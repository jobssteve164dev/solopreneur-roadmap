import * as fs from 'fs';
import * as path from 'path';
import initSqlJs from 'sql.js';
import { RoadmapNode } from './types';

export class SqliteStore {
  private db: initSqlJs.Database | null = null;
  private SQL: initSqlJs.SqlJsStatic | null = null;

  constructor(
    private dbFilePath: string,
    private extensionPath: string
  ) {}

  /**
   * Initializes the SQLite WASM runtime and opens the database.
   */
  public async init(): Promise<void> {
    if (this.db) {
      return;
    }

    try {
      const wasmPath = path.join(
        this.extensionPath,
        'node_modules',
        'sql.js',
        'dist',
        'sql-wasm.wasm'
      );

      // Initialize the sql.js engine with the local wasm file
      this.SQL = await initSqlJs({
        locateFile: () => wasmPath,
      });

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
  ): void {
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
    this.save();
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
