const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openAnalysisOwner } = require('./analysis-fixture.js');
const { runtimeProjectMcpSource } = require('../out/runtimeDataOperations.js');
const { createIntelligenceMcpSession } = require('../out/intelligenceMcp.js');
const { startTelegramExtensionBridge } = require('../out/telegramExtensionBridge.js');
const { getAgentRunDeliveryOwner } = require('../out/agentRunPreparation.js');
const { createFlowTrace, createFlowLoop } = require('../out/flowStore.js');

function cleanFixture(root) {
  if (!fs.existsSync(root)) return;
  for (const name of fs.readdirSync(root)) {
    const target = path.join(root, name);
    if (fs.lstatSync(target).isDirectory()) cleanFixture(target);
    else fs.unlinkSync(target);
  }
  fs.rmdirSync(root);
}

async function fixture(t, afterPrepared, beforePrepared) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-conversation-tracking-'));
  const sessions = [];
  let bridge;
  t.after(async () => { for (const session of sessions) await session.close(); bridge?.dispose(); });
  fs.mkdirSync(path.join(base, '.git'));
  const root = path.join(base, '.solomap-global');
  const projects = ['Alpha', 'Beta'].map(name => ({ name, path: path.join(base, name) }));
  for (const project of projects) fs.mkdirSync(path.join(project.path, '.git'), { recursive: true });
  const f = await openAnalysisOwner(t, root, projects);
  t.after(() => cleanFixture(base));
  const call = (operation, input) => f.ops({ operation, input });
  await f.store.initializeProjectRegistry({ legacyProjects: projects, legacySelectedProjectPath: projects[0].path });
  f.store.patchHostSettings({ namespace: 'telegram', ownerScope: 'global', idempotencyKey: 'tg', patches: [
    { key: 'enabled', expectedRevision: 0, value: true },
    { key: 'chatId', expectedRevision: 0, value: '1234' },
    { key: 'replyGeneration', expectedRevision: 0, value: 3 }
  ] });
  const owner = await getAgentRunDeliveryOwner();
  const conversationId = crypto.randomUUID();
  async function session(chat = conversationId, project = projects[0]) {
    const operationId = crypto.randomUUID();
    if (chat !== null) f.store.admitLegacyIntelligenceOperation({ operationId, conversationId: chat, requestKey: operationId,
      prompt: '本轮请求', baselineRevision: 0, source: 'telegram', ownerPid: owner.pid, ownerBirth: owner.birth });
    const source = await runtimeProjectMcpSource(root, project.path, chat === null ? undefined : operationId);
    const mcp = await createIntelligenceMcpSession({ getProjects: () => projects, getSelectedProjectPath: () => project.path,
      getCurrentSteps: () => [], getSettings: () => ({ language: 'zh' }) }, source);
    sessions.push(mcp);
    return { ...mcp, source, operationId, finish() { f.store.markLegacyIntelligenceOperation(operationId, 'failed'); } };
  }
  let deliveries = 0;
  bridge = await startTelegramExtensionBridge(root, async (_command, args) => {
    deliveries++;
    const input = JSON.parse(args[0]);
    await beforePrepared?.(input);
    if (input.message === '启动失败') throw new Error('fixture_launch_failed');
    if (input.mode === 'flow') {
      const flow = createFlowTrace(input.projectPath, input.message);
      flow.flowId = `flow-${crypto.createHash('sha256').update(input.launchIntentId).digest('hex').slice(0, 32)}`;
      flow.status = 'running'; flow.loops = [createFlowLoop(input.message, 1)];
      await call('write_flow_trace', { root: input.projectPath, flow, expectedRevision: 0, idempotencyKey: input.launchIntentId });
    } else {
      await call('prepare_run_intent', { root: input.projectPath, launchIntentId: input.launchIntentId,
        nodeId: input.mode === 'solo' ? '__solo__' : input.stepId, runKind: input.mode,
        prompt: input.message, command: 'fixture-agent', userMessage: input.message, status: 'Running',
        metadata: { interactiveSession: true, launchIntentHash: 'fixture-hash' },
        launchRequest: { workspaceRoot: input.projectPath, agentCli: 'fixture-agent' }, deliveryOwner: owner, idempotencyKey: input.launchIntentId });
      if (input.message === '准备后失败') throw new Error('fixture_terminal_failed');
    }
    await afterPrepared?.({ ...f, root, input });
    return { status: 'started', projectPath: input.projectPath, mode: input.mode };
  });
  async function tool(mcp, name, args = {}) {
    const result = await mcp.client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  }
  async function settle(launch, status = 'Completed', report, defer = false) {
    let state = f.store.readRunCheckpointState(launch.projectId, launch.executionLogId);
    if (report) {
      f.store.submitRunReport(state.projectId, { executionLogId: launch.executionLogId, generation: state.generation,
        turnId: state.turnId, report, availability: 'available', idempotencyKey: `${state.turnId}:report` });
      state = f.store.readRunCheckpointState(launch.projectId, launch.executionLogId);
    }
    const done = await call('checkpoint_run', { projectId: state.projectId, executionLogId: state.status.executionLogId,
      generation: state.generation, proof: state.proof, expectedRevision: state.revision, expectedTurnId: state.turnId,
      action: 'complete', outcome: status === 'Failed' ? 'failed' : 'candidate_complete', summary: '已完成要求并验证',
      idempotencyKey: `${state.turnId}:done` });
    const scope = { projectId: state.projectId, executionLogId: state.status.executionLogId, generation: done.generation,
      expectedRevision: done.revision, expectedTurnId: done.turnId };
    const lease = defer ? { token: '' } : await call('claim_run_consumer', { ...scope, owner });
    const input = { ...scope, token: lease.token, journal: { agentCli: 'fixture-agent', command: 'fixture-agent',
      output: '任务结果', status }, digest: { schemaVersion: 2, runId: state.runId, executionLogId: state.status.executionLogId,
      nodeId: state.status.nodeId, outcome: '已完成要求并验证', changedFiles: ['src/example.ts'] }, idempotencyKey: `${state.turnId}:settle` };
    if (!defer) await call('commit_run_settlement', input);
    return { input, done };
  }
  return { ...f, base, owner, root, projects, call, session, tool, settle, deliveries: () => deliveries };
}

