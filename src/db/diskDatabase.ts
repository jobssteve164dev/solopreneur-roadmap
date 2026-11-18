import * as fs from 'fs';
import { DatabaseGenerationForeignKeys, prepareDatabaseGenerationForeignKeyIndexes } from './databaseGenerationForeignKeys.js';
import * as path from 'path';
import { pathToFileURL } from 'url';

export type SqlValue = string | number | bigint | null | Uint8Array;
type Row = Record<string, SqlValue>;
interface NativeStatement {
  run(...values: SqlValue[]): { changes: number | bigint };
  iterate(...values: SqlValue[]): IterableIterator<Row>;
  columns(): { name: string }[];
}
interface NativeDatabase {
  readonly isOpen: boolean;
  readonly isTransaction: boolean;
  prepare(sql: string): NativeStatement;
  exec(sql: string): void;
  close(): void;
  createSession(options?: { db?: string; table?: string }): NativeSession;
  applyChangeset(changeset: Uint8Array, options?: { onConflict?: (type: number) => number }): boolean;
}
interface NativeSession { changeset(): Uint8Array; close(): void }

const changesetEnvelopeMagic = Buffer.from('SMCS2');

function encodeChangesets(changesets: Array<{ table: string; bytes: Uint8Array }>): Uint8Array {
  const nonempty = changesets.filter(value => value.bytes.byteLength > 0);
  if (!nonempty.length) return new Uint8Array();
  const parts: Buffer[] = [changesetEnvelopeMagic, Buffer.alloc(4)]; parts[1].writeUInt32BE(nonempty.length);
  for (const changeset of nonempty) {
    const table = Buffer.from(changeset.table); if (!table.length || table.length > 65535) throw new Error('database_generation_changeset_invalid');
    const header = Buffer.alloc(6); header.writeUInt16BE(table.length); header.writeUInt32BE(changeset.bytes.byteLength, 2);
    parts.push(header, table, Buffer.from(changeset.bytes));
  }
  return Buffer.concat(parts);
}

function decodeChangesets(value: Uint8Array): Array<{ table: string; bytes: Uint8Array }> {
  const bytes = Buffer.from(value);
  if (bytes.length < changesetEnvelopeMagic.length || !bytes.subarray(0, changesetEnvelopeMagic.length).equals(changesetEnvelopeMagic)) return [{ table: 'legacy', bytes }];
  if (bytes.length < changesetEnvelopeMagic.length + 4) throw new Error('database_generation_changeset_invalid');
  const count = bytes.readUInt32BE(changesetEnvelopeMagic.length);
  if (!count) throw new Error('database_generation_changeset_invalid');
  const result: Array<{ table: string; bytes: Uint8Array }> = []; let offset = changesetEnvelopeMagic.length + 4;
  for (let index = 0; index < count; index++) {
    if (offset + 6 > bytes.length) throw new Error('database_generation_changeset_invalid');
    const tableLength = bytes.readUInt16BE(offset), length = bytes.readUInt32BE(offset + 2); offset += 6;
    if (!tableLength || !length || offset + tableLength + length > bytes.length) throw new Error('database_generation_changeset_invalid');
    const table = bytes.subarray(offset, offset + tableLength).toString(); offset += tableLength;
    result.push({ table, bytes: bytes.subarray(offset, offset + length) }); offset += length;
  }
  if (offset !== bytes.length) throw new Error('database_generation_changeset_invalid');
  return result;
}

/** Compatibility at the query boundary; data stays on disk, never in a JS snapshot. */
export class DiskStatement {
  private values: SqlValue[] = [];
  private iterator: IterableIterator<Row> | null = null;
  private row: Row | null = null;
  constructor(private statement: NativeStatement, private onChange: (changes: number) => void) {}
  bind(values: SqlValue[]): void {
    this.free();
    this.values = values;
  }
  run(values: SqlValue[] = this.values): void {
    this.free();
    this.onChange(Number(this.statement.run(...values).changes));
  }
  step(): boolean {
    if (!this.iterator) this.iterator = this.statement.iterate(...this.values);
    const next = this.iterator.next();
    this.row = next.done ? null : next.value;
    return !next.done;
  }
  getAsObject(): Row {
    if (!this.row) throw new Error('SQLite statement has no current row');
    return this.row;
  }
  free(): void {
    this.iterator?.return?.();
    this.iterator = null;
    this.row = null;
  }
}

