import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { UnifiedDataStore } from './db/unifiedDataStore';
import type { MemoryImportResult } from './memoryDatabaseMigration';
import { discoverLegacyRunProcesses } from './legacyRunProcessRecovery.js';

const retiredFiles = new Set([
  '.gitignore',
  'README.md',
  'automation-tasks.jsonl',
  'bootstrap-roadmap-instructions.md',
  'execution-graph.json',
  'roadmap-methodology.md',
  'validate-roadmap.cjs',
  'validate-time-plan.cjs'
]);

const retiredDirectories = [
  'attachments',
  'step-sessions',
  'audits',
  'agent-runs',
  'agent-status',
  'runtime',
  'tmp',
  'verification'
];

const retiredDirectoryPatterns = [
  /^agent-runtime-closure-\d{8}$/,
  /^path-recovery-\d{8}T\d{6}Z$/,
  /^\.history-rewrite-preserve$/
];

function isRetiredProjectDirectory(name: string): boolean {
  return retiredDirectories.includes(name) || retiredDirectoryPatterns.some(pattern => pattern.test(name));
}

export function isRetiredProjectFile(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return false;
  const parts = normalized.split('/');
  if (parts[parts.length - 1].toLowerCase() === 'roadmap.csv') return false;
  if (parts.length === 1) return retiredFiles.has(parts[0]);
  if (normalized === 'runtime/task-checkpoint.cjs') return true;
  return retiredDirectories.includes(parts[0]) || retiredDirectoryPatterns.some(pattern => pattern.test(parts[0]));
}

function mimeType(file: string): string {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.json') return 'application/json';
  if (extension === '.jsonl') return 'application/x-ndjson';
  if (extension === '.md') return 'text/markdown';
  if (extension === '.txt' || extension === '.log') return 'text/plain';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.js' || extension === '.cjs' || extension === '.mjs') return 'text/javascript';
  return 'application/octet-stream';
}

async function safeFileStat(sourceRoot: string, file: string): Promise<fs.Stats> {
  const relative = path.relative(sourceRoot, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('migration_source_invalid');
  const leaf = await fs.promises.lstat(file);
  if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1) throw new Error('migration_source_invalid');
  let directory = path.dirname(file);
  while (directory !== sourceRoot) {
    if (!directory.startsWith(sourceRoot + path.sep)) throw new Error('migration_source_invalid');
    const info = await fs.promises.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await fs.promises.realpath(directory) !== directory) throw new Error('migration_source_invalid');
    directory = path.dirname(directory);
  }
  if (await fs.promises.realpath(file) !== file) throw new Error('migration_source_invalid');
  return leaf;
}

async function stableFile(sourceRoot: string, file: string): Promise<{ bytes: Buffer; hash: string }> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    const before = await safeFileStat(sourceRoot, file);
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || before.dev !== opened.dev || before.ino !== opened.ino) throw new Error('migration_source_changed');
    const bytes = await handle.readFile();
    const after = await safeFileStat(sourceRoot, file);
    const openedAfter = await handle.stat();
    if (!openedAfter.isFile() || openedAfter.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino
      || opened.dev !== openedAfter.dev || opened.ino !== openedAfter.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('migration_source_changed');
    return { bytes, hash: crypto.createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if (error instanceof Error && ['migration_source_invalid', 'migration_source_changed'].includes(error.message)) throw error;
    throw new Error('migration_source_invalid');
  } finally { await handle?.close().catch(() => undefined); }
}

async function projectFiles(sourceRoot: string): Promise<Array<{ file: string; key: string; retired: boolean; unsafe: boolean }>> {
  const files: Array<{ file: string; key: string; retired: boolean; unsafe: boolean }> = [];
  const pending = [{ directory: sourceRoot, retired: false }];
  while (pending.length) {
    const current = pending.pop()!;
    const directory = current.directory;
    const relativeDirectory = path.relative(sourceRoot, directory);
    if (relativeDirectory.startsWith('..') || path.isAbsolute(relativeDirectory)) throw new Error('migration_source_invalid');
    const descriptorRoot = process.platform === 'linux' ? '/proc/self/fd' : process.platform === 'darwin' ? '/dev/fd' : '';
    if (!descriptorRoot) throw new Error('migration_secure_path_unsupported');
    const before = await fs.promises.lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('migration_source_invalid');
    const directoryFlag = Number((fs.constants as unknown as Record<string, number>).O_DIRECTORY || 0);
    const noFollowFlag = Number((fs.constants as unknown as Record<string, number>).O_NOFOLLOW || 0);
    const handle = await fs.promises.open(directory, fs.constants.O_RDONLY | directoryFlag | noFollowFlag);
    let entries: fs.Dirent[];
    try {
      const anchored = path.join(descriptorRoot, String(handle.fd));
      const opened = await handle.stat();
      if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino || await fs.promises.realpath(anchored) !== directory) throw new Error('migration_source_invalid');
      entries = await fs.promises.readdir(anchored, { withFileTypes: true });
    } finally { await handle.close(); }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const file = path.join(directory, entry.name);
      const key = path.relative(sourceRoot, file).split(path.sep).join('/');
      const retired = entry.name.toLowerCase() !== 'roadmap.csv' && (current.retired || isRetiredProjectFile(key));
      if (entry.isSymbolicLink()) { files.push({ file, key, retired, unsafe: true }); continue; }
      if (entry.isDirectory()) {
        if (current.retired || directory === sourceRoot && isRetiredProjectDirectory(entry.name)) pending.push({ directory: file, retired: true });
        else if (directory === sourceRoot && entry.name === 'runtime') pending.push({ directory: file, retired: false });
        else files.push({ file, key, retired: false, unsafe: false });
        continue;
      }
      if (entry.isFile()) files.push({ file, key, retired, unsafe: false });
    }
  }
  return files.sort((left, right) => left.key.localeCompare(right.key));
}

