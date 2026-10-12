const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { RunLifecycleClient, readConversationLogSnapshot } = require('../out/runLifecycleClient.js');

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-run-lifecycle-'));
  const root = path.join(base, '.solomap-global');
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  const store = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(store);
  return { base, root, project, store, operations, call: (operation, input) => operations({ operation, input }) };
}
function request(project, executionLogId = 1) {
  return { root: project, executionLogId, nodeId: '__solo__', runKind: 'solo', prompt: '完整任务输入\n原始证据', command: 'codex', userMessage: '完成用户目标', status: 'Running', idempotencyKey: `prepare:${project}:${executionLogId}` };
}

test('expanded conversation logs read every fixed-turn stdout and stderr byte from the unified database', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', request(f.project));
    const stdout = Buffer.from('前段🌿'.repeat(12000) + '\n末尾');
    const stderr = Buffer.from('错误输出\n仍需保留');
    const first = stdout.subarray(0, 65535), second = stdout.subarray(65535);
    await f.call('append_run_log', { projectId: run.projectId, executionLogId: 1, generation: run.generation, stream: 'stdout', sequence: 0, offset: 0, bytes: first.toString('base64'), idempotencyKey: 'full-stdout-0' });
    await f.call('append_run_log', { projectId: run.projectId, executionLogId: 1, generation: run.generation, stream: 'stdout', sequence: 1, offset: first.length, bytes: second.toString('base64'), idempotencyKey: 'full-stdout-1' });
    await f.call('append_run_log', { projectId: run.projectId, executionLogId: 1, generation: run.generation, stream: 'stderr', sequence: 0, offset: 0, bytes: stderr.toString('base64'), idempotencyKey: 'full-stderr' });
    const client = new RunLifecycleClient((operation, input) => f.operations({ operation, input }), f.root);
    const snapshot = await readConversationLogSnapshot(client, f.project, 1, { runId: run.runId, turnId: run.turnId, revision: run.revision, nodeId: '__solo__' });
    assert.deepEqual(snapshot.stdout, stdout);
    assert.deepEqual(snapshot.stderr, stderr);
    await assert.rejects(readConversationLogSnapshot(client, f.project, 1, { runId: 'late-source' }), /run_log_source_changed/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('linked Solo conversation logs validate their durable source node and remain readable from the linked step', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', request(f.project));
    const stdout = Buffer.from('关联后的完整 Solo 输出🌿');
    await f.call('append_run_log', { projectId: run.projectId, executionLogId: 1, generation: run.generation, stream: 'stdout', sequence: 0, offset: 0, bytes: stdout.toString('base64'), idempotencyKey: 'linked-solo-output' });
    await f.call('link_project_journal', { root: f.project, executionLogId: 1, nodeId: 'step-1', linkedAt: '2026-10-11T12:00:00.000Z' });
    const client = new RunLifecycleClient((operation, input) => f.operations({ operation, input }), f.root);
    const snapshot = await readConversationLogSnapshot(client, f.project, 1, { runId: run.runId, turnId: run.turnId, nodeId: 'step-1' });
    assert.deepEqual(snapshot.stdout, stdout);
    assert.equal(snapshot.nodeId, '__solo__');
  } finally { await f.operations.close(); f.store.close(); }
});

test('historical output-only conversations expose their complete output as stdout', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', request(f.project));
    const output = Buffer.from('迁移历史完整输出🌿\n'.repeat(7000));
    const contentId = f.store.putContent(output, 'application/octet-stream', 'binary');
    f.store.db.run('INSERT INTO log_chunks VALUES(?,?,?,?,?,?)', [run.runId, 'output', 0, contentId, Date.now(), 0]);
    const client = new RunLifecycleClient((operation, input) => f.operations({ operation, input }), f.root);
    const snapshot = await readConversationLogSnapshot(client, f.project, 1, { runId: run.runId, turnId: run.turnId, nodeId: '__solo__' });
    assert.deepEqual(snapshot.stdout, output);
    assert.deepEqual(snapshot.stderr, Buffer.alloc(0));
  } finally { await f.operations.close(); f.store.close(); }
});

test('conversation log snapshots keep each historical turn inside its recorded byte range', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', request(f.project));
    const first = Buffer.from('第一轮完整输出🌿\n'.repeat(7000));
    await f.call('append_run_log', { projectId: run.projectId, executionLogId: 1, generation: run.generation, stream: 'stdout', sequence: 0, offset: 0, bytes: first.toString('base64'), idempotencyKey: 'turn-one-log' });
    const completed = await f.call('checkpoint_run', { projectId: run.projectId, executionLogId: 1, generation: run.generation, proof: run.proof, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'partial', summary: '第一轮完成', idempotencyKey: 'turn-one-complete' });
    const started = await f.call('checkpoint_run', { projectId: run.projectId, executionLogId: 1, generation: run.generation, proof: run.proof, expectedRevision: completed.revision, expectedTurnId: completed.turnId, action: 'start', message: '开始第二轮', idempotencyKey: 'turn-two-start' });
    const second = Buffer.from('第二轮输出\n'.repeat(3000));
    await f.call('append_run_log', { projectId: run.projectId, executionLogId: 1, generation: run.generation, stream: 'stdout', sequence: 1, offset: first.length, bytes: second.toString('base64'), idempotencyKey: 'turn-two-log' });
    const secondJournalId = f.store.readRunTurnJournal(run.projectId, 1, started.turnId).executionLogId;
    const client = new RunLifecycleClient((operation, input) => f.operations({ operation, input }), f.root);
    const continuation = await client.findConversation(f.project, 1);
    const historical = await readConversationLogSnapshot(client, f.project, 1, { runId: run.runId, turnId: run.turnId });
    const current = await readConversationLogSnapshot(client, f.project, secondJournalId, { runId: run.runId, turnId: started.turnId });
    assert.equal(continuation.turnId, run.turnId, 'journal projection keeps the selected historical turn');
    assert.equal(continuation.status.turnId, started.turnId, 'lifecycle state remains on the current turn');
    assert.equal(continuation.revision, started.revision);
    assert.deepEqual(historical.stdout, first);
    assert.deepEqual(current.stdout, second);
  } finally { await f.operations.close(); f.store.close(); }
});

test('dead maintenance owner recovery retains its full receipt before settling and reopening', async () => {
  const f = fixture();
  let closed = false;
  const resultPath = path.join(f.root, 'tmp', 'owned-install', 'result.json');
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  const bytes = Buffer.from(JSON.stringify({ success: true, detail: '已安装完整内容🌿'.repeat(10000) }) + '\n');
  try {
    const run = await f.call('prepare_run', { ...request(f.project), runKind: 'skill_install', metadata: { maintenanceResultPath: resultPath } });
    const claimed = await f.call('claim_run', { root: f.project, executionLogId: 1, expectedRevision: run.revision, idempotencyKey: 'interrupted-maintenance-owner' });
    await f.call('patch_run_state', { root: f.project, executionLogId: 1, generation: claimed.generation, expectedRevision: claimed.revision,
      patch: { maintenanceResultGeneration: claimed.generation, maintenanceResultBaseline: null }, idempotencyKey: 'maintenance-started-without-receipt' });
    fs.writeFileSync(resultPath, bytes);
    await new (require('../out/runRecovery.js').RunRecovery)(f.store).recover();
    const purpose = `maintenance_result_${claimed.generation}`;
    const receipt = await f.call('read_run_document', { root: f.project, executionLogId: 1, purpose });
    assert.ok(receipt, 'recovery must capture the completed external result before marking the interrupted process');
    assert.deepEqual(Buffer.from(receipt.bytes, 'base64'), bytes);
    const state = await f.call('read_run_state', { root: f.project, executionLogId: 1 });
    assert.equal(state.status.status, 'Failed', 'a missing host exit receipt cannot invent a successful process exit');
    await f.operations.close(); f.store.close(); closed = true;
    const reopened = new UnifiedDataStore(f.root);
    try { assert.deepEqual(reopened.readRunDocument(run.projectId, 1, purpose), receipt); }
    finally { reopened.close(); }
  } finally { if (!closed) { await f.operations.close(); f.store.close(); } }
});

