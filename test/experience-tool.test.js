const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations, runtimeMcpSource } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');
const { anonymousToolEnv } = require('./analysis-fixture.js');

const projectRoot = path.resolve(__dirname, '..');
const toolPath = path.join(projectRoot, 'resources', 'tools', 'solomap-experience.cjs');

test('experience retrieve returns structured lessons and rejects generic URL matches', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-experience-retrieve-'));
  const workspace = path.join(root, 'app');
  const globalRoot = path.join(root, '.solomap-global');
  const digestRoot = path.join(workspace, '.solopreneur', 'run-digests');
  fs.mkdirSync(digestRoot, { recursive: true });
  const store = new UnifiedDataStore(globalRoot); const ops = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: globalRoot, runtimeId: 'experience-owner', onCommand: () => ({ status: 'running' }), onData: ops });
  try {
  const project = await ops({ operation: 'register_project', input: { root: workspace } });
  const env = anonymousToolEnv();
  fs.writeFileSync(path.join(digestRoot, 'solo-1.json'), JSON.stringify({
    schemaVersion: 2,
    runId: 'solo-1',
    executionLogId: 7,
    nodeId: '__solo__',
    runKind: 'solo',
    agentCli: 'codex',
    status: 'Completed',
    finishedAt: '2026-07-21T00:00:00.000Z',
    userIntent: '优化首次提示词的经验账本索引',
    outcome: '首次提示词改为按需检索经验账本。',
    changedFiles: ['src/extension.ts'],
    touchedFiles: ['resources/tools/solomap-experience.cjs'],
    verification: ['node --test test/experience-tool.test.js'],
    failures: [],
    reusableSignals: []
  }));
  const valuable = store.write({ kind: 'lesson', action: 'create', scope: project.projectId, idempotencyKey: 'valuable-lesson', data: {
    summary: '首次提示词只保留经验账本入口，按具体功能和文件检索高价值结论。',
    applies_when: 'Agent 需要历史经验但当前提示词应保持精简时。',
    do_this: '使用 retrieve 查询，并优先读取结构化经验和证据入口。',
    avoid_this: '不要把原始运行记录或无关历史任务注入首次提示词。',
    does_not_apply_when: '没有可信原文时。', verification: '读取固定版本原文再验证。', confidence: 0.9, status: 'approved'
  } });
  store.write({ kind: 'lesson', action: 'create', scope: project.projectId, idempotencyKey: 'noise-lesson', data: {
    summary: '执行失败模式待复用排障：ERROR: You have hit your usage limit. https://example.com/usage',
    applies_when: '任何任务。', do_this: '重试。', avoid_this: '无。', confidence: 0.5,
    status: 'candidate'
  } });
  const rejected = store.write({ kind: 'lesson', action: 'create', scope: project.projectId, idempotencyKey: 'rejected-lesson', data: {
    status: 'rejected', summary: '首次提示词经验账本索引应该重新注入全部历史运行正文。',
    applies_when: '首次提示词加载经验账本索引时。', do_this: '注入全部原文。', confidence: 1
  } });
  await ops({ operation: 'import_project_data', input: { collection: 'run-digests', projectRoot: workspace, sourceRoot: digestRoot, idempotencyKey: 'experience-digests' } });
  await ops.waitForMigrations();
  fs.renameSync(digestRoot, `${digestRoot}-retained-evidence`);

  const result = JSON.parse((await promisify(childProcess.execFile)(process.execPath, [
    toolPath,
    'retrieve',
    '--project', workspace,
    '--global', globalRoot,
    '--query', '首次提示词 经验账本索引',
    '--limit', '5',
    '--json'
  ], { encoding: 'utf8', env })).stdout);

  assert.equal(result.command, 'retrieve');
  assert.equal(result.payload.lessons.length, 1);
  assert.equal(result.payload.lessons[0].id, valuable.objectId);
  assert.match(result.payload.lessons[0].doThis, /retrieve/);
  assert.equal(result.payload.lessons[0].doesNotApplyWhen, '没有可信原文时。');
  assert.equal(result.payload.lessons[0].verification, '读取固定版本原文再验证。');
  assert.deepEqual(result.payload.lessons[0].sourceRef, { objectId: valuable.objectId, revision: 1 });
  assert.equal(result.payload.evidenceLeads.length, 1);
  assert.doesNotMatch(JSON.stringify(result.payload), /usage limit|example\.com/);
  assert.doesNotMatch(JSON.stringify(result.payload), /重新注入全部历史运行正文/);
  assert.equal(store.read(rejected.objectId).data.status, 'rejected', 'excluded lessons remain readable as history');
  assert.equal(fs.existsSync(path.join(globalRoot, 'learning')), false);
  const markdown = (await promisify(childProcess.execFile)(process.execPath, [toolPath, 'retrieve', '--project', workspace, '--global', globalRoot, '--query', '首次提示词 经验账本索引'], { encoding: 'utf8', env })).stdout;
  assert.match(markdown, new RegExp(`solomap://objects/${valuable.objectId}.*revision[=: ]+1`));
  assert.match(markdown, /读取固定版本原文再验证。/);
  assert.match(markdown, new RegExp(`solomap://objects/${result.payload.evidenceLeads[0].sourceRef.objectId}.*revision[=: ]+1`));
  store.write({ kind: 'lesson', action: 'patch', scope: project.projectId, objectId: valuable.objectId, expectedRevision: 1, idempotencyKey: 'update-valuable-lesson', data: { do_this: '更新后的 retrieve 动作。' } });
  const { openDataClient } = require('../resources/tools/solomap-data-client.cjs');
  const client = await openDataClient(globalRoot, workspace, null);
  try {
    const original = await client.call('read', { ref: result.payload.lessons[0].sourceRef.objectId, revision: result.payload.lessons[0].sourceRef.revision });
    assert.equal(original.data.do_this, '使用 retrieve 查询，并优先读取结构化经验和证据入口。');
    const current = await client.call('read', { ref: valuable.objectId });
    assert.equal(current.revision, 2); assert.equal(current.data.do_this, '更新后的 retrieve 动作。');
  } finally { await client.close(); }
  } finally { await server.close(); await ops.close(); store.close(); }
});

