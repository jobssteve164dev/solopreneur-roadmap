const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { prepareAgentRun, resumePreparedAgentRun } = require('../out/agentRunPreparation.js');

async function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-global-policy-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project');
  fs.mkdirSync(project);
  let store = new UnifiedDataStore(root), ops = createRuntimeDataOperations(store);
  t.after(async () => { await ops.close(); store.close(); });
  const call = (operation, input) => ops({ operation, input });
  const input = (id, extra = {}) => ({ agentCli: 'codex', selectedModel: '', prompt: '执行当前用户动作。', workspaceRoot: project, nodeId: '__solo__', executionLogId: id, userMessage: '执行当前用户动作。', runKind: 'solo', globalDataPath: root, taskPermissionMode: 'auto', ...extra });
  return { root, project, call, input, get store() { return store; },
    save: (policy, content, key) => call('save_global_prompt', { policy, content, source: 'user', idempotencyKey: key }),
    plan: id => call('read_run_execution_plan', { root: project, executionLogId: id }),
    async restart() { await ops.close(); store.close(); store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store); }
  };
}

test('ordinary preparation delivers the complete fixed database policy without claiming adoption', async t => {
  const f = await fixture(t), body = '  完整原始要求🌿\n保留每条约束\n末行\n';
  const policy = await f.save(null, body, 'policy-original');
  const prepared = await prepareAgentRun(f.input(1), f.call), plan = await f.plan(1);
  assert.deepEqual(plan.status.globalPromptPolicyRef, policy);
  assert.ok(plan.prompt.includes(body), 'preserve every byte including leading spaces and the final newline');
  assert.ok(plan.prompt.includes(policy.objectId));
  assert.ok(plan.prompt.includes(JSON.stringify(policy)), 'the delivered instructions identify their fixed revision');
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM policy_uses')[0].n, 0, 'injection is not actual adoption');
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM evaluations')[0].n, 0);
  assert.equal(prepared.status.globalPromptPolicyRef.revision, policy.revision);
  assert.equal(fs.existsSync(path.join(f.root, 'context', 'global-default-prompt.md')), false);
});

test('a user save during preparation cannot replace the policy pinned by the run transaction', async t => {
  const f = await fixture(t), body = '原事务固定全文\n', policy = await f.save(null, body, 'policy-before-race');
  let changed = false;
  const call = async (operation, input) => {
    const result = await f.call(operation, input);
    if (operation === 'prepare_run' && !changed) { changed = true; await f.save(policy, '用户后来保存的全文\n', 'policy-during-preparation'); }
    return result;
  };
  await prepareAgentRun(f.input(1), call);
  const plan = await f.plan(1);
  assert.deepEqual(plan.status.globalPromptPolicyRef, policy);
  assert.ok(plan.prompt.includes(body));
  assert.ok(!plan.prompt.includes('用户后来保存的全文'));
});

test('first launch imports the complete configured policy once and never replaces a later database policy with a stale seed', async t => {
  const f = await fixture(t), body = '  首次完整配置\n保留末行\n';
  await prepareAgentRun(f.input(1, { globalPrompt: body }), f.call);
  const first = await f.call('read_global_prompt_policy', {});
  assert.ok(first, 'a fresh data root must not lose the existing user instructions');
  assert.equal(first.data.content, body);
  const newer = await f.save({ objectId: first.objectId, revision: first.revision }, '用户新的权威要求\n', 'policy-user-newer');
  await prepareAgentRun(f.input(2, { globalPrompt: body, metadata: { globalPromptPolicyRef: { objectId: 'forged-policy', revision: 999 } } }), f.call);
  const plan = await f.plan(2), current = await f.call('read_global_prompt_policy', {});
  assert.deepEqual(plan.status.globalPromptPolicyRef, newer);
  assert.ok(plan.prompt.includes('用户新的权威要求\n')); assert.ok(!plan.prompt.includes(body));
  assert.equal(current.revision, newer.revision);
});

