const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');
const { getAgentRunDeliveryOwner } = require('../out/agentRunPreparation.js');
const { reviewHash } = require('../out/learningReview.js');
const { buildLearningRetrievalContext } = require('../out/learningLedger.js');
const { anonymousToolEnv } = require('./analysis-fixture.js');

const report = (usage) => ({
  schemaVersion: 1,
  summary: '按已审核经验完成真实任务。',
  unmetRequirements: [], decisions: [], corrections: [], verification: [], commits: [],
  experienceUsage: usage,
  lessons: []
});

function externalMemoryEntry(overrides = {}) {
  const entry = {
    schemaVersion: 1,
    objectType: 'memory_entry',
    entryId: 'entry-1',
    scopeId: 'memory_scope:project:project',
    layer: 'stable',
    kind: 'project_fact',
    status: 'active',
    title: '外部事实',
    content: '外部来源的完整正文🌿',
    tags: ['external'],
    revision: 7,
    validity: { validFrom: null, validUntil: null },
    provenance: { sourceType: 'cloudmcp' },
    metadata: {},
    supersedes: [],
    ...overrides
  };
  const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]))
    : value;
  return { ...entry, canonicalHash: `sha256:${crypto.createHash('sha256').update(JSON.stringify(ordered(entry))).digest('hex')}` };
}

async function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-rsi-'));
  const root = path.join(base, '.solomap-global');
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  let store = new UnifiedDataStore(root);
  let ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  return {
    base, root, project, get store() { return store; }, call, request: value => ops(value),
    async restart() { await ops.close(); store.close(); store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store); },
    async close() { await ops.close(); store.close(); }
  };
}

async function completeAndSettle(f, executionLogId, lesson, verdict, evidence, eventType = 'verified', delivered = true, trustedVerification = eventType === 'verified', deliveredRevision = lesson.revision) {
  const run = await f.call('prepare_run', {
    root: f.project, executionLogId, nodeId: '__solo__', runKind: 'solo', prompt: delivered ? `执行当前用户目标。\n来源：solomap://objects/${lesson.objectId} · revision=${deliveredRevision}` : '执行当前用户目标。',
    command: 'authenticated agent cli', userMessage: '完成真实任务', metadata: { interactiveSession: true },
    idempotencyKey: `rsi-prepare:${executionLogId}`
  });
  const fixedPolicy = run.status.globalPromptPolicyRef;
  const done = await f.call('checkpoint_run', {
    projectId: run.projectId, executionLogId, generation: run.generation, proof: run.proof,
    expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'partial',
    summary: '真实任务已完成', report: report([{
      experienceId: lesson.objectId, experienceRevision: lesson.revision,
      action: '实施前先完整审计生产写入与所有消费者。', result: '实现一次完成并通过验证。', verdict, evidence
    }]), idempotencyKey: `rsi-complete:${executionLogId}`
  });
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM policy_uses')[0].n, 0, 'prompt injection alone is still not adoption');
  const owner = await getAgentRunDeliveryOwner();
  const scope = { projectId: run.projectId, executionLogId, generation: done.generation, expectedRevision: done.revision, expectedTurnId: done.turnId };
  const lease = await f.call('claim_run_consumer', { ...scope, owner });
  const verification = trustedVerification ? await f.call('record_run_verification', {
    projectId: run.projectId, executionLogId, claim: '任务结果通过宿主验证', result: 'pass',
    evidence: evidence.join('\n') || '宿主验证通过', idempotencyKey: `rsi-verification:${executionLogId}`
  }) : undefined;
  const input = {
    ...scope, token: lease.token,
    journal: { agentCli: 'codex', command: 'authenticated agent cli', output: '真实结果', status: 'Completed' },
    digest: { schemaVersion: 2, runId: `__solo__:${executionLogId}`, nodeId: '__solo__', executionLogId },
    learning: { eventType, summary: '真实任务结果', metadata: { sourceType: 'solo_run', verification: evidence, recommendedStatus: eventType === 'verified' ? 'closed' : eventType } },
    ...(verification ? { verification: { objectId: verification.objectId, revision: verification.revision } } : {}),
    idempotencyKey: `rsi-settle:${executionLogId}`
  };
  const settled = await f.call('commit_run_settlement', input);
  return { run, done, fixedPolicy, input, settled };
}

