/** Published migration SQL is immutable; new versions append rather than rewrite V1. */
import { entityDefinitions } from './unifiedSchema';

export const runtimeEntityDefinitions: typeof entityDefinitions = {
  ...entityDefinitions,
  project: { ...entityDefinitions.project, columns: entityDefinitions.project.columns + ', notes_content_id TEXT REFERENCES contents(id)' },
  turn: { ...entityDefinitions.turn, columns: entityDefinitions.turn.columns.replace('request_content_id TEXT NOT NULL', 'request_content_id TEXT').replace('started_at INTEGER NOT NULL', 'started_at INTEGER') },
  conversation: { ...entityDefinitions.conversation, project: false },
  message: { ...entityDefinitions.message, project: false },
  evidence: { ...entityDefinitions.evidence, project: false },
  runtime_instance: { ...entityDefinitions.runtime_instance, columns: entityDefinitions.runtime_instance.columns.replace('process_started_at INTEGER NOT NULL', "process_started_at INTEGER NOT NULL, process_birth TEXT NOT NULL DEFAULT ''") }
};

function nullableConversationTable(kind: 'conversation' | 'message' | 'evidence'): string {
  const definition = entityDefinitions[kind];
  const table = definition.table;
  const columns = [...definition.columns.matchAll(/(?:^|,)\s*([a-z_]+)\s/g)].map(match => match[1]);
  const scopedReferences = [...definition.columns.matchAll(/([a-z_]+) TEXT(?: NOT NULL)? REFERENCES ([a-z_]+)\(id\)/g)]
    .filter(match => (kind === 'evidence' ? ['runs', 'file_bindings'] : ['conversations', 'roadmap_nodes', 'turns']).includes(match[2]));
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
const lessonSourceColumns = 'lesson_type TEXT, source_type TEXT, promotion_target TEXT, evidence_refs_json TEXT, source_event_ids_json TEXT, legacy_lesson_id TEXT, external_created_at INTEGER, external_updated_at INTEGER, external_confidence TEXT, semantic_review_json TEXT';
const learningEventSourceColumns = 'source_type TEXT, verification_signal INTEGER CHECK(verification_signal IN (0,1))';
const lessonDecisionSourceColumns = 'legacy_decision_id TEXT, external_source TEXT, external_created_at INTEGER, external_updated_at INTEGER, event_revision INTEGER, lesson_revision INTEGER, source_object_id TEXT REFERENCES evidence(id), source_revision INTEGER';
export const additionalEntityColumns: Record<string, string> = { memory: structuredMemoryColumns + ', valid_from INTEGER', lesson: lessonSourceColumns, learning_event: learningEventSourceColumns, lesson_decision: lessonDecisionSourceColumns };

function analysisTimestamp(value: string): string {
  return `COALESCE(CAST(ROUND((julianday(${value})-2440587.5)*86400000) AS INTEGER),0)`;
}
function analysisRunTimestamp(record = 'record_json'): string {
  return `MAX(${analysisTimestamp(`json_extract(${record},'$.finishedAt')`)},${analysisTimestamp(`json_extract(${record},'$.startedAt')`)})`;
}
function latestRunTimestamp(projectId: string): string {
  return `(SELECT COALESCE(MAX(${analysisRunTimestamp()}),0) FROM project_run_indexes WHERE project_id=${projectId})`;
}
function latestJournalTimestamp(projectId: string): string {
  return `(SELECT COALESCE(MAX(${analysisTimestamp('timestamp')}),0) FROM project_journal_entries WHERE project_id=${projectId})`;
}
function refreshRunAnalysisSource(projectId: string, oldTimestamp: string, newTimestamp: string): string {
  const latestRun = latestRunTimestamp(projectId);
  const recent = `MAX(${latestRun},${latestJournalTimestamp(projectId)})`;
  return `UPDATE project_analysis_sources SET revision=revision+1,
latest_run_at=CASE WHEN ${newTimestamp}>=latest_run_at THEN ${newTimestamp} WHEN ${oldTimestamp}=latest_run_at THEN ${latestRun} ELSE latest_run_at END,
recent_activity_at=CASE WHEN ${newTimestamp}>=recent_activity_at THEN ${newTimestamp} WHEN ${oldTimestamp}=latest_run_at THEN ${recent} ELSE recent_activity_at END
WHERE project_id=${projectId};`;
}
function refreshJournalAnalysisSource(projectId: string, oldTimestamp: string, newTimestamp: string): string {
  const recent = `MAX(${latestRunTimestamp(projectId)},${latestJournalTimestamp(projectId)})`;
  return `UPDATE project_analysis_sources SET revision=revision+1,
recent_activity_at=CASE WHEN ${newTimestamp}>=recent_activity_at THEN ${newTimestamp} WHEN ${oldTimestamp}=recent_activity_at THEN ${recent} ELSE recent_activity_at END
WHERE project_id=${projectId};`;
}
function touchProjectAnalysisSource(projectId: string): string {
  return `INSERT INTO project_analysis_sources(project_id,revision,run_count,latest_run_at,recent_activity_at) VALUES(${projectId},1,0,0,0)
ON CONFLICT(project_id) DO UPDATE SET revision=project_analysis_sources.revision+1;`;
}

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
` }, { version: 10, sql: `
CREATE TABLE maintenance_tasks(
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('migration_review','recycling_apply')),
 target_id TEXT,
 status TEXT NOT NULL CHECK(status IN ('ready','running','completed','failed','revoked')),
 error TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 valid_until INTEGER NOT NULL);
CREATE INDEX maintenance_tasks_status ON maintenance_tasks(status,updated_at);
` }, { version: 11, sql: `
CREATE TABLE maintenance_tasks_v11(
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('migration_review','migration_apply','recycling_apply')),
 target_id TEXT,
 status TEXT NOT NULL CHECK(status IN ('ready','running','completed','failed','revoked')),
 error TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 valid_until INTEGER NOT NULL);
INSERT INTO maintenance_tasks_v11 SELECT * FROM maintenance_tasks;
DROP TABLE maintenance_tasks;
ALTER TABLE maintenance_tasks_v11 RENAME TO maintenance_tasks;
CREATE INDEX maintenance_tasks_status ON maintenance_tasks(status,updated_at);
` }, { version: 12, sql: lessonSourceColumns.split(', ').map(column => `ALTER TABLE lessons ADD COLUMN ${column};`).join('\n') + '\n' + learningEventSourceColumns.split(', ').map(column => `ALTER TABLE learning_events ADD COLUMN ${column};`).join('\n') + '\n' + lessonDecisionSourceColumns.split(', ').map(column => `ALTER TABLE lesson_decisions ADD COLUMN ${column};`).join('\n') + '\n' + nullableConversationTable('evidence') + `
CREATE TABLE lesson_decision_candidates(
 decision_id TEXT NOT NULL REFERENCES lesson_decisions(id),decision_revision INTEGER NOT NULL,ordinal INTEGER NOT NULL,
 project_id TEXT REFERENCES projects(id),lesson_id TEXT NOT NULL REFERENCES lessons(id),lesson_revision INTEGER,
 PRIMARY KEY(decision_id,decision_revision,ordinal),
 FOREIGN KEY(decision_id,project_id) REFERENCES lesson_decisions(id,project_id),
 FOREIGN KEY(decision_id,decision_revision) REFERENCES object_revisions(object_id,revision),
 FOREIGN KEY(lesson_id,lesson_revision) REFERENCES object_revisions(object_id,revision));
