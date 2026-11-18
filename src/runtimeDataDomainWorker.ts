import { legacyReviewRequestForTransfer,restoreLegacyReviewResult } from './db/legacyReviewBatchPublication.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { parentPort, threadId, Worker, workerData } from 'worker_threads';

import { sendRuntimeDataRequest, type RuntimeDataRequest } from './autonomousRuntimeControl';
import { projectJournalSerializedResult, UnifiedDataStore } from './db/unifiedDataStore';
import { runInputsSerializedResult } from './db/runInputsPublication.js';
import { boundedDataWriteBytes } from './db/dataWritePublication.js';
import { RuntimeContinuationSource } from './runtimeWorkContinuationBridge.js';
import { createRuntimeDataOperations, RuntimeDataOperations, RuntimeWorkspaceCompute } from './runtimeDataOperations';
import { runtimeOperationDefinition, RuntimeExecutorAffinity } from './runtimeOperationRegistry';
import { configureLocalDiagnosticPersistence, importLegacyLocalDiagnostics } from './localDiagnostics';
import { importLegacyRuntimeState } from './runtimeStateMigration';
import { IntelligenceRuntime, type IntelligenceCognitiveRunner } from './intelligenceRuntime';
import { RemoteIntelligencePersistence } from './intelligencePersistence';
import { reapFinishedLegacyRunProcesses } from './legacyRunProcessRecovery';
import type { RuntimeWriteActorConfiguration, RuntimeWriteActorControl } from './runtimeDataExecutionDomains';
import type { WorkspaceSnapshot } from './runWorkspace';
import { captureDatabaseGenerationProof, persistDatabaseGenerationCutover } from './databaseGeneration';
import { DatabaseSnapshotWorkerClient, type PersistedDatabaseChangeset } from './databaseSnapshotWorkerClient.js';
import { DatabaseGenerationWorkerClient } from './databaseGenerationWorkerClient.js';
import { configureExternalSignalDataRequest } from './projectExternalSignals';
import type { GrowthSnapshotStageManifest, GrowthSnapshotStageSection } from './db/types';
import type { ProjectCoverageSnapshot } from './projectCoverage';
import type { DocumentationManifest } from './documentationManifest';
import type { CognitiveCliInvocation } from './localAgentCliEngine';
import type { ProjectRegistrySnapshot } from './projectRegistry';
import { dataValueTransferIfDeep,restoreDataValueTransfer,type DataValueTransfer } from './db/dataValueTransfer.js';

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
const workContinuations=new RuntimeContinuationSource((token,error)=>port.postMessage({continuationReady:{token,...(error===undefined?{}:{error})}}));
function postWorkResult(id:number,result:unknown,serializeResult:boolean,projectAfter=false):void {
  const continuation=workContinuations.expose(result);
  if(continuation){port!.postMessage({id,continuation});return;}
  if(projectAfter)scheduleSidebarProjection();
  const cached=result && typeof result==='object'
    ? (result as {[projectJournalSerializedResult]?:string})[projectJournalSerializedResult] ?? runInputsSerializedResult(result) : undefined;
  const resultTransfer=serializeResult?undefined:dataValueTransferIfDeep(result);
  port!.postMessage(serializeResult?{id,serializedResult:cached ?? JSON.stringify(result ?? null)}:resultTransfer?{id,resultTransfer}:{id,result});
}
const configuration = workerData as DomainWorkerData;
const store = configuration.affinity === 'writer-actor'
  ? UnifiedDataStore.open(configuration.root, configuration.databaseId)
  : UnifiedDataStore.openReadOnly(configuration.root, configuration.databaseId);
if (store.databaseId !== configuration.databaseId) {
  store.close();
  throw new Error('database_identity_mismatch');
}
if (configuration.affinity === 'writer-actor') store.beginContentPreparationRecovery();
if (configuration.affinity === 'writer-actor') configureLocalDiagnosticPersistence({
  append: (_root, event) => boundedDataWriteBytes(event, 65536) !== undefined
    ? store.publishDiagnosticEvent(event).then(() => undefined)
    : requestInternalWriter({ operation: 'append_diagnostic_event', input: event as unknown as Record<string, unknown> }).then(() => undefined),
  read: async () => store.readDiagnosticEvents({ limit: 250 }) as unknown as { items: Record<string, unknown>[] }
}, configuration.root);
let closing = false;
const activityContext = new AsyncLocalStorage<number>();
const generationAdmission = new AsyncLocalStorage<() => void>();
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
let generationStopping = false;
let activeWriterOperations = 0;
const generationSnapshotWorkers = new Set<DatabaseSnapshotWorkerClient>();
const generationComputeWorkers = new Set<DatabaseGenerationWorkerClient>();
const generationJobs = new Set<Promise<unknown>>();
let maintenanceComputeStopping: Promise<number> | undefined;
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

