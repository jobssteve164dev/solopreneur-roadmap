import * as fs from 'fs';
import * as path from 'path';
import initSqlJs from 'sql.js';
import {
  AgentConversation,
  GrowthEdgeRecord,
  GrowthModuleLabelRecord,
  GrowthNodeRecord,
  GrowthSignalRecord,
  GrowthSnapshotData,
  GrowthSnapshotRecord,
  RoadmapNode,
  RunIndexEntry,
  RunIndexFile,
  RunIndexRecord,
  RunIndexSignal
} from './types';
import {
  inferProjectRootForConversationStore,
  normalizeAgentConversationLifecycle
} from '../conversationLifecycle';

let sharedSqlJsRuntime: Promise<initSqlJs.SqlJsStatic> | null = null;

function getSqlJsRuntime(): Promise<initSqlJs.SqlJsStatic> {
  if (!sharedSqlJsRuntime) {
    sharedSqlJsRuntime = initSqlJs().catch((error) => {
      sharedSqlJsRuntime = null;
      throw error;
    });
  }
  return sharedSqlJsRuntime;
}

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
      this.SQL = await getSqlJsRuntime();

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
      'run_signals',
      'growth_snapshots',
      'growth_nodes',
      'growth_edges',
      'growth_signals',
      'growth_module_labels'
    ];
    const requiredIndexes = [
      'idx_execution_logs_node_id',
      'idx_run_records_node_id',
      'idx_run_records_status',
      'idx_run_records_run_kind',
      'idx_run_records_agent_cli',
      'idx_run_files_file_path',
      'idx_run_signals_type',
      'idx_growth_snapshots_created_at',
      'idx_growth_nodes_snapshot',
      'idx_growth_nodes_path',
      'idx_growth_edges_snapshot',
      'idx_growth_signals_snapshot',
      'idx_growth_signals_node',
      'idx_growth_module_labels_snapshot'
    ];
    let schemaChanged = requiredTables.some((name) => !this.sqliteObjectExists('table', name))
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
        inputTokens INTEGER DEFAULT 0,
        cachedInputTokens INTEGER DEFAULT 0,
        outputTokens INTEGER DEFAULT 0,
        reasoningOutputTokens INTEGER DEFAULT 0,
        totalTokens INTEGER DEFAULT 0,
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
    for (const [column, definition] of [
      ['inputTokens', 'INTEGER DEFAULT 0'],
      ['cachedInputTokens', 'INTEGER DEFAULT 0'],
      ['outputTokens', 'INTEGER DEFAULT 0'],
      ['reasoningOutputTokens', 'INTEGER DEFAULT 0'],
      ['totalTokens', 'INTEGER DEFAULT 0']
    ]) {
      if (!this.sqliteColumnExists('run_records', column)) {
        this.db.run(`ALTER TABLE run_records ADD COLUMN ${column} ${definition}`);
        schemaChanged = true;
      }
    }

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

    this.db.run(`
      CREATE TABLE IF NOT EXISTS growth_snapshots (
        id TEXT PRIMARY KEY,
        createdAt TEXT,
        projectPath TEXT,
        gitHead TEXT,
        scanReason TEXT,
        status TEXT,
        durationMs INTEGER,
        error TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS growth_nodes (
        snapshotId TEXT,
        nodeId TEXT,
        parentId TEXT,
        kind TEXT,
        path TEXT,
        label TEXT,
        language TEXT,
        bytes INTEGER,
        loc INTEGER,
        fileCount INTEGER,
        testFileCount INTEGER,
        generated INTEGER,
        excluded INTEGER,
        primaryRole TEXT,
        confidence REAL,
        PRIMARY KEY (snapshotId, nodeId)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS growth_edges (
        snapshotId TEXT,
        sourceId TEXT,
        targetId TEXT,
        kind TEXT,
        weight REAL,
        evidence TEXT,
        PRIMARY KEY (snapshotId, sourceId, targetId, kind)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS growth_signals (
        snapshotId TEXT,
        nodeId TEXT,
        type TEXT,
        level TEXT,
        value TEXT,
        source TEXT,
        sourceRef TEXT,
        createdAt TEXT,
        PRIMARY KEY (snapshotId, nodeId, type, value, sourceRef)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS growth_module_labels (
        snapshotId TEXT,
        nodeId TEXT,
        label TEXT,
        role TEXT,
        source TEXT,
        confidence REAL,
        updatedAt TEXT,
        PRIMARY KEY (snapshotId, nodeId, label, role, source)
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_growth_snapshots_created_at
      ON growth_snapshots (createdAt)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_growth_nodes_snapshot
      ON growth_nodes (snapshotId, kind)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_growth_nodes_path
      ON growth_nodes (path)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_growth_edges_snapshot
      ON growth_edges (snapshotId, kind)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_growth_signals_snapshot
      ON growth_signals (snapshotId, type, level)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_growth_signals_node
      ON growth_signals (nodeId, type)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_growth_module_labels_snapshot
      ON growth_module_labels (snapshotId, nodeId)
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

  private sqliteColumnExists(table: string, column: string): boolean {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const stmt = this.db.prepare(`PRAGMA table_info(${table})`);
    try {
      while (stmt.step()) {
        if (String((stmt.getAsObject() as any).name || '') === column) {
          return true;
        }
      }
      return false;
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
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens,
        totalTokens,
        outputPath,
        outputBytes,
        outputTail,
        commandPath,
        promptPath,
        changesPath,
        touchedFilesPath,
        updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        executionLogId,
        record.nodeId || '',
        record.runKind || 'step',
        record.agentCli || '',
        record.status || '',
        record.startedAt || '',
        record.finishedAt || '',
        Math.max(0, Number(record.durationMs || 0)),
        Math.max(0, Number(record.inputTokens || 0)),
        Math.max(0, Number(record.cachedInputTokens || 0)),
        Math.max(0, Number(record.outputTokens || 0)),
        Math.max(0, Number(record.reasoningOutputTokens || 0)),
        Math.max(0, Number(record.totalTokens || 0)),
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
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens,
        totalTokens,
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
          inputTokens: Math.max(0, Number(row.inputTokens || 0)),
          cachedInputTokens: Math.max(0, Number(row.cachedInputTokens || 0)),
          outputTokens: Math.max(0, Number(row.outputTokens || 0)),
          reasoningOutputTokens: Math.max(0, Number(row.reasoningOutputTokens || 0)),
          totalTokens: Math.max(0, Number(row.totalTokens || 0)),
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

  public writeGrowthSnapshot(data: GrowthSnapshotData): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const snapshot = data.snapshot;
    const snapshotId = String(snapshot.id || '').trim();
    if (!snapshotId) {
      throw new Error('Cannot write a growth snapshot without an id');
    }
    this.db.run('BEGIN TRANSACTION');
    try {
      this.db.run(
        `INSERT OR REPLACE INTO growth_snapshots (
          id,
          createdAt,
          projectPath,
          gitHead,
          scanReason,
          status,
          durationMs,
          error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          snapshotId,
          snapshot.createdAt || new Date().toISOString(),
          snapshot.projectPath || '',
          snapshot.gitHead || '',
          snapshot.scanReason || '',
          snapshot.status || '',
          Math.max(0, Number(snapshot.durationMs || 0)),
          snapshot.error || ''
        ]
      );

      this.db.run('DELETE FROM growth_nodes WHERE snapshotId = ?', [snapshotId]);
      this.db.run('DELETE FROM growth_edges WHERE snapshotId = ?', [snapshotId]);
      this.db.run('DELETE FROM growth_signals WHERE snapshotId = ?', [snapshotId]);
      this.db.run('DELETE FROM growth_module_labels WHERE snapshotId = ?', [snapshotId]);

      const nodeStmt = this.db.prepare(`
        INSERT OR REPLACE INTO growth_nodes (
          snapshotId,
          nodeId,
          parentId,
          kind,
          path,
          label,
          language,
          bytes,
          loc,
          fileCount,
          testFileCount,
          generated,
          excluded,
          primaryRole,
          confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      try {
        for (const node of data.nodes) {
          const nodeId = String(node.nodeId || '').trim();
          if (!nodeId) {
            continue;
          }
          nodeStmt.run([
            snapshotId,
            nodeId,
            node.parentId || '',
            node.kind || '',
            node.path || '',
            node.label || '',
            node.language || '',
            Math.max(0, Number(node.bytes || 0)),
            Math.max(0, Number(node.loc || 0)),
            Math.max(0, Number(node.fileCount || 0)),
            Math.max(0, Number(node.testFileCount || 0)),
            node.generated ? 1 : 0,
            node.excluded ? 1 : 0,
            node.primaryRole || '',
            Math.max(0, Math.min(1, Number(node.confidence || 0)))
          ]);
        }
      } finally {
        nodeStmt.free();
      }

      const edgeStmt = this.db.prepare(`
        INSERT OR IGNORE INTO growth_edges (
          snapshotId,
          sourceId,
          targetId,
          kind,
          weight,
          evidence
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      try {
        for (const edge of data.edges) {
          const sourceId = String(edge.sourceId || '').trim();
          const targetId = String(edge.targetId || '').trim();
          const kind = String(edge.kind || '').trim();
          if (!sourceId || !targetId || !kind) {
            continue;
          }
          edgeStmt.run([
            snapshotId,
            sourceId,
            targetId,
            kind,
            Math.max(0, Number(edge.weight || 0)),
            edge.evidence || ''
          ]);
        }
      } finally {
        edgeStmt.free();
      }

      const signalStmt = this.db.prepare(`
        INSERT OR IGNORE INTO growth_signals (
          snapshotId,
          nodeId,
          type,
          level,
          value,
          source,
          sourceRef,
          createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      try {
        for (const signal of data.signals) {
          const nodeId = String(signal.nodeId || '').trim();
          const type = String(signal.type || '').trim();
          const value = String(signal.value || '').trim();
          if (!nodeId || !type || !value) {
            continue;
          }
          signalStmt.run([
            snapshotId,
            nodeId,
            type,
            signal.level || 'info',
            value,
            signal.source || '',
            signal.sourceRef || '',
            signal.createdAt || snapshot.createdAt || new Date().toISOString()
          ]);
        }
      } finally {
        signalStmt.free();
      }

      const labelStmt = this.db.prepare(`
        INSERT OR IGNORE INTO growth_module_labels (
          snapshotId,
          nodeId,
          label,
          role,
          source,
          confidence,
          updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      try {
        for (const label of data.labels) {
          const nodeId = String(label.nodeId || '').trim();
          const value = String(label.label || '').trim();
          if (!nodeId || !value) {
            continue;
          }
          labelStmt.run([
            snapshotId,
            nodeId,
            value,
            label.role || '',
            label.source || '',
            Math.max(0, Math.min(1, Number(label.confidence || 0))),
            label.updatedAt || snapshot.createdAt || new Date().toISOString()
          ]);
        }
      } finally {
        labelStmt.free();
      }

      this.db.run('COMMIT');
      this.save();
    } catch (error) {
      try {
        this.db.run('ROLLBACK');
      } catch {}
      throw error;
    }
  }

  public getLatestGrowthSnapshot(): GrowthSnapshotData | null {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const snapshotStmt = this.db.prepare(`
      SELECT id, createdAt, projectPath, gitHead, scanReason, status, durationMs, error
      FROM growth_snapshots
      ORDER BY createdAt DESC
      LIMIT 1
    `);
    let snapshot: GrowthSnapshotRecord | null = null;
    try {
      if (snapshotStmt.step()) {
        const row = snapshotStmt.getAsObject() as any;
        snapshot = {
          id: String(row.id || ''),
          createdAt: String(row.createdAt || ''),
          projectPath: String(row.projectPath || ''),
          gitHead: String(row.gitHead || ''),
          scanReason: String(row.scanReason || ''),
          status: String(row.status || ''),
          durationMs: Math.max(0, Number(row.durationMs || 0)),
          error: String(row.error || '')
        };
      }
    } finally {
      snapshotStmt.free();
    }
    if (!snapshot) {
      return null;
    }
    return {
      snapshot,
      nodes: this.getGrowthNodes(snapshot.id),
      edges: this.getGrowthEdges(snapshot.id),
      signals: this.getGrowthSignals(snapshot.id),
      labels: this.getGrowthModuleLabels(snapshot.id)
    };
  }

  public getGrowthSnapshotById(snapshotId: string): GrowthSnapshotData | null {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const id = String(snapshotId || '').trim();
    if (!id) {
      return null;
    }
    const snapshotStmt = this.db.prepare(`
      SELECT id, createdAt, projectPath, gitHead, scanReason, status, durationMs, error
      FROM growth_snapshots
      WHERE id = ?
      LIMIT 1
    `);
    let snapshot: GrowthSnapshotRecord | null = null;
    try {
      snapshotStmt.bind([id]);
      if (snapshotStmt.step()) {
        const row = snapshotStmt.getAsObject() as any;
        snapshot = {
          id: String(row.id || ''),
          createdAt: String(row.createdAt || ''),
          projectPath: String(row.projectPath || ''),
          gitHead: String(row.gitHead || ''),
          scanReason: String(row.scanReason || ''),
          status: String(row.status || ''),
          durationMs: Math.max(0, Number(row.durationMs || 0)),
          error: String(row.error || '')
        };
      }
    } finally {
      snapshotStmt.free();
    }
    if (!snapshot) {
      return null;
    }
    return {
      snapshot,
      nodes: this.getGrowthNodes(snapshot.id),
      edges: this.getGrowthEdges(snapshot.id),
      signals: this.getGrowthSignals(snapshot.id),
      labels: this.getGrowthModuleLabels(snapshot.id)
    };
  }

  public getGrowthSnapshotHistory(limit = 12): GrowthSnapshotRecord[] {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const stmt = this.db.prepare(`
      SELECT id, createdAt, projectPath, gitHead, scanReason, status, durationMs, error
      FROM growth_snapshots
      ORDER BY createdAt DESC
      LIMIT ?
    `);
    const rows: GrowthSnapshotRecord[] = [];
    try {
      stmt.bind([Math.max(1, Math.min(50, Number(limit || 12)))]);
      while (stmt.step()) {
        const row = stmt.getAsObject() as any;
        rows.push({
          id: String(row.id || ''),
          createdAt: String(row.createdAt || ''),
          projectPath: String(row.projectPath || ''),
          gitHead: String(row.gitHead || ''),
          scanReason: String(row.scanReason || ''),
          status: String(row.status || ''),
          durationMs: Math.max(0, Number(row.durationMs || 0)),
          error: String(row.error || '')
        });
      }
    } finally {
      stmt.free();
    }
    return rows;
  }

  private getGrowthNodes(snapshotId: string): GrowthNodeRecord[] {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const stmt = this.db.prepare(`
      SELECT snapshotId, nodeId, parentId, kind, path, label, language, bytes, loc, fileCount, testFileCount, generated, excluded, primaryRole, confidence
      FROM growth_nodes
      WHERE snapshotId = ?
      ORDER BY kind ASC, path ASC, nodeId ASC
    `);
    const rows: GrowthNodeRecord[] = [];
    try {
      stmt.bind([snapshotId]);
      while (stmt.step()) {
        const row = stmt.getAsObject() as any;
        rows.push({
          snapshotId: String(row.snapshotId || ''),
          nodeId: String(row.nodeId || ''),
          parentId: String(row.parentId || ''),
          kind: String(row.kind || ''),
          path: String(row.path || ''),
          label: String(row.label || ''),
          language: String(row.language || ''),
          bytes: Math.max(0, Number(row.bytes || 0)),
          loc: Math.max(0, Number(row.loc || 0)),
          fileCount: Math.max(0, Number(row.fileCount || 0)),
          testFileCount: Math.max(0, Number(row.testFileCount || 0)),
          generated: Boolean(Number(row.generated || 0)),
          excluded: Boolean(Number(row.excluded || 0)),
          primaryRole: String(row.primaryRole || ''),
          confidence: Math.max(0, Math.min(1, Number(row.confidence || 0)))
        });
      }
    } finally {
      stmt.free();
    }
    return rows;
  }

  private getGrowthEdges(snapshotId: string): GrowthEdgeRecord[] {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const stmt = this.db.prepare(`
      SELECT snapshotId, sourceId, targetId, kind, weight, evidence
      FROM growth_edges
      WHERE snapshotId = ?
      ORDER BY kind ASC, sourceId ASC, targetId ASC
    `);
    const rows: GrowthEdgeRecord[] = [];
    try {
      stmt.bind([snapshotId]);
      while (stmt.step()) {
        const row = stmt.getAsObject() as any;
        rows.push({
          snapshotId: String(row.snapshotId || ''),
          sourceId: String(row.sourceId || ''),
          targetId: String(row.targetId || ''),
          kind: String(row.kind || ''),
          weight: Math.max(0, Number(row.weight || 0)),
          evidence: String(row.evidence || '')
        });
      }
    } finally {
      stmt.free();
    }
    return rows;
  }

  private getGrowthSignals(snapshotId: string): GrowthSignalRecord[] {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const stmt = this.db.prepare(`
      SELECT snapshotId, nodeId, type, level, value, source, sourceRef, createdAt
      FROM growth_signals
      WHERE snapshotId = ?
      ORDER BY level DESC, type ASC, nodeId ASC
    `);
    const rows: GrowthSignalRecord[] = [];
    try {
      stmt.bind([snapshotId]);
      while (stmt.step()) {
        const row = stmt.getAsObject() as any;
        rows.push({
          snapshotId: String(row.snapshotId || ''),
          nodeId: String(row.nodeId || ''),
          type: String(row.type || ''),
          level: String(row.level || ''),
          value: String(row.value || ''),
          source: String(row.source || ''),
          sourceRef: String(row.sourceRef || ''),
          createdAt: String(row.createdAt || '')
        });
      }
    } finally {
      stmt.free();
    }
    return rows;
  }

  private getGrowthModuleLabels(snapshotId: string): GrowthModuleLabelRecord[] {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const stmt = this.db.prepare(`
      SELECT snapshotId, nodeId, label, role, source, confidence, updatedAt
      FROM growth_module_labels
      WHERE snapshotId = ?
      ORDER BY nodeId ASC, confidence DESC
    `);
    const rows: GrowthModuleLabelRecord[] = [];
    try {
      stmt.bind([snapshotId]);
      while (stmt.step()) {
        const row = stmt.getAsObject() as any;
        rows.push({
          snapshotId: String(row.snapshotId || ''),
          nodeId: String(row.nodeId || ''),
          label: String(row.label || ''),
          role: String(row.role || ''),
          source: String(row.source || ''),
          confidence: Math.max(0, Math.min(1, Number(row.confidence || 0))),
          updatedAt: String(row.updatedAt || '')
        });
      }
    } finally {
      stmt.free();
    }
    return rows;
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
   * Retrieves one bounded page of execution history for a roadmap node, newest first.
   */
  public getExecutionLogPage(nodeId: string, limit = 20, offset = 0): { logs: AgentConversation[]; hasMore: boolean } {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const stmt = this.db.prepare(`
      SELECT id, nodeId, timestamp, agentCli, command, output, status
      FROM execution_logs
      WHERE nodeId = ?
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `);
    const logs: AgentConversation[] = [];
    try {
      stmt.bind([nodeId, safeLimit + 1, safeOffset]);
      while (stmt.step()) {
        logs.push(stmt.getAsObject() as unknown as AgentConversation);
      }
    } finally {
      stmt.free();
    }
    const hasMore = logs.length > safeLimit;
    const page = logs.slice(0, safeLimit);
    return {
      logs: this.filterSupersededRunningLogs(page.map((log) => this.normalizeConversationStatus(log)))
        .map((log) => this.normalizeConversationStatus(log)),
      hasMore
    };
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
