const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs'),{runInputsSerializedResult}=require('../out/db/runInputsPublication.js');

test('actual diagnostic append preserves complete canonical payload, current input result and zero-write replay outside Source codecs',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-diagnostic-publication-')),store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});const call=input=>operations({operation:'append_diagnostic_event',input}),full='完整诊断上下文🌿'.repeat(14000),input={kind:'operation',occurredAt:new Date().toISOString(),scope:'runtime.fixture',payload:{z:3,diagnosticFullText:full,a:1},idempotencyKey:'complete-diagnostic'},stringify=JSON.stringify,rows=store.rows;
  const large=value=>typeof value==='string' && value.length>65536 || typeof value?.diagnosticFullText==='string' && value.diagnosticFullText.length>65536 || typeof value?.payload?.diagnosticFullText==='string' && value.payload.diagnosticFullText.length>65536;
  JSON.stringify=function(value,...args){if(large(value))throw Error('Source encoded large diagnostic JSON');return stringify.call(this,value,...args);};store.rows=function(sql,...args){const result=rows.call(this,sql,...args);if(sql.includes('diagnostic_events') && result.some(value=>typeof value.payload_json==='string' && value.payload_json.length>65536))throw Error('Source fetched large existing diagnostic TEXT');return result;};
  const wal=()=>{const value=fs.readFileSync(store.filePath+'-wal');return{length:value.length,sha:crypto.createHash('sha256').update(value).digest('hex')};};
  try{
    const first=await call(input);assert.deepEqual(first,input);assert.equal(typeof runInputsSerializedResult(first),'string');assert.equal(crypto.createHash('sha256').update(runInputsSerializedResult(first)).digest('hex'),crypto.createHash('sha256').update(stringify(input)).digest('hex'));const before=wal(),reordered={...input,payload:{a:1,diagnosticFullText:full,z:3}},replay=await call(reordered);assert.deepEqual(replay,reordered);assert.deepEqual(Object.keys(replay.payload),['a','diagnosticFullText','z']);assert.equal(typeof runInputsSerializedResult(replay),'string');assert.equal(crypto.createHash('sha256').update(runInputsSerializedResult(replay)).digest('hex'),crypto.createHash('sha256').update(stringify(reordered)).digest('hex'));assert.deepEqual(wal(),before);
    await assert.rejects(call({...input,payload:{diagnosticFullText:full+'changed'}}),/idempotency_conflict/);await assert.rejects(call({...input,payload:{a:1}}),/idempotency_conflict/);assert.deepEqual(wal(),before);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
  }finally{JSON.stringify=stringify;store.rows=rows;}
  assert.deepEqual(JSON.parse(store.rows('SELECT payload_json FROM diagnostic_events WHERE idempotency_key=?',[input.idempotencyKey])[0].payload_json),input.payload);assert.equal(store.rows('SELECT COUNT(*) AS n FROM diagnostic_events')[0].n,1);
});

test('diagnostic fast-path budgets exclude large UTF8, escaped strings and keys before Source encoding',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-diagnostic-budget-')),store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);
  t.after(async()=>{await operations.close();store.close();});
  const stringify=JSON.stringify;
  JSON.stringify=function(value,...args){const result=stringify.call(this,value,...args);if(typeof value==='string' && Buffer.byteLength(result)>65536)throw Error('Source encoded an over-budget diagnostic string');return result;};
  try{
    for(const [index,payload] of [{body:'中'.repeat(50000)},{body:'\u0000'.repeat(12000)},{body:'\ud800'.repeat(12000)},{['中'.repeat(30000)]:'完整键名'}].entries()){
      const input={kind:'operation',occurredAt:new Date().toISOString(),scope:'budget.fixture',payload,idempotencyKey:`diagnostic-byte-budget:${index}`},result=await operations({operation:'append_diagnostic_event',input});
      assert.deepEqual(result,input);
      assert.equal(crypto.createHash('sha256').update(runInputsSerializedResult(result)).digest('hex'),crypto.createHash('sha256').update(stringify(input)).digest('hex'));
    }
  }finally{JSON.stringify=stringify;}
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM diagnostic_events')[0].n,4);
});
