const {nativeDirectGrowth}=require('./fixtures/native-direct-growth-oracles.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { restorePortableHandoffSequences } = require('../out/db/portableHandoffSequences.js');
const { restorePortableRecordSequences } = require('../out/db/portableRecordSequences.js');
const { createRuntimeDataOperations } = require('./runtime-data-fixture.cjs');
const { sendRuntimeDataRequest, sendRuntimeControlCommand } = require('../out/autonomousRuntimeControl.js');
const { createDatabaseGenerationBaseline, captureDatabaseGenerationProof, persistDatabaseGenerationCutover, readDatabaseGenerationReclaimManifest, reclaimDatabaseGeneration, reclaimOrphanedDatabaseGenerations, recoverPendingDatabaseGenerationCutover, isDatabaseGenerationCutoverError } = require('../out/databaseGeneration.js');

test('legacy portable handoff boundaries recover sparse original sequences without changing snapshot bytes', () => {
  const handoffs = [
    { project_id:'project',node_key:'step',run_id:'second',turn_id:'turn-2',checkpoint_sequence:3,handoff_sequence:null },
    { project_id:'project',node_key:'step',run_id:'first',turn_id:'turn-1',checkpoint_sequence:2,handoff_sequence:null }
  ];
  const tables=new Map([['step_handoffs',handoffs],['run_documents',[
    {object_id:'doc-1',run_id:'first',purpose:'settlement_turn1_2'},
    {object_id:'doc-2',run_id:'second',purpose:'settlement_turn2_3'}
  ]],['evidence',[]],['project_step_memory_revisions',[]]]), decoded=new Map();
  for(const [id,cursor,document] of [['manual',190,null],['r2',137,'doc-2'],['r1',41,'doc-1']]){
    const snapshot=Buffer.from(JSON.stringify({handoffCursor:cursor,...(document?{latestHandoffRef:{objectId:document}}:{})}));
    decoded.set(id,snapshot);tables.get('evidence').push({id,content_id:id});
    tables.get('project_step_memory_revisions').push({project_id:'project',node_key:'step',object_id:id,handoff_cursor:cursor});
  }
  const original=[...decoded].map(([id,bytes])=>[id,Buffer.from(bytes)]);
  restorePortableHandoffSequences(tables,decoded);
  assert.deepEqual(handoffs.map(row=>row.handoff_sequence),[137,41]);
  for(const [id,bytes] of original)assert.deepEqual(decoded.get(id),bytes);
  handoffs[0].handoff_sequence=null;tables.get('project_step_memory_revisions').pop();handoffs[1].handoff_sequence=null;
  assert.throws(()=>restorePortableHandoffSequences(tables,decoded),/handoff_boundary_missing/);
});

test('legacy portable handoff boundaries reject conflicting immutable anchors', () => {
  const tables=new Map([['step_handoffs',[{project_id:'p',node_key:'n',run_id:'r',turn_id:'t',checkpoint_sequence:1,handoff_sequence:null}]],
    ['run_documents',[{object_id:'d',run_id:'r',purpose:'settlement_t_1'}]],['evidence',[]],['project_step_memory_revisions',[]]]),decoded=new Map();
  for(const cursor of [3,7]){const id=String(cursor);tables.get('evidence').push({id,content_id:id});tables.get('project_step_memory_revisions').push({project_id:'p',node_key:'n',object_id:id,handoff_cursor:cursor});decoded.set(id,Buffer.from(JSON.stringify({handoffCursor:cursor,latestHandoffRef:{objectId:'d'}})));}
  assert.throws(()=>restorePortableHandoffSequences(tables,decoded),/handoff_boundary_conflict/);
});

test('legacy portable growth order retains approved sparse boundaries and uses creation events between them',()=>{
  const manifest=Buffer.from(JSON.stringify({candidateSnapshots:[{snapshotId:'a',objectRowid:41}],retainedSnapshots:[{snapshotId:'c',objectRowid:173}]}));
  const rows=[{id:'c',snapshot_sequence:null},{id:'b',snapshot_sequence:null},{id:'a',snapshot_sequence:null}];
  const tables=new Map([['growth_snapshots',rows],['events',['a','b','c'].map((id,index)=>({subject_id:id,sequence:80+index,kind:'growth_snapshot.create'}))],['growth_snapshot_cleanup_plans',[{manifest_content_id:'plan'}]]]);
  restorePortableRecordSequences(tables,new Map([['plan',manifest]]));
  assert.deepEqual(rows.map(row=>row.snapshot_sequence),[173,42,41]);
  assert.equal(JSON.parse(manifest).retainedSnapshots[0].objectRowid,173);
  rows.forEach(row=>row.snapshot_sequence=null);tables.get('events').pop();
  assert.throws(()=>restorePortableRecordSequences(tables,new Map([['plan',manifest]])),/growth_order_missing/);
});

test('portable business order rejects invalid or duplicate derived sequence values',()=>{
  for(const sequence of [-1,0,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>restorePortableRecordSequences(new Map([['growth_snapshots',[{id:'g',project_id:'p',snapshot_sequence:sequence}]]]),new Map()),/record_order_invalid/);
  assert.throws(()=>restorePortableRecordSequences(new Map([['run_digests',[{object_id:'a',project_id:'p',digest_sequence:1},{object_id:'b',project_id:'p',digest_sequence:1}]]]),new Map()),/record_order_invalid/);
  assert.throws(()=>restorePortableRecordSequences(new Map([['growth_live_items',[{snapshot_id:'a',detail_ordinal:0},{snapshot_id:'a',detail_ordinal:0}]]]),new Map()),/detail_order_invalid/);
  assert.throws(()=>restorePortableHandoffSequences(new Map([['step_handoffs',[{handoff_sequence:0}]]]),new Map()),/handoff_sequence_invalid/);
});

test('legacy portable records restore business events and preserve the recorded technical queue order',()=>{
  const events=[['run','v1',11],['run','v2',30],['document','body',40],['flow','flow-body',50],['report','report-body',70],['temporary','temporary-body',90]].map(([subject_id,content_id,sequence])=>({subject_id,content_id,sequence,kind:'formal'}));
  const effects=[{id:'second-id',project_id:'p',kind:'refresh',state:'done',effect_sequence:null,payload_content_id:'payload-b',token:'original-token'},
    {id:'first-id',project_id:'p',kind:'roadmap',state:'queued',effect_sequence:null,payload_content_id:'payload-a',token:''}];
  const tables=new Map([['events',events],['run_control',[{project_id:'p',run_id:'run',run_sequence:null}]],
    ['object_revisions',[{object_id:'run',revision:2,content_id:'v2'}]],
    ['run_consumer_sources',[{project_id:'p',run_id:'run',source_revision:2,source_sequence:null}]],
    ['run_documents',[{run_id:'run',object_id:'document',purpose:'settlement_turna_3'}]],
    ['run_settlements',[{project_id:'p',run_id:'run',turn_id:'turn-a',checkpoint_sequence:3,payload_content_id:'original',settlement_sequence:null}]],
    ['flow_control',[{project_id:'p',object_id:'flow',flow_sequence:null}]],['reports',[{project_id:'p',id:'report',creation_sequence:null}]],
    ['run_input_materializations',[{project_id:'p',evidence_id:'temporary',materialization_sequence:null}]],['run_effects',effects]]);
  const bytes=Buffer.from('original immutable payload without an effects array'),decoded=new Map([['original',bytes]]);
  restorePortableRecordSequences(tables,decoded);
  for(const [table,column,sequence] of [['run_control','run_sequence',11],['run_consumer_sources','source_sequence',30],['run_settlements','settlement_sequence',40],['flow_control','flow_sequence',50],['reports','creation_sequence',70],['run_input_materializations','materialization_sequence',90]])assert.equal(tables.get(table)[0][column],sequence);
  assert.deepEqual(effects.map(row=>[row.id,row.kind,row.state,row.effect_sequence,row.token]),[['second-id','refresh','done',1,'original-token'],['first-id','roadmap','queued',2,'']]);
  assert.deepEqual(decoded.get('original'),bytes);
  tables.get('run_consumer_sources')[0].source_sequence=null;tables.set('object_revisions',[]);
  assert.throws(()=>restorePortableRecordSequences(tables,decoded),/record_order_missing:run_consumer_sources/);
});

test('generation handoff errors retain their restart identity through normal Error wrapping', () => {
  for (const error of [new Error('database_generation_cutover'), 'database_generation_cutover', 'Error: database_generation_cutover',
    new Error('startup_migrations_failed: database_generation_cutover'), new Error('runtime_data_domain_exited:writer-actor:75')]) {
    assert.equal(isDatabaseGenerationCutoverError(error), true);
  }
  for (const error of [new Error('migration_failed'), 'runtime_data_domain_exited:writer-actor:1',
    'not_database_generation_cutover', 'database_generation_cutover_invalid']) assert.equal(isDatabaseGenerationCutoverError(error), false);
});

test('native generation replay preserves the exact entries in a fixed step-memory revision',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-memory-boundary-'));t.after(()=>cleanupExact(base));
  const projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  const source=new UnifiedDataStore(path.join(base,'source')),closeCompute=require('./content-compute-fixture.cjs').attachLazyContentCompute(source);let candidate;
  try{
    const project=await source.registerProject({root:projectRoot});
    const runs=[];for(let index=0;index<100;index++)runs.push(await source.prepareRun(project.projectId,project.locationId,{root:projectRoot,executionLogId:index+1,nodeId:'step',runKind:'agent_review',prompt:'original input',command:'readonly',userMessage:'review',idempotencyKey:`boundary-run-${index}`}));
    const candidateDir=path.join(base,'candidate');await createDatabaseGenerationBaseline(source.filePath,path.join(candidateDir,'solomap.db'),source.databaseId);candidate=UnifiedDataStore.open(candidateDir,source.databaseId);
    source.beginDatabaseGenerationCapture();
    const order=Array.from({length:100},(_,index)=>index);for(let index=order.length-1;index>0;index--){const target=crypto.randomInt(index+1);[order[index],order[target]]=[order[target],order[index]];}
    source.transaction(()=>{
      for(let index=0;index<order.length;index++){
        const run=runs[order[index]];
        const content=source.putStructuredContent({payloadIndex:order[index]});
        source.insertStepHandoff(project.projectId,'step',run.runId,run.turnId,order[index],content);
        if(index===49)require('./fixtures/native-step-memory-oracles.cjs').writeStepMemoryNative(source,project.projectId,{nodeId:'step',expectedRevision:0,patch:{objective:'fixed boundary'},idempotencyKey:'fixed-boundary'});
      }
    });
    const capture=source.stopDatabaseGenerationCapture();candidate.applyDatabaseGenerationChangeset(capture.changeset,capture.searchObjectIds);
    const original=source.readStepMemory(project.projectId,'step',{revision:1}),replayed=candidate.readStepMemory(project.projectId,'step',{revision:1});
    assert.equal(original.data.entries.length,50);assert.deepEqual(replayed,original);
  }finally{await closeCompute();candidate?.close();source.close();}
});

test('native generation replay preserves same-conversation ingress order and the recoverable head',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-ingress-order-'));t.after(()=>cleanupExact(base));
  const source=new UnifiedDataStore(path.join(base,'source'));let candidate;
  try{
    const owner=source.claimPiExecutionOwner('ordered-ingress'),conversationId=crypto.randomUUID(),candidateDir=path.join(base,'candidate');
    await createDatabaseGenerationBaseline(source.filePath,path.join(candidateDir,'solomap.db'),source.databaseId);candidate=UnifiedDataStore.open(candidateDir,source.databaseId);
    source.beginDatabaseGenerationCapture();
    for(let index=0;index<100;index++)source.admitPiConversationIngress({conversationId,operationId:crypto.randomUUID(),requestKey:`native-ingress-${index}`,text:`input ${index}`,source:'sidebar',sourceGeneration:1},owner);
    const capture=source.stopDatabaseGenerationCapture();candidate.applyDatabaseGenerationChangeset(capture.changeset,capture.searchObjectIds);
    assert.deepEqual(candidate.listRecoverablePiConversationIngresses(conversationId),source.listRecoverablePiConversationIngresses(conversationId));
    assert.equal(candidate.listRecoverablePiConversationIngresses()[0].text,'input 0');
  }finally{candidate?.close();source.close();}
});

