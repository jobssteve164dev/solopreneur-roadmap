const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ledger = require('../out/learningLedger.js');
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-learning-review-'));

test('review retains legacy reports even when current intake limits are stricter', async () => {
  const { registerLearningTask, writeLearningJson } = require('../out/taskReport.js');
  const { collectReviewManifest } = require('../out/learningReview.js');
  const { queryGrowthReports } = require('../out/growthReports.js');
  const project = root(); const runDir = path.join(project, '.solopreneur/agent-runs/__solo__/1');
  const taskId = registerLearningTask(project, { executionLogId: 1, runDir, userMessage: '改进导出', startedAt: '2026-09-08' });
  const reports = [{ summary: '导出可按日期筛选。', verification: ['检查日志'.repeat(400)] }, { summary: '已补齐筛选测试。' }, { summary: '导出已改进。', commits: [{ repository: 'owner/repo', sha: 'a'.repeat(40), files: ['src/app.js'], note: '字'.repeat(501) }] }, { summary: '字'.repeat(120), verification: ['字'.repeat(380)], outputs: ['这是详细过程说明。'.repeat(40)] }];
  reports.forEach((report, index) => writeLearningJson(path.join(runDir, `task-report-${index + 1}.json`), { schemaVersion: 1, projectPath: project, taskId, executionLogId: 1, turnId: `${index + 1}:complete`, createdAt: '2026-09-08', report }));
  const manifest = await collectReviewManifest({ runId: 'bounded', globalRoot: path.join(project, '.global'), globalPrompt: '', projects: [project], repositoryForProject: async () => '' });
  assert.equal(manifest.sources.filter(s => s.kind === 'agent_report').length, 4);
  const page = await queryGrowthReports(project, path.resolve(__dirname, '..'), { taskId });
  assert.equal(page.turns.length, 4, 'archive remains readable in the growth view');
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'task-report-1.json'))).report.verification[0], reports[0].verification[0]);
});

test('global review indexes every memory and constraint layer with exact paths', async () => {
  const { collectReviewManifest } = require('../out/learningReview.js');
  const project = root(); const globalRoot = path.join(project, '.solomap-global');
  fs.mkdirSync(path.join(project, '.solopreneur/run-digests'), { recursive: true });
  fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(globalRoot, 'memory/entries'), { recursive: true });
  fs.mkdirSync(path.join(globalRoot, 'learning/ledger/sources'), { recursive: true });
  fs.mkdirSync(path.join(globalRoot, 'learning/candidate-decisions'), { recursive: true });
  fs.mkdirSync(path.join(globalRoot, 'context'), { recursive: true });
  fs.writeFileSync(path.join(project, 'agent.md'), '# Project rules\n');
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Repository rules\n');
  fs.writeFileSync(path.join(project, 'PROJECT_MEMORY.md'), '# Legacy project memory\n');
  fs.writeFileSync(path.join(project, 'docs/boundary.md'), '# Product boundary\n');
  fs.writeFileSync(path.join(project, '.solopreneur/documentation.json'), JSON.stringify({ schemaVersion: 1, documents: [{ path: 'docs/boundary.md', role: 'boundary', status: 'active', solves: 'product boundary' }] }));
  fs.writeFileSync(path.join(project, '.solopreneur/run-digests/run-1.json'), '{}');
  fs.writeFileSync(path.join(globalRoot, 'memory/profile.md'), '# Profile\n');
  fs.writeFileSync(path.join(globalRoot, 'memory/entries/mem-1.json'), '{}');
  fs.writeFileSync(path.join(globalRoot, 'learning/ledger/index.json'), '{}');
  fs.writeFileSync(path.join(globalRoot, 'learning/ledger/events.jsonl'), '{}\n');
  fs.writeFileSync(path.join(globalRoot, 'learning/ledger/sources/event-1.json'), '{}');
  fs.writeFileSync(path.join(globalRoot, 'learning/candidate-decisions/semantic-1.json'), JSON.stringify({ schemaVersion: 2, runId: 'older-review', id: 'source-1', hash: 'a'.repeat(64), decision: 'skipped', reason: 'already reviewed' }));
  fs.writeFileSync(path.join(globalRoot, 'context/global-default-prompt.md'), 'Global setting\n');
  fs.writeFileSync(path.join(project, 'global-root-placeholder'), '');
  fs.writeFileSync(path.join(project, 'agent-root.md'), '');
  const manifest = await collectReviewManifest({ runId: 'layers', globalRoot, globalPrompt: 'Global setting', projects: [project], repositoryForProject: async () => '' });
  const byKind = kind => manifest.sources.filter(source => source.kind === kind).map(source => source.file);
  for (const name of ['agent.md', 'AGENTS.md']) assert.ok(byKind('project_constraint').includes(path.join(project, name)), name);
  assert.ok(byKind('project_memory_legacy').includes(path.join(project, 'PROJECT_MEMORY.md')));
  assert.ok(byKind('project_document_index').includes(path.join(project, '.solopreneur/documentation.json')));
  assert.ok(byKind('project_document').includes(path.join(project, 'docs/boundary.md')));
  assert.ok(byKind('run_digest').includes(path.join(project, '.solopreneur/run-digests/run-1.json')));
  assert.ok(byKind('memory_entry').includes(path.join(globalRoot, 'memory/entries/mem-1.json')));
  assert.ok(byKind('learning_ledger').includes(path.join(globalRoot, 'learning/ledger/index.json')));
  assert.ok(byKind('learning_event_source').includes(path.join(globalRoot, 'learning/ledger/sources/event-1.json')));
  assert.ok(byKind('legacy_candidate-decisions').includes(path.join(globalRoot, 'learning/candidate-decisions/semantic-1.json')));
  assert.ok(byKind('global_prompt_mirror').includes(path.join(globalRoot, 'context/global-default-prompt.md')));
});

