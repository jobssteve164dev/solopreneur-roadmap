const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { reviewHash } = require('../out/learningReview.js');
const { queryTokens } = require('../out/db/searchIndex.js');

async function semanticHistory(t, failure = false, deferSource = false, sourceOptions = {}) {
 const failPrompt = failure === true || failure === 'prompt' || failure === 'all-targets';
 const f = await fixture(t), sourceRoot = path.join(f.root, 'maintenance'), runId = 'semantic-legacy', run = path.join(sourceRoot,'runs',runId);
 fs.mkdirSync(run,{recursive:true}); const original = '# 用户约束\n保留用户目标。\n', target = '# 用户约束\n保留用户目标。交付后核验。\n';
 fs.mkdirSync(path.join(f.root,'memory'),{recursive:true}); fs.writeFileSync(path.join(f.root,'memory','operating-rules.md'),original);
 const source = {id:'semantic-original',kind:'memory',file:path.join(f.root,'memory','operating-rules.md'),hash:reviewHash(original),content:original};
 if(sourceOptions.projectScoped)source.projectPath=f.project;
 if(sourceOptions.previousVersions)source.previousVersions=sourceOptions.previousVersions;
 const manifest = {schemaVersion:1,runId,globalRoot:f.root,globalPrompt:'保留用户目标。',promptHash:reviewHash('保留用户目标。'),projects:[f.project],sources:[source],memory:[{relativePath:'operating-rules.md',hash:source.hash,content:original}],gaps:[]};
 const lesson = {projectPath:f.project,summary:'交付后核验',appliesWhen:'修改用户功能',doesNotApplyWhen:'纯讨论',doThis:'核验真实结果',avoidThis:'只凭退出码宣称通过',verification:'实际结果可回读',reason:'用户明确要求',evidence:[source.id],status:'candidate'};
 let previousLesson;
 if(sourceOptions.existingLesson){
  previousLesson={schemaVersion:1,id:'lesson-aabb',projectId:f.projectId,projectName:'project',projectPath:f.project,sourceEventIds:[],sourceType:'review',lessonType:'implementation_pattern',summary:'原经验要求',appliesWhen:'原适用条件',doesNotApplyWhen:'原例外条件',doThis:'原动作',avoidThis:'原禁忌',verification:'原核验方法',evidenceRefs:[],confidence:'medium',status:'candidate',promotionTarget:'pattern',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-02T00:00:00Z'};
  lesson.id=previousLesson.id;
  const file=path.join(f.root,'learning','candidates',previousLesson.id+'.json'),content=JSON.stringify(previousLesson);
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);
  manifest.sources.push({id:'original-candidate',kind:'candidate',projectPath:f.project,file,hash:reviewHash(content),content});
 }
 const proposal = {schemaVersion:2,runId,manifestHash:reviewHash(JSON.stringify(manifest)),globalPrompt:{value:'保留用户目标。\n交付后核验。',reason:'用户要求',evidence:[source.id],constraints:[]},memoryChanges:[{path:'operating-rules.md',baseHash:source.hash,before:'保留用户目标。',after:'保留用户目标。交付后核验。',evidence:[source.id],reason:'用户要求'}],lessons:[lesson],processedSources:[],unresolved:[]};
 if(deferSource)proposal.processedSources.push({id:source.id,hash:source.hash,decision:'deferred',reason:'原始证据留待后续核验。'});
 const review = {schemaVersion:1,runId,manifestHash:proposal.manifestHash,proposalHash:reviewHash(JSON.stringify(proposal)),verdict:'pass',summary:'核验原文',provenance:{method:'subagent',parentRunId:runId,childRunId:'independent-semantic-child'},checks:['overall','globalPrompt','memory:0','lesson:0'].map(target=>({target,safe:true,reason:'核验原始要求',evidence:[source.id]}))};
 const proposalFile = path.join(run,'semantic-proposal.json'), checkFile = path.join(run,'semantic-check.json');
 for(const [file,value] of [[path.join(run,'manifest.json'),manifest],[proposalFile,proposal],[checkFile,review],[path.join(run,'result.json'),{proposalFile,checkFile}]]) fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
 let persisted = manifest.globalPrompt;
 const write = fs.writeFileSync;
 let applied;
 try {
  fs.writeFileSync = (file,...args) => {
   if (['memory','all-targets'].includes(failure) && String(file) === path.join(f.root,'memory',`operating-rules.md.${runId}.tmp`)) throw new Error('fixture memory write failed');
   if (['lesson','all-targets'].includes(failure) && String(file).startsWith(path.join(f.root,'learning','candidates') + path.sep)) throw new Error('fixture lesson write failed');
   return write(file,...args);
  };
  applied = await require('./fixtures/legacy-learning-review-apply.cjs').applyLearningReview({manifest,proposal,review,runDir:run,getGlobalPrompt:()=>persisted,setGlobalPrompt:async value=>{if(failPrompt)throw new Error('settings temporarily unavailable');persisted=value;}});
 } finally { fs.writeFileSync = write; }
 assert.equal(applied.status,failure?'partial':'applied','the actual historical producer establishes valid input');
 const originals = new Map(fs.readdirSync(run).filter(n=>fs.statSync(path.join(run,n)).isFile()).map(n=>[n,fs.readFileSync(path.join(run,n))]));
 const importHistory = async key=>{const job=await f.call('import_project_data',{collection:'learning-review',sourceRoot,projectScopes:{[f.project]:f.projectId},idempotencyKey:key});await f.request.waitForMigrations?.();let state;for(let i=0;i<150;i++){state=await f.call('migration_status',{jobId:job.jobId});if(!['queued','running'].includes(state.status))return state;await new Promise(r=>setTimeout(r,10));}assert.fail('history import did not settle');};
 return {...f,nativeProposal:f.proposal,get store(){return f.store;},sourceRoot,run,manifest,proposal,review,original,target,originals,previousLesson,importHistory,get persisted(){return persisted;}};
}
for(const partial of [false,true])test(`actual v2 ${partial?'partial':'applied'} multi-target history is typed without activating its old results`,async t=>{
 const f=await semanticHistory(t,partial), state=await f.importHistory('semantic-import');
 assert.equal(state.status,'completed',JSON.stringify(state.progress));
 const batches=f.store.search({scope:null,kinds:['review_batch']}).items;
 assert.equal(batches.length,1,'valid semantic review must be imported as a formal batch');
 const batch=f.store.read(batches[0].objectId);
 assert.equal(batch.data.proposal_content,JSON.stringify(f.proposal));
 const applications=[...f.store.search({scope:null,kinds:['application']}).items,...f.store.search({scope:f.projectId,kinds:['application']}).items].map(a=>f.store.read(a.objectId));
 assert.equal(applications.length,3,'all prompt, memory and lesson target applications must survive');
 assert.deepEqual(applications.map(a=>f.store.read(a.data.target_object_id).kind).sort(),['lesson','memory','policy']);
 assert.equal(f.store.readGlobalPromptPolicy(),null,'import is historical, never an implicit application');
 const memory=applications.find(a=>f.store.read(a.data.target_object_id).kind==='memory');
 assert.equal(memory.data.before_content,f.original);assert.equal(memory.data.after_content,f.target);assert.equal(memory.data.expected_revision,0);
 for(const [name,bytes] of f.originals)assert.deepEqual(fs.readFileSync(path.join(f.run,name)),bytes);
 const revisions=applications.map(a=>[a.objectId,a.revision]);
 const replay=await f.importHistory('semantic-replay');assert.equal(replay.progress.imported,0);assert.equal(replay.progress.unchanged,state.progress.imported);
 assert.deepEqual(revisions.map(([id])=>[id,f.store.read(id).revision]),revisions);
 await f.restart();assert.deepEqual(applications.map(a=>f.store.read(a.objectId).data.after_content),applications.map(a=>a.data.after_content));
});

for (const failure of ['memory','lesson']) test(`v2 pending ${failure} keeps its target kind and resumes its real database result`, async t => {
 const f = await semanticHistory(t,failure);
 const imported = await f.importHistory('semantic-pending'); assert.equal(imported.status,'completed',JSON.stringify(imported.progress));
 const memoryJob = await f.call('import_project_data',{collection:'memory',sourceRoot:path.join(f.root,'memory'),idempotencyKey:'semantic-current-memory'});
 for(let i=0;i<100;i++) { const state=await f.call('migration_status',{jobId:memoryJob.jobId});if(!['queued','running'].includes(state.status)){assert.equal(state.status,'completed');break;}await new Promise(r=>setTimeout(r,10)); }
 const oldFiles = new Map([...f.originals]);
 const batch = await f.begin('semantic-resume',f.persisted);
 assert.equal(batch.pending.length,1);
 assert.equal(batch.pending[0].targetKind,failure,'a memory/lesson result must not be presented as a prompt');
 const result = f.nativeProposal(batch);
 const applied = await f.apply(batch,result,'semantic-resume-apply');
 const old = f.store.read(batch.pending[0].objectId);
 assert.equal(old.data.status,'resumed'); assert.ok(old.data.applied_revision > 0,'resumed means an actual canonical database version was adopted');
 const target = f.store.read(old.data.target_object_id,old.data.applied_revision);
 assert.equal(target.archivedAt,null,'updating a historical snapshot is not applying a real result');
 assert.equal(target.kind,failure);
 if(failure === 'memory')assert.equal(target.data.content,f.target);
 else { assert.equal(target.data.summary,f.proposal.lessons[0].summary);assert.equal(target.data.do_this,f.proposal.lessons[0].doThis);assert.equal(target.data.status,'candidate');assert.deepEqual(JSON.parse(target.data.semantic_review_json).sourceRef,{objectId:batch.pending[0].legacyTarget.batchId,revision:batch.pending[0].legacyTarget.revision,scope:null}); }
 for(const [file,bytes] of oldFiles)assert.deepEqual(fs.readFileSync(path.join(f.run,file)),bytes);
 assert.equal(fs.readFileSync(path.join(f.root,'memory','operating-rules.md'),'utf8'),failure==='memory'?f.original:f.target,'native recovery never resumes the retired file writer');
 const replay=await f.apply(batch,result,'semantic-resume-apply');assert.equal(replay.policy.revision,applied.policy.revision);
 await f.restart();assert.equal(f.store.read(old.objectId).data.applied_revision,old.data.applied_revision);assert.equal(f.store.read(target.objectId).revision,target.revision);
});

test('saving new default instructions preserves every pending v2 memory target', async t => {
 const f=await semanticHistory(t,'memory');assert.equal((await f.importHistory('v2-save-history')).status,'completed');
 const old=f.store.search({scope:null,kinds:['application']}).items.map(item=>f.store.read(item.objectId)).find(item=>f.store.read(item.data.target_object_id).kind==='memory');
 const before=old.revision;
 await f.call('save_global_prompt',{policy:null,content:'用户的新默认指令。',source:'user',idempotencyKey:'v2-user-save'});
 const current=f.store.read(old.objectId);assert.equal(current.data.status,'partial');assert.equal(current.revision,before);assert.equal(current.data.after_content,f.target);
});

for(const deferred of [false,true])test(`v2 memory recovery ${deferred?'defers a later user edit while delivering the full prompt':'rejects a concurrent edit without partial adoption'}`,async t=>{
 const f=await semanticHistory(t,'memory');assert.equal((await f.importHistory('v2-edited-history')).status,'completed');
 const job=await f.call('import_project_data',{collection:'memory',sourceRoot:path.join(f.root,'memory'),idempotencyKey:'v2-edited-memory'});
 for(let i=0;i<100;i++){const state=await f.call('migration_status',{jobId:job.jobId});if(!['queued','running'].includes(state.status)){assert.equal(state.status,'completed');break;}await new Promise(r=>setTimeout(r,10));}
 const target=f.store.search({scope:null,kinds:['memory']}).items.find(item=>item.data.title==='operating-rules');assert.ok(target);
 let batch;if(!deferred)batch=await f.begin('v2-concurrent',f.persisted);
 f.store.write({kind:'memory',action:'patch',scope:null,objectId:target.objectId,expectedRevision:target.revision,idempotencyKey:'v2-later-user-edit',data:{content:'用户后来确认的新要求。'}});
 if(deferred)batch=await f.begin('v2-deferred',f.persisted);
 const result=f.nativeProposal(batch),beforePolicy=f.store.readGlobalPromptPolicy();
 if(deferred){result.recovery[0].decision='deferred';result.recovery[0].reason='保留用户后来确认的修改，旧目标仍待复核。';await f.apply(batch,result,'v2-deferred-apply');}
 else{await assert.rejects(f.apply(batch,result,'v2-conflicting-apply'),/learning_review_target_revision_conflict/);assert.equal(f.store.readGlobalPromptPolicy().revision,beforePolicy.revision);assert.equal(f.store.read(batch.objectId).data.status,'draft');}
 assert.equal(f.store.read(target.objectId).data.content,'用户后来确认的新要求。');assert.equal(f.store.read(batch.pending[0].objectId).data.status,'partial');
 assert.equal(f.store.read(batch.pending[0].objectId).data.after_content,f.target);
});

for (const corruption of ['outside-reference','review-hash','memory-hash','unknown-target','missing-item','before-snapshot']) test(`v2 invalid ${corruption} retains every byte without a half imported batch`,async t=>{
 const f=await semanticHistory(t);
 const mutate=(name,change)=>{const file=path.join(f.run,name),value=JSON.parse(fs.readFileSync(file,'utf8'));change(value);fs.writeFileSync(file,JSON.stringify(value));};
 if(corruption==='outside-reference')mutate('result.json',value=>{value.proposalFile=path.join(f.base,'outside','semantic-proposal.json');});
 if(corruption==='review-hash')mutate('semantic-check.json',value=>{value.proposalHash='0'.repeat(64);});
 if(corruption==='memory-hash')mutate('application.json',value=>{value.items['memory:operating-rules.md']='0'.repeat(64);});
 if(corruption==='unknown-target')mutate('application.json',value=>{value.items['memory:outside.md']='0'.repeat(64);});
 if(corruption==='missing-item')mutate('application.json',value=>{delete value.items['lesson:0'];});
 if(corruption==='before-snapshot')mutate('before-application.json',value=>{value.memory[0].content='被替换的旧内容。';});
 const bytes=new Map(fs.readdirSync(f.run).map(name=>[name,fs.readFileSync(path.join(f.run,name))]));
 const imported=await f.importHistory('v2-corrupt');assert.equal(imported.status,'completed_with_conflicts');
 assert.equal(f.store.search({scope:null,kinds:['review_batch','application']}).items.length,0);
 assert.equal(f.store.search({scope:f.projectId,kinds:['application']}).items.length,0);
 for(const [name,original]of bytes){assert.deepEqual(fs.readFileSync(path.join(f.run,name)),original);const captured=f.store.readMigrationSource(`learning-review:${f.sourceRoot}`,`runs/semantic-legacy/${name}`);assert.deepEqual(captured.bytes,original);}
});

test('v2 hash-only deferred cursor restores its full fixed original manifest source',async t=>{
 const f=await semanticHistory(t,false,true),file=path.join(f.sourceRoot,'review-state.json'),original=fs.readFileSync(file);
 const cursor=JSON.parse(original);assert.equal(cursor.deferredSources.length,1);assert.equal(cursor.deferredSources[0].content,undefined,'the actual v2 producer only saved an identity/hash');
 const imported=await f.importHistory('v2-deferred-cursor');assert.equal(imported.status,'completed',JSON.stringify(imported.progress));
 const batch=await f.begin('v2-deferred-review',f.persisted),source=batch.manifest.sources.find(item=>item.id===f.manifest.sources[0].id);
 assert.ok(source,'deferred original evidence must not disappear with the old file reader');assert.equal(source.content,f.original);assert.equal(source.hash,f.manifest.sources[0].hash);
 assert.deepEqual(fs.readFileSync(file),original);assert.deepEqual(f.store.readMigrationSource(`learning-review:${f.sourceRoot}`,'review-state.json').bytes,original);
 await f.restart();const restored=f.store.read(batch.objectId);assert.ok(restored.data.review_content.includes(source.id));
});

test('v2 hash-only cursor pins the original input across later import and indexed replay',async t=>{
 const prior={id:'semantic-original',kind:'memory',hash:reviewHash('更早原文。'),content:'更早原文。'};
 const f=await semanticHistory(t,false,true,{previousVersions:[prior]}),identity=`learning-review:${f.sourceRoot}`;
 assert.equal((await f.importHistory('v2-fixed-cursor')).status,'completed');
 const pinned=f.store.rows('SELECT * FROM legacy_learning_review_cursor_inputs');assert.equal(pinned.length,1);
 const objects=f.store.rows('SELECT COUNT(*) AS n FROM objects')[0].n;
 assert.equal((await f.importHistory('v2-fixed-replay')).progress.imported,0);
 assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM objects')[0].n,objects);
 assert.deepEqual(f.store.rows('SELECT * FROM legacy_learning_review_cursor_inputs'),pinned);
 const plan=f.store.rows('EXPLAIN QUERY PLAN SELECT input_content_id FROM legacy_learning_review_cursor_inputs WHERE source_identity=? AND cursor_hash=?',[identity,pinned[0].cursor_hash]);
 assert.ok(plan.some(row=>String(row.detail).includes('SEARCH')));assert.ok(plan.every(row=>!String(row.detail).includes('SCAN')));
 const moved={...f.manifest,sources:f.manifest.sources.map(source=>({...source,file:source.file+'.later-location',previousVersions:[]}))},bytes=Buffer.from(JSON.stringify(moved)),key='runs/semantic-legacy/manifest.json',hash=reviewHash(bytes);
 f.store.captureMigrationSource({identity,key,hash},bytes,{mimeType:'application/json',encoding:'utf8',pending:true});
 f.store.importLegacyLearningReview({identity,runKey:'runs/semantic-legacy',manifest:moved,proposal:null,application:null,files:[{key,hash}]});
 await f.restart();const batch=await f.begin('v2-pinned-after-import',f.persisted),source=batch.manifest.sources.find(item=>item.id==='semantic-original');
 assert.equal(source.file,f.manifest.sources[0].file);assert.equal(source.content,f.original);assert.deepEqual(source.previousVersions.map(item=>item.content),[prior.content]);
 assert.deepEqual(f.store.rows('SELECT * FROM legacy_learning_review_cursor_inputs'),pinned,'later imports never repoint a previously accepted cursor');
});

