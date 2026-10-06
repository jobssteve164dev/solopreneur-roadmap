import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';

import {
  claimRuntimeLease,
  hasRuntimeLease,
  readCurrentRegisteredShadowDecision,
  runCognitiveShadowDecisionCycle,
  runShadowDecisionCycle,
  updateRuntimeState
} from './autonomousRuntime';
import { cognitiveRuntimeConfigRevision, readCognitiveRuntimeConfig } from './cognitiveRuntimeConfig';
import { EmbeddedPiAgentEngine } from './piAgentEngine';
import { initializeAutonomousExecutionRuntime } from './autonomousExecutionRuntime';
import { startRuntimeControlServer } from './autonomousRuntimeControl';
import { runtimeBuildId } from './runtimeBuildIdentity';
import { classifyDiagnosticFailure, recordLocalDiagnosticError } from './localDiagnostics';
import { runPiMainPathRequestFile } from './piMainPathRuntime';
import { startTelegramBackgroundRuntime } from './telegramRuntime';
import { UnifiedDataStore } from './db/unifiedDataStore';
import { createRuntimeDataOperations } from './runtimeDataOperations';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import { enqueueStartupDataMigrations } from './runtimeDatabaseBootstrap';
import { isAutonomousRuntimeDisabled } from './autonomousRuntimeService';

