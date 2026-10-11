const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');

const projectRoot = path.resolve(__dirname, '..');
const toolPath = path.join(projectRoot, 'resources', 'tools', 'solomap-memory.cjs');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function writeJsonMemory(filePath, overrides = {}) {
  const entry = {
    schemaVersion: 1,
    id: 'mem_json_test',
    scopeId: 'memory_scope:project:demo-app',
    layer: 'stable',
    kind: 'project_fact',
    status: 'active',
    title: 'JSON startup boundary',
    content: '侧边栏启动必须等待统一链路完成，再查询历史。',
    tags: ['sidebar', 'startup'],
    provenance: { evidenceRefs: ['test:json-memory'] },
    validity: { validFrom: null, validUntil: null },
    ...overrides
  };
  const canonicalHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify(sortJson(entry))).digest('hex')}`;
  write(filePath, `${JSON.stringify({ ...entry, canonicalHash }, null, 2)}\n`);
}

async function runTool(workspace, globalRoot, query, extra = []) {
  const result = await promisify(execFile)(process.execPath, [
    toolPath,
    'retrieve',
    '--project', workspace,
    '--global', globalRoot,
    '--query', query,
    '--json',
    ...extra
  ], { encoding: 'utf8' });
  return JSON.parse(result.stdout);
}

async function runRoute(workspace, globalRoot, kind, title = '') {
  const result = await promisify(execFile)(process.execPath, [
    toolPath,
    'route',
    '--project', workspace,
    '--global', globalRoot,
    '--kind', kind,
    ...(title ? ['--title', title] : []),
    '--json'
  ], { encoding: 'utf8' });
  return JSON.parse(result.stdout);
}

async function openFixture(workspace, globalRoot) {
  fs.mkdirSync(workspace, { recursive: true });
  const store = new UnifiedDataStore(globalRoot); const ops = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: globalRoot, runtimeId: 'memory-tool-owner', onCommand: () => ({ status: 'running' }), onData: ops });
  const close = async () => { await server.close(); await ops.close(); store.close(); };
  try {
    const project = await ops({ operation: 'register_project', input: { root: workspace } });
    const otherPath = path.join(path.dirname(workspace), 'other-app'); fs.mkdirSync(otherPath, { recursive: true });
    const other = await ops({ operation: 'register_project', input: { root: otherPath } });
    const sourceRoot = path.join(globalRoot, 'memory'); let migration;
    if (fs.existsSync(sourceRoot)) {
      const job = await ops({ operation: 'import_memory', input: { sourceRoot, projectScopes: { 'demo-app': project.projectId, 'other-app': other.projectId }, idempotencyKey: 'memory-tool-import' } });
      await ops.waitForMigrations(); migration = await ops({ operation: 'migration_status', input: { jobId: job.jobId } });
      fs.renameSync(sourceRoot, `${sourceRoot}-retained-evidence`);
    }
    return { store, ops, project: project.projectId, migration, close };
  } catch (error) { await close(); throw error; }
}

test('memory retrieve returns scoped high-value sections with fixed database locations', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-'));
  const workspace = path.join(root, 'demo-app');
  const globalRoot = path.join(root, '.solomap-global');
  const memoryRoot = path.join(globalRoot, 'memory');
  fs.mkdirSync(workspace, { recursive: true });
  write(path.join(memoryRoot, 'profile.md'), '# Profile\n\n## Communication\n\n- 默认先给结论。\n');
  write(path.join(memoryRoot, 'operating-rules.md'), '# Rules\n\n## Webview startup\n\n- Webview 首屏不能等待外部网络。\n');
  write(path.join(memoryRoot, 'projects', 'demo-app.md'), '# Demo\n\n## Sidebar launch boundary\n\n侧边栏对话必须复用统一启动链路，不能抢跑历史查询。\n');
  write(path.join(memoryRoot, 'projects', 'other-app.md'), '# Other\n\n侧边栏对话使用另一套旧链路。\n');
  write(path.join(memoryRoot, 'patterns', 'webview.md'), '# Webview\n\n## First paint\n\n侧边栏对话启动后再加载历史查询，不能与统一启动链并发。\n');
  write(path.join(memoryRoot, 'domains', 'billing.md'), '# Billing\n\nStripe subscription recovery.\n');

  const fixture = await openFixture(workspace, globalRoot);
  try {
  const output = await runTool(workspace, globalRoot, '侧边栏对话启动链路和历史查询');
  assert.ok(output.payload.results.length >= 2);
  const projectResult = output.payload.results.find((result) => result.source === 'project');
  assert.ok(projectResult);
  assert.equal(projectResult.sourceRef.revision, 1);
  assert.equal(fixture.store.readMetadata(projectResult.sourceRef.objectId).projectId, fixture.project);
  assert.equal(fixture.store.read(projectResult.sourceRef.objectId, 1).data.content, '# Demo\n\n## Sidebar launch boundary\n\n侧边栏对话必须复用统一启动链路，不能抢跑历史查询。\n');
  assert.ok(projectResult.lineStart > 0);
  assert.match(projectResult.reason, /命中/);
  assert.doesNotMatch(JSON.stringify(output), /other-app\.md/);
  assert.doesNotMatch(JSON.stringify(output), /Stripe subscription/);
  const markdown = (await promisify(execFile)(process.execPath, [toolPath, 'retrieve', '--project', workspace, '--global', globalRoot, '--query', '侧边栏对话启动链路和历史查询'])).stdout;
  assert.match(markdown, new RegExp(`solomap://objects/${projectResult.sourceRef.objectId}.*revision[=: ]+1`));
  assert.equal(fs.existsSync(memoryRoot), false);
  } finally { await fixture.close(); }
});

