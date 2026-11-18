const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');

for(const entry of ['runtime','store'])test(entry+': formal review finish consumes complete application, policy and batch outside Source and replays after a newer prompt',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-review-finish-publication-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  const call=(operation,input)=>operations({operation,input});await call('register_project',{root});const prompt='用户确认的完整全局要求🌿\n'.repeat(4000),batch=await call('prepare_learning_review',{runId:'large-formal-review',workspaceRoot:root,globalPrompt:prompt,persistedGlobalPrompt:prompt}),result={globalPrompt:prompt,changes:[],lessons:[],processedSourceIds:batch.manifest.sources.map(source=>source.id),deferredSourceIds:[],unresolved:[],recovery:[]},applied=await call('apply_learning_review',{batchId:batch.objectId,expectedRevision:batch.revision,manifestHash:hash(JSON.stringify(batch.manifest)),result,idempotencyKey:'large-review-apply'}),input={applicationId:applied.application.objectId,expectedRevision:applied.application.revision,promptHash:hash(prompt),idempotencyKey:'large-review-finish'},read=store.content,put=store.putContent;
  store.content=function(id){if(Number(this.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded large review finish body');return read.call(this,id);};
  store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded large review finish body');return put.call(this,value,...args);};
  const finish=value=>entry==='runtime'?call('finish_learning_review',value):store.finishLearningReview(value);
  const wal=()=>{const value=fs.readFileSync(store.filePath+'-wal');return{length:value.length,sha:hash(value)};};let receipt;
  try{
    receipt=await finish(input);
    await call('write',{kind:'policy',action:'patch',scope:null,objectId:applied.policy.objectId,expectedRevision:applied.policy.revision,idempotencyKey:'newer-review-finish-policy',data:{content:'用户后来确认的完整要求🌿'.repeat(14000)}});
    const before=wal();assert.deepEqual(await finish(input),receipt);assert.deepEqual(wal(),before);
    for(const table of ['content_lifecycle_prepare_owners','content_lifecycle_prepare_pins'])assert.equal(store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n,0);
  }finally{store.content=read;store.putContent=put;}
  assert.equal(store.read(receipt.objectId).data.status,'applied');assert.equal(store.read(batch.objectId).data.status,'applied');assert.equal(store.read(receipt.objectId).data.after_content,prompt);assert.equal(store.read(applied.policy.objectId).data.content,'用户后来确认的完整要求🌿'.repeat(14000));
});
