const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildStrategyPyramidSnapshotData,
  readCachedStrategyPyramidSnapshot
} = require('../out/strategyPyramid.js');

test('strategy pyramid reuses its local snapshot until a project source changes', () => {
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

  try {
    const generated = buildStrategyPyramidSnapshotData(projects, globalDataPath, projectPath);
    const cached = readCachedStrategyPyramidSnapshot(projects, globalDataPath);
    assert.equal(cached.generatedAt, generated.generatedAt);
    assert.equal(cached.projects[0].path, projectPath);

    fs.appendFileSync(path.join(solopreneurPath, 'roadmap.csv'), '2,Verify demand,Learn,Pending\n');
    assert.equal(readCachedStrategyPyramidSnapshot(projects, globalDataPath), null);
  } finally {
    for (const filePath of [
      path.join(strategyPath, 'pyramid-snapshot-meta.json'),
      path.join(strategyPath, 'pyramid-snapshot.json'),
      path.join(strategyPath, 'project-strategy.csv'),
      path.join(strategyPath, 'ability-registry.csv'),
      path.join(solopreneurPath, 'roadmap.csv')
    ]) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    const learningPath = path.join(globalDataPath, 'learning');
    for (const filePath of [
      path.join(learningPath, 'ledger', 'events.jsonl'),
      path.join(learningPath, 'ledger', 'index.json')
    ]) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    for (const directoryPath of [
      path.join(learningPath, 'ledger', 'sources'),
      path.join(learningPath, 'ledger'),
      path.join(learningPath, 'approved'),
      path.join(learningPath, 'candidate-decisions'),
      path.join(learningPath, 'candidates'),
      path.join(learningPath, 'promotion-suggestions'),
      path.join(learningPath, 'rejected'),
      learningPath
    ]) {
      if (fs.existsSync(directoryPath)) fs.rmdirSync(directoryPath);
    }
    if (fs.existsSync(strategyPath)) fs.rmdirSync(strategyPath);
    if (fs.existsSync(globalDataPath)) fs.rmdirSync(globalDataPath);
    fs.rmdirSync(solopreneurPath);
    fs.rmdirSync(projectPath);
    fs.rmdirSync(root);
  }
});
