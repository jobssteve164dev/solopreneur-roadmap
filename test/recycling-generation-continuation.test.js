const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');
const {RuntimeDataExecutionDomains}=require('../out/runtimeDataExecutionDomains.js');
const {RuntimeExecutionScheduler,readRuntimeWorkContinuation,continueRuntimeWork,resumeRuntimeWork}=require('../out/runtimePriorityScheduler.js');

test('actual generation waits outside its lane for an in-progress recycling scope and a subsequently admitted scope operation',async t=>{
  const watchdog=setTimeout(()=>{process.stderr.write('owned recycling generation dependency did not drain\n');process.exit(1);},60000);watchdog.unref();t.after(()=>clearTimeout(watchdog));
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-recycling-generation-')),root=path.join(base,'data'),projectRoot=path.join(base,'solomap-old-init-GenerationScope'),file=path.join(projectRoot,'.solopreneur','issues-cache.json'),bytes=Buffer.from('the full approved cache survives scope and generation continuation');
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
  const setup=new UnifiedDataStore(root),ops=createRuntimeDataOperations(setup);await setup.registerProject({root:projectRoot});
  const identity=`analysis-caches:${root}`,key=path.relative(root,file).split(path.sep).join('/'),hash=crypto.createHash('sha256').update(bytes).digest('hex');
  setup.captureMigrationSource({identity,key,hash},bytes);setup.markMigrationSourceImported(identity,key);
  const plan=await ops({operation:'prepare_recycling',input:{}});await ops({operation:'confirm_recycling',input:{planId:plan.planId}});await ops({operation:'execute_recycling_plan',input:{planId:plan.planId}});
  fs.renameSync(projectRoot,path.join(base,'retained-original-project'));
  setup.enqueueMemoryMigration({collection:'documentation',projectRoot,sourceRoot:path.join(projectRoot,'captured.json')},'protected-scope-generation');
  const databaseId=setup.databaseId;await ops.close();setup.close();
  let domains,compaction,following,steps=0,inserted=false;
  class DependencyScheduler extends RuntimeExecutionScheduler{
    submit(domain,action,options){
      const inspect=value=>{
        const continuation=readRuntimeWorkContinuation(value);if(!continuation)return value;
        if(options?.label==='restore_recycling_file'&&++steps===2){
          inserted=true;assert.equal(fs.existsSync(projectRoot),false);
          compaction=domains.operations({operation:'maintain_database_storage',input:{compact:true,idempotencyKey:'after-accepted-recycling-scope'}});void compaction.catch(()=>{});
          following=domains.operations({operation:'confirm_recycling',input:{planId:plan.planId}});void following.catch(()=>{});
        }
        return continueRuntimeWork(async admission=>inspect(await resumeRuntimeWork(continuation,admission)),continuation.waitFor);
      };
      return super.submit(domain,async admission=>inspect(await action(admission)),options);
    }
  }
  domains=await RuntimeDataExecutionDomains.start({root,databaseId,scheduler:new DependencyScheduler()});t.after(()=>domains.close());
  assert.deepEqual(JSON.parse(await domains.dispatchSerialized({operation:'restore_recycling_file',input:{itemId:plan.files[0].itemId}})),{restored:true,path:file});
  assert.equal(inserted,true);assert.deepEqual(await following,{confirmed:true});
  await assert.rejects(compaction,/database_generation_cutover/,'native generation must reach its durable cutover after both accepted scope flights complete');
  assert.deepEqual(fs.readFileSync(file),bytes);
});
