const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');
const {RuntimeExecutionScheduler}=require('../out/runtimePriorityScheduler.js');
const {runtimeOperationDefinition}=require('../out/runtimeOperationRegistry.js');
const {MigrationRecycling}=require('../out/migrationRecycling.js');

async function fixture(t,name='project',sourceMode=false){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-recycling-physical-scope-')),root=path.join(base,'data'),projectRoot=path.join(base,name);fs.mkdirSync(projectRoot);
  const store=new UnifiedDataStore(root),operations=createRuntimeDataOperations(store,undefined,undefined,undefined,undefined,undefined,{storageContinuations:sourceMode}),project=await store.registerProject({root:projectRoot}),scheduler=new RuntimeExecutionScheduler();
  t.after(async()=>{await operations.close();store.close();});
  const call=(operation,input={})=>sourceMode?scheduler.submit(runtimeOperationDefinition(operation).domain,()=>operations({operation,input})):operations({operation,input});
  return{base,root,projectRoot,store,operations,project,call,scheduler};
}
function noLegacyAudit(t,store){
  const scopes=store.registeredProjectScopes,registry=store.readProjectRegistry;
  store.registeredProjectScopes=()=>assert.fail('physical recycling must not invoke the legacy whole-history project audit');
  store.readProjectRegistry=()=>assert.fail('physical recycling must not parse registry JSON in Source');
  t.after(()=>{store.registeredProjectScopes=scopes;store.readProjectRegistry=registry;});
}

test('a project-bound physical source does not probe unrelated registered paths',async t=>{
  const f=await fixture(t),unrelated=path.join(f.base,'unrelated-project');fs.mkdirSync(unrelated);
  await f.store.registerProject({root:unrelated});
  const exists=fs.existsSync,realpath=fs.realpathSync,probes=[];
  fs.existsSync=function(file,...args){if(String(file)===unrelated)probes.push('exists');return exists.call(this,file,...args);};
  fs.realpathSync=function(file,...args){if(String(file)===unrelated)probes.push('realpath');return realpath.call(this,file,...args);};
  let actual;
  try{actual=new MigrationRecycling(f.store).sourcePath(`step-memory:${f.project.projectId}`,'history/actual.md');}
  finally{fs.existsSync=exists;fs.realpathSync=realpath;}
  assert.equal(actual,path.join(f.projectRoot,'.solopreneur','step-memory','history','actual.md'));
  assert.deepEqual(probes,[],'filter by the bound project before asking the filesystem about physical authority');
});

test('physical cache preview, holding and restoring preserve their exact scope without the legacy Source project audit',async t=>{
  const f=await fixture(t),file=path.join(f.projectRoot,'.solopreneur','issues-cache.json'),bytes=Buffer.from('{"keep":"the complete captured cache"}'),identity=`analysis-caches:${f.root}`,key=path.relative(f.root,file).split(path.sep).join('/'),hash=crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(file,bytes);f.store.captureMigrationSource({identity,key,hash},bytes);f.store.markMigrationSourceImported(identity,key);
  noLegacyAudit(t,f.store);
  const plan=await f.call('prepare_recycling');assert.equal(plan.files.length,1);assert.equal(plan.files[0].path,file);
  await f.call('confirm_recycling',{planId:plan.planId});
  const held=await f.call('hold_recycling_file',{itemId:plan.files[0].itemId});assert.equal(fs.existsSync(file),false);assert.deepEqual(fs.readFileSync(held.path),bytes);
  await f.call('restore_recycling_file',{itemId:plan.files[0].itemId});assert.deepEqual(fs.readFileSync(file),bytes);
});

