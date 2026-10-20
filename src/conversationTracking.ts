import * as crypto from 'crypto';
import * as path from 'path';
import type { UnifiedDataStore } from './db/unifiedDataStore';
import { isProcessOwnerAlive, readProcessBirthMarker } from './processIdentity';

interface LaunchOrigin { key: string; source: string; chatId: string; generation: number }
type Launch = Record<string, any>;

export class ConversationTracking {
  constructor(private readonly store: UnifiedDataStore, private readonly database: {
    rows(sql: string, values: Array<string | number>): Array<Record<string, any>>;
    run(sql: string, values: Array<string | number>): void;
    transaction<T>(action: () => T): T;
  }) {}

  public origin(scope: string, operationId?: string, parentConversationId?: string): LaunchOrigin {
    if (!operationId) return { key: parentConversationId ? `run:${parentConversationId}` : `session:${scope}`, source: 'agent', chatId: '', generation: 0 };
    const native = this.store.readPiConversationOperation(operationId);
    const legacy = native ? null : this.database.rows('SELECT conversation_id,source,source_generation,status FROM pi_legacy_conversation_operations WHERE operation_id=?', [operationId])[0];
    if (native ? !['accepted', 'running'].includes(native.status) : legacy?.status !== 'running') throw new Error('intelligence_operation_inactive');
    const source = String(native?.acceptance.source || legacy?.source || 'sidebar');
    const generation = Number(native?.acceptance.sourceGeneration ?? legacy?.source_generation ?? 0);
    const config = new Map(this.store.readHostSettings({ namespace: 'telegram', ownerScope: 'global' }).items.map(item => [item.key, item.value]));
    if (source === 'telegram' && (generation !== Number(config.get('replyGeneration') || 0) || !config.get('enabled') || !config.get('chatId'))) throw new Error('intelligence_reply_revoked');
    return { key: `intelligence:${native?.conversationId || legacy!.conversation_id}`, source,
      chatId: source === 'telegram' ? String(config.get('chatId')) : '', generation };
  }

  public reserve(ownerProjectId: string, projectId: string, origin: LaunchOrigin, input: Record<string, unknown>): { launch: Launch; dispatchToken?: string } {
    return this.database.transaction(() => {
      const hash = crypto.createHash('sha256').update(JSON.stringify({ projectId, mode: input.mode, message: input.message,
        stepId: input.stepId || '', agentCli: input.agentCli || '', model: input.model || '' })).digest('hex');
      const existing = this.database.rows('SELECT * FROM mcp_conversation_launches WHERE origin_key=? AND request_key=?', [origin.key, String(input.idempotencyKey)])[0];
      if (existing) {
        if (existing.intent_hash !== hash) throw new Error('idempotency_conflict');
        return { launch: existing, ...(existing.acknowledged ? {} : { dispatchToken: this.beginDispatch(existing) }) };
      }
      const ref = crypto.randomUUID(), intentId = `mcp:${ref}`;
      const flowId = input.mode === 'flow' ? `flow-${crypto.createHash('sha256').update(intentId).digest('hex').slice(0, 32)}` : '';
      this.database.run(`INSERT INTO mcp_conversation_launches(ref,origin_key,owner_project_id,project_id,request_key,intent_hash,launch_intent_id,mode,flow_id,title,source,chat_id,reply_generation,created_at,error)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'')`, [ref, origin.key, ownerProjectId, projectId, String(input.idempotencyKey), hash, intentId,
        String(input.mode), flowId, String(input.message).slice(0, 200), origin.source, origin.chatId, origin.generation, Date.now()]);
      const launch = this.database.rows('SELECT * FROM mcp_conversation_launches WHERE ref=?', [ref])[0];
      return { launch, dispatchToken: this.beginDispatch(launch) };
    });
  }

  public fail(ref: string, error: string): void {
    this.database.run('UPDATE mcp_conversation_launches SET error=? WHERE ref=?', [error.slice(0, 1000), ref]);
  }