for(const state of ['prepared','applying'])test(`native generation replay preserves growth history, topology pages and ${state} cleanup authorization`,async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-growth-order-'));t.after(()=>cleanupExact(base));
  const projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  const source=new UnifiedDataStore(path.join(base,'source'));let candidate;
  try{
    const project=await source.registerProject({root:projectRoot}),candidateDir=path.join(base,'candidate');
    await createDatabaseGenerationBaseline(source.filePath,path.join(candidateDir,'solomap.db'),source.databaseId);candidate=UnifiedDataStore.open(candidateDir,source.databaseId);
    source.beginDatabaseGenerationCapture();
    const nodeIds=Array.from({length:20},()=>crypto.randomUUID());
    for(let index=0;index<30;index++){
      const id=crypto.randomUUID(),createdAt='2026-11-14T00:00:00.000Z';
      const nodes=nodeIds.map((nodeId,ordinal)=>({snapshotId:id,nodeId,parentId:'',kind:'file',path:`file-${ordinal}`,label:'source',language:'JavaScript',bytes:10,loc:2,fileCount:1,testFileCount:0,generated:false,excluded:false,primaryRole:'source',confidence:1}));
      nativeDirectGrowth(source,'write',project.projectId,{snapshot:{id,projectPath:projectRoot,createdAt,gitHead:`head-${Math.floor(index/10)}`,scanReason:`scan-${index}`,status:'completed',durationMs:1,error:''},nodes,edges:[],signals:[],labels:[]},`growth-order-${index}`);
    }
    const plan=source.previewGrowthSnapshotCleanup({idempotencyKey:'growth-order-preview'});
    const apply={planId:plan.planId,planHash:plan.planHash,confirmation:'确认删除该清单记录',idempotencyKey:'growth-order-apply',batchSize:3};
    if(state==='applying'){
      const run=source.db.run.bind(source.db);let batch=0;
      source.db.run=(sql,...values)=>{if(sql.startsWith('DELETE FROM outbox WHERE id IN (SELECT outbox_id FROM growth_cleanup_batch_outbox_scope)')&&++batch===2)throw new Error('owned_growth_batch_interrupt');return run(sql,...values);};
      try{assert.throws(()=>source.applyGrowthSnapshotCleanup(apply),/owned_growth_batch_interrupt/);}finally{source.db.run=run;}
      assert.equal(source.readGrowthSnapshotCleanupPlan(plan.planId).status,'applying');
      assert.equal(source.rows('SELECT COUNT(*) AS n FROM growth_snapshots')[0].n,27);
    }
    const capture=source.stopDatabaseGenerationCapture();candidate.applyDatabaseGenerationChangeset(capture.changeset,capture.searchObjectIds);
    assert.equal(source.readProjectGrowth(project.projectId).latest.snapshot.scanReason,'scan-29');
    assert.equal(plan.manifest.candidateSnapshots.length,27);
    assert.deepEqual(candidate.readProjectGrowth(project.projectId,50),source.readProjectGrowth(project.projectId,50));
    assert.deepEqual(candidate.growthSnapshotDetailCleanupBoundary(),source.growthSnapshotDetailCleanupBoundary());
    if(state==='prepared')assert.deepEqual(candidate.buildGrowthSnapshotCleanupManifest(plan.manifest.createdAt),plan.manifest);
    assert.deepEqual(candidate.applyGrowthSnapshotCleanup(apply),source.applyGrowthSnapshotCleanup(apply));
    assert.equal(candidate.readGrowthSnapshotCleanupPlan(plan.planId).planHash,plan.planHash);
    assert.equal(candidate.rows('SELECT COUNT(*) AS n FROM growth_snapshots')[0].n,3);
    assert.deepEqual(candidate.readProjectGrowth(project.projectId,50),source.readProjectGrowth(project.projectId,50));
  }finally{candidate?.close();source.close();}
});

