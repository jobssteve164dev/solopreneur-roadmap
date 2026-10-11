const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { getAgentRunDeliveryOwner } = require('../out/agentRunPreparation.js');

async function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-settlement-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  const run = await call('prepare_run', { root: project, executionLogId: 1, nodeId: 'step', runKind: 'step', prompt: '原始请求', command: 'actual command', userMessage: '用户目标', metadata: { interactiveSession: true }, idempotencyKey: 'settlement-prepare' });
  const done = await call('checkpoint_run', { projectId: run.projectId, executionLogId: 1, generation: run.generation, proof: run.proof, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'partial', summary: '全部结论🌿\n'.repeat(12000), idempotencyKey: 'settlement-result' });
  const owner = await getAgentRunDeliveryOwner();
  const scope = { projectId: run.projectId, executionLogId: 1, generation: done.generation, expectedRevision: done.revision, expectedTurnId: done.turnId };
  return { base, root, project, store, ops, call, run, done, owner, scope, async close() { await this.ops.close(); this.store.close(); } };
}

function result(f, lease) {
  return { ...f.scope, token: lease.token, journal: { agentCli: 'claude', command: 'actual command', output: '全部工作汇报🌿\n'.repeat(12000), status: 'In Progress' }, digest: { schemaVersion: 2, runId: 'step:1', nodeId: 'step', executionLogId: 1, finishedAt: f.done.status.finishedAt, decision: { summary: '完整结论' } }, handoff: { summary: '完整交接🌿\n'.repeat(12000) }, learning: { eventType: 'partial', summary: '完整学习来源', metadata: { sourceType: 'step_run', verification: ['实际验证'] } }, idempotencyKey: `settlement:${f.run.runId}:${f.run.turnId}` };
}

test('ordinary status patches cannot change host sealing or accepted output boundaries', async () => {
  const f = await fixture();
  try {
    for (const [key, value] of Object.entries({ hostOutputPending: false, hostOutputFinalizedAt: 'forged', hostOutputSource: 'host', nativeOutputPending: false, nativeReplyObjectId: 'forged', nativeReplyRevision: 1, nativeTokenUsage: { totalTokens: 0 }, nativeWorkspaceObservationObjectId: 'forged', nativeWorkspaceObservationRevision: 1, workspaceEvidenceBoundary: 'recorded', turnLogEndOffsets: { output: 0 }, turnLogStartOffsets: { output: 0 } })) {
      await assert.rejects(f.call('patch_run_state', { projectId: f.run.projectId, executionLogId: 1, generation: f.done.generation, expectedRevision: f.done.revision, patch: { [key]: value }, idempotencyKey: `forged-seal:${key}` }), /invalid_run_patch/);
    }
    const current = await f.call('read_run_state', { projectId: f.run.projectId, executionLogId: 1 });
    assert.equal(current.revision, f.done.revision);
  } finally { await f.close(); }
});

test('a new turn cannot replace an accepted unattended result before the live host seals its output', async () => {
  const f = await fixture();
  try {
    const run = await f.call('prepare_run', { root: f.project, executionLogId: 2, nodeId: 'step', runKind: 'step', prompt: '原始请求', command: 'actual command', userMessage: '用户目标', metadata: { interactiveSession: false, agentPid: f.owner.pid, processBirth: f.owner.birth }, idempotencyKey: 'pending-host-run' });
    const done = await f.call('checkpoint_run', { projectId: run.projectId, executionLogId: 2, generation: run.generation, proof: run.proof, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'partial', summary: 'Agent提交了结果，宿主尚未关闭', idempotencyKey: 'pending-host-complete' });
    assert.equal(done.status.hostOutputPending, true);
    await assert.rejects(f.call('checkpoint_run', { projectId: run.projectId, executionLogId: 2, generation: run.generation, proof: run.proof, expectedRevision: done.revision, expectedTurnId: done.turnId, action: 'start', message: '下一轮要求', idempotencyKey: 'pending-host-next' }), /run_output_pending/);
    const sealed = await f.call('finalize_run_output', { projectId: run.projectId, executionLogId: 2, generation: run.generation, proof: run.proof, expectedRevision: done.revision, expectedTurnId: done.turnId, exitCode: 0, source: 'host', idempotencyKey: 'pending-host-finalize' });
    const next = await f.call('checkpoint_run', { projectId: run.projectId, executionLogId: 2, generation: run.generation, proof: run.proof, expectedRevision: sealed.revision, expectedTurnId: sealed.turnId, action: 'start', message: '下一轮要求', idempotencyKey: 'pending-host-next' });
    assert.notEqual(next.turnId, done.turnId);
  } finally { await f.close(); }
});

