export const contentLifecycleGcRoots: ReadonlyArray<{ table: string; column: string }> = [
  {
    "table": "object_revisions",
    "column": "content_id"
  },
  {
    "table": "migration_items",
    "column": "source_content_id"
  },
  {
    "table": "session_bindings",
    "column": "provider_context_content_id"
  },
  {
    "table": "log_chunks",
    "column": "content_id"
  },
  {
    "table": "run_changes",
    "column": "after_content_id"
  },
  {
    "table": "run_changes",
    "column": "before_content_id"
  },
  {
    "table": "run_summaries",
    "column": "handoff_content_id"
  },
  {
    "table": "run_summaries",
    "column": "summary_content_id"
  },
  {
    "table": "events",
    "column": "content_id"
  },
  {
    "table": "requests",
    "column": "result_content_id"
  },
  {
    "table": "outbox",
    "column": "content_id"
  },
  {
    "table": "inbox",
    "column": "content_id"
  },
  {
    "table": "projections",
    "column": "content_id"
  },
  {
    "table": "projects",
    "column": "notes_content_id"
  },
  {
    "table": "roadmap_nodes",
    "column": "agent_prompt_content_id"
  },
  {
    "table": "assets",
    "column": "content_id"
  },
  {
    "table": "integrations",
    "column": "health_content_id"
  },
  {
    "table": "integrations",
    "column": "config_content_id"
  },
  {
    "table": "tasks",
    "column": "criteria_content_id"
  },
  {
    "table": "tasks",
    "column": "original_request_content_id"
  },
  {
    "table": "runs",
    "column": "prompt_content_id"
  },
  {
    "table": "runs",
    "column": "command_content_id"
  },
  {
    "table": "reports",
    "column": "content_id"
  },
  {
    "table": "workflow_loops",
    "column": "scoring_content_id"
  },
  {
    "table": "memories",
    "column": "content_id"
  },
  {
    "table": "review_batches",
    "column": "review_content_id"
  },
  {
    "table": "review_batches",
    "column": "proposal_content_id"
  },
  {
    "table": "applications",
    "column": "after_content_id"
  },
  {
    "table": "applications",
    "column": "before_content_id"
  },
  {
    "table": "policies",
    "column": "content_id"
  },
  {
    "table": "settings",
    "column": "content_id"
  },
  {
    "table": "schedules",
    "column": "task_template_content_id"
  },
  {
    "table": "messages",
    "column": "content_id"
  },
  {
    "table": "migration_recycling",
    "column": "source_content_id"
  },
  {
    "table": "project_run_artifacts",
    "column": "content_id"
  },
  {
    "table": "evidence",
    "column": "content_id"
  },
  {
    "table": "run_digests",
    "column": "content_id"
  },
  {
    "table": "notification_deliveries",
    "column": "response_content_id"
  },
  {
    "table": "notification_deliveries",
    "column": "payload_content_id"
  },
  {
    "table": "automation_deliveries",
    "column": "payload_content_id"
  },
  {
    "table": "automation_delivery_receipts",
    "column": "content_id"
  },
  {
    "table": "run_control",
    "column": "binding_content_id"
  },
  {
    "table": "run_control",
    "column": "metadata_content_id"
  },
  {
    "table": "run_control_revisions",
    "column": "binding_content_id"
  },
  {
    "table": "run_control_revisions",
    "column": "metadata_content_id"
  },
  {
    "table": "run_settlements",
    "column": "handoff_content_id"
  },
  {
    "table": "run_settlements",
    "column": "digest_content_id"
  },
  {
    "table": "run_settlements",
    "column": "payload_content_id"
  },
  {
    "table": "project_step_memory",
    "column": "content_id"
  },
  {
    "table": "project_step_memory_revisions",
    "column": "source_refs_content_id"
  },
  {
    "table": "project_step_memory_revisions",
    "column": "content_id"
  },
  {
    "table": "step_handoffs",
    "column": "content_id"
  },
  {
    "table": "run_input_materializations",
    "column": "input_content_id"
  },
  {
    "table": "flow_revisions",
    "column": "loop_versions_content_id"
  },
  {
    "table": "report_versions",
    "column": "content_id"
  },
  {
    "table": "turns",
    "column": "summary_content_id"
  },
  {
    "table": "turns",
    "column": "request_content_id"
  },
  {
    "table": "report_version_sources",
    "column": "source_content_id"
  },
  {
    "table": "learning_review_controls",
    "column": "input_content_id"
  },
  {
    "table": "legacy_learning_review_controls",
    "column": "input_content_id"
  },
  {
    "table": "legacy_learning_review_cursor_inputs",
    "column": "input_content_id"
  },
  {
    "table": "migration_source_json_versions",
    "column": "content_id"
  },
  {
    "table": "scheduled_occurrences",
    "column": "payload_content_id"
  },
  {
    "table": "notification_delivery_attempts",
    "column": "response_content_id"
  },
  {
    "table": "roadmap_file_states",
    "column": "pending_content_id"
  },
  {
    "table": "roadmap_file_states",
    "column": "accepted_content_id"
  },
  {
    "table": "growth_snapshot_cleanup_plans",
    "column": "manifest_content_id"
  },
  {
    "table": "growth_snapshot_cleanup_batches",
    "column": "receipt_content_id"
  },
  {
    "table": "growth_snapshot_cleanup_batches",
    "column": "candidate_ids_content_id"
  },
  {
    "table": "pi_conversation_operations",
    "column": "settlement_content_id"
  },
  {
    "table": "pi_conversation_operations",
    "column": "terminal_content_id"
  },
  {
    "table": "pi_conversation_operations",
    "column": "acceptance_content_id"
  },
  {
    "table": "pi_tool_invocations",
    "column": "result_content_id"
  },
  {
    "table": "growth_detail_cleanup_plans",
    "column": "result_content_id"
  },
  {
    "table": "documentation_projection_state",
    "column": "manifest_content_id"
  },
  {
    "table": "pi_conversation_ingress",
    "column": "last_error_content_id"
  },
  {
    "table": "pi_conversation_ingress",
    "column": "request_content_id"
  },
  {
    "table": "pi_session_commits",
    "column": "result_content_id"
  },
  {
    "table": "run_effects",
    "column": "payload_content_id"
  },
  {
    "table": "content_lifecycle_faults",
    "column": "content_id"
  },
  {
    "table": "content_lifecycle_prepare_pins",
    "column": "content_id"
  },
  {
    "table": "content_lifecycle_repairs",
    "column": "content_id"
  }
];