test('dead maintenance recovery seals invalid evidence with its exact error', async () => {
  const f = fixture();
  const resultPath = path.join(f.root, 'tmp', 'invalid-install', 'result.json');
  try {
    const run = await f.call('prepare_run', { ...request(f.project), runKind: 'mcp_install', metadata: { maintenanceResultPath: resultPath } });
    const claimed = await f.call('claim_run', { root: f.project, executionLogId: 1, expectedRevision: run.revision, idempotencyKey: 'invalid-maintenance-owner' });
    await f.call('patch_run_state', { root: f.project, executionLogId: 1, generation: claimed.generation, expectedRevision: claimed.revision,
      patch: { maintenanceResultGeneration: claimed.generation, maintenanceResultBaseline: null }, idempotencyKey: 'invalid-maintenance-started' });
    fs.mkdirSync(resultPath, { recursive: true });
    await new (require('../out/runRecovery.js').RunRecovery)(f.store).recover();
    const state = await f.call('read_run_state', { root: f.project, executionLogId: 1 });
    assert.equal(state.status.status, 'Failed'); assert.match(state.status.checkpointSummary, /capability_attachment_path_invalid/);
    const log = await f.call('read_run_log', { root: f.project, executionLogId: 1, stream: 'stderr', offset: 0 });
    assert.match(Buffer.from(log.bytes, 'base64').toString(), /capability_attachment_path_invalid/);
    assert.equal(f.store.recoverableRunStates().items.length, 0);
  } finally { await f.operations.close(); f.store.close(); }
});