CREATE TRIGGER lesson_decision_candidates_scope BEFORE INSERT ON lesson_decision_candidates
 WHEN NOT EXISTS(SELECT 1 FROM lesson_decisions WHERE id=NEW.decision_id AND project_id IS NEW.project_id)
 OR NOT EXISTS(SELECT 1 FROM lessons WHERE id=NEW.lesson_id AND (project_id IS NULL OR project_id IS NEW.project_id))
 BEGIN SELECT RAISE(ABORT,'scope_mismatch'); END;
CREATE TABLE lesson_event_refs(
 lesson_id TEXT NOT NULL REFERENCES lessons(id),lesson_revision INTEGER NOT NULL,ordinal INTEGER NOT NULL,
 project_id TEXT REFERENCES projects(id),source_id TEXT NOT NULL,
 event_id TEXT REFERENCES learning_events(id),event_revision INTEGER,
 PRIMARY KEY(lesson_id,lesson_revision,ordinal),
 FOREIGN KEY(lesson_id,lesson_revision) REFERENCES object_revisions(object_id,revision),
 FOREIGN KEY(event_id,event_revision) REFERENCES object_revisions(object_id,revision),
 CHECK((event_id IS NULL)=(event_revision IS NULL)));
CREATE TRIGGER lesson_event_refs_scope BEFORE INSERT ON lesson_event_refs
 WHEN NOT EXISTS(SELECT 1 FROM lessons WHERE id=NEW.lesson_id AND project_id IS NEW.project_id)
 OR (NEW.event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM learning_events WHERE id=NEW.event_id AND (project_id IS NULL OR project_id IS NEW.project_id)))
 BEGIN SELECT RAISE(ABORT,'scope_mismatch'); END;
CREATE TABLE legacy_lesson_sources(
 source_identity TEXT NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id),legacy_lesson_id TEXT NOT NULL,
 object_id TEXT NOT NULL UNIQUE REFERENCES lessons(id),imported_revision INTEGER NOT NULL,
 source_updated_at INTEGER NOT NULL,source_key TEXT NOT NULL,
 PRIMARY KEY(source_identity,project_id,legacy_lesson_id),
 FOREIGN KEY(object_id,project_id) REFERENCES lessons(id,project_id));
CREATE TABLE run_digests(
 object_id TEXT PRIMARY KEY REFERENCES evidence(id),project_id TEXT NOT NULL REFERENCES projects(id),
 content_id TEXT NOT NULL REFERENCES contents(id),node_key TEXT NOT NULL,run_kind TEXT NOT NULL,
 run_key TEXT NOT NULL,finished_at TEXT NOT NULL,execution_log_id INTEGER NOT NULL,
 UNIQUE(object_id,project_id));
CREATE INDEX run_digests_project ON run_digests(project_id,finished_at DESC,object_id);
CREATE TABLE run_digest_generations(
 project_id TEXT PRIMARY KEY REFERENCES projects(id),revision INTEGER NOT NULL);
CREATE TABLE run_digest_sources(
 project_id TEXT NOT NULL REFERENCES projects(id),source_key TEXT NOT NULL,object_id TEXT NOT NULL,
 projection_object_id TEXT NOT NULL UNIQUE REFERENCES evidence(id),
 source_hash TEXT NOT NULL,PRIMARY KEY(project_id,source_key),UNIQUE(object_id),
 FOREIGN KEY(object_id,project_id) REFERENCES run_digests(object_id,project_id));
CREATE TABLE run_digest_signals(
 project_id TEXT NOT NULL,object_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('file','tag')),ordinal INTEGER NOT NULL,
 value TEXT NOT NULL,PRIMARY KEY(object_id,kind,ordinal),
 FOREIGN KEY(object_id,project_id) REFERENCES run_digests(object_id,project_id));
CREATE INDEX run_digest_signals_lookup ON run_digest_signals(project_id,object_id,kind,ordinal,value);
CREATE TABLE run_digest_index_sources(
 project_id TEXT NOT NULL,execution_log_id INTEGER NOT NULL,object_id TEXT NOT NULL REFERENCES run_digests(object_id),
 PRIMARY KEY(project_id,execution_log_id),
 FOREIGN KEY(project_id,execution_log_id) REFERENCES project_run_indexes(project_id,execution_log_id));
CREATE TABLE project_journal_sources(
 project_id TEXT NOT NULL,execution_log_id INTEGER NOT NULL,object_id TEXT NOT NULL UNIQUE REFERENCES evidence(id),
 PRIMARY KEY(project_id,execution_log_id),
 FOREIGN KEY(project_id,execution_log_id) REFERENCES project_journal_entries(project_id,execution_log_id));
CREATE TABLE notification_deliveries(
 id TEXT PRIMARY KEY,intent_id TEXT NOT NULL UNIQUE,channel TEXT NOT NULL CHECK(channel='telegram'),
 object_id TEXT NOT NULL UNIQUE REFERENCES evidence(id),original_hash TEXT NOT NULL,message_hash TEXT NOT NULL,
 payload_content_id TEXT NOT NULL REFERENCES contents(id),response_content_id TEXT REFERENCES contents(id),
 state TEXT NOT NULL CHECK(state IN ('queued','delivered','cancelled','failed')),
 revision INTEGER NOT NULL DEFAULT 1,error TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX notification_deliveries_pending ON notification_deliveries(channel,state,created_at,id);
CREATE TABLE automation_deliveries(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),intent_id TEXT NOT NULL,
 object_id TEXT NOT NULL UNIQUE REFERENCES evidence(id),kind TEXT NOT NULL CHECK(kind IN ('notification','sound')),event_trigger TEXT NOT NULL DEFAULT '',event_action TEXT NOT NULL DEFAULT '',
 payload_content_id TEXT NOT NULL REFERENCES contents(id),state TEXT NOT NULL CHECK(state IN ('queued','claimed','delivered','cancelled')),
 revision INTEGER NOT NULL DEFAULT 1,owner_id TEXT,owner_pid INTEGER,owner_birth TEXT,claim_token TEXT,claimed_at INTEGER,
 error TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 UNIQUE(project_id,intent_id));
CREATE INDEX automation_deliveries_pending ON automation_deliveries(state,created_at,id);
CREATE INDEX automation_deliveries_owner ON automation_deliveries(owner_pid,owner_birth,owner_id) WHERE state='claimed';
CREATE TABLE automation_ui_owners(
 pid INTEGER NOT NULL,birth TEXT NOT NULL,owner_id TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN (0,1)),
 PRIMARY KEY(pid,birth));
CREATE TABLE automation_delivery_receipts(
 delivery_id TEXT NOT NULL REFERENCES automation_deliveries(id),claim_token TEXT NOT NULL,state TEXT NOT NULL,
 content_id TEXT NOT NULL REFERENCES contents(id),PRIMARY KEY(delivery_id,claim_token,state));
CREATE TABLE run_control(
 run_id TEXT PRIMARY KEY REFERENCES runs(id),
 project_id TEXT NOT NULL REFERENCES projects(id),execution_log_id INTEGER NOT NULL CHECK(execution_log_id>0),
 node_key TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0),
 checkpoint_sequence INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint_sequence>=0),
 current_turn_id TEXT NOT NULL REFERENCES turns(id),metadata_content_id TEXT NOT NULL REFERENCES contents(id),
 binding_content_id TEXT REFERENCES contents(id),process_pid INTEGER,process_birth TEXT,child_pid INTEGER,child_birth TEXT,
 delivery_pending INTEGER NOT NULL DEFAULT 0 CHECK(delivery_pending IN (0,1)),delivery_owner_id TEXT,delivery_pid INTEGER,delivery_birth TEXT,
 recovery_needed INTEGER NOT NULL DEFAULT 0 CHECK(recovery_needed IN (0,1)),
 UNIQUE(project_id,execution_log_id),
 FOREIGN KEY(run_id,project_id) REFERENCES runs(id,project_id),
 FOREIGN KEY(current_turn_id,project_id) REFERENCES turns(id,project_id));
