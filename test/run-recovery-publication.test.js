const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{RunRecovery}=require('../out/runRecovery.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

async function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-recovery-publication-')),root=path.join(base,'project');fs.mkdirSync(root);const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  const retained='必须完整保留的恢复上下文🌿'.repeat(12000),initial=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'完整用户目标',command:'not executed',userMessage:'完整用户目标',metadata:{retained},idempotencyKey:'recovery-publication-run'}}),run=await operations({operation:'claim_run',input:{projectId:initial.projectId,executionLogId:1,expectedRevision:initial.revision,idempotencyKey:'recovery-abandoned-claim'}});
  const guard=()=>{const read=store.content,put=store.putContent;store.content=function(id){if(Number(this.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded large recovery metadata');return read.call(this,id);};store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded large recovery metadata');return put.call(this,value,...args);};return()=>{store.content=read;store.putContent=put;};};
  return{store,run,retained,guard};
}

test('the actual recovery loop closes an abandoned run while keeping large metadata outside Source',async t=>{
  const f=await fixture(t),recovery=new RunRecovery(f.store),restore=f.guard();let state;
  try{await recovery.recover();state=(await f.store.readRunContextPublication(f.run.projectId,{executionLogId:1})).state;}finally{restore();await recovery.close();}
  assert.equal(state.status.retained,f.retained);assert.equal(state.status.status,'Failed');assert.ok(state.status.finishedAt);assert.equal(f.store.recoverableRunStates().items.length,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

test('recovery persists the original failure backoff with large metadata and a deferred retry makes no persistent writes',async t=>{
  const f=await fixture(t),now=10000,recovery=new RunRecovery(f.store,undefined,()=>now,{snapshot:async()=>{throw Error('actual_recovery_workspace_failure');},gitHead:async()=>'',gitEvidence:async()=>undefined}),restore=f.guard();
  try{
    await assert.rejects(recovery.recover(),/actual_recovery_workspace_failure/);const {state}=await f.store.readRunContextPublication(f.run.projectId,{executionLogId:1});
    assert.equal(state.status.retained,f.retained);assert.equal(state.status.recoveryFailureStage,'workspace-snapshot');assert.equal(state.status.recoveryRetryAttempts,1);assert.equal(state.status.recoveryRetryAtMs,now+30000);assert.equal(state.status.recoveryBackoffRevision,state.revision);
    const wal=()=>{const bytes=fs.readFileSync(f.store.filePath+'-wal');return{bytes:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};},before=wal();await recovery.recover();assert.deepEqual(wal(),before);
  }finally{restore();await recovery.close();}
});
