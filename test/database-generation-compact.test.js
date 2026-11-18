const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DiskDatabase } = require('../out/db/diskDatabase.js');

function cleanupOwn(root) {
  if (!fs.existsSync(root)) return;
  for (const name of fs.readdirSync(root)) { const target=path.join(root,name); if(fs.lstatSync(target).isDirectory()) cleanupOwn(target); else fs.unlinkSync(target); }
  fs.rmdirSync(root);
}

test('generation capacity counts a full baseline, compact candidate, WAL allowance and running reserve before allocating files',t=>{
  const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-capacity-'));t.after(()=>cleanupOwn(root));
  const store=new UnifiedDataStore(root),statfs=fs.statfsSync;
  try{
    const before=store.rows('SELECT total_changes() AS n')[0].n;
    fs.statfsSync=()=>({bavail:0,bsize:4096});
    assert.throws(()=>store.assertDatabaseGenerationCapacity(true),/database_generation_insufficient_space/);
    assert.equal(store.rows('SELECT total_changes() AS n')[0].n,before);
    assert.equal(fs.existsSync(path.join(root,'database-generations')),false);
    fs.statfsSync=()=>({bavail:1024*1024,bsize:4096});
    const compact=store.assertDatabaseGenerationCapacity(true),copy=store.assertDatabaseGenerationCapacity(false);
    const allocated=store.rows('PRAGMA page_count')[0].page_count*4096,used=allocated-store.rows('PRAGMA freelist_count')[0].freelist_count*4096;
    assert.equal(compact.requiredBytes-copy.requiredBytes,used);
    assert.ok(compact.requiredBytes>=allocated+used+allocated+512*1024*1024);
  } finally{fs.statfsSync=statfs;store.close();}
});

test('foreground content preparation completes while a private generation is executing native compact',async t=>{
  const {Worker}=require('node:worker_threads'),{once}=require('node:events'),crypto=require('node:crypto');
  const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createDatabaseGenerationBaseline}=require('../out/databaseGeneration.js');
  const {DatabaseGenerationWorkerClient}=require('../out/databaseGenerationWorkerClient.js');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-compute-isolation-'));t.after(()=>cleanupOwn(root));
  const source=new UnifiedDataStore(root),databaseId=source.databaseId;
  const candidateDir=path.join(root,'database-generations',crypto.randomUUID());
  source.db.run('CREATE TABLE owned_compact_bulk(id INTEGER PRIMARY KEY,payload BLOB)');source.db.run('INSERT INTO owned_compact_bulk VALUES(1,zeroblob(134217728))');
  try{await createDatabaseGenerationBaseline(source.filePath,path.join(candidateDir,'baseline.db'),databaseId);}finally{source.close();}
  let foreground,generation;
  try{
    foreground=new Worker(path.resolve(__dirname,'../out/maintenanceComputeWorker.js'),{workerData:{root,databaseId}});await once(foreground,'message');
    const identity=fs.lstatSync(candidateDir,{bigint:true}),proof={device:String(identity.dev),inode:String(identity.ino)};
    generation=await DatabaseGenerationWorkerClient.start({root,databaseId,generation:{candidateDir,...proof}});
    let completed=false;
    const building=generation.request('build_compact_database_generation',{candidateDir,value:proof}).finally(()=>{completed=true;});void building.catch(()=>{});
    while(!completed&&!fs.readdirSync(candidateDir).some(name=>name.startsWith('.solomap-compact-')))await new Promise(resolve=>setTimeout(resolve,1));
    assert.equal(completed,false,'the foreground request must overlap actual generation work');
    const reply=once(foreground,'message');foreground.postMessage({id:1,operation:'prepare_content_publication',input:{bytes:'foreground remains available',mimeType:'text/plain',encoding:'utf8'}});
    const [prepared]=await reply;
    assert.equal(prepared.error,undefined);assert.equal(prepared.result.content.sha256,crypto.createHash('sha256').update('foreground remains available').digest('hex'));
    assert.equal(completed,false,'native compact must not occupy the foreground preparation Worker');
    await building;
    await assert.rejects(generation.request('prepare_content_publication',{candidateDir,input:{bytes:'not a foreground endpoint',mimeType:'text/plain',encoding:'utf8'}}),/database_generation_operation_invalid/);
  }finally{await generation?.close();await foreground?.terminate();}
});

