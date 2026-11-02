import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import * as fs from 'fs';
import { Worker } from 'worker_threads';

import type { RuntimeDataRequest } from './autonomousRuntimeControl';
import type { RuntimeDataOperations } from './runtimeDataOperations';
import { runtimeOperationDefinition, RuntimeExecutorAffinity, type RuntimeExecutionDomain } from './runtimeOperationRegistry';
import { RuntimeExecutionScheduler, type RuntimeSchedulerAdmission } from './runtimePriorityScheduler';
import { CognitiveCliProcessExecutor } from './cognitiveCliProcessExecutor';
import type { CognitiveCliInvocation } from './localAgentCliEngine';
import type { ProjectRegistrySnapshot } from './projectRegistry';

type WorkerAffinity = Extract<RuntimeExecutorAffinity, 'writer-actor' | 'foreground-reader' | 'interactive-reader' | 'background-reader' | 'external-worker' | 'git-worker' | 'network-worker'>;
type ExternalWorkerRole = 'intelligence' | 'conversation';
const writerUserDomains = new Set<RuntimeExecutionDomain>([
  'control-query', 'foreground-command', 'foreground-query', 'interactive-query', 'subscription-event', 'runtime-event'
]);
const writerDomainPriority: readonly RuntimeExecutionDomain[] = [
  'control-query', 'foreground-command', 'foreground-query', 'interactive-query', 'subscription-event', 'runtime-event',
  'background-command', 'external-job', 'git-job', 'network-job', 'background-query', 'maintenance'
];

interface DomainWorkerResponse {
  id?: number;
  internalRequestId?: number;
  internalParentId?: number;
  internalRequest?: RuntimeDataRequest;
  internalResult?: unknown;
  internalError?: string;
  ready?: boolean;
  closed?: boolean;
  threadId?: number;
  maintenanceThreadId?: number;
  result?: unknown;
  serializedResult?: string;
  error?: string;
  activity?: { id: number; phase: string };
  cognitiveChild?: { active: boolean; pid: number; processStartIdentity?: string };
  cognitiveInvocationId?: number;
  cognitiveInvocation?: CognitiveCliInvocation;
  cognitiveCancelId?: number;
  projectionEvent?: { projectPaths: string[] };
  controlProjectionEvent?: { projectRegistry: ProjectRegistrySnapshot };
}

type QueuedWorkerWork = {
  id: number;
  queuedAt: number;
  resolve(value: unknown): void;
  reject(error: unknown): void;
} & ({ kind: 'request'; request: RuntimeDataRequest; serializeResult: boolean; admission?: RuntimeSchedulerAdmission }
  | { kind: 'control'; control: { action: RuntimeWriteActorControl; input: Record<string, unknown> }; admission?: RuntimeSchedulerAdmission });

export interface RuntimeExecutorActivity {
  id: number;
  kind: 'request' | 'control';
  label: string;
  phase: string;
  postedAt: number;
  startedAt?: number;
  phaseAt: number;
  ageMs: number;
  phaseAgeMs: number;
}

export type RuntimeExecutorActivitySnapshot = Record<WorkerAffinity, {
  threadId: number;
  threadIds?: number[];
  queued: RuntimeExecutorActivity[];
  active: RuntimeExecutorActivity[];
}>;

export interface RuntimeWriteActorConfiguration {
  runtimeId: string;
  releaseVersion: string;
  buildId: string;
}

export type RuntimeWriteActorControl =
  | 'import_legacy_diagnostics'
  | 'recover_migrations'
  | 'recover_runs'
  | 'initialize_intelligence'
  | 'recover_intelligence'
  | 'drain_intelligence'
  | 'resume_intelligence'
  | 'cancel_intelligence_operation'
  | 'recover_outbox'
  | 'wait_for_migrations'
  | 'quiesce_for_database_generation'
  | 'interrupt'
  | 'storage_maintenance_ready'
  | 'storage_maintenance_failed'
  | 'settle_redundant_upgrade_migrations'
  | 'enqueue_startup_migrations'
  | 'backfill_report_versions'
  | 'reap_finished_legacy_runs'
  | 'maintain_planner_statistics'
  | 'restart_sidebar_projection'
  | 'record_compatibility_drain'
  | 'read_project_registry_projection'
  | 'drain_documentation_projections';

