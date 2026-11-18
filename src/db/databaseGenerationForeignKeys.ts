import type { DiskDatabase, SqlValue } from './diskDatabase.js';

const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;
const changed = (column: string): string => `(typeof(OLD.${quote(column)})<>typeof(NEW.${quote(column)}) OR OLD.${quote(column)} IS NOT NEW.${quote(column)} COLLATE BINARY)`;
const affinity = (type: string): string => /INT/i.test(type) ? 'INTEGER' : /CHAR|CLOB|TEXT/i.test(type) ? 'TEXT' : /BLOB/i.test(type) || !type ? 'BLOB' : /REAL|FLOA|DOUB/i.test(type) ? 'REAL' : 'NUMERIC';
const rows = (database: DiskDatabase, sql: string): Record<string, SqlValue>[] => {
  const result = database.exec(sql)[0];
  return result ? result.values.map(values => Object.fromEntries(result.columns.map((key, index) => [key, values[index]]))) : [];
};

// The authorized growth cleanup can remove these parents during capture.
// Build their missing reverse keys off-actor, before accepting the baseline.
const mutableParentIndexes: ReadonlyArray<{ table: string; columns: string[] }> = [
  { table: 'applications', columns: ['target_object_id'] },
  { table: 'grants', columns: ['target_id'] },
  { table: 'mcp_conversation_launches', columns: ['flow_object_id'] },
  { table: 'migration_items', columns: ['object_id'] },
  { table: 'relations', columns: ['target_id'] },
  { table: 'legacy_learning_review_cursor_inputs', columns: ['cursor_id', 'cursor_revision'] },
  { table: 'lesson_decision_candidates', columns: ['lesson_id', 'lesson_revision'] },
  { table: 'lesson_event_refs', columns: ['event_id', 'event_revision'] },
  { table: 'policy_uses', columns: ['lesson_id', 'lesson_revision'] },
  { table: 'policy_uses', columns: ['policy_id', 'policy_revision'] },
  { table: 'migration_items', columns: ['source_capture_request_id'] },
  { table: 'migration_source_json_versions', columns: ['request_id'] }
];
export function prepareDatabaseGenerationForeignKeyIndexes(database: DiskDatabase): string[] {
  const created: string[] = [];
  for (const item of mutableParentIndexes) {
    const covered = rows(database, `PRAGMA main.index_list(${quote(item.table)})`).filter(index => !Number(index.partial)).some(index => {
      const columns = rows(database, `PRAGMA main.index_xinfo(${quote(String(index.name))})`).filter(column => Number(column.key));
      return columns.length >= item.columns.length && item.columns.every(column => columns.slice(0, item.columns.length).some(indexColumn => indexColumn.name === column && String(indexColumn.coll).toUpperCase() === 'BINARY'));
    });
    if (covered) continue;
    const name = `generation_fk_${item.table}_${item.columns.join('_')}`;
    database.run(`CREATE INDEX ${quote(name)} ON ${quote(item.table)}(${item.columns.map(column => `${quote(column)} COLLATE BINARY`).join(',')})`);
    created.push(name);
  }
  return created;
}

