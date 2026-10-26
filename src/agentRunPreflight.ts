import * as crypto from 'crypto';
import * as path from 'path';
import { getAgentProvider, shellQuote } from './agentCli';
import { agentDatabaseConfigPath, codexDatabaseProfileName, codexDatabaseProfilePath, databaseAgentProviders, DatabaseAgentProvider, ensureCodexProjectTrusted } from './agentDatabaseConfig';
import type { NativeSessionBinding } from './sessionIdentity';
import { getCodexSessionHome } from './sessionIdentity';
import type { RunState } from './runLifecycleTypes';

type Operation = (operation: string, input: Record<string, unknown>) => Promise<unknown>;
export interface CapturedAgentProcess { code: number; stdout: Buffer; stderr: Buffer }

export async function prepareNativeAgentLaunch(input: {
  state: RunState;
  workspaceRoot: string;
  operation: Operation;
  execute: (command: string, stream: string) => Promise<CapturedAgentProcess>;
  prepareDatabase?: boolean;
  globalDataPath?: string;
}): Promise<RunState> {
  let state = input.state;
  const executionLogId = Number(state.status.executionLogId);
  const scope = { root: input.workspaceRoot, projectId: state.projectId, executionLogId, generation: state.generation };
  const cli = String(state.status.agentCli || (state.status.agentLaunch as { agentCli?: string } | undefined)?.agentCli || '');
  const provider = getAgentProvider(cli);
  const launch = state.status.agentLaunch as { codexProfile?: string } | undefined;
  const unique = (purpose: string) => `run:${state.runId}:${state.generation}:${purpose}:${crypto.randomUUID()}`;
  const patch = async (value: Record<string, unknown>) => {
    const key = unique('preflight-state');
    for (;;) {
      state = await input.operation('read_run_state', scope) as RunState;
      if (state.generation !== scope.generation) throw new Error('run_owner_conflict');
      try { state = await input.operation('patch_run_state', { ...scope, expectedRevision: state.revision, patch: value, idempotencyKey: key }) as RunState; return; }
      catch (error) { if ((error as Error).message !== 'revision_conflict') throw error; }
    }
  };
  const binding = ['codex', 'claude'].includes(provider) ? await input.operation('read_run_binding', scope) as NativeSessionBinding | null : null;
  const codexHome = provider === 'codex' ? getCodexSessionHome(binding) : '';
  if (state.status.interactiveSession === true && provider === 'codex') ensureCodexProjectTrusted(codexHome, input.workspaceRoot);
  if (input.prepareDatabase !== false && databaseAgentProviders.includes(provider as DatabaseAgentProvider)) {
    const claude = provider === 'claude' ? [...(binding?.revisions || [])].reverse().find(value => value.providerContext?.claude)?.providerContext?.claude as Record<string, unknown> | undefined : undefined;
    const configPath = provider === 'codex'
      ? codexDatabaseProfilePath(codexHome || undefined, launch?.codexProfile || codexDatabaseProfileName(input.globalDataPath || String(state.status.globalDataPath || '')))
      : String(claude?.configPath || state.status.agentDatabaseConfigPath || agentDatabaseConfigPath(provider as DatabaseAgentProvider));
    await input.operation('prepare_agent_database', { root: input.workspaceRoot, provider, command: process.execPath, configPath });
  }
  if (state.status.interactiveSession !== true) return state;
  const fail = async (code: string, reason: string, source: string): Promise<never> => {
    const binding = await input.operation('read_run_binding', scope) as NativeSessionBinding | null;
    let headRevision = binding?.headRevision || 0;
    if (binding) {
      const head = binding.revisions[binding.headRevision - 1];
      const updated = await input.operation('write_run_binding', { ...scope, expectedHeadRevision: binding.headRevision, revision: {
        ...(head.sessionId ? { sessionId: head.sessionId } : {}), supersedesRevision: binding.headRevision, method: head.method, contract: head.contract,
        state: 'unavailable', errorCode: code, evidence: { source, logRef: `solomap://run/${state.runId}/preflight` }
      }, idempotencyKey: unique('identity-unavailable') }) as NativeSessionBinding;
      headRevision = updated.headRevision;
    }
    await patch({ failureCode: code, failureReason: reason, sessionBindingHeadRevision: headRevision });
    throw Object.assign(new Error(reason), { code, exitCode: 126 });
  };
  // Caller-assigned session IDs are part of the formal provider invocation.
  // Never put an extra --help/--version subprocess in front of a user task;
  // unsupported versions fail as that one formal invocation, without delaying
  // every compatible launch or creating a second attempt.
  if (provider === 'cursor') {
    state = await input.operation('read_run_state', scope) as RunState;
    if (state.generation !== scope.generation) throw new Error('run_owner_conflict');
    let binding = await input.operation('read_run_binding', scope) as NativeSessionBinding;
    let head = binding.revisions[binding.headRevision - 1];
    const acknowledged = () => head.method === 'provider_created' && head.contract === 'official_stable' && head.evidence?.source === 'cursor_create_chat' && Boolean(head.sessionId) && ['planned', 'confirmed'].includes(head.state);
    if (!String(state.status.plannedNativeSessionId || '') && !acknowledged()) {
      const createHelp = await input.execute(`${shellQuote(cli)} create-chat --help`, 'create-chat-help');
      const help = await input.execute(`${shellQuote(cli)} --help`, 'identity-help');
      if (createHelp.code !== 0 || help.code !== 0 || !Buffer.concat([help.stdout, help.stderr]).includes(Buffer.from('--resume'))) await fail('identity_capability_missing', '当前 Cursor CLI 无法创建并继续指定会话，请升级后重试。', 'official_cli_help');
      const created = await input.execute(`${shellQuote(cli)} create-chat`, 'create-chat');
      if (created.code !== 0) await fail('native_session_creation_failed', 'Cursor 未能创建本次会话，请查看执行输出后重试。', 'cursor_create_chat');
      const sessionId = Buffer.concat([created.stdout, created.stderr]).toString('utf8').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{5,255}$/.test(sessionId)) await fail('native_session_id_ambiguous', 'Cursor 返回的会话标识无法确认，请重试。', 'cursor_create_chat');
      binding = await input.operation('write_run_binding', { ...scope, expectedHeadRevision: binding.headRevision, revision: {
        sessionId, method: 'provider_created', contract: 'official_stable', state: 'planned', evidence: { source: 'cursor_create_chat' }
      }, idempotencyKey: unique('cursor-planned') }) as NativeSessionBinding;
      head = binding.revisions[binding.headRevision - 1];
    }
    if (acknowledged()) {
      if (head.state === 'planned') {
        binding = await input.operation('write_run_binding', { ...scope, expectedHeadRevision: binding.headRevision, confirmSessionId: head.sessionId, evidence: head.evidence, idempotencyKey: `run:${state.runId}:${state.generation}:cursor-ack:${binding.headRevision}` }) as NativeSessionBinding;
        head = binding.revisions[binding.headRevision - 1];
      }
      state = await input.operation('read_run_state', scope) as RunState;
      const projection = { plannedNativeSessionId: head.sessionId, sessionBindingHeadRevision: binding.headRevision, nativeSessionId: head.sessionId, nativeSessionIdIsCurrent: true };
      if (Object.entries(projection).some(([key, value]) => state.status[key] !== value)) await patch(projection);
    }
  }
  return state;
}
