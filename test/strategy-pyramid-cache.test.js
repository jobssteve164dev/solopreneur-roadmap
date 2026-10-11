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