test('launch returns a durable reference and read-only query follows completion while the session remains alive', async t => {
  const f = await fixture(t); const s = await f.session();
  assert.ok((await s.client.listTools()).tools.find(tool => tool.name === 'solomap_get_conversation')?.annotations.readOnlyHint);
  const input = { project: 'Beta', mode: 'solo', message: '完成示例功能', idempotencyKey: 'one' };
  const launched = await f.tool(s, 'solomap_start_conversation', input);
  assert.ok(launched.conversationRef); assert.ok(launched.runId); assert.ok(launched.executionLogId);
  assert.equal((await f.tool(s, 'solomap_get_conversation', { ref: launched.conversationRef })).state, 'running');
  assert.equal((await f.tool(s, 'solomap_start_conversation', input)).conversationRef, launched.conversationRef);
  assert.equal(f.deliveries(), 1);
  const settled = await f.settle(launched);
  const result = await f.tool(s, 'solomap_get_conversation', { ref: launched.conversationRef });
  assert.equal(result.state, 'waiting'); assert.equal(result.turnCompleted, true);
  assert.equal(result.outcome, 'candidate_complete'); assert.equal(result.result.summary, '已完成要求并验证');
  assert.deepEqual(result.result.changedFiles, ['src/example.ts']);
  assert.equal((await f.call('read_run_state', { projectId: launched.projectId, executionLogId: launched.executionLogId })).status.interactiveSession, true);
  const before = f.store.db.getRowsModified();
  const writes = f.store.rows('SELECT total_changes() AS n')[0].n;
  for (let n = 0; n < 5; n++) await f.tool(s, 'solomap_get_conversation', { ref: launched.conversationRef });
  assert.equal(f.store.rows('SELECT total_changes() AS n')[0].n, writes);
  assert.ok(before >= 0);
  await f.call('commit_run_settlement', settled.input);
  const notices = await f.call('list_notification_deliveries', { channel: 'telegram' });
  assert.equal(notices.items.length, 1); assert.equal(notices.items[0].payload.chatId, '1234');
  assert.equal(notices.items[0].payload.replyGeneration, 3);
  assert.match(notices.items[0].payload.text, /完成示例功能/); assert.match(notices.items[0].payload.text, /已完成要求并验证/);
  s.finish(); const reopened = await f.session(undefined, f.projects[1]);
  assert.equal((await f.tool(reopened, 'solomap_get_conversation', {})).latest[0].conversationRef, launched.conversationRef);
  const other = await f.session(crypto.randomUUID());
  assert.equal((await other.client.callTool({ name: 'solomap_get_conversation', arguments: { ref: launched.conversationRef } })).isError, true);
});

