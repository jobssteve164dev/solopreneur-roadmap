const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-diagnostic-boundaries-')),store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);
  t.after(async()=>{await operations.close();store.close();});
  const input={kind:'error',occurredAt:new Date().toISOString(),scope:'diagnostic.boundaries',payload:{complete:'完整诊断保留🌿'.repeat(14000)},idempotencyKey:'boundary-event'};
  return{store,operations,input,call:input=>operations({operation:'append_diagnostic_event',input})};
}
const wal=store=>{const bytes=fs.readFileSync(store.filePath+'-wal');return{length:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};};

test('a conflicting real write during diagnostic preparation wins without being overwritten',async t=>{
  const f=fixture(t),compute=f.store.diagnosticCompute;let before,inserted=false;
  const winner={...f.input,payload:{actual:'已接受的诊断'}};
  f.store.setDiagnosticCompute(async input=>{const prepared=await compute(input);if(!inserted){inserted=true;await f.call(winner);before=wal(f.store);}return prepared;});
  await assert.rejects(f.call(f.input),/idempotency_conflict/);assert.deepEqual(wal(f.store),before);assert.deepEqual(f.store.readDiagnosticEvents().items[0].payload,winner.payload);
});

test('identical real writes prepared concurrently converge on one complete diagnostic without replay WAL writes',async t=>{
  const f=fixture(t),compute=f.store.diagnosticCompute;let before,inserted=false;
  f.store.setDiagnosticCompute(async input=>{const prepared=await compute(input);if(!inserted){inserted=true;await f.call(f.input);before=wal(f.store);}return prepared;});
  assert.deepEqual(await f.call(f.input),f.input);assert.deepEqual(wal(f.store),before);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM diagnostic_events')[0].n,1);
});

test('diagnostic final Pi permission is rechecked after real Compute preparation',async t=>{
  const f=fixture(t),owner=f.store.claimPiExecutionOwner('diagnostic-owner'),operation=f.store.admitPiConversationOperation({schemaVersion:1,conversationId:'816381ea-9418-4edc-bbcd-ec8d9979b152',operationId:'diagnostic-operation',requestKey:'diagnostic-operation',prompt:'fixture',attachments:[],baselineRevision:0,source:'sidebar',sourceGeneration:1,projectScope:'',systemPrompt:'fixture',projectContext:{selectedProject:'',projects:[]},model:{provider:'agent-cli',modelId:'auto'},tools:[],executionProfile:'pi-core-0.87.1-v1',options:{retry:'native',compaction:'native',toolExecution:'sequential'}},owner);
  f.store.admitPiToolInvocation(operation.operationId,owner,{invocationId:'diagnostic-call',toolName:'solomap_write',arguments:{},replay:'never'});
  const compute=f.store.diagnosticCompute;let revoked=false;
  f.store.setDiagnosticCompute(async input=>{const prepared=await compute(input);f.store.claimPiExecutionOwner('replacement-diagnostic-owner');revoked=true;return prepared;});
  await assert.rejects(f.operations({operation:'append_diagnostic_event',input:f.input,piToolFence:{operationId:operation.operationId,invocationId:'diagnostic-call',ownerId:owner.ownerId,ownerGeneration:owner.generation}}),/pi_owner_fenced|pi_tool_invocation_fenced/);
  assert.equal(revoked,true);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM diagnostic_events')[0].n,0);
});

test('diagnostic replay retains original native text conversion and strict malformed header conflicts',async t=>{
  const f=fixture(t);
  for(const scope of ['异常头\ud800','超长诊断作用域🌿'.repeat(14000)]){
    const input={...f.input,scope,idempotencyKey:crypto.randomUUID()};
    assert.deepEqual(await f.call(input),input);
    if(scope.includes('\ud800')){
      assert.throws(()=>f.store.appendDiagnosticEvent(input),/idempotency_conflict/);
      await assert.rejects(f.call(input),/idempotency_conflict/);
    }else assert.deepEqual(await f.call(input),input);
  }
  const before=wal(f.store);await assert.rejects(f.call({...f.input,payload:null}),/invalid_diagnostic_event/);assert.deepEqual(wal(f.store),before);
});
