const fs=require('node:fs'),path=require('node:path'),{isMainThread,workerData}=require('node:worker_threads');
if(!isMainThread && workerData?.affinity==='writer-actor' && process.env.SOLOMAP_TEST_GENERATION_CLOSE_PROBE){
 const root=process.env.SOLOMAP_TEST_GENERATION_CLOSE_PROBE,repo=path.resolve(__dirname,'../..'),events=path.join(root,'events.jsonl');let rotation=0,apply=0,closed=false,spinRecorded=false;
 const record=value=>fs.appendFileSync(events,JSON.stringify(value)+'\n');
 const {UnifiedDataStore}=require(path.join(repo,'out/db/unifiedDataStore.js')),rotate=UnifiedDataStore.prototype.rotateDatabaseGenerationCapture;
 UnifiedDataStore.prototype.rotateDatabaseGenerationCapture=function(...args){const result=rotate.apply(this,args);rotation++;record({kind:'rotate',rotation,bytes:result.changeset.byteLength});return result;};
 const {DatabaseGenerationWorkerClient}=require(path.join(repo,'out/databaseGenerationWorkerClient.js')),request=DatabaseGenerationWorkerClient.prototype.request,close=DatabaseGenerationWorkerClient.prototype.close;
 const wait=async name=>{while(!fs.existsSync(path.join(root,name)))await new Promise(r=>setTimeout(r,5));};
 DatabaseGenerationWorkerClient.prototype.request=async function(operation,...args){const result=await request.call(this,operation,...args);if(operation==='build_project_import_generation'){record({kind:'build-returned'});await wait('release-build');}else if(operation==='apply_project_import_generation_changeset'){const index=++apply;record({kind:'apply-returned',index,rotation});await wait('release-apply-'+index);}return result;};
 DatabaseGenerationWorkerClient.prototype.close=async function(...args){const result=await close.apply(this,args);if(!closed){closed=true;record({kind:'generation-worker-closed'});}return result;};
 const immediate=setImmediate;global.setImmediate=function(...args){if(closed && !spinRecorded && new Error().stack.includes('executeDatabaseGeneration')){spinRecorded=true;record({kind:'post-close-generation-spin'});}return immediate.apply(this,args);};record({kind:'probe-ready'});
}
