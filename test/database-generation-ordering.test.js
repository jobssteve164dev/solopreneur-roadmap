const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {createDatabaseGenerationBaseline}=require('../out/databaseGeneration.js');
const {createFlowTrace}=require('../out/flowStore.js');
const {readProcessBirthMarker}=require('../out/processIdentity.js');
const {createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

test('external run and flow pages continue across generation without repeats or missing entries',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-external-pages-')),projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);
  const source=new UnifiedDataStore(path.join(root,'source')),closeCompute=require('./content-compute-fixture.cjs').attachLazyContentCompute(source);let candidate;
  t.after(async()=>{await closeCompute();candidate?.close();source.close();});
  const project=await source.registerProject({root:projectRoot}),candidateRoot=path.join(root,'candidate');
  await createDatabaseGenerationBaseline(source.filePath,path.join(candidateRoot,'solomap.db'),source.databaseId);candidate=UnifiedDataStore.open(candidateRoot,source.databaseId);
  source.beginDatabaseGenerationCapture();
  const owner={id:'external-pages-owner',pid:process.pid,birth:readProcessBirthMarker(process.pid)};
  for(let index=0;index<120;index++){
    const run=await source.prepareRun(project.projectId,project.locationId,{root:projectRoot,executionLogId:index+1,nodeId:'step',runKind:'step',prompt:'original prompt',command:'readonly',userMessage:'original request',metadata:{interactiveSession:true},idempotencyKey:`external-page-run-${index}`});
    source.reserveRunInputMaterialization(project.projectId,index+1,run.generation);
    const done=await source.checkpointRun(project.projectId,{executionLogId:index+1,generation:run.generation,proof:run.proof,expectedRevision:run.revision,expectedTurnId:run.turnId,action:'complete',outcome:'partial',summary:`result-${index}`,idempotencyKey:`external-page-complete-${index}`});
    if(index<40){
      const scope={executionLogId:index+1,generation:done.generation,expectedRevision:done.revision,expectedTurnId:done.turnId};
      const lease=source.claimRunConsumer(project.projectId,{...scope,owner});
      assert.ok(lease?.token);
      await source.commitRunSettlement(project.projectId,{...scope,token:lease.token,journal:{agentCli:'codex',command:'readonly',output:`original result-${index}`,status:'In Progress'},digest:{schemaVersion:2,runId:run.runId,nodeId:'step',executionLogId:index+1},effects:[{kind:'refresh',payload:{index}}],idempotencyKey:`external-page-settle-${index}`});
    }
    if(index<40)source.writeFlowTrace(project.projectId,{flow:createFlowTrace(projectRoot,`flow-${index}`),expectedRevision:0,idempotencyKey:`external-page-flow-${index}`});
  }
  for(let index=120;index<160;index++)await source.prepareRun(project.projectId,project.locationId,{root:projectRoot,executionLogId:index+1,nodeId:'step',runKind:'step',prompt:'pending delivery',command:'readonly',userMessage:'start',metadata:{interactiveSession:true},idempotencyKey:`external-page-run-${index}`});
  source.db.run('UPDATE run_control SET delivery_pending=1,recovery_needed=1');
  const capture=source.stopDatabaseGenerationCapture();candidate.applyDatabaseGenerationChangeset(capture.changeset,capture.searchObjectIds);
  const readers={
    runs:(store,cursor)=>store.listRunStates({projectId:project.projectId,cursor,limit:15}),
    consumers:(store,cursor)=>store.listRunStates({projectId:project.projectId,cursor,limit:15,pendingConsumer:true}),
    settlements:(store,cursor)=>store.readRunSettlements(project.projectId,{cursor,limit:15}),
    effects:(store,cursor)=>store.listRunEffects({projectId:project.projectId,cursor,limit:15}),
    flows:(store,cursor)=>store.listFlowTraces(project.projectId,{cursor,limit:15}),
    recovery:(store,cursor)=>store.recoverableRunStates(cursor),
    deliveries:(store,cursor)=>store.listRunDeliveries({projectId:project.projectId,cursor,limit:15}),
    inputs:(store,cursor)=>store.listRunInputMaterializations(cursor)
  };
  for(const [name,read] of Object.entries(readers))await t.test(name,()=>{
    const prefix=read(source,0);assert.notEqual(prefix.nextCursor,null,`${name} must span multiple real pages`);
    assert.deepEqual(read(candidate,prefix.nextCursor),read(source,prefix.nextCursor));
    const all=store=>{let cursor=0,items=[];do{const page=read(store,cursor);items.push(...page.items);cursor=page.nextCursor;}while(cursor!==null);return items;};
    assert.deepEqual(all(candidate),all(source));
  });
});

