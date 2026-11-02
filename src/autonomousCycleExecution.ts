import * as path from 'path';
import * as fs from 'fs';
import { Worker } from 'worker_threads';
import { CognitiveCliProcessExecutor } from './cognitiveCliProcessExecutor';
import type { CognitiveCliInvocation } from './localAgentCliEngine';

interface AutonomousCycleExecutorOptions {
  globalDataPath: string;
  runtimeId: string;
  ownerPid?: number;
  workerEntryPath?: string;
}

export interface AutonomousCycleResult {
  leaseLost?: boolean;
  diagnosticError?: string;
}

interface WorkerMessage {
  ready?: boolean;
  closed?: boolean;
  id?: number;
  completed?: boolean;
  leaseLost?: boolean;
  diagnosticError?: string;
  error?: string;
  cognitiveChild?: { active: boolean; pid: number; processStartIdentity?: string };
  cognitiveInvocationId?: number;
  cognitiveInvocation?: CognitiveCliInvocation;
  cognitiveCancelId?: number;
}

export class AutonomousCycleExecutor {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve(value: AutonomousCycleResult): void; reject(error: unknown): void }>();
  private sequence = 0;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: unknown) => void;
  private closePromise: Promise<void> | undefined;
  private resolveClosed: (() => void) | undefined;
  private closed = false;
  private exited = false;
  private terminalError: Error | undefined;
  private readonly exitPromise: Promise<void>;
  private resolveExited!: () => void;
  private readonly ownedChildren = new Map<number, string | undefined>();
  private readonly cognitiveExecutor = new CognitiveCliProcessExecutor();

  constructor(options: AutonomousCycleExecutorOptions) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.exitPromise = new Promise<void>(resolve => { this.resolveExited = resolve; });
    this.worker = new Worker(options.workerEntryPath || path.join(__dirname, 'autonomousCycleWorker.js'), {
      workerData: {
        globalDataPath: options.globalDataPath,
        runtimeId: options.runtimeId,
        ownerPid: options.ownerPid || process.pid
      }
    });
    this.worker.on('message', message => this.onMessage(message as WorkerMessage));
    this.worker.once('error', error => this.fail(error));
    this.worker.once('exit', code => { void this.onExit(code); });
  }

  ready(): Promise<void> { return this.readyPromise; }

  async run(paused: boolean): Promise<AutonomousCycleResult> {
    await this.ready();
    if (this.closed) throw new Error('autonomous_cycle_worker_closed');
    if (this.terminalError) throw this.terminalError;
    const id = ++this.sequence;
    return new Promise<AutonomousCycleResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'run', id, paused });
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      await this.readyPromise.catch(() => undefined);
      if (!this.exited) {
        const acknowledged = new Promise<void>(resolve => { this.resolveClosed = resolve; });
        this.worker.postMessage({ type: 'close' });
        await Promise.race([
          acknowledged,
          this.exitPromise,
          new Promise<void>(resolve => setTimeout(resolve, 1_000))
        ]);
        if (!this.exited) await this.worker.terminate();
      }
      await this.exitPromise;
      this.fail(new Error('autonomous_cycle_worker_closed'));
    })();
    return this.closePromise;
  }

  private onMessage(message: WorkerMessage): void {
    if (message.cognitiveCancelId !== undefined) {
      this.cognitiveExecutor.cancel(message.cognitiveCancelId);
      return;
    }
    if (message.cognitiveInvocationId !== undefined && message.cognitiveInvocation) {
      void this.cognitiveExecutor.execute(message.cognitiveInvocationId, message.cognitiveInvocation).then(
        result => { if (!this.exited) this.worker.postMessage({ cognitiveInvocationId: message.cognitiveInvocationId, cognitiveResult: result }); },
        error => { if (!this.exited) this.worker.postMessage({ cognitiveInvocationId: message.cognitiveInvocationId, cognitiveError: error instanceof Error ? error.message : String(error) }); }
      );
      return;
    }
    if (message.cognitiveChild && Number.isSafeInteger(message.cognitiveChild.pid)) {
      if (message.cognitiveChild.active) this.ownedChildren.set(message.cognitiveChild.pid, message.cognitiveChild.processStartIdentity);
      else this.ownedChildren.delete(message.cognitiveChild.pid);
      return;
    }
    if (message.ready) {
      this.resolveReady();
      return;
    }
    if (message.closed) {
      this.resolveClosed?.();
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve({
      ...(message.leaseLost ? { leaseLost: true } : {}),
      ...(message.diagnosticError ? { diagnosticError: message.diagnosticError } : {})
    });
  }

  private fail(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.terminalError ||= failure;
    this.rejectReady(failure);
    for (const pending of this.pending.values()) pending.reject(failure);
    this.pending.clear();
  }

  private async onExit(code: number): Promise<void> {
    this.exited = true;
    if (!this.closed) this.fail(new Error(`autonomous_cycle_worker_exited:${code}`));
    await this.cognitiveExecutor.close();
    await this.terminateOwnedChildren();
    this.resolveExited();
    this.resolveClosed?.();
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

  private signalOwnedChildren(signal: NodeJS.Signals): void {
    for (const [pid, identity] of this.ownedChildren) {
      if (!this.childAlive(pid, identity)) { this.ownedChildren.delete(pid); continue; }
      try { process.kill(pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  }

  private async terminateOwnedChildren(): Promise<void> {
    this.signalOwnedChildren('SIGTERM');
    const deadline = Date.now() + 2_000;
    while ([...this.ownedChildren].some(([pid, identity]) => this.childAlive(pid, identity)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    this.signalOwnedChildren('SIGKILL');
    const reapDeadline = Date.now() + 1_000;
    while ([...this.ownedChildren].some(([pid, identity]) => this.childAlive(pid, identity)) && Date.now() < reapDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    this.ownedChildren.clear();
  }
}
