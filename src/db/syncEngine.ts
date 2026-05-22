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
        title: 'Project Kickoff & Vision Definition',
        description: 'Define the target audience, unique value proposition (UVP), and core features of the solopreneur project.',
        stage: 'Ideation',
        dependencies: '',
        agentCli: 'antigravity-cli',
        agentPrompt: 'Create a product brief and MVP specification for a solopreneur task management tool.',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      },
      {
        id: '2',
        title: 'Market & Competitor Analysis',
        description: 'Research existing solutions, identify gaps, and document key success factors.',
        stage: 'Research',
        dependencies: '1',
        agentCli: 'research',
        agentPrompt: 'Analyze the top 3 competitors in the solopreneur tool space. Highlight their pricing, features, and weaknesses.',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      },
      {
        id: '3',
        title: 'Database Schema Design',
        description: 'Design the relational database schema, tables, and relationships for the MVP.',
        stage: 'Architecture',
        dependencies: '2',
        agentCli: 'antigravity-cli',
        agentPrompt: 'Design a clean SQL schema representing tasks, projects, and execution_logs. Output a migration.sql file.',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      },
      {
        id: '4',
        title: 'Build API Services',
        description: 'Implement backend routes, models, and controller endpoints using Express/TypeScript.',
        stage: 'Backend',
        dependencies: '3',
        agentCli: 'antigravity-cli',
        agentPrompt: 'Generate Express API routes for project CRUD operations, database integrations, and terminal run hooks.',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      },
      {
        id: '5',
        title: 'Build Web UI App',
        description: 'Implement the React frontend dashboard with beautiful glassmorphism and real-time terminal streams.',
        stage: 'Frontend',
        dependencies: '4',
        agentCli: 'cursor-cli',
        agentPrompt: 'Build a premium glassmorphic React dashboard with status widgets and action cards.',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      },
      {
        id: '6',
        title: 'Production Deployment & Launch',
        description: 'Configure CI/CD, set up server container, and launch to production.',
        stage: 'Launch',
        dependencies: '5',
        agentCli: 'gitops-cli',
        agentPrompt: 'Create a deployment configuration, Dockerfile, and CI/CD GitHub action workflow to deploy on render/coolify.',
        status: 'Pending',
        createdAt: now,
        completedAt: '',
      }
    ];
  }
}
