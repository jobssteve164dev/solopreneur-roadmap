const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

async function fixture(t,mode){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-run-allocation-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store),project=await store.registerProject({root});
  t.after(async()=>{await operations.close();store.close();});
  await operations({operation:'initialize_project_journal',input:{root}});
  const input={root,executionLogId:0,nodeId:'step',runKind:'step',prompt:'complete original prompt',command:'original command',userMessage:'original user request',metadata:{launchIntentHash:'original-intent-hash'},launchIntentId:'allocated-intent',idempotencyKey:'caller-key'};
  const call=changes=>Promise.resolve().then(()=>{if(mode!=='direct')return operations({operation:'prepare_run_intent',input:{...input,...changes}});const {executionLogId:_executionLogId,...intent}={...input,...changes};return store.prepareRunIntent(project.projectId,project.locationId,intent);});
  return{base,root,store,operations,project,input,call};
}

for(const mode of ['runtime','direct'])test(mode+': a real journal body update during allocation preparation is selected again without Source body comparison',async t=>{
  const f=await fixture(t,mode),original={nodeId:'step',timestamp:new Date().toISOString(),agentCli:'',command:'original retained journal command',output:'retained old output',status:'Preparing'};
  f.store.appendProjectJournal(f.project.projectId,'run-launch-intent:allocated-intent',original);
  const compute=f.store.runCreationCompute,prepare=compute.prepare;let calls=0;
  compute.prepare=async request=>{const result=await prepare(request);if(++calls===1)f.store.updateProjectJournal(f.project.projectId,1,{...original,output:'actual independently updated output'});return result;};
  const run=await f.call({prompt:'full prepared prompt'.repeat(7000)});
  assert.ok(calls>=2);assert.equal(run.status.rootExecutionLogId,1);
  const entry=f.store.readProjectJournal(run.projectId,{executionLogId:1}).logs[0];assert.equal(entry.output,'actual independently updated output');assert.equal(entry.command,original.command);
  const source=f.store.rows('SELECT object_id FROM project_journal_sources WHERE project_id=? AND execution_log_id=1',[run.projectId])[0];assert.equal(JSON.parse(f.store.read(source.object_id).data.content).output,entry.output);
});

for(const mode of ['runtime','direct'])test(mode+': the final allocated run failure rolls the journal prelude and intent relationship back in the original transaction',async t=>{
  const f=await fixture(t,mode),tables=['objects','object_revisions','events','requests','runs','run_control','tasks','turns','conversations','project_journal_entries','project_journal_sources','run_turn_journals','run_launch_intents'],counts=()=>Object.fromEntries(tables.map(table=>[table,f.store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n])),before=counts();
  f.store.db.run("CREATE TEMP TRIGGER fail_allocated_root_event BEFORE INSERT ON events WHEN NEW.kind='run.prepare' BEGIN SELECT RAISE(ABORT,'allocated_run_final_failure'); END");
  await assert.rejects(f.call({prompt:'complete prepared atomic prompt'.repeat(5000)}),/allocated_run_final_failure/);assert.deepEqual(counts(),before);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
  f.store.db.run('DROP TRIGGER fail_allocated_root_event');
  const state=await f.call({});const events=f.store.rows('SELECT kind FROM events WHERE sequence<=? ORDER BY sequence',[state.receipt.committedSequence]).map(row=>String(row.kind));
  assert.equal(events.at(-1),'run.prepare');assert.equal(events.at(-5),'evidence.create','the journal prelude retains its original event position before conversation/task/turn/run');
});

for(const mode of ['runtime','direct'])test(mode+': global slot replay from another project retains its original large result and a finished slot allocates in the new project',async t=>{
  const f=await fixture(t),otherRoot=path.join(f.base,'other-project');fs.mkdirSync(otherRoot);
  const input={...f.input,launchSlotId:'one-global-slot',launchSlotScope:'global',metadata:{launchIntentHash:'global-slot-original-intent',retained:'complete retained metadata'.repeat(8000)}};delete input.launchIntentId;
  const slot=input=>Promise.resolve().then(async()=>{if(mode!=='direct')return f.operations({operation:'prepare_run_slot',input});const project=await f.store.registerProject({root:input.root}),{executionLogId:_executionLogId,...intent}=input;return f.store.prepareRunSlot(project.projectId,project.locationId,intent);});
  const first=await slot(input),read=f.store.content;let replay;
  f.store.content=function(id){if(Number(f.store.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded the retained global slot result');return read.call(this,id);};
  try{replay=await slot({...input,root:otherRoot});}finally{f.store.content=read;}
  assert.equal(replay.runId,first.runId);assert.equal(replay.projectId,first.projectId);assert.equal(replay.status.retained,input.metadata.retained);
  const closed=await f.operations({operation:'checkpoint_run',input:{projectId:first.projectId,executionLogId:1,generation:first.generation,proof:first.proof,expectedRevision:first.revision,expectedTurnId:first.turnId,action:'session-close',exitCode:143,idempotencyKey:'finish-global-slot'}});
  assert.ok(closed.status.finishedAt);
  const next=await slot({...input,root:otherRoot});assert.notEqual(next.runId,first.runId);assert.notEqual(next.projectId,first.projectId);assert.equal(next.status.rootExecutionLogId,1);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM run_launch_intents WHERE launch_intent_id=?',[input.launchSlotId])[0].n,1);
});
