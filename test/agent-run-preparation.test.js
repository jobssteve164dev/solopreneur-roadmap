const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { shellQuote } = require('../out/agentCli.js');
const fixtureRoots = [];
function fixtureRoot(prefix) { const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); fixtureRoots.push(root); return root; }
function cleanupExact(root) {
  if (!fs.existsSync(root)) return;
  const directories = [root], files = [];
  const inventory = directory => fs.readdirSync(directory).forEach(name => { const target = path.join(directory, name); if (fs.lstatSync(target).isDirectory()) { directories.push(target); inventory(target); } else files.push(target); });
  inventory(root); files.forEach(file => fs.unlinkSync(file)); directories.sort((a, b) => b.length - a.length).forEach(directory => fs.rmdirSync(directory));
}
test.after(() => fixtureRoots.forEach(cleanupExact));

test('host preparation persists all task input and native identity without producing permanent per-run files', async () => {
  const modulePath = path.resolve(__dirname, '../out/agentRunPreparation.js');
  assert.ok(fs.existsSync(modulePath), 'host preparation must use the same domain operations as the shared runner');
  const { prepareAgentRun } = require(modulePath);
  const base = fixtureRoot("solomap-run-preparation-'unicode-🌿-");
  const root = path.join(base, '.solomap-global'); const projectRoot = path.join(base, 'project'); fs.mkdirSync(projectRoot);
  const store = new UnifiedDataStore(root); const operations = createRuntimeDataOperations(store);
  try {
    const input = { agentCli: 'claude', selectedModel: 'chosen-model', prompt: '完整用户任务\n禁止改变范围', workspaceRoot: projectRoot, nodeId: '__solo__', executionLogId: 1, userMessage: '用户目标', runKind: 'solo', globalDataPath: root, taskPermissionMode: 'auto' };
    const call = (operation, input) => operations({ operation, input });
    const prepared = await prepareAgentRun(input, call);
    assert.equal(prepared.status.deliveryPending, true, 'host preparation registers the durable terminal delivery before returning');
    assert.equal(prepared.status.deliveryOwnerPid, process.pid);
    const deliveryRequest = await call('read_run_document', { projectId: prepared.projectId, executionLogId: 1, purpose: 'launch_request' });
    assert.ok(deliveryRequest, 'an unfinished preparation must recover all launch parameters after the creating window closes');
    assert.deepEqual(JSON.parse(Buffer.from(deliveryRequest.bytes, 'base64')), input);
    const { RunLifecycleClient, runStatusReference, parseRunDataReference } = require('../out/runLifecycleClient.js');
    const outputReference = parseRunDataReference(prepared.outputFilePath);
    assert.equal(outputReference.reference, runStatusReference(projectRoot, 1));
    assert.equal((await new RunLifecycleClient(call).readStatus(outputReference.reference)).rootExecutionLogId, 1);
    const replay = await prepareAgentRun(input, call);
    assert.equal(replay.runId, prepared.runId);
    const state = await call('read_run_state', { root: projectRoot, executionLogId: 1 });
    const plan = await call('read_run_execution_plan', { root: projectRoot, executionLogId: 1 });
    assert.equal(state.status.selectedModel, 'chosen-model');
    assert.equal(state.status.sessionBindingHeadRevision, 2);
    const binding = await call('read_run_binding', { root: projectRoot, executionLogId: 1 });
    assert.equal(binding.provider, 'claude');
    assert.equal(binding.bindingNonce, state.status.bindingNonce);
    assert.equal(binding.revisions[1].sessionId, state.status.plannedNativeSessionId);
    assert.match(binding.revisions[1].sessionId, /^[0-9a-f-]{36}$/);
    assert.match(plan.prompt, /完整用户任务\n禁止改变范围/);
    assert.match(plan.prompt, /solomap_migration_start/);
    assert.match(plan.prompt, /普通对话只生成清单/);
    assert.match(plan.prompt, /SoloMap 数据库记忆系统（每个任务必须执行）/);
    assert.match(plan.prompt, /实现或判断前.*solomap_context/);
    assert.match(plan.prompt, /任务收尾.*未来任务仍会复用/);
    assert.match(plan.prompt, new RegExp(`SoloMap-Task: task-${state.taskId}`));
    assert.match(plan.prompt, /solomap_conversation_status\(\{action:"start"\}\)/);
    assert.match(plan.prompt, /complete 动作/);
    assert.doesNotMatch(plan.prompt, /--report-json|taskCheckpointProcess\.js|SOLOMAP_TASK_COMMAND/);
    assert.doesNotMatch(plan.prompt, /agent-runs\/|\.solopreneur\/runtime/);
    assert.equal(spawnSync('bash', ['-n', '-c', prepared.finalCommand], { encoding: 'utf8' }).status, 0);
    assert.deepEqual(fs.readdirSync(path.join(projectRoot, '.solopreneur')), ['project.json']);
    assert.equal(fs.existsSync(path.join(root, 'tmp')), false, 'temporary paths are materialized only when the CLI needs them');
    const nativeSessionId = String(state.status.plannedNativeSessionId);
    const resumed = await prepareAgentRun({ ...input, executionLogId: 2, runKind: 'solo_continue', parentExecutionLogId: 1, nativeSessionId, continuation: true }, call);
    assert.equal(resumed.status.sessionMode, 'resume');
    assert.equal(resumed.status.plannedNativeSessionId, nativeSessionId);
    assert.equal(resumed.taskId, prepared.taskId);
    assert.equal(resumed.status.agentLaunch.direct, false);
    const resumePlan = await call('read_run_execution_plan', { root: projectRoot, executionLogId: 2 });
    assert.match(resumePlan.command, new RegExp(`--resume '${nativeSessionId}'`));
    assert.doesNotMatch(resumePlan.command.replace(shellQuote(projectRoot), '<workspace>'), /cat |prompt\.txt|agent-runs/);
  } finally { await operations.close(); store.close(); }
});

