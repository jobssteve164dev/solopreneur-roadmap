import { parentPort, threadId, workerData } from 'worker_threads';

import { configureLocalDiagnosticPersistence } from './localDiagnostics';
import type { RuntimeDataOperations } from './runtimeDataOperations';
import { startTelegramBackgroundRuntime } from './telegramRuntime';

const port = parentPort;
if (!port) throw new Error('telegram_runtime_parent_missing');
const globalDataPath = String((workerData as { globalDataPath?: string }).globalDataPath || '');
if (!globalDataPath) throw new Error('telegram_runtime_data_root_missing');

let sequence = 0;
let closing = false;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const operation = ((request: Parameters<RuntimeDataOperations>[0]) => {
  const requestId = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    try { port.postMessage({ requestId, request }); }
    catch (error) {
      pending.delete(requestId);
      reject(error);
    }
  });
}) as RuntimeDataOperations;

configureLocalDiagnosticPersistence({
  append: (_root, event) => operation({ operation: 'append_diagnostic_event', input: event as unknown as Record<string, unknown> }).then(() => undefined),
  read: (_root) => operation({ operation: 'read_diagnostic_events', input: { limit: 250 } }) as Promise<{ items: Record<string, unknown>[] }>
}, globalDataPath);

const runtime = startTelegramBackgroundRuntime(globalDataPath, operation);
port.on('message', (message: { requestId?: number; result?: unknown; error?: string; close?: 'handoff' | 'drain' }) => {
  if (message.requestId !== undefined) {
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
    return;
  }
  if (!message.close || closing) return;
  closing = true;
  void runtime.close(message.close).then(
    () => port.postMessage({ closed: true }),
    error => { throw error; }
  );
});
port.postMessage({ ready: true, threadId });
