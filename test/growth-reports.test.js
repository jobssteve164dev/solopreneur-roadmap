const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { registerLearningTask, writeLearningJson } = require('../out/taskReport.js');

function fixture() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'growth-reports-'));
  const runDir = path.join(project, '.solopreneur/agent-runs/__solo__/1');
  fs.mkdirSync(runDir, { recursive: true });
  const taskId = registerLearningTask(project, { executionLogId: 1, runDir, userMessage: '设计导出体验', startedAt: '2026-09-01T00:00:00Z' });
  const report = (sequence, body) => writeLearningJson(path.join(runDir, `task-report-${sequence}.json`), {
    schemaVersion: 1, projectPath: project, taskId, executionLogId: 1, turnId: `${sequence}:complete`, createdAt: `2026-09-0${sequence}T01:00:00Z`, report: body
  });
  return { project, runDir, taskId, report };
}

test('ledger groups stable tasks, retains legacy unknown work and versions, and paginates locally', async () => {
  const { queryGrowthReports } = require('../out/growthReports.js');
  const f = fixture();
  f.report(1, { summary: '第一轮', unmetRequirements: ['尚缺实际验收'], decisions: ['保留导出入口', { action: '预览', reason: '减少误操作', custom: '兼容信息' }] });
  let page = await queryGrowthReports(f.project, path.resolve(__dirname, '..'), {});
  assert.equal(page.tasks.length, 1);
  assert.equal(page.tasks[0].title, '设计导出体验');
  assert.equal(page.tasks[0].unmet, true);
  f.report(2, { summary: '', verification: [{ result: '通过', evidence: ['本地记录'] }] });
  page = await queryGrowthReports(f.project, path.resolve(__dirname, '..'), { unmetOnly: true });
  assert.equal(page.tasks.length, 1, 'missing field and empty summary do not close earlier work');
  assert.equal(page.tasks[0].latestSummary, '');
  let detail = await queryGrowthReports(f.project, path.resolve(__dirname, '..'), { taskId: f.taskId });
  assert.equal(detail.turns.length, 2);
  f.report(1, { summary: '修正第一轮', unmetRequirements: ['尚缺实际验收'] });
  detail = await queryGrowthReports(f.project, path.resolve(__dirname, '..'), { taskId: f.taskId });
  assert.equal(detail.turns.length, 2);
  assert.equal(detail.turns.find(t => t.sequence === 1).versions.length, 2);
  f.report(1, { summary: '第一轮', unmetRequirements: ['尚缺实际验收'], decisions: ['保留导出入口', { action: '预览', reason: '减少误操作', custom: '兼容信息' }] });
  detail = await queryGrowthReports(f.project, path.resolve(__dirname, '..'), { taskId: f.taskId });
  assert.deepEqual(detail.turns.find(t => t.sequence === 1).history.map(item => item.report.summary), ['第一轮', '修正第一轮', '第一轮']);
  fs.writeFileSync(path.join(f.runDir, 'task-report-2.json'), '{');
  detail = await queryGrowthReports(f.project, path.resolve(__dirname, '..'), { taskId: f.taskId });
  assert.equal(detail.turns.length, 2);
  assert.equal(detail.turns[0].availability, 'invalid');
  assert.ok(detail.turns[0].report, 'previous valid material is retained');
});

test('report reading rejects cross-project directories, symlinks and forged turn identities', async () => {
  const { readRegisteredTaskSources } = require('../out/growthReports.js');
  const a = fixture(); const b = fixture();
  a.report(1, { summary: '合法' });
  writeLearningJson(path.join(a.runDir, 'task-report-2.json'), { projectPath: a.project, taskId: a.taskId, executionLogId: 99, turnId: '2:complete', report: { summary: '伪造' } });
  fs.symlinkSync(path.join(a.runDir, 'task-report-1.json'), path.join(a.runDir, 'task-report-3.json'));
  const taskFile = path.join(a.project, '.solopreneur/agent-runs/learning-tasks', `${a.taskId}.json`);
  const task = JSON.parse(fs.readFileSync(taskFile));
  task.executions.push({ id: 2, runDir: b.runDir }); writeLearningJson(taskFile, task);
  const sources = readRegisteredTaskSources(a.project);
  assert.equal(sources.reports.length, 1);
  assert.equal(sources.reports[0].report.summary, '合法');
});

