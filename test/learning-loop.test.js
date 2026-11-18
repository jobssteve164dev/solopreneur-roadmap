const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations, runtimeMcpSource } = require('./runtime-data-fixture.cjs');
const { getAgentRunDeliveryOwner } = require('../out/agentRunPreparation.js');
const { refreshProjectRegistry } = require('../out/projectRegistry.js');
const runtime = require('../out/autonomousRuntime.js');
const { readTodayReviewFromDatabase } = require('../out/dailyReview.js');
const { buildProjectPortfolioSummary } = require('../out/projectPortfolio.js');
const { createGlobalEngineeringSnapshotPlaceholder } = require('../out/globalEngineeringStore.js');
const { isTrashOrLocalPrivate } = require('../out/learningQuality.js');

async function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-learning-loop-'));
  fs.mkdirSync(path.join(base, '.git'));
  const project = path.join(base, 'project'); fs.mkdirSync(project);
  fs.mkdirSync(path.join(project, '.git'));
  const root = path.join(base, '.solomap-global');
  const readSecret = require('node:crypto').randomBytes(32).toString('hex');
  let store = new UnifiedDataStore(root), ops = createRuntimeDataOperations(store, undefined, readSecret);
  t.after(async () => { await ops.close(); store.close(); });
  const call = (operation, input = {}) => ops({ operation, input });
  await refreshProjectRegistry(root, () => ({ legacyProjects: [{ name: 'Project', path: project, priority: 'P1' }], legacyHiddenProjects: [] }), call);
  const registered = await call('register_project', { root: project });
  const projects = [{ name: 'Project', path: project, priority: 'P1' }];
  fs.mkdirSync(path.join(project, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(project, '.solopreneur', 'roadmap.csv'), 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,Verify the final package,,Build,,,,Pending,,\n');
  await call('accept_roadmap_csv', { root: project });
  assert.ok(fs.realpathSync(root).startsWith(fs.realpathSync(base) + path.sep));
  return { base, root, project, projects, readSecret, projectId: registered.projectId, call, request: request => ops(request), get store() { return store; },
    async restart() { await ops.close(); store.close(); store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store, undefined, readSecret); } };
}

test('schema 74 invalidates populated legacy sidebar summaries once while retaining their local cache', t => {
  const { DiskDatabase } = require('../out/db/diskDatabase.js');
  const { unifiedSchemaSql } = require('../out/db/unifiedSchema.js');
  const { unifiedSchemaMigrations } = require('../out/db/unifiedSchemaMigrations.js');
  const crypto = require('node:crypto');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-learning-upgrade-'));
  const root = path.join(base, '.solomap-global');
  const db = new DiskDatabase(path.join(root, 'solomap.db'), { foreignKeys: false });
  const hash = text => crypto.createHash('sha256').update(text).digest('hex');
  try {
    const schema = unifiedSchemaSql(); db.run(schema);
    db.run('INSERT INTO schema_migrations VALUES(1,?,?)', [hash(schema), Date.now()]);
    db.run('INSERT INTO database_meta VALUES(?,?)', ['database_id', crypto.randomUUID()]);
    db.run('INSERT INTO database_meta VALUES(?,?)', ['protocol_version', '1']);
    for (const migration of unifiedSchemaMigrations.filter(item => item.version <= 73)) {
      db.run(migration.sql);
      db.run('INSERT INTO schema_migrations VALUES(?,?,?)', [migration.version, hash(migration.sql), Date.now()]);
    }
    db.run("INSERT INTO objects VALUES('retained-project','project',NULL,1,1,1,NULL)");
    db.run("INSERT INTO projects(id,name) VALUES('retained-project','Retained')");
    db.run("UPDATE sidebar_core_projection_state SET source_revision=10,projection_revision=10,projection_json=? WHERE project_id='retained-project'", [JSON.stringify({ marker: 'retained-local-summary' })]);
  } finally { db.close(); }
  let store = new UnifiedDataStore(root);
  t.after(() => store.close());
  const upgraded = store.rows("SELECT source_revision,projection_revision,projection_json FROM sidebar_core_projection_state WHERE project_id='retained-project'")[0];
  assert.equal(upgraded.source_revision, 11);
  assert.equal(upgraded.projection_revision, 10);
  assert.deepEqual(JSON.parse(upgraded.projection_json), { marker: 'retained-local-summary' });
  const analysis = store.rows("SELECT run_index_revision FROM project_analysis_sources WHERE project_id='retained-project'")[0];
  const legacyStrategyRevision = hash(JSON.stringify([store.readLearningSourceRevision(), [['retained-project', null, Number(analysis?.run_index_revision || 0)]]]));
  assert.notEqual(store.readStrategySourceRevision(['retained-project']), legacyStrategyRevision, 'the earlier candidate-count semantics must not authorize a cached strategy snapshot after upgrading');
  store.close(); store = new UnifiedDataStore(root);
  assert.equal(store.rows("SELECT source_revision FROM sidebar_core_projection_state WHERE project_id='retained-project'")[0].source_revision, 11);
});

