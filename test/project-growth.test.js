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
    "import * as Papa from 'papaparse';",
    "import { loadProject } from './db/store';",
    'export function activate() {',
    '  Papa.parse("a,b");',
    '  return loadProject();',
    '}'
  ].join('\n'));
  writeFile(path.join(tempRoot, 'test', 'store.test.js'), [
    "const assert = require('node:assert/strict');",
    "const { loadProject } = require('../src/db/store');",
    "assert.equal(loadProject().ok, true);",
    "assert.equal(1, 1);"
  ].join('\n'));
  writeFile(path.join(tempRoot, 'docs', 'methodology.md'), '# Methodology\n');

  const { SqliteStore } = require(path.join(projectRoot, 'out', 'db', 'sqliteStore.js'));
  const {
    buildProjectGrowthViewModel,
    getProjectGrowthView,
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
  assert.equal(view.totals.packages, 1);
  assert.ok(view.treemap);
  assert.equal(view.treemap.label, 'Project');
  assert.ok(view.modules.some((module) => module.nodeId === 'module:data-layer'));
  assert.ok(view.capabilities.some((capability) => capability.nodeId === 'capability:roadmap:roadmap-data'));
  assert.ok(view.keyEdges.some((edge) => edge.kind === 'depends_on' && edge.targetId === 'package:papaparse'));
  assert.ok(view.keyEdges.some((edge) => edge.kind === 'tested_by'));
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
  assert.ok(latest.edges.some((edge) => (
    edge.kind === 'tested_by'
    && edge.sourceId === 'file:src/db/store.ts'
    && edge.targetId === 'file:test/store.test.js'
  )));
  assert.ok(latest.edges.some((edge) => (
    edge.kind === 'depends_on'
    && edge.sourceId === 'file:src/extension.ts'
    && edge.targetId === 'package:papaparse'
  )));
  assert.ok(latest.edges.some((edge) => edge.kind === 'implements' && edge.targetId === 'capability:roadmap:roadmap-data'));
  assert.ok(latest.signals.some((signal) => signal.type === 'failure' && signal.level === 'attention'));

  const persistedView = buildProjectGrowthViewModel(latest);
  assert.equal(persistedView.totals.capabilities, 1);
  assert.ok(persistedView.gaps.length > 0);

  writeFile(path.join(tempRoot, 'src', 'db', 'cache.ts'), [
    'export const cacheReady = true;'
  ].join('\n'));
  const secondView = await refreshProjectGrowthSnapshot(tempRoot, projectRoot, {
    scanReason: 'test-second',
    now: new Date('2026-01-04T00:00:00.000Z')
  });
  assert.equal(secondView.totals.files, 5);
  assert.ok(secondView.diff);
  assert.equal(secondView.diff.filesAdded, 1);
  assert.equal(secondView.diff.filesRemoved, 0);
  assert.equal(secondView.history.length, 2);
  assert.equal(secondView.history[0].snapshotId, secondView.snapshotId);

  const queriedView = await getProjectGrowthView(tempRoot, projectRoot, {
    refreshIfMissing: false,
    historyLimit: 5
  });
  assert.equal(queriedView.snapshotId, secondView.snapshotId);
  assert.ok(queriedView.diff);
  assert.equal(queriedView.diff.filesAdded, 1);
  assert.equal(queriedView.history.length, 2);
});

test('project growth webview uses locale labels for roadmap and history metadata', () => {
  const { getProjectGrowthWebviewHtml } = require(path.join(projectRoot, 'out', 'projectGrowthWebview.js'));
  const fakeWebview = {
    asWebviewUri(uri) {
      return uri;
    }
  };
  const fakeContext = {
    extensionUri: { fsPath: projectRoot, path: projectRoot },
    extensionPath: projectRoot
  };
  const viewModel = {
    snapshotId: 'growth-test',
    generatedAt: '2026-01-03T00:00:00.000Z',
    treemap: null,
    gaps: [{
      nodeId: 'module:data-layer',
      label: '数据层',
      level: 'watch',
      value: '最近被 Agent 触碰，但缺少验证信号',
      source: 'run_index'
    }],
    modules: [],
    capabilities: [{
      nodeId: 'capability:roadmap:roadmap-data',
      label: '补强项目数据链路',
      stage: '交付与验证',
      modules: ['module:data-layer'],
      signal: 'watch'
    }],
    keyEdges: [],
    history: [{
      snapshotId: 'growth-test',
      createdAt: '2026-01-03T00:00:00.000Z',
      scanReason: 'test',
      gitHead: 'abc123',
      totals: { files: 4, modules: 3, capabilities: 1, packages: 1, loc: 42, signals: 1 }
    }],
    diff: null,
    totals: { files: 4, modules: 3, capabilities: 1, packages: 1, loc: 42, signals: 1 }
  };

  const zhHtml = getProjectGrowthWebviewHtml(fakeWebview, fakeContext, viewModel, 'Demo', true);
  assert.match(zhHtml, /来源: run_index/);
  assert.match(zhHtml, /阶段: 交付与验证/);
  assert.match(zhHtml, /文件: <strong>4<\/strong>/);
  assert.doesNotMatch(zhHtml, /Source: run_index/);
  assert.doesNotMatch(zhHtml, /Stage: 交付与验证/);
  assert.doesNotMatch(zhHtml, /Files: <strong>4<\/strong>/);

  const enHtml = getProjectGrowthWebviewHtml(fakeWebview, fakeContext, viewModel, 'Demo', false);
  assert.match(enHtml, /Source: run_index/);
  assert.match(enHtml, /Stage: 交付与验证/);
  assert.match(enHtml, /Files: <strong>4<\/strong>/);
});
