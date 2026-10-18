const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openAnalysisOwner } = require('./analysis-fixture.js');

const {
  buildStrategyPyramidSnapshotData,
  readCachedStrategyPyramidSnapshot
} = require('../out/strategyPyramid.js');

test('strategy pyramid reuses its committed snapshot until a project source changes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-strategy-cache-'));
  const projectPath = path.join(root, 'project');
  const solopreneurPath = path.join(projectPath, '.solopreneur');
  const globalDataPath = path.join(root, '.solomap-global');
  const strategyPath = path.join(globalDataPath, 'strategy');
  fs.mkdirSync(solopreneurPath, { recursive: true });
  fs.writeFileSync(
    path.join(solopreneurPath, 'roadmap.csv'),
    'id,title,stage,status\n1,Ship a useful result,Build,Pending\n',
    'utf8'
  );
  const projects = [{ name: 'Project', path: projectPath, type: 'core_product' }];
  const { store, projectIds } = await openAnalysisOwner(t, globalDataPath, projects);

    const generated = await buildStrategyPyramidSnapshotData(projects, globalDataPath, projectPath);
    const cached = await readCachedStrategyPyramidSnapshot(projects, globalDataPath);
    assert.equal(cached.generatedAt, generated.generatedAt);
    assert.equal(cached.projects[0].path, projectPath);

    fs.appendFileSync(path.join(solopreneurPath, 'roadmap.csv'), '2,Verify demand,Learn,Pending\n');
    assert.equal(await readCachedStrategyPyramidSnapshot(projects, globalDataPath), null);

    const regenerated = await buildStrategyPyramidSnapshotData(projects, globalDataPath, projectPath);
    assert.equal((await readCachedStrategyPyramidSnapshot(projects, globalDataPath)).generatedAt, regenerated.generatedAt);
    const scope = projectIds.get(projectPath);
    const evidence = store.write({ kind: 'evidence', action: 'create', scope, idempotencyKey: 'cache-test-evidence', data: { type: 'host_observation', source_actor_id: 'local-runtime', content: 'Verification passed', observed_at: Date.now() } });
    store.write({ kind: 'learning_event', action: 'create', scope, idempotencyKey: 'cache-test-event', data: { source_object_id: evidence.objectId, source_revision: 1, event_type: 'verified', source_type: 'solo', summary: 'Verification passed', occurred_at: Date.now() } });
    assert.equal(await readCachedStrategyPyramidSnapshot(projects, globalDataPath), null);
    assert.equal(fs.existsSync(strategyPath), false);
});

test('strategy pyramid keeps offline projects and their saved facts without recreating their directories', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-strategy-offline-'));
  const project = path.join(base, 'project'), offline = path.join(base, 'offline');
  const root = path.join(base, '.solomap-global');
  fs.mkdirSync(project); fs.mkdirSync(offline);
  const projects = [{ name: 'Current', path: project }, { name: 'Offline', path: offline }, { name: 'Legacy', path: path.join(base, 'missing') }];
  const native = await openAnalysisOwner(t, root, projects.slice(0, 2));
  native.store.upsertProjectRunIndex(native.projectIds.get(offline), {
    executionLogId: 1, nodeId: '__solo__', runKind: 'solo', agentCli: 'codex', status: 'Completed',
    startedAt: '2026-10-09T10:00:00Z', finishedAt: '2026-10-09T10:10:00Z', durationMs: 600000,
    outputPath: '', outputBytes: 0, outputTail: '', commandPath: '', promptPath: '', changesPath: '', touchedFilesPath: '', updatedAt: '2026-10-09T10:10:00Z'
  });
  native.store.writeStrategyState(native.projectIds.get(offline), { expectedRevision: 0, idempotencyKey: 'offline-strategy', value: {
    role: 'cashflow', businessStage: 'sell', revenueTier: 'stable', timeLoad: 'low', strategicAction: 'maintain', abilities: 'CLI'
  } });
  fs.renameSync(offline, path.join(base, 'disconnected'));
  const snapshot = await buildStrategyPyramidSnapshotData(projects, root, project);
  assert.equal(snapshot.totalProjects, 3);
  assert.equal(snapshot.projects.find(p => p.path === offline).businessStage, 'sell');
  assert.equal(snapshot.projects.find(p => p.path === offline).actualMinutes, 10);
  assert.equal((await readCachedStrategyPyramidSnapshot(projects, root)).generatedAt, snapshot.generatedAt);
  assert.equal(fs.existsSync(offline), false);
  assert.equal(fs.existsSync(projects[2].path), false);
  assert.equal(native.store.registeredProjectScopes().length, 2);
  fs.renameSync(path.join(base, 'disconnected'), offline);
  fs.writeFileSync(path.join(offline, '.solopreneur', 'roadmap.csv'), 'id,title,stage,status\n1,Reach customers,Sell,Pending\n');
  assert.equal(await readCachedStrategyPyramidSnapshot(projects, root), null);
  const restored = await buildStrategyPyramidSnapshotData(projects, root, project);
  assert.equal(restored.projects.find(p => p.path === offline).totalNodes, 1);
  await assert.rejects(native.ops({ operation: 'write_strategy_state', input: { root: projects[2].path, expectedRevision: 0, value: {}, idempotencyKey: 'offline-write' } }), /ENOENT/);
  const invalid = path.join(base, 'not-a-directory'); fs.writeFileSync(invalid, 'fixture');
  await assert.rejects(native.ops({ operation: 'read_strategy_state', input: { root: invalid } }), /project_root_required/);
});
