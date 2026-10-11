const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');

async function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-step-memory-database-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  let store = new UnifiedDataStore(root); let ops = createRuntimeDataOperations(store);
  const identity = await ops({ operation: 'register_project', input: { root: project } });
  return { root, project, identity, store: () => store, call: (operation, input) => ops({ operation, input }),
    async reopen() { await ops.close(); store.close(); store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store); },
    async close() { await ops.close(); store.close(); } };
}

test('formal completion criteria and metadata preserve all values, fixed revisions, concurrent patches and restart without producing files', async () => {
  const f = await fixture();
  const scope = { root: f.project, nodeId: 'step' };
  const criteria = Array.from({ length: 25 }, (_, index) => `第${index}条用户完整完成标准🌿`);
  try {
    const first = await f.call('write_step_memory', { ...scope, expectedRevision: 0, patch: { completionCriteria: criteria, custom: '正式元数据' }, idempotencyKey: 'criteria-first' });
    assert.equal(first.revision, 1); assert.deepEqual(first.data.completionCriteria, criteria);
    assert.equal((await f.call('read_step_memory', scope)).revision, first.revision);
    const second = await f.call('write_step_memory', { ...scope, expectedRevision: 1, patch: { lastCompletionEvidence: ['完整证据'] }, idempotencyKey: 'criteria-second' });
    await assert.rejects(f.call('write_step_memory', { ...scope, expectedRevision: 1, patch: { custom: '迟到覆盖' }, idempotencyKey: 'criteria-stale' }), /revision_conflict/);
    const retry = await f.call('write_step_memory', { ...scope, expectedRevision: 2, patch: { custom: '经过协调的新值' }, idempotencyKey: 'criteria-stale' });
    assert.equal(retry.revision, 3); assert.deepEqual(retry.data.completionCriteria, criteria);
    assert.deepEqual(await f.call('write_step_memory', { ...scope, expectedRevision: 1, patch: { lastCompletionEvidence: ['完整证据'] }, idempotencyKey: 'criteria-second' }), second);
    await f.reopen();
    const historical = await f.call('read_step_memory', { ...scope, revision: 1 });
    assert.equal(historical.data.custom, '正式元数据'); assert.deepEqual(historical.data.completionCriteria, criteria);
    assert.deepEqual((await f.call('read_step_memory', { ...scope, includeEntries: false })).data, { completionCriteria: criteria, custom: '经过协调的新值', lastCompletionEvidence: ['完整证据'] });
    const formal = await f.call('read', { ref: first.objectId, view: 'full' });
    assert.deepEqual(JSON.parse(formal.data.content).data.completionCriteria, criteria, 'the same evidence must be available through ordinary MCP read');
    assert.deepEqual(fs.readdirSync(path.join(f.project, '.solopreneur')), ['project.json']);
    await assert.rejects(f.call('write_step_memory', { ...scope, expectedRevision: 3, patch: { entries: [] }, idempotencyKey: 'criteria-forge-entries' }), /step_handoff_requires_settlement/);
  } finally { await f.close(); }
});