test('automatic revision admission rejects a changed parent turn before creating any task or journal', async () => {
  const f = await fixture();
  try {
    const newer = await f.call('checkpoint_run', { projectId: f.run.projectId, executionLogId: 1, generation: f.done.generation, proof: f.run.proof, expectedRevision: f.done.revision, expectedTurnId: f.done.turnId, action: 'start', message: '下一轮要求', idempotencyKey: 'revision-parent-newer' });
    const before = await f.call('read_project_journal', { root: f.project });
    await assert.rejects(f.call('prepare_run', { root: f.project, executionLogId: 3, parentExecutionLogId: 1, expectedParentTurnId: f.done.turnId, nodeId: 'step', runKind: 'agent_review_revision', prompt: '修正上一轮', command: 'actual CLI', userMessage: '原始目标', idempotencyKey: 'stale-revision-admission' }), /run_source_turn_changed/);
    const after = await f.call('read_project_journal', { root: f.project });
    assert.equal(after.logs.length, before.logs.length);
    assert.equal((await f.call('read_run_state', { projectId: f.run.projectId, executionLogId: 1 })).turnId, newer.turnId);
  } finally { await f.close(); }
});

test('settlement follow-up actions are committed atomically, recover after restart and fence live consumers', async () => {
  const f = await fixture();
  try {
    const lease = await f.call('claim_run_consumer', { ...f.scope, owner: f.owner });
    const input = { ...result(f, lease), effects: [
      { kind: 'roadmap', payload: { nodeId: 'step', nextStatus: 'In Progress' } },
      { kind: 'review', payload: { mainExecutionLogId: 1, fullEvidence: '完整复核证据🌿\n'.repeat(10000) } }
    ] };
    await f.call('commit_run_settlement', input);
    await f.call('commit_run_settlement', input);
    await f.ops.close(); f.store.close();
    f.store = new UnifiedDataStore(f.root); f.ops = createRuntimeDataOperations(f.store);
    f.call = (operation, value) => f.ops({ operation, input: value });
    const pending = await f.call('list_run_effects', { projectId: f.run.projectId });
    assert.equal(pending.items.length, 2);
    const review = pending.items.find(item => item.kind === 'review');
    assert.deepEqual((await f.call('claim_run_effect', { projectId: f.run.projectId, effectId: review.effectId, owner: f.owner })).payload, input.effects[1].payload);
    const effect = pending.items.find(item => item.kind === 'roadmap');
    const held = await f.call('claim_run_effect', { projectId: f.run.projectId, effectId: effect.effectId, owner: f.owner });
    assert.ok(held.token);
    assert.equal(await f.call('claim_run_effect', { projectId: f.run.projectId, effectId: effect.effectId, owner: { ...f.owner, id: 'other-live-window' } }), null);
    await assert.rejects(f.call('finish_run_effect', { projectId: f.run.projectId, effectId: effect.effectId, token: 'invalid', result: 'done' }), /run_effect_lease_lost/);
    await f.call('finish_run_effect', { projectId: f.run.projectId, effectId: effect.effectId, token: held.token, result: 'retry', error: '重启后继续' });
    const abandoned = await f.call('claim_run_effect', { projectId: f.run.projectId, effectId: effect.effectId, owner: { id: 'dead-window', pid: 2147483647, birth: 'proc:gone' } });
    const resumed = await f.call('claim_run_effect', { projectId: f.run.projectId, effectId: effect.effectId, owner: f.owner });
    assert.notEqual(resumed.token, abandoned.token);
    await assert.rejects(f.call('finish_run_effect', { projectId: f.run.projectId, effectId: effect.effectId, token: abandoned.token, result: 'done' }), /run_effect_lease_lost/);
    await f.call('finish_run_effect', { projectId: f.run.projectId, effectId: effect.effectId, token: resumed.token, result: 'done' });
    await f.call('finish_run_effect', { projectId: f.run.projectId, effectId: effect.effectId, token: resumed.token, result: 'done' });
    assert.equal((await f.call('list_run_effects', { projectId: f.run.projectId })).items.length, 1);
    assert.equal((await f.call('list_run_effects', { projectId: f.run.projectId, state: 'done' })).items.length, 1);
    fs.mkdirSync(path.join(f.base, 'other'));
    const other = await f.call('register_project', { root: path.join(f.base, 'other') });
    await assert.rejects(f.call('claim_run_effect', { projectId: other.projectId, effectId: effect.effectId, owner: f.owner }), /run_effect_scope_mismatch/);
  } finally { await f.close(); }
});