test('global review prompt names every path layer and its read or write role', () => {
  const { buildLearningReviewPrompt } = require('../out/learningReviewApply.js');
  const project = '/workspace/product'; const globalRoot = '/data/.solomap-global';
  const manifest = { schemaVersion: 1, runId: 'review-paths', globalRoot, globalPrompt: 'Keep intent.', promptHash: 'hash', projects: [project], memory: [], gaps: [], sources: [
    { kind: 'global_prompt_mirror', file: '/data/.solomap-global/context/global-default-prompt.md' }
  ] };
  const prompt = buildLearningReviewPrompt('/runs/manifest.json', manifest, '/runs/result.json');
  for (const expected of [
    '/data/.solomap-global/context/global-default-prompt.md', '/data/.solomap-global/memory/profile.md',
    '/data/.solomap-global/memory/operating-rules.md', '/data/.solomap-global/memory/projects', '/data/.solomap-global/memory/decisions',
    '/data/.solomap-global/memory/patterns', '/data/.solomap-global/memory/domains', '/data/.solomap-global/memory/inbox',
    '/data/.solomap-global/memory/active', '/data/.solomap-global/memory/entries', '/data/.solomap-global/learning/ledger',
    '/data/.solomap-global/learning/candidates', '/data/.solomap-global/learning/approved', '/data/.solomap-global/learning/rejected',
    '/data/.solomap-global/learning/promotion-suggestions', '/data/.solomap-global/learning/candidate-decisions',
    '/workspace/product/agent.md', '/workspace/product/AGENTS.md',
    '/workspace/product/PROJECT_MEMORY.md', '/workspace/product/.solopreneur/documentation.json', '/workspace/product/.solopreneur/run-digests',
    '/workspace/product/.solopreneur/agent-runs/learning-tasks', '项目 agent.md/AGENTS.md、PROJECT_MEMORY.md、正式文档',
    '/data/.solomap-global/tools/solomap-memory.cjs', '/data/.solomap-global/tools/solomap-experience.cjs',
    '形成或修订影响后续所有插件任务的稳定行为约束与分层经验'
  ]) assert.ok(prompt.includes(expected), expected);
});

test('normal event writes and reads do not generate semantic candidates or promotion suggestions', () => {
  const project = root(); const global = path.join(project, '.solomap-global');
  ledger.appendLearningEvent(project, global, { sourceType: 'user_correction', sourceRef: 'test', eventType: 'corrected', summary: '保持用户选择', evidenceRefs: [{ type: 'user', ref: 'message:1' }] });
  ledger.readLearningSummary(project, global);
  ledger.buildLearningRetrievalContext(project, global, { projectPath: project, contextText: '保持用户选择' });
  ledger.buildLearningPromotionContext(project, global);
  assert.deepEqual(fs.readdirSync(path.join(global, 'learning/candidates')), []);
  assert.deepEqual(fs.readdirSync(path.join(global, 'learning/candidate-decisions')), []);
  assert.deepEqual(fs.readdirSync(path.join(global, 'learning/promotion-suggestions')), []);
});