test('Step failures and launch failures remain queryable without claiming completion', async t => {
  const f = await fixture(t); const s = await f.session();
  const launched = await f.tool(s, 'solomap_start_conversation', { project: 'Alpha', mode: 'step', stepId: 'S01', message: '执行环节', idempotencyKey: 'step' });
  assert.ok(launched.projectId); assert.ok(launched.executionLogId);
  await f.settle(launched, 'Failed');
  const result = await f.tool(s, 'solomap_get_conversation', { ref: launched.conversationRef });
  assert.equal(result.state, 'failed'); assert.equal(result.turnCompleted, true);
  assert.equal((await s.client.callTool({ name: 'solomap_start_conversation', arguments: { project: 'Alpha', mode: 'solo', message: '启动失败', idempotencyKey: 'fail' } })).isError, true);
  const recent = await f.tool(s, 'solomap_get_conversation');
  assert.equal(recent.latest[0].state, 'launch_failed'); assert.match(recent.latest[0].error, /fixture_launch_failed/);
});

test('Flow query and notification follow the whole flow rather than a completed role', async t => {
  const f = await fixture(t); const s = await f.session();
  const launched = await f.tool(s, 'solomap_start_conversation', { project: 'Alpha', mode: 'flow', message: '交付完整网站', idempotencyKey: 'flow' });
  assert.ok(launched.flowId);
  let snapshot = await f.call('read_flow_trace', { projectId: launched.projectId, flowId: launched.flowId });
  snapshot.flow.loops[0].planner.status = 'completed';
  await f.call('write_flow_trace', { projectId: launched.projectId, flow: snapshot.flow, expectedRevision: snapshot.revision, idempotencyKey: 'planner-complete' });
  assert.equal((await f.tool(s, 'solomap_get_conversation', { ref: launched.conversationRef })).state, 'running');
  assert.equal((await f.call('list_notification_deliveries', { channel: 'telegram' })).items.length, 0);
  snapshot = await f.call('read_flow_trace', { projectId: launched.projectId, flowId: launched.flowId });
  snapshot.flow.status = 'completed'; snapshot.flow.latestSummary = '网站已交付，检查通过'; snapshot.flow.completedAt = new Date().toISOString();
  const input = { projectId: launched.projectId, flow: snapshot.flow, expectedRevision: snapshot.revision, idempotencyKey: 'flow-complete' };
  await f.call('write_flow_trace', input); await f.call('write_flow_trace', input);
  const result = await f.tool(s, 'solomap_get_conversation', { ref: launched.conversationRef });
  assert.equal(result.state, 'completed'); assert.equal(result.result.summary, '网站已交付，检查通过');
  assert.equal((await f.call('list_notification_deliveries', { channel: 'telegram' })).items.length, 1);
});

test('query returns the settled report and never reuses it for the next active turn', async t => {
  const f = await fixture(t); const s = await f.session();
  const launched = await f.tool(s, 'solomap_start_conversation', { project: 'Alpha', mode: 'solo', message: '输出交付物', idempotencyKey: 'report' });
  const report = { schemaVersion: 1, summary: '交付物已生成', unmetRequirements: [], decisions: [], corrections: [],
    verification: ['实际验证通过', { summary: '', result: '产物检查通过', evidence: ['本地记录'] }], commits: [], experienceUsage: [], lessons: [], artifacts: ['docs/result.md'] };
  await f.settle(launched, 'Completed', report);
  const result = await f.tool(s, 'solomap_get_conversation', { ref: launched.conversationRef });
  assert.deepEqual(result.result.report, report); assert.deepEqual(result.result.artifacts, ['docs/result.md']);
  assert.deepEqual(result.result.verification, report.verification);
  const notice = (await f.call('list_notification_deliveries', { channel: 'telegram' })).items[0].payload.text;
  assert.match(notice, /实际验证通过/); assert.match(notice, /产物检查通过/); assert.doesNotMatch(notice, /\[object Object\]/);
  let state = f.store.readRunCheckpointState(launched.projectId, launched.executionLogId);
  await f.call('checkpoint_run', { projectId: state.projectId, executionLogId: launched.executionLogId, generation: state.generation,
    proof: state.proof, expectedRevision: state.revision, expectedTurnId: state.turnId, action: 'start', message: '继续修改', idempotencyKey: 'next-turn' });
  const next = await f.tool(s, 'solomap_get_conversation', { ref: launched.conversationRef });
  assert.equal(next.state, 'running'); assert.equal(next.turnCompleted, false); assert.equal(next.result, null);
  assert.notEqual(next.turnId, result.turnId);
});

