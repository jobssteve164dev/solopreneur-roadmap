const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs'),{growthRefreshNative,writeStateNative}=require('./fixtures/native-daily-state-oracles.cjs');
async function fixture(t,native=false){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-growth-publication-')),root=path.join(base,'project');fs.mkdirSync(root);const store=new UnifiedDataStore(path.join(base,'data')),ops=createRuntimeDataOperations(store);t.after(async()=>{await ops.close();store.close();});const project=(await store.registerProject({root})).projectId;
  const reserve=requestId=>native?growthRefreshNative(store,'reserve',project,requestId):store.reserveProjectGrowthRefresh(project,requestId),state=()=>store.readAnalysisState(project,'growth-refresh','current'),key=requestId=>`analysis-state:${project}:growth-refresh:current:reserve:${requestId}`;
  return{store,project,reserve,state,key};
}
for(const native of [true,false])test(`${native?'Native':'public'} growth reserve replays the actual original generation after newer reservations`,async t=>{
  const f=await fixture(t,native),first=await f.reserve('first');assert.deepEqual(first,{requestId:'first',generation:1});assert.deepEqual(await f.reserve('first'),first);const newer=await f.reserve('newer'),events=f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n,requests=f.store.rows('SELECT COUNT(*) AS n FROM requests')[0].n,wal=`${f.store.filePath}-wal`,walBytes=fs.existsSync(wal)?fs.statSync(wal).size:0;
  assert.deepEqual(await f.reserve('first'),first);assert.equal(newer.generation,2);assert.equal(f.state().revision,2);assert.deepEqual(f.state().value,{requestId:'newer'});assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n,events);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM requests')[0].n,requests);assert.equal(fs.existsSync(wal)?fs.statSync(wal).size:0,walBytes);
});
for(const native of [true,false])test(`${native?'Native':'public'} growth pending receipt fails before reading a corrupt current reservation`,async t=>{
  const f=await fixture(t,native);await f.reserve('first');await f.reserve('newer');const current=f.state(),cid=f.store.rows('SELECT content_id FROM settings WHERE id=?',[current.objectId])[0].content_id;
  f.store.db.run("UPDATE requests SET status='pending' WHERE actor_id=? AND idempotency_key=?",[f.store.actorId,f.key('first')]);f.store.db.run('UPDATE contents SET data=zeroblob(length(data)) WHERE id=?',[cid]);await assert.rejects(async()=>f.reserve('first'),/growth_refresh_reservation_pending/);
});
for(const native of [true,false])test(`${native?'Native':'public'} growth fixed receipt ignores newer current body corruption`,async t=>{
  const f=await fixture(t,native),first=await f.reserve('first');await f.reserve('newer');const current=f.state(),cid=f.store.rows('SELECT content_id FROM settings WHERE id=?',[current.objectId])[0].content_id;f.store.db.run('UPDATE contents SET data=zeroblob(length(data)) WHERE id=?',[cid]);
  assert.deepEqual(await f.reserve('first'),first);await assert.rejects(async()=>f.reserve('fresh'),/content_integrity_error/);
});
for(const native of [true,false])test(`${native?'Native':'public'} growth fixed receipt validates the actual retained request identity`,async t=>{
  const f=await fixture(t,native);await f.reserve('first');writeStateNative(f.store,'analysis',f.project,{namespace:'growth-refresh',key:'current',expectedRevision:1,value:{requestId:'different'},idempotencyKey:'actual-other-receipt'});
  const saved=f.store.rows('SELECT result_content_id,result_inline_json FROM requests WHERE actor_id=? AND idempotency_key=?',[f.store.actorId,`analysis-state:${f.project}:growth-refresh:current:actual-other-receipt`])[0];assert.ok(saved.result_content_id);f.store.db.run('UPDATE requests SET result_content_id=?,result_inline_json=? WHERE actor_id=? AND idempotency_key=?',[saved.result_content_id,saved.result_inline_json,f.store.actorId,f.key('first')]);
  await assert.rejects(async()=>f.reserve('first'),/idempotency_conflict/);
});

