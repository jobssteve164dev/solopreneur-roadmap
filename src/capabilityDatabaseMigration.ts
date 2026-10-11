import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { UnifiedDataStore } from './db/unifiedDataStore';
import type { MemoryImportOptions, MemoryImportResult } from './memoryDatabaseMigration';

const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const collections = [
  { kind: 'skill', directory: 'skills', installed: 'installed', field: 'skills' },
  { kind: 'mcp', directory: 'mcp', installed: 'servers', field: 'connectors' },
  { kind: 'enhancement', directory: 'enhancements', installed: 'installed', field: 'enhancements' }
];

/** Historical sources are read only by the existing asynchronous migration owner. */
export async function importCapabilityDirectory(store: UnifiedDataStore, sourceRoot: string, options: MemoryImportOptions = {}): Promise<MemoryImportResult> {
  if (path.resolve(sourceRoot) !== path.resolve(store.root)) throw new Error('capability_migration_scope_invalid');
  const root = await fs.promises.realpath(sourceRoot), identity = options.sourceIdentity || `capabilities:${sourceRoot}`;
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, retainedFiles: [], conflicts: [] };
  const capture = async (file: string) => {
    const physical = await fs.promises.realpath(file), relative = path.relative(root, physical);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('migration_source_invalid');
    const before = await fs.promises.lstat(file);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('migration_source_invalid');
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('migration_source_changed');
      bytes = await handle.readFile();
      const after = await handle.stat(), final = await fs.promises.lstat(file);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || final.dev !== before.dev || final.ino !== before.ino || await fs.promises.realpath(file) !== physical) throw new Error('migration_source_changed');
    } finally { await handle.close(); }
    const key = path.relative(sourceRoot, file).split(path.sep).join('/'), source = { identity, key, hash: hash(bytes!) };
    store.captureMigrationSource(source, bytes!, { pending: true });
    result.originalBytes += bytes!.length; result.retainedFiles.push(key);
    return { source, bytes: bytes! };
  };
  for (const collection of collections) {
    if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
    const file = path.join(sourceRoot, collection.directory, 'registry.json');
    let registry: Awaited<ReturnType<typeof capture>> | undefined;
    const conflictStart = result.conflicts.length;
    try {
      registry = await capture(file);
      const parsed = JSON.parse(registry.bytes.toString('utf8'));
      if (!Array.isArray(parsed[collection.field])) throw new Error('capability_registry_invalid');
      const ids = new Set<string>();
      for (const entry of parsed[collection.field]) {
        if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
        let entrySource: { identity: string; key: string; hash: string } | undefined;
        try {
          if (!entry || typeof entry.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.id) || ids.has(entry.id)) throw new Error('capability_identity_invalid');
          ids.add(entry.id);
          const packageRoot = path.join(sourceRoot, collection.directory, collection.installed, entry.id);
          const files: Record<string, string> = { manifest: path.join(packageRoot, `solomap.${collection.kind}.json`), source_lock: path.join(packageRoot, 'source.lock.json') };
          if (collection.kind === 'skill') files.entry_document = path.resolve(sourceRoot, collection.directory, entry.entry || path.join(collection.installed, entry.id, 'package', 'SKILL.md'));
          if (collection.kind === 'enhancement') files.health = path.join(packageRoot, 'health.json');
          const attachments: Array<{ purpose: string; bytes: string }> = [], sources: Array<{ identity: string; key: string; hash: string }> = [];
          for (const [purpose, filename] of Object.entries(files)) {
            try { const captured = await capture(filename); sources.push(captured.source); attachments.push({ purpose, bytes: captured.bytes.toString('base64') }); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            await new Promise<void>(resolve => setImmediate(resolve));
          }
          const bytes = Buffer.from(JSON.stringify({ entry, attachments }));
          entrySource = { identity, key: `${registry.source.key}#entry:${entry.id}`, hash: hash(bytes) };
          store.captureMigrationSource(entrySource, bytes, { pending: true });
          const imported = store.importCapabilityEntry(collection.kind, entry, entrySource, attachments);
          if (imported.unchanged) result.unchanged++; else result.imported++;
          for (const source of sources) store.markMigrationSourceImported(source.identity, source.key);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.conflicts.push({ source: `${registry.source.key}#entry:${String(entry?.id || '')}`, error: message });
          if (entrySource) store.markMigrationSourceConflict(identity, entrySource.key, message);
        }
        options.onProgress?.(result);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (hash((await capture(file)).bytes) !== registry.source.hash) throw new Error('migration_source_changed');
      if (result.conflicts.length === conflictStart) store.markMigrationSourceImported(identity, registry.source.key);
      else store.markMigrationSourceConflict(identity, registry.source.key, 'capability_entry_conflict');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const message = error instanceof Error ? error.message : String(error);
        result.conflicts.push({ source: path.relative(sourceRoot, file).split(path.sep).join('/'), error: message });
        if (registry) store.markMigrationSourceConflict(identity, registry.source.key, message);
      }
    }
  }
  return result;
}