for(const family of ['digests','migration jobs','outbox','documentation head','derived projections'])test(`native generation replay preserves causal order for ${family}`,async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-causal-order-'));t.after(()=>cleanupExact(base));
  const projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  const source=new UnifiedDataStore(path.join(base,'source'));let candidate;
  try{
    const project=await source.registerProject({root:projectRoot}),candidateDir=path.join(base,'candidate');
    await createDatabaseGenerationBaseline(source.filePath,path.join(candidateDir,'solomap.db'),source.databaseId);candidate=UnifiedDataStore.open(candidateDir,source.databaseId);
    source.beginDatabaseGenerationCapture();
    for(let index=0;index<40;index++){
      if(family==='digests')source.saveRunDigestSource(project.projectId,`source-${index}`,Buffer.from(JSON.stringify({schemaVersion:2,runId:`history:${index}`,nodeId:'step',runKind:'step',executionLogId:1,agentCli:'codex',status:'Completed',startedAt:'2026-09-01T00:00:00Z',finishedAt:'2026-09-01T00:00:01Z',durationMs:1,tokenUsage:{},userIntent:'original input',outcome:`result-${index}`,changedFiles:[],touchedFiles:[],commandSignals:[],verification:[],failures:[],reusableSignals:[],tags:[]})));
      else if(family==='migration jobs')source.enqueueMemoryMigration({sourceRoot:`legacy-${index}`,collection:'capabilities'},`job-${index}`);
      else if(family==='derived projections')source.upsertProjectRunIndex(project.projectId,{executionLogId:index+1,nodeId:'step',runKind:'agent_review',startedAt:'2026-11-14T00:00:00Z',status:'success'},[],[]);
      else if(family==='documentation head'){
        source.writeDocumentationManifest(project.projectId,{schemaVersion:1,updatedAt:`manifest-${index}`,documents:[],pendingReview:[]},null,index,`manifest-${index}`);
      }else {
        const receipt=source.write({kind:'memory',action:'create',scope:project.projectId,idempotencyKey:`event-${index}`,data:{category:'inbox',title:`event-${index}`,status:'captured',content:'body'}});
        const event=source.rows('SELECT id,content_id FROM events WHERE subject_id=?',[receipt.objectId])[0];
        source.db.run("INSERT INTO outbox VALUES(?,?,?,?,?,?,?,0,NULL)",[crypto.randomUUID(),event.id,'roadmap_projection','test://ordered',event.content_id,index,'pending']);
      }
    }
    if(family==='migration jobs')source.db.run('UPDATE migration_jobs SET created_at=1');
    if(family==='documentation head')source.db.run("UPDATE objects SET updated_at=1 WHERE id IN (SELECT id FROM evidence WHERE type='documentation_manifest')");
    const capture=source.stopDatabaseGenerationCapture();candidate.applyDatabaseGenerationChangeset(capture.changeset,capture.searchObjectIds);
    if(family==='digests'){
      const withoutObservationTime=store=>store.prepareRunIndexBackfill(project.projectId).map(item=>({...item,record:{...item.record,updatedAt:'observation-time'}}));
      assert.deepEqual(withoutObservationTime(candidate),withoutObservationTime(source));
      assert.deepEqual(candidate.readRunDigests(project.projectId,{limit:15}),source.readRunDigests(project.projectId,{limit:15}));
    }else if(family==='migration jobs'){
      assert.deepEqual(candidate.pendingMigrationJobs(),source.pendingMigrationJobs());
      assert.deepEqual(candidate.migrationJobSummaries(),source.migrationJobSummaries());
    }
    else if(family==='derived projections'){
      for(const table of ['project_analysis_sources','sidebar_core_projection_state'])assert.deepEqual(candidate.rows(`SELECT * FROM ${table}`),source.rows(`SELECT * FROM ${table}`));
    }else if(family==='documentation head')assert.deepEqual(candidate.readDocumentationManifest(project.projectId),source.readDocumentationManifest(project.projectId));
    else {
      const expected=[],actual=[];source.deliverRoadmapProjection=async id=>expected.push(id);candidate.deliverRoadmapProjection=async id=>actual.push(id);
      await source.recoverOutbox();await candidate.recoverOutbox();assert.deepEqual(actual,expected);
    }
  }finally{candidate?.close();source.close();}
});

test('generation finalization preserves imported ordering floors and rebuilds the combined content count',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-order-floors-'));t.after(()=>cleanupExact(base));
  const source=new UnifiedDataStore(path.join(base,'source'));let candidate;
  try{
    const owner=source.claimPiExecutionOwner('ordering-floor-owner'),conversationId=crypto.randomUUID(),candidateDir=path.join(base,'candidate');
    source.backfillDatabaseOverviewProjectionBatch();
    await createDatabaseGenerationBaseline(source.filePath,path.join(candidateDir,'solomap.db'),source.databaseId);candidate=UnifiedDataStore.open(candidateDir,source.databaseId);
    for(let index=0;index<40;index++)candidate.admitPiConversationIngress({conversationId,operationId:crypto.randomUUID(),requestKey:`candidate-${index}`,text:`retained ${index}`,source:'sidebar',sourceGeneration:1},owner);
    candidate.prepareDatabaseGenerationOrderingFloors();
    source.beginDatabaseGenerationCapture();
    source.admitPiConversationIngress({conversationId,operationId:crypto.randomUUID(),requestKey:'source-tail',text:'source tail',source:'sidebar',sourceGeneration:1},owner);
    const capture=source.stopDatabaseGenerationCapture();candidate.applyDatabaseGenerationChangeset(capture.changeset,capture.searchObjectIds);
    assert.equal(Number(candidate.rows("SELECT value FROM database_meta WHERE key='pi_ingress_sequence'")[0].value),1,'Source control replay really overwrites the candidate counter');
    assert.notEqual(candidate.readDatabaseOverview().contents.records,candidate.rows('SELECT COUNT(*) AS n FROM contents')[0].n,'Source projection cannot include independently imported contents');
    candidate.finalizeDatabaseGenerationProgress(true);
    const admitted=candidate.admitPiConversationIngress({conversationId,operationId:crypto.randomUUID(),requestKey:'after-cutover',text:'after cutover',source:'sidebar',sourceGeneration:1},owner);
    assert.ok(candidate.rows('SELECT admission_sequence FROM pi_conversation_ingress WHERE operation_id=?',[admitted.operationId])[0].admission_sequence>40);
    for(let index=0;index<100;index++){if(candidate.backfillDatabaseOverviewProjectionBatch(10).complete)break;assert.notEqual(index,99);}
    assert.deepEqual(candidate.readDatabaseOverview().contents,{records:candidate.rows('SELECT COUNT(*) AS n FROM contents')[0].n,exact:true});
  }finally{candidate?.close();source.close();}
});

for (const interruptedState of ['ready', 'old-moved', 'activated', 'complete']) test(`compact generation resumes ${interruptedState} without publishing project files`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-compact-cutover-'));
  t.after(() => cleanupExact(root));
  const active = new UnifiedDataStore(root), databaseId = active.databaseId;
  const receipt = active.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'compact-history', data: { category: 'inbox', title: 'kept', status: 'captured', content: 'original fixed history' } });
  active.write({ kind: 'memory', action: 'patch', scope: null, objectId: receipt.objectId, expectedRevision: receipt.revision, idempotencyKey: 'compact-history-patch', data: { content: 'latest value' } });
  const generationId = crypto.randomUUID(), candidateDir = path.join(root, 'database-generations', generationId);
  await createDatabaseGenerationBaseline(active.filePath, path.join(candidateDir, 'solomap.db'), databaseId);
  active.close();
  const proof = captureDatabaseGenerationProof(path.join(candidateDir, 'solomap.db'));
  if (['old-moved', 'activated', 'complete'].includes(interruptedState)) fs.renameSync(path.join(root, 'solomap.db'), path.join(candidateDir, 'previous-solomap.db'));
  if (['activated', 'complete'].includes(interruptedState)) fs.renameSync(path.join(candidateDir, 'solomap.db'), path.join(root, 'solomap.db'));
  persistDatabaseGenerationCutover(root, { schemaVersion: 1, purpose: 'compact', state: interruptedState, generationId, candidateDir, databaseId, createdAt: Date.now(), candidateProof: proof,
    result: { databaseId, compacted: true, beforeBytes: 100, afterBytes: 50, integrity: 'ok' } });
  assert.equal(recoverPendingDatabaseGenerationCutover(root).purpose, 'compact');
  assert.equal(fs.existsSync(path.join(root, '.solopreneur')), false);
  assert.equal(fs.existsSync(candidateDir), false);
  const reopened = UnifiedDataStore.open(root, databaseId);
  try { assert.equal(reopened.read(receipt.objectId, receipt.revision).data.content, 'original fixed history'); assert.equal(reopened.read(receipt.objectId).data.content, 'latest value'); }
  finally { reopened.close(); }
});

function cleanupExact(root) {
  if (!fs.existsSync(root)) return;
  const directories = [root], files = [];
  const visit = directory => fs.readdirSync(directory).forEach(name => {
    const target = path.join(directory, name), stat = fs.lstatSync(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) { directories.push(target); visit(target); }
    else files.push(target);
  });
  visit(root); files.forEach(file => fs.unlinkSync(file));
  directories.sort((a, b) => b.length - a.length).forEach(directory => fs.rmdirSync(directory));
}

