import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { UnifiedDataStore } from './db/unifiedDataStore';
import { snapshotWorkspace, captureRunGitEvidence } from './runWorkspace';
import type { RunState } from './runLifecycleTypes';
import { readWindowsProcessBirthMarkerAsync } from './processIdentity.js';
import { RunNativeObserver } from './runNativeObserver';

interface TrackedProcess { pid: number; birth: string }

export function captureNativeStopBoundary(store: UnifiedDataStore, state: RunState): { nativeStopStream: 'native:codex' | 'native:claude'; nativeStopLogBoundary: number } | undefined {
  const provider = String(state.status.sessionProvider || '');
  if (!['codex', 'claude'].includes(provider)) return undefined;
  try {
    const binding = store.readRunBinding(state.projectId, Number(state.status.executionLogId));
    if (!binding || binding.provider !== provider
      || path.resolve(binding.workspaceRoot) !== path.resolve(String(state.status.workspaceRoot || ''))
      || binding.resumableRevision !== binding.headRevision
      || Number(state.status.sessionBindingHeadRevision) !== binding.headRevision) return undefined;
    const head = binding.revisions[binding.headRevision - 1];
    if (!head || head.revision !== binding.headRevision || head.state !== 'confirmed' || !head.sessionId
      || head.sessionId !== state.status.nativeSessionId) return undefined;
    const transcriptPath = String(head.evidence?.transcriptPath || '');
    if (!transcriptPath) return undefined;
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) return undefined;
    const sourceSize = stat.size;
    const sourceOffset = provider === 'codex' ? Number(state.status.codexNativeSourceOffset || 0) : 0;
    if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0 || sourceSize < sourceOffset) return undefined;
    return { nativeStopStream: provider === 'codex' ? 'native:codex' : 'native:claude', nativeStopLogBoundary: sourceSize - sourceOffset };
  } catch { return undefined; }
}