for(const visibleDeferred of [false,true])test(`v2 hidden hash-only deferred cursor resumes after another review ${visibleDeferred?'defers':'processes'} visible sources and restarts`,async t=>{
 const prior={id:'semantic-original',kind:'memory',hash:reviewHash('更早的私有原文。'),content:'更早的私有原文。'};
 const f=await semanticHistory(t,false,true,{projectScoped:true,previousVersions:[prior]});assert.equal((await f.importHistory('v2-private-cursor')).status,'completed');
 const pins=f.store.rows('SELECT * FROM legacy_learning_review_cursor_inputs'),visible=f.memory(null,'仍可复盘的全局正文。','可见来源');
 const project=f.store.read(f.projectId);f.store.write({kind:'project',action:'patch',scope:null,objectId:project.objectId,expectedRevision:project.revision,idempotencyKey:'v2-hide-project',data:{hidden:1}});
 const batch=await f.begin('v2-hidden-cursor',f.persisted);assert.ok(!batch.manifest.sources.some(source=>source.id==='semantic-original'));
 assert.ok(!JSON.stringify(batch.manifest).includes(f.original));
 const result=f.nativeProposal(batch),visibleSource=batch.manifest.sources.find(source=>source.ref?.objectId===visible.objectId);assert.ok(visibleSource);
 if(visibleDeferred){result.deferredSourceIds=[visibleSource.id];result.processedSourceIds=result.processedSourceIds.filter(id=>id!==visibleSource.id);}
 const applied=await f.apply(batch,result,'v2-hidden-apply');await f.call('finish_learning_review',{applicationId:applied.application.objectId,expectedRevision:applied.application.revision,promptHash:reviewHash(result.globalPrompt),idempotencyKey:'v2-hidden-finish'});
 const hidden=f.store.read(f.projectId);f.store.write({kind:'project',action:'patch',scope:null,objectId:hidden.objectId,expectedRevision:hidden.revision,idempotencyKey:'v2-show-project',data:{hidden:0}});
 await f.restart();const next=await f.begin('v2-visible-again',f.persisted),retained=next.manifest.sources.find(source=>source.id==='semantic-original');
 assert.ok(retained,'a successful visible review must preserve the unavailable deferred source');assert.equal(retained.content,f.original);assert.equal(retained.projectPath,f.project);assert.equal(retained.hash,f.manifest.sources[0].hash);assert.deepEqual(retained.previousVersions.map(source=>source.content),[prior.content]);
 assert.equal(next.manifest.sources.some(source=>source.id===visibleSource.id),visibleDeferred,'visible dispositions remain independent of the hidden source');assert.deepEqual(f.store.rows('SELECT * FROM legacy_learning_review_cursor_inputs'),pins);
 for(const [name,bytes]of f.originals)assert.deepEqual(fs.readFileSync(path.join(f.run,name)),bytes);
});

test('v2 hash-only cursor rejects a missing declared run rather than guessing another source',async t=>{
 const f=await semanticHistory(t,false,true),file=path.join(f.sourceRoot,'review-state.json'),cursor=JSON.parse(fs.readFileSync(file,'utf8'));
 cursor.lastAppliedRunId='different-missing-run';fs.writeFileSync(file,JSON.stringify(cursor));
 const imported=await f.importHistory('v2-missing-cursor-run');assert.equal(imported.status,'completed_with_conflicts');
 assert.ok(imported.progress.conflicts.some(item=>item.error==='legacy_review_cursor_source_missing'));
 assert.equal(f.store.rows('SELECT COUNT(*) AS n FROM legacy_learning_review_cursor_inputs')[0].n,0);
 const batch=await f.begin('v2-no-guessed-source',f.persisted);assert.ok(!batch.manifest.sources.some(source=>source.id==='semantic-original'));
});

test('v2 multi-target preparation reads each full historical batch once through the actual store',async t=>{
 const f=await semanticHistory(t,'all-targets');assert.equal((await f.importHistory('v2-all-pending')).status,'completed');
 const legacy=f.store.search({scope:null,kinds:['review_batch']}).items[0];let reads=0;const read=f.store.read;
 f.store.read=function(ref,...args){if(ref===legacy.objectId)reads++;return read.call(this,ref,...args);};
 const batch=await f.begin('v2-single-full-read');assert.equal(batch.pending.length,3);assert.deepEqual(batch.pending.map(item=>item.targetKind).sort(),['lesson','memory','policy']);
 assert.equal(reads,1,'target count must not multiply complete historical body reads');
 const prefix='runs/semantic-legacy#',plan=f.store.rows('EXPLAIN QUERY PLAN SELECT source_key,object_id FROM migration_items WHERE source_identity=? AND source_key>=? AND source_key<?',[`learning-review:${f.sourceRoot}:target`,prefix,'runs/semantic-legacy$']);
 assert.ok(plan.some(row=>String(row.detail).includes('SEARCH')));assert.ok(plan.every(row=>!String(row.detail).includes('SCAN')));
});

test('v2 native resumed lesson survives a late old producer and preserves that producer byte-for-byte',async t=>{
 const f=await semanticHistory(t,'lesson');assert.equal((await f.importHistory('v2-native-owner-history')).status,'completed');
 const batch=await f.begin('v2-native-owner',f.persisted);await f.apply(batch,f.nativeProposal(batch),'v2-native-owner-apply');
 const application=f.store.read(batch.pending[0].objectId),before=f.store.read(application.data.target_object_id);
 const late=await require('./fixtures/legacy-learning-review-apply.cjs').applyLearningReview({manifest:f.manifest,proposal:f.proposal,review:f.review,runDir:f.run,getGlobalPrompt:()=>f.persisted,setGlobalPrompt:async()=>{}});assert.equal(late.status,'applied');
 const key='candidates/'+before.data.legacy_lesson_id+'.json',file=path.join(f.root,'learning',key),original=fs.readFileSync(file);
 const job=await f.call('import_project_data',{collection:'learning',sourceRoot:path.join(f.root,'learning'),projectScopes:{[f.project]:f.projectId},idempotencyKey:'v2-late-old-producer'});
 let state;for(let i=0;i<100;i++){state=await f.call('migration_status',{jobId:job.jobId});if(!['queued','running'].includes(state.status))break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(state.status,'completed_with_conflicts');assert.ok(state.progress.conflicts.some(item=>item.error==='migration_conflict: newer_database_revision'));
 assert.deepEqual(f.store.read(before.objectId),before);assert.deepEqual(f.store.readMigrationSource(`learning:${path.join(f.root,'learning')}`,key).bytes,original);assert.deepEqual(fs.readFileSync(file),original);
 const provenance=JSON.parse(before.data.semantic_review_json).sourceRef;assert.equal(f.store.read(provenance.objectId,provenance.revision).data.proposal_content,JSON.stringify(f.proposal));
 await f.restart();assert.deepEqual(f.store.read(before.objectId),before);
});

test('v2 fixed cursor inputs and every source body survive an actual backup restore without old sources',async t=>{
 const prior={id:'semantic-original',kind:'memory',hash:reviewHash('备份前的完整旧证据。'),content:'备份前的完整旧证据。'};
 const f=await semanticHistory(t,false,true,{previousVersions:[prior]});assert.equal((await f.importHistory('v2-backup-cursor')).status,'completed');
 const pinned=f.store.rows('SELECT * FROM legacy_learning_review_cursor_inputs'),restoredRoot=path.join(f.base,'restore','.solomap-global');
 fs.mkdirSync(restoredRoot,{recursive:true});await f.store.backup({destination:path.join(restoredRoot,'solomap.db'),idempotencyKey:'fixed-cursor-backup'});
 fs.renameSync(f.sourceRoot,f.sourceRoot+'-retained');fs.renameSync(path.join(f.root,'memory'),path.join(f.root,'memory-retained'));
 const restored=new UnifiedDataStore(restoredRoot),ops=createRuntimeDataOperations(restored);
 try {
  assert.deepEqual(restored.rows('SELECT * FROM legacy_learning_review_cursor_inputs'),pinned);
  assert.equal(restored.rows('PRAGMA integrity_check')[0].integrity_check,'ok');assert.deepEqual(restored.rows('PRAGMA foreign_key_check'),[]);
  const batch=await ops({operation:'prepare_learning_review',input:{runId:'v2-restored-cursor',workspaceRoot:f.project,globalPrompt:f.persisted,persistedGlobalPrompt:f.persisted}});
  const source=batch.manifest.sources.find(item=>item.id==='semantic-original');assert.ok(source);assert.equal(source.content,f.original);assert.equal(source.hash,f.manifest.sources[0].hash);assert.deepEqual(source.previousVersions.map(item=>item.content),[prior.content]);
  assert.equal(fs.existsSync(f.sourceRoot),false);assert.equal(fs.existsSync(path.join(f.root,'memory')),false);
 }finally{await ops.close();restored.close();}
});

for(const [field,value]of [[null,null],['applies_when','用户后来改的适用条件'],['does_not_apply_when','用户后来改的例外'],['verification','用户后来确认的核验'],['evidence_refs_json',[{type:'command',ref:'真实验证',summary:'新证据'}]]])test(`v2 existing lesson ${field?'preserves a pre-review user edit to '+field:'resumes its complete unchanged original image'}`,async t=>{
 const f=await semanticHistory(t,'lesson',false,{existingLesson:true});assert.equal((await f.importHistory('v2-existing-lesson')).status,'completed');
 const job=await f.call('import_project_data',{collection:'learning',sourceRoot:path.join(f.root,'learning'),projectScopes:{[f.project]:f.projectId},idempotencyKey:'v2-canonical-lesson'});
 for(let i=0;i<100;i++){const state=await f.call('migration_status',{jobId:job.jobId});if(!['queued','running'].includes(state.status)){assert.equal(state.status,'completed',JSON.stringify(state));break;}await new Promise(r=>setTimeout(r,10));}
 const lesson=f.store.search({scope:f.projectId,kinds:['lesson']}).items.find(item=>item.data.legacy_lesson_id===f.previousLesson.id);assert.ok(lesson);
 if(field)f.store.write({kind:'lesson',action:'patch',scope:f.projectId,objectId:lesson.objectId,expectedRevision:lesson.revision,idempotencyKey:'v2-edited-before-review',data:{[field]:value}});
 const batch=await f.begin('v2-later-lesson-review',f.persisted),before=f.store.read(lesson.objectId),policy=f.store.readGlobalPromptPolicy();
 if(field){await assert.rejects(f.apply(batch,f.nativeProposal(batch),'v2-adopt-over-later-edit'),/learning_review_target_changed/);
 assert.deepEqual(f.store.read(lesson.objectId),before);assert.equal(f.store.readGlobalPromptPolicy().revision,policy.revision);assert.equal(f.store.read(batch.pending[0].objectId).data.status,'partial');}
 else {const legacy=JSON.parse(f.store.read(batch.pending[0].legacyTarget.batchId,batch.pending[0].legacyTarget.revision).data.review_content),original=legacy.legacyTargets.find(target=>target.kind==='lesson').beforeData;assert.deepEqual(Object.fromEntries(Object.keys(original).map(key=>[key,key.endsWith('_json') && typeof before.data[key] === 'string' ? JSON.parse(before.data[key]) : before.data[key]])),original,'the canonical imported fields match the actual original candidate');await f.apply(batch,f.nativeProposal(batch),'v2-adopt-existing-lesson');const current=f.store.read(lesson.objectId);assert.equal(current.data.summary,f.proposal.lessons[0].summary);assert.equal(f.store.read(batch.pending[0].objectId).data.target_object_id,lesson.objectId);assert.equal(f.store.read(batch.pending[0].objectId).data.applied_revision,current.revision);}
});

async function fixture(t) {
  const base = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'review-database-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  let store = new UnifiedDataStore(root), ops = createRuntimeDataOperations(store);
  const { projectId } = await ops({ operation: 'register_project', input: { root: project } });
  t.after(async () => { await ops.close(); store.close(); });
  const call = (operation, input) => ops({ operation, input });
  const memory = (scope, text, title = '来源') => store.write({ kind: 'memory', action: 'create', scope, idempotencyKey: 'memory:' + title, data: { category: 'rules', title, status: 'captured', content: text } });
  const begin = (runId, prompt = '保留用户目标。') => call('prepare_learning_review', { runId, workspaceRoot: project, globalPrompt: prompt, persistedGlobalPrompt: prompt });
  const proposal = (batch, globalPrompt = batch.manifest.globalPrompt) => ({ globalPrompt, changes: [], lessons: [], processedSourceIds: batch.manifest.sources.map(s => s.id), deferredSourceIds: [], unresolved: [], recovery: batch.pending.map(p => ({ applicationId: p.objectId, revision: p.revision, decision: 'resumed', reason: '承接原完整结果。' })) });
  const apply = (batch, result, key = 'apply:' + batch.manifest.runId) => call('apply_learning_review', { batchId: batch.objectId, expectedRevision: batch.revision, manifestHash: reviewHash(JSON.stringify(batch.manifest)), result, idempotencyKey: key });
  const reviewSession = async batch => {
    let state = await call('prepare_run', { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'learning_review', prompt: '完整提示词复盘。', command: 'formal-review', userMessage: '复盘经验', metadata: { learningReviewBatchId: batch.objectId }, idempotencyKey: 'prepare-review' });
    state = await call('claim_run', { root: project, executionLogId: 1, expectedRevision: state.revision, agentPid: process.pid, processBirth: '', idempotencyKey: 'claim-review' });
    return { ...await call('open_mcp_session', { projectId, runIdentity: { executionLogId: 1, generation: state.generation, proof: state.proof } }), state };
  };
  return { base, root, project, projectId, get store() { return store; }, request: request => ops(request), call, memory, begin, proposal, apply, reviewSession,
    async restart() { await ops.close(); store.close(); store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store); } };
}

test('formal review collects complete pinned database sources across visible projects without old files', async t => {
  const f = await fixture(t), full = '完整正文🌿'.repeat(18000);
  const local = f.memory(f.projectId, full), global = f.memory(null, '跨项目用户偏好。', '全局');
  const other = path.join(f.base, 'other'); fs.mkdirSync(other);
  const { projectId } = await f.call('register_project', { root: other });
  f.memory(projectId, '另一项目正文。', '另一项目');
  const hidden = path.join(f.base, 'hidden'); fs.mkdirSync(hidden);
  const hiddenProject = await f.call('register_project', { root: hidden });
  f.memory(hiddenProject.projectId, '隐藏项目私有正文。', '隐藏');
  const current = f.store.read(hiddenProject.projectId);
  f.store.write({ kind: 'project', action: 'patch', scope: null, objectId: current.objectId, expectedRevision: current.revision, idempotencyKey: 'hide', data: { hidden: 1 } });
  const batch = await f.begin('full-sources');
  assert.deepEqual(batch.manifest.projects.sort(), [f.project, other].sort());
  for (const item of [local, global]) {
    const source = batch.manifest.sources.find(s => s.ref.objectId === item.objectId);
    assert.equal(source.ref.revision, item.revision);
    assert.equal(source.hash, reviewHash(source.content));
    assert.deepEqual(JSON.parse(source.content), f.store.read(item.objectId, item.revision).data);
  }
  assert.equal(JSON.parse(batch.manifest.sources.find(s => s.ref.objectId === local.objectId).content).content, full);
  assert.equal(batch.manifest.sources.some(s => s.content.includes('隐藏项目私有')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'maintenance')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'memory')), false);
});

test('formal review applies the full prompt and cursor atomically, keeps pinned evidence, and replays without versions', async t => {
  const f = await fixture(t), old = f.memory(f.projectId, '用户明确要求必须复核结果。');
  const batch = await f.begin('apply-full'), source = batch.manifest.sources.find(s => s.ref.objectId === old.objectId);
  f.store.write({ kind: 'memory', action: 'patch', scope: f.projectId, objectId: old.objectId, expectedRevision: old.revision, idempotencyKey: 'source-newer', data: { content: '更晚的补充，不能覆盖旧批次证据。' } });
  const result = f.proposal(batch, '保留用户目标。\n交付前复核实际结果。');
  result.changes = [{ type: 'add', before: [], after: '交付前复核实际结果。', evidence: [source.id], reason: '用户明确要求，已有原文。' }];
  const applied = await f.apply(batch, result);
  const policy = f.store.read(applied.policy.objectId, applied.policy.revision);
  assert.equal(policy.data.content, result.globalPrompt);
  assert.deepEqual(f.store.read(applied.application.objectId).data.after_content, result.globalPrompt);
  const saved = f.store.read(batch.objectId);
  assert.equal(saved.data.status, 'applying');
  assert.deepEqual(JSON.parse(saved.data.proposal_content), result);
  assert.deepEqual(await f.apply(batch, result), applied);
  await f.call('finish_learning_review', { applicationId: applied.application.objectId, expectedRevision: applied.application.revision, promptHash: reviewHash(result.globalPrompt), idempotencyKey: 'finish-apply-full' });
  const next = await f.begin('next', result.globalPrompt);
  const changed = next.manifest.sources.find(s => s.ref.objectId === old.objectId);
  assert.equal(changed.ref.revision, 2);
  assert.equal(JSON.parse(source.content).content, f.store.read(old.objectId, 1).data.content);
});

