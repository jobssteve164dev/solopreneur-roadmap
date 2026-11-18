const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{RuntimeDataExecutionDomains}=require('../out/runtimeDataExecutionDomains.js');

test('actual Runtime background step import retains complete source and fixed history while local actions complete',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-step-import-runtime-')),root=path.join(base,'data'),workspace=path.join(base,'project');fs.mkdirSync(workspace);
  const setup=new UnifiedDataStore(root),project=await setup.registerProject({root:workspace}),databaseId=setup.databaseId;setup.close();
  const sourceRoot=path.join(workspace,'.solopreneur','step-memory');fs.mkdirSync(sourceRoot);
  const value={criteria:['完整历史标准🌿'],unknown:crypto.randomBytes(1024*1024).toString('base64'),entries:[{raw:crypto.randomBytes(2*1024*1024).toString('base64')}]},bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),file=path.join(sourceRoot,'step.json');fs.writeFileSync(file,bytes);
  const observer=UnifiedDataStore.openReadOnly(root,databaseId),domains=await RuntimeDataExecutionDomains.start({root,databaseId});t.after(async()=>{await domains.close();observer.close();});
  const before=await domains.operations({operation:'write_step_memory',input:{root:workspace,nodeId:'step',expectedRevision:0,patch:{user:'用户手动值',criteria:['用户当前标准']},idempotencyKey:'runtime-before-import'}}),started=Date.now(),job=await domains.operations({operation:'import_project_data',input:{collection:'step-memory',sourceRoot,projectRoot:workspace,idempotencyKey:'actual-runtime-step-source'}});
  let readsDuring=0,writesDuring=0,admitted=false,maxReadMs=0,maxWriteMs=0;const saved=[],deadline=Date.now()+30000;
  const complete=()=>observer.rows('SELECT status FROM migration_jobs WHERE id=?',[job.jobId])[0]?.status==='completed';
  while(!complete() && Date.now()<deadline){
    if(observer.rows("SELECT 1 FROM migration_items WHERE source_identity=? AND source_key='step.json' AND stage='captured'",[`step-memory:${project.projectId}`]).length && observer.rows('SELECT 1 FROM content_lifecycle_prepare_owners LIMIT 1').length){admitted=true;break;}
    await new Promise(resolve=>setTimeout(resolve,1));
  }
  assert.ok(admitted,'observe the actual importer after source capture and before its atomic step publication');
  for(let index=0;index<3 && !complete();index++){
    const readStarted=Date.now(),writeStarted=Date.now(),[,receipt]=await Promise.all([
      domains.operations({operation:'read',input:{ref:project.projectId}}).then(value=>{maxReadMs=Math.max(maxReadMs,Date.now()-readStarted);if(!complete())readsDuring++;return value;}),
      domains.operations({operation:'write',input:{kind:'memory',action:'create',scope:project.projectId,idempotencyKey:`during-source-import-${index}`,data:{category:'inbox',title:'本地记录',content:`完整独立记录${index}`,status:'captured'}}}).then(value=>{maxWriteMs=Math.max(maxWriteMs,Date.now()-writeStarted);if(!complete())writesDuring++;return value;})
    ]);saved.push(receipt);
  }
  while(!complete() && Date.now()<deadline){const status=observer.rows('SELECT status,error FROM migration_jobs WHERE id=?',[job.jobId])[0];assert.notEqual(status?.status,'failed',status?.error);await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(complete(),true);assert.ok(readsDuring>0);assert.ok(writesDuring>0);const memory=observer.readStepMemory(project.projectId,'step');assert.equal(memory.revision,2);assert.equal(memory.data.user,'用户手动值');assert.deepEqual(memory.data.criteria,['用户当前标准']);assert.equal(memory.data.unknown,value.unknown);assert.deepEqual(memory.data.entries,value.entries);assert.deepEqual(observer.readStepMemory(project.projectId,'step',{revision:before.revision,includeEntries:false}).data,before.data);
  assert.equal(observer.read(memory.sources[0].objectId,1).data.content,bytes.toString('utf8'));assert.deepEqual(fs.readFileSync(file),bytes);for(const receipt of saved)assert.match(observer.read(receipt.objectId).data.content,/完整独立记录/);
  assert.equal(observer.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(observer.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
  t.diagnostic(JSON.stringify({sourceBytes:bytes.length,elapsedMs:Date.now()-started,readsDuring,writesDuring,maxReadMs,maxWriteMs,qualification:'actual existing Writer/Compute/Reader background importer; functional overlap only; shared file capture and formal retained-history/Host resource gates remain separate'}));
});

test('actual Runtime close finishes the already-started step source and stops at the next file boundary',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-step-import-close-')),root=path.join(base,'data'),workspace=path.join(base,'project');fs.mkdirSync(workspace);
  const setup=new UnifiedDataStore(root),project=await setup.registerProject({root:workspace}),databaseId=setup.databaseId;setup.close();
  const sourceRoot=path.join(workspace,'.solopreneur','step-memory');fs.mkdirSync(sourceRoot);const value={criteria:['完整保留正在导入的文件'],entries:[{raw:crypto.randomBytes(4*1024*1024).toString('base64')}]},bytes=Buffer.from(JSON.stringify(value));fs.writeFileSync(path.join(sourceRoot,'a.json'),bytes);fs.writeFileSync(path.join(sourceRoot,'b.json'),'{}');
  const observer=UnifiedDataStore.openReadOnly(root,databaseId),domains=await RuntimeDataExecutionDomains.start({root,databaseId});let closed=false;t.after(async()=>{try{if(!closed)await domains.close();}finally{observer.close();}});
  const job=await domains.operations({operation:'import_project_data',input:{collection:'step-memory',sourceRoot,projectRoot:workspace,idempotencyKey:'close-during-real-step-import'}}),deadline=Date.now()+30000;let admitted=false;
  while(Date.now()<deadline){if(observer.rows("SELECT 1 FROM migration_items WHERE source_identity=? AND source_key='a.json' AND stage='captured'",[`step-memory:${project.projectId}`]).length && observer.rows('SELECT 1 FROM content_lifecycle_prepare_owners LIMIT 1').length){admitted=true;break;}await new Promise(resolve=>setTimeout(resolve,1));}
  assert.ok(admitted,'close during the real step publication after source capture');await domains.close();closed=true;
  const status=observer.readMigrationJob(job.jobId),memory=observer.readStepMemory(project.projectId,'a');assert.equal(status.status,'interrupted',status.error);assert.ok(memory,'the current file must finish before the Compute worker stops');assert.deepEqual(memory.data.entries,value.entries);assert.deepEqual(memory.data.criteria,value.criteria);assert.equal(observer.read(memory.sources[0].objectId,1).data.content,bytes.toString('utf8'));assert.equal(observer.readStepMemory(project.projectId,'b'),null);assert.equal(status.progress.imported,1);assert.equal(status.progress.interrupted,true);assert.equal(observer.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(observer.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);assert.deepEqual(fs.readFileSync(path.join(sourceRoot,'a.json')),bytes);assert.equal(fs.readFileSync(path.join(sourceRoot,'b.json'),'utf8'),'{}');
});
