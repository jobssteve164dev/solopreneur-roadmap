const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {DiskDatabase}=require('../out/db/diskDatabase.js');

test('cancelling a failed generation closes native Sessions without materializing a discarded tail',()=>{
  const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-cancel-tail-'));
  let store;
  try{
    store=new UnifiedDataStore(root);store.beginDatabaseGenerationCapture();
    store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'cancel-tail',data:{category:'inbox',title:'survives',status:'captured',content:'complete foreground result'}});
    const sessions=store.db.replicationSessions;let closed=0;
    for(const item of sessions){
      const close=item.session.close.bind(item.session);
      item.session.close=()=>{closed++;close();};
      item.session.changeset=()=>{throw new Error('discarded tail must not be serialized');};
    }
    store.cancelDatabaseGenerationCapture();
    assert.equal(closed,sessions.length);assert.equal(store.databaseGenerationCaptureActive(),false);assert.equal(store.db.changesetCaptureActive,false);
    store.beginDatabaseGenerationCapture();store.cancelDatabaseGenerationCapture();
    assert.equal(store.verifyDatabaseGeneration().integrity,'ok');
  }finally{store?.close();for(const name of fs.readdirSync(root)){const file=path.join(root,name);assert.ok(fs.lstatSync(file).isFile());fs.unlinkSync(file);}fs.rmdirSync(root);}
});

test('native online backup retains the read transaction pinned before concurrent Writer commits',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-pinned-native-'));
  const source=path.join(root,'source.db'),destination=path.join(root,'baseline.db');
  let writer,reader,candidate;
  try{
    writer=new DiskDatabase(source);
    writer.run('CREATE TABLE observations(id INTEGER PRIMARY KEY,version INTEGER NOT NULL,payload BLOB NOT NULL)');
    writer.run('INSERT INTO observations VALUES(1,1,zeroblob(262144))');
    reader=new DiskDatabase(source,{readOnly:true});
    reader.run('BEGIN');
    assert.equal(reader.exec('SELECT version FROM observations WHERE id=1')[0].values[0][0],1);
    writer.run('UPDATE observations SET version=2 WHERE id=1');
    writer.run("INSERT INTO observations VALUES(2,2,X'ff')");
    let commitsDuringCopy=0;
    const {backup}=require('node:sqlite');
    await backup(reader.native,destination,{rate:1,progress:()=>{writer.run('UPDATE observations SET version=version+1 WHERE id=1');commitsDuringCopy++;}});
    assert.ok(commitsDuringCopy>0,'copy must overlap actual commits after snapshot pinning');
    candidate=new DiskDatabase(destination,{readOnly:true});
    assert.deepEqual(candidate.exec('SELECT id,version,length(payload) FROM observations')[0].values,[[1,1,262144]]);
    assert.equal(reader.exec('SELECT COUNT(*) FROM observations')[0].values[0][0],1);
    reader.run('COMMIT');
    assert.equal(reader.exec('SELECT COUNT(*) FROM observations')[0].values[0][0],2);
    assert.equal(writer.exec('SELECT version FROM observations WHERE id=1')[0].values[0][0],2+commitsDuringCopy);
  }finally{
    candidate?.close();reader?.close();writer?.close();
    for(const name of fs.readdirSync(root)){const file=path.join(root,name);assert.ok(fs.lstatSync(file).isFile());fs.unlinkSync(file);}fs.rmdirSync(root);
  }
});

