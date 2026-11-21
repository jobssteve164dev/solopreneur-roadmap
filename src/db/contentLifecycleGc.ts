import { randomUUID } from 'crypto';
import { DiskDatabase, SqlValue } from './diskDatabase.js';
import { contentLifecycleGcRoots } from './contentLifecycleGcSchema.js';

type Row = Record<string, SqlValue>;
interface GcStore {
  db: DiskDatabase;
  rows(sql: string, values?: SqlValue[]): Row[];
  transaction<T>(operation: () => T, commit?: <R>(publish: () => R) => R): T;
  readTransaction<T>(operation: () => T): T;
  writerIncarnation(): string;
  ownsWriter(): boolean;
  captureActive(): boolean;
  reservationOwner(id: string): string | undefined;
  pinReservation(ownerId: string, id: string): void;
  reservationCleanupFailed(): boolean;
  handoffReservation(id: string, previousOwner: string): void;
}
type Candidate = { id: string; token: string };
export interface StorageReclamationOverview {
  status: 'disabled' | 'paused' | 'checkingHistory' | 'checkingReferences' | 'pending' | 'idle';
  deletedContents: number;
  reclaimedStoredBytes: number;
}
export interface StorageGcBatch {
  incarnation: string; revision: number; pending: boolean;
  action: 'idle' | 'recover' | 'release_holds' | 'scan' | 'start' | 'discard' | 'expand' | 'cancel' | 'clean' | 'seal' | 'purge';
  groupId?: string; sourceId?: string; cursor?: string; complete?: boolean; rooted?: boolean;
  privateStaging?: boolean; incomingCursor?: string; incomingComplete?: boolean;
  candidates?: Candidate[]; ids?: string[]; chunks?: Array<{ ordinal: number; bytes: number }>;
  edges?: Array<{ source: string; target: string }>; bytes?: number;
}

