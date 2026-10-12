import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import type { RunState } from './runLifecycleTypes';

async function main(): Promise<void> {
  const action = String(process.argv[2] || '');
  if (!['start', 'complete', 'session-close', 'native-event', 'native-ready', 'native-append'].includes(action)) throw new Error('invalid_checkpoint_action');
  const args: Record<string, string> = {};
  for (let index = 3; index < process.argv.length; index += 2) {
    const key = process.argv[index]; const value = process.argv[index + 1];
    if (!key.startsWith('--') || value === undefined) throw new Error(`invalid_checkpoint_argument:${key}`);
    args[key.slice(2)] = value;
  }
  const globalDataPath = String(process.env.SOLOMAP_GLOBAL_DATA_PATH || '');
  const projectId = String(process.env.SOLOMAP_PROJECT_ID || '');
  const executionLogId = Number(process.env.SOLOMAP_EXECUTION_LOG_ID);
  const generation = Number(process.env.SOLOMAP_RUN_GENERATION);
  const proof = String(process.env.SOLOMAP_RUN_PROOF || '');
  if (!globalDataPath || !projectId || !Number.isInteger(executionLogId) || executionLogId < 1 || !Number.isInteger(generation) || generation < 1 || !proof) throw new Error('checkpoint_identity_required');
  const identity = { projectId, executionLogId };
  const call = <T>(operation: string, input: Record<string, unknown>) => sendRuntimeDataRequest<T>(globalDataPath, { operation, input });
  if (action === 'native-event' || action === 'native-ready' || action === 'native-append') {
    const parts: Buffer[] = [];
    for await (const part of process.stdin) parts.push(Buffer.from(part));
    const event = JSON.parse(Buffer.concat(parts).toString('utf8'));
    for (;;) {
      try {
        const result = await call<RunState & { claudeNativeResume?: unknown }>(action === 'native-ready' ? 'record_claude_native_ready' : action === 'native-append' ? 'record_claude_native_append' : 'record_claude_native_event',
          { ...identity, generation, proof, ...(action === 'native-ready' ? { sessionId: event.sessionId } : { event }) });
        process.stdout.write(`${JSON.stringify({ runId: result.runId, revision: result.revision, nextSequence: Number(result.status.claudeNativeEventHead || 0) + 1,
          ...(result.claudeNativeResume ? { resume: result.claudeNativeResume } : {}) })}\n`);
        return;
      } catch (error) {
        if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(String((error as NodeJS.ErrnoException).code))
          && !(error instanceof SyntaxError) && (error as Error).message !== 'different_runtime') throw error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  }
  let state = await call<RunState>('read_run_state', identity);
  let report: unknown;
  if (args['report-json'] !== undefined) {
    try { report = JSON.parse(args['report-json']); } catch { report = args['report-json']; }
  } else if (args['report-file']) {
    // A caller-supplied input is read once; no report copies or status files are produced.
    try { const bytes = await fs.promises.readFile(path.resolve(String(state.status.workspaceRoot), args['report-file']), 'utf8'); try { report = JSON.parse(bytes); } catch { report = bytes; } }
    catch (error) { report = { inputError: (error as Error).message }; }
  }
  const fields = {
    action, ...(args.message !== undefined ? { message: args.message } : {}),
    ...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
    ...(args.summary !== undefined ? { summary: args.summary } : {}),
    ...(args.next !== undefined ? { next: args.next } : {}),
    ...(args.code !== undefined ? { exitCode: Number(args.code) } : {}),
    ...(args['preserve-roadmap-state'] !== undefined ? { preserveRoadmapState: args['preserve-roadmap-state'] === 'true' } : {}),
    ...(report !== undefined ? { report } : {}),
    ...(state.status.sessionProvider === 'claude' && process.env.CLAUDE_CODE_SESSION_ID !== undefined && action !== 'session-close'
      ? { nativeSessionObservation: { provider: 'claude', sessionId: process.env.CLAUDE_CODE_SESSION_ID, source: 'CLAUDE_CODE_SESSION_ID' } } : {})
  };
  const boundTurnId = args['turn-id'] || process.env.SOLOMAP_TASK_TURN_ID || '';
  if (action !== 'session-close' && !boundTurnId) throw new Error('checkpoint_turn_required');
  const sourceTurnId = boundTurnId || state.turnId;
  const intent = JSON.stringify({ runId: state.runId, turnId: sourceTurnId, generation, ...fields });
  const idempotencyKey = args['idempotency-key'] || `checkpoint:${crypto.createHash('sha256').update(intent).digest('hex')}`;
  for (;;) {
    try {
      const result = await call<RunState>('checkpoint_run', { ...identity, generation, proof, expectedRevision: state.revision, ...(action !== 'session-close' ? { expectedTurnId: boundTurnId } : {}), idempotencyKey, ...fields });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    } catch (error) {
      if ((error as Error).message !== 'revision_conflict') throw error;
      const updated = await call<RunState>('read_run_state', identity);
      if (updated.turnId !== state.turnId || updated.generation !== generation) throw new Error('checkpoint_turn_conflict');
      state = updated;
    }
  }
}

void main().catch(error => {
  process.stderr.write(`SoloMap checkpoint: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = ['native-event', 'native-ready', 'native-append'].includes(String(process.argv[2])) ? 3 : 2;
});
