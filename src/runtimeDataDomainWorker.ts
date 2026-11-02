import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { parentPort, threadId, Worker, workerData } from 'worker_threads';

import { sendRuntimeDataRequest, type RuntimeDataRequest } from './autonomousRuntimeControl';
import { UnifiedDataStore } from './db/unifiedDataStore';
import { createRuntimeDataOperations, RuntimeDataOperations, RuntimeWorkspaceCompute } from './runtimeDataOperations';
import { runtimeOperationDefinition, RuntimeExecutorAffinity } from './runtimeOperationRegistry';
import { configureLocalDiagnosticPersistence, importLegacyLocalDiagnostics } from './localDiagnostics';
import { importLegacyRuntimeState } from './runtimeStateMigration';
import { IntelligenceRuntime, type IntelligenceCognitiveRunner } from './intelligenceRuntime';
import { RemoteIntelligencePersistence } from './intelligencePersistence';
import { reapFinishedLegacyRunProcesses } from './legacyRunProcessRecovery';
import type { RuntimeWriteActorConfiguration, RuntimeWriteActorControl } from './runtimeDataExecutionDomains';
import type { WorkspaceSnapshot } from './runWorkspace';
import { captureDatabaseGenerationProof, persistDatabaseGenerationCutover, reclaimDatabaseGeneration } from './databaseGeneration';
import { configureExternalSignalDataRequest } from './projectExternalSignals';
import type { GrowthSnapshotStageManifest, GrowthSnapshotStageSection } from './db/types';
import type { ProjectCoverageSnapshot } from './projectCoverage';
import type { DocumentationManifest } from './documentationManifest';
import type { CognitiveCliInvocation } from './localAgentCliEngine';
import type { ProjectRegistrySnapshot } from './projectRegistry';

interface DomainWorkerData {
  root: string;
  databaseId: string;
  affinity: Extract<RuntimeExecutorAffinity, 'writer-actor' | 'foreground-reader' | 'interactive-reader' | 'background-reader' | 'external-worker' | 'git-worker' | 'network-worker'>;
  runtime?: RuntimeWriteActorConfiguration;
  readAuthoritySecret?: string;
  externalRole?: 'intelligence' | 'conversation';
  recoverIntelligence?: boolean;
}

const port = parentPort;
if (!port) throw new Error('runtime_data_domain_parent_missing');
const configuration = workerData as DomainWorkerData;
const store = configuration.affinity === 'writer-actor'
  ? UnifiedDataStore.open(configuration.root, configuration.databaseId)
  : UnifiedDataStore.openReadOnly(configuration.root, configuration.databaseId);
if (store.databaseId !== configuration.databaseId) {
  store.close();
  throw new Error('database_identity_mismatch');
}
if (configuration.affinity === 'writer-actor') configureLocalDiagnosticPersistence({
  append: (_root, event) => { store.appendDiagnosticEvent(event); },
  read: async () => store.readDiagnosticEvents({ limit: 250 }) as unknown as { items: Record<string, unknown>[] }
}, configuration.root);
let closing = false;
const activityContext = new AsyncLocalStorage<number>();
let internalWriterSequence = 0;
const internalWriterPending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
function requestInternalWriter(request: RuntimeDataRequest): Promise<unknown> {
  if (closing) return Promise.reject(new Error('runtime_internal_writer_closing'));
  const internalRequestId = ++internalWriterSequence;
  return new Promise((resolve, reject) => {
    internalWriterPending.set(internalRequestId, { resolve, reject });
    try { port!.postMessage({ internalRequestId, internalParentId: activityContext.getStore(), internalRequest: request }); }
    catch (error) {
      internalWriterPending.delete(internalRequestId);
      reject(error);
    }
  });
}
if (configuration.affinity !== 'writer-actor') configureLocalDiagnosticPersistence({
  append: (_root, event) => requestInternalWriter({
    operation: 'append_diagnostic_event', input: event as unknown as Record<string, unknown>
  }).then(() => undefined),
  read: (_root) => requestInternalWriter({ operation: 'read_diagnostic_events', input: { limit: 250 } }) as Promise<{ items: Record<string, unknown>[] }>
});
async function requestInternalRuntime(request: RuntimeDataRequest): Promise<unknown> {
  if (configuration.affinity !== 'external-worker' || configuration.externalRole !== 'conversation'
    || request.operation !== 'start_conversation') return requestInternalWriter(request);
  const prepared = await requestInternalWriter({ ...request, operation: 'prepare_conversation_launch' }) as {
    phase?: string; ref?: string; dispatchToken?: string; args?: string[]; receipt?: unknown;
  };
  if (prepared.phase !== 'dispatch') return prepared;
  try {
    const result = await requestInternalWriter({ operation: 'execute_telegram_editor_command', input: {
      command: 'solopreneur.internalStartConversation', args: prepared.args || []
    } });
    if ((result as { status?: string })?.status !== 'started') throw new Error('conversation_not_started');
    return await requestInternalWriter({ operation: 'settle_conversation_launch', input: {
      ref: String(prepared.ref || ''), dispatchToken: String(prepared.dispatchToken || '')
    } });
  } catch (error) {
    await requestInternalWriter({ operation: 'settle_conversation_launch', input: {
      ref: String(prepared.ref || ''), dispatchToken: String(prepared.dispatchToken || ''),
      error: error instanceof Error ? error.message : String(error)
    } }).catch(() => undefined);
    throw error;
  }
}
let cognitiveInvocationSequence = 0;
const cognitiveInvocationPending = new Map<number, { resolve(value: string): void; reject(error: Error): void }>();
function createRemoteCognitiveRunner(): IntelligenceCognitiveRunner {
  const active = new Set<number>();
  return {
    runner: (invocation: CognitiveCliInvocation) => {
      if (closing) return Promise.reject(new Error('runtime_external_worker_closing'));
      const cognitiveInvocationId = ++cognitiveInvocationSequence;
      active.add(cognitiveInvocationId);
      return new Promise<string>((resolve, reject) => {
        cognitiveInvocationPending.set(cognitiveInvocationId, {
          resolve: value => { active.delete(cognitiveInvocationId); resolve(value); },
          reject: error => { active.delete(cognitiveInvocationId); reject(error); }
        });
        port!.postMessage({ cognitiveInvocationId, cognitiveInvocation: invocation });
      });
    },
    cancel: () => { for (const cognitiveCancelId of active) port!.postMessage({ cognitiveCancelId }); }
  };
}
if (configuration.affinity === 'network-worker') {
  configureExternalSignalDataRequest((_root, request) => requestInternalWriter(request));
}
let maintenanceComputeWorker: Worker | undefined;
let maintenanceComputeThreadId = 0;
let maintenanceComputeSequence = 0;
const maintenanceComputePending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
let maintenanceComputeReady: Promise<void> = Promise.resolve();
let maintenanceComputeRestartTimer: NodeJS.Timeout | undefined;
let gitComputeTail: Promise<void> = Promise.resolve();
let writerGenerationFenced = false;
let activeWriterOperations = 0;
const documentationManifestTails = new Map<string, Promise<void>>();
let writerExclusive = false;
let writerShared = 0;
const writerGateQueue: Array<{ exclusive: boolean; resolve(release: () => void): void }> = [];

