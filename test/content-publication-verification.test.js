const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const {DiskDatabase}=require('../out/db/diskDatabase.js');
const {UnifiedDataStore,prepareContentForStorage}=require('../out/db/unifiedDataStore.js');
const {attachLazyContentCompute}=require('./content-compute-fixture.cjs');

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function fixture(t,create=true){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-content-proof-')),store=new UnifiedDataStore(root),closeCompute=attachLazyContentCompute(store);
  const pending=[],releases=[],targets=new Set(),original=store.assertContentIntegrity.bind(store),bytes=crypto.randomBytes(1024*1024+17);
  const prepared=prepareContentForStorage(bytes,'application/octet-stream','binary'),id=create?store.putContent(bytes,'application/octet-stream','binary'):null;
  if(id)targets.add(id);
  store.assertContentIntegrity=contentId=>{if(targets.has(contentId))throw new Error('Writer performed whole-body integrity verification');return original(contentId);};
  const track=promise=>{void promise.catch(()=>undefined);pending.push(promise);return promise;};
  t.after(async()=>{for(const release of releases)release();await Promise.allSettled(pending);await closeCompute();if(store.db.isOpen)store.close();});
  const verify=store.contentVerificationCompute;
  const pause=(count=1)=>{
    const gates=Array.from({length:count},()=>({entered:deferred(),release:deferred()}));let calls=0;
    releases.push(...gates.map(gate=>gate.release.resolve));
    store.setContentVerificationCompute(async request=>{
      const call=calls++,proof=await verify(request);
      if(gates[call]){gates[call].entered.resolve();await gates[call].release.promise;}
      return proof;
    });
    return {gates,calls:()=>calls};
  };
  return {root,store,bytes,prepared,id,targets,track,pause,verify,original,releases};
}
function corrupt(database,id){
  const statement=database.prepare('SELECT ordinal,data FROM content_chunks WHERE content_id=? ORDER BY ordinal LIMIT 1');let row;
  try{statement.bind([id]);assert.ok(statement.step());row=statement.getAsObject();}finally{statement.free();}
  const bytes=Buffer.from(row.data);bytes[0]^=255;database.run('UPDATE content_chunks SET data=? WHERE content_id=? AND ordinal=?',[bytes,id,row.ordinal]);
}
function assertExited(store){
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM temp.solomap_content_verification_watches')[0].n,0);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
}

