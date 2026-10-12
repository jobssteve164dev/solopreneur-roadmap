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

async function runExternalSync(fixture, target, authorized = true) {
  const { syncExternalMemoryTarget } = require('../out/externalMemoryTarget.js');
  return syncExternalMemoryTarget({
    projectId: fixture.project, targetRoot: target, authorized,
    sync: input => fixture.ops({ operation: 'sync_external_memory', input }),
    reconcile: input => fixture.ops({ operation: 'reconcile_external_memory_target', input })
  });
}

async function runExternalDisconnect(fixture, target) {
  const { disconnectExternalMemoryTarget } = require('../out/externalMemoryTarget.js');
  return disconnectExternalMemoryTarget({
    projectId: fixture.project, target,
    revoke: input => fixture.ops({ operation: 'revoke_external_memory_target', input })
  });
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

test('the host adapter synchronizes an explicitly selected CloudMCP JSON target with hash, scope, revision and authorization boundaries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-external-'));
  const workspace = path.join(root, 'demo-app');
  const globalRoot = path.join(root, '.solomap-global');
  const target = path.join(root, 'cloudmcp-target');
  fs.mkdirSync(path.join(target, 'entries'), { recursive: true });
  write(path.join(target, 'contract.json'), JSON.stringify({ schemaVersion: 1, target: 'solomap', format: 'json', targetId: 'fixture-target' }));
  const entryPath = path.join(target, 'entries', 'entry.json');
  writeJsonMemory(entryPath, { revision: 2 });
  let fixture = await openFixture(workspace, globalRoot);
  try {
    const synced = await runExternalSync(fixture, target);
    assert.equal(synced.entries.length, 1);
    let found = await runTool(workspace, globalRoot, 'JSON startup boundary');
    assert.ok(found.payload.results.some(item => item.memoryId === 'mem_json_test'));

    writeJsonMemory(entryPath, { revision: 1 });
    await assert.rejects(runExternalSync(fixture, target), /external_memory_source_revision_conflict/);
    writeJsonMemory(entryPath, { revision: 2 });
    const targets = await fixture.ops({ operation: 'read_external_memory_targets', input: { projectId: fixture.project } });
    assert.deepEqual(targets.items, [{ target: 'fixture-target', active: 1, total: 1 }]);
    const firstDisconnect = await runExternalDisconnect(fixture, 'fixture-target');
    assert.equal(firstDisconnect.revoked, 1);
    found = await runTool(workspace, globalRoot, 'JSON startup boundary');
    assert.ok(!found.payload.results.some(item => item.memoryId === 'mem_json_test'));
    await runExternalSync(fixture, target);

    const loopPath = path.join(target, 'entries', 'loop.json');
    writeJsonMemory(loopPath, { id: 'loop-external', revision: 1, title: 'Loop source', content: '来源集合回环必须撤销已经移除的来源。' });
    await runExternalSync(fixture, target);
    fs.renameSync(loopPath, `${loopPath}.retained`);
    await runExternalSync(fixture, target);
    assert.equal(fixture.store.rows("SELECT status FROM memories WHERE external_source LIKE '%loop-external'")[0].status, 'revoked', 'A→A+B→A must perform a new reconciliation action');

    const secondDisconnect = await runExternalDisconnect(fixture, 'fixture-target');
    assert.ok(secondDisconnect.revoked >= 1, 'a new disconnect after reauthorization must revoke the current active generation');
    found = await runTool(workspace, globalRoot, 'JSON startup boundary');
    assert.ok(!found.payload.results.some(item => item.memoryId === 'mem_json_test'));
    await runExternalSync(fixture, target);

    const candidatePath = path.join(target, 'entries', 'candidate.json');
    writeJsonMemory(candidatePath, { id: 'candidate-external', revision: 1, layer: 'candidate', kind: 'observation', title: 'External candidate', content: '外部候选观察不进入默认上下文。' });
    const pendingPath = path.join(target, 'entries', 'pending.json');
    writeJsonMemory(pendingPath, { id: 'pending-external', revision: 1, layer: 'stable', status: 'pending', kind: 'observation', title: 'External pending', content: '外部未生效观察不能进入任何检索。' });
    await runExternalSync(fixture, target, true);
    const defaultContext = await fixture.ops({ operation: 'context', input: { project: fixture.project, kinds: ['memory'], terms: ['外部候选观察'] } });
    assert.ok(!defaultContext.items.some(item => item.data.legacy_entry_id === 'candidate-external'));
    const inbox = await runTool(workspace, globalRoot, '外部候选观察', ['--sources', 'inbox']);
    assert.ok(inbox.payload.results.some(item => item.memoryId === 'candidate-external'));
    const pendingDefault = await runTool(workspace, globalRoot, '外部未生效观察');
    const pendingInbox = await runTool(workspace, globalRoot, '外部未生效观察', ['--sources', 'inbox']);
    assert.ok(!pendingDefault.payload.results.some(item => item.memoryId === 'pending-external'));
    assert.ok(!pendingInbox.payload.results.some(item => item.memoryId === 'pending-external'));
    fs.renameSync(candidatePath, `${candidatePath}.retained`);
    await runExternalSync(fixture, target);
    const reconciledInbox = await runTool(workspace, globalRoot, '外部候选观察', ['--sources', 'inbox']);
    assert.ok(!reconciledInbox.payload.results.some(item => item.memoryId === 'candidate-external'), 'entries removed upstream are revoked during reconciliation');

    const damagedBeforeDisconnect = JSON.parse(fs.readFileSync(entryPath, 'utf8')); damagedBeforeDisconnect.content = 'damaged before disconnect'; write(entryPath, JSON.stringify(damagedBeforeDisconnect));
    await fixture.ops({ operation: 'revoke_external_memory_target', input: { projectId: fixture.project, target: 'fixture-target', idempotencyKey: 'fixture-target-disconnect-damaged' } });
    found = await runTool(workspace, globalRoot, 'JSON startup boundary');
    assert.ok(!found.payload.results.some(item => item.memoryId === 'mem_json_test'), 'disconnect revokes retained history without rereading damaged files');
    writeJsonMemory(entryPath, { revision: 2 });
    await runExternalSync(fixture, target);

    await fixture.close();
    fixture = await openFixture(workspace, globalRoot);
    found = await runTool(workspace, globalRoot, 'JSON startup boundary');
    assert.ok(found.payload.results.some(item => item.memoryId === 'mem_json_test'), 'authorized external memory survives a cold restart');

    const damaged = JSON.parse(fs.readFileSync(entryPath, 'utf8')); damaged.content = 'tampered'; write(entryPath, JSON.stringify(damaged));
    await assert.rejects(runExternalSync(fixture, target), /external_memory_hash_mismatch/);
    writeJsonMemory(entryPath, { revision: 3, scopeId: 'memory_scope:project:another-project' });
    await assert.rejects(runExternalSync(fixture, target), /external_memory_scope_mismatch/);
  } finally { await fixture.close(); }
});

