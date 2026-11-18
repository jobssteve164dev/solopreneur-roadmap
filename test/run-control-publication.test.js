const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

for(const mode of ['runtime','direct'])for(const operation of ['patch_run_state','write_run_binding'])test(`${mode}: actual ${operation} preserves large retained metadata and prompt outside Source`,async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-run-control-publication-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store),project=await store.registerProject({root});t.after(async()=>{await operations.close();store.close();});
  const preserved='完整原始运行元数据'.repeat(10000),prompt='完整保留运行正文'.repeat(10000),run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt,command:'original command',userMessage:'user goal',metadata:{preserved},idempotencyKey:'control-original-run'}});
  for(;;){const batch=store.prepareStorageReferenceBatch(128);store.commitStorageReferenceBatch(batch);if(!batch.pending)break;}store.beginContentPreparationRecovery();store.activateStorageContentLifecycle({strictPublication:true});
  const input=operation==='patch_run_state'?{projectId:project.projectId,executionLogId:1,generation:1,expectedRevision:1,patch:{sessionBindingHeadRevision:0,annotation:'完整本次状态'.repeat(9000)},idempotencyKey:'control-state'}:{projectId:project.projectId,executionLogId:1,generation:1,expectedHeadRevision:0,seed:{runId:'1',provider:'claude',workspaceRoot:root,cliPath:'claude',bindingNonce:'original-nonce',createdAt:run.status.startedAt,method:'caller_assigned',contract:'official_stable',providerContext:{complete:'完整身份上下文'.repeat(9000)}},idempotencyKey:'control-binding'};
  const put=store.putContent,read=store.content,createHash=crypto.createHash;
  store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded a large run control body');return put.call(this,value,...args);};
  store.content=function(id){if(Number(store.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded a large run control body');return read.call(this,id);};
  crypto.createHash=(...args)=>{const hash=createHash(...args),update=hash.update;hash.update=function(value,...options){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source hashed a large run control body');return update.call(this,value,...options);};return hash;};
  const call=()=>mode==='direct'?store[{"patch_run_state":"patchRunState","write_run_binding":"writeRunBinding"}[operation]](project.projectId,input):operations({operation,input});
  let first,replay;try{first=await call();replay=await call();}finally{store.putContent=put;store.content=read;crypto.createHash=createHash;}
  assert.deepEqual(replay,first);const state=store.readRunState(project.projectId,1);assert.equal(state.status.preserved,preserved);assert.equal(store.read(run.runId).data.prompt_content,prompt);
  if(operation==='patch_run_state')assert.equal(state.status.annotation,input.patch.annotation);else{assert.equal(first.provider,'claude');assert.deepEqual(first.revisions[0].providerContext,input.seed.providerContext);assert.equal(state.status.sessionBindingHeadRevision,1);}
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

for(const large of [false,true])for(const operation of ['patch_run_state','write_run_binding'])test(`${operation} ${large?'prepared':'bounded synchronous'} recovery does not consume an unrelated damaged prompt`,async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-run-control-scope-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store),project=await store.registerProject({root});t.after(async()=>{await operations.close();store.close();});
  const run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'unrelated retained prompt',command:'original command',userMessage:'original goal',metadata:large?{retained:'完整必要metadata'.repeat(9000)}:{},idempotencyKey:'scope-original-run'}});
  for(;;){const batch=store.prepareStorageReferenceBatch(128);store.commitStorageReferenceBatch(batch);if(!batch.pending)break;}store.beginContentPreparationRecovery();store.activateStorageContentLifecycle({strictPublication:true});
  const promptId=store.rows('SELECT prompt_content_id FROM runs WHERE id=?',[run.runId])[0].prompt_content_id;store.db.run('UPDATE contents SET data=zeroblob(stored_byte_length) WHERE id=?',[promptId]);
  const prepare=store.runControlCompute;let prepared=0;store.runControlCompute=request=>{prepared++;return prepare(request);};
  const input=operation==='patch_run_state'?{projectId:project.projectId,executionLogId:1,generation:1,expectedRevision:1,patch:{status:'Failed',failureReason:'原任务需要恢复'},idempotencyKey:'scope-recovery-state'}:{projectId:project.projectId,executionLogId:1,generation:1,expectedHeadRevision:0,seed:{runId:'1',provider:'claude',workspaceRoot:root,cliPath:'claude',bindingNonce:'scope-original-nonce',createdAt:run.status.startedAt,method:'caller_assigned',contract:'official_stable'},idempotencyKey:'scope-recovery-binding'};
  const result=await operations({operation,input});
  if(operation==='patch_run_state')assert.equal(result.status.status,'Failed');else assert.equal(result.provider,'claude');
  assert.equal(prepared>0,large);assert.equal(store.rows('SELECT prompt_content_id FROM runs WHERE id=?',[run.runId])[0].prompt_content_id,promptId);
});

