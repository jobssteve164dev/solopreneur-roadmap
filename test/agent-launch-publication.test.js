const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

for(const entry of ['runtime','host'])test(`the actual ${entry} Agent launch prepares its original intent, retained metadata, binding revisions, fixed policy and final prompt outside Source`,async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-agent-launch-publication-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  await store.registerProject({root});
  for(;;){const batch=store.prepareStorageReferenceBatch(128);store.commitStorageReferenceBatch(batch);if(!batch.pending)break;}
  store.beginContentPreparationRecovery();store.activateStorageContentLifecycle({strictPublication:true});
  const input={agentCli:'claude',selectedModel:'fixture-model',prompt:'完整启动输入'.repeat(9000),globalPrompt:'完整固定全局要求'.repeat(9000),workspaceRoot:root,nodeId:'__solo__',executionLogId:1,userMessage:'完整原始目标'.repeat(9000),runKind:'solo',globalDataPath:store.root,taskPermissionMode:'auto',metadata:{preserved:'完整保留metadata'.repeat(9000)},deliveryOwner:{id:'original-window',pid:process.pid,birth:''}};
  const put=store.putContent,read=store.content,createHash=crypto.createHash;
  store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded a large Agent launch body');return put.call(this,value,...args);};
  store.content=function(id){if(Number(store.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded a large Agent launch body');return read.call(this,id);};
  crypto.createHash=(...args)=>{const hash=createHash(...args),update=hash.update;hash.update=function(value,...options){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source hashed a large Agent launch body');return update.call(this,value,...options);};return hash;};
  let result;try{result=entry==='runtime'?await operations({operation:'prepare_agent_launch',input}):await require('../out/agentRunPreparation.js').prepareAgentRun(input,(operation,input)=>operations({operation,input}));}finally{store.putContent=put;store.content=read;crypto.createHash=createHash;}
  const plan=store.readRunExecutionPlan(result.projectId,1),binding=store.readRunBinding(result.projectId,1);
  assert.equal(result.status.preserved,input.metadata.preserved);assert.equal(result.status.userMessage,input.userMessage);assert.equal(result.status.status,'Running');
  assert.equal(binding.headRevision,2);assert.equal(result.status.sessionBindingHeadRevision,2);assert.equal(result.status.deliveryPending,true);
  assert.ok(plan.prompt.includes(input.prompt));assert.ok(plan.prompt.includes(input.globalPrompt));assert.ok(plan.prompt.includes(result.turnId));
  assert.equal(store.read(result.status.globalPromptPolicyRef.objectId,result.status.globalPromptPolicyRef.revision).data.content,input.globalPrompt);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

async function fixture(t,patch={}){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-agent-launch-boundary-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store),project=await store.registerProject({root});t.after(async()=>{await operations.close();store.close();});
  await operations({operation:'initialize_project_journal',input:{root}});
  const input={agentCli:'claude',selectedModel:'original-model',prompt:'完整本轮任务',globalPrompt:'本轮完整固定策略',workspaceRoot:root,nodeId:'__solo__',executionLogId:0,userMessage:'完整本轮目标',runKind:'solo',globalDataPath:store.root,taskPermissionMode:'auto',launchIntentId:'formal-launch',metadata:{retained:'完整大正文'.repeat(12000)},deliveryOwner:{id:'window',pid:process.pid,birth:''},...patch};
  for(const key of Object.keys(input))if(input[key]===undefined)delete input[key];
  return{store,operations,project,input,launch:()=>operations({operation:'prepare_agent_launch',input})};
}
const tables=['objects','object_revisions','requests','events','runs','run_control','run_control_revisions','session_bindings','run_launch_intents','run_documents','project_journal_entries','run_turn_journals','flow_control','flow_revisions','flow_role_runs'];
const counts=store=>Object.fromEntries(tables.map(table=>[table,store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n]));
const exited=store=>{for(const table of ['content_lifecycle_prepare_owners','content_lifecycle_prepare_pins'])assert.equal(store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n,0);};

test('actual final Agent ready failure rolls back the complete intent, journal, binding and input graph',async t=>{
  const f=await fixture(t),before=counts(f.store);
  f.store.db.run("CREATE TEMP TRIGGER reject_agent_ready BEFORE INSERT ON events WHEN NEW.kind='run.inputs' BEGIN SELECT RAISE(ABORT,'fixture_agent_final_ready_failure'); END");
  await assert.rejects(f.launch(),/fixture_agent_final_ready_failure/);assert.deepEqual(counts(f.store),before);exited(f.store);
  f.store.db.run('DROP TRIGGER reject_agent_ready');
  const result=await f.launch();assert.equal(result.revision,5);assert.equal(result.receipt.revision,5);assert.equal(f.store.readRunBinding(result.projectId,result.status.rootExecutionLogId).headRevision,2);exited(f.store);
});

test('actual recovery claims the original launch without adopting later incoming text and returns the current decorated result',async t=>{
  const f=await fixture(t),first=await f.launch();assert.equal(first.revision,5);
  f.input.prompt='另一次输入不得覆盖已保存原请求';f.input.metadata={retained:'另一份metadata'};
  const second=await f.launch();assert.equal(second.runId,first.runId);assert.equal(second.revision,6);assert.equal(second.receipt,undefined);assert.ok(second.proof);assert.equal(second.dataRoot,f.store.root);assert.equal(second.status.retained,first.status.retained);
  const plan=f.store.readRunExecutionPlan(first.projectId,first.status.rootExecutionLogId);assert.ok(plan.prompt.includes('完整本轮任务'));assert.ok(!plan.prompt.includes(f.input.prompt));assert.equal(f.store.readRunBinding(first.projectId,first.status.rootExecutionLogId).headRevision,2);exited(f.store);
});

test('a later small update on the same run waits for accepted Agent preparation while unrelated local work completes',async t=>{
  const f=await fixture(t,{executionLogId:1,launchIntentId:undefined}),select=f.store.agentLaunchCompute.select;let enter,release,first=true;
  const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});t.after(release);
  f.store.agentLaunchCompute.select=async request=>{const value=await select(request);if(first){first=false;enter();await gate;}return value;};
  const pending=f.launch();void pending.catch(()=>{});await entered;assert.equal(f.store.db.inTransaction,false);
  let completed=false;const later=f.operations({operation:'patch_run_state',input:{projectId:f.project.projectId,executionLogId:1,generation:1,expectedRevision:5,patch:{afterLaunch:true},idempotencyKey:'later-agent-state'}}).then(value=>{completed=true;return value;});void later.catch(()=>{});
  try{
    const receipt=await f.operations({operation:'write',input:{kind:'memory',action:'create',scope:f.project.projectId,idempotencyKey:'during-agent-preparation',data:{category:'inbox',title:'已保存',content:'启动准备期间仍能保存',status:'captured'}}});assert.equal(f.store.read(receipt.objectId).data.content,'启动准备期间仍能保存');assert.equal(completed,false);
  }finally{release();}
  const [run,state]=await Promise.all([pending,later]);assert.equal(run.revision,5);assert.equal(state.revision,6);assert.equal(state.status.afterLaunch,true);exited(f.store);
});
