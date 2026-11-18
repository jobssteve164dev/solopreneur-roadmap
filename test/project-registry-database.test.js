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

test('project autonomy publishes the complete fixed result and rolls back earlier revocations on a later settings failure', async t => {
  const f = await fixture(t);
  const other = path.join(f.base, 'other'); fs.mkdirSync(other);
  const input = { projectPath: f.project, registeredProjectPaths: [f.project, other], expectedEpoch: 0, enabled: true,
    toolNetworkDisabled: true, idempotencyKey: 'prepared-autonomy-enable' };
  const patch = f.store.patchHostSettings.bind(f.store);
  f.store.patchHostSettings = value => {
    if (value.namespace === 'project_autonomy') throw new Error('legacy_writer_autonomy_settings');
    return patch(value);
  };
  const enabled = await f.call('patch_project_autonomy_authorization', input);
  const second = await f.call('patch_project_autonomy_authorization', { ...input, projectPath: other, idempotencyKey: 'prepared-autonomy-other' });
  const payload = { ...enabled, preserved: '完整授权内容🌿'.repeat(1024) };
  const scope = { namespace: 'project_autonomy', ownerScope: 'global' };
  await f.call('patch_host_settings', { ...scope, idempotencyKey: 'autonomy-retain-legacy-value',
    patches: [{ key: enabled.projectId, expectedRevision: 1, value: payload }] });
  const unchanged = { ...input, expectedEpoch: 1, idempotencyKey: 'prepared-autonomy-unchanged' };
  assert.deepEqual(await f.call('patch_project_autonomy_authorization', unchanged), payload);
  const revoke = { idempotencyKey: 'prepared-autonomy-revoke' };
  const run = f.store.db.run.bind(f.store.db);
  const root = `${revoke.idempotencyKey}:setting:`;
  let started = 0;
  f.store.db.run = (sql, params) => {
    if (sql.startsWith('INSERT INTO requests(') && String(params?.[1]).startsWith(root)
        && String(params[1]).slice(root.length).length === 64 && ++started === 2) throw new Error('actual_second_autonomy_revoke');
    return run(sql, params);
  };
  try { await assert.rejects(f.raw('revoke_project_autonomy_authorizations', revoke), /actual_second_autonomy_revoke/); }
  finally { f.store.db.run = run; }
  assert.equal(started, 2);
  for (const grant of [enabled, second]) assert.equal((await f.call('read_project_autonomy_authorization', { projectPath: grant.projectPath })).enabled, true);
  const ordered=[enabled.projectId,second.projectId].sort();
  const occupied='prepared-autonomy-revoke-with-occupied-child';
  await f.call('patch_host_settings',{namespace:'runtime',ownerScope:'global',idempotencyKey:`${occupied}:setting:${ordered[1]}`,
    patches:[{key:'occupiedRequest',expectedRevision:0,value:true}]});
  f.store.db.run=(sql,params)=>{
    if(sql.startsWith('INSERT INTO requests(') && params?.[1]===`${occupied}:setting:${ordered[0]}`)throw new Error('actual_first_autonomy_revoke');
    return run(sql,params);
  };
  try{await assert.rejects(f.raw('revoke_project_autonomy_authorizations',{idempotencyKey:occupied}),/actual_first_autonomy_revoke/);}
  finally{f.store.db.run=run;}
  const result = await f.call('revoke_project_autonomy_authorizations', revoke);
  assert.equal(result.items.length, 2);
  assert.equal(result.items.find(item => item.projectId === enabled.projectId).preserved, payload.preserved);
  assert.ok(result.items.every(item => !item.enabled && item.epoch === 2 && item.toolNetworkDisabled));
  assert.deepEqual(await f.call('revoke_project_autonomy_authorizations', revoke), result);
  assert.deepEqual(await f.call('patch_project_autonomy_authorization', unchanged), payload);
});

test('project autonomy rechecks the physical path after the actual root request insert',async t=>{
  const f=await fixture(t),key='autonomy-late-path-loss',isolated=path.join(f.base,'isolated-after-root-request');
  const run=f.store.db.run.bind(f.store.db);
  let moved=false;
  f.store.db.run=(sql,params)=>{
    const result=run(sql,params);
    if(!moved && sql.startsWith('INSERT INTO requests(') && params?.[1]===key){
      moved=true;fs.renameSync(f.project,isolated);
    }
    return result;
  };
  try{await assert.rejects(f.raw('patch_project_autonomy_authorization',{projectPath:f.project,registeredProjectPaths:[f.project],
    enabled:true,toolNetworkDisabled:true,expectedEpoch:0,idempotencyKey:key}),/ENOENT/);}
  finally{f.store.db.run=run;}
  assert.equal(moved,true);
  assert.equal(f.store.rows('SELECT 1 FROM requests WHERE idempotency_key=?',[key]).length,0);
  assert.equal((await f.call('read_project_autonomy_authorization',{projectPath:f.project})).enabled,false);
});

