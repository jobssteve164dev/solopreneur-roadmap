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
import { classifyDiagnosticFailure, configureLocalDiagnosticPersistence, createLocalDiagnosticTrace, importLegacyLocalDiagnostics, recordLocalDiagnosticError, sanitizeDiagnosticText } from './localDiagnostics';
import { runPiMainPathRequestFile } from './piMainPathRuntime';
import { startTelegramBackgroundRuntime } from './telegramRuntime';
import { UnifiedDataStore } from './db/unifiedDataStore';
import { createRuntimeDataOperations } from './runtimeDataOperations';
import { normalizeGlobalDataPathForExtension, refreshProjectRegistry } from './projectRegistry';
import { enqueueStartupDataMigrations, historicalRunOwnerStateStamp, refreshHistoricalRunMigrations } from './runtimeDatabaseBootstrap';
import { isAutonomousRuntimeDisabled } from './autonomousRuntimeService';
import { importLegacyRuntimeState } from './runtimeStateMigration';
import { readRuntimePauseState, writeRuntimePauseState } from './runtimePauseState';
import { reapFinishedLegacyRunProcesses } from './legacyRunProcessRecovery';
import { IntelligenceRuntime } from './intelligenceRuntime';
import { RuntimeDataExecutionDomains } from './runtimeDataExecutionDomains';
import { activeCognitiveCliInvocationCount, cancelActiveCognitiveCliInvocations, signalCognitiveCliShutdown } from './localAgentCliEngine';
import { terminateRuntimeOwnedChildProcesses } from './runtimeChildProcessSupervisor';

