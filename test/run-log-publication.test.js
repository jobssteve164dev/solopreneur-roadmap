const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs'),{canonicalJson}=require('../out/contentReferences.js');
const {appendRunLogNative}=require('./fixtures/native-run-log-oracles.cjs');

async function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-run-log-publication-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  const run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'step',runKind:'step',prompt:'原任务',command:'',userMessage:'原目标',metadata:{retained:'完整运行metadata'.repeat(12000)},idempotencyKey:'log-run'}});
  const input={root,executionLogId:1,generation:run.generation,stream:'stdout',sequence:0,offset:0,bytes:Buffer.from('完整日志🌿').toString('base64'),idempotencyKey:'original-log'};
  return{store,operations,run,input};
}
const wal=store=>{const bytes=fs.readFileSync(store.filePath+'-wal');return{bytes:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};};
const counts=store=>Object.fromEntries(['requests','events','log_chunks','objects','object_revisions','run_control_revisions'].map(table=>[table,store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n]));

for(const native of [true,false])test(`characterized ${native?'Native':'public'} log preserves complete intent, contiguous streams and original fixed receipt`,async t=>{
  const f=await fixture(t),append=input=>native?appendRunLogNative(f.store,f.run.projectId,input):f.store.appendRunLog(f.run.projectId,input),input={...f.input,extra:{origin:'完整额外意图'}};
  const first=await append(input),expected=crypto.createHash('sha256').update(canonicalJson({operation:'append_run_log',projectId:f.run.projectId,input})).digest('hex');
  assert.equal(f.store.rows('SELECT input_hash FROM requests WHERE actor_id=? AND idempotency_key=?',[f.store.actorId,input.idempotencyKey])[0].input_hash,expected);
  const rows=f.store.rows('SELECT stream,sequence,content_id,byte_offset FROM log_chunks WHERE run_id=? ORDER BY stream',[f.run.runId]);assert.deepEqual(rows.map(row=>row.stream),['output','stdout']);assert.equal(rows[0].content_id,rows[1].content_id);assert.equal(first.nextSequence,1);assert.equal(first.totalBytes,Buffer.from(input.bytes,'base64').length);
  const event=f.store.rows("SELECT content_id,sequence FROM events WHERE kind='run.log_appended' AND request_id=?",[first.requestId])[0],descriptor=JSON.parse(f.store.content(event.content_id).toString('utf8'));assert.equal(event.sequence,first.committedSequence);assert.deepEqual(descriptor,{stream:'stdout',sequence:0,offset:0,byteLength:first.totalBytes,sha256:crypto.createHash('sha256').update(Buffer.from(input.bytes,'base64')).digest('hex')});
  await assert.rejects(async()=>append({...input,extra:{origin:'改变额外意图'}}),/idempotency_conflict/);
  const next={...input,bytes:Buffer.from('后续完整日志').toString('base64'),sequence:1,offset:first.totalBytes,idempotencyKey:'next-log'};await append(next);
  const before=wal(f.store);assert.deepEqual(await append(input),first);assert.deepEqual(wal(f.store),before);assert.deepEqual(Buffer.from(f.store.readRunLog(f.run.projectId,{executionLogId:1,stream:'output'}).bytes,'base64'),Buffer.concat([Buffer.from(input.bytes,'base64'),Buffer.from(next.bytes,'base64')]));assert.equal(f.store.readRunState(f.run.projectId,1).revision,1);
});

for(const native of [true,false])test(`characterized ${native?'Native':'public'} log retains original validation order and last-event atomic rollback`,async t=>{
  const f=await fixture(t),append=input=>native?appendRunLogNative(f.store,f.run.projectId,input):f.store.appendRunLog(f.run.projectId,input);
  for(const [patch,error] of [[{generation:-1,stream:'output',bytes:'invalid'},'run_owner_conflict'],[{stream:'output',bytes:'invalid'},'reserved_log_stream'],[{stream:'',bytes:'invalid'},'invalid_log_chunk'],[{sequence:-1,bytes:''},'invalid_log_chunk'],[{idempotencyKey:'',bytes:''},'invalid_log_chunk'],[{bytes:''},'invalid_log_bytes'],[{bytes:'invalid'},'invalid_log_bytes'],[{sequence:9},'log_sequence_conflict']])await assert.rejects(async()=>append({...f.input,...patch}),new RegExp(error));
  const before=counts(f.store);f.store.db.run("CREATE TEMP TRIGGER reject_last_log_event BEFORE INSERT ON events WHEN NEW.kind='run.log_appended' BEGIN SELECT RAISE(ABORT,'last_log_event_failure'); END");
  await assert.rejects(async()=>append(f.input),/last_log_event_failure/);assert.deepEqual(counts(f.store),before);f.store.db.run('DROP TRIGGER reject_last_log_event');
  const receipt=await append({...f.input,idempotencyKey:' '});assert.equal(receipt.nextSequence,1);assert.equal(f.store.rows("SELECT COUNT(*) AS n FROM requests WHERE idempotency_key=' '")[0].n,1,'original log keys are nonempty, not trim-normalized');
});