  public acknowledge(launch: Launch): void {
    if (!this.database.rows('SELECT 1 FROM mcp_conversation_launches WHERE ref=?', [launch.ref]).length) throw new Error('conversation_reference_missing');
    this.database.run('UPDATE mcp_conversation_launches SET acknowledged=1,error=\'\' WHERE ref=? AND acknowledged=0', [launch.ref]);
    launch.acknowledged = 1; launch.error = '';
  }

  public beginDispatch(launch: Launch): string {
    return this.database.transaction(() => {
      const token = crypto.randomUUID();
      this.database.run('INSERT INTO mcp_conversation_dispatches VALUES(?,?,?,?)', [token, launch.ref, process.pid, readProcessBirthMarker(process.pid)]);
      this.database.run("UPDATE mcp_conversation_launches SET error='' WHERE ref=?", [launch.ref]);
      this.pruneFailures(String(launch.origin_key));
      return token;
    });
  }

  public finishDispatch(token: string, originKey: string): void {
    this.database.transaction(() => {
      this.database.run('DELETE FROM mcp_conversation_dispatches WHERE id=?', [token]);
      this.pruneFailures(originKey);
    });
  }

  public recoverDispatches(): void {
    const origins = this.database.rows('SELECT DISTINCT l.origin_key FROM mcp_conversation_dispatches d JOIN mcp_conversation_launches l ON l.ref=d.ref', []);
    for (const origin of origins) this.database.transaction(() => this.pruneFailures(String(origin.origin_key)));
  }

  private pruneFailures(originKey: string): void {
    for (const row of this.database.rows('SELECT d.* FROM mcp_conversation_dispatches d JOIN mcp_conversation_launches l ON l.ref=d.ref WHERE l.origin_key=?', [originKey])) {
      if (isProcessOwnerAlive(Number(row.owner_pid), String(row.owner_birth))) continue;
      this.database.run('DELETE FROM mcp_conversation_dispatches WHERE id=?', [row.id]);
      this.database.run("UPDATE mcp_conversation_launches SET error='启动过程已中断，可重试。' WHERE ref=? AND acknowledged=0 AND NOT EXISTS(SELECT 1 FROM mcp_conversation_dispatches WHERE ref=?)", [row.ref, row.ref]);
    }
    const removable = "origin_key=? AND acknowledged=0 AND error<>'' AND run_id IS NULL AND flow_object_id IS NULL AND NOT EXISTS(SELECT 1 FROM mcp_conversation_dispatches d WHERE d.ref=mcp_conversation_launches.ref)";
    this.database.run(`DELETE FROM mcp_conversation_launches WHERE ${removable} AND rowid NOT IN (SELECT rowid FROM mcp_conversation_launches WHERE ${removable} ORDER BY rowid DESC LIMIT 20)`, [originKey, originKey]);
  }

  public query(origin: LaunchOrigin, input: { ref?: string; limit?: number }): Record<string, any> {
    if (input.ref) {
      const row = this.database.rows('SELECT * FROM mcp_conversation_launches WHERE ref=? AND origin_key=?', [input.ref, origin.key])[0];
      if (!row) throw new Error('conversation_scope_denied');
      return this.describe(row);
    }
    const limit = input.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('invalid_conversation_query');
    const visible = this.visibleProjects();
    return { latest: this.database.rows('SELECT * FROM mcp_conversation_launches WHERE origin_key=? AND project_id IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC LIMIT ?',
      [origin.key, JSON.stringify([...visible]), limit]).map(row => this.describe(row)) };
  }

  private visibleProjects(): Set<string> {
    const registry = this.store.readProjectRegistry() as { registry?: { hiddenProjects?: string[] } } | null;
    const hidden = new Set((registry?.registry?.hiddenProjects || []).map(root => path.resolve(root)));
    return new Set(this.store.existingRegisteredProjectScopes().filter(project => !hidden.has(path.resolve(project.root))
      && this.store.readMetadata(project.projectId).archivedAt === null).map(project => project.projectId));
  }