test('project location move publishes settings and full schedule bodies and rolls back through the original late SQL', async t=>{
  const f=await fixture(t),target=path.join(f.base,'moved-full-project');
  const project=await f.call('register_project',{root:f.project});
  const original=await f.call('initialize_project_registry',{legacyProjects:[{name:'原项目',path:f.project}],legacySelectedProjectPath:f.project});
  await f.call('patch_project_autonomy_authorization',{projectPath:f.project,registeredProjectPaths:[f.project],enabled:true,toolNetworkDisabled:true,
    expectedEpoch:0,idempotencyKey:'move-keep-autonomy'});
  const task={id:'move-task',projectPath:f.project,nested:[{sourceTimePlanProjectPath:f.project,body:'完整内容🌿'.repeat(2048)}]};
  await f.call('patch_host_settings',{namespace:'extension',ownerScope:'global',patches:[{key:'automationTasks',expectedRevision:0,value:[task]}],idempotencyKey:'move-task-setup'});
  const dueAt=Date.parse('2026-12-01T09:00:00Z');
  await f.call('sync_schedules',{schedules:[{id:task.id,enabled:true,timezone:'UTC',nextDueAt:dueAt,trigger:{kind:'once'},task}],idempotencyKey:'move-task-schedule'});
  await f.call('patch_ui_state',{view:'sidebar',scopeKey:f.project,patches:[{key:'interaction.issueDraftTitle',expectedRevision:0,value:'未提交草稿'}],idempotencyKey:'move-ui-setup'});
  fs.renameSync(f.project,target);
  const input={expectedRevision:original.revision,projectPatches:[{path:f.project,remove:true},{path:target,fields:{name:'移动后项目',notes:'完整说明🌿'.repeat(2048)}}],
    selectedProjectPath:target,autonomyMove:{sourcePath:f.project,targetPath:target},idempotencyKey:'prepared-registry-location-move'};
  const patch=f.store.patchHostSettings.bind(f.store),write=f.store.write.bind(f.store),encode=f.store.putStructuredContent.bind(f.store);
  f.store.patchHostSettings=input=>{if(input.idempotencyKey.startsWith('prepared-registry-location-move:'))throw new Error('legacy_registry_move_settings');return patch(input);};
  f.store.write=input=>{if(input.idempotencyKey.startsWith('prepared-registry-location-move:'))throw new Error('legacy_registry_move_schedule');return write(input);};
  f.store.putStructuredContent=value=>{if(value?.id===task.id && value?.projectPath===target)throw new Error('legacy_registry_move_payload');return encode(value);};
  const run=f.store.db.run.bind(f.store.db);
  f.store.db.run=(sql,params)=>{
    if(sql.startsWith('UPDATE scheduled_occurrences SET payload_content_id='))throw new Error('actual_late_registry_move_occurrence');
    return run(sql,params);
  };
  try{await assert.rejects(f.raw('patch_project_registry',input),/actual_late_registry_move_occurrence/);}
  finally{f.store.db.run=run;}
  assert.deepEqual(await f.call('read_project_registry'),original);
  assert.equal(f.store.rows("SELECT root_path FROM project_locations WHERE project_id=? AND status='active'",[project.projectId])[0].root_path,f.project);
  assert.equal((await f.call('read_project_autonomy_authorization',{projectPath:f.project})).enabled,true);
  const moved=await f.call('patch_project_registry',input);
  assert.equal(moved.registry.projects[0].notes,input.projectPatches[1].fields.notes);
  assert.equal(f.store.rows("SELECT root_path FROM project_locations WHERE project_id=? AND status='active'",[project.projectId])[0].root_path,target);
  const expected={...task,projectPath:target,nested:[{...task.nested[0],sourceTimePlanProjectPath:target}]};
  assert.deepEqual(f.store.readScheduleLedger().tasks[0].task,expected);
  assert.deepEqual(f.store.readHostSettings({namespace:'extension',ownerScope:'global',keys:['automationTasks']}).items[0].value,[expected]);
  assert.equal((await f.call('read_project_autonomy_authorization',{projectPath:target})).enabled,true);
  assert.equal((await f.call('read_ui_state',{view:'sidebar',scopeKey:target})).items.find(item=>item.key==='interaction.issueDraftTitle').value,'未提交草稿');
  assert.deepEqual(await f.call('patch_project_registry',input),moved);
});

