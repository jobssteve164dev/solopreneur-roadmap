import { MaintenanceRuntimeEndpoint, RuntimeDataRequest, sendRuntimeDataRequest, sendRuntimeMaintenanceRequest } from './autonomousRuntimeControl';
import { DataWrite, UnifiedDataStore } from './db/unifiedDataStore';
import type { UnifiedMcpSource } from './unifiedMcp';
import * as crypto from 'crypto';
import type { DataObject } from './db/unifiedDataStore';
import { validateAgentLink, validateAgentWrite } from './dataAuthorization';
import { DatabaseMigrationCoordinator } from './databaseMigrationCoordinator';
import * as fs from 'fs';
import * as path from 'path';
import { configureAgentDatabase, databaseAgentProviders, DatabaseAgentProvider, isAgentDatabaseConfigPath } from './agentDatabaseConfig';
import { readIntelligenceConversation, listIntelligenceConversations } from './intelligenceConversationData';
import { MigrationRecycling } from './migrationRecycling';
import { isRetirableRunArtifact } from './projectDataMigration';

export interface RuntimeDataOperations {
  (request: RuntimeDataRequest): Promise<unknown>;
  recoverMigrations(): void;
  waitForMigrations(): Promise<void>;
  close(): Promise<void>;
}

export function createRuntimeDataOperations(store: UnifiedDataStore): RuntimeDataOperations {
  const migrations = new DatabaseMigrationCoordinator(store);
  const recycling = new MigrationRecycling(store);
  type ProjectSession = { kind: 'project'; actorId: string; scope: string };
  type MaintenanceSession = { kind: 'maintenance'; taskId: string; taskKind: 'migration_review' | 'recycling_apply'; targetId: string | null };
  const sessions = new Map<string, ProjectSession | MaintenanceSession>();
  const maintenanceLaunchClaims = new Map<string, { token: string; expiresAt: number }>();
  const claimMaintenanceLaunch = (taskId: string) => {
    const now = Date.now();
    for (const [id, claim] of maintenanceLaunchClaims) if (claim.expiresAt <= now) maintenanceLaunchClaims.delete(id);
    if ([...sessions.values()].some(session => session.kind === 'maintenance' && session.taskId === taskId) || (maintenanceLaunchClaims.get(taskId)?.expiresAt || 0) > now) throw new Error('maintenance_task_in_use');
    const claim = { token: crypto.randomBytes(32).toString('hex'), expiresAt: now + 30 * 60_000 };
    maintenanceLaunchClaims.set(taskId, claim);
    return claim.token;
  };
  const allowedRead = (object: DataObject, scope: string): boolean => object.projectId === scope || object.objectId === scope || (object.projectId === null && ['memory', 'lesson', 'policy'].includes(object.kind) && ['verified', 'approved', 'active'].includes(String(object.data.status)));
  const dispatch = async (request: RuntimeDataRequest): Promise<unknown> => {
    if (!request || typeof request.operation !== 'string' || !request.input || typeof request.input !== 'object') throw new Error('invalid_data_request');
    const input = request.input;
    switch (request.operation) {
      case 'open_mcp_session': {
        const scope = String(input.projectId || '');
        const identity = store.establishMcpActor(scope, input.resume as { actorId: string; proof: string } | undefined);
        const sessionToken = crypto.randomBytes(32).toString('hex');
        sessions.set(sessionToken, { kind: 'project', actorId: identity.actorId, scope });
        return { ...identity, sessionToken };
      }
      case 'open_maintenance_mcp_session': {
        const taskId = String(input.taskId || '');
        if ([...sessions.values()].some(session => session.kind === 'maintenance' && session.taskId === taskId)) throw new Error('maintenance_task_in_use');
        const claim = maintenanceLaunchClaims.get(taskId);
        const launchToken = String(input.launchToken || '');
        if (!claim || claim.expiresAt <= Date.now() || !launchToken || launchToken.length !== claim.token.length || !crypto.timingSafeEqual(Buffer.from(launchToken), Buffer.from(claim.token))) throw new Error('maintenance_launch_denied');
        const task = store.establishMaintenanceTask(taskId, String(input.proof || ''));
        maintenanceLaunchClaims.delete(taskId);
        const sessionToken = crypto.randomBytes(32).toString('hex');
        sessions.set(sessionToken, { kind: 'maintenance', taskId: task.taskId, taskKind: task.kind, targetId: task.targetId });
        return { taskId: task.taskId, kind: task.kind, targetId: task.targetId, sessionToken };
      }
      case 'close_mcp_session': {
        const token = String(input.sessionToken || '');
        const session = sessions.get(token);
        if (session?.kind === 'project') store.closeMcpActor(session.actorId, session.scope);
        sessions.delete(token);
        return { closed: true };
      }
      case 'create_maintenance_task': {
        const task = store.createMaintenanceTask(String(input.kind || '') as 'migration_review' | 'recycling_apply', input.targetId ? String(input.targetId) : undefined);
        return { ...task, launchToken: claimMaintenanceLaunch(task.taskId) };
      }
      case 'claim_maintenance_task': {
        const task = store.resumeMaintenanceTask(String(input.taskId || ''));
        return { ...task, launchToken: claimMaintenanceLaunch(task.taskId) };
      }
      case 'resume_maintenance_task': return store.resumeMaintenanceTask(String(input.taskId || ''));
      case 'maintenance_task_status': return store.readMaintenanceTask(String(input.taskId || ''));
      case 'fail_maintenance_task': {
        const taskId = String(input.taskId || '');
        maintenanceLaunchClaims.delete(taskId);
        return store.completeMaintenanceTask(taskId, String(input.error || 'agent_cli_stopped'));
      }
      case 'register_project': return store.registerProject(input as unknown as Parameters<UnifiedDataStore['registerProject']>[0]);
      case 'write_project_growth': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.writeProjectGrowth(project.projectId, input.data as any, String(input.idempotencyKey || ''));
      }
      case 'read_project_growth': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.readProjectGrowth(project.projectId, Number(input.historyLimit || 12));
      }
      case 'append_project_journal': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.appendProjectJournal(project.projectId, String(input.idempotencyKey || ''), input.entry as any, Number(input.executionLogId || 0), Number(input.minimumExecutionLogId || 1));
      }
      case 'update_project_journal': {
        const project = await store.registerProject({ root: String(input.root || '') });
        return store.updateProjectJournal(project.projectId, Number(input.executionLogId || 0), input as any);
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
        const project = await store.registerProject({ root: String(input.root || '') }); return store.readProjectRunIndexes(project.projectId);
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
      case 'write_growth_report_projection': {
        const project = await store.registerProject({ root: String(input.root || '') });
        store.writeGrowthReportProjection(project.projectId, input.updates as Array<{ key: string; value: unknown }>);
        return { written: Array.isArray(input.updates) ? input.updates.length : 0 };
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
      case 'read_intelligence_conversation': return readIntelligenceConversation(store, String(input.id || ''));
      case 'list_intelligence_conversations': return listIntelligenceConversations(store);
      case 'write_intelligence_conversation': return store.writeIntelligenceConversation(input as unknown as Parameters<UnifiedDataStore['writeIntelligenceConversation']>[0]);
      case 'migration_status': return store.readMigrationJob(String(input.jobId || ''));
      case 'migration_overview': return {
        ...(await recycling.overview()),
        maintenanceTasks: store.maintenanceTasks(),
        activeMaintenanceTaskIds: [...sessions.values()].filter((session): session is MaintenanceSession => session.kind === 'maintenance').map(session => session.taskId),
        launchingMaintenanceTaskIds: [...maintenanceLaunchClaims.entries()].filter(([, claim]) => claim.expiresAt > Date.now()).map(([taskId]) => taskId)
      };
      case 'prepare_recycling': return recycling.prepare();
      case 'read_recycling_plan': return recycling.readPlan(String(input.planId || ''));
      case 'retry_migration': return migrations.retry(String(input.jobId || ''));
      case 'confirm_recycling': return recycling.confirm(String(input.planId || ''));
      case 'hold_recycling_file': return recycling.hold(String(input.itemId || ''));
      case 'finish_recycling_file': return recycling.finish(String(input.itemId || ''));
      case 'retire_recycling_file': return recycling.retire(String(input.itemId || ''));
      case 'restore_recycling_file': return recycling.restore(String(input.itemId || ''));
      case 'execute_recycling_plan': {
        const plan = recycling.readPlan(String(input.planId || ''));
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
        return recycling.overview();
      }
      case 'complete_maintenance_task': {
        const session = request.sessionToken ? sessions.get(request.sessionToken) : undefined;
        if (!session || session.kind !== 'maintenance') throw new Error('action_denied');
        const completed = store.completeMaintenanceTask(session.taskId, input.error ? String(input.error) : null);
        maintenanceLaunchClaims.delete(session.taskId);
        sessions.delete(String(request.sessionToken));
        return completed;
      }
      case 'write': return store.write(input as unknown as DataWrite);
      case 'read': {
        const ref = String(input.ref || '');
        const revision = input.revision as number | undefined;
        if (input.view === 'metadata') return store.readMetadata(ref, revision);
        if (input.view === 'content') return store.readPage(input as unknown as Parameters<UnifiedDataStore['readPage']>[0]);
        if (input.view && input.view !== 'full') throw new Error('unknown_read_view');
        return store.read(ref, revision);
      }
      case 'search': return store.search(input as unknown as Parameters<UnifiedDataStore['search']>[0]);
      case 'link': return store.link(input as unknown as Parameters<UnifiedDataStore['link']>[0]);
      case 'context': {
        const session = request.sessionToken ? sessions.get(request.sessionToken) : undefined;
        return store.context(input as unknown as Parameters<UnifiedDataStore['context']>[0], session?.kind === 'project' ? object => allowedRead(object, session.scope) : undefined);
      }
      case 'export': return store.export(input as unknown as Parameters<UnifiedDataStore['export']>[0]);
      case 'backup': await store.backup(String(input.destination || '')); return { destination: input.destination };
      default: throw new Error('unknown_data_operation');
    }
  };
  const operations = async (request: RuntimeDataRequest) => {
    if (request.maintenanceTransport) {
      if (!request.maintenanceTaskId || !request.maintenanceProof) throw new Error('maintenance_transport_denied');
      const proof = String(request.maintenanceProof || '');
      const task = request.operation === 'close_mcp_session'
        ? store.verifyMaintenanceTaskIdentity(request.maintenanceTaskId, proof)
        : store.verifyMaintenanceTaskProof(request.maintenanceTaskId, proof);
      if (request.operation === 'open_maintenance_mcp_session') {
        if (String(request.input.taskId || '') !== task.taskId || String(request.input.proof || '') !== String(request.maintenanceProof || '')) throw new Error('action_denied');
      } else {
        const transportSession = request.sessionToken ? sessions.get(request.sessionToken) : undefined;
        if (!transportSession || transportSession.kind !== 'maintenance' || transportSession.taskId !== task.taskId) throw new Error('action_denied');
      }
    }
    if (!request.sessionToken) return dispatch(request);
    const session = sessions.get(request.sessionToken);
    if (!session) throw new Error('mcp_session_expired');
    const input = request.input;
    if (session.kind === 'maintenance') {
      store.authorizeMaintenanceTask(session.taskId, session.taskKind, session.targetId);
      const reviewActions = ['migration_overview', 'retry_migration', 'prepare_recycling', 'read_recycling_plan', 'complete_maintenance_task'];
      const recyclingActions = ['migration_overview', 'read_recycling_plan', 'execute_recycling_plan', 'complete_maintenance_task'];
      if (!(session.taskKind === 'migration_review' ? reviewActions : recyclingActions).includes(request.operation)) throw new Error('action_denied');
      if (session.taskKind === 'recycling_apply' && ['read_recycling_plan', 'execute_recycling_plan'].includes(request.operation) && String(input.planId || '') !== session.targetId) throw new Error('maintenance_target_denied');
      try { return await dispatch(request); }
      catch (error) {
        if (request.operation !== 'complete_maintenance_task') {
          try { store.completeMaintenanceTask(session.taskId, error instanceof Error ? error.message : String(error)); } catch {}
        }
        throw error;
      }
    }
    if (!['write', 'read', 'search', 'link', 'context', 'export'].includes(request.operation)) throw new Error('action_denied');
    store.authorizeMcpAction(session.actorId, session.scope, request.operation);
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
      if (input[key] && !allowedRead(store.readMetadata(String(input[key])), session.scope)) throw new Error('scope_denied');
    }
    return store.withActor(session.actorId, async () => {
      const result = await dispatch(request);
      if (request.operation === 'read') {
        const value = result as DataObject | { object: DataObject };
        if (!allowedRead('object' in value ? value.object : value, session.scope)) throw new Error('scope_denied');
      }
      if (request.operation === 'context') {
        const context = result as { items: DataObject[] };
        return { ...context, items: context.items.filter(item => allowedRead(item, session.scope)) };
      }
      return result;
    });
  };
  return Object.assign(operations, { recoverMigrations: () => migrations.recover(), waitForMigrations: () => migrations.wait(), close: () => migrations.close() });
}

