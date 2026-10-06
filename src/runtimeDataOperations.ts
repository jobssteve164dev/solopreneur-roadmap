import { RuntimeDataRequest, sendRuntimeDataRequest } from './autonomousRuntimeControl';
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

export interface RuntimeDataOperations {
  (request: RuntimeDataRequest): Promise<unknown>;
  recoverMigrations(): void;
  waitForMigrations(): Promise<void>;
  close(): Promise<void>;
}

export function createRuntimeDataOperations(store: UnifiedDataStore): RuntimeDataOperations {
  const migrations = new DatabaseMigrationCoordinator(store);
  const recycling = new MigrationRecycling(store);
  const sessions = new Map<string, { actorId: string; scope: string }>();
  const allowedRead = (object: DataObject, scope: string): boolean => object.projectId === scope || object.objectId === scope || (object.projectId === null && ['memory', 'lesson', 'policy'].includes(object.kind) && ['verified', 'approved', 'active'].includes(String(object.data.status)));
  const dispatch = async (request: RuntimeDataRequest): Promise<unknown> => {
    if (!request || typeof request.operation !== 'string' || !request.input || typeof request.input !== 'object') throw new Error('invalid_data_request');
    const input = request.input;
    switch (request.operation) {
      case 'open_mcp_session': {
        const scope = String(input.projectId || '');
        const identity = store.establishMcpActor(scope, input.resume as { actorId: string; proof: string } | undefined);
        const sessionToken = crypto.randomBytes(32).toString('hex');
        sessions.set(sessionToken, { actorId: identity.actorId, scope });
        return { ...identity, sessionToken };
      }
      case 'close_mcp_session': {
        const token = String(input.sessionToken || '');
        const session = sessions.get(token);
        if (session) store.closeMcpActor(session.actorId, session.scope);
        sessions.delete(token);
        return { closed: true };
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
      case 'read_intelligence_conversation': return readIntelligenceConversation(store, String(input.id || ''));
      case 'list_intelligence_conversations': return listIntelligenceConversations(store);
      case 'write_intelligence_conversation': return store.writeIntelligenceConversation(input as unknown as Parameters<UnifiedDataStore['writeIntelligenceConversation']>[0]);
      case 'migration_status': return store.readMigrationJob(String(input.jobId || ''));
      case 'migration_overview': return recycling.overview();
      case 'prepare_recycling': return recycling.prepare();
      case 'read_recycling_plan': return recycling.readPlan(String(input.planId || ''));
      case 'retry_migration': return migrations.retry(String(input.jobId || ''));
      case 'confirm_recycling': return recycling.confirm(String(input.planId || ''));
      case 'hold_recycling_file': return recycling.hold(String(input.itemId || ''));
      case 'finish_recycling_file': return recycling.finish(String(input.itemId || ''));
      case 'retire_recycling_file': return recycling.retire(String(input.itemId || ''));
      case 'restore_recycling_file': return recycling.restore(String(input.itemId || ''));
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
        return store.context(input as unknown as Parameters<UnifiedDataStore['context']>[0], session ? object => allowedRead(object, session.scope) : undefined);
      }
      case 'export': return store.export(input as unknown as Parameters<UnifiedDataStore['export']>[0]);
      case 'backup': await store.backup(String(input.destination || '')); return { destination: input.destination };
      default: throw new Error('unknown_data_operation');
    }
  };
  const operations = async (request: RuntimeDataRequest) => {
    if (!request.sessionToken) return dispatch(request);
    const session = sessions.get(request.sessionToken);
    if (!session) throw new Error('mcp_session_expired');
    const input = request.input;
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

export async function runtimeProjectMcpSource(globalDataPath: string, projectRoot: string): Promise<UnifiedMcpSource | undefined> {
  if (!projectRoot || !fs.existsSync(path.join(globalDataPath, 'solomap.db'))) return undefined;
  const project = await sendRuntimeDataRequest<{ projectId: string }>(globalDataPath, { operation: 'register_project', input: { root: projectRoot } });
  return runtimeMcpSource(globalDataPath, project.projectId, true);
}
