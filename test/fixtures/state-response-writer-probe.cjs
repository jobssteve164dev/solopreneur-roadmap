const {isMainThread,workerData,threadId}=require('node:worker_threads');
if(!isMainThread && workerData?.affinity==='writer-actor'){
  const fs=require('node:fs'),stringify=JSON.stringify,parse=JSON.parse;
  const coverage=value=>value && typeof value==='object' && value.version===1 && value.provider==='c8-istanbul' && typeof value.payload==='string' && value.payload.length>65536;
  const external=value=>value && typeof value==='object' && typeof value.generation==='number' && typeof value.requestId==='string' && typeof value.cache?.externalPayload==='string' && value.cache.externalPayload.length>65536;
  const record=value=>{const output=process.env.SOLOMAP_STATE_RESPONSE_PROBE;if(output)fs.appendFileSync(output,stringify({threadId,affinity:workerData.affinity,...value})+'\n');};
  JSON.stringify=function(value,...args){
    const result=stringify.call(this,value,...args);
    if(value && typeof value==='object' && Object.keys(value).length===3 && typeof value.objectId==='string' && typeof value.revision==='number' && typeof value.value?.payload==='string' && value.value.payload.length>65536){
      record({kind:'state-stringify',bytes:Buffer.byteLength(result)});
    }
    if(coverage(value))record({kind:'coverage-stringify',bytes:Buffer.byteLength(result)});
    if(external(value) || typeof value?.accepted==='boolean' && external(value.state?.value))record({kind:'external-stringify',bytes:Buffer.byteLength(result)});
    return result;
  };
  JSON.parse=function(value,...args){const result=parse.call(this,value,...args);if(coverage(result))record({kind:'coverage-parse',bytes:Buffer.byteLength(value)});if(external(result))record({kind:'external-parse',bytes:Buffer.byteLength(value)});return result;};
}
