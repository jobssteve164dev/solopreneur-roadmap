import * as fs from 'fs';
import * as path from 'path';
import initSqlJs from 'sql.js';
import { AgentConversation, RoadmapNode, RunIndexEntry, RunIndexFile, RunIndexRecord, RunIndexSignal } from './types';
import {
  inferProjectRootForConversationStore,
  normalizeAgentConversationLifecycle
} from '../conversationLifecycle';

export class SqliteStore {
  private db: initSqlJs.Database | null = null;
  private SQL: initSqlJs.SqlJsStatic | null = null;
  private readonly projectRoot: string;

  constructor(
    private dbFilePath: string,
    private extensionPath: string
  ) {
    this.projectRoot = inferProjectRootForConversationStore(dbFilePath);
  }

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

      const existed = fs.existsSync(this.dbFilePath);
      if (existed) {
        const fileBuffer = fs.readFileSync(this.dbFilePath);
        this.db = new this.SQL.Database(fileBuffer);
      } else {
        this.db = new this.SQL.Database();
      }
      const schemaChanged = this.createTables();
      if (!existed || schemaChanged) {
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
  private createTables(): boolean {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const requiredTables = [
      'nodes',
      'execution_logs',
      'run_records',
      'run_files',
      'run_signals'
    ];
    const requiredIndexes = [
      'idx_execution_logs_node_id',
      'idx_run_records_node_id',
      'idx_run_records_status',
      'idx_run_records_run_kind',
      'idx_run_records_agent_cli',
      'idx_run_files_file_path',
      'idx_run_signals_type'
    ];
    const schemaChanged = requiredTables.some((name) => !this.sqliteObjectExists('table', name))
      || requiredIndexes.some((name) => !this.sqliteObjectExists('index', name));

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

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_execution_logs_node_id
      ON execution_logs (nodeId, id)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS run_records (
        executionLogId INTEGER PRIMARY KEY,
        nodeId TEXT,
        runKind TEXT,
        agentCli TEXT,
        status TEXT,
        startedAt TEXT,
        finishedAt TEXT,
        durationMs INTEGER,
        outputPath TEXT,
        outputBytes INTEGER,
        outputTail TEXT,
        commandPath TEXT,
        promptPath TEXT,
        changesPath TEXT,
        touchedFilesPath TEXT,
        updatedAt TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS run_files (
        executionLogId INTEGER,
        filePath TEXT,
        role TEXT,
        PRIMARY KEY (executionLogId, filePath, role)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS run_signals (
        executionLogId INTEGER,
        type TEXT,
        value TEXT,
        PRIMARY KEY (executionLogId, type, value)
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_run_records_node_id
      ON run_records (nodeId, executionLogId)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_run_records_status
      ON run_records (status)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_run_records_run_kind
      ON run_records (runKind)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_run_records_agent_cli
      ON run_records (agentCli)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_run_files_file_path
      ON run_files (filePath)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_run_signals_type
      ON run_signals (type)
    `);
    return schemaChanged;
  }

  private sqliteObjectExists(type: string, name: string): boolean {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const stmt = this.db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?');
    try {
      stmt.bind([type, name]);
      return stmt.step();
    } finally {
      stmt.free();
    }
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

  private normalizeConversationStatus(log: AgentConversation): AgentConversation {
    const normalized = normalizeAgentConversationLifecycle(this.projectRoot, log);
    if (normalized.status !== log.status) {
      return {
        ...normalized,
        output: this.persistLifecycleStatus(normalized, log.status)
      };
    }
    return normalized;
  }

  private persistLifecycleStatus(log: AgentConversation, previousStatus: string): string {
    if (!this.db || !log.id) {
      return String(log.output || '');
    }
    const output = String(log.output || '');
    const lifecycleNote = `SoloMap lifecycle reconciliation: ${previousStatus || 'Unknown'} -> ${log.status}`;
    const nextOutput = output.includes('SoloMap lifecycle reconciliation:')
      ? output
      : [output, lifecycleNote].filter(Boolean).join('\n\n');
    this.db.run(
      `UPDATE execution_logs
       SET output = ?, status = ?
       WHERE id = ?`,
      [nextOutput, log.status, log.id]
    );
    this.save();
    return nextOutput;
  }

  private filterSupersededRunningLogs(logs: AgentConversation[]): AgentConversation[] {
    const latestFinishedByNode = new Map<string, number>();
    logs.forEach((log) => {
      if (log.status === 'Running') {
        return;
      }
      const nodeId = String(log.nodeId || '');
      latestFinishedByNode.set(nodeId, Math.max(latestFinishedByNode.get(nodeId) || 0, Number(log.id || 0)));
    });
    return logs.filter((log) => {
      if (log.status !== 'Running' || Number(log.id || 0) > (latestFinishedByNode.get(String(log.nodeId || '')) || 0)) {
        return true;
      }
      const output = String(log.output || '');
      return !/Agent conversation started|Launched command in integrated terminal/.test(output);
    });
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

  public upsertRunIndex(record: RunIndexRecord, files: RunIndexFile[] = [], signals: RunIndexSignal[] = []): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const executionLogId = Number(record.executionLogId || 0);
    if (!executionLogId) {
      throw new Error('Cannot index a run without an executionLogId');
    }
    this.db.run(
      `INSERT OR REPLACE INTO run_records (
        executionLogId,
        nodeId,
        runKind,
        agentCli,
        status,
        startedAt,
        finishedAt,
        durationMs,
        outputPath,
        outputBytes,
        outputTail,
        commandPath,
        promptPath,
        changesPath,
        touchedFilesPath,
        updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        executionLogId,
        record.nodeId || '',
        record.runKind || 'step',
        record.agentCli || '',
        record.status || '',
        record.startedAt || '',
        record.finishedAt || '',
        Math.max(0, Number(record.durationMs || 0)),
        record.outputPath || '',
        Math.max(0, Number(record.outputBytes || 0)),
        record.outputTail || '',
        record.commandPath || '',
        record.promptPath || '',
        record.changesPath || '',
        record.touchedFilesPath || '',
        record.updatedAt || new Date().toISOString()
      ]
    );

    this.db.run('DELETE FROM run_files WHERE executionLogId = ?', [executionLogId]);
    const fileStmt = this.db.prepare('INSERT OR IGNORE INTO run_files (executionLogId, filePath, role) VALUES (?, ?, ?)');
    try {
      for (const file of files) {
        const filePath = String(file.filePath || '').trim();
        const role = String(file.role || '').trim();
        if (filePath && role) {
          fileStmt.run([executionLogId, filePath, role]);
        }
      }
    } finally {
      fileStmt.free();
    }

    this.db.run('DELETE FROM run_signals WHERE executionLogId = ?', [executionLogId]);
    const signalStmt = this.db.prepare('INSERT OR IGNORE INTO run_signals (executionLogId, type, value) VALUES (?, ?, ?)');
    try {
      for (const signal of signals) {
        const type = String(signal.type || '').trim();
        const value = String(signal.value || '').trim();
        if (type && value) {
          signalStmt.run([executionLogId, type, value]);
        }
      }
    } finally {
      signalStmt.free();
    }
    this.save();
  }

  public getRunIndexEntries(): RunIndexEntry[] {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const entries = new Map<number, RunIndexEntry>();
    const runStmt = this.db.prepare(`
      SELECT
        executionLogId,
        nodeId,
        runKind,
        agentCli,
        status,
        startedAt,
        finishedAt,
        durationMs,
        outputPath,
        outputBytes,
        outputTail,
        commandPath,
        promptPath,
        changesPath,
        touchedFilesPath,
        updatedAt
      FROM run_records
      ORDER BY finishedAt DESC, executionLogId DESC
    `);
    try {
      while (runStmt.step()) {
        const row = runStmt.getAsObject() as any;
        const executionLogId = Number(row.executionLogId || 0);
        entries.set(executionLogId, {
          executionLogId,
          nodeId: String(row.nodeId || ''),
          runKind: String(row.runKind || ''),
          agentCli: String(row.agentCli || ''),
          status: String(row.status || ''),
          startedAt: String(row.startedAt || ''),
          finishedAt: String(row.finishedAt || ''),
          durationMs: Math.max(0, Number(row.durationMs || 0)),
          outputPath: String(row.outputPath || ''),
          outputBytes: Math.max(0, Number(row.outputBytes || 0)),
          outputTail: String(row.outputTail || ''),
          commandPath: String(row.commandPath || ''),
          promptPath: String(row.promptPath || ''),
          changesPath: String(row.changesPath || ''),
          touchedFilesPath: String(row.touchedFilesPath || ''),
          updatedAt: String(row.updatedAt || ''),
          files: [],
          signals: []
        });
      }
    } finally {
      runStmt.free();
    }

    const fileStmt = this.db.prepare('SELECT executionLogId, filePath, role FROM run_files ORDER BY executionLogId DESC, filePath ASC');
    try {
      while (fileStmt.step()) {
        const row = fileStmt.getAsObject() as any;
        const executionLogId = Number(row.executionLogId || 0);
        const entry = entries.get(executionLogId);
        if (entry) {
          entry.files.push({
            executionLogId,
            filePath: String(row.filePath || ''),
            role: String(row.role || '')
          });
        }
      }
    } finally {
      fileStmt.free();
    }

    const signalStmt = this.db.prepare('SELECT executionLogId, type, value FROM run_signals ORDER BY executionLogId DESC, type ASC');
    try {
      while (signalStmt.step()) {
        const row = signalStmt.getAsObject() as any;
        const executionLogId = Number(row.executionLogId || 0);
        const entry = entries.get(executionLogId);
        if (entry) {
          entry.signals.push({
            executionLogId,
            type: String(row.type || ''),
            value: String(row.value || '')
          });
        }
      }
    } finally {
      signalStmt.free();
    }
    return [...entries.values()];
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
    return this.filterSupersededRunningLogs(logs.map((log) => this.normalizeConversationStatus(log)))
      .map((log) => this.normalizeConversationStatus(log));
  }

  /**
   * Retrieves execution history across all roadmap nodes, newest first.
   */
  public getAllExecutionLogs(): AgentConversation[] {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const stmt = this.db.prepare(`
      SELECT id, nodeId, timestamp, agentCli, command, output, status
      FROM execution_logs
      ORDER BY id DESC
    `);
    const logs: AgentConversation[] = [];
    try {
      while (stmt.step()) {
        logs.push(stmt.getAsObject() as unknown as AgentConversation);
      }
    } finally {
      stmt.free();
    }
    return this.filterSupersededRunningLogs(logs.map((log) => this.normalizeConversationStatus(log)))
      .map((log) => this.normalizeConversationStatus(log));
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