CREATE INDEX run_control_project ON run_control(project_id,execution_log_id DESC);
CREATE INDEX run_control_recovery ON run_control(recovery_needed);
CREATE TABLE run_control_revisions(
 run_id TEXT NOT NULL REFERENCES runs(id),revision INTEGER NOT NULL,
 generation INTEGER NOT NULL,checkpoint_sequence INTEGER NOT NULL,current_turn_id TEXT NOT NULL REFERENCES turns(id),
 metadata_content_id TEXT NOT NULL REFERENCES contents(id),binding_content_id TEXT REFERENCES contents(id),process_pid INTEGER,process_birth TEXT,child_pid INTEGER,child_birth TEXT,recovery_needed INTEGER NOT NULL,
 delivery_pending INTEGER NOT NULL,delivery_owner_id TEXT,delivery_pid INTEGER,delivery_birth TEXT,
 PRIMARY KEY(run_id,revision),FOREIGN KEY(run_id,revision) REFERENCES object_revisions(object_id,revision) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE run_documents(
 run_id TEXT NOT NULL REFERENCES runs(id),purpose TEXT NOT NULL,object_id TEXT NOT NULL UNIQUE REFERENCES evidence(id),
 PRIMARY KEY(run_id,purpose));
CREATE TABLE run_turn_journals(
 project_id TEXT NOT NULL REFERENCES projects(id),run_id TEXT NOT NULL REFERENCES runs(id),
 turn_id TEXT NOT NULL REFERENCES turns(id),execution_log_id INTEGER NOT NULL,
 PRIMARY KEY(project_id,turn_id),UNIQUE(project_id,execution_log_id),
 FOREIGN KEY(run_id,project_id) REFERENCES runs(id,project_id),
 FOREIGN KEY(turn_id,project_id) REFERENCES turns(id,project_id),
 FOREIGN KEY(project_id,execution_log_id) REFERENCES project_journal_entries(project_id,execution_log_id));
CREATE TABLE run_consumer_leases(
 run_id TEXT PRIMARY KEY REFERENCES runs(id),owner_id TEXT NOT NULL,pid INTEGER NOT NULL,birth TEXT NOT NULL,
 token TEXT NOT NULL,generation INTEGER NOT NULL,source_revision INTEGER NOT NULL,
 turn_id TEXT NOT NULL REFERENCES turns(id),checkpoint_sequence INTEGER NOT NULL,head_revision INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('claimed','released','committed')));
CREATE TABLE run_consumer_sources(
 run_id TEXT NOT NULL REFERENCES runs(id),project_id TEXT NOT NULL REFERENCES projects(id),
 turn_id TEXT NOT NULL REFERENCES turns(id),checkpoint_sequence INTEGER NOT NULL,source_revision INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','committed')),
 PRIMARY KEY(run_id,source_revision),UNIQUE(run_id,turn_id,checkpoint_sequence),
 FOREIGN KEY(run_id,source_revision) REFERENCES object_revisions(object_id,revision) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(run_id,project_id) REFERENCES runs(id,project_id),FOREIGN KEY(turn_id,project_id) REFERENCES turns(id,project_id));
CREATE INDEX run_consumer_sources_pending ON run_consumer_sources(state,project_id);
CREATE TABLE run_settlements(
 run_id TEXT NOT NULL REFERENCES runs(id),turn_id TEXT NOT NULL REFERENCES turns(id),checkpoint_sequence INTEGER NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id),execution_log_id INTEGER NOT NULL,source_revision INTEGER NOT NULL,
 payload_content_id TEXT NOT NULL REFERENCES contents(id),digest_content_id TEXT NOT NULL REFERENCES contents(id),
 handoff_content_id TEXT REFERENCES contents(id),learning_event_id TEXT REFERENCES learning_events(id),committed_at INTEGER NOT NULL,
 PRIMARY KEY(run_id,turn_id,checkpoint_sequence),
 FOREIGN KEY(run_id,project_id) REFERENCES runs(id,project_id),
 FOREIGN KEY(turn_id,project_id) REFERENCES turns(id,project_id));
CREATE INDEX run_settlements_project ON run_settlements(project_id,committed_at DESC,run_id,turn_id,checkpoint_sequence);
CREATE TABLE project_step_memory(
 project_id TEXT NOT NULL REFERENCES projects(id),node_key TEXT NOT NULL,content_id TEXT NOT NULL REFERENCES contents(id),revision INTEGER NOT NULL,
 PRIMARY KEY(project_id,node_key));
CREATE TABLE project_step_memory_state(
 project_id TEXT PRIMARY KEY REFERENCES projects(id),revision INTEGER NOT NULL CHECK(revision>0));
CREATE TABLE project_step_memory_revisions(
 project_id TEXT NOT NULL REFERENCES projects(id),node_key TEXT NOT NULL,revision INTEGER NOT NULL,
 content_id TEXT NOT NULL REFERENCES contents(id),handoff_cursor INTEGER NOT NULL,
 object_id TEXT NOT NULL REFERENCES evidence(id),metadata_object_id TEXT NOT NULL REFERENCES evidence(id),
 source_refs_content_id TEXT NOT NULL REFERENCES contents(id),
 PRIMARY KEY(project_id,node_key,revision));
CREATE TABLE step_memory_sources(
 project_id TEXT NOT NULL REFERENCES projects(id),node_key TEXT NOT NULL,source_key TEXT NOT NULL,
 object_id TEXT NOT NULL REFERENCES evidence(id),source_hash TEXT NOT NULL,entry_count INTEGER NOT NULL CHECK(entry_count>=0),
 format TEXT NOT NULL CHECK(format IN ('json','md')),PRIMARY KEY(project_id,node_key,source_key),
 FOREIGN KEY(object_id,project_id) REFERENCES evidence(id,project_id));
CREATE TABLE step_memory_field_origins(
 project_id TEXT NOT NULL REFERENCES projects(id),node_key TEXT NOT NULL,field TEXT NOT NULL,
 origin TEXT NOT NULL CHECK(origin IN ('default','user','import')),source_key TEXT,source_hash TEXT,
 PRIMARY KEY(project_id,node_key,field));
CREATE TABLE step_handoffs(
 project_id TEXT NOT NULL REFERENCES projects(id),node_key TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES runs(id),
 turn_id TEXT NOT NULL REFERENCES turns(id),checkpoint_sequence INTEGER NOT NULL,content_id TEXT NOT NULL REFERENCES contents(id),
 PRIMARY KEY(project_id,run_id,turn_id),FOREIGN KEY(run_id,project_id) REFERENCES runs(id,project_id),
 FOREIGN KEY(turn_id,project_id) REFERENCES turns(id,project_id));
