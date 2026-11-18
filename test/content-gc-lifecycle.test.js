const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const {attachLazyContentCompute}=require('./content-compute-fixture.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-content-gc-'));
  const store = new UnifiedDataStore(root); store.beginContentPreparationRecovery();
  const closeCompute=attachLazyContentCompute(store);
  const close = store.close.bind(store); let open = true;
  store.close = () => { if (open) { close(); open = false; } };
  t.after(async () => { await closeCompute();store.close(); for (const name of fs.readdirSync(root)) { const file = path.join(root, name); assert.ok(fs.lstatSync(file).isFile()); fs.unlinkSync(file); } fs.rmdirSync(root); });
  return store;
}
function index(store) {
  for (let i = 0; i < 2000; i++) { const batch = store.prepareStorageReferenceBatch(128); store.commitStorageReferenceBatch(batch); if (!batch.pending) return; }
  assert.fail('reference index did not converge');
}
function quantum(store) { const batch = store.prepareStorageGcBatch(128); store.commitStorageGcBatch(batch); return batch; }
function drain(store) {
  for (let i = 0; i < 10000; i++) if (!quantum(store).pending) return;
  assert.fail('content GC did not converge');
}
function watch(store, id) {
  for (let i = 0; i < 10000; i++) {
    quantum(store);
    if (store.rows("SELECT 1 FROM content_lifecycle_gc_members m JOIN content_lifecycle_gc_groups g ON g.id=m.group_id WHERE m.content_id=? AND g.state='collecting'", [id]).length) return;
  }
  assert.fail('candidate watch was never acquired');
}
function seal(store, id) {
  for (let i = 0; i < 10000; i++) {
    quantum(store);
    if (store.rows("SELECT 1 FROM content_lifecycle_gc_members m JOIN content_lifecycle_gc_groups g ON g.id=m.group_id WHERE m.content_id=? AND g.state='sealed'", [id]).length) return;
  }
  assert.fail('candidate did not seal');
}
test('the collection root catalog covers every real content FK with a leading index', t => {
  const store=fixture(t),actual=[];
  for(const row of store.rows("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")){
    const table=String(row.name);if(['content_chunks','content_lifecycle_release_holds'].includes(table))continue;
    for(const fk of store.rows(`PRAGMA foreign_key_list("${table}")`)){
      if(fk.table!=='contents')continue;
      const column=String(fk.from);actual.push(`${table}.${column}`);
      assert.ok(store.rows(`PRAGMA index_list("${table}")`).some(index=>!index.partial&&store.rows(`PRAGMA index_info("${index.name}")`)[0]?.name===column),`${table}.${column} needs a leading index`);
    }
  }
  const expected=require('../out/db/contentLifecycleGcSchema.js').contentLifecycleGcRoots.map(row=>`${row.table}.${row.column}`);
  assert.deepEqual(actual.sort(),expected.sort());
});
test('legacy cleanup transfers bounded candidates to GC without scanning or deleting retained history', t => {
  const store=fixture(t),ids=Array.from({length:260},(_,i)=>store.putContent(`legacy candidate ${i}`));
  const retained=store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'legacy-transfer-retained',data:{category:'inbox',title:'retained history',status:'captured',content:{contentId:ids[0]}}});
  for(const id of ids)store.db.run('INSERT OR IGNORE INTO database_storage_cleanup_candidates SELECT id,stored_byte_length FROM contents WHERE id=?',[id]);
  index(store);store.activateStorageContentLifecycle();
  const before=store.rows('SELECT COUNT(*) AS n FROM contents')[0].n;
  store.prepareDatabaseStorageCleanup();
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM database_storage_cleanup_candidates')[0].n,132);
  const content=store.content;store.content=()=>assert.fail('legacy cleanup must not rescan historical bodies');
  try{for(const table of ['object_revisions','learning_review_controls','legacy_learning_review_controls','legacy_learning_review_cursor_inputs'])assert.equal(store.protectDatabaseStorageCleanupReferencesBatch(table,0,128).nextCursor,null);}
  finally{store.content=content;}
  for(let i=0;i<10;i++){
    const batch=store.finalizeDatabaseStorageCleanupBatch(128);
    assert.equal(batch.deletedContents,0);assert.equal(batch.reclaimedStoredBytes,0);
    if(!batch.pending)break;assert.notEqual(i,9);
  }
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM contents')[0].n,before,'transfer does not claim physical deletion');
  drain(store);
  assert.equal(store.rows('SELECT 1 FROM contents WHERE id=?',[ids[0]]).length,1);
  for(const id of ids.slice(1))assert.equal(store.rows('SELECT 1 FROM contents WHERE id=?',[id]).length,0);
  assert.deepEqual(store.read(retained.objectId,1).data.content,JSON.stringify({contentId:ids[0]}));
  const later=store.putContent('a later retired byproduct');store.queueStorageCleanupContents([later]);
  assert.equal(store.rows('SELECT 1 FROM database_storage_cleanup_candidates').length,0);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_gc_pending WHERE content_id=?',[later]).length,1);
});

test('disabled collection still transfers historical legacy candidates in bounded pieces without old scans or purge',t=>{
  const store=fixture(t),ids=Array.from({length:260},(_,i)=>store.putContent(`disabled legacy candidate ${i}`));
  assert.equal(store.usesStorageContentLifecycle(),false);
  for(const id of ids)store.db.run('INSERT OR IGNORE INTO database_storage_cleanup_candidates SELECT id,stored_byte_length FROM contents WHERE id=?',[id]);
  const original=store.content,run=store.db.run.bind(store.db);let sweeps=0;
  store.content=()=>assert.fail('legacy handoff cannot parse historical bodies while collection is disabled');
  store.db.run=(sql,...args)=>{if(String(sql).startsWith('DELETE FROM database_storage_cleanup_candidates WHERE content_id IN')&&!String(sql).includes('LIMIT'))sweeps++;assert.ok(!/^DELETE FROM (contents|content_chunks)\b/.test(String(sql)),'only the unified sealed collector may purge physical body rows');return run(sql,...args);};
  try{
    store.prepareDatabaseStorageCleanup();assert.equal(store.rows('SELECT COUNT(*) AS n FROM database_storage_cleanup_candidates')[0].n,132);
    assert.equal(store.protectDatabaseStorageCleanupReferencesBatch('object_revisions',0,128).nextCursor,null);
    assert.deepEqual(store.finalizeDatabaseStorageCleanupBatch(128),{deletedContents:0,reclaimedStoredBytes:0,pending:true});
    assert.equal(store.rows('SELECT COUNT(*) AS n FROM database_storage_cleanup_candidates')[0].n,4);
    assert.deepEqual(store.finalizeDatabaseStorageCleanupBatch(128),{deletedContents:0,reclaimedStoredBytes:0,pending:false});assert.equal(sweeps,0);
  }finally{store.content=original;store.db.run=run;}
  for(const id of ids){assert.equal(store.rows('SELECT 1 FROM contents WHERE id=?',[id]).length,1);assert.equal(store.rows('SELECT 1 FROM content_lifecycle_gc_pending WHERE content_id=?',[id]).length,1);}
});

