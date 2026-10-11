const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openAnalysisOwner } = require('./analysis-fixture.js');
const { queryGrowthReports, readRegisteredProjectSources } = require('../out/growthReports.js');

async function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-native-reports-'));
  const root = path.join(base, '.solomap-global');
  const project = path.join(base, 'project'); fs.mkdirSync(project);
  const owner = await openAnalysisOwner(t, root, [{ path: project, name: 'Reports' }]);
  const projectId = owner.projectIds.get(project);
  const prepared = owner.store.prepareRun(projectId, (await owner.store.registerProject({ root: project })).locationId, {
    root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '完整提示', command: 'codex',
    userMessage: '完整原始需求' + '甲'.repeat(500), idempotencyKey: 'native-report-run'
  });
  return { ...owner, projectId, base, root, project, prepared, extension: path.resolve(__dirname, '..') };
}

test('ordinary report consumers resolve the current project database when no data-root argument is supplied', async t => {
  const f = await fixture(t);
  submit(f, '正式完整报告', 'default-root-native-report');
  const page = await queryGrowthReports(f.project, f.extension, {});
  assert.equal(page.tasks.length, 1, 'omitting the optional root must use the authoritative project database rather than legacy files');
  assert.equal(page.tasks[0].summary, '正式完整报告');
  const sources = await readRegisteredProjectSources(f.project, f.extension);
  assert.equal(sources.tasks.length, 1); assert.equal(sources.tasks[0].taskId, f.prepared.taskId);
  assert.equal(fs.existsSync(path.join(f.project, '.solopreneur', 'agent-runs')), false);
  if (process.env.SOLOMAP_462_PACKAGE2_EVIDENCE) fs.writeFileSync(`${process.env.SOLOMAP_462_PACKAGE2_EVIDENCE}-default-root.json`, JSON.stringify({ page, sources, prepared: f.prepared }, null, 2));
});

test('default report reads preserve native fixed versions and ignore a conflicting legacy report directory', async t => {
  const f = await fixture(t);
  const first = submit(f, '库中原始全文', 'default-root-first');
  submit(f, '库中后续完整报告', 'default-root-next');
  const { registerLearningTask, writeLearningJson } = require('../out/taskReport.js');
  const runDir = path.join(f.project, '.solopreneur', 'agent-runs', '__solo__', '1');
  const taskId = registerLearningTask(f.project, { executionLogId: 1, runDir, userMessage: '旧源不得覆盖新权威', startedAt: '' });
  const file = path.join(runDir, 'task-report-1.json');
  writeLearningJson(file, { schemaVersion: 1, taskId, projectPath: f.project, executionLogId: 1, turnId: '1:complete', report: { summary: '冲突旧文件' } });
  const before = fs.readFileSync(file);
  const page = await queryGrowthReports(f.project, f.extension, { taskId: f.prepared.taskId });
  assert.equal(page.tasks[0]?.summary, '库中后续完整报告');
  assert.ok(page.turns.some(turn => turn.history.some(version => version.report.summary === '库中原始全文')));
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(f.store.read(first.objectId, first.revision).data.summary, '库中原始全文');
});

function submit(f, summary, key) {
  return f.store.submitRunReport(f.projectId, { executionLogId: 1, generation: f.prepared.generation, turnId: f.prepared.turnId,
    report: { summary, unmetRequirements: ['尚需验收'], decisions: ['完整决策' + '乙'.repeat(10000)] }, availability: 'available', idempotencyKey: key });
}

