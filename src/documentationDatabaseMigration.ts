import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { DocumentationManifest } from './documentationManifest';
import { UnifiedDataStore } from './db/unifiedDataStore';
import type { MemoryImportOptions, MemoryImportResult } from './memoryDatabaseMigration';

const digest = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
interface DocumentationImportOptions extends MemoryImportOptions { projectRoot?: string }

/** Imports the retired project documentation index without changing the source file. */
export async function importDocumentationManifest(store: UnifiedDataStore, sourceRoot: string, options: DocumentationImportOptions = {}): Promise<MemoryImportResult> {
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, retainedFiles: [], conflicts: [] };
  const projectRoot = path.resolve(String(options.projectRoot || ''));
  const expected = path.join(projectRoot, '.solopreneur', 'documentation.json');
  if (!path.isAbsolute(String(options.projectRoot || '')) || path.resolve(sourceRoot) !== expected) throw new Error('documentation_migration_scope_invalid');
  const projectPhysical = await fs.promises.realpath(projectRoot);
  const before = await fs.promises.lstat(sourceRoot);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('migration_source_invalid');
  const physical = await fs.promises.realpath(sourceRoot);
  const relative = path.relative(projectPhysical, physical);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('migration_source_invalid');
  const handle = await fs.promises.open(sourceRoot, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('migration_source_changed');
    bytes = await handle.readFile();
    const after = await handle.stat(), final = await fs.promises.lstat(sourceRoot);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || final.dev !== before.dev || final.ino !== before.ino || await fs.promises.realpath(sourceRoot) !== physical) throw new Error('migration_source_changed');
  } finally { await handle.close(); }
  const identity = options.sourceIdentity || `documentation:${projectPhysical}`;
  const key = '.solopreneur/documentation.json';
  const source = { identity, key, hash: digest(bytes) };
  result.originalBytes = bytes.length;
  result.retainedFiles.push(key);
  store.captureMigrationSource(source, bytes, { mimeType: 'application/json', encoding: 'utf8', pending: true });
  try {
    const manifest = JSON.parse(bytes.toString('utf8')) as DocumentationManifest;
    if (!manifest || !Array.isArray(manifest.documents) || !Array.isArray(manifest.pendingReview)) throw new Error('invalid_documentation_manifest');
    const project = await store.registerProject({ root: projectRoot });
    const imported = store.importDocumentationManifest(project.projectId, { manifest, source });
    if (imported.unchanged) result.unchanged++; else result.imported++;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (store.migrationSourceState(identity, key)?.stage !== 'conflict') store.markMigrationSourceConflict(identity, key, message);
    result.conflicts.push({ source: key, error: message });
  }
  options.onProgress?.(result);
  return result;
}
