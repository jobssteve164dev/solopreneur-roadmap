const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const zlib=require('node:zlib');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');
const {computeRunInputFile}=require('../out/runInputFile.js');
const {createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

async function fixture(t,prompt='完整🌿'.repeat(30000)){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-input-file-boundary-')),projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);
  const store=new UnifiedDataStore(path.join(root,'data')),ops=createRuntimeDataOperations(store);
  let closed=false;const close=async()=>{if(closed)return;closed=true;await ops.close();store.close();};t.after(close);
  const project=await store.registerProject({root:projectRoot});
  const run=await store.prepareRun(project.projectId,project.locationId,{root:projectRoot,executionLogId:1,nodeId:'step',runKind:'agent_review',prompt,command:'readonly',userMessage:'复核',idempotencyKey:'file-boundary'});
  const identity={projectId:project.projectId,executionLogId:1,generation:run.generation};
  store.reserveRunInputMaterialization(project.projectId,1,run.generation);
  const entry=()=>store.readRunInputFileEntry(identity);
  const compute=(action,proof)=>computeRunInputFile(store,{identity,entry:entry(),action,...(proof?{proof}:{} )});
  return {root,store,ops,identity,entry,compute,close};
}

for(const compressed of [false,true])test(`legacy large ${compressed?'gzip':'inline'} prompt preserves a partial file larger than 64 KiB`,async t=>{
  const bytes=Buffer.from('完整🌿'.repeat(30000)),f=await fixture(t,bytes.toString()),entry=f.entry();
  const data=compressed?zlib.gzipSync(bytes):bytes;
  f.store.db.run('UPDATE contents SET encoding=?,data=?,stored_byte_length=?,chunk_index_json=NULL WHERE id=?',[compressed?'gzip:utf8':'utf8',data,data.length,entry.contentId]);
  f.store.assertContentIntegrity(entry.contentId);
  fs.mkdirSync(path.dirname(entry.path),{recursive:true});const prefix=bytes.subarray(0,100003);fs.writeFileSync(entry.path,prefix,{flag:'wx'});
  assert.equal(f.compute('inspect').proof.size,prefix.length);
  await f.ops({operation:'recover_run_inputs',input:{}});
  const observed=f.store.readRunDocument(f.identity.projectId,1,`temporary_observed_${f.identity.generation}`);
  assert.deepEqual(Buffer.from(observed.bytes,'base64'),prefix);assert.equal(fs.existsSync(entry.path),false);
});

test('a registered input replaced immediately before its ownership transfer is preserved',async t=>{
  const f=await fixture(t,'original bytes'),result=f.compute('materialize');
  f.store.beginRunInputFileCleanup(f.identity,result.proof);
  const entry=f.entry(),realRename=fs.renameSync,replacement=Buffer.from('replacement user bytes');let injected=false;
  fs.renameSync=(from,to)=>{
    if(path.basename(from)===path.basename(entry.path) && !injected){
      injected=true;realRename(from,from+'.original');fs.writeFileSync(from,replacement,{flag:'wx'});
    }
    return realRename(from,to);
  };
  try{assert.throws(()=>f.compute('remove',result.proof),/run_input_file_conflict/);}
  finally{fs.renameSync=realRename;}
  assert.equal(injected,true);assert.deepEqual(fs.readFileSync(entry.path),replacement);
  assert.equal(f.entry().state,'active','a conflict cannot acknowledge registration release');
});

test('moving the temporary directory cannot redirect removal into its replacement',async t=>{
  const f=await fixture(t,'original bytes'),result=f.compute('materialize');f.store.beginRunInputFileCleanup(f.identity,result.proof);
  const entry=f.entry(),parent=path.dirname(entry.path),realRename=fs.renameSync;let injected=false;
  fs.renameSync=(from,to)=>{
    if(path.basename(from)===path.basename(entry.path) && !injected){
      injected=true;realRename(parent,parent+'.original');fs.mkdirSync(parent);fs.writeFileSync(entry.path,'replacement directory asset',{flag:'wx'});
    }
    return realRename(from,to);
  };
  try{assert.throws(()=>f.compute('remove',result.proof),/run_input_file_conflict/);}
  finally{fs.renameSync=realRename;}
  assert.equal(injected,true);assert.equal(fs.readFileSync(entry.path,'utf8'),'replacement directory asset');
});

for(const point of ['before-transfer','before-delete','after-delete','after-directory-remove'])test(`run input exit resumes after interruption ${point}`,async t=>{
  const f=await fixture(t),entry=f.entry(),result=f.compute('materialize');
  f.store.markRunInputWritten(f.identity.projectId,1,f.identity.generation);f.store.beginRunInputFileCleanup(f.identity,result.proof);
  const rename=fs.renameSync,unlink=fs.unlinkSync,rmdir=fs.rmdirSync;let injected=false;
  const fail=()=>{injected=true;throw new Error('interrupted_input_exit');};
  fs.renameSync=(from,to)=>{if(point==='before-transfer' && path.basename(from)===path.basename(entry.path))fail();return rename(from,to);};
  fs.unlinkSync=file=>{
    if(path.basename(file)==='input' && !injected){if(point==='before-delete')fail();if(point==='after-delete'){unlink(file);fail();}}
    return unlink(file);
  };
  fs.rmdirSync=directory=>{if(point==='after-directory-remove' && path.basename(directory)===path.basename(entry.path)+'.exit' && !injected){rmdir(directory);fail();}return rmdir(directory);};
  try{assert.throws(()=>f.compute('remove',result.proof),/interrupted_input_exit/);}
  finally{fs.renameSync=rename;fs.unlinkSync=unlink;fs.rmdirSync=rmdir;}
  assert.equal(injected,true);assert.ok(f.entry()?.exitProof);
  await f.ops({operation:'recover_run_inputs',input:{}});
  assert.equal(f.entry().state,'released');assert.equal(fs.existsSync(entry.path),false);assert.equal(fs.existsSync(entry.path+'.exit'),false);
  assert.equal(f.store.rows('SELECT exit_proof_json FROM run_input_materializations')[0].exit_proof_json,null);
});

test('run input creation and removal sync directories before acknowledgement',async t=>{
  const f=await fixture(t),sync=fs.fsyncSync;let count=0;
  fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isDirectory())count++;return sync(fd);};
  try{
    const result=f.compute('materialize');assert.ok(count>0);count=0;
    f.store.beginRunInputFileCleanup(f.identity,result.proof);f.compute('remove',result.proof);assert.ok(count>=3);
  }finally{fs.fsyncSync=sync;}
});