test('invalid follow-up actions roll back the entire settlement and leave its source recoverable', async () => {
  const f = await fixture();
  try {
    const lease = await f.call('claim_run_consumer', { ...f.scope, owner: f.owner });
    await assert.rejects(f.call('commit_run_settlement', { ...result(f, lease), effects: [{ kind: 'unknown-effect', payload: {} }] }), /invalid_run_effect/);
    assert.equal((await f.call('read_run_settlements', { projectId: f.run.projectId })).items.length, 0);
    assert.equal((await f.call('list_run_states', { projectId: f.run.projectId, pendingConsumer: true })).items.length, 1);
    assert.equal(await f.call('read_step_memory', { projectId: f.run.projectId, nodeId: 'step' }), null);
  } finally { await f.close(); }
});

test('repeated follow-up polling reads only queue headers until a window owns the action', async () => {
  const f = await fixture();
  try {
    const lease = await f.call('claim_run_consumer', { ...f.scope, owner: f.owner });
    await f.call('commit_run_settlement', { ...result(f, lease), effects: [{ kind: 'review', payload: { fullEvidence: '完整历史证据🌿\n'.repeat(100000) } }] });
    const contentIds = new Set(f.store.rows('SELECT payload_content_id FROM run_effects').map(row => row.payload_content_id));
    const originalContent = f.store.content.bind(f.store); let reads = 0;
    f.store.content = id => { if (contentIds.has(id)) reads++; return originalContent(id); };
    const page = await f.call('list_run_effects', { projectId: f.run.projectId });
    for (let index = 0; index < 10; index++) await f.call('list_run_effects', { projectId: f.run.projectId });
    assert.equal(reads, 0, 'unchanged polling must not repeatedly decode complete evidence');
    const held = await f.call('claim_run_effect', { projectId: f.run.projectId, effectId: page.items[0].effectId, owner: f.owner });
    assert.equal(held.payload.fullEvidence.length, '完整历史证据🌿\n'.repeat(100000).length);
    assert.equal(reads, 1);
  } finally { await f.close(); }
});

test('documentation audits can be built and settled without rewriting the historical manifest file', async () => {
  const { buildDocumentationAudit } = require('../out/documentationManifest.js');
  const f = await fixture();
  try {
    fs.mkdirSync(path.join(f.project, 'docs')); fs.writeFileSync(path.join(f.project, 'docs', 'decisions.md'), '# 正式决策\n');
    const legacy = path.join(f.project, '.solopreneur', 'documentation.json'); fs.writeFileSync(legacy, '{"historical":"unchanged"}');
    const audit = buildDocumentationAudit(f.project, { schemaVersion: 1, updatedAt: '', documents: [], pendingReview: [] }, { changedFilesSummary: 'A docs/decisions.md', finishedAt: f.done.status.finishedAt });
    const lease = await f.call('claim_run_consumer', { ...f.scope, owner: f.owner });
    const input = { ...result(f, lease), documentationAudit: audit };
    await f.call('commit_run_settlement', input);
    assert.deepEqual(await f.call('read_documentation_manifest', { projectId: f.run.projectId }), audit.manifest);
    assert.equal(fs.readFileSync(legacy, 'utf8'), '{"historical":"unchanged"}');
    const objects = f.store.search({ scope: f.run.projectId, kinds: ['document'], limit: 100 }).items;
    assert.equal(objects.length, 1); assert.equal(objects[0].data.status, 'active');
  } finally { await f.close(); }
});

