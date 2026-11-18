const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');
const {importStepMemorySourceNative,saveStepMemoryRevisionNative}=require('./fixtures/native-step-memory-import-oracles.cjs');

async function fixture(t,native=false){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-step-import-publication-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  const project=await store.registerProject({root}),identity=`step-memory:${project.projectId}`;
  const input=value=>{const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');return{nodeId:'step',source:{identity,key:'step.json',hash:crypto.createHash('sha256').update(bytes).digest('hex')},bytes,format:'json'};};
  return{store,operations,project,input,call:value=>native?importStepMemorySourceNative(store,project.projectId,value):store.importStepMemorySource(project.projectId,value),capture:value=>store.publishMigrationSource(value.source,value.bytes,{mimeType:'application/json',encoding:'utf8'})};
}
const wal=store=>{const bytes=fs.readFileSync(store.filePath+'-wal');return{bytes:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};};
const counts=store=>Object.fromEntries(['objects','object_revisions','evidence','events','requests','relations','step_memory_sources','project_step_memory','project_step_memory_revisions','project_step_memory_state','step_memory_field_origins'].map(table=>[table,store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n]));

for(const native of [true,false])test(`characterized ${native?'Native':'public'} step source import preserves field ownership, raw entries and fixed versions`,async t=>{
  const f=await fixture(t,native);saveStepMemoryRevisionNative(f.store,f.project.projectId,'step',{untagged:'无标记的原值'});
  await f.store.writeStepMemory(f.project.projectId,{nodeId:'step',expectedRevision:1,patch:{criteria:['默认标准'],edited:'默认值',retained:'完整原有元数据🌿'.repeat(8000)},origin:'default',idempotencyKey:'default-before-import'});
  await f.store.writeStepMemory(f.project.projectId,{nodeId:'step',expectedRevision:2,patch:{edited:'用户值'},idempotencyKey:'user-before-import'});
  const entries=Array.from({length:31},(_,i)=>({unknown:{index:i,text:'完整历史🌿'.repeat(200)}})),firstInput=f.input({criteria:['来源标准'],edited:'来源不覆盖用户',untagged:'来源不覆盖无标记值',removedField:'来源拥有字段',largeSource:'完整来源元数据'.repeat(8000),entries});await f.capture(firstInput);
  const originalGraph=counts(f.store);assert.deepEqual(await f.call(firstInput),{unchanged:false});const acceptedGraph=counts(f.store);assert.equal(acceptedGraph.requests-originalGraph.requests,2);assert.equal(acceptedGraph.events-originalGraph.events,2);const first=f.store.readStepMemory(f.project.projectId,'step');assert.equal(first.revision,4);assert.deepEqual(first.data.criteria,['来源标准']);assert.equal(first.data.edited,'用户值');assert.equal(first.data.untagged,'无标记的原值');assert.deepEqual(first.data.entries,entries);
  assert.equal(f.store.read(first.sources[0].objectId,1).data.content,firstInput.bytes.toString('utf8'));const before=wal(f.store),graph=counts(f.store);assert.deepEqual(await f.call(firstInput),{unchanged:true});assert.deepEqual(wal(f.store),before);assert.deepEqual(counts(f.store),graph);
  await f.store.writeStepMemory(f.project.projectId,{nodeId:'step',expectedRevision:4,patch:{criteria:['用户后改标准']},idempotencyKey:'user-after-import'});
  const next=f.input({criteria:['来源新标准不能覆盖'],edited:'来源新值不能覆盖',untagged:'不能覆盖',addedField:'新增来源字段',entries:[{raw:'新完整交接'}]});await f.capture(next);assert.deepEqual(await f.call(next),{unchanged:false});
  const current=f.store.readStepMemory(f.project.projectId,'step');assert.equal(current.revision,6);assert.deepEqual(current.data.criteria,['用户后改标准']);assert.equal(current.data.edited,'用户值');assert.equal(current.data.addedField,'新增来源字段');assert.equal(Object.hasOwn(current.data,'removedField'),false);assert.equal(Object.hasOwn(current.data,'largeSource'),false);assert.notEqual(current.sources[0].objectId,first.sources[0].objectId);
  const historical=f.store.readStepMemory(f.project.projectId,'step',{revision:4});assert.equal(historical.data.removedField,'来源拥有字段');assert.deepEqual(historical.data.entries,entries);assert.equal(f.store.rows('SELECT revision FROM project_step_memory_state WHERE project_id=?',[f.project.projectId])[0].revision,6);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

for(const native of [true,false])test(`characterized ${native?'Native':'public'} unchanged step source restores only its marker and leaves damaged unused metadata unread`,async t=>{
  const f=await fixture(t,native),input=f.input({accepted:'原始元数据',entries:[{raw:'原始交接'}]});await f.capture(input);await f.call(input);
  const id=f.store.rows('SELECT content_id FROM project_step_memory WHERE project_id=? AND node_key=?',[f.project.projectId,'step'])[0].content_id;f.store.db.run('UPDATE contents SET data=zeroblob(length(data)) WHERE id=?',[id]);assert.throws(()=>f.store.content(id),/content_integrity_error/);
  f.store.db.run("UPDATE migration_items SET stage='conflict',source_hash='changed',error='source error' WHERE source_identity=? AND source_key=?",[input.source.identity,input.source.key]);const graph=counts(f.store);
  assert.deepEqual(await f.call(input),{unchanged:true});const source=f.store.rows('SELECT stage,source_hash,error,imported_revision FROM migration_items WHERE source_identity=? AND source_key=?',[input.source.identity,input.source.key])[0];assert.deepEqual({...source},{stage:'imported',source_hash:input.source.hash,error:null,imported_revision:1});assert.deepEqual(counts(f.store),graph);
  const before=wal(f.store);assert.deepEqual(await f.call(input),{unchanged:true});assert.deepEqual(wal(f.store),before);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

for(const native of [true,false])test(`characterized ${native?'Native':'public'} step source validates before parsing and rolls back its last projection event`,async t=>{
  const f=await fixture(t,native),input=f.input({criteria:['导入完整标准'],entries:[{raw:'完整历史'}]});
  for(const patch of [{nodeId:''},{source:{...input.source,hash:'bad'}},{format:'unsupported'}])await assert.rejects(async()=>f.call({...input,...patch}),/step_memory_source_invalid/);
  const wrongEntries=f.input({entries:'invalid'});await assert.rejects(async()=>f.call(wrongEntries),/step_memory_source_entries_invalid/);
  await f.capture(input);const before=counts(f.store);f.store.db.run("CREATE TEMP TRIGGER reject_import_projection BEFORE INSERT ON events WHEN NEW.kind='evidence.step_memory' BEGIN SELECT RAISE(ABORT,'last_step_import_projection_failure'); END");
  await assert.rejects(async()=>f.call(input),/last_step_import_projection_failure/);assert.deepEqual(counts(f.store),before);assert.equal(f.store.rows('SELECT stage FROM migration_items WHERE source_identity=? AND source_key=?',[input.source.identity,input.source.key])[0].stage,'captured');
  f.store.db.run('DROP TRIGGER reject_import_projection');assert.deepEqual(await f.call(input),{unchanged:false});assert.equal(f.store.readStepMemory(f.project.projectId,'step').revision,1);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('public step source import keeps complete raw source and current metadata processing outside Source',async t=>{
  const f=await fixture(t);await f.store.writeStepMemory(f.project.projectId,{nodeId:'step',expectedRevision:0,patch:{retained:'完整现有元数据🌿'.repeat(15000)},idempotencyKey:'large-before-source'});
  const input=f.input({criteria:['新来源标准'],unknown:'完整导入元数据🌿'.repeat(16000),entries:[{raw:'完整原始交接🌿'.repeat(18000)}]});await f.capture(input);
  const put=f.store.putContent,read=f.store.content,createHash=crypto.createHash;f.store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded large imported step memory');return put.call(this,value,...args);};f.store.content=function(id){if(Number(f.store.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded large current step memory');return read.call(this,id);};crypto.createHash=(...args)=>{const hash=createHash(...args),update=hash.update;hash.update=function(value,...options){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source hashed large step import bytes');return update.call(this,value,...options);};return hash;};
  let result;try{result=await f.store.importStepMemorySource(f.project.projectId,input);}finally{f.store.putContent=put;f.store.content=read;crypto.createHash=createHash;}
  assert.deepEqual(result,{unchanged:false});const memory=f.store.readStepMemory(f.project.projectId,'step');assert.equal(memory.data.retained,'完整现有元数据🌿'.repeat(15000));assert.equal(memory.data.unknown,'完整导入元数据🌿'.repeat(16000));assert.equal(f.store.read(memory.sources[0].objectId,1).data.content,input.bytes.toString('utf8'));
});

test('step source reselects an origin-only user change made before the first content watch',async t=>{
  const f=await fixture(t);await f.store.writeStepMemory(f.project.projectId,{nodeId:'step',expectedRevision:0,patch:{criteria:['保留原值']},origin:'default',idempotencyKey:'before-origin-only-change'});
  const input=f.input({criteria:['不能覆盖用户'],added:'完整来源值',entries:[]}),compute=f.store.stepMemoryImportCompute,prepare=compute.prepare;let attempts=0;
  compute.prepare=async request=>{const selected=await prepare(request);if(!attempts++)f.store.db.run("UPDATE step_memory_field_origins SET origin='user' WHERE project_id=? AND node_key=? AND field='criteria'",[f.project.projectId,'step']);return selected;};
  try{assert.deepEqual(await f.call(input),{unchanged:false});}finally{compute.prepare=prepare;}
  assert.ok(attempts>=2);assert.deepEqual(f.store.readStepMemory(f.project.projectId,'step').data.criteria,['保留原值']);assert.equal(f.store.readStepMemory(f.project.projectId,'step').data.added,'完整来源值');assert.equal(f.store.rows("SELECT COUNT(*) AS n FROM events WHERE kind='evidence.step_memory_source'")[0].n,1);
});

test('step source consumes a real late Native import without duplicate persistent preparation',async t=>{
  const f=await fixture(t),input=f.input({criteria:['真实 Native 接受值'],entries:[{raw:'完整交接'}]}),compute=f.store.stepMemoryImportCompute,prepare=compute.prepare;let winner,accepted,attempts=0;
  compute.prepare=async request=>{const selected=await prepare(request);if(!attempts++){winner=importStepMemorySourceNative(f.store,f.project.projectId,input);accepted={wal:wal(f.store),graph:counts(f.store)};}return selected;};
  try{assert.deepEqual(await f.call(input),{unchanged:true});}finally{compute.prepare=prepare;}
  assert.deepEqual(winner,{unchanged:false});assert.ok(attempts>=2);assert.deepEqual(counts(f.store),accepted.graph);assert.deepEqual(wal(f.store),accepted.wal);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

for(const native of [true,false])test(`${native?'Native':'public'} step source propagates the first Native insert error even when its name is also a preparation retry signal`,async t=>{
  const f=await fixture(t,native),input=f.input({criteria:['完整来源值'],entries:[]}),before=counts(f.store),transaction=f.store.transaction;let failures=0,depth=0;
  f.store.db.run("CREATE TEMP TRIGGER reject_first_step_import BEFORE INSERT ON requests BEGIN SELECT RAISE(ABORT,'step_memory_plan_changed'); END");
  f.store.transaction=function(...args){depth++;try{return transaction.apply(this,args);}catch(error){if(depth===1 && error instanceof Error && error.message==='step_memory_plan_changed' && failures===0){this.db.run('DROP TRIGGER reject_first_step_import');failures++;}throw error;}finally{depth--;}};
  try{await assert.rejects(async()=>f.call(input),/step_memory_plan_changed/);}finally{f.store.transaction=transaction;}
  assert.equal(failures,1);assert.deepEqual(counts(f.store),before);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);assert.deepEqual(await f.call(input),{unchanged:false});
});

for(const native of [true,false])for(const saved of ['both','source','projection'])test(`${native?'Native':'public'} step source retains actual ${saved} child receipts while restoring an older source mapping`,async t=>{
  const f=await fixture(t,native),first=f.input({criteria:['旧来源值'],entries:[{raw:'旧完整来源'}]}),next=f.input({criteria:['新来源值'],entries:[{raw:'新完整来源'}]});
  importStepMemorySourceNative(f.store,f.project.projectId,first);const previous=f.store.rows('SELECT * FROM step_memory_sources WHERE project_id=?',[f.project.projectId])[0];importStepMemorySourceNative(f.store,f.project.projectId,next);
  const current=f.store.rows('SELECT * FROM step_memory_sources WHERE project_id=?',[f.project.projectId])[0],key=`step-memory-source:${require('../out/contentReferences.js').canonicalJson([f.project.projectId,'step',next.source.key,previous.object_id,next.source.hash])}`;
  f.store.db.run('UPDATE step_memory_sources SET object_id=?,source_hash=?,entry_count=?,format=? WHERE project_id=? AND node_key=? AND source_key=?',[previous.object_id,previous.source_hash,previous.entry_count,previous.format,f.project.projectId,'step',first.source.key]);
  if(saved!=='both')f.store.db.run('UPDATE requests SET idempotency_key=? WHERE actor_id=? AND idempotency_key=?',[`${key}:held-${saved}`,f.store.actorId,saved==='source'?`${key}:projection`:key]);
  const before=counts(f.store);assert.deepEqual(await f.call(next),{unchanged:false});const after=counts(f.store),memory=f.store.readStepMemory(f.project.projectId,'step');
  assert.equal(after.requests-before.requests,saved==='both'?0:1);assert.equal(after.events-before.events,saved==='both'?0:1);assert.equal(memory.revision,saved==='source'?3:2);assert.deepEqual(memory.data.criteria,['新来源值']);assert.deepEqual(memory.data.entries,[{raw:'新完整来源'}]);assert.equal(f.store.rows('SELECT revision FROM project_step_memory_state WHERE project_id=?',[f.project.projectId])[0].revision,2);
  const actual=f.store.rows('SELECT * FROM step_memory_sources WHERE project_id=?',[f.project.projectId])[0];assert.equal(actual.source_hash,next.source.hash);if(saved!=='projection')assert.equal(actual.object_id,current.object_id);else assert.notEqual(actual.object_id,current.object_id);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

for(const native of [true,false])test(`${native?'Native':'public'} step source pins SQLite-bound keys in every version while retaining the original request intent`,async t=>{
  const f=await fixture(t,native),{canonicalJson}=require('../out/contentReferences.js'),key='\ud800.json',inputs=[f.input({first:'完整首版元数据',entries:[{raw:'首版完整来源'}]}),f.input({second:'完整后版元数据',entries:[{raw:'后版完整来源'}]})];
  let previous=null;const versions=[];
  for(const input of inputs){
    input.source.key=key;const descriptor={projectId:f.project.projectId,nodeId:input.nodeId,source:input.source,format:input.format},requestKey=`step-memory-source:${canonicalJson([f.project.projectId,input.nodeId,key,previous,input.source.hash])}`;
    assert.deepEqual(await f.call(input),{unchanged:false});const current=f.store.readStepMemory(f.project.projectId,'step'),stored=f.store.rows('SELECT * FROM step_memory_sources WHERE project_id=?',[f.project.projectId])[0];assert.equal(stored.source_key,'\ufffd.json');assert.equal(current.sources.length,1);assert.equal(current.sources[0].key,stored.source_key);assert.equal(current.sources[0].objectId,stored.object_id);assert.deepEqual(current.data.entries,JSON.parse(input.bytes).entries);
    const body=JSON.parse(f.store.read(current.objectId,1).data.content);assert.deepEqual(body.sources,current.sources);const expected=crypto.createHash('sha256').update(canonicalJson(descriptor)).digest('hex'),requests=f.store.rows('SELECT idempotency_key,input_hash FROM requests WHERE actor_id=? AND idempotency_key IN (?,?) ORDER BY idempotency_key',[f.store.actorId,requestKey,requestKey+':projection']);assert.equal(requests.length,2);assert.ok(requests.every(row=>row.input_hash===expected));versions.push(current);previous=stored.object_id;
  }
  for(const version of versions){const historical=f.store.readStepMemory(f.project.projectId,'step',{revision:version.revision});assert.deepEqual(historical.sources,version.sources);assert.deepEqual(historical.data.entries,version.data.entries);}
});
