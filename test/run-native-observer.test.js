const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('Codex observation reads each new native log range once and commits its cursor once per batch', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/runNativeObserver.ts'), 'utf8');
  const start = source.indexOf("const stream = 'native:codex'");
  const end = source.indexOf('\n  private async observeClaude', start);
  const body = source.slice(start, end);
  assert.match(body, /const frames: Array</);
  assert.equal((body.match(/for await \(const frame of this\.rows/g) || []).length, 1,
    'the same growing transcript range must not be fetched twice');
  assert.equal((body.match(/codexNativeCursor:/g) || []).length, 1,
    'cursor persistence must be batched instead of writing one database revision per JSONL row');
});
const crypto = require('node:crypto');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { snapshotWorkspace, workspaceDocumentPurpose } = require('../out/runWorkspace.js');
const { createInteractionBudget } = require('../out/interactionBudget.js');

test('a delayed Codex observation records authoritative task ingress after the host observation timeout', async () => {
  const { RunNativeObserver } = require('../out/runNativeObserver.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-native-ingress-diagnostic-'));
  const root = path.join(base, '.solomap-global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const interactionBudget = createInteractionBudget();
    const run = await call('prepare_run', {
      root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '真实任务', command: 'codex', userMessage: '真实任务',
      metadata: { interactiveSession: true, sessionProvider: 'codex', interactionBudget, interactionId: interactionBudget.interactionId,
        terminalDeliveryTraceId: '0123456789abcdef', deliveryLastError: 'agent_task_ingress_timeout' },
      idempotencyKey: 'native-ingress-diagnostic-prepare'
    });
    const scope = { projectId: run.projectId, executionLogId: 1, generation: run.generation };
    const observer = new RunNativeObserver(store);
    const current = () => store.readRunCheckpointState(run.projectId, 1);
    const patch = (fields, event) => { const latest = current(); return store.patchRunState(run.projectId, { ...scope, expectedRevision: latest.revision, patch: fields, idempotencyKey: `native-ingress-diagnostic:${event}:${latest.revision}` }); };
    const timestamp = new Date(Math.max(interactionBudget.acceptedWallMs, Date.parse(run.status.startedAt)) + 25).toISOString();
    await observer.observeRow(current, patch, { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: 'native-ingress-turn', started_at: timestamp } }, 25);
    const final = current();
    assert.equal(final.status.taskIngressReceipt.authority, 'provider_native');
    assert.equal(final.status.deliveryLastError, '');
    const events = store.readDiagnosticEvents({ kind: 'operation', limit: 20 }).items;
    const ingress = events.find(item => item.scope === 'terminal.delivery.task.ingress' && item.payload.status === 'ok');
    assert.ok(ingress, 'the authoritative provider event must reconcile a delayed host observation');
    assert.equal(ingress.payload.traceId, '0123456789abcdef');
    assert.equal(ingress.payload.interactionId, interactionBudget.interactionId);
    assert.equal(ingress.payload.authority, 'provider_native');
    assert.equal(ingress.payload.reconciledObservationTimeout, true);
    const source = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8');
    assert.doesNotMatch(source, /trace\?\.record\('terminal\.delivery\.task\.ingress',/,
      'host polling must be identified as observation rather than authoritative provider ingress');
  } finally { await ops.close(); store.close(); }
});

test('session reentry records the first real native TUI request on the precreated turn without a synthetic prompt', async () => {
  const { RunNativeObserver } = require('../out/runNativeObserver.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-native-reentry-request-'));
  const root = path.join(base, '.solomap-global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const interactionBudget = createInteractionBudget();
    const run = await call('prepare_run', {
      root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '', command: 'codex resume session-1', userMessage: '',
      status: 'Waiting', metadata: { interactiveSession: true, sessionProvider: 'codex', nativeSessionId: 'session-1', agentInputMode: 'session_reentry', nativeSessionReentryAwaitingRequest: true,
        interactionBudget, interactionId: interactionBudget.interactionId },
      idempotencyKey: 'native-reentry-prepare'
    });
    const scope = { projectId: run.projectId, executionLogId: 1, generation: run.generation };
    const observer = new RunNativeObserver(store);
    const current = () => store.readRunCheckpointState(run.projectId, 1);
    const patch = (fields, event) => { const latest = current(); return store.patchRunState(run.projectId, { ...scope, expectedRevision: latest.revision, patch: fields, idempotencyKey: `native-reentry:${event}:${latest.revision}` }); };
    const timestamp = new Date(Date.parse(run.status.startedAt) + 10).toISOString();
    const request = '这是用户在重新进入原生会话后真正输入的要求';
    await observer.observeRow(current, patch, { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: request }] } }, 100);
    const accepted = current();
    assert.equal(accepted.status.status, 'Running');
    assert.notEqual(accepted.status.interactionId, run.status.interactionId, 'the real native submit starts its own task budget');
    await observer.observeRow(current, patch, { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: 'native-reentry-turn', started_at: timestamp } }, 101);
    const started = current();
    assert.equal(started.status.taskIngressReceipt.interactionId, started.status.interactionId);
    await observer.observeRow(current, patch, { type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: 'native-reentry-turn', started_at: timestamp, completed_at: timestamp, last_agent_message: '已按真实要求完成' } }, 102);
    const final = current();
    assert.equal(final.turnId, run.turnId, 'reentry must fill the precreated turn rather than creating another empty turn');
    assert.equal(store.read(run.turnId).data.request_content, request);
    assert.equal(final.status.userMessage, request);
    assert.equal(final.status.nativeSessionReentryAwaitingRequest, false);
    const journal = await call('read_run_turn_journal', { ...scope, turnId: run.turnId });
    assert.match(journal.entry.output, new RegExp(request));
    assert.doesNotMatch(journal.entry.output, /等待本轮用户消息/);
  } finally { await ops.close(); store.close(); }
});