test('pending launch recovery and restart retain their original policy while a new task uses the newer version', async t => {
  const f = await fixture(t), body = '重启前固定要求\n', policy = await f.save(null, body, 'policy-before-restart');
  const prepared = await prepareAgentRun(f.input(0, { launchIntentId: 'policy-pending-launch' }), f.call);
  const newer = await f.save(policy, '新任务要求\n', 'policy-before-new-task');
  await f.restart();
  const resumed = await resumePreparedAgentRun(prepared, f.call, f.root);
  const plan = await f.plan(Number(resumed.status.rootExecutionLogId));
  assert.deepEqual(plan.status.globalPromptPolicyRef, policy); assert.ok(plan.prompt.includes(body));
  const next = await prepareAgentRun(f.input(0, { launchIntentId: 'policy-new-launch' }), f.call);
  assert.deepEqual((await f.plan(Number(next.status.rootExecutionLogId))).status.globalPromptPolicyRef, newer);
  assert.equal((await f.call('read', { ref: policy.objectId, revision: policy.revision })).data.content, body);
});

test('a continued turn pins the newly saved policy without changing the first turn fixed run snapshot', async t => {
  const f = await fixture(t), original = await f.save(null, '首轮要求\n', 'policy-first-turn');
  await prepareAgentRun(f.input(1, { agentCli: 'claude' }), f.call);
  const first = await f.plan(1);
  assert.deepEqual(first.status.globalPromptPolicyRef, original);
  await f.call('checkpoint_run', { root: f.project, executionLogId: 1, generation: first.generation, proof: first.proof, expectedRevision: first.revision, expectedTurnId: first.turnId, action: 'complete', outcome: 'partial', message: '第一轮', summary: '第一轮结果', workspaceEvidenceSource: 'native', nativeStartedAt: Date.now(), nativeCompletedAt: Date.now(), idempotencyKey: 'policy-first-complete' });
  const newer = await f.save(original, '后续轮新要求\n', 'policy-next-turn');
  const current = await f.call('read_run_checkpoint_state', { root: f.project, executionLogId: 1 });
  const next = await f.call('checkpoint_run', { root: f.project, executionLogId: 1, generation: current.generation, proof: current.proof, expectedRevision: current.revision, expectedTurnId: current.turnId, action: 'start', message: '下一轮动作', idempotencyKey: 'policy-next-start' });
  assert.deepEqual(next.status.globalPromptPolicyRef, newer);
  assert.deepEqual((await f.call('read_run_state', { root: f.project, executionLogId: 1, revision: first.revision })).status.globalPromptPolicyRef, original);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM policy_uses')[0].n, 0);
});

test('importing first-launch configuration preserves a pending historical application instead of fabricating a user save', async t => {
  const f = await fixture(t);
  const target = f.store.write({ kind: 'policy', action: 'create', scope: null, idempotencyKey: 'historical-policy', data: { kind: 'legacy_global_prompt', status: 'historical', content: '旧待恢复全文' } });
  const batch = f.store.write({ kind: 'review_batch', action: 'create', scope: null, idempotencyKey: 'historical-policy-batch', data: { input_cursor: 0, input_hash: '1'.repeat(64), status: 'interrupted', review_content: '{}' } });
  const inputContentId = f.store.readMetadata(batch.objectId).data.review_content_id;
  f.store.db.run('INSERT INTO legacy_learning_review_controls VALUES(?,?,?,?)', [batch.objectId, inputContentId, 'first-launch-historical-review', 'runs/original']);
  const receipt = f.store.write({ kind: 'application', action: 'create', scope: null, idempotencyKey: 'historical-policy-application', data: { review_id: batch.objectId, target_object_id: target.objectId, expected_revision: 0, before_content: '原要求', after_content: '旧待恢复全文', status: 'partial', applied_revision: null } });
  const before = f.store.read(receipt.objectId);
  await prepareAgentRun(f.input(1, { globalPrompt: '首次已有配置全文\n' }), f.call);
  assert.deepEqual(f.store.read(receipt.objectId), before, 'configuration import is not a new user save or a review decision');
});