test('a real run result is reviewed into a fixed lesson, recalled, adopted and evaluated', async () => {
  const f = await fixture();
  try {
    const originalPrompt = '保留用户目标。\n';
    await f.call('save_global_prompt', { policy: null, content: originalPrompt, source: 'user', idempotencyKey: 'rsi-review-policy' });
    const run = await f.call('prepare_run', { root: f.project, executionLogId: 10, nodeId: '__solo__', runKind: 'solo', prompt: '完成一次经过验证的真实任务。', command: 'authenticated agent cli', userMessage: '完成真实任务', metadata: { interactiveSession: true }, idempotencyKey: 'rsi-source-run' });
    const done = await f.call('checkpoint_run', { projectId: run.projectId, executionLogId: 10, generation: run.generation, proof: run.proof, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'partial', summary: '真实任务已验证', report: report([]), idempotencyKey: 'rsi-source-complete' });
    const owner = await getAgentRunDeliveryOwner();
    const lease = await f.call('claim_run_consumer', { projectId: run.projectId, executionLogId: 10, generation: done.generation, expectedRevision: done.revision, expectedTurnId: done.turnId, owner });
    await f.call('commit_run_settlement', {
      projectId: run.projectId, executionLogId: 10, generation: done.generation, expectedRevision: done.revision, expectedTurnId: done.turnId, token: lease.token,
      journal: { agentCli: 'codex', command: 'authenticated agent cli', output: '真实结果', status: 'Completed' },
      digest: { schemaVersion: 2, runId: '__solo__:10', nodeId: '__solo__', executionLogId: 10 },
      learning: { eventType: 'verified', summary: '先审计生产者与消费者后一次完成', metadata: { sourceType: 'solo_run', verification: ['node --test passed'], recommendedStatus: 'closed' } },
      idempotencyKey: 'rsi-source-settle'
    });
    const learningEventId = String(f.store.rows("SELECT id FROM learning_events WHERE project_id=? AND summary='先审计生产者与消费者后一次完成'", [run.projectId])[0].id);
    const batch = await f.call('prepare_learning_review', { runId: 'rsi-real-review', workspaceRoot: f.project, globalPrompt: originalPrompt, persistedGlobalPrompt: originalPrompt });
    const eventSource = batch.manifest.sources.find(source => source.kind === 'learning_event' && source.ref?.objectId === learningEventId);
    assert.ok(eventSource, 'the review must receive the fixed real learning event');
    const addition = '实施跨层改动前，先审计生产写入、消费者、恢复与退役边界。';
    const result = {
      globalPrompt: originalPrompt + addition + '\n',
      changes: [{ type: 'add', before: [], after: addition, evidence: [eventSource.id], reason: '真实任务验证了实施前完整审计能避免返工。' }],
      lessons: [{ projectPath: f.project, lessonType: 'implementation_pattern', summary: '实施前完整审计生产链', appliesWhen: '修改跨层功能时', doesNotApplyWhen: '纯文案且不改变行为时', doThis: '先核对生产者、消费者、恢复与旧路径退出', avoidThis: '用验收循环代替实施前审计', verification: '真实任务一次完成并通过验证', reason: '本轮真实学习事件已有验证证据', evidence: [eventSource.id] }],
      processedSourceIds: batch.manifest.sources.map(source => source.id), deferredSourceIds: [], unresolved: [], recovery: []
    };
    const applied = await f.call('apply_learning_review', { batchId: batch.objectId, expectedRevision: batch.revision, manifestHash: reviewHash(JSON.stringify(batch.manifest)), result, idempotencyKey: 'rsi-real-review-apply' });
    assert.equal(applied.lessons.length, 1);
    assert.deepEqual(await f.call('apply_learning_review', { batchId: batch.objectId, expectedRevision: batch.revision, manifestHash: reviewHash(JSON.stringify(batch.manifest)), result, idempotencyKey: 'rsi-real-review-apply' }), applied);
    const lesson = f.store.read(applied.lessons[0].objectId, applied.lessons[0].revision);
    assert.equal(lesson.data.status, 'approved');
    assert.deepEqual(lesson.data.event_refs, [{ sourceId: learningEventId, objectId: learningEventId, revision: 1 }]);
    assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM lesson_decisions WHERE lesson_id=?', [lesson.objectId])[0].n, 1);
    assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM applications WHERE lesson_id=?', [lesson.objectId])[0].n, 1);
    await f.call('finish_learning_review', { applicationId: applied.application.objectId, expectedRevision: applied.application.revision, promptHash: reviewHash(result.globalPrompt), idempotencyKey: 'rsi-real-review-finish' });

    const server = await startRuntimeControlServer({ globalDataPath: f.root, runtimeId: 'rsi-recall-fixture', onCommand: () => ({ status: 'running' }), onData: request => f.request(request) });
    try {
      const recalled = await buildLearningRetrievalContext(f.project, f.root, { projectPath: f.project, runKind: 'solo', role: 'builder', contextText: '修改跨层功能' });
      assert.match(recalled, new RegExp(`solomap://objects/${lesson.objectId}.*revision=${lesson.revision}`));
    } finally { await server.close(); }
    const cycle = await completeAndSettle(f, 11, lesson, 'effective', ['node --test test/rsi-database.test.js passed']);
    const cycles = await f.call('read_rsi_cycles', { projectId: cycle.run.projectId });
    assert.equal(cycles.items.length, 1);
    assert.equal(cycles.items[0].evaluation.verdict, 'effective');
  } finally { await f.close(); }
});

