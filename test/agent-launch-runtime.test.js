const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {RuntimeDataExecutionDomains}=require('../out/runtimeDataExecutionDomains.js');

test('the actual Agent launch releases the Writer while Compute prepares complete input and preserves the serialized result',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-agent-launch-runtime-')),root=path.join(base,'data'),workspaceRoot=path.join(base,'project');fs.mkdirSync(workspaceRoot);
  const setup=new UnifiedDataStore(root),project=await setup.registerProject({root:workspaceRoot}),databaseId=setup.databaseId;setup.close();
  const observer=UnifiedDataStore.openReadOnly(root,databaseId),domains=await RuntimeDataExecutionDomains.start({root,databaseId});t.after(async()=>{await domains.close();observer.close();});
  const input={agentCli:'claude',selectedModel:'original-model',prompt:crypto.randomBytes(1024*1024).toString('base64'),globalPrompt:'完整固定策略'.repeat(12000),workspaceRoot,nodeId:'__solo__',executionLogId:1,userMessage:'启动完整用户任务',runKind:'solo',globalDataPath:root,taskPermissionMode:'auto',metadata:{retained:'完整元数据'.repeat(12000)},deliveryOwner:{id:'runtime-window',pid:process.pid,birth:''}};
  let completed=false;const pending=domains.dispatchSerialized({operation:'prepare_agent_launch',input}).then(value=>{completed=true;return value;});void pending.catch(()=>{});
  const deadline=Date.now()+15000;let admitted=false;
  while(!completed && Date.now()<deadline){if(observer.rows('SELECT 1 FROM content_lifecycle_prepare_owners LIMIT 1').length){admitted=true;break;}await new Promise(resolve=>setTimeout(resolve,1));}
  assert.ok(admitted,'observe real preparation admission before submitting unrelated Writer work');
  let readsDuring=0,writesDuring=0;
  const saved=[];
  for(let index=0;index<3 && !completed;index++){
    const [,receipt]=await Promise.all([
      domains.operations({operation:'read',input:{ref:project.projectId}}).then(value=>{if(!completed)readsDuring++;return value;}),
      domains.operations({operation:'write',input:{kind:'memory',action:'create',scope:project.projectId,idempotencyKey:`during-agent-${index}`,data:{category:'inbox',status:'captured',title:'并行保存',content:`完整本地动作${index}`}}}).then(value=>{if(!completed)writesDuring++;return value;})
    ]);saved.push(receipt);
  }
  const result=JSON.parse(await pending);
  assert.ok(readsDuring>0,'Reader completes before Agent preparation finishes');assert.ok(writesDuring>0,'unrelated Writer completes before Agent preparation finishes');
  assert.equal(result.revision,5);assert.equal(result.receipt.revision,5);assert.equal(result.status.retained,input.metadata.retained);assert.equal(result.dataRoot,root);assert.match(result.finalCommand,/runAgentProcess/);
  const plan=observer.readRunExecutionPlan(project.projectId,1);assert.ok(plan.prompt.includes(input.prompt));assert.ok(plan.prompt.includes(input.globalPrompt));assert.equal(observer.readRunBinding(project.projectId,1).headRevision,2);
  for(const receipt of saved)assert.match(observer.read(receipt.objectId).data.content,/完整本地动作/);
  assert.equal(observer.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(observer.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
  t.diagnostic(JSON.stringify({promptBytes:Buffer.byteLength(input.prompt),readsDuring,writesDuring,qualification:'actual Runtime Writer/Compute/Reader and serialized consumer; functional overlap only, not formal Host/Browser SLO or retained-history resource gate'}));
});
