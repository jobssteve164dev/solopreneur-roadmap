import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CsvStore } from './csvStore';
import { SqliteStore } from './sqliteStore';
import { AgentConversation, GrowthSnapshotData, GrowthSnapshotRecord, RoadmapNode, RoadmapEdge, RunIndexEntry, RunIndexFile, RunIndexRecord, RunIndexSignal } from './types';
import { sendRuntimeDataRequest } from '../autonomousRuntimeControl';

export class SyncEngine {
  private csvStore: CsvStore;
  private sqliteStore: SqliteStore | undefined;
  private nodeCache: RoadmapNode[] = [];
  private conversationCache: AgentConversation[] = [];
  private runIndexCache: RunIndexEntry[] = [];
  private readonly projectRoot: string;
  private historyLoad: Promise<void> | undefined;
  private closed = false;
  private cacheRevision = 0;
  private minimumExecutionLogId = 1;
  private readonly conversationRevisions = new Map<string, number>();
  private readonly indexRevisions = new Map<number, number>();
  private roadmapRevision = 0;
  private roadmapWrites: Promise<void> = Promise.resolve();

  constructor(
    private csvPath: string,
    private dbPath: string,
    private extensionPath: string,
    private globalDataPath = ''
  ) {
    this.csvStore = new CsvStore(csvPath);
    this.projectRoot = path.dirname(path.dirname(dbPath));
    if (!globalDataPath) this.sqliteStore = new SqliteStore(dbPath, extensionPath);
    this.nodeCache = this.csvStore.readNodes();
  }

  /**
   * Initializes both engines and synchronizes their data on startup.
   */
  public async initAndSync(options: { history?: 'all' | 'background' } = {}): Promise<void> {
    // 1. Init SQLite database
    if (this.globalDataPath) {
      this.minimumExecutionLogId = (await sendRuntimeDataRequest<{ minimumExecutionLogId: number }>(this.globalDataPath,
        { operation: 'initialize_project_journal', input: { root: this.projectRoot } })).minimumExecutionLogId;
      if (options.history === 'background') {
        // Reserve legacy IDs with a scalar query; no output history is needed
        // for the first durable write while migration is still queued.
        // Full history supports existing continuation/status consumers, but is
        // never a prerequisite for painting recent conversations or launching.
        setImmediate(() => {
          if (!this.closed) void this.loadHistory().catch(error => console.warn('SoloMap background conversation hydration failed:', error));
        });
      } else await this.loadHistory();
    } else await this.sqliteStore!.init();

    if (this.globalDataPath) {
      const snapshot = await this.readOrAcceptRoadmap();
      this.nodeCache = snapshot.nodes;
      this.roadmapRevision = snapshot.revision;
    } else this.refreshNodes();
  }