function retired(value: string): string {
  return `EXISTS(SELECT 1 FROM content_lifecycle_gc_members m JOIN content_lifecycle_gc_groups g ON g.id=m.group_id WHERE m.content_id=${value} AND g.state='sealed')`;
}
function dirty(value: string): string {
  return `UPDATE content_lifecycle_gc_groups SET dirty=1 WHERE dirty=0 AND state IN ('collecting','marking') AND id IN (SELECT group_id FROM content_lifecycle_gc_members WHERE content_id=${value});`;
}
function enqueue(value: string): string {
  return `INSERT INTO content_lifecycle_gc_pending SELECT ${value},lower(hex(randomblob(16)))
    WHERE ${value} IS NOT NULL AND EXISTS(SELECT 1 FROM contents WHERE id=${value}) AND NOT ${retired(value)}
    ON CONFLICT(content_id) DO UPDATE SET token=excluded.token;`;
}
export function contentLifecycleGcRootTriggers(roots = contentLifecycleGcRoots.filter(root => root.table !== 'content_lifecycle_repairs')): string {
  return roots.map(({ table, column }) => {
    const name = `content_lifecycle_gc_${table}_${column}`, next = `NEW.${column}`, previous = `OLD.${column}`;
    const publicationCheck = table.startsWith('content_lifecycle_') ? '' : `SELECT CASE WHEN
      (SELECT strict_publication FROM content_lifecycle_gc_state WHERE id=1)=1 AND EXISTS(SELECT 1 FROM content_lifecycle_reference_unpublished WHERE content_id=${next})
      THEN RAISE(ABORT,'content_reference_preparation_required') END;`;
    const byteCheck = table.startsWith('content_lifecycle_') ? '' : `SELECT CASE WHEN
      (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 AND EXISTS(SELECT 1 FROM contents WHERE id=${next} AND encoding LIKE 'staging:%')
      THEN RAISE(ABORT,'content_unfinished') END;`;
    return `
CREATE TRIGGER ${name}_insert_guard BEFORE INSERT ON ${table} WHEN ${next} IS NOT NULL BEGIN
 SELECT CASE WHEN ${retired(next)} THEN RAISE(ABORT,'content_retired') END;
 ${byteCheck}
 ${publicationCheck}
END;
CREATE TRIGGER ${name}_update_guard BEFORE UPDATE OF ${column} ON ${table} WHEN ${next} IS NOT NULL AND ${next} IS NOT ${previous} BEGIN
 SELECT CASE WHEN ${retired(next)} THEN RAISE(ABORT,'content_retired') END;
 ${byteCheck}
 ${publicationCheck}
END;
CREATE TRIGGER ${name}_insert AFTER INSERT ON ${table} WHEN (SELECT enabled FROM content_lifecycle_gc_state WHERE id=1)=1 AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 ${dirty(next)}
 DELETE FROM content_lifecycle_gc_pending WHERE content_id=${next};
END;
CREATE TRIGGER ${name}_update AFTER UPDATE OF ${column} ON ${table} WHEN ${next} IS NOT ${previous} AND (SELECT enabled FROM content_lifecycle_gc_state WHERE id=1)=1 AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 ${dirty(previous)} ${dirty(next)} ${enqueue(previous)}
 DELETE FROM content_lifecycle_gc_pending WHERE content_id=${next};
END;
CREATE TRIGGER ${name}_delete AFTER DELETE ON ${table} WHEN (SELECT enabled FROM content_lifecycle_gc_state WHERE id=1)=1 AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 ${dirty(previous)} ${enqueue(previous)}
END;`;
  }).join('\n');
}

