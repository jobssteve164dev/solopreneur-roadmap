const fs=require('node:fs'),path=require('node:path'),{isMainThread,workerData}=require('node:worker_threads');
const file=process.env.SOLOMAP_GROWTH_INPUT_EXIT_PROBE,out=process.env.SOLOMAP_GROWTH_RUNTIME_OUT;
function record(value){fs.appendFileSync(file,JSON.stringify(value)+'\n');}
if(file && out && !isMainThread && workerData?.affinity==='writer-actor'){
  const {UnifiedDataStore}=require(path.join(out,'db/unifiedDataStore.js')),prototype=UnifiedDataStore.prototype,begin=prototype.beginProjectGrowthRefreshStage,discard=prototype.discardProjectGrowthRefreshStage;
  prototype.beginProjectGrowthRefreshStage=function(...args){this.ensureProjectGrowthStageTables();this.db.run("CREATE TEMP TRIGGER actual_runtime_growth_begin_failure BEFORE INSERT ON runtime_growth_refresh_stages BEGIN SELECT RAISE(ABORT,'actual_runtime_growth_begin_sql_failure'); END");record({kind:'begin',stageId:args[1].manifest.stageId});return begin.apply(this,args);};
  prototype.discardProjectGrowthRefreshStage=function(stageId){const done=()=>record({kind:'source-discarded',stageId,headers:Number(this.rows('SELECT COUNT(*) AS n FROM runtime_growth_refresh_stages WHERE stage_id=?',[stageId])[0].n),items:Number(this.rows('SELECT COUNT(*) AS n FROM runtime_growth_refresh_stage_items WHERE stage_id=?',[stageId])[0].n)}),result=discard.call(this,stageId);if(result && typeof result.then==='function')return result.then(value=>{done();return value;});done();return result;};
}
if(file && out && !isMainThread && workerData?.root && workerData.databaseId && !workerData.affinity){
  const assign=Map.prototype.set,remove=Map.prototype.delete;
  Map.prototype.set=function(key,value){const result=assign.call(this,key,value);if(typeof key==='string' && value?.manifest?.stageId===key && value?.snapshot)record({kind:'compute-scan-created',stageId:key});return result;};
  Map.prototype.delete=function(key){const value=this.get(key),scan=typeof key==='string' && value?.manifest?.stageId===key && value?.snapshot,result=remove.call(this,key);if(scan)record({kind:'compute-scan-deleted',stageId:key,deleted:result,remaining:this.has(key)});return result;};
}