test('an explicit fixed experience adoption creates one durable policy use and one honest evaluation', async () => {
  const f = await fixture();
  try {
    const policy = await f.call('save_global_prompt', { policy: null, content: '每次实施前审计完整生产链。\n', source: 'user', idempotencyKey: 'rsi-policy' });
    const lesson = f.store.write({ kind: 'lesson', action: 'create', scope: null, idempotencyKey: 'rsi-lesson', data: {
      status: 'approved', summary: '实施前完整审计生产链', applies_when: '修改跨层功能时', do_this: '先核对生产者、消费者、恢复与退役边界', avoid_this: '用验收代替实现前审计', verification: '真实任务结果通过', confidence: 1
    } });
    const first = await completeAndSettle(f, 1, lesson, 'effective', ['node --test test/rsi-database.test.js passed'], 'verified', true, false);
    assert.deepEqual(first.fixedPolicy, policy);
    let cycles = await f.call('read_rsi_cycles', { projectId: first.run.projectId });
    assert.equal(cycles.items.length, 1);
    assert.equal(cycles.items[0].evaluation.verdict, 'unassessed', 'the Agent report is only a claim until the host records formal verification');
    const verification = await f.call('record_run_verification', {
      projectId: first.run.projectId, executionLogId: 1, claim: '独立宿主回归通过', result: 'pass',
      evidence: 'node --test test/rsi-database.test.js passed', idempotencyKey: 'rsi-post-settlement-verification'
    });
    cycles = await f.call('read_rsi_cycles', { projectId: first.run.projectId });
    assert.deepEqual(cycles.items[0].policyRef, policy);
    assert.deepEqual(cycles.items[0].lessonRef, { objectId: lesson.objectId, revision: lesson.revision });
    assert.equal(cycles.items[0].evaluation.verdict, 'effective');
    assert.equal(cycles.items[0].evaluation.verificationId, verification.objectId);
    assert.deepEqual(cycles.items[0].evidence, ['node --test test/rsi-database.test.js passed']);
    assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM policy_uses')[0].n, 1);
    assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM evaluations')[0].n, 1);

    const corrected = f.store.write({ kind: 'lesson', action: 'patch', scope: null, objectId: lesson.objectId, expectedRevision: lesson.revision, idempotencyKey: 'rsi-lesson-corrected', data: { status: 'revoked', summary: '该经验已经撤销' } });
    assert.equal(corrected.revision, lesson.revision + 1);
    await f.restart();
    const afterRestart = await f.call('read_rsi_cycles', { projectId: first.run.projectId });
    assert.deepEqual(afterRestart.items[0].lessonRef, { objectId: lesson.objectId, revision: lesson.revision }, 'history keeps the adopted fixed revision');
    assert.equal(afterRestart.items[0].currentLessonStatus, 'revoked');
    assert.deepEqual(await f.call('commit_run_settlement', first.input), first.settled);
    assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM policy_uses')[0].n, 1);
    assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM evaluations')[0].n, 1);
    f.store.write({ kind: 'lesson', action: 'create', scope: first.run.projectId, idempotencyKey: 'rsi-promoted-legacy', data: { status: 'promoted', summary: '旧 promoted 固定版本经验不得进入正式任务召回结果', applies_when: '正式任务检索固定经验版本时', do_this: '只召回 approved 经验', confidence: 1 } });
    const server = await startRuntimeControlServer({ globalDataPath: f.root, runtimeId: 'rsi-cli-fixture', onCommand: () => ({ status: 'running' }), onData: request => f.request(request) });
    try {
      const env = anonymousToolEnv();
      const { stdout } = await promisify(childProcess.execFile)(process.execPath, [path.join(__dirname, '..', 'resources', 'tools', 'solomap-experience.cjs'), 'rsi', '--project', f.project, '--global', f.root, '--json'], { env });
      const external = JSON.parse(stdout);
      assert.equal(external.payload.cycles.length, 1);
      assert.deepEqual(external.payload.cycles[0].lessonRef, { objectId: lesson.objectId, revision: lesson.revision });
      assert.equal(external.payload.cycles[0].verdict, 'effective');
      const retrieved = JSON.parse((await promisify(childProcess.execFile)(process.execPath, [path.join(__dirname, '..', 'resources', 'tools', 'solomap-experience.cjs'), 'retrieve', '--project', f.project, '--global', f.root, '--query', '该经验已经撤销', '--json'], { env })).stdout);
      assert.deepEqual(retrieved.payload.lessons, [], 'revoked lessons remain historical but cannot be recalled by the production CLI');
      const promoted = JSON.parse((await promisify(childProcess.execFile)(process.execPath, [path.join(__dirname, '..', 'resources', 'tools', 'solomap-experience.cjs'), 'retrieve', '--project', f.project, '--global', f.root, '--query', '旧 promoted 固定版本经验召回', '--json'], { env })).stdout);
      assert.deepEqual(promoted.payload.lessons, [], 'legacy promoted lessons remain historical but cannot be recalled by the production CLI');
    } finally { await server.close(); }
  } finally { await f.close(); }
});