for(const physicalFile of [false,true])test(`captured migration verification preserves existing ${physicalFile?'file':'directory'} path semantics without the legacy Source project audit`,async t=>{
  const f=await fixture(t),key='.solopreneur/documentation.json',bytes=Buffer.from('{"complete":"captured documentation"}'),identity=`documentation:${f.projectRoot}`,hash=crypto.createHash('sha256').update(bytes).digest('hex');
  f.store.captureMigrationSource({identity,key,hash},bytes);f.store.markMigrationSourceImported(identity,key);
  const job=f.store.enqueueMemoryMigration({collection:'documentation',projectRoot:f.projectRoot,sourceRoot:path.join(f.projectRoot,key)},'verify-captured-physical-scope');
  if(physicalFile){fs.renameSync(f.projectRoot,path.join(f.base,'retained-project'));fs.writeFileSync(f.projectRoot,'the registered path now names a file');}
  noLegacyAudit(t,f.store);
  const verified=await f.call('migration_status',{jobId:job.jobId,verifySourceKey:key});
  assert.deepEqual(verified.sourceVerification,{identity,key,hash,bytes:bytes.length,verified:true,stage:'imported'});
});

async function heldMissingCache(t,name,sourceMode=false){
  const f=await fixture(t,name,sourceMode),file=path.join(f.projectRoot,'.solopreneur','issues-cache.json'),bytes=Buffer.from('the entire approved analysis cache'),identity=`analysis-caches:${f.root}`,key=path.relative(f.root,file).split(path.sep).join('/'),hash=crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(file,bytes);f.store.captureMigrationSource({identity,key,hash},bytes);f.store.markMigrationSourceImported(identity,key);
  const plan=await f.call('prepare_recycling');assert.equal(plan.files.length,1);
  await f.call('confirm_recycling',{planId:plan.planId});await f.call('execute_recycling_plan',{planId:plan.planId});
  fs.renameSync(f.projectRoot,path.join(f.base,'retained-original-project'));assert.equal(fs.existsSync(f.projectRoot),false);
  return{...f,file,bytes,itemId:plan.files[0].itemId};
}

test('an approved default cache restore rebuilds a missing ordinary root without Source history scans',async t=>{
  const f=await heldMissingCache(t,'ordinary-missing-root');noLegacyAudit(t,f.store);
  assert.deepEqual(await f.call('restore_recycling_file',{itemId:f.itemId}),{restored:true,path:f.file});
  assert.deepEqual(fs.readFileSync(f.file),f.bytes);
});

for(const changed of [false,true])test(`missing test-named root retains its exact migration protection through Compute${changed?' and rejects a late release':''}`,async t=>{
  const f=await heldMissingCache(t,`solomap-old-init-Scoped${changed?'Changed':'Kept'}`);
  const job=f.store.enqueueMemoryMigration({collection:'documentation',projectRoot:f.projectRoot,sourceRoot:path.join(f.projectRoot,'captured.json')},'protected-recycling-root');
  const compute=f.store.storageLifecycleCompute,qualify=compute.qualifyProjectRetirement;let calls=0;
  compute.qualifyProjectRetirement=async candidate=>{
    const result=await qualify(candidate);calls++;
    if(calls===1){assert.equal(result,false,'the actual queued migration protects this otherwise stale test registration');if(changed)f.store.db.run("UPDATE migration_jobs SET status='completed' WHERE id=?",[job.jobId]);}
    return result;
  };
  noLegacyAudit(t,f.store);
  if(changed){
    await assert.rejects(f.call('restore_recycling_file',{itemId:f.itemId}),/recycling_path_invalid/);
    assert.equal(fs.existsSync(f.projectRoot),false);assert.equal(f.store.recyclingItem(f.itemId).status,'trashed');assert.equal(calls,2);
  }else{
    assert.deepEqual(await f.call('restore_recycling_file',{itemId:f.itemId}),{restored:true,path:f.file});assert.deepEqual(fs.readFileSync(f.file),f.bytes);assert.equal(calls,1);
  }
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM temp.solomap_project_retirement_watches')[0].n,0);
});

test('an unprotected vanished test root is not newly authorized by an approved cache receipt',async t=>{
  const f=await heldMissingCache(t,'solomap-old-init-StillExcluded');noLegacyAudit(t,f.store);
  await assert.rejects(f.call('restore_recycling_file',{itemId:f.itemId}),/recycling_path_invalid/);
  assert.equal(fs.existsSync(f.projectRoot),false);assert.equal(f.store.recyclingItem(f.itemId).status,'trashed');
});

