import * as crypto from 'crypto';
import * as path from 'path';
import type { ContentPage, DataObject, UnifiedDataStore } from './db/unifiedDataStore';
import type { RunCheckpointInput, RunState, RunConsumerLease, RunSettlementInput } from './runLifecycleTypes';
import { workspaceDocumentPurpose, gitEvidenceDocumentPurpose, RunGitEvidence } from './runWorkspace';
import { getResumableSessionValue, NativeSessionBinding, ResumableSessionBinding } from './sessionIdentity';

type Operation = (operation: string, input: Record<string, unknown>) => Promise<unknown>;
const runSnapshot = Symbol('runStatusSnapshot');
type StatusSnapshot = Record<string, any> & { [runSnapshot]?: { reference: string; state: RunState; original: Record<string, unknown> } };

export interface ConversationLogSnapshot {
  runId: string;
  turnId: string;
  revision: number;
  nodeId: string;
  stdout: Buffer;
  stderr: Buffer;
}

export async function readConversationLogSnapshot(
  client: RunLifecycleClient,
  root: string,
  executionLogId: number,
  expected?: { runId?: string; turnId?: string; revision?: number; nodeId?: string }
): Promise<ConversationLogSnapshot> {
  const source = await client.findConversationTurn(root, executionLogId);
  if (!source) throw new Error('run_conversation_missing');
  if (expected?.runId && expected.runId !== source.runId) throw new Error('run_log_source_changed');
  if (expected?.turnId && expected.turnId !== source.turnId) throw new Error('run_log_source_changed');
  if (expected?.revision !== undefined && expected.revision !== source.revision) throw new Error('run_log_source_changed');
  const sourceNodeId = String(source.status.nodeId || '');
  if (expected?.nodeId && expected.nodeId !== sourceNodeId
    && !await client.hasConversationLink(root, executionLogId, expected.nodeId, sourceNodeId)) throw new Error('run_conversation_node_mismatch');
  let [stdout, stderr] = await Promise.all([
    client.readLog(source.reference, 'stdout', source.status),
    client.readLog(source.reference, 'stderr', source.status)
  ]);
  if (!stdout.length && !stderr.length) stdout = await client.readLog(source.reference, 'output', source.status);
  return { runId: source.runId, turnId: source.turnId, revision: source.revision, nodeId: sourceNodeId, stdout, stderr };
}

export function runStatusReference(root: string, executionLogId: number): string {
  if (!root || !Number.isInteger(executionLogId) || executionLogId < 1) throw new Error('run_reference_required');
  return `solomap://run-state/${executionLogId}?root=${encodeURIComponent(path.resolve(root))}`;
}

export function parseRunStatusReference(reference: string): { root: string; executionLogId: number } {
  const value = new URL(reference);
  const root = value.searchParams.get('root') || '';
  const executionLogId = Number(value.pathname.slice(1));
  if (value.protocol !== 'solomap:' || value.hostname !== 'run-state' || reference !== runStatusReference(root, executionLogId)) throw new Error('invalid_run_reference');
  return { root, executionLogId };
}

export function runDataReference(reference: string, field: string): string {
  parseRunStatusReference(reference);
  if (!/^[a-z][a-z0-9-]*$/.test(field)) throw new Error('invalid_run_field');
  const value = new URL(reference); value.pathname += `/${field}`;
  return value.toString();
}

export function parseRunDataReference(reference: string): { reference: string; field: string } {
  const value = new URL(reference);
  const parts = value.pathname.split('/');
  if (parts.length !== 3) throw new Error('invalid_run_data_reference');
  const field = parts.pop()!;
  value.pathname = parts.join('/');
  const statusReference = value.toString();
  if (runDataReference(statusReference, field) !== reference) throw new Error('invalid_run_data_reference');
  return { reference: statusReference, field };
}

/** Plugin consumers use the same owner operations as the packaged Agent. */
export class RunLifecycleClient {
  constructor(private readonly operation: Operation, public readonly dataRoot?: string) {}

  public async recordVerification(root: string, executionLogId: number, input: { claim: string; result: 'pass' | 'fail'; evidence: string; idempotencyKey: string }): Promise<{ objectId: string; revision: number }> {
    return this.operation('record_run_verification', { root, executionLogId, ...input }) as Promise<{ objectId: string; revision: number }>;
  }