test('the production preparer reuses one formal Flow role across concurrent windows and delivery recovery', async () => {
  const { prepareAgentRun, resumePreparedAgentRun } = require('../out/agentRunPreparation.js');
  const { createFlowTrace, createFlowLoop } = require('../out/flowStore.js');
  const base = fixtureRoot('solomap-flow-preparer-');
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const operations = createRuntimeDataOperations(store);
  const call = (operation, input) => operations({ operation, input });
  try {
    const flow = createFlowTrace(project, '完整目标'); flow.loops = [createFlowLoop(flow.goal, 1)];
    const created = await call('write_flow_trace', { root: project, flow, expectedRevision: 0, idempotencyKey: 'preparer-flow' });
    const input = { agentCli: 'claude', selectedModel: 'chosen-model', prompt: '完整计划🌿', workspaceRoot: project, nodeId: `__flow__::${flow.flowId}::loop-1::planner`, executionLogId: 0, userMessage: flow.goal, runKind: 'flow_planner', globalDataPath: root, taskPermissionMode: 'auto', flowRole: { flowId: flow.flowId, loopId: 'loop-1', role: 'planner', attempt: 0 } };
    const [first, second] = await Promise.all([prepareAgentRun(input, call), prepareAgentRun(input, call)]);
    assert.equal(first.runId, second.runId);
    const current = await call('read_flow_trace', { root: project, flowId: flow.flowId });
    assert.equal(current.flow.loops[0].planner.executionLogId, first.status.rootExecutionLogId);
    assert.equal((await call('read_project_journal', { root: project })).logs.length, 1);
    const plan = await call('read_run_execution_plan', { root: project, executionLogId: first.status.rootExecutionLogId });
    assert.ok(plan.prompt.includes('完整计划🌿')); assert.ok(plan.command.includes('chosen-model'));
    assert.doesNotMatch(plan.prompt, /solomap_migration_start/);
    assert.equal((await resumePreparedAgentRun(plan, call)).runId, first.runId);
    assert.deepEqual(fs.readdirSync(path.join(project, '.solopreneur')), ['project.json']);
  } finally { await operations.close(); store.close(); }
});

