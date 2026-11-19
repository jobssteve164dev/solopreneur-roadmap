const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('./runtime-data-fixture.cjs');

function cleanupCreated(root) {
  const dirs = [root], files = [];
  for (let i = 0; i < dirs.length; i++) for (const name of fs.readdirSync(dirs[i])) {
    const file = path.join(dirs[i], name);
    if (fs.lstatSync(file).isDirectory()) dirs.push(file); else files.push(file);
  }
  for (const file of files) fs.unlinkSync(file);
  for (const dir of dirs.reverse()) fs.rmdirSync(dir);
}
async function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-data-lifecycle-'));
  const root = path.join(base, 'global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  let store = new UnifiedDataStore(root), ops = createRuntimeDataOperations(store);
  t.after(async () => { await ops.close(); store.close(); cleanupCreated(base); });
  fs.mkdirSync(path.join(project, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(project, '.solopreneur', 'roadmap.csv'), 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\nstep,执行,完整目标,实施,,codex,执行,Pending,2026-01-01T00:00:00.000Z,');
  await ops({ operation: 'accept_roadmap_csv', input: { root: project } });
  const run = await ops({ operation: 'prepare_run', input: { root: project, executionLogId: 1, nodeId: 'step', runKind: 'step', prompt: '完整输入', command: 'fixture', userMessage: '完整输入', metadata: { interactiveSession: true }, idempotencyKey: 'prepare' } });
  const input = { executionLogId: 1, generation: run.generation, stream: 'stdout', sequence: 0, offset: 0, bytes: Buffer.from('原文🌿\n').toString('base64'), idempotencyKey: 'log-0' };
  return { get store() { return store; }, root, project, base, run, input, async reopen() {
    await ops.close(); store.close(); store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store);
  } };
}
test('log receipts keep the exact retry result without a separate content object', async t => {
  const f = await fixture(t);
  const result = await f.store.appendRunLog(f.run.projectId, f.input);
  const row = f.store.rows("SELECT * FROM requests WHERE idempotency_key='log-0'")[0];
  assert.equal(row.result_content_id, null, 'short receipt must leave the shared content pool');
  assert.deepEqual(JSON.parse(row.result_inline_json), result);
  await f.reopen();
  assert.deepEqual(await f.store.appendRunLog(f.run.projectId, f.input), result);
  await assert.rejects(f.store.appendRunLog(f.run.projectId, { ...f.input, bytes: Buffer.from('different').toString('base64') }), /idempotency_conflict/);
  const reader = UnifiedDataStore.openReadOnly(f.root);
  try { assert.deepEqual(reader.readRunLog(f.run.projectId, { executionLogId: 1, stream: 'output' }).bytes, f.input.bytes); }
  finally { reader.close(); }
});
test('historical receipt conversion preserves replay and routes released content to unified GC without bridge holds', async t => {
  const f = await fixture(t), result = await f.store.appendRunLog(f.run.projectId, f.input);
  const original = f.store.putContent(JSON.stringify(result), 'application/json');
  f.store.db.run('UPDATE requests SET result_inline_json=NULL,result_content_id=? WHERE id=?', [original, result.requestId]);
  for (let i = 0; i < 100; i++) { const plan = f.store.prepareStorageColdBatch(8); if (!plan.pending) break; f.store.commitStorageColdBatch(plan); }
  assert.deepEqual(await f.store.appendRunLog(f.run.projectId, f.input), result);
  assert.equal(f.store.rows('SELECT result_content_id FROM requests WHERE id=?', [result.requestId])[0].result_content_id, null);
  assert.equal(f.store.rows('SELECT content_id FROM content_lifecycle_release_holds WHERE content_id=?', [original]).length, 0);
  f.store.queueStorageCleanupContents([original]); f.store.prepareDatabaseStorageCleanup();
  assert.equal(f.store.rows('SELECT content_id FROM database_storage_cleanup_candidates WHERE content_id=?', [original]).length, 0);
  assert.equal(f.store.rows('SELECT content_id FROM content_lifecycle_gc_pending WHERE content_id=?', [original]).length, 1);
  assert.equal(f.store.usesStorageContentLifecycle(), false);
  const legacy = f.store.finalizeDatabaseStorageCleanupBatch(8);
  assert.equal(legacy.deletedContents, 0); assert.equal(legacy.reclaimedStoredBytes, 0);
  assert.equal(f.store.rows('SELECT content_id FROM content_lifecycle_gc_pending WHERE content_id=?', [original]).length, 1);
  assert.deepEqual(JSON.parse(f.store.content(original).toString()), result);
});
test('cold receipt catch-up drives indexed lookups from its queue with production-sized history', async t => {
  const f = await fixture(t);
  const result = await f.store.appendRunLog(f.run.projectId, f.input);
  const original = f.store.putContent(JSON.stringify(result), 'application/json');
  f.store.db.run('UPDATE requests SET result_inline_json=NULL,result_content_id=? WHERE id=?', [original, result.requestId]);
  f.store.db.run('UPDATE content_lifecycle_progress SET receipt_cursor=(SELECT MAX(sequence) FROM events) WHERE id=1');
  // Reproduce production's planner estimates while the new queue has no statistics.
  f.store.db.run('ANALYZE sqlite_schema');
  const stats = [
    ['events', 'events_request', '1278327 1'],
    ['events', 'sqlite_autoindex_events_2', '1278327 1'],
    ['events', 'sqlite_autoindex_events_1', '1278327 1'],
    ['requests', 'sqlite_autoindex_requests_1', '1278331 1'],
    ['requests', 'sqlite_autoindex_requests_2', '1278331 159792 1'],
  ];
  for (const row of stats) f.store.db.run('INSERT INTO sqlite_stat1 VALUES(?,?,?)', row);
  f.store.db.run('ANALYZE sqlite_schema');

  const plans = [];
  const rows = f.store.rows;
  f.store.rows = function (sql, parameters) {
    if (sql.includes('FROM content_lifecycle_receipt_pending pending')) {
      plans.push(rows.call(this, 'EXPLAIN QUERY PLAN ' + sql, parameters).map(row => row.detail));
    }
    return rows.call(this, sql, parameters);
  };
  const batch = f.store.prepareStorageColdBatch(64);
  assert.equal(batch.nextReceiptCursor, batch.receiptCursor);
  assert.equal(batch.receipts.length, 1);
  assert.equal(batch.receipts[0].id, result.requestId);
  assert.equal(f.store.commitStorageColdBatch(batch).inlinedReceipts, 1);
  assert.deepEqual(await f.store.appendRunLog(f.run.projectId, f.input), result);
  const drained = f.store.prepareStorageColdBatch(64);
  assert.equal(drained.receipts.length, 0);
  assert.equal(drained.dirtyReceipts.length, 0);
  assert.equal(plans.length, 2);
  for (const plan of plans) {
    assert.match(plan[0], /^SCAN pending\b/);
    assert.ok(plan.some(step => /^SEARCH requests .*\(id=\?\)/.test(step)));
    assert.ok(plan.some(step => /^SEARCH events USING INDEX events_request \(request_id=\?\)/.test(step)));
  }
});
test('cold JSON conversion retains identity and exact bytes and reaches zero work after restart', async t => {
  const f = await fixture(t);
  // Emulate an old, uncompressed body. Existing write behavior intentionally skips compression below 16KiB.
  const bytes = Buffer.from(JSON.stringify({ text: '完整历史与关系🌿'.repeat(240) }));
  const id = crypto.randomUUID(), hash = crypto.createHash('sha256').update(bytes).digest('hex');
  f.store.db.run('INSERT INTO contents VALUES(?,?,?,?,?,?,?,NULL)', [id, hash, 'application/json', 'utf8', bytes.length, bytes.length, bytes]);
  for (let i = 0; i < 100; i++) { const plan = f.store.prepareStorageColdBatch(8); if (!plan.pending) break; f.store.commitStorageColdBatch(plan); }
  const row = f.store.rows('SELECT * FROM contents WHERE id=?', [id])[0];
  assert.equal(row.encoding, 'gzip:utf8'); assert.equal(row.sha256, hash); assert.equal(row.byte_length, bytes.length);
  assert.ok(row.stored_byte_length < bytes.length * .9); assert.deepEqual(f.store.content(id), bytes);
  const before = f.store.rows('SELECT * FROM content_lifecycle_progress');
  const plan = f.store.prepareStorageColdBatch(8); assert.equal(plan.pending, false);
  f.store.commitStorageColdBatch(plan);
  assert.deepEqual(f.store.rows('SELECT * FROM content_lifecycle_progress'), before);
});

for (const { label, pinnedBeforeRead, initiallyQueued } of [
  { label: 'before the historical scan', pinnedBeforeRead: true, initiallyQueued: false },
  { label: 'after the historical scan', pinnedBeforeRead: false, initiallyQueued: false },
  { label: 'after reading the pending queue', pinnedBeforeRead: false, initiallyQueued: true },
]) {
  test(`cold conversion preserves a pin acquired ${label}`, async t => {
    const f = await fixture(t);
    const bytes = Buffer.from(JSON.stringify({ text: '完整准备内容🌿'.repeat(180) }));
    const id = f.store.putContent(bytes, 'application/json');
    const encoding = () => f.store.rows('SELECT encoding FROM contents WHERE id=?', [id])[0].encoding;
    const queued = () => Boolean(f.store.rows('SELECT 1 FROM content_lifecycle_cold_pending WHERE content_id=?', [id])[0]);
    const prepare = () => {
      const reader = UnifiedDataStore.openReadOnly(f.root);
      try { return reader.prepareStorageColdBatch(64); }
      finally { reader.close(); }
    };
    if (initiallyQueued) {
      f.store.db.run('UPDATE content_lifecycle_progress SET content_cursor=(SELECT rowid FROM contents WHERE id=?) WHERE id=1', [id]);
    } else f.store.db.run('DELETE FROM content_lifecycle_cold_pending WHERE content_id=?', [id]);
    const initial = pinnedBeforeRead ? undefined : prepare();
    if (initial) assert.ok(initial.contents.some(item => item.id === id));

    await f.store.withPreparedContentOwnership(async () => {
      f.store.pinPreparedContent(f.store.requireContentPreparationOwner(), id);
      let batch = initial || prepare();
      if (pinnedBeforeRead) assert.ok(!batch.contents.some(item => item.id === id));
      for (let index = 0; index < 20 && batch.pending; index++) {
        f.store.commitStorageColdBatch(batch);
        assert.equal(encoding(), 'utf8');
        batch = prepare();
      }
      assert.equal(batch.pending, false);
      assert.ok(queued(), 'the deferred content must survive advancing the historical cursor');
      assert.deepEqual(f.store.content(id), bytes);
    });

    const deferred = prepare();
    assert.ok(deferred.contents.some(item => item.id === id));
    assert.equal(f.store.commitStorageColdBatch(deferred).compressedContents, 1);
    assert.equal(encoding(), 'gzip:utf8');
    assert.equal(queued(), false);
    assert.deepEqual(f.store.content(id), bytes);
  });
}

test('storage cursors cannot skip new JSON when SQLite reuses the highest rowid', async t => {
  const f = await fixture(t);
  const make = suffix => Buffer.from(JSON.stringify({ retained: suffix + '历史🌿'.repeat(180) }));
  const oldId = f.store.putContent(make('old'), 'application/json');
  for (let i = 0; i < 100; i++) { const plan = f.store.prepareStorageColdBatch(8); if (!plan.pending) break; f.store.commitStorageColdBatch(plan); }
  const oldRowid = f.store.rows('SELECT rowid AS n FROM contents WHERE id=?', [oldId])[0].n;
  f.store.db.run('DELETE FROM contents WHERE id=?', [oldId]);
  const id = f.store.putContent(make('new'), 'application/json');
  assert.equal(f.store.rows('SELECT rowid AS n FROM contents WHERE id=?', [id])[0].n, oldRowid);
  for (let i = 0; i < 100; i++) { const plan = f.store.prepareStorageColdBatch(8); if (!plan.pending) break; f.store.commitStorageColdBatch(plan); }
  assert.equal(f.store.rows('SELECT encoding FROM contents WHERE id=?', [id])[0].encoding, 'gzip:utf8');
});
test('result representations are exclusive and stale cold batches cannot advance or count twice', async t => {
  const f = await fixture(t), result = await f.store.appendRunLog(f.run.projectId, f.input);
  const id = f.store.putContent('{}', 'application/json');
  assert.throws(() => f.store.db.run('UPDATE requests SET result_content_id=? WHERE id=?', [id, result.requestId]), /request_result_invalid/);
  const first = f.store.prepareStorageColdBatch(8), second = f.store.prepareStorageColdBatch(8);
  assert.equal(f.store.commitStorageColdBatch(first).applied, true);
  const before = f.store.rows('SELECT * FROM content_lifecycle_progress');
  assert.equal(f.store.commitStorageColdBatch(second).applied, false);
  assert.deepEqual(f.store.rows('SELECT * FROM content_lifecycle_progress'), before);
});

test('an existing gzip representation never forces identity merging during cold conversion', async t => {
  const f = await fixture(t), bytes = Buffer.from(JSON.stringify({ retained: '共享历史'.repeat(600) }));
  const hash = crypto.createHash('sha256').update(bytes).digest('hex'), compressed = require('node:zlib').gzipSync(bytes);
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  f.store.db.run('INSERT INTO contents VALUES(?,?,?,?,?,?,?,NULL)', [ids[0], hash, 'application/json', 'utf8', bytes.length, bytes.length, bytes]);
  f.store.db.run('INSERT INTO contents VALUES(?,?,?,?,?,?,?,NULL)', [ids[1], hash, 'application/json', 'gzip:utf8', bytes.length, compressed.length, compressed]);
  for (let i = 0; i < 100; i++) { const plan = f.store.prepareStorageColdBatch(8); if (!plan.pending) break; f.store.commitStorageColdBatch(plan); }
  await f.reopen();
  for (const id of ids) assert.deepEqual(f.store.content(id), bytes);
  assert.equal(f.store.rows('SELECT encoding FROM contents WHERE id=?', [ids[0]])[0].encoding, 'utf8');
  assert.equal(f.store.prepareStorageColdBatch(8).pending, false);
});
test('cold preparation runs on the real read-only Maintenance Worker and remains restartable', async t => {
  const f = await fixture(t);
  const { Worker } = require('node:worker_threads');
  const { once } = require('node:events');
  const worker = new Worker(path.resolve(__dirname, '../out/maintenanceComputeWorker.js'), { workerData: { root: f.root, databaseId: f.store.databaseId } });
  t.after(() => worker.terminate());
  const [ready] = await once(worker, 'message'); assert.equal(ready.ready, true);
  assert.ok(ready.threadId > 0);
  const original = JSON.stringify({ text: '保留逐字节历史🌿'.repeat(200) });
  const id = f.store.putContent(original, 'application/json');
  f.store.setMaintenanceCompute({ prepareStorageColdBatch: async limit => {
    const response = once(worker, 'message'); worker.postMessage({ id: 1, operation: 'prepare_storage_cold_batch', limit });
    const [message] = await response; assert.equal(message.error, undefined); return message.result;
  } });
  for (let i = 0; i < 100; i++) if (!(await f.store.maintainStorageColdQuantum(8)).pending) break;
  assert.equal(f.store.rows('SELECT encoding FROM contents WHERE id=?', [id])[0].encoding, 'gzip:utf8');
  assert.equal(f.store.content(id).toString(), original);
  await f.reopen(); assert.equal(f.store.prepareStorageColdBatch(8).pending, false);
});
test('one lifecycle entry advances readonly reference, cold and GC quanta through restart and idle', async t => {
  const f=await fixture(t),{Worker}=require('node:worker_threads'),{once}=require('node:events');
  assert.equal(typeof f.store.maintainStorageLifecycleQuantum,'function');
  const worker=new Worker(path.resolve(__dirname,'../out/maintenanceComputeWorker.js'),{workerData:{root:f.root,databaseId:f.store.databaseId}});
  t.after(()=>worker.terminate());await once(worker,'message');let sequence=0;
  const rpc=async(operation,input={})=>{const response=once(worker,'message');worker.postMessage({id:++sequence,operation,...input});const[message]=await response;assert.equal(message.error,undefined);return message.result;};
  const compute={prepareStorageRunOutputBatch:limit=>rpc('prepare_storage_run_output_batch',{limit}),prepareStorageRepairBatch:excludedIds=>rpc('prepare_storage_repair_batch',{searchObjectIds:excludedIds}),prepareStorageReferenceBatch:limit=>rpc('prepare_storage_reference_batch',{limit}),prepareStorageColdBatch:limit=>rpc('prepare_storage_cold_batch',{limit}),prepareStorageGcBatch:limit=>rpc('prepare_storage_gc_batch',{limit})};
  f.store.setMaintenanceCompute(compute);f.store.beginContentPreparationRecovery();
  const ids=Array.from({length:12},(_,i)=>f.store.putContent(`lifecycle orphan ${i}`));
  const held=f.store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'lifecycle-held',data:{category:'inbox',title:'retained full history',status:'captured',content:{contentId:ids[0]}}});
  f.store.queueStorageCleanupContents(ids);f.store.activateStorageContentLifecycle();
  const phases=new Set();
  for(let i=0;i<2000;i++){const result=await f.store.maintainStorageLifecycleQuantum(8);phases.add(result.phase);if(!result.pending)break;assert.notEqual(i,1999);}
  assert.deepEqual([...phases].sort(),['byproducts','cold','gc','reference']);
  assert.equal(f.store.rows('SELECT 1 FROM database_storage_cleanup_candidates').length,0);
  assert.equal(f.store.rows('SELECT 1 FROM contents WHERE id=?',[ids[0]]).length,1);
  for(const id of ids.slice(1))assert.equal(f.store.rows('SELECT 1 FROM contents WHERE id=?',[id]).length,0);
  assert.equal(f.store.read(held.objectId,1).data.content,JSON.stringify({contentId:ids[0]}));
  const privateBytes=Buffer.from(JSON.stringify({sourceContents:Object.fromEntries(Array.from({length:301},(_,i)=>[i,`future-${i}`]))}));
  const privateId=f.store.putContent(privateBytes,'text/plain');
  let resume,owned;const originalImmediate=global.setImmediate;
  global.setImmediate=callback=>{resume=callback;return {};};
  try{owned=f.store.withPreparedContentOwnership(()=>f.store.prepareContentReferencePublication(privateId,require('../out/contentReferences.js').summarizeContentBytes(privateBytes)));}
  finally{global.setImmediate=originalImmediate;}
  try{
    assert.equal(typeof resume,'function');let last;
    for(let i=0;i<18;i++)last=await f.store.maintainStorageLifecycleQuantum(8);
    assert.equal(last.pending,true,'a live manifest must retain its debt');
    assert.equal(last.runnable??last.pending,false,'blocked private publication must not busy-loop the Actor and Compute');
  }finally{resume();await owned;}
  for(let i=0;i<2000;i++){const result=await f.store.maintainStorageLifecycleQuantum(8);if(!result.pending)break;assert.notEqual(i,1999);}
  const prepareReference=compute.prepareStorageReferenceBatch;
  let release,started,entered=false;const gate=new Promise(resolve=>{release=resolve;}),preparing=new Promise(resolve=>{started=resolve;});
  compute.prepareStorageReferenceBatch=async limit=>{const batch=await prepareReference(limit);entered=true;started();await gate;return batch;};
  let inFlight,outcome;
  for(let i=0;i<4;i++){
    inFlight=f.store.maintainStorageLifecycleQuantum(8);outcome=inFlight.then(()=>null,error=>error);
    await Promise.race([preparing,outcome]);if(entered)break;assert.equal(await outcome,null);
  }
  assert.equal(entered,true);assert.equal(f.store.maintainStorageLifecycleQuantum(8),inFlight,'overlapping ticks share the same quantum');
  let reopened=false;const reopening=f.reopen().then(()=>{reopened=true;});
  await new Promise(resolve=>setImmediate(resolve));const waited=!reopened;release();
  const error=await outcome;await reopening;
  assert.equal(waited,true,'closing must wait for the already admitted readonly/Writer quantum');assert.equal(error,null);
  f.store.setMaintenanceCompute(compute);f.store.beginContentPreparationRecovery();
  const restartedOrphan=f.store.putContent('orphan created by the replacement Writer');
  for(let i=0;i<2000;i++){const result=await f.store.maintainStorageLifecycleQuantum(8);if(!result.pending)break;assert.notEqual(i,1999);}
  assert.equal(f.store.rows('SELECT 1 FROM contents WHERE id=?',[restartedOrphan]).length,0);
  const changes=f.store.rows('SELECT total_changes() AS n')[0].n;
  for(let i=0;i<9;i++)assert.equal((await f.store.maintainStorageLifecycleQuantum(8)).pending,false);
  assert.equal(f.store.rows('SELECT total_changes() AS n')[0].n,changes);
});
test('the real Runtime Writer wires lifecycle computation while retaining a foreground write', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-lifecycle-actor-'));
  const bootstrap=new UnifiedDataStore(root),databaseId=bootstrap.databaseId;
  const ids=Array.from({length:5},(_,i)=>bootstrap.putContent(`Actor orphan ${i}`));
  bootstrap.queueStorageCleanupContents(ids);bootstrap.beginContentPreparationRecovery();bootstrap.activateStorageContentLifecycle();bootstrap.close();
  const {RuntimeDataExecutionDomains}=require('../out/runtimeDataExecutionDomains.js');
  const domains=await RuntimeDataExecutionDomains.start({root,databaseId});
  t.after(async()=>{await domains.close();cleanupCreated(root);});
  const reader=UnifiedDataStore.openReadOnly(root);t.after(()=>reader.close());
  let retained;
  for(let i=0;i<1000;i++){
    const maintenance=domains.dispatch({operation:'maintain_database_storage',input:{phase:'lifecycle',automatic:true,limit:8}});
    if(i===0)retained=await domains.dispatch({operation:'write',input:{kind:'memory',action:'create',scope:null,idempotencyKey:'lifecycle-foreground-write',data:{category:'inbox',title:'foreground result',status:'captured',content:'完整前台结果🌿'}}});
    const result=await maintenance;if(!result.pending)break;assert.notEqual(i,999);
  }
  for(const id of ids)assert.equal(reader.rows('SELECT 1 FROM contents WHERE id=?',[id]).length,0);
  assert.equal(reader.rows('SELECT 1 FROM database_storage_cleanup_candidates').length,0);
  assert.equal(reader.read(retained.objectId,1).data.content,'完整前台结果🌿');
});
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => JSON.stringify(key) + ':' + canonicalJson(child)).join(',') + '}';
  return JSON.stringify(value);
}
test('new archives retain inline receipts and schema 74 archives normalize only the added nullable column', async t => {
  const f = await fixture(t), result = await f.store.appendRunLog(f.run.projectId, f.input);
  const archive = path.join(f.base, 'new-archive.json');
  await f.store.exportProject({ root: f.project, destination: archive, idempotencyKey: 'export' });
  const envelope = JSON.parse(fs.readFileSync(archive, 'utf8'));
  assert.ok(!envelope.archive.tables.some(table => table.name.startsWith('content_lifecycle_')));
  const exported = envelope.archive.tables.find(table => table.name === 'requests').rows.find(row => row.idempotency_key === 'log-0');
  assert.deepEqual(JSON.parse(exported.result_inline_json), result);
  const target = new UnifiedDataStore(path.join(f.base, 'target'));
  t.after(() => target.close());
  await target.importProject({ source: archive, root: path.join(f.base, 'imported'), idempotencyKey: 'import' });
  assert.deepEqual(JSON.parse(target.rows("SELECT result_inline_json FROM requests WHERE idempotency_key='log-0'")[0].result_inline_json), result);
  // A genuinely old archive has external results, not inline values with the new column hidden.
  const externalId = f.store.putContent(JSON.stringify(result), 'application/json');
  f.store.db.run('UPDATE requests SET result_inline_json=NULL,result_content_id=? WHERE id=?', [externalId, result.requestId]);
  const externalArchive = path.join(f.base, 'external-archive.json');
  await f.store.exportProject({ root: f.project, destination: externalArchive, idempotencyKey: 'export-external' });
  const old = JSON.parse(fs.readFileSync(externalArchive, 'utf8')); old.archive.sourceSchemaVersion = 74;
  old.archive.tables.find(table => table.name === 'requests').rows.forEach(row => { delete row.result_inline_json; });
  old.sha256 = crypto.createHash('sha256').update(canonicalJson(old.archive)).digest('hex');
  const oldArchive = path.join(f.base, 'old-archive.json'); fs.writeFileSync(oldArchive, canonicalJson(old));
  const oldTarget = new UnifiedDataStore(path.join(f.base, 'old-target')); t.after(() => oldTarget.close());
  oldTarget.write({ action: 'create', kind: 'memory', scope: null, idempotencyKey: 'existing-event', data: { title: 'before import', category: 'inbox', status: 'captured', content: 'existing' } });
  await oldTarget.importProject({ source: oldArchive, root: path.join(f.base, 'old-imported'), idempotencyKey: 'old-import' });
  const request = oldTarget.rows("SELECT * FROM requests WHERE idempotency_key='log-0'")[0];
  assert.equal(request.result_inline_json, null); assert.deepEqual(JSON.parse(oldTarget.content(request.result_content_id).toString()), result);
  assert.notEqual(request.committed_sequence, result.committedSequence);
  for (let i = 0; i < 200; i++) { const plan = oldTarget.prepareStorageColdBatch(8); if (!plan.pending) break; oldTarget.commitStorageColdBatch(plan); }
  const migrated = oldTarget.rows("SELECT * FROM requests WHERE idempotency_key='log-0'")[0];
  assert.equal(migrated.result_content_id, null); assert.deepEqual(JSON.parse(migrated.result_inline_json), result);
});

