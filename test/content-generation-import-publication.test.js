const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {UnifiedDataStore,prepareContentForStorage}=require('../out/db/unifiedDataStore.js');
const {createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');
const {createDatabaseGenerationBaseline}=require('../out/databaseGeneration.js');
const {DatabaseGenerationWorkerClient}=require('../out/databaseGenerationWorkerClient.js');

test('candidate import permission rejects a forged token and physical aliases of the Source database',async t=>{
  const {bindCandidateImportAuthority,assertCandidateImportAuthority}=require('../out/db/candidateImportAuthority.js');
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-import-authority-')),source=new UnifiedDataStore(path.join(base,'source'));
  t.after(()=>source.close());
  assert.throws(()=>assertCandidateImportAuthority({},source.root,source.databaseId),/project_import_candidate_required/);
  await assert.rejects(source.importProject({source:path.join(base,'unused-archive'),root:path.join(base,'untouched-target'),idempotencyKey:'forged-role'},()=>{},true,source.root,{}),/project_import_candidate_required/);
  assert.equal(fs.existsSync(path.join(base,'untouched-target')),false);
  const candidateRoot=path.join(source.root,'database-generations',crypto.randomUUID());fs.mkdirSync(candidateRoot,{recursive:true});
  fs.linkSync(source.filePath,path.join(candidateRoot,'solomap.db'));
  const stat=fs.lstatSync(candidateRoot,{bigint:true});
  assert.throws(()=>bindCandidateImportAuthority({sourceRoot:source.root,candidateRoot,databaseId:source.databaseId,directoryDevice:String(stat.dev),directoryInode:String(stat.ino)}),/project_import_candidate_changed/);
});

for(const scenario of ['ordinary','deduplicate','cycle','fanout','empty','rollback','other-owner','pending-tail'])test(`the actual private Generation Worker publishes final imported content before strict roots: ${scenario}`,async t=>{
  const deduplicate=scenario==='deduplicate'||scenario==='rollback'||scenario==='pending-tail';
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-content-publication-')),donorRoot=path.join(base,'donor'),projectRoot=path.join(base,'project'),activeRoot=path.join(base,'active');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(path.join(projectRoot,'.solopreneur'));
  fs.writeFileSync(path.join(projectRoot,'.solopreneur','roadmap.csv'),'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\nstep,完整任务,原始目标,实施,,codex,执行,Pending,2026-01-01T00:00:00.000Z,');
  const donor=new UnifiedDataStore(donorRoot),donorOps=createRuntimeDataOperations(donor),active=new UnifiedDataStore(activeRoot);
  let worker,releaseOwner,ownerFlight,unrelatedId,ownerRows,pendingRows;
  t.after(async()=>{releaseOwner?.();await ownerFlight;await worker?.close();active.cancelDatabaseGenerationCapture();await donorOps.close();donor.close();active.close();});
  const project=await donor.registerProject({root:projectRoot}),body=scenario==='pending-tail'?JSON.stringify({relatedContentIds:Array.from({length:301},(_,i)=>`pending-target-${i}`)}):scenario==='empty'?'':'完整保留的导入原文🌿'.repeat(1000);
  await donorOps({operation:'accept_roadmap_csv',input:{root:projectRoot}});
  const memory=donor.write({kind:'memory',action:'create',scope:project.projectId,idempotencyKey:'imported-memory',data:{category:'inbox',title:'immutable imported memory',status:'captured',content:body}});
  const originalBodyId=donor.readMetadata(memory.objectId).data.content_id;
  const firstSnapshot=donor.rows('SELECT content_id FROM object_revisions WHERE object_id=? AND revision=1',[memory.objectId])[0].content_id;
  let secondMemory;
  const updateSnapshot=(id,patch)=>{
    const snapshot=JSON.parse(donor.content(id).toString('utf8'));
    const stored=prepareContentForStorage(Buffer.from(JSON.stringify({...snapshot,...patch})),'application/json','utf8');
    donor.db.run('DELETE FROM content_chunks WHERE content_id=?',[id]);
    donor.db.run('UPDATE contents SET sha256=?,encoding=?,byte_length=?,stored_byte_length=?,data=?,chunk_index_json=? WHERE id=?',[stored.sha256,stored.encoding,stored.byteLength,stored.storedByteLength,stored.data,stored.chunkIndexJson,id]);
    for(const chunk of stored.chunks)donor.db.run('INSERT INTO content_chunks VALUES(?,?,?)',[id,chunk.ordinal,chunk.data]);
  };
  if(scenario==='cycle'){
    secondMemory=donor.write({kind:'memory',action:'create',scope:project.projectId,idempotencyKey:'cycle-member',data:{category:'inbox',title:'cycle member',status:'captured',content:'other retained body'}});
    const secondSnapshot=donor.rows('SELECT content_id FROM object_revisions WHERE object_id=? AND revision=1',[secondMemory.objectId])[0].content_id;
    updateSnapshot(firstSnapshot,{relatedContentId:secondSnapshot});updateSnapshot(secondSnapshot,{relatedContentId:firstSnapshot});
  }
  const fanout=scenario==='fanout'?Array.from({length:257},()=>crypto.randomUUID()):[];
  if(fanout.length)updateSnapshot(firstSnapshot,{relatedContentIds:fanout});
  const archive=path.join(base,'project.solomap-project.json');
  await donorOps({operation:'export_project',input:{root:projectRoot,destination:archive,idempotencyKey:'strict-generation-export'}});
  const drainReferences=()=>{for(let i=0;i<2000;i++){const batch=active.prepareStorageReferenceBatch(128);active.commitStorageReferenceBatch(batch);if(scenario==='pending-tail'&&active.rows('SELECT 1 FROM content_lifecycle_reference_jobs WHERE source_id=?',[canonicalId]).length)break;if(!batch.pending)break;assert.notEqual(i,1999);}};
  if(scenario==='pending-tail')for(let i=0;i<2000;i++){const batch=active.prepareStorageReferenceBatch(128);active.commitStorageReferenceBatch(batch);if(!batch.pending)break;assert.notEqual(i,1999);}
  const canonicalId=deduplicate?active.putContent(body):originalBodyId;
  if(scenario==='pending-tail')active.db.run('INSERT INTO content_lifecycle_edges VALUES(?,?,0)',[canonicalId,'obsolete-before-baseline']);
  drainReferences();
  active.beginContentPreparationRecovery();active.activateStorageContentLifecycle({strictPublication:true});
  if(scenario==='other-owner'){
    ownerFlight=active.withPreparedContentOwnership(async()=>{
      unrelatedId=active.putContent('another accepted producer is still preparing');
      active.pinPreparedContent(active.requireContentPreparationOwner(),unrelatedId);
      await new Promise(resolve=>{releaseOwner=resolve;});
    });
    ownerRows=active.rows('SELECT * FROM content_lifecycle_prepare_owners ORDER BY id');
    pendingRows=active.rows('SELECT * FROM content_lifecycle_reference_pending WHERE content_id=?',[unrelatedId]);
  }
  if(scenario==='rollback')active.db.run('UPDATE contents SET data=zeroblob(stored_byte_length) WHERE id=?',[canonicalId]);
  const candidateDir=path.join(activeRoot,'database-generations',crypto.randomUUID());
  if(scenario==='pending-tail')active.beginDatabaseGenerationCapture();
  await createDatabaseGenerationBaseline(active.filePath,path.join(candidateDir,'solomap.db'),active.databaseId);
  const identity=fs.lstatSync(candidateDir,{bigint:true});
  if(scenario==='rollback'){
    const {bindCandidateImportAuthority}=require('../out/db/candidateImportAuthority.js');
    const candidate=UnifiedDataStore.open(candidateDir,active.databaseId);
    try{
      const authority=bindCandidateImportAuthority({sourceRoot:activeRoot,candidateRoot:candidateDir,databaseId:active.databaseId,directoryDevice:String(identity.dev),directoryInode:String(identity.ino)});
      const original=candidate.rows('SELECT data FROM contents WHERE id=?',[canonicalId])[0].data;
      const count=candidate.rows('SELECT COUNT(*) AS n FROM contents')[0].n;
      let interrupted=false;
      await assert.rejects(candidate.importProject({source:archive,root:path.join(candidateDir,'project-files'),idempotencyKey:'strict-generation-import'},()=>{
        if(!interrupted&&!Buffer.from(candidate.rows('SELECT data FROM contents WHERE id=?',[canonicalId])[0].data).equals(Buffer.from(original))){interrupted=true;throw new Error('injected_candidate_after_repair');}
      },true,activeRoot,authority),/injected_candidate_after_repair/);
      assert.equal(interrupted,true);
      assert.deepEqual(candidate.rows('SELECT data FROM contents WHERE id=?',[canonicalId])[0].data,original,'failed private preparation must restore the damaged baseline bytes for an exact retry');
      assert.equal(candidate.rows('SELECT COUNT(*) AS n FROM contents')[0].n,count,'an interrupted map must not leak provisional content');
      assert.equal(candidate.rows('PRAGMA foreign_keys')[0].foreign_keys,1);
    }finally{candidate.close();}
  }
  worker=await DatabaseGenerationWorkerClient.start({root:activeRoot,databaseId:active.databaseId,generation:{candidateDir,device:String(identity.dev),inode:String(identity.ino)}});
  const result=await worker.request('build_project_import_generation',{candidateDir,source:archive,targetRoot:path.join(base,'imported-project'),idempotencyKey:'strict-generation-import'});
  assert.equal(result.projectId,project.projectId);
  if(scenario==='pending-tail'){
    const inspect=UnifiedDataStore.openReadOnly(candidateDir,active.databaseId);
    try{assert.equal(inspect.rows('SELECT edge_offset FROM content_lifecycle_reference_jobs WHERE source_id=?',[canonicalId])[0]?.edge_offset,128,'the original Source job remains available for its Session tail');}finally{inspect.close();}
    fs.mkdirSync(path.join(candidateDir,'changesets'));
    for(let frameNumber=1;frameNumber<=4;frameNumber++){
      const batch=active.prepareStorageReferenceBatch(128);active.commitStorageReferenceBatch(batch);
      const frame=active.rotateDatabaseGenerationCapture(),file=path.join(candidateDir,'changesets',`${String(frameNumber).padStart(12,'0')}.changeset`);
      fs.writeFileSync(file,frame.changeset,{flag:'wx'});
      await worker.request('apply_project_import_generation_changeset',{candidateDir,changesetFile:file,searchObjectIds:frame.searchObjectIds,previousLiveSequence:0,currentLiveSequence:0});
    }
    active.cancelDatabaseGenerationCapture();
  }
  const reader=UnifiedDataStore.openReadOnly(candidateDir,active.databaseId);
  try{
    assert.equal(reader.rows('SELECT strict_publication FROM content_lifecycle_gc_state WHERE id=1')[0].strict_publication,1,'the candidate must retain strict publication');
    const imported=reader.read(memory.objectId,1);assert.equal(imported.data.content,body);assert.equal(imported.data.content_id,canonicalId);
    const snapshot=reader.rows('SELECT content_id FROM object_revisions WHERE object_id=? AND revision=1',[memory.objectId])[0].content_id;
    const expectedTargets=[canonicalId,...fanout];
    if(secondMemory){
      const secondSnapshot=reader.rows('SELECT content_id FROM object_revisions WHERE object_id=? AND revision=1',[secondMemory.objectId])[0].content_id;
      assert.equal(JSON.parse(reader.content(snapshot).toString('utf8')).relatedContentId,secondSnapshot);
      assert.equal(JSON.parse(reader.content(secondSnapshot).toString('utf8')).relatedContentId,snapshot);
      expectedTargets.push(secondSnapshot);
    }
    assert.deepEqual(reader.rows('SELECT target_id FROM content_lifecycle_edges WHERE source_id=?',[snapshot]).map(row=>row.target_id).sort(),expectedTargets.sort());
    assert.equal(reader.rows('SELECT COUNT(*) AS n FROM content_lifecycle_reference_unpublished')[0].n,unrelatedId?1:0,'only imported final bytes become ready; unrelated preparation remains pending');
    if(unrelatedId){
      assert.deepEqual(reader.rows('SELECT * FROM content_lifecycle_prepare_owners ORDER BY id'),ownerRows);
      assert.deepEqual(reader.rows('SELECT * FROM content_lifecycle_reference_pending WHERE content_id=?',[unrelatedId]),pendingRows);
      assert.deepEqual(reader.rows('SELECT * FROM content_lifecycle_prepare_pins WHERE content_id=?',[unrelatedId]),active.rows('SELECT * FROM content_lifecycle_prepare_pins WHERE content_id=?',[unrelatedId]));
      assert.equal(reader.rows('SELECT incarnation FROM content_lifecycle_gc_state WHERE id=1')[0].incarnation,active.rows('SELECT incarnation FROM content_lifecycle_gc_state WHERE id=1')[0].incarnation);
    }
    assert.equal(fs.existsSync(path.join(base,'imported-project')),false,'the candidate must not publish project files before the original cutover');
  }finally{reader.close();}
});
