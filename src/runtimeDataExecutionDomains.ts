import * as path from 'path';
import { Worker } from 'worker_threads';

import type { RuntimeDataRequest } from './autonomousRuntimeControl';
import { runtimeOperationDefinition, RuntimeExecutorAffinity } from './runtimeOperationRegistry';

type WorkerAffinity = Extract<RuntimeExecutorAffinity, 'interactive-reader' | 'background-reader' | 'external-worker' | 'maintenance-worker'>;

interface DomainWorkerResponse {
  id?: number;
  ready?: boolean;
  closed?: boolean;
  threadId?: number;
  result?: unknown;
  error?: string;
}

class RuntimeDomainWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  private sequence = 0;
  private readyThreadId = 0;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: unknown) => void;
  private closePromise: Promise<void> | undefined;
  private resolveClosed: (() => void) | undefined;
  private exited = false;

  constructor(root: string, databaseId: string, readonly affinity: WorkerAffinity) {
    this.readyPromise = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.worker = new Worker(path.join(__dirname, 'runtimeDataDomainWorker.js'), {
      workerData: { root, databaseId, affinity }
    });
    this.worker.on('message', (message: DomainWorkerResponse) => this.onMessage(message));
    this.worker.once('error', error => this.fail(error));
    this.worker.once('exit', code => {
      this.exited = true;
      if (code !== 0) this.fail(new Error(`runtime_data_domain_exited:${this.affinity}:${code}`));
      this.resolveClosed?.();
    });
  }

  private onMessage(message: DomainWorkerResponse): void {
    if (message.ready) {
      this.readyThreadId = Number(message.threadId);
      this.resolveReady();
      return;
    }
    if (message.closed) {
      this.resolveClosed?.();
      return;
    }
    const pending = this.pending.get(Number(message.id));
    if (!pending) return;
    this.pending.delete(Number(message.id));
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  private fail(error: unknown): void {
    this.rejectReady(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  async ready(): Promise<void> { await this.readyPromise; }
  threadId(): number { return this.readyThreadId; }

  async request(request: RuntimeDataRequest): Promise<unknown> {
    await this.ready();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, request }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = new Promise<void>(resolve => {
      if (this.exited) { resolve(); return; }
      this.resolveClosed = resolve;
      this.worker.postMessage({ close: true });
    });
    return this.closePromise;
  }
}

export class RuntimeDataExecutionDomains {
  private constructor(
    private readonly writer: (request: RuntimeDataRequest) => Promise<unknown>,
    private readonly supervisor: (request: RuntimeDataRequest) => Promise<unknown>,
    private readonly interactive: RuntimeDomainWorker,
    private readonly background: RuntimeDomainWorker,
    private readonly external: RuntimeDomainWorker,
    private readonly maintenance: RuntimeDomainWorker
  ) {}

  static async start(options: {
    root: string;
    databaseId: string;
    writer(request: RuntimeDataRequest): Promise<unknown>;
    supervisor?(request: RuntimeDataRequest): Promise<unknown>;
  }): Promise<RuntimeDataExecutionDomains> {
    const interactive = new RuntimeDomainWorker(options.root, options.databaseId, 'interactive-reader');
    const background = new RuntimeDomainWorker(options.root, options.databaseId, 'background-reader');
    const external = new RuntimeDomainWorker(options.root, options.databaseId, 'external-worker');
    const maintenance = new RuntimeDomainWorker(options.root, options.databaseId, 'maintenance-worker');
    const workers = [interactive, background, external, maintenance];
    try { await Promise.all(workers.map(worker => worker.ready())); }
    catch (error) {
      await Promise.allSettled(workers.map(worker => worker.close()));
      throw error;
    }
    return new RuntimeDataExecutionDomains(options.writer, options.supervisor || options.writer, interactive, background, external, maintenance);
  }

  dispatch(request: RuntimeDataRequest): Promise<unknown> {
    const definition = runtimeOperationDefinition(request.operation);
    // Authenticated MCP sessions and fenced Pi operations carry in-memory
    // authority owned by the writer. They must not be copied into readers.
    if (request.sessionToken || request.piToolFence) return this.writer(request);
    if (definition.executor === 'supervisor') return this.supervisor(request);
    if (definition.executor === 'interactive-reader') {
      return this.interactive.request(request).catch(error => {
        const detail = error instanceof Error ? error.message : String(error);
        // A newly committed run may briefly be absent from an already-open WAL
        // reader. Preserve read-after-write semantics with one authoritative,
        // still read-only retry through the writer connection.
        if (request.operation === 'read_run_state' && /:\s*run_missing$/.test(detail)) return this.writer(request);
        throw error;
      });
    }
    if (definition.executor === 'background-reader') return this.background.request(request);
    if (definition.executor === 'external-worker') return this.external.request(request);
    if (definition.executor === 'maintenance-worker') return this.maintenance.request(request);
    return this.writer(request);
  }

  topology(): {
    interactiveQuery: { threadId: number; readOnly: true };
    backgroundQuery: { threadId: number; readOnly: true };
    externalJob: { threadId: number; readOnly: true };
    maintenance: { threadId: number; readOnly: false };
  } {
    return {
      interactiveQuery: { threadId: this.interactive.threadId(), readOnly: true },
      backgroundQuery: { threadId: this.background.threadId(), readOnly: true },
      externalJob: { threadId: this.external.threadId(), readOnly: true },
      maintenance: { threadId: this.maintenance.threadId(), readOnly: false }
    };
  }

  async close(): Promise<void> {
    await Promise.all([this.interactive.close(), this.background.close(), this.external.close(), this.maintenance.close()]);
  }
}
