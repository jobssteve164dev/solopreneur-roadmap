const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {RuntimeDataExecutionDomains}=require('../out/runtimeDataExecutionDomains.js');
const {canonicalJson}=require('../out/contentReferences.js');

for(const operation of ['prepare_run','prepare_run_intent'])test(`actual Source and Compute publish and replay a complete serialized ${operation} while another Writer request commits`,async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-run-creation-runtime-')),root=path.join(base,'data'),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  const setup=new UnifiedDataStore(root),project=await setup.registerProject({root:projectRoot}),databaseId=setup.databaseId;setup.close();
  const observer=UnifiedDataStore.openReadOnly(root,databaseId);t.after(()=>observer.close());
  const domains=await RuntimeDataExecutionDomains.start({root,databaseId});t.after(()=>domains.close());
  const prompt=crypto.randomBytes(1024*1024).toString('base64'),userMessage='完整原始消息'.repeat(20000),metadata={context:'完整保留上下文'.repeat(18000),launchIntentHash:'actual-runtime-creation-intent'},input={root:projectRoot,executionLogId:operation==='prepare_run'?1:0,nodeId:'step',runKind:'step',prompt,command:'',userMessage,metadata,...(operation==='prepare_run_intent'?{launchIntentId:'actual-runtime-launch-intent'}:{}),idempotencyKey:'actual-runtime-creation'};
  let finished=false;const creating=domains.dispatchSerialized({operation,input}).then(value=>{finished=true;return value;});void creating.catch(()=>{});
  const deadline=Date.now()+10000;let owned=false;
  while(!finished && Date.now()<deadline){if(observer.rows('SELECT 1 FROM content_lifecycle_prepare_owners LIMIT 1').length){owned=true;break;}await new Promise(resolve=>setTimeout(resolve,1));}
  assert.equal(owned,true);
  const receipt=await domains.operations({operation:'write',input:{kind:'memory',action:'create',scope:project.projectId,idempotencyKey:'during-real-runtime-creation',data:{category:'inbox',title:'local foreground work',status:'captured',content:'committed while the complete run was preparing'}}});
  assert.equal(finished,false,'the independent write must commit during the admitted creation RPC');
  const result=JSON.parse(await creating);assert.equal(result.status.context,metadata.context);assert.equal(result.status.userMessage,userMessage);assert.equal(typeof result.proof,'string');
  assert.equal(observer.read(result.runId,1).data.prompt_content,prompt);assert.equal(observer.read(result.taskId,1).data.original_request_content,userMessage);
  assert.match(observer.read(receipt.objectId).data.content,/complete run was preparing/);
  const counts=()=>observer.rows('SELECT (SELECT COUNT(*) FROM contents) AS contents,(SELECT COUNT(*) FROM events) AS events,(SELECT COUNT(*) FROM requests) AS requests')[0],before=counts();
  const replay=JSON.parse(await domains.dispatchSerialized({operation,input}));
  if(operation==='prepare_run')assert.equal(canonicalJson(replay),canonicalJson(result));
  else{const {receipt:_receipt,...checkpoint}=result;assert.equal(canonicalJson(replay),canonicalJson(checkpoint));}
  assert.deepEqual(counts(),before);
  assert.equal(observer.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(observer.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});
