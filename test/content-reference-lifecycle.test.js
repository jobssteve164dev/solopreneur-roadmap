const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-reference-lifecycle-'));
  const store = new UnifiedDataStore(root);
  t.after(() => {
    store.close();
    for (const name of fs.readdirSync(root)) {
      const file = path.join(root, name);
      assert.ok(fs.lstatSync(file).isFile(), 'only this fixture database files may be removed');
      fs.unlinkSync(file);
    }
    fs.rmdirSync(root);
  });
  return store;
}
function drain(store) {
  for (let i = 0; i < 1000; i++) {
    const batch = store.prepareStorageReferenceBatch(128);
    store.commitStorageReferenceBatch(batch);
    if (!batch.pending) return;
  }
  assert.fail('reference index did not converge');
}
test('reference indexing preserves recursive reference grammar independently of MIME', t => {
  const store = fixture(t);
  const nested = store.putContent('leaf'), target = store.putContent('other leaf');
  const source = store.putContent(JSON.stringify({
    nested: [{ bodyContentId: nested }], ContentIds: [target, { contentId: 'ignored-array-object' }],
    sourceContents: { body: nested, ignored: { contentId: 'ignored-map-object' } },
    bodyContentId: { contentId: 'reachable-nested-object' }
  }), 'application/octet-stream', 'binary');
  drain(store);
  const edges = store.rows('SELECT target_id FROM content_lifecycle_edges WHERE source_id=? ORDER BY target_id', [source]);
  assert.deepEqual(edges.map(row => row.target_id), [nested, target, 'reachable-nested-object'].sort());
  const before = store.rows('SELECT total_changes() AS n')[0].n;
  drain(store);
  assert.equal(store.rows('SELECT total_changes() AS n')[0].n, before, 'unchanged maintenance is read-only');
});
test('large reference summaries commit bounded pages and resume after Worker restart', async t => {
  let worker;
  t.after(async () => { if (worker) await worker.terminate(); });
  const store = fixture(t), targets = Array.from({ length: 301 }, (_, i) => `target-${i}`);
  const source = store.putContent(JSON.stringify({ sourceContents: Object.fromEntries(targets.map((id, i) => [i, id])) }));
  async function start() {
    worker = new Worker(path.resolve(__dirname, '../out/maintenanceComputeWorker.js'), { workerData: { root: store.root, databaseId: store.databaseId } });
    await once(worker, 'message');
  }
  async function prepare(id) {
    const reply = once(worker, 'message');
    worker.postMessage({ id, operation: 'prepare_storage_reference_batch', limit: 128 });
    const [message] = await reply;
    assert.equal(message.error, undefined);
    return message.result;
  }
  await start();
  const first = await prepare(1);
  assert.equal(first.sourceId, source);
  assert.equal(first.targets.length, 128);
  assert.equal(first.complete, false);
  assert.equal(store.commitStorageReferenceBatch(first).applied, true);
  await worker.terminate(); worker = undefined;
  await start();
  const second = await prepare(2);
  assert.equal(second.offset, 128);
  assert.equal(second.targets.length, 128);
  assert.equal(store.commitStorageReferenceBatch(first).applied, false, 'late first page cannot double advance');
  store.commitStorageReferenceBatch(second);
  const final = await prepare(3);
  assert.equal(final.targets.length, 45);
  assert.equal(final.complete, true);
  store.commitStorageReferenceBatch(final);
  assert.deepEqual(store.rows('SELECT target_id FROM content_lifecycle_edges WHERE source_id=? ORDER BY target_id', [source]).map(row => row.target_id), targets.sort());
});
test('new reference source invalidates an older summary even when the identity and hash are unchanged', t => {
  const store = fixture(t), source = store.putContent(JSON.stringify({ contentId: 'retained-target' }));
  const stale = store.prepareStorageReferenceBatch(128);
  const row = store.rows('SELECT data FROM contents WHERE id=?', [source])[0];
  store.db.run('UPDATE contents SET data=? WHERE id=?', [row.data, source]);
  assert.equal(store.commitStorageReferenceBatch(stale).applied, false);
  drain(store);
  assert.deepEqual(store.rows('SELECT target_id FROM content_lifecycle_edges WHERE source_id=?', [source]).map(row => row.target_id), ['retained-target']);
});
test('queued writes cannot advance past unindexed historical contents', t => {
  const store = fixture(t);
  function insert(id, target) {
    const bytes = Buffer.from(JSON.stringify({ contentId: target }));
    const hash = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    store.db.run('INSERT INTO contents VALUES(?,?,?,?,?,?,?,NULL)', [id, hash, 'text/plain', 'utf8', bytes.length, bytes.length, bytes]);
  }
  insert('a', 'first'); insert('b', 'middle'); insert('z', 'last');
  store.db.run('DELETE FROM content_lifecycle_reference_pending');
  store.db.run("UPDATE content_lifecycle_reference_progress SET cursor='',upper_id='z',prefer_pending=0 WHERE id=1");
  const first = store.prepareStorageReferenceBatch(128);
  assert.equal(first.sourceId, 'a'); store.commitStorageReferenceBatch(first);
  store.db.run("UPDATE contents SET data=data WHERE id='z'");
  const queued = store.prepareStorageReferenceBatch(128);
  assert.equal(queued.sourceId, 'z'); store.commitStorageReferenceBatch(queued);
  assert.equal(store.rows('SELECT cursor FROM content_lifecycle_reference_progress')[0].cursor, 'a');
  drain(store);
  assert.deepEqual(store.rows("SELECT target_id FROM content_lifecycle_edges WHERE source_id='b'").map(row => row.target_id), ['middle']);
});
test('incomplete and repaired content retains unresolved-reference evidence until reindexed', t => {
  const store = fixture(t), bytes = JSON.stringify({ contentId: 'protected' });
  const id = store.putContent(bytes);
  store.db.run('UPDATE contents SET data=? WHERE id=?', [Buffer.alloc(Buffer.byteLength(bytes), 100), id]);
  drain(store);
  assert.equal(store.rows('SELECT source_id FROM content_lifecycle_reference_faults WHERE source_id=?', [id]).length, 1);
  const changes = store.rows('SELECT total_changes() AS n')[0].n;
  drain(store);
  assert.equal(store.rows('SELECT total_changes() AS n')[0].n, changes);
  assert.equal(store.putContent(bytes), id);
  drain(store);
  assert.equal(store.rows('SELECT source_id FROM content_lifecycle_reference_faults WHERE source_id=?', [id]).length, 0);
  assert.deepEqual(store.rows('SELECT target_id FROM content_lifecycle_edges WHERE source_id=?', [id]).map(row => row.target_id), ['protected']);
});
test('reference rebuild prunes obsolete edges in bounded commits after a failed staged attempt', t => {
  const store = fixture(t), id = store.putContent(JSON.stringify({ bodyContentIds: ['retained'] }));
  for (let i = 0; i < 302; i++) store.db.run('INSERT INTO content_lifecycle_edges VALUES(?,?,?)', [id, `old-${i}`, -1]);
  let commits = 0;
  for (;;) {
    const batch = store.prepareStorageReferenceBatch(128);
    assert.ok(batch.targets.length + batch.prune.length <= 128);
    store.commitStorageReferenceBatch(batch); commits++;
    if (!batch.pending) break;
    assert.ok(commits < 10);
  }
  assert.ok(commits >= 4);
  assert.deepEqual(store.rows('SELECT target_id FROM content_lifecycle_edges WHERE source_id=?', [id]).map(row => row.target_id), ['retained']);
});
test('deep valid historical JSON cannot exhaust the reference parser call stack', t => {
  const store = fixture(t), depth = 12000;
  const id = store.putContent('{"next":'.repeat(depth) + '{"contentId":"deep-target"}' + '}'.repeat(depth));
  drain(store);
  assert.deepEqual(store.rows('SELECT target_id FROM content_lifecycle_edges WHERE source_id=?', [id]).map(row => row.target_id), ['deep-target']);
});
