import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { UnifiedDataStore } from './db/unifiedDataStore';
import { MemoryImportOptions, MemoryImportResult } from './memoryDatabaseMigration';

const retiredDirectories = ['active-conversations', 'conversations', 'daily', 'metrics'];

const retiredFiles = new Set([
  'capability-registry.csv',
  'decision-conflicts.csv',
  'dependencies.csv',
  'portfolio.csv',
  'runtime/events.jsonl',
  'runtime/execution-runtime.json'
]);

const normalizeKey = (value: string): string => value.split(path.sep).join('/').replace(/^\.\//, '');

export function isGlobalRetiredDataKey(value: string): boolean {
  const key = normalizeKey(value);
  return retiredFiles.has(key)
    || /^active-conversations\/records\/[a-f0-9]{64}\.json$/i.test(key)
    || /^conversations\/sidebar-conversation-[a-f0-9]{40}-v1\.json\.legacy-\d+$/i.test(key)
    || /^daily\/\d{4}-\d{2}-\d{2}\.json$/.test(key)
    || /^metrics\/(?:priority-accuracy|execution-speed|reuse-rate)\.csv$/.test(key)
    || key === 'metrics/monthly-summary.md';
}

async function discoverFiles(root: string, shouldContinue: () => boolean): Promise<Array<{ file: string; key: string; info: fs.Stats }>> {
  const files: Array<{ file: string; key: string; info: fs.Stats }> = [];
  const candidates = retiredDirectories.map(key => path.join(root, ...key.split('/')))
    .concat([...retiredFiles].map(key => path.join(root, ...key.split('/'))));
  const pending = [...candidates].sort().reverse();
  while (pending.length) {
    if (!shouldContinue()) break;
    const file = pending.pop()!;
    let info: fs.Stats;
    try { info = await fs.promises.lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; continue; }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      pending.push(...(await fs.promises.readdir(file)).sort().reverse().map(name => path.join(file, name)));
      continue;
    }
    const key = normalizeKey(path.relative(root, file));
    if (info.isFile() && isGlobalRetiredDataKey(key)) files.push({ file, key, info });
  }
  return files.sort((left, right) => left.key.localeCompare(right.key));
}

async function stableBytes(root: string, source: { file: string; info: fs.Stats }): Promise<Buffer> {
  const physicalRoot = await fs.promises.realpath(root);
  const physicalFile = await fs.promises.realpath(source.file);
  const relative = path.relative(physicalRoot, physicalFile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('migration_source_invalid');
  const handle = await fs.promises.open(source.file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== source.info.dev || opened.ino !== source.info.ino) throw new Error('migration_source_changed');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const final = await fs.promises.lstat(source.file);
    if (after.size !== source.info.size || after.mtimeMs !== source.info.mtimeMs || after.ctimeMs !== source.info.ctimeMs
      || final.dev !== source.info.dev || final.ino !== source.info.ino || final.size !== bytes.length
      || await fs.promises.realpath(source.file) !== physicalFile) throw new Error('migration_source_changed');
    return bytes;
  } finally { await handle.close(); }
}

export async function globalRetiredDataStamp(root: string, shouldContinue: () => boolean): Promise<string> {
  const hash = crypto.createHash('sha256');
  const files = await discoverFiles(path.resolve(root), shouldContinue);
  if (!files.length) return '';
  for (const source of files) {
    if (!shouldContinue()) return '';
    hash.update(JSON.stringify([source.key, source.info.mode, source.info.dev, source.info.ino, source.info.size, source.info.mtimeMs, source.info.ctimeMs]));
  }
  return hash.digest('hex');
}

export async function importGlobalRetiredData(store: UnifiedDataStore, sourceRoot: string, options: MemoryImportOptions): Promise<MemoryImportResult> {
  const root = path.resolve(sourceRoot);
  if (root !== path.resolve(store.root)) throw new Error('migration_source_scope_mismatch');
  let physicalRoot: string;
  let physicalStoreRoot: string;
  try { [physicalRoot, physicalStoreRoot] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(store.root)]); }
  catch { throw new Error('migration_source_scope_mismatch'); }
  if (physicalRoot !== physicalStoreRoot) throw new Error('migration_source_scope_mismatch');
  const identity = `global-retired:${root}`;
  const shouldContinue = options.shouldContinue || (() => true);
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, conflicts: [], retainedFiles: [] };
  for (const source of await discoverFiles(root, shouldContinue)) {
    if (!shouldContinue()) { result.interrupted = true; break; }
    try {
      const bytes = await stableBytes(root, source);
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      result.originalBytes += bytes.length;
      const current = store.migrationSourceState(identity, source.key);
      if (current?.hash === hash && current.stage === 'imported') {
        result.unchanged++;
      } else {
        store.captureMigrationSource({ identity, key: source.key, hash }, bytes, { pending: true });
        const archived = store.archiveMigrationSource({ identity, key: source.key, hash }, bytes, { reason: 'retired_global_file_chain', observedAt: source.info.mtimeMs });
        result.archivedSources ||= [];
        result.archivedSources.push({ source: source.key, error: 'retired_global_file_chain', evidenceRef: `solomap://evidence/${archived.objectId}` });
        if (archived.unchanged) result.unchanged++; else result.imported++;
      }
    } catch (error) {
      result.conflicts.push({ source: source.key, error: error instanceof Error ? error.message : String(error) });
    }
    options.onProgress?.(result);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return result;
}
