import * as path from 'path';
import type { DiskDatabase, SqlValue } from './diskDatabase.js';

type Row = Record<string, SqlValue>;
interface Store {
  db: DiskDatabase;
  rows(sql: string, values?: SqlValue[]): Row[];
  transaction<T>(operation: () => T): T;
  readTransaction<T>(operation: () => T): T;
}
export interface StorageRunOutputBatch {
  history: boolean;
  revision: number;
  nextProject: string;
  nextExecution: string;
  pending: boolean;
  records: Array<{ projectId: string; executionId: string; record: string; token?: string; outputPath: string; error: string | null }>;
}
export function runOutputRelativePath(output: unknown): string {
  const original = String(output || ''), normalized = original.replace(/\\/g, '/'), marker = '.solopreneur/agent-runs/';
  const at = normalized.indexOf(marker);
  const relative = at >= 0 ? normalized.slice(at + marker.length) : !path.isAbsolute(original) ? normalized : '';
  return relative && !relative.split('/').some(part => !part || part === '.' || part === '..') ? relative : '';
}
export const storageRunOutputsSchemaSql = `
CREATE TABLE content_lifecycle_run_outputs(
 project_id TEXT NOT NULL,execution_log_id INTEGER NOT NULL,output_path TEXT NOT NULL,error TEXT,
 PRIMARY KEY(project_id,execution_log_id),
 FOREIGN KEY(project_id,execution_log_id) REFERENCES project_run_indexes(project_id,execution_log_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE TABLE content_lifecycle_run_output_pending(
 project_id TEXT NOT NULL,execution_log_id INTEGER NOT NULL,version TEXT NOT NULL,
 PRIMARY KEY(project_id,execution_log_id),
 FOREIGN KEY(project_id,execution_log_id) REFERENCES project_run_indexes(project_id,execution_log_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE TABLE content_lifecycle_run_output_progress(
 id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0,
 project_cursor TEXT NOT NULL DEFAULT '',execution_cursor TEXT NOT NULL DEFAULT '0',
 upper_project TEXT NOT NULL,upper_execution TEXT NOT NULL
);
INSERT INTO content_lifecycle_run_output_progress(id,upper_project,upper_execution)
SELECT 1,COALESCE((SELECT project_id FROM project_run_indexes ORDER BY project_id DESC,execution_log_id DESC LIMIT 1),''),
 COALESCE((SELECT CAST(execution_log_id AS TEXT) FROM project_run_indexes ORDER BY project_id DESC,execution_log_id DESC LIMIT 1),'0');
CREATE TRIGGER content_lifecycle_run_output_insert AFTER INSERT ON project_run_indexes
WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT INTO content_lifecycle_run_output_pending VALUES(NEW.project_id,NEW.execution_log_id,lower(hex(randomblob(16))));
END;
CREATE TRIGGER content_lifecycle_run_output_update AFTER UPDATE OF record_json ON project_run_indexes
WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 DELETE FROM content_lifecycle_run_outputs WHERE project_id=NEW.project_id AND execution_log_id=NEW.execution_log_id;
 INSERT INTO content_lifecycle_run_output_pending VALUES(NEW.project_id,NEW.execution_log_id,lower(hex(randomblob(16))))
 ON CONFLICT(project_id,execution_log_id) DO UPDATE SET version=excluded.version;
END;
`;