test('concurrent run audits preserve both document indexes and review risks from the shared project baseline', async () => {
  const f = await fixture();
  try {
    const second = await f.call('prepare_run', { root: f.project, executionLogId: 2, nodeId: 'other-step', runKind: 'step', prompt: '另一个目标', command: 'actual command', userMessage: '并行请求', metadata: { interactiveSession: true }, idempotencyKey: 'parallel-doc-prepare' });
    const done = await f.call('checkpoint_run', { projectId: second.projectId, executionLogId: 2, generation: second.generation, proof: second.proof, expectedRevision: second.revision, expectedTurnId: second.turnId, action: 'complete', outcome: 'partial', summary: '另一轮结论', idempotencyKey: 'parallel-doc-complete' });
    const scope = { projectId: second.projectId, executionLogId: 2, generation: done.generation, expectedRevision: done.revision, expectedTurnId: done.turnId };
    const audit = name => ({ manifest: { schemaVersion: 1, updatedAt: '2026-10-09T12:00:00Z', documents: [{ path: `docs/${name}.md`, role: 'decisions', status: 'active', solves: `用户的${name}决策`, lastTouchedAt: '2026-10-09T12:00:00Z' }], pendingReview: [{ path: `docs/${name}.md`, reason: `${name}风险`, severity: 'warning', detectedAt: '2026-10-09T12:00:00Z', source: 'documentation_audit' }] }, touchedDocuments: [`docs/${name}.md`], pendingReview: [], summary: '完整文档审计' });
    const firstLease = await f.call('claim_run_consumer', { ...f.scope, owner: f.owner });
    const secondLease = await f.call('claim_run_consumer', { ...scope, owner: { ...f.owner, id: 'second-window' } });
    await f.call('commit_run_settlement', { ...result(f, firstLease), documentationAudit: audit('a') });
    await f.call('commit_run_settlement', { ...result(f, secondLease), ...scope, token: secondLease.token, digest: { schemaVersion: 2, runId: 'other-step:2', nodeId: 'other-step', executionLogId: 2 }, documentationAudit: audit('b'), idempotencyKey: 'parallel-doc-settle' });
    const merged = await f.call('read_documentation_manifest', { projectId: f.run.projectId });
    assert.deepEqual(merged.documents.map(item => item.path).sort(), ['docs/a.md', 'docs/b.md']);
    assert.deepEqual(merged.pendingReview.map(item => item.reason).sort(), ['a风险', 'b风险']);
  } finally { await f.close(); }
});

