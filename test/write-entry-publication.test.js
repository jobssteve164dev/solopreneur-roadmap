const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

async function fixture(t){const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-write-entry-')),root=path.join(base,'project');fs.mkdirSync(root);const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});const project=await operations({operation:'register_project',input:{root}});return{root,store,operations,project};}

test('an actual small patch keeps a large existing scalar metadata field outside Source reads',async t=>{
  const f=await fixture(t),title='完整原始元数据标题🌿'.repeat(12000),source=f.store.write({kind:'memory',scope:f.project.projectId,action:'create',idempotencyKey:'large-scalar-source',data:{category:'inbox',title,status:'captured',content:'完整正文'}}),rows=f.store.rows;
  f.store.rows=function(...args){const result=rows.apply(this,args);for(const row of result)for(const value of Object.values(row))if(typeof value==='string' && Buffer.byteLength(value)>65536)throw Error('Source read unbounded scalar metadata');return result;};
  let receipt;try{receipt=await f.operations({operation:'write',input:{kind:'memory',scope:f.project.projectId,action:'patch',objectId:source.objectId,expectedRevision:1,idempotencyKey:'large-scalar-patch',data:{status:'candidate'}}});}finally{f.store.rows=rows;}
  assert.equal(receipt.revision,2);assert.equal(f.store.readMetadata(source.objectId).data.title,title);assert.equal(f.store.readMetadata(source.objectId).data.status,'candidate');assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

test('the actual link entry prepares both complete bodies and its new snapshot outside Source',async t=>{
  const f=await fixture(t),text='关系来源完整正文🌿\n'.repeat(12000),source=f.store.write({kind:'memory',scope:f.project.projectId,action:'create',idempotencyKey:'link-large-source',data:{category:'inbox',title:'实际来源',status:'captured',content:text}}),target=f.store.write({kind:'memory',scope:f.project.projectId,action:'create',idempotencyKey:'link-large-target',data:{category:'inbox',title:'实际目标',status:'captured',content:'目标完整正文🌿\n'.repeat(12000)}}),read=f.store.content,put=f.store.putContent;
  f.store.content=function(id){if(Number(f.store.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded a large link body');return read.call(this,id);};
  f.store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded a large link snapshot');return put.call(this,value,...args);};
  let receipt;try{receipt=await f.operations({operation:'link',input:{source:source.objectId,relation:'source',target:target.objectId,expectedRevision:1,idempotencyKey:'link-complete-source'}});}finally{f.store.content=read;f.store.putContent=put;}
  assert.equal(receipt.revision,2);assert.equal(f.store.read(source.objectId).data.content,text);assert.deepEqual(f.store.readMetadata(source.objectId,2).relations,[{relation:'source',target:target.objectId}]);assert.ok(f.store.search({scope:f.project.projectId,kinds:['memory'],query:'关系来源完整正文'}).items.some(object=>object.objectId===source.objectId));
});

test('an accepted actual link preserves its fixed receipt and leaves WAL unchanged on retry',async t=>{
  const f=await fixture(t),create=key=>f.store.write({kind:'memory',scope:f.project.projectId,action:'create',idempotencyKey:key,data:{category:'inbox',title:key,status:'captured',content:'完整保留正文'}}),source=create('link-fixed-source'),target=create('link-fixed-target'),input={source:source.objectId,relation:'source',target:target.objectId,expectedRevision:1,idempotencyKey:'link-fixed'},first=await f.operations({operation:'link',input}),wal=()=>{const bytes=fs.readFileSync(f.store.filePath+'-wal');return{bytes:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};},before=wal();
  assert.deepEqual(await f.operations({operation:'link',input}),first);assert.deepEqual(wal(),before);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

test('an accepted large generic write retries without a durable preparation owner or WAL changes',async t=>{
  const f=await fixture(t),input={kind:'memory',scope:f.project.projectId,action:'create',idempotencyKey:'generic-large-fixed',data:{category:'inbox',title:'完整固定来源',status:'captured',content:'完整通用原文🌿'.repeat(12000)}},first=await f.operations({operation:'write',input}),wal=()=>{const bytes=fs.readFileSync(f.store.filePath+'-wal');return{bytes:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};},before=wal();
  assert.deepEqual(await f.operations({operation:'write',input}),first);assert.deepEqual(wal(),before);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

test('actual link and patch entries share the original object FIFO',async t=>{
  const f=await fixture(t),create=key=>f.store.write({kind:'memory',scope:f.project.projectId,action:'create',idempotencyKey:key,data:{category:'inbox',title:key,status:'captured',content:'完整正文'}}),source=create('fifo-source'),target=create('fifo-target'),prepare=f.store.linkCompute;
  let started,release;const ready=new Promise(resolve=>started=resolve),paused=new Promise(resolve=>release=resolve);
  f.store.setLinkCompute(async request=>{const result=await prepare(request);started();await paused;return result;});
  const linked=f.operations({operation:'link',input:{source:source.objectId,relation:'source',target:target.objectId,expectedRevision:1,idempotencyKey:'fifo-link'}});
  await ready;let finished=false;const patched=f.operations({operation:'write',input:{kind:'memory',scope:f.project.projectId,action:'patch',objectId:source.objectId,expectedRevision:2,idempotencyKey:'fifo-patch',data:{status:'candidate'}}}).then(value=>{finished=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);release();assert.equal((await linked).revision,2);assert.equal((await patched).revision,3);assert.deepEqual(f.store.readMetadata(source.objectId).relations,[{relation:'source',target:target.objectId}]);
});

test('actual link keeps target integrity ahead of expected revision and rolls back its final native publication',async t=>{
  const f=await fixture(t),create=key=>f.store.write({kind:'memory',scope:f.project.projectId,action:'create',idempotencyKey:key,data:{category:'inbox',title:key,status:'captured',content:key}}),source=create('rollback-source'),target=create('rollback-target'),input={source:source.objectId,relation:'source',target:target.objectId,expectedRevision:1,idempotencyKey:'rollback-link'},events=f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n;
  await assert.rejects(f.store.publishLink(input,publish=>f.store.transaction(()=>{publish();throw Error('link_final_native_failure');})),/link_final_native_failure/);
  assert.equal(f.store.readMetadata(source.objectId).revision,1);assert.deepEqual(f.store.readMetadata(source.objectId).relations,[]);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM events')[0].n,events);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM requests WHERE idempotency_key=?',[input.idempotencyKey])[0].n,0);
  const contentId=f.store.readMetadata(target.objectId).data.content_id,damaged=Buffer.from(f.store.rows('SELECT data FROM contents WHERE id=?',[contentId])[0].data);damaged[0]^=1;f.store.db.run('UPDATE contents SET data=? WHERE id=?',[damaged,contentId]);
  await assert.rejects(f.operations({operation:'link',input:{...input,expectedRevision:99}}),/content_integrity_error/);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

test('the actual generic write returns a same-intent Native winner accepted during preparation',async t=>{
  const f=await fixture(t),source=f.store.write({kind:'memory',scope:f.project.projectId,action:'create',idempotencyKey:'native-winner-source',data:{category:'inbox',title:'原始来源',status:'captured',content:'原始正文'}}),input={kind:'memory',scope:f.project.projectId,action:'patch',objectId:source.objectId,expectedRevision:1,idempotencyKey:'native-winner-patch',data:{content:'并发下完整原始正文🌿'.repeat(12000)}},compute=f.store.dataWriteCompute;let winner;
  f.store.setDataWriteCompute({...compute,prepare:async request=>{const result=await compute.prepare(request);if(!winner && request.input.idempotencyKey===input.idempotencyKey)winner=f.store.write(input);return result;}});
  assert.deepEqual(await f.operations({operation:'write',input}),winner);assert.equal(f.store.read(source.objectId).data.content,input.data.content);assert.equal(f.store.readMetadata(source.objectId).revision,2);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM requests WHERE idempotency_key=?',[input.idempotencyKey])[0].n,1);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});
