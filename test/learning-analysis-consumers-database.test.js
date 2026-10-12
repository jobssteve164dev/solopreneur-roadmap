const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');
const { runtimeBuildId } = require('../out/runtimeBuildIdentity.js');
const { claimRuntimeLease } = require('../out/autonomousRuntime.js');
const portfolio = require('../out/projectPortfolio.js');
const strategy = require('../out/strategyPyramid.js');
const { SidebarProjectLoader } = require('../out/sidebarProjectLoader.js');

function removeFixtureTree(root) {
  if (!fs.existsSync(root)) return;
  const files = [];
  const directories = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      files.push(current);
      continue;
    }
    directories.push(current);
    for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
  }
  for (const filePath of files) fs.unlinkSync(filePath);
  directories.sort((left, right) => right.split(path.sep).length - left.split(path.sep).length || right.localeCompare(left));
  for (const directoryPath of directories) fs.rmdirSync(directoryPath);
}

async function fixture(action) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-learning-analysis-'));
  const workspace = path.join(base, 'project'); fs.mkdirSync(path.join(workspace, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.solopreneur', 'roadmap.csv'), 'id,title,stage,status\n1,Verify demand,Learn,Pending\n');
  const root = path.join(base, '.solomap-global');
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const runtimeEntry = path.resolve(__dirname, '../out/autonomousRuntimeProcess.js');
  claimRuntimeLease(root, { runtimeId: 'learning-analysis-owner', pid: process.pid });
  const onCommand = async command => {
    if (command === 'refresh') {
      const runtime = require('../out/autonomousRuntime.js');
      await require('../out/projectRegistry.js').refreshProjectRegistry(root, undefined, (operation, input) => ops({ operation, input }));
      runtime.runShadowDecisionCycle({ globalDataPath: root });
      await runtime.persistShadowRuntimeState(root, ops);
    }
    return { status: 'running' };
  };
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'learning-analysis-owner', entryPath: runtimeEntry, buildId: runtimeBuildId(path.resolve(__dirname, '..')), onCommand, onData: ops });
  let owner = { store, ops, server };
  const closeOwner = async () => { const previous = owner; owner = null; if (previous) { await previous.server.close(); await previous.ops.close(); previous.store.close(); } };
  const restart = async () => {
    const id = store.databaseId;
    await closeOwner();
    const reopened = UnifiedDataStore.open(root, id); const operations = createRuntimeDataOperations(reopened);
    claimRuntimeLease(root, { runtimeId: 'learning-analysis-owner', pid: process.pid });
    owner = { store: reopened, ops: operations, server: await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'learning-analysis-owner', entryPath: runtimeEntry, buildId: runtimeBuildId(path.resolve(__dirname, '..')), onCommand, onData: operations }) };
    return owner;
  };
  const project = (await ops({ operation: 'register_project', input: { root: workspace } })).projectId;
  const evidence = store.write({ kind: 'evidence', action: 'create', scope: project, idempotencyKey: 'analysis-evidence', data: { type: 'host_observation', source_actor_id: 'local-runtime', content: 'The check failed', observed_at: Date.now() } });
  const event = store.write({ kind: 'learning_event', action: 'create', scope: project, idempotencyKey: 'analysis-event', data: { source_object_id: evidence.objectId, source_revision: 1, event_type: 'failed', source_type: 'solo', summary: 'A failed validation needs attention', occurred_at: Date.now() } });
  const lesson = store.write({ kind: 'lesson', action: 'create', scope: project, idempotencyKey: 'analysis-lesson', data: { status: 'candidate', summary: 'Check the actual outcome before continuing', applies_when: 'Completing a change', do_this: 'Run a meaningful check', avoid_this: 'Do not infer success', lesson_type: 'verification_pattern', source_event_ids_json: [event.objectId], confidence: 0.9 } });
  try { await action({ base, root, workspace, project, store, ops, event, lesson, restart, projects: [{ name: 'Project', path: workspace, type: 'core_product' }] }); }
  finally {
    await closeOwner();
    removeFixtureTree(base);
  }
}

test('project portfolio uses committed learning signals without a legacy learning directory', () => fixture(async ({ workspace, root, projects }) => {
  const [summary] = await portfolio.buildProjectPortfolioSummariesFromDatabase(projects, path.resolve(__dirname, '..'), { includeReusableSignals: true, globalDataPath: root });
  assert.equal(summary.reusableSignals, 3);
  assert.equal(summary.nodes[0].title, 'Verify demand');
  assert.equal(fs.existsSync(path.join(root, 'learning')), false);
  assert.equal(fs.existsSync(path.join(workspace, '.solopreneur', 'project_journal.db')), false);
}));