test('a restarted snapshot retries ancestor synchronization after directory creation succeeded but fsync failed',async()=>{
  const {PinnedDatabaseSnapshot}=require('../out/db/pinnedDatabaseSnapshot.js');
  const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),crypto=require('node:crypto');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-snapshot-sync-retry-')),sync=fs.fsyncSync;
  let store,snapshot;const directoriesSynced=new Set();let fail=true;
  try{
    store=new UnifiedDataStore(root);snapshot=new PinnedDatabaseSnapshot(store.filePath,store.databaseId,'writer-one');
    const rootStat=fs.statSync(root,{bigint:true}),rootKey=`${rootStat.dev}:${rootStat.ino}`,parent=path.join(root,'new-parent'),destination=path.join(parent,'new-child','baseline.db');
    fs.fsyncSync=function(descriptor){const stat=fs.fstatSync(descriptor,{bigint:true}),key=`${stat.dev}:${stat.ino}`;
      if(stat.isDirectory()&&key===rootKey&&fail){fail=false;throw Object.assign(new Error('fixture_parent_sync_failed'),{code:'EIO'});}
      if(stat.isDirectory())directoriesSynced.add(key);return sync.call(fs,descriptor);
    };
    await assert.rejects(snapshot.copyTo(destination,snapshot.pin(crypto.randomUUID())),/fixture_parent_sync_failed/);
    assert.equal(fs.existsSync(destination),false);assert.equal(fs.existsSync(path.dirname(destination)),true);
    snapshot.cancel();snapshot=new PinnedDatabaseSnapshot(store.filePath,store.databaseId,'writer-one');directoriesSynced.clear();
    await snapshot.copyTo(destination,snapshot.pin(crypto.randomUUID()));fs.fsyncSync=sync;
    for(const directory of [root,parent,path.dirname(destination)]){const stat=fs.statSync(directory,{bigint:true});assert.ok(directoriesSynced.has(`${stat.dev}:${stat.ino}`),`retry must synchronize directory: ${directory}`);}
  }finally{
    fs.fsyncSync=sync;snapshot?.cancel();store?.close();
    const directories=[root],files=[];for(let i=0;i<directories.length;i++)for(const name of fs.readdirSync(directories[i])){const entry=path.join(directories[i],name);if(fs.lstatSync(entry).isDirectory())directories.push(entry);else files.push(entry);}for(const file of files)fs.unlinkSync(file);for(const directory of directories.reverse())fs.rmdirSync(directory);
  }
});

test('a successful snapshot copy synchronizes every directory entry it creates in a new parent chain',async()=>{
  const {PinnedDatabaseSnapshot}=require('../out/db/pinnedDatabaseSnapshot.js');
  const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),crypto=require('node:crypto');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-snapshot-durable-path-')),sync=fs.fsyncSync;
  let store,snapshot;const directoriesSynced=new Set();
  try{
    store=new UnifiedDataStore(root);snapshot=new PinnedDatabaseSnapshot(store.filePath,store.databaseId,'writer-one');
    const binding=snapshot.pin(crypto.randomUUID()),parent=path.join(root,'new-parent'),leaf=path.join(parent,'new-child');
    fs.fsyncSync=function(descriptor){const stat=fs.fstatSync(descriptor,{bigint:true});if(stat.isDirectory())directoriesSynced.add(`${stat.dev}:${stat.ino}`);return sync.call(fs,descriptor);};
    await snapshot.copyTo(path.join(leaf,'baseline.db'),binding);fs.fsyncSync=sync;
    for(const directory of [root,parent,leaf]){const stat=fs.statSync(directory,{bigint:true});assert.ok(directoriesSynced.has(`${stat.dev}:${stat.ino}`),`directory entry must be durable: ${directory}`);}
  }finally{
    fs.fsyncSync=sync;snapshot?.cancel();store?.close();
    const directories=[root],files=[];for(let i=0;i<directories.length;i++)for(const name of fs.readdirSync(directories[i])){const entry=path.join(directories[i],name);if(fs.lstatSync(entry).isDirectory())directories.push(entry);else files.push(entry);}for(const file of files)fs.unlinkSync(file);for(const directory of directories.reverse())fs.rmdirSync(directory);
  }
});

test('a destination appearing after preflight is preserved byte-for-byte instead of being overwritten by native backup',async()=>{
  const {PinnedDatabaseSnapshot}=require('../out/db/pinnedDatabaseSnapshot.js');
  const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),crypto=require('node:crypto');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-snapshot-destination-'));
  let store,snapshot,foreign;
  const mkdir=fs.mkdirSync;
  try{
    store=new UnifiedDataStore(root);snapshot=new PinnedDatabaseSnapshot(store.filePath,store.databaseId,'writer-one');
    const binding=snapshot.pin(crypto.randomUUID()),parent=path.join(root,'generation'),destination=path.join(parent,'baseline.db');let inserted=false,original;
    fs.mkdirSync=function(directory,options){
      const result=mkdir.call(fs,directory,options);
      if(path.resolve(directory)===parent&&!inserted){
        inserted=true;const owner=new DiskDatabase(destination,{journalMode:'DELETE'});
        try{owner.run('CREATE TABLE owner_asset(value TEXT NOT NULL)');owner.run("INSERT INTO owner_asset VALUES('existing owner data')");}finally{owner.close();}
        original=fs.readFileSync(destination);
      }
      return result;
    };
    let copying;try{copying=snapshot.copyTo(destination,binding);}finally{fs.mkdirSync=mkdir;}
    await assert.rejects(copying,/database_snapshot_destination_exists/);
    assert.equal(inserted,true);assert.deepEqual(fs.readFileSync(destination),original);
    foreign=new DiskDatabase(destination,{readOnly:true});assert.equal(foreign.exec('SELECT value FROM owner_asset')[0].values[0][0],'existing owner data');
    assert.deepEqual(fs.readdirSync(parent),['baseline.db']);
  }finally{
    fs.mkdirSync=mkdir;snapshot?.cancel();foreign?.close();store?.close();
    const directories=[root],files=[];for(let i=0;i<directories.length;i++)for(const name of fs.readdirSync(directories[i])){const entry=path.join(directories[i],name);if(fs.lstatSync(entry).isDirectory())directories.push(entry);else files.push(entry);}for(const file of files)fs.unlinkSync(file);for(const directory of directories.reverse())fs.rmdirSync(directory);
  }
});

