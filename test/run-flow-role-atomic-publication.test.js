const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');
const {createFlowTrace,createFlowLoop}=require('../out/flowStore.js');

async function fixture(t,initial=true){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-flow-role-atomic-publication-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store),project=await store.registerProject({root});
  t.after(async()=>{await operations.close();store.close();});
  const flow=createFlowTrace(root,'完整Flow目标');flow.loops=[createFlowLoop(flow.goal,1)];
  if(!initial)await operations({operation:'write_flow_trace',input:{root,flow,expectedRevision:0,idempotencyKey:'original-flow'}});
  await operations({operation:'initialize_project_journal',input:{root}});
  for(;;){const batch=store.prepareStorageReferenceBatch(128);store.commitStorageReferenceBatch(batch);if(!batch.pending)break;}
  store.beginContentPreparationRecovery();store.activateStorageContentLifecycle({strictPublication:true});
  const input={root,flowId:flow.flowId,loopId:'loop-1',role:'planner',attempt:0,...(initial?{initialFlow:flow}:{}),prompt:'原角色完整输入',command:'',userMessage:flow.goal,status:'Preparing',metadata:{launchIntentHash:'original-role-intent'},idempotencyKey:'original-role'};
  return{store,operations,project,flow,input,call:patch=>operations({operation:'prepare_flow_role',input:{...input,...patch}})};
}
const tables=['objects','object_revisions','events','requests','runs','run_control','run_control_revisions','conversations','tasks','turns','project_journal_entries','project_journal_sources','run_turn_journals','run_documents','flow_control','flow_loop_details','flow_revisions','flow_role_runs','notification_deliveries'];
const counts=store=>Object.fromEntries(tables.map(table=>[table,store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n]));
const noOwners=store=>{assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);};

for(const initial of [true,false])test(`failure in the final attached Flow event rolls back ${initial?'the initial Flow and ':''}journal, run and role mapping`,async t=>{
  const f=await fixture(t,initial),before=counts(f.store);
  f.store.db.run("CREATE TEMP TRIGGER reject_attached_flow BEFORE INSERT ON events WHEN NEW.kind='evidence.flow' AND (SELECT revision FROM objects WHERE id=NEW.subject_id)=2 BEGIN SELECT RAISE(ABORT,'fixture_final_flow_attachment_failure'); END");
  await assert.rejects(f.call(),/fixture_final_flow_attachment_failure/);assert.deepEqual(counts(f.store),before);noOwners(f.store);
  f.store.db.run('DROP TRIGGER reject_attached_flow');
  const run=await f.call(),snapshot=f.store.readFlowTrace(f.project.projectId,f.flow.flowId);
  assert.equal(snapshot.revision,2);assert.equal(snapshot.flow.loops[0].planner.executionLogId,run.status.rootExecutionLogId);
  const stable=counts(f.store);assert.equal((await f.call()).runId,run.runId);assert.deepEqual(counts(f.store),stable);noOwners(f.store);
});

test('a Flow paused during real role preparation leaves no journal or run behind',async t=>{
  const f=await fixture(t,false),prepare=f.store.runCreationCompute.prepare;let enter,release;
  const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});t.after(release);
  f.store.runCreationCompute.prepare=async request=>{const result=await prepare(request);enter();await gate;return result;};
  const pending=f.call();void pending.catch(()=>{});await entered;
  try{
    assert.equal(f.store.db.inTransaction,false);
    await f.operations({operation:'write_flow_trace',input:{root:f.input.root,flow:{...f.flow,status:'paused'},expectedRevision:1,idempotencyKey:'pause-before-role-publication'}});
  }finally{release();}
  await assert.rejects(pending,/flow_not_running/);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM runs')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM project_journal_entries')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM flow_role_runs')[0].n,0);noOwners(f.store);
});

test('a Flow created by another entry after selection is adopted before the role is attached',async t=>{
  const f=await fixture(t),select=f.store.flowRoleCompute;let enter,release,first=true;
  const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});t.after(release);
  f.store.flowRoleCompute=async request=>{const result=await select(request);if(first){first=false;enter();await gate;}return result;};
  const pending=f.call();void pending.catch(()=>{});await entered;let original;
  try{original=await f.operations({operation:'write_flow_trace',input:{root:f.input.root,flow:f.flow,expectedRevision:0,idempotencyKey:'independent-first-flow'}});}finally{release();}
  const run=await pending,snapshot=f.store.readFlowTrace(f.project.projectId,f.flow.flowId);
  assert.equal(snapshot.objectId,original.objectId);assert.equal(snapshot.revision,2);assert.equal(snapshot.flow.loops[0].planner.executionLogId,run.status.rootExecutionLogId);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM flow_control')[0].n,1);noOwners(f.store);
});
