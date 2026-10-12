const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openAnalysisOwner } = require('./analysis-fixture.js');
const { sendRuntimeDataRequest } = require('../out/autonomousRuntimeControl.js');

async function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-project-registry-owner-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const callbacks = []; let owner = await openAnalysisOwner({ after: fn => callbacks.push(fn) }, root, [{ path: project }]);
  t.after(async () => { for (const close of callbacks.splice(0).reverse()) await close(); });
  const call = async (operation, input = {}) => {
    try { return await sendRuntimeDataRequest(root, { operation, input }); }
    catch (error) { assert.fail(`${operation} must serve the database registry: ${error.message}`); }
  };
  return { base, root, project, call, get store() { return owner.store; }, waitForMigrations: () => owner.ops.waitForMigrations(),
    raw: (operation, input) => sendRuntimeDataRequest(root, { operation, input }),
    restart: async () => { for (const close of callbacks.splice(0).reverse()) await close(); owner = await openAnalysisOwner({ after: fn => callbacks.push(fn) }, root, [{ path: project }]); } };
}

test('formal project registry imports full display metadata and offline selection once and survives source isolation and owner restart', async t => {
  const f = await fixture(t), offline = path.join(f.base, 'offline');
  const file = path.join(f.root, 'projects.json');
  const legacy = { schemaVersion: 1, updatedAt: '2026-09-01T00:00:00.000Z', projects: [{ name: '用户项目', path: f.project, type: 'product', priority: 'high', description: '完整说明🌿', notes: '完整备注\n第二行', pinnedAt: '2026-09-01T00:00:00.000Z' }, { name: '暂时离线', path: offline }], hiddenProjects: [f.project] };
  const bytes = Buffer.from(JSON.stringify(legacy, null, 2)); fs.writeFileSync(file, bytes);
  const adopted = await f.call('initialize_project_registry', { legacyProjects: [{ name: '过时全局缓存', path: f.project }], legacySelectedProjectPath: offline });
  assert.deepEqual(adopted.registry.projects, legacy.projects); assert.deepEqual(adopted.registry.hiddenProjects, [f.project]);
  assert.equal(adopted.registry.selectedProjectPath, offline); assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(f.store.readMigrationSource(`project-registry:${f.root}`, 'projects.json').bytes, bytes);
  const mapping = f.store.rows('SELECT object_id,imported_revision,stage FROM migration_items WHERE source_identity=? AND source_key=?', [`project-registry:${f.root}`, 'projects.json'])[0];
  assert.equal(mapping?.object_id, adopted.objectId, 'captured source must be reconciled to its formal registry');
  assert.equal(Number(mapping.imported_revision), adopted.revision); assert.equal(mapping.stage, 'imported');
  const isolation = path.join(f.base, 'source-isolation'); fs.mkdirSync(isolation); fs.renameSync(file, path.join(isolation, 'projects.json'));
  await f.restart();
  assert.deepEqual(await f.call('read_project_registry'), adopted);
  assert.deepEqual(await f.call('initialize_project_registry', { legacyProjects: [{ name: '不得覆盖库中项目', path: f.project }], workspaceRoot: f.project }), adopted);
  assert.equal(fs.existsSync(file), false); assert.deepEqual(fs.readFileSync(path.join(isolation, 'projects.json')), bytes);
});

test('formal project registry patches preserve concurrent unrelated fields and replay the exact accepted revision', async t => {
  const f = await fixture(t);
  const first = await f.call('initialize_project_registry', { legacyProjects: [{ name: '原名字', path: f.project, notes: '原备注' }] });
  const rename = { expectedRevision: first.revision, projectPatches: [{ path: f.project, fields: { name: '新名字' } }], idempotencyKey: 'rename-project' };
  const named = await f.call('patch_project_registry', rename);
  const notes = { expectedRevision: first.revision, projectPatches: [{ path: f.project, fields: { notes: '另一个窗口的新备注' } }], idempotencyKey: 'notes-project' };
  await assert.rejects(f.raw('patch_project_registry', notes), /revision_conflict/);
  const patched = await f.call('patch_project_registry', { ...notes, expectedRevision: named.revision });
  assert.deepEqual(patched.registry.projects, [{ name: '新名字', path: f.project, notes: '另一个窗口的新备注' }]);
  assert.deepEqual(await f.call('patch_project_registry', rename), named, 'lost reply replay must retain its exact committed revision');
  assert.deepEqual(await f.call('read_project_registry'), patched);
  assert.equal(fs.existsSync(path.join(f.root, 'projects.json')), false);
});

