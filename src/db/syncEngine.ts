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
        title: '明确产品承诺与市场定位',
        description: '让 AI Agent 从最初的项目想法出发，梳理目标用户、核心价值、差异化定位和第一阶段成功标准。',
        stage: '商业规划',
        dependencies: '',
        agentCli: 'agy',
        agentPrompt: '分析这个独立开发项目的商业模式、目标用户、核心竞争差异和主要风险，并在 docs/product-brief.md 中写出清晰的产品简报、MVP 边界和验收标准。',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      },
      {
        id: '2',
        title: '品牌表达与项目基础设置',
        description: '让 AI Agent 将产品定位转成名称、视觉方向、基础说明文档和项目工作区的初始组织方式。',
        stage: '品牌与设置',
        dependencies: '1',
        agentCli: 'agy',
        agentPrompt: '基于 docs/product-brief.md，为项目生成品牌命名方向、视觉语气、README 初稿和基础项目目录建议，结果写入 docs/brand-and-setup.md。',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      },
      {
        id: '3',
        title: '构建第一个可用 MVP 切片',
        description: '让 AI Agent 搭建最小可运行产品路径，优先交付能被用户实际体验和验证的一小段闭环。',
        stage: '产品与 MVP',
        dependencies: '2',
        agentCli: 'agy',
        agentPrompt: '阅读 docs/product-brief.md 和 docs/brand-and-setup.md，规划并实现第一个最小可用产品切片，补充运行方式和最窄验证命令。',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      },
      {
        id: '4',
        title: '准备发布与增长动作',
        description: '让 AI Agent 基于已经完成的 MVP，整理发布清单、首批传播文案、后续迭代任务和可衡量的增长动作。',
        stage: '营销与增长',
        dependencies: '3',
        agentCli: 'agy',
        agentPrompt: '基于当前项目文件，创建 docs/launch-checklist.md，包含发布检查清单、首页/社媒文案、已知缺口、下一步增长实验和验收方式。',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      }
    ];
  }
}