test('a freshly generated database Today decision is current and unchanged persistence adds no history', async t => {
  const f = await fixture(t);
  const decision = await runtime.runShadowDecisionCycleFromDatabase({ globalDataPath: f.root, projects: f.projects, operation: f.request });
  await runtime.persistShadowRuntimeState(f.root, f.request);
  const review = await readTodayReviewFromDatabase(f.root, f.projects, f.request);
  assert.equal(review.stale, undefined, 'producer and reader must agree on the exact same unchanged database input');
  assert.equal(review.decisionId, decision.decisionId);
  const before = f.store.rows('SELECT count(*) AS n FROM object_revisions')[0].n;
  await runtime.persistShadowRuntimeState(f.root, f.request);
  assert.equal(f.store.rows('SELECT count(*) AS n FROM object_revisions')[0].n, before);
});

test('historical evidence locations do not discard useful experience or corrupt candidate and blocked counts', async t => {
  const f = await fixture(t);
  const lesson = { summary: 'Verify the final executable', appliesWhen: 'Releasing a package', doThis: 'Install the package and execute the user entry', avoidThis: 'Only checking source syntax', evidenceRefs: [{ type: 'file', ref: '.solopreneur/agent-runs/__solo__/1/output.log' }], promotionTarget: 'pattern' };
  assert.equal(isTrashOrLocalPrivate(lesson), false);
  f.store.write({ kind: 'lesson', action: 'create', scope: f.projectId, idempotencyKey: 'valid-candidate', data: { status: 'candidate', summary: lesson.summary, applies_when: lesson.appliesWhen, do_this: lesson.doThis, avoid_this: lesson.avoidThis, evidence_refs_json: lesson.evidenceRefs, promotion_target: 'pattern' } });
  f.store.write({ kind: 'lesson', action: 'create', scope: f.projectId, idempotencyKey: 'valid-approved', data: { status: 'approved', summary: 'Keep the selected project', applies_when: 'Refreshing the sidebar', do_this: 'Retain selection', avoid_this: 'Reset selection' } });
  const overview = await f.call('read_learning_overview');
  assert.equal(overview.candidateCount, 1);
  assert.equal(overview.projectSignals.find(s => s.projectId === f.projectId).candidateCount, 1, 'approved experience is not a pending candidate');
  const nodes = [{ id: '1', title: 'Build package', status: 'Pending', stage: 'Build', dependencies: '' }, { id: '2', title: 'Publish package', status: 'Pending', stage: 'Build', dependencies: '1' }];
  const portfolio = buildProjectPortfolioSummary(f.projects[0], { roadmapNodesByProjectPath: new Map([[f.project, nodes]]), learningOverview: overview });
  const snapshot = createGlobalEngineeringSnapshotPlaceholder(f.root, [portfolio]);
  assert.equal(snapshot.learningCandidateCount, 1);
  assert.equal(snapshot.dependencies.length, 1);
  assert.match(snapshot.dependencies[0].reason, /Build package/);
  assert.equal(createGlobalEngineeringSnapshotPlaceholder(f.root, [{ ...portfolio, learningCandidateCount: undefined }]).learningCandidateCount, null);
});

test('Today receives approved content and exact outcomes before planning and invalidates when that experience changes', async t => {
  const f = await fixture(t);
  const lesson = f.store.write({ kind: 'lesson', action: 'create', scope: f.projectId, idempotencyKey: 'planning-lesson', data: { status: 'approved', summary: 'Check final package first', applies_when: 'Verify the final package', do_this: 'Install the final package before publishing', avoid_this: 'Relying only on source compilation', lesson_type: 'planning_rule', verification: 'Previous package installation caught a missing entry' } });
  let count = 0;
  const engine = { id: 'isolated-planner', async plan(input) { count++; assert.ok(input.candidates[0].learning.some(item => item.objectId === lesson.objectId && item.doThis === 'Install the final package before publishing')); return { candidateId: input.candidates[0].id, reason: '先验证最终安装包。' }; } };
  const first = await runtime.runCognitiveShadowDecisionCycle({ globalDataPath: f.root, projects: f.projects, operation: f.request, engine });
  await runtime.runCognitiveShadowDecisionCycle({ globalDataPath: f.root, projects: f.projects, operation: f.request, engine, currentDecision: first });
  assert.equal(count, 1);
  f.store.write({ kind: 'lesson', action: 'patch', scope: f.projectId, objectId: lesson.objectId, expectedRevision: lesson.revision, idempotencyKey: 'revoke-planning-lesson', data: { status: 'revoked' } });
  const second = await runtime.runCognitiveShadowDecisionCycle({ globalDataPath: f.root, projects: f.projects, operation: f.request, currentDecision: first, engine: { id: engine.id, async plan(input) { count++; assert.deepEqual(input.candidates[0].learning, []); return { candidateId: input.candidates[0].id, reason: '按当前任务推进。' }; } } });
  assert.equal(count, 2);
  assert.notEqual(first.sourceRevision, second.sourceRevision);
});