test('pooled receipts appearing behind the event cursor are still converted', async t => {
  const f = await fixture(t), result = await f.store.appendRunLog(f.run.projectId, f.input);
  for (let i = 0; i < 100; i++) { const plan = f.store.prepareStorageColdBatch(8); if (!plan.pending) break; f.store.commitStorageColdBatch(plan); }
  const externalId = f.store.putContent(JSON.stringify(result), 'application/json');
  // Old imports/recovered records can appear below a persisted high sequence cursor.
  f.store.db.run('UPDATE requests SET result_inline_json=NULL,result_content_id=? WHERE id=?', [externalId, result.requestId]);
  for (let i = 0; i < 100; i++) { const plan = f.store.prepareStorageColdBatch(8); if (!plan.pending) break; f.store.commitStorageColdBatch(plan); }
  assert.equal(f.store.rows('SELECT result_content_id FROM requests WHERE id=?', [result.requestId])[0].result_content_id, null);
  assert.deepEqual(await f.store.appendRunLog(f.run.projectId, f.input), result);
});
test('a reader crossing cold conversion never combines old encoding with new payload', async t => {
  const f = await fixture(t), original = Buffer.from(JSON.stringify({ text: '并发分页🌿'.repeat(300) }));
  const id = f.store.putContent(original, 'application/json');
  const reader = UnifiedDataStore.openReadOnly(f.root); t.after(() => reader.close());
  const metadata = reader.rows('SELECT sha256,byte_length,stored_byte_length,encoding,chunk_index_json FROM contents WHERE id=?', [id])[0];
  assert.equal(metadata.encoding, 'utf8');
  for (let i = 0; i < 100; i++) { const plan = f.store.prepareStorageColdBatch(8); if (!plan.pending) break; f.store.commitStorageColdBatch(plan); }
  assert.equal(f.store.rows('SELECT encoding FROM contents WHERE id=?', [id])[0].encoding, 'gzip:utf8');
  assert.deepEqual(reader.contentRange(id, metadata, 7, original.length - 7), original.subarray(7, original.length - 7));
  assert.deepEqual(reader.readTransaction(() => reader.content(id)), original, 'nested content reads must reuse the caller snapshot');
});
test('the public paged reader keeps its snapshot when the Writer recodes the body mid-read', async t => {
  const f = await fixture(t);
  const asset = f.store.write({ kind: 'asset', action: 'create', scope: f.run.projectId, idempotencyKey: 'paged-asset', data: { name: 'history.json', origin: 'fixture', content: { text: '分页原文🌿'.repeat(300) } } });
  const id = f.store.readMetadata(asset.objectId).data.content_id, original = f.store.content(id);
  let plan;
  for (let i = 0; i < 100; i++) { plan = f.store.prepareStorageColdBatch(64); if (plan.contents.some(row => row.id === id)) break; assert.ok(plan.pending); f.store.commitStorageColdBatch(plan); }
  assert.ok(plan.contents.some(row => row.id === id));
  const reader = UnifiedDataStore.openReadOnly(f.root); t.after(() => reader.close());
  const readRows = reader.rows.bind(reader); let crossed = false;
  // Deterministic scheduling boundary; both connections still execute real SQLite reads/writes.
  reader.rows = (sql, values) => {
    const rows = readRows(sql, values);
    if (!crossed && values?.[0] === id && rows[0]?.encoding === 'utf8') { crossed = true; f.store.commitStorageColdBatch(plan); }
    return rows;
  };
  const page = reader.readPage({ ref: asset.objectId, field: 'content', limit: 256 });
  assert.equal(crossed, true); assert.deepEqual(Buffer.from(page.data, 'base64'), original.subarray(0, 256));
  assert.equal(f.store.rows('SELECT encoding FROM contents WHERE id=?', [id])[0].encoding, 'gzip:utf8');
});
test('one damaged retained body is preserved and does not block other cold work or grow on idle retries', async t => {
  const f = await fixture(t);
  const original = Buffer.from(JSON.stringify({ text: '保留损坏证据🌿'.repeat(300) }));
  const bad = f.store.putContent(original, 'application/json');
  const corrupt = Buffer.alloc(original.length, 120);
  f.store.db.run('UPDATE contents SET data=? WHERE id=?', [corrupt, bad]);
  const goodBytes = Buffer.from(JSON.stringify({ text: '其他历史正常退出🌿'.repeat(300) }));
  const good = f.store.putContent(goodBytes, 'application/json');
  assert.doesNotThrow(() => {
    for (let i = 0; i < 200; i++) { const plan = f.store.prepareStorageColdBatch(8); if (!plan.pending) break; f.store.commitStorageColdBatch(plan); }
  });
  assert.equal(f.store.rows('SELECT encoding FROM contents WHERE id=?', [good])[0].encoding, 'gzip:utf8');
  assert.equal(f.store.rows('SELECT error FROM content_lifecycle_faults WHERE content_id=?', [bad])[0].error, 'content_integrity_error');
  assert.deepEqual(Buffer.from(f.store.rows('SELECT data FROM contents WHERE id=?', [bad])[0].data), corrupt);
  const before = f.store.rows('SELECT total_changes() AS n')[0].n;
  for (let i = 0; i < 25; i++) { const plan = f.store.prepareStorageColdBatch(8); assert.equal(plan.pending, false); f.store.commitStorageColdBatch(plan); }
  assert.equal(f.store.rows('SELECT total_changes() AS n')[0].n, before);
  assert.equal(f.store.putContent(original, 'application/json'), bad);
  for (let i = 0; i < 200; i++) { const plan = f.store.prepareStorageColdBatch(8); if (!plan.pending) break; f.store.commitStorageColdBatch(plan); }
  assert.deepEqual(f.store.content(bad), original);
  assert.equal(f.store.rows('SELECT content_id FROM content_lifecycle_faults WHERE content_id=?', [bad]).length, 0);
});
test('a late fault observation cannot quarantine a body repaired before its commit', async t => {
  const f = await fixture(t), original = Buffer.from(JSON.stringify({ text: '迟到修复🌿'.repeat(350) }));
  const id = f.store.putContent(original, 'application/json'); f.store.db.run('UPDATE contents SET data=? WHERE id=?', [Buffer.alloc(original.length, 120), id]);
  let stale;
  for (let i = 0; i < 200; i++) { const plan = f.store.prepareStorageColdBatch(8); if (plan.faults.some(fault => fault.id === id)) { stale = plan; break; } assert.ok(plan.pending); f.store.commitStorageColdBatch(plan); }
  assert.ok(stale); assert.equal(f.store.putContent(original, 'application/json'), id);
  f.store.commitStorageColdBatch(stale);
  assert.equal(f.store.rows('SELECT content_id FROM content_lifecycle_faults WHERE content_id=?', [id]).length, 0);
  for (let i = 0; i < 200; i++) { const plan = f.store.prepareStorageColdBatch(8); if (!plan.pending) break; f.store.commitStorageColdBatch(plan); }
  assert.deepEqual(f.store.content(id), original);
  assert.equal(f.store.rows('SELECT encoding FROM contents WHERE id=?', [id])[0].encoding, 'gzip:utf8');
});
