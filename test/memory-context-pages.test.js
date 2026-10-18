const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');
const { openDataClient } = require('../resources/tools/solomap-data-client.cjs');

async function fixture(action) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-context-'));
  const root = path.join(base, '.solomap-global'); const workspace = path.join(base, 'project'); fs.mkdirSync(workspace);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'memory-context-owner', onCommand: () => ({ status: 'running' }), onData: ops });
  let client;
  try {
    const project = await ops({ operation: 'register_project', input: { root: workspace } });
    client = await openDataClient(root, workspace, null);
    const write = (scope, key, extra = {}) => store.write({ kind: 'memory', action: 'create', scope, idempotencyKey: key, data: { category: 'rules', title: key, status: 'active', content: '完整记忆正文🌿'.repeat(10000), ...extra } });
    await action({ store, client, project: project.projectId, write });
  } finally { if (client) await client.close(); await server.close(); await ops.close(); store.close(); }
}

test('ordinary memory context pages references without decoding or losing large eligible bodies', () => fixture(async ({ store, client, project, write }) => {
  const local = [write(project, 'local-a'), write(project, 'local-b')];
  const global = [write(null, 'global-a'), write(null, 'global-b')];
  write(null, 'unreviewed-global', { status: 'candidate' });
  write(project, 'future', { valid_from: Date.now() + 60000 });
  write(project, 'expired', { valid_until: Date.now() - 1 });
  write(project, 'withdrawn', { status: 'invalidated' });
  const other = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'other', data: { name: 'other' } });
  write(other.objectId, 'private');
  const ids = new Set([...local, ...global].map(item => store.readMetadata(item.objectId).data.content_id));
  const original = store.contentRange.bind(store); let decodes = 0;
  store.contentRange = (...args) => { if (ids.has(args[0])) decodes++; return original(...args); };
  let cursor; const items = [];
  try {
    do {
      const page = await client.call('context', { project, view: 'metadata', limit: 1, budget: 1, ...(cursor ? { cursor } : {}) });
      assert.equal(page.items.length, 1, 'the full-text budget must not hide a readable reference');
      assert.equal(page.sourceChanged, false);
      assert.ok(page.items.length <= 1);
      assert.ok(page.items.every(item => !Object.hasOwn(item.data, 'content')));
      items.push(...page.items); cursor = page.cursor;
    } while (cursor);
    assert.deepEqual(items.map(item => item.objectId).sort(), [...local, ...global].map(item => item.objectId).sort());
    assert.equal(decodes, 0);
  } finally { store.contentRange = original; }
  const body = await client.content(items.find(item => item.objectId === local[0].objectId));
  assert.equal(body, '完整记忆正文🌿'.repeat(10000));
  await assert.rejects(client.call('context', { project: other.objectId, view: 'metadata' }), /scope_denied/);
}));

test('memory context detects global updates between pages while unrelated project writes can finish', () => fixture(async ({ store, client, project, write }) => {
  write(project, 'first-local'); write(project, 'second-local');
  const global = write(null, 'global');
  const first = await client.call('context', { project, view: 'metadata', limit: 1 });
  assert.ok(first.cursor);
  const other = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'other', data: { name: 'other' } });
  write(other.objectId, 'unrelated');
  const second = await client.call('context', { project, view: 'metadata', limit: 1, cursor: first.cursor });
  assert.equal(second.sourceChanged, false);
  store.write({ kind: 'memory', action: 'patch', scope: null, objectId: global.objectId, expectedRevision: 1, idempotencyKey: 'global-update', data: { content: '变化后的完整来源' } });
  const changed = await client.call('context', { project, view: 'metadata', limit: 1, cursor: second.cursor });
  assert.equal(changed.sourceChanged, true); assert.deepEqual(changed.items, []); assert.equal(changed.cursor, null);
  await assert.rejects(client.call('context', { project, view: 'metadata', query: 'different', cursor: first.cursor }), /cursor_scope_mismatch/);
}));

test('ordinary context matches concrete alternative terms through the full-content index', () => fixture(async ({ store, client, project, write }) => {
  const nonce = write(project, 'nonce', { content: 'OAuth 回调必须验证 nonce。' });
  const startup = write(null, 'startup', { content: 'Webview 首屏独立加载。' });
  const irrelevant = Array.from({ length: 30 }, (_, i) => write(project, `billing-${i}`, { content: '计费与无关历史🌿'.repeat(5000) }));
  const ids = new Set(irrelevant.map(item => store.readMetadata(item.objectId).data.content_id));
  const original = store.contentRange.bind(store); let unrelatedDecodes = 0;
  store.contentRange = (...args) => { if (ids.has(args[0])) unrelatedDecodes++; return original(...args); };
  const matches = []; let cursor;
  try {
    do {
      const page = await client.call('context', { project, view: 'metadata', terms: ['nonce', 'Webview'], limit: 1, ...(cursor ? { cursor } : {}) });
      matches.push(...page.items); cursor = page.cursor;
    } while (cursor);
    assert.deepEqual(matches.map(item => item.objectId).sort(), [nonce.objectId, startup.objectId].sort());
    assert.equal(unrelatedDecodes, 0);
  } finally { store.contentRange = original; }
}));

test('term-free ordinary search resumes cursors from the established contract', () => fixture(async ({ client, project, write }) => {
  write(project, 'old-cursor-a'); write(project, 'old-cursor-b');
  const first = await client.call('search', { scope: project, kinds: ['memory'], limit: 1 });
  const cursor = JSON.parse(Buffer.from(first.cursor, 'base64url').toString('utf8'));
  cursor.fingerprint = crypto.createHash('sha256').update(JSON.stringify({ kinds: ['memory'], query: '', scope: project })).digest('hex');
  const next = await client.call('search', { scope: project, kinds: ['memory'], limit: 1, cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url') });
  assert.equal(next.items.length, 1); assert.notEqual(next.items[0].objectId, first.items[0].objectId);
}));
