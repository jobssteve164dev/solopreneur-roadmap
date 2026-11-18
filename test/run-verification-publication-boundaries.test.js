const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

async function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-verification-boundaries-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  const create=id=>operations({operation:'prepare_run',input:{root,executionLogId:id,nodeId:'__solo__',runKind:'solo',prompt:'完整验证目标',command:'not executed',userMessage:'完整验证目标',idempotencyKey:`boundary-run:${id}`}}),run=await create(1),input={projectId:run.projectId,executionLogId:1,claim:'独立检查通过',result:'pass',evidence:'完整独立检查证据',idempotencyKey:'boundary-verification'};
  return{store,operations,run,input,create,call:input=>operations({operation:'record_run_verification',input})};
}

test('a verification Native insert failure rolls back the original root request, evidence and events before same-intent recovery',async t=>{
  const f=await fixture(t),before=f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n;
  f.store.db.exec("CREATE TEMP TRIGGER verification_boundary_abort AFTER INSERT ON verifications BEGIN SELECT RAISE(ABORT,'verification_boundary_actual_abort'); END");
  await assert.rejects(f.call(f.input),/verification_boundary_actual_abort/);
  assert.equal(f.store.rows("SELECT COUNT(*) AS n FROM requests WHERE idempotency_key LIKE 'boundary-verification%'")[0].n,0);
  assert.equal(f.store.rows("SELECT COUNT(*) AS n FROM evidence WHERE type='host_verification'")[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM verifications')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n,before);
  f.store.db.exec('DROP TRIGGER verification_boundary_abort');const receipt=await f.call(f.input);assert.equal(f.store.read(receipt.objectId).data.claim,f.input.claim);
  for(const table of ['content_lifecycle_prepare_owners','content_lifecycle_prepare_pins'])assert.equal(f.store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n,0);
});

test('the genuine same-key verification accepted during preparation retains its actual receipt and child graph',async t=>{
  const f=await fixture(t),compute=f.store.runVerificationCompute;let winner,once=false;
  f.store.setRunVerificationCompute(async request=>{const prepared=await compute(request);if(!once){once=true;winner=require('./fixtures/native-learning-producer-oracles.cjs').recordRunVerificationNative(f.store,f.run.projectId,f.input);}return prepared;});
  assert.deepEqual(await f.call(f.input),winner);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM verifications')[0].n,1);assert.equal(f.store.rows("SELECT COUNT(*) AS n FROM evidence WHERE type='host_verification'")[0].n,1);
});

test('a genuine task change inside final readonly qualification causes re-preparation rather than publishing stale verification or leaking a private sentinel',async t=>{
  const f=await fixture(t),other=await f.create(2),task=f.store.rows('SELECT task_id FROM runs WHERE id=?',[other.runId])[0].task_id,compute=f.store.runVerificationCompute;let changed=false;
  f.store.setRunVerificationCompute(async request=>{
    if(request.qualification && !changed){changed=true;f.store.write({kind:'run',action:'patch',scope:f.run.projectId,objectId:f.run.runId,expectedRevision:f.store.readMetadata(f.run.runId).revision,idempotencyKey:'real-task-change',data:{task_id:task}});}
    return compute(request);
  });
  const receipt=await f.call(f.input);assert.equal(changed,true);assert.equal(f.store.read(receipt.objectId).data.task_id,task);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM verifications')[0].n,1);
});

test('multiple metrics for one adopted action share one real verification feedback while all evaluations are updated',async t=>{
  const f=await fixture(t),write=(kind,key,data)=>f.store.write({kind,action:'create',scope:f.run.projectId,idempotencyKey:key,data}),action='核对正式交付入口';
  const policy=f.store.write({kind:'policy',action:'create',scope:null,idempotencyKey:'metrics-policy',data:{kind:'execution_baseline',status:'active',content:'同一执行基线'}}),lesson=write('lesson','metrics-lesson',{status:'approved',summary:'核对最终入口',do_this:action}),use=write('policy_use','metrics-use',{policy_id:policy.objectId,policy_revision:policy.revision,lesson_id:lesson.objectId,lesson_revision:lesson.revision,run_id:f.run.runId,purpose:action}),feedback=write('learning_event','metrics-original-feedback',{source_object_id:use.objectId,source_revision:use.revision,event_type:'completed',summary:action,occurred_at:Date.now()});
  const evaluations=['entry-starts','result-correct'].map(metric=>write('evaluation',`metrics:${metric}`,{policy_use_id:use.objectId,feedback_event_id:feedback.objectId,metric,value:null,baseline_ref:JSON.stringify({turnId:f.run.turnId,lessonId:lesson.objectId,lessonRevision:lesson.revision,action,evidence:['实际检查记录']}),verdict:'unassessed'}));
  const receipt=await f.call({...f.input,turnId:f.run.turnId,experienceAssessments:[{lessonId:lesson.objectId,lessonRevision:lesson.revision,action,result:'pass',evidence:'逐项核对入口启动与结果'}]});
  const current=evaluations.map(item=>f.store.readMetadata(item.objectId));assert.deepEqual(current.map(item=>item.data.verdict),['effective','effective']);assert.deepEqual(current.map(item=>item.data.verification_id),[receipt.objectId,receipt.objectId]);assert.equal(current[0].data.feedback_event_id,current[1].data.feedback_event_id);
  const finalFeedback=f.store.read(String(current[0].data.feedback_event_id));assert.equal(finalFeedback.data.event_type,'verified');assert.ok(finalFeedback.relations.some(item=>item.target===receipt.objectId));assert.ok(finalFeedback.relations.some(item=>item.target===feedback.objectId));
  assert.equal(f.store.rows("SELECT COUNT(*) AS n FROM learning_events WHERE source_object_id=? AND event_type='verified'",[use.objectId])[0].n,1);for(const table of ['content_lifecycle_prepare_owners','content_lifecycle_prepare_pins'])assert.equal(f.store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n,0);
});
