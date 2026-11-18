const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks'),{UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{RuntimeDataExecutionDomains}=require('../out/runtimeDataExecutionDomains.js');

test('actual Runtime publishes complete large logs and fixed retries while independent readers and writes progress',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-log-runtime-')),root=path.join(base,'data'),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  const setup=new UnifiedDataStore(root),closeCompute=require('./content-compute-fixture.cjs').attachLazyContentCompute(setup),project=await setup.registerProject({root:projectRoot}),context='完整运行上下文🌿'.repeat(10000);
  const run=await setup.prepareRun(project.projectId,project.locationId,{root:projectRoot,executionLogId:1,nodeId:'step',runKind:'step',prompt:'原任务',command:'',userMessage:'原目标',metadata:{context},idempotencyKey:'real-log-run'}),databaseId=setup.databaseId;await closeCompute();setup.close();
  const observer=UnifiedDataStore.openReadOnly(root,databaseId);t.after(()=>observer.close());const domains=await RuntimeDataExecutionDomains.start({root,databaseId});t.after(()=>domains.close());
  const bytes=Buffer.concat([Buffer.from('完整原始输出\0🌿'),crypto.randomBytes(8*1024*1024)]),input={projectId:project.projectId,executionLogId:1,generation:run.generation,stream:'stdout',sequence:0,offset:0,bytes:bytes.toString('base64'),idempotencyKey:'actual-large-log'};
  let complete=false,readsDuring=0,writesDuring=0,maximumReadMs=0,maximumWriteMs=0,publicationMs=0,walPeak=0;const started=performance.now(),rssBefore=process.memoryUsage().rss;let rssPeak=rssBefore;
  const sample=setInterval(()=>{rssPeak=Math.max(rssPeak,process.memoryUsage().rss);try{walPeak=Math.max(walPeak,fs.statSync(path.join(root,'solomap.db-wal')).size);}catch{}},5);t.after(()=>clearInterval(sample));
  const publishing=domains.dispatchSerialized({operation:'append_run_log',input}).then(value=>{complete=true;publicationMs=performance.now()-started;return value;});void publishing.catch(()=>{});
  const deadline=Date.now()+10000;let admitted=false;
  while(!complete && Date.now()<deadline){if(observer.rows('SELECT 1 FROM content_lifecycle_prepare_owners LIMIT 1').length){admitted=true;break;}await new Promise(resolve=>setTimeout(resolve,1));}
  assert.ok(admitted,'observe the actual preparation owner before submitting unrelated work');assert.equal(complete,false);
  const saved=[];for(let index=0;index<6 && !complete;index++){
    const reading=performance.now(),writing=performance.now();const [,receipt]=await Promise.all([
      domains.operations({operation:'read',input:{ref:project.projectId}}).then(value=>{maximumReadMs=Math.max(maximumReadMs,performance.now()-reading);if(!complete)readsDuring++;return value;}),
      domains.operations({operation:'write',input:{kind:'memory',action:'create',scope:project.projectId,idempotencyKey:`during-log-${index}`,data:{category:'inbox',title:`独立保存 ${index}`,status:'captured',content:`日志准备期间保存 ${index}`}}}).then(value=>{maximumWriteMs=Math.max(maximumWriteMs,performance.now()-writing);if(!complete)writesDuring++;return value;})
    ]);saved.push(receipt);
  }
  const serialized=await publishing,result=JSON.parse(serialized);assert.ok(readsDuring>0);assert.ok(writesDuring>0);assert.equal(result.nextSequence,1);assert.equal(result.totalBytes,bytes.length);
  for(const stream of ['stdout','output']){
    const parts=[];let offset=0;do{const page=await domains.operations({operation:'read_run_log',input:{projectId:project.projectId,executionLogId:1,stream,offset,limit:1048576}});parts.push(Buffer.from(page.bytes,'base64'));offset=page.nextOffset;}while(offset!==null);
    assert.deepEqual(Buffer.concat(parts),bytes);
  }
  const counts=()=>observer.rows('SELECT (SELECT COUNT(*) FROM contents) AS contents,(SELECT COUNT(*) FROM requests) AS requests,(SELECT COUNT(*) FROM events) AS events,(SELECT COUNT(*) FROM log_chunks) AS logs')[0],beforeReplay=counts(),replayStarted=performance.now();
  assert.deepEqual(JSON.parse(await domains.dispatchSerialized({operation:'append_run_log',input})),result);const replayMs=performance.now()-replayStarted;assert.deepEqual(counts(),beforeReplay);
  assert.equal(observer.readRunState(project.projectId,1).status.context,context);assert.equal(observer.readRunState(project.projectId,1).revision,1);assert.equal(observer.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(observer.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
  for(const receipt of saved)assert.match(observer.read(receipt.objectId).data.content,/日志准备期间保存/);clearInterval(sample);
  t.diagnostic(JSON.stringify({bytes:bytes.length,base64Bytes:Buffer.byteLength(input.bytes),metadataBytes:Buffer.byteLength(context),publicationMs,replayMs,elapsedMs:performance.now()-started,readsDuring,writesDuring,maximumReadMs,maximumWriteMs,rssBefore,rssAfter:process.memoryUsage().rss,rssPeak,walPeak,qualification:'actual existing Writer/Compute/Reader domains and serialized transport; overlap measures the admitted publication window, exact binary source/output pages and fixed replay verified; RSS includes parent verification/shared existing workers; isolated fixture, not formal retained history/HostBrowser/cgroup or final capacity evidence; accepted WAL0 separately proved against frozen Native in isolated publication regressions'}));
});
