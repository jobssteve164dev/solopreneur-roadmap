const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');
const {writeStateNative}=require('./fixtures/native-daily-state-oracles.cjs'),{importStateNative}=require('./fixtures/native-state-import-oracles.cjs');

async function fixture(t,type,flow,native=false){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-fixed-state-')),root=path.join(base,'project');fs.mkdirSync(root);const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});const project=(await store.registerProject({root})).projectId;
  const capture=async value=>{const bytes=Buffer.from(JSON.stringify(value)),source={identity:`fixed-${type}:${root}`,key:'state.json',hash:crypto.createHash('sha256').update(bytes).digest('hex')};await store.publishMigrationSource(source,bytes,{mimeType:'application/json',encoding:'utf8'});return source;};
  const call=(value,key,source,expectedRevision=0)=>{
    if(flow==='import'){const args=type==='analysis'?[project,'snapshot','current',value,source]:[project,value,source];return native?importStateNative(store,type,args):store[type==='analysis'?'importAnalysisState':'importStrategyState'](...args);}
    const input={...(type==='analysis'?{namespace:'snapshot',key:'current'}:{}),value,expectedRevision,idempotencyKey:key};return native?writeStateNative(store,type,project,input):store[type==='analysis'?'writeAnalysisState':'writeStrategyState'](project,input);
  };
  const read=()=>type==='analysis'?store.readAnalysisState(project,'snapshot','current'):store.readStrategyState(project),prepare=flow==='import'?store.importObjectCompute:store.stateWriteCompute,setPrepare=value=>flow==='import'?store.setImportObjectCompute(value):store.setStateWriteCompute(value);
  return{store,project,capture,call,read,prepare,setPrepare};
}

for(const type of ['analysis','strategy'])for(const flow of ['save','import'])for(const callerValue of [55,99])test(`${type} ${flow} owns generated data before the first Reader await with ${callerValue===99?'same-value caller rewrites':'later caller changes'}`,async t=>{
  const f=await fixture(t,type,flow),expected={effect:'generated',plain:{counter:99},bytes:{0:99,1:22},buffer:{type:'Buffer',data:[99,22]}},source=flow==='import'?await f.capture(expected):undefined;let generations=0,release,notify,paused=false;
  const value={effect:{toJSON(){generations++;value.plain.counter=99;value.bytes[0]=99;value.buffer[0]=99;return'generated';}},plain:{counter:11},bytes:new Uint8Array([11,22]),buffer:Buffer.from([11,22])},gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>notify=resolve);
  f.setPrepare(async request=>{if(!paused){paused=true;notify();await gate;}return f.prepare(request);});const pending=f.call(value,'owned-before-read',source);
  try{await entered;const generatedBeforeWait=generations;value.plain.counter=callerValue;value.bytes[0]=callerValue;value.buffer[0]=callerValue;release();await pending;assert.deepEqual(f.read().value,expected);assert.equal(generatedBeforeWait,1);assert.equal(generations,1);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);}finally{release();await pending.catch(()=>undefined);}
});

for(const type of ['analysis','strategy'])for(const flow of ['save','import'])test(`${type} ${flow} generation failure does not enter Reader preparation or create business state`,async t=>{
  const f=await fixture(t,type,flow),source=flow==='import'?await f.capture({captured:'source'}):undefined,before=['objects','requests','events'].map(table=>f.store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n);let generations=0,preparations=0;
  f.setPrepare(async request=>{preparations++;return f.prepare(request);});await assert.rejects(async()=>f.call({toJSON(){generations++;throw Error('fixed_generation_failed');}},'failed-generation',source),/fixed_generation_failed/);assert.equal(generations,1);assert.equal(preparations,0);assert.equal(f.read().objectId,null);assert.deepEqual(['objects','requests','events'].map(table=>f.store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n),before);
});

for(const type of ['analysis','strategy'])for(const flow of ['save','import'])test(`${type} ${flow} reselects actual changed metadata without running its generator again`,async t=>{
  const f=await fixture(t,type,flow),initial={history:'kept'},oldSource=flow==='import'?await f.capture(initial):undefined;await f.call(initial,'initial',oldSource);const current=f.read(),cid=f.store.rows('SELECT content_id FROM settings WHERE id=?',[current.objectId])[0].content_id,expected={generated:'once'},source=flow==='import'?await f.capture(expected):undefined;let generations=0,changed=false;const generationAtPrepare=[];
  f.setPrepare(async request=>{generationAtPrepare.push(generations);const result=await f.prepare(request);if(!changed){changed=true;f.store.db.run('UPDATE contents SET mime_type=? WHERE id=?',['application/json;profile=fixed-snapshot-reselect',cid]);}return result;});
  await f.call({toJSON(){generations++;return expected;}},'reselected',source,1);assert.ok(generationAtPrepare.length>=2);assert.ok(generationAtPrepare.every(count=>count===1));assert.equal(generations,1);assert.equal(f.read().revision,2);assert.deepEqual(f.read().value,expected);assert.equal(f.store.read(current.objectId,1).data.content,JSON.stringify(initial));
});
for(const type of ['analysis','strategy'])for(const flow of ['save','import'])for(const native of [true,false])for(const rich of [false,true])test(`${native?'Native':'public'} ${type} ${flow} retains a complete ${rich?512:3500}-level ${rich?'typed and raw':'ordinary'} JSON value through the real Worker chain`,async t=>{
  const f=await fixture(t,type,flow,native);let value=rich?{text:'完整🌿',buffer:Buffer.from([0,255]),typed:Object.assign(new Uint8Array([1,2]),{annotation:'kept'}),...(JSON.rawJSON?{raw:JSON.rawJSON('1e3')}:{})}:0;for(let depth=0;depth<(rich?512:3500);depth++)value=[value];const text=JSON.stringify(value),decoded=JSON.stringify(JSON.parse(text));if(!rich)assert.equal(Buffer.byteLength(text),7001);const source=flow==='import'?await f.capture(value):undefined,result=await f.call(value,'deep-json',source),id=flow==='import'?result.receipt.objectId:result.objectId;
  assert.equal(f.store.read(id,1).data.content,text);assert.equal(JSON.stringify(f.read().value),decoded);if(flow==='save')assert.equal(JSON.stringify(result.value),decoded);for(const table of ['content_lifecycle_prepare_owners','content_lifecycle_prepare_pins'])assert.equal(f.store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n,0,table);
});
