import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { DiskDatabase } from './diskDatabase.js';
import { syncSnapshotDirectoryChain } from './pinnedDatabaseSnapshot.js';
import { orderedRecordSequences } from './orderedRecordSequences.js';

/** Run only off the Writer, against a generation's already-owned baseline. */
export function createCompactDatabaseCandidate(input: { candidateDir: string; databaseId: string; device: string; inode: string }): { beforeBytes: number; afterBytes: number } {
  const directory = path.resolve(input.candidateDir);
  const parent = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
  const identity = fs.fstatSync(parent, { bigint: true });
  const descriptorPath = (descriptor: number, fallback: string): string => process.platform === 'linux' ? `/proc/self/fd/${descriptor}` : process.platform === 'darwin' ? `/dev/fd/${descriptor}` : fallback;
  const stableParent = descriptorPath(parent, directory), baseline = path.join(stableParent, 'baseline.db'), destination = path.join(stableParent, 'solomap.db');
  let stage: string | undefined, staged: string | undefined, stageDescriptor: number | undefined, fileDescriptor: number | undefined;
  let ownedStage: fs.BigIntStats | undefined, ownedFile: fs.BigIntStats | undefined;
  let published = false, complete = false;
  const same = (target: string, expected: fs.BigIntStats): boolean => {
    try { const current = fs.lstatSync(target, { bigint: true }); return !current.isSymbolicLink() && current.dev === expected.dev && current.ino === expected.ino; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  const assertParent = (): void => {
    if (String(identity.dev) !== input.device || String(identity.ino) !== input.inode || !same(directory, identity)) throw new Error('database_compact_directory_changed');
  };
  try {
    assertParent();
    syncSnapshotDirectoryChain(directory, identity.dev);
    const baselineIdentity = fs.lstatSync(baseline, { bigint: true });
    if (!baselineIdentity.isFile() || baselineIdentity.isSymbolicLink()) throw new Error('database_compact_baseline_invalid');
    const beforeBytes = Number(baselineIdentity.size);
    stage = path.join(stableParent, `.solomap-compact-${randomUUID()}`);
    fs.mkdirSync(stage, { mode: 0o700 });
    stageDescriptor = fs.openSync(stage, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
    ownedStage = fs.fstatSync(stageDescriptor, { bigint: true });
    staged = path.join(descriptorPath(stageDescriptor, stage), 'solomap.db');
    fileDescriptor = fs.openSync(staged, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    ownedFile = fs.fstatSync(fileDescriptor, { bigint: true });
    const source = new DiskDatabase(baseline, { journalMode: 'DELETE' });
    let committedSequence: number, migrationVersion: number;
    try {
      if (source.exec("SELECT value FROM database_meta WHERE key='database_id'")[0]?.values[0]?.[0] !== input.databaseId) throw new Error('database_compact_identity_mismatch');
      committedSequence = Number(source.exec('SELECT COALESCE(MAX(sequence),0) FROM events')[0].values[0][0]);
      migrationVersion = Number(source.exec('SELECT COALESCE(MAX(version),0) FROM schema_migrations')[0].values[0][0]);
      source.run('VACUUM INTO ?', [staged]);
    } finally { source.close(); }
    if (!same(baseline, baselineIdentity) || !same(staged, ownedFile)) throw new Error('database_compact_file_changed');
    const candidate = new DiskDatabase(staged, { readOnly: true, immutable: true });
    try {
      if (candidate.exec("SELECT value FROM database_meta WHERE key='database_id'")[0]?.values[0]?.[0] !== input.databaseId
        || Number(candidate.exec('SELECT COALESCE(MAX(sequence),0) FROM events')[0].values[0][0]) !== committedSequence
        || Number(candidate.exec('SELECT COALESCE(MAX(version),0) FROM schema_migrations')[0].values[0][0]) !== migrationVersion
        || candidate.exec('PRAGMA integrity_check')[0]?.values[0]?.[0] !== 'ok'
        || candidate.exec('PRAGMA foreign_key_check').length) throw new Error('database_compact_candidate_invalid');
      candidate.run('ATTACH DATABASE ? AS compact_baseline', [baseline]);
      // The bundled native engine preserves rowids of indexed tables. Check
      // that invariant before trusting the copied contentless FTS binding.
      if (candidate.exec('SELECT 1 FROM objects current JOIN compact_baseline.objects original ON original.id=current.id WHERE current.rowid<>original.rowid LIMIT 1').length) throw new Error('database_compact_search_rowid_changed');
      for (const [table,column] of [
        ...orderedRecordSequences.filter(specification => !specification.base).map(specification => [specification.table,specification.column]),
        ...['growth_items','growth_edges','growth_signals','growth_module_labels','growth_live_items','growth_live_edges','growth_live_signals','growth_live_module_labels'].map(table => [table,'detail_ordinal'])
      ]) {
        const schema = candidate.exec(`PRAGMA main.table_info("${table}")`)[0];
        const primaryKeys = schema.values.filter(row => Number(row[5]) > 0).sort((left,right) => Number(left[5])-Number(right[5])).map(row => String(row[1]));
        if (!primaryKeys.length || primaryKeys.some(key => !/^[a-z_]+$/.test(key))) throw new Error('database_compact_order_key_invalid');
        const join = primaryKeys.map(key => `original."${key}" IS current."${key}"`).join(' AND ');
        if (candidate.exec(`SELECT 1 FROM main."${table}" current JOIN compact_baseline."${table}" original ON ${join}
          WHERE original."${column}" IS NULL AND current.rowid<>original.rowid LIMIT 1`).length) throw new Error('database_compact_legacy_order_changed');
      }
    } finally { candidate.close(); }
    fs.fsyncSync(fileDescriptor);
    assertParent();
    fs.linkSync(staged, destination);
    published = true;
    assertParent();
    if (!same(destination, ownedFile)) throw new Error('database_compact_file_changed');
    fs.fsyncSync(parent);
    const afterBytes = Number(fs.fstatSync(fileDescriptor, { bigint: true }).size);
    complete = true;
    return { beforeBytes, afterBytes };
  } finally {
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
    try {
      if (published && !complete && ownedFile && same(destination, ownedFile)) fs.unlinkSync(destination);
      if (staged && ownedFile && same(staged, ownedFile)) fs.unlinkSync(staged);
      if (stage && ownedStage && same(stage, ownedStage)) fs.rmdirSync(stage);
      fs.fsyncSync(parent);
    } finally { if (stageDescriptor !== undefined) fs.closeSync(stageDescriptor); fs.closeSync(parent); }
  }
}