class RuntimeDomainWorker {
  private worker: Worker | undefined;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: unknown): void;
    kind: 'request' | 'control';
    label: string;
    phase: string;
    postedAt: number;
    startedAt?: number;
    phaseAt: number;
    admission?: RuntimeSchedulerAdmission;
  }>();
  private sequence = 0;
  private readyThreadId = 0;
  private maintenanceThreadId = 0;
  private readyPromise!: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: unknown) => void;
  private closePromise: Promise<void> | undefined;
  private resolveClosed: (() => void) | undefined;
  private exited = false;
  private closing = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private terminalError: Error | undefined;
  private fatalReported = false;
  private readonly requestConcurrency: number;
  private activeRequests = 0;
  private activeAuxiliaryRequests = 0;
  private readonly requestQueue: QueuedWorkerWork[] = [];
  private readonly ownedChildren = new Map<number, string | undefined>();
  private cognitiveExecutor: CognitiveCliProcessExecutor | undefined;
  private workerStarts = 0;

  constructor(
    private readonly root: string,
    private readonly databaseId: string,
    readonly affinity: WorkerAffinity,
    private readonly readAuthoritySecret: string,
    private readonly runtime?: RuntimeWriteActorConfiguration,
    private readonly onFatal?: (error: Error) => void,
    private readonly onInternalRequest?: (request: RuntimeDataRequest, admission?: RuntimeSchedulerAdmission) => Promise<unknown>,
    private readonly onWorkerExit?: (ownerId: string) => Promise<unknown>,
    private readonly externalRole?: ExternalWorkerRole,
    private readonly onProjectionEvent?: (projectPaths: string[]) => void,
    private readonly onControlProjectionEvent?: (snapshot: ProjectRegistrySnapshot) => void
  ) {
    // SQLite calls remain synchronous on this single Writer thread. A bounded
    // cooperative queue lets requests that are awaiting Git/file/network work
    // yield without admitting concurrent database execution.
    this.requestConcurrency = affinity === 'writer-actor' ? 8 : affinity === 'git-worker' ? 1 : affinity === 'network-worker' ? 2
      : affinity === 'external-worker' ? externalRole === 'conversation' ? 2 : 16 : Number.MAX_SAFE_INTEGER;
    this.startWorker();
  }

  private startWorker(): void {
    this.exited = false;
    this.readyPromise = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    if (this.affinity === 'external-worker' && this.externalRole !== 'conversation') this.cognitiveExecutor = new CognitiveCliProcessExecutor();
    const workerOwnerId = this.affinity === 'external-worker' && this.externalRole === 'conversation' && this.runtime
      ? `${this.runtime.runtimeId}:conversation:${crypto.randomUUID()}`
      : `${this.affinity}:${crypto.randomUUID()}`;
    const recoverIntelligence = this.workerStarts++ > 0
      && this.affinity === 'external-worker' && this.externalRole !== 'conversation';
    const worker = new Worker(path.join(__dirname, 'runtimeDataDomainWorker.js'), {
      workerData: { root: this.root, databaseId: this.databaseId, affinity: this.affinity, externalRole: this.externalRole,
        runtime: this.runtime, readAuthoritySecret: this.readAuthoritySecret, recoverIntelligence }
    });
    this.worker = worker;
    worker.on('message', (message: DomainWorkerResponse) => {
      if (this.worker === worker) this.onMessage(message, workerOwnerId);
    });
    worker.once('error', error => {
      if (this.worker === worker) {
        this.fail(error);
        this.reportFatal(error);
      }
    });
    worker.once('exit', code => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.exited = true;
      const exitError = new Error(`runtime_data_domain_exited:${this.affinity}:${code}`);
      this.fail(exitError);
      this.reportFatal(exitError);
      const cognitiveClosed = this.cognitiveExecutor?.close() || Promise.resolve();
      this.cognitiveExecutor = undefined;
      const releaseWorkerState = async (): Promise<void> => {
        if (!this.onWorkerExit) return;
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try { await this.onWorkerExit(workerOwnerId); return; }
          catch (error) {
            lastError = error;
            if (this.closing) throw error;
            await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
          }
        }
        throw lastError;
      };
      void Promise.all([cognitiveClosed, this.terminateOwnedChildren(), releaseWorkerState()]).then(() => {
        if (this.closing || ['writer-actor', 'git-worker'].includes(this.affinity)) {
          this.resolveClosed?.();
          return;
        }
        this.restartTimer = setTimeout(() => {
          this.restartTimer = undefined;
          if (!this.closing) this.startWorker();
        }, 50);
        this.restartTimer.unref();
      }, error => {
        const cleanupError = error instanceof Error ? error : new Error(String(error));
        this.terminalError = cleanupError;
        this.fail(cleanupError);
        this.onFatal?.(cleanupError);
        this.resolveClosed?.();
      });
    });
  }

  private onMessage(message: DomainWorkerResponse, workerOwnerId: string): void {
    if (message.projectionEvent) {
      this.onProjectionEvent?.(message.projectionEvent.projectPaths.map(String));
      return;
    }
    if (message.controlProjectionEvent) {
      this.onControlProjectionEvent?.(message.controlProjectionEvent.projectRegistry);
      return;
    }
    if (message.cognitiveCancelId !== undefined) {
      this.cognitiveExecutor?.cancel(message.cognitiveCancelId);
      return;
    }
    if (message.cognitiveInvocationId !== undefined && message.cognitiveInvocation) {
      const worker = this.worker;
      const executor = this.cognitiveExecutor;
      if (!worker || !executor) {
        worker?.postMessage({ cognitiveInvocationId: message.cognitiveInvocationId, cognitiveError: 'cognitive_cli_supervisor_unavailable' });
        return;
      }
      void executor.execute(message.cognitiveInvocationId, message.cognitiveInvocation).then(
        result => { if (this.worker === worker) worker.postMessage({ cognitiveInvocationId: message.cognitiveInvocationId, cognitiveResult: result }); },
        error => { if (this.worker === worker) worker.postMessage({ cognitiveInvocationId: message.cognitiveInvocationId, cognitiveError: error instanceof Error ? error.message : String(error) }); }
      );
      return;
    }
    if (message.cognitiveChild && Number.isSafeInteger(message.cognitiveChild.pid)) {
      if (message.cognitiveChild.active) this.ownedChildren.set(message.cognitiveChild.pid, message.cognitiveChild.processStartIdentity);
      else this.ownedChildren.delete(message.cognitiveChild.pid);
      return;
    }
    if (message.internalRequestId !== undefined && message.internalRequest) {
      const worker = this.worker;
      if (!worker || !this.onInternalRequest) {
        worker?.postMessage({ internalRequestId: message.internalRequestId, internalError: 'runtime_internal_writer_unavailable' });
        return;
      }
      const admission = this.pending.get(Number(message.internalParentId))?.admission;
      const request = message.internalRequest.operation === 'prepare_conversation_launch'
        ? { ...message.internalRequest, input: { ...message.internalRequest.input, dispatchOwnerId: workerOwnerId } }
        : message.internalRequest;
      void this.onInternalRequest(request, admission).then(
        result => { if (this.worker === worker) worker.postMessage({ internalRequestId: message.internalRequestId, internalResult: result }); },
        error => { if (this.worker === worker) worker.postMessage({ internalRequestId: message.internalRequestId, internalError: error instanceof Error ? error.message : String(error) }); }
      );
      return;
    }
    if (message.ready) {
      this.readyThreadId = Number(message.threadId);
      this.maintenanceThreadId = Number(message.maintenanceThreadId || 0);
      this.resolveReady();
      return;
    }
    if (message.closed) {
      const worker = this.worker;
      if (!worker) this.resolveClosed?.();
      else void worker.terminate().then(() => this.resolveClosed?.(), () => this.resolveClosed?.());
      return;
    }
    if (message.activity) {
      const pending = this.pending.get(message.activity.id);
      if (pending) {
        pending.phase = message.activity.phase;
        pending.phaseAt = Date.now();
        if (!pending.startedAt) pending.startedAt = Date.now();
      }
      return;
    }
    const pending = this.pending.get(Number(message.id));
    if (!pending) return;
    this.pending.delete(Number(message.id));
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.serializedResult !== undefined ? message.serializedResult : message.result);
  }

  private fail(error: unknown): void {
    this.rejectReady(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const request of this.requestQueue.splice(0)) request.reject(error);
  }

  private childIdentityMatches(pid: number, expected: string | undefined): boolean {
    if (process.platform !== 'linux' || !expected) return true;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return String(fields[19] || '') === expected;
    } catch { return false; }
  }

  private childAlive(pid: number, expected: string | undefined): boolean {
    if (!this.childIdentityMatches(pid, expected)) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  }

  private async terminateOwnedChildren(): Promise<void> {
    const signal = (name: NodeJS.Signals) => {
      for (const [pid, identity] of this.ownedChildren) {
        if (!this.childAlive(pid, identity)) { this.ownedChildren.delete(pid); continue; }
        try { process.kill(pid, name); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    };
    signal('SIGTERM');
    const gracefulDeadline = Date.now() + 2_000;
    while ([...this.ownedChildren].some(([pid, identity]) => this.childAlive(pid, identity)) && Date.now() < gracefulDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    signal('SIGKILL');
    const reapDeadline = Date.now() + 1_000;
    while ([...this.ownedChildren].some(([pid, identity]) => this.childAlive(pid, identity)) && Date.now() < reapDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    this.ownedChildren.clear();
  }

  private reportFatal(error: Error): void {
    if (!['writer-actor', 'git-worker'].includes(this.affinity) || this.closing || this.fatalReported) return;
    this.fatalReported = true;
    this.terminalError = error;
    this.onFatal?.(error);
  }

  async ready(): Promise<void> {
    if (this.terminalError) throw this.terminalError;
    await this.readyPromise;
    if (this.terminalError) throw this.terminalError;
  }
  threadId(): number { return this.readyThreadId; }
  childMaintenanceThreadId(): number { return this.maintenanceThreadId; }
  load(): number { return this.pending.size + this.requestQueue.length + this.activeRequests; }

  activitySnapshot(now = Date.now()): RuntimeExecutorActivitySnapshot[WorkerAffinity] {
    const map = (item: {
      id: number;
      kind: 'request' | 'control';
      label: string;
      phase: string;
      postedAt: number;
      startedAt?: number;
      phaseAt: number;
    }): RuntimeExecutorActivity => ({ ...item, ageMs: Math.max(0, now - item.postedAt), phaseAgeMs: Math.max(0, now - item.phaseAt) });
    return {
      threadId: this.readyThreadId,
      queued: this.requestQueue.map(item => map({
        id: item.id, kind: item.kind, label: item.kind === 'request' ? item.request.operation : item.control.action,
        phase: 'queued', postedAt: item.queuedAt, phaseAt: item.queuedAt
      })),
      active: [...this.pending.entries()].map(([id, item]) => map({ id, kind: item.kind, label: item.label,
        phase: item.phase, postedAt: item.postedAt, phaseAt: item.phaseAt, ...(item.startedAt ? { startedAt: item.startedAt } : {}) }))
    };
  }

  async request(request: RuntimeDataRequest, serializeResult = false, admission?: RuntimeSchedulerAdmission): Promise<unknown> {
    await this.ready();
    const id = ++this.sequence;
    if (this.requestConcurrency !== Number.MAX_SAFE_INTEGER) {
      return new Promise((resolve, reject) => {
        this.requestQueue.push({ kind: 'request', id, request, serializeResult, admission, queuedAt: Date.now(), resolve, reject });
        this.pumpRequestQueue();
      });
    }
    return this.performRequest(id, request, serializeResult, admission);
  }

  private pumpRequestQueue(): void {
    while (this.activeRequests < this.requestConcurrency && this.requestQueue.length) {
      const queuedIndex = this.nextQueuedWorkIndex();
      if (queuedIndex < 0) return;
      const [queued] = this.requestQueue.splice(queuedIndex, 1);
      const auxiliary = this.isAuxiliaryWriterWork(queued);
      this.activeRequests += 1;
      if (auxiliary) this.activeAuxiliaryRequests += 1;
      const work = queued.kind === 'request'
        ? this.performRequest(queued.id, queued.request, queued.serializeResult, queued.admission)
        : this.performControl(queued.id, queued.control, queued.admission);
      void work.then(queued.resolve, queued.reject).finally(() => {
        this.activeRequests -= 1;
        if (auxiliary) this.activeAuxiliaryRequests -= 1;
        this.pumpRequestQueue();
      });
    }
  }

  private isAuxiliaryWriterWork(work: QueuedWorkerWork): boolean {
    if (this.affinity !== 'writer-actor' || !work.admission) return false;
    return !writerUserDomains.has(work.admission.domain);
  }

  private nextQueuedWorkIndex(): number {
    if (this.affinity !== 'writer-actor') return 0;
    let selected = -1;
    let selectedPriority = Number.MAX_SAFE_INTEGER;
    for (let index = 0; index < this.requestQueue.length; index += 1) {
      const work = this.requestQueue[index];
      if (this.isAuxiliaryWriterWork(work) && this.activeAuxiliaryRequests >= 6) continue;
      const rank = work.admission ? writerDomainPriority.indexOf(work.admission.domain) : 0;
      const effectiveRank = rank < 0 ? writerDomainPriority.length : rank;
      if (effectiveRank < selectedPriority) { selected = index; selectedPriority = effectiveRank; }
    }
    return selected;
  }

  private async performRequest(id: number, request: RuntimeDataRequest, serializeResult: boolean, admission?: RuntimeSchedulerAdmission): Promise<unknown> {
    await this.ready();
    const worker = this.worker;
    if (!worker) throw this.terminalError || new Error(`runtime_data_domain_unavailable:${this.affinity}`);
    return new Promise((resolve, reject) => {
      const postedAt = Date.now();
      this.pending.set(id, { resolve, reject, kind: 'request', label: request.operation, phase: 'posted', postedAt, phaseAt: postedAt, admission });
      try { worker.postMessage({ id, request, serializeResult }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  async control(action: RuntimeWriteActorControl, input: Record<string, unknown> = {}, admission?: RuntimeSchedulerAdmission): Promise<unknown> {
    await this.ready();
    const id = ++this.sequence;
    // Writer lifecycle controls must remain admissible even when every
    // cooperative request slot is awaiting an external child job. They still
    // execute on the one Writer thread, so SQLite authority remains singular.
    if (this.affinity === 'writer-actor'
      || (this.affinity === 'external-worker' && (action === 'cancel_intelligence_operation' || action === 'drain_intelligence' || action === 'resume_intelligence'))) {
      return this.performControl(id, { action, input }, admission);
    }
    if (this.requestConcurrency !== Number.MAX_SAFE_INTEGER) {
      return new Promise((resolve, reject) => {
        this.requestQueue.push({ kind: 'control', id, control: { action, input }, admission, queuedAt: Date.now(), resolve, reject });
        this.pumpRequestQueue();
      });
    }
    return this.performControl(id, { action, input }, admission);
  }

  private async performControl(id: number, control: { action: RuntimeWriteActorControl; input: Record<string, unknown> }, admission?: RuntimeSchedulerAdmission): Promise<unknown> {
    await this.ready();
    const worker = this.worker;
    if (!worker) throw this.terminalError || new Error(`runtime_data_domain_unavailable:${this.affinity}`);
    return new Promise((resolve, reject) => {
      const postedAt = Date.now();
      this.pending.set(id, { resolve, reject, kind: 'control', label: control.action, phase: 'posted', postedAt, phaseAt: postedAt, admission });
      try { worker.postMessage({ id, control }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = new Promise<void>(resolve => {
      this.closing = true;
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
      if (this.exited || !this.worker) { resolve(); return; }
      let settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(deadline); resolve(); };
      this.resolveClosed = finish;
      const deadline = setTimeout(() => {
        const worker = this.worker;
        if (!worker) { finish(); return; }
        void Promise.allSettled([this.terminateOwnedChildren(), worker.terminate()]).then(finish);
      }, 5_000);
      deadline.unref();
      try { this.worker.postMessage({ close: true }); }
      catch { void this.worker.terminate().then(finish, finish); }
    });
    return this.closePromise;
  }
}

class RuntimeDomainWorkerPool {
  private readonly assigned: number[];
  private tieBreaker = 0;

  constructor(private readonly workers: RuntimeDomainWorker[]) {
    if (!workers.length) throw new Error('runtime_reader_pool_empty');
    this.assigned = workers.map(() => 0);
  }

  async ready(): Promise<void> { await Promise.all(this.workers.map(worker => worker.ready())); }

  request(request: RuntimeDataRequest, serializeResult = false, admission?: RuntimeSchedulerAdmission): Promise<unknown> {
    const start = this.tieBreaker++ % this.workers.length;
    let selected = start;
    let selectedLoad = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < this.workers.length; offset += 1) {
      const index = (start + offset) % this.workers.length;
      const load = this.workers[index].load() + this.assigned[index];
      if (load < selectedLoad) { selected = index; selectedLoad = load; }
    }
    this.assigned[selected] += 1;
    return this.workers[selected].request(request, serializeResult, admission).finally(() => { this.assigned[selected] -= 1; });
  }

  activitySnapshot(now = Date.now()): RuntimeExecutorActivitySnapshot[WorkerAffinity] {
    const snapshots = this.workers.map(worker => worker.activitySnapshot(now));
    const remap = (items: RuntimeExecutorActivity[], workerIndex: number) => items.map(item => ({
      ...item,
      id: (workerIndex + 1) * 1_000_000 + item.id
    }));
    return {
      threadId: snapshots[0].threadId,
      threadIds: snapshots.map(snapshot => snapshot.threadId),
      queued: snapshots.flatMap((snapshot, index) => remap(snapshot.queued, index)),
      active: snapshots.flatMap((snapshot, index) => remap(snapshot.active, index))
    };
  }

  threadIds(): number[] { return this.workers.map(worker => worker.threadId()); }
  async close(): Promise<void> { await Promise.all(this.workers.map(worker => worker.close())); }
}

interface ProjectionSubscriptionWaiter {
  resolve(value: { revision: number; projectPaths: string[] }): void;
  timer: NodeJS.Timeout;
}

class RuntimeProjectionSubscriptionBroker {
  private revision = 0;
  private closed = false;
  private readonly waiters = new Set<ProjectionSubscriptionWaiter>();

  publish(projectPaths: string[]): void {
    if (this.closed) return;
    this.revision += 1;
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve({ revision: this.revision, projectPaths });
    }
  }

  wait(afterRevision: number): Promise<{ revision: number; projectPaths: string[] }> {
    if (this.closed || afterRevision !== this.revision) {
      return Promise.resolve({ revision: this.revision, projectPaths: [] });
    }
    return new Promise(resolve => {
      const waiter: ProjectionSubscriptionWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve({ revision: this.revision, projectPaths: [] });
        }, 30_000)
      };
      waiter.timer.unref();
      this.waiters.add(waiter);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve({ revision: this.revision, projectPaths: [] });
    }
  }
}

export class RuntimeDataExecutionDomains {
  readonly operations: RuntimeDataOperations;

  private constructor(
    private readonly writer: RuntimeDomainWorker,
    private readonly controlReader: RuntimeDomainWorker,
    private readonly foreground: RuntimeDomainWorkerPool,
    private readonly interactive: RuntimeDomainWorkerPool,
    private readonly background: RuntimeDomainWorkerPool,
    private readonly intelligence: RuntimeDomainWorker,
    private readonly conversation: RuntimeDomainWorker,
    private readonly foregroundGit: RuntimeDomainWorker,
    private readonly git: RuntimeDomainWorker,
    private readonly network: RuntimeDomainWorker,
    private readonly fatalFailure: Promise<never>,
    private readonly projectionSubscriptions: RuntimeProjectionSubscriptionBroker
  ) {
    this.operations = Object.assign(
      (request: RuntimeDataRequest) => this.dispatch(request),
      {
        setStorageMaintenanceBarrier: () => { throw new Error('runtime_write_actor_owns_storage_barrier'); },
        recoverMigrations: () => { void this.control('recover_migrations'); },
        recoverRuns: () => { void this.control('recover_runs'); },
        interruptMigrations: () => { void this.control('interrupt'); },
        interruptRuns: () => { void this.control('interrupt'); },
        waitForMigrations: () => this.control('wait_for_migrations').then(() => undefined),
        quiesceForDatabaseGeneration: () => this.control('quiesce_for_database_generation').then(() => undefined),
        close: () => this.close(),
        setIntelligenceRuntime: () => { throw new Error('runtime_external_worker_owns_intelligence_runtime'); }
      }
    );
  }

  static async start(options: {
    root: string;
    databaseId: string;
    runtime?: RuntimeWriteActorConfiguration;
    scheduler?: RuntimeExecutionScheduler;
    dispatchSupervisorOperation?: (request: RuntimeDataRequest) => Promise<unknown>;
    onProjectRegistryProjection?: (snapshot: ProjectRegistrySnapshot) => void;
  }): Promise<RuntimeDataExecutionDomains> {
    let rejectFatal!: (error: Error) => void;
    const fatalFailure = new Promise<never>((_resolve, reject) => { rejectFatal = reject; });
    void fatalFailure.catch(() => undefined);
    const readAuthoritySecret = crypto.randomBytes(32).toString('base64url');
    const parallelism = Math.max(1, os.cpus().length);
    const foregroundReaderCount = Math.max(1, Math.min(2, Math.floor(parallelism / 2)));
    const interactiveReaderCount = Math.max(1, Math.min(2, parallelism - foregroundReaderCount));
    const backgroundReaderCount = 1;
    const projectionSubscriptions = new RuntimeProjectionSubscriptionBroker();
    let routeInternal!: (request: RuntimeDataRequest, admission?: RuntimeSchedulerAdmission) => Promise<unknown>;
    const writer = new RuntimeDomainWorker(options.root, options.databaseId, 'writer-actor', readAuthoritySecret, options.runtime, rejectFatal,
      (request, admission) => routeInternal(request, admission), undefined, undefined,
      projectPaths => projectionSubscriptions.publish(projectPaths), options.onProjectRegistryProjection);
    const controlReader = new RuntimeDomainWorker(options.root, options.databaseId, 'foreground-reader', readAuthoritySecret);
    const foregroundWorkers = Array.from({ length: foregroundReaderCount }, () => new RuntimeDomainWorker(options.root, options.databaseId, 'foreground-reader', readAuthoritySecret));
    const interactiveWorkers = Array.from({ length: interactiveReaderCount }, () => new RuntimeDomainWorker(options.root, options.databaseId, 'interactive-reader', readAuthoritySecret));
    const backgroundWorkers = Array.from({ length: backgroundReaderCount }, () => new RuntimeDomainWorker(options.root, options.databaseId, 'background-reader', readAuthoritySecret));
    const foreground = new RuntimeDomainWorkerPool(foregroundWorkers);
    const interactive = new RuntimeDomainWorkerPool(interactiveWorkers);
    const background = new RuntimeDomainWorkerPool(backgroundWorkers);
    const foregroundGit = new RuntimeDomainWorker(options.root, options.databaseId, 'git-worker', readAuthoritySecret, undefined, rejectFatal);
    const git = new RuntimeDomainWorker(options.root, options.databaseId, 'git-worker', readAuthoritySecret, undefined, rejectFatal);
    const scheduler = options.scheduler || new RuntimeExecutionScheduler();
    const scheduleInternal = (request: RuntimeDataRequest, action: () => Promise<unknown>, admission?: RuntimeSchedulerAdmission): Promise<unknown> => {
      const definition = runtimeOperationDefinition(request.operation);
      const options = {
        deadlineAt: request.deadlineAt,
        supersedesKey: request.supersedesKey,
        label: `internal-worker:${request.operation}`
      };
      return admission ? scheduler.submitChild(admission, action, options) : scheduler.submit(definition.domain, action, options);
    };
    const network = new RuntimeDomainWorker(options.root, options.databaseId, 'network-worker', readAuthoritySecret, undefined, undefined,
      (request, admission) => scheduleInternal(request, () => {
        const executor = runtimeOperationDefinition(request.operation).executor;
        if (executor === 'supervisor' && options.dispatchSupervisorOperation) return options.dispatchSupervisorOperation(request);
        if (executor === 'foreground-reader') return (runtimeOperationDefinition(request.operation).domain === 'control-query' ? controlReader : foreground).request(request, false, admission);
        if (executor === 'interactive-reader') return interactive.request(request, false, admission);
        if (executor === 'background-reader') return background.request(request, false, admission);
        if (executor === 'writer-actor' || executor === 'maintenance-worker') return writer.request(request, false, admission);
        throw new Error(`runtime_internal_operation_unavailable:${request.operation}:${executor}`);
      }, admission));
    let conversation!: RuntimeDomainWorker;
    routeInternal = (request: RuntimeDataRequest, admission?: RuntimeSchedulerAdmission): Promise<unknown> => scheduleInternal(request, () => {
      const executor = runtimeOperationDefinition(request.operation).executor;
      if (executor === 'supervisor' && options.dispatchSupervisorOperation) return options.dispatchSupervisorOperation(request);
      if (executor === 'foreground-reader') return (runtimeOperationDefinition(request.operation).domain === 'control-query' ? controlReader : foreground).request(request, false, admission);
      if (executor === 'interactive-reader') return interactive.request(request, false, admission);
      if (executor === 'background-reader') return background.request(request, false, admission);
      if (executor === 'git-worker') {
        const foregroundLane = request.operation === 'capture_pre_session_git_snapshot'
          || Boolean(admission && writerUserDomains.has(admission.domain));
        return (foregroundLane ? foregroundGit : git).request(request, false, admission);
      }
      if (executor === 'network-worker') return network.request(request, false, admission);
      if (executor === 'external-worker' && request.operation === 'start_conversation') {
        if (!conversation) throw new Error('runtime_conversation_worker_not_ready');
        return conversation.request(request, false, admission);
      }
      if (executor === 'writer-actor' || executor === 'maintenance-worker') return writer.request(request, false, admission);
      throw new Error(`runtime_internal_operation_unavailable:${request.operation}:${executor}`);
    }, admission);
    const intelligence = new RuntimeDomainWorker(options.root, options.databaseId, 'external-worker', readAuthoritySecret, options.runtime, undefined, routeInternal,
      undefined, 'intelligence');
    conversation = new RuntimeDomainWorker(options.root, options.databaseId, 'external-worker', readAuthoritySecret, options.runtime, rejectFatal, routeInternal,
      ownerId => writer.request({ operation: 'abandon_conversation_dispatches', input: { ownerId } }), 'conversation');
    const workers = [writer, controlReader, ...foregroundWorkers, ...interactiveWorkers, ...backgroundWorkers, intelligence, conversation, foregroundGit, git, network];
    try {
      await Promise.all(workers.map(worker => worker.ready()));
      if (options.runtime) await writer.request({ operation: 'abandon_conversation_dispatches', input: {
        ownerPrefix: `${options.runtime.runtimeId}:conversation:`
      } });
    }
    catch (error) {
      await Promise.allSettled(workers.map(worker => worker.close()));
      throw error;
    }
    return new RuntimeDataExecutionDomains(writer, controlReader, foreground, interactive, background, intelligence, conversation, foregroundGit, git, network, fatalFailure,
      projectionSubscriptions);
  }

  waitForFatalFailure(): Promise<never> { return this.fatalFailure; }

  activitySnapshot(): RuntimeExecutorActivitySnapshot {
    const now = Date.now();
    return {
      'writer-actor': this.writer.activitySnapshot(now),
      'foreground-reader': (() => {
        const control = this.controlReader.activitySnapshot(now);
        const foreground = this.foreground.activitySnapshot(now);
        return {
          threadId: control.threadId,
          threadIds: [control.threadId, ...(foreground.threadIds || [foreground.threadId])],
          queued: [...control.queued, ...foreground.queued.map(item => ({ ...item, id: item.id + 1_000_000 }))],
          active: [...control.active, ...foreground.active.map(item => ({ ...item, id: item.id + 1_000_000 }))]
        };
      })(),
      'interactive-reader': this.interactive.activitySnapshot(now),
      'background-reader': this.background.activitySnapshot(now),
      'external-worker': (() => {
        const intelligence = this.intelligence.activitySnapshot(now);
        const conversation = this.conversation.activitySnapshot(now);
        return {
          threadId: intelligence.threadId,
          threadIds: [intelligence.threadId, conversation.threadId],
          queued: [...intelligence.queued, ...conversation.queued.map(item => ({ ...item, id: item.id + 1_000_000 }))],
          active: [...intelligence.active, ...conversation.active.map(item => ({ ...item, id: item.id + 1_000_000 }))]
        };
      })(),
      'git-worker': (() => {
        const foreground = this.foregroundGit.activitySnapshot(now);
        const background = this.git.activitySnapshot(now);
        return {
          threadId: foreground.threadId,
          threadIds: [foreground.threadId, background.threadId],
          queued: [...foreground.queued, ...background.queued.map(item => ({ ...item, id: item.id + 1_000_000 }))],
          active: [...foreground.active, ...background.active.map(item => ({ ...item, id: item.id + 1_000_000 }))]
        };
      })(),
      'network-worker': this.network.activitySnapshot(now)
    };
  }

  control(action: RuntimeWriteActorControl, input: Record<string, unknown> = {}, admission?: RuntimeSchedulerAdmission): Promise<unknown> {
    if (action === 'initialize_intelligence' || action === 'recover_intelligence' || action === 'cancel_intelligence_operation' || action === 'drain_intelligence' || action === 'resume_intelligence') {
      return this.intelligence.control(action, input, admission);
    }
    return this.writer.control(action, input, admission);
  }

  dispatch(request: RuntimeDataRequest): Promise<unknown> {
    return this.dispatchThroughWorker(request, false);
  }

  dispatchSerialized(request: RuntimeDataRequest, admission?: RuntimeSchedulerAdmission): Promise<string> {
    return this.dispatchThroughWorker(request, true, admission) as Promise<string>;
  }

  private dispatchThroughWorker(request: RuntimeDataRequest, serializeResult: boolean, admission?: RuntimeSchedulerAdmission): Promise<unknown> {
    const definition = runtimeOperationDefinition(request.operation);
    if (definition.executor === 'supervisor') {
      if (request.operation !== 'wait_sidebar_core_projection_revision') {
        throw new Error(`runtime_supervisor_operation_unavailable:${request.operation}`);
      }
      const result = this.projectionSubscriptions.wait(Number(request.input.afterRevision || 0));
      return serializeResult ? result.then(value => JSON.stringify(value)) : result;
    }
    const delegatedRead = definition.kind === 'query' && Boolean(request.readAuthority)
      && ['foreground-reader', 'interactive-reader', 'background-reader'].includes(definition.executor);
    // Mutations keep the Writer-owned live session. Queries carry a signed,
    // Runtime-epoch-bound authority and are revalidated against the read DB.
    if ((request.sessionToken || request.piToolFence) && !delegatedRead && definition.executor !== 'external-worker') return this.writer.request(request, serializeResult, admission);
    if (definition.executor === 'foreground-reader') {
      const reader = definition.domain === 'control-query' ? this.controlReader : this.foreground;
      return reader.request(request, serializeResult, admission).catch(error => {
        const detail = error instanceof Error ? error.message : String(error);
        if (request.operation === 'read_run_state' && /(?:^|:\s*)run_missing$/.test(detail)) return this.writer.request(request, serializeResult, admission);
        throw error;
      });
    }
    if (definition.executor === 'interactive-reader') {
      return this.interactive.request(request, serializeResult, admission).catch(error => {
        const detail = error instanceof Error ? error.message : String(error);
        // A newly committed run may briefly be absent from an already-open WAL
        // reader. Preserve read-after-write semantics with one authoritative,
        // still read-only retry through the writer connection.
        if (request.operation === 'read_run_state' && /(?:^|:\s*)run_missing$/.test(detail)) return this.writer.request(request, serializeResult, admission);
        throw error;
      });
    }
    if (definition.executor === 'background-reader') return this.background.request(request, serializeResult, admission);
    if (definition.executor === 'external-worker') {
      if (request.operation === 'cancel_intelligence_operation') {
        return this.intelligence.control('cancel_intelligence_operation', request.input, admission);
      }
      if (request.operation === 'start_conversation') return this.conversation.request(request, serializeResult, admission);
      return this.intelligence.request(request, serializeResult, admission);
    }
    if (definition.executor === 'git-worker') {
      const foregroundLane = request.operation === 'capture_pre_session_git_snapshot'
        || Boolean(admission && writerUserDomains.has(admission.domain));
      return (foregroundLane ? this.foregroundGit : this.git)
        .request(request, serializeResult, admission);
    }
    if (definition.executor === 'network-worker') return this.network.request(request, serializeResult, admission);
    if (definition.executor === 'maintenance-worker') return this.writer.request(request, serializeResult, admission);
    return this.writer.request(request, serializeResult, admission);
  }

  topology(): {
    writerActor: { threadId: number; readOnly: false };
    controlQuery: { threadId: number; readOnly: true; concurrency: 1 };
    foregroundQuery: { threadIds: number[]; readOnly: true; concurrency: number };
    interactiveQuery: { threadIds: number[]; readOnly: true; concurrency: number };
    backgroundQuery: { threadIds: number[]; readOnly: true; concurrency: number };
    gitJob: { threadId: number; readOnly: true; concurrency: 1 };
    foregroundGitCommand: { threadId: number; readOnly: true; concurrency: 1 };
    networkJob: { threadId: number; readOnly: true; concurrency: 2 };
    intelligenceJob: { threadId: number; readOnly: true; concurrency: 2 };
    conversationJob: { threadId: number; readOnly: true; concurrency: 2 };
    maintenanceJob: { threadId: number; readOnly: true };
    maintenanceCommit: { threadId: number; readOnly: false };
  } {
    return {
      writerActor: { threadId: this.writer.threadId(), readOnly: false },
      controlQuery: { threadId: this.controlReader.threadId(), readOnly: true, concurrency: 1 },
      foregroundQuery: { threadIds: this.foreground.threadIds(), readOnly: true, concurrency: this.foreground.threadIds().length },
      interactiveQuery: { threadIds: this.interactive.threadIds(), readOnly: true, concurrency: this.interactive.threadIds().length },
      backgroundQuery: { threadIds: this.background.threadIds(), readOnly: true, concurrency: this.background.threadIds().length },
      gitJob: { threadId: this.git.threadId(), readOnly: true, concurrency: 1 },
      foregroundGitCommand: { threadId: this.foregroundGit.threadId(), readOnly: true, concurrency: 1 },
      networkJob: { threadId: this.network.threadId(), readOnly: true, concurrency: 2 },
      intelligenceJob: { threadId: this.intelligence.threadId(), readOnly: true, concurrency: 2 },
      conversationJob: { threadId: this.conversation.threadId(), readOnly: true, concurrency: 2 },
      maintenanceJob: { threadId: this.writer.childMaintenanceThreadId(), readOnly: true },
      maintenanceCommit: { threadId: this.writer.threadId(), readOnly: false }
    };
  }

  async close(): Promise<void> {
    // Dependants may still need their final Writer acknowledgement while they
    // drain. Close the singular database authority only after every ingress,
    // reader and external executor has stopped producing callbacks.
    this.projectionSubscriptions.close();
    await Promise.all([this.intelligence.close(), this.conversation.close()]);
    await this.network.close();
    await Promise.all([this.foregroundGit.close(), this.git.close()]);
    await this.controlReader.close();
    await this.foreground.close();
    await this.interactive.close();
    await this.background.close();
    await this.writer.close();
  }
}
