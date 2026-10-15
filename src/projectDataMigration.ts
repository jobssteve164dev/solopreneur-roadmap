import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isDeepStrictEqual } from 'util';
import { UnifiedDataStore } from './db/unifiedDataStore';
import { SqliteStore } from './db/sqliteStore';
import type { MemoryImportResult } from './memoryDatabaseMigration';
import type { RunIndexEntry, RunIndexRecord } from './db/types';
import { extractTokenUsageFromOutput, normalizeTokenUsage, extractCodexTranscriptUsage, extractClaudeTranscriptUsage, findClaudeTranscript } from './tokenUsage';
import { findCodexTranscriptFile, getContinuationAgentProvider } from './continuation';
import { containedRegularPath, readRegisteredTaskSources } from './growthReports.js';
import { assertVersion2Binding, NativeSessionBinding } from './sessionIdentity.js';
import { runArtifactKind, shouldDescendRunArtifactDirectory } from './runArtifactPolicy.js';

const digest = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');

async function resolveProjectDatabaseSource(projectRoot: string, source: string, fileName: string): Promise<{ projectRoot: string; source: string }> {
  const declaredSource = await fs.promises.lstat(source);
  if (!declaredSource.isFile() || declaredSource.isSymbolicLink()) throw new Error('migration_source_invalid');
  const physicalProjectRoot = await fs.promises.realpath(projectRoot);
  const physicalSource = await fs.promises.realpath(source);
  if (physicalSource !== path.join(physicalProjectRoot, '.solopreneur', fileName)) {
    throw new Error('migration_source_scope_mismatch');
  }
  const stat = await fs.promises.lstat(physicalSource);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('migration_source_invalid');
  return { projectRoot: physicalProjectRoot, source: physicalSource };
}

