const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Worker}=require('node:worker_threads');
const {once}=require('node:events');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');

async function fixture(t,root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-storage-audit-recovery-'))){
  const store=new UnifiedDataStore(root);
  const worker=new Worker(path.resolve(__dirname,'../out/maintenanceComputeWorker.js'),{workerData:{root,databaseId:store.databaseId}});
  const pending=new Map();let id=0;
  worker.on('message',message=>{const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);message.error?entry.reject(Error(message.error)):entry.resolve(message.result);});
  await once(worker,'message');
  const rpc=(operation,input)=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});worker.postMessage({id,operation,...input});});
  store.setMaintenanceCompute({prepareStorageColdBatch:limit=>rpc('prepare_storage_cold_batch',{limit}),
    prepareProjectRetirementPage:value=>rpc('prepare_project_retirement_page',{value}),qualifyProjectRetirement:value=>rpc('qualify_project_retirement',{value}),
    prepareStorageRunOutputBatch:limit=>rpc('prepare_storage_run_output_batch',{limit})});
  let closed=false;
  const close=async()=>{if(closed)return;closed=true;await worker.terminate();store.close();};
  t.after(close);
  const cold=()=>store.maintainStorageColdQuantum(64);
  return {store,cold,root,close};
}

test('cold lifecycle recovery settles interrupted audit history in bounded pieces, preserves counters and leaves live maintenance alone',async t=>{
  const f=await fixture(t),{store,cold}=f;
  store.db.run('BEGIN');
  for(let i=0;i<270;i++)store.db.run("INSERT INTO database_storage_maintenance VALUES(?,?,NULL,'running','',3,4,5,600,0,700,700,'not_checked')",[`interrupted-${i}`,i]);
  store.db.run('COMMIT');
  const live=store.beginDatabaseStorageMaintenance(1000,800,true);
  const counts=()=>Number(store.rows("SELECT COUNT(*) AS n FROM database_storage_maintenance WHERE error='maintenance_interrupted'")[0].n);
  await cold();assert.equal(counts(),128,'one maintenance piece must recover work without draining the full history');
  await cold();assert.equal(counts(),256);
  await cold();assert.equal(counts(),270);
  const row=store.rows('SELECT * FROM database_storage_maintenance WHERE id=?',['interrupted-0'])[0];
  assert.equal(row.status,'failed');assert.ok(row.finished_at>0);assert.ok(row.after_bytes>0);
  assert.deepEqual([row.deleted_artifacts,row.deleted_sources,row.deleted_contents,row.reclaimed_stored_bytes,row.before_bytes,row.integrity],[3,4,5,600,700,'not_checked']);
  assert.equal(store.rows('SELECT status FROM database_storage_maintenance WHERE id=?',[live])[0].status,'running');
  for(let i=0;i<20;i++){const batch=store.prepareStorageColdBatch(64);store.commitStorageColdBatch(batch);if(!batch.pending)break;}
  const changes=Number(store.rows('SELECT total_changes() AS n')[0].n);
  for(let i=0;i<3;i++)await cold();
  assert.equal(Number(store.rows('SELECT total_changes() AS n')[0].n),changes,'finished recovery must not rewrite settled history while idle');
});

test('a failed audit recovery transaction is retried and a restarted Writer still settles its fixed startup history',async t=>{
  const f=await fixture(t),{store,cold}=f;
  const interrupted=store.beginDatabaseStorageMaintenance(1,123);
  store.db.run("CREATE TEMP TRIGGER reject_audit_recovery BEFORE UPDATE OF status ON database_storage_maintenance WHEN NEW.error='maintenance_interrupted' BEGIN SELECT RAISE(ABORT,'recovery_io_failure'); END");
  await assert.rejects(cold(),/recovery_io_failure/);
  assert.equal(store.rows('SELECT status FROM database_storage_maintenance WHERE id=?',[interrupted])[0].status,'running');
  store.db.run('DROP TRIGGER reject_audit_recovery');
  await cold();
  assert.equal(store.rows('SELECT status FROM database_storage_maintenance WHERE id=?',[interrupted])[0].status,'failed');
  const late=store.beginDatabaseStorageMaintenance(2,456,true);
  await cold();
  assert.equal(store.rows('SELECT status FROM database_storage_maintenance WHERE id=?',[late])[0].status,'running');
  await f.close();
  const restarted=await fixture(t,f.root);
  await restarted.cold();
  assert.equal(restarted.store.rows('SELECT status FROM database_storage_maintenance WHERE id=?',[late])[0].status,'failed');
});