CREATE INDEX step_handoffs_node ON step_handoffs(project_id,node_key);
CREATE TABLE run_effects(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),run_id TEXT NOT NULL REFERENCES runs(id),
 turn_id TEXT NOT NULL REFERENCES turns(id),checkpoint_sequence INTEGER NOT NULL,execution_log_id INTEGER NOT NULL,source_revision INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('roadmap','review','revision','refresh','telegram','automation','flow')),
 payload_content_id TEXT NOT NULL REFERENCES contents(id),state TEXT NOT NULL CHECK(state IN ('queued','claimed','done')),
 owner_id TEXT NOT NULL DEFAULT '',pid INTEGER NOT NULL DEFAULT 0,birth TEXT NOT NULL DEFAULT '',token TEXT NOT NULL DEFAULT '',
 error TEXT NOT NULL DEFAULT '',completed_at INTEGER,
 UNIQUE(run_id,turn_id,checkpoint_sequence,kind),
 FOREIGN KEY(run_id,project_id) REFERENCES runs(id,project_id),FOREIGN KEY(turn_id,project_id) REFERENCES turns(id,project_id),
 FOREIGN KEY(run_id,turn_id,checkpoint_sequence) REFERENCES run_settlements(run_id,turn_id,checkpoint_sequence));
CREATE INDEX run_effects_pending ON run_effects(state,project_id);
CREATE INDEX run_delivery_pending ON run_control(delivery_pending,project_id);
CREATE TABLE run_launch_intents(
 project_id TEXT NOT NULL REFERENCES projects(id),launch_intent_id TEXT NOT NULL,run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
 PRIMARY KEY(project_id,launch_intent_id),FOREIGN KEY(run_id,project_id) REFERENCES runs(id,project_id));
CREATE TABLE run_input_materializations(
 run_id TEXT NOT NULL REFERENCES runs(id),project_id TEXT NOT NULL REFERENCES projects(id),generation INTEGER NOT NULL,
 path TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL,size INTEGER NOT NULL,evidence_id TEXT NOT NULL REFERENCES evidence(id),
 input_content_id TEXT NOT NULL REFERENCES contents(id),written INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL CHECK(state IN ('active','released')),PRIMARY KEY(run_id,generation),
 FOREIGN KEY(run_id,project_id) REFERENCES runs(id,project_id));
CREATE INDEX run_input_materializations_active ON run_input_materializations(state,run_id,generation);
CREATE TABLE flow_control(
 project_id TEXT NOT NULL REFERENCES projects(id),flow_id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id),
 object_id TEXT NOT NULL UNIQUE REFERENCES evidence(id),PRIMARY KEY(project_id,flow_id),
 FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id));
CREATE TABLE flow_loop_details(
 project_id TEXT NOT NULL,flow_id TEXT NOT NULL,loop_id TEXT NOT NULL,loop_object_id TEXT NOT NULL UNIQUE REFERENCES workflow_loops(id),
 evidence_object_id TEXT NOT NULL UNIQUE REFERENCES evidence(id),PRIMARY KEY(project_id,flow_id,loop_id),
 FOREIGN KEY(project_id,flow_id) REFERENCES flow_control(project_id,flow_id),
 FOREIGN KEY(loop_object_id,project_id) REFERENCES workflow_loops(id,project_id),FOREIGN KEY(evidence_object_id,project_id) REFERENCES evidence(id,project_id));
CREATE TABLE flow_role_runs(
 project_id TEXT NOT NULL,flow_id TEXT NOT NULL,loop_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('planner','builder','verifier')),
 attempt INTEGER NOT NULL CHECK(attempt>=0),run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
 PRIMARY KEY(project_id,flow_id,loop_id,role,attempt),FOREIGN KEY(project_id,flow_id,loop_id) REFERENCES flow_loop_details(project_id,flow_id,loop_id),
 FOREIGN KEY(run_id,project_id) REFERENCES runs(id,project_id));
CREATE TABLE flow_revisions(
 object_id TEXT NOT NULL REFERENCES evidence(id),revision INTEGER NOT NULL,loop_versions_content_id TEXT NOT NULL REFERENCES contents(id),
 PRIMARY KEY(object_id,revision),FOREIGN KEY(object_id,revision) REFERENCES object_revisions(object_id,revision) DEFERRABLE INITIALLY DEFERRED);
` }, { version: 13, sql: `
CREATE TABLE run_index_import_sources(
 project_id TEXT NOT NULL,execution_log_id INTEGER NOT NULL,source_identity TEXT NOT NULL,
 source_key TEXT NOT NULL,source_hash TEXT NOT NULL,index_hash TEXT NOT NULL,
 priority INTEGER NOT NULL CHECK(priority IN (0,10,20)),
 PRIMARY KEY(project_id,execution_log_id),
 FOREIGN KEY(project_id,execution_log_id) REFERENCES project_run_indexes(project_id,execution_log_id));
` }, { version: 14, sql: `
ALTER TABLE migration_recycling ADD COLUMN authorized_path TEXT;
ALTER TABLE migration_recycling ADD COLUMN restore_path TEXT;
` }, { version: 15, sql: `
CREATE TABLE recycling_restore_stages(
 item_id TEXT PRIMARY KEY REFERENCES migration_recycling(id),directory TEXT NOT NULL UNIQUE,
 device TEXT NOT NULL,inode TEXT NOT NULL);
` }, { version: 16, sql: `
CREATE TABLE recycling_restore_intents(
 id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES migration_recycling(id),directory TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK(status IN ('planned','owned','ownership_unknown','cleaned')),
 device TEXT,inode TEXT,created_at INTEGER NOT NULL,
 CHECK((device IS NULL)=(inode IS NULL)));
CREATE INDEX recycling_restore_intents_item ON recycling_restore_intents(item_id,status,created_at);
CREATE INDEX recycling_restore_intents_conflicts ON recycling_restore_intents(created_at,id) WHERE status='ownership_unknown';
` }, { version: 17, sql: `
CREATE TABLE report_versions(
 ordinal INTEGER PRIMARY KEY AUTOINCREMENT,object_id TEXT NOT NULL REFERENCES reports(id),revision INTEGER NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id),task_id TEXT NOT NULL REFERENCES tasks(id),turn_id TEXT NOT NULL REFERENCES turns(id),
 run_id TEXT REFERENCES runs(id),content_id TEXT NOT NULL REFERENCES contents(id),sha256 TEXT NOT NULL,
 metadata_json TEXT NOT NULL,recorded_at INTEGER NOT NULL,
 UNIQUE(object_id,revision),FOREIGN KEY(object_id,revision) REFERENCES object_revisions(object_id,revision),
 FOREIGN KEY(object_id,project_id) REFERENCES reports(id,project_id),
 FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id),FOREIGN KEY(turn_id,project_id) REFERENCES turns(id,project_id));
CREATE INDEX report_versions_project_task ON report_versions(project_id,task_id,turn_id,ordinal);
CREATE INDEX events_subject_content ON events(subject_id,content_id);
` }, { version: 18, sql: `
CREATE TABLE turns_historical(id TEXT PRIMARY KEY,object_kind TEXT NOT NULL DEFAULT 'turn' CHECK(object_kind='turn'),project_id TEXT NOT NULL,
 ${entityDefinitions.turn.columns.replace('request_content_id TEXT NOT NULL', 'request_content_id TEXT').replace('started_at INTEGER NOT NULL', 'started_at INTEGER')},
 UNIQUE(id,project_id),FOREIGN KEY(id,object_kind) REFERENCES objects(id,kind),FOREIGN KEY(id,project_id) REFERENCES objects(id,project_id),
 FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id),UNIQUE(task_id,sequence));