async function continueReport(f, taskId, turnId, executionLogId) {
  const vm = require('node:vm');
  const compiled = fs.readFileSync(path.join(f.extension, 'out/extension.js'), 'utf8');
  const captureStart = compiled.indexOf('async function captureConversationLaunchTarget(');
  const captureEnd = compiled.indexOf('async function resumeOrdinaryConversation(', captureStart);
  assert.ok(captureStart > 0 && captureEnd > captureStart);
  const capture = new vm.Script(compiled.slice(captureStart, captureEnd) + '\ncaptureConversationLaunchTarget(context, workspaceRoot, globalDataPath, settings)');
  const branch = compiled.slice(compiled.indexOf("case 'growth.reports':"), compiled.indexOf("case 'project.select':", compiled.indexOf("case 'growth.reports':")));
  assert.ok(branch, 'exercise the compiled webview action handler');
  const settled = []; const launches = [];
  const panel = { webview: { postMessage: value => settled.push(value) } };
  await new vm.Script(`(async () => { switch (message.command) { ${branch} } })()`)
    .runInNewContext({
      message: { command: 'growth.reportAction', projectPath: f.project, kind: 'continue', taskId, turnId, executionLogId, actionId: 'continue-report' },
      context: { extensionPath: f.extension }, activeProjectGrowthPanel: panel,
      activeProjectGrowthPath: f.project, projectGrowthLoadSequence: 1, growthReportActions: new Set(),
      getProjects: () => [{ path: f.project }], getPersistedSettings: () => ({ globalDataPath: f.root }),
      normalizeGlobalDataPathForExtension: root => root, isSoloMapLanguageZh: () => true,
      growthReports_js_1: require('../out/growthReports.js'), path,
      vscode: { window: { showInputBox: async () => '继续完成日期选择' } },
      captureConversationLaunchTarget: (context, workspaceRoot, globalDataPath, settings) => capture.runInNewContext({ context, workspaceRoot, globalDataPath, settings,
        path, crypto: require('node:crypto'), syncEngine_1: require('../out/db/syncEngine.js') }),
      ensureActionProject: async () => f.project, waitForAgentProcessCleanup: async () => {},
      taskReport_1: require('../out/taskReport.js'),
      handleContinueConversationTurn: async (...args) => { launches.push(args); }
    });
  assert.equal(settled[0]?.error, undefined, 'the actual report action must accept native execution bindings');
  assert.equal(launches.length, 1);
  assert.equal(launches[0][1], '__solo__'); assert.equal(launches[0][2], executionLogId);
  assert.match(launches[0][3], /继续完成日期选择/);
  assert.match(launches[0][3], /参考上一轮工作汇报/);
  assert.equal(launches[0][6], true, 'report continuation preserves roadmap state');
  return launches[0];
}

async function archiveReport(f, receipt, key) {
  return f.ops({ operation: 'write', input: { kind: 'report', action: 'archive', scope: f.projectId,
    objectId: receipt.objectId, expectedRevision: receipt.revision, idempotencyKey: key, data: {} } });
}

test('an archived report leaves ordinary results while its pinned full version remains readable', async t => {
  const f = await fixture(t); const receipt = submit(f, '已经归档的结果', 'archive-single');
  await archiveReport(f, receipt, 'archive-single-host');
  const detail = await queryGrowthReports(f.project, f.extension, { taskId: `task-${f.prepared.taskId}` }, f.root);
  assert.equal(detail.turns.length, 0, 'archived material must leave ordinary results and actions');
  assert.equal(detail.tasks[0].latestSummary, '');
  const sources = await readRegisteredProjectSources(f.project, f.extension, f.root);
  assert.equal(sources.reports.length, 0);
  const original = f.store.readReportVersions(f.projectId, [{ objectId: receipt.objectId, revision: 1 }]);
  assert.equal(original[0].report.summary, '已经归档的结果'); assert.equal(original[0].report.decisions[0].length, 10004);
  assert.equal(sources.observations[0].envelope.report.summary, '已经归档的结果', 'explicit full history preserves the original report');
});

test('archiving an older report object does not withdraw a newer result from the same turn', async t => {
  const f = await fixture(t); const a = submit(f, '较早对象甲', 'archive-old-a'); submit(f, '仍然有效的乙', 'archive-old-b');
  await archiveReport(f, a, 'archive-old-a-host');
  const detail = await queryGrowthReports(f.project, f.extension, { taskId: `task-${f.prepared.taskId}` }, f.root);
  assert.equal(detail.tasks[0].latestSummary, '仍然有效的乙');
  assert.deepEqual(detail.turns[0].history.map(item => item.report.summary), ['仍然有效的乙']);
  const sources = await readRegisteredProjectSources(f.project, f.extension, f.root);
  assert.equal(sources.reports[0]?.report.summary, '仍然有效的乙');
  const launch = await continueReport(f, `task-${f.prepared.taskId}`, f.prepared.turnId, 1);
  assert.match(launch[3], /仍然有效的乙/); assert.doesNotMatch(launch[3], /较早对象甲/);
});

