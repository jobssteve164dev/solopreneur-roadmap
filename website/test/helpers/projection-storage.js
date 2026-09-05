import { DatabaseSync } from 'node:sqlite';

export function storage() {
  const db = new DatabaseSync(':memory:');
  let written = 0;
  return {
    db,
    get written() { return written; },
    sql: { exec(sql, ...params) {
      const statement = db.prepare(sql);
      if (statement.columns().length) return statement.all(...params);
      const result = statement.run(...params);
      written += Number(result.changes);
      return [];
    } },
    transactionSync(fn) {
      db.exec('BEGIN');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}