test('formal project registry hides, removes and selects projects without losing retained versions or writing a registry file', async t => {
  const f = await fixture(t), offline = path.join(f.base, 'offline');
  const initial = await f.call('initialize_project_registry', { legacyProjects: [{ name: '在线', path: f.project }, { name: '离线', path: offline }] });
  const changed = await f.call('patch_project_registry', { expectedRevision: initial.revision, hiddenPatches: [{ path: f.project, hidden: true }], selectedProjectPath: offline, idempotencyKey: 'hide-and-select' });
  assert.deepEqual(changed.registry.hiddenProjects, [f.project]); assert.equal(changed.registry.selectedProjectPath, offline);
  const removed = await f.call('patch_project_registry', { expectedRevision: changed.revision, projectPatches: [{ path: offline, remove: true }], idempotencyKey: 'remove-offline' });
  assert.deepEqual(removed.registry.projects, [{ name: '在线', path: f.project }]);
  assert.equal(removed.registry.selectedProjectPath, '');
  assert.deepEqual(await f.call('read_project_registry', { revision: initial.revision }), initial);
  await f.restart(); assert.deepEqual(await f.call('read_project_registry'), removed);
  assert.equal(fs.existsSync(path.join(f.root, 'projects.json')), false);
});

test('unchanged registry reads use the indexed revision header without decoding full metadata or rewriting the WAL', async t => {
  const f = await fixture(t);
  const projects = Array.from({ length: 58 }, (_, i) => ({ name: `项目${i}`, path: path.join(f.base, `project-${i}`), notes: '完整备注🌿'.repeat(80) }));
  const initial = await f.call('initialize_project_registry', { legacyProjects: projects });
  const content = f.store.content.bind(f.store); let decodes = 0;
  f.store.content = (...args) => { decodes++; return content(...args); };
  const walPath = path.join(f.root, 'solomap.db-wal'), wal = fs.readFileSync(walPath);
  for (let i = 0; i < 100; i++) assert.deepEqual(await f.call('read_project_registry', { knownRevision: initial.revision }), { objectId: initial.objectId, revision: initial.revision, unchanged: true, legacyContextImported: true });
  assert.equal(decodes, 0); assert.deepEqual(fs.readFileSync(walPath), wal);
  assert.deepEqual(await f.call('read_project_registry', { knownRevision: initial.revision, knownObjectId: 'another-registry-object' }), initial, 'a same revision from another object must not be treated as unchanged');
  assert.equal(fs.existsSync(path.join(f.root, 'projects.json')), false);
});

test('invalid registry patches do not corrupt the accepted metadata or clear fields absent from a partial update', async t => {
  const f = await fixture(t);
  const initial = await f.call('initialize_project_registry', { legacyProjects: [{ name: '原名字', path: f.project, priority: 'high', notes: '要保留的备注' }] });
  for (const [index, patch] of [{ path: 'relative/project', fields: { name: '错误路径' } }, { path: f.project, fields: { agentCli: '错误内部字段' } }, { path: f.project, fields: { notes: null } }].entries()) {
    await assert.rejects(f.raw('patch_project_registry', { expectedRevision: initial.revision, projectPatches: [patch], idempotencyKey: `bad-project-${index}` }), /invalid_project_registry_patch/);
    assert.deepEqual(await f.call('read_project_registry'), initial);
  }
  const changed = await f.call('patch_project_registry', { expectedRevision: initial.revision, projectPatches: [{ path: f.project, fields: { priority: '' } }], idempotencyKey: 'clear-priority' });
  assert.deepEqual(changed.registry.projects, [{ name: '原名字', path: f.project, notes: '要保留的备注' }]);
});

test('the existing project registry writer commits to the owner and never recreates projects.json', async t => {
  const f = await fixture(t);
  await f.call('initialize_project_registry', { legacyProjects: [{ name: '原名称', path: f.project, notes: '完整备注' }] });
  await require('../out/projectRegistry.js').writeProjectRegistry(f.root, 'projects.json', [{ name: '新名称', path: f.project }], []);
  const current = await f.call('read_project_registry');
  assert.deepEqual(current.registry.projects, [{ name: '新名称', path: f.project, notes: '完整备注' }]);
  assert.equal(fs.existsSync(path.join(f.root, 'projects.json')), false);
});