async function alive(target: TrackedProcess, requireVerifiedIdentity = false): Promise<boolean> {
  if (!target.pid) return false;
  if (target.pid <= 1 || target.pid === process.pid) throw new Error('run_process_identity_conflict');
  try { process.kill(target.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }
  if (!target.birth) throw new Error('run_process_identity_unverified');
  let actual = '';
  if (process.platform === 'win32' && target.birth.startsWith('win32:')) actual = await readWindowsProcessBirthMarkerAsync(target.pid);
  else try {
    const stat = await fs.promises.readFile(`/proc/${target.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
    if (fields[0] === 'Z') return false;
    actual = `proc:${fields[19]}`;
  } catch {
    actual = await new Promise<string>(resolve => execFile('ps', ['-o', 'lstart=', '-p', String(target.pid)], { encoding: 'utf8' }, (error, output) => resolve(!error && output.trim() ? `ps:${output.trim()}` : '')));
  }
  if (!actual) {
    try { process.kill(target.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; }
    throw new Error('run_process_identity_unverified');
  }
  if (requireVerifiedIdentity && actual !== target.birth) throw new Error('run_process_identity_unverified');
  return actual === target.birth;
}

export class RunStop {
  private readonly pending = new Map<string, Promise<RunState>>();
  private interrupted = false;
  constructor(private readonly store: UnifiedDataStore) {}

  public stop(projectId: string, input: Parameters<UnifiedDataStore['requestRunStop']>[1]): Promise<RunState> {
    if (this.interrupted) return Promise.reject(new Error('run_stop_interrupted'));
    const current = this.store.readRunCheckpointState(projectId, input.executionLogId);
    const persistedIntent = current.status.stopRequestIntent;
    const replayingAcceptedStop = current.generation === input.generation
      && current.status.stopRequested === true
      && current.status.stopRequestKey === input.idempotencyKey
      && persistedIntent && typeof persistedIntent === 'object';
    const accepted = replayingAcceptedStop ? current : this.store.requestRunStop(projectId, input, captureNativeStopBoundary(this.store, current));
    const acceptedInput = replayingAcceptedStop
      ? { ...(persistedIntent as Parameters<UnifiedDataStore['requestRunStop']>[1]), expectedRevision: current.revision }
      : input;
    const key = `${accepted.runId}:${accepted.generation}:${input.idempotencyKey}`;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const stopping = this.finish(projectId, acceptedInput, accepted);
    this.pending.set(key, stopping);
    void stopping.then(() => this.pending.delete(key), () => this.pending.delete(key));
    return stopping;
  }

  private async finish(projectId: string, input: Parameters<UnifiedDataStore['requestRunStop']>[1], accepted: RunState): Promise<RunState> {
    const current = () => {
      if (this.interrupted) throw new Error('run_stop_interrupted');
      const state = this.store.readRunCheckpointState(projectId, input.executionLogId);
      if (state.generation !== accepted.generation) throw new Error('run_owner_conflict');
      return state;
    };
    let state = current();
    const wrapper = { pid: Number(state.status.agentPid), birth: String(state.status.processBirth) };
    const child = { pid: Number(state.status.agentChildPid), birth: String(state.status.processChildBirth) };
    if (input.requireVerifiedIdentity) {
      for (const target of [child, wrapper]) { current(); await alive(target, true); }
    }
    for (const target of [child, wrapper]) {
      current();
      if (await alive(target, input.requireVerifiedIdentity)) {
        current();
        try { process.kill(target === child && process.platform !== 'win32' ? -target.pid : target.pid, 'SIGTERM'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }
    const forceAfter = Date.now() + 1500;
    let forced = false;
    while (await alive(child)) {
      current();
      if (!forced && Date.now() >= forceAfter) {
        if (await alive(child)) {
          try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        }
        forced = true;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    // The wrapper must finish committing accepted output before closure.
    while (await alive(wrapper)) { current(); await new Promise(resolve => setTimeout(resolve, 25)); }
    state = current();
    if (state.status.interactiveSessionClosed) { new RunNativeObserver(this.store).forget(state); return state; }
    await new RunNativeObserver(this.store).observe(state, false, 143);
    state = current();
    const finishedBeforeStop = Boolean(state.status.finishedAt);
    const workspaceSnapshot = state.status.finishedAt && !state.status.hostOutputPending && !state.status.nativeOutputPending ? undefined : await snapshotWorkspace(String(state.status.workspaceRoot));
    const gitEvidence = workspaceSnapshot ? await captureRunGitEvidence(String(state.status.workspaceRoot), String(state.status.baseGitHash || ''), workspaceSnapshot) : undefined;
    state = current();
    if (state.status.hostOutputPending) state = this.store.finalizeRunOutput(projectId, { executionLogId: input.executionLogId, generation: state.generation, proof: state.proof!, expectedRevision: state.revision, expectedTurnId: state.turnId, exitCode: 143, source: 'recovery', workspaceSnapshot, gitEvidence, idempotencyKey: `${input.idempotencyKey}:finalize-output` });
    if (!state.status.finishedAt) state = this.store.checkpointRun(projectId, { executionLogId: input.executionLogId, generation: state.generation, proof: state.proof!, expectedRevision: state.revision, expectedTurnId: state.turnId, action: 'complete', outcome: input.outcome === 'partial' ? 'partial' : 'failed', summary: input.reason, exitCode: 143, workspaceSnapshot, gitEvidence, workspaceEvidenceSource: 'recovery', idempotencyKey: `${input.idempotencyKey}:complete` });
    if ((state.status.interactiveSession || finishedBeforeStop) && !state.status.interactiveSessionClosed) {
      state = current();
      state = this.store.checkpointRun(projectId, { executionLogId: input.executionLogId, generation: state.generation, proof: state.proof!, expectedRevision: state.revision, expectedTurnId: state.turnId, action: 'session-close', exitCode: 143, ...(state.status.nativeOutputPending ? { workspaceSnapshot, gitEvidence, workspaceEvidenceSource: 'recovery' as const } : {}), idempotencyKey: `${input.idempotencyKey}:close` });
    }
    new RunNativeObserver(this.store).forget(state);
    return state;
  }

  public interrupt(): void { this.interrupted = true; }
  public async close(): Promise<void> { this.interrupt(); await Promise.allSettled(this.pending.values()); }
}
