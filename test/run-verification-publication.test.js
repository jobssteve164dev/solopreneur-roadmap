const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

for(const mode of ['runtime','direct'])test(mode+': actual run verification publishes complete evidence and claim outside Source and replays without WAL writes',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-verification-publication-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  const run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'核验完整交付结果',command:'not executed',userMessage:'核验完整交付结果',idempotencyKey:'verification-run'}}),evidence='完整独立验证证据🌿'.repeat(14000),claim='完整独立验证结论🌿'.repeat(14000),input={projectId:run.projectId,executionLogId:1,claim,result:'pass',evidence,idempotencyKey:'complete-verification'},read=store.content,put=store.putContent,stringify=JSON.stringify;
  const call=input=>Promise.resolve().then(()=>mode==='direct'?store.recordRunVerification(run.projectId,input):operations({operation:'record_run_verification',input}));
  store.content=function(id){if(Number(this.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded large verification content');return read.call(this,id);};
  store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded large verification content');return put.call(this,value,...args);};
  JSON.stringify=function(value,...args){if(typeof value==='string' && Buffer.byteLength(value)>65536)throw Error('Source encoded large verification JSON');return stringify.call(this,value,...args);};
  const wal=()=>{const value=fs.readFileSync(store.filePath+'-wal');return{length:value.length,sha:crypto.createHash('sha256').update(value).digest('hex')};};
  let receipt;
  try{
    receipt=await call(input);const before=wal();assert.deepEqual(await call(input),receipt);assert.deepEqual(wal(),before);
    await assert.rejects(call({...input,evidence:evidence+'changed'}),/idempotency_conflict/);assert.deepEqual(wal(),before);
    for(const table of ['content_lifecycle_prepare_owners','content_lifecycle_prepare_pins'])assert.equal(store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n,0);
  }finally{store.content=read;store.putContent=put;JSON.stringify=stringify;}
  const verification=store.read(receipt.objectId);assert.equal(verification.data.claim,claim);assert.equal(verification.data.result,'pass');assert.equal(store.read(String(verification.data.evidence_id)).data.content,evidence);
  assert.equal(store.rows("SELECT COUNT(*) AS n FROM evidence WHERE type='host_verification'")[0].n,1);assert.equal(store.rows('SELECT COUNT(*) AS n FROM verifications')[0].n,1);
});