test('the actual intelligence project read tool awaits the formal registry and sees a committed rename immediately', async t => {
  const f = await fixture(t);
  const initial = await f.call('initialize_project_registry', { legacyProjects: [{ name: '原名称', path: f.project, priority: 'high', description: '完整说明' }] });
  const tools = require('../out/intelligenceReadTools.js').createIntelligenceReadTools({
    async getProjects() { return (await f.call('read_project_registry')).registry.projects; },
    getSelectedProjectPath() { return f.project; }, getCurrentSteps() { return []; }, getSettings() { return { language: 'zh' }; }
  });
  await f.call('patch_project_registry', { expectedRevision: initial.revision, projectPatches: [{ path: f.project, fields: { name: '提交后的新名称' } }], idempotencyKey: 'intelligence-registry-rename' });
  const result = await tools.call('list_projects').catch(error => ({ error: error.message }));
  assert.deepEqual(result, [{ name: '提交后的新名称', priority: 'high', description: '完整说明' }]);
  const selected = await tools.call('get_current_project');
  assert.equal(selected.selectedProject.name, '提交后的新名称');
});

test('a delayed registry read cannot overwrite a committed field patch or cross another data root', async t => {
  const f = await fixture(t), other = await fixture(t);
  const registry = require('../out/projectRegistry.js');
  await f.call('initialize_project_registry', { legacyProjects: [{ name: '旧名', path: f.project, notes: '备注' }] });
  await other.call('initialize_project_registry', { legacyProjects: [{ name: '另一根', path: other.project }] });
  await registry.refreshProjectRegistry(f.root); await registry.refreshProjectRegistry(other.root);
  let release, readReady;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { readReady = resolve; });
  const stale = registry.refreshProjectRegistry(f.root, undefined, async (operation, input) => {
    const snapshot = await f.raw(operation, {}); readReady(); await gate; return snapshot;
  });
  await ready;
  const committed = await registry.patchProjectRegistry(f.root, { projectPatches: [{ path: f.project, fields: { name: '用户刚改的名称' } }] }, 'delayed-read-name');
  release();
  assert.deepEqual(await stale, committed);
  assert.deepEqual(registry.getProjectsSnapshot({ globalDataPath: f.root, projectRegistryFileName: 'projects.json', legacyProjects: [], legacyHiddenProjects: [] }), [{ name: '用户刚改的名称', path: f.project, notes: '备注' }]);
  assert.deepEqual(registry.getProjectsSnapshot({ globalDataPath: other.root, projectRegistryFileName: 'projects.json', legacyProjects: [], legacyHiddenProjects: [] }), [{ name: '另一根', path: other.project }]);
});

test('a stale window retries its exact registry fields after a concurrent committed rename', async t => {
  const f = await fixture(t), registry = require('../out/projectRegistry.js');
  const initial = await f.call('initialize_project_registry', { legacyProjects: [{ name: '旧名', path: f.project, priority: 'high', notes: '原备注' }] });
  await registry.refreshProjectRegistry(f.root);
  await f.call('patch_project_registry', { expectedRevision: initial.revision, projectPatches: [{ path: f.project, fields: { name: '窗口一新名称' } }], idempotencyKey: 'window-one-rename' });
  const accepted = await registry.patchProjectRegistry(f.root, { projectPatches: [{ path: f.project, fields: { notes: '窗口二完整备注' } }] }, 'window-two-notes');
  assert.deepEqual(accepted.registry.projects, [{ name: '窗口一新名称', path: f.project, priority: 'high', notes: '窗口二完整备注' }]);
  assert.deepEqual(await f.call('read_project_registry'), accepted);
  await f.restart();
  assert.deepEqual(await registry.refreshProjectRegistry(f.root), accepted);
});