test('launch latest and failure retention keep their original order across generation and later additions',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-launch-order-')),projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);
  const source=new UnifiedDataStore(path.join(root,'source'));let candidate;t.after(()=>{candidate?.close();source.close();});
  const project=await source.registerProject({root:projectRoot}),candidateRoot=path.join(root,'candidate');
  await createDatabaseGenerationBaseline(source.filePath,path.join(candidateRoot,'solomap.db'),source.databaseId);candidate=UnifiedDataStore.open(candidateRoot,source.databaseId);
  const origin={key:'session:launch-order',source:'agent',chatId:'',generation:0};
  const fail=(store,index)=>{const tracking=store.conversationTracking(),reserved=tracking.reserve(project.projectId,project.projectId,origin,{mode:'solo',message:`title-${index}`,idempotencyKey:`launch-${index}`});tracking.settleDispatch(reserved.dispatchToken,reserved.launch.ref,'failed start');return reserved.launch.ref;};
  source.beginDatabaseGenerationCapture();for(let index=0;index<40;index++)fail(source,index);
  const capture=source.stopDatabaseGenerationCapture();candidate.applyDatabaseGenerationChangeset(capture.changeset,capture.searchObjectIds);
  assert.deepEqual(candidate.conversationTracking().query(origin,{}),source.conversationTracking().query(origin,{}));
  assert.equal(candidate.rows('SELECT COUNT(*) AS n FROM mcp_conversation_launches')[0].n,20);
  const oldest=source.rows('SELECT ref FROM mcp_conversation_launches ORDER BY launch_sequence LIMIT 1')[0].ref;
  for(const store of [source,candidate])fail(store,40);
  assert.deepEqual(candidate.conversationTracking().query(origin,{}).latest.map(item=>item.title),source.conversationTracking().query(origin,{}).latest.map(item=>item.title));
  assert.equal(candidate.rows('SELECT COUNT(*) AS n FROM mcp_conversation_launches')[0].n,20);
  assert.equal(candidate.rows('SELECT ref FROM mcp_conversation_launches WHERE ref=?',[oldest]).length,0);
});

test('an adopted historical turn retains its original latest report across generation',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-report-order-')),projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);
  const source=new UnifiedDataStore(path.join(root,'source')),closeCompute=require('./content-compute-fixture.cjs').attachLazyContentCompute(source);let candidate;t.after(async()=>{await closeCompute();candidate?.close();source.close();});
  const project=await source.registerProject({root:projectRoot}),candidateRoot=path.join(root,'candidate');
  await createDatabaseGenerationBaseline(source.filePath,path.join(candidateRoot,'solomap.db'),source.databaseId);candidate=UnifiedDataStore.open(candidateRoot,source.databaseId);
  source.beginDatabaseGenerationCapture();
  const run=await source.prepareRun(project.projectId,project.locationId,{root:projectRoot,executionLogId:1,nodeId:'step',runKind:'step',prompt:'original prompt',command:'readonly',userMessage:'original request',metadata:{interactiveSession:true},idempotencyKey:'report-order-run'});
  const done=await source.checkpointRun(project.projectId,{executionLogId:1,generation:run.generation,proof:run.proof,expectedRevision:run.revision,expectedTurnId:run.turnId,action:'complete',outcome:'partial',summary:'first turn',idempotencyKey:'report-order-complete'});
  const next=await source.checkpointRun(project.projectId,{executionLogId:1,generation:done.generation,proof:run.proof,expectedRevision:done.revision,expectedTurnId:done.turnId,action:'start',message:'next turn',idempotencyKey:'report-order-next'});
  await source.patchRunState(project.projectId,{executionLogId:1,generation:next.generation,expectedRevision:next.revision,patch:{historicalAdopted:true},idempotencyKey:'report-order-adopted'});
  // An adopted legacy journal has its turn but no native control revision for it.
  source.db.run('DELETE FROM run_control_revisions WHERE run_id=? AND current_turn_id=?',[run.runId,run.turnId]);
  let latest;
  for(let index=0;index<40;index++)latest=source.write({kind:'report',action:'create',scope:project.projectId,idempotencyKey:`historical-report-${index}`,data:{run_id:run.runId,turn_id:run.turnId,schema_version:1,availability:'recorded',content:{schemaVersion:1,summary:`report-${index}`}}});
  assert.equal(source.resolveRunConversationTurn(project.projectId,1).state.status.taskReportObjectId,latest.objectId);
  const capture=source.stopDatabaseGenerationCapture();candidate.applyDatabaseGenerationChangeset(capture.changeset,capture.searchObjectIds);
  assert.deepEqual(candidate.resolveRunConversationTurn(project.projectId,1),source.resolveRunConversationTurn(project.projectId,1));
});