export async function legacyProjectFilesStamp(projectRoot: string): Promise<{ stamp: string; count: number }> {
  const physicalRoot = await fs.promises.realpath(projectRoot);
  const sourceRoot = path.join(physicalRoot, '.solopreneur');
  const info = await fs.promises.lstat(sourceRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || await fs.promises.realpath(sourceRoot) !== sourceRoot) throw new Error('migration_source_invalid');
  const hash = crypto.createHash('sha256');
  let count = 0;
  for (const source of await projectFiles(sourceRoot)) {
    if (!source.retired) continue;
    const stat = await fs.promises.lstat(source.file);
    hash.update(JSON.stringify([source.key, source.unsafe ? 'symlink' : 'file', stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
    count++;
  }
  return { stamp: hash.digest('hex'), count };
}

export async function importLegacyProjectFiles(store: UnifiedDataStore, sourceRoot: string, options: any = {}): Promise<MemoryImportResult> {
  const projectRoot = await fs.promises.realpath(String(options.projectRoot || ''));
  const physicalSourceRoot = await fs.promises.realpath(sourceRoot);
  if (physicalSourceRoot !== path.join(projectRoot, '.solopreneur')) throw new Error('migration_source_scope_mismatch');
  const sourceInfo = await fs.promises.lstat(sourceRoot);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('migration_source_invalid');
  const project = await store.registerProject({ root: projectRoot });
  const identity = `project-legacy-files:${projectRoot}`;
  const result: MemoryImportResult = { imported: 0, unchanged: 0, originalBytes: 0, conflicts: [], retainedFiles: [], interrupted: false };
  const liveRuns = discoverLegacyRunProcesses(projectRoot).map(owner => ({ runDirectory: path.resolve(owner.runDirectory), executionLogId: owner.executionLogId }));
  for (const source of await projectFiles(physicalSourceRoot)) {
    if (options.shouldContinue && !options.shouldContinue()) return { ...result, interrupted: true };
    if (!source.retired) { result.retainedFiles.push(source.file); continue; }
    if (source.unsafe) {
      result.conflicts.push({ source: source.file, error: 'migration_source_invalid' });
      result.retainedFiles.push(source.file);
      continue;
    }
    try {
      const captured = await stableFile(physicalSourceRoot, source.file);
      result.originalBytes += captured.bytes.length;
      const normalizedKey = source.key.split(path.sep).join('/');
      const runRelative = normalizedKey.startsWith('agent-runs/') ? normalizedKey.slice('agent-runs/'.length) : '';
      const runFile = runRelative ? path.resolve(projectRoot, '.solopreneur', 'agent-runs', runRelative) : '';
      const statusMatch = /^agent-status\/(\d+)\.json$/.exec(normalizedKey);
      const processOwnsSource = runFile
        ? liveRuns.some(owner => runFile === owner.runDirectory || runFile.startsWith(owner.runDirectory + path.sep))
        : statusMatch ? liveRuns.some(owner => owner.executionLogId === Number(statusMatch[1])) : false;
      let statusOwnsSource = false;
      if (statusMatch) {
        try { statusOwnsSource = store.historicalRunOwnerAlive(JSON.parse(captured.bytes.toString('utf8'))); }
        catch { /* Invalid historical status is archived after no live process claims it. */ }
      }
      if (processOwnsSource || statusOwnsSource) { result.retainedFiles.push(source.file); continue; }
      store.captureMigrationSource({ identity, key: source.key, hash: captured.hash }, captured.bytes, {
        mimeType: mimeType(source.file), encoding: /^(?:text\/|application\/(?:json|javascript|x-ndjson))/.test(mimeType(source.file)) ? 'utf8' : 'binary'
      });
      const archived = store.archiveMigrationSource({ identity, key: source.key, hash: captured.hash }, captured.bytes, {
        reason: 'retired SoloMap project file', mimeType: mimeType(source.file), projectId: project.projectId
      });
      result.archivedSources ||= [];
      result.archivedSources.push({ source: source.key, error: 'retired SoloMap project file', evidenceRef: `solomap://evidence/${archived.objectId}` });
      if (archived.unchanged) result.unchanged++; else result.imported++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.conflicts.push({ source: source.file, error: message });
      result.retainedFiles.push(source.file);
    }
    options.onProgress?.(result);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return result;
}
