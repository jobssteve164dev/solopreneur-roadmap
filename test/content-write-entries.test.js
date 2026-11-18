const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-write-entries-')),store=new UnifiedDataStore(root),operations=createRuntimeDataOperations(store);
  t.after(async()=>{await operations.close();store.close();});
  const write=input=>operations({operation:'write',input});
  const index=()=>{for(let count=0;count<2000;count++){const batch=store.prepareStorageReferenceBatch(128);store.commitStorageReferenceBatch(batch);if(!batch.pending)return;}assert.fail('reference index did not converge');};
  return {root,store,operations,write,index};
}
function memory(content,key='memory'){
  return {kind:'memory',action:'create',scope:null,idempotencyKey:key,data:{category:'inbox',title:'完整写入',status:'captured',content}};
}
function sourceEncoderGuard(store){
  const original=store.putContent.bind(store);
  store.putContent=(value,...args)=>{
    if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Writer encoded a large body');
    return original(value,...args);
  };
  return ()=>{store.putContent=original;};
}

test('the actual write entry preserves large body bytes, fixed history, search and idempotent replay before and after publication changes',async t=>{
  const f=fixture(t),content='雪原\n"quote"🌿'+ '原文完整保留'.repeat(18000),input=memory(content,'write-characterization'),start=performance.now(),cpu=process.cpuUsage();
  const first=await f.write(input),elapsedMs=performance.now()-start;
  assert.equal(f.store.read(first.objectId,first.revision).data.content,content);
  for(const query of ['雪原','quote','":"雪','\\n'])assert.deepEqual(f.store.search({scope:null,query,kinds:['memory']}).items.map(item=>item.objectId),[first.objectId]);
  const count=f.store.rows('SELECT COUNT(*) AS n FROM contents')[0].n;
  assert.deepEqual(await f.write(input),first);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM contents')[0].n,count);
  const second=await f.write({kind:'memory',action:'patch',scope:null,objectId:first.objectId,expectedRevision:1,idempotencyKey:'write-characterization-patch',data:{title:'改名后的完整写入'}});
  assert.equal(second.revision,2);assert.equal(f.store.read(first.objectId,1).data.content,content);assert.equal(f.store.read(first.objectId,2).data.content,content);
  await assert.rejects(f.write({...input,data:{...input.data,content:'different'}}),/idempotency_conflict/);
  t.diagnostic(JSON.stringify({bytes:Buffer.byteLength(content),elapsedMs,cpu:process.cpuUsage(cpu),rss:process.memoryUsage().rss,qualification:'actual Runtime write entry; isolated fixture; captures body/history/search/replay baseline, not Host or formal resource acceptance'}));
});

