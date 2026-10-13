import { RuntimeDataRequest, sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { DataWrite, UnifiedDataStore } from './db/unifiedDataStore';
import type { UnifiedMcpSource } from './unifiedMcp';
import * as crypto from 'crypto';
import type { DataObject } from './db/unifiedDataStore';
import { agentReadableObject as agentObject, canAgentDiscover, canAgentRead, validateAgentLink, validateAgentWrite } from './dataAuthorization';
import { DatabaseMigrationCoordinator } from './databaseMigrationCoordinator';
import * as fs from 'fs';
import * as path from 'path';
import { RunInputMaterialization } from './runInputMaterialization';
import { configureAgentDatabase, databaseAgentProviders, DatabaseAgentProvider, isAgentDatabaseConfigPath } from './agentDatabaseConfig';
import { MigrationProjectScope, MigrationRecycling } from './migrationRecycling';
import { isRetirableRunArtifact, initializeProjectJournalAllocation } from './projectDataMigration';
import { enqueueAvailableDataMigrations } from './runtimeDatabaseBootstrap';
import { validateTaskReport } from './taskReport';
import { RunRecovery } from './runRecovery';
import { RunNativeObserver } from './runNativeObserver';
import { snapshotWorkspace, captureRunGitEvidence, readWorkspaceGitHead } from './runWorkspace';
import { RunStop } from './runStop';
import { registerTelegramEditorEndpoint } from './telegramExtensionBridge';
import { persistTelegramRuntimeSecret } from './telegramRuntimeConfig';
import { migrationRunKinds, soloConversationRunKinds } from './runLifecycleTypes';

export interface RuntimeDataOperations {
  (request: RuntimeDataRequest): Promise<unknown>;
  setStorageMaintenanceBarrier(barrier: Promise<unknown>): void;
  recoverMigrations(): void;
  recoverRuns(): void;
  interruptRuns(): void;
  waitForMigrations(): Promise<void>;
  close(): Promise<void>;
}

export interface McpRunIdentity { executionLogId: number; generation: number; proof: string }
type MigrationRunKind = typeof migrationRunKinds[number];

function normalizeObjectReference(value: unknown): string {
  const raw = String(value || '');
  const uri = raw.match(/^solomap:\/(?:\/)?(?:objects|asset)\/([a-f0-9-]{36})$/);
  return uri ? uri[1] : raw;
}

export function createRuntimeDataOperations(store: UnifiedDataStore): RuntimeDataOperations {
  const migrations = new DatabaseMigrationCoordinator(store);
  const recycling = new MigrationRecycling(store);
  const runStops = new RunStop(store);
  const runs = new RunRecovery(store, runStops);
  const runInputs = new RunInputMaterialization(store);
  let storageMaintenanceTail: Promise<void> = Promise.resolve();
  let storageMaintenanceBarrier: Promise<unknown> = Promise.resolve();
  type ProjectSession = { kind: 'project'; actorId: string; scope: string; runIdentity?: McpRunIdentity; reviewBatchId?: string; migrationKind?: MigrationRunKind; migrationTargetId?: string | null; migrationProjectRoot?: string | null; migrationProjectId?: string | null; migrationPhysicalRoot?: string | null };
  const sessions = new Map<string, ProjectSession>();
  const samePhysicalRoot = (left: string, right: string): boolean => {
    try { return fs.realpathSync(left) === fs.realpathSync(right); } catch { return path.resolve(left) === path.resolve(right); }
  };
  const migrationScope = async (input: Record<string, unknown>): Promise<MigrationProjectScope | undefined> => {
    if (input.projectRoot === undefined) return undefined;
    const requested = String(input.projectRoot || '');
    if (!path.isAbsolute(requested)) throw new Error('project_scope_required');
    const registered = store.registeredProjectScopes().find(candidate => samePhysicalRoot(candidate.root, requested));
    if (!registered) throw new Error('project_scope_denied');
    let physicalRoot: string;
    try { physicalRoot = fs.realpathSync(registered.root); } catch { throw new Error('project_scope_denied'); }
    return { root: path.resolve(registered.root), projectId: registered.projectId, physicalRoot };
  };
  const allowedRead = (object: DataObject, session: ProjectSession): boolean => canAgentRead(object, session.scope, session.reviewBatchId, store.learningReviewScopeCurrent(object));
  const runProject = async (input: Record<string, unknown>): Promise<{ projectId: string }> => {
    if (input.projectId) {
      const projectId = String(input.projectId);
      if (store.readMetadata(projectId).kind !== 'project') throw new Error('project_scope_required');
      return { projectId };
    }
    return store.registerProject({ root: String(input.root || '') });
  };
  const withRoadmapBackup = async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if ((input.metadata as Record<string, unknown> | undefined)?.captureRoadmapBackup !== true) return input;
    try {
      const bytes = await fs.promises.readFile(path.join(String(input.root), '.solopreneur', 'roadmap.csv'));
      return { ...input, roadmapBackup: bytes.toString('base64') };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return input; throw error; }
  };
  const maintainDatabaseStorage = (compact: boolean, automatic: boolean) => {
    const operation = storageMaintenanceTail.catch(() => undefined).then(async () => {
      await storageMaintenanceBarrier;
      const currentSize = store.databaseStorageFileSizes();
      store.recoverInterruptedDatabaseStorageMaintenance(Date.now(), currentSize.databaseBytes);
      if (automatic && !store.hasPendingDatabaseStorageCleanup() && !store.hasStaleSolomapTestProjectRegistrations()) return { skipped: true, reason: 'storage_current' };
      const startedAt = Date.now(), before = currentSize;
      const totals = { deletedArtifacts: 0, deletedSources: 0, deletedContents: 0, reclaimedStoredBytes: 0 };
      const maintenanceId = store.beginDatabaseStorageMaintenance(startedAt, before.databaseBytes);
      try {
        const retiredTestProjects = store.cleanupStaleSolomapTestProjectRegistrations();
        let indexCursor = 0;
        for (;;) {
          const batch = store.protectIndexedRunArtifactOutputsBatch(indexCursor, 250);
          if (batch.nextCursor === null) break;
          indexCursor = batch.nextCursor;
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        for (;;) {
          const batch = store.cleanupDatabaseStorageBatch(5000, maintenanceId);
          totals.deletedArtifacts += batch.deletedArtifacts; totals.deletedSources += batch.deletedSources;
          if (!batch.pending) break;
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        if (store.hasDatabaseStorageCleanupCandidates()) {
          store.prepareDatabaseStorageCleanup();
          if (store.hasDatabaseStorageCleanupCandidates()) {
            for (const table of ['object_revisions', 'learning_review_controls', 'legacy_learning_review_controls', 'legacy_learning_review_cursor_inputs'] as const) {
              let cursor = 0;
              for (;;) {
                const batch = store.protectDatabaseStorageCleanupReferencesBatch(table, cursor, 250);
                if (batch.nextCursor === null) break;
                cursor = batch.nextCursor;
                await new Promise<void>(resolve => setImmediate(resolve));
              }
            }
            for (;;) {
              const batch = store.finalizeDatabaseStorageCleanupBatch(250, maintenanceId);
              totals.deletedContents += batch.deletedContents; totals.reclaimedStoredBytes += batch.reclaimedStoredBytes;
              if (!batch.pending) break;
              await new Promise<void>(resolve => setImmediate(resolve));
            }
          }
        }
        const integrity = compact ? store.compactDatabaseStorage().integrity : 'not_checked';
        const after = store.databaseStorageFileSizes(); const finishedAt = Date.now();
        store.settleDatabaseStorageMaintenance(maintenanceId, { status: 'completed', finishedAt, ...totals, compacted: compact, afterBytes: after.databaseBytes, integrity });
        return { ...totals, retiredTestProjects, compacted: compact, integrity, beforeBytes: before.databaseBytes, afterBytes: after.databaseBytes, pendingByproductRecords: 0 };
      } catch (error) {
        const after = store.databaseStorageFileSizes();
        store.settleDatabaseStorageMaintenance(maintenanceId, { status: 'failed', finishedAt: Date.now(), error: String(error), ...totals, compacted: false, afterBytes: after.databaseBytes, integrity: 'not_checked' });
        throw error;
      }
    });
    storageMaintenanceTail = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const dispatch = async (request: RuntimeDataRequest): Promise<unknown> => {
    if (!request || typeof request.operation !== 'string' || !request.input || typeof request.input !== 'object') throw new Error('invalid_data_request');
    const input = request.input;
    switch (request.operation) {
      case 'register_telegram_editor_endpoint': return registerTelegramEditorEndpoint(String(input.globalDataPath || store.root), input as Parameters<typeof registerTelegramEditorEndpoint>[1]);
      case 'install_runtime_secret': persistTelegramRuntimeSecret(store.root, String(input.secretRef || ''), String(input.value || '')); return { installed: true };
      case 'accept_roadmap_csv': return store.acceptRoadmapCsv(input as unknown as Parameters<UnifiedDataStore['acceptRoadmapCsv']>[0]);
      case 'read_roadmap': return store.readRoadmap(input as unknown as Parameters<UnifiedDataStore['readRoadmap']>[0]);
      case 'update_roadmap': return store.updateRoadmap(input as unknown as Parameters<UnifiedDataStore['updateRoadmap']>[0]);
      case 'resolve_roadmap_conflict': return store.resolveRoadmapConflict(input as unknown as Parameters<UnifiedDataStore['resolveRoadmapConflict']>[0]);
      case 'open_mcp_session': {
        const scope = String(input.projectId || '');
        const runIdentity = input.runIdentity as McpRunIdentity | undefined;
        const authorizedRun = runIdentity ? store.authorizedRunState(scope, runIdentity) : undefined;
        const runKind = String(authorizedRun?.status.runKind || '');
        const migrationKind = migrationRunKinds.includes(runKind as MigrationRunKind) ? runKind as MigrationRunKind : undefined;
        const migrationProjectRoot = migrationKind ? String(authorizedRun?.status.migrationProjectRoot || '') || null : null;
        const soloProjectRoot = soloConversationRunKinds.includes(runKind as typeof soloConversationRunKinds[number])
          ? String(authorizedRun?.status.workspaceRoot || '') || null
          : null;
        const migrationProject = migrationProjectRoot || soloProjectRoot
          ? await migrationScope({ projectRoot: migrationProjectRoot || soloProjectRoot })
          : undefined;
        if (migrationProject && migrationProject.projectId !== scope) throw new Error('maintenance_scope_denied');
        const reviewBatchId = runIdentity ? store.authorizedLearningReviewBatch(scope, runIdentity) : undefined;
        const identity = store.establishMcpActor(scope, input.resume as { actorId: string; proof: string } | undefined);
        const sessionToken = crypto.randomBytes(32).toString('hex');
        sessions.set(sessionToken, { kind: 'project', actorId: identity.actorId, scope, runIdentity, reviewBatchId, migrationKind,
          migrationTargetId: migrationKind ? String(authorizedRun?.status.migrationTargetId || '') || null : undefined,
          migrationProjectRoot: migrationProject?.root || null,
          migrationProjectId: migrationProject?.projectId || null,
          migrationPhysicalRoot: migrationProject?.physicalRoot || null });
        return { ...identity, sessionToken, runKind, migrationKind: migrationKind || null };
      }
      case 'close_mcp_session': {
        const token = String(input.sessionToken || '');
        const session = sessions.get(token);
        if (session?.kind === 'project') store.closeMcpActor(session.actorId, session.scope);
        sessions.delete(token);
        return { closed: true };
      }
      case 'register_project': return store.registerProject(input as unknown as Parameters<UnifiedDataStore['registerProject']>[0]);
      case 'read_capability_registry': return store.readCapabilityRegistry(input as unknown as Parameters<UnifiedDataStore['readCapabilityRegistry']>[0]);
      case 'patch_capability_registry': return store.patchCapabilityRegistry(input as unknown as Parameters<UnifiedDataStore['patchCapabilityRegistry']>[0]);
      case 'begin_capability_operation': return store.beginCapabilityOperation(input as unknown as Parameters<UnifiedDataStore['beginCapabilityOperation']>[0]);
      case 'attach_capability_operation': return store.attachCapabilityOperation(input as unknown as Parameters<UnifiedDataStore['attachCapabilityOperation']>[0]);
      case 'read_capability_operations': return store.readCapabilityOperations(input as unknown as Parameters<UnifiedDataStore['readCapabilityOperations']>[0]);
      case 'read_capability_operation_run_state': return store.readCapabilityOperationRunState(input as unknown as Parameters<UnifiedDataStore['readCapabilityOperationRunState']>[0]);
      case 'read_capability_operation_result': return store.readCapabilityOperationResult(input as unknown as Parameters<UnifiedDataStore['readCapabilityOperationResult']>[0]);
      case 'fail_capability_operation': return store.failCapabilityOperation(input as unknown as Parameters<UnifiedDataStore['failCapabilityOperation']>[0]);
      case 'complete_capability_operation': return store.completeCapabilityOperation(input as unknown as Parameters<UnifiedDataStore['completeCapabilityOperation']>[0]);
      case 'read_capability_evidence': return store.readCapabilityEvidence(input as unknown as Parameters<UnifiedDataStore['readCapabilityEvidence']>[0]);
      case 'write_internal_attachment': {
        const project = await runProject(input);
        return store.writeInternalAttachment(project.projectId, input as unknown as Parameters<UnifiedDataStore['writeInternalAttachment']>[1]);
      }
      case 'read_internal_attachment': {
        const project = await runProject(input);
        return store.readInternalAttachment(project.projectId, input as unknown as Parameters<UnifiedDataStore['readInternalAttachment']>[1]);
      }
      case 'initialize_project_registry': return store.initializeProjectRegistry(input as Parameters<UnifiedDataStore['initializeProjectRegistry']>[0]);
      case 'read_project_registry': return store.readProjectRegistry(input as Parameters<UnifiedDataStore['readProjectRegistry']>[0]);
      case 'patch_project_registry': return store.patchProjectRegistry(input as unknown as Parameters<UnifiedDataStore['patchProjectRegistry']>[0]);
      case 'read_host_settings': return store.readHostSettings(input as Parameters<UnifiedDataStore['readHostSettings']>[0]);
      case 'patch_host_settings': return store.patchHostSettings(input as unknown as Parameters<UnifiedDataStore['patchHostSettings']>[0]);
      case 'migrate_host_secret_state': return store.migrateHostSecretState(input as Parameters<UnifiedDataStore['migrateHostSecretState']>[0]);
      case 'project_cognitive_runtime_config': return store.projectCognitiveRuntimeConfig(input as Parameters<UnifiedDataStore['projectCognitiveRuntimeConfig']>[0]);
      case 'read_project_autonomy_authorization': return store.readProjectAutonomyAuthorization(input as Parameters<UnifiedDataStore['readProjectAutonomyAuthorization']>[0]);
      case 'patch_project_autonomy_authorization': return store.patchProjectAutonomyAuthorization(input as unknown as Parameters<UnifiedDataStore['patchProjectAutonomyAuthorization']>[0]);
      case 'revoke_project_autonomy_authorizations': return store.revokeProjectAutonomyAuthorizations(input as Parameters<UnifiedDataStore['revokeProjectAutonomyAuthorizations']>[0]);
      case 'append_diagnostic_event': return store.appendDiagnosticEvent(input as Parameters<UnifiedDataStore['appendDiagnosticEvent']>[0]);
      case 'read_diagnostic_events': return store.readDiagnosticEvents(input as Parameters<UnifiedDataStore['readDiagnosticEvents']>[0]);
      case 'record_native_projection': return store.recordNativeProjection(input as Parameters<UnifiedDataStore['recordNativeProjection']>[0]);
      case 'is_recent_native_projection': return store.isRecentNativeProjection(input as Parameters<UnifiedDataStore['isRecentNativeProjection']>[0]);
      case 'consume_native_projection': return store.consumeNativeProjection(input as Parameters<UnifiedDataStore['consumeNativeProjection']>[0]);
      case 'cancel_native_projection': return store.cancelNativeProjection(input as Parameters<UnifiedDataStore['cancelNativeProjection']>[0]);
      case 'supersede_native_projections': return store.supersedeNativeProjections(input as Parameters<UnifiedDataStore['supersedeNativeProjections']>[0]);
      case 'read_ui_state': return store.readUiState(input as Parameters<UnifiedDataStore['readUiState']>[0]);
      case 'patch_ui_state': return store.patchUiState(input as unknown as Parameters<UnifiedDataStore['patchUiState']>[0]);
      case 'sync_schedules': return store.syncSchedules(input as unknown as Parameters<UnifiedDataStore['syncSchedules']>[0]);
      case 'read_schedule_sync_state': return store.readScheduleSyncState();
      case 'claim_due_schedules': return store.claimDueSchedules(input as unknown as Parameters<UnifiedDataStore['claimDueSchedules']>[0]);
      case 'read_schedule_ledger': return store.readScheduleLedger();
      case 'restore_legacy_scheduled_occurrences': return store.restoreLegacyScheduledOccurrences(input as unknown as Parameters<UnifiedDataStore['restoreLegacyScheduledOccurrences']>[0]);
      case 'settle_schedule_occurrence': return store.settleScheduleOccurrence(input as unknown as Parameters<UnifiedDataStore['settleScheduleOccurrence']>[0]);
      case 'accept_inbox_message': return store.acceptInboxMessage(input as unknown as Parameters<UnifiedDataStore['acceptInboxMessage']>[0]);
      case 'claim_inbox_messages': return store.claimInboxMessages(input as unknown as Parameters<UnifiedDataStore['claimInboxMessages']>[0]);
      case 'begin_inbox_action': return store.beginInboxAction(input as unknown as Parameters<UnifiedDataStore['beginInboxAction']>[0]);
      case 'settle_inbox_action': return store.settleInboxAction(input as unknown as Parameters<UnifiedDataStore['settleInboxAction']>[0]);
      case 'import_legacy_telegram_conversations': return store.importLegacyTelegramConversationIds(input as Parameters<UnifiedDataStore['importLegacyTelegramConversationIds']>[0]);
      case 'reconcile_unknown_inbox_actions': return store.reconcileUnknownInboxActions(input as unknown as Parameters<UnifiedDataStore['reconcileUnknownInboxActions']>[0]);
      case 'acknowledge_inbox_message': return store.acknowledgeInboxMessage(input as unknown as Parameters<UnifiedDataStore['acknowledgeInboxMessage']>[0]);
      case 'release_inbox_message': return store.releaseInboxMessage(input as unknown as Parameters<UnifiedDataStore['releaseInboxMessage']>[0]);
      case 'register_runtime_instance': return store.registerRuntimeInstance(input as unknown as Parameters<UnifiedDataStore['registerRuntimeInstance']>[0]);
      case 'heartbeat_runtime_instance': return store.heartbeatRuntimeInstance(input as unknown as Parameters<UnifiedDataStore['heartbeatRuntimeInstance']>[0]);
      case 'read_learning_overview': return store.readLearningOverview();
      case 'read_rsi_cycles': {
        const project = await runProject(input);
        return store.readRsiCycles(project.projectId, input);
      }
      case 'record_run_verification': {
        const project = await runProject(input);
        return store.recordRunVerification(project.projectId, input as unknown as Parameters<UnifiedDataStore['recordRunVerification']>[1]);
      }
      case 'sync_external_memory': {
        const project = await runProject(input);
        return store.syncExternalMemory(project.projectId, input as unknown as Parameters<UnifiedDataStore['syncExternalMemory']>[1]);
      }
      case 'read_external_memory_targets': {
        const project = await runProject(input);
        return store.readExternalMemoryTargets(project.projectId);
      }
      case 'revoke_external_memory_target': {
        const project = await runProject(input);
        return store.revokeExternalMemoryTarget(project.projectId, input as unknown as Parameters<UnifiedDataStore['revokeExternalMemoryTarget']>[1]);
      }
      case 'reconcile_external_memory_target': {
        const project = await runProject(input);
        return store.reconcileExternalMemoryTarget(project.projectId, input as unknown as Parameters<UnifiedDataStore['reconcileExternalMemoryTarget']>[1]);
      }
      case 'record_learning_cycle': {
        const project = await runProject(input);
        const { root: _root, projectId: _projectId, ...cycle } = input;
        return store.recordLearningCycle(project.projectId, cycle as unknown as Parameters<UnifiedDataStore['recordLearningCycle']>[1]);
      }
      case 'read_learning_source_revision': return store.readLearningSourceRevision();
      case 'read_global_prompt_policy': return store.readGlobalPromptPolicy();
      case 'save_global_prompt': return store.saveGlobalPrompt(input as unknown as Parameters<UnifiedDataStore['saveGlobalPrompt']>[0]);
      case 'prepare_learning_review': return store.prepareLearningReview(input as unknown as Parameters<UnifiedDataStore['prepareLearningReview']>[0]);
      case 'apply_learning_review': return store.applyLearningReview(input as unknown as Parameters<UnifiedDataStore['applyLearningReview']>[0]);
      case 'finish_learning_review': return store.finishLearningReview(input as unknown as Parameters<UnifiedDataStore['finishLearningReview']>[0]);
      case 'interrupt_learning_review': return store.interruptLearningReview(String(input.batchId || ''));
      case 'recover_run_inputs': return runInputs.recover();
      case 'materialize_run_prompt':
      case 'release_run_prompt': {
        const project = await runProject(input);
        const executionLogId = Number(input.executionLogId); const generation = Number(input.generation);
        store.verifyRunExecutionProof(project.projectId, executionLogId, generation, String(input.proof || ''));
        return request.operation === 'materialize_run_prompt' ? runInputs.materialize({ projectId: project.projectId, executionLogId, generation }) : runInputs.release({ projectId: project.projectId, executionLogId, generation });
      }
      case 'prepare_flow_role': {
        await initializeProjectJournalAllocation(store, String(input.root || ''));
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.prepareFlowRole(project.projectId, project.locationId, input as unknown as Parameters<UnifiedDataStore['prepareFlowRole']>[2]);
      }
      case 'read_run_intent': {
        const project = await runProject(input);
        return store.readRunIntent(project.projectId, String(input.launchIntentId || ''));
      }
      case 'prepare_run_intent': {
        await initializeProjectJournalAllocation(store, String(input.root || ''));
        const project = await store.registerProject({ root: String(input.root || '') });
        const prepared = store.readRunIntent(project.projectId, String(input.launchIntentId || '')) ? input : await withRoadmapBackup(input);
        return store.prepareRunIntent(project.projectId, project.locationId, prepared as unknown as Parameters<UnifiedDataStore['prepareRunIntent']>[2]);
      }
      case 'read_run_slot': {
        const project = await runProject(input);
        return store.readRunSlot(project.projectId, String(input.launchSlotId || ''), input.launchSlotScope === 'global' ? 'global' : 'project');
      }
      case 'prepare_run_slot': {
        await initializeProjectJournalAllocation(store, String(input.root || ''));
        const project = await store.registerProject({ root: String(input.root || '') });
        const scope = input.launchSlotScope === 'global' ? 'global' : 'project';
        const prepared = store.readRunSlot(project.projectId, String(input.launchSlotId || ''), scope) ? input : await withRoadmapBackup(input);
        return store.prepareRunSlot(project.projectId, project.locationId, prepared as unknown as Parameters<UnifiedDataStore['prepareRunSlot']>[2]);
      }
      case 'prepare_run': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.prepareRun(project.projectId, project.locationId, await withRoadmapBackup(input) as unknown as Parameters<UnifiedDataStore['prepareRun']>[2]);
      }
      case 'read_run_state': {
        const project = await runProject(input);
        return store.readRunState(project.projectId, Number(input.executionLogId), input.revision === undefined ? undefined : Number(input.revision));
      }
      case 'read_run_execution_plan': {
        const project = await runProject(input);
        return store.readRunExecutionPlan(project.projectId, Number(input.executionLogId));
      }
      case 'read_run_launch_permission': {
        const project = await runProject(input);
        return store.readRunLaunchPermission(project.projectId, input as unknown as Parameters<UnifiedDataStore['readRunLaunchPermission']>[1]);
      }
      case 'read_run_checkpoint_state': {
        const project = await runProject(input);
        return store.readRunCheckpointState(project.projectId, Number(input.executionLogId));
      }
      case 'read_run_turn_journal': {
        const project = await runProject(input);
        return store.readRunTurnJournal(project.projectId, Number(input.executionLogId), input.turnId === undefined ? undefined : String(input.turnId));
      }
      case 'resolve_run_conversation': {
        const project = await runProject(input);
        return store.resolveRunConversation(project.projectId, Number(input.executionLogId));
      }
      case 'resolve_run_conversation_turn': {
        const project = await runProject(input);
        return store.resolveRunConversationTurn(project.projectId, Number(input.executionLogId));
      }
      case 'patch_run_inputs': {
        const project = await runProject(input);
        return store.patchRunInputs(project.projectId, input as unknown as Parameters<UnifiedDataStore['patchRunInputs']>[1]);
      }
      case 'list_run_states': {
        const project = input.projectId || input.root ? await runProject(input) : undefined;
        return store.listRunStates({ ...(project ? { projectId: project.projectId } : {}), ...(input.pendingConsumer === true ? { pendingConsumer: true } : {}), ...(input.cursor !== undefined ? { cursor: Number(input.cursor) } : {}), ...(input.limit !== undefined ? { limit: Number(input.limit) } : {}) });
      }
      case 'list_run_deliveries': {
        const project = input.projectId || input.root ? await runProject(input) : undefined;
        return store.listRunDeliveries({ ...input, ...(project ? { projectId: project.projectId } : {}) });
      }
      case 'release_run_delivery': {
        const project = await runProject(input);
        return store.releaseRunDelivery(project.projectId, input as unknown as Parameters<UnifiedDataStore['releaseRunDelivery']>[1]);
      }
      case 'patch_run_state': {
        const project = await runProject(input);
        return store.patchRunState(project.projectId, input as unknown as Parameters<UnifiedDataStore['patchRunState']>[1]);
      }
      case 'claim_run_consumer': {
        const project = await runProject(input);
        return store.claimRunConsumer(project.projectId, input as unknown as Parameters<UnifiedDataStore['claimRunConsumer']>[1]);
      }
      case 'release_run_consumer': {
        const project = await runProject(input);
        store.releaseRunConsumer(project.projectId, input as unknown as Parameters<UnifiedDataStore['releaseRunConsumer']>[1]);
        return { released: true };
      }
      case 'commit_run_settlement': {
        const project = await runProject(input);
        return store.commitRunSettlement(project.projectId, input as unknown as Parameters<UnifiedDataStore['commitRunSettlement']>[1]);
      }
      case 'read_run_settlements': {
        const project = await runProject(input);
        return store.readRunSettlements(project.projectId, input);
      }
      case 'query_run_digests': {
        const project = await runProject(input);
        return store.queryRunDigests(project.projectId, input as unknown as Parameters<UnifiedDataStore['queryRunDigests']>[1]);
      }
      case 'read_run_digests': {
        const project = await runProject(input);
        return store.readRunDigests(project.projectId, input);
      }
      case 'read_run_index_health': {
        const project = await runProject(input);
        return store.readRunIndexHealth(project.projectId);
      }
      case 'backfill_run_indexes': {
        const project = await runProject(input);
        return store.backfillRunIndexes(project.projectId);
      }
      case 'list_run_effects': {
        const project = input.projectId || input.root ? await runProject(input) : undefined;
        return store.listRunEffects({ ...input, ...(project ? { projectId: project.projectId } : {}) });
      }
      case 'claim_run_effect': {
        const project = await runProject(input);
        return store.claimRunEffect(project.projectId, input as unknown as Parameters<UnifiedDataStore['claimRunEffect']>[1]);
      }
      case 'finish_run_effect': {
        const project = await runProject(input);
        return store.finishRunEffect(project.projectId, input as unknown as Parameters<UnifiedDataStore['finishRunEffect']>[1]);
      }
      case 'read_step_memory_state': {
        const project = await runProject(input);
        return store.readStepMemoryState(project.projectId);
      }
      case 'read_step_memory': {
        const project = await runProject(input);
        return store.readStepMemory(project.projectId, String(input.nodeId || ''), { ...(input.revision === undefined ? {} : { revision: Number(input.revision) }), includeEntries: input.includeEntries !== false });
      }
      case 'read_notification': return store.readNotification(String(input.intentId || ''));
      case 'enqueue_notification': return store.enqueueNotification(input as unknown as Parameters<UnifiedDataStore['enqueueNotification']>[0]);
      case 'list_notification_deliveries': return store.listNotificationDeliveries(input as unknown as Parameters<UnifiedDataStore['listNotificationDeliveries']>[0]);
      case 'begin_notification_delivery': return store.beginNotificationDelivery(input as unknown as Parameters<UnifiedDataStore['beginNotificationDelivery']>[0]);
      case 'settle_notification_delivery': return store.settleNotificationDelivery(input as unknown as Parameters<UnifiedDataStore['settleNotificationDelivery']>[0]);
      case 'append_automation_event': {
        const project = await runProject(input);
        return store.appendAutomationEvent(project.projectId, input as unknown as Parameters<UnifiedDataStore['appendAutomationEvent']>[1]);
      }
      case 'prepare_automation_delivery': {
        const project = await runProject(input);
        return store.prepareAutomationDelivery(project.projectId, input as unknown as Parameters<UnifiedDataStore['prepareAutomationDelivery']>[1]);
      }
      case 'prepare_automation_deliveries': {
        const project = await runProject(input);
        return store.prepareAutomationDeliveries(project.projectId, input as unknown as Parameters<UnifiedDataStore['prepareAutomationDeliveries']>[1]);
      }
      case 'list_automation_deliveries': return store.listAutomationDeliveries(input as unknown as Parameters<UnifiedDataStore['listAutomationDeliveries']>[0]);
      case 'claim_automation_delivery': return store.claimAutomationDelivery(input as unknown as Parameters<UnifiedDataStore['claimAutomationDelivery']>[0]);
      case 'begin_automation_delivery': return store.beginAutomationDelivery(input as unknown as Parameters<UnifiedDataStore['beginAutomationDelivery']>[0]);
      case 'register_automation_ui_owner': return store.registerAutomationUiOwner(input as unknown as Parameters<UnifiedDataStore['registerAutomationUiOwner']>[0]);
      case 'settle_automation_delivery': return store.settleAutomationDelivery(input as unknown as Parameters<UnifiedDataStore['settleAutomationDelivery']>[0]);
      case 'write_step_memory': {
        const project = await runProject(input);
        return store.writeStepMemory(project.projectId, input as unknown as Parameters<UnifiedDataStore['writeStepMemory']>[1]);
      }
      case 'read_flow_trace': {
        const project = await runProject(input);
        return store.readFlowTrace(project.projectId, String(input.flowId), input.revision === undefined ? undefined : Number(input.revision));
      }
      case 'write_flow_trace': {
        const project = await runProject(input);
        return store.writeFlowTrace(project.projectId, input as unknown as Parameters<UnifiedDataStore['writeFlowTrace']>[1]);
      }
      case 'list_flow_traces': {
        const project = await runProject(input);
        return store.listFlowTraces(project.projectId, input);
      }
      case 'read_documentation_manifest': {
        const project = await runProject(input);
        return store.readDocumentationManifest(project.projectId);
      }
      case 'sync_documentation_manifest': {
        const project = await runProject(input);
        return store.syncDocumentationManifest(project.projectId, input as unknown as Parameters<UnifiedDataStore['syncDocumentationManifest']>[1]);
      }
      case 'claim_run': {
        const project = await runProject(input);
        return store.claimRun(project.projectId, input as unknown as Parameters<UnifiedDataStore['claimRun']>[1]);
      }
      case 'claim_run_delivery': {
        const project = await runProject(input);
        return store.claimRunDelivery(project.projectId, input as unknown as Parameters<UnifiedDataStore['claimRunDelivery']>[1]);
      }
      case 'stop_run': {
        const project = await runProject(input);
        return runStops.stop(project.projectId, input as unknown as Parameters<RunStop['stop']>[1]);
      }
      case 'write_run_binding': {
        const project = await runProject(input);
        return store.writeRunBinding(project.projectId, input as unknown as Parameters<UnifiedDataStore['writeRunBinding']>[1]);
      }
      case 'read_run_binding': {
        const project = await runProject(input);
        return store.readRunBinding(project.projectId, Number(input.executionLogId), input.revision === undefined ? undefined : Number(input.revision));
      }
      case 'read_recent_run_session': {
        const project = await runProject(input);
        return store.readRecentRunSession(project.projectId, String(input.nodeId || ''), String(input.provider || ''));
      }
      case 'submit_run_report': {
        const project = await store.registerProject({ root: String(input.root || '') });
        let availability = 'available';
        let validationError = '';
        let report = input.report;
        try { report = validateTaskReport(input.report, String(input.root)); }
        catch (error) { availability = 'invalid'; validationError = error instanceof Error ? error.message : String(error); }
        return store.submitRunReport(project.projectId, { ...input, report, availability, validationError } as unknown as Parameters<UnifiedDataStore['submitRunReport']>[1]);
      }
      case 'record_claude_native_ready': {
        const project = await runProject(input);
        const state = store.recordClaudeNativeReady(project.projectId, input as unknown as Parameters<UnifiedDataStore['recordClaudeNativeReady']>[1]);
        return { ...state, claudeNativeResume: store.readClaudeNativeResume(project.projectId, Number(input.executionLogId)) };
      }
      case 'record_claude_native_append': {
        const project = await runProject(input);
        return store.recordClaudeNativeAppend(project.projectId, input as unknown as Parameters<UnifiedDataStore['recordClaudeNativeAppend']>[1]);
      }
      case 'record_claude_native_event': {
        const project = await runProject(input);
        const state = store.recordClaudeNativeEvent(project.projectId, input as unknown as Parameters<UnifiedDataStore['recordClaudeNativeEvent']>[1]);
        await new RunNativeObserver(store).observe(state);
        return store.readRunState(project.projectId, Number(input.executionLogId));
      }
      case 'checkpoint_run': {
        const project = await runProject(input);
        const checkpoint = { ...input };
        if (checkpoint.report !== undefined) checkpoint.reportIntent = checkpoint.report;
        else delete checkpoint.reportIntent;
        store.verifyRunExecutionProof(project.projectId, Number(input.executionLogId), Number(input.generation), String(input.proof || ''));
        let state = store.readRunState(project.projectId, Number(input.executionLogId));
        if (checkpoint.action === 'complete') {
          checkpoint.reportAvailability = checkpoint.report === undefined ? 'missing' : 'available';
          if (checkpoint.report !== undefined) {
            try { checkpoint.report = validateTaskReport(checkpoint.report, String(input.root || state.status.workspaceRoot)); }
            catch (error) { checkpoint.reportAvailability = 'invalid'; checkpoint.reportValidationError = error instanceof Error ? error.message : String(error); }
          }
        }
        const replay = store.readRunCheckpointReplay(project.projectId, checkpoint as unknown as Parameters<UnifiedDataStore['checkpointRun']>[1]);
        if (replay) return replay;
        if ((checkpoint.action === 'session-close' || checkpoint.action === 'complete' && checkpoint.exitCode !== undefined && state.status.sessionProvider === 'claude')
          && state.status.interactiveSession && !state.status.interactiveSessionClosed) {
          if (state.revision !== Number(checkpoint.expectedRevision)) throw new Error('revision_conflict');
          if (checkpoint.expectedTurnId && checkpoint.expectedTurnId !== state.turnId) throw new Error('checkpoint_turn_conflict');
          await new RunNativeObserver(store).observe(state, false, checkpoint.exitCode as number | undefined);
          state = store.readRunState(project.projectId, Number(input.executionLogId));
          if (checkpoint.action === 'complete' && checkpoint.report === undefined && state.status.nativeReplyObjectId
            && state.status.nativeOutputPending !== true && store.readMetadata(state.turnId).data.finished_at !== null
            && !store.runChildProcessAlive(project.projectId, Number(input.executionLogId))) return state;
          if (state.revision !== Number(checkpoint.expectedRevision)) throw new Error('revision_conflict');
        }
        if (checkpoint.action === 'start' && state.status.nativeOutputPending === true) {
          await new RunNativeObserver(store).observe(state);
          state = store.readRunState(project.projectId, Number(input.executionLogId));
          if (state.revision !== Number(checkpoint.expectedRevision)) throw new Error('revision_conflict');
        }
        if (checkpoint.action === 'start') checkpoint.gitBaseline = await readWorkspaceGitHead(String(state.status.workspaceRoot));
        if (['start', 'complete'].includes(String(checkpoint.action)) || (checkpoint.action === 'session-close' && (store.readMetadata(state.turnId).data.finished_at === null || state.status.nativeOutputPending === true))) {
          checkpoint.workspaceSnapshot = await snapshotWorkspace(String(state.status.workspaceRoot));
        }
        if (checkpoint.action !== 'start') checkpoint.gitEvidence = await captureRunGitEvidence(String(state.status.workspaceRoot), String(state.status.baseGitHash || ''), checkpoint.workspaceSnapshot as import('./runWorkspace').WorkspaceSnapshot | undefined);
        const result = store.checkpointRun(project.projectId, checkpoint as unknown as Parameters<UnifiedDataStore['checkpointRun']>[1]);
        if (checkpoint.action === 'session-close') new RunNativeObserver(store).forget(result);
        return result;
      }
      case 'finalize_run_output': {
        const project = await runProject(input);
        const finalize = input as unknown as Parameters<UnifiedDataStore['finalizeRunOutput']>[1];
        const replay = store.readRunOutputFinalizationReplay(project.projectId, finalize);
        if (replay) return replay;
        const state = store.readRunState(project.projectId, Number(input.executionLogId));
        const workspaceSnapshot = await snapshotWorkspace(String(state.status.workspaceRoot));
        return store.finalizeRunOutput(project.projectId, { ...finalize, workspaceSnapshot, gitEvidence: await captureRunGitEvidence(String(state.status.workspaceRoot), String(state.status.baseGitHash || ''), workspaceSnapshot) });
      }
      case 'append_run_log': {
        const project = await runProject(input);
        return store.appendRunLog(project.projectId, input as unknown as Parameters<UnifiedDataStore['appendRunLog']>[1]);
      }
      case 'read_run_log': {
        const project = await runProject(input);
        return store.readRunLog(project.projectId, input as unknown as Parameters<UnifiedDataStore['readRunLog']>[1]);
      }
      case 'read_run_log_head': {
        const project = await runProject(input);
        return store.readRunLogHead(project.projectId, Number(input.executionLogId), String(input.stream || ''));
      }
      case 'write_run_document': {
        const project = await runProject(input);
        return store.writeRunDocument(project.projectId, input as unknown as Parameters<UnifiedDataStore['writeRunDocument']>[1]);
      }
      case 'read_run_document': {
        const project = await runProject(input);
        return store.readRunDocument(project.projectId, Number(input.executionLogId), String(input.purpose || ''), input.revision === undefined ? undefined : Number(input.revision), input.tailBytes === undefined ? undefined : Number(input.tailBytes));
      }
      case 'recover_run_executions': {
        if (input.identityOnly === true) {
          const executionLogId = Number(input.executionLogId);
          if (!Number.isSafeInteger(executionLogId) || executionLogId < 1) throw new Error('invalid_execution_log_id');
          const project = await runProject(input);
          const state = store.readRunState(project.projectId, executionLogId);
          if (state.generation !== Number(input.generation)) throw new Error('run_owner_conflict');
          await new RunNativeObserver(store).observe(state, true);
        } else await runs.recover();
        return { recovered: true };
      }
      case 'write_project_growth': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.writeProjectGrowth(project.projectId, input.data as any, String(input.idempotencyKey || ''));
      }
      case 'reserve_project_growth_refresh': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.reserveProjectGrowthRefresh(project.projectId, String(input.requestId || ''));
      }
      case 'commit_project_growth_refresh': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.commitProjectGrowthRefresh(project.projectId, input as unknown as Parameters<UnifiedDataStore['commitProjectGrowthRefresh']>[1]);
      }
      case 'read_project_growth': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.readProjectGrowth(project.projectId, Number(input.historyLimit || 12));
      }
      case 'initialize_project_journal': return { minimumExecutionLogId: await initializeProjectJournalAllocation(store, String(input.root || '')) };
      case 'append_project_journal': {
        await initializeProjectJournalAllocation(store, String(input.root || ''));
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.appendProjectJournal(project.projectId, String(input.idempotencyKey || ''), input.entry as any, Number(input.executionLogId || 0), Number(input.minimumExecutionLogId || 1));
      }
      case 'update_project_journal': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.updateProjectJournal(project.projectId, Number(input.executionLogId || 0), input as any);
      }
      case 'link_project_journal': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.linkProjectJournal(project.projectId, Number(input.executionLogId), String(input.nodeId || ''), String(input.linkedAt || ''));
      }
      case 'read_project_journal': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.readProjectJournal(project.projectId, input as any);
      }
      case 'upsert_project_run_index': {
        const project = await store.registerProject({ root: String(input.root || '') });
        store.upsertProjectRunIndex(project.projectId, input.record as any, input.files as any, input.signals as any); return { written: true };
      }
      case 'read_project_run_indexes': {
        const project = await store.registerProject({ root: String(input.root || '') }); return store.readProjectRunIndexes(project.projectId, input as any);
      }
      case 'read_project_investment_runs': {
        const project = await store.registerProject({ root: String(input.root || '') }); return store.readProjectInvestmentRuns(project.projectId);
      }
      case 'read_project_impact_runs': {
        const project = await store.registerProject({ root: String(input.root || '') }); return store.readProjectImpactRuns(project.projectId);
      }
      case 'read_project_reusable_source_count': {
        const project = await store.registerProject({ root: String(input.root || '') }); return store.readProjectReusableSourceCount(project.projectId);
      }
      case 'read_project_analysis_source': {
        const project = await store.registerProject({ root: String(input.root || '') }); return store.readProjectAnalysisSource(project.projectId);
      }
      case 'read_analysis_state':
      case 'write_analysis_state': {
        const project = input.root === undefined ? null : (await store.registerProject({ root: String(input.root) })).projectId;
        return request.operation === 'read_analysis_state'
          ? store.readAnalysisState(project, String(input.namespace || ''), String(input.key || ''))
          : store.writeAnalysisState(project, input as unknown as Parameters<UnifiedDataStore['writeAnalysisState']>[1]);
      }
      case 'reserve_sidebar_core_refresh': return store.reserveSidebarCoreRefresh(String(input.requestId || ''));
      case 'commit_sidebar_core_refresh': return store.commitSidebarCoreRefresh(input as unknown as Parameters<UnifiedDataStore['commitSidebarCoreRefresh']>[0]);
      case 'reserve_external_refresh': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.reserveExternalRefresh(project.projectId, String(input.key || ''), String(input.requestId || ''));
      }
      case 'commit_external_refresh': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.commitExternalRefresh(project.projectId, input as unknown as Parameters<UnifiedDataStore['commitExternalRefresh']>[1]);
      }
      case 'read_strategy_source_revision': {
        if (!Array.isArray(input.roots) || input.roots.some(root => typeof root !== 'string')) throw new Error('strategy_source_roots_required');
        const projectIds: string[] = [];
        for (const root of input.roots) projectIds.push((await store.registerProject({ root })).projectId);
        return { revision: store.readStrategySourceRevision(projectIds), projectIds };
      }
      case 'read_strategy_state':
      case 'write_strategy_state': {
        const project = input.root === undefined ? null : (await store.registerProject({ root: String(input.root) })).projectId;
        return request.operation === 'read_strategy_state' ? store.readStrategyState(project) : store.writeStrategyState(project, input as unknown as Parameters<UnifiedDataStore['writeStrategyState']>[1]);
      }
      case 'write_run_artifact': {
        const root = String(input.root || ''); const project = await store.registerProject({ root }); store.writeRunArtifact(project.projectId, input as any);
        if (typeof input.sourceKey === 'string') {
          const bytes = Buffer.from(String(input.bytes || ''), 'base64'); const identity = `agent-runs:${root}`;
          store.captureMigrationSource({ identity, key: input.sourceKey, hash: String(input.hash || '') }, bytes, { mimeType: String(input.mimeType || 'application/octet-stream'), encoding: 'binary' });
          if (isRetirableRunArtifact(input.sourceKey)) store.markMigrationSourceImported(identity, input.sourceKey);
        }
        return { written: true };
      }
      case 'read_run_artifact': {
        const project = await store.registerProject({ root: String(input.root || '') }); return store.readRunArtifact(project.projectId, Number(input.executionLogId || 0), String(input.relativePath || ''));
      }
      case 'read_growth_report_projection': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.readGrowthReportProjection(project.projectId, String(input.prefix || ''));
      }
      case 'read_registered_report_sources': {
        const project = await store.registerProject({ root: String(input.root || '') });
        while (store.backfillReportVersions(project.projectId)) await new Promise<void>(resolve => setImmediate(resolve));
        return store.readRegisteredReportSources(project.projectId, input);
      }
      case 'read_report_versions': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.readReportVersions(project.projectId, input.refs as Array<{ objectId: string; revision: number }>);
      }
      case 'read_report_source_revision': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return { revision: store.reportSourceRevision(project.projectId) };
      }
      case 'read_github_facts':
      case 'write_github_facts': {
        const project = await store.registerProject({ root: String(input.root || '') });
        if (request.operation === 'read_github_facts') return store.readGithubFacts(project.projectId, String(input.repository || ''));
        store.writeGithubFacts(project.projectId, input as unknown as Parameters<UnifiedDataStore['writeGithubFacts']>[1]);
        return { written: true };
      }
      case 'write_growth_report_projection': {
        const project = await store.registerProject({ root: String(input.root || '') });
        const revisions = store.writeGrowthReportProjection(project.projectId, input.updates as Parameters<UnifiedDataStore['writeGrowthReportProjection']>[1], input.expectedSourceRevision as number | undefined);
        return { written: Array.isArray(input.updates) ? input.updates.length : 0, revisions };
      }
      case 'prepare_agent_database': {
        const provider = String(input.provider);
        if (!databaseAgentProviders.includes(provider as DatabaseAgentProvider) || typeof input.command !== 'string' || !path.isAbsolute(input.command)) throw new Error('invalid_agent_database_configuration');
        const configuration = input.configPath;
        if (configuration !== undefined && !isAgentDatabaseConfigPath(provider as DatabaseAgentProvider, configuration)) throw new Error('invalid_agent_database_configuration');
        const project = await store.registerProject({ root: String(input.root || '') });
        const configPath = configureAgentDatabase({ provider: provider as DatabaseAgentProvider, configPath: configuration as string | undefined, command: input.command, globalDataPath: store.root });
        return { ...project, configPath };
      }
      case 'import_memory': return migrations.enqueue(input);
      case 'import_intelligence': return migrations.enqueue({ ...input, collection: 'intelligence' });
      case 'import_project_data': return migrations.enqueue(input);
      case 'read_intelligence_conversation': return store.readIntelligenceConversation(String(input.id || ''));
      case 'list_intelligence_conversations': return store.listIntelligenceConversations();
      case 'write_intelligence_conversation': return store.writeIntelligenceConversation(input as unknown as Parameters<UnifiedDataStore['writeIntelligenceConversation']>[0]);
      case 'migration_status': {
        const scope = await migrationScope(input); const job = store.readMigrationJob(String(input.jobId || ''));
        if (scope && !recycling.jobBelongsToProject(job, scope)) throw new Error('maintenance_scope_denied');
        return input.metadataOnly === true ? store.readMigrationJobStatus(job.jobId) : job;
      }
      case 'discover_migrations': {
        const scope = await migrationScope(input);
        return enqueueAvailableDataMigrations(store, operations, () => true, true, scope?.root);
      }
      case 'migration_overview': {
        const scope = await migrationScope(input);
        const formalRuns = store.migrationAgentRuns().filter(run => !scope || run.projectId === scope.projectId);
        const projectedRuns = formalRuns.map(run => {
          const active = !run.status.finishedAt;
          return {
            taskId: run.taskId,
            kind: String(run.status.runKind),
            targetId: String(run.status.migrationTargetId || '') || null,
            status: active ? (String(run.status.status) === 'Preparing' ? 'ready' : 'running') : String(run.status.status) === 'Failed' ? 'failed' : 'completed',
            error: run.status.failureReason ? String(run.status.failureReason) : null,
            createdAt: Date.parse(String(run.status.startedAt || '')) || 0,
            updatedAt: Date.parse(String(run.status.finishedAt || run.status.startedAt || '')) || 0,
            validUntil: active ? Number.MAX_SAFE_INTEGER : Date.parse(String(run.status.finishedAt || '')) || 0
          };
        });
        const overview = await recycling.overview(scope);
        const projectedOverview = input.summaryOnly === true ? {
          ...overview,
          jobs: overview.jobs.map(job => {
            const { conflicts: _conflicts, ...progress } = job.progress;
            return { ...job, progress };
          })
        } : overview;
        return {
          ...projectedOverview,
          maintenanceTasks: projectedRuns,
          activeMaintenanceTaskIds: projectedRuns.filter(task => ['ready', 'running'].includes(task.status)).map(task => task.taskId),
          launchingMaintenanceTaskIds: []
        };
      }
      case 'prepare_recycling': return recycling.prepare(await migrationScope(input));
      case 'read_recycling_plan': return recycling.readPlan(String(input.planId || ''), await migrationScope(input));
      case 'retry_migration': {
        const scope = await migrationScope(input); const job = store.readMigrationJob(String(input.jobId || ''));
        if (scope && !recycling.jobBelongsToProject(job, scope)) throw new Error('maintenance_scope_denied');
        return migrations.retry(job.jobId);
      }
      case 'confirm_recycling': return recycling.confirm(String(input.planId || ''), input.files as Array<{ itemId: string; path: string; hash: string; bytes: number }> | undefined, await migrationScope(input));
      case 'hold_recycling_file': return recycling.hold(String(input.itemId || ''));
      case 'finish_recycling_file': return recycling.finish(String(input.itemId || ''));
      case 'retire_recycling_file': return recycling.retire(String(input.itemId || ''));
      case 'restore_recycling_file': return recycling.restore(String(input.itemId || ''), input.destination === undefined ? undefined : String(input.destination), await migrationScope(input));
      case 'execute_recycling_plan': {
        const scope = await migrationScope(input);
        const plan = recycling.readPlan(String(input.planId || ''), scope);
        const failures: string[] = [];
        for (const file of plan.files) {
          if (['trashed', 'restored'].includes(file.status)) continue;
          if (file.status === 'changed') { failures.push(file.itemId); continue; }
          try {
            const held = await recycling.hold(file.itemId);
            if (!held.recycled) await recycling.retire(file.itemId);
          } catch { failures.push(file.itemId); }
        }
        if (failures.length) throw new Error(`recycling_items_retained:${failures.join(',')}`);
        return recycling.overview(scope);
      }
      case 'write': return store.write(input as unknown as DataWrite);
      case 'read': {
        const ref = normalizeObjectReference(input.ref);
        const revision = input.revision as number | undefined;
        const session = request.sessionToken ? sessions.get(request.sessionToken) : undefined;
        if (input.view === 'metadata') return store.readMetadata(ref, revision);
        if (input.view === 'content') return store.readPage({ ...input, ref } as unknown as Parameters<UnifiedDataStore['readPage']>[0], session?.kind === 'project' ? (object, field) => {
          if (!allowedRead(object, session)) throw new Error('scope_denied');
          if (object.projection?.hostReview === true && field === 'review_content') throw new Error('review_input_requires_host');
        } : undefined);
        if (input.view && input.view !== 'full') throw new Error('unknown_read_view');
        return store.read(ref, revision, session?.kind === 'project' ? agentObject : undefined);
      }
      case 'search': {
        const session = request.sessionToken ? sessions.get(request.sessionToken) : undefined;
        return store.search(input as unknown as Parameters<UnifiedDataStore['search']>[0], session?.kind === 'project' ? object => allowedRead(object, session) && canAgentDiscover(object) : undefined, session?.kind === 'project' ? agentObject : undefined);
      }
      case 'link': return store.link(input as unknown as Parameters<UnifiedDataStore['link']>[0]);
      case 'context': {
        const session = request.sessionToken ? sessions.get(request.sessionToken) : undefined;
        return store.context(input as unknown as Parameters<UnifiedDataStore['context']>[0], session?.kind === 'project' ? object => allowedRead(object, session) : undefined);
      }
      case 'export': {
        const session = request.sessionToken ? sessions.get(request.sessionToken) : undefined;
        return store.export(input as unknown as Parameters<UnifiedDataStore['export']>[0], session?.kind === 'project' ? object => {
          store.authorizeMcpAction(session.actorId, session.scope, 'export');
          if (!allowedRead(object, session) || !allowedRead(store.readMetadata(object.objectId), session) || !canAgentDiscover(object)) throw new Error('scope_denied');
          return agentObject(object);
        } : undefined);
      }
      case 'backup': return store.backup({ destination: String(input.destination || ''), idempotencyKey: String(input.idempotencyKey || '') });
      case 'read_database_storage': return store.readDatabaseStorage();
      case 'maintain_database_storage': return maintainDatabaseStorage(input.compact === true, input.automatic === true);
      case 'restore_backup': return store.restoreBackup({ source: String(input.source || ''), destinationRoot: String(input.destinationRoot || ''), idempotencyKey: String(input.idempotencyKey || '') });
      case 'export_project': return store.exportProject(input as unknown as Parameters<UnifiedDataStore['exportProject']>[0]);
      case 'import_project': return store.importProject(input as unknown as Parameters<UnifiedDataStore['importProject']>[0]);
      default: throw new Error('unknown_data_operation');
    }
  };
  const operations = async (request: RuntimeDataRequest) => {
    if (!request.sessionToken) return dispatch(request);
    const session = sessions.get(request.sessionToken);
    if (!session) throw new Error('mcp_session_expired');
    const input = request.input;
    if (session.migrationKind) {
      if (!session.runIdentity) throw new Error('action_denied');
      store.authorizedRunState(session.scope, session.runIdentity);
      const reviewActions = ['migration_overview', 'migration_status', 'retry_migration', 'prepare_recycling', 'read_recycling_plan'];
      const migrationActions = ['discover_migrations', ...reviewActions];
      const recyclingActions = ['migration_overview', 'read_recycling_plan', 'execute_recycling_plan'];
      if (!(session.migrationKind === 'migration_apply' ? migrationActions : session.migrationKind === 'migration_review' ? reviewActions : recyclingActions).includes(request.operation)) throw new Error('action_denied');
      if (session.migrationProjectRoot) {
        const scope = await migrationScope(input);
        if (!scope || scope.projectId !== session.migrationProjectId || scope.physicalRoot !== session.migrationPhysicalRoot) throw new Error('maintenance_scope_denied');
      }
      if (session.migrationKind === 'recycling_apply' && ['read_recycling_plan', 'execute_recycling_plan'].includes(request.operation) && String(input.planId || '') !== session.migrationTargetId) throw new Error('maintenance_target_denied');
      return dispatch(request);
    }
    const ordinaryMigrationActions = ['discover_migrations', 'migration_overview', 'migration_status', 'retry_migration', 'prepare_recycling'];
    if (ordinaryMigrationActions.includes(request.operation)) {
      if (!session.runIdentity) throw new Error('action_denied');
      const run = store.authorizedRunState(session.scope, session.runIdentity);
      if (!soloConversationRunKinds.includes(String(run.status.runKind) as typeof soloConversationRunKinds[number])) throw new Error('action_denied');
      const scope = await migrationScope(input);
      if (!scope) throw new Error('project_scope_required');
      if (scope.projectId !== session.scope || scope.physicalRoot !== session.migrationPhysicalRoot) throw new Error('maintenance_scope_denied');
      return dispatch(request);
    }
    if (!['write', 'read', 'search', 'link', 'context', 'export'].includes(request.operation)) throw new Error('action_denied');
    store.authorizeMcpAction(session.actorId, session.scope, request.operation);
    if (session.runIdentity) store.authorizedLearningReviewBatch(session.scope, session.runIdentity);
    if (request.operation === 'write') {
      if (input.scope !== session.scope) throw new Error('scope_denied');
      validateAgentWrite(input as unknown as DataWrite, input.objectId ? store.read(String(input.objectId)) : undefined);
    }
    if (request.operation === 'link') {
      const source = store.readMetadata(String(input.source));
      if (source.projectId !== session.scope) throw new Error('scope_denied');
      validateAgentLink(source, String(input.relation));
    }
    if (request.operation === 'search' && input.scope !== session.scope) throw new Error('scope_denied');
    if (request.operation === 'context' && input.project !== session.scope) throw new Error('scope_denied');
    for (const key of request.operation === 'link' ? ['source', 'target'] : ['ref', 'objectId']) {
      if (input[key] && !allowedRead(store.readMetadata(normalizeObjectReference(input[key])), session)) throw new Error('scope_denied');
    }
    return store.withActor(session.actorId, async () => {
      // A reviewed source describes its original revision, not an Agent's later edit.
      const applied = request.operation === 'write' && input.kind === 'lesson' && input.action === 'patch'
        ? { ...request, input: { ...input, data: { external_updated_at: null, ...(input.data as Record<string, unknown>), semantic_review_json: null, ...(Object.prototype.hasOwnProperty.call(input.data, 'confidence') ? { external_confidence: null } : {}) } } }
        : request.operation === 'write' && input.kind === 'learning_event' && input.action === 'patch'
          ? { ...request, input: { ...input, data: { ...(input.data as Record<string, unknown>), verification_signal: 0 } } }
          : request;
      const result = await dispatch(applied);
      if (request.operation === 'read') {
        const value = result as DataObject | { object: DataObject };
        if (!allowedRead('object' in value ? value.object : value, session)) throw new Error('scope_denied');
        return 'object' in value ? { ...value, object: agentObject(value.object) } : agentObject(value);
      }
      if (request.operation === 'context') {
        const context = result as { items: DataObject[] };
        return { ...context, items: context.items.filter(item => allowedRead(item, session)) };
      }
      return result;
    });
  };
  return Object.assign(operations, { setStorageMaintenanceBarrier: (barrier: Promise<unknown>) => { storageMaintenanceBarrier = barrier; }, recoverMigrations: () => migrations.recover(), recoverRuns: () => runs.start(), interruptRuns: () => runStops.interrupt(), waitForMigrations: () => migrations.wait(), close: async () => { await storageMaintenanceTail; await runs.close(); await migrations.close(); } });
}

