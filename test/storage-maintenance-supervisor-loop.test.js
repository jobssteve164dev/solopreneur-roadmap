const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');

// Execute the final generated controller without starting a Supervisor or inheriting real state roots.
function fixture(t,run=async()=>({pending:false})){
  const file=process.env.SOLOMAP_STORAGE_CONTROLLER_BASELINE || path.resolve(__dirname,'../out/autonomousRuntimeProcess.js');
  let source=fs.readFileSync(file,'utf8');
  if(file.endsWith('.ts'))source=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const parsed=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),controllers=[];
  const visit=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text==='scheduleStorageColdMaintenance')controllers.push(node.getText(parsed));ts.forEachChild(node,visit);};visit(parsed);
  assert.equal(controllers.length,1,'validate the actual final generated Supervisor controller');
  let now=0,sequence=0;const timers=new Map(),calls=[],errors=[];
  const clock={
    tick(ms){now+=ms;for(const [id,timer]of [...timers].sort((a,b)=>a[1].at-b[1].at)){if(timer.at<=now&&timers.delete(id))timer.callback();}},
    get next(){return timers.size?Math.min(...[...timers.values()].map(timer=>timer.at)):null;},get size(){return timers.size;}
  };
  const context=vm.createContext({stopping:false,storageColdTimer:undefined,storageColdReady:false,storageColdRunning:false,storageColdRetryAt:0,storageWakePending:false,storageColdFailure:'',storageMaintenance:undefined,
    Date:{now:()=>now},setTimeout:(callback,delay)=>{const handle={id:++sequence,unref(){}};timers.set(handle.id,{callback,at:now+delay});return handle;},clearTimeout:handle=>timers.delete(handle?.id),
    scheduledOperations:request=>{calls.push(request);return run();},process:{stderr:{write:value=>errors.push(value)}}});
  vm.runInContext('"use strict";\n'+controllers[0],context,{filename:file});
  t.after(async()=>{context.stopping=true;timers.clear();await context.storageMaintenance;});
  return {context,clock,calls,errors,schedule:delay=>context.scheduleStorageColdMaintenance(delay),flush:()=>new Promise(resolve=>setImmediate(resolve))};
}

test('generated maintenance controller coalesces early wake messages behind the startup barrier',async t=>{
  const f=fixture(t);for(let i=0;i<100;i++)f.schedule(0);
  assert.equal(f.clock.size,0);assert.equal(f.context.storageWakePending,true);
  f.context.storageColdReady=true;f.schedule(0);assert.equal(f.clock.size,1);f.clock.tick(0);await f.flush();assert.equal(f.calls.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])),{operation:'maintain_database_storage',input:{phase:'lifecycle',automatic:true,limit:64}});
});

test('generated maintenance controller holds one flight and merges repeated wakes into one next piece',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release({pending:false}));
  const f=fixture(t,()=>gate);f.context.storageColdReady=true;f.schedule(0);f.clock.tick(0);
  assert.equal(f.calls.length,1);for(let i=0;i<100;i++)f.schedule(0);
  assert.equal(f.clock.size,0,'no parallel timer may run a second piece while the first is active');
  release({pending:false});await f.flush();assert.equal(f.clock.next,0);f.clock.tick(0);await f.flush();
  assert.equal(f.calls.length,2);assert.equal(f.clock.size,1);assert.equal(f.clock.next,30000);
});

test('generated maintenance controller keeps the original failure cadence despite frequent producer wakes',async t=>{
  const f=fixture(t,async()=>{throw Error('original-maintenance-io');});f.context.storageColdReady=true;f.schedule(0);f.clock.tick(0);await f.flush();
  assert.equal(f.calls.length,1);assert.equal(f.clock.next,5000);
  for(let i=0;i<10;i++){f.clock.tick(100);f.schedule(0);assert.equal(f.clock.next,5000);}
  f.clock.tick(3999);assert.equal(f.calls.length,1);f.clock.tick(1);await f.flush();assert.equal(f.calls.length,2);assert.equal(f.clock.next,10000);
  assert.equal(f.errors.length,1,'the unchanged persistent error is not logged on every wake or retry');assert.match(f.errors[0],/original-maintenance-io/);
});

test('generated maintenance controller distinguishes blocked pending, runnable progress and a true idle window',async t=>{
  const results=[{pending:true,runnable:false},{pending:true,runnable:true},{pending:false}],f=fixture(t,async()=>results.shift());
  f.context.storageColdReady=true;f.schedule(0);f.clock.tick(0);await f.flush();assert.equal(f.clock.next,100);
  f.clock.tick(100);await f.flush();assert.equal(f.clock.next,100);f.clock.tick(0);await f.flush();assert.equal(f.clock.next,30100);
  f.context.stopping=true;f.clock.tick(30000);assert.equal(f.calls.length,3);assert.equal(f.clock.size,0);
});