test('memory retrieve supports source filters and rejects generic queries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-filter-'));
  const workspace = path.join(root, 'demo-app');
  const globalRoot = path.join(root, '.solomap-global');
  const memoryRoot = path.join(globalRoot, 'memory');
  fs.mkdirSync(workspace, { recursive: true });
  write(path.join(memoryRoot, 'projects', 'demo-app.md'), '# Demo\n\n## Auth decision\n\nOAuth 回调必须绑定 nonce。\n');
  write(path.join(memoryRoot, 'decisions', 'auth.md'), '# Auth\n\n## OAuth callback\n\nOAuth 回调必须验证 nonce 和 state。\n');

  const fixture = await openFixture(workspace, globalRoot);
  try {
  const filtered = await runTool(workspace, globalRoot, 'OAuth 回调 nonce', ['--sources', 'decisions']);
  assert.equal(filtered.payload.results.length, 1);
  assert.equal(filtered.payload.results[0].source, 'decisions');

  const generic = await runTool(workspace, globalRoot, 'https://example.com SoloMap 项目记忆系统');
  assert.deepEqual(generic.payload.results, []);
  assert.match(generic.payload.message, /具体功能/);
  } finally { await fixture.close(); }
});

test('memory retrieve preserves migrated structured metadata, validity and candidate boundaries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-json-'));
  const workspace = path.join(root, 'demo-app');
  const globalRoot = path.join(root, '.solomap-global');
  const memoryRoot = path.join(globalRoot, 'memory');
  fs.mkdirSync(workspace, { recursive: true });
  write(path.join(memoryRoot, 'projects', 'demo-app.md'), '# Legacy\n\n侧边栏启动统一链路。\n');
  writeJsonMemory(path.join(memoryRoot, 'entries', 'mem_json_test.json'));
  writeJsonMemory(path.join(memoryRoot, 'entries', 'mem_expired.json'), {
    id: 'mem_expired',
    title: 'Expired startup boundary',
    content: '侧边栏启动使用已经过期的旧链路。',
    validity: { validFrom: null, validUntil: '2020-01-01T00:00:00.000Z' }
  });
  write(path.join(memoryRoot, 'entries', 'mem_invalid.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'mem_invalid',
    scopeId: 'memory_scope:project:demo-app',
    layer: 'stable',
    kind: 'project_fact',
    status: 'active',
    title: 'Invalid hash startup boundary',
    content: '侧边栏启动不应读取损坏条目。',
    canonicalHash: 'sha256:invalid'
  }));
  writeJsonMemory(path.join(memoryRoot, 'entries', 'mem_candidate.json'), {
    id: 'mem_candidate',
    layer: 'candidate',
    kind: 'observation',
    title: 'Candidate startup observation',
    content: '侧边栏启动候选观察尚未验证。'
  });

  const fixture = await openFixture(workspace, globalRoot);
  try {
  assert.ok(fixture.migration.progress.conflicts.some(item => /hash/.test(item.error)));
  const output = await runTool(workspace, globalRoot, '侧边栏启动统一链路');
  const jsonResult = output.payload.results.find((result) => result.memoryId === 'mem_json_test');
  assert.ok(jsonResult);
  assert.equal(jsonResult.memoryId, 'mem_json_test');
  assert.doesNotMatch(JSON.stringify(output), /Expired startup boundary|Invalid hash startup boundary|Candidate startup observation/);

  const candidates = await runTool(workspace, globalRoot, '侧边栏启动候选观察', ['--sources', 'inbox']);
  assert.equal(candidates.payload.results[0].memoryId, 'mem_candidate');
  } finally { await fixture.close(); }
});

