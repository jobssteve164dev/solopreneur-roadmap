const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');

async function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-turn-journal-'));
  const root = path.join(base, '.solomap-global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  const registered = await call('register_project', { root: project });
  return { base, root, project, store, call, projectId: registered.projectId, async close() { await ops.close(); store.close(); } };
}
function prepare(root, executionLogId = 17) {
  return { root, executionLogId, nodeId: '__solo__', runKind: 'solo', prompt: '完整任务', command: 'codex', userMessage: '用户目标', metadata: { interactiveSession: true, agentCli: 'codex', commandPreview: 'codex [fresh]' }, idempotencyKey: `journal-prepare:${executionLogId}` };
}

test('a prepared run binds its existing execution record to the actual turn and rolls back conflicting ownership', async () => {
  const f = await fixture();
  try {
    await f.call('append_project_journal', { root: f.project, executionLogId: 17, idempotencyKey: 'existing-record', entry: { nodeId: '__solo__', timestamp: '2026-10-09T00:00:00Z', output: 'existing full raw text', status: 'Running' } });
    const run = await f.call('prepare_run', prepare(f.project));
    const journal = await f.call('read_run_turn_journal', { projectId: run.projectId, executionLogId: 17, turnId: run.turnId });
    assert.equal(journal.executionLogId, 17); assert.equal(journal.turnId, run.turnId);
    assert.equal(journal.entry.output, 'existing full raw text');
    assert.equal(run.status.journalExecutionLogId, 17);
    await f.call('append_project_journal', { root: f.project, executionLogId: 18, idempotencyKey: 'other-node-record', entry: { nodeId: 'other-node', timestamp: '2026-10-09T00:00:00Z', output: 'unrelated', status: 'Completed' } });
    await assert.rejects(f.call('prepare_run', prepare(f.project, 18)), /execution_identity_conflict/);
    await assert.rejects(f.call('read_run_state', { projectId: run.projectId, executionLogId: 18 }), /run_missing/);
    assert.equal(f.store.search({ scope: run.projectId, kinds: ['task'], query: '用户目标' }).items.length, 1);
  } finally { await f.close(); }
});

test('concurrent start observations create one durable journal per turn and replay keeps the original journal identity', async () => {
  const f = await fixture();
  try {
    const run = await f.call('prepare_run', prepare(f.project));
    const scope = { projectId: run.projectId, executionLogId: 17, generation: run.generation, proof: run.proof };
    const first = await f.call('checkpoint_run', { ...scope, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'partial', summary: '第一轮', idempotencyKey: 'journal-first-complete' });
    const settledJournal = await f.call('read_run_turn_journal', { ...scope, turnId: run.turnId });
    assert.equal(settledJournal.entry.status, 'In Progress');
    assert.match(settledJournal.entry.output, /第一轮/);
    const start = { ...scope, expectedRevision: first.revision, expectedTurnId: first.turnId, action: 'start', message: '第二轮补充', idempotencyKey: 'journal-second-start' };
    const starts = await Promise.all(Array.from({ length: 8 }, () => f.call('checkpoint_run', start)));
    const second = starts[0]; assert.equal(second.status.journalExecutionLogId, 18);
    await assert.rejects(f.call('prepare_run', prepare(f.project, 18)), /execution_identity_conflict/);
    assert.ok(starts.every(value => value.turnId === second.turnId && value.status.journalExecutionLogId === 18));
    const done = await f.call('checkpoint_run', { ...scope, expectedRevision: second.revision, expectedTurnId: second.turnId, action: 'complete', outcome: 'partial', summary: '第二轮', idempotencyKey: 'journal-second-complete' });
    const third = await f.call('checkpoint_run', { ...scope, expectedRevision: done.revision, expectedTurnId: done.turnId, action: 'start', message: '第三轮', idempotencyKey: 'journal-third-start' });
    assert.equal(third.status.journalExecutionLogId, 19);
    const replay = await f.call('checkpoint_run', start);
    assert.equal(replay.status.journalExecutionLogId, 18); assert.equal(replay.turnId, second.turnId);
    const history = await f.call('read_project_journal', { root: f.project }); assert.equal(history.logs.length, 3);
    assert.match(history.logs.find(entry => entry.id === 18).output, /第二轮补充/);
    assert.equal((await f.call('read_run_turn_journal', { ...scope, turnId: run.turnId })).executionLogId, 17);
    await assert.rejects(f.call('patch_run_state', { ...scope, expectedRevision: third.revision, patch: { journalExecutionLogId: 999 }, idempotencyKey: 'journal-identity-forgery' }), /invalid_run_patch/);
    const other = await f.call('prepare_run', prepare(f.project, 20));
    await assert.rejects(f.call('read_run_turn_journal', { ...scope, turnId: other.turnId }), /run_turn_mismatch/);
    await assert.rejects(f.call('checkpoint_run', { ...scope, expectedRevision: third.revision, expectedTurnId: second.turnId, action: 'complete', outcome: 'partial', summary: '迟到', idempotencyKey: 'late-journal-complete' }), /checkpoint_turn_conflict/);
    assert.equal((await f.call('read_project_journal', { root: f.project })).logs.length, 4);
  } finally { await f.close(); }
  const restarted = new UnifiedDataStore(f.root); const ops = createRuntimeDataOperations(restarted);
  try {
    const current = await ops({ operation: 'read_run_state', input: { projectId: f.projectId, executionLogId: 17 } });
    assert.equal(current.status.journalExecutionLogId, 19);
    assert.deepEqual(fs.readdirSync(path.join(f.project, '.solopreneur')), ['project.json']);
  } finally { await ops.close(); restarted.close(); }
});