test('formal review retains every deferred version and excludes unchanged applied evidence after restart', async t => {
  const f = await fixture(t), held = f.memory(f.projectId, '延期旧全文。'), done = f.memory(null, '已处理全文。', '处理');
  const first = await f.begin('defer'), result = f.proposal(first);
  const source = first.manifest.sources.find(s => s.ref.objectId === held.objectId);
  result.deferredSourceIds = [source.id]; result.processedSourceIds = result.processedSourceIds.filter(id => id !== source.id);
  const applied = await f.apply(first, result);
  await f.call('finish_learning_review', { applicationId: applied.application.objectId, expectedRevision: applied.application.revision, promptHash: reviewHash(result.globalPrompt), idempotencyKey: 'finish-defer' });
  f.store.write({ kind: 'memory', action: 'patch', scope: f.projectId, objectId: held.objectId, expectedRevision: 1, idempotencyKey: 'change-held', data: { content: '延期新全文。' } });
  await f.restart();
  const next = await f.begin('defer-next'), latest = next.manifest.sources.find(s => s.id === source.id);
  assert.equal(next.manifest.sources.some(s => s.ref.objectId === done.objectId), false);
  assert.equal(JSON.parse(latest.content).content, '延期新全文。');
  assert.equal(JSON.parse(latest.previousVersions[0].content).content, '延期旧全文。');
  assert.deepEqual(latest.previousVersions[0].ref, source.ref);
  assert.equal(f.store.read((await f.apply(next, f.proposal(next))).policy.objectId).data.content, next.manifest.globalPrompt);
});

test('native deferred archived sources retain every fixed version across a hidden successful review', async t => {
  const f = await fixture(t), held = f.memory(f.projectId, '私有延期第一版。', '归档来源');
  const defer = async runId => {
    const batch = await f.begin(runId), source = batch.manifest.sources.find(item => item.ref?.objectId === held.objectId), result = f.proposal(batch);
    assert.ok(source); result.deferredSourceIds = [source.id]; result.processedSourceIds = result.processedSourceIds.filter(id => id !== source.id);
    const applied = await f.apply(batch, result);
    await f.call('finish_learning_review', { applicationId: applied.application.objectId, expectedRevision: applied.application.revision, promptHash: reviewHash(result.globalPrompt), idempotencyKey: 'finish:' + runId });
    return source;
  };
  await defer('private-defer-first');
  f.store.write({ kind: 'memory', action: 'patch', scope: f.projectId, objectId: held.objectId, expectedRevision: held.revision, idempotencyKey: 'private-second-version', data: { content: '私有延期第二版。' } });
  const original = await defer('private-defer-second'), project = f.store.read(f.projectId);
  f.store.write({ kind: 'project', action: 'patch', scope: null, objectId: project.objectId, expectedRevision: project.revision, idempotencyKey: 'hide-native-deferred', data: { hidden: 1 } });
  const current = f.store.read(held.objectId);
  f.store.write({ kind: 'memory', action: 'archive', scope: f.projectId, objectId: held.objectId, expectedRevision: current.revision, idempotencyKey: 'archive-native-deferred', data: {} });
  const hidden = await f.begin('hidden-native-review'); assert.ok(!hidden.manifest.sources.some(item => item.id === original.id)); assert.ok(!JSON.stringify(hidden.manifest).includes('私有延期'));
  const result = f.proposal(hidden), applied = await f.apply(hidden, result);
  await f.call('finish_learning_review', { applicationId: applied.application.objectId, expectedRevision: applied.application.revision, promptHash: reviewHash(result.globalPrompt), idempotencyKey: 'finish-hidden-native' });
  const shown = f.store.read(f.projectId);
  f.store.write({ kind: 'project', action: 'patch', scope: null, objectId: shown.objectId, expectedRevision: shown.revision, idempotencyKey: 'show-native-deferred', data: { hidden: 0 } });
  await f.restart(); const next = await f.begin('shown-native-review'), restored = next.manifest.sources.find(item => item.id === original.id);
  assert.ok(restored, 'archiving the live object must not discard its deferred fixed versions'); assert.deepEqual(restored, original);
  assert.equal(JSON.parse(restored.content).content, '私有延期第二版。'); assert.equal(JSON.parse(restored.previousVersions[0].content).content, '私有延期第一版。');
});

test('formal review rejects stale policy and malformed deletions with no partial policy or application writes', async t => {
  const f = await fixture(t); f.memory(f.projectId, '只支持保留原要求。');
  const batch = await f.begin('stale'), original = f.store.read(batch.policy.objectId);
  const malformed = f.proposal(batch, '不同的要求。');
  await assert.rejects(f.apply(batch, malformed), /删除但缺少|新增或改写/);
  assert.equal(f.store.read(original.objectId).revision, original.revision);
  assert.equal(f.store.search({ scope: f.projectId, kinds: ['application'] }).items.length, 0);
  f.store.write({ kind: 'policy', action: 'patch', scope: null, objectId: original.objectId, expectedRevision: original.revision, idempotencyKey: 'new-user-policy', data: { content: '用户更新后的要求。' } });
  await assert.rejects(f.apply(batch, f.proposal(batch)), /revision_conflict/);
  assert.equal(f.store.read(original.objectId).data.content, '用户更新后的要求。');
  assert.equal(f.store.search({ scope: f.projectId, kinds: ['application'] }).items.length, 0);
});

test('formal review exposes interrupted full application after restart and acknowledges only its exact prompt', async t => {
  const f = await fixture(t); f.memory(f.projectId, '可用正文。');
  const batch = await f.begin('interrupted'), applied = await f.apply(batch, f.proposal(batch));
  await f.restart();
  const next = await f.begin('recover');
  assert.equal(next.pending.length, 1);
  assert.equal(next.pending[0].objectId, applied.application.objectId);
  assert.equal(next.pending[0].targetPrompt, '保留用户目标。');
  await assert.rejects(f.call('finish_learning_review', { applicationId: applied.application.objectId, expectedRevision: applied.application.revision, promptHash: reviewHash('其他正文'), idempotencyKey: 'wrong-ack' }), /prompt_mismatch/);
  assert.equal(f.store.read(applied.application.objectId).data.status, 'applying');
});

test('a live formal review run retains ownership after the launching window is gone', async t => {
  const f = await fixture(t), batch = await f.begin('old-window'), session = await f.reviewSession(batch);
  await f.restart();
  await assert.rejects(f.begin('new-window'), /learning_review_owner_alive/);
  const current = f.store.read(batch.objectId); assert.equal(current.revision, batch.revision); assert.equal(current.data.status, 'draft');
  const resumed = await f.call('open_mcp_session', { projectId: f.projectId, runIdentity: { executionLogId: 1, generation: session.state.generation, proof: session.state.proof } });
  assert.equal((await f.request({ operation: 'read', sessionToken: resumed.sessionToken, input: { ref: batch.objectId } })).objectId, batch.objectId);
});

test('a lost review finish reply replays its original receipt after a newer prompt has been applied', async t => {
  const f = await fixture(t), batch = await f.begin('finish-reply'), applied = await f.apply(batch, f.proposal(batch));
  const request = { applicationId: applied.application.objectId, expectedRevision: applied.application.revision, promptHash: reviewHash(batch.manifest.globalPrompt), idempotencyKey: 'finish-reply' };
  const first = await f.call('finish_learning_review', request);
  const policy = f.store.read(applied.policy.objectId);
  f.store.write({ kind: 'policy', action: 'patch', scope: null, objectId: policy.objectId, expectedRevision: policy.revision, idempotencyKey: 'newer-user-policy-after-finish', data: { content: '用户后来修改的完整要求。' } });
  await f.restart();
  assert.deepEqual(await f.call('finish_learning_review', request), first);
  assert.equal(f.store.read(policy.objectId).data.content, '用户后来修改的完整要求。');
  assert.equal(f.store.read(first.objectId).revision, first.revision);
});

test('an explicit user instruction save supersedes a pending review projection without losing its original result', async t => {
  const f = await fixture(t); f.memory(f.projectId, '用户要求核验完整交付。');
  const batch = await f.begin('pending-user-edit'), result = f.proposal(batch, '保留用户目标。\n核验完整交付。');
  result.changes = [{ type: 'add', before: [], after: '核验完整交付。', evidence: [batch.manifest.sources[0].id], reason: '用户已明确要求。' }];
  const applied = await f.apply(batch, result);
  const request = { policy: { objectId: applied.policy.objectId, revision: applied.policy.revision }, content: '保留用户目标。\n用户刚保存的新要求。', source: 'user', idempotencyKey: 'explicit-user-prompt-save' };
  const saved = await f.call('save_global_prompt', request);
  const interrupted = f.store.read(applied.application.objectId);
  assert.equal(interrupted.data.status, 'superseded'); assert.equal(interrupted.data.after_content, result.globalPrompt);
  assert.equal(interrupted.data.before_content, batch.manifest.globalPrompt);
  assert.equal(f.store.read(saved.objectId, saved.revision).data.content, request.content);
  await f.restart();
  assert.deepEqual(await f.call('save_global_prompt', request), saved);
  const next = await f.begin('after-explicit-save', request.content);
  assert.equal(next.pending.length, 0); assert.equal(next.manifest.globalPrompt, request.content);
  await assert.rejects(f.call('save_global_prompt', { ...request, source: 'review_projection', content: result.globalPrompt, idempotencyKey: 'late-review-projection' }), /global_prompt_revision_conflict/);
});

test('ordinary project MCP cannot collect all projects or apply reviewed policies', async t => {
  const f = await fixture(t);
  const session = await f.call('open_mcp_session', { projectId: f.projectId });
  for (const operation of ['prepare_learning_review', 'apply_learning_review', 'finish_learning_review', 'read_global_prompt_policy', 'save_global_prompt']) {
    await assert.rejects(f.request({ operation, sessionToken: session.sessionToken, input: { runId: 'unauthorized' } }), /action_denied/);
  }
});

test('an interrupted unapplied full proposal and its pinned evidence are collected again after restart', async t => {
  const f = await fixture(t), original = f.memory(f.projectId, '必须保留的旧版本全文🌿。');
  const batch = await f.begin('unapplied-proposal'), result = f.proposal(batch, '保留用户目标。\n核验实际交付。');
  result.changes = [{ type: 'add', before: [], after: '核验实际交付。', evidence: [batch.manifest.sources[0].id], reason: '原始用户要求。' }];
  const proposed = f.store.write({ kind: 'review_batch', action: 'patch', scope: f.projectId, objectId: batch.objectId, expectedRevision: batch.revision, idempotencyKey: 'save-unapplied-proposal', data: { proposal_content: JSON.stringify(result) } });
  await f.call('interrupt_learning_review', { batchId: batch.objectId });
  const interrupted = f.store.read(batch.objectId);
  f.store.write({ kind: 'memory', action: 'patch', scope: f.projectId, objectId: original.objectId, expectedRevision: original.revision, idempotencyKey: 'change-before-resume', data: { content: '更晚的来源全文，不能覆盖旧提案证据。' } });
  await f.restart();
  const next = await f.begin('resume-unapplied-proposal');
  const candidate = next.manifest.sources.find(source => source.kind === 'review_proposal' && source.ref?.objectId === batch.objectId);
  assert.ok(candidate, 'the next formal review must expose the interrupted full proposal');
  assert.equal(candidate.ref.revision, interrupted.revision);
  assert.equal(candidate.hash, reviewHash(candidate.content));
  const preserved = JSON.parse(candidate.content);
  assert.deepEqual(preserved.result, result); assert.deepEqual(preserved.manifest, batch.manifest);
  assert.equal(JSON.parse(preserved.manifest.sources.find(source => source.ref.objectId === original.objectId).content).content, '必须保留的旧版本全文🌿。');
  const evidence = next.manifest.sources.find(source => source.ref?.objectId === original.objectId);
  assert.equal(evidence.ref.revision, 2); assert.ok(evidence.previousVersions.some(source => source.ref.revision === 1));
  assert.equal(f.store.read(batch.policy.objectId).revision, batch.policy.revision, 'collecting an old proposal cannot apply it');
  assert.equal(f.store.search({ scope: f.projectId, kinds: ['application'] }).items.length, 0);
  assert.equal(f.store.read(proposed.objectId, proposed.revision).data.proposal_content, JSON.stringify(result));
});

test('an old unapplied proposal cannot serve as evidence for promoting its own instructions', async t => {
  const f = await fixture(t), batch = await f.begin('proposal-self-evidence');
  const manifest = { ...batch.manifest, sources: [{ id: 'held-proposal', kind: 'review_proposal', content: '{"globalPrompt":"新增要求。"}', hash: reviewHash('{"globalPrompt":"新增要求。"}') }] };
  const { validateDirectGlobalPromptReview } = require('../out/learningReviewApply.js');
  const result = { globalPrompt: '保留用户目标。\n新增要求。', changes: [{ type: 'add', before: [], after: '新增要求。', evidence: ['held-proposal'], reason: '承接旧提案。' }], lessons: [], processedSourceIds: ['held-proposal'], deferredSourceIds: [], unresolved: [], recovery: [] };
  assert.throws(() => validateDirectGlobalPromptReview(manifest, result), /不能只由旧提示词、索引或候选自证/);
});

test('a submitted draft survives an unannounced host exit and is collected after its formal run dies', async t => {
  const f = await fixture(t), { spawn } = require('node:child_process'), { once } = require('node:events');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn'); t.after(() => { if (child.exitCode === null) child.kill(); });
  const batch = await f.call('prepare_learning_review', { runId: 'unannounced-exit', workspaceRoot: f.project, globalPrompt: '保留用户目标。', persistedGlobalPrompt: '保留用户目标。', owner: { id: 'old-window', pid: child.pid, birth: '' } });
  let run = await f.call('prepare_run', { root: f.project, executionLogId: 1, nodeId: '__solo__', runKind: 'learning_review', prompt: '完整复盘。', command: 'formal-review', userMessage: '复盘经验', metadata: { learningReviewBatchId: batch.objectId }, idempotencyKey: 'prepare-exited-review' });
  run = await f.call('claim_run', { root: f.project, executionLogId: 1, expectedRevision: run.revision, agentPid: child.pid, processBirth: '', idempotencyKey: 'claim-exited-review' });
  const result = f.proposal(batch);
  const submitted = f.store.write({ kind: 'review_batch', action: 'patch', scope: f.projectId, objectId: batch.objectId, expectedRevision: batch.revision, idempotencyKey: 'submit-before-host-exit', data: { proposal_content: JSON.stringify(result) } });
  await f.restart(); await assert.rejects(f.begin('while-old-agent-lives'), /learning_review_owner_alive/);
  assert.equal(f.store.read(batch.objectId).revision, submitted.revision);
  const exited = once(child, 'exit'); child.kill(); await exited;
  await f.restart(); const next = await f.begin('after-unannounced-exit');
  const source = next.manifest.sources.find(item => item.kind === 'review_proposal' && item.ref.objectId === batch.objectId);
  assert.ok(source, 'host termination without interrupt must retain the submitted proposal in the next review');
  assert.deepEqual(JSON.parse(source.content).result, result);
  assert.equal(f.store.read(batch.objectId).data.status, 'interrupted');
  assert.equal(f.store.read(batch.objectId, submitted.revision).data.status, 'draft');
  assert.equal(f.store.read(batch.policy.objectId).revision, batch.policy.revision);
});

test('an interrupted malformed proposal remains complete evidence without blocking the next review', async t => {
  const f = await fixture(t), batch = await f.begin('malformed-unapplied-proposal');
  const raw = '{"globalPrompt":"截断但仍需保留🌿';
  f.store.write({ kind: 'review_batch', action: 'patch', scope: f.projectId, objectId: batch.objectId, expectedRevision: batch.revision, idempotencyKey: 'save-malformed-proposal', data: { proposal_content: raw } });
  await f.call('interrupt_learning_review', { batchId: batch.objectId }); await f.restart();
  const next = await f.begin('after-malformed-proposal');
  const candidate = next.manifest.sources.find(source => source.kind === 'review_proposal' && source.ref?.objectId === batch.objectId);
  assert.ok(candidate); assert.equal(JSON.parse(candidate.content).proposalContent, raw);
  assert.equal(JSON.parse(candidate.content).result, null);
  assert.equal(f.store.read(batch.policy.objectId).revision, batch.policy.revision);
});