test('archiving the latest report object selects the remaining valid result for reading and continuation', async t => {
  const f = await fixture(t); submit(f, '保留的结果甲', 'archive-new-a'); const b = submit(f, '撤出的结果乙', 'archive-new-b');
  await archiveReport(f, b, 'archive-new-b-host');
  const detail = await queryGrowthReports(f.project, f.extension, { taskId: `task-${f.prepared.taskId}` }, f.root);
  assert.equal(detail.tasks[0].latestSummary, '保留的结果甲');
  assert.deepEqual(detail.turns[0].history.map(item => item.report.summary), ['保留的结果甲']);
  const launch = await continueReport(f, `task-${f.prepared.taskId}`, f.prepared.turnId, 1);
  assert.match(launch[3], /保留的结果甲/); assert.doesNotMatch(launch[3], /撤出的结果乙/);
  assert.equal(f.store.readReportVersions(f.projectId, [{ objectId: b.objectId, revision: 1 }])[0].report.summary, '撤出的结果乙');
});

test('the real work-report continue action uses the native execution identity', async t => {
  const f = await fixture(t); submit(f, '可继续处理的汇报', 'continue-native');
  await continueReport(f, `task-${f.prepared.taskId}`, f.prepared.turnId, 1);
});

test('backfilling older report indexes cannot replace a later committed version', async t => {
  const f = await fixture(t);
  const index = f.store.indexReportRevision.bind(f.store);
  const now = Date.now; const timestamp = now();
  let receipt;
  try {
    Date.now = () => timestamp;
    // Model retained pre-index revisions with the actual mutation, content and audit store.
    f.store.indexReportRevision = () => {};
    receipt = submit(f, '旧提交', 'before-version-index');
    f.store.indexReportRevision = index;
    f.store.write({ kind: 'report', action: 'patch', scope: f.projectId, objectId: receipt.objectId, expectedRevision: 1,
      idempotencyKey: 'after-version-index', data: { content: { summary: '新提交', unmetRequirements: [] } } });
  } finally { Date.now = now; f.store.indexReportRevision = index; }
  const detail = await queryGrowthReports(f.project, f.extension, { taskId: `task-${f.prepared.taskId}` }, f.root);
  assert.equal(detail.tasks[0].latestSummary, '新提交', 'index creation order is not report commit order');
  assert.deepEqual(detail.turns[0].history.map(item => item.report.summary), ['旧提交', '新提交']);
  const savedRoot = path.join(f.root, 'exports', 'reopened');
  await f.store.backup(path.join(savedRoot, 'solomap.db'));
  const reopened = require('../out/db/unifiedDataStore.js').UnifiedDataStore.open(savedRoot);
  try {
    const restored = reopened.readRegisteredReportSources(f.projectId);
    assert.equal(restored.reports[0].report.summary, '新提交');
    assert.deepEqual(restored.observations.map(item => item.envelope.report.summary), ['旧提交', '新提交']);
  } finally { reopened.close(); }
});

test('report ordering seeks the exact revision event instead of every event for each version', async t => {
  const f = await fixture(t); const receipt = submit(f, '版本0', 'order-seek-first');
  for (let revision = 1; revision < 100; revision++) f.store.write({ kind: 'report', action: 'patch', scope: f.projectId,
    objectId: receipt.objectId, expectedRevision: revision, idempotencyKey: `order-seek-${revision}`, data: { content: { summary: `版本${revision}` } } });
  const original = f.store.rows.bind(f.store); let query;
  f.store.rows = (sql, args) => { if (sql.startsWith('SELECT v.*,e.sequence')) query = { sql, args }; return original(sql, args); };
  const page = await queryGrowthReports(f.project, f.extension, {}, f.root);
  assert.equal(page.tasks[0].latestSummary, '版本99');
  const plan = original('EXPLAIN QUERY PLAN ' + query.sql, query.args);
  assert.ok(plan.some(row => /SEARCH e .*\(subject_id=\? AND content_id=\?\)/.test(row.detail)), JSON.stringify(plan));
});

