import { parentPort, threadId, workerData } from 'worker_threads';

import type { RuntimeDataRequest } from './autonomousRuntimeControl';
import { UnifiedDataStore } from './db/unifiedDataStore';
import { createRuntimeDataOperations } from './runtimeDataOperations';
import { runtimeOperationDefinition, RuntimeExecutorAffinity } from './runtimeOperationRegistry';

interface DomainWorkerData {
  root: string;
  databaseId: string;
  affinity: Extract<RuntimeExecutorAffinity, 'interactive-reader' | 'background-reader' | 'external-worker' | 'maintenance-worker'>;
}

const port = parentPort;
if (!port) throw new Error('runtime_data_domain_parent_missing');
const configuration = workerData as DomainWorkerData;
const store = configuration.affinity === 'maintenance-worker'
  ? new UnifiedDataStore(configuration.root, `runtime-${configuration.affinity}`)
  : UnifiedDataStore.openReadOnly(configuration.root, configuration.databaseId);
if (store.databaseId !== configuration.databaseId) {
  store.close();
  throw new Error('database_identity_mismatch');
}
const operations = createRuntimeDataOperations(store);
let closing = false;

port.on('message', async (message: { id?: number; request?: RuntimeDataRequest; close?: boolean }) => {
  if (message.close) {
    if (closing) return;
    closing = true;
    try { await operations.close(); } finally {
      store.close();
      port.postMessage({ closed: true });
      port.close();
    }
    return;
  }
  const id = Number(message.id);
  try {
    if (!message.request) throw new Error('runtime_data_domain_request_missing');
    const definition = runtimeOperationDefinition(message.request.operation);
    if (definition.executor !== configuration.affinity) throw new Error(`runtime_data_domain_mismatch:${definition.executor}`);
    if (message.request.sessionToken || message.request.piToolFence) throw new Error('runtime_data_domain_authority_required');
    const result = await operations(message.request);
    port.postMessage({ id, result });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    port.postMessage({ id, error: `${message.request?.operation || 'unknown'}: ${detail}` });
  }
});

port.postMessage({ ready: true, threadId, affinity: configuration.affinity });
