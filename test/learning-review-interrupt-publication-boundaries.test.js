const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),{once}=require('node:events');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs'),{readProcessBirthMarker}=require('../out/processIdentity.js');

async function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-review-interrupt-boundaries-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});const call=(operation,input)=>operations({operation,input});await call('register_project',{root});const prompt='保留用户目标，核验交付。',batch=await call('prepare_learning_review',{runId:'boundary-interrupt-review',workspaceRoot:root,globalPrompt:prompt,persistedGlobalPrompt:prompt}),retained='完整复盘运行背景🌿'.repeat(12000),run=await call('prepare_run',{root,executionLogId:1,nodeId:'__solo__',runKind:'learning_review',prompt:'执行真实复盘',command:'not executed',userMessage:'复盘经验',metadata:{learningReviewBatchId:batch.objectId,retained},idempotencyKey:'boundary-interrupt-run'});
  return{store,operations,call,root,batch,run,retained,interrupt:()=>call('interrupt_learning_review',{batchId:batch.objectId})};
}
function noOwners(f){for(const table of ['content_lifecycle_prepare_owners','content_lifecycle_prepare_pins'])assert.equal(f.store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n,0);}

test('an actual batch abort rolls back the stopped run, both histories and requests before interrupt retry',async t=>{
  const f=await fixture(t),events=f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n,history=f.store.rows('SELECT COUNT(*) AS n FROM run_control_revisions WHERE run_id=?',[f.run.runId])[0].n;
  f.store.db.exec("CREATE TEMP TRIGGER review_interrupt_actual_abort AFTER UPDATE ON review_batches WHEN NEW.status='interrupted' BEGIN SELECT RAISE(ABORT,'review_interrupt_actual_abort'); END");
  await assert.rejects(f.interrupt(),/review_interrupt_actual_abort/);const {state}=await f.store.readRunContextPublication(f.run.projectId,{executionLogId:1});assert.equal(state.revision,f.run.revision);assert.notEqual(state.status.stopRequested,true);assert.equal(f.store.readMetadata(f.batch.objectId).data.status,'draft');assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n,events);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM run_control_revisions WHERE run_id=?',[f.run.runId])[0].n,history);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM requests WHERE idempotency_key LIKE ?',[`learning-review:${f.batch.objectId}:%`])[0].n,0);noOwners(f);
  f.store.db.exec('DROP TRIGGER review_interrupt_actual_abort');await f.interrupt();assert.equal((await f.store.readRunContextPublication(f.run.projectId,{executionLogId:1})).state.status.stopRequested,true);assert.equal(f.store.readMetadata(f.batch.objectId).data.status,'interrupted');noOwners(f);
});

test('a real owner process dying after preparation changes owner-release into the original abandoned-run stop',async t=>{
  const f=await fixture(t),child=spawn(process.execPath,['-e',"process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:'pipe'});child.stderr.resume();await once(child.stdout,'data');t.after(async()=>{if(child.exitCode===null && child.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}});
  await f.call('claim_run',{projectId:f.run.projectId,executionLogId:1,expectedRevision:f.run.revision,agentPid:child.pid,processBirth:readProcessBirthMarker(child.pid),idempotencyKey:'actual-review-child-owner'});
  const compute=f.store.learningReviewInterruptCompute;let killed=false;
  f.store.setLearningReviewInterruptCompute(async request=>{const prepared=await compute(request);if(!killed){assert.equal(prepared.live,true);killed=true;const ended=once(child,'exit');child.kill('SIGTERM');await ended;}return prepared;});
  await f.interrupt();assert.equal(killed,true);assert.equal(f.store.readMetadata(f.batch.objectId).data.status,'interrupted');assert.notEqual(JSON.parse(f.store.read(f.batch.objectId).data.review_content).ownerReleased,true);assert.equal((await f.store.readRunContextPublication(f.run.projectId,{executionLogId:1})).state.status.stopRequested,true);noOwners(f);
});

test('a real review-to-run mapping move releases the old run FIFO and stops only the newly associated run',async t=>{
  const f=await fixture(t),other=await f.call('prepare_run',{root:f.root,executionLogId:2,nodeId:'__solo__',runKind:'solo',prompt:'另一个真实运行',command:'not executed',userMessage:'另一个真实运行',idempotencyKey:'actual-other-review-run'}),compute=f.store.learningReviewInterruptCompute;let changed=false;
  f.store.setLearningReviewInterruptCompute(async request=>{const prepared=await compute(request);if(!changed){changed=true;f.store.db.run('UPDATE learning_review_controls SET run_id=? WHERE batch_id=?',[other.runId,f.batch.objectId]);}return prepared;});
  await f.interrupt();assert.equal(changed,true);const first=(await f.store.readRunContextPublication(f.run.projectId,{executionLogId:1})).state,second=(await f.store.readRunContextPublication(f.run.projectId,{executionLogId:2})).state;assert.equal(first.revision,f.run.revision);assert.notEqual(first.status.stopRequested,true);assert.equal(second.status.stopRequested,true);assert.equal(f.store.readMetadata(f.batch.objectId).data.status,'interrupted');noOwners(f);
});