async function launchRuntime(root) {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../out/autonomousRuntimeProcess.js'), '--global-data-path', root], { stdio: 'pipe' });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; }); child.stdout.resume();
  const deadline = Date.now() + 15_000;
  for (;;) {
    assert.equal(child.exitCode, null, stderr);
    assert.ok(Date.now() < deadline, stderr || 'Runtime generation fixture did not become ready');
    try {
      const health = await sendRuntimeControlCommand(root, 'health', { timeoutMs: 1000 });
      if (health.ok && health.status === 'running') break;
    } catch { /* The endpoint file can precede the listening control server. */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return { child, stderr: () => stderr };
}

test('reference queue replay preserves exact source versions across consecutive changesets', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-reference-replay-'));
  t.after(() => cleanupExact(root));
  const active = new UnifiedDataStore(root), candidateDir = path.join(root, 'database-generations', crypto.randomUUID());
  let candidate;
  try {
    await createDatabaseGenerationBaseline(active.filePath, path.join(candidateDir, 'solomap.db'), active.databaseId);
    candidate = UnifiedDataStore.open(candidateDir, active.databaseId);
    active.beginDatabaseGenerationCapture();
    const id = active.putContent(JSON.stringify({ contentId: 'retained-target' }));
    let capture = active.stopDatabaseGenerationCapture();
    candidate.applyDatabaseGenerationChangeset(capture.changeset, capture.searchObjectIds);
    assert.equal(JSON.stringify(candidate.rows('SELECT * FROM content_lifecycle_reference_pending WHERE content_id=?', [id])),
      JSON.stringify(active.rows('SELECT * FROM content_lifecycle_reference_pending WHERE content_id=?', [id])));
    active.beginDatabaseGenerationCapture();
    active.db.run('UPDATE contents SET data=data WHERE id=?', [id]);
    capture = active.stopDatabaseGenerationCapture();
    candidate.applyDatabaseGenerationChangeset(capture.changeset, capture.searchObjectIds);
    assert.equal(JSON.stringify(candidate.rows('SELECT * FROM content_lifecycle_reference_pending WHERE content_id=?', [id])),
      JSON.stringify(active.rows('SELECT * FROM content_lifecycle_reference_pending WHERE content_id=?', [id])));
  } finally { candidate?.close(); active.close(); }
});

test('reference queue replay retains independently prepared candidate contents', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-reference-fork-'));
  t.after(() => cleanupExact(root));
  const active = new UnifiedDataStore(root), candidateDir = path.join(root, 'database-generations', crypto.randomUUID());
  let candidate;
  try {
    await createDatabaseGenerationBaseline(active.filePath, path.join(candidateDir, 'solomap.db'), active.databaseId);
    candidate = UnifiedDataStore.open(candidateDir, active.databaseId);
    const local = candidate.putContent(JSON.stringify({ contentId: 'candidate-retained-target' }));
    active.beginDatabaseGenerationCapture();
    const live = active.putContent(JSON.stringify({ contentId: 'live-retained-target' }));
    const capture = active.stopDatabaseGenerationCapture();
    candidate.applyDatabaseGenerationChangeset(capture.changeset, capture.searchObjectIds);
    assert.equal(candidate.rows('SELECT content_id FROM content_lifecycle_reference_pending WHERE content_id=?', [local]).length, 1);
    assert.equal(candidate.rows('SELECT content_id FROM content_lifecycle_reference_pending WHERE content_id=?', [live]).length, 1);
    active.beginDatabaseGenerationCapture();
    active.db.run('UPDATE contents SET data=data WHERE id=?', [live]);
    const second = active.stopDatabaseGenerationCapture();
    candidate.applyDatabaseGenerationChangeset(second.changeset, second.searchObjectIds);
    assert.equal(candidate.rows('SELECT content_id FROM content_lifecycle_reference_pending WHERE content_id=?', [local]).length, 1);
    for (let index = 0; index < 200; index++) {
      const batch = candidate.prepareStorageReferenceBatch(128); candidate.commitStorageReferenceBatch(batch);
      if (!batch.pending) break;
      assert.ok(index < 199, 'candidate reference index did not converge');
    }
    assert.deepEqual(candidate.rows('SELECT target_id FROM content_lifecycle_edges WHERE source_id=?', [local]).map(row => row.target_id), ['candidate-retained-target']);
    assert.deepEqual(candidate.rows('SELECT target_id FROM content_lifecycle_edges WHERE source_id=?', [live]).map(row => row.target_id), ['live-retained-target']);
  } finally { candidate?.close(); active.close(); }
});

test('a rejected generation changeset rolls back the reference replay guard', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-reference-rollback-'));
  t.after(() => cleanupExact(root));
  const active = new UnifiedDataStore(root), candidateDir = path.join(root, 'database-generations', crypto.randomUUID());
  let candidate;
  try {
    const original = active.putContent('unreferenced source');
    await createDatabaseGenerationBaseline(active.filePath, path.join(candidateDir, 'solomap.db'), active.databaseId);
    candidate = UnifiedDataStore.open(candidateDir, active.databaseId);
    candidate.db.run('DELETE FROM contents WHERE id=?', [original]);
    active.beginDatabaseGenerationCapture();
    active.db.run('DELETE FROM contents WHERE id=?', [original]);
    const capture = active.stopDatabaseGenerationCapture();
    assert.throws(() => candidate.applyDatabaseGenerationChangeset(capture.changeset, capture.searchObjectIds), /database_generation_changeset_table/);
    assert.equal(candidate.rows('SELECT replaying FROM content_lifecycle_replication_guard WHERE id=1')[0].replaying, 0);
    const next = candidate.putContent('another independent candidate body');
    assert.equal(candidate.rows('SELECT content_id FROM content_lifecycle_reference_pending WHERE content_id=?', [next]).length, 1);
  } finally { candidate?.close(); active.close(); }
});

test('an online database generation captures every foreground commit while maintenance builds its baseline', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-capture-'));
  t.after(() => cleanupExact(root));
  const active = new UnifiedDataStore(root);
  const generationId = crypto.randomUUID(), candidateDir = path.join(root, 'database-generations', generationId);
  try {
    active.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'baseline', data: { category: 'inbox', title: 'baseline', status: 'captured', content: 'before' } });
    active.beginDatabaseGenerationCapture();
    const overlap = active.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'overlap', data: { category: 'inbox', title: 'captured in baseline and changeset', status: 'captured', content: 'baselineuniqueterm' } });
    await createDatabaseGenerationBaseline(path.join(root, 'solomap.db'), path.join(candidateDir, 'solomap.db'), active.databaseId);
    active.write({ kind: 'memory', action: 'patch', scope: null, objectId: overlap.objectId, expectedRevision: overlap.revision, idempotencyKey: 'overlap-final', data: { content: 'latestuniqueterm' } });
    active.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'foreground', data: { category: 'inbox', title: 'foreground survives', status: 'captured', content: 'after' } });
    const delta = active.stopDatabaseGenerationCapture();
    const candidate = UnifiedDataStore.open(candidateDir, active.databaseId);
    try {
      assert.equal(candidate.rows("SELECT COUNT(*) AS count FROM memories WHERE title='captured in baseline and changeset'")[0].count, 1);
      assert.equal(candidate.read(overlap.objectId).data.content, 'baselineuniqueterm');
      assert.equal(candidate.search({ scope: null, query: 'baselineuniqueterm' }).items.some(item => item.objectId === overlap.objectId), true);
      assert.equal(candidate.rows("SELECT COUNT(*) AS count FROM memories WHERE title='foreground survives'")[0].count, 0);
      candidate.applyDatabaseGenerationChangeset(delta.changeset, delta.searchObjectIds);
      assert.equal(candidate.rows("SELECT COUNT(*) AS count FROM memories WHERE title='captured in baseline and changeset'")[0].count, 1);
      assert.equal(candidate.read(overlap.objectId).data.content, 'latestuniqueterm');
      assert.equal(candidate.search({ scope: null, query: 'latestuniqueterm' }).items.some(item => item.objectId === overlap.objectId), true,
        'session changesets exclude FTS virtual tables, so the explicit touched-object manifest must rebuild the candidate index');
      assert.equal(candidate.search({ scope: null, query: 'baselineuniqueterm' }).items.some(item => item.objectId === overlap.objectId), false,
        'reindexing must replace stale terms instead of retaining the baseline virtual-table row');
      assert.equal(candidate.rows("SELECT COUNT(*) AS count FROM memories WHERE title='foreground survives'")[0].count, 1);
      assert.equal(candidate.verifyDatabaseGeneration().integrity, 'ok');
    } finally { candidate.close(); }
  } finally { active.close(); }
});

