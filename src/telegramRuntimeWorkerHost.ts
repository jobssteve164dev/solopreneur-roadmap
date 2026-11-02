import * as path from 'path';
import { Worker } from 'worker_threads';

import type { RuntimeDataOperations } from './runtimeDataOperations';

interface TelegramWorkerMessage {
  ready?: boolean;
  closed?: boolean;
  threadId?: number;
  requestId?: number;
  request?: Parameters<RuntimeDataOperations>[0];
  result?: unknown;
  error?: string;
}

export class TelegramRuntimeWorkerHost {
  private readonly worker: Worker;
  private readonly readyPromise: Promise<void>;
  private readonly fatalPromise: Promise<never>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private rejectFatal!: (error: Error) => void;
  private closePromise: Promise<void> | undefined;
  private resolveClosed: (() => void) | undefined;
  private closing = false;
  private readyThreadId = 0;

  constructor(globalDataPath: string, private readonly operation: RuntimeDataOperations) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.fatalPromise = new Promise<never>((_resolve, reject) => { this.rejectFatal = reject; });
    void this.fatalPromise.catch(() => undefined);
    const worker = new Worker(path.join(__dirname, 'telegramRuntimeWorker.js'), { workerData: { globalDataPath } });
    this.worker = worker;
    worker.on('message', (message: TelegramWorkerMessage) => this.receive(message));
    worker.once('error', error => {
      this.rejectReady(error);
      if (!this.closing) this.rejectFatal(error);
    });
    worker.once('exit', code => {
      if (this.closing) {
        this.resolveClosed?.();
        return;
      }
      const error = new Error(`telegram_runtime_worker_exited:${code}`);
      this.rejectReady(error);
      this.rejectFatal(error);
    });
  }

  private receive(message: TelegramWorkerMessage): void {
    if (message.ready) {
      this.readyThreadId = Number(message.threadId || 0);
      this.resolveReady();
      return;
    }
    if (message.requestId !== undefined && message.request) {
      void this.operation(message.request).then(
        result => this.worker.postMessage({ requestId: message.requestId, result }),
        error => this.worker.postMessage({ requestId: message.requestId, error: error instanceof Error ? error.message : String(error) })
      );
      return;
    }
    if (message.closed) this.resolveClosed?.();
  }

  ready(): Promise<void> { return this.readyPromise; }

  waitForFatalFailure(): Promise<never> { return this.fatalPromise; }

  activity(): { threadId: number; readOnly: false; role: 'telegram-channel' } {
    return { threadId: this.readyThreadId, readOnly: false, role: 'telegram-channel' };
  }

  close(mode: 'handoff' | 'drain' = 'handoff'): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = new Promise<void>(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve();
      };
      this.resolveClosed = () => { void this.worker.terminate().then(finish, finish); };
      const deadline = setTimeout(() => { void this.worker.terminate().then(finish, finish); }, 5_000);
      deadline.unref();
      this.readyPromise.then(
        () => this.worker.postMessage({ close: mode }),
        () => { void this.worker.terminate().then(finish, finish); }
      );
    });
    return this.closePromise;
  }
}