test('closing a resume-only session before user input does not create a failed task turn', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-native-reentry-close-'));
  const root = path.join(base, '.solomap-global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const run = await call('prepare_run', {
      root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo_continue', prompt: '', command: 'codex resume session-1', userMessage: '', status: 'Waiting',
      metadata: { interactiveSession: true, sessionProvider: 'codex', nativeSessionId: 'session-1', agentInputMode: 'session_reentry', nativeSessionReentryAwaitingRequest: true },
      idempotencyKey: 'native-reentry-close-prepare'
    });
    const closed = await call('checkpoint_run', { projectId: run.projectId, executionLogId: 1, generation: run.generation, proof: run.proof,
      expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'session-close', exitCode: 0, idempotencyKey: 'native-reentry-close' });
    const turn = store.read(run.turnId);
    assert.equal(closed.status.status, 'Session Closed');
    assert.equal(closed.status.failureCode, undefined);
    assert.equal(turn.data.outcome, 'partial');
    assert.equal(turn.data.summary_content, '');
    assert.ok(turn.data.finished_at);
  } finally { await ops.close(); store.close(); }
});

test('the Runtime observes exact native identity and settles machine turns while the Agent stays alive without running checkpoint commands', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-native-observer-'));
  const root = path.join(base, '.solomap-global'); const project = path.join(base, 'project'); const codexHome = path.join(base, 'codex-home'); fs.mkdirSync(project);
  let store = new UnifiedDataStore(root); let ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const nonce = crypto.randomBytes(32).toString('hex'); const sessionId = crypto.randomUUID();
    const run = await call('prepare_run', { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '用户完整目标', command: 'codex', userMessage: '用户完整目标', metadata: { interactiveSession: true, sessionProvider: 'codex', bindingNonce: nonce }, idempotencyKey: 'native-prepare' });
    const scope = { projectId: run.projectId, root: project, executionLogId: 1 };
    await call('write_run_binding', { ...scope, generation: run.generation, expectedHeadRevision: 0, seed: { runId: '1', provider: 'codex', workspaceRoot: project, cliPath: 'codex', bindingNonce: nonce, method: 'transcript_correlated_compat', contract: 'compatibility', createdAt: run.status.startedAt, providerContext: { codex: { codexHome } } }, idempotencyKey: 'native-seed' });
    const latest = await call('read_run_state', scope);
    const claimed = await call('claim_run', { ...scope, expectedRevision: latest.revision, agentPid: process.pid, idempotencyKey: 'native-live-owner' });
    await call('write_run_document', { ...scope, generation: claimed.generation, turnId: run.turnId, purpose: workspaceDocumentPurpose(run.turnId, 'before'), bytes: Buffer.from(JSON.stringify(await snapshotWorkspace(project))).toString('base64'), mimeType: 'application/json', expectedRevision: 0, idempotencyKey: 'native-before' });
    const timestamp = new Date(Date.parse(run.status.startedAt) + 10).toISOString();
    const date = new Date(timestamp); const directory = path.join(codexHome, 'sessions', String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')); fs.mkdirSync(directory, { recursive: true });
    const transcript = path.join(directory, `rollout-${sessionId}.jsonl`);
    const rows = [
      { type: 'session_meta', timestamp, payload: { id: sessionId, cwd: project, timestamp } },
      { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `SoloMap binding nonce: ${nonce}.` }] } },
      { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: 'native-first', started_at: timestamp } },
      { type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: 'native-first', started_at: timestamp, completed_at: timestamp, last_agent_message: '完整机器结果🌿\n'.repeat(10000) } }
    ];
    fs.writeFileSync(transcript, rows.map(value => JSON.stringify(value)).join('\n') + '\n');
    fs.writeFileSync(path.join(project, 'result.txt'), 'first actual result');
    await call('recover_run_executions', {});
    const first = await call('read_run_state', scope);
    assert.equal(first.status.status, 'In Progress'); assert.equal(first.turnId, run.turnId);
    assert.equal(store.read(run.turnId).data.summary_content, '完整机器结果🌿\n'.repeat(10000));
    const binding = await call('read_run_binding', scope); const head = binding.revisions.at(-1);
    assert.equal(head.state, 'confirmed'); assert.equal(head.sessionId, sessionId);
    assert.equal(first.status.nativeSessionId, sessionId); assert.equal(first.status.nativeSessionIdIsCurrent, true);
    const changes = await call('read_run_document', { ...scope, purpose: workspaceDocumentPurpose(run.turnId, 'changes') });
    assert.equal(Buffer.from(changes.bytes, 'base64').toString(), 'A result.txt');
    await call('recover_run_executions', {}); assert.equal((await call('read_run_state', scope)).revision, first.revision);
    await ops.close(); store.close();
    store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store);
    const nextTimestamp = new Date().toISOString();
    const nextRows = [
      { type: 'response_item', timestamp: nextTimestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续原目标，完整补充🌿' }] } },
      { type: 'event_msg', timestamp: nextTimestamp, payload: { type: 'task_started', turn_id: 'native-second', started_at: nextTimestamp } }
    ];
    fs.appendFileSync(transcript, nextRows.map(value => JSON.stringify(value)).join('\n') + '\n');
    await call('recover_run_executions', {});
    const second = await call('read_run_state', scope); assert.notEqual(second.turnId, run.turnId);
    assert.equal(second.status.status, 'Running'); assert.equal(second.status.journalExecutionLogId, 2);
    assert.equal(store.read(second.turnId).data.request_content, '继续原目标，完整补充🌿');
    fs.writeFileSync(path.join(project, 'result.txt'), 'second actual longer result');
    const completion = JSON.stringify({ type: 'event_msg', timestamp: nextTimestamp, payload: { type: 'task_complete', turn_id: 'native-second', started_at: nextTimestamp, completed_at: nextTimestamp, last_agent_message: '第二轮真实结果' } });
    fs.appendFileSync(transcript, completion.slice(0, -1));
    await call('recover_run_executions', {}); assert.equal((await call('read_run_state', scope)).status.status, 'Running');
    fs.appendFileSync(transcript, '}\n'); await call('recover_run_executions', {});
    const done = await call('read_run_state', scope); assert.equal(done.status.status, 'In Progress');
    assert.equal(store.read(second.turnId).data.summary_content, '第二轮真实结果');
    assert.equal(store.read(run.turnId).data.summary_content, '完整机器结果🌿\n'.repeat(10000));
    const numericStarted = Date.now();
    fs.appendFileSync(transcript, JSON.stringify({ type: 'event_msg', timestamp: new Date(numericStarted).toISOString(), payload: { type: 'task_started', turn_id: 'native-numeric', started_at: numericStarted / 1000 } }) + '\n');
    await call('recover_run_executions', {});
    const numeric = await call('read_run_state', scope); assert.equal(numeric.status.status, 'Running');
    assert.notEqual(numeric.turnId, second.turnId);
    fs.appendFileSync(transcript, JSON.stringify({ type: 'event_msg', timestamp: new Date(numericStarted).toISOString(), payload: { type: 'task_complete', turn_id: 'native-numeric', started_at: numericStarted / 1000, completed_at: numericStarted, last_agent_message: '数值时刻完成' } }) + '\n');
    await call('recover_run_executions', {});
    assert.equal(store.read(numeric.turnId).data.summary_content, '数值时刻完成');
    const orderedTimestamp = new Date().toISOString();
    fs.appendFileSync(transcript, [
      { type: 'event_msg', timestamp: orderedTimestamp, payload: { type: 'task_started', turn_id: 'native-start-before-user', started_at: orderedTimestamp } },
      { type: 'response_item', timestamp: orderedTimestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '实际新一轮用户消息🌿' }] } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    await call('recover_run_executions', {});
    const ordered = await call('read_run_state', scope);
    assert.equal(ordered.status.status, 'Running');
    assert.equal(store.read(ordered.turnId).data.request_content, '实际新一轮用户消息🌿');
    assert.equal(ordered.status.userMessage, '实际新一轮用户消息🌿');
    assert.match((await call('read_run_turn_journal', { ...scope, turnId: ordered.turnId })).entry.output, /实际新一轮用户消息🌿/);
    fs.appendFileSync(transcript, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'turn_aborted', reason: 'interrupted' } }) + '\n');
    await call('recover_run_executions', {});
    const aborted = await call('read_run_state', scope);
    assert.equal(aborted.status.status, 'Failed'); assert.equal(aborted.turnId, ordered.turnId);
    assert.equal(store.read(ordered.turnId).data.outcome, 'failed');
    const resumedTimestamp = new Date().toISOString();
    fs.appendFileSync(transcript, [
      { type: 'event_msg', timestamp: resumedTimestamp, payload: { type: 'task_started', turn_id: 'native-after-abort', started_at: resumedTimestamp } },
      { type: 'response_item', timestamp: resumedTimestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '中止后继续原目标' }] } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    await call('recover_run_executions', {});
    const resumed = await call('read_run_state', scope);
    assert.notEqual(resumed.turnId, aborted.turnId); assert.equal(resumed.status.status, 'Running');
    assert.equal(store.read(resumed.turnId).data.request_content, '中止后继续原目标');
    const headLog = await call('read_run_log_head', { ...scope, stream: 'native:codex' });
    assert.equal(headLog.totalBytes, fs.statSync(transcript).size);
    const chunks = []; for (let offset = 0; offset < headLog.totalBytes;) {
      const page = await call('read_run_log', { ...scope, stream: 'native:codex', offset, limit: 65536 }); const bytes = Buffer.from(page.bytes, 'base64'); chunks.push(bytes); offset += bytes.length;
    }
    assert.deepEqual(Buffer.concat(chunks), fs.readFileSync(transcript));
    assert.deepEqual(fs.readdirSync(path.join(project, '.solopreneur')), ['project.json']);
  } finally { await ops.close(); store.close(); }
});

