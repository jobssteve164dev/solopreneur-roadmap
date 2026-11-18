const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');
const {externalRefreshNative}=require('./fixtures/native-daily-state-oracles.cjs');

async function fixture(t,pauseAt=1,kind){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-content-runtime-fence-')),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  const store=new UnifiedDataStore(path.join(base,'global')),ops=createRuntimeDataOperations(store),project=await store.registerProject({root:projectRoot});
  const run=await store.prepareRun(project.projectId,project.locationId,{root:projectRoot,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'original',command:'fixture',userMessage:'original',idempotencyKey:'fence-fixture-run'});
  t.after(async()=>{await ops.close();store.close();});
  const owner=store.claimPiExecutionOwner('content-original-owner');
  const operation=store.admitPiConversationOperation({schemaVersion:1,conversationId:'816381ea-9418-4edc-bbcd-ec8d9979b152',operationId:'content-fence-operation',requestKey:'content-fence-operation',prompt:'fixture',attachments:[],baselineRevision:0,source:'sidebar',sourceGeneration:1,projectScope:'',systemPrompt:'fixture',projectContext:{selectedProject:'',projects:[]},model:{provider:'agent-cli',modelId:'auto'},tools:[],executionProfile:'pi-core-0.87.1-v1',options:{retry:'native',compaction:'native',toolExecution:'sequential'}},owner);
  store.admitPiToolInvocation(operation.operationId,owner,{invocationId:'content-call',toolName:'solomap_write',arguments:{},replay:'never'});
  const fence={operationId:operation.operationId,invocationId:'content-call',ownerId:owner.ownerId,ownerGeneration:owner.generation};
  let entered,release,prepares=0;
  const entering=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});t.after(release);
  const pause=async prepared=>{if(++prepares===pauseAt){entered();await gate;}return prepared;};
  if(kind==='state'){
    const prepare=store.stateWriteCompute;
    store.setStateWriteCompute(async input=>pause(await prepare(input)));
  }else if(kind==='log'){
    const prepare=store.runLogCompute;
    store.setRunLogCompute(async input=>pause(await prepare(input)));
  }else if(kind==='document'){
    const compute=store.runDocumentCompute;
    store.setRunDocumentCompute({...compute,prepare:async input=>pause(await compute.prepare(input))});
  }else{
    const prepare=store.contentPreparationCompute;
    store.setContentPreparationCompute(async input=>pause(await prepare(input)));
  }
  return {store,ops,project,projectRoot,run,fence,entering,release};
}

for(const kind of ['log','document','artifact'])test(`a prepared runtime ${kind} cannot publish business data after its Pi invocation owner changes`,async t=>{
  const f=await fixture(t,1,kind),bytes=crypto.randomBytes(131073),key=`runtime-fenced-${kind}`;
  const input=kind==='log'?{projectId:f.project.projectId,executionLogId:1,generation:f.run.generation,stream:'stdout',sequence:0,offset:0,bytes:bytes.toString('base64'),idempotencyKey:key}
    :kind==='document'?{projectId:f.project.projectId,executionLogId:1,generation:f.run.generation,purpose:'task_notes',bytes:bytes.toString('base64'),mimeType:'application/octet-stream',expectedRevision:0,idempotencyKey:key}
    :{root:f.projectRoot,executionLogId:1,relativePath:'__solo__/1/prompt.txt',bytes:bytes.toString('base64'),hash:crypto.createHash('sha256').update(bytes).digest('hex'),mimeType:'text/plain'};
  const operation=kind==='log'?'append_run_log':kind==='document'?'write_run_document':'write_run_artifact';
  const pending=f.ops({operation,piToolFence:f.fence,input});void pending.catch(()=>{});
  try{
    await Promise.race([f.entering,pending.then(()=>{throw Error('fixture_operation_completed_without_entering_preparation_gate');})]);f.store.claimPiExecutionOwner('content-replacement-owner');f.release();
    await assert.rejects(pending,/pi_owner_fenced|pi_tool_invocation_fenced/);
    if(kind==='artifact')assert.equal(Boolean(f.store.readRunArtifact(f.project.projectId,1,input.relativePath)),false,'a rejected stale owner must leave no artifact');
    else assert.equal(f.store.rows('SELECT 1 FROM requests WHERE idempotency_key=?',[key]).length,0,'a rejected stale owner must leave no committed request');
  }finally{f.release();await Promise.allSettled([pending]);}
});