test('the standalone runtime reads the database registry after its legacy source is isolated', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-registry-runtime-'));
  const root = path.join(base, '.solomap-global'); fs.mkdirSync(root);
  const alpha = path.join(base, 'alpha'), beta = path.join(base, 'beta');
  for (const [project, status] of [[alpha, 'Pending'], [beta, 'Failed']]) {
    fs.mkdirSync(path.join(project, '.solopreneur'), { recursive: true });
    fs.writeFileSync(path.join(project, '.solopreneur', 'roadmap.csv'), `id,title,stage,status,dependencies\n1,用户任务,实施,${status},\n`);
  }
  const file = path.join(root, 'projects.json');
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, projects: [{ name: 'Alpha', path: alpha, priority: 'P1' }, { name: 'Beta', path: beta, priority: 'P2' }], hiddenProjects: [] })); fs.writeFileSync(file, bytes);
  const run = async () => {
    const result = await require('node:util').promisify(require('node:child_process').execFile)(process.execPath, [path.resolve(__dirname, '../out/autonomousRuntimeProcess.js'), '--once', '--global-data-path', root], { env: { ...process.env, SOLOMAP_GLOBAL_DATA_PATH: root } });
    assert.equal(result.stdout.includes('Error'), false);
    const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
    const runtimeStore = UnifiedDataStore.open(root);
    try {
      return runtimeStore.readHostSettings({ namespace: 'runtime_shadow', ownerScope: 'global' }).items.find(item => item.key === 'decision').value;
    } finally { runtimeStore.close(); }
  };
  assert.equal((await run()).recommendedProjectPath, beta);
  const isolation = path.join(base, 'source-isolation'); fs.mkdirSync(isolation); fs.renameSync(file, path.join(isolation, 'projects.json'));
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const store = UnifiedDataStore.open(root);
  try { const snapshot = store.readProjectRegistry(); assert.deepEqual(snapshot.registry.projects.map(project => project.path), [alpha, beta]); }
  finally { store.close(); }
  assert.equal((await run()).recommendedProjectPath, beta);
  assert.equal(fs.existsSync(file), false); assert.deepEqual(fs.readFileSync(path.join(isolation, 'projects.json')), bytes);
});

test('invalid legacy registry bytes remain fully captured without creating a guessed registry or changing the source', async t => {
  for (const bytes of [Buffer.from('{"projects": [完整损坏字节🌿'), Buffer.from('{"projects": [], "hiddenProjects": "错误结构"}')]) {
    const f = await fixture(t), file = path.join(f.root, 'projects.json'); fs.writeFileSync(file, bytes);
    await assert.rejects(f.raw('initialize_project_registry', { legacyProjects: [{ name: '不得用缓存冒充成功', path: f.project }] }), /project_registry_source_invalid/);
    const captured = f.store.readMigrationSource(`project-registry:${f.root}`, 'projects.json');
    assert.deepEqual(captured.bytes, bytes); assert.equal(captured.stage, 'unmapped');
    assert.equal(await f.call('read_project_registry'), null); assert.deepEqual(fs.readFileSync(file), bytes);
    const walPath = path.join(f.root, 'solomap.db-wal'), wal = fs.readFileSync(walPath);
    await assert.rejects(f.raw('initialize_project_registry', {}), /project_registry_source_invalid/);
    assert.deepEqual(fs.readFileSync(walPath), wal, 'an unchanged malformed source must not create repeated capture writes');
  }
});

test('runtime-first registry creation still imports the plugin legacy selection once without replacing database metadata', async t => {
  const f = await fixture(t), offline = path.join(f.base, 'offline');
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, projects: [{ name: '文件中的正式名称', path: f.project }, { name: '离线项目', path: offline }], hiddenProjects: [] }));
  const file = path.join(f.root, 'projects.json'); fs.writeFileSync(file, bytes);
  await f.call('initialize_project_registry', {});
  const isolation = path.join(f.base, 'source-isolation'); fs.mkdirSync(isolation); fs.renameSync(file, path.join(isolation, 'projects.json'));
  let calls = 0;
  const registry = require('../out/projectRegistry.js');
  const hints = { legacyProjects: [{ name: '过时缓存名称', path: f.project }], legacyHiddenProjects: [], legacySelectedProjectPath: offline, workspaceRoot: f.project };
  const imported = await registry.refreshProjectRegistry(f.root, () => { calls++; return hints; });
  assert.equal(imported.registry.selectedProjectPath, offline, 'a runtime-first import must not lose the plugin saved selection');
  assert.equal(imported.registry.projects[0].name, '文件中的正式名称'); assert.equal(calls, 1);
  const captured = f.store.readMigrationSource(`project-registry:${f.root}`, 'vscode-project-state');
  assert.deepEqual(JSON.parse(captured.bytes.toString()), hints); assert.equal(captured.stage, 'imported');
  const mapping = f.store.rows('SELECT object_id,imported_revision FROM migration_items WHERE source_identity=? AND source_key=?', [`project-registry:${f.root}`, 'vscode-project-state'])[0];
  assert.equal(mapping.object_id, imported.objectId); assert.equal(Number(mapping.imported_revision), imported.revision);
  const changed = await registry.patchProjectRegistry(f.root, { selectedProjectPath: f.project, projectPatches: [{ path: f.project, fields: { name: '用户新名称' } }] }, 'after-first-context');
  const wal = fs.readFileSync(path.join(f.root, 'solomap.db-wal'));
  assert.deepEqual(await registry.refreshProjectRegistry(f.root, () => assert.fail('legacy context must not be read again')), changed);
  await f.restart();
  assert.deepEqual(await registry.refreshProjectRegistry(f.root, () => assert.fail('restart must not reimport stale context')), changed);
  assert.equal(fs.existsSync(file), false); assert.deepEqual(fs.readFileSync(path.join(isolation, 'projects.json')), bytes);
});

