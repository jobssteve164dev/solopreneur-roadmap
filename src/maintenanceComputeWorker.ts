import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { parentPort, threadId, workerData } from 'worker_threads';
import { DiskDatabase } from './db/diskDatabase';
import { describeGrowthSnapshotStage, UnifiedDataStore } from './db/unifiedDataStore';
import { createDatabaseGenerationBaseline, readDatabaseGenerationReclaimManifest } from './databaseGeneration';
import { buildCompleteProjectGrowthSnapshot } from './projectGrowth';
import type { ProjectGrowthScanOptions } from './projectGrowth';
import { captureProjectContentHash, computeProjectCoverageSnapshot } from './projectCoverage';
import type { ProjectCoverageSnapshot } from './projectCoverage';
import { CsvStore } from './db/csvStore';
import type { GrowthSnapshotData, GrowthSnapshotStageManifest, GrowthSnapshotStageSection, RoadmapNode, RunIndexEntry } from './db/types';
import { collectStartupDataMigrations } from './runtimeDatabaseBootstrap';
import { buildDocumentationAudit, mergeDocumentationManifestsForPersistence, refreshDocumentationManifest, type DocumentationAuditOptions, type DocumentationManifest } from './documentationManifest';

const port = parentPort;
if (!port) throw new Error('maintenance_compute_parent_missing');
const configuration = workerData as { root?: string; databaseId?: string };
let readStore: UnifiedDataStore | undefined;
const growthStages = new Map<string, { manifest: GrowthSnapshotStageManifest; snapshot: GrowthSnapshotData }>();
const GROWTH_STAGE_PAGE_SIZE = 200;

function maintenanceReadStore(): UnifiedDataStore {
  if (!configuration.root || !configuration.databaseId) throw new Error('maintenance_database_identity_missing');
  readStore ||= UnifiedDataStore.openReadOnly(configuration.root, configuration.databaseId);
  return readStore;
}