test('generation replay rebases candidate event sequences without dropping concurrent foreground receipts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-event-rebase-'));
  t.after(() => cleanupExact(root));
  const active = new UnifiedDataStore(root);
  const generationId = crypto.randomUUID(), candidateDir = path.join(root, 'database-generations', generationId);
  try {
    active.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'event-rebase-baseline',
      data: { category: 'inbox', title: 'event baseline', status: 'captured', content: 'baseline' } });
    const boundary = active.readRuntimeWriterBarrier().committedSequence;
    active.beginDatabaseGenerationCapture();
    await createDatabaseGenerationBaseline(path.join(root, 'solomap.db'), path.join(candidateDir, 'solomap.db'), active.databaseId);
    const candidate = UnifiedDataStore.open(candidateDir, active.databaseId);
    try {
      const imported = candidate.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'event-rebase-import',
        data: { category: 'inbox', title: 'candidate import', status: 'captured', content: 'candidate' } });
      const foreground = active.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'event-rebase-foreground',
        data: { category: 'inbox', title: 'foreground event', status: 'captured', content: 'foreground' } });
      const liveSequence = active.readRuntimeWriterBarrier().committedSequence;
      const delta = active.stopDatabaseGenerationCapture();
      candidate.applyDatabaseGenerationChangeset(delta.changeset, delta.searchObjectIds, boundary, liveSequence);
      for (const receipt of [imported, foreground]) {
        const event = candidate.rows('SELECT sequence,request_id FROM events WHERE subject_id=? ORDER BY sequence DESC LIMIT 1', [receipt.objectId])[0];
        assert.ok(event, `event for ${receipt.objectId} must survive generation replay`);
        const request = candidate.rows('SELECT committed_sequence FROM requests WHERE id=?', [event.request_id])[0];
        assert.equal(Number(request.committed_sequence), Number(event.sequence));
      }
      const sequences = candidate.rows('SELECT sequence FROM events').map(row => Number(row.sequence));
      assert.equal(new Set(sequences).size, sequences.length);
    } finally { candidate.close(); }
  } finally { active.close(); }
});

test('startup cutover publishes one fully verified generation and reclaims its completed staging directory', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-cutover-'));
  t.after(() => cleanupExact(root));
  const active = new UnifiedDataStore(root);
  const databaseId = active.databaseId, generationId = crypto.randomUUID();
  const candidateDir = path.join(root, 'database-generations', generationId);
  active.beginDatabaseGenerationCapture();
  await createDatabaseGenerationBaseline(path.join(root, 'solomap.db'), path.join(candidateDir, 'solomap.db'), databaseId);
  active.stopDatabaseGenerationCapture();
  active.close();
  const candidate = UnifiedDataStore.open(candidateDir, databaseId);
  candidate.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'candidate-only', data: { category: 'inbox', title: 'candidate active', status: 'captured', content: 'generation' } });
  candidate.close();
  const hidden = path.join(candidateDir, 'project-files', '.solopreneur');
  fs.mkdirSync(hidden, { recursive: true });
  fs.writeFileSync(path.join(hidden, 'project.json'), '{"schemaVersion":1,"projectId":"00000000-0000-4000-8000-000000000001"}\n');
  fs.writeFileSync(path.join(hidden, 'roadmap.csv'), 'id,title,stage,status,agentCli,model,dependencies,parallelGroup\n');
  const target = path.join(root, 'imported-project');
  persistDatabaseGenerationCutover(root, {
    schemaVersion: 1, state: 'ready', generationId, candidateDir, databaseId,
    result: { projectId: '00000000-0000-4000-8000-000000000001', locationId: '00000000-0000-4000-8000-000000000002', identityPath: path.join(target, '.solopreneur', 'project.json'), roadmapPath: path.join(target, '.solopreneur', 'roadmap.csv') },
    hiddenIdentityPath: path.join(hidden, 'project.json'), hiddenRoadmapPath: path.join(hidden, 'roadmap.csv'), createdAt: Date.now(),
    candidateProof: captureDatabaseGenerationProof(path.join(candidateDir, 'solomap.db'))
  });
  const recovered = recoverPendingDatabaseGenerationCutover(root);
  assert.equal(recovered.state, 'complete');
  assert.equal(fs.existsSync(candidateDir), false);
  const activated = UnifiedDataStore.open(root, databaseId);
  try { assert.equal(activated.rows("SELECT COUNT(*) AS count FROM memories WHERE title='candidate active'")[0].count, 1); }
  finally { activated.close(); }
  assert.equal(fs.existsSync(path.join(target, '.solopreneur', 'project.json')), true);
  assert.equal(fs.existsSync(path.join(target, '.solopreneur', 'roadmap.csv')), true);
  const { DiskDatabase } = require('../out/db/diskDatabase.js');
  const originalExec = DiskDatabase.prototype.exec;
  let integrityChecks = 0;
  DiskDatabase.prototype.exec = function(sql) {
    if (/PRAGMA integrity_check/i.test(sql)) integrityChecks += 1;
    return originalExec.call(this, sql);
  };
  try {
    assert.equal(recoverPendingDatabaseGenerationCutover(root), null, 'completed cutover journals leave the startup hot path');
    assert.equal(integrityChecks, 0, 'a completed generation must use its frozen verification proof instead of rescanning the active database');
  } finally { DiskDatabase.prototype.exec = originalExec; }
});

test('cutover does not move the active database when project files cannot be published exactly', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-publish-conflict-'));
  t.after(() => cleanupExact(root));
  const active = new UnifiedDataStore(root);
  const databaseId = active.databaseId, generationId = crypto.randomUUID();
  active.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'active-only', data: { category: 'inbox', title: 'active remains', status: 'captured', content: 'old generation' } });
  active.close();
  const candidateDir = path.join(root, 'database-generations', generationId);
  fs.mkdirSync(candidateDir, { recursive: true });
  fs.copyFileSync(path.join(root, 'solomap.db'), path.join(candidateDir, 'solomap.db'));
  const hidden = path.join(candidateDir, 'project-files', '.solopreneur');
  const target = path.join(root, 'conflicting-project', '.solopreneur');
  fs.mkdirSync(hidden, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(hidden, 'project.json'), '{"schemaVersion":1,"projectId":"00000000-0000-4000-8000-000000000031"}\n');
  fs.writeFileSync(path.join(hidden, 'roadmap.csv'), 'id,title,stage,status,agentCli,model,dependencies,parallelGroup\n');
  fs.writeFileSync(path.join(target, 'project.json'), '{"conflict":true}\n');
  persistDatabaseGenerationCutover(root, {
    schemaVersion: 1, state: 'ready', generationId, candidateDir, databaseId,
    result: { projectId: '00000000-0000-4000-8000-000000000031', locationId: '00000000-0000-4000-8000-000000000032', identityPath: path.join(target, 'project.json'), roadmapPath: path.join(target, 'roadmap.csv') },
    hiddenIdentityPath: path.join(hidden, 'project.json'), hiddenRoadmapPath: path.join(hidden, 'roadmap.csv'), createdAt: Date.now()
  });

  assert.throws(() => recoverPendingDatabaseGenerationCutover(root), /database_generation_target_changed/);
  assert.equal(fs.existsSync(path.join(candidateDir, 'previous-solomap.db')), false);
  const reopened = UnifiedDataStore.open(root, databaseId);
  try { assert.equal(reopened.rows("SELECT COUNT(*) AS count FROM memories WHERE title='active remains'")[0].count, 1); }
  finally { reopened.close(); }
});

test('project file publication rolls back a newly published identity when the roadmap conflicts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-roadmap-conflict-'));
  t.after(() => cleanupExact(root));
  const active = new UnifiedDataStore(root);
  const databaseId = active.databaseId, generationId = crypto.randomUUID();
  active.close();
  const candidateDir = path.join(root, 'database-generations', generationId);
  fs.mkdirSync(candidateDir, { recursive: true });
  fs.copyFileSync(path.join(root, 'solomap.db'), path.join(candidateDir, 'solomap.db'));
  const hidden = path.join(candidateDir, 'project-files', '.solopreneur');
  const target = path.join(root, 'roadmap-conflict-project', '.solopreneur');
  fs.mkdirSync(hidden, { recursive: true }); fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(hidden, 'project.json'), '{"schemaVersion":1,"projectId":"00000000-0000-4000-8000-000000000041"}\n');
  fs.writeFileSync(path.join(hidden, 'roadmap.csv'), 'id,title\n');
  fs.writeFileSync(path.join(target, 'roadmap.csv'), 'conflict\n');
  persistDatabaseGenerationCutover(root, {
    schemaVersion: 1, state: 'ready', generationId, candidateDir, databaseId,
    result: { projectId: '00000000-0000-4000-8000-000000000041', locationId: '00000000-0000-4000-8000-000000000042', identityPath: path.join(target, 'project.json'), roadmapPath: path.join(target, 'roadmap.csv') },
    hiddenIdentityPath: path.join(hidden, 'project.json'), hiddenRoadmapPath: path.join(hidden, 'roadmap.csv'), createdAt: Date.now()
  });
  assert.throws(() => recoverPendingDatabaseGenerationCutover(root), /database_generation_target_changed/);
  assert.equal(fs.existsSync(path.join(target, 'project.json')), false);
  assert.equal(fs.existsSync(path.join(candidateDir, 'previous-solomap.db')), false);
});

