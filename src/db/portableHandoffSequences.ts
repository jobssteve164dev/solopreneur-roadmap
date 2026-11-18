import type { SqlValue } from './diskDatabase.js';

type Row = Record<string, SqlValue>;
export function restorePortableHandoffSequences(tables: Map<string, Row[]>, decoded: Map<string, Uint8Array>): void {
  const handoffs = tables.get('step_handoffs') || [];
  const missing = new Map<string, Row>();
  const key = (project: unknown, node: unknown, run: unknown, purpose: unknown): string => JSON.stringify([project, node, run, purpose]);
  for (const handoff of handoffs) {
    if (handoff.handoff_sequence !== null && handoff.handoff_sequence !== undefined) {
      if (!Number.isSafeInteger(handoff.handoff_sequence) || Number(handoff.handoff_sequence) < 1) throw new Error('project_archive_handoff_sequence_invalid');
      continue;
    }
    const purpose = `settlement_${String(handoff.turn_id).replace(/-/g, '')}_${Number(handoff.checkpoint_sequence)}`;
    missing.set(key(handoff.project_id, handoff.node_key, handoff.run_id, purpose), handoff);
  }
  if (missing.size) {
    const evidence = new Map((tables.get('evidence') || []).map(row => [String(row.id), row]));
    const documents = new Map<string, Row[]>();
    for (const row of tables.get('run_documents') || []) {
      const id = String(row.object_id), entries = documents.get(id) || []; entries.push(row); documents.set(id, entries);
    }
    for (const revision of tables.get('project_step_memory_revisions') || []) {
      const object = evidence.get(String(revision.object_id)), bytes = object ? decoded.get(String(object.content_id)) : undefined;
      if (!bytes) throw new Error('project_archive_handoff_boundary_missing');
      const snapshot = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')) as { latestHandoffRef?: { objectId?: string }; handoffCursor?: number };
      if (!snapshot.latestHandoffRef?.objectId) continue;
      for (const document of documents.get(snapshot.latestHandoffRef.objectId) || []) {
        const handoff = missing.get(key(revision.project_id, revision.node_key, document.run_id, document.purpose));
        if (!handoff) continue;
        const sequence = Number(revision.handoff_cursor);
        if (!Number.isSafeInteger(sequence) || sequence < 1 || snapshot.handoffCursor !== sequence
          || handoff.handoff_sequence !== null && handoff.handoff_sequence !== undefined && handoff.handoff_sequence !== sequence) throw new Error('project_archive_handoff_boundary_conflict');
        handoff.handoff_sequence = sequence;
      }
    }
  }
  const seen = new Map<string, Row>();
  for (const handoff of handoffs) {
    if (!Number.isSafeInteger(handoff.handoff_sequence)) throw new Error('project_archive_handoff_boundary_missing');
    const identity = JSON.stringify([handoff.project_id, handoff.node_key, handoff.handoff_sequence]);
    if (seen.has(identity) && seen.get(identity) !== handoff) throw new Error('project_archive_handoff_boundary_conflict');
    seen.set(identity, handoff);
  }
}