for(const structured of [false,true])test(`the actual write entry publishes ${structured?'structured':'raw JSON'} bodies with large reference sets before its atomic business commit`,async t=>{
  const f=fixture(t),target=f.store.putContent('必须保留的真实目标');f.index();f.store.beginContentPreparationRecovery();f.store.activateStorageContentLifecycle({strictPublication:true});
  const value={sourceContents:Object.fromEntries([target,...Array.from({length:300},(_,i)=>`unavailable-${i}`)].map((id,i)=>[i,id])),raw:'完整正文🌿'.repeat(20000)};
  const content=structured?value:JSON.stringify(value),restore=sourceEncoderGuard(f.store);
  let receipt;
  try{receipt=await f.write(memory(content,`published-body-${structured}`));}finally{restore();}
  const saved=f.store.read(receipt.objectId,receipt.revision).data.content;
  assert.equal(structured?JSON.parse(saved).raw:saved,structured?value.raw:content);
  const id=f.store.rows('SELECT content_id FROM memories WHERE id=?',[receipt.objectId])[0].content_id;
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_edges WHERE source_id=?',[id])[0].n,301);
  assert.equal(f.store.rows('SELECT 1 FROM content_lifecycle_reference_unpublished WHERE content_id=?',[id]).length,0);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('a metadata-only write updates search without decoding the retained body on the Writer',async t=>{
  const f=fixture(t),content='雪原\n"quote"🌿'+'必须保留'.repeat(20000),first=await f.write(memory(content,'retained-body'));
  const id=f.store.rows('SELECT content_id FROM memories WHERE id=?',[first.objectId])[0].content_id,original=f.store.content.bind(f.store);
  f.store.content=contentId=>{if(contentId===id)throw Error('Writer decoded the retained body');return original(contentId);};
  try{await f.write({kind:'memory',action:'patch',scope:null,objectId:first.objectId,expectedRevision:1,idempotencyKey:'metadata-only',data:{title:'新标题'}});}
  finally{f.store.content=original;}
  assert.equal(f.store.read(first.objectId,1).data.content,content);assert.equal(f.store.read(first.objectId,2).data.content,content);
  for(const query of ['雪原','quote','":"雪','\\n','新标题'])assert.deepEqual(f.store.search({scope:null,query,kinds:['memory']}).items.map(item=>item.objectId),[first.objectId]);
});

test('binary content through the actual write entry preserves exact bytes and MIME without Writer encoding',async t=>{
  const f=fixture(t),project=await f.write({kind:'project',action:'create',scope:null,idempotencyKey:'binary-project',data:{name:'binary'}}),bytes=crypto.randomBytes(256*1024+17),restore=sourceEncoderGuard(f.store);
  let receipt;
  try{receipt=await f.write({kind:'asset',action:'create',scope:project.objectId,idempotencyKey:'binary-content',data:{name:'attachment.bin',origin:'write-test',content:{encoding:'base64',data:bytes.toString('base64'),mimeType:'application/x-exact-test'}}});}finally{restore();}
  const content=f.store.read(receipt.objectId,1).data.content;assert.equal(content.mimeType,'application/x-exact-test');assert.deepEqual(Buffer.from(content.data,'base64'),bytes);
});

test('a later write on the same object follows an admitted large publication while another object remains writable',async t=>{
  const f=fixture(t),initial=await f.write(memory('initial','ordered-object')),compute=f.store.dataWriteCompute;
  let entered,release;const entering=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});t.after(release);
  f.store.setDataWriteCompute({...compute,prepare:async request=>{
    const result=await compute.prepare(request);
    if(request.input.idempotencyKey==='ordered-large-first'){entered();await gate;}
    return result;
  }});
  const first=f.write({kind:'memory',action:'patch',scope:null,objectId:initial.objectId,expectedRevision:1,idempotencyKey:'ordered-large-first',data:{content:'大正文必须先提交'.repeat(20000)}});void first.catch(()=>{});
  await entering;
  const next=f.write({kind:'memory',action:'patch',scope:null,objectId:initial.objectId,expectedRevision:2,idempotencyKey:'ordered-small-next',data:{title:'第二次修改'}});void next.catch(()=>{});
  const unrelated=await f.write(memory('independent progress','unrelated-during-publication'));assert.equal(unrelated.revision,1);
  release();assert.equal((await first).revision,2);assert.equal((await next).revision,3);
  assert.equal(f.store.read(initial.objectId,3).data.title,'第二次修改');
});

