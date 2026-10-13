import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { UnifiedDataStore } from './db/unifiedDataStore';
import type { MemoryImportOptions, MemoryImportResult } from './memoryDatabaseMigration';

interface Candidate {
  projectId: string;
  projectPath: string;
  enabled: boolean;
  toolNetworkDisabled: boolean;
  epoch: number;
  updatedAt: string;
  sourceKey: string;
  sourceHash: string;
}

const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

function normalizeCandidate(projectId: string, value: unknown, sourceKey: string, sourceHash: string): Candidate {
  if (!/^[a-f0-9]{64}$/.test(projectId) || !value || typeof value !== 'object') throw new Error('project_autonomy_source_invalid');
  const record = value as Record<string, unknown>;
  const projectPathValue = String(record.projectPath || '').trim();
  if (!projectPathValue) throw new Error('project_autonomy_source_invalid');
  let projectPath: string;
  try { projectPath = fs.realpathSync(projectPathValue); } catch { projectPath = path.resolve(projectPathValue); }
  if (hash(Buffer.from(projectPath)) !== projectId || (record.projectId !== undefined && String(record.projectId) !== projectId)) throw new Error('project_autonomy_identity_invalid');
  const epoch = Number(record.epoch || 0);
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error('project_autonomy_source_invalid');
  return {
    projectId,
    projectPath,
    enabled: Boolean(record.enabled),
    toolNetworkDisabled: Boolean(record.toolNetworkDisabled),
    epoch,
    updatedAt: String(record.updatedAt || ''),
    sourceKey,
    sourceHash
  };
}

/** Historical authorization files are consumed only by the explicit Runtime migration queue. */
export async function importProjectAutonomyAuthorizations(
  store: UnifiedDataStore,
  sourceRoot: string,
  options: MemoryImportOptions = {}
): Promise<MemoryImportResult> {
  if (path.resolve(sourceRoot) !== path.resolve(store.root)) throw new Error('project_autonomy_migration_scope_invalid');
  const identity = options.sourceIdentity || `project-autonomy:${store.root}`;
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, retainedFiles: [], conflicts: [] };
  const candidates = new Map<string, Candidate>();
  const sourceConflicts = new Set<string>();
  const capture = async (file: string, key: string): Promise<{ bytes: Buffer; sourceHash: string }> => {
    const before = await fs.promises.lstat(file);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('migration_source_invalid');
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('migration_source_changed');
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('migration_source_changed');
    } finally { await handle.close(); }
    const sourceHash = hash(bytes!);
    store.captureMigrationSource({ identity, key, hash: sourceHash }, bytes!, { mimeType: 'application/json', encoding: 'utf8', pending: true });
    result.originalBytes += bytes!.length;
    result.retainedFiles.push(key);
    return { bytes: bytes!, sourceHash };
  };
  const conflict = (key: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    sourceConflicts.add(key);
    result.conflicts.push({ source: key, error: message });
    store.markMigrationSourceConflict(identity, key, message);
  };

  const combinedPath = path.join(sourceRoot, 'runtime', 'project-autonomy-authorizations.json');
  try {
    const key = 'runtime/project-autonomy-authorizations.json';
    const captured = await capture(combinedPath, key);
    const parsed = JSON.parse(captured.bytes.toString('utf8')) as { schemaVersion?: unknown; projects?: unknown };
    if (parsed.schemaVersion !== 1 || !parsed.projects || typeof parsed.projects !== 'object' || Array.isArray(parsed.projects)) throw new Error('project_autonomy_source_invalid');
    for (const [projectId, value] of Object.entries(parsed.projects as Record<string, unknown>)) {
      try { candidates.set(projectId, normalizeCandidate(projectId, value, key, captured.sourceHash)); }
      catch (error) { conflict(`${key}#${projectId}`, error); sourceConflicts.add(key); }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') conflict('runtime/project-autonomy-authorizations.json', error);
  }

  const recordsRoot = path.join(sourceRoot, 'runtime', 'project-autonomy-authorizations');
  try {
    for (const entry of (await fs.promises.readdir(recordsRoot, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue;
      const key = `runtime/project-autonomy-authorizations/${entry.name}`;
      try {
        const captured = await capture(path.join(recordsRoot, entry.name), key);
        const projectId = entry.name.slice(0, -'.json'.length);
        candidates.set(projectId, normalizeCandidate(projectId, JSON.parse(captured.bytes.toString('utf8')), key, captured.sourceHash));
      } catch (error) { conflict(key, error); }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') conflict('runtime/project-autonomy-authorizations/', error);
  }

  for (const candidate of candidates.values()) {
    if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
    try {
      const existing = store.readHostSettings({ namespace: 'project_autonomy', ownerScope: 'global' }).items.find(item => item.key === candidate.projectId);
      if (existing) result.unchanged++;
      else {
        const { sourceKey, sourceHash, ...value } = candidate;
        store.patchHostSettings({
          namespace: 'project_autonomy', ownerScope: 'global',
          patches: [{ key: candidate.projectId, expectedRevision: 0, value }],
          idempotencyKey: `project-autonomy-import:${candidate.projectId}:${sourceHash}`
        });
        result.imported++;
      }
      options.onProgress?.(result);
    } catch (error) { conflict(`${candidate.sourceKey}#${candidate.projectId}`, error); sourceConflicts.add(candidate.sourceKey); }
  }
  for (const key of new Set(result.retainedFiles)) {
    if (sourceConflicts.has(key)) store.markMigrationSourceConflict(identity, key, 'project_autonomy_entry_conflict');
    else store.markMigrationSourceImported(identity, key);
  }
  return result;
}