  public describe(row: Launch, sourceRevision?: number): Record<string, any> {
    if (!this.visibleProjects().has(String(row.project_id))) throw new Error('conversation_scope_denied');
    const project = this.store.readMetadata(String(row.project_id));
    const base = { conversationRef: String(row.ref), projectId: String(row.project_id), project: String(project.data.name || ''),
      mode: String(row.mode), title: String(row.title), createdAt: new Date(Number(row.created_at)).toISOString() };
    if (project.archivedAt !== null) throw new Error('conversation_scope_denied');
    if (row.mode === 'flow') {
      const snapshot = this.store.readFlowTrace(String(row.project_id), String(row.flow_id));
      if (!snapshot) return { ...base, flowId: row.flow_id, state: row.error ? 'launch_failed' : 'starting', turnCompleted: false, ...(row.error ? { error: row.error } : {}) };
      const flow = snapshot.flow;
      const progressed = row.acknowledged || !row.error || flow.status !== 'running' || flow.loops.some(loop => (['planner', 'builder', 'verifier'] as const).some(role => {
        const execution = loop[role];
        if (execution.status === 'completed') return true;
        if (!execution.executionLogId) return false;
        const state = this.store.readRunState(String(row.project_id), execution.executionLogId);
        return !state.status.deliveryPending || Boolean(state.status.terminalCommandSubmittedAt);
      }));
      if (!row.acknowledged && row.error && !progressed) return { ...base, flowId: flow.flowId, state: 'launch_failed', turnCompleted: false, error: row.error };
      const loop = flow.loops.find(candidate => candidate.index === flow.currentLoopIndex) || flow.loops.at(-1);
      const state = flow.status === 'needs_user_confirmation' ? 'needs_input' : flow.status;
      return { ...base, flowId: flow.flowId, state, turnCompleted: ['completed', 'failed', 'abandoned'].includes(state),
        flowCompleted: state === 'completed', currentLoop: flow.currentLoopIndex,
        roles: loop ? Object.fromEntries(['planner', 'builder', 'verifier'].map(role => [role, (loop as any)[role].status])) : {},
        result: { summary: flow.latestSummary || '', verification: loop?.scoring || null,
          changedFiles: loop?.evidence?.changedFilesSummary || '', artifacts: [] } };
    }
    let run = this.store.readRunIntent(String(row.project_id), String(row.launch_intent_id));
    if (!run) return { ...base, state: row.error ? 'launch_failed' : 'starting', turnCompleted: false, ...(row.error ? { error: row.error } : {}) };
    if (!row.acknowledged && row.error && run.status.deliveryPending && !run.status.terminalCommandSubmittedAt) return { ...base,
      runId: run.runId, executionLogId: Number(run.status.executionLogId), state: 'launch_failed', turnCompleted: false, error: row.error };
    if (sourceRevision !== undefined) run = this.store.readRunState(run.projectId, Number(run.status.rootExecutionLogId || run.status.executionLogId), sourceRevision);
    const status = run.status;
    const turn = this.store.readMetadata(run.turnId);
    const settled = this.store.readLatestRunSettlement(run.projectId, run.runId, run.turnId, sourceRevision);
    const pending = this.database.rows("SELECT 1 FROM run_consumer_sources WHERE run_id=? AND turn_id=? AND state='queued' AND source_revision>? AND source_revision<=? LIMIT 1",
      [run.runId, run.turnId, Number(settled?.sourceRevision || 0), sourceRevision ?? Number.MAX_SAFE_INTEGER]).length > 0;
    const turnCompleted = Boolean(settled) && !pending;
    const journalStatus = String((settled?.journal as any)?.status || status.status);
    const state = !turnCompleted ? (['Failed', 'Cancelled', 'Interrupted'].includes(journalStatus) ? 'failed' : turn.data.finished_at ? 'settling' : 'running')
      : journalStatus === 'Failed' ? 'failed' : status.interactiveSession === true && status.interactiveSessionClosed !== true ? 'waiting'
        : journalStatus === 'Completed' ? 'completed' : 'needs_input';
    const reportId = String(settled?.reportObjectId || '');
    let report: Record<string, any> | null = null;
    if (turnCompleted && reportId) {
      const object = this.store.read(reportId, Number(settled!.reportRevision));
      if (object.projectId !== run.projectId || object.kind !== 'report' || object.data.turn_id !== run.turnId) throw new Error('conversation_result_scope_mismatch');
      if (object.data.availability === 'available') report = typeof object.data.content === 'string' ? JSON.parse(object.data.content) : object.data.content as Record<string, any>;
    }
    const digest = settled?.digest as Record<string, any> | undefined;
    return { ...base, runId: run.runId, taskId: run.taskId, turnId: run.turnId, executionLogId: Number(status.executionLogId),
      state, turnCompleted, outcome: turn.data.outcome || '', startedAt: status.startedAt, finishedAt: turn.data.finished_at || null,
      result: turnCompleted ? { summary: report?.summary || digest?.outcome || digest?.decision?.summary || status.checkpointSummary || '',
        verification: report?.verification || [], unmetRequirements: report?.unmetRequirements || [],
        changedFiles: digest?.changedFiles || digest?.workspace?.changedFiles || [], artifacts: report?.artifacts || report?.outputs || [],
        commits: report?.commits || [], ...(report ? { report, reportRef: { objectId: reportId, revision: settled!.reportRevision } } : {}) } : null,
      ...(journalStatus === 'Failed' ? { error: String(status.failureReason || status.checkpointSummary || '任务未完成。') } : {}) };
  }

