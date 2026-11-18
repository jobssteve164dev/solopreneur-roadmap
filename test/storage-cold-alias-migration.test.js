const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Worker}=require('node:worker_threads');
const {once}=require('node:events');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {unifiedSchemaMigrations}=require('../out/db/unifiedSchemaMigrations.js');

test('an actual schema82 database upgrades without changing its checksum or bytes and resumes omitted alias cold work',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-alias-cold-upgrade-'));
  const latest=unifiedSchemaMigrations.pop();assert.equal(latest.version,83);
  let store,bodyId,checksum82;
  const bytes=Buffer.from(JSON.stringify({historical:'保留所有原文'.repeat(200)}));
  t.after(()=>store?.close());
  try{
    store=new UnifiedDataStore(root);
    bodyId=store.putContent(bytes,'application/json','repair:legacy:utf8');
    store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'retained-alias',data:{category:'inbox',title:'retained history',status:'captured',content:JSON.parse(bytes)}});
    assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_cold_pending WHERE content_id=?',[bodyId])[0].n,0);
    // A legacy completed cursor is an upgrade fixture; the actual async repair
    // producing this state has a separate Runtime/Worker regression.
    store.db.run('UPDATE content_lifecycle_progress SET content_cursor=(SELECT MAX(rowid) FROM contents),revision=revision+1 WHERE id=1');
    checksum82=store.rows('SELECT checksum FROM schema_migrations WHERE version=82')[0].checksum;
    store.close();store=undefined;
  }finally{unifiedSchemaMigrations.push(latest);}
  store=new UnifiedDataStore(root);
  assert.equal(store.rows('SELECT MAX(version) AS n FROM schema_migrations')[0].n,83);
  assert.equal(store.rows('SELECT checksum FROM schema_migrations WHERE version=82')[0].checksum,checksum82);
  assert.equal(store.rows('SELECT content_cursor FROM content_lifecycle_progress')[0].content_cursor,0);
  assert.deepEqual(store.content(bodyId),bytes);
  store.beginContentPreparationRecovery();
  const worker=new Worker(path.resolve(__dirname,'../out/maintenanceComputeWorker.js'),{workerData:{root,databaseId:store.databaseId}});
  t.after(()=>worker.terminate());await once(worker,'message');let id=0;
  store.setMaintenanceCompute({prepareStorageColdBatch:async limit=>{
    const response=once(worker,'message');worker.postMessage({id:++id,operation:'prepare_storage_cold_batch',limit});
    const [message]=await response;if(message.error)throw new Error(message.error);return message.result;
  }});
  for(let quantum=0;quantum<30;quantum++){
    const result=await store.maintainStorageColdQuantum(8);
    assert.deepEqual(store.content(bodyId),bytes);
    if(!result.pending)break;assert.notEqual(quantum,29,'legacy backfill must converge');
  }
  assert.match(store.rows('SELECT encoding FROM contents WHERE id=?',[bodyId])[0].encoding,/^gzip:repair:legacy:utf8$/);
  const cursor=store.rows('SELECT content_cursor FROM content_lifecycle_progress')[0].content_cursor;
  assert.ok(cursor>0);
  await worker.terminate();store.close();store=undefined;
  store=new UnifiedDataStore(root);
  assert.equal(store.rows('SELECT content_cursor FROM content_lifecycle_progress')[0].content_cursor,cursor,'an applied migration must not restart historical work on every reopen');
  assert.deepEqual(store.content(bodyId),bytes);
});

test('alias cold triggers keep native replay suppression and enqueue a later actual update',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-alias-cold-guard-')),store=new UnifiedDataStore(root);
  t.after(()=>store.close());
  const bytes=Buffer.from(JSON.stringify({raw:'retained bytes '.repeat(100)}));
  store.db.run('UPDATE content_lifecycle_replication_guard SET replaying=1 WHERE id=1');
  const id=store.putContent(bytes,'application/json','repair:source:utf8');
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_cold_pending WHERE content_id=?',[id])[0].n,0);
  store.db.run('UPDATE content_lifecycle_replication_guard SET replaying=0 WHERE id=1');
  store.db.run('UPDATE contents SET data=? WHERE id=?',[bytes,id]);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_cold_pending WHERE content_id=?',[id])[0].n,1);
  assert.deepEqual(store.content(id),bytes);
});
