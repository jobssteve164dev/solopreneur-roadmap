import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { once } from 'events';
import { isRuntimeDataTransportError, sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { shellQuote, getAgentProvider } from './agentCli';
import { buildDatabaseAgentCommand, DatabaseAgentLaunch } from './agentDatabaseLaunch';
import { prepareNativeAgentLaunch, CapturedAgentProcess } from './agentRunPreflight';
import type { RunState } from './runLifecycleTypes';
import { snapshotWorkspace, workspaceDocumentPurpose, workspaceChanges, readWorkspaceGitHead } from './runWorkspace';
import { createPreSessionGitCommit } from './preSessionGit';
import { buildReadOnlyAgentCommandForPromptFile } from './agentCli';
import { getCodexSessionHome, NativeSessionBinding } from './sessionIdentity';
import { readWindowsProcessBirthMarker } from './processIdentity.js';
import { maintenanceRunKinds } from './runLifecycleTypes';
import { captureMaintenanceRunResult, maintenanceResultSignature } from './maintenanceRunResult';
import { captureRunLog } from './runLogBatching';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

function processBirth(pid: number): string {
  if (process.platform === 'win32') return readWindowsProcessBirthMarker(pid);
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return `proc:${stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19]}`;
  } catch {
    try { return `ps:${childProcess.execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim()}`; }
    catch { return ''; }
  }
}