test('unknown outcomes remain unassessed and external memory authorization is reversible without losing history', async () => {
  const f = await fixture();
  try {
    await f.call('save_global_prompt', { policy: null, content: '保留未知结果，不伪造有效。\n', source: 'user', idempotencyKey: 'rsi-policy-unknown' });
    const lesson = f.store.write({ kind: 'lesson', action: 'create', scope: null, idempotencyKey: 'rsi-lesson-unknown', data: { status: 'approved', summary: '未知结果保持未知', confidence: 1 } });
    const second = await completeAndSettle(f, 2, lesson, 'effective', [], 'completed', true, false);
    const cycles = await f.call('read_rsi_cycles', { projectId: second.run.projectId });
    assert.equal(cycles.items[0].evaluation.verdict, 'unassessed');

    const entry = externalMemoryEntry();
    const session = await f.request({ operation: 'open_mcp_session', input: { projectId: second.run.projectId } });
    await assert.rejects(f.request({
      operation: 'sync_external_memory', sessionToken: session.sessionToken,
      input: { projectId: second.run.projectId, source: 'cloud-memory:forged-global', entry: externalMemoryEntry({ entryId: 'forged', scopeId: 'memory_scope:global' }), authorized: true, idempotencyKey: 'forged-global' }
    }), /action_denied/);
    await f.request({ operation: 'close_mcp_session', input: { sessionToken: session.sessionToken } });
    const active = await f.call('sync_external_memory', {
      projectId: second.run.projectId, source: 'cloud-memory:target-1:entry-1', entry,
      authorized: true, idempotencyKey: 'external-active'
    });
    const visible = await f.call('context', { project: second.run.projectId, kinds: ['memory'], terms: ['外部来源'], limit: 20 });
    assert.ok(visible.items.some(item => item.objectId === active.objectId));
    const otherRoot = path.join(f.base, 'other-project'); fs.mkdirSync(otherRoot);
    const other = await f.call('register_project', { root: otherRoot });
    const isolated = await f.call('context', { project: other.projectId, kinds: ['memory'], terms: ['外部来源'], limit: 20 });
    assert.ok(!isolated.items.some(item => item.objectId === active.objectId), 'project external memory stays in its project');
    const globalEntry = externalMemoryEntry({ entryId: 'global-1', scopeId: 'memory_scope:global', kind: 'global', title: '跨项目事实', content: '跨项目授权记忆', revision: 1 });
    const global = await f.call('sync_external_memory', { projectId: second.run.projectId, source: 'cloud-memory:target-1:global-1', entry: globalEntry, authorized: true, idempotencyKey: 'external-global' });
    const otherGlobal = await f.call('context', { project: other.projectId, kinds: ['memory'], terms: ['跨项目授权'], limit: 20 });
    assert.ok(otherGlobal.items.some(item => item.objectId === global.objectId));
    await assert.rejects(f.call('sync_external_memory', {
      projectId: second.run.projectId, source: 'cloud-memory:target-1:entry-1',
      entry: { ...externalMemoryEntry({ content: 'tampered', revision: 8 }), canonicalHash: entry.canonicalHash },
      authorized: true, idempotencyKey: 'external-bad-hash'
    }), /external_memory_hash_mismatch/);
    const revoked = await f.call('sync_external_memory', {
      projectId: second.run.projectId, source: 'cloud-memory:target-1:entry-1', entry,
      authorized: false, idempotencyKey: 'external-revoked'
    });
    await assert.rejects(f.call('sync_external_memory', {
      projectId: second.run.projectId, source: 'cloud-memory:target-1:entry-1', entry: externalMemoryEntry({ revision: 6 }),
      authorized: true, idempotencyKey: 'external-stale-revision'
    }), /external_memory_source_revision_conflict/);
    assert.equal(f.store.read(active.objectId, active.revision).data.status, 'active');
    assert.equal(f.store.read(revoked.objectId).data.status, 'revoked');
    const hidden = await f.call('context', { project: second.run.projectId, kinds: ['memory'], terms: ['外部来源'], limit: 20 });
    assert.ok(!hidden.items.some(item => item.objectId === active.objectId));
    await f.restart();
    const restored = await f.call('sync_external_memory', {
      projectId: second.run.projectId, source: 'cloud-memory:target-1:entry-1', entry,
      authorized: true, idempotencyKey: 'external-restored'
    });
    assert.equal(f.store.read(restored.objectId).data.status, 'active');
  } finally { await f.close(); }
});

