const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

async function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-automation-content-')),root=path.join(base,'global'),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  const store=new UnifiedDataStore(root),ops=createRuntimeDataOperations(store),project=await store.registerProject({root:projectRoot});
  t.after(async()=>{await ops.close();store.close();});
  return {store,ops,project,append:input=>ops({operation:'append_automation_event',input:{root:projectRoot,...input}})};
}
function guardSourceEncoder(store){
  const original=store.putContent.bind(store);
  store.putContent=(value,...args)=>{if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Writer encoded a large automation event');return original(value,...args);};
  return ()=>{store.putContent=original;};
}

test('the automation event entry preserves its original intent hash, event kind, fixed snapshot and replay result',async t=>{
  const f=await fixture(t),event={action:'reminder',details:'完整自动化历史🌿'.repeat(9000)};
  const legacy=f.store.appendAutomationEvent(f.project.projectId,{event,idempotencyKey:'legacy-automation-event'});
  const restore=guardSourceEncoder(f.store);let replay;
  try{replay=await f.append({event,idempotencyKey:'legacy-automation-event'});}finally{restore();}
  assert.deepEqual(replay,{receipt:legacy.receipt,replayed:true});
  const expectedHash=crypto.createHash('sha256').update(JSON.stringify({event,operation:'append_automation_event',projectId:f.project.projectId})).digest('hex');
  assert.equal(f.store.rows('SELECT input_hash FROM requests WHERE id=?',[legacy.receipt.requestId])[0].input_hash,expectedHash);
  assert.equal(f.store.rows('SELECT kind FROM events WHERE request_id=?',[legacy.receipt.requestId])[0].kind,'evidence.automation');
  const object=f.store.read(legacy.receipt.objectId,1);
  assert.deepEqual(JSON.parse(object.data.content),event);assert.equal(object.data.type,'automation_event');assert.equal(object.data.observed_at,object.createdAt);
});

test('the actual automation event entry publishes complete large structured bytes and reference summaries before its atomic commit',async t=>{
  const f=await fixture(t),target=f.store.putContent('formal shared target');
  for(let i=0;i<2000;i++){const batch=f.store.prepareStorageReferenceBatch(128);f.store.commitStorageReferenceBatch(batch);if(!batch.pending)break;assert.notEqual(i,1999);}
  f.store.beginContentPreparationRecovery();f.store.activateStorageContentLifecycle({strictPublication:true});
  const event={action:'reminder',details:'不可截断的事件原文🌿'.repeat(20000),sourceContents:Object.fromEntries([target,...Array.from({length:300},(_,i)=>`future-automation-${i}`)].map((id,i)=>[i,id]))};
  const restore=guardSourceEncoder(f.store);let result;
  try{result=await f.append({event,idempotencyKey:'large-automation-event'});}finally{restore();}
  assert.equal(result.replayed,false);
  const object=f.store.read(result.receipt.objectId,1);assert.deepEqual(JSON.parse(object.data.content),event);assert.equal(object.data.observed_at,object.createdAt);
  const id=object.data.content_id;
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_edges WHERE source_id=?',[id])[0].n,301);
  assert.equal(f.store.rows('SELECT 1 FROM content_lifecycle_reference_unpublished WHERE content_id=?',[id]).length,0);
  assert.deepEqual(f.store.search({scope:f.project.projectId,query:'不可截断',kinds:['evidence']}).items.map(item=>item.objectId),[object.objectId]);
  assert.equal(f.store.rows('SELECT kind FROM events WHERE request_id=?',[result.receipt.requestId])[0].kind,'evidence.automation');
});

test('overlapping identical automation submissions create one event and report only the second as replayed',async t=>{
  const f=await fixture(t),input={event:{action:'reminder',details:'完整事件🌿'.repeat(20000)},idempotencyKey:'overlapping-automation'};
  const results=await Promise.all([f.append(input),f.append(input)]);
  assert.equal(results[0].replayed,false);assert.equal(results[1].replayed,true);assert.deepEqual(results[0].receipt,results[1].receipt);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM events WHERE request_id=?',[results[0].receipt.requestId])[0].n,1);
  await assert.rejects(f.append({...input,event:{...input.event,details:'changed'}}),/idempotency_conflict/);
});

test('automation records with base64-looking properties remain structured JSON events',async t=>{
  const f=await fixture(t),event={action:'notify',data:'this is ordinary event metadata',encoding:'base64',details:'保留事件对象🌿'.repeat(15000)};
  const restore=guardSourceEncoder(f.store);let result;
  try{result=await f.append({event,idempotencyKey:'json-automation-base64-properties'});}finally{restore();}
  const object=f.store.read(result.receipt.objectId,1);assert.deepEqual(JSON.parse(object.data.content),event);
  assert.equal(f.store.rows('SELECT mime_type FROM contents WHERE id=?',[object.data.content_id])[0].mime_type,'application/json');
});

test('automation preparation owns the original request key and event while its caller reuses the input object',async t=>{
  const f=await fixture(t);
  f.store.appendAutomationEvent(f.project.projectId,{event:{action:'other'},idempotencyKey:'already-existing-automation'});
  const compute=f.store.dataWriteCompute;let entered,release;
  const entering=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});t.after(release);
  f.store.setDataWriteCompute({...compute,prepare:async request=>{const prepared=await compute.prepare(request);entered();await gate;return prepared;}});
  const details='调用时的完整原文🌿'.repeat(20000),input={event:{action:'original',details},idempotencyKey:'owned-automation-request'};
  const pending=f.store.publishAutomationEvent(f.project.projectId,input);void pending.catch(()=>{});
  try{
    await entering;input.idempotencyKey='already-existing-automation';input.event.details='caller changed the mutable object';release();
    const result=await pending;assert.equal(result.replayed,false);
    assert.deepEqual(JSON.parse(f.store.read(result.receipt.objectId,1).data.content),{action:'original',details});
    assert.equal(f.store.rows('SELECT idempotency_key FROM requests WHERE id=?',[result.receipt.requestId])[0].idempotency_key,'owned-automation-request');
  }finally{release();await Promise.allSettled([pending]);}
});
