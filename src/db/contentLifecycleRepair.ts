import { randomUUID, createHash } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';
import { DiskDatabase, SqlValue } from './diskDatabase.js';
import type { PreparedStoredContent } from './unifiedDataStore.js';

type Row = Record<string, SqlValue>;
export type StagedPreparedContent = Omit<PreparedStoredContent,'chunks'> & {sourceContentId: string; chunkCount: number};
type RepairContent = PreparedStoredContent | StagedPreparedContent;
interface RepairStore {
  db: DiskDatabase;
  rows(sql: string, values?: SqlValue[]): Row[];
  transaction<T>(operation: () => T): T;
  readTransaction<T>(operation: () => T): T;
  incarnation(): string;
  ownsWriter(): boolean;
  assertIntegrity(id: string, assertLive: ()=>void): Promise<void>;
}
export interface StorageRepairBatch {
  pending: boolean;
  contentId?: string;
  token?: string;
  phase?: string;
  ordinals?: number[];
}
export function contentEncodingBase(encoding: string): string {
  const base = encoding.replace(/^(?:chunked|gzip):/, '');
  return base.startsWith('repair:') ? base.slice(base.indexOf(':', 7) + 1) : base;
}
export function candidateRepairRange(encoding: string): { first: number; count: number } | undefined {
  const match = /^candidate-import:(\d+):(\d+):/.exec(encoding);
  if (!match) return undefined;
  const first = Number(match[1]), count = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || !Number.isSafeInteger(first + count)) throw new Error('content_repair_identity_conflict');
  return { first, count };
}

export const contentLifecycleRepairSchemaSql = `
CREATE TABLE content_lifecycle_repairs(
 content_id TEXT PRIMARY KEY REFERENCES contents(id),token TEXT NOT NULL,incarnation TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('building','cleanup','superseded')),
 sha256 TEXT NOT NULL,mime_type TEXT NOT NULL,source_encoding TEXT NOT NULL,target_encoding TEXT NOT NULL,
 shadow_floor INTEGER NOT NULL,first_ordinal INTEGER NOT NULL,chunk_count INTEGER NOT NULL,
 byte_length INTEGER NOT NULL,stored_byte_length INTEGER NOT NULL,chunk_index_json TEXT,
 written_chunks INTEGER NOT NULL DEFAULT 0 CHECK(written_chunks>=0),written_bytes INTEGER NOT NULL DEFAULT 0 CHECK(written_bytes>=0));
`;
const repairColumns = 'content_id,token,incarnation,phase,sha256,mime_type,source_encoding,target_encoding,shadow_floor,first_ordinal,chunk_count,byte_length,stored_byte_length,chunk_index_json';
const repairMetadata = 'content_id,token,incarnation,phase,sha256,mime_type,source_encoding,target_encoding,shadow_floor,first_ordinal,chunk_count,byte_length,stored_byte_length,written_chunks,written_bytes';