test('ordinary project search hides ineligible external memory while explicit inbox context can inspect candidates', async () => {
  const f = await fixture();
  try {
    const project = await f.call('register_project', { root: f.project });
    const entries = [
      ['active', externalMemoryEntry({ entryId: 'visible', title: 'External visible marker', content: 'external-visible-marker' })],
      ['pending', externalMemoryEntry({ entryId: 'pending', status: 'pending', title: 'External pending marker', content: 'external-pending-marker' })],
      ['candidate', externalMemoryEntry({ entryId: 'candidate', layer: 'candidate', title: 'External candidate marker', content: 'external-candidate-marker' })],
      ['future', externalMemoryEntry({ entryId: 'future', title: 'External future marker', content: 'external-future-marker', validity: { validFrom: new Date(Date.now() + 86400000).toISOString(), validUntil: null } })],
      ['expired', externalMemoryEntry({ entryId: 'expired', title: 'External expired marker', content: 'external-expired-marker', validity: { validFrom: null, validUntil: new Date(Date.now() - 86400000).toISOString() } })]
    ];
    for (const [name, entry] of entries) await f.call('sync_external_memory', {
      projectId: project.projectId, source: `cloudmcp:project:${project.projectId}:visibility:${name}`, entry,
      authorized: true, idempotencyKey: `external-visibility:${name}`
    });
    const session = await f.request({ operation: 'open_mcp_session', input: { projectId: project.projectId } });
    try {
      const search = term => f.request({ operation: 'search', sessionToken: session.sessionToken, input: { scope: project.projectId, kinds: ['memory'], terms: [term] } });
      assert.equal((await search('external-visible-marker')).items.length, 1);
      for (const hidden of ['pending', 'candidate', 'future', 'expired']) assert.equal((await search(`external-${hidden}-marker`)).items.length, 0, `${hidden} external memory must stay out of ordinary search`);
      const inbox = await f.request({ operation: 'context', sessionToken: session.sessionToken, input: { project: project.projectId, kinds: ['memory'], categories: ['inbox'], terms: ['external-candidate-marker'] } });
      assert.equal(inbox.items.length, 1, 'candidate external memory is available only through the explicit inbox context');
    } finally { await f.request({ operation: 'close_mcp_session', input: { sessionToken: session.sessionToken } }); }
  } finally { await f.close(); }
});

