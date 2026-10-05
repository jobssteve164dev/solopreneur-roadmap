import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AsyncLocalStorage } from 'async_hooks';
import { gzipSync, gunzipSync } from 'zlib';
import { DiskDatabase, SqlValue } from './diskDatabase';
import { entityDefinitions, unifiedSchemaSql } from './unifiedSchema';
import { indexTokens, queryTokens } from './searchIndex';

export interface DataWrite {
  kind: string;
  action: 'create' | 'patch' | 'archive';
  scope: string | null;
  objectId?: string;
  expectedRevision?: number;
  idempotencyKey: string;
  data: Record<string, unknown>;
}
export interface DataObject {
  objectId: string;
  kind: string;
  projectId: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  data: Record<string, unknown>;
  relations: Array<{ relation: string; target: string }>;
}
export interface WriteReceipt {
  requestId: string;
  objectId: string;
  revision: number;
  committedSequence: number;
  status: 'committed';
  pendingEffects: string[];
}
interface ImportedSource { identity: string; key: string; hash: string }
interface ContentChunk { offset: number; byteLength: number; storedOffset: number; storedByteLength: number; sha256: string; compressed: boolean }
export interface ContentPage {
  object: DataObject;
  revision: number;
  field: string;
  encoding: 'base64';
  data: string;
  byteOffset: number;
  byteLength: number;
  totalBytes: number;
  sha256: string;
  mimeType: string;
  cursor: string | null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('invalid_data: undefined is not a persisted value');
  return encoded;
}
function digest(data: Uint8Array | string): string { return crypto.createHash('sha256').update(data).digest('hex'); }

/** Authoritative domain operations. Only Runtime exposes this owner to other processes. */
export class UnifiedDataStore {
  public static open(root: string, expectedDatabaseId?: string): UnifiedDataStore {
    if (!fs.existsSync(path.join(root, 'solomap.db'))) throw new Error('database_restore_required');
    const store = new UnifiedDataStore(root);
    if (expectedDatabaseId && store.rows("SELECT value FROM database_meta WHERE key='database_id'")[0]?.value !== expectedDatabaseId) {
      store.close();
      throw new Error('database_identity_mismatch');
    }
    return store;
  }
  private readonly db: DiskDatabase;
  private readonly columns = new Map<string, Set<string>>();
  private readonly deviceId: string;
  private readonly ownerActorId: string;
  private readonly actorContext = new AsyncLocalStorage<string>();
  private get actorId(): string { return this.actorContext.getStore() || this.ownerActorId; }
  public readonly filePath: string;
  constructor(public readonly root: string, actorId = 'local-runtime') {
    this.ownerActorId = actorId;
    this.filePath = path.join(root, 'solomap.db');
    const existed = fs.existsSync(this.filePath);
    this.db = new DiskDatabase(this.filePath);
    try {
      if (!existed) fs.chmodSync(this.filePath, 0o600);
      const sql = unifiedSchemaSql();
      this.transaction(() => {
        const existing = this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'");
        if (!existing.length) {
          if (existed || this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").length) throw new Error('unrecognized_database');
          this.db.run(sql);
          this.db.run('INSERT INTO schema_migrations VALUES(1,?,?)', [digest(sql), Date.now()]);
          this.db.run('INSERT INTO database_meta VALUES(?,?)', ['database_id', crypto.randomUUID()]);
          this.db.run('INSERT INTO database_meta VALUES(?,?)', ['protocol_version', '1']);
        } else if (this.rows('SELECT checksum FROM schema_migrations WHERE version=1')[0]?.checksum !== digest(sql)) {
          throw new Error('schema_checksum_mismatch');
        }
        this.db.run('INSERT OR IGNORE INTO actors(id,kind,provider) VALUES(?,?,?)', [actorId, 'runtime', 'solomap']);
      });
      for (const definition of Object.values(entityDefinitions)) {
        this.columns.set(definition.table, new Set(this.rows(`PRAGMA table_info(${definition.table})`).map(row => String(row.name)).filter(name => !['id', 'object_kind', 'project_id'].includes(name))));
      }
      const environment = canonical({ schemaVersion: 1, platform: process.platform, hostname: os.hostname(), user: os.userInfo().username });
      const device = this.rows('SELECT id FROM devices WHERE environment=?', [environment])[0];
      this.deviceId = device ? String(device.id) : crypto.randomUUID();
      if (!device) this.db.run('INSERT INTO devices VALUES(?,?,?,NULL,?)', [this.deviceId, os.hostname(), environment, Date.now()]);
    } catch (error) { this.db.close(); throw error; }
  }
  public withActor<T>(actorId: string, action: () => T): T {
    if (!this.rows('SELECT id FROM actors WHERE id=?', [actorId]).length) throw new Error('actor_missing');
    return this.actorContext.run(actorId, action);
  }
  public authorizeMcpAction(actorId: string, projectId: string, action: string): void {
    const actor = this.rows('SELECT COALESCE(authority_id,id) AS authority,identity_ref,kind FROM actors WHERE id=?', [actorId])[0];
    if (!actor || (actor.kind === 'mcp' && !actor.identity_ref)) throw new Error('action_denied');
    const grants = this.rows("SELECT action_set_json FROM grants JOIN objects ON objects.id=grants.id WHERE actor_id=? AND target_id=? AND status='active' AND objects.archived_at IS NULL AND (valid_until IS NULL OR valid_until>?)", [actor.authority, projectId, Date.now()]);
    if (!grants.some(grant => {
      const value = JSON.parse(String(grant.action_set_json)) as { schemaVersion: number; actions: string[] };
      return value.schemaVersion === 1 && Array.isArray(value.actions) && value.actions.includes(action);
    })) throw new Error('action_denied');
  }
  public closeMcpActor(actorId: string, projectId: string): void {
    this.db.run("UPDATE actors SET identity_ref=NULL WHERE id=? AND kind='mcp' AND authority_id IN (SELECT actor_id FROM grants WHERE target_id=?)", [actorId, projectId]);
  }
  public establishMcpActor(projectId: string, resume?: { actorId: string; proof: string }): { actorId: string; proof: string; authorityActorId: string } {
    if (this.current(projectId).kind !== 'project') throw new Error('project_identity_invalid');
    const authorityActorId = `solomap-stdio:${projectId}`;
    if (resume) {
      const actor = this.rows('SELECT identity_ref,authority_id FROM actors WHERE id=? AND kind=?', [resume.actorId, 'mcp'])[0];
      const grant = this.rows("SELECT grants.id FROM grants JOIN objects ON objects.id=grants.id WHERE actor_id=? AND target_id=? AND status='active' AND objects.archived_at IS NULL AND (valid_until IS NULL OR valid_until>?)", [authorityActorId, projectId, Date.now()])[0];
      if (!actor || !grant || actor.authority_id !== authorityActorId || actor.identity_ref !== digest(resume.proof)) throw new Error('actor_resume_denied');
      return { ...resume, authorityActorId };
    }
    // The authenticated host provisions this connector once. Sessions never reset its grant.
    if (!this.rows('SELECT id FROM actors WHERE id=?', [authorityActorId]).length) {
      const grantId = crypto.randomUUID();
      this.recordMutation({ operation: 'mcp_grant', authorityActorId, projectId }, `mcp-grant:${authorityActorId}`, 'grant', () => {
        const time = Date.now();
        this.db.run('INSERT INTO actors(id,kind,provider,identity_ref) VALUES(?,?,?,?)', [authorityActorId, 'mcp_principal', 'solomap-stdio', projectId]);
        this.db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [grantId, 'grant', projectId, 1, time, time]);
        this.db.run('INSERT INTO grants(id,project_id,actor_id,target_id,action_set_json,revision,status) VALUES(?,?,?,?,?,?,?)', [grantId, projectId, authorityActorId, projectId, canonical({ schemaVersion: 1, actions: ['search', 'read', 'write', 'link', 'context', 'export'] }), 1, 'active']);
        return this.current(grantId);
      });
    }
    if (!this.rows("SELECT grants.id FROM grants JOIN objects ON objects.id=grants.id WHERE actor_id=? AND target_id=? AND status='active' AND objects.archived_at IS NULL AND (valid_until IS NULL OR valid_until>?)", [authorityActorId, projectId, Date.now()]).length) throw new Error('action_denied');
    const actorId = crypto.randomUUID();
    const proof = crypto.randomBytes(32).toString('hex');
    this.db.run('INSERT INTO actors(id,kind,provider,identity_ref,authority_id) VALUES(?,?,?,?,?)', [actorId, 'mcp', 'solomap-stdio', digest(proof), authorityActorId]);
    return { actorId, proof, authorityActorId };
  }

