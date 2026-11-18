import { randomUUID } from 'crypto';
import { DiskDatabase, type SqlValue } from './diskDatabase.js';

type Row = Record<string, SqlValue>;

// These TEMP receipts belong to one private candidate. Source-written slots lose
// their private ownership during native replay, including conflict replacement.
export class CandidateImportChunks {
  constructor(private readonly db: DiskDatabase, private readonly rows: (sql: string, values?: SqlValue[]) => Row[], private readonly assertCandidate: () => void) {
    this.assertCandidate();
    db.run('CREATE TEMP TABLE candidate_import_chunks(content_id TEXT,ordinal INTEGER,PRIMARY KEY(content_id,ordinal)) WITHOUT ROWID');
    db.run('CREATE TEMP TABLE candidate_import_chunk_changes(content_id TEXT PRIMARY KEY) WITHOUT ROWID');
    db.run('CREATE TEMP TABLE candidate_import_chunk_journals(content_id TEXT PRIMARY KEY,token TEXT NOT NULL) WITHOUT ROWID');
    db.run('CREATE TEMP TABLE candidate_import_chunk_protected(content_id TEXT PRIMARY KEY) WITHOUT ROWID');
    db.run('CREATE TEMP TABLE candidate_import_content_slots(sha256 TEXT,mime_type TEXT,encoding TEXT,content_id TEXT,PRIMARY KEY(sha256,mime_type,encoding)) WITHOUT ROWID');
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = operation === 'DELETE' ? 'OLD' : 'NEW';
      db.run(`CREATE TEMP TRIGGER candidate_import_chunks_${operation.toLowerCase()} AFTER ${operation} ON main.content_chunks
        WHEN (SELECT replaying FROM main.content_lifecycle_replication_guard WHERE id=1)=1 BEGIN
        INSERT OR IGNORE INTO candidate_import_chunk_changes SELECT ${row}.content_id WHERE EXISTS(SELECT 1 FROM candidate_import_chunks WHERE content_id=${row}.content_id)
          OR EXISTS(SELECT 1 FROM candidate_import_chunk_protected WHERE content_id=${row}.content_id);
        DELETE FROM candidate_import_chunks WHERE content_id=${row}.content_id AND ordinal=${row}.ordinal;
      END`);
      db.run(`CREATE TEMP TRIGGER candidate_import_chunk_journals_${operation.toLowerCase()} AFTER ${operation} ON main.content_lifecycle_repairs
        WHEN (SELECT replaying FROM main.content_lifecycle_replication_guard WHERE id=1)=1 BEGIN
        INSERT OR IGNORE INTO candidate_import_chunk_changes SELECT ${row}.content_id WHERE EXISTS(SELECT 1 FROM candidate_import_chunks WHERE content_id=${row}.content_id)
          OR EXISTS(SELECT 1 FROM candidate_import_chunk_protected WHERE content_id=${row}.content_id);
        DELETE FROM candidate_import_chunk_journals WHERE content_id=${row}.content_id;
      END`);
    }
    db.run(`CREATE TEMP TRIGGER candidate_import_chunk_content_update AFTER UPDATE ON main.contents
      WHEN (SELECT replaying FROM main.content_lifecycle_replication_guard WHERE id=1)=1 BEGIN
      INSERT OR IGNORE INTO candidate_import_chunk_changes SELECT NEW.id WHERE EXISTS(SELECT 1 FROM candidate_import_chunks WHERE content_id=NEW.id)
        OR EXISTS(SELECT 1 FROM candidate_import_chunk_protected WHERE content_id=NEW.id);
    END`);
  }

  own(contentId: string, ordinal: number): void {
    this.db.run('INSERT OR IGNORE INTO candidate_import_chunks VALUES(?,?)', [contentId, ordinal]);
  }
  protect(contentId: string): void {
    this.db.run('INSERT OR IGNORE INTO candidate_import_chunk_protected VALUES(?)', [contentId]);
    this.db.run('INSERT OR IGNORE INTO candidate_import_chunk_changes VALUES(?)', [contentId]);
  }

  // Called within the native frame transaction, before its FK proof and COMMIT.
  // At most 64 private slots are retired per frame; remaining work gets the
  // established durable repair journal rather than a new Source sweep.
  reconcile(): void {
    this.assertCandidate();
    let budget = 64;
    for (const changed of this.rows('SELECT content_id FROM candidate_import_chunk_changes')) {
      const id = String(changed.content_id), content = this.rows('SELECT sha256,mime_type,encoding,byte_length,stored_byte_length,chunk_index_json FROM contents WHERE id=?', [id])[0];
      if (!content) continue;
      const active = new Set<number>();
      let first = 0, count = 0;
      if (String(content.encoding).startsWith('chunked:')) {
        const manifest = JSON.parse(String(content.chunk_index_json)), chunks = Array.isArray(manifest) ? manifest : manifest.chunks;
        first = Array.isArray(manifest) ? 0 : manifest.firstOrdinal;
        for (const [index, chunk] of chunks.entries()) active.add(chunk.ordinal ?? first + index);
        const ordinals = [...active].sort((a, b) => a - b);
        first = ordinals[0]; count = ordinals[ordinals.length - 1] - first + 1;
        if (!count || !Number.isSafeInteger(first) || first < 0 || !Number.isSafeInteger(first + count)
          || ordinals.some(ordinal => !Number.isSafeInteger(ordinal))) throw new Error('candidate_import_cleanup_layout_invalid');
      }
      for (const slot of this.rows('SELECT ordinal FROM candidate_import_chunks WHERE content_id=? ORDER BY ordinal', [id])) {
        const ordinal = Number(slot.ordinal);
        if (active.has(ordinal)) continue;
        if (budget) {
          this.db.run('DELETE FROM content_chunks WHERE content_id=? AND ordinal=?', [id, ordinal]);
          this.db.run('DELETE FROM candidate_import_chunks WHERE content_id=? AND ordinal=?', [id, ordinal]);
          budget--;
        }
      }
      const journal = this.rows('SELECT token,source_encoding FROM content_lifecycle_repairs WHERE content_id=?', [id])[0];
      const privateJournal = this.rows('SELECT token FROM candidate_import_chunk_journals WHERE content_id=?', [id])[0];
      const remaining = this.rows('SELECT 1 FROM content_chunks WHERE content_id=? AND (ordinal<? OR ordinal>=?) LIMIT 1', [id, first, first + count])[0];
      if (!remaining && (!journal || journal.token === privateJournal?.token)) {
        if (journal && journal.token === privateJournal?.token) this.db.run('DELETE FROM content_lifecycle_repairs WHERE content_id=? AND token=?', [id, journal.token]);
        this.db.run('DELETE FROM candidate_import_chunk_journals WHERE content_id=?', [id]);
        this.db.run('DELETE FROM candidate_import_chunk_protected WHERE content_id=?', [id]);
        continue;
      }
      const marker = `candidate-import:${first}:${count}:${content.encoding}`;
      if (journal && journal.token !== privateJournal?.token) {
        this.db.run('UPDATE content_lifecycle_repairs SET source_encoding=?,chunk_index_json=? WHERE content_id=? AND token=?', [marker, content.chunk_index_json, id, journal.token]);
        continue;
      }
      const token = String(privateJournal?.token || randomUUID());
      const gc = this.rows('SELECT token FROM content_lifecycle_gc_pending WHERE content_id=?', [id])[0];
      this.db.run(`INSERT INTO content_lifecycle_repairs(content_id,token,incarnation,phase,sha256,mime_type,source_encoding,target_encoding,shadow_floor,first_ordinal,chunk_count,byte_length,stored_byte_length,chunk_index_json)
        VALUES(?,?,(SELECT incarnation FROM content_lifecycle_gc_state WHERE id=1),'cleanup',?,?,?,?,0,?,?,?,?,?)
        ON CONFLICT(content_id) DO UPDATE SET sha256=excluded.sha256,mime_type=excluded.mime_type,source_encoding=excluded.source_encoding,target_encoding=excluded.target_encoding,
          first_ordinal=excluded.first_ordinal,chunk_count=excluded.chunk_count,byte_length=excluded.byte_length,stored_byte_length=excluded.stored_byte_length,chunk_index_json=excluded.chunk_index_json`,
      [id, token, content.sha256, content.mime_type, marker, content.encoding, first, count, content.byte_length, content.stored_byte_length, content.chunk_index_json]);
      this.db.run('INSERT OR REPLACE INTO candidate_import_chunk_journals VALUES(?,?)', [id, token]);
      if (gc) this.db.run('INSERT OR IGNORE INTO content_lifecycle_gc_pending VALUES(?,?)', [id, gc.token]);
    }
    this.db.run('DELETE FROM candidate_import_chunk_changes');
    this.assertCandidate();
  }
}