test('the migration-source half of a runtime artifact operation rechecks the same Pi fence after its own preparation',async t=>{
  const f=await fixture(t,2),bytes=crypto.randomBytes(131073),relativePath='__solo__/1/prompt.txt';
  const input={root:f.projectRoot,executionLogId:1,relativePath,sourceKey:relativePath,bytes:bytes.toString('base64'),hash:crypto.createHash('sha256').update(bytes).digest('hex'),mimeType:'text/plain'};
  const pending=f.ops({operation:'write_run_artifact',piToolFence:f.fence,input});void pending.catch(()=>{});
  try{
    await f.entering;assert.ok(f.store.readRunArtifact(f.project.projectId,1,relativePath),'the first business step completed under its valid owner');
    f.store.claimPiExecutionOwner('content-replacement-owner');f.release();
    await assert.rejects(pending,/pi_owner_fenced|pi_tool_invocation_fenced/);
    assert.equal(f.store.rows('SELECT 1 FROM migration_items WHERE source_identity=? AND source_key=?',[`agent-runs:${f.projectRoot}`,relativePath]).length,0,'the later step cannot commit after its original owner is revoked');
    assert.ok(f.store.readRunArtifact(f.project.projectId,1,relativePath),'rejecting the later step must not roll back earlier authorized data');
  }finally{f.release();await Promise.allSettled([pending]);}
});

for(const type of ['analysis','strategy'])test(`a prepared runtime ${type} state cannot publish after its Pi invocation owner changes`,async t=>{
  const f=await fixture(t,1,'state'),idempotencyKey=`state-fenced-${type}`,operation=type==='analysis'?'write_analysis_state':'write_strategy_state',input={root:f.projectRoot,expectedRevision:0,value:{original:'完整状态🌿'.repeat(18000)},idempotencyKey,...(type==='analysis'?{namespace:'external',key:'issues'}:{})},pending=f.ops({operation,piToolFence:f.fence,input});void pending.catch(()=>{});
  try{
    await Promise.race([f.entering,pending.then(()=>{throw Error('fixture_state_completed_without_preparation_gate');})]);f.store.claimPiExecutionOwner('state-replacement-owner');f.release();await assert.rejects(pending,/pi_owner_fenced|pi_tool_invocation_fenced/);
    const state=type==='analysis'?f.store.readAnalysisState(f.project.projectId,'external','issues'):f.store.readStrategyState(f.project.projectId);assert.equal(state.objectId,null);const key=type==='analysis'?`analysis-state:${f.project.projectId}:external:issues:${idempotencyKey}`:`strategy-state:${f.project.projectId}:${idempotencyKey}`;assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM requests WHERE idempotency_key=?',[key])[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
  }finally{f.release();await Promise.allSettled([pending]);}
});

for(const kind of ['reserve','accept','reject'])test(`a prepared runtime external ${kind} rechecks its final Pi owner before completing`,async t=>{
  const f=await fixture(t,1,'state'),token=kind==='reserve'?undefined:externalRefreshNative(f.store,'reserve',f.project.projectId,'issues','original'),operation=kind==='reserve'?'reserve_external_refresh':'commit_external_refresh',input=kind==='reserve'?{root:f.projectRoot,key:'issues',requestId:'reserved'}:{root:f.projectRoot,key:'issues',requestId:kind==='accept'?'original':'superseded',generation:token.generation,requestedAt:1,cache:{payload:'完整受保护外部缓存🌿'.repeat(16000)}},pending=f.ops({operation,piToolFence:f.fence,input});void pending.catch(()=>{});
  try{
    await Promise.race([f.entering,pending.then(()=>{throw Error('fixture_external_completed_without_preparation_gate');})]);f.store.claimPiExecutionOwner('external-replacement-owner');f.release();await assert.rejects(pending,/pi_owner_fenced|pi_tool_invocation_fenced/);assert.equal(f.store.readAnalysisState(f.project.projectId,'external','issues').objectId,null);if(kind==='reserve')assert.equal(f.store.readAnalysisState(f.project.projectId,'external-refresh','issues').objectId,null);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
  }finally{f.release();await Promise.allSettled([pending]);}
});