test('materialization retries complete failed file and parent durability steps before acknowledging',async t=>{
  const f=await fixture(t),sync=fs.fsyncSync;let failed=false;
  fs.fsyncSync=fd=>{if(!failed && fs.fstatSync(fd).isFile()){failed=true;throw Object.assign(new Error('injected_sync_failure'),{code:'EIO'});}return sync(fd);};
  try{assert.throws(()=>f.compute('materialize'),/injected_sync_failure/);}finally{fs.fsyncSync=sync;}
  assert.equal(fs.existsSync(f.entry().path),true);assert.equal(f.entry().written,false);
  const synchronized=[];
  fs.fsyncSync=fd=>{synchronized.push(fs.realpathSync(`/proc/self/fd/${fd}`));return sync(fd);};
  try{f.compute('materialize');}finally{fs.fsyncSync=sync;}
  for(const file of [f.entry().path,path.dirname(f.entry().path),f.store.root])assert.ok(synchronized.includes(file),`retry must sync ${file}`);
});

test('an unsupported directory sync returns explicit responsibility and preserves a released exit receipt across restart',async t=>{
  const {RunInputMaterialization}=require('../out/runInputMaterialization.js');
  const f=await fixture(t,'original bytes'),platform=Object.getOwnPropertyDescriptor(process,'platform'),open=fs.openSync;
  const simulate=operation=>{
    Object.defineProperty(process,'platform',{...platform,value:'win32'});
    fs.openSync=(file,...args)=>{
      let directory=false;try{directory=fs.lstatSync(file).isDirectory();}catch(error){if(error.code!=='ENOENT')throw error;}
      if(directory)throw Object.assign(new Error('simulated_directory_open_unsupported'),{code:'EPERM'});
      return open(file,...args);
    };
    try{return operation();}finally{fs.openSync=open;Object.defineProperty(process,'platform',platform);}
  };
  f.store.setRunInputFileCompute(async request=>simulate(()=>computeRunInputFile(f.store,request)));
  const inputs=new RunInputMaterialization(f.store),materialized=await inputs.materialize(f.identity);
  assert.equal(f.compute('inspect').proof.sha256,materialized.sha256);
  const reserve=path.join(f.root,'original-inode');fs.linkSync(materialized.path,reserve);
  await inputs.release(f.identity);
  assert.equal(f.entry().state,'released');assert.ok(f.entry().exitProof);assert.equal(f.store.listRunInputMaterializations().items.length,0);
  await assert.rejects(f.store.computeRunInputFile(f.identity,'materialize'),/run_input_released/);
  await assert.rejects(f.store.computeRunInputFile(f.identity,'prepare_observed'),/run_input_released/);
  await inputs.recover(); // The first slice records this Writer's fixed upper boundary.
  const held=materialized.path+'.exit';fs.mkdirSync(held);fs.linkSync(reserve,path.join(held,'input'));
  let calls=0;f.store.setRunInputFileCompute(async request=>{calls++;return simulate(()=>computeRunInputFile(f.store,request));});
  for(let index=0;index<20;index++)await inputs.recover();
  assert.equal(calls,0,'idle recovery cannot repeatedly scan released receipts in this Writer');assert.ok(fs.existsSync(path.join(held,'input')));
  const publications=f.store.rows('SELECT COUNT(*) AS n FROM run_documents')[0].n;
  await f.close();
  const restarted=new UnifiedDataStore(f.store.root),ops=createRuntimeDataOperations(restarted);t.after(async()=>{await ops.close();restarted.close();});
  await ops({operation:'recover_run_inputs',input:{}});
  assert.equal(fs.existsSync(held),false);assert.equal(restarted.readRunInputFileEntry(f.identity).exitProof,null);
  assert.equal(restarted.rows('SELECT COUNT(*) AS n FROM run_documents')[0].n,publications,'released receipts cannot republish observed evidence');
});