  public notifyRun(projectId: string, runId: string, turnId: string, sourceRevision: number): boolean {
    const row = this.database.rows(`SELECT l.* FROM mcp_conversation_launches l JOIN run_launch_intents i ON i.project_id=l.project_id AND i.launch_intent_id=l.launch_intent_id
      WHERE l.project_id=? AND i.run_id=?`, [projectId, runId])[0];
    if (!row) return false;
    if (!this.visibleProjects().has(projectId)) return true;
    const view = this.describe(row, sourceRevision);
    if (view.turnCompleted && view.turnId === turnId) this.notify(row, view, `turn:${turnId}`);
    return true;
  }

  public notifyFlow(projectId: string, flowId: string, revision: number): void {
    const row = this.database.rows('SELECT * FROM mcp_conversation_launches WHERE project_id=? AND flow_id=?', [projectId, flowId])[0];
    if (!row) return;
    if (!this.visibleProjects().has(projectId)) return;
    const view = this.describe(row);
    if (row.notified_flow_state === view.state) return;
    if (['completed', 'failed', 'abandoned', 'needs_input'].includes(view.state)) this.notify(row, view, `flow:${revision}`);
    this.database.run('UPDATE mcp_conversation_launches SET notified_flow_state=? WHERE ref=?', [view.state, row.ref]);
  }

  private notify(row: Launch, view: Record<string, any>, identity: string): void {
    if (row.source !== 'telegram' || !row.chat_id) return;
    const config = new Map(this.store.readHostSettings({ namespace: 'telegram', ownerScope: 'global' }).items.map(item => [item.key, item.value]));
    if (!config.get('enabled') || String(config.get('chatId')) !== row.chat_id || Number(config.get('replyGeneration') || 0) !== Number(row.reply_generation)) return;
    const labels: Record<string, string> = { completed: '任务已完成', waiting: '本轮已结束，可继续对话', failed: '任务未完成', abandoned: '任务已停止', needs_input: '需要你确认' };
    const verification = (Array.isArray(view.result?.verification) ? view.result.verification : []).map((item: any) =>
      typeof item === 'string' ? item : [item?.summary, item?.result].find(value => typeof value === 'string' && value.trim()) || '').filter(Boolean).slice(0, 3);
    const text = [`[${view.project}] ${view.title}`, labels[view.state] || '任务状态已更新',
      String(view.result?.summary || view.error || '').slice(0, 2200),
      ...verification].filter(Boolean).join('\n');
    const intentId = `conversation:${row.ref}:${identity}`;
    if (this.store.readNotification(intentId)) return;
    this.store.enqueueNotification({ channel: 'telegram', intentId, payload: { replyGeneration: Number(row.reply_generation),
      chatId: String(row.chat_id), text }, idempotencyKey: `enqueue:${intentId}` });
  }
}