test('passive discovery finds task trailers without reports and reads exact failed checks', async () => {
  const file = path.resolve(__dirname, '../out/learningReview.js');
  assert.ok(fs.existsSync(file), 'manual review evidence collector must exist');
  const { collectGithubEvidence } = require(file);
  const project = root(); const sha = 'a'.repeat(40);
  const api = async endpoint => {
    if (endpoint.includes('/check-runs?')) return { total_count: 1, check_runs: [{ id: 1, head_sha: sha, name: 'login', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/owner/repo/actions/runs/1' }] };
    if (endpoint.includes('/status?')) return { sha, total_count: 0, statuses: [] };
    if (endpoint.includes('/commits?')) return [{ sha, commit: { message: 'fix: login\n\nSoloMap-Task: task-123' } }];
    if (endpoint.includes(`/commits/${sha}?`)) return { sha, commit: { message: 'fix: login\n\nSoloMap-Task: task-123' }, files: [{ filename: 'login.js', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new', changes: 2 }] };
    throw new Error('unexpected endpoint ' + endpoint);
  };
  const result = await collectGithubEvidence({ projectPath: project, repository: 'owner/repo', tasks: [{ taskId: 'task-123', startedAt: '2026-09-08T00:00:00Z' }], reports: [], api });
  assert.equal(result.commits.length, 1);
  assert.deepEqual(result.commits[0].taskIds, ['task-123']);
  assert.equal(result.commits[0].checks[0].conclusion, 'failure');
  assert.equal(result.commits[0].reportMissing, true);
});

test('manual review applies exact memory patch once and rejects stale or unreviewed proposals', async () => {
  const file = path.resolve(__dirname, '../out/learningReviewApply.js');
  assert.ok(fs.existsSync(file), 'validated review application must exist');
  const { applyLearningReview } = require(file);
  const { reviewHash } = require('../out/learningReview.js');
  const globalRoot = root(); const runDir = path.join(globalRoot, 'maintenance/runs/review-1');
  fs.mkdirSync(path.join(globalRoot, 'memory'), { recursive: true });
  const target = path.join(globalRoot, 'memory/operating-rules.md');
  fs.writeFileSync(target, '# Rules\nKeep user intent.\n');
  const manifest = { schemaVersion: 1, runId: 'review-1', globalRoot, globalPrompt: 'Keep intent.', promptHash: reviewHash('Keep intent.'), projects: [], sources: [{ id: 'source-1', kind: 'agent_report', hash: 'evidence', value: {} }], memory: [{ relativePath: 'operating-rules.md', hash: reviewHash(fs.readFileSync(target, 'utf8')), content: fs.readFileSync(target, 'utf8') }], gaps: [] };
  const proposal = { schemaVersion: 2, runId: 'review-1', manifestHash: reviewHash(JSON.stringify(manifest)), globalPrompt: null, memoryChanges: [{ path: 'operating-rules.md', baseHash: manifest.memory[0].hash, before: 'Keep user intent.', after: 'Keep user intent. Check actual outcomes.', reason: 'supported', evidence: ['source-1'] }], lessons: [], processedSources: [], unresolved: [] };
  const review = { schemaVersion: 1, runId: 'review-1', manifestHash: proposal.manifestHash, proposalHash: reviewHash(JSON.stringify(proposal)), verdict: 'pass', summary: 'checked evidence', checks: [{ target: 'overall', safe: true, reason: 'all reviewed', evidence: ['source-1'] }, { target: 'memory:0', safe: true, reason: 'preserves intent', evidence: ['source-1'] }] };
  const options = { manifest, proposal, review, runDir, getGlobalPrompt: () => 'Keep intent.', setGlobalPrompt: async () => { throw new Error('must not update unchanged setting'); } };
  const first = await applyLearningReview(options);
  assert.equal(first.status, 'applied');
  assert.equal(fs.readFileSync(target, 'utf8'), '# Rules\nKeep user intent. Check actual outcomes.\n');
  assert.equal((await applyLearningReview(options)).status, 'applied');
  assert.equal(fs.readFileSync(target, 'utf8').match(/Check actual outcomes/g).length, 1);
  const invalid = { ...proposal, memoryChanges: [{ ...proposal.memoryChanges[0], path: '../agent.md' }] };
  await assert.rejects(applyLearningReview({ ...options, proposal: invalid }), /review|proposal|target/i);
});

test('manual runner completes a no-change review through separate generation and verification', async () => {
  const file = path.resolve(__dirname, '../out/learningReviewRunner.js');
  assert.ok(fs.existsSync(file), 'manual entry runner must exist');
  const { runManualLearningReview } = require(file);
  const { reviewHash } = require('../out/learningReview.js');
  const globalRoot = root(); const runDir = path.join(globalRoot, 'maintenance/runs/global-prompt-review-test');
  let launches = 0;
  const result = await runManualLearningReview({ runDir, globalRoot, projects: [], globalPrompt: '', getGlobalPrompt: () => '', setGlobalPrompt: async () => { throw new Error('no changes'); }, launch: async (promptFile, resultFile) => {
    launches += 1;
    const generatedPrompt = fs.readFileSync(promptFile, 'utf8');
    if (launches === 1) {
      assert.ok(generatedPrompt.includes(path.join(globalRoot, 'memory/profile.md')));
      assert.ok(generatedPrompt.includes(path.join(globalRoot, 'learning/ledger')));
      assert.ok(generatedPrompt.includes('影响后续所有插件任务'));
    } else assert.ok(generatedPrompt.includes('项目记忆、项目约束、全局记忆与现有全局约束'));
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json')));
    const manifestHash = reviewHash(JSON.stringify(manifest));
    if (launches === 1) fs.writeFileSync(resultFile, JSON.stringify({ schemaVersion: 2, runId: manifest.runId, manifestHash, globalPrompt: null, memoryChanges: [], lessons: [], processedSources: [], unresolved: [] }));
    else {
      const proposal = JSON.parse(fs.readFileSync(path.join(runDir, 'proposal-1.json')));
      fs.writeFileSync(resultFile, JSON.stringify({ schemaVersion: 1, runId: manifest.runId, manifestHash, proposalHash: reviewHash(JSON.stringify(proposal)), verdict: 'pass', checks: [{ target: 'overall', safe: true, reason: 'No new evidence warrants changes.', evidence: [] }], summary: 'No changes' }));
    }
  } });
  assert.equal(launches, 2);
  assert.equal(result.status, 'applied');
});

test('interrupted generation resumes the same review without overwriting previous attempts', async () => {
  const { runManualLearningReview } = require('../out/learningReviewRunner.js');
  const { reviewHash } = require('../out/learningReview.js');
  const globalRoot = root(); const runDir = path.join(globalRoot, 'maintenance/runs/review-original');
  const input = { runDir, globalRoot, projects: [], globalPrompt: '', getGlobalPrompt: () => '', setGlobalPrompt: async () => assert.fail('no changes') };
  await assert.rejects(runManualLearningReview({ ...input, launch: async () => { throw new Error('interrupted'); } }), /interrupted/);
  const original = fs.readFileSync(path.join(runDir, 'prompt-1.txt'), 'utf8');
  const launchFiles = [];
  const result = await runManualLearningReview({ ...input, runDir: path.join(globalRoot, 'maintenance/runs/review-new-request'), launch: async (prompt, file) => {
    launchFiles.push(file);
    assert.equal(path.dirname(file), runDir);
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json')));
    const manifestHash = reviewHash(JSON.stringify(manifest));
    if (file.endsWith('proposal-2.json')) fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, runId: manifest.runId, manifestHash, globalPrompt: null, memoryChanges: [], lessons: [], processedSources: [], unresolved: ['未声称原任务全部验收'] }));
    else {
      assert.match(fs.readFileSync(prompt, 'utf8'), /明确保留在 unresolved 或 deferred/);
      const proposal = JSON.parse(fs.readFileSync(path.join(runDir, 'proposal-2.json')));
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, runId: manifest.runId, manifestHash, proposalHash: reviewHash(JSON.stringify(proposal)), verdict: 'pass', checks: [{ target: 'overall', safe: true, reason: 'No unsupported changes or conclusions.', evidence: [] }] }));
    }
  } });
  assert.equal(result.status, 'applied');
  assert.equal(launchFiles.length, 2);
  assert.equal(fs.readFileSync(path.join(runDir, 'prompt-1.txt'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(globalRoot, 'maintenance/runs/review-new-request')), false);
});

test('completed digest text does not count as a successful experience use', () => {
  const digest = require('../out/runDigest.js');
  const project = root();
  const value = digest.buildRunDigest({ workspaceRoot: project, nodeId: '1', runKind: 'solo', agentCli: 'codex', executionLogId: 1, userMessage: 'fix login', resolvedCommand: 'npm test', status: 'Completed', startedAt: '2026-09-08T00:00:00Z', finishedAt: '2026-09-08T00:01:00Z', durationMs: 60000, changedFilesSummary: 'M login.js', touchedFilesSummary: 'M login.js', outputTail: 'npm test passed', completionReason: 'done', failureCode: '', failureReason: '' });
  digest.writeRunDigest(project, value);
  const graph = JSON.parse(fs.readFileSync(path.join(project, '.solopreneur/execution-graph.json')));
  for (const node of Object.values(graph.experienceNodes)) {
    assert.equal(node.stats.uses, 0);
    assert.equal(node.stats.wins, 0);
  }
});

test('GitHub pagination failure preserves progress and a later manual call resumes it', async () => {
  const { collectGithubEvidence } = require('../out/learningReview.js');
  const project = root(); const sha = 'b'.repeat(40); const calls = [];
  const tasks = [{ taskId: 'task-123', startedAt: '2026-09-08T00:00:00Z' }];
  const firstApi = async endpoint => {
    calls.push(endpoint);
    if (/[?&]page=1(?:&|$)/.test(endpoint)) return Array.from({ length: 100 }, (_, i) => ({ sha: i === 0 ? sha : i.toString(16).padStart(40, '0'), commit: { message: 'unrelated' } }));
    throw new Error('network unavailable');
  };
  const first = await collectGithubEvidence({ projectPath: project, repository: 'owner/repo', tasks, reports: [], api: firstApi });
  assert.equal(first.gaps.includes('network unavailable'), true);
  const secondCalls = [];
  await collectGithubEvidence({ projectPath: project, repository: 'owner/repo', tasks, reports: [], api: async endpoint => { secondCalls.push(endpoint); return []; } });
  assert.match(secondCalls[0], /page=2/);
  assert.match(secondCalls[0], new RegExp('sha=' + sha));
});

test('report registration preserves explicit task lineage across CLI runs and separates new Solo tasks', () => {
  const { registerLearningTask } = require('../out/taskReport.js');
  const project = root();
  const first = registerLearningTask(project, { executionLogId: 1, runDir: path.join(project, 'run1'), userMessage: 'fix', startedAt: '2026-09-08' });
  const second = registerLearningTask(project, { executionLogId: 2, parentExecutionLogId: 1, runDir: path.join(project, 'run2'), userMessage: 'continue', startedAt: '2026-09-09' });
  const unrelated = registerLearningTask(project, { executionLogId: 3, runDir: path.join(project, 'run3'), userMessage: 'new', startedAt: '2026-09-09' });
  assert.equal(first, second);
  assert.notEqual(first, unrelated);
});

test('generated review shell waits for the command and records its real exit status', () => {
  const cp = require('node:child_process');
  const { buildLearningReviewRunScript } = require('../out/learningReviewRunner.js');
  const project = root(); const done = path.join(project, 'done.json');
  const script = path.join(project, 'run.sh');
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(script, buildLearningReviewRunScript("printf 'finished'; exit 7", project, path.join(project, 'output.log'), done, quote));
  const syntax = cp.spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  cp.spawnSync('bash', [script], { encoding: 'utf8' });
  assert.ok(fs.existsSync(done), 'pipeline must not skip the completion marker');
  assert.equal(JSON.parse(fs.readFileSync(done)).exitCode, 7);
  assert.equal(fs.readFileSync(path.join(project, 'output.log'), 'utf8'), 'finished');
});

function applicationFixture() {
  const { reviewHash } = require('../out/learningReview.js');
  const globalRoot = path.join(root(), '.solomap-global'); fs.mkdirSync(globalRoot); const project = path.join(globalRoot, 'app'); fs.mkdirSync(project);
  const runDir = path.join(globalRoot, 'maintenance/runs/review-test'); fs.mkdirSync(runDir, { recursive: true });
  const content = '# Rules\nKeep intent.\n'; fs.mkdirSync(path.join(globalRoot, 'memory')); fs.writeFileSync(path.join(globalRoot, 'memory/operating-rules.md'), content);
  const manifest = { schemaVersion: 1, runId: 'review-test', globalRoot, globalPrompt: 'Keep intent.', promptHash: reviewHash('Keep intent.'), projects: [project], sources: [{ id: 'evidence-1', kind: 'agent_report', projectPath: project, hash: 'source-hash', value: {} }], memory: [{ relativePath: 'operating-rules.md', hash: reviewHash(content), content }], gaps: [] };
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest));
  const proposal = { schemaVersion: 2, runId: manifest.runId, manifestHash: reviewHash(JSON.stringify(manifest)), globalPrompt: { value: 'Keep intent. Verify outcomes.', reason: 'verified', evidence: ['evidence-1'], constraints: [{ hash: reviewHash('Keep intent.'), disposition: 'preserved', reason: 'kept' }] }, memoryChanges: [{ path: 'operating-rules.md', baseHash: reviewHash(content), before: 'Keep intent.', after: 'Keep intent. Verify outcomes.', evidence: ['evidence-1'], reason: 'verified' }], lessons: [], processedSources: [], unresolved: [] };
  const makeReview = () => ({ schemaVersion: 1, runId: manifest.runId, manifestHash: proposal.manifestHash, proposalHash: reviewHash(JSON.stringify(proposal)), verdict: 'pass', summary: 'checked', checks: ['overall', 'globalPrompt', 'memory:0', 'lesson:0'].map(target => ({ target, safe: true, reason: 'verified source', evidence: ['evidence-1'] })) });
  return { manifest, proposal, runDir, makeReview, project, globalRoot };
}

