import * as fs from 'fs';
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
  prepare(sql: string): NativeStatement;
  exec(sql: string): void;
  close(): void;
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
  close(): void { this.runStatements.clear(); this.native.close(); }
}