test('new retirement uses the unified persistent collection queue before collection is enabled',t=>{
  const store=fixture(t),id=store.putContent('new retirement has one governed exit');store.queueStorageCleanupContents([id]);
  assert.equal(store.usesStorageContentLifecycle(),false);assert.equal(store.rows('SELECT 1 FROM database_storage_cleanup_candidates WHERE content_id=?',[id]).length,0);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_gc_pending WHERE content_id=?',[id]).length,1);assert.equal(store.rows('SELECT 1 FROM contents WHERE id=?',[id]).length,1);
});
test('GC exits an orphan while preserving complete fixed-version history and zero-growth idle', t => {
  const store = fixture(t);
  const memory = store.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'retained-memory', data: { category: 'inbox', title: 'retained', status: 'captured', content: 'first full body' } });
  store.write({ kind: 'memory', action: 'patch', scope: null, objectId: memory.objectId, expectedRevision: memory.revision, idempotencyKey: 'retained-patch', data: { content: 'second full body' } });
  const orphan = store.putContent('unreferenced private output');
  index(store); store.activateStorageContentLifecycle(); drain(store);
  assert.equal(store.rows('SELECT id FROM contents WHERE id=?', [orphan]).length, 0);
  assert.equal(store.read(memory.objectId, memory.revision).data.content, 'first full body');
  assert.equal(store.read(memory.objectId).data.content, 'second full body');
  const before = store.rows('SELECT total_changes() AS n')[0].n;
  for (let i = 0; i < 25; i++) assert.equal(quantum(store).pending, false);
  assert.equal(store.rows('SELECT total_changes() AS n')[0].n, before);
});

test('GC accepts a new synchronous commit boundary but still rejects an already open transaction and rolls back its watch publication',t=>{
  const store=fixture(t),target=store.putContent('commit-qualified GC candidate');index(store);store.activateStorageContentLifecycle();
  let batch;
  for(let i=0;i<10000;i++){batch=store.prepareStorageGcBatch(128);if(batch.action==='start'&&batch.candidates[0].id===target)break;store.commitStorageGcBatch(batch);assert.notEqual(i,9999);}
  assert.throws(()=>store.transaction(()=>store.commitStorageGcBatch(batch)),/content_gc_transaction_nested/);
  const watched=store.storageGc.watched.size;
  assert.throws(()=>store.commitStorageGcBatch(batch,publish=>store.transaction(()=>{publish();throw Error('fenced_gc_transaction_abort');})),/fenced_gc_transaction_abort/);
  assert.equal(store.storageGc.watched.size,watched,'the failed outer boundary must not publish new in-memory watches');
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_gc_groups').length,0);
  assert.equal(store.commitStorageGcBatch(batch).applied,true,'the same original batch remains valid after the entire boundary rolls back');
});

