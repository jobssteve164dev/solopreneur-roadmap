const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');
const {describeAgentRunIntent}=require('../out/agentRunPreparation.js');
const {createInteractionBudget}=require('../out/interactionBudget.js');

test('real readonly Agent preparation derives original admission and complete fixed-policy ready inputs without publishing intermediate objects',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-agent-preparation-plan-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store),project=await store.registerProject({root});t.after(async()=>{await operations.close();store.close();});
  for(;;){const batch=store.prepareStorageReferenceBatch(128);store.commitStorageReferenceBatch(batch);if(!batch.pending)break;}store.beginContentPreparationRecovery();store.activateStorageContentLifecycle({strictPublication:true});
  const input={agentCli:'claude',selectedModel:'fixture-model',prompt:'完整原始启动任务'.repeat(9000),globalPrompt:'完整本轮固定全局要求'.repeat(9000),workspaceRoot:root,nodeId:'__solo__',executionLogId:1,userMessage:'完整原始用户目标'.repeat(9000),runKind:'solo',globalDataPath:store.root,taskPermissionMode:'auto',interactionBudget:createInteractionBudget(),deliveryOwner:{id:'original-window',pid:process.pid,birth:''},metadata:{retained:'完整保留元数据'.repeat(9000)}};
  const expectedIntent=describeAgentRunIntent(input),identity={...store.dataWriteDatabaseIdentity(),projectId:project.projectId,actorId:store.actorId},count=()=>store.rows('SELECT (SELECT COUNT(*) FROM objects) AS objects,(SELECT COUNT(*) FROM requests) AS requests,(SELECT COUNT(*) FROM events) AS events')[0],before=count();
  const put=store.putContent,read=store.content,createHash=crypto.createHash;
  store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded a large Agent preparation body');return put.call(this,value,...args);};
  store.content=function(id){if(Number(store.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded a large Agent preparation body');return read.call(this,id);};
  crypto.createHash=(...args)=>{const hash=createHash(...args),update=hash.update;hash.update=function(value,...options){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source hashed a large Agent preparation body');return update.call(this,value,...options);};return hash;};
  let selected,admitted,readyInput;
  try{
    selected=await store.agentLaunchCompute.select({...identity,input,preflight:{}});assert.deepEqual(count(),before);assert.equal(selected.intentHash,expectedIntent.intentHash);assert.equal(selected.creation.metadata.retained,input.metadata.retained);assert.deepEqual(selected.creation.launchRequest,input);
    const step=store.agentLaunchCompute.step;store.agentLaunchCompute.step=async request=>{const value=await step(request);if(request.phase==='ready')readyInput=value.ready;return value;};
    admitted=await store.publishRunCreation(project.projectId,project.locationId,selected.creation,publish=>publish(),undefined,async(request,prepared,publication)=>{
      const graph=await store.stageAgentLaunchGraph({...identity,input:selected.input,prepareKey:selected.prepareKey,preflight:{},base:store.projectedRunCreation(publication),projectedTurn:publication.nodes.get('turn').commit.plan.projectedObject,projectedPolicy:publication.nodes.get('policy').commit.plan.projectedObject});
      assert.equal(store.rows('SELECT COUNT(*) AS n FROM run_control')[0].n,0);return graph;
    });
  }finally{store.putContent=put;store.content=read;crypto.createHash=createHash;}
  const current=store.readRunState(project.projectId,1),execution=store.readRunExecutionPlan(project.projectId,1);
  assert.equal(admitted.revision,5);assert.equal(admitted.receipt.revision,5);assert.equal(admitted.proof,undefined);assert.equal(admitted.dataRoot,store.root);assert.match(admitted.finalCommand,/runAgentProcess/);assert.equal(current.revision,5);assert.equal(current.status.status,'Running');assert.equal(current.status.retained,input.metadata.retained);assert.equal(current.status.launchIntentHash,expectedIntent.intentHash);
  assert.equal(store.readRunBinding(project.projectId,1).headRevision,2);assert.equal(execution.prompt,readyInput.prompt);assert.ok(execution.prompt.includes(input.prompt));assert.ok(execution.prompt.includes(input.globalPrompt));assert.ok(execution.prompt.includes(`turnId:"${current.turnId}"`));assert.ok(execution.prompt.includes('）：\n'+input.globalPrompt+'\n'));
  assert.equal(Buffer.from(store.readRunDocument(project.projectId,1,'launch_request').bytes,'base64').toString(),JSON.stringify(input));
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});
