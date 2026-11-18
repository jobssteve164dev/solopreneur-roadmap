const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs'),{canonicalJson}=require('../out/contentReferences.js'),{importStateNative}=require('./fixtures/native-state-import-oracles.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(t,type,native=false){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-state-import-')),root=path.join(base,'project');fs.mkdirSync(root);const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});const project=(await store.registerProject({root})).projectId;
  const args=(value,source)=>type==='analysis'?[project,'external','issues',value,source]:[project,value,source],call=(value,source)=>native?importStateNative(store,type,args(value,source)):store[type==='analysis'?'importAnalysisState':'importStrategyState'](...args(value,source)),read=()=>type==='analysis'?store.readAnalysisState(project,'external','issues'):store.readStrategyState(project),write=(value,expectedRevision)=>type==='analysis'?store.writeAnalysisState(project,{namespace:'external',key:'issues',value,expectedRevision,idempotencyKey:'user-choice'}):store.writeStrategyState(project,{value,expectedRevision,idempotencyKey:'user-choice'});
  const capture=async(version,value)=>{const bytes=Buffer.from(JSON.stringify(value)),source={identity:`original-${type}`,key:'state.json',hash:hash(bytes)};await store.publishMigrationSource(source,bytes,{mimeType:'application/json',encoding:'utf8'});return source;};return{store,project,args,call,read,write,capture};
}
for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} import preserves complete intent, fixed history and rollback of conflict markers`,async t=>{
  const f=await fixture(t,type,native),value={original:'完整原始状态🌿'.repeat(9000),unknown:{kept:true}},source=await f.capture(1,value),first=await f.call(value,source);assert.equal(first.receipt.revision,1);assert.deepEqual(f.read().value,value);
  const input={kind:'setting',action:'create',scope:f.project,idempotencyKey:`import-${type}:${canonicalJson(source)}`,data:{namespace:type==='analysis'?'analysis:external':'strategy',key:type==='analysis'?'issues':'preferences',owner_scope:f.project,content:JSON.stringify(value)}};assert.equal(f.store.rows('SELECT input_hash FROM requests WHERE id=?',[first.receipt.requestId])[0].input_hash,hash(canonicalJson({input,source})));
  assert.deepEqual(await f.call({unused:'仍执行JSON编码'},source),{unchanged:true});const nextValue={original:'完整更新状态🌿'.repeat(9000)},next=await f.capture(2,nextValue),updated=await f.call(nextValue,next);assert.equal(updated.receipt.objectId,first.receipt.objectId);assert.equal(updated.receipt.revision,2);assert.deepEqual(JSON.parse(f.store.read(first.receipt.objectId,1).data.content),value);
  await f.write({kept:'用户选择'},2);const lateValue={late:true},late=await f.capture(3,lateValue),before=f.store.migrationSourceState(late.identity,late.key);await assert.rejects(async()=>f.call(lateValue,late),/migration_conflict: newer_database_revision/);assert.deepEqual(f.store.migrationSourceState(late.identity,late.key),before);assert.deepEqual(f.read().value,{kept:'用户选择'});
});
for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} import reads current state and checks user choice before validating source`,async t=>{
  const f=await fixture(t,type,native);await f.write({kept:'当前用户选择'},0);await assert.rejects(async()=>f.call({candidate:true},{identity:'',key:'',hash:'invalid'}),/migration_conflict: existing_database_choice/);
  const current=f.read(),cid=f.store.rows('SELECT content_id FROM settings WHERE id=?',[current.objectId])[0].content_id;f.store.db.run('UPDATE contents SET data=zeroblob(length(data)) WHERE id=?',[cid]);await assert.rejects(async()=>f.call({candidate:true},{identity:'',key:'',hash:'invalid'}),/content_integrity_error/);
});
for(const type of ['analysis','strategy'])test(`public ${type} import prepares full JSON, original intent and prior state outside Source`,async t=>{
  const f=await fixture(t,type),value={original:'完整当前历史状态🌿'.repeat(18000)},source=await f.capture(1,value);await f.call(value,source);const nextValue={original:'完整新状态🌿'.repeat(18000)},next=await f.capture(2,nextValue),put=f.store.putContent,read=f.store.content,createHash=crypto.createHash;
  f.store.putContent=function(bytes,...args){if((typeof bytes==='string'?Buffer.byteLength(bytes):bytes.byteLength)>65536)throw Error('Source encoded large state import');return put.call(this,bytes,...args);};f.store.content=function(id){if(Number(this.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded large state import');return read.call(this,id);};crypto.createHash=(...args)=>{const digest=createHash(...args),update=digest.update;digest.update=function(bytes,...rest){if((typeof bytes==='string'?Buffer.byteLength(bytes):bytes.byteLength)>65536)throw Error('Source hashed large state import');return update.call(this,bytes,...rest);};return digest;};
  let result;try{result=await f.call(nextValue,next);}finally{f.store.putContent=put;f.store.content=read;crypto.createHash=createHash;}
  assert.equal(result.receipt.revision,2);assert.deepEqual(f.read().value,nextValue);assert.deepEqual(JSON.parse(f.store.read(result.receipt.objectId,1).data.content),value);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

for(const type of ['analysis','strategy'])test(`public ${type} import reselects a real late user choice without beginning persistent preparation`,async t=>{
  const f=await fixture(t,type),value={historical:'完整来源'},source=await f.capture(1,value),prepare=f.store.importObjectCompute,ownership=f.store.withPreparedContentOwnership;let calls=0,owners=0,userChoiceOwners=0,savingChoice=false;
  f.store.setImportObjectCompute(async request=>{const first=++calls===1,result=await prepare(request);if(first){savingChoice=true;try{await f.write({kept:'准备期间用户选择'},0);}finally{savingChoice=false;}}return result;});f.store.withPreparedContentOwnership=function(...args){if(savingChoice)userChoiceOwners++;else owners++;return ownership.apply(this,args);};
  try{await assert.rejects(async()=>f.call(value,source),/migration_conflict: existing_database_choice/);}finally{f.store.setImportObjectCompute(prepare);f.store.withPreparedContentOwnership=ownership;}
  assert.equal(calls,2);assert.equal(owners,0);assert.equal(userChoiceOwners,1);assert.deepEqual(f.read().value,{kept:'准备期间用户选择'});assert.equal(f.store.migrationSourceState(source.identity,source.key).stage,'captured');assert.equal(f.store.rows("SELECT COUNT(*) AS n FROM settings WHERE owner_scope=?",[f.project])[0].n,1);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

for(const type of ['analysis','strategy'])test(`public ${type} import rechecks the actual old content mapping before returning an unchanged source`,async t=>{
  const f=await fixture(t,type),value={historical:'原完整来源'},source=await f.capture(1,value),first=await f.call(value,source),bad=f.store.putContent('真实当前状态已不可解析','text/plain','utf8'),prepare=f.store.importObjectCompute;let calls=0;
  f.store.setImportObjectCompute(async request=>{const initial=++calls===1,result=await prepare(request);if(initial)f.store.db.run('UPDATE settings SET content_id=? WHERE id=?',[bad,first.receipt.objectId]);return result;});
  try{await assert.rejects(async()=>f.call(value,source),/Unexpected token|not valid JSON/);}finally{f.store.setImportObjectCompute(prepare);}
  assert.equal(calls,2);assert.equal(f.store.readMetadata(first.receipt.objectId).revision,1);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} unchanged import still encodes this value after reading current state`,async t=>{
  const f=await fixture(t,type,native),value={historical:'原完整来源'},source=await f.capture(1,value);await f.call(value,source);const circular={};circular.self=circular;await assert.rejects(async()=>f.call(circular,source),/circular/i);assert.deepEqual(f.read().value,value);
});

for(const type of ['analysis','strategy'])test(`public ${type} import rolls back the final real Native event and can retry the original source`,async t=>{
  const f=await fixture(t,type),value={historical:'原完整来源'},source=await f.capture(1,value),tables=['objects','object_revisions','requests','events','settings'],counts=()=>tables.map(table=>f.store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n),before=counts();f.store.db.run("CREATE TEMP TRIGGER reject_state_import_event BEFORE INSERT ON events WHEN NEW.kind='setting.create' BEGIN SELECT RAISE(ABORT,'state_import_final_event_failed'); END");
  await assert.rejects(async()=>f.call(value,source),/state_import_final_event_failed/);assert.deepEqual(counts(),before);assert.equal(f.read().objectId,null);assert.equal(f.store.migrationSourceState(source.identity,source.key).stage,'captured');assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);f.store.db.run('DROP TRIGGER reject_state_import_event');assert.equal((await f.call(value,source)).receipt.revision,1);
});

for(const type of ['analysis','strategy'])test(`public ${type} import retains the original global state key and scope`,async t=>{
  const f=await fixture(t,type),value={original:'完整全局状态🌿'},source=await f.capture(1,value),args=type==='analysis'?[null,'usage','local',value,source]:[null,value,source],result=await f.store[type==='analysis'?'importAnalysisState':'importStrategyState'](...args),object=f.store.read(result.receipt.objectId),read=()=>type==='analysis'?f.store.readAnalysisState(null,'usage','local'):f.store.readStrategyState(null);
  assert.equal(object.projectId,null);assert.equal(object.data.owner_scope,'global');assert.equal(object.data.key,type==='analysis'?'local':'cache');assert.deepEqual(read().value,value);assert.deepEqual(await f.store[type==='analysis'?'importAnalysisState':'importStrategyState'](...args),{unchanged:true});assert.equal(read().revision,1);
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} import preserves sparse array length in complete JSON and original intent`,async t=>{
  const f=await fixture(t,type,native),value={kept:'完整原始值',tail:new Array(3),mixed:[,'中间值',,,]},text=JSON.stringify(value),source=await f.capture(1,value),result=await f.call(value,source),object=f.store.read(result.receipt.objectId,1);
  assert.equal(object.data.content,text);assert.deepEqual(f.read().value,JSON.parse(text));assert.equal(f.read().value.tail.length,3);assert.equal(f.read().value.mixed.length,4);
  const input={kind:'setting',action:'create',scope:f.project,idempotencyKey:`import-${type}:${canonicalJson(source)}`,data:{namespace:type==='analysis'?'analysis:external':'strategy',key:type==='analysis'?'issues':'preferences',owner_scope:f.project,content:text}};assert.equal(f.store.rows('SELECT input_hash FROM requests WHERE id=?',[result.receipt.requestId])[0].input_hash,hash(canonicalJson({input,source})));
});

for(const type of ['analysis','strategy'])for(const shape of ['root-sparse','nested-sparse','dense-undefined'])test(`public ${type} import retains Native JSON for ${shape} arrays`,async t=>{
  const f=await fixture(t,type),comparison=await fixture(t,type,true),value=shape==='root-sparse'?new Array(3):shape==='nested-sparse'?{nested:[new Array(2),[,'保留值',,,]],tail:new Array(1)}:[undefined,'保留值',undefined],text=JSON.stringify(value),source=await f.capture(1,value),originalSource=await comparison.capture(1,value),oracle=await comparison.call(value,originalSource);
  const result=await f.call(value,source);assert.equal(f.store.read(result.receipt.objectId,1).data.content,text);assert.equal(comparison.store.read(oracle.receipt.objectId,1).data.content,text);assert.deepEqual(f.read().value,JSON.parse(text));
});

for(const native of [true,false])test(`${native?'Native':'public'} ordinary memory write preserves sparse JSON metadata and its original hash`,async t=>{
  const f=await fixture(t,'analysis'),metadata={tail:new Array(3),dense:[null,'完整值',null]},input={kind:'memory',action:'create',scope:f.project,idempotencyKey:'ordinary-array-metadata',data:{category:'project',title:'完整普通记录',status:'active',content:'完整正文',metadata_json:metadata}},receipt=await(native?f.store.write(input):f.store.publishWrite(input)),object=f.store.read(receipt.objectId,1);
  assert.equal(object.data.metadata_json,canonicalJson(metadata));assert.equal(f.store.rows('SELECT input_hash FROM requests WHERE id=?',[receipt.requestId])[0].input_hash,hash(canonicalJson(input)));
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} import preserves distinct Buffer Date and Uint8Array JSON types`,async t=>{
  const f=await fixture(t,type,native),binary=Buffer.from([0,255,128]),value={binary,date:new Date('2026-11-16T00:00:00.000Z'),typed:new Uint8Array(binary.buffer,binary.byteOffset,binary.byteLength),duplicate:binary},text=JSON.stringify(value),source=await f.capture(1,value),result=await f.call(value,source),object=f.store.read(result.receipt.objectId,1);
  assert.equal(object.data.content,text);assert.deepEqual(f.read().value,JSON.parse(text));const input={kind:'setting',action:'create',scope:f.project,idempotencyKey:`import-${type}:${canonicalJson(source)}`,data:{namespace:type==='analysis'?'analysis:external':'strategy',key:type==='analysis'?'issues':'preferences',owner_scope:f.project,content:text}};assert.equal(f.store.rows('SELECT input_hash FROM requests WHERE id=?',[result.receipt.requestId])[0].input_hash,hash(canonicalJson({input,source})));
});

for(const type of ['analysis','strategy'])test(`public ${type} import preserves a root Buffer without converting a real typed array`,async t=>{
  const f=await fixture(t,type),original=await fixture(t,type,true),value=Buffer.from([0,255,128]),source=await f.capture(1,value),originalSource=await original.capture(1,value),oracle=await original.call(value,originalSource),result=await f.call(value,source);assert.equal(f.store.read(result.receipt.objectId,1).data.content,original.store.read(oracle.receipt.objectId,1).data.content);assert.deepEqual(f.read().value,{type:'Buffer',data:[0,255,128]});
});

test('large Buffer state imports encode original JSON and read prior Buffer history outside Source',async t=>{
  const f=await fixture(t,'analysis'),oldValue={binary:Buffer.alloc(128*1024,7)},source=await f.capture(1,oldValue);await f.call(oldValue,source);const value={binary:Buffer.alloc(128*1024,9),typed:new Uint8Array([1,2,3])},text=JSON.stringify(value),next=await f.capture(2,value),put=f.store.putContent,read=f.store.content,createHash=crypto.createHash;
  f.store.putContent=function(bytes,...args){if((typeof bytes==='string'?Buffer.byteLength(bytes):bytes.byteLength)>65536)throw Error('Source encoded large Buffer state');return put.call(this,bytes,...args);};f.store.content=function(id){if(Number(this.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded large Buffer state');return read.call(this,id);};crypto.createHash=(...args)=>{const digest=createHash(...args),update=digest.update;digest.update=function(bytes,...rest){if((typeof bytes==='string'?Buffer.byteLength(bytes):bytes.byteLength)>65536)throw Error('Source hashed large Buffer state');return update.call(this,bytes,...rest);};return digest;};
  let result;try{result=await f.call(value,next);}finally{f.store.putContent=put;f.store.content=read;crypto.createHash=createHash;}
  assert.equal(result.receipt.revision,2);assert.equal(f.store.read(result.receipt.objectId,2).data.content,text);assert.equal(f.store.read(result.receipt.objectId,1).data.content,JSON.stringify(oldValue));assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} import preserves the complete JSON-visible nonplain container graph`,async t=>{
  class Payload{constructor(){this.label='完整类字段';this.binary=Buffer.from([0,255,128]);this.tail=new Array(2);}}
  const f=await fixture(t,type,native),error=Object.assign(new Error('不进入JSON的内部消息'),{code:'E_VISIBLE',detail:new Payload()}),map=Object.assign(new Map([['ignored','内部Map数据不进入JSON']]),{annotation:new Payload()}),set=Object.assign(new Set(['ignored']),{annotation:error}),regexp=Object.assign(/original/u,{annotation:new Payload()}),dataView=Object.assign(new DataView(new ArrayBuffer(8)),{annotation:new Payload()}),arrayBuffer=Object.assign(new ArrayBuffer(8),{annotation:new Payload()}),weakMap=Object.assign(new WeakMap(),{annotation:new Payload()}),value={dto:new Payload(),error,map,set,regexp,dataView,arrayBuffer,weakMap,url:new URL('https://example.test/完整路径?q=原值'),boxed:[new String('原字符串'),new Number(3),new Boolean(false),Object.assign(Object(Symbol('原符号')),{annotation:new Payload()})],ignored:Symbol('不进入JSON的值'),optional:()=>1,array:[undefined,Symbol('原空位'),()=>1]},text=JSON.stringify(value),source=await f.capture(1,value),result=await f.call(value,source),object=f.store.read(result.receipt.objectId,1);
  assert.equal(object.data.content,text);assert.deepEqual(f.read().value,JSON.parse(text));const input={kind:'setting',action:'create',scope:f.project,idempotencyKey:`import-${type}:${canonicalJson(source)}`,data:{namespace:type==='analysis'?'analysis:external':'strategy',key:type==='analysis'?'issues':'preferences',owner_scope:f.project,content:text}};assert.equal(f.store.rows('SELECT input_hash FROM requests WHERE id=?',[result.receipt.requestId])[0].input_hash,hash(canonicalJson({input,source})));
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} import keeps the original boxed BigInt encoding error before source hash validation`,async t=>{
  const f=await fixture(t,type,native),source=await f.capture(1,{original:'真实来源'});await assert.rejects(async()=>f.call(Object(5n),{...source,hash:'invalid'}),/serialize a BigInt/);assert.equal(f.read().objectId,null);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} import preserves typed-view JSON-visible named properties and aliases`,async t=>{
  class Detail{constructor(){this.binary=Buffer.from([0,255,128]);this.tail=new Array(2);}}
  const f=await fixture(t,type,native),view=Object.assign(new Uint8Array([3,4]),{annotation:new Detail(),'01':'不是索引的字段'}),value={view,again:view},text=JSON.stringify(value),source=await f.capture(1,value),result=await f.call(value,source);assert.equal(f.store.read(result.receipt.objectId,1).data.content,text);assert.deepEqual(f.read().value,JSON.parse(text));
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} import owns shared-memory JSON bytes before the caller changes them`,async t=>{
  const f=await fixture(t,type,native),shared=new SharedArrayBuffer(4),bytes=new Uint8Array(shared);bytes.set([0,255,128,3]);const value={binary:Buffer.from(shared),typed:Object.assign(new Uint16Array(shared),{annotation:'完整自有字段'})},text=JSON.stringify(value),source=await f.capture(1,value),pending=f.call(value,source);bytes.fill(9);const result=await pending;assert.equal(f.store.read(result.receipt.objectId,1).data.content,text);assert.deepEqual(f.read().value,JSON.parse(text));
});

for(const type of ['analysis','strategy'])test(`public ${type} typed-view cycles keep the Native encoding failure and leave no business root`,async t=>{
  const f=await fixture(t,type),original=await fixture(t,type,true),view=new Uint8Array([3,4]);view.self=view;const source=await f.capture(1,{original:'完整来源'}),nativeSource=await original.capture(1,{original:'完整来源'});await assert.rejects(async()=>original.call(view,nativeSource),/circular/i);await assert.rejects(async()=>f.call(view,source),/circular/i);assert.equal(f.read().objectId,null);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

for(const native of [true,false])test(`${native?'Native':'public'} ordinary writes capture shared-memory metadata before a later caller mutation`,async t=>{
  const f=await fixture(t,'analysis'),shared=new SharedArrayBuffer(4),bytes=new Uint8Array(shared);bytes.set([0,255,128,3]);const metadata={typed:bytes},text=canonicalJson(metadata),input={kind:'memory',action:'create',scope:f.project,idempotencyKey:'ordinary-shared-metadata',data:{category:'project',title:'完整普通记录',status:'active',content:'完整正文',metadata_json:metadata}},expectedHash=hash(canonicalJson(input)),pending=native?f.store.write(input):f.store.publishWrite(input);bytes.fill(9);const result=await pending;assert.equal(f.store.read(result.objectId,1).data.metadata_json,text);assert.equal(f.store.rows('SELECT input_hash FROM requests WHERE id=?',[result.requestId])[0].input_hash,expectedHash);
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} import preserves native raw JSON literal bytes and parsed values`,async t=>{
  const f=await fixture(t,type,native),raw=JSON.rawJSON('1e3'),value={numeric:raw,again:raw,quoted:JSON.rawJSON('"raw\\u002dvalue"'),empty:JSON.rawJSON('null'),lookalike:{rawJSON:'1e3'},typed:Object.assign(new Uint8Array([3,4]),{raw})},text=JSON.stringify(value),source=await f.capture(1,value),result=await f.call(value,source);assert.equal(f.store.read(result.receipt.objectId,1).data.content,text);assert.deepEqual(f.read().value,{numeric:1000,again:1000,quoted:'raw-value',empty:null,lookalike:{rawJSON:'1e3'},typed:{0:3,1:4,raw:1000}});
  const input={kind:'setting',action:'create',scope:f.project,idempotencyKey:`import-${type}:${canonicalJson(source)}`,data:{namespace:type==='analysis'?'analysis:external':'strategy',key:type==='analysis'?'issues':'preferences',owner_scope:f.project,content:text}};assert.equal(f.store.rows('SELECT input_hash FROM requests WHERE id=?',[result.receipt.requestId])[0].input_hash,hash(canonicalJson({input,source})));
});

for(const type of ['analysis','strategy'])test(`public ${type} import preserves a root native raw JSON literal`,async t=>{
  const f=await fixture(t,type),value=JSON.rawJSON('1e3'),source=await f.capture(1,value),result=await f.call(value,source);assert.equal(f.store.read(result.receipt.objectId,1).data.content,'1e3');assert.equal(f.read().value,1000);
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} import applies the original toJSON receiver key and hidden-field contract`,async t=>{
  const f=await fixture(t,type,native),calls=[],value={internal:'原来不输出的字段',toJSON(key){calls.push({key,receiver:this===value});return{published:'正式状态',atKey:key};}},source=await f.capture(1,value);calls.length=0;const result=await f.call(value,source);assert.deepEqual(calls,[{key:'',receiver:true}]);assert.equal(f.store.read(result.receipt.objectId,1).data.content,'{"published":"正式状态","atKey":""}');assert.deepEqual(f.read().value,{published:'正式状态',atKey:''});calls.length=0;assert.deepEqual(await f.call(value,source),{unchanged:true});assert.deepEqual(calls,[{key:'',receiver:true}]);
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} current and database-choice errors retain their order after generation`,async t=>{
  const f=await fixture(t,type,native);await f.write({kept:'用户选择'},0);let calls=0;const value={toJSON(){calls++;if(native)throw Error('input_hook_must_not_run');return{generated:'fixed'};}},source={identity:'original-hooks',key:'state.json',hash:'invalid'};await assert.rejects(async()=>f.call(value,source),/migration_conflict: existing_database_choice/);assert.equal(calls,native?0:1);const current=f.read(),cid=f.store.rows('SELECT content_id FROM settings WHERE id=?',[current.objectId])[0].content_id;f.store.db.run('UPDATE contents SET data=zeroblob(length(data)) WHERE id=?',[cid]);await assert.rejects(async()=>f.call(value,source),/content_integrity_error/);assert.equal(calls,native?0:2);
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} nested hooks retain occurrence keys private receivers and ignored getters`,async t=>{
  const calls=[];class Published{#text='私有正式值';toJSON(key){calls.push(key);return{published:this.#text,key};}}
  const shared=new Published(),value={first:shared,array:[shared],nested:{last:shared},hidden:{get internal(){throw Error('hidden_getter_must_not_run');},toJSON(key){calls.push(key);return{key,published:'只输出正式字段'};}}},f=await fixture(t,type,native),text=JSON.stringify(value),source=await f.capture(1,value);calls.length=0;const result=await f.call(value,source);assert.deepEqual(calls,['first','0','last','hidden']);assert.equal(f.store.read(result.receipt.objectId,1).data.content,text);assert.deepEqual(f.read().value,JSON.parse(text));
});

for(const type of ['analysis','strategy'])for(const shape of ['date','buffer','object'])test(`public ${type} hook ${shape} return values retain Native single-hook semantics`,async t=>{
  const f=await fixture(t,type),original=await fixture(t,type,true);let calls=0;const value={toJSON(){calls++;return shape==='date'?new Date('2026-11-16T00:00:00.000Z'):shape==='buffer'?Buffer.from([0,255,128]):{published:'正式值',toJSON(){throw Error('replacement_hook_must_not_run');}};}},source=await f.capture(1,value),originalSource=await original.capture(1,value);calls=0;const oracle=await original.call(value,originalSource);assert.equal(calls,1);calls=0;const result=await f.call(value,source);assert.equal(calls,1);assert.equal(f.store.read(result.receipt.objectId,1).data.content,original.store.read(oracle.receipt.objectId,1).data.content);
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} hook failures precede source hash validation without a business root`,async t=>{
  const f=await fixture(t,type,native),source=await f.capture(1,{original:'真实来源'});let calls=0;const value={toJSON(){calls++;throw Error('original_hook_encoding_failed');}};await assert.rejects(async()=>f.call(value,{...source,hash:'invalid'}),/original_hook_encoding_failed/);assert.equal(calls,1);assert.equal(f.read().objectId,null);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

test('state input hook return graphs keep large JSON encoding and prior reads outside Source',async t=>{
  const f=await fixture(t,'analysis'),old={published:'完整历史🌿'.repeat(16000)},firstValue={toJSON(){return old;}},source=await f.capture(1,firstValue);await f.call(firstValue,source);const next={published:'完整新版本🌿'.repeat(16000),binary:Buffer.alloc(128*1024,7)},value={toJSON(){return next;}},text=JSON.stringify(next),nextSource=await f.capture(2,value),put=f.store.putContent,read=f.store.content,createHash=crypto.createHash;
  f.store.putContent=function(bytes,...args){if((typeof bytes==='string'?Buffer.byteLength(bytes):bytes.byteLength)>65536)throw Error('Source encoded a large hook result');return put.call(this,bytes,...args);};f.store.content=function(id){if(Number(this.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded prior hook history');return read.call(this,id);};crypto.createHash=(...args)=>{const digest=createHash(...args),update=digest.update;digest.update=function(bytes,...rest){if((typeof bytes==='string'?Buffer.byteLength(bytes):bytes.byteLength)>65536)throw Error('Source hashed a large hook result');return update.call(this,bytes,...rest);};return digest;};
  let result;try{result=await f.call(value,nextSource);}finally{f.store.putContent=put;f.store.content=read;crypto.createHash=createHash;}
  assert.equal(f.store.read(result.receipt.objectId,2).data.content,text);assert.equal(f.store.read(result.receipt.objectId,1).data.content,JSON.stringify(old));assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} array hooks retain the original initial serialization length`,async t=>{
  const f=await fixture(t,type,native),array=[];let calls=0;const first={toJSON(key){calls++;array.push({unexpected:'编码开始后追加的元素'});return{published:'原始元素',key};}};array.push(first);const source=await f.capture(1,array);array.length=1;calls=0;const result=await f.call(array,source);assert.equal(calls,1);assert.equal(array.length,2);assert.equal(f.store.read(result.receipt.objectId,1).data.content,'[{"published":"原始元素","key":"0"}]');
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} shrinking array hooks retain trailing nulls`,async t=>{
  const f=await fixture(t,type,native),array=[];let calls=0;const first={toJSON(key){calls++;array.length=1;return{published:'保留初始长度',key};}};array.push(first,'随后移除');const source=await f.capture(1,array);array.push('随后移除');calls=0;const result=await f.call(array,source);assert.equal(calls,1);assert.equal(array.length,1);assert.equal(f.store.read(result.receipt.objectId,1).data.content,'[{"published":"保留初始长度","key":"0"},null]');
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} array gaps retain inherited JSON-visible elements`,async t=>{
  const f=await fixture(t,type,native),value=['首项',,'尾项'],prototype=Object.create(Array.prototype);Object.defineProperty(prototype,'1',{value:{published:'原型中的实际元素'},configurable:true});Object.setPrototypeOf(value,prototype);const source=await f.capture(1,value),result=await f.call(value,source);assert.equal(f.store.read(result.receipt.objectId,1).data.content,'["首项",{"published":"原型中的实际元素"},"尾项"]');
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} array capture owns inherited values before awaiting`,async t=>{
  const f=await fixture(t,type,native),value=['首项',,'尾项'],prototype=Object.create(Array.prototype),element={published:'本次输入'};Object.defineProperty(prototype,'1',{value:element,configurable:true});Object.setPrototypeOf(value,prototype);const source=await f.capture(1,value),pending=f.call(value,source);element.published='调用方随后修改';const result=await pending;assert.equal(f.store.read(result.receipt.objectId,1).data.content,'["首项",{"published":"本次输入"},"尾项"]');
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} array JSON retains nonenumerable indexed values`,async t=>{
  const f=await fixture(t,type,native),value=['首项',,'尾项'];Object.defineProperty(value,'1',{value:{published:'不可枚举的实际元素'},configurable:true});const source=await f.capture(1,value),result=await f.call(value,source);assert.equal(f.store.read(result.receipt.objectId,1).data.content,'["首项",{"published":"不可枚举的实际元素"},"尾项"]');
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} array JSON ignores nonindexed getters`,async t=>{
  const f=await fixture(t,type,native),value=['实际元素'];let calls=0;Object.defineProperty(value,'ignored',{enumerable:true,get(){calls++;throw Error('ignored_array_property_must_not_run');}});const source=await f.capture(1,value),result=await f.call(value,source);assert.equal(calls,0);assert.equal(f.store.read(result.receipt.objectId,1).data.content,'["实际元素"]');
});

test('large nested DTO Buffer fields and Error history encode outside Source',async t=>{
  class Payload{constructor(byte){this.label='完整嵌套状态';this.binary=Buffer.alloc(128*1024,byte);}}
  const f=await fixture(t,'analysis'),oldValue={dto:new Payload(7),error:Object.assign(new Error('内部消息'),{detail:new Payload(8)})},source=await f.capture(1,oldValue);await f.call(oldValue,source);const value={dto:new Payload(9),error:Object.assign(new Error('内部消息'),{detail:new Payload(10)})},text=JSON.stringify(value),next=await f.capture(2,value),put=f.store.putContent,read=f.store.content,createHash=crypto.createHash;
  f.store.putContent=function(bytes,...args){if((typeof bytes==='string'?Buffer.byteLength(bytes):bytes.byteLength)>65536)throw Error('Source encoded nested DTO state');return put.call(this,bytes,...args);};f.store.content=function(id){if(Number(this.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded nested DTO state');return read.call(this,id);};crypto.createHash=(...args)=>{const digest=createHash(...args),update=digest.update;digest.update=function(bytes,...rest){if((typeof bytes==='string'?Buffer.byteLength(bytes):bytes.byteLength)>65536)throw Error('Source hashed nested DTO state');return update.call(this,bytes,...rest);};return digest;};
  let result;try{result=await f.call(value,next);}finally{f.store.putContent=put;f.store.content=read;crypto.createHash=createHash;}
  assert.equal(f.store.read(result.receipt.objectId,2).data.content,text);assert.equal(f.store.read(result.receipt.objectId,1).data.content,JSON.stringify(oldValue));assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} imported values preserve detached byte JSON with and without caller hooks`,async t=>{
  const f=await fixture(t,type,native);
  for(const withHooks of [false,true]){
    const typed=new Uint8Array([0,255]),buffer=Buffer.from(new ArrayBuffer(2));for(const view of [typed,buffer])structuredClone(view.buffer,{transfer:[view.buffer]});let calls=0;
    typed.annotation=withHooks?{toJSON(key){calls++;return{kept:'真实可见字段',key};}}:{kept:'真实可见字段'};
    const value={typed,alias:typed,buffer},expected=JSON.stringify(value),source=await f.capture(withHooks?2:1,value),before=calls,result=await f.call(value,source);
    assert.equal(f.store.read(result.receipt.objectId,result.receipt.revision).data.content,expected);assert.deepEqual(f.read().value,JSON.parse(expected));assert.equal(calls,before+(withHooks?2:0));assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
  }
});

for(const type of ['analysis','strategy'])for(const native of [true,false])test(`${native?'Native':'public'} ${type} imported mixed callback capture owns plain bytes and raw JSON before readonly awaits`,async t=>{
  const f=await fixture(t,type,native),bytes=new Uint8Array([11,22]),buffer=Buffer.from([11,22]),value={plain:{text:'调用时原字段'},bytes,buffer,proxied:new Proxy({stable:'原Proxy'},{}),...(typeof JSON.rawJSON==='function'?{raw:JSON.rawJSON('9007199254740993')}:{})},expected=JSON.stringify(value),source=await f.capture(1,value),prepare=f.store.importObjectCompute;let release,notify,paused=false;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>notify=resolve);
  if(!native)f.store.setImportObjectCompute(async request=>{const result=await prepare(request);if(request.state && !paused){paused=true;assert.equal(result.mode,'publish');notify();await gate;}return result;});
  const pending=f.call(value,source);if(!native)await entered;value.plain.text='等待时后改';bytes[0]=99;buffer[0]=99;release();let saved;try{saved=await pending;}finally{f.store.setImportObjectCompute(prepare);}
  assert.equal(f.store.read(saved.receipt.objectId,1).data.content,expected);assert.deepEqual(f.read().value,JSON.parse(expected));assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});