test('GC payload deletion and its audit counters roll back together and the same sealed batch can retry',t=>{
  const store=fixture(t),target=store.putContent('one physical payload with durable exit accounting');index(store);store.activateStorageContentLifecycle();seal(store,target);
  const audit=store.beginDatabaseStorageMaintenance(1,0,true),batch=store.prepareStorageGcBatch(128);
  assert.equal(batch.action,'purge');assert.equal(batch.sourceId,target);assert.ok(batch.bytes>0);
  store.db.run(`CREATE TEMP TRIGGER reject_gc_audit_progress BEFORE UPDATE OF deleted_contents ON database_storage_maintenance
    WHEN NEW.deleted_contents>OLD.deleted_contents BEGIN SELECT RAISE(ABORT,'gc_audit_progress_fault'); END`);
  assert.throws(()=>store.commitStorageGcBatch(batch,undefined,audit),/gc_audit_progress_fault/);
  assert.equal(store.rows('SELECT 1 FROM contents WHERE id=?',[target]).length,1);
  assert.equal(store.rows('SELECT deleted_contents FROM database_storage_maintenance WHERE id=?',[audit])[0].deleted_contents,0);
  store.db.run('DROP TRIGGER temp.reject_gc_audit_progress');
  const committed=store.commitStorageGcBatch(batch,undefined,audit);
  assert.equal(committed.deletedContents,1);assert.equal(store.rows('SELECT 1 FROM contents WHERE id=?',[target]).length,0);
  const saved=store.rows('SELECT deleted_contents,reclaimed_stored_bytes FROM database_storage_maintenance WHERE id=?',[audit])[0];
  assert.equal(saved.deleted_contents,1);assert.equal(saved.reclaimed_stored_bytes,committed.reclaimedStoredBytes);
  store.releaseDatabaseStorageMaintenance(audit);
});
test('a real FK arriving after watch registration invalidates the older collection proof', t => {
  const store = fixture(t);
  const holder = store.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'late-root', data: { category: 'inbox', title: 'holder', status: 'captured', content: 'old retained body' } });
  const target = store.putContent('late referenced body');
  index(store); store.activateStorageContentLifecycle(); watch(store, target);
  const stale = store.prepareStorageGcBatch(128);
  store.db.run('UPDATE memories SET content_id=? WHERE id=?', [target, holder.objectId]);
  const group = store.rows('SELECT g.dirty FROM content_lifecycle_gc_members m JOIN content_lifecycle_gc_groups g ON g.id=m.group_id WHERE m.content_id=?', [target])[0];
  assert.equal(group.dirty, 1);
  assert.equal(store.commitStorageGcBatch(stale).applied, false);
  drain(store);
  assert.equal(store.content(target).toString(), 'late referenced body');
});
test('indirect JSON references follow a live owner and exit after the owner releases them', async t => {
  const store = fixture(t), target = store.putContent('retained through a JSON edge');
  const parent = store.putContent(JSON.stringify({ nested: [{ payloadContentId: target }] }), 'application/octet-stream', 'binary');
  index(store);
  let release;
  const owned = store.withPreparedContentOwnership(async () => {
    store.pinPreparedContent(store.requireContentPreparationOwner(), parent);
    await new Promise(resolve => { release = resolve; });
  });
  try {
    store.activateStorageContentLifecycle(); drain(store);
    assert.equal(store.content(target).toString(), 'retained through a JSON edge');
  } finally { release(); await owned; }
  drain(store);
  assert.equal(store.rows('SELECT id FROM contents WHERE id IN (?,?)', [parent, target]).length, 0);
});
test('an unreachable cycle retires as a group without exposing partially collected members', t => {
  const store = fixture(t), a = crypto.randomUUID(), b = crypto.randomUUID();
  for (const [id, target] of [[a, b], [b, a]]) {
    const bytes = Buffer.from(JSON.stringify({ contentId: target })), hash = crypto.createHash('sha256').update(bytes).digest('hex');
    store.db.run('INSERT INTO contents VALUES(?,?,?,?,?,?,?,NULL)', [id, hash, 'application/json', 'utf8', bytes.length, bytes.length, bytes]);
  }
  index(store); store.activateStorageContentLifecycle();
  let sealed = false;
  for (let i = 0; i < 10000; i++) {
    quantum(store);
    if (store.rows("SELECT m.content_id FROM content_lifecycle_gc_members m JOIN content_lifecycle_gc_groups g ON g.id=m.group_id WHERE m.content_id IN (?,?) AND g.state='sealed'", [a, b]).length === 2) { sealed = true; break; }
  }
  assert.equal(sealed, true);
  assert.throws(() => store.content(a), /content_retired/);
  assert.throws(() => store.content(b), /content_retired/);
  drain(store);
  assert.equal(store.rows('SELECT id FROM contents WHERE id IN (?,?)', [a, b]).length, 0);
});
test('deduplication allocates a fresh active identity when its old unique slot is retired', async t => {
  const store = fixture(t), bytes = Buffer.from('same bytes after retirement'), original = store.putContent(bytes);
  index(store); store.activateStorageContentLifecycle(); seal(store, original);
  const fresh = store.putContent(bytes);
  assert.notEqual(fresh, original);
  assert.equal(store.content(fresh).toString(), bytes.toString());
  assert.throws(() => store.content(original), /content_retired/);
  const { summarizeContentBytes } = require('../out/contentReferences.js');
  await store.withPreparedContentOwnership(async () => store.prepareContentReferencePublication(fresh, summarizeContentBytes(bytes)));
  index(store); drain(store);
});
test('cold maintenance can advance past a sealed body without reparsing or resurrecting it', t => {
  const store = fixture(t), id = store.putContent(JSON.stringify({ text: 'compressible'.repeat(300) }), 'application/json');
  index(store); store.activateStorageContentLifecycle(); seal(store, id);
  const batch = store.prepareStorageColdBatch(64);
  store.commitStorageColdBatch(batch);
  assert.equal(batch.contents.some(row => row.id === id), false);
  assert.equal(batch.faults.some(row => row.id === id), false);
  drain(store);
});
test('a retired codec cannot hide another compatible identity retained by real business roots', t => {
  const store = fixture(t), bytes = Buffer.from('shared codec bytes '.repeat(100)), hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const gzipId = crypto.randomUUID(), activeId = crypto.randomUUID(), compressed = require('node:zlib').gzipSync(bytes);
  store.db.run('INSERT INTO contents VALUES(?,?,?,?,?,?,?,NULL)', [gzipId, hash, 'text/plain', 'gzip:utf8', bytes.length, compressed.length, compressed]);
  store.db.run('INSERT INTO contents VALUES(?,?,?,?,?,?,?,NULL)', [activeId, hash, 'text/plain', 'utf8', bytes.length, bytes.length, bytes]);
  const holder = store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'active-codec-root',data:{category:'inbox',title:'holder',status:'captured',content:'initial body'}});
  store.db.run('UPDATE memories SET content_id=? WHERE id=?', [activeId, holder.objectId]);
  index(store); store.activateStorageContentLifecycle(); seal(store, gzipId);
  assert.equal(store.putContent(bytes), activeId);
  assert.equal(store.content(activeId).toString(), bytes.toString());
});
test('GC enqueue triggers replay exact source tokens without inventing candidate versions', async t => {
  const active = fixture(t), candidateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-gc-replay-candidate-'));
  const { createDatabaseGenerationBaseline } = require('../out/databaseGeneration.js');
  let candidate;
  t.after(() => { candidate?.close(); for (const name of fs.readdirSync(candidateRoot)) { const file = path.join(candidateRoot, name); assert.ok(fs.lstatSync(file).isFile()); fs.unlinkSync(file); } fs.rmdirSync(candidateRoot); });
  index(active); active.activateStorageContentLifecycle(); drain(active);
  await createDatabaseGenerationBaseline(active.filePath, path.join(candidateRoot, 'solomap.db'), active.databaseId);
  candidate = UnifiedDataStore.open(candidateRoot, active.databaseId);
  active.beginDatabaseGenerationCapture();
  const id = active.putContent('GC token captured after snapshot');
  assert.equal(active.prepareStorageGcBatch(128).pending, false, 'active capture pauses GC');
  const captured = active.stopDatabaseGenerationCapture();
  candidate.applyDatabaseGenerationChangeset(captured.changeset, captured.searchObjectIds);
  assert.deepEqual(candidate.rows('SELECT * FROM content_lifecycle_gc_pending WHERE content_id=?', [id]), active.rows('SELECT * FROM content_lifecycle_gc_pending WHERE content_id=?', [id]));
});
test('unrelated roots do not invalidate a watched proof', t => {
  const store = fixture(t), orphan = store.putContent('watched isolated orphan');
  index(store); store.activateStorageContentLifecycle(); watch(store, orphan);
  const batch = store.prepareStorageGcBatch(128);
  store.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'unrelated-root', data: { category: 'inbox', title: 'unrelated', status: 'captured', content: 'retained unrelated' } });
  assert.equal(store.commitStorageGcBatch(batch).applied, true);
  index(store); drain(store);
  assert.equal(store.rows('SELECT 1 FROM contents WHERE id=?', [orphan]).length, 0);
});
test('an unrelated live private summary does not impose a global empty-queue barrier', async t => {
  const store=fixture(t), orphan=store.putContent('unrelated watched orphan');
  index(store); store.activateStorageContentLifecycle({strictPublication:true}); watch(store,orphan);
  const bytes=Buffer.from(JSON.stringify({sourceContents:Object.fromEntries(Array.from({length:301},(_,i)=>[i,`unrelated-target-${i}`]))}));
  const id=store.putContent(bytes), {summarizeContentBytes}=require('../out/contentReferences.js');
  await store.withPreparedContentOwnership(async()=>{
    const preparing=store.prepareContentReferencePublication(id,summarizeContentBytes(bytes));
    try { drain(store); assert.equal(store.rows('SELECT 1 FROM contents WHERE id=?',[orphan]).length,0); }
    finally { await preparing; }
  });
  index(store); drain(store);
});
test('a target reserved beyond the first page invalidates an already expanded watch', async t => {
  const store=fixture(t), target=store.putContent('target in the last private page');
  index(store); store.activateStorageContentLifecycle({strictPublication:true}); watch(store,target);
  quantum(store);
  const stale=store.prepareStorageGcBatch(128), {summarizeContentBytes}=require('../out/contentReferences.js');
  const bytes=Buffer.from(JSON.stringify({sourceContents:Object.fromEntries([...Array.from({length:300},(_,i)=>`missing-${i}`),target].sort().map((id,i)=>[i,id]))}));
  // Keep the same full reference set, with this target in a later publication page.
  const summary=summarizeContentBytes(bytes); summary.targets=[...summary.targets.filter(id=>id!==target),target];
  const id=store.putContent(bytes);
  await store.withPreparedContentOwnership(async()=>{
    const owner=store.requireContentPreparationOwner(), preparing=store.prepareContentReferencePublication(id,summary);
    try {
      assert.equal(store.commitStorageGcBatch(stale).applied,false);
      drain(store);
      assert.equal(store.content(target).toString(),'target in the last private page');
      assert.equal(store.rows('SELECT 1 FROM content_lifecycle_prepare_pins WHERE owner_id=? AND content_id=?',[owner,target]).length,1);
    } finally { await preparing; }
  });
  index(store); drain(store);
  assert.equal(store.rows('SELECT 1 FROM contents WHERE id IN (?,?)',[id,target]).length,0);
});
test('derived debt preserves candidate-only unknown sources across two live preparation changesets', async t => {
  const active=fixture(t), root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-debt-replay-'));
  let candidate;
  t.after(()=>{candidate?.close();for(const name of fs.readdirSync(root)){const file=path.join(root,name);assert.ok(fs.lstatSync(file).isFile());fs.unlinkSync(file);}fs.rmdirSync(root);});
  index(active); active.activateStorageContentLifecycle({strictPublication:true}); drain(active);
  await require('../out/databaseGeneration.js').createDatabaseGenerationBaseline(active.filePath,path.join(root,'solomap.db'),active.databaseId);
  candidate=UnifiedDataStore.open(root,active.databaseId);
  const local=candidate.putContent('candidate independent debt');
  active.beginDatabaseGenerationCapture();
  const bytes=Buffer.from(JSON.stringify({sourceContents:Object.fromEntries(Array.from({length:301},(_,i)=>[i,`debt-target-${i}`]))})), id=active.putContent(bytes);
  await active.withPreparedContentOwnership(async()=>{
    const preparing=active.prepareContentReferencePublication(id,require('../out/contentReferences.js').summarizeContentBytes(bytes));
    try {
      assert.equal(active.rows('SELECT 1 FROM content_lifecycle_gc_exempt_sources WHERE content_id=?',[id]).length,1);
      let capture=active.stopDatabaseGenerationCapture(); candidate.applyDatabaseGenerationChangeset(capture.changeset,capture.searchObjectIds);
      assert.deepEqual(candidate.rows('SELECT content_id FROM content_lifecycle_gc_debt ORDER BY content_id').map(row=>row.content_id),[local]);
      active.beginDatabaseGenerationCapture();
    } finally { await preparing; }
  });
  const capture=active.stopDatabaseGenerationCapture(); candidate.applyDatabaseGenerationChangeset(capture.changeset,capture.searchObjectIds);
  assert.deepEqual(candidate.rows('SELECT content_id FROM content_lifecycle_gc_debt ORDER BY content_id').map(row=>row.content_id),[local]);
  assert.equal(candidate.rows('SELECT 1 FROM content_lifecycle_gc_exempt_sources').length,0);
  assert.equal(candidate.rows('SELECT replaying FROM content_lifecycle_replication_guard')[0].replaying,0);
});
test('a failed private child revokes its exemption while an indirectly rooted dependency stays protected', async t => {
  const store=fixture(t), target=store.putContent('indirect retained target');
  const holder=store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'private-child-holder',data:{category:'inbox',title:'holder',status:'captured',content:'initial'}});
  index(store); store.activateStorageContentLifecycle({strictPublication:true}); watch(store,target); quantum(store);
  const unrelated=store.putContent('orphan beside a failed live preparation');index(store);
  const {summarizeContentBytes}=require('../out/contentReferences.js');
  const bytes=Buffer.from(JSON.stringify({sourceContents:Object.fromEntries([...Array.from({length:300},(_,i)=>`unavailable-${i}`),target].map((id,i)=>[i,id]))}));
  const source=store.putContent(bytes), summary=summarizeContentBytes(bytes); summary.targets=[...summary.targets.filter(id=>id!==target),target];
  const run=store.db.run.bind(store.db); let injected=false;
  store.db.run=(sql,values)=>{if(!injected&&sql.startsWith('UPDATE content_lifecycle_reference_preparations SET committed=')&&values[2]===source&&values[3]===128){injected=true;throw Error('injected_reference_page_failure');}return run(sql,values);};
  try {
    await store.withPreparedContentOwnership(async()=>{
      const preparing=store.prepareContentReferencePublication(source,summary).then(()=>null,error=>error);
      const parentBytes=Buffer.from(JSON.stringify({contentId:source})), parent=store.putContent(parentBytes);
      await store.withPreparedContentOwnership(()=>store.prepareContentReferencePublication(parent,summarizeContentBytes(parentBytes)));
      store.db.run('UPDATE memories SET content_id=? WHERE id=?',[parent,holder.objectId]);
      const failure=await preparing; assert.match(failure.message,/injected_reference_page_failure/);
      assert.equal(store.rows('SELECT 1 FROM content_lifecycle_gc_exempt_sources WHERE content_id=?',[source]).length,0);
      assert.equal(store.rows('SELECT 1 FROM content_lifecycle_gc_debt WHERE content_id=?',[source]).length,1);
      index(store);
      drain(store);
      assert.equal(store.rows('SELECT 1 FROM contents WHERE id=?',[unrelated]).length,0);
      assert.equal(store.content(target).toString(),'indirect retained target');
    });
  } finally { store.db.run=run; }
  index(store); drain(store);
  assert.equal(store.content(target).toString(),'indirect retained target');
});
test('failed publication metadata drains before owner deletion without a bulk cascade', async t => {
  const store=fixture(t);index(store);store.activateStorageContentLifecycle({strictPublication:true});drain(store);
  const {summarizeContentBytes}=require('../out/contentReferences.js'),run=store.db.run.bind(store.db),deletions=[];
  const childCount=()=>['content_lifecycle_prepare_pins','content_lifecycle_reference_preparations','content_lifecycle_preparation_names','content_lifecycle_gc_exempt_sources'].reduce((n,table)=>n+Number(store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n),0);
  store.db.run=(sql,values)=>{
    if(sql.startsWith('UPDATE content_lifecycle_reference_preparations SET committed='))throw Error('injected_first_page_failure');
    if(sql==='DELETE FROM content_lifecycle_prepare_owners WHERE id=?')deletions.push(childCount());
    return run(sql,values);
  };
  try {
    await store.withPreparedContentOwnership(async()=>{
      for(let i=0;i<300;i++){
        const bytes=Buffer.from(JSON.stringify({contentId:`failed-missing-${i}`})),id=store.putContent(bytes),summary=summarizeContentBytes(bytes);
        store.allocatePreparedContentId(`failed-name-${i}`,summary.sha256,'text/plain','utf8');
        await assert.rejects(store.prepareContentReferencePublication(id,summary),/injected_first_page_failure/);
      }
    });
    for(let i=0;i<100;i++){
      const before=childCount()+Number(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n);
      const recovered=store.recoverContentPreparations(128);
      const after=childCount()+Number(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n);
      assert.ok(before-after<=128,`released ${before-after} owned records in one quantum`);
      if(!recovered.pending)break;
    }
    assert.deepEqual(deletions,[0]);assert.equal(childCount(),0);
  }finally{store.db.run=run;}
  index(store);drain(store);
});
test('a rolled-back seal retains its watch against a later private target reservation', async t => {
  const store=fixture(t), target=store.putContent('rollback watched target');
  index(store);store.activateStorageContentLifecycle({strictPublication:true});watch(store,target);quantum(store);
  const sealBatch=store.prepareStorageGcBatch(128); assert.equal(sealBatch.action,'seal');
  const transaction=store.transaction.bind(store);
  store.transaction=fn=>transaction(()=>{fn();throw Error('injected_gc_commit_failure');});
  assert.throws(()=>store.commitStorageGcBatch(sealBatch),/injected_gc_commit_failure/);
  store.transaction=transaction;
  const bytes=Buffer.from(JSON.stringify({sourceContents:Object.fromEntries([...Array.from({length:300},(_,i)=>`rollback-missing-${i}`),target].map((id,i)=>[i,id]))})), id=store.putContent(bytes);
  const summary=require('../out/contentReferences.js').summarizeContentBytes(bytes);summary.targets=[...summary.targets.filter(id=>id!==target),target];
  await store.withPreparedContentOwnership(async()=>{
    const preparing=store.prepareContentReferencePublication(id,summary);
    try {
      assert.equal(store.rows('SELECT g.dirty FROM content_lifecycle_gc_members m JOIN content_lifecycle_gc_groups g ON g.id=m.group_id WHERE m.content_id=?',[target])[0].dirty,1);
      assert.equal(store.commitStorageGcBatch(sealBatch).applied,false);
    } finally {await preparing;}
  });
  index(store);drain(store);
});
test('an older empty recovery page cannot clear a newly revoked owner barrier', async t => {
  const store=fixture(t);index(store);store.activateStorageContentLifecycle({strictPublication:true});drain(store);
  store.db.run('UPDATE content_lifecycle_gc_state SET recover_exemptions=1 WHERE id=1');
  const stale=store.prepareStorageGcBatch(128);assert.equal(stale.action,'recover');assert.deepEqual(stale.ids,[]);
  const bytes=Buffer.from(JSON.stringify({sourceContents:Object.fromEntries(Array.from({length:301},(_,i)=>[i,`barrier-${i}`]))})),id=store.putContent(bytes);
  await store.withPreparedContentOwnership(async()=>{
    const owner=store.requireContentPreparationOwner(),preparing=store.prepareContentReferencePublication(id,require('../out/contentReferences.js').summarizeContentBytes(bytes));
    try {
      store.db.run('UPDATE content_lifecycle_prepare_owners SET reference_reservations_live=0 WHERE id=?',[owner]);
      assert.equal(store.commitStorageGcBatch(stale).applied,false);
      assert.equal(store.rows('SELECT recover_exemptions FROM content_lifecycle_gc_state')[0].recover_exemptions,1);
      const fresh=store.prepareStorageGcBatch(128);assert.equal(fresh.action,'recover');assert.deepEqual(fresh.ids,[id]);
      assert.equal(store.commitStorageGcBatch(fresh).applied,true);
      assert.equal(store.rows('SELECT 1 FROM content_lifecycle_gc_debt WHERE content_id=?',[id]).length,1);
    } finally {await preparing;}
  });
  index(store);drain(store);
  assert.equal(store.rows('SELECT recover_exemptions FROM content_lifecycle_gc_state')[0].recover_exemptions,0);
});
test('one failed duplicate owner hands the private exemption back to the still-preparing owner', async t => {
  const store=fixture(t),orphan=store.putContent('orphan beside duplicate preparation');
  index(store);store.activateStorageContentLifecycle({strictPublication:true});watch(store,orphan);
  const bytes=Buffer.from(JSON.stringify({sourceContents:Object.fromEntries(Array.from({length:301},(_,i)=>[i,`duplicate-private-${i}`]))})),id=store.putContent(bytes),summary=require('../out/contentReferences.js').summarizeContentBytes(bytes);
  const run=store.db.run.bind(store.db);let failedOwner;
  store.db.run=(sql,values)=>{if(sql.startsWith('UPDATE content_lifecycle_reference_preparations SET committed=')&&values[1]===failedOwner&&values[3]===128)throw Error('duplicate_owner_failed');return run(sql,values);};
  try{
    await store.withPreparedContentOwnership(async()=>{
      const owner=store.requireContentPreparationOwner(),preparing=store.prepareContentReferencePublication(id,summary);
      try{
        await assert.rejects(store.withPreparedContentOwnership(async()=>{failedOwner=store.requireContentPreparationOwner();await store.prepareContentReferencePublication(id,summary);}),/duplicate_owner_failed/);
        assert.equal(store.rows('SELECT owner_id FROM content_lifecycle_gc_exempt_sources WHERE content_id=?',[id])[0]?.owner_id,owner);
        drain(store);assert.equal(store.rows('SELECT 1 FROM contents WHERE id=?',[orphan]).length,0);
      }finally{await preparing;}
    });
  }finally{store.db.run=run;}
  index(store);drain(store);
});
test('lossless cold recoding transfers an already complete reference proof without blocking GC', t => {
  const store=fixture(t),target=store.putContent('cold retained indirect target');
  const source=store.putContent(JSON.stringify({contentId:target,text:'cold repeated bytes '.repeat(200)}),'application/json');
  const holder=store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'cold-proof-holder',data:{category:'inbox',title:'holder',status:'captured',content:'initial'}});
  store.db.run('UPDATE memories SET content_id=? WHERE id=?',[source,holder.objectId]);
  const orphan=store.putContent('orphan alongside continuing cold recoding');
  index(store);store.activateStorageContentLifecycle({strictPublication:true});watch(store,orphan);
  const cold=store.prepareStorageColdBatch(64);assert.ok(cold.contents.some(row=>row.id===source));
  store.commitStorageColdBatch(cold);
  assert.equal(store.rows('SELECT ready FROM content_lifecycle_reference_pending WHERE content_id=?',[source])[0].ready,1);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_gc_debt WHERE content_id=?',[source]).length,0);
  drain(store);assert.equal(store.rows('SELECT 1 FROM contents WHERE id=?',[orphan]).length,0);
  assert.equal(store.content(target).toString(),'cold retained indirect target');
});
test('a same-owner retry absorbs the older failed revocation before its new manifest starts', async t => {
  const store=fixture(t);index(store);store.activateStorageContentLifecycle({strictPublication:true});drain(store);
  const bytes=Buffer.from(JSON.stringify({sourceContents:Object.fromEntries(Array.from({length:301},(_,i)=>[i,`retry-reference-${i}`]))})),id=store.putContent(bytes),summary=require('../out/contentReferences.js').summarizeContentBytes(bytes);
  const run=store.db.run.bind(store.db);let pageFailed=false,revokeFailed=false;
  store.db.run=(sql,values)=>{
    if(!pageFailed&&sql.startsWith('UPDATE content_lifecycle_reference_preparations SET committed=')){pageFailed=true;throw Error('first_reference_page_failed');}
    if(pageFailed&&!revokeFailed&&sql==='DELETE FROM content_lifecycle_reference_preparations WHERE content_id=? AND owner_id=?'){revokeFailed=true;throw Error('first_reference_revoke_failed');}
    return run(sql,values);
  };
  try{
    await store.withPreparedContentOwnership(async()=>{
      await assert.rejects(store.prepareContentReferencePublication(id,summary),/first_reference_page_failed/);
      const retry=store.prepareContentReferencePublication(id,summary);
      try{
        const owner=store.requireContentPreparationOwner();
        assert.equal(store.rows('SELECT committed FROM content_lifecycle_reference_preparations WHERE owner_id=? AND content_id=?',[owner,id])[0].committed,128);
        store.recoverContentPreparations(128);
        assert.equal(store.rows('SELECT committed FROM content_lifecycle_reference_preparations WHERE owner_id=? AND content_id=?',[owner,id])[0]?.committed,128);
      }finally{await retry;}
    });
  }finally{store.db.run=run;}
  index(store);drain(store);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_prepare_owners').length,0);
});
test('known private partial bytes exit despite an unrelated published integrity fault', async t => {
  const store=fixture(t),holder=store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'preserved-corrupt-history',data:{category:'inbox',title:'retained',status:'captured',content:'original retained bytes'}});
  const observer=store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'private-byte-observer',data:{category:'inbox',title:'raw identifier',status:'captured',content:'initial'}});
  const retained=store.rows('SELECT content_id FROM memories WHERE id=?',[holder.objectId])[0].content_id;
  store.db.run('UPDATE contents SET data=zeroblob(stored_byte_length) WHERE id=?',[retained]);
  index(store);store.activateStorageContentLifecycle({strictPublication:true});
  let preparing,staging;
  const prepared=require('../out/db/unifiedDataStore.js').prepareContentForStorage(crypto.randomBytes(2*1024*1024),'application/octet-stream','binary');
  await assert.rejects(store.withPreparedContentOwnership(async()=>{
    preparing=store.putPreparedContent(prepared,'abandoned-private-bytes').then(()=>null,error=>error);
    staging=store.rows("SELECT id FROM contents WHERE encoding LIKE 'staging:%'")[0].id;
    throw Error('cancel_private_bytes');
  }),/cancel_private_bytes/);
  assert.match((await preparing).message,/prepared_content_owner_finished/);
  const raw=Buffer.from(JSON.stringify({contentId:staging})),parent=store.putContent(raw,'application/json');
  await store.withPreparedContentOwnership(async()=>{
    await store.prepareContentReferencePublication(parent,require('../out/contentReferences.js').summarizeContentBytes(raw));
    store.db.run('UPDATE memories SET content_id=? WHERE id=?',[parent,observer.objectId]);
  });
  const actual=Number(store.rows('SELECT SUM(length(data)) AS n FROM content_chunks WHERE content_id=?',[staging])[0].n);
  assert.ok(actual>0);
  index(store);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_reference_faults WHERE source_id=?',[staging]).length,1);
  const before=store.rows('SELECT reclaimed_stored_bytes FROM content_lifecycle_gc_state')[0].reclaimed_stored_bytes;
  drain(store);
  assert.equal(store.rows('SELECT 1 FROM contents WHERE id=?',[staging]).length,0);
  assert.equal(store.rows('SELECT 1 FROM content_chunks WHERE content_id=?',[staging]).length,0);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_gc_debt WHERE content_id=?',[staging]).length,0);
  assert.equal(store.rows('SELECT reclaimed_stored_bytes FROM content_lifecycle_gc_state')[0].reclaimed_stored_bytes-before,actual);
  assert.equal(store.rows('SELECT 1 FROM contents WHERE id=?',[retained]).length,1);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_edges WHERE source_id=? AND target_id=?',[parent,staging]).length,1);
  assert.equal(JSON.parse(String(store.read(observer.objectId).data.content)).contentId,staging);
  assert.throws(()=>store.content(retained),/content_integrity_error/);
});
test('raw references to a retired identity survive purge and protect original bytes restored under that identity', async t => {
  const store=fixture(t),original=Buffer.from('original bytes restored by a later import'),id=store.putContent(original);
  const holder=store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'raw-retired-parent',data:{category:'inbox',title:'raw reference',status:'captured',content:'initial'}});
  index(store);store.activateStorageContentLifecycle({strictPublication:true});seal(store,id);
  const bytes=Buffer.from(JSON.stringify({contentId:id})),parent=store.putContent(bytes,'application/json');
  await store.withPreparedContentOwnership(async()=>{
    await store.prepareContentReferencePublication(parent,require('../out/contentReferences.js').summarizeContentBytes(bytes));
    store.db.run('UPDATE memories SET content_id=? WHERE id=?',[parent,holder.objectId]);
  });
  index(store);drain(store);
  assert.equal(store.rows('SELECT 1 FROM contents WHERE id=?',[id]).length,0);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_edges WHERE source_id=? AND target_id=?',[parent,id]).length,1);
  store.db.run('INSERT INTO contents VALUES(?,?,?,?,?,?,?,NULL)',[id,crypto.createHash('sha256').update(original).digest('hex'),'text/plain','utf8',original.length,original.length,original]);
  index(store);drain(store);
  assert.deepEqual(store.content(id),original);
});
test('unfinished byte identities reject typed reads and direct adoption while raw identifiers remain writable', async t => {
  const store=fixture(t),holder=store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'unfinished-guard-holder',data:{category:'inbox',title:'holder',status:'captured',content:'initial'}});
  index(store);store.activateStorageContentLifecycle({strictPublication:true});
  const prepared=require('../out/db/unifiedDataStore.js').prepareContentForStorage(crypto.randomBytes(2*1024*1024),'application/octet-stream','binary');
  await store.withPreparedContentOwnership(async()=>{
    const preparing=store.putPreparedContent(prepared,'unfinished-guard'),staging=store.rows("SELECT id FROM contents WHERE encoding LIKE 'staging:%'")[0].id;
    const bytes=Buffer.from(JSON.stringify({contentId:staging})),parent=store.putContent(bytes),summary=require('../out/contentReferences.js').summarizeContentBytes(bytes);
    try{
      assert.throws(()=>store.db.run('UPDATE memories SET content_id=? WHERE id=?',[staging,holder.objectId]),/content_unfinished/);
      assert.throws(()=>store.content(staging),/content_unfinished/);
      await store.prepareContentReferencePublication(parent,summary);
      assert.deepEqual(JSON.parse(store.content(parent).toString()),{contentId:staging});
    }finally{await preparing;}
    await store.prepareContentReferencePublication(parent,summary);
    store.db.run('UPDATE memories SET content_id=? WHERE id=?',[parent,holder.objectId]);
  });
  index(store);drain(store);
  assert.equal(store.rows("SELECT 1 FROM contents WHERE encoding LIKE 'staging:%'").length,0);
});
test('the reference-aware collector exits legacy bridge holds without growing new holds for retained content', async t => {
  const store=fixture(t),holder=store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'bridge-hold-holder',data:{category:'inbox',title:'holder',status:'captured',content:'retained bridge bytes'}});
  const id=store.rows('SELECT content_id FROM memories WHERE id=?',[holder.objectId])[0].content_id;
  await store.withPreparedContentOwnership(async()=>store.pinPreparedContent(store.requireContentPreparationOwner(),id));
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_release_holds WHERE content_id=?',[id]).length,0,'new releases do not grow the retired bridge even before activation');
  store.db.run('INSERT INTO content_lifecycle_release_holds VALUES(?)',[id]);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_release_holds WHERE content_id=?',[id]).length,1);
  index(store);store.activateStorageContentLifecycle();drain(store);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_release_holds').length,0);
  await store.withPreparedContentOwnership(async()=>store.pinPreparedContent(store.requireContentPreparationOwner(),id));
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_release_holds').length,0);
  drain(store);assert.equal(store.read(holder.objectId).data.content,'retained bridge bytes');
});
test('physical content deletion requires a sealed proof once the new collector owns cleanup', t => {
  const store=fixture(t),id=store.putContent('physical delete belongs to the collector');index(store);store.activateStorageContentLifecycle();
  assert.throws(()=>store.db.run('DELETE FROM contents WHERE id=?',[id]),/content_gc_seal_required/);
  drain(store);assert.equal(store.rows('SELECT 1 FROM contents WHERE id=?',[id]).length,0);
});
test('a reader keeps its pre-seal WAL snapshot until it ends the read transaction', t => {
  const store = fixture(t), id = store.putContent('snapshot retained bytes');
  index(store); store.activateStorageContentLifecycle();
  const reader = UnifiedDataStore.openReadOnly(path.dirname(store.filePath), store.databaseId);
  try {
    reader.readTransaction(() => {
      assert.equal(reader.content(id).toString(), 'snapshot retained bytes');
      drain(store);
      assert.equal(reader.content(id).toString(), 'snapshot retained bytes');
    });
    assert.throws(() => reader.content(id), /content_missing/);
  } finally { reader.close(); }
});
test('restart cancels an unsealed incarnation and resumes bounded physical purge of a sealed group', t => {
  const store = fixture(t), root = path.dirname(store.filePath), databaseId = store.databaseId, id = store.putContent(crypto.randomBytes(2 * 1024 * 1024));
  const expected = store.rows('SELECT COUNT(*) AS n,SUM(stored_byte_length) AS bytes FROM contents')[0];
  index(store); store.activateStorageContentLifecycle(); watch(store, id);
  const stale = store.prepareStorageGcBatch(128);
  store.close();
  let resumed = UnifiedDataStore.open(root, databaseId);
  try {
    assert.throws(() => resumed.activateStorageContentLifecycle(), /content_gc_writer_required/);
    resumed.beginContentPreparationRecovery(); resumed.activateStorageContentLifecycle();
    assert.equal(resumed.commitStorageGcBatch(stale).applied, false);
    seal(resumed, id);
    const first = quantum(resumed);
    assert.ok(first.chunks.length > 0 && first.chunks.length <= 128);
    resumed.close();
    resumed = UnifiedDataStore.open(root, databaseId);
    resumed.beginContentPreparationRecovery(); resumed.activateStorageContentLifecycle();
    assert.throws(() => resumed.content(id), /content_retired/);
    const deleted = [];
    for (let i = 0; i < 10000; i++) {
      const batch = resumed.prepareStorageGcBatch(128), result = resumed.commitStorageGcBatch(batch);
      if (result.deletedContents) deleted.push(batch.sourceId);
      if (!batch.pending) break;
    }
    assert.ok(deleted.includes(id));
    assert.equal(new Set(deleted).size, deleted.length);
    const state = resumed.rows('SELECT deleted_contents,reclaimed_stored_bytes FROM content_lifecycle_gc_state WHERE id=1')[0];
    assert.equal(state.deleted_contents, expected.n); assert.equal(state.reclaimed_stored_bytes, expected.bytes);
    assert.equal(resumed.rows('SELECT 1 FROM content_lifecycle_gc_groups').length, 0);
    assert.equal(resumed.rows('SELECT 1 FROM content_lifecycle_gc_members').length, 0);
  } finally { resumed.close(); }
});
for (const missingParents of [0, 128]) test(`incoming purge rechecks a source restored after preparation (${missingParents} other parents)`, async t => {
  const store=fixture(t),original=Buffer.from('target restored after physical purge'),target=store.putContent(original);
  const holder=store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'restored-incoming-source',data:{category:'inbox',title:'preserved source',status:'captured',content:'initial'}});
  index(store);store.activateStorageContentLifecycle({strictPublication:true});seal(store,target);
  const source='000-restored-incoming-source',bytes=Buffer.from(JSON.stringify({contentId:target}));
  store.db.run('INSERT INTO content_lifecycle_edges VALUES(?,?,0)',[source,target]);
  for(let i=0;i<missingParents;i++)store.db.run('INSERT INTO content_lifecycle_edges VALUES(?,?,0)',[`missing-${String(i).padStart(4,'0')}`,target]);
  const stale=store.prepareStorageGcBatch(128);
  assert.equal(stale.action,'purge');assert.ok(stale.edges.some(edge=>edge.source===source));
  assert.equal(stale.incomingComplete,missingParents===0);
  store.db.run('INSERT INTO contents VALUES(?,?,?,?,?,?,?,NULL)',[source,crypto.createHash('sha256').update(bytes).digest('hex'),'application/json','utf8',bytes.length,bytes.length,bytes]);
  await store.withPreparedContentOwnership(async()=>{
    await store.prepareContentReferencePublication(source,require('../out/contentReferences.js').summarizeContentBytes(bytes));
    store.db.run('UPDATE memories SET content_id=? WHERE id=?',[source,holder.objectId]);
  });
  assert.equal(store.commitStorageGcBatch(stale).applied,true);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_edges WHERE source_id=? AND target_id=?',[source,target]).length,1);
  index(store);drain(store);
  assert.equal(store.rows('SELECT 1 FROM contents WHERE id=?',[target]).length,0);
  store.db.run('INSERT INTO contents VALUES(?,?,?,?,?,?,?,NULL)',[target,crypto.createHash('sha256').update(original).digest('hex'),'text/plain','utf8',original.length,original.length,original]);
  index(store);drain(store);
  assert.deepEqual(store.content(target),original);
});
test('large reverse fanout is watched and expanded in pages before the single seal', t => {
  const store = fixture(t), target = store.putContent('fanout target');
  for (let i = 0; i < 301; i++) store.putContent(JSON.stringify({ contentId: target, n: i }));
  index(store); store.activateStorageContentLifecycle();
  store.db.run('INSERT INTO content_lifecycle_gc_pending VALUES(?,?)', [target, crypto.randomUUID()]);
  let sawPaged = false;
  for (let i = 0; i < 10000; i++) {
    const batch = quantum(store);
    assert.ok((batch.ids?.length || 0) <= 128);
    if (batch.sourceId === target && batch.action === 'expand' && !batch.complete) sawPaged = true;
    if (!batch.pending) break;
  }
  assert.equal(sawPaged, true);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM contents')[0].n, 0);
});
test('a killed Writer loses its exemption before a new incarnation can resume collection', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-gc-killed-writer-'));
  const {spawn}=require('node:child_process'),{once}=require('node:events');let store;
  const script=String.raw`
const fs=require('node:fs'),path=require('node:path');
const {UnifiedDataStore}=require(process.argv[2]),{summarizeContentBytes}=require(process.argv[3]);
const root=process.argv[1],store=new UnifiedDataStore(root);store.beginContentPreparationRecovery();
const target=store.putContent('recover after a real Writer crash');
for(let i=0;i<2000;i++){const batch=store.prepareStorageReferenceBatch(128);store.commitStorageReferenceBatch(batch);if(!batch.pending)break;}
store.activateStorageContentLifecycle({strictPublication:true});
for(let i=0;i<2000;i++){store.commitStorageGcBatch(store.prepareStorageGcBatch(128));if(store.rows("SELECT 1 FROM content_lifecycle_gc_members m JOIN content_lifecycle_gc_groups g ON g.id=m.group_id WHERE m.content_id=? AND g.state='collecting'",[target]).length)break;}
const bytes=Buffer.from(JSON.stringify({sourceContents:Object.fromEntries([...Array.from({length:300},(_,i)=>'crash-missing-'+i),target].map((id,i)=>[i,id]))}));
const source=store.putContent(bytes),summary=summarizeContentBytes(bytes);summary.targets=[...summary.targets.filter(id=>id!==target),target];
store.withPreparedContentOwnership(async()=>{
 const preparing=store.prepareContentReferencePublication(source,summary);
 fs.writeFileSync(path.join(root,'phase-ready.json'),JSON.stringify({source,target,owner:store.requireContentPreparationOwner()}));
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
 await preparing;
}).catch(error=>{process.stderr.write(error.stack);process.exitCode=1});
`;
  const child=spawn(process.execPath,['--experimental-sqlite','-e',script,root,path.resolve(__dirname,'../out/db/unifiedDataStore.js'),path.resolve(__dirname,'../out/contentReferences.js')],{stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',bytes=>{stderr+=bytes;});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGKILL');await ended;}store?.close();for(const name of fs.readdirSync(root)){const file=path.join(root,name);assert.ok(fs.lstatSync(file).isFile());fs.unlinkSync(file);}fs.rmdirSync(root);});
  const ready=path.join(root,'phase-ready.json'),deadline=Date.now()+10000;
  while(!fs.existsSync(ready)){assert.equal(child.exitCode,null,stderr);assert.equal(child.signalCode,null,stderr);assert.ok(Date.now()<deadline,stderr||'Writer did not reach the owned private phase');await new Promise(resolve=>setTimeout(resolve,20));}
  const phase=JSON.parse(fs.readFileSync(ready,'utf8')),ended=once(child,'exit');child.kill('SIGKILL');await ended;
  store=new UnifiedDataStore(root);store.beginContentPreparationRecovery();store.activateStorageContentLifecycle({strictPublication:true});
  assert.equal(store.rows('SELECT recover_exemptions FROM content_lifecycle_gc_state')[0].recover_exemptions,1);
  const recovery=store.prepareStorageGcBatch(128);assert.equal(recovery.action,'recover');assert.deepEqual(recovery.ids,[phase.source]);
  store.commitStorageGcBatch(recovery);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_gc_debt WHERE content_id=?',[phase.source]).length,1);
  for(let i=0;i<1000;i++)if(!store.recoverContentPreparations(128).pending)break;
  index(store);drain(store);
  for(const table of ['contents','content_lifecycle_gc_exempt_sources','content_lifecycle_gc_debt','content_lifecycle_prepare_owners','content_lifecycle_prepare_pins','content_lifecycle_release_holds'])assert.equal(store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n,0,table);
});
