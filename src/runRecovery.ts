import { UnifiedDataStore } from './db/unifiedDataStore';
import { snapshotWorkspace, captureRunGitEvidence } from './runWorkspace';
import { RunNativeObserver } from './runNativeObserver';
import { RunStop } from './runStop';
import { RunInputMaterialization } from './runInputMaterialization';
import { captureMaintenanceRunResult } from './maintenanceRunResult';

export class RunRecovery {
  private recovery: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly terminalOwnerMissingSince = new Map<string, number>();
  constructor(
    private readonly store: UnifiedDataStore,
    private readonly stops = new RunStop(store),
    private readonly now = () => Date.now(),
    private readonly terminalOwnerGraceMs = 30_000
  ) {}

  public recover(): Promise<void> {
    if (!this.recovery) this.recovery = this.recoverPending().finally(() => { this.recovery = undefined; });
    return this.recovery;
  }
  private async recoverPending(): Promise<void> {
    const errors: unknown[] = [];
    try { await new RunInputMaterialization(this.store).recover(); }
    catch (error) { errors.push(error); }
    let cursor: number | null = 0;
    do {
      const page = this.store.recoverableRunStates(cursor);
      for (const observed of page.items) {
        if (this.stopped) return;
        try {
          const executionLogId = Number(observed.status.executionLogId);
          if (observed.status.stopRequested) {
            const intent = observed.status.stopRequestIntent as Record<string, unknown> | undefined;
            await this.stops.stop(observed.projectId, { ...(intent || (observed.status.stopRequireVerifiedIdentity ? { requireVerifiedIdentity: true } : {})), executionLogId, generation: observed.generation, expectedRevision: observed.revision, expectedTurnId: observed.turnId, reason: String(observed.status.stopReason), idempotencyKey: String(observed.status.stopRequestKey) });
            continue;
          }
          // An accepted launch stays queued until a window can deliver it. A
          // closed creator is not evidence that the Agent has already failed.
          if (observed.status.deliveryPending) continue;
          try { await new RunNativeObserver(this.store).observe(observed); }
          catch (error) {
            if (['run_owner_conflict', 'revision_conflict', 'checkpoint_turn_conflict', 'identity_index_conflict'].includes((error as Error).message)) continue;
            errors.push(error);
          }
          if (this.store.runProcessAlive(observed.projectId, executionLogId)) {
            const live = this.store.readRunCheckpointState(observed.projectId, executionLogId);
            const terminalKey = `${live.runId}:${live.generation}:${String(live.status.terminalDeliveryId || live.status.terminalName || '')}`;
            const terminalOwned = live.status.interactiveSession === true
              && live.status.interactiveSessionClosed !== true
              && !live.status.deliveryPending
              && Boolean(live.status.terminalName);
            if (!terminalOwned || this.store.runDeliveryOwnerAlive(live.projectId, executionLogId)) {
              this.terminalOwnerMissingSince.delete(terminalKey);
              continue;
            }
            const missingSince = this.terminalOwnerMissingSince.get(terminalKey);
            if (missingSince === undefined) {
              this.terminalOwnerMissingSince.set(terminalKey, this.now());
              continue;
            }
            if (this.now() - missingSince < this.terminalOwnerGraceMs) continue;
            await this.stops.stop(live.projectId, {
              executionLogId,
              generation: live.generation,
              expectedRevision: live.revision,
              expectedTurnId: live.turnId,
              reason: '承载当前对话的终端窗口已关闭。',
              requireVerifiedIdentity: true,
              idempotencyKey: `run:${live.runId}:${live.generation}:orphaned-terminal:${live.turnId}`
            });
            this.terminalOwnerMissingSince.delete(terminalKey);
            continue;
          }
          const before = this.store.readRunCheckpointState(observed.projectId, executionLogId);
          if (before.generation !== observed.generation) continue;
          let maintenanceCaptureError = '';
          try {
            await captureMaintenanceRunResult(this.store.root, before, async (operation, input) => operation === 'read_run_document'
              ? this.store.readRunDocument(before.projectId, executionLogId, String(input.purpose))
              : this.store.writeRunDocument(before.projectId, input as unknown as Parameters<UnifiedDataStore['writeRunDocument']>[1]));
          } catch (error) {
            maintenanceCaptureError = error instanceof Error ? error.message : String(error);
            const head = this.store.readRunLogHead(before.projectId, executionLogId, 'stderr');
            this.store.appendRunLog(before.projectId, { executionLogId, generation: before.generation, stream: 'stderr', sequence: head.nextSequence, offset: head.totalBytes,
              bytes: Buffer.from(`安装回执保存失败：${maintenanceCaptureError}\n`).toString('base64'), idempotencyKey: `run:${before.runId}:${before.generation}:recovery-maintenance-error` });
          }
          const workspaceSnapshot = before.status.finishedAt && !before.status.hostOutputPending && !before.status.nativeOutputPending ? undefined : await snapshotWorkspace(String(before.status.workspaceRoot));
          const gitEvidence = workspaceSnapshot ? await captureRunGitEvidence(String(before.status.workspaceRoot), String(before.status.baseGitHash || ''), workspaceSnapshot) : undefined;
          const state = this.store.readRunCheckpointState(observed.projectId, executionLogId);
          if (state.generation !== before.generation || state.turnId !== before.turnId || this.store.runProcessAlive(observed.projectId, executionLogId)) continue;
          if (state.status.hostOutputPending) {
            this.store.finalizeRunOutput(state.projectId, { executionLogId, generation: state.generation, proof: state.proof!, expectedRevision: state.revision, expectedTurnId: state.turnId, exitCode: 1, source: 'recovery', workspaceSnapshot, gitEvidence, idempotencyKey: `run:${state.runId}:${state.generation}:recover-output:${state.turnId}` });
            new RunNativeObserver(this.store).forget(state);
            continue;
          }
          this.store.checkpointRun(state.projectId, {
            executionLogId, generation: state.generation, proof: state.proof!, expectedRevision: state.revision, expectedTurnId: state.turnId,
            action: state.status.finishedAt ? 'session-close' : 'complete', ...(state.status.nativeOutputPending ? { exitCode: 1, workspaceSnapshot, gitEvidence, workspaceEvidenceSource: 'recovery' as const } : {}), ...(state.status.finishedAt ? {} : { outcome: 'failed', summary: maintenanceCaptureError || '执行已中断，完整已提交记录已保留，可重新继续。', exitCode: 1, workspaceSnapshot, gitEvidence, workspaceEvidenceSource: 'recovery' }),
            idempotencyKey: `run:${state.runId}:${state.generation}:recover:${state.revision}`
          });
          new RunNativeObserver(this.store).forget(state);
        } catch (error) { errors.push(error); }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      cursor = page.nextCursor;
    } while (cursor !== null && !this.stopped);
    if (errors.length) throw Object.assign(new Error(errors.map(error => error instanceof Error ? error.message : String(error)).join('; ')), { errors });
  }
  public start(): void {
    if (this.timer || this.stopped) return;
    const tick = () => { void this.recover().catch(error => process.stderr.write(`SoloMap run recovery: ${String(error)}\n`)); };
    this.timer = setInterval(tick, 5000); this.timer.unref(); tick();
  }
  public async close(): Promise<void> {
    this.stopped = true;
    this.stops.interrupt();
    if (this.timer) clearInterval(this.timer);
    await this.recovery;
    await this.stops.close();
  }
}
