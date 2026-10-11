const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');

test('delivery polling lists only recoverable queued tasks and keeps active creators and stopped tasks untouched', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-delivery-poll-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const prepare = (id, owner) => call('prepare_run', { root: project, executionLogId: id, nodeId: '__solo__', runKind: 'solo', prompt: `完整任务 ${id}`, command: '', userMessage: '目标', status: 'Preparing', metadata: { interactiveSession: true }, deliveryOwner: owner, launchRequest: { executionLogId: id }, idempotencyKey: `delivery-poll:${id}` });
    const gone = { id: 'closed', pid: 2147483647, birth: 'proc:gone' };
    const queued = await prepare(1, gone);
    const live = await prepare(2, { id: 'active', pid: process.pid, birth: '' });
    const stopped = await prepare(3, gone);
    await call('patch_run_state', { projectId: stopped.projectId, executionLogId: 3, generation: stopped.generation, expectedRevision: stopped.revision, patch: { stopRequested: true }, idempotencyKey: 'stop-delivery-poll' });
    const page = await call('list_run_deliveries', { projectId: queued.projectId, limit: 1 });
    assert.equal(page.items.length, 1); assert.equal(page.items[0].runId, queued.runId);
    assert.equal(page.nextCursor, null);
    const claimed = await call('claim_run_delivery', { projectId: queued.projectId, executionLogId: 1, generation: queued.generation, expectedRevision: queued.revision, owner: { id: 'new-window', pid: process.pid, birth: '' }, idempotencyKey: 'delivery-poll-claim' });
    assert.equal((await call('list_run_deliveries', {})).items.length, 0);
    assert.equal((await call('read_run_state', { projectId: live.projectId, executionLogId: 2 })).revision, live.revision);
    assert.equal(claimed.runId, queued.runId);
    await assert.rejects(call('claim_run_delivery', { projectId: stopped.projectId, executionLogId: 3, generation: stopped.generation, expectedRevision: stopped.revision + 1, owner: gone, idempotencyKey: 'must-not-deliver-stopped' }), /run_stop_requested/);
  } finally { await ops.close(); store.close(); }
});

test('a failed terminal delivery releases only its own generation and can retry without recreating the task', async () => {
  const { getAgentRunDeliveryOwner } = require('../out/agentRunPreparation.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-delivery-release-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const owner = await getAgentRunDeliveryOwner();
    const prepared = await call('prepare_run', { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '完整原始目标', command: 'actual command', userMessage: '用户原话', metadata: { interactiveSession: true }, deliveryOwner: owner, idempotencyKey: 'delivery-release-prepare' });
    const release = { projectId: prepared.projectId, executionLogId: 1, generation: prepared.generation, owner, error: 'terminal_not_ready', idempotencyKey: 'delivery-release' };
    await assert.rejects(call('release_run_delivery', { ...release, owner: { ...owner, id: 'other-window' }, idempotencyKey: 'invalid-release' }), /run_delivery_lease_lost/);
    await call('release_run_delivery', release);
    await call('release_run_delivery', release);
    assert.equal((await call('list_run_deliveries', {})).items.length, 1);
    const current = await call('read_run_state', { projectId: prepared.projectId, executionLogId: 1 });
    assert.equal(current.status.deliveryPending, true); assert.equal(current.status.deliveryLastError, 'terminal_not_ready');
    const claimed = await call('claim_run', { projectId: prepared.projectId, executionLogId: 1, expectedRevision: current.revision, agentPid: process.pid, processBirth: owner.birth, idempotencyKey: 'delivered-run-claim' });
    await assert.rejects(call('release_run_delivery', { ...release, idempotencyKey: 'late-release' }), /run_owner_conflict|run_already_delivered/);
    assert.equal(claimed.taskId, prepared.taskId); assert.equal(claimed.status.userMessage, '用户原话');
  } finally { await ops.close(); store.close(); }
});

test('a prepared task survives its creating window and Runtime restart until one live window delivers it', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-run-delivery-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  let store = new UnifiedDataStore(root); let ops = createRuntimeDataOperations(store);
  let call = (operation, input) => ops({ operation, input });
  try {
    const prepared = await call('prepare_run', { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '完整未投递任务🌿\n'.repeat(10000), command: 'actual command', userMessage: '用户目标', metadata: { interactiveSession: true }, deliveryOwner: { id: 'closed-window', pid: 1073741824, birth: 'proc:1' }, idempotencyKey: 'prepare-delivery' });
    assert.equal(prepared.status.deliveryPending, true);
    await call('recover_run_executions', {});
    assert.equal((await call('read_run_state', { projectId: prepared.projectId, executionLogId: 1 })).status.finishedAt, '');
    await ops.close(); store.close();
    store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store); call = (operation, input) => ops({ operation, input });
    const identity = { projectId: prepared.projectId, executionLogId: 1 };
    const queued = await call('read_run_state', identity);
    assert.equal(queued.status.deliveryPending, true); assert.equal(queued.runId, prepared.runId);
    const intent = { ...identity, generation: queued.generation, expectedRevision: queued.revision, owner: { id: 'new-window', pid: process.pid, birth: '' }, idempotencyKey: 'claim-delivery' };
    const claimed = await call('claim_run_delivery', intent);
    assert.equal(claimed.status.deliveryOwnerId, 'new-window');
    assert.deepEqual((await call('claim_run_delivery', intent)).receipt, claimed.receipt);
    await assert.rejects(call('claim_run_delivery', { ...intent, expectedRevision: claimed.revision, owner: { id: 'competing-window', pid: process.pid, birth: '' }, idempotencyKey: 'second-delivery' }), /run_delivery_owner_alive/);
    await call('recover_run_executions', {});
    assert.equal((await call('read_run_state', identity)).status.finishedAt, '');
    const launched = await call('claim_run', { ...identity, expectedRevision: claimed.revision, agentPid: process.pid, idempotencyKey: 'runner-delivery' });
    assert.equal(launched.status.deliveryPending, false);
    assert.equal((await call('read_run_execution_plan', identity)).prompt, '完整未投递任务🌿\n'.repeat(10000));
    await assert.rejects(call('claim_run_delivery', { ...intent, generation: launched.generation, expectedRevision: launched.revision, idempotencyKey: 'already-launched' }), /run_already_delivered/);
    assert.deepEqual(fs.readdirSync(path.join(project, '.solopreneur')), ['project.json']);
  } finally { await ops.close(); store.close(); }
});

test('another window cannot take an undelivered task away from a still live creating window', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-live-delivery-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const prepared = await call('prepare_run', { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '尚在准备', command: '', userMessage: '目标', status: 'Preparing', deliveryOwner: { id: 'live-window', pid: process.pid, birth: '' }, idempotencyKey: 'live-prepare' });
    await call('recover_run_executions', {});
    assert.equal((await call('read_run_state', { projectId: prepared.projectId, executionLogId: 1 })).status.status, 'Preparing');
    await assert.rejects(call('claim_run_delivery', { projectId: prepared.projectId, executionLogId: 1, generation: prepared.generation, expectedRevision: prepared.revision, owner: { id: 'other-window', pid: process.pid, birth: '' }, idempotencyKey: 'live-other' }), /run_delivery_owner_alive/);
  } finally { await ops.close(); store.close(); }
});
