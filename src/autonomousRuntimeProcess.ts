import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';

import {
  claimRuntimeLease,
  hasRuntimeLease,
  refreshShadowRuntimeState,
  runShadowDecisionCycleFromDatabase,
  runtimeRootRequiresExistingDatabase,
  persistShadowRuntimeState,
  updateRuntimeState
} from './autonomousRuntime';
import { refreshCognitiveRuntimeConfig } from './cognitiveRuntimeConfig';
import { AutonomousCycleExecutor } from './autonomousCycleExecution';
import { sendRuntimeControlCommand, sendRuntimeDataRequest, serializedRuntimeDataResult, startRuntimeControlServer, type RuntimeDataRequest } from './autonomousRuntimeControl';
import { runtimeBuildId, runtimeReleaseVersion } from './runtimeBuildIdentity';
import { classifyDiagnosticFailure, configureLocalDiagnosticPersistence, createLocalDiagnosticTrace, recordLocalDiagnosticError, sanitizeDiagnosticText } from './localDiagnostics';
import { runPiMainPathRequestFile } from './piMainPathRuntime';
import { TelegramRuntimeWorkerHost } from './telegramRuntimeWorkerHost';
import { UnifiedDataStore } from './db/unifiedDataStore';
import { createRuntimeDataOperations } from './runtimeDataOperations';
import { normalizeGlobalDataPathForExtension, refreshProjectRegistry } from './projectRegistry';
import { isAutonomousRuntimeDisabled } from './autonomousRuntimeService';
import { importLegacyRuntimeState } from './runtimeStateMigration';
import { readRuntimePauseState, writeRuntimePauseState } from './runtimePauseState';
import { RuntimeDataExecutionDomains, RuntimeWriteActorControl } from './runtimeDataExecutionDomains';
import { activeCognitiveCliInvocationCount, cancelActiveCognitiveCliInvocations, signalCognitiveCliShutdown } from './localAgentCliEngine';
import { terminateRuntimeOwnedChildProcesses } from './runtimeChildProcessSupervisor';
import { reclaimOrphanedDatabaseGenerations, recoverPendingDatabaseGenerationCutover } from './databaseGeneration';
import { runtimeOperationDefinition } from './runtimeOperationRegistry';
import { executeTelegramExtensionCommand, registerTelegramEditorEndpoint } from './telegramExtensionBridge';
import { RuntimeExecutionScheduler } from './runtimePriorityScheduler';
import type { RuntimeExecutionDomain } from './runtimeOperationRegistry';
import { RuntimeControlProjection, type ProjectRegistryReadInput, type ProjectRegistryReadResult } from './runtimeControlProjection';
import type { ProjectRegistrySnapshot } from './projectRegistry';

