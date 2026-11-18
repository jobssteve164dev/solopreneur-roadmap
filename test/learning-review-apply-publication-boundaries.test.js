const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');

async function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-review-apply-boundaries-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});const call=(operation,input)=>operations({operation,input}),project=await call('register_project',{root}),event=store.write({kind:'learning_event',action:'create',scope:project.projectId,idempotencyKey:'boundary-apply-source',data:{source_object_id:project.projectId,source_revision:1,event_type:'verified',summary:'真实核对交付入口',occurred_at:Date.now()}}),prompt='保留用户目标，核验实际结果。',batch=await call('prepare_learning_review',{runId:'boundary-review-apply',workspaceRoot:root,globalPrompt:prompt,persistedGlobalPrompt:prompt}),source=batch.manifest.sources.find(value=>value.ref?.objectId===event.objectId),result={globalPrompt:prompt,changes:[],lessons:[{projectPath:root,lessonType:'verification_pattern',summary:'验证交付入口',appliesWhen:'交付实际功能',doesNotApplyWhen:'纯讨论',doThis:'执行实际入口并核对输出',avoidThis:'只看退出码',verification:'实际结果可以回读',reason:'本轮真实事件支持该核对动作',evidence:[source.id]}],processedSourceIds:batch.manifest.sources.map(value=>value.id),deferredSourceIds:[],unresolved:[],recovery:[]},input={batchId:batch.objectId,expectedRevision:batch.revision,manifestHash:hash(JSON.stringify(batch.manifest)),result,idempotencyKey:'boundary-review-apply'};
  return{store,operations,call,project,batch,input,apply:()=>call('apply_learning_review',input)};
}
function noOwners(f){for(const table of ['content_lifecycle_prepare_owners','content_lifecycle_prepare_pins'])assert.equal(f.store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n,0);}
function piFence(f){const owner=f.store.claimPiExecutionOwner('review-apply-owner'),operation=f.store.admitPiConversationOperation({schemaVersion:1,conversationId:'816381ea-9418-4edc-bbcd-ec8d9979b152',operationId:'review-apply-operation',requestKey:'review-apply-operation',prompt:'fixture',attachments:[],baselineRevision:0,source:'sidebar',sourceGeneration:1,projectScope:'',systemPrompt:'fixture',projectContext:{selectedProject:'',projects:[]},model:{provider:'agent-cli',modelId:'auto'},tools:[],executionProfile:'pi-core-0.87.1-v1',options:{retry:'native',compaction:'native',toolExecution:'sequential'}},owner);f.store.admitPiToolInvocation(operation.operationId,owner,{invocationId:'review-apply-call',toolName:'solomap_write',arguments:{},replay:'never'});return{operationId:operation.operationId,invocationId:'review-apply-call',ownerId:owner.ownerId,ownerGeneration:owner.generation};}

test('a final native batch failure rolls back the complete prompt, lesson, decision, cursor, applications and events',async t=>{
  const f=await fixture(t),events=f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n,objects=f.store.rows('SELECT COUNT(*) AS n FROM objects')[0].n,policy=f.store.readGlobalPromptPolicy();
  f.store.db.exec("CREATE TEMP TRIGGER review_apply_actual_abort AFTER UPDATE ON review_batches WHEN NEW.status='applying' BEGIN SELECT RAISE(ABORT,'review_apply_actual_abort'); END");
  await assert.rejects(f.apply(),/review_apply_actual_abort/);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM objects')[0].n,objects);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n,events);assert.equal(f.store.rows("SELECT COUNT(*) AS n FROM requests WHERE idempotency_key LIKE 'boundary-review-apply%'")[0].n,0);assert.equal(f.store.readGlobalPromptPolicy().revision,policy.revision);assert.equal(f.store.readMetadata(f.batch.objectId).data.status,'draft');assert.equal(f.store.rows("SELECT COUNT(*) AS n FROM settings WHERE namespace='learning_review'")[0].n,0);noOwners(f);
  f.store.db.exec('DROP TRIGGER review_apply_actual_abort');const result=await f.apply();assert.equal(result.lessons.length,1);assert.equal(f.store.readMetadata(f.batch.objectId).data.status,'applying');noOwners(f);
});

test('a real user policy save during preparation keeps the new policy and prevents partial review adoption',async t=>{
  const f=await fixture(t),compute=f.store.learningReviewApplyCompute;let changed=false;
  f.store.setLearningReviewApplyCompute({...compute,prepare:async request=>{const prepared=await compute.prepare(request);if(!changed){changed=true;const policy=f.store.readGlobalPromptPolicy();await f.store.saveGlobalPrompt({policy:{objectId:policy.objectId,revision:policy.revision},content:'用户后来确认的新要求。',source:'user',idempotencyKey:'actual-late-review-policy'});}return prepared;}});
  await assert.rejects(f.apply(),/revision_conflict/);assert.equal(changed,true);assert.equal(f.store.readGlobalPromptPolicy().data.content,'用户后来确认的新要求。');assert.equal(f.store.readMetadata(f.batch.objectId).data.status,'draft');assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM applications')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM lessons')[0].n,0);noOwners(f);
});

test('final Pi permission loss rejects all review application children after actual preparation',async t=>{
  const f=await fixture(t),fence=piFence(f),compute=f.store.learningReviewApplyCompute;let revoked=false;
  f.store.setLearningReviewApplyCompute({...compute,prepare:async request=>{const prepared=await compute.prepare(request);if(!revoked){revoked=true;f.store.claimPiExecutionOwner('replacement-review-apply-owner');}return prepared;}});
  await assert.rejects(f.operations({operation:'apply_learning_review',input:f.input,piToolFence:fence}),/pi_owner_fenced|pi_tool_invocation_fenced/);assert.equal(revoked,true);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM applications')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM lessons')[0].n,0);assert.equal(f.store.readMetadata(f.batch.objectId).data.status,'draft');noOwners(f);
});

test('a true post-commit ACK error is propagated and an explicit accepted review replay leaves WAL unchanged',async t=>{
  const f=await fixture(t),fence=piFence(f),original=f.store.withPiToolInvocationFenceSync;let acks=0;
  f.store.withPiToolInvocationFenceSync=function(...args){const result=original.apply(this,args);acks++;throw Error('review_apply_actual_ack_failure');};
  try{await assert.rejects(f.operations({operation:'apply_learning_review',input:f.input,piToolFence:fence}),/review_apply_actual_ack_failure/);}finally{f.store.withPiToolInvocationFenceSync=original;}
  assert.equal(acks,1);assert.equal(f.store.readMetadata(f.batch.objectId).data.status,'applying');assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM lessons')[0].n,1);const wal=()=>{const bytes=fs.readFileSync(f.store.filePath+'-wal');return{length:bytes.length,sha:hash(bytes)};},before=wal(),result=await f.operations({operation:'apply_learning_review',input:f.input,piToolFence:fence});assert.equal(result.lessons.length,1);assert.deepEqual(wal(),before);noOwners(f);
});
