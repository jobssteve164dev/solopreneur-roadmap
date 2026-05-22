import * as fs from 'fs';
import { CsvStore } from './csvStore';
import { SqliteStore } from './sqliteStore';
import { RoadmapNode, RoadmapEdge } from './types';

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
  ): void {
    this.sqliteStore.logExecution(nodeId, agentCli, command, output, status);
  }

  /**
   * Seed a beautiful initial roadmap for new projects to demonstrate the capability.
   */
  private createDefaultRoadmap(): RoadmapNode[] {
    const now = new Date().toISOString();
    return [
      {
        id: '1',
        title: 'Business Vision & Market Positioning',
        description: 'AI agent analyzes customer personas, market differentiation, and competitive landscapes from the initial startup concept.',
        stage: 'Business Planning',
        dependencies: '',
        agentCli: 'antigravity-cli',
        agentPrompt: 'Analyze the core business model, target audience, and competition for a new solopreneur venture. Draft a comprehensive strategic roadmap and business plan.',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      },
      {
        id: '2',
        title: 'Brand Identity & Administrative Setup',
        description: 'AI agent recommends branding options, visual VI sheets, organizational charts, and LLC administrative paperwork.',
        stage: 'Brand & Setup',
        dependencies: '1',
        agentCli: 'antigravity-cli',
        agentPrompt: 'Generate branding visual style sheets, suggest domain and name choices, and draft LLC incorporation and structural operating agreements.',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      },
      {
        id: '3',
        title: 'Product Scaffold & MVP Deployment',
        description: 'AI agent configures the directory structure, builds core frontend and backend components, and deploys directly to staging URL.',
        stage: 'Product & MVP',
        dependencies: '2',
        agentCli: 'antigravity-cli',
        agentPrompt: 'Scaffold the MVC backend database schema, implement a premium glassmorphic React dashboard with Tailwind elements, and deploy live live URL.',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      },
      {
        id: '4',
        title: 'Marketing Automation & Growth Drive',
        description: 'Cross-agent workflows draft high-engaging marketing copy, execute outbound sales pipelines, and monitor conversion metrics.',
        stage: 'Marketing & Growth',
        dependencies: '3',
        agentCli: 'antigravity-cli',
        agentPrompt: 'Draft high-converting SEO marketing copies, set up automated outreach lead generation pipelines, and configure analytics metrics charts.',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      }
    ];
  }
}