INSERT INTO turns_historical SELECT * FROM turns;
DROP TRIGGER messages_turn_id_scope_insert;
DROP TRIGGER messages_turn_id_scope_update;
DROP TABLE turns;
ALTER TABLE turns_historical RENAME TO turns;
CREATE TRIGGER messages_turn_id_scope_insert BEFORE INSERT ON messages WHEN EXISTS(SELECT 1 FROM turns WHERE id=NEW.turn_id AND project_id IS NOT NEW.project_id) BEGIN SELECT RAISE(ABORT,'scope_mismatch'); END;
CREATE TRIGGER messages_turn_id_scope_update BEFORE UPDATE OF turn_id ON messages WHEN EXISTS(SELECT 1 FROM turns WHERE id=NEW.turn_id AND project_id IS NOT NEW.project_id) BEGIN SELECT RAISE(ABORT,'scope_mismatch'); END;
CREATE TRIGGER turns_scope_insert BEFORE INSERT ON turns WHEN NOT EXISTS(SELECT 1 FROM objects WHERE id=NEW.id AND project_id IS NEW.project_id) BEGIN SELECT RAISE(ABORT,'scope_mismatch'); END;
CREATE TRIGGER turns_scope_update BEFORE UPDATE OF project_id ON turns WHEN NEW.project_id IS NOT OLD.project_id BEGIN SELECT RAISE(ABORT,'immutable_scope'); END;
CREATE INDEX turns_scope ON turns(project_id);
CREATE TABLE legacy_report_tasks(
 project_id TEXT NOT NULL REFERENCES projects(id),legacy_task_id TEXT NOT NULL,task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
 source_identity TEXT NOT NULL,source_key TEXT NOT NULL,started_at TEXT NOT NULL,title_preview TEXT NOT NULL,executions_json TEXT NOT NULL,
 PRIMARY KEY(project_id,legacy_task_id),UNIQUE(source_identity,source_key),FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id));
CREATE TABLE legacy_report_turns(
 project_id TEXT NOT NULL REFERENCES projects(id),task_id TEXT NOT NULL REFERENCES tasks(id),execution_log_id INTEGER NOT NULL,
 legacy_sequence INTEGER NOT NULL,turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id),
 PRIMARY KEY(project_id,task_id,execution_log_id,legacy_sequence),FOREIGN KEY(turn_id,project_id) REFERENCES turns(id,project_id));
CREATE TABLE report_version_sources(
 object_id TEXT NOT NULL,revision INTEGER NOT NULL,source_identity TEXT NOT NULL,source_key TEXT NOT NULL,source_hash TEXT NOT NULL,
 source_content_id TEXT NOT NULL REFERENCES contents(id),source_capture_revision INTEGER NOT NULL,source_created_at TEXT NOT NULL,
 PRIMARY KEY(object_id,revision),FOREIGN KEY(object_id,revision) REFERENCES report_versions(object_id,revision));
CREATE TABLE report_source_generations(project_id TEXT PRIMARY KEY REFERENCES projects(id),revision INTEGER NOT NULL);
` }, { version: 19, sql: `
ALTER TABLE growth_report_projection ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
` }, { version: 20, sql: `
CREATE TABLE learning_review_controls(
 batch_id TEXT PRIMARY KEY REFERENCES review_batches(id),request_project_id TEXT NOT NULL REFERENCES projects(id),
 run_key TEXT NOT NULL UNIQUE,input_content_id TEXT NOT NULL REFERENCES contents(id),run_id TEXT UNIQUE REFERENCES runs(id));
` }, { version: 21, sql: `
CREATE TABLE legacy_learning_review_controls(
 batch_id TEXT PRIMARY KEY REFERENCES review_batches(id),input_content_id TEXT NOT NULL REFERENCES contents(id),
 source_identity TEXT NOT NULL,source_key TEXT NOT NULL,UNIQUE(source_identity,source_key));
` }, { version: 22, sql: `
CREATE TABLE legacy_learning_review_cursor_inputs(
 source_identity TEXT NOT NULL,cursor_hash TEXT NOT NULL,run_key TEXT NOT NULL,
 cursor_id TEXT NOT NULL REFERENCES settings(id),cursor_revision INTEGER NOT NULL,
 input_content_id TEXT NOT NULL REFERENCES contents(id),PRIMARY KEY(source_identity,cursor_hash),
 FOREIGN KEY(cursor_id,cursor_revision) REFERENCES object_revisions(object_id,revision));
` }, { version: 23, sql: `
CREATE INDEX requests_migration_capture_key ON requests(idempotency_key)
 WHERE idempotency_key>='migration-capture:' AND idempotency_key<'migration-capture;';
CREATE TABLE migration_source_json_versions(
 source_identity TEXT NOT NULL,source_key TEXT NOT NULL,capture_revision INTEGER NOT NULL,
 content_id TEXT NOT NULL REFERENCES contents(id),transport_hash TEXT NOT NULL,json_hash TEXT,
 request_id TEXT NOT NULL REFERENCES requests(id),PRIMARY KEY(source_identity,source_key,capture_revision));
CREATE INDEX migration_source_json_hash ON migration_source_json_versions(source_identity,source_key,json_hash,capture_revision);
CREATE TABLE migration_source_json_heads(
 source_identity TEXT NOT NULL,source_key TEXT NOT NULL,through_revision INTEGER NOT NULL,
 PRIMARY KEY(source_identity,source_key));
` }, { version: 24, sql: `
ALTER TABLE projects ADD COLUMN notes_content_id TEXT REFERENCES contents(id);
` }, { version: 25, sql: `
CREATE TABLE capability_registry(
 kind TEXT NOT NULL CHECK(kind IN ('skill','mcp','enhancement')),legacy_id TEXT NOT NULL,
 integration_id TEXT NOT NULL UNIQUE REFERENCES integrations(id),
 PRIMARY KEY(kind,legacy_id));
CREATE INDEX capability_registry_kind ON capability_registry(kind,integration_id);
` }, { version: 26, sql: `
CREATE TABLE project_journal_links(
 project_id TEXT NOT NULL,execution_log_id INTEGER NOT NULL,node_id TEXT NOT NULL,linked_at TEXT NOT NULL,
 PRIMARY KEY(project_id,execution_log_id,node_id),
 FOREIGN KEY(project_id,execution_log_id) REFERENCES project_journal_entries(project_id,execution_log_id));
CREATE INDEX project_journal_links_node ON project_journal_links(project_id,node_id,execution_log_id DESC);
` }, { version: 27, sql: `
CREATE TABLE schedule_bindings(
 external_id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL UNIQUE REFERENCES schedules(id));
CREATE TABLE scheduled_occurrences(
 id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL REFERENCES schedules(id),occurrence_key TEXT NOT NULL,
 due_at INTEGER NOT NULL,payload_content_id TEXT NOT NULL REFERENCES contents(id),
 status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 0,
 owner_id TEXT,owner_pid INTEGER,owner_birth TEXT,claim_token TEXT,lease_expires_at INTEGER,error TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(schedule_id,occurrence_key));
CREATE INDEX scheduled_occurrences_due ON scheduled_occurrences(status,due_at,id);
ALTER TABLE inbox ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inbox ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE inbox ADD COLUMN owner_id TEXT;
ALTER TABLE inbox ADD COLUMN owner_pid INTEGER;
ALTER TABLE inbox ADD COLUMN owner_birth TEXT;
ALTER TABLE inbox ADD COLUMN claim_token TEXT;
ALTER TABLE inbox ADD COLUMN claimed_at INTEGER;
` }, { version: 28, sql: `
CREATE TABLE runtime_instance_bindings(
 runtime_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL UNIQUE REFERENCES runtime_instances(id));
