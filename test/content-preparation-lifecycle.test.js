const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore, prepareContentForStorage } = require('../out/db/unifiedDataStore.js');
const {attachLazyContentCompute}=require('./content-compute-fixture.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-prepared-lifecycle-'));
  const store = new UnifiedDataStore(root);
  const closeCompute=attachLazyContentCompute(store);
  const close=store.close.bind(store);let open=true;
  store.close=()=>{if(open){close();open=false;}};
  t.after(async () => {
    await closeCompute();
    store.close();
    const directories = [root], files = [];
    for (let i = 0; i < directories.length; i++) for (const name of fs.readdirSync(directories[i])) {
      const file = path.join(directories[i], name); if (fs.lstatSync(file).isDirectory()) directories.push(file); else files.push(file);
    }
    for (const file of files) fs.unlinkSync(file); for (const directory of directories.reverse()) fs.rmdirSync(directory);
  });
  assert.equal(typeof store.withPreparedContentOwnership, 'function', 'preparation must have a durable per-call owner');
  return store;
}
test('dedup hits have independent pins until each preparation owner finishes', async t => {
  const store = fixture(t), bytes = Buffer.from('完整准备内容🌿'.repeat(120));
  const prepared = prepareContentForStorage(bytes, 'text/plain', 'utf8');
  let id;
  await store.withPreparedContentOwnership(async () => {
    id = await store.putPreparedContent(prepared, 'first');
    assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins WHERE content_id=?', [id])[0].n, 1);
    await store.withPreparedContentOwnership(async () => {
      assert.equal(await store.putPreparedContent(prepared, 'second'), id);
      assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins WHERE content_id=?', [id])[0].n, 2);
      store.queueStorageCleanupContents([id]); store.prepareDatabaseStorageCleanup();
      assert.equal(store.hasDatabaseStorageCleanupCandidates(), false);
    });
    assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins WHERE content_id=?', [id])[0].n, 1);
  });
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n, 0);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n, 0);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_release_holds WHERE content_id=?', [id])[0].n, 0,'the retired legacy purger no longer needs new bridge holds');
  assert.deepEqual(store.content(id), bytes);
});
test('simultaneous identical chunk preparation shares bytes and retains both owners', async t => {
  const store = fixture(t), bytes = Buffer.from('并发共享原文🌿'.repeat(100000));
  const prepared = prepareContentForStorage(bytes, 'application/octet-stream', 'binary');
  let ready; const bothReady = new Promise(resolve => { ready = resolve; });
  let release; const held = new Promise(resolve => { release = resolve; });
  const ids = [];
  const operations = ['a', 'b'].map(key => store.withPreparedContentOwnership(async () => {
    const id = await store.putPreparedContent(prepared, key); ids.push(id); if (ids.length === 2) ready();
    await held; return id;
  }));
  const completed = Promise.all(operations);
  try {
    await Promise.race([bothReady, completed.then(() => { throw new Error('owners finished before inspection'); })]); assert.equal(ids[0], ids[1]);
    assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins WHERE content_id=?', [ids[0]])[0].n, 2);
    assert.deepEqual(store.content(ids[0]), bytes);
  } finally { release(); await completed; }
});
test('failed ownership closes its pins without losing prepared bytes or becoming a permanent active owner', async t => {
  const store = fixture(t), bytes = Buffer.from('准备后失败仍保留🌿'.repeat(400));
  let id;
  await assert.rejects(store.withPreparedContentOwnership(async () => {
    id = await store.putPreparedContent(prepareContentForStorage(bytes, 'text/plain', 'utf8'), 'failure');
    throw new Error('consumer_failed');
  }), /consumer_failed/);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n, 0);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n, 0);
  assert.deepEqual(store.content(id), bytes);
});
test('only an authorized new Writer can recover owners from a previous incarnation', async t => {
  const store = fixture(t), id = store.putContent('先前未完成准备的原文');
  store.db.run('INSERT INTO content_lifecycle_prepare_owners(id,writer_incarnation) VALUES(?,?)', ['prior-call', 'prior-writer']);
  store.db.run('INSERT INTO content_lifecycle_prepare_pins VALUES(?,?)', ['prior-call', id]);
  const reader = UnifiedDataStore.openReadOnly(store.root); t.after(() => reader.close());
  assert.equal(reader.recoverContentPreparations().released, 0);
  assert.throws(() => reader.beginContentPreparationRecovery(), /preparation_recovery_writer_required/);
  assert.equal(store.recoverContentPreparations().released, 0);
  store.beginContentPreparationRecovery();
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n, 1, 'claiming authority must not scan or clean during startup');
  assert.equal(store.recoverContentPreparations().released, 1);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n, 0);
  assert.deepEqual(store.content(id), Buffer.from('先前未完成准备的原文'));
  assert.equal(store.recoverContentPreparations().released, 0);
});
test('an interrupted release preserves the user result and remains recoverable in the current Writer', async t => {
  const store = fixture(t), bytes = Buffer.from('准备完成但释放暂时失败🌿'.repeat(300));
  store.db.run("CREATE TRIGGER lifecycle_release_fault BEFORE DELETE ON content_lifecycle_prepare_pins BEGIN SELECT RAISE(ABORT,'fixture_release_interrupted'); END");
  const id = await store.withPreparedContentOwnership(async () => store.putPreparedContent(prepareContentForStorage(bytes, 'text/plain', 'utf8'), 'release-fault'));
  assert.deepEqual(store.content(id), bytes);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n, 1);
  store.db.run('DROP TRIGGER lifecycle_release_fault');
  assert.equal(store.recoverContentPreparations().released, 1);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n, 0);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n, 0);
});
test('one canceled owner cannot fail another owner during late canonical deduplication', async t => {
  const store = fixture(t), bytes = Buffer.from('取消一方仍完成另一方🌿'.repeat(100000));
  const prepared = prepareContentForStorage(bytes, 'application/octet-stream', 'binary');
  let cancel; const cancellation = new Promise((_, reject) => { cancel = reject; });
  const first = store.withPreparedContentOwnership(async () => Promise.race([store.putPreparedContent(prepared, 'cancel-a'), cancellation]));
  const second = store.withPreparedContentOwnership(async () => store.putPreparedContent(prepared, 'keep-b'));
  const firstRejected = assert.rejects(first, /owner_a_cancelled/);
  cancel(new Error('owner_a_cancelled')); await firstRejected;
  const canonicalId = store.putContent(bytes, 'application/octet-stream', 'binary');
  const id = await second;
  assert.equal(id, canonicalId); assert.deepEqual(store.content(id), bytes);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n, 0);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n, 0);
});
test('when every owner cancels a shared preparation cannot publish a new unowned result', async t => {
  const store = fixture(t), bytes = Buffer.from('全部取消🌿'.repeat(200000));
  const prepared = prepareContentForStorage(bytes, 'application/octet-stream', 'binary');
  let building, cancel; const cancellation = new Promise((_, reject) => { cancel = reject; });
  const operation = store.withPreparedContentOwnership(async () => {
    building = store.putPreparedContent(prepared, 'all-cancelled'); return Promise.race([building, cancellation]);
  });
  const rejected = assert.rejects(operation, /all_owners_cancelled/);
  cancel(new Error('all_owners_cancelled')); await rejected;
  await assert.rejects(building, /prepared_content_owner_finished/);
  assert.equal(store.rows("SELECT COUNT(*) AS n FROM contents WHERE sha256=? AND encoding IN ('binary','gzip:binary','chunked:binary')", [prepared.sha256])[0].n, 0);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n, 0);
});
async function attachRealMaintenance(store, t, failRetirementSyncOnce = false) {
  const { Worker } = require('node:worker_threads'), { once } = require('node:events');
  const entry = path.resolve(__dirname, '../out/maintenanceComputeWorker.js');
  const code = `const fs=require('node:fs'),path=require('node:path'),{workerData}=require('node:worker_threads');const paths=new Map(),open=fs.openSync,sync=fs.fsyncSync,remove=fs.rmdirSync;let removed=false,failed=false;fs.openSync=function(file,...args){const fd=open.call(fs,file,...args);paths.set(fd,String(file));return fd};fs.rmdirSync=function(file,...args){const result=remove.call(fs,file,...args);if(/^project-export-[a-f0-9-]{36}$/.test(path.basename(String(file))))removed=true;return result};fs.fsyncSync=function(fd){if(removed&&!failed&&paths.get(fd)===path.join(workerData.root,'.solomap-maintenance-staging')){failed=true;fs.closeSync(fd)}return sync.call(fs,fd)};require(${JSON.stringify(entry)});`;
  const worker = new Worker(failRetirementSyncOnce ? code : entry, { ...(failRetirementSyncOnce ? { eval: true } : {}), workerData: { root: store.root, databaseId: store.databaseId } });
  t.after(() => worker.terminate()); await once(worker, 'message'); let sequence = 0;
  const rpc = async (operation, input) => {
    const response = once(worker, 'message'); worker.postMessage({ id: ++sequence, operation, ...input });
    const [message] = await response; if (message.error) throw Object.assign(new Error(message.error), message.errorCode ? { code: message.errorCode } : {}); return message.result;
  };
  store.setMaintenanceCompute({
    verifyContentForPublication: value => rpc('verify_content_publication',{value}),
    prepareContentPublication: input => rpc('prepare_content_publication', { input }),
    prepareRunLog: value => rpc('prepare_run_log', { value }),
    prepareStorageColdBatch: limit => rpc('prepare_storage_cold_batch', { limit }),
    cleanupProjectExportStage: (stageDirectory, limit) => rpc('cleanup_project_export_stage', { stageDirectory, limit }),
    stageProjectExport: (root, ownerId) => rpc('stage_project_export', { root, ownerId }),
    digestFile: file => rpc('digest_file', { file })
  });
}
test('the artifact producer prepares raw bytes and large summaries on the real Maintenance Worker before binding', async t => {
  const store=fixture(t);await attachRealMaintenance(store,t);
  const project=store.write({kind:'project',action:'create',scope:null,idempotencyKey:'prepared-artifact-project',data:{name:'artifact producer'}}).objectId;
  const target=store.putContent('actual retained artifact target');
  for(let i=0;i<2000;i++){const plan=store.prepareStorageReferenceBatch(128);store.commitStorageReferenceBatch(plan);if(!plan.pending)break;}
  store.beginContentPreparationRecovery();store.activateStorageContentLifecycle({strictPublication:true});
  const value={sourceContents:Object.fromEntries([target,...Array.from({length:300},(_,i)=>`raw-target-${i}`)].map((id,i)=>[i,id])),raw:'原始载荷🌿'.repeat(20000)};
  const bytes=Buffer.from(JSON.stringify(value)),hash=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const input={executionLogId:1,relativePath:'step/1/output.log',bytes:bytes.toString('base64'),hash,mimeType:'application/octet-stream'};
  const original=store.putContent;store.putContent=()=>{throw Error('raw bytes must not use the synchronous Writer encoder');};
  try{await store.publishRunArtifact(project,input);}finally{store.putContent=original;}
  const artifact=store.rows('SELECT content_id FROM project_run_artifacts WHERE project_id=?',[project])[0];
  assert.deepEqual(store.content(artifact.content_id),bytes);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_edges WHERE source_id=?',[artifact.content_id])[0].n,301);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_gc_debt').length,0);
  for(let i=0;i<20;i++)if(!store.recoverContentPreparations(128).pending)break;
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_prepare_owners').length,0);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_prepare_pins').length,0);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_reference_unpublished').length,0);
  await assert.rejects(store.publishRunArtifact(project,{...input,hash:'0'.repeat(64)}),/run_artifact_hash_mismatch/);
  assert.deepEqual(store.readRunArtifactBytes(project,1,input.relativePath).bytes,bytes);
});
test('captured learning bytes keep their native JSON version and exact replay through prepared publication', async t => {
  const store=fixture(t);await attachRealMaintenance(store,t);
  for(let i=0;i<2000;i++){const plan=store.prepareStorageReferenceBatch(128);store.commitStorageReferenceBatch(plan);if(!plan.pending)break;}
  store.beginContentPreparationRecovery();store.activateStorageContentLifecycle({strictPublication:true});
  const value={sourceContents:Object.fromEntries(Array.from({length:301},(_,i)=>[i,`raw-${i}`])),text:'精确保留迁移原始字节🌿'.repeat(12000)};
  const bytes=Buffer.from('\uFEFF'+JSON.stringify(value,null,2)),hash=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const source={identity:'learning:prepared-capture',key:'candidates/original.json',hash};
  const legacy=store.recordMigrationJsonVersion;store.recordMigrationJsonVersion=()=>{throw Error('original JSON must be parsed in Maintenance Compute');};
  let receipt;
  try{receipt=await store.publishMigrationSource(source,bytes,{mimeType:'application/json',encoding:'utf8'});}finally{store.recordMigrationJsonVersion=legacy;}
  assert.equal(receipt.unchanged,false);
  assert.deepEqual(store.readMigrationSource(source.identity,source.key).bytes,bytes);
  const jsonHash=require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.deepEqual(store.readMigrationSourceJsonVersion(source.identity,source.key,jsonHash),{bytes,hash,sourceRevision:1});
  const requests=store.rows('SELECT COUNT(*) AS n FROM requests')[0].n,contents=store.rows('SELECT COUNT(*) AS n FROM contents')[0].n;
  assert.deepEqual(await store.publishMigrationSource(source,bytes,{mimeType:'application/json',encoding:'utf8'}),{...receipt,unchanged:true});
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM requests')[0].n,requests);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM contents')[0].n,contents);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_gc_debt').length,0);
});
for(const producer of ['log','document']) test(`prepared run ${producer} publication preserves exact retries and historical bytes`, async t => {
  const store=fixture(t),projectRoot=path.join(store.root,'run-project');fs.mkdirSync(projectRoot);
  const project=await store.registerProject({root:projectRoot});
  const run=await store.prepareRun(project.projectId,project.locationId,{root:projectRoot,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'original input',command:'fixture',userMessage:'original request',idempotencyKey:'prepared-run'});
  const original=Buffer.from('old accepted bytes'),initial=producer==='log'
    ?{executionLogId:1,generation:run.generation,stream:'stdout',sequence:0,offset:0,bytes:original.toString('base64'),idempotencyKey:'legacy-log'}
    :{executionLogId:1,generation:run.generation,purpose:'source',bytes:original.toString('base64'),mimeType:'application/json',expectedRevision:0,idempotencyKey:'legacy-document'};
  const accepted=producer==='log'?require('./fixtures/native-run-log-oracles.cjs').appendRunLogNative(store,project.projectId,initial):store.writeRunDocumentContent(project.projectId,initial);
  for(let i=0;i<2000;i++){const plan=store.prepareStorageReferenceBatch(128);store.commitStorageReferenceBatch(plan);if(!plan.pending)break;}
  store.beginContentPreparationRecovery();store.activateStorageContentLifecycle({strictPublication:true});await attachRealMaintenance(store,t);
  const publish=input=>producer==='log'?store.publishRunLog(project.projectId,input):store.publishRunDocument(project.projectId,input);
  assert.deepEqual(await publish(initial),accepted);
  const bytes=Buffer.from(JSON.stringify({raw:'原文🌿'.repeat(20000),sourceContents:Object.fromEntries(Array.from({length:301},(_,i)=>[i,`source-${i}`]))}));
  const next={...initial,bytes:bytes.toString('base64'),idempotencyKey:'prepared-next',...(producer==='log'?{sequence:1,offset:original.length}:{expectedRevision:1})};
  const receipt=await publish(next);
  assert.deepEqual(await publish(next),receipt);
  if(producer==='log')assert.deepEqual(Buffer.from(store.readRunLog(project.projectId,{executionLogId:1,stream:'output',limit:1048576}).bytes,'base64'),Buffer.concat([original,bytes]));
  else{
    assert.deepEqual(Buffer.from(store.readRunDocument(project.projectId,1,'source',1).bytes,'base64'),original);
    assert.deepEqual(Buffer.from(store.readRunDocument(project.projectId,1,'source').bytes,'base64'),bytes);
  }
  const content=store.rows('SELECT id FROM contents WHERE sha256=?',[require('node:crypto').createHash('sha256').update(bytes).digest('hex')])[0];
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_edges WHERE source_id=?',[content.id])[0].n,301);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_gc_debt').length,0);
});
for(const producer of ['log','document']) test(`a replaced run rejects a ${producer} prepared by its previous generation`, async t => {
  const store=fixture(t),root=path.join(store.root,'run-project');fs.mkdirSync(root);
  const project=await store.registerProject({root}),run=await store.prepareRun(project.projectId,project.locationId,{root,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'original',command:'fixture',userMessage:'original',idempotencyKey:'source-run'});
  for(let i=0;i<2000;i++){const plan=store.prepareStorageReferenceBatch(128);store.commitStorageReferenceBatch(plan);if(!plan.pending)break;}
  store.beginContentPreparationRecovery();store.activateStorageContentLifecycle({strictPublication:true});await attachRealMaintenance(store,t);
  const replace=()=>store.db.run('UPDATE run_control SET generation=generation+1 WHERE run_id=?',[run.runId]);
  if(producer==='log'){
    const compute=store.maintenanceCompute;
    store.setMaintenanceCompute({...compute,prepareRunLog:async input=>{const prepared=await compute.prepareRunLog(input);replace();return prepared;}});
  }else{
    const compute=store.runDocumentCompute;
    store.setRunDocumentCompute({...compute,prepare:async input=>{const prepared=await compute.prepare(input);replace();return prepared;}});
  }
  const common={executionLogId:1,generation:run.generation,bytes:Buffer.from('late original bytes').toString('base64'),idempotencyKey:'late-source'};
  await assert.rejects(producer==='log'?store.publishRunLog(project.projectId,{...common,stream:'stdout',sequence:0,offset:0})
    :store.publishRunDocument(project.projectId,{...common,purpose:'source',mimeType:'text/plain',expectedRevision:0}),/run_owner_conflict/);
  assert.equal(store.rows("SELECT 1 FROM requests WHERE idempotency_key='late-source'").length,0);
  assert.equal(store.rows('SELECT 1 FROM log_chunks WHERE run_id=?',[run.runId]).length,0);
  assert.equal(store.rows('SELECT 1 FROM run_documents WHERE run_id=? AND purpose=?',[run.runId,'source']).length,0);
});
test('a retired byproduct source can reappear without reusing its immutable capture receipt', async t => {
  const store=fixture(t);await attachRealMaintenance(store,t);
  store.beginContentPreparationRecovery();store.activateStorageContentLifecycle();
  const query=store.rows.bind(store),recoveryPlans=[];
  store.rows=(sql,values)=>{
    if(sql.startsWith('SELECT COALESCE(MAX(CAST(substr('))recoveryPlans.push(query('EXPLAIN QUERY PLAN '+sql,values));
    return query(sql,values);
  };
  const identity='agent-runs:/历史🌿',key='__solo__/44/evidence/release.vsix';
  const capture=async text=>{const bytes=Buffer.from(text);return store.publishMigrationSource({identity,key,hash:require('node:crypto').createHash('sha256').update(bytes).digest('hex')},bytes,{mimeType:'application/octet-stream',encoding:'binary'});};
  const first=await capture('first full version'),second=await capture('second full version');
  assert.equal(store.readMigrationSource(identity,key).sourceRevision,2);
  assert.equal(store.cleanupDatabaseStorageBatch(128,undefined,false).deletedSources,1);
  assert.equal(store.migrationSourceState(identity,key),null);
  const third=await capture('third full version');
  assert.equal(store.readMigrationSource(identity,key).sourceRevision,3);
  assert.equal(store.readMigrationSource(identity,key).bytes.toString(),'third full version');
  assert.equal((await capture('third full version')).requestId,third.requestId);
  for(const receipt of [first,second])assert.equal(store.rows('SELECT 1 FROM requests WHERE id=?',[receipt.requestId]).length,1);
  assert.equal(store.cleanupDatabaseStorageBatch(128,undefined,false).deletedSources,1);
  await capture('fourth full version');assert.equal(store.readMigrationSource(identity,key).sourceRevision,4);
  assert.ok(recoveryPlans.length>=1);
  for(const plan of recoveryPlans){
    assert.ok(plan.some(row=>/SEARCH requests USING (?:COVERING )?INDEX.*actor_id=.*idempotency_key/.test(row.detail)),JSON.stringify(plan));
    assert.ok(plan.some(row=>/SEARCH events USING.*sequence=/.test(row.detail)),JSON.stringify(plan));
    assert.equal(plan.some(row=>/SCAN (?:requests|events)/.test(row.detail)),false,JSON.stringify(plan));
  }
});
for(const legacy of [false,true]) test(`capture revisions survive source retirement across actor changes (${legacy?'legacy head missing':'retained head'})`, async t => {
  const store=fixture(t);await attachRealMaintenance(store,t);
  const originalActor=store.actorId,otherActor='capture-other-actor';
  store.db.run('INSERT INTO actors(id,kind,provider,identity_ref) VALUES(?,?,?,NULL)',[otherActor,'host','other capture owner']);
  const identity='agent-runs:/多角色🌿',key='__solo__/44/evidence/release.vsix';
  const capture=(actor,text)=>store.withActor(actor,async()=>{const bytes=Buffer.from(text);return store.publishMigrationSource({identity,key,hash:require('node:crypto').createHash('sha256').update(bytes).digest('hex')},bytes);});
  await capture(originalActor,'first');await capture(originalActor,'second');
  assert.equal(store.cleanupDatabaseStorageBatch(128,undefined,false).deletedSources,1);
  if(legacy)store.db.run('DELETE FROM content_lifecycle_capture_heads WHERE source_identity=? AND source_key=?',[identity,key]);
  await capture(otherActor,'third');
  assert.equal(store.readMigrationSource(identity,key).sourceRevision,3);
  await capture(originalActor,'fourth');
  assert.equal(store.readMigrationSource(identity,key).sourceRevision,4);
  assert.equal(store.readMigrationSource(identity,key).bytes.toString(),'fourth');
});
test('capture head recovery ignores another actor using the private-looking key for an ordinary mutation', async t => {
  const store=fixture(t);await attachRealMaintenance(store,t);
  const originalActor=store.actorId,other='capture-spoof-actor',identity='agent-runs:/scoped',key='__solo__/1/evidence/blob.bin';
  store.db.run('INSERT INTO actors(id,kind,provider,identity_ref) VALUES(?,?,?,NULL)',[other,'mcp','fixture']);
  const prefix=`migration-capture:${require('../out/contentReferences.js').canonicalJson([identity,key])}:`;
  store.withActor(other,()=>store.write({kind:'memory',action:'create',scope:null,idempotencyKey:prefix+'9000',data:{category:'inbox',title:'ordinary user data',status:'captured',content:'not a capture'}}));
  const bytes=Buffer.from('actual source');
  await store.withActor(originalActor,()=>store.publishMigrationSource({identity,key,hash:require('node:crypto').createHash('sha256').update(bytes).digest('hex')},bytes));
  assert.equal(store.readMigrationSource(identity,key).sourceRevision,1);
});
for(const chunked of [false,true]) test(`prepared publication repairs the original referenced identity (${chunked?'chunks':'inline'})`, async t => {
  const store=fixture(t);await attachRealMaintenance(store,t);
  const project=store.write({kind:'project',action:'create',scope:null,idempotencyKey:'repair-project',data:{name:'repair'}}).objectId;
  const bytes=chunked?require('node:crypto').randomBytes(2*1024*1024):Buffer.from('full original bytes '.repeat(100));
  const input={executionLogId:1,relativePath:'node/1/output.log',bytes:bytes.toString('base64'),hash:require('node:crypto').createHash('sha256').update(bytes).digest('hex')};
  await store.publishRunArtifact(project,input);
  const id=store.rows('SELECT content_id FROM project_run_artifacts WHERE project_id=?',[project])[0].content_id;
  if(chunked)store.db.run('UPDATE content_chunks SET data=zeroblob(length(data)) WHERE content_id=? AND ordinal=0',[id]);
  else store.db.run('UPDATE contents SET data=zeroblob(stored_byte_length) WHERE id=?',[id]);
  assert.throws(()=>store.content(id),/content_integrity_error/);
  await store.publishRunArtifact(project,input);
  assert.equal(store.rows('SELECT content_id FROM project_run_artifacts WHERE project_id=?',[project])[0].content_id,id);
  assert.deepEqual(store.content(id),bytes);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_faults WHERE content_id=?',[id]).length,0);
});
test('content reads honor legacy absolute ordinals without adding a wrapper offset twice', async t => {
  const store=fixture(t),bytes=require('node:crypto').randomBytes(2*1024*1024);
  const id=store.putContent(bytes,'application/octet-stream','binary');
  store.db.run('UPDATE content_chunks SET data=zeroblob(length(data)) WHERE content_id=? AND ordinal=0',[id]);
  await store.withPreparedContentOwnership(()=>store.putPreparedContent(prepareContentForStorage(bytes,'application/octet-stream','binary'),'ordinal-compatibility',id));
  const wrapper=JSON.parse(store.rows('SELECT chunk_index_json FROM contents WHERE id=?',[id])[0].chunk_index_json);
  const legacy=wrapper.chunks.map((part,ordinal)=>({...part,ordinal:wrapper.firstOrdinal+ordinal}));
  for(const index of [legacy,{firstOrdinal:9999,chunks:legacy}]){
    store.db.run('UPDATE contents SET chunk_index_json=? WHERE id=?',[JSON.stringify(index),id]);
    assert.deepEqual(store.content(id),bytes);
    assert.deepEqual(store.contentRange(id,store.rows('SELECT * FROM contents WHERE id=?',[id])[0],65530,65560),bytes.subarray(65530,65560));
  }
});
test('repair restores an empty referenced body with damaged chunk metadata', async t => {
  const store=fixture(t),bytes=Buffer.alloc(0),id=store.putContent(bytes,'application/octet-stream','binary');
  store.db.run('UPDATE contents SET encoding=?,chunk_index_json=? WHERE id=?',['chunked:binary','[{}]',id]);
  assert.throws(()=>store.content(id),/content_integrity_error/);
  await store.withPreparedContentOwnership(async()=>assert.equal(await store.putPreparedContent(prepareContentForStorage(bytes,'application/octet-stream','binary'),'empty-repair',id),id));
  assert.deepEqual(store.content(id),bytes);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_repairs').length,0);
});
test('interrupted shadow repair preserves every old chunk and recovery discards only replacements', async t => {
  const store=fixture(t);await attachRealMaintenance(store,t);
  const bytes=require('node:crypto').randomBytes(2*1024*1024);
  const id=store.putContent(bytes,'application/octet-stream','binary');
  store.db.run('UPDATE content_chunks SET data=zeroblob(length(data)) WHERE content_id=? AND ordinal=0',[id]);
  const header=store.rows('SELECT * FROM contents WHERE id=?',[id])[0];
  const old=store.rows('SELECT ordinal,data FROM content_chunks WHERE content_id=? ORDER BY ordinal',[id]);
  let failed;
  await assert.rejects(store.withPreparedContentOwnership(async()=>{
    failed=store.putPreparedContent(prepareContentForStorage(bytes,'application/octet-stream','binary'),'interrupted-repair').then(()=>null,error=>error);
    while(!store.rows('SELECT 1 FROM content_lifecycle_repairs WHERE content_id=?',[id]).length) await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(store.rows('SELECT * FROM contents WHERE id=?',[id])[0],header);
    assert.deepEqual(store.rows('SELECT ordinal,data FROM content_chunks WHERE content_id=? AND ordinal<? ORDER BY ordinal',[id,old.length]),old);
    throw Error('interrupt_repair');
  }),/interrupt_repair/);
  assert.match((await failed).message,/prepared_content_owner_finished/);
  store.close();const resumed=new UnifiedDataStore(store.root),closeResumedCompute=attachLazyContentCompute(resumed);resumed.beginContentPreparationRecovery();
  try{
    for(let i=0;i<100;i++){const batch=resumed.prepareStorageRepairBatch();resumed.commitStorageRepairBatch(batch);if(!batch.pending)break;}
    assert.deepEqual(resumed.rows('SELECT * FROM contents WHERE id=?',[id])[0],header);
    assert.deepEqual(resumed.rows('SELECT ordinal,data FROM content_chunks WHERE content_id=? ORDER BY ordinal',[id]),old);
    assert.equal(resumed.rows('SELECT 1 FROM content_lifecycle_repairs').length,0);
    await resumed.withPreparedContentOwnership(async()=>assert.equal(await resumed.putPreparedContent(prepareContentForStorage(bytes,'application/octet-stream','binary'),'retry'),id));
    assert.deepEqual(resumed.content(id),bytes);
  }finally{await closeResumedCompute();resumed.close();}
});
test('a committed shadow pointer recovers cleanup after restart without retransmitting bytes', async t => {
  const store=fixture(t),bytes=require('node:crypto').randomBytes(2*1024*1024);
  const id=store.putContent(bytes,'application/octet-stream','binary');
  store.db.run('UPDATE content_chunks SET data=zeroblob(length(data)) WHERE content_id=? AND ordinal=0',[id]);
  const transaction=store.transaction.bind(store);let interrupted=false;
  store.transaction=operation=>{
    const result=transaction(operation);
    if(!interrupted&&store.rows("SELECT 1 FROM content_lifecycle_repairs WHERE content_id=? AND phase='cleanup'",[id]).length){interrupted=true;throw Error('after_pointer_commit');}
    return result;
  };
  await assert.rejects(store.withPreparedContentOwnership(()=>store.putPreparedContent(prepareContentForStorage(bytes,'application/octet-stream','binary'),'pointer-interruption')),/after_pointer_commit/);
  store.transaction=transaction;assert.deepEqual(store.content(id),bytes);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_chunks WHERE content_id=?',[id])[0].n,64);
  store.close();const resumed=new UnifiedDataStore(store.root);resumed.beginContentPreparationRecovery();
  try{
    for(let i=0;i<100;i++){const batch=resumed.prepareStorageRepairBatch();resumed.commitStorageRepairBatch(batch);if(!batch.pending)break;}
    assert.deepEqual(resumed.content(id),bytes);
    assert.equal(resumed.rows('SELECT COUNT(*) AS n FROM content_chunks WHERE content_id=?',[id])[0].n,32);
    assert.equal(resumed.rows('SELECT 1 FROM content_lifecycle_repairs').length,0);
  }finally{resumed.close();}
});
test('a second interrupted repair preserves responsibility for prior obsolete chunks', async t => {
  const store=fixture(t),bytes=require('node:crypto').randomBytes(2*1024*1024);
  const prepared=prepareContentForStorage(bytes,'application/octet-stream','binary');
  const id=store.putContent(bytes,'application/octet-stream','binary');
  store.db.run('UPDATE content_chunks SET data=zeroblob(length(data)) WHERE content_id=? AND ordinal=0',[id]);
  const transaction=store.transaction.bind(store);let interrupted=false;
  store.transaction=operation=>{
    const result=transaction(operation);
    if(!interrupted&&store.rows("SELECT 1 FROM content_lifecycle_repairs WHERE content_id=? AND phase='cleanup'",[id]).length){interrupted=true;throw Error('after_first_pointer');}
    return result;
  };
  await assert.rejects(store.withPreparedContentOwnership(()=>store.putPreparedContent(prepared,'first-generation',id)),/after_first_pointer/);store.transaction=transaction;
  const active=JSON.parse(store.rows('SELECT chunk_index_json FROM contents WHERE id=?',[id])[0].chunk_index_json);
  store.db.run('UPDATE content_chunks SET data=zeroblob(length(data)) WHERE content_id=? AND ordinal=?',[id,active.firstOrdinal]);
  let failure;
  await assert.rejects(store.withPreparedContentOwnership(async()=>{
    failure=store.putPreparedContent(prepared,'second-generation',id).then(()=>null,error=>error);
    while(!store.rows("SELECT 1 FROM content_lifecycle_repairs WHERE content_id=? AND phase='building'",[id]).length)await new Promise(resolve=>setImmediate(resolve));
    throw Error('cancel_second_generation');
  }),/cancel_second_generation/);assert.match((await failure).message,/prepared_content_owner_finished/);
  store.beginContentPreparationRecovery();
  for(let i=0;i<100;i++){const batch=store.prepareStorageRepairBatch();store.commitStorageRepairBatch(batch);if(!batch.pending)break;}
  const physical=store.rows('SELECT ordinal FROM content_chunks WHERE content_id=? ORDER BY ordinal',[id]).map(row=>row.ordinal);
  assert.deepEqual(physical,active.chunks.map((part,ordinal)=>part.ordinal??active.firstOrdinal+ordinal));
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_repairs').length,0);
});
test('preferred and inferred identities share one concurrent repair', async t => {
  const store=fixture(t),bytes=require('node:crypto').randomBytes(2*1024*1024);
  const prepared=prepareContentForStorage(bytes,'application/octet-stream','binary');
  const id=store.putContent(bytes,'application/octet-stream','binary');
  store.db.run('UPDATE content_chunks SET data=zeroblob(length(data)) WHERE content_id=? AND ordinal=0',[id]);
  const results=await Promise.all([undefined,id].map(preferred=>store.withPreparedContentOwnership(()=>store.putPreparedContent(prepared,'same',preferred))));
  assert.deepEqual(results,[id,id]);assert.deepEqual(store.content(id),bytes);
  assert.equal(store.rows('SELECT 1 FROM content_lifecycle_repairs').length,0);
});
test('failed file staging is registered before I/O and retires in bounded Maintenance Worker batches', async t => {
  const store = fixture(t); await attachRealMaintenance(store, t); let stageDirectory, ownerId;
  await assert.rejects(store.withPreparedContentOwnership(async () => {
    const owner = store.rows('SELECT * FROM content_lifecycle_prepare_owners')[0];
    assert.equal(owner.stage_kind, 'project_export', 'the durable owner must precede file creation'); ownerId = owner.id;
    stageDirectory = path.join(store.root, '.solomap-maintenance-staging', `project-export-${ownerId}`);
    fs.mkdirSync(path.join(stageDirectory, 'chunks'), { recursive: true });
    fs.writeFileSync(path.join(stageDirectory, 'owner.json'), require('../out/projectExportStaging.js').projectExportStageOwnerBytes(store.databaseId, ownerId));
    fs.writeFileSync(path.join(stageDirectory, 'archive.stage'), 'incomplete owned archive');
    fs.writeFileSync(path.join(stageDirectory, 'chunks', 'manifest.json'), '{}');
    for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(stageDirectory, 'chunks', `${String(i).padStart(8, '0')}.chunk`), 'owned partial chunk');
    throw new Error('worker_stage_interrupted');
  }, { stageKind: 'project_export' }), /worker_stage_interrupted/);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners WHERE id=?', [ownerId])[0].n, 1);
  await store.maintainStorageColdQuantum(8);
  assert.ok(fs.existsSync(stageDirectory), 'one quantum must not remove all 202 files');
  assert.ok(fs.readdirSync(path.join(stageDirectory, 'chunks')).length >= 73);
  for (let i = 0; i < 20; i++) if (!(await store.maintainStorageColdQuantum(8)).pending) break;
  assert.equal(fs.existsSync(stageDirectory), false);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n, 0);
});
test('unknown stage files are preserved without starving unrelated maintenance or growing on retries', async t => {
  const store = fixture(t); await attachRealMaintenance(store, t); let stageDirectory;
  await assert.rejects(store.withPreparedContentOwnership(async () => {
    const owner = store.rows('SELECT * FROM content_lifecycle_prepare_owners')[0];
    assert.equal(owner.stage_kind, 'project_export');
    stageDirectory = path.join(store.root, '.solomap-maintenance-staging', `project-export-${owner.id}`);
    fs.mkdirSync(stageDirectory, { recursive: true });
    fs.writeFileSync(path.join(stageDirectory, 'owner.json'), require('../out/projectExportStaging.js').projectExportStageOwnerBytes(store.databaseId, owner.id));
    fs.writeFileSync(path.join(stageDirectory, 'archive.stage'), 'owned partial archive');
    fs.writeFileSync(path.join(stageDirectory, 'user-file.txt'), 'preserve user bytes'); throw new Error('interrupted');
  }, { stageKind: 'project_export' }), /interrupted/);
  for (let i = 0; i < 20; i++) if (!(await store.maintainStorageColdQuantum(8)).pending) break;
  assert.equal(fs.readFileSync(path.join(stageDirectory, 'user-file.txt'), 'utf8'), 'preserve user bytes');
  const before = store.rows('SELECT total_changes() AS n')[0].n;
  for (let i = 0; i < 5; i++) assert.equal((await store.maintainStorageColdQuantum(8)).pending, false);
  assert.equal(store.rows('SELECT total_changes() AS n')[0].n, before);
  fs.unlinkSync(path.join(stageDirectory, 'user-file.txt'));
  assert.equal(store.retryContentPreparationStages(), 1);
  for (let i = 0; i < 20; i++) if (!(await store.maintainStorageColdQuantum(8)).pending) break;
  assert.equal(fs.existsSync(stageDirectory), false);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n, 0);
});
test('a real small project export transfers ownership to its replay receipt and removes all stage files', async t => {
  const store = fixture(t), project = path.join(store.root, 'project');
  fs.mkdirSync(path.join(project, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(project, '.solopreneur', 'roadmap.csv'), 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,原始目标,保留完整说明,实施,,codex,执行,Pending,2026-01-01T00:00:00.000Z,');
  await store.acceptRoadmapCsv({ root: project }); await attachRealMaintenance(store, t);
  const destination = path.join(store.root, 'exports', 'project.json');
  const receipt = await store.exportProject({ root: project, destination, idempotencyKey: 'small-real-export' });
  assert.ok(receipt.bytes < 65536, 'exercise the inline prepared manifest, not only chunked archives');
  const bytes = fs.readFileSync(destination);
  assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'), receipt.sha256);
  const result = store.rows("SELECT * FROM requests WHERE idempotency_key='project-export:small-real-export'")[0];
  const stored = JSON.parse(store.requestResult(result).toString());
  assert.deepEqual(store.content(stored.archiveContentId), bytes);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n, 0);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n, 0);
  assert.equal(fs.readdirSync(path.join(store.root, '.solomap-maintenance-staging')).filter(name => name.startsWith('project-export-')).length, 0);
  assert.deepEqual(await store.exportProject({ root: project, destination, idempotencyKey: 'small-real-export' }), receipt);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n, 0);
});
test('cleanup failure and failure to record it cannot revoke an already delivered result', async t => {
  const store = fixture(t); await attachRealMaintenance(store, t); let ownerId, stageDirectory;
  store.db.run("CREATE TRIGGER stage_error_record_fault BEFORE UPDATE OF stage_error ON content_lifecycle_prepare_owners BEGIN SELECT RAISE(ABORT,'fixture_stage_error_record_failed'); END");
  const result = await store.withPreparedContentOwnership(async () => {
    ownerId = store.rows('SELECT id FROM content_lifecycle_prepare_owners')[0].id;
    stageDirectory = path.join(store.root, '.solomap-maintenance-staging', `project-export-${ownerId}`); fs.mkdirSync(stageDirectory, { recursive: true });
    fs.writeFileSync(path.join(stageDirectory, 'owner.json'), require('../out/projectExportStaging.js').projectExportStageOwnerBytes(store.databaseId, ownerId));
    fs.writeFileSync(path.join(stageDirectory, 'unknown.txt'), 'preserve unknown bytes');
    fs.writeFileSync(path.join(store.root, 'delivered-result.txt'), 'already delivered');
    await store.cleanupContentPreparationStage(ownerId); return 'already_delivered_result';
  }, { stageKind: 'project_export' });
  assert.equal(result, 'already_delivered_result'); assert.equal(fs.readFileSync(path.join(store.root, 'delivered-result.txt'), 'utf8'), 'already delivered');
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners WHERE id=?', [ownerId])[0].n, 1);
  store.db.run('DROP TRIGGER stage_error_record_fault'); fs.unlinkSync(path.join(stageDirectory, 'unknown.txt'));
  for (let i = 0; i < 20; i++) if (!(await store.maintainStorageColdQuantum(8)).pending) break;
  assert.equal(fs.existsSync(stageDirectory), false);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n, 0);
});
test('the real producer durably creates ownership and retires files before the owner is released', async t => {
  const store = fixture(t), project = path.join(store.root, 'project'); fs.mkdirSync(path.join(project, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(project, '.solopreneur', 'roadmap.csv'), 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,完整目标,原文,实施,,codex,执行,Pending,2026-01-01T00:00:00.000Z,');
  await store.acceptRoadmapCsv({ root: project });
  const { Worker } = require('node:worker_threads'), { once } = require('node:events');
  const entry = path.resolve(__dirname, '../out/maintenanceComputeWorker.js');
  // Observe actual native filesystem calls while preserving their real implementations.
  const code = `const fs=require('node:fs');const {parentPort}=require('node:worker_threads');const events=[],paths=new Map();const open=fs.openSync,sync=fs.fsyncSync,remove=fs.rmdirSync,send=parentPort.postMessage.bind(parentPort);fs.openSync=function(file,...args){const fd=open.call(fs,file,...args);paths.set(fd,String(file));events.push({kind:'open',file:String(file)});return fd};fs.fsyncSync=function(fd){const result=sync.call(fs,fd);events.push({kind:'sync',file:paths.get(fd)});return result};fs.rmdirSync=function(file,...args){const result=remove.call(fs,file,...args);events.push({kind:'remove-directory',file:String(file)});return result};parentPort.postMessage=message=>send(message.result?{...message,events}:message);require(${JSON.stringify(entry)});`;
  const worker = new Worker(code, { eval: true, workerData: { root: store.root, databaseId: store.databaseId } }); t.after(() => worker.terminate()); await once(worker, 'message');
  await store.withPreparedContentOwnership(async () => {
    const ownerId = store.rows('SELECT id FROM content_lifecycle_prepare_owners')[0].id;
    const response = once(worker, 'message'); worker.postMessage({ id: 1, operation: 'stage_project_export', root: project, ownerId });
    const [message] = await response; assert.equal(message.error, undefined);
    const directory = message.result.stageDirectory, events = message.events;
    const markerSynced = events.findIndex(event => event.kind === 'sync' && event.file === path.join(directory, 'owner.json'));
    const directorySynced = events.findIndex((event, index) => index > markerSynced && event.kind === 'sync' && event.file === directory);
    const payloadOpened = events.findIndex(event => event.kind === 'open' && event.file === path.join(directory, 'archive.stage'));
    assert.ok(markerSynced >= 0); assert.ok(directorySynced > markerSynced, 'marker directory entry must be durable');
    assert.ok(payloadOpened > directorySynced, 'payload must follow durable ownership');
    const cleanupResponse = once(worker, 'message'); worker.postMessage({ id: 2, operation: 'cleanup_project_export_stage', stageDirectory: directory, limit: 128 });
    const [cleanup] = await cleanupResponse; assert.equal(cleanup.error, undefined); assert.equal(cleanup.result.pending, false);
    const removed = cleanup.events.findIndex(event => event.kind === 'remove-directory' && event.file === directory);
    const retiredParentSynced = cleanup.events.findIndex((event, index) => index > removed && event.kind === 'sync' && event.file === path.dirname(directory));
    assert.ok(removed >= 0); assert.ok(retiredParentSynced > removed, 'retirement must be durable before the DB can release ownership');
    store.db.run('UPDATE content_lifecycle_prepare_owners SET stage_kind=NULL WHERE id=?', [ownerId]);
  }, { stageKind: 'project_export' });
});

test('a transient retirement sync failure retains ownership for retry instead of quarantining completed work', async t => {
  const store = fixture(t); await attachRealMaintenance(store, t, true); let ownerId, stageDirectory;
  const result = await store.withPreparedContentOwnership(async () => {
    ownerId = store.rows('SELECT id FROM content_lifecycle_prepare_owners')[0].id;
    stageDirectory = path.join(store.root, '.solomap-maintenance-staging', `project-export-${ownerId}`); fs.mkdirSync(stageDirectory, { recursive: true });
    fs.writeFileSync(path.join(stageDirectory, 'owner.json'), require('../out/projectExportStaging.js').projectExportStageOwnerBytes(store.databaseId, ownerId));
    fs.writeFileSync(path.join(stageDirectory, 'archive.stage'), 'owned staged bytes');
    await store.cleanupContentPreparationStage(ownerId); return 'already_delivered';
  }, { stageKind: 'project_export' });
  assert.equal(result, 'already_delivered'); assert.equal(fs.existsSync(stageDirectory), false);
  const owner = store.rows('SELECT * FROM content_lifecycle_prepare_owners WHERE id=?', [ownerId])[0];
  assert.ok(owner.stage_retry_at > Date.now(), 'a transient I/O error must schedule a retry');
  assert.match(owner.stage_error, /EBADF/);
  for (let i = 0; i < 10; i++) if (!(await store.maintainStorageColdQuantum(8)).pending) break;
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n, 1);
  assert.equal(store.retryContentPreparationStages(), 1);
  for (let i = 0; i < 10; i++) if (!(await store.maintainStorageColdQuantum(8)).pending) break;
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n, 0);
});