test('memory route returns scoped candidate targets, structure, and review guardrails without writing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-route-'));
  const workspace = path.join(root, 'demo-app');
  const globalRoot = path.join(root, '.solomap-global');
  const memoryRoot = path.join(globalRoot, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });

  const fixture = await openFixture(workspace, globalRoot);
  try {
  const before = fixture.store.search({ scope: fixture.project, kinds: ['memory'] }).items;
  const projectRoute = await runRoute(workspace, globalRoot, 'project');
  assert.deepEqual(projectRoute.payload.target, { kind: 'memory', scope: fixture.project, data: { category: 'project', status: 'captured' } });
  assert.match(projectRoute.payload.operation, /superseded|stable fact/i);
  assert.ok(projectRoute.payload.guardrails.some((item) => /Read.*fixed.*revision/i.test(item)));

  const patternRoute = await runRoute(workspace, globalRoot, 'pattern', 'Webview Startup');
  assert.equal(patternRoute.payload.target.data.category, 'pattern');
  assert.deepEqual(patternRoute.payload.requiredStructure, ['Pattern', 'Evidence', 'Applies when', 'Do this', 'Avoid this']);
  assert.equal(patternRoute.payload.targetFile, undefined);

  const activeRoute = await runRoute(workspace, globalRoot, 'handoff');
  assert.equal(activeRoute.payload.target.data.category, 'active');
  assert.equal(activeRoute.payload.kind, 'active');

  const routes = [
    ['profile', '', 'profile'],
    ['rules', '', 'rules'],
    ['decision', '', 'decision'],
    ['domain', 'OAuth Security', 'domain'],
    ['inbox', '', 'inbox']
  ];
  for (const [kind, title, category] of routes) {
    const route = await runRoute(workspace, globalRoot, kind, title);
    assert.equal(route.payload.target.scope, fixture.project);
    assert.equal(route.payload.target.data.status, 'captured');
    assert.equal(route.payload.target.data.category, category);
    assert.ok(route.payload.requiredStructure.length >= 3);
    assert.ok(route.payload.operation);
  }
  assert.deepEqual(fixture.store.search({ scope: fixture.project, kinds: ['memory'] }).items, before);
  assert.equal(fs.existsSync(memoryRoot), false);
  } finally { await fixture.close(); }
});

test('memory route rejects unknown kinds and missing topic titles', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-route-invalid-'));
  const workspace = path.join(root, 'demo-app');
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(path.join(globalRoot, 'memory'), { recursive: true });

  const fixture = await openFixture(workspace, globalRoot);
  try {
    await assert.rejects(promisify(execFile)(process.execPath, [toolPath, 'route', '--project', workspace, '--global', globalRoot, '--kind', 'unknown']), error => error.code === 1 && /Unknown memory kind/.test(error.stderr));
    await assert.rejects(promisify(execFile)(process.execPath, [toolPath, 'route', '--project', workspace, '--global', globalRoot, '--kind', 'pattern']), error => error.code === 1 && /--title is required/.test(error.stderr));
  } finally { await fixture.close(); }
});