test('a runtime-created empty registry imports plugin-only legacy projects and hidden metadata without losing an earlier user action', async t => {
  const f = await fixture(t), offline = path.join(f.base, 'offline');
  const first = await f.call('initialize_project_registry', {});
  await f.call('patch_project_registry', { expectedRevision: first.revision, projectPatches: [{ path: f.project, fields: { name: '用户的新项目', notes: '不能覆盖' } }], selectedProjectPath: f.project, idempotencyKey: 'new-project-before-context' });
  const hints = { legacyProjects: [{ name: '旧缓存', path: f.project, notes: '旧备注' }, { name: '离线旧项目', path: offline, notes: '完整旧备注' }], legacyHiddenProjects: [offline], legacySelectedProjectPath: offline };
  const imported = await require('../out/projectRegistry.js').refreshProjectRegistry(f.root, () => hints);
  assert.deepEqual(imported.registry.projects, [{ name: '用户的新项目', path: f.project, notes: '不能覆盖' }, { name: '离线旧项目', path: offline, notes: '完整旧备注' }]);
  assert.deepEqual(imported.registry.hiddenProjects, [offline]); assert.equal(imported.registry.selectedProjectPath, f.project);
  assert.deepEqual(JSON.parse(f.store.readMigrationSource(`project-registry:${f.root}`, 'vscode-project-state').bytes.toString()), hints);
  assert.equal(fs.existsSync(path.join(f.root, 'projects.json')), false);
});


test('startup memory migration discovers a database-only registered project without consulting projects.json', async t => {
  const f = await fixture(t), archived = path.join(f.base, 'archived-project'); fs.mkdirSync(archived);
  await f.call('initialize_project_registry', { legacyProjects: [{ name: '正式登记项目', path: archived }] });
  const directory = path.join(f.root, 'memory', 'projects'); fs.mkdirSync(directory, { recursive: true });
  const source = path.join(directory, 'archived-project.md'), text = '项目完整历史 archived-database-proof 🌿'; fs.writeFileSync(source, text);
  await require('../out/runtimeDatabaseBootstrap.js').enqueueStartupMemoryMigration(f.store, request => f.raw(request.operation, request.input), () => true);
  await f.waitForMigrations();
  const project = await f.call('register_project', { root: archived });
  const found = await f.call('search', { scope: project.projectId, kinds: ['memory'], query: 'archived-database-proof' });
  assert.equal(found.items.length, 1, 'the project scope must be derived from the formal registry');
  assert.equal((await f.call('read', { ref: found.items[0].objectId })).data.content, text);
  assert.equal(fs.readFileSync(source, 'utf8'), text); assert.equal(fs.existsSync(path.join(f.root, 'projects.json')), false);
});

test('a legacy registry without optional hiddenProjects still imports its full project metadata', async t => {
  const f = await fixture(t);
  const legacy = { projects: [{ name: '旧格式项目', path: f.project, notes: '旧格式完整备注' }] };
  const bytes = Buffer.from(JSON.stringify(legacy)); fs.writeFileSync(path.join(f.root, 'projects.json'), bytes);
  const snapshot = await f.call('initialize_project_registry', {});
  assert.deepEqual(snapshot.registry.projects, legacy.projects); assert.deepEqual(snapshot.registry.hiddenProjects, []);
  assert.deepEqual(f.store.readMigrationSource(`project-registry:${f.root}`, 'projects.json').bytes, bytes);
});

