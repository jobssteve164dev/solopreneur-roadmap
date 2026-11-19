const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {Worker}=require('node:worker_threads');
const {once}=require('node:events');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {createRuntimeDataOperations}=require('../out/runtimeDataOperations.js');
const {RuntimeExecutionScheduler,continueRuntimeWork,readRuntimeWorkContinuation,resumeRuntimeWork}=require('../out/runtimePriorityScheduler.js');
const {RuntimeDataExecutionDomains}=require('../out/runtimeDataExecutionDomains.js');
const {removeOwnedEntry}=require('../scripts/owned-fixture-cleanup.cjs');

test('the production storage-ready boundary enables collection and preserves referenced history across restart',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-storage-activation-'));
  const root=path.join(base,'.solomap-global');
  const project=path.join(base,'project');
  const csvPath=path.join(project,'.solopreneur','roadmap.csv');
  fs.mkdirSync(path.dirname(csvPath),{recursive:true});
  fs.writeFileSync(csvPath,'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,Original roadmap,,Build,,,,Pending,,\n');
  let domains;
  t.after(async()=>{await domains?.close();removeOwnedEntry(base,base);});
  const setup=new UnifiedDataStore(root);
  const databaseId=setup.databaseId;
  const orphan=setup.putContent('unreferenced bytes reserved for this test');
  const history=setup.putContent('retained history', 'text/plain', 'utf8');
  const retained=setup.write({kind:'memory',action:'create',scope:null,idempotencyKey:'retained-history',
    data:{category:'inbox',status:'captured',title:'History',content:{bodyContentId:history}}});
  setup.db.run("UPDATE content_lifecycle_reference_progress SET cursor='',upper_id=(SELECT MAX(id) FROM contents) WHERE id=1");
  setup.close();
  const read=operation=>{
    const reader=UnifiedDataStore.openReadOnly(root,databaseId);
    try{return operation(reader);}finally{reader.close();}
  };
  const state=()=>read(reader=>reader.rows('SELECT enabled,strict_publication,incarnation,revision,deleted_contents,reclaimed_stored_bytes FROM content_lifecycle_gc_state WHERE id=1')[0]);
  const start=()=>RuntimeDataExecutionDomains.start({root,databaseId,
    runtime:{runtimeId:crypto.randomUUID(),releaseVersion:'0.0.655',buildId:'storage-activation-test'}});
  domains=await start();
  assert.equal(state().enabled,0);
  await domains.control('storage_maintenance_ready');
  const enabled=state();
  assert.equal(enabled.enabled,1);
  assert.equal(enabled.strict_publication,0);
  assert.notEqual(enabled.incarnation,'');
  await domains.control('storage_maintenance_ready');
  assert.deepEqual(state(),enabled);
  assert.equal(read(reader=>reader.prepareStorageGcBatch()).action,'idle','unindexed history protects the original content');
  assert.equal(read(reader=>reader.content(orphan).toString()),'unreferenced bytes reserved for this test');

  const accepted=await domains.operations({operation:'accept_roadmap_csv',input:{root:project}});
  const updated=await domains.operations({operation:'update_roadmap',input:{root:project,expectedRevision:accepted.revision,
    nodes:accepted.nodes.map(node=>({...node,title:'Updated after activation'})),idempotencyKey:'roadmap-after-activation'}});
  assert.equal(updated.pending,false);
  assert.match(fs.readFileSync(csvPath,'utf8'),/Updated after activation/);

  for(let i=0;i<512;i++){
    await domains.operations({operation:'maintain_database_storage',input:{phase:'lifecycle',automatic:true,limit:64}});
    const exists=read(reader=>reader.rows('SELECT 1 FROM contents WHERE id=?',[orphan]).length);
    if(!exists)break;
    assert.notEqual(i,511,'production maintenance must reclaim the proven orphan');
  }
  const reclaimed=state();
  assert.ok(reclaimed.deleted_contents>0 && reclaimed.reclaimed_stored_bytes>0);
  assert.equal(read(reader=>reader.content(history).toString()),'retained history');
  assert.equal(read(reader=>reader.read(retained.objectId,1).data.content),JSON.stringify({bodyContentId:history}));
  await domains.close();domains=undefined;
  domains=await start();
  const resumed=state();
  assert.equal(resumed.enabled,1);
  assert.equal(resumed.strict_publication,0);
  assert.notEqual(resumed.incarnation,enabled.incarnation);
  assert.equal(resumed.deleted_contents,reclaimed.deleted_contents);
  await domains.control('storage_maintenance_ready');
  assert.deepEqual(state(),resumed);
  assert.equal(read(reader=>reader.content(history).toString()),'retained history');
  const roadmap=await domains.operations({operation:'read_roadmap',input:{root:project}});
  assert.equal(roadmap.nodes[0].title,'Updated after activation');
});

