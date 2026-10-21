const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { IntelligenceConversationStore } = require('../out/intelligenceChat.js');
const { IntelligenceRuntime } = require('../out/intelligenceRuntime.js');
const { createIntelligenceMcpSession } = require('../out/intelligenceMcp.js');
const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
const { runtimeProjectMcpSource } = require('../out/runtimeDataOperations.js');
const { createTelegramIntelligenceReply } = require('../out/telegramIntelligenceChat.js');
const { startTelegramExtensionBridge, executeTelegramExtensionCommand } = require('../out/telegramExtensionBridge.js');
const { sendRuntimeDataRequest } = require('../out/autonomousRuntimeControl.js');

function cleanupExact(root) {
  if (!fs.existsSync(root)) return;
  const directories = [root];
  for (let index = 0; index < directories.length; index++) {
    for (const name of fs.readdirSync(directories[index])) {
      const target = path.join(directories[index], name);
      const stat = fs.lstatSync(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) directories.push(target);
      else fs.unlinkSync(target);
    }
  }
  directories.reverse().forEach(directory => fs.rmdirSync(directory));
}

async function fixture(t, mode, onLaunch) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-intelligence-launch-'));
  fs.mkdirSync(path.join(base, '.git'));
  const root = path.join(base, '.solomap-global');
  const project = path.join(base, 'alpha');
  const otherProject = path.join(base, 'beta');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(path.join(otherProject, '.git'), { recursive: true });
  let bridge;
  t.after(() => bridge?.dispose());
  const projects = [{ path: project, name: 'Alpha' }, { path: otherProject, name: 'Beta' }];
  const owner = await require('./analysis-fixture.js').openAnalysisOwner(t, root, projects);
  t.after(() => cleanupExact(base));
  await owner.store.initializeProjectRegistry({ legacyProjects: projects, legacySelectedProjectPath: project });
  const requestFile = path.join(base, 'model-request.json');
  const cli = path.join(base, 'codex');
  fs.writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.on('data', bytes => input += bytes);