for(const replay of [false,true])test(`normal portable import ${replay?'with concurrent Native tail ':''}does not collide with another project in global run pages`,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-generation-import-orders-'));
  const stores=[],operations=[],projects=[];t.after(async()=>{for(const close of operations)await close.close();for(const store of stores)store.close();});
  const owner={id:'portable-order-owner',pid:process.pid,birth:readProcessBirthMarker(process.pid)};
  for(const name of ['source','target']){
    const projectRoot=path.join(root,`${name}-project`);fs.mkdirSync(path.join(projectRoot,'.solopreneur'),{recursive:true});
    fs.writeFileSync(path.join(projectRoot,'.solopreneur','roadmap.csv'),'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,Step,,Implementation,,codex,,Pending,,');
    const store=new UnifiedDataStore(path.join(root,`${name}-data`)),ops=createRuntimeDataOperations(store);stores.push(store);operations.push(ops);
    await ops({operation:'accept_roadmap_csv',input:{root:projectRoot}});const project=await store.registerProject({root:projectRoot});projects.push({...project,root:projectRoot});
    for(let index=0;index<4;index++){
      const run=await store.prepareRun(project.projectId,project.locationId,{root:projectRoot,executionLogId:index+1,nodeId:'step',runKind:'step',prompt:'original prompt',command:'readonly',userMessage:'original request',metadata:{interactiveSession:true},idempotencyKey:`import-order-run-${index}`});
      store.reserveRunInputMaterialization(project.projectId,index+1,run.generation);
      const done=await store.checkpointRun(project.projectId,{executionLogId:index+1,generation:run.generation,proof:run.proof,expectedRevision:run.revision,expectedTurnId:run.turnId,action:'complete',outcome:'partial',summary:'retained result',idempotencyKey:`import-order-complete-${index}`});
      if(index<2){
        const scope={executionLogId:index+1,generation:done.generation,expectedRevision:done.revision,expectedTurnId:done.turnId};
        const lease=store.claimRunConsumer(project.projectId,{...scope,owner});assert.ok(lease?.token);
        await store.commitRunSettlement(project.projectId,{...scope,token:lease.token,journal:{agentCli:'codex',command:'readonly',output:'retained result',status:'In Progress'},digest:{schemaVersion:2,runId:run.runId,nodeId:'step',executionLogId:index+1},effects:[{kind:'refresh',payload:{index}},{kind:'roadmap',payload:{index}}],idempotencyKey:`import-order-settle-${index}`});
      }
    }
  }
  const sourceInput=stores[0].listRunInputMaterializations().items.find(entry=>entry.executionLogId===1);
  assert.ok(sourceInput);fs.mkdirSync(path.dirname(sourceInput.path),{recursive:true});fs.writeFileSync(sourceInput.path,'original prompt',{flag:'wx'});stores[0].markRunInputWritten(projects[0].projectId,1,sourceInput.generation);
  const source=path.join(root,'project.json');await stores[0].exportProject({root:path.join(root,'source-project'),destination:source,idempotencyKey:'import-order-export'});
  const authority=stores[1],baselineSequence=authority.readRuntimeWriterBarrier().committedSequence;let target=authority;
  if(replay){const candidateRoot=path.join(root,'candidate');await createDatabaseGenerationBaseline(authority.filePath,path.join(candidateRoot,'solomap.db'),authority.databaseId);target=UnifiedDataStore.open(candidateRoot,authority.databaseId);stores.push(target);authority.beginDatabaseGenerationCapture();}
  const imported=await target.importProject({source,root:path.join(root,'imported-project'),idempotencyKey:'import-order-import'},()=>{},replay,authority.root);
  for(const entry of target.listRunInputMaterializations().items.filter(entry=>entry.projectId===imported.projectId))assert.equal(path.dirname(entry.path),path.join(authority.root,'tmp'),'imported temporary registrations must belong to the destination authority');
  assert.ok(target.rows("SELECT written FROM run_input_materializations WHERE project_id=? AND state='active'",[imported.projectId]).every(row=>row.written===0));
  assert.equal(fs.readFileSync(sourceInput.path,'utf8'),'original prompt');
  if(replay){
    const binding={projectId:imported.projectId,sourceHash:target.prepareProjectImport(source).sourceHash,requestKey:'project-import:import-order-import'};
    target.prepareDatabaseGenerationOrderingFloors(binding);
    for(let index=4;index<8;index++){
      const run=await authority.prepareRun(projects[1].projectId,projects[1].locationId,{root:projects[1].root,executionLogId:index+1,nodeId:'step',runKind:'step',prompt:'concurrent prompt',command:'readonly',userMessage:'concurrent request',metadata:{interactiveSession:true},idempotencyKey:`import-order-run-${index}`});
      authority.reserveRunInputMaterialization(projects[1].projectId,index+1,run.generation);
      const done=await authority.checkpointRun(projects[1].projectId,{executionLogId:index+1,generation:run.generation,proof:run.proof,expectedRevision:run.revision,expectedTurnId:run.turnId,action:'complete',outcome:'partial',summary:'concurrent retained result',idempotencyKey:`import-order-complete-${index}`});
      if(index<6){
        const scope={executionLogId:index+1,generation:done.generation,expectedRevision:done.revision,expectedTurnId:done.turnId};
        const lease=authority.claimRunConsumer(projects[1].projectId,{...scope,owner});assert.ok(lease?.token);
        await authority.commitRunSettlement(projects[1].projectId,{...scope,token:lease.token,journal:{agentCli:'codex',command:'readonly',output:'concurrent retained result',status:'In Progress'},digest:{schemaVersion:2,runId:run.runId,nodeId:'step',executionLogId:index+1},effects:[{kind:'refresh',payload:{index}},{kind:'roadmap',payload:{index}}],idempotencyKey:`import-order-settle-${index}`});
      }
    }
    const capture=authority.stopDatabaseGenerationCapture();target.applyDatabaseGenerationChangeset(capture.changeset,capture.searchObjectIds,baselineSequence,authority.readRuntimeWriterBarrier().committedSequence);
    target.finalizeDatabaseGenerationProgress(true,binding,authority.readGlobalRecordOrderHeads());
  }
  const count=target.rows('SELECT COUNT(*) AS n FROM run_control')[0].n;
  const ids=[];let cursor=0;do{const page=target.listRunStates({cursor,limit:1});ids.push(...page.items.map(item=>item.runId));cursor=page.nextCursor;}while(cursor!==null);
  assert.equal(count,replay?12:8);assert.equal(ids.length,count);assert.equal(new Set(ids).size,count);
  const consumers=[];cursor=0;do{const page=target.listRunStates({cursor,limit:1,pendingConsumer:true});consumers.push(...page.items.map(item=>item.runId));cursor=page.nextCursor;}while(cursor!==null);
  assert.equal(consumers.length,replay?6:4);assert.equal(new Set(consumers).size,consumers.length);
  const effects=[];cursor=0;do{const page=target.listRunEffects({cursor,limit:1});effects.push(...page.items.map(item=>item.effectId));cursor=page.nextCursor;}while(cursor!==null);
  assert.equal(effects.length,replay?12:8);assert.equal(new Set(effects).size,effects.length);
  assert.equal(target.listRunInputMaterializations().items.length,replay?12:8);
  const reportVersions=(store,projectId)=>store.rows('SELECT v.object_id,v.revision,v.content_id,v.run_id,v.turn_id FROM report_versions v JOIN objects o ON o.id=v.object_id WHERE o.project_id=? ORDER BY v.object_id,v.revision',[projectId]).map(({content_id,...version})=>({...version,bytes:store.content(content_id).toString('base64')}));
  assert.deepEqual(reportVersions(target,projects[0].projectId),reportVersions(stores[0],projects[0].projectId));
  assert.deepEqual(reportVersions(target,projects[1].projectId),reportVersions(authority,projects[1].projectId));
  assert.ok(target.rows('SELECT ordinal FROM report_versions v JOIN objects o ON o.id=v.object_id WHERE o.project_id=?',[imported.projectId]).every(row=>row.ordinal<0));
  assert.ok(target.rows('SELECT ordinal FROM report_versions v JOIN objects o ON o.id=v.object_id WHERE o.project_id=?',[projects[1].projectId]).every(row=>row.ordinal>0));
  const namespaces=target.rows('SELECT * FROM database_record_order_namespaces WHERE project_id=? ORDER BY table_name',[imported.projectId]);assert.equal(namespaces.length,4);
  assert.ok(namespaces.every(namespace=>namespace.state==='active'));
  assert.throws(()=>target.db.run('UPDATE database_record_order_namespaces SET offset=offset+1,end_sequence=end_sequence+1 WHERE id=?',[namespaces[0].id]),/record_order_active_immutable/);
  const beforeNamespaces=JSON.stringify(namespaces);target.prepareDatabaseGenerationOrderingFloors();target.finalizeDatabaseGenerationProgress(false);
  assert.equal(JSON.stringify(target.rows('SELECT * FROM database_record_order_namespaces WHERE project_id=? ORDER BY table_name',[imported.projectId])),beforeNamespaces);
  if(target!==authority)operations.push({close:require('./content-compute-fixture.cjs').attachLazyContentCompute(target)});
  const next=await target.prepareRun(imported.projectId,imported.locationId,{root:path.join(root,'imported-project'),executionLogId:5,nodeId:'step',runKind:'step',prompt:'new prompt',command:'readonly',userMessage:'new request',idempotencyKey:'after-import-order'});
  assert.ok(target.rows('SELECT run_sequence FROM run_control WHERE run_id=?',[next.runId])[0].run_sequence>Math.max(...namespaces.filter(namespace=>namespace.table_name==='run_control').map(namespace=>namespace.end_sequence)));
  const reexport=path.join(root,'reexport.json');await target.exportProject({root:path.join(root,'imported-project'),destination:reexport,idempotencyKey:'reexport-order'});
  const third=new UnifiedDataStore(path.join(root,'third-data'));stores.push(third);
  await third.importProject({source:reexport,root:path.join(root,'reimported-project'),idempotencyKey:'reimport-order'});
  assert.deepEqual(third.listRunStates({projectId:imported.projectId,limit:100}).items.map(item=>item.runId),target.listRunStates({projectId:imported.projectId,limit:100}).items.map(item=>item.runId));
  assert.deepEqual(reportVersions(third,imported.projectId),reportVersions(target,imported.projectId));
  const thirdOps=createRuntimeDataOperations(third);operations.push(thirdOps);await thirdOps({operation:'recover_run_inputs',input:{}});
  assert.equal(third.listRunInputMaterializations().items.length,0);
  assert.equal(fs.readFileSync(sourceInput.path,'utf8'),'original prompt','recovery after reimport must preserve the original authority file');
});
