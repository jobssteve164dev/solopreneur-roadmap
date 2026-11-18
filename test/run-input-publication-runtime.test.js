const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {RuntimeDataExecutionDomains}=require('../out/runtimeDataExecutionDomains.js');
const {canonicalJson}=require('../out/contentReferences.js');

test('actual Writer, Compute and serialized transport publish complete inputs while other local work progresses',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-input-publication-runtime-')),root=path.join(base,'data'),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  const setup=new UnifiedDataStore(root),project=await setup.registerProject({root:projectRoot}),context='完整保留的运行元数据🌿'.repeat(10000);
  const closeSetupCompute=require('./content-compute-fixture.cjs').attachLazyContentCompute(setup);
  const run=await setup.prepareRun(project.projectId,project.locationId,{root:projectRoot,executionLogId:1,nodeId:'step',runKind:'step',prompt:'original prompt',command:'original command',userMessage:'original request',metadata:{largeContext:context},idempotencyKey:'runtime-input-publication-fixture'});
  const databaseId=setup.databaseId;await closeSetupCompute();setup.close();
  const observer=UnifiedDataStore.openReadOnly(root,databaseId);t.after(()=>observer.close());
  const domains=await RuntimeDataExecutionDomains.start({root,databaseId});t.after(()=>domains.close());
  const targets=Array.from({length:301},(_,i)=>`runtime-unavailable-source-${i}`),prompt=JSON.stringify({sourceContents:Object.fromEntries(targets.map((id,i)=>[i,id])),raw:crypto.randomBytes(8*1024*1024).toString('base64'),lessons:Array.from({length:301},(_,i)=>`solomap://objects/runtime-absent-lesson-${i} · revision=1`)});
  const input={projectId:project.projectId,executionLogId:1,generation:run.generation,expectedRevision:1,idempotencyKey:'actual-prepared-run-input',prompt,command:'',status:'Waiting'};
  const started=performance.now(),rssBefore=process.memoryUsage().rss;let complete=false,readsDuring=0,writesDuring=0,maximumReadMs=0,maximumWriteMs=0,rssPeak=rssBefore,walPeak=0,publicationMs=0;
  const sample=setInterval(()=>{rssPeak=Math.max(rssPeak,process.memoryUsage().rss);try{walPeak=Math.max(walPeak,fs.statSync(path.join(root,'solomap.db-wal')).size);}catch{}},5);t.after(()=>clearInterval(sample));
  const preparing=domains.dispatchSerialized({operation:'patch_run_inputs',input}).then(result=>{complete=true;publicationMs=performance.now()-started;return result;});void preparing.catch(()=>{});
  const deadline=Date.now()+10000;let ownerObserved=false;
  while(!complete && Date.now()<deadline){
    if(observer.rows('SELECT 1 FROM content_lifecycle_prepare_owners LIMIT 1').length){ownerObserved=true;break;}
    await new Promise(resolve=>setTimeout(resolve,1));
  }
  assert.ok(ownerObserved,'the original persistent preparation owner must be observed before unrelated work is submitted');
  assert.equal(complete,false,'the actual Writer has admitted preparation before unrelated work is submitted');
  const saved=[];
  for(let index=0;index<6 && !complete;index++){
    const reading=performance.now(),writing=performance.now();
    const [,receipt]=await Promise.all([
      domains.operations({operation:'read',input:{ref:project.projectId}}).then(value=>{maximumReadMs=Math.max(maximumReadMs,performance.now()-reading);if(!complete)readsDuring++;return value;}),
      domains.operations({operation:'write',input:{kind:'memory',action:'create',scope:project.projectId,idempotencyKey:`during-input-publication-${index}`,data:{category:'inbox',title:`local work ${index}`,status:'captured',content:`saved while input was preparing ${index}`}}}).then(value=>{maximumWriteMs=Math.max(maximumWriteMs,performance.now()-writing);if(!complete)writesDuring++;return value;})
    ]);saved.push(receipt);
  }
  const serialized=await preparing,result=JSON.parse(serialized);
  assert.ok(readsDuring>0,'the independent reader must finish work before input preparation completes');
  assert.ok(writesDuring>0,'an unrelated small write must finish before input preparation completes');
  assert.equal(result.revision,2);assert.equal(result.status.largeContext,context);assert.equal(result.status.status,'Waiting');assert.equal(observer.read(run.runId,2).data.prompt_content,prompt);assert.equal(observer.read(run.runId,2).data.command_content,'');
  const promptId=observer.rows('SELECT prompt_content_id FROM runs WHERE id=?',[run.runId])[0].prompt_content_id;
  assert.equal(observer.rows('SELECT COUNT(*) AS n FROM content_lifecycle_edges WHERE source_id=?',[promptId])[0].n,301);
  const counts=()=>observer.rows('SELECT (SELECT COUNT(*) FROM contents) AS contents,(SELECT COUNT(*) FROM events) AS events,(SELECT COUNT(*) FROM requests) AS requests')[0],beforeReplay=counts();
  const replaySerialized=await domains.dispatchSerialized({operation:'patch_run_inputs',input}),replay=JSON.parse(replaySerialized),hash=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
  assert.equal(hash(replay),hash(result),'serialized replay preserves the full original public value, including all large metadata; JSON property order is not part of the receipt contract');
  assert.deepEqual(counts(),beforeReplay,'replay adds no payload, request or event history');
  assert.equal(observer.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
  assert.equal(observer.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
  for(const receipt of saved)assert.match(observer.read(receipt.objectId).data.content,/saved while input was preparing/);
  clearInterval(sample);
  t.diagnostic(JSON.stringify({promptBytes:Buffer.byteLength(prompt),metadataBytes:Buffer.byteLength(context),publicationMs,elapsedMs:performance.now()-started,readsDuring,writesDuring,maximumReadMs,maximumWriteMs,rssBefore,rssAfter:process.memoryUsage().rss,rssPeak,walPeak,wirePropertyOrderIdentical:replaySerialized===serialized,qualification:'isolated actual Runtime domains, original Compute and serialized consumer; overlap is the admitted publication RPC window, not a specific physical encoding or writing phase; RSS includes shared existing workers and parent verification, timing includes full request/response; full references and missing-lesson fanout, exact public value replay and ownership exit; not formal retained database/Host/Browser or final resource budget evidence'}));
});
