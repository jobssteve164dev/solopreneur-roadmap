const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('./runtime-data-fixture.cjs');

test('run input file IO and partial recovery do not decode the prompt on the Writer',async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-input-compute-')),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  const store=new UnifiedDataStore(path.join(base,'global')),ops=createRuntimeDataOperations(store);
  try{
    const project=await store.registerProject({root:projectRoot}),prompt='完整输入🌿\n'.repeat(60000);
    const run=await store.prepareRun(project.projectId,project.locationId,{root:projectRoot,executionLogId:1,nodeId:'step',runKind:'agent_review',prompt,command:'readonly',userMessage:'复核',idempotencyKey:'input-compute'});
    const identity={projectId:project.projectId,executionLogId:1,generation:run.generation,proof:run.proof};
    const read=store.readRunInputMaterializationBytes.bind(store);
    store.readRunInputMaterializationBytes=()=>{throw new Error('Writer decoded the prompt for file IO');};
    const materialized=await ops({operation:'materialize_run_prompt',input:identity});
    assert.deepEqual(fs.readFileSync(materialized.path),Buffer.from(prompt));
    await ops({operation:'release_run_prompt',input:identity});
    const partial=await store.prepareRun(project.projectId,project.locationId,{root:projectRoot,executionLogId:2,nodeId:'step',runKind:'agent_review',prompt,command:'readonly',userMessage:'复核',idempotencyKey:'input-compute-partial'});
    const entry=store.reserveRunInputMaterialization(project.projectId,2,partial.generation),prefix=Buffer.from(prompt).subarray(0,103);
    fs.writeFileSync(entry.path,prefix,{flag:'wx'});
    await ops({operation:'recover_run_inputs',input:{}});
    store.readRunInputMaterializationBytes=read;
    assert.equal(fs.existsSync(entry.path),false);
    assert.deepEqual(Buffer.from(store.readRunDocument(project.projectId,2,`temporary_observed_${partial.generation}`).bytes,'base64'),prefix);
    assert.equal(store.listRunInputMaterializations().items.length,0);
  }finally{await ops.close();store.close();}
});

test('input recovery uses actual parent and child identities without decoding large run metadata',async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-input-recovery-control-')),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  const store=new UnifiedDataStore(path.join(base,'global')),ops=createRuntimeDataOperations(store),owner=await require('../out/agentRunPreparation.js').getAgentRunDeliveryOwner();
  const retained='完整运行上下文与用户资料🌿'.repeat(18000),entries=[];let restore=()=>{};
  try{
    const project=await store.registerProject({root:projectRoot});let executionLogId=0;
    for(const mode of ['parent','child','birth-mismatch','dead','replaced']){
      executionLogId++;
      let state=await ops({operation:'prepare_run',input:{root:projectRoot,executionLogId,nodeId:'step',runKind:'agent_review',prompt:'完整输入🌿',command:'readonly',userMessage:'保留真实恢复边界',metadata:{retained,agentPid:mode==='parent' || mode==='birth-mismatch'?owner.pid:0,processBirth:mode==='birth-mismatch'?owner.birth+'-mismatch':owner.birth},idempotencyKey:`recovery-control-${mode}`}});
      const proof=state.proof;
      if(mode==='child')state=await ops({operation:'patch_run_state',input:{projectId:project.projectId,executionLogId,generation:state.generation,expectedRevision:state.revision,patch:{agentChildPid:owner.pid,processChildBirth:owner.birth},idempotencyKey:'recovery-live-child'}});
      const identity={projectId:project.projectId,executionLogId,generation:state.generation,proof},file=await ops({operation:'materialize_run_prompt',input:identity});entries.push({identity,file,keep:mode==='parent' || mode==='child'});
      if(mode==='replaced'){
        const replacement=await ops({operation:'claim_run',input:{projectId:project.projectId,executionLogId,expectedRevision:state.revision,agentPid:owner.pid,processBirth:owner.birth,idempotencyKey:'recovery-live-replacement'}}),identity={projectId:project.projectId,executionLogId,generation:replacement.generation,proof:replacement.proof},file=await ops({operation:'materialize_run_prompt',input:identity});entries.push({identity,file,keep:true});
      }
    }
    const metadataIds=new Set(store.rows('SELECT metadata_content_id FROM run_control').map(row=>row.metadata_content_id)),content=store.content;let decoded=0;
    store.content=function(id){if(metadataIds.has(id)){decoded++;throw Error('Source decoded large metadata for input recovery');}return content.call(this,id);};restore=()=>{store.content=content;};
    await ops({operation:'recover_run_inputs',input:{}});restore();
    assert.equal(decoded,0);
    for(const {identity,file,keep} of entries){assert.equal(fs.existsSync(file.path),keep);assert.equal(Boolean(store.readRunInputMaterialization(identity.projectId,identity.executionLogId,identity.generation)),keep);if(keep)assert.equal(fs.readFileSync(file.path,'utf8'),'完整输入🌿');}
    for(const {identity,keep} of entries)if(keep)await ops({operation:'release_run_prompt',input:identity});
    assert.deepEqual(fs.readdirSync(path.join(store.root,'tmp')),[]);
  }finally{restore();await ops.close();store.close();}
});

