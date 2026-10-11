import * as childProcess from 'child_process';
import { once } from 'events';
import { StringDecoder } from 'string_decoder';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import type { RunState } from './runLifecycleTypes';
import type { NativeSessionBinding } from './sessionIdentity';
import type { DatabaseAgentLaunch } from './agentDatabaseLaunch';

async function main(): Promise<void> {
  const root = String(process.env.SOLOMAP_GLOBAL_DATA_PATH || '');
  const identity = { projectId: String(process.env.SOLOMAP_PROJECT_ID || ''), executionLogId: Number(process.env.SOLOMAP_EXECUTION_LOG_ID) };
  const generation = Number(process.env.SOLOMAP_RUN_GENERATION);
  const operation = async <T>(operation: string, input: Record<string, unknown>): Promise<T> => {
    for (;;) {
      try { return await sendRuntimeDataRequest<T>(root, { operation, input }); }
      catch (error) {
        if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(String((error as NodeJS.ErrnoException).code)) && (error as Error).message !== 'different_runtime' && !(error instanceof SyntaxError)) throw error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  };
  const state = await operation<RunState & { prompt: string }>('read_run_execution_plan', identity);
  if (state.generation !== generation || state.turnId !== process.env.SOLOMAP_TASK_TURN_ID) throw new Error('run_owner_conflict');
  const launch = state.status.agentLaunch as DatabaseAgentLaunch;
  const sessionId = String(state.status.plannedNativeSessionId || '');
  if (!launch.continuation || !sessionId) throw new Error('native_resume_target_required');
  const head = await operation<{ nextSequence: number; totalBytes: number }>('read_run_log_head', { ...identity, stream: 'native:codex' });
  const child = childProcess.spawn(launch.agentCli, ['app-server'], { cwd: String(state.status.workspaceRoot), stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>;
  void closed.catch(() => undefined);
  let completed = false; let nativeTurnId = ''; let assistant = ''; let failure = '';
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const stop = () => { child.kill('SIGTERM'); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  let sequence = head.nextSequence; let offset = head.totalBytes;
  const frame = async (line: string): Promise<void> => {
    let message: any;
    try { message = JSON.parse(line); } catch { failure = 'codex_event_invalid'; stop(); return; }
    if (message.error) { failure = String(message.error.message || 'codex_app_server_error'); stop(); return; }
    if (message.id === 0) {
      send({ method: 'initialized', params: {} });
      send({ id: 1, method: 'thread/resume', params: { threadId: sessionId, cwd: state.status.workspaceRoot, ...(launch.taskPermissionMode === 'never' ? {} : { approvalPolicy: 'never', sandbox: 'danger-full-access' }), ...(launch.selectedModel ? { model: launch.selectedModel } : {}) } });
    } else if (message.id === 1) {
      if (String(message.result?.thread?.id || '') !== sessionId) { failure = 'native_resume_target_mismatch'; stop(); return; }
      const binding = await operation<NativeSessionBinding>('read_run_binding', identity);
      if (!binding) throw new Error('run_native_binding_missing');
      const confirmed = await operation<NativeSessionBinding>('write_run_binding', { ...identity, generation, expectedHeadRevision: binding.headRevision, confirmSessionId: sessionId, evidence: { source: 'codex_app_server', logRef: `solomap://run/${state.runId}/native:codex` }, idempotencyKey: `run:${state.runId}:${generation}:app-server-confirmed` });
      for (;;) {
        const current = await operation<RunState>('read_run_state', identity);
        if (current.generation !== generation || current.turnId !== state.turnId) throw new Error('run_owner_conflict');
        try { await operation('patch_run_state', { ...identity, generation, expectedRevision: current.revision, patch: { nativeSessionId: sessionId, nativeSessionIdIsCurrent: true, sessionBindingHeadRevision: confirmed.headRevision }, idempotencyKey: `run:${state.runId}:${generation}:app-server-identity` }); break; }
        catch (error) { if ((error as Error).message !== 'revision_conflict') throw error; }
      }
      for (;;) {
        const permission = await operation<{ permission: 'allow' | 'wait' | 'deny'; reason: string }>('read_run_launch_permission', { ...identity, generation, proof: process.env.SOLOMAP_RUN_PROOF, expectedTurnId: state.turnId });
        if (permission.permission === 'deny') throw new Error(permission.reason);
        if (permission.permission === 'allow') break;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('codex_app_server_closed_before_completion');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      send({ id: 2, method: 'turn/start', params: { threadId: sessionId, input: [{ type: 'text', text: state.prompt, text_elements: [] }], ...(launch.selectedModel ? { model: launch.selectedModel } : {}) } });
    } else if (message.id === 2) {
      nativeTurnId = String(message.result?.turn?.id || '');
      if (!nativeTurnId) { failure = 'native_turn_identity_missing'; stop(); }
    } else {
      if (String(message.params?.threadId || '') !== sessionId) return;
      if (message.method === 'item/agentMessage/delta' && String(message.params?.turnId || '') === nativeTurnId) { const delta = String(message.params.delta || ''); assistant += delta; process.stdout.write(delta); }
      if (message.method === 'item/completed' && String(message.params?.turnId || '') === nativeTurnId && message.params?.item?.type === 'agentMessage' && !assistant) { assistant = String(message.params.item.text || ''); process.stdout.write(assistant); }
      if (message.method === 'turn/completed' && String(message.params?.turn?.id || '') === nativeTurnId) { completed = message.params.turn.status === 'completed'; if (!completed) failure = `codex_turn_${String(message.params.turn.status)}`; stop(); }
    }
  };
  const stderr = (async () => { for await (const bytes of child.stderr) process.stderr.write(bytes); })();
  try {
    send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'solomap_vscode', title: 'SoloMap VS Code Extension', version: '0.1.0' }, capabilities: null } });
    const decoder = new StringDecoder('utf8'); let pending = '';
    for await (const value of child.stdout) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      await operation('append_run_log', { ...identity, generation, stream: 'native:codex', sequence, offset, bytes: bytes.toString('base64'), idempotencyKey: `run:${state.runId}:${generation}:native:codex:${sequence}` }); sequence++; offset += bytes.length;
      pending += decoder.write(bytes);
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); if (line.trim()) await frame(line); }
    }
    pending += decoder.end(); if (pending.trim()) await frame(pending);
    await closed; await stderr;
    if (!completed || failure) throw new Error(failure || 'codex_app_server_closed_before_completion');
  } finally {
    stop(); await closed.catch(() => undefined); await stderr;
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
  }
}
void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