export function runtimeMcpSource(globalDataPath: string, scope: string | null, globalReads = false): UnifiedMcpSource {
  let session: { actorId: string; proof: string; sessionToken: string } | undefined;
  let opening: Promise<void> | undefined;
  const establish = async (): Promise<void> => {
    if (!opening) opening = sendRuntimeDataRequest<typeof session>(globalDataPath, { operation: 'open_mcp_session', input: { projectId: scope, ...(session ? { resume: { actorId: session.actorId, proof: session.proof } } : {}) } }).then(value => { session = value; }).finally(() => { opening = undefined; });
    await opening;
  };
  return { scope, globalReads, async close() {
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

export function runtimeMaintenanceMcpSource(globalDataPath: string, taskId: string, proof: string, launchToken: string): UnifiedMcpSource {
  let sessionToken = '';
  const establish = async (): Promise<void> => {
    const session = await sendRuntimeDataRequest<{ sessionToken: string }>(globalDataPath, { operation: 'open_maintenance_mcp_session', input: { taskId, proof, launchToken } });
    sessionToken = session.sessionToken;
  };
  return {
    scope: null,
    async close() {
      if (sessionToken) await sendRuntimeDataRequest(globalDataPath, { operation: 'close_mcp_session', input: { sessionToken } });
      sessionToken = '';
    },
    async call(operation, input) {
      if (!sessionToken) await establish();
      try { return await sendRuntimeDataRequest(globalDataPath, { operation, input, sessionToken }); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'mcp_session_expired') throw error;
        await establish();
        return sendRuntimeDataRequest(globalDataPath, { operation, input, sessionToken });
      }
    }
  };
}

export function runtimeMaintenanceEndpointMcpSource(endpoint: MaintenanceRuntimeEndpoint, taskId: string, proof: string, launchToken: string): UnifiedMcpSource {
  let sessionToken = '';
  const send = <T>(request: RuntimeDataRequest) => sendRuntimeMaintenanceRequest<T>(endpoint, taskId, proof, request);
  const establish = async (): Promise<void> => {
    const session = await send<{ sessionToken: string }>({ operation: 'open_maintenance_mcp_session', input: { taskId, proof, launchToken } });
    sessionToken = session.sessionToken;
  };
  return {
    scope: null,
    async close() {
      if (sessionToken) await send({ operation: 'close_mcp_session', input: {}, sessionToken });
      sessionToken = '';
    },
    async call(operation, input) {
      if (!sessionToken) await establish();
      try { return await send({ operation, input, sessionToken }); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'mcp_session_expired') throw error;
        await establish();
        return send({ operation, input, sessionToken });
      }
    }
  };
}

export async function runtimeProjectMcpSource(globalDataPath: string, projectRoot: string): Promise<UnifiedMcpSource | undefined> {
  if (!projectRoot || !fs.existsSync(path.join(globalDataPath, 'solomap.db'))) return undefined;
  const project = await sendRuntimeDataRequest<{ projectId: string }>(globalDataPath, { operation: 'register_project', input: { root: projectRoot } });
  return runtimeMcpSource(globalDataPath, project.projectId, true);
}