test('formal project reads share the committed registry metadata and retained notes instead of an independent basename', async t => {
  const f = await fixture(t);
  const project = await f.call('register_project', { root: f.project });
  const initial = await f.call('initialize_project_registry', { legacyProjects: [{ name: '正式名称', path: f.project, type: 'tool', priority: 'high', description: '正式说明', notes: '完整项目备注🌿' }] });
  const first = await f.call('read', { ref: project.projectId });
  assert.equal(first.data.name, '正式名称', 'the public project object must share the application registry metadata');
  assert.equal(first.data.type, 'tool'); assert.equal(first.data.priority, 'high'); assert.equal(first.data.description, '正式说明');
  assert.equal(first.data.notes_content, '完整项目备注🌿');
  const updated = await f.call('patch_project_registry', { expectedRevision: initial.revision, projectPatches: [{ path: f.project, fields: { name: '改名后的正式项目', notes: '完整新备注\n第二行🌿' } }], idempotencyKey: 'formal-project-metadata' });
  const current = await f.call('read', { ref: project.projectId });
  assert.equal(current.data.name, '改名后的正式项目'); assert.equal(current.data.notes_content, '完整新备注\n第二行🌿');
  const retained = await f.call('read', { ref: project.projectId, revision: first.revision });
  assert.equal(retained.data.name, '正式名称'); assert.equal(retained.data.notes_content, '完整项目备注🌿');
  assert.equal(updated.registry.projects[0].notes, current.data.notes_content);
  await f.restart(); assert.deepEqual(await f.call('read', { ref: project.projectId }), current);
  assert.equal(fs.existsSync(path.join(f.root, 'projects.json')), false);
});

test('a project first registered after registry import receives its full metadata without another legacy read', async t => {
  const f = await fixture(t), next = path.join(f.base, 'next-project'); fs.mkdirSync(next);
  await f.call('initialize_project_registry', { legacyProjects: [{ name: '已登记的新项目', path: next, notes: '保留首次登记之前的备注' }] });
  const registered = await f.call('register_project', { root: next });
  const read = await f.call('read', { ref: registered.projectId });
  assert.equal(read.data.name, '已登记的新项目'); assert.equal(read.data.notes_content, '保留首次登记之前的备注');
  const wal = fs.readFileSync(path.join(f.root, 'solomap.db-wal'));
  await f.call('register_project', { root: next });
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'solomap.db-wal')), wal, 'unchanged registration must not append metadata revisions');
});

test('a logical directory alias and its physical project share metadata while other projects keep their revisions', async t => {
  const f = await fixture(t), alias = path.join(f.base, 'project-alias'), peer = path.join(f.base, 'peer'); fs.symlinkSync(f.project, alias, 'dir'); fs.mkdirSync(peer);
  const own = await f.call('register_project', { root: alias }), foreign = await f.call('register_project', { root: peer });
  const initial = await f.call('initialize_project_registry', { legacyProjects: [{ name: '目录别名的项目', path: alias, notes: '完整别名备注' }, { name: '其他项目', path: peer }] });
  const before = await f.call('read', { ref: foreign.projectId });
  assert.equal((await f.call('read', { ref: own.projectId })).data.name, '目录别名的项目');
  await f.call('patch_project_registry', { expectedRevision: initial.revision, projectPatches: [{ path: alias, fields: { notes: '别名下的新备注' } }], idempotencyKey: 'alias-project-notes' });
  assert.equal((await f.call('read', { ref: own.projectId })).data.notes_content, '别名下的新备注');
  assert.deepEqual(await f.call('read', { ref: foreign.projectId }), before);
});

