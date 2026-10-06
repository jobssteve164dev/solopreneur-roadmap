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
    for (const entry of legacy.getAllExecutionLogs().reverse()) { if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true }; store.importProjectJournal(project.projectId, entry); result.imported++; if (result.imported % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve)); }
    for (const entry of legacy.getRunIndexEntries()) store.upsertProjectRunIndex(project.projectId, entry, entry.files, entry.signals);
  } finally { legacy.close(); }
  store.markMigrationSourceImported(identity, path.basename(source));
  return result;
}

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = []; const pending = [root];
  while (pending.length) { const directory = pending.pop()!; for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) pending.push(file); else if (entry.isFile() && !entry.isSymbolicLink()) files.push(file); } }
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
  for (const file of await filesUnder(sourceRoot)) {
    if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
    const relativePath = path.relative(sourceRoot, file); const captured = await stableFile(file); result.originalBytes += captured.bytes.length; result.retainedFiles.push(file);
    const capture = store.captureMigrationSource({ identity, key: relativePath, hash: captured.hash }, captured.bytes, { mimeType: 'application/octet-stream', encoding: 'binary' });
    if (capture.unchanged) { result.unchanged++; continue; }
    const executionLogId = Number([...relativePath.split(path.sep)].reverse().find(part => /^\d+$/.test(part)) || 0);
    store.writeRunArtifact(project.projectId, { executionLogId, relativePath, bytes: captured.bytes.toString('base64'), hash: captured.hash });
    if (isRetirableRunArtifact(relativePath)) store.markMigrationSourceImported(identity, relativePath);
    result.imported++;
    if (result.imported % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
  return result;
}

export async function importProjectGrowth(store: UnifiedDataStore, source: string, options: any = {}): Promise<MemoryImportResult> {
  const projectRoot = String(options.projectRoot || ''); const identity = `project-growth:${projectRoot}`;
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, conflicts: [], retainedFiles: [source], interrupted: false };
  const captured = await stableFile(source); result.originalBytes = captured.bytes.length;
  const sourceState = store.captureMigrationSource({ identity, key: path.basename(source), hash: captured.hash }, captured.bytes, { mimeType: 'application/x-sqlite3', encoding: 'binary' });
  if (sourceState.unchanged) { result.unchanged = 1; return result; }
  const project = await store.registerProject({ root: projectRoot }); const legacy = new SqliteStore(source, path.resolve(__dirname, '..'));
  try {
    await legacy.initReadOnly();
    for (const row of legacy.getAllGrowthSnapshotHistory().reverse()) {
      if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
      const snapshot = legacy.getGrowthSnapshotById(row.id);
      if (snapshot) { store.writeProjectGrowth(project.projectId, snapshot, `legacy-growth:${project.projectId}:${row.id}`); result.imported++; }
      if (result.imported % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
  } finally { legacy.close(); }
  store.markMigrationSourceImported(identity, path.basename(source));
  return result;
}