test('explicit fact refresh coalesces requests and retains exact previous checks on partial failure', async () => {
  const { collectGithubEvidence } = require('../out/learningReview.js');
  const f = fixture(); const sha = 'a'.repeat(40); let checks = 0; let fail = false;
  const input = { projectPath: f.project, repository: 'owner/repo', tasks: [{ taskId: f.taskId, startedAt: '2026-09-01' }], reports: [], api: async endpoint => {
    if (endpoint.includes('/commits?')) return [{ sha, commit: { message: `fix: result\n\nSoloMap-Task: ${f.taskId}` } }];
    if (endpoint.includes('/check-runs?')) { checks++; if (fail) throw new Error('offline'); return { check_runs: [{ id: 1, head_sha: sha, status: 'completed', conclusion: 'failure' }] }; }
    if (endpoint.includes('/status?')) return { sha, statuses: [] };
    return { sha, files: [{ filename: 'src/a.js', changes: 1, patch: '+value' }], commit: { message: 'result' } };
  } };
  const results = await Promise.all([collectGithubEvidence(input), collectGithubEvidence(input)]);
  assert.equal(checks, 1);
  assert.equal(results[0].commits[0].checks[0].conclusion, 'failure');
  fail = true;
  const next = await collectGithubEvidence(input);
  assert.equal(next.commits[0].checks[0].conclusion, 'failure');
  assert.ok(next.commits[0].gaps.includes('offline'));
  assert.equal(next.commits[0].checksObservedAt, results[0].commits[0].checksObservedAt);
  assert.ok(fs.readdirSync(path.join(f.project, '.solopreneur/agent-runs/learning-evidence')).some(name => name.endsWith('.facts.json')));
});