/** One seed per proof keeps a rooted branch from discarding unrelated candidates. */
export class ContentLifecycleGc {
  private readonly watched = new Set<string>();
  private readonly rootSql = contentLifecycleGcRoots.map(({ table, column }) =>
    `SELECT 1 FROM ${table} WHERE ${column}=?`).join(' UNION ALL ') + ' LIMIT 1';
  constructor(private readonly store: GcStore) {}
  private rooted(id: string): boolean {
    return Boolean(this.store.rows(this.rootSql, contentLifecycleGcRoots.map(() => id))[0]);
  }
  private historicalReferencesRemain(): boolean {
    return Boolean(this.store.rows(`SELECT 1 FROM content_lifecycle_reference_progress p WHERE id=1 AND EXISTS
      (SELECT 1 FROM contents WHERE contents.id>p.cursor AND contents.id<=p.upper_id) LIMIT 1`)[0]);
  }
  private hasUnverifiedReferences(): boolean {
    return Boolean(this.store.rows('SELECT 1 FROM content_lifecycle_gc_debt LIMIT 1')[0]);
  }
  private indexIncomplete(): boolean {
    return this.historicalReferencesRemain() || this.hasUnverifiedReferences();
  }
  readOverview(): StorageReclamationOverview {
    return this.store.readTransaction(() => {
      const state = this.store.rows('SELECT * FROM content_lifecycle_gc_state WHERE id=1')[0];
      let status: StorageReclamationOverview['status'] = 'idle';
      if (!Number(state.enabled)) status = 'disabled';
      else if (Number(state.capture_hold)) status = 'paused';
      else if (this.historicalReferencesRemain()) status = 'checkingHistory';
      else if (this.hasUnverifiedReferences()) status = 'checkingReferences';
      else if (Number(state.recover_exemptions) || this.store.rows(`SELECT 1
        WHERE EXISTS(SELECT 1 FROM content_lifecycle_gc_groups)
           OR EXISTS(SELECT 1 FROM content_lifecycle_gc_pending)
           OR EXISTS(SELECT 1 FROM content_lifecycle_release_holds)
           OR EXISTS(SELECT 1 FROM database_storage_cleanup_candidates)
           OR EXISTS(SELECT 1 FROM contents WHERE id>? AND id<=?)`, [state.cursor, state.upper_id])[0]) {
        status = 'pending';
      }
      return {
        status,
        deletedContents: Number(state.deleted_contents),
        reclaimedStoredBytes: Number(state.reclaimed_stored_bytes)
      };
    });
  }
  private assertWriter(): void {
    if (!this.store.ownsWriter()) throw new Error('content_gc_writer_required');
  }
  private privateStaging(id: string): boolean {
    return Boolean(this.store.rows("SELECT 1 FROM content_lifecycle_private_staging p JOIN contents c ON c.id=p.content_id WHERE p.content_id=? AND c.encoding LIKE 'staging:%'", [id])[0]);
  }
  private privateCandidate(limit: number): Candidate | undefined {
    const candidates = this.store.rows(`SELECT p.content_id,q.token FROM content_lifecycle_private_staging p JOIN contents c ON c.id=p.content_id
      JOIN content_lifecycle_gc_pending q ON q.content_id=p.content_id WHERE c.encoding LIKE 'staging:%'
      AND NOT EXISTS(SELECT 1 FROM content_lifecycle_prepare_pins WHERE content_id=p.content_id)
      AND NOT EXISTS(SELECT 1 FROM content_lifecycle_gc_members m JOIN content_lifecycle_gc_groups g ON g.id=m.group_id WHERE m.content_id=p.content_id AND g.state='sealed')
      ORDER BY p.content_id LIMIT ?`, [limit]);
    const candidate = candidates.find(row => !this.rooted(String(row.content_id)));
    return candidate ? { id: String(candidate.content_id), token: String(candidate.token) } : undefined;
  }
  activate(options: { strictPublication?: boolean } = {}): void {
    this.assertWriter();
    const changedIncarnation = this.store.transaction(() => {
      const state = this.store.rows('SELECT * FROM content_lifecycle_gc_state WHERE id=1')[0];
      const changed = state.incarnation !== this.store.writerIncarnation();
      const strict = options.strictPublication === undefined ? Number(state.strict_publication) : Number(options.strictPublication);
      if (Number(state.enabled) && !changed && strict === Number(state.strict_publication)) return false;
      if (changed) this.store.db.run(`UPDATE content_lifecycle_gc_groups SET state='cancelled' WHERE state='collecting'`);
      this.store.db.run(`UPDATE content_lifecycle_gc_state SET enabled=1,strict_publication=?,incarnation=?,revision=revision+1,
        recover_exemptions=CASE WHEN ? AND EXISTS(SELECT 1 FROM content_lifecycle_gc_exempt_sources) THEN 1 ELSE recover_exemptions END,
        upper_id=CASE WHEN enabled=0 THEN COALESCE((SELECT MAX(id) FROM contents),'') ELSE upper_id END WHERE id=1`, [strict, this.store.writerIncarnation(), changed ? 1 : 0]);
      return changed;
    });
    if (changedIncarnation) this.watched.clear();
  }
  invalidateReservations(targets: ReadonlySet<string>): void {
    const smaller = targets.size < this.watched.size ? targets : this.watched;
    const larger = smaller === targets ? this.watched : targets;
    for (const id of smaller) if (larger.has(id)) {
      this.store.db.run("UPDATE content_lifecycle_gc_groups SET dirty=1 WHERE state='collecting' AND dirty=0");
      return;
    }
  }
  prepare(limit = 128): StorageGcBatch {
    if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error('database_maintenance_limit_invalid');
    return this.store.readTransaction(() => {
      const state = this.store.rows('SELECT * FROM content_lifecycle_gc_state WHERE id=1')[0];
      const batch: StorageGcBatch = { incarnation: String(state.incarnation), revision: Number(state.revision), pending: false, action: 'idle' };
      if (!Number(state.enabled) || Number(state.capture_hold) || this.store.captureActive()) return batch;
      if (Number(state.recover_exemptions)) {
        batch.action = 'recover'; batch.pending = true;
        batch.ids = this.store.rows(`SELECT e.content_id FROM content_lifecycle_gc_exempt_sources e JOIN content_lifecycle_prepare_owners o ON o.id=e.owner_id
          WHERE e.writer_incarnation<>? OR o.reference_reservations_live=0 ORDER BY e.content_id LIMIT ?`, [state.incarnation, limit]).map(row => String(row.content_id));
        batch.complete = batch.ids.length < limit;
        return batch;
      }
      const holds = this.store.rows('SELECT content_id FROM content_lifecycle_release_holds LIMIT ?', [limit]);
      if (holds.length) { batch.action = 'release_holds'; batch.pending = true; batch.ids = holds.map(row => String(row.content_id)); return batch; }
      const group = this.store.rows(`SELECT * FROM content_lifecycle_gc_groups ORDER BY CASE state WHEN 'sealed' THEN 0 WHEN 'cancelled' THEN 1 ELSE 2 END,id LIMIT 1`)[0];
      if (group) {
        batch.groupId = String(group.id); batch.pending = true;
        if (group.state === 'cancelled') {
          batch.action = 'clean';
          batch.ids = this.store.rows('SELECT content_id FROM content_lifecycle_gc_members WHERE group_id=? LIMIT ?', [group.id, limit]).map(row => String(row.content_id));
          return batch;
        }
        if (group.state === 'sealed') return this.preparePurge(batch, limit);
        if (Number(group.dirty) || group.incarnation !== state.incarnation) { batch.action = 'cancel'; return batch; }
        // Unknown dependencies may not authorize deletion, even if discovered after this group began.
        if (!Number(group.private_staging) && this.indexIncomplete()) {
          if (this.privateCandidate(limit)) batch.action = 'cancel'; else batch.pending = false;
          return batch;
        }
        const member = this.store.rows('SELECT * FROM content_lifecycle_gc_members WHERE group_id=? AND expanded=0 ORDER BY content_id LIMIT 1', [group.id])[0];
        if (!member) { batch.action = 'seal'; return batch; }
        batch.sourceId = String(member.content_id);
        if (this.rooted(batch.sourceId)) { batch.action = 'cancel'; batch.rooted = true; return batch; }
        if (Number(group.private_staging)) {
          if (!this.privateStaging(batch.sourceId)) { batch.action = 'cancel'; return batch; }
          batch.action = 'expand'; batch.ids = []; batch.cursor = ''; batch.complete = true; return batch;
        }
        batch.action = 'expand';
        const parents = this.store.rows(`SELECT e.source_id FROM content_lifecycle_edges e JOIN contents c ON c.id=e.source_id
          WHERE e.target_id=? AND e.source_id>? AND NOT EXISTS
          (SELECT 1 FROM content_lifecycle_gc_members m JOIN content_lifecycle_gc_groups g ON g.id=m.group_id WHERE m.content_id=e.source_id AND g.state='sealed')
          ORDER BY e.source_id LIMIT ?`, [member.content_id, member.parent_cursor, limit]);
        batch.ids = parents.map(row => String(row.source_id));
        batch.cursor = batch.ids.at(-1) || String(member.parent_cursor);
        batch.complete = parents.length < limit;
        return batch;
      }
      const privateCandidate = this.privateCandidate(limit);
      if (privateCandidate) { batch.pending = true; batch.action = 'start'; batch.candidates = [privateCandidate]; batch.privateStaging = true; return batch; }
      if (this.indexIncomplete()) return batch;
      const candidates = this.store.rows('SELECT * FROM content_lifecycle_gc_pending ORDER BY content_id LIMIT ?', [limit]);
      if (candidates.length) {
        batch.pending = true; batch.action = 'discard'; batch.candidates = [];
        for (const candidate of candidates) {
          const id = String(candidate.content_id), token = String(candidate.token);
          if (!this.store.rows('SELECT 1 FROM contents WHERE id=?', [id])[0] || this.rooted(id)) batch.candidates.push({ id, token });
          else {
            if (!batch.candidates.length) { batch.action = 'start'; batch.candidates.push({ id, token }); }
            break;
          }
        }
        return batch;
      }
      const scanned = this.store.rows('SELECT id FROM contents WHERE id>? AND id<=? ORDER BY id LIMIT ?', [state.cursor, state.upper_id, limit]);
      if (!scanned.length) return batch;
      batch.action = 'scan'; batch.pending = true; batch.cursor = String(scanned.at(-1)!.id);
      batch.ids = scanned.filter(row => !this.rooted(String(row.id))).map(row => String(row.id));
      return batch;
    });
  }
  private preparePurge(batch: StorageGcBatch, limit: number): StorageGcBatch {
    batch.action = 'purge';
    const member = this.store.rows('SELECT * FROM content_lifecycle_gc_members WHERE group_id=? LIMIT 1', [batch.groupId!])[0];
    if (!member) return batch;
    batch.sourceId = String(member.content_id);
    const chunks = this.store.rows('SELECT ordinal,length(data) AS bytes FROM content_chunks WHERE content_id=? ORDER BY ordinal LIMIT ?', [member.content_id, limit]);
    let bytes = 0;
    batch.chunks = [];
    for (const chunk of chunks) {
      if (batch.chunks.length && bytes + Number(chunk.bytes) > 4 * 1024 * 1024) break;
      batch.chunks.push({ ordinal: Number(chunk.ordinal), bytes: Number(chunk.bytes) }); bytes += Number(chunk.bytes);
    }
    if (batch.chunks.length) return batch;
    batch.edges = this.store.rows('SELECT source_id,target_id FROM content_lifecycle_edges WHERE source_id=? LIMIT ?', [member.content_id, limit])
      .map(row => ({ source: String(row.source_id), target: String(row.target_id) }));
    if (batch.edges.length) return batch;
    {
      const incoming = this.store.rows('SELECT source_id,target_id FROM content_lifecycle_edges WHERE target_id=? AND source_id>? ORDER BY source_id LIMIT ?', [member.content_id, member.purge_cursor, limit]);
      batch.incomingCursor = String(incoming.at(-1)?.source_id || member.purge_cursor);
      batch.incomingComplete = incoming.length < limit;
      batch.edges = incoming.filter(row => !this.store.rows(`SELECT 1 FROM contents c WHERE c.id=? AND NOT EXISTS
        (SELECT 1 FROM content_lifecycle_gc_members m JOIN content_lifecycle_gc_groups g ON g.id=m.group_id WHERE m.content_id=c.id AND g.state='sealed')`, [row.source_id])[0])
        .map(row => ({ source: String(row.source_id), target: String(row.target_id) }));
      if (!batch.incomingComplete) return batch;
    }
    batch.bytes = Number(this.store.rows('SELECT length(data) AS bytes FROM contents WHERE id=?', [member.content_id])[0]?.bytes || 0);
    return batch;
  }
  private purgeIncomingEdges(edges: NonNullable<StorageGcBatch['edges']>): void {
    for (const edge of edges) this.store.db.run(`DELETE FROM content_lifecycle_edges WHERE source_id=? AND target_id=? AND NOT EXISTS
      (SELECT 1 FROM contents c WHERE c.id=? AND NOT EXISTS
        (SELECT 1 FROM content_lifecycle_gc_members m JOIN content_lifecycle_gc_groups g ON g.id=m.group_id WHERE m.content_id=c.id AND g.state='sealed'))`,
    [edge.source, edge.target, edge.source]);
  }
  commit(batch: StorageGcBatch, commit?: <T>(publish: () => T) => T, recordProgress?: (counts: {deletedContents: number; reclaimedStoredBytes: number}) => void): { applied: boolean; deletedContents: number; reclaimedStoredBytes: number } {
    const result = { applied: false, deletedContents: 0, reclaimedStoredBytes: 0 };
    if (batch.action === 'idle') return result;
    this.assertWriter();
    if ((batch.ids?.length || 0) > 128 || (batch.candidates?.length || 0) > 128 || (batch.chunks?.length || 0) > 128 || (batch.edges?.length || 0) > 128) throw new Error('database_maintenance_limit_invalid');
    const addWatch: string[] = [], removeWatch: string[] = [];
    let clearWatch = false;
    const committed = this.store.transaction(() => {
      const state = this.store.rows('SELECT * FROM content_lifecycle_gc_state WHERE id=1')[0];
      if (!Number(state.enabled) || state.incarnation !== this.store.writerIncarnation() || state.incarnation !== batch.incarnation || Number(state.revision) !== batch.revision || Number(state.capture_hold) || this.store.captureActive()) return result;
      const group = batch.groupId ? this.store.rows('SELECT * FROM content_lifecycle_gc_groups WHERE id=?', [batch.groupId])[0] : undefined;
      if (batch.groupId && !group) return result;
      if (group?.state === 'collecting' && batch.action !== 'cancel' && (Number(group.dirty) || group.incarnation !== state.incarnation)) return result;
      const db = this.store.db;
      switch (batch.action) {
        case 'release_holds':
          for (const id of batch.ids || []) db.run('DELETE FROM content_lifecycle_release_holds WHERE content_id=?', [id]);
          break;
        case 'recover':
          for (const id of batch.ids || []) {
            const row = this.store.rows('SELECT owner_id FROM content_lifecycle_gc_exempt_sources WHERE content_id=?', [id])[0];
            if (row) this.store.handoffReservation(id, String(row.owner_id));
            db.run(`DELETE FROM content_lifecycle_gc_exempt_sources WHERE content_id=? AND
              (writer_incarnation<>? OR EXISTS(SELECT 1 FROM content_lifecycle_prepare_owners o WHERE o.id=owner_id AND o.reference_reservations_live=0))`, [id, state.incarnation]);
          }
          if (batch.complete) db.run('UPDATE content_lifecycle_gc_state SET recover_exemptions=0 WHERE id=1');
          break;
        case 'scan':
          for (const id of batch.ids || []) db.run(`INSERT OR IGNORE INTO content_lifecycle_gc_pending SELECT ?,? WHERE EXISTS(SELECT 1 FROM contents WHERE id=?)`, [id, randomUUID(), id]);
          db.run('UPDATE content_lifecycle_gc_state SET cursor=? WHERE id=1', [batch.cursor!]); break;
        case 'discard':
          for (const candidate of batch.candidates || []) db.run('DELETE FROM content_lifecycle_gc_pending WHERE content_id=? AND token=?', [candidate.id, candidate.token]);
          break;
        case 'start': {
          const seed = batch.candidates![0];
          if (!this.store.rows('SELECT 1 FROM content_lifecycle_gc_pending WHERE content_id=? AND token=?', [seed.id, seed.token])[0]
            || this.store.rows('SELECT 1 FROM content_lifecycle_gc_groups LIMIT 1')[0]) return result;
          if (batch.privateStaging && !this.privateStaging(seed.id)) return result;
          const id = randomUUID();
          db.run(`INSERT INTO content_lifecycle_gc_groups(id,incarnation,state,pending_members,seed_id,seed_token,private_staging) VALUES(?,?,'collecting',1,?,?,?)`, [id, state.incarnation, seed.id, seed.token, batch.privateStaging ? 1 : 0]);
          db.run('INSERT INTO content_lifecycle_gc_members(content_id,group_id) VALUES(?,?)', [seed.id, id]); break;
        }
        case 'expand': {
          if (group!.state !== 'collecting') return result;
          const member = this.store.rows('SELECT * FROM content_lifecycle_gc_members WHERE content_id=? AND group_id=? AND expanded=0', [batch.sourceId!, group!.id])[0];
          if (!member) return result;
          const owner = this.store.reservationOwner(String(member.content_id));
          if (owner) {
            this.store.pinReservation(owner, String(member.content_id));
            db.run('DELETE FROM content_lifecycle_gc_pending WHERE content_id=? AND token=?', [group!.seed_id, group!.seed_token]);
            db.run("UPDATE content_lifecycle_gc_groups SET state='cancelled' WHERE id=?", [group!.id]);
            break;
          }
          let added = 0;
          for (const id of batch.ids || []) {
            if (this.store.rows('SELECT 1 FROM content_lifecycle_gc_members WHERE content_id=?', [id])[0]) continue;
            db.run('INSERT INTO content_lifecycle_gc_members(content_id,group_id) VALUES(?,?)', [id, group!.id]); added++;
            addWatch.push(id);
          }
          db.run('UPDATE content_lifecycle_gc_members SET parent_cursor=?,expanded=? WHERE content_id=?', [batch.cursor!, batch.complete ? 1 : 0, batch.sourceId!]);
          db.run('UPDATE content_lifecycle_gc_groups SET pending_members=pending_members+? WHERE id=?', [added - (batch.complete ? 1 : 0), group!.id]); break;
        }
        case 'cancel':
          if (group!.state !== 'collecting') return result;
          // A clean rooted ancestor proves this one seed reachable; a dirty proof proves nothing.
          if (batch.rooted && !Number(group!.dirty)) db.run('DELETE FROM content_lifecycle_gc_pending WHERE content_id=? AND token=?', [group!.seed_id, group!.seed_token]);
          db.run("UPDATE content_lifecycle_gc_groups SET state='cancelled' WHERE id=?", [group!.id]); break;
        case 'clean':
          if (group!.state !== 'cancelled') return result;
          for (const id of batch.ids || []) { db.run('DELETE FROM content_lifecycle_gc_members WHERE content_id=? AND group_id=?', [id, group!.id]); removeWatch.push(id); }
          if (!this.store.rows('SELECT 1 FROM content_lifecycle_gc_members WHERE group_id=? LIMIT 1', [group!.id])[0]) db.run('DELETE FROM content_lifecycle_gc_groups WHERE id=?', [group!.id]);
          break;
        case 'seal':
          if (group!.state !== 'collecting' || Number(group!.pending_members) || Number(state.recover_exemptions) || this.store.reservationCleanupFailed()) return result;
          if (Number(group!.private_staging) ? !this.privateStaging(String(group!.seed_id)) || this.rooted(String(group!.seed_id)) : this.indexIncomplete()) return result;
          db.run("UPDATE content_lifecycle_gc_groups SET state='sealed' WHERE id=? AND dirty=0 AND pending_members=0 AND incarnation=?", [group!.id, state.incarnation]); clearWatch = true; break;
        case 'purge':
          if (group!.state !== 'sealed') return result;
          if (!batch.sourceId) { db.run('DELETE FROM content_lifecycle_gc_groups WHERE id=?', [group!.id]); break; }
          if (!this.store.rows('SELECT 1 FROM content_lifecycle_gc_members WHERE content_id=? AND group_id=?', [batch.sourceId, group!.id])[0]) return result;
          if (batch.chunks?.length) {
            for (const chunk of batch.chunks) db.run('DELETE FROM content_chunks WHERE content_id=? AND ordinal=?', [batch.sourceId, chunk.ordinal]);
            result.reclaimedStoredBytes = batch.chunks.reduce((total, chunk) => total + chunk.bytes, 0);
          } else if (batch.incomingCursor !== undefined && !batch.incomingComplete) {
            this.purgeIncomingEdges(batch.edges || []);
            db.run('UPDATE content_lifecycle_gc_members SET purge_cursor=? WHERE content_id=?', [batch.incomingCursor, batch.sourceId]);
          } else if (batch.edges?.length && batch.incomingCursor === undefined) {
            for (const edge of batch.edges) db.run('DELETE FROM content_lifecycle_edges WHERE source_id=? AND target_id=?', [edge.source, edge.target]);
          } else {
            this.purgeIncomingEdges(batch.edges || []);
            db.run('DELETE FROM content_lifecycle_release_holds WHERE content_id=?', [batch.sourceId]);
            db.run('DELETE FROM contents WHERE id=?', [batch.sourceId]);
            db.run('DELETE FROM content_lifecycle_gc_members WHERE content_id=?', [batch.sourceId]);
            result.deletedContents = 1; result.reclaimedStoredBytes = batch.bytes || 0;
          }
          db.run('UPDATE content_lifecycle_gc_state SET deleted_contents=deleted_contents+?,reclaimed_stored_bytes=reclaimed_stored_bytes+? WHERE id=1', [result.deletedContents, result.reclaimedStoredBytes]);
          break;
      }
      db.run('UPDATE content_lifecycle_gc_state SET revision=revision+1 WHERE id=1');
      if(result.deletedContents || result.reclaimedStoredBytes)recordProgress?.(result);
      return { ...result, applied: true };
    },commit);
    if (committed.applied) {
      if (batch.action === 'start') this.watched.add(batch.candidates![0].id);
      for (const id of addWatch) this.watched.add(id);
      for (const id of removeWatch) this.watched.delete(id);
      if (clearWatch) this.watched.clear();
    }
    return committed;
  }
}