test('experience retrieve refuses generic URL-only queries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-experience-generic-'));
  const workspace = path.join(root, 'app');
  fs.mkdirSync(workspace, { recursive: true });
  const globalRoot = path.join(root, '.solomap-global'); const store = new UnifiedDataStore(globalRoot); const ops = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: globalRoot, runtimeId: 'generic-experience-owner', onCommand: () => ({ status: 'running' }), onData: ops });
  try {
  await ops({ operation: 'register_project', input: { root: workspace } });
  const env = anonymousToolEnv();
  const result = JSON.parse((await promisify(childProcess.execFile)(process.execPath, [
    toolPath,
    'retrieve',
    '--project', workspace,
    '--global', globalRoot,
    '--query', 'https://example.com',
    '--json'
  ], { encoding: 'utf8', env })).stdout);
  assert.deepEqual(result.payload.tokens, []);
  assert.deepEqual(result.payload.lessons, []);
  assert.match(result.payload.message, /具体功能、文件、错误或目标/);
  } finally { await server.close(); await ops.close(); store.close(); }
});

test('typed confidence keeps the stronger lesson when equivalent candidates arrive later', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-experience-confidence-'));
  const workspace = path.join(root, 'app'); fs.mkdirSync(workspace);
  const globalRoot = path.join(root, '.solomap-global'); const store = new UnifiedDataStore(globalRoot); const ops = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: globalRoot, runtimeId: 'confidence-owner', onCommand: () => ({ status: 'running' }), onData: ops });
  try {
    const project = await ops({ operation: 'register_project', input: { root: workspace } });
    const env = anonymousToolEnv();
    const data = { status: 'approved', summary: 'OAuth 回调验证必须绑定完整 nonce 和当前会话。', applies_when: 'OAuth 回调验证时。', do_this: '先核对 nonce 再确认身份。' };
    const strong = store.write({ kind: 'lesson', action: 'create', scope: project.projectId, idempotencyKey: 'strong', data: { ...data, confidence: 0.9 } });
    store.write({ kind: 'lesson', action: 'create', scope: project.projectId, idempotencyKey: 'weak', data: { ...data, confidence: 0.2 } });
    const result = JSON.parse((await promisify(childProcess.execFile)(process.execPath, [toolPath, 'retrieve', '--project', workspace, '--global', globalRoot, '--query', 'OAuth 回调验证 nonce', '--json'], { env })).stdout);
    assert.equal(result.payload.lessons.length, 1);
    assert.equal(result.payload.lessons[0].id, strong.objectId);
    assert.equal(result.payload.lessons[0].confidence, 0.9);
  } finally { await server.close(); await ops.close(); store.close(); }
});

