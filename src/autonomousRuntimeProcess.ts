import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';

import {
  claimRuntimeLease,
  hasRuntimeLease,
  readCurrentRegisteredShadowDecision,
  refreshShadowRuntimeState,
  runCognitiveShadowDecisionCycle,
  runShadowDecisionCycleFromDatabase,
  runtimeRootRequiresExistingDatabase,
  persistShadowRuntimeState,
  updateRuntimeState
} from './autonomousRuntime';
import { cognitiveRuntimeConfigRevision, readCognitiveRuntimeConfig, refreshCognitiveRuntimeConfig } from './cognitiveRuntimeConfig';
import { EmbeddedPiAgentEngine } from './piAgentEngine';
import { sendRuntimeControlCommand, startRuntimeControlServer } from './autonomousRuntimeControl';
import { runtimeBuildId, runtimeReleaseVersion } from './runtimeBuildIdentity';
import { classifyDiagnosticFailure, configureLocalDiagnosticPersistence, importLegacyLocalDiagnostics, recordLocalDiagnosticError } from './localDiagnostics';
import { runPiMainPathRequestFile } from './piMainPathRuntime';
import { startTelegramBackgroundRuntime } from './telegramRuntime';
import { UnifiedDataStore } from './db/unifiedDataStore';
import { createRuntimeDataOperations } from './runtimeDataOperations';
import { normalizeGlobalDataPathForExtension, refreshProjectRegistry } from './projectRegistry';
import { enqueueStartupDataMigrations, historicalRunOwnerStateStamp, refreshHistoricalRunMigrations } from './runtimeDatabaseBootstrap';
import { isAutonomousRuntimeDisabled } from './autonomousRuntimeService';
import { importLegacyRuntimeState } from './runtimeStateMigration';
import { readRuntimePauseState, writeRuntimePauseState } from './runtimePauseState';

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
    const databaseRoot = normalizeGlobalDataPathForExtension(globalDataPath);
    const runtimeWasInitialized = runtimeRootRequiresExistingDatabase(databaseRoot);
    const runtimeId = crypto.randomUUID();
    const lease = claimRuntimeLease(databaseRoot, { runtimeId, pid: process.pid });
    if (lease.acquired) {
      const store = lease.owner.databaseId || runtimeWasInitialized || fs.existsSync(path.join(databaseRoot, 'solomap.db'))
        ? UnifiedDataStore.open(databaseRoot, lease.owner.databaseId || undefined)
        : new UnifiedDataStore(databaseRoot);
      const operations = createRuntimeDataOperations(store);
      try {
        updateRuntimeState(databaseRoot, runtimeId, { databaseId: store.databaseId });
        await refreshCognitiveRuntimeConfig(databaseRoot, (request) => operations(request));
        const result = await runPiMainPathRequestFile(databaseRoot, deliveryRequestFile);
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } finally {
        await operations.close();
        store.close();
        updateRuntimeState(databaseRoot, runtimeId, { status: 'stopped' });
      }
    } else {
      await refreshCognitiveRuntimeConfig(databaseRoot);
      const result = await runPiMainPathRequestFile(databaseRoot, deliveryRequestFile);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
    return;
  }
  if (process.argv.includes('--once')) {
    const onceRuntimeId = crypto.randomUUID();
    const databaseRoot = normalizeGlobalDataPathForExtension(globalDataPath);
    const runtimeWasInitialized = runtimeRootRequiresExistingDatabase(databaseRoot);
    const lease = claimRuntimeLease(globalDataPath, { runtimeId: onceRuntimeId, pid: process.pid });
    if (!lease.acquired) {
      await sendRuntimeControlCommand(globalDataPath, 'refresh', { expectedRuntimeId: lease.owner.runtimeId, timeoutMs: 10_000 });
      return;
    }
    const root = databaseRoot;
    const store = runtimeWasInitialized || fs.existsSync(path.join(root, 'solomap.db')) ? UnifiedDataStore.open(root) : new UnifiedDataStore(root);
    importLegacyRuntimeState(store, root);
    const operations = createRuntimeDataOperations(store);
    try {
      await refreshProjectRegistry(root, undefined, (operation, input) => operations({ operation, input }));
      const decision = await runShadowDecisionCycleFromDatabase({ globalDataPath, operation: operations });
      if (!hasRuntimeLease(globalDataPath, onceRuntimeId, process.pid)) return;
      await persistShadowRuntimeState(globalDataPath, operations);
    } finally {
      await operations.close(); store.close();
      updateRuntimeState(globalDataPath, onceRuntimeId, { status: 'stopped' });
    }
    return;
  }

  const runtimeId = argumentValue('--runtime-id') || crypto.randomUUID();
  const databaseRoot = normalizeGlobalDataPathForExtension(globalDataPath);
  const runtimeWasInitialized = process.argv.includes('--database-required')
    || (!argumentValue('--runtime-id') && runtimeRootRequiresExistingDatabase(databaseRoot));
  const lease = claimRuntimeLease(globalDataPath, { runtimeId, pid: process.pid });
  if (!lease.acquired) return;
  const databaseId = argumentValue('--database-id') || lease.owner.databaseId;
  const dataStore = databaseId || runtimeWasInitialized || fs.existsSync(path.join(databaseRoot, 'solomap.db'))
    ? UnifiedDataStore.open(databaseRoot, databaseId || undefined)
    : new UnifiedDataStore(databaseRoot);
  importLegacyRuntimeState(dataStore, databaseRoot);
  updateRuntimeState(globalDataPath, runtimeId, { databaseId: dataStore.databaseId });
  const dataOperations = createRuntimeDataOperations(dataStore);
  configureLocalDiagnosticPersistence({
    append: (_root, event) => dataOperations({ operation: 'append_diagnostic_event', input: event as unknown as Record<string, unknown> }).then(() => undefined),
    read: (_root) => dataOperations({ operation: 'read_diagnostic_events', input: { limit: 250 } }) as Promise<{ items: Record<string, unknown>[] }>
  }, databaseRoot);
  await importLegacyLocalDiagnostics(databaseRoot,
    event => dataOperations({ operation: 'append_diagnostic_event', input: event as unknown as Record<string, unknown> }).then(() => undefined),
    (source, bytes) => dataStore.captureMigrationSource(source, bytes, { mimeType: 'application/json', encoding: 'utf8', pending: true }),
    (source, result, error) => result === 'imported'
      ? dataStore.markMigrationSourceImported(source.identity, source.key)
      : dataStore.markMigrationSourceConflict(source.identity, source.key, error || 'legacy_diagnostic_invalid'));
  const runtimeBuild = runtimeBuildId(path.dirname(path.dirname(path.resolve(process.argv[1]))));
  const releaseVersion = argumentValue('--runtime-version') || runtimeReleaseVersion(path.dirname(path.dirname(path.resolve(process.argv[1]))));
  const registeredRuntime = await dataOperations({ operation: 'register_runtime_instance', input: { runtimeId, pid: process.pid, processStartedAt: Date.parse(lease.owner.startedAt), processBirth: lease.owner.processBirth || '', status: 'running', buildId: runtimeBuild, idempotencyKey: `runtime-register:${runtimeId}` } }) as { generation: number };
  const heartbeatRuntime = (status: 'running' | 'paused' | 'stopped' | 'failed') => {
    const heartbeatAt = Date.now();
    return dataOperations({ operation: 'heartbeat_runtime_instance', input: { runtimeId, generation: registeredRuntime.generation, status, heartbeatAt, idempotencyKey: `runtime-heartbeat:${runtimeId}:${status}:${heartbeatAt}` } });
  };
  await refreshCognitiveRuntimeConfig(databaseRoot, dataOperations);
  await refreshShadowRuntimeState(databaseRoot, dataOperations);
  let outboxRecovery: Promise<unknown> | undefined;
  let startupMigration: Promise<void> | undefined;
  let historicalOwnerStamp = '';

  let stopping = false;
  let paused = await readRuntimePauseState(dataOperations, isAutonomousRuntimeDisabled(globalDataPath));
  let running = false;
  let rerunRequested = false;
  let timer: NodeJS.Timeout | undefined;
  let activeEngine: EmbeddedPiAgentEngine | undefined;
  let controlServer: { close(): Promise<void> } | undefined;
  let telegram = startTelegramBackgroundRuntime(globalDataPath, dataOperations);
  if (paused) { updateRuntimeState(globalDataPath, runtimeId, { status: 'paused' }); await heartbeatRuntime('paused'); }
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    const telegramClosed = telegram?.close();
    activeEngine?.cancel();
    dataOperations.interruptRuns();
    void (async () => {
      await controlServer?.close();
      await telegramClosed;
      await startupMigration;
      await heartbeatRuntime('stopped');
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
    buildId: runtimeBuild,
    releaseVersion,
    owner: argumentValue('--runtime-owner') === 'service' ? 'service' : 'fallback',
    onData: dataOperations,
    async onCommand(command) {
      if (command === 'pause' || command === 'drain') {
        paused = true;
        if (command === 'pause') await writeRuntimePauseState(dataOperations, true);
        activeEngine?.cancel();
        updateRuntimeState(globalDataPath, runtimeId, { status: 'paused' });
        await heartbeatRuntime('paused');
        if (command === 'drain') setTimeout(stop, 25).unref();
        return { status: 'paused' };
      }
      if (command === 'resume') {
        await writeRuntimePauseState(dataOperations, false);
        paused = false;
        telegram ||= startTelegramBackgroundRuntime(globalDataPath, dataOperations);
        updateRuntimeState(globalDataPath, runtimeId, { status: 'running' });
        await heartbeatRuntime('running');
        if (running) rerunRequested = true;
        else runCycleObserved();
        return { status: 'running' };
      }
      if (command === 'refresh') {
        if (!paused) {
          if (running) rerunRequested = true;
          else runCycleObserved();
        }
        return { status: paused ? 'paused' : 'running' };
      }
      if (command === 'stop') {
        stop();
        return { status: 'stopped' };
      }
      return { status: paused ? 'paused' : 'running' };
    }
  }); } catch (error) {
    telegram?.close();
    await heartbeatRuntime('failed').catch(() => undefined);
    dataStore?.close();
    updateRuntimeState(globalDataPath, runtimeId, { status: 'stopped' });
    throw error;
  }
  dataOperations?.recoverMigrations();
  dataOperations.recoverRuns();
  outboxRecovery = dataStore?.recoverOutbox().catch(error => process.stderr.write(`SoloMap Runtime outbox recovery: ${String(error)}\n`));
  startupMigration = (async () => {
    await outboxRecovery;
    if (!stopping) historicalOwnerStamp = await historicalRunOwnerStateStamp(dataStore, () => !stopping);
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
      await refreshProjectRegistry(globalDataPath, undefined, (operation, input) => dataOperations({ operation, input }));
      await refreshCognitiveRuntimeConfig(globalDataPath, dataOperations);
      await startupMigration;
      if (!stopping) historicalOwnerStamp = await refreshHistoricalRunMigrations(dataStore, dataOperations, () => !stopping, historicalOwnerStamp);
      const current = readCurrentRegisteredShadowDecision(globalDataPath);
      const cognitiveConfig = readCognitiveRuntimeConfig(globalDataPath);
      const cognitiveConfigRevision = cognitiveRuntimeConfigRevision(cognitiveConfig);
      const engine = cognitiveConfig.mode === 'agent_cli' ? new EmbeddedPiAgentEngine({
        agentCli: cognitiveConfig.agentCli,
        model: cognitiveConfig.model,
        configRevision: cognitiveConfigRevision,
        workingDirectory: globalDataPath
      }) : null;
      activeEngine = engine || undefined;
      const decision = engine
        ? await runCognitiveShadowDecisionCycle({
          globalDataPath,
          engine,
          operation: dataOperations,
          currentDecision: current,
          engineConfigRevision: cognitiveConfigRevision,
          beforeCommit: () => !paused
            && hasRuntimeLease(globalDataPath, runtimeId, process.pid)
            && cognitiveRuntimeConfigRevision(readCognitiveRuntimeConfig(globalDataPath)) === cognitiveConfigRevision
        })
        : await runShadowDecisionCycleFromDatabase({ globalDataPath, operation: dataOperations });
      if (!hasRuntimeLease(globalDataPath, runtimeId, process.pid)) {
        stop();
        return;
      }
      await persistShadowRuntimeState(globalDataPath, dataOperations);
      updateRuntimeState(globalDataPath, runtimeId, { status: 'running' });
      await heartbeatRuntime('running');
    } catch (error) {
      recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.cycle', classifyDiagnosticFailure(error));
      if (stopping) return;
      if (paused) {
        updateRuntimeState(globalDataPath, runtimeId, { status: 'paused' });
        await heartbeatRuntime('paused');
        return;
      }
      if (!hasRuntimeLease(globalDataPath, runtimeId, process.pid)) {
        stop();
        return;
      }
      const fallback = await runShadowDecisionCycleFromDatabase({ globalDataPath, operation: dataOperations });
      if (!hasRuntimeLease(globalDataPath, runtimeId, process.pid)) {
        stop();
        return;
      }
      await persistShadowRuntimeState(globalDataPath, dataOperations);
      updateRuntimeState(globalDataPath, runtimeId, { status: 'running' });
      await heartbeatRuntime('running');
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
