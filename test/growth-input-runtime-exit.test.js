const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),{once}=require('node:events'),{randomUUID}=require('node:crypto');
const repo=path.resolve(__dirname,'..'),{sendRuntimeControlCommand,sendRuntimeDataRequest}=require('../out/autonomousRuntimeControl.js'),{UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
test('actual Runtime begin SQL failure releases Source staging and its already-built Compute scan before returning',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-growth-input-exit-')),root=path.join(base,'.solomap-global'),project=path.join(base,'project'),events=path.join(base,'exit-events.jsonl'),out=process.env.SOLOMAP_GROWTH_RUNTIME_OUT || path.join(repo,'out'),probe=path.join(__dirname,'fixtures/growth-input-exit-probe.cjs');fs.mkdirSync(path.join(project,'.solopreneur'),{recursive:true});fs.writeFileSync(path.join(project,'.solopreneur/roadmap.csv'),'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n');fs.writeFileSync(path.join(project,'index.js'),'module.exports = 1;\n');const runtimeId=randomUUID(),child=spawn(process.execPath,[path.join(out,'autonomousRuntimeProcess.js'),'--global-data-path',root,'--runtime-id',runtimeId],{env:{...process.env,SOLOMAP_GROWTH_RUNTIME_OUT:out,SOLOMAP_GROWTH_INPUT_EXIT_PROBE:events,NODE_OPTIONS:`${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(probe)}`},stdio:['ignore','pipe','pipe']});let errors='';child.stdout.resume();child.stderr.on('data',value=>{errors+=value;});
  t.after(async()=>{if(child.exitCode!==null)return;const exited=once(child,'exit');try{await sendRuntimeControlCommand(root,'stop');}catch{child.kill();}await exited;});
  const deadline=Date.now()+10000;for(;;){assert.equal(child.exitCode,null,errors);assert.ok(Date.now()<deadline,errors || 'Runtime readiness');try{if((await sendRuntimeControlCommand(root,'health',{timeoutMs:500})).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,20));}
  await assert.rejects(sendRuntimeDataRequest(root,{operation:'refresh_project_growth',input:{root:project,extensionPath:repo,requestId:'actual-begin-failure',scanReason:'exit-proof'}}),/actual_runtime_growth_begin_sql_failure/);assert.equal((await sendRuntimeControlCommand(root,'health')).ok,true);
  const observed=fs.readFileSync(events,'utf8').trim().split('\n').map(value=>JSON.parse(value)),begun=observed.find(value=>value.kind==='begin');assert.ok(begun);t.diagnostic(JSON.stringify(observed));assert.deepEqual(observed.find(value=>value.kind==='compute-scan-created' && value.stageId===begun.stageId),{kind:'compute-scan-created',stageId:begun.stageId});assert.deepEqual(observed.find(value=>value.kind==='source-discarded' && value.stageId===begun.stageId),{kind:'source-discarded',stageId:begun.stageId,headers:0,items:0});assert.deepEqual(observed.find(value=>value.kind==='compute-scan-deleted' && value.stageId===begun.stageId),{kind:'compute-scan-deleted',stageId:begun.stageId,deleted:true,remaining:false});
  assert.equal(begun.requestId, 'actual-begin-failure');
  const owners = observed.filter(value => value.kind === 'source-owner-created' && value.requestId === begun.requestId);
  assert.ok(owners.length > 0, 'the probe must observe preparation for this growth request');
  const reader = new UnifiedDataStore(root, undefined, { readOnly: true });
  try {
    assert.equal(reader.rows('SELECT COUNT(*) AS n FROM growth_snapshots')[0].n, 0);
    for (const { ownerId } of owners) {
      assert.ok(ownerId);
      assert.deepEqual(reader.rows('SELECT id FROM content_lifecycle_prepare_owners WHERE id=?', [ownerId]), []);
      assert.deepEqual(reader.rows('SELECT owner_id FROM content_lifecycle_prepare_pins WHERE owner_id=?', [ownerId]), []);
    }
  } finally { reader.close(); }
});