test('handoff history stores each full entry once and reading one turn avoids decoding other settlement payloads', async () => {
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const f = await fixture();
  try {
    const text = '完整交接原文🌿\n'.repeat(10000);
    for (let index = 0; index < 4; index++) {
      const scope = { projectId: f.run.projectId, executionLogId: 1, generation: f.done.generation, expectedRevision: f.done.revision, expectedTurnId: f.done.turnId };
      const lease = await f.call('claim_run_consumer', { ...scope, owner: f.owner });
      const input = { ...result(f, lease), ...scope, journal: { agentCli: 'claude', command: 'actual command', output: `完整结论 ${index}`, status: 'In Progress' }, digest: { schemaVersion: 2, runId: `step:${f.done.status.journalExecutionLogId}`, nodeId: 'step', executionLogId: Number(f.done.status.journalExecutionLogId) }, handoff: { summary: `${index}\n${text}` }, idempotencyKey: `handoff-history:${index}` };
      await f.call('commit_run_settlement', input);
      if (index < 3) {
        let current = await f.call('read_run_checkpoint_state', { projectId: f.run.projectId, executionLogId: 1 });
        await f.call('checkpoint_run', { projectId: f.run.projectId, executionLogId: 1, generation: current.generation, proof: current.proof, expectedRevision: current.revision, expectedTurnId: current.turnId, action: 'start', message: `后续请求 ${index}`, idempotencyKey: `handoff-start:${index}` });
        current = await f.call('read_run_checkpoint_state', { projectId: f.run.projectId, executionLogId: 1 });
        f.done = await f.call('checkpoint_run', { projectId: f.run.projectId, executionLogId: 1, generation: current.generation, proof: current.proof, expectedRevision: current.revision, expectedTurnId: current.turnId, action: 'complete', outcome: 'partial', summary: `完整结果 ${index}`, idempotencyKey: `handoff-complete:${index}` });
      }
    }
    const memory = await f.call('read_step_memory', { projectId: f.run.projectId, nodeId: 'step' });
    assert.equal(memory.data.entries.length, 4);
    assert.equal(memory.data.entries[3].summary, `3\n${text}`);
    const aggregates = f.store.rows('SELECT id FROM contents').filter(row => {
      try { const value = JSON.parse(f.store.content(row.id).toString('utf8')); return Array.isArray(value.entries) && value.entries.some(entry => String(entry.summary || '').includes(text)); } catch { return false; }
    });
    assert.equal(aggregates.length, 0, 'authoritative history must not save growing copies of every previous handoff');
    let reads = 0;
    const client = new RunLifecycleClient(async (operation, input) => { if (operation === 'read_run_settlements') reads++; return f.call(operation, operation === 'read_run_settlements' ? { ...input, limit: 1 } : input); });
    const ref = runStatusReference(f.project, 1); const current = await client.readStatus(ref);
    const turn = await client.readSettlements(ref, current);
    assert.equal(turn.length, 1); assert.equal(reads, 1);
  } finally { await f.close(); }
});

test('settlement claims fence concurrent windows and commit full journal, digest, handoff and learning once without business files', async () => {
  const f = await fixture();
  try {
    const lease = await f.call('claim_run_consumer', { ...f.scope, owner: f.owner });
    assert.ok(lease.token);
    assert.equal(await f.call('claim_run_consumer', { ...f.scope, owner: { ...f.owner, id: 'another-live-window' } }), null);
    assert.deepEqual(await f.call('claim_run_consumer', { ...f.scope, owner: f.owner }), lease);
    const input = result(f, lease);
    const committed = await f.call('commit_run_settlement', input);
    assert.equal(committed.status.status, 'Waiting');
    assert.deepEqual(await f.call('commit_run_settlement', input), committed);
    const history = await f.call('read_run_settlements', { projectId: f.run.projectId, executionLogId: 1 });
    assert.equal(history.items.length, 1);
    assert.deepEqual(history.items[0].journal, input.journal);
    assert.deepEqual(history.items[0].digest, input.digest);
    assert.deepEqual(history.items[0].handoff, input.handoff);
    assert.deepEqual(history.items[0].learning, input.learning);
    const journal = await f.call('read_run_turn_journal', { projectId: f.run.projectId, executionLogId: 1, turnId: f.run.turnId });
    assert.equal(journal.entry.output, input.journal.output);
    assert.equal((await f.call('read_step_memory', { projectId: f.run.projectId, nodeId: 'step' })).data.entries.length, 1);
    const event = f.store.read(history.items[0].learningEventId);
    assert.equal(event.kind, 'learning_event'); assert.equal(event.data.source_object_id, f.run.turnId);
    assert.deepEqual(fs.readdirSync(path.join(f.project, '.solopreneur')), ['project.json']);
    assert.equal(await f.call('claim_run_consumer', { ...f.scope, expectedRevision: committed.revision, owner: f.owner }), null);
  } finally { await f.close(); }
});

