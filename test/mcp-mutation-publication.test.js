const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js'),{createRuntimeDataOperations}=require('./runtime-data-fixture.cjs');

async function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-mcp-mutation-')),root=path.join(base,'project');fs.mkdirSync(root);
  const store=new UnifiedDataStore(path.join(base,'data')),operations=createRuntimeDataOperations(store);t.after(async()=>{await operations.close();store.close();});
  const project=await operations({operation:'register_project',input:{root}}),session=await operations({operation:'open_mcp_session',input:{projectId:project.projectId}});
  return{store,operations,project,session};
}

for(const operation of ['write','link'])test(`the actual MCP ${operation} authorizes complete large metadata outside Source`,async t=>{
  const f=await fixture(t),title='完整权限读取元数据🌿'.repeat(10000),create=(key,title)=>f.store.write({kind:'memory',scope:f.project.projectId,action:'create',idempotencyKey:key,data:{category:'inbox',title,status:'captured',content:'完整正文'}}),source=create('mcp-large-source',title),target=create('mcp-large-target','实际目标'),rows=f.store.rows;
  f.store.rows=function(...args){const result=rows.apply(this,args);for(const row of result)for(const value of Object.values(row))if(typeof value==='string' && Buffer.byteLength(value)>65536)throw Error('Source read unbounded authorization metadata');return result;};
  let receipt;
  try{receipt=await f.operations({operation,sessionToken:f.session.sessionToken,input:operation==='write'?{kind:'memory',scope:f.project.projectId,action:'patch',objectId:source.objectId,expectedRevision:1,idempotencyKey:'mcp-large-patch',data:{status:'candidate'}}:{source:source.objectId,relation:'source',target:target.objectId,expectedRevision:1,idempotencyKey:'mcp-large-link'}});}finally{f.store.rows=rows;}
  assert.equal(receipt.revision,2);assert.equal(f.store.readMetadata(source.objectId).data.title,title);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

for(const operation of ['write','link'])test(`the actual MCP ${operation} rechecks a late entity policy change before any business write`,async t=>{
  const f=await fixture(t),create=key=>f.store.write({kind:'memory',scope:f.project.projectId,action:'create',idempotencyKey:key,data:{category:'inbox',title:key,status:'captured',content:'完整原文'}}),source=create('policy-source'),target=create('policy-target'),prepare=f.store.mcpMutationAuthorizationCompute;let changed=false;
  f.store.setMcpMutationAuthorizationCompute(async request=>{const result=await prepare(request);if(!changed){changed=true;f.store.db.run("UPDATE memories SET status='active' WHERE id=?",[source.objectId]);}return result;});
  await assert.rejects(f.operations({operation,sessionToken:f.session.sessionToken,input:operation==='write'?{kind:'memory',scope:f.project.projectId,action:'patch',objectId:source.objectId,expectedRevision:1,idempotencyKey:'late-policy-patch',data:{status:'candidate'}}:{source:source.objectId,relation:'source',target:target.objectId,expectedRevision:1,idempotencyKey:'late-policy-link'}}),/promotion_requires_existing_review/);
  assert.ok(changed);assert.equal(f.store.readMetadata(source.objectId).revision,1);assert.equal(f.store.readMetadata(source.objectId).data.status,'active');assert.deepEqual(f.store.readMetadata(source.objectId).relations,[]);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM requests WHERE idempotency_key IN (?,?)',['late-policy-patch','late-policy-link'])[0].n,0);
});

test('the actual MCP write retains current grant authorization after asynchronous preparation',async t=>{
  const f=await fixture(t),prepare=f.store.mcpMutationAuthorizationCompute;let revoked=false;
  f.store.setMcpMutationAuthorizationCompute(async request=>{const result=await prepare(request);if(!revoked){revoked=true;f.store.db.run("UPDATE grants SET status='revoked' WHERE actor_id=? AND target_id=?",[f.session.authorityActorId,f.project.projectId]);assert.ok(f.store.db.getRowsModified()>0);}return result;});
  await assert.rejects(f.operations({operation:'write',sessionToken:f.session.sessionToken,input:{kind:'memory',scope:f.project.projectId,action:'create',idempotencyKey:'revoked-before-mutation',data:{category:'inbox',title:'等待授权确认',status:'captured',content:'完整正文'}}}),/action_denied/);
  assert.ok(revoked);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM requests WHERE idempotency_key=?',['revoked-before-mutation'])[0].n,0);
});

test('an accepted large MCP write reauthorizes its fixed receipt without changing WAL or creating an owner',async t=>{
  const f=await fixture(t),request={operation:'write',sessionToken:f.session.sessionToken,input:{kind:'memory',scope:f.project.projectId,action:'create',idempotencyKey:'mcp-fixed-large',data:{category:'inbox',title:'完整固定回执',status:'captured',content:'完整MCP原始正文🌿'.repeat(12000)}}},receipt=await f.operations(request),wal=()=>{const bytes=fs.readFileSync(f.store.filePath+'-wal');return{length:bytes.length,sha:crypto.createHash('sha256').update(bytes).digest('hex')};},before=wal();
  assert.deepEqual(await f.operations(request),receipt);assert.deepEqual(wal(),before);assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM content_lifecycle_prepare_owners')[0].n,0);
});

test('an MCP authorization wait preserves the admitted input while another object remains writable',async t=>{
  const f=await fixture(t),prepare=f.store.mcpMutationAuthorizationCompute;let entered,release,paused=false;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);t.after(()=>release());
  f.store.setMcpMutationAuthorizationCompute(async request=>{const result=await prepare(request);if(!paused){paused=true;entered();await gate;}return result;});
  const input={kind:'memory',scope:f.project.projectId,action:'create',idempotencyKey:'mcp-admitted-input',data:{category:'inbox',title:'原始输入',status:'captured',content:'完整正文',metadata_json:{nested:{value:'原始值'}}}},pending=f.operations({operation:'write',sessionToken:f.session.sessionToken,input});void pending.catch(()=>{});
  await ready;input.data.metadata_json.nested.value='后来的变化';assert.equal((await f.operations({operation:'write',input:{kind:'memory',scope:f.project.projectId,action:'create',idempotencyKey:'mcp-independent-progress',data:{category:'inbox',title:'可继续写入',status:'captured',content:'独立正文'}}})).revision,1);release();
  const receipt=await pending;assert.equal(JSON.parse(f.store.readMetadata(receipt.objectId).data.metadata_json).nested.value,'原始值');
});

for(const later of ['write','link'])test(`an MCP authorization wait keeps a later ${later} in the original shared object FIFO`,async t=>{
  const f=await fixture(t),create=key=>f.store.write({kind:'memory',scope:f.project.projectId,action:'create',idempotencyKey:key,data:{category:'inbox',title:key,status:'captured',content:'原始正文'}}),source=create('shared-fifo-source'),target=create('shared-fifo-target'),prepare=f.store.mcpMutationAuthorizationCompute;
  let entered,release,paused=false;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);t.after(()=>release());
  f.store.setMcpMutationAuthorizationCompute(async request=>{const value=await prepare(request);if(!paused && request.intent.input.idempotencyKey==='shared-fifo-first'){paused=true;entered();await gate;}return value;});
  const first=f.operations({operation:'write',sessionToken:f.session.sessionToken,input:{kind:'memory',scope:f.project.projectId,action:'patch',objectId:source.objectId,expectedRevision:1,idempotencyKey:'shared-fifo-first',data:{content:'先接受的完整正文🌿'.repeat(12000)}}});void first.catch(()=>{});await ready;
  const second=f.operations({operation:later,...(later==='link'?{sessionToken:f.session.sessionToken}:{}),input:later==='write'?{kind:'memory',scope:f.project.projectId,action:'patch',objectId:source.objectId,expectedRevision:2,idempotencyKey:'shared-fifo-second',data:{title:'后接受的修改'}}:{source:source.objectId,target:target.objectId,relation:'source',expectedRevision:2,idempotencyKey:'shared-fifo-second'}});void second.catch(()=>{});
  await f.operations({operation:'write',sessionToken:f.session.sessionToken,input:{kind:'memory',scope:f.project.projectId,action:'create',idempotencyKey:'shared-fifo-independent',data:{category:'inbox',title:'继续完成独立写入',status:'captured',content:'独立正文'}}});
  release();assert.equal((await first).revision,2);assert.equal((await second).revision,3);assert.equal(f.store.readMetadata(source.objectId).revision,3);
});

test('an MCP write preserves its actual post-publication error and retries its accepted receipt only when requested',async t=>{
  const f=await fixture(t),source=f.store.write({kind:'memory',scope:f.project.projectId,action:'create',idempotencyKey:'own-publication-source',data:{category:'inbox',title:'原始标题',status:'captured',content:'完整正文'}}),native=f.store.writeMutation,input={kind:'memory',scope:f.project.projectId,action:'patch',objectId:source.objectId,expectedRevision:1,idempotencyKey:'own-publication-error',data:{title:'已接受的新标题'}};let attempts=0;
  f.store.writeMutation=function(value,...args){const receipt=native.call(this,value,...args);if(value.idempotencyKey===input.idempotencyKey && ++attempts===1)throw Error('actual_error_after_native_publication');return receipt;};
  await assert.rejects(f.operations({operation:'write',sessionToken:f.session.sessionToken,input}),/actual_error_after_native_publication/);assert.equal(attempts,1);assert.equal(f.store.readMetadata(source.objectId).revision,2);f.store.writeMutation=native;
  const receipt=await f.operations({operation:'write',sessionToken:f.session.sessionToken,input});assert.equal(receipt.revision,2);assert.equal(f.store.readMetadata(source.objectId).data.title,'已接受的新标题');
});
