const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { createFlowTrace, createFlowLoop, matchesFlowLaunchIntent } = require('../out/flowStore.js');

test('Flow launch replay accepts only the same normalized intent', () => {
  const flow = createFlowTrace('/project', '完整目标', { supplementFiles: ['a.png'], selectedAgentCli: 'codex', selectedModel: 'auto' });
  assert.equal(matchesFlowLaunchIntent(flow, '完整目标', { supplementFiles: ['a.png'], selectedAgentCli: 'codex', selectedModel: 'auto' }), true);
  assert.equal(matchesFlowLaunchIntent(flow, '另一个目标', { supplementFiles: ['a.png'], selectedAgentCli: 'codex', selectedModel: 'auto' }), false);
  assert.equal(matchesFlowLaunchIntent(flow, '完整目标', { supplementFiles: ['a.png'], selectedAgentCli: 'claude', selectedModel: 'auto' }), false);
});

test('Flow persists its task, role evidence and scoring in the single database with CAS and restart recovery', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-flow-db-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  let store = new UnifiedDataStore(root); let ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const flow = createFlowTrace(project, '完整用户目标🌿', { selectedAgentCli: 'claude', selectedModel: 'chosen-model' });
    flow.loops = [createFlowLoop(flow.goal, 1)];
    const created = await call('write_flow_trace', { root: project, flow, expectedRevision: 0, idempotencyKey: 'flow-create' });
    assert.equal(created.revision, 1); assert.deepEqual(created.flow, flow);
    const scope = { projectId: created.projectId, flowId: flow.flowId };
    const task = store.read(created.taskId);
    assert.equal(task.kind, 'task'); assert.equal(task.data.original_request_content, '完整用户目标🌿');
    const role = await call('prepare_run', { root: project, executionLogId: 1, nodeId: `__flow__::${flow.flowId}::loop-1::verifier`, runKind: 'flow_verifier', prompt: '完整验证任务', command: 'actual verifier', userMessage: flow.goal, idempotencyKey: 'flow-role-run' });
    const output = '完整角色证据🌿\n'.repeat(20000);
    const updated = structuredClone(flow);
    updated.loops[0].verifier = { status: 'completed', executionLogId: 1, outputTail: '展示尾部', data: { fullOutput: output } };
    updated.loops[0].status = 'closed'; updated.loops[0].scoring = { hardEvidencePass: true, intentPass: true, judgmentPass: true, recommendedStatus: 'closed', reasons: ['真实验证通过'] };
    updated.status = 'completed';
    const intent = { ...scope, flow: updated, expectedRevision: created.revision, idempotencyKey: 'flow-close' };
    const closed = await call('write_flow_trace', intent);
    assert.deepEqual(await call('write_flow_trace', intent), closed);
    const loops = store.search({ scope: created.projectId, kinds: ['workflow_loop'] }).items;
    assert.equal(loops.length, 1); assert.equal(loops[0].data.task_id, created.taskId); assert.equal(loops[0].data.verifier_run_id, role.runId);
    assert.deepEqual(JSON.parse(store.read(loops[0].objectId).data.scoring_content), updated.loops[0].scoring);
    await assert.rejects(call('write_flow_trace', { ...scope, flow, expectedRevision: created.revision, idempotencyKey: 'late-flow-write' }), /revision_conflict/);
    assert.deepEqual((await call('read_flow_trace', scope)).flow, updated);
    await ops.close(); store.close(); store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store);
    const resumed = await call('read_flow_trace', scope);
    assert.equal(resumed.objectId, created.objectId); assert.equal(resumed.revision, closed.revision);
    assert.equal(resumed.flow.loops[0].verifier.data.fullOutput, output);
    assert.equal((await call('list_flow_traces', { projectId: created.projectId })).items[0].flow.flowId, flow.flowId);
    assert.deepEqual(fs.readdirSync(path.join(project, '.solopreneur')), ['project.json']);
    const before = resumed.revision;
    await assert.rejects(call('write_flow_trace', { ...scope, flow: { ...updated, loops: [{ ...updated.loops[0], verifier: { status: 'completed', executionLogId: 999 } }] }, expectedRevision: before, idempotencyKey: 'missing-flow-role' }), /run_missing/);
    assert.equal((await call('read_flow_trace', scope)).revision, before);
  } finally { await ops.close(); store.close(); }
});

test('the Flow consumer merges concurrent updates through Runtime without rewriting or reading historical JSON', async () => {
  const flowStore = require('../out/flowStore.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-flow-consumer-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const flow = createFlowTrace(project, '完整目标'); flow.loops = [createFlowLoop(flow.goal, 1)];
    await flowStore.saveFlowTrace(project, flow, root, call);
    assert.deepEqual(fs.readdirSync(path.join(project, '.solopreneur')), ['project.json']);
    const registered = await call('register_project', { root: project });
    const stored = await call('read_flow_trace', { projectId: registered.projectId, flowId: flow.flowId });
    assert.ok(stored);
    fs.mkdirSync(path.join(project, '.solopreneur', 'flows'));
    const historical = path.join(project, '.solopreneur', 'flows', `${flow.flowId}.json`);
    fs.writeFileSync(historical, '{"historical":"must not be used or rewritten"}');
    let initialReads = 0; let release;
    const gate = new Promise(resolve => { release = resolve; });
    const concurrentCall = async (operation, input) => {
      const result = await call(operation, input);
      if (operation === 'read_flow_trace' && initialReads < 2) { initialReads++; if (initialReads === 2) release(); await gate; }
      return result;
    };
    await Promise.all([
      flowStore.updateFlowTrace(project, flow.flowId, current => ({ ...current, status: 'paused' }), root, concurrentCall),
      flowStore.updateFlowTrace(project, flow.flowId, current => ({ ...current, latestSummary: '并发写入的完整摘要🌿' }), root, concurrentCall)
    ]);
    const current = await flowStore.readFlowTrace(project, flow.flowId, root, call);
    assert.equal(current.status, 'paused'); assert.equal(current.latestSummary, '并发写入的完整摘要🌿');
    assert.equal(current.loops.length, 1);
    const state = await flowStore.buildFlowStatePayload(project, true, root, call);
    assert.equal(state.flow.flowId, flow.flowId); assert.equal(state.history.length, 1);
    assert.equal(fs.readFileSync(historical, 'utf8'), '{"historical":"must not be used or rewritten"}');
  } finally { await ops.close(); store.close(); }
});