test('prepared content dedup verifies complete stored bytes off the Writer before reusing their identity',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-content-verification-')),store=new UnifiedDataStore(root),closeCompute=attachLazyContentCompute(store);
  t.after(async()=>{await closeCompute();store.close();});
  const bytes=Buffer.from('完整正文与原有身份🌿'.repeat(40000)),prepared=prepareContentForStorage(bytes,'text/plain','utf8');
  const id=store.putContent(bytes,'text/plain','utf8'),integrity=store.assertContentIntegrity.bind(store);
  store.assertContentIntegrity=()=>{throw new Error('Writer performed whole-body integrity verification');};
  try{
    const reused=await store.withPreparedContentOwnership(()=>store.putPreparedContent(prepared,'verified-dedup'));
    assert.equal(reused,id);
  }finally{store.assertContentIntegrity=integrity;}
  assert.deepEqual(store.readContentForMaintenance(id),bytes);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

for(const external of [false,true])test(`a stale healthy proof cannot adopt a same-header chunk changed ${external?'by another connection':'on the Writer'}`,async t=>{
  const f=fixture(t),paused=f.pause(),operation=f.track(f.store.withPreparedContentOwnership(()=>f.store.putPreparedContent(f.prepared,'changed-after-proof')));
  await paused.gates[0].entered.promise;
  if(external){const other=new DiskDatabase(f.store.filePath);try{corrupt(other,f.id);}finally{other.close();}
    assert.equal(f.store.rows('SELECT dirty FROM temp.solomap_content_verification_watches WHERE content_id=?',[f.id])[0].dirty,0,'external writes do not fire this connection\'s TEMP triggers');
  }else corrupt(f.store.db,f.id);
  paused.gates[0].release.resolve();assert.equal(await operation,f.id);assert.ok(paused.calls()>1);
  assert.deepEqual(f.store.readContentForMaintenance(f.id),f.bytes);assertExited(f.store);
});

test('unrelated committed logs do not invalidate a healthy content proof',async t=>{
  const f=fixture(t),paused=f.pause(),operation=f.track(f.store.withPreparedContentOwnership(()=>f.store.putPreparedContent(f.prepared,'unrelated-writes')));
  await paused.gates[0].entered.promise;
  for(let index=0;index<20;index++)f.store.appendDiagnosticEvent({kind:'operation',scope:'other-content',occurredAt:new Date().toISOString(),payload:{index},idempotencyKey:`unrelated-${index}`});
  paused.gates[0].release.resolve();assert.equal(await operation,f.id);assert.equal(paused.calls(),1);assertExited(f.store);
});

test('a rolled-back chunk change leaves the original proof and bytes valid',async t=>{
  const f=fixture(t),paused=f.pause(),operation=f.track(f.store.withPreparedContentOwnership(()=>f.store.putPreparedContent(f.prepared,'rolled-back')));
  await paused.gates[0].entered.promise;
  f.store.db.run('BEGIN IMMEDIATE');try{corrupt(f.store.db,f.id);assert.equal(f.store.rows('SELECT dirty FROM temp.solomap_content_verification_watches')[0].dirty,1);}finally{f.store.db.run('ROLLBACK');}
  paused.gates[0].release.resolve();assert.equal(await operation,f.id);assert.equal(paused.calls(),1);assert.deepEqual(f.store.readContentForMaintenance(f.id),f.bytes);assertExited(f.store);
});

test('uncommitted Writer bytes cannot be verified through an older committed reader view',async t=>{
  const f=fixture(t);let calls=0;f.store.setContentVerificationCompute(async request=>{calls++;return f.verify(request);});
  await assert.rejects(f.store.runAtomicCommand(async()=>{
    corrupt(f.store.db,f.id);
    await f.store.withPreparedContentOwnership(()=>f.store.putPreparedContent(f.prepared,'uncommitted'));
  }),/content_verification_transaction_active/);
  assert.equal(calls,0);assert.deepEqual(f.store.readContentForMaintenance(f.id),f.bytes);
});

test('verification rejects an already-pinned readonly snapshot and uses a fresh Compute view for repair',async t=>{
  const f=fixture(t),reader=UnifiedDataStore.openReadOnly(f.root,f.store.databaseId);t.after(()=>reader.close());
  reader.db.run('BEGIN');reader.rows('SELECT data FROM content_chunks WHERE content_id=? LIMIT 1',[f.id]);corrupt(f.store.db,f.id);
  const file=fs.statSync(f.store.filePath,{bigint:true}),request={contentId:f.id,sha256:f.prepared.sha256,mimeType:f.prepared.mimeType,baseEncoding:'binary',byteLength:f.bytes.length,databaseId:f.store.databaseId,incarnation:'owned-test',token:crypto.randomUUID(),sourceDevice:String(file.dev),sourceInode:String(file.ino)};
  try{assert.throws(()=>reader.verifyContentForPublication(request),/content_verification_snapshot_active/);}finally{reader.db.run('ROLLBACK');}
  assert.equal(await f.store.withPreparedContentOwnership(()=>f.store.putPreparedContent(f.prepared,'fresh-after-old-snapshot')),f.id);
  assert.deepEqual(f.store.readContentForMaintenance(f.id),f.bytes);assertExited(f.store);
});

test('a cancelled first owner does not revoke another owner sharing its verified content flight',async t=>{
  const f=fixture(t),paused=f.pause(),cancel=deferred();
  const first=f.track(f.store.withPreparedContentOwnership(()=>Promise.race([f.store.putPreparedContent(f.prepared,'first'),cancel.promise.then(()=>{throw new Error('first_cancelled');})])));
  await paused.gates[0].entered.promise;
  const second=f.track(f.store.withPreparedContentOwnership(()=>f.store.putPreparedContent(f.prepared,'second')));
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins WHERE content_id=?',[f.id])[0].n,2);
  cancel.resolve();await assert.rejects(first,/first_cancelled/);paused.gates[0].release.resolve();
  assert.equal(await second,f.id);assert.equal(paused.calls(),1);assertExited(f.store);
});

test('a cancelled proof cannot remove a later flight watch for the same content',async t=>{
  const f=fixture(t),paused=f.pause(2),cancel=deferred();let oldWork;
  const first=f.track(f.store.withPreparedContentOwnership(()=>{
    oldWork=f.track(f.store.putPreparedContent(f.prepared,'old'));return Promise.race([oldWork,cancel.promise.then(()=>{throw new Error('old_cancelled');})]);
  }));
  await paused.gates[0].entered.promise;cancel.resolve();await assert.rejects(first,/old_cancelled/);
  const next=f.track(f.store.withPreparedContentOwnership(()=>f.store.putPreparedContent(f.prepared,'new')));await paused.gates[1].entered.promise;
  paused.gates[0].release.resolve();await assert.rejects(oldWork,/prepared_content_owner_finished/);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM temp.solomap_content_verification_watches')[0].n,1);
  paused.gates[1].release.resolve();assert.equal(await next,f.id);assertExited(f.store);
});

test('verification IO failure preserves original bytes without starting a content repair',async t=>{
  const f=fixture(t);f.store.setContentVerificationCompute(async()=>{throw Object.assign(new Error('verification_IO'),{code:'EIO'});});
  await assert.rejects(f.store.withPreparedContentOwnership(()=>f.store.putPreparedContent(f.prepared,'IO-failure')),/verification_IO/);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_repairs')[0].n,0);assert.deepEqual(f.store.readContentForMaintenance(f.id),f.bytes);assertExited(f.store);
});

test('a proof replayed with another request token is rejected before content adoption',async t=>{
  const f=fixture(t);f.store.setContentVerificationCompute(async request=>({...await f.verify(request),token:crypto.randomUUID()}));
  await assert.rejects(f.store.withPreparedContentOwnership(()=>f.store.putPreparedContent(f.prepared,'wrong-proof')),/content_verification_proof_invalid/);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_repairs')[0].n,0);assertExited(f.store);
});

test('a lossless representation change is reverified without changing content identity',async t=>{
  const f=fixture(t),paused=f.pause(),operation=f.track(f.store.withPreparedContentOwnership(()=>f.store.putPreparedContent(f.prepared,'recoded')));
  await paused.gates[0].entered.promise;
  const gzip=zlib.gzipSync(f.bytes);f.store.db.run("UPDATE contents SET encoding='gzip:binary',stored_byte_length=?,data=?,chunk_index_json=NULL WHERE id=?",[gzip.length,gzip,f.id]);
  paused.gates[0].release.resolve();assert.equal(await operation,f.id);assert.equal(paused.calls(),2);
  assert.deepEqual(f.store.readContentForMaintenance(f.id),f.bytes);assertExited(f.store);
});

test('a removed TEMP trigger cannot make an old healthy proof valid after a chunk change',async t=>{
  const f=fixture(t),paused=f.pause(),operation=f.track(f.store.withPreparedContentOwnership(()=>f.store.putPreparedContent(f.prepared,'lost-trigger')));
  await paused.gates[0].entered.promise;f.store.db.run('DROP TRIGGER temp.solomap_verify_content_chunks_update');corrupt(f.store.db,f.id);
  assert.equal(f.store.rows('SELECT dirty FROM temp.solomap_content_verification_watches')[0].dirty,0);
  paused.gates[0].release.resolve();assert.equal(await operation,f.id);assert.ok(paused.calls()>1);
  assert.deepEqual(f.store.readContentForMaintenance(f.id),f.bytes);assertExited(f.store);
});

test('a late damaged canonical is repaired before adoption and the abandoned private staging exits',async t=>{
  const f=fixture(t,false),project=f.store.write({kind:'project',action:'create',scope:null,idempotencyKey:'late-canonical-project',data:{name:'proof project'}});f.store.beginContentPreparationRecovery();
  for(let index=0;index<2000;index++){const batch=f.store.prepareStorageReferenceBatch(128);f.store.commitStorageReferenceBatch(batch);if(!batch.pending)break;}
  f.store.activateStorageContentLifecycle({strictPublication:true});
  const operation=f.track(f.store.withPreparedContentOwnership(()=>f.store.putPreparedContent(f.prepared,'late-canonical')));
  const stage=f.store.rows("SELECT id FROM contents WHERE encoding LIKE 'staging:%'")[0].id;
  const canonical=f.store.putContent(f.bytes,'application/octet-stream','binary');let asset;
  await f.store.withPreparedContentOwnership(async()=>{
    await f.store.prepareContentReferencePublication(canonical,require('../out/contentReferences.js').summarizeContentBytes(f.bytes));
    asset=f.store.write({kind:'asset',action:'create',scope:project.objectId,idempotencyKey:'late-canonical-root',data:{name:'retained.bin',origin:'verification-test',content_id:canonical}});
  });
  f.targets.add(canonical);corrupt(f.store.db,canonical);
  assert.equal(await operation,canonical);assert.deepEqual(f.store.readContentForMaintenance(canonical),f.bytes);assertExited(f.store);
  f.store.assertContentIntegrity=f.original;
  for(let index=0;index<2000 && f.store.rows('SELECT 1 FROM contents WHERE id=?',[stage]).length;index++){
    const references=f.store.prepareStorageReferenceBatch(128);f.store.commitStorageReferenceBatch(references);
    const gc=f.store.prepareStorageGcBatch(128);f.store.commitStorageGcBatch(gc);
  }
  assert.equal(f.store.rows('SELECT 1 FROM contents WHERE id=?',[stage]).length,0);
  assert.equal(f.store.rows('SELECT 1 FROM content_chunks WHERE content_id=?',[stage]).length,0);
  assert.deepEqual(Buffer.from(f.store.read(asset.objectId,asset.revision).data.content.data,'base64'),f.bytes);
});

for(const late of [false,true])test(`a staged archive repairs its ${late?'late':'existing'} damaged canonical through bounded chunk copies`,async t=>{
  const f=fixture(t,false),mime='application/vnd.solomap.project+json';
  const prepared=prepareContentForStorage(f.bytes,mime,'binary');
  f.store.beginContentPreparationRecovery();
  for(let index=0;index<2000;index++){const batch=f.store.prepareStorageReferenceBatch(128);f.store.commitStorageReferenceBatch(batch);if(!batch.pending)break;}
  f.store.activateStorageContentLifecycle({strictPublication:true});
  let canonical;
  const createDamaged=()=>{canonical=f.store.putContent(f.bytes,mime,'binary');f.targets.add(canonical);corrupt(f.store.db,canonical);};
  if(!late)createDamaged();
  else{
    const select=f.store.selectPreparedContentPromotion.bind(f.store);
    f.store.selectPreparedContentPromotion=(...args)=>{createDamaged();return select(...args);};
  }
  const repaired=await f.store.withPreparedContentOwnership(async()=>{
    const owner=f.store.requireContentPreparationOwner(),stageDirectory=path.join(f.root,'.solomap-maintenance-staging',`project-export-${owner}`),directory=path.join(stageDirectory,'chunks');
    fs.mkdirSync(directory,{recursive:true});
    const archive=path.join(stageDirectory,'archive.stage');fs.writeFileSync(archive,f.bytes);
    const chunks=prepared.chunks.map(chunk=>{
      const file=path.join(directory,`${chunk.ordinal}.chunk`);fs.writeFileSync(file,chunk.data);
      return {ordinal:chunk.ordinal,file,bytes:chunk.data.length,sha256:crypto.createHash('sha256').update(chunk.data).digest('hex')};
    });
    const contentManifestPath=path.join(directory,'manifest.json'),manifest=Buffer.from(JSON.stringify({...prepared,data:Buffer.from(prepared.data).toString('base64'),chunks}));
    fs.writeFileSync(contentManifestPath,manifest);
    const staged={path:archive,contentManifestPath,stageDirectory,sha256:prepared.sha256,bytes:f.bytes.length,manifestSha256:crypto.createHash('sha256').update(manifest).digest('hex')};
    return f.store.putStagedProjectExportContent(staged,`archive-${late}`);
  });
  assert.equal(repaired,canonical);assert.deepEqual(f.store.readContentForMaintenance(canonical),f.bytes);assertExited(f.store);
  assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_repairs')[0].n,0);
  const privateRows=f.store.rows('SELECT content_id FROM content_lifecycle_private_staging');assert.equal(privateRows.length,1);
  const privateId=privateRows[0].content_id;
  f.store.assertContentIntegrity=f.original;
  for(let index=0;index<2000 && f.store.rows('SELECT 1 FROM contents WHERE id=?',[privateId]).length;index++){
    const references=f.store.prepareStorageReferenceBatch(128);f.store.commitStorageReferenceBatch(references);
    const gc=f.store.prepareStorageGcBatch(128);f.store.commitStorageGcBatch(gc);
  }
  assert.equal(f.store.rows('SELECT 1 FROM contents WHERE id=?',[privateId]).length,0);
  assert.equal(f.store.rows('SELECT 1 FROM content_chunks WHERE content_id=?',[privateId]).length,0);
});