test('stable launch intents reuse one task and complete launch parameters across retry and restart', async () => {
  const { prepareAgentRun } = require('../out/agentRunPreparation.js');
  const base = fixtureRoot('solomap-run-intent-');
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  let store = new UnifiedDataStore(root); let ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const input = { agentCli: 'claude', selectedModel: 'chosen-model', prompt: '完整待复核输入🌿', workspaceRoot: project, nodeId: 'step-one', executionLogId: 0, userMessage: '原始目标', runKind: 'agent_review', globalDataPath: root, taskPermissionMode: 'auto', launchIntentId: 'effect:fixed-review' };
    const [first, second] = await Promise.all([prepareAgentRun(input, call), prepareAgentRun(input, call)]);
    assert.equal(first.runId, second.runId); assert.equal(first.taskId, second.taskId);
    const scope = { root: project, launchIntentId: input.launchIntentId };
    assert.equal((await call('read_run_intent', scope)).runId, first.runId);
    assert.equal((await call('read_project_journal', { root: project })).logs.length, 1);
    await ops.close(); store.close(); store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store);
    assert.equal((await prepareAgentRun(input, call)).runId, first.runId);
    await assert.rejects(prepareAgentRun({ ...input, prompt: '其他目标' }, call), /execution_identity_conflict/);
    const request = await call('read_run_document', { root: project, executionLogId: first.status.rootExecutionLogId, purpose: 'launch_request' });
    assert.equal(JSON.parse(Buffer.from(request.bytes, 'base64')).executionLogId, first.status.rootExecutionLogId);
    assert.deepEqual(fs.readdirSync(path.join(project, '.solopreneur')), ['project.json']);
  } finally { await ops.close(); store.close(); }
});

test('read-only review preparation retains full evidence and uses only the dedicated MCP checkpoint writer', async () => {
  const { prepareAgentRun } = require('../out/agentRunPreparation.js');
  const base = fixtureRoot('solomap-review-preparer-');
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  try {
    const prompt = '全部复核证据🌿'.repeat(25000);
    const input = { agentCli: 'codex', selectedModel: 'chosen-model', prompt, workspaceRoot: project, nodeId: 'step', executionLogId: 0, userMessage: '原始目标', runKind: 'agent_review', globalDataPath: root, taskPermissionMode: 'auto', readOnlyReview: true, launchIntentId: 'review-effect-one' };
    const prepared = await prepareAgentRun(input, (operation, input) => ops({ operation, input }));
    const plan = await ops({ operation: 'read_run_execution_plan', input: { root: project, executionLogId: prepared.status.rootExecutionLogId } });
    assert.ok(plan.prompt.startsWith(prompt));
    assert.match(plan.prompt, /SoloMap 数据库记忆系统（每个任务必须执行）/);
    assert.match(plan.prompt, /solomap_context/);
    assert.match(plan.prompt, /solomap_search/);
    assert.match(plan.prompt, /solomap_read/);
    assert.match(plan.prompt, /本轮对数据库记忆仅可检索和读取/);
    assert.match(plan.prompt, /solomap_conversation_status\(\{action:"start"\}\)/);
    assert.doesNotMatch(plan.prompt, /solomap_write|solomap_link|solomap_export|solomap_migration_start|solomap_recycling_preview|taskCheckpointProcess|--report-json/);
    assert.equal(plan.status.agentLaunch.readOnly, true);
    assert.equal(plan.status.interactiveSession, false);
    assert.doesNotMatch(plan.command, /solomap_read|--dangerously|--full-auto/);
    assert.deepEqual(fs.readdirSync(path.join(project, '.solopreneur')), ['project.json']);
  } finally { await ops.close(); store.close(); }
});

test('Grok read-only review receives bounded memory and only the dedicated MCP checkpoint permission', async () => {
  const { prepareAgentRun } = require('../out/agentRunPreparation.js');
  const base = fixtureRoot('solomap-grok-review-memory-'); const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store); const call = (operation, input) => ops({ operation, input });
  try {
    const registered = await call('register_project', { root: project });
    await call('write', { kind: 'memory', action: 'create', scope: registered.projectId, idempotencyKey: 'grok-review-memory', data: { category: 'project', title: '审查边界', status: 'captured', content: '必须核对真实测试证据。' } });
    const prepared = await prepareAgentRun({ agentCli: 'grok', selectedModel: '', prompt: '复核当前交付', workspaceRoot: project, nodeId: 'step', executionLogId: 0, userMessage: '检查测试证据', runKind: 'agent_review', globalDataPath: root, taskPermissionMode: 'auto', readOnlyReview: true, launchIntentId: 'grok-review-memory' }, call);
    const plan = await call('read_run_execution_plan', { root: project, executionLogId: prepared.status.rootExecutionLogId });
    assert.match(plan.prompt, /宿主按本轮目标加载的固定版本/);
    assert.match(plan.prompt, /必须核对真实测试证据/);
    assert.match(plan.prompt, /不需要为了启动再次调用 MCP/);
    assert.match(plan.prompt, /solomap_conversation_status\(\{action:"start"\}\)/);
    assert.match(plan.command, /--allow 'MCPTool\(solomap_data__solomap_conversation_status\)'/);
    assert.doesNotMatch(plan.command, /--deny 'MCPTool'/);
    assert.doesNotMatch(plan.prompt, /solomap_write|solomap_link|solomap_export/);
  } finally { await ops.close(); store.close(); }
});

