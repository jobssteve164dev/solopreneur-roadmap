const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

for(const mode of ['runtime','direct'])for(const operation of ['claim_run','claim_run_terminal_owner','begin_run_delivery'])test(`${mode}: actual ${operation} retains complete metadata without Source decoding or encoding the body`,async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-run-start-control-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store),project=await store.registerProject({root});t.after(async()=>{await operations.close();store.close();});
  const retained='完整启动恢复metadata'.repeat(12000),owner={id:'window',pid:process.pid,birth:''},gone={id:'gone',pid:99999999,birth:'gone'};
  let run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'原提示词',command:'原命令',userMessage:'原用户目标',status:'Running',deliveryOwner:gone,metadata:{retained,interactiveSession:true,terminalName:'SoloMap Agent',terminalDeliveryId:'original-terminal'},idempotencyKey:'original-start-run'}});
  if(operation==='claim_run_terminal_owner')run=await store.claimRun(project.projectId,{executionLogId:1,expectedRevision:run.revision,agentPid:process.pid,processBirth:'',terminalDeliveryId:'original-terminal',idempotencyKey:'already-started'});
  const input={projectId:project.projectId,executionLogId:1,expectedRevision:run.revision,...(operation==='claim_run'?{agentPid:process.pid,processBirth:'',terminalDeliveryId:'original-terminal'}:{generation:run.generation,owner,terminalName:'SoloMap Agent',terminalDeliveryId:'original-terminal'}),...(operation==='begin_run_delivery'?{terminalDeliveryTraceId:'original-trace',terminalDeliveryStartedAt:'2026-11-15T00:00:00.000Z',terminalDeliveryAttempt:1}:{}),idempotencyKey:`typed-${operation}`};
  const put=store.putContent,read=store.content,createHash=crypto.createHash;
  store.putContent=function(value,...args){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source encoded a large start body');return put.call(this,value,...args);};
  store.content=function(id){if(Number(store.rows('SELECT byte_length FROM contents WHERE id=?',[id])[0]?.byte_length)>65536)throw Error('Source decoded a large start body');return read.call(this,id);};
  crypto.createHash=(...args)=>{const hash=createHash(...args),update=hash.update;hash.update=function(value,...options){if((typeof value==='string'?Buffer.byteLength(value):value.byteLength)>65536)throw Error('Source hashed a large start body');return update.call(this,value,...options);};return hash;};
  const wal=()=>{const value=fs.readFileSync(store.filePath+'-wal');return{length:value.length,sha256:createHash('sha256').update(value).digest('hex')};};
  const call=()=>mode==='direct'?store[{"claim_run":"claimRun","claim_run_terminal_owner":"claimRunTerminalOwner","begin_run_delivery":"beginRunDelivery"}[operation]](project.projectId,input):operations({operation,input});
  let first,replay;try{first=await call();const beforeReplay=wal();replay=await call();assert.deepEqual(wal(),beforeReplay,'fixed committed retry must not create durable preparation state or change WAL');}finally{store.putContent=put;store.content=read;crypto.createHash=createHash;}
  assert.deepEqual(replay,first);assert.equal(first.status.retained,retained);
  if(operation==='claim_run'){assert.equal(first.generation,run.generation+1);assert.equal(first.status.deliveryPending,false);assert.ok(first.proof);}
  else{assert.equal(first.status.deliveryOwnerId,owner.id);assert.equal(first.status.terminalDeliveryId,'original-terminal');}
  if(operation==='begin_run_delivery')assert.equal(first.revision,run.revision+2);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
});

test('failure in the final terminal event rolls back the original lease and all terminal metadata',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-run-start-rollback-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  const run=await operations({operation:'prepare_run',input:{root,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'原提示词',command:'原命令',userMessage:'原目标',metadata:{retained:'完整metadata'.repeat(12000)},deliveryOwner:{id:'gone',pid:99999999,birth:'gone'},idempotencyKey:'terminal-rollback-original'}});
  const input={projectId:run.projectId,executionLogId:1,generation:run.generation,expectedRevision:run.revision,owner:{id:'current',pid:process.pid,birth:''},terminalName:'SoloMap Agent',terminalDeliveryId:'delivery',terminalDeliveryTraceId:'trace',terminalDeliveryStartedAt:'2026-11-15T00:00:00.000Z',terminalDeliveryAttempt:1,idempotencyKey:'terminal-rollback'};
  const tables=['objects','requests','events','object_revisions','run_control_revisions'],counts=()=>Object.fromEntries(tables.map(table=>[table,store.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n])),before=counts();
  store.db.run("CREATE TEMP TRIGGER reject_terminal_state BEFORE INSERT ON events WHEN NEW.kind='run.state' BEGIN SELECT RAISE(ABORT,'fixture_terminal_final_failure'); END");
  await assert.rejects(operations({operation:'begin_run_delivery',input}),/fixture_terminal_final_failure/);assert.deepEqual(counts(),before);assert.deepEqual(store.readRunState(run.projectId,1).status,run.status);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);assert.equal(store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_pins')[0].n,0);
  store.db.run('DROP TRIGGER reject_terminal_state');const result=await operations({operation:'begin_run_delivery',input});assert.equal(result.revision,3);assert.equal(result.status.terminalDeliveryId,'delivery');
});
