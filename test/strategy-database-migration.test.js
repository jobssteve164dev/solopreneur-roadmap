const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');

async function fixture(action) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-strategy-import-'));
  const root = path.join(base, '.solomap-global'); const workspace = path.join(base, 'project'); fs.mkdirSync(workspace);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'strategy-import-owner', onCommand: () => ({ status: 'running' }), onData: ops });
  const project = (await ops({ operation: 'register_project', input: { root: workspace } })).projectId;
  const sourceRoot = path.join(root, 'strategy'); fs.mkdirSync(sourceRoot);
  const originals = new Map([
    ['project-strategy.csv', Buffer.from(`projectPath,role,businessStage,revenueTier,timeLoad,strategicAction,abilities,updatedAt,custom\n${workspace},frozen,sunset,unknown,low,reduce,cli-tools,2026-01-01T00:00:00Z,保留未知字段\n`)],
    ['ability-registry.csv', Buffer.from('abilityId,name,category,marketRelevance,notes,updatedAt\ncli-tools,工具,technical,high,完整原文,2026-01-01T00:00:00Z\n')],
    ['pyramid-snapshot.json', Buffer.from(JSON.stringify({ generatedAt: '2026-01-01T00:00:00Z', mainJudgment: '保留历史模型判断', projects: [{ path: workspace, role: '冻结项目' }], custom: { original: '完整原文' } }))],
    ['pyramid-snapshot-meta.json', Buffer.from(JSON.stringify({ version: 1, signature: 'old-file-source-signature', engineConfigRevision: 'old-model' }))]
  ]);
  for (const [key, bytes] of originals) fs.writeFileSync(path.join(sourceRoot, key), bytes);
  const run = async (key, scopes = { [workspace]: project }) => {
    const job = await ops({ operation: 'import_project_data', input: { collection: 'strategy', sourceRoot, projectScopes: scopes, idempotencyKey: key } });
    await ops.waitForMigrations(); return store.readMigrationJob(job.jobId);
  };
  try { await action({ root, workspace, project, store, ops, sourceRoot, originals, run }); }
  finally { await server.close(); await ops.close(); store.close(); }
}

test('strategy history imports full original files and user choices then replays without new versions', () => fixture(async ({ project, store, sourceRoot, originals, run }) => {
  const first = await run('strategy-history-first'); assert.equal(first.status, 'completed');
  const preferences = store.readStrategyState(project);
  assert.equal(preferences.value.role, 'frozen'); assert.equal(preferences.value.custom, '保留未知字段');
  const cache = store.readStrategyState(null);
  assert.equal(cache.value.snapshot.mainJudgment, '保留历史模型判断');
  assert.deepEqual(cache.value.snapshot.custom, { original: '完整原文' });
  for (const [key, bytes] of originals) {
    assert.deepEqual(store.readMigrationSource(`strategy:${sourceRoot}`, key).bytes, bytes);
    assert.deepEqual(fs.readFileSync(path.join(sourceRoot, key)), bytes);
  }
  const revisions = store.rows("SELECT id,revision FROM objects WHERE kind='setting' ORDER BY id");
  const second = await run('strategy-history-replay'); assert.equal(second.status, 'completed');
  assert.equal(second.progress.imported, 0);
  assert.deepEqual(store.rows("SELECT id,revision FROM objects WHERE kind='setting' ORDER BY id"), revisions);
}));

test('strategy history cannot replace a later native user choice and retains the conflicting source', () => fixture(async ({ project, store, sourceRoot, run }) => {
  store.writeStrategyState(project, { expectedRevision: 0, value: { role: 'core_product', businessStage: 'sell' }, idempotencyKey: 'user-first' });
  const job = await run('strategy-existing-choice');
  assert.equal(job.status, 'completed_with_conflicts');
  assert.equal(store.readStrategyState(project).value.role, 'core_product');
  assert.ok(job.progress.conflicts.some(conflict => /newer_database_revision|existing_database_choice/.test(conflict.error)));
  assert.ok(store.readMigrationSource(`strategy:${sourceRoot}`, 'project-strategy.csv').bytes.length > 0);
}));

test('strategy source without an exact project mapping remains captured without a guessed private scope', () => fixture(async ({ store, sourceRoot, originals, run }) => {
  const job = await run('strategy-no-scope', {});
  assert.equal(job.status, 'completed_with_conflicts');
  assert.ok(job.progress.conflicts.some(conflict => /project_mapping_required/.test(conflict.error)));
  const record = store.readMigrationSource(`strategy:${sourceRoot}`, 'project-strategy.csv');
  assert.equal(crypto.createHash('sha256').update(record.bytes).digest('hex'), crypto.createHash('sha256').update(originals.get('project-strategy.csv')).digest('hex'));
  assert.equal(store.rows("SELECT count(*) AS n FROM settings WHERE namespace='strategy' AND key='preferences'")[0].n, 0);
}));

test('normal discovery schedules strategy history using database project identities', () => fixture(async ({ store, ops, project }) => {
  const { enqueueAvailableDataMigrations } = require('../out/runtimeDatabaseBootstrap.js');
  await enqueueAvailableDataMigrations(store, ops, () => true);
  await ops.waitForMigrations();
  assert.equal(store.readStrategyState(project).value.role, 'frozen');
  const jobs = store.migrationJobCount();
  const revisions = store.rows("SELECT id,revision FROM objects WHERE kind='setting' ORDER BY id");
  await enqueueAvailableDataMigrations(store, ops, () => true);
  await ops.waitForMigrations();
  assert.equal(store.migrationJobCount(), jobs);
  assert.deepEqual(store.rows("SELECT id,revision FROM objects WHERE kind='setting' ORDER BY id"), revisions);
}));

test('an offline registered project does not prevent importing an available project or global history', () => fixture(async ({ store, ops, sourceRoot, project, workspace }) => {
  const { enqueueAvailableDataMigrations } = require('../out/runtimeDatabaseBootstrap.js');
  const offline = path.join(path.dirname(workspace), 'offline-project'); fs.mkdirSync(offline);
  const other = await store.registerProject({ root: offline });
  fs.appendFileSync(path.join(sourceRoot, 'project-strategy.csv'), `${offline},frozen,sunset,unknown,low,reduce,cli-tools,2026-01-01T00:00:00Z,离线原文\n`);
  fs.renameSync(offline, offline + '-retained');
  await enqueueAvailableDataMigrations(store, ops, () => true); await ops.waitForMigrations();
  const jobs = store.migrationJobs().filter(job => job.args.collection === 'strategy');
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'completed_with_conflicts');
  assert.equal(store.readStrategyState(project).value.role, 'frozen');
  assert.equal(store.readStrategyState(null).value.snapshot.mainJudgment, '保留历史模型判断');
  assert.equal(store.readStrategyState(other.projectId).objectId, null);
  assert.ok(jobs[0].progress.conflicts.some(conflict => /project_mapping_required/.test(conflict.error)));
  assert.equal(store.readMigrationSource(`strategy:${sourceRoot}`, 'project-strategy.csv').bytes.toString(), fs.readFileSync(path.join(sourceRoot, 'project-strategy.csv'), 'utf8'));
}));