test('a new live audit whose settlement fails is recovered by the same Writer after the startup audit cursor is complete',async t=>{
  const {store,cold}=await fixture(t);
  await cold();
  const id=store.beginDatabaseStorageMaintenance(10,123,true);
  store.db.run("CREATE TEMP TRIGGER reject_late_audit_settlement BEFORE UPDATE OF status ON database_storage_maintenance BEGIN SELECT RAISE(ABORT,'late_audit_io_failure'); END");
  assert.throws(()=>store.settleDatabaseStorageMaintenance(id,{status:'completed',finishedAt:20,deletedArtifacts:0,deletedSources:0,deletedContents:0,reclaimedStoredBytes:0,compacted:false,afterBytes:123,integrity:'not_checked'}),/late_audit_io_failure/);
  store.releaseDatabaseStorageMaintenance(id);
  store.db.run('DROP TRIGGER temp.reject_late_audit_settlement');
  await cold();
  const row=store.rows('SELECT status,error FROM database_storage_maintenance WHERE id=?',[id])[0];
  assert.equal(row.status,'failed');assert.equal(row.error,'maintenance_interrupted');
});

test('a maintenance business error survives a simultaneous audit settlement failure and its released audit is recoverable',async t=>{
  const {store,cold}=await fixture(t);
  await cold();
  const original=store.maintenanceCompute.prepareStorageRunOutputBatch;
  store.maintenanceCompute.prepareStorageRunOutputBatch=async()=>{throw Error('original_maintenance_failure');};
  const operations=require('../out/runtimeDataOperations.js').createRuntimeDataOperations(store);
  t.after(()=>operations.close());
  store.db.run("CREATE TEMP TRIGGER reject_failed_audit_settlement BEFORE UPDATE OF status ON database_storage_maintenance BEGIN SELECT RAISE(ABORT,'audit_settlement_io_failure'); END");
  await assert.rejects(operations({operation:'maintain_database_storage',input:{compact:false}}),/original_maintenance_failure/);
  assert.equal(store.liveStorageMaintenanceIds.size,0);
  store.db.run('DROP TRIGGER temp.reject_failed_audit_settlement');
  store.maintenanceCompute.prepareStorageRunOutputBatch=original;
  await cold();
  const row=store.rows('SELECT status FROM database_storage_maintenance ORDER BY started_at DESC LIMIT 1')[0];
  assert.equal(row.status,'failed');
  assert.equal(store.rows('SELECT error FROM database_storage_maintenance ORDER BY started_at DESC LIMIT 1')[0].error,'Error: original_maintenance_failure');
});

test('released audit retries share the 128 metadata budget and keep their responsibility when a recovery transaction rolls back',async t=>{
  const {store,cold}=await fixture(t);await cold();const ids=[];
  for(let index=0;index<260;index++){
    const id=store.beginDatabaseStorageMaintenance(index,123,true);ids.push(id);store.releaseDatabaseStorageMaintenance(id);
  }
  store.db.run(`CREATE TEMP TRIGGER reject_retry_audit_recovery BEFORE UPDATE OF status ON database_storage_maintenance
    WHEN OLD.id='${ids[1]}' BEGIN SELECT RAISE(ABORT,'retry_audit_transaction_fault'); END`);
  await assert.rejects(cold(),/retry_audit_transaction_fault/);
  assert.equal(store.rows("SELECT COUNT(*) AS n FROM database_storage_maintenance WHERE status='running'")[0].n,260);
  store.db.run('DROP TRIGGER temp.reject_retry_audit_recovery');
  for(const remaining of [132,4,0]){await cold();assert.equal(store.rows("SELECT COUNT(*) AS n FROM database_storage_maintenance WHERE status='running'")[0].n,remaining);}
  assert.equal(store.unsettledStorageMaintenance.size,0);
});

test('a failed per-piece audit counter update rolls back its physical metadata deletion',async t=>{
  const {store,root}=await fixture(t),projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);
  const project=await store.registerProject({root:projectRoot}),bytes=Buffer.from('the audit and deletion must commit together');
  store.writeHistoricalRunArtifact(project.projectId,{executionLogId:1,relativePath:'step/1/cache/retired.bin',bytes,hash:require('node:crypto').createHash('sha256').update(bytes).digest('hex')},'output');
  store.db.run("UPDATE project_run_artifacts SET artifact_kind='byproduct'");
  const operations=require('../out/runtimeDataOperations.js').createRuntimeDataOperations(store);t.after(()=>operations.close());
  store.db.run(`CREATE TEMP TRIGGER reject_audit_progress BEFORE UPDATE OF deleted_artifacts ON database_storage_maintenance
    WHEN NEW.deleted_artifacts>OLD.deleted_artifacts BEGIN SELECT RAISE(ABORT,'audit_progress_transaction_fault'); END`);
  await assert.rejects(operations({operation:'maintain_database_storage',input:{compact:false}}),/audit_progress_transaction_fault/);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM project_run_artifacts')[0].n,1,'failed audit progress must roll back the deletion from the same transaction');
  assert.equal(store.rows('SELECT deleted_artifacts FROM database_storage_maintenance')[0].deleted_artifacts,0);
});
