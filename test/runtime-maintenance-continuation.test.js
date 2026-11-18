const test=require('node:test');
const assert=require('node:assert/strict');
const {RuntimeExecutionScheduler}=require('../out/runtimePriorityScheduler.js');

const continuation=(action,waitFor)=>({[Symbol.for('solomap.runtime.workContinuation')]:action,...(waitFor?{waitFor}:{})});

test('an accepted maintenance operation releases its admission between pieces and only returns its complete result',async()=>{
  const scheduler=new RuntimeExecutionScheduler(),order=[],admissions=[];
  let entered,release;
  const entering=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const complete=scheduler.submit('maintenance',async admission=>{
    order.push('first');admissions.push(admission.id);entered();await gate;
    return continuation(async next=>{
      order.push('second');admissions.push(next.id);
      return continuation(async final=>{order.push('third');admissions.push(final.id);return {deletedArtifacts:17,deletedSources:9,pending:false};});
    });
  },{label:'complete-maintenance'});
  await entering;
  const unrelated=scheduler.submit('maintenance',async()=>{order.push('other maintenance');return 'finished';});
  release();
  assert.deepEqual(await complete,{deletedArtifacts:17,deletedSources:9,pending:false});
  assert.equal(await unrelated,'finished');
  assert.deepEqual(order,['first','other maintenance','second','third']);
  assert.equal(new Set(admissions).size,3,'each piece needs its own real admission');
});

test('accepted maintenance continues after its original admission deadline while the existing queue is full',async()=>{
  const scheduler=new RuntimeExecutionScheduler();let entered,release,pieces=0;
  const entering=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const accepted=scheduler.submit('maintenance',async()=>{
    pieces++;entered();await gate;
    return continuation(async()=>{pieces++;return {completed:true};});
  },{deadlineAt:Date.now()+100,label:'accepted-before-deadline'});
  await entering;
  const queued=Array.from({length:64},(_,i)=>scheduler.submit('maintenance',async()=>i));
  await assert.rejects(scheduler.submit('maintenance',async()=>-1),/runtime_domain_queue_full/);
  await new Promise(resolve=>setTimeout(resolve,120));release();
  assert.deepEqual(await accepted,{completed:true});
  assert.equal(pieces,2);
  assert.deepEqual(await Promise.all(queued),Array.from({length:64},(_,i)=>i));
});

test('a failed later piece returns its original error and releases the maintenance slot',async()=>{
  const scheduler=new RuntimeExecutionScheduler(),failure=Error('original-maintenance-write-error');
  await assert.rejects(scheduler.submit('maintenance',async()=>continuation(async()=>{throw failure;})),error=>error===failure);
  assert.equal(await scheduler.submit('maintenance',async()=>({usable:true})).then(result=>result.usable),true);
  await new Promise(resolve=>setImmediate(resolve));
  const state=scheduler.snapshot().maintenance;
  assert.equal(state.active,0);assert.equal(state.queued,0);
});

test('a dependent maintenance piece waits in the same queue while the operation it needs keeps making progress',async()=>{
  const scheduler=new RuntimeExecutionScheduler(),order=[];
  let entered,release,finished;
  const entering=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;}),complete=new Promise(resolve=>{finished=resolve;});
  const first=scheduler.submit('maintenance',async()=>{
    order.push('cleanup starts');entered();await gate;
    return continuation(async()=>{
      order.push('cleanup advances');
      return continuation(async()=>{order.push('cleanup finishes');finished();return 'complete cleanup';});
    });
  });
  await entering;
  const dependent=scheduler.submit('maintenance',async()=>{
    order.push('dependent plans');
    return continuation(async()=>{order.push('dependent commits');return 'complete dependent';},complete);
  });
  release();
  assert.deepEqual(await Promise.all([first,dependent]),['complete cleanup','complete dependent']);
  assert.deepEqual(order,['cleanup starts','dependent plans','cleanup advances','cleanup finishes','dependent commits']);
});

test('a queued continuation with a failed dependency preserves the original error and leaves the lane usable',async()=>{
  const scheduler=new RuntimeExecutionScheduler(),failure=Error('original-dependency-error');
  const failed=Promise.reject(failure);void failed.catch(()=>{});
  await assert.rejects(scheduler.submit('maintenance',async()=>continuation(async()=>({incorrectlyRan:true}),failed)),error=>error===failure);
  assert.equal(await scheduler.submit('maintenance',async()=> 'usable'),'usable');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(scheduler.snapshot().maintenance.active,0);assert.equal(scheduler.snapshot().maintenance.queued,0);
});

test('a foreground continuation waiting for maintenance does not reserve the CPU against its own dependency',async()=>{
  const scheduler=new RuntimeExecutionScheduler(),order=[];let release;
  const ready=new Promise(resolve=>{release=resolve;});
  const foreground=scheduler.submit('foreground-query',async()=>continuation(async()=>{order.push('foreground completes');return 'visible';},ready));
  const maintenance=scheduler.submit('maintenance',async()=>{order.push('maintenance completes');release();return 'prepared';});
  let timer;
  try{
    assert.deepEqual(await Promise.race([Promise.all([foreground,maintenance]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('dependent-maintenance-deadlock')),1000);})]),['visible','prepared']);
    assert.deepEqual(order,['maintenance completes','foreground completes']);
  }finally{clearTimeout(timer);release();await Promise.allSettled([foreground,maintenance]);}
});