test('portfolio counts native reusable sources once and ignores leftover legacy directories', () => fixture(async ({ workspace, root, projects, project, store }) => {
  for (const nodeId of ['1', '2']) store.writeStepMemory(project, { nodeId, expectedRevision: 0, patch: { goal: 'Verify the outcome' }, idempotencyKey: `portfolio-memory:${nodeId}` });
  for (const executionLogId of [1, 2]) store.upsertProjectRunIndex(project, { executionLogId, nodeId: '__solo__', runKind: 'solo', status: 'Completed', startedAt: '2026-10-09T10:00:00Z', finishedAt: '2026-10-09T10:05:00Z', durationMs: 300000 });
  fs.mkdirSync(path.join(workspace, '.solopreneur', 'agent-runs', 'phantom-old-group'), { recursive: true });
  fs.mkdirSync(path.join(workspace, '.solopreneur', 'step-memory'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.solopreneur', 'step-memory', 'phantom.json'), '{}');
  const [summary] = await portfolio.buildProjectPortfolioSummariesFromDatabase(projects, path.resolve(__dirname, '..'), { includeReusableSignals: true, globalDataPath: root });
  assert.equal(summary.reusableSignals, 6);
  assert.equal(summary.investment.soloConversationCount, 2);
}));

test('the existing sidebar card receives formal learning signals during asynchronous enrichment', () => fixture(async ({ root, workspace, projects }) => {
  let resolveUpdate;
  const update = new Promise(resolve => { resolveUpdate = resolve; });
  const loader = new SidebarProjectLoader({ isAvailable: () => true, getGlobalDataPath: () => root, getExtensionPath: () => path.resolve(__dirname, '..'), postMessage: message => { if (message.projects?.updatedProjectPaths?.includes(workspace)) resolveUpdate(message); }, buildGlobalStore: () => ({}), buildGlobalStorePlaceholder: () => ({}) });
  const timer = setTimeout(() => resolveUpdate(null), 3000);
  try {
    loader.schedulePortfolioEnrichment(projects, workspace, portfolio.buildProjectPortfolioSummaries(projects, { coreOnly: true }));
    const message = await update;
    assert.ok(message, 'the existing card must finish enrichment');
    assert.equal(message.projects.portfolio[0].reusableSignals, 3);
    assert.equal(fs.existsSync(path.join(root, 'learning')), false);
  } finally { clearTimeout(timer); loader.cancelExternalLoads(); }
}));

test('strategy pyramid uses committed learning and preserves roadmap facts without regenerating old sources', () => fixture(async ({ workspace, root, projects }) => {
  const snapshot = await strategy.buildStrategyPyramidSnapshotData(projects, root, workspace);
  assert.equal(snapshot.learningSignals.length, 1);
  assert.equal(snapshot.learningSignals[0].eventCount, 1);
  assert.equal(snapshot.learningSignals[0].candidateCount, 1);
  assert.equal(snapshot.learningSignals[0].riskSignals, 1);
  assert.equal(snapshot.learningSignals[0].verificationSignals, 1);
  assert.equal(snapshot.projects[0].nodes[0].title, 'Verify demand');
  assert.equal(fs.existsSync(path.join(root, 'learning')), false);
  assert.equal(fs.existsSync(path.join(root, 'strategy')), false);
}));

test('strategy choices and cached judgments remain available without permanent strategy files', () => fixture(async ({ workspace, root, projects, restart }) => {
  await strategy.saveProjectStrategyData(root, workspace, '冻结项目', 'sunset', 'unknown', 'low', '冻结项目，减少维护', ['CLI 与开发者工具']);
  assert.equal(fs.existsSync(path.join(root, 'strategy')), false);
  const snapshot = await strategy.buildStrategyPyramidSnapshotData(projects, root, workspace);
  assert.equal(snapshot.projects[0].role, '冻结项目');
  assert.equal(snapshot.projects[0].businessStage, 'sunset');
  await restart();
  const cached = await strategy.readCachedStrategyPyramidSnapshot(projects, root);
  assert.equal(cached.generatedAt, snapshot.generatedAt);
  assert.equal(cached.projects[0].role, '冻结项目');
  assert.equal(fs.existsSync(path.join(root, 'strategy')), false);
}));

test('strategy cache invalidates on a committed learning revision while unrelated writes preserve it', () => fixture(async ({ workspace, root, projects, store, event, project }) => {
  const snapshot = await strategy.buildStrategyPyramidSnapshotData(projects, root, workspace);
  store.write({ kind: 'memory', action: 'create', scope: project, idempotencyKey: 'unrelated-strategy-note', data: { category: 'active', title: 'A separate note', content: 'Preserve the selected user action', status: 'captured' } });
  assert.equal((await strategy.readCachedStrategyPyramidSnapshot(projects, root)).generatedAt, snapshot.generatedAt);
  store.write({ kind: 'learning_event', action: 'patch', scope: project, objectId: event.objectId, expectedRevision: 1, idempotencyKey: 'strategy-event-changed', data: { summary: 'The result now needs a different check' } });
  assert.equal(await strategy.readCachedStrategyPyramidSnapshot(projects, root), null);
}));

test('strategy state retries return the original receipt and stale concurrent updates cannot overwrite it', () => fixture(async ({ workspace, ops }) => {
  const initial = { root: workspace, expectedRevision: 0, value: { role: 'frozen' }, idempotencyKey: 'native-strategy-original-choice' };
  const first = await ops({ operation: 'write_strategy_state', input: initial });
  const retried = await ops({ operation: 'write_strategy_state', input: initial });
  assert.deepEqual(retried, first);
  assert.equal(first.revision, 1);
  const second = await ops({ operation: 'write_strategy_state', input: { root: workspace, expectedRevision: 1, value: { role: 'maintenance' }, idempotencyKey: 'native-strategy-later-choice' } });
  assert.equal(second.revision, 2);
  await assert.rejects(ops({ operation: 'write_strategy_state', input: { root: workspace, expectedRevision: 1, value: { role: 'core_product' }, idempotencyKey: 'native-strategy-stale-choice' } }), /revision_conflict/);
  assert.deepEqual(await ops({ operation: 'write_strategy_state', input: initial }), first);
  assert.deepEqual((await ops({ operation: 'read_strategy_state', input: { root: workspace } })).value, { role: 'maintenance' });
}));

test('a judgment completing late cannot overwrite a newer judgment from another window', () => fixture(async ({ root, workspace, projects }) => {
  const judgment = mainJudgment => ({ confidence: 'medium', stageTitle: '验证期', mainJudgment, strategicAction: '验证', constraint: '不扩张', risks: [], moves: [], recommendedScenarioPath: '验证', projects: [] });
  let finishOld; let entered;
  const oldResult = new Promise(resolve => { finishOld = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const older = strategy.buildCognitiveStrategyPyramidSnapshotData(projects, root, workspace, { id: 'test-model', async judgeStrategyPyramid() { entered(); return oldResult; } }, 'same-model');
  const rejectedOlder = assert.rejects(older, /revision_conflict/);
  await started;
  await strategy.buildCognitiveStrategyPyramidSnapshotData(projects, root, workspace, { id: 'test-model', async judgeStrategyPyramid() { return judgment('较新的判断'); } }, 'same-model');
  finishOld(judgment('迟到的旧判断'));
  await rejectedOlder;
  assert.equal((await strategy.readCachedStrategyPyramidSnapshot(projects, root, 'same-model')).mainJudgment, '较新的判断');
}));

test('cache publication checks committed source changes inside the owner transaction', () => fixture(async ({ ops, store, project, event, workspace }) => {
  const source = await ops({ operation: 'read_strategy_source_revision', input: { roots: [workspace] } });
  store.write({ kind: 'learning_event', action: 'patch', scope: project, objectId: event.objectId, expectedRevision: 1, idempotencyKey: 'source-between-check-and-commit', data: { summary: 'New evidence is committed before cache publication' } });
  await assert.rejects(ops({ operation: 'write_strategy_state', input: { expectedRevision: 0, value: { snapshot: 'stale' }, expectedSourceRevision: source.revision, sourceProjectIds: source.projectIds, idempotencyKey: 'stale-source-publication' } }), /strategy_source_conflict/);
  assert.equal(store.readStrategyState(null).objectId, null);
}));

test('cache publication rejects changed preferences or investment and retries committed receipts after later source changes', () => fixture(async ({ ops, store, project, workspace }) => {
  const source = await ops({ operation: 'read_strategy_source_revision', input: { roots: [workspace] } });
  const input = { expectedRevision: 0, value: { snapshot: 'current' }, expectedSourceRevision: source.revision, sourceProjectIds: source.projectIds, idempotencyKey: 'committed-cache-intent' };
  const first = await ops({ operation: 'write_strategy_state', input });
  store.writeStrategyState(project, { expectedRevision: 0, value: { role: 'frozen' }, idempotencyKey: 'later-preference' });
  assert.deepEqual(await ops({ operation: 'write_strategy_state', input }), first);
  await assert.rejects(ops({ operation: 'write_strategy_state', input: { ...input, expectedRevision: 1, idempotencyKey: 'old-preference-cache' } }), /strategy_source_conflict/);
  const laterSource = await ops({ operation: 'read_strategy_source_revision', input: { roots: [workspace] } });
  store.upsertProjectRunIndex(project, { executionLogId: 1, nodeId: '1', runKind: 'step', status: 'Completed', durationMs: 600000 });
  await assert.rejects(ops({ operation: 'write_strategy_state', input: { ...input, expectedRevision: 1, expectedSourceRevision: laterSource.revision, idempotencyKey: 'old-investment-cache' } }), /strategy_source_conflict/);
  assert.equal(store.readStrategyState(null).revision, 1);
}));

test('strategy writes require a usable request intent and cannot create state from malformed requests', () => fixture(async ({ ops, store, workspace, project }) => {
  for (const idempotencyKey of [undefined, '', '   ', 17]) await assert.rejects(ops({ operation: 'write_strategy_state', input: { root: workspace, expectedRevision: 0, value: { role: 'frozen' }, idempotencyKey } }), /invalid_strategy_state/);
  assert.equal(store.readStrategyState(project).objectId, null);
}));

test('a superseded rules request cannot consume the cache revision before the latest request completes', () => fixture(async ({ root, workspace, projects, store }) => {
  const original = store.readLearningOverview.bind(store);
  let count = 0; let enterOld; let enterNew; let finishOld; let finishNew; let oldCurrent = true;
  const oldEntered = new Promise(resolve => { enterOld = resolve; }); const newEntered = new Promise(resolve => { enterNew = resolve; });
  const oldResult = new Promise(resolve => { finishOld = resolve; }); const newResult = new Promise(resolve => { finishNew = resolve; });
  store.readLearningOverview = async () => { if (++count === 1) { enterOld(); await oldResult; } else { enterNew(); await newResult; } return original(); };
  const observe = promise => promise.then(value => ({ value }), error => ({ error }));
  const older = observe(strategy.buildStrategyPyramidSnapshotData(projects, root, workspace, true, () => oldCurrent));
  await oldEntered; oldCurrent = false;
  const newer = observe(strategy.buildStrategyPyramidSnapshotData(projects, root, workspace, true, () => true));
  await newEntered; finishOld();
  const old = await older; finishNew(); const latest = await newer;
  store.readLearningOverview = original;
  assert.ok(old.error && /no longer current|configuration changed/.test(old.error.message), 'the old request must lose publication eligibility before any write');
  assert.equal(latest.error, undefined, 'the latest request must retain its starting cache revision');
  assert.equal((await strategy.readCachedStrategyPyramidSnapshot(projects, root)).generatedAt, latest.value.generatedAt);
}));

test('the existing daily review action receives committed learning counts from the Runtime owner', () => fixture(async ({ root, projects, ops }) => {
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    return request === 'vscode' ? { window: { createTerminal: () => ({ show() {}, sendText() {} }) } } : original.apply(this, arguments);
  };
  try {
    const runtime = require('../out/autonomousRuntime.js');
    await require('../out/projectRegistry.js').refreshProjectRegistry(root, undefined, (operation, input) => ops({ operation, input }));
    runtime.runShadowDecisionCycle({ globalDataPath: root, projects });
    await runtime.persistShadowRuntimeState(root, ops);
    const { startDailyReviewAgent } = require('../out/dailyReview.js');
    const review = await startDailyReviewAgent({ globalDataPath: root, cliPath: '/missing-solomap-analysis-test-agent', taskPermissionMode: 'ask' }, projects);
    assert.equal(review.inputSnapshot.ledgerEventCount, 1);
    assert.equal(review.inputSnapshot.ledgerCandidateCount, 1);
    assert.equal(review.inputSnapshot.confirmedLearningCount, 0);
    assert.equal(fs.existsSync(path.join(root, 'learning')), false);
  } finally { Module._load = original; }
}));