/** TEMP-only change tracking on one already-verified, private candidate. */
export class DatabaseGenerationForeignKeys {
  private readonly schemaCookie: number;
  private readonly dataVersion: number;
  private readonly tempSchemaCookie?: number;
  private readonly checks: Array<{ queue: string; sql: string }> = [];
  constructor(private readonly database: DiskDatabase, verified: { schemaCookie: number; dataVersion: number }) {
    this.schemaCookie = verified.schemaCookie;
    this.dataVersion = verified.dataVersion;
    this.assertSchema();
    const tables = rows(database, "SELECT name,sql FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    let sequence = 0;
    for (const table of tables) {
      const child = String(table.name), childInfo = rows(database, `PRAGMA main.table_xinfo(${quote(child)})`);
      const primary = childInfo.filter(column => Number(column.pk)).sort((a, b) => Number(a.pk) - Number(b.pk)).map(column => String(column.name));
      const aliases = /WITHOUT\s+ROWID/i.test(String(table.sql)) ? [] : ['rowid', '_rowid_', 'oid'].filter(alias => !childInfo.some(column => String(column.name).toLowerCase() === alias));
      const keys = /WITHOUT\s+ROWID/i.test(String(table.sql))
        ? primary : aliases.slice(0, 1);
      const constraints = new Map<number, Record<string, SqlValue>[]>();
      for (const fk of rows(database, `PRAGMA main.foreign_key_list(${quote(child)})`)) {
        const key = Number(fk.id), group = constraints.get(key) || []; group.push(fk); constraints.set(key, group);
      }
      if (constraints.size && !keys.length) throw new Error(`database_generation_child_identity_missing:${child}`);
      for (const group of constraints.values()) {
        group.sort((a, b) => Number(a.seq) - Number(b.seq));
        const parent = String(group[0].table), childColumns = group.map(fk => String(fk.from));
        const parentInfo = rows(database, `PRAGMA main.table_xinfo(${quote(parent)})`);
        const parentPrimary = parentInfo.filter(column => Number(column.pk)).sort((a, b) => Number(a.pk) - Number(b.pk)).map(column => String(column.name));
        const parentColumns = group.map((fk, index) => fk.to === null ? parentPrimary[index] : String(fk.to));
        if (parentColumns.some(column => !column)) throw new Error(`database_generation_parent_identity_missing:${parent}`);
        const prefix = `solomap_generation_fk_${sequence++}`, queue = `${prefix}_queue`;
        database.run(`CREATE TEMP TABLE ${quote(queue)}(${keys.map((_, index) => `k${index}`).join(',')},PRIMARY KEY(${keys.map((_, index) => `k${index}`).join(',')})) WITHOUT ROWID`);
        const enqueueNew = `INSERT OR IGNORE INTO ${quote(queue)} VALUES(${keys.map(key => `NEW.${quote(key)}`).join(',')});`;
        database.run(`CREATE TEMP TRIGGER ${quote(`${prefix}_insert`)} AFTER INSERT ON main.${quote(child)} BEGIN ${enqueueNew} END`);
        const childChanges = [...new Set([...childColumns, ...keys])];
        database.run(`CREATE TEMP TRIGGER ${quote(`${prefix}_update`)} AFTER UPDATE ON main.${quote(child)}
          WHEN ${childChanges.map(changed).join(' OR ')} BEGIN ${enqueueNew} END`);
        // Unary + removes child affinity: SQLite applies the parent column's
        // affinity and collation when deciding whether a FK matches.
        const linkedOld = parentColumns.map((column, index) => `OLD.${quote(column)}=+c.${quote(childColumns[index])}`).join(' AND ');
        const compatible = parentColumns.every((column, index) => affinity(String(parentInfo.find(item => item.name === column)?.type || '')) === affinity(String(childInfo.find(item => item.name === childColumns[index])?.type || '')));
        const indexed = compatible ? parentColumns.map((column, index) => `OLD.${quote(column)}=c.${quote(childColumns[index])}`).join(' AND ') : '';
        const enqueueOldChildren = `INSERT OR IGNORE INTO ${quote(queue)} SELECT ${keys.map(key => `c.${quote(key)}`).join(',')} FROM main.${quote(child)} c WHERE ${indexed ? `${indexed} AND ` : ''}${linkedOld};`;
        database.run(`CREATE TEMP TRIGGER ${quote(`${prefix}_parent_delete`)} BEFORE DELETE ON main.${quote(parent)} BEGIN ${enqueueOldChildren} END`);
        database.run(`CREATE TEMP TRIGGER ${quote(`${prefix}_parent_update`)} AFTER UPDATE ON main.${quote(parent)}
          WHEN ${parentColumns.map(changed).join(' OR ')} BEGIN ${enqueueOldChildren} END`);
        const identity = keys.map((key, index) => `c.${quote(key)}=+q.k${index}`).join(' AND ');
        const nonNull = childColumns.map(column => `c.${quote(column)} IS NOT NULL`).join(' AND ');
        const parentMatch = parentColumns.map((column, index) => `p.${quote(column)}=+c.${quote(childColumns[index])}`).join(' AND ');
        this.checks.push({ queue, sql: `SELECT 1 FROM temp.${quote(queue)} q CROSS JOIN main.${quote(child)} c ON ${identity}
          WHERE ${nonNull} AND NOT EXISTS(SELECT 1 FROM main.${quote(parent)} p WHERE ${parentMatch}) LIMIT 1` });
      }
    }
    this.tempSchemaCookie = Number(database.exec('PRAGMA temp.schema_version')[0].values[0][0]);
    this.assertSchema();
  }
  assertSchema(): void {
    if (Number(this.database.exec('PRAGMA main.schema_version')[0].values[0][0]) !== this.schemaCookie) throw new Error('database_generation_schema_changed');
    if (Number(this.database.exec('PRAGMA main.data_version')[0].values[0][0]) !== this.dataVersion) throw new Error('database_generation_candidate_changed');
    if (this.tempSchemaCookie !== undefined && Number(this.database.exec('PRAGMA temp.schema_version')[0].values[0][0]) !== this.tempSchemaCookie) throw new Error('database_generation_schema_changed');
  }
  begin(): void {
    this.verify();
    for (const check of this.checks) this.database.run(`DELETE FROM temp.${quote(check.queue)}`);
  }
  verify(): void {
    this.assertSchema();
    for (const check of this.checks) if (this.database.exec(check.sql).length) throw new Error('database_generation_changeset_foreign_key');
    this.assertSchema();
  }
}