export function runtimeMcpSource(globalDataPath: string, scope: string | null, globalReads = false, runIdentity?: McpRunIdentity): UnifiedMcpSource {
  let session: { actorId: string; proof: string; sessionToken: string; runKind: string; migrationKind: string | null } | undefined;
  let opening: Promise<void> | undefined;
  const establish = async (): Promise<void> => {
    if (!opening) opening = sendRuntimeDataRequest<typeof session>(globalDataPath, { operation: 'open_mcp_session', input: { projectId: scope, ...(runIdentity ? { runIdentity } : {}), ...(session ? { resume: { actorId: session.actorId, proof: session.proof } } : {}) } }).then(value => { session = value; }).finally(() => { opening = undefined; });
    await opening;
  };
  return { scope, globalReads, async sessionInfo() {
    if (!session) await establish();
    return { runKind: String(session!.runKind || ''), migrationKind: session!.migrationKind || null };
  }, async close() {
    if (opening) await opening;
    if (session) await sendRuntimeDataRequest(globalDataPath, { operation: 'close_mcp_session', input: { sessionToken: session.sessionToken } });
    session = undefined;
  }, async call(operation, input) {
    if (!session) await establish();
    try { return await sendRuntimeDataRequest(globalDataPath, { operation, input, sessionToken: session!.sessionToken }); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'mcp_session_expired') throw error;
      await establish();
      return sendRuntimeDataRequest(globalDataPath, { operation, input, sessionToken: session!.sessionToken });
    }
  } };
}

export async function runtimeProjectMcpSource(globalDataPath: string, projectRoot: string): Promise<UnifiedMcpSource | undefined> {
  if (!projectRoot || !fs.existsSync(path.join(globalDataPath, 'solomap.db'))) return undefined;
  const project = await sendRuntimeDataRequest<{ projectId: string }>(globalDataPath, { operation: 'register_project', input: { root: projectRoot } });
  return runtimeMcpSource(globalDataPath, project.projectId, true);
}
