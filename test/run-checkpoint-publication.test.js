const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

async function fixture(t,metadata,mode){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-checkpoint-publication-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  const message='本轮完整用户目标🌿\n'.repeat(12000),run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'step',runKind:'step',prompt:'原任务',command:'',userMessage:message,...(metadata?{metadata}:{}),idempotencyKey:'checkpoint-original-run'}});
  return{store,operations,run,root,message,checkpoint:input=>Promise.resolve().then(()=>mode==='direct'?store.checkpointRun(run.projectId,input):operations({operation:'checkpoint_run',input}))};
}
function guardSource(store){
  const read=store.content,put=store.putContent,hash=crypto.createHash,stringify=JSON.stringify,parse=JSON.parse;
  store.content=function(id){if(Number(store.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded a large checkpoint body');return read.call(this,id);};
  store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded a large checkpoint body');return put.call(this,value,...args);};
  crypto.createHash=(...args)=>{const value=hash(...args),update=value.update;value.update=function(bytes,...options){if((typeof bytes==='string'?Buffer.byteLength(bytes):bytes.byteLength)>65536)throw Error('Source hashed a large checkpoint body');return update.call(this,bytes,...options);};return value;};
  JSON.stringify=function(value,...args){let bytes=0;const pending=[value],seen=new Set();while(pending.length){const item=pending.pop();if(typeof item==='string')bytes+=Buffer.byteLength(item);else if(item && typeof item==='object' && !seen.has(item)){seen.add(item);pending.push(...Object.values(item));}if(bytes>65536)throw Error('Source serialized a large checkpoint body');}return stringify.call(this,value,...args);};
  JSON.parse=function(value,...args){if(typeof value==='string' && Buffer.byteLength(value)>65536)throw Error('Source parsed a large checkpoint body');return parse.call(this,value,...args);};
  return()=>{store.content=read;store.putContent=put;crypto.createHash=hash;JSON.stringify=stringify;JSON.parse=parse;};
}
for(const mode of ['runtime','direct'])test(mode+': actual checkpoint start prepares complete metadata and journal outside Source and retries without WAL changes',async t=>{
  const f=await fixture(t,undefined,mode),input={projectId:f.run.projectId,executionLogId:1,generation:1,proof:f.run.proof,expectedRevision:f.run.revision,expectedTurnId:f.run.turnId,action:'start',foregroundStart:true,idempotencyKey:'actual-checkpoint-start'},restore=guardSource(f.store);let first;
  try{first=await f.checkpoint(input);}finally{restore();}
  assert.equal(first.status.userMessage,f.message);assert.equal(first.status.checkpointSequence,1);assert.equal(first.turnId,f.run.turnId);assert.equal(f.store.readRunTurnJournal(f.run.projectId,1).entry.status,'Running');
  const wal=()=>{const bytes=fs.readFileSync(f.store.filePath+'-wal');return{length:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};},before=wal(),restoreRetry=guardSource(f.store);let retry;
  try{retry=await f.checkpoint(input);}finally{restoreRetry();}
  assert.deepEqual(retry,first);assert.deepEqual(wal(),before);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

for(const mode of ['runtime','direct'])test(mode+': actual completion publishes its full invalid report, turn, workspace documents and journal in one transaction',async t=>{
  const f=await fixture(t,undefined,mode),summary='保留完整完成总结🌿\n'.repeat(12000),report={schemaVersion:1,summary:'原任务结果',unmetRequirements:[],decisions:[],corrections:[],verification:[],commits:[],experienceUsage:[],lessons:[],raw:'完整报告原文'.repeat(12000)},input={projectId:f.run.projectId,executionLogId:1,generation:1,proof:f.run.proof,expectedRevision:f.run.revision,expectedTurnId:f.run.turnId,action:'complete',outcome:'partial',summary,report,workspaceSnapshot:{},idempotencyKey:'actual-checkpoint-complete'},restore=guardSource(f.store);let completed;
  try{completed=await f.checkpoint(input);}finally{restore();}
  assert.equal(completed.status.userMessage,f.message);assert.equal(completed.status.checkpointSummary,summary);assert.equal(completed.status.checkpointSequence,1);assert.equal(completed.status.taskReportStatus,mode==='direct'?'missing':'invalid');
  assert.deepEqual(JSON.parse(f.store.read(completed.status.taskReportObjectId).data.content),report);assert.equal(f.store.read(f.run.turnId).data.summary_content,summary);assert.ok(f.store.readRunTurnJournal(f.run.projectId,1).entry.output.includes(summary));
  assert.ok(f.store.readMetadata(completed.status.workspaceAfterObjectId));assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM run_consumer_sources WHERE run_id=?',[f.run.runId])[0].n,1);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

test('the frozen Native direct checkpoint preserves the caller report availability without Runtime normalization',async t=>{
  const f=await fixture(t),summary='保留完整完成总结🌿\n'.repeat(12000),report={schemaVersion:1,summary:'原任务结果',unmetRequirements:[],decisions:[],corrections:[],verification:[],commits:[],experienceUsage:[],lessons:[],raw:'完整报告原文'.repeat(12000)},input={projectId:f.run.projectId,executionLogId:1,generation:1,proof:f.run.proof,expectedRevision:f.run.revision,expectedTurnId:f.run.turnId,action:'complete',outcome:'partial',summary,report,workspaceSnapshot:{},idempotencyKey:'actual-checkpoint-complete'},restore=()=>{};let completed;
  try{completed=require('./fixtures/native-run-producer-oracles.cjs').checkpointRunNative(f.store,f.run.projectId,input);}finally{restore();}
  assert.equal(completed.status.userMessage,f.message);assert.equal(completed.status.checkpointSummary,summary);assert.equal(completed.status.checkpointSequence,1);assert.equal(completed.status.taskReportStatus,'missing');
  assert.deepEqual(JSON.parse(f.store.read(completed.status.taskReportObjectId).data.content),report);assert.equal(f.store.read(f.run.turnId).data.summary_content,summary);assert.ok(f.store.readRunTurnJournal(f.run.projectId,1).entry.output.includes(summary));
  assert.ok(f.store.readMetadata(completed.status.workspaceAfterObjectId));assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM run_consumer_sources WHERE run_id=?',[f.run.runId])[0].n,1);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

test('a new checkpoint turn retains the actual staged journal and completes after the acknowledged initial turn',async t=>{
  const f=await fixture(t),base={projectId:f.run.projectId,executionLogId:1,generation:1,proof:f.run.proof},first=await f.operations({operation:'checkpoint_run',input:{...base,action:'complete',outcome:'partial',summary:'第一轮完成',expectedRevision:1,expectedTurnId:f.run.turnId,idempotencyKey:'first-completed-turn'}});
  const message='新轮次完整原文🌿\n'.repeat(12000),restore=guardSource(f.store);let started;
  try{started=await f.operations({operation:'checkpoint_run',input:{...base,action:'start',message,foregroundStart:true,expectedRevision:first.revision,expectedTurnId:first.turnId,idempotencyKey:'second-turn-start'}});}finally{restore();}
  assert.notEqual(started.turnId,first.turnId);assert.equal(started.status.userMessage,message);assert.equal(f.store.read(started.turnId).data.request_content,message);assert.ok(f.store.readRunTurnJournal(f.run.projectId,1,started.turnId).entry.output.includes(message));
  const completed=await f.operations({operation:'checkpoint_run',input:{...base,action:'complete',outcome:'partial',summary:'新轮次完成',expectedRevision:started.revision,expectedTurnId:started.turnId,idempotencyKey:'second-turn-complete'}});assert.equal(completed.turnId,started.turnId);assert.equal(completed.status.checkpointSequence,3);
});

test('implicit completion retains both real journal source versions and the new turn patch',async t=>{
  const f=await fixture(t),base={projectId:f.run.projectId,executionLogId:1,generation:1,proof:f.run.proof},first=await f.operations({operation:'checkpoint_run',input:{...base,action:'complete',outcome:'partial',summary:'已保存上一轮',expectedRevision:1,expectedTurnId:f.run.turnId,idempotencyKey:'implicit-first-complete'}}),waiting=await f.operations({operation:'patch_run_state',input:{projectId:f.run.projectId,executionLogId:1,generation:1,expectedRevision:first.revision,patch:{status:'Waiting'},idempotencyKey:'implicit-waiting'}});
  const summary='隐式新轮次完整总结🌿\n'.repeat(12000),restore=guardSource(f.store);let completed;
  try{completed=await f.operations({operation:'checkpoint_run',input:{...base,action:'complete',outcome:'partial',summary,expectedRevision:waiting.revision,expectedTurnId:waiting.turnId,idempotencyKey:'implicit-new-complete'}});}finally{restore();}
  assert.notEqual(completed.turnId,first.turnId);assert.equal(completed.status.checkpointImplicitTurn,true);assert.equal(f.store.read(completed.turnId).data.summary_content,summary);assert.equal(f.store.readMetadata(completed.turnId).revision,2);
  const journal=f.store.readRunTurnJournal(f.run.projectId,1,completed.turnId),source=f.store.rows('SELECT object_id FROM project_journal_sources WHERE project_id=? AND execution_log_id=?',[f.run.projectId,journal.executionLogId])[0].object_id;
  assert.equal(f.store.readMetadata(source).revision,2);assert.ok(journal.entry.output.includes(summary));assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

test('actual current-run MCP opens and completes with the original large payload outside Source',async t=>{
  const f=await fixture(t),identity={executionLogId:1,generation:1,proof:f.run.proof},restore=guardSource(f.store);let completed;
  try{
    const session=await f.operations({operation:'open_mcp_session',input:{projectId:f.run.projectId,runIdentity:identity,openRequestId:'checkpoint-mcp-large-original'}});
    completed=await f.operations({operation:'checkpoint_current_run',sessionToken:session.sessionToken,input:{action:'complete',outcome:'partial',summary:f.message,report:null}});
  }finally{restore();}
  assert.equal(completed.status.checkpointSummary,f.message);assert.equal(completed.status.userMessage,f.message);assert.equal(completed.status.taskReportStatus,'invalid');assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

test('checkpoint qualification never reads the unbounded existing journal command in Source',async t=>{
  const f=await fixture(t),journal=f.store.readRunTurnJournal(f.run.projectId,1),command='原始长命令🌿'.repeat(15000);f.store.updateProjectJournal(f.run.projectId,journal.executionLogId,{...journal.entry,command});
  const rows=f.store.rows;f.store.rows=function(...args){const result=rows.apply(this,args);for(const row of result)for(const value of Object.values(row))if(typeof value==='string' && Buffer.byteLength(value)>65536)throw Error('Source read unbounded journal TEXT');return result;};
  try{await f.operations({operation:'checkpoint_run',input:{projectId:f.run.projectId,executionLogId:1,generation:1,proof:f.run.proof,expectedRevision:1,expectedTurnId:f.run.turnId,action:'start',foregroundStart:true,idempotencyKey:'checkpoint-large-command'}});}finally{f.store.rows=rows;}
  assert.equal(f.store.readRunTurnJournal(f.run.projectId,1).entry.command,command);
});

test('post-commit journal proof cleanup failure preserves the accepted result and exits through the original Cold quantum',async t=>{
  const f=await fixture(t),run=f.store.db.run;let injected=false;f.store.db.run=function(sql,...args){if(!injected && /^DELETE FROM temp\.solomap_checkpoint_log_watches/.test(sql) && f.store.readMetadata(f.run.runId).revision===2){injected=true;throw Error('fixture_checkpoint_release_after_commit');}return run.call(this,sql,...args);};
  let result;try{result=await f.operations({operation:'checkpoint_run',input:{projectId:f.run.projectId,executionLogId:1,generation:1,proof:f.run.proof,expectedRevision:1,expectedTurnId:f.run.turnId,action:'start',foregroundStart:true,idempotencyKey:'checkpoint-cleanup-accepted'}});}finally{f.store.db.run=run;}
  assert.equal(injected,true);assert.equal(result.revision,2);assert.equal(f.store.readRunState(f.run.projectId,1).revision,2);await f.store.maintainStorageColdQuantum(1);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM temp.solomap_checkpoint_journal_watches')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM temp.solomap_checkpoint_log_watches')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

test('an acknowledged current-run start ignores unused report input and reuses the Compute serialization',async t=>{
  const f=await fixture(t),session=await f.operations({operation:'open_mcp_session',input:{projectId:f.run.projectId,runIdentity:{executionLogId:1,generation:1,proof:f.run.proof}}}),started=await f.operations({operation:'checkpoint_current_run',sessionToken:session.sessionToken,input:{action:'start'}}),unused={};unused.self=unused;
  const restore=guardSource(f.store);let replay;try{replay=await f.operations({operation:'checkpoint_current_run',sessionToken:session.sessionToken,input:{action:'start',report:unused}});}finally{restore();}
  assert.equal(replay.revision,started.revision);assert.equal(replay.status.userMessage,f.message);assert.equal(require('../out/db/runInputsPublication.js').runInputsSerializedResult(replay),JSON.stringify(replay));
});

test('the actual native observer publishes a complete large reply without Source state or JSON codecs',async t=>{
  const f=await fixture(t,{interactiveSession:true,sessionProvider:'codex'}),nonce=crypto.randomBytes(32).toString('hex'),sessionId=crypto.randomUUID(),transcript=path.join(f.root,'native.jsonl'),scope={projectId:f.run.projectId,executionLogId:1,generation:1};
  const seed=await f.operations({operation:'write_run_binding',input:{...scope,expectedHeadRevision:0,seed:{runId:'1',provider:'codex',workspaceRoot:f.root,cliPath:'codex',bindingNonce:nonce,method:'transcript_correlated_compat',contract:'compatibility',createdAt:f.run.status.startedAt},idempotencyKey:'observer-large-seed'}}),planned=await f.operations({operation:'write_run_binding',input:{...scope,expectedHeadRevision:seed.headRevision,revision:{sessionId,method:'transcript_correlated_compat',contract:'compatibility',state:'planned'},idempotencyKey:'observer-large-planned'}});
  await f.operations({operation:'write_run_binding',input:{...scope,expectedHeadRevision:planned.headRevision,confirmSessionId:sessionId,evidence:{source:'confirmed_resume_target',transcriptPath:transcript},idempotencyKey:'observer-large-confirmed'}});
  const latest=f.store.readRunCheckpointState(f.run.projectId,1),claimed=await f.operations({operation:'claim_run',input:{projectId:f.run.projectId,executionLogId:1,expectedRevision:latest.revision,agentPid:process.pid,idempotencyKey:'observer-large-live-owner'}}),timestamp=new Date(Date.parse(f.run.status.startedAt)+1).toISOString(),reply='完整原生回复🌿\n'.repeat(12000);
  const rows=[{type:'session_meta',timestamp,payload:{id:sessionId,cwd:f.root,timestamp}},{type:'event_msg',timestamp,payload:{type:'task_started',turn_id:'actual-large-native-turn',started_at:timestamp}},{type:'event_msg',timestamp,payload:{type:'task_complete',turn_id:'actual-large-native-turn',started_at:timestamp,completed_at:timestamp,last_agent_message:reply}}];fs.writeFileSync(transcript,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const observed=f.store.readRunCheckpointState(f.run.projectId,1),restore=guardSource(f.store);try{await new (require('../out/runNativeObserver.js').RunNativeObserver)(f.store).observe(observed);}finally{restore();}
  const result=f.store.readRunState(f.run.projectId,1),sha=value=>crypto.createHash('sha256').update(String(value || '')).digest('hex');assert.equal(result.generation,claimed.generation);assert.equal(sha(result.status.checkpointSummary),sha(reply));assert.notEqual(result.status.nativeOutputPending,true);assert.equal(sha(f.store.read(result.turnId).data.summary_content),sha(reply));assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.runObserverParserTokens.size,0);assert.equal(f.store.retiredRunObserverParserTokens.size,0);
});

test('persistent native parser release failure reaches the original Cold error backoff and preserves its retirement responsibility',async t=>{
  const f=await fixture(t),stream='native:codex',bytes=Buffer.from('{"pending":"unclosed native row');await f.store.publishRunLog(f.run.projectId,{executionLogId:1,generation:1,stream,sequence:0,offset:0,bytes:bytes.toString('base64'),idempotencyKey:'parser-retirement-source'});
  const page=await f.store.prepareRunNativeRowsPublication({projectId:f.run.projectId,executionLogId:1,stream,end:bytes.length,state:{offset:0,cursor:0,length:0}}),release=f.store.runObserverCompute.release;f.store.runObserverCompute.release=async()=>{throw Error('fixture_parser_retirement_io');};
  try{await f.store.releaseRunNativeRowsPublication([page.state.token]);assert.equal(f.store.retiredRunObserverParserTokens.size,1);await assert.rejects(f.store.maintainStorageColdQuantum(1),/fixture_parser_retirement_io/);}finally{f.store.runObserverCompute.release=release;await f.store.maintainStorageColdQuantum(1);}
  assert.equal(f.store.retiredRunObserverParserTokens.size,0);assert.equal(f.store.runObserverParserTokens.size,0);assert.equal((await release({...f.store.dataWriteDatabaseIdentity(),tokens:[]})).remaining,0);
});