test('a compact candidate shrinks its own baseline and retains full history and exact search rowids', async t => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { createDatabaseGenerationBaseline } = require('../out/databaseGeneration.js');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-compact-candidate-'));t.after(()=>cleanupOwn(root));
  const source=new UnifiedDataStore(path.join(root,'source'));
  const candidateDir=path.join(root,'candidate');fs.mkdirSync(candidateDir);
  const receipt=source.write({kind:'memory',action:'create',scope:null,idempotencyKey:'compact-kept',data:{category:'inbox',title:'retained',status:'captured',content:'original fixed full body'}});
  source.write({kind:'memory',action:'patch',scope:null,objectId:receipt.objectId,expectedRevision:receipt.revision,idempotencyKey:'compact-kept-patch',data:{content:'later complete body'}});
  source.db.run('CREATE TABLE owned_scratch(id INTEGER PRIMARY KEY,payload BLOB)');source.db.run('INSERT INTO owned_scratch VALUES(1,zeroblob(8388608))');source.db.run('DELETE FROM owned_scratch');
  const baseline=path.join(candidateDir,'baseline.db'),databaseId=source.databaseId;
  try { await createDatabaseGenerationBaseline(source.filePath,baseline,databaseId); }
  finally { source.close(); }
  const identity=fs.lstatSync(candidateDir,{bigint:true});
  const { createCompactDatabaseCandidate }=require('../out/db/compactDatabaseGeneration.js');
  const result=createCompactDatabaseCandidate({candidateDir,databaseId,device:String(identity.dev),inode:String(identity.ino)});
  assert.ok(result.afterBytes < result.beforeBytes-8_000_000);
  const candidate=UnifiedDataStore.open(candidateDir,databaseId);
  try {
    assert.equal(candidate.read(receipt.objectId,receipt.revision).data.content,'original fixed full body');assert.equal(candidate.read(receipt.objectId).data.content,'later complete body');
    assert.equal(candidate.verifyDatabaseGeneration().integrity,'ok');
    const before=new DiskDatabase(baseline,{readOnly:true});
    try { assert.deepEqual(candidate.rows('SELECT rowid,id FROM objects ORDER BY id').map(row=>[row.rowid,row.id]),before.exec('SELECT rowid,id FROM objects ORDER BY id')[0].values); }
    finally { before.close(); }
  } finally { candidate.close(); }
  assert.deepEqual(fs.readdirSync(candidateDir).sort(),['baseline.db','solomap.db']);
});

test('native VACUUM INTO preserves indexed business rowids and contentless search bindings', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-vacuum-native-'));
  t.after(() => { for (const name of fs.readdirSync(root)) fs.unlinkSync(path.join(root, name)); fs.rmdirSync(root); });
  const source = new DiskDatabase(path.join(root, 'baseline.db'));
  let candidate;
  try {
    source.run('CREATE TABLE objects(id TEXT PRIMARY KEY,payload BLOB)');
    source.run("CREATE VIRTUAL TABLE object_search USING fts5(terms,content='',contentless_delete=1,detail=none)");
    source.run("INSERT INTO objects(rowid,id,payload) VALUES(10,'retained-a',zeroblob(1000)),(30,'retained-b',zeroblob(1000))");
    source.run("INSERT INTO object_search(rowid,terms) VALUES(10,'alpha'),(30,'beta')");
    source.run('CREATE TABLE scratch(id INTEGER PRIMARY KEY,payload BLOB)');
    source.run('INSERT INTO scratch VALUES(1,zeroblob(8388608))');
    source.run('DELETE FROM scratch');
    assert.ok(Number(source.exec('PRAGMA freelist_count')[0].values[0][0]) > 1000);
    source.run('PRAGMA wal_checkpoint(TRUNCATE)');
    source.run('VACUUM INTO ?', [path.join(root, 'candidate.db')]);
    candidate = new DiskDatabase(path.join(root, 'candidate.db'));
    assert.deepEqual(candidate.exec('SELECT rowid,id FROM objects ORDER BY id')[0].values, [[10,'retained-a'],[30,'retained-b']]);
    assert.deepEqual(candidate.exec("SELECT objects.id FROM objects JOIN object_search ON object_search.rowid=objects.rowid WHERE object_search MATCH 'beta'")[0].values, [['retained-b']]);
    assert.equal(candidate.exec('PRAGMA freelist_count')[0].values[0][0], 0);
    assert.ok(fs.statSync(candidate.filePath).size < fs.statSync(source.filePath).size / 10);
  } finally { candidate?.close(); source.close(); }
});