function debtRefresh(id: string): string {
  const unknown = `((EXISTS(SELECT 1 FROM content_lifecycle_reference_pending WHERE content_id=${id} AND ready IN (-1,0)) OR EXISTS(SELECT 1 FROM content_lifecycle_reference_jobs WHERE source_id=${id}) OR EXISTS(SELECT 1 FROM content_lifecycle_reference_faults WHERE source_id=${id})) AND NOT EXISTS(SELECT 1 FROM content_lifecycle_private_staging p JOIN contents c ON c.id=p.content_id WHERE p.content_id=${id} AND c.encoding LIKE 'staging:%'))`;
  const exempt = `EXISTS(SELECT 1 FROM content_lifecycle_gc_exempt_sources e
    JOIN contents c ON c.id=e.content_id AND c.sha256=e.sha256 AND c.byte_length=e.byte_length
    JOIN content_lifecycle_reference_preparations p ON p.content_id=e.content_id AND p.owner_id=e.owner_id AND p.sha256=e.sha256
    JOIN content_lifecycle_prepare_owners o ON o.id=e.owner_id AND o.reference_reservations_live=1 AND o.writer_incarnation=e.writer_incarnation
    JOIN content_lifecycle_reference_unpublished u ON u.content_id=e.content_id
    WHERE e.content_id=${id} AND e.writer_incarnation=(SELECT incarnation FROM content_lifecycle_gc_state WHERE id=1))`;
  return `INSERT INTO content_lifecycle_gc_debt SELECT ${id} WHERE ${unknown} AND NOT ${exempt} AND NOT EXISTS(SELECT 1 FROM content_lifecycle_gc_debt WHERE content_id=${id});
    DELETE FROM content_lifecycle_gc_debt WHERE content_id=${id} AND NOT (${unknown} AND NOT ${exempt});`;
}
function debtTriggers(): string {
  return [
    ['content_lifecycle_reference_pending', 'content_id'], ['content_lifecycle_reference_jobs', 'source_id'],
    ['content_lifecycle_reference_faults', 'source_id'], ['content_lifecycle_gc_exempt_sources', 'content_id'],
    ['content_lifecycle_reference_unpublished', 'content_id'], ['content_lifecycle_reference_preparations', 'content_id'], ['contents', 'id'], ['content_lifecycle_private_staging', 'content_id']
  ].map(([table, column]) => `
CREATE TRIGGER content_lifecycle_gc_debt_${table}_insert AFTER INSERT ON ${table} BEGIN ${debtRefresh(`NEW.${column}`)} END;
CREATE TRIGGER content_lifecycle_gc_debt_${table}_delete AFTER DELETE ON ${table} BEGIN ${debtRefresh(`OLD.${column}`)} END;
CREATE TRIGGER content_lifecycle_gc_debt_${table}_update AFTER UPDATE ON ${table} BEGIN ${debtRefresh(`OLD.${column}`)} ${debtRefresh(`NEW.${column}`)} END;
`).join('\n');
}