function pumpWriterGate(): void {
  if (writerExclusive || !writerGateQueue.length) return;
  const first = writerGateQueue[0];
  if (first.exclusive) {
    if (writerShared) return;
    writerGateQueue.shift();
    writerExclusive = true;
    first.resolve(() => { writerExclusive = false; pumpWriterGate(); });
    return;
  }
  while (writerGateQueue.length && !writerGateQueue[0].exclusive && !writerExclusive) {
    const item = writerGateQueue.shift()!;
    writerShared += 1;
    item.resolve(() => { writerShared -= 1; pumpWriterGate(); });
  }
}

function acquireWriterGate(exclusive: boolean): Promise<() => void> {
  if (configuration.affinity !== 'writer-actor') return Promise.resolve(() => {});
  return new Promise(resolve => { writerGateQueue.push({ exclusive, resolve }); pumpWriterGate(); });
}

function publishActivity(phase: string): void {
  const id = activityContext.getStore();
  if (id !== undefined) port!.postMessage({ activity: { id, phase } });
}

async function serializeDocumentationManifest<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = documentationManifestTails.get(key) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  documentationManifestTails.set(key, tail);
  await previous.catch(() => undefined);
  try { return await operation(); }
  finally {
    release();
    if (documentationManifestTails.get(key) === tail) documentationManifestTails.delete(key);
  }
}

function serializeGitOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = gitComputeTail.then(operation, operation);
  gitComputeTail = result.then(() => undefined, () => undefined);
  return result;
}