test('an unavailable native transcript does not prevent dead-owner recovery from settling the actual run', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-native-missing-'));
  const root = path.join(base, '.solomap-global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const sessionId = crypto.randomUUID();
    const run = await call('prepare_run', { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '用户目标', command: 'codex', userMessage: '用户目标', metadata: { interactiveSession: true, sessionProvider: 'codex' }, idempotencyKey: 'missing-native-run' });
    const scope = { projectId: run.projectId, root: project, executionLogId: 1, generation: run.generation };
    const seed = await call('write_run_binding', { ...scope, expectedHeadRevision: 0, seed: { runId: '1', provider: 'codex', workspaceRoot: project, cliPath: 'codex', bindingNonce: crypto.randomBytes(32).toString('hex'), method: 'transcript_correlated_compat', contract: 'compatibility', createdAt: run.status.startedAt }, idempotencyKey: 'missing-native-seed' });
    const planned = await call('write_run_binding', { ...scope, expectedHeadRevision: seed.headRevision, revision: { sessionId, method: 'transcript_correlated_compat', contract: 'compatibility', state: 'planned' }, idempotencyKey: 'missing-native-planned' });
    await call('write_run_binding', { ...scope, expectedHeadRevision: planned.headRevision, confirmSessionId: sessionId, evidence: { source: 'confirmed_resume_target', transcriptPath: path.join(base, 'provider-record-not-present.jsonl') }, idempotencyKey: 'missing-native-confirmed' });
    const latest = await call('read_run_state', scope);
    await call('claim_run', { ...scope, expectedRevision: latest.revision, idempotencyKey: 'missing-native-owner' });
    await call('recover_run_executions', {});
    const recovered = await call('read_run_state', scope);
    assert.equal(recovered.status.status, 'Failed'); assert.equal(recovered.turnId, run.turnId);
    assert.equal(store.read(run.turnId).data.outcome, 'failed');
  } finally { await ops.close(); store.close(); }
});

