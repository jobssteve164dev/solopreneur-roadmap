import * as fs from 'fs';
import * as path from 'path';
import initSqlJs from 'sql.js';
import { AgentConversation, RoadmapNode } from './types';

export class SqliteStore {
  private db: initSqlJs.Database | null = null;
  private SQL: initSqlJs.SqlJsStatic | null = null;

  constructor(
    private dbFilePath: string,
    private extensionPath: string
  ) {}

  public isInitialized(): boolean {
    return Boolean(this.db);
  }

  /**
   * Initializes the SQLite WASM runtime and opens the database.
   */
  public async init(): Promise<void> {
    if (this.db) {
      return;
    }

    try {
      // 在 Node.js 环境下，可以直接无需任何参数地初始化 sql.js
      // 它会自动加载其同包目录下的 sql-wasm.wasm，避免绝对路径跨平台或解包导致定位失败的问题
      this.SQL = await initSqlJs();

      if (fs.existsSync(this.dbFilePath)) {
        const fileBuffer = fs.readFileSync(this.dbFilePath);
        this.db = new this.SQL.Database(fileBuffer);
      } else {
        this.db = new this.SQL.Database();
        this.createTables();
        this.save();
      }
    } catch (error) {
      console.error('Failed to initialize SQLite WASM:', error);
      throw error;
    }
  }

  /**
   * Creates the schema tables for storing node history, logs, and state.
   */
  private createTables(): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    // Nodes Table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        title TEXT,
        description TEXT,
        stage TEXT,
        dependencies TEXT,
        agentCli TEXT,
        agentPrompt TEXT,
        status TEXT,
        createdAt TEXT,
        completedAt TEXT
      )
    `);

    // Logs & History Table (SQLite-only feature for rich tracking)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS execution_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeId TEXT,
        timestamp TEXT,
        agentCli TEXT,
        command TEXT,
        output TEXT,
        status TEXT,
        FOREIGN KEY (nodeId) REFERENCES nodes(id)
      )
    `);
  }

  /**
   * Commits the in-memory SQLite state to the local database file.
   */
  public save(): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbFilePath, buffer);
    } catch (error) {
      console.error('Failed to save SQLite database to file:', error);
      throw error;
    }
  }

  /**
   * Resets and updates the nodes table inside SQLite.
   * This is used when synchronizing from the CSV source of truth.
   */
  public syncNodesFromList(nodes: RoadmapNode[]): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    if (this.nodesMatch(this.getAllNodes(), nodes)) {
      return;
    }

    // Clear existing nodes
    this.db.run('DELETE FROM nodes');

    // Insert new nodes
    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, title, description, stage, dependencies, agentCli, agentPrompt, status, createdAt, completedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const node of nodes) {
      stmt.run([
        node.id,
        node.title,
        node.description,
        node.stage,
        node.dependencies,
        node.agentCli,
        node.agentPrompt,
        node.status,
        node.createdAt,
        node.completedAt,
      ]);
    }
    stmt.free();
    this.save();
  }

  private nodesMatch(existing: RoadmapNode[], next: RoadmapNode[]): boolean {
    if (existing.length !== next.length) {
      return false;
    }
    const fields: Array<keyof RoadmapNode> = [
      'id',
      'title',
      'description',
      'stage',
      'dependencies',
      'agentCli',
      'agentPrompt',
      'status',
      'createdAt',
      'completedAt'
    ];
    return existing.every((node, index) => fields.every((field) => String(node[field] || '') === String(next[index]?.[field] || '')));
  }

  /**
   * Retrieves all nodes from the SQLite database.
   */
  public getAllNodes(): RoadmapNode[] {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const res = this.db.exec('SELECT * FROM nodes');
    if (res.length === 0) {
      return [];
    }

    const columns = res[0].columns;
    const values = res[0].values;

    return values.map((row: any[]) => {
      const node: any = {};
      columns.forEach((col: string, idx: number) => {
        node[col] = row[idx];
      });
      return node as RoadmapNode;
    });
  }

  /**
   * Log an execution event to the SQL history.
   */
  public logExecution(
    nodeId: string,
    agentCli: string,
    command: string,
    output: string,
    status: string
  ): number {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    this.db.run(
      `INSERT INTO execution_logs (nodeId, timestamp, agentCli, command, output, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        nodeId,
        new Date().toISOString(),
        agentCli,
        command,
        output,
        status,
      ]
    );
    const idResult = this.db.exec('SELECT last_insert_rowid() AS id');
    const id = idResult[0]?.values?.[0]?.[0];
    this.save();
    return typeof id === 'number' ? id : Number(id || 0);
  }

  /**
   * Updates an existing execution log so one Agent run appears as one conversation.
   */
  public updateExecution(
    id: number,
    agentCli: string,
    command: string,
    output: string,
    status: string
  ): boolean {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    this.db.run(
      `UPDATE execution_logs
       SET agentCli = ?, command = ?, output = ?, status = ?
       WHERE id = ?`,
      [agentCli, command, output, status, id]
    );
    const changed = this.db.getRowsModified() > 0;
    this.save();
    return changed;
  }

  /**
   * Retrieves execution history for a roadmap node, newest first.
   */
  public getExecutionLogs(nodeId: string): AgentConversation[] {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const stmt = this.db.prepare(`
      SELECT id, nodeId, timestamp, agentCli, command, output, status
      FROM execution_logs
      WHERE nodeId = ?
      ORDER BY id DESC
    `);
    const logs: AgentConversation[] = [];
    try {
      stmt.bind([nodeId]);
      while (stmt.step()) {
        logs.push(stmt.getAsObject() as unknown as AgentConversation);
      }
    } finally {
      stmt.free();
    }
    const latestFinishedId = logs
      .filter((log) => log.status !== 'Running')
      .reduce((max, log) => Math.max(max, Number(log.id || 0)), 0);
    return logs.filter((log) => {
      if (log.status !== 'Running' || Number(log.id || 0) > latestFinishedId) {
        return true;
      }
      const output = String(log.output || '');
      return !/Agent conversation started|Launched command in integrated terminal/.test(output);
    });
  }

  /**
   * Closes the database.
   */
  public close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
