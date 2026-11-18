const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

async function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-turn-request-publication-')),root=path.join(base,'project');fs.mkdirSync(root);const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  const metadata='完整原始运行背景🌿'.repeat(12000),run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'',command:'codex resume session-1',userMessage:'',status:'Waiting',metadata:{interactiveSession:true,sessionProvider:'codex',agentInputMode:'session_reentry',nativeSessionReentryAwaitingRequest:true,requestPublicationFixture:metadata},idempotencyKey:'request-publication-prepare'}});
  return{store,operations,run,metadata,input:(message,key,revision=run.revision)=>({executionLogId:1,generation:run.generation,proof:run.proof,expectedRevision:revision,turnId:run.turnId,message,idempotencyKey:key})};
}
const wal=store=>{const bytes=fs.readFileSync(store.filePath+'-wal');return{bytes:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};};

test('turn request publication preserves complete history and its original expectedRevision-free replay intent',async t=>{
  const f=await fixture(t),message='用户完整第一条真实要求🌿\n'.repeat(12000),input=f.input(message,'first-request'),first=await f.store.publishRunTurnRequest(f.run.projectId,input);
  const second=await f.store.publishRunTurnRequest(f.run.projectId,f.input('随后真实追加的新要求','second-request',first.revision)),before=wal(f.store),replay=await f.store.publishRunTurnRequest(f.run.projectId,{...input,expectedRevision:999});
  assert.deepEqual(replay,first);assert.deepEqual(wal(f.store),before);assert.equal(replay.status.userMessage,message);assert.equal(replay.status.requestPublicationFixture,f.metadata);assert.equal(f.store.read(f.run.turnId,2).data.request_content,message);assert.equal(f.store.read(f.run.turnId).data.request_content,'随后真实追加的新要求');assert.equal(f.store.readRunCheckpointState(f.run.projectId,1).revision,second.revision);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
  const {expectedRevision:_ignored,...intent}=input,hash=crypto.createHash('sha256').update(require('../out/contentReferences.js').canonicalJson({operation:'patch_run_turn_request',projectId:f.run.projectId,input:intent})).digest('hex');assert.equal(f.store.rows('SELECT input_hash FROM requests WHERE idempotency_key=?',[input.idempotencyKey])[0].input_hash,hash);
});

test('the last turn request event failure rolls back its turn, full journal, source evidence, metadata and receipts',async t=>{
  const f=await fixture(t),input=f.input('必须整体发布的完整用户要求🌿'.repeat(12000),'failed-request'),before={state:f.store.readRunCheckpointState(f.run.projectId,1),turn:f.store.read(f.run.turnId),journal:f.store.readRunTurnJournal(f.run.projectId,1),events:f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n,requests:f.store.rows('SELECT COUNT(*) AS n FROM requests')[0].n};
  f.store.db.exec("CREATE TEMP TRIGGER fail_turn_request_event BEFORE INSERT ON events WHEN NEW.kind='run.request' BEGIN SELECT RAISE(ABORT,'actual_last_request_event_failure'); END");
  await assert.rejects(f.store.publishRunTurnRequest(f.run.projectId,input),/actual_last_request_event_failure/);assert.deepEqual(f.store.readRunCheckpointState(f.run.projectId,1),before.state);assert.deepEqual(f.store.read(f.run.turnId),before.turn);assert.equal(f.store.readRunTurnJournal(f.run.projectId,1).entry.output,before.journal.entry.output);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n,before.events);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM requests')[0].n,before.requests);
  f.store.db.exec('DROP TRIGGER fail_turn_request_event');assert.equal((await f.store.publishRunTurnRequest(f.run.projectId,input)).status.userMessage,input.message);
});

test('a journal update after qualification is incorporated once before turn request publication',async t=>{
  const f=await fixture(t),compute=f.store.runTurnRequestCompute,input=f.input('完整新用户消息','journal-race-request');let changed=false,qualifications=0;
  f.store.setRunTurnRequestCompute({...compute,qualify:async request=>{qualifications++;const result=await compute.qualify(request);if(!changed){changed=true;const journal=f.store.readRunTurnJournal(f.run.projectId,1);f.store.updateProjectJournal(f.run.projectId,journal.executionLogId,{...journal.entry,output:journal.entry.output+'\n实际并发保留的日志'});}return result;}});
  await f.store.publishRunTurnRequest(f.run.projectId,input);assert.ok(changed);assert.ok(qualifications>=2);const output=f.store.readRunTurnJournal(f.run.projectId,1).entry.output;assert.ok(output.includes('实际并发保留的日志'));assert.equal(output.split('User message:\n完整新用户消息').length-1,1);
});

test('the actual public turn request entry preserves full results without Source body work',async t=>{
  const f=await fixture(t),message='必须完整保留的原始用户要求🌿'.repeat(15000),input=f.input(message,'direct-full-turn-request'),read=f.store.content,put=f.store.putContent,createHash=crypto.createHash;
  f.store.content=function(id){if(Number(this.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded a large public turn request');return read.call(this,id);};
  f.store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded a large public turn request');return put.call(this,value,...args);};
  crypto.createHash=(...args)=>{const hash=createHash(...args),update=hash.update;hash.update=function(value,...options){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source hashed a large public turn request');return update.call(this,value,...options);};return hash;};let first;
  try{first=await f.store.patchRunTurnRequest(f.run.projectId,input);}finally{f.store.content=read;f.store.putContent=put;crypto.createHash=createHash;}
  assert.equal(first.status.userMessage,message);assert.equal(first.status.requestPublicationFixture,f.metadata);assert.equal(f.store.read(f.run.turnId,2).data.request_content,message);assert.ok(f.store.readRunTurnJournal(f.run.projectId,1).entry.output.includes(message));
  const before=wal(f.store);assert.deepEqual(await f.store.patchRunTurnRequest(f.run.projectId,{...input,expectedRevision:999}),first);assert.deepEqual(wal(f.store),before);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('turn request preparation preserves Native empty-key priority over a stale revision',async t=>{
  const f=await fixture(t),input=f.input('完整合法用户消息','   ',0);let expected;
  try{require('./fixtures/native-turn-request-oracle.cjs').patchRunTurnRequestNative(f.store,f.run.projectId,input);}catch(error){expected=error.message;}
  assert.equal(expected,'idempotency_key_required');
  await assert.rejects(f.store.publishRunTurnRequest(f.run.projectId,input),error=>error.message===expected);
});