async function captureSqliteSnapshot(
  source: string,
  initialize: (store: SqliteStore) => Promise<void>
): Promise<{ source: string; snapshot: string; bytes: Buffer; hash: string; cleanup(): Promise<void> }> {
  const before = await fs.promises.lstat(source);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('migration_source_invalid');
  const capturedSource = await stableFile(source);
  const snapshot = path.join(os.tmpdir(), `solomap-migration-snapshot-${crypto.randomUUID()}.db`);
  const cleanup = async () => {
    for (const file of [`${snapshot}-shm`, `${snapshot}-wal`, snapshot]) {
      try { await fs.promises.unlink(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  };
  const legacy = new SqliteStore(source, path.resolve(__dirname, '..'));
  try {
    try {
      await initialize(legacy);
      await legacy.backup(snapshot);
    } finally {
      legacy.close();
    }
    const after = await fs.promises.lstat(source);
    if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('migration_source_changed');
    const currentSource = await stableFile(source);
    if (currentSource.hash !== capturedSource.hash) throw new Error('migration_source_changed');
    await stableFile(snapshot);
    return {
      source,
      snapshot,
      ...capturedSource,
      cleanup
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function stableFile(file: string): Promise<{ bytes: Buffer; hash: string }> {
  const before = await fs.promises.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('migration_source_invalid');
  const bytes = await fs.promises.readFile(file); const after = await fs.promises.lstat(file);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('migration_source_changed');
  return { bytes, hash: digest(bytes) };
}

function isAppendedHistoricalOutput(store: UnifiedDataStore, projectId: string, executionLogId: number, relativePath: string, current: { bytes: Buffer; hash: string }): boolean {
  if (runArtifactKind(relativePath) !== 'output') return false;
  const archived = store.readRunArtifactBytes(projectId, executionLogId, relativePath);
  return Boolean(archived && current.bytes.length > archived.bytes.length && digest(archived.bytes) === archived.hash
    && digest(current.bytes.subarray(0, archived.bytes.length)) === archived.hash);
}

export async function initializeProjectJournalAllocation(store: UnifiedDataStore, projectRoot: string): Promise<number> {
  const physicalProjectRoot = await fs.promises.realpath(projectRoot);
  const project = await store.registerProject({ root: physicalProjectRoot });
  const reserved = store.readProjectJournalMinimum(project.projectId);
  if (reserved !== null) return reserved;
  const declaredSource = path.join(projectRoot, '.solopreneur', 'project_journal.db');
  try { const stat = await fs.promises.lstat(declaredSource); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('migration_source_invalid'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return store.reserveProjectJournalIds(project.projectId, 1); throw error; }
  const source = (await resolveProjectDatabaseSource(projectRoot, declaredSource, 'project_journal.db')).source;
  const legacy = new SqliteStore(source, path.resolve(__dirname, '..'));
  try {
    await legacy.initJournalReadOnly();
    return store.reserveProjectJournalIds(project.projectId, legacy.getLastExecutionLogId() + 1);
  } finally { legacy.close(); }
}

export async function importProjectJournal(store: UnifiedDataStore, source: string, options: any = {}): Promise<MemoryImportResult> {
  const projectRoot = String(options.projectRoot || ''); const identity = `project-journal:${projectRoot}`;
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, conflicts: [], retainedGaps: [], retainedFiles: [source], interrupted: false };
  if (options.mode === 'unified') {
    const project = await store.registerProject({ root: projectRoot });
    if (source !== `solomap://${store.databaseId}/${project.projectId}/project-journal`) throw new Error('migration_source_scope_mismatch');
    result.retainedFiles = [];
    for (;;) {
      const ids = store.missingProjectJournalSources(project.projectId);
      if (!ids.length) return result;
      for (const id of ids) {
        if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
        store.syncProjectJournalSource(project.projectId, id); result.imported++;
        options.onProgress?.(result);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
  }
  const { projectRoot: physicalProjectRoot, source: physicalSource } = await resolveProjectDatabaseSource(projectRoot, source, 'project_journal.db');
  store.markMigrationSourceRechecking(identity, path.basename(source));
  const captured = await captureSqliteSnapshot(physicalSource, legacy => legacy.initJournalReadOnly()); result.originalBytes = captured.bytes.length;
  try {
  store.captureMigrationSource({ identity, key: path.basename(source), hash: captured.hash }, captured.bytes, { mimeType: 'application/x-sqlite3', encoding: 'binary' });
  const project = await store.registerProject({ root: physicalProjectRoot }); const legacy = new SqliteStore(captured.snapshot, path.resolve(__dirname, '..'));
  try {
    await legacy.initJournalReadOnly();
    store.reserveProjectJournalIds(project.projectId, legacy.getLastExecutionLogId() + 1);
    for (let offset = 0; ; offset += 200) {
      const page = legacy.getExecutionJournalPageRaw({ limit: 200, offset });
      for (const entry of page.logs) {
        if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
        store.importProjectJournal(project.projectId, entry); result.imported++;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (!page.hasMore) break;
    }
    for (let offset = 0; ; offset += 200) {
      const indexes = legacy.getRunIndexEntries(200, offset);
      for (const entry of indexes) {
        if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
        try {
          const enriched = await enrichHistoricalIndex(store, project.projectId, projectRoot, entry, error => result.retainedGaps!.push({ source: `${source}#run:${entry.executionLogId}`, error }));
          const { files: _files, signals: _signals, ...sourceRecord } = entry;
          store.importHistoricalRunIndex(project.projectId, enriched, entry.files, entry.signals, { identity, key: path.basename(source), hash: captured.hash }, 20, sourceRecord);
        } catch (error) { result.conflicts.push({ source: `${source}#run:${entry.executionLogId}`, error: String(error) }); }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (indexes.length < 200) break;
    }
  } finally { legacy.close(); }
  if (result.conflicts.length) store.markMigrationSourceConflict(identity, path.basename(source), JSON.stringify(result.conflicts));
  else store.markMigrationSourceImported(identity, path.basename(source));
  return result;
  } finally { await captured.cleanup(); }
}

async function captureHistoricalOutput(store: UnifiedDataStore, projectId: string, projectRoot: string, file: string, executionLogId: number, artifactKind: 'output' | 'session'): Promise<string> {
  const runRoot = path.join(await fs.promises.realpath(projectRoot), '.solopreneur', 'agent-runs');
  const declared = path.resolve(projectRoot, file);
  let declaredRelative = path.relative(path.join(path.resolve(projectRoot), '.solopreneur', 'agent-runs'), declared);
  if (!declaredRelative || declaredRelative.startsWith('..') || path.isAbsolute(declaredRelative)) declaredRelative = path.relative(runRoot, declared);
  if (!declaredRelative || declaredRelative.startsWith('..') || path.isAbsolute(declaredRelative)) throw new Error('historical_run_output_scope_mismatch');
  let resolved: string;
  try { resolved = await fs.promises.realpath(declared); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const archived = store.readRunArtifactBytes(projectId, executionLogId, declaredRelative);
    if (!archived) throw error;
    const bytes = archived.bytes;
    if (digest(bytes) !== archived.hash) throw new Error('historical_run_output_hash_mismatch');
    store.captureMigrationSource({ identity: `agent-runs:${projectRoot}`, key: declaredRelative, hash: archived.hash }, bytes, { mimeType: archived.mimeType, encoding: 'binary', sourceKind: artifactKind });
    store.writeHistoricalRunArtifact(projectId, { executionLogId, relativePath: declaredRelative, bytes: archived.bytes, hash: archived.hash, mimeType: archived.mimeType }, artifactKind);
    return bytes.toString('utf8');
  }
  const relative = path.relative(runRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('historical_run_output_scope_mismatch');
  const captured = await stableFile(resolved);
  store.captureMigrationSource({ identity: `agent-runs:${projectRoot}`, key: relative, hash: captured.hash }, captured.bytes, { mimeType: 'text/plain', encoding: 'utf8', sourceKind: artifactKind });
  const previous = store.readRunArtifactMetadata(projectId, executionLogId, relative);
  if (previous && previous.hash !== captured.hash) throw new Error('migration_target_changed');
  store.writeHistoricalRunArtifact(projectId, { executionLogId, relativePath: relative, bytes: captured.bytes, hash: captured.hash }, artifactKind);
  return captured.bytes.toString('utf8');
}

async function enrichHistoricalIndex(store: UnifiedDataStore, projectId: string, projectRoot: string, entry: RunIndexEntry, onGap: (error: string) => void): Promise<RunIndexRecord> {
  const { files: _files, signals: _signals, ...record } = entry;
  if (!record.outputPath) return record;
  try {
    let output = '';
    try { output = await captureHistoricalOutput(store, projectId, projectRoot, record.outputPath, record.executionLogId, 'output'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; onGap('historical_run_output_missing'); }
    if (normalizeTokenUsage(record).totalTokens > 0) return record;
    const usage = extractTokenUsageFromOutput(output, record.agentCli);
    if (usage.totalTokens > 0) return { ...record, ...usage };
    const runDirectory = path.dirname(path.isAbsolute(record.outputPath) ? record.outputPath : path.join(projectRoot, record.outputPath));
    const sessionText = await captureHistoricalOutput(store, projectId, projectRoot, path.join(runDirectory, 'session.json'), record.executionLogId, 'session');
    const sessionId = String(JSON.parse(sessionText).sessionId || '').trim();
    if (!sessionId) return record;
    const family = path.basename(record.agentCli).toLowerCase(); let transcript = '';
    if (/^codex(?:-cli)?$/.test(family)) {
      let home = path.join(process.env.HOME || '', '.codex');
      try { home = (await captureHistoricalOutput(store, projectId, projectRoot, path.join(runDirectory, 'codex-home.txt'), record.executionLogId, 'session')).trim() || home; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      transcript = findCodexTranscriptFile(home, sessionId);
    } else if (/^claude(?:-code|-code-cli)?$/.test(family)) transcript = findClaudeTranscript(projectRoot, record.startedAt, sessionId);
    if (!transcript) return record;
    const captured = await stableFile(transcript); const body = captured.bytes.toString('utf8');
    const physicalRoot = await fs.promises.realpath(projectRoot);
    const checkedRoots = new Set<string>();
    for (const line of body.split(/\r?\n/)) {
      let event: any; try { event = JSON.parse(line); } catch { continue; }
      const cwd = event?.type === 'session_meta' ? event.payload?.cwd : event.cwd;
      if (cwd && !checkedRoots.has(cwd)) {
        let physicalCwd: string;
        try { physicalCwd = await fs.promises.realpath(cwd); }
        catch { throw new Error('historical_native_session_scope_mismatch'); }
        if (physicalCwd !== physicalRoot) throw new Error('historical_native_session_scope_mismatch');
        checkedRoots.add(cwd);
      }
    }
    store.captureMigrationSource({ identity: `native-token-evidence:${projectId}`, key: `${family}/${sessionId}/${path.basename(transcript)}`, hash: captured.hash }, captured.bytes, { mimeType: 'application/x-ndjson', encoding: 'utf8' });
    const start = Date.parse(record.startedAt); const end = Date.parse(record.finishedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) { onGap('historical_token_window_missing'); return record; }
    return { ...record, ...(/^codex(?:-cli)?$/.test(family) ? extractCodexTranscriptUsage(body, record.startedAt, record.finishedAt) : extractClaudeTranscriptUsage(body, record.startedAt, record.finishedAt)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return record;
    throw error;
  }
}

async function filesUnder(root: string, onConflict: (source: string, error: unknown) => void, reportSymlinks = false): Promise<string[]> {
  const files: string[] = []; const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch (error) { onConflict(directory, error); continue; }
    for (const entry of entries) { const file = path.join(directory, entry.name); if (entry.isSymbolicLink()) { if (reportSymlinks) onConflict(file, new Error('migration_source_invalid')); } else if (entry.isDirectory()) pending.push(file); else if (entry.isFile()) files.push(file); }
  }
  return files.sort();
}

async function durableRunFilesUnder(root: string, onConflict: (source: string, error: unknown) => void): Promise<string[]> {
  const files: string[] = []; const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch (error) { onConflict(directory, error); continue; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name); const relative = path.relative(root, file); const parts = relative.split(path.sep);
      if (entry.isSymbolicLink()) { if (runArtifactKind(relative)) onConflict(file, new Error('migration_source_invalid')); continue; }
      if (entry.isFile()) { if (runArtifactKind(relative)) files.push(file); continue; }
      if (!entry.isDirectory()) continue;
      // Durable files only exist directly under a node, a numeric run, or learning-tasks.
      // Do not walk evidence/build/download directories that can contain entire toolchains.
      if (shouldDescendRunArtifactDirectory(relative)) pending.push(file);
    }
  }
  return files.sort();
}

/** Files whose live consumers have already moved to the global database. */
export function isRetirableRunArtifact(relativePath: string): boolean {
  return runArtifactKind(relativePath) !== null;
}

export async function importAgentRuns(store: UnifiedDataStore, sourceRoot: string, options: any = {}): Promise<MemoryImportResult> {
  const projectRoot = String(options.projectRoot || ''); const identity = `agent-runs:${projectRoot}`;
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, conflicts: [], retainedFiles: [], interrupted: false };
  const project = await store.registerProject({ root: projectRoot });
  const resolvedRoot = await fs.promises.realpath(projectRoot);
  const sourceInfo = await fs.promises.lstat(sourceRoot);
  if (sourceInfo.isSymbolicLink() || await fs.promises.realpath(sourceRoot) !== path.join(resolvedRoot, '.solopreneur', 'agent-runs')) throw new Error('migration_source_scope_mismatch');
  const files = await durableRunFilesUnder(sourceRoot, (source, error) => result.conflicts.push({ source, error: String(error) }));
  const statusRoot = path.join(projectRoot, '.solopreneur', 'agent-status');
  const projectStatus = path.join(projectRoot, '.agent_status.json');
  const statusFiles = files.filter(file => path.basename(file) === '.agent_status.json');
  try { await fs.promises.lstat(projectStatus); statusFiles.push(projectStatus); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.conflicts.push({ source: projectStatus, error: String(error) }); }
  try {
    const statusInfo = await fs.promises.lstat(statusRoot);
    if (statusInfo.isSymbolicLink() || !statusInfo.isDirectory() || await fs.promises.realpath(statusRoot) !== path.join(resolvedRoot, '.solopreneur', 'agent-status')) throw new Error('historical_run_status_scope_mismatch');
    statusFiles.push(...await filesUnder(statusRoot, (source, error) => result.conflicts.push({ source, error: String(error) }), true));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.conflicts.push({ source: statusRoot, error: String(error) }); }
  const uniqueStatusFiles = [...new Set(statusFiles)];
  const liveStatusFiles = new Set<string>();
  const liveRunDirectories = new Set<string>();
  for (const statusFile of uniqueStatusFiles) {
    try {
      const status = JSON.parse((await stableFile(statusFile)).bytes.toString('utf8'));
      if (!status || typeof status !== 'object' || !store.historicalRunOwnerAlive(status)) continue;
      const declared = ['sessionFilePath', 'promptFilePath', 'commandFilePath', 'outputFilePath']
        .map(field => String(status[field] || '').trim()).filter(Boolean).map(file => path.dirname(path.resolve(file)));
      if (new Set(declared).size !== 1) continue;
      const directory = declared[0], relative = path.relative(sourceRoot, directory), parts = relative.split(path.sep);
      const executionLogId = Number(status.rootExecutionLogId || status.executionLogId);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && parts[0] === status.nodeId
        && (parts.length === 1 || parts.length === 2 && Number(parts[1]) === executionLogId)) {
        liveRunDirectories.add(directory);
        liveStatusFiles.add(statusFile);
      }
    } catch {
      // Invalid sources are handled by the normal importer and remain visible as conflicts.
    }
  }
  const filesByNode = new Map<string, string[]>();
  for (const file of files) {
    const node = path.relative(sourceRoot, file).split(path.sep)[0];
    if (!filesByNode.has(node)) filesByNode.set(node, []);
    filesByNode.get(node)!.push(file);
  }
  const runs = new Map<string, Map<string, { file: string; hash: string; executionLogId: number; modifiedAt: number }>>();
  const conflictingRuns = new Set<string>();
  const appendedOutputs = new Set<string>();
  const lateChangeEvidence = new Map<string, { file: string; executionLogId: number }>();
  const runDirectory = (relative: string) => { const parts = relative.split(path.sep); return parts.length >= 3 && /^\d+$/.test(parts[1]) ? parts.slice(0, 2).join(path.sep) : parts[0]; };
  for (const file of files) {
    if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
    if ([...liveRunDirectories].some(directory => file === directory || file.startsWith(`${directory}${path.sep}`))) {
      const captured = await stableFile(file); result.originalBytes += captured.bytes.length; result.retainedFiles.push(file); result.unchanged++;
      continue;
    }
    try {
      const relativePath = path.relative(sourceRoot, file); const captured = await stableFile(file); result.originalBytes += captured.bytes.length; result.retainedFiles.push(file);
      store.captureMigrationSource({ identity, key: relativePath, hash: captured.hash }, captured.bytes, { mimeType: 'application/octet-stream', encoding: 'binary' });
      const parts = relativePath.split(path.sep);
      const legacyArtifactId = /^\d+$/.test(parts[0]) && store.readRunArtifactMetadata(project.projectId, Number(parts[0]), relativePath) ? Number(parts[0]) : 0;
      const executionLogId = parts.length >= 3 && /^\d+$/.test(parts[1]) ? Number(parts[1]) : legacyArtifactId;
      let artifact = store.readRunArtifactMetadata(project.projectId, executionLogId, relativePath);
      if (artifact?.hash === captured.hash) result.unchanged++;
      else if (artifact && isAppendedHistoricalOutput(store, project.projectId, executionLogId, relativePath, captured)) appendedOutputs.add(relativePath);
      else if (artifact && ['changes.txt', 'touched-files.txt'].includes(path.basename(relativePath))) lateChangeEvidence.set(relativePath, { file, executionLogId });
      else if (artifact) { result.conflicts.push({ source: file, error: 'migration_target_changed' }); conflictingRuns.add(runDirectory(relativePath)); }
      else {
        store.writeRunArtifact(project.projectId, { executionLogId, relativePath, bytes: captured.bytes, hash: captured.hash });
        result.imported++;
      }
      if (!artifact || artifact.hash === captured.hash || appendedOutputs.has(relativePath)) {
        const name = path.basename(file);
        if (['command.txt', 'output.log', 'completion.json', 'started_at', 'touched-files.txt', 'changes.txt', 'prompt.txt', '.agent_status.json'].includes(name)) {
          const directory = path.dirname(relativePath);
          if (!runs.has(directory)) runs.set(directory, new Map());
          runs.get(directory)!.set(name, { file: relativePath, hash: captured.hash, executionLogId, modifiedAt: (await fs.promises.stat(file)).mtimeMs });
        }
      }
    } catch (error) { result.conflicts.push({ source: file, error: String(error) }); conflictingRuns.add(runDirectory(path.relative(sourceRoot, file))); }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const appendedRunDirectories = new Set([...appendedOutputs].map(runDirectory));
  for (const [relativePath, changed] of lateChangeEvidence) {
    if (appendedRunDirectories.has(runDirectory(relativePath))) continue;
    result.conflicts.push({ source: changed.file, error: 'migration_target_changed' });
    conflictingRuns.add(runDirectory(relativePath));
  }
  // Registered envelopes bind reports to tasks and execution identities; directory names
  // alone are never sufficient to manufacture those relationships.
  const registered = readRegisteredTaskSources(projectRoot);
  for (const task of registered.tasks) {
    if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
    const taskFile = path.join(sourceRoot, 'learning-tasks', `${task.taskId}.json`);
    try {
      if (typeof task.userMessage !== 'string' || !containedRegularPath(projectRoot, taskFile)) throw new Error('legacy_task_invalid');
      const captured = await stableFile(taskFile);
      if (captured.hash !== task.sourceHash) throw new Error('migration_source_changed');
      const taskId = store.importRegisteredReportTask(project.projectId, { identity, key: path.relative(sourceRoot, taskFile), hash: captured.hash }, captured.bytes, {
        taskId: task.taskId, userMessage: task.userMessage, startedAt: String(task.startedAt || ''), executions: task.executions.map((run: any) => {
          const relative = path.relative(sourceRoot, path.resolve(run.runDir));
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('legacy_task_execution_scope_mismatch');
          return { id: run.id, nodeId: relative.split(path.sep)[0] };
        })
      });
      for (const observation of registered.observations.filter(item => item.taskId === task.taskId)) {
        if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
        try {
          const owners = registered.observations.filter(item => item.file === observation.file);
          const recorded = owners.find(item => item.availability === 'recorded');
          if (recorded && recorded !== observation) continue;
          if (!recorded && new Set(owners.map(item => JSON.stringify([item.taskId, item.executionLogId, item.sequence]))).size > 1) throw new Error('legacy_report_source_ambiguous');
          const reportSource = await stableFile(observation.file);
          if (reportSource.hash !== observation.hash) throw new Error('migration_source_changed');
          store.importRegisteredReport(project.projectId, taskId, observation, { identity, key: path.relative(sourceRoot, observation.file), hash: reportSource.hash }, reportSource.bytes);
        } catch (error) { result.conflicts.push({ source: observation.file, error: String(error) }); }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    } catch (error) { result.conflicts.push({ source: taskFile, error: String(error) }); }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  for (const file of uniqueStatusFiles) {
    if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
    if (liveStatusFiles.has(file)) {
      if (!files.includes(file)) { const captured = await stableFile(file); result.originalBytes += captured.bytes.length; result.retainedFiles.push(file); result.unchanged++; }
      continue;
    }
    const external = !files.includes(file), statusIdentity = file === projectStatus ? `project-agent-status:${projectRoot}` : external ? `agent-status:${projectRoot}` : identity;
    const key = file === projectStatus ? '.agent_status.json' : path.relative(external ? statusRoot : sourceRoot, file);
    let captured: Awaited<ReturnType<typeof stableFile>> | undefined;
    try {
      captured = await stableFile(file);
      if (external) { result.originalBytes += captured.bytes.length; result.retainedFiles.push(file); }
      store.captureMigrationSource({ identity: statusIdentity, key, hash: captured.hash }, captured.bytes, { mimeType: 'application/json', encoding: 'utf8' });
      const status = JSON.parse(captured.bytes.toString('utf8'));
      const id = Number(status.rootExecutionLogId || status.executionLogId);
      const matchingTasks = registered.tasks.filter(task => (!status.learningTaskId || task.taskId === status.learningTaskId) && task.executions.some((run: { id: number }) => run.id === id));
      const candidates = matchingTasks.flatMap(task => task.executions.filter((run: { id: number; runDir: string }) => run.id === id));
      const unregistered = candidates.length === 0 && !registered.tasks.some(task => task.executions.some((run: { id: number }) => run.id === id));
      const pathFields = ['sessionFilePath', 'promptFilePath', 'commandFilePath', 'outputFilePath', 'codexHomeFilePath', 'completionDecisionFilePath', 'workspaceSnapshotPath', 'changesFilePath', 'roadmapBackupFilePath'];
      let retiredWorkspaceRoot: string | undefined;
      if (unregistered && typeof status.workspaceRoot === 'string' && path.isAbsolute(status.workspaceRoot)) {
        const retiredRoot = path.resolve(status.workspaceRoot);
        if (retiredRoot !== resolvedRoot) {
          let retired = false;
          try { await fs.promises.realpath(retiredRoot); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') retired = true; else throw error; }
          if (retired) {
            const declared = pathFields.filter(field => typeof status[field] === 'string' && status[field]);
            for (const field of declared) {
              const relative = path.relative(retiredRoot, path.resolve(status[field]));
              if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('historical_run_workspace_mismatch');
            }
            retiredWorkspaceRoot = retiredRoot;
          }
        }
      }
      let retiredAgentRunsRoot: string | undefined;
      if (unregistered && !retiredWorkspaceRoot) {
        const declared = pathFields.filter(field => typeof status[field] === 'string' && status[field]);
        const roots = new Set<string>();
        let eligible = declared.length > 0;
        for (const field of declared) {
          const declaredFile = String(status[field]);
          if (!path.isAbsolute(declaredFile)) { eligible = false; break; }
          let directory = path.dirname(path.resolve(declaredFile));
          for (;;) {
            if (path.basename(directory) === 'agent-runs' && path.basename(path.dirname(directory)) === '.solopreneur') { roots.add(directory); break; }
            const parent = path.dirname(directory);
            if (parent === directory) { eligible = false; break; }
            directory = parent;
          }
          if (!eligible) break;
        }
        const retiredRoot = roots.size === 1 ? [...roots][0] : '';
        if (!retiredRoot || retiredRoot === path.join(resolvedRoot, '.solopreneur', 'agent-runs')) eligible = false;
        let retiredComponent = retiredRoot;
        while (eligible) {
          try {
            if ((await fs.promises.lstat(retiredComponent)).isSymbolicLink()) { eligible = false; break; }
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          const parent = path.dirname(retiredComponent);
          if (parent === retiredComponent) break;
          retiredComponent = parent;
        }
        for (const field of eligible ? declared : []) {
          const declaredFile = path.resolve(status[field]);
          try { await fs.promises.lstat(declaredFile); eligible = false; break; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          const relative = path.relative(retiredRoot, declaredFile);
          const currentFile = path.join(sourceRoot, relative);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { eligible = false; break; }
          try {
            const info = await fs.promises.lstat(currentFile);
            const physical = path.join(resolvedRoot, '.solopreneur', 'agent-runs', relative);
            if (!info.isFile() || info.isSymbolicLink() || await fs.promises.realpath(currentFile) !== physical) { eligible = false; break; }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const journalOutput = field === 'outputFilePath' && path.basename(declaredFile) === 'output.log'
              ? store.readProjectJournal(project.projectId, { executionLogId: Number(status.executionLogId), nodeId: String(status.nodeId), limit: 1 }).logs[0]?.output
              : '';
            if (!journalOutput) { eligible = false; break; }
          }
        }
        if (eligible) retiredAgentRunsRoot = retiredRoot;
      }
      const declaredPath = (field: string): string => {
        const declared = path.resolve(String(status[field] || ''));
        if (!status[field]) return declared;
        if (retiredWorkspaceRoot) return path.join(projectRoot, path.relative(retiredWorkspaceRoot, declared));
        if (retiredAgentRunsRoot) return path.join(sourceRoot, path.relative(retiredAgentRunsRoot, declared));
        return declared;
      };
      if (unregistered) {
        const directories = new Set<string>(['sessionFilePath', 'promptFilePath', 'commandFilePath', 'outputFilePath'].filter(field => status[field]).map(field => path.dirname(declaredPath(field))));
        if (directories.size === 0) {
          const numbered = path.join(sourceRoot, String(status.nodeId || ''), String(id));
          const relative = path.relative(sourceRoot, numbered);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('historical_run_source_conflict');
          let info: fs.Stats;
          try { info = await fs.promises.lstat(numbered); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('historical_run_source_conflict'); throw error; }
          const physicalNumbered = path.join(resolvedRoot, '.solopreneur', 'agent-runs', String(status.nodeId || ''), String(id));
          if (!info.isDirectory() || info.isSymbolicLink() || await fs.promises.realpath(numbered) !== path.resolve(physicalNumbered)) throw new Error('historical_run_source_conflict');
          directories.add(numbered);
        }
        if (directories.size !== 1) throw new Error('historical_run_source_conflict');
        const runDir = [...directories][0], relative = path.relative(sourceRoot, runDir), parts = relative.split(path.sep);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || parts[0] !== status.nodeId || !(parts.length === 1 || parts.length === 2 && Number(parts[1]) === id)) throw new Error('historical_run_source_conflict');
        candidates.push({ id, runDir });
      }
      if (candidates.length !== 1) throw new Error('historical_run_task_mismatch');
      const runDir = path.resolve(candidates[0].runDir), relative = path.relative(sourceRoot, runDir);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep)[0] !== status.nodeId || conflictingRuns.has(relative)) throw new Error('historical_run_source_conflict');
      let appendedOutputArtifactExecutionLogId: number | undefined;
      let changesSourceKey: string | undefined;
      const read = async (name: string, required = true, declaredField?: string): Promise<Buffer | null> => {
        const declared = declaredField ? String(status[declaredField] || '') : '';
        const file = declared ? declaredPath(declaredField!) : path.join(runDir, name);
        if (path.dirname(file) !== runDir) throw new Error('historical_run_source_conflict');
        const sourceKey = path.relative(sourceRoot, file);
        const adoptedArtifact = store.readRunArtifactMetadata(project.projectId, id, sourceKey);
        const legacyNodeArtifact = relative === status.nodeId ? store.readRunArtifactMetadata(project.projectId, 0, sourceKey) : null;
        const artifact = adoptedArtifact || legacyNodeArtifact;
        const artifactExecutionLogId = adoptedArtifact ? id : legacyNodeArtifact ? 0 : id;
        const declaredKind = declared ? runArtifactKind(path.join(status.nodeId, String(id), name)) : null;
        if (declared && !declaredKind) throw new Error('historical_run_input_invalid');
        let declaredCurrent: Awaited<ReturnType<typeof stableFile>> | undefined;
        if (declared) {
          try { declaredCurrent = await stableFile(file); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        if (declaredCurrent) {
          const appended = Boolean(artifact && declaredCurrent.hash !== artifact.hash && declaredKind === 'output' && appendedOutputs.has(sourceKey));
          const refreshed = Boolean(artifact && declaredCurrent.hash !== artifact.hash && lateChangeEvidence.has(sourceKey));
          if (artifact && declaredCurrent.hash !== artifact.hash && !appended && !refreshed) throw new Error('historical_run_source_changed');
          if (appended) appendedOutputArtifactExecutionLogId = artifactExecutionLogId;
          store.captureMigrationSource({ identity, key: sourceKey, hash: declaredCurrent.hash }, declaredCurrent.bytes, { mimeType: 'application/octet-stream', encoding: 'binary', sourceKind: declaredKind! });
          if (!appended && !refreshed) store.writeHistoricalRunArtifact(project.projectId, { executionLogId: id, relativePath: sourceKey, bytes: declaredCurrent.bytes, hash: declaredCurrent.hash }, declaredKind!);
          if (!artifact) { result.originalBytes += declaredCurrent.bytes.length; result.retainedFiles.push(file); result.imported++; }
          return declaredCurrent.bytes;
        }
        if (!artifact) { if (required) throw new Error('historical_run_input_missing'); return null; }
        if (declared && !declaredCurrent) {
          const archivedArtifact = store.readRunArtifactBytes(project.projectId, id, sourceKey);
          if (!archivedArtifact) throw new Error('historical_run_input_missing');
          const archived = archivedArtifact.bytes;
          store.captureMigrationSource({ identity, key: sourceKey, hash: artifact.hash }, archived, { mimeType: artifact.mimeType, encoding: 'binary', sourceKind: declaredKind! });
          store.writeHistoricalRunArtifact(project.projectId, { executionLogId: id, relativePath: sourceKey, bytes: archived, hash: artifact.hash, mimeType: artifact.mimeType }, declaredKind!);
          return archived;
        }
        const current = declaredCurrent || await stableFile(file);
        if (current.hash !== artifact.hash) {
          if (appendedOutputs.has(sourceKey)) appendedOutputArtifactExecutionLogId = artifactExecutionLogId;
          else if (!lateChangeEvidence.has(sourceKey)) throw new Error('historical_run_source_changed');
        }
        return current.bytes;
      };
      const session = await read('session.json', status.nativeSessionIdIsCurrent === true, 'sessionFilePath');
      if (!session && status.sessionFilePath) {
        result.retainedGaps ||= [];
        result.retainedGaps.push({ source: String(status.sessionFilePath), error: 'historical_optional_artifact_missing' });
      }
      let binding: NativeSessionBinding | null = null;
      let nativeTranscript: { source: { identity: string; key: string; hash: string }; bytes: Buffer } | undefined;
      if (session) {
        const value = JSON.parse(session.toString('utf8'));
        if (value.version === 2) binding = assertVersion2Binding(value, file);
        else {
          if (value.version !== undefined && value.version !== 1 || typeof value.sessionId !== 'string' || !value.sessionId.trim() || /\s/.test(value.sessionId) || typeof value.source !== 'string' || !value.source) throw new Error('historical_run_legacy_identity_invalid');
          const provider = getContinuationAgentProvider(String(status.agentCli || ''));
          if (!status.agentCli || status.sessionProvider && status.sessionProvider !== provider) throw new Error('historical_run_binding_mismatch');
          const sessionSource = { identity, key: path.relative(sourceRoot, status.sessionFilePath ? declaredPath('sessionFilePath') : path.join(runDir, 'session.json')), hash: digest(session) };
          let providerContext: Record<string, unknown> | undefined;
          let nativeSessionVerified = true;
          const evidence: Record<string, unknown> = { source: 'legacy_session_file', sessionSource, legacySource: value.source, timestampSource: value.updatedAt ? 'legacy_session_updated_at' : 'historical_status_started_at', nonceSource: status.bindingNonce ? 'historical_status' : 'migration_source_hash' };
          if (provider === 'codex') {
            const homeBytes = await read('codex-home.txt', Boolean(status.codexHomeFilePath), 'codexHomeFilePath');
            const home = homeBytes?.toString('utf8').trim() || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
            if (!path.isAbsolute(home)) throw new Error('historical_run_provider_context_invalid');
            const transcript = findCodexTranscriptFile(home, value.sessionId);
            if (!transcript) {
              if (status.nativeSessionIdIsCurrent === true) throw new Error('historical_run_native_source_missing');
              nativeSessionVerified = false;
              result.retainedGaps ||= [];
              result.retainedGaps.push({ source: path.join(runDir, 'session.json'), error: 'historical_native_identity_unverified' });
              Object.assign(evidence, { nativeIdentityVerified: false, reason: 'historical_native_source_missing' });
            } else {
            const realHome = await fs.promises.realpath(home), realTranscript = await fs.promises.realpath(transcript);
            if (!['sessions', 'archived_sessions'].some(directory => containedRegularPath(path.join(realHome, directory), realTranscript))) throw new Error('historical_run_native_source_scope_mismatch');
            const native = await stableFile(transcript);
            const newline = native.bytes.indexOf(10), first = JSON.parse(native.bytes.subarray(0, newline < 0 ? native.bytes.length : newline).toString('utf8'));
            const meta = first.type === 'session_meta' ? first.payload : null;
            if (!meta || (meta.id || meta.session_id) !== value.sessionId || meta.id && meta.session_id && meta.id !== meta.session_id || !meta.cwd || path.resolve(meta.cwd) !== path.resolve(projectRoot)) throw new Error('historical_run_native_source_mismatch');
            nativeTranscript = { source: { identity: `native-session-history:${projectRoot}`, key: `${id}/codex/${path.basename(transcript)}`, hash: native.hash }, bytes: native.bytes };
            store.captureMigrationSource(nativeTranscript.source, native.bytes, { mimeType: 'application/x-ndjson', encoding: 'utf8' });
            result.originalBytes += native.bytes.length; result.retainedFiles.push(transcript);
            providerContext = { codex: { codexHome: path.resolve(home) } };
            Object.assign(evidence, { transcriptPath: transcript, transcriptSource: nativeTranscript.source, providerContextSource: homeBytes ? 'recorded_codex_home' : 'existing_default_with_verified_transcript' });
            }
          }
          const createdAt = String(value.updatedAt || status.startedAt || '');
          binding = { version: 2, runId: String(id), provider, workspaceRoot: resolvedRoot, cliPath: String(status.agentCli), bindingNonce: String(status.bindingNonce || `legacy-session:${sessionSource.hash}`), createdAt, headRevision: 1, ...(nativeSessionVerified ? { resumableRevision: 1 } : {}),
            revisions: [{ revision: 1, sessionId: value.sessionId, method: 'transcript_correlated_compat', contract: 'compatibility', state: nativeSessionVerified ? 'confirmed' : 'unavailable', createdAt, evidence, ...(providerContext ? { providerContext } : {}) }] };
        }
      }
      const prompt = (await read('prompt.txt', true, 'promptFilePath'))!.toString('utf8'), command = (await read('command.txt', true, 'commandFilePath'))!.toString('utf8');
      let output = await read('output.log', false, 'outputFilePath');
      const physicalOutput = status.outputFilePath ? declaredPath('outputFilePath') : path.join(runDir, 'output.log');
      const outputArtifactPath = path.relative(sourceRoot, physicalOutput);
      const appendedOutputSource = output && appendedOutputArtifactExecutionLogId !== undefined
        ? { identity, key: outputArtifactPath, hash: digest(output) }
        : undefined;
      let outputSource: { identity: string; key: string; hash: string } | undefined;
      if (!output) {
        if (status.outputFilePath && path.basename(status.outputFilePath) !== 'output.log') throw new Error('historical_run_input_missing');
        const journal = store.readProjectJournal(project.projectId, { executionLogId: Number(status.executionLogId), nodeId: String(status.nodeId), limit: 1 }).logs[0];
        if (!journal || !journal.output) throw new Error('historical_run_input_missing');
        const { dataState: _dataState, ...sourceJournal } = journal;
        const bytes = Buffer.from(JSON.stringify(sourceJournal));
        outputSource = { identity: `historical-journal-output:${projectRoot}`, key: String(status.executionLogId), hash: digest(bytes) };
        store.captureMigrationSource(outputSource, bytes, { mimeType: 'application/json', encoding: 'utf8' });
        output = Buffer.from(journal.output);
      }
      const documents: { workspaceBefore?: Buffer; changes?: Buffer; roadmapBackup?: Buffer } = {};
      const completionBytes = await read('completion.json', Boolean(status.completionDecisionFilePath), 'completionDecisionFilePath');
      const legacyCompletion = completionBytes ? { source: { identity, key: path.join(relative, status.completionDecisionFilePath ? path.basename(status.completionDecisionFilePath) : 'completion.json'), hash: digest(completionBytes) }, bytes: completionBytes } : undefined;
      for (const [field, statusKey, fallback] of [['workspaceBefore', 'workspaceSnapshotPath', 'workspace-before.json'], ['changes', 'changesFilePath', 'changes.txt'], ['roadmapBackup', 'roadmapBackupFilePath', 'roadmap-before.csv']] as const) {
        const declared = String(status[statusKey] || ''), name = declared ? path.basename(declared) : fallback;
        if (declared && declaredPath(statusKey) !== path.join(runDir, name)) throw new Error('historical_run_document_scope_mismatch');
        const bytes = await read(fallback, false, statusKey);
        if (bytes) {
          documents[field] = bytes;
          if (field === 'changes') changesSourceKey = path.relative(sourceRoot, declared ? declaredPath(statusKey) : path.join(runDir, fallback));
        }
        else if (declared) {
          result.retainedGaps ||= [];
          result.retainedGaps.push({ source: declared, error: 'historical_optional_artifact_missing' });
        }
      }
      const historicalExecutionLogIds = unregistered ? [...new Set([id, Number(status.executionLogId)])] : matchingTasks[0].executions.filter((run: { id: number; runDir: string }) => path.resolve(run.runDir) === runDir).map((run: { id: number }) => run.id);
      const reportExecutionLogIds = new Set(historicalExecutionLogIds);
      const reports: Array<{ source: { identity: string; key: string; hash: string }; bytes: Buffer; observation: { executionLogId: number; sequence: number; availability: string; envelope: any } }> = [];
      const reportAliases = new Set<string>(status.learningTaskId ? [String(status.learningTaskId)] : []);
      if (unregistered) for (const name of (await fs.promises.readdir(runDir)).filter(name => /^task-report-(?:status-)?\d+\.json$/.test(name)).sort()) {
        const bytes = (await read(name))!, envelope = JSON.parse(bytes.toString('utf8')), sequence = Number(name.match(/\d+/)![0]);
        let reportProjectRoot: string;
        try { reportProjectRoot = typeof envelope.projectPath === 'string' ? await fs.promises.realpath(envelope.projectPath) : ''; }
        catch { if (retiredWorkspaceRoot && path.resolve(String(envelope.projectPath || '')) === retiredWorkspaceRoot) reportProjectRoot = resolvedRoot; else throw new Error('historical_run_report_mismatch'); }
        if (envelope.schemaVersion !== 1 || reportProjectRoot !== resolvedRoot || !Number.isSafeInteger(envelope.executionLogId) || !reportExecutionLogIds.has(envelope.executionLogId) || envelope.turnId !== `${sequence}:complete` || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error('historical_run_report_mismatch');
        if (envelope.taskId) {
          if (typeof envelope.taskId !== 'string' || !/^task-[a-zA-Z0-9-]+$/.test(envelope.taskId)) throw new Error('historical_run_report_mismatch');
          reportAliases.add(envelope.taskId);
        } else if (status.learningTaskId || !name.startsWith('task-report-status-')) throw new Error('historical_run_report_mismatch');
        if (reportAliases.size > 1) throw new Error('historical_run_report_mismatch');
        const receipt = name.startsWith('task-report-status-');
        if (receipt && !['missing', 'invalid', 'save_failed'].includes(envelope.availability)) throw new Error('historical_run_report_mismatch');
        if (receipt && reports.some(report => report.observation.executionLogId === envelope.executionLogId && report.observation.sequence === sequence)) continue;
        const availability = receipt ? envelope.availability : envelope.report && typeof envelope.report === 'object' && typeof envelope.report.summary === 'string' ? 'recorded' : 'invalid';
        reports.push({ source: { identity, key: path.join(relative, name), hash: digest(bytes) }, bytes, observation: { executionLogId: envelope.executionLogId, sequence, availability, envelope: availability === 'recorded' ? envelope : { ...envelope, report: null } } });
      }
      if ((await stableFile(file)).hash !== captured.hash) throw new Error('historical_run_source_changed');
      const refreshedArtifacts = [];
      for (const [sourceKey, changed] of lateChangeEvidence) {
        if (runDirectory(sourceKey) !== relative) continue;
        const current = await stableFile(changed.file);
        const adoptedArtifact = store.readRunArtifactMetadata(project.projectId, id, sourceKey);
        if (adoptedArtifact?.hash === current.hash) continue;
        refreshedArtifacts.push({ source: { identity, key: sourceKey, hash: current.hash }, artifactExecutionLogId: adoptedArtifact ? id : changed.executionLogId, kind: 'change_evidence' as const, ...(sourceKey === changesSourceKey ? { documentPurpose: 'changes' as const } : {}) });
      }
      const adopted = store.adoptHistoricalRun(project.projectId, project.locationId, { identity: statusIdentity, key, hash: captured.hash }, { historicalExecutionLogIds, status, binding, prompt, command, output, outputSource, nativeTranscript, legacyCompletion, appendedOutputSource, appendedOutputArtifactExecutionLogId, refreshedArtifacts, ...documents, ...(unregistered ? { unregisteredReports: reports, unregisteredTaskAlias: [...reportAliases][0], unregisteredRequest: prompt, unregisteredWorkspaceRoot: resolvedRoot, unregisteredWorkspaceRelocated: Boolean(retiredWorkspaceRoot || retiredAgentRunsRoot) } : { registeredTaskAlias: matchingTasks[0].taskId }) });
      if (relative === status.nodeId) {
        for (const original of filesByNode.get(relative) || []) {
          if (path.dirname(original) !== runDir) continue;
          const artifactPath = path.relative(sourceRoot, original), originalArtifact = store.readRunArtifactMetadata(project.projectId, 0, artifactPath);
          if (originalArtifact && !store.readRunArtifactMetadata(project.projectId, id, artifactPath)) {
            const current = await stableFile(original);
            if (current.hash !== originalArtifact.hash) throw new Error('historical_run_source_changed');
            store.writeRunArtifact(project.projectId, { executionLogId: id, relativePath: artifactPath, bytes: current.bytes, ...originalArtifact });
          }
        }
        for (const artifact of runs.get(relative)?.values() || []) artifact.executionLogId = id;
      }
      if (adopted.unchanged) result.unchanged++; else result.imported++;
      // Eligibility follows successful identity and lifecycle adoption, rather
      // than merely having copied a file into the artifact archive.
      const declaredFiles = ['sessionFilePath', 'promptFilePath', 'commandFilePath', 'outputFilePath', 'codexHomeFilePath', 'completionDecisionFilePath', 'workspaceSnapshotPath', 'changesFilePath', 'roadmapBackupFilePath']
        .filter(field => status[field]).map(field => declaredPath(field));
      for (const original of new Set([...files, ...declaredFiles])) {
        if (path.dirname(original) !== runDir) continue;
        const artifactPath = path.relative(sourceRoot, original);
        const artifact = store.readRunArtifactMetadata(project.projectId, id, artifactPath);
        if (!artifact || !isRetirableRunArtifact(artifactPath) && !['prompt', 'output', 'control', 'session', 'change_evidence', 'report'].includes(store.migrationSourceKind(identity, artifactPath))) continue;
        let current: Awaited<ReturnType<typeof stableFile>>;
        try { current = await stableFile(original); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        if (current.hash !== artifact.hash) throw new Error('historical_run_source_changed');
        store.markMigrationSourceImported(identity, artifactPath);
      }
    } catch (error) {
      const coded = error as Error & { code?: string };
      const message = coded.code ? `${coded.code}: ${coded.message}` : String(error);
      result.conflicts.push({ source: file, error: message });
      if (captured) store.markMigrationSourceConflict(statusIdentity, key, message);
    }
    options.onProgress?.(result);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  let minimumAnonymousId = 1;
  for (const directory of runs.keys()) {
    const parts = directory.split(path.sep);
    if (parts.length === 2 && /^\d+$/.test(parts[1]) && Number.isSafeInteger(Number(parts[1]))) minimumAnonymousId = Math.max(minimumAnonymousId, Number(parts[1]) + 1);
  }
  for (const [directory, artifacts] of runs) {
    if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
    if (conflictingRuns.has(directory)) continue;
    try {
      const parts = directory.split(path.sep);
      if (parts.length > 2) {
        let ancestor = path.dirname(directory); let nestedArtifact = false;
        while (ancestor !== '.' && ancestor !== '') {
          if (runs.has(ancestor)) { nestedArtifact = true; break; }
          ancestor = path.dirname(ancestor);
        }
        if (nestedArtifact) continue;
      }
      if (directory === '.' || parts.length > 2 || (parts.length === 2 && !/^\d+$/.test(parts[1]))) throw new Error('historical_run_identity_ambiguous');
      const text = (name: string) => {
        const source = artifacts.get(name);
        if (!source) return '';
        const bytes = fs.readFileSync(path.join(sourceRoot, source.file));
        if (digest(bytes) !== source.hash) throw new Error('historical_run_source_changed');
        return bytes.toString('utf8');
      };
      const output = text('output.log'); const command = text('command.txt');
      if (!['command.txt', 'output.log', 'completion.json', 'touched-files.txt', 'changes.txt', 'prompt.txt'].some(name => artifacts.has(name))) continue;
      const nodeId = parts[0];
      const started = text('started_at').trim();
      const startedAt = Number.isFinite(Date.parse(started)) ? started : new Date((await fs.promises.stat(path.join(sourceRoot, directory))).mtimeMs).toISOString();
      const durationMatch = output.match(/Run duration ms:\s*(\d+)/);
      const durationMs = durationMatch ? Number(durationMatch[1]) : Math.max(0, Math.max(...[...artifacts.values()].map(item => item.modifiedAt)) - Date.parse(startedAt));
      const completion = text('completion.json'); let outcome: any = {};
      if (completion) {
        try {
          outcome = JSON.parse(completion);
          if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome) || typeof outcome.markCompleted !== 'boolean' || outcome.reason !== undefined && typeof outcome.reason !== 'string') throw new Error('invalid_completion_decision');
        }
        catch { outcome = { failureCode: 'completion_state_invalid', failureReason: 'Agent completion decision file could not be parsed.' }; }
      }
      const status = outcome.markCompleted === true ? 'Completed' : outcome.markCompleted === false || outcome.failureReason || outcome.failureCode || /Failure category:|Failure reason:|Agent CLI exited before completing/i.test(output) ? 'Failed' : 'unknown';
      const metadata = text('.agent_status.json'); const state = metadata ? JSON.parse(metadata) : {};
      const runKind = String(state.runKind || (nodeId === '__solo__' ? 'solo' : nodeId === '__roadmap_revision__' ? 'roadmap_revision' : 'step'));
      const declaredArtifactIds = new Set([...artifacts.values()].map(item => item.executionLogId).filter(id => id > 0));
      const executionLogId = parts.length === 2 ? Number(parts[1]) : declaredArtifactIds.size === 1 ? [...declaredArtifactIds][0] : store.reserveHistoricalRunId(project.projectId, directory, { nodeId, timestamp: startedAt, agentCli: command, command, output, status }, minimumAnonymousId);
      if (parts.length === 1) for (const file of filesByNode.get(directory) || []) {
        const relativePath = path.relative(sourceRoot, file);
        const components = relativePath.split(path.sep);
        const originalId = components.length >= 3 && /^\d+$/.test(components[1]) ? Number(components[1]) : store.readRunArtifactMetadata(project.projectId, executionLogId, relativePath) ? executionLogId : 0;
        const artifact = store.readRunArtifactMetadata(project.projectId, originalId, relativePath);
        if (artifact && !store.readRunArtifactMetadata(project.projectId, executionLogId, relativePath)) {
          const current = await stableFile(file);
          if (current.hash !== artifact.hash) throw new Error('historical_run_source_changed');
          store.writeRunArtifact(project.projectId, { executionLogId, relativePath, bytes: current.bytes, ...artifact });
        }
      }
      const changed = text('touched-files.txt').trim() || text('changes.txt');
      const changedFiles = changed.split(/\r?\n/).map(line => line.trim().replace(/^(?:[AMDRCU?!]{1,2}|\?\?)\s+/, '')).filter(file => file && !file.startsWith('.solopreneur/agent-runs/')).map(filePath => ({ filePath, role: 'changed' }));
      const record: RunIndexRecord = { executionLogId, nodeId, runKind, agentCli: command, status, startedAt, finishedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(), durationMs, ...extractTokenUsageFromOutput(output, command), outputTail: '', outputPath: '', outputBytes: Buffer.byteLength(output), commandPath: '', promptPath: '', changesPath: '', touchedFilesPath: '', updatedAt: new Date(Math.max(...[...artifacts.values()].map(item => item.modifiedAt))).toISOString() };
      store.importHistoricalRunIndex(project.projectId, record, changedFiles, [], { identity, key: directory, hash: digest(Buffer.from(JSON.stringify([...artifacts].map(([name, item]) => [name, item.hash])))) }, 10);
    } catch (error) { result.conflicts.push({ source: path.join(sourceRoot, directory), error: String(error) }); }
    options.onProgress?.(result);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return result;
}

export async function importProjectGrowth(store: UnifiedDataStore, source: string, options: any = {}): Promise<MemoryImportResult> {
  const projectRoot = String(options.projectRoot || ''); const identity = `project-growth:${projectRoot}`;
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, conflicts: [], retainedFiles: [source], interrupted: false };
  const { projectRoot: physicalProjectRoot, source: physicalSource } = await resolveProjectDatabaseSource(projectRoot, source, 'project_growth.db');
  const captured = await captureSqliteSnapshot(physicalSource, legacy => legacy.initReadOnly()); result.originalBytes = captured.bytes.length;
  try {
  const sourceState = store.captureMigrationSource({ identity, key: path.basename(source), hash: captured.hash }, captured.bytes, { mimeType: 'application/x-sqlite3', encoding: 'binary' });
  const sourceAlreadyImported = sourceState.unchanged && sourceState.stage === 'imported';
  if (sourceAlreadyImported) result.unchanged = 1;
  const project = await store.registerProject({ root: physicalProjectRoot }); const legacy = new SqliteStore(captured.snapshot, path.resolve(__dirname, '..'));
  try {
    const snapshotsAlreadyImported = sourceAlreadyImported || store.growthSnapshotsImported(project.projectId, captured.hash);
    await legacy.initReadOnly();
    for (const row of snapshotsAlreadyImported ? [] : legacy.getAllGrowthSnapshotHistory().reverse()) {
      if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
      const snapshot = legacy.getGrowthSnapshotById(row.id);
      if (snapshot) { store.writeProjectGrowth(project.projectId, snapshot, `legacy-growth:${project.projectId}:${row.id}`); result.imported++; }
      // A legacy snapshot can contain tens of thousands of rows. Let control,
      // task-start, and live database requests run between every snapshot.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    store.markGrowthSnapshotsImported(project.projectId, captured.hash);
    for (const row of legacy.getGrowthReportProjection('')) {
      const current = store.readGrowthReportProjection(project.projectId, row.key).find(item => item.key === row.key);
      if (current) {
        if (isDeepStrictEqual(current.value, row.value)) result.unchanged++;
        else result.conflicts.push({ source: `${path.basename(source)}#growth_report_projection:${row.key}`, error: 'growth_report_projection_conflict' });
        continue;
      }
      try {
        store.writeGrowthReportProjection(project.projectId, [{ ...row, expectedRevision: 0 }]);
        result.imported++;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'revision_conflict') throw error;
        result.conflicts.push({ source: `${path.basename(source)}#growth_report_projection:${row.key}`, error: 'growth_report_projection_conflict' });
      }
    }
  } finally { legacy.close(); }
  if (result.conflicts.length) store.markMigrationSourceConflict(identity, path.basename(source), 'growth_report_projection_conflict');
  else store.markMigrationSourceImported(identity, path.basename(source));
  return result;
  } finally { await captured.cleanup(); }
}

export async function importStepMemoryDirectory(store: UnifiedDataStore, sourceRoot: string, options: any = {}): Promise<MemoryImportResult> {
  const projectRoot = await fs.promises.realpath(String(options.projectRoot || ''));
  const sourceInfo = await fs.promises.lstat(sourceRoot);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('migration_source_invalid');
  if (await fs.promises.realpath(sourceRoot) !== path.join(projectRoot, '.solopreneur', 'step-memory')) throw new Error('migration_source_scope_mismatch');
  const project = await store.registerProject({ root: projectRoot });
  const identity = `step-memory:${project.projectId}`;
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, conflicts: [], retainedFiles: [], interrupted: false };
  const files = await filesUnder(sourceRoot, (source, error) => { result.conflicts.push({ source, error: String(error) }); result.retainedFiles.push(source); }, true);
  for (const file of files) {
    if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
    let captured: Awaited<ReturnType<typeof stableFile>> | undefined;
    const key = path.relative(sourceRoot, file).split(path.sep).join('/');
    try {
      captured = await stableFile(file); result.originalBytes += captured.bytes.length; result.retainedFiles.push(file);
      const format = path.extname(file).slice(1); const supported = format === 'json' || format === 'md';
      store.captureMigrationSource({ identity, key, hash: captured.hash }, captured.bytes, { mimeType: format === 'json' ? 'application/json' : format === 'md' ? 'text/markdown' : 'application/octet-stream', encoding: supported ? 'utf8' : 'binary', ...(supported ? {} : { error: 'step_memory_source_format_unsupported' }) });
      if (!supported) throw new Error('step_memory_source_format_unsupported');
      const imported = store.importStepMemorySource(project.projectId, { nodeId: key.slice(0, -format.length - 1), source: { identity, key, hash: captured.hash }, bytes: captured.bytes, format });
      if (imported.unchanged) result.unchanged++; else result.imported++;
    } catch (error) {
      result.conflicts.push({ source: file, error: String(error) });
      if (captured) store.captureMigrationSource({ identity, key, hash: captured.hash }, captured.bytes, { mimeType: 'application/octet-stream', encoding: 'binary', error: error instanceof Error ? error.message : String(error) });
    }
    options.onProgress?.(result);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return result;
}

export async function importRunDigestDirectory(store: UnifiedDataStore, sourceRoot: string, options: any = {}): Promise<MemoryImportResult> {
  const projectRoot = await fs.promises.realpath(String(options.projectRoot || ''));
  const sourceInfo = await fs.promises.lstat(sourceRoot);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('migration_source_invalid');
  if (await fs.promises.realpath(sourceRoot) !== path.join(projectRoot, '.solopreneur', 'run-digests')) throw new Error('migration_source_scope_mismatch');
  const project = await store.registerProject({ root: projectRoot }); const identity = `run-digests:${project.projectId}`;
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, conflicts: [], retainedFiles: [], interrupted: false };
  const files = await filesUnder(sourceRoot, (source, error) => { result.conflicts.push({ source, error: String(error) }); result.retainedFiles.push(source); }, true);
  for (const file of files) {
    if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
    let captured: Awaited<ReturnType<typeof stableFile>> | undefined;
    const key = path.relative(sourceRoot, file).split(path.sep).join('/');
    try {
      captured = await stableFile(file); result.originalBytes += captured.bytes.length; result.retainedFiles.push(file);
      store.captureMigrationSource({ identity, key, hash: captured.hash }, captured.bytes, { mimeType: 'application/json', encoding: 'utf8' });
      if (path.extname(file) !== '.json') throw new Error('run_digest_source_format_unsupported');
      const imported = store.importRunDigestSource(project.projectId, { source: { identity, key, hash: captured.hash }, bytes: captured.bytes });
      if (imported.unchanged) result.unchanged++; else result.imported++;
    } catch (error) {
      result.conflicts.push({ source: file, error: String(error) });
      if (captured) store.captureMigrationSource({ identity, key, hash: captured.hash }, captured.bytes, { mimeType: 'application/octet-stream', encoding: 'binary', error: error instanceof Error ? error.message : String(error) });
    }
    options.onProgress?.(result); await new Promise<void>(resolve => setImmediate(resolve));
  }
  for (;;) {
    if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
    if (!store.backfillRunIndexes(project.projectId, 32).backfilledCount) break;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return result;
}