test('the final prompt assembly gives representative executable task families the same database memory contract', async () => {
  const { prepareAgentRun } = require('../out/agentRunPreparation.js');
  const base = fixtureRoot('solomap-memory-contract-matrix-');
  const runKinds = ['step', 'solo', 'flow_planner', 'agent_review_revision', 'migration_review', 'skill_install', 'agent_cli_upgrade'];
  for (const [index, runKind] of runKinds.entries()) {
    const caseRoot = path.join(base, String(index)); const root = path.join(caseRoot, 'global'); const project = path.join(caseRoot, 'project'); fs.mkdirSync(caseRoot); fs.mkdirSync(project);
    const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
    const call = (operation, input) => ops({ operation, input });
    try {
      const prepared = await prepareAgentRun({ agentCli: 'claude', selectedModel: '', prompt: `任务：${runKind}`, workspaceRoot: project, nodeId: `node-${index}`, executionLogId: 100 + index, userMessage: runKind, runKind, globalDataPath: root, taskPermissionMode: 'auto' }, call);
      const plan = await call('read_run_execution_plan', { root: project, executionLogId: prepared.status.rootExecutionLogId });
      assert.equal((plan.prompt.match(/SoloMap 数据库记忆系统（每个任务必须执行）：/g) || []).length, 1, runKind);
      assert.match(plan.prompt, /实现或判断前.*solomap_context/, runKind);
      if (runKind.startsWith('migration_')) {
        assert.match(plan.prompt, /本轮对数据库记忆仅可检索和读取/, runKind);
        assert.doesNotMatch(plan.prompt, /solomap_write|solomap_link|solomap_export/, runKind);
      } else assert.match(plan.prompt, /任务收尾.*未来任务仍会复用/, runKind);
    } finally { await ops.close(); store.close(); }
  }
});

test('unattended review corrections continue the selected native session while keeping durable task identity', async () => {
  const { prepareAgentRun } = require('../out/agentRunPreparation.js');
  const base = fixtureRoot('solomap-review-native-revision-');
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const sessionId = 'cc70ea64-51ec-41ef-842b-72f62bb8b7b3';
    for (const agentCli of ['claude', 'codex', 'agy']) {
      const input = { agentCli, selectedModel: 'original-model', prompt: '完整修正要求🌿', workspaceRoot: project, nodeId: 'step', executionLogId: 0, userMessage: '原始目标', runKind: 'agent_review_revision', globalDataPath: root, taskPermissionMode: 'auto', nativeSessionId: sessionId, continuation: true, launchIntentId: `revision:${agentCli}` };
      const prepared = await prepareAgentRun(input, call);
      const plan = await call('read_run_execution_plan', { root: project, executionLogId: prepared.status.rootExecutionLogId });
      assert.equal(plan.status.sessionMode, 'resume'); assert.equal(plan.status.interactiveSession, false);
      assert.equal(plan.status.plannedNativeSessionId, sessionId);
      assert.equal(plan.status.agentLaunch.continuation, true);
      assert.match(plan.command, agentCli === 'claude' ? /-p --resume/ : agentCli === 'codex' ? /runCodexContinuation\.js/ : /printf %s/);
      assert.doesNotMatch(plan.command.replace(shellQuote(project), '<workspace>'), /prompt\.txt|agent-runs/);
    }
  } finally { await ops.close(); store.close(); }
});