process.stdin.on('end', () => {
  const request = JSON.parse(fs.readFileSync(${JSON.stringify(requestFile)}, 'utf8'));
  if (request.signalQuery) {
    const results = input.slice(input.lastIndexOf('USER:')).split('TOOLRESULT:').slice(1)
      .map(text => JSON.parse(text.trim().split('\\n')[0]));
    const page = results.length ? JSON.parse(results.at(-1).content[0].text) : null;
    if (!page || page.cursor) {
      const call = JSON.stringify({ toolCall: { name: 'solomap_project_signals', arguments: {
        project: 'Beta', kind: 'delivery', ...(page ? { cursor: page.cursor } : {})
      } } });
      return console.log(request.prefix + '\\n' + call);
    }
    const data = JSON.parse(results.map(result => JSON.parse(result.content[0].text).content).join(''));
    return console.log('已查到 ' + data.workflowRuns.length + ' 条 Actions，其中 ' + data.workflowRuns.filter(run => run.conclusion === 'failure').length + ' 条失败。');
  }
  if (request.maintenance) {
    const call = (name, args) => console.log(JSON.stringify({ toolCall: { name, arguments: args } }));
    if (input.lastIndexOf('TOOLRESULT:') <= input.lastIndexOf('USER:')) return call('solomap_project_signals', {});
    const line = input.slice(input.lastIndexOf('TOOLRESULT:') + 'TOOLRESULT:'.length).trim().split('\\n')[0];
    const result = JSON.parse(line);
    if (result.isError) return console.log('维护数据读取失败。');
    const value = JSON.parse(result.content[0].text);
    if (value.status === 'projects') return call('solomap_project_signals', { project: JSON.parse(value.content).projects.find(p => p.name === 'Beta').projectId, kind: 'security' });
    if (value.status === 'saved') {
      const alert = JSON.parse(value.content).alerts[0];
      return call('solomap_start_conversation', { project: value.projectId, mode: 'solo', message: alert.title + ' ' + alert.url, idempotencyKey: 'maintain-beta' });
    }
    return console.log(value.status === 'started' ? '维护任务已启动。' : '维护任务未启动。');
  }
  if (input.lastIndexOf('TOOLRESULT:') > input.lastIndexOf('USER:')) {
    const line = input.slice(input.lastIndexOf('TOOLRESULT:') + 'TOOLRESULT:'.length).trim().split('\\n')[0];
    const result = JSON.parse(line);
    if (result.isError) console.log('任务未启动。');
    else if (result.toolName === 'solomap_get_conversation') {
      const value = JSON.parse(result.content[0].text);
      console.log(value.latest[0]?.turnCompleted ? '任务本轮已完成。' : '任务正在执行。');
    } else console.log('任务已启动。');
  } else console.log(JSON.stringify({ toolCall: JSON.parse(fs.readFileSync(${JSON.stringify(requestFile)}, 'utf8')) }));
});
`, { mode: 0o700 });
  owner.store.patchHostSettings({ namespace: 'cognitive', ownerScope: 'global', idempotencyKey: 'launch-model', patches: [
    { key: 'mode', expectedRevision: 0, value: 'agent_cli' },
    { key: 'agentCli', expectedRevision: 0, value: cli },
    { key: 'model', expectedRevision: 0, value: 'auto' }
  ] });
  owner.store.patchHostSettings({ namespace: 'telegram', ownerScope: 'global', idempotencyKey: 'launch-chat-generation',
    patches: [{ key: 'replyGeneration', expectedRevision: 0, value: 0 },
      { key: 'enabled', expectedRevision: 0, value: true }, { key: 'chatId', expectedRevision: 0, value: '1234' }] });
  if (mode === 'harness') {
    owner.store.registerPiCompatibilityRelease('0.0.605', 'previous-build', 'previous-runtime');
    owner.store.recordPiCompatibilityDrain({ runtimeId: 'previous-runtime', releaseVersion: '0.0.605', buildId: 'previous-build',
      replacementVersion: '0.0.606', replacementBuildId: 'launch-build' });
  }
  const runtime = new IntelligenceRuntime(root, owner.store, owner.ops, 'launch-runtime', mode === 'harness' ? '0.0.606' : '0.0.605', 'launch-build');
  owner.ops.setIntelligenceRuntime(runtime);
  assert.equal(runtime.mode().mode, mode);
  const store = new IntelligenceConversationStore(root, async (messages, context) => {
    const mcp = await createIntelligenceMcpSession({
      getProjects: () => projects, getSelectedProjectPath: () => project,
      getCurrentSteps: () => [], getSettings: () => ({ language: 'zh' })
    }, await runtimeProjectMcpSource(root, project, context.operationId));
    try { return await new EmbeddedPiAgentEngine({ agentCli: cli, workingDirectory: root }).chat(messages, { selectedProject: 'Alpha', projects: ['Alpha'] }, mcp.client, context); }
    finally { await mcp.close(); }
  }, (_root, request) => owner.ops(request), true);
  let ids = {};
  const reply = createTelegramIntelligenceReply(() => store, () => ids, async next => { ids = next; }, () => 0);
  const launches = [];
  bridge = await startTelegramExtensionBridge(root, async (command, args) => {
    // The editor must still be able to call the Runtime while a native tool is in flight.
    await sendRuntimeDataRequest(root, { operation: 'read_database_overview', input: {} });
    const payload = JSON.parse(args[0]);
    launches.push({ command, ...payload });
    await onLaunch?.({ ...owner, root, runtime, payload });
    return { status: 'started', projectPath: payload.projectPath, mode: payload.mode };
  });
  return { ...owner, database: owner.store, root, project, otherProject, launches, store,
    async ask(input, chatId = crypto.randomUUID(), toolName = 'solomap_start_conversation') {
      fs.writeFileSync(requestFile, JSON.stringify(input.maintenance || input.signalQuery ? input : { name: toolName, arguments: input }));
      const answer = await reply(chatId, input.signalQuery ? 'Action没有数据吗' : '请开始这项任务');
      assert.equal((await store.get(ids[chatId])).messages.at(-1).content, answer);
      return answer;
    },
    disconnect() { bridge.dispose(); bridge = undefined; }
  };
}

for (const mode of ['legacy', 'harness']) {
  test(`${mode} Telegram executes a project query after a model preamble and reads every page before replying`, async t => {
    const f = await fixture(t, mode);
    const targetId = f.projectIds.get(f.otherProject);
    const token = f.database.reserveExternalRefresh(targetId, 'delivery', 'preamble-query');
    f.database.commitExternalRefresh(targetId, { key: 'delivery', ...token, requestedAt: Date.now(), cache: {
      schemaVersion: 1, syncedAt: '2026-10-21T04:10:29.484Z',
      workflowRuns: Array.from({ length: 26 }, (_, index) => ({ name: 'Security',
        displayTitle: 'Complete retained workflow record ' + index + ' '.repeat(160),
        status: 'completed', conclusion: index < 3 ? 'failure' : 'success' }))
    } });
    const answer = await f.ask({ signalQuery: true, prefix: '刚才只查了 Issues，还没查 Actions，所以目前不能判断有没有数据。' }, '1234');
    assert.equal(answer, '已查到 26 条 Actions，其中 3 条失败。');
    assert.doesNotMatch(answer, /toolCall|尚未返回|还没有返回/);
    assert.equal(f.launches.length, 0);
    if (mode === 'harness') {
      const calls = f.database.rows("SELECT status FROM pi_tool_invocations WHERE tool_name='solomap_project_signals'");
      assert.ok(calls.length > 1, 'the original JSON cache spans multiple tool result pages');
      assert.ok(calls.every(call => call.status === 'completed'));
    }
  });

  test(`${mode} Telegram reads another project database signals and starts an evidence-based task with queryable completion`, async t => {
    let run;
    const f = await fixture(t, mode, async ({ ops, payload }) => {
      run = await ops({ operation: 'prepare_run_intent', input: { root: payload.projectPath, launchIntentId: payload.launchIntentId,
        nodeId: '__solo__', runKind: 'solo', prompt: payload.message, command: 'isolated-agent', userMessage: payload.message,
        status: 'Running', metadata: { interactiveSession: true, launchIntentHash: 'maintenance-fixture' }, idempotencyKey: payload.launchIntentId } });
    });
    const targetId = f.projectIds.get(f.otherProject);
    const token = f.database.reserveExternalRefresh(targetId, 'security', 'maintenance-signal');
    f.database.commitExternalRefresh(targetId, { key: 'security', ...token, requestedAt: Date.now(), cache: {
      schemaVersion: 1, repo: 'owner/beta', syncedAt: '2026-10-20T00:00:00Z', message: '',
      alerts: [{ source: 'dependabot', title: '修复 Beta 依赖漏洞', severity: 'high', state: 'open', url: 'https://example.test/beta/security/7' }]
    } });
    fs.renameSync(f.project, f.project + '-unavailable');
    assert.equal(await f.ask({ maintenance: true }, '1234'), '维护任务已启动。');
    assert.equal(f.launches.length, 1);
    assert.equal(f.launches[0].projectPath, f.otherProject);
    assert.equal(f.launches[0].message, '修复 Beta 依赖漏洞 https://example.test/beta/security/7');
    assert.equal(await f.ask({}, '1234', 'solomap_get_conversation'), '任务正在执行。');
    const done = f.database.checkpointRun(targetId, { executionLogId: run.status.executionLogId, generation: run.generation,
      proof: run.proof, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'candidate_complete',
      summary: '依赖漏洞已修复并验证', idempotencyKey: 'maintenance-complete' });
    const owner = await require('../out/agentRunPreparation.js').getAgentRunDeliveryOwner();
    const scope = { executionLogId: run.status.executionLogId, generation: done.generation, expectedRevision: done.revision, expectedTurnId: done.turnId };
    const lease = f.database.claimRunConsumer(targetId, { ...scope, owner });
    f.database.commitRunSettlement(targetId, { ...scope, token: lease.token,
      journal: { agentCli: 'isolated-agent', command: 'isolated-agent', output: '依赖漏洞已修复并验证', status: 'Completed' },
      digest: { schemaVersion: 2, runId: run.runId, nodeId: '__solo__', executionLogId: run.status.executionLogId, outcome: '依赖漏洞已修复并验证' }, idempotencyKey: 'maintenance-settle' });
    assert.equal(await f.ask({}, '1234', 'solomap_get_conversation'), '任务本轮已完成。');
    if (mode === 'harness') assert.deepEqual(f.database.rows("SELECT replay FROM pi_tool_invocations WHERE tool_name='solomap_project_signals'").map(row => row.replay), ['safe', 'safe']);
  });

  test(`${mode} Telegram follow-up queries the original task and its settled result in the same chat`, async t => {
    let run;
    const f = await fixture(t, mode, async ({ ops, payload }) => {
      run = await ops({ operation: 'prepare_run_intent', input: { root: payload.projectPath, launchIntentId: payload.launchIntentId,
        nodeId: '__solo__', runKind: 'solo', prompt: payload.message, command: 'isolated-agent', userMessage: payload.message,
        status: 'Running', metadata: { interactiveSession: true, launchIntentHash: 'follow-up-fixture' }, idempotencyKey: payload.launchIntentId } });
    });
    const chatId = '1234';
    assert.equal(await f.ask({ project: 'Alpha', mode: 'solo', message: '执行后查询结果', idempotencyKey: 'follow-up' }, chatId), '任务已启动。');
    assert.equal(await f.ask({}, chatId, 'solomap_get_conversation'), '任务正在执行。');
    const done = f.database.checkpointRun(run.projectId, { executionLogId: run.status.executionLogId, generation: run.generation,
      proof: run.proof, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete',
      outcome: 'candidate_complete', summary: '交付已验证', idempotencyKey: 'follow-up-done' });
    const owner = await require('../out/agentRunPreparation.js').getAgentRunDeliveryOwner();
    const scope = { executionLogId: run.status.executionLogId, generation: done.generation, expectedRevision: done.revision, expectedTurnId: done.turnId };
    const lease = f.database.claimRunConsumer(run.projectId, { ...scope, owner });
    f.database.commitRunSettlement(run.projectId, { ...scope, token: lease.token,
      journal: { agentCli: 'isolated-agent', command: 'isolated-agent', output: '交付已验证', status: 'Completed' },
      digest: { schemaVersion: 2, runId: run.runId, nodeId: '__solo__', executionLogId: run.status.executionLogId, outcome: '交付已验证' }, idempotencyKey: 'follow-up-settle' });
    assert.equal(await f.ask({}, chatId, 'solomap_get_conversation'), '任务本轮已完成。');
    assert.equal(f.launches.length, 1);
    assert.equal(f.database.listNotificationDeliveries({ channel: 'telegram' }).items.length, 1);
    if (mode === 'harness') assert.deepEqual(f.database.rows("SELECT replay FROM pi_tool_invocations WHERE tool_name='solomap_get_conversation'").map(row => row.replay), ['safe', 'safe']);
  });

  test(`${mode} intelligence chat launches Solo, Step and Flow through the existing project bridge`, async t => {
    const f = await fixture(t, mode);
    for (const targetMode of ['solo', 'step', 'flow']) {
      assert.equal(await f.ask({ project: 'Alpha', mode: targetMode, message: `执行 ${targetMode} 任务`,
        ...(targetMode === 'step' ? { stepId: 'S01' } : {}), idempotencyKey: `launch-${targetMode}` }), '任务已启动。');
      assert.deepEqual({ ...f.launches.at(-1), launchIntentId: '<stable>' }, {
        command: 'solopreneur.internalStartConversation', projectPath: f.project, mode: targetMode,
        message: `执行 ${targetMode} 任务`, ...(targetMode === 'step' ? { stepId: 'S01' } : {}), launchIntentId: '<stable>'
      });
      assert.match(f.launches.at(-1).launchIntentId, /^mcp:[a-f0-9-]{36}$/);
    }
    assert.equal(f.launches.length, 3);
    if (mode === 'harness') {
      assert.deepEqual(f.database.rows('SELECT tool_name,replay,status FROM pi_tool_invocations').map(row => ({ ...row })),
        Array.from({ length: 3 }, () => ({ tool_name: 'solomap_start_conversation', replay: 'never', status: 'completed' })));
    }
  });

  test(`${mode} intelligence chat never reports an invalid or unavailable launch as started`, async t => {
    const f = await fixture(t, mode);
    for (const input of [
      { project: 'Unknown', mode: 'solo' },
      { project: 'Alpha', mode: 'step' },
      { project: 'Alpha', mode: 'solo', stepId: 'S01' }
    ]) {
      assert.equal(await f.ask({ ...input, message: '不应执行', idempotencyKey: crypto.randomUUID() }), '任务未启动。');
      assert.equal(f.launches.length, 0);
    }
    f.disconnect();
    assert.equal(await f.ask({ project: 'Alpha', mode: 'solo', message: '编辑器离线', idempotencyKey: 'offline' }), '任务未启动。');
    assert.equal(f.launches.length, 0);
  });
}

for (const outcome of ['failed', 'cancelled']) {
  test(`native task launch preserves acknowledged editor writes when the source turn is ${outcome}`, async t => {
    let cancellation;
    const f = await fixture(t, 'harness', async ({ root, runtime, payload }) => {
      await sendRuntimeDataRequest(root, { operation: 'prepare_run', input: {
        root: payload.projectPath, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: payload.message,
        command: 'isolated-editor-fixture', userMessage: payload.message, status: 'Failed',
        metadata: { failureReason: 'fixture_editor_launch_failed' }, idempotencyKey: 'editor-failed-run'
      } });
      await sendRuntimeDataRequest(root, { operation: 'patch_host_settings', input: {
        namespace: 'extension', ownerScope: 'global', idempotencyKey: 'editor-record',
        patches: [{ key: 'launchEvidence', expectedRevision: 0, value: 'acknowledged' }]
      } });
      if (outcome === 'failed') throw new Error('fixture_editor_launch_failed');
      cancellation = runtime.cancel({ source: 'telegram' });
    });
    const launch = f.ask({ project: 'Alpha', mode: 'solo', message: '记录启动状态', idempotencyKey: outcome });
    if (outcome === 'failed') assert.equal(await launch, '任务未启动。');
    else { await assert.rejects(launch, /intelligence_operation_(?:aborted|failed)/); await cancellation; }
    assert.equal(f.database.readHostSettings({ namespace: 'extension', ownerScope: 'global' }).items
      .find(item => item.key === 'launchEvidence')?.value, 'acknowledged');
    const recorded = f.database.readRunState(f.projectIds.get(f.project), 1);
    assert.equal(recorded.status.status, 'Failed');
    assert.equal(f.database.read(recorded.taskId).kind, 'task');
    if (outcome === 'cancelled') assert.equal(f.database.rows('SELECT cancel_requested FROM pi_conversation_operations')[0].cancel_requested, 1);
  });
}

test('revocation before the editor request is sent produces no launch side effect', async t => {
  const f = await fixture(t, 'harness');
  await assert.rejects(executeTelegramExtensionCommand(f.root, 'solopreneur.internalStartConversation', [JSON.stringify({
    projectPath: f.project, mode: 'solo', message: 'must not launch', launchIntentId: 'revoked'
  })], () => { throw new Error('fixture_revoked_before_send'); }), /fixture_revoked_before_send/);
  assert.equal(f.launches.length, 0);
});

test('another SQLite owner cannot take over between the final launch check and socket write', async t => {
  const f = await fixture(t, 'harness');
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const contender = UnifiedDataStore.open(f.root);
  contender.db.run('PRAGMA busy_timeout=0');
  const original = net.Socket.prototype.write;
  let attempted = false;
  net.Socket.prototype.write = function (bytes, ...args) {
    if (typeof bytes === 'string' && bytes.includes('"command":"solopreneur.internalStartConversation"')) {
      attempted = true;
      assert.throws(() => contender.claimPiExecutionOwner('competing-owner'), /locked|busy/i);
    }
    return original.call(this, bytes, ...args);
  };
  try {
    assert.equal(await f.ask({ project: 'Alpha', mode: 'solo', message: '保留已授权启动', idempotencyKey: 'send-fence' }), '任务已启动。');
    assert.equal(attempted, true);
    assert.equal(f.launches.length, 1);
  } finally { net.Socket.prototype.write = original; contender.close(); }
});

test('intelligence chat without a project data source cannot launch conversations', async () => {
  const session = await createIntelligenceMcpSession({ getProjects: () => [], getSelectedProjectPath: () => '',
    getCurrentSteps: () => null, getSettings: () => ({ language: 'zh' }) });
  try { assert.equal((await session.client.listTools()).tools.some(tool => tool.name === 'solomap_start_conversation'), false); }
  finally { await session.close(); }
});
