const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');

async function fixture(action) {
  const store = new UnifiedDataStore(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-authority-')));
  const operations = createRuntimeDataOperations(store);
  const project = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'project', data: { name: 'authority' } }).objectId;
  const session = await operations({ operation: 'open_mcp_session', input: { projectId: project } });
  const call = (operation, input) => operations({ operation, input, sessionToken: session.sessionToken });
  try { await action({ store, operations, project, session, call }); } finally { store.close(); }
}

for (const change of [{ status: 'revoked' }, { valid_until: 1 }, { action_set_json: { schemaVersion: 1, actions: ['read'] } }]) {
  test(`existing connection observes grant changes ${JSON.stringify(change)}`, () => fixture(async ({ store, project, session, call }) => {
    const grant = store.search({ scope: project, kinds: ['grant'] }).items.find(item => item.data.actor_id === session.authorityActorId);
    store.write({ kind: 'grant', action: 'patch', scope: project, objectId: grant.objectId, expectedRevision: grant.revision, idempotencyKey: 'revoke', data: change });
    await assert.rejects(call('write', { kind: 'memory', action: 'create', scope: project, idempotencyKey: 'denied', data: { category: 'project', title: 'claim', status: 'candidate', content: 'claim' } }), /action_denied/);
    assert.equal(store.search({ scope: project, kinds: ['memory'] }).items.length, 0);
  }));
}

test('project session cannot mutate a readable global object through link', () => fixture(async ({ store, project, call }) => {
  const global = store.write({ kind: 'lesson', action: 'create', scope: null, idempotencyKey: 'global', data: { status: 'approved', summary: 'approved global' } });
  const local = store.write({ kind: 'lesson', action: 'create', scope: null, idempotencyKey: 'local', data: { status: 'approved', summary: 'second global' } });
  await assert.rejects(call('link', { source: global.objectId, relation: 'source', target: local.objectId, expectedRevision: 1, idempotencyKey: 'link' }), /scope_denied/);
  assert.equal(store.read(global.objectId).revision, 1);
}));

test('unapproved global memory cannot consume a project context page or budget before readable memory', () => fixture(async ({ store, project, call }) => {
  const memories = Array.from({ length: 502 }, (_, i) => String(i)).map(key => store.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: key, data: { category: 'rules', title: '候选', status: 'candidate', content: '未确认' } })).sort((a, b) => a.objectId.localeCompare(b.objectId));
  const candidate = memories[0];
  const approved = store.write({ kind: 'memory', action: 'patch', scope: null, objectId: memories[memories.length - 1].objectId, expectedRevision: 1, idempotencyKey: 'approve-context', data: { title: '可信记忆', status: 'verified', content: '已确认且可读取的完整规则' } });
  const budget = JSON.stringify(store.read(approved.objectId)).length + 20;
  const context = await call('context', { project, budget });
  assert.deepEqual(context.items.map(item => item.objectId), [approved.objectId]);
  assert.equal(context.items[0].data.content, '已确认且可读取的完整规则');
  await assert.rejects(call('read', { ref: candidate.objectId }), /scope_denied/);
}));

test('reviewed content cannot be rewritten by an ordinary agent while preserving its approval', () => fixture(async ({ store, project, call }) => {
  const memory = store.write({ kind: 'memory', action: 'create', scope: project, idempotencyKey: 'reviewed', data: { category: 'project', title: 'reviewed', status: 'verified', content: 'reviewed content' } });
  await assert.rejects(call('write', { kind: 'memory', action: 'patch', scope: project, objectId: memory.objectId, expectedRevision: 1, idempotencyKey: 'rewrite', data: { content: 'unreviewed replacement' } }), /promotion_requires_existing_review/);
  assert.equal(store.read(memory.objectId).data.content, 'reviewed content');
}));

test('ordinary agent cannot forge the host actor on an evidence record', () => fixture(async ({ store, project, call }) => {
  await assert.rejects(call('write', { kind: 'evidence', action: 'create', scope: project, idempotencyKey: 'forged', data: { type: 'host_verified', source_actor_id: 'local-runtime', content: 'claim', observed_at: Date.now() } }), /host_observation_requires_authorization/);
  assert.equal(store.search({ scope: project, kinds: ['evidence'] }).items.length, 0);
}));

