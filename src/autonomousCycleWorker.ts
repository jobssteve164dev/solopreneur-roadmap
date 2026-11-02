import { parentPort, workerData } from 'worker_threads';

import {
  hasRuntimeLease,
  persistShadowRuntimeState,
  readCurrentRegisteredShadowDecision,
  runCognitiveShadowDecisionCycle,
  runShadowDecisionCycleFromDatabase
} from './autonomousRuntime';
import { cognitiveRuntimeConfigRevision, readCognitiveRuntimeConfig, refreshCognitiveRuntimeConfig } from './cognitiveRuntimeConfig';
import type { CognitiveCliInvocation } from './localAgentCliEngine';
import { EmbeddedPiAgentEngine } from './piAgentEngine';
import { refreshProjectRegistry } from './projectRegistry';
import { sendRuntimeDataRequest, type RuntimeDataRequest } from './autonomousRuntimeControl';
import type { RuntimeDataOperations } from './runtimeDataOperations';

const port = parentPort;
if (!port) throw new Error('autonomous_cycle_worker_parent_missing');

const configuration = workerData as { globalDataPath: string; runtimeId: string; ownerPid: number };
let activeEngine: EmbeddedPiAgentEngine | undefined;
let closing = false;

let cognitiveInvocationSequence = 0;
const cognitiveInvocationPending = new Map<number, { resolve(value: string): void; reject(error: Error): void }>();
const activeCognitiveInvocations = new Set<number>();
const cognitiveRunner = {
  runner: (invocation: CognitiveCliInvocation) => {
    const cognitiveInvocationId = ++cognitiveInvocationSequence;
    activeCognitiveInvocations.add(cognitiveInvocationId);
    return new Promise<string>((resolve, reject) => {
      cognitiveInvocationPending.set(cognitiveInvocationId, {
        resolve: value => { activeCognitiveInvocations.delete(cognitiveInvocationId); resolve(value); },
        reject: error => { activeCognitiveInvocations.delete(cognitiveInvocationId); reject(error); }
      });
      port.postMessage({ cognitiveInvocationId, cognitiveInvocation: invocation });
    });
  },
  cancel: () => { for (const cognitiveCancelId of activeCognitiveInvocations) port.postMessage({ cognitiveCancelId }); }
};

function operation(request: RuntimeDataRequest): Promise<unknown> {
  if (closing) return Promise.reject(new Error('autonomous_cycle_worker_closing'));
  return sendRuntimeDataRequest(configuration.globalDataPath, request);
}

const dataOperations: RuntimeDataOperations = Object.assign(operation, {
  setStorageMaintenanceBarrier: () => { throw new Error('autonomous_cycle_storage_barrier_unavailable'); },
  recoverMigrations: () => { throw new Error('autonomous_cycle_migration_control_unavailable'); },
  recoverRuns: () => { throw new Error('autonomous_cycle_run_recovery_unavailable'); },
  interruptMigrations: () => { throw new Error('autonomous_cycle_migration_control_unavailable'); },
  interruptRuns: () => { throw new Error('autonomous_cycle_run_control_unavailable'); },
  waitForMigrations: () => Promise.reject(new Error('autonomous_cycle_migration_control_unavailable')),
  quiesceForDatabaseGeneration: () => Promise.reject(new Error('autonomous_cycle_database_control_unavailable')),
  close: () => Promise.resolve(),
  setIntelligenceRuntime: () => { throw new Error('autonomous_cycle_intelligence_control_unavailable'); }
});

function ownsLease(): boolean {
  return hasRuntimeLease(configuration.globalDataPath, configuration.runtimeId, configuration.ownerPid);
}

async function runCycle(paused: boolean): Promise<{ leaseLost?: boolean; diagnosticError?: string }> {
  if (!ownsLease()) return { leaseLost: true };
  let diagnosticError = '';
  try {
    await refreshProjectRegistry(configuration.globalDataPath, undefined,
      (name, input) => operation({ operation: name, input }));
    await refreshCognitiveRuntimeConfig(configuration.globalDataPath, operation);
    const current = readCurrentRegisteredShadowDecision(configuration.globalDataPath);
    const cognitiveConfig = readCognitiveRuntimeConfig(configuration.globalDataPath);
    const configRevision = cognitiveRuntimeConfigRevision(cognitiveConfig);
    const engine = cognitiveConfig.mode === 'agent_cli' ? new EmbeddedPiAgentEngine({
      agentCli: cognitiveConfig.agentCli,
      model: cognitiveConfig.model,
      configRevision,
      workingDirectory: configuration.globalDataPath,
      runner: cognitiveRunner.runner,
      runnerCancel: cognitiveRunner.cancel
    }) : null;
    activeEngine = engine || undefined;
    if (engine) {
      await runCognitiveShadowDecisionCycle({
        globalDataPath: configuration.globalDataPath,
        engine,
        operation: dataOperations,
        currentDecision: current,
        engineConfigRevision: configRevision,
        beforeCommit: () => ownsLease()
          && cognitiveRuntimeConfigRevision(readCognitiveRuntimeConfig(configuration.globalDataPath)) === configRevision
      });
    } else {
      await runShadowDecisionCycleFromDatabase({ globalDataPath: configuration.globalDataPath, operation: dataOperations });
    }
  } catch (error) {
    if (closing) throw error;
    diagnosticError = error instanceof Error ? error.message : String(error);
    if (!ownsLease()) return { leaseLost: true, diagnosticError };
    await runShadowDecisionCycleFromDatabase({ globalDataPath: configuration.globalDataPath, operation: dataOperations });
  } finally {
    activeEngine = undefined;
  }
  if (!ownsLease()) return { leaseLost: true, ...(diagnosticError ? { diagnosticError } : {}) };
  await persistShadowRuntimeState(configuration.globalDataPath, dataOperations);
  return diagnosticError ? { diagnosticError } : {};
}

port.on('message', (message: {
  type?: 'run' | 'close';
  id?: number;
  paused?: boolean;
  cognitiveInvocationId?: number;
  cognitiveResult?: string;
  cognitiveError?: string;
}) => {
  if (message.cognitiveInvocationId !== undefined) {
    const pending = cognitiveInvocationPending.get(message.cognitiveInvocationId);
    if (!pending) return;
    cognitiveInvocationPending.delete(message.cognitiveInvocationId);
    if (message.cognitiveError) pending.reject(new Error(message.cognitiveError));
    else pending.resolve(String(message.cognitiveResult || ''));
    return;
  }
  if (message.type === 'close') {
    closing = true;
    cognitiveRunner.cancel();
    activeEngine?.cancel();
    port.postMessage({ closed: true });
    port.close();
    return;
  }
  if (message.type === 'run' && message.id !== undefined) {
    void runCycle(Boolean(message.paused)).then(
      result => port.postMessage({ id: message.id, completed: true, ...result }),
      error => port.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) })
    );
  }
});

port.postMessage({ ready: true });