test('invalid typed pin metadata cannot partially commit a name or note change', async t => {
  const f = await fixture(t);
  const original = await f.call('initialize_project_registry', { legacyProjects: [{ name: '原正式名称', path: f.project, notes: '原完整备注' }] });
  const project = await f.call('register_project', { root: f.project });
  const before = await f.call('read', { ref: project.projectId }), wal = fs.readFileSync(path.join(f.root, 'solomap.db-wal'));
  await assert.rejects(f.raw('patch_project_registry', { expectedRevision: original.revision, projectPatches: [{ path: f.project, fields: { name: '不该部分写入', notes: '不该部分写入的备注', pinnedAt: 'not-a-date' } }], idempotencyKey: 'invalid-typed-project-pin' }), /project_registry_pin_invalid/);
  assert.deepEqual(await f.call('read_project_registry'), original); assert.deepEqual(await f.call('read', { ref: project.projectId }), before);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'solomap.db-wal')), wal);
});

test('re-registering two directory aliases preserves the last accepted metadata and does not rewrite the WAL', async t => {
  const f = await fixture(t), alias = path.join(f.base, 'same-project-alias'); fs.symlinkSync(f.project, alias, 'dir');
  const own = await f.call('register_project', { root: f.project });
  const initial = await f.call('initialize_project_registry', { legacyProjects: [{ name: '物理目录名称', path: f.project, notes: '物理目录备注' }, { name: '别名展示名称', path: alias, notes: '别名原备注' }] });
  const updated = await f.call('patch_project_registry', { expectedRevision: initial.revision, projectPatches: [{ path: alias, fields: { notes: '最后接受的完整备注🌿' } }], idempotencyKey: 'last-alias-metadata' });
  const before = await f.call('read', { ref: own.projectId }), wal = fs.readFileSync(path.join(f.root, 'solomap.db-wal'));
  for (const root of [f.project, alias, f.project, alias]) {
    assert.equal((await f.call('register_project', { root })).projectId, own.projectId);
    assert.deepEqual(await f.call('read', { ref: own.projectId }), before);
  }
  assert.deepEqual(await f.call('read_project_registry'), updated);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'solomap.db-wal')), wal);
  await f.restart();
  await f.call('register_project', { root: alias });
  assert.deepEqual(await f.call('read', { ref: own.projectId }), before);
});

test('an offline directory alias retains its database project binding for metadata edits and restart', async t => {
  const f = await fixture(t), alias = path.join(f.base, 'offline-project-alias'); fs.symlinkSync(f.project, alias, 'dir');
  const own = await f.call('register_project', { root: alias });
  const initial = await f.call('initialize_project_registry', { legacyProjects: [{ name: '离线别名项目', path: alias, notes: '原完整备注' }] });
  fs.renameSync(alias, path.join(f.base, 'isolated-project-alias'));
  const updated = await f.call('patch_project_registry', { expectedRevision: initial.revision, projectPatches: [{ path: alias, fields: { name: '离线时的新名称', notes: '离线时保存的完整备注🌿' } }], idempotencyKey: 'offline-alias-metadata' });
  const project = await f.call('read', { ref: own.projectId });
  assert.equal(project.data.name, '离线时的新名称'); assert.equal(project.data.notes_content, '离线时保存的完整备注🌿');
  await f.restart();
  assert.deepEqual(await f.call('read_project_registry'), updated);
  assert.deepEqual(await f.call('read', { ref: own.projectId }), project);
  assert.deepEqual(f.store.registeredProjectRoots(), [f.project], 'the offline logical alias must not become another runtime scan root');
});

test('concurrent logical aliases share one identity and retain distinct bindings without duplicate scan roots', async t => {
  const f = await fixture(t), aliases = ['alias-one', 'alias-two'].map(name => path.join(f.base, name));
  for (const alias of aliases) fs.symlinkSync(f.project, alias, 'dir');
  const registered = await Promise.all(aliases.map(root => f.call('register_project', { root })));
  assert.equal(registered[0].projectId, registered[1].projectId);
  assert.equal(f.store.rows("SELECT id FROM project_locations WHERE project_id=? AND status='alias'", [registered[0].projectId]).length, 2);
  assert.deepEqual(f.store.registeredProjectRoots(), [f.project]);
  const wal = fs.readFileSync(path.join(f.root, 'solomap.db-wal'));
  await Promise.all(aliases.map(root => f.call('register_project', { root })));
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'solomap.db-wal')), wal);
});