for(const direct of [true,false])test(`${direct?'public':'Runtime'} log keeps complete large bytes outside Source encoding and hashing`,async t=>{
  const f=await fixture(t),bytes=Buffer.concat([Buffer.from('原始日志\0🌿'),crypto.randomBytes(280000)]),input={...f.input,bytes:bytes.toString('base64')},put=f.store.putContent,read=f.store.content,createHash=crypto.createHash;
  f.store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded a large log body');return put.call(this,value,...args);};
  f.store.content=function(id){if(Number(f.store.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded unrelated run metadata');return read.call(this,id);};
  crypto.createHash=(...args)=>{const hash=createHash(...args),update=hash.update;hash.update=function(value,...options){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source hashed a large log body');return update.call(this,value,...options);};return hash;};
  let receipt;try{receipt=await(direct?f.store.appendRunLog(f.run.projectId,input):f.operations({operation:'append_run_log',input}));}finally{f.store.putContent=put;f.store.content=read;crypto.createHash=createHash;}
  assert.equal(receipt.totalBytes,bytes.length);assert.deepEqual(Buffer.from(f.store.readRunLog(f.run.projectId,{executionLogId:1,stream:'stdout',limit:1048576}).bytes,'base64'),bytes);assert.deepEqual(Buffer.from(f.store.readRunLog(f.run.projectId,{executionLogId:1,stream:'output',limit:1048576}).bytes,'base64'),bytes);
});

for(const native of [true,false])test(`${native?'Native':'Runtime'} accepted log replay leaves damaged unused historical bytes unchanged with WAL0`,async t=>{
  const f=await fixture(t),first=appendRunLogNative(f.store,f.run.projectId,f.input),contentId=f.store.rows("SELECT content_id FROM log_chunks WHERE run_id=? AND stream='stdout' AND sequence=0",[f.run.runId])[0].content_id;
  appendRunLogNative(f.store,f.run.projectId,{...f.input,sequence:1,offset:first.totalBytes,bytes:Buffer.from('后续日志').toString('base64'),idempotencyKey:'later-log'});
  f.store.db.run('UPDATE contents SET data=zeroblob(length(data)) WHERE id=?',[contentId]);assert.throws(()=>f.store.content(contentId),/content_integrity_error/);
  const before=wal(f.store),graph=counts(f.store),result=await(native?appendRunLogNative(f.store,f.run.projectId,f.input):f.operations({operation:'append_run_log',input:f.input}));
  assert.deepEqual(result,first);assert.deepEqual(wal(f.store),before);assert.deepEqual(counts(f.store),graph);assert.throws(()=>f.store.content(contentId),/content_integrity_error/);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('Runtime log preserves Native stream and shape errors before Base64 validation',async t=>{
  const f=await fixture(t);for(const [patch,error] of [[{stream:'output',bytes:'invalid'},'reserved_log_stream'],[{stream:'',bytes:'invalid'},'invalid_log_chunk'],[{sequence:-1,bytes:'invalid'},'invalid_log_chunk']])await assert.rejects(f.operations({operation:'append_run_log',input:{...f.input,...patch}}),new RegExp(error));
});

for(const direct of [true,false])test(`${direct?'public':'published'} log captures original nested extra intent before yielding`,async t=>{
  const f=await fixture(t),input={...f.input,extra:{value:'原值'}},original={...input,extra:{value:'原值'}},pending=direct?f.store.appendRunLog(f.run.projectId,input):f.store.publishRunLog(f.run.projectId,input);input.extra.value='等待期间修改';await pending;
  const expected=crypto.createHash('sha256').update(canonicalJson({operation:'append_run_log',projectId:f.run.projectId,input:original})).digest('hex');assert.equal(f.store.rows('SELECT input_hash FROM requests WHERE idempotency_key=?',[input.idempotencyKey])[0].input_hash,expected);
});

test('a real integrity error after native log inserts rolls back and propagates without retrying the business graph',async t=>{
  const f=await fixture(t),transaction=f.store.transaction,before=counts(f.store);let failed=0;
  const install=()=>f.store.db.run("CREATE TEMP TRIGGER fail_log_integrity_once BEFORE INSERT ON events WHEN NEW.kind='run.log_appended' BEGIN SELECT RAISE(ABORT,'content_integrity_error'); END");
  f.store.transaction=function(...args){try{return transaction.apply(this,args);}catch(error){if(error instanceof Error && error.message==='content_integrity_error'){this.db.run('DROP TRIGGER fail_log_integrity_once');failed++;}throw error;}};
  install();assert.throws(()=>appendRunLogNative(f.store,f.run.projectId,f.input),/content_integrity_error/);assert.equal(failed,1);assert.deepEqual(counts(f.store),before);
  install();try{await assert.rejects(f.store.appendRunLog(f.run.projectId,f.input),/content_integrity_error/);}finally{f.store.transaction=transaction;}
  assert.equal(failed,2);assert.deepEqual(counts(f.store),before);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('log publication restores its actual prepared bytes if they are damaged before the first physical watch',async t=>{
  const f=await fixture(t),stage=f.store.stageAgentDependencies;let calls=0,contentId;
  f.store.stageAgentDependencies=function(...args){calls++;if(calls===1){contentId=args[0].contents[0].contentId;this.db.run('UPDATE contents SET data=zeroblob(length(data)) WHERE id=?',[contentId]);}return stage.apply(this,args);};
  let receipt;try{receipt=await f.store.appendRunLog(f.run.projectId,f.input);}finally{f.store.stageAgentDependencies=stage;}
  assert.ok(calls>=2);assert.equal(receipt.nextSequence,1);assert.deepEqual(f.store.content(contentId),Buffer.from(f.input.bytes,'base64'));assert.equal(f.store.rows("SELECT COUNT(*) AS n FROM events WHERE kind='run.log_appended'")[0].n,1);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM log_chunks WHERE run_id=?',[f.run.runId])[0].n,2);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('log publication reselects a physically dirtied proof constructor while reusing the original prepared body',async t=>{
  const f=await fixture(t),stage=f.store.stageAgentDependencies,prepare=f.store.runLogCompute,watches=f.store.contentVerificationWatches(),begin=watches.begin;let target,changes=0,preparations=0;
  f.store.setRunLogCompute(async request=>{preparations++;return prepare(request);});
  f.store.stageAgentDependencies=function(...args){target=args[0].contents[0].contentId;watches.begin=function(id){const watch=begin.call(this,id);if(id===target && !changes++){f.store.db.run('UPDATE contents SET data=data WHERE id=?',[id]);}return watch;};return stage.apply(this,args);};
  let receipt;try{receipt=await f.store.appendRunLog(f.run.projectId,f.input);}finally{f.store.stageAgentDependencies=stage;watches.begin=begin;f.store.setRunLogCompute(prepare);}
  assert.equal(preparations,1);assert.ok(changes>=1);assert.equal(receipt.nextSequence,1);assert.deepEqual(Buffer.from(f.store.readRunLog(f.run.projectId,{executionLogId:1,stream:'output'}).bytes,'base64'),Buffer.from(f.input.bytes,'base64'));assert.equal(f.store.rows("SELECT COUNT(*) AS n FROM events WHERE kind='run.log_appended'")[0].n,1);
});

test('log FIFO preserves both contiguous appends while an independent actual write completes during preparation',async t=>{
  const f=await fixture(t),prepare=f.store.runLogCompute;let enter,release,secondStarted=false;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
  f.store.setRunLogCompute(async request=>{const prepared=await prepare(request);if(request.input.idempotencyKey===f.input.idempotencyKey){enter();await gate;}else secondStarted=true;return prepared;});
  const first=f.store.appendRunLog(f.run.projectId,f.input);await entered;
  const next={...f.input,sequence:1,offset:Buffer.from(f.input.bytes,'base64').length,bytes:Buffer.from('下一个完整日志').toString('base64'),idempotencyKey:'queued-next-log'},second=f.store.appendRunLog(f.run.projectId,next);
  try{const foreground=f.store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'foreground-during-log',data:{category:'test',title:'独立写入',status:'active',content:'无需等待日志准备'}});assert.equal(f.store.read(foreground.objectId).data.title,'独立写入');assert.equal(secondStarted,false);}finally{release();}
  const [a,b]=await Promise.all([first,second]);assert.equal(a.nextSequence,1);assert.equal(b.nextSequence,2);assert.equal(secondStarted,true);assert.deepEqual(Buffer.from(f.store.readRunLog(f.run.projectId,{executionLogId:1,stream:'output'}).bytes,'base64'),Buffer.concat([Buffer.from(f.input.bytes,'base64'),Buffer.from(next.bytes,'base64')]));
});

test('log readonly selection reuses a real late Native winner without duplicate business or preparation writes',async t=>{
  const f=await fixture(t),prepare=f.store.runLogCompute;let winner,afterWinner,calls=0;
  f.store.setRunLogCompute(async request=>{const prepared=await prepare(request);if(!calls++){winner=appendRunLogNative(f.store,f.run.projectId,f.input);afterWinner={wal:wal(f.store),counts:counts(f.store)};}return prepared;});
  const result=await f.store.appendRunLog(f.run.projectId,f.input);assert.deepEqual(result,winner);assert.equal(calls,2);assert.deepEqual(counts(f.store),afterWinner.counts);assert.deepEqual(wal(f.store),afterWinner.wal);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('log preserves Native long stream and key values without hashing their staging labels in Source',async t=>{
  const f=await fixture(t),stream='原始流🌿'.repeat(8000),key='原始键🌿'.repeat(8000),initial={...f.input,stream,idempotencyKey:`${key}:native`},first=appendRunLogNative(f.store,f.run.projectId,initial),input={...initial,sequence:1,offset:first.totalBytes,bytes:Buffer.from('后续原始字节').toString('base64'),idempotencyKey:`${key}:published`},createHash=crypto.createHash;
  crypto.createHash=(...args)=>{const hash=createHash(...args),update=hash.update;hash.update=function(value,...options){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source hashed a large log stage key');return update.call(this,value,...options);};return hash;};
  let result;try{result=await f.store.appendRunLog(f.run.projectId,input);}finally{crypto.createHash=createHash;}
  assert.equal(result.nextSequence,2);assert.deepEqual(Buffer.from(f.store.readRunLog(f.run.projectId,{executionLogId:1,stream}).bytes,'base64'),Buffer.concat([Buffer.from(initial.bytes,'base64'),Buffer.from(input.bytes,'base64')]));
  const expected=crypto.createHash('sha256').update(canonicalJson({operation:'append_run_log',projectId:f.run.projectId,input})).digest('hex');assert.equal(f.store.rows('SELECT input_hash FROM requests WHERE idempotency_key=?',[input.idempotencyKey])[0].input_hash,expected);
});

test('log replay reselects a real cold-converted receipt before verifying its now-unused old payload',async t=>{
  const f=await fixture(t),first=appendRunLogNative(f.store,f.run.projectId,f.input),old=f.store.putContent(JSON.stringify(first),'application/json');f.store.db.run('UPDATE requests SET result_inline_json=NULL,result_content_id=? WHERE id=?',[old,first.requestId]);
  const stage=f.store.stageAgentDependencies;let converted=false,afterConversion;
  f.store.stageAgentDependencies=function(...args){
    if(!converted){converted=true;for(let index=0;index<100;index++){const batch=this.prepareStorageColdBatch(8);if(!batch.pending)break;this.commitStorageColdBatch(batch);}
      assert.equal(this.rows('SELECT result_content_id FROM requests WHERE id=?',[first.requestId])[0].result_content_id,null);this.db.run('UPDATE contents SET data=zeroblob(length(data)) WHERE id=?',[old]);assert.throws(()=>this.content(old),/content_integrity_error/);assert.deepEqual(appendRunLogNative(this,f.run.projectId,f.input),first);afterConversion={wal:wal(this),counts:counts(this)};
    }
    return stage.apply(this,args);
  };
  let result;try{result=await f.store.appendRunLog(f.run.projectId,f.input);}finally{f.store.stageAgentDependencies=stage;}
  assert.deepEqual(result,first);assert.deepEqual(wal(f.store),afterConversion.wal);assert.deepEqual(counts(f.store),afterConversion.counts);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('log replay retains the actual Native integrity error when its needed receipt pointer has not changed',async t=>{
  const f=await fixture(t),first=appendRunLogNative(f.store,f.run.projectId,f.input),old=f.store.putContent(JSON.stringify(first),'application/json');f.store.db.run('UPDATE requests SET result_inline_json=NULL,result_content_id=? WHERE id=?',[old,first.requestId]);
  const stage=f.store.stageAgentDependencies,prepare=f.store.runLogCompute;let changed=false,preparations=0,afterDamage;
  f.store.setRunLogCompute(async request=>{preparations++;return prepare(request);});f.store.stageAgentDependencies=function(...args){if(!changed){changed=true;this.db.run('UPDATE contents SET data=zeroblob(length(data)) WHERE id=?',[old]);assert.throws(()=>appendRunLogNative(this,f.run.projectId,f.input),/content_integrity_error/);afterDamage={wal:wal(this),counts:counts(this)};}return stage.apply(this,args);};
  try{await assert.rejects(f.store.appendRunLog(f.run.projectId,f.input),/content_integrity_error/);}finally{f.store.stageAgentDependencies=stage;f.store.setRunLogCompute(prepare);}
  assert.equal(preparations,1);assert.deepEqual(wal(f.store),afterDamage.wal);assert.deepEqual(counts(f.store),afterDamage.counts);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});
