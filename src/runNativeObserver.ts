import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { UnifiedDataStore } from './db/unifiedDataStore';
import { assertCodexResumeTranscript, locateCodexSessionByBindingNonce } from './codexSessionIdentity';
import { snapshotWorkspace, captureRunGitEvidence, readWorkspaceGitHead, workspaceDocumentPurpose } from './runWorkspace';
import { normalizeTokenUsage, subtractUsage } from './tokenUsage';
import type { RunState } from './runLifecycleTypes';
import { assertClaudeTranscript, claudeTranscriptChunks, claudeTranscriptPaths } from './claudeSessionIdentity';
import type { FileHandle } from 'fs/promises';
import { claudeNativeEventPurpose, validateClaudeNativeEvent, ClaudeNativeEvent } from './claudeNativeEvent';
import { taskIngressReceiptFields } from './providerTaskIngress';

const observations = new WeakMap<UnifiedDataStore, Map<string, Promise<void>>>();
interface ClaudeLineage {
  generation: number;
  turnId: string;
  nativeTurnId: string;
  cursor: number;
  uuids: Set<string>;
}
const claudeLineages = new WeakMap<UnifiedDataStore, Map<string, ClaudeLineage>>();
interface NativeRowBuffer { offset: number; cursor: number; parts: Buffer[]; length: number }
const claudeFences = new WeakMap<UnifiedDataStore, Map<string, { generation: number; sequence: number; cursor: number; start: number; uuids: Set<string>; assistants: Set<string>; end: number; userFound: boolean; parse: NativeRowBuffer }>>();