test('ordinary agent task proposal cannot declare a completed host task', () => fixture(async ({ store, project, call }) => {
  const conversation = store.write({ kind: 'conversation', action: 'create', scope: project, idempotencyKey: 'conversation', data: { mode: 'solo', status: 'active', title: 'conversation' } });
  await assert.rejects(call('write', { kind: 'task', action: 'create', scope: project, idempotencyKey: 'complete', data: { conversation_id: conversation.objectId, original_request_content: 'request', status: 'completed' } }), /host_observation_requires_authorization/);
}));

test('closing a connection invalidates its credentials without resetting the connector grant', () => fixture(async ({ store, operations, project, session }) => {
  await operations({ operation: 'close_mcp_session', input: { sessionToken: session.sessionToken } });
  assert.equal(store.search({ scope: project, kinds: ['grant'] }).items[0].data.status, 'active');
  await assert.rejects(operations({ operation: 'open_mcp_session', input: { projectId: project, resume: { actorId: session.actorId, proof: session.proof } } }), /actor_resume_denied/);
}));

test('an ordinary evidence claim gets its actual connection source and replays the same receipt', () => fixture(async ({ store, project, session, call }) => {
  const input = { kind: 'evidence', action: 'create', scope: project, idempotencyKey: 'claim', data: { type: 'agent_claim', content: 'self-reported evidence' } };
  const receipt = await call('write', input);
  const object = store.read(receipt.objectId);
  assert.equal(object.data.source_actor_id, session.actorId);
  assert.ok(object.data.observed_at > 0);
  assert.deepEqual(await call('write', input), receipt);
}));

for (const kind of ['roadmap_node', 'memory']) {
  test(`ordinary connection cannot modify protected ${kind} through a relationship`, () => fixture(async ({ store, project, call }) => {
    const object = store.write({ kind, action: 'create', scope: project, idempotencyKey: `protected-${kind}`, data: kind === 'memory' ? { category: 'project', title: 'reviewed', status: 'verified', content: 'reviewed' } : { local_node_id: 'protected', title: 'protected', status: 'pending' } });
    const target = store.write({ kind: 'memory', action: 'create', scope: project, idempotencyKey: 'target', data: { category: 'project', title: 'target', status: 'candidate', content: 'target' } });
    await assert.rejects(call('link', { source: object.objectId, target: target.objectId, relation: 'supersedes', expectedRevision: 1, idempotencyKey: 'bypass' }), /action_requires_existing_authorization|promotion_requires_existing_review/);
    assert.equal(store.read(object.objectId).revision, 1);
  }));
}

for (const restriction of [{ status: 'revoked' }, { valid_until: 1 }, { action_set_json: { schemaVersion: 1, actions: ['read'] } }]) {
  test(`reconnecting cannot reset the connector restriction ${JSON.stringify(restriction)}`, () => fixture(async ({ store, operations, project, session }) => {
    const grant = store.search({ scope: project, kinds: ['grant'] }).items[0];
    store.write({ kind: 'grant', action: 'patch', scope: project, objectId: grant.objectId, expectedRevision: grant.revision, idempotencyKey: 'restrict-connector', data: restriction });
    if (restriction.action_set_json) {
      const reconnected = await operations({ operation: 'open_mcp_session', input: { projectId: project } });
      await assert.rejects(operations({ operation: 'write', input: { kind: 'memory', action: 'create', scope: project, idempotencyKey: 'reconnected-write', data: { category: 'project', title: 'claim', status: 'candidate', content: 'claim' } }, sessionToken: reconnected.sessionToken }), /action_denied/);
      assert.notEqual(reconnected.actorId, session.actorId);
    } else {
      await assert.rejects(operations({ operation: 'open_mcp_session', input: { projectId: project } }), /actor_resume_denied|action_denied/);
    }
    assert.equal(store.search({ scope: project, kinds: ['grant'] }).items.length, 1);
  }));
}