  public async hasConversationLink(root: string, executionLogId: number, nodeId: string, sourceNodeId: string): Promise<boolean> {
    const page = await this.operation('read_project_journal', { root, executionLogId, nodeId, limit: 1 }) as { logs?: Array<{ dataState?: { linkedFromNodeId?: string } }> };
    return page.logs?.[0]?.dataState?.linkedFromNodeId === sourceNodeId;
  }

  private status(reference: string, state: RunState): StatusSnapshot {
    const status: StatusSnapshot = { ...state.status, turnId: state.turnId, executionLogId: state.status.journalExecutionLogId || state.status.executionLogId };
    for (const [key, field] of Object.entries({ outputFilePath: 'output', changesFilePath: 'changes', touchedFilesPath: 'changes', commandFilePath: 'command', promptFilePath: 'prompt', sessionFilePath: 'session', completionDecisionFilePath: 'decision', workspaceSnapshotPath: 'workspace', codexHomeFilePath: 'codex-home', agentProcessPidFilePath: 'process' })) status[key] = runDataReference(reference, field);
    status[runSnapshot] = { reference, state, original: JSON.parse(JSON.stringify(status)) };
    return status;
  }

  public async readStatus(reference: string, revision?: number): Promise<StatusSnapshot | null> {
    const identity = parseRunStatusReference(reference);
    try { return this.status(reference, await this.operation('read_run_state', { ...identity, ...(revision !== undefined ? { revision } : {}) }) as RunState); }
    catch (error) { if ((error as Error).message === 'run_missing') return null; throw error; }
  }

  public async findConversation(root: string, executionLogId: number): Promise<{ reference: string; status: StatusSnapshot; turnId: string; runId: string; generation: number; revision: number } | null> {
    const result = await this.operation('resolve_run_conversation', { root, executionLogId }) as { state: RunState; turnId: string } | null;
    if (!result) return null;
    const reference = runStatusReference(root, Number(result.state.status.rootExecutionLogId));
    return { reference, status: this.status(reference, result.state), turnId: result.turnId, runId: result.state.runId, generation: result.state.generation, revision: result.state.revision };
  }

  public async findConversationTurn(root: string, executionLogId: number): ReturnType<RunLifecycleClient['findConversation']> {
    const result = await this.operation('resolve_run_conversation_turn', { root, executionLogId }) as { state: RunState; turnId: string } | null;
    if (!result) return null;
    const reference = runStatusReference(root, Number(result.state.status.rootExecutionLogId));
    return { reference, status: this.status(reference, result.state), turnId: result.turnId, runId: result.state.runId, generation: result.state.generation, revision: result.state.revision };
  }

  public async listConversationStatuses(root: string, executionLogId: number) {
    const { items } = await this.operation('list_conversation_run_states', { root, executionLogId }) as { items: RunState[] };
    return items.map(state => {
      const reference = runStatusReference(root, Number(state.status.rootExecutionLogId));
      return { reference, status: this.status(reference, state), turnId: state.turnId, runId: state.runId, generation: state.generation, revision: state.revision };
    });
  }