function nativeTime(value: unknown): number {
  const numeric = Number(value);
  if (String(value ?? '').trim() && Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  return Date.parse(String(value || ''));
}

/** Observes official native events even while the plugin window is closed. */
export class RunNativeObserver {
  constructor(private readonly store: UnifiedDataStore) {}

  public forget(state: RunState): void {
    const cache = claudeLineages.get(this.store); const key = `${state.projectId}:${state.runId}`;
    if (cache?.get(key)?.generation === state.generation) cache.delete(key);
    const fences = claudeFences.get(this.store);
    if (fences?.get(key)?.generation === state.generation) fences.delete(key);
  }

  public async observe(observed: RunState, identityOnly = false, exitCode?: number): Promise<void> {
    let pending = observations.get(this.store);
    if (!pending) { pending = new Map(); observations.set(this.store, pending); }
    const key = `${observed.projectId}:${observed.runId}:${observed.generation}`;
    const work = (pending.get(key) || Promise.resolve()).catch(() => {}).then(() => {
      const current = this.store.readRunCheckpointState(observed.projectId, Number(observed.status.executionLogId));
      if (current.generation !== observed.generation) throw new Error('run_owner_conflict');
      return this.observeCurrent(current, identityOnly, exitCode);
    });
    pending.set(key, work);
    try { await work; }
    finally { if (pending.get(key) === work) pending.delete(key); }
  }

  private async observeCurrent(observed: RunState, identityOnly: boolean, exitCode?: number): Promise<void> {
    if (observed.status.interactiveSessionClosed) this.forget(observed);
    if (observed.status.interactiveSession && (!observed.status.interactiveSessionClosed || identityOnly) && observed.status.sessionProvider === 'claude') return this.observeClaude(observed, identityOnly, exitCode);
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
    const sourceOffset = Number(observed.status.codexNativeSourceOffset || 0);
    if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0) throw new Error('native_transcript_offset_invalid');
    const capturedSourceBytes = sourceOffset + logHead.totalBytes;
    if (stat.size < capturedSourceBytes) throw new Error('native_transcript_truncated');
    if (stat.size > capturedSourceBytes) {
      const source = fs.createReadStream(transcriptPath, { start: capturedSourceBytes, end: stat.size - 1 });
      for await (const value of source) {
        const state = current();
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
        this.store.appendRunLog(scope.projectId, { executionLogId, generation: state.generation, stream, sequence: logHead.nextSequence, offset: logHead.totalBytes, bytes: bytes.toString('base64'), idempotencyKey: `run:${state.runId}:${state.generation}:native-source:${logHead.totalBytes}` });
        logHead = this.store.readRunLogHead(scope.projectId, executionLogId, stream);
      }
    }
    let cursor = Number(current().status.codexNativeCursor || 0);
    const initialCursor = cursor;
    let lastStartedOffset = -1;
    const frames: Array<{ row: any; offset: number; nextCursor: number }> = [];
    for await (const frame of this.rows(scope.projectId, executionLogId, cursor, logHead.totalBytes)) {
      frames.push(frame);
      if (frame.row?.type === 'event_msg' && frame.row.payload?.type === 'task_started') lastStartedOffset = frame.offset;
    }
    let observation: Promise<{ workspaceSnapshot: Awaited<ReturnType<typeof snapshotWorkspace>>; gitEvidence: Awaited<ReturnType<typeof captureRunGitEvidence>>; observedAt: string }> | undefined;
    const observedWorkspace = () => observation ||= (async () => {
      const observedAt = new Date().toISOString();
      const workspaceSnapshot = await snapshotWorkspace(String(observed.status.workspaceRoot));
      const gitEvidence = await captureRunGitEvidence(String(observed.status.workspaceRoot), String(observed.status.baseGitHash || ''), workspaceSnapshot);
      return { workspaceSnapshot, gitEvidence, observedAt };
    })();
    for (const frame of frames) {
      if (frame.row) await this.observeRow(current, patch, frame.row, frame.offset, { lastStartedOffset, endOffset: frame.nextCursor, observedWorkspace });
      cursor = frame.nextCursor;
    }
    if (cursor !== initialCursor) patch({ codexNativeCursor: cursor }, `cursor:${cursor}`);
  }

  private async observeClaude(observed: RunState, identityOnly: boolean, exitCode?: number): Promise<void> {
    const executionLogId = Number(observed.status.executionLogId);
    const current = () => {
      const value = this.store.readRunCheckpointState(observed.projectId, executionLogId);
      if (value.generation !== observed.generation) throw new Error('run_owner_conflict');
      return value;
    };
    let binding = this.store.readRunBinding(observed.projectId, executionLogId);
    if (!binding) return;
    const head = binding.revisions[binding.headRevision - 1];
    if (!['planned', 'confirmed'].includes(head.state) || !head.sessionId) return;
    const context = [...binding.revisions].reverse().find(value => value.providerContext?.claude)?.providerContext;
    const claudeHome = String((context?.claude as Record<string, unknown> | undefined)?.claudeHome || '');
    if (!claudeHome) return;
    const files = head.evidence?.source === 'claude_native_transcript' && head.evidence.transcriptPath
      ? [String(head.evidence.transcriptPath)] : await claudeTranscriptPaths(claudeHome, binding.workspaceRoot, head.sessionId);
    const matches: Array<{ file: string; inode: string; sourceSize: number; stamp: string; handle: FileHandle }> = [];
    try {
      for (const file of files) {
        try {
          const value = await assertClaudeTranscript(file, claudeHome, binding.workspaceRoot, head.sessionId, String(observed.status.claudeNativeSourceStamp || ''));
          if (value) matches.push({ file, ...value });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (matches.length > 1) throw new Error('identity_ambiguous');
      if (!matches.length) return;
      const transcript = matches[0]; let state = current();
      if (state.status.interactiveSessionClosed && !identityOnly) return;
      if (head.state === 'planned') binding = this.store.writeRunBinding(state.projectId, { executionLogId, generation: state.generation, expectedHeadRevision: binding.headRevision,
        confirmSessionId: head.sessionId, evidence: { source: 'claude_native_transcript', transcriptPath: transcript.file, inode: transcript.inode },
        idempotencyKey: `run:${state.runId}:${state.generation}:claude-confirm:${binding.headRevision}` });
      state = current();
      const projection = { nativeSessionId: head.sessionId, nativeSessionIdIsCurrent: true, sessionBindingHeadRevision: binding.headRevision };
      if (Object.entries(projection).some(([key, value]) => state.status[key] !== value)) state = this.store.patchRunState(state.projectId, { executionLogId, generation: state.generation, expectedRevision: state.revision, patch: projection, idempotencyKey: `run:${state.runId}:${state.generation}:claude-projection:${state.revision}` });
      if (identityOnly) return;
      const stream = 'native:claude'; let logHead = this.store.readRunLogHead(state.projectId, executionLogId, stream);
      if (transcript.sourceSize < logHead.totalBytes) throw new Error('native_transcript_truncated');
      if (head.evidence?.source === 'claude_native_transcript' && head.evidence.inode !== transcript.inode) throw new Error('native_transcript_replaced');
      if (transcript.sourceSize > logHead.totalBytes) {
        const source = claudeTranscriptChunks(transcript.handle, logHead.totalBytes, transcript.sourceSize);
        for await (const chunk of source) {
          state = current(); if (state.status.interactiveSessionClosed) return;
          this.store.appendRunLog(state.projectId, { executionLogId, generation: state.generation, stream, sequence: logHead.nextSequence, offset: logHead.totalBytes, bytes: Buffer.from(chunk).toString('base64'), idempotencyKey: `run:${state.runId}:${state.generation}:claude-source:${logHead.totalBytes}` });
          logHead = this.store.readRunLogHead(state.projectId, executionLogId, stream);
        }
      }
      if (state.status.claudeNativeContract === 'mods-v1') await this.observeClaudeMachineRows(observed, head.sessionId, logHead.totalBytes);
      else await this.observeClaudeRows(observed, head.sessionId, logHead.totalBytes);
      state = current();
      if (Number(state.status.agentChildPid) > 0 && !this.store.runChildProcessAlive(state.projectId, executionLogId)
        && (exitCode !== undefined || !this.store.runProcessAlive(state.projectId, executionLogId))) {
        await this.observeClaudeExit(state, head.sessionId, logHead.totalBytes, exitCode ?? 1);
        state = current();
      }
      if (state.status.claudeNativeSourceStamp !== transcript.stamp || state.status.claudeNativeParseEnd !== logHead.totalBytes) this.store.patchRunState(state.projectId, { executionLogId, generation: state.generation, expectedRevision: state.revision, patch: { claudeNativeSourceStamp: transcript.stamp, claudeNativeParseEnd: logHead.totalBytes }, idempotencyKey: `run:${state.runId}:${state.generation}:claude-source-stamp:${state.revision}` });
    } finally { for (const match of matches) await match.handle.close(); }
  }

  private async observeClaudeExit(state: RunState, sessionId: string, end: number, exitCode: number): Promise<void> {
    if (this.store.readMetadata(state.turnId).data.finished_at !== null && state.status.nativeOutputPending !== true) return;
    const executionLogId = Number(state.status.executionLogId);
    const receipt = this.store.readRunDocument(state.projectId, executionLogId, `claude_exit_${state.generation}`);
    const saved = receipt ? JSON.parse(Buffer.from(receipt.bytes, 'base64').toString('utf8')) : null;
    if (saved && (saved.sessionId !== sessionId || saved.childPid !== state.status.agentChildPid || saved.childBirth !== state.status.processChildBirth
      || !Number.isSafeInteger(saved.logEnd) || saved.logEnd > end || !Number.isFinite(Date.parse(saved.completedAt)))) throw new Error('native_exit_conflict');
    const canonicalWorkspace = await fs.promises.realpath(String(state.status.workspaceRoot));
    const lineage = new Set<string>(); const assistants: string[] = [];
    let userUuid = ''; let start = 0; let boundary = 0; let apiError = false;
    const boundUser = state.status.claudeNativeBoundTurnId === state.turnId ? String(state.status.claudeNativeTurnId || '') : '';
    for await (const frame of this.rows(state.projectId, executionLogId, Number(state.status.claudeNativeStartOffset || 0), saved?.logEnd ?? end, 'native:claude')) {
      const row = frame.row;
      if (!row || row.sessionId !== sessionId || row.isSidechain === true || typeof row.cwd !== 'string'
        || ![path.resolve(String(state.status.workspaceRoot)), canonicalWorkspace].includes(path.resolve(row.cwd))) continue;
      if (!userUuid && row.type === 'user' && row.message?.role === 'user' && !row.isMeta && !row.isCompactSummary
        && (!boundUser ? nativeTime(row.timestamp) >= Date.parse(String(state.status.turnStartedAt || state.status.startedAt)) : row.uuid === boundUser)) {
        userUuid = row.uuid; start = frame.offset; boundary = frame.nextCursor; lineage.add(row.uuid);
      } else if (lineage.has(row.parentUuid) && (['assistant', 'progress', 'system', 'attachment'].includes(row.type)
        || row.type === 'user' && Array.isArray(row.message?.content) && row.message.content.some((block: any) => block?.type === 'tool_result'))) {
        lineage.add(row.uuid);
        if (row.type === 'assistant' && row.message?.role === 'assistant') { assistants.push(row.uuid); boundary = frame.nextCursor; apiError ||= row.isApiErrorMessage === true; }
      }
    }
    if (!userUuid) return;
    const current = this.store.readRunCheckpointState(state.projectId, executionLogId);
    if (current.generation !== state.generation) throw new Error('run_owner_conflict');
    if (current.turnId !== state.turnId) throw new Error('checkpoint_turn_conflict');
    const closure = { phase: 'complete' as const, userUuid, assistantUuids: assistants, startedAt: String(state.status.claudeNativeStartedAt || state.status.turnStartedAt || state.status.startedAt),
      completedAt: saved?.completedAt || new Date().toISOString(), reason: (saved?.exitCode ?? exitCode) === 0 && assistants.length && !apiError ? 'answer' as const : 'error' as const };
    if (!receipt) this.store.writeRunDocument(state.projectId, { executionLogId, generation: state.generation, turnId: state.turnId, purpose: `claude_exit_${state.generation}`,
      bytes: Buffer.from(JSON.stringify({ ...closure, sessionId, exitCode, childPid: state.status.agentChildPid, childBirth: state.status.processChildBirth, logEnd: end })).toString('base64'),
      mimeType: 'application/json', expectedRevision: 0, idempotencyKey: `run:${state.runId}:${state.generation}:claude-exit` });
    await this.observeClaudeRows(state, sessionId, boundary, closure, start);
  }

  private async observeClaudeMachineRows(observed: RunState, sessionId: string, end: number): Promise<void> {
    const executionLogId = Number(observed.status.executionLogId);
    const canonicalWorkspace = await fs.promises.realpath(String(observed.status.workspaceRoot));
    let fences = claudeFences.get(this.store);
    if (!fences) { fences = new Map(); claudeFences.set(this.store, fences); }
    const key = `${observed.projectId}:${observed.runId}`;
    for (;;) {
      const state = this.store.readRunCheckpointState(observed.projectId, executionLogId);
      if (state.generation !== observed.generation) throw new Error('run_owner_conflict');
      if (state.status.interactiveSessionClosed) return;
      const sequence = Number(state.status.claudeNativeEventCursor || 0) + 1;
      if (sequence > Number(state.status.claudeNativeEventHead || 0)) return;
      const document = this.store.readRunDocument(state.projectId, executionLogId, claudeNativeEventPurpose(state.generation, sequence));
      if (!document) throw new Error('native_event_missing');
      const event = validateClaudeNativeEvent(JSON.parse(Buffer.from(document.bytes, 'base64').toString('utf8')));
      if (event.sessionId !== sessionId) throw new Error('identity_provider_mismatch');
      const previous = fences.get(key);
      const offset = Number(state.status.claudeNativeStartOffset || 0);
      const fence = previous?.generation === state.generation && previous.sequence === sequence ? previous
        : { generation: state.generation, sequence, cursor: offset, start: 0, uuids: new Set<string>(), assistants: new Set<string>(), end: 0, userFound: false,
          parse: { offset, cursor: offset, parts: [], length: 0 } };
      for await (const frame of this.rows(state.projectId, executionLogId, fence.cursor, end, 'native:claude', fence.parse)) {
        const row = frame.row;
        const scoped = row && row.sessionId === sessionId && row.isSidechain !== true && typeof row.cwd === 'string'
          && [path.resolve(String(state.status.workspaceRoot)), canonicalWorkspace].includes(path.resolve(row.cwd));
        if (scoped && row.type === 'user' && row.uuid === event.userUuid && row.message?.role === 'user' && !row.isMeta && !row.isCompactSummary) {
          fence.userFound = true; fence.start = frame.offset; fence.uuids.add(row.uuid); fence.end = frame.nextCursor;
        } else if (scoped && fence.uuids.has(row.parentUuid) && (['assistant', 'progress', 'system', 'attachment'].includes(row.type)
          || row.type === 'user' && row.message?.role === 'user' && Array.isArray(row.message.content) && row.message.content.some((block: any) => block?.type === 'tool_result'))) {
          fence.uuids.add(row.uuid);
          if (row.type === 'assistant' && row.message?.role === 'assistant') fence.assistants.add(row.uuid);
          fence.end = frame.nextCursor;
        }
        fence.cursor = frame.nextCursor;
        if (fence.userFound && (event.phase === 'start' || event.assistantUuids.length && event.assistantUuids.every(id => fence.assistants.has(id)))) break;
      }
      fences.set(key, fence);
      if (!fence.userFound || !event.assistantUuids.every(id => fence.assistants.has(id))) return;
      await this.observeClaudeRows(state, sessionId, fence.end, event, fence.start);
      this.store.acknowledgeClaudeNativeEvent(state.projectId, { executionLogId, generation: state.generation, sequence });
      fences.delete(key);
    }
  }

  private async observeClaudeRows(observed: RunState, sessionId: string, end: number, machine?: Pick<ClaudeNativeEvent, 'phase' | 'userUuid' | 'assistantUuids' | 'startedAt' | 'completedAt' | 'reason'>, machineStart?: number): Promise<void> {
    const executionLogId = Number(observed.status.executionLogId);
    const current = () => {
      const state = this.store.readRunCheckpointState(observed.projectId, executionLogId);
      if (state.generation !== observed.generation) throw new Error('run_owner_conflict');
      return state;
    };
    const patch = (fields: Record<string, unknown>, event: string) => {
      const state = current();
      if (Object.entries(fields).every(([key, value]) => JSON.stringify(state.status[key]) === JSON.stringify(value))) return state;
      return this.store.patchRunState(state.projectId, { executionLogId, generation: state.generation, expectedRevision: state.revision,
        patch: fields, idempotencyKey: `run:${state.runId}:${state.generation}:claude-event:${event}:${state.revision}` });
    };
    const stream = 'native:claude'; let cursor = machineStart ?? Number(current().status.claudeNativeCursor || 0);
    if (cursor >= end || !machine && current().status.claudeNativeParseEnd === end) return;
    const workspaceRoot = String(observed.status.workspaceRoot);
    const canonicalWorkspace = await fs.promises.realpath(workspaceRoot);
    const scoped = (row: any) => row && row.sessionId === sessionId && row.isSidechain !== true && typeof row.cwd === 'string'
      && [path.resolve(workspaceRoot), canonicalWorkspace].includes(path.resolve(row.cwd));
    const request = (row: any): string => {
      if (!scoped(row) || row.type !== 'user' || row.isMeta || row.isCompactSummary || row.message?.role !== 'user' || machine && row.uuid !== machine.userUuid) return '';
      const content = row.message.content;
      return typeof content === 'string' ? content : Array.isArray(content) && !content.some((value: any) => value?.type === 'tool_result')
        ? content.filter((value: any) => value?.type === 'text').map((value: any) => String(value.text || '')).join('\n') : '';
    };
    const follows = (row: any, lineage: Set<string>) => scoped(row) && typeof row.uuid === 'string'
      && ['user', 'assistant', 'progress', 'system', 'attachment'].includes(row.type)
      && (!['user', 'assistant'].includes(row.type) || row.message?.role === row.type)
      && (lineage.has(row.uuid) || lineage.has(row.parentUuid));
    const initial = current();
    let cache = claudeLineages.get(this.store);
    if (!cache) { cache = new Map(); claudeLineages.set(this.store, cache); }
    const cacheKey = `${initial.projectId}:${initial.runId}`; const previous = cache.get(cacheKey);
    const nativeTurnId = initial.status.claudeNativeBoundTurnId === initial.turnId ? String(initial.status.claudeNativeTurnId || '') : '';
    const cached = previous?.generation === initial.generation && previous.turnId === initial.turnId && previous.nativeTurnId === nativeTurnId && previous.cursor === cursor;
    // This is a derived index; a cold owner or a changed checkpoint rebuilds it from the authoritative log.
    const lineage = new Set<string>(cached ? previous.uuids : nativeTurnId ? [nativeTurnId] : []);
    if (!cached) for await (const frame of this.rows(observed.projectId, executionLogId, Number(initial.status.claudeNativeStartOffset || 0), cursor, stream)) {
      if (follows(frame.row, lineage)) lineage.add(frame.row.uuid);
    }
    let lastStartedOffset = -1;
    const preview = new Set(lineage);
    for await (const frame of this.rows(observed.projectId, executionLogId, cursor, end, stream)) {
      const row = frame.row;
      if (request(row) && row.uuid && (machine || Number.isFinite(nativeTime(row.timestamp)) && nativeTime(row.timestamp) >= Date.parse(String(initial.status.claudeNativeStartedAt || initial.status.turnStartedAt || initial.status.startedAt)))) {
        lastStartedOffset = frame.offset; preview.clear(); preview.add(row.uuid);
      } else if (follows(row, preview)) {
        preview.add(row.uuid);
      }
    }
    let observation: Promise<{ workspaceSnapshot: Awaited<ReturnType<typeof snapshotWorkspace>>; gitEvidence: Awaited<ReturnType<typeof captureRunGitEvidence>>; observedAt: string }> | undefined;
    const observedWorkspace = () => observation ||= (async () => {
      const observedAt = new Date().toISOString(); const workspaceSnapshot = await snapshotWorkspace(workspaceRoot);
      return { workspaceSnapshot, gitEvidence: await captureRunGitEvidence(workspaceRoot, String(observed.status.baseGitHash || ''), workspaceSnapshot), observedAt };
    })();
    for await (const frame of this.rows(observed.projectId, executionLogId, cursor, end, stream)) {
      const row = frame.row; const time = nativeTime(row?.timestamp); const state = current();
      const text = request(row);
      if (text && typeof row.uuid === 'string' && (machine || Number.isFinite(time) && time >= Date.parse(String(state.status.claudeNativeStartedAt || state.status.turnStartedAt || state.status.startedAt)))) {
        const timestamp = machine?.startedAt || row.timestamp;
        await this.observeRow(current, patch, { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }, frame.offset);
        await this.observeRow(current, patch, { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: row.uuid, started_at: nativeTime(timestamp) } }, frame.offset);
        lineage.clear(); lineage.add(row.uuid);
      } else if (follows(row, lineage) && (machine || Number.isFinite(time) && time >= Date.parse(String(state.status.claudeNativeStartedAt || '')))) {
        // Auxiliary ancestors and tool results remain reachable without becoming user turns.
        lineage.add(row.uuid);
        if (machine ? machine.phase !== 'start' && frame.nextCursor === end : row.type === 'system' && row.subtype === 'turn_duration') {
          const state = current();
          const messages = new Map<string, ReturnType<typeof normalizeTokenUsage>>();
          const messageLineage = new Set([String(state.status.claudeNativeTurnId)]);
          const replyBlocks = new Map<string, { order: number; text: string }>();
          let replyMessageId = '';
          for await (const item of this.rows(observed.projectId, executionLogId, Number(state.status.claudeNativeStartOffset || 0), frame.nextCursor, stream)) {
            const value = item.row;
            if (!follows(value, messageLineage)) continue;
            messageLineage.add(value.uuid);
            if (value.type !== 'assistant' || !value.message?.id || value.isApiErrorMessage || value.isVirtual) continue;
            if (value.message.usage) {
              const usage = normalizeTokenUsage(value.message.usage); const previous = messages.get(value.message.id);
              if (!previous || usage.totalTokens >= previous.totalTokens) messages.set(value.message.id, usage);
            }
            {
              if (value.message.id !== replyMessageId) { replyBlocks.clear(); replyMessageId = value.message.id; }
              const indexed = Number.isInteger(value.apiBlockIndex) && value.apiBlockIndex >= 0;
              const key = indexed ? `block:${value.apiBlockIndex}` : value.uuid;
              const text = Array.isArray(value.message.content) ? value.message.content.filter((block: any) => block?.type === 'text').map((block: any) => String(block.text || '')).join('\n') : String(value.message.content || '');
              replyBlocks.set(key, { order: indexed ? value.apiBlockIndex : replyBlocks.get(key)?.order ?? replyBlocks.size, text });
            }
          }
          const usage = normalizeTokenUsage(null);
          for (const value of messages.values()) for (const key of Object.keys(usage) as Array<keyof typeof usage>) usage[key] += value[key];
          const baseline = normalizeTokenUsage(state.status.claudeNativeTokenBaseline as any);
          for (const key of Object.keys(usage) as Array<keyof typeof usage>) usage[key] += baseline[key];
          patch({ claudeNativeTokenTotal: usage }, `usage:${frame.offset}`);
          const reply = [...replyBlocks.values()].sort((a, b) => a.order - b.order).map(block => block.text).filter(Boolean).join('\n');
          await this.observeRow(current, patch, { type: 'event_msg', timestamp: machine?.completedAt || row.timestamp, payload: { type: machine && machine.reason !== 'answer' ? 'turn_aborted' : 'task_complete', turn_id: state.status.claudeNativeTurnId,
            ...(machine ? { reason: machine.reason } : {}), started_at: nativeTime(state.status.claudeNativeStartedAt), last_agent_message: reply } }, frame.offset,
            { stream, lastStartedOffset, endOffset: frame.nextCursor, observedWorkspace });
        }
      }
      cursor = frame.nextCursor; patch({ claudeNativeCursor: cursor }, `cursor:${cursor}`);
    }
    if (machine && machine.phase !== 'start' && !machine.assistantUuids.length) {
      const state = current();
      await this.observeRow(current, patch, { type: 'event_msg', timestamp: machine.completedAt,
        payload: { type: 'turn_aborted', turn_id: state.status.claudeNativeTurnId, started_at: nativeTime(machine.startedAt), reason: machine.reason, last_agent_message: '' } }, end,
        { stream, lastStartedOffset, endOffset: end, observedWorkspace });
    }
    const final = current();
    if (!final.status.interactiveSessionClosed && (!final.status.finishedAt || final.status.nativeOutputPending)
      && final.status.claudeNativeCursor === cursor && final.status.claudeNativeBoundTurnId === final.turnId
      && lineage.has(String(final.status.claudeNativeTurnId || ''))) {
      cache.set(cacheKey, { generation: final.generation, turnId: final.turnId, nativeTurnId: String(final.status.claudeNativeTurnId), cursor, uuids: lineage });
    } else this.forget(final);
  }

  private async *rows(projectId: string, executionLogId: number, cursor: number, end: number, stream = 'native:codex', partial?: NativeRowBuffer): AsyncGenerator<{ row: any; offset: number; nextCursor: number }> {
    let offset = partial?.offset ?? cursor; let parts: Buffer[] = partial?.parts || []; let length = partial?.length || 0;
    cursor = partial?.cursor ?? cursor;
    while (offset < end) {
      const page = this.store.readRunLog(projectId, { executionLogId, stream, offset, limit: Math.min(1_048_576, end - offset) });
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
      if (partial) Object.assign(partial, { offset, cursor, parts, length });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  private async observeRow(current: () => RunState, patch: (fields: Record<string, unknown>, event: string) => RunState, row: any, sourceOffset: number, source?: { stream?: 'native:codex' | 'native:claude'; lastStartedOffset: number; endOffset: number; observedWorkspace: () => Promise<{ workspaceSnapshot: Awaited<ReturnType<typeof snapshotWorkspace>>; gitEvidence: Awaited<ReturnType<typeof captureRunGitEvidence>>; observedAt: string }> }): Promise<void> {
    let state = current();
    const native = (suffix: string) => `${state.status.sessionProvider === 'claude' ? 'claude' : 'codex'}Native${suffix}`;
    if (state.status.interactiveSessionClosed) return;
    const executionLogId = Number(state.status.executionLogId);
    const identity = { executionLogId, generation: state.generation };
    const payload = row.payload;
    if (row.type === 'event_msg' && payload?.type === 'token_count' && payload.info?.total_token_usage) {
      patch({ [native('TokenTotal')]: normalizeTokenUsage(payload.info.total_token_usage) }, `tokens:${sourceOffset}`);
      return;
    }
    if (row.type === 'response_item' && payload?.type === 'message' && payload.role === 'user' && (this.store.readMetadata(state.turnId).data.finished_at !== null || state.status[native('AwaitingRequest')] === true)) {
      const text = (Array.isArray(payload.content) ? payload.content : []).filter((item: any) => item?.type === 'input_text').map((item: any) => String(item.text || '')).join('\n');
      if (text) {
        const purpose = `native_user_${sourceOffset}`;
        if (!this.store.readRunDocument(state.projectId, executionLogId, purpose)) this.store.writeRunDocument(state.projectId, { ...identity, ...(state.status[native('AwaitingRequest')] === true ? { turnId: state.turnId } : {}), purpose, bytes: Buffer.from(text).toString('base64'), mimeType: 'text/plain', expectedRevision: 0, idempotencyKey: `run:${state.runId}:${state.generation}:native-user:${sourceOffset}` });
        if (state.status[native('AwaitingRequest')] === true && state.status[native('BoundTurnId')] === state.turnId) {
          state = current();
          this.store.patchRunTurnRequest(state.projectId, { ...identity, expectedRevision: state.revision, turnId: state.turnId, message: text, idempotencyKey: `run:${state.runId}:${state.generation}:native-request:${sourceOffset}` });
          patch({ [native('AwaitingRequest')]: false }, `request:${sourceOffset}`);
        } else {
          const requestTimestamp = nativeTime(row.timestamp);
          patch({ [native('PendingRequest')]: purpose, [native('PendingRequestTimestamp')]: Number.isFinite(requestTimestamp) ? requestTimestamp : null }, `request:${sourceOffset}`);
        }
      }
      return;
    }
    if (row.type !== 'event_msg' || !['task_started', 'task_complete', 'turn_aborted'].includes(payload?.type)) return;
    const nativeTurnId = String(payload.turn_id || (payload.type === 'turn_aborted' ? state.status[native('TurnId')] || '' : ''));
    if (!nativeTurnId) return;
    const key = crypto.createHash('sha256').update(nativeTurnId).digest('hex');
    const eventTimestamp = nativeTime(payload.started_at || row.timestamp);
    if (!Number.isFinite(eventTimestamp)) return;
    if (payload.type === 'task_started') {
      const ingress = () => taskIngressReceiptFields(state.status, {
        provider: String(state.status.sessionProvider || ''),
        kind: state.status.sessionProvider === 'claude' ? 'claude_root_turn_start' : 'codex_task_started',
        nativeTurnId,
        sessionId: String(state.status.nativeSessionId || state.status.plannedNativeSessionId || ''),
        providerStartedAt: new Date(eventTimestamp).toISOString()
      });
      if (state.status[native('TurnId')] === nativeTurnId) {
        const receipt = ingress();
        if (Object.keys(receipt).length) patch(receipt, `ingress:${key}`);
        return;
      }
      const previousStart = state.status[native('BoundTurnId')] === state.turnId ? state.status[native('StartedAt')] : state.status.turnStartedAt;
      if (eventTimestamp < Date.parse(String(previousStart || state.status.startedAt))) return;
      let beforeRecorded = Boolean(this.store.readRunDocument(state.projectId, executionLogId, workspaceDocumentPurpose(state.turnId, 'before')));
      if (this.store.readMetadata(state.turnId).data.finished_at !== null && state.status.nativeOutputPending !== true) {
        const document = state.status[native('PendingRequest')] ? this.store.readRunDocument(state.projectId, executionLogId, String(state.status[native('PendingRequest')])) : null;
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
        patch({ [native('AwaitingRequest')]: !document }, `pending-request:${key}`);
      }
      patch({ [native('TurnId')]: nativeTurnId, [native('BoundTurnId')]: state.turnId, [native('StartedAt')]: new Date(eventTimestamp).toISOString(), [native('StartOffset')]: sourceOffset, [native('WorkspaceBeforeRecorded')]: beforeRecorded, turnStartedAt: new Date(eventTimestamp).toISOString(), [native('TokenBaseline')]: state.status[native('TokenTotal')] || normalizeTokenUsage(null), [native('PendingRequest')]: '', ...ingress() }, `start:${key}`);
      return;
    }
    const completedTimestamp = nativeTime(row.timestamp || payload.completed_at);
    if (!Number.isFinite(completedTimestamp) || completedTimestamp < eventTimestamp) return;
    if (payload.type === 'task_complete' && !state.status[native('TurnId')]
      && payload.started_at !== undefined && eventTimestamp >= Date.parse(String(state.status.turnStartedAt || state.status.startedAt))) {
      const turn = this.store.readMetadata(state.turnId);
      const initialTurnId = this.store.readRunState(state.projectId, executionLogId, 1).turnId;
      if (state.turnId === initialTurnId && (turn.data.finished_at === null || state.status.nativeOutputPending === true)) {
        // Some native transcripts report the first completion without a separate start event.
        state = patch({ [native('TurnId')]: nativeTurnId, [native('BoundTurnId')]: state.turnId,
          [native('StartedAt')]: new Date(eventTimestamp).toISOString(), [native('StartOffset')]: sourceOffset,
          [native('WorkspaceBeforeRecorded')]: Boolean(this.store.readRunDocument(state.projectId, executionLogId, workspaceDocumentPurpose(state.turnId, 'before'))),
          [native('TokenBaseline')]: normalizeTokenUsage(null),
          ...(state.status[native('PendingRequestTimestamp')] != null && Number(state.status[native('PendingRequestTimestamp')]) <= eventTimestamp
            ? { [native('PendingRequest')]: '', [native('PendingRequestTimestamp')]: null } : {}) }, `completion-start:${key}`);
      }
    }
    if (state.status[native('TurnId')] !== nativeTurnId || state.status[native('BoundTurnId')] !== state.turnId) return;
    if (eventTimestamp < Date.parse(String(state.status[native('StartedAt')] || state.status.turnStartedAt || state.status.startedAt))) return;
    if (this.store.readMetadata(state.turnId).data.finished_at !== null && state.status.nativeOutputPending !== true) return;
    const boundaryUnavailable = (source?.lastStartedOffset ?? -1) > sourceOffset || state.status[native('WorkspaceBeforeRecorded')] !== true;
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
    this.store.checkpointRun(state.projectId, { ...identity, proof: latest.proof!, expectedRevision: latest.revision, expectedTurnId: latest.turnId, action: 'complete', outcome: aborted ? 'failed' : 'partial', summary: aborted ? `本轮已中止：${String(payload.reason || 'interrupted')}` : String(payload.last_agent_message || '本轮回复已完成。'), workspaceSnapshot, gitEvidence, nativeWorkspaceObservation, ...(payload.last_agent_message !== undefined ? { nativeReply: String(payload.last_agent_message) } : {}), ...(source ? { nativeLogRange: { ...(source.stream ? { stream: source.stream } : {}), start: Number(state.status[native('StartOffset')]), end: source.endOffset } } : {}), gitAfterHash, nativeStartedAt: eventTimestamp, nativeCompletedAt: completedTimestamp, nativeTokenUsage: subtractUsage(normalizeTokenUsage(state.status[native('TokenTotal')] as any), normalizeTokenUsage(state.status[native('TokenBaseline')] as any)), workspaceEvidenceSource: 'native', idempotencyKey: `run:${state.runId}:${state.generation}:native-${aborted ? 'aborted' : 'complete'}:${key}` });
  }
}