test('project location move keeps earlier Native location errors ahead of a later retargeted alias conflict',async t=>{
  const f=await fixture(t),target=path.join(f.base,'move-target'),peer=path.join(f.base,'peer'),alias=path.join(f.base,'peer-alias');
  fs.mkdirSync(peer);fs.symlinkSync(peer,alias,'dir');
  await f.call('register_project',{root:f.project});
  await f.call('register_project',{root:alias});
  const initial=await f.call('initialize_project_registry',{legacyProjects:[{name:'原项目',path:f.project},{name:'其他项目',path:alias}]});
  fs.renameSync(f.project,target);fs.renameSync(alias,path.join(f.base,'old-peer-alias'));fs.symlinkSync(target,alias,'dir');
  const input={expectedRevision:initial.revision,projectPatches:[{path:f.project,remove:true},{path:target,fields:{name:'已移动'}},{path:alias,fields:{name:'仍是其他项目'}}],
    autonomyMove:{sourcePath:f.project,targetPath:target},idempotencyKey:'move-alias-original-sql'};
  const run=f.store.db.run.bind(f.store.db);
  f.store.db.run=(sql,params)=>{
    if(sql.startsWith("UPDATE project_locations SET status='moved'"))throw new Error('actual_location_before_alias');
    return run(sql,params);
  };
  try{await assert.rejects(f.raw('patch_project_registry',input),/actual_location_before_alias/);}
  finally{f.store.db.run=run;}
  await assert.rejects(f.raw('patch_project_registry',input),/project_registry_alias_conflict/);
  assert.deepEqual(await f.call('read_project_registry'),initial);
});

test('project location move reselects a target restored after the confirmed missing filesystem selection',async t=>{
  const f=await fixture(t),target=path.join(f.base,'restored-move-target');
  await f.call('register_project',{root:f.project});
  const initial=await f.call('initialize_project_registry',{legacyProjects:[{name:'原项目',path:f.project}]});
  const compute=f.store.projectMigrationInspectionCompute;
  let attempts=0;
  f.store.projectMigrationInspectionCompute=async request=>{
    const plan=await compute(request);
    if(request.kind==='registryMove' && ++attempts===2)fs.renameSync(f.project,target);
    return plan;
  };
  const result=await f.call('patch_project_registry',{expectedRevision:initial.revision,projectPatches:[{path:f.project,remove:true},{path:target,fields:{name:'移动后项目'}}],
    autonomyMove:{sourcePath:f.project,targetPath:target},idempotencyKey:'move-target-restored'});
  assert.ok(attempts>=3);
  assert.equal(result.registry.projects[0].path,target);
});

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
  const read = f.store.read.bind(f.store);
  f.store.read = (id, revision, ...rest) => {
    if (id === named.objectId && revision === named.revision) throw new Error('writer_read_legacy_registry_replay');
    return read(id, revision, ...rest);
  };
  assert.deepEqual(await f.call('patch_project_registry', rename), named, 'lost reply replay must retain its exact committed revision');
  assert.deepEqual(await f.call('read_project_registry'), patched);
  assert.equal(fs.existsSync(path.join(f.root, 'projects.json')), false);
});