test('repeated interrupted reviews retain every proposal without recursively copying proposal bodies', async t => {
  const f = await fixture(t); f.memory(f.projectId, '完整原文🌿'.repeat(250));
  const proposals = [];
  for (let index = 0; index < 8; index++) {
    const batch = await f.begin('repeated-proposal-' + index);
    const result = f.proposal(batch);
    f.store.write({ kind: 'review_batch', action: 'patch', scope: f.projectId, objectId: batch.objectId, expectedRevision: batch.revision, idempotencyKey: 'repeated-proposal-write-' + index, data: { proposal_content: JSON.stringify(result) } });
    await f.call('interrupt_learning_review', { batchId: batch.objectId }); proposals.push(batch.objectId);
  }
  await f.restart(); const next = await f.begin('after-repeated-proposals');
  const retained = next.manifest.sources.filter(source => source.kind === 'review_proposal');
  assert.deepEqual(retained.map(source => source.ref.objectId).sort(), proposals.sort());
  for (const source of retained) {
    assert.ok(Buffer.byteLength(source.content) < 65536, 'retained proposals must reference other proposal bodies, rather than recursively duplicate them');
    for (const header of JSON.parse(source.content).manifest.sources.filter(item => item.kind === 'review_proposal')) {
      assert.equal(header.content, '');
      let cursor, bytes = [];
      do {
        const page = await f.call('read', { ref: next.objectId, revision: next.revision, view: 'content', field: `review_source:${header.id}:${header.hash}`, limit: 1024, ...(cursor ? { cursor } : {}) });
        bytes.push(Buffer.from(page.data, 'base64')); cursor = page.cursor;
      } while (cursor);
      const text = Buffer.concat(bytes).toString('utf8'); assert.equal(reviewHash(text), header.hash);
      assert.equal(JSON.parse(text).batchId, header.ref.objectId);
    }
  }
});

test('a deferred interrupted proposal preserves its earlier complete version when a later result arrives', async t => {
  const f = await fixture(t), first = await f.begin('late-proposal-original'), original = f.proposal(first);
  f.store.write({ kind: 'review_batch', action: 'patch', scope: f.projectId, objectId: first.objectId, expectedRevision: first.revision, idempotencyKey: 'original-proposal', data: { proposal_content: JSON.stringify(original) } });
  await f.call('interrupt_learning_review', { batchId: first.objectId });
  const second = await f.begin('defer-old-proposal'), source = second.manifest.sources.find(item => item.kind === 'review_proposal');
  const result = f.proposal(second); result.deferredSourceIds = [source.id]; result.processedSourceIds = result.processedSourceIds.filter(id => id !== source.id);
  const applied = await f.apply(second, result);
  await f.call('finish_learning_review', { applicationId: applied.application.objectId, expectedRevision: applied.application.revision, promptHash: reviewHash(result.globalPrompt), idempotencyKey: 'finish-deferred-proposal' });
  const old = f.store.read(first.objectId), changed = { ...original, unresolved: ['更晚的完整补充。'] };
  f.store.write({ kind: 'review_batch', action: 'patch', scope: f.projectId, objectId: old.objectId, expectedRevision: old.revision, idempotencyKey: 'later-proposal', data: { proposal_content: JSON.stringify(changed) } });
  await f.restart(); const next = await f.begin('read-deferred-proposal-versions');
  const latest = next.manifest.sources.find(item => item.id === source.id);
  assert.deepEqual(JSON.parse(latest.content).result, changed);
  const pinned = latest.previousVersions?.find(item => item.hash === source.hash);
  assert.ok(pinned, 'deferring the old proposal must retain its original complete version');
  assert.deepEqual(JSON.parse(pinned.content).result, original); assert.deepEqual(pinned.ref, source.ref);
});

test('a deferred proposal no longer exposes a project removed from the current review scope', async t => {
  const f = await fixture(t), privateRoot = path.join(f.base, 'private-project'); fs.mkdirSync(privateRoot);
  const { projectId } = await f.call('register_project', { root: privateRoot });
  f.memory(projectId, '撤销后不可继续暴露的原始私有正文。', '私有来源');
  const first = await f.begin('before-project-scope-revoked'), original = f.proposal(first);
  f.store.write({ kind: 'review_batch', action: 'patch', scope: f.projectId, objectId: first.objectId, expectedRevision: first.revision, idempotencyKey: 'scoped-original-proposal', data: { proposal_content: JSON.stringify(original) } });
  await f.call('interrupt_learning_review', { batchId: first.objectId });
  const second = await f.begin('defer-scoped-proposal'), source = second.manifest.sources.find(item => item.kind === 'review_proposal');
  const result = f.proposal(second); result.deferredSourceIds = [source.id]; result.processedSourceIds = result.processedSourceIds.filter(id => id !== source.id);
  const applied = await f.apply(second, result);
  await f.call('finish_learning_review', { applicationId: applied.application.objectId, expectedRevision: applied.application.revision, promptHash: reviewHash(result.globalPrompt), idempotencyKey: 'finish-scoped-proposal' });
  const later = { ...original, unresolved: ['后续补充仍需保留原延期版本。'] }, old = f.store.read(first.objectId);
  f.store.write({ kind: 'review_batch', action: 'patch', scope: f.projectId, objectId: old.objectId, expectedRevision: old.revision, idempotencyKey: 'later-private-proposal', data: { proposal_content: JSON.stringify(later) } });
  const project = f.store.read(projectId);
  f.store.write({ kind: 'project', action: 'patch', scope: null, objectId: project.objectId, expectedRevision: project.revision, idempotencyKey: 'revoke-review-project', data: { hidden: 1 } });
  await f.restart(); const next = await f.begin('after-project-scope-revoked');
  assert.equal(next.manifest.sources.some(item => item.id === source.id), false);
  assert.equal(next.manifest.sources.some(item => item.content.includes('撤销后不可继续暴露')), false);
  assert.ok(next.manifest.gaps.length > 0); assert.equal(f.store.read(first.objectId).data.proposal_content, JSON.stringify(later));
  assert.equal(f.store.read(source.ref.objectId, source.ref.revision).data.proposal_content, JSON.stringify(original), 'the later proposal never overwrites the original pinned proposal');
  const hiddenResult = f.proposal(next), hiddenApplied = await f.apply(next, hiddenResult);
  await f.call('finish_learning_review', { applicationId: hiddenApplied.application.objectId, expectedRevision: hiddenApplied.application.revision, promptHash: reviewHash(hiddenResult.globalPrompt), idempotencyKey: 'finish-hidden-proposal' });
  const shown = f.store.read(projectId);
  f.store.write({ kind: 'project', action: 'patch', scope: null, objectId: shown.objectId, expectedRevision: shown.revision, idempotencyKey: 'show-deferred-proposal', data: { hidden: 0 } });
  await f.restart(); const resumed = await f.begin('after-project-scope-restored'), retained = resumed.manifest.sources.find(item => item.id === source.id);
  assert.ok(retained); assert.deepEqual(JSON.parse(retained.content).result, later);
  assert.ok([retained, ...(retained.previousVersions || [])].some(item => item.hash === source.hash && JSON.parse(item.content).result.globalPrompt === original.globalPrompt), 'the original deferred proposal remains pinned after the hidden successful review');
});