test('candidate lessons are neither recalled nor accepted as adopted experience', async () => {
  const f = await fixture();
  try {
    await f.call('save_global_prompt', { policy: null, content: '只采用已审核经验。\n', source: 'user', idempotencyKey: 'rsi-policy-candidate' });
    const project = await f.call('register_project', { root: f.project });
    const candidate = f.store.write({ kind: 'lesson', action: 'create', scope: project.projectId, idempotencyKey: 'rsi-candidate', data: {
      status: 'candidate', summary: '候选经验不能进入执行提示', applies_when: '任何任务', do_this: '尚未审核', confidence: 0.5
    } });
    const server = await startRuntimeControlServer({ globalDataPath: f.root, runtimeId: 'rsi-candidate-fixture', onCommand: () => ({ status: 'running' }), onData: request => f.request(request) });
    try {
      const recalled = await buildLearningRetrievalContext(f.project, f.root, { projectPath: f.project, runKind: 'solo', role: 'builder', contextText: '候选经验不能进入执行提示' });
      assert.doesNotMatch(recalled, new RegExp(candidate.objectId));
    } finally { await server.close(); }
    await assert.rejects(completeAndSettle(f, 4, candidate, 'effective', ['forged evidence']), /rsi_lesson_not_approved/);
    assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM policy_uses')[0].n, 0);
    assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM evaluations')[0].n, 0);
  } finally { await f.close(); }
});

test('a report cannot manufacture adoption for an experience that the fixed run prompt never recalled', async () => {
  const f = await fixture();
  try {
    await f.call('save_global_prompt', { policy: null, content: '只记录实际采用。\n', source: 'user', idempotencyKey: 'rsi-policy-forgery' });
    const lesson = f.store.write({ kind: 'lesson', action: 'create', scope: null, idempotencyKey: 'rsi-lesson-forgery', data: { status: 'approved', summary: '未召回经验', confidence: 1 } });
    await assert.rejects(completeAndSettle(f, 3, lesson, 'effective', ['node --test passed'], 'verified', false), /rsi_experience_not_delivered/);
    assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM policy_uses')[0].n, 0);
    assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM evaluations')[0].n, 0);
    assert.equal((await f.call('list_run_states', { root: f.project, pendingConsumer: true })).items.length, 1, 'failed settlement remains recoverable');
  } finally { await f.close(); }
});

test('a delivered revision 10 reference cannot authorize a report claiming revision 1', async () => {
  const f = await fixture();
  try {
    await f.call('save_global_prompt', { policy: null, content: '固定版本必须精确匹配。\n', source: 'user', idempotencyKey: 'rsi-policy-revision-prefix' });
    const first = f.store.write({ kind: 'lesson', action: 'create', scope: null, idempotencyKey: 'rsi-lesson-revision-prefix', data: { status: 'approved', summary: '精确固定版本', confidence: 1 } });
    let head = first;
    for (let revision = 2; revision <= 10; revision++) head = f.store.write({ kind: 'lesson', action: 'patch', scope: null, objectId: first.objectId, expectedRevision: head.revision, idempotencyKey: `rsi-lesson-revision-prefix:${revision}`, data: { status: 'approved', summary: `精确固定版本 ${revision}` } });
    assert.equal(head.revision, 10);
    await assert.rejects(completeAndSettle(f, 5, first, 'effective', ['forged prefix match'], 'completed', true, false, 10), /rsi_experience_not_delivered/);
    assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM policy_uses')[0].n, 0);
  } finally { await f.close(); }
});