test('partial application retries remaining settings without appending memory twice', async () => {
  const { applyLearningReview } = require('../out/learningReviewApply.js');
  const f = applicationFixture(); let prompt = 'Keep intent.'; let fail = true;
  const options = { ...f, review: f.makeReview(), getGlobalPrompt: () => prompt, setGlobalPrompt: async value => { if (fail) throw new Error('disk unavailable'); prompt = value; } };
  assert.equal((await applyLearningReview(options)).status, 'partial');
  fail = false;
  assert.equal((await applyLearningReview(options)).status, 'applied');
  assert.equal(fs.readFileSync(path.join(f.globalRoot, 'memory/operating-rules.md'), 'utf8').match(/Verify outcomes/g).length, 1);
});

test('stale prompt, path traversal and symlink targets cause zero application writes', async () => {
  const { applyLearningReview } = require('../out/learningReviewApply.js');
  for (const mode of ['stale', 'traversal', 'symlink']) {
    const f = applicationFixture(); let writes = 0;
    if (mode === 'traversal') f.proposal.memoryChanges[0].path = '../agent.md';
    if (mode === 'symlink') {
      fs.mkdirSync(path.join(f.globalRoot, 'outside'));
      fs.symlinkSync(path.join(f.globalRoot, 'outside'), path.join(f.globalRoot, 'memory/patterns'));
      f.proposal.memoryChanges[0] = { ...f.proposal.memoryChanges[0], path: 'patterns/rule.md', before: '', baseHash: require('../out/learningReview.js').reviewHash('') };
    }
    await assert.rejects(applyLearningReview({ ...f, review: f.makeReview(), getGlobalPrompt: () => mode === 'stale' ? 'New user instructions.' : 'Keep intent.', setGlobalPrompt: async () => { writes += 1; } }));
    assert.equal(writes, 0);
    assert.equal(fs.readFileSync(path.join(f.globalRoot, 'memory/operating-rules.md'), 'utf8'), '# Rules\nKeep intent.\n');
  }
});

