const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');
const {createFlowTrace,createFlowLoop}=require('../out/flowStore.js');

for(const mode of ['runtime','direct'])for(const initial of [true,false])test(`${mode}: actual Flow role preparation preserves ${initial?'the complete initial goal':'all retained large loop history'} outside Source`,async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-run-flow-publication-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  const project=await store.registerProject({root}),goal=initial?'完整初始Flow目标'.repeat(9000):'继续原Flow目标',flow=createFlowTrace(root,goal);flow.loops=[createFlowLoop(goal,1)];
  if(!initial){flow.loops[0].planner={status:'pending',data:{completeRetainedHistory:'完整保留的Flow历史'.repeat(14000)}};await operations({operation:'write_flow_trace',input:{root,flow,expectedRevision:0,idempotencyKey:'retained-flow-baseline'}});}
  for(;;){const batch=store.prepareStorageReferenceBatch(128);store.commitStorageReferenceBatch(batch);if(!batch.pending)break;}store.beginContentPreparationRecovery();store.activateStorageContentLifecycle({strictPublication:true});
  const input={root,flowId:flow.flowId,loopId:'loop-1',role:'planner',attempt:0,...(initial?{initialFlow:flow}:{}),prompt:'完整Flow角色任务'.repeat(8000),command:'',userMessage:goal,status:'Preparing',metadata:{launchIntentHash:'same-complete-flow-role'},idempotencyKey:'full-flow-role'};
  const put=store.putContent,read=store.content,createHash=crypto.createHash;
  store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded a large Flow body');return put.call(this,value,...args);};
  store.content=function(id){if(Number(store.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded retained large Flow history');return read.call(this,id);};
  crypto.createHash=(...args)=>{const hash=createHash(...args),update=hash.update;hash.update=function(value,...options){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source hashed a large Flow body');return update.call(this,value,...options);};return hash;};
  let run;try{run=await (mode==='direct'?Promise.resolve().then(()=>store.prepareFlowRole(project.projectId,project.locationId,input)):operations({operation:'prepare_flow_role',input}));}finally{store.putContent=put;store.content=read;crypto.createHash=createHash;}
  const current=store.readFlowTrace(project.projectId,flow.flowId);assert.equal(current.revision,2);assert.equal(current.flow.goal,goal);assert.equal(current.flow.loops[0].planner.executionLogId,run.status.rootExecutionLogId);
  assert.deepEqual(store.readFlowTrace(project.projectId,flow.flowId,1).flow,flow);
  assert.equal(store.read(run.runId,1).data.prompt_content,input.prompt);
  const wal=()=>{const bytes=fs.readFileSync(store.filePath+'-wal');return{length:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};},beforeWal=wal();
  assert.equal((await (mode==='direct'?Promise.resolve().then(()=>store.prepareFlowRole(project.projectId,project.locationId,input)):operations({operation:'prepare_flow_role',input}))).runId,run.runId);
  assert.deepEqual(wal(),beforeWal,'replaying an existing Flow role must not persist another preparation owner');
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('the actual Flow write stages full header, loops and retained task body with fixed history and replay',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-flow-write-publication-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});await store.registerProject({root});
  for(;;){const batch=store.prepareStorageReferenceBatch(128);store.commitStorageReferenceBatch(batch);if(!batch.pending)break;}store.beginContentPreparationRecovery();store.activateStorageContentLifecycle({strictPublication:true});
  const goal='完整Flow用户原始目标'.repeat(9000),flow=createFlowTrace(root,goal);flow.loops=[createFlowLoop(goal,1)];flow.loops[0].planner.data={fullHistory:'完整保留的角色历史'.repeat(14000)};
  const put=store.putContent,read=store.content,createHash=crypto.createHash;
  store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded a large Flow body');return put.call(this,value,...args);};
  store.content=function(id){if(Number(store.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded a large Flow body');return read.call(this,id);};
  crypto.createHash=(...args)=>{const hash=createHash(...args),update=hash.update;hash.update=function(value,...options){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source hashed a large Flow body');return update.call(this,value,...options);};return hash;};
  let first,second,replay;const initial={root,flow,expectedRevision:0,idempotencyKey:'full-flow-write'};
  try{
    first=await operations({operation:'write_flow_trace',input:initial});
    second=await operations({operation:'write_flow_trace',input:{root,flow:{...flow,status:'completed'},expectedRevision:1,idempotencyKey:'close-full-flow-write'}});
    const before=store.rows('SELECT (SELECT COUNT(*) FROM contents) AS contents,(SELECT COUNT(*) FROM events) AS events,(SELECT COUNT(*) FROM requests) AS requests')[0];
    replay=await operations({operation:'write_flow_trace',input:initial});assert.deepEqual(store.rows('SELECT (SELECT COUNT(*) FROM contents) AS contents,(SELECT COUNT(*) FROM events) AS events,(SELECT COUNT(*) FROM requests) AS requests')[0],before);
  }finally{store.putContent=put;store.content=read;crypto.createHash=createHash;}
  assert.deepEqual(first.flow,flow);assert.deepEqual(replay,first);assert.equal(second.revision,2);assert.equal(second.flow.status,'completed');assert.deepEqual(store.readFlowTrace(first.projectId,flow.flowId,1),first);
  assert.equal(store.read(first.taskId).data.original_request_content,goal);assert.equal(store.read(first.taskId).data.status,'completed');
  const headerId=store.rows('SELECT content_id FROM evidence WHERE id=?',[first.objectId])[0].content_id;assert.equal(store.rows('SELECT mime_type FROM contents WHERE id=?',[headerId])[0].mime_type,'text/plain');
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('an actual MCP Flow launch updates its notification state without Source reading complete loop history',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-mcp-flow-notification-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});const project=await store.registerProject({root});
  const tracking=store.conversationTracking(),{launch,dispatchToken}=tracking.reserve(project.projectId,project.projectId,{key:'session:typed-flow-notification',source:'agent',chatId:'',generation:0},{mode:'flow',message:'complete Flow result',idempotencyKey:'mcp-flow-launch',dispatchOwnerId:'fixture'});tracking.finishDispatch(dispatchToken,launch.origin_key);
  const flow=createFlowTrace(root,'complete Flow result');flow.flowId=launch.flow_id;flow.loops=[createFlowLoop(flow.goal,1)];flow.loops[0].planner.data={fullHistory:'完整保留的Flow角色历史'.repeat(18000)};
  const read=store.content;store.content=function(id){if(Number(store.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded complete Flow history while notifying');return read.call(this,id);};
  let result;try{result=await operations({operation:'write_flow_trace',input:{root,flow,expectedRevision:0,idempotencyKey:'notify-complete-flow'}});}finally{store.content=read;}
  assert.deepEqual(result.flow,flow);assert.equal(store.rows('SELECT notified_flow_state FROM mcp_conversation_launches WHERE ref=?',[launch.ref])[0].notified_flow_state,'running');
});

for(const revoked of [false,true])test(`the Flow notification ${revoked?'rechecks changed configuration before enqueue':'preserves a large payload and its original intent hashes outside Source'}`,async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-flow-notification-payload-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});const project=await store.registerProject({root});
  const projectName='完整项目名称'.repeat(revoked?1:16000);
  await operations({operation:'write',input:{kind:'project',action:'patch',scope:null,objectId:project.projectId,expectedRevision:1,idempotencyKey:'notification-project-title',data:{name:projectName}}});
  store.patchHostSettings({namespace:'telegram',ownerScope:'global',idempotencyKey:'notification-configuration',patches:[{key:'enabled',expectedRevision:0,value:true},{key:'chatId',expectedRevision:0,value:'fixture-chat'},{key:'replyGeneration',expectedRevision:0,value:7}]});
  const tracking=store.conversationTracking(),{launch,dispatchToken}=tracking.reserve(project.projectId,project.projectId,{key:'session:flow-payload',source:'telegram',chatId:'fixture-chat',generation:7},{mode:'flow',message:'complete Flow result',idempotencyKey:'mcp-telegram-flow',dispatchOwnerId:'fixture'});tracking.finishDispatch(dispatchToken,launch.origin_key);
  const flow=createFlowTrace(root,'complete Flow result');flow.flowId=launch.flow_id;flow.status='completed';flow.latestSummary='完整交付结果';flow.loops=[createFlowLoop(flow.goal,1)];
  const compute=store.flowTraceCompute,plan=compute.plan;let calls=0;
  compute.plan=async request=>{const value=await plan(request);if(++calls===1 && revoked){const setting=store.readHostSettings({namespace:'telegram',ownerScope:'global'}).items.find(item=>item.key==='enabled');store.patchHostSettings({namespace:'telegram',ownerScope:'global',idempotencyKey:'disable-during-flow-prepare',patches:[{key:'enabled',expectedRevision:setting.revision,value:false}]});}return value;};
  const put=store.putContent,read=store.content,createHash=crypto.createHash;
  store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded a large notification body');return put.call(this,value,...args);};
  store.content=function(id){if(Number(store.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded a large notification body');return read.call(this,id);};
  crypto.createHash=(...args)=>{const hash=createHash(...args),update=hash.update;hash.update=function(value,...options){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source hashed a large notification body');return update.call(this,value,...options);};return hash;};
  let result;try{result=await operations({operation:'write_flow_trace',input:{projectId:project.projectId,flow,expectedRevision:0,idempotencyKey:'flow-with-notification'}});}finally{store.putContent=put;store.content=read;crypto.createHash=createHash;}
  assert.equal(result.flow.status,'completed');assert.equal(store.rows('SELECT notified_flow_state FROM mcp_conversation_launches WHERE ref=?',[launch.ref])[0].notified_flow_state,'completed');
  if(revoked){assert.ok(calls>=2);assert.equal(store.rows('SELECT COUNT(*) AS n FROM notification_deliveries')[0].n,0);}
  else{
    const intentId=`conversation:${launch.ref}:flow:1`,delivery=store.readNotification(intentId),text=`[${projectName}] complete Flow result\n任务已完成\n完整交付结果`,payload={replyGeneration:7,chatId:'fixture-chat',text};assert.deepEqual(delivery.payload,payload);
    const {canonicalJson}=require('../out/contentReferences.js'),hash=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex'),intent={channel:'telegram',intentId,payload};
    assert.equal(store.rows('SELECT original_hash FROM notification_deliveries WHERE intent_id=?',[intentId])[0].original_hash,hash(intent));assert.equal(delivery.messageHash,hash({parseMode:'',text}));
    assert.equal(store.rows('SELECT input_hash FROM requests WHERE idempotency_key=?',[`enqueue:${intentId}`])[0].input_hash,hash({operation:'enqueue_notification',...intent}));
    assert.equal(store.rows("SELECT kind FROM events WHERE subject_id=? ORDER BY sequence LIMIT 1",[delivery.objectId])[0].kind,'evidence.notification');
  }
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

for(const invisible of ['hidden','archived','missing'])test(`a ${invisible} Flow notification does not inspect an unrelated damaged role recovery body`,async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-invisible-flow-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});const project=await store.registerProject({root});
  await store.initializeProjectRegistry({legacyProjects:[{name:'Fixture',path:root}]});
  const tracking=store.conversationTracking(),{launch,dispatchToken}=tracking.reserve(project.projectId,project.projectId,{key:'session:invisible-flow',source:'agent',chatId:'',generation:0},{mode:'flow',message:'complete Flow result',idempotencyKey:'invisible-launch',dispatchOwnerId:'fixture'});tracking.finishDispatch(dispatchToken,launch.origin_key);tracking.fail(launch.ref,'original interrupted launch');
  const flow=createFlowTrace(root,'complete Flow result');flow.flowId=launch.flow_id;flow.loops=[createFlowLoop(flow.goal,1)];flow.loops[0].planner.executionLogId=1;
  const run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:`__flow__::${flow.flowId}::loop-1::planner`,runKind:'flow_planner',prompt:'accepted role',command:'',userMessage:flow.goal,status:'Preparing',idempotencyKey:'accepted-invisible-role'}});
  if(invisible==='hidden'){const registry=store.readProjectRegistry();store.patchProjectRegistry({expectedRevision:registry.revision,hiddenPatches:[{path:root,hidden:true}],idempotencyKey:'hide-invisible-flow'});}
  else if(invisible==='archived'){const object=store.readMetadata(project.projectId);store.write({kind:'project',action:'archive',scope:null,objectId:project.projectId,expectedRevision:object.revision,idempotencyKey:'archive-invisible-flow',data:{}});}
  else fs.renameSync(root,path.join(base,'retained-original-project'));
  const contentId=store.rows('SELECT metadata_content_id FROM run_control WHERE run_id=?',[run.runId])[0].metadata_content_id;store.db.run('UPDATE contents SET data=zeroblob(stored_byte_length) WHERE id=?',[contentId]);
  const result=await operations({operation:'write_flow_trace',input:{projectId:project.projectId,flow,expectedRevision:0,idempotencyKey:'write-invisible-flow'}});
  assert.deepEqual(result.flow,flow);assert.equal(store.rows('SELECT notified_flow_state FROM mcp_conversation_launches WHERE ref=?',[launch.ref])[0].notified_flow_state,'');assert.equal(store.rows('SELECT COUNT(*) AS n FROM notification_deliveries')[0].n,0);
});

test('a running Flow does not verify notification configuration that its state does not consume',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-running-flow-config-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});const project=await store.registerProject({root});
  store.patchHostSettings({namespace:'telegram',ownerScope:'global',idempotencyKey:'unused-notification-config',patches:[{key:'enabled',expectedRevision:0,value:true},{key:'chatId',expectedRevision:0,value:'fixture-chat'},{key:'replyGeneration',expectedRevision:0,value:7}]});
  const tracking=store.conversationTracking(),{launch,dispatchToken}=tracking.reserve(project.projectId,project.projectId,{key:'session:running-flow',source:'telegram',chatId:'fixture-chat',generation:7},{mode:'flow',message:'complete Flow result',idempotencyKey:'running-flow-launch',dispatchOwnerId:'fixture'});tracking.finishDispatch(dispatchToken,launch.origin_key);
  const contentId=store.rows("SELECT content_id FROM settings WHERE namespace='telegram' AND owner_scope='global' AND key='enabled'")[0].content_id;store.db.run('UPDATE contents SET data=zeroblob(stored_byte_length) WHERE id=?',[contentId]);
  const flow=createFlowTrace(root,'complete Flow result');flow.flowId=launch.flow_id;flow.loops=[createFlowLoop(flow.goal,1)];
  const result=await operations({operation:'write_flow_trace',input:{projectId:project.projectId,flow,expectedRevision:0,idempotencyKey:'running-with-unused-config'}});
  assert.deepEqual(result.flow,flow);assert.equal(store.rows('SELECT COUNT(*) AS n FROM notification_deliveries')[0].n,0);
});