test('new handoffs reference unchanged large step metadata without decoding or copying it each turn', async t => {
  const f = await fixture(); const store = f.store(); const originalContent = store.content;
  const large = '必须完整保留的原始元数据🌿'.repeat(50000); let decoded = 0;
  try {
    await f.call('write_step_memory', { root: f.project, nodeId: 'step', expectedRevision: 0, patch: { completionCriteria: ['完整用户标准'], largeUnknownMetadata: large }, idempotencyKey: 'large-step-metadata' });
    const metadataId = store.rows('SELECT content_id FROM project_step_memory WHERE project_id=? AND node_key=?', [f.identity.projectId, 'step'])[0].content_id;
    store.content = function(id, ...args) { if (id === metadataId) decoded++; return originalContent.call(this, id, ...args); };
    for (let id = 1; id <= 12; id++) {
      const run = await f.call('prepare_run', { root: f.project, executionLogId: id, nodeId: 'step', runKind: 'step', prompt: '本轮目标', command: 'actual command', userMessage: '用户本轮请求', metadata: { interactiveSession: true }, idempotencyKey: `large-step-run:${id}` });
      const done = await f.call('checkpoint_run', { projectId: run.projectId, executionLogId: id, generation: run.generation, proof: run.proof, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'partial', summary: '本轮正式结果', idempotencyKey: `large-step-done:${id}` });
      const scope = { projectId: run.projectId, executionLogId: id, generation: done.generation, expectedRevision: done.revision, expectedTurnId: done.turnId };
      const lease = await f.call('claim_run_consumer', { ...scope, owner: { id: 'retained-owner', pid: process.pid, birth: 'live-test-owner' } });
      await f.call('commit_run_settlement', { ...scope, token: lease.token, journal: { agentCli: 'claude', command: 'actual command', output: '实际完整结果', status: 'In Progress' }, digest: { schemaVersion: 2, nodeId: 'step', executionLogId: id, runId: `step:${id}` }, handoff: { usefulSignals: `第${id}轮完整交接` }, idempotencyKey: `large-step-settle:${id}` });
    }
    const handoffMetadataDecodes = decoded;
    store.content = originalContent;
    const memory = await f.call('read_step_memory', { root: f.project, nodeId: 'step' });
    assert.equal(memory.data.largeUnknownMetadata, large); assert.equal(memory.data.entries.length, 12);
    const largeCopies = store.rows('SELECT id FROM contents').filter(row => originalContent.call(store, row.id).includes(Buffer.from(large))).length;
    t.diagnostic(JSON.stringify({ handoffs: 12, metadataBytes: Buffer.byteLength(large), handoffMetadataDecodes, largeCopies, storedContents: store.rows('SELECT SUM(byte_length) AS logicalBytes,SUM(stored_byte_length) AS storedBytes FROM contents')[0] }));
    assert.equal((await f.call('read_step_memory_state', { root: f.project })).revision, 1, 'unchanged metadata handoffs cannot invalidate all visible node criteria');
    assert.equal(handoffMetadataDecodes, 0, 'adding a handoff must carry forward the immutable metadata reference without reading its large body');
    assert.ok(largeCopies <= 2, `twelve unchanged handoffs cannot add another full metadata prefix: ${largeCopies} copies`);
  } finally { store.content = originalContent; await f.close(); }
});


test('step memory freshness is project scoped, indexed, durable and unchanged on receipt replay or rejected writes', async t => {
  const f = await fixture(); const second = path.join(f.root, 'other-project'); fs.mkdirSync(second);
  const other = await f.call('register_project', { root: second });
  try {
    assert.deepEqual(await f.call('read_step_memory_state', { root: f.project }), { revision: 0 });
    const input = { root: f.project, nodeId: 'step', expectedRevision: 0, patch: { completionCriteria: ['原用户标准'] }, idempotencyKey: 'freshness-write' };
    await f.call('write_step_memory', input);
    assert.deepEqual(await f.call('read_step_memory_state', { root: f.project }), { revision: 1 });
    await f.call('write_step_memory', input);
    await assert.rejects(f.call('write_step_memory', { ...input, patch: { completionCriteria: ['迟到修改'] }, idempotencyKey: 'freshness-conflict' }), /revision_conflict/);
    assert.deepEqual(await f.call('read_step_memory_state', { root: f.project }), { revision: 1 });
    assert.deepEqual(await f.call('read_step_memory_state', { projectId: other.projectId }), { revision: 0 });
    await f.reopen();
    assert.deepEqual(await f.call('read_step_memory_state', { root: f.project }), { revision: 1 });
    const store = f.store(); const content = store.content; let decoded = 0;
    store.content = function(...args) { decoded++; return content.apply(this, args); };
    for (let index = 0; index < 20; index++) await f.call('read_step_memory_state', { projectId: f.identity.projectId });
    store.content = content;
    const plan = store.rows('EXPLAIN QUERY PLAN SELECT revision FROM project_step_memory_state WHERE project_id=?', [f.identity.projectId]);
    t.diagnostic(JSON.stringify({ repeatedReads: 20, contentDecodes: decoded, queryPlan: plan }));
    assert.equal(decoded, 0); assert.ok(plan.some(row => /SEARCH.*project_step_memory_state.*INDEX/.test(row.detail)));
  } finally { await f.close(); }
});