test('startup cutover resumes moving the previous generation sidecars after a crash', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-old-sidecars-'));
  t.after(() => cleanupExact(root));
  const active = new UnifiedDataStore(root);
  const databaseId = active.databaseId, generationId = crypto.randomUUID();
  const candidateDir = path.join(root, 'database-generations', generationId);
  fs.mkdirSync(candidateDir, { recursive: true });
  active.close();
  fs.copyFileSync(path.join(root, 'solomap.db'), path.join(candidateDir, 'solomap.db'));
  const hidden = path.join(candidateDir, 'project-files', '.solopreneur');
  fs.mkdirSync(hidden, { recursive: true });
  fs.writeFileSync(path.join(hidden, 'project.json'), '{"schemaVersion":1,"projectId":"00000000-0000-4000-8000-000000000011"}\n');
  fs.writeFileSync(path.join(hidden, 'roadmap.csv'), 'id,title,stage,status,agentCli,model,dependencies,parallelGroup\n');
  const target = path.join(root, 'old-sidecars-project');
  persistDatabaseGenerationCutover(root, {
    schemaVersion: 1, state: 'ready', generationId, candidateDir, databaseId,
    result: { projectId: '00000000-0000-4000-8000-000000000011', locationId: '00000000-0000-4000-8000-000000000012', identityPath: path.join(target, '.solopreneur', 'project.json'), roadmapPath: path.join(target, '.solopreneur', 'roadmap.csv') },
    hiddenIdentityPath: path.join(hidden, 'project.json'), hiddenRoadmapPath: path.join(hidden, 'roadmap.csv'), createdAt: Date.now()
  });
  const previous = path.join(candidateDir, 'previous-solomap.db');
  fs.renameSync(path.join(root, 'solomap.db'), previous);
  fs.writeFileSync(path.join(root, 'solomap.db-wal'), 'old-wal');
  fs.writeFileSync(path.join(root, 'solomap.db-shm'), 'old-shm');

  const recovered = recoverPendingDatabaseGenerationCutover(root);

  assert.equal(recovered.state, 'complete');
  if (fs.existsSync(path.join(root, 'solomap.db-wal'))) assert.notEqual(fs.readFileSync(path.join(root, 'solomap.db-wal'), 'utf8'), 'old-wal');
  if (fs.existsSync(path.join(root, 'solomap.db-shm'))) assert.notEqual(fs.readFileSync(path.join(root, 'solomap.db-shm'), 'utf8'), 'old-shm');
  assert.equal(fs.existsSync(candidateDir), false, 'the verified previous database and sidecars must not accumulate');
});

test('startup cutover resumes activating candidate sidecars after a crash', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-new-sidecars-'));
  t.after(() => cleanupExact(root));
  const active = new UnifiedDataStore(root);
  const databaseId = active.databaseId, generationId = crypto.randomUUID();
  const candidateDir = path.join(root, 'database-generations', generationId);
  fs.mkdirSync(candidateDir, { recursive: true });
  active.close();
  fs.copyFileSync(path.join(root, 'solomap.db'), path.join(candidateDir, 'solomap.db'));
  const hidden = path.join(candidateDir, 'project-files', '.solopreneur');
  fs.mkdirSync(hidden, { recursive: true });
  fs.writeFileSync(path.join(hidden, 'project.json'), '{"schemaVersion":1,"projectId":"00000000-0000-4000-8000-000000000021"}\n');
  fs.writeFileSync(path.join(hidden, 'roadmap.csv'), 'id,title,stage,status,agentCli,model,dependencies,parallelGroup\n');
  const target = path.join(root, 'new-sidecars-project');
  persistDatabaseGenerationCutover(root, {
    schemaVersion: 1, state: 'old-moved', generationId, candidateDir, databaseId,
    result: { projectId: '00000000-0000-4000-8000-000000000021', locationId: '00000000-0000-4000-8000-000000000022', identityPath: path.join(target, '.solopreneur', 'project.json'), roadmapPath: path.join(target, '.solopreneur', 'roadmap.csv') },
    hiddenIdentityPath: path.join(hidden, 'project.json'), hiddenRoadmapPath: path.join(hidden, 'roadmap.csv'), createdAt: Date.now()
  });
  fs.renameSync(path.join(root, 'solomap.db'), path.join(candidateDir, 'previous-solomap.db'));
  fs.renameSync(path.join(candidateDir, 'solomap.db'), path.join(root, 'solomap.db'));
  fs.writeFileSync(path.join(candidateDir, 'solomap.db-wal'), 'candidate-wal');
  fs.writeFileSync(path.join(candidateDir, 'solomap.db-shm'), 'candidate-shm');

  const recovered = recoverPendingDatabaseGenerationCutover(root);

  assert.equal(recovered.state, 'complete');
  assert.equal(fs.existsSync(candidateDir), false);
});

test('generation reclaim planning returns an exact read-only physical manifest and never selects the active candidate', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-reclaim-manifest-'));
  t.after(() => cleanupExact(root));
  const activeId = crypto.randomUUID(), completedId = crypto.randomUUID(), orphanId = crypto.randomUUID();
  const make = id => {
    const directory = path.join(root, 'database-generations', id);
    fs.mkdirSync(path.join(directory, 'project-files', '.solopreneur'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'solomap.db'), id);
    return directory;
  };
  const activeDir = make(activeId), completedDir = make(completedId), orphanDir = make(orphanId);
  const journal = (generationId, candidateDir, state) => ({
    schemaVersion: 1, state, generationId, candidateDir, databaseId: 'database-id',
    result: { projectId: crypto.randomUUID(), locationId: crypto.randomUUID(), identityPath: path.join(root, `${generationId}-project`, '.solopreneur', 'project.json'), roadmapPath: path.join(root, `${generationId}-project`, '.solopreneur', 'roadmap.csv') },
    hiddenIdentityPath: path.join(candidateDir, 'project-files', '.solopreneur', 'project.json'),
    hiddenRoadmapPath: path.join(candidateDir, 'project-files', '.solopreneur', 'roadmap.csv'), createdAt: Date.now()
  });
  persistDatabaseGenerationCutover(root, journal(activeId, activeDir, 'ready'));
  fs.writeFileSync(path.join(completedDir, 'cutover-complete.json'), JSON.stringify(journal(completedId, completedDir, 'complete')));

  const manifest = readDatabaseGenerationReclaimManifest(root);

  assert.equal(manifest.activeGenerationId, activeId);
  assert.deepEqual(manifest.entries.map(entry => [entry.generationId, entry.state, entry.reclaimCandidate]), [
    [activeId, 'active', false], [completedId, 'complete', true], [orphanId, 'orphaned', true]
  ].sort((left, right) => left[0].localeCompare(right[0])));
  for (const entry of manifest.entries) {
    assert.equal(entry.safeInventory, true);
    assert.equal(entry.files.some(file => file.path === path.join(entry.directory, 'solomap.db')), true);
    assert.equal(entry.files.every(file => file.path.startsWith(`${entry.directory}${path.sep}`)), true);
    assert.match(entry.files[0].inode, /^\d+$/);
  }
  assert.throws(() => reclaimDatabaseGeneration(root, activeId), /database_generation_reclaim_not_safe/);
  assert.equal(reclaimDatabaseGeneration(root, completedId).files, 2);
  assert.equal(reclaimDatabaseGeneration(root, orphanId).files, 1);
  assert.equal(fs.existsSync(activeDir), true); assert.equal(fs.existsSync(completedDir), false); assert.equal(fs.existsSync(orphanDir), false);
});

test('startup reclaims only manifest-verified orphaned generations left by a hard crash', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-startup-reclaim-'));
  t.after(() => cleanupExact(root));
  const activeId = crypto.randomUUID(), orphanId = crypto.randomUUID();
  const make = id => {
    const directory = path.join(root, 'database-generations', id);
    fs.mkdirSync(path.join(directory, 'changesets'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'solomap.db'), id);
    fs.writeFileSync(path.join(directory, 'changesets', '000000000001.changeset'), 'delta');
    return directory;
  };
  const activeDir = make(activeId), orphanDir = make(orphanId);
  const hidden = path.join(activeDir, 'project-files', '.solopreneur');
  fs.mkdirSync(hidden, { recursive: true });
  persistDatabaseGenerationCutover(root, {
    schemaVersion: 1, state: 'ready', generationId: activeId, candidateDir: activeDir, databaseId: 'database-id',
    result: { projectId: crypto.randomUUID(), locationId: crypto.randomUUID(), identityPath: path.join(root, 'project', '.solopreneur', 'project.json'), roadmapPath: path.join(root, 'project', '.solopreneur', 'roadmap.csv') },
    hiddenIdentityPath: path.join(hidden, 'project.json'), hiddenRoadmapPath: path.join(hidden, 'roadmap.csv'), createdAt: Date.now()
  });

  const reclaimed = reclaimOrphanedDatabaseGenerations(root);

  assert.deepEqual(reclaimed.map(item => item.generationId), [orphanId]);
  assert.equal(fs.existsSync(activeDir), true, 'the cutover journal protects its active generation');
  assert.equal(fs.existsSync(orphanDir), false, 'the exact orphan inventory is reclaimed during startup');
});

