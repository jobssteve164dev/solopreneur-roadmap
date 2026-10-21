const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createIntelligenceMcpSession } = require('../out/intelligenceMcp.js');
const { runtimeProjectMcpSource } = require('../out/runtimeDataOperations.js');

async function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-project-signals-'));
  fs.mkdirSync(path.join(base, '.git'));
  const root = path.join(base, '.solomap-global');
  const projects = ['Alpha', 'Beta', 'Hidden'].map(name => ({ name, path: path.join(base, name) }));
  for (const project of projects) fs.mkdirSync(path.join(project.path, '.git'), { recursive: true });
  let session;
  t.after(() => session?.close());
  const owner = await require('./analysis-fixture.js').openAnalysisOwner(t, root, projects);
  await owner.store.initializeProjectRegistry({ legacyProjects: projects, legacySelectedProjectPath: projects[0].path,
    legacyHiddenProjects: [projects[2].path] });
  session = await createIntelligenceMcpSession({ getProjects: () => projects.slice(0, 2),
    getSelectedProjectPath: () => projects[0].path, getCurrentSteps: () => [], getSettings: () => ({ language: 'zh' })
  }, await runtimeProjectMcpSource(root, projects[0].path));
  return { ...owner, root, projects, session,
    async call(input) {
      const result = await session.client.callTool({ name: 'solomap_project_signals', arguments: input });
      if (result.isError) throw new Error(result.content[0].text);
      return JSON.parse(result.content[0].text);
    },
    save(project, kind, cache) {
      const id = owner.projectIds.get(project.path);
      const token = owner.store.reserveExternalRefresh(id, kind, `${kind}-${Math.random()}`);
      return owner.store.commitExternalRefresh(id, { key: kind, ...token, requestedAt: Date.now(), cache }).state;
    }
  };
}

test('project signals tool reads another project raw caches without display filters or database writes', async t => {
  const f = await fixture(t);
  const beta = f.projects[1];
  const cache = { schemaVersion: 1, repo: 'owner/beta', syncedAt: '2026-10-01T00:00:00Z', message: 'partial source warning',
    alerts: [{ source: 'dependabot', title: 'low retained', severity: 'low', state: 'closed', url: 'https://example.test/1' },
      { source: 'code-scanning', title: 'critical retained', severity: 'critical', state: 'open', url: 'https://example.test/2' }], extra: { preserved: true } };
  f.save(beta, 'security', cache);
  await f.call({});
  const before = f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n;
  const list = JSON.parse((await f.call({})).content);
  assert.deepEqual(list.projects.map(p => p.name), ['Alpha', 'Beta']);
  const target = list.projects.find(p => p.name === 'Beta');
  assert.equal(target.projectId, f.projectIds.get(beta.path));
  const value = await f.call({ project: target.projectId, kind: 'security' });
  assert.equal(value.status, 'saved');
  assert.equal(value.projectId, f.projectIds.get(beta.path));
  assert.equal(value.syncedAt, '2026-10-01T00:00:00Z');
  assert.deepEqual(JSON.parse(value.content), cache);
  assert.equal(value.cursor, null);
  assert.equal((await f.call({ project: 'Beta', kind: 'issues' })).status, 'not_synced');
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n, before);
});

test('project signals pages preserve the original revision across refreshes and reject changed scope', async t => {
  const f = await fixture(t);
  const beta = f.projects[1];
  const cache = { schemaVersion: 1, repo: 'owner/beta', syncedAt: '2026-10-20T00:00:00Z',
    issues: [{ number: 7, title: 'entire body', body: '中文😀'.repeat(20000) + 'ORIGINAL-END', labels: [], state: 'open' }] };
  f.save(beta, 'issues', cache);
  let page = await f.call({ project: 'Beta', kind: 'issues' });
  assert.ok(page.cursor);
  const first = page;
  let content = page.content;
  const originalRevision = page.revision;
  f.save(beta, 'issues', { ...cache, issues: [] });
  await assert.rejects(f.call({ project: 'Alpha', kind: 'issues', cursor: page.cursor }), /cursor|scope/);
  await assert.rejects(f.call({ project: 'Beta', kind: 'security', cursor: page.cursor }), /cursor|scope/);
  while (page.cursor) {
    page = await f.call({ project: 'Beta', kind: 'issues', cursor: page.cursor });
    assert.equal(page.revision, originalRevision);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 40000);
    content += page.content;
  }
  assert.deepEqual(JSON.parse(content), cache);
  const registry = f.store.readProjectRegistry();
  f.store.patchProjectRegistry({ expectedRevision: registry.revision, hiddenPatches: [{ path: beta.path, hidden: true }], idempotencyKey: 'hide-beta' });
  await assert.rejects(f.call({ project: 'Beta', kind: 'issues', cursor: first.cursor }), /scope_denied/);
});

