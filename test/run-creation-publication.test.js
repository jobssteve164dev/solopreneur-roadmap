const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');
const {canonicalJson}=require('../out/contentReferences.js');
const {runInputsSerializedResult}=require('../out/db/runInputsPublication.js');

async function fixture(t,mode){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-run-creation-publication-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store),project=await store.registerProject({root});
  t.after(async()=>{await operations.close();store.close();});
  for(;;){const batch=store.prepareStorageReferenceBatch(128);store.commitStorageReferenceBatch(batch);if(!batch.pending)break;}
  store.beginContentPreparationRecovery();store.activateStorageContentLifecycle({strictPublication:true});
  const call=changes=>{const input={root,executionLogId:1,nodeId:'step',runKind:'step',prompt:'prompt',command:'command',userMessage:'request',idempotencyKey:'prepared-run-creation',...changes};return Promise.resolve().then(()=>mode==='direct'?store.prepareRun(project.projectId,project.locationId,input):operations({operation:'prepare_run',input}));};
  return{base,root,store,operations,project,call};
}
function forbidLargeSourceWork(store){
  const put=store.putContent,read=store.content,createHash=crypto.createHash;
  store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded a large creation body');return put.call(this,value,...args);};
  store.content=function(id){if(Number(store.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded a large creation body');return read.call(this,id);};
  crypto.createHash=(...args)=>{const hash=createHash(...args),update=hash.update;hash.update=function(value,...options){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source hashed a large creation body');return update.call(this,value,...options);};return hash;};
  return()=>{store.putContent=put;store.content=read;crypto.createHash=createHash;};
}

for(const mode of ['runtime','direct'])test(mode+': the actual prepare_run entry prepares full request, metadata, backup, launch document, journal and history outside Source',async t=>{
  const f=await fixture(t,mode),prompt='完整运行提示词'.repeat(12000),userMessage='用户完整原始请求'.repeat(10000),metadata={retained:'完整元数据'.repeat(18000)},backup=Buffer.from('id,title\n1,完整路线图\n'.repeat(7000));
  const launchRequest={prompt,userMessage,interactionBudget:{interactionId:'original-launch-budget'},executionLogId:1},input={prompt,userMessage,metadata,roadmapBackup:backup.toString('base64'),launchRequest};
  const restore=forbidLargeSourceWork(f.store);let state;
  try{state=await f.call(input);}finally{restore();}
  assert.equal(state.status.userMessage,userMessage);assert.equal(state.status.retained,metadata.retained);
  assert.equal(f.store.read(state.runId,1).data.prompt_content,prompt);
  assert.equal(f.store.read(state.taskId,1).data.original_request_content,userMessage);
  assert.equal(f.store.read(state.turnId,1).data.request_content,userMessage);
  assert.equal(f.store.read(state.conversationId,1).data.title,userMessage);
  assert.deepEqual(Buffer.from(f.store.readRunDocument(state.projectId,1,'roadmap_backup').bytes,'base64'),backup);
  assert.equal(Buffer.from(f.store.readRunDocument(state.projectId,1,'launch_request').bytes,'base64').toString(),JSON.stringify(launchRequest));
  assert.equal(f.store.readProjectJournal(state.projectId,{executionLogId:1}).logs[0].output.startsWith(userMessage),true);
  assert.equal(f.store.rows('SELECT input_hash FROM requests WHERE id=?',[state.receipt.requestId])[0].input_hash,crypto.createHash('sha256').update(canonicalJson({operation:'prepare_run',projectId:f.project.projectId,locationId:f.project.locationId,input:{root:f.root,executionLogId:1,nodeId:'step',runKind:'step',prompt,command:'command',userMessage,idempotencyKey:'prepared-run-creation',...input}})).digest('hex'));
  assert.deepEqual(JSON.parse(runInputsSerializedResult(state)),state);
  const wal=()=>{const bytes=fs.readFileSync(f.store.filePath+'-wal');return{length:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};},beforeWal=wal(),before=f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n;
  assert.deepEqual(await f.call(input),state);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n,before);
  assert.deepEqual(wal(),beforeWal,'replaying the accepted creation must not persist another preparation owner or pins');
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

function pausePreparation(t,store,method='prepare'){
  const compute=store.runCreationCompute,original=compute[method];let enter,release,calls=0;
  const entering=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});t.after(release);
  compute[method]=async request=>{const result=await original(request);calls++;if(calls===1){enter();await gate;}return result;};
  return{entering,release,get calls(){return calls;}};
}

test('real read-only creation preparation leaves the Source transaction free for an independent write',async t=>{
  const f=await fixture(t),gate=pausePreparation(t,f.store),pending=f.call({prompt:'完整准备期间继续工作'.repeat(16000)});void pending.catch(()=>{});
  await gate.entering;
  try{
    assert.equal(f.store.db.inTransaction,false);
    const receipt=await f.operations({operation:'write',input:{action:'create',kind:'memory',scope:null,idempotencyKey:'during-real-run-preparation',data:{category:'active',title:'foreground work',content:'independent foreground result',status:'active'}}});
    assert.equal(f.store.read(receipt.objectId).data.content,'independent foreground result');
    assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM runs')[0].n,0);
  }finally{gate.release();}
  assert.equal((await pending).revision,1);
});

test('failure in the final run event rolls back every prepared child, document and journal business row',async t=>{
  const f=await fixture(t),tables=['objects','object_revisions','events','requests','runs','run_control','run_control_revisions','conversations','tasks','turns','project_journal_entries','project_journal_sources','run_turn_journals','run_documents'],counts=()=>Object.fromEntries(tables.map(table=>[table,f.store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n])),before=counts();
  f.store.db.run("CREATE TEMP TRIGGER reject_final_run_creation BEFORE INSERT ON events WHEN NEW.kind='run.prepare' BEGIN SELECT RAISE(ABORT,'fixture_final_run_creation_failure'); END");
  await assert.rejects(f.call({prompt:'原子失败完整正文'.repeat(15000),roadmapBackup:Buffer.from('backup').toString('base64'),launchRequest:{complete:'original launch request'}}),/fixture_final_run_creation_failure/);
  assert.deepEqual(counts(),before);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
  f.store.db.run('DROP TRIGGER reject_final_run_creation');
  assert.equal((await f.call({prompt:'same accepted key after rollback'})).revision,1);
});

test('creation replay preserves the original fixed control and result after later input updates',async t=>{
  const f=await fixture(t),input={prompt:'original complete run prompt'.repeat(5000),metadata:{context:'original metadata'.repeat(8000)}},first=await f.call(input);
  await f.operations({operation:'patch_run_inputs',input:{projectId:f.project.projectId,executionLogId:1,generation:1,expectedRevision:1,prompt:'later prompt',status:'Waiting',idempotencyKey:'after-run-creation'}});
  const replay=await f.call(input);assert.deepEqual(replay,first);assert.deepEqual(JSON.parse(runInputsSerializedResult(replay)),first);
  await assert.rejects(f.call({...input,prompt:'different original intent'}),/idempotency_conflict/);
});

test('creation replay requalifies an actual unversioned journal mapping without persistent preparation writes',async t=>{
  const f=await fixture(t),input={metadata:{retained:'完整历史资料🌿'.repeat(9000)}},first=await f.call(input),compute=f.store.runCreationCompute,prepare=compute.prepare;
  const wal=()=>{const bytes=fs.readFileSync(f.store.filePath+'-wal');return{length:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};};
  let changed=false,mapped,before;
  compute.prepare=async request=>{
    const result=await prepare(request);
    if(result.replay && !changed){
      changed=true;
      f.store.transaction(()=>{
        mapped=f.store.appendProjectJournal(first.projectId,'actual-migrated-journal',{nodeId:'step',timestamp:new Date().toISOString(),agentCli:'',command:'',output:'实际恢复的执行记录',status:'Running'}).executionLogId;
        f.store.db.run('UPDATE run_turn_journals SET execution_log_id=? WHERE project_id=? AND run_id=? AND turn_id=?',[mapped,first.projectId,first.runId,first.turnId]);
      });
      before=wal();
    }
    return result;
  };
  const replay=await f.call(input);
  assert.equal(changed,true);assert.notEqual(mapped,first.status.journalExecutionLogId);assert.equal(replay.status.journalExecutionLogId,mapped);
  assert.deepEqual(replay.receipt,first.receipt);assert.equal(replay.status.retained,input.metadata.retained);assert.deepEqual(wal(),before);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('creation replay reselects when actual content changes during proof construction',async t=>{
  const f=await fixture(t),input={metadata:{retained:'完整历史资料🌿'.repeat(9000)}},first=await f.call(input),verify=f.store.contentVerificationCompute;
  const wal=()=>{const bytes=fs.readFileSync(f.store.filePath+'-wal');return{length:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};};
  let changed=false,before;
  f.store.contentVerificationCompute=async request=>{
    const result=await verify(request);
    if(!changed){changed=true;f.store.db.run('UPDATE contents SET data=data WHERE id=?',[request.contentId]);assert.equal(f.store.rows('SELECT changes() AS n')[0].n,1);before=wal();}
    return result;
  };
  try{assert.deepEqual(await f.call(input),first);}finally{f.store.contentVerificationCompute=verify;}
  assert.equal(changed,true);assert.deepEqual(wal(),before);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('a policy created after the read-only blueprint invalidates bootstrap and is fixed in the final run',async t=>{
  const f=await fixture(t),gate=pausePreparation(t,f.store),pending=f.call({prompt:'正文保持完整'.repeat(12000),globalPrompt:'bootstrap policy which must not win'});void pending.catch(()=>{});
  await gate.entering;let policy;
  try{policy=await f.operations({operation:'write',input:{kind:'policy',action:'create',scope:null,idempotencyKey:'policy-created-during-preparation',data:{kind:'global_prompt',status:'active',content:'current independently committed policy'}}});}
  finally{gate.release();}
  const result=await pending;assert.deepEqual(result.status.globalPromptPolicyRef,{objectId:policy.objectId,revision:policy.revision});assert.ok(gate.calls>=2);
  assert.equal(f.store.rows("SELECT COUNT(*) AS n FROM policies WHERE kind='global_prompt' AND status='active'")[0].n,1);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

test('prepared run and journal snapshots preserve SQLite text affinity without rewriting original metadata values',async t=>{
  const f=await fixture(t),state=await f.call({status:42,runKind:73,nodeId:17}),snapshotId=f.store.rows('SELECT content_id FROM object_revisions WHERE object_id=? AND revision=1',[state.runId])[0].content_id;
  const fixed=JSON.parse(f.store.content(snapshotId)).data,current=f.store.rows('SELECT status,run_kind FROM runs WHERE id=?',[state.runId])[0];
  assert.equal(fixed.status,current.status);assert.equal(fixed.run_kind,current.run_kind);assert.equal(state.status.runKind,73);
  const journal=f.store.rows('SELECT node_id FROM project_journal_entries WHERE project_id=? AND execution_log_id=1',[state.projectId])[0],source=f.store.rows('SELECT object_id FROM project_journal_sources WHERE project_id=? AND execution_log_id=1',[state.projectId])[0];
  assert.equal(JSON.parse(f.store.read(source.object_id).data.content).nodeId,journal.node_id);
});

test('an identical child that wins during preparation is reused before dependent identities are committed',async t=>{
  const f=await fixture(t),gate=pausePreparation(t,f.store),pending=f.call({});void pending.catch(()=>{});await gate.entering;let child;
  try{child=f.store.write({kind:'conversation',action:'create',scope:f.project.projectId,idempotencyKey:'prepared-run-creation:conversation',data:{mode:'step',status:'active',title:'request'}});}
  finally{gate.release();}
  const state=await pending;assert.equal(state.conversationId,child.objectId);assert.equal(f.store.rows('SELECT conversation_id FROM tasks WHERE id=?',[state.taskId])[0].conversation_id,child.objectId);assert.ok(gate.calls>=2);
});

test('learning eligibility is derived again under the final qualified read snapshot',async t=>{
  const f=await fixture(t),lesson=f.store.write({kind:'lesson',action:'create',scope:null,idempotencyKey:'creation-approved-lesson',data:{status:'approved',summary:'specific approved lesson summary',do_this:'specific approved lesson action'}}),compute=f.store.runCreationCompute,prepare=compute.prepare;let changed=false;
  compute.prepare=async request=>{
    const result=await prepare(request);
    if(!changed){changed=true;assert.equal(result.lessons.length,1);const {DatabaseSync}=require('node:sqlite'),external=new DatabaseSync(f.store.filePath);
      try{external.prepare("UPDATE lessons SET status='revoked' WHERE id=?").run(lesson.objectId);}finally{external.close();}}
    return result;
  };
  const state=await f.call({prompt:`solomap://objects/${lesson.objectId} · revision=1 specific approved lesson summary specific approved lesson action`});
  assert.equal(f.store.rows("SELECT COUNT(*) AS n FROM evidence WHERE run_id=? AND type='host_learning_delivery'",[state.runId])[0].n,0);
});

test('a learning-review run checks retained draft status without Source decoding its large review manifest',async t=>{
  const f=await fixture(t);f.store.activateStorageContentLifecycle({strictPublication:false});
  const text='complete retained review context '.repeat(9000),batch=await f.store.prepareLearningReview({runId:'retained-review-for-run-core',workspaceRoot:f.root,globalPrompt:text,persistedGlobalPrompt:text});
  f.store.activateStorageContentLifecycle({strictPublication:true});
  const control=f.store.rows('SELECT input_content_id FROM learning_review_controls WHERE batch_id=?',[batch.objectId])[0],read=f.store.content;
  assert.ok(Number(f.store.rows('SELECT byte_length FROM contents WHERE id=?',[control.input_content_id])[0].byte_length)>65536);
  f.store.content=function(id){if(id===control.input_content_id)throw Error('Source decoded the retained review manifest just to check draft status');return read.call(this,id);};
  let state;try{state=await f.call({runKind:'learning_review',metadata:{learningReviewBatchId:batch.objectId}});}finally{f.store.content=read;}
  assert.equal(f.store.rows('SELECT run_id FROM learning_review_controls WHERE batch_id=?',[batch.objectId])[0].run_id,state.runId);
});

for(const variant of ['intent','slot'])test(`the actual ${variant} creation stages the complete journal and derives the launch document with its allocated execution id`,async t=>{
  const f=await fixture(t),operation=`prepare_run_${variant}`,input={root:f.root,executionLogId:0,nodeId:'step',runKind:'step',prompt:'按原意准备完整运行'.repeat(10000),command:'完整原始命令'.repeat(9000),userMessage:'完整启动请求'.repeat(12000),metadata:{launchIntentHash:'same-original-intent'},[variant==='intent'?'launchIntentId':'launchSlotId']:`publication-${variant}`,idempotencyKey:`original-${variant}`};
  input.launchRequest={executionLogId:0,prompt:input.prompt,original:'preserve property order'};
  const restore=forbidLargeSourceWork(f.store);let first;
  try{first=await f.operations({operation,input});}finally{restore();}
  assert.equal(first.status.rootExecutionLogId,1);assert.equal(f.store.read(first.runId).data.prompt_content,input.prompt);
  assert.equal(f.store.readProjectJournal(first.projectId,{executionLogId:1}).logs[0].command,input.command);
  assert.equal(Buffer.from(f.store.readRunDocument(first.projectId,1,'launch_request').bytes,'base64').toString(),JSON.stringify({...input.launchRequest,executionLogId:1}));
  const again=await f.operations({operation,input});assert.equal(again.runId,first.runId);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM runs')[0].n,1);
  await assert.rejects(f.operations({operation,input:{...input,metadata:{launchIntentHash:'a different original intent'}}}),/execution_identity_conflict/);
});
