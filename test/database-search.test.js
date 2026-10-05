const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');

test('indexed search does not load unrelated full bodies and returns metadata with a full-read reference', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-indexed-search-'));
  const store = new UnifiedDataStore(root);
  const project = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'project', data: { name: 'search' } }).objectId;
  const first = store.write({ kind: 'memory', action: 'create', scope: project, idempotencyKey: 'first', data: { category: 'project', title: 'first', status: 'captured', content: '完整中文正文 abc-XYZ 🙂 新目标' } });
  const unrelated = store.write({ kind: 'memory', action: 'create', scope: project, idempotencyKey: 'unrelated', data: { category: 'project', title: 'unrelated', status: 'captured', content: 'unrelated full body'.repeat(100000) } });
  const native = new DatabaseSync(store.filePath);
  native.prepare('UPDATE contents SET sha256=? WHERE id=?').run('0'.repeat(64), store.read(unrelated.objectId).data.content_id);
  try {
    for (const query of ['新目标', '中文', '🙂', 'abc-xy', 'does not exist anywhere']) {
      const result = store.search({ scope: project, query });
      assert.equal(result.items.length, query.startsWith('does') ? 0 : 1);
      if (result.items.length) {
        assert.equal(result.items[0].objectId, first.objectId);
        assert.equal(result.items[0].data.content, undefined);
        assert.ok(result.items[0].data.content_id);
      }
    }
    assert.equal(store.read(first.objectId).data.content, '完整中文正文 abc-XYZ 🙂 新目标');
  } finally { native.close(); store.close(); }
});

test('search sees a patch immediately and removes the previous text from its index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-search-revision-'));
  const store = new UnifiedDataStore(root);
  try {
    const project = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'project', data: { name: 'revision' } }).objectId;
    const memory = store.write({ kind: 'memory', action: 'create', scope: project, idempotencyKey: 'first', data: { category: 'project', title: 'record', status: 'captured', content: 'before value' } });
    store.write({ kind: 'memory', action: 'patch', scope: project, objectId: memory.objectId, expectedRevision: 1, idempotencyKey: 'patch', data: { content: 'after value' } });
    assert.equal(store.search({ scope: project, query: 'before value' }).items.length, 0);
    assert.equal(store.search({ scope: project, query: 'after value' }).items[0].revision, 2);
  } finally { store.close(); }
});