test('a Telegram rebind before settlement cannot send the old task result to the new binding', async t => {
  const f = await fixture(t); const s = await f.session();
  const launched = await f.tool(s, 'solomap_start_conversation', { project: 'Alpha', mode: 'solo', message: '旧绑定任务', idempotencyKey: 'old-binding' });
  const settings = f.store.readHostSettings({ namespace: 'telegram', ownerScope: 'global' });
  f.store.patchHostSettings({ namespace: 'telegram', ownerScope: 'global', idempotencyKey: 'rebind', patches: [
    { key: 'chatId', expectedRevision: settings.items.find(item => item.key === 'chatId').revision, value: '5678' },
    { key: 'replyGeneration', expectedRevision: settings.items.find(item => item.key === 'replyGeneration').revision, value: 4 }
  ] });
  await f.settle(launched);
  assert.equal((await f.call('list_notification_deliveries', { channel: 'telegram' })).items.length, 0);
  const denied = await s.client.callTool({ name: 'solomap_get_conversation', arguments: { ref: launched.conversationRef } });
  assert.equal(denied.isError, true); assert.match(denied.content[0].text, /revoked/);
});

test('concurrent retries share one durable run and conflicting retries are rejected', async t => {
  const f = await fixture(t); const s = await f.session();
  const input = { project: 'Alpha', mode: 'solo', message: '只执行一次', idempotencyKey: 'concurrent' };
  const launches = await Promise.all([f.tool(s, 'solomap_start_conversation', input), f.tool(s, 'solomap_start_conversation', input)]);
  assert.equal(launches[0].conversationRef, launches[1].conversationRef);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM run_control')[0].n, 1);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM mcp_conversation_launches')[0].n, 1);
  const conflict = await s.client.callTool({ name: 'solomap_start_conversation', arguments: { ...input, message: '不同任务' } });
  assert.equal(conflict.isError, true); assert.match(conflict.content[0].text, /idempotency_conflict/);
});

test('a prepared task whose editor launch failed is never reported as started by a retry', async t => {
  const f = await fixture(t); const s = await f.session();
  const args = { project: 'Alpha', mode: 'solo', message: '准备后失败', idempotencyKey: 'prepared-failure' };
  assert.equal((await s.client.callTool({ name: 'solomap_start_conversation', arguments: args })).isError, true);
  assert.equal((await s.client.callTool({ name: 'solomap_start_conversation', arguments: args })).isError, true);
  const query = await f.tool(s, 'solomap_get_conversation');
  assert.equal(query.latest[0].state, 'launch_failed');
});

test('an earlier turn settling after the next turn starts still sends its own result', async t => {
  const f = await fixture(t); const s = await f.session();
  const launched = await f.tool(s, 'solomap_start_conversation', { project: 'Alpha', mode: 'solo', message: '分轮推进', idempotencyKey: 'late' });
  const first = await f.settle(launched, 'Completed', undefined, true);
  const currentProof = f.store.readRunCheckpointState(launched.projectId, launched.executionLogId).proof;
  await f.call('checkpoint_run', { projectId: launched.projectId, executionLogId: launched.executionLogId,
    generation: first.done.generation, proof: currentProof, expectedRevision: first.done.revision, expectedTurnId: first.done.turnId,
    action: 'start', message: '第二轮已经开始', idempotencyKey: 'start-before-settle' });
  first.input.token = f.store.claimRunConsumer(launched.projectId, { ...first.input, owner: f.owner }).token;
  await f.call('commit_run_settlement', first.input);
  assert.equal((await f.call('list_notification_deliveries', { channel: 'telegram' })).items.length, 1);
  const current = await f.tool(s, 'solomap_get_conversation', { ref: launched.conversationRef });
  assert.equal(current.state, 'running'); assert.equal(current.result, null);
});