test('late Today feedback keeps the original decision and cannot change the current recommendation', async t => {
  const f = await fixture(t);
  const first = await runtime.runShadowDecisionCycleFromDatabase({ globalDataPath: f.root, projects: f.projects, operation: f.request });
  await runtime.persistShadowRuntimeState(f.root, f.request);
  const roadmap = await f.call('read_roadmap', { root: f.project });
  await f.call('update_roadmap', { root: f.project, expectedRevision: roadmap.revision, nodes: roadmap.nodes.map(n => ({ ...n, title: 'Next package action' })), idempotencyKey: 'new-today-input' });
  const second = await runtime.runShadowDecisionCycleFromDatabase({ globalDataPath: f.root, projects: f.projects, operation: f.request });
  await runtime.persistShadowRuntimeState(f.root, f.request);
  await runtime.recordShadowDecisionFeedback(f.root, { operationId: 'late-selection', decisionId: first.decisionId, recommendedProjectPath: f.project, selectedProjectPath: f.project, outcome: 'accepted', recordedAt: new Date().toISOString() }, f.request);
  assert.equal((await readTodayReviewFromDatabase(f.root, f.projects, f.request)).decisionId, second.decisionId);
  assert.equal(runtime.readShadowDecisionFeedbackOutcome(f.root, first.decisionId), 'accepted');
  const learning = f.store.rows("SELECT source_object_id,source_revision FROM learning_events WHERE source_type='today_feedback'");
  assert.equal(learning.length, 1, 'the actual choice must become scoped evidence for the next manual review');
  assert.ok(f.store.read(String(learning[0].source_object_id), Number(learning[0].source_revision)));
});

test('dependency cycles never become executable Today actions', () => {
  const project = { name: 'Cycle', path: '/isolated/cycle' };
  const nodes = [{ id: '1', title: 'First', status: 'Pending', dependencies: '2' }, { id: '2', title: 'Second', status: 'Pending', dependencies: '1' }];
  const portfolio = buildProjectPortfolioSummary(project, { roadmapNodesByProjectPath: new Map([[project.path, nodes]]), coreOnly: true });
  assert.equal(portfolio.recommendedNodeId, '');
  assert.equal(portfolio.blockedNodes, 2);
  assert.ok(portfolio.blocker);
  const failed = buildProjectPortfolioSummary(project, { roadmapNodesByProjectPath: new Map([[project.path, [{ id: '3', title: 'Retry failed action', status: 'Failed' }]]]), coreOnly: true });
  assert.equal(createGlobalEngineeringSnapshotPlaceholder('/isolated/.solomap-global', [failed]).dependencies.length, 0, 'a failed action without dependencies is recoverable rather than dependency-blocked');
});