/** Old bytes remain in place until a complete, durable replacement is selected. */
export class ContentLifecycleRepair {
  private readonly running = new Map<string, Promise<string>>();
  constructor(private readonly store: RepairStore) {}
  activeIds(): string[] { return [...this.running.keys()]; }
  supersede(id: string): void {
    this.store.db.run(`UPDATE content_lifecycle_repairs SET phase='superseded',
      source_encoding=CASE WHEN source_encoding LIKE 'candidate-import:%' THEN target_encoding ELSE source_encoding END WHERE content_id=?`, [id]);
  }
  repair(id: string, prepared: PreparedStoredContent, pin: (id: string) => void, assertLive: () => void): Promise<string> {
    return this.enqueue(id,prepared,pin,assertLive);
  }
  repairFromContent(id: string, prepared: StagedPreparedContent, pin: (id: string)=>void, assertLive: ()=>void): Promise<string> {
    if(prepared.sourceContentId===id || !Number.isSafeInteger(prepared.chunkCount) || prepared.chunkCount<0)throw new Error('prepared_content_invalid');
    pin(prepared.sourceContentId);
    return this.enqueue(id,prepared,pin,assertLive);
  }
  private enqueue(id: string, prepared: RepairContent, pin: (id: string)=>void, assertLive: ()=>void): Promise<string> {
    pin(id);
    const previous = this.running.get(id) || Promise.resolve('');
    const work = previous.catch(() => '').then(() => this.replace(id, prepared, assertLive));
    this.running.set(id, work);
    return work.finally(() => { if (this.running.get(id) === work) this.running.delete(id); });
  }
  private record(id: string): Row | undefined { return this.store.rows(`SELECT ${repairMetadata} FROM content_lifecycle_repairs WHERE content_id=?`, [id])[0]; }
  private assertJob(id: string, token: string, phase: string): void {
    const row = this.store.rows('SELECT phase FROM content_lifecycle_repairs WHERE content_id=? AND token=?', [id, token])[0];
    if (row?.phase === 'superseded') throw new Error('content_repair_superseded');
    if (row?.phase !== phase) throw new Error('content_repair_identity_conflict');
  }
  private async replace(id: string, prepared: RepairContent, assertLive: () => void): Promise<string> {
    assertLive();
    try { await this.store.assertIntegrity(id,assertLive); return id; }
    catch (error) { if (!(error instanceof Error) || !['content_integrity_error', 'content_unfinished'].includes(error.message)) throw error; }
    // A new generation cannot replace an unfinished generation's retirement record.
    for (;;) {
      const previous = this.record(id);
      if (!previous) break;
      if (previous.incarnation !== this.store.incarnation() && !this.store.ownsWriter()) throw new Error('content_repair_recovery_writer_required');
      assertLive();
      const batch = this.prepareRow(previous);
      this.commit(batch, id);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assertLive();
    try { await this.store.assertIntegrity(id,assertLive); return id; }
    catch (error) { if (!(error instanceof Error) || !['content_integrity_error', 'content_unfinished'].includes(error.message)) throw error; }
    const current = this.store.rows('SELECT sha256,mime_type,encoding FROM contents WHERE id=?', [id])[0];
    if (!current || current.sha256 !== prepared.sha256 || current.mime_type !== prepared.mimeType) throw new Error('prepared_content_collision');
    const fault = this.store.rows('SELECT encoding FROM content_lifecycle_faults WHERE content_id=?', [id])[0];
    const sourceEncoding = String(String(current.encoding).startsWith('staging:') ? fault?.encoding || prepared.encoding : current.encoding);
    const base = contentEncodingBase(prepared.encoding), token = randomUUID();
    const preparedChunkCount='sourceContentId' in prepared?prepared.chunkCount:prepared.chunks.length;
    if ((!sourceEncoding.startsWith('chunked:') && prepared.byteLength <= 65536) || prepared.byteLength === 0) {
      if (preparedChunkCount) throw new Error('prepared_content_invalid');
      const bytes = prepared.encoding.startsWith('gzip:') ? gunzipSync(prepared.data, { maxOutputLength: prepared.byteLength }) : Buffer.from(prepared.data);
      if (bytes.length !== prepared.byteLength || createHash('sha256').update(bytes).digest('hex') !== prepared.sha256) throw new Error('prepared_content_invalid');
      let encoding = /^(?:staging|chunked):/.test(sourceEncoding) ? base : sourceEncoding;
      if (this.store.rows('SELECT 1 FROM contents WHERE sha256=? AND mime_type=? AND encoding=? AND id<>?', [prepared.sha256, prepared.mimeType, encoding, id])[0]) encoding = `repair:${token}:${base}`;
      const data = encoding.startsWith('gzip:') ? gzipSync(bytes, { level: 1 }) : bytes;
      this.store.transaction(() => {
        this.store.db.run(`INSERT INTO content_lifecycle_repairs(${repairColumns}) VALUES(?,?,?,'cleanup',?,?,?,?,0,0,0,?,?,NULL)`,
          [id, token, this.store.incarnation(), prepared.sha256, prepared.mimeType, sourceEncoding, encoding, bytes.length, data.length]);
        this.store.db.run('UPDATE contents SET encoding=?,byte_length=?,stored_byte_length=?,data=?,chunk_index_json=NULL WHERE id=? AND sha256=? AND mime_type=?',
          [encoding, bytes.length, data.length, data.length ? data : Buffer.alloc(0), id, prepared.sha256, prepared.mimeType]);
        if (this.store.db.getRowsModified() !== 1) throw new Error('prepared_content_collision');
        this.store.db.run('DELETE FROM content_lifecycle_faults WHERE content_id=?', [id]);
      });
    } else {
      const index = preparedChunkCount ? prepared.chunkIndexJson :
        JSON.stringify([{ offset: 0, byteLength: prepared.byteLength, storedOffset: 0, storedByteLength: prepared.data.byteLength, sha256: prepared.sha256, compressed: prepared.encoding.startsWith('gzip:') }]);
      const chunkCount=preparedChunkCount || 1;
      if (!index || index[0] !== '[' || index[index.length - 1] !== ']') throw new Error('prepared_content_invalid');
      const first = Number(this.store.rows('SELECT COALESCE(MAX(ordinal),-1)+1 AS n FROM content_chunks WHERE content_id=?', [id])[0].n);
      if (!Number.isSafeInteger(first + chunkCount)) throw new Error('content_repair_ordinal_exhausted');
      let encoding = sourceEncoding.startsWith('chunked:') ? sourceEncoding : `chunked:${base}`;
      if (this.store.rows('SELECT 1 FROM contents WHERE sha256=? AND mime_type=? AND encoding=? AND id<>?', [prepared.sha256, prepared.mimeType, encoding, id])[0]) encoding = `chunked:repair:${token}:${base}`;
      const manifest = `{"firstOrdinal":${first},"chunks":${index}}`;
      this.store.transaction(() => {
        this.store.db.run(`INSERT INTO content_lifecycle_repairs(${repairColumns}) VALUES(?,?,?,'building',?,?,?,?,?,?,?,?,?,?)`,
          [id, token, this.store.incarnation(), prepared.sha256, prepared.mimeType, sourceEncoding, encoding, first, first, chunkCount, prepared.byteLength, prepared.storedByteLength, manifest]);
        this.store.db.run(`INSERT INTO content_lifecycle_faults VALUES(?,?,?,?) ON CONFLICT(content_id) DO UPDATE SET sha256=excluded.sha256,encoding=excluded.encoding,error=excluded.error`,
          [id, prepared.sha256, sourceEncoding, `content_repair_pending:${base}`]);
      });
      try {
        let writtenBytes = 0;
        for (let offset = 0; offset < chunkCount; offset += 16) {
          assertLive();
          let block: Array<{ordinal: number; data: Uint8Array}>;
          if(preparedChunkCount && 'sourceContentId' in prepared){
            const source=this.store.rows('SELECT sha256,mime_type,byte_length FROM contents WHERE id=?',[prepared.sourceContentId])[0];
            if(!source || source.sha256!==prepared.sha256 || source.mime_type!==prepared.mimeType || Number(source.byte_length)!==prepared.byteLength)throw new Error('prepared_content_collision');
            block=this.store.rows('SELECT ordinal,data FROM content_chunks WHERE content_id=? AND ordinal>=? ORDER BY ordinal LIMIT 16',[prepared.sourceContentId,offset]).map(row=>({ordinal:Number(row.ordinal),data:row.data as Uint8Array}));
          }else block=preparedChunkCount && 'chunks' in prepared?prepared.chunks.slice(offset,offset+16):[{ordinal:0,data:prepared.data}];
          if(block.length!==Math.min(16,chunkCount-offset))throw new Error('prepared_content_invalid');
          let blockBytes = 0;
          this.store.transaction(() => {
            this.assertJob(id, token, 'building');
            for (const [ordinal, chunk] of block.entries()) {
              if (chunk.ordinal !== offset + ordinal || !(chunk.data instanceof Uint8Array) || !chunk.data.byteLength || chunk.data.byteLength > 65536) throw new Error('prepared_content_invalid');
              this.store.db.run('INSERT INTO content_chunks VALUES(?,?,?)', [id, first + offset + ordinal, chunk.data]);
              blockBytes += chunk.data.byteLength;
            }
            this.store.db.run("UPDATE content_lifecycle_repairs SET written_chunks=written_chunks+?,written_bytes=written_bytes+? WHERE content_id=? AND token=? AND phase='building' AND written_chunks=? AND written_bytes=?", [block.length, blockBytes, id, token, offset, writtenBytes]);
            if (this.store.db.getRowsModified() !== 1) throw new Error('content_repair_identity_conflict');
          });
          writtenBytes += blockBytes;
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        assertLive();
        this.store.transaction(() => {
          this.assertJob(id, token, 'building');
          const stored = this.store.rows('SELECT written_chunks,written_bytes FROM content_lifecycle_repairs WHERE content_id=? AND token=?', [id, token])[0];
          if (Number(stored.written_chunks) !== chunkCount || Number(stored.written_bytes) !== prepared.storedByteLength) throw new Error('prepared_content_invalid');
          this.store.db.run('UPDATE contents SET encoding=?,byte_length=?,stored_byte_length=?,data=?,chunk_index_json=? WHERE id=? AND sha256=? AND mime_type=? AND encoding=?',
            [encoding, prepared.byteLength, prepared.storedByteLength, Buffer.alloc(0), manifest, id, prepared.sha256, prepared.mimeType, current.encoding]);
          if (this.store.db.getRowsModified() !== 1) throw new Error('prepared_content_collision');
          this.store.db.run("UPDATE content_lifecycle_repairs SET phase='cleanup' WHERE content_id=? AND token=?", [id, token]);
          this.store.db.run('DELETE FROM content_lifecycle_faults WHERE content_id=?', [id]);
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'content_repair_superseded') throw error;
        await this.store.assertIntegrity(id,assertLive);
      }
    }
    for (;;) {
      assertLive();
      const row = this.record(id);
      if (!row) break;
      const batch = this.prepareRow(row);
      this.commit(batch, id);
      if (!batch.ordinals?.length) break;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    await this.store.assertIntegrity(id,assertLive);
    return id;
  }
  prepare(excludedIds: string[] = []): StorageRepairBatch {
    return this.store.readTransaction(() => {
      const row = this.store.rows(`SELECT ${repairMetadata} FROM content_lifecycle_repairs WHERE content_id NOT IN (SELECT value FROM json_each(?)) ORDER BY content_id LIMIT 1`, [JSON.stringify(excludedIds)])[0];
      return row ? this.prepareRow(row) : { pending: false };
    });
  }
  private prepareRow(row: Row): StorageRepairBatch {
    const batch: StorageRepairBatch = { pending: true, contentId: String(row.content_id), token: String(row.token), phase: String(row.phase), ordinals: [] };
    const candidate = candidateRepairRange(String(row.source_encoding));
    if (candidate) {
      batch.ordinals = this.store.rows(`SELECT ordinal FROM (
        SELECT ordinal FROM content_chunks WHERE content_id=? AND ordinal<?
        UNION ALL SELECT ordinal FROM content_chunks WHERE content_id=? AND ordinal>=?
      ) ORDER BY ordinal LIMIT 64`, [row.content_id, candidate.first, row.content_id, candidate.first + candidate.count]).map(part => Number(part.ordinal));
      return batch;
    }
    if (row.phase === 'superseded') return batch;
    const parameters: SqlValue[] = [row.content_id];
    let where = '';
    if (row.phase === 'building') { where = 'AND ordinal>=?'; parameters.push(row.shadow_floor); }
    else if (Number(row.chunk_count)) {
      batch.ordinals = this.store.rows(`SELECT ordinal FROM (
        SELECT ordinal FROM content_chunks WHERE content_id=? AND ordinal<?
        UNION ALL SELECT ordinal FROM content_chunks WHERE content_id=? AND ordinal>=?
      ) ORDER BY ordinal LIMIT 64`, [row.content_id, row.first_ordinal, row.content_id, Number(row.first_ordinal) + Number(row.chunk_count)]).map(part => Number(part.ordinal));
      return batch;
    }
    batch.ordinals = this.store.rows(`SELECT ordinal FROM content_chunks WHERE content_id=? ${where} ORDER BY ordinal LIMIT 64`, parameters).map(part => Number(part.ordinal));
    return batch;
  }
  commit(batch: StorageRepairBatch, activeId?: string): { applied: boolean; pending: boolean } {
    if (!batch.pending || !batch.contentId) return { applied: false, pending: false };
    if ((batch.ordinals?.length || 0) > 64) throw new Error('database_maintenance_limit_invalid');
    if (this.running.has(batch.contentId) && activeId !== batch.contentId) return { applied: false, pending: true };
    if (!this.store.ownsWriter() && activeId !== batch.contentId) throw new Error('content_repair_recovery_writer_required');
    return this.store.transaction(() => {
      const row = this.record(batch.contentId!);
      if (!row || row.token !== batch.token || row.phase !== batch.phase) return { applied: false, pending: true };
      const candidate = candidateRepairRange(String(row.source_encoding));
      if (candidate || row.phase === 'cleanup') {
        const pointer = this.store.rows(`SELECT 1 FROM contents c JOIN content_lifecycle_repairs r ON r.content_id=c.id
          WHERE c.id=? AND c.sha256=r.sha256 AND c.mime_type=r.mime_type AND c.chunk_index_json IS r.chunk_index_json`, [row.content_id])[0];
        if (!pointer) throw new Error('content_repair_identity_conflict');
      }
      if (candidate || row.phase !== 'superseded') for (const ordinal of batch.ordinals || []) {
        const allowed = candidate ? ordinal < candidate.first || ordinal >= candidate.first + candidate.count
          : row.phase === 'building' ? ordinal >= Number(row.shadow_floor) : !Number(row.chunk_count) || ordinal < Number(row.first_ordinal) || ordinal >= Number(row.first_ordinal) + Number(row.chunk_count);
        if (!Number.isSafeInteger(ordinal) || !allowed) throw new Error('content_repair_identity_conflict');
        this.store.db.run('DELETE FROM content_chunks WHERE content_id=? AND ordinal=?', [row.content_id, ordinal]);
      }
      if (!batch.ordinals?.length) {
        if (candidate) this.store.db.run('DELETE FROM content_lifecycle_faults WHERE content_id=? AND sha256=?', [row.content_id, row.sha256]);
        else if (row.phase === 'building') this.store.db.run("UPDATE content_lifecycle_faults SET error='content_integrity_error' WHERE content_id=? AND sha256=?", [row.content_id, row.sha256]);
        this.store.db.run('DELETE FROM content_lifecycle_repairs WHERE content_id=? AND token=?', [row.content_id, row.token]);
      }
      return { applied: true, pending: Boolean(batch.ordinals?.length) };
    });
  }
}