  private async readOrAcceptRoadmap(): Promise<{ nodes: RoadmapNode[]; revision: number }> {
    try {
      return await sendRuntimeDataRequest(this.globalDataPath, { operation: 'accept_roadmap_csv', input: { root: this.projectRoot } });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !/ENOENT/.test(error instanceof Error ? error.message : String(error))) throw error;
      try { return await sendRuntimeDataRequest(this.globalDataPath, { operation: 'read_roadmap', input: { root: this.projectRoot } }); }
      catch (readError) {
        if (!/roadmap_import_required/.test(readError instanceof Error ? readError.message : String(readError))) throw readError;
        return { nodes: this.nodeCache, revision: 0 };
      }
    }
  }

  /** Refreshes the Git source of truth without reading conversation history. */
  public refreshNodes(): void | Promise<void> {
    if (this.globalDataPath && this.roadmapRevision > 0) {
      const immediate = this.csvStore.readNodes();
      if (immediate.length) this.nodeCache = immediate;
      return this.readOrAcceptRoadmap().then(snapshot => {
        if (this.closed) return;
        this.nodeCache = snapshot.nodes;
        this.roadmapRevision = snapshot.revision;
      });
    }
    // 2. Read nodes from CSV (Git source of truth)
    const csvNodes = this.csvStore.readNodes();
    this.nodeCache = csvNodes;

    if (csvNodes.length > 0) {
      // 3. Hydrate SQLite from the CSV
      this.sqliteStore?.syncNodesFromList(csvNodes);
      this.nodeCache = csvNodes;
    } else {
      // If CSV is empty, check if SQLite has any existing nodes (to prevent data loss)
      const sqliteNodes = this.sqliteStore?.getAllNodes() || [];
      if (sqliteNodes.length > 0) {
        // Sync back to CSV
        this.csvStore.writeNodes(sqliteNodes);
        this.nodeCache = sqliteNodes;
      } else {
        // Both are empty! Seed a default roadmap for a new solopreneur project
        const defaultNodes = this.createDefaultRoadmap();
        this.csvStore.writeNodes(defaultNodes);
        this.sqliteStore?.syncNodesFromList(defaultNodes);
        this.nodeCache = defaultNodes;
      }
    }
  }

  public async resolveRoadmapConflict(choice: 'file' | 'database'): Promise<void> {
    if (!this.globalDataPath || this.roadmapRevision < 1) throw new Error('roadmap_conflict_unavailable');
    const snapshot: { nodes: RoadmapNode[]; revision: number } = await sendRuntimeDataRequest(this.globalDataPath, {
      operation: 'resolve_roadmap_conflict', input: { root: this.projectRoot, choice, expectedRevision: this.roadmapRevision, idempotencyKey: `roadmap-conflict:${choice}:${crypto.randomUUID()}` }
    });
    this.nodeCache = snapshot.nodes;
    this.roadmapRevision = snapshot.revision;
  }

  public close(): void {
    this.closed = true;
    this.sqliteStore?.close();
  }

  public get dataRoot(): string { return this.globalDataPath; }

  private mergeConversations(logs: AgentConversation[], startedRevision: number): void {
    const key = (log: AgentConversation) => `${log.nodeId}\0${log.id}`;
    const merged = new Map(this.conversationCache.map(log => [key(log), log]));
    for (const log of logs) {
      const identity = key(log);
      if ((this.conversationRevisions.get(identity) || 0) > startedRevision) continue;
      merged.set(identity, log);
      this.conversationRevisions.set(identity, ++this.cacheRevision);
    }
    this.conversationCache = [...merged.values()].sort((a, b) => b.id - a.id);
  }

  private loadHistory(): Promise<void> {
    if (this.historyLoad) return this.historyLoad;
    this.historyLoad = (async () => {
      const startedRevision = this.cacheRevision;
      const logs = await this.readDatabaseJournal('', true);
      if (this.closed) return;
      const indexes: RunIndexEntry[] = [];
      const indexIds = new Set<number>();
      for (let position = 0; !this.closed; position += 200) {
        const page = await sendRuntimeDataRequest<RunIndexEntry[]>(this.globalDataPath, { operation: 'read_project_run_indexes', input: { root: this.projectRoot, limit: 200, offset: position } });
        const newEntries = page.filter(index => !indexIds.has(index.executionLogId));
        newEntries.forEach(index => indexIds.add(index.executionLogId));
        indexes.push(...newEntries);
        // During an extension upgrade the old owner can still return its
        // unpaginated response. Accept it once instead of querying it forever.
        if (page.length !== 200 || !newEntries.length) break;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (this.closed) return;
      this.mergeConversations(logs, startedRevision);
      const merged = new Map(indexes.map(index => [index.executionLogId, index]));
      for (const index of this.runIndexCache) {
        if ((this.indexRevisions.get(index.executionLogId) || 0) > startedRevision) merged.set(index.executionLogId, index);
      }
      if (!this.closed) this.runIndexCache = [...merged.values()].sort((a, b) => b.executionLogId - a.executionLogId);
    })().finally(() => { this.historyLoad = undefined; });
    return this.historyLoad;
  }

  private async readDatabaseJournal(nodeId = '', background = false): Promise<AgentConversation[]> {
    const logs: AgentConversation[] = [];
    while (!background || !this.closed) {
      const page = await sendRuntimeDataRequest<{ logs: AgentConversation[]; hasMore: boolean }>(this.globalDataPath, { operation: 'read_project_journal', input: { root: this.projectRoot, ...(nodeId ? { nodeId } : {}), limit: 500, offset: logs.length } });
      logs.push(...page.logs);
      if (!page.hasMore || !page.logs.length) break;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    return logs;
  }

  /** Reads durable pages even while background hydration is incomplete. */
  public async readAgentExecutionPage(nodeId: string, limit = 20, offset = 0): Promise<{ logs: AgentConversation[]; hasMore: boolean }> {
    if (!this.globalDataPath) return this.getAgentExecutionPage(nodeId, limit, offset);
    return this.readConversationPage(nodeId, limit, offset);
  }

  public async readRecentProjectAgentExecutions(limit = 200): Promise<AgentConversation[]> {
    if (!this.globalDataPath) return this.getRecentProjectAgentExecutions(limit);
    return (await this.readConversationPage('', limit, 0)).logs;
  }

  public async readAgentExecutions(nodeId: string): Promise<AgentConversation[]> {
    if (!this.globalDataPath) return this.getAgentExecutions(nodeId);
    const revision = this.cacheRevision;
    const logs = await this.readDatabaseJournal(nodeId);
    this.mergeConversations(logs, revision);
    return this.getAgentExecutions(nodeId);
  }

  public async readAgentExecutionById(executionLogId: number): Promise<AgentConversation | null> {
    if (!this.globalDataPath) return this.getProjectAgentExecutions().find(log => log.id === executionLogId) || null;
    const revision = this.cacheRevision;
    const page = await sendRuntimeDataRequest<{ logs: AgentConversation[] }>(this.globalDataPath, { operation: 'read_project_journal', input: { root: this.projectRoot, executionLogId, limit: 1 } });
    const log = page.logs[0] || null;
    if (log) this.mergeConversations([log], revision);
    return this.getProjectAgentExecutions().find(item => item.id === executionLogId) || null;
  }

  private async readConversationPage(nodeId: string, limit: number, offset: number): Promise<{ logs: AgentConversation[]; hasMore: boolean }> {
    const startedRevision = this.cacheRevision;
    const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 20)));
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const needed = safeOffset + safeLimit + 1;
    const logs: AgentConversation[] = [];
    let databaseHasMore = false;
    do {
      const page = await sendRuntimeDataRequest<{ logs: AgentConversation[]; hasMore: boolean }>(this.globalDataPath, { operation: 'read_project_journal', input: { root: this.projectRoot, ...(nodeId ? { nodeId } : {}), limit: Math.min(500, needed - logs.length), offset: logs.length } });
      logs.push(...page.logs); databaseHasMore = page.hasMore;
      if (!databaseHasMore || !page.logs.length) break;
    } while (logs.length < needed);
    const key = (log: AgentConversation) => `${log.nodeId}\0${log.id}`;
    const merged = new Map(logs.map(log => [key(log), log]));
    // A live commit or a newer read owns its row over this older response.
    for (const log of this.conversationCache) {
      if ((nodeId ? log.nodeId === nodeId : !log.dataState?.linkedFromNodeId) && (this.conversationRevisions.get(key(log)) || 0) > startedRevision) merged.set(key(log), log);
    }
    const ordered = [...merged.values()].sort((a, b) => b.id - a.id);
    this.mergeConversations(ordered, startedRevision);
    return { logs: ordered.slice(safeOffset, safeOffset + safeLimit), hasMore: databaseHasMore || ordered.length > safeOffset + safeLimit };
  }

  /**
   * Retrieves nodes. Reads from SQLite (very fast).
   */
  public getNodes(): RoadmapNode[] {
    if (!this.sqliteStore?.isInitialized()) {
      return this.nodeCache;
    }
    return this.sqliteStore.getAllNodes();
  }

  /**
   * Updates a single node and synchronizes it to both SQLite and CSV.
   */
  public updateNode(nodeId: string, updates: Partial<RoadmapNode>): void | Promise<void> {
    const nodes = this.getNodes();
    const targetIdx = nodes.findIndex((n) => n.id === nodeId);

    if (targetIdx === -1) {
      throw new Error(`Node with ID ${nodeId} not found`);
    }

    const updatedNode = {
      ...nodes[targetIdx],
      ...updates,
    } as RoadmapNode;

    nodes[targetIdx] = updatedNode;

    this.nodeCache = nodes;
    if (!this.globalDataPath || this.roadmapRevision === 0) {
      this.sqliteStore?.syncNodesFromList(nodes);
      this.csvStore.writeNodes(nodes);
      return;
    }
    return this.enqueueRoadmapMutation(current => current.map(node => node.id === nodeId ? { ...node, ...updates } : node));
  }

  /**
   * Adds a list of newly generated nodes (e.g. from AI) into the roadmap.
   */
  public setNodes(nodes: RoadmapNode[]): void | Promise<void> {
    this.nodeCache = nodes;
    if (!this.globalDataPath || this.roadmapRevision === 0) {
      this.sqliteStore?.syncNodesFromList(nodes);
      this.csvStore.writeNodes(nodes);
      return;
    }
    return this.enqueueRoadmapMutation(() => nodes.map(node => ({ ...node })));
  }

  private enqueueRoadmapMutation(change: (nodes: RoadmapNode[]) => RoadmapNode[]): Promise<void> {
    const requestKey = crypto.randomUUID();
    const run = this.roadmapWrites.then(async () => {
      const current = await sendRuntimeDataRequest<{ nodes: RoadmapNode[]; revision: number }>(this.globalDataPath, { operation: 'read_roadmap', input: { root: this.projectRoot } });
      const result = await sendRuntimeDataRequest<{ nodes: RoadmapNode[]; revision: number }>(this.globalDataPath, { operation: 'update_roadmap', input: { root: this.projectRoot, expectedRevision: current.revision, nodes: change(current.nodes), idempotencyKey: `sync-engine:${requestKey}` } });
      if (!this.closed) { this.nodeCache = result.nodes; this.roadmapRevision = result.revision; }
    });
    this.roadmapWrites = run.catch(() => {});
    return run;
  }

  public flushRoadmapWrites(): Promise<void> { return this.roadmapWrites; }

  /**
   * Record a CLI execution log inside the SQLite database.
   */
  public logAgentExecution(
    nodeId: string,
    agentCli: string,
    command: string,
    output: string,
    status: string
  ): number | Promise<number> {
    if (!this.globalDataPath) return this.sqliteStore!.logExecution(nodeId, agentCli, command, output, status);
    const timestamp = new Date().toISOString();
    const idempotencyKey = crypto.randomUUID();
    const minimumExecutionLogId = Math.max(this.minimumExecutionLogId, this.conversationCache.reduce((maximum, entry) => Math.max(maximum, Number(entry.id || 0)), 0) + 1);
    return sendRuntimeDataRequest<{ executionLogId: number }>(this.globalDataPath, { operation: 'append_project_journal', input: { root: this.projectRoot, minimumExecutionLogId, idempotencyKey, entry: { nodeId, timestamp, agentCli, command, output, status } } }).then(result => {
      this.conversationRevisions.set(`${nodeId}\0${result.executionLogId}`, ++this.cacheRevision);
      this.conversationCache = [{ id: result.executionLogId, nodeId, timestamp, agentCli, command, output, status }, ...this.conversationCache.filter(log => log.id !== result.executionLogId)];
      return result.executionLogId;
    });
  }

  /**
   * Update a previously created Agent execution log.
   */
  public updateAgentExecution(
    id: number,
    agentCli: string,
    command: string,
    output: string,
    status: string
  ): boolean | Promise<boolean> {
    if (!this.globalDataPath) return this.sqliteStore!.updateExecution(id, agentCli, command, output, status);
    return sendRuntimeDataRequest<{ updated: boolean }>(this.globalDataPath, { operation: 'update_project_journal', input: { root: this.projectRoot, executionLogId: id, agentCli, command, output, status } }).then(async result => {
      if (result.updated) {
        const current = this.conversationCache.filter(item => item.id === id);
        for (const item of current) {
          this.conversationRevisions.set(`${item.nodeId}\0${id}`, ++this.cacheRevision);
          Object.assign(item, { agentCli, command, output, ...(item.status === 'Linked' ? {} : { status }) });
        }
        if (!current.length) await this.readAgentExecutionById(id);
      }
      return result.updated;
    });
  }

  public async linkAgentExecution(executionLogId: number, nodeId: string): Promise<AgentConversation> {
    if (!this.globalDataPath) throw new Error('database_runtime_required');
    const linkedAt = new Date().toISOString();
    const linked = await sendRuntimeDataRequest<AgentConversation>(this.globalDataPath, { operation: 'link_project_journal', input: { root: this.projectRoot, executionLogId, nodeId, linkedAt } });
    this.mergeConversations([linked], this.cacheRevision);
    return linked;
  }

  /**
   * Reads the agent conversation history for a single roadmap node.
   */
  public getAgentExecutions(nodeId: string): AgentConversation[] {
    return this.globalDataPath ? this.conversationCache.filter(item => item.nodeId === nodeId) : this.sqliteStore!.getExecutionLogs(nodeId);
  }

  public getAgentExecutionPage(nodeId: string, limit = 20, offset = 0): { logs: AgentConversation[]; hasMore: boolean } {
    if (!this.globalDataPath) return this.sqliteStore!.getExecutionLogPage(nodeId, limit, offset);
    const matches = this.conversationCache.filter(item => item.nodeId === nodeId);
    return { logs: matches.slice(offset, offset + limit), hasMore: matches.length > offset + limit };
  }

  /**
   * Reads agent conversation history across the whole project.
   */
  public getProjectAgentExecutions(): AgentConversation[] {
    return this.globalDataPath ? this.conversationCache.filter(item => !item.dataState?.linkedFromNodeId) : this.sqliteStore!.getAllExecutionLogs();
  }

  public getRecentProjectAgentExecutions(limit = 200): AgentConversation[] {
    return this.globalDataPath ? this.conversationCache.filter(item => !item.dataState?.linkedFromNodeId).slice(0, limit) : this.sqliteStore!.getRecentExecutionLogs(limit);
  }

  public upsertRunIndex(record: RunIndexRecord, files: RunIndexFile[] = [], signals: RunIndexSignal[] = []): void | Promise<void> {
    if (!this.globalDataPath) { this.sqliteStore!.upsertRunIndex(record, files, signals); return; }
    return sendRuntimeDataRequest(this.globalDataPath, { operation: 'upsert_project_run_index', input: { root: this.projectRoot, record, files, signals } }).then(() => {
      this.indexRevisions.set(record.executionLogId, ++this.cacheRevision);
      this.runIndexCache = [{ ...record, files, signals }, ...this.runIndexCache.filter(item => item.executionLogId !== record.executionLogId)];
    });
  }

  public getRunIndexEntries(): RunIndexEntry[] {
    return this.globalDataPath ? [...this.runIndexCache] : this.sqliteStore!.getRunIndexEntries();
  }

  public writeGrowthSnapshot(data: GrowthSnapshotData): void {
    this.sqliteStore!.writeGrowthSnapshot(data);
  }

  public getLatestGrowthSnapshot(): GrowthSnapshotData | null {
    return this.sqliteStore!.getLatestGrowthSnapshot();
  }

  public getGrowthSnapshotById(snapshotId: string): GrowthSnapshotData | null {
    return this.sqliteStore!.getGrowthSnapshotById(snapshotId);
  }

  public getGrowthSnapshotHistory(limit = 12): GrowthSnapshotRecord[] {
    return this.sqliteStore!.getGrowthSnapshotHistory(limit);
  }

  /**
   * Seed a beautiful initial roadmap for new projects to demonstrate the capability.
   */
  private createDefaultRoadmap(): RoadmapNode[] {
    const now = new Date().toISOString();
    return [
      {
        id: '1',
        title: '生成初始路线图',
        description: '让 AI Agent 直接重写 .solopreneur/roadmap.csv，基于当前项目文件生成真正可执行的定制化路线图。',
        stage: '目标与路径确认',
        dependencies: '',
        agentCli: 'agy',
        agentPrompt: '阅读 .solopreneur/bootstrap-roadmap-instructions.md 和 .solopreneur/roadmap-methodology.md，基于当前项目文件直接重写 .solopreneur/roadmap.csv。完成后按指令文件中的自检要求重新读取并校验该 CSV。',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      },
      {
        id: '2',
        title: '明确交付目标与成功标准',
        description: '让 AI Agent 从项目文件出发，梳理真实目标、使用对象、范围边界和可验证的成功标准。',
        stage: '目标与路径确认',
        dependencies: '1',
        agentCli: 'agy',
        agentPrompt: '分析这个项目的交付目标、使用对象、验证方式和主要风险，并在 docs/project-brief.md 中写出清晰的范围边界、成功标准和下一步行动；若证据表明这是对外产品，再补充客户验证要求。',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      },
      {
        id: '3',
        title: '交付首个可验证切片',
        description: '让 AI Agent 将项目目标转成可以运行、查看或按文档验收的最小交付结果。',
        stage: '交付与验证',
        dependencies: '2',
        agentCli: 'agy',
        agentPrompt: '阅读 docs/project-brief.md，规划并实现首个可验证交付切片，补充运行方式和最窄验证命令。',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      },
      {
        id: '4',
        title: '验证结果并安排下一轮',
        description: '让 AI Agent 收集本次交付的运行、使用或验收结果，并把反馈转成下一轮动作。',
        stage: '结果反馈与迭代',
        dependencies: '3',
        agentCli: 'agy',
        agentPrompt: '基于当前项目文件创建 docs/iteration-review.md，记录验证证据、反馈来源、未解决问题和下一轮改进任务；若这是对外产品，加入触达与用户反馈动作。',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      }
    ];
  }
}