test('the complete storage entry releases maintenance admission between real cleanup pieces and returns complete totals',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-full-maintenance-')),root=path.join(base,'data'),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  const store=new UnifiedDataStore(root),project=await store.registerProject({root:projectRoot});
  for(let i=0;i<160;i++){
    const relativePath=`step/1/cache/piece-${i}.bin`,bytes=Buffer.from(`regenerable fixture ${i}`),hash=crypto.createHash('sha256').update(bytes).digest('hex');
    store.writeHistoricalRunArtifact(project.projectId,{executionLogId:1,relativePath,bytes,hash},'output');
    store.db.run("UPDATE project_run_artifacts SET artifact_kind='unclassified' WHERE project_id=? AND relative_path=?",[project.projectId,relativePath]);
  }
  store.beginContentPreparationRecovery();store.activateStorageContentLifecycle({strictPublication:false});
  const worker=new Worker(path.resolve(__dirname,'../out/maintenanceComputeWorker.js'),{workerData:{root,databaseId:store.databaseId}}),pending=new Map();let sequence=0;
  worker.on('message',message=>{const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);message.error?entry.reject(Error(message.error)):entry.resolve(message.result);});
  await once(worker,'message');
  const rpc=(operation,limit,value)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});worker.postMessage({id,operation,limit,value});});
  let enter,release,calls=0;const entering=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;}),order=[];
  store.setMaintenanceCompute({prepareStorageRunOutputBatch:async limit=>{
    order.push(`output-piece-${++calls}`);if(calls===1){enter();await gate;}return rpc('prepare_storage_run_output_batch',limit);
  },prepareProjectRetirementPage:value=>rpc('prepare_project_retirement_page',undefined,value),qualifyProjectRetirement:value=>rpc('qualify_project_retirement',undefined,value),prepareStorageReferenceBatch:limit=>rpc('prepare_storage_reference_batch',limit),prepareStorageColdBatch:limit=>rpc('prepare_storage_cold_batch',limit),prepareStorageGcBatch:limit=>rpc('prepare_storage_gc_batch',limit)});
  // Internal Source mode returns local continuation values; no public API or closure crosses a worker boundary.
  const operations=createRuntimeDataOperations(store,undefined,undefined,undefined,undefined,undefined,{storageContinuations:true}),scheduler=new RuntimeExecutionScheduler();
  let complete,other;
  t.after(async()=>{release();await Promise.allSettled([complete,other]);await operations.close();await worker.terminate();store.close();});
  complete=scheduler.submit('maintenance',()=>operations({operation:'maintain_database_storage',input:{compact:false,automatic:false}}));void complete.catch(()=>{});
  await entering;
  other=scheduler.submit('maintenance',async()=>{order.push('other-maintenance');return 'other complete';});
  release();const result=await complete;assert.equal(await other,'other complete');
  assert.ok(order.indexOf('other-maintenance')<order.indexOf('output-piece-2'),'another accepted maintenance operation must finish before the next cleanup piece is admitted');
  assert.equal(result.deletedArtifacts,160);assert.equal(result.deletedSources,0);assert.equal(result.compacted,false);
  assert.equal(store.rows("SELECT COUNT(*) AS n FROM project_run_artifacts WHERE artifact_kind IN ('unclassified','byproduct')")[0].n,0);
  const audit=store.rows('SELECT status,deleted_artifacts FROM database_storage_maintenance ORDER BY started_at DESC LIMIT 1')[0];
  assert.equal(audit.status,'completed');assert.equal(audit.deleted_artifacts,160);
});