test('closing a settled conversation preserves one notice and query uses the latest settled outcome', async t => {
  const f = await fixture(t); const s = await f.session();
  const launched = await f.tool(s, 'solomap_start_conversation', { project: 'Alpha', mode: 'solo', message: '结束会话', idempotencyKey: 'close' });
  const first = await f.settle(launched);
  const current = f.store.readRunCheckpointState(launched.projectId, launched.executionLogId);
  const closed = await f.call('checkpoint_run', { projectId: launched.projectId, executionLogId: launched.executionLogId,
    generation: current.generation, proof: current.proof, expectedRevision: current.revision, expectedTurnId: current.turnId,
    action: 'session-close', exitCode: 1, idempotencyKey: 'closed-with-error' });
  const scope = { executionLogId: launched.executionLogId, generation: closed.generation, expectedRevision: closed.revision, expectedTurnId: closed.turnId };
  const lease = f.store.claimRunConsumer(launched.projectId, { ...scope, owner: f.owner });
  await f.call('commit_run_settlement', { ...first.input, ...scope, token: lease.token,
    journal: { ...first.input.journal, status: 'Failed' }, digest: { ...first.input.digest, outcome: '关闭时发现错误' }, idempotencyKey: 'close-settle' });
  assert.equal((await f.call('list_notification_deliveries', { channel: 'telegram' })).items.length, 1);
  const result = await f.tool(s, 'solomap_get_conversation', { ref: launched.conversationRef });
  assert.equal(result.state, 'failed'); assert.equal(result.result.summary, '关闭时发现错误');
});

test('archiving a project cannot roll back ordinary task settlement or Flow completion', async t => {
  const f = await fixture(t); const s = await f.session();
  const ordinary = await f.tool(s, 'solomap_start_conversation', { project: 'Alpha', mode: 'solo', message: '归档前任务', idempotencyKey: 'archive-solo' });
  const flow = await f.tool(s, 'solomap_start_conversation', { project: 'Alpha', mode: 'flow', message: '归档前流程', idempotencyKey: 'archive-flow' });
  const project = f.store.readMetadata(ordinary.projectId);
  f.store.write({ kind: 'project', action: 'archive', scope: null, objectId: project.objectId, expectedRevision: project.revision, data: {}, idempotencyKey: 'archive-project' });
  await f.settle(ordinary);
  const snapshot = f.store.readFlowTrace(flow.projectId, flow.flowId);
  await f.call('write_flow_trace', { projectId: flow.projectId, flow: { ...snapshot.flow, status: 'completed', latestSummary: '已完成' },
    expectedRevision: snapshot.revision, idempotencyKey: 'archived-flow-complete' });
  assert.equal(f.store.readRunSettlements(ordinary.projectId, { turnId: f.store.readRunState(ordinary.projectId, ordinary.executionLogId).turnId }).items.length, 1);
  assert.equal((await f.call('list_notification_deliveries', { channel: 'telegram' })).items.length, 0);
  assert.equal((await s.client.callTool({ name: 'solomap_get_conversation', arguments: { ref: ordinary.conversationRef } })).isError, true);
});

test('independent MCP sessions without a bound Agent run cannot merge their tasks or idempotency keys', async t => {
  const f = await fixture(t); const a = await f.session(null); const b = await f.session(null);
  const input = { project: 'Alpha', mode: 'solo', message: '独立会话', idempotencyKey: 'same-key' };
  const first = await f.tool(a, 'solomap_start_conversation', input);
  const second = await f.tool(b, 'solomap_start_conversation', input);
  assert.notEqual(first.conversationRef, second.conversationRef);
  assert.equal((await f.tool(a, 'solomap_get_conversation')).latest.length, 1);
  assert.equal((await b.client.callTool({ name: 'solomap_get_conversation', arguments: { ref: first.conversationRef } })).isError, true);
  const settled = await f.settle(first, 'Completed', undefined, true);
  settled.input.token = f.store.claimRunConsumer(first.projectId, { ...settled.input, owner: f.owner }).token;
  await f.call('commit_run_settlement', { ...settled.input, effects: [{ kind: 'telegram', payload: {} }] });
  assert.equal(f.store.rows("SELECT COUNT(*) AS n FROM run_effects WHERE kind='telegram'")[0].n, 1);
});