test('static test references cannot establish feature acceptance', () => {
  const { buildProjectGrowthSnapshot, buildProjectGrowthViewModel } = require('../out/projectGrowth.js');
  const f = fixture(); fs.mkdirSync(path.join(f.project, 'src')); fs.mkdirSync(path.join(f.project, 'test'));
  fs.writeFileSync(path.join(f.project, 'src/feature.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(f.project, 'test/feature.test.js'), "const feature = require('../src/feature.js'); test('feature', () => {});");
  const run = { executionLogId: 1, nodeId: 'feature', files: [{ filePath: 'src/feature.js', role: 'changed' }], signals: [], status: 'Completed', startedAt: '', finishedAt: '' };
  const snapshot = buildProjectGrowthSnapshot(f.project, [{ id: 'feature', title: '导出', status: 'Completed', stage: '交付' }], [run]);
  snapshot.nodes.push({ nodeId: 'module:feature', kind: 'module', label: 'Feature', fileCount: 1, loc: 10, confidence: 1, primaryRole: 'feature' });
  snapshot.edges.push({ sourceId: 'module:feature', targetId: 'file:src/feature.js', kind: 'contains' },
    { sourceId: 'file:src/feature.js', targetId: 'file:test/feature.test.js', kind: 'tested_by' },
    { sourceId: 'module:feature', targetId: 'capability:roadmap:feature', kind: 'implements' });
  const view = buildProjectGrowthViewModel(snapshot);
  assert.ok(view.modules.some(module => module.directCoveragePercent === 100));
  assert.ok(view.capabilityHealth.every(capability => capability.status !== 'formed'));
  assert.ok(view.focusAreas.every(area => area.status !== 'formed'));
});

test('coverage source identity detects same-size edits, including reopened cached views', async () => {
  const { captureCoverageVersion, coverageVersionState } = require('../out/projectCoverage.js');
  const f = fixture(); fs.mkdirSync(path.join(f.project, 'src'));
  fs.writeFileSync(path.join(f.project, 'src/a.js'), 'one');
  const sourceVersion = captureCoverageVersion(f.project);
  assert.equal(coverageVersionState(f.project, { sourceVersion }), 'current');
  const coverageFile = path.join(f.project, '.solopreneur/coverage/project-growth-coverage.json');
  fs.mkdirSync(path.dirname(coverageFile), { recursive: true });
  fs.writeFileSync(coverageFile, JSON.stringify({ version: 1, provider: 'c8-istanbul', files: [], sourceVersion }));
  const { getProjectGrowthView } = require('../out/projectGrowth.js');
  await getProjectGrowthView(f.project, path.resolve(__dirname, '..'), { refreshIfMissing: false });
  fs.writeFileSync(path.join(f.project, 'src/a.js'), 'two');
  assert.equal(coverageVersionState(f.project, { sourceVersion }), 'stale');
  assert.equal(coverageVersionState(f.project, {}), 'unknown');
  const reopened = await getProjectGrowthView(f.project, path.resolve(__dirname, '..'), { refreshIfMissing: false });
  assert.equal(reopened.coverage.versionState, 'stale');
});

test('large accumulated evidence remains readable without loading diff bodies into the page', async () => {
  const { queryGrowthReports } = require('../out/growthReports.js');
  const f = fixture(); f.report(1, { summary: '结果' });
  const dir = path.join(f.project, '.solopreneur/agent-runs/learning-evidence'); fs.mkdirSync(dir);
  const commits = Array.from({ length: 2000 }, (_, i) => ({ sha: i.toString(16).padStart(40, '0'), repository: 'owner/repo', taskIds: i === 0 ? [f.taskId] : ['task-other'], checks: [{ name: '检查'.repeat(250), conclusion: 'success' }], files: [] }));
  const file = path.join(dir, 'repo.summary.json'); fs.writeFileSync(file, JSON.stringify({ commits }));
  assert.ok(fs.statSync(file).size > 1024 * 1024);
  const page = await queryGrowthReports(f.project, path.resolve(__dirname, '..'), {});
  assert.equal(page.tasks[0].evidence.length, 1);
  assert.equal(page.tasks[0].evidence[0].checks[0].conclusion, 'success');
});

test('separately refreshed shared tasks retain scopes and never inherit the entire diff', async () => {
  const { collectGithubEvidence } = require('../out/learningReview.js');
  const f = fixture(); const sha = 'b'.repeat(40); const second = 'task-second';
  const api = async endpoint => {
    if (endpoint.includes('/commits?')) return [{ sha, commit: { message: `fix: shared\n\nSoloMap-Task: ${f.taskId}\nSoloMap-Task: ${second}` } }];
    if (endpoint.includes('/check-runs?')) return { check_runs: [] };
    if (endpoint.includes('/status?')) return { sha, statuses: [] };
    return { sha, commit: { message: `fix: shared\n\nSoloMap-Task: ${f.taskId}\nSoloMap-Task: ${second}` }, files: ['a.js','b.js'].map(filename => ({ filename, patch: '+ok', changes: 1 })) };
  };
  for (const [taskId, file] of [[f.taskId, 'a.js'], [second, 'b.js']]) await collectGithubEvidence({ projectPath: f.project, repository: 'owner/repo', tasks: [{ taskId, startedAt: '2026-09-01' }], reports: [{ taskId, report: { commits: [{ repository: 'owner/repo', sha, files: [file] }] } }], api });
  const root = path.join(f.project, '.solopreneur/agent-runs/learning-evidence');
  const facts = JSON.parse(fs.readFileSync(path.join(root, fs.readdirSync(root).find(name => name.endsWith('.facts.json')))));
  assert.equal(facts.commits[0].commitTaskIds.length, 2);
  assert.deepEqual(facts.commits[0].reportedScopes.map(scope => scope.files), [['a.js'], ['b.js']]);
});

test('source changed while loading converges to the new turn and a snapshot writer preserves reports', async () => {
  const { queryGrowthReports } = require('../out/growthReports.js');
  const { SqliteStore } = require('../out/db/sqliteStore.js');
  const f = fixture(); f.report(1, { summary: '旧结果', unmetRequirements: ['待办'] });
  const extension = path.resolve(__dirname, '..');
  const store = new SqliteStore(path.join(f.project, '.solopreneur/project_growth.db'), extension); await store.init();
  const pending = queryGrowthReports(f.project, extension, {});
  setImmediate(() => f.report(2, { summary: '新结果', unmetRequirements: [] }));
  assert.equal((await pending).tasks[0].latestSummary, '新结果');
  store.writeGrowthSnapshot({ snapshot: { id: 'snapshot-1', projectPath: f.project, createdAt: new Date().toISOString(), gitHead: '', scanReason: 'test', status: 'completed', durationMs: 1, error: '' }, nodes: [], edges: [], signals: [], labels: [] });
  store.close();
  const page = await queryGrowthReports(f.project, extension, { taskId: f.taskId });
  assert.equal(page.turns.length, 2);
});

test('final serialized report script parses without interpreting report text as code', () => {
  const vm = require('node:vm');
  const { growthReportsScript } = require('../out/growthReportsWebview.js');
  const script = growthReportsScript('/project/</script><script>alert(1)</script>', true);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.ok(!script.includes('</script>'));
});

test('missing and invalid report receipts remain distinct without blocking checkpoints', async () => {
  const { recordTaskReport } = require('../out/taskReport.js');
  const { queryGrowthReports } = require('../out/growthReports.js');
  const f = fixture(); const status = { workspaceRoot: f.project, learningTaskId: f.taskId, executionLogId: 1, outputFilePath: path.join(f.runDir, 'output.log') };
  assert.equal(recordTaskReport(status, {}, 1).taskReportStatus, 'missing');
  const invalid = path.join(f.runDir, 'invalid.json'); fs.writeFileSync(invalid, '{');
  assert.equal(recordTaskReport(status, { 'report-file': invalid }, 2).taskReportStatus, 'invalid');
  const page = await queryGrowthReports(f.project, path.resolve(__dirname, '..'), { taskId: f.taskId });
  assert.deepEqual(page.turns.map(turn => turn.availability), ['invalid', 'missing']);
});

test('non-code reports paginate and module changes do not silently reassign historical work', async () => {
  const { queryGrowthReports } = require('../out/growthReports.js');
  const { SqliteStore } = require('../out/db/sqliteStore.js');
  const f = fixture(); fs.mkdirSync(path.join(f.project, 'src')); fs.writeFileSync(path.join(f.project, 'src/a.js'), 'a');
  f.report(1, { summary: '首轮', outputs: ['src/a.js'], unmetRequirements: ['待验收'] });
  const extension = path.resolve(__dirname, '..');
  const store = new SqliteStore(path.join(f.project, '.solopreneur/project_growth.db'), extension); await store.init();
  const snapshot = { snapshot: { id: 'mapping', projectPath: f.project, createdAt: new Date().toISOString(), gitHead: '', scanReason: 'test', status: 'completed', durationMs: 1, error: '' },
    nodes: [{ nodeId: 'file:src/a.js', kind: 'file', path: 'src/a.js', label: 'a', parentId: '', primaryRole: 'feature' }, { nodeId: 'module:a', kind: 'module', path: 'src', label: '模块 A', parentId: '', primaryRole: 'feature' }, { nodeId: 'capability:a', kind: 'capability', path: '', label: '导出', parentId: '', primaryRole: 'feature' }],
    edges: [{ sourceId: 'module:a', targetId: 'file:src/a.js', kind: 'contains', weight: 1, evidence: 'module-scan' }, { sourceId: 'module:a', targetId: 'capability:a', kind: 'implements', weight: 1, evidence: 'run_index:nodeId' }], signals: [], labels: [] };
  store.writeGrowthSnapshot(snapshot);
  assert.equal((await queryGrowthReports(f.project, extension, { moduleId: 'module:a' })).tasks.length, 1);
  assert.equal((await queryGrowthReports(f.project, extension, { capabilityId: 'capability:a' })).tasks.length, 1);
  snapshot.nodes[1].nodeId = 'module:b'; snapshot.edges[0].sourceId = 'module:b'; snapshot.edges[1].sourceId = 'module:b';
  store.writeGrowthSnapshot(snapshot); store.close();
  assert.equal((await queryGrowthReports(f.project, extension, { moduleId: 'module:b' })).tasks.length, 0);
  for (let id = 2; id <= 23; id++) {
    const runDir = path.join(f.project, '.solopreneur/agent-runs/__solo__', String(id)); fs.mkdirSync(runDir, { recursive: true });
    registerLearningTask(f.project, { executionLogId: id, runDir, userMessage: `讨论 ${id}`, startedAt: '2026-09-01' });
  }
  const first = await queryGrowthReports(f.project, extension, {});
  const second = await queryGrowthReports(f.project, extension, { offset: 20 });
  assert.equal(first.tasks.length, 20); assert.equal(second.tasks.length, 3);
  assert.equal(new Set([...first.tasks, ...second.tasks].map(task => task.taskId)).size, 23);
  assert.equal(first.total, 23);
});

test('interactive runs sharing one physical directory retain host-confirmed execution identities', async () => {
  const { queryGrowthReports } = require('../out/growthReports.js');
  const { SqliteStore } = require('../out/db/sqliteStore.js');
  const f = fixture(); f.report(1, { summary: '第一轮', unmetRequirements: ['待办'] });
  writeLearningJson(path.join(f.runDir, 'task-report-3.json'), { schemaVersion: 1, taskId: f.taskId, projectPath: f.project, executionLogId: 2, turnId: '3:complete', createdAt: '2026-09-03', report: { summary: '原会话第二轮', unmetRequirements: [] } });
  const extension = path.resolve(__dirname, '..');
  const journal = new SqliteStore(path.join(f.project, '.solopreneur/project_journal.db'), extension); await journal.init();
  journal.logExecution('__solo__', 'codex', '', 'Initial task', 'Completed');
  journal.logExecution('__solo__', 'codex', '', 'Agent continuation started.\nContinuation parent conversation: 1\n\nUser supplement:\n继续', 'Completed');
  journal.close();
  const page = await queryGrowthReports(f.project, extension, { taskId: f.taskId });
  assert.equal(page.turns.length, 2);
  assert.deepEqual(page.turns.map(turn => turn.availability), ['recorded', 'recorded']);
  assert.deepEqual(page.turns.map(turn => turn.executionLogId), [2, 1]);
  assert.deepEqual(page.turns.map(turn => turn.roundNumber), [2, 1]);
  assert.equal(page.tasks[0].latestSummary, '原会话第二轮');
  fs.writeFileSync(path.join(f.runDir, 'task-report-3.json'), '{');
  const partial = await queryGrowthReports(f.project, extension, { taskId: f.taskId });
  assert.equal(partial.turns.length, 2, 'a partial write cannot invent a turn for each execution');
  assert.equal(partial.turns[0].availability, 'invalid');
  assert.equal(partial.turns[0].report.summary, '原会话第二轮');
});