for (const failure of ['close', 'capture']) test(`${failure === 'close' ? 'closing a building Runtime generation' : 'a failed Runtime capture cancels the building generation'} settles its job and reclaims its own candidate`, async t => {
  const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-close-'));
  t.after(() => cleanupExact(base));
  const project = path.join(base, 'project');
  fs.mkdirSync(path.join(project, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(project, '.solopreneur', 'roadmap.csv'), 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,Close generation,,,,codex,,Pending,,');
  const source = new UnifiedDataStore(path.join(base, 'source')), operations = createRuntimeDataOperations(source);
  const archive = path.join(base, 'source.json');
  try {
    const accepted = await operations({ operation: 'accept_roadmap_csv', input: { root: project } });
    for (let index = 0; index < 500; index++) source.write({ kind: 'memory', action: 'create', scope: accepted.projectId, idempotencyKey: `close-${index}`, data: { category: 'inbox', title: `close ${index}`, status: 'captured', content: `source ${index}` } });
    await operations({ operation: 'export_project', input: { root: project, destination: archive, idempotencyKey: 'close-export' } });
  } finally { await operations.close(); source.close(); }
  const root = path.join(base, 'target'), target = new UnifiedDataStore(root), databaseId = target.databaseId;
  target.close();
  const domains = await RuntimeDataExecutionDomains.start({ root, databaseId });
  try {
    const importing = domains.operations({ operation: 'import_project', input: { source: archive, root: path.join(base, 'imported'), idempotencyKey: 'close-import' } }).catch(error => error);
    const deadline = Date.now() + 15000;
    let candidate;
    while (Date.now() < deadline) {
      candidate = fs.existsSync(path.join(root, 'database-generations')) && fs.readdirSync(path.join(root, 'database-generations')).map(name => path.join(root, 'database-generations', name)).find(directory => fs.existsSync(path.join(directory, 'project-files', '.solopreneur', 'roadmap.csv')));
      if (candidate) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(candidate, 'close must overlap the actual candidate build');
    if (failure === 'close') await domains.close();
    else {
      fs.renameSync(path.join(candidate, 'changesets'), path.join(candidate, 'changesets-test-held'));
      fs.mkdirSync(path.join(candidate, 'changesets'));
      await domains.operations({ operation: 'write', input: { kind: 'memory', action: 'create', scope: null, idempotencyKey: 'capture-failure-foreground', data: { category: 'inbox', title: 'saved through failed capture', status: 'captured', content: 'foreground survives' } } });
    }
    const error = await importing;
    assert.ok(error instanceof Error);
    if (failure === 'capture') assert.match(error.message, /database_snapshot_changeset_directory_changed|database_generation_interrupted/);
    assert.equal(fs.existsSync(candidate), false, 'close waits for the full generation lifecycle, including candidate cleanup');
    assert.equal(fs.existsSync(path.join(root, 'database-generation-cutover.json')), false);
    if (failure === 'capture') {
      const receipt = await domains.operations({ operation: 'write', input: { kind: 'memory', action: 'create', scope: null, idempotencyKey: 'capture-failure-later-foreground', data: { category: 'inbox', title: 'still usable', status: 'captured', content: 'source remains authoritative' } } });
      assert.ok(receipt.objectId);
    }
    const reopened = UnifiedDataStore.open(root, databaseId);
    try { assert.equal(reopened.verifyDatabaseGeneration().integrity, 'ok'); } finally { reopened.close(); }
  } finally { await domains.close(); }
});

test('generation dispatch preserves session and Pi invocation authorization before receipt replay or new work', async t => {
  const {RuntimeDataExecutionDomains}=require('../out/runtimeDataExecutionDomains.js');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-authority-'));t.after(()=>cleanupExact(root));
  const store=new UnifiedDataStore(root),databaseId=store.databaseId;
  store.finalizeDatabaseCompaction({idempotencyKey:'already-compacted',beforeBytes:0,startedAt:Date.now()});store.close();
  const domains=await RuntimeDataExecutionDomains.start({root,databaseId});
  try{
    for(const input of [{compact:false},{compact:true,idempotencyKey:'already-compacted'},{compact:true,idempotencyKey:'new-work'}]) await assert.rejects(domains.operations({operation:'maintain_database_storage',sessionToken:'expired-session',input}),/mcp_session_expired/);
    await assert.rejects(domains.operations({operation:'import_project',sessionToken:'expired-session',input:{source:path.join(root,'missing.json'),root:path.join(root,'project'),idempotencyKey:'denied-import'}}),/mcp_session_expired/);
    await assert.rejects(domains.operations({operation:'maintain_database_storage',piToolFence:{operationId:'expired-operation',invocationId:'expired-invocation',ownerId:'expired-owner',ownerGeneration:1},input:{compact:true,idempotencyKey:'already-compacted'}}),/pi_owner_fenced/);
    await assert.rejects(domains.operations({operation:'maintain_database_storage',input:{compact:true}}),/idempotency_key_required/);
    assert.equal(fs.existsSync(path.join(root,'database-generations')),false);
  } finally {await domains.close();}
});

test('an admitted generation reaches seal while foreground producers are still continuously submitting commits',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-continuous-'));t.after(()=>cleanupExact(base));
  const root=path.join(base,'.solomap-global'),store=new UnifiedDataStore(root),databaseId=store.databaseId;
  store.db.run('CREATE TABLE owned_scratch(id INTEGER PRIMARY KEY,payload BLOB);INSERT INTO owned_scratch VALUES(1,zeroblob(8388608));DELETE FROM owned_scratch;');store.close();
  const runtime=await launchRuntime(root),exiting=once(runtime.child,'exit'),accepted=[];let producing=true,timer,releaseProducers;
  const startProducers=new Promise(resolve=>{releaseProducers=resolve;});
  const producers=Array.from({length:4},(_,lane)=>(async()=>{
    await startProducers;
    for(let index=0;producing;index++){
      try{
        const receipt=await sendRuntimeDataRequest(root,{operation:'write',input:{kind:'memory',action:'create',scope:null,idempotencyKey:`continuous-${lane}-${index}`,data:{category:'inbox',title:`ongoing ${lane} ${index}`,status:'captured',content:`complete commit ${lane} ${index}`}}});accepted.push(receipt.objectId);
      }catch(error){if(!/database_generation_cutover|runtime_data_domain_exited:writer-actor:75|Invalid Runtime endpoint|ECONNRESET|ECONNREFUSED|Runtime data service is unavailable/.test(String(error.message||error)))throw error;break;}
    }
  })());
  try{
    const compacting=sendRuntimeDataRequest(root,{operation:'maintain_database_storage',input:{compact:true,idempotencyKey:'continuous-compact'}}).catch(error=>error);
    const admissionDeadline=Date.now()+5000;
    while(!fs.existsSync(path.join(root,'database-generations'))){assert.ok(Date.now()<admissionDeadline,'maintenance must first be admitted under the existing foreground reservation policy');await new Promise(resolve=>setTimeout(resolve,1));}
    releaseProducers();
    const outcome=await Promise.race([compacting.then(error=>({error})),new Promise(resolve=>{timer=setTimeout(()=>resolve({timedOut:true}),10000);})]);
    const remainedActive=producing;producing=false;clearTimeout(timer);await Promise.all(producers);await compacting;
    assert.equal(outcome.timedOut,undefined,'generation must reach seal before stopping the foreground producers');assert.ok(remainedActive);assert.ok(accepted.length>4);
    assert.ok(isDatabaseGenerationCutoverError(outcome.error)||/Runtime data service is unavailable|ECONNRESET/.test(String(outcome.error?.message)));
    const [code]=await exiting;assert.equal(code,75,runtime.stderr());recoverPendingDatabaseGenerationCutover(root);
    const reopened=UnifiedDataStore.open(root,databaseId);
    try{for(const id of accepted)assert.match(reopened.read(id).data.content,/complete commit/);assert.equal(reopened.verifyDatabaseGeneration().integrity,'ok');}finally{reopened.close();}
  }finally{producing=false;releaseProducers();clearTimeout(timer);await Promise.allSettled(producers);if(runtime.child.exitCode===null){await sendRuntimeControlCommand(root,'stop').catch(()=>undefined);await exiting;}}
});

test('Runtime compact generation shrinks the database, retains concurrent commits and history, and replays its receipt after restart', async t => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-runtime-compact-'));t.after(()=>cleanupExact(base));
  const root=path.join(base,'.solomap-global'),source=new UnifiedDataStore(root),databaseId=source.databaseId;
  const history=source.write({kind:'memory',action:'create',scope:null,idempotencyKey:'compact-runtime-history',data:{category:'inbox',title:'compact history',status:'captured',content:'complete original bytes'}});
  source.write({kind:'memory',action:'patch',scope:null,objectId:history.objectId,expectedRevision:history.revision,idempotencyKey:'compact-runtime-history-patch',data:{content:'complete latest bytes'}});
  source.db.run('CREATE TABLE owned_compact_scratch(id INTEGER PRIMARY KEY,payload BLOB)');source.db.run('INSERT INTO owned_compact_scratch VALUES(1,zeroblob(16777216))');source.db.run('DELETE FROM owned_compact_scratch');source.close();
  const before=fs.statSync(path.join(root,'solomap.db')).size;
  let runtime=await launchRuntime(root),reader;
  const committed=[];
  try {
    const {DiskDatabase}=require('../out/db/diskDatabase.js');reader=new DiskDatabase(path.join(root,'solomap.db'),{readOnly:true});reader.run('BEGIN');reader.exec('SELECT COUNT(*) FROM events');
    const compacting=sendRuntimeDataRequest(root,{operation:'maintain_database_storage',input:{compact:true,idempotencyKey:'runtime-compact-once'}}).then(()=>assert.fail('compact must activate through restart'),error=>error);
    for(let index=0;index<24;index++){
      let timer;
      try{
        const receipt=await Promise.race([sendRuntimeDataRequest(root,{operation:'write',input:{kind:'memory',action:'create',scope:null,idempotencyKey:`compact-foreground-${index}`,data:{category:'inbox',title:`compact foreground ${index}`,status:'captured',content:`saved foreground ${index}`}}}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('compact blocked foreground write')),4000);})]);
        committed.push(receipt.objectId);
      }catch(error){if(!/database_generation_cutover|Invalid Runtime endpoint|ECONNRESET|ECONNREFUSED/.test(String(error.message||error)))throw error;break;}
      finally{clearTimeout(timer);}
    }
    const error=await compacting;assert.match(error.message,/database_generation_cutover|Runtime data service is unavailable|ECONNRESET/);
    reader.close();reader=undefined;
    const [code]=await once(runtime.child,'exit');assert.equal(code,75,runtime.stderr());assert.ok(committed.length>0);
    runtime=await launchRuntime(root);
    const receipt=await sendRuntimeDataRequest(root,{operation:'maintain_database_storage',input:{compact:true,idempotencyKey:'runtime-compact-once'}});
    assert.equal(receipt.compacted,true);assert.equal(receipt.databaseId,databaseId);
    assert.ok(fs.statSync(path.join(root,'solomap.db')).size<before-15_000_000);
    assert.equal(fs.existsSync(path.join(root,'.solopreneur')),false);
    assert.deepEqual(fs.readdirSync(path.join(root,'database-generations')),[]);
    assert.equal((await sendRuntimeDataRequest(root,{operation:'read',input:{ref:history.objectId,revision:history.revision}})).data.content,'complete original bytes');
    for(const objectId of committed)assert.match((await sendRuntimeDataRequest(root,{operation:'read',input:{ref:objectId}})).data.content,/saved foreground/);
  } finally {
    reader?.close();
    if(runtime.child.exitCode===null){const exited=once(runtime.child,'exit');await sendRuntimeControlCommand(root,'stop').catch(()=>undefined);await exited;}
  }
});