async function adoptedRun(f, { id, lesson, recall = true, verify = false, assessmentTurn, assessmentResult = 'pass', reportedEvidence = ['package-entry-check'], afterRecall, eventType = 'completed', prompt = 'Verify the final executable.' } = {}) {
  const run = await f.call('prepare_run', { root: f.project, executionLogId: id, nodeId: '__solo__', runKind: 'solo', prompt, command: 'isolated-cli', userMessage: 'Verify package', metadata: { interactiveSession: true }, idempotencyKey: `prepare:${id}` });
  if (recall) {
    const reader = UnifiedDataStore.openReadOnly(f.root, f.store.databaseId);
    const readerOps = createRuntimeDataOperations(reader, undefined, f.readSecret);
    const source = runtimeMcpSource(f.root, f.projectId, true, { executionLogId: id, generation: run.generation, proof: run.proof }, undefined,
      request => request.readAuthority && ['read', 'context'].includes(request.operation) ? readerOps(request) : f.request(request));
    try {
      const first = await source.call('context', { project: f.projectId, kinds: ['lesson'], terms: ['executable'] });
      assert.ok(first.items.some(item => item.objectId === lesson.objectId));
      assert.equal('__solomapLearningDelivery' in first, false, 'transport credentials must not enter the Agent response');
      assert.equal(f.store.rows("SELECT count(*) AS n FROM evidence WHERE type='host_learning_delivery' AND run_id=?", [run.runId])[0].n, 1);
      const before = f.store.rows('SELECT count(*) AS n FROM object_revisions')[0].n;
      const walBefore = fs.statSync(path.join(f.root, 'solomap.db-wal')).size;
      await source.call('context', { project: f.projectId, kinds: ['lesson'], terms: ['executable'] });
      assert.equal(f.store.rows('SELECT count(*) AS n FROM object_revisions')[0].n, before, 'repeated delivery is zero-growth');
      assert.equal(fs.statSync(path.join(f.root, 'solomap.db-wal')).size, walBefore, 'unchanged delivery must not grow physical WAL');
    } finally { await source.close(); await readerOps.close(); reader.close(); }
  }
  if (afterRecall) await afterRecall(run);
  const action = 'Install and execute the final package';
  const report = { schemaVersion: 1, summary: 'Verified final package.', unmetRequirements: [], decisions: [], corrections: [], verification: [], commits: [], lessons: [], experienceUsage: [{ experienceId: lesson.objectId, experienceRevision: lesson.revision, action, result: 'The installed executable starts.', verdict: 'effective', evidence: reportedEvidence }] };
  let state = await f.call('read_run_state', { projectId: f.projectId, executionLogId: id });
  state = await f.call('checkpoint_run', { projectId: f.projectId, executionLogId: id, generation: state.generation, proof: run.proof, expectedRevision: state.revision, expectedTurnId: state.turnId, action: 'complete', outcome: 'candidate_complete', summary: report.summary, report, idempotencyKey: `complete:${id}` });
  const scope = { projectId: f.projectId, executionLogId: id, generation: state.generation, expectedRevision: state.revision, expectedTurnId: state.turnId };
  const lease = await f.call('claim_run_consumer', { ...scope, owner: await getAgentRunDeliveryOwner() });
  let verification;
  if (verify) verification = await f.call('record_run_verification', { projectId: f.projectId, executionLogId: id, claim: 'Package entry starts', result: 'pass', evidence: 'Installed package entry check passed', turnId: assessmentTurn || run.turnId,
    experienceAssessments: [{ lessonId: lesson.objectId, lessonRevision: lesson.revision, action, result: assessmentResult, evidence: 'Package installation and actual execution were checked' }], idempotencyKey: `verify:${id}` });
  const settlement = { ...scope, token: lease.token, journal: { agentCli: 'isolated-cli', command: 'isolated-cli', output: report.summary, status: 'Completed' }, digest: { schemaVersion: 2, runId: `__solo__:${id}`, executionLogId: id, nodeId: '__solo__' },
    learning: { eventType, summary: report.summary, metadata: { sourceType: 'solo' } }, ...(verification ? { verification } : {}), idempotencyKey: `settle:${id}` };
  await f.call('commit_run_settlement', settlement);
  return { ...run, settlement };
}

test('a launch reference alone cannot authorize adoption but the actual approved instructions can', async t => {
  const f = await fixture(t);
  await f.call('save_global_prompt', { policy: null, content: 'Verify actual outcomes.', source: 'user', idempotencyKey: 'prompt-policy' });
  const lesson = f.store.write({ kind: 'lesson', action: 'create', scope: f.projectId, idempotencyKey: 'prompt-lesson', data: { status: 'approved', summary: 'Verify the executable', do_this: 'Install and execute the final package' } });
  const reference = `solomap://objects/${lesson.objectId} · revision=${lesson.revision}`;
  await adoptedRun(f, { id: 31, lesson, recall: false, prompt: reference });
  assert.equal((await f.call('read_rsi_cycles', { projectId: f.projectId })).items.length, 0);
  await adoptedRun(f, { id: 32, lesson, recall: false, prompt: `${reference}\nVerify the executable\nInstall and execute the final package` });
  assert.equal((await f.call('read_rsi_cycles', { projectId: f.projectId })).items.length, 1);
  assert.equal(f.store.rows("SELECT count(*) AS n FROM evidence WHERE type='host_learning_delivery'")[0].n, 1);
});

test('an authenticated on-demand MCP delivery can be adopted and independently evaluated after owner restart', async t => {
  const f = await fixture(t);
  await f.call('save_global_prompt', { policy: null, content: 'Verify the final result.', source: 'user', idempotencyKey: 'adoption-policy' });
  const lesson = f.store.write({ kind: 'lesson', action: 'create', scope: f.projectId, idempotencyKey: 'adoption-lesson', data: { status: 'approved', summary: 'Verify the executable', applies_when: 'Releasing executable packages', do_this: 'Install and execute the final package', avoid_this: 'Only compile source' } });
  const run = await adoptedRun(f, { id: 21, lesson, verify: true });
  let cycles = await f.call('read_rsi_cycles', { projectId: f.projectId });
  assert.equal(cycles.items.length, 1);
  assert.equal(cycles.items[0].evaluation.verdict, 'effective');
  await f.restart();
  cycles = await f.call('read_rsi_cycles', { projectId: f.projectId });
  assert.equal(cycles.items[0].runId, run.runId);
  assert.equal(cycles.items[0].evaluation.verdict, 'effective');
  const planned = await runtime.runCognitiveShadowDecisionCycle({ globalDataPath: f.root, projects: f.projects, operation: f.request, engine: { id: 'outcome-planner', async plan(input) {
    assert.equal(input.candidates[0].learning[0].outcomes[0].verdict, 'effective');
    return { candidateId: input.candidates[0].id, reason: '先安装并运行最终包。' };
  } } });
  assert.match(planned.recommendations[0].reason, /最终包/);
});