test('a previous native completion cannot settle an explicitly started newer turn', async () => {
  const { RunNativeObserver } = require('../out/runNativeObserver.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-native-old-turn-'));
  const root = path.join(base, '.solomap-global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const run = await call('prepare_run', { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '第一轮', command: 'codex', userMessage: '第一轮', metadata: { interactiveSession: true, sessionProvider: 'codex' }, idempotencyKey: 'old-native-prepare' });
    const scope = { projectId: run.projectId, executionLogId: 1, generation: run.generation };
    const nativeStart = new Date(Date.parse(run.status.startedAt) + 1).toISOString();
    const observer = new RunNativeObserver(store);
    const current = () => store.readRunCheckpointState(run.projectId, 1);
    const patch = (fields, event) => { const latest = current(); return store.patchRunState(run.projectId, { ...scope, expectedRevision: latest.revision, patch: fields, idempotencyKey: `old-native:${event}:${latest.revision}` }); };
    await observer.observeRow(current, patch, { type: 'event_msg', timestamp: nativeStart, payload: { type: 'task_started', turn_id: 'native-first', started_at: nativeStart } }, 0);
    let first = current();
    first = await call('checkpoint_run', { ...scope, proof: first.proof, expectedRevision: first.revision, expectedTurnId: first.turnId, action: 'complete', outcome: 'partial', summary: '第一轮已提交', idempotencyKey: 'old-native-first-complete' });
    await observer.observeRow(current, patch, { type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete', turn_id: 'native-first', started_at: nativeStart, last_agent_message: '第一轮完整机器结果' } }, 99);
    const next = await call('checkpoint_run', { ...scope, proof: current().proof, expectedRevision: current().revision, expectedTurnId: first.turnId, action: 'start', message: '第二轮目标', idempotencyKey: 'old-native-new-start' });
    await observer.observeRow(current, patch, { type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete', turn_id: 'native-first', started_at: nativeStart, last_agent_message: '迟到第一轮结果' } }, 100);
    const final = current();
    assert.equal(final.turnId, next.turnId); assert.equal(final.status.status, 'Running');
    assert.equal(store.readMetadata(next.turnId).data.finished_at, null);
    assert.equal(store.read(run.turnId).data.summary_content, '第一轮已提交');
    assert.equal((await call('read_run_turn_journal', { ...scope, turnId: run.turnId })).entry.status, 'In Progress');
    assert.match((await call('read_run_turn_journal', { ...scope, turnId: run.turnId })).entry.output, /第一轮已提交/);
    assert.equal((await call('read_run_turn_journal', { ...scope, turnId: next.turnId })).entry.status, 'Running');
  } finally { await ops.close(); store.close(); }
});


test('historical native starts preserve every turn and use the last sealed workspace before a committed change', async () => {
  const { RunNativeObserver } = require('../out/runNativeObserver.js');
  const { execFileSync } = require('node:child_process');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-native-backlog-'));
  const root = path.join(base, '.solomap-global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(project, 'result.txt'), 'original'); git('add', 'result.txt'); git('commit', '-q', '-m', 'baseline');
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const run = await call('prepare_run', { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '第一轮', command: 'codex', userMessage: '第一轮', metadata: { interactiveSession: true, sessionProvider: 'codex', baseGitHash: git('rev-parse', 'HEAD') }, idempotencyKey: 'backlog-prepare' });
    const scope = { projectId: run.projectId, executionLogId: 1, generation: run.generation };
    const current = () => store.readRunCheckpointState(run.projectId, 1);
    const patch = (fields, event) => { const latest = current(); return store.patchRunState(run.projectId, { ...scope, expectedRevision: latest.revision, patch: fields, idempotencyKey: `backlog:${event}:${latest.revision}` }); };
    const observer = new RunNativeObserver(store);
    const first = current();
    await call('checkpoint_run', { ...scope, proof: first.proof, expectedRevision: first.revision, expectedTurnId: first.turnId, action: 'complete', outcome: 'partial', summary: '已完成第一轮', idempotencyKey: 'backlog-first-complete' });
    const historical = Date.now(); await new Promise(resolve => setTimeout(resolve, 30));
    fs.writeFileSync(path.join(project, 'result.txt'), 'actual committed second result'); git('add', 'result.txt'); git('commit', '-q', '-m', 'second result');
    const turns = [];
    for (const [i, message] of ['第二轮目标', '第三轮目标'].entries()) {
      const timestamp = new Date(historical + i).toISOString();
      await observer.observeRow(current, patch, { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: message }] } }, 100 + i * 3);
      await observer.observeRow(current, patch, { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: `native-backlog-${i}`, started_at: timestamp } }, 101 + i * 3);
      turns.push(current().turnId);
      await observer.observeRow(current, patch, { type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: `native-backlog-${i}`, started_at: timestamp, last_agent_message: `完成${message}` } }, 102 + i * 3);
    }
    assert.equal(new Set([first.turnId, ...turns]).size, 3, 'historical native turns must all have distinct formal identities');
    assert.equal(store.read(turns[1]).data.request_content, '第三轮目标');
    assert.equal(store.read(turns[1]).data.summary_content, '完成第三轮目标');
    const changed = store.readRunDocument(run.projectId, 1, workspaceDocumentPurpose(turns[0], 'changes'));
    assert.match(Buffer.from(changed.bytes, 'base64').toString(), /M result.txt/, 'delayed observation must retain the committed change');
    const { gitEvidenceDocumentPurpose } = require('../out/runWorkspace.js');
    const evidence = store.readRunDocument(run.projectId, 1, gitEvidenceDocumentPurpose(turns[0]));
    assert.match(JSON.parse(Buffer.from(evidence.bytes, 'base64')).patch, /actual committed second result/);
  } finally { await ops.close(); store.close(); }
});


