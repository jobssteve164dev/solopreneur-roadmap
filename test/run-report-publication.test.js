const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs'),{canonicalJson}=require('../out/contentReferences.js');
const {submitRunReportNative}=require('./fixtures/native-run-report-oracles.cjs');

for(const largeReport of [false,true])test(`actual report submission preserves ${largeReport?'the complete invalid original report':'large current run metadata'} outside Source`,async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-run-report-publication-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  const metadata={retained:largeReport?'原元数据':'完整运行metadata'.repeat(12000)},run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'step',runKind:'step',prompt:'原任务',command:'',userMessage:'原目标',metadata,idempotencyKey:'report-original-run'}});
  const report={schemaVersion:1,summary:'原始任务结果',unmetRequirements:[],decisions:[],corrections:[],verification:[],commits:[],experienceUsage:[],lessons:[],...(largeReport?{raw:'报告保留原始大正文'.repeat(12000),sourceContents:Object.fromEntries(Array.from({length:301},(_,index)=>[index,`report-missing-source-${index}`]))}:{})};
  const input={root,executionLogId:1,generation:run.generation,turnId:run.turnId,report,idempotencyKey:'full-report'};
  const put=store.putContent,read=store.content,createHash=crypto.createHash;
  store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded a large report body');return put.call(this,value,...args);};
  store.content=function(id){if(Number(store.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded a large report body');return read.call(this,id);};
  crypto.createHash=(...args)=>{const hash=createHash(...args),update=hash.update;hash.update=function(value,...options){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source hashed a large report body');return update.call(this,value,...options);};return hash;};
  let receipt;try{receipt=await operations({operation:'submit_run_report',input});}finally{store.putContent=put;store.content=read;crypto.createHash=createHash;}
  assert.equal(receipt.availability,largeReport?'invalid':'available');assert.deepEqual(JSON.parse(store.read(receipt.objectId).data.content),report);
  const current=store.readRunState(run.projectId,1);assert.equal(current.revision,2);assert.equal(current.status.retained,metadata.retained);assert.equal(current.status.taskReportObjectId,receipt.objectId);assert.equal(current.status.taskReportRevision,1);
  const validationError=largeReport?'report exceeds character limit 2000; condense the report before submitting':'';
  const expected=crypto.createHash('sha256').update(canonicalJson({operation:'submit_run_report',projectId:run.projectId,executionLogId:1,generation:run.generation,turnId:run.turnId,report,availability:receipt.availability,validationError})).digest('hex');
  assert.equal(store.rows('SELECT input_hash FROM requests WHERE actor_id=? AND idempotency_key=?',[store.actorId,input.idempotencyKey])[0].input_hash,expected);
  if(largeReport){const contentId=store.readMetadata(receipt.objectId).data.content_id;assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_edges WHERE source_id=?',[contentId])[0].n,301);assert.ok(store.search({scope:run.projectId,kinds:['report'],query:'报告保留原始大正文'}).items.some(item=>item.objectId===receipt.objectId));}
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

async function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-run-report-boundary-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  const run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'step',runKind:'step',prompt:'原任务',command:'',userMessage:'原目标',metadata:{retained:'完整运行metadata'.repeat(12000)},idempotencyKey:'report-boundary-run'}});
  const report={schemaVersion:1,summary:'原始报告结果',unmetRequirements:[],decisions:[],corrections:[],verification:[],commits:[],experienceUsage:[],lessons:[]};
  const input={root,executionLogId:1,generation:run.generation,turnId:run.turnId,report,idempotencyKey:'report-boundary-submit'};
  return{store,operations,run,input,submit:patch=>operations({operation:'submit_run_report',input:{...input,...patch}})};
}

test('actual null report preserves the original JSON null body and invalid receipt',async t=>{
  const f=await fixture(t),receipt=await f.submit({report:null,idempotencyKey:'actual-null-report'}),object=f.store.readMetadata(receipt.objectId),content=f.store.rows('SELECT mime_type FROM contents WHERE id=?',[object.data.content_id])[0];
  assert.equal(receipt.availability,'invalid');assert.equal(content.mime_type,'application/json');assert.equal(f.store.content(object.data.content_id).toString('utf8'),'null');assert.equal(f.store.readRunState(f.run.projectId,1).status.taskReportStatus,'invalid');
});

test('the last run report binding failure rolls back report, version index, receipt and metadata together',async t=>{
  const f=await fixture(t),tables=['objects','object_revisions','events','requests','reports','report_versions','run_control_revisions'],counts=()=>Object.fromEntries(tables.map(table=>[table,f.store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n])),before=counts();
  f.store.db.run("CREATE TEMP TRIGGER reject_last_report_binding BEFORE INSERT ON events WHEN NEW.kind='run.report' BEGIN SELECT RAISE(ABORT,'fixture_last_report_binding_failure'); END");
  await assert.rejects(f.submit(),/fixture_last_report_binding_failure/);assert.deepEqual(counts(),before);assert.equal(f.store.readRunState(f.run.projectId,1).revision,1);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
  f.store.db.run('DROP TRIGGER reject_last_report_binding');const receipt=await f.submit();assert.equal(receipt.revision,1);assert.equal(f.store.readRunState(f.run.projectId,1).revision,2);
});

test('historical report replay preserves its fixed receipt, current availability and later binding without durable writes or unrelated decoding',async t=>{
  const f=await fixture(t),first=await f.submit(),second=await f.submit({report:{wrong:true},idempotencyKey:'later-invalid-report'});assert.equal(second.objectId,first.objectId);assert.equal(second.revision,2);assert.equal(second.availability,'invalid');
  const current=f.store.readRunState(f.run.projectId,1);assert.equal(current.status.taskReportRevision,2);assert.equal(current.revision,3);
  const contentId=f.store.rows('SELECT metadata_content_id FROM run_control WHERE run_id=?',[f.run.runId])[0].metadata_content_id;
  const chunk=f.store.rows('SELECT ordinal FROM content_chunks WHERE content_id=? ORDER BY ordinal LIMIT 1',[contentId])[0];
  if(chunk)f.store.db.run('UPDATE content_chunks SET data=zeroblob(length(data)) WHERE content_id=? AND ordinal=?',[contentId,chunk.ordinal]);
  else f.store.db.run('UPDATE contents SET data=zeroblob(length(data)) WHERE id=?',[contentId]);
  const wal=()=>{const bytes=fs.readFileSync(f.store.filePath+'-wal');return{length:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};},before=wal();
  const replay=await f.submit();assert.deepEqual(replay,{...first,availability:'invalid'});assert.deepEqual(wal(),before);assert.equal(f.store.readMetadata(f.run.runId).revision,3);assert.equal(f.store.readMetadata(first.objectId).revision,2);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

for(const native of [true,false])test(`${native?'frozen Native':'public'} report submission preserves supplied status, raw body, full intent and current availability on fixed replay`,async t=>{
  const f=await fixture(t),submit=input=>native?submitRunReportNative(f.store,f.run.projectId,input):f.store.submitRunReport(f.run.projectId,input);
  const {root,...base}=f.input,input={...base,report:null,availability:'missing',validationError:'调用方完整原始错误',extra:'不属于旧根意图'};
  const first=await submit(input),hash=crypto.createHash('sha256').update(canonicalJson({operation:'submit_run_report',projectId:f.run.projectId,executionLogId:1,generation:f.run.generation,turnId:f.run.turnId,report:null,availability:'missing',validationError:input.validationError})).digest('hex');
  assert.equal(first.availability,'missing');assert.equal(f.store.content(f.store.readMetadata(first.objectId).data.content_id).toString('utf8'),'null');
  assert.equal(f.store.rows('SELECT input_hash FROM requests WHERE actor_id=? AND idempotency_key=?',[f.store.actorId,input.idempotencyKey])[0].input_hash,hash);
  const state=f.store.readRunState(f.run.projectId,1);assert.equal(state.revision,2);assert.equal(state.status.taskReportStatus,'missing');assert.equal(state.status.taskReportError,input.validationError);
  await assert.rejects(async()=>submit({...input,availability:'invalid'}),/idempotency_conflict/);
  const report={raw:'未经二次校验的完整报告'.repeat(12000)},next=await submit({...base,report,availability:'available',validationError:'',idempotencyKey:'later-supplied-report'});
  assert.equal(next.objectId,first.objectId);assert.equal(next.revision,2);assert.equal(next.availability,'available');assert.deepEqual(JSON.parse(f.store.read(next.objectId).data.content),report);
  const wal=()=>{const bytes=fs.readFileSync(f.store.filePath+'-wal');return{bytes:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};},before=wal();
  assert.deepEqual(await submit({...input,extra:'改变原来未哈希的额外字段'}),{...first,availability:'available'});assert.deepEqual(wal(),before);
  assert.equal(f.store.readRunState(f.run.projectId,1).revision,3);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

for(const native of [true,false])test(`${native?'frozen Native':'public'} report submission retains original validation priority and atomic rollback at the last binding`,async t=>{
  const f=await fixture(t),submit=input=>native?submitRunReportNative(f.store,f.run.projectId,input):f.store.submitRunReport(f.run.projectId,input),{root,...base}=f.input,input={...base,availability:'invalid',validationError:'原始错误'};
  for(const [patch,message] of [[{generation:-1,turnId:'',idempotencyKey:''},'run_owner_conflict'],[{turnId:'',idempotencyKey:''},'report_turn_required'],[{turnId:'denied-turn',idempotencyKey:''},'report_turn_denied'],[{idempotencyKey:' '},'idempotency_key_required']])await assert.rejects(async()=>submit({...input,...patch}),new RegExp(message));
  const tables=['objects','object_revisions','events','requests','reports','report_versions','run_control_revisions'],counts=()=>Object.fromEntries(tables.map(table=>[table,f.store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n])),before=counts();
  f.store.db.run("CREATE TEMP TRIGGER reject_supplied_report_binding BEFORE INSERT ON events WHEN NEW.kind='run.report' BEGIN SELECT RAISE(ABORT,'supplied_report_last_binding_failure'); END");
  await assert.rejects(async()=>submit(input),/supplied_report_last_binding_failure/);assert.deepEqual(counts(),before);assert.equal(f.store.readRunState(f.run.projectId,1).revision,1);
  f.store.db.run('DROP TRIGGER reject_supplied_report_binding');const receipt=await submit(input);assert.equal(receipt.revision,1);assert.equal(receipt.availability,'invalid');assert.equal(f.store.readRunState(f.run.projectId,1).revision,2);
});

test('public supplied report submission keeps full raw report and metadata encoding outside Source',async t=>{
  const f=await fixture(t),{root,...base}=f.input,report={summary:'调用方已处理的报告',raw:'原始长报告正文'.repeat(20000)},input={...base,report,availability:'available',validationError:'调用方原始说明'},put=f.store.putContent,read=f.store.content,createHash=crypto.createHash;
  f.store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded a supplied report body');return put.call(this,value,...args);};
  f.store.content=function(id){if(Number(f.store.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded supplied report metadata');return read.call(this,id);};
  crypto.createHash=(...args)=>{const hash=createHash(...args),update=hash.update;hash.update=function(value,...options){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source hashed a supplied report body');return update.call(this,value,...options);};return hash;};
  let receipt;try{receipt=await f.store.submitRunReport(f.run.projectId,input);}finally{f.store.putContent=put;f.store.content=read;crypto.createHash=createHash;}
  assert.equal(receipt.availability,'available');assert.deepEqual(JSON.parse(f.store.read(receipt.objectId).data.content),report);assert.equal(f.store.readRunState(f.run.projectId,1).status.taskReportError,input.validationError);
});

test('supplied report replacement consumes the same actual previous body as Native while fixed replay leaves that body unused',async t=>{
  const f=await fixture(t),{root,...base}=f.input,input={...base,report:{raw:'原始报告正文'.repeat(12000)},availability:'available'},first=submitRunReportNative(f.store,f.run.projectId,input),contentId=f.store.readMetadata(first.objectId).data.content_id;
  if(f.store.rows('SELECT 1 FROM content_chunks WHERE content_id=?',[contentId]).length)f.store.db.run('UPDATE content_chunks SET data=zeroblob(length(data)) WHERE content_id=?',[contentId]);
  else f.store.db.run('UPDATE contents SET data=zeroblob(length(data)) WHERE id=?',[contentId]);
  const next={...input,report:{raw:'实际替换内容'},idempotencyKey:'supplied-replace-damaged-old-report'},tables=['objects','object_revisions','events','requests','reports','report_versions','run_control_revisions'],counts=()=>Object.fromEntries(tables.map(table=>[table,f.store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n])),before=counts();
  assert.throws(()=>submitRunReportNative(f.store,f.run.projectId,next),/content_integrity_error/);assert.deepEqual(counts(),before);
  await assert.rejects(f.store.submitRunReport(f.run.projectId,next),/content_integrity_error/);assert.deepEqual(counts(),before);
  const wal=()=>{const bytes=fs.readFileSync(f.store.filePath+'-wal');return{bytes:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};},beforeReplay=wal();
  assert.deepEqual(submitRunReportNative(f.store,f.run.projectId,input),first);assert.deepEqual(await f.store.submitRunReport(f.run.projectId,input),first);assert.deepEqual(wal(),beforeReplay);
});

test('supplied report replacement reselects an actual previous-body mapping changed before its first watch',async t=>{
  const f=await fixture(t),{root,...base}=f.input,input={...base,report:{raw:'准备时的完整旧报告'},availability:'available'},first=submitRunReportNative(f.store,f.run.projectId,input),bad=f.store.putTextContent('真实损坏的迟到旧内容');
  f.store.db.run('UPDATE contents SET data=zeroblob(length(data)) WHERE id=?',[bad]);
  const next={...input,report:{raw:'准备好的完整新报告'},idempotencyKey:'supplied-report-late-old-mapping'},stage=f.store.stageAgentDependencies;let changes=0;
  f.store.stageAgentDependencies=function(...args){if(!changes++){this.db.run('UPDATE reports SET content_id=? WHERE id=?',[bad,first.objectId]);assert.throws(()=>submitRunReportNative(this,f.run.projectId,next),/content_integrity_error/);}return stage.apply(this,args);};
  try{await assert.rejects(f.store.submitRunReport(f.run.projectId,next),/content_integrity_error/);}finally{f.store.stageAgentDependencies=stage;}
  assert.equal(changes,1);assert.equal(f.store.readMetadata(first.objectId).revision,1);assert.equal(f.store.rows('SELECT content_id FROM reports WHERE id=?',[first.objectId])[0].content_id,bad);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM requests WHERE idempotency_key=?',[next.idempotencyKey])[0].n,0);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});
