const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {RuntimeDataExecutionDomains}=require('../out/runtimeDataExecutionDomains.js');

test('actual Runtime Writer and Maintenance Compute materialize complete prompts while foreground readers and writes continue',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-input-runtime-')),root=path.join(base,'data'),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  const store=new UnifiedDataStore(root),project=await store.registerProject({root:projectRoot});
  const closeSetupCompute=require('./content-compute-fixture.cjs').attachLazyContentCompute(store);
  const prompt=crypto.randomBytes(16*1024*1024).toString('base64')+'\n完整输入🌿',bytes=Buffer.from(prompt);
  const run=await store.prepareRun(project.projectId,project.locationId,{root:projectRoot,executionLogId:1,nodeId:'step',runKind:'agent_review',prompt,command:'readonly',userMessage:'复核',idempotencyKey:'runtime-input'});
  const databaseId=store.databaseId,identity={projectId:project.projectId,executionLogId:1,generation:run.generation,proof:run.proof};await closeSetupCompute();store.close();
  const observer=UnifiedDataStore.openReadOnly(root,databaseId);t.after(()=>observer.close());
  const domains=await RuntimeDataExecutionDomains.start({root,databaseId});t.after(()=>domains.close());
  await assert.rejects(domains.operations({operation:'materialize_run_prompt',input:{...identity,proof:'invalid'}}),/run_proof_denied/);
  const started=performance.now();let complete=false,readsDuring=0,writesDuring=0,maximumReadMs=0,physicalPath,enteredAtBytes;
  const writesByKind={text:0,structured:0,binary:0};
  const materializing=domains.operations({operation:'materialize_run_prompt',input:identity}).then(result=>{complete=true;return result;});
  void materializing.catch(()=>undefined);
  const enteringDeadline=Date.now()+5000;
  while(!physicalPath && !complete && Date.now()<enteringDeadline){
    const registration=observer.readRunInputFileEntry(identity);
    if(registration && fs.existsSync(registration.path)){
      const size=fs.statSync(registration.path).size;
      if(size>0 && size<bytes.length){physicalPath=registration.path;enteredAtBytes=size;break;}
    }
    await new Promise(resolve=>setTimeout(resolve,1));
  }
  assert.ok(physicalPath,'the actual Compute worker must have started writing before foreground work is submitted');
  const stillWriting=()=>!complete && fs.existsSync(physicalPath) && fs.statSync(physicalPath).size<bytes.length;
  const saved=[];
  for(let index=0;index<8 && !complete;index++){
    const readingStarted=performance.now();
    const [state,...receipts]=await Promise.all([
      domains.operations({operation:'read_run_state',input:{projectId:project.projectId,executionLogId:1}}).then(result=>{maximumReadMs=Math.max(maximumReadMs,performance.now()-readingStarted);if(stillWriting())readsDuring++;return result;}),
      ...Object.keys(writesByKind).map(kind=>{
        const text=`saved during materialization ${index}`,content=kind==='text'?text:kind==='structured'?{text}:{encoding:'base64',data:Buffer.from(text).toString('base64'),mimeType:'text/plain'};
        return domains.operations({operation:'write',input:{kind:'memory',action:'create',scope:project.projectId,idempotencyKey:`input-foreground-${index}-${kind}`,data:{category:'inbox',title:`foreground ${index} ${kind}`,status:'captured',content}}}).then(result=>{if(stillWriting()){writesDuring++;writesByKind[kind]++;}return {...result,kind};});
      })
    ]);
    assert.equal(state.runId,run.runId);saved.push(...receipts);
  }
  const materialized=await materializing;
  assert.ok(readsDuring>0,'real foreground readers must progress while the physical input file is still incomplete');
  assert.ok(writesDuring>0,'real foreground writes must progress while the physical input file is still incomplete');
  for(const [kind,count] of Object.entries(writesByKind))assert.ok(count>0,`${kind} small writes must finish before the actual Compute input file is complete`);
  assert.equal(materialized.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));assert.equal(materialized.size,bytes.length);
  assert.deepEqual(fs.readFileSync(materialized.path),bytes);
  await domains.operations({operation:'release_run_prompt',input:identity});assert.equal(fs.existsSync(materialized.path),false);
  for(const receipt of saved){
    const content=(await domains.operations({operation:'read',input:{ref:receipt.objectId}})).data.content;
    assert.match(receipt.kind==='binary'?Buffer.from(content.data,'base64').toString():receipt.kind==='structured'?JSON.parse(content).text:content,/saved during materialization/);
  }
  t.diagnostic(JSON.stringify({bytes:bytes.length,enteredAtBytes,materializeAndConcurrentWorkMs:performance.now()-started,readsDuring,writesDuring,writesByKind,maximumReadMs,qualification:'real Runtime execution domains and existing Compute; text, structured and binary small write submissions and completions observed after physical writing begins and before the file is complete; excludes fixture construction and does not replace Host/Browser or formal resource gates'}));
});
