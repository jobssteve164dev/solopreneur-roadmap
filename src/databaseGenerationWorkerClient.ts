import * as path from 'path';
import { Worker } from 'worker_threads';

export interface DatabaseGenerationWorkerConfiguration {
  root: string;
  databaseId: string;
  generation: { candidateDir: string; device: string; inode: string };
}

/** The existing maintenance lane owns one private, cancellable generation. */
export class DatabaseGenerationWorkerClient {
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private sequence = 0;
  private failure?: Error;
  private closing?: Promise<number>;
  private constructor(configuration: DatabaseGenerationWorkerConfiguration) {
    let ready!: () => void, rejectReady!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject; });
    this.worker = new Worker(path.join(__dirname, 'maintenanceComputeWorker.js'), { workerData: configuration });
    const fail = (error: Error): void => { this.failure ||= error; rejectReady(this.failure); this.rejectPending(this.failure); };
    this.worker.on('message', message => {
      if (message.ready) { ready(); return; }
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      if (message.error) item.reject(new Error(String(message.error))); else item.resolve(message.result);
    });
    this.worker.once('error', fail);
    this.worker.once('exit', code => fail(new Error(`database_generation_compute_exited:${code}`)));
  }
  private rejectPending(error: Error): void { for (const item of this.pending.values()) item.reject(error); this.pending.clear(); }
  static async start(configuration: DatabaseGenerationWorkerConfiguration): Promise<DatabaseGenerationWorkerClient> {
    const client = new DatabaseGenerationWorkerClient(configuration);
    try { await client.ready; return client; } catch (error) { await client.close(); throw error; }
  }
  request<T>(operation: string, input: Record<string, unknown>): Promise<T> {
    if (this.failure || this.closing) return Promise.reject(this.failure || new Error('database_generation_compute_closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, operation, ...input }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  assertHealthy(): void { if (this.failure || this.closing) throw this.failure || new Error('database_generation_compute_closed'); }
  close(): Promise<number> {
    if (!this.closing) {
      this.rejectPending(new Error('database_generation_compute_closed'));
      this.closing = this.worker.terminate();
    }
    return this.closing;
  }
}