test('pinning reads the full policy only for delivery and a prepared retry does not read it again', async t => {
  const f = await fixture(t), body = '完整大正文🌿\n'.repeat(12000), policy = await f.save(null, body, 'policy-large-original');
  const read = f.store.read.bind(f.store); let reads = 0;
  f.store.read = (ref, ...args) => { if (ref === policy.objectId) reads++; return read(ref, ...args); };
  const prepared = await prepareAgentRun(f.input(0, { launchIntentId: 'large-policy-fixed' }), f.call);
  assert.equal(reads, 1, 'reference pinning must not decode the full policy before its actual delivery');
  assert.ok((await f.plan(Number(prepared.status.rootExecutionLogId))).prompt.includes(body));
  await resumePreparedAgentRun(prepared, f.call, f.root);
  assert.equal(reads, 1, 'an unchanged pending launch must reuse its already prepared fixed inputs');
});

test('native backlog cannot attribute a later policy to an earlier turn that only received the original instructions', async t => {
  const f = await fixture(t), original = await f.save(null, '启动时实际收到的要求\n', 'native-policy-original');
  await prepareAgentRun(f.input(1), f.call);
  const first = await f.plan(1), start = Date.now();
  await f.call('checkpoint_run', { root: f.project, executionLogId: 1, generation: first.generation, proof: first.proof, expectedRevision: first.revision, expectedTurnId: first.turnId, action: 'complete', outcome: 'partial', message: '首轮', summary: '首轮完成', exitCode: 0, workspaceEvidenceSource: 'native', nativeStartedAt: start, nativeCompletedAt: start + 1, idempotencyKey: 'native-policy-complete' });
  await f.save(original, '回放之前后来保存的要求\n', 'native-policy-future-save');
  const current = await f.call('read_run_checkpoint_state', { root: f.project, executionLogId: 1 });
  const next = await f.call('checkpoint_run', { root: f.project, executionLogId: 1, generation: current.generation, proof: current.proof, expectedRevision: current.revision, expectedTurnId: current.turnId, action: 'start', message: '积压轮次', workspaceEvidenceSource: 'native', nativeStartedAt: start + 2, idempotencyKey: 'native-policy-backlog-start' });
  assert.deepEqual(next.status.globalPromptPolicyRef, original, 'replay cannot invent a policy delivery or adoption that did not happen');
});

test('a read-only review receives the complete fixed policy without instructions to start or settle business turns', async t => {
  const f = await fixture(t), body = '  完整审查约束🌿\n保留末行\n', policy = await f.save(null, body, 'readonly-policy');
  await prepareAgentRun(f.input(1, { readOnlyReview: true, prompt: '只读审查当前结果。' }), f.call);
  const plan = await f.plan(1);
  assert.deepEqual(plan.status.globalPromptPolicyRef, policy);
  assert.ok(plan.prompt.includes(body));
  assert.ok(plan.prompt.includes(JSON.stringify(policy)));
  assert.doesNotMatch(plan.prompt, /后续每轮 start|SOLOMAP_TASK_COMMAND|SoloMap 任务汇报/);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM policy_uses')[0].n, 0);
});

test('an undefined optional policy seed stays absent while an explicitly empty user policy is retained', async t => {
  const f = await fixture(t), input = f.input(0, { globalPrompt: undefined, launchIntentId: 'policy-undefined-seed' });
  const prepared = await prepareAgentRun(input, f.call);
  assert.equal(Object.hasOwn(input, 'globalPrompt'), true, 'preparation cannot mutate the caller input');
  assert.equal(prepared.status.globalPromptPolicyRef, null);
  assert.equal(await f.call('read_global_prompt_policy', {}), null);
  const document = await f.call('read_run_document', { root: f.project, executionLogId: prepared.status.rootExecutionLogId, purpose: 'launch_request' });
  assert.equal(Object.hasOwn(JSON.parse(Buffer.from(document.bytes, 'base64').toString('utf8')), 'globalPrompt'), false);
  await prepareAgentRun(f.input(0, { globalPrompt: '', launchIntentId: 'policy-explicit-empty' }), f.call);
  const policy = await f.call('read_global_prompt_policy', {});
  assert.equal(policy.data.content, '');
  assert.ok(policy.objectId);
});