for(const serialized of [false,true])test(`real Source transport re-admits complete maintenance between physical metadata pieces (${serialized?'serialized':'object'} result)`,async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-full-maintenance-domain-')),root=path.join(base,'data'),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  const setup=new UnifiedDataStore(root),project=await setup.registerProject({root:projectRoot});
  for(let i=0;i<160;i++){
    const relativePath=`step/1/cache/domain-${i}.bin`,bytes=Buffer.from(`regenerable domain fixture ${i}`),hash=crypto.createHash('sha256').update(bytes).digest('hex');
    setup.writeHistoricalRunArtifact(project.projectId,{executionLogId:1,relativePath,bytes,hash},'output');
    setup.db.run("UPDATE project_run_artifacts SET artifact_kind='unclassified' WHERE project_id=? AND relative_path=?",[project.projectId,relativePath]);
  }
  const bodies=setup.rows('SELECT DISTINCT content_id FROM project_run_artifacts').map(row=>String(row.content_id));
  setup.beginContentPreparationRecovery();setup.activateStorageContentLifecycle({strictPublication:false});const databaseId=setup.databaseId;setup.close();
  const observer=UnifiedDataStore.openReadOnly(root,databaseId);t.after(()=>observer.close());
  let domains,other,remainingAtYield,remainingDuringOther;const admissions=[];
  const count=()=>Number(observer.rows("SELECT COUNT(*) AS n FROM project_run_artifacts WHERE artifact_kind IN ('unclassified','byproduct')")[0].n);
  class ObservedScheduler extends RuntimeExecutionScheduler {
    submit(domain,action,options){
      const inspect=value=>{
        const continuation=readRuntimeWorkContinuation(value);if(!continuation)return value;
        const remaining=count();
        if(!other && remaining>0 && remaining<160){
          remainingAtYield=remaining;
          other=this.submit('maintenance',async admission=>{remainingDuringOther=count();return domains.dispatchAdmitted({operation:'maintain_database_storage',input:{phase:'cold',limit:8}},admission);},{label:'other-real-cold'});
          void other.catch(()=>{});
        }
        return continueRuntimeWork(async admission=>{admissions.push(admission.id);return inspect(await resumeRuntimeWork(continuation,admission));},continuation.waitFor);
      };
      return super.submit(domain,async admission=>inspect(await action(admission)),options);
    }
  }
  const scheduler=new ObservedScheduler();domains=await RuntimeDataExecutionDomains.start({root,databaseId,scheduler});t.after(()=>domains.close());
  const request={operation:'maintain_database_storage',input:{compact:false,automatic:false}};
  const value=await(serialized?domains.dispatchSerialized(request):domains.operations(request)),result=serialized?JSON.parse(value):value;
  assert.ok(other,'an actual continuation was observed after some metadata was deleted and before the complete result');await other;
  assert.equal(remainingDuringOther,remainingAtYield,'the other admitted maintenance executes before the next physical cleanup piece');
  assert.ok(admissions.length>1);assert.equal(new Set(admissions).size,admissions.length);
  assert.equal(result.deletedArtifacts,160);assert.equal(result.pendingByproductRecords,0);assert.equal(count(),0);
  assert.ok(result.deletedContents>=160,'the final total includes actual sealed collector commits');assert.ok(result.reclaimedStoredBytes>0);assert.equal(result.pending,false);
  for(const id of bodies)assert.equal(observer.rows('SELECT 1 FROM contents WHERE id=?',[id]).length,0,'metadata handoff is not physical payload reclamation');
  assert.equal(observer.rows('SELECT status FROM database_storage_maintenance ORDER BY started_at DESC LIMIT 1')[0].status,'completed');
});