test('history replay retains proven execution bindings when only the old run directory moves', async t => {
  const f = await fixture(t);
  const { registerLearningTask, writeLearningJson } = require('../out/taskReport.js');
  const { importAgentRuns } = require('../out/projectDataMigration.js');
  const sourceRoot = path.join(f.project, '.solopreneur/agent-runs');
  const runDir = path.join(sourceRoot, '__solo__/71'); fs.mkdirSync(runDir, { recursive: true });
  const taskId = registerLearningTask(f.project, { executionLogId: 71, runDir, userMessage: '旧任务继续', startedAt: '' });
  writeLearningJson(path.join(runDir, 'task-report-1.json'), { schemaVersion: 1, projectPath: f.project, taskId,
    executionLogId: 71, turnId: '1:complete', createdAt: '2026-09-01', report: { summary: '已保留的旧汇报' } });
  await importAgentRuns(f.store, sourceRoot, { projectRoot: f.project });
  const before = await readRegisteredProjectSources(f.project, f.extension, f.root);
  const revision = before.sourceRevision;
  fs.renameSync(runDir, path.join(f.base, 'retained-old-run'));
  await importAgentRuns(f.store, sourceRoot, { projectRoot: f.project });
  const after = await readRegisteredProjectSources(f.project, f.extension, f.root);
  assert.deepEqual(after.tasks.find(task => task.taskId === taskId).executions, [{ id: 71, nodeId: '__solo__' }]);
  assert.equal(after.sourceRevision, revision, 'unchanged proven binding must not publish another generation');
  await continueReport(f, taskId, after.reports.find(report => report.taskId === taskId).turnId, 71);
  const nextDir = path.join(sourceRoot, '__solo__/73'); fs.mkdirSync(nextDir, { recursive: true });
  registerLearningTask(f.project, { executionLogId: 73, runDir: nextDir, userMessage: '旧任务继续', startedAt: '', taskId });
  await importAgentRuns(f.store, sourceRoot, { projectRoot: f.project });
  const updated = await readRegisteredProjectSources(f.project, f.extension, f.root);
  assert.deepEqual(updated.tasks.find(task => task.taskId === taskId).executions, [{ id: 71, nodeId: '__solo__' }, { id: 73, nodeId: '__solo__' }]);
  assert.ok(updated.sourceRevision > revision, 'a newly proven binding publishes a new source generation');
  const bytes = fs.readFileSync(path.join(sourceRoot, 'learning-tasks', `${taskId}.json`));
  const source = { identity: `agent-runs:${f.project}`, key: `learning-tasks/${taskId}.json`, hash: require('node:crypto').createHash('sha256').update(bytes).digest('hex') };
  assert.throws(() => f.store.importRegisteredReportTask(f.projectId, source, bytes, {
    taskId, userMessage: '旧任务继续', startedAt: '', executions: [{ id: 71, nodeId: 'another-node' }]
  }), /legacy_task_execution_conflict/);
  assert.equal(f.store.reportSourceRevision(f.projectId), updated.sourceRevision, 'conflicting identity changes roll back');
});

test('retained valid report material remains actionable after a later invalid receipt', async t => {
  const f = await fixture(t); const receipt = submit(f, '上次有效材料', 'valid-before-invalid');
  f.store.write({ kind: 'report', action: 'patch', scope: f.projectId, objectId: receipt.objectId, expectedRevision: 1,
    idempotencyKey: 'invalid-after-valid', data: { availability: 'invalid', validation_error: 'bad_json', content: 'null' } });
  const sources = await readRegisteredProjectSources(f.project, f.extension, f.root);
  assert.equal(sources.reports[0]?.report.summary, '上次有效材料', 'visible retained material must also be available to its actions');
  await continueReport(f, `task-${f.prepared.taskId}`, f.prepared.turnId, 1);
});