test('promoted semantic lesson is retrievable with identity and evidence, rejected revision disappears', async () => {
  const { applyLearningReview } = require('../out/learningReviewApply.js');
  const f = applicationFixture(); let prompt = 'Keep intent.';
  f.proposal.lessons = [{ projectPath: f.project, summary: 'Verify login outcomes', appliesWhen: 'Changing login', doesNotApplyWhen: 'No login behavior change', doThis: 'Run login regression', avoidThis: 'Claim success from exit code', verification: 'Observe login response', reason: 'Evidence supports it', evidence: ['evidence-1'], status: 'promoted', target: 'operating-rules.md' }];
  assert.equal((await applyLearningReview({ ...f, review: f.makeReview(), getGlobalPrompt: () => prompt, setGlobalPrompt: async value => { prompt = value; } })).status, 'applied');
  const retrieval = ledger.buildLearningRetrievalContext(f.project, f.globalRoot, { projectPath: f.project, contextText: 'login' });
  assert.match(retrieval, /Verify login outcomes/);
  const candidates = path.join(f.globalRoot, 'learning/candidates');
  const file = path.join(candidates, fs.readdirSync(candidates)[0]); const candidate = JSON.parse(fs.readFileSync(file));
  assert.match(candidate.evidenceRefs[0].ref, /^maintenance\/runs\//);
  candidate.status = 'rejected'; fs.writeFileSync(file, JSON.stringify(candidate));
  assert.equal(ledger.buildLearningRetrievalContext(f.project, f.globalRoot, { projectPath: f.project, contextText: 'login' }), '');
});

test('subsequent manual click resumes a partial application before starting another Agent', async () => {
  const { applyLearningReview } = require('../out/learningReviewApply.js');
  const { runManualLearningReview } = require('../out/learningReviewRunner.js');
  const f = applicationFixture(); const review = f.makeReview();
  fs.writeFileSync(path.join(f.runDir, 'proposal-1.json'), JSON.stringify(f.proposal));
  fs.writeFileSync(path.join(f.runDir, 'review-1.json'), JSON.stringify(review));
  fs.writeFileSync(path.join(f.runDir, 'result.json'), JSON.stringify({ proposalFile: path.join(f.runDir, 'proposal-1.json'), checkFile: path.join(f.runDir, 'review-1.json') }));
  await applyLearningReview({ ...f, review, getGlobalPrompt: () => 'Keep intent.', setGlobalPrompt: async () => { throw new Error('temporary failure'); } });
  let prompt = 'Keep intent.'; let launches = 0;
  const result = await runManualLearningReview({ runDir: path.join(path.dirname(f.runDir), 'next-review'), globalRoot: f.globalRoot, projects: [f.project], globalPrompt: prompt, getGlobalPrompt: () => prompt, setGlobalPrompt: async value => { prompt = value; }, launch: async () => { launches += 1; throw new Error('should resume saved proposal'); } });
  assert.equal(result.status, 'applied');
  assert.equal(launches, 0);
  assert.equal(prompt, 'Keep intent. Verify outcomes.');
});

test('review keeps the current editor draft separate from persisted instruction concurrency checks', async () => {
  const { runManualLearningReview } = require('../out/learningReviewRunner.js');
  const { reviewHash } = require('../out/learningReview.js');
  const globalRoot = root(); const runDir = path.join(globalRoot, 'maintenance/runs/draft');
  const result = await runManualLearningReview({ runDir, globalRoot, projects: [], globalPrompt: 'Unsaved user instruction', persistedGlobalPrompt: 'Saved instruction', getGlobalPrompt: () => 'Saved instruction', setGlobalPrompt: async () => { throw new Error('no change proposal must preserve draft without saving'); }, launch: async (_prompt, resultFile) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json')));
    assert.equal(manifest.globalPrompt, 'Unsaved user instruction');
    const manifestHash = reviewHash(JSON.stringify(manifest));
    if (path.basename(resultFile).startsWith('proposal')) fs.writeFileSync(resultFile, JSON.stringify({ schemaVersion: 2, runId: manifest.runId, manifestHash, globalPrompt: null, memoryChanges: [], lessons: [], processedSources: [], unresolved: [] }));
    else {
      const proposal = JSON.parse(fs.readFileSync(path.join(runDir, 'proposal-1.json')));
      fs.writeFileSync(resultFile, JSON.stringify({ schemaVersion: 1, runId: manifest.runId, manifestHash, proposalHash: reviewHash(JSON.stringify(proposal)), verdict: 'pass', summary: 'No changes', checks: [{ target: 'overall', safe: true, reason: 'Retains draft', evidence: [] }] }));
    }
  } });
  assert.equal(result.status, 'applied');
});