test('actual compaction waits outside its lane for preceding and subsequently admitted complete maintenance',async t=>{
  const watchdog=setTimeout(()=>{process.stderr.write('owned generation dependency regression did not drain\n');process.exit(1);},60000);watchdog.unref();
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-maintenance-generation-dependency-')),root=path.join(base,'data'),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  const setup=new UnifiedDataStore(root),project=await setup.registerProject({root:projectRoot});
  for(let i=0;i<80;i++){
    const relativePath=`step/1/cache/dependency-${i}.bin`,bytes=Buffer.from(`generation dependency fixture ${i}`),hash=crypto.createHash('sha256').update(bytes).digest('hex');
    setup.writeHistoricalRunArtifact(project.projectId,{executionLogId:1,relativePath,bytes,hash},'output');setup.db.run("UPDATE project_run_artifacts SET artifact_kind='unclassified' WHERE project_id=? AND relative_path=?",[project.projectId,relativePath]);
  }
  setup.beginContentPreparationRecovery();setup.activateStorageContentLifecycle({strictPublication:false});const databaseId=setup.databaseId;setup.close();
  const observer=UnifiedDataStore.openReadOnly(root,databaseId);t.after(()=>observer.close());
  let domains,compaction,following,inserted=false;
  const count=()=>Number(observer.rows("SELECT COUNT(*) AS n FROM project_run_artifacts WHERE artifact_kind IN ('unclassified','byproduct')")[0].n);
  class DependencyScheduler extends RuntimeExecutionScheduler {
    submit(domain,action,options){
      const inspect=value=>{
        const continuation=readRuntimeWorkContinuation(value);if(!continuation)return value;
        const remaining=count();
        if(!inserted && remaining>0 && remaining<80){
          inserted=true;
          compaction=domains.operations({operation:'maintain_database_storage',input:{compact:true,idempotencyKey:'after-complete-maintenance'}});void compaction.catch(()=>{});
          following=domains.operations({operation:'maintain_database_storage',input:{compact:false,automatic:false}});void following.catch(()=>{});
        }
        return continueRuntimeWork(async admission=>inspect(await resumeRuntimeWork(continuation,admission)),continuation.waitFor);
      };
      return super.submit(domain,async admission=>inspect(await action(admission)),options);
    }
  }
  domains=await RuntimeDataExecutionDomains.start({root,databaseId,scheduler:new DependencyScheduler()});t.after(()=>domains.close());t.after(()=>clearTimeout(watchdog));
  const first=await domains.operations({operation:'maintain_database_storage',input:{compact:false,automatic:false}});
  assert.equal(inserted,true);assert.equal(first.deletedArtifacts,80);assert.equal((await following).deletedArtifacts,0);
  await assert.rejects(compaction,/database_generation_cutover/,'the real candidate must reach its durable cutover instead of holding the lane while its prerequisites cannot run');
  assert.equal(count(),0);
  assert.equal(observer.rows("SELECT COUNT(*) AS n FROM database_storage_maintenance WHERE status='completed' AND compacted=0")[0].n,2);
});