test('work reports read native tasks and all report versions without legacy task directories', async t => {
  const f = await fixture(t);
  const first = submit(f, '第一版', 'first'); submit(f, '第二版', 'second'); submit(f, '第一版', 'third');
  const page = await queryGrowthReports(f.project, f.extension, {}, f.root);
  assert.equal(page.tasks.length, 1, 'a submitted native task must appear in work reports');
  assert.equal(page.tasks[0].taskId, `task-${f.prepared.taskId}`); assert.equal(page.tasks[0].unmet, true);
  const detail = await queryGrowthReports(f.project, f.extension, { taskId: page.tasks[0].taskId }, f.root);
  assert.equal(detail.turns.length, 1); assert.equal(detail.turns[0].turnId, f.prepared.turnId);
  assert.deepEqual(detail.turns[0].history.map(item => item.report.summary), ['第一版', '第二版', '第一版']);
  assert.equal(detail.turns[0].report.decisions[0].length, 10004);
  const sources = await readRegisteredProjectSources(f.project, f.extension, f.root);
  assert.equal(sources.tasks[0].userMessage.length, 506, 'review receives the complete original request');
  assert.equal(sources.reports[0].report.summary, '第一版');
  assert.equal(sources.observations[0].sourceRef.objectId, first.objectId);
  assert.equal(fs.existsSync(path.join(f.project, '.solopreneur/agent-runs')), false);
});

test('ordinary report lists decode no full bodies and generic report patches retain pinned versions', async t => {
  const f = await fixture(t); const receipt = submit(f, '原始', 'original');
  f.store.write({ kind: 'report', action: 'patch', scope: f.projectId, objectId: receipt.objectId, expectedRevision: 1,
    idempotencyKey: 'report-patch', data: { content: { summary: '修订', unmetRequirements: [], lessons: ['全文' + '丙'.repeat(20000)] } } });
  const originalDecode = f.store.decodedContent.bind(f.store); let decodes = 0;
  f.store.decodedContent = (...args) => { decodes++; return originalDecode(...args); };
  const reportContentIds = f.store.rows('SELECT content_id FROM report_versions WHERE project_id=?', [f.projectId]).map(row => row.content_id);
  const bodyIds = new Set([...reportContentIds, f.store.readMetadata(f.prepared.taskId).data.original_request_content_id]);
  const originalContent = f.store.content.bind(f.store); let bodyReads = 0;
  f.store.content = id => { if (bodyIds.has(id)) bodyReads++; return originalContent(id); };
  const page = await queryGrowthReports(f.project, f.extension, {}, f.root);
  assert.equal(page.tasks[0]?.latestSummary, '修订'); assert.equal(page.tasks[0].unmet, false);
  assert.equal(decodes, 0, 'overview must not deserialize report, request or log bodies');
  assert.equal(bodyReads, 0, 'overview must not read full stored bodies through another decoder');
  const detail = await queryGrowthReports(f.project, f.extension, { taskId: page.tasks[0].taskId }, f.root);
  assert.deepEqual(detail.turns[0].history.map(item => item.report.summary), ['原始', '修订']);
  assert.equal(detail.turns[0].report.lessons[0].length, 20002);
  const before = fs.statSync(f.store.filePath + '-wal').size;
  for (let i = 0; i < 8; i++) await queryGrowthReports(f.project, f.extension, {}, f.root);
  assert.equal(fs.statSync(f.store.filePath + '-wal').size, before, 'unchanged overview must not persist another copy');
});

test('report retry rejects a changed availability intent rather than replaying a different receipt', async t => {
  const f = await fixture(t);
  const input = { executionLogId: 1, generation: f.prepared.generation, turnId: f.prepared.turnId, report: null, availability: 'missing', idempotencyKey: 'same-report-intent' };
  f.store.submitRunReport(f.projectId, input);
  assert.throws(() => f.store.submitRunReport(f.projectId, { ...input, availability: 'invalid', validationError: 'bad json' }), /idempotency_conflict/);
});