export const contentLifecycleGcSchemaSql = `
ALTER TABLE content_lifecycle_prepare_owners ADD COLUMN reference_reservations_live INTEGER NOT NULL DEFAULT 1;
CREATE TABLE content_lifecycle_gc_state(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,strict_publication INTEGER NOT NULL DEFAULT 0,incarnation TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 0,cursor TEXT NOT NULL DEFAULT '',upper_id TEXT NOT NULL DEFAULT '',capture_hold INTEGER NOT NULL DEFAULT 0,recover_exemptions INTEGER NOT NULL DEFAULT 0,deleted_contents INTEGER NOT NULL DEFAULT 0,reclaimed_stored_bytes INTEGER NOT NULL DEFAULT 0);
INSERT INTO content_lifecycle_gc_state(id) VALUES(1);
CREATE TABLE content_lifecycle_private_staging(content_id TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE content_lifecycle_gc_exempt_sources(content_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES content_lifecycle_prepare_owners(id),sha256 TEXT NOT NULL,byte_length INTEGER NOT NULL,writer_incarnation TEXT NOT NULL,
 FOREIGN KEY(owner_id,content_id) REFERENCES content_lifecycle_reference_preparations(owner_id,content_id) ON DELETE CASCADE,
 FOREIGN KEY(content_id) REFERENCES content_lifecycle_reference_unpublished(content_id) ON DELETE CASCADE);
CREATE INDEX content_lifecycle_gc_exempt_owner ON content_lifecycle_gc_exempt_sources(owner_id,content_id);
CREATE INDEX content_lifecycle_gc_exempt_incarnation ON content_lifecycle_gc_exempt_sources(writer_incarnation,content_id);
CREATE TABLE content_lifecycle_gc_debt(content_id TEXT PRIMARY KEY) WITHOUT ROWID;
INSERT OR IGNORE INTO content_lifecycle_gc_debt SELECT content_id FROM content_lifecycle_reference_pending WHERE ready IN (-1,0);
INSERT OR IGNORE INTO content_lifecycle_gc_debt SELECT source_id FROM content_lifecycle_reference_jobs;
INSERT OR IGNORE INTO content_lifecycle_gc_debt SELECT source_id FROM content_lifecycle_reference_faults;
${debtTriggers()}
CREATE TRIGGER content_lifecycle_gc_exempt_identity BEFORE UPDATE OF sha256,byte_length ON contents WHEN NEW.sha256 IS NOT OLD.sha256 OR NEW.byte_length IS NOT OLD.byte_length BEGIN
 DELETE FROM content_lifecycle_gc_exempt_sources WHERE content_id=OLD.id;
END;
CREATE TRIGGER content_lifecycle_gc_exempt_owner_end BEFORE UPDATE OF reference_reservations_live,writer_incarnation ON content_lifecycle_prepare_owners
WHEN (NEW.reference_reservations_live=0 OR NEW.writer_incarnation IS NOT OLD.writer_incarnation) AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 AND EXISTS(SELECT 1 FROM content_lifecycle_gc_exempt_sources WHERE owner_id=OLD.id) BEGIN
 UPDATE content_lifecycle_gc_state SET recover_exemptions=1,revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER content_lifecycle_gc_exempt_owner_delete BEFORE DELETE ON content_lifecycle_prepare_owners
WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 AND EXISTS(SELECT 1 FROM content_lifecycle_gc_exempt_sources WHERE owner_id=OLD.id) BEGIN
 SELECT RAISE(ABORT,'content_reference_reservations_pending');
END;
CREATE TABLE content_lifecycle_gc_pending(content_id TEXT PRIMARY KEY,token TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE content_lifecycle_gc_groups(id TEXT PRIMARY KEY,incarnation TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('collecting','sealed','cancelled')),dirty INTEGER NOT NULL DEFAULT 0,pending_members INTEGER NOT NULL DEFAULT 0,seed_id TEXT NOT NULL,seed_token TEXT NOT NULL,private_staging INTEGER NOT NULL DEFAULT 0);
CREATE TABLE content_lifecycle_gc_members(content_id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES content_lifecycle_gc_groups(id) ON DELETE CASCADE,expanded INTEGER NOT NULL DEFAULT 0,parent_cursor TEXT NOT NULL DEFAULT '',purge_cursor TEXT NOT NULL DEFAULT '') WITHOUT ROWID;
CREATE INDEX content_lifecycle_gc_frontier ON content_lifecycle_gc_members(group_id,expanded,content_id);
CREATE INDEX content_lifecycle_reference_pending_ready ON content_lifecycle_reference_pending(ready,content_id);
${contentLifecycleGcRootTriggers()}
CREATE TRIGGER content_lifecycle_gc_content_insert AFTER INSERT ON contents WHEN (SELECT enabled FROM content_lifecycle_gc_state WHERE id=1)=1 AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 ${enqueue('NEW.id')}
END;
CREATE TRIGGER content_lifecycle_gc_content_update AFTER UPDATE OF sha256,mime_type,byte_length ON contents WHEN (NEW.sha256 IS NOT OLD.sha256 OR NEW.mime_type IS NOT OLD.mime_type OR NEW.byte_length IS NOT OLD.byte_length) AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 ${dirty('NEW.id')}
END;
CREATE TRIGGER content_lifecycle_gc_content_delete AFTER DELETE ON contents WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 ${dirty('OLD.id')}
 DELETE FROM content_lifecycle_gc_pending WHERE content_id=OLD.id;
END;
CREATE TRIGGER content_lifecycle_gc_edge_insert_guard BEFORE INSERT ON content_lifecycle_edges BEGIN
 SELECT CASE WHEN ${retired('NEW.source_id')} THEN RAISE(ABORT,'content_retired') END;
END;
CREATE TRIGGER content_lifecycle_gc_edge_update_guard BEFORE UPDATE OF source_id,target_id ON content_lifecycle_edges WHEN NEW.source_id IS NOT OLD.source_id OR NEW.target_id IS NOT OLD.target_id BEGIN
 SELECT CASE WHEN ${retired('NEW.source_id')} THEN RAISE(ABORT,'content_retired') END;
END;
CREATE TRIGGER content_lifecycle_gc_edge_update AFTER UPDATE OF source_id,target_id ON content_lifecycle_edges WHEN (NEW.source_id IS NOT OLD.source_id OR NEW.target_id IS NOT OLD.target_id) AND (SELECT enabled FROM content_lifecycle_gc_state WHERE id=1)=1 AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 ${dirty('OLD.target_id')} ${dirty('NEW.target_id')} ${enqueue('OLD.target_id')}
END;
CREATE TRIGGER content_lifecycle_gc_edge_insert AFTER INSERT ON content_lifecycle_edges WHEN (SELECT enabled FROM content_lifecycle_gc_state WHERE id=1)=1 AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 ${dirty('NEW.target_id')}
END;
CREATE TRIGGER content_lifecycle_gc_edge_delete AFTER DELETE ON content_lifecycle_edges WHEN (SELECT enabled FROM content_lifecycle_gc_state WHERE id=1)=1 AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 ${dirty('OLD.target_id')} ${enqueue('OLD.target_id')}
END;
CREATE TRIGGER content_lifecycle_gc_retired_update BEFORE UPDATE OF sha256,mime_type,byte_length,stored_byte_length,data,chunk_index_json ON contents WHEN ${retired('OLD.id')} BEGIN
 SELECT RAISE(ABORT,'content_retired');
END;
CREATE TRIGGER content_lifecycle_gc_retired_chunk_insert BEFORE INSERT ON content_chunks WHEN ${retired('NEW.content_id')} BEGIN
 SELECT RAISE(ABORT,'content_retired');
END;
CREATE TRIGGER content_lifecycle_gc_retired_chunk_update BEFORE UPDATE ON content_chunks WHEN ${retired('OLD.content_id')} OR ${retired('NEW.content_id')} BEGIN
 SELECT RAISE(ABORT,'content_retired');
END;
CREATE TRIGGER content_lifecycle_private_staging_promote AFTER UPDATE OF encoding ON contents WHEN NEW.encoding NOT LIKE 'staging:%' AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 DELETE FROM content_lifecycle_private_staging WHERE content_id=NEW.id;
END;
CREATE TRIGGER content_lifecycle_private_staging_delete AFTER DELETE ON contents WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 DELETE FROM content_lifecycle_private_staging WHERE content_id=OLD.id;
END;
CREATE TRIGGER content_lifecycle_private_staging_watch AFTER DELETE ON content_lifecycle_private_staging WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 ${dirty('OLD.content_id')}
END;
CREATE TRIGGER content_lifecycle_gc_physical_delete BEFORE DELETE ON contents WHEN (SELECT enabled FROM content_lifecycle_gc_state WHERE id=1)=1 AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 AND NOT ${retired('OLD.id')} BEGIN
 SELECT RAISE(ABORT,'content_gc_seal_required');
END;
`;