test('replayed native turns seal machine timestamps and each turn own cumulative token delta', async () => {
  const { RunNativeObserver } = require('../out/runNativeObserver.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-native-usage-'));
  const root = path.join(base, '.solomap-global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  try {
    const run = await ops({ operation: 'prepare_run', input: { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '原目标', command: 'codex', userMessage: '原目标', metadata: { interactiveSession: true, sessionProvider: 'codex' }, idempotencyKey: 'usage-prepare' } });
    const scope = { projectId: run.projectId, executionLogId: 1, generation: run.generation };
    const current = () => store.readRunCheckpointState(run.projectId, 1);
    const patch = (fields, event) => { const latest = current(); return store.patchRunState(run.projectId, { ...scope, expectedRevision: latest.revision, patch: fields, idempotencyKey: `usage:${event}:${latest.revision}` }); };
    const observer = new RunNativeObserver(store);
    const start = Date.parse(run.status.startedAt) + 1;
    const totals = [{ input_tokens: 100, cached_input_tokens: 20, output_tokens: 40, reasoning_output_tokens: 5, total_tokens: 140 }, { input_tokens: 150, cached_input_tokens: 35, output_tokens: 60, reasoning_output_tokens: 7, total_tokens: 210 }];
    const expected = [{ inputTokens: 100, cachedInputTokens: 20, outputTokens: 40, reasoningOutputTokens: 5, totalTokens: 140 }, { inputTokens: 50, cachedInputTokens: 15, outputTokens: 20, reasoningOutputTokens: 2, totalTokens: 70 }];
    const revisions = [];
    for (let i = 0; i < 2; i++) {
      const began = new Date(start + i * 20).toISOString(); const ended = new Date(start + i * 20 + 10).toISOString();
      await observer.observeRow(current, patch, { type: 'event_msg', timestamp: began, payload: { type: 'task_started', turn_id: `usage-${i}`, started_at: began } }, i * 100);
      await observer.observeRow(current, patch, { type: 'event_msg', timestamp: ended, payload: { type: 'token_count', info: { total_token_usage: totals[i] } } }, i * 100 + 1);
      await observer.observeRow(current, patch, { type: 'event_msg', timestamp: ended, payload: { type: 'task_complete', turn_id: `usage-${i}`, started_at: began, completed_at: ended, last_agent_message: `完整结果${i}` } }, i * 100 + 2);
      const state = current(); revisions.push(state.revision);
      assert.deepEqual({ began: state.status.turnStartedAt, ended: state.status.finishedAt, usage: state.status.nativeTokenUsage, formalEnded: store.readMetadata(state.turnId).data.finished_at }, { began, ended, usage: expected[i], formalEnded: Date.parse(ended) });
    }
    assert.deepEqual(store.readRunState(run.projectId, 1, revisions[0]).status.nativeTokenUsage, expected[0], 'future turns must not mutate the source usage');
  } finally { await ops.close(); store.close(); }
});


