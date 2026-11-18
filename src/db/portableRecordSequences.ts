import type { SqlValue } from './diskDatabase.js';

type Row = Record<string, SqlValue>;

/** Recover business order from the archive's immutable creation events and plans. */
export function restorePortableRecordSequences(tables: Map<string, Row[]>, decoded: Map<string, Uint8Array>): void {
  const events = new Map<string, number>();
  const firstEvents = new Map<string, number>();
  const versionEvents = new Map<string, number>();
  const identity = (...values: unknown[]): string => JSON.stringify(values);
  for (const event of tables.get('events') || []) {
    const id = String(event.subject_id), sequence = Number(event.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('project_archive_record_order_invalid');
    firstEvents.set(id,Math.min(firstEvents.get(id) ?? sequence,sequence));
    const version = identity(event.subject_id,event.content_id);
    versionEvents.set(version,Math.min(versionEvents.get(version) ?? sequence,sequence));
    if (!['growth_snapshot.create', 'evidence.run_digest'].includes(String(event.kind))) continue;
    events.set(id, Math.min(events.get(id) ?? sequence, sequence));
  }
  const growth = tables.get('growth_snapshots') || [];
  if (growth.some(row => row.snapshot_sequence == null)) {
    const anchors = new Map<string, number>();
    const anchor = (items: Array<{ snapshotId: string; objectRowid: number }> = []): void => {
      for (const item of items) {
        if (!Number.isSafeInteger(item.objectRowid) || item.objectRowid < 1
          || anchors.has(item.snapshotId) && anchors.get(item.snapshotId) !== item.objectRowid) throw new Error('project_archive_growth_boundary_conflict');
        anchors.set(item.snapshotId, item.objectRowid);
      }
    };
    for (const plan of tables.get('growth_snapshot_cleanup_plans') || []) {
      const bytes = decoded.get(String(plan.manifest_content_id));
      if (!bytes) throw new Error('project_archive_growth_boundary_missing');
      const manifest = JSON.parse(Buffer.from(bytes).toString('utf8'));
      anchor(manifest.retainedSnapshots); anchor(manifest.candidateSnapshots);
    }
    for (const plan of tables.get('growth_detail_cleanup_plans') || []) {
      const manifest = JSON.parse(String(plan.manifest_json));
      anchor(manifest.retainedTopologies); anchor(manifest.candidateSnapshots);
    }
    const ordered = [...growth];
    for (const row of ordered) if (!events.has(String(row.id))) throw new Error('project_archive_growth_order_missing');
    ordered.sort((left, right) => events.get(String(left.id))! - events.get(String(right.id))!);
    let previous = 0;
    for (const row of ordered) {
      const anchored = anchors.get(String(row.id));
      const sequence = row.snapshot_sequence == null ? anchored ?? previous + 1 : Number(row.snapshot_sequence);
      if (!Number.isSafeInteger(sequence) || sequence <= previous || anchored !== undefined && sequence !== anchored) throw new Error('project_archive_growth_boundary_conflict');
      row.snapshot_sequence = sequence; previous = sequence;
    }
  }
  for (const row of tables.get('run_digests') || []) if (row.digest_sequence == null) {
    const sequence = events.get(String(row.object_id));
    if (sequence === undefined) throw new Error('project_archive_digest_order_missing');
    row.digest_sequence = sequence;
  }
  for (const [table,column,subject] of [
    ['run_control','run_sequence','run_id'],['flow_control','flow_sequence','object_id'],
    ['reports','creation_sequence','id'],['run_input_materializations','materialization_sequence','evidence_id']
  ]) for (const row of tables.get(table) || []) if (row[column] == null) {
    const sequence = firstEvents.get(String(row[subject]));
    if (sequence === undefined) throw new Error(`project_archive_record_order_missing:${table}`);
    row[column] = sequence;
  }
  const revisions = new Map((tables.get('object_revisions') || []).map(row => [identity(row.object_id,row.revision),row]));
  for (const row of tables.get('run_consumer_sources') || []) if (row.source_sequence == null) {
    const revision = revisions.get(identity(row.run_id,row.source_revision));
    const sequence = revision ? versionEvents.get(identity(row.run_id,revision.content_id)) : undefined;
    if (sequence === undefined) throw new Error('project_archive_record_order_missing:run_consumer_sources');
    row.source_sequence = sequence;
  }
  const documentOrders = new Map((tables.get('run_documents') || []).map(row => [identity(row.run_id,row.purpose),firstEvents.get(String(row.object_id))]));
  const settlementKey = (row: Row): string => identity(row.run_id,`settlement_${String(row.turn_id).replace(/-/g,'')}_${Number(row.checkpoint_sequence)}`);
  const settlements = new Map((tables.get('run_settlements') || []).map(row => [settlementKey(row),row]));
  for (const row of settlements.values()) if (row.settlement_sequence == null) {
    const sequence = documentOrders.get(settlementKey(row));
    if (sequence === undefined) throw new Error('project_archive_record_order_missing:run_settlements');
    row.settlement_sequence = sequence;
  }
  const effects = tables.get('run_effects') || [];
  if (effects.some(row => row.effect_sequence == null)) {
    if (effects.some(row => row.effect_sequence != null)) throw new Error('project_archive_effect_order_conflict');
    // Legacy import already consumed this serialized queue in archive order.
    // The original enqueue order was not recorded in its settlement payload.
    effects.forEach((row,index) => { row.effect_sequence = index+1; });
  }
  for (const [table,column] of [
    ['growth_snapshots','snapshot_sequence'],['run_digests','digest_sequence'],['run_control','run_sequence'],
    ['flow_control','flow_sequence'],['reports','creation_sequence'],['run_input_materializations','materialization_sequence'],
    ['run_consumer_sources','source_sequence'],['run_settlements','settlement_sequence'],['run_effects','effect_sequence']
  ]) {
    const seen = new Set<string>();
    for (const row of tables.get(table) || []) {
      const sequence = row[column], key = JSON.stringify([row.project_id,sequence]);
      if (!Number.isSafeInteger(sequence) || Number(sequence) < 1 || seen.has(key)) throw new Error('project_archive_record_order_invalid');
      seen.add(key);
    }
  }
  for (const [table,rows] of tables) if (/^growth_(live_)?(items|edges|signals|module_labels)$/.test(table)) {
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.detail_ordinal == null) continue;
      const key = JSON.stringify([row.snapshot_id,row.detail_ordinal]);
      if (!Number.isSafeInteger(row.detail_ordinal) || Number(row.detail_ordinal) < 0 || seen.has(key)) throw new Error('project_archive_detail_order_invalid');
      seen.add(key);
    }
  }
}