async function runProjectImportGeneration(request: RuntimeDataRequest): Promise<unknown> {
  if (configuration.affinity !== 'writer-actor') throw new Error('database_generation_writer_required');
  const source = path.resolve(String(request.input.source || '')), targetRoot = path.resolve(String(request.input.root || ''));
  const idempotencyKey = String(request.input.idempotencyKey || '');
  if (!idempotencyKey.trim()) throw new Error('idempotency_key_required');
  const identity = await computeMaintenance<{ sourceHash: string; projectId: string }>('inspect_project_import', { source });
  const committed = store.readCommittedProjectImport({ sourceHash: identity.sourceHash, targetRoot, idempotencyKey });
  if (committed) return committed;
  const generationId = crypto.randomUUID(), candidateDir = path.join(configuration.root, 'database-generations', generationId);
  const changesetDir = path.join(candidateDir, 'changesets');
  fs.mkdirSync(changesetDir, { recursive: true, mode: 0o700 });
  store.beginDatabaseGenerationCapture();
  let sequence = 0, captureActive = true;
  let captureFailure: Error | undefined;
  const assertCaptureHealthy = (): void => { if (captureFailure) throw captureFailure; };
  const pending: Array<{ file: string; searchObjectIds: string[]; liveSequence: number }> = [];
  const persistCapture = (capture: { changeset: Uint8Array; searchObjectIds: string[] }): void => {
    if (!capture.changeset.byteLength && !capture.searchObjectIds.length) return;
    const file = path.join(changesetDir, `${String(++sequence).padStart(12, '0')}.changeset`);
    const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeFileSync(descriptor, capture.changeset); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    pending.push({ file, searchObjectIds: capture.searchObjectIds, liveSequence: store.readRuntimeWriterBarrier().committedSequence });
  };
  let rotating = false;
  const timer = setInterval(() => {
    if (rotating || !captureActive) return;
    rotating = true;
    try { persistCapture(store.rotateDatabaseGenerationCapture()); }
    catch (error) {
      captureFailure = error instanceof Error ? error : new Error(String(error));
      process.stderr.write(`SoloMap generation changeset capture: ${String(error)}\n`);
    }
    finally { rotating = false; }
  }, 50);
  timer.unref();
  try {
    const baseline = await computeMaintenance<{ committedSequence: number }>('backup_database_generation', { candidateDir });
    let appliedLiveSequence = Number(baseline.committedSequence);
    assertCaptureHealthy();
    const built = await computeMaintenance<Record<string, any>>('build_project_import_generation', { candidateDir, source, targetRoot, idempotencyKey });
    assertCaptureHealthy();
    clearInterval(timer);
    while (rotating) await new Promise<void>(resolve => setImmediate(resolve));
    assertCaptureHealthy();
    persistCapture(store.rotateDatabaseGenerationCapture());
    for (;;) {
      while (pending.length) {
        const item = pending.shift()!;
        const currentLiveSequence = Math.max(appliedLiveSequence, item.liveSequence);
        await computeMaintenance('apply_project_import_generation_changeset', { candidateDir, changesetFile: item.file, searchObjectIds: item.searchObjectIds, previousLiveSequence: appliedLiveSequence, currentLiveSequence });
        appliedLiveSequence = currentLiveSequence;
      }
      const next = store.rotateDatabaseGenerationCapture();
      if (!next.changeset.byteLength && !next.searchObjectIds.length) break;
      persistCapture(next);
    }
    writerGenerationFenced = true;
    while (activeWriterOperations > 1) await new Promise<void>(resolve => setImmediate(resolve));
    await operations.quiesceForDatabaseGeneration();
    if (projectionWorker) { const worker = projectionWorker; projectionWorker = undefined; await worker.terminate(); }
    const finalCapture = store.stopDatabaseGenerationCapture(); captureActive = false;
    persistCapture(finalCapture);
    while (pending.length) {
      const item = pending.shift()!;
      const currentLiveSequence = Math.max(appliedLiveSequence, item.liveSequence);
      await computeMaintenance('apply_project_import_generation_changeset', { candidateDir, changesetFile: item.file, searchObjectIds: item.searchObjectIds, previousLiveSequence: appliedLiveSequence, currentLiveSequence });
      appliedLiveSequence = currentLiveSequence;
    }
    await computeMaintenance('verify_project_import_generation', { candidateDir });
    persistDatabaseGenerationCutover(configuration.root, {
      schemaVersion: 1, state: 'ready', generationId, candidateDir, databaseId: configuration.databaseId,
      result: { projectId: String(built.projectId), locationId: String(built.locationId), identityPath: String(built.identityPath), roadmapPath: String(built.roadmapPath) },
      hiddenIdentityPath: String(built.hiddenIdentityPath), hiddenRoadmapPath: String(built.hiddenRoadmapPath), createdAt: Date.now(),
      candidateProof: captureDatabaseGenerationProof(path.join(candidateDir, 'solomap.db'))
    });
    setTimeout(() => process.exit(75), 25).unref();
    throw new Error('database_generation_cutover');
  } catch (error) {
    clearInterval(timer);
    if (captureActive) { try { store.stopDatabaseGenerationCapture(); } catch {} }
    if (!writerGenerationFenced && !fs.existsSync(path.join(configuration.root, 'database-generation-cutover.json'))) {
      try { reclaimDatabaseGeneration(configuration.root, generationId); }
      catch (cleanupError) { process.stderr.write(`SoloMap failed generation cleanup: ${String(cleanupError)}\n`); }
    }
    if (writerGenerationFenced) setTimeout(() => process.exit(76), 25).unref();
    throw error;
  }
}

function rejectMaintenanceComputePending(error: Error): void {
  for (const pending of maintenanceComputePending.values()) pending.reject(error);
  maintenanceComputePending.clear();
}

function startMaintenanceComputeWorker(): Promise<void> {
  if (configuration.affinity !== 'writer-actor' || closing) return Promise.resolve();
  if (maintenanceComputeWorker) return maintenanceComputeReady;
  maintenanceComputeReady = new Promise<void>((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'maintenanceComputeWorker.js'), { workerData: { root: configuration.root, databaseId: configuration.databaseId } });
    maintenanceComputeWorker = worker;
    worker.on('message', (message: { id?: number; ready?: boolean; threadId?: number; result?: unknown; error?: string }) => {
      if (message.ready) {
        maintenanceComputeThreadId = Number(message.threadId || 0);
        resolve();
        return;
      }
      const pending = maintenanceComputePending.get(Number(message.id));
      if (!pending) return;
      maintenanceComputePending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    worker.once('error', error => {
      reject(error);
      rejectMaintenanceComputePending(error);
    });
    worker.once('exit', code => {
      if (maintenanceComputeWorker !== worker) return;
      maintenanceComputeWorker = undefined;
      maintenanceComputeThreadId = 0;
      rejectMaintenanceComputePending(new Error(`maintenance_compute_exited:${code}`));
      if (closing) return;
      maintenanceComputeRestartTimer = setTimeout(() => {
        maintenanceComputeRestartTimer = undefined;
        void startMaintenanceComputeWorker().catch(error => {
          process.stderr.write(`SoloMap maintenance compute worker restart: ${String(error)}\n`);
        });
      }, 50);
      maintenanceComputeRestartTimer.unref();
    });
  });
  return maintenanceComputeReady;
}

const computeMaintenance = async <T>(operation: string, input: Record<string, unknown>): Promise<T> => {
  if (configuration.affinity !== 'writer-actor') throw new Error('maintenance_compute_writer_required');
  await startMaintenanceComputeWorker();
  const id = ++maintenanceComputeSequence;
  return new Promise<T>((resolve, reject) => {
    maintenanceComputePending.set(id, { resolve, reject });
    try { maintenanceComputeWorker!.postMessage({ id, operation, ...input }); }
    catch (error) {
      maintenanceComputePending.delete(id);
      reject(error);
    }
  });
};