for(const change of ['metadata-only','external metadata','schema-only','active transaction'])test(`pure Session attachment rejects ${change} changes after pinning and never checkpoints the live database`,async()=>{
  const {PinnedDatabaseSnapshot}=require('../out/db/pinnedDatabaseSnapshot.js');
  const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),crypto=require('node:crypto');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-snapshot-session-'));
  let store,snapshot;
  try{
    store=new UnifiedDataStore(root);const before=store.readDatabaseSnapshotFence();
    snapshot=new PinnedDatabaseSnapshot(store.filePath,store.databaseId,before.writerIncarnation);
    const stale=snapshot.pin(before.token);
    if(change==='active transaction')await store.runAtomicCommand(async()=>{
      assert.throws(()=>store.readDatabaseSnapshotFence(),/database_snapshot_transaction_active/);
      assert.equal(store.beginPinnedDatabaseGenerationCapture(stale,before,snapshot),false);
    });
    else if(change==='schema-only')store.db.run('CREATE TABLE snapshot_schema_probe(id TEXT PRIMARY KEY)');
    else if(change==='external metadata'){
      const external=new DiskDatabase(store.filePath);
      try{external.run("INSERT INTO database_meta VALUES('snapshot_metadata_probe','metadata-only write')");}finally{external.close();}
    }else store.db.run("INSERT INTO database_meta VALUES('snapshot_metadata_probe','metadata-only write')");
    assert.equal(store.beginPinnedDatabaseGenerationCapture(stale,before,snapshot),false);
    assert.equal(store.databaseGenerationCaptureActive(),false);
    const fresh=store.readDatabaseSnapshotFence(),obsolete=snapshot.pin(fresh.token),ack=snapshot.pin(fresh.token);
    assert.equal(store.beginPinnedDatabaseGenerationCapture(stale,before,snapshot),false,'a late ACK must not consume the new fence');
    assert.equal(store.beginPinnedDatabaseGenerationCapture(obsolete,fresh,snapshot),false,'a replaced nonce must not start capture or consume the current fence');
    store.db.checkpointForGeneration=()=>{throw new Error('live checkpoint must not run');};
    assert.equal(store.beginPinnedDatabaseGenerationCapture(ack,fresh,snapshot),true);
    store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'captured-after-exact-pin',data:{category:'inbox',title:'foreground',status:'captured',content:'complete result'}});
    assert.ok(store.stopDatabaseGenerationCapture().changeset.byteLength>0);
  }finally{
    snapshot?.cancel();store?.close();
    for(const name of fs.readdirSync(root)){const entry=path.join(root,name);assert.ok(fs.lstatSync(entry).isFile());fs.unlinkSync(entry);}fs.rmdirSync(root);
  }
});