test('the first run can adopt delivered experience before any global prompt has been saved', async t => {
  const f = await fixture(t);
  const lesson = f.store.write({ kind: 'lesson', action: 'create', scope: f.projectId, idempotencyKey: 'first-run-lesson', data: { status: 'approved', summary: 'Verify the executable', do_this: 'Install and execute the final package' } });
  const run = await adoptedRun(f, { id: 41, lesson });
  assert.equal(run.status.globalPromptPolicyRef, null);
  assert.equal(await f.call('read_global_prompt_policy'), null, 'experience adoption must not configure a global prompt on the user’s behalf');
  assert.equal((await f.call('read_rsi_cycles', { projectId: f.projectId })).items.length, 1);
});

test('a reader response from the old turn cannot deliver experience into its successor', async t => {
  const f = await fixture(t);
  const lesson = f.store.write({ kind: 'lesson', action: 'create', scope: f.projectId, idempotencyKey: 'turn-race-lesson', data: { status: 'approved', summary: 'Verify the executable', do_this: 'Install and execute the final package' } });
  const run = await f.call('prepare_run', { root: f.project, executionLogId: 42, nodeId: '__solo__', runKind: 'solo', prompt: 'Verify package', command: 'isolated-cli', userMessage: 'Verify package', metadata: { interactiveSession: true }, idempotencyKey: 'turn-race-run' });
  const reader = UnifiedDataStore.openReadOnly(f.root, f.store.databaseId), readerOps = createRuntimeDataOperations(reader, undefined, f.readSecret);
  const read = reader.read.bind(reader);
  let changed = false;
  reader.read = (...args) => {
    const result = read(...args);
    if (args[0] === lesson.objectId && !changed) {
      changed = true;
      const done = require('./fixtures/native-run-producer-oracles.cjs').checkpointRunNative(f.store,f.projectId, { executionLogId: 42, generation: run.generation, proof: run.proof, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'partial', summary: 'Old turn finished', idempotencyKey: 'turn-race-complete' });
      require('./fixtures/native-run-producer-oracles.cjs').checkpointRunNative(f.store,f.projectId, { executionLogId: 42, generation: done.generation, proof: run.proof, expectedRevision: done.revision, expectedTurnId: done.turnId, action: 'start', message: 'New unrelated turn', idempotencyKey: 'turn-race-start' });
    }
    return result;
  };
  const source = runtimeMcpSource(f.root, f.projectId, true, { executionLogId: 42, generation: run.generation, proof: run.proof }, undefined,
    request => request.readAuthority && request.operation === 'read' ? readerOps(request) : f.request(request));
  try {
    await source.call('read', { ref: lesson.objectId, view: 'full' });
    assert.ok(changed);
    assert.equal(f.store.rows("SELECT count(*) AS n FROM evidence WHERE type='host_learning_delivery'")[0].n, 0);
  } finally { await source.close(); await readerOps.close(); reader.close(); }
});

test('fixed historical experience stays readable without authorizing its superseded version', async t => {
  const f = await fixture(t);
  const lesson = f.store.write({ kind: 'lesson', action: 'create', scope: f.projectId, idempotencyKey: 'history-lesson', data: { status: 'approved', summary: 'Verify the executable', do_this: 'Install and execute the final package' } });
  const run = await f.call('prepare_run', { root: f.project, executionLogId: 47, nodeId: '__solo__', runKind: 'solo', prompt: 'Audit earlier experience', command: 'isolated-cli', userMessage: 'Audit history', metadata: { interactiveSession: true }, idempotencyKey: 'history-run' });
  f.store.write({ kind: 'lesson', action: 'patch', scope: f.projectId, objectId: lesson.objectId, expectedRevision: lesson.revision, idempotencyKey: 'history-new-version', data: { do_this: 'Verify the package and its restored state' } });
  const reader = UnifiedDataStore.openReadOnly(f.root, f.store.databaseId), readerOps = createRuntimeDataOperations(reader, undefined, f.readSecret);
  const source = runtimeMcpSource(f.root, f.projectId, true, { executionLogId: 47, generation: run.generation, proof: run.proof }, undefined,
    request => request.readAuthority && request.operation === 'read' ? readerOps(request) : f.request(request));
  try {
    const old = await source.call('read', { ref: lesson.objectId, revision: lesson.revision, view: 'full' });
    assert.equal(old.revision, lesson.revision);
    assert.equal(old.data.do_this, 'Install and execute the final package');
    assert.equal(f.store.rows("SELECT count(*) AS n FROM evidence WHERE type='host_learning_delivery'")[0].n, 0);
  } finally { await source.close(); await readerOps.close(); reader.close(); }
});