test('cross-project task export stays portable and excludes host Telegram associations', async t => {
  const f = await fixture(t); const s = await f.session();
  const launch = await f.tool(s, 'solomap_start_conversation', { project: 'Beta', mode: 'solo', message: '可移植项目任务', idempotencyKey: 'portable' });
  fs.writeFileSync(path.join(f.projects[1].path, '.solopreneur', 'roadmap.csv'), require('../out/db/csvStore.js').serializeRoadmapNodes([
    { id: 'S01', title: '示例环节', status: 'Pending', parentId: null, priority: 'P2', assignee: 'user', startDate: '', dueDate: '', dependencies: [] }
  ]));
  await f.call('accept_roadmap_csv', { root: f.projects[1].path });
  const destination = path.join(f.base, 'project-export.json');
  await f.store.exportProject({ root: f.projects[1].path, destination, idempotencyKey: 'export-tracked' });
  const archive = JSON.parse(fs.readFileSync(destination, 'utf8')).archive;
  assert.equal(archive.tables.some(table => table.name === 'mcp_conversation_launches'), false);
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const imported = new UnifiedDataStore(path.join(f.base, 'imported-data'));
  try {
    const target = path.join(f.base, 'imported-project'); fs.mkdirSync(target);
    const result = await imported.importProject({ root: target, source: destination, idempotencyKey: 'import-tracked' });
    assert.equal(result.projectId, launch.projectId);
    assert.equal(imported.rows('PRAGMA foreign_key_check').length, 0);
    assert.equal(imported.rows('SELECT COUNT(*) AS n FROM mcp_conversation_launches')[0].n, 0);
  } finally { imported.close(); }
});

test('failed attempts are bounded, task-backed references persist, and repeated queries do not grow SQLite', async t => {
  const f = await fixture(t); const s = await f.session();
  const retained = await f.tool(s, 'solomap_start_conversation', { project: 'Alpha', mode: 'solo', message: '保留真实任务', idempotencyKey: 'retained' });
  for (let i = 0; i < 25; i++) await s.client.callTool({ name: 'solomap_start_conversation', arguments: {
    project: 'Alpha', mode: 'solo', message: '启动失败', idempotencyKey: `failure-${i}` } });
  const counts = f.store.readDatabaseStorage().conversationLaunches;
  assert.deepEqual(counts, { records: 21, taskBacked: 1, failedAttempts: 20, activeDispatches: 0 });
  assert.equal((await f.tool(s, 'solomap_get_conversation', { ref: retained.conversationRef })).runId, retained.runId);
  const origin = f.store.rows('SELECT origin_key FROM mcp_conversation_launches WHERE ref=?', [retained.conversationRef])[0].origin_key;
  const before = f.store.databaseStorageFileSizes().databaseBytes;
  const associationBytes = () => Number(f.store.rows("SELECT COALESCE(SUM(pgsize),0) AS bytes FROM dbstat WHERE name IN (SELECT name FROM sqlite_schema WHERE tbl_name IN ('mcp_conversation_launches','mcp_conversation_dispatches'))")[0].bytes);
  const associationBefore = associationBytes();
  f.store.db.run('BEGIN IMMEDIATE');
  for (let i = 0; i < 2000; i++) f.store.db.run(`INSERT INTO mcp_conversation_launches(ref,origin_key,owner_project_id,project_id,request_key,intent_hash,launch_intent_id,mode,flow_id,title,source,chat_id,reply_generation,created_at,error)
    SELECT ?,origin_key,owner_project_id,project_id,?,intent_hash,?,'solo','',title,source,chat_id,reply_generation,created_at,'' FROM mcp_conversation_launches WHERE ref=?`,
    [crypto.randomUUID(), `history-${i}`, `history:${i}`, retained.conversationRef]);
  f.store.db.run('COMMIT');
  const growth = f.store.databaseStorageFileSizes().databaseBytes - before;
  const associationGrowth = associationBytes() - associationBefore;
  assert.ok(growth < 2000 * 8192, `association table plus indexes/WAL grew ${growth} bytes`);
  assert.ok(associationGrowth > 0 && associationGrowth < 2000 * 8192, `association table plus indexes use ${associationGrowth} additional bytes`);
  const writes = f.store.rows('SELECT total_changes() AS n')[0].n;
  const plan = f.store.rows('EXPLAIN QUERY PLAN SELECT * FROM mcp_conversation_launches WHERE origin_key=? AND project_id IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC LIMIT ?', [origin, JSON.stringify([retained.projectId]), 5]);
  assert.match(JSON.stringify(plan), /mcp_conversation_launches_recent/);
  for (let i = 0; i < 10; i++) assert.equal((await f.tool(s, 'solomap_get_conversation')).latest.length, 5);
  assert.equal(f.store.rows('SELECT total_changes() AS n')[0].n, writes);
  t.diagnostic(`2000 history associations: table+index growth=${associationGrowth} bytes, database+WAL growth=${growth} bytes; recent-query index used; 10 unchanged queries wrote 0 rows; failed-attempt retention=20; active dispatches=0`);
});

