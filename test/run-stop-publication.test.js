const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');
const crypto=require('node:crypto'),{RunStop}=require('../out/runStop.js');

test('the actual stop entry closes its run while preserving complete large metadata outside Source',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-stop-publication-')),root=path.join(base,'project');fs.mkdirSync(root);const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  const metadata='完整停止时运行背景🌿'.repeat(12000),run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'完整用户目标',command:'not executed',userMessage:'完整用户目标',metadata:{stopPublicationFixture:metadata},idempotencyKey:'stop-publication-prepare'}}),read=store.content,put=store.putContent;
  store.content=function(id){if(Number(this.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded large stop metadata');return read.call(this,id);};
  store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded large stop metadata');return put.call(this,value,...args);};
  let stopped;try{stopped=await operations({operation:'stop_run',input:{projectId:run.projectId,executionLogId:1,generation:run.generation,expectedRevision:run.revision,expectedTurnId:run.turnId,reason:'用户明确要求停止',idempotencyKey:'actual-stop-publication'}});}finally{store.content=read;store.putContent=put;}
  assert.equal(stopped.status.stopRequested,true);assert.equal(stopped.status.checkpointSummary,'用户明确要求停止');assert.equal(stopped.status.stopPublicationFixture,metadata);assert.ok(stopped.status.finishedAt);assert.equal(store.read(run.turnId).data.finished_at!==null,true);
});

test('a bounded stop is accepted during shutdown without starting Compute',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-small-stop-publication-')),root=path.join(base,'project');fs.mkdirSync(root);
  const {ContentComputeDataStore}=require('./content-compute-fixture.cjs'),store=new ContentComputeDataStore(path.join(base,'data')),service=new RunStop(store);t.after(async()=>{await service.close();store.close();});
  const project=await store.registerProject({root}),run=await store.prepareRun(project.projectId,project.locationId,{root,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'目标',command:'not executed',userMessage:'目标',idempotencyKey:'small-stop-run'});
  store.setRunContextCompute({context:()=>{throw Error('bounded stop unexpectedly started context Compute');}});store.setRunControlCompute(()=>{throw Error('bounded stop unexpectedly started control Compute');});
  const stopping=service.stop(run.projectId,{executionLogId:1,generation:run.generation,expectedRevision:run.revision,expectedTurnId:run.turnId,reason:'用户停止',idempotencyKey:'small-stop'}).then(value=>({value}),error=>({error}));
  await service.close();assert.match((await stopping).error.message,/run_stop_interrupted/);assert.equal(store.readRunState(run.projectId,1).status.stopRequested,true);
});

async function controlFixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-stop-control-publication-')),root=path.join(base,'project');fs.mkdirSync(root);const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  const retained='停止必须保留的原始上下文🌿'.repeat(12000),run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'完整目标',command:'not executed',userMessage:'完整目标',metadata:{retained},idempotencyKey:'stop-control-prepare'}});
  return {store,run,retained,input:{executionLogId:1,generation:run.generation,expectedRevision:run.revision,expectedTurnId:run.turnId,reason:'停止该任务',idempotencyKey:'stop-control',nativeStopStream:'native:codex',nativeStopLogBoundary:Number.MAX_SAFE_INTEGER}};
}

test('stop control preserves its normalized original hash, fixed history and write-free replay',async t=>{
  const {store,run,retained,input}=await controlFixture(t),first=await store.publishRunControl(run.projectId,{type:'stop',input});
  const later=await store.publishRunControl(run.projectId,{type:'state',input:{executionLogId:1,generation:run.generation,expectedRevision:first.revision,patch:{subsequent:'后来写入'},idempotencyKey:'after-stop-control'}}),wal=()=>{const bytes=fs.readFileSync(store.filePath+'-wal');return{bytes:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};},before=wal();
  assert.deepEqual(await store.publishRunControl(run.projectId,{type:'stop',input:{...input,expectedRevision:999}}),first);assert.deepEqual(wal(),before);assert.equal(first.status.retained,retained);assert.equal(first.status.stopNativeStream,undefined);assert.equal(first.status.stopRequestIntent.nativeStopLogBoundary,undefined);assert.equal(store.readRunState(run.projectId,1).revision,later.revision);
  const normalized={executionLogId:1,generation:run.generation,expectedTurnId:run.turnId,reason:input.reason,idempotencyKey:input.idempotencyKey},intent={operation:'request_run_stop',projectId:run.projectId,input:normalized},hash=crypto.createHash('sha256').update(require('../out/contentReferences.js').canonicalJson(intent)).digest('hex');assert.equal(store.rows('SELECT input_hash FROM requests WHERE idempotency_key=?',[input.idempotencyKey])[0].input_hash,hash);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

test('a final stop event failure rolls back metadata, history, request and delivery changes',async t=>{
  const {store,run,input}=await controlFixture(t),state=store.readRunCheckpointState(run.projectId,1),tables=['events','requests','run_control_revisions'],counts=()=>Object.fromEntries(tables.map(table=>[table,store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n])),before=counts();
  store.db.exec("CREATE TEMP TRIGGER fail_stop_control BEFORE INSERT ON events WHEN NEW.kind='run.stop' BEGIN SELECT RAISE(ABORT,'actual_last_stop_event_failure'); END");
  await assert.rejects(store.publishRunControl(run.projectId,{type:'stop',input}),/actual_last_stop_event_failure/);assert.deepEqual(store.readRunCheckpointState(run.projectId,1),state);assert.deepEqual(counts(),before);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
  store.db.exec('DROP TRIGGER fail_stop_control');assert.equal((await store.publishRunControl(run.projectId,{type:'stop',input})).status.stopRequested,true);
});

test('direct requestRunStop preserves full metadata through the original stop control contract',async t=>{
  const {store,run,retained,input}=await controlFixture(t),content=store.content,put=store.putContent;let first;
  store.content=function(id){if(Number(this.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded large direct stop metadata');return content.call(this,id);};
  store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded large direct stop metadata');return put.call(this,value,...args);};
  try{first=await store.requestRunStop(run.projectId,input);}finally{store.content=content;store.putContent=put;}
  assert.equal(first.status.stopRequested,true);assert.equal(first.status.retained,retained);assert.equal(first.status.stopNativeStream,undefined);assert.equal(first.status.stopRequestIntent.nativeStopLogBoundary,undefined);
  const before=wal();assert.deepEqual(await store.requestRunStop(run.projectId,{...input,expectedRevision:999}),first);assert.deepEqual(wal(),before);
  function wal(){const bytes=fs.readFileSync(store.filePath+'-wal');return{length:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};}
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('a direct small stop commits before yielding without entering shared Compute',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-direct-small-stop-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  const run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'保留当前目标',command:'not executed',userMessage:'原用户目标',idempotencyKey:'direct-small-stop-run'}}),prepare=store.runControlCompute;let calls=0;
  store.setRunControlCompute(request=>{calls++;return prepare(request);});
  const pending=store.requestRunStop(run.projectId,{executionLogId:1,generation:run.generation,expectedRevision:run.revision,expectedTurnId:run.turnId,reason:'用户停止',idempotencyKey:'direct-small-stop'}),immediate=store.readRunCheckpointState(run.projectId,1).status.stopRequested;
  const result=await pending;assert.equal(immediate,true);assert.equal(calls,0);assert.equal(result.status.stopRequested,true);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});