test('a final prepared binding failure rolls its evidence, binding index and control history back together',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-run-binding-atomic-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store),project=await store.registerProject({root});t.after(async()=>{await operations.close();store.close();});
  const retained='完整运行metadata'.repeat(9000),run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'original prompt',command:'original command',userMessage:'original goal',metadata:{retained},idempotencyKey:'atomic-binding-original'}});
  const tables=['objects','object_revisions','events','requests','session_bindings','run_control_revisions'],counts=()=>Object.fromEntries(tables.map(table=>[table,store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n])),before=counts();
  store.db.run("CREATE TEMP TRIGGER reject_final_binding BEFORE INSERT ON events WHEN NEW.kind='run.binding' BEGIN SELECT RAISE(ABORT,'fixture_final_binding_failure'); END");
  const input={projectId:project.projectId,executionLogId:1,generation:1,expectedHeadRevision:0,seed:{runId:'1',provider:'claude',workspaceRoot:root,cliPath:'claude',bindingNonce:'original-nonce',createdAt:run.status.startedAt,method:'caller_assigned',contract:'official_stable'},idempotencyKey:'atomic-binding'};
  await assert.rejects(operations({operation:'write_run_binding',input}),/fixture_final_binding_failure/);
  assert.deepEqual(counts(),before);assert.equal(store.readRunBinding(project.projectId,1),null);assert.equal(store.readRunState(project.projectId,1).status.retained,retained);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
  store.db.run('DROP TRIGGER reject_final_binding');assert.equal((await operations({operation:'write_run_binding',input})).provider,'claude');
});

test('an unchanged binding confirmation replay leaves the physical WAL unchanged',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-run-binding-replay-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store),project=await store.registerProject({root});t.after(async()=>{await operations.close();store.close();});
  const run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'original prompt',command:'original command',userMessage:'original goal',idempotencyKey:'replay-binding-original'}}),scope={root,executionLogId:1,generation:run.generation};
  await operations({operation:'write_run_binding',input:{...scope,expectedHeadRevision:0,seed:{runId:'1',provider:'codex',workspaceRoot:root,cliPath:'codex',bindingNonce:'original-nonce',createdAt:run.status.startedAt,method:'provider_callback',contract:'official_stable'},idempotencyKey:'replay-binding-seed'}});
  await operations({operation:'write_run_binding',input:{...scope,expectedHeadRevision:1,revision:{sessionId:'original-session',method:'provider_callback',contract:'official_stable',state:'planned'},idempotencyKey:'replay-binding-planned'}});
  const input={...scope,expectedHeadRevision:2,confirmSessionId:'original-session',evidence:{source:'native_callback'},idempotencyKey:'replay-binding-confirmed'},first=await operations({operation:'write_run_binding',input}),wal=path.join(store.root,'solomap.db-wal'),hash=()=>crypto.createHash('sha256').update(fs.readFileSync(wal)).digest('hex'),before=hash();
  assert.deepEqual(await operations({operation:'write_run_binding',input}),first);assert.equal(hash()===before,true,'an identical confirmation must not create owners, pins or any other durable database writes');
});

for(const [type,method] of [['state','patchRunState'],['stop','requestRunStop'],['binding','writeRunBinding'],['deliveryClaim','claimRunDelivery'],['deliveryRelease','releaseRunDelivery'],['runClaim','claimRun'],['terminalOwner','claimRunTerminalOwner']])test(`${type}: Native key validation precedes stale control conditions`,async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-control-key-priority-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  const run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'原目标',command:'readonly',userMessage:'用户要求',metadata:{retained:'完整控制上下文🌿'.repeat(12000)},deliveryOwner:{id:'gone',pid:99999999,birth:'gone'},idempotencyKey:`control-key-${type}`}});
  const input={executionLogId:1,generation:run.generation,expectedRevision:0,expectedTurnId:'not-current',expectedHeadRevision:99,patch:{annotation:'原合法补丁'},reason:'用户要求停止',owner:{id:'current',pid:process.pid,birth:''},terminalName:'SoloMap Agent',terminalDeliveryId:'delivery',idempotencyKey:'   '};
  let expected;try{require('./fixtures/native-run-control-oracles.cjs')[method+'Native'](store,run.projectId,input);}catch(error){expected=error.message;}
  assert.equal(expected,'idempotency_key_required');
  await assert.rejects(Promise.resolve().then(()=>store.publishRunControl(run.projectId,{type,input})),error=>error.message===expected);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('an actual frozen Native binding remains a write-free fixed receipt through the public publisher',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-native-control-binding-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  const run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'完整原目标',command:'readonly',userMessage:'原始请求',idempotencyKey:'native-control-binding-run'}}),input={executionLogId:1,generation:run.generation,expectedHeadRevision:0,seed:{runId:'1',provider:'claude',workspaceRoot:root,cliPath:'claude',bindingNonce:'native-original-nonce',createdAt:run.status.startedAt,method:'caller_assigned',contract:'official_stable'},idempotencyKey:'native-original-binding'};
  const native=require('./fixtures/native-run-control-oracles.cjs').writeRunBindingNative(store,run.projectId,input),wal=()=>{const bytes=fs.readFileSync(store.filePath+'-wal');return{length:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};},before=wal();
  assert.equal(native.provider,'claude');assert.deepEqual(await store.writeRunBinding(run.projectId,input),native);assert.deepEqual(wal(),before);
});
