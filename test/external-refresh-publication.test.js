const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs'),{externalRefreshNative,writeStateNative}=require('./fixtures/native-daily-state-oracles.cjs');
const {runInputsSerializedResult}=require('../out/db/runInputsPublication.js');
async function fixture(t,native=false){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-external-refresh-')),root=path.join(base,'project');fs.mkdirSync(root);const store=new UnifiedDataStore(path.join(base,'data')),ops=createRuntimeDataOperations(store);t.after(async()=>{await ops.close();store.close();});const project=(await store.registerProject({root})).projectId;
  const reserve=requestId=>native?externalRefreshNative(store,'reserve',project,'issues',requestId):store.reserveExternalRefresh(project,'issues',requestId),commit=input=>native?externalRefreshNative(store,'commit',project,{key:'issues',...input}):store.commitExternalRefresh(project,{key:'issues',...input}),read=namespace=>store.readAnalysisState(project,namespace,'issues'),seed=(namespace,value,key)=>writeStateNative(store,'analysis',project,{namespace,key:'issues',value,expectedRevision:0,idempotencyKey:key});
  return{store,project,reserve,commit,read,seed};
}
for(const native of [true,false])test(`${native?'Native':'public'} external refresh retains generations, complete cache bytes and fixed history`,async t=>{
  const f=await fixture(t,native),first=await f.reserve('request-a');assert.deepEqual(first,{requestId:'request-a',generation:1});const second=await f.reserve('request-b');assert.equal(second.generation,2);assert.deepEqual(await f.commit({requestId:'request-a',generation:1,requestedAt:1,cache:{ignored:true}}),{accepted:false,state:{objectId:null,revision:0,value:null}});
  const cache={payload:'完整外部缓存🌿'.repeat(12000),unknown:{retained:true}},accepted=await f.commit({requestId:'request-b',generation:2,requestedAt:2,cache});assert.equal(accepted.accepted,true);assert.equal(accepted.state.revision,1);const body=JSON.stringify({generation:2,requestedAt:2,requestId:'request-b',cache});assert.equal(f.store.read(accepted.state.objectId,1).data.content,body);
  const third=await f.reserve('request-c'),nextCache={payload:'完整外部第二版🌿'.repeat(12000)},next=await f.commit({requestId:'request-c',generation:third.generation,requestedAt:3,cache:nextCache});assert.equal(next.state.objectId,accepted.state.objectId);assert.equal(next.state.revision,2);assert.equal(f.store.read(accepted.state.objectId,1).data.content,body);assert.deepEqual(f.read('external').value,{generation:3,requestedAt:3,requestId:'request-c',cache:nextCache});
});
for(const native of [true,false])test(`${native?'Native':'public'} external refresh keeps actual automatic-version replay and rejection semantics`,async t=>{
  const f=await fixture(t,native),first=await f.reserve('request-a');await assert.rejects(async()=>f.reserve('request-a'),/idempotency_conflict/);const accepted=await f.commit({requestId:'request-a',generation:first.generation,requestedAt:1,cache:{published:'原提交'}});await assert.rejects(async()=>f.commit({requestId:'request-a',generation:first.generation,requestedAt:1,cache:{published:'原提交'}}),/idempotency_conflict/);
  await f.reserve('request-b');const before=f.store.rows('SELECT COUNT(*) AS n FROM requests')[0].n,rejected=await f.commit({requestId:'request-a',generation:first.generation,requestedAt:1,cache:{changed:'旧提交重试'}});assert.equal(rejected.accepted,false);assert.deepEqual(rejected.state,accepted.state);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM requests')[0].n,before);
});
for(const native of [true,false])test(`${native?'Native':'public'} external rejection retains reservation and cache read errors after generation`,async t=>{
  const f=await fixture(t,native),reservation=await f.reserve('request-a');f.seed('external',{retained:'真实旧缓存'},'cache');const current=f.read('external'),cid=f.store.rows('SELECT content_id FROM settings WHERE id=?',[current.objectId])[0].content_id;f.store.db.run('UPDATE contents SET data=zeroblob(length(data)) WHERE id=?',[cid]);let calls=0;const cache={toJSON(){calls++;if(native)throw Error('candidate_hook_must_not_run');return{generated:'fixed'};}};
  await assert.rejects(async()=>f.commit({requestId:'wrong-request',generation:reservation.generation+1,requestedAt:1,cache}),/content_integrity_error/);assert.equal(calls,native?0:1);
  const g=await fixture(t,native);await g.reserve('real-reservation');const reservationState=g.read('external-refresh'),reservationCid=g.store.rows('SELECT content_id FROM settings WHERE id=?',[reservationState.objectId])[0].content_id;g.seed('external',{retained:'第二个真实缓存'},'other-cache');const cached=g.read('external'),cacheCid=g.store.rows('SELECT content_id FROM settings WHERE id=?',[cached.objectId])[0].content_id;g.store.db.run('UPDATE contents SET data=zeroblob(length(data)) WHERE id=?',[reservationCid]);g.store.db.run('UPDATE contents SET data=zeroblob(length(data)) WHERE id=?',[cacheCid]);await assert.rejects(async()=>g.commit({requestId:'wrong',generation:1,requestedAt:1,cache}),/content_integrity_error/);assert.equal(calls,native?0:2);
});
for(const native of [true,false])test(`${native?'Native':'public'} external cache generation retains its real receiver and cache key`,async t=>{
  const f=await fixture(t,native);let calls=0;class Cache{#value='正式缓存';toJSON(key){calls++;return{published:this.#value,key};}get hidden(){throw Error('hidden_original_cache_must_not_be_encoded');}}const cache=new Cache(),reservation=await f.reserve('request-a'),rejected=await f.commit({requestId:'other',generation:reservation.generation,requestedAt:1,cache});assert.equal(rejected.accepted,false);assert.equal(calls,native?0:1);const accepted=await f.commit({requestId:'request-a',generation:reservation.generation,requestedAt:1,cache});assert.equal(calls,native?1:2);assert.deepEqual(accepted.state.value,{generation:1,requestedAt:1,requestId:'request-a',cache:{published:'正式缓存',key:'cache'}});
});

for(const operation of ['reserve','commit'])test(`public external ${operation} prepares its complete old state and new cache outside Source`,async t=>{
  const f=await fixture(t),old={requestId:'retained-reservation',payload:'完整保留旧状态🌿'.repeat(16000)},cache={payload:'完整新外部缓存🌿'.repeat(16000),unknown:{kept:true}},reservation=operation==='commit'?await f.reserve('request-a'):null,previous=f.seed(operation==='reserve'?'external-refresh':'external',old,'large-old'),put=f.store.putContent,read=f.store.content,createHash=crypto.createHash;
  f.store.putContent=function(bytes,...args){if((typeof bytes==='string'?Buffer.byteLength(bytes):bytes.byteLength)>65536)throw Error('Source encoded large external state');return put.call(this,bytes,...args);};f.store.content=function(id){if(Number(this.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded large external state');return read.call(this,id);};crypto.createHash=(...args)=>{const digest=createHash(...args),update=digest.update;digest.update=function(bytes,...rest){if((typeof bytes==='string'?Buffer.byteLength(bytes):bytes.byteLength)>65536)throw Error('Source hashed large external state');return update.call(this,bytes,...rest);};return digest;};let result;
  try{result=operation==='reserve'?await f.reserve('request-a'):await f.commit({requestId:'request-a',generation:reservation.generation,requestedAt:2,cache});}finally{f.store.putContent=put;f.store.content=read;crypto.createHash=createHash;}
  assert.equal(f.store.read(previous.objectId,1).data.content,JSON.stringify(old));if(operation==='reserve')assert.equal(result.generation,2);else{assert.equal(result.accepted,true);assert.equal(result.state.revision,2);assert.deepEqual(result.state.value.cache,cache);}assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('an actual replacement reservation rejects a generated candidate without an owner',async t=>{
  const f=await fixture(t),token=await f.reserve('original'),prepare=f.store.stateWriteCompute,ownership=f.store.withPreparedContentOwnership;let calls=0,hooks=0,owners=0,replaced=false;const cache={toJSON(){hooks++;return{generated:'fixed'};}};
  f.store.setStateWriteCompute(async request=>{calls++;const result=await prepare(request);if(!replaced){replaced=true;externalRefreshNative(f.store,'reserve',f.project,'issues','replacement');}return result;});f.store.withPreparedContentOwnership=function(...args){owners++;return ownership.apply(this,args);};
  const result=await f.commit({requestId:'original',generation:token.generation,requestedAt:1,cache});assert.deepEqual(result,{accepted:false,state:{objectId:null,revision:0,value:null}});assert.equal(calls,2);assert.equal(hooks,1);assert.equal(owners,0);assert.deepEqual(f.read('external-refresh').value,{requestId:'replacement'});assert.equal(runInputsSerializedResult(result),JSON.stringify(result));
});

test('a reservation replaced after actual dependency registration cannot publish its prepared cache',async t=>{
  const f=await fixture(t),token=await f.reserve('original');f.seed('external',{retained:'真实当前缓存'},'retained');const stage=f.store.stageAgentDependencies,ownership=f.store.withPreparedContentOwnership;let replaced=false,owners=0;
  f.store.stageAgentDependencies=async function(plan,...args){const proof=await stage.call(this,plan,...args);if(!replaced && plan.mode==='publish' && plan.reservationChoice){replaced=true;externalRefreshNative(f.store,'reserve',f.project,'issues','replacement');}return proof;};f.store.withPreparedContentOwnership=function(...args){owners++;return ownership.apply(this,args);};
  const result=await f.commit({requestId:'original',generation:token.generation,requestedAt:1,cache:{candidate:'过期缓存'}});assert.equal(replaced,true);assert.equal(result.accepted,false);assert.deepEqual(result.state.value,{retained:'真实当前缓存'});assert.equal(result.state.revision,1);assert.equal(owners,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('an actual late cache update reselects the Native automatic current intent and retains all fixed history',async t=>{
  const f=await fixture(t),token=await f.reserve('original'),seed=f.seed('external',{retained:'首个真实缓存'},'retained'),prepare=f.store.stateWriteCompute;let changed=false,calls=0;
  f.store.setStateWriteCompute(async request=>{calls++;const result=await prepare(request);if(!changed){changed=true;writeStateNative(f.store,'analysis',f.project,{namespace:'external',key:'issues',expectedRevision:1,value:{retained:'准备时写入的第二版'},idempotencyKey:'actual-late-cache'});}return result;});
  const cache={published:'本次接受的完整缓存'},result=await f.commit({requestId:'original',generation:token.generation,requestedAt:1,cache});assert.equal(calls,2);assert.equal(result.accepted,true);assert.equal(result.state.revision,3);assert.equal(f.store.read(seed.objectId,1).data.content,'{"retained":"首个真实缓存"}');assert.equal(f.store.read(seed.objectId,2).data.content,'{"retained":"准备时写入的第二版"}');assert.deepEqual(result.state.value.cache,cache);assert.equal(runInputsSerializedResult(result),JSON.stringify(result));
});

test('external accepted cache captures mutable Buffer bytes before awaiting reservation selection',async t=>{
  const f=await fixture(t),token=await f.reserve('original'),cache={payload:Buffer.from([0,255,128]),unknown:{kept:'调用时的字段'}},expected=JSON.parse(JSON.stringify(cache)),pending=f.commit({requestId:'original',generation:token.generation,requestedAt:1,cache});cache.payload[0]=99;cache.unknown.kept='调用后修改';const result=await pending;assert.deepEqual(result.state.value.cache,expected);assert.equal(runInputsSerializedResult(result),JSON.stringify(result));assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

for(const native of [true,false])for(const operation of ['reserve','commit'])test(`${native?'Native':'public'} external ${operation} does not retry its first actual Native write failure`,async t=>{
  const f=await fixture(t,native),token=operation==='commit'?await f.reserve('failure'):null,key=`analysis-state:${f.project}:${operation==='reserve'?'external-refresh':'external'}:issues:${operation==='reserve'?'reserve':'commit'}:failure`,run=f.store.db.run;let attempts=0;const call=()=>operation==='reserve'?f.reserve('failure'):f.commit({requestId:'failure',generation:token.generation,requestedAt:1,cache:{published:'显式重试结果'}});
  f.store.db.run=function(sql,values){const result=run.call(this,sql,values);if(sql.startsWith('INSERT INTO requests(') && values?.[1]===key){attempts++;throw Error('data_write_replay_changed');}return result;};try{await assert.rejects(async()=>call(),/data_write_replay_changed/);}finally{f.store.db.run=run;}
  assert.equal(attempts,1);assert.equal(f.read(operation==='reserve'?'external-refresh':'external').objectId,null);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM requests WHERE idempotency_key=?',[key])[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);const retried=await call();if(operation==='reserve')assert.equal(retried.generation,1);else assert.equal(retried.state.revision,1);
});

test('external rejected generations return the actual full cache with no business request, owner, or WAL write',async t=>{
  const f=await fixture(t),token=await f.reserve('current'),cache={payload:'完整当前拒绝回包🌿'.repeat(12000)};f.seed('external',cache,'current-cache');const requests=f.store.rows('SELECT COUNT(*) AS n FROM requests')[0].n,events=f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n,wal=`${f.store.filePath}-wal`,walBytes=fs.existsSync(wal)?fs.statSync(wal).size:0,ownership=f.store.withPreparedContentOwnership;let owners=0;
  f.store.withPreparedContentOwnership=function(...args){owners++;return ownership.apply(this,args);};const result=await f.commit({requestId:'stale',generation:token.generation,requestedAt:1,cache:{ignored:'候选值'}});assert.equal(result.accepted,false);assert.deepEqual(result.state.value,cache);assert.equal(runInputsSerializedResult(result),JSON.stringify(result));assert.equal(owners,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM requests')[0].n,requests);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n,events);assert.equal(fs.existsSync(wal)?fs.statSync(wal).size:0,walBytes);
});

test('external rejection does not turn an unused committed child request into a dependency',async t=>{
  const f=await fixture(t),token=await f.reserve('old');await f.commit({requestId:'old',generation:token.generation,requestedAt:1,cache:{kept:'真实已提交缓存'}});await f.reserve('new');const prepare=f.store.stateWriteCompute,key=`analysis-state:${f.project}:external:issues:commit:old`;let calls=0;
  f.store.setStateWriteCompute(async request=>{calls++;const selected=await prepare(request);if(calls===1)f.store.db.run('UPDATE requests SET committed_sequence=committed_sequence+1 WHERE actor_id=? AND idempotency_key=?',[f.store.actorId,key]);return selected;});const result=await f.commit({requestId:'old',generation:token.generation,requestedAt:1,cache:{ignored:true}});assert.equal(calls,1);assert.equal(result.accepted,false);assert.deepEqual(result.state.value.cache,{kept:'真实已提交缓存'});
});

function detachedCandidate(withHooks=false){
  const typed=new Uint8Array([0,255,128]),big=new BigInt64Array([1n]),buffer=Buffer.from(new ArrayBuffer(3)),masked=Buffer.from(new ArrayBuffer(3));
  for(const view of [typed,big,buffer,masked])structuredClone(view.buffer,{transfer:[view.buffer]});
  Object.defineProperty(masked,'toJSON',{value:null,enumerable:true});
  let hooks=0;const annotation=withHooks?{toJSON(key){hooks++;return{kept:'真实命名字段',key};}}:{kept:'真实命名字段'};
  typed.annotation=annotation;masked.annotation=annotation;
  return{value:{typed,alias:typed,big,buffer,masked},hooks:()=>hooks};
}
for(const native of [true,false])for(const withHooks of [false,true])test(`${native?'Native':'public'} external rejection and acceptance preserve detached JSON-readable views${withHooks?' with real hooks':''}`,async t=>{
  const f=await fixture(t,native),token=await f.reserve('current'),candidate=detachedCandidate(withHooks),expected=JSON.parse(JSON.stringify(candidate.value)),before=candidate.hooks();
  const rejected=await f.commit({requestId:'stale',generation:token.generation,requestedAt:1,cache:candidate.value});assert.deepEqual(rejected,{accepted:false,state:{objectId:null,revision:0,value:null}});assert.equal(candidate.hooks(),before+(!native && withHooks?3:0));
  const accepted=await f.commit({requestId:'current',generation:token.generation,requestedAt:2,cache:candidate.value});assert.equal(accepted.accepted,true);assert.deepEqual(accepted.state.value.cache,expected);assert.equal(candidate.hooks(),before+(withHooks?(native?3:6):0));assert.equal(f.store.read(accepted.state.objectId,1).data.content,JSON.stringify(accepted.state.value));assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

for(const native of [true,false])for(const visible of [false,true])test(`${native?'Native':'public'} external refresh reads a typed length getter only when JSON consumes it${visible?' visibly':''}`,async t=>{
  const f=await fixture(t,native),token=await f.reserve('current');let calls=0;const typed=new Uint8Array([0,255]),dataView=new DataView(new ArrayBuffer(2));
  Object.defineProperty(typed,'length',{enumerable:visible,get(){calls++;if(!visible)throw Error('invisible_typed_length');return'JSON可见的长度字段';}});
  Object.defineProperty(dataView,'length',{get(){calls++;throw Error('invisible_data_view_length');}});
  Object.defineProperty(typed,'buffer',{get(){calls++;throw Error('invisible_typed_buffer');}});
  const candidate={typed,dataView},rejected=await f.commit({requestId:'stale',generation:token.generation,requestedAt:1,cache:candidate});assert.equal(rejected.accepted,false);assert.equal(calls,!native && visible?1:0);
  const result=await f.commit({requestId:'current',generation:token.generation,requestedAt:2,cache:candidate});assert.equal(result.accepted,true);assert.equal(calls,visible?(native?1:2):0);assert.deepEqual(result.state.value.cache,{typed:{0:0,1:255,...(visible?{length:'JSON可见的长度字段'}:{})},dataView:{}});
});
for(const native of [true,false])for(const inherited of [false,true])test(`${native?'Native':'public'} external refresh keeps ${inherited?'inherited':'direct'} proxy data at its generation boundary`,async t=>{
  const f=await fixture(t,native),token=await f.reserve('current'),trace=[],target={kept:'代理中的完整字段'},proxy=new Proxy(target,{get(object,key,receiver){trace.push(`get:${String(key)}`);return Reflect.get(object,key,receiver);},ownKeys(object){trace.push('keys');return Reflect.ownKeys(object);},getOwnPropertyDescriptor(object,key){trace.push(`descriptor:${String(key)}`);return Reflect.getOwnPropertyDescriptor(object,key);},getPrototypeOf(object){trace.push('prototype');return Reflect.getPrototypeOf(object);}}),cache=inherited?Object.assign(Object.create(proxy),{kept:'实际自有字段'}):proxy;
  trace.length=0;const rejected=await f.commit({requestId:'stale',generation:token.generation,requestedAt:1,cache});assert.equal(rejected.accepted,false);if(native)assert.deepEqual(trace,[]);else assert.ok(trace.length>0);
  const accepted=await f.commit({requestId:'current',generation:token.generation,requestedAt:2,cache});assert.equal(accepted.accepted,true);assert.deepEqual(accepted.state.value.cache,{kept:inherited?'实际自有字段':'代理中的完整字段'});assert.ok(trace.length>0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

for(const native of [true,false])for(const shape of ['getter-empty','getter-bytes','data-empty'])test(`${native?'Native':'public'} standard Buffer JSON retains its actual ${shape} receiver length semantics`,async t=>{
  const f=await fixture(t,native),token=await f.reserve('current'),buffer=Buffer.from([11,22]);let calls=0;
  Object.defineProperty(buffer,'length',shape==='data-empty'?{value:0}:{get(){calls++;return shape==='getter-empty'?0:2;}});
  const perCall=shape==='data-empty'?0:shape==='getter-empty'?1:5,rejected=await f.commit({requestId:'stale',generation:token.generation,requestedAt:1,cache:{buffer}});assert.equal(rejected.accepted,false);assert.equal(calls,native?0:perCall);
  const accepted=await f.commit({requestId:'current',generation:token.generation,requestedAt:2,cache:{buffer}});assert.equal(accepted.accepted,true);assert.deepEqual(accepted.state.value.cache,{buffer:{type:'Buffer',data:shape==='getter-bytes'?[11,22]:[]}});assert.equal(calls,perCall*(native?1:2));assert.equal(f.store.read(accepted.state.objectId,1).data.content,JSON.stringify(accepted.state.value));
  if(shape==='getter-empty' && native)t.diagnostic(Buffer.prototype.toJSON.toString());
});
for(const native of [true,false])test(`${native?'Native':'public'} changed Buffer prototype JSON uses the real receiver during generation`,async t=>{
  const f=await fixture(t,native),token=await f.reserve('current'),buffer=Buffer.from([11,22]),original=Buffer.prototype.toJSON;let calls=0;
  Buffer.prototype.toJSON=function(key){if(this!==buffer)return original.call(this,key);calls++;assert.equal(key,'buffer');return{custom:'实际替换后的编码结果'};};
  try{
    const rejected=await f.commit({requestId:'stale',generation:token.generation,requestedAt:1,cache:{buffer}});assert.equal(rejected.accepted,false);assert.equal(calls,native?0:1);
    const accepted=await f.commit({requestId:'current',generation:token.generation,requestedAt:2,cache:{buffer}});assert.equal(accepted.accepted,true);assert.equal(calls,native?1:2);assert.deepEqual(accepted.state.value.cache,{buffer:{custom:'实际替换后的编码结果'}});
  }finally{Buffer.prototype.toJSON=original;}
});

for(const native of [true,false])for(const kind of ['proxy','hook','getter'])test(`${native?'Native':'public'} a callback-bearing child retains ordinary sibling ownership for ${kind}`,async t=>{
  const f=await fixture(t,native),token=await f.reserve('current');class Stable{#value='原稳定字段';toJSON(key){return{stable:this.#value,key};}}class StableGetter{#value='原稳定字段';get stable(){return this.#value;}}
  const opaque=kind==='proxy'?new Proxy({stable:'原稳定字段'},{}):kind==='hook'?new Stable():Object.defineProperty(new StableGetter(),'stable',{enumerable:true,get:Object.getOwnPropertyDescriptor(StableGetter.prototype,'stable').get}),bytes=new Uint8Array([11,22]),buffer=Buffer.from([11,22]),cache={plain:{text:'调用时的原字段'},bytes,alias:bytes,buffer,opaque},prepare=f.store.stateWriteCompute;
  let release,notify,paused=false;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>notify=resolve);
  if(!native)f.store.setStateWriteCompute(async request=>{const selected=await prepare(request);if(request.state && !paused){paused=true;assert.equal(selected.mode,'publish');notify();await gate;}return selected;});
  const pending=f.commit({requestId:'current',generation:token.generation,requestedAt:1,cache});if(!native)await entered;cache.plain.text='等待时调用方后改';bytes[0]=99;buffer[0]=99;release();let result;
  try{result=await pending;}finally{f.store.setStateWriteCompute(prepare);}
  assert.equal(result.accepted,true);assert.deepEqual(result.state.value.cache,{plain:{text:'调用时的原字段'},bytes:{0:11,1:22},alias:{0:11,1:22},buffer:{type:'Buffer',data:[11,22]},opaque:{stable:'原稳定字段',...(kind==='hook'?{key:'opaque'}:{})}});assert.equal(native || paused,true);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});
for(const native of [true,false])test(`${native?'Native':'public'} captured parent identity keeps one real callback before a cyclic JSON error`,async t=>{
  const f=await fixture(t,native),token=await f.reserve('current');let calls=0;const cache={plain:{kept:'原字段'}};cache.child={toJSON(){calls++;return cache;}};
  await assert.rejects(async()=>f.commit({requestId:'current',generation:token.generation,requestedAt:1,cache}),/circular|cyclic/i);assert.equal(calls,1);assert.equal(f.read('external').objectId,null);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

for(const native of [true,false])for(const shape of ['array','object'])test(`${native?'Native':'public'} callback changes to captured ${shape} retain Native reads while caller changes stay isolated`,async t=>{
  const f=await fixture(t,native),token=await f.reserve('current');let calls=0,container;
  const head={toJSON(){calls++;if(shape==='array'){container.length=1;container.length=3;container[1]='本次钩子改动';}else{container.tail='本次钩子改动';delete container.gone;}return{normalized:true};}};
  container=shape==='array'?[head,'原尾项','待移除']:{head,tail:'原尾项',gone:'待移除'};const cache={container,plain:{text:'调用时原字段'}},prepare=f.store.stateWriteCompute;let release,notify,paused=false;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>notify=resolve);
  if(!native)f.store.setStateWriteCompute(async request=>{const result=await prepare(request);if(request.state && !paused){paused=true;assert.equal(result.mode,'publish');notify();await gate;}return result;});
  const pending=f.commit({requestId:'current',generation:token.generation,requestedAt:1,cache});if(!native)await entered;cache.plain.text='等待时调用方后改';release();let result;try{result=await pending;}finally{f.store.setStateWriteCompute(prepare);}
  assert.equal(calls,1);assert.equal(result.accepted,true);assert.deepEqual(result.state.value.cache,{container:shape==='array'?[{normalized:true},'本次钩子改动',null]:{head:{normalized:true},tail:'本次钩子改动'},plain:{text:'调用时原字段'}});
});

for(const native of [true,false])for(const key of ['toString','constructor','__proto__'])test(`${native?'Native':'public'} fixed snapshots preserve owned ${key} fields after caller deletion`,async t=>{
  const f=await fixture(t,native),token=await f.reserve('current'),plain=Object.create(null);plain[key]='调用时原字段';const cache={plain,proxied:new Proxy({stable:'原Proxy'}, {})},prepare=f.store.stateWriteCompute;let release,notify,paused=false;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>notify=resolve);
  if(!native)f.store.setStateWriteCompute(async request=>{const result=await prepare(request);if(request.state && !paused){paused=true;notify();await gate;}return result;});
  const pending=f.commit({requestId:'current',generation:token.generation,requestedAt:1,cache});if(!native)await entered;delete plain[key];release();let saved;try{saved=await pending;}finally{f.store.setStateWriteCompute(prepare);}
  assert.equal(saved.accepted,true);assert.equal(Object.hasOwn(saved.state.value.cache.plain,key),true);assert.equal(saved.state.value.cache.plain[key],'调用时原字段');
});

for(const native of [true,false])for(const kind of ['typed','buffer'])for(const effect of ['stable','write','detach'])test(`${native?'Native':'public'} ${kind} fixed snapshots isolate caller edits and retain generated ${effect} data`,async t=>{
  const f=await fixture(t,native),token=await f.reserve('current'),bytes=kind==='typed'?new Uint8Array([11,22]):Buffer.from(new ArrayBuffer(2));if(kind==='buffer'){bytes[0]=11;bytes[1]=22;}let calls=0;
  const cache={effect:{toJSON(key){calls++;assert.equal(this,cache.effect);assert.equal(key,'effect');if(effect==='write')bytes[0]=77;if(effect==='detach')structuredClone(bytes.buffer,{transfer:[bytes.buffer]});return{normalized:true};}},bytes,alias:bytes,plain:{text:'调用时原字段'}},prepare=f.store.stateWriteCompute;let release,notify,paused=false;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>notify=resolve);
  if(!native)f.store.setStateWriteCompute(async request=>{const selected=await prepare(request);if(request.state && !paused){paused=true;assert.equal(selected.mode,'publish');notify();await gate;}return selected;});
  const pending=f.commit({requestId:'current',generation:token.generation,requestedAt:1,cache});if(!native)await entered;try{bytes[0]=99;bytes[1]=88;}catch{}cache.plain.text='等待时调用方后改';release();let saved;try{saved=await pending;}finally{f.store.setStateWriteCompute(prepare);}
  const values=effect==='detach'?[]:[effect==='write'?77:11,22],encoded=kind==='buffer'?{type:'Buffer',data:values}:Object.fromEntries(values.map((value,index)=>[index,value]));assert.equal(calls,1);assert.equal(saved.accepted,true);assert.deepEqual(saved.state.value.cache,{effect:{normalized:true},bytes:encoded,alias:encoded,plain:{text:'调用时原字段'}});
});
