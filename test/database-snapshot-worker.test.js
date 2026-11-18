const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-snapshot-worker-')),store=new UnifiedDataStore(root),clients=[];
  t.after(async()=>{for(const client of clients)await client.close();store.close();const directories=[root],files=[];for(let i=0;i<directories.length;i++)for(const name of fs.readdirSync(directories[i])){const entry=path.join(directories[i],name);if(fs.lstatSync(entry).isDirectory())directories.push(entry);else files.push(entry);}for(const file of files)fs.unlinkSync(file);for(const directory of directories.reverse())fs.rmdirSync(directory);});
  return{root,store,async start(){
    const {DatabaseSnapshotWorkerClient}=require('../out/databaseSnapshotWorkerClient.js'),candidateDir=path.join(root,'database-generations',crypto.randomUUID());
    fs.mkdirSync(path.dirname(candidateDir),{recursive:true});fs.mkdirSync(candidateDir,{mode:0o700});const stat=fs.statSync(candidateDir,{bigint:true});
    const client=await DatabaseSnapshotWorkerClient.start({root,databaseId:store.databaseId,writerIncarnation:store.readDatabaseSnapshotFence().writerIncarnation,candidateDir,generationDevice:String(stat.dev),generationInode:String(stat.ino)});clients.push(client);return{client,candidateDir};
  }};
}
test('a dedicated snapshot Worker preserves the exact baseline while it durably receives live Session changes',async t=>{
  const f=fixture(t),receipt=f.store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'before',data:{category:'inbox',title:'complete history',status:'captured',content:'original complete bytes'}});
  const {client,candidateDir}=await f.start(),fence=f.store.readDatabaseSnapshotFence(),binding=await client.pin(fence.token);
  assert.equal(client.isCurrent(binding),true);assert.equal(f.store.beginPinnedDatabaseGenerationCapture(binding,fence,client),true);
  f.store.write({kind:'memory',action:'patch',scope:null,objectId:receipt.objectId,expectedRevision:1,idempotencyKey:'after',data:{content:'later complete bytes'}});
  const delta=f.store.rotateDatabaseGenerationCapture(),sequence=f.store.readRuntimeWriterBarrier().committedSequence;
  const [baseline,persisted]=await Promise.all([client.copy(binding),client.persistChangeset({sequence:1,changeset:delta.changeset,searchObjectIds:delta.searchObjectIds,liveSequence:sequence})]);
  assert.equal(baseline.committedSequence,binding.committedSequence);assert.equal(baseline.destination,path.join(candidateDir,'solomap.db'));
  assert.deepEqual(fs.readFileSync(persisted.file),Buffer.from(delta.changeset));assert.equal(persisted.liveSequence,sequence);
  assert.equal(f.store.stopDatabaseGenerationCapture().changeset.length,0);
  const candidate=new UnifiedDataStore(candidateDir);
  try{
    assert.equal(candidate.read(receipt.objectId).data.content,'original complete bytes');
    candidate.applyDatabaseGenerationChangeset(fs.readFileSync(persisted.file),persisted.searchObjectIds,binding.committedSequence,persisted.liveSequence);
    assert.equal(candidate.read(receipt.objectId).data.content,'later complete bytes');assert.equal(candidate.read(receipt.objectId,1).data.content,'original complete bytes');
  }finally{candidate.close();}
  client.assertHealthy();assert.equal(client.isCurrent(binding),false);
});
test('superseded pin replies and a lost snapshot Worker cannot grant capture authority',async t=>{
  const f=fixture(t),{client}=await f.start(),fence=f.store.readDatabaseSnapshotFence();
  const first=client.pin(fence.token);const firstResult=first.then(value=>({value}),error=>({error}));const second=await client.pin(fence.token),old=await firstResult;
  assert.match(old.error.message,/database_snapshot_superseded/);assert.equal(client.isCurrent(second),true);
  await client.worker.terminate();assert.throws(()=>client.assertHealthy(),/database_snapshot_worker_exited/);
  assert.equal(f.store.beginPinnedDatabaseGenerationCapture(second,fence,client),false);
  const saved=f.store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'after-worker-loss',data:{category:'inbox',title:'foreground continues',status:'captured',content:'complete result'}});assert.equal(saved.status,'committed');
});
test('capture persistence never replaces an existing file in the generation',async t=>{
  const f=fixture(t),{client,candidateDir}=await f.start(),binding=await client.pin(f.store.readDatabaseSnapshotFence().token),file=path.join(candidateDir,'changesets','000000000001.changeset'),bytes=Buffer.from('existing owned fixture bytes');fs.writeFileSync(file,bytes);
  await assert.rejects(client.persistChangeset({sequence:1,changeset:Uint8Array.from([1,2,3]),searchObjectIds:[],liveSequence:0}),/EEXIST|file already exists/);
  assert.deepEqual(fs.readFileSync(file),bytes);
  assert.throws(()=>client.assertHealthy(),/EEXIST|file already exists/);assert.equal(client.isCurrent(binding),false);
});
test('a moved capture directory cannot acknowledge a file at a replacement path',async t=>{
  const f=fixture(t),{client,candidateDir}=await f.start(),directory=path.join(candidateDir,'changesets'),moved=path.join(candidateDir,'moved-own-changesets');
  fs.renameSync(directory,moved);fs.mkdirSync(directory);
  await assert.rejects(client.persistChangeset({sequence:1,changeset:Uint8Array.from([1,2,3]),searchObjectIds:[],liveSequence:0}),/database_snapshot_changeset_directory_changed/);
  assert.deepEqual(fs.readdirSync(directory),[]);assert.deepEqual(fs.readdirSync(moved),[]);
});
test('a generation admits only one capture persistence flight instead of buffering full frames',async t=>{
  const f=fixture(t),{client}=await f.start();
  const first=client.persistChangeset({sequence:1,changeset:new Uint8Array(8*1024*1024),searchObjectIds:[],liveSequence:0});
  const result=first.then(value=>({value}),error=>({error}));
  await assert.rejects(client.persistChangeset({sequence:2,changeset:new Uint8Array(8*1024*1024),searchObjectIds:[],liveSequence:0}),/database_snapshot_changeset_busy/);
  assert.equal((await result).error,undefined);
  assert.ok((await client.persistChangeset({sequence:2,changeset:Uint8Array.from([1,2,3]),searchObjectIds:[],liveSequence:0})).file.endsWith('000000000002.changeset'));
});
