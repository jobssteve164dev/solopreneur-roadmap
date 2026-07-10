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
  assert.ok(view.insight);
  assert.equal(view.orientation.totalSteps, 1);
  assert.equal(view.orientation.currentStep, '补强项目数据链路');
  assert.equal(view.orientation.currentStepStatus, 'In Progress');
  assert.match(view.insight.headline, /主要生长区域/);
  assert.ok(view.focusAreas.some((area) => area.label === '数据层'));
  assert.ok(view.recommendedActions.length > 0);
  assert.ok(view.modules.some((module) => module.nodeId === 'module:data-layer'));
  assert.ok(view.capabilities.some((capability) => capability.nodeId === 'capability:roadmap:roadmap-data'));
  assert.ok(view.capabilityHealth.some((capability) => capability.nodeId === 'capability:roadmap:roadmap-data'));
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
    projectPath: '/workspace/demo',
    orientation: {
      purpose: '帮助独立开发者把零散 AI 对话变成可推进、可验证的项目路线。',
      currentStage: '交付与验证',
      currentStep: '补强项目数据链路',
      currentStepStatus: 'In Progress',
      completedSteps: 3,
      totalSteps: 5,
      stages: [
        { label: '产品定义', completed: 2, active: 0, pending: 0, total: 2, status: 'completed' },
        { label: '交付与验证', completed: 1, active: 1, pending: 1, total: 3, status: 'active' }
      ]
    },
    insight: {
      headline: '4 个文件沉淀为 1 个主要生长区域',
      body: '补强项目数据链路已经有代码落地，但还需要补验证证据。',
      healthLabel: '1 个优先处理点',
      focusLabel: '数据层 最值得先看',
      evidenceLabel: '1 条生长信号'
    },
    capabilityHealth: [{
      nodeId: 'capability:roadmap:roadmap-data',
      label: '补强项目数据链路',
      stage: '交付与验证',
      status: 'needs_verification',
      summary: '关联 1 个生长区域、2 个文件，还缺少测试证据。',
      action: 'add_verification',
      modules: ['数据层'],
      evidence: ['数据层: 最近被 Agent 触碰，但缺少验证信号'],
      signal: 'watch',
      roadmapStatus: 'In Progress',
      description: '建立稳定的项目数据事实。'
    }],
    focusAreas: [{
      nodeId: 'module:data-layer',
      label: '数据层',
      status: 'needs_verification',
      summary: 'data · 2 个文件 · 24 行 · 0 个测试',
      action: 'add_verification',
      files: 2,
      loc: 24,
      tests: 0,
      confidence: 0.82,
      evidence: ['最近被 Agent 触碰，但缺少验证信号']
    }],
    recommendedActions: [{
      title: '补强项目数据链路：补验证证据',
      detail: '关联 1 个生长区域、2 个文件，还缺少测试证据。',
      target: '交付与验证',
      level: 'needs_verification',
      source: 'roadmap'
    }],
    treemap: null,
    gaps: [{
      nodeId: 'module:data-layer',
      label: '数据层',
      level: 'watch',
      value: '最近被 Agent 触碰，但缺少验证信号',
      source: 'run_index'
    }],
    modules: [{
      id: 'module:data-layer',
      label: '数据层',
      role: 'data',
      signal: 'watch',
      files: 2,
      loc: 24,
      tests: 1,
      confidence: 0.82,
      paths: ['src/data.js']
    }],
    capabilities: [{
      nodeId: 'capability:roadmap:roadmap-data',
      label: '补强项目数据链路',
      stage: '交付与验证',
      modules: ['module:data-layer'],
      signal: 'watch'
    }],
    keyEdges: [{
      sourceId: 'module:data-layer',
      targetId: 'package:papaparse',
      kind: 'depends_on',
      weight: 1
    }],
    history: [{
      snapshotId: 'growth-test',
      createdAt: '2026-01-03T00:00:00.000Z',
      scanReason: 'webview_refresh',
      gitHead: 'abc123',
      totals: { files: 4, modules: 3, capabilities: 1, packages: 1, loc: 42, signals: 1 }
    }],
    diff: null,
    totals: { files: 4, modules: 3, capabilities: 1, packages: 1, loc: 42, signals: 1 }
  };

  const zhHtml = getProjectGrowthWebviewHtml(fakeWebview, fakeContext, viewModel, 'Demo', true);
  assert.match(zhHtml, /<title>SoloMap: 项目生长图<\/title>/);
  assert.match(zhHtml, /当前项目 · Demo · 项目路径: \/workspace\/demo/);
  assert.match(zhHtml, /项目概览/);
  assert.match(zhHtml, /帮助独立开发者把零散 AI 对话变成可推进、可验证的项目路线/);
  assert.match(zhHtml, /3\/5/);
  assert.match(zhHtml, /当前推进 · 交付与验证/);
  assert.match(zhHtml, /接下来最值得做/);
  assert.match(zhHtml, /项目能力全貌/);
  assert.match(zhHtml, /代码生长落点/);
  assert.match(zhHtml, /路线状态/);
  assert.match(zhHtml, /待验证/);
  assert.match(zhHtml, /补验证证据/);
  assert.match(zhHtml, /关注/);
  assert.match(zhHtml, /职责: 数据层/);
  assert.match(zhHtml, /来源: 运行索引/);
  assert.match(zhHtml, /阶段: 交付与验证/);
  assert.match(zhHtml, /文件: <strong>4<\/strong>/);
  assert.match(zhHtml, /快照原因: <strong>图内刷新<\/strong>/);
  assert.match(zhHtml, /依赖/);
  assert.doesNotMatch(zhHtml, /WATCH/);
  assert.doesNotMatch(zhHtml, /run_index/);
  assert.doesNotMatch(zhHtml, /depends_on/);
  assert.doesNotMatch(zhHtml, /webview_refresh/);
  assert.doesNotMatch(zhHtml, /Source: Run Index/);
  assert.doesNotMatch(zhHtml, /Stage: 交付与验证/);
  assert.doesNotMatch(zhHtml, /Files: <strong>4<\/strong>/);

  const enHtml = getProjectGrowthWebviewHtml(fakeWebview, fakeContext, viewModel, 'Demo', false);
  assert.match(enHtml, /<title>SoloMap: Project Growth Graph<\/title>/);
  assert.match(enHtml, /Current Project · Demo · Project Path: \/workspace\/demo/);
  assert.match(enHtml, /Project Overview/);
  assert.match(enHtml, /What this project is for/);
  assert.match(enHtml, /Current work · 交付与验证/);
  assert.match(enHtml, /Most Useful Next Moves/);
  assert.match(enHtml, /Project Capability Map/);
  assert.match(enHtml, /Code Growth Footprint/);
  assert.match(enHtml, /Needs Verification/);
  assert.match(enHtml, /Add verification evidence/);
  assert.match(enHtml, /Watch/);
  assert.match(enHtml, /Role: Data/);
  assert.match(enHtml, /Source: Run Index/);
  assert.match(enHtml, /Stage: 交付与验证/);
  assert.match(enHtml, /Files: <strong>4<\/strong>/);
  assert.match(enHtml, /Reason: <strong>View Refresh<\/strong>/);
  assert.match(enHtml, /Depends On/);
});
