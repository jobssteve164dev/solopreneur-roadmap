import * as path from 'path';
import { Worker } from 'worker_threads';
import type { DatabaseSnapshotBinding, DatabaseSnapshotOwner } from './db/pinnedDatabaseSnapshot.js';

export interface DatabaseSnapshotWorkerConfiguration {
  root: string;
  databaseId: string;
  writerIncarnation: string;
  candidateDir: string;
  generationDevice: string;
  generationInode: string;
  baselineName?: 'solomap.db' | 'baseline.db';
}
export interface PersistedDatabaseChangeset { file: string; searchObjectIds: string[]; liveSequence: number }
export interface CopiedDatabaseSnapshot { destination: string; databaseId: string; committedSequence: number; bytes: number }

/** One generation owns this Worker; losing it invalidates every outstanding lease. */
export class DatabaseSnapshotWorkerClient implements DatabaseSnapshotOwner {
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private sequence = 0;
  private pinGeneration = 0;
  private binding?: Readonly<DatabaseSnapshotBinding>;
  private failure?: Error;
  private closing?: Promise<number>;
  private copying = false;
  private persisting?: Promise<PersistedDatabaseChangeset>;
  private constructor(private readonly configuration: DatabaseSnapshotWorkerConfiguration) {
    let ready!: () => void, rejectReady!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject; });
    this.worker = new Worker(path.join(__dirname, 'databaseSnapshotWorker.js'), { workerData: configuration });
    const fail = (error: Error): void => {
      this.invalidate(error);
      rejectReady(this.failure || error);
    };
    this.worker.on('message', message => {
      if (message.ready) { ready(); return; }
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      if (message.error) { const error = new Error(String(message.error)); item.reject(error); fail(error); }
      else item.resolve(message.result);
    });
    this.worker.on('error', fail);
    this.worker.on('exit', code => fail(new Error(`database_snapshot_worker_exited:${code}`)));
  }
  private invalidate(error: Error): void {
    this.failure ||= error;
    this.binding = undefined;
    for (const item of this.pending.values()) item.reject(this.failure);
    this.pending.clear();
    void this.close();
  }
  static async start(configuration: DatabaseSnapshotWorkerConfiguration): Promise<DatabaseSnapshotWorkerClient> {
    const client = new DatabaseSnapshotWorkerClient(configuration);
    try { await client.ready; client.assertHealthy(); return client; }
    catch (error) { await client.close(); throw error; }
  }
  assertHealthy(): void { if (this.failure) throw this.failure; if (this.closing) throw new Error('database_snapshot_worker_closed'); }
  private call<T>(operation: string, input: Record<string, unknown>, transfer: ArrayBuffer[] = []): Promise<T> {
    this.assertHealthy();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, operation, ...input }, transfer); }
      catch (error) { this.pending.delete(id); this.invalidate(error instanceof Error ? error : new Error(String(error))); reject(error); }
    });
  }
  async pin(token: string): Promise<Readonly<DatabaseSnapshotBinding>> {
    this.assertHealthy();
    if (this.copying) throw new Error('database_snapshot_busy');
    const generation = ++this.pinGeneration;
    this.binding = undefined;
    const binding = await this.call<DatabaseSnapshotBinding>('pin', { token });
    this.assertHealthy();
    if (generation !== this.pinGeneration) throw new Error('database_snapshot_superseded');
    if (binding.token !== token || binding.databaseId !== this.configuration.databaseId || binding.writerIncarnation !== this.configuration.writerIncarnation) throw new Error('database_snapshot_binding_invalid');
    return this.binding = Object.freeze(binding);
  }
  isCurrent(binding: DatabaseSnapshotBinding): boolean {
    return Boolean(binding && !this.failure && !this.closing && !this.copying && this.binding
      && Object.keys(this.binding).every(key => this.binding![key as keyof DatabaseSnapshotBinding] === binding[key as keyof DatabaseSnapshotBinding]));
  }
  async copy(binding: DatabaseSnapshotBinding): Promise<CopiedDatabaseSnapshot> {
    if (!this.isCurrent(binding)) throw new Error('database_snapshot_binding_invalid');
    this.copying = true;
    try { return await this.call<CopiedDatabaseSnapshot>('copy', { binding }); }
    finally { this.copying = false; this.binding = undefined; }
  }
  persistChangeset(input: { sequence: number; changeset: Uint8Array; searchObjectIds: string[]; liveSequence: number }): Promise<PersistedDatabaseChangeset> {
    this.assertHealthy();
    if (this.persisting) return Promise.reject(new Error('database_snapshot_changeset_busy'));
    const bytes = Uint8Array.from(input.changeset);
    const flight = this.call<PersistedDatabaseChangeset>('persist_changeset', { ...input, changeset: bytes }, [bytes.buffer]);
    this.persisting = flight;
    const clear = () => { if (this.persisting === flight) this.persisting = undefined; };
    void flight.then(clear, clear);
    return flight;
  }
  close(): Promise<number> {
    if (!this.closing) {
      this.binding = undefined;
      this.closing = this.worker.terminate();
    }
    return this.closing;
  }
}