test('registry replay reselects a retained revision when its current entity is removed or repaired', async t => {
  const f = await fixture(t);
  const first = await f.call('initialize_project_registry', { legacyProjects: [{ name: '原项目', path: f.project }] });
  const retained = { expectedRevision: first.revision, projectPatches: [{ path: f.project, fields: { name: '保留名称' } }], idempotencyKey: 'retained-registry-entity' };
  const accepted = await f.call('patch_project_registry', retained);
  const latest = await f.call('patch_project_registry', { expectedRevision: accepted.revision, projectPatches: [{ path: f.project, fields: { name: '最新名称' } }], idempotencyKey: 'latest-registry-entity' });
  const row = f.store.rows('SELECT * FROM settings WHERE id=?', [latest.objectId])[0];
  const original = f.store.projectMigrationInspectionCompute;
  let preparations = 0;
  f.store.projectMigrationInspectionCompute = async request => {
    const result = await original(request);
    if (request.kind === 'registryPatchReplay' && ++preparations === 1) f.store.db.run('DELETE FROM settings WHERE id=?', [latest.objectId]);
    return result;
  };
  await assert.rejects(f.raw('patch_project_registry', retained), /entity_missing/);
  preparations = 0;
  f.store.projectMigrationInspectionCompute = async request => {
    const result = await original(request);
    if (request.kind === 'registryPatchReplay' && ++preparations === 2) {
      const columns = Object.keys(row);
      f.store.db.run(`INSERT INTO settings(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, columns.map(key => row[key]));
    }
    return result;
  };
  assert.deepEqual(await f.call('patch_project_registry', retained), accepted);
  assert.deepEqual(await f.call('read_project_registry'), latest);
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
  t.after(() => {
    for (const file of [
      path.join(base, 'source-isolation', 'projects.json'),
      path.join(root, 'runtime', 'control.json'),
      path.join(root, 'runtime', 'owner.json'),
      path.join(root, 'solomap.db-wal'),
      path.join(root, 'solomap.db-shm'),
      path.join(root, 'solomap.db'),
      path.join(alpha, '.solopreneur', 'roadmap.csv'),
      path.join(alpha, '.solopreneur', 'project.json'),
      path.join(beta, '.solopreneur', 'roadmap.csv'),
      path.join(beta, '.solopreneur', 'project.json')
    ]) if (fs.existsSync(file)) fs.unlinkSync(file);
    for (const directory of [
      path.join(base, 'source-isolation'),
      path.join(root, 'runtime'),
      root,
      path.join(alpha, '.solopreneur'),
      alpha,
      path.join(beta, '.solopreneur'),
      beta,
      base
    ]) if (fs.existsSync(directory)) fs.rmdirSync(directory);
  });
  for (const [project, status] of [[alpha, 'Pending'], [beta, 'Failed']]) {
    fs.mkdirSync(path.join(project, '.solopreneur'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.solopreneur', 'roadmap.csv'),
      `id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,用户任务,,实施,,,,${status},,\n`
    );
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


for(const existing of [false,true])test(`registry context keeps complete legacy settings off the synchronous capture path (existing=${existing})`,async t=>{
  const f=await fixture(t),other=path.join(f.base,'other-project'); fs.mkdirSync(other);
  const registered=await f.call('register_project',{root:other});
  if(existing)await f.call('initialize_project_registry',{});
  const notes='完整旧项目备注🌿'.repeat(15000);
  const hints={legacyProjects:[{name:'离线项目',path:other,notes}],legacyHiddenProjects:[other]};
  const capture=f.store.captureMigrationSource.bind(f.store);
  f.store.captureMigrationSource=(source,...rest)=>{
    if(source.key==='vscode-project-state')throw new Error('registry_context_used_synchronous_capture');
    return capture(source,...rest);
  };
  const write=f.store.write.bind(f.store);
  f.store.write=(input,...rest)=>{
    if(input.kind==='project' && input.idempotencyKey.startsWith('project-registry-metadata:'))throw new Error('registry_context_metadata_used_legacy_write');
    return write(input,...rest);
  };
  const snapshot=await f.call('initialize_project_registry',hints);
  assert.equal(snapshot.legacyContextImported,true);
  assert.equal(snapshot.registry.projects.find(project=>project.path===other).notes===notes,true);
  const retained=f.store.readMigrationSource(`project-registry:${f.root}`,'vscode-project-state');
  assert.equal(retained.stage,'imported');
  assert.equal(JSON.parse(retained.bytes.toString()).legacyProjects[0].notes===notes,true);
  const metadata=await f.call('read',{ref:registered.projectId});
  assert.equal(metadata.data.notes_content===notes,true);
  assert.equal(metadata.data.hidden,1);
});

test('the first registry snapshot hashes identically to the accepted database snapshot', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, 'projects.json'), JSON.stringify({ schemaVersion: 1, hiddenProjects: [], projects: [
    { name: '项目名', path: f.project, priority: 'P1', notes: '记录完整决策依据' }
  ] }));
  const initialized = await f.call('initialize_project_registry', {});
  const accepted = await f.call('read_project_registry');
  const { todayRegistryRevision } = require('../out/todayDecisionInputs.js');
  assert.equal(todayRegistryRevision(initialized.registry), todayRegistryRevision(accepted.registry));
});

test('late registry files retain both matching and conflicting sources without Writer body reads', async t => {
  const f = await fixture(t), filename = path.join(f.root, 'projects.json');
  const project = { name: '正式项目', path: f.project, notes: '完整保留项目备注🌿'.repeat(12000) };
  const initial = await f.call('initialize_project_registry', { legacyProjects: [project], legacyHiddenProjects: [] });
  f.store.readProjectRegistry = () => { throw new Error('late_registry_decoded_in_writer'); };
  const identity = `project-registry:${f.root}`;
  const write = value => fs.writeFileSync(filename, JSON.stringify({ schemaVersion: 1, projects: [value], hiddenProjects: [] }));
  write(project);
  const matched = await f.call('initialize_project_registry', {});
  assert.equal(matched.revision, initial.revision);
  assert.equal(f.store.migrationSourceState(identity, 'projects.json').stage, 'imported');
  fs.appendFileSync(filename, '\n');
  f.store.db.run("CREATE TEMP TRIGGER reject_late_registry_import BEFORE UPDATE OF stage ON migration_items WHEN NEW.source_key='projects.json' AND NEW.stage='imported' BEGIN SELECT RAISE(ABORT,'original_late_registry_marker'); END");
  await f.call('initialize_project_registry', {});
  const failed = f.store.rows("SELECT stage,error FROM migration_items WHERE source_identity=? AND source_key='projects.json'", [identity])[0];
  assert.deepEqual([failed.stage, failed.error], ['conflict', 'original_late_registry_marker']);
  f.store.db.run('DROP TRIGGER temp.reject_late_registry_import');
  write({ ...project, name: '旧文件中的其它名称' });
  const conflict = await f.call('initialize_project_registry', {});
  assert.equal(conflict.registry.projects[0].name, project.name);
  assert.equal(f.store.migrationSourceState(identity, 'projects.json').stage, 'conflict');
  const captured = f.store.readMigrationSource(identity, 'projects.json');
  assert.equal(captured.bytes.equals(fs.readFileSync(filename)), true);
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
  const notes = '保留首次登记之前的备注🌿\n'.repeat(9000);
  await f.call('initialize_project_registry', { legacyProjects: [{ name: '已登记的新项目', path: next, notes }] });
  f.store.readProjectRegistry = () => { throw new Error('writer_read_legacy_registration_registry'); };
  f.store.syncProjectRegistryMetadata = () => { throw new Error('writer_sync_legacy_registration_metadata'); };
  const registered = await f.call('register_project', { root: next });
  const read = await f.call('read', { ref: registered.projectId });
  assert.equal(read.data.name, '已登记的新项目'); assert.ok(Buffer.from(read.data.notes_content).equals(Buffer.from(notes)));
  const wal = fs.readFileSync(path.join(f.root, 'solomap.db-wal'));
  await f.call('register_project', { root: next });
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'solomap.db-wal')), wal, 'unchanged registration must not append metadata revisions');
});

test('first registration resumes prepared metadata after the owner restarts', async t => {
  const f = await fixture(t), next = path.join(f.base, 'pending-project'); fs.mkdirSync(next);
  const notes = '登记失败后仍应补齐的完整备注🌿'.repeat(5500);
  await f.call('initialize_project_registry', { legacyProjects: [{ name: '等待补齐的新项目', path: next, notes }] });
  const original = f.store.projectMigrationInspectionCompute;
  f.store.projectMigrationInspectionCompute = request => {
    if (request.kind === 'firstRegistrationMetadata') throw new Error('registration_compute_interrupted');
    return original(request);
  };
  await assert.rejects(f.raw('register_project', { root: next }), /registration_compute_interrupted/);
  const projectId = f.store.lookupProjectForRead(next);
  assert.ok(projectId);
  await f.restart();
  const registered = await f.call('register_project', { root: next });
  assert.equal(registered.projectId, projectId);
  const read = await f.call('read', { ref: projectId });
  assert.equal(read.data.name, '等待补齐的新项目');
  assert.ok(Buffer.from(read.data.notes_content || '').equals(Buffer.from(notes)));
});

test('first registration recovery uses the physical entry after its unbound alias moves', async t => {
  const f = await fixture(t), next = path.join(f.base, 'pending-target'), alias = path.join(f.base, 'pending-alias');
  fs.mkdirSync(next); fs.symlinkSync(next, alias, 'dir');
  await f.call('initialize_project_registry', { legacyProjects: [
    { name: '别名的展示名称', path: alias, notes: '别名备注' },
    { name: '真实目录名称', path: next, notes: '真实目录备注' }
  ] });
  const original = f.store.projectMigrationInspectionCompute;
  f.store.projectMigrationInspectionCompute = request => {
    if (request.kind === 'firstRegistrationMetadata') throw new Error('registration_compute_interrupted');
    return original(request);
  };
  await assert.rejects(f.raw('register_project', { root: alias }), /registration_compute_interrupted/);
  fs.renameSync(alias, path.join(f.base, 'alias-isolation')); fs.symlinkSync(f.project, alias, 'dir');
  f.store.projectMigrationInspectionCompute = original;
  const registration = await f.call('register_project', { root: next });
  const read = await f.call('read', { ref: registration.projectId });
  assert.equal(read.data.name, '真实目录名称');
  assert.equal(read.data.notes_content, '真实目录备注');
});

test('first registration preserves an alias update accepted while metadata is prepared', async t => {
  const f = await fixture(t), next = path.join(f.base, 'alias-edit-target'), alias = path.join(f.base, 'alias-edit');
  fs.mkdirSync(next); fs.symlinkSync(next, alias, 'dir');
  const initial = await f.call('initialize_project_registry', { legacyProjects: [
    { name: '真实目录名称', path: next, notes: '真实目录旧备注' },
    { name: '别名的展示名称', path: alias, notes: '别名旧备注' }
  ] });
  const original = f.store.projectMigrationInspectionCompute;
  let changed = false;
  f.store.projectMigrationInspectionCompute = async request => {
    const result = await original(request);
    if (request.kind === 'firstRegistrationMetadata' && !changed) {
      changed = true;
      await f.raw('patch_project_registry', { expectedRevision: initial.revision, projectPatches: [{ path: alias, fields: { notes: '新接受的别名备注' } }], idempotencyKey: 'registered-alias-during-prepare' });
    }
    return result;
  };
  const registration = await f.call('register_project', { root: next });
  assert.ok(changed);
  const read = await f.call('read', { ref: registration.projectId });
  assert.equal(read.data.name, '别名的展示名称');
  assert.equal(read.data.notes_content, '新接受的别名备注');
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
  assert.ok(fs.readFileSync(path.join(f.root, 'solomap.db-wal')).equals(wal), 'a rejected patch leaves the WAL byte-for-byte unchanged');
});

test('re-registering two directory aliases preserves the last accepted metadata and does not rewrite the WAL', async t => {
  const f = await fixture(t), alias = path.join(f.base, 'same-project-alias'); fs.symlinkSync(f.project, alias, 'dir');
  const own = await f.call('register_project', { root: f.project });
  const initial = await f.call('initialize_project_registry', { legacyProjects: [{ name: '物理目录名称', path: f.project, notes: '物理目录备注' }, { name: '别名展示名称', path: alias, notes: '别名原备注' }] });
  const previous = await f.call('read', { ref: own.projectId });
  const updated = await f.call('patch_project_registry', { expectedRevision: initial.revision, projectPatches: [
    { path: f.project, fields: { notes: '批次中物理目录接受的备注' } },
    { path: alias, fields: { notes: '最后接受的完整备注🌿' } }
  ], idempotencyKey: 'last-alias-metadata' });
  const before = await f.call('read', { ref: own.projectId }), wal = fs.readFileSync(path.join(f.root, 'solomap.db-wal'));
  assert.equal(before.revision, previous.revision + 2);
  assert.equal((await f.call('read', { ref: own.projectId, revision: previous.revision + 1 })).data.notes_content, '批次中物理目录接受的备注');
  assert.equal(before.data.notes_content, '最后接受的完整备注🌿');
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

test('project location changes invalidate the durable sidebar projection source revision', async t => {
  const f = await fixture(t);
  const registered = await f.call('register_project', { root: f.project });
  const before = Number(f.store.rows('SELECT source_revision FROM sidebar_core_projection_state WHERE project_id=?', [registered.projectId])[0].source_revision);
  const moved = path.join(f.base, 'moved-project');
  f.store.db.run("UPDATE project_locations SET root_path=? WHERE project_id=? AND root_path=? AND status='active'", [moved, registered.projectId, f.project]);
  const after = Number(f.store.rows('SELECT source_revision FROM sidebar_core_projection_state WHERE project_id=?', [registered.projectId])[0].source_revision);
  assert.equal(after, before + 1);
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

test('registry bootstrap publishes the original file and registry setting without the old synchronous import kernel', async t => {
  const f = await fixture(t);
  const notes = '完整项目历史备注🌿'.repeat(7000);
  const projects = [{name: '正式项目', path: f.project, notes}];
  const file = path.join(f.root, 'projects.json');
  const bytes = Buffer.from(JSON.stringify({projects}));
  fs.writeFileSync(file, bytes);
  f.store.importObjectInternal = () => { throw new Error('registry_used_legacy_import_kernel'); };
  const write = f.store.write.bind(f.store);
  f.store.write = (input,...rest) => {
    if(input.kind==='project' && input.idempotencyKey.startsWith('project-registry-metadata:'))throw new Error('registry_bootstrap_metadata_used_legacy_write');
    return write(input,...rest);
  };
  const snapshot = await f.raw('initialize_project_registry', {});
  assert.deepEqual(snapshot.registry.projects, projects);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(f.store.readMigrationSource(`project-registry:${f.root}`, 'projects.json').bytes, bytes);
  const projectId = f.store.lookupProjectForRead(f.project);
  assert.equal(f.store.read(projectId).data.notes_content, notes);
});

test('registry bootstrap keeps the native project error ahead of a later context capture failure', async t => {
  const f = await fixture(t), file = path.join(f.root,'projects.json');
  const bytes = Buffer.from(JSON.stringify({projects:[{name:'错误置顶的项目',path:f.project,pinnedAt:'not-a-date'}]}));
  fs.writeFileSync(file,bytes);
  const stage = f.store.stageContentPublication.bind(f.store);
  let altered = false;
  f.store.stageContentPublication = async (request,key,...rest) => {
    const binding = await stage(request,key,...rest);
    if (key.startsWith('registry-context:') && key.endsWith(':source')) {
      altered = true;
      f.store.db.run('UPDATE contents SET data=zeroblob(length(data)) WHERE id=?',[binding.contentId]);
    }
    return binding;
  };
  await assert.rejects(f.raw('initialize_project_registry',{legacyProjects:[]}),/project_registry_pin_invalid/);
  assert.equal(altered,true);
  assert.equal(await f.call('read_project_registry'),null);
  const captured = f.store.readMigrationSource(`project-registry:${f.root}`, 'projects.json');
  assert.deepEqual(captured.bytes,bytes);
  assert.equal(captured.stage,'captured');
});

test('registry context retains the actual fixed nested patch revision without a Writer body read', async t => {
  const f = await fixture(t), first = await f.call('initialize_project_registry',{});
  const hints = {legacyProjects:[{name:'历史接受名称',path:f.project,notes:'历史接受的完整备注'}]};
  const {canonicalJson} = require('../out/contentReferences.js');
  const {projectRegistryContextIntent} = require('../out/projectMigrationInspection.js');
  const hash = require('node:crypto').createHash('sha256').update(canonicalJson(hints)).digest('hex');
  const accepted = await f.call('patch_project_registry',projectRegistryContextIntent(hints,first,false,hash));
  const latest = await f.call('patch_project_registry',{expectedRevision:accepted.revision,projectPatches:[{path:f.project,remove:true}],idempotencyKey:'move-past-accepted-context-patch'});
  const read = f.store.read.bind(f.store), stage = f.store.stageContentPublication.bind(f.store);
  f.store.read = (id,revision,...rest) => {
    if(id===accepted.objectId && revision===accepted.revision)throw new Error('writer_read_nested_registry_replay');
    return read(id,revision,...rest);
  };
  f.store.stageContentPublication = (request,key,...rest) => {
    if(key===`registry-context:${hash}:registry`)throw new Error('staged_unused_registry_replay_body');
    return stage(request,key,...rest);
  };
  assert.deepEqual(await f.call('initialize_project_registry',hints),{...latest,legacyContextImported:true});
  const marker = f.store.rows('SELECT object_id,imported_revision,stage FROM migration_items WHERE source_identity=? AND source_key=?',[`project-registry:${f.root}`,'vscode-project-state'])[0];
  assert.equal(marker.object_id,accepted.objectId);
  assert.equal(marker.imported_revision,accepted.revision);
  assert.equal(marker.stage,'imported');
});

test('registry context source capture SQL wins over a later fixed patch conflict', async t => {
  const f=await fixture(t), first=await f.call('initialize_project_registry',{});
  const hints={legacyProjects:[{name:'旧名称',path:f.project}]};
  const hash=require('node:crypto').createHash('sha256').update(require('../out/contentReferences.js').canonicalJson(hints)).digest('hex');
  const latest=await f.call('patch_project_registry',{expectedRevision:first.revision,selectedProjectPath:'',idempotencyKey:`project-registry-context:${hash}`});
  f.store.db.run(`CREATE TEMP TRIGGER reject_legacy_context_capture BEFORE INSERT ON migration_items
    WHEN NEW.source_key='vscode-project-state' BEGIN SELECT RAISE(ABORT,'actual_context_capture_insert'); END`);
  await assert.rejects(f.raw('initialize_project_registry',hints),/actual_context_capture_insert/);
  assert.deepEqual(await f.call('read_project_registry'),latest);
});

test('runtime prepares the complete registry patch and leaves display metadata atomic', async t => {
  const f=await fixture(t);
  const first=await f.call('initialize_project_registry',{legacyProjects:[{name:'原项目名',path:f.project}]});
  const notes='完整注册表备注🌿'.repeat(7000);
  const encode=f.store.putStructuredContent, write=f.store.write;
  f.store.putStructuredContent=function(value,...rest){
    if(value?.projects?.some(project=>project.notes===notes))throw new Error('registry_patch_encoded_on_source');
    return encode.call(this,value,...rest);
  };
  f.store.write=function(input,...rest){
    if(input.kind==='project' && input.idempotencyKey.startsWith('project-registry-metadata:'))throw new Error('registry_project_metadata_used_legacy_write');
    return write.call(this,input,...rest);
  };
  const input={expectedRevision:first.revision,projectPatches:[{path:f.project,fields:{name:'新项目名',notes}}],idempotencyKey:'prepared-registry-patch'};
  const result=await f.raw('patch_project_registry',input);
  assert.equal(result.registry.projects[0].notes,notes);
  assert.equal(f.store.read(f.store.lookupProjectForRead(f.project)).data.notes_content,notes);
  assert.deepEqual(await f.raw('patch_project_registry',input),result);
});

for(const target of ['project','registry'])test(`registry patch rolls back when its prepared ${target} body fails`, async t => {
  const f = await fixture(t), first = await f.call('initialize_project_registry',{legacyProjects:[{name:'原名称',path:f.project,notes:'原备注'}]});
  const projectId = f.store.lookupProjectForRead(f.project), before = await f.call('read',{ref:projectId});
  const input = {expectedRevision:first.revision,projectPatches:[{path:f.project,fields:{notes:'完整新备注🌿'.repeat(300)}}],idempotencyKey:`registry-prepared-failure-${target}`};
  const search = f.store.dataWriteCompute.search, stage = f.store.stageContentPublication.bind(f.store);
  if (target === 'project') {
    f.store.dataWriteCompute.search = request => {
      if (request.input.kind === 'project') throw new Error('actual_registry_project_search_failure');
      return search(request);
    };
  } else {
    f.store.stageContentPublication = async (request,key,...rest) => {
      const binding = await stage(request,key,...rest);
      if (key === `registry-patch:${input.idempotencyKey}`) f.store.db.run('UPDATE contents SET data=zeroblob(length(data)) WHERE id=?',[binding.contentId]);
      return binding;
    };
  }
  await assert.rejects(f.raw('patch_project_registry',input),target === 'project'?/actual_registry_project_search_failure/:/content_integrity_error/);
  assert.deepEqual(await f.call('read_project_registry'),first);
  assert.deepEqual(await f.call('read',{ref:projectId}),before);
  f.store.dataWriteCompute.search = search;
  f.store.stageContentPublication = stage;
  const accepted = await f.call('patch_project_registry',input);
  assert.equal(accepted.revision,first.revision+1);
  assert.equal((await f.call('read',{ref:projectId})).data.notes_content,input.projectPatches[0].fields.notes);
});

test('a prepared registry patch reselects a later alias retargeted during the first project write', async t => {
  const f = await fixture(t), olderRoot = path.join(f.base,'first-target'), newerRoot = path.join(f.base,'second-target');
  fs.mkdirSync(olderRoot); fs.mkdirSync(newerRoot);
  const older = await f.call('register_project',{root:olderRoot}), newer = await f.call('register_project',{root:newerRoot});
  const first = await f.call('initialize_project_registry',{legacyProjects:[
    {name:'第一个项目',path:f.project}, {name:'改指前的项目',path:olderRoot}, {name:'改指后的项目',path:newerRoot}
  ]});
  const firstProjectId = f.store.lookupProjectForRead(f.project);
  const alias = path.join(f.base,'new-alias'); fs.symlinkSync(olderRoot,alias,'dir');
  const run = f.store.db.run.bind(f.store.db);
  let retargeted = false;
  f.store.db.run = (sql,args,...rest) => {
    const result = run(sql,args,...rest);
    if (!retargeted && sql.startsWith('UPDATE projects SET ') && args?.at(-1)===firstProjectId) {
      retargeted = true;
      fs.renameSync(alias,path.join(f.base,'old-alias-isolation'));
      fs.symlinkSync(newerRoot,alias,'dir');
    }
    return result;
  };
  const accepted = await f.call('patch_project_registry',{expectedRevision:first.revision,projectPatches:[
    {path:f.project,fields:{name:'本次写入先更新的项目'}},
    {path:alias,fields:{name:'别名目标名称',notes:'只属于改指后项目的备注'}}
  ],idempotencyKey:'registry-physical-retarget-after-first-write'});
  assert.ok(retargeted);
  assert.equal(accepted.revision,first.revision+1);
  assert.equal((await f.call('read',{ref:older.projectId})).data.name,'改指前的项目');
  assert.equal((await f.call('read',{ref:newer.projectId})).data.notes_content,'只属于改指后项目的备注');
  assert.equal(f.store.lookupProjectForRead(alias),newer.projectId);
});

test('registry patch rejects a blank idempotency key before writing preparation pages', async t => {
  const f=await fixture(t);
  const current=await f.call('initialize_project_registry',{legacyProjects:[{name:'项目',path:f.project}]});
  const file=path.join(f.root,'solomap.db-wal'),before=fs.readFileSync(file);
  await assert.rejects(f.raw('patch_project_registry',{expectedRevision:current.revision,idempotencyKey:' \t ',projectPatches:[{path:f.project,fields:{notes:'保留原状态'}}]}),/idempotency_key_required/);
  assert.ok(fs.readFileSync(file).equals(before),'the invalid patch must not create preparation pages');
});
