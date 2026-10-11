const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');

test('the final CLI gate checks its original revision source after preparation and fences forged identities', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-final-launch-gate-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const parent = await call('prepare_run', { root: project, executionLogId: 1, nodeId: 'step', runKind: 'step', prompt: '原始目标', command: 'main', userMessage: '目标', metadata: { interactiveSession: true }, idempotencyKey: 'launch-parent' });
    const done = await call('checkpoint_run', { projectId: parent.projectId, executionLogId: 1, generation: parent.generation, proof: parent.proof, expectedRevision: parent.revision, expectedTurnId: parent.turnId, action: 'complete', outcome: 'partial', summary: '本轮已交付', idempotencyKey: 'launch-parent-done' });
    const revision = await call('prepare_run', { root: project, executionLogId: 2, parentExecutionLogId: 1, expectedParentTurnId: parent.turnId, nodeId: 'step', runKind: 'agent_review_revision', prompt: '本轮修正', command: 'CLI', userMessage: '原始目标', idempotencyKey: 'launch-revision' });
    const input = { projectId: revision.projectId, executionLogId: 2, generation: revision.generation, proof: revision.proof, expectedTurnId: revision.turnId };
    assert.equal((await call('read_run_launch_permission', input)).permission, 'allow');
    await assert.rejects(call('patch_run_state', { projectId: revision.projectId, executionLogId: 2, generation: revision.generation, expectedRevision: revision.revision, patch: { sourceParentTurnId: 'forged' }, idempotencyKey: 'forged-launch-parent' }), /invalid_run_patch/);
    await assert.rejects(call('read_run_launch_permission', { ...input, proof: 'f'.repeat(64) }), /run_proof_denied/);
    await assert.rejects(call('read_run_launch_permission', { ...input, expectedTurnId: parent.turnId }), /checkpoint_turn_conflict/);
    await call('checkpoint_run', { projectId: parent.projectId, executionLogId: 1, generation: parent.generation, proof: parent.proof, expectedRevision: done.revision, expectedTurnId: done.turnId, action: 'start', message: '新的用户要求', idempotencyKey: 'launch-newer-parent' });
    const denied = await call('read_run_launch_permission', input);
    assert.equal(denied.permission, 'deny'); assert.equal(denied.reason, 'run_source_turn_changed');
    const current = await call('read_run_state', { projectId: revision.projectId, executionLogId: 2 });
    assert.equal(current.status.finishedAt, '', 'the check itself must not fabricate a completed result');
  } finally { await ops.close(); store.close(); }
});

test('the final Flow gate waits through pause and allows the same role after resume, but denies abandonment', async () => {
  const { createFlowTrace, createFlowLoop } = require('../out/flowStore.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-flow-final-launch-gate-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    let flow = createFlowTrace(project, '原始 Flow 目标'); flow.loops = [createFlowLoop(flow.goal, 1)];
    const created = await call('write_flow_trace', { root: project, flow, expectedRevision: 0, idempotencyKey: 'flow-gate-create' });
    const run = await call('prepare_flow_role', { root: project, flowId: flow.flowId, loopId: 'loop-1', role: 'planner', attempt: 0, prompt: '原角色输入', command: 'CLI', userMessage: flow.goal, status: 'Running', metadata: { launchIntentHash: 'flow-gate-original' }, idempotencyKey: 'flow-gate-role' });
    const identity = { projectId: created.projectId, executionLogId: run.status.rootExecutionLogId, generation: run.generation, proof: run.proof, expectedTurnId: run.turnId };
    assert.equal((await call('read_run_launch_permission', identity)).permission, 'allow');
    for (const [status, permission] of [['paused', 'wait'], ['running', 'allow'], ['abandoned', 'deny']]) {
      const current = await call('read_flow_trace', { root: project, flowId: flow.flowId });
      flow = { ...current.flow, status };
      await call('write_flow_trace', { root: project, flow, expectedRevision: current.revision, idempotencyKey: `flow-gate-${status}` });
      assert.equal((await call('read_run_launch_permission', identity)).permission, permission);
    }
  } finally { await ops.close(); store.close(); }
});