test('run input cleanup rejects a stale inode proof and preserves a replacement file',async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-input-proof-')),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  const store=new UnifiedDataStore(path.join(base,'global')),ops=createRuntimeDataOperations(store);
  try{
    const project=await store.registerProject({root:projectRoot}),run=await store.prepareRun(project.projectId,project.locationId,{root:projectRoot,executionLogId:1,nodeId:'step',runKind:'agent_review',prompt:'原始输入🌿',command:'readonly',userMessage:'复核',idempotencyKey:'input-proof'});
    const identity={projectId:project.projectId,executionLogId:1,generation:run.generation,proof:run.proof};
    const entry=await ops({operation:'materialize_run_prompt',input:identity}),observed=await store.computeRunInputFile(identity,'inspect');
    fs.renameSync(entry.path,path.join(base,'original-input'));fs.writeFileSync(entry.path,'原始输入🌿',{flag:'wx'});
    await assert.rejects(store.computeRunInputFile(identity,'remove',observed.proof),/run_input_file_conflict/);
    assert.equal(fs.readFileSync(entry.path,'utf8'),'原始输入🌿');assert.ok(store.readRunInputMaterialization(project.projectId,1,run.generation));
  }finally{await ops.close();store.close();}
});

test('registered run input symlinks are preserved and independent materializers share one file',async()=>{
  const {RunInputMaterialization}=require('../out/runInputMaterialization.js');
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-input-links-')),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  const store=new UnifiedDataStore(path.join(base,'global')),ops=createRuntimeDataOperations(store);
  try{
    const project=await store.registerProject({root:projectRoot}),run=await store.prepareRun(project.projectId,project.locationId,{root:projectRoot,executionLogId:1,nodeId:'step',runKind:'agent_review',prompt:'原始输入🌿',command:'readonly',userMessage:'复核',idempotencyKey:'input-links'});
    const identity={projectId:project.projectId,executionLogId:1,generation:run.generation};
    const [first,second]=await Promise.all([new RunInputMaterialization(store).materialize(identity),new RunInputMaterialization(store).materialize(identity)]);assert.deepEqual(first,second);
    await new RunInputMaterialization(store).release(identity);
    const next=await store.prepareRun(project.projectId,project.locationId,{root:projectRoot,executionLogId:2,nodeId:'step',runKind:'agent_review',prompt:'原始输入🌿',command:'readonly',userMessage:'复核',idempotencyKey:'input-linked'});
    const linked=store.reserveRunInputMaterialization(project.projectId,2,next.generation),foreign=path.join(base,'foreign.txt');fs.writeFileSync(foreign,'原始输入🌿');fs.symlinkSync(foreign,linked.path);
    await assert.rejects(new RunInputMaterialization(store).release({projectId:project.projectId,executionLogId:2,generation:next.generation}),/run_input_file_conflict/);
    assert.ok(fs.lstatSync(linked.path).isSymbolicLink());assert.equal(fs.readFileSync(foreign,'utf8'),'原始输入🌿');
  }finally{await ops.close();store.close();}
});

test('an empty partial input is retained as exact evidence before its registration exits',async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-empty-input-')),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  const store=new UnifiedDataStore(path.join(base,'global')),ops=createRuntimeDataOperations(store);
  try{
    const project=await store.registerProject({root:projectRoot}),run=await store.prepareRun(project.projectId,project.locationId,{root:projectRoot,executionLogId:1,nodeId:'step',runKind:'agent_review',prompt:'完整输入🌿',command:'readonly',userMessage:'复核',idempotencyKey:'empty-partial'});
    const entry=store.reserveRunInputMaterialization(project.projectId,1,run.generation);fs.mkdirSync(path.dirname(entry.path),{recursive:true});fs.writeFileSync(entry.path,Buffer.alloc(0),{flag:'wx'});
    await ops({operation:'recover_run_inputs',input:{}});
    assert.equal(fs.existsSync(entry.path),false);assert.equal(store.readRunDocument(project.projectId,1,`temporary_observed_${run.generation}`).totalBytes,0);assert.equal(store.listRunInputMaterializations().items.length,0);
  }finally{await ops.close();store.close();}
});