test('a new turn rejects an unfinished old settlement without any journal, learning or handoff side effects', async () => {
  const f = await fixture();
  try {
    const lease = await f.call('claim_run_consumer', { ...f.scope, owner: f.owner });
    const current = await f.call('read_run_checkpoint_state', { projectId: f.run.projectId, executionLogId: 1 });
    await f.call('checkpoint_run', { projectId: f.run.projectId, executionLogId: 1, generation: current.generation, proof: current.proof, expectedRevision: current.revision, expectedTurnId: current.turnId, action: 'start', message: '新轮次', idempotencyKey: 'newer-settlement-turn' });
    await assert.rejects(f.call('commit_run_settlement', result(f, lease)), /run_consumer_source_changed/);
    assert.equal((await f.call('read_run_settlements', { projectId: f.run.projectId, executionLogId: 1 })).items.length, 0);
    assert.equal(await f.call('read_step_memory', { projectId: f.run.projectId, nodeId: 'step' }), null);
    assert.match((await f.call('read_run_turn_journal', { projectId: f.run.projectId, executionLogId: 1, turnId: f.run.turnId })).entry.output, /全部结论/);
  } finally { await f.close(); }
});

test('the durable queue settles a previous completed turn after a new turn starts without changing the new turn', async () => {
  const f = await fixture();
  try {
    const current = await f.call('read_run_checkpoint_state', { projectId: f.run.projectId, executionLogId: 1 });
    const next = await f.call('checkpoint_run', { projectId: f.run.projectId, executionLogId: 1, generation: current.generation, proof: current.proof, expectedRevision: current.revision, expectedTurnId: current.turnId, action: 'start', message: '第二轮原始目标', idempotencyKey: 'queue-next-turn' });
    const pending = await f.call('list_run_states', { projectId: f.run.projectId, pendingConsumer: true });
    assert.equal(pending.items.length, 1); assert.equal(pending.items[0].turnId, f.run.turnId);
    assert.equal(pending.items[0].revision, f.done.revision);
    const lease = await f.call('claim_run_consumer', { ...f.scope, owner: f.owner });
    assert.ok(lease);
    const settled = await f.call('commit_run_settlement', result(f, lease));
    assert.equal(settled.turnId, next.turnId); assert.equal(settled.status.status, 'Running');
    assert.equal(settled.status.userMessage, '第二轮原始目标');
    assert.equal((await f.call('list_run_states', { projectId: f.run.projectId, pendingConsumer: true })).items.length, 0);
    assert.equal((await f.call('read_run_turn_journal', { projectId: f.run.projectId, executionLogId: 1, turnId: next.turnId })).entry.status, 'Running');
    assert.equal((await f.call('read_run_turn_journal', { projectId: f.run.projectId, executionLogId: 1, turnId: f.run.turnId })).entry.output, result(f, lease).journal.output);
  } finally { await f.close(); }
});

test('a dead consumer lease survives owner restart and can be taken over without replacing an active owner', async () => {
  const f = await fixture();
  try {
    const abandoned = await f.call('claim_run_consumer', { ...f.scope, owner: { id: 'dead-window', pid: 2147483647, birth: 'proc:gone' } });
    await f.ops.close(); f.store.close();
    f.store = new UnifiedDataStore(f.root); f.ops = createRuntimeDataOperations(f.store);
    f.call = (operation, input) => f.ops({ operation, input });
    const recovered = await f.call('claim_run_consumer', { ...f.scope, owner: f.owner });
    assert.notEqual(recovered.token, abandoned.token);
    await assert.rejects(f.call('commit_run_settlement', result(f, abandoned)), /run_consumer_lease_lost/);
    assert.equal((await f.call('commit_run_settlement', result(f, recovered))).status.status, 'Waiting');
  } finally { await f.close(); }
});