/** Metadata projection only; it neither owns nor reads content payloads. */
export class StorageRunOutputs {
  constructor(private readonly store: Store) {}
  cache(projectId: string, executionId: number, output: unknown): void {
    const values = [projectId, executionId];
    this.store.db.run(`INSERT INTO content_lifecycle_run_outputs VALUES(?,?,?,NULL)
      ON CONFLICT(project_id,execution_log_id) DO UPDATE SET output_path=excluded.output_path,error=NULL`, [...values, runOutputRelativePath(output)]);
    this.store.db.run('DELETE FROM content_lifecycle_run_output_pending WHERE project_id=? AND execution_log_id=?', values);
  }
  prepare(limit: number): StorageRunOutputBatch {
    if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error('database_maintenance_limit_invalid');
    return this.store.readTransaction(() => {
      const progress = this.store.rows('SELECT * FROM content_lifecycle_run_output_progress WHERE id=1')[0];
      let rows = this.store.rows(`SELECT i.project_id,CAST(i.execution_log_id AS TEXT) AS execution_id,i.record_json,p.version
        FROM content_lifecycle_run_output_pending p JOIN project_run_indexes i USING(project_id,execution_log_id)
        ORDER BY p.project_id,p.execution_log_id LIMIT ?`, [limit]);
      const history = rows.length === 0;
      let nextProject = String(progress.project_cursor), nextExecution = String(progress.execution_cursor);
      if (history && (nextProject !== progress.upper_project || nextExecution !== progress.upper_execution)) {
        rows = this.store.rows(`SELECT i.project_id,CAST(i.execution_log_id AS TEXT) AS execution_id,i.record_json
          FROM project_run_indexes i WHERE (i.project_id,i.execution_log_id)>(?,CAST(? AS INTEGER))
          AND (i.project_id,i.execution_log_id)<=(?,CAST(? AS INTEGER)) ORDER BY i.project_id,i.execution_log_id LIMIT ?`,
        [nextProject, nextExecution, progress.upper_project, progress.upper_execution, limit]);
        nextProject = rows.length === limit ? String(rows.at(-1)!.project_id) : String(progress.upper_project);
        nextExecution = rows.length === limit ? String(rows.at(-1)!.execution_id) : String(progress.upper_execution);
      }
      const records: StorageRunOutputBatch['records'] = [];
      for (const row of rows) {
        if (history && this.store.rows('SELECT 1 FROM content_lifecycle_run_outputs WHERE project_id=? AND execution_log_id=?', [row.project_id, row.execution_id])[0]) continue;
        let outputPath = '', error: string | null = null;
        try {
          const record = JSON.parse(String(row.record_json));
          if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('run_index_metadata_invalid');
          outputPath = runOutputRelativePath(record.outputPath);
        }
        catch { error = 'run_index_metadata_invalid'; }
        records.push({ projectId: String(row.project_id), executionId: String(row.execution_id), record: String(row.record_json),
          ...(row.version ? { token: String(row.version) } : {}), outputPath, error });
      }
      return { history, revision: Number(progress.revision), nextProject, nextExecution, records,
        pending: rows.length > 0 || nextProject !== progress.project_cursor || nextExecution !== progress.execution_cursor };
    });
  }
  commit(batch: StorageRunOutputBatch): { applied: boolean } {
    if (!batch.pending) return { applied: false };
    return this.store.transaction(() => {
      const progress = this.store.rows('SELECT revision FROM content_lifecycle_run_output_progress WHERE id=1')[0];
      if (batch.history && Number(progress.revision) !== batch.revision) return { applied: false };
      let applied = false;
      for (const item of batch.records) {
        const keys = [item.projectId, item.executionId];
        const current = this.store.rows('SELECT record_json FROM project_run_indexes WHERE project_id=? AND execution_log_id=?', keys)[0];
        if (!current || current.record_json !== item.record) continue;
        const pending = this.store.rows('SELECT version FROM content_lifecycle_run_output_pending WHERE project_id=? AND execution_log_id=?', keys)[0];
        if (item.token ? pending?.version !== item.token : pending || this.store.rows('SELECT 1 FROM content_lifecycle_run_outputs WHERE project_id=? AND execution_log_id=?', keys)[0]) continue;
        this.store.db.run(`INSERT INTO content_lifecycle_run_outputs VALUES(?,?,?,?)
          ON CONFLICT(project_id,execution_log_id) DO UPDATE SET output_path=excluded.output_path,error=excluded.error`, [...keys, item.outputPath, item.error]);
        if (item.token) this.store.db.run('DELETE FROM content_lifecycle_run_output_pending WHERE project_id=? AND execution_log_id=? AND version=?', [...keys, item.token]);
        applied = true;
      }
      if (batch.history) {
        this.store.db.run('UPDATE content_lifecycle_run_output_progress SET revision=revision+1,project_cursor=?,execution_cursor=? WHERE id=1', [batch.nextProject, batch.nextExecution]);
        applied = true;
      }
      return { applied };
    });
  }
}
