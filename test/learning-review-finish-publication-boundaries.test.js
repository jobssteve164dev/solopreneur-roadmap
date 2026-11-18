const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');

async function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-review-finish-boundaries-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});const call=(operation,input)=>operations({operation,input}),project=await call('register_project',{root}),prompt='保留用户目标，核验实际交付。',batch=await call('prepare_learning_review',{runId:'boundary-formal-review',workspaceRoot:root,globalPrompt:prompt,persistedGlobalPrompt:prompt}),result={globalPrompt:prompt,changes:[],lessons:[],processedSourceIds:batch.manifest.sources.map(source=>source.id),deferredSourceIds:[],unresolved:[],recovery:[]},applied=await call('apply_learning_review',{batchId:batch.objectId,expectedRevision:batch.revision,manifestHash:hash(JSON.stringify(batch.manifest)),result,idempotencyKey:'boundary-review-apply'}),input={applicationId:applied.application.objectId,expectedRevision:applied.application.revision,promptHash:hash(prompt),idempotencyKey:'boundary-review-finish'};
  return{store,operations,call,project,batch,applied,input,finish:(value=input)=>call('finish_learning_review',value)};
}
function noOwners(f){for(const table of ['content_lifecycle_prepare_owners','content_lifecycle_prepare_pins'])assert.equal(f.store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n,0);}

test('a final batch Native failure rolls back application, both requests and events before a same-intent review finish retry',async t=>{
  const f=await fixture(t),before=f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n;
  f.store.db.exec("CREATE TEMP TRIGGER review_finish_boundary_abort AFTER UPDATE ON review_batches WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT,'review_finish_actual_abort'); END");
  await assert.rejects(f.finish(),/review_finish_actual_abort/);assert.equal(f.store.readMetadata(f.applied.application.objectId).revision,f.applied.application.revision);assert.equal(f.store.readMetadata(f.applied.application.objectId).data.status,'applying');assert.equal(f.store.readMetadata(f.batch.objectId).data.status,'applying');assert.equal(f.store.rows("SELECT COUNT(*) AS n FROM requests WHERE idempotency_key LIKE 'boundary-review-finish%'")[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n,before);noOwners(f);
  f.store.db.exec('DROP TRIGGER review_finish_boundary_abort');const receipt=await f.finish();assert.equal(f.store.readMetadata(receipt.objectId).data.status,'applied');assert.equal(f.store.readMetadata(f.batch.objectId).data.status,'applied');noOwners(f);
});

test('review finish shares the original application write FIFO while an unrelated real write can proceed',async t=>{
  const f=await fixture(t),compute=f.store.learningReviewFinishCompute;let release,enteredResolve,first=true;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>enteredResolve=resolve);t.after(()=>release());
  f.store.setLearningReviewFinishCompute(async request=>{if(first){first=false;enteredResolve();await gate;}return compute(request);});
  const finishing=f.finish();void finishing.catch(()=>{});await entered;
  const later=f.call('write',{kind:'application',action:'patch',scope:f.project.projectId,objectId:f.applied.application.objectId,expectedRevision:f.applied.application.revision,idempotencyKey:'after-review-finish',data:{status:'partial'}});void later.catch(()=>{});
  try{await f.call('append_diagnostic_event',{kind:'operation',occurredAt:new Date().toISOString(),scope:'review-finish-unrelated',payload:{complete:true},idempotencyKey:'review-finish-unrelated'});assert.equal(f.store.readDiagnosticEvents().items.length,1);}finally{release();}
  const receipt=await finishing;await assert.rejects(later,/revision_conflict/);assert.equal(f.store.readMetadata(receipt.objectId).data.status,'applied');noOwners(f);
});

test('a real pinned-input mapping change before the first watch is re-read before review finish commits',async t=>{
  const f=await fixture(t),original=f.store.rows('SELECT input_content_id FROM learning_review_controls WHERE batch_id=?',[f.batch.objectId])[0].input_content_id,saved=JSON.parse(f.store.content(original).toString('utf8')),next=f.store.putStructuredContent({...saved,verifiedSourceChange:'actual-mapping'}),compute=f.store.learningReviewFinishCompute;let changed=false,calls=0;
  f.store.setLearningReviewFinishCompute(async request=>{calls++;const prepared=await compute(request);if(!changed){changed=true;f.store.db.run('UPDATE learning_review_controls SET input_content_id=? WHERE batch_id=?',[next,f.batch.objectId]);}return prepared;});
  const receipt=await f.finish();assert.ok(calls>=3);assert.equal(f.store.readMetadata(receipt.objectId).data.status,'applied');assert.equal(f.store.rows('SELECT input_content_id FROM learning_review_controls WHERE batch_id=?',[f.batch.objectId])[0].input_content_id,next);noOwners(f);
});

test('the original application revision error precedes reading a damaged batch input',async t=>{
  const f=await fixture(t),broken=f.store.putContent('{');f.store.db.run('UPDATE learning_review_controls SET input_content_id=? WHERE batch_id=?',[broken,f.batch.objectId]);
  await assert.rejects(f.finish({...f.input,expectedRevision:0}),/revision_conflict/);assert.equal(f.store.rows("SELECT COUNT(*) AS n FROM requests WHERE idempotency_key LIKE 'boundary-review-finish%'")[0].n,0);assert.equal(f.store.readMetadata(f.applied.application.objectId).data.status,'applying');noOwners(f);
});
