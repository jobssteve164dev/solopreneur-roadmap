/** Published migration SQL is immutable; new versions append rather than rewrite V1. */
import { entityDefinitions } from './unifiedSchema';

export const runtimeEntityDefinitions: typeof entityDefinitions = {
  ...entityDefinitions,
  conversation: { ...entityDefinitions.conversation, project: false },
  message: { ...entityDefinitions.message, project: false }
};

function nullableConversationTable(kind: 'conversation' | 'message'): string {
  const definition = entityDefinitions[kind];
  const table = definition.table;
  const columns = [...definition.columns.matchAll(/(?:^|,)\s*([a-z_]+)\s/g)].map(match => match[1]);
  const scopedReferences = [...definition.columns.matchAll(/([a-z_]+) TEXT(?: NOT NULL)? REFERENCES ([a-z_]+)\(id\)/g)]
    .filter(match => ['conversations', 'roadmap_nodes', 'turns'].includes(match[2]));
  return `CREATE TABLE ${table}_nullable(id TEXT PRIMARY KEY,object_kind TEXT NOT NULL DEFAULT '${kind}' CHECK(object_kind='${kind}'),project_id TEXT,${definition.columns},UNIQUE(id,project_id),FOREIGN KEY(id,object_kind) REFERENCES objects(id,kind),FOREIGN KEY(id,project_id) REFERENCES objects(id,project_id)${scopedReferences.map(match => `,FOREIGN KEY(${match[1]},project_id) REFERENCES ${match[2]}(id,project_id)`).join('')}${definition.constraints ? ',' + definition.constraints : ''});
INSERT INTO ${table}_nullable SELECT id,object_kind,project_id,${columns.join(',')} FROM ${table};
DROP TABLE ${table};
ALTER TABLE ${table}_nullable RENAME TO ${table};
CREATE TRIGGER ${table}_scope_insert BEFORE INSERT ON ${table} WHEN NOT EXISTS(SELECT 1 FROM objects WHERE id=NEW.id AND project_id IS NEW.project_id) BEGIN SELECT RAISE(ABORT,'scope_mismatch'); END;
CREATE TRIGGER ${table}_scope_update BEFORE UPDATE OF project_id ON ${table} WHEN NEW.project_id IS NOT OLD.project_id BEGIN SELECT RAISE(ABORT,'immutable_scope'); END;
CREATE INDEX ${table}_scope ON ${table}(project_id);
${scopedReferences.map(match => `CREATE TRIGGER ${table}_${match[1]}_scope_insert BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${match[2]} WHERE id=NEW.${match[1]} AND project_id IS NOT NEW.project_id) BEGIN SELECT RAISE(ABORT,'scope_mismatch'); END;
CREATE TRIGGER ${table}_${match[1]}_scope_update BEFORE UPDATE OF ${match[1]} ON ${table} WHEN EXISTS(SELECT 1 FROM ${match[2]} WHERE id=NEW.${match[1]} AND project_id IS NOT NEW.project_id) BEGIN SELECT RAISE(ABORT,'scope_mismatch'); END;`).join('\n')}`;
}
const structuredMemoryColumns = 'legacy_entry_id TEXT, external_scope TEXT, layer TEXT, tags_json TEXT, provenance_json TEXT, validity_json TEXT, supersedes_json TEXT, metadata_json TEXT, external_entry_revision INTEGER';
export const additionalEntityColumns: Record<string, string> = { memory: structuredMemoryColumns + ', valid_from INTEGER' };

