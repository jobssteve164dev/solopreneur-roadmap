const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

async function fixture(t,mode){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-document-publication-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  const run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'step',runKind:'step',prompt:'原任务',command:'',userMessage:'原目标',idempotencyKey:'document-original-run'}});
  return{store,operations,run,root,document:input=>Promise.resolve().then(()=>mode==='direct'?store.writeRunDocument(run.projectId,input):operations({operation:'write_run_document',input}))};
}
function bodyGuards(store){
  const put=store.putContent,read=store.content,createHash=crypto.createHash;
  store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded a large document snapshot');return put.call(this,value,...args);};
  store.content=function(id){if(Number(store.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded a large document body');return read.call(this,id);};
  crypto.createHash=(...args)=>{const hash=createHash(...args),update=hash.update;hash.update=function(value,...options){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source hashed a large document body');return update.call(this,value,...options);};return hash;};
  return()=>{store.putContent=put;store.content=read;crypto.createHash=createHash;};
}

test('actual document publication preserves validation order before decoding bytes',async t=>{
  const f=await fixture(t),input={projectId:f.run.projectId,executionLogId:1,generation:1,purpose:'INVALID',bytes:'not-base64!',mimeType:'text/plain',expectedRevision:0,idempotencyKey:'invalid-document'};
  assert.throws(()=>f.store.writeRunDocumentContent(f.run.projectId,input),/invalid_run_document$/);
  await assert.rejects(f.store.writeRunDocument(f.run.projectId,input),/invalid_run_document$/);
  await assert.rejects(f.operations({operation:'write_run_document',input}),/invalid_run_document$/);
  await assert.rejects(f.operations({operation:'write_run_document',input:{...input,generation:2}}),/run_owner_conflict$/);
});

for(const mode of ['runtime','direct'])test(mode+': actual document retry returns its fixed receipt without changing WAL or recreating a preparation owner',async t=>{
  const f=await fixture(t,mode),text='完整原始文档🌿\n'.repeat(12000),input={projectId:f.run.projectId,executionLogId:1,generation:1,purpose:'full_document',bytes:Buffer.from(text).toString('base64'),mimeType:'text/plain',expectedRevision:0,idempotencyKey:'fixed-document'};
  let restore=bodyGuards(f.store),first;try{first=await f.document(input);}finally{restore();}
  const wal=()=>{const bytes=fs.readFileSync(f.store.filePath+'-wal');return{length:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};},before=wal();
  restore=bodyGuards(f.store);let replay;try{replay=await f.document(input);}finally{restore();}
  assert.deepEqual(replay,first);assert.deepEqual(wal(),before,'the original completed receipt requires no durable preparation writes');assert.equal(Buffer.from(f.store.readRunDocument(f.run.projectId,1,'full_document').bytes,'base64').toString(),text);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

for(const mode of ['runtime','direct'])test(mode+': actual document publication preserves a large existing snapshot and real reference fanout outside Source',async t=>{
  const f=await fixture(t,mode),input={projectId:f.run.projectId,executionLogId:1,generation:1,purpose:'referenced_document',bytes:Buffer.from('原文档').toString('base64'),mimeType:'text/plain',expectedRevision:0,idempotencyKey:'referenced-document-original'},original=await f.document(input);
  const targets=[];f.store.transaction(()=>{for(let index=0;index<1201;index++)targets.push(f.store.write({kind:'memory',action:'create',scope:f.run.projectId,idempotencyKey:`document-real-target-${index}`,data:{category:'inbox',title:`真实引用${index}`,status:'captured',content:'实际保留内容'}}).objectId);for(const target of targets)f.store.db.run('INSERT INTO relations VALUES(?,?,?)',[original.objectId,'source',target]);});
  const text='完整更新文档🌿\n'.repeat(12000),restore=bodyGuards(f.store);let result;try{result=await f.document({...input,bytes:Buffer.from(text).toString('base64'),expectedRevision:1,idempotencyKey:'referenced-document-update'});}finally{restore();}
  assert.equal(result.objectId,original.objectId);assert.equal(result.revision,2);assert.equal(f.store.readMetadata(result.objectId,2).relations.length,1201);assert.equal(Buffer.from(f.store.readRunDocument(f.run.projectId,1,'referenced_document').bytes,'base64').toString(),text);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});
