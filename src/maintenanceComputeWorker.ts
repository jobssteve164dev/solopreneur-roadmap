import { prepareDiagnosticEvent, type DiagnosticEventInput } from './db/diagnosticPublication.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { computeRunInputFile, type RunInputFileRequest } from './runInputFile.js';
import { inspectProjectMigration, type ProjectMigrationInspection } from './projectMigrationInspection.js';
import { dataValueTransferIfDeep } from './db/dataValueTransfer.js';
import type { HostSettingsPreparation, HostSettingsProjection } from './db/hostSettingsPublication.js';
import type { ScheduleSyncPreparation } from './db/schedulePublication.js';
import type { ContentVerificationRequest } from './db/contentVerification.js';
import type { RunInputsPreparationRequest, RunInputsPlanRequest, RunInputsResultRequest } from './db/runInputsPublication.js';
import type { RunCreationRequest, RunCreationPlanRequest } from './db/runCreationPublication.js';
import type { ImportObjectRequest } from './db/importObjectPublication.js';
import { stateWriteSelectionForTransfer,type StateWriteRequest } from './db/stateWritePublication.js';
import type { GrowthStageCaptureRequest, GrowthStageInputEncoding } from './db/growthStagePublication.js';
import { canonicalJson } from './contentReferences.js';
import type { ArchiveSourceRequest } from './db/archiveSourcePublication.js';
import type { DirectGrowthRequest } from './db/directGrowthPublication.js';
import type { LegacyReviewBatchRequest } from './db/legacyReviewBatchPublication.js';
import { restoreLegacyReviewRequest,legacyReviewResultForTransfer } from './db/legacyReviewBatchPublication.js';
import type { LessonSourceRequest } from './db/lessonSourcePublication.js';
import type { RegisteredReportTaskRequest } from './db/registeredReportTaskPublication.js';
import type { RegisteredReportRequest } from './db/registeredReportPublication.js';
import type { HistoricalRunInputPreparationRequest,HistoricalRunIdentityRequest,HistoricalRunTaskRequest,HistoricalRunSourcesRequest,HistoricalRunExistingRequest,HistoricalRunRootSelectionRequest,HistoricalRunRootTurnRequest,HistoricalRunRootMetadataRequest,HistoricalRunRootBodyRequest,HistoricalRunRootNodeRequest,HistoricalRunRootDocumentRequest,HistoricalRunRootFinalMetadataRequest,HistoricalRunRootProjectionRequest } from './db/historicalRunAdoptionPublication.js';
import type { LearningDecisionSourceRequest } from './db/learningDecisionSourcePublication.js';
import type { LearningEventSourceRequest } from './db/learningEventSourcePublication.js';
import type { LegacyReviewCursorRequest } from './db/legacyReviewCursorPublication.js';
import { GrowthStageCapture } from './db/growthStageCapture.js';
import type { StepMemoryImportRequest, StepMemoryImportSourcePlanRequest } from './db/stepMemoryImportPublication.js';
import type { StepMemoryRequest, StepMemoryBodyRequest, StepMemoryPlanRequest, StepMemoryResultRequest } from './db/stepMemoryPublication.js';
import type { RunAllocationRequest } from './db/runAllocationPublication.js';
import type { FlowRoleSelectionRequest } from './db/flowRolePublication.js';
import type { RunDeliveryStartPreparationRequest, RunControlPreparationRequest } from './db/runControlPublication.js';
import type { RunReportRequest, RunReportResultRequest } from './db/runReportPublication.js';
import type { RunLogPreparationRequest } from './db/runLogPublication.js';
import type { RunDocumentRequest, RunDocumentPlanRequest } from './db/runDocumentPublication.js';
import type { RunCheckpointInspectionRequest, RunCheckpointRequest, RunCheckpointPlanRequest } from './db/runCheckpointPublication.js';
import type { RunOutputInspectionRequest, RunOutputRequest, RunOutputPlanRequest } from './db/runOutputPublication.js';
import type { RunSettlementRequest, RunSettlementPayloadRequest, RunSettlementDigestRequest, RunSettlementDocumentationRequest, RunSettlementLearningRequest, RunSettlementStepRequest, RunSettlementStepPlanRequest, RunSettlementJournalsRequest, RunSettlementTailRequest, RunSettlementNotificationRequest } from './db/runSettlementPublication.js';
import type { RunContextRequest, CurrentRunCheckpointRequest, RunTaskIngressRequest } from './db/runContextPublication.js';
import type { RunNativeRowsRequest, RunNativeRowsReleaseRequest, RunObserverDocumentRequest, RunDocumentValueRequest } from './db/runObserverPublication.js';
import type { AgentLaunchSelectionRequest,AgentLaunchStepRequest,AgentLaunchArtifactsRequest } from './db/agentLaunchPublication.js';
import type { FlowTracePreparationRequest, FlowTracePlanRequest } from './db/flowPublication.js';
import type { DataWriteDatabaseIdentity, DataWritePreparationRequest, DataWriteSearchRequest, DataWriteReferenceDiscoveryRequest } from './db/dataWritePublication.js';
import type { LinkPreparationRequest } from './db/linkPublication.js';
import type { McpMutationAuthorizationRequest } from './db/mcpMutationAuthorization.js';
import type { RunNativeRequest } from './db/runNativePublication.js';
import type { RunConsumerClaimRequest } from './db/runConsumerClaimPublication.js';
import type { RunVerificationRequest } from './db/runVerificationPublication.js';
import type { LearningCycleRequest, LearningReviewFinishRequest, LearningReviewInterruptRequest, LearningReviewApplyRequest, LearningReviewApplyQualificationRequest, LearningReviewApplyRecoveryRequest, LearningReviewApplyResultRequest } from './db/learningReviewPublication.js';
import type { ExternalMemoryRequest } from './db/externalMemoryPublication.js';
import type { GlobalPromptSaveRequest, GlobalPromptOverridesRequest, GlobalPromptSupersedeRequest } from './db/globalPromptPublication.js';
import type { LearningReviewSourceCaptureRequest, LearningReviewSourceCapturePage, LearningReviewSourceCaptureRowRequest } from './db/learningReviewSourceCapture.js';
import type { LearningReviewPrepareEntryRequest } from './db/learningReviewPublication.js';
import type { LearningReviewPreparationRequest, LearningReviewPreparationAdvance, LearningReviewPreparationState, LearningReviewPreparationRelease, LearningReviewPreparationPhase, LearningReviewPreparationAcknowledgement, PreparedLearningReviewPreparation } from './db/learningReviewPreparePublication.js';
import type { RunTurnRequestPreparation, RunTurnRequestQualification } from './db/runTurnRequestPublication.js';
import type { ProjectRetirementPageRequest, ProjectRetirementQualificationRequest } from './db/projectRetirement.js';
import { parentPort, threadId, workerData } from 'worker_threads';
import { cleanupProjectExportStageBatch, projectExportStageOwnerBytes, syncProjectExportStageDirectory } from './projectExportStaging';
import { DiskDatabase } from './db/diskDatabase';
import { bindCandidateImportAuthority, assertCandidateImportAuthority } from './db/candidateImportAuthority.js';
import { describeGrowthSnapshotStage, prepareContentPublication, UnifiedDataStore, type ContentPublicationInput, type DatabaseImportOrderBinding } from './db/unifiedDataStore';
import { readDatabaseGenerationReclaimManifest } from './databaseGeneration';
import { createCompactDatabaseCandidate } from './db/compactDatabaseGeneration.js';
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
const configuration = workerData as { root?: string; databaseId?: string; generation?: { candidateDir: string; device: string; inode: string } };
let readStore: UnifiedDataStore | undefined;
let learningReviewCaptureStore: UnifiedDataStore | undefined;
interface LearningReviewPreparationContext {
  request:LearningReviewPreparationRequest;phase:number;iterator:AsyncGenerator<LearningReviewPreparationPhase,PreparedLearningReviewPreparation,LearningReviewPreparationAcknowledgement>;
  state?:LearningReviewPreparationState;flight?:Promise<LearningReviewPreparationState>;closing?:boolean;
}
let learningReviewPreparation:LearningReviewPreparationContext|undefined;
let verificationReadStore: {store: UnifiedDataStore; device: string; inode: string} | undefined;
let generationCandidate: { store: UnifiedDataStore; device: string; inode: string; importOrder?: DatabaseImportOrderBinding } | undefined;
const growthStages = new Map<string, { manifest: GrowthSnapshotStageManifest; snapshot: GrowthSnapshotData }>();
const growthStageCaptures=new Map<string,GrowthStageCapture>();
const generationBuilds = new Map<string, { cancelled: boolean }>();
const GROWTH_STAGE_PAGE_SIZE = 200;

