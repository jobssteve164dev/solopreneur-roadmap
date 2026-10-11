import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { UnifiedDataStore } from './db/unifiedDataStore';

type Identity = { projectId: string; executionLogId: number; generation: number };

export class RunInputMaterialization {
  constructor(private readonly store: UnifiedDataStore) {}
  public async materialize(identity: Identity): Promise<{ path: string; sha256: string; size: number }> {
    const entry = this.store.reserveRunInputMaterialization(identity.projectId, identity.executionLogId, identity.generation);
    const bytes = this.store.readRunInputMaterializationBytes(identity.projectId, identity.executionLogId, identity.generation);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('run_input_changed');
    await fs.promises.mkdir(path.dirname(entry.path), { recursive: true });
    try { await fs.promises.writeFile(entry.path, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await this.verify(entry); }
    this.store.markRunInputWritten(identity.projectId, identity.executionLogId, identity.generation);
    return entry;
  }
  private async verify(entry: { path: string; sha256: string; size: number }): Promise<void> {
    const stat = await fs.promises.lstat(entry.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size || crypto.createHash('sha256').update(await fs.promises.readFile(entry.path)).digest('hex') !== entry.sha256) throw new Error('run_input_file_conflict');
  }
  public async release(identity: Identity): Promise<void> {
    const entry = this.store.readRunInputMaterialization(identity.projectId, identity.executionLogId, identity.generation);
    if (!entry) return;
    try {
      try { await this.verify(entry); }
      catch (error) {
        if ((error as Error).message !== 'run_input_file_conflict' || entry.written) throw error;
        const stat = await fs.promises.lstat(entry.path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw error;
        const observed = await fs.promises.readFile(entry.path);
        const intended = this.store.readRunInputMaterializationBytes(identity.projectId, identity.executionLogId, identity.generation);
        if (observed.length >= intended.length || !observed.equals(intended.subarray(0, observed.length))) throw error;
        const state = this.store.readRunState(identity.projectId, identity.executionLogId);
        const purpose = `temporary_observed_${identity.generation}`;
        const previous = this.store.readRunDocument(identity.projectId, identity.executionLogId, purpose);
        this.store.writeRunDocument(identity.projectId, { executionLogId: identity.executionLogId, generation: state.generation, purpose, bytes: observed.toString('base64'), mimeType: 'application/octet-stream', expectedRevision: previous?.revision || 0, idempotencyKey: `run:${state.runId}:${identity.generation}:temporary-partial:${crypto.createHash('sha256').update(observed).digest('hex')}` });
      }
      await fs.promises.unlink(entry.path);
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.store.releaseRunInputMaterialization(identity.projectId, identity.executionLogId, identity.generation);
  }
  public async recover(): Promise<void> {
    const errors: unknown[] = [];
    let cursor: number | null = 0;
    do {
      const page = this.store.listRunInputMaterializations(cursor);
      for (const entry of page.items) {
        try {
          const state = this.store.readRunState(entry.projectId, entry.executionLogId);
          if (state.generation !== entry.generation || !this.store.runProcessAlive(entry.projectId, entry.executionLogId)) await this.release(entry);
        } catch (error) { errors.push(error); }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    if (errors.length) throw Object.assign(new Error(errors.map(error => error instanceof Error ? error.message : String(error)).join('; ')), { errors });
  }
}
