// Source changesets carry these derived rows. Only replay skips their duplicate derivation.
// The untracked GC debt triggers and all business constraints remain active.
export const generationProjectionTriggersSchemaSql = `
DROP TRIGGER content_cold_delete;
CREATE TRIGGER content_cold_delete AFTER DELETE ON contents WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 DELETE FROM content_lifecycle_cold_pending WHERE content_id=OLD.id;
END;
DROP TRIGGER content_cold_insert;
CREATE TRIGGER content_cold_insert AFTER INSERT ON contents
WHEN (NEW.mime_type='application/json' AND NEW.encoding='utf8' AND NEW.byte_length BETWEEN 256 AND 65536) AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT OR REPLACE INTO content_lifecycle_cold_pending VALUES(NEW.id,NEW.sha256);
END;
DROP TRIGGER content_cold_update;
CREATE TRIGGER content_cold_update AFTER UPDATE OF data,encoding ON contents
WHEN (NEW.mime_type='application/json' AND NEW.encoding='utf8' AND NEW.byte_length BETWEEN 256 AND 65536) AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT OR REPLACE INTO content_lifecycle_cold_pending VALUES(NEW.id,NEW.sha256);
END;
DROP TRIGGER content_lifecycle_gc_exempt_identity;
CREATE TRIGGER content_lifecycle_gc_exempt_identity BEFORE UPDATE OF sha256,byte_length ON contents WHEN (NEW.sha256 IS NOT OLD.sha256 OR NEW.byte_length IS NOT OLD.byte_length) AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 DELETE FROM content_lifecycle_gc_exempt_sources WHERE content_id=OLD.id;
END;
DROP TRIGGER content_receipt_event_delete;
CREATE TRIGGER content_receipt_event_delete AFTER DELETE ON events WHEN (OLD.kind='run.log_appended') AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 DELETE FROM content_lifecycle_receipt_pending WHERE request_id=OLD.request_id AND NOT EXISTS(SELECT 1 FROM events WHERE request_id=OLD.request_id AND kind='run.log_appended');
END;
DROP TRIGGER content_receipt_event_insert;
CREATE TRIGGER content_receipt_event_insert AFTER INSERT ON events WHEN (NEW.kind='run.log_appended') AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT OR REPLACE INTO content_lifecycle_receipt_pending SELECT id,result_content_id FROM requests WHERE id=NEW.request_id AND status='committed' AND result_content_id IS NOT NULL;
END;
DROP TRIGGER content_receipt_request_delete;
CREATE TRIGGER content_receipt_request_delete AFTER DELETE ON requests WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 DELETE FROM content_lifecycle_receipt_pending WHERE request_id=OLD.id;
END;
DROP TRIGGER content_receipt_request_insert;
CREATE TRIGGER content_receipt_request_insert AFTER INSERT ON requests
WHEN (NEW.status='committed' AND NEW.result_content_id IS NOT NULL) AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT OR REPLACE INTO content_lifecycle_receipt_pending SELECT NEW.id,NEW.result_content_id FROM events WHERE request_id=NEW.id AND kind='run.log_appended';
END;
DROP TRIGGER content_receipt_request_update;
CREATE TRIGGER content_receipt_request_update AFTER UPDATE OF result_content_id,status ON requests
WHEN (NEW.status='committed' AND NEW.result_content_id IS NOT NULL) AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT OR REPLACE INTO content_lifecycle_receipt_pending SELECT NEW.id,NEW.result_content_id FROM events WHERE request_id=NEW.id AND kind='run.log_appended';
END;
DROP TRIGGER database_overview_content_delete;
CREATE TRIGGER database_overview_content_delete AFTER DELETE ON contents WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE database_overview_projection SET
  contents_records=MAX(0,contents_records-CASE WHEN exact=1 OR OLD.rowid<=baseline_cursor OR OLD.rowid>baseline_target THEN 1 ELSE 0 END),
  updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER)
 WHERE singleton=1;
END;
DROP TRIGGER database_overview_content_insert;
CREATE TRIGGER database_overview_content_insert AFTER INSERT ON contents WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE database_overview_projection SET
  contents_records=contents_records+CASE WHEN exact=1 OR NEW.rowid<=baseline_cursor OR NEW.rowid>baseline_target THEN 1 ELSE 0 END,
  updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER)
 WHERE singleton=1;
END;
DROP TRIGGER growth_edge_semantic_delete;
CREATE TRIGGER growth_edge_semantic_delete AFTER DELETE ON growth_edges WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=OLD.snapshot_id; END;
DROP TRIGGER growth_edge_semantic_insert;
CREATE TRIGGER growth_edge_semantic_insert AFTER INSERT ON growth_edges WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=NEW.snapshot_id; END;
DROP TRIGGER growth_edge_semantic_update;
CREATE TRIGGER growth_edge_semantic_update AFTER UPDATE ON growth_edges WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id IN (OLD.snapshot_id,NEW.snapshot_id); END;
DROP TRIGGER growth_item_semantic_delete;
CREATE TRIGGER growth_item_semantic_delete AFTER DELETE ON growth_items WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=OLD.snapshot_id; END;
DROP TRIGGER growth_item_semantic_insert;
CREATE TRIGGER growth_item_semantic_insert AFTER INSERT ON growth_items WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=NEW.snapshot_id; END;
DROP TRIGGER growth_item_semantic_update;
CREATE TRIGGER growth_item_semantic_update AFTER UPDATE ON growth_items WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id IN (OLD.snapshot_id,NEW.snapshot_id); END;
DROP TRIGGER growth_label_semantic_delete;
CREATE TRIGGER growth_label_semantic_delete AFTER DELETE ON growth_module_labels WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=OLD.snapshot_id; END;
DROP TRIGGER growth_label_semantic_insert;
CREATE TRIGGER growth_label_semantic_insert AFTER INSERT ON growth_module_labels WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=NEW.snapshot_id; END;
DROP TRIGGER growth_label_semantic_update;
CREATE TRIGGER growth_label_semantic_update AFTER UPDATE ON growth_module_labels WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id IN (OLD.snapshot_id,NEW.snapshot_id); END;
DROP TRIGGER growth_live_edge_semantic_delete;
CREATE TRIGGER growth_live_edge_semantic_delete AFTER DELETE ON growth_live_edges WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=OLD.snapshot_id; END;
DROP TRIGGER growth_live_edge_semantic_insert;
CREATE TRIGGER growth_live_edge_semantic_insert AFTER INSERT ON growth_live_edges WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=NEW.snapshot_id; END;
DROP TRIGGER growth_live_edge_semantic_update;
CREATE TRIGGER growth_live_edge_semantic_update AFTER UPDATE ON growth_live_edges WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id IN (OLD.snapshot_id,NEW.snapshot_id); END;
DROP TRIGGER growth_live_item_semantic_delete;
CREATE TRIGGER growth_live_item_semantic_delete AFTER DELETE ON growth_live_items WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=OLD.snapshot_id; END;
DROP TRIGGER growth_live_item_semantic_insert;
CREATE TRIGGER growth_live_item_semantic_insert AFTER INSERT ON growth_live_items WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=NEW.snapshot_id; END;
DROP TRIGGER growth_live_item_semantic_update;
CREATE TRIGGER growth_live_item_semantic_update AFTER UPDATE ON growth_live_items WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id IN (OLD.snapshot_id,NEW.snapshot_id); END;
DROP TRIGGER growth_live_label_semantic_delete;
CREATE TRIGGER growth_live_label_semantic_delete AFTER DELETE ON growth_live_module_labels WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=OLD.snapshot_id; END;
DROP TRIGGER growth_live_label_semantic_insert;
CREATE TRIGGER growth_live_label_semantic_insert AFTER INSERT ON growth_live_module_labels WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=NEW.snapshot_id; END;
DROP TRIGGER growth_live_label_semantic_update;
CREATE TRIGGER growth_live_label_semantic_update AFTER UPDATE ON growth_live_module_labels WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id IN (OLD.snapshot_id,NEW.snapshot_id); END;
DROP TRIGGER growth_live_signal_semantic_delete;
CREATE TRIGGER growth_live_signal_semantic_delete AFTER DELETE ON growth_live_signals WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=OLD.snapshot_id; END;
DROP TRIGGER growth_live_signal_semantic_insert;
CREATE TRIGGER growth_live_signal_semantic_insert AFTER INSERT ON growth_live_signals WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=NEW.snapshot_id; END;
DROP TRIGGER growth_live_signal_semantic_update;
CREATE TRIGGER growth_live_signal_semantic_update AFTER UPDATE ON growth_live_signals WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id IN (OLD.snapshot_id,NEW.snapshot_id); END;
DROP TRIGGER growth_signal_semantic_delete;
CREATE TRIGGER growth_signal_semantic_delete AFTER DELETE ON growth_signals WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=OLD.snapshot_id; END;
DROP TRIGGER growth_signal_semantic_insert;
CREATE TRIGGER growth_signal_semantic_insert AFTER INSERT ON growth_signals WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id=NEW.snapshot_id; END;
DROP TRIGGER growth_signal_semantic_update;
CREATE TRIGGER growth_signal_semantic_update AFTER UPDATE ON growth_signals WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id IN (OLD.snapshot_id,NEW.snapshot_id); END;
DROP TRIGGER growth_snapshot_semantic_header_update;
CREATE TRIGGER growth_snapshot_semantic_header_update AFTER UPDATE OF project_id,git_head,status,project_path,error ON growth_snapshots WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 DELETE FROM growth_snapshot_semantic_index WHERE snapshot_id IN (OLD.id,NEW.id);
END;
DROP TRIGGER project_analysis_control_delete;
CREATE TRIGGER project_analysis_control_delete AFTER DELETE ON run_control WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN INSERT INTO project_analysis_sources(project_id,revision,run_count,latest_run_at,recent_activity_at) VALUES(OLD.project_id,1,0,0,0)
ON CONFLICT(project_id) DO UPDATE SET revision=project_analysis_sources.revision+1; END;
DROP TRIGGER project_analysis_control_insert;
CREATE TRIGGER project_analysis_control_insert AFTER INSERT ON run_control WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN INSERT INTO project_analysis_sources(project_id,revision,run_count,latest_run_at,recent_activity_at) VALUES(NEW.project_id,1,0,0,0)
ON CONFLICT(project_id) DO UPDATE SET revision=project_analysis_sources.revision+1; END;
DROP TRIGGER project_analysis_control_update;
CREATE TRIGGER project_analysis_control_update AFTER UPDATE ON run_control WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN INSERT INTO project_analysis_sources(project_id,revision,run_count,latest_run_at,recent_activity_at) VALUES(NEW.project_id,1,0,0,0)
ON CONFLICT(project_id) DO UPDATE SET revision=project_analysis_sources.revision+1; END;
DROP TRIGGER project_analysis_journal_delete;
CREATE TRIGGER project_analysis_journal_delete AFTER DELETE ON project_journal_entries WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE project_analysis_sources SET revision=revision+1,
 recent_activity_at=CASE WHEN COALESCE(CAST(ROUND((julianday(OLD.timestamp)-2440587.5)*86400000) AS INTEGER),0)=recent_activity_at THEN MAX((SELECT COALESCE(MAX(MAX(COALESCE(CAST(ROUND((julianday(json_extract(record_json,'$.finishedAt'))-2440587.5)*86400000) AS INTEGER),0),COALESCE(CAST(ROUND((julianday(json_extract(record_json,'$.startedAt'))-2440587.5)*86400000) AS INTEGER),0))),0) FROM project_run_indexes WHERE project_id=OLD.project_id),(SELECT COALESCE(MAX(COALESCE(CAST(ROUND((julianday(timestamp)-2440587.5)*86400000) AS INTEGER),0)),0) FROM project_journal_entries WHERE project_id=OLD.project_id)) ELSE recent_activity_at END
 WHERE project_id=OLD.project_id;
END;
DROP TRIGGER project_analysis_journal_insert;
CREATE TRIGGER project_analysis_journal_insert AFTER INSERT ON project_journal_entries WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT INTO project_analysis_sources(project_id,revision,run_count,latest_run_at,recent_activity_at)
 VALUES(NEW.project_id,1,0,0,COALESCE(CAST(ROUND((julianday(NEW.timestamp)-2440587.5)*86400000) AS INTEGER),0))
 ON CONFLICT(project_id) DO UPDATE SET revision=project_analysis_sources.revision+1,recent_activity_at=MAX(project_analysis_sources.recent_activity_at,excluded.recent_activity_at);
END;
DROP TRIGGER project_analysis_journal_update;
CREATE TRIGGER project_analysis_journal_update AFTER UPDATE ON project_journal_entries WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE project_analysis_sources SET revision=revision+1,
recent_activity_at=CASE WHEN COALESCE(CAST(ROUND((julianday(NEW.timestamp)-2440587.5)*86400000) AS INTEGER),0)>=recent_activity_at THEN COALESCE(CAST(ROUND((julianday(NEW.timestamp)-2440587.5)*86400000) AS INTEGER),0) WHEN COALESCE(CAST(ROUND((julianday(OLD.timestamp)-2440587.5)*86400000) AS INTEGER),0)=recent_activity_at THEN MAX((SELECT COALESCE(MAX(MAX(COALESCE(CAST(ROUND((julianday(json_extract(record_json,'$.finishedAt'))-2440587.5)*86400000) AS INTEGER),0),COALESCE(CAST(ROUND((julianday(json_extract(record_json,'$.startedAt'))-2440587.5)*86400000) AS INTEGER),0))),0) FROM project_run_indexes WHERE project_id=NEW.project_id),(SELECT COALESCE(MAX(COALESCE(CAST(ROUND((julianday(timestamp)-2440587.5)*86400000) AS INTEGER),0)),0) FROM project_journal_entries WHERE project_id=NEW.project_id)) ELSE recent_activity_at END
WHERE project_id=NEW.project_id;
END;
DROP TRIGGER project_analysis_link_delete;
CREATE TRIGGER project_analysis_link_delete AFTER DELETE ON project_journal_links WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN INSERT INTO project_analysis_sources(project_id,revision,run_count,latest_run_at,recent_activity_at) VALUES(OLD.project_id,1,0,0,0)
ON CONFLICT(project_id) DO UPDATE SET revision=project_analysis_sources.revision+1; END;
DROP TRIGGER project_analysis_link_insert;
CREATE TRIGGER project_analysis_link_insert AFTER INSERT ON project_journal_links WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN INSERT INTO project_analysis_sources(project_id,revision,run_count,latest_run_at,recent_activity_at) VALUES(NEW.project_id,1,0,0,0)
ON CONFLICT(project_id) DO UPDATE SET revision=project_analysis_sources.revision+1; END;
DROP TRIGGER project_analysis_link_update;
CREATE TRIGGER project_analysis_link_update AFTER UPDATE ON project_journal_links WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN INSERT INTO project_analysis_sources(project_id,revision,run_count,latest_run_at,recent_activity_at) VALUES(NEW.project_id,1,0,0,0)
ON CONFLICT(project_id) DO UPDATE SET revision=project_analysis_sources.revision+1; END;
DROP TRIGGER project_analysis_run_delete;
CREATE TRIGGER project_analysis_run_delete AFTER DELETE ON project_run_indexes WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE project_analysis_sources SET revision=revision+1,run_count=MAX(0,run_count-1),
 latest_run_at=CASE WHEN MAX(COALESCE(CAST(ROUND((julianday(json_extract(OLD.record_json,'$.finishedAt'))-2440587.5)*86400000) AS INTEGER),0),COALESCE(CAST(ROUND((julianday(json_extract(OLD.record_json,'$.startedAt'))-2440587.5)*86400000) AS INTEGER),0))=latest_run_at THEN (SELECT COALESCE(MAX(MAX(COALESCE(CAST(ROUND((julianday(json_extract(record_json,'$.finishedAt'))-2440587.5)*86400000) AS INTEGER),0),COALESCE(CAST(ROUND((julianday(json_extract(record_json,'$.startedAt'))-2440587.5)*86400000) AS INTEGER),0))),0) FROM project_run_indexes WHERE project_id=OLD.project_id) ELSE latest_run_at END,
 recent_activity_at=CASE WHEN MAX(COALESCE(CAST(ROUND((julianday(json_extract(OLD.record_json,'$.finishedAt'))-2440587.5)*86400000) AS INTEGER),0),COALESCE(CAST(ROUND((julianday(json_extract(OLD.record_json,'$.startedAt'))-2440587.5)*86400000) AS INTEGER),0))=latest_run_at THEN MAX((SELECT COALESCE(MAX(MAX(COALESCE(CAST(ROUND((julianday(json_extract(record_json,'$.finishedAt'))-2440587.5)*86400000) AS INTEGER),0),COALESCE(CAST(ROUND((julianday(json_extract(record_json,'$.startedAt'))-2440587.5)*86400000) AS INTEGER),0))),0) FROM project_run_indexes WHERE project_id=OLD.project_id),(SELECT COALESCE(MAX(COALESCE(CAST(ROUND((julianday(timestamp)-2440587.5)*86400000) AS INTEGER),0)),0) FROM project_journal_entries WHERE project_id=OLD.project_id)) ELSE recent_activity_at END
 WHERE project_id=OLD.project_id;
END;
DROP TRIGGER project_analysis_run_insert;
CREATE TRIGGER project_analysis_run_insert AFTER INSERT ON project_run_indexes WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT INTO project_analysis_sources(project_id,revision,run_count,latest_run_at,recent_activity_at)
 VALUES(NEW.project_id,1,1,MAX(COALESCE(CAST(ROUND((julianday(json_extract(NEW.record_json,'$.finishedAt'))-2440587.5)*86400000) AS INTEGER),0),COALESCE(CAST(ROUND((julianday(json_extract(NEW.record_json,'$.startedAt'))-2440587.5)*86400000) AS INTEGER),0)),MAX(COALESCE(CAST(ROUND((julianday(json_extract(NEW.record_json,'$.finishedAt'))-2440587.5)*86400000) AS INTEGER),0),COALESCE(CAST(ROUND((julianday(json_extract(NEW.record_json,'$.startedAt'))-2440587.5)*86400000) AS INTEGER),0)))
 ON CONFLICT(project_id) DO UPDATE SET revision=project_analysis_sources.revision+1,run_count=project_analysis_sources.run_count+1,
 latest_run_at=MAX(project_analysis_sources.latest_run_at,excluded.latest_run_at),recent_activity_at=MAX(project_analysis_sources.recent_activity_at,excluded.recent_activity_at);
END;
DROP TRIGGER project_analysis_run_update;
CREATE TRIGGER project_analysis_run_update AFTER UPDATE ON project_run_indexes WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE project_analysis_sources SET revision=revision+1,
latest_run_at=CASE WHEN MAX(COALESCE(CAST(ROUND((julianday(json_extract(NEW.record_json,'$.finishedAt'))-2440587.5)*86400000) AS INTEGER),0),COALESCE(CAST(ROUND((julianday(json_extract(NEW.record_json,'$.startedAt'))-2440587.5)*86400000) AS INTEGER),0))>=latest_run_at THEN MAX(COALESCE(CAST(ROUND((julianday(json_extract(NEW.record_json,'$.finishedAt'))-2440587.5)*86400000) AS INTEGER),0),COALESCE(CAST(ROUND((julianday(json_extract(NEW.record_json,'$.startedAt'))-2440587.5)*86400000) AS INTEGER),0)) WHEN MAX(COALESCE(CAST(ROUND((julianday(json_extract(OLD.record_json,'$.finishedAt'))-2440587.5)*86400000) AS INTEGER),0),COALESCE(CAST(ROUND((julianday(json_extract(OLD.record_json,'$.startedAt'))-2440587.5)*86400000) AS INTEGER),0))=latest_run_at THEN (SELECT COALESCE(MAX(MAX(COALESCE(CAST(ROUND((julianday(json_extract(record_json,'$.finishedAt'))-2440587.5)*86400000) AS INTEGER),0),COALESCE(CAST(ROUND((julianday(json_extract(record_json,'$.startedAt'))-2440587.5)*86400000) AS INTEGER),0))),0) FROM project_run_indexes WHERE project_id=NEW.project_id) ELSE latest_run_at END,
recent_activity_at=CASE WHEN MAX(COALESCE(CAST(ROUND((julianday(json_extract(NEW.record_json,'$.finishedAt'))-2440587.5)*86400000) AS INTEGER),0),COALESCE(CAST(ROUND((julianday(json_extract(NEW.record_json,'$.startedAt'))-2440587.5)*86400000) AS INTEGER),0))>=recent_activity_at THEN MAX(COALESCE(CAST(ROUND((julianday(json_extract(NEW.record_json,'$.finishedAt'))-2440587.5)*86400000) AS INTEGER),0),COALESCE(CAST(ROUND((julianday(json_extract(NEW.record_json,'$.startedAt'))-2440587.5)*86400000) AS INTEGER),0)) WHEN MAX(COALESCE(CAST(ROUND((julianday(json_extract(OLD.record_json,'$.finishedAt'))-2440587.5)*86400000) AS INTEGER),0),COALESCE(CAST(ROUND((julianday(json_extract(OLD.record_json,'$.startedAt'))-2440587.5)*86400000) AS INTEGER),0))=latest_run_at THEN MAX((SELECT COALESCE(MAX(MAX(COALESCE(CAST(ROUND((julianday(json_extract(record_json,'$.finishedAt'))-2440587.5)*86400000) AS INTEGER),0),COALESCE(CAST(ROUND((julianday(json_extract(record_json,'$.startedAt'))-2440587.5)*86400000) AS INTEGER),0))),0) FROM project_run_indexes WHERE project_id=NEW.project_id),(SELECT COALESCE(MAX(COALESCE(CAST(ROUND((julianday(timestamp)-2440587.5)*86400000) AS INTEGER),0)),0) FROM project_journal_entries WHERE project_id=NEW.project_id)) ELSE recent_activity_at END
WHERE project_id=NEW.project_id;
END;
DROP TRIGGER project_conversation_journal_delete;
CREATE TRIGGER project_conversation_journal_delete AFTER DELETE ON project_journal_entries WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE project_analysis_sources SET conversation_revision=conversation_revision+1 WHERE project_id=OLD.project_id;
END;
DROP TRIGGER project_conversation_journal_insert;
CREATE TRIGGER project_conversation_journal_insert AFTER INSERT ON project_journal_entries WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE project_analysis_sources SET conversation_revision=conversation_revision+1 WHERE project_id=NEW.project_id;
END;
DROP TRIGGER project_conversation_journal_update;
CREATE TRIGGER project_conversation_journal_update AFTER UPDATE ON project_journal_entries WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE project_analysis_sources SET conversation_revision=conversation_revision+1 WHERE project_id=NEW.project_id;
END;
DROP TRIGGER project_conversation_link_delete;
CREATE TRIGGER project_conversation_link_delete AFTER DELETE ON project_journal_links WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE project_analysis_sources SET conversation_revision=conversation_revision+1 WHERE project_id=OLD.project_id;
END;
DROP TRIGGER project_conversation_link_insert;
CREATE TRIGGER project_conversation_link_insert AFTER INSERT ON project_journal_links WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE project_analysis_sources SET conversation_revision=conversation_revision+1 WHERE project_id=NEW.project_id;
END;
DROP TRIGGER project_conversation_link_update;
CREATE TRIGGER project_conversation_link_update AFTER UPDATE ON project_journal_links WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE project_analysis_sources SET conversation_revision=conversation_revision+1 WHERE project_id=NEW.project_id;
END;
DROP TRIGGER project_conversation_mapping_delete;
CREATE TRIGGER project_conversation_mapping_delete AFTER DELETE ON run_turn_journals WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE project_analysis_sources SET conversation_revision=conversation_revision+1 WHERE project_id=OLD.project_id;
END;
DROP TRIGGER project_conversation_mapping_insert;
CREATE TRIGGER project_conversation_mapping_insert AFTER INSERT ON run_turn_journals WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE project_analysis_sources SET conversation_revision=conversation_revision+1 WHERE project_id=NEW.project_id;
END;
DROP TRIGGER project_conversation_mapping_update;
CREATE TRIGGER project_conversation_mapping_update AFTER UPDATE ON run_turn_journals WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE project_analysis_sources SET conversation_revision=conversation_revision+1 WHERE project_id=NEW.project_id;
END;
DROP TRIGGER project_conversation_turn_update;
CREATE TRIGGER project_conversation_turn_update AFTER UPDATE OF request_content_id,summary_content_id ON turns
WHEN (NEW.request_content_id IS NOT OLD.request_content_id OR NEW.summary_content_id IS NOT OLD.summary_content_id) AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE project_analysis_sources SET conversation_revision=conversation_revision+1 WHERE project_id=NEW.project_id;
END;
DROP TRIGGER project_strategy_run_delete;
CREATE TRIGGER project_strategy_run_delete AFTER DELETE ON project_run_indexes WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE project_analysis_sources SET run_index_revision=run_index_revision+1 WHERE project_id=OLD.project_id;
END;
DROP TRIGGER project_strategy_run_insert;
CREATE TRIGGER project_strategy_run_insert AFTER INSERT ON project_run_indexes WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT INTO project_analysis_sources(project_id,revision,run_count,latest_run_at,recent_activity_at,conversation_revision,run_index_revision)
 VALUES(NEW.project_id,1,0,0,0,1,1)
 ON CONFLICT(project_id) DO UPDATE SET run_index_revision=project_analysis_sources.run_index_revision+1;
END;
DROP TRIGGER project_strategy_run_update;
CREATE TRIGGER project_strategy_run_update AFTER UPDATE ON project_run_indexes WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE project_analysis_sources SET run_index_revision=run_index_revision+1 WHERE project_id=NEW.project_id;
END;
DROP TRIGGER sidebar_core_archive_update;
CREATE TRIGGER sidebar_core_archive_update AFTER UPDATE OF archived_at ON objects
WHEN (NEW.kind='roadmap_node' AND NEW.archived_at IS NOT OLD.archived_at) AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000 WHERE project_id=NEW.project_id;
END;
DROP TRIGGER sidebar_core_dependency_delete;
CREATE TRIGGER sidebar_core_dependency_delete AFTER DELETE ON roadmap_dependencies WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000
 WHERE project_id=(SELECT project_id FROM roadmap_nodes WHERE id=OLD.node_id);
END;
DROP TRIGGER sidebar_core_dependency_insert;
CREATE TRIGGER sidebar_core_dependency_insert AFTER INSERT ON roadmap_dependencies WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000
 WHERE project_id=(SELECT project_id FROM roadmap_nodes WHERE id=NEW.node_id);
END;
DROP TRIGGER sidebar_core_project_insert;
CREATE TRIGGER sidebar_core_project_insert AFTER INSERT ON projects WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT OR IGNORE INTO sidebar_core_projection_state(project_id) VALUES(NEW.id);
END;
DROP TRIGGER sidebar_core_project_update;
CREATE TRIGGER sidebar_core_project_update AFTER UPDATE ON projects WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000 WHERE project_id=NEW.id;
END;
DROP TRIGGER sidebar_core_roadmap_delete;
CREATE TRIGGER sidebar_core_roadmap_delete AFTER DELETE ON roadmap_nodes WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT INTO sidebar_core_projection_state(project_id,source_revision) VALUES(OLD.project_id,1)
 ON CONFLICT(project_id) DO UPDATE SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000;
END;
DROP TRIGGER sidebar_core_roadmap_insert;
CREATE TRIGGER sidebar_core_roadmap_insert AFTER INSERT ON roadmap_nodes WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT INTO sidebar_core_projection_state(project_id,source_revision) VALUES(NEW.project_id,1)
 ON CONFLICT(project_id) DO UPDATE SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000;
END;
DROP TRIGGER sidebar_core_roadmap_update;
CREATE TRIGGER sidebar_core_roadmap_update AFTER UPDATE ON roadmap_nodes WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT INTO sidebar_core_projection_state(project_id,source_revision) VALUES(NEW.project_id,1)
 ON CONFLICT(project_id) DO UPDATE SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000;
END;
DROP TRIGGER sidebar_projection_analysis_delete;
CREATE TRIGGER sidebar_projection_analysis_delete AFTER DELETE ON project_analysis_sources WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000 WHERE project_id=OLD.project_id;
END;
DROP TRIGGER sidebar_projection_analysis_insert;
CREATE TRIGGER sidebar_projection_analysis_insert AFTER INSERT ON project_analysis_sources WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000 WHERE project_id=NEW.project_id;
END;
DROP TRIGGER sidebar_projection_analysis_update;
CREATE TRIGGER sidebar_projection_analysis_update AFTER UPDATE OF run_count,latest_run_at,recent_activity_at ON project_analysis_sources
WHEN (NEW.run_count IS NOT OLD.run_count OR NEW.latest_run_at IS NOT OLD.latest_run_at OR NEW.recent_activity_at IS NOT OLD.recent_activity_at) AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000 WHERE project_id=NEW.project_id;
END;
DROP TRIGGER sidebar_projection_documentation_delete;
CREATE TRIGGER sidebar_projection_documentation_delete AFTER DELETE ON evidence WHEN (OLD.type='documentation_manifest') AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000 WHERE project_id=OLD.project_id;
END;
DROP TRIGGER sidebar_projection_documentation_insert;
CREATE TRIGGER sidebar_projection_documentation_insert AFTER INSERT ON evidence WHEN (NEW.type='documentation_manifest') AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000 WHERE project_id=NEW.project_id;
END;
DROP TRIGGER sidebar_projection_documentation_update;
CREATE TRIGGER sidebar_projection_documentation_update AFTER UPDATE ON evidence WHEN (NEW.type='documentation_manifest' OR OLD.type='documentation_manifest') AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000 WHERE project_id IN (NEW.project_id,OLD.project_id);
END;
DROP TRIGGER sidebar_projection_learning_event_delete;
CREATE TRIGGER sidebar_projection_learning_event_delete AFTER DELETE ON learning_events WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000;
END;
DROP TRIGGER sidebar_projection_learning_event_insert;
CREATE TRIGGER sidebar_projection_learning_event_insert AFTER INSERT ON learning_events WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000;
END;
DROP TRIGGER sidebar_projection_learning_event_update;
CREATE TRIGGER sidebar_projection_learning_event_update AFTER UPDATE ON learning_events WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000;
END;
DROP TRIGGER sidebar_projection_lesson_decision_delete;
CREATE TRIGGER sidebar_projection_lesson_decision_delete AFTER DELETE ON lesson_decisions WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000;
END;
DROP TRIGGER sidebar_projection_lesson_decision_insert;
CREATE TRIGGER sidebar_projection_lesson_decision_insert AFTER INSERT ON lesson_decisions WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000;
END;
DROP TRIGGER sidebar_projection_lesson_decision_update;
CREATE TRIGGER sidebar_projection_lesson_decision_update AFTER UPDATE ON lesson_decisions WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000;
END;
DROP TRIGGER sidebar_projection_lesson_delete;
CREATE TRIGGER sidebar_projection_lesson_delete AFTER DELETE ON lessons WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000;
END;
DROP TRIGGER sidebar_projection_lesson_insert;
CREATE TRIGGER sidebar_projection_lesson_insert AFTER INSERT ON lessons WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000;
END;
DROP TRIGGER sidebar_projection_lesson_update;
CREATE TRIGGER sidebar_projection_lesson_update AFTER UPDATE ON lessons WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000;
END;
DROP TRIGGER sidebar_projection_location_delete;
CREATE TRIGGER sidebar_projection_location_delete AFTER DELETE ON project_locations WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000 WHERE project_id=OLD.project_id;
END;
DROP TRIGGER sidebar_projection_location_insert;
CREATE TRIGGER sidebar_projection_location_insert AFTER INSERT ON project_locations WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000 WHERE project_id=NEW.project_id;
END;
DROP TRIGGER sidebar_projection_location_update;
CREATE TRIGGER sidebar_projection_location_update AFTER UPDATE ON project_locations WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000 WHERE project_id IN (OLD.project_id,NEW.project_id);
END;
DROP TRIGGER sidebar_projection_memory_delete;
CREATE TRIGGER sidebar_projection_memory_delete AFTER DELETE ON project_step_memory WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000 WHERE project_id=OLD.project_id;
END;
DROP TRIGGER sidebar_projection_memory_insert;
CREATE TRIGGER sidebar_projection_memory_insert AFTER INSERT ON project_step_memory WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000 WHERE project_id=NEW.project_id;
END;
DROP TRIGGER sidebar_projection_memory_update;
CREATE TRIGGER sidebar_projection_memory_update AFTER UPDATE ON project_step_memory WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000 WHERE project_id=NEW.project_id;
END;
DROP TRIGGER sidebar_projection_run_delete;
CREATE TRIGGER sidebar_projection_run_delete AFTER DELETE ON project_run_indexes WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000 WHERE project_id=OLD.project_id;
END;
DROP TRIGGER sidebar_projection_run_insert;
CREATE TRIGGER sidebar_projection_run_insert AFTER INSERT ON project_run_indexes WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000 WHERE project_id=NEW.project_id;
END;
DROP TRIGGER sidebar_projection_run_update;
CREATE TRIGGER sidebar_projection_run_update AFTER UPDATE ON project_run_indexes WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE sidebar_core_projection_state SET source_revision=source_revision+1,updated_at=unixepoch('subsec')*1000 WHERE project_id=NEW.project_id;
END;
DROP TRIGGER today_evaluation_delete;
CREATE TRIGGER today_evaluation_delete AFTER DELETE ON evaluations WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT INTO today_learning_revisions VALUES(COALESCE(OLD.project_id,'global'),1) ON CONFLICT(scope_key) DO UPDATE SET revision=revision+1;
END;
DROP TRIGGER today_evaluation_insert;
CREATE TRIGGER today_evaluation_insert AFTER INSERT ON evaluations WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT INTO today_learning_revisions VALUES(COALESCE(NEW.project_id,'global'),1) ON CONFLICT(scope_key) DO UPDATE SET revision=revision+1;
END;
DROP TRIGGER today_evaluation_update;
CREATE TRIGGER today_evaluation_update AFTER UPDATE ON evaluations WHEN (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT INTO today_learning_revisions VALUES(COALESCE(NEW.project_id,'global'),1) ON CONFLICT(scope_key) DO UPDATE SET revision=revision+1;
END;
DROP TRIGGER today_lesson_delete;
CREATE TRIGGER today_lesson_delete AFTER DELETE ON lessons WHEN (OLD.status='approved') AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT INTO today_learning_revisions VALUES(COALESCE(OLD.project_id,'global'),1) ON CONFLICT(scope_key) DO UPDATE SET revision=revision+1;
END;
DROP TRIGGER today_lesson_insert;
CREATE TRIGGER today_lesson_insert AFTER INSERT ON lessons WHEN (NEW.status='approved') AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT INTO today_learning_revisions VALUES(COALESCE(NEW.project_id,'global'),1) ON CONFLICT(scope_key) DO UPDATE SET revision=revision+1;
END;
DROP TRIGGER today_lesson_update;
CREATE TRIGGER today_lesson_update AFTER UPDATE ON lessons WHEN (NEW.status='approved' OR OLD.status='approved') AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT INTO today_learning_revisions VALUES(COALESCE(NEW.project_id,'global'),1) ON CONFLICT(scope_key) DO UPDATE SET revision=revision+1;
END;
DROP TRIGGER today_object_archive;
CREATE TRIGGER today_object_archive AFTER UPDATE OF archived_at ON objects WHEN (NEW.archived_at IS NOT OLD.archived_at AND NEW.kind IN ('lesson','policy','evaluation')) AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 INSERT INTO today_learning_revisions VALUES(COALESCE(NEW.project_id,'global'),1) ON CONFLICT(scope_key) DO UPDATE SET revision=revision+1;
END;
DROP TRIGGER today_policy_insert;
CREATE TRIGGER today_policy_insert AFTER INSERT ON policies WHEN (NEW.kind='global_prompt') AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE today_learning_revisions SET revision=revision+1 WHERE scope_key='global';
END;
DROP TRIGGER today_policy_update;
CREATE TRIGGER today_policy_update AFTER UPDATE ON policies WHEN (NEW.kind='global_prompt' OR OLD.kind='global_prompt') AND (SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1)=0 BEGIN
 UPDATE today_learning_revisions SET revision=revision+1 WHERE scope_key='global';
END;
`;
