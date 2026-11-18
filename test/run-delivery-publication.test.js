const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

for(const mode of ['runtime','direct'])for(const operation of ['claim_run_delivery','release_run_delivery'])test(`${mode}: actual ${operation} preserves complete recovery metadata outside Source`,async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-run-delivery-publication-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store),project=await store.registerProject({root});t.after(async()=>{await operations.close();store.close();});
  const retained='完整运行恢复元数据'.repeat(12000),owner={id:'current-window',pid:process.pid,birth:''},dead={id:'old-window',pid:99999999,birth:'dead'},run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'original prompt',command:'original command',userMessage:'original goal',metadata:{retained},deliveryOwner:dead,idempotencyKey:'delivery-original-run'}});
  let current=run;if(operation==='release_run_delivery')current=await store.claimRunDelivery(project.projectId,{executionLogId:1,generation:1,expectedRevision:1,owner,idempotencyKey:'delivery-original-claim'});
  const input={projectId:project.projectId,executionLogId:1,generation:1,...(operation==='claim_run_delivery'?{expectedRevision:current.revision}:{}),owner,...(operation==='release_run_delivery'?{error:'完整准备失败原因'.repeat(9000)}:{}),idempotencyKey:`prepared-${operation}`};
  const put=store.putContent,read=store.content,createHash=crypto.createHash;
  store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded a large delivery body');return put.call(this,value,...args);};
  store.content=function(id){if(Number(store.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded a large delivery body');return read.call(this,id);};
  crypto.createHash=(...args)=>{const hash=createHash(...args),update=hash.update;hash.update=function(value,...options){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source hashed a large delivery body');return update.call(this,value,...options);};return hash;};
  const call=()=>mode==='direct'?store[{"claim_run_delivery":"claimRunDelivery","release_run_delivery":"releaseRunDelivery"}[operation]](project.projectId,input):operations({operation,input});
  let first,replay;try{first=await call();replay=await call();}finally{store.putContent=put;store.content=read;crypto.createHash=createHash;}
  assert.deepEqual(replay,first);assert.equal(first.status.retained,retained);assert.equal(first.status.deliveryPending,true);assert.equal(first.status.deliveryOwnerId,operation==='claim_run_delivery'?owner.id:'');
  if(operation==='release_run_delivery')assert.equal(first.status.deliveryLastError,input.error);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});
