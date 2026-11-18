const test=require('node:test');
const assert=require('node:assert/strict');
const {RuntimeExecutionScheduler,continueRuntimeWork,mapRuntimeWorkResult}=require('../out/runtimePriorityScheduler.js');
const {RuntimeContinuationSource,RuntimeContinuationClient}=require('../out/runtimeWorkContinuationBridge.js');

function bridge(){
  let client;
  const source=new RuntimeContinuationSource((token,error)=>queueMicrotask(()=>client.ready(token,error)));
  const deliver=(value,session)=>{
    const descriptor=source.expose(value);
    if(descriptor){const wire=structuredClone(descriptor);assert.deepEqual(Object.keys(wire).sort(),['token','waiting']);return client.accept(wire,session);}
    if(session)client.finish(session);return value;
  };
  client=new RuntimeContinuationClient(async(token,admission,session)=>{
    try{return deliver(await source.resume(token,admission),session);}catch(error){client.finish(session,error);throw error;}
  });
  return {source,client,deliver};
}

test('private work tokens preserve accepted whole results and release the real Scheduler between pieces',async()=>{
  const {client,deliver}=bridge(),scheduler=new RuntimeExecutionScheduler(),order=[],admissions=[];
  let enter,release;const entering=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const accepted=scheduler.submit('maintenance',async()=>deliver(continueRuntimeWork(async admission=>{
    admissions.push(admission.id);order.push('first');enter();await gate;
    return continueRuntimeWork(async next=>{admissions.push(next.id);order.push('second');return {deletedArtifacts:160,completed:true};});
  })));
  await entering;let drained=false;const draining=client.drain().then(()=>{drained=true;});
  const other=scheduler.submit('maintenance',async()=>{order.push('other');return 'complete other';});
  assert.equal(drained,false);release();
  assert.deepEqual(await accepted,{deletedArtifacts:160,completed:true});assert.equal(await other,'complete other');await draining;
  assert.deepEqual(order,['first','other','second']);assert.equal(new Set(admissions).size,2);
});

test('a private dependency token leaves the lane free for the accepted maintenance it needs',async()=>{
  const {deliver}=bridge(),scheduler=new RuntimeExecutionScheduler(),order=[];let ready;
  const dependency=new Promise(resolve=>{ready=resolve;});
  const waiting=scheduler.submit('maintenance',async()=>deliver(continueRuntimeWork(async()=>{order.push('dependent');return 'dependent result';},dependency)));
  const first=scheduler.submit('maintenance',async()=>deliver(continueRuntimeWork(async()=>{order.push('preceding');ready();return 'preceding result';})));
  assert.deepEqual(await Promise.all([waiting,first]),['dependent result','preceding result']);assert.deepEqual(order,['preceding','dependent']);
});

test('failed cross-thread dependencies preserve their error and release their logical drain',async()=>{
  const {client,deliver}=bridge(),scheduler=new RuntimeExecutionScheduler();let fail;
  const dependency=new Promise((_,reject)=>{fail=reject;});
  const waiting=scheduler.submit('maintenance',async()=>deliver(continueRuntimeWork(async()=>{throw Error('must not run');},dependency)));void waiting.catch(()=>{});
  await new Promise(resolve=>setImmediate(resolve));fail(Error('original-maintenance-dependency-error'));
  await assert.rejects(waiting,/original-maintenance-dependency-error/);await client.drain();
  assert.equal(await scheduler.submit('maintenance',async()=> 'usable'),'usable');
});

test('a consumed work token cannot run twice and projections only see the final public result',async()=>{
  const {source,deliver}=bridge(),scheduler=new RuntimeExecutionScheduler();let executions=0,projections=0;
  const descriptor=source.expose(continueRuntimeWork(async()=>{executions++;return 'original result';}));
  assert.equal(await source.resume(descriptor.token,{id:1,domain:'maintenance'}),'original result');
  await assert.rejects(source.resume(descriptor.token,{id:2,domain:'maintenance'}),/runtime_continuation_missing/);assert.equal(executions,1);
  const projected=mapRuntimeWorkResult(continueRuntimeWork(async()=>continueRuntimeWork(async()=>({complete:160}))),value=>{projections++;return JSON.stringify(value);});
  assert.equal(await scheduler.submit('maintenance',async()=>deliver(projected)),'{"complete":160}');assert.equal(projections,1);
});