async function restoreRecyclingFile(input: { itemId: string; destination: string; expectedHash: string; sourcePath?: string; symbolicLink?: boolean; alreadyRestored?: boolean }): Promise<{ path: string; receiptPath: string; sha256: string; bytes: number; sourceDevice?: number; sourceInode?: number }> {
  if (!configuration.root || !configuration.databaseId || !/^[a-f0-9-]{36}$/i.test(input.itemId) || !path.isAbsolute(input.destination)) throw new Error('recycling_path_invalid');
  const recycleRoot = path.join(path.resolve(configuration.root), '.migration-recycle');
  await fs.promises.mkdir(recycleRoot, { recursive: true, mode: 0o700 });
  const recycleInfo = await fs.promises.lstat(recycleRoot);
  if (!recycleInfo.isDirectory() || recycleInfo.isSymbolicLink() || await fs.promises.realpath(recycleRoot) !== recycleRoot) throw new Error('recycling_path_invalid');
  if (input.sourcePath && path.resolve(input.sourcePath) !== path.join(recycleRoot, `${input.itemId}.json`)) throw new Error('recycling_path_invalid');
  const parent = path.dirname(input.destination);
  await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await fs.promises.lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || await fs.promises.realpath(parent) !== parent) throw new Error('recycling_path_invalid');
  const globalReceipt = path.join(recycleRoot, `${input.itemId}.restore-maintenance`);
  const localReceipt = path.join(parent, `.solomap-restore-${input.itemId}`);
  if (input.alreadyRestored) {
    if (!input.expectedHash) throw new Error('recycling_snapshot_changed');
    const existing = input.symbolicLink ? Buffer.from(await fs.promises.readlink(input.destination), 'utf8') : await fs.promises.readFile(input.destination);
    const sha256 = crypto.createHash('sha256').update(existing).digest('hex');
    if (sha256 !== input.expectedHash) throw new Error('restore_target_exists');
    let receiptPath = '';
    for (const candidate of [globalReceipt, localReceipt]) {
      try {
        const [receipt, destination] = await Promise.all([fs.promises.lstat(candidate), fs.promises.lstat(input.destination)]);
        if (receipt.dev !== destination.dev || receipt.ino !== destination.ino) throw new Error('restore_target_exists');
        receiptPath = candidate; break;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return { path: input.destination, receiptPath, sha256, bytes: existing.length };
  }
  const store = maintenanceReadStore();
  let bytes: Buffer, sourceInfo: fs.Stats | undefined;
  if (input.sourcePath) {
    sourceInfo = await fs.promises.lstat(input.sourcePath);
    bytes = input.symbolicLink ? Buffer.from(await fs.promises.readlink(input.sourcePath), 'utf8') : await fs.promises.readFile(input.sourcePath);
    const after = await fs.promises.lstat(input.sourcePath);
    if (sourceInfo.dev !== after.dev || sourceInfo.ino !== after.ino || sourceInfo.size !== after.size || sourceInfo.mtimeMs !== after.mtimeMs) throw new Error('recycling_source_changed');
  }
  else bytes = store.recyclingSnapshot(input.itemId).bytes;
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (input.expectedHash && sha256 !== input.expectedHash) throw new Error('recycling_snapshot_changed');
  const target = bytes.toString('utf8');
  if (input.symbolicLink && (!Buffer.from(target, 'utf8').equals(bytes) || target.includes('\0'))) throw new Error('recycling_snapshot_changed');
  const writeReceipt = async (receiptPath: string): Promise<void> => {
    try {
      if (input.symbolicLink) await fs.promises.symlink(target, receiptPath);
      else {
        const handle = await fs.promises.open(receiptPath, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = input.symbolicLink ? Buffer.from(await fs.promises.readlink(receiptPath), 'utf8') : await fs.promises.readFile(receiptPath);
      if (!existing.equals(bytes)) throw new Error('recycling_source_changed');
    }
  };
  let receiptPath = globalReceipt;
  await writeReceipt(receiptPath);
  const publish = async (): Promise<void> => {
    try { await fs.promises.link(receiptPath, input.destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        receiptPath = localReceipt;
        await writeReceipt(receiptPath);
        await fs.promises.link(receiptPath, input.destination);
        return;
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const [receipt, destination] = await Promise.all([fs.promises.lstat(receiptPath), fs.promises.lstat(input.destination)]);
      if (receipt.dev !== destination.dev || receipt.ino !== destination.ino) throw new Error('restore_target_exists');
    }
  };
  await publish();
  const [receipt, destination] = await Promise.all([fs.promises.lstat(receiptPath), fs.promises.lstat(input.destination)]);
  if (receipt.dev !== destination.dev || receipt.ino !== destination.ino || (input.symbolicLink ? !destination.isSymbolicLink() : !destination.isFile() || destination.isSymbolicLink())) throw new Error('restore_target_exists');
  return { path: input.destination, receiptPath, sha256, bytes: bytes.length,
    ...(sourceInfo ? { sourceDevice: sourceInfo.dev, sourceInode: sourceInfo.ino } : {}) };
}

async function cleanupRecyclingRestore(input: { itemId: string; destination: string; receiptPath: string; heldPath?: string; expectedHash?: string; sourceDevice?: number; sourceInode?: number }): Promise<void> {
  if (!configuration.root || !/^[a-f0-9-]{36}$/i.test(input.itemId) || !path.isAbsolute(input.destination) || !input.expectedHash) throw new Error('recycling_path_invalid');
  const recycleRoot = path.join(path.resolve(configuration.root), '.migration-recycle');
  const destinationInfo = await fs.promises.lstat(input.destination);
  const destinationBytes = destinationInfo.isSymbolicLink() ? Buffer.from(await fs.promises.readlink(input.destination), 'utf8') : await fs.promises.readFile(input.destination);
  if (crypto.createHash('sha256').update(destinationBytes).digest('hex') !== input.expectedHash) throw new Error('restore_target_exists');
  if (input.receiptPath) {
    const allowedReceipt = new Set([path.join(recycleRoot, `${input.itemId}.restore-maintenance`), path.join(path.dirname(input.receiptPath), `.solomap-restore-${input.itemId}`)]);
    if (!allowedReceipt.has(path.resolve(input.receiptPath))) throw new Error('recycling_path_invalid');
    try {
      const receipt = await fs.promises.lstat(input.receiptPath);
      if (receipt.dev !== destinationInfo.dev || receipt.ino !== destinationInfo.ino) throw new Error('restore_target_exists');
      await fs.promises.unlink(input.receiptPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (input.heldPath) {
    if (path.resolve(input.heldPath) !== path.join(recycleRoot, `${input.itemId}.json`)) throw new Error('recycling_path_invalid');
    try {
      const info = await fs.promises.lstat(input.heldPath);
      if (input.sourceDevice !== undefined && (info.dev !== input.sourceDevice || info.ino !== input.sourceInode)) throw new Error('recycling_source_changed');
      const bytes = info.isSymbolicLink() ? Buffer.from(await fs.promises.readlink(input.heldPath), 'utf8') : await fs.promises.readFile(input.heldPath);
      if (input.expectedHash && crypto.createHash('sha256').update(bytes).digest('hex') !== input.expectedHash) throw new Error('recycling_source_changed');
      await fs.promises.unlink(input.heldPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

async function buildProjectGrowthStage(input: { projectPath: string; extensionPath: string; options?: Omit<ProjectGrowthScanOptions, 'now'> & { now?: string } }): Promise<GrowthSnapshotStageManifest> {
  const store = maintenanceReadStore();
  const projectPath = path.resolve(input.projectPath);
  const projectId = store.lookupProjectForRead(projectPath);
  if (!projectId) throw new Error('project_not_registered');
  const roadmapNodes = new CsvStore(path.join(projectPath, '.solopreneur', 'roadmap.csv')).readNodes();
  const runEntries: RunIndexEntry[] = [];
  let beforeExecutionLogId = 0;
  for (;;) {
    const page = store.readProjectRunIndexes(projectId, { limit: GROWTH_STAGE_PAGE_SIZE, ...(beforeExecutionLogId ? { beforeExecutionLogId } : {}) });
    runEntries.push(...page);
    if (page.length < GROWTH_STAGE_PAGE_SIZE) break;
    beforeExecutionLogId = Math.min(...page.map(entry => entry.executionLogId));
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const { now, ...rawOptions } = input.options || {};
  const options: ProjectGrowthScanOptions = { ...rawOptions, ...(now ? { now: new Date(now) } : {}) };
  const snapshot = await buildCompleteProjectGrowthSnapshot(projectPath, input.extensionPath, roadmapNodes, runEntries, options);
  const stageId = crypto.randomUUID();
  const manifest: GrowthSnapshotStageManifest = {
    stageId,
    ...describeGrowthSnapshotStage(snapshot, {
      gitHead: String(options.gitFacts?.head || snapshot.snapshot.gitHead || ''),
      contentHash: captureProjectContentHash(projectPath)
    })
  };
  growthStages.set(stageId, { manifest, snapshot });
  return manifest;
}

function readProjectGrowthStagePage(stageId: string, section: GrowthSnapshotStageSection, offset: number): { items: unknown[]; nextOffset: number | null } {
  const stage = growthStages.get(stageId);
  if (!stage) throw new Error('growth_refresh_stage_missing');
  if (!['nodes', 'edges', 'signals', 'labels'].includes(section) || !Number.isInteger(offset) || offset < 0) throw new Error('invalid_growth_refresh_stage_page');
  const values = stage.snapshot[section] as unknown[];
  const items = values.slice(offset, offset + GROWTH_STAGE_PAGE_SIZE);
  return { items, nextOffset: offset + items.length < values.length ? offset + items.length : null };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('invalid_data: undefined is not a persisted value');
  return encoded;
}

async function digestFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const before = await fs.promises.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('maintenance_file_invalid');
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => { bytes += chunk.length; hash.update(chunk); });
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  const after = await fs.promises.lstat(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes !== after.size) {
    throw new Error('maintenance_file_changed');
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function inspectBackup(file: string): Promise<{ databaseId: string; sha256: string; bytes: number }> {
  const source = path.resolve(file);
  const stat = await fs.promises.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('backup_source_invalid');
  for (const suffix of ['-wal', '-shm']) {
    try { if ((await fs.promises.lstat(`${source}${suffix}`)).size > 0) throw new Error('backup_source_active'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  let database: DiskDatabase | undefined;
  let databaseId = '';
  try {
    database = new DiskDatabase(source, { readOnly: true, immutable: true });
    const integrity = database.exec('PRAGMA integrity_check')[0]?.values?.[0]?.[0];
    const identity = database.exec("SELECT value FROM database_meta WHERE key='database_id'")[0]?.values?.[0]?.[0];
    if (integrity !== 'ok' || typeof identity !== 'string' || !identity) throw new Error('backup_source_invalid');
    databaseId = identity;
  } catch (error) { if ((error as Error).message === 'backup_source_active') throw error; throw new Error('backup_source_invalid'); }
  finally { database?.close(); }
  return { databaseId, ...await digestFile(source) };
}

async function restoreBackup(input: { source: string; destinationRoot: string; databaseId: string; sha256: string; bytes: number }): Promise<{ destination: string; databaseId: string; sha256: string; bytes: number }> {
  const source = path.resolve(input.source), root = path.resolve(input.destinationRoot), destination = path.join(root, 'solomap.db');
  const inspected = await inspectBackup(source);
  if (inspected.databaseId !== input.databaseId || inspected.sha256 !== input.sha256 || inspected.bytes !== input.bytes) throw new Error('maintenance_file_changed');
  try {
    const rootStat = await fs.promises.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('restore_target_invalid');
    const names = await fs.promises.readdir(root);
    if (names.some(name => name !== 'solomap.db' && !name.startsWith('.solomap-restore-'))) throw new Error('restore_target_not_empty');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  }
  const rootStat = await fs.promises.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.promises.realpath(root) !== root) throw new Error('restore_target_invalid');
  const descriptor = fs.openSync(root, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
  const openedRoot = fs.fstatSync(descriptor);
  if (openedRoot.dev !== rootStat.dev || openedRoot.ino !== rootStat.ino) { fs.closeSync(descriptor); throw new Error('restore_target_invalid'); }
  const descriptorRoot = process.platform === 'linux' ? `/proc/self/fd/${descriptor}` : process.platform === 'darwin' ? `/dev/fd/${descriptor}` : root;
  const stableDestination = path.join(descriptorRoot, 'solomap.db');
  const assertRootStable = async (): Promise<void> => {
    const current = await fs.promises.lstat(root);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== openedRoot.dev || current.ino !== openedRoot.ino) throw new Error('restore_target_invalid');
  };
  try {
    const existing = await inspectBackup(stableDestination);
    if (existing.databaseId !== input.databaseId || existing.sha256 !== input.sha256 || existing.bytes !== input.bytes) throw new Error('restore_target_exists');
    fs.closeSync(descriptor);
    return { destination, databaseId: input.databaseId, sha256: input.sha256, bytes: input.bytes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as Error).message !== 'backup_source_invalid') { fs.closeSync(descriptor); throw error; }
  }
  const temporary = path.join(descriptorRoot, `.solomap-restore-${input.sha256.slice(0, 24)}`);
  let createdDestination = false;
  try {
    await assertRootStable();
    try {
      const staged = await digestFile(temporary);
      if (staged.sha256 !== input.sha256 || staged.bytes !== input.bytes) await fs.promises.unlink(temporary);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await fs.promises.chmod(temporary, 0o600);
    const staged = await inspectBackup(temporary);
    if (staged.databaseId !== input.databaseId || staged.sha256 !== input.sha256 || staged.bytes !== input.bytes) throw new Error('backup_source_invalid');
    await assertRootStable();
    try { await fs.promises.link(temporary, stableDestination); createdDestination = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await inspectBackup(stableDestination);
      if (existing.databaseId !== input.databaseId || existing.sha256 !== input.sha256 || existing.bytes !== input.bytes) throw new Error('restore_target_exists');
    }
    await assertRootStable();
    await fs.promises.unlink(temporary);
    fs.closeSync(descriptor);
    return { destination, databaseId: input.databaseId, sha256: input.sha256, bytes: input.bytes };
  } catch (error) {
    try { await fs.promises.unlink(temporary); } catch {}
    if (createdDestination) try { await fs.promises.unlink(stableDestination); } catch {}
    fs.closeSync(descriptor);
    throw error;
  }
}

function verifiedGenerationDirectory(raw: string): string {
  if (!configuration.root) throw new Error('maintenance_database_identity_missing');
  const directory = path.resolve(raw), parent = path.resolve(configuration.root, 'database-generations');
  const relative = path.relative(parent, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !/^[a-f0-9-]{36}$/.test(relative)) throw new Error('database_generation_path_invalid');
  return directory;
}

async function buildProjectImportGeneration(input: { candidateDir: string; source: string; targetRoot: string; idempotencyKey: string }): Promise<Record<string, unknown>> {
  const candidateDir = verifiedGenerationDirectory(input.candidateDir);
  const hiddenRoot = path.join(candidateDir, 'project-files');
  const candidate = UnifiedDataStore.open(candidateDir, configuration.databaseId);
  try {
    const sourceHash = candidate.prepareProjectImport(input.source).sourceHash;
    const imported = await candidate.importProject({ source: input.source, root: hiddenRoot, idempotencyKey: input.idempotencyKey });
    const result = candidate.retargetPreparedProjectImport({ ...imported, hiddenRoot, targetRoot: input.targetRoot, sourceHash, idempotencyKey: input.idempotencyKey });
    const verified = candidate.verifyDatabaseGeneration();
    return { ...result, hiddenIdentityPath: path.join(hiddenRoot, '.solopreneur', 'project.json'), hiddenRoadmapPath: path.join(hiddenRoot, '.solopreneur', 'roadmap.csv'), ...verified };
  } finally { candidate.close(); }
}

function applyProjectImportGenerationChangeset(input: { candidateDir: string; changesetFile: string; searchObjectIds: string[]; previousLiveSequence: number; currentLiveSequence: number }): void {
  const candidateDir = verifiedGenerationDirectory(input.candidateDir);
  const changesetFile = path.resolve(input.changesetFile);
  if (path.dirname(changesetFile) !== path.join(candidateDir, 'changesets') || !/^\d{12}\.changeset$/.test(path.basename(changesetFile))) throw new Error('database_generation_changeset_path_invalid');
  const candidate = UnifiedDataStore.open(candidateDir, configuration.databaseId);
  try { candidate.applyDatabaseGenerationChangeset(fs.readFileSync(changesetFile), input.searchObjectIds, input.previousLiveSequence, input.currentLiveSequence); }
  finally { candidate.close(); }
}

port.on('message', async (message: { id?: number; operation?: string; file?: string; value?: unknown; source?: string; root?: string; tables?: string[]; destinationRoot?: string; destination?: string; databaseId?: string; sha256?: string; expectedHash?: string; bytes?: number; limit?: number; contentId?: string; outboxId?: string; itemId?: string; sourcePath?: string; receiptPath?: string; heldPath?: string; sourceDevice?: number; sourceInode?: number; symbolicLink?: boolean; alreadyRestored?: boolean; ref?: string; revision?: number; format?: 'json' | 'md' | 'text'; agentProjection?: boolean; candidateDir?: string; targetRoot?: string; idempotencyKey?: string; changesetFile?: string; searchObjectIds?: string[]; previousLiveSequence?: number; currentLiveSequence?: number; stageDirectory?: string; stageId?: string; section?: string; offset?: number; projectId?: string; manifest?: DocumentationManifest; projectPath?: string; globalOnly?: boolean; extensionPath?: string; gitHead?: string; roadmapNodes?: RoadmapNode[]; runEntries?: RunIndexEntry[]; options?: Omit<ProjectGrowthScanOptions, 'now'> & { now?: string }; auditOptions?: DocumentationAuditOptions; close?: boolean }) => {
  if (message.close) {
    readStore?.close();
    port.postMessage({ closed: true });
    port.close();
    return;
  }
  const id = Number(message.id);
  try {
    if (message.operation === 'digest_file') {
      port.postMessage({ id, result: await digestFile(String(message.file || '')) });
      return;
    }
    if (message.operation === 'discover_startup_migrations') {
      port.postMessage({ id, result: await collectStartupDataMigrations(maintenanceReadStore(), () => true,
        message.projectPath ? path.resolve(message.projectPath) : undefined, Boolean(message.globalOnly)) });
      return;
    }
    if (message.operation === 'prepare_documentation_manifest_sync') {
      const store = maintenanceReadStore();
      const projectId = String(message.projectId || '');
      if (!projectId || !message.manifest) throw new Error('invalid_documentation_manifest');
      const current = store.readDocumentationManifest(projectId);
      const manifest = mergeDocumentationManifestsForPersistence(current, message.manifest);
      const comparable = (value: DocumentationManifest) => canonical({
        schemaVersion: value.schemaVersion,
        documents: value.documents,
        pendingReview: value.pendingReview,
        lastAudit: value.lastAudit || null
      });
      const expectedHead = comparable(current);
      port.postMessage({ id, result: { manifest, expectedHead, unchanged: expectedHead === comparable(manifest) } });
      return;
    }
    if (message.operation === 'refresh_documentation_manifest') {
      const root = path.resolve(String(message.root || ''));
      const store = maintenanceReadStore();
      const projectId = store.lookupProjectForRead(root);
      if (!projectId) throw new Error('project_not_registered');
      port.postMessage({ id, result: refreshDocumentationManifest(root, store.readDocumentationManifest(projectId)) });
      return;
    }
    if (message.operation === 'audit_documentation_manifest') {
      const root = path.resolve(String(message.root || ''));
      const store = maintenanceReadStore();
      const projectId = store.lookupProjectForRead(root);
      if (!projectId) throw new Error('project_not_registered');
      port.postMessage({ id, result: buildDocumentationAudit(root, store.readDocumentationManifest(projectId),
        message.auditOptions || {}) });
      return;
    }
    if (message.operation === 'canonicalize') {
      port.postMessage({ id, result: canonical(message.value) });
      return;
    }
    if (message.operation === 'build_project_growth_snapshot') {
      const { now, ...rawOptions } = message.options || {};
      const options: ProjectGrowthScanOptions = { ...rawOptions, ...(now ? { now: new Date(now) } : {}) };
      port.postMessage({ id, result: await buildCompleteProjectGrowthSnapshot(
        String(message.projectPath || ''), String(message.extensionPath || ''), message.roadmapNodes || [], message.runEntries || [], options
      ) });
      return;
    }
    if (message.operation === 'build_project_growth_stage') {
      port.postMessage({ id, result: await buildProjectGrowthStage({ projectPath: String(message.projectPath || ''), extensionPath: String(message.extensionPath || ''), options: message.options }) });
      return;
    }
    if (message.operation === 'read_project_growth_stage_page') {
      port.postMessage({ id, result: readProjectGrowthStagePage(String(message.stageId || ''), String(message.section || '') as GrowthSnapshotStageSection, Number(message.offset || 0)) });
      return;
    }
    if (message.operation === 'cleanup_project_growth_stage') {
      growthStages.delete(String(message.stageId || ''));
      port.postMessage({ id, result: null });
      return;
    }
    if (message.operation === 'compute_project_coverage') {
      const store = maintenanceReadStore();
      const projectPath = path.resolve(String(message.projectPath || ''));
      const projectId = store.lookupProjectForRead(projectPath);
      if (!projectId) throw new Error('project_not_registered');
      const current = store.readAnalysisState(projectId, 'coverage', 'project-growth');
      const previous = current.value && typeof current.value === 'object' ? current.value as ProjectCoverageSnapshot : null;
      port.postMessage({ id, result: await computeProjectCoverageSnapshot(projectPath, String(message.extensionPath || ''), previous, String(message.gitHead || '')) });
      return;
    }
    if (message.operation === 'prepare_run_index_backfill') {
      if (!configuration.root || !configuration.databaseId) throw new Error('maintenance_database_identity_missing');
      const store = UnifiedDataStore.openReadOnly(configuration.root, configuration.databaseId);
      try {
        const projectPath = path.resolve(String(message.projectPath || ''));
        const projectId = store.lookupProjectForRead(projectPath);
        if (!projectId) throw new Error('project_not_registered');
        port.postMessage({ id, result: store.prepareRunIndexBackfill(projectId, Math.max(1, Math.min(20, Number(message.limit || 1)))) });
      } finally { store.close(); }
      return;
    }
    if (message.operation === 'inspect_backup') {
      port.postMessage({ id, result: await inspectBackup(String(message.file || '')) });
      return;
    }
    if (message.operation === 'restore_backup') {
      port.postMessage({ id, result: await restoreBackup({ source: String(message.source || ''), destinationRoot: String(message.destinationRoot || ''), databaseId: String(message.databaseId || ''), sha256: String(message.sha256 || ''), bytes: Number(message.bytes || 0) }) });
      return;
    }
    if (message.operation === 'prepare_project_import') {
      if (!configuration.root || !configuration.databaseId) throw new Error('maintenance_database_identity_missing');
      readStore ||= UnifiedDataStore.openReadOnly(configuration.root, configuration.databaseId);
      port.postMessage({ id, result: readStore.prepareProjectImport(String(message.source || '')) });
      return;
    }
    if (message.operation === 'inspect_project_import') {
      if (!configuration.root || !configuration.databaseId) throw new Error('maintenance_database_identity_missing');
      readStore ||= UnifiedDataStore.openReadOnly(configuration.root, configuration.databaseId);
      const prepared = readStore.prepareProjectImport(String(message.source || ''));
      port.postMessage({ id, result: { sourceHash: prepared.sourceHash, projectId: prepared.archive.projectId } });
      return;
    }
    if (message.operation === 'stage_project_export') {
      if (!configuration.root || !configuration.databaseId) throw new Error('maintenance_database_identity_missing');
      readStore ||= UnifiedDataStore.openReadOnly(configuration.root, configuration.databaseId);
      const prepared = await readStore.prepareProjectExport(String(message.root || ''));
      const directory = path.join(configuration.root, '.solomap-maintenance-staging');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stageDirectory = path.join(directory, `project-export-${crypto.randomUUID()}`);
      fs.mkdirSync(stageDirectory, { mode: 0o700 });
      const stagedPath = path.join(stageDirectory, 'archive.stage');
      const descriptor = fs.openSync(stagedPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      try { fs.writeFileSync(descriptor, prepared.envelope); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      const staged = await digestFile(stagedPath);
      if (staged.sha256 !== prepared.content.sha256 || staged.bytes !== prepared.envelope.byteLength) throw new Error('project_export_staging_invalid');
      const chunksDirectory = path.join(stageDirectory, 'chunks');
      fs.mkdirSync(chunksDirectory, { recursive: true, mode: 0o700 });
      const chunks = prepared.content.chunks.map(chunk => {
        const file = path.join(chunksDirectory, `${String(chunk.ordinal).padStart(8, '0')}.chunk`);
        const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
        try { fs.writeFileSync(descriptor, chunk.data); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
        return { ordinal: chunk.ordinal, file, bytes: chunk.data.byteLength, sha256: crypto.createHash('sha256').update(chunk.data).digest('hex') };
      });
      const contentManifestPath = path.join(chunksDirectory, 'manifest.json');
      const manifest = { sha256: prepared.content.sha256, mimeType: prepared.content.mimeType, encoding: prepared.content.encoding,
        byteLength: prepared.content.byteLength, storedByteLength: prepared.content.storedByteLength,
        data: Buffer.from(prepared.content.data).toString('base64'), chunkIndexJson: prepared.content.chunkIndexJson, chunks };
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      const manifestDescriptor = fs.openSync(contentManifestPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      try { fs.writeFileSync(manifestDescriptor, manifestBytes); fs.fsyncSync(manifestDescriptor); } finally { fs.closeSync(manifestDescriptor); }
      port.postMessage({ id, result: { projectId: prepared.projectId, path: stagedPath, sha256: staged.sha256, bytes: staged.bytes, tableCount: prepared.tableCount,
        contentManifestPath, manifestSha256: crypto.createHash('sha256').update(manifestBytes).digest('hex'), stageDirectory } });
      return;
    }
    if (message.operation === 'verify_project_export_content') {
      if (!configuration.root || !configuration.databaseId) throw new Error('maintenance_database_identity_missing');
      readStore ||= UnifiedDataStore.openReadOnly(configuration.root, configuration.databaseId);
      const bytes = readStore.readContentForMaintenance(String(message.contentId || ''));
      if (bytes.byteLength !== Number(message.bytes) || crypto.createHash('sha256').update(bytes).digest('hex') !== String(message.sha256 || '')) throw new Error('project_export_content_invalid');
      port.postMessage({ id, result: null }); return;
    }
    if (message.operation === 'cleanup_project_export_stage') {
      const stagingRoot = path.join(String(configuration.root || ''), '.solomap-maintenance-staging');
      const stageDirectory = path.resolve(String(message.stageDirectory || ''));
      if (path.dirname(stageDirectory) !== stagingRoot || !/^project-export-[a-f0-9-]{36}$/.test(path.basename(stageDirectory))) throw new Error('project_export_staging_invalid');
      const chunks = path.join(stageDirectory, 'chunks');
      if (fs.existsSync(chunks)) { for (const name of fs.readdirSync(chunks)) fs.unlinkSync(path.join(chunks, name)); fs.rmdirSync(chunks); }
      for (const name of fs.readdirSync(stageDirectory)) fs.unlinkSync(path.join(stageDirectory, name));
      fs.rmdirSync(stageDirectory);
      port.postMessage({ id, result: null }); return;
    }
    if (message.operation === 'stage_file_export') {
      if (!configuration.root || !configuration.databaseId) throw new Error('maintenance_database_identity_missing');
      readStore ||= UnifiedDataStore.openReadOnly(configuration.root, configuration.databaseId);
      port.postMessage({ id, result: readStore.stageFileExport({ outboxId: String(message.outboxId || ''),
        ...(message.contentId ? { contentId: String(message.contentId) } : {}), ...(message.ref ? { ref: String(message.ref) } : {}),
        ...(message.revision ? { revision: Number(message.revision) } : {}), ...(message.format ? { format: message.format } : {}),
        ...(message.agentProjection ? { agentProjection: true } : {}) }) });
      return;
    }
    if (message.operation === 'restore_recycling_file') {
      port.postMessage({ id, result: await restoreRecyclingFile({ itemId: String(message.itemId || ''), destination: String(message.destination || ''), expectedHash: String(message.expectedHash || ''),
        ...(message.sourcePath ? { sourcePath: String(message.sourcePath) } : {}), ...(message.symbolicLink ? { symbolicLink: true } : {}), ...(message.alreadyRestored ? { alreadyRestored: true } : {}) }) });
      return;
    }
    if (message.operation === 'cleanup_recycling_restore') {
      await cleanupRecyclingRestore({ itemId: String(message.itemId || ''), destination: String(message.destination || ''), receiptPath: String(message.receiptPath || ''), ...(message.heldPath ? { heldPath: String(message.heldPath) } : {}),
        ...(message.expectedHash ? { expectedHash: String(message.expectedHash) } : {}), ...(message.sourceDevice !== undefined ? { sourceDevice: Number(message.sourceDevice), sourceInode: Number(message.sourceInode) } : {}) });
      port.postMessage({ id, result: null }); return;
    }
    if (message.operation === 'build_project_import_generation') {
      port.postMessage({ id, result: await buildProjectImportGeneration({ candidateDir: String(message.candidateDir || ''), source: String(message.source || ''), targetRoot: String(message.targetRoot || ''), idempotencyKey: String(message.idempotencyKey || '') }) });
      return;
    }
    if (message.operation === 'backup_database_generation') {
      const candidateDir = verifiedGenerationDirectory(String(message.candidateDir || ''));
      if (!configuration.root || !configuration.databaseId) throw new Error('maintenance_database_identity_missing');
      await createDatabaseGenerationBaseline(path.join(configuration.root, 'solomap.db'), path.join(candidateDir, 'solomap.db'), configuration.databaseId);
      const candidate = UnifiedDataStore.open(candidateDir, configuration.databaseId);
      try { port.postMessage({ id, result: candidate.readRuntimeWriterBarrier() }); }
      finally { candidate.close(); }
      return;
    }
    if (message.operation === 'apply_project_import_generation_changeset') {
      applyProjectImportGenerationChangeset({ candidateDir: String(message.candidateDir || ''), changesetFile: String(message.changesetFile || ''), searchObjectIds: Array.isArray(message.searchObjectIds) ? message.searchObjectIds.map(String) : [], previousLiveSequence: Number(message.previousLiveSequence), currentLiveSequence: Number(message.currentLiveSequence) });
      port.postMessage({ id, result: null });
      return;
    }
    if (message.operation === 'verify_project_import_generation') {
      const candidate = UnifiedDataStore.open(verifiedGenerationDirectory(String(message.candidateDir || '')), configuration.databaseId);
      try { port.postMessage({ id, result: candidate.verifyDatabaseGeneration() }); } finally { candidate.close(); }
      return;
    }
    if (message.operation === 'read_database_generation_reclaim_manifest') {
      if (!configuration.root) throw new Error('maintenance_database_identity_missing');
      port.postMessage({ id, result: readDatabaseGenerationReclaimManifest(configuration.root) });
      return;
    }
    if (message.operation === 'validate_project_import') {
      if (!configuration.root || !configuration.databaseId) throw new Error('maintenance_database_identity_missing');
      readStore ||= UnifiedDataStore.openReadOnly(configuration.root, configuration.databaseId);
      readStore.validateStagedProjectImport(Array.isArray(message.tables) ? message.tables : []);
      port.postMessage({ id, result: null });
      return;
    }
    throw new Error('maintenance_compute_operation_unknown');
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});

port.postMessage({ ready: true, threadId });