export class DiskDatabase {
  private native: NativeDatabase;
  private changes = 0;
  private readonly runStatements = new Map<string, NativeStatement>();
  private replicationSessions: Array<{ table: string; session: NativeSession }> | undefined;
  private replayRevision = 0;
  private generationForeignKeys?: DatabaseGenerationForeignKeys;
  private verifiedGeneration?: { changes: number; dataVersion: number; schemaCookie: number };
  get changesetReplayRevision(): number { return this.replayRevision; }
  get isOpen(): boolean { return this.native.isOpen; }
  get inTransaction(): boolean { return this.native.isTransaction; }
  constructor(public readonly filePath: string, options: { foreignKeys?: boolean; journalMode?: 'WAL' | 'DELETE'; readOnly?: boolean; immutable?: boolean } = {}) {
    if (!options.readOnly) fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Node's bundled driver avoids platform-specific extension ABI binaries.
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string | URL, options?: { readOnly?: boolean }) => NativeDatabase };
    let location: string | URL = filePath;
    if (options.immutable) { const url = pathToFileURL(filePath); url.searchParams.set('immutable', '1'); location = url; }
    this.native = new DatabaseSync(location, options.readOnly ? { readOnly: true } : {});
    try {
      this.native.exec(options.readOnly
        ? `PRAGMA busy_timeout=10000; PRAGMA query_only=ON; PRAGMA foreign_keys=${options.foreignKeys === false ? 'OFF' : 'ON'};`
        : `PRAGMA busy_timeout=10000; PRAGMA journal_mode=${options.journalMode || 'WAL'}; PRAGMA synchronous=FULL; PRAGMA foreign_keys=${options.foreignKeys === false ? 'OFF' : 'ON'};`);
    } catch (error) {
      this.native.close();
      throw error;
    }
  }
  prepare(sql: string): DiskStatement {
    return new DiskStatement(this.native.prepare(sql), changes => { this.changes = changes; });
  }
  run(sql: string, values?: SqlValue[]): void {
    if (values) {
      let statement = this.runStatements.get(sql);
      if (!statement) {
        statement = this.native.prepare(sql);
        this.runStatements.set(sql, statement);
      }
      this.changes = Number(statement.run(...values).changes);
    }
    else this.native.exec(sql);
  }
  exec(sql: string): { columns: string[]; values: SqlValue[][] }[] {
    const statement = this.native.prepare(sql);
    const columns = statement.columns().map(column => column.name);
    const rows = [...statement.iterate()];
    return rows.length ? [{ columns, values: rows.map(row => columns.map(column => row[column])) }] : [];
  }
  getRowsModified(): number { return this.changes; }
  async backup(destination: string): Promise<void> {
    const { backup } = require('node:sqlite') as { backup(source: NativeDatabase, target: string): Promise<void> };
    await backup(this.native, destination);
  }
  get changesetCaptureActive(): boolean { return Boolean(this.replicationSessions); }
  startChangesetCapture(): void {
    if (this.replicationSessions) throw new Error('database_generation_capture_active');
    const tables = [...this.native.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").iterate()]
      .map(row => ({ name: String(row.name), sql: String(row.sql || '') }));
    const virtual = tables.filter(table => /^CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql)).map(table => table.name);
    const authoritative = tables.filter(table => !['content_lifecycle_replication_guard', 'content_lifecycle_gc_debt', 'content_lifecycle_capture_imports'].includes(table.name)
      && !virtual.some(name => table.name === name || table.name.startsWith(`${name}_`)));
    const sessions: Array<{ table: string; session: NativeSession }> = [];
    try {
      for (const table of authoritative) sessions.push({ table: table.name, session: this.native.createSession({ db: 'main', table: table.name }) });
      this.replicationSessions = sessions;
    } catch (error) {
      for (const item of sessions) item.session.close();
      throw error;
    }
  }
  rotateChangesetCapture(): Uint8Array {
    if (!this.replicationSessions) throw new Error('database_generation_capture_inactive');
    const changeset = encodeChangesets(this.replicationSessions.map(value => ({ table: value.table, bytes: value.session.changeset() })));
    this.replicationSessions.forEach(value => value.session.close());
    this.replicationSessions = undefined;
    this.startChangesetCapture();
    return changeset;
  }
  stopChangesetCapture(): Uint8Array {
    if (!this.replicationSessions) throw new Error('database_generation_capture_inactive');
    const changeset = encodeChangesets(this.replicationSessions.map(value => ({ table: value.table, bytes: value.session.changeset() })));
    this.replicationSessions.forEach(value => value.session.close());
    this.replicationSessions = undefined;
    return changeset;
  }
  cancelChangesetCapture(): void {
    const sessions = this.replicationSessions;
    this.replicationSessions = undefined;
    let failure: unknown;
    for (const item of sessions || []) { try { item.session.close(); } catch (error) { failure ||= error; } }
    if (failure) throw failure;
  }
  private generationCounters(): { changes: number; dataVersion: number; schemaCookie: number } {
    return { changes: Number(this.exec('SELECT total_changes()')[0].values[0][0]), dataVersion: Number(this.exec('PRAGMA main.data_version')[0].values[0][0]), schemaCookie: Number(this.exec('PRAGMA main.schema_version')[0].values[0][0]) };
  }
  prepareGenerationForeignKeyIndexes(): string[] {
    if (this.generationForeignKeys) throw new Error('database_generation_validation_active');
    return prepareDatabaseGenerationForeignKeyIndexes(this);
  }
  verifyGenerationIntegrity(): void {
    this.verifiedGeneration = undefined;
    const before = this.generationCounters();
    if (this.exec('PRAGMA integrity_check')[0]?.values?.[0]?.[0] !== 'ok' || this.exec('PRAGMA foreign_key_check').length) throw new Error('database_generation_invalid');
    const after = this.generationCounters();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('database_generation_baseline_changed');
    this.verifiedGeneration = after;
  }
  acceptVerifiedGenerationBaseline(): void {
    if (!this.verifiedGeneration || JSON.stringify(this.generationCounters()) !== JSON.stringify(this.verifiedGeneration)) throw new Error('database_generation_baseline_changed');
    const verified = this.verifiedGeneration;
    this.verifiedGeneration = undefined;
    if (this.generationForeignKeys) throw new Error('database_generation_validation_active');
    this.generationForeignKeys = new DatabaseGenerationForeignKeys(this, verified);
  }
  verifyGenerationTail(): void {
    if (!this.generationForeignKeys) throw new Error('database_generation_baseline_changed');
    this.generationForeignKeys.verify();
  }
  applyChangeset(changeset: Uint8Array, previousLiveSequence?: number, currentLiveSequence?: number, afterApply?: () => void): void {
    if (!changeset.byteLength) return;
    const { constants } = require('node:sqlite') as { constants: Record<string, number> };
    this.native.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    try {
      this.generationForeignKeys?.begin();
      // Candidate-only, transaction-local suppression: the exact source queue
      // changeset follows below. Re-enqueueing here would invent new versions.
      const lifecycleGuard = this.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='content_lifecycle_replication_guard'").length > 0;
      if (lifecycleGuard) this.native.exec('UPDATE content_lifecycle_replication_guard SET replaying=1 WHERE id=1');
      if (previousLiveSequence !== undefined || currentLiveSequence !== undefined) {
        if (!Number.isSafeInteger(previousLiveSequence) || !Number.isSafeInteger(currentLiveSequence)
          || Number(previousLiveSequence) < 0 || Number(currentLiveSequence) < Number(previousLiveSequence)) {
          throw new Error('database_generation_event_sequence_invalid');
        }
        const previousSequence = Number(previousLiveSequence);
        const delta = Number(currentLiveSequence) - previousSequence;
        if (delta > 0) {
          this.native.prepare('UPDATE events SET sequence=-(sequence+?) WHERE sequence>?').run(delta, previousSequence);
          this.native.prepare('UPDATE events SET sequence=-sequence WHERE sequence<0').run();
          this.native.prepare('UPDATE requests SET committed_sequence=committed_sequence+? WHERE committed_sequence>?').run(delta, previousSequence);
        }
      }
      const pending = decodeChangesets(changeset), ordered: typeof pending = [], appliedTables = new Set<string>();
      while (pending.length) {
        const index = pending.findIndex(part => {
          if (part.table === 'legacy' || !/^[a-zA-Z0-9_]+$/.test(part.table)) return true;
          const dependencies = [...this.native.prepare(`PRAGMA foreign_key_list("${part.table}")`).iterate()].map(row => String(row.table));
          return dependencies.every(table => !pending.some(candidate => candidate.table === table) || appliedTables.has(table) || table === part.table);
        });
        const [next] = pending.splice(index < 0 ? 0 : index, 1); ordered.push(next); appliedTables.add(next.table);
      }
      for (const part of ordered) {
        const conflictTypes: number[] = [];
        try {
          const applied = this.native.applyChangeset(part.bytes, { onConflict: type => {
            conflictTypes.push(type);
            if (type === constants.SQLITE_CHANGESET_DATA || type === constants.SQLITE_CHANGESET_CONFLICT) return constants.SQLITE_CHANGESET_REPLACE;
            return constants.SQLITE_CHANGESET_ABORT;
          } });
          if (!applied) throw new Error('database_generation_changeset_rejected');
        } catch (error) { throw new Error(`database_generation_changeset_table:${part.table}:conflicts=${conflictTypes.join(',')}:${error instanceof Error ? error.message : String(error)}`); }
      }
      if (lifecycleGuard) this.native.exec('UPDATE content_lifecycle_replication_guard SET replaying=0 WHERE id=1');
      afterApply?.();
      this.generationForeignKeys?.verify();
      this.native.exec('COMMIT');
      this.replayRevision++;
      this.native.exec('PRAGMA foreign_keys=ON');
      if (!this.generationForeignKeys && this.exec('PRAGMA foreign_key_check').some(result => result.values.length)) throw new Error('database_generation_changeset_foreign_key');
    } catch (error) {
      try { this.native.exec('ROLLBACK'); } catch {}
      try { this.native.exec('PRAGMA foreign_keys=ON'); } catch {}
      throw error;
    }
  }
  close(): void { this.replicationSessions?.forEach(value => value.session.close()); this.replicationSessions = undefined; this.runStatements.clear(); this.native.close(); }
}