test('an accepted checkpoint replays its original receipt after the project moves and rejects a changed intent', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', request(f.project));
    const intent = { projectId: run.projectId, executionLogId: 1, generation: run.generation, proof: run.proof, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'partial', summary: '实际已提交结果', idempotencyKey: 'moved-checkpoint-result' };
    const completed = await f.call('checkpoint_run', intent);
    fs.renameSync(f.project, path.join(f.base, 'moved-project'));
    const replay = await f.call('checkpoint_run', intent);
    assert.deepEqual(replay.receipt, completed.receipt); assert.equal(replay.turnId, completed.turnId);
    await assert.rejects(f.call('checkpoint_run', { ...intent, summary: '同键另一结果' }), /idempotency_conflict/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('checkpoint commits full workspace evidence with its turn and preserves it on replay after files change', async () => {
  const f = fixture();
  try {
    const { snapshotWorkspace, workspaceDocumentPurpose } = require('../out/runWorkspace.js');
    fs.writeFileSync(path.join(f.project, 'work.txt'), 'before');
    const run = await f.call('prepare_run', request(f.project));
    await f.call('write_run_document', { projectId: run.projectId, executionLogId: 1, generation: run.generation, purpose: workspaceDocumentPurpose(run.turnId, 'before'), bytes: Buffer.from(JSON.stringify(await snapshotWorkspace(f.project))).toString('base64'), mimeType: 'application/json', expectedRevision: 0, idempotencyKey: 'baseline' });
    fs.writeFileSync(path.join(f.project, 'work.txt'), 'longer changed content');
    const intent = { root: f.project, executionLogId: 1, generation: run.generation, proof: run.proof, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'partial', summary: '保存结果', idempotencyKey: 'complete-with-workspace' };
    const complete = await f.call('checkpoint_run', intent);
    const changes = await f.call('read_run_document', { root: f.project, executionLogId: 1, purpose: workspaceDocumentPurpose(run.turnId, 'changes') });
    assert.ok(changes, 'workspace changes must commit with completion');
    assert.equal(Buffer.from(changes.bytes, 'base64').toString(), 'M work.txt');
    assert.equal(complete.status.workspaceChangesObjectId, changes.objectId);
    assert.match((await f.call('read_run_turn_journal', { root: f.project, executionLogId: 1 })).entry.output, /M work\.txt/);
    fs.writeFileSync(path.join(f.project, 'late.txt'), 'late');
    const replay = await f.call('checkpoint_run', { ...intent, expectedRevision: complete.revision });
    assert.equal(replay.receipt.committedSequence, complete.receipt.committedSequence);
    assert.deepEqual(await f.call('read_run_document', { root: f.project, executionLogId: 1, purpose: workspaceDocumentPurpose(run.turnId, 'changes') }), changes);
    const started = await f.call('checkpoint_run', { ...intent, expectedRevision: complete.revision, action: 'start', message: '下一轮', idempotencyKey: 'new-workspace-turn' });
    const baseline = await f.call('read_run_document', { root: f.project, executionLogId: 1, purpose: workspaceDocumentPurpose(started.turnId, 'before') });
    assert.ok(JSON.parse(Buffer.from(baseline.bytes, 'base64')).hasOwnProperty('late.txt'));
    const states = await f.call('read_run_state', { root: f.project, executionLogId: 1 });
    await assert.rejects(f.call('checkpoint_run', { ...intent, expectedRevision: states.revision, idempotencyKey: 'stale-workspace-completion' }), /checkpoint_turn_conflict/);
    assert.equal(await f.call('read_run_document', { root: f.project, executionLogId: 1, purpose: workspaceDocumentPurpose(started.turnId, 'changes') }), null);
    assert.deepEqual(fs.readdirSync(path.join(f.project, '.solopreneur')), ['project.json']);
  } finally { await f.operations.close(); f.store.close(); }
});

test('the host obtains the complete execution plan and writes logs by registered identity without resolving the filesystem again', async () => {
  const f = fixture();
  try {
    const prepared = await f.call('prepare_run', request(f.project));
    const plan = await f.call('read_run_execution_plan', { projectId: prepared.projectId, executionLogId: 1 });
    assert.equal(plan.command, 'codex');
    assert.equal(plan.prompt, '完整任务输入\n原始证据');
    assert.equal(plan.proof, prepared.proof);
    const append = await f.call('append_run_log', { projectId: prepared.projectId, executionLogId: 1, generation: prepared.generation, stream: 'stdout', sequence: 0, offset: 0, bytes: Buffer.from('all output').toString('base64'), idempotencyKey: 'registered-log' });
    assert.equal(append.totalBytes, 10);
    const session = await f.call('open_mcp_session', { projectId: prepared.projectId });
    await assert.rejects(f.operations({ operation: 'read_run_execution_plan', input: { projectId: prepared.projectId, executionLogId: 1 }, sessionToken: session.sessionToken }), /action_denied/);
    await assert.rejects(f.call('read_run_execution_plan', { projectId: prepared.runId, executionLogId: 1 }), /project_scope_required/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('checkpoint replay ignores a refreshed CAS revision after the original intent already committed', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', request(f.project));
    const input = { root: f.project, executionLogId: 1, generation: run.generation, proof: run.proof, expectedRevision: run.revision, action: 'complete', outcome: 'partial', summary: '已保存本轮结果', idempotencyKey: 'one-completion' };
    const settled = await f.call('checkpoint_run', input);
    const replay = await f.call('checkpoint_run', { ...input, expectedRevision: settled.revision });
    assert.equal(replay.receipt.committedSequence, settled.receipt.committedSequence);
    assert.equal(replay.status.checkpointSequence, 1);
  } finally { await f.operations.close(); f.store.close(); }
});

test('a subsequent turn remains recoverable after the preceding checkpoint supplied an exit code', async () => {
  const f = fixture();
  try {
    const prepared = await f.call('prepare_run', { ...request(f.project), metadata: { interactiveSession: true } });
    const identity = { projectId: prepared.projectId, executionLogId: 1 };
    const claimed = await f.call('claim_run', { ...identity, expectedRevision: prepared.revision, idempotencyKey: 'recovery-owner' });
    const complete = await f.call('checkpoint_run', { ...identity, generation: claimed.generation, proof: claimed.proof, expectedRevision: claimed.revision, expectedTurnId: claimed.turnId, action: 'complete', outcome: 'partial', summary: '第一轮已记录', exitCode: 0, idempotencyKey: 'recovery-first-complete' });
    const started = await f.call('checkpoint_run', { ...identity, generation: claimed.generation, proof: claimed.proof, expectedRevision: complete.revision, expectedTurnId: complete.turnId, action: 'start', message: '继续执行', idempotencyKey: 'recovery-second-start' });
    assert.ok(f.store.recoverableRunStates().items.some(run => run.runId === started.runId), 'new turn must restore durable recovery registration');
    await f.call('recover_run_executions', {});
    const recovered = await f.call('read_run_state', identity);
    assert.equal(recovered.turnId, started.turnId); assert.equal(recovered.status.status, 'Failed');
    assert.equal(recovered.status.checkpointOutcome, 'failed');
    const first = f.store.read(complete.turnId); assert.equal(first.data.outcome, 'partial');
  } finally { await f.operations.close(); f.store.close(); }
});

test('a closed session refuses a new start while replaying an already committed start without reopening it', async () => {
  const f = fixture();
  try {
    const prepared = await f.call('prepare_run', { ...request(f.project), metadata: { interactiveSession: true } });
    const identity = { projectId: prepared.projectId, executionLogId: 1, generation: prepared.generation, proof: prepared.proof };
    const complete = await f.call('checkpoint_run', { ...identity, expectedRevision: prepared.revision, expectedTurnId: prepared.turnId, action: 'complete', outcome: 'partial', summary: '已记录', idempotencyKey: 'closed-first-complete' });
    const startInput = { ...identity, expectedRevision: complete.revision, expectedTurnId: complete.turnId, action: 'start', message: '第二轮', idempotencyKey: 'closed-accepted-start' };
    const started = await f.call('checkpoint_run', startInput);
    const closed = await f.call('checkpoint_run', { ...identity, expectedRevision: started.revision, expectedTurnId: started.turnId, action: 'session-close', exitCode: 0, idempotencyKey: 'closed-session-boundary' });
    await assert.rejects(f.call('checkpoint_run', { ...identity, expectedRevision: closed.revision, expectedTurnId: closed.turnId, action: 'start', message: '迟到的开始请求', idempotencyKey: 'closed-late-start' }), /session_already_closed/);
    const replay = await f.call('checkpoint_run', startInput);
    assert.equal(replay.receipt.committedSequence, started.receipt.committedSequence); assert.equal(replay.turnId, started.turnId);
    const actual = await f.call('read_run_state', identity);
    assert.equal(actual.revision, closed.revision); assert.equal(actual.status.interactiveSessionClosed, true);
    assert.ok(actual.status.finishedAt); assert.equal(actual.status.status, 'Failed');
  } finally { await f.operations.close(); f.store.close(); }
});

test('a settled interactive turn with an exit code stays registered until its dead session is closed', async () => {
  const f = fixture();
  try {
    const prepared = await f.call('prepare_run', { ...request(f.project), metadata: { interactiveSession: true } });
    const identity = { projectId: prepared.projectId, executionLogId: 1 };
    const claimed = await f.call('claim_run', { ...identity, expectedRevision: prepared.revision, idempotencyKey: 'settled-session-owner' });
    const complete = await f.call('checkpoint_run', { ...identity, generation: claimed.generation, proof: claimed.proof, expectedRevision: claimed.revision, expectedTurnId: claimed.turnId, action: 'complete', outcome: 'partial', summary: '结果已保留', exitCode: 0, idempotencyKey: 'settled-session-result' });
    assert.ok(f.store.recoverableRunStates().items.some(run => run.runId === complete.runId));
    await f.call('recover_run_executions', {});
    const closed = await f.call('read_run_state', identity);
    assert.equal(closed.status.interactiveSessionClosed, true);
    assert.equal(closed.turnId, complete.turnId); assert.equal(closed.status.checkpointSummary, '结果已保留');
    assert.equal(f.store.recoverableRunStates().items.length, 0);
  } finally { await f.operations.close(); f.store.close(); }
});

test('closed sessions reject state and input resurrection and late completion without changing their accepted result', async () => {
  const f = fixture();
  try {
    const prepared = await f.call('prepare_run', { ...request(f.project), metadata: { interactiveSession: true } });
    const identity = { projectId: prepared.projectId, executionLogId: 1, generation: prepared.generation, proof: prepared.proof };
    const completeInput = { ...identity, expectedRevision: prepared.revision, expectedTurnId: prepared.turnId, action: 'complete', outcome: 'partial', summary: '已提交结果', idempotencyKey: 'closed-result' };
    const complete = await f.call('checkpoint_run', completeInput);
    const closed = await f.call('checkpoint_run', { ...identity, expectedRevision: complete.revision, expectedTurnId: complete.turnId, action: 'session-close', exitCode: 0, idempotencyKey: 'closed-result-session' });
    const scope = { ...identity, expectedRevision: closed.revision };
    for (const patch of [{ status: 'Waiting' }, { status: 'Running' }, { interactiveSessionClosed: false }, { finishedAt: '' }]) {
      await assert.rejects(f.call('patch_run_state', { ...scope, patch, idempotencyKey: `closed-state:${JSON.stringify(patch)}` }), /session_already_closed/);
    }
    await assert.rejects(f.call('patch_run_inputs', { ...scope, status: 'Running', idempotencyKey: 'closed-input-resurrection' }), /session_already_closed/);
    await assert.rejects(f.call('checkpoint_run', { ...completeInput, expectedRevision: closed.revision, idempotencyKey: 'closed-late-completion' }), /session_already_closed/);
    const replay = await f.call('checkpoint_run', completeInput);
    assert.equal(replay.receipt.committedSequence, complete.receipt.committedSequence);
    const actual = await f.call('read_run_state', identity);
    assert.equal(actual.revision, closed.revision); assert.equal(actual.turnId, complete.turnId);
    assert.equal(actual.status.checkpointSummary, '已提交结果');
    const processed = await f.call('patch_run_state', { ...scope, patch: { status: 'Processed' }, idempotencyKey: 'closed-consumed-result' });
    assert.equal(processed.status.interactiveSessionClosed, true);
  } finally { await f.operations.close(); f.store.close(); }
});

test('closing an unreported running session settles its existing turn and full workspace evidence', async () => {
  const f = fixture();
  try {
    const { snapshotWorkspace, workspaceDocumentPurpose } = require('../out/runWorkspace.js');
    fs.writeFileSync(path.join(f.project, 'result.txt'), 'before');
    const run = await f.call('prepare_run', { ...request(f.project), metadata: { interactiveSession: true } });
    const identity = { projectId: run.projectId, executionLogId: 1, generation: run.generation, proof: run.proof };
    await f.call('write_run_document', { ...identity, turnId: run.turnId, purpose: workspaceDocumentPurpose(run.turnId, 'before'), bytes: Buffer.from(JSON.stringify(await snapshotWorkspace(f.project))).toString('base64'), mimeType: 'application/json', expectedRevision: 0, idempotencyKey: 'close-running-before' });
    fs.writeFileSync(path.join(f.project, 'result.txt'), 'changed without agent checkpoint');
    const closed = await f.call('checkpoint_run', { ...identity, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'session-close', exitCode: 143, idempotencyKey: 'close-unreported-running' });
    const turn = f.store.read(run.turnId);
    assert.equal(turn.data.outcome, 'failed'); assert.ok(turn.data.finished_at);
    assert.equal(closed.status.status, 'Failed'); assert.equal(closed.turnId, run.turnId);
    assert.equal(closed.status.failureCode, 'checkpoint_missing'); assert.equal(closed.status.interactiveSessionClosed, true);
    const changes = await f.call('read_run_document', { ...identity, purpose: workspaceDocumentPurpose(run.turnId, 'changes') });
    assert.equal(Buffer.from(changes.bytes, 'base64').toString(), 'M result.txt');
    const report = f.store.read(closed.status.taskReportObjectId); assert.equal(report.data.availability, 'missing');
  } finally { await f.operations.close(); f.store.close(); }
});

test('dead-owner recovery records actual workspace changes and their observation source in the settled turn', async () => {
  const f = fixture();
  try {
    const { snapshotWorkspace, workspaceDocumentPurpose } = require('../out/runWorkspace.js');
    fs.writeFileSync(path.join(f.project, 'result.txt'), 'before');
    const prepared = await f.call('prepare_run', request(f.project));
    const identity = { projectId: prepared.projectId, executionLogId: 1 };
    await f.call('write_run_document', { ...identity, generation: prepared.generation, turnId: prepared.turnId, purpose: workspaceDocumentPurpose(prepared.turnId, 'before'), bytes: Buffer.from(JSON.stringify(await snapshotWorkspace(f.project))).toString('base64'), mimeType: 'application/json', expectedRevision: 0, idempotencyKey: 'recovery-workspace-before' });
    await f.call('claim_run', { ...identity, expectedRevision: prepared.revision, idempotencyKey: 'recovery-workspace-claim' });
    fs.writeFileSync(path.join(f.project, 'result.txt'), 'changed before the owner crashed');
    await f.call('recover_run_executions', {});
    const recovered = await f.call('read_run_state', identity);
    assert.equal(recovered.status.status, 'Failed');
    const changes = await f.call('read_run_document', { ...identity, purpose: workspaceDocumentPurpose(prepared.turnId, 'changes') });
    assert.ok(changes, 'recovery must preserve actual changed-file evidence');
    assert.equal(Buffer.from(changes.bytes, 'base64').toString(), 'M result.txt');
    assert.equal(recovered.status.workspaceChangesObjectId, changes.objectId);
    assert.equal(recovered.status.workspaceEvidenceSource, 'recovery');
    assert.ok(Date.parse(recovered.status.workspaceObservedAt) > 0);
  } finally { await f.operations.close(); f.store.close(); }
});

test('a replayed claim returns its committed generation and proof rather than the replacement owner credentials', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', request(f.project));
    const scope = { projectId: run.projectId, executionLogId: 1 };
    const intent = { ...scope, expectedRevision: run.revision, idempotencyKey: 'original-claim' };
    const first = await f.call('claim_run', intent);
    const replacement = await f.call('claim_run', { ...scope, expectedRevision: first.revision, idempotencyKey: 'replacement-claim' });
    assert.notEqual(first.generation, replacement.generation);
    const replay = await f.call('claim_run', intent);
    assert.equal(replay.generation, first.generation); assert.equal(replay.proof, first.proof); assert.equal(replay.revision, replay.receipt.revision);
    await assert.rejects(f.call('checkpoint_run', { ...scope, generation: replay.generation, proof: replay.proof, expectedRevision: replacement.revision, action: 'complete', outcome: 'failed', summary: 'stale result', idempotencyKey: 'stale-replay' }), /run_owner_conflict/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('host status patches update the authoritative exit-code column and preserve its historical revisions', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', request(f.project));
    const identity = { projectId: run.projectId, executionLogId: 1, generation: run.generation };
    const intent = { ...identity, expectedRevision: run.revision, patch: { exitCode: 7 }, idempotencyKey: 'typed-exit-code' };
    const patched = await f.call('patch_run_state', intent);
    assert.equal(patched.status.exitCode, 7, 'accepted exit code must be visible from the authoritative runs row');
    assert.equal((await f.call('read_run_state', identity)).status.exitCode, 7);
    assert.equal((await f.call('read_run_state', { ...identity, revision: run.revision })).status.exitCode, null);
    const replacement = await f.call('patch_run_state', { ...identity, expectedRevision: patched.revision, patch: { exitCode: 13 }, idempotencyKey: 'new-exit-code' });
    assert.equal(replacement.status.exitCode, 13);
    const replay = await f.call('patch_run_state', intent);
    assert.equal(replay.revision, patched.revision); assert.equal(replay.status.exitCode, 7);
    for (const code of [-1, 0.5, 'not an exit code']) await assert.rejects(f.call('patch_run_state', { ...identity, expectedRevision: replacement.revision, patch: { exitCode: code }, idempotencyKey: `invalid-exit:${code}` }), /invalid_run_exit_code/);
    assert.equal((await f.call('read_run_state', identity)).revision, replacement.revision);
  } finally { await f.operations.close(); f.store.close(); }
});

test('prepared inputs and state lists retain complete revisions and reject stale or cross-project input patches', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', { ...request(f.project), status: 'Preparing' });
    const patched = await f.call('patch_run_inputs', { projectId: run.projectId, executionLogId: 1, generation: run.generation, expectedRevision: run.revision, prompt: '原文\n完整报告协议', command: 'updated command', status: 'Running', idempotencyKey: 'prepared-inputs' });
    const plan = await f.call('read_run_execution_plan', { projectId: run.projectId, executionLogId: 1 });
    assert.equal(plan.prompt, '原文\n完整报告协议');
    assert.equal(plan.command, 'updated command');
    assert.equal(f.store.read(run.runId, run.revision).data.prompt_content, request(f.project).prompt);
    await assert.rejects(f.call('patch_run_inputs', { projectId: run.projectId, executionLogId: 1, generation: run.generation, expectedRevision: run.revision, prompt: 'late', idempotencyKey: 'late-input' }), /revision_conflict/);
    const next = await f.call('prepare_run', request(f.project, 2));
    const page = await f.call('list_run_states', { projectId: run.projectId, limit: 1 });
    assert.equal(page.items[0].revision, patched.revision);
    assert.ok(page.nextCursor);
    const rest = await f.call('list_run_states', { projectId: run.projectId, cursor: page.nextCursor, limit: 1 });
    assert.equal(rest.items[0].runId, next.runId);
    assert.equal(rest.nextCursor, null);
    const otherRoot = path.join(f.base, 'private-other'); fs.mkdirSync(otherRoot);
    const otherProject = await f.call('register_project', { root: otherRoot });
    assert.equal((await f.call('list_run_states', { projectId: otherProject.projectId })).items.length, 0);
    await assert.rejects(f.call('patch_run_inputs', { projectId: otherProject.projectId, executionLogId: 1, generation: run.generation, expectedRevision: run.revision, prompt: 'wrong project', idempotencyKey: 'wrong-project-input' }), /run_missing/);
    const ordinary = await f.call('open_mcp_session', { projectId: run.projectId });
    await assert.rejects(f.operations({ operation: 'list_run_states', input: {}, sessionToken: ordinary.sessionToken }), /action_denied/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('run verification replays the same receipt after a lost response and runtime restart', async () => {
  const f = fixture();
  let reopened;
  try {
    const run = await f.call('prepare_run', request(f.project));
    const input = { projectId: run.projectId, executionLogId: 1, claim: 'independent review passed', result: 'pass', evidence: 'review evidence', idempotencyKey: 'verification-lost-response' };
    const first = await f.call('record_run_verification', input);
    await f.operations.close(); f.store.close();
    reopened = UnifiedDataStore.open(f.root);
    const operations = createRuntimeDataOperations(reopened);
    try {
      await new Promise(resolve => setTimeout(resolve, 5));
      const replay = await operations({ operation: 'record_run_verification', input });
      assert.deepEqual(replay, first);
      assert.equal(reopened.rows("SELECT COUNT(*) AS n FROM evidence WHERE type='host_verification'")[0].n, 1);
      assert.equal(reopened.rows('SELECT COUNT(*) AS n FROM verifications')[0].n, 1);
      assert.equal(reopened.read(first.objectId).revision, first.revision);
    } finally { await operations.close(); }
  } finally { if (reopened) reopened.close(); else { await f.operations.close(); f.store.close(); } }
});

test('run documents retain full binary revisions and reject late owners or another project', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', request(f.project));
    const scope = { projectId: run.projectId, executionLogId: 1 };
    const firstBytes = Buffer.from([0, 255, 254, 10]); const nextBytes = Buffer.from('完整实际命令🌿');
    const firstInput = { ...scope, generation: run.generation, purpose: 'actual_command', bytes: firstBytes.toString('base64'), mimeType: 'application/octet-stream', expectedRevision: 0, idempotencyKey: 'first-command' };
    const first = await f.call('write_run_document', firstInput);
    const replay = await f.call('write_run_document', firstInput); assert.equal(replay.committedSequence, first.committedSequence);
    const second = await f.call('write_run_document', { ...scope, generation: run.generation, purpose: 'actual_command', bytes: nextBytes.toString('base64'), mimeType: 'text/plain', expectedRevision: first.revision, idempotencyKey: 'retry-command' });
    assert.equal(second.objectId, first.objectId); assert.equal(second.revision, 2);
    const old = await f.call('read_run_document', { ...scope, purpose: 'actual_command', revision: first.revision });
    const current = await f.call('read_run_document', { ...scope, purpose: 'actual_command' });
    assert.deepEqual(Buffer.from(old.bytes, 'base64'), firstBytes); assert.deepEqual(Buffer.from(current.bytes,'base64'), nextBytes);
    assert.equal(current.revision, 2);
    await assert.rejects(f.call('write_run_document', { ...firstInput, bytes: 'different', idempotencyKey: 'changed-intent' }), /invalid_run_document_bytes/);
    await assert.rejects(f.call('write_run_document', { ...firstInput, idempotencyKey: 'stale-write' }), /revision_conflict/);
    const claimed = await f.call('claim_run', { ...scope, expectedRevision: run.revision, idempotencyKey: 'replacement' });
    await assert.rejects(f.call('write_run_document', { ...firstInput, expectedRevision: 2, idempotencyKey: 'late-document' }), /run_owner_conflict/);
    assert.notEqual(claimed.generation, run.generation);
    const otherRoot = path.join(f.base, 'other-project'); fs.mkdirSync(otherRoot); const other = await f.call('register_project', { root: otherRoot });
    await assert.rejects(f.call('read_run_document', { projectId: other.projectId, executionLogId: 1, purpose: 'actual_command' }), /run_missing/);
    const session = await f.call('open_mcp_session', { projectId: run.projectId });
    await assert.rejects(f.operations({ operation: 'write_run_document', input: firstInput, sessionToken: session.sessionToken }), /action_denied/);
    assert.equal(fs.existsSync(path.join(f.project, '.solopreneur', 'agent-runs')), false);
  } finally { await f.operations.close(); f.store.close(); }
});

test('a prepared task persists domain identity and full input without permanent run files', async () => {
  const f = fixture();
  try {
    const prepared = await f.call('prepare_run', request(f.project));
    const read = await f.call('read_run_state', { root: f.project, executionLogId: 1 });
    assert.equal(read.runId, prepared.runId);
    assert.equal(read.status.status, 'Running');
    assert.equal(read.status.executionLogId, 1);
    assert.equal(f.store.read(read.runId).data.prompt_content, '完整任务输入\n原始证据');
    assert.equal(f.store.read(read.taskId).data.original_request_content, '完成用户目标');
    assert.equal(f.store.read(read.turnId).data.sequence, 1);
    assert.deepEqual(fs.readdirSync(path.join(f.project, '.solopreneur')), ['project.json']);
    const replay = await f.call('prepare_run', request(f.project));
    assert.equal(replay.runId, prepared.runId);
    assert.equal(replay.receipt.committedSequence, prepared.receipt.committedSequence);
    await assert.rejects(f.call('prepare_run', { ...request(f.project), prompt: 'different input' }), /idempotency_conflict/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('binary log chunks retain complete bytes, reject sequence gaps and survive owner restart', async () => {
  const f = fixture();
  let reopened;
  try {
    const prepared = await f.call('prepare_run', request(f.project));
    const bytes = Buffer.from([0, 255, 195, 169, 10]);
    const input = { root: f.project, executionLogId: 1, generation: prepared.generation, stream: 'stdout', sequence: 0, offset: 0, bytes: bytes.toString('base64'), idempotencyKey: 'log:0' };
    await f.call('append_run_log', input);
    await f.call('append_run_log', input);
    await assert.rejects(f.call('append_run_log', { ...input, sequence: 2, offset: 5, idempotencyKey: 'gap' }), /log_sequence_conflict/);
    await assert.rejects(f.call('append_run_log', { ...input, bytes: Buffer.from('changed').toString('base64') }), /idempotency_conflict/);
    await f.operations.close(); f.store.close();
    reopened = UnifiedDataStore.open(f.root);
    const operations = createRuntimeDataOperations(reopened);
    try {
      const page = await operations({ operation: 'read_run_log', input: { root: f.project, executionLogId: 1, stream: 'stdout', offset: 0, limit: 2 } });
      const rest = await operations({ operation: 'read_run_log', input: { root: f.project, executionLogId: 1, stream: 'stdout', offset: 2, limit: 100 } });
      assert.deepEqual(Buffer.concat([Buffer.from(page.bytes, 'base64'), Buffer.from(rest.bytes, 'base64')]), bytes);
      assert.equal(rest.totalBytes, 5);
      assert.equal(rest.nextOffset, null);
    } finally { await operations.close(); }
  } finally { if (reopened) reopened.close(); else { await f.operations.close(); f.store.close(); } }
});

test('checkpoint revisions reject late owners and continuations share task identity across projects without numeric-ID collisions', async () => {
  const f = fixture();
  try {
    const first = await f.call('prepare_run', request(f.project));
    const settled = await f.call('checkpoint_run', { root: f.project, executionLogId: 1, generation: first.generation, proof: first.proof, expectedRevision: first.revision, action: 'complete', outcome: 'partial', summary: '完整结果', idempotencyKey: 'checkpoint:1' });
    assert.equal(settled.status.checkpointOutcome, 'partial');
    const resumed = await f.call('checkpoint_run', { root: f.project, executionLogId: 1, generation: first.generation, proof: first.proof, expectedRevision: settled.revision, action: 'start', message: '继续同一目标', idempotencyKey: 'checkpoint:2' });
    assert.equal(resumed.turnId === settled.turnId, false);
    assert.equal(resumed.taskId, settled.taskId);
    await assert.rejects(f.call('checkpoint_run', { root: f.project, executionLogId: 1, generation: first.generation, proof: first.proof, expectedRevision: settled.revision, action: 'complete', outcome: 'failed', summary: 'late', idempotencyKey: 'late' }), /revision_conflict/);
    const reserved = await f.call('append_project_journal', { root: f.project, idempotencyKey: 'continued-reservation', entry: { nodeId: '__solo__', timestamp: new Date().toISOString(), output: '续聊', status: 'Running' } });
    const continued = await f.call('prepare_run', { ...request(f.project, reserved.executionLogId), parentExecutionLogId: 1, runKind: 'solo_continue' });
    assert.equal(continued.taskId, first.taskId);
    assert.equal(continued.conversationId, first.conversationId);
    const otherProject = path.join(f.base, 'another'); fs.mkdirSync(otherProject);
    const other = await f.call('prepare_run', request(otherProject));
    assert.notEqual(other.runId, first.runId);
    assert.notEqual(other.taskId, first.taskId);
    await assert.rejects(f.call('checkpoint_run', { root: otherProject, executionLogId: 1, generation: first.generation, proof: first.proof, expectedRevision: other.revision, action: 'complete', outcome: 'partial', summary: 'wrong project', idempotencyKey: 'scope' }), /run_proof_denied/);
    const ordinary = await f.call('open_mcp_session', { projectId: first.projectId });
    await assert.rejects(f.operations({ operation: 'checkpoint_run', input: {}, sessionToken: ordinary.sessionToken }), /action_denied/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('run state patches retain omitted fields and historical state while a new owner rejects old writes', async () => {
  const f = fixture();
  try {
    const initial = await f.call('prepare_run', { ...request(f.project), metadata: { terminalName: 'Original terminal', selectedModel: 'chosen' } });
    const patched = await f.call('patch_run_state', { root: f.project, executionLogId: 1, generation: initial.generation, expectedRevision: initial.revision, patch: { terminalName: 'Renamed terminal' }, idempotencyKey: 'terminal' });
    assert.equal(patched.status.selectedModel, 'chosen');
    assert.equal(patched.status.terminalName, 'Renamed terminal');
    const historical = await f.call('read_run_state', { root: f.project, executionLogId: 1, revision: initial.revision });
    assert.equal(historical.status.terminalName, 'Original terminal');
    const claimed = await f.call('claim_run', { root: f.project, executionLogId: 1, expectedRevision: patched.revision, idempotencyKey: 'claim' });
    assert.equal(claimed.generation, initial.generation + 1);
    assert.notEqual(claimed.proof, initial.proof);
    await assert.rejects(f.call('patch_run_state', { root: f.project, executionLogId: 1, generation: initial.generation, expectedRevision: claimed.revision, patch: { status: 'Failed' }, idempotencyKey: 'old-owner' }), /run_owner_conflict/);
    await assert.rejects(f.call('append_run_log', { root: f.project, executionLogId: 1, generation: initial.generation, stream: 'stdout', sequence: 0, offset: 0, bytes: Buffer.from('late').toString('base64'), idempotencyKey: 'late-log' }), /run_owner_conflict/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('native binding revisions persist confirmation and reject concurrent or mismatched confirmation', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', request(f.project));
    const seed = { runId: '1', provider: 'codex', workspaceRoot: f.project, cliPath: 'codex', bindingNonce: 'nonce', method: 'provider_callback', contract: 'official_stable' };
    const created = await f.call('write_run_binding', { root: f.project, executionLogId: 1, generation: run.generation, expectedHeadRevision: 0, seed, idempotencyKey: 'binding-seed' });
    assert.equal(created.headRevision, 1);
    const planned = await f.call('write_run_binding', { root: f.project, executionLogId: 1, generation: run.generation, expectedHeadRevision: 1, revision: { sessionId: 'session-A', method: 'provider_callback', contract: 'official_stable', state: 'planned' }, idempotencyKey: 'binding-planned' });
    assert.equal(planned.headRevision, 2);
    const plannedState = await f.call('read_run_state', { root: f.project, executionLogId: 1 });
    await assert.rejects(f.call('write_run_binding', { root: f.project, executionLogId: 1, generation: run.generation, expectedHeadRevision: 2, confirmSessionId: 'session-B', idempotencyKey: 'bad-confirm' }), /identity_provider_mismatch/);
    const confirmed = await f.call('write_run_binding', { root: f.project, executionLogId: 1, generation: run.generation, expectedHeadRevision: 2, confirmSessionId: 'session-A', evidence: { source: 'native_callback', bytes: 'full evidence' }, idempotencyKey: 'binding-confirmed' });
    assert.equal(confirmed.resumableRevision, 3);
    assert.equal(confirmed.revisions[2].evidence.bytes, 'full evidence');
    const read = await f.call('read_run_binding', { root: f.project, executionLogId: 1 });
    assert.deepEqual(read, confirmed);
    const confirmedState = await f.call('read_run_state', { root: f.project, executionLogId: 1 });
    assert.equal(confirmedState.status.nativeSessionIdIsCurrent, true, 'the formal status must reflect the committed binding immediately');
    assert.equal(confirmedState.status.nativeSessionId, 'session-A');
    assert.equal(confirmedState.status.sessionBindingHeadRevision, 3);
    const fixedPlanned = await f.call('read_run_state', { root: f.project, executionLogId: 1, revision: plannedState.revision });
    assert.notEqual(fixedPlanned.status.nativeSessionIdIsCurrent, true, 'a fixed older status must not acquire a later confirmation');
    const walPath = path.join(f.root, 'solomap.db-wal');
    const walBefore = fs.readFileSync(walPath);
    const replayed = await f.call('write_run_binding', { root: f.project, executionLogId: 1, generation: run.generation, expectedHeadRevision: 2, confirmSessionId: 'session-A', evidence: { source: 'native_callback', bytes: 'full evidence' }, idempotencyKey: 'binding-confirmed' });
    assert.deepEqual(replayed, confirmed);
    assert.deepEqual(fs.readFileSync(walPath), walBefore, 'an unchanged confirmation retry must not write the database again');
    await assert.rejects(f.call('write_run_binding', { root: f.project, executionLogId: 1, generation: run.generation, expectedHeadRevision: 2, confirmSessionId: 'session-A', idempotencyKey: 'concurrent' }), /identity_index_conflict/);
    assert.equal(fs.existsSync(path.join(f.project, '.solopreneur', 'agent-runs')), false);
  } finally { await f.operations.close(); f.store.close(); }
});

test('a conflicting native binding immediately withdraws its current status without rewriting the confirmed snapshot', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', request(f.project));
    const scope = { root: f.project, executionLogId: 1, generation: run.generation };
    await f.call('write_run_binding', { ...scope, expectedHeadRevision: 0, seed: { runId: '1', provider: 'claude', workspaceRoot: f.project, cliPath: 'claude', bindingNonce: 'nonce', method: 'caller_assigned', contract: 'official_stable' }, idempotencyKey: 'conflict-seed' });
    await f.call('write_run_binding', { ...scope, expectedHeadRevision: 1, revision: { sessionId: 'session-A', method: 'caller_assigned', contract: 'official_stable', state: 'planned' }, idempotencyKey: 'conflict-plan' });
    await f.call('write_run_binding', { ...scope, expectedHeadRevision: 2, confirmSessionId: 'session-A', evidence: { source: 'native_callback' }, idempotencyKey: 'conflict-confirm' });
    const current = await f.call('read_run_state', scope);
    // Older hosts persisted this projection separately from the binding.
    const confirmed = await f.call('patch_run_state', { ...scope, expectedRevision: current.revision, patch: { nativeSessionId: 'session-A', nativeSessionIdIsCurrent: true, sessionBindingHeadRevision: 3 }, idempotencyKey: 'older-host-projection' });
    await f.call('write_run_binding', { ...scope, expectedHeadRevision: 3, revision: { supersedesRevision: 3, sessionId: 'different-session', method: 'caller_assigned', contract: 'official_stable', state: 'conflict', errorCode: 'identity_provider_mismatch' }, idempotencyKey: 'conflicting-native-callback' });
    const conflict = await f.call('read_run_state', scope);
    assert.equal(conflict.status.nativeSessionIdIsCurrent, false);
    assert.equal(conflict.status.nativeSessionId, '');
    assert.equal(conflict.status.sessionBindingHeadRevision, 4);
    const fixed = await f.call('read_run_state', { ...scope, revision: confirmed.revision });
    assert.equal(fixed.status.nativeSessionIdIsCurrent, true);
    assert.equal(fixed.status.nativeSessionId, 'session-A');
  } finally { await f.operations.close(); f.store.close(); }
});

test('a native binding cannot use another project location even when execution IDs match', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', request(f.project));
    const otherRoot = path.join(f.base, 'other'); fs.mkdirSync(otherRoot);
    await f.call('prepare_run', request(otherRoot));
    await assert.rejects(f.call('write_run_binding', { root: f.project, executionLogId: 1, generation: run.generation, expectedHeadRevision: 0, seed: { runId: '1', provider: 'codex', workspaceRoot: otherRoot, cliPath: 'codex', bindingNonce: 'nonce', method: 'provider_callback', contract: 'official_stable' }, idempotencyKey: 'wrong-binding-location' }), /identity_workspace_mismatch/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('a replacement wrapper cannot claim an execution while its actual child is still alive', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', request(f.project));
    const registered = await f.call('patch_run_state', { root: f.project, executionLogId: 1, generation: run.generation, expectedRevision: run.revision, patch: { agentPid: 0, agentChildPid: process.pid }, idempotencyKey: 'actual-child' });
    await assert.rejects(f.call('claim_run', { root: f.project, executionLogId: 1, expectedRevision: registered.revision, idempotencyKey: 'wrapper-replacement' }), /run_owner_alive/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('a new log writer receives durable sequence and byte offsets for an existing stream', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', request(f.project));
    await f.call('append_run_log', { projectId: run.projectId, executionLogId: 1, generation: run.generation, stream: 'stdout', sequence: 0, offset: 0, bytes: Buffer.from('before').toString('base64'), idempotencyKey: 'before' });
    const claimed = await f.call('claim_run', { projectId: run.projectId, executionLogId: 1, expectedRevision: run.revision, idempotencyKey: 'new-log-writer' });
    const head = await f.call('read_run_log_head', { projectId: run.projectId, executionLogId: 1, stream: 'stdout' });
    assert.equal(head.nextSequence, 1); assert.equal(head.totalBytes, 6);
    await f.call('append_run_log', { projectId: run.projectId, executionLogId: 1, generation: claimed.generation, stream: 'stdout', sequence: head.nextSequence, offset: head.totalBytes, bytes: Buffer.from('after').toString('base64'), idempotencyKey: 'after' });
    const page = await f.call('read_run_log', { projectId: run.projectId, executionLogId: 1, stream: 'stdout' });
    assert.equal(Buffer.from(page.bytes, 'base64').toString(), 'beforeafter');
  } finally { await f.operations.close(); f.store.close(); }
});

test('a failed preparation can settle its actual turn and cannot be claimed as a new execution', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', { ...request(f.project), status: 'Preparing' });
    const failure = await f.call('checkpoint_run', { projectId: run.projectId, executionLogId: 1, generation: run.generation, proof: run.proof, expectedRevision: run.revision, action: 'complete', outcome: 'failed', summary: 'preparation failed', exitCode: 1, idempotencyKey: 'preparation-failure' });
    assert.equal(failure.status.status, 'Failed');
    assert.equal(failure.status.exitCode, 1);
    await assert.rejects(f.call('claim_run', { projectId: run.projectId, executionLogId: 1, expectedRevision: failure.revision, idempotencyKey: 'completed-redelivery' }), /run_already_finished/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('recovery preserves the full database prompt and unrelated user files without creating temporary inputs', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', request(f.project));
    const scope = { projectId: run.projectId, executionLogId: 1 };
    await f.call('claim_run', { ...scope, expectedRevision: run.revision, idempotencyKey: 'dead-owner' });
    const userFile = path.join(f.project, 'prompt.txt'); fs.writeFileSync(userFile, request(f.project).prompt);
    await f.call('recover_run_executions', {});
    const state = await f.call('read_run_state', scope);
    assert.equal(state.status.status, 'Failed'); assert.match(state.status.checkpointSummary, /中断/);
    assert.equal((await f.call('read_run_execution_plan', scope)).prompt, request(f.project).prompt);
    assert.equal(fs.readFileSync(userFile, 'utf8'), request(f.project).prompt);
    assert.equal(fs.existsSync(path.join(f.root, 'tmp', 'run-inputs')), false);
    const session = await f.call('open_mcp_session', { projectId: run.projectId });
    await assert.rejects(f.operations({ operation: 'recover_run_executions', input: {}, sessionToken: session.sessionToken }), /action_denied/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('recovery keeps another live run and independently settles a dead execution', async () => {
  const f = fixture();
  try {
    const runs = [];
    for (const id of [1, 2]) {
      const run = await f.call('prepare_run', request(f.project, id));
      runs.push(await f.call('claim_run', { projectId: run.projectId, executionLogId: id, expectedRevision: run.revision, ...(id === 1 ? { agentPid: process.pid } : {}), idempotencyKey: `owner:${id}` }));
    }
    await f.call('recover_run_executions', {});
    assert.equal((await f.call('read_run_state', { projectId: runs[0].projectId, executionLogId: 1 })).status.status, 'Running');
    assert.equal((await f.call('read_run_state', { projectId: runs[1].projectId, executionLogId: 2 })).status.status, 'Failed');
    assert.equal(fs.existsSync(path.join(f.root, 'tmp', 'run-inputs')), false);
  } finally { await f.operations.close(); f.store.close(); }
});

test('run control changes and dead-owner recovery reuse the indexed prompt without decoding its full body', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', { ...request(f.project), prompt: '完整大正文🌿\n'.repeat(100000) });
    const promptId = f.store.readMetadata(run.runId).data.prompt_content_id;
    const original = f.store.content.bind(f.store);
    f.store.content = id => { assert.notEqual(id, promptId, 'a control transition must not load the immutable prompt'); return original(id); };
    const scope = { projectId: run.projectId, executionLogId: 1 };
    const patched = await f.call('patch_run_state', { ...scope, generation: run.generation, expectedRevision: run.revision, patch: { terminalName: 'current terminal' }, idempotencyKey: 'terminal' });
    await f.call('claim_run', { ...scope, expectedRevision: patched.revision, idempotencyKey: 'dead-owner' });
    await f.call('recover_run_executions', {});
    assert.equal((await f.call('read_run_state', scope)).status.status, 'Failed');
    f.store.content = original;
    assert.equal(f.store.read(run.runId).data.prompt_content, '完整大正文🌿\n'.repeat(100000));
    assert.ok(f.store.search({ scope: run.projectId, kinds: ['run'], query: '完整大正文' }).items.some(item => item.objectId === run.runId));
  } finally { await f.operations.close(); f.store.close(); }
});

test('a report is tied to the actual run and turn without completing the task or writing learning files', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', request(f.project));
    const report = { schemaVersion: 1, summary: '用户结果', unmetRequirements: [], decisions: [], corrections: [], verification: [], commits: [], experienceUsage: [], lessons: [] };
    const receipt = await f.call('submit_run_report', { root: f.project, executionLogId: 1, turnId: run.turnId, generation: run.generation, report, idempotencyKey: 'report' });
    assert.equal(receipt.availability, 'available');
    const stored = f.store.read(receipt.objectId);
    assert.equal(stored.data.run_id, run.runId);
    assert.equal(stored.data.turn_id, run.turnId);
    assert.deepEqual(JSON.parse(stored.data.content), report);
    assert.equal(f.store.read(run.taskId).data.status, 'active');
    assert.equal(fs.existsSync(path.join(f.project, '.solopreneur', 'agent-runs')), false);
    const replay = await f.call('submit_run_report', { root: f.project, executionLogId: 1, turnId: run.turnId, generation: run.generation, report, idempotencyKey: 'report' });
    assert.equal(replay.objectId, receipt.objectId);
    const invalid = await f.call('submit_run_report', { root: f.project, executionLogId: 1, turnId: run.turnId, generation: run.generation, report: { wrong: true }, idempotencyKey: 'invalid-report' });
    assert.equal(invalid.availability, 'invalid');
    assert.deepEqual(JSON.parse(f.store.read(invalid.objectId).data.content), { wrong: true });
  } finally { await f.operations.close(); f.store.close(); }
});

test('checkpoint and late report submission share one authoritative report head and strip unknown fields', async () => {
  const f = fixture();
  try {
    const run = await f.call('prepare_run', request(f.project));
    const shape = summary => ({ schemaVersion: 1, summary, unmetRequirements: [], decisions: [], corrections: [], verification: [], commits: [], experienceUsage: [], lessons: [], taskId: 'forged-task' });
    const artifact = path.join(f.project, 'artifact.txt');
    fs.writeFileSync(artifact, 'durable output');
    const checkpointReport = { ...shape('checkpoint-A'), decisions: ['x'.repeat(470)], outputs: ['artifact.txt'] };
    const checkpointInput = {
      root: f.project, executionLogId: 1, generation: run.generation, proof: run.proof,
      expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'partial',
      summary: '检查点结果', report: checkpointReport, idempotencyKey: 'one-report-checkpoint'
    };
    const checkpoint = await f.call('checkpoint_run', checkpointInput);
    fs.renameSync(artifact, path.join(f.base, 'retained-artifact.txt'));
    const checkpointReplay = await f.call('checkpoint_run', checkpointInput);
    assert.equal(checkpointReplay.revision, checkpoint.revision, 'the original raw request must replay after its response is lost even when file-based validation changes');
    const firstId = checkpoint.status.taskReportObjectId;
    assert.equal(checkpoint.status.taskReportRevision, 1);
    assert.equal(JSON.parse(f.store.read(firstId).data.content).taskId, undefined);

    const late = await f.call('submit_run_report', {
      root: f.project, executionLogId: 1, generation: run.generation, turnId: run.turnId,
      report: shape('late-B'), idempotencyKey: 'one-report-late'
    });
    assert.equal(late.objectId, firstId, 'late intake must revise the checkpoint report instead of creating another authority');
    assert.equal(late.revision, 2);
    const current = await f.call('read_run_state', { root: f.project, executionLogId: 1 });
    assert.equal(current.status.taskReportObjectId, firstId);
    assert.equal(current.status.taskReportRevision, 2);
    assert.equal(JSON.parse(f.store.read(firstId).data.content).taskId, undefined);
    const sources = f.store.readRegisteredReportSources(run.projectId);
    assert.deepEqual([...new Set(sources.observations.map(item => item.sourceRef.objectId))], [firstId]);
    assert.deepEqual(sources.observations.map(item => item.envelope.report.summary), ['checkpoint-A', 'late-B']);
    assert.equal(sources.reports[0].report.summary, 'late-B');
  } finally { await f.operations.close(); f.store.close(); }
});

test('a live execution cannot lose ownership', async () => {
  const f = fixture();
  try {
    const first = await f.call('prepare_run', { ...request(f.project), metadata: { agentPid: process.pid } });
    await assert.rejects(f.call('claim_run', { root: f.project, executionLogId: 1, expectedRevision: first.revision, idempotencyKey: 'live-claim' }), /run_owner_alive/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('report retries still resolve their original turn after the next turn starts', async () => {
  const f = fixture();
  try {
    const first = await f.call('prepare_run', request(f.project));
    const report = { schemaVersion: 1, summary: '第一轮结果', unmetRequirements: [], decisions: [], corrections: [], verification: [], commits: [], experienceUsage: [], lessons: [] };
    const reportInput = { root: f.project, executionLogId: 1, turnId: first.turnId, generation: first.generation, report, idempotencyKey: 'first-turn-report' };
    const saved = await f.call('submit_run_report', reportInput);
    const reportState = await f.call('read_run_state', { root: f.project, executionLogId: 1 });
    const settled = await f.call('checkpoint_run', { root: f.project, executionLogId: 1, generation: first.generation, proof: first.proof, expectedRevision: reportState.revision, action: 'complete', outcome: 'partial', summary: '第一轮', idempotencyKey: 'first-turn-complete' });
    await f.call('checkpoint_run', { root: f.project, executionLogId: 1, generation: first.generation, proof: first.proof, expectedRevision: settled.revision, action: 'start', message: '第二轮', idempotencyKey: 'second-turn-start' });
    const retried = await f.call('submit_run_report', reportInput);
    assert.equal(retried.objectId, saved.objectId);
    assert.equal(f.store.read(retried.objectId).data.turn_id, first.turnId);
  } finally { await f.operations.close(); f.store.close(); }
});

test('a first-time late report keeps its explicit original turn and rejects another run or a missing turn', async () => {
  const f = fixture();
  try {
    const first = await f.call('prepare_run', request(f.project));
    const settled = await f.call('checkpoint_run', { root: f.project, executionLogId: 1, generation: first.generation, proof: first.proof, expectedRevision: first.revision, action: 'complete', outcome: 'partial', summary: '第一轮结果', idempotencyKey: 'late-report-complete' });
    await f.call('checkpoint_run', { root: f.project, executionLogId: 1, generation: first.generation, proof: first.proof, expectedRevision: settled.revision, action: 'start', message: '第二轮', idempotencyKey: 'late-report-next' });
    const report = { schemaVersion: 1, summary: '第一轮迟到报告', unmetRequirements: [], decisions: [], corrections: [], verification: [], commits: [], experienceUsage: [], lessons: [] };
    const receipt = await f.call('submit_run_report', { projectId: first.projectId, root: f.project, executionLogId: 1, generation: first.generation, turnId: first.turnId, report, idempotencyKey: 'late-report-first-submission' });
    assert.equal(f.store.read(receipt.objectId).data.turn_id, first.turnId);
    const reserved = await f.call('append_project_journal', { root: f.project, idempotencyKey: 'late-other-reservation', entry: { nodeId: '__solo__', timestamp: new Date().toISOString(), output: '另一运行', status: 'Running' } });
    const other = await f.call('prepare_run', request(f.project, reserved.executionLogId));
    await assert.rejects(f.call('submit_run_report', { root: f.project, executionLogId: 1, generation: first.generation, turnId: other.turnId, report, idempotencyKey: 'wrong-run-report' }), /report_turn_denied/);
    await assert.rejects(f.call('submit_run_report', { root: f.project, executionLogId: 1, generation: first.generation, report, idempotencyKey: 'missing-turn-report' }), /report_turn_required/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('a host-observed completion without an Agent start command creates a new turn instead of rewriting the prior turn', async () => {
  const f = fixture();
  try {
    const first = await f.call('prepare_run', request(f.project));
    const settled = await f.call('checkpoint_run', { root: f.project, executionLogId: 1, generation: first.generation, proof: first.proof, expectedRevision: first.revision, action: 'complete', outcome: 'partial', summary: '第一轮原结果', idempotencyKey: 'implicit-first' });
    const waiting = await f.call('patch_run_state', { root: f.project, executionLogId: 1, generation: first.generation, expectedRevision: settled.revision, patch: { status: 'Waiting' }, idempotencyKey: 'waiting' });
    const implicit = await f.call('checkpoint_run', { root: f.project, executionLogId: 1, generation: first.generation, proof: first.proof, expectedRevision: waiting.revision, action: 'complete', outcome: 'partial', message: '新的用户输入', summary: '宿主观测的下一轮结果', idempotencyKey: 'host-completion' });
    assert.notEqual(implicit.turnId, first.turnId);
    assert.equal(f.store.read(first.turnId).data.summary_content, '第一轮原结果');
    assert.equal(f.store.read(implicit.turnId).data.request_content, '新的用户输入');
    assert.equal(implicit.status.checkpointImplicitTurn, true);
  } finally { await f.operations.close(); f.store.close(); }
});