test('generic task verification cannot promote a different turn or unassessed experience', async t => {
  const f = await fixture(t);
  await f.call('save_global_prompt', { policy: null, content: 'Verify actual outcomes.', source: 'user', idempotencyKey: 'unassessed-policy' });
  const lesson = f.store.write({ kind: 'lesson', action: 'create', scope: f.projectId, idempotencyKey: 'unassessed-lesson', data: { status: 'approved', summary: 'Verify the executable', applies_when: 'Releasing executable packages', do_this: 'Install and execute the final package' } });
  await adoptedRun(f, { id: 22, lesson });
  await f.call('record_run_verification', { projectId: f.projectId, executionLogId: 22, claim: 'Some unrelated task passed', result: 'pass', evidence: 'Unrelated test output', idempotencyKey: 'unrelated-pass' });
  assert.equal((await f.call('read_rsi_cycles', { projectId: f.projectId })).items[0].evaluation.verdict, 'unassessed');
});

test('the same independent result has the same verdict before or after settlement', async t => {
  const f = await fixture(t);
  await f.call('save_global_prompt', { policy: null, content: 'Use independently verified results.', source: 'user', idempotencyKey: 'arrival-policy' });
  const lesson = f.store.write({ kind: 'lesson', action: 'create', scope: f.projectId, idempotencyKey: 'arrival-lesson', data: { status: 'approved', summary: 'Verify the executable', do_this: 'Install and execute the final package' } });
  await adoptedRun(f, { id: 43, lesson, eventType: 'failed', verify: true });
  const late = await adoptedRun(f, { id: 44, lesson, eventType: 'failed' });
  await f.call('record_run_verification', { projectId: f.projectId, executionLogId: 44, turnId: late.turnId, claim: 'Independent check confirms the task outcome', result: 'pass', evidence: 'Installed package entry check passed',
    experienceAssessments: [{ lessonId: lesson.objectId, lessonRevision: lesson.revision, action: 'Install and execute the final package', result: 'pass', evidence: 'Package installation and actual execution were checked' }], idempotencyKey: 'arrival-late-verification' });
  const cycles = await f.call('read_rsi_cycles', { projectId: f.projectId });
  assert.equal(cycles.items.length, 2);
  assert.deepEqual(cycles.items.map(item => item.evaluation.verdict), ['effective', 'effective']);
  assert.equal(f.store.rows("SELECT count(*) AS n FROM learning_events WHERE event_type='failed'")[0].n, 1, 'the original failed claim remains as history alongside its independent correction');
});

test('independent negative evidence is retained in either arrival order when the Agent supplied no evidence', async t => {
  const f = await fixture(t);
  const lesson = f.store.write({ kind: 'lesson', action: 'create', scope: f.projectId, idempotencyKey: 'negative-arrival-lesson', data: { status: 'approved', summary: 'Verify the executable', do_this: 'Install and execute the final package' } });
  await adoptedRun(f, { id: 45, lesson, verify: true, assessmentResult: 'fail', reportedEvidence: [] });
  const late = await adoptedRun(f, { id: 46, lesson, reportedEvidence: [] });
  await f.call('record_run_verification', { projectId: f.projectId, executionLogId: 46, turnId: late.turnId, claim: 'Independent check contradicts the claimed experience outcome', result: 'pass', evidence: 'The task passed by another approach',
    experienceAssessments: [{ lessonId: lesson.objectId, lessonRevision: lesson.revision, action: 'Install and execute the final package', result: 'fail', evidence: 'The adopted action failed independently of the final task outcome' }], idempotencyKey: 'negative-arrival-late' });
  assert.deepEqual((await f.call('read_rsi_cycles', { projectId: f.projectId })).items.map(item => item.evaluation.verdict), ['ineffective', 'ineffective']);
});