test('closing an already settled session preserves one learning source and one handoff per completed turn', async () => {
  const f = await fixture();
  try {
    const firstLease = await f.call('claim_run_consumer', { ...f.scope, owner: f.owner });
    const effect = { kind: 'automation', payload: { exactGoal: '同轮只推进一次' } };
    await f.call('commit_run_settlement', { ...result(f, firstLease), effects: [effect] });
    const current = await f.call('read_run_checkpoint_state', { projectId: f.run.projectId, executionLogId: 1 });
    const closed = await f.call('checkpoint_run', { projectId: f.run.projectId, executionLogId: 1, generation: current.generation, proof: current.proof, expectedRevision: current.revision, expectedTurnId: current.turnId, action: 'session-close', exitCode: 0, idempotencyKey: 'settled-session-closed' });
    f.scope = { ...f.scope, expectedRevision: closed.revision };
    const closeLease = await f.call('claim_run_consumer', { ...f.scope, owner: f.owner });
    const input = { ...result(f, closeLease), effects: [effect, { kind: 'refresh', payload: {} }], idempotencyKey: 'closed-session-settlement' };
    assert.equal((await f.call('commit_run_settlement', input)).status.status, 'Processed');
    const history = await f.call('read_run_settlements', { projectId: f.run.projectId, executionLogId: 1 });
    assert.equal(history.items.length, 2);
    assert.equal(history.items[0].learningEventId, history.items[1].learningEventId);
    const pending = (await f.call('list_run_effects', { projectId: f.run.projectId })).items;
    assert.equal(pending.filter(item => item.kind === 'automation').length, 1, 'session closure must not create another business action for the same turn');
    assert.equal(pending.filter(item => item.kind === 'refresh').length, 1);
    assert.equal((await f.call('read_step_memory', { projectId: f.run.projectId, nodeId: 'step' })).data.entries.length, 1);
  } finally { await f.close(); }
});

test('a live unattended checkpoint is not consumed until its host finalizes complete evidence', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-host-seal-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  let store = new UnifiedDataStore(root); let ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const run = await call('prepare_run', { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'flow_planner', prompt: '完整输入', command: 'actual CLI', userMessage: '完整目标', metadata: { agentPid: process.pid, interactiveSession: false }, idempotencyKey: 'host-seal-prepare' });
    const scope = { projectId: run.projectId, executionLogId: 1, generation: run.generation };
    await call('append_run_log', { ...scope, stream: 'stdout', sequence: 0, offset: 0, bytes: Buffer.from('prefix').toString('base64'), idempotencyKey: 'host-seal-prefix' });
    const completed = await call('checkpoint_run', { ...scope, proof: run.proof, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'partial', summary: '业务结果', idempotencyKey: 'host-seal-business-complete' });
    assert.equal((await call('list_run_states', { projectId: run.projectId, pendingConsumer: true })).items.length, 0);
    await call('append_run_log', { ...scope, stream: 'stdout', sequence: 1, offset: 6, bytes: Buffer.from('full result🌿').toString('base64'), idempotencyKey: 'host-seal-tail' });
    fs.writeFileSync(path.join(project, 'after.txt'), '实际后续产物');
    const intent = { ...scope, proof: run.proof, expectedRevision: completed.revision, expectedTurnId: run.turnId, exitCode: 0, source: 'host', idempotencyKey: 'host-seal-finalize' };
    const finalized = await call('finalize_run_output', intent);
    assert.equal(finalized.status.turnLogEndOffsets.output, Buffer.byteLength('prefixfull result🌿'));
    assert.equal(finalized.status.hostOutputPending, false);
    assert.equal((await call('list_run_states', { projectId: run.projectId, pendingConsumer: true })).items.length, 1);
    assert.equal((await call('finalize_run_output', intent)).receipt.requestId, finalized.receipt.requestId);
    await ops.close(); store.close(); store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store);
    assert.equal((await call('finalize_run_output', intent)).receipt.requestId, finalized.receipt.requestId);
    assert.equal((await call('list_run_states', { projectId: run.projectId, pendingConsumer: true })).items.length, 1);
  } finally { await ops.close(); store.close(); }
});