test('offline B and C preserve their machine results without claiming the current files as either historical workspace', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-native-offline-workspace-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); const codexHome = path.join(base, 'codex'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const nonce = crypto.randomBytes(32).toString('hex'); const sessionId = crypto.randomUUID();
    const run = await call('prepare_run', { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '原目标', command: 'codex', userMessage: '原目标', metadata: { interactiveSession: true, sessionProvider: 'codex', bindingNonce: nonce }, idempotencyKey: 'offline-prepare' });
    const scope = { projectId: run.projectId, executionLogId: 1 };
    await call('write_run_binding', { ...scope, generation: run.generation, expectedHeadRevision: 0, seed: { runId: '1', provider: 'codex', workspaceRoot: project, cliPath: 'codex', bindingNonce: nonce, method: 'transcript_correlated_compat', contract: 'compatibility', createdAt: run.status.startedAt, providerContext: { codex: { codexHome } } }, idempotencyKey: 'offline-seed' });
    const state = await call('read_run_state', scope);
    await call('claim_run', { ...scope, expectedRevision: state.revision, agentPid: process.pid, idempotencyKey: 'offline-owner' });
    const timestamp = new Date(Date.parse(run.status.startedAt) + 1).toISOString(); const date = new Date(timestamp);
    const directory = path.join(codexHome, 'sessions', String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')); fs.mkdirSync(directory, { recursive: true });
    const transcript = path.join(directory, `rollout-${sessionId}.jsonl`);
    const event = (turn, time, type, message) => ({ type: 'event_msg', timestamp: time, payload: { type, turn_id: turn, started_at: time, last_agent_message: message } });
    const firstRows = [{ type: 'session_meta', timestamp, payload: { id: sessionId, cwd: project, timestamp } }, { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `SoloMap binding nonce: ${nonce}.` }] } }, event('A', timestamp, 'task_started'), event('A', timestamp, 'task_complete', '第一轮完整结果')];
    fs.writeFileSync(transcript, firstRows.map(row => JSON.stringify(row)).join('\n') + '\n');
    await call('recover_run_executions', {});
    const began = Date.now() + 1; const backlog = [];
    for (const [i, turn] of ['B', 'C'].entries()) {
      const time = new Date(began + i).toISOString();
      backlog.push({ type: 'response_item', timestamp: time, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${turn}的真实要求` }] } }, event(turn, time, 'task_started'), event(turn, time, 'task_complete', `${turn}的完整机器结果`));
      fs.writeFileSync(path.join(project, `${turn.toLowerCase()}.txt`), `${turn} actual result`);
    }
    fs.appendFileSync(transcript, backlog.map(row => JSON.stringify(row)).join('\n') + '\n');
    await call('recover_run_executions', {});
    const sources = store.listRunStates({ projectId: run.projectId, pendingConsumer: true }).items;
    for (const turn of ['B', 'C']) {
      const source = sources.find(item => item.status.codexNativeTurnId === turn); assert.ok(source);
      assert.equal(store.read(source.turnId).data.summary_content, `${turn}的完整机器结果`);
      assert.equal(source.status.workspaceEvidenceBoundary, 'unavailable', 'a current sample cannot be presented as a historical per-turn workspace');
      const observed = store.readRunDocument(run.projectId, 1, `native_workspace_observation_${source.turnId.replace(/-/g, '')}`);
      assert.ok(observed, 'the real current observation must still be retained');
      const saved = JSON.parse(Buffer.from(observed.bytes, 'base64'));
      assert.deepEqual(Object.keys(saved.workspaceSnapshot).sort(), ['b.txt', 'c.txt']);
      assert.ok(saved.observedAt);
    }
    const all = []; let offset = 0; const head = await call('read_run_log_head', { ...scope, stream: 'native:codex' });
    while (offset < head.totalBytes) { const page = await call('read_run_log', { ...scope, stream: 'native:codex', offset, limit: 65536 }); const bytes = Buffer.from(page.bytes, 'base64'); all.push(bytes); offset += bytes.length; }
    assert.deepEqual(Buffer.concat(all), fs.readFileSync(transcript));
  } finally { await ops.close(); store.close(); }
});


test('a machine reply remains in its fixed turn after late terminal bytes and another native turn', async () => {
  const { RunNativeObserver } = require('../out/runNativeObserver.js');
  const { RunLifecycleClient, runStatusReference, runDataReference } = require('../out/runLifecycleClient.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-native-reply-seal-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  try {
    const run = await ops({ operation: 'prepare_run', input: { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '原目标', command: 'codex', userMessage: '原目标', metadata: { interactiveSession: true, sessionProvider: 'codex' }, idempotencyKey: 'reply-prepare' } });
    const scope = { projectId: run.projectId, executionLogId: 1, generation: run.generation };
    const current = () => store.readRunCheckpointState(run.projectId, 1);
    const patch = (fields, event) => { const latest = current(); return store.patchRunState(run.projectId, { ...scope, expectedRevision: latest.revision, patch: fields, idempotencyKey: `reply:${event}:${latest.revision}` }); };
    const observer = new RunNativeObserver(store); const began = Date.parse(run.status.startedAt) + 1;
    const reply = '属于第一轮的完整机器输出🌿\n'.repeat(18000);
    await observer.observeRow(current, patch, { type: 'event_msg', timestamp: new Date(began).toISOString(), payload: { type: 'task_started', turn_id: 'reply-B', started_at: began } }, 0);
    await observer.observeRow(current, patch, { type: 'event_msg', timestamp: new Date(began + 1).toISOString(), payload: { type: 'task_complete', turn_id: 'reply-B', started_at: began, last_agent_message: reply } }, 1);
    const source = current(); const ref = runStatusReference(project, 1); const client = new RunLifecycleClient((operation, input) => ops({ operation, input }));
    const sealed = await client.readStatus(ref, source.revision);
    const late = Buffer.from('第一轮迟到的原始终端字节🌿');
    await ops({ operation: 'append_run_log', input: { ...scope, stream: 'stdout', sequence: 0, offset: 0, bytes: late.toString('base64'), idempotencyKey: 'reply-late-terminal' } });
    await observer.observeRow(current, patch, { type: 'event_msg', timestamp: new Date(began + 2).toISOString(), payload: { type: 'task_started', turn_id: 'reply-C', started_at: began + 2 } }, 2);
    await observer.observeRow(current, patch, { type: 'event_msg', timestamp: new Date(began + 3).toISOString(), payload: { type: 'task_complete', turn_id: 'reply-C', started_at: began + 2, last_agent_message: '下一轮独立结果' } }, 3);
    const output = await client.readData(runDataReference(ref, 'output'), sealed);
    assert.equal(output.toString('utf8'), reply, 'formal consumers must keep the full machine reply even before its terminal display is committed');
    assert.deepEqual(await client.readLog(ref, 'stdout'), late, 'late terminal bytes must remain intact in the session source');
    assert.equal(store.read(source.turnId).data.summary_content, reply);
    const saved = current();
    assert.equal((await client.readData(runDataReference(ref, 'output'), await client.readStatus(ref, saved.revision))).toString('utf8'), '下一轮独立结果');
  } finally { await ops.close(); store.close(); }
});


test('an Agent business completion waits for its native reply while keeping the accepted candidate and report', async () => {
  const { RunNativeObserver } = require('../out/runNativeObserver.js');
  const { RunLifecycleClient, runStatusReference, runDataReference } = require('../out/runLifecycleClient.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-native-business-before-reply-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  try {
    const run = await ops({ operation: 'prepare_run', input: { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '原目标', command: 'codex', userMessage: '原目标', metadata: { interactiveSession: true, sessionProvider: 'codex' }, idempotencyKey: 'business-prepare' } });
    const scope = { projectId: run.projectId, executionLogId: 1, generation: run.generation };
    const current = () => store.readRunCheckpointState(run.projectId, 1);
    const patch = (fields, event) => { const latest = current(); return store.patchRunState(run.projectId, { ...scope, expectedRevision: latest.revision, patch: fields, idempotencyKey: `business:${event}:${latest.revision}` }); };
    const observer = new RunNativeObserver(store); const began = Date.parse(run.status.startedAt) + 1;
    await observer.observeRow(current, patch, { type: 'event_msg', timestamp: new Date(began).toISOString(), payload: { type: 'task_started', turn_id: 'business-native', started_at: began } }, 0);
    const before = current(); const report = { schemaVersion: 1, summary: '已完成真实交付', unmetRequirements: [], decisions: [], corrections: [], verification: [], commits: [], experienceUsage: [], lessons: [] };
    const accepted = await ops({ operation: 'checkpoint_run', input: { ...scope, proof: before.proof, expectedRevision: before.revision, expectedTurnId: before.turnId, action: 'complete', outcome: 'candidate_complete', summary: '用户原目标已完成', report, idempotencyKey: 'business-complete' } });
    assert.equal(store.listRunStates({ projectId: run.projectId, pendingConsumer: true }).items.length, 0, 'review must wait for the actual machine result');
    assert.equal(accepted.status.nativeOutputPending, true);
    const reply = '随后返回的完整机器结果🌿'.repeat(18000);
    await observer.observeRow(current, patch, { type: 'event_msg', timestamp: new Date(began + 1).toISOString(), payload: { type: 'task_complete', turn_id: 'business-native', started_at: began, last_agent_message: reply } }, 1);
    const done = current();
    assert.equal(done.turnId, accepted.turnId); assert.equal(done.status.nativeOutputPending, false);
    assert.equal(done.status.checkpointOutcome, 'candidate_complete'); assert.equal(done.status.checkpointSummary, '用户原目标已完成');
    assert.equal(done.status.taskReportObjectId, accepted.status.taskReportObjectId);
    assert.equal(store.read(done.status.taskReportObjectId).data.availability, 'available');
    assert.equal(store.listRunStates({ projectId: run.projectId, pendingConsumer: true }).items.length, 1);
    const client = new RunLifecycleClient((operation, input) => ops({ operation, input })); const ref = runStatusReference(project, 1);
    assert.equal((await client.readData(runDataReference(ref, 'output'), await client.readStatus(ref, done.revision))).toString('utf8'), reply);
  } finally { await ops.close(); store.close(); }
});

for (const close of [false, true]) test(close ? 'a dead native owner preserves the accepted business receipt and final observed workspace after restart' : 'the next checkpoint drains a committed native reply before advancing its original turn', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-native-pending-recovery-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); const codexHome = path.join(base, 'codex'); fs.mkdirSync(project);
  let store = new UnifiedDataStore(root); let ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const nonce = crypto.randomBytes(32).toString('hex'); const sessionId = crypto.randomUUID();
    const run = await call('prepare_run', { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '原目标', command: 'codex', userMessage: '原目标', metadata: { interactiveSession: true, sessionProvider: 'codex', bindingNonce: nonce }, idempotencyKey: 'pending-prepare' });
    const scope = { projectId: run.projectId, executionLogId: 1 };
    await call('write_run_binding', { ...scope, generation: run.generation, expectedHeadRevision: 0, seed: { runId: '1', provider: 'codex', workspaceRoot: project, cliPath: 'codex', bindingNonce: nonce, method: 'transcript_correlated_compat', contract: 'compatibility', createdAt: run.status.startedAt, providerContext: { codex: { codexHome } } }, idempotencyKey: 'pending-seed' });
    let state = await call('read_run_state', scope);
    await call('claim_run', { ...scope, expectedRevision: state.revision, ...(close ? {} : { agentPid: process.pid }), idempotencyKey: 'pending-owner' });
    const began = new Date(Date.parse(run.status.startedAt) + 1).toISOString(); const date = new Date(began);
    const directory = path.join(codexHome, 'sessions', String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')); fs.mkdirSync(directory, { recursive: true });
    const transcript = path.join(directory, `rollout-${sessionId}.jsonl`);
    const rows = [{ type: 'session_meta', timestamp: began, payload: { id: sessionId, cwd: project, timestamp: began } }, { type: 'response_item', timestamp: began, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `SoloMap binding nonce: ${nonce}.` }] } }, { type: 'event_msg', timestamp: began, payload: { type: 'task_started', turn_id: 'pending-native', started_at: began } }];
    fs.writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const { RunNativeObserver } = require('../out/runNativeObserver.js');
    await new RunNativeObserver(store).observe(store.readRunCheckpointState(run.projectId, 1));
    state = store.readRunCheckpointState(run.projectId, 1);
    const report = { schemaVersion: 1, summary: '正式交付已保存', unmetRequirements: [], decisions: [], corrections: [], verification: [], commits: [], experienceUsage: [], lessons: [] };
    const accepted = await call('checkpoint_run', { ...scope, generation: state.generation, proof: state.proof, expectedRevision: state.revision, expectedTurnId: state.turnId, action: 'complete', outcome: 'candidate_complete', summary: '原目标完成', report, idempotencyKey: 'pending-business' });
    fs.writeFileSync(path.join(project, 'last-result.txt'), 'accepted result after business receipt');
    if (close) {
      await ops.close(); store.close(); store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store);
      await call('recover_run_executions', {});
      const closed = await call('read_run_state', scope);
      assert.equal(closed.turnId, accepted.turnId); assert.equal(closed.status.nativeOutputPending, false);
      assert.equal(closed.status.interactiveSessionClosed, true); assert.equal(closed.status.checkpointOutcome, 'candidate_complete');
      assert.equal(closed.status.taskReportObjectId, accepted.status.taskReportObjectId);
      const final = store.readRunDocument(run.projectId, 1, workspaceDocumentPurpose(accepted.turnId, 'after'));
      assert.ok(JSON.parse(Buffer.from(final.bytes, 'base64').toString())['last-result.txt'], 'recovery must capture accepted changes after an early business receipt');
      assert.equal(store.recoverableRunStates().items.length, 0);
      assert.equal(store.listRunStates({ projectId: run.projectId, pendingConsumer: true }).items.length, 1);
    } else {
      fs.appendFileSync(transcript, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete', turn_id: 'pending-native', started_at: began, last_agent_message: '第一轮完整机器回复' } }) + '\n');
      const intent = { ...scope, generation: accepted.generation, proof: state.proof, expectedRevision: accepted.revision, expectedTurnId: accepted.turnId, action: 'start', message: '第二轮原目标', idempotencyKey: 'pending-next' };
      await assert.rejects(call('checkpoint_run', intent), /revision_conflict/, 'draining the native source must expose a fresh CAS revision');
      const sealed = await call('read_run_state', scope);
      assert.equal(sealed.turnId, accepted.turnId); assert.equal(sealed.status.nativeOutputPending, false);
      const next = await call('checkpoint_run', { ...intent, expectedRevision: sealed.revision });
      assert.notEqual(next.turnId, accepted.turnId); assert.equal(store.read(accepted.turnId).data.outcome, 'candidate_complete');
      assert.equal(store.listRunStates({ projectId: run.projectId, pendingConsumer: true }).items.length, 1);
      assert.deepEqual(await call('checkpoint_run', { ...intent, expectedRevision: sealed.revision }), next);
    }
  } finally { await ops.close(); store.close(); }
});
