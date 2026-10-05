import { RuntimeDataRequest, sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { DataWrite, UnifiedDataStore } from './db/unifiedDataStore';
import type { UnifiedMcpSource } from './unifiedMcp';
import * as crypto from 'crypto';
import type { DataObject } from './db/unifiedDataStore';
import { validateAgentLink, validateAgentWrite } from './dataAuthorization';
import { importMemoryDirectory } from './memoryDatabaseMigration';

export function createRuntimeDataOperations(store: UnifiedDataStore): (request: RuntimeDataRequest) => Promise<unknown> {
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
      case 'import_memory': return importMemoryDirectory(store, String(input.sourceRoot || ''), { projectScopes: input.projectScopes as Record<string, string> | undefined, sourceIdentity: input.sourceIdentity as string | undefined });
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
  return async request => {
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
