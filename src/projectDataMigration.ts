import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { UnifiedDataStore } from './db/unifiedDataStore';
import { SqliteStore } from './db/sqliteStore';
import type { MemoryImportResult } from './memoryDatabaseMigration';

const digest = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');

async function stableFile(file: string): Promise<{ bytes: Buffer; hash: string }> {
  const before = await fs.promises.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('migration_source_invalid');
  const bytes = await fs.promises.readFile(file); const after = await fs.promises.lstat(file);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('migration_source_changed');
  return { bytes, hash: digest(bytes) };
}

export async function importProjectJournal(store: UnifiedDataStore, source: string, options: any = {}): Promise<MemoryImportResult> {
  const projectRoot = String(options.projectRoot || ''); const identity = `project-journal:${projectRoot}`;
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, conflicts: [], retainedFiles: [source], interrupted: false };
  const captured = await stableFile(source); result.originalBytes = captured.bytes.length;
  store.captureMigrationSource({ identity, key: path.basename(source), hash: captured.hash }, captured.bytes, { mimeType: 'application/x-sqlite3', encoding: 'binary' });
  const project = await store.registerProject({ root: projectRoot }); const legacy = new SqliteStore(source, path.resolve(__dirname, '..'));
  try {
    await legacy.initJournalReadOnly();
    for (const entry of legacy.getAllExecutionLogsRaw().reverse()) { if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true }; store.importProjectJournal(project.projectId, entry); result.imported++; if (result.imported % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve)); }
    for (const entry of legacy.getRunIndexEntries()) store.upsertProjectRunIndex(project.projectId, entry, entry.files, entry.signals);
  } finally { legacy.close(); }
  store.markMigrationSourceImported(identity, path.basename(source));
  return result;
}

async function filesUnder(root: string, onConflict: (source: string, error: unknown) => void): Promise<string[]> {
  const files: string[] = []; const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch (error) { onConflict(directory, error); continue; }
    for (const entry of entries) { const file = path.join(directory, entry.name); if (entry.isDirectory()) pending.push(file); else if (entry.isFile() && !entry.isSymbolicLink()) files.push(file); }
  }
  return files.sort();
}

/** Files whose live consumers have already moved to the global database. */
export function isRetirableRunArtifact(_relativePath: string): boolean {
  // Run files still participate in settlement, rollback, statistics, reports, and
  // native-session recovery. They are archived in the database but stay local
  // until every live reader has moved to the database.
  return false;
}

export async function importAgentRuns(store: UnifiedDataStore, sourceRoot: string, options: any = {}): Promise<MemoryImportResult> {
  const projectRoot = String(options.projectRoot || ''); const identity = `agent-runs:${projectRoot}`;
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, conflicts: [], retainedFiles: [], interrupted: false };
  const project = await store.registerProject({ root: projectRoot });
  const files = await filesUnder(sourceRoot, (source, error) => result.conflicts.push({ source, error: String(error) }));
  for (const file of files) {
    if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
    try {
      const relativePath = path.relative(sourceRoot, file); const captured = await stableFile(file); result.originalBytes += captured.bytes.length; result.retainedFiles.push(file);
      store.captureMigrationSource({ identity, key: relativePath, hash: captured.hash }, captured.bytes, { mimeType: 'application/octet-stream', encoding: 'binary' });
      const executionLogId = Number([...relativePath.split(path.sep)].reverse().find(part => /^\d+$/.test(part)) || 0);
      const artifact = store.readRunArtifact(project.projectId, executionLogId, relativePath);
      if (artifact?.hash === captured.hash) result.unchanged++;
      else if (artifact) result.conflicts.push({ source: file, error: 'migration_target_changed' });
      else {
        store.writeRunArtifact(project.projectId, { executionLogId, relativePath, bytes: captured.bytes.toString('base64'), hash: captured.hash });
        if (isRetirableRunArtifact(relativePath)) store.markMigrationSourceImported(identity, relativePath);
        result.imported++;
      }
    } catch (error) { result.conflicts.push({ source: file, error: String(error) }); }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return result;
}

export async function importProjectGrowth(store: UnifiedDataStore, source: string, options: any = {}): Promise<MemoryImportResult> {
  const projectRoot = String(options.projectRoot || ''); const identity = `project-growth:${projectRoot}`;
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, conflicts: [], retainedFiles: [source], interrupted: false };
  const captured = await stableFile(source); result.originalBytes = captured.bytes.length;
  const sourceState = store.captureMigrationSource({ identity, key: path.basename(source), hash: captured.hash }, captured.bytes, { mimeType: 'application/x-sqlite3', encoding: 'binary' });
  if (sourceState.unchanged && sourceState.stage === 'imported') { result.unchanged = 1; return result; }
  const project = await store.registerProject({ root: projectRoot }); const legacy = new SqliteStore(source, path.resolve(__dirname, '..'));
  try {
    await legacy.initReadOnly();
    for (const row of legacy.getAllGrowthSnapshotHistory().reverse()) {
      if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
      const snapshot = legacy.getGrowthSnapshotById(row.id);
      if (snapshot) { store.writeProjectGrowth(project.projectId, snapshot, `legacy-growth:${project.projectId}:${row.id}`); result.imported++; }
      // A legacy snapshot can contain tens of thousands of rows. Let control,
      // task-start, and live database requests run between every snapshot.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  } finally { legacy.close(); }
  store.markMigrationSourceImported(identity, path.basename(source));
  return result;
}
