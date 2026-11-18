const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {canonicalJson}=require('../out/contentReferences.js');
const {runInputsSerializedResult}=require('../out/db/runInputsPublication.js');
const {ObjectHeadVerification}=require('../out/db/objectHeadVerification.js');
const {createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

async function fixture(t,overrides={},strict=true){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-run-input-publication-')),projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);
  const store=new UnifiedDataStore(path.join(root,'data')),operations=createRuntimeDataOperations(store);
  t.after(async()=>{await operations.close();store.close();});
  const run=await operations({operation:'prepare_run',input:{root:projectRoot,executionLogId:1,nodeId:'step',runKind:'step',prompt:'original prompt',command:'original command',userMessage:'original request',metadata:{interactiveSession:true},idempotencyKey:'prepare-run-input-fixture',...overrides}});
  for(let i=0;i<2000;i++){const batch=store.prepareStorageReferenceBatch(128);store.commitStorageReferenceBatch(batch);if(!batch.pending)break;assert.notEqual(i,1999);}
  store.beginContentPreparationRecovery();if(strict)store.activateStorageContentLifecycle({strictPublication:true});
  const patch=fields=>operations({operation:'patch_run_inputs',input:{root:projectRoot,executionLogId:1,generation:run.generation,expectedRevision:1,idempotencyKey:'patch-run-input',...fields}});
  return{root:projectRoot,store,operations,run,patch};
}

function sourceGuard(store){
  const put=store.putContent.bind(store),read=store.content.bind(store),index=store.indexSearchObject.bind(store),createHash=crypto.createHash,stringify=JSON.stringify;
  store.putContent=(value,...args)=>{if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded a large run payload');return put(value,...args);};
  store.content=id=>{if(Number(store.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded a retained large run payload');return read(id);};
  store.indexSearchObject=(object,terms,...args)=>{if(object.kind==='run'&&(typeof terms!=='string'||args[0]!==true))throw Error('Source derived run search terms');return index(object,terms,...args);};
  crypto.createHash=(...args)=>{
    const hash=createHash(...args),update=hash.update;
    hash.update=function(value,...options){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source hashed a large run payload');return update.call(this,value,...options);};
    return hash;
  };
  JSON.stringify=(value,...args)=>{if(value?.runId && value.status && Object.values(value.status).some(item=>typeof item==='string'&&item.length>65536))throw Error('Source encoded a large run result');return stringify(value,...args);};
  return()=>{store.putContent=put;store.content=read;store.indexSearchObject=index;crypto.createHash=createHash;JSON.stringify=stringify;};
}

test('the actual run-input entry retains its request hash, receipts, empty command and fixed control history',async t=>{
  const f=await fixture(t,{},false),fields={prompt:'new prompt',command:'',status:'Waiting'},first=await f.patch(fields);
  const input={root:f.root,executionLogId:1,generation:f.run.generation,expectedRevision:1,idempotencyKey:'patch-run-input',...fields};
  assert.equal(f.store.rows('SELECT input_hash FROM requests WHERE id=?',[first.receipt.requestId])[0].input_hash,crypto.createHash('sha256').update(canonicalJson({operation:'patch_run_inputs',projectId:f.run.projectId,input})).digest('hex'));
  assert.equal(first.revision,2);assert.equal(first.status.status,'Waiting');
  assert.deepEqual(JSON.parse(runInputsSerializedResult(first)),first,'the actual Domain consumer can send the fully serialized Compute projection');
  assert.equal(f.store.read(f.run.runId,1).data.prompt_content,'original prompt');
  assert.equal(f.store.read(f.run.runId,2).data.command_content,'');
  await f.patch({expectedRevision:2,idempotencyKey:'later-run-input',status:'Running'});
  assert.deepEqual(await f.patch(fields),first,'a replay returns its original fixed control revision after a later update');
  await assert.rejects(f.patch({...fields,prompt:'different intent'}),/idempotency_conflict/);
});

test('the public input patch prepares full bodies and serialized metadata outside Source',async t=>{
  const retained='完整保留的输入补丁背景🌿'.repeat(16000),f=await fixture(t,{metadata:{retained}}),input={root:f.root,executionLogId:1,generation:f.run.generation,expectedRevision:1,prompt:'完整用户提示词🌿'.repeat(18000),command:'',status:'Waiting',idempotencyKey:'public-large-input'},restore=sourceGuard(f.store);let result;
  try{result=await f.store.patchRunInputs(f.run.projectId,input);}finally{restore();}
  assert.equal(result.status.retained,retained);assert.equal(f.store.read(f.run.runId,2).data.prompt_content,input.prompt);assert.equal(f.store.read(f.run.runId,2).data.command_content,'');assert.deepEqual(JSON.parse(runInputsSerializedResult(result)),result);
});

for(const mode of ['native','runtime'])test(`${mode}: accepted input replay leaves the physical WAL unchanged`,async t=>{
  const f=await fixture(t,{metadata:{retained:'完整固定上下文🌿'.repeat(12000)}},false),fields={prompt:'完整输入重放正文🌿'.repeat(12000),command:'',status:'Waiting'},input={root:f.root,executionLogId:1,generation:f.run.generation,expectedRevision:1,idempotencyKey:'patch-run-input',...fields},call=()=>mode==='native'?require('./fixtures/native-run-input-oracles.cjs').patchRunInputsNative(f.store,f.run.projectId,input):f.patch(fields),first=await call(),wal=()=>{const bytes=fs.readFileSync(f.store.filePath+'-wal');return{length:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};},before=wal();
  assert.deepEqual(await call(),first);assert.deepEqual(wal(),before);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('input preparation preserves the Native empty-key priority over a stale version',async t=>{
  const f=await fixture(t),input={root:f.root,executionLogId:1,generation:f.run.generation,expectedRevision:0,idempotencyKey:'   ',prompt:'完整合法输入🌿'.repeat(12000)};let expected;
  try{require('./fixtures/native-run-input-oracles.cjs').patchRunInputsNative(f.store,f.run.projectId,input);}catch(error){expected=error.message;}
  assert.equal(expected,'idempotency_key_required');await assert.rejects(f.patch(input),error=>error.message===expected);
});

test('input replay rebuilds a proof dirtied by a real physical rewrite during verification',async t=>{
  const f=await fixture(t,{metadata:{retained:'完整历史背景🌿'.repeat(12000)}}),fields={prompt:'固定原输入',status:'Waiting'},first=await f.patch(fields),verify=f.store.contentVerificationCompute;let changed=false,before;
  const wal=()=>{const bytes=fs.readFileSync(f.store.filePath+'-wal');return{length:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};};
  f.store.contentVerificationCompute=async request=>{const result=await verify(request);if(!changed){changed=true;f.store.db.run('UPDATE contents SET data=data WHERE id=?',[request.contentId]);assert.equal(f.store.rows('SELECT changes() AS n')[0].n,1);before=wal();}return result;};
  try{assert.deepEqual(await f.patch(fields),first);}finally{f.store.contentVerificationCompute=verify;}
  assert.equal(changed,true);assert.deepEqual(wal(),before);
});

test('input replay requalifies a real unversioned journal mapping before returning the fixed receipt',async t=>{
  const f=await fixture(t),fields={prompt:'原固定输入'},first=await f.patch(fields),prepare=f.store.runInputsCompute.prepare;let changed=false,mapped,before;
  const wal=()=>{const bytes=fs.readFileSync(f.store.filePath+'-wal');return{length:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};};
  f.store.runInputsCompute.prepare=async request=>{const result=await prepare(request);if(result.replay && !changed){changed=true;f.store.transaction(()=>{mapped=f.store.appendProjectJournal(f.run.projectId,'actual-input-replay-journal',{nodeId:'step',timestamp:new Date().toISOString(),agentCli:'',command:'',output:'真实恢复的执行记录',status:'Running'}).executionLogId;f.store.db.run('UPDATE run_turn_journals SET execution_log_id=? WHERE project_id=? AND run_id=? AND turn_id=?',[mapped,f.run.projectId,f.run.runId,f.run.turnId]);});before=wal();}return result;};
  const replay=await f.patch(fields);assert.equal(changed,true);assert.equal(replay.status.journalExecutionLogId,mapped);assert.deepEqual(replay.receipt,first.receipt);assert.deepEqual(wal(),before);
});

test('input historical replay preserves the original result without consuming a later damaged metadata body',async t=>{
  const f=await fixture(t,{metadata:{retained:'原版本完整背景🌿'.repeat(12000)}}),fields={prompt:'固定版本输入'},first=await f.patch(fields);
  await f.operations({operation:'patch_run_state',input:{projectId:f.run.projectId,executionLogId:1,generation:f.run.generation,expectedRevision:first.revision,patch:{later:'后来实际状态'},idempotencyKey:'after-fixed-input'}});
  const id=f.store.rows('SELECT metadata_content_id FROM run_control WHERE run_id=?',[f.run.runId])[0].metadata_content_id,encoding=String(f.store.rows('SELECT encoding FROM contents WHERE id=?',[id])[0].encoding);
  if(encoding.startsWith('chunked:'))f.store.db.run('UPDATE content_chunks SET data=zeroblob(length(data)) WHERE content_id=?',[id]);else f.store.db.run('UPDATE contents SET data=zeroblob(stored_byte_length) WHERE id=?',[id]);
  assert.deepEqual(await f.patch(fields),first);
});

test('input current replay does not consume an unrelated damaged object snapshot',async t=>{
  const f=await fixture(t),fields={prompt:'保留当前输入'},first=await f.patch(fields),id=f.store.rows('SELECT content_id FROM object_revisions WHERE object_id=? AND revision=?',[f.run.runId,first.revision])[0].content_id;
  f.store.db.run('UPDATE contents SET data=zeroblob(stored_byte_length) WHERE id=?',[id]);
  const input={root:f.root,executionLogId:1,generation:f.run.generation,expectedRevision:1,idempotencyKey:'patch-run-input',...fields},native=require('./fixtures/native-run-input-oracles.cjs').patchRunInputsNative(f.store,f.run.projectId,input);
  assert.deepEqual(await f.patch(fields),native);assert.deepEqual(native,first);
});

for(const mode of ['native','public'])test(`${mode}: input lesson references publish one real delivery with the original root graph`,async t=>{
  const f=await fixture(t,{},false),summary='完整的已批准经验摘要',action='完整执行最终交付验证',lesson=f.store.write({kind:'lesson',action:'create',scope:f.run.projectId,idempotencyKey:'input-real-approved-lesson',data:{status:'approved',summary,do_this:action}}),prompt=`solomap://objects/${lesson.objectId} · revision=1\n${summary}\n${action}\n`+'完整用户上下文🌿'.repeat(12000),input={root:f.root,executionLogId:1,generation:f.run.generation,expectedRevision:1,idempotencyKey:'patch-run-input',prompt};
  const restore=mode==='public'?sourceGuard(f.store):()=>{};let result;
  try{result=await (mode==='native'?require('./fixtures/native-run-input-oracles.cjs').patchRunInputsNative(f.store,f.run.projectId,input):f.store.patchRunInputs(f.run.projectId,input));}finally{restore();}
  assert.equal(result.revision,2);assert.equal(f.store.read(f.run.runId,2).data.prompt_content,prompt);
  const deliveries=f.store.rows("SELECT id FROM evidence WHERE run_id=? AND type='host_learning_delivery'",[f.run.runId]);assert.equal(deliveries.length,1);
  const relations=f.store.readMetadata(deliveries[0].id).relations;assert.ok(relations.some(value=>value.relation==='delivered_lesson' && value.target===lesson.objectId));assert.ok(relations.some(value=>value.relation==='delivered_turn' && value.target===f.run.turnId));
});

function pauseCompute(t,store,method){
  const compute=store.runInputsCompute,original=compute[method];let enter,release,paused=false,calls=0;
  const entering=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});t.after(release);
  compute[method]=async request=>{calls++;const result=await original(request);if(!paused){paused=true;enter();await gate;}return result;};
  return {entering,release,get calls(){return calls;}};
}

test('a later small update cannot overtake a preparing large input for the same run',async t=>{
  const f=await fixture(t),gate=pauseCompute(t,f.store,'prepare'),prompt='先准备完整提示词'.repeat(20000),first=f.patch({prompt});void first.catch(()=>{});
  await gate.entering;
  const second=f.patch({expectedRevision:2,idempotencyKey:'queued-small-input',status:'Waiting'});void second.catch(()=>{});
  assert.equal(f.store.readMetadata(f.run.runId).revision,1);
  gate.release();const [a,b]=await Promise.all([first,second]);
  assert.equal(a.revision,2);assert.equal(b.revision,3);assert.equal(b.status.status,'Waiting');assert.equal(f.store.read(f.run.runId).data.prompt_content,prompt);
});

test('a legacy writer winning the same key during preparation replays its original receipt',async t=>{
  const f=await fixture(t,{},false),gate=pauseCompute(t,f.store,'plan'),fields={prompt:'prepared winner'.repeat(10000),status:'Waiting'},pending=f.patch(fields);void pending.catch(()=>{});
  await gate.entering;
  const winner=require('./fixtures/native-run-input-oracles.cjs').patchRunInputsNative(f.store,f.run.projectId,{root:f.root,executionLogId:1,generation:f.run.generation,expectedRevision:1,idempotencyKey:'patch-run-input',...fields});
  gate.release();assert.deepEqual(await pending,winner);assert.equal(f.store.readMetadata(f.run.runId).revision,2);
});

test('a same-key legacy commit before planning is replayed even when its plan revision is now stale',async t=>{
  const f=await fixture(t,{},false),gate=pauseCompute(t,f.store,'prepare'),fields={prompt:'earlier legacy winner'.repeat(10000)},pending=f.patch(fields);void pending.catch(()=>{});
  await gate.entering;
  const winner=require('./fixtures/native-run-input-oracles.cjs').patchRunInputsNative(f.store,f.run.projectId,{root:f.root,executionLogId:1,generation:f.run.generation,expectedRevision:1,idempotencyKey:'patch-run-input',...fields});
  gate.release();assert.deepEqual(await pending,winner);
});

test('a changed physical body after planning cannot be taken up by a stale run proof',async t=>{
  const f=await fixture(t,{metadata:{largeContext:'保留完整元数据'.repeat(20000)}}),gate=pauseCompute(t,f.store,'plan'),prompt='proof checked body',pending=f.patch({prompt});void pending.catch(()=>{});
  await gate.entering;
  const hash=crypto.createHash('sha256').update(prompt).digest('hex'),id=f.store.rows('SELECT id FROM contents WHERE sha256=? AND mime_type=?',[hash,'text/plain'])[0].id;
  f.store.db.run('UPDATE contents SET data=? WHERE id=?',[Buffer.from('x'.repeat(Buffer.byteLength(prompt))),id]);
  gate.release();assert.equal((await pending).revision,2);
  assert.ok(gate.calls>=2,'dirty physical bytes invalidate the old plan and must be verified again after restoring the original bytes');
  assert.equal(f.store.read(f.run.runId).data.prompt_content,prompt);assert.deepEqual(f.store.content(id),Buffer.from(prompt));
});

test('a run-input publication rechecks its Pi owner at the final business commit',async t=>{
  const f=await fixture(t),owner=f.store.claimPiExecutionOwner('run-input-owner');
  const operation=f.store.admitPiConversationOperation({schemaVersion:1,conversationId:'816381ea-9418-4edc-bbcd-ec8d9979b152',operationId:'run-input-operation',requestKey:'run-input-operation',prompt:'fixture',attachments:[],baselineRevision:0,source:'sidebar',sourceGeneration:1,projectScope:'',systemPrompt:'fixture',projectContext:{selectedProject:'',projects:[]},model:{provider:'agent-cli',modelId:'auto'},tools:[],executionProfile:'pi-core-0.87.1-v1',options:{retry:'native',compaction:'native',toolExecution:'sequential'}},owner);
  f.store.admitPiToolInvocation(operation.operationId,owner,{invocationId:'run-input-call',toolName:'solomap_write',arguments:{},replay:'never'});
  const fence={operationId:operation.operationId,invocationId:'run-input-call',ownerId:owner.ownerId,ownerGeneration:owner.generation},gate=pauseCompute(t,f.store,'plan');
  const pending=f.operations({operation:'patch_run_inputs',piToolFence:fence,input:{root:f.root,executionLogId:1,generation:f.run.generation,expectedRevision:1,idempotencyKey:'fenced-run-input',prompt:'owner guarded prompt'.repeat(10000)}});void pending.catch(()=>{});
  await gate.entering;f.store.claimPiExecutionOwner('replacement-run-input-owner');gate.release();
  await assert.rejects(pending,/pi_owner_fenced|pi_tool_invocation_fenced/);
  assert.equal(f.store.readMetadata(f.run.runId).revision,1);assert.equal(f.store.rows("SELECT 1 FROM requests WHERE idempotency_key='fenced-run-input'").length,0);
});

test('a run document published after planning is included in the fixed input revision relations',async t=>{
  const f=await fixture(t),gate=pauseCompute(t,f.store,'plan'),pending=f.patch({prompt:'full prepared prompt'.repeat(10000)});void pending.catch(()=>{});
  await gate.entering;
  const document=await f.operations({operation:'write_run_document',input:{root:f.root,executionLogId:1,generation:f.run.generation,purpose:'task_notes',bytes:Buffer.from('document published before input commit').toString('base64'),mimeType:'text/plain',expectedRevision:0,idempotencyKey:'concurrent-input-document'}});
  gate.release();const result=await pending;
  await f.patch({expectedRevision:result.revision,idempotencyKey:'after-document-input',status:'Waiting'});
  assert.ok(f.store.read(f.run.runId,result.revision).relations.some(relation=>relation.relation==='source'&&relation.target===document.objectId));
  assert.ok(gate.calls>=2,'the new relation invalidates the old run snapshot plan');
});

test('a prompt with many absent lesson handles registers proofs in bounded Source pieces',async t=>{
  const f=await fixture(t),prompt=Array.from({length:301},(_,i)=>`solomap://objects/missing-lesson-${i} · revision=1`).join('\n');
  const original=f.store.rows.bind(f.store);let perHeadSourceReads=0;
  f.store.rows=(sql,...args)=>{if(/SELECT revision FROM objects WHERE id=\?/.test(sql))perHeadSourceReads++;return original(sql,...args);};
  const result=await f.patch({prompt});
  assert.equal(result.revision,2);assert.equal(perHeadSourceReads,0,'the final Source commit must not query each observed URI head');
  assert.equal(original('SELECT COUNT(*) AS n FROM temp.solomap_object_head_watches')[0].n,0,'only the accepted call owns these temporary proofs');
});

test('failed temporary proof release retains only its token for bounded retry without masking an operation',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-object-proof-release-')),store=new UnifiedDataStore(path.join(root,'data'));t.after(()=>store.close());
  const f={store},proofs=new ObjectHeadVerification(store.db),token=proofs.token(),heads=Array.from({length:301},(_,i)=>({id:`release-missing-${i}`,revision:null}));
  for(let offset=0;offset<heads.length;offset+=128)f.store.transaction(()=>proofs.register(token,heads.slice(offset,offset+128)));
  f.store.db.run("CREATE TEMP TRIGGER reject_object_proof_release BEFORE DELETE ON solomap_object_head_watches BEGIN SELECT RAISE(ABORT,'proof_release_io_failure'); END");
  assert.equal(proofs.releaseBatch(token),false,'retire the failed token instead of replacing the original operation error');
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM temp.solomap_object_head_watches')[0].n,301);
  assert.throws(()=>proofs.flushRetired(true),/proof_release_io_failure/,'the background retry retains the original I/O error and enters the existing 5s error cadence instead of a runnable pending hot loop');
  f.store.db.run('DROP TRIGGER reject_object_proof_release');
  assert.equal(proofs.flushRetired(),true);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM temp.solomap_object_head_watches')[0].n,173);
  assert.equal(proofs.flushRetired(),true);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM temp.solomap_object_head_watches')[0].n,45);
  assert.equal(proofs.flushRetired(),false);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM temp.solomap_object_head_watches')[0].n,0);
});

test('a conflicting revision written while Compute plans cannot publish stale prepared inputs',async t=>{
  const f=await fixture(t,{},false),gate=pauseCompute(t,f.store,'plan'),pending=f.patch({prompt:'must not commit'.repeat(10000)});void pending.catch(()=>{});
  await gate.entering;
  require('./fixtures/native-run-input-oracles.cjs').patchRunInputsNative(f.store,f.run.projectId,{executionLogId:1,generation:f.run.generation,expectedRevision:1,idempotencyKey:'competing-input',prompt:'current winner'});
  gate.release();await assert.rejects(pending,/revision_conflict/);
  assert.equal(f.store.read(f.run.runId).data.prompt_content,'current winner');assert.equal(f.store.rows("SELECT 1 FROM requests WHERE idempotency_key='patch-run-input'").length,0);
});

test('a runtime input with caller-owned extra request containers hashes their accepted values',async t=>{
  const f=await fixture(t),gate=pauseCompute(t,f.store,'prepare'),extra={nested:['accepted']};
  const prompt='accepted prompt'.repeat(10000),pending=f.patch({prompt,extra});void pending.catch(()=>{});await gate.entering;extra.nested[0]='changed later';gate.release();
  const result=await pending,input={root:f.root,executionLogId:1,generation:f.run.generation,expectedRevision:1,idempotencyKey:'patch-run-input',prompt,extra:{nested:['accepted']}};
  assert.equal(f.store.rows('SELECT input_hash FROM requests WHERE id=?',[result.receipt.requestId])[0].input_hash,crypto.createHash('sha256').update(canonicalJson({operation:'patch_run_inputs',projectId:f.run.projectId,input})).digest('hex'));
});

test('a small run-input patch also publishes its new plain and empty body summaries before strict roots',async t=>{
  const f=await fixture(t),result=await f.patch({prompt:'small new prompt',command:''});
  assert.equal(result.revision,2);
  for(const row of f.store.rows('SELECT prompt_content_id AS id FROM runs WHERE id=? UNION SELECT command_content_id AS id FROM runs WHERE id=?',[f.run.runId,f.run.runId]))assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_reference_unpublished WHERE content_id=?',[row.id])[0].n,0);
});

test('a bounded ordinary input patch keeps the local synchronous path without starting Compute',async t=>{
  const f=await fixture(t);for(const method of ['prepare','plan','result'])f.store.runInputsCompute[method]=async()=>{throw Error('small input unexpectedly entered Compute');};
  const result=await f.patch({prompt:'立即可用的小输入',command:'',status:'Waiting'});
  assert.equal(result.revision,2);assert.equal(result.status.status,'Waiting');
});

test('the actual run-input entry prepares a large prompt and its full reference summary before strict business publication',async t=>{
  const f=await fixture(t),targets=Array.from({length:301},(_,i)=>`unavailable-run-source-${i}`),prompt=JSON.stringify({sourceContents:Object.fromEntries(targets.map((id,i)=>[i,id])),raw:'完整运行输入🌿'.repeat(20000)}),restore=sourceGuard(f.store);
  let result;try{result=await f.patch({prompt});}finally{restore();}
  assert.equal(result.revision,2);assert.equal(f.store.read(f.run.runId,2).data.prompt_content,prompt);
  const id=f.store.rows('SELECT prompt_content_id FROM runs WHERE id=?',[f.run.runId])[0].prompt_content_id;
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_edges WHERE source_id=?',[id])[0].n,301);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_reference_unpublished WHERE content_id=?',[id])[0].n,0);
});

for(const retained of ['prompt','metadata'])test(`a status-only run-input patch preserves retained large ${retained} without decoding it on Source`,async t=>{
  const body='必须保留的运行上下文🌿'.repeat(20000),f=await fixture(t,retained==='prompt'?{prompt:body}:{metadata:{interactiveSession:true,largeContext:body}}),restore=sourceGuard(f.store);
  let result;try{result=await f.patch({status:'Waiting'});}finally{restore();}
  assert.equal(result.status.status,'Waiting');
  if(retained==='prompt')assert.equal(f.store.read(f.run.runId,2).data.prompt_content,body);
  else assert.equal(result.status.largeContext,body);
  assert.equal(f.store.readRunState(f.run.projectId,1,1).status.status,'Running');
});

test('a closed session with retained large metadata keeps the original semantic rejection before any business commit',async t=>{
  const f=await fixture(t,{metadata:{interactiveSessionClosed:true,largeContext:'原会话内容'.repeat(20000)}}),restore=sourceGuard(f.store);
  try{await assert.rejects(f.patch({status:'Running'}),/session_already_closed/);}finally{restore();}
  assert.equal(f.store.readMetadata(f.run.runId).revision,1);
  assert.equal(f.store.rows("SELECT COUNT(*) AS n FROM requests WHERE idempotency_key='patch-run-input'")[0].n,0);
});
