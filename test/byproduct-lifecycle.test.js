const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {attachLazyContentCompute}=require('./content-compute-fixture.cjs');

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-byproduct-lifecycle-'));let store=new UnifiedDataStore(root);const closeComputes=[attachLazyContentCompute(store)];
  t.after(async()=>{for(const close of closeComputes)await close();store.close();const directories=[root],files=[];for(let i=0;i<directories.length;i++)for(const name of fs.readdirSync(directories[i])){const entry=path.join(directories[i],name);if(fs.lstatSync(entry).isDirectory())directories.push(entry);else files.push(entry);}for(const file of files)fs.unlinkSync(file);for(const directory of directories.reverse())fs.rmdirSync(directory);});
  assert.equal(typeof store.prepareStorageRunOutputBatch,'function');
  store.reopenFixture=()=>{store.close();store=new UnifiedDataStore(root);closeComputes.push(attachLazyContentCompute(store));return store;};
  return store;
}
function project(store){return store.write({kind:'project',action:'create',scope:null,idempotencyKey:'project',data:{name:'retained run'}}).objectId;}
function artifact(store,projectId,relativePath,text){const bytes=Buffer.from(text),hash=crypto.createHash('sha256').update(bytes).digest('hex');store.writeHistoricalRunArtifact(projectId,{executionLogId:1,relativePath,bytes,hash},'output');store.db.run("UPDATE project_run_artifacts SET artifact_kind='unclassified' WHERE project_id=? AND relative_path=?",[projectId,relativePath]);return{bytes,hash};}
test('periodic byproduct retirement preserves index-declared output and linked source while transferring other roots to GC',async t=>{
  const store=fixture(t),id=project(store),output='step/1/evidence/custom.bin',identity='agent-runs:/retained';
  const kept=artifact(store,id,output,'full declared output');
  store.importProjectRunIndex(id,{executionLogId:1,outputPath:'.solopreneur/agent-runs/'+output});
  for(let i=2;i<=40;i++)store.importProjectRunIndex(id,{executionLogId:i,outputPath:`step/${i}/output.log`});
  store.db.run('UPDATE project_run_indexes SET record_json=record_json WHERE project_id=?',[id]);
  for(const key of [output,'step/1/cache/stale.bin','step/1/cache/linked.bin']){
    const bytes=key===output?kept.bytes:Buffer.from(key),hash=crypto.createHash('sha256').update(bytes).digest('hex');
    store.captureMigrationSource({identity,key,hash},bytes);
    if(key.endsWith('linked.bin'))await store.importObject({kind:'memory',action:'create',scope:id,idempotencyKey:'linked',data:{category:'inbox',title:'retained source',status:'captured',content:'full history'}},{identity,key,hash});
  }
  for(let i=0;i<140;i++)artifact(store,id,`step/1/cache/${i}.bin`,`regenerable ${i}`);
  store.beginContentPreparationRecovery();store.activateStorageContentLifecycle();
  const {Worker}=require('node:worker_threads'),{once}=require('node:events');
  const worker=new Worker(path.resolve(__dirname,'../out/maintenanceComputeWorker.js'),{workerData:{root:store.root,databaseId:store.databaseId}});t.after(()=>worker.terminate());await once(worker,'message');let sequence=0;
  const rpc=async(operation,limit)=>{const ready=once(worker,'message');worker.postMessage({id:++sequence,operation,limit});const[message]=await ready;assert.equal(message.error,undefined);return message.result;};
  store.setMaintenanceCompute({prepareStorageRunOutputBatch:limit=>rpc('prepare_storage_run_output_batch',limit)});
  let retired=0,interleaved=false;
  for(let i=0;i<500;i++){const result=await store.maintainStorageByproductsQuantum(16);retired+=result.deletedArtifacts;
    if(result.deletedArtifacts&&store.rows('SELECT 1 FROM content_lifecycle_run_output_pending LIMIT 1').length)interleaved=true;
    if(!result.pending)break;assert.notEqual(i,499);}
  assert.equal(interleaved,true,'ready byproducts must exit while other index projections are still pending');
  assert.equal(retired,140);assert.equal(store.readRunArtifactBytes(id,1,output).bytes.toString(),'full declared output');
  assert.equal(store.readMigrationSource(identity,output).bytes.toString(),'full declared output');
  assert.equal(store.migrationSourceState(identity,'step/1/cache/stale.bin'),null);
  assert.equal(store.migrationSourceState(identity,'step/1/cache/linked.bin').stage,'imported');
  for(let i=0;i<5000;i++){const ref=store.prepareStorageReferenceBatch(128);store.commitStorageReferenceBatch(ref);if(!ref.pending)break;}
  for(let i=0;i<10000;i++){const gc=store.prepareStorageGcBatch(128);store.commitStorageGcBatch(gc);if(!gc.pending)break;assert.notEqual(i,9999);}
  assert.equal(store.readRunArtifactBytes(id,1,output).bytes.toString(),'full declared output');
  const late=artifact(store,id,'step/1/cache/late.bin','late regenerable data');
  assert.equal((await store.maintainStorageByproductsQuantum(16)).deletedArtifacts,1);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_gc_pending WHERE content_id IN (SELECT id FROM contents WHERE sha256=?)',[late.hash]).length,1);
  const before=store.rows('SELECT total_changes() AS n')[0].n;
  for(let i=0;i<5;i++)assert.equal((await store.maintainStorageByproductsQuantum(16)).pending,false);
  assert.equal(store.rows('SELECT total_changes() AS n')[0].n,before);
});
test('a stale output projection cannot authorize retirement after the declared output changes',t=>{
  const store=fixture(t),id=project(store),first='step/1/cache/first.bin',second='step/1/cache/second.bin';
  artifact(store,id,first,'original first');artifact(store,id,second,'original second');
  store.importProjectRunIndex(id,{executionLogId:1,outputPath:first});
  store.db.run('UPDATE project_run_indexes SET record_json=? WHERE project_id=?',[JSON.stringify({executionLogId:1,outputPath:first}),id]);
  const stale=store.prepareStorageRunOutputBatch(8);
  store.db.run('UPDATE project_run_indexes SET record_json=? WHERE project_id=?',[JSON.stringify({executionLogId:1,outputPath:second}),id]);
  assert.equal(store.commitStorageRunOutputBatch(stale).applied,false);
  assert.equal(store.cleanupDatabaseStorageBatch(8,undefined,true,true).deletedArtifacts,0);
  const fresh=store.prepareStorageRunOutputBatch(8);assert.equal(store.commitStorageRunOutputBatch(fresh).applied,true);
  assert.equal(store.cleanupDatabaseStorageBatch(8,undefined,true,true).deletedArtifacts,1);
  assert.equal(store.readRunArtifactBytes(id,1,second).bytes.toString(),'original second');
  assert.equal(store.readRunArtifactBytes(id,1,first),null);
});
test('the actual v81 migration scans pre-existing run metadata by stable keys and preserves malformed metadata',t=>{
  let store=fixture(t);const id=project(store);
  for(const execution of [1,2,3])store.importProjectRunIndex(id,{executionLogId:execution,outputPath:`step/${execution}/cache/output.bin`});
  store.db.run("UPDATE project_run_indexes SET record_json='null' WHERE execution_log_id=2");
  store.db.run('DROP TRIGGER content_lifecycle_run_output_insert');store.db.run('DROP TRIGGER content_lifecycle_run_output_update');
  for(const table of ['content_lifecycle_run_output_pending','content_lifecycle_run_outputs','content_lifecycle_run_output_progress'])store.db.run('DROP TABLE '+table);
  store.db.run('DELETE FROM schema_migrations WHERE version=81');store=store.reopenFixture();
  const first=store.prepareStorageRunOutputBatch(1);assert.equal(first.history,true);assert.equal(first.records.length,1);
  assert.equal(store.commitStorageRunOutputBatch(first).applied,true);assert.equal(store.commitStorageRunOutputBatch(first).applied,false);
  for(let i=0;i<10;i++){const batch=store.prepareStorageRunOutputBatch(1);store.commitStorageRunOutputBatch(batch);if(!batch.pending)break;assert.notEqual(i,9);}
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_run_outputs')[0].n,3);
  assert.equal(store.rows('SELECT error FROM content_lifecycle_run_outputs WHERE execution_log_id=2')[0].error,'run_index_metadata_invalid');
  assert.equal(store.prepareStorageRunOutputBatch(1).pending,false);
  store.db.run('UPDATE project_run_indexes SET record_json=? WHERE execution_log_id=2',[JSON.stringify({executionLogId:2,outputPath:'step/2/cache/recovered.bin'})]);
  assert.equal(store.commitStorageRunOutputBatch(store.prepareStorageRunOutputBatch(1)).applied,true);
  assert.equal(store.rows('SELECT output_path,error FROM content_lifecycle_run_outputs WHERE execution_log_id=2')[0].error,null);
});
test('native Session replays run output invalidation exactly and continues resolving it after the merge',async t=>{
  const store=fixture(t),id=project(store);store.importProjectRunIndex(id,{executionLogId:1,outputPath:'step/1/cache/old.bin'});
  const candidateRoot=path.join(store.root,'candidate');fs.mkdirSync(candidateRoot);await store.db.backup(path.join(candidateRoot,'solomap.db'));
  const candidate=new UnifiedDataStore(candidateRoot);
  try{
    store.beginDatabaseGenerationCapture();
    store.db.run('UPDATE project_run_indexes SET record_json=? WHERE project_id=?',[JSON.stringify({executionLogId:1,outputPath:'step/1/cache/new.bin'}),id]);
    const first=store.rotateDatabaseGenerationCapture();candidate.applyDatabaseGenerationChangeset(first.changeset,first.searchObjectIds);
    assert.equal(candidate.rows('SELECT 1 FROM content_lifecycle_run_outputs WHERE project_id=?',[id]).length,0);
    assert.equal(candidate.rows('SELECT COUNT(*) AS n FROM content_lifecycle_run_output_pending')[0].n,1);
    store.commitStorageRunOutputBatch(store.prepareStorageRunOutputBatch(8));
    const second=store.stopDatabaseGenerationCapture();candidate.applyDatabaseGenerationChangeset(second.changeset,second.searchObjectIds);
    assert.equal(candidate.rows('SELECT output_path FROM content_lifecycle_run_outputs WHERE project_id=?',[id])[0].output_path,'step/1/cache/new.bin');
    assert.equal(candidate.rows('SELECT 1 FROM content_lifecycle_run_output_pending').length,0);
    assert.equal(candidate.rows('SELECT replaying FROM content_lifecycle_replication_guard')[0].replaying,0);
    assert.equal(candidate.rows('PRAGMA foreign_key_check').length,0);
  }finally{candidate.close();}
});