test('revoking a delivered lesson rejects its adoption without rolling back the actual task result', async t => {
  const f = await fixture(t);
  await f.call('save_global_prompt', { policy: null, content: 'Keep the actual result.', source: 'user', idempotencyKey: 'revoked-policy' });
  const lesson = f.store.write({ kind: 'lesson', action: 'create', scope: f.projectId, idempotencyKey: 'revoked-lesson', data: { status: 'approved', summary: 'Verify the executable', do_this: 'Install and execute the final package' } });
  await adoptedRun(f, { id: 23, lesson, afterRecall() { f.store.write({ kind: 'lesson', action: 'patch', scope: f.projectId, objectId: lesson.objectId, expectedRevision: lesson.revision, idempotencyKey: 'revoke-after-delivery', data: { status: 'revoked' } }); } });
  assert.equal(f.store.rows('SELECT count(*) AS n FROM policy_uses')[0].n, 0);
  assert.equal(f.store.rows('SELECT count(*) AS n FROM run_settlements')[0].n, 1);
  assert.equal(f.store.rows("SELECT count(*) AS n FROM evidence WHERE type='learning_adoption_rejected'")[0].n, 1);
});

test('a repeated rejected adoption cannot roll back the later session-close settlement', async t => {
  const f = await fixture(t);
  const lesson = f.store.write({ kind: 'lesson', action: 'create', scope: f.projectId, idempotencyKey: 'rejected-close-lesson', data: { status: 'approved', summary: 'Verify the executable', do_this: 'Install and execute the final package' } });
  const run = await adoptedRun(f, { id: 48, lesson, recall: false });
  await f.restart();
  const head = await f.call('read_run_checkpoint_state', { root: f.project, executionLogId: 48 });
  const closed = await f.call('checkpoint_run', { projectId: f.projectId, executionLogId: 48, generation: head.generation, proof: head.proof, expectedRevision: head.revision, expectedTurnId: head.turnId, action: 'session-close', exitCode: 1, idempotencyKey: 'rejected-close-checkpoint' });
  const scope = { projectId: f.projectId, executionLogId: 48, generation: closed.generation, expectedRevision: closed.revision, expectedTurnId: closed.turnId };
  const lease = await f.call('claim_run_consumer', { ...scope, owner: await getAgentRunDeliveryOwner() });
  await f.call('commit_run_settlement', { ...run.settlement, ...scope, token: lease.token, idempotencyKey: 'rejected-close-settlement' });
  assert.equal(f.store.rows('SELECT count(*) AS n FROM run_settlements')[0].n, 2);
  assert.equal(f.store.rows("SELECT count(*) AS n FROM evidence WHERE type='learning_adoption_rejected'")[0].n, 1);
});

test('closing a verified turn preserves its accepted adoption when the close does not repeat verification', async t => {
  const f = await fixture(t);
  const lesson = f.store.write({ kind: 'lesson', action: 'create', scope: f.projectId, idempotencyKey: 'verified-close-lesson', data: { status: 'approved', summary: 'Verify the executable', do_this: 'Install and execute the final package' } });
  const run = await adoptedRun(f, { id: 49, lesson, verify: true });
  await f.restart();
  const head = await f.call('read_run_checkpoint_state', { root: f.project, executionLogId: 49 });
  const closed = await f.call('checkpoint_run', { projectId: f.projectId, executionLogId: 49, generation: head.generation, proof: head.proof, expectedRevision: head.revision, expectedTurnId: head.turnId, action: 'session-close', exitCode: 0, idempotencyKey: 'verified-close-checkpoint' });
  const scope = { projectId: f.projectId, executionLogId: 49, generation: closed.generation, expectedRevision: closed.revision, expectedTurnId: closed.turnId };
  const lease = await f.call('claim_run_consumer', { ...scope, owner: await getAgentRunDeliveryOwner() });
  const { verification, ...original } = run.settlement;
  await f.call('commit_run_settlement', { ...original, ...scope, token: lease.token, idempotencyKey: 'verified-close-settlement' });
  const cycles = await f.call('read_rsi_cycles', { projectId: f.projectId });
  assert.equal(cycles.items.length, 1);
  assert.equal(cycles.items[0].evaluation.verdict, 'effective');
  assert.equal(cycles.items[0].evaluation.verificationId, verification.objectId);
  assert.equal(f.store.rows('SELECT count(*) AS n FROM run_settlements')[0].n, 2);
});

test('a Today result that loses its source version before the writer commit cannot become current', async t => {
  const f = await fixture(t);
  await runtime.runShadowDecisionCycleFromDatabase({ globalDataPath: f.root, projects: f.projects, operation: f.request });
  const before = await f.call('read_roadmap', { root: f.project });
  await f.call('update_roadmap', { root: f.project, expectedRevision: before.revision, nodes: before.nodes.map(node => ({ ...node, title: 'Changed after computation' })), idempotencyKey: 'source-race' });
  await assert.rejects(runtime.persistShadowRuntimeState(f.root, f.request), /today_source_conflict/);
  const settings = await f.call('read_host_settings', { namespace: 'runtime_shadow', ownerScope: 'global' });
  assert.equal(settings.items.some(item => item.key === 'decision'), false);
});

