const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function createRoadmapNode(id, title) {
  return {
    id,
    title,
    description: `${title} description`,
    stage: '交付与验证',
    dependencies: '',
    agentCli: 'codex',
    agentPrompt: 'Implement and verify this capability.',
    status: 'In Progress',
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: ''
  };
}

test('project growth snapshot closes filesystem, run index, roadmap, and query model', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-growth-'));
  const solopreneurDir = path.join(tempRoot, '.solopreneur');
  fs.mkdirSync(solopreneurDir, { recursive: true });

  writeFile(path.join(tempRoot, 'src', 'db', 'store.ts'), [
    'export function loadProject() {',
    '  return { ok: true };',
    '}'
  ].join('\n'));
  writeFile(path.join(tempRoot, 'src', 'extension.ts'), [
    "import { loadProject } from './db/store';",
    'export function activate() {',
    '  return loadProject();',
    '}'
  ].join('\n'));
  writeFile(path.join(tempRoot, 'test', 'store.test.js'), [
    "const assert = require('node:assert/strict');",
    "assert.equal(1, 1);"
  ].join('\n'));
  writeFile(path.join(tempRoot, 'docs', 'methodology.md'), '# Methodology\n');

  const { SqliteStore } = require(path.join(projectRoot, 'out', 'db', 'sqliteStore.js'));
  const {
    buildProjectGrowthViewModel,
    refreshProjectGrowthSnapshot
  } = require(path.join(projectRoot, 'out', 'projectGrowth.js'));

  const dbPath = path.join(solopreneurDir, 'project_journal.db');
  const store = new SqliteStore(dbPath, projectRoot);
  await store.init();
  store.syncNodesFromList([
    createRoadmapNode('roadmap-data', '补强项目数据链路')
  ]);
  store.upsertRunIndex({
    executionLogId: 101,
    nodeId: 'roadmap-data',
    runKind: 'step',
    agentCli: 'codex',
    status: 'Failed',
    startedAt: '2026-01-02T00:00:00.000Z',
    finishedAt: '2026-01-02T00:01:00.000Z',
    durationMs: 60000,
    outputPath: '.solopreneur/agent-runs/101/output.log',
    outputBytes: 128,
    outputTail: 'npm run compile failed',
    commandPath: '',
    promptPath: '',
    changesPath: '',
    touchedFilesPath: '',
    updatedAt: '2026-01-02T00:01:00.000Z'
  }, [
    { filePath: 'src/db/store.ts', role: 'changed' },
    { filePath: 'src/extension.ts', role: 'touched' }
  ], [
    { type: 'failure', value: 'compile failed' }
  ]);
  store.close();

  const view = await refreshProjectGrowthSnapshot(tempRoot, projectRoot, {
    scanReason: 'test',
    now: new Date('2026-01-03T00:00:00.000Z')
  });

  assert.equal(view.totals.files, 4);
  assert.ok(view.totals.modules >= 3);
  assert.equal(view.totals.capabilities, 1);
  assert.ok(view.treemap);
  assert.equal(view.treemap.label, 'Project');
  assert.ok(view.gaps.some((gap) => gap.source === 'run_index' || gap.source === 'growth_rules'));

  const reopened = new SqliteStore(dbPath, projectRoot);
  await reopened.init();
  const latest = reopened.getLatestGrowthSnapshot();
  reopened.close();

  assert.ok(latest);
  assert.equal(latest.snapshot.scanReason, 'test');
  assert.ok(latest.nodes.some((node) => node.nodeId === 'module:data-layer' && node.label === '数据层'));
  assert.ok(latest.nodes.some((node) => node.nodeId === 'capability:roadmap:roadmap-data'));
  assert.ok(latest.edges.some((edge) => (
    edge.kind === 'imports'
    && edge.sourceId === 'file:src/extension.ts'
    && edge.targetId === 'file:src/db/store.ts'
  )));
  assert.ok(latest.edges.some((edge) => edge.kind === 'implements' && edge.targetId === 'capability:roadmap:roadmap-data'));
  assert.ok(latest.signals.some((signal) => signal.type === 'failure' && signal.level === 'attention'));

  const persistedView = buildProjectGrowthViewModel(latest);
  assert.equal(persistedView.totals.capabilities, 1);
  assert.ok(persistedView.gaps.length > 0);
});
