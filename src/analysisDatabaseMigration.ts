import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { UnifiedDataStore } from './db/unifiedDataStore';
import { archiveUnresolvedMigrationSource, type MemoryImportResult } from './memoryDatabaseMigration';

function hash(bytes: Uint8Array): string { return crypto.createHash('sha256').update(bytes).digest('hex'); }

async function stableJson(file: string): Promise<{ bytes: Buffer; value: any; hash: string; parseError?: string }> {
  const before = await fs.promises.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('migration_source_invalid');
  const bytes = await fs.promises.readFile(file);
  const after = await fs.promises.lstat(file);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('migration_source_changed');
  try { return { bytes, value: JSON.parse(bytes.toString('utf8')), hash: hash(bytes) }; }
  catch { return { bytes, value: null, hash: hash(bytes), parseError: 'analysis_cache_source_invalid' }; }
}

export async function importAnalysisCaches(store: UnifiedDataStore, sourceRoot: string, options: any = {}): Promise<MemoryImportResult> {
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, conflicts: [], retainedFiles: [], interrupted: false };
  const identity = `analysis-caches:${path.resolve(sourceRoot)}`;
  const importFile = async (file: string, projectId: string | null, namespace: string, key: string, transform: (value: any) => unknown = value => value) => {
    if (options.shouldContinue && !options.shouldContinue()) { result.interrupted = true; return; }
    let captured: Awaited<ReturnType<typeof stableJson>>;
    try { captured = await stableJson(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    result.originalBytes += captured.bytes.length;
    result.retainedFiles.push(file);
    const source = { identity, key: path.relative(sourceRoot, file).split(path.sep).join('/'), hash: captured.hash };
    store.markMigrationSourceRechecking(identity, source.key);
    store.captureMigrationSource(source, captured.bytes, { mimeType: 'application/json', encoding: 'utf8' });
    try {
      if (captured.parseError) throw new Error(captured.parseError);
      const imported = store.importAnalysisState(projectId, namespace, key, transform(captured.value), source);
      imported.unchanged ? result.unchanged++ : result.imported++;
      store.markMigrationSourceImported(identity, source.key);
    } catch (error) {
      const message = String(error);
      if (!archiveUnresolvedMigrationSource(store, result, source, captured.bytes, message, options, { displaySource: file, mimeType: 'application/json', projectId })) {
        result.conflicts.push({ source: file, error: message });
        store.markMigrationSourceConflict(identity, source.key, message);
      }
    }
    options.onProgress?.(result);
  };

  await importFile(path.join(sourceRoot, 'usage', 'solomap-usage.json'), null, 'usage', 'local');
  await importFile(path.join(sourceRoot, 'sidebar-core-snapshot-v1.json'), null, 'sidebar', 'core', value => ({ ...value, version: 3 }));

  const projectScopes = Object.entries(options.projectScopes || {}) as Array<[string, string]>;
  for (const [projectRoot, projectId] of projectScopes) {
    if (result.interrupted) break;
    const projectKey = crypto.createHash('sha1').update(projectRoot).digest('hex');
    const conversationCandidates = [
      path.join(sourceRoot, 'conversations', `sidebar-conversation-${projectKey}-v1.json`),
      path.join(sourceRoot, `sidebar-conversation-${projectKey}-v1.json`)
    ];
    for (const file of conversationCandidates) await importFile(file, projectId, 'sidebar', 'conversation', value => ({
      sourceRevision: store.readProjectAnalysisSource(projectId).conversationRevision,
      snapshot: value?.snapshot || value
    }));
    for (const [fileName, key] of [['issues-cache.json', 'issues'], ['pull-requests-cache.json', 'pullRequests'], ['delivery-cache.json', 'delivery'], ['security-cache.json', 'security']] as const) {
      await importFile(path.join(projectRoot, '.solopreneur', fileName), projectId, 'external', key, value => ({
        requestedAt: Date.parse(String(value?.syncedAt || '')) || 0,
        cache: value
      }));
    }
  }
  return result;
}