test('reserving a large run input reuses its published prompt identity without decoding or encoding the body on the Writer',async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-run-input-published-')),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  const store=new UnifiedDataStore(path.join(base,'global')),closeCompute=require('./content-compute-fixture.cjs').attachLazyContentCompute(store);
  try{
    const project=await store.registerProject({root:projectRoot}),prompt='完整原字节🌿'.repeat(60000);
    const prepared=await store.prepareRun(project.projectId,project.locationId,{root:projectRoot,executionLogId:1,nodeId:'step',runKind:'agent_review',prompt,command:'readonly',userMessage:'复核',idempotencyKey:'published-input'});
    const original=store.rows('SELECT r.prompt_content_id,c.sha256,c.byte_length FROM runs r JOIN contents c ON c.id=r.prompt_content_id WHERE r.id=?',[prepared.runId])[0];
    const read=store.content.bind(store),plan=store.readRunExecutionPlan.bind(store);let entry;
    store.content=id=>{assert.notEqual(id,original.prompt_content_id,'reservation must not decode an already-published prompt');return read(id);};
    store.readRunExecutionPlan=()=>{throw new Error('reservation must not reconstruct the complete execution plan');};
    try{entry=store.reserveRunInputMaterialization(project.projectId,1,prepared.generation);}finally{store.content=read;store.readRunExecutionPlan=plan;}
    assert.equal(entry.sha256,original.sha256);assert.equal(entry.size,original.byte_length);
    assert.equal(store.rows('SELECT input_content_id FROM run_input_materializations WHERE run_id=?',[prepared.runId])[0].input_content_id,original.prompt_content_id);
    assert.deepEqual(store.reserveRunInputMaterialization(project.projectId,1,prepared.generation),entry);
    assert.deepEqual(store.readRunInputMaterializationBytes(project.projectId,1,prepared.generation),Buffer.from(prompt));
  }finally{await closeCompute();store.close();}
});

test('review path inputs preserve complete database bytes and clean only registered temporary files across restart', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-review-path-'));
  const root = path.join(base, 'global'); const projectRoot = path.join(base, 'project'); fs.mkdirSync(projectRoot);
  let store = new UnifiedDataStore(root); let ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const project = await store.registerProject({ root: projectRoot });
    const prompt = '完整🌿\n'.repeat(60000);
    const prepared = await store.prepareRun(project.projectId, project.locationId, { root: projectRoot, executionLogId: 1, nodeId: 'step', runKind: 'agent_review', prompt, command: 'readonly', userMessage: '复核', idempotencyKey: 'prepare-temp-review' });
    const identity = { projectId: project.projectId, executionLogId: 1, generation: prepared.generation, proof: prepared.proof };
    const materialized = await call('materialize_run_prompt', identity);
    assert.equal(fs.readFileSync(materialized.path, 'utf8'), prompt);
    assert.ok(materialized.path.startsWith(path.join(root, 'tmp') + path.sep));
    assert.deepEqual(await call('materialize_run_prompt', identity), materialized);
    const unrelated = path.join(root, 'tmp', 'user-owned.txt'); fs.writeFileSync(unrelated, 'keep');
    await assert.rejects(call('release_run_prompt', { ...identity, proof: 'invalid' }), /run_proof_denied/);
    assert.ok(fs.existsSync(materialized.path));
    await ops.close(); store.close(); store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store);
    await call('recover_run_inputs', {});
    assert.equal(fs.existsSync(materialized.path), false);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
    assert.deepEqual(fs.readdirSync(path.join(projectRoot, '.solopreneur')), ['project.json']);
    assert.equal(store.listRunInputMaterializations().items.length, 0);
  } finally { await ops.close(); store.close(); }
});