test('a newly visible project invalidates the whole Today project set at commit', async t => {
  const f = await fixture(t);
  await runtime.runShadowDecisionCycleFromDatabase({ globalDataPath: f.root, projects: f.projects, operation: f.request });
  const registry = await f.call('read_project_registry');
  const other = path.join(f.base, 'other'); fs.mkdirSync(other);
  await f.call('patch_project_registry', { expectedRevision: registry.revision, projectPatches: [{ path: other, fields: { name: 'Other', priority: 'P0' } }], idempotencyKey: 'new-project-before-today-commit' });
  await assert.rejects(runtime.persistShadowRuntimeState(f.root, f.request), /today_source_conflict/);
});

test('a signed read completed after its task report cannot retroactively prove experience delivery', async t => {
  const f = await fixture(t);
  f.store.write({ kind: 'lesson', action: 'create', scope: f.projectId, idempotencyKey: 'late-lesson', data: { status: 'approved', summary: 'Verify executable', do_this: 'Run final executable' } });
  const run = await f.call('prepare_run', { root: f.project, executionLogId: 24, nodeId: '__solo__', runKind: 'solo', prompt: 'Current task', command: 'isolated-cli', userMessage: 'Current task', metadata: { interactiveSession: true }, idempotencyKey: 'late-prepare' });
  const session = await f.request({ operation: 'open_mcp_session', input: { projectId: f.projectId, runIdentity: { executionLogId: 24, generation: run.generation, proof: run.proof } } });
  try {
    const raw = await f.request({ operation: 'context', sessionToken: session.sessionToken, readAuthority: session.readAuthority, input: { project: f.projectId, kinds: ['lesson'] } });
    assert.ok(raw.__solomapLearningDelivery);
    await assert.rejects(f.request({ operation: 'record_learning_delivery', sessionToken: session.sessionToken, input: { receipt: raw.__solomapLearningDelivery + 'changed' } }), /learning_delivery_invalid/);
    const current = await f.call('read_run_state', { projectId: f.projectId, executionLogId: 24 });
    await f.call('checkpoint_run', { projectId: f.projectId, executionLogId: 24, generation: current.generation, proof: run.proof, expectedRevision: current.revision, expectedTurnId: current.turnId, action: 'complete', outcome: 'candidate_complete', summary: 'Task result', idempotencyKey: 'late-complete' });
    await assert.rejects(f.request({ operation: 'record_learning_delivery', sessionToken: session.sessionToken, input: { receipt: raw.__solomapLearningDelivery } }), /learning_delivery_turn_closed/);
    const after = await f.request({ operation: 'context', sessionToken: session.sessionToken, readAuthority: session.readAuthority, input: { project: f.projectId, kinds: ['lesson'] } });
    assert.equal('__solomapLearningDelivery' in after, false);
    assert.equal(f.store.rows("SELECT count(*) AS n FROM evidence WHERE type='host_learning_delivery'")[0].n, 0);
  } finally { await f.call('close_mcp_session', { sessionToken: session.sessionToken }); }
});

test('a passing task with a failed experience assessment retains a negative experience feedback event', async t => {
  const f = await fixture(t);
  await f.call('save_global_prompt', { policy: null, content: 'Preserve counterexamples.', source: 'user', idempotencyKey: 'negative-policy' });
  const lesson = f.store.write({ kind: 'lesson', action: 'create', scope: f.projectId, idempotencyKey: 'negative-lesson', data: { status: 'approved', summary: 'Verify the executable', do_this: 'Install and execute the final package' } });
  const run = await adoptedRun(f, { id: 25, lesson });
  await f.call('record_run_verification', { projectId: f.projectId, executionLogId: 25, claim: 'Task passed but the adopted action was ineffective', result: 'pass', evidence: 'Task succeeded using another method', turnId: run.turnId,
    experienceAssessments: [{ lessonId: lesson.objectId, lessonRevision: lesson.revision, action: 'Install and execute the final package', result: 'fail', evidence: 'Independent check found the adopted action did not help' }], idempotencyKey: 'negative-assessment' });
  const cycle = (await f.call('read_rsi_cycles', { projectId: f.projectId })).items[0];
  assert.equal(cycle.evaluation.verdict, 'ineffective');
  assert.equal(cycle.evaluation.value, 0);
  const event = f.store.read(cycle.evaluation.feedbackEventId);
  assert.equal(event.data.event_type, 'verified_failed');
  assert.equal(event.data.verification_signal, 0);
  assert.equal((await f.call('read_learning_overview')).projectSignals.find(item => item.projectId === f.projectId).riskSignals, 1, 'independently disproved experience must remain visible to downstream learning consumers');
});