function runDatabaseGeneration(request: RuntimeDataRequest, releaseAdmission: () => void): Promise<unknown> {
  const job = executeDatabaseGeneration(request, releaseAdmission);
  generationJobs.add(job);
  const remove = (): void => { generationJobs.delete(job); };
  void job.then(remove, remove);
  return job;
}

async function reclaimOwnGeneration(generationId: string, identity: fs.BigIntStats): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'databaseGenerationCleanupWorker.js'), { workerData: {
      root: configuration.root, generationId, device: String(identity.dev), inode: String(identity.ino)
    } });
    let reply: { error?: string; result?: unknown } | undefined;
    worker.on('message', message => { reply = message; });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0 || !reply || reply.error) reject(new Error(reply?.error || `database_generation_cleanup_exited:${code}`));
      else resolve();
    });
  });
}

async function executeDatabaseGeneration(request: RuntimeDataRequest, releaseAdmission: () => void): Promise<unknown> {
  if (configuration.affinity !== 'writer-actor') throw new Error('database_generation_writer_required');
  releaseAdmission();
  if (generationStopping || closing) throw new Error('database_generation_interrupted');
  const compact = request.operation === 'maintain_database_storage', startedAt = Date.now();
  const source = path.resolve(String(request.input.source || '')), targetRoot = path.resolve(String(request.input.root || ''));
  const idempotencyKey = String(request.input.idempotencyKey || '');
  if (!idempotencyKey.trim()) throw new Error('idempotency_key_required');
  let ownsFinalFence = false;
  const segment = async <T>(exclusive: boolean, operation: () => T | Promise<T>): Promise<T> => {
    const release = await acquireWriterGate(exclusive);
    try {
      if (closing || generationStopping) throw new Error('database_generation_interrupted');
      if (request.piToolFence) store.assertPiToolInvocationActive(request.piToolFence.operationId, request.piToolFence.invocationId, {
        ownerId: request.piToolFence.ownerId, generation: request.piToolFence.ownerGeneration
      });
      if (writerGenerationFenced && !ownsFinalFence) throw new Error('database_generation_cutover');
      return await operation();
    } finally { release(); }
  };
  if (compact) {
    const committed = await segment(false, () => store.readCommittedDatabaseCompaction(idempotencyKey));
    if (committed) return committed;
  }
  const generationId = crypto.randomUUID(), candidateDir = path.join(configuration.root, 'database-generations', generationId);
  fs.mkdirSync(path.dirname(candidateDir), { recursive: true, mode: 0o700 });
  fs.mkdirSync(candidateDir, { mode: 0o700 });
  const generationIdentity = fs.lstatSync(candidateDir, { bigint: true });
  let snapshotWorker: DatabaseSnapshotWorkerClient | undefined;
  let generationWorker: DatabaseGenerationWorkerClient | undefined;
  let sequence = 0, captureActive = false;
  let capturedSchemaCookie: number | undefined;
  let timer: NodeJS.Timeout | undefined;
  let captureFlight: Promise<boolean> | undefined;
  let captureFailure: Error | undefined;
  let buildFlight: Promise<Record<string, any>> | undefined;
  let stopFlight: Promise<void> | undefined;
  const stopCapture = (): Promise<void> => stopFlight ||= (async () => {
    const release = await acquireWriterGate(false);
    try { if (captureActive) { try { store.cancelDatabaseGenerationCapture(); } finally { captureActive = false; } } }
    finally { release(); }
  })();
  const failCapture = (error: unknown): void => {
    captureFailure ||= error instanceof Error ? error : new Error(String(error));
    if (timer) clearInterval(timer);
    // Stop the source Session independently of the candidate build's completion.
    void stopCapture().catch(stopError => { process.stderr.write(`SoloMap capture stop: ${String(stopError)}\n`); });
    void generationWorker?.close();
  };
  const assertCaptureHealthy = (): void => { if (captureFailure) throw captureFailure; snapshotWorker?.assertHealthy(); generationWorker?.assertHealthy(); };
  const pending: PersistedDatabaseChangeset[] = [];
  const captureQuantum = async (stop = false): Promise<boolean> => {
    const capture = await segment(false, () => {
      assertCaptureHealthy();
      store.assertDatabaseGenerationSchema(capturedSchemaCookie!);
      const result = stop ? store.stopDatabaseGenerationCapture() : store.rotateDatabaseGenerationCapture();
      if (stop) captureActive = false;
      return { ...result, liveSequence: store.readRuntimeWriterBarrier().committedSequence };
    });
    if (!capture.changeset.byteLength && !capture.searchObjectIds.length) return false;
    pending.push(await snapshotWorker!.persistChangeset({ ...capture, sequence: ++sequence }));
    return true;
  };
  try {
    generationWorker = await DatabaseGenerationWorkerClient.start({ root: configuration.root, databaseId: configuration.databaseId,
      generation: { candidateDir, device: String(generationIdentity.dev), inode: String(generationIdentity.ino) } });
    generationComputeWorkers.add(generationWorker);
    if (!compact) {
      const identity = await generationWorker.request<{ sourceHash: string; projectId: string }>('inspect_project_import', { candidateDir, source });
      const committed = await segment(false, () => store.readCommittedProjectImport({ sourceHash: identity.sourceHash, targetRoot, idempotencyKey }));
      if (committed) {
        await generationWorker.close();
        await reclaimOwnGeneration(generationId, generationIdentity);
        return committed;
      }
    }
    await segment(false, () => store.assertDatabaseGenerationCapacity(compact));
    snapshotWorker = await DatabaseSnapshotWorkerClient.start({ root: configuration.root, databaseId: configuration.databaseId,
      writerIncarnation: store.databaseWriterIncarnation, candidateDir, generationDevice: String(generationIdentity.dev), generationInode: String(generationIdentity.ino), baselineName: compact ? 'baseline.db' : 'solomap.db' });
    generationSnapshotWorkers.add(snapshotWorker);
    let binding;
    while (!captureActive) {
      binding = await segment(true, async () => {
        const fence = store.readDatabaseSnapshotFence();
        const snapshot = await snapshotWorker!.pin(fence.token);
        captureActive = store.beginPinnedDatabaseGenerationCapture(snapshot, fence, snapshotWorker!);
        if (captureActive) capturedSchemaCookie = snapshot.schemaCookie;
        return snapshot;
      });
      if (!captureActive) await new Promise<void>(resolve => setImmediate(resolve));
    }
    timer = setInterval(() => {
      if (captureFlight || !captureActive) return;
      const flight = captureQuantum();
      captureFlight = flight;
      void flight.then(() => { if (captureFlight === flight) captureFlight = undefined; }, error => {
        failCapture(error);
        if (captureFlight === flight) captureFlight = undefined;
      });
    }, 50);
    timer.unref();
    const baseline = await snapshotWorker.copy(binding!);
    let appliedLiveSequence = Number(baseline.committedSequence);
    assertCaptureHealthy();
    buildFlight = generationWorker.request<Record<string, any>>(compact ? 'build_compact_database_generation' : 'build_project_import_generation', { candidateDir, source, targetRoot, idempotencyKey,
      value: { device: String(generationIdentity.dev), inode: String(generationIdentity.ino) } });
    const built = await buildFlight;
    assertCaptureHealthy();
    clearInterval(timer);
    await captureFlight;
    assertCaptureHealthy();
    await captureQuantum();
    for (let catchupRound = 0; catchupRound < 4; catchupRound++) {
      while (pending.length) {
        const item = pending.shift()!;
        const currentLiveSequence = Math.max(appliedLiveSequence, item.liveSequence);
        await generationWorker.request('apply_project_import_generation_changeset', { candidateDir, changesetFile: item.file, searchObjectIds: item.searchObjectIds, previousLiveSequence: appliedLiveSequence, currentLiveSequence });
        appliedLiveSequence = currentLiveSequence;
      }
      if (catchupRound === 3 || !await captureQuantum()) break;
    }
    if (closing || generationStopping) throw new Error('database_generation_interrupted');
    writerGenerationFenced = true;
    ownsFinalFence = true;
    while (activeWriterOperations > 1) await new Promise<void>(resolve => setImmediate(resolve));
    await operations.quiesceForDatabaseGeneration();
    if (projectionWorker) { const worker = projectionWorker; projectionWorker = undefined; await worker.terminate(); }
    await captureQuantum(true);
    while (pending.length) {
      const item = pending.shift()!;
      const currentLiveSequence = Math.max(appliedLiveSequence, item.liveSequence);
      await generationWorker.request('apply_project_import_generation_changeset', { candidateDir, changesetFile: item.file, searchObjectIds: item.searchObjectIds, previousLiveSequence: appliedLiveSequence, currentLiveSequence });
      appliedLiveSequence = currentLiveSequence;
    }
    const compactResult = compact ? await generationWorker.request<import('./databaseGeneration.js').DatabaseCompactionResult>('finalize_compact_database_generation', { candidateDir,
      value: { idempotencyKey, beforeBytes: baseline.bytes, startedAt, device: String(generationIdentity.dev), inode: String(generationIdentity.ino) } }) : undefined;
    if (!compact) {
      const orderHeads = await segment(false,()=>store.readGlobalRecordOrderHeads());
      await generationWorker.request('verify_project_import_generation', { candidateDir,value:orderHeads });
    }
    assertCaptureHealthy();
    if (request.piToolFence) store.assertPiToolInvocationActive(request.piToolFence.operationId, request.piToolFence.invocationId, {
        ownerId: request.piToolFence.ownerId, generation: request.piToolFence.ownerGeneration
    });
    const cutover = {
      schemaVersion: 1, state: 'ready', generationId, candidateDir, databaseId: configuration.databaseId,
      createdAt: Date.now(),
      candidateProof: captureDatabaseGenerationProof(path.join(candidateDir, 'solomap.db'))
    } as const;
    persistDatabaseGenerationCutover(configuration.root, compact ? { ...cutover, purpose: 'compact', result: compactResult! } : { ...cutover,
      result: { projectId: String(built.projectId), locationId: String(built.locationId), identityPath: String(built.identityPath), roadmapPath: String(built.roadmapPath) },
      hiddenIdentityPath: String(built.hiddenIdentityPath), hiddenRoadmapPath: String(built.hiddenRoadmapPath) });
    await snapshotWorker.close();
    await generationWorker.close();
    setTimeout(() => process.exit(75), 25).unref();
    throw new Error('database_generation_cutover');
  } catch (error) {
    if (timer) clearInterval(timer);
    await stopCapture();
    await snapshotWorker?.close();
    await generationWorker?.close();
    await captureFlight?.catch(() => undefined);
    await buildFlight?.catch(() => undefined);
    await maintenanceComputeStopping;
    if (!ownsFinalFence) {
      try { await reclaimOwnGeneration(generationId, generationIdentity); }
      catch (cleanupError) { process.stderr.write(`SoloMap failed generation cleanup: ${String(cleanupError)}\n`); }
    }
    if (ownsFinalFence) setTimeout(() => process.exit(76), 25).unref();
    throw captureFailure || error;
  } finally {
    if (snapshotWorker) { await snapshotWorker.close(); generationSnapshotWorkers.delete(snapshotWorker); }
    if (generationWorker) { await generationWorker.close(); generationComputeWorkers.delete(generationWorker); }
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
    let workerFailure:Error|undefined;
    maintenanceComputeWorker = worker;
    worker.on('message', (message: { id?: number; ready?: boolean; threadId?: number; result?: unknown; error?: string; errorCode?: string }) => {
      if (message.ready) {
        maintenanceComputeThreadId = Number(message.threadId || 0);
        resolve();
        return;
      }
      const pending = maintenanceComputePending.get(Number(message.id));
      if (!pending) return;
      maintenanceComputePending.delete(Number(message.id));
      if (message.error) pending.reject(Object.assign(new Error(message.error), message.errorCode ? { code: message.errorCode } : {}));
      else pending.resolve(message.result);
    });
    worker.once('error', error => {workerFailure = error;});
    worker.once('exit', code => {
      const failure=Object.assign(new Error(`maintenance_compute_exited:${code}`),{cause:workerFailure});
      reject(failure);
      if (maintenanceComputeWorker !== worker) return;
      maintenanceComputeWorker = undefined;
      maintenanceComputeThreadId = 0;
      rejectMaintenanceComputePending(failure);
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
  if (closing) throw new Error('maintenance_compute_closing');
  await startMaintenanceComputeWorker();
  if (closing) throw new Error('maintenance_compute_closing');
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
  const fence=request.piToolFence?{...request.piToolFence}:undefined;
  const reservation = await store.reserveProjectGrowthRefresh(project.projectId,requestId,publish=>fence?store.withPiToolInvocationFenceSync(fence.operationId,fence.invocationId,{ownerId:fence.ownerId,generation:fence.ownerGeneration},publish):publish());
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
  try {
    await store.beginProjectGrowthRefreshStage(project.projectId, { requestId, generation: reservation.generation, manifest });
    for (const section of ['nodes', 'edges', 'signals', 'labels'] as GrowthSnapshotStageSection[]) {
      let offset = 0;
      for (;;) {
        const page = await computeMaintenance<{ items: unknown[]; nextOffset: number | null }>('read_project_growth_stage_page', { stageId: manifest.stageId, section, offset });
        if (page.items.length) await store.appendProjectGrowthRefreshStage(manifest.stageId, section, offset, page.items);
        if (page.nextOffset === null) break;
        if (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error('growth_refresh_stage_page_invalid');
        offset = page.nextOffset;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    return await store.commitProjectGrowthRefreshStage(project.projectId,manifest.stageId,publish=>fence?store.withPiToolInvocationFenceSync(fence.operationId,fence.invocationId,{ownerId:fence.ownerId,generation:fence.ownerGeneration},publish):publish());
  } finally {
    try{await store.discardProjectGrowthRefreshStage(manifest.stageId).catch(()=>undefined);}
    finally{await computeMaintenance('cleanup_project_growth_stage', { stageId: manifest.stageId }).catch(() => undefined);}
  }
}
const projectCoverageRuns = new Map<string, Promise<ProjectCoverageSnapshot>>();
function runProjectCoverageAnalysis(request: RuntimeDataRequest): Promise<ProjectCoverageSnapshot> {
  if (configuration.affinity !== 'writer-actor') return Promise.reject(new Error('project_coverage_writer_required'));
  const fence=request.piToolFence?{...request.piToolFence}:undefined;
  const projectPath = path.resolve(String(request.input.root || ''));
  const extensionPath = path.resolve(String(request.input.extensionPath || ''));
  const key = `${projectPath}\0${extensionPath}`;
  const active = projectCoverageRuns.get(key);
  if (active) return active;
  const run = (async () => {
    const project = await store.registerProject({ root: projectPath });
    const gitFacts = await requestInternalWriter({ operation: 'read_project_growth_git_facts', input: { root: projectPath } }) as { head: string };
    const snapshot = await computeMaintenance<ProjectCoverageSnapshot>('compute_project_coverage', { projectPath, extensionPath, gitHead: gitFacts.head });
    const written=await store.publishProjectCoverageState(project.projectId,snapshot,`coverage:${crypto.randomUUID()}`,publish=>fence?store.withPiToolInvocationFenceSync(fence.operationId,fence.invocationId,{ownerId:fence.ownerId,generation:fence.ownerGeneration},publish):publish());
    return written.value as ProjectCoverageSnapshot;
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
    const committed = await store.publishRunIndexBackfill(project.projectId, 1);
    if (!committed) break;
    backfilledCount += committed;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const health = await requestInternalWriter({ operation: 'read_run_index_health', input: { projectId: project.projectId } }) as ReturnType<UnifiedDataStore['readRunIndexHealth']>;
  return { ...health, backfilledCount };
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
  store.setProjectMigrationInspectionCompute(value => computeMaintenance('inspect_project_migration_source', { value }));
  store.setScheduleSyncCompute(value => computeMaintenance('prepare_schedule_sync',{value}));
  store.setHostSettingsCompute({
    prepare: value => computeMaintenance('prepare_host_settings', { value }),
    project: value => computeMaintenance('project_host_settings', { value })
  });
  store.setMaintenanceCompute({
    prepareFlowTrace: value => computeMaintenance('prepare_flow_trace_publication',{value}),
    planFlowTrace: value => computeMaintenance('plan_flow_trace_publication',{value}),
    selectRunAllocation: value => computeMaintenance('select_run_allocation',{value}),
    selectFlowRole: value => computeMaintenance('select_flow_role',{value}),
    prepareRunControl: value => computeMaintenance('prepare_run_control',{value}),
    prepareRunDeliveryStart: value => computeMaintenance('prepare_run_delivery_start',{value}),
    prepareRunDocument: value => computeMaintenance('prepare_run_document',{value}),
    planRunDocument: value => computeMaintenance('plan_run_document',{value}),
    inspectRunCheckpoint: value => computeMaintenance('inspect_run_checkpoint',{value}),
    prepareRunCheckpoint: value => computeMaintenance('prepare_run_checkpoint',{value}),
    planRunCheckpoint: value => computeMaintenance('plan_run_checkpoint',{value}),
    inspectRunOutput: value => computeMaintenance('inspect_run_output',{value}),
    prepareRunOutput: value => computeMaintenance('prepare_run_output',{value}),
    prepareRunConsumerClaim: value => computeMaintenance('prepare_run_consumer_claim',{value}),
    prepareRunVerification: value => computeMaintenance('prepare_run_verification',{value}),
    prepareGlobalPromptSave: value => computeMaintenance('prepare_global_prompt_save',{value}),
    prepareLearningReviewEntry:value=>computeMaintenance('prepare_learning_review_entry',{value}),
    projectLearningReviewPreparationResult:value=>computeMaintenance('project_learning_review_preparation_result',{value}),
    beginLearningReviewPreparation:value=>computeMaintenance('begin_learning_review_preparation',{value}),
    advanceLearningReviewPreparation:value=>computeMaintenance('advance_learning_review_preparation',{value}),
    releaseLearningReviewPreparation:value=>computeMaintenance('release_learning_review_preparation',{value}),
    beginLearningReviewSourceCapture:value=>computeMaintenance('begin_learning_review_source_capture',{value}),
    captureLearningReviewSourcePage:value=>computeMaintenance('capture_learning_review_source_page',{value}),
    peekLearningReviewSourceCapture:value=>computeMaintenance('peek_learning_review_source_capture',{value}),
    consumeLearningReviewSourceCapture:value=>computeMaintenance('consume_learning_review_source_capture',{value}),
    releaseLearningReviewSourceCapture:value=>computeMaintenance('release_learning_review_source_capture',{value}),
    prepareGlobalPromptOverrides: value => computeMaintenance('prepare_global_prompt_overrides',{value}),
    prepareGlobalPromptSupersede: value => computeMaintenance('prepare_global_prompt_supersede',{value}),
    prepareExternalMemoryMutation: value => computeMaintenance('prepare_external_memory_mutation',{value}),
    prepareLearningCycle: value => computeMaintenance('prepare_learning_cycle',{value}),
    prepareLearningReviewFinish: value => computeMaintenance('prepare_learning_review_finish',{value}),
    prepareLearningReviewInterrupt: value => computeMaintenance('prepare_learning_review_interrupt',{value}),
    prepareLearningReviewApply: value => computeMaintenance('prepare_learning_review_apply',{value}),
    qualifyLearningReviewApply: value => computeMaintenance('qualify_learning_review_apply',{value}),
    prepareLearningReviewApplyRecovery: value => computeMaintenance('prepare_learning_review_apply_recovery',{value}),
    projectLearningReviewApplyResult: value => computeMaintenance('project_learning_review_apply_result',{value}),
    prepareDiagnosticEvent: value => computeMaintenance('prepare_diagnostic_event',{value}),
    prepareRunSettlement: value => computeMaintenance('prepare_run_settlement',{value}),
    prepareRunSettlementPayload: value => computeMaintenance('prepare_run_settlement_payload',{value}),
    prepareRunSettlementDigest: value => computeMaintenance('prepare_run_settlement_digest',{value}),
    prepareRunSettlementDocumentation: value => computeMaintenance('prepare_run_settlement_documentation',{value}),
    prepareRunSettlementLearning: value => computeMaintenance('prepare_run_settlement_learning',{value}),
    prepareImportObject: value => computeMaintenance('prepare_import_object',{value}),
    prepareArchiveSource: value => computeMaintenance('prepare_archive_source',{value}),
    prepareDirectGrowth: value => computeMaintenance('prepare_direct_growth',{value}),
    prepareLegacyReviewBatch: value => computeMaintenance('prepare_legacy_review_batch',{value:legacyReviewRequestForTransfer(value)}).then(restoreLegacyReviewResult),
    prepareLessonSource: value => computeMaintenance('prepare_lesson_source',{value}),
    prepareRegisteredReportTask: value => computeMaintenance('prepare_registered_report_task',{value}),
    prepareRegisteredReport: value => computeMaintenance('prepare_registered_report',{value}),
    prepareHistoricalRunAdoptionInput: value => computeMaintenance('prepare_historical_run_adoption_input',{value}),
    prepareHistoricalRunIdentity: value => computeMaintenance('prepare_historical_run_identity',{value}),
    prepareHistoricalRunTask: value => computeMaintenance('prepare_historical_run_task',{value}),
    prepareHistoricalRunSources: value => computeMaintenance('prepare_historical_run_sources',{value}),
    prepareHistoricalRunExisting: value => computeMaintenance('prepare_historical_run_existing',{value}),
    prepareHistoricalRunRootSelection: value => computeMaintenance('prepare_historical_run_root_selection',{value}),
    prepareHistoricalRunRootTurn: value => computeMaintenance('prepare_historical_run_root_turn',{value}),
    prepareHistoricalRunRootMetadata: value => computeMaintenance('prepare_historical_run_root_metadata',{value}),
    planHistoricalRunRootBody: value => computeMaintenance('plan_historical_run_root_body',{value}),
    prepareHistoricalRunRootNode: value => computeMaintenance('prepare_historical_run_root_node',{value}),
    prepareHistoricalRunRootDocument: value => computeMaintenance('prepare_historical_run_root_document',{value}),
    prepareHistoricalRunRootFinalMetadata: value => computeMaintenance('prepare_historical_run_root_final_metadata',{value}),
    projectHistoricalRunRoot: value => computeMaintenance('project_historical_run_root',{value}),
    prepareLearningDecisionSource: value => computeMaintenance('prepare_learning_decision_source',{value}),
    prepareLearningEventSource: value => computeMaintenance('prepare_learning_event_source',{value}),
    prepareLegacyReviewCursor: value => computeMaintenance('prepare_legacy_review_cursor',{value}),
    prepareStateWrite: value => computeMaintenance('prepare_state_write',{value}),
    captureGrowthStage: value => computeMaintenance('capture_growth_stage',{value}),
    prepareStepMemoryImport: value => computeMaintenance('prepare_step_memory_import',{value}),
    planStepMemoryImportSource: value => computeMaintenance('plan_step_memory_import_source',{value}),
    prepareStepMemory: value => computeMaintenance('prepare_step_memory',{value}),
    prepareStepMemoryBody: value => computeMaintenance('prepare_step_memory_body',{value}),
    planStepMemory: value => computeMaintenance('plan_step_memory',{value}),
    projectStepMemoryResult: value => computeMaintenance('project_step_memory_result',{value}),
    prepareRunSettlementStep: value => computeMaintenance('prepare_run_settlement_step',{value}),
    planRunSettlementStep: value => computeMaintenance('plan_run_settlement_step',{value}),
    prepareRunSettlementJournals: value => computeMaintenance('prepare_run_settlement_journals',{value}),
    prepareRunSettlementTail: value => computeMaintenance('prepare_run_settlement_tail',{value}),
    prepareRunSettlementNotification: value => computeMaintenance('prepare_run_settlement_notification',{value}),
    planRunOutput: value => computeMaintenance('plan_run_output',{value}),
    prepareRunContext: value => computeMaintenance('prepare_run_context',{value}),
    prepareCurrentRunCheckpoint: value => computeMaintenance('prepare_current_run_checkpoint',{value}),
    prepareRunTaskIngress: value => computeMaintenance('prepare_run_task_ingress',{value}),
    prepareRunNativeRows: value => computeMaintenance('prepare_run_native_rows',{value}),
    releaseRunNativeRows: value => computeMaintenance('release_run_native_rows',{value}),
    prepareRunObserverDocument: value => computeMaintenance('prepare_run_observer_document',{value}),
    prepareRunDocumentValue: value => computeMaintenance('prepare_run_document_value',{value}),
    prepareRunReport: value => computeMaintenance('prepare_run_report',{value}),
    prepareRunLog: value => computeMaintenance('prepare_run_log',{value}),
    projectRunReportResult: value => computeMaintenance('project_run_report_result',{value}),
    selectAgentLaunch: value => computeMaintenance('select_agent_launch',{value}),
    prepareAgentLaunchStep: value => computeMaintenance('prepare_agent_launch_step',{value}),
    prepareAgentLaunchArtifacts: value => computeMaintenance('prepare_agent_launch_artifacts',{value}),
    prepareRunCreation: value => computeMaintenance('prepare_run_creation',{value}),
    planRunCreation: value => computeMaintenance('plan_run_creation',{value}),
    prepareRunInputs: value => computeMaintenance('prepare_run_inputs',{value}),
    planRunInputs: value => computeMaintenance('plan_run_inputs',{value}),
    projectRunInputsResult: value => computeMaintenance('project_run_inputs_result',{value}),
    prepareDataWrite: value => computeMaintenance('prepare_data_write',{value}),
    prepareDataWriteSearch: value => computeMaintenance('prepare_data_write_search',{value}),
    prepareDataWriteReferences: value => computeMaintenance('prepare_data_write_references',{value}),
    prepareLink:value=>computeMaintenance('prepare_link',{value}),
    prepareMcpMutationAuthorization:value=>computeMaintenance('prepare_mcp_mutation_authorization',{value}),
    prepareRunNative:value=>computeMaintenance('prepare_run_native',{value}),
    prepareRunTurnRequest:value=>computeMaintenance('prepare_run_turn_request',{value}),
    qualifyRunTurnRequest:value=>computeMaintenance('qualify_run_turn_request',{value}),
    verifyContentForPublication: value => computeMaintenance('verify_content_publication', { value }),
    runInputFile: value => computeMaintenance('run_input_file', { value }),
    prepareStorageRunOutputBatch: limit => computeMaintenance('prepare_storage_run_output_batch', { limit }),
    prepareProjectRetirementPage: value => computeMaintenance('prepare_project_retirement_page', { value }),
    qualifyProjectRetirement: value => computeMaintenance('qualify_project_retirement', { value }),
    prepareStorageRepairBatch: excludedIds => computeMaintenance('prepare_storage_repair_batch', { searchObjectIds: excludedIds }),
    prepareStorageReferenceBatch: limit => computeMaintenance('prepare_storage_reference_batch', { limit }),
    prepareStorageGcBatch: limit => computeMaintenance('prepare_storage_gc_batch', { limit }),
    prepareContentPublication: input => computeMaintenance('prepare_content_publication', { input }),
    prepareStorageColdBatch: limit => computeMaintenance('prepare_storage_cold_batch', { limit }),
    digestFile: file => computeMaintenance('digest_file', { file }),
    canonicalize: value => computeMaintenance('canonicalize', { value }),
    inspectBackup: file => computeMaintenance('inspect_backup', { file }),
    restoreBackup: input => computeMaintenance('restore_backup', input),
    prepareProjectImport: source => computeMaintenance('prepare_project_import', { source }),
    stageProjectExport: (root, ownerId) => computeMaintenance('stage_project_export', { root, ownerId }),
    cleanupProjectExportStage: (stageDirectory, limit) => computeMaintenance('cleanup_project_export_stage', { stageDirectory, limit }),
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
  { phase: publishActivity }, configuration.affinity === 'writer-actor' ? request => {
    const release = generationAdmission.getStore();
    if (!release) throw new Error('database_generation_admission_missing');
    return runDatabaseGeneration(request, release);
  } : undefined,{storageContinuations:configuration.affinity==='writer-actor',wakeStorageMaintenance:()=>port!.postMessage({storageMaintenanceWake:true})});

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
const legacyRuntimeReady = configuration.affinity === 'writer-actor'
  ? importLegacyRuntimeState(store, configuration.root) : Promise.resolve();
if (configuration.affinity === 'writer-actor') {
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
  if(action==='resume_runtime_work')throw new Error('runtime_continuation_requires_frame');
  if (action === 'read_project_registry_projection') {
    if (configuration.affinity !== 'foreground-reader') throw new Error('runtime_data_domain_mismatch:foreground-reader');
    return store.readProjectRegistry(input);
  }
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
        (source, bytes) => store.publishMigrationSource(source, bytes, { mimeType: 'application/json', encoding: 'utf8', pending: true }),
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
    case 'wait_for_migrations':
      if(input.interrupt===true){
        generationStopping=true;
        operations.interruptMigrations();
        await Promise.allSettled([...generationSnapshotWorkers,...generationComputeWorkers].map(worker=>worker.close()));
        await Promise.allSettled([...generationJobs]);
      }
      await operations.waitForMigrations(); return { settled: true };
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
  }
}

port.on('message', async (message: { id?: number; request?: RuntimeDataRequest; requestTransfer?:DataValueTransfer;serializeResult?: boolean; admission?: import('./runtimePriorityScheduler.js').RuntimeSchedulerAdmission; control?: { action: RuntimeWriteActorControl; input: Record<string, unknown> }; internalRequestId?: number; internalResult?: unknown; internalError?: string; cognitiveInvocationId?: number; cognitiveResult?: string; cognitiveError?: string; close?: boolean }) => {
  if(message.requestTransfer){try{message.request=restoreDataValueTransfer(message.requestTransfer) as RuntimeDataRequest;}catch(error){port!.postMessage({id:message.id,error:error instanceof Error?error.message:String(error)});return;}}
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
    generationStopping = true;
    for (const pending of internalWriterPending.values()) pending.reject(new Error('runtime_internal_writer_closing'));
    internalWriterPending.clear();
    if (maintenanceComputeRestartTimer) clearTimeout(maintenanceComputeRestartTimer);
    maintenanceComputeRestartTimer = undefined;
    if (maintenanceComputeWorker) {
      const worker = maintenanceComputeWorker;
      maintenanceComputeStopping = worker.terminate();
      rejectMaintenanceComputePending(new Error('maintenance_compute_closing'));
    }
    await Promise.allSettled([...generationSnapshotWorkers, ...generationComputeWorkers].map(worker => worker.close()));
    await maintenanceComputeStopping;
    await Promise.allSettled([...generationJobs]);
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
      workContinuations.clear();
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
  // Async preparation yields; business transactions finish within one synchronous segment.
  let releaseWriter = await acquireWriterGate(false);
  if (writerGenerationFenced && configuration.affinity === 'writer-actor') {
    releaseWriter();
    port.postMessage({ id, error: 'database_generation_cutover' });
    return;
  }
  if (configuration.affinity === 'writer-actor') activeWriterOperations += 1;
  try {
    port.postMessage({ activity: { id, phase: 'executing' } });
    if (message.control) {
      const result = await activityContext.run(id, () => message.control!.action==='resume_runtime_work'
        ? generationAdmission.run(()=>{const release=releaseWriter;releaseWriter=()=>{};release();},()=>{
          if(configuration.affinity!=='writer-actor' || !message.admission)throw new Error('runtime_continuation_admission_required');
          return workContinuations.resume(String(message.control!.input.token || ''),message.admission);
        }) : control(message.control!.action, message.control!.input || {}));
      postWorkResult(id,result,message.serializeResult===true,message.control.action==='resume_runtime_work' && configuration.affinity==='writer-actor');
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
    const result = configuration.affinity === 'writer-actor' && (message.request.operation === 'import_project' || message.request.operation === 'maintain_database_storage' && message.request.input.compact === true)
      ? await activityContext.run(id, () => generationAdmission.run(() => { const release = releaseWriter; releaseWriter = () => {}; release(); }, () => operations(message.request!)))
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
      if (message.request.operation !== 'append_run_log') scheduleSidebarProjection();
      if (foundationObserverSyncOperations.has(message.request.operation)) projectionWorker?.postMessage({ syncFoundations: true });
    }
    postWorkResult(id,result,message.serializeResult===true);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    port.postMessage({ id, error: detail });
  } finally {
    if (configuration.affinity === 'writer-actor') activeWriterOperations -= 1;
    releaseWriter();
  }
});

void Promise.all([maintenanceComputeReady,intelligenceReady,legacyRuntimeReady]).then(() => {
  port.postMessage({ ready: true, threadId, maintenanceThreadId: maintenanceComputeThreadId, affinity: configuration.affinity });
}).catch(error => {
  setImmediate(() => { throw error; });
});