test('the background importer resumes a legacy partial review with full sources and an unknown original policy version', async t => {
  const f = await fixture(t), sourceRoot = path.join(f.root, 'maintenance'), run = path.join(sourceRoot, 'runs', 'legacy-partial'); fs.mkdirSync(run, { recursive: true });
  const originalText = '核验实际交付。🌿\n完整历史原文。';
  const source = { id: 'legacy-full-source', kind: 'memory', projectPath: f.project, file: path.join(f.root, 'memory', 'projects', 'project.md'), hash: reviewHash(originalText), content: originalText };
  const manifest = { schemaVersion: 1, runId: 'legacy-partial', globalRoot: f.root, globalPrompt: '保留用户目标。', promptHash: reviewHash('保留用户目标。'), persistedPromptHash: reviewHash('当时实际保存的另一份指令。'), projects: [f.project], sources: [source], memory: [], gaps: [] };
  const result = { globalPrompt: '保留用户目标。\n核验实际交付。', changes: [{ type: 'add', before: [], after: '核验实际交付。', evidence: [source.id], reason: '原始要求。' }], lessons: [], processedSourceIds: [source.id], deferredSourceIds: [], unresolved: [], recovery: [] };
  const recovered = { ...source, id: 'previously-recovered-source', content: '此前接续的完整原文。', hash: reviewHash('此前接续的完整原文。') };
  const application = { schemaVersion: 1, proposalHash: reviewHash(JSON.stringify(result)), targetPromptHash: reviewHash(result.globalPrompt), targetPrompt: result.globalPrompt, status: 'partial', items: {}, errors: ['旧宿主投影未完成。'], sourceCursor: [source, recovered], deferredSourceIds: [], deferredSources: [], recovery: [] };
  const files = { 'manifest.json': manifest, 'proposal.json': result, 'application.json': application };
  const originals = new Map();
  for (const [name, value] of Object.entries(files)) { const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'); fs.writeFileSync(path.join(run, name), bytes); originals.set(name, bytes); }
  const job = await f.call('import_project_data', { collection: 'learning-review', sourceRoot, projectScopes: { [f.project]: f.projectId }, idempotencyKey: 'import-legacy-partial-review' });
  let status;
  for (let attempt = 0; attempt < 100; attempt++) { status = await f.call('migration_status', { jobId: job.jobId }); if (!['queued', 'running'].includes(status.status)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(status.status, 'completed', status.error);
  const imported = f.store.search({ scope: null, kinds: ['application'] }).items;
  assert.equal(imported.length, 1); const saved = f.store.read(imported[0].objectId);
  assert.equal(saved.data.status, 'partial'); assert.equal(saved.data.after_content, result.globalPrompt);
  assert.equal(saved.data.before_content_id, null, 'an editor draft is not proof of the old persisted policy');
  assert.equal(saved.data.expected_revision, 0, 'unknown legacy policy versions cannot be fabricated');
  assert.equal(f.store.readGlobalPromptPolicy(), null, 'import must not activate the old target as current user instructions');
  const originalRevision = saved.revision;
  const replay = await f.call('import_project_data', { collection: 'learning-review', sourceRoot, projectScopes: { [f.project]: f.projectId }, idempotencyKey: 'recheck-legacy-partial-review' });
  for (let attempt = 0; attempt < 100; attempt++) { status = await f.call('migration_status', { jobId: replay.jobId }); if (!['queued', 'running'].includes(status.status)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(status.progress.imported, 0, 'unchanged history is not reported as newly imported');
  assert.equal(status.progress.unchanged, 1);
  assert.equal(f.store.read(saved.objectId).revision, originalRevision);
  await f.restart(); const next = await f.begin('resume-legacy-partial');
  assert.equal(next.pending.length, 1); assert.equal(next.pending[0].objectId, saved.objectId); assert.equal(next.pending[0].targetPrompt, result.globalPrompt);
  assert.deepEqual(next.pending[0].result, result);
  assert.equal(next.manifest.sources.find(item => item.id === source.id).content, originalText);
  assert.equal(next.manifest.sources.find(item => item.id === recovered.id)?.content, recovered.content, 'application cursor history outside the last manifest must also survive');
  const resumed = f.proposal(next, result.globalPrompt);
  resumed.changes = result.changes;
  const applied = await f.apply(next, resumed);
  await f.call('finish_learning_review', { applicationId: applied.application.objectId, expectedRevision: applied.application.revision, promptHash: reviewHash(result.globalPrompt), idempotencyKey: 'finish-resumed-legacy' });
  assert.equal(f.store.read(saved.objectId).data.status, 'resumed');
  await f.restart();
  assert.equal((await f.begin('after-legacy-resumed', result.globalPrompt)).pending.length, 0);
  for (const [name, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(run, name)), bytes);
});

async function legacyReview(t, status = 'partial') {
  const f = await fixture(t), sourceRoot = path.join(f.root, 'maintenance'), runId = 'old-review';
  const run = path.join(sourceRoot, 'runs', runId); fs.mkdirSync(run, { recursive: true });
  const content = '历史用户要求：交付后核验。🌿\n';
  const source = { id: 'old-source', kind: 'memory', projectPath: f.project, hash: reviewHash(content), content };
  const manifest = { schemaVersion: 1, runId, globalRoot: f.root, globalPrompt: '保留用户目标。', promptHash: reviewHash('保留用户目标。'), projects: [f.project], sources: [source], memory: [], gaps: [] };
  const proposal = { globalPrompt: '保留用户目标。\n交付后核验。', changes: [{ type: 'add', before: [], after: '交付后核验。', evidence: [source.id], reason: '用户原始要求。' }], lessons: [], processedSourceIds: [source.id], deferredSourceIds: [], unresolved: [], recovery: [] };
  fs.writeFileSync(path.join(run, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(run, 'proposal.json'), JSON.stringify(proposal));
  if (status) fs.writeFileSync(path.join(run, 'application.json'), JSON.stringify({ schemaVersion: 1, status, proposalHash: reviewHash(JSON.stringify(proposal)), targetPromptHash: reviewHash(proposal.globalPrompt), targetPrompt: proposal.globalPrompt, sourceCursor: [source], deferredSourceIds: [], deferredSources: [], recovery: [], items: {}, errors: [] }));
  const importHistory = async key => {
    const job = await f.call('import_project_data', { collection: 'learning-review', sourceRoot, projectScopes: { [f.project]: f.projectId }, idempotencyKey: key });
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await f.call('migration_status', { jobId: job.jobId });
      if (!['queued', 'running'].includes(state.status)) return state;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('legacy history import did not settle');
  };
  return { ...f, get store() { return f.store; }, sourceRoot, run, source, manifest, proposal, importHistory };
}

for (const representation of ['github', 'deleted-fulltext', 'deleted-unavailable']) test(`legacy v1 ${representation} sources retain their original hash and complete paged evidence after restart`, async t => {
  const f = await legacyReview(t), content = '删除前的完整原文🌿\n'.repeat(9000);
  const value = representation === 'github'
    ? { repository: 'owner/repo', sha: 'a'.repeat(40), files: ['src/app.ts'], checks: [], statuses: [], gaps: [], observedAt: '2026-09-18T00:00:00Z' }
    : { file: path.join(f.project, 'old.md'), previousHash: reviewHash(content), previousKind: 'memory', ...(representation === 'deleted-unavailable' ? { contentUnavailable: true } : {}) };
  const { observedAt, ...stable } = value;
  const source = { id: representation === 'github' ? 'github-' + reviewHash('owner/repo:' + 'a'.repeat(40)).slice(0, 24) : 'old-source', kind: representation === 'github' ? 'github' : 'deleted_source', projectPath: f.project, hash: reviewHash(JSON.stringify(stable)), value, ...(representation === 'deleted-fulltext' ? { content } : {}) };
  f.manifest.sources = [source];
  fs.writeFileSync(path.join(f.run, 'manifest.json'), JSON.stringify(f.manifest));
  const app = JSON.parse(fs.readFileSync(path.join(f.run, 'application.json'), 'utf8')); app.sourceCursor = [source];
  fs.writeFileSync(path.join(f.run, 'application.json'), JSON.stringify(app));
  const state = await f.importHistory('import-representation-' + representation);
  assert.equal(state.status, 'completed', JSON.stringify(state));
  await f.restart(); const next = await f.begin('continue-representation-' + representation);
  const retained = next.manifest.sources.find(item => item.id === source.id);
  assert.ok(retained); assert.equal(retained.hash, source.hash); assert.deepEqual(retained.value, value);
  const expectedBody = representation === 'deleted-fulltext' ? content : JSON.stringify(value);
  assert.equal(retained.content, expectedBody);
  const session = await f.reviewSession(next), chunks = []; let cursor;
  do {
    const page = await f.request({ operation: 'read', sessionToken: session.sessionToken, input: { ref: next.objectId, view: 'content', field: 'review_source:' + source.id + ':' + source.hash, limit: 16000, ...(cursor ? { cursor } : {}) } });
    assert.equal(page.sha256, reviewHash(expectedBody)); chunks.push(Buffer.from(page.data, 'base64')); cursor = page.cursor;
  } while (cursor);
  assert.equal(Buffer.concat(chunks).toString('utf8'), expectedBody);
  const captured = f.store.readMigrationSource('learning-review:' + f.sourceRoot, 'runs/old-review/manifest.json');
  assert.deepEqual(JSON.parse(captured.bytes.toString('utf8')), f.manifest);
});

test('a legacy deferred value source keeps its semantic hash and full transport body after cursor import', async t => {
  const f = await legacyReview(t, null), value = { file: path.join(f.project, 'gone.md'), previousHash: 'b'.repeat(64), previousKind: 'memory', contentUnavailable: true };
  const source = { id: 'gone-source', kind: 'deleted_source', projectPath: f.project, hash: reviewHash(JSON.stringify(value)), value };
  fs.writeFileSync(path.join(f.sourceRoot, 'review-state.json'), JSON.stringify({ schemaVersion: 1, sources: {}, deferredSourceIds: [source.id], deferredSources: [source], unresolved: [] }));
  const state = await f.importHistory('import-deferred-value'); assert.equal(state.status, 'completed', JSON.stringify(state));
  await f.restart(); const next = await f.begin('continue-deferred-value'), retained = next.manifest.sources.find(item => item.id === source.id);
  assert.ok(retained); assert.deepEqual(retained.value, value); assert.equal(retained.hash, source.hash); assert.equal(retained.content, JSON.stringify(value));
  assert.equal(f.store.readPage({ ref: next.objectId, field: 'review_source:' + source.id }).sha256, reviewHash(JSON.stringify(value)));
});

for (const status of [null, 'partial']) test(`cross batch legacy ${status ? 'applications' : 'proposals'} preserve every observed fact version for authorized paging`, async t => {
  const f = await legacyReview(t, status), stable = { repository: 'owner/repo', sha: 'f'.repeat(40), files: [], checks: [], statuses: [], gaps: [] };
  const source = date => ({ id: 'github-' + reviewHash('owner/repo:' + stable.sha).slice(0, 24), kind: 'github', projectPath: f.project, hash: reviewHash(JSON.stringify(stable)), value: { ...stable, observedAt: date } });
  const earlier = source('2026-09-16T00:00:00Z'), first = { ...source('2026-09-17T00:00:00Z'), previousVersions: [earlier] }, later = source('2026-09-18T00:00:00Z');
  for (const [runId, snapshot] of [['old-review', first], ['other-review', later]]) {
    const run = path.join(f.sourceRoot, 'runs', runId); fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, 'manifest.json'), JSON.stringify({ ...f.manifest, runId, sources: [snapshot] }));
    fs.writeFileSync(path.join(run, 'proposal.json'), JSON.stringify(f.proposal));
    if (status) fs.writeFileSync(path.join(run, 'application.json'), JSON.stringify({ schemaVersion: 1, status, proposalHash: reviewHash(JSON.stringify(f.proposal)), targetPromptHash: reviewHash(f.proposal.globalPrompt), targetPrompt: f.proposal.globalPrompt, sourceCursor: [snapshot], deferredSources: [] }));
  }
  assert.equal((await f.importHistory('cross-batch-' + status)).status, 'completed');
  await f.restart(); const next = await f.begin('cross-batch-next-' + status), current = next.manifest.sources.find(item => item.id === first.id);
  assert.ok(current);
  assert.equal(new Set([current, ...(current.previousVersions || [])].map(item => item.content)).size, 3, 'all complete observations must remain selectable across batches');
  const session = await f.reviewSession(next);
  for (const snapshot of [earlier, first, later]) {
    const body = JSON.stringify(snapshot.value), page = await f.request({ operation: 'read', sessionToken: session.sessionToken, input: { ref: next.objectId, view: 'content', field: 'review_source:' + first.id + ':' + reviewHash(body) } });
    assert.equal(Buffer.from(page.data, 'base64').toString('utf8'), body); assert.equal(page.sha256, reviewHash(body));
  }
});

test('a failed review wait releases its window but preserves its living formal Agent and later complete proposal', async t => {
  const f = await fixture(t), { runDatabaseLearningReview } = require('../out/learningReviewRunner.js'), { spawn } = require('node:child_process'), { once } = require('node:events');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); await once(child, 'spawn');
  t.after(() => { if (child.exitCode === null) child.kill(); }); let batch, result;
  await assert.rejects(runDatabaseLearningReview({ runId: 'rpc-failed-wait', globalRoot: f.root, workspaceRoot: f.project, globalPrompt: '保留用户目标。', persistedGlobalPrompt: '保留用户目标。', getGlobalPrompt: () => '保留用户目标。', setGlobalPrompt: async () => assert.fail('no application before Agent completion'), operation: f.call,
    launch: async (_prompt, prepared) => {
      batch = prepared; result = f.proposal(batch);
      let run = await f.call('prepare_run', { root: f.project, executionLogId: 1, nodeId: '__solo__', runKind: 'learning_review', prompt: '完整复盘。', command: 'formal-review', userMessage: '复盘经验', metadata: { learningReviewBatchId: batch.objectId }, idempotencyKey: 'prepare-rpc-review' });
      await f.call('claim_run', { root: f.project, executionLogId: 1, expectedRevision: run.revision, agentPid: child.pid, processBirth: '', idempotencyKey: 'claim-rpc-review' });
      f.store.write({ kind: 'review_batch', action: 'patch', scope: f.projectId, objectId: batch.objectId, expectedRevision: batch.revision, idempotencyKey: 'rpc-review-result', data: { proposal_content: JSON.stringify(result) } });
      throw Object.assign(new Error('state RPC connection reset'), { code: 'ECONNRESET' });
    } }), /connection reset/);
  await f.restart(); await assert.rejects(f.begin('retry-while-formal-agent-lives'), /learning_review_owner_alive/);
  const before = f.store.read(batch.objectId); await f.call('interrupt_learning_review', { batchId: batch.objectId });
  assert.equal(f.store.read(batch.objectId).revision, before.revision, 'repeated released-window observations cannot amplify versions');
  const exited = once(child, 'exit'); child.kill(); await exited; await f.restart();
  const next = await f.begin('retry-after-formal-agent-exit');
  const candidate = next.manifest.sources.find(item => item.kind === 'review_proposal' && item.ref.objectId === batch.objectId);
  assert.ok(candidate); assert.deepEqual(JSON.parse(candidate.content).result, result);
});

test('an earlier mistakenly interrupted batch cannot bypass its living formal Agent ownership', async t => {
  const f = await fixture(t), { spawn } = require('node:child_process'), { once } = require('node:events');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); await once(child, 'spawn');
  t.after(() => { if (child.exitCode === null) child.kill(); }); const batch = await f.begin('old-mistaken-interruption');
  let run = await f.call('prepare_run', { root: f.project, executionLogId: 1, nodeId: '__solo__', runKind: 'learning_review', prompt: '完整复盘。', command: 'formal-review', userMessage: '复盘经验', metadata: { learningReviewBatchId: batch.objectId }, idempotencyKey: 'prepare-mistaken-review' });
  await f.call('claim_run', { root: f.project, executionLogId: 1, expectedRevision: run.revision, agentPid: child.pid, processBirth: '', idempotencyKey: 'claim-mistaken-review' });
  f.store.write({ kind: 'review_batch', action: 'patch', scope: f.projectId, objectId: batch.objectId, expectedRevision: batch.revision, idempotencyKey: 'historical-mistaken-interruption', data: { status: 'interrupted', proposal_content: JSON.stringify(f.proposal(batch)) } });
  await f.restart(); await assert.rejects(f.begin('retry-old-mistaken-interruption'), /learning_review_owner_alive/);
  const exited = once(child, 'exit'); child.kill(); await exited;
  assert.ok((await f.begin('after-old-mistaken-agent-exit')).manifest.sources.some(item => item.kind === 'review_proposal' && item.ref.objectId === batch.objectId));
});

test('a launch failure without a living formal Agent permits a new review in the same host', async t => {
  const f = await fixture(t), { runDatabaseLearningReview } = require('../out/learningReviewRunner.js');
  await assert.rejects(runDatabaseLearningReview({ runId: 'launch-never-started', globalRoot: f.root, workspaceRoot: f.project, globalPrompt: '保留用户目标。', persistedGlobalPrompt: '保留用户目标。', getGlobalPrompt: () => '保留用户目标。', setGlobalPrompt: async () => assert.fail(), operation: f.call, launch: async () => { throw new Error('shell launch failed'); } }), /shell launch failed/);
  assert.ok((await f.begin('retry-launch-in-same-host')).objectId);
});

for (const alreadyInterrupted of [false, true]) test(`a ${alreadyInterrupted ? 'historically interrupted' : 'failed terminal delivery'} review retires its unstarted run before a new review can launch`, async t => {
  const f = await fixture(t), { runDatabaseLearningReview } = require('../out/learningReviewRunner.js'), { prepareAgentRun } = require('../out/agentRunPreparation.js');
  const { spawn } = require('node:child_process'), { once } = require('node:events');
  const host = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); await once(host, 'spawn');
  t.after(() => { if (host.exitCode === null) host.kill(); });
  const fields = fs.readFileSync(`/proc/${host.pid}/stat`, 'utf8').split(') ')[1].trim().split(/\s+/);
  const owner = { id: 'original-review-window', pid: host.pid, birth: `proc:${fields[19]}` };
  let batch, prepared;
  const launch = async (_prompt, current) => {
    batch = current;
    prepared = await prepareAgentRun({ agentCli: 'codex', selectedModel: '', prompt: '原完整复盘提示词。🌿', workspaceRoot: f.project, nodeId: '__solo__', executionLogId: 1, userMessage: '复盘经验', runKind: 'learning_review', globalDataPath: f.root, taskPermissionMode: 'default', metadata: { learningReviewBatchId: batch.objectId } }, (operation, input) => f.call(operation, operation === 'prepare_run' ? { ...input, deliveryOwner: owner } : input));
    assert.equal(prepared.status.deliveryPending, true);
    assert.equal(f.store.runProcessAlive(f.projectId, 1), false);
    if (alreadyInterrupted) f.store.write({ kind: 'review_batch', action: 'patch', scope: f.projectId, objectId: batch.objectId, expectedRevision: batch.revision, idempotencyKey: 'old-undelivered-interruption', data: { status: 'interrupted' } });
    else throw new Error('terminal closed before command delivery');
  };
  if (alreadyInterrupted) await launch('', await f.begin('old-undelivered-batch'));
  else await assert.rejects(runDatabaseLearningReview({ runId: 'undelivered-batch', globalRoot: f.root, workspaceRoot: f.project, globalPrompt: '保留用户目标。', persistedGlobalPrompt: '保留用户目标。', operation: f.call, getGlobalPrompt: () => '保留用户目标。', setGlobalPrompt: async () => assert.fail(), launch }), /terminal closed/);
  const originalPlan = f.store.readRunExecutionPlan(f.projectId, 1);
  const next = await f.begin('retry-undelivered-review');
  const stopped = f.store.readRunState(f.projectId, 1);
  assert.equal(stopped.status.stopRequested, true, 'the original prepared run must lose its execution right before retry');
  assert.equal(stopped.status.deliveryPending, false, 'failed review cannot remain queued for a later window');
  assert.deepEqual(f.store.readRunLaunchPermission(f.projectId, { executionLogId: 1, generation: stopped.generation, proof: f.store.readRunCheckpointState(f.projectId, 1).proof, expectedTurnId: stopped.turnId }), { permission: 'deny', reason: 'run_stop_requested' });
  await assert.rejects(f.call('claim_run', { projectId: f.projectId, executionLogId: 1, expectedRevision: stopped.revision, idempotencyKey: 'late-original-review-claim' }), /run_stop_requested/);
  const newRun = await f.call('prepare_run', { root: f.project, executionLogId: 2, nodeId: '__solo__', runKind: 'learning_review', prompt: '新完整复盘。', command: 'new-formal-review', userMessage: '重新复盘', metadata: { learningReviewBatchId: next.objectId }, deliveryOwner: { id: 'new-window', pid: 999999999, birth: 'proc:gone' }, idempotencyKey: 'prepare-new-undelivered-review' });
  const exited = once(host, 'exit'); host.kill(); await exited; await f.restart();
  assert.deepEqual(f.store.listRunDeliveries({}).items.map(run => run.runId), [newRun.runId], 'only the new review may recover delivery after the first host exits');
  await new (require('../out/runRecovery.js').RunRecovery)(f.store).recover();
  const recovered = f.store.readRunState(f.projectId, 1);
  assert.equal(recovered.status.status, 'Failed'); assert.ok(recovered.status.finishedAt);
  assert.equal(recovered.status.deliveryPending, false);
  assert.equal(f.store.readRunExecutionPlan(f.projectId, 1).prompt, originalPlan.prompt);
  assert.equal(f.store.readRunExecutionPlan(f.projectId, 1).command, originalPlan.command);
  assert.equal(f.store.read(batch.objectId).data.status, 'interrupted');
  assert.equal(f.store.read(next.objectId).data.status, 'draft');
  await f.restart(); assert.deepEqual(f.store.listRunDeliveries({}).items.map(run => run.runId), [newRun.runId]);
});

test('an explicit stop revokes queued delivery in its committed run revision', async t => {
  const f = await fixture(t);
  const run = await f.call('prepare_run', { root: f.project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '保留原始输入。', command: 'original-command', userMessage: '目标', deliveryOwner: { id: 'gone-window', pid: 999999999, birth: 'proc:gone' }, idempotencyKey: 'prepare-stopped-delivery' });
  const stopped = f.store.requestRunStop(f.projectId, { executionLogId: 1, generation: run.generation, expectedRevision: run.revision, expectedTurnId: run.turnId, reason: '用户停止。', idempotencyKey: 'revoke-stopped-delivery' });
  assert.equal(stopped.status.deliveryPending, false, 'the accepted stop must persist the delivery revocation');
  assert.equal(f.store.readRunState(f.projectId, 1, stopped.revision).status.deliveryPending, false);
  assert.deepEqual(f.store.listRunDeliveries({}).items, []);
});

test('legacy fact snapshots with the same semantic hash retain both complete observed versions', async t => {
  const f = await legacyReview(t, null), stable = { repository: 'owner/repo', sha: 'c'.repeat(40), files: [], checks: [], statuses: [], gaps: [] };
  const old = { id: 'github-' + reviewHash('owner/repo:' + stable.sha).slice(0, 24), kind: 'github', projectPath: f.project, hash: reviewHash(JSON.stringify(stable)), value: { ...stable, observedAt: '2026-09-17T00:00:00Z' } };
  const current = { ...old, value: { ...stable, observedAt: '2026-09-18T00:00:00Z' }, previousVersions: [old] };
  f.manifest.sources = [current]; fs.writeFileSync(path.join(f.run, 'manifest.json'), JSON.stringify(f.manifest));
  assert.equal((await f.importHistory('same-semantic-version')).status, 'completed');
  await f.restart(); const next = await f.begin('same-semantic-version-next'), retained = next.manifest.sources.find(item => item.id === current.id);
  assert.equal(retained.content, JSON.stringify(current.value), 'the newer observed body cannot be overwritten by its older semantic twin');
  assert.equal(retained.previousVersions[0].content, JSON.stringify(old.value));
  const session = await f.reviewSession(next);
  for (const value of [current.value, old.value]) {
    const body = JSON.stringify(value), page = await f.request({ operation: 'read', sessionToken: session.sessionToken, input: { ref: next.objectId, view: 'content', field: 'review_source:' + current.id + ':' + reviewHash(body) } });
    assert.equal(Buffer.from(page.data, 'base64').toString('utf8'), body); assert.equal(page.sha256, reviewHash(body));
  }
});

for (const invalid of ['github-hash', 'deleted-body', 'deleted-missing']) test(`legacy malformed ${invalid} evidence retains bytes without a typed partial batch`, async t => {
  const f = await legacyReview(t, null), content = '完整旧原文。';
  const value = invalid === 'github-hash'
    ? { repository: 'owner/repo', sha: 'd'.repeat(40), observedAt: '2026-09-18T00:00:00Z' }
    : { file: path.join(f.project, 'old.md'), previousHash: reviewHash(content), previousKind: 'memory' };
  f.manifest.sources = [{ id: invalid === 'github-hash' ? 'github-' + reviewHash('owner/repo:' + value.sha).slice(0, 24) : 'old-source', kind: invalid === 'github-hash' ? 'github' : 'deleted_source', hash: invalid === 'github-hash' ? 'e'.repeat(64) : reviewHash(JSON.stringify(value)), value, ...(invalid === 'deleted-body' ? { content: '被替换的正文。' } : {}) }];
  const bytes = Buffer.from(JSON.stringify(f.manifest)); fs.writeFileSync(path.join(f.run, 'manifest.json'), bytes);
  assert.equal((await f.importHistory('invalid-' + invalid)).status, 'completed_with_conflicts');
  assert.equal(f.store.search({ scope: null, kinds: ['review_batch', 'application', 'policy'] }).items.length, 0);
  assert.deepEqual(f.store.readMigrationSource('learning-review:' + f.sourceRoot, 'runs/old-review/manifest.json').bytes, bytes);
});

test('a legacy completed proposal remains available after import and a Runtime restart', async t => {
  const f = await legacyReview(t, null);
  assert.equal((await f.importHistory('import-old-proposal')).status, 'completed');
  await f.restart();
  const next = await f.begin('old-proposal-next');
  const source = next.manifest.sources.find(item => item.kind === 'review_proposal');
  assert.ok(source, 'the old completed Agent result must be available to the next review');
  assert.deepEqual(JSON.parse(source.content).result, f.proposal);
  assert.equal(next.manifest.sources.find(item => item.id === f.source.id).content, f.source.content);
});

test('a user instruction save supersedes imported partial review work and preserves its original target', async t => {
  const f = await legacyReview(t);
  assert.equal((await f.importHistory('import-old-user-edit')).status, 'completed');
  const old = f.store.search({ scope: null, kinds: ['application'] }).items[0];
  const saved = await f.call('save_global_prompt', { policy: null, source: 'user', content: '用户刚保存的完整要求。', idempotencyKey: 'save-after-legacy-import' });
  assert.equal(f.store.read(old.objectId).data.status, 'superseded');
  assert.equal(f.store.read(old.objectId).data.after_content, f.proposal.globalPrompt);
  await f.restart();
  assert.equal((await f.begin('after-import-user-edit', '用户刚保存的完整要求。')).pending.length, 0);
  assert.equal(f.store.read(saved.objectId).data.content, '用户刚保存的完整要求。');
});

test('Runtime discovery automatically queues legacy review history once and resumes without new domain versions', async t => {
  const f = await legacyReview(t, null);
  const { enqueueAvailableDataMigrations } = require('../out/runtimeDatabaseBootstrap.js');
  const queued = await enqueueAvailableDataMigrations(f.store, f.request, () => true);
  assert.ok(queued.queued > 0, 'startup must discover old review history without a manual import');
  let jobs;
  for (let attempt = 0; attempt < 100; attempt++) {
    jobs = f.store.migrationJobs().filter(job => job.args.collection === 'learning-review');
    if (jobs.length && jobs.every(job => !['queued', 'running'].includes(job.status))) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'completed');
  const before = f.store.search({ scope: null }).sourceSequence;
  await enqueueAvailableDataMigrations(f.store, f.request, () => true);
  assert.equal(f.store.migrationJobs().filter(job => job.args.collection === 'learning-review').length, 1);
  assert.equal(f.store.search({ scope: null }).sourceSequence, before);
  fs.writeFileSync(path.join(f.run, 'output.log'), '旧Agent迟到的完整输出。\n');
  await enqueueAvailableDataMigrations(f.store, f.request, () => true);
  jobs = f.store.migrationJobs().filter(job => job.args.collection === 'learning-review');
  assert.equal(jobs.length, 2, 'new historical files must be discovered after the first completed import');
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await f.call('migration_status', { jobId: jobs[1].jobId });
    if (!['queued', 'running'].includes(state.status)) { assert.equal(state.status, 'completed'); break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(f.store.readMigrationSource(`learning-review:${f.sourceRoot}`, 'runs/old-review/output.log').bytes.toString('utf8'), '旧Agent迟到的完整输出。\n');
});

test('legacy review cursor import preserves complete deferred sources and all their pinned versions', async t => {
  const f = await legacyReview(t, null);
  const old = { ...f.source, content: '更早未处理的全文。', hash: reviewHash('更早未处理的全文。') };
  const held = { ...f.source, previousVersions: [old] };
  fs.writeFileSync(path.join(f.sourceRoot, 'review-state.json'), JSON.stringify({ schemaVersion: 1, lastAppliedRunId: 'older-run', sources: {}, deferredSourceIds: [held.id], deferredSources: [held], unresolved: ['保留待确认事项。'] }));
  assert.equal((await f.importHistory('import-old-cursor')).status, 'completed');
  await f.restart(); const next = await f.begin('old-cursor-next');
  const source = next.manifest.sources.find(item => item.id === held.id);
  assert.ok(source, 'deferred historical sources must be presented to the next review');
  assert.equal(source.content, held.content);
  assert.equal(source.previousVersions?.[0]?.content, old.content, 'the earlier deferred version must survive the file importer and restart');
});

test('an imported partial review cannot expose sources from a project hidden after import', async t => {
  const f = await legacyReview(t);
  assert.equal((await f.importHistory('import-hidden-review')).status, 'completed');
  const project = f.store.read(f.projectId);
  f.store.write({ kind: 'project', action: 'patch', scope: null, objectId: project.objectId, expectedRevision: project.revision, idempotencyKey: 'hide-old-review-project', data: { hidden: 1 } });
  const next = await f.begin('hidden-history-next');
  assert.equal(next.pending.length, 0, 'revoked historical source scope cannot be passed to another review');
  assert.equal(next.manifest.sources.some(item => item.content.includes(f.source.content)), false);
  assert.equal(f.store.search({ scope: null, kinds: ['application'] }).items.length, 1, 'revocation preserves the historical application');
});

test('legacy review import preserves every declared history file and binary attachment with a typed source link', async t => {
  const f = await legacyReview(t, null);
  const originals = new Map([
    ['prompt.txt', Buffer.from('完整复盘提示词🌿\n'.repeat(5000))],
    ['output.log', Buffer.from('完整旧Agent输出\r\n')],
    ['attachments/history.bin', Buffer.from([0, 255, 128, 13, 10, 1])]
  ]);
  for (const [name, bytes] of originals) { const file = path.join(f.run, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
  assert.equal((await f.importHistory('import-all-review-assets')).status, 'completed');
  const identity = `learning-review:${f.sourceRoot}`;
  const batch = f.store.search({ scope: null, kinds: ['review_batch'] }).items[0];
  for (const [name, bytes] of originals) {
    const key = `runs/old-review/${name}`;
    const captured = f.store.readMigrationSource(identity, key);
    assert.deepEqual(captured.bytes, bytes); assert.equal(captured.stage, 'imported');
    const binding = f.store.rows('SELECT object_id AS objectId FROM migration_items WHERE source_identity=? AND source_key=?', [identity, key])[0];
    assert.ok(binding.objectId, 'each physical file must have a typed database binding');
    const asset = f.store.read(binding.objectId);
    assert.equal(asset.kind, 'evidence');
    assert.deepEqual(Buffer.from(asset.data.content.data, 'base64'), bytes);
    assert.ok(f.store.read(batch.objectId).relations.some(link => link.relation === 'source' && link.target === asset.objectId));
  }
});

test('legacy review migration refuses a symbolic runs directory before reading outside files', async t => {
  const f = await legacyReview(t, null), outside = path.join(f.base, 'outside-review-history');
  fs.renameSync(path.join(f.sourceRoot, 'runs'), outside);
  fs.symlinkSync(outside, path.join(f.sourceRoot, 'runs'), 'dir');
  const result = await f.importHistory('refuse-symbolic-review-history');
  assert.notEqual(result.status, 'completed', 'a symbolic history ancestor is not an authorized source tree');
  assert.equal(f.store.search({ scope: null, kinds: ['review_batch', 'application'] }).items.length, 0);
  assert.throws(() => f.store.readMigrationSource(`learning-review:${f.sourceRoot}`, 'runs/old-review/manifest.json'), /migration_source_missing/);
});

test('legacy review import preserves a live old owner and catches up after its unchanged lock loses ownership', async t => {
  const f = await legacyReview(t, null), cp = require('node:child_process');
  const { once } = require('node:events');
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const lock = path.join(f.sourceRoot, 'review.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, processStart: '', runId: 'old-review' }));
  const before = fs.readFileSync(lock);
  const { enqueueAvailableDataMigrations } = require('../out/runtimeDatabaseBootstrap.js');
  await enqueueAvailableDataMigrations(f.store, f.request, () => true);
  let first;
  for (let attempt = 0; attempt < 100; attempt++) {
    first = f.store.migrationJobs().find(job => job.args.collection === 'learning-review');
    if (first && !['queued', 'running'].includes(first.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(first?.status, 'completed_with_conflicts');
  assert.equal(first.progress.conflicts[0].error, 'legacy_review_owner_alive');
  assert.equal(f.store.search({ scope: null, kinds: ['review_batch'] }).items.length, 0);
  const exited = once(child, 'exit'); child.kill(); await exited;
  assert.deepEqual(fs.readFileSync(lock), before, 'migration must not clear the legacy owner lock');
  await enqueueAvailableDataMigrations(f.store, f.request, () => true);
  for (let attempt = 0; attempt < 100; attempt++) {
    const jobs = f.store.migrationJobs().filter(job => job.args.collection === 'learning-review');
    if (jobs.length === 2 && jobs[1].status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(f.store.search({ scope: null, kinds: ['review_batch'] }).items.length, 1);
  assert.deepEqual(fs.readFileSync(lock), before);
});

test('legacy review conflicts retain original bytes and do not create a half imported application', async t => {
  const f = await legacyReview(t);
  const invalid = { ...f.manifest, sources: [{ ...f.source, hash: reviewHash('另一份原文。') }] };
  const bytes = Buffer.from(JSON.stringify(invalid, null, 2) + '\n');
  fs.writeFileSync(path.join(f.run, 'manifest.json'), bytes);
  const result = await f.importHistory('refuse-corrupt-review-hash');
  assert.equal(result.status, 'completed_with_conflicts');
  assert.equal(f.store.search({ scope: null, kinds: ['review_batch', 'application', 'policy'] }).items.length, 0);
  const captured = f.store.readMigrationSource(`learning-review:${f.sourceRoot}`, 'runs/old-review/manifest.json');
  assert.deepEqual(captured.bytes, bytes); assert.equal(captured.stage, 'unmapped');
  assert.deepEqual(fs.readFileSync(path.join(f.run, 'manifest.json')), bytes);
});

test('an instruction save cannot repurpose an unrelated global policy', async t => {
  const f = await fixture(t);
  const unrelated = f.store.write({ kind: 'policy', action: 'create', scope: null, idempotencyKey: 'other-global-policy', data: { kind: 'other_rule', status: 'active', content: '其他策略完整正文。' } });
  await assert.rejects(f.call('save_global_prompt', { policy: { objectId: unrelated.objectId, revision: unrelated.revision }, content: '默认指令。', source: 'user', idempotencyKey: 'wrong-prompt-policy' }), /global_prompt_revision_conflict/);
  assert.equal(f.store.read(unrelated.objectId).revision, unrelated.revision);
  assert.equal(f.store.read(unrelated.objectId).data.content, '其他策略完整正文。');
  assert.equal(await f.call('read_global_prompt_policy', {}), null);
});

for (const operation of ['read', 'search', 'write']) test(`ordinary project MCP cannot ${operation} a host review snapshot without its run proof`, async t => {
  const f = await fixture(t), other = path.join(f.base, 'private'); fs.mkdirSync(other);
  const { projectId } = await f.call('register_project', { root: other });
  f.memory(projectId, '其他项目私有原文。');
  const batch = await f.begin('private-review-' + operation);
  const session = await f.call('open_mcp_session', { projectId: f.projectId });
  const request = input => f.request({ operation, sessionToken: session.sessionToken, input });
  if (operation === 'search') {
    const page = await request({ scope: f.projectId, kinds: ['review_batch'] });
    assert.equal(page.items.some(item => item.objectId === batch.objectId), false);
  } else await assert.rejects(request(operation === 'read'
    ? { ref: batch.objectId, view: 'full' }
    : { action: 'patch', kind: 'review_batch', scope: f.projectId, objectId: batch.objectId, expectedRevision: batch.revision, idempotencyKey: 'unauthorized-proposal', data: { proposal_content: JSON.stringify(f.proposal(batch)) } }), /scope_denied/);
});

for(const view of ['full','content','export-json','export-md','export-text'])test(`review ${view} cannot expose unavailable deferred control bodies`,async t=>{
 const f=await fixture(t),privateRoot=path.join(f.base,'private');fs.mkdirSync(privateRoot);const {projectId}=await f.call('register_project',{root:privateRoot});const marker='不可公开的延期私有正文🌿';const held=f.memory(projectId,marker,'私有延期');
 const first=await f.begin('privacy-before-hide'),source=first.manifest.sources.find(item=>item.ref?.objectId===held.objectId),result=f.proposal(first);result.deferredSourceIds=[source.id];result.processedSourceIds=result.processedSourceIds.filter(id=>id!==source.id);
 const applied=await f.apply(first,result);await f.call('finish_learning_review',{applicationId:applied.application.objectId,expectedRevision:applied.application.revision,promptHash:reviewHash(result.globalPrompt),idempotencyKey:'finish-privacy-before-hide'});
 const project=f.store.read(projectId);f.store.write({kind:'project',action:'patch',scope:null,objectId:project.objectId,expectedRevision:project.revision,idempotencyKey:'privacy-hide',data:{hidden:1}});
 const batch=await f.begin('privacy-hidden'),session=await f.reviewSession(batch);assert.ok(!JSON.stringify(batch.manifest).includes(marker));
 const call=input=>f.request({operation:'read',sessionToken:session.sessionToken,input});await assert.rejects(call({ref:batch.objectId,view:'content',field:'review_source:'+source.id}),/review_source_missing|scope_denied/);
 if(view==='content')await assert.rejects(call({ref:batch.objectId,view:'content',field:'review_content',limit:127}),/review_input_requires_host|scope_denied/);
 else if(view==='full'){const full=await call({ref:batch.objectId,view:'full'});assert.ok(!JSON.stringify(full).includes(marker),'ordinary full read must not contain hidden previous.deferredSources');}
 else {const destination=path.join(f.root,'exports','review.json');await f.request({operation:'export',sessionToken:session.sessionToken,input:{ref:batch.objectId,format:view.slice('export-'.length),destination,idempotencyKey:'privacy-export'}});assert.ok(!fs.readFileSync(destination,'utf8').includes(marker),'ordinary export must use the same public review content as reads');}
});
for(const view of ['metadata','full','source','export'])test(`review ${view} rechecks project visibility after batch preparation`,async t=>{
 const f=await fixture(t),privateRoot=path.join(f.base,'private');fs.mkdirSync(privateRoot);const {projectId}=await f.call('register_project',{root:privateRoot});const held=f.memory(projectId,'后来隐藏的私有正文。','后来隐藏');
 const batch=await f.begin('privacy-scope-changes'),source=batch.manifest.sources.find(item=>item.ref?.objectId===held.objectId),session=await f.reviewSession(batch);assert.ok(source);
 const project=f.store.read(projectId);f.store.write({kind:'project',action:'patch',scope:null,objectId:project.objectId,expectedRevision:project.revision,idempotencyKey:'privacy-later-hide',data:{hidden:1}});
 const request=view==='export'?{operation:'export',sessionToken:session.sessionToken,input:{ref:batch.objectId,format:'json',destination:path.join(f.root,'exports','revoked.json'),idempotencyKey:'privacy-revoked-export'}}:{operation:'read',sessionToken:session.sessionToken,input:{ref:batch.objectId,view:view==='source'?'content':view,...(view==='source'?{field:'review_source:'+source.id}: {})}};
 await assert.rejects(f.request(request),/scope_denied|review_source_scope_changed/,'the run credential cannot extend a revoked project grant');assert.equal(fs.existsSync(path.join(f.root,'exports','revoked.json')),false);
});

test('host review application rechecks the current source scope before any mutation', async t => {
  const f = await fixture(t), privateRoot = path.join(f.base, 'private'); fs.mkdirSync(privateRoot);
  const { projectId } = await f.call('register_project', { root: privateRoot }); f.memory(projectId, '隐藏后不能被本轮采用的来源。', '应用来源');
  const batch = await f.begin('host-scope-revoked'), result = f.proposal(batch), project = f.store.read(projectId), before = f.store.read(batch.policy.objectId);
  f.store.write({ kind: 'project', action: 'patch', scope: null, objectId: project.objectId, expectedRevision: project.revision, idempotencyKey: 'hide-before-host-apply', data: { hidden: 1 } });
  await assert.rejects(f.apply(batch, result), /learning_review_source_scope_changed/);
  assert.deepEqual(f.store.read(batch.policy.objectId), before); assert.equal(f.store.read(batch.objectId).data.status, 'draft');
  assert.equal(f.store.search({ scope: f.projectId, kinds: ['application'] }).items.length, 0);
  assert.equal(f.store.rows("SELECT COUNT(*) AS n FROM settings WHERE namespace='learning_review' AND key='cursor'")[0].n, 0);
});

test('a review source pagination cursor cannot retain a subsequently hidden project grant', async t => {
  const f = await fixture(t), privateRoot = path.join(f.base, 'private'); fs.mkdirSync(privateRoot);
  const { projectId } = await f.call('register_project', { root: privateRoot }), held = f.memory(projectId, '完整的私有来源🌿'.repeat(150), '分页来源');
  const batch = await f.begin('page-scope-revoked'), source = batch.manifest.sources.find(item => item.ref?.objectId === held.objectId), session = await f.reviewSession(batch);
  const input = { ref: batch.objectId, revision: batch.revision, view: 'content', field: 'review_source:' + source.id, limit: 73 }, request = input => f.request({ operation: 'read', sessionToken: session.sessionToken, input });
  const first = await request(input); assert.ok(first.cursor); const project = f.store.read(projectId);
  f.store.write({ kind: 'project', action: 'patch', scope: null, objectId: project.objectId, expectedRevision: project.revision, idempotencyKey: 'hide-between-pages', data: { hidden: 1 } });
  await assert.rejects(request({ ...input, cursor: first.cursor }), /scope_denied|review_source_scope_changed/);
});

test('review search excludes a batch after a source project is hidden', async t => {
  const f = await fixture(t), privateRoot = path.join(f.base, 'private'); fs.mkdirSync(privateRoot);
  const { projectId } = await f.call('register_project', { root: privateRoot }); f.memory(projectId, '私有检索来源。', '检索来源');
  const batch = await f.begin('search-scope-revoked'), session = await f.reviewSession(batch), project = f.store.read(projectId);
  f.store.write({ kind: 'project', action: 'patch', scope: null, objectId: project.objectId, expectedRevision: project.revision, idempotencyKey: 'hide-before-query', data: { hidden: 1 } });
  const page = await f.request({ operation: 'search', sessionToken: session.sessionToken, input: { scope: f.projectId, kinds: ['review_batch'] } });
  assert.equal(page.items.some(item => item.objectId === batch.objectId), false, 'query results cannot bypass the current review source grant');
});

test('public review reads and exports do not decode private host control content', async t => {
  const f = await fixture(t), batch = await f.begin('private-control-cost'), session = await f.reviewSession(batch);
  const controlId = f.store.readMetadata(batch.objectId).data.review_content_id, original = f.store.decodedContent.bind(f.store); let privateDecodes = 0;
  f.store.decodedContent = id => { if (id === controlId) privateDecodes++; return original(id); };
  const full = await f.request({ operation: 'read', sessionToken: session.sessionToken, input: { ref: batch.objectId, view: 'full' } });
  assert.equal(full.data.review_content, undefined); assert.equal(full.projection.hostReview, true);
  await f.request({ operation: 'export', sessionToken: session.sessionToken, input: { ref: batch.objectId, format: 'json', destination: path.join(f.root, 'exports', 'public-cost.json'), idempotencyKey: 'public-control-cost' } });
  assert.equal(privateDecodes, 0, 'private host fields must be projected before full content decoding');
});

test('a cursor with an omitted field cannot expose host review control input', async t => {
  const f = await fixture(t), batch = await f.begin('host-control-cursor'), session = await f.reviewSession(batch);
  const page = f.store.readPage({ ref: batch.objectId, field: 'review_content', limit: 17 });
  assert.ok(page.cursor);
  await assert.rejects(f.request({ operation: 'read', sessionToken: session.sessionToken, input: { ref: batch.objectId, view: 'content', cursor: page.cursor, limit: 17 } }), /review_input_requires_host/);
  const parts = [Buffer.from(page.data, 'base64')]; let cursor = page.cursor;
  do { const next = f.store.readPage({ ref: batch.objectId, cursor, limit: 127 }); parts.push(Buffer.from(next.data, 'base64')); cursor = next.cursor; } while (cursor);
  assert.equal(Buffer.concat(parts).toString('utf8'), f.store.read(batch.objectId).data.review_content);
});

for (const format of ['json', 'md', 'text']) test(`a replayed ${format} export cannot reuse unprojected host review content`, async t => {
  const f = await fixture(t), batch = await f.begin('unsafe-cached-' + format), session = await f.reviewSession(batch);
  const input = { ref: batch.objectId, format, destination: path.join(f.root, 'exports', 'cached.' + format), idempotencyKey: 'unsafe-cached-export' };
  const write = f.store.writeFileAtStableParent;
  try {
    f.store.writeFileAtStableParent = function (file, ...args) { if (file === input.destination) throw new Error('fixture export delivery interrupted'); return write.call(this, file, ...args); };
    await assert.rejects(f.store.withActor(session.actorId, () => f.store.export(input)), /fixture export delivery interrupted/);
  } finally { f.store.writeFileAtStableParent = write; }
  assert.equal(fs.existsSync(input.destination), false);
  await assert.rejects(f.request({ operation: 'export', sessionToken: session.sessionToken, input }), /export_authorization_changed/);
  assert.equal(fs.existsSync(input.destination), false, 'a saved unsafe request cannot deliver its old private payload');
});

test('authorized public export replay retains its pinned proposal after later edits', async t => {
  const f = await fixture(t), batch = await f.begin('public-cached'), session = await f.reviewSession(batch);
  const input = { ref: batch.objectId, format: 'json', destination: path.join(f.root, 'exports', 'public.json'), idempotencyKey: 'public-cached-export' };
  const original = await f.request({ operation: 'export', sessionToken: session.sessionToken, input }), bytes = fs.readFileSync(input.destination);
  await f.request({ operation: 'write', sessionToken: session.sessionToken, input: { kind: 'review_batch', action: 'patch', scope: f.projectId, objectId: batch.objectId, expectedRevision: batch.revision, idempotencyKey: 'proposal-after-export', data: { proposal_content: JSON.stringify(f.proposal(batch)) } } });
  assert.deepEqual(await f.request({ operation: 'export', sessionToken: session.sessionToken, input }), original);
  assert.deepEqual(fs.readFileSync(input.destination), bytes);
});

test('an already archived project is excluded from fresh review scope and does not prevent the result',async t=>{
 const f=await fixture(t),privateRoot=path.join(f.base,'archived');fs.mkdirSync(privateRoot);const {projectId}=await f.call('register_project',{root:privateRoot});f.memory(projectId,'已归档项目正文。','archived');const p=f.store.read(projectId);
 f.store.write({kind:'project',action:'archive',scope:null,objectId:p.objectId,expectedRevision:p.revision,idempotencyKey:'archive-before-prepare',data:{}});
 const batch=await f.begin('exclude-already-archived');assert.equal(batch.manifest.projects.includes(privateRoot),false);const session=await f.reviewSession(batch);
 await f.request({operation:'read',sessionToken:session.sessionToken,input:{ref:batch.objectId,view:'metadata'}});await f.apply(batch,f.proposal(batch));
});
for(const format of ['json','md','text'])test(`restart recovery cannot deliver an unprojected ${format} review export`,async t=>{
 const f=await fixture(t),batch=await f.begin('outbox-unsafe-'+format),session=await f.reviewSession(batch),input={ref:batch.objectId,format,destination:path.join(f.root,'exports','pending.'+format),idempotencyKey:'unsafe-pending'};
 const write=f.store.writeFileAtStableParent;
 try{f.store.writeFileAtStableParent=function(file,...args){if(file===input.destination)throw Error('fixture delivery interrupted');return write.call(this,file,...args);};await assert.rejects(f.store.withActor(session.actorId,()=>f.store.export(input)),/fixture delivery interrupted/);}finally{f.store.writeFileAtStableParent=write;}
 await f.restart();const recovered=await f.store.recoverOutbox();assert.equal(fs.existsSync(input.destination),false,'Runtime startup must enforce the same public projection as explicit export retry');assert.ok(recovered.pending.some(p=>p.error==='export_authorization_changed'));
});
for(const recover of [false,true])test(`${recover?'outbox':'explicit'} export rechecks source scope after asynchronous destination preparation`,async t=>{
 const f=await fixture(t),privateRoot=path.join(f.base,'private');fs.mkdirSync(privateRoot);const {projectId}=await f.call('register_project',{root:privateRoot});f.memory(projectId,'准备目录时撤销的私有来源。','delivery');const batch=await f.begin('delivery-race'),session=await f.reviewSession(batch),input={ref:batch.objectId,format:'json',destination:path.join(f.root,'exports','race.json'),idempotencyKey:'race-export'};
 if(recover){const write=f.store.writeFileAtStableParent;try{f.store.writeFileAtStableParent=function(file,...args){if(file===input.destination)throw Error('fixture delivery interrupted');return write.call(this,file,...args);};await assert.rejects(f.request({operation:'export',sessionToken:session.sessionToken,input}),/fixture delivery interrupted/);}finally{f.store.writeFileAtStableParent=write;}}
 const mkdir=fs.promises.mkdir;let revoked=false;
 try{fs.promises.mkdir=async(dir,...args)=>{const result=await mkdir(dir,...args);if(dir===path.dirname(input.destination)&&!revoked){revoked=true;const p=f.store.read(projectId);f.store.write({kind:'project',action:'patch',scope:null,objectId:p.objectId,expectedRevision:p.revision,idempotencyKey:'hide-during-mkdir',data:{hidden:1}});}return result;};
 if(recover){const result=await f.store.recoverOutbox();assert.ok(result.pending.some(p=>/scope_denied|scope_changed/.test(p.error)));}else await assert.rejects(f.request({operation:'export',sessionToken:session.sessionToken,input}),/scope_denied|scope_changed/);
 }finally{fs.promises.mkdir=mkdir;}
 assert.equal(revoked,true);assert.equal(fs.existsSync(input.destination),false);
 const project=f.store.read(projectId);f.store.write({kind:'project',action:'patch',scope:null,objectId:project.objectId,expectedRevision:project.revision,idempotencyKey:'restore-delivery-scope',data:{hidden:0}});
 await f.restart();const resumed=await f.store.recoverOutbox();assert.equal(resumed.pending.length,0);assert.ok(fs.existsSync(input.destination));assert.equal(JSON.parse(fs.readFileSync(input.destination,'utf8')).data.review_content,undefined);
});

for (const revoked of [false, true]) test(`pending public export ${revoked ? 'retains a revoked connector grant' : 'survives session closure and restart'}`, async t => {
 const f=await fixture(t),batch=await f.begin('public-pending-grant'),session=await f.reviewSession(batch),input={ref:batch.objectId,format:'json',destination:path.join(f.root,'exports','grant.json'),idempotencyKey:'pending-grant'};
 const publicObject=await f.request({operation:'read',sessionToken:session.sessionToken,input:{ref:batch.objectId,view:'full'}}),write=f.store.writeFileAtStableParent;
 try{f.store.writeFileAtStableParent=function(file,...args){if(file===input.destination)throw Error('fixture delivery interrupted');return write.call(this,file,...args);};await assert.rejects(f.request({operation:'export',sessionToken:session.sessionToken,input}),/fixture delivery interrupted/);}finally{f.store.writeFileAtStableParent=write;}
 await f.call('close_mcp_session',{sessionToken:session.sessionToken});
 if(revoked){const grant=f.store.rows('SELECT id FROM grants WHERE actor_id=? AND target_id=?',[session.authorityActorId,f.projectId])[0],object=f.store.read(grant.id);f.store.write({kind:'grant',action:'archive',scope:f.projectId,objectId:object.objectId,expectedRevision:object.revision,idempotencyKey:'revoke-export-connector',data:{}});}
 await f.restart();const recovered=await f.store.recoverOutbox();
 if(revoked){assert.equal(fs.existsSync(input.destination),false);assert.ok(recovered.pending.some(p=>p.error==='action_denied'));}
 else{assert.equal(recovered.pending.length,0);assert.deepEqual(JSON.parse(fs.readFileSync(input.destination,'utf8')),publicObject);}
});

for(const check of ['matches','decode','index'])test(`review search ${check} excludes hidden deferred private control`,async t=>{
 const f=await fixture(t),privateRoot=path.join(f.base,'private');fs.mkdirSync(privateRoot);const {projectId}=await f.call('register_project',{root:privateRoot}),marker='PRIVATEDEFERREDCONTROLZZX';const held=f.memory(projectId,marker,'private-marker');
 const prior=await f.begin('private-before-search'),source=prior.manifest.sources.find(s=>s.ref?.objectId===held.objectId),result=f.proposal(prior);result.processedSourceIds=result.processedSourceIds.filter(id=>id!==source.id);result.deferredSourceIds=[source.id];const applied=await f.apply(prior,result);await f.call('finish_learning_review',{applicationId:applied.application.objectId,expectedRevision:applied.application.revision,promptHash:reviewHash(result.globalPrompt),idempotencyKey:'finish-private-search'});
 const p=f.store.read(projectId);f.store.write({kind:'project',action:'patch',scope:null,objectId:p.objectId,expectedRevision:p.revision,idempotencyKey:'hide-private-search',data:{hidden:1}});
 const batch=await f.begin('private-hidden-search'),session=await f.reviewSession(batch),controlId=f.store.readMetadata(batch.objectId).data.review_content_id,decode=f.store.decodedContent.bind(f.store);let privateDecodes=0;
 f.store.decodedContent=id=>{if(id===controlId)privateDecodes++;return decode(id);};
 const page=await f.request({operation:'search',sessionToken:session.sessionToken,input:{scope:f.projectId,kinds:['review_batch'],query:marker,limit:1}});
 if(check==='matches'){assert.equal(page.items.length,0,'private original text cannot be inferred from query matches');assert.equal(page.cursor,null);}else if(check==='decode')assert.equal(privateDecodes,0,'search must apply the same pre-decode public projection');else assert.equal(f.store.rows('SELECT id FROM objects WHERE id=? AND rowid IN (SELECT rowid FROM object_search WHERE object_search MATCH ?)',[batch.objectId,queryTokens(marker)]).length,0,'private control text must not occupy the public object index');
});

test('authorized review batch permits only its proposal through the original project MCP', async t => {
  const f = await fixture(t); f.memory(f.projectId, '供本次用户授权复盘的正文。');
  const batch = await f.begin('agent-proposal');
  assert.equal(f.store.read(batch.objectId).projectId, f.projectId);
  const session = await f.reviewSession(batch);
  const result = f.proposal(batch);
  const receipt = await f.request({ operation: 'write', sessionToken: session.sessionToken, input: { kind: 'review_batch', action: 'patch', scope: f.projectId, objectId: batch.objectId, expectedRevision: batch.revision, idempotencyKey: 'agent-proposal', data: { proposal_content: JSON.stringify(result) } } });
  assert.equal(receipt.revision, batch.revision + 1);
  await assert.rejects(f.request({ operation: 'write', sessionToken: session.sessionToken, input: { kind: 'review_batch', action: 'patch', scope: f.projectId, objectId: batch.objectId, expectedRevision: receipt.revision, idempotencyKey: 'tamper-input', data: { review_content: '{}' } } }), /review_input_requires_host/);
  await assert.rejects(f.request({ operation: 'write', sessionToken: session.sessionToken, input: { kind: 'review_batch', action: 'archive', scope: f.projectId, objectId: batch.objectId, expectedRevision: receipt.revision, idempotencyKey: 'archive-authorized-batch', data: {} } }), /review_input_requires_host/);
  const applied = await f.apply({ ...batch, revision: receipt.revision }, result);
  assert.equal(f.store.read(applied.policy.objectId).data.content, result.globalPrompt);
});

test('one accepted review cannot create another application under a different retry intent', async t => {
  const f = await fixture(t), batch = await f.begin('same-batch'), result = f.proposal(batch);
  await f.apply(batch, result, 'accepted-review');
  await assert.rejects(f.apply(batch, result, 'different-intent'), /learning_review_already_accepted/);
  assert.equal(f.store.search({ scope: f.projectId, kinds: ['application'] }).items.length, 1);
});

test('review MCP source pages retain cross-project fixed bytes without widening ordinary reads', async t => {
  const f = await fixture(t), other = path.join(f.base, 'private-other'); fs.mkdirSync(other);
  const { projectId } = await f.call('register_project', { root: other });
  const sourceObject = f.memory(projectId, '另一项目的用户授权复盘正文🌿'.repeat(1000));
  const batch = await f.begin('fixed-source'), source = batch.manifest.sources.find(s => s.ref.objectId === sourceObject.objectId);
  const session = await f.reviewSession(batch);
  const index = await f.request({ operation: 'read', sessionToken: session.sessionToken, input: { ref: batch.objectId, revision: batch.revision, view: 'metadata' } });
  assert.equal(index.projection.sources.find(s => s.id === source.id).hash, source.hash);
  assert.equal(index.projection.sources.some(s => Object.hasOwn(s, 'content')), false);
  await assert.rejects(f.request({ operation: 'read', sessionToken: session.sessionToken, input: { ref: sourceObject.objectId, view: 'full' } }), /scope_denied/);
  const parts = []; let cursor;
  do {
    const page = await f.request({ operation: 'read', sessionToken: session.sessionToken, input: { ref: batch.objectId, revision: batch.revision, view: 'content', field: 'review_source:' + source.id, limit: 73, ...(cursor ? { cursor } : {}) } });
    assert.equal(page.sha256, source.hash); parts.push(Buffer.from(page.data, 'base64')); cursor = page.cursor;
  } while (cursor);
  assert.equal(Buffer.concat(parts).toString('utf8'), source.content);
});

test('review MCP proof binds one real run and survives a database owner restart without granting other runs access', async t => {
  const f = await fixture(t), batch = await f.begin('proof-boundary'), session = await f.reviewSession(batch);
  const runIdentity = { executionLogId: 1, generation: session.state.generation, proof: session.state.proof };
  await assert.rejects(f.call('open_mcp_session', { projectId: f.projectId, runIdentity: { ...runIdentity, proof: '0'.repeat(64) } }), /run_proof_denied/);
  await assert.rejects(f.call('open_mcp_session', { projectId: f.projectId, runIdentity: { ...runIdentity, generation: runIdentity.generation + 1 } }), /run_owner_conflict/);
  await assert.rejects(f.call('prepare_run', { root: f.project, executionLogId: 2, nodeId: '__solo__', runKind: 'learning_review', prompt: '重复复盘', command: 'duplicate', userMessage: '复盘', metadata: { learningReviewBatchId: batch.objectId }, idempotencyKey: 'duplicate-review-run' }), /learning_review_run_conflict/);
  assert.throws(() => f.store.readRunState(f.projectId, 2), /run_missing/);
  const normal = await f.call('prepare_run', { root: f.project, executionLogId: 3, nodeId: '__solo__', runKind: 'solo', prompt: '正常任务', command: 'normal', userMessage: '任务', idempotencyKey: 'normal-run' });
  const ordinary = await f.call('open_mcp_session', { projectId: f.projectId, runIdentity: { executionLogId: 3, generation: normal.generation, proof: normal.proof } });
  await assert.rejects(f.request({ operation: 'read', sessionToken: ordinary.sessionToken, input: { ref: batch.objectId } }), /scope_denied/);
  await f.restart();
  const resumed = await f.call('open_mcp_session', { projectId: f.projectId, resume: { actorId: session.actorId, proof: session.proof }, runIdentity });
  const read = await f.request({ operation: 'read', sessionToken: resumed.sessionToken, input: { ref: batch.objectId } });
  assert.equal(read.projection.hostReview, true); assert.equal(read.data.input_hash, reviewHash(JSON.stringify(batch.manifest)));
  await assert.rejects(f.request({ operation: 'read', sessionToken: session.sessionToken, input: { ref: batch.objectId } }), /mcp_session_expired/);
});

test('distributed client and the packaged stdio MCP bridge carry the current review proof through the real transport', async t => {
  const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');
  const { openDataClient } = require('../resources/tools/solomap-data-client.cjs');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const f = await fixture(t), batch = await f.begin('transport-proof'), bound = await f.reviewSession(batch);
  const server = await startRuntimeControlServer({ globalDataPath: f.root, runtimeId: 'review-transport-owner', entryPath: path.resolve('out/autonomousRuntimeProcess.js'), onCommand: () => ({ status: 'running' }), onData: request => f.request(request) });
  const env = { ...process.env, SOLOMAP_PROJECT_ID: f.projectId, SOLOMAP_EXECUTION_LOG_ID: '1', SOLOMAP_RUN_GENERATION: String(bound.state.generation), SOLOMAP_RUN_PROOF: bound.state.proof };
  const saved = Object.fromEntries(Object.keys(env).filter(key => key.startsWith('SOLOMAP_')).map(key => [key, process.env[key]]));
  let dataClient, mcp;
  try {
    for (const key of ['SOLOMAP_PROJECT_ID', 'SOLOMAP_EXECUTION_LOG_ID', 'SOLOMAP_RUN_GENERATION', 'SOLOMAP_RUN_PROOF']) process.env[key] = env[key];
    dataClient = await openDataClient(f.root, f.project);
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.equal((await dataClient.call('read', { ref: batch.objectId, view: 'metadata' })).projection.hostReview, true);
    mcp = new Client({ name: 'formal-review-proof-test', version: '1.0.0' });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('out/databaseMcpProcess.js'), '--global-data-path', f.root], cwd: f.project, env, stderr: 'pipe' }));
    const response = await mcp.callTool({ name: 'solomap_read', arguments: { ref: batch.objectId, view: 'metadata' } });
    assert.equal(response.isError, undefined, JSON.stringify(response.content));
    assert.equal(JSON.parse(response.content[0].text).projection.hostReview, true);
    const denied = await mcp.callTool({ name: 'solomap_write', arguments: { kind: 'policy', action: 'patch', objectId: batch.policy.objectId, expectedRevision: batch.policy.revision, idempotencyKey: 'bridge-cannot-apply-policy', data: { content: '越权结果' } } });
    assert.equal(denied.isError, true); assert.equal(f.store.read(batch.policy.objectId).data.content, batch.manifest.globalPrompt);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (mcp) await mcp.close(); if (dataClient) await dataClient.close(); await server.close();
  }
});

test('manual database review generates and applies its prompt through one launch without permanent review files', async t => {
  const { runDatabaseLearningReview } = require('../out/learningReviewRunner.js');
  const f = await fixture(t); f.memory(f.projectId, '用户要求保留功能。');
  let persisted = '保留用户目标。', launches = 0;
  const answer = await runDatabaseLearningReview({ runId: 'real-runner', globalRoot: f.root, workspaceRoot: f.project, globalPrompt: persisted, persistedGlobalPrompt: persisted,
    operation: f.call, getGlobalPrompt: () => persisted, setGlobalPrompt: async value => { persisted = value; },
    launch: async (prompt, batch) => {
      launches += 1; assert.match(prompt, /完整全局默认提示词/); assert.match(prompt, new RegExp(batch.objectId));
      assert.doesNotMatch(prompt, /maintenance\/runs|review-state\.json|application\.json|manifest\.json/);
      const session = await f.reviewSession(batch);
      const current = await f.request({ operation: 'read', sessionToken: session.sessionToken, input: { ref: batch.objectId, view: 'metadata' } });
      assert.ok(current.projection.sources.length);
      await f.request({ operation: 'write', sessionToken: session.sessionToken, input: { kind: 'review_batch', action: 'patch', scope: f.projectId, objectId: batch.objectId, expectedRevision: current.revision, idempotencyKey: 'runner-result', data: { proposal_content: JSON.stringify(f.proposal(batch)) } } });
    } });
  assert.equal(launches, 1); assert.equal(answer.status, 'applied');
  assert.equal(f.store.read(answer.applicationId).data.status, 'applied');
  assert.equal(f.store.read(answer.policy.objectId, answer.policy.revision).data.content, persisted);
  assert.equal(fs.existsSync(path.join(f.root, 'maintenance')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'context')), false);
});

test('manual database review preserves the accepted full result when the host setting projection fails', async t => {
  const { runDatabaseLearningReview } = require('../out/learningReviewRunner.js');
  const f = await fixture(t); f.memory(f.projectId, '明确的用户要求。');
  const persisted = '保留用户目标。';
  const answer = await runDatabaseLearningReview({ runId: 'host-interrupted', globalRoot: f.root, workspaceRoot: f.project, globalPrompt: persisted, persistedGlobalPrompt: persisted,
    operation: f.call, getGlobalPrompt: () => persisted, setGlobalPrompt: async () => { throw new Error('host setting disconnected'); },
    launch: async (_prompt, batch) => { f.store.write({ kind: 'review_batch', action: 'patch', scope: f.projectId, objectId: batch.objectId, expectedRevision: batch.revision, idempotencyKey: 'interrupted-result', data: { proposal_content: JSON.stringify(f.proposal(batch)) } }); } });
  assert.equal(answer.status, 'partial'); assert.deepEqual(answer.errors, ['host setting disconnected']);
  assert.equal(f.store.read(answer.applicationId).data.status, 'applying');
  assert.equal(f.store.read(answer.policy.objectId, answer.policy.revision).data.content, persisted);
  await f.restart();
  assert.equal((await f.begin('host-recovery')).pending[0].objectId, answer.applicationId);
});

test('formal review includes existing user rule files as pinned read-only evidence without treating old memory directories as authority', async t => {
  const f = await fixture(t);
  const globalFile = path.join(path.dirname(f.root), 'agent.md'), projectFile = path.join(f.project, 'AGENTS.md');
  fs.writeFileSync(globalFile, '共享用户约束全文。\n'); fs.writeFileSync(projectFile, '项目规则全文。\n');
  const batch = await f.begin('user-rules');
  const shared = batch.manifest.sources.find(s => s.kind === 'global_constraint');
  const local = batch.manifest.sources.find(s => s.kind === 'project_constraint');
  assert.equal(shared.content, fs.readFileSync(globalFile, 'utf8')); assert.equal(local.content, fs.readFileSync(projectFile, 'utf8'));
  assert.equal(shared.file, globalFile); assert.equal(local.file, projectFile);
  fs.writeFileSync(projectFile, '用户后续修改的规则。\n');
  const page = await f.call('read', { ref: batch.objectId, revision: batch.revision, view: 'content', field: 'review_source:' + local.id });
  assert.equal(Buffer.from(page.data, 'base64').toString('utf8'), '项目规则全文。\n');
  assert.equal(fs.readFileSync(projectFile, 'utf8'), '用户后续修改的规则。\n');
});

test('formal review stores the actual persisted policy baseline when applying an unsaved editor draft', async t => {
  const f = await fixture(t), batch = await f.call('prepare_learning_review', { runId: 'draft-baseline', workspaceRoot: f.project, globalPrompt: '未保存的用户草稿。', persistedGlobalPrompt: '保留用户目标。' });
  const applied = await f.apply(batch, f.proposal(batch));
  assert.equal(f.store.read(applied.application.objectId).data.before_content, '保留用户目标。');
  assert.equal(f.store.read(applied.policy.objectId).data.content, '未保存的用户草稿。');
});

test('ordinary review claims cannot claim the host review lease or lose their existing proposal editing contract', async t => {
  const f = await fixture(t), session = await f.call('open_mcp_session', { projectId: f.projectId });
  const claim = await f.request({ operation: 'write', sessionToken: session.sessionToken, input: { kind: 'review_batch', action: 'create', scope: f.projectId, idempotencyKey: 'ordinary-review-claim', data: {
    input_cursor: 0, input_hash: reviewHash('claim'), status: 'draft', review_content: JSON.stringify({ runId: 'ordinary-claim', owner: { pid: process.pid, birth: '' }, manifest: { sources: [], gaps: [], globalPrompt: '未授权的声明。' } })
  } } });
  assert.ok((await f.begin('authorized-after-claim')).objectId);
  const edit = await f.request({ operation: 'write', sessionToken: session.sessionToken, input: { kind: 'review_batch', action: 'patch', scope: f.projectId, objectId: claim.objectId, expectedRevision: claim.revision, idempotencyKey: 'ordinary-review-edit', data: { review_content: JSON.stringify({ conclusion: '普通 Agent 修改自己的待审声明。' }) } } });
  assert.equal(edit.revision, claim.revision + 1);
});

test('the next manual click resumes the full accepted prompt when its host projection failed before changing settings', async t => {
  const { runDatabaseLearningReview } = require('../out/learningReviewRunner.js');
  const f = await fixture(t), original = f.memory(f.projectId, '用户要求在交付前核验真实结果。');
  let persisted = '保留用户目标。'; const full = persisted + '\n交付前核验真实结果。'; let prior;
  const launch = async (_prompt, batch) => {
    const source = batch.manifest.sources.find(s => s.ref?.objectId === original.objectId); assert.ok(source, 'pending accepted evidence must remain available to the recovering Agent');
    const result = f.proposal(batch, full); result.changes = [{ type: 'add', before: [], after: '交付前核验真实结果。', evidence: [source.id], reason: '实际用户要求。' }];
    f.store.write({ kind: 'review_batch', action: 'patch', scope: f.projectId, objectId: batch.objectId, expectedRevision: batch.revision, idempotencyKey: 'resume-proposal:' + batch.objectId, data: { proposal_content: JSON.stringify(result) } });
  };
  const first = await runDatabaseLearningReview({ runId: 'changed-projection-fail', globalRoot: f.root, workspaceRoot: f.project, globalPrompt: persisted, persistedGlobalPrompt: persisted, operation: f.call, getGlobalPrompt: () => persisted, setGlobalPrompt: async () => { throw new Error('setting write interrupted'); }, launch });
  assert.equal(first.status, 'partial'); prior = first.applicationId; assert.equal(f.store.read(first.policy.objectId).data.content, full);
  await f.restart();
  const next = await runDatabaseLearningReview({ runId: 'changed-projection-resume', globalRoot: f.root, workspaceRoot: f.project, globalPrompt: persisted, persistedGlobalPrompt: persisted, operation: f.call, getGlobalPrompt: () => persisted, setGlobalPrompt: async value => { persisted = value; }, launch });
  assert.equal(next.status, 'applied'); assert.equal(persisted, full);
  assert.equal(f.store.read(prior).data.status, 'resumed'); assert.equal(f.store.read(next.applicationId).data.status, 'applied');
});

test('global review ignores project policies and archived policies instead of selecting them as the global default', async t => {
  const f = await fixture(t);
  const local = f.store.write({ kind: 'policy', action: 'create', scope: f.projectId, idempotencyKey: 'local-default-policy', data: { kind: 'global_prompt', status: 'active', content: '只属于当前项目的规则。' } });
  const retired = f.store.write({ kind: 'policy', action: 'create', scope: null, idempotencyKey: 'retired-default-policy', data: { kind: 'global_prompt', status: 'active', content: '已归档的旧规则。' } });
  f.store.write({ kind: 'policy', action: 'archive', scope: null, objectId: retired.objectId, expectedRevision: retired.revision, idempotencyKey: 'archive-default-policy', data: {} });
  const batch = await f.begin('scope-default-policy');
  assert.equal(f.store.read(batch.policy.objectId).data.content, '保留用户目标。');
  assert.equal(f.store.read(batch.policy.objectId).projectId, null);
  assert.equal(f.store.read(local.objectId).data.content, '只属于当前项目的规则。');
});

async function candidateHistory(t){const f=await semanticHistory(t),journal=JSON.parse(fs.readFileSync(path.join(f.run,'application.json'),'utf8')),id=journal.items['lesson:0'],file=path.join(f.root,'learning','candidates',id+'.json'),bytes=fs.readFileSync(file),value=JSON.parse(bytes);assert.equal(reviewHash(JSON.stringify(value)),journal.pending['lesson:0']);return {...f,get store(){return f.store;},journal,id,file,bytes,value};}
async function importCandidate(f,key){const job=await f.call('import_project_data',{collection:'learning',sourceRoot:path.join(f.root,'learning'),projectScopes:{[f.project]:f.projectId},idempotencyKey:key});for(let i=0;i<150;i++){const state=await f.call('migration_status',{jobId:job.jobId});if(!['queued','running'].includes(state.status))return state;await new Promise(r=>setTimeout(r,10));}assert.fail('candidate import did not settle');}
function lessonApplication(f){const apps=f.store.search({scope:f.projectId,kinds:['application']}).items.map(item=>f.store.read(item.objectId));return apps.find(item=>f.store.read(item.data.target_object_id).kind==='lesson');}
test('a later source capture reconciles the existing lesson application full after-image',async t=>{
 const f=await candidateHistory(t),held=path.join(f.base,'held-original-candidate.json');fs.renameSync(f.file,held);const first=await f.importHistory('journal-first');assert.equal(first.status,'completed_with_conflicts',JSON.stringify(first.progress));const original=lessonApplication(f);assert.ok(original,JSON.stringify(first.progress));fs.renameSync(held,f.file);assert.equal((await importCandidate(f,'candidate-late')).status,'completed');assert.equal((await f.importHistory('journal-reconciled')).status,'completed');const after=lessonApplication(f);assert.equal(after.objectId,original.objectId);assert.deepEqual(JSON.parse(after.data.after_content),f.value);const revision=after.revision;await f.importHistory('journal-reconciled-again');assert.equal(lessonApplication(f).revision,revision);await f.restart();assert.deepEqual(JSON.parse(f.store.read(after.objectId).data.after_content),f.value);
});
test('a later candidate source version cannot replace the recorded original full after-image',async t=>{
 const f=await candidateHistory(t);assert.equal((await importCandidate(f,'candidate-original')).status,'completed');const later={...f.value,summary:'用户后续修改的经验',updatedAt:new Date(Date.parse(f.value.updatedAt)+1000).toISOString()};fs.writeFileSync(f.file,JSON.stringify(later,null,2)+'\n');assert.notEqual(reviewHash(JSON.stringify(later)),f.journal.pending['lesson:0']);assert.equal((await importCandidate(f,'candidate-later-version')).status,'completed');assert.equal((await f.importHistory('journal-after-later-source')).status,'completed');assert.deepEqual(JSON.parse(lessonApplication(f).data.after_content),f.value);assert.deepEqual(JSON.parse(f.store.readMigrationSource('learning:'+path.join(f.root,'learning'),'candidates/'+f.id+'.json').bytes.toString('utf8')),later);assert.deepEqual(JSON.parse(fs.readFileSync(f.file,'utf8')),later);
});
test('missing original lesson after-image keeps the complete prompt and reports the reconciliation gap',async t=>{
 const f=await candidateHistory(t),later={...f.value,summary:'只剩无法匹配原应用哈希的版本',updatedAt:new Date(Date.parse(f.value.updatedAt)+1000).toISOString()};fs.writeFileSync(f.file,JSON.stringify(later,null,2)+'\n');assert.equal((await importCandidate(f,'candidate-unmatched')).status,'completed');const state=await f.importHistory('journal-missing-original');assert.equal(state.status,'completed_with_conflicts');assert.ok(state.progress.conflicts.some(c=>/legacy_review_lesson_after_(missing|invalid)/.test(c.error)),JSON.stringify(state.progress));const policies=f.store.search({scope:null,kinds:['policy']}).items.map(item=>f.store.read(item.objectId));assert.ok(policies.some(p=>p.data.content===f.proposal.globalPrompt.value),'the complete prompt must still be recovered');for(const[name,bytes]of f.originals)assert.deepEqual(fs.readFileSync(path.join(f.run,name)),bytes);
 const app=lessonApplication(f);assert.equal(app.data.after_content,'null','the missing original is explicit, never a synthetic proposal');
 const identity='learning-review:'+f.sourceRoot,key='runs/semantic-legacy/application.json',capture=f.store.readMigrationSource(identity,key);
 assert.equal(capture.stage,'conflict');await f.importHistory('journal-missing-original-repeat');assert.equal(lessonApplication(f).revision,app.revision);assert.equal(f.store.readMigrationSource(identity,key).sourceRevision,capture.sourceRevision);assert.equal(f.store.readMigrationSource(identity,key).stage,'conflict');
});

test('unchanged candidate after-image lookup uses indexed fixed versions without decoding unrelated or prior bodies', async t => {
 const f=await candidateHistory(t);await importCandidate(f,'indexed-original');
 const identity='learning:'+path.join(f.root,'learning'),key='candidates/'+f.id+'.json',hash=f.journal.pending['lesson:0'];
 for(let i=0;i<12;i++){const value={...f.value,summary:'later '+i},bytes=Buffer.from(JSON.stringify(value));f.store.captureMigrationSource({identity,key,hash:reviewHash(bytes)},bytes,{mimeType:'application/json',encoding:'utf8'});}
 let calls=0;const content=f.store.content.bind(f.store);f.store.content=(...args)=>{calls++;return content(...args);};
 for(let i=0;i<8;i++){const saved=f.store.readMigrationSourceJsonVersion(identity,key,hash);assert.deepEqual(JSON.parse(saved.bytes),f.value);assert.equal(saved.sourceRevision,1);}
 assert.equal(calls,8,'exact indexed lookup only reads the requested immutable content once per call');
});

test('a fixed full lesson after-image survives backup and restore without the original candidate',async t=>{
 const f=await candidateHistory(t);assert.equal((await f.importHistory('after-image-backup')).status,'completed');const app=lessonApplication(f),destination=path.join(f.base,'after-backup.db');await f.store.backup({destination,idempotencyKey:'lesson-after-image-backup'});fs.renameSync(path.join(f.root,'learning'),path.join(f.root,'learning-retained'));
 const restoredRoot=path.join(f.base,'restored-after');fs.mkdirSync(restoredRoot);fs.copyFileSync(destination,path.join(restoredRoot,'solomap.db'));const restored=new UnifiedDataStore(restoredRoot);try{assert.deepEqual(JSON.parse(restored.read(app.objectId).data.after_content),f.value);const saved=restored.readMigrationSourceJsonVersion('learning:'+path.join(f.root,'learning'),'candidates/'+f.id+'.json',f.journal.pending['lesson:0']);assert.deepEqual(JSON.parse(saved.bytes),f.value);}finally{restored.close();}
});
