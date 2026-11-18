const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

for(const failed of [null,'binding','ready'])test(`prepared bindings, identity and ready inputs over a new real run ${failed?`roll back at the final ${failed} event`:'commit with their original intermediate history'}`,async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-control-projection-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store),project=await store.registerProject({root});t.after(async()=>{await operations.close();store.close();});
  const tables=['objects','object_revisions','events','requests','runs','run_control','run_control_revisions','session_bindings','project_journal_entries','run_turn_journals'],counts=()=>Object.fromEntries(tables.map(table=>[table,store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n])),before=counts();
  if(failed==='binding')store.db.run("CREATE TEMP TRIGGER reject_last_projected_binding BEFORE INSERT ON events WHEN NEW.kind='run.binding' AND (SELECT revision FROM objects WHERE id=NEW.subject_id)=3 BEGIN SELECT RAISE(ABORT,'fixture_last_projected_binding_failure'); END");
  if(failed==='ready')store.db.run("CREATE TEMP TRIGGER reject_last_projected_ready BEFORE INSERT ON events WHEN NEW.kind='run.inputs' AND (SELECT revision FROM objects WHERE id=NEW.subject_id)=5 BEGIN SELECT RAISE(ABORT,'fixture_last_projected_ready_failure'); END");
  const pending=store.publishRunCreation(project.projectId,project.locationId,{root,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'original prompt',command:'',userMessage:'original goal',status:'Preparing',metadata:{retained:'完整运行metadata'.repeat(9000)},idempotencyKey:'projected-root'},publish=>publish(),undefined,async(request,prepared,publication)=>{
    assert.ok(publication);assert.equal(store.rows('SELECT COUNT(*) AS n FROM run_control')[0].n,0);const handles=[];
    try{
      let projected=store.projectedRunCreation(publication);
      const identity={...store.dataWriteDatabaseIdentity(),projectId:project.projectId,actorId:store.actorId,time:Date.now()};
      const first=await store.stageRunControl({...identity,projectedBase:projected,mutation:{type:'binding',input:{executionLogId:1,generation:1,expectedHeadRevision:0,seed:{runId:'1',provider:'claude',workspaceRoot:root,cliPath:'claude',bindingNonce:'original-nonce',createdAt:new Date(request.time).toISOString(),method:'caller_assigned',contract:'official_stable'},idempotencyKey:'projected-binding-seed'}}});handles.push(first);projected=store.projectedRunControl(first);
      const second=await store.stageRunControl({...identity,time:Date.now(),projectedBase:projected,mutation:{type:'binding',input:{executionLogId:1,generation:1,expectedHeadRevision:1,revision:{sessionId:'original-session',method:'caller_assigned',contract:'official_stable',state:'planned'},idempotencyKey:'projected-binding-plan'}}});handles.push(second);
      projected=store.projectedRunControl(second);
      const identityState=await store.stageRunControl({...identity,time:Date.now(),projectedBase:projected,mutation:{type:'state',input:{executionLogId:1,generation:1,expectedRevision:3,patch:{sessionBindingHeadRevision:2,nativeSessionId:'',nativeSessionIdIsCurrent:false},idempotencyKey:'projected-identity-state'}}});handles.push(identityState);projected=store.projectedRunControl(identityState);
      const turn=publication.nodes.get('turn').commit.plan.projectedObject;assert.ok(turn);
      const ready=await store.stageRunInputs({...identity,projectedBase:projected,projectedTurn:turn,input:{executionLogId:1,generation:1,expectedRevision:4,prompt:'完整最终运行输入'.repeat(9000),command:'fixture command',status:'Running',idempotencyKey:'projected-ready'}});handles.push(ready);
      assert.equal(store.rows('SELECT COUNT(*) AS n FROM run_control')[0].n,0);
      return{check:()=>handles.forEach(handle=>handle.check()),before:()=>{},after:()=>handles.forEach(handle=>handle.commitNative()),release:async()=>{for(const handle of handles)await handle.release();}};
    }catch(error){for(const handle of handles)await handle.release();throw error;}
  });
  if(failed){await assert.rejects(pending,failed==='binding'?/fixture_last_projected_binding_failure/:/fixture_last_projected_ready_failure/);assert.deepEqual(counts(),before);}
  else{
    const original=await pending,current=store.readRunState(project.projectId,1);assert.equal(original.revision,1);assert.equal(current.revision,5);
    assert.deepEqual(store.rows('SELECT binding_revision FROM session_bindings ORDER BY binding_revision').map(row=>row.binding_revision),[1,2]);
    assert.equal(store.readRunBinding(project.projectId,1,2).headRevision,1);assert.equal(store.readRunBinding(project.projectId,1,3).headRevision,2);assert.equal(current.status.sessionBindingHeadRevision,2);
    assert.equal(store.readRunState(project.projectId,1,2).status.sessionBindingHeadRevision,1);assert.equal(current.status.retained,'完整运行metadata'.repeat(9000));
    assert.equal(store.readRunState(project.projectId,1,4).status.status,'Preparing');assert.equal(current.status.status,'Running');assert.equal(store.read(current.runId,5).data.prompt_content,'完整最终运行输入'.repeat(9000));
  }
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});