test('signal tool rejects unknown projects, hidden projects, malformed cursors and arbitrary namespaces', async t => {
  const f = await fixture(t);
  for (const project of ['missing', 'Hidden', '/etc']) await assert.rejects(f.call({ project, kind: 'security' }), /scope_denied/);
  await assert.rejects(f.call({ project: 'Alpha', kind: 'secrets' }), /kind|Invalid|enum/i);
  await assert.rejects(f.call({ project: 'Alpha', kind: 'issues', cursor: 'invalid' }), /cursor/);
});

test('project discovery pages without losing projects and refuses to mix changed registries', async t => {
  const f = await fixture(t);
  const current = f.store.readProjectRegistry();
  f.store.patchProjectRegistry({ expectedRevision: current.revision, idempotencyKey: 'many-projects',
    projectPatches: Array.from({ length: 45 }, (_, i) => ({ path: path.join(f.projects[0].path, `extra-${i}`), fields: { name: `Extra ${i}` } })) });
  const first = await f.call({});
  assert.ok(first.cursor);
  let content = first.content;
  let page = first;
  while (page.cursor) {
    page = await f.call({ cursor: page.cursor });
    content += page.content;
  }
  const names = JSON.parse(content).projects.map(p => p.name);
  assert.equal(names.length, 47);
  assert.equal(new Set(names).size, 47);
  const newRoot = path.join(f.projects[0].path, 'extra-0');
  fs.mkdirSync(path.join(newRoot, '.git'), { recursive: true });
  await f.store.registerProject({ root: newRoot });
  await assert.rejects(f.call({ cursor: first.cursor }), /project_list_changed/);
  const latest = f.store.readProjectRegistry();
  f.store.patchProjectRegistry({ expectedRevision: latest.revision, hiddenPatches: [{ path: f.projects[1].path, hidden: true }], idempotencyKey: 'changed-page' });
  await assert.rejects(f.call({ cursor: first.cursor }), /project_list_changed/);
});

test('revoking the MCP read grant also revokes ongoing project data pages', async t => {
  const f = await fixture(t);
  f.save(f.projects[1], 'issues', { syncedAt: '2026-10-20T00:00:00Z', issues: [{ body: 'a'.repeat(8000) }] });
  const first = await f.call({ project: 'Beta', kind: 'issues' });
  assert.ok(first.cursor);
  f.store.db.run("UPDATE grants SET status='revoked' WHERE target_id=?", [f.projectIds.get(f.projects[0].path)]);
  await assert.rejects(f.call({ project: 'Beta', kind: 'issues', cursor: first.cursor }), /action_denied/);
});

test('signal read does not broaden generic reads and retains all saved delivery runs', async t => {
  const f = await fixture(t);
  const cache = { repo: 'owner/beta', syncedAt: '2026-10-20T00:00:00Z', latestRelease: { tagName: 'v1' },
    workflowRuns: Array.from({ length: 12 }, (_, i) => ({ name: `run-${i}`, conclusion: i % 2 ? 'failure' : 'success' })) };
  const state = f.save(f.projects[1], 'delivery', cache);
  assert.deepEqual(JSON.parse((await f.call({ project: f.projects[1].path, kind: 'delivery' })).content), cache);
  const denied = await f.session.client.callTool({ name: 'solomap_read', arguments: { ref: state.objectId } });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /scope_denied/);
});