function maintenanceReadStore(): UnifiedDataStore {
  if (!configuration.root || !configuration.databaseId) throw new Error('maintenance_database_identity_missing');
  readStore ||= UnifiedDataStore.openReadOnly(configuration.root, configuration.databaseId);
  if(readStore.hasOpenLearningReviewSourceCapture()){
    const file=fs.statSync(path.join(configuration.root,'solomap.db'),{bigint:true});
    return contentVerificationReadStore({databaseId:configuration.databaseId,sourceDevice:String(file.dev),sourceInode:String(file.ino)});
  }
  return readStore;
}
function contentVerificationReadStore(request: DataWriteDatabaseIdentity): UnifiedDataStore {
  if(!configuration.root || !configuration.databaseId)throw new Error('maintenance_database_identity_missing');
  const file=path.join(configuration.root,'solomap.db'),before=fs.statSync(file,{bigint:true});
  if(request.databaseId!==configuration.databaseId || request.sourceDevice!==String(before.dev) || request.sourceInode!==String(before.ino))throw new Error('content_verification_database_changed');
  if(!verificationReadStore){
    const store=UnifiedDataStore.openReadOnly(configuration.root,configuration.databaseId),after=fs.statSync(file,{bigint:true});
    if(before.dev!==after.dev || before.ino!==after.ino){store.close();throw new Error('content_verification_database_changed');}
    verificationReadStore={store,device:String(after.dev),inode:String(after.ino)};
  }
  if(verificationReadStore.device!==request.sourceDevice || verificationReadStore.inode!==request.sourceInode)throw new Error('content_verification_database_changed');
  return verificationReadStore.store;
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
  if (configuration.generation) {
    const stat = fs.lstatSync(directory, { bigint: true });
    if (directory !== path.resolve(configuration.generation.candidateDir) || !stat.isDirectory() || stat.isSymbolicLink()
      || String(stat.dev) !== configuration.generation.device || String(stat.ino) !== configuration.generation.inode) throw new Error('database_generation_directory_changed');
  }
  return directory;
}