test('memory patches preserve literal dollar replacement syntax', async () => {
  const { applyLearningReview } = require('../out/learningReviewApply.js');
  const f = applicationFixture(); f.proposal.globalPrompt = null;
  f.proposal.memoryChanges[0].after = 'Literal $& and $$ must stay unchanged.';
  await applyLearningReview({ ...f, review: f.makeReview(), getGlobalPrompt: () => 'Keep intent.', setGlobalPrompt: async () => {} });
  assert.equal(fs.readFileSync(path.join(f.globalRoot, 'memory/operating-rules.md'), 'utf8'), '# Rules\nLiteral $& and $$ must stay unchanged.\n');
});

test('an interrupted application recovers a completed file write from its write-ahead journal', async () => {
  const { applyLearningReview } = require('../out/learningReviewApply.js');
  const { reviewHash } = require('../out/learningReview.js');
  const f = applicationFixture(); f.proposal.globalPrompt = null;
  const after = '# Rules\nKeep intent. Verify outcomes.\n';
  fs.writeFileSync(path.join(f.globalRoot, 'memory/operating-rules.md'), after);
  fs.writeFileSync(path.join(f.runDir, 'application.json'), JSON.stringify({ proposalHash: reviewHash(JSON.stringify(f.proposal)), status: 'applying', items: {}, pending: { 'memory:operating-rules.md': reviewHash(after) }, errors: [] }));
  assert.equal((await applyLearningReview({ ...f, review: f.makeReview(), getGlobalPrompt: () => 'Keep intent.', setGlobalPrompt: async () => {} })).status, 'applied');
  assert.equal(fs.readFileSync(path.join(f.globalRoot, 'memory/operating-rules.md'), 'utf8'), after);
});