test('recycling scope proof invalidation returns to the same Scheduler before recomputing and still restores the approved file',async t=>{
  const f=await heldMissingCache(t,'solomap-old-init-FairScope',true);
  f.store.enqueueMemoryMigration({collection:'documentation',projectRoot:f.projectRoot,sourceRoot:path.join(f.projectRoot,'captured.json')},'fair-protected-root');
  const compute=f.store.storageLifecycleCompute,qualify=compute.qualifyProjectRetirement;let calls=0,other,atOther=Infinity;
  compute.qualifyProjectRetirement=async candidate=>{
    const result=await qualify(candidate);calls++;assert.equal(result,false);
    if(calls<=8){
      f.store.enqueueMemoryMigration({collection:'documentation',projectRoot:f.base,sourceRoot:path.join(f.base,`unrelated-${calls}.json`)},`unrelated-recycling-${calls}`);
      if(!other){other=f.call('maintain_database_storage',{phase:'cold',limit:8}).then(result=>{atOther=calls;return result;});void other.catch(()=>{});}
    }
    return result;
  };
  noLegacyAudit(t,f.store);
  const result=await f.call('restore_recycling_file',{itemId:f.itemId});await other;
  assert.deepEqual(result,{restored:true,path:f.file});assert.deepEqual(fs.readFileSync(f.file),f.bytes);assert.equal(calls,9);assert.ok(atOther<=2);
});

test('transient path existence during Compute cannot authorize an unprotected vanished test root',async t=>{
  const f=await heldMissingCache(t,'solomap-old-init-TransientScope'),compute=f.store.storageLifecycleCompute,qualify=compute.qualifyProjectRetirement;let calls=0;
  assert.equal(f.store.registeredProjectScopes().some(project=>project.root===f.projectRoot),false);
  compute.qualifyProjectRetirement=async candidate=>{
    fs.mkdirSync(f.projectRoot);const result=await qualify(candidate);calls++;
    fs.renameSync(f.projectRoot,path.join(f.base,`retained-transient-${calls}`));return result;
  };
  noLegacyAudit(t,f.store);
  await assert.rejects(f.call('restore_recycling_file',{itemId:f.itemId}),/recycling_path_invalid/);
  assert.equal(fs.existsSync(f.projectRoot),false);assert.equal(f.store.recyclingItem(f.itemId).status,'trashed');assert.equal(calls,1);
});

test('initial standalone scope admission rejection releases its logical close responsibility',async t=>{
  const f=await heldMissingCache(t,'solomap-old-init-RejectedScope');
  f.store.enqueueMemoryMigration({collection:'documentation',projectRoot:f.projectRoot,sourceRoot:path.join(f.projectRoot,'protected.json')},'rejected-scope-protection');
  const submit=RuntimeExecutionScheduler.prototype.submit;let captured,closed=false;
  RuntimeExecutionScheduler.prototype.submit=function(domain,action,options){
    if(options?.label==='standalone:restore_recycling_file'){captured=action;return Promise.reject(Error('fixture_initial_scope_queue_full'));}
    return submit.call(this,domain,action,options);
  };
  let timely;
  try{
    await assert.rejects(f.call('restore_recycling_file',{itemId:f.itemId}),/fixture_initial_scope_queue_full/);
    const closing=f.operations.close().then(()=>{closed=true;});
    await new Promise(resolve=>setTimeout(resolve,50));timely=closed;
    RuntimeExecutionScheduler.prototype.submit=submit;
    // Finish the old leaked fixture flight when running this regression against its pre-fix baseline.
    if(!closed){assert.ok(captured);await new RuntimeExecutionScheduler().submit('maintenance',captured);}
    await closing;
  }finally{RuntimeExecutionScheduler.prototype.submit=submit;}
  assert.equal(timely,true,'a rejected first admission must not leave close waiting for work that was never queued');
});