test('the actual memory CLI reads only indexed matches and keeps full pinned sources after restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-resource-'));
  const workspace = path.join(root, 'demo-app'); const globalRoot = path.join(root, '.solomap-global');
  let fixture = await openFixture(workspace, globalRoot);
  try {
    const match = fixture.store.write({ kind: 'memory', action: 'create', scope: fixture.project, idempotencyKey: 'match', data: { category: 'project', title: 'OAuth nonce callback', status: 'captured', content: '# OAuth callback\n\n验证 nonce 和完整会话。\n' + '完整来源🌿'.repeat(15000) } });
    const others = Array.from({ length: 30 }, (_, i) => fixture.store.write({ kind: 'memory', action: 'create', scope: fixture.project, idempotencyKey: `unrelated-${i}`, data: { category: 'project', title: `billing-${i}`, status: 'captured', content: '无关计费历史🌳'.repeat(10000) } }));
    const unrelatedIds = new Set(others.map(item => fixture.store.readMetadata(item.objectId).data.content_id));
    const matchedId = fixture.store.readMetadata(match.objectId).data.content_id;
    const original = fixture.store.contentRange.bind(fixture.store); let unrelatedDecodes = 0; let matchedDecodes = 0; let matchedBytes = 0;
    const originalRows = fixture.store.rows.bind(fixture.store); const queryPlans = [];
    fixture.store.rows = (sql, values) => {
      if (sql.startsWith('SELECT id FROM objects') && sql.includes('object_search MATCH')) queryPlans.push({ sql, values, plan: originalRows('EXPLAIN QUERY PLAN ' + sql, values) });
      return originalRows(sql, values);
    };
    fixture.store.contentRange = (...args) => { const bytes = original(...args); if (unrelatedIds.has(args[0])) unrelatedDecodes++; if (args[0] === matchedId) { matchedDecodes++; matchedBytes += bytes.length; } return bytes; };
    let result;
    try { for (let i = 0; i < 4; i++) result = await runTool(workspace, globalRoot, 'OAuth nonce callback'); }
    finally { fixture.store.contentRange = original; fixture.store.rows = originalRows; }
    assert.equal(unrelatedDecodes, 0); assert.equal(matchedDecodes, 8);
    assert.equal(result.payload.results[0].sourceRef.objectId, match.objectId);
    const body = fixture.store.read(match.objectId, 1).data.content;
    assert.equal(matchedBytes, Buffer.byteLength(body) * 8);
    assert.ok(queryPlans.length >= 4);
    for (const query of queryPlans) {
      assert.ok(query.plan.some(row => /object_search.*VIRTUAL TABLE INDEX/.test(row.detail)));
      assert.ok(query.plan.some(row => /SEARCH objects USING/.test(row.detail)));
      assert.ok(!query.plan.some(row => /^SCAN objects$/.test(row.detail)));
    }
    console.log(JSON.stringify({ memoryCliResource: { root, retainedMemoryCount: 31, repetitions: 4, matchedDecodes, matchedBytes, unrelatedDecodes, queryPlans } }));
    fixture.store.write({ kind: 'memory', action: 'patch', scope: fixture.project, objectId: match.objectId, expectedRevision: 1, idempotencyKey: 'changed', data: { content: '更新后的 OAuth nonce callback 正文。' } });
    await fixture.close(); fixture = await openFixture(workspace, globalRoot);
    const { openDataClient } = require('../resources/tools/solomap-data-client.cjs');
    const client = await openDataClient(globalRoot, workspace);
    try {
      assert.equal(await client.content({ objectId: match.objectId, revision: 1 }), body);
      assert.equal((await runTool(workspace, globalRoot, 'OAuth nonce callback')).payload.results[0].sourceRef.revision, 2);
      const route = await runRoute(workspace, globalRoot, 'project', 'OAuth nonce callback');
      assert.ok(route.payload.existing.some(item => item.objectId === match.objectId && item.revision === 2));
    } finally { await client.close(); }
    assert.equal(fs.existsSync(path.join(globalRoot, 'memory')), false);
    assert.equal(fs.existsSync(path.join(globalRoot, 'learning')), false);
    assert.deepEqual(fs.readdirSync(path.join(workspace, '.solopreneur')), ['project.json']);
  } finally { await fixture.close(); }
});

test('native structured memory tags are searchable without a legacy file identity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-native-tags-'));
  const workspace = path.join(root, 'demo-app'); const globalRoot = path.join(root, '.solomap-global');
  const fixture = await openFixture(workspace, globalRoot);
  try {
    const entry = fixture.store.write({ kind: 'memory', action: 'create', scope: fixture.project, idempotencyKey: 'native-tags', data: { category: 'project', title: '会话约束', status: 'captured', content: '回调必须先核对当前会话，再执行身份确认。', tags_json: ['nativeNonceTag'], provenance_json: { evidenceRefs: ['source:current-code'] } } });
    const result = await runTool(workspace, globalRoot, 'nativeNonceTag');
    assert.equal(result.payload.results.length, 1);
    assert.deepEqual(result.payload.results[0].sourceRef, { objectId: entry.objectId, revision: 1 });
    assert.equal(result.payload.results[0].memoryId, entry.objectId);
  } finally { await fixture.close(); }
});