async function main(): Promise<void> {
  const globalDataPath = argument('--global-data-path');
  const projectRoot = argument('--project-path');
  const executionLogId = Number(argument('--execution-log-id'));
  if (!globalDataPath || !projectRoot || !Number.isInteger(executionLogId) || executionLogId < 1) throw new Error('run_execution_arguments_required');
  let requestedSignal: NodeJS.Signals | undefined;
  const request = async <T>(operation: string, input: Record<string, unknown>): Promise<T> => {
    for (;;) {
      try { return await sendRuntimeDataRequest<T>(globalDataPath, { operation, input }); }
      catch (error) {
        if (requestedSignal && operation !== 'append_run_log') throw Object.assign(new Error(`执行已停止：${requestedSignal}`), { exitCode: requestedSignal === 'SIGINT' ? 130 : 143 });
        // Persistence is an observer of a live conversation, never its stop
        // authority. Keep this exact batch and idempotency key until recovery.
        if (operation !== 'append_run_log' && !isRuntimeDataTransportError(error)) throw error;
        // Keep accepted output queued while the same database owner restarts.
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  };
  const plan = await request<RunState & { command: string; prompt: string }>('read_run_execution_plan', { root: projectRoot, executionLogId });
  if (plan.status.finishedAt) {
    process.exitCode = Number(plan.status.exitCode ?? plan.status.sessionExitCode ?? (plan.status.status === 'Failed' ? 1 : 0));
    return;
  }
  const identity = { projectId: plan.projectId, executionLogId };
  const claimKey = `run:${plan.runId}:${plan.generation}:claim:${crypto.randomUUID()}`;
  let state: RunState;
  for (;;) {
    const latest = await request<RunState>('read_run_state', identity);
    if (latest.generation !== plan.generation) throw new Error('run_owner_conflict');
    if (latest.turnId !== plan.turnId) throw new Error('checkpoint_turn_conflict');
    try {
      state = await request<RunState>('claim_run', { ...identity, expectedRevision: latest.revision, agentPid: process.pid, processBirth: processBirth(process.pid), ...(process.env.SOLOMAP_TERMINAL_DELIVERY_ID ? { terminalDeliveryId: process.env.SOLOMAP_TERMINAL_DELIVERY_ID } : {}), idempotencyKey: claimKey });
      break;
    } catch (error) { if ((error as Error).message !== 'revision_conflict') throw error; }
  }
  const generation = state.generation;
  const proof = state.proof!;
  const checkpoint = async (fields: Record<string, unknown>): Promise<RunState> => {
    const idempotencyKey = `run:${plan.runId}:${generation}:host:${crypto.randomUUID()}`;
    const observed = await request<RunState>('read_run_state', identity);
    for (;;) {
      state = await request<RunState>('read_run_state', identity);
      if (state.generation !== generation) throw new Error('run_owner_conflict');
      if (state.turnId !== observed.turnId) throw new Error('checkpoint_turn_conflict');
      try { return await request<RunState>('checkpoint_run', { ...identity, generation, proof, expectedRevision: state.revision, expectedTurnId: observed.turnId, ...fields, idempotencyKey }); }
      catch (error) { if ((error as Error).message !== 'revision_conflict') throw error; }
    }
  };
  const finalizeOutput = async (exitCode: number): Promise<RunState> => {
    const idempotencyKey = `run:${plan.runId}:${generation}:host-output-finalized`;
    for (;;) {
      const latest = await request<RunState>('read_run_checkpoint_state', identity);
      if (latest.generation !== generation) throw new Error('run_owner_conflict');
      if (!latest.status.hostOutputPending) return latest;
      try { return await request<RunState>('finalize_run_output', { ...identity, generation, proof, expectedRevision: latest.revision, expectedTurnId: latest.turnId, exitCode, source: 'host', idempotencyKey }); }
      catch (error) { if ((error as Error).message !== 'revision_conflict') throw error; }
    }
  };
  const patch = async (fields: Record<string, unknown>): Promise<void> => {
    for (;;) {
      state = await request<RunState>('read_run_state', identity);
      if (state.generation !== generation) throw new Error('run_owner_conflict');
      try {
        state = await request<RunState>('patch_run_state', { ...identity, generation, expectedRevision: state.revision, patch: fields, idempotencyKey: `run:${plan.runId}:${generation}:process:${crypto.randomUUID()}` });
        return;
      } catch (error) { if ((error as Error).message !== 'revision_conflict') throw error; }
    }
  };
  const interactive = Boolean(plan.status.interactiveSession);
  const maintenance = maintenanceRunKinds.includes(String(plan.status.runKind));
  const executionRoot = maintenance ? String(plan.status.maintenanceWorkspaceRoot || projectRoot) : projectRoot;
  const captureMaintenanceResult = async (): Promise<boolean> => {
    return captureMaintenanceRunResult(globalDataPath, { ...state, generation }, request);
  };
  let codexHome = '';
  let claudeConfigDirOverride: string | null | undefined;
  let child: childProcess.ChildProcess | undefined;
  let exited: Promise<[number | null, NodeJS.Signals | null]> | undefined;
  let captures: Promise<void>[] = [];
  let temporaryInput = false;
  let terminationDecision = Promise.resolve();
  const stopDisplays = new Set<() => void>();
  const continuationStopSummary = (exitCode: number): string | undefined => {
    const intent = state.status.stopRequestIntent as { outcome?: string } | undefined;
    if (state.status.stopRequested && intent?.outcome === 'partial' && !state.status.failureCode && !state.status.failureReason
      && (requestedSignal || [0, 130, 143].includes(exitCode))) return String(state.status.stopReason);
    return undefined;
  };
  const signalChild = (signal: NodeJS.Signals) => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  const onTerminate = () => {
    terminationDecision = (async () => {
      try {
        const latest = await request<RunState>('read_run_state', identity);
        const intent = latest.status.stopRequestIntent as { expectedTurnId?: string } | undefined;
        if (latest.generation !== generation || !latest.status.stopRequested || intent?.expectedTurnId !== latest.turnId) return;
        state = latest;
        requestedSignal = 'SIGTERM';
        stopDisplays.forEach(stop => stop());
        signalChild('SIGTERM');
      } catch { /* A transport or stale-owner failure is not authority to stop a live Agent. */ }
    })();
  };
  const onInterrupt = () => { requestedSignal = 'SIGINT'; stopDisplays.forEach(stop => stop()); signalChild('SIGINT'); };
  process.on('SIGTERM', onTerminate);
  process.on('SIGINT', onInterrupt);
  const displayErrors = new Map<NodeJS.WritableStream, () => void>();
  const displayFiles: Array<Promise<fs.promises.FileHandle | undefined>> = [];
  const display = (output: NodeJS.WriteStream, fd: number): ((bytes: Buffer) => Promise<void>) => {
    let available = true;
    let wake: (() => void) | undefined;
    const onError = () => { available = false; wake?.(); };
    output.on('error', onError); displayErrors.set(output, onError);
    stopDisplays.add(onError);
    // Node's normal POSIX TTY writes can block the event loop. Use an owned
    // nonblocking descriptor so a paused display cannot prevent a formal stop.
    const file = output.isTTY && process.platform !== 'win32'
      ? fs.promises.open(`/dev/fd/${fd}`, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY).catch(() => undefined)
      : undefined;
    if (file) displayFiles.push(file);
    return async bytes => {
      if (!available) return;
      if (file) {
        const handle = await file;
        if (!handle) { onError(); return; }
        let offset = 0;
        while (available && offset < bytes.length) {
          try { offset += (await handle.write(bytes, offset, bytes.length - offset)).bytesWritten; }
          catch (error) {
            if (!['EAGAIN', 'EWOULDBLOCK', 'EINTR'].includes(String((error as NodeJS.ErrnoException).code))) { onError(); return; }
            await new Promise<void>(resolve => {
              const timer = setTimeout(done, 20);
              function done() { clearTimeout(timer); wake = undefined; resolve(); }
              wake = done;
              if (!available) done();
            });
          }
        }
        return;
      }
      await new Promise<void>(resolve => {
        const onBroken = () => { available = false; resolve(); };
        output.once('error', onBroken);
        try { output.write(bytes, () => { output.removeListener('error', onBroken); resolve(); }); }
        catch { output.removeListener('error', onBroken); available = false; resolve(); }
      });
    };
  };
  const stdoutDisplay = display(process.stdout, 1); const stderrDisplay = display(process.stderr, 2);
  const capture = async (stream: NodeJS.ReadableStream, name: string, forward: (bytes: Buffer) => Promise<void>, head: { nextSequence: number; totalBytes: number }): Promise<void> => {
    let sequence = head.nextSequence;
    let offset = head.totalBytes;
    await captureRunLog(stream, {
      forward,
      append: async bytes => {
        await request('append_run_log', { ...identity, generation, stream: name, sequence, offset, bytes: bytes.toString('base64'), idempotencyKey: `run:${plan.runId}:${generation}:${name}:${sequence}` });
        sequence++;
        offset += bytes.length;
      }
    });
  };
  const checkStopped = async () => {
    await terminationDecision;
    if (requestedSignal) throw Object.assign(new Error(`执行已停止：${requestedSignal}`), { exitCode: requestedSignal === 'SIGINT' ? 130 : 143 });
  };
  const execute = async (command: string, streams: [string, string], terminal: boolean, visible: boolean, collect = false): Promise<CapturedAgentProcess> => {
    if (!command.trim()) throw new Error('run_command_required');
    const heads = await Promise.all(streams.map(stream => request<{ nextSequence: number; totalBytes: number }>('read_run_log_head', { ...identity, stream })));
    await checkStopped();
    const inner = terminal ? `if command -v script >/dev/null 2>&1; then exec script -q -f -e -c ${shellQuote(command)} /dev/null; else exec bash -c ${shellQuote(command)}; fi` : `exec bash -c ${shellQuote(command)}`;
    // The child cannot execute the Agent before its PID is durably registered.
    // If the wrapper dies before releasing fd 3, EOF exits this gate.
    const env: NodeJS.ProcessEnv = { ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}), SOLOMAP_TASK_COMMAND: path.join(__dirname, 'taskCheckpointProcess.js'), SOLOMAP_GLOBAL_DATA_PATH: globalDataPath, SOLOMAP_PROJECT_ID: plan.projectId, SOLOMAP_EXECUTION_LOG_ID: String(executionLogId), SOLOMAP_RUN_GENERATION: String(generation), SOLOMAP_RUN_PROOF: proof, SOLOMAP_RUN_KIND: String(plan.status.runKind || ''), SOLOMAP_TASK_TURN_ID: state.turnId };
    if (claudeConfigDirOverride === null) delete env.CLAUDE_CONFIG_DIR;
    else if (claudeConfigDirOverride) env.CLAUDE_CONFIG_DIR = claudeConfigDirOverride;
    env.SOLOMAP_NODE_EXECUTABLE = process.execPath;
    env.ELECTRON_RUN_AS_NODE = '1';
    child = childProcess.spawn('bash', ['-c', `IFS= read -r solomap_launch_gate <&3 || exit 125; [ "$solomap_launch_gate" = launch ] || exit 125; exec 3<&-; ${inner}`], {
      cwd: executionRoot,
      stdio: ['inherit', 'pipe', 'pipe', 'pipe'],
      env,
      detached: process.platform !== 'win32'
    });
    exited = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>;
    // Observe spawn rejection immediately, including a missing shell.
    void exited.catch(() => undefined);
    if (!child.pid) await exited;
    await patch({ agentChildPid: child.pid!, processChildBirth: processBirth(child.pid!) });
    await checkStopped();
    // Attach readers before releasing the gate. Node drains unread pipes when
    // a short-lived child exits, so asynchronous discovery must happen first.
    const collected: Buffer[][] = [[], []];
    const forward = (index: number, display: (bytes: Buffer) => Promise<void>) => async (bytes: Buffer) => {
      if (collect) collected[index].push(bytes);
      if (visible) await display(bytes);
    };
    captures = [capture(child.stdout!, streams[0], forward(0, stdoutDisplay), heads[0]), capture(child.stderr!, streams[1], forward(1, stderrDisplay), heads[1])];
    const finished = Promise.all([...captures, exited]);
    void finished.catch(() => undefined);
    for (;;) {
      await checkStopped();
      const permission = await request<{ permission: 'allow' | 'wait' | 'deny'; reason: string }>('read_run_launch_permission', { ...identity, generation, proof, expectedTurnId: plan.turnId });
      if (permission.permission === 'allow') break;
      if (permission.permission === 'deny') {
        const message = permission.reason === 'run_source_turn_changed' ? '原任务已进入新一轮，这次修正已取消。'
          : permission.reason === 'flow_not_running' ? '此 Flow 已结束，未启动本次执行。' : '执行已停止。';
        await patch({ failureCode: permission.reason, failureReason: message });
        throw Object.assign(new Error(message), { exitCode: 143 });
      }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('执行等待期间宿主已关闭。');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    (child.stdio[3] as NodeJS.WritableStream).end('launch\n');
    const result = await finished;
    const [exitCode, signal] = result[2] as [number | null, NodeJS.Signals | null];
    const code = exitCode ?? (signal === 'SIGINT' ? 130 : 143);
    await checkStopped();
    return { code, stdout: Buffer.concat(collected[0]), stderr: Buffer.concat(collected[1]) };
  };
  const startupFailed = async (offsets: number[]): Promise<boolean> => {
    const patterns = [Buffer.from('app server did not become ready'), Buffer.from('app-server-control.sock: No such file or directory')];
    const overlap = Math.max(...patterns.map(value => value.length)) - 1;
    for (const [index, stream] of ['stdout', 'stderr'].entries()) {
      let offset: number | null = offsets[index]; let carry = Buffer.alloc(0);
      do {
        const page: { bytes: string; nextOffset: number | null } = await request('read_run_log', { ...identity, stream, offset, limit: 65536 });
        const bytes = Buffer.concat([carry, Buffer.from(page.bytes, 'base64')]);
        if (patterns.some(pattern => bytes.includes(pattern))) return true;
        carry = bytes.subarray(Math.max(0, bytes.length - overlap)); offset = page.nextOffset;
      } while (offset !== null);
    }
    return false;
  };
  const writeHostOutput = async (value: string): Promise<void> => {
    const bytes = Buffer.from(value);
    const head = await request<{ nextSequence: number; totalBytes: number }>('read_run_log_head', { ...identity, stream: 'stdout' });
    await request('append_run_log', { ...identity, generation, stream: 'stdout', sequence: head.nextSequence, offset: head.totalBytes, bytes: bytes.toString('base64'), idempotencyKey: `run:${plan.runId}:${generation}:stdout:${head.nextSequence}` });
    await stdoutDisplay(bytes);
  };
  try {
    if (maintenance && plan.status.maintenanceResultPath) {
      await patch({ maintenanceResultGeneration: generation, maintenanceResultBaseline: maintenanceResultSignature(String(plan.status.maintenanceResultPath)) });
    }
    if (getAgentProvider(String(plan.status.agentCli || (plan.status.agentLaunch as DatabaseAgentLaunch | undefined)?.agentCli || '')) === 'codex') {
      codexHome = getCodexSessionHome(await request<NativeSessionBinding | null>('read_run_binding', identity));
    }
    if (getAgentProvider(String(plan.status.agentCli || (plan.status.agentLaunch as DatabaseAgentLaunch | undefined)?.agentCli || '')) === 'claude') {
      const binding = await request<NativeSessionBinding | null>('read_run_binding', identity);
      const context = [...(binding?.revisions || [])].reverse().find(value => value.providerContext?.claude)?.providerContext?.claude as Record<string, unknown> | undefined;
      claudeConfigDirOverride = context?.configDirOverride === null ? null : String(context?.configDirOverride || context?.claudeHome || '') || undefined;
      if (claudeConfigDirOverride && !path.isAbsolute(claudeConfigDirOverride)) throw new Error('identity_provider_context_invalid');
    }
    if (!state.status.baseGitHash) {
      const baseGitHash = (plan.status.runKind === 'agent_review_revision' || plan.status.preSessionGitBackup === true)
        ? await createPreSessionGitCommit(projectRoot) || ''
        : await readWorkspaceGitHead(projectRoot);
      await patch({ baseGitHash });
    }
    const baselinePurpose = workspaceDocumentPurpose(state.turnId, 'before');
    if (!await request('read_run_document', { ...identity, purpose: baselinePurpose })) {
      const baseline = await snapshotWorkspace(projectRoot);
      await request('write_run_document', { ...identity, generation, turnId: state.turnId, purpose: baselinePurpose, bytes: Buffer.from(JSON.stringify(baseline)).toString('base64'), mimeType: 'application/json', expectedRevision: 0, idempotencyKey: `run:${plan.runId}:${generation}:workspace:before:${state.turnId}` });
    }
    let command = plan.command;
    const launch = plan.status.agentLaunch as DatabaseAgentLaunch | undefined;
    if (launch?.readOnly) {
      const materialized = await request<{ path: string }>('materialize_run_prompt', { ...identity, generation, proof });
      temporaryInput = true;
      command = buildReadOnlyAgentCommandForPromptFile(launch.agentCli, materialized.path, projectRoot, launch.selectedModel);
      if (!command) throw new Error('reviewer_read_only_mode_unsupported');
    } else if (launch) {
      state = await prepareNativeAgentLaunch({ state, workspaceRoot: projectRoot, operation: request, execute: (command, stream) => execute(command, [`preflight:${stream}:stdout`, `preflight:${stream}:stderr`], false, false, true) });
      if (!launch.direct) {
        const sessionId = String(state.status.plannedNativeSessionId || '');
        command = buildDatabaseAgentCommand({ ...launch, continuation: launch.continuation || (getAgentProvider(launch.agentCli) === 'cursor' && Boolean(sessionId)) }, plan.runId, plan.revision, executionRoot, interactive, sessionId, String(state.status.bindingNonce || ''), state.status.claudeNativeObserverCapable === true);
      }
    }
    const initialHeads = await Promise.all(['stdout', 'stderr'].map(stream => request<{ totalBytes: number }>('read_run_log_head', { ...identity, stream })));
    const execution = await execute(command, ['stdout', 'stderr'], interactive, true, Boolean(launch?.readOnly));
    let { code } = execution;
    if (maintenance && plan.status.maintenanceResultPath && !await captureMaintenanceResult() && code === 0) throw new Error('maintenance_result_missing');
    if (launch?.readOnly) {
      const baseline = await request<{ bytes: string }>('read_run_document', { ...identity, purpose: baselinePurpose });
      const after = await snapshotWorkspace(projectRoot);
      const changes = workspaceChanges(JSON.parse(Buffer.from(baseline.bytes, 'base64').toString('utf8')), after);
      const match = Buffer.concat([execution.stdout, execution.stderr]).toString('utf8').match(/SOLOMAP_REVIEW_JSON_START\s*([\s\S]*?)\s*SOLOMAP_REVIEW_JSON_END/);
      let result: Record<string, unknown> | undefined;
      try { result = match ? JSON.parse(match[1]) : undefined; } catch {}
      if (changes.length) {
        code = 126;
        await patch({ failureCode: 'reviewer_workspace_modified', failureReason: '只读复核期间项目文件发生变更，复核未通过。' });
      } else if (!result || !['pass', 'revise', 'needs_user_confirmation'].includes(String(result.status))) {
        code = 125;
        await patch({ failureCode: 'agent_review_failed', failureReason: '复核未返回可解析的判断，完整输出已保存。' });
      }
      if (result) {
        const document = await request<{ objectId: string; revision: number }>('write_run_document', { ...identity, generation, turnId: state.turnId, purpose: 'review_result', bytes: Buffer.from(JSON.stringify(result)).toString('base64'), mimeType: 'application/json', expectedRevision: 0, idempotencyKey: `run:${plan.runId}:${generation}:review-result` });
        await patch({ reviewResultObjectId: document.objectId, reviewResultRevision: document.revision });
      }
    }
    if (code !== 0 && interactive && launch && getAgentProvider(launch.agentCli) === 'codex' && await startupFailed(initialHeads.map(head => head.totalBytes))) {
      const cli = shellQuote(launch.agentCli);
      const fallback = command.startsWith(`${cli} resume `) ? `${cli} resume --no-daemon ${command.slice(`${cli} resume `.length)}`
        : command.startsWith(`${cli} `) ? `${cli} --no-daemon ${command.slice(`${cli} `.length)}` : '';
      if (fallback) {
        await writeHostOutput('\n会话启动暂时不可用，正在自动重试。\n');
        ({ code } = await execute(fallback, ['stdout', 'stderr'], true, true));
      }
    }
    state = await request<RunState>('read_run_state', identity);
    if (!state.status.finishedAt && ['Running', 'Waiting', 'Processed', 'Turn Started'].includes(String(state.status.status))) {
      const stopSummary = continuationStopSummary(code);
      const settled = await checkpoint({ action: 'complete', requireDeliverable: !maintenance && !interactive && !launch?.readOnly && !['flow_planner', 'flow_verifier'].includes(String(plan.status.runKind)), outcome: stopSummary || code === 0 ? 'partial' : 'failed', exitCode: code, summary: stopSummary || (code === 0 ? '本轮执行已结束，完整输出已保存。' : `本轮执行退出，退出码 ${code}，完整输出已保存。`) });
      code = Number(settled.status.exitCode ?? code);
      if (settled.status.failureCode === 'no_deliverable_changes') await writeHostOutput(`\n${settled.status.failureReason}\n`);
    }
    if (!interactive) code = Number((await finalizeOutput(code)).status.exitCode ?? code);
    if (interactive) await checkpoint({ action: 'session-close', exitCode: code });
    process.exitCode = code;
  } catch (error) {
    signalChild('SIGTERM');
    if (exited) await exited.catch(() => undefined);
    await Promise.allSettled(captures);
    try { await captureMaintenanceResult(); }
    catch (captureError) { await writeHostOutput(`\n安装回执保存失败：${captureError instanceof Error ? captureError.message : String(captureError)}\n`); }
    state = await request<RunState>('read_run_state', identity);
    const exitCode = Number((error as Error & { exitCode?: number }).exitCode || 1);
    const stopSummary = requestedSignal && [130, 143].includes(exitCode) ? continuationStopSummary(exitCode) : undefined;
    if (state.generation === generation && !state.status.finishedAt && ['Preparing', 'Running', 'Waiting', 'Processed', 'Turn Started'].includes(String(state.status.status))) {
      await checkpoint({ action: 'complete', outcome: stopSummary ? 'partial' : 'failed', exitCode, summary: stopSummary || (error instanceof Error ? error.message : String(error)) });
    }
    if (!interactive && state.generation === generation) await finalizeOutput(exitCode);
    if (interactive && state.generation === generation) await checkpoint({ action: 'session-close', exitCode });
    if (stopSummary) { process.exitCode = exitCode; return; }
    throw error;
  } finally {
    process.off('SIGTERM', onTerminate);
    process.off('SIGINT', onInterrupt);
    if (child && child.exitCode === null && child.signalCode === null) { signalChild('SIGTERM'); await exited?.catch(() => undefined); }
    if (temporaryInput) await request('release_run_prompt', { ...identity, generation, proof });
    displayErrors.forEach((listener, output) => output.removeListener('error', listener));
    await Promise.all(displayFiles.map(async file => { await (await file)?.close(); }));
  }
}

void main().catch(error => {
  process.stderr.write(`SoloMap 无法完成本轮执行：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = Number((error as Error & { exitCode?: number }).exitCode || 1);
});