for(const branch of ['fresh','fixed-replay'])test(`public growth ${branch} reads complete retained state outside Source`,async t=>{
  const f=await fixture(t),body={requestId:branch==='fresh'?'legacy':'first',payload:'完整保留增长预留🌿'.repeat(16000)};if(branch==='fixed-replay')await f.reserve('first');
  const written=writeStateNative(f.store,'analysis',f.project,{namespace:'growth-refresh',key:'current',expectedRevision:branch==='fresh'?0:1,value:body,idempotencyKey:'actual-large-state'});
  if(branch==='fixed-replay'){
    const saved=f.store.rows('SELECT result_content_id,result_inline_json FROM requests WHERE actor_id=? AND idempotency_key=?',[f.store.actorId,`analysis-state:${f.project}:growth-refresh:current:actual-large-state`])[0];f.store.db.run('UPDATE requests SET result_content_id=?,result_inline_json=? WHERE actor_id=? AND idempotency_key=?',[saved.result_content_id,saved.result_inline_json,f.store.actorId,f.key('first')]);await f.reserve('newer');
  }
  const read=f.store.content,put=f.store.putContent;f.store.content=function(id){if(Number(this.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded full growth reservation');return read.call(this,id);};f.store.putContent=function(bytes,...args){if((typeof bytes==='string'?Buffer.byteLength(bytes):bytes.byteLength)>65536)throw Error('Source encoded full growth reservation');return put.call(this,bytes,...args);};let result;
  try{result=await f.reserve(branch==='fresh'?'fresh':'first');}finally{f.store.content=read;f.store.putContent=put;}
  assert.deepEqual(result,{requestId:branch==='fresh'?'fresh':'first',generation:2});assert.equal(f.store.read(written.objectId,written.revision).data.content,JSON.stringify(body));assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('growth reserve observes a real same-request reservation created during Reader preparation',async t=>{
  const f=await fixture(t),prepare=f.store.stateWriteCompute;let calls=0,interposed=false;
  f.store.setStateWriteCompute(async request=>{calls++;const selected=await prepare(request);if(!interposed){interposed=true;growthRefreshNative(f.store,'reserve',f.project,'same-request');}return selected;});
  const result=await f.reserve('same-request');assert.deepEqual(result,{requestId:'same-request',generation:1});assert.equal(calls,2);assert.equal(f.state().revision,1);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM requests WHERE idempotency_key=?',[f.key('same-request')])[0].n,1);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});
test('growth reserve reselects the genuine current intent after a different Native reservation',async t=>{
  const f=await fixture(t),first=await f.reserve('first'),original=f.state(),prepare=f.store.stateWriteCompute;let changed=false,calls=0;
  f.store.setStateWriteCompute(async request=>{calls++;const selected=await prepare(request);if(!changed){changed=true;growthRefreshNative(f.store,'reserve',f.project,'interposed');}return selected;});
  const written=await f.reserve('final');assert.equal(calls,2);assert.equal(first.generation,1);assert.equal(written.generation,3);assert.equal(f.store.read(original.objectId,1).data.content,'{"requestId":"first"}');assert.equal(f.store.read(original.objectId,2).data.content,'{"requestId":"interposed"}');assert.deepEqual(await f.reserve('interposed'),{requestId:'interposed',generation:2});
});
for(const native of [true,false])test(`${native?'Native':'public'} growth first actual Native write failure is visible without automatic graph retry`,async t=>{
  const f=await fixture(t,native),run=f.store.db.run;let attempts=0;
  f.store.db.run=function(sql,values){const result=run.call(this,sql,values);if(sql.startsWith('INSERT INTO requests(') && values?.[1]===f.key('failure')){attempts++;throw Error('data_write_replay_changed');}return result;};
  try{await assert.rejects(async()=>f.reserve('failure'),/data_write_replay_changed/);}finally{f.store.db.run=run;}
  assert.equal(attempts,1);assert.equal(f.state().objectId,null);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM requests WHERE idempotency_key=?',[f.key('failure')])[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);assert.equal((await f.reserve('failure')).generation,1);
});
test('growth reservation fixed replay and fresh publication both obey the final commit callback',async t=>{
  const f=await fixture(t);let commits=0;
  const commit=()=>{commits++;throw Error('actual_final_growth_fence');};await assert.rejects(f.store.reserveProjectGrowthRefresh(f.project,'fresh-fenced',commit),/actual_final_growth_fence/);assert.equal(f.state().objectId,null);
  const first=await f.reserve('retained');await assert.rejects(f.store.reserveProjectGrowthRefresh(f.project,'retained',commit),/actual_final_growth_fence/);assert.equal(commits,2);assert.equal(f.state().revision,first.generation);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});
