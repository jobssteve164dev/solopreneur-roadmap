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
  public async initAndSync(): Promise<void> {
    // 1. Init SQLite database
    if (this.globalDataPath) {
      const indexesPromise = sendRuntimeDataRequest<RunIndexEntry[]>(this.globalDataPath, { operation: 'read_project_run_indexes', input: { root: this.projectRoot } });
      const logs: AgentConversation[] = [];
      let offset = 0;
      while (true) {
        const page = await sendRuntimeDataRequest<{ logs: AgentConversation[]; hasMore: boolean }>(this.globalDataPath, { operation: 'read_project_journal', input: { root: this.projectRoot, limit: 500, offset } });
        logs.push(...page.logs);
        if (!page.hasMore) break;
        offset += page.logs.length;
      }
      const indexes = await indexesPromise;
      let legacyLogs: AgentConversation[] = [];
      let legacyIndexes: RunIndexEntry[] = [];
      if (fs.existsSync(this.dbPath)) {
        const legacy = new SqliteStore(this.dbPath, this.extensionPath);
        try {
          await legacy.initJournalReadOnly();
          legacyLogs = legacy.getAllExecutionLogs();
          legacyIndexes = legacy.getRunIndexEntries();
        } catch (error) {
          console.warn('SoloMap could not read the legacy project journal during background migration:', error);
        } finally { legacy.close(); }
      }
      const databaseLogIds = new Set(logs.map(entry => entry.id));
      this.conversationCache = [...logs, ...legacyLogs.filter(entry => !databaseLogIds.has(entry.id))]
        .sort((a, b) => b.id - a.id);
      const databaseIndexIds = new Set(indexes.map(entry => entry.executionLogId));
      this.runIndexCache = [...indexes, ...legacyIndexes.filter(entry => !databaseIndexIds.has(entry.executionLogId))]
        .sort((a, b) => b.executionLogId - a.executionLogId);
    } else await this.sqliteStore!.init();

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

  public close(): void {
    this.sqliteStore?.close();
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
  public updateNode(nodeId: string, updates: Partial<RoadmapNode>): void {
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

    // Save to SQLite & CSV
    this.sqliteStore?.syncNodesFromList(nodes);
    this.csvStore.writeNodes(nodes);
    this.nodeCache = nodes;
  }

  /**
   * Adds a list of newly generated nodes (e.g. from AI) into the roadmap.
   */
  public setNodes(nodes: RoadmapNode[]): void {
    this.sqliteStore?.syncNodesFromList(nodes);
    this.csvStore.writeNodes(nodes);
    this.nodeCache = nodes;
  }

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
    const minimumExecutionLogId = this.conversationCache.reduce((maximum, entry) => Math.max(maximum, Number(entry.id || 0)), 0) + 1;
    return sendRuntimeDataRequest<{ executionLogId: number }>(this.globalDataPath, { operation: 'append_project_journal', input: { root: this.projectRoot, minimumExecutionLogId, idempotencyKey, entry: { nodeId, timestamp, agentCli, command, output, status } } }).then(result => {
      this.conversationCache.unshift({ id: result.executionLogId, nodeId, timestamp, agentCli, command, output, status });
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
    return sendRuntimeDataRequest<{ updated: boolean }>(this.globalDataPath, { operation: 'update_project_journal', input: { root: this.projectRoot, executionLogId: id, agentCli, command, output, status } }).then(result => {
      if (result.updated) {
        const current = this.conversationCache.find(item => item.id === id);
        if (current) Object.assign(current, { agentCli, command, output, status });
      }
      return result.updated;
    });
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
    return this.globalDataPath ? [...this.conversationCache] : this.sqliteStore!.getAllExecutionLogs();
  }

  public getRecentProjectAgentExecutions(limit = 200): AgentConversation[] {
    return this.globalDataPath ? this.conversationCache.slice(0, limit) : this.sqliteStore!.getRecentExecutionLogs(limit);
  }

  public upsertRunIndex(record: RunIndexRecord, files: RunIndexFile[] = [], signals: RunIndexSignal[] = []): void | Promise<void> {
    if (!this.globalDataPath) { this.sqliteStore!.upsertRunIndex(record, files, signals); return; }
    return sendRuntimeDataRequest(this.globalDataPath, { operation: 'upsert_project_run_index', input: { root: this.projectRoot, record, files, signals } }).then(() => {
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