test('real experience CLI preserves typed evidence, role filters and the original confidence label', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-experience-typed-source-'));
  const workspace = path.join(root, 'app'); fs.mkdirSync(workspace);
  const globalRoot = path.join(root, '.solomap-global'); const store = new UnifiedDataStore(globalRoot); const ops = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: globalRoot, runtimeId: 'typed-experience-owner', onCommand: () => ({ status: 'running' }), onData: ops });
  try {
    const project = await ops({ operation: 'register_project', input: { root: workspace } });
    const env = anonymousToolEnv();
    const data = { status: 'approved', summary: 'Validate the final generated script through its actual runtime output', applies_when: 'Changing executable generation', do_this: 'Run the generated script', confidence: 1, external_confidence: 'high', lesson_type: 'verification_pattern', evidence_refs_json: [{ type: 'command', ref: 'node --test stablereplaynonce.test.js', summary: 'The final regression passed' }] };
    const lesson = store.write({ kind: 'lesson', action: 'create', scope: project.projectId, idempotencyKey: 'typed-evidence', data });
    const invoke = async (query, json = true) => (await promisify(childProcess.execFile)(process.execPath, [toolPath, 'retrieve', '--project', workspace, '--global', globalRoot, '--query', query, ...(json ? ['--json'] : [])], { encoding: 'utf8', env })).stdout;
    const result = JSON.parse(await invoke('stablereplaynonce 验证'));
    assert.equal(result.payload.lessons.length, 1, 'a term present only in formal evidence must retrieve its lesson');
    assert.equal(result.payload.lessons[0].id, lesson.objectId);
    assert.deepEqual(result.payload.lessons[0].evidence, [{ type: 'command', ref: 'node --test stablereplaynonce.test.js', summary: 'The final regression passed' }]);
    assert.equal(result.payload.lessons[0].confidence, 'high');
    const markdown = await invoke('stablereplaynonce 验证', false);
    assert.match(markdown, /node --test stablereplaynonce\.test\.js/);
    assert.match(markdown, new RegExp(`${lesson.objectId}.*revision[=: ]+1`));
    const common = { status: 'approved', summary: 'nativetypemismatch should retain the original relevance and quality boundary', applies_when: 'nativetypemismatch', confidence: 0.8 };
    store.write({ kind: 'lesson', action: 'create', scope: project.projectId, idempotencyKey: 'typed-verification-filter', data: { ...common, lesson_type: 'verification_pattern' } });
    store.write({ kind: 'lesson', action: 'create', scope: project.projectId, idempotencyKey: 'typed-risk-filter', data: { ...common, lesson_type: 'risk_pattern', summary: common.summary + ' for actual failures' } });
    assert.deepEqual(JSON.parse(await invoke('nativetypemismatch')).payload.lessons, [], 'verification and risk lessons keep their established query-type gates');
    const verification = JSON.parse(await invoke('nativetypemismatch 验证')).payload.lessons;
    assert.equal(verification.length, 1); assert.equal(verification[0].lesson, common.summary);
    const risk = JSON.parse(await invoke('nativetypemismatch error')).payload.lessons;
    assert.equal(risk.length, 1); assert.match(risk[0].lesson, /actual failures/);
  } finally { await server.close(); await ops.close(); store.close(); }
});

test('an ordinary revision uses its current confidence while preserving the original imported version', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-experience-confidence-revision-')); const workspace = path.join(root, 'app'); fs.mkdirSync(workspace);
  const globalRoot = path.join(root, '.solomap-global'); const store = new UnifiedDataStore(globalRoot); const ops = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: globalRoot, runtimeId: 'confidence-revision-owner', onCommand: () => ({ status: 'running' }), onData: ops }); let client;
  try {
    const { projectId } = await ops({ operation: 'register_project', input: { root: workspace } }); client = runtimeMcpSource(globalRoot, projectId, true);
    const env = anonymousToolEnv();
    const original = store.write({ kind: 'lesson', action: 'create', scope: projectId, idempotencyKey: 'original-high-source', data: { status: 'approved', summary: 'currentconfidencerevision preserves observed applicability after a new result', applies_when: 'currentconfidencerevision', confidence: 1, external_confidence: 'high' } });
    const invoke = async () => JSON.parse((await promisify(childProcess.execFile)(process.execPath, [toolPath, 'retrieve', '--project', workspace, '--global', globalRoot, '--query', 'currentconfidencerevision', '--json'], { encoding: 'utf8', env })).stdout).payload.lessons[0];
    assert.equal((await invoke()).confidence, 'high');
    const next = store.write({ kind: 'lesson', action: 'patch', scope: projectId, objectId: original.objectId, expectedRevision: 1, idempotencyKey: 'native-confidence-decrease', data: { confidence: 0.2 } });
    assert.equal((await invoke()).confidence, 0.2, 'the current value must not be shadowed by the original imported label');
    store.write({ kind: 'lesson', action: 'patch', scope: projectId, objectId: original.objectId, expectedRevision: next.revision, idempotencyKey: 'native-confidence-zero', data: { confidence: 0 } });
    assert.equal((await invoke()).confidence, 0);
    assert.equal((await client.call('read', { ref: original.objectId, revision: 1 })).data.external_confidence, 'high');
  } finally { if (client) await client.close(); await server.close(); await ops.close(); store.close(); }
});