test('external targets require an explicit identity and never collapse separate directories into one target', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-target-missing-id-'));
  const workspace = path.join(root, 'demo-app'); const globalRoot = path.join(root, '.solomap-global');
  const fixture = await openFixture(workspace, globalRoot);
  try {
    for (const name of ['first', 'second']) {
      const target = path.join(root, name); fs.mkdirSync(path.join(target, 'entries'), { recursive: true });
      write(path.join(target, 'contract.json'), JSON.stringify({ schemaVersion: 1, target: 'solomap', format: 'json' }));
      writeJsonMemory(path.join(target, 'entries', 'entry.json'), { id: `${name}-entry`, content: `${name} directory` });
      await assert.rejects(runExternalSync(fixture, target), /external_memory_target_identity_invalid/);
    }
    assert.deepEqual((await fixture.ops({ operation: 'read_external_memory_targets', input: { projectId: fixture.project } })).items, []);
  } finally { await fixture.close(); }
});

test('external target identity is global for global entries and exact for adjacent project target names', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-target-identity-'));
  const workspace = path.join(root, 'demo-app'); const globalRoot = path.join(root, '.solomap-global');
  const fixture = await openFixture(workspace, globalRoot);
  try {
    const otherRoot = path.join(root, 'other-app');
    const other = await fixture.ops({ operation: 'register_project', input: { root: otherRoot } });
    const shared = path.join(root, 'shared-global'); fs.mkdirSync(path.join(shared, 'entries'), { recursive: true });
    write(path.join(shared, 'contract.json'), JSON.stringify({ schemaVersion: 1, target: 'solomap', format: 'json', targetId: 'shared_global' }));
    writeJsonMemory(path.join(shared, 'entries', 'global.json'), { id: 'shared-entry', scopeId: 'memory_scope:global', kind: 'global', title: 'Shared global memory', content: '两个项目读取同一条全局记忆。', revision: 1 });
    await runExternalSync(fixture, shared);
    await runExternalSync({ project: other.projectId, ops: fixture.ops }, shared);
    assert.equal(fixture.store.rows("SELECT COUNT(*) AS n FROM memories WHERE external_source='cloudmcp:global:shared_global:shared-entry'")[0].n, 1);
    const otherContext = await fixture.ops({ operation: 'context', input: { project: other.projectId, kinds: ['memory'], terms: ['两个项目读取'] } });
    assert.equal(otherContext.items.length, 1);

    for (const [targetId, entryId, title] of [['foo_bar', 'under-entry', 'Underscore target'], ['fooXbar', 'letter-entry', 'Letter target']]) {
      const target = path.join(root, targetId); fs.mkdirSync(path.join(target, 'entries'), { recursive: true });
      write(path.join(target, 'contract.json'), JSON.stringify({ schemaVersion: 1, target: 'solomap', format: 'json', targetId }));
      writeJsonMemory(path.join(target, 'entries', 'entry.json'), { id: entryId, scopeId: 'memory_scope:project:demo-app', title, content: `${title} remains exact.`, revision: 1 });
      await runExternalSync(fixture, target);
    }
    await fixture.ops({ operation: 'revoke_external_memory_target', input: { projectId: fixture.project, target: 'foo_bar', idempotencyKey: 'revoke-foo-bar' } });
    const exact = await fixture.ops({ operation: 'context', input: { project: fixture.project, kinds: ['memory'], terms: ['Letter target remains exact'] } });
    assert.ok(exact.items.some(item => item.data.title === 'Letter target'));
    assert.equal(fixture.store.rows("SELECT status FROM memories WHERE external_source LIKE '%under-entry'")[0].status, 'revoked');
    assert.equal(fixture.store.rows("SELECT status FROM memories WHERE external_source LIKE '%letter-entry'")[0].status, 'active');

    await fixture.ops({ operation: 'revoke_external_memory_target', input: { projectId: fixture.project, target: 'shared_global', idempotencyKey: 'revoke-shared-global' } });
    const revokedGlobal = await fixture.ops({ operation: 'context', input: { project: other.projectId, kinds: ['memory'], terms: ['两个项目读取'] } });
    assert.equal(revokedGlobal.items.length, 0);
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
