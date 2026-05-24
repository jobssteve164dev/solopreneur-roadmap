import * as fs from 'fs';
import { CsvStore } from './csvStore';
import { SqliteStore } from './sqliteStore';
import { AgentConversation, RoadmapNode, RoadmapEdge } from './types';

export class SyncEngine {
  private csvStore: CsvStore;
  private sqliteStore: SqliteStore;

  constructor(
    private csvPath: string,
    private dbPath: string,
    private extensionPath: string
  ) {
    this.csvStore = new CsvStore(csvPath);
    this.sqliteStore = new SqliteStore(dbPath, extensionPath);
  }

  /**
   * Initializes both engines and synchronizes their data on startup.
   */
  public async initAndSync(): Promise<void> {
    // 1. Init SQLite database
    await this.sqliteStore.init();

    // 2. Read nodes from CSV (Git source of truth)
    const csvNodes = this.csvStore.readNodes();

    if (csvNodes.length > 0) {
      // 3. Hydrate SQLite from the CSV
      this.sqliteStore.syncNodesFromList(csvNodes);
    } else {
      // If CSV is empty, check if SQLite has any existing nodes (to prevent data loss)
      const sqliteNodes = this.sqliteStore.getAllNodes();
      if (sqliteNodes.length > 0) {
        // Sync back to CSV
        this.csvStore.writeNodes(sqliteNodes);
      } else {
        // Both are empty! Seed a default roadmap for a new solopreneur project
        const defaultNodes = this.createDefaultRoadmap();
        this.csvStore.writeNodes(defaultNodes);
        this.sqliteStore.syncNodesFromList(defaultNodes);
      }
    }
  }

  /**
   * Retrieves nodes. Reads from SQLite (very fast).
   */
  public getNodes(): RoadmapNode[] {
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
    this.sqliteStore.syncNodesFromList(nodes);
    this.csvStore.writeNodes(nodes);
  }

  /**
   * Adds a list of newly generated nodes (e.g. from AI) into the roadmap.
   */
  public setNodes(nodes: RoadmapNode[]): void {
    this.sqliteStore.syncNodesFromList(nodes);
    this.csvStore.writeNodes(nodes);
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
  ): number {
    return this.sqliteStore.logExecution(nodeId, agentCli, command, output, status);
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
  ): boolean {
    return this.sqliteStore.updateExecution(id, agentCli, command, output, status);
  }

  /**
   * Reads the agent conversation history for a single roadmap node.
   */
  public getAgentExecutions(nodeId: string): AgentConversation[] {
    return this.sqliteStore.getExecutionLogs(nodeId);
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
        stage: '问题与客户发现',
        dependencies: '',
        agentCli: 'agy',
        agentPrompt: '阅读 .solopreneur/bootstrap-roadmap-instructions.md 和 .solopreneur/roadmap-methodology.md，基于当前项目文件直接重写 .solopreneur/roadmap.csv。完成后按指令文件中的自检要求重新读取并校验该 CSV。',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      },
      {
        id: '2',
        title: '验证问题与目标客户',
        description: '让 AI Agent 从最初的项目想法出发，梳理问题假设、目标用户、验证方式和第一阶段成功标准。',
        stage: '问题与客户发现',
        dependencies: '1',
        agentCli: 'agy',
        agentPrompt: '分析这个独立开发项目的问题假设、目标用户、验证方式和主要风险，并在 docs/problem-discovery.md 中写出清晰的用户发现、MVP 边界和下一步行动。',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      },
      {
        id: '3',
        title: '构建第一个可用 MVP 切片',
        description: '让 AI Agent 将问题假设转成能被用户试用和验证的最小产品路径。',
        stage: '产品与 MVP',
        dependencies: '2',
        agentCli: 'agy',
        agentPrompt: '阅读 docs/problem-discovery.md，规划并实现第一个最小可用产品切片，补充运行方式和最窄验证命令。',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      },
      {
        id: '4',
        title: '准备首轮市场触达',
        description: '让 AI Agent 将产品承诺转成品牌、官网、发布或销售材料，推动真实用户反馈。',
        stage: '营销与销售',
        dependencies: '3',
        agentCli: 'agy',
        agentPrompt: '基于当前产品切片创建 docs/launch-message.md，包含一句话定位、官网首屏文案、发布帖、首批触达渠道和用户反馈入口。',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      },
      {
        id: '5',
        title: '建立反馈与改进循环',
        description: '让 AI Agent 基于已经完成的 MVP 和市场触达，整理反馈、指标、支持信号和下一轮改进动作。',
        stage: '反馈与规模化',
        dependencies: '4',
        agentCli: 'agy',
        agentPrompt: '基于当前项目文件，创建 docs/learning-loop.md，包含反馈收集方式、关键指标、支持信号、单位经济假设和下一轮 Build -> Sell -> Learn -> Improve 改进任务。',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      }
    ];
  }
}
