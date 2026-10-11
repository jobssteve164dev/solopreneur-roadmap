import * as crypto from 'crypto';
import * as fs from 'fs';
import { UnifiedDataStore } from './db/unifiedDataStore';
import { assertCodexResumeTranscript, locateCodexSessionByBindingNonce } from './codexSessionIdentity';
import { snapshotWorkspace, captureRunGitEvidence, readWorkspaceGitHead, workspaceDocumentPurpose } from './runWorkspace';
import { normalizeTokenUsage, subtractUsage } from './tokenUsage';
import type { RunState } from './runLifecycleTypes';

function nativeTime(value: unknown): number {
  const numeric = Number(value);
  if (String(value ?? '').trim() && Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  return Date.parse(String(value || ''));
}

/** Observes official native events even while the plugin window is closed. */
export class RunNativeObserver {
  constructor(private readonly store: UnifiedDataStore) {}

  public async observe(observed: RunState, identityOnly = false): Promise<void> {
    if (!observed.status.interactiveSession || observed.status.interactiveSessionClosed && !identityOnly || observed.status.sessionProvider !== 'codex') return;
    const executionLogId = Number(observed.status.executionLogId);
    const scope = { projectId: observed.projectId, executionLogId };
    const current = () => {
      const state = this.store.readRunCheckpointState(scope.projectId, executionLogId);
      if (state.generation !== observed.generation) throw new Error('run_owner_conflict');
      return state;
    };
    const patch = (fields: Record<string, unknown>, event: string) => {
      const state = current();
      if (Object.entries(fields).every(([key, value]) => JSON.stringify(state.status[key]) === JSON.stringify(value))) return state;
      return this.store.patchRunState(scope.projectId, { executionLogId, generation: state.generation, expectedRevision: state.revision, patch: fields, idempotencyKey: `run:${state.runId}:${state.generation}:native:${event}:${state.revision}` });
    };
    let binding = this.store.readRunBinding(scope.projectId, executionLogId);
    if (!binding) return;
    let head = binding.revisions[binding.headRevision - 1];
    if (['preparing', 'planned'].includes(head.state) && head.contract === 'compatibility') {
      const context = head.providerContext?.codex as Record<string, unknown> | undefined;
      const located = await locateCodexSessionByBindingNonce({ codexHome: String(context?.codexHome || ''), workspaceRoot: String(observed.status.workspaceRoot), bindingNonce: binding.bindingNonce, startedAt: binding.createdAt });
      const state = current();
      if (state.status.interactiveSessionClosed && !identityOnly) return;
      if (located.status === 'not_found') return;
      const write = (fields: Record<string, unknown>, key: string) => this.store.writeRunBinding(scope.projectId, { executionLogId, generation: state.generation, expectedHeadRevision: binding!.headRevision, ...fields, idempotencyKey: `run:${state.runId}:${state.generation}:native-binding:${key}:${binding!.headRevision}` } as Parameters<UnifiedDataStore['writeRunBinding']>[1]);
      if (located.status === 'ambiguous' || (head.state === 'planned' && head.sessionId !== located.sessionId)) {
        write({ revision: { supersedesRevision: binding.headRevision, method: head.method, contract: head.contract, state: 'conflict', errorCode: located.status === 'ambiguous' ? 'identity_ambiguous' : 'identity_provider_mismatch', providerContext: head.providerContext, evidence: { source: 'codex_transcript_binding_nonce', candidateSessionIds: located.candidateSessionIds } } }, 'conflict');
        return;
      }
      const evidence = { source: 'codex_transcript_binding_nonce', transcriptPath: located.transcriptPath, providerCreatedAt: located.providerCreatedAt };
      if (head.state === 'preparing') binding = write({ revision: { sessionId: located.sessionId, method: head.method, contract: head.contract, state: 'planned', providerContext: head.providerContext, evidence } }, 'planned');
      binding = write({ confirmSessionId: located.sessionId, evidence }, 'confirmed');
      head = binding.revisions[binding.headRevision - 1];
    }
    if (identityOnly || head.state !== 'confirmed' || !head.sessionId) return;
    const transcriptPath = String(head.evidence?.transcriptPath || '');
    if (!transcriptPath) return;
    patch({ nativeSessionId: head.sessionId, nativeSessionIdIsCurrent: true, plannedNativeSessionId: head.sessionId, sessionBindingHeadRevision: binding.headRevision }, 'identity');
    const stream = 'native:codex';
    let logHead = this.store.readRunLogHead(scope.projectId, executionLogId, stream);
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(transcriptPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    await assertCodexResumeTranscript(transcriptPath, String(observed.status.workspaceRoot), head.sessionId);
    current();
    if (stat.size < logHead.totalBytes) throw new Error('native_transcript_truncated');
    if (stat.size > logHead.totalBytes) {
      const source = fs.createReadStream(transcriptPath, { start: logHead.totalBytes, end: stat.size - 1 });
      for await (const value of source) {
        const state = current();
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
        this.store.appendRunLog(scope.projectId, { executionLogId, generation: state.generation, stream, sequence: logHead.nextSequence, offset: logHead.totalBytes, bytes: bytes.toString('base64'), idempotencyKey: `run:${state.runId}:${state.generation}:native-source:${logHead.totalBytes}` });
        logHead = this.store.readRunLogHead(scope.projectId, executionLogId, stream);
      }
    }
    let cursor = Number(current().status.codexNativeCursor || 0);
    let lastStartedOffset = -1;
    for await (const frame of this.rows(scope.projectId, executionLogId, cursor, logHead.totalBytes)) {
      if (frame.row?.type === 'event_msg' && frame.row.payload?.type === 'task_started') lastStartedOffset = frame.offset;
    }
    let observation: Promise<{ workspaceSnapshot: Awaited<ReturnType<typeof snapshotWorkspace>>; gitEvidence: Awaited<ReturnType<typeof captureRunGitEvidence>>; observedAt: string }> | undefined;
    const observedWorkspace = () => observation ||= (async () => {
      const observedAt = new Date().toISOString();
      const workspaceSnapshot = await snapshotWorkspace(String(observed.status.workspaceRoot));
      const gitEvidence = await captureRunGitEvidence(String(observed.status.workspaceRoot), String(observed.status.baseGitHash || ''), workspaceSnapshot);
      return { workspaceSnapshot, gitEvidence, observedAt };
    })();
    for await (const frame of this.rows(scope.projectId, executionLogId, cursor, logHead.totalBytes)) {
      if (frame.row) await this.observeRow(current, patch, frame.row, frame.offset, { lastStartedOffset, endOffset: frame.nextCursor, observedWorkspace });
      cursor = frame.nextCursor;
      patch({ codexNativeCursor: cursor }, `cursor:${cursor}`);
    }
  }

  private async *rows(projectId: string, executionLogId: number, cursor: number, end: number): AsyncGenerator<{ row: any; offset: number; nextCursor: number }> {
    let offset = cursor; let parts: Buffer[] = []; let length = 0;
    while (offset < end) {
      const page = this.store.readRunLog(projectId, { executionLogId, stream: 'native:codex', offset, limit: Math.min(65536, end - offset) });
      const bytes = Buffer.from(page.bytes, 'base64');
      if (!bytes.length) throw new Error('native_source_read_incomplete');
      offset += bytes.length; let start = 0; let newline = bytes.indexOf(10);
      while (newline >= 0) {
        const segment = bytes.subarray(start, newline); parts.push(segment); length += segment.length;
        const line = Buffer.concat(parts, length).toString('utf8'); let row: any;
        try { row = JSON.parse(line); } catch {}
        const nextCursor = cursor + length + 1;
        yield { row, offset: cursor, nextCursor };
        cursor = nextCursor; parts = []; length = 0; start = newline + 1; newline = bytes.indexOf(10, start);
      }
      if (start < bytes.length) { const segment = bytes.subarray(start); parts.push(segment); length += segment.length; }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  private async observeRow(current: () => RunState, patch: (fields: Record<string, unknown>, event: string) => RunState, row: any, sourceOffset: number, source?: { lastStartedOffset: number; endOffset: number; observedWorkspace: () => Promise<{ workspaceSnapshot: Awaited<ReturnType<typeof snapshotWorkspace>>; gitEvidence: Awaited<ReturnType<typeof captureRunGitEvidence>>; observedAt: string }> }): Promise<void> {
    let state = current();
    if (state.status.interactiveSessionClosed) return;
    const executionLogId = Number(state.status.executionLogId);
    const identity = { executionLogId, generation: state.generation };
    const payload = row.payload;
    if (row.type === 'event_msg' && payload?.type === 'token_count' && payload.info?.total_token_usage) {
      patch({ codexNativeTokenTotal: normalizeTokenUsage(payload.info.total_token_usage) }, `tokens:${sourceOffset}`);
      return;
    }
    if (row.type === 'response_item' && payload?.type === 'message' && payload.role === 'user' && (this.store.readMetadata(state.turnId).data.finished_at !== null || state.status.codexNativeAwaitingRequest === true)) {
      const text = (Array.isArray(payload.content) ? payload.content : []).filter((item: any) => item?.type === 'input_text').map((item: any) => String(item.text || '')).join('\n');
      if (text) {
        const purpose = `native_user_${sourceOffset}`;
        if (!this.store.readRunDocument(state.projectId, executionLogId, purpose)) this.store.writeRunDocument(state.projectId, { ...identity, ...(state.status.codexNativeAwaitingRequest === true ? { turnId: state.turnId } : {}), purpose, bytes: Buffer.from(text).toString('base64'), mimeType: 'text/plain', expectedRevision: 0, idempotencyKey: `run:${state.runId}:${state.generation}:native-user:${sourceOffset}` });
        if (state.status.codexNativeAwaitingRequest === true && state.status.codexNativeBoundTurnId === state.turnId) {
          state = current();
          this.store.patchRunTurnRequest(state.projectId, { ...identity, expectedRevision: state.revision, turnId: state.turnId, message: text, idempotencyKey: `run:${state.runId}:${state.generation}:native-request:${sourceOffset}` });
          patch({ codexNativeAwaitingRequest: false }, `request:${sourceOffset}`);
        } else {
          const requestTimestamp = nativeTime(row.timestamp);
          patch({ codexNativePendingRequest: purpose, codexNativePendingRequestTimestamp: Number.isFinite(requestTimestamp) ? requestTimestamp : null }, `request:${sourceOffset}`);
        }
      }
      return;
    }
    if (row.type !== 'event_msg' || !['task_started', 'task_complete', 'turn_aborted'].includes(payload?.type)) return;
    const nativeTurnId = String(payload.turn_id || (payload.type === 'turn_aborted' ? state.status.codexNativeTurnId || '' : ''));
    if (!nativeTurnId) return;
    const key = crypto.createHash('sha256').update(nativeTurnId).digest('hex');
    const eventTimestamp = nativeTime(payload.started_at || row.timestamp);
    if (!Number.isFinite(eventTimestamp)) return;
    if (payload.type === 'task_started') {
      if (state.status.codexNativeTurnId === nativeTurnId) return;
      const previousStart = state.status.codexNativeBoundTurnId === state.turnId ? state.status.codexNativeStartedAt : state.status.turnStartedAt;
      if (eventTimestamp < Date.parse(String(previousStart || state.status.startedAt))) return;
      let beforeRecorded = Boolean(this.store.readRunDocument(state.projectId, executionLogId, workspaceDocumentPurpose(state.turnId, 'before')));
      if (this.store.readMetadata(state.turnId).data.finished_at !== null && state.status.nativeOutputPending !== true) {
        const document = state.status.codexNativePendingRequest ? this.store.readRunDocument(state.projectId, executionLogId, String(state.status.codexNativePendingRequest)) : null;
        const message = document ? Buffer.from(document.bytes, 'base64').toString('utf8') : '等待本轮用户消息';
        // A delayed event cannot supply a new historical 'before' from today's files.
        const sealed = this.store.readRunDocument(state.projectId, executionLogId, workspaceDocumentPurpose(state.turnId, 'after'));
        const priorObservation = !sealed && state.status.nativeWorkspaceObservationObjectId
          ? this.store.readRunDocument(state.projectId, executionLogId, `native_workspace_observation_${state.turnId.replace(/-/g, '')}`, Number(state.status.nativeWorkspaceObservationRevision)) : null;
        const observedBefore = priorObservation ? JSON.parse(Buffer.from(priorObservation.bytes, 'base64').toString('utf8')) : null;
        const observedAt = sealed ? String(state.status.workspaceObservedAt || '') : String(observedBefore?.observedAt || '');
        beforeRecorded = Boolean((sealed || observedBefore) && eventTimestamp >= Date.parse(observedAt));
        const workspaceSnapshot = beforeRecorded ? sealed ? JSON.parse(Buffer.from(sealed.bytes, 'base64').toString('utf8')) : observedBefore.workspaceSnapshot : undefined;
        const gitBaseline = String(state.status.workspaceAfterGitHash || state.status.baseGitHash || '');
        const latest = current();
        if (latest.turnId !== state.turnId) throw new Error('checkpoint_turn_conflict');
        state = this.store.checkpointRun(state.projectId, { ...identity, proof: latest.proof!, expectedRevision: latest.revision, expectedTurnId: latest.turnId, action: 'start', message, workspaceSnapshot, gitBaseline, nativeStartedAt: eventTimestamp, workspaceEvidenceSource: 'native', idempotencyKey: `run:${state.runId}:${state.generation}:native-start:${key}` });
        if (document) this.store.link({ source: document.objectId, relation: 'source', target: state.turnId, expectedRevision: document.revision, idempotencyKey: `run:${state.runId}:${state.generation}:native-request-source:${key}` });
        patch({ codexNativeAwaitingRequest: !document }, `pending-request:${key}`);
      }
      patch({ codexNativeTurnId: nativeTurnId, codexNativeBoundTurnId: state.turnId, codexNativeStartedAt: new Date(eventTimestamp).toISOString(), codexNativeStartOffset: sourceOffset, codexNativeWorkspaceBeforeRecorded: beforeRecorded, turnStartedAt: new Date(eventTimestamp).toISOString(), codexNativeTokenBaseline: state.status.codexNativeTokenTotal || normalizeTokenUsage(null), codexNativePendingRequest: '' }, `start:${key}`);
      return;
    }
    const completedTimestamp = nativeTime(row.timestamp || payload.completed_at);
    if (!Number.isFinite(completedTimestamp) || completedTimestamp < eventTimestamp) return;
    if (payload.type === 'task_complete' && !state.status.codexNativeTurnId
      && payload.started_at !== undefined && eventTimestamp >= Date.parse(String(state.status.turnStartedAt || state.status.startedAt))) {
      const turn = this.store.readMetadata(state.turnId);
      const initialTurnId = this.store.readRunState(state.projectId, executionLogId, 1).turnId;
      if (state.turnId === initialTurnId && (turn.data.finished_at === null || state.status.nativeOutputPending === true)) {
        // Some native transcripts report the first completion without a separate start event.
        state = patch({ codexNativeTurnId: nativeTurnId, codexNativeBoundTurnId: state.turnId,
          codexNativeStartedAt: new Date(eventTimestamp).toISOString(), codexNativeStartOffset: sourceOffset,
          codexNativeWorkspaceBeforeRecorded: Boolean(this.store.readRunDocument(state.projectId, executionLogId, workspaceDocumentPurpose(state.turnId, 'before'))),
          codexNativeTokenBaseline: normalizeTokenUsage(null),
          ...(state.status.codexNativePendingRequestTimestamp != null && Number(state.status.codexNativePendingRequestTimestamp) <= eventTimestamp
            ? { codexNativePendingRequest: '', codexNativePendingRequestTimestamp: null } : {}) }, `completion-start:${key}`);
      }
    }
    if (state.status.codexNativeTurnId !== nativeTurnId || state.status.codexNativeBoundTurnId !== state.turnId) return;
    if (eventTimestamp < Date.parse(String(state.status.codexNativeStartedAt || state.status.turnStartedAt || state.status.startedAt))) return;
    if (this.store.readMetadata(state.turnId).data.finished_at !== null && state.status.nativeOutputPending !== true) return;
    const boundaryUnavailable = (source?.lastStartedOffset ?? -1) > sourceOffset || state.status.codexNativeWorkspaceBeforeRecorded !== true;
    const nativeWorkspaceObservation = boundaryUnavailable ? source ? await source.observedWorkspace() : await (async () => {
      const observedAt = new Date().toISOString(); const workspaceSnapshot = await snapshotWorkspace(String(state.status.workspaceRoot));
      return { observedAt, workspaceSnapshot, gitEvidence: await captureRunGitEvidence(String(state.status.workspaceRoot), String(state.status.baseGitHash || ''), workspaceSnapshot) };
    })() : undefined;
    const workspaceSnapshot = boundaryUnavailable ? undefined : await snapshotWorkspace(String(state.status.workspaceRoot));
    const gitEvidence = workspaceSnapshot ? await captureRunGitEvidence(String(state.status.workspaceRoot), String(state.status.baseGitHash || ''), workspaceSnapshot) : undefined;
    const gitAfterHash = await readWorkspaceGitHead(String(state.status.workspaceRoot));
    const latest = current();
    if (latest.turnId !== state.turnId) throw new Error('checkpoint_turn_conflict');
    const aborted = payload.type === 'turn_aborted';
    this.store.checkpointRun(state.projectId, { ...identity, proof: latest.proof!, expectedRevision: latest.revision, expectedTurnId: latest.turnId, action: 'complete', outcome: aborted ? 'failed' : 'partial', summary: aborted ? `本轮已中止：${String(payload.reason || 'interrupted')}` : String(payload.last_agent_message || '本轮回复已完成。'), workspaceSnapshot, gitEvidence, nativeWorkspaceObservation, ...(payload.last_agent_message !== undefined ? { nativeReply: String(payload.last_agent_message) } : {}), ...(source ? { nativeLogRange: { start: Number(state.status.codexNativeStartOffset), end: source.endOffset } } : {}), gitAfterHash, nativeStartedAt: eventTimestamp, nativeCompletedAt: completedTimestamp, nativeTokenUsage: subtractUsage(normalizeTokenUsage(state.status.codexNativeTokenTotal as any), normalizeTokenUsage(state.status.codexNativeTokenBaseline as any)), workspaceEvidenceSource: 'native', idempotencyKey: `run:${state.runId}:${state.generation}:native-${aborted ? 'aborted' : 'complete'}:${key}` });
  }
}
