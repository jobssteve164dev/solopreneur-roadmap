const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{RuntimeDataExecutionDomains}=require('../out/runtimeDataExecutionDomains.js');

test('actual Runtime step metadata preserves serialized results while Reader and unrelated Writer keep working',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-step-memory-runtime-')),root=path.join(base,'data'),workspace=path.join(base,'project');fs.mkdirSync(workspace);
  const setup=new UnifiedDataStore(root),project=await setup.registerProject({root:workspace}),databaseId=setup.databaseId;setup.close();
  const observer=UnifiedDataStore.openReadOnly(root,databaseId),domains=await RuntimeDataExecutionDomains.start({root,databaseId});t.after(async()=>{await domains.close();observer.close();});
  const input={root:workspace,nodeId:'step',expectedRevision:0,patch:{retained:crypto.randomBytes(1024*1024).toString('base64'),completionCriteria:['完整用户标准🌿']},origin:'default',idempotencyKey:'actual-runtime-step-memory'};
  let completed=false;const pending=domains.dispatchSerialized({operation:'write_step_memory',input}).then(value=>{completed=true;return value;});void pending.catch(()=>{});
  const deadline=Date.now()+15000;let admitted=false;
  while(!completed && Date.now()<deadline){if(observer.rows('SELECT 1 FROM content_lifecycle_prepare_owners LIMIT 1').length){admitted=true;break;}await new Promise(resolve=>setTimeout(resolve,1));}
  assert.ok(admitted,'observe real preparation before submitting independent actions');let readsDuring=0,writesDuring=0;const saved=[];
  for(let index=0;index<3 && !completed;index++){
    const [,receipt]=await Promise.all([
      domains.operations({operation:'read',input:{ref:project.projectId}}).then(value=>{if(!completed)readsDuring++;return value;}),
      domains.operations({operation:'write',input:{kind:'memory',action:'create',scope:project.projectId,idempotencyKey:`during-step-${index}`,data:{category:'inbox',title:'独立本地动作',content:`完整本地记录${index}`,status:'captured'}}}).then(value=>{if(!completed)writesDuring++;return value;})
    ]);saved.push(receipt);
  }
  const result=JSON.parse(await pending);assert.equal(result.revision,1);assert.deepEqual(result.data,input.patch);assert.ok(readsDuring>0);assert.ok(writesDuring>0);
  assert.deepEqual(JSON.parse(await domains.dispatchSerialized({operation:'write_step_memory',input})),result);
  assert.deepEqual(observer.readStepMemory(project.projectId,'step',{includeEntries:false}).data,input.patch);for(const receipt of saved)assert.match(observer.read(receipt.objectId).data.content,/完整本地记录/);
  assert.equal(observer.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(observer.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
  t.diagnostic(JSON.stringify({metadataBytes:Buffer.byteLength(input.patch.retained),readsDuring,writesDuring,qualification:'actual Writer/Compute/Reader and serialized consumer; functional overlap only, formal retained-history/Host resource gates still separate'}));
});