test('released history is scanned at most 128 metadata rows per tick and becomes idle after its fixed upper boundary',async t=>{
  const {RunInputMaterialization}=require('../out/runInputMaterialization.js');
  const f=await fixture(t),entry=f.entry();
  f.store.releaseRunInputMaterialization(f.identity.projectId,1,f.identity.generation);
  for(let generation=2;generation<=260;generation++)f.store.db.run(`INSERT INTO run_input_materializations
    (run_id,project_id,generation,path,sha256,size,evidence_id,input_content_id,written,state,materialization_sequence)
    SELECT run_id,project_id,?,path||?,sha256,size,evidence_id,input_content_id,0,'released',? FROM run_input_materializations WHERE run_id=? AND generation=?`,[generation,`-${generation}`,generation,entry.runId,f.identity.generation]);
  const first=f.store.prepareRunInputReceiptRecoveryBatch();assert.equal(first.length,128);assert.ok(first.every(row=>row.exitProof===null));
  f.store.db.run(`INSERT INTO run_input_materializations
    (run_id,project_id,generation,path,sha256,size,evidence_id,input_content_id,written,state,materialization_sequence,exit_proof_json)
    SELECT run_id,project_id,500,path||'-later',sha256,size,evidence_id,input_content_id,0,'released',500,'later receipt outside the fixed boundary' FROM run_input_materializations WHERE run_id=? AND generation=?`,[entry.runId,f.identity.generation]);
  assert.equal(f.store.prepareRunInputReceiptRecoveryBatch().length,128);assert.equal(f.store.prepareRunInputReceiptRecoveryBatch().length,4);
  let calls=0;f.store.setRunInputFileCompute(()=>{calls++;throw new Error('old released metadata must not cause file IO');});
  const rows=f.store.rows.bind(f.store);let historyQueries=0;
  f.store.rows=(sql,...args)=>{if(sql.includes("state='released'"))historyQueries++;return rows(sql,...args);};
  const inputs=new RunInputMaterialization(f.store);for(let index=0;index<20;index++)await inputs.recover();
  assert.equal(calls,0);assert.equal(historyQueries,0);
});