test('schema 52 upgrades in place and reopening schema 54 preserves identities and source rows', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-conversation-tracking-upgrade-'));
  try {
    const root = path.join(base, '.solomap-global'); fs.mkdirSync(root);
    const { DatabaseSync } = require('node:sqlite');
    const migrations = require('../out/db/unifiedSchemaMigrations.js').unifiedSchemaMigrations;
    const sql = fs.readFileSync(path.join(__dirname, 'fixtures/unified-schema-v1.sql'), 'utf8');
    const db = new DatabaseSync(path.join(root, 'solomap.db'));
    db.exec(sql); db.prepare('INSERT INTO schema_migrations VALUES(1,?,1)').run(crypto.createHash('sha256').update(sql).digest('hex'));
    for (const migration of migrations.filter(item => item.version <= 52)) {
      db.exec(migration.sql); db.prepare('INSERT INTO schema_migrations VALUES(?,?,1)').run(migration.version, crypto.createHash('sha256').update(migration.sql).digest('hex'));
    }
    db.prepare('INSERT INTO database_meta VALUES(?,?)').run('database_id', 'preserved-tracking-identity');
    db.exec("INSERT INTO pi_legacy_conversation_operations VALUES('old-operation','old-conversation','old-request','hash',0,1,'telegram',1,'old-owner',0,'settled',1,1)");
    db.close();
    const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
    for (let i = 0; i < 2; i++) {
      const store = new UnifiedDataStore(root);
      try {
        assert.equal(store.rows('SELECT MAX(version) AS version FROM schema_migrations')[0].version, 54);
        assert.equal(store.rows("SELECT value FROM database_meta WHERE key='database_id'")[0].value, 'preserved-tracking-identity');
        assert.equal(store.rows("SELECT source_generation FROM pi_legacy_conversation_operations WHERE operation_id='old-operation'")[0].source_generation, 0);
        assert.equal(store.rows('PRAGMA integrity_check')[0].integrity_check, 'ok');
        assert.deepEqual(store.rows('PRAGMA foreign_key_check'), []);
      } finally { store.close(); }
    }
  } finally { cleanFixture(base); }
});

test('the durable task identity is linked in its creation transaction before any editor acknowledgement', async t => {
  let observed = 0;
  const f = await fixture(t, ({ root, input }) => {
    const { DatabaseSync } = require('node:sqlite');
    const reader = new DatabaseSync(path.join(root, 'solomap.db'), { readOnly: true });
    try {
      const row = reader.prepare('SELECT acknowledged,run_id,flow_object_id FROM mcp_conversation_launches WHERE launch_intent_id=?').get(input.launchIntentId);
      assert.equal(row.acknowledged, 0);
      assert.ok(input.mode === 'flow' ? row.flow_object_id : row.run_id);
      observed++;
    } finally { reader.close(); }
  });
  const s = await f.session();
  for (const mode of ['solo', 'flow']) await f.tool(s, 'solomap_start_conversation', { project: 'Alpha', mode, message: '可靠保存任务关联', idempotencyKey: `atomic-${mode}` });
  assert.equal(observed, 2);
});

test('a Flow recovered by the existing task poller overrides a stale launch error and sends its result', async t => {
  const f = await fixture(t); const s = await f.session();
  const launch = await f.tool(s, 'solomap_start_conversation', { project: 'Alpha', mode: 'flow', message: '恢复后完成流程', idempotencyKey: 'flow-recovered' });
  f.store.db.run("UPDATE mcp_conversation_launches SET acknowledged=0,error='old_terminal_interruption' WHERE ref=?", [launch.conversationRef]);
  const snapshot = f.store.readFlowTrace(launch.projectId, launch.flowId);
  await f.call('write_flow_trace', { projectId: launch.projectId, flow: { ...snapshot.flow, status: 'completed', latestSummary: '恢复执行后已完成' },
    expectedRevision: snapshot.revision, idempotencyKey: 'poller-recovered-flow' });
  const query = await f.tool(s, 'solomap_get_conversation', { ref: launch.conversationRef });
  assert.equal(query.state, 'completed'); assert.equal(query.result.summary, '恢复执行后已完成');
  assert.equal((await f.call('list_notification_deliveries', { channel: 'telegram' })).items.length, 1);
});

test('legacy admission rejects an already revoked Telegram source generation before any tool can run', async t => {
  const f = await fixture(t); const operationId = crypto.randomUUID();
  assert.throws(() => f.store.admitLegacyIntelligenceOperation({ operationId, conversationId: crypto.randomUUID(), requestKey: operationId,
    prompt: '旧聊天请求', baselineRevision: 0, source: 'telegram', sourceGeneration: 2, ownerPid: f.owner.pid, ownerBirth: f.owner.birth }), /intelligence_reply_revoked/);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM pi_legacy_conversation_operations WHERE operation_id=?', [operationId])[0].n, 0);
});