test('failed per-table Session attachment closes every already-created Session before retry',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-session-attach-'));let database;
  try{
    database=new DiskDatabase(path.join(root,'source.db'));database.run('CREATE TABLE a(id INTEGER PRIMARY KEY)');database.run('CREATE TABLE b(id INTEGER PRIMARY KEY)');
    const create=database.native.createSession.bind(database.native);let calls=0,closed=0;
    database.native.createSession=options=>{
      if(++calls===2)throw new Error('fixture_session_attach_failed');
      const session=create(options);return{changeset:()=>session.changeset(),close:()=>{closed++;session.close();}};
    };
    assert.throws(()=>database.startChangesetCapture(),/fixture_session_attach_failed/);
    assert.equal(closed,1);assert.equal(database.changesetCaptureActive,false);
    database.native.createSession=create;database.startChangesetCapture();database.run('INSERT INTO a VALUES(1)');
    assert.ok(database.stopChangesetCapture().byteLength>0);
  }finally{database?.close();for(const name of fs.readdirSync(root))fs.unlinkSync(path.join(root,name));fs.rmdirSync(root);}
});

test('reusing a request token cannot revive an old snapshot ACK and cancellation cannot qualify a completed copy',async()=>{
  const {PinnedDatabaseSnapshot}=require('../out/db/pinnedDatabaseSnapshot.js');
  const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),crypto=require('node:crypto');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-snapshot-revoke-'));
  let store,snapshot;
  try{
    store=new UnifiedDataStore(root);snapshot=new PinnedDatabaseSnapshot(store.filePath,store.databaseId,'writer-one');
    const first=snapshot.pin(crypto.randomUUID()),second=snapshot.pin(first.token),destination=path.join(root,'generation','baseline.db');
    await assert.rejects(snapshot.copyTo(destination,first),/database_snapshot_binding_invalid/);
    assert.equal(fs.existsSync(destination),false);
    const copying=snapshot.copyTo(destination,second);snapshot.cancel();
    await assert.rejects(copying,/database_snapshot_revoked/);
    assert.equal(fs.existsSync(destination),false);
    fs.writeFileSync(destination,'pre-existing fixture bytes');
    const third=snapshot.pin(crypto.randomUUID());
    await assert.rejects(snapshot.copyTo(destination,third),/database_snapshot_destination_exists/);
    assert.equal(fs.readFileSync(destination,'utf8'),'pre-existing fixture bytes');
    await snapshot.copyTo(path.join(root,'generation','replacement.db'),third);
  }finally{
    snapshot?.cancel();store?.close();
    const directories=[root],files=[];for(let i=0;i<directories.length;i++)for(const name of fs.readdirSync(directories[i])){const entry=path.join(directories[i],name);if(fs.lstatSync(entry).isDirectory())directories.push(entry);else files.push(entry);}for(const file of files)fs.unlinkSync(file);for(const directory of directories.reverse())fs.rmdirSync(directory);
  }
});

test('a generation snapshot binds its token, source identity and Writer incarnation before copying',async()=>{
  const {PinnedDatabaseSnapshot}=require('../out/db/pinnedDatabaseSnapshot.js');
  const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-snapshot-binding-'));
  let store,snapshot,baseline;
  try{
    store=new UnifiedDataStore(root);
    const receipt=store.write({kind:'memory',action:'create',scope:null,idempotencyKey:'before-pin',data:{category:'inbox',title:'snapshot',status:'captured',content:'complete original'}});
    snapshot=new PinnedDatabaseSnapshot(store.filePath,store.databaseId,'writer-one');
    const crypto=require('node:crypto'),first=snapshot.pin(crypto.randomUUID());
    store.write({kind:'memory',action:'patch',scope:null,objectId:receipt.objectId,expectedRevision:1,idempotencyKey:'after-pin',data:{content:'complete later'}});
    const destination=path.join(root,'generation','solomap.db');
    await assert.rejects(snapshot.copyTo(destination,{...first,writerIncarnation:'writer-two'}),/database_snapshot_binding_invalid/);
    assert.equal(fs.existsSync(destination),false);
    await snapshot.copyTo(destination,first);
    baseline=UnifiedDataStore.openReadOnly(path.dirname(destination),store.databaseId);
    assert.equal(baseline.readRuntimeWriterBarrier().committedSequence,first.committedSequence);
    assert.equal(baseline.read(receipt.objectId).revision,1);
    assert.equal(baseline.read(receipt.objectId).data.content,'complete original');
  }finally{
    snapshot?.cancel();baseline?.close();store?.close();
    const directories=[root],files=[];for(let i=0;i<directories.length;i++)for(const name of fs.readdirSync(directories[i])){const entry=path.join(directories[i],name);if(fs.lstatSync(entry).isDirectory())directories.push(entry);else files.push(entry);}for(const file of files)fs.unlinkSync(file);for(const directory of directories.reverse())fs.rmdirSync(directory);
  }
});