function argumentValue(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

let closeFailedRuntimeInitialization: (() => Promise<void>) | undefined;
let runtimeInitializationId = '';

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
  runtimeInitializationId = runtimeId;
  const databaseRoot = normalizeGlobalDataPathForExtension(globalDataPath);
  const runtimeWasInitialized = process.argv.includes('--database-required')
    || (!argumentValue('--runtime-id') && runtimeRootRequiresExistingDatabase(databaseRoot));
  const lease = claimRuntimeLease(globalDataPath, { runtimeId, pid: process.pid });
  if (!lease.acquired) return;
  const databaseId = argumentValue('--database-id') || lease.owner.databaseId;
  const dataStore = databaseId || runtimeWasInitialized || fs.existsSync(path.join(databaseRoot, 'solomap.db'))
    ? UnifiedDataStore.open(databaseRoot, databaseId || undefined)
    : new UnifiedDataStore(databaseRoot);
  let rawStoreClosed = false;
  closeFailedRuntimeInitialization = async () => {
    if (!rawStoreClosed) {
      rawStoreClosed = true;
      try { dataStore.close(); } catch { /* Preserve the initialization failure. */ }
      updateRuntimeState(globalDataPath, runtimeId, { status: 'stopped' });
    }
  };
  importLegacyRuntimeState(dataStore, databaseRoot);
  updateRuntimeState(globalDataPath, runtimeId, { databaseId: dataStore.databaseId });
  const dataOperations = createRuntimeDataOperations(dataStore);
  let initializationTelegram: ReturnType<typeof startTelegramBackgroundRuntime> | undefined;
  let heartbeatStopped: (() => Promise<unknown>) | undefined;
  let earlyCleanup: Promise<void> | undefined;
  closeFailedRuntimeInitialization = () => {
    if (earlyCleanup) return earlyCleanup;
    earlyCleanup = (async () => {
      dataOperations.interruptMigrations();
      dataOperations.interruptRuns();
      await initializationTelegram?.close('handoff').catch(() => undefined);
      await heartbeatStopped?.().catch(() => undefined);
      await dataOperations.close().catch(() => undefined);
      try { dataStore.close(); } catch { /* Preserve the initialization failure. */ }
      updateRuntimeState(globalDataPath, runtimeId, { status: 'stopped' });
    })();
    return earlyCleanup;
  };
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
  heartbeatStopped = () => heartbeatRuntime('stopped');
  const intelligenceRuntime = new IntelligenceRuntime(databaseRoot, dataStore, dataOperations, runtimeId, releaseVersion, runtimeBuild);
  dataOperations.setIntelligenceRuntime(intelligenceRuntime);
  await refreshCognitiveRuntimeConfig(databaseRoot, dataOperations);
  await refreshShadowRuntimeState(databaseRoot, dataOperations);
  let outboxRecovery: Promise<unknown> | undefined;
  let storageMaintenance: Promise<unknown> | undefined;
  let startupMigration: Promise<void> | undefined;
  let historicalOwnerStamp = '';
  let startupMigrationsReady = false;
  let resolveStorageMaintenanceBarrier!: () => void;
  let rejectStorageMaintenanceBarrier!: (error: unknown) => void;
  const storageMaintenanceBarrier = new Promise<void>((resolve, reject) => { resolveStorageMaintenanceBarrier = resolve; rejectStorageMaintenanceBarrier = reject; });
  void storageMaintenanceBarrier.catch(() => undefined);
  dataOperations.setStorageMaintenanceBarrier(storageMaintenanceBarrier);

  let stopping = false;
  let paused = await readRuntimePauseState(dataOperations, isAutonomousRuntimeDisabled(globalDataPath));
  let running = false;
  let rerunRequested = false;
  let timer: NodeJS.Timeout | undefined;
  let activeEngine: EmbeddedPiAgentEngine | undefined;
  let controlServer: { beginBusy(): () => void; close(): Promise<void> } | undefined;
  let dataExecutionDomains: RuntimeDataExecutionDomains | undefined;
  let telegram = initializationTelegram = startTelegramBackgroundRuntime(globalDataPath, dataOperations);
  let shutdownPromise: Promise<void> | undefined;
  let upgradeReplacement: { buildId: string; releaseVersion: string } | undefined;
  if (paused) { updateRuntimeState(globalDataPath, runtimeId, { status: 'paused' }); await heartbeatRuntime('paused'); }
  const stop = (exitCode = 0, reason = 'lease_lost'): Promise<void> => {
    if (exitCode !== 0) process.exitCode = exitCode;
    if (reason !== 'upgrade_drain') {
      signalCognitiveCliShutdown();
      cancelActiveCognitiveCliInvocations();
    }
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    const shutdownTrace = createLocalDiagnosticTrace(globalDataPath, `runtime.shutdown.${reason}`, { targetId: runtimeId });
    shutdownTrace.record(`runtime.shutdown.${reason}`, exitCode ? 'error' : 'ok', 0, undefined, { pid: process.pid, exitCode });
    shutdownPromise = (async () => {
      let shutdownError: unknown;
      const attempt = async (action: () => unknown | Promise<unknown>): Promise<void> => {
        try { await action(); }
        catch (error) { shutdownError ||= error; }
      };
      if (timer) clearInterval(timer);
      const telegramClosed = telegram?.close(reason === 'upgrade_drain' ? 'drain' : 'handoff');
      activeEngine?.cancel();
      shutdownTrace.record('runtime.shutdown.cognitive-invocations', 'ok', activeCognitiveCliInvocationCount());
      dataOperations.interruptMigrations();
      dataOperations.interruptRuns();
      // Leaf runtimes must release their MCP sessions, inbox claims, and
      // accepted work while the shared data plane is still available.
      // Closing RPC first creates a circular shutdown dependency once data
      // connections are persistent.
      await attempt(() => telegramClosed);
      await attempt(() => controlServer?.close());
      await attempt(() => dataExecutionDomains?.close());
      if (reason !== 'upgrade_drain') terminateRuntimeOwnedChildProcesses();
      await attempt(() => startupMigration);
      await attempt(() => storageMaintenance);
      await attempt(() => heartbeatRuntime('stopped'));
      await attempt(() => dataOperations.close());
      await attempt(() => outboxRecovery);
      const replacement = upgradeReplacement;
      if (reason === 'upgrade_drain' && replacement) await attempt(() => dataStore.recordPiCompatibilityDrain({
        runtimeId, releaseVersion, buildId: runtimeBuild,
        replacementVersion: replacement.releaseVersion, replacementBuildId: replacement.buildId
      }));
      try { dataStore?.close(); }
      catch (error) { shutdownError ||= error; }
      finally { updateRuntimeState(globalDataPath, runtimeId, { status: 'stopped' }); }
      if (shutdownError) throw shutdownError;
    })();
    void shutdownPromise.catch(error => { process.stderr.write(`SoloMap Runtime shutdown: ${String(error)}\n`); process.exitCode = 1; });
    process.exitCode ??= exitCode;
    return shutdownPromise;
  };
  closeFailedRuntimeInitialization = async () => { await stop(1, 'initialization_failed').catch(() => undefined); };
  try {
    dataExecutionDomains = await RuntimeDataExecutionDomains.start({
      root: databaseRoot,
      databaseId: dataStore.databaseId,
      writer: request => dataOperations(request)
    });
    controlServer = await startRuntimeControlServer({
    globalDataPath,
    runtimeId,
    entryPath: path.resolve(process.argv[1]),
    buildId: runtimeBuild,
    releaseVersion,
    owner: argumentValue('--runtime-owner') === 'service' ? 'service' : 'fallback',
    enforceOperationRegistry: true,
    onData: request => dataExecutionDomains!.dispatch(request),
    async onCommand(command, replacement) {
      if (command === 'pause' || command === 'drain') {
        paused = true;
        if (command === 'pause') await writeRuntimePauseState(dataOperations, true);
        if (command === 'drain') upgradeReplacement = replacement;
        updateRuntimeState(globalDataPath, runtimeId, { status: 'paused' });
        await heartbeatRuntime('paused');
        if (command === 'drain') setTimeout(() => stop(0, 'upgrade_drain'), 25).unref();
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
        if (running) rerunRequested = true;
        else runCycleObserved();
        return { status: paused ? 'paused' : 'running' };
      }
      if (command === 'stop') {
        stop(0, 'control_stop');
        return { status: 'stopped' };
      }
      return { status: paused ? 'paused' : 'running' };
    }
    });
  } catch (error) {
    rejectStorageMaintenanceBarrier(error);
    await stop(1, 'control_start_failed').catch(() => undefined);
    throw error;
  }
  let releaseStartupMigrationBusy = () => {};
  try {
    releaseStartupMigrationBusy = controlServer.beginBusy();
    dataStore.settleRedundantAgentRunUpgradeMigrations();
    dataOperations.recoverMigrations();
  }
  catch (error) {
    releaseStartupMigrationBusy();
    rejectStorageMaintenanceBarrier(error);
    await stop(1, 'startup_failed');
    throw error;
  }
  dataOperations.recoverRuns();
  void intelligenceRuntime.recover().catch(error => process.stderr.write(`SoloMap intelligence recovery: ${String(error)}\n`));
  outboxRecovery = dataStore?.recoverOutbox().catch(error => process.stderr.write(`SoloMap Runtime outbox recovery: ${String(error)}\n`));
  const startupMigrationReady = (async () => {
    try {
      await outboxRecovery;
      if (!stopping) historicalOwnerStamp = await historicalRunOwnerStateStamp(dataStore, () => !stopping);
      if (!stopping) await enqueueStartupDataMigrations(dataStore, dataOperations, () => !stopping);
      if (!stopping) await dataOperations.waitForMigrations();
      if (!stopping) {
        const recovered = await reapFinishedLegacyRunProcesses(dataStore);
        for (const conflict of recovered.conflicts) process.stderr.write(`SoloMap legacy run recovery: ${conflict}\n`);
      }
      if (!stopping) startupMigrationsReady = true;
    } finally { releaseStartupMigrationBusy(); }
  })();
  void startupMigrationReady.then(resolveStorageMaintenanceBarrier, rejectStorageMaintenanceBarrier);
  startupMigration = startupMigrationReady.catch(error => { process.stderr.write(`SoloMap Runtime memory migration: ${String(error)}\n`); });
  void startupMigrationReady.catch(error => {
    recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.migration.failed', error);
    void stop(1, 'migration_failed');
  });
  storageMaintenance = (async () => {
    await startupMigrationReady;
    if (!stopping) await dataOperations({ operation: 'maintain_database_storage', input: { compact: false, automatic: true } });
  })().catch(error => { process.stderr.write(`SoloMap Runtime storage maintenance: ${String(error)}\n`); });
  function runCycleObserved(): void {
    void runCycle().catch(error => {
      recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.cycle.fatal', classifyDiagnosticFailure(error));
    });
  }
  async function runCycle(): Promise<void> {
    if (stopping || running) return;
    running = true;
    let releaseBusy: (() => void) | undefined;
    try {
      releaseBusy = controlServer?.beginBusy();
      if (!hasRuntimeLease(globalDataPath, runtimeId, process.pid)) {
        stop();
        return;
      }
      try { dataStore.maintainPlannerStatistics(); }
      catch (error) { recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.planner-statistics', classifyDiagnosticFailure(error)); }
      await refreshProjectRegistry(globalDataPath, undefined, (operation, input) => dataOperations({ operation, input }));
      await refreshCognitiveRuntimeConfig(globalDataPath, dataOperations);
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
          beforeCommit: () => hasRuntimeLease(globalDataPath, runtimeId, process.pid)
            && cognitiveRuntimeConfigRevision(readCognitiveRuntimeConfig(globalDataPath)) === cognitiveConfigRevision
        })
        : await runShadowDecisionCycleFromDatabase({ globalDataPath, operation: dataOperations });
      if (!hasRuntimeLease(globalDataPath, runtimeId, process.pid)) {
        stop();
        return;
      }
      await persistShadowRuntimeState(globalDataPath, dataOperations);
      updateRuntimeState(globalDataPath, runtimeId, { status: paused ? 'paused' : 'running' });
      await heartbeatRuntime(paused ? 'paused' : 'running');
      if (!stopping && startupMigrationsReady) {
        try { historicalOwnerStamp = await refreshHistoricalRunMigrations(dataStore, dataOperations, () => !stopping, historicalOwnerStamp); }
        catch (error) { recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.migration-refresh', classifyDiagnosticFailure(error)); }
      }
    } catch (error) {
      recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.cycle', classifyDiagnosticFailure(error));
      if (stopping) return;
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
      updateRuntimeState(globalDataPath, runtimeId, { status: paused ? 'paused' : 'running' });
      await heartbeatRuntime(paused ? 'paused' : 'running');
    } finally {
      releaseBusy?.();
      activeEngine = undefined;
      running = false;
      if (rerunRequested && !stopping) {
        rerunRequested = false;
        runCycleObserved();
      }
    }
  }
  process.once('SIGTERM', () => { void stop(0, 'sigterm'); });
  process.once('SIGINT', () => { void stop(0, 'sigint'); });
  runCycleObserved();
  timer = setInterval(runCycleObserved, intervalValue());
}

void main().catch(async error => {
  const globalDataPath = argumentValue('--global-data-path');
  const failureReason = sanitizeDiagnosticText(error);
  const failureCode = /^[a-z0-9_]{1,80}$/i.test(failureReason) ? failureReason : classifyDiagnosticFailure(error);
  if (globalDataPath) recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.initialize', failureCode);
  try { await closeFailedRuntimeInitialization?.(); }
  catch (cleanupError) { process.stderr.write(`SoloMap Runtime initialization cleanup: ${String(cleanupError)}\n`); }
  const runtimeId = argumentValue('--runtime-id') || runtimeInitializationId;
  if (globalDataPath && runtimeId) updateRuntimeState(globalDataPath, runtimeId, { status: 'failed', failureCode, failureReason });
  process.stderr.write(`SoloMap Runtime could not initialize autonomous execution: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