test('large typed metadata keeps SQLite affinity, JSON columns and complete revision snapshots',async t=>{
  const f=fixture(t),input=memory('tiny body','typed-metadata');
  input.data.title='ordinary title '.repeat(5000);input.data.confidence='0.75';input.data.metadata_json={z:'必须保留的尾部',a:[1,2,3]};
  const original=f.store.write({...input,idempotencyKey:'legacy-typed-metadata'}),expected=f.store.read(original.objectId,1).data;
  assert.equal(expected.confidence,0.75);assert.equal(expected.metadata_json,'{"a":[1,2,3],"z":"必须保留的尾部"}');
  const restore=sourceEncoderGuard(f.store);let actual;
  try{actual=await f.write(input);}finally{restore();}
  assert.deepEqual(f.store.read(actual.objectId,1).data,expected);
  const second=await f.write({kind:'memory',action:'patch',scope:null,objectId:actual.objectId,expectedRevision:1,idempotencyKey:'typed-metadata-patch',data:{status:'verified'}});
  assert.equal(second.revision,2);assert.equal(f.store.read(actual.objectId,1).data.status,'captured');assert.equal(f.store.read(actual.objectId,2).data.metadata_json,expected.metadata_json);
  assert.deepEqual(f.store.search({scope:null,query:'必须保留的尾部',kinds:['memory']}).items.map(item=>item.objectId).sort(),[original.objectId,actual.objectId].sort());
});

test('fixed history roots do not require an unbounded synchronous pin walk before write preparation can yield',async t=>{
  const f=fixture(t),lesson=f.store.write({kind:'lesson',action:'create',scope:null,idempotencyKey:'pin-budget-lesson',data:{status:'candidate',summary:'retained fixed root'}});
  const event=f.store.write({kind:'learning_event',action:'create',scope:null,idempotencyKey:'pin-budget-event',data:{source_object_id:lesson.objectId,source_revision:1,event_type:'agent_claim',summary:'event',occurred_at:Date.now()}});
  const original=f.store.db.run.bind(f.store.db);let pins=0;
  f.store.db.run=(sql,values)=>{if(String(sql).startsWith('INSERT OR IGNORE INTO content_lifecycle_prepare_pins'))pins++;return original(sql,values);};
  const pending=f.write({kind:'lesson_decision',action:'create',scope:null,idempotencyKey:'fixed-root-pin-budget',data:{event_id:event.objectId,decision:'accept',reason:'complete references',actor_id:'local-runtime',candidate_refs:Array.from({length:300},()=>({objectId:lesson.objectId,revision:1}))}});
  void pending.catch(()=>{});
  const beforeYield=pins;f.store.db.run=original;
  try{assert.ok(beforeYield<=128,`preparation pinned ${beforeYield} references before yielding`);}
  finally{const receipt=await pending;assert.equal(f.store.readMetadata(receipt.objectId).data.candidate_refs.length,300);}
});

test('registering a large fixed-history proof yields to another real write between bounded watch batches',async t=>{
  const f=fixture(t),lessons=[];
  for(let i=0;i<257;i++)lessons.push(f.store.write({kind:'lesson',action:'create',scope:null,idempotencyKey:`watch-batch-lesson-${i}`,data:{status:'candidate',summary:`fixed root ${i}`}}));
  const event=f.store.write({kind:'learning_event',action:'create',scope:null,idempotencyKey:'watch-batch-event',data:{source_object_id:lessons[0].objectId,source_revision:1,event_type:'agent_claim',summary:'event',occurred_at:Date.now()}});
  const original=f.store.db.run.bind(f.store.db);
  let registered=0,observed,foreground;
  f.store.db.run=(sql,values)=>{
    const result=original(sql,values);
    if(String(sql).startsWith('INSERT INTO temp.solomap_content_verification_watches')){
      registered++;
      if(registered===1)setImmediate(()=>{foreground=f.write(memory('foreground is usable','during-watch-registration')).then(()=>{observed=registered;});});
    }
    return result;
  };
  const receipt=await f.write({kind:'lesson_decision',action:'create',scope:null,idempotencyKey:'watch-batch-decision',data:{event_id:event.objectId,decision:'accept',reason:'complete fixed refs',actor_id:'local-runtime',candidate_refs:lessons.map(item=>({objectId:item.objectId,revision:1}))}});
  await foreground;f.store.db.run=original;
  assert.equal(f.store.readMetadata(receipt.objectId).data.candidate_refs.length,257);
  assert.ok(observed>0 && observed<=128,`the independent write only completed after ${observed} watch registrations`);
});
