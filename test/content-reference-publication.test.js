const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { summarizeContentBytes } = require('../out/contentReferences.js');
const { createDatabaseGenerationBaseline } = require('../out/databaseGeneration.js');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-reference-publication-'));
  const store = new UnifiedDataStore(root);
  t.after(() => { store.close(); for (const name of fs.readdirSync(root)) { const file = path.join(root, name); assert.ok(fs.lstatSync(file).isFile()); fs.unlinkSync(file); } fs.rmdirSync(root); });
  return store;
}
function index(store) {
  for (let i = 0; i < 2000; i++) { const batch = store.prepareStorageReferenceBatch(128); store.commitStorageReferenceBatch(batch); if (!batch.pending) return; }
  assert.fail('reference maintenance did not converge');
}
test('structured writes publish bounded final-byte summaries in their original atomic commit', t => {
  const store=fixture(t),target=store.putContent('retained structured target');
  index(store);store.beginContentPreparationRecovery();store.activateStorageContentLifecycle({strictPublication:true});
  const value={description:'规范序列化保持原字节🌿',nested:{contentId:target},otherContentIds:['missing raw identifier',target]};
  const receipt=store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'structured-final-bytes',data:{category:'inbox',title:'structured reference',status:'captured',content:value}});
  const id=store.rows('SELECT content_id FROM memories WHERE id=?',[receipt.objectId])[0].content_id;
  assert.equal(store.content(id).toString(),require('../out/contentReferences.js').canonicalJson(value));
  assert.deepEqual(store.rows('SELECT target_id FROM content_lifecycle_edges WHERE source_id=? ORDER BY target_id',[id]).map(row=>row.target_id),['missing raw identifier',target].sort());
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_reference_unpublished').length,0);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_gc_debt').length,0);
  const snapshot=store.rows('SELECT content_id FROM object_revisions WHERE object_id=?',[receipt.objectId])[0].content_id;
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_edges WHERE source_id=? AND target_id=?',[snapshot,id]).length,1);
  const before=store.rows('SELECT COUNT(*) AS n FROM contents')[0].n;
  assert.deepEqual(store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'structured-final-bytes',data:{category:'inbox',title:'structured reference',status:'captured',content:value}}),receipt);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM contents')[0].n,before);
});
test('inbox publication preserves canonical bytes, references and unchanged replay', t => {
  const store=fixture(t),target=store.putContent('inbox retained source');
  index(store);store.beginContentPreparationRecovery();store.activateStorageContentLifecycle({strictPublication:true});
  const input={channel:'fixture',sourceId:'message',generation:1,payload:{z:'完整消息🌿',nested:{contentId:target}},idempotencyKey:'inbox-reference-publication'};
  const first=store.acceptInboxMessage(input),row=store.rows('SELECT content_id FROM inbox WHERE channel=?',['fixture'])[0];
  assert.equal(store.content(row.content_id).toString(),require('../out/contentReferences.js').canonicalJson(input.payload));
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_edges WHERE source_id=? AND target_id=?',[row.content_id,target]).length,1);
  assert.deepEqual(store.acceptInboxMessage(input),first);
  assert.throws(()=>store.acceptInboxMessage({...input,payload:{contentId:target},idempotencyKey:'inbox-reference-conflict'}),/inbox_identity_conflict/);
});
test('a complete prepared summary transfers to the index without reparsing the body', async t => {
  const store = fixture(t), target = store.putContent('target'), bytes = Buffer.from(JSON.stringify({ contentId: target }));
  const id = store.putContent(bytes);
  await store.withPreparedContentOwnership(async () => store.prepareContentReferencePublication(id, summarizeContentBytes(bytes)));
  const row = store.rows('SELECT * FROM content_lifecycle_reference_pending WHERE content_id=?', [id])[0];
  assert.equal(row.ready, 1);
  const original = store.content.bind(store);
  store.content = contentId => { assert.notEqual(contentId, id, 'the index must consume the completed manifest'); return original(contentId); };
  index(store);
  assert.deepEqual(store.rows('SELECT target_id FROM content_lifecycle_edges WHERE source_id=?', [id]).map(row => row.target_id), [target]);
  assert.equal(store.rows('SELECT * FROM content_lifecycle_reference_preparations').length, 0);
});
test('same-source publication revokes a partial historical job before writing prepared edges', async t => {
  const store = fixture(t), targets = Array.from({ length: 301 }, (_, i) => `target-${i}`), bytes = Buffer.from(JSON.stringify({ sourceContents: Object.fromEntries(targets.map(id => [id, id])) }));
  const id = store.putContent(bytes);
  store.db.run('DELETE FROM content_lifecycle_reference_pending WHERE content_id=?', [id]);
  store.db.run("UPDATE content_lifecycle_reference_progress SET cursor='',upper_id=? WHERE id=1", [id]);
  let first;
  for (let i = 0; i < 200; i++) { const batch = store.prepareStorageReferenceBatch(128); store.commitStorageReferenceBatch(batch); if (batch.sourceId === id) { first = batch; break; } }
  assert.equal(first.complete, false);
  const stale = store.prepareStorageReferenceBatch(128);
  await store.withPreparedContentOwnership(async () => store.prepareContentReferencePublication(id, summarizeContentBytes(bytes)));
  assert.equal(store.commitStorageReferenceBatch(stale).applied, false);
  index(store);
  assert.deepEqual(store.rows('SELECT target_id FROM content_lifecycle_edges WHERE source_id=? ORDER BY target_id', [id]).map(row => row.target_id), targets.sort());
});
test('unrelated ready publication preserves a prepared historical index plan', async t => {
  const store = fixture(t), bytes = Buffer.from('{"contentId":"history-target"}'), source = store.putContent(bytes);
  let plan;
  for (let i = 0; i < 200; i++) { const batch = store.prepareStorageReferenceBatch(128); if (batch.sourceId === source) { plan = batch; break; } store.commitStorageReferenceBatch(batch); }
  const unrelatedBytes = Buffer.from('{"contentId":"other-target"}'), unrelated = store.putContent(unrelatedBytes);
  await store.withPreparedContentOwnership(async () => store.prepareContentReferencePublication(unrelated, summarizeContentBytes(unrelatedBytes)));
  assert.equal(store.commitStorageReferenceBatch(plan).applied, true);
});
test('same-owner duplicate preparations share completion without losing their manifest', async t => {
  const store = fixture(t), bytes = Buffer.from(JSON.stringify({ sourceContents: Object.fromEntries(Array.from({ length: 301 }, (_, i) => [i, `target-${i}`])) }));
  const id = store.putContent(bytes), summary = summarizeContentBytes(bytes);
  await store.withPreparedContentOwnership(async () => {
    await Promise.all([store.prepareContentReferencePublication(id, summary), store.prepareContentReferencePublication(id, summary)]);
  });
  assert.equal(store.rows('SELECT ready FROM content_lifecycle_reference_pending WHERE content_id=?', [id])[0].ready, 1);
});
test('a background index cannot prune a source during its private reference preparation', async t => {
  const store = fixture(t), bytes = Buffer.from(JSON.stringify({ sourceContents: Object.fromEntries(Array.from({ length: 301 }, (_, i) => [i, `target-${i}`])) }));
  const id = store.putContent(bytes), summary = summarizeContentBytes(bytes);
  await store.withPreparedContentOwnership(async () => {
    const writing = store.prepareContentReferencePublication(id, summary);
    const prepared = store.prepareStorageReferenceBatch(128);
    assert.notEqual(prepared.sourceId, id);
    await writing;
  });
  index(store);
  assert.equal(store.rows('SELECT count(*) AS n FROM content_lifecycle_edges WHERE source_id=?', [id])[0].n, 301);
});
test('failed reference preparation releases its owner and returns the source to durable indexing', async t => {
  const store = fixture(t), bytes = Buffer.from(JSON.stringify({ sourceContents: Object.fromEntries(Array.from({ length: 301 }, (_, i) => [i, `target-${i}`])) }));
  const id = store.putContent(bytes);
  let late;
  await assert.rejects(store.withPreparedContentOwnership(async () => {
    late = store.prepareContentReferencePublication(id, summarizeContentBytes(bytes));
    void late.catch(() => undefined);
    throw new Error('cancel this caller');
  }), /cancel this caller/);
  await assert.rejects(late, /prepared_content_owner_finished/);
  assert.equal(store.rows('SELECT * FROM content_lifecycle_reference_preparations WHERE content_id=?', [id]).length, 0);
  assert.equal(store.rows('SELECT ready FROM content_lifecycle_reference_pending WHERE content_id=?', [id])[0].ready, 0);
  index(store);
  assert.equal(store.rows('SELECT count(*) AS n FROM content_lifecycle_edges WHERE source_id=?', [id])[0].n, 301);
});
test('an independent owner completes the same summary after the first caller fails', async t => {
  const store = fixture(t), bytes = Buffer.from(JSON.stringify({ sourceContents: Object.fromEntries(Array.from({ length: 301 }, (_, i) => [i, `target-${i}`])) }));
  const id = store.putContent(bytes), summary = summarizeContentBytes(bytes);
  let late, survivor;
  await assert.rejects(store.withPreparedContentOwnership(async () => {
    late = store.prepareContentReferencePublication(id, summary); void late.catch(() => undefined);
    survivor = store.withPreparedContentOwnership(() => store.prepareContentReferencePublication(id, summary));
    throw new Error('first caller cancelled');
  }), /first caller cancelled/);
  await assert.rejects(late, /prepared_content_owner_finished/);
  await survivor;
  index(store);
  assert.equal(store.rows('SELECT count(*) AS n FROM content_lifecycle_edges WHERE source_id=?', [id])[0].n, 301);
});
test('generation replay preserves private preparation and failed-owner handoff tokens', async t => {
  const store = fixture(t), bytes = Buffer.from(JSON.stringify({ sourceContents: Object.fromEntries(Array.from({ length: 301 }, (_, i) => [i, `target-${i}`])) }));
  const id = store.putContent(bytes), root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-reference-publication-candidate-'));
  let candidate, late;
  t.after(() => { candidate?.close(); for (const name of fs.readdirSync(root)) { const file = path.join(root, name); assert.ok(fs.lstatSync(file).isFile()); fs.unlinkSync(file); } fs.rmdirSync(root); });
  await createDatabaseGenerationBaseline(store.filePath, path.join(root, 'solomap.db'), store.databaseId);
  candidate = UnifiedDataStore.open(root, store.databaseId);
  store.beginDatabaseGenerationCapture();
  await assert.rejects(store.withPreparedContentOwnership(async () => {
    late = store.prepareContentReferencePublication(id, summarizeContentBytes(bytes)); void late.catch(() => undefined);
    const first = store.rotateDatabaseGenerationCapture();
    candidate.applyDatabaseGenerationChangeset(first.changeset, first.searchObjectIds);
    assert.equal(candidate.rows('SELECT ready FROM content_lifecycle_reference_pending WHERE content_id=?', [id])[0].ready, -1);
    throw new Error('cancel after capture');
  }), /cancel after capture/);
  await assert.rejects(late, /prepared_content_owner_finished/);
  const second = store.stopDatabaseGenerationCapture();
  candidate.applyDatabaseGenerationChangeset(second.changeset, second.searchObjectIds);
  assert.equal(JSON.stringify(candidate.rows('SELECT * FROM content_lifecycle_reference_pending WHERE content_id=?', [id])),
    JSON.stringify(store.rows('SELECT * FROM content_lifecycle_reference_pending WHERE content_id=?', [id])));
  assert.equal(candidate.rows('SELECT * FROM content_lifecycle_reference_preparations').length, 0);
  index(candidate);
  assert.equal(candidate.rows('SELECT count(*) AS n FROM content_lifecycle_edges WHERE source_id=?', [id])[0].n, 301);
});
test('publication rechecks the logical byte length after private staging yields', async t => {
  const store = fixture(t), bytes = Buffer.from(JSON.stringify({ sourceContents: Object.fromEntries(Array.from({ length: 301 }, (_, i) => [i, `target-${i}`])) }));
  const id = store.putContent(bytes);
  await store.withPreparedContentOwnership(async () => {
    const writing = store.prepareContentReferencePublication(id, summarizeContentBytes(bytes));
    store.db.run('UPDATE contents SET byte_length=byte_length+1 WHERE id=?', [id]);
    await assert.rejects(writing, /content_reference_preparation_changed/);
  });
  assert.equal(store.rows('SELECT ready FROM content_lifecycle_reference_pending WHERE content_id=?', [id])[0].ready, 0);
});
test('publication fixes its summary and targets before yielding to the caller', async t => {
  const store = fixture(t), bytes = Buffer.from(JSON.stringify({ sourceContents: Object.fromEntries(Array.from({ length: 301 }, (_, i) => [i, `target-${i}`])) }));
  const id = store.putContent(bytes), summary = summarizeContentBytes(bytes), expected = [...summary.targets];
  await store.withPreparedContentOwnership(async () => {
    const writing = store.prepareContentReferencePublication(id, summary);
    summary.targets[200] = 'changed-after-entry'; summary.sha256 = 'changed-hash'; summary.byteLength = 1; summary.ruleVersion = 2;
    await writing;
  });
  assert.deepEqual(store.rows('SELECT target_id FROM content_lifecycle_edges WHERE source_id=? ORDER BY target_id', [id]).map(row => row.target_id), expected);
});
test('a duplicate flight checks reference identities instead of only their count', async t => {
  const store = fixture(t), bytes = Buffer.from(JSON.stringify({ sourceContents: Object.fromEntries(Array.from({ length: 301 }, (_, i) => [i, `target-${i}`])) }));
  const id = store.putContent(bytes), summary = summarizeContentBytes(bytes), expected = [...summary.targets];
  await store.withPreparedContentOwnership(async () => {
    const first = store.prepareContentReferencePublication(id, summary);
    summary.targets[200] = 'different-same-size-summary';
    await assert.rejects(store.prepareContentReferencePublication(id, summary), /content_reference_summary_mismatch/);
    await first;
  });
  assert.deepEqual(store.rows('SELECT target_id FROM content_lifecycle_edges WHERE source_id=? ORDER BY target_id', [id]).map(row => row.target_id), expected);
});
