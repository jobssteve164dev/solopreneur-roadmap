import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { UnifiedDataStore } from './db/unifiedDataStore';
import type { ContentPublicationCommit } from './db/unifiedDataStore';
import type { NativeSessionBinding } from './sessionIdentity.js';
import { snapshotWorkspace, captureRunGitEvidence } from './runWorkspace';
import type { RunState } from './runLifecycleTypes';
import { readWindowsProcessBirthMarkerAsync } from './processIdentity.js';
import { RunNativeObserver } from './runNativeObserver';
import type { RuntimeWorkspaceCompute } from './runtimeDataOperations';

interface TrackedProcess { pid: number; birth: string }

export function captureNativeStopBoundary(store: UnifiedDataStore, state: RunState, preparedBinding?: NativeSessionBinding | null): { nativeStopStream: 'native:codex' | 'native:claude'; nativeStopLogBoundary: number } | undefined {
  const provider = String(state.status.sessionProvider || '');
  if (!['codex', 'claude'].includes(provider)) return undefined;
  try {
    const binding = preparedBinding === undefined ? store.readRunBinding(state.projectId, Number(state.status.executionLogId)) : preparedBinding;
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
  constructor(private readonly store: UnifiedDataStore, private readonly workspaceCompute: RuntimeWorkspaceCompute = {
    snapshot: snapshotWorkspace, gitHead: async () => '', gitEvidence: captureRunGitEvidence
  }) {}

  public stop(projectId: string, input: Parameters<UnifiedDataStore['requestRunStop']>[1],commit:ContentPublicationCommit=publish=>publish()): Promise<RunState> {
    if (this.interrupted) return Promise.reject(new Error('run_stop_interrupted'));
    const owned={...input},key=JSON.stringify([projectId,owned.executionLogId,owned.generation,owned.idempotencyKey]);
    const pending=this.pending.get(key);if(pending)return pending;
    // Admission includes preparation, so shutdown cannot lose an accepted intent.
    const stopping=this.acceptAndFinish(projectId,owned,commit);
    this.pending.set(key,stopping);
    void stopping.then(()=>this.pending.delete(key),()=>this.pending.delete(key));
    return stopping;
  }

  private async acceptAndFinish(projectId:string,input:Parameters<UnifiedDataStore['requestRunStop']>[1],commit:ContentPublicationCommit):Promise<RunState> {
    const context=await this.store.readRunContextPublication(projectId,{executionLogId:input.executionLogId,includeProof:true,includeBinding:true},true),current=context.state;
    const persistedIntent = current.status.stopRequestIntent;
    const replayingAcceptedStop = current.generation === input.generation
      && current.status.stopRequested === true
      && current.status.stopRequestKey === input.idempotencyKey
      && persistedIntent && typeof persistedIntent === 'object';
    const trustedBoundary=captureNativeStopBoundary(this.store,current,context.binding);
    const accepted = replayingAcceptedStop ? commit(()=>{this.store.assertRunGeneration(projectId,input.executionLogId,current.generation);return current;}) : await this.store.publishRunControl(projectId,{type:'stop',input,contextRevision:current.revision,...(trustedBoundary?{trustedBoundary}:{})},commit) as RunState;
    const acceptedInput = replayingAcceptedStop
      ? { ...(persistedIntent as Parameters<UnifiedDataStore['requestRunStop']>[1]), expectedRevision: current.revision }
      : input;
    return this.finish(projectId,acceptedInput,accepted,commit);
  }

  private async finish(projectId: string, input: Parameters<UnifiedDataStore['requestRunStop']>[1], accepted: RunState,commit:ContentPublicationCommit): Promise<RunState> {
    const fence = () => {
      if (this.interrupted) throw new Error('run_stop_interrupted');
      commit(()=>this.store.assertRunGeneration(projectId,input.executionLogId,accepted.generation));
    };
    const current = async () => {
      fence();
      const {state}=await this.store.readRunContextPublication(projectId,{executionLogId:input.executionLogId,generation:accepted.generation,includeProof:true},true);
      fence();return state;
    };
    let state = await current();
    const wrapper = { pid: Number(state.status.agentPid), birth: String(state.status.processBirth) };
    const child = { pid: Number(state.status.agentChildPid), birth: String(state.status.processChildBirth) };
    if (input.requireVerifiedIdentity) {
      for (const target of [child, wrapper]) { fence(); await alive(target, true); }
    }
    for (const target of [child, wrapper]) {
      fence();
      if (await alive(target, input.requireVerifiedIdentity)) {
        fence();
        try { process.kill(target === child && process.platform !== 'win32' ? -target.pid : target.pid, 'SIGTERM'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }
    const forceAfter = Date.now() + 1500;
    let forced = false;
    while (await alive(child)) {
      fence();
      if (!forced && Date.now() >= forceAfter) {
        if (await alive(child)) {
          fence();
          try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        }
        forced = true;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    // The wrapper must finish committing accepted output before closure.
    while (await alive(wrapper)) { fence(); await new Promise(resolve => setTimeout(resolve, 25)); }
    state = await current();
    if (state.status.interactiveSessionClosed) { await new RunNativeObserver(this.store, this.workspaceCompute).forget(state); return state; }
    await new RunNativeObserver(this.store, this.workspaceCompute).observe(state, false, 143);
    state = await current();
    const finishedBeforeStop = Boolean(state.status.finishedAt);
    const workspaceSnapshot = state.status.finishedAt && !state.status.hostOutputPending && !state.status.nativeOutputPending ? undefined : await this.workspaceCompute.snapshot(String(state.status.workspaceRoot));
    const gitEvidence = workspaceSnapshot ? await this.workspaceCompute.gitEvidence(String(state.status.workspaceRoot), String(state.status.baseGitHash || ''), workspaceSnapshot) : undefined;
    state = await current();
    if (state.status.hostOutputPending) state = await this.store.publishRunOutput(projectId, { executionLogId: input.executionLogId, generation: state.generation, proof: state.proof!, expectedRevision: state.revision, expectedTurnId: state.turnId, exitCode: 143, source: 'recovery', workspaceSnapshot, gitEvidence, idempotencyKey: `${input.idempotencyKey}:finalize-output` },commit);
    if (!state.status.finishedAt) state = await this.store.publishRunCheckpoint(projectId, { executionLogId: input.executionLogId, generation: state.generation, proof: state.proof!, expectedRevision: state.revision, expectedTurnId: state.turnId, action: 'complete', outcome: input.outcome === 'partial' ? 'partial' : 'failed', summary: input.reason, exitCode: 143, workspaceSnapshot, gitEvidence, workspaceEvidenceSource: 'recovery', idempotencyKey: `${input.idempotencyKey}:complete` },commit);
    if ((state.status.interactiveSession || finishedBeforeStop) && !state.status.interactiveSessionClosed) {
      state = await current();
      state = await this.store.publishRunCheckpoint(projectId, { executionLogId: input.executionLogId, generation: state.generation, proof: state.proof!, expectedRevision: state.revision, expectedTurnId: state.turnId, action: 'session-close', exitCode: 143, ...(state.status.nativeOutputPending ? { workspaceSnapshot, gitEvidence, workspaceEvidenceSource: 'recovery' as const } : {}), idempotencyKey: `${input.idempotencyKey}:close` },commit);
    }
    await new RunNativeObserver(this.store, this.workspaceCompute).forget(state);
    return state;
  }

  public interrupt(): void { this.interrupted = true; }
  public async close(): Promise<void> { this.interrupt(); await Promise.allSettled(this.pending.values()); }
}