test('a full maintenance piece rechecks its original Pi fence after actual Compute and closes its audit on rejection',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-full-maintenance-fence-')),root=path.join(base,'data'),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  const store=new UnifiedDataStore(root),project=await store.registerProject({root:projectRoot});
  for(let i=0;i<5;i++){
    const relativePath=`step/1/cache/fenced-${i}.bin`,bytes=Buffer.from(`retain after revoked owner ${i}`),hash=crypto.createHash('sha256').update(bytes).digest('hex');
    store.writeHistoricalRunArtifact(project.projectId,{executionLogId:1,relativePath,bytes,hash},'output');store.db.run("UPDATE project_run_artifacts SET artifact_kind='unclassified' WHERE project_id=? AND relative_path=?",[project.projectId,relativePath]);
  }
  store.beginContentPreparationRecovery();store.activateStorageContentLifecycle({strictPublication:false});
  const owner=store.claimPiExecutionOwner('full-maintenance-owner');
  const operation=store.admitPiConversationOperation({schemaVersion:1,conversationId:'816381ea-9418-4edc-bbcd-ec8d9979b152',operationId:'full-maintenance-operation',requestKey:'full-maintenance-operation',prompt:'fixture',attachments:[],baselineRevision:0,source:'sidebar',sourceGeneration:1,projectScope:'',systemPrompt:'fixture',projectContext:{selectedProject:'',projects:[]},model:{provider:'agent-cli',modelId:'auto'},tools:[],executionProfile:'pi-core-0.87.1-v1',options:{retry:'native',compaction:'native',toolExecution:'sequential'}},owner);
  store.admitPiToolInvocation(operation.operationId,owner,{invocationId:'full-maintenance-call',toolName:'solomap_write',arguments:{},replay:'never'});
  const fence={operationId:operation.operationId,invocationId:'full-maintenance-call',ownerId:owner.ownerId,ownerGeneration:owner.generation};
  const worker=new Worker(path.resolve(__dirname,'../out/maintenanceComputeWorker.js'),{workerData:{root,databaseId:store.databaseId}});await once(worker,'message');
  let sequence=0;
  const rpc=async(operation,input)=>{
    const response=once(worker,'message');worker.postMessage({id:++sequence,operation,...input});const[message]=await response;if(message.error)throw Error(message.error);return message.result;
  };
  let enter,release;const entering=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  store.setMaintenanceCompute({prepareStorageRunOutputBatch:async limit=>{
    const result=await rpc('prepare_storage_run_output_batch',{limit});enter();await gate;return result;
  },prepareProjectRetirementPage:value=>rpc('prepare_project_retirement_page',{value}),qualifyProjectRetirement:value=>rpc('qualify_project_retirement',{value})});
  const operations=createRuntimeDataOperations(store,undefined,undefined,undefined,undefined,undefined,{storageContinuations:true}),scheduler=new RuntimeExecutionScheduler();let pending;
  t.after(async()=>{release();await Promise.allSettled([pending]);await operations.close();await worker.terminate();store.close();});
  pending=scheduler.submit('maintenance',()=>operations({operation:'maintain_database_storage',piToolFence:fence,input:{compact:false,automatic:false}}));void pending.catch(()=>{});
  await entering;store.claimPiExecutionOwner('replacement-full-maintenance-owner');release();await assert.rejects(pending,/pi_owner_fenced|pi_tool_invocation_fenced/);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM project_run_artifacts')[0].n,5);assert.equal(store.liveStorageMaintenanceIds.size,0);
  assert.equal(store.rows('SELECT status FROM database_storage_maintenance ORDER BY started_at DESC LIMIT 1')[0].status,'failed');
});

test('real checkpoint writes wake the existing Supervisor channel without leaving an unconsumed Source continuation',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-checkpoint-maintenance-wake-')),root=path.join(base,'data'),setup=new UnifiedDataStore(root),databaseId=setup.databaseId;setup.close();
  let wakes=0;const domains=await RuntimeDataExecutionDomains.start({root,databaseId,onStorageMaintenanceWake:()=>{wakes++;}});t.after(()=>domains.close());
  const id='cf151efe-78de-4116-a819-40b91299f76f',createdAt='2026-10-18T00:00:00.000Z';let revision=0;
  for(let turn=0;turn<2;turn++){
    const messages=Array.from({length:(turn+1)*2},(_,index)=>({role:index%2?'assistant':'user',content:`full checkpoint message ${index}`})),count=messages.length-1;
    const sourceHash=crypto.createHash('sha256').update(JSON.stringify(messages.slice(0,count).map(message=>({role:message.role,content:message.content})))).digest('hex');
    const result=await domains.operations({operation:'write_intelligence_conversation',input:{conversation:{id,title:'Checkpoint wake',createdAt,updatedAt:createdAt,messages},expectedRevision:revision,idempotencyKey:`checkpoint-wake-${turn}`,contextCheckpoint:{schemaVersion:1,engine:'pi-harness',sourceMessageCount:count,sourceHash,retainedMessageCount:1,tokensBefore:200000,summary:`checkpoint ${turn}`,createdAt:Date.now()+turn}}});revision=result.revision;
  }
  assert.equal(wakes,2,'checkpoint producers send a coalescible wake event, never a discarded full-operation descriptor');
  const observer=UnifiedDataStore.openReadOnly(root,databaseId);t.after(()=>observer.close());
  assert.equal(observer.readIntelligenceConversation(id).contextCheckpoint.summary,'checkpoint 1');
  assert.ok(observer.rows('SELECT (SELECT COUNT(*) FROM database_storage_cleanup_candidates)+(SELECT COUNT(*) FROM content_lifecycle_gc_pending) AS n')[0].n>0,'the retired body keeps its persistent collection responsibility until the Supervisor advances it');
  let timer;
  try{await Promise.race([domains.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('checkpoint left an unconsumed maintenance drain')),3000);})]);}finally{clearTimeout(timer);}
});