` }, { version: 29, sql: `
CREATE TABLE notification_delivery_attempts(
 delivery_id TEXT NOT NULL REFERENCES notification_deliveries(id),attempt_token TEXT NOT NULL UNIQUE,
 delivery_revision INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('started','retryable','confirmed')),
 response_content_id TEXT REFERENCES contents(id),error TEXT NOT NULL DEFAULT '',started_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 PRIMARY KEY(delivery_id,delivery_revision));
` }, { version: 30, sql: `
CREATE TABLE inbox_action_attempts(
 channel TEXT NOT NULL,source_id TEXT NOT NULL,action TEXT NOT NULL,claim_token TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state='started'),started_at INTEGER NOT NULL,
 PRIMARY KEY(channel,source_id,action),
 FOREIGN KEY(channel,source_id) REFERENCES inbox(channel,source_id));
` }, { version: 31, sql: `
CREATE TABLE inbox_action_outcomes(
 channel TEXT NOT NULL,source_id TEXT NOT NULL,action TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('confirmed','unknown')),updated_at INTEGER NOT NULL,
 PRIMARY KEY(channel,source_id,action),
 FOREIGN KEY(channel,source_id,action) REFERENCES inbox_action_attempts(channel,source_id,action));
` }, { version: 32, sql: `
CREATE TABLE diagnostic_events(
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL CHECK(kind IN ('error','operation')),
 occurred_at TEXT NOT NULL,scope TEXT NOT NULL,payload_json TEXT NOT NULL);