function retainGenerationCandidate(candidate: UnifiedDataStore, importOrder?: DatabaseImportOrderBinding): void {
  if (!configuration.generation || generationCandidate) throw new Error('database_generation_validation_active');
  candidate.acceptVerifiedDatabaseGenerationBaseline();
  const stat = fs.lstatSync(candidate.filePath, { bigint: true });
  generationCandidate = { store: candidate, device: String(stat.dev), inode: String(stat.ino), importOrder };
}
function currentGenerationCandidate(directory: string): UnifiedDataStore {
  if (!configuration.generation) return UnifiedDataStore.open(directory, configuration.databaseId);
  const current = generationCandidate;
  if (!current) throw new Error('database_generation_baseline_changed');
  const stat = fs.lstatSync(path.join(directory, 'solomap.db'), { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || String(stat.dev) !== current.device || String(stat.ino) !== current.inode) throw new Error('database_generation_candidate_changed');
  return current.store;
}
function closeGenerationCandidate(candidate: UnifiedDataStore): void {
  if (generationCandidate?.store === candidate) generationCandidate = undefined;
  candidate.close();
}

async function buildProjectImportGeneration(input: { candidateDir: string; source: string; targetRoot: string; idempotencyKey: string }): Promise<Record<string, unknown>> {
  const candidateDir = verifiedGenerationDirectory(input.candidateDir);
  if (generationBuilds.has(candidateDir)) throw new Error('database_generation_build_active');
  const build = { cancelled: false };
  generationBuilds.set(candidateDir, build);
  const assertCurrent = (): void => { if (build.cancelled) throw new Error('database_generation_interrupted'); };
  const hiddenRoot = path.join(candidateDir, 'project-files');
  let candidate: UnifiedDataStore | undefined;
  try {
    candidate = UnifiedDataStore.open(candidateDir, configuration.databaseId);
    const candidateStat = fs.lstatSync(candidateDir, { bigint: true });
    const importAuthority = bindCandidateImportAuthority({ sourceRoot: configuration.root!, candidateRoot: candidateDir, databaseId: candidate.databaseId,
      directoryDevice: String(candidateStat.dev), directoryInode: String(candidateStat.ino) });
    const sourceHash = candidate.prepareProjectImport(input.source).sourceHash;
    const imported = await candidate.importProject({ source: input.source, root: hiddenRoot, idempotencyKey: input.idempotencyKey }, assertCurrent,Boolean(configuration.generation),configuration.root,importAuthority);
    assertCurrent();
    const result = candidate.retargetPreparedProjectImport({ ...imported, hiddenRoot, targetRoot: input.targetRoot, sourceHash, idempotencyKey: input.idempotencyKey });
    const importOrder = {projectId:imported.projectId,sourceHash,requestKey:`project-import:${input.idempotencyKey}`};
    if (configuration.generation) candidate.prepareDatabaseGenerationForeignKeyIndexes();
    if (configuration.generation) candidate.prepareDatabaseGenerationOrderingFloors(importOrder);
    const verified = candidate.verifyDatabaseGeneration();
    assertCandidateImportAuthority(importAuthority, candidateDir, candidate.databaseId, configuration.root);
    if (configuration.generation) retainGenerationCandidate(candidate,importOrder);
    return { ...result, hiddenIdentityPath: path.join(hiddenRoot, '.solopreneur', 'project.json'), hiddenRoadmapPath: path.join(hiddenRoot, '.solopreneur', 'roadmap.csv'), ...verified };
  } finally { if (candidate && generationCandidate?.store !== candidate) candidate.close(); generationBuilds.delete(candidateDir); }
}

function applyProjectImportGenerationChangeset(input: { candidateDir: string; changesetFile: string; searchObjectIds: string[]; previousLiveSequence: number; currentLiveSequence: number }): void {
  const candidateDir = verifiedGenerationDirectory(input.candidateDir);
  const changesetFile = path.resolve(input.changesetFile);
  if (path.dirname(changesetFile) !== path.join(candidateDir, 'changesets') || !/^\d{12}\.changeset$/.test(path.basename(changesetFile))) throw new Error('database_generation_changeset_path_invalid');
  const candidate = currentGenerationCandidate(candidateDir);
  try { candidate.applyDatabaseGenerationChangeset(fs.readFileSync(changesetFile), input.searchObjectIds, input.previousLiveSequence, input.currentLiveSequence); }
  finally { if (!configuration.generation) candidate.close(); }
}

port.on('message', async (message: { id?: number; operation?: string; input?: ContentPublicationInput; file?: string; value?: unknown; source?: string; root?: string; tables?: string[]; destinationRoot?: string; destination?: string; databaseId?: string; sha256?: string; expectedHash?: string; bytes?: number; limit?: number; contentId?: string; outboxId?: string; itemId?: string; sourcePath?: string; receiptPath?: string; heldPath?: string; sourceDevice?: number; sourceInode?: number; symbolicLink?: boolean; alreadyRestored?: boolean; ref?: string; revision?: number; format?: 'json' | 'md' | 'text'; agentProjection?: boolean; candidateDir?: string; targetRoot?: string; idempotencyKey?: string; changesetFile?: string; searchObjectIds?: string[]; previousLiveSequence?: number; currentLiveSequence?: number; stageDirectory?: string; stageId?: string; ownerId?: string; section?: string; offset?: number; projectId?: string; manifest?: DocumentationManifest; projectPath?: string; globalOnly?: boolean; extensionPath?: string; gitHead?: string; roadmapNodes?: RoadmapNode[]; runEntries?: RunIndexEntry[]; options?: Omit<ProjectGrowthScanOptions, 'now'> & { now?: string }; auditOptions?: DocumentationAuditOptions; close?: boolean }) => {
  if (message.close) {
    if(learningReviewPreparation){const context=learningReviewPreparation;context.closing=true;try{await context.flight;}catch{/* Release the failed preparation as well. */}await context.iterator.return(undefined as never);learningReviewPreparation=undefined;}
    if (generationCandidate) closeGenerationCandidate(generationCandidate.store);
    readStore?.close();
    verificationReadStore?.store.close();
    learningReviewCaptureStore=undefined;
    port.postMessage({ closed: true });
    port.close();
    return;
  }
  const id = Number(message.id);
  try {
    if (configuration.generation) {
      verifiedGenerationDirectory(String(message.candidateDir || ''));
      if (!['inspect_project_import', 'build_project_import_generation', 'apply_project_import_generation_changeset', 'verify_project_import_generation', 'build_compact_database_generation', 'finalize_compact_database_generation', 'cancel_database_generation'].includes(String(message.operation))) throw new Error('database_generation_operation_invalid');
    }
    if (message.operation === 'cancel_database_generation') {
      const build = generationBuilds.get(verifiedGenerationDirectory(String(message.candidateDir || '')));
      if (build) build.cancelled = true;
      port.postMessage({ id, result: null });
      return;
    }
    if (message.operation === 'prepare_content_publication') {
      if (!message.input) throw new Error('content_preparation_input_required');
      port.postMessage({ id, result: prepareContentPublication(message.input) });
      return;
    }
    if (message.operation === 'run_input_file') {
      port.postMessage({id,result:computeRunInputFile(maintenanceReadStore(),message.value as RunInputFileRequest)});
      return;
    }
    if(message.operation==='verify_content_publication'){
      const request=message.value as ContentVerificationRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).verifyContentForPublication(request)});
      return;
    }
    if(message.operation==='prepare_flow_trace_publication'){
      const request=message.value as FlowTracePreparationRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareFlowTracePublication(request)});return;
    }
    if(message.operation==='plan_flow_trace_publication'){
      const request=message.value as FlowTracePlanRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).planFlowTracePublication(request)});return;
    }
    if(message.operation==='prepare_agent_launch_artifacts'){
      const request=message.value as AgentLaunchArtifactsRequest;
      port.postMessage({id,result:await contentVerificationReadStore(request).prepareAgentLaunchArtifacts(request)});return;
    }
    if(message.operation==='select_agent_launch'){
      const request=message.value as AgentLaunchSelectionRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).selectAgentLaunch(request)});return;
    }
    if(message.operation==='prepare_agent_launch_step'){
      const request=message.value as AgentLaunchStepRequest;
      port.postMessage({id,result:await contentVerificationReadStore(request).prepareAgentLaunchStep(request)});return;
    }
    if(message.operation==='prepare_run_native_rows'){
      const request=message.value as RunNativeRowsRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunNativeRows(request)});return;
    }
    if(message.operation==='release_run_native_rows'){
      const request=message.value as RunNativeRowsReleaseRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).releaseRunNativeRows(request)});return;
    }
    if(message.operation==='prepare_run_observer_document'){
      const request=message.value as RunObserverDocumentRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunObserverDocument(request)});return;
    }
    if(message.operation==='prepare_run_document_value'){
      const request=message.value as RunDocumentValueRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunDocumentValue(request)});return;
    }
    if(message.operation==='prepare_run_context'){
      const request=message.value as RunContextRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunContext(request)});return;
    }
    if(message.operation==='prepare_current_run_checkpoint'){
      const request=message.value as CurrentRunCheckpointRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareCurrentRunCheckpoint(request)});return;
    }
    if(message.operation==='prepare_run_task_ingress'){
      const request=message.value as RunTaskIngressRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunTaskIngress(request)});return;
    }
    if(message.operation==='inspect_run_checkpoint'){
      const request=message.value as RunCheckpointInspectionRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).inspectRunCheckpoint(request)});return;
    }
    if(message.operation==='prepare_run_checkpoint'){
      const request=message.value as RunCheckpointRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunCheckpoint(request)});return;
    }
    if(message.operation==='inspect_run_output'){
      const request=message.value as RunOutputInspectionRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).inspectRunOutput(request)});return;
    }
    if(message.operation==='prepare_diagnostic_event'){
      port.postMessage({id,result:prepareDiagnosticEvent(message.value as DiagnosticEventInput)});return;
    }
    if(message.operation==='prepare_global_prompt_save'){
      const request=message.value as GlobalPromptSaveRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareGlobalPromptSave(request)});return;
    }
    if(message.operation==='begin_learning_review_source_capture'){
      const request=message.value as LearningReviewSourceCaptureRequest;
      if(!learningReviewCaptureStore)learningReviewCaptureStore=maintenanceReadStore();
      port.postMessage({id,result:learningReviewCaptureStore.beginLearningReviewSourceCapture(request)});return;
    }
    if(message.operation==='prepare_learning_review_entry'){
      const request=message.value as LearningReviewPrepareEntryRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareLearningReviewEntry(request)});return;
    }
    if(message.operation==='project_learning_review_preparation_result'){
      const request=message.value as import('./db/learningReviewPreparePublication.js').LearningReviewPreparationResultRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).projectLearningReviewPreparationResult(request)});return;
    }
    if(message.operation==='begin_learning_review_preparation'){
      const request=message.value as LearningReviewPreparationRequest;
      if(!/^[a-f0-9-]{36}$/i.test(request.preparationId))throw new Error('learning_review_prepare_invalid');
      contentVerificationReadStore(request);
      if(learningReviewPreparation){
        if(learningReviewPreparation.closing || learningReviewPreparation.request.preparationId!==request.preparationId)throw new Error('learning_review_prepare_busy');
        if(JSON.stringify(learningReviewPreparation.request)!==JSON.stringify(request))throw new Error('learning_review_prepare_phase_changed');
        port.postMessage({id,result:learningReviewPreparation.state || await learningReviewPreparation.flight});return;
      }
      const context:LearningReviewPreparationContext={request,phase:0,iterator:contentVerificationReadStore(request).planLearningReviewPreparation(request,()=>learningReviewCaptureStore)};
      learningReviewPreparation=context;
      context.flight=context.iterator.next().then(next=>context.state=next.done?{preparationId:request.preparationId,phase:0,done:true,result:next.value}:{preparationId:request.preparationId,phase:0,done:false,value:next.value});
      try{port.postMessage({id,result:await context.flight});}catch(error){if(learningReviewPreparation===context)learningReviewPreparation=undefined;await context.iterator.return(undefined as never);throw error;}finally{context.flight=undefined;}return;
    }
    if(message.operation==='advance_learning_review_preparation'){
      const request=message.value as LearningReviewPreparationAdvance,context=learningReviewPreparation;
      if(!context || context.request.preparationId!==request.preparationId)throw new Error('learning_review_prepare_missing');
      contentVerificationReadStore(request);
      if(context.closing || context.flight || context.state?.done || context.phase!==request.phase || !request.acknowledgement)throw new Error('learning_review_prepare_phase_changed');
      context.phase++;context.flight=context.iterator.next(request.acknowledgement).then(next=>context.state=next.done?{preparationId:request.preparationId,phase:context.phase,done:true,result:next.value}:{preparationId:request.preparationId,phase:context.phase,done:false,value:next.value});
      try{port.postMessage({id,result:await context.flight});}finally{context.flight=undefined;}return;
    }
    if(message.operation==='release_learning_review_preparation'){
      const request=message.value as LearningReviewPreparationRelease,context=learningReviewPreparation;
      if(!context){port.postMessage({id,result:{released:false}});return;}
      if(context.request.preparationId!==request.preparationId || ['databaseId','sourceDevice','sourceInode'].some(key=>context.request[key as keyof LearningReviewPreparationRelease]!==request[key as keyof LearningReviewPreparationRelease]))throw new Error('learning_review_prepare_phase_changed');
      context.closing=true;try{try{await context.flight;}catch{/* Finish the actual failed context before releasing it. */}await context.iterator.return(undefined as never);}finally{if(learningReviewPreparation===context)learningReviewPreparation=undefined;}
      port.postMessage({id,result:{released:true}});return;
    }
    if(message.operation==='capture_learning_review_source_page'){
      if(!learningReviewCaptureStore)throw new Error('learning_review_capture_missing');
      port.postMessage({id,result:learningReviewCaptureStore.captureLearningReviewSourcePage(message.value as LearningReviewSourceCapturePage)});return;
    }
    if(message.operation==='peek_learning_review_source_capture'){
      if(!learningReviewCaptureStore)throw new Error('learning_review_capture_missing');
      port.postMessage({id,result:learningReviewCaptureStore.peekLearningReviewSourceCapture(message.value as LearningReviewSourceCaptureRowRequest)});return;
    }
    if(message.operation==='consume_learning_review_source_capture'){
      if(!learningReviewCaptureStore)throw new Error('learning_review_capture_missing');
      port.postMessage({id,result:learningReviewCaptureStore.consumeLearningReviewSourceCapture(message.value as LearningReviewSourceCaptureRowRequest)});return;
    }
    if(message.operation==='release_learning_review_source_capture'){
      const result=learningReviewCaptureStore?.releaseLearningReviewSourceCapture(message.value as LearningReviewSourceCapturePage) || {released:false};
      learningReviewCaptureStore=undefined;port.postMessage({id,result});return;
    }
    if(message.operation==='prepare_global_prompt_overrides'){
      const request=message.value as GlobalPromptOverridesRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareGlobalPromptOverrides(request)});return;
    }
    if(message.operation==='prepare_global_prompt_supersede'){
      const request=message.value as GlobalPromptSupersedeRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareGlobalPromptSupersede(request)});return;
    }
    if(message.operation==='prepare_external_memory_mutation'){
      const request=message.value as ExternalMemoryRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareExternalMemoryMutation(request)});return;
    }
    if(message.operation==='prepare_learning_cycle'){
      const request=message.value as LearningCycleRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareLearningCycle(request)});return;
    }
    if(message.operation==='prepare_learning_review_apply'){
      const request=message.value as LearningReviewApplyRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareLearningReviewApply(request)});return;
    }
    if(message.operation==='qualify_learning_review_apply'){
      const request=message.value as LearningReviewApplyQualificationRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).qualifyLearningReviewApply(request)});return;
    }
    if(message.operation==='prepare_learning_review_apply_recovery'){
      const request=message.value as LearningReviewApplyRecoveryRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareLearningReviewApplyRecovery(request)});return;
    }
    if(message.operation==='project_learning_review_apply_result'){
      const request=message.value as LearningReviewApplyResultRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).projectLearningReviewApplyResult(request)});return;
    }
    if(message.operation==='prepare_learning_review_interrupt'){
      const request=message.value as LearningReviewInterruptRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareLearningReviewInterrupt(request)});return;
    }
    if(message.operation==='prepare_learning_review_finish'){
      const request=message.value as LearningReviewFinishRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareLearningReviewFinish(request)});return;
    }
    if(message.operation==='prepare_run_verification'){
      const request=message.value as RunVerificationRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunVerification(request)});return;
    }
    if(message.operation==='prepare_run_consumer_claim'){
      const request=message.value as RunConsumerClaimRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunConsumerClaim(request)});return;
    }
    if(message.operation==='prepare_run_settlement'){
      const request=message.value as RunSettlementRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunSettlement(request)});return;
    }
    if(message.operation==='prepare_run_settlement_payload'){
      const request=message.value as RunSettlementPayloadRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunSettlementPayload(request)});return;
    }
    if(message.operation==='prepare_run_settlement_digest'){
      const request=message.value as RunSettlementDigestRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunSettlementDigest(request)});return;
    }
    if(message.operation==='prepare_run_settlement_documentation'){
      const request=message.value as RunSettlementDocumentationRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunSettlementDocumentation(request)});return;
    }
    if(message.operation==='prepare_run_settlement_learning'){
      const request=message.value as RunSettlementLearningRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunSettlementLearning(request)});return;
    }
    if(message.operation==='prepare_state_write'){
      const request=message.value as StateWriteRequest;
      port.postMessage({id,result:stateWriteSelectionForTransfer(contentVerificationReadStore(request).prepareStateWrite(request))});return;
    }
    if(message.operation==='capture_growth_stage'){
      const input=message.value as GrowthStageCaptureRequest;
      try{
      if(input.operation==='encode'){
        const result:GrowthStageInputEncoding={encodedItems:[]};
        input.values.forEach((value,index)=>{if(result.failure)return;try{result.encodedItems.push({index,json:canonicalJson(value)});}catch(error){const actual=error instanceof Error?error:new Error(String(error));result.failure={index,message:actual.message,name:actual.name,...('code' in actual && typeof actual.code==='string'?{code:actual.code}:{})};}});
        port.postMessage({id,result});return;
      }
      if(input.operation==='begin'){
        if(growthStageCaptures.has(input.token))throw new Error('growth_refresh_stage_capture_exists');
        growthStageCaptures.set(input.token,new GrowthStageCapture(input.stageId,input.staged));port.postMessage({id,result:undefined});return;
      }
      const capture=growthStageCaptures.get(input.token);
      if(input.operation==='release'){capture?.close();growthStageCaptures.delete(input.token);port.postMessage({id,result:undefined});return;}
      if(!capture)throw new Error('growth_refresh_stage_capture_missing');
      if(input.operation==='page'){capture.append(input.section,input.rows);port.postMessage({id,result:undefined});return;}
      if(input.operation==='prepare'){const request={...input.request,manifest:capture.validate()};port.postMessage({id,result:contentVerificationReadStore(request).prepareGrowthStage(request)});return;}
      throw new Error('growth_refresh_stage_capture_invalid');
      }catch(error){const actual=error instanceof Error?error:new Error(String(error));port.postMessage({id,result:{captureFailure:{message:actual.message,name:actual.name,...('code' in actual && typeof actual.code==='string'?{code:actual.code}:{})}}});return;}
    }
    if(message.operation==='prepare_import_object'){
      const request=message.value as ImportObjectRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareImportObject(request)});return;
    }
    if(message.operation==='prepare_archive_source'){
      const request=message.value as ArchiveSourceRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareArchiveSource(request)});return;
    }
    if(message.operation==='prepare_direct_growth'){
      const request=message.value as DirectGrowthRequest;
      port.postMessage({id,result:await contentVerificationReadStore(request).prepareDirectGrowthFromSource(request)});return;
    }
    if(message.operation==='prepare_legacy_review_batch'){
      const request=restoreLegacyReviewRequest(message.value);
      port.postMessage({id,result:legacyReviewResultForTransfer(contentVerificationReadStore(request).prepareLegacyReviewBatch(request))});return;
    }
    if(message.operation==='prepare_registered_report_task'){
      const request=message.value as RegisteredReportTaskRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRegisteredReportTask(request)});return;
    }
    if(message.operation==='prepare_registered_report'){
      const request=message.value as RegisteredReportRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRegisteredReport(request)});return;
    }
    if(message.operation==='prepare_historical_run_adoption_input'){
      const request=message.value as HistoricalRunInputPreparationRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareHistoricalRunAdoptionInput(request)});return;
    }
    if(message.operation==='prepare_historical_run_root_document'){
      const request=message.value as HistoricalRunRootDocumentRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareHistoricalRunRootDocument(request)});return;
    }
    if(message.operation==='prepare_historical_run_root_final_metadata'){
      const request=message.value as HistoricalRunRootFinalMetadataRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareHistoricalRunRootFinalMetadata(request)});return;
    }
    if(message.operation==='project_historical_run_root'){
      const request=message.value as HistoricalRunRootProjectionRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).projectHistoricalRunRoot(request)});return;
    }
    if(message.operation==='prepare_historical_run_root_node'){
      const request=message.value as HistoricalRunRootNodeRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareHistoricalRunRootNode(request)});return;
    }
    if(message.operation==='prepare_historical_run_root_metadata'){
      const request=message.value as HistoricalRunRootMetadataRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareHistoricalRunRootMetadata(request)});return;
    }
    if(message.operation==='plan_historical_run_root_body'){
      const request=message.value as HistoricalRunRootBodyRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).planHistoricalRunRootBody(request)});return;
    }
    if(message.operation==='prepare_historical_run_root_turn'){
      const request=message.value as HistoricalRunRootTurnRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareHistoricalRunRootTurn(request)});return;
    }
    if(message.operation==='prepare_historical_run_existing'){
      const request=message.value as HistoricalRunExistingRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareHistoricalRunExisting(request)});return;
    }
    if(message.operation==='prepare_historical_run_root_selection'){
      const request=message.value as HistoricalRunRootSelectionRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareHistoricalRunRootSelection(request)});return;
    }
    if(message.operation==='prepare_historical_run_sources'){
      const request=message.value as HistoricalRunSourcesRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareHistoricalRunSources(request)});return;
    }
    if(message.operation==='prepare_historical_run_task'){
      const request=message.value as HistoricalRunTaskRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareHistoricalRunTask(request)});return;
    }
    if(message.operation==='prepare_historical_run_identity'){
      const request=message.value as HistoricalRunIdentityRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareHistoricalRunIdentity(request)});return;
    }
    if(message.operation==='prepare_lesson_source'){
      const request=message.value as LessonSourceRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareLessonSource(request)});return;
    }
    if(message.operation==='prepare_learning_decision_source'){
      const request=message.value as LearningDecisionSourceRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareLearningDecisionSource(request)});return;
    }
    if(message.operation==='prepare_learning_event_source'){
      const request=message.value as LearningEventSourceRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareLearningEventSource(request)});return;
    }
    if(message.operation==='prepare_legacy_review_cursor'){
      const request=message.value as LegacyReviewCursorRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareLegacyReviewCursor(request)});return;
    }
    if(message.operation==='prepare_step_memory_import'){
      const request=message.value as StepMemoryImportRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareStepMemoryImport(request)});return;
    }
    if(message.operation==='plan_step_memory_import_source'){
      const request=message.value as StepMemoryImportSourcePlanRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).planStepMemoryImportSource(request)});return;
    }
    if(message.operation==='prepare_step_memory'){
      const request=message.value as StepMemoryRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareStepMemory(request)});return;
    }
    if(message.operation==='prepare_step_memory_body'){
      const request=message.value as StepMemoryBodyRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareStepMemoryBody(request)});return;
    }
    if(message.operation==='plan_step_memory'){
      const request=message.value as StepMemoryPlanRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).planStepMemory(request)});return;
    }
    if(message.operation==='project_step_memory_result'){
      const request=message.value as StepMemoryResultRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).projectStepMemoryResult(request)});return;
    }
    if(message.operation==='prepare_run_settlement_step'){
      const request=message.value as RunSettlementStepRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunSettlementStep(request)});return;
    }
    if(message.operation==='plan_run_settlement_step'){
      const request=message.value as RunSettlementStepPlanRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).planRunSettlementStep(request)});return;
    }
    if(message.operation==='prepare_run_settlement_journals'){
      const request=message.value as RunSettlementJournalsRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunSettlementJournals(request)});return;
    }
    if(message.operation==='prepare_run_settlement_tail'){
      const request=message.value as RunSettlementTailRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunSettlementTail(request)});return;
    }
    if(message.operation==='prepare_run_settlement_notification'){
      const request=message.value as RunSettlementNotificationRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunSettlementNotification(request)});return;
    }
    if(message.operation==='prepare_run_output'){
      const request=message.value as RunOutputRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunOutput(request)});return;
    }
    if(message.operation==='plan_run_output'){
      const request=message.value as RunOutputPlanRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).planRunOutput(request)});return;
    }
    if(message.operation==='plan_run_checkpoint'){
      const request=message.value as RunCheckpointPlanRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).planRunCheckpoint(request)});return;
    }
    if(message.operation==='prepare_run_document'){
      const request=message.value as RunDocumentRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunDocument(request)});return;
    }
    if(message.operation==='plan_run_document'){
      const request=message.value as RunDocumentPlanRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).planRunDocument(request)});return;
    }
    if(message.operation==='prepare_run_report'){
      const request=message.value as RunReportRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunReport(request)});return;
    }
    if(message.operation==='prepare_run_log'){
      const request=message.value as RunLogPreparationRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunLog(request)});return;
    }
    if(message.operation==='project_run_report_result'){
      const request=message.value as RunReportResultRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).projectRunReportResult(request)});return;
    }
    if(message.operation==='prepare_run_delivery_start'){
      const request=message.value as RunDeliveryStartPreparationRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunDeliveryStart(request)});return;
    }
    if(message.operation==='prepare_run_control'){
      const request=message.value as RunControlPreparationRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunControl(request)});return;
    }
    if(message.operation==='select_flow_role'){
      const request=message.value as FlowRoleSelectionRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).selectFlowRole(request)});return;
    }
    if(message.operation==='select_run_allocation'){
      const request=message.value as RunAllocationRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).selectRunAllocation(request)});return;
    }
    if(message.operation==='prepare_run_creation'){
      const request=message.value as RunCreationRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunCreation(request)});return;
    }
    if(message.operation==='plan_run_creation'){
      const request=message.value as RunCreationPlanRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).planRunCreation(request)});return;
    }
    if(message.operation==='prepare_run_inputs'){
      const request=message.value as RunInputsPreparationRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunInputs(request)});return;
    }
    if(message.operation==='plan_run_inputs'){
      const request=message.value as RunInputsPlanRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).planRunInputs(request)});return;
    }
    if(message.operation==='project_run_inputs_result'){
      const request=message.value as RunInputsResultRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).projectRunInputsResult(request)});return;
    }
    if(message.operation==='prepare_data_write'){
      const request=message.value as DataWritePreparationRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareDataWrite(request)});return;
    }
    if(message.operation==='prepare_link'){
      const request=message.value as LinkPreparationRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareLink(request)});return;
    }
    if(message.operation==='prepare_mcp_mutation_authorization'){
      const request=message.value as McpMutationAuthorizationRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareMcpMutationAuthorization(request)});return;
    }
    if(message.operation==='prepare_run_native'){
      const request=message.value as RunNativeRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunNative(request)});return;
    }
    if(message.operation==='prepare_run_turn_request'){
      const request=message.value as RunTurnRequestPreparation;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareRunTurnRequest(request)});return;
    }
    if(message.operation==='qualify_run_turn_request'){
      const request=message.value as RunTurnRequestQualification;
      port.postMessage({id,result:contentVerificationReadStore(request).qualifyRunTurnRequest(request)});return;
    }
    if(message.operation==='prepare_data_write_search'){
      const request=message.value as DataWriteSearchRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareDataWriteSearch(request)});return;
    }
    if(message.operation==='prepare_data_write_references'){
      const request=message.value as DataWriteReferenceDiscoveryRequest;
      port.postMessage({id,result:contentVerificationReadStore(request).prepareDataWriteReferences(request)});return;
    }
    if (message.operation === 'prepare_storage_reference_batch') {
      port.postMessage({ id, result: maintenanceReadStore().prepareStorageReferenceBatch(Number(message.limit || 128)) });
      return;
    }
    if (message.operation === 'prepare_project_retirement_page') {
      const request=message.value as ProjectRetirementPageRequest;
      port.postMessage({ id, result: contentVerificationReadStore(request).prepareProjectRetirementPage(request) }); return;
    }
    if (message.operation === 'qualify_project_retirement') {
      const request=message.value as ProjectRetirementQualificationRequest;
      port.postMessage({ id, result: contentVerificationReadStore(request).qualifyProjectRetirement(request) }); return;
    }
    if (message.operation === 'prepare_storage_run_output_batch') {
      port.postMessage({ id, result: maintenanceReadStore().prepareStorageRunOutputBatch(Number(message.limit || 64)) });
      return;
    }
    if (message.operation === 'prepare_storage_repair_batch') {
      port.postMessage({ id, result: maintenanceReadStore().prepareStorageRepairBatch(message.searchObjectIds || []) });
      return;
    }
    if (message.operation === 'prepare_storage_gc_batch') {
      port.postMessage({ id, result: maintenanceReadStore().prepareStorageGcBatch(Number(message.limit || 128)) });
      return;
    }
    if (message.operation === 'prepare_storage_cold_batch') {
      port.postMessage({ id, result: maintenanceReadStore().prepareStorageColdBatch(Number(message.limit || 64)) });
      return;
    }
    if (message.operation === 'prepare_schedule_sync') {
      const value=message.value as ScheduleSyncPreparation;
      port.postMessage({id,result:contentVerificationReadStore(value).prepareScheduleSync(value)});
      return;
    }
    if (message.operation === 'prepare_host_settings') {
      const value=message.value as HostSettingsPreparation;
      port.postMessage({id,result:contentVerificationReadStore(value).prepareHostSettings(value)});
      return;
    }
    if (message.operation === 'project_host_settings') {
      const value=message.value as HostSettingsProjection;
      port.postMessage({id,result:contentVerificationReadStore(value).projectHostSettings(value)});
      return;
    }
    if (message.operation === 'inspect_project_migration_source') {
      const value = message.value as ProjectMigrationInspection;
      let readStore: UnifiedDataStore | undefined;
      switch (value.kind) {
        case 'runDigestPublication':
        case 'runIndexBackfillCandidates':
        case 'runIndexBackfill':
        case 'historicalRunIndex':
        case 'formalRunIndex':
        case 'linkedJournal':
        case 'capturedMigrationSource':
        case 'capturedLegacyReviewJson':
        case 'migrationSourceJsonVersion':
        case 'legacyProjectJournalPublication':
        case 'piTimeSchedule':
        case 'scheduleClaimCandidates':
        case 'scheduleClaims':
        case 'scheduleSettlement':
        case 'hostSecretMigration':
        case 'legacyTelegramStartup':
        case 'registrySnapshot':
        case 'firstRegistrationMetadata':
        case 'legacyGrowthProjectionPublication':
        case 'registryMetadataTargets':
        case 'registryMetadataDraft':
        case 'registryPatchReplay':
        case 'projectAutonomy':
        case 'registryMove':
        case 'lateRegistryMatch': readStore = contentVerificationReadStore(value.value); break;
        case 'archivedArtifact':
        case 'appendedOutput': readStore = maintenanceReadStore(); break;
      }
      let result;
      try {
        result = readStore ? await readStore.inspectProjectMigration(value)
          : await inspectProjectMigration(value, () => { throw new Error('maintenance_database_identity_missing'); });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        port.postMessage({ id, result: { failure: { message: failure.message, code: (failure as NodeJS.ErrnoException).code } } });
        return;
      }
      if(value.kind==='legacyReviewJson' || value.kind==='capturedLegacyReviewJson'){
        const valueTransfer=dataValueTransferIfDeep(result);
        if(valueTransfer){port.postMessage({id,result:{valueTransfer}});return;}
      }
      const bytes = result && typeof result === 'object' && result.bytes;
      const transfer = bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer
        && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? [bytes.buffer] : [];
      port.postMessage({ id, result: { value: result } }, transfer);
      return;
    }
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
      const ownerId = String(message.ownerId || '');
      if (!/^[a-f0-9-]{36}$/.test(ownerId) || !readStore.hasProjectExportStageOwner(ownerId)) throw new Error('prepared_content_owner_required');
      const prepared = await readStore.prepareProjectExport(String(message.root || ''));
      const directory = path.join(configuration.root, '.solomap-maintenance-staging');
      const createdStagingRoot = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (createdStagingRoot) syncProjectExportStageDirectory(fs.realpathSync(configuration.root));
      const stageDirectory = path.join(directory, `project-export-${ownerId}`);
      fs.mkdirSync(stageDirectory, { mode: 0o700 });
      syncProjectExportStageDirectory(directory);
      const ownerDescriptor = fs.openSync(path.join(stageDirectory, 'owner.json'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      try { fs.writeFileSync(ownerDescriptor, projectExportStageOwnerBytes(configuration.databaseId, ownerId)); fs.fsyncSync(ownerDescriptor); } finally { fs.closeSync(ownerDescriptor); }
      syncProjectExportStageDirectory(stageDirectory);

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
    if (message.operation === 'cleanup_project_export_stage') {
      const stageDirectory = path.resolve(String(message.stageDirectory || ''));
      const ownerId = /^project-export-([a-f0-9-]{36})$/.exec(path.basename(stageDirectory))?.[1];
      if (!ownerId || !maintenanceReadStore().hasProjectExportStageOwner(ownerId)) throw new Error('prepared_content_owner_required');
      port.postMessage({ id, result: cleanupProjectExportStageBatch(String(configuration.root || ''), String(configuration.databaseId || ''), stageDirectory, Number(message.limit ?? 128)) });
      return;
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
    if (message.operation === 'build_compact_database_generation') {
      const candidateDir = verifiedGenerationDirectory(String(message.candidateDir || ''));
      const identity = message.value as { device: string; inode: string };
      const result = createCompactDatabaseCandidate({ candidateDir, databaseId: String(configuration.databaseId || ''), ...identity });
      if (configuration.generation) {
        const candidate = UnifiedDataStore.open(candidateDir, configuration.databaseId);
        try { candidate.prepareDatabaseGenerationForeignKeyIndexes(); candidate.prepareDatabaseGenerationOrderingFloors(); candidate.verifyDatabaseGeneration(); retainGenerationCandidate(candidate); }
        catch (error) { candidate.close(); throw error; }
      }
      port.postMessage({ id, result });
      return;
    }
    if (message.operation === 'finalize_compact_database_generation') {
      const directory = verifiedGenerationDirectory(String(message.candidateDir || ''));
      const input = message.value as { idempotencyKey: string; beforeBytes: number; startedAt: number; device: string; inode: string };
      const identity = fs.lstatSync(directory, { bigint: true });
      if (!identity.isDirectory() || identity.isSymbolicLink() || String(identity.dev) !== input.device || String(identity.ino) !== input.inode) throw new Error('database_compact_directory_changed');
      const candidate = currentGenerationCandidate(directory);
      let result;
      try {
        if (configuration.generation) candidate.verifyDatabaseGenerationTail(); else candidate.verifyDatabaseGeneration();
        result = candidate.finalizeDatabaseCompaction(input);
        if (configuration.generation) candidate.verifyDatabaseGenerationTail();
      } finally { closeGenerationCandidate(candidate); }
      if (fs.statSync(path.join(String(message.candidateDir), 'solomap.db')).size !== result.afterBytes) throw new Error('database_compact_measurement_changed');
      port.postMessage({ id, result });
      return;
    }
    if (message.operation === 'build_project_import_generation') {
      port.postMessage({ id, result: await buildProjectImportGeneration({ candidateDir: String(message.candidateDir || ''), source: String(message.source || ''), targetRoot: String(message.targetRoot || ''), idempotencyKey: String(message.idempotencyKey || '') }) });
      return;
    }
    if (message.operation === 'apply_project_import_generation_changeset') {
      applyProjectImportGenerationChangeset({ candidateDir: String(message.candidateDir || ''), changesetFile: String(message.changesetFile || ''), searchObjectIds: Array.isArray(message.searchObjectIds) ? message.searchObjectIds.map(String) : [], previousLiveSequence: Number(message.previousLiveSequence), currentLiveSequence: Number(message.currentLiveSequence) });
      port.postMessage({ id, result: null });
      return;
    }
    if (message.operation === 'verify_project_import_generation') {
      const candidate = currentGenerationCandidate(verifiedGenerationDirectory(String(message.candidateDir || '')));
      let result;
      try {
        if (configuration.generation) candidate.finalizeDatabaseGenerationProgress(true,generationCandidate?.importOrder,message.value as Record<string,number>);
        result = configuration.generation ? candidate.verifyDatabaseGenerationTail() : candidate.verifyDatabaseGeneration();
      } finally { closeGenerationCandidate(candidate); }
      port.postMessage({ id, result });
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
    port.postMessage({ id, error: error instanceof Error ? error.message : String(error), ...(typeof (error as NodeJS.ErrnoException)?.code === 'string' ? { errorCode: (error as NodeJS.ErrnoException).code } : {}) });
  }
});

if (configuration.generation) verifiedGenerationDirectory(configuration.generation.candidateDir);
port.postMessage({ ready: true, threadId });