test('a retargeted directory alias cannot apply metadata to another project under its previous binding', async t => {
  const f = await fixture(t), peer = path.join(f.base, 'other-project'), alias = path.join(f.base, 'retargeted-alias'); fs.mkdirSync(peer); fs.symlinkSync(f.project, alias, 'dir');
  const own = await f.call('register_project', { root: alias }), foreign = await f.call('register_project', { root: peer });
  const initial = await f.call('initialize_project_registry', { legacyProjects: [{ name: '原别名项目', path: alias }] });
  const ownBefore = await f.call('read', { ref: own.projectId }), foreignBefore = await f.call('read', { ref: foreign.projectId });
  fs.renameSync(alias, path.join(f.base, 'original-alias-isolation')); fs.symlinkSync(peer, alias, 'dir');
  const wal = fs.readFileSync(path.join(f.root, 'solomap.db-wal'));
  await assert.rejects(f.raw('patch_project_registry', { expectedRevision: initial.revision, projectPatches: [{ path: alias, fields: { notes: '不得串项目' } }], idempotencyKey: 'retargeted-alias-edit' }), /project_registry_alias_conflict/);
  assert.deepEqual(await f.call('read_project_registry'), initial);
  assert.deepEqual(await f.call('read', { ref: own.projectId }), ownBefore); assert.deepEqual(await f.call('read', { ref: foreign.projectId }), foreignBefore);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'solomap.db-wal')), wal);
});

test('project-scoped MCP sessions read their own complete notes while global registry state and private peers stay denied', async t => {
  const f = await fixture(t), peer = path.join(f.base, 'private-peer'); fs.mkdirSync(peer);
  const own = await f.call('register_project', { root: f.project }), foreign = await f.call('register_project', { root: peer });
  const registry = await f.call('initialize_project_registry', { legacyProjects: [{ name: '自己的项目', path: f.project, notes: '自己的完整备注🌿' }, { name: '私有其他项目', path: peer, notes: '其他项目私有备注' }] });
  const session = await f.call('open_mcp_session', { projectId: own.projectId });
  const call = (operation, input) => sendRuntimeDataRequest(f.root, { operation, input, sessionToken: session.sessionToken });
  assert.equal((await call('read', { ref: own.projectId })).data.notes_content, '自己的完整备注🌿');
  for (const ref of [registry.objectId, foreign.projectId]) for (const operation of ['read', 'export']) {
    await assert.rejects(call(operation, { ref, revision: 1, format: 'json', destination: path.join(f.base, 'denied-export.json'), idempotencyKey: `denied-${operation}-${ref}` }), /scope_denied/);
  }
  for (const operation of ['initialize_project_registry', 'read_project_registry', 'patch_project_registry']) await assert.rejects(call(operation, {}), /action_denied/);
  const result = await call('search', { scope: own.projectId, kinds: ['setting'], query: 'project_registry' });
  assert.equal(result.items.length, 0); assert.equal(fs.existsSync(path.join(f.base, 'denied-export.json')), false);
  assert.deepEqual(await f.call('read_project_registry'), registry);
  await f.call('close_mcp_session', { sessionToken: session.sessionToken });
});

test('a bound alias retargeted to an unregistered directory is rejected before registry or identity writes', async t => {
  const f = await fixture(t), target = path.join(f.base, 'unregistered-target'), alias = path.join(f.base, 'bound-alias'); fs.mkdirSync(target); fs.symlinkSync(f.project, alias, 'dir');
  const own = await f.call('register_project', { root: alias });
  const initial = await f.call('initialize_project_registry', { legacyProjects: [{ name: '原项目', path: alias, notes: '保留原备注' }] });
  fs.renameSync(alias, path.join(f.base, 'bound-alias-isolation')); fs.symlinkSync(target, alias, 'dir');
  const before = await f.call('read', { ref: own.projectId }), wal = fs.readFileSync(path.join(f.root, 'solomap.db-wal'));
  await assert.rejects(f.raw('patch_project_registry', { expectedRevision: initial.revision, projectPatches: [{ path: alias, fields: { notes: '不能接受的备注' } }], idempotencyKey: 'unknown-alias-target' }), /project_registry_alias_conflict/);
  await assert.rejects(f.raw('register_project', { root: alias }), /project_registry_alias_conflict/);
  assert.deepEqual(await f.call('read_project_registry'), initial); assert.deepEqual(await f.call('read', { ref: own.projectId }), before);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'solomap.db-wal')), wal); assert.equal(fs.existsSync(path.join(target, '.solopreneur', 'project.json')), false);
});