CREATE INDEX diagnostic_events_recent ON diagnostic_events(kind,sequence DESC);
` }, { version: 33, sql: `
CREATE TABLE native_projection_receipts(
 projection_id TEXT PRIMARY KEY,setting_key TEXT NOT NULL,value_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX native_projection_receipts_lookup ON native_projection_receipts(setting_key,value_hash,created_at DESC);
` }, { version: 34, sql: `
CREATE TABLE native_projection_consumptions(
 projection_id TEXT NOT NULL REFERENCES native_projection_receipts(projection_id),host_id TEXT NOT NULL,consumed_at INTEGER NOT NULL,
 PRIMARY KEY(projection_id,host_id));
` }, { version: 35, sql: `
ALTER TABLE runtime_instances ADD COLUMN process_birth TEXT NOT NULL DEFAULT '';
` }, { version: 36, sql: `
CREATE TABLE capability_operations(
 ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL CHECK(kind IN ('skill','mcp','enhancement')),
 action TEXT NOT NULL CHECK(action IN ('install','upgrade','enable','disable','uninstall')),
 target_id TEXT,request_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','stale')),
 result_path TEXT,run_id TEXT,expected_revision INTEGER NOT NULL DEFAULT 0,
 result_integration_id TEXT REFERENCES integrations(id),result_revision INTEGER,
 error TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX capability_operations_active ON capability_operations(status,ordinal);
CREATE INDEX capability_operations_target ON capability_operations(kind,target_id,ordinal DESC);
CREATE TABLE capability_operation_heads(
 kind TEXT NOT NULL CHECK(kind IN ('skill','mcp','enhancement')),target_id TEXT NOT NULL,
 operation_id TEXT NOT NULL UNIQUE REFERENCES capability_operations(id),operation_ordinal INTEGER NOT NULL,
 PRIMARY KEY(kind,target_id));
CREATE TABLE capability_evidence_versions(
 integration_id TEXT NOT NULL REFERENCES integrations(id),integration_revision INTEGER NOT NULL,
 purpose TEXT NOT NULL,evidence_id TEXT NOT NULL REFERENCES evidence(id),
 PRIMARY KEY(integration_id,integration_revision,purpose));
CREATE INDEX capability_evidence_purpose ON capability_evidence_versions(integration_id,purpose,integration_revision DESC);
` }, { version: 37, sql: `
CREATE TABLE capability_physical_operation_heads(
 kind TEXT NOT NULL CHECK(kind IN ('skill','mcp','enhancement')),target_id TEXT NOT NULL,
 operation_id TEXT NOT NULL UNIQUE REFERENCES capability_operations(id),operation_ordinal INTEGER NOT NULL,
 PRIMARY KEY(kind,target_id));
INSERT INTO capability_physical_operation_heads(kind,target_id,operation_id,operation_ordinal)
 SELECT kind,target_id,operation_id,operation_ordinal FROM capability_operation_heads;
` }, { version: 38, sql: `
ALTER TABLE capability_operations ADD COLUMN source_intent_json TEXT NOT NULL DEFAULT '{}';
` }, { version: 39, sql: `
CREATE TABLE roadmap_file_states(
 project_id TEXT PRIMARY KEY REFERENCES projects(id),binding_id TEXT NOT NULL UNIQUE REFERENCES file_bindings(id),
 accepted_content_id TEXT NOT NULL REFERENCES contents(id),accepted_hash TEXT NOT NULL,
 generation INTEGER NOT NULL DEFAULT 1,projected_generation INTEGER NOT NULL DEFAULT 1,
 pending_content_id TEXT REFERENCES contents(id),pending_hash TEXT,last_error TEXT NOT NULL DEFAULT '',
 CHECK((pending_content_id IS NULL)=(pending_hash IS NULL)));
CREATE TABLE roadmap_node_fields(
 node_id TEXT PRIMARY KEY REFERENCES roadmap_nodes(id),dependencies_text TEXT NOT NULL DEFAULT '',
 created_at_text TEXT NOT NULL DEFAULT '',completed_at_text TEXT NOT NULL DEFAULT '');
` }, { version: 40, sql: `
ALTER TABLE project_run_artifacts ADD COLUMN artifact_kind TEXT NOT NULL DEFAULT 'unclassified';
ALTER TABLE migration_items ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'unclassified';
CREATE INDEX project_run_artifacts_kind ON project_run_artifacts(artifact_kind,project_id,execution_log_id);
CREATE INDEX project_run_artifacts_content ON project_run_artifacts(content_id);
CREATE INDEX migration_items_source_kind ON migration_items(source_kind,source_identity,source_key);
CREATE INDEX migration_items_content ON migration_items(source_content_id);
CREATE TABLE database_storage_maintenance(
 id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,finished_at INTEGER,status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),error TEXT NOT NULL,
 deleted_artifacts INTEGER NOT NULL,deleted_sources INTEGER NOT NULL,deleted_contents INTEGER NOT NULL,
 reclaimed_stored_bytes INTEGER NOT NULL,compacted INTEGER NOT NULL CHECK(compacted IN (0,1)),
 before_bytes INTEGER NOT NULL,after_bytes INTEGER NOT NULL,integrity TEXT NOT NULL);
CREATE TABLE database_storage_cleanup_candidates(
 content_id TEXT PRIMARY KEY,stored_byte_length INTEGER NOT NULL);
` }, { version: 41, sql: `
CREATE INDEX content_ref_object_revisions_content_id ON object_revisions(content_id);
CREATE INDEX content_ref_session_bindings_provider_context_content_id ON session_bindings(provider_context_content_id);
CREATE INDEX content_ref_log_chunks_content_id ON log_chunks(content_id);
CREATE INDEX content_ref_run_changes_after_content_id ON run_changes(after_content_id);
CREATE INDEX content_ref_run_changes_before_content_id ON run_changes(before_content_id);
CREATE INDEX content_ref_run_summaries_handoff_content_id ON run_summaries(handoff_content_id);
CREATE INDEX content_ref_run_summaries_summary_content_id ON run_summaries(summary_content_id);
CREATE INDEX content_ref_events_content_id ON events(content_id);
CREATE INDEX content_ref_requests_result_content_id ON requests(result_content_id);
CREATE INDEX content_ref_outbox_content_id ON outbox(content_id);
CREATE INDEX content_ref_inbox_content_id ON inbox(content_id);
CREATE INDEX content_ref_projections_content_id ON projections(content_id);
CREATE INDEX content_ref_projects_notes_content_id ON projects(notes_content_id);
CREATE INDEX content_ref_roadmap_nodes_agent_prompt_content_id ON roadmap_nodes(agent_prompt_content_id);
CREATE INDEX content_ref_assets_content_id ON assets(content_id);
CREATE INDEX content_ref_integrations_health_content_id ON integrations(health_content_id);
CREATE INDEX content_ref_integrations_config_content_id ON integrations(config_content_id);
CREATE INDEX content_ref_tasks_criteria_content_id ON tasks(criteria_content_id);
CREATE INDEX content_ref_tasks_original_request_content_id ON tasks(original_request_content_id);
CREATE INDEX content_ref_runs_prompt_content_id ON runs(prompt_content_id);
CREATE INDEX content_ref_runs_command_content_id ON runs(command_content_id);
CREATE INDEX content_ref_reports_content_id ON reports(content_id);
CREATE INDEX content_ref_workflow_loops_scoring_content_id ON workflow_loops(scoring_content_id);
CREATE INDEX content_ref_memories_content_id ON memories(content_id);
CREATE INDEX content_ref_review_batches_review_content_id ON review_batches(review_content_id);
CREATE INDEX content_ref_review_batches_proposal_content_id ON review_batches(proposal_content_id);
CREATE INDEX content_ref_applications_after_content_id ON applications(after_content_id);
CREATE INDEX content_ref_applications_before_content_id ON applications(before_content_id);
CREATE INDEX content_ref_policies_content_id ON policies(content_id);
CREATE INDEX content_ref_settings_content_id ON settings(content_id);
CREATE INDEX content_ref_schedules_task_template_content_id ON schedules(task_template_content_id);
CREATE INDEX content_ref_messages_content_id ON messages(content_id);
CREATE INDEX content_ref_migration_recycling_source_content_id ON migration_recycling(source_content_id);
CREATE INDEX content_ref_evidence_content_id ON evidence(content_id);
CREATE INDEX content_ref_run_digests_content_id ON run_digests(content_id);
CREATE INDEX content_ref_notification_deliveries_response_content_id ON notification_deliveries(response_content_id);
CREATE INDEX content_ref_notification_deliveries_payload_content_id ON notification_deliveries(payload_content_id);
CREATE INDEX content_ref_automation_deliveries_payload_content_id ON automation_deliveries(payload_content_id);
CREATE INDEX content_ref_automation_delivery_receipts_content_id ON automation_delivery_receipts(content_id);
CREATE INDEX content_ref_run_control_binding_content_id ON run_control(binding_content_id);
CREATE INDEX content_ref_run_control_metadata_content_id ON run_control(metadata_content_id);
CREATE INDEX content_ref_run_control_revisions_binding_content_id ON run_control_revisions(binding_content_id);
CREATE INDEX content_ref_run_control_revisions_metadata_content_id ON run_control_revisions(metadata_content_id);
CREATE INDEX content_ref_run_settlements_handoff_content_id ON run_settlements(handoff_content_id);
CREATE INDEX content_ref_run_settlements_digest_content_id ON run_settlements(digest_content_id);
CREATE INDEX content_ref_run_settlements_payload_content_id ON run_settlements(payload_content_id);
CREATE INDEX content_ref_project_step_memory_content_id ON project_step_memory(content_id);
CREATE INDEX content_ref_project_step_memory_revisions_source_refs_content_id ON project_step_memory_revisions(source_refs_content_id);
CREATE INDEX content_ref_project_step_memory_revisions_content_id ON project_step_memory_revisions(content_id);
CREATE INDEX content_ref_step_handoffs_content_id ON step_handoffs(content_id);
CREATE INDEX content_ref_run_effects_payload_content_id ON run_effects(payload_content_id);
CREATE INDEX content_ref_run_input_materializations_input_content_id ON run_input_materializations(input_content_id);
CREATE INDEX content_ref_flow_revisions_loop_versions_content_id ON flow_revisions(loop_versions_content_id);
CREATE INDEX content_ref_report_versions_content_id ON report_versions(content_id);
CREATE INDEX content_ref_turns_summary_content_id ON turns(summary_content_id);
CREATE INDEX content_ref_turns_request_content_id ON turns(request_content_id);
CREATE INDEX content_ref_report_version_sources_source_content_id ON report_version_sources(source_content_id);
CREATE INDEX content_ref_learning_review_controls_input_content_id ON learning_review_controls(input_content_id);
CREATE INDEX content_ref_legacy_learning_review_controls_input_content_id ON legacy_learning_review_controls(input_content_id);
CREATE INDEX content_ref_legacy_learning_review_cursor_inputs_input_content_id ON legacy_learning_review_cursor_inputs(input_content_id);
CREATE INDEX content_ref_migration_source_json_versions_content_id ON migration_source_json_versions(content_id);
CREATE INDEX content_ref_scheduled_occurrences_payload_content_id ON scheduled_occurrences(payload_content_id);
CREATE INDEX content_ref_notification_delivery_attempts_response_content_id ON notification_delivery_attempts(response_content_id);
CREATE INDEX content_ref_roadmap_file_states_pending_content_id ON roadmap_file_states(pending_content_id);
CREATE INDEX content_ref_roadmap_file_states_accepted_content_id ON roadmap_file_states(accepted_content_id);
` }, { version: 42, sql: `
CREATE INDEX events_request ON events(request_id);
` }, { version: 43, sql: `
CREATE INDEX migration_items_stage_source ON migration_items(stage,source_identity,source_key);
CREATE INDEX migration_recycling_source_receipt ON migration_recycling(source_identity,source_key,source_hash,status);
` }, { version: 44, sql: `
CREATE TABLE project_analysis_sources(
 project_id TEXT PRIMARY KEY REFERENCES projects(id),revision INTEGER NOT NULL,
 run_count INTEGER NOT NULL,latest_run_at INTEGER NOT NULL,recent_activity_at INTEGER NOT NULL);
INSERT INTO project_analysis_sources(project_id,revision,run_count,latest_run_at,recent_activity_at)
SELECT p.id,COALESCE(g.revision,0),
 (SELECT COUNT(*) FROM project_run_indexes i WHERE i.project_id=p.id),
 ${latestRunTimestamp('p.id')},
 MAX(
  ${latestRunTimestamp('p.id')},
  ${latestJournalTimestamp('p.id')}
 )
FROM projects p LEFT JOIN report_source_generations g ON g.project_id=p.id;
CREATE INDEX settings_namespace_owner_key ON settings(namespace,owner_scope,key,id);
CREATE TRIGGER project_analysis_run_insert AFTER INSERT ON project_run_indexes BEGIN
 INSERT INTO project_analysis_sources(project_id,revision,run_count,latest_run_at,recent_activity_at)
 VALUES(NEW.project_id,1,1,${analysisRunTimestamp('NEW.record_json')},${analysisRunTimestamp('NEW.record_json')})
 ON CONFLICT(project_id) DO UPDATE SET revision=project_analysis_sources.revision+1,run_count=project_analysis_sources.run_count+1,
 latest_run_at=MAX(project_analysis_sources.latest_run_at,excluded.latest_run_at),recent_activity_at=MAX(project_analysis_sources.recent_activity_at,excluded.recent_activity_at);
END;
CREATE TRIGGER project_analysis_run_update AFTER UPDATE ON project_run_indexes BEGIN
 ${refreshRunAnalysisSource('NEW.project_id', analysisRunTimestamp('OLD.record_json'), analysisRunTimestamp('NEW.record_json'))}
END;
CREATE TRIGGER project_analysis_run_delete AFTER DELETE ON project_run_indexes BEGIN
 UPDATE project_analysis_sources SET revision=revision+1,run_count=MAX(0,run_count-1),
 latest_run_at=CASE WHEN ${analysisRunTimestamp('OLD.record_json')}=latest_run_at THEN ${latestRunTimestamp('OLD.project_id')} ELSE latest_run_at END,
 recent_activity_at=CASE WHEN ${analysisRunTimestamp('OLD.record_json')}=latest_run_at THEN MAX(${latestRunTimestamp('OLD.project_id')},${latestJournalTimestamp('OLD.project_id')}) ELSE recent_activity_at END
 WHERE project_id=OLD.project_id;
END;
CREATE TRIGGER project_analysis_journal_insert AFTER INSERT ON project_journal_entries BEGIN
 INSERT INTO project_analysis_sources(project_id,revision,run_count,latest_run_at,recent_activity_at)
 VALUES(NEW.project_id,1,0,0,${analysisTimestamp('NEW.timestamp')})
 ON CONFLICT(project_id) DO UPDATE SET revision=project_analysis_sources.revision+1,recent_activity_at=MAX(project_analysis_sources.recent_activity_at,excluded.recent_activity_at);
END;
CREATE TRIGGER project_analysis_journal_update AFTER UPDATE ON project_journal_entries BEGIN
 ${refreshJournalAnalysisSource('NEW.project_id', analysisTimestamp('OLD.timestamp'), analysisTimestamp('NEW.timestamp'))}
END;
CREATE TRIGGER project_analysis_journal_delete AFTER DELETE ON project_journal_entries BEGIN
 UPDATE project_analysis_sources SET revision=revision+1,
 recent_activity_at=CASE WHEN ${analysisTimestamp('OLD.timestamp')}=recent_activity_at THEN MAX(${latestRunTimestamp('OLD.project_id')},${latestJournalTimestamp('OLD.project_id')}) ELSE recent_activity_at END
 WHERE project_id=OLD.project_id;
END;
CREATE TRIGGER project_analysis_link_insert AFTER INSERT ON project_journal_links BEGIN ${touchProjectAnalysisSource('NEW.project_id')} END;
CREATE TRIGGER project_analysis_link_update AFTER UPDATE ON project_journal_links BEGIN ${touchProjectAnalysisSource('NEW.project_id')} END;
CREATE TRIGGER project_analysis_link_delete AFTER DELETE ON project_journal_links BEGIN ${touchProjectAnalysisSource('OLD.project_id')} END;
CREATE TRIGGER project_analysis_control_insert AFTER INSERT ON run_control BEGIN ${touchProjectAnalysisSource('NEW.project_id')} END;
CREATE TRIGGER project_analysis_control_update AFTER UPDATE ON run_control BEGIN ${touchProjectAnalysisSource('NEW.project_id')} END;
CREATE TRIGGER project_analysis_control_delete AFTER DELETE ON run_control BEGIN ${touchProjectAnalysisSource('OLD.project_id')} END;
` }, { version: 45, sql: `
CREATE TABLE growth_snapshot_cleanup_plans(
 plan_id TEXT PRIMARY KEY REFERENCES evidence(id),database_id TEXT NOT NULL,snapshot_upper_bound INTEGER NOT NULL,
 snapshot_count INTEGER NOT NULL,latest_snapshot_id TEXT,manifest_hash TEXT NOT NULL,
 manifest_content_id TEXT NOT NULL REFERENCES contents(id),
 status TEXT NOT NULL CHECK(status IN ('prepared','applying','applied','invalidated')),
 invalidation_reason TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,applied_at INTEGER);
CREATE TABLE growth_snapshot_cleanup_batches(
 plan_id TEXT NOT NULL REFERENCES growth_snapshot_cleanup_plans(plan_id),batch_index INTEGER NOT NULL,
 candidate_ids_content_id TEXT NOT NULL REFERENCES contents(id),receipt_content_id TEXT REFERENCES contents(id),
 status TEXT NOT NULL CHECK(status IN ('prepared','applied')),created_at INTEGER NOT NULL,applied_at INTEGER,
 PRIMARY KEY(plan_id,batch_index));
CREATE INDEX growth_snapshot_cleanup_plan_status ON growth_snapshot_cleanup_plans(status,created_at);
CREATE INDEX content_ref_growth_cleanup_plans_manifest ON growth_snapshot_cleanup_plans(manifest_content_id);
CREATE INDEX content_ref_growth_cleanup_batches_candidates ON growth_snapshot_cleanup_batches(candidate_ids_content_id);
CREATE INDEX content_ref_growth_cleanup_batches_receipt ON growth_snapshot_cleanup_batches(receipt_content_id);
` }, { version: 46, sql: `
CREATE TABLE growth_snapshot_semantic_index(
 snapshot_id TEXT PRIMARY KEY REFERENCES growth_snapshots(id) ON DELETE CASCADE,
 semantic_fingerprint TEXT NOT NULL,format_version INTEGER NOT NULL CHECK(format_version=1),indexed_at INTEGER NOT NULL);
CREATE INDEX growth_snapshot_semantic_fingerprint ON growth_snapshot_semantic_index(semantic_fingerprint,snapshot_id);
CREATE INDEX growth_signals_semantic_order ON growth_signals(snapshot_id,item_id,type,level,value,source,source_ref);
CREATE TRIGGER growth_snapshot_semantic_header_update AFTER UPDATE OF project_id,git_head,status,project_path,error ON growth_snapshots BEGIN
 DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id IN (OLD.id,NEW.id);
END;
CREATE TRIGGER growth_item_semantic_insert AFTER INSERT ON growth_items BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=NEW.snapshot_id; END;
CREATE TRIGGER growth_item_semantic_update AFTER UPDATE ON growth_items BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id IN (OLD.snapshot_id,NEW.snapshot_id); END;
CREATE TRIGGER growth_item_semantic_delete AFTER DELETE ON growth_items BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=OLD.snapshot_id; END;
CREATE TRIGGER growth_edge_semantic_insert AFTER INSERT ON growth_edges BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=NEW.snapshot_id; END;
CREATE TRIGGER growth_edge_semantic_update AFTER UPDATE ON growth_edges BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id IN (OLD.snapshot_id,NEW.snapshot_id); END;
CREATE TRIGGER growth_edge_semantic_delete AFTER DELETE ON growth_edges BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=OLD.snapshot_id; END;
CREATE TRIGGER growth_signal_semantic_insert AFTER INSERT ON growth_signals BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=NEW.snapshot_id; END;
CREATE TRIGGER growth_signal_semantic_update AFTER UPDATE ON growth_signals BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id IN (OLD.snapshot_id,NEW.snapshot_id); END;
CREATE TRIGGER growth_signal_semantic_delete AFTER DELETE ON growth_signals BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=OLD.snapshot_id; END;
CREATE TRIGGER growth_label_semantic_insert AFTER INSERT ON growth_module_labels BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=NEW.snapshot_id; END;
CREATE TRIGGER growth_label_semantic_update AFTER UPDATE ON growth_module_labels BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id IN (OLD.snapshot_id,NEW.snapshot_id); END;
CREATE TRIGGER growth_label_semantic_delete AFTER DELETE ON growth_module_labels BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=OLD.snapshot_id; END;
` }];