for(const longReader of [false,true])test(`Runtime project import builds a generation off-actor, captures concurrent foreground commits, and activates it on restart (${longReader?'pinned WAL reader':'ordinary readers'})`, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-generation-runtime-e2e-'));
  t.after(() => cleanupExact(base));
  const sourceRoot = path.join(base, 'source-data'), sourceProject = path.join(base, 'source-project');
  const targetRoot = path.join(base, 'target-data', '.solomap-global'), targetProject = path.join(base, 'target-project');
  fs.mkdirSync(path.join(sourceProject, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(sourceProject, '.solopreneur', 'roadmap.csv'), [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '1,Generation import,,,,codex,,Pending,,'
  ].join('\n'));
  const source = new UnifiedDataStore(sourceRoot), sourceOperations = createRuntimeDataOperations(source);
  const archive = path.join(base, 'source.solomap-project.json');
  try {
    await sourceOperations({ operation: 'accept_roadmap_csv', input: { root: sourceProject } });
    source.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'source-marker',
      data: { category: 'inbox', title: 'generation source marker', status: 'captured', content: 'source generation content' } });
    await sourceOperations({ operation: 'export_project', input: { root: sourceProject, destination: archive, idempotencyKey: 'generation-runtime-export' } });
  } finally { await sourceOperations.close(); source.close(); }

  const target = new UnifiedDataStore(targetRoot); const databaseId = target.databaseId; target.close();
  let runtime = await launchRuntime(targetRoot);
  const committed = [];
  let pinnedReader;
  try {
    if(longReader){
      const {DiskDatabase}=require('../out/db/diskDatabase.js');pinnedReader=new DiskDatabase(path.join(targetRoot,'solomap.db'),{readOnly:true});pinnedReader.run('BEGIN');pinnedReader.exec('SELECT COUNT(*) FROM events');
      const seed=await sendRuntimeDataRequest(targetRoot,{operation:'write',input:{kind:'memory',action:'create',scope:null,idempotencyKey:'pinned-reader-seed',data:{category:'inbox',title:'foreground-seed',status:'captured',content:'foreground commit seed'}}});committed.push(seed.objectId);
    }
    const importing = sendRuntimeDataRequest(targetRoot, { operation: 'import_project', input: {
      source: archive, root: targetProject, idempotencyKey: 'generation-runtime-import'
    } }).then(() => assert.fail('generation import must hand off through a Runtime restart'), error => error);
    for (let index = 0; index < 24; index++) {
      try {
        const saving = sendRuntimeDataRequest(targetRoot, { operation: 'write', input: {
          kind: 'memory', action: 'create', scope: null, idempotencyKey: `generation-foreground-${index}`,
          data: { category: 'inbox', title: `foreground-${index}`, status: 'captured', content: `foreground commit ${index}` }
        } });
        let timer,receipt;
        try{receipt=await(longReader?Promise.race([saving,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('foreground write blocked by generation checkpoint')),4000);})]):saving);}
        finally{if(timer)clearTimeout(timer);}
        committed.push(receipt.objectId);
      } catch (error) {
        if (!/database_generation_cutover|Invalid Runtime endpoint|ECONNRESET|ECONNREFUSED/.test(String(error?.message || error))) throw error;
        break;
      }
    }
    const importError = await importing;
    if(pinnedReader){pinnedReader.run('COMMIT');pinnedReader.close();pinnedReader=undefined;}
    assert.match(String(importError.message || importError), /database_generation_cutover|Runtime data service is unavailable|ECONNRESET/);
    const [exitCode] = await once(runtime.child, 'exit');
    assert.equal(exitCode, 75, runtime.stderr());
    assert.ok(committed.length > 0, 'foreground commits must overlap the off-actor generation build');

    runtime = await launchRuntime(targetRoot);
    const replay = await sendRuntimeDataRequest(targetRoot, { operation: 'import_project', input: {
      source: archive, root: targetProject, idempotencyKey: 'generation-runtime-import'
    } });
    assert.ok(replay.projectId);
    assert.equal((await sendRuntimeDataRequest(targetRoot, { operation: 'read_roadmap', input: { root: targetProject } })).nodes.length, 1);
    for (const objectId of committed) {
      const value = await sendRuntimeDataRequest(targetRoot, { operation: 'read', input: { ref: objectId } });
      assert.match(String(value.data.content), /foreground commit/);
    }
    const reopened = UnifiedDataStore.open(targetRoot, databaseId);
    try { assert.equal(reopened.verifyDatabaseGeneration().integrity, 'ok'); }
    finally { reopened.close(); }
  } finally {
    if(pinnedReader){pinnedReader.close();pinnedReader=undefined;}
    if (runtime.child.exitCode === null) {
      const exited = once(runtime.child, 'exit');
      await sendRuntimeControlCommand(targetRoot, 'stop').catch(() => undefined);
      await exited;
    }
  }
});