test('a transient receipt IO failure retries its exact identity and returns to idle without another Writer restart',async t=>{
  const {RunInputMaterialization}=require('../out/runInputMaterialization.js');
  const f=await fixture(t),result=f.compute('materialize');
  f.store.beginRunInputFileCleanup(f.identity,result.proof);f.store.releaseRunInputMaterialization(f.identity.projectId,1,f.identity.generation,true);
  let calls=0;f.store.setRunInputFileCompute(async request=>{
    calls++;if(calls===1)throw Object.assign(new Error('transient_receipt_IO'),{code:'EIO'});
    return computeRunInputFile(f.store,request);
  });
  const inputs=new RunInputMaterialization(f.store);
  await assert.rejects(inputs.recover(),/transient_receipt_IO/);
  assert.equal(calls,1);assert.equal(JSON.parse(f.entry().exitProof).retry,true);assert.equal(fs.existsSync(f.entry().path),true);
  await inputs.recover();assert.equal(calls,3);assert.equal(fs.existsSync(f.entry().path),false);assert.equal(f.entry().exitProof,null);
  const changes=f.store.rows('SELECT total_changes() AS n')[0].n;
  for(let index=0;index<20;index++)await inputs.recover();
  assert.equal(calls,3);assert.equal(f.store.rows('SELECT total_changes() AS n')[0].n,changes);
});

test('a failed retry marker write retains in-process responsibility for the released file',async t=>{
  const {RunInputMaterialization}=require('../out/runInputMaterialization.js');
  const f=await fixture(t),result=f.compute('materialize');
  f.store.beginRunInputFileCleanup(f.identity,result.proof);f.store.releaseRunInputMaterialization(f.identity.projectId,1,f.identity.generation,true);
  let calls=0,failed=false;f.store.setRunInputFileCompute(async request=>{
    calls++;if(calls===1)throw Object.assign(new Error('transient_receipt_IO'),{code:'EIO'});return computeRunInputFile(f.store,request);
  });
  const run=f.store.db.run.bind(f.store.db);
  f.store.db.run=(sql,values)=>{
    if(sql.startsWith('UPDATE run_input_materializations SET exit_proof_json=') && String(values?.[0]).includes('"retry":true') && !failed){failed=true;throw new Error('retry_marker_IOERR');}
    return run(sql,values);
  };
  const inputs=new RunInputMaterialization(f.store);
  try{await assert.rejects(inputs.recover(),/retry_marker_IOERR/);}finally{f.store.db.run=run;}
  assert.equal(failed,true);assert.notEqual(JSON.parse(f.entry().exitProof).retry,true);assert.ok(fs.existsSync(f.entry().path));
  await inputs.recover();assert.equal(calls,3);assert.equal(fs.existsSync(f.entry().path),false);assert.equal(f.entry().exitProof,null);
  for(let index=0;index<20;index++)await inputs.recover();assert.equal(calls,3);
});

for(const released of [false,true])test(`full backup restored into another data root does not inherit ${released?'released':'active'} source file ownership`,async t=>{
  const {RunInputMaterialization}=require('../out/runInputMaterialization.js');
  const f=await fixture(t,'full retained prompt🌿'),source=f.entry(),result=f.compute('materialize');
  f.store.markRunInputWritten(f.identity.projectId,1,f.identity.generation);
  if(released){f.store.beginRunInputFileCleanup(f.identity,result.proof);f.store.releaseRunInputMaterialization(f.identity.projectId,1,f.identity.generation,true);}
  const backup=path.join(f.root,'backup.db');await f.store.backup({destination:backup,idempotencyKey:'backup-input-root'});
  const restoredRoot=path.join(f.root,'restored');await f.store.restoreBackup({source:backup,destinationRoot:restoredRoot,idempotencyKey:'restore-input-root'});
  const restored=UnifiedDataStore.open(restoredRoot,f.store.databaseId),ops=createRuntimeDataOperations(restored);t.after(async()=>{await ops.close();restored.close();});
  if(released){await ops({operation:'recover_run_inputs',input:{}});assert.equal(restored.readRunInputFileEntry(f.identity).exitProof,null);}
  else{
    const inputs=new RunInputMaterialization(restored),materialized=await inputs.materialize(f.identity);
    assert.equal(path.dirname(materialized.path),path.join(restoredRoot,'tmp'));assert.equal(fs.readFileSync(materialized.path,'utf8'),'full retained prompt🌿');
    await inputs.release(f.identity);assert.equal(fs.existsSync(materialized.path),false);
  }
  assert.equal(fs.readFileSync(source.path,'utf8'),'full retained prompt🌿');
});