function argumentValue(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

let closeFailedRuntimeInitialization: ((exitCode?: number, reason?: string) => Promise<void>) | undefined;
let runtimeInitializationId = '';

function isDatabaseGenerationCutoverError(error: unknown): boolean {
  return /(?:^|:)database_generation_cutover(?:$|:)|runtime_data_domain_exited:writer-actor:75/.test(String(error));
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
      recoverPendingDatabaseGenerationCutover(databaseRoot);
      reclaimOrphanedDatabaseGenerations(databaseRoot);
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
    recoverPendingDatabaseGenerationCutover(databaseRoot);
    reclaimOrphanedDatabaseGenerations(databaseRoot);
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
  recoverPendingDatabaseGenerationCutover(databaseRoot);
  reclaimOrphanedDatabaseGenerations(databaseRoot);
  const expectedDatabaseId = argumentValue('--database-id') || lease.owner.databaseId;
  const bootstrapStore = expectedDatabaseId || runtimeWasInitialized || fs.existsSync(path.join(databaseRoot, 'solomap.db'))
    ? UnifiedDataStore.open(databaseRoot, expectedDatabaseId || undefined)
    : new UnifiedDataStore(databaseRoot);
  const databaseId = bootstrapStore.databaseId;
  bootstrapStore.close();
  let dataExecutionDomains: RuntimeDataExecutionDomains | undefined;
  let autonomousCycle: AutonomousCycleExecutor | undefined;
  let runtimeDomainsClosed = false;
  closeFailedRuntimeInitialization = async () => {
    if (!runtimeDomainsClosed) {
      runtimeDomainsClosed = true;
      await dataExecutionDomains?.close().catch(() => undefined);
      updateRuntimeState(globalDataPath, runtimeId, { status: 'stopped' });
    }
  };
  const runtimeBuild = runtimeBuildId(path.dirname(path.dirname(path.resolve(process.argv[1]))));
  const releaseVersion = argumentValue('--runtime-version') || runtimeReleaseVersion(path.dirname(path.dirname(path.resolve(process.argv[1]))));
  const executionScheduler = new RuntimeExecutionScheduler();
  const controlProjection = new RuntimeControlProjection();
  let intelligenceExecutionMode: { mode: 'legacy' | 'harness' } | undefined;
  const dispatchSupervisorOperation = async (request: RuntimeDataRequest): Promise<unknown> => {
    if (request.operation === 'read_project_registry') {
      return controlProjection.readProjectRegistryWithFallback(request.input,
        (input: ProjectRegistryReadInput) => dataExecutionDomains!.control('read_project_registry_projection', input) as Promise<ProjectRegistryReadResult>);
    }
    if (request.operation === 'read_intelligence_execution_mode') {
      if (!intelligenceExecutionMode) throw new Error('runtime_intelligence_execution_mode_not_ready');
      return intelligenceExecutionMode;
    }
    if (request.operation === 'wait_sidebar_core_projection_revision') {
      return dataExecutionDomains!.dispatch(request);
    }
    if (request.operation === 'register_telegram_editor_endpoint') {
      return registerTelegramEditorEndpoint(globalDataPath,
        request.input as Parameters<typeof registerTelegramEditorEndpoint>[1]);
    }
    if (request.operation === 'execute_telegram_editor_command') {
      return executeTelegramExtensionCommand(globalDataPath, String(request.input.command || ''),
        Array.isArray(request.input.args) ? request.input.args.map(String) : []);
    }
    throw new Error(`runtime_supervisor_operation_unknown:${request.operation}`);
  };
  dataExecutionDomains = await RuntimeDataExecutionDomains.start({
    root: databaseRoot,
    databaseId,
    runtime: { runtimeId, releaseVersion, buildId: runtimeBuild },
    scheduler: executionScheduler,
    dispatchSupervisorOperation,
    onProjectRegistryProjection: snapshot => controlProjection.hydrateProjectRegistry(snapshot)
  });
  controlProjection.hydrateProjectRegistry(await dataExecutionDomains.control('read_project_registry_projection') as ProjectRegistrySnapshot | null);
  const dataOperations = dataExecutionDomains.operations;
  const scheduledOperations = Object.assign(
    (request: Parameters<typeof dataOperations>[0]) => {
      const definition = runtimeOperationDefinition(request.operation);
      if (definition.executor === 'supervisor') return dispatchSupervisorOperation(request);
      return executionScheduler.submit(definition.domain, () => dataOperations(request), {
        deadlineAt: request.deadlineAt,
        supersedesKey: request.supersedesKey,
        label: `internal:${request.operation}`
      });
    },
    dataOperations
  );
  const scheduleControl = <T = unknown>(domain: RuntimeExecutionDomain, action: RuntimeWriteActorControl, input: Record<string, unknown> = {}): Promise<T> =>
    executionScheduler.submit(domain, admission => dataExecutionDomains!.control(action, input, admission) as Promise<T>, { label: `internal:${action}` });
  const startAutonomousCycle = async (): Promise<AutonomousCycleExecutor> => {
    const executor = new AutonomousCycleExecutor({ globalDataPath, runtimeId, ownerPid: process.pid });
    await executor.ready();
    return executor;
  };
  updateRuntimeState(globalDataPath, runtimeId, { databaseId });
  let initializationTelegram: TelegramRuntimeWorkerHost | undefined;
  let heartbeatStopped: (() => Promise<unknown>) | undefined;
  let earlyCleanup: Promise<void> | undefined;
  closeFailedRuntimeInitialization = () => {
    if (earlyCleanup) return earlyCleanup;
    earlyCleanup = (async () => {
      await dataExecutionDomains?.control('interrupt').catch(() => undefined);
      await initializationTelegram?.close('handoff').catch(() => undefined);
      await autonomousCycle?.close().catch(() => undefined);
      await heartbeatStopped?.().catch(() => undefined);
      if (!runtimeDomainsClosed) {
        runtimeDomainsClosed = true;
        await dataExecutionDomains?.close().catch(() => undefined);
      }
      updateRuntimeState(globalDataPath, runtimeId, { status: 'stopped' });
    })();
    return earlyCleanup;
  };
  configureLocalDiagnosticPersistence({
    append: (_root, event) => scheduledOperations({ operation: 'append_diagnostic_event', input: event as unknown as Record<string, unknown> }).then(() => undefined),
    read: (_root) => scheduledOperations({ operation: 'read_diagnostic_events', input: { limit: 250 } }) as Promise<{ items: Record<string, unknown>[] }>
  }, databaseRoot);
  await dataExecutionDomains.control('import_legacy_diagnostics');
  const registeredRuntime = await dataOperations({ operation: 'register_runtime_instance', input: { runtimeId, pid: process.pid, processStartedAt: Date.parse(lease.owner.startedAt), processBirth: lease.owner.processBirth || '', status: 'running', buildId: runtimeBuild, idempotencyKey: `runtime-register:${runtimeId}` } }) as { generation: number };
  const heartbeatRuntime = (status: 'running' | 'paused' | 'stopped' | 'failed') => {
    const heartbeatAt = Date.now();
    return scheduledOperations({ operation: 'heartbeat_runtime_instance', input: { runtimeId, generation: registeredRuntime.generation, status, heartbeatAt, idempotencyKey: `runtime-heartbeat:${runtimeId}:${status}:${heartbeatAt}` } });
  };
  heartbeatStopped = () => heartbeatRuntime('stopped');
  intelligenceExecutionMode = await dataExecutionDomains.control('initialize_intelligence') as { mode: 'legacy' | 'harness' };
  await refreshCognitiveRuntimeConfig(databaseRoot, scheduledOperations);
  await refreshShadowRuntimeState(databaseRoot, scheduledOperations);
  let outboxRecovery: Promise<unknown> | undefined;
  let storageMaintenance: Promise<unknown> | undefined;
  let startupMigration: Promise<void> | undefined;
  let stopping = false;
  let paused = await readRuntimePauseState(scheduledOperations, isAutonomousRuntimeDisabled(globalDataPath));
  let running = false;
  let rerunRequested = false;
  let timer: NodeJS.Timeout | undefined;
  let databaseOverviewProjectionTimer: NodeJS.Timeout | undefined;
  let reportVersionBackfillTimer: NodeJS.Timeout | undefined;
  let plannerMaintenanceTimer: NodeJS.Timeout | undefined;
  let controlServer: { beginBusy(): () => void; close(mode?: 'drain' | 'handoff'): Promise<void> } | undefined;
  let telegram = initializationTelegram = new TelegramRuntimeWorkerHost(globalDataPath, scheduledOperations);
  await telegram.ready();
  let shutdownPromise: Promise<void> | undefined;
  let upgradeReplacement: { buildId: string; releaseVersion: string } | undefined;
  let documentationProjectionDrainRunning = false;
  let documentationProjectionDrainRequested = false;
  const scheduleDocumentationProjectionDrain = (): void => {
    if (stopping) return;
    documentationProjectionDrainRequested = true;
    if (documentationProjectionDrainRunning) return;
    documentationProjectionDrainRunning = true;
    setImmediate(() => {
      void (async () => {
        try {
          while (!stopping && documentationProjectionDrainRequested) {
            documentationProjectionDrainRequested = false;
            let result: { processed: number; pending: boolean };
            do {
              result = await scheduleControl('background-command', 'drain_documentation_projections');
              if (result.pending) await new Promise<void>(resolve => setImmediate(resolve));
            } while (!stopping && result.pending);
          }
        } catch (error) {
          recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.documentation-projection', error);
        } finally {
          documentationProjectionDrainRunning = false;
          if (documentationProjectionDrainRequested && !stopping) scheduleDocumentationProjectionDrain();
        }
      })();
    });
  };
  if (paused) { updateRuntimeState(globalDataPath, runtimeId, { status: 'paused' }); await heartbeatRuntime('paused'); }
  const stop = (exitCode = 0, reason = 'lease_lost'): Promise<void> => {
    if (exitCode !== 0) process.exitCode = exitCode;
    const handoff = reason === 'upgrade_drain';
    if (shutdownPromise) return shutdownPromise;
    if (!handoff) {
      signalCognitiveCliShutdown();
      cancelActiveCognitiveCliInvocations();
    }
    stopping = true;
    const shutdownTrace = createLocalDiagnosticTrace(globalDataPath, `runtime.shutdown.${reason}`, { targetId: runtimeId });
    shutdownTrace.record(`runtime.shutdown.${reason}`, exitCode ? 'error' : 'ok', 0, undefined, { pid: process.pid, exitCode });
    shutdownPromise = (async () => {
      let shutdownError: unknown;
      let intelligenceDrained = !handoff;
      const attempt = async (action: () => unknown | Promise<unknown>): Promise<void> => {
        try { await action(); }
        catch (error) { shutdownError ||= error; }
      };
      if (timer) clearInterval(timer);
      timer = undefined;
      if (databaseOverviewProjectionTimer) clearTimeout(databaseOverviewProjectionTimer);
      if (reportVersionBackfillTimer) clearTimeout(reportVersionBackfillTimer);
      if (plannerMaintenanceTimer) clearTimeout(plannerMaintenanceTimer);
      databaseOverviewProjectionTimer = undefined;
      reportVersionBackfillTimer = undefined;
      plannerMaintenanceTimer = undefined;
      shutdownTrace.record('runtime.shutdown.cognitive-invocations', 'ok', activeCognitiveCliInvocationCount());
      if (handoff) {
        try {
          if (!dataExecutionDomains) throw new Error('runtime_intelligence_drain_unavailable');
          await dataExecutionDomains.control('drain_intelligence');
          intelligenceDrained = true;
          shutdownTrace.record('runtime.shutdown.intelligence-drain', 'ok');
        } catch (error) {
          shutdownTrace.record('runtime.shutdown.intelligence-drain', 'error', 0, error);
          try { await dataExecutionDomains.control('resume_intelligence'); }
          catch (resumeError) {
            recordLocalDiagnosticError(globalDataPath, 'runtime.shutdown.intelligence-resume', resumeError);
            shutdownPromise = undefined;
            throw resumeError;
          }
          paused = await readRuntimePauseState(scheduledOperations, isAutonomousRuntimeDisabled(globalDataPath));
          stopping = false;
          upgradeReplacement = undefined;
          updateRuntimeState(globalDataPath, runtimeId, { status: paused ? 'paused' : 'running' });
          await heartbeatRuntime(paused ? 'paused' : 'running').catch(() => undefined);
          scheduleDatabaseOverviewProjectionBackfill(1_000);
          scheduleReportVersionBackfill(1_000);
          schedulePlannerMaintenance(30_000);
          if (!paused) runCycleObserved();
          timer = setInterval(runCycleObserved, intervalValue());
          shutdownPromise = undefined;
          throw error;
        }
      } else shutdownTrace.record('runtime.shutdown.intelligence-drain', 'ok');
      const controlClosed = controlServer?.close(handoff ? 'handoff' : 'drain');
      const telegramClosed = telegram?.close('handoff');
      await attempt(() => dataExecutionDomains?.control('interrupt'));
      shutdownTrace.record('runtime.shutdown.interrupt', shutdownError ? 'error' : 'ok');
      // Leaf runtimes must release their MCP sessions, inbox claims, and
      // accepted work while the shared data plane is still available.
      // Closing RPC first creates a circular shutdown dependency once data
      // connections are persistent.
      await attempt(() => telegramClosed);
      shutdownTrace.record('runtime.shutdown.telegram', shutdownError ? 'error' : 'ok');
      await attempt(() => autonomousCycle?.close());
      shutdownTrace.record('runtime.shutdown.autonomous-cycle', shutdownError ? 'error' : 'ok');
      await attempt(() => controlClosed);
      shutdownTrace.record('runtime.shutdown.control-server', shutdownError ? 'error' : 'ok');
      if (!handoff) terminateRuntimeOwnedChildProcesses();
      const replacement = upgradeReplacement;
      if (reason === 'upgrade_drain' && replacement && intelligenceDrained && !shutdownError) await attempt(() => dataExecutionDomains?.control('record_compatibility_drain', {
        runtimeId, releaseVersion, buildId: runtimeBuild,
        replacementVersion: replacement.releaseVersion, replacementBuildId: replacement.buildId
      }));
      await attempt(() => heartbeatRuntime('stopped'));
      shutdownTrace.record('runtime.shutdown.heartbeat', shutdownError ? 'error' : 'ok');
      if (!runtimeDomainsClosed) {
        runtimeDomainsClosed = true;
        await attempt(() => dataExecutionDomains?.close());
        shutdownTrace.record('runtime.shutdown.execution-domains', shutdownError ? 'error' : 'ok');
      }
      const backgroundSettlements = [startupMigration, storageMaintenance, outboxRecovery]
        .filter((value): value is Promise<unknown> => Boolean(value));
      await Promise.allSettled(backgroundSettlements);
      shutdownTrace.record('runtime.shutdown.background-settlement', 'ok', backgroundSettlements.length);
      updateRuntimeState(globalDataPath, runtimeId, { status: 'stopped' });
      if (shutdownError && reason !== 'database_generation_cutover') throw shutdownError;
    })();
    void shutdownPromise.catch(error => {
      process.stderr.write(`SoloMap Runtime shutdown: ${String(error)}\n`);
      if (!handoff) process.exitCode = 1;
    });
    process.exitCode ??= exitCode;
    return shutdownPromise;
  };
  closeFailedRuntimeInitialization = async (exitCode = 1, reason = 'initialization_failed') => {
    await stop(exitCode, reason).catch(() => undefined);
  };
  const stopAndExit = (exitCode: number, reason: string): void => {
    void stop(exitCode, reason).then(
      () => process.exit(process.exitCode ?? exitCode),
      () => { if (reason !== 'upgrade_drain') process.exit(process.exitCode ?? exitCode); }
    );
  };
  process.once('SIGTERM', () => stopAndExit(0, 'sigterm'));
  process.once('SIGINT', () => stopAndExit(0, 'sigint'));
  void dataExecutionDomains.waitForFatalFailure().catch(error => {
    const generationCutover = isDatabaseGenerationCutoverError(error);
    if (!generationCutover) recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.write-actor-failed', error);
    stopAndExit(generationCutover ? 75 : 1, generationCutover ? 'database_generation_cutover' : 'write_actor_failed');
  });
  void telegram.waitForFatalFailure().catch(error => {
    recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.telegram-worker-failed', error);
    stopAndExit(1, 'telegram_worker_failed');
  });
  try {
    // The endpoint is not published until bounded state repair required by
    // every request has completed. Long historical work remains post-ready
    // maintenance and is admitted by the shared scheduler below.
    await dataExecutionDomains.control('settle_redundant_upgrade_migrations');
    await dataExecutionDomains.control('recover_runs');
  } catch (error) {
    await dataExecutionDomains.control('storage_maintenance_failed', { error: String(error) }).catch(() => undefined);
    const generationCutover = isDatabaseGenerationCutoverError(error);
    await stop(generationCutover ? 75 : 1, generationCutover ? 'database_generation_cutover' : 'startup_failed');
    throw error;
  }
  try {
    controlServer = await startRuntimeControlServer({
    globalDataPath,
    runtimeId,
    entryPath: path.resolve(process.argv[1]),
    buildId: runtimeBuild,
    releaseVersion,
    owner: argumentValue('--runtime-owner') === 'service' ? 'service' : 'fallback',
    enforceOperationRegistry: true,
    scheduler: executionScheduler,
    executorActivity: () => ({ ...dataExecutionDomains!.activitySnapshot(), 'telegram-worker': telegram?.activity() }),
    onData: async (request, admission) => {
      const definition = runtimeOperationDefinition(request.operation);
      if (definition.executor === 'supervisor') return dispatchSupervisorOperation(request);
      const result = await dataExecutionDomains!.dispatchSerialized(request, admission);
      if (request.operation === 'sync_documentation_manifest' || request.operation === 'refresh_documentation_manifest') {
        scheduleDocumentationProjectionDrain();
      }
      return serializedRuntimeDataResult(result);
    },
    async onCommand(command, replacement) {
      if (command === 'pause' || command === 'drain') {
        paused = true;
        if (command === 'pause') await writeRuntimePauseState(scheduledOperations, true);
        if (command === 'drain') upgradeReplacement = replacement;
        updateRuntimeState(globalDataPath, runtimeId, { status: 'paused' });
        await heartbeatRuntime('paused');
        if (command === 'drain') setTimeout(() => stopAndExit(0, 'upgrade_drain'), 25).unref();
        return { status: 'paused' };
      }
      if (command === 'resume') {
        await writeRuntimePauseState(scheduledOperations, false);
        paused = false;
        if (!telegram) {
          telegram = new TelegramRuntimeWorkerHost(globalDataPath, scheduledOperations);
          await telegram.ready();
          void telegram.waitForFatalFailure().catch(error => {
            recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.telegram-worker-failed', error);
            stopAndExit(1, 'telegram_worker_failed');
          });
        }
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
        stopAndExit(0, 'control_stop');
        return { status: 'stopped' };
      }
      return { status: paused ? 'paused' : 'running' };
    }
    });
    autonomousCycle = await startAutonomousCycle();
  } catch (error) {
    await dataExecutionDomains.control('storage_maintenance_failed', { error: String(error) }).catch(() => undefined);
    await stop(1, 'control_start_failed').catch(() => undefined);
    throw error;
  }
  scheduleDocumentationProjectionDrain();
  function scheduleDatabaseOverviewProjectionBackfill(delayMs: number): void {
    if (stopping || databaseOverviewProjectionTimer) return;
    databaseOverviewProjectionTimer = setTimeout(() => {
      databaseOverviewProjectionTimer = undefined;
      if (stopping) return;
      void sendRuntimeDataRequest<{ processed: number; complete: boolean }>(databaseRoot, {
        operation: 'backfill_database_overview_projection',
        input: { limit: 2_000, idempotencyKey: 'database-overview-projection-v64' },
        deadlineAt: Date.now() + 1_000
      }).then(
        result => { if (!result.complete) scheduleDatabaseOverviewProjectionBackfill(100); },
        error => {
          if (!stopping) {
            process.stderr.write(`SoloMap database overview projection: ${String(error)}\n`);
            scheduleDatabaseOverviewProjectionBackfill(1_000);
          }
        }
      );
    }, delayMs);
    databaseOverviewProjectionTimer.unref();
  }
  scheduleDatabaseOverviewProjectionBackfill(5_000);
  function scheduleReportVersionBackfill(delayMs: number): void {
    if (stopping || reportVersionBackfillTimer) return;
    reportVersionBackfillTimer = setTimeout(() => {
      reportVersionBackfillTimer = undefined;
      if (stopping) return;
      void scheduleControl<{ processed: number; complete: boolean }>('maintenance', 'backfill_report_versions').then(
        result => { if (!result.complete) scheduleReportVersionBackfill(25); },
        error => {
          if (!stopping) {
            process.stderr.write(`SoloMap report index maintenance: ${String(error)}\n`);
            scheduleReportVersionBackfill(1_000);
          }
        }
      );
    }, delayMs);
    reportVersionBackfillTimer.unref();
  }
  function schedulePlannerMaintenance(delayMs: number): void {
    if (stopping || plannerMaintenanceTimer) return;
    plannerMaintenanceTimer = setTimeout(() => {
      plannerMaintenanceTimer = undefined;
      if (stopping) return;
      void scheduleControl('maintenance', 'maintain_planner_statistics')
        .catch(error => recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.planner-statistics', classifyDiagnosticFailure(error)));
    }, delayMs);
    plannerMaintenanceTimer.unref();
  }
  scheduleReportVersionBackfill(5_000);
  const startupMaintenanceQuantum = <T>(action: () => Promise<T>, label: string): Promise<T> =>
    executionScheduler.submit('maintenance', action, { label });
  const startupMigrationReady = (async () => {
    // Give the first host/user action a reserved admission window. Every later
    // step is a separate maintenance quantum and cannot start while foreground
    // work is active or queued.
    const admissionAt = Date.now() + 1_000;
    while (!stopping && Date.now() < admissionAt) await new Promise(resolve => setTimeout(resolve, Math.min(100, admissionAt - Date.now())));
    if (stopping) return;
    const releaseStartupMigrationBusy = controlServer!.beginBusy();
    try {
      await startupMaintenanceQuantum(() => dataExecutionDomains!.control('recover_migrations'), 'internal:recover-migrations');
      await startupMaintenanceQuantum(() => dataExecutionDomains!.control('recover_outbox'), 'internal:recover-outbox');
      await startupMaintenanceQuantum(() => dataExecutionDomains!.control('enqueue_startup_migrations', {
        phase: 'registry'
      }), 'internal:startup-initialize-registry');
      const registry = controlProjection.readProjectRegistry({}) as {
        registry?: { projects?: Array<{ path?: string; name?: string }> };
      } | null;
      const projects = Array.isArray(registry?.registry?.projects) ? registry!.registry!.projects! : [];
      const admitRequests = async (requests: RuntimeDataRequest[]): Promise<void> => {
        for (const request of requests) {
          if (stopping) return;
          await startupMaintenanceQuantum(
            () => dataOperations(request),
            `internal:startup-migration:${request.operation}`
          );
        }
      };
      for (const project of projects) {
        if (stopping) break;
        if (!path.isAbsolute(String(project.path || ''))) continue;
        const root = path.resolve(String(project.path));
        await startupMaintenanceQuantum(() => dataExecutionDomains!.control('enqueue_startup_migrations', {
          phase: 'register', root, name: String(project.name || '')
        }), 'internal:startup-register-project');
        const discovered = await startupMaintenanceQuantum(() => dataExecutionDomains!.control('enqueue_startup_migrations', {
          phase: 'project', root
        }) as Promise<{ requests: RuntimeDataRequest[] }>, 'internal:startup-discover-project');
        await admitRequests(discovered.requests || []);
      }
      if (!stopping) {
        const discovered = await startupMaintenanceQuantum(() => dataExecutionDomains!.control('enqueue_startup_migrations', {
          phase: 'global'
        }) as Promise<{ requests: RuntimeDataRequest[] }>, 'internal:startup-discover-global');
        await admitRequests(discovered.requests || []);
      }
      if (!stopping) await startupMaintenanceQuantum(() => dataExecutionDomains!.control('wait_for_migrations'), 'internal:wait-for-migrations');
      if (!stopping) {
        const recovered = await startupMaintenanceQuantum(() => dataExecutionDomains!.control('reap_finished_legacy_runs') as Promise<{ conflicts: string[] }>, 'internal:reap-legacy-runs');
        for (const conflict of recovered.conflicts) process.stderr.write(`SoloMap legacy run recovery: ${conflict}\n`);
      }
    } finally { releaseStartupMigrationBusy(); }
  })();
  outboxRecovery = startupMigrationReady;
  void startupMigrationReady.then(() => scheduleControl('maintenance', 'recover_intelligence'))
    .catch(error => process.stderr.write(`SoloMap intelligence recovery: ${String(error)}\n`));
  void startupMigrationReady.then(
    () => scheduleControl('runtime-event', 'storage_maintenance_ready'),
    error => scheduleControl('runtime-event', 'storage_maintenance_failed', { error: String(error) })
  ).catch(error => process.stderr.write(`SoloMap storage maintenance barrier: ${String(error)}\n`));
  startupMigration = startupMigrationReady.catch(error => { process.stderr.write(`SoloMap Runtime memory migration: ${String(error)}\n`); });
  void startupMigrationReady.catch(error => {
    const generationCutover = isDatabaseGenerationCutoverError(error);
    if (generationCutover) {
      stopAndExit(75, 'database_generation_cutover');
      return;
    }
    recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.migration.failed', error);
    stopAndExit(1, 'migration_failed');
  });
  storageMaintenance = (async () => {
    await startupMigrationReady;
    if (!stopping) await scheduledOperations({ operation: 'maintain_database_storage', input: { compact: false, automatic: true } });
  })().catch(error => { process.stderr.write(`SoloMap Runtime storage maintenance: ${String(error)}\n`); });
  void startupMigrationReady.then(
    () => schedulePlannerMaintenance(30_000),
    () => undefined
  );
  function runCycleObserved(): void {
    void runCycle().catch(error => {
      recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.cycle.fatal', classifyDiagnosticFailure(error));
    });
  }
  async function runCycle(): Promise<void> {
    if (stopping || running) return;
    running = true;
    let executor: AutonomousCycleExecutor | undefined;
    try {
      executor = autonomousCycle ||= await startAutonomousCycle();
      const result = await executor.run(paused);
      if (result.diagnosticError) {
        recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.cycle', classifyDiagnosticFailure(result.diagnosticError));
      }
      if (result.leaseLost) {
        stopAndExit(0, 'lease_lost');
        return;
      }
      updateRuntimeState(globalDataPath, runtimeId, { status: paused ? 'paused' : 'running' });
      await heartbeatRuntime(paused ? 'paused' : 'running');
    } catch (error) {
      if (!stopping) {
        recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.cycle.fatal', classifyDiagnosticFailure(error));
        if (executor && autonomousCycle === executor) autonomousCycle = undefined;
        await executor?.close().catch(() => undefined);
      }
    } finally {
      running = false;
      if (rerunRequested && !stopping) {
        rerunRequested = false;
        runCycleObserved();
      }
    }
  }
  runCycleObserved();
  timer = setInterval(runCycleObserved, intervalValue());
}

void main().catch(async error => {
  const globalDataPath = argumentValue('--global-data-path');
  const generationCutover = isDatabaseGenerationCutoverError(error);
  const failureReason = sanitizeDiagnosticText(error);
  const failureCode = /^[a-z0-9_]{1,80}$/i.test(failureReason) ? failureReason : classifyDiagnosticFailure(error);
  if (globalDataPath && !generationCutover) recordLocalDiagnosticError(globalDataPath, 'autonomous-runtime.initialize', failureCode);
  try { await closeFailedRuntimeInitialization?.(generationCutover ? 75 : 1, generationCutover ? 'database_generation_cutover' : 'initialization_failed'); }
  catch (cleanupError) { process.stderr.write(`SoloMap Runtime initialization cleanup: ${String(cleanupError)}\n`); }
  const runtimeId = argumentValue('--runtime-id') || runtimeInitializationId;
  if (globalDataPath && runtimeId && !generationCutover) updateRuntimeState(globalDataPath, runtimeId, { status: 'failed', failureCode, failureReason });
  if (!generationCutover) process.stderr.write(`SoloMap Runtime could not initialize autonomous execution: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = generationCutover ? 75 : 1;
});