async function runProjectGrowthRefresh(request: RuntimeDataRequest): Promise<unknown> {
  if (configuration.affinity !== 'writer-actor') throw new Error('project_growth_writer_required');
  const projectPath = path.resolve(String(request.input.root || ''));
  const extensionPath = path.resolve(String(request.input.extensionPath || ''));
  const requestId = String(request.input.requestId || '');
  if (!requestId.trim() || !extensionPath) throw new Error('growth_refresh_request_required');
  const project = await store.registerProject({ root: projectPath });
  const reservation = store.reserveProjectGrowthRefresh(project.projectId, requestId);
  const gitFacts = await requestInternalWriter({ operation: 'read_project_growth_git_facts', input: { root: projectPath } }) as {
    head: string; churn: Array<[string, number]>;
  };
  const manifest = await computeMaintenance<GrowthSnapshotStageManifest>('build_project_growth_stage', {
    projectPath,
    extensionPath,
    options: {
      scanReason: String(request.input.scanReason || 'manual_refresh'),
      ...(request.input.maxFiles === undefined ? {} : { maxFiles: Number(request.input.maxFiles) }),
      ...(request.input.now === undefined ? {} : { now: String(request.input.now) }),
      gitFacts
    }
  });
  store.beginProjectGrowthRefreshStage(project.projectId, { requestId, generation: reservation.generation, manifest });
  try {
    for (const section of ['nodes', 'edges', 'signals', 'labels'] as GrowthSnapshotStageSection[]) {
      let offset = 0;
      for (;;) {
        const page = await computeMaintenance<{ items: unknown[]; nextOffset: number | null }>('read_project_growth_stage_page', { stageId: manifest.stageId, section, offset });
        if (page.items.length) store.appendProjectGrowthRefreshStage(manifest.stageId, section, offset, page.items);
        if (page.nextOffset === null) break;
        if (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error('growth_refresh_stage_page_invalid');
        offset = page.nextOffset;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    return store.commitProjectGrowthRefreshStage(project.projectId, manifest.stageId);
  } finally {
    store.discardProjectGrowthRefreshStage(manifest.stageId);
    await computeMaintenance('cleanup_project_growth_stage', { stageId: manifest.stageId }).catch(() => undefined);
  }
}
const projectCoverageRuns = new Map<string, Promise<ProjectCoverageSnapshot>>();
function runProjectCoverageAnalysis(request: RuntimeDataRequest): Promise<ProjectCoverageSnapshot> {
  if (configuration.affinity !== 'writer-actor') return Promise.reject(new Error('project_coverage_writer_required'));
  const projectPath = path.resolve(String(request.input.root || ''));
  const extensionPath = path.resolve(String(request.input.extensionPath || ''));
  const key = `${projectPath}\0${extensionPath}`;
  const active = projectCoverageRuns.get(key);
  if (active) return active;
  const run = (async () => {
    const project = await store.registerProject({ root: projectPath });
    const gitFacts = await requestInternalWriter({ operation: 'read_project_growth_git_facts', input: { root: projectPath } }) as { head: string };
    const snapshot = await computeMaintenance<ProjectCoverageSnapshot>('compute_project_coverage', { projectPath, extensionPath, gitHead: gitFacts.head });
    const current = store.readAnalysisState(project.projectId, 'coverage', 'project-growth');
    store.writeAnalysisState(project.projectId, { namespace: 'coverage', key: 'project-growth', expectedRevision: current.revision,
      value: snapshot, idempotencyKey: `coverage:${crypto.randomUUID()}` });
    return snapshot;
  })().finally(() => projectCoverageRuns.delete(key));
  projectCoverageRuns.set(key, run);
  return run;
}
async function runRunIndexBackfill(request: RuntimeDataRequest): Promise<unknown> {
  if (configuration.affinity !== 'writer-actor') throw new Error('run_index_backfill_writer_required');
  const projectPath = path.resolve(String(request.input.root || ''));
  const project = await store.registerProject({ root: projectPath });
  let backfilledCount = 0;
  for (;;) {
    const prepared = await computeMaintenance<ReturnType<UnifiedDataStore['prepareRunIndexBackfill']>>('prepare_run_index_backfill', { projectPath, limit: 1 });
    if (!prepared.length) break;
    if (store.commitPreparedRunIndexBackfill(project.projectId, prepared[0])) backfilledCount += 1;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return { ...store.readRunIndexHealth(project.projectId), backfilledCount };
}

async function runDocumentationManifestSync(request: RuntimeDataRequest): Promise<DocumentationManifest> {
  if (configuration.affinity !== 'writer-actor') throw new Error('documentation_manifest_writer_required');
  const input = request.input as Record<string, unknown> & { manifest?: DocumentationManifest };
  const idempotencyKey = String(input.idempotencyKey || '');
  if (!idempotencyKey || !input.manifest) throw new Error('invalid_documentation_manifest');
  const project = input.projectId
    ? (() => {
        const projectId = String(input.projectId);
        if (store.readMetadata(projectId).kind !== 'project') throw new Error('project_scope_required');
        return { projectId };
      })()
    : await store.registerProject({ root: String(input.root || '') });
  return serializeDocumentationManifest(project.projectId, async () => {
    let authoritative: DocumentationManifest | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      publishActivity('documentation.prepare');
      const prepared = await computeMaintenance<{
        manifest: DocumentationManifest;
        expectedHead: string;
        unchanged: boolean;
      }>('prepare_documentation_manifest_sync', { projectId: project.projectId, manifest: input.manifest! });
      if (prepared.unchanged) {
        authoritative = prepared.manifest;
        break;
      }
      publishActivity('documentation.publish-authority');
      try {
        authoritative = store.commitDocumentationManifestEvidence(project.projectId, {
          manifest: prepared.manifest, expectedHead: prepared.expectedHead, idempotencyKey
        });
        break;
      } catch (error) {
        if (!/documentation_manifest_conflict/.test(String(error)) || attempt === 2) throw error;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    if (!authoritative) throw new Error('documentation_manifest_conflict');
    return authoritative;
  });
}

async function runDocumentationManifestRefresh(request: RuntimeDataRequest): Promise<DocumentationManifest> {
  if (configuration.affinity !== 'writer-actor') throw new Error('documentation_manifest_writer_required');
  const root = path.resolve(String(request.input.root || ''));
  publishActivity('documentation.scan');
  const manifest = await computeMaintenance<DocumentationManifest>('refresh_documentation_manifest', { root });
  const stableManifest = { ...manifest, updatedAt: '' };
  return runDocumentationManifestSync({ ...request, input: {
    ...request.input,
    root,
    manifest,
    idempotencyKey: `documentation-scan:${crypto.createHash('sha256').update(JSON.stringify(stableManifest)).digest('hex')}`
  } });
}

async function drainPendingDocumentationProjectionQuantum(): Promise<{ processed: number; pending: boolean }> {
  const projectId = store.pendingDocumentationProjectionProjectIds(1)[0];
  if (!projectId || closing) return { processed: 0, pending: false };
  return serializeDocumentationManifest(projectId, async () => {
    const item = store.readDocumentationProjectionItem(projectId);
    if (!item || closing) return { processed: 0, pending: store.pendingDocumentationProjectionProjectIds(1).length > 0 };
    publishActivity(`documentation.${item.phase}:${item.cursor}/${item.documentCount}`);
    if (item.phase === 'binding') store.commitDocumentationProjectionBinding(projectId, item);
    else store.commitDocumentationProjectionDocument(projectId, item);
    return { processed: 1, pending: store.pendingDocumentationProjectionProjectIds(1).length > 0 };
  });
}
if (configuration.affinity === 'writer-actor') {
  maintenanceComputeReady = startMaintenanceComputeWorker();
  store.setMaintenanceCompute({
    digestFile: file => computeMaintenance('digest_file', { file }),
    canonicalize: value => computeMaintenance('canonicalize', { value }),
    inspectBackup: file => computeMaintenance('inspect_backup', { file }),
    restoreBackup: input => computeMaintenance('restore_backup', input),
    prepareProjectImport: source => computeMaintenance('prepare_project_import', { source }),
    stageProjectExport: root => computeMaintenance('stage_project_export', { root }),
    verifyProjectExportContent: (contentId, sha256, bytes) => computeMaintenance('verify_project_export_content', { contentId, sha256, bytes }),
    cleanupProjectExportStage: stageDirectory => computeMaintenance('cleanup_project_export_stage', { stageDirectory }),
    validateProjectImport: tables => computeMaintenance('validate_project_import', { tables }),
    stageFileExport: input => computeMaintenance('stage_file_export', input),
    restoreRecyclingFile: input => computeMaintenance('restore_recycling_file', input),
    cleanupRecyclingRestore: input => computeMaintenance('cleanup_recycling_restore', input)
  });
}
const workspaceCompute: RuntimeWorkspaceCompute | undefined = configuration.affinity === 'writer-actor' ? {
  snapshot: root => requestInternalWriter({ operation: 'compute_workspace_snapshot', input: { root } }) as Promise<WorkspaceSnapshot>,
  gitHead: root => requestInternalWriter({ operation: 'compute_workspace_git_head', input: { root } }) as Promise<string>,
  gitEvidence: (root, baseGitHash, workspace) => requestInternalWriter({
    operation: 'compute_workspace_git_evidence', input: { root, baseGitHash, workspace }
  }) as Promise<import('./runWorkspace').RunGitEvidence>
} : undefined;
const operations = createRuntimeDataOperations(store, workspaceCompute, configuration.readAuthoritySecret,
  configuration.affinity === 'writer-actor'
    ? { executeTelegramEditorCommand: (command, args) => sendRuntimeDataRequest(configuration.root, {
        operation: 'execute_telegram_editor_command', input: { command, args }
      }) }
    : undefined,
  { phase: publishActivity });

let intelligenceRuntime: IntelligenceRuntime | undefined;
const intelligenceReady = configuration.affinity === 'external-worker' && configuration.externalRole !== 'conversation' && configuration.runtime
  ? IntelligenceRuntime.create(
      configuration.root,
      new RemoteIntelligencePersistence(requestInternalWriter),
      requestInternalRuntime as RuntimeDataOperations,
      `${configuration.runtime.runtimeId}:intelligence:${crypto.randomUUID()}`,
      configuration.runtime.releaseVersion,
      configuration.runtime.buildId,
      createRemoteCognitiveRunner
    ).then(runtime => {
      intelligenceRuntime = runtime;
      operations.setIntelligenceRuntime(runtime);
      return configuration.recoverIntelligence ? runtime.recover() : undefined;
    })
  : Promise.resolve();
let resolveStorageMaintenanceBarrier: (() => void) | undefined;
let rejectStorageMaintenanceBarrier: ((error: unknown) => void) | undefined;
if (configuration.affinity === 'writer-actor') {
  importLegacyRuntimeState(store, configuration.root);
  if (configuration.runtime) {
    const barrier = new Promise<void>((resolve, reject) => {
      resolveStorageMaintenanceBarrier = resolve;
      rejectStorageMaintenanceBarrier = reject;
    });
    void barrier.catch(() => undefined);
    operations.setStorageMaintenanceBarrier(barrier);
  }
}
let projectionWorker: Worker | undefined;
let projectionReady = false;
let projectionBusy = false;
let projectionQueued = false;
let projectionSequence = 0;
let projectionRetryDelay = 50;
function publishProjectionEvent(projectPaths: string[]): void {
  port!.postMessage({ projectionEvent: { projectPaths } });
}
function publishProjectRegistryProjection(snapshot: ProjectRegistrySnapshot): void {
  port!.postMessage({ controlProjectionEvent: { projectRegistry: snapshot } });
}
let projectionRestartTimer: NodeJS.Timeout | undefined;
const foundationObserverSyncOperations = new Set([
  'accept_roadmap_csv', 'import_project', 'initialize_project_registry', 'patch_project_registry', 'register_project'
]);

function scheduleSidebarProjection(): void {
  if (!projectionWorker || closing) return;
  projectionQueued = true;
  if (!projectionReady || projectionBusy) return;
  projectionBusy = true;
  projectionQueued = false;
  projectionWorker.ref();
  projectionWorker.postMessage({ id: ++projectionSequence, limit: 16 });
}

function retrySidebarProjection(action: () => void): void {
  if (closing || writerGenerationFenced) return;
  if (projectionRestartTimer) clearTimeout(projectionRestartTimer);
  const delay = projectionRetryDelay;
  projectionRetryDelay = Math.min(2_000, projectionRetryDelay * 2);
  projectionRestartTimer = setTimeout(() => { projectionRestartTimer = undefined; action(); }, delay);
  projectionRestartTimer.unref();
}

function startSidebarProjectionWorker(): void {
  if (configuration.affinity !== 'writer-actor' || closing || projectionWorker) return;
  projectionWorker = new Worker(path.join(__dirname, 'sidebarDatabaseProjectionWorker.js'), {
    workerData: { root: configuration.root, databaseId: configuration.databaseId }
  });
  const worker = projectionWorker;
  worker.on('message', (message: { id?: number; ready?: boolean; closed?: boolean; items?: Array<{ projectId: string; sourceRevision: number; summary: unknown }>; foundationObservations?: Array<{ path: string; signature: string }>; observerError?: string; error?: string }) => {
    if (writerGenerationFenced) return;
    if (message.foundationObservations) {
      store.reconcileSidebarFoundationSignatures(message.foundationObservations);
      scheduleSidebarProjection();
      return;
    }
    if (message.observerError) {
      process.stderr.write(`SoloMap foundation observer: ${message.observerError}\n`);
      retrySidebarProjection(() => worker.postMessage({ syncFoundations: true }));
      return;
    }
    if (message.ready) {
      projectionReady = true;
      worker.unref();
      scheduleSidebarProjection();
      return;
    }
    if (message.closed) return;
    if (Number(message.id) !== projectionSequence) return;
    const items = message.items || [];
    if (message.error) {
      const error = new Error(`sidebar_projection_failed:${message.error}`);
      process.stderr.write(`SoloMap sidebar projection: ${message.error}\n`);
      projectionQueued = true;
    } else {
      const changedPaths: string[] = [];
      for (const item of items) if (store.commitSidebarCoreProjection(item).accepted) changedPaths.push(String((item.summary as { path?: string })?.path || ''));
      if (changedPaths.length) publishProjectionEvent(changedPaths.filter(Boolean));
      projectionRetryDelay = 50;
    }
    projectionBusy = false;
    worker.unref();
    if (message.error) retrySidebarProjection(scheduleSidebarProjection);
    else if (projectionQueued || items.length === 16) setImmediate(scheduleSidebarProjection);
  });
  worker.on('error', error => {
    projectionBusy = false;
    process.stderr.write(`SoloMap sidebar projection worker: ${String(error)}\n`);
    void worker.terminate();
  });
  worker.on('exit', code => {
    if (projectionWorker !== worker) return;
    projectionWorker = undefined;
    projectionReady = false;
    projectionBusy = false;
    if (closing) return;
    process.stderr.write(`SoloMap sidebar projection worker exited (${code}); restarting.\n`);
    retrySidebarProjection(startSidebarProjectionWorker);
  });
  worker.unref();
  projectionQueued = true;
}

if (configuration.affinity === 'writer-actor') startSidebarProjectionWorker();

async function control(action: RuntimeWriteActorControl, input: Record<string, unknown>): Promise<unknown> {
  if (configuration.affinity === 'external-worker') {
    if (configuration.externalRole === 'conversation') throw new Error('runtime_intelligence_control_wrong_lane');
    await intelligenceReady;
    if (action === 'initialize_intelligence') return intelligenceRuntime!.mode();
    if (action === 'recover_intelligence') return intelligenceRuntime!.recover();
    if (action === 'cancel_intelligence_operation') return intelligenceRuntime!.cancel(input);
    if (action === 'drain_intelligence') { await intelligenceRuntime!.drain(); return { drained: true }; }
    if (action === 'resume_intelligence') { await intelligenceRuntime!.resume(); return { resumed: true }; }
    throw new Error('runtime_external_control_required');
  }
  if (configuration.affinity !== 'writer-actor') throw new Error('runtime_write_actor_control_required');
  switch (action) {
    case 'import_legacy_diagnostics':
      await importLegacyLocalDiagnostics(configuration.root,
        event => operations({ operation: 'append_diagnostic_event', input: event as unknown as Record<string, unknown> }).then(() => undefined),
        (source, bytes) => store.captureMigrationSource(source, bytes, { mimeType: 'application/json', encoding: 'utf8', pending: true }),
        (source, result, error) => result === 'imported'
          ? store.markMigrationSourceImported(source.identity, source.key)
          : store.markMigrationSourceConflict(source.identity, source.key, error || 'legacy_diagnostic_invalid'));
      return { imported: true };
    case 'recover_migrations': operations.recoverMigrations(); return { recovered: true };
    case 'recover_runs': operations.recoverRuns(); return { recovered: true };
    case 'initialize_intelligence': {
      throw new Error('runtime_intelligence_control_migrated');
    }
    case 'recover_intelligence': throw new Error('runtime_intelligence_control_migrated');
    case 'cancel_intelligence_operation': throw new Error('runtime_intelligence_control_migrated');
    case 'drain_intelligence':
    case 'resume_intelligence': throw new Error('runtime_intelligence_control_migrated');
    case 'recover_outbox': await store.recoverOutbox(); return { recovered: true };
    case 'wait_for_migrations': await operations.waitForMigrations(); return { settled: true };
    case 'quiesce_for_database_generation': await operations.quiesceForDatabaseGeneration(); return { settled: true };
    case 'interrupt': operations.interruptMigrations(); operations.interruptRuns(); return { interrupted: true };
    case 'storage_maintenance_ready': resolveStorageMaintenanceBarrier?.(); return { ready: true };
    case 'storage_maintenance_failed': rejectStorageMaintenanceBarrier?.(new Error(String(input.error || 'startup_migration_failed'))); return { failed: true };
    case 'settle_redundant_upgrade_migrations': store.settleRedundantAgentRunUpgradeMigrations(); return { settled: true };
    case 'enqueue_startup_migrations': {
      const phase = String(input.phase || 'global');
      if (phase === 'registry') {
        publishActivity('startup.initialize-registry');
        const registry = await store.initializeProjectRegistry();
        publishProjectRegistryProjection(registry);
        return { requests: [], registry };
      }
      if (phase === 'register') {
        const root = path.resolve(String(input.root || ''));
        if (!path.isAbsolute(String(input.root || ''))) throw new Error('startup_migration_root_invalid');
        publishActivity('startup.register-project');
        try {
          await store.registerProject({ root, name: String(input.name || '') });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write(`SoloMap startup project registration: ${root}: ${String(error)}\n`);
        }
        return { requests: [] };
      }
      if (!['project', 'global'].includes(phase)) throw new Error('startup_migration_phase_invalid');
      if (phase === 'project' && !path.isAbsolute(String(input.root || ''))) throw new Error('startup_migration_root_invalid');
      publishActivity(phase === 'project' ? 'startup.discover-project' : 'startup.discover-global');
      const requests = await computeMaintenance<RuntimeDataRequest[]>('discover_startup_migrations', phase === 'project'
        ? { projectPath: path.resolve(String(input.root || '')) }
        : { globalOnly: true });
      return { requests };
    }
    case 'drain_documentation_projections': return drainPendingDocumentationProjectionQuantum();
    case 'backfill_report_versions': return store.backfillReportVersionsBatch(100);
    case 'reap_finished_legacy_runs': return reapFinishedLegacyRunProcesses(store);
    case 'maintain_planner_statistics': store.maintainPlannerStatistics(); return { maintained: true };
    case 'restart_sidebar_projection': {
      if (!projectionWorker) return { restarted: false };
      await projectionWorker.terminate();
      return { restarted: true };
    }
    case 'record_compatibility_drain':
      store.recordPiCompatibilityDrain(input as unknown as Parameters<UnifiedDataStore['recordPiCompatibilityDrain']>[0]);
      return { recorded: true };
    case 'read_project_registry_projection': return store.readProjectRegistry(input);
  }
}

port.on('message', async (message: { id?: number; request?: RuntimeDataRequest; serializeResult?: boolean; control?: { action: RuntimeWriteActorControl; input: Record<string, unknown> }; internalRequestId?: number; internalResult?: unknown; internalError?: string; cognitiveInvocationId?: number; cognitiveResult?: string; cognitiveError?: string; close?: boolean }) => {
  if (message.cognitiveInvocationId !== undefined) {
    const pending = cognitiveInvocationPending.get(message.cognitiveInvocationId);
    if (!pending) return;
    cognitiveInvocationPending.delete(message.cognitiveInvocationId);
    if (message.cognitiveError) pending.reject(new Error(message.cognitiveError));
    else pending.resolve(String(message.cognitiveResult || ''));
    return;
  }
  if (message.internalRequestId !== undefined) {
    const pending = internalWriterPending.get(message.internalRequestId);
    if (!pending) return;
    internalWriterPending.delete(message.internalRequestId);
    if (message.internalError) pending.reject(new Error(message.internalError));
    else pending.resolve(message.internalResult);
    return;
  }
  if (message.close) {
    if (closing) return;
    closing = true;
    for (const pending of internalWriterPending.values()) pending.reject(new Error('runtime_internal_writer_closing'));
    internalWriterPending.clear();
    const releaseWriter = await acquireWriterGate(true);
    try {
      if (maintenanceComputeRestartTimer) clearTimeout(maintenanceComputeRestartTimer);
      maintenanceComputeRestartTimer = undefined;
      if (projectionRestartTimer) clearTimeout(projectionRestartTimer);
      projectionRestartTimer = undefined;
      if (projectionWorker) {
        const worker = projectionWorker;
        projectionWorker = undefined;
        await worker.terminate();
      }
      await operations.close();
      if (maintenanceComputeWorker) {
        const worker = maintenanceComputeWorker;
        maintenanceComputeWorker = undefined;
        await worker.terminate();
      }
    } finally {
      releaseWriter();
      store.close();
      port.postMessage({ closed: true });
      port.close();
    }
    return;
  }
  const id = Number(message.id);
  if (writerGenerationFenced && configuration.affinity === 'writer-actor') {
    port.postMessage({ id, error: 'database_generation_cutover' });
    return;
  }
  // Ordinary Writer requests may yield to independent Git/network children.
  // A command that spans one SQLite transaction receives an exclusive segment,
  // so no unrelated request can accidentally join or roll back that transaction.
  const releaseWriter = await acquireWriterGate(configuration.affinity === 'writer-actor'
    && message.request?.operation === 'prepare_agent_launch');
  if (configuration.affinity === 'writer-actor') activeWriterOperations += 1;
  try {
    port.postMessage({ activity: { id, phase: 'executing' } });
    if (message.control) {
      const result = await activityContext.run(id, () => control(message.control!.action, message.control!.input || {}));
      port.postMessage({ id, result });
      return;
    }
    if (!message.request) throw new Error('runtime_data_domain_request_missing');
    const definition = runtimeOperationDefinition(message.request.operation);
    const writerAuthorityOverride = configuration.affinity === 'writer-actor'
      && Boolean(message.request.sessionToken || message.request.piToolFence
        || message.request.operation === 'read_run_state');
    const writerMaintenanceWorker = configuration.affinity === 'writer-actor' && definition.executor === 'maintenance-worker';
    if (definition.executor !== configuration.affinity && !writerAuthorityOverride && !writerMaintenanceWorker) throw new Error(`runtime_data_domain_mismatch:${definition.executor}`);
    if (configuration.affinity !== 'writer-actor' && (message.request.sessionToken || message.request.piToolFence)
      && !(definition.kind === 'query' && message.request.readAuthority)
      && !(configuration.affinity === 'external-worker' && configuration.externalRole === 'conversation'
        && message.request.operation === 'start_conversation')) throw new Error('runtime_data_domain_authority_required');
    if (configuration.affinity === 'external-worker') {
      const conversationRequest = message.request.operation === 'start_conversation';
      if ((configuration.externalRole === 'conversation') !== conversationRequest) throw new Error('runtime_external_lane_mismatch');
    }
    const result = configuration.affinity === 'writer-actor' && message.request.operation === 'import_project'
      ? await activityContext.run(id, () => runProjectImportGeneration(message.request!))
      : configuration.affinity === 'writer-actor' && message.request.operation === 'refresh_project_growth'
      ? await activityContext.run(id, () => runProjectGrowthRefresh(message.request!))
      : configuration.affinity === 'writer-actor' && message.request.operation === 'run_project_coverage_analysis'
      ? await activityContext.run(id, () => runProjectCoverageAnalysis(message.request!))
      : configuration.affinity === 'writer-actor' && message.request.operation === 'backfill_run_indexes'
      ? await activityContext.run(id, () => runRunIndexBackfill(message.request!))
      : configuration.affinity === 'writer-actor' && message.request.operation === 'sync_documentation_manifest'
      ? await activityContext.run(id, () => runDocumentationManifestSync(message.request!))
      : configuration.affinity === 'writer-actor' && message.request.operation === 'refresh_documentation_manifest'
      ? await activityContext.run(id, () => runDocumentationManifestRefresh(message.request!))
      : configuration.affinity === 'writer-actor' && message.request.operation === 'audit_documentation_manifest'
      ? await activityContext.run(id, () => computeMaintenance('audit_documentation_manifest', {
        root: message.request!.input.root, auditOptions: message.request!.input.options
      }))
      : configuration.affinity === 'writer-actor' && message.request.operation === 'read_database_generation_reclaim_manifest'
      ? await activityContext.run(id, () => computeMaintenance('read_database_generation_reclaim_manifest', message.request!.input))
      : configuration.affinity === 'git-worker'
      ? await activityContext.run(id, () => serializeGitOperation(() => operations(message.request!)))
      : configuration.affinity === 'external-worker' && configuration.externalRole === 'conversation' && message.request.operation === 'start_conversation'
      ? await activityContext.run(id, () => requestInternalRuntime(message.request!))
      : await activityContext.run(id, () => operations(message.request!));
    if (configuration.affinity === 'writer-actor') {
      if (message.request.operation === 'initialize_project_registry' || message.request.operation === 'patch_project_registry') {
        publishProjectRegistryProjection(result as ProjectRegistrySnapshot);
      }
      scheduleSidebarProjection();
      if (foundationObserverSyncOperations.has(message.request.operation)) projectionWorker?.postMessage({ syncFoundations: true });
    }
    const serializedResult = message.serializeResult === true ? JSON.stringify(result ?? null) : undefined;
    port.postMessage(message.serializeResult === true ? { id, serializedResult } : { id, result });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    port.postMessage({ id, error: detail });
  } finally {
    if (configuration.affinity === 'writer-actor') activeWriterOperations -= 1;
    releaseWriter();
  }
});

void maintenanceComputeReady.then(async () => {
  await intelligenceReady;
}).then(() => {
  port.postMessage({ ready: true, threadId, maintenanceThreadId: maintenanceComputeThreadId, affinity: configuration.affinity });
}).catch(error => {
  process.stderr.write(`SoloMap maintenance compute worker: ${String(error)}\n`);
  process.exitCode = 1;
  port.close();
});