test('failure retention cannot remove a concurrent retry while its editor dispatch is still active', async t => {
  let release, entered, attempts = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, undefined, async input => {
    if (input.message !== '并发恢复任务') return;
    attempts++;
    if (attempts === 2) { entered(); await gate; return; }
    throw new Error('fixture_attempt_failed');
  });
  const s = await f.session();
  const args = { project: 'Alpha', mode: 'solo', message: '并发恢复任务', idempotencyKey: 'retention-retry' };
  assert.equal((await s.client.callTool({ name: 'solomap_start_conversation', arguments: args })).isError, true);
  const ref = (await f.tool(s, 'solomap_get_conversation')).latest[0].conversationRef;
  const retry = f.tool(s, 'solomap_start_conversation', args);
  try {
    await waiting;
    assert.equal((await s.client.callTool({ name: 'solomap_start_conversation', arguments: args })).isError, true);
    for (let i = 0; i < 25; i++) await s.client.callTool({ name: 'solomap_start_conversation', arguments: {
      project: 'Alpha', mode: 'solo', message: '启动失败', idempotencyKey: `concurrent-fail-${i}` } });
  } finally { release(); }
  assert.equal((await retry).conversationRef, ref);
  assert.equal((await f.tool(s, 'solomap_get_conversation', { ref })).state, 'running');
});

test('Runtime startup recovers interrupted dispatches before read-only conversation queries', async t => {
  const f = await fixture(t); const s = await f.session();
  assert.equal((await s.client.callTool({ name: 'solomap_start_conversation', arguments: {
    project: 'Alpha', mode: 'solo', message: '启动失败', idempotencyKey: 'cold-start' } })).isError, true);
  const ref = (await f.tool(s, 'solomap_get_conversation')).latest[0].conversationRef;
  f.store.db.run("UPDATE mcp_conversation_launches SET error='' WHERE ref=?", [ref]);
  f.store.db.run('INSERT INTO mcp_conversation_dispatches VALUES(?,?,?,?)', [crypto.randomUUID(), ref, 2147483647, 'dead-owner']);
  assert.equal((await f.tool(s, 'solomap_get_conversation', { ref })).state, 'starting');
  f.ops.recoverRuns();
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM mcp_conversation_dispatches')[0].n, 0);
  const writes = f.store.rows('SELECT total_changes() AS n')[0].n;
  for (let i = 0; i < 3; i++) {
    const query = await f.tool(s, 'solomap_get_conversation', { ref });
    assert.equal(query.state, 'launch_failed'); assert.match(query.error, /已中断/);
  }
  assert.equal(f.store.rows('SELECT total_changes() AS n')[0].n, writes);
});

test('a launch reservation and its dispatch become durable together before any task exists', async t => {
  const f = await fixture(t); const s = await f.session();
  const projectId = f.projectIds.get(f.projects[0].path);
  const tracking = f.store.conversationTracking();
  const origin = tracking.origin('unused', s.operationId);
  tracking.reserve(projectId, projectId, origin, { mode: 'solo', message: '原子受理', idempotencyKey: 'atomic-reservation' });
  const { DatabaseSync } = require('node:sqlite');
  const reader = new DatabaseSync(path.join(f.root, 'solomap.db'), { readOnly: true });
  let ref;
  try {
    const row = reader.prepare('SELECT l.ref,d.id FROM mcp_conversation_launches l LEFT JOIN mcp_conversation_dispatches d ON d.ref=l.ref WHERE l.request_key=?').get('atomic-reservation');
    assert.ok(row.id, 'a committed reservation must already have its dispatch'); ref = row.ref;
  } finally { reader.close(); }
  f.ops.recoverRuns();
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM mcp_conversation_dispatches')[0].n, 1, 'startup must preserve a live dispatch');
  assert.equal((await f.tool(s, 'solomap_get_conversation', { ref })).state, 'starting');
  f.store.db.run('UPDATE mcp_conversation_dispatches SET owner_pid=?,owner_birth=? WHERE ref=?', [2147483647, 'dead-owner', ref]);
  f.ops.recoverRuns();
  assert.equal((await f.tool(s, 'solomap_get_conversation', { ref })).state, 'launch_failed');
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM mcp_conversation_dispatches')[0].n, 0);
});
