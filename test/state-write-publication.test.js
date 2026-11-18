const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{canonicalJson}=require('../out/contentReferences.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs'),{writeStateNative}=require('./fixtures/native-daily-state-oracles.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const {runInputsSerializedResult}=require('../out/db/runInputsPublication.js');
async function fixture(t,type,native=false){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-state-write-')),root=path.join(base,'project');fs.mkdirSync(root);const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});const project=(await store.registerProject({root})).projectId;
  const input=(value,expectedRevision,idempotencyKey,extra={})=>({...type==='analysis'?{namespace:'sidebar',key:'conversation'}:{},value,expectedRevision,idempotencyKey,...extra}),call=value=>native?writeStateNative(store,type,project,value):store[type==='analysis'?'writeAnalysisState':'writeStrategyState'](project,value),read=()=>type==='analysis'?store.readAnalysisState(project,'sidebar','conversation'):store.readStrategyState(project),source=()=>type==='analysis'?store.readProjectAnalysisSource(project).conversationRevision:store.readStrategySourceRevision([project]);
  return{store,project,input,call,read,source};
}
function released(store){
  for(const table of ['content_lifecycle_prepare_owners','content_lifecycle_prepare_pins'])assert.equal(store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n,0);
  for(const table of ['solomap_state_source_watches','solomap_state_source_projects'])if(store.rows("SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name=?",[table]).length)assert.equal(store.rows(`SELECT COUNT(*) AS n FROM temp.${table}`)[0].n,0);
}
function event(store,project,key){
  const evidence=store.write({kind:'evidence',action:'create',scope:project,idempotencyKey:`evidence:${key}`,data:{type:'host_observation',source_actor_id:store.actorId,content:`真实证据${key}`,observed_at:1}});
  return store.write({kind:'learning_event',action:'create',scope:project,idempotencyKey:`event:${key}`,data:{source_object_id:evidence.objectId,source_revision:1,event_type:'completed',source_type:'solo',summary:`真实学习事件${key}`,occurred_at:1}});
}
for(const type of ['analysis','strategy'])for(const shape of ['buffer','date','url'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} masked native JSON hooks retain privately captured enumerable values for ${shape}`,async t=>{
  const f=await fixture(t,type,native),value=shape==='buffer'?Buffer.from([0,255,128]):shape==='date'?new Date('2026-11-16T00:00:00.000Z'):new URL('https://example.test/original');value.toJSON=null;value.kept={published:'调用时的自有字段'};const body=JSON.stringify(value),pending=f.call(f.input(value,0,'masked'));value.kept.published='调用方随后修改';if(shape==='buffer')value[0]=99;const result=await pending;assert.deepEqual(result.value,JSON.parse(body));assert.equal(f.store.read(result.objectId,1).data.content,body);released(f.store);
});
for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} daily save retains full intent and fixed replay history`,async t=>{
  const f=await fixture(t,type,native),value={original:'完整日常状态🌿'.repeat(12000),unknown:{kept:true},binary:Buffer.from([0,255,128]),array:['首项',,'尾项'],omitted:undefined},body=JSON.stringify(value),first=await f.call(f.input(value,0,'first',{expectedSourceRevision:f.source(),sourceProjectIds:[f.project]}));assert.equal(first.revision,1);assert.deepEqual(first.value,JSON.parse(body));assert.equal(f.store.read(first.objectId,1).data.content,body);
  const key=type==='analysis'?`analysis-state:${f.project}:sidebar:conversation:first`:`strategy-state:${f.project}:first`,intent={kind:'setting',action:'create',scope:f.project,idempotencyKey:key,data:{namespace:type==='analysis'?'analysis:sidebar':'strategy',key:type==='analysis'?'conversation':'preferences',owner_scope:f.project,content:body}};assert.equal(f.store.rows('SELECT input_hash FROM requests WHERE actor_id=? AND idempotency_key=?',[f.store.actorId,key])[0].input_hash,hash(canonicalJson(intent)));
  assert.deepEqual(await f.call(f.input(value,0,'first',{expectedSourceRevision:'ignored-on-retry',sourceProjectIds:['ignored-on-retry']})),first);const secondValue={original:'完整第二版🌿'.repeat(12000)},second=await f.call(f.input(secondValue,1,'second')),thirdValue={original:'完整第三版🌿'.repeat(12000)},third=await f.call(f.input(thirdValue,2,'third'));assert.equal(third.revision,3);assert.deepEqual(await f.call(f.input(secondValue,1,'second',{expectedSourceRevision:'ignored-on-retry'})),second);assert.deepEqual(f.read().value,thirdValue);assert.equal(f.store.read(first.objectId,1).data.content,body);assert.equal(f.store.read(first.objectId,2).data.content,JSON.stringify(secondValue));
});
for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} daily save retains current-body errors after its input generation boundary`,async t=>{
  const f=await fixture(t,type,native),first=await f.call(f.input({current:'真实当前值'},0,'first')),cid=f.store.rows('SELECT content_id FROM settings WHERE id=?',[first.objectId])[0].content_id;f.store.db.run('UPDATE contents SET data=zeroblob(length(data)) WHERE id=?',[cid]);let calls=0;const value={toJSON(){calls++;if(native)throw Error('input_hook_must_remain_after_current');return{generated:'fixed'};}};await assert.rejects(async()=>f.call(f.input(value,99,'bad-current',{expectedSourceRevision:'wrong',sourceProjectIds:[f.project]})),/content_integrity_error/);assert.equal(calls,native?0:1);assert.equal(f.store.readMetadata(first.objectId).revision,1);
});
for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} daily source guards precede revision and data encoding after generation`,async t=>{
  const f=await fixture(t,type,native);let calls=0;const value={toJSON(){calls++;if(native)throw Error('input_hook_must_remain_after_guard');return{generated:'fixed'};}},error=type==='analysis'?/analysis_source_conflict/:/strategy_source_conflict/;await assert.rejects(async()=>f.call(f.input(value,99,'wrong-source',{expectedSourceRevision:'wrong',sourceProjectIds:[f.project]})),error);assert.equal(calls,native?0:1);assert.equal(f.read().objectId,null);await f.call(f.input({current:'保留当前值'},0,'first'));await assert.rejects(async()=>f.call(f.input(value,0,'wrong-source-again',{expectedSourceRevision:'wrong',sourceProjectIds:[f.project]})),error);assert.equal(calls,native?0:2);assert.equal(f.read().revision,1);
});
for(const type of ['analysis','strategy'])test(`public ${type} missing current retains its Native data error after one generation`,async t=>{
  const original=await fixture(t,type,true),current=await fixture(t,type);let originalCalls=0,currentCalls=0;const oldValue={toJSON(){originalCalls++;return{published:'原始输入'};}},newValue={toJSON(){currentCalls++;return{published:'原始输入'};}};let oldError,newError;try{await original.call(original.input(oldValue,7,'missing'));}catch(error){oldError=error;}try{await current.call(current.input(newValue,7,'missing'));}catch(error){newError=error;}assert.ok(oldError);assert.ok(newError);assert.equal(newError.message,oldError.message);assert.equal(originalCalls,type==='analysis'?0:1);assert.equal(currentCalls,1);assert.equal(current.read().objectId,null);
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} daily save ignores extraneous payload routing controls`,async t=>{
  const f=await fixture(t,type,native),result=await f.call(f.input({published:'原调用范围'},0,'scope',{projectId:null,type:type==='analysis'?'strategy':'analysis',namespace:type==='analysis'?'sidebar':'external',key:type==='analysis'?'conversation':'injected',reservation:{requestId:'ignored-payload-control',generation:999},selectCurrentRevision:true,growthReservationRequestId:'ignored-growth-routing'})),object=f.store.readMetadata(result.objectId);assert.equal(object.projectId,f.project);assert.equal(object.data.namespace,type==='analysis'?'analysis:sidebar':'strategy');assert.equal(object.data.key,type==='analysis'?'conversation':'preferences');
});

for(const type of ['analysis','strategy'])test(`public ${type} daily save prepares large current and new state outside Source`,async t=>{
  const f=await fixture(t,type),old={original:'完整旧日常状态🌿'.repeat(18000)},first=await f.call(f.input(old,0,'first')),value={original:'完整新日常状态🌿'.repeat(18000),binary:Buffer.alloc(128*1024,7)},body=JSON.stringify(value),put=f.store.putContent,read=f.store.content,createHash=crypto.createHash;
  f.store.putContent=function(bytes,...args){if((typeof bytes==='string'?Buffer.byteLength(bytes):bytes.byteLength)>65536)throw Error('Source encoded large daily state');return put.call(this,bytes,...args);};f.store.content=function(id){if(Number(this.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded prior daily state');return read.call(this,id);};crypto.createHash=(...args)=>{const digest=createHash(...args),update=digest.update;digest.update=function(bytes,...rest){if((typeof bytes==='string'?Buffer.byteLength(bytes):bytes.byteLength)>65536)throw Error('Source hashed large daily state');return update.call(this,bytes,...rest);};return digest;};
  let result;try{result=await f.call(f.input(value,1,'next'));}finally{f.store.putContent=put;f.store.content=read;crypto.createHash=createHash;}
  assert.equal(result.revision,2);assert.deepEqual(result.value,JSON.parse(body));assert.equal(f.store.read(first.objectId,1).data.content,JSON.stringify(old));assert.equal(f.store.read(first.objectId,2).data.content,body);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('public strategy daily source guard hashes the actual learning corpus outside Source',async t=>{
  const f=await fixture(t,'strategy');
  for(let index=0;index<900;index++){
    const evidence=f.store.write({kind:'evidence',action:'create',scope:f.project,idempotencyKey:`corpus-evidence:${index}`,data:{type:'host_observation',source_actor_id:f.store.actorId,content:`真实保留证据${index}`,observed_at:index+1}});
    f.store.write({kind:'learning_event',action:'create',scope:f.project,idempotencyKey:`corpus-event:${index}`,data:{source_object_id:evidence.objectId,source_revision:1,event_type:'completed',source_type:'solo',summary:`真实学习事件${index}`,occurred_at:index+1}});
  }
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM learning_events')[0].n,900);const expectedSourceRevision=f.source(),createHash=crypto.createHash;let result;
  crypto.createHash=(...args)=>{const digest=createHash(...args),update=digest.update;digest.update=function(bytes,...rest){if((typeof bytes==='string'?Buffer.byteLength(bytes):bytes.byteLength)>65536)throw Error('Source hashed the learning corpus');return update.call(this,bytes,...rest);};return digest;};
  try{result=await f.call(f.input({published:'真实来源资格'},0,'guarded',{expectedSourceRevision,sourceProjectIds:[f.project]}));}finally{crypto.createHash=createHash;}
  assert.equal(result.revision,1);assert.deepEqual(result.value,{published:'真实来源资格'});
});

test('strategy daily save reselects when a real new corpus member arrives after the Reader result',async t=>{
  const f=await fixture(t,'strategy'),expectedSourceRevision=f.source(),prepare=f.store.stateWriteCompute;let calls=0;
  f.store.setStateWriteCompute(async request=>{const first=++calls===1,result=await prepare(request);if(first)event(f.store,f.project,'late-member');return result;});
  await assert.rejects(()=>f.call(f.input({candidate:'旧来源'},0,'guarded',{expectedSourceRevision,sourceProjectIds:[f.project]})),/strategy_source_conflict/);assert.equal(calls,2);assert.equal(f.read().objectId,null);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM learning_events')[0].n,1);released(f.store);
});

for(const kind of ['preferences','counter'])test(`strategy daily save retains the actual ${kind} source observation after registration`,async t=>{
  const f=await fixture(t,'strategy'),otherRoot=path.join(f.store.root,'other-project');fs.mkdirSync(otherRoot);const other=(await f.store.registerProject({root:otherRoot})).projectId,expectedSourceRevision=f.store.readStrategySourceRevision([other]),stage=f.store.stageAgentDependencies,prepare=f.store.stateWriteCompute;let changed=false,calls=0;
  f.store.setStateWriteCompute(async request=>{calls++;return prepare(request);});f.store.stageAgentDependencies=async function(plan,...args){const proof=await stage.call(this,plan,...args);if(!changed && plan.sourceProjects?.length){changed=true;if(kind==='preferences')writeStateNative(f.store,'strategy',other,{expectedRevision:0,value:{kept:'实际新偏好'},idempotencyKey:'late-preference'});else f.store.upsertProjectRunIndex(other,{executionLogId:1,nodeId:'1',runKind:'step',status:'Completed',durationMs:600000});}return proof;};
  await assert.rejects(()=>f.call(f.input({candidate:'旧来源'},0,'guarded',{expectedSourceRevision,sourceProjectIds:[other]})),/strategy_source_conflict/);assert.equal(changed,true);assert.equal(calls,2);assert.equal(f.read().objectId,null);if(kind==='preferences')assert.deepEqual(f.store.readStrategyState(other).value,{kept:'实际新偏好'});released(f.store);
});

test('strategy committed retry ignores changed source dependencies and publishes no owner',async t=>{
  const f=await fixture(t,'strategy'),value={published:'原固定请求结果'},first=await f.call(f.input(value,0,'committed',{expectedSourceRevision:f.source(),sourceProjectIds:[f.project]})),prepare=f.store.stateWriteCompute;let calls=0;
  f.store.setStateWriteCompute(async request=>{const result=await prepare(request);if(++calls===1)event(f.store,f.project,'ignored-late-member');return result;});
  assert.deepEqual(await f.call(f.input(value,0,'committed',{expectedSourceRevision:'ignored-on-retry',sourceProjectIds:['ignored-on-retry']})),first);assert.equal(calls,1);assert.equal(f.read().revision,1);released(f.store);
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} daily hooks retain their real receiver and encoded return value`,async t=>{
  const f=await fixture(t,type,native);let calls=0;class Value{#value='正式返回值';toJSON(key){calls++;return{published:this.#value,key};}get hidden(){throw Error('hidden_original_object_must_not_be_encoded');}}const value=new Value(),result=await f.call(f.input(value,0,'hook'));assert.equal(calls,1);assert.deepEqual(result.value,{published:'正式返回值',key:''});assert.equal(f.store.read(result.objectId,1).data.content,'{"published":"正式返回值","key":""}');released(f.store);
});

for(const type of ['analysis','strategy'])test(`public ${type} daily hook capture survives a real proof-invalidating rewrite`,async t=>{
  const f=await fixture(t,type),first=await f.call(f.input({retained:'固定旧历史'},0,'first')),cid=f.store.rows('SELECT content_id FROM settings WHERE id=?',[first.objectId])[0].content_id,prepare=f.store.stateWriteCompute,stage=f.store.stageAgentDependencies;let calls=0,hooks=0,rewritten=false;const value={toJSON(key){hooks++;assert.equal(this,value);return{published:'捕获一次的实际结果',key};}};
  f.store.setStateWriteCompute(async request=>{calls++;return prepare(request);});f.store.stageAgentDependencies=async function(plan,...args){const proof=await stage.call(this,plan,...args);if(plan.mode==='publish' && !rewritten){rewritten=true;f.store.db.run('UPDATE contents SET data=data WHERE id=?',[cid]);}return proof;};
  const result=await f.call(f.input(value,1,'next'));assert.equal(calls,2);assert.equal(hooks,1);assert.equal(result.revision,2);assert.deepEqual(result.value,{published:'捕获一次的实际结果',key:''});assert.equal(f.store.read(first.objectId,1).data.content,'{"retained":"固定旧历史"}');assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM events WHERE subject_id=?',[first.objectId])[0].n,2);released(f.store);
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} first Native write failure remains visible and rolls back before explicit retry`,async t=>{
  const f=await fixture(t,type,native),input=f.input({published:'显式重试后保留'},0,'first-failure',{expectedSourceRevision:f.source(),sourceProjectIds:[f.project]}),key=type==='analysis'?`analysis-state:${f.project}:sidebar:conversation:first-failure`:`strategy-state:${f.project}:first-failure`,run=f.store.db.run;let attempts=0;
  f.store.db.run=function(sql,values){const result=run.call(this,sql,values);if(sql.startsWith('INSERT INTO requests(') && values?.[1]===key){attempts++;throw Error('data_write_replay_changed');}return result;};
  try{await assert.rejects(async()=>f.call(input),/data_write_replay_changed/);}finally{f.store.db.run=run;}
  assert.equal(attempts,1);assert.equal(f.read().objectId,null);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM requests WHERE idempotency_key=?',[key])[0].n,0);released(f.store);const result=await f.call(input);assert.equal(result.revision,1);assert.deepEqual(result.value,{published:'显式重试后保留'});assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM events WHERE subject_id=?',[result.objectId])[0].n,1);released(f.store);
});

test('daily source proof cleanup retains and drains a real failed release without changing the accepted result',async t=>{
  const f=await fixture(t,'strategy'),run=f.store.db.run;let failures=0;
  f.store.db.run=function(sql,...args){if(!failures && sql.startsWith('DELETE FROM temp.solomap_state_source_projects')){failures++;throw Error('actual_state_source_release_failed');}return run.call(this,sql,...args);};
  let result;try{result=await f.call(f.input({published:'已接受的真实结果'},0,'cleanup',{expectedSourceRevision:f.source(),sourceProjectIds:[f.project]}));}finally{f.store.db.run=run;}
  assert.equal(failures,1);assert.equal(result.revision,1);assert.deepEqual(f.read().value,{published:'已接受的真实结果'});assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM temp.solomap_state_source_watches')[0].n,1);assert.equal(f.store.stateSourceVerification.flushRetired(true),false);released(f.store);assert.equal(f.read().revision,1);
});

for(const type of ['analysis','strategy'])for(const literal of ['9007199254740993','1e400','-0'])test(`public ${type} serialized daily response uses the actual parsed value for ${literal}`,async t=>{
  const f=await fixture(t,type),result=await f.call(f.input(JSON.rawJSON(literal),0,'raw-result')),serialized=runInputsSerializedResult(result);assert.equal(f.store.read(result.objectId,1).data.content,literal);assert.ok(Object.is(result.value,JSON.parse(literal)));assert.equal(serialized,JSON.stringify(result));assert.equal(serialized,`{"objectId":${JSON.stringify(result.objectId)},"revision":1,"value":${JSON.stringify(JSON.parse(literal))}}`);released(f.store);
});

for(const direction of ['departure','arrival'])test(`strategy daily source qualification notices a real counter row key migration after registration: ${direction}`,async t=>{
  const f=await fixture(t,'strategy'),otherRoot=path.join(f.store.root,'counter-destination');fs.mkdirSync(otherRoot);const other=(await f.store.registerProject({root:otherRoot})).projectId;
  f.store.upsertProjectRunIndex(f.project,{executionLogId:1,nodeId:'1',runKind:'step',status:'Completed',durationMs:600000});assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM project_analysis_sources WHERE project_id=?',[other])[0].n,0);const sourceProject=direction==='departure'?f.project:other,expectedSourceRevision=f.store.readStrategySourceRevision([sourceProject]),stage=f.store.stageAgentDependencies;let moved=false;
  f.store.stageAgentDependencies=async function(plan,...args){const proof=await stage.call(this,plan,...args);if(!moved && plan.sourceProjects?.length){moved=true;f.store.db.run('UPDATE project_analysis_sources SET project_id=? WHERE project_id=?',[other,f.project]);}return proof;};
  await assert.rejects(()=>f.call(f.input({candidate:'旧项目计数资格'},0,'counter-key',{expectedSourceRevision,sourceProjectIds:[sourceProject]})),/strategy_source_conflict/);assert.equal(moved,true);assert.equal(f.read().objectId,null);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM project_analysis_sources WHERE project_id=?',[other])[0].n,1);released(f.store);
});

for(const native of [true,false])test(`${native?'Native':'public'} coverage saves choose actual current revision inside their serialized publication`,async t=>{
  const f=await fixture(t,'analysis',native),first={payload:'完整首份覆盖率结果🌿'.repeat(9000)},second={payload:'完整第二份覆盖率结果🌿'.repeat(9000)},save=(value,key)=>native?(()=>{const current=f.store.readAnalysisState(f.project,'coverage','project-growth');return writeStateNative(f.store,'analysis',f.project,{namespace:'coverage',key:'project-growth',expectedRevision:current.revision,value,idempotencyKey:key});})():f.store.publishProjectCoverageState(f.project,value,key);
  const results=await Promise.all([Promise.resolve().then(()=>save(first,'coverage-first')),Promise.resolve().then(()=>save(second,'coverage-next'))]);assert.deepEqual(results.map(value=>value.revision),[1,2]);assert.equal(results[0].objectId,results[1].objectId);assert.equal(f.store.read(results[0].objectId,1).data.content,JSON.stringify(first));assert.equal(f.store.read(results[0].objectId,2).data.content,JSON.stringify(second));if(!native)assert.equal(runInputsSerializedResult(results[1].value),JSON.stringify(second));released(f.store);
});

test('explicit daily compare-and-set keeps its caller revision while coverage uses internal current selection',async t=>{
  const f=await fixture(t,'analysis'),first=f.call(f.input({published:'首请求'},0,'first-cas')),second=f.call(f.input({published:'并发旧请求'},0,'stale-cas'));const settled=await Promise.allSettled([first,second]);assert.equal(settled[0].status,'fulfilled');assert.equal(settled[1].status,'rejected');assert.match(settled[1].reason.message,/revision_conflict/);assert.deepEqual(f.read().value,{published:'首请求'});released(f.store);
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} daily values preserve detached byte JSON with and without caller hooks`,async t=>{
  const f=await fixture(t,type,native);
  for(const withHooks of [false,true]){
    const typed=new Uint8Array([0,255]),buffer=Buffer.from(new ArrayBuffer(2));for(const view of [typed,buffer])structuredClone(view.buffer,{transfer:[view.buffer]});let calls=0;
    typed.annotation=withHooks?{toJSON(key){calls++;return{kept:'真实可见字段',key};}}:{kept:'真实可见字段'};
    const value={typed,alias:typed,buffer},expected=JSON.stringify(value),before=calls,result=await f.call(f.input(value,withHooks?1:0,`detached-${withHooks}`));
    assert.equal(f.store.read(result.objectId,result.revision).data.content,expected);assert.deepEqual(result.value,JSON.parse(expected));assert.equal(calls,before+(withHooks?2:0));released(f.store);
  }
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} daily mixed callback capture owns plain bytes and raw JSON before readonly awaits`,async t=>{
  const f=await fixture(t,type,native),bytes=new Uint8Array([11,22]),buffer=Buffer.from([11,22]),value={plain:{text:'调用时原字段'},bytes,buffer,proxied:new Proxy({stable:'原Proxy'},{}),...(typeof JSON.rawJSON==='function'?{raw:JSON.rawJSON('9007199254740993')}:{})},expected=JSON.stringify(value),prepare=f.store.stateWriteCompute;let release,notify,paused=false;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>notify=resolve);
  if(!native)f.store.setStateWriteCompute(async request=>{const result=await prepare(request);if(request.state && !paused){paused=true;assert.equal(result.mode,'publish');notify();await gate;}return result;});
  const pending=f.call(f.input(value,0,'mixed-ownership'));if(!native)await entered;value.plain.text='等待时后改';bytes[0]=99;buffer[0]=99;release();let saved;try{saved=await pending;}finally{f.store.setStateWriteCompute(prepare);}
  assert.equal(f.store.read(saved.objectId,1).data.content,expected);assert.deepEqual(saved.value,JSON.parse(expected));released(f.store);
});
