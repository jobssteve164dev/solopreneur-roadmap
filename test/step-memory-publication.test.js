const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');
const {runInputsSerializedResult}=require('../out/db/runInputsPublication.js');

async function fixture(t,mode){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-step-memory-publication-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store),project=await store.registerProject({root});
  t.after(async()=>{await operations.close();store.close();});
  for(;;){const batch=store.prepareStorageReferenceBatch(128);store.commitStorageReferenceBatch(batch);if(!batch.pending)break;}
  store.beginContentPreparationRecovery();store.activateStorageContentLifecycle({strictPublication:true});
  const call=input=>mode==='direct'?store.writeStepMemory(project.projectId,input):operations({operation:'write_step_memory',input:{root,...input}});
  return{store,operations,root,project,call};
}
function wal(store){const bytes=fs.readFileSync(store.filePath+'-wal');return{length:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};}
function forbidLargeSourceWork(store){
  const read=store.content,put=store.putContent,createHash=crypto.createHash;
  store.content=function(id){if(Number(this.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded large step memory');return read.call(this,id);};
  store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded large step memory');return put.call(this,value,...args);};
  crypto.createHash=(...args)=>{const hash=createHash(...args),update=hash.update;hash.update=function(value,...options){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source hashed large step memory');return update.call(this,value,...options);};return hash;};
  return()=>{store.content=read;store.putContent=put;crypto.createHash=createHash;};
}
for(const mode of ['runtime','direct'])test(mode+': formal step memory preserves full metadata and fixed receipts outside Source',async t=>{
  const f=await fixture(t,mode),retained='完整用户完成标准与原始资料🌿'.repeat(15000),initial={nodeId:'step',expectedRevision:0,patch:{retained,criteria:['原标准']},origin:'default',idempotencyKey:'step-initial'};
  const restore=forbidLargeSourceWork(f.store);let first,second;
  try{first=await f.call(initial);second=await f.call({nodeId:'step',expectedRevision:1,patch:{criteria:['用户完整新标准']},idempotencyKey:'step-update'});}finally{restore();}
  assert.equal(first.data.retained,retained);assert.deepEqual(first.data.criteria,['原标准']);assert.equal(second.data.retained,retained);assert.deepEqual(second.data.criteria,['用户完整新标准']);
  assert.deepEqual(JSON.parse(runInputsSerializedResult(second)),second);
  assert.deepEqual(f.store.rows('SELECT field,origin FROM step_memory_field_origins WHERE project_id=? ORDER BY field',[f.project.projectId]).map(row=>({...row})),[{field:'criteria',origin:'user'},{field:'retained',origin:'default'}]);
  const before=wal(f.store);assert.deepEqual(await f.call({...initial,expectedRevision:999}),first);assert.deepEqual(wal(f.store),before);
  assert.deepEqual(f.store.readStepMemory(f.project.projectId,'step',{revision:1,includeEntries:false}).data,first.data);
  await assert.rejects(Promise.resolve().then(()=>f.call({...initial,patch:{retained:'different'}})),/idempotency_conflict/);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('step memory replays actual Native receipts and unchanged metadata adds only reference history',async t=>{
  const f=await fixture(t,'direct'),input={nodeId:'step',expectedRevision:0,patch:{retained:'原始完整资料🌿'.repeat(15000)},idempotencyKey:'native-step-memory'},first=require('./fixtures/native-step-memory-oracles.cjs').writeStepMemoryNative(f.store,f.project.projectId,input),before=wal(f.store);
  assert.deepEqual(await f.call(input),first);assert.deepEqual(wal(f.store),before);
  const initial=f.store.rows('SELECT * FROM project_step_memory_revisions WHERE project_id=?',[f.project.projectId])[0];
  for(let index=0;index<3;index++){
    const restore=forbidLargeSourceWork(f.store);let result;
    try{result=await f.call({...input,expectedRevision:index+1,idempotencyKey:`same-metadata-${index}`});}finally{restore();}
    assert.deepEqual(result.data,first.data);
    const row=f.store.rows('SELECT * FROM project_step_memory_revisions WHERE project_id=? AND revision=?',[f.project.projectId,index+2])[0],body=JSON.parse(f.store.read(row.object_id,1).data.content);
    assert.equal(row.content_id,initial.content_id);assert.equal(row.metadata_object_id,initial.metadata_object_id);assert.deepEqual(body.dataRef,{objectId:initial.metadata_object_id,revision:1});assert.equal(body.data,undefined);
  }
  assert.equal(f.store.readStepMemoryState(f.project.projectId).revision,1);
  const needle=Buffer.from(input.patch.retained),copies=f.store.rows('SELECT id FROM contents').filter(row=>f.store.content(row.id).includes(needle)).length;
  assert.equal(copies,2,'same metadata is retained once as metadata and once in its original evidence body');
});

test('step memory final event failure rolls the complete graph back and permits the same request retry',async t=>{
  const f=await fixture(t),tables=['objects','object_revisions','evidence','events','requests','relations','project_step_memory','project_step_memory_revisions','project_step_memory_state','step_memory_field_origins'],counts=()=>Object.fromEntries(tables.map(table=>[table,f.store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n])),before=counts(),input={nodeId:'step',expectedRevision:0,patch:{completionCriteria:['正式完整标准'],retained:'完整内容🌿'.repeat(15000)},origin:'default',idempotencyKey:'step-atomic-failure'};
  f.store.db.run("CREATE TEMP TRIGGER reject_step_event BEFORE INSERT ON events WHEN NEW.kind='evidence.step_memory' BEGIN SELECT RAISE(ABORT,'fixture_step_event_failure'); END");
  await assert.rejects(f.call(input),/fixture_step_event_failure/);assert.deepEqual(counts(),before);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
  f.store.db.run('DROP TRIGGER reject_step_event');const result=await f.call(input);assert.equal(result.revision,1);assert.deepEqual(result.data,input.patch);
});

function pausePreparation(t,store){
  const compute=store.stepMemoryCompute,original=compute.prepareStepMemory;let enter,release,once=false;
  const entering=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});t.after(release);
  compute.prepareStepMemory=async request=>{const value=await original(request);if(!once){once=true;enter();await gate;}return value;};return{entering,release};
}

test('step memory preparation releases Source and reselects actual late imported sources',async t=>{
  const f=await fixture(t),sourceBytes='{"entries":[]}',sourceHash=crypto.createHash('sha256').update(sourceBytes).digest('hex'),gate=pausePreparation(t,f.store),input={nodeId:'step',expectedRevision:0,patch:{criteria:['用户原标准']},idempotencyKey:'step-late-source'},pending=f.call(input);void pending.catch(()=>{});await gate.entering;
  let source;
  try{
    assert.equal(f.store.db.inTransaction,false);
    source=await f.operations({operation:'write',input:{kind:'evidence',action:'create',scope:f.project.projectId,idempotencyKey:'late-step-source',data:{type:'step_memory_source',source_actor_id:f.store.actorId,content:sourceBytes,observed_at:Date.now()}}});
    f.store.db.run('INSERT INTO step_memory_sources VALUES(?,?,?,?,?,?,?)',[f.project.projectId,'step','late-real-source',source.objectId,sourceHash,0,'json']);
  }finally{gate.release();}
  const result=await pending,body=JSON.parse(f.store.read(result.objectId,1).data.content);assert.deepEqual(body.sources,[{key:'late-real-source',objectId:source.objectId,revision:1,sha256:sourceHash,entryCount:0,format:'json'}]);
  assert.ok(f.store.readMetadata(result.objectId).relations.some(value=>value.relation==='source' && value.target===source.objectId));assert.deepEqual(result.data,input.patch);
});

test('step memory readonly replay retries a real content rewrite without extra persistent preparation',async t=>{
  const f=await fixture(t),input={nodeId:'step',expectedRevision:0,patch:{retained:'保留完整历史🌿'.repeat(15000)},idempotencyKey:'step-replay-proof'},first=await f.call(input),verify=f.store.contentVerificationCompute;let changed=false,before;
  f.store.contentVerificationCompute=async request=>{const result=await verify(request);if(!changed){changed=true;f.store.db.run('UPDATE contents SET data=data WHERE id=?',[request.contentId]);assert.equal(f.store.rows('SELECT changes() AS n')[0].n,1);before=wal(f.store);}return result;};
  try{assert.deepEqual(await f.call(input),first);}finally{f.store.contentVerificationCompute=verify;}
  assert.equal(changed,true);assert.deepEqual(wal(f.store),before);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('step memory takes the actual late global handoff boundary without losing its fixed prefix',async t=>{
  const f=await fixture(t),run=await f.operations({operation:'prepare_run',input:{root:f.root,executionLogId:1,nodeId:'step',runKind:'step',prompt:'原始目标',userMessage:'保留交接边界',command:'not executed',idempotencyKey:'step-boundary-run'}}),gate=pausePreparation(t,f.store),pending=f.call({nodeId:'step',expectedRevision:0,patch:{criteria:['保留完整边界']},idempotencyKey:'step-late-handoff'});void pending.catch(()=>{});await gate.entering;let sequence;
  try{sequence=f.store.insertStepHandoff(f.project.projectId,'step',run.runId,run.turnId,1,f.store.putStructuredContent({summary:'实际迟到交接'}));}finally{gate.release();}
  const result=await pending,body=JSON.parse(f.store.read(result.objectId,1).data.content),memory=f.store.readStepMemory(f.project.projectId,'step',{revision:result.revision});
  assert.equal(body.handoffCursor,sequence);assert.equal(memory.data.entries.length,1);assert.equal(memory.data.entries[0].summary,'实际迟到交接');
});

test('step memory same-node patches retain the original revision conflict and retry contract',async t=>{
  const f=await fixture(t),base={nodeId:'step',expectedRevision:0},results=await Promise.allSettled([f.call({...base,patch:{first:'用户原值'},idempotencyKey:'concurrent-step-first'}),f.call({...base,patch:{second:'用户后值'},idempotencyKey:'concurrent-step-second'})]);
  assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.match(results[1].reason.message,/revision_conflict/);
  const retry=await f.call({...base,expectedRevision:1,patch:{second:'用户后值'},idempotencyKey:'concurrent-step-second'});assert.deepEqual(retry.data,{first:'用户原值',second:'用户后值'});assert.equal(retry.revision,2);
});

test('step memory first result stays at its actual accepted revision when later metadata is committed before projection',async t=>{
  const f=await fixture(t,'direct'),compute=f.store.stepMemoryCompute,project=compute.projectStepMemoryResult;let later;
  compute.projectStepMemoryResult=async request=>{
    if(!later)later=require('./fixtures/native-step-memory-oracles.cjs').writeStepMemoryNative(f.store,f.project.projectId,{nodeId:'step',expectedRevision:1,patch:{value:'之后的用户修改'},idempotencyKey:'later-step-memory'});
    return project(request);
  };
  const input={nodeId:'step',expectedRevision:0,patch:{value:'本次实际提交值'},idempotencyKey:'first-fixed-step-memory'},first=await f.call(input);
  assert.equal(first.revision,1);assert.deepEqual(first.data,input.patch);assert.equal(later.revision,2);assert.equal(f.store.readStepMemory(f.project.projectId,'step').data.value,'之后的用户修改');assert.deepEqual(await f.call(input),first);
});

test('step memory final publication refusal leaves no business graph or persistent preparation',async t=>{
  const f=await fixture(t,'direct'),before=f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n;
  await assert.rejects(f.store.publishStepMemory(f.project.projectId,{nodeId:'step',expectedRevision:0,patch:{value:'保留完整意图'},idempotencyKey:'step-final-permission'},()=>{throw Error('fixture_final_permission_changed');}),/fixture_final_permission_changed/);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n,before);assert.equal(f.store.readStepMemory(f.project.projectId,'step'),null);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('step memory replay requalifies a real evidence body mapping replaced before the first watch',async t=>{
  const f=await fixture(t,'direct'),native=require('./fixtures/native-step-memory-oracles.cjs').writeStepMemoryNative,input={nodeId:'step',expectedRevision:0,patch:{value:'本次真实原始资料'},idempotencyKey:'step-mapping-first'},first=native(f.store,f.project.projectId,input),second=native(f.store,f.project.projectId,{nodeId:'step',expectedRevision:1,patch:{value:'后续真实完整资料'},idempotencyKey:'step-mapping-second'}),contentId=f.store.rows('SELECT content_id FROM evidence WHERE id=?',[second.objectId])[0].content_id,compute=f.store.stepMemoryCompute,prepare=compute.prepareStepMemory;let changed=false,before;
  compute.prepareStepMemory=async request=>{
    const result=await prepare(request);
    if(result.replay && !changed){changed=true;f.store.db.run('UPDATE evidence SET content_id=? WHERE id=?',[contentId,first.objectId]);assert.equal(f.store.rows('SELECT changes() AS n')[0].n,1);before=wal(f.store);}
    return result;
  };
  try{
    const result=await f.call(input),expected=native(f.store,f.project.projectId,input);assert.equal(changed,true);assert.equal(expected.revision,2);assert.deepEqual(result,expected);assert.deepEqual(wal(f.store),before);
    assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
  }finally{compute.prepareStepMemory=prepare;}
});