test('explicit history migration preserves registered report versions and unknown start times', async t => {
  const f = await fixture(t);
  const { registerLearningTask, writeLearningJson } = require('../out/taskReport.js');
  const { importAgentRuns } = require('../out/projectDataMigration.js');
  const runDir = path.join(f.project, '.solopreneur/agent-runs/__solo__/71'); fs.mkdirSync(runDir, { recursive: true });
  const legacyTask = registerLearningTask(f.project, { executionLogId: 71, runDir, userMessage: '完整旧需求' + '丁'.repeat(1000), startedAt: '' });
  const reportFile = path.join(runDir, 'task-report-1.json');
  const body = summary => ({ schemaVersion: 1, projectPath: f.project, taskId: legacyTask, executionLogId: 71, turnId: '1:complete', createdAt: '2026-09-01T10:00:00Z', report: { summary, unmetRequirements: ['待验收'], decisions: ['完整历史' + '戊'.repeat(10000)] } });
  for (const summary of ['旧版甲', '旧版乙', '旧版甲']) {
    writeLearningJson(reportFile, body(summary));
    await importAgentRuns(f.store, path.join(f.project, '.solopreneur/agent-runs'), { projectRoot: f.project });
  }
  const before = await queryGrowthReports(f.project, f.extension, { taskId: legacyTask }, f.root);
  assert.equal(before.tasks.length, 1, 'explicit migration must make registered historical work readable from the single database');
  assert.deepEqual(before.turns[0].history.map(item => item.report.summary), ['旧版甲', '旧版乙', '旧版甲']);
  assert.equal(before.turns[0].executionLogId, 71); assert.equal(before.tasks[0].createdAt, '2026-09-01T10:00:00Z');
  const savedTurn = f.store.readMetadata(before.turns[0].turnId);
  assert.equal(savedTurn.data.started_at, null, 'a report timestamp cannot invent a missing turn start');
  fs.renameSync(path.join(f.project, '.solopreneur/agent-runs'), path.join(f.base, 'retained-history'));
  const reopened = await queryGrowthReports(f.project, f.extension, { taskId: legacyTask }, f.root);
  assert.deepEqual(reopened, before, 'legacy directories are no longer a condition of successful reading');
  const sources = await readRegisteredProjectSources(f.project, f.extension, f.root);
  assert.equal(sources.tasks.find(task => task.taskId === legacyTask).userMessage.length, 1005);
});

test('a report changed while the overview loads is re-read before publishing the page', async t => {
  const f = await fixture(t); submit(f, '过时结果', 'late-old');
  const readSources = f.store.readRegisteredReportSources.bind(f.store); let changed = false;
  f.store.readRegisteredReportSources = (...args) => {
    const value = readSources(...args);
    if (!changed) { changed = true; queueMicrotask(() => submit(f, '当前结果', 'late-new')); }
    return value;
  };
  const page = await queryGrowthReports(f.project, f.extension, {}, f.root);
  assert.equal(page.tasks[0].latestSummary, '当前结果', 'a late page must converge to the committed report');
});

test('GitHub verification retains partial facts in native evidence and leaves no learning-evidence files', async t => {
  const f = await fixture(t); const { collectGithubEvidence } = require('../out/learningReview.js');
  const taskId = `task-${f.prepared.taskId}`; const sha = 'e'.repeat(40); let offline = false;
  const input = { projectPath: f.project, globalDataPath: f.root, repository: 'owner/repo', tasks: [{ taskId, startedAt: '2026-09-01' }], reports: [], api: async endpoint => {
    if (endpoint.includes('/commits?')) return [{ sha, commit: { message: `fix: native\n\nSoloMap-Task: ${taskId}` } }];
    if (endpoint.includes('/check-runs?')) { if (offline) throw new Error('offline'); return { check_runs: [{ id: 1, head_sha: sha, conclusion: 'success' }] }; }
    if (endpoint.includes('/status?')) return { sha, statuses: [] };
    return { sha, commit: { message: `fix: native\n\nSoloMap-Task: ${taskId}` }, files: [{ filename: 'a.js', patch: '+a', changes: 1 }] };
  } };
  const first = await collectGithubEvidence(input); offline = true; const second = await collectGithubEvidence(input);
  assert.equal(second.commits[0].checks[0].conclusion, 'success');
  assert.equal(second.commits[0].checksObservedAt, first.commits[0].checksObservedAt);
  assert.equal(fs.existsSync(path.join(f.project, '.solopreneur/agent-runs')), false, 'explicit verification must not create permanent evidence files');
  const native = f.store.search({ scope: f.projectId, kinds: ['evidence'], query: 'github_host_facts' }).items;
  assert.equal(native.length, 1, 'full facts belong to one versioned native evidence object');
  assert.equal(f.store.read(native[0].objectId).revision, 2);
});