test('new Flow identities stay distinct when several windows create goals in the same millisecond', () => {
  const ids = Array.from({ length: 100 }, () => createFlowTrace('/project', '并发目标').flowId);
  assert.equal(new Set(ids).size, 100);
});

test('Flow role preparation is atomic, retry safe across windows and restart, and respects a paused goal', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-flow-atomic-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  let store = new UnifiedDataStore(root); let ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const flow = createFlowTrace(project, '完整原始目标'); flow.loops = [createFlowLoop(flow.goal, 1)];
    const created = await call('write_flow_trace', { root: project, flow, expectedRevision: 0, idempotencyKey: 'atomic-flow-create' });
    const input = { root: project, flowId: flow.flowId, loopId: 'loop-1', role: 'planner', attempt: 0, prompt: '完整角色输入', command: '', userMessage: flow.goal, status: 'Preparing', metadata: { launchIntentHash: 'same-real-launch' }, deliveryOwner: { id: 'dead-window', pid: 99999999, birth: 'gone' }, launchRequest: { workspaceRoot: project, executionLogId: 0, nodeId: `__flow__::${flow.flowId}::loop-1::planner` }, idempotencyKey: 'atomic-planner' };
    const [left, right] = await Promise.all([call('prepare_flow_role', input), call('prepare_flow_role', { ...input, idempotencyKey: 'other-window' })]);
    assert.equal(left.runId, right.runId); assert.equal(left.turnId, right.turnId);
    const current = await call('read_flow_trace', { projectId: created.projectId, flowId: flow.flowId });
    const executionLogId = current.flow.loops[0].planner.executionLogId;
    assert.equal(left.status.rootExecutionLogId, executionLogId);
    assert.equal((await call('read_project_journal', { root: project })).logs.length, 1);
    const request = await call('read_run_document', { projectId: created.projectId, executionLogId, purpose: 'launch_request' });
    assert.equal(JSON.parse(Buffer.from(request.bytes, 'base64').toString()).executionLogId, executionLogId);
    await assert.rejects(call('prepare_flow_role', { ...input, metadata: { launchIntentHash: 'different-launch' }, idempotencyKey: 'changed-goal' }), /execution_identity_conflict/);
    await ops.close(); store.close(); store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store);
    assert.equal((await call('prepare_flow_role', input)).runId, left.runId);
    await call('write_flow_trace', { root: project, flow: { ...current.flow, status: 'paused' }, expectedRevision: current.revision, idempotencyKey: 'user-pauses' });
    assert.equal((await call('list_run_deliveries', { projectId: created.projectId })).items.length, 0);
    await assert.rejects(call('claim_run_delivery', { projectId: created.projectId, executionLogId, generation: left.generation, expectedRevision: left.revision, owner: { id: 'new-window', pid: process.pid, birth: '' }, idempotencyKey: 'paused-claim' }), /flow_not_running/);
    await assert.rejects(call('prepare_flow_role', { ...input, role: 'builder', idempotencyKey: 'paused-builder' }), /flow_not_running/);
    assert.equal((await call('read_project_journal', { root: project })).logs.length, 1);
  } finally { await ops.close(); store.close(); }
});

test('accepting a new Flow creates its first role and recoverable delivery in one transaction', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-flow-admission-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const flow = createFlowTrace(project, '原始目标🌿'); flow.loops = [createFlowLoop(flow.goal, 1)];
    const input = { root: project, flowId: flow.flowId, loopId: 'loop-1', role: 'planner', attempt: 0, initialFlow: flow, prompt: '完整初始计划输入', command: '', userMessage: flow.goal, status: 'Preparing', metadata: { launchIntentHash: 'same-admission' }, deliveryOwner: { id: 'closed-window', pid: 99999999, birth: 'gone' }, launchRequest: { workspaceRoot: project, executionLogId: 0, nodeId: `__flow__::${flow.flowId}::loop-1::planner` }, idempotencyKey: 'flow-admission' };
    await assert.rejects(call('prepare_flow_role', { ...input, prompt: 12, idempotencyKey: 'invalid-admission' }), /invalid_run_request/);
    assert.equal(await call('read_flow_trace', { root: project, flowId: flow.flowId }), null);
    const run = await call('prepare_flow_role', input);
    const persisted = await call('read_flow_trace', { root: project, flowId: flow.flowId });
    assert.equal(persisted.flow.loops[0].planner.executionLogId, run.status.rootExecutionLogId);
    assert.equal((await call('list_run_deliveries', { projectId: run.projectId })).items[0].runId, run.runId);
    assert.deepEqual(fs.readdirSync(path.join(project, '.solopreneur')), ['project.json']);
  } finally { await ops.close(); store.close(); }
});
