import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as Papa from 'papaparse';
import { UnifiedDataStore } from './db/unifiedDataStore';
import type { MemoryImportOptions, MemoryImportResult } from './memoryDatabaseMigration';

const hash = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
async function stableSource(file: string): Promise<Buffer> {
  const before = await fs.promises.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('migration_source_invalid');
  const bytes = await fs.promises.readFile(file);
  const after = await fs.promises.lstat(file);
  if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.length !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('migration_source_changed');
  return bytes;
}
function csv(bytes: Buffer): Record<string, string>[] {
  const parsed = Papa.parse<Record<string, string>>(bytes.toString('utf8'), { header: true, skipEmptyLines: 'greedy' });
  if (parsed.errors.length) throw new Error(`strategy_csv_invalid: ${parsed.errors[0].message}`);
  return parsed.data;
}

/** Legacy files are captured in full; only exact project mappings can create preferences. */
export async function importStrategyDirectory(store: UnifiedDataStore, sourceRoot: string, options: MemoryImportOptions = {}): Promise<MemoryImportResult> {
  if ((await fs.promises.lstat(sourceRoot)).isSymbolicLink()) throw new Error('migration_source_invalid');
  const root = await fs.promises.realpath(sourceRoot);
  const identity = options.sourceIdentity || `strategy:${root}`;
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, conflicts: [], retainedFiles: [] };
  const captured = new Map<string, Buffer>();
  const known = new Set(['project-strategy.csv', 'ability-registry.csv', 'pyramid-snapshot.json', 'pyramid-snapshot-meta.json']);
  for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
    if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
    try {
      if (!entry.isFile() || entry.isSymbolicLink()) { result.retainedFiles.push(entry.name); continue; }
      const bytes = await stableSource(path.join(root, entry.name));
      result.originalBytes += bytes.length;
      store.captureMigrationSource({ identity, key: entry.name, hash: hash(bytes) }, bytes, { encoding: 'utf8', pending: true });
      if (known.has(entry.name)) captured.set(entry.name, bytes);
      else result.retainedFiles.push(entry.name);
    } catch (error) { result.conflicts.push({ source: entry.name, error: String(error) }); }
    options.onProgress?.(result); await new Promise<void>(resolve => setImmediate(resolve));
  }
  const importValue = (scope: string | null, key: string, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const source = { identity, key, hash: hash(bytes) };
    store.captureMigrationSource(source, bytes, { mimeType: 'application/json', encoding: 'utf8', pending: true });
    try {
      const imported = store.importStrategyState(scope, value, source);
      if (imported.unchanged) result.unchanged++; else result.imported++;
    } catch (error) {
      store.captureMigrationSource(source, bytes, { mimeType: 'application/json', encoding: 'utf8', error: String(error) });
      throw error;
    }
  };
  const finish = async (keys: string[], conflictStart: number) => {
    for (const key of keys) {
      const bytes = captured.get(key)!;
      try { if (hash(await stableSource(path.join(root, key))) !== hash(bytes)) throw new Error('source_changed_during_import'); }
      catch (error) { result.conflicts.push({ source: key, error: String(error) }); }
    }
    for (const key of keys) {
      const bytes = captured.get(key)!;
      if (result.conflicts.length === conflictStart) store.markMigrationSourceImported(identity, key);
      else store.captureMigrationSource({ identity, key, hash: hash(bytes) }, bytes, { encoding: 'utf8', error: 'strategy_import_incomplete' });
    }
  };
  const preferences = captured.get('project-strategy.csv');
  if (preferences) {
    const start = result.conflicts.length;
    try {
      const rows = csv(preferences);
      const paths = new Map<string, number>();
      for (const row of rows) paths.set(row.projectPath, (paths.get(row.projectPath) || 0) + 1);
      for (const row of rows) {
        if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
        try {
          const scope = options.projectScopes?.[row.projectPath];
          if (!path.isAbsolute(row.projectPath || '') || !scope) throw new Error('project_mapping_required');
          if (paths.get(row.projectPath)! > 1) throw new Error('ambiguous_project_preferences');
          importValue(scope, `preferences:${JSON.stringify([scope, row.projectPath])}`, row);
        } catch (error) { result.conflicts.push({ source: `project-strategy.csv:${row.projectPath || ''}`, error: String(error) }); }
        options.onProgress?.(result); await new Promise<void>(resolve => setImmediate(resolve));
      }
    } catch (error) { result.conflicts.push({ source: 'project-strategy.csv', error: String(error) }); }
    await finish(['project-strategy.csv'], start);
  }
  const cacheKeys = [...captured.keys()].filter(key => key !== 'project-strategy.csv');
  if (cacheKeys.length) {
    const start = result.conflicts.length;
    try {
      if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
      const snapshot = captured.has('pyramid-snapshot.json') ? JSON.parse(captured.get('pyramid-snapshot.json')!.toString('utf8')) : null;
      const metadata = captured.has('pyramid-snapshot-meta.json') ? JSON.parse(captured.get('pyramid-snapshot-meta.json')!.toString('utf8')) : null;
      const abilities = captured.has('ability-registry.csv') ? csv(captured.get('ability-registry.csv')!) : [];
      const sourceHashes = Object.fromEntries(cacheKeys.sort().map(key => [key, hash(captured.get(key)!)]));
      importValue(null, 'cache:legacy', { version: 1, signature: `legacy:${hash(Buffer.from(JSON.stringify(sourceHashes)))}`, engineConfigRevision: metadata?.engineConfigRevision || '', snapshot, legacyMetadata: metadata, derivedRegistries: { abilities } });
    } catch (error) { result.conflicts.push({ source: 'strategy-cache', error: String(error) }); }
    await finish(cacheKeys, start);
  }
  return result;
}