test('existing lesson targets are version checked even when evidence only cites a new report', async () => {
  const { applyLearningReview } = require('../out/learningReviewApply.js'); const { reviewHash } = require('../out/learningReview.js');
  const f = applicationFixture(); f.proposal.globalPrompt = null; f.proposal.memoryChanges = [];
  const file = path.join(f.globalRoot, 'learning/candidates/lesson-abcd.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = JSON.stringify({ id: 'lesson-abcd', projectPath: f.project, summary: 'Old' }); fs.writeFileSync(file, before);
  f.manifest.sources.push({ id: 'old-lesson', kind: 'legacy_candidates', file, hash: reviewHash(before), projectPath: f.project });
  f.proposal.manifestHash = reviewHash(JSON.stringify(f.manifest));
  f.proposal.lessons = [{ id: 'lesson-abcd', projectPath: f.project, summary: 'Review result', appliesWhen: 'Login changes', doesNotApplyWhen: 'Other tasks', doThis: 'Test login', avoidThis: 'Guess', verification: 'Login test', reason: 'New evidence', evidence: ['evidence-1'], status: 'candidate' }];
  fs.writeFileSync(file, JSON.stringify({ id: 'lesson-abcd', projectPath: f.project, summary: 'New external edit' }));
  await assert.rejects(applyLearningReview({ ...f, review: f.makeReview(), getGlobalPrompt: () => 'Keep intent.', setGlobalPrompt: async () => {} }), /lesson.*changed/i);
  assert.equal(JSON.parse(fs.readFileSync(file)).summary, 'New external edit');
});

test('a newer editor draft supersedes an old partial review instead of applying its prompt', async () => {
  const { applyLearningReview } = require('../out/learningReviewApply.js'); const { runManualLearningReview } = require('../out/learningReviewRunner.js');
  const f = applicationFixture(); const review = f.makeReview();
  fs.writeFileSync(path.join(f.runDir, 'proposal-1.json'), JSON.stringify(f.proposal));
  fs.writeFileSync(path.join(f.runDir, 'review-1.json'), JSON.stringify(review));
  fs.writeFileSync(path.join(f.runDir, 'result.json'), JSON.stringify({ proposalFile: path.join(f.runDir, 'proposal-1.json'), checkFile: path.join(f.runDir, 'review-1.json') }));
  await applyLearningReview({ ...f, review, getGlobalPrompt: () => 'Keep intent.', setGlobalPrompt: async () => { throw new Error('unavailable'); } });
  let writes = 0;
  await assert.rejects(runManualLearningReview({ runDir: path.join(path.dirname(f.runDir), 'new-draft'), globalRoot: f.globalRoot, projects: [f.project], globalPrompt: 'New user draft', persistedGlobalPrompt: 'Keep intent.', getGlobalPrompt: () => 'Keep intent.', setGlobalPrompt: async () => { writes++; }, launch: async () => { throw new Error('fresh generation requested'); } }), /fresh generation/);
  assert.equal(writes, 0);
});

test('resuming an applied lesson verifies full content, including edits that retain review metadata', async () => {
  const { applyLearningReview } = require('../out/learningReviewApply.js'); const f = applicationFixture();
  f.proposal.lessons = [{ projectPath: f.project, summary: 'Verify login', appliesWhen: 'Login changes', doesNotApplyWhen: 'Other tasks', doThis: 'Test login', avoidThis: 'Guess', verification: 'Login test', reason: 'Evidence', evidence: ['evidence-1'], status: 'candidate' }];
  const review = f.makeReview();
  const options = { ...f, review, getGlobalPrompt: () => 'Keep intent.', setGlobalPrompt: async () => { throw new Error('temporary failure'); } };
  assert.equal((await applyLearningReview(options)).status, 'partial');
  const dir = path.join(f.globalRoot, 'learning/candidates'); const file = path.join(dir, fs.readdirSync(dir)[0]);
  const value = JSON.parse(fs.readFileSync(file)); value.summary = 'User correction after partial apply'; fs.writeFileSync(file, JSON.stringify(value));
  await assert.rejects(applyLearningReview(options), /Applied lesson changed/);
});

test('review completion uses the terminal Node runtime when the extension host is Electron', () => {
  const cp = require('node:child_process'); const { buildLearningReviewRunScript } = require('../out/learningReviewRunner.js');
  const project = root(); const script = path.join(project, 'electron-run.sh'); const done = path.join(project, 'done.json');
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  const original = process.execPath;
  try { process.execPath = '/not-a-node-runtime/Code Helper'; fs.writeFileSync(script, buildLearningReviewRunScript('exit 0', project, path.join(project, 'out.log'), done, quote)); }
  finally { process.execPath = original; }
  const result = cp.spawnSync('bash', [script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(done), 'Electron host path must not prevent terminal completion');
});

test('interrupting a review command leaves a terminal completion marker', async () => {
  const cp = require('node:child_process'); const { buildLearningReviewRunScript } = require('../out/learningReviewRunner.js');
  const project = root(); const script = path.join(project, 'interrupt.sh'); const done = path.join(project, 'done.json');
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(script, buildLearningReviewRunScript('node -e ' + quote('console.log("READY");setInterval(()=>{},1000)'), project, path.join(project, 'out.log'), done, quote));
  const child = cp.spawn('bash', [script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let interrupted = false;
  child.stdout.on('data', bytes => { if (!interrupted && bytes.toString().includes('READY')) { interrupted = true; process.kill(-child.pid, 'SIGINT'); } });
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(interrupted, true);
  assert.ok(fs.existsSync(done), 'Ctrl+C must release the review even when the terminal stays open');
  assert.equal(JSON.parse(fs.readFileSync(done)).exitCode, 130);
});