  public async adoptConversationHistory(root: string, executionLogId: number): ReturnType<RunLifecycleClient['findConversation']> {
    const existing = await this.findConversation(root, executionLogId);
    if (existing) return existing;
    const projectRoot = path.resolve(root);
    const job = await this.operation('import_project_data', {
      collection: 'agent-runs', sourceRoot: path.join(projectRoot, '.solopreneur', 'agent-runs'), projectRoot,
      idempotencyKey: `conversation-history-adoption-v3:${projectRoot}`, refreshCompleted: true, archiveUnresolved: true
    }) as { jobId: string; status: string };
    if (['failed', 'interrupted', 'completed_with_conflicts'].includes(job.status)) {
      try { await this.operation('retry_migration', { jobId: job.jobId }); }
      catch (error) { if ((error as Error).message !== 'migration_not_retryable') throw error; }
    }
    for (;;) {
      const current = await this.operation('migration_status', { jobId: job.jobId, metadataOnly: true }) as { status: string; error: string | null };
      if (!['queued', 'running'].includes(current.status)) {
        const adopted = await this.findConversation(root, executionLogId);
        if (adopted) return adopted;
        if (current.error) throw new Error(current.error);
        return null;
      }
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  }

  private async selectedState(reference: string, status?: StatusSnapshot): Promise<RunState> {
    if (status) {
      const snapshot = status[runSnapshot];
      if (!snapshot || snapshot.reference !== reference) throw new Error('run_status_snapshot_required');
      return snapshot.state;
    }
    return this.operation('read_run_state', parseRunStatusReference(reference)) as Promise<RunState>;
  }

  private async readContent(ref: string, revision: number, field: string): Promise<Buffer> {
    const buffers: Buffer[] = []; let cursor: string | null = null;
    do {
      const page = await this.operation('read', { ref, revision, field, view: 'content', limit: 65536, ...(cursor ? { cursor } : {}) }) as ContentPage;
      buffers.push(Buffer.from(page.data, 'base64')); cursor = page.cursor;
    } while (cursor !== null);
    return Buffer.concat(buffers);
  }

  public async readReport(reference: string, status?: StatusSnapshot): Promise<{ objectId: string; revision: number; availability: string; validationError: string; report: unknown } | null> {
    const state = await this.selectedState(reference, status);
    const objectId = String(state.status.taskReportObjectId || '');
    if (!objectId) return null;
    const revision = Number(state.status.taskReportRevision || 0);
    if (!Number.isInteger(revision) || revision < 1) throw new Error('run_report_snapshot_required');
    const object = await this.operation('read', { ref: objectId, revision, view: 'metadata' }) as DataObject;
    if (object.kind !== 'report' || object.projectId !== state.projectId || object.data.run_id !== state.runId || object.data.turn_id !== state.turnId) throw new Error('run_report_mismatch');
    return { objectId, revision: object.revision, availability: String(object.data.availability), validationError: String(object.data.validation_error || ''), report: JSON.parse((await this.readContent(objectId, object.revision, 'content')).toString('utf8')) };
  }

  public async readGitEvidence(reference: string, status?: StatusSnapshot): Promise<RunGitEvidence | null> {
    const state = await this.selectedState(reference, status);
    if (!state.status.gitEvidenceObjectId || !state.status.gitEvidenceRevision) return null;
    const identity = { projectId: state.projectId, executionLogId: parseRunStatusReference(reference).executionLogId };
    const document = await this.operation('read_run_document', { ...identity, purpose: gitEvidenceDocumentPurpose(state.turnId), revision: state.status.gitEvidenceRevision }) as { objectId: string; bytes: string } | null;
    if (!document || document.objectId !== state.status.gitEvidenceObjectId) throw new Error('run_git_evidence_mismatch');
    return JSON.parse(Buffer.from(document.bytes, 'base64').toString('utf8')) as RunGitEvidence;
  }

  public async readReviewEvidence(reference: string, status?: StatusSnapshot): Promise<{ result: unknown; manifest: Record<string, any> } | null> {
    const state = await this.selectedState(reference, status);
    if (!state.status.reviewResultObjectId || !state.status.reviewResultRevision) return null;
    const identity = { projectId: state.projectId, executionLogId: parseRunStatusReference(reference).executionLogId };
    const result = await this.operation('read_run_document', { ...identity, purpose: 'review_result', revision: state.status.reviewResultRevision }) as { objectId: string; bytes: string } | null;
    if (!result || result.objectId !== state.status.reviewResultObjectId) throw new Error('run_review_evidence_mismatch');
    const request = await this.operation('read_run_document', { ...identity, purpose: 'launch_request', revision: 1 }) as { bytes: string } | null;
    if (!request) throw new Error('run_launch_request_missing');
    const launch = JSON.parse(Buffer.from(request.bytes, 'base64').toString('utf8'));
    let manifest = launch.reviewEvidence || {};
    if (manifest.version === 2) {
      const source = await this.operation('read_run_state', { projectId: state.projectId, executionLogId: manifest.sourceRootExecutionLogId, revision: manifest.sourceRevision }) as RunState;
      if (source.runId !== manifest.sourceRunId || source.turnId !== manifest.sourceTurnId || source.projectId !== state.projectId) throw new Error('run_review_source_mismatch');
      const sourceReference = runStatusReference(String(source.status.workspaceRoot), Number(manifest.sourceRootExecutionLogId));
      const sourceStatus = this.status(sourceReference, source);
      const gitEvidence = await this.readGitEvidence(sourceReference, sourceStatus);
      const mainOutput = (await this.readLog(sourceReference, 'output', sourceStatus)).toString('utf8');
      if (crypto.createHash('sha256').update(mainOutput).digest('hex') !== manifest.mainOutputSha256 || crypto.createHash('sha256').update(gitEvidence?.patch || '').digest('hex') !== manifest.patchSha256) throw new Error('run_review_source_content_mismatch');
      manifest = { ...manifest, mainOutput, patch: gitEvidence?.patch || '', files: gitEvidence?.files || {} };
    }
    return { result: JSON.parse(Buffer.from(result.bytes, 'base64').toString('utf8')), manifest };
  }

  public async readData(dataReference: string, status?: StatusSnapshot): Promise<Buffer> {
    const { reference, field } = parseRunDataReference(dataReference);
    const state = await this.selectedState(reference, status);
    if (['output', 'stdout', 'stderr'].includes(field)) return this.readLog(reference, field, status);
    if (['prompt', 'command', 'changes', 'workspace'].includes(field)) return Buffer.from(await this.readField(reference, field as 'prompt' | 'command' | 'changes' | 'workspace', status));
    if (field === 'decision') return Buffer.from(JSON.stringify(state.status.userConfirmedCompletion === true
      ? { markCompleted: true, reason: '用户确认完成。', outcome: 'candidate_complete', source: 'user' }
      : { markCompleted: state.status.checkpointOutcome === 'candidate_complete', reason: String(state.status.checkpointSummary || ''), outcome: String(state.status.checkpointOutcome || '') }));
    if (field === 'process') return Buffer.from(`${Number(state.status.agentChildPid || state.status.agentPid || 0)}\n${String(state.status.processChildBirth || state.status.processBirth || '')}\n`);
    if (field === 'report') { const report = await this.readReport(reference, status); return report ? Buffer.from(JSON.stringify(report.report)) : Buffer.alloc(0); }
    if (field === 'session') { const binding = await this.readBinding(reference, status); return binding ? Buffer.from(JSON.stringify(binding)) : Buffer.alloc(0); }
    if (field === 'codex-home') {
      const binding = await this.readBinding(reference, status);
      const context = binding?.revisions[binding.headRevision - 1]?.providerContext?.codex as Record<string, unknown> | undefined;
      return Buffer.from(String(context?.codexHome || ''));
    }
    if (field === 'roadmap-backup') {
      if (!state.status.roadmapBackupObjectId || !state.status.roadmapBackupRevision) return Buffer.alloc(0);
      const document = await this.operation('read_run_document', { projectId: state.projectId, executionLogId: parseRunStatusReference(reference).executionLogId, purpose: 'roadmap_backup', revision: state.status.roadmapBackupRevision }) as { objectId: string; bytes: string } | null;
      if (!document || document.objectId !== state.status.roadmapBackupObjectId) throw new Error('run_roadmap_backup_mismatch');
      return Buffer.from(document.bytes, 'base64');
    }
    throw new Error('unsupported_run_field');
  }

  public async readBinding(reference: string, status?: StatusSnapshot): Promise<NativeSessionBinding | null> {
    const identity = parseRunStatusReference(reference);
    const state = await this.selectedState(reference, status);
    return this.operation('read_run_binding', { projectId: state.projectId, executionLogId: identity.executionLogId, revision: state.revision }) as Promise<NativeSessionBinding | null>;
  }

  public async getResumableSession(reference: string): Promise<ResumableSessionBinding | null> {
    return getResumableSessionValue(await this.readBinding(reference));
  }

  public async recoverNativeIdentity(reference: string, status: StatusSnapshot): Promise<void> {
    const state = await this.selectedState(reference, status);
    if (state.status.historicalTurnProjection) throw new Error('historical_turn_read_only');
    await this.operation('recover_run_executions', { ...parseRunStatusReference(reference), generation: state.generation, identityOnly: true });
  }

  public async writeBinding(reference: string, status: StatusSnapshot, input: Omit<Parameters<UnifiedDataStore['writeRunBinding']>[1], 'executionLogId' | 'generation'>): Promise<NativeSessionBinding> {
    const snapshot = status[runSnapshot];
    if (!snapshot || snapshot.reference !== reference) throw new Error('run_status_snapshot_required');
    if (snapshot.state.status.historicalTurnProjection) throw new Error('historical_turn_read_only');
    return this.operation('write_run_binding', { ...input, projectId: snapshot.state.projectId, executionLogId: parseRunStatusReference(reference).executionLogId, generation: snapshot.state.generation }) as Promise<NativeSessionBinding>;
  }

  public async checkpoint(reference: string, status: StatusSnapshot, input: Omit<RunCheckpointInput, 'executionLogId' | 'generation' | 'proof' | 'expectedRevision' | 'expectedTurnId'>): Promise<StatusSnapshot> {
    const snapshot = status[runSnapshot];
    if (!snapshot || snapshot.reference !== reference) throw new Error('run_status_snapshot_required');
    if (snapshot.state.status.historicalTurnProjection) throw new Error('historical_turn_read_only');
    const identity = { projectId: snapshot.state.projectId, executionLogId: parseRunStatusReference(reference).executionLogId };
    const current = await this.operation('read_run_checkpoint_state', identity) as RunState;
    if (current.generation !== snapshot.state.generation) throw new Error('run_owner_conflict');
    const state = await this.operation('checkpoint_run', {
      ...input, ...identity, generation: snapshot.state.generation, proof: current.proof,
      expectedRevision: snapshot.state.revision, expectedTurnId: snapshot.state.turnId,
    }) as RunState;
    return this.status(reference, state);
  }

  public async stop(reference: string, status: StatusSnapshot, reason: string, idempotencyKey: string, requireVerifiedIdentity = false, outcome?: 'partial'): Promise<StatusSnapshot> {
    const snapshot = status[runSnapshot];
    if (!snapshot || snapshot.reference !== reference) throw new Error('run_status_snapshot_required');
    if (snapshot.state.status.historicalTurnProjection) throw new Error('historical_turn_read_only');
    const state = await this.operation('stop_run', {
      projectId: snapshot.state.projectId, executionLogId: parseRunStatusReference(reference).executionLogId,
      generation: snapshot.state.generation, expectedRevision: snapshot.state.revision, expectedTurnId: snapshot.state.turnId,
      reason, idempotencyKey, ...(requireVerifiedIdentity ? { requireVerifiedIdentity: true } : {}), ...(outcome ? { outcome } : {}),
    }) as RunState;
    return this.status(reference, state);
  }

  public async readJournal(reference: string, status: StatusSnapshot): Promise<{ turnId: string; executionLogId: number; entry: { agentCli: string; command: string; output: string; status: string } }> {
    const state = await this.selectedState(reference, status);
    return this.operation('read_run_turn_journal', { projectId: state.projectId, executionLogId: parseRunStatusReference(reference).executionLogId, turnId: state.turnId }) as any;
  }

  public async readFlow(reference: string, status: StatusSnapshot, flowId: string): Promise<import('./db/unifiedDataStore').FlowSnapshot | null> {
    const state = await this.selectedState(reference, status);
    return this.operation('read_flow_trace', { projectId: state.projectId, flowId }) as any;
  }

  public async readSettlements(reference: string, status: StatusSnapshot): Promise<Array<Record<string, any>>> {
    const state = await this.selectedState(reference, status);
    const result: Array<Record<string, any>> = []; let cursor: number | null = 0;
    do {
      const page = await this.operation('read_run_settlements', { projectId: state.projectId, executionLogId: parseRunStatusReference(reference).executionLogId, turnId: state.turnId, cursor, limit: 100 }) as { items: Array<Record<string, any>>; nextCursor: number | null };
      result.push(...page.items.filter(item => item.turnId === state.turnId)); cursor = page.nextCursor;
    } while (cursor !== null);
    return result;
  }

  public async claimConsumer(reference: string, status: StatusSnapshot, owner: { id: string; pid: number; birth: string }): Promise<RunConsumerLease | null> {
    const state = await this.selectedState(reference, status);
    if (state.status.historicalTurnProjection) throw new Error('historical_turn_read_only');
    return this.operation('claim_run_consumer', { projectId: state.projectId, executionLogId: parseRunStatusReference(reference).executionLogId, generation: state.generation, expectedRevision: state.revision, expectedTurnId: state.turnId, owner }) as Promise<RunConsumerLease | null>;
  }

  public async listEffects(cursor = 0): Promise<{ items: import('./runLifecycleTypes').RunEffectReference[]; nextCursor: number | null }> {
    return this.operation('list_run_effects', { cursor, limit: 100 }) as any;
  }

  public async listDeliveries(cursor = 0): Promise<{ items: RunState[]; nextCursor: number | null }> {
    return this.operation('list_run_deliveries', { cursor, limit: 100 }) as any;
  }

  public async claimEffect(effect: import('./runLifecycleTypes').RunEffectReference, owner: { id: string; pid: number; birth: string }): Promise<import('./runLifecycleTypes').RunEffect | null> {
    return this.operation('claim_run_effect', { projectId: effect.projectId, effectId: effect.effectId, owner }) as any;
  }

  public async finishEffect(effect: import('./runLifecycleTypes').RunEffect, error?: string): Promise<void> {
    await this.operation('finish_run_effect', { projectId: effect.projectId, effectId: effect.effectId, token: effect.token, result: error === undefined ? 'done' : 'retry', ...(error === undefined ? {} : { error }) });
  }

  public async releaseConsumer(reference: string, status: StatusSnapshot, lease: RunConsumerLease): Promise<void> {
    const state = await this.selectedState(reference, status);
    await this.operation('release_run_consumer', { ...lease, projectId: state.projectId, executionLogId: parseRunStatusReference(reference).executionLogId });
  }

  public async commitSettlement(reference: string, status: StatusSnapshot, lease: RunConsumerLease, input: Omit<RunSettlementInput, keyof RunConsumerLease>): Promise<StatusSnapshot> {
    const state = await this.selectedState(reference, status);
    if (lease.expectedRevision !== state.revision || lease.expectedTurnId !== state.turnId || lease.executionLogId !== parseRunStatusReference(reference).executionLogId) throw new Error('run_consumer_source_changed');
    return this.status(reference, await this.operation('commit_run_settlement', { ...input, ...lease, projectId: state.projectId }) as RunState);
  }

  public async writeStatus(reference: string, proposed: StatusSnapshot): Promise<StatusSnapshot> {
    const snapshot = proposed[runSnapshot];
    if (!snapshot || snapshot.reference !== reference) throw new Error('run_status_snapshot_required');
    if (snapshot.state.status.historicalTurnProjection) throw new Error('historical_turn_read_only');
    const patch: Record<string, unknown> = {};
    const immutable = new Set(['turnId', 'executionLogId', 'journalExecutionLogId', 'rootExecutionLogId', 'workspaceRoot', 'learningTaskId', 'nodeId', 'checkpointSequence', 'checkpointToken']);
    const derived = new Set(['outputFilePath', 'changesFilePath', 'touchedFilesPath', 'commandFilePath', 'promptFilePath', 'sessionFilePath', 'completionDecisionFilePath', 'workspaceSnapshotPath', 'codexHomeFilePath', 'agentProcessPidFilePath']);
    for (const [key, value] of Object.entries(proposed)) {
      if (derived.has(key) || JSON.stringify(value) === JSON.stringify(snapshot.original[key])) continue;
      if (immutable.has(key) || value === undefined) throw new Error('invalid_run_patch');
      patch[key] = value;
    }
    const input = { ...parseRunStatusReference(reference), projectId: snapshot.state.projectId, generation: snapshot.state.generation, expectedRevision: snapshot.state.revision };
    if (!Object.keys(patch).length) {
      const state = await this.operation('read_run_state', input) as RunState;
      if (state.revision !== snapshot.state.revision || state.generation !== snapshot.state.generation) throw new Error('revision_conflict');
      return this.status(reference, state);
    }
    const serialized = JSON.stringify(patch, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value);
    const digest = crypto.createHash('sha256').update(serialized).digest('hex');
    const state = await this.operation('patch_run_state', { ...input, patch, idempotencyKey: `run:${snapshot.state.runId}:${snapshot.state.generation}:${snapshot.state.revision}:plugin:${digest}` }) as RunState;
    return this.status(reference, state);
  }

  public async listStatuses(root?: string, pendingConsumer = false): Promise<Array<{ reference: string; status: StatusSnapshot }>> {
    const result: Array<{ reference: string; status: StatusSnapshot }> = [];
    let cursor: number | null = 0;
    do {
      const page = await this.operation('list_run_states', { ...(root ? { root } : {}), ...(pendingConsumer ? { pendingConsumer: true } : {}), cursor, limit: 100 }) as { items: RunState[]; nextCursor: number | null };
      for (const state of page.items) {
        const reference = runStatusReference(String(state.status.workspaceRoot), Number(state.status.rootExecutionLogId));
        result.push({ reference, status: this.status(reference, state) });
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return result;
  }

  public async listRecoverableStatuses(): Promise<Array<{ reference: string; runId: string; generation: number; status: StatusSnapshot }>> {
    const result: Array<{ reference: string; runId: string; generation: number; status: StatusSnapshot }> = [];
    let cursor: number | null = 0;
    do {
      const page = await this.operation('list_recoverable_run_states', { cursor }) as { items: RunState[]; nextCursor: number | null };
      for (const state of page.items) {
        const reference = runStatusReference(String(state.status.workspaceRoot), Number(state.status.rootExecutionLogId));
        result.push({ reference, runId: state.runId, generation: state.generation, status: this.status(reference, state) });
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return result;
  }

  public async claimTerminalOwner(reference: string, status: StatusSnapshot, owner: { id: string; pid: number; birth: string }): Promise<StatusSnapshot> {
    const snapshot = status[runSnapshot];
    if (!snapshot || snapshot.reference !== reference) throw new Error('run_status_snapshot_required');
    const state = await this.operation('claim_run_terminal_owner', {
      ...parseRunStatusReference(reference), projectId: snapshot.state.projectId,
      generation: snapshot.state.generation, expectedRevision: snapshot.state.revision,
      terminalName: String(status.terminalName || ''), terminalDeliveryId: String(status.terminalDeliveryId || ''), owner,
      idempotencyKey: `run:${snapshot.state.runId}:${snapshot.state.generation}:terminal-owner:${owner.id}`
    }) as RunState;
    return this.status(reference, state);
  }

  public async readLog(reference: string, stream: string, status?: StatusSnapshot): Promise<Buffer> {
    const identity = parseRunStatusReference(reference);
    const state = await this.selectedState(reference, status);
    if (state.status.historicalTurnProjection) {
      if (stream === 'stderr') return Buffer.alloc(0);
      if (stream !== 'output' && stream !== 'stdout') throw new Error('unsupported_run_field');
      const journal = await this.readJournal(reference, status!);
      return Buffer.from(journal.entry.output);
    }
    if (stream === 'output' && status && state.status.nativeReplyObjectId) {
      const reply = await this.operation('read_run_document', { projectId: state.projectId, executionLogId: identity.executionLogId, purpose: `native_reply_${state.turnId.replace(/-/g, '')}`, revision: Number(state.status.nativeReplyRevision) }) as { objectId: string; bytes: string } | null;
      if (!reply || reply.objectId !== state.status.nativeReplyObjectId) throw new Error('run_native_reply_mismatch');
      return Buffer.from(reply.bytes, 'base64');
    }
    const scope = { projectId: state.projectId, executionLogId: identity.executionLogId, stream };
    const head = await this.operation('read_run_log_head', scope) as { totalBytes: number };
    const start = status ? Number((state.status.turnLogStartOffsets as Record<string, unknown> | undefined)?.[stream] || 0) : 0;
    const end = status ? Number((state.status.turnLogEndOffsets as Record<string, unknown> | undefined)?.[stream] ?? head.totalBytes) : head.totalBytes;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > head.totalBytes) throw new Error('run_log_snapshot_invalid');
    const buffers: Buffer[] = []; let offset = start;
    while (offset < end) {
      const page = await this.operation('read_run_log', { ...scope, offset, limit: Math.min(65536, end - offset) }) as { bytes: string };
      const bytes = Buffer.from(page.bytes, 'base64');
      if (!bytes.length || bytes.length > end - offset) throw new Error('run_log_read_incomplete');
      buffers.push(bytes); offset += bytes.length;
    }
    return Buffer.concat(buffers);
  }

  public async readLogTailInfo(reference: string, stream: string, maxBytes: number, status?: StatusSnapshot): Promise<{ bytes: Buffer; totalBytes: number }> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576) throw new Error('run_log_tail_limit_invalid');
    const identity = parseRunStatusReference(reference);
    const state = await this.selectedState(reference, status);
    if (state.status.historicalTurnProjection) {
      const bytes = await this.readLog(reference, stream, status);
      return { bytes: bytes.subarray(Math.max(0, bytes.length - maxBytes)), totalBytes: bytes.length };
    }
    if (stream === 'output' && status && state.status.nativeReplyObjectId) {
      const reply = await this.operation('read_run_document', { projectId: state.projectId, executionLogId: identity.executionLogId, purpose: `native_reply_${state.turnId.replace(/-/g, '')}`, revision: Number(state.status.nativeReplyRevision), tailBytes: maxBytes }) as { objectId: string; bytes: string; totalBytes: number } | null;
      if (!reply || reply.objectId !== state.status.nativeReplyObjectId) throw new Error('run_native_reply_mismatch');
      const bytes = Buffer.from(reply.bytes, 'base64');
      if (!Number.isInteger(reply.totalBytes) || reply.totalBytes < bytes.length) throw new Error('run_native_reply_mismatch');
      return { bytes, totalBytes: reply.totalBytes };
    }
    const scope = { projectId: state.projectId, executionLogId: identity.executionLogId, stream };
    const head = await this.operation('read_run_log_head', scope) as { totalBytes: number };
    const turnStart = status ? Number((state.status.turnLogStartOffsets as Record<string, unknown> | undefined)?.[stream] || 0) : 0;
    const end = status ? Number((state.status.turnLogEndOffsets as Record<string, unknown> | undefined)?.[stream] ?? head.totalBytes) : head.totalBytes;
    if (!Number.isInteger(turnStart) || !Number.isInteger(end) || turnStart < 0 || end < turnStart || end > head.totalBytes) throw new Error('run_log_snapshot_invalid');
    const start = Math.max(turnStart, end - maxBytes);
    const buffers: Buffer[] = []; let offset = start;
    while (offset < end) {
      const page = await this.operation('read_run_log', { ...scope, offset, limit: Math.min(65536, end - offset) }) as { bytes: string };
      const bytes = Buffer.from(page.bytes, 'base64');
      if (!bytes.length || bytes.length > end - offset) throw new Error('run_log_read_incomplete');
      buffers.push(bytes); offset += bytes.length;
    }
    return { bytes: Buffer.concat(buffers), totalBytes: end - turnStart };
  }

  public async readLogTail(reference: string, stream: string, maxBytes: number, status?: StatusSnapshot): Promise<Buffer> {
    return (await this.readLogTailInfo(reference, stream, maxBytes, status)).bytes;
  }

  public async readField(reference: string, field: 'prompt' | 'command' | 'changes' | 'workspace', status?: StatusSnapshot): Promise<string> {
    const identity = parseRunStatusReference(reference);
    const state = await this.selectedState(reference, status);
    if (state.status.historicalTurnProjection && field === 'command') return (await this.readJournal(reference, status!)).entry.command;
    if (field === 'changes' || field === 'workspace') {
      if (field === 'changes' && state.status.workspaceEvidenceBoundary === 'unavailable') return '变更待核验。';
      const revision = Number(state.status[field === 'changes' ? 'workspaceChangesRevision' : 'workspaceSnapshotRevision'] || 0);
      const document = await this.operation('read_run_document', { projectId: state.projectId, executionLogId: identity.executionLogId, purpose: workspaceDocumentPurpose(state.turnId, field === 'changes' ? 'changes' : 'before'), ...(revision ? { revision } : {}) }) as { bytes: string } | null;
      return document ? Buffer.from(document.bytes, 'base64').toString('utf8') : '';
    }
    return (await this.readContent(state.runId, state.revision, `${field}_content`)).toString('utf8');
  }
}