  private rows(sql: string, values: SqlValue[] = []): Record<string, SqlValue>[] {
    const statement = this.db.prepare(sql);
    const result: Record<string, SqlValue>[] = [];
    try {
      statement.bind(values);
      while (statement.step()) result.push(statement.getAsObject());
    } finally { statement.free(); }
    return result;
  }
  private transaction<T>(operation: () => T): T {
    this.db.run('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.run('COMMIT');
      return result;
    } catch (error) { this.db.run('ROLLBACK'); throw error; }
  }
  private putContent(data: Uint8Array | string, mimeType = 'text/plain', encoding = 'utf8'): string {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const hash = digest(bytes);
    const existing = this.rows('SELECT id FROM contents WHERE sha256=? AND mime_type=? AND encoding IN (?,?,?)', [hash, mimeType, encoding, `gzip:${encoding}`, `chunked:${encoding}`])[0];
    if (existing) {
      this.content(String(existing.id));
      return String(existing.id);
    }
    let stored: Buffer;
    let storedEncoding: string;
    let chunkIndex: string | null = null;
    let chunkParts: Buffer[] | undefined;
    let storedLength: number;
    if (bytes.length > 65536) {
      const chunks: ContentChunk[] = [];
      const parts: Buffer[] = [];
      let storedOffset = 0;
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        const part = bytes.subarray(offset, offset + 65536);
        const compressed = gzipSync(part, { level: 1 });
        const encoded = compressed.length < part.length * 0.9 ? compressed : part;
        chunks.push({ offset, byteLength: part.length, storedOffset, storedByteLength: encoded.length, sha256: digest(part), compressed: encoded === compressed });
        parts.push(encoded);
        storedOffset += encoded.length;
      }
      chunkParts = parts;
      stored = Buffer.alloc(0);
      storedLength = storedOffset;
      storedEncoding = `chunked:${encoding}`;
      chunkIndex = canonical(chunks);
    } else {
      const compressed = bytes.length >= 16384 ? gzipSync(bytes, { level: 1 }) : bytes;
      stored = compressed.length < bytes.length * 0.9 ? compressed : bytes;
      storedEncoding = stored === bytes ? encoding : `gzip:${encoding}`;
      storedLength = stored.length;
    }
    const id = crypto.randomUUID();
    this.db.run('INSERT INTO contents VALUES(?,?,?,?,?,?,?,?)', [id, hash, mimeType, storedEncoding, bytes.length, storedLength, stored, chunkIndex]);
    chunkParts?.forEach((part, ordinal) => this.db.run('INSERT INTO content_chunks VALUES(?,?,?)', [id, ordinal, part]));
    return id;
  }
  private content(id: string): Buffer {
    const row = this.rows('SELECT sha256,byte_length,stored_byte_length,encoding,chunk_index_json FROM contents WHERE id=?', [id])[0];
    if (!row) throw new Error('content_missing');
    const bytes = this.contentRange(id, row, 0, Number(row.byte_length));
    if (bytes.length !== row.byte_length || digest(bytes) !== row.sha256) throw new Error('content_integrity_error');
    return bytes;
  }
  private contentRange(id: string, metadata: Record<string, SqlValue>, offset: number, end: number): Buffer {
    if (!String(metadata.encoding).startsWith('chunked:')) {
      const row = this.rows('SELECT data FROM contents WHERE id=?', [id])[0];
      const stored = Buffer.from(row.data as Uint8Array);
      if (stored.length !== metadata.stored_byte_length) throw new Error('content_integrity_error');
      let bytes: Buffer;
      try { bytes = String(metadata.encoding).startsWith('gzip:') ? gunzipSync(stored, { maxOutputLength: Number(metadata.byte_length) }) : stored; }
      catch { throw new Error('content_integrity_error'); }
      if (bytes.length !== metadata.byte_length || digest(bytes) !== metadata.sha256) throw new Error('content_integrity_error');
      return bytes.subarray(offset, end);
    }
    let chunks: ContentChunk[];
    try { chunks = JSON.parse(String(metadata.chunk_index_json)); } catch { throw new Error('content_integrity_error'); }
    if (!Array.isArray(chunks) || !chunks.length) throw new Error('content_integrity_error');
    let rawOffset = 0;
    let storedOffset = 0;
    const parts: Buffer[] = [];
    for (const [ordinal, chunk] of chunks.entries()) {
      if (chunk.offset !== rawOffset || chunk.storedOffset !== storedOffset || !Number.isInteger(chunk.byteLength) || chunk.byteLength < 1 || chunk.byteLength > 65536 || !Number.isInteger(chunk.storedByteLength) || chunk.storedByteLength < 1 || chunk.storedByteLength > 65536 || !/^[a-f0-9]{64}$/.test(chunk.sha256) || typeof chunk.compressed !== 'boolean') throw new Error('content_integrity_error');
      rawOffset += chunk.byteLength;
      storedOffset += chunk.storedByteLength;
      if (chunk.offset >= end || rawOffset <= offset) continue;
      const row = this.rows('SELECT data FROM content_chunks WHERE content_id=? AND ordinal=?', [id, ordinal])[0];
      if (!row) throw new Error('content_integrity_error');
      const stored = Buffer.from(row.data as Uint8Array);
      if (stored.length !== chunk.storedByteLength) throw new Error('content_integrity_error');
      let bytes: Buffer;
      try { bytes = chunk.compressed ? gunzipSync(stored, { maxOutputLength: chunk.byteLength }) : stored; }
      catch { throw new Error('content_integrity_error'); }
      if (bytes.length !== chunk.byteLength || digest(bytes) !== chunk.sha256) throw new Error('content_integrity_error');
      parts.push(bytes.subarray(Math.max(0, offset - chunk.offset), Math.min(bytes.length, end - chunk.offset)));
    }
    if (rawOffset !== metadata.byte_length || storedOffset !== metadata.stored_byte_length) throw new Error('content_integrity_error');
    return Buffer.concat(parts);
  }
  private decodedContent(id: string): unknown {
    const row = this.rows('SELECT encoding,mime_type FROM contents WHERE id=?', [id])[0];
    const bytes = this.content(id);
    return String(row.encoding).endsWith('binary') ? { encoding: 'base64', data: bytes.toString('base64'), mimeType: String(row.mime_type) } : bytes.toString('utf8');
  }
  private definition(kind: string): typeof entityDefinitions[string] {
    if (!Object.prototype.hasOwnProperty.call(entityDefinitions, kind)) throw new Error('unknown_kind');
    return entityDefinitions[kind];
  }
  private normalizeData(kind: string, input: Record<string, unknown>): Record<string, SqlValue> {
    const definition = this.definition(kind);
    const allowed = this.columns.get(definition.table)!;
    const result: Record<string, SqlValue> = {};
    for (const [inputKey, value] of Object.entries(input)) {
      const key = inputKey === 'content' ? 'content_id' : (inputKey.endsWith('_content') ? `${inputKey}_id` : inputKey);
      if (!allowed.has(key)) throw new Error(`invalid_field: ${kind}.${inputKey}`);
      if (key !== inputKey) {
        const binary = value as { encoding?: string; data?: string; mimeType?: string } | null;
        if (binary && binary.encoding === 'base64') {
          if (typeof binary.data !== 'string') throw new Error('invalid_binary_content');
          const bytes = Buffer.from(binary.data, 'base64');
          if (bytes.toString('base64') !== binary.data) throw new Error('invalid_binary_content');
          result[key] = this.putContent(bytes, binary.mimeType || 'application/octet-stream', 'binary');
        } else result[key] = value === null ? null : this.putContent(typeof value === 'string' ? value : canonical(value), typeof value === 'string' ? 'text/plain' : 'application/json');
      } else if (typeof value === 'boolean') result[key] = value ? 1 : 0;
      else if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) result[key] = value;
      else if (key.endsWith('_json')) result[key] = canonical(value);
      else throw new Error(`invalid_value: ${kind}.${inputKey}`);
    }
    return result;
  }
  private current(id: string, full = true): DataObject {
    const object = this.rows('SELECT * FROM objects WHERE id=?', [id])[0];
    if (!object) throw new Error('object_missing');
    const definition = this.definition(String(object.kind));
    const row = this.rows(`SELECT * FROM ${definition.table} WHERE id=?`, [id])[0];
    if (!row) throw new Error('entity_missing');
    const data: Record<string, unknown> = {};
    for (const key of this.columns.get(definition.table)!) {
      const value = row[key];
      if (key.endsWith('_content_id') || key === 'content_id') {
        data[key] = value;
        if (value && full) data[key === 'content_id' ? 'content' : key.slice(0, -3)] = this.decodedContent(String(value));
      } else data[key] = value;
    }
    const relations = this.rows('SELECT relation,target_id FROM relations WHERE source_id=? ORDER BY relation,target_id', [id]).map(row => ({ relation: String(row.relation), target: String(row.target_id) }));
    return { objectId: id, kind: String(object.kind), projectId: object.project_id === null ? null : String(object.project_id), revision: Number(object.revision), createdAt: Number(object.created_at), updatedAt: Number(object.updated_at), archivedAt: object.archived_at === null ? null : Number(object.archived_at), data, relations };
  }
  public read(ref: string, revision?: number): DataObject {
    const object = this.readMetadata(ref, revision);
    for (const [key, value] of Object.entries(object.data)) {
      if (value && (key.endsWith('_content_id') || key === 'content_id')) object.data[key === 'content_id' ? 'content' : key.slice(0, -3)] = this.decodedContent(String(value));
    }
    return object;
  }
  public readMetadata(ref: string, revision?: number): DataObject {
    const current = this.current(ref, false);
    if (revision === undefined || revision === current.revision) return current;
    const row = this.rows('SELECT content_id FROM object_revisions WHERE object_id=? AND revision=?', [ref, revision])[0];
    if (!row) throw new Error('revision_missing');
    return JSON.parse(this.content(String(row.content_id)).toString('utf8')) as DataObject;
  }
  public readPage(input: { ref: string; revision?: number; field?: string; cursor?: string; limit?: number }): ContentPage {
    const limit = input.limit ?? 65536;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1048576) throw new Error('invalid_page_limit');
    const cursor = input.cursor ? JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as { ref: string; revision: number; field: string; offset: number; contentId: string } : undefined;
    const field = input.field ?? cursor?.field ?? 'content';
    if (cursor && (cursor.ref !== input.ref || cursor.field !== field || (input.revision !== undefined && input.revision !== cursor.revision))) throw new Error('cursor_scope_mismatch');
    const object = this.readMetadata(input.ref, cursor?.revision ?? input.revision);
    const contentId = object.data[field + '_id'];
    if (typeof contentId !== 'string' || (field !== 'content' && !field.endsWith('_content'))) throw new Error('content_field_missing');
    if (cursor && cursor.contentId !== contentId) throw new Error('cursor_content_mismatch');
    const metadata = this.rows('SELECT sha256,mime_type,byte_length,stored_byte_length,encoding,chunk_index_json FROM contents WHERE id=?', [contentId])[0];
    if (!metadata) throw new Error('content_missing');
    const totalBytes = Number(metadata.byte_length);
    const offset = cursor?.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > totalBytes) throw new Error('invalid_page_offset');
    const end = Math.min(totalBytes, offset + limit);
    const bytes = this.contentRange(contentId, metadata, offset, end);
    return { object, revision: object.revision, field, encoding: 'base64', data: bytes.toString('base64'), byteOffset: offset, byteLength: end - offset, totalBytes, sha256: String(metadata.sha256), mimeType: String(metadata.mime_type), cursor: end < totalBytes ? Buffer.from(canonical({ ref: input.ref, revision: object.revision, field, offset: end, contentId })).toString('base64url') : null };
  }
  private snapshot(object: DataObject): string {
    const data = { ...object.data };
    for (const key of Object.keys(data)) {
      if (key.endsWith('_content_id') || key === 'content_id') delete data[key === 'content_id' ? 'content' : key.slice(0, -3)];
    }
    return canonical({ ...object, data });
  }
  private checkReferences(projectId: string | null, data: Record<string, SqlValue>): void {
    for (const [key, value] of Object.entries(data)) {
      if (!value || !key.endsWith('_id') || key.endsWith('content_id') || key.endsWith('actor_id') || key === 'device_id') continue;
      const referenced = this.rows('SELECT project_id FROM objects WHERE id=?', [value])[0];
      if (referenced?.project_id !== null && referenced?.project_id !== undefined && referenced.project_id !== projectId) throw new Error('scope_mismatch');
    }
  }
  public write(input: DataWrite): WriteReceipt {
    return this.writeMutation(input);
  }
  public captureMigrationSource(source: ImportedSource, bytes: Uint8Array, options: { mimeType?: string; encoding?: string; error?: string } = {}): { unchanged: boolean; requestId: string; committedSequence: number } {
    if (!source.identity || !source.key || source.hash !== digest(bytes)) throw new Error('migration_source_invalid');
    return this.transaction(() => {
      const previous = this.rows('SELECT migration_items.*,contents.sha256 AS captured_hash FROM migration_items LEFT JOIN contents ON contents.id=migration_items.source_content_id WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
      const revision = Number(previous?.source_capture_revision || 0);
      const classificationChanged = options.error ? previous?.stage !== 'unmapped' || previous.error !== options.error : previous?.stage === 'unmapped';
      if (previous?.captured_hash === source.hash && !classificationChanged) {
        this.content(String(previous.source_content_id));
        const request = this.rows('SELECT id,committed_sequence FROM requests WHERE id=?', [previous.source_capture_request_id])[0];
        if (!request) throw new Error('migration_capture_receipt_missing');
        return { unchanged: true, requestId: String(request.id), committedSequence: Number(request.committed_sequence) };
      }
      const contentId = this.putContent(bytes, options.mimeType || 'application/octet-stream', options.encoding || 'binary');
      const stage = options.error ? 'unmapped' : 'captured';
      const descriptor = canonical({ source, contentId, revision: revision + 1, stage, error: options.error || null });
      const requestId = crypto.randomUUID();
      const nextKey = `migration-capture:${canonical([source.identity, source.key])}:${revision + 1}`;
      this.db.run('INSERT INTO requests(actor_id,idempotency_key,id,input_hash,status) VALUES(?,?,?,?,?)', [this.actorId, nextKey, requestId, digest(descriptor), 'pending']);
      this.db.run('INSERT INTO migration_items(source_identity,source_key,source_hash,stage,error,source_content_id,source_capture_revision,source_capture_request_id) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_identity,source_key) DO UPDATE SET source_content_id=excluded.source_content_id,source_capture_revision=excluded.source_capture_revision,source_capture_request_id=excluded.source_capture_request_id,stage=excluded.stage,error=excluded.error', [source.identity, source.key, source.hash, stage, options.error || null, contentId, revision + 1, requestId]);
      const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM events')[0].next);
      const eventContent = this.putContent(descriptor, 'application/json');
      this.db.run('INSERT INTO events VALUES(?,?,NULL,?,?,?,?,?)', [crypto.randomUUID(), sequence, this.actorId, 'migration.source_captured', eventContent, Date.now(), requestId]);
      const resultContent = this.putContent(canonical({ requestId, committedSequence: sequence }), 'application/json');
      this.db.run("UPDATE requests SET status='committed',result_content_id=?,committed_sequence=? WHERE id=?", [resultContent, sequence, requestId]);
      return { unchanged: false, requestId, committedSequence: sequence };
    });
  }
  public readMigrationSource(identity: string, key: string): { bytes: Buffer; hash: string; sourceRevision: number; stage: string } {
    const item = this.rows('SELECT migration_items.*,contents.sha256 AS captured_hash FROM migration_items JOIN contents ON contents.id=migration_items.source_content_id WHERE source_identity=? AND source_key=?', [identity, key])[0];
    if (!item) throw new Error('migration_source_missing');
    return { bytes: this.content(String(item.source_content_id)), hash: String(item.captured_hash), sourceRevision: Number(item.source_capture_revision), stage: String(item.stage) };
  }
  public importObject(input: DataWrite, source: ImportedSource): { receipt?: WriteReceipt; unchanged: boolean } {
    if (!source.identity || !source.key || !/^[a-f0-9]{64}$/.test(source.hash)) throw new Error('migration_source_invalid');
    const previous = this.rows('SELECT * FROM migration_items WHERE source_identity=? AND source_key=?', [source.identity, source.key])[0];
    const bound = previous?.object_id ? this.current(String(previous.object_id), false) : undefined;
    if (bound && (bound.kind !== input.kind || bound.projectId !== input.scope)) {
      this.db.run("UPDATE migration_items SET stage='conflict',error='source_binding_mismatch' WHERE source_identity=? AND source_key=?", [source.identity, source.key]);
      throw new Error('migration_conflict: source_binding_mismatch');
    }
    if (previous?.object_id && previous.source_hash === source.hash) {
      this.db.run("UPDATE migration_items SET stage='imported',error=NULL WHERE source_identity=? AND source_key=?", [source.identity, source.key]);
      return { unchanged: true };
    }
    if (previous?.object_id) {
      const current = bound!;
      if (current.revision !== previous.imported_revision || current.kind !== input.kind || current.projectId !== input.scope) {
        this.db.run("UPDATE migration_items SET stage='conflict',error='newer_database_revision' WHERE source_identity=? AND source_key=?", [source.identity, source.key]);
        throw new Error('migration_conflict: newer_database_revision');
      }
      input = { ...input, action: 'patch', objectId: current.objectId, expectedRevision: current.revision, idempotencyKey: `${input.idempotencyKey}:after:${current.revision}` };
    }
    return { receipt: this.writeMutation(input, source), unchanged: false };
  }
  private writeMutation(input: DataWrite, source?: ImportedSource): WriteReceipt {
    const definition = this.definition(input.kind);
    if (!['create', 'patch', 'archive'].includes(input.action)) throw new Error('unknown_action');
    if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) throw new Error('idempotency_key_required');
    if (input.scope !== null && typeof input.scope !== 'string') throw new Error('scope_required');
    if (definition.project && !input.scope) throw new Error('project_scope_required');
    if (input.kind === 'project' && input.scope !== null) throw new Error('project_is_global');
    return this.recordMutation(source ? { input, source } : input, input.idempotencyKey, input.action, () => {
      const id = input.action === 'create' ? crypto.randomUUID() : input.objectId;
      if (!id) throw new Error('object_id_required');
      const time = Date.now();
      const data = this.normalizeData(input.kind, input.data);
      if (input.kind === 'evidence' && this.rows("SELECT id FROM actors WHERE id=? AND kind='mcp'", [this.actorId]).length) {
        if (data.type !== 'agent_claim' || input.action !== 'create') throw new Error('host_observation_requires_authorization');
        data.source_actor_id = this.actorId;
        data.observed_at = time;
      }
      this.checkReferences(input.scope, data);
      const keys = Object.keys(data);
      if (input.action === 'create') {
        this.db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [id, input.kind, input.scope, 1, time, time]);
        this.db.run(`INSERT INTO ${definition.table}(id,project_id${keys.length ? ',' + keys.join(',') : ''}) VALUES(?,?${keys.map(() => ',?').join('')})`, [id, input.scope, ...keys.map(key => data[key])]);
      } else {
        const object = this.current(id);
        if (object.kind !== input.kind || object.projectId !== input.scope) throw new Error('scope_mismatch');
        if (!Number.isInteger(input.expectedRevision) || object.revision !== input.expectedRevision) throw new Error('revision_conflict');
        if (keys.length) this.db.run(`UPDATE ${definition.table} SET ${keys.map(key => key + '=?').join(',')} WHERE id=?`, [...keys.map(key => data[key]), id]);
        this.db.run('UPDATE objects SET revision=revision+1,updated_at=?,archived_at=? WHERE id=? AND revision=?', [time, input.action === 'archive' ? time : object.archivedAt, id, input.expectedRevision!]);
      }
      return this.current(id);
    }, source ? (_eventId, object) => {
      this.db.run("INSERT INTO migration_items(source_identity,source_key,source_hash,object_id,imported_revision,stage,error) VALUES(?,?,?,?,?,'imported',NULL) ON CONFLICT(source_identity,source_key) DO UPDATE SET source_hash=excluded.source_hash,object_id=excluded.object_id,imported_revision=excluded.imported_revision,stage='imported',error=NULL", [source.identity, source.key, source.hash, object.objectId, object.revision]);
    } : undefined);
  }
  private recordMutation(input: unknown, idempotencyKey: string, reason: string, mutation: () => DataObject, enqueue?: (eventId: string, object: DataObject) => void): WriteReceipt {
    if (!idempotencyKey.trim()) throw new Error('idempotency_key_required');
    const inputHash = digest(canonical(input));
    return this.transaction(() => {
      const previous = this.rows('SELECT * FROM requests WHERE actor_id=? AND idempotency_key=?', [this.actorId, idempotencyKey])[0];
      if (previous) {
        if (previous.input_hash !== inputHash) throw new Error('idempotency_conflict');
        return JSON.parse(this.content(String(previous.result_content_id)).toString('utf8')) as WriteReceipt;
      }
      const requestId = crypto.randomUUID();
      this.db.run('INSERT INTO requests(actor_id,idempotency_key,id,input_hash,status) VALUES(?,?,?,?,?)', [this.actorId, idempotencyKey, requestId, inputHash, 'pending']);
      const object = mutation();
      const id = object.objectId;
      const rowid = this.rows('SELECT rowid FROM objects WHERE id=?', [id])[0].rowid;
      this.db.run('INSERT OR REPLACE INTO object_search(rowid,terms) VALUES(?,?)', [rowid, indexTokens(canonical(object.data))]);
      const time = Date.now();
      const snapshotId = this.putContent(this.snapshot(object), 'application/json');
      this.db.run('INSERT INTO object_revisions VALUES(?,?,?,?,?,?)', [id, object.revision, snapshotId, this.actorId, reason, time]);
      const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM events')[0].next);
      const eventId = crypto.randomUUID();
      this.db.run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)', [eventId, sequence, id, this.actorId, `${object.kind}.${reason}`, snapshotId, time, requestId]);
      enqueue?.(eventId, object);
      const pendingEffects = this.rows("SELECT id FROM outbox WHERE event_id=? AND state<>'delivered'", [eventId]).map(row => String(row.id));
      const receipt: WriteReceipt = { requestId, objectId: id, revision: object.revision, committedSequence: sequence, status: 'committed', pendingEffects };
      const resultId = this.putContent(canonical(receipt), 'application/json');
      this.db.run('UPDATE requests SET status=?,result_content_id=?,committed_sequence=? WHERE id=?', ['committed', resultId, sequence, requestId]);
      return receipt;
    });
  }
  public async registerProject(input: { root: string; name?: string }): Promise<{ projectId: string; locationId: string; identityPath: string }> {
    if (!input.root || !fs.statSync(input.root).isDirectory()) throw new Error('project_root_required');
    const root = fs.realpathSync(input.root);
    const identityPath = path.join(root, '.solopreneur', 'project.json');
    let identityId: string | undefined;
    try {
      const value = JSON.parse(await fs.promises.readFile(identityPath, 'utf8')) as { schemaVersion: number; projectId: string };
      if (value.schemaVersion !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.projectId)) throw new Error('project_identity_invalid');
      identityId = value.projectId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`project_identity_invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    const location = this.rows("SELECT * FROM project_locations WHERE device_id=? AND root_path=? AND status='active'", [this.deviceId, root])[0];
    if (identityId && location && identityId !== location.project_id) throw new Error('project_identity_conflict');
    const projectId = identityId || (location ? String(location.project_id) : crypto.randomUUID());
    const registrationKey = `project-location:${this.deviceId}:${root}:${projectId}`;
    const identityBody = JSON.stringify({ schemaVersion: 1, projectId }) + '\n';
    const receipt = this.recordMutation({ operation: 'register_project', root, projectId }, registrationKey, 'register', () => {
      const existing = this.rows('SELECT * FROM objects WHERE id=?', [projectId])[0];
      const time = Date.now();
      if (existing) {
        if (existing.kind !== 'project') throw new Error('project_identity_conflict');
        this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [time, projectId]);
      } else {
        this.db.run('INSERT INTO objects VALUES(?,?,NULL,?,?,?,NULL)', [projectId, 'project', 1, time, time]);
        this.db.run('INSERT INTO projects(id,name) VALUES(?,?)', [projectId, input.name || path.basename(root)]);
      }
      if (!location) this.db.run('INSERT INTO project_locations VALUES(?,?,?,?,?)', [crypto.randomUUID(), projectId, this.deviceId, root, 'active']);
      return this.current(projectId);
    }, (eventId) => {
      this.db.run('INSERT INTO outbox VALUES(?,?,?,?,?,?,?,0,NULL)', [crypto.randomUUID(), eventId, 'project_identity', identityPath, this.putContent(identityBody, 'application/json'), 1, 'pending']);
    });
    await fs.promises.mkdir(path.dirname(identityPath), { recursive: true });
    try { await fs.promises.writeFile(identityPath, identityBody, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = JSON.parse(await fs.promises.readFile(identityPath, 'utf8')) as { schemaVersion: number; projectId: string };
      if (current.schemaVersion !== 1 || current.projectId !== projectId) throw new Error('project_identity_conflict');
    }
    this.db.run("UPDATE outbox SET state='delivered',attempt=attempt+1 WHERE event_id IN (SELECT id FROM events WHERE request_id=?)", [receipt.requestId]);
    const saved = this.rows("SELECT id FROM project_locations WHERE project_id=? AND device_id=? AND root_path=? AND status='active'", [projectId, this.deviceId, root])[0];
    return { projectId, locationId: String(saved.id), identityPath };
  }
  public link(input: { source: string; relation: string; target: string; expectedRevision: number; idempotencyKey: string }): WriteReceipt {
    const allowed = ['parent', 'source', 'evidence', 'depends_on', 'adopts', 'supersedes', 'feedback'];
    if (!allowed.includes(input.relation)) throw new Error('unknown_relation');
    return this.recordMutation(input, input.idempotencyKey, 'link', () => {
      const source = this.current(input.source);
      const target = this.current(input.target);
      if (source.revision !== input.expectedRevision) throw new Error('revision_conflict');
      if (source.objectId === target.objectId) throw new Error('self_relation');
      if (source.projectId !== target.projectId && target.projectId !== null) throw new Error('scope_mismatch');
      if (input.relation === 'depends_on' && (source.kind !== 'roadmap_node' || target.kind !== 'roadmap_node')) throw new Error('relation_kind_mismatch');
      if (input.relation === 'parent' && (source.kind !== 'conversation' || target.kind !== 'conversation')) throw new Error('relation_kind_mismatch');
      if (input.relation === 'evidence' && target.kind !== 'evidence') throw new Error('relation_kind_mismatch');
      this.db.run('INSERT OR IGNORE INTO relations VALUES(?,?,?)', [input.source, input.relation, input.target]);
      this.db.run('UPDATE objects SET revision=revision+1,updated_at=? WHERE id=?', [Date.now(), source.objectId]);
      return this.current(source.objectId);
    });
  }
  public context(input: { project: string; query?: string; categories?: string[]; budget?: number }, canRead: (object: DataObject) => boolean = () => true): { items: DataObject[]; sourceSequence: number; remaining: boolean } {
    const budget = input.budget === undefined ? 16000 : input.budget;
    if (!Number.isInteger(budget) || budget < 1) throw new Error('invalid_budget');
    const eligible = (item: DataObject): boolean => canRead(item) && (!input.categories || input.categories.includes(String(item.data.category))) && item.data.status !== 'rejected' && item.archivedAt === null;
    const result = this.search({ scope: input.project, query: input.query, kinds: ['memory', 'lesson', 'policy'], limit: 500 }, eligible);
    const global = this.search({ scope: null, query: input.query, kinds: ['memory', 'lesson', 'policy'], limit: 500 }, eligible);
    const candidates = [...result.items, ...global.items];
    const items: DataObject[] = [];
    let size = 0;
    for (const metadata of candidates) {
      const item = this.read(metadata.objectId);
      const length = canonical(item).length;
      if (size + length > budget) continue;
      items.push(item);
      size += length;
    }
    return { items, sourceSequence: Math.max(result.sourceSequence, global.sourceSequence), remaining: items.length !== candidates.length || result.cursor !== null || global.cursor !== null };
  }
  public async export(input: { ref: string; format: 'json' | 'md' | 'text'; destination: string; idempotencyKey: string }): Promise<{ destination: string; sha256: string; revision: number }> {
    if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) throw new Error('idempotency_key_required');
    if (!['json', 'md', 'text'].includes(input.format)) throw new Error('unknown_export_format');
    const destination = path.resolve(input.destination);
    const exportRoot = path.resolve(this.root, 'exports');
    const relative = path.relative(exportRoot, destination);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('export_destination_outside_exports');
    this.validateExportPath(destination);
    const stored = this.transaction(() => {
      const hash = digest(canonical(input));
      const previous = this.rows('SELECT * FROM requests WHERE actor_id=? AND idempotency_key=?', [this.actorId, input.idempotencyKey])[0];
      if (previous) {
        if (previous.input_hash !== hash) throw new Error('idempotency_conflict');
        return JSON.parse(this.content(String(previous.result_content_id)).toString('utf8')) as { destination: string; sha256: string; revision: number; contentId: string; outboxId: string };
      }
      const object = this.current(input.ref);
      const body = object.data.content as { encoding?: string; data?: string } | undefined;
      const data = input.format === 'json' ? canonical(object) : body && body.encoding === 'base64' ? Buffer.from(body.data!, 'base64') : String(object.data.content ?? canonical(object.data));
      const contentId = this.putContent(data, input.format === 'json' ? 'application/json' : 'text/plain');
      const requestId = crypto.randomUUID();
      const outboxId = crypto.randomUUID();
      const eventId = crypto.randomUUID();
      const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0)+1 AS seq FROM events')[0].seq);
      const result = { destination, sha256: digest(data), revision: object.revision, contentId, outboxId };
      const resultId = this.putContent(canonical(result), 'application/json');
      this.db.run('INSERT INTO requests VALUES(?,?,?,?,?,?,?)', [this.actorId, input.idempotencyKey, requestId, hash, resultId, 'committed', sequence]);
      this.db.run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)', [eventId, sequence, object.objectId, this.actorId, 'object.export', contentId, Date.now(), requestId]);
      this.db.run('INSERT INTO outbox VALUES(?,?,?,?,?,?,?,0,NULL)', [outboxId, eventId, 'file_export', destination, contentId, 1, 'pending']);
      return result;
    });
    const bytes = this.content(stored.contentId);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    this.validateExportPath(destination);
    // Existing user exports are never overwritten. A replay may accept only identical bytes.
    try { await fs.promises.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || digest(await fs.promises.readFile(destination)) !== stored.sha256) throw error;
    }
    this.db.run("UPDATE outbox SET state='delivered',attempt=attempt+1 WHERE id=?", [stored.outboxId]);
    return { destination: stored.destination, sha256: stored.sha256, revision: stored.revision };
  }
  private validateExportPath(destination: string): void {
    const relative = path.relative(path.resolve(this.root), destination);
    let current = path.resolve(this.root);
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error('export_destination_symlink');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
  }
  public async recoverOutbox(): Promise<{ delivered: number; pending: Array<{ id: string; error: string }> }> {
    const effects = this.rows("SELECT * FROM outbox WHERE state<>'delivered' AND channel IN ('project_identity','file_export') ORDER BY rowid");
    const pending: Array<{ id: string; error: string }> = [];
    let delivered = 0;
    for (const effect of effects) {
      const id = String(effect.id);
      try {
        const destination = String(effect.destination_ref);
        if (effect.channel === 'file_export') {
          const relative = path.relative(path.resolve(this.root, 'exports'), destination);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('export_destination_outside_exports');
          this.validateExportPath(destination);
        } else {
          if (path.basename(destination) !== 'project.json' || path.basename(path.dirname(destination)) !== '.solopreneur') throw new Error('project_identity_invalid');
          const projectRoot = fs.realpathSync(path.dirname(path.dirname(destination)));
          if (!this.rows("SELECT id FROM project_locations WHERE root_path=? AND status='active'", [projectRoot]).length) throw new Error('project_location_missing');
          if (fs.existsSync(path.dirname(destination)) && fs.lstatSync(path.dirname(destination)).isSymbolicLink()) throw new Error('project_identity_symlink');
        }
        const bytes = this.content(String(effect.content_id));
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        if (effect.channel === 'file_export') this.validateExportPath(destination);
        try { await fs.promises.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || fs.lstatSync(destination).isSymbolicLink() || digest(await fs.promises.readFile(destination)) !== digest(bytes)) throw error;
        }
        this.db.run("UPDATE outbox SET state='delivered',attempt=attempt+1,next_attempt_at=NULL WHERE id=?", [id]);
        delivered++;
      } catch (error) {
        this.db.run("UPDATE outbox SET attempt=attempt+1 WHERE id=?", [id]);
        pending.push({ id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { delivered, pending };
  }
  public search(input: { scope: string | null; query?: string; kinds?: string[]; limit?: number; cursor?: string }, canRead: (object: DataObject) => boolean = () => true): { items: DataObject[]; cursor: string | null; sourceSequence: number; sourceChanged: boolean } {
    if (input.scope !== null && typeof input.scope !== 'string') throw new Error('scope_required');
    const limit = input.limit === undefined ? 50 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('invalid_limit');
    const sequence = Number(this.rows('SELECT COALESCE(MAX(sequence),0) AS seq FROM events')[0].seq);
    const after = input.cursor ? JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as { id: string; sequence: number; fingerprint: string } : null;
    const fingerprint = digest(canonical({ scope: input.scope, query: input.query || '', kinds: input.kinds || [] }));
    if (after && after.fingerprint !== fingerprint) throw new Error('cursor_scope_mismatch');
    const kinds = input.kinds || Object.keys(entityDefinitions);
    kinds.forEach(kind => this.definition(kind));
    const matches: DataObject[] = [];
    let lastId = after?.id || '';
    while (matches.length <= limit) {
      const candidates = this.rows(`SELECT id FROM objects WHERE project_id IS ? AND archived_at IS NULL AND kind IN (${kinds.map(() => '?').join(',')}) AND id>? ${input.query ? 'AND rowid IN (SELECT rowid FROM object_search WHERE object_search MATCH ?)' : ''} ORDER BY id LIMIT ?`, [input.scope, ...kinds, lastId, ...(input.query ? [queryTokens(input.query)] : []), limit + 1]);
      if (!candidates.length) break;
      for (const row of candidates) {
        lastId = String(row.id);
        const metadata = this.current(lastId, false);
        if (!canRead(metadata)) continue;
        if (!input.query || canonical(this.current(lastId).data).toLowerCase().includes(input.query.toLowerCase())) matches.push(metadata);
        if (matches.length > limit) break;
      }
      if (candidates.length < limit + 1) break;
    }
    const items = matches.slice(0, limit);
    return { items, cursor: matches.length > limit ? Buffer.from(canonical({ id: items[items.length - 1].objectId, sequence: after?.sequence ?? sequence, fingerprint })).toString('base64url') : null, sourceSequence: sequence, sourceChanged: after !== null && after.sequence !== sequence };
  }
  public async backup(destination: string): Promise<void> {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const fd = fs.openSync(destination, 'wx', 0o600);
    fs.closeSync(fd);
    await this.db.backup(destination);
  }
  public close(): void { this.db.close(); }
}