test('a replacement generation retires the old input without touching its live replacement', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-review-generation-path-'));
  const root = path.join(base, 'global'); const projectRoot = path.join(base, 'project'); fs.mkdirSync(projectRoot);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  try {
    const project = await store.registerProject({ root: projectRoot });
    const prepared = await store.prepareRun(project.projectId, project.locationId, { root: projectRoot, executionLogId: 1, nodeId: 'step', runKind: 'agent_review', prompt: '完整输入', command: 'readonly', userMessage: '复核', idempotencyKey: 'prepare-generations' });
    const old = await ops({ operation: 'materialize_run_prompt', input: { projectId: project.projectId, executionLogId: 1, generation: prepared.generation, proof: prepared.proof } });
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8'); const birth = `proc:${stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19]}`;
    const replacement = await store.claimRun(project.projectId, { executionLogId: 1, expectedRevision: prepared.revision, agentPid: process.pid, processBirth: birth, idempotencyKey: 'replace-old-input-generation' });
    const identity = { projectId: project.projectId, executionLogId: 1, generation: replacement.generation, proof: replacement.proof };
    const next = await ops({ operation: 'materialize_run_prompt', input: identity });
    await ops({ operation: 'recover_run_inputs', input: {} });
    assert.equal(fs.existsSync(old.path), false);
    assert.equal(fs.readFileSync(next.path, 'utf8'), '完整输入');
    await ops({ operation: 'release_run_prompt', input: identity });
    assert.deepEqual(fs.readdirSync(path.join(root, 'tmp')), []);
  } finally { await ops.close(); store.close(); }
});

test('a corrupt registered input cannot prevent another project execution from recovering', async () => {
  const { RunRecovery } = require('../out/runRecovery.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-corrupt-input-recovery-'));
  const root = path.join(base, 'global'); const projectRoot = path.join(base, 'project'); fs.mkdirSync(projectRoot);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store); const recovery = new RunRecovery(store);
  try {
    const project = await store.registerProject({ root: projectRoot });
    const prepared = await store.prepareRun(project.projectId, project.locationId, { root: projectRoot, executionLogId: 1, nodeId: 'step', runKind: 'agent_review', prompt: '完整输入', command: 'readonly', userMessage: '复核', idempotencyKey: 'prepare-conflicting-input' });
    const entry = await ops({ operation: 'materialize_run_prompt', input: { projectId: project.projectId, executionLogId: 1, generation: prepared.generation, proof: prepared.proof } });
    fs.writeFileSync(entry.path, 'outside content that must remain');
    const otherRoot = path.join(base, 'other-project'); fs.mkdirSync(otherRoot);
    const other = await store.registerProject({ root: otherRoot });
    const unfinished = await store.prepareRun(other.projectId, other.locationId, { root: otherRoot, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '待恢复', command: 'unused', userMessage: '目标', idempotencyKey: 'other-unfinished' });
    await store.claimRun(other.projectId, { executionLogId: 1, expectedRevision: unfinished.revision, agentPid: 2147483647, processBirth: 'proc:gone', idempotencyKey: 'other-dead-owner' });
    await assert.rejects(recovery.recover(), /run_input_file_conflict/);
    assert.equal(store.readRunState(other.projectId, 1).status.status, 'Failed');
    assert.equal(fs.readFileSync(entry.path, 'utf8'), 'outside content that must remain');
  } finally { await recovery.close(); await ops.close(); store.close(); }
});

test('a crash during prompt materialization preserves the partial bytes in the database and retires its own unfinished file', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-partial-input-recovery-'));
  const root = path.join(base, 'global'); const projectRoot = path.join(base, 'project'); fs.mkdirSync(projectRoot);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  try {
    const project = await store.registerProject({ root: projectRoot });
    const prepared = await store.prepareRun(project.projectId, project.locationId, { root: projectRoot, executionLogId: 1, nodeId: 'step', runKind: 'agent_review', prompt: '完整输入🌿'.repeat(20000), command: 'readonly', userMessage: '复核', idempotencyKey: 'prepare-partial-input' });
    const entry = store.reserveRunInputMaterialization(project.projectId, 1, prepared.generation);
    fs.mkdirSync(path.dirname(entry.path), { recursive: true });
    const prefix = Buffer.from('完整输入🌿'.repeat(20000)).subarray(0, 103);
    fs.writeFileSync(entry.path, prefix, { flag: 'wx' });
    await ops({ operation: 'recover_run_inputs', input: {} });
    assert.equal(fs.existsSync(entry.path), false);
    const evidence = store.readRunDocument(project.projectId, 1, `temporary_observed_${prepared.generation}`);
    assert.deepEqual(Buffer.from(evidence.bytes, 'base64'), prefix);
    assert.equal(store.listRunInputMaterializations().items.length, 0);
  } finally { await ops.close(); store.close(); }
});