test('cold database reads retain legacy caches when the project directory is unavailable', async t => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { readProjectSignals } = require('../out/projectSignalsRead.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-project-signals-cold-'));
  fs.mkdirSync(path.join(base, '.git'));
  const root = path.join(base, '.solomap-global');
  const projectPath = path.join(base, 'offline');
  fs.mkdirSync(path.join(projectPath, '.git'), { recursive: true });
  let store = new UnifiedDataStore(root);
  t.after(() => store.close());
  const project = await store.registerProject({ root: projectPath });
  await store.initializeProjectRegistry({ legacyProjects: [{ name: 'Offline', path: projectPath }] });
  const cache = { repo: 'owner/offline', syncedAt: '2026-09-01T00:00:00Z', issues: [] };
  store.writeAnalysisState(project.projectId, { namespace: 'external', key: 'issues', expectedRevision: 0,
    value: cache, idempotencyKey: 'legacy-cache' });
  store.close();
  fs.renameSync(projectPath, path.join(base, 'unavailable-project'));
  store = UnifiedDataStore.open(root);
  const result = readProjectSignals(store, { project: 'Offline', kind: 'issues' });
  assert.equal(result.status, 'saved');
  assert.deepEqual(JSON.parse(result.content), cache);
});

test('formal intelligence MCP reads saved signals with no selection or an unavailable selected directory', async t => {
  const f = await fixture(t);
  f.save(f.projects[1], 'security', { repo: 'owner/beta', alerts: [{ title: 'saved risk' }] });
  fs.renameSync(f.projects[0].path, f.projects[0].path + '-unavailable');
  for (const selected of [f.projects[0].path, '']) {
    const source = await runtimeProjectMcpSource(f.root, selected);
    assert.ok(source, 'persisted project identities keep the database tools available');
    try {
      const result = await source.call('project_signals', { project: 'Beta', kind: 'security' });
      assert.equal(JSON.parse(result.content).alerts[0].title, 'saved risk');
      const session = await createIntelligenceMcpSession({ getProjects: () => f.projects, getSelectedProjectPath: () => selected,
        getCurrentSteps: () => [], getSettings: () => ({ language: 'zh' }) }, source);
      try {
        const tools = (await session.client.listTools()).tools.map(tool => tool.name);
        assert.ok(tools.includes('solomap_project_signals'));
        assert.ok(tools.includes('solomap_start_conversation'));
        assert.equal(tools.includes('solomap_write'), false);
        assert.equal(tools.includes('solomap_read'), false);
        await assert.rejects(source.call('write', {}), /action_denied/);
      } finally { await session.close(); }
    } finally { await source.close(); }
  }
});

test('project discovery survives the actual Pi output boundary with very long project names', async t => {
  const f = await fixture(t);
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const registry = f.store.readProjectRegistry();
  const name = '长项目名'.repeat(20000);
  f.store.patchProjectRegistry({ expectedRevision: registry.revision, idempotencyKey: 'long-name',
    projectPatches: [{ path: f.projects[1].path, fields: { name } }] });
  let content = '';
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async invocation => {
    const input = invocation.stdin;
    if (input.lastIndexOf('TOOLRESULT:') <= input.lastIndexOf('USER:')) return JSON.stringify({ toolCall: { name: 'solomap_project_signals', arguments: {} } });
    assert.doesNotMatch(input, /Pi Harness tool output limit/);
    const result = JSON.parse(input.slice(input.lastIndexOf('TOOLRESULT:') + 11).trim().split('\n')[0]);
    assert.equal(Boolean(result.isError), false);
    const page = JSON.parse(result.content[0].text);
    content += page.content;
    if (page.cursor) return JSON.stringify({ toolCall: { name: 'solomap_project_signals', arguments: { cursor: page.cursor } } });
    assert.equal(JSON.parse(content).projects[1].name, name);
    return '完整读取项目列表。';
  } });
  assert.equal(await engine.chat([{ role: 'user', content: '列出项目' }], { selectedProject: '', projects: [] }, f.session.client), '完整读取项目列表。');
});