function argumentValue(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

function intervalValue(): number {
  const parsed = Number(argumentValue('--interval-ms') || 30_000);
  return Number.isFinite(parsed) ? Math.max(5_000, Math.round(parsed)) : 30_000;
}

async function main(): Promise<void> {
  const globalDataPath = argumentValue('--global-data-path');
  if (!globalDataPath) {
    process.stderr.write('SoloMap Runtime requires --global-data-path.\n');
    process.exitCode = 2;
    return;
  }
  const deliveryRequestFile = argumentValue('--delivery-request-file');
  if (deliveryRequestFile) {
    const result = await runPiMainPathRequestFile(globalDataPath, deliveryRequestFile);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  await initializeAutonomousExecutionRuntime({ globalDataPath });
  if (process.argv.includes('--once')) {
    runShadowDecisionCycle({ globalDataPath });
    return;
  }

  const runtimeId = argumentValue('--runtime-id') || crypto.randomUUID();
  const lease = claimRuntimeLease(globalDataPath, { runtimeId, pid: process.pid });
  if (!lease.acquired) return;
  const databaseRoot = normalizeGlobalDataPathForExtension(globalDataPath);
  const databaseId = argumentValue('--database-id') || lease.owner.databaseId;
  const dataStore = databaseId || fs.existsSync(path.join(databaseRoot, 'solomap.db'))
    ? UnifiedDataStore.open(databaseRoot, databaseId || undefined)
    : new UnifiedDataStore(databaseRoot);
  updateRuntimeState(globalDataPath, runtimeId, { databaseId: dataStore.databaseId });
  const dataOperations = createRuntimeDataOperations(dataStore);
  let outboxRecovery: Promise<unknown> | undefined;
  let startupMigration: Promise<void> | undefined;

  let stopping = false;
  let paused = isAutonomousRuntimeDisabled(globalDataPath);
  let running = false;
  let rerunRequested = false;
  let timer: NodeJS.Timeout | undefined;
  let activeEngine: EmbeddedPiAgentEngine | undefined;
  let controlServer: { close(): Promise<void> } | undefined;
  let telegram = paused ? undefined : startTelegramBackgroundRuntime(globalDataPath);
  if (paused) updateRuntimeState(globalDataPath, runtimeId, { status: 'paused' });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    telegram?.close();
    activeEngine?.cancel();
    void (async () => {
      await controlServer?.close();
      await startupMigration;
      await dataOperations.close();
      await outboxRecovery;
      dataStore?.close();
      updateRuntimeState(globalDataPath, runtimeId, { status: 'stopped' });
    })().catch(error => { process.stderr.write(`SoloMap Runtime shutdown: ${String(error)}\n`); process.exitCode = 1; });
    process.exitCode = 0;
  };
  try { controlServer = await startRuntimeControlServer({
    globalDataPath,
    runtimeId,
    entryPath: path.resolve(process.argv[1]),
    buildId: runtimeBuildId(path.dirname(path.dirname(path.resolve(process.argv[1])))),
    owner: argumentValue('--runtime-owner') === 'service' ? 'service' : 'fallback',
    onData: dataOperations,
    onCommand(command) {
      if (command === 'pause' || command === 'drain') {
        paused = true;
        activeEngine?.cancel();
        updateRuntimeState(globalDataPath, runtimeId, { status: 'paused' });
        if (command === 'drain') setTimeout(stop, 25).unref();
        return { status: 'paused' };
      }
      if (command === 'resume') {
        paused = false;
        telegram ||= startTelegramBackgroundRuntime(globalDataPath);
        updateRuntimeState(globalDataPath, runtimeId, { status: 'running' });
        if (running) rerunRequested = true;
        else runCycleObserved();
        return { status: 'running' };
      }
      if (command === 'stop') {
        stop();
        return { status: 'stopped' };
      }
      return { status: paused ? 'paused' : 'running' };
    }
  }); } catch (error) {
    telegram?.close();
    dataStore?.close();
    updateRuntimeState(globalDataPath, runtimeId, { status: 'stopped' });
    throw error;
  }
  dataOperations?.recoverMigrations();
  outboxRecovery = dataStore?.recoverOutbox().catch(error => process.stderr.write(`SoloMap Runtime outbox recovery: ${String(error)}\n`));
  startupMigration = (async () => {
    await outboxRecovery;
    if (!stopping) await enqueueStartupDataMigrations(dataStore, dataOperations, () => !stopping);
  })().catch(error => { process.stderr.write(`SoloMap Runtime memory migration: ${String(error)}\n`); });
  function runCycleObserved(): void {
    void runCycle().catch(error => {
      recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.cycle.fatal', classifyDiagnosticFailure(error));
    });
  }
  async function runCycle(): Promise<void> {
    if (stopping || running) return;
    if (paused) {
      updateRuntimeState(globalDataPath, runtimeId, { status: 'paused' });
      return;
    }
    running = true;
    try {
      if (!hasRuntimeLease(globalDataPath, runtimeId, process.pid)) {
        stop();
        return;
      }
      const current = readCurrentRegisteredShadowDecision(globalDataPath);
      const cognitiveConfig = readCognitiveRuntimeConfig(globalDataPath);
      const cognitiveConfigRevision = cognitiveRuntimeConfigRevision(cognitiveConfig);
      const engine = cognitiveConfig.mode === 'agent_cli' ? new EmbeddedPiAgentEngine({
        agentCli: cognitiveConfig.agentCli,
        model: cognitiveConfig.model,
        configRevision: cognitiveConfigRevision,
        workingDirectory: path.join(globalDataPath, 'runtime', 'cognitive-work')
      }) : null;
      activeEngine = engine || undefined;
      const decision = engine
        ? (current?.engineStatus === 'completed' && current.engineId === engine.id ? current : await runCognitiveShadowDecisionCycle({
          globalDataPath,
          engine,
          engineConfigRevision: cognitiveConfigRevision,
          beforeCommit: () => !paused
            && hasRuntimeLease(globalDataPath, runtimeId, process.pid)
            && cognitiveRuntimeConfigRevision(readCognitiveRuntimeConfig(globalDataPath)) === cognitiveConfigRevision
        }))
        : runShadowDecisionCycle({ globalDataPath });
      if (!hasRuntimeLease(globalDataPath, runtimeId, process.pid)) {
        stop();
        return;
      }
      updateRuntimeState(globalDataPath, runtimeId, {
        status: 'running',
        lastDecisionId: decision.decisionId,
        error: ''
      });
    } catch (error) {
      recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.cycle', classifyDiagnosticFailure(error));
      if (stopping) return;
      if (paused) {
        updateRuntimeState(globalDataPath, runtimeId, { status: 'paused' });
        return;
      }
      if (!hasRuntimeLease(globalDataPath, runtimeId, process.pid)) {
        stop();
        return;
      }
      const fallback = runShadowDecisionCycle({ globalDataPath });
      updateRuntimeState(globalDataPath, runtimeId, {
        status: 'running',
        lastDecisionId: fallback.decisionId,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      activeEngine = undefined;
      running = false;
      if (rerunRequested && !paused && !stopping) {
        rerunRequested = false;
        runCycleObserved();
      }
    }
  }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  runCycleObserved();
  timer = setInterval(runCycleObserved, intervalValue());
}

void main().catch(error => {
  const globalDataPath = argumentValue('--global-data-path');
  if (globalDataPath) recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.initialize', classifyDiagnosticFailure(error));
  process.stderr.write(`SoloMap Runtime could not initialize autonomous execution: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