export const unifiedSchemaMigrations = [{ version: 2, sql: `
CREATE TABLE migration_jobs(
 id TEXT PRIMARY KEY,actor_id TEXT NOT NULL REFERENCES actors(id),idempotency_key TEXT NOT NULL,
 input_hash TEXT NOT NULL,args_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','interrupted','completed','completed_with_conflicts','failed')),
 progress_json TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 UNIQUE(actor_id,idempotency_key));
CREATE INDEX migration_jobs_pending ON migration_jobs(status,created_at);
` }, { version: 3, sql: structuredMemoryColumns.split(', ').map(column => `ALTER TABLE memories ADD COLUMN ${column};`).join('\n') }, { version: 4, sql: `ALTER TABLE memories ADD COLUMN valid_from INTEGER;
UPDATE memories SET valid_from=CAST(ROUND((julianday(json_extract(validity_json,'$.validFrom'))-2440587.5)*86400000) AS INTEGER) WHERE json_valid(validity_json) AND json_type(validity_json,'$.validFrom')='text';` }, { version: 5, sql: nullableConversationTable('conversation') + '\n' + nullableConversationTable('message') }, { version: 6, sql: `
CREATE TABLE migration_recycling(
 id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,source_identity TEXT NOT NULL,source_key TEXT NOT NULL,
 source_hash TEXT NOT NULL,source_content_id TEXT NOT NULL REFERENCES contents(id),original_path TEXT NOT NULL,byte_count INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('prepared','approved','moving','held','trashed','restoring','restored','changed')),
 error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX migration_recycling_plan ON migration_recycling(plan_id);
` }, { version: 7, sql: `
ALTER TABLE growth_snapshots ADD COLUMN project_path TEXT NOT NULL DEFAULT '';
ALTER TABLE growth_snapshots ADD COLUMN error TEXT NOT NULL DEFAULT '';
ALTER TABLE growth_edges ADD COLUMN evidence TEXT NOT NULL DEFAULT '';
ALTER TABLE growth_signals ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE growth_signals ADD COLUMN source_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE growth_signals ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE growth_module_labels(
 snapshot_id TEXT NOT NULL REFERENCES growth_snapshots(id),node_id TEXT NOT NULL,label TEXT NOT NULL,
 role TEXT NOT NULL,source TEXT NOT NULL,confidence REAL NOT NULL,updated_at INTEGER NOT NULL,
 PRIMARY KEY(snapshot_id,node_id));
CREATE TABLE growth_report_projection(
 project_id TEXT NOT NULL REFERENCES projects(id),key TEXT NOT NULL,value_json TEXT NOT NULL,updated_at INTEGER NOT NULL,
 PRIMARY KEY(project_id,key));
` }, { version: 8, sql: `
ALTER TABLE growth_snapshots ADD COLUMN payload_hash TEXT NOT NULL DEFAULT '';
` }, { version: 9, sql: `
CREATE TABLE project_journal_entries(
 execution_log_id INTEGER NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id),
 idempotency_key TEXT NOT NULL,node_id TEXT NOT NULL,timestamp TEXT NOT NULL,agent_cli TEXT NOT NULL,
 command TEXT NOT NULL,output TEXT NOT NULL,status TEXT NOT NULL,
 PRIMARY KEY(project_id,execution_log_id),UNIQUE(project_id,idempotency_key));
CREATE INDEX project_journal_project_node ON project_journal_entries(project_id,node_id,execution_log_id DESC);
CREATE TABLE project_run_indexes(
 project_id TEXT NOT NULL REFERENCES projects(id),execution_log_id INTEGER NOT NULL,
 record_json TEXT NOT NULL,files_json TEXT NOT NULL,signals_json TEXT NOT NULL,updated_at INTEGER NOT NULL,
 PRIMARY KEY(project_id,execution_log_id));
CREATE TABLE project_run_artifacts(
 project_id TEXT NOT NULL REFERENCES projects(id),execution_log_id INTEGER NOT NULL,relative_path TEXT NOT NULL,
 content_id TEXT NOT NULL REFERENCES contents(id),sha256 TEXT NOT NULL,mime_type TEXT NOT NULL,updated_at INTEGER NOT NULL,
 PRIMARY KEY(project_id,execution_log_id,relative_path));
` }];
