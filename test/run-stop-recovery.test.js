const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { RunStop } = require('../out/runStop.js');
const { RunRecovery } = require('../out/runRecovery.js');

test('recovery preserves an accepted ordinary stop after a refused strict continuation stop', async () => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-stop-intent-recovery-'));
  const root=path.join(base,'global'),project=path.join(base,'project');fs.mkdirSync(project);
  const unrelated=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>process.stdout.write('unexpected-signal'));process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:'pipe'});
  await once(unrelated.stdout,'data');let signals='';unrelated.stdout.on('data',bytes=>{signals+=bytes;});unrelated.stderr.resume();
  let store=new UnifiedDataStore(root),service=new RunStop(store),recovery;
  try{
    const projectIdentity=await store.registerProject({root:project});
    let state=store.prepareRun(projectIdentity.projectId,projectIdentity.locationId,{root:project,executionLogId:1,nodeId:'__solo__',runKind:'solo',prompt:'原始完整输入',command:'not executed',userMessage:'原任务',metadata:{interactiveSession:true,agentPid:unrelated.pid,processBirth:'proc:reused-old-birth'},idempotencyKey:'stop-intent-prepare'});
    const projectId=state.projectId;
    await assert.rejects(service.stop(projectId,{executionLogId:1,generation:state.generation,expectedRevision:state.revision,expectedTurnId:state.turnId,reason:'正在原会话中继续处理。',requireVerifiedIdentity:true,outcome:'partial',idempotencyKey:'strict-refused'}),/run_process_identity_unverified/);
    state=store.readRunState(projectId,1);assert.equal(state.status.stopRequireVerifiedIdentity,true);
    const stopping=service.stop(projectId,{executionLogId:1,generation:state.generation,expectedRevision:state.revision,expectedTurnId:state.turnId,reason:'用户要求停止',idempotencyKey:'ordinary-accepted'}).then(value=>({value}),error=>({error}));
    await service.close();assert.match((await stopping).error.message,/run_stop_interrupted/);
    const accepted=store.readRunState(projectId,1);assert.equal(accepted.status.stopRequestIntent.requireVerifiedIdentity,undefined);assert.equal(accepted.status.stopRequestIntent.outcome,undefined);
    store.close();store=new UnifiedDataStore(root);assert.deepEqual(store.readRunState(projectId,1),accepted);
    recovery=new RunRecovery(store);await recovery.recover();
    const closed=store.readRunState(projectId,1);assert.equal(closed.status.interactiveSessionClosed,true);assert.equal(closed.status.checkpointOutcome,'failed');assert.equal(closed.status.checkpointSummary,'用户要求停止');
    assert.equal(unrelated.exitCode,null);assert.equal(unrelated.signalCode,null);process.kill(unrelated.pid,0);assert.equal(signals,'');assert.deepEqual(fs.readdirSync(path.join(project,'.solopreneur')),['project.json']);
  }finally{
    if(recovery)await recovery.close();await service.close();store.close();
    if(unrelated.exitCode===null&&unrelated.signalCode===null){const ended=once(unrelated,'exit');unrelated.kill('SIGKILL');await ended;}
  }
});

test('Runtime shutdown hands an accepted stop back to recovery without waiting for a wrapper that needs its data service', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-stop-recovery-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const wrapper = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: 'pipe' });
  await once(wrapper.stdout, 'data'); wrapper.stderr.resume();
  const stat = fs.readFileSync(`/proc/${wrapper.pid}/stat`, 'utf8');
  const birth = `proc:${stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19]}`;
  const store = new UnifiedDataStore(root); const service = new RunStop(store);
  let stopping; let closing;
  try {
    const identity = await store.registerProject({ root: project });
    const run = store.prepareRun(identity.projectId, identity.locationId, { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '原始输入', command: 'actual command', userMessage: '目标', metadata: { interactiveSession: true, agentPid: wrapper.pid, processBirth: birth }, idempotencyKey: 'recoverable-stop-run' });
    stopping = service.stop(run.projectId, { executionLogId: 1, generation: run.generation, expectedRevision: run.revision, expectedTurnId: run.turnId, reason: '用户要求停止', idempotencyKey: 'recoverable-stop' }).then(value => ({ value }), error => ({ error }));
    closing = service.close();
    const result = await Promise.race([closing.then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('waiting-for-wrapper'), 100))]);
    assert.equal(result, 'closed');
    assert.match((await stopping).error.message, /run_stop_interrupted/);
    assert.equal(store.readRunState(run.projectId, 1).status.stopRequested, true);
    const ended = once(wrapper, 'exit'); wrapper.kill('SIGKILL'); await ended;
    const recovery = new RunRecovery(store);
    try { await recovery.recover(); } finally { await recovery.close(); }
    const settled = store.readRunState(run.projectId, 1);
    assert.equal(settled.status.interactiveSessionClosed, true); assert.equal(settled.status.status, 'Failed');
    assert.match(settled.status.checkpointSummary, /用户要求停止/);
    assert.deepEqual(fs.readdirSync(path.join(project, '.solopreneur')), ['project.json']);
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) { const ended = once(wrapper, 'exit'); wrapper.kill('SIGKILL'); await ended; }
    await stopping; await closing; store.close();
  }
});

test('recovery consumes a late stop request for an already finished non-interactive run', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-finished-stop-recovery-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); let recovery;
  try {
    const identity = await store.registerProject({ root: project });
    const run = store.prepareRun(identity.projectId, identity.locationId, { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'migration_apply', prompt: '迁移旧数据', command: 'completed command', userMessage: '迁移旧数据', metadata: { interactiveSession: false }, idempotencyKey: 'finished-stop-run' });
    const completed = store.checkpointRun(run.projectId, { executionLogId: 1, generation: run.generation, proof: run.proof, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'partial', summary: '迁移已完成', exitCode: 0, idempotencyKey: 'finished-stop-complete' });
    store.requestRunStop(run.projectId, { executionLogId: 1, generation: completed.generation, expectedRevision: completed.revision, expectedTurnId: completed.turnId, reason: '终端稍后关闭', idempotencyKey: 'finished-stop-late' });
    assert.equal(store.recoverableRunStates().items.length, 1);
    recovery = new RunRecovery(store); await recovery.recover();
    const settled = store.readRunState(run.projectId, 1);
    assert.equal(settled.status.status, 'Session Closed');
    assert.equal(store.recoverableRunStates().items.length, 0, 'a settled run must not be recovered every five seconds forever');
  } finally { if (recovery) await recovery.close(); store.close(); }
});

test('recovery preserves a live interactive process when only its terminal host disappears', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-orphaned-terminal-recovery-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const wrapper = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>process.exit(0));process.stdout.write('ready');setInterval(()=>{},1000)"], { cwd: project, stdio: 'pipe' });
  await once(wrapper.stdout, 'data'); wrapper.stderr.resume();
  const stat = fs.readFileSync(`/proc/${wrapper.pid}/stat`, 'utf8');
  const birth = `proc:${stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19]}`;
  const store = new UnifiedDataStore(root); let recovery;
  try {
    const identity = await store.registerProject({ root: project });
    let run = store.prepareRun(identity.projectId, identity.locationId, {
      root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '原始输入', command: 'actual command', userMessage: '目标',
      metadata: { interactiveSession: true, terminalName: 'closed terminal', terminalDeliveryId: 'delivery-1' },
      deliveryOwner: { id: 'closed-window', pid: 1073741824, birth: 'proc:gone' }, idempotencyKey: 'orphaned-terminal-run'
    });
    run = store.claimRun(run.projectId, { executionLogId: 1, expectedRevision: run.revision, agentPid: wrapper.pid, processBirth: birth, terminalDeliveryId: 'delivery-1', idempotencyKey: 'orphaned-terminal-claim' });
    recovery = new RunRecovery(store);
    await recovery.recover();
    assert.equal(wrapper.exitCode, null, 'recovery must preserve a live run when its display owner is missing');
    await recovery.recover();
    await recovery.recover();
    assert.equal(wrapper.exitCode, null, 'display ownership loss must not terminate a verified live execution');
    const preserved = store.readRunState(run.projectId, 1);
    assert.notEqual(preserved.status.stopRequested, true);
    assert.notEqual(preserved.status.interactiveSessionClosed, true);
    assert.equal(store.recoverableRunStates().items.length, 1);
  } finally {
    if (recovery) await recovery.close();
    if (wrapper.exitCode === null && wrapper.signalCode === null) { const ended = once(wrapper, 'exit'); wrapper.kill('SIGKILL'); await ended; }
    store.close();
  }
});

test('recovery backs off an unchanged failed run and persists its exact failure stage', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-recovery-backoff-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); let recovery; let now = 1_000; let checks = 0;
  try {
    const identity = await store.registerProject({ root: project });
    let run = store.prepareRun(identity.projectId, identity.locationId, {
      root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'migration_apply', prompt: '恢复失败退避', command: 'not executed',
      userMessage: '恢复失败退避', metadata: { interactiveSession: false }, idempotencyKey: 'recovery-backoff-run'
    });
    run = store.claimRun(run.projectId, { executionLogId: 1, expectedRevision: run.revision, agentPid: 1073741824,
      processBirth: 'proc:gone', idempotencyKey: 'recovery-backoff-claim' });
    const original = store.runProcessAlive.bind(store);
    store.runProcessAlive = () => { checks++; throw new Error('fixture_process_probe_failed'); };
    recovery = new RunRecovery(store, undefined, () => now);
    await assert.rejects(recovery.recover(), /fixture_process_probe_failed/);
    assert.equal(checks, 1);
    await recovery.close();
    recovery = new RunRecovery(store, undefined, () => now);
    await recovery.recover();
    assert.equal(checks, 1, 'the cooldown must survive a Runtime rebuild instead of living only in one process Map');
    let deferred = store.readRunState(run.projectId, 1);
    deferred = store.patchRunState(run.projectId, { executionLogId: 1, generation: deferred.generation, expectedRevision: deferred.revision,
      patch: { externalRecoverySignal: 'changed' }, idempotencyKey: 'external-state-change' });
    await assert.rejects(recovery.recover(), /fixture_process_probe_failed/);
    assert.equal(checks, 2, 'an external revision change must bypass the stale cooldown immediately');
    await recovery.recover();
    assert.equal(checks, 2, 'the new failed revision receives its own persisted cooldown');
    const failures = store.readDiagnosticEvents({ kind: 'error', limit: 20 }).items
      .filter(event => event.scope === 'runtime.run-recovery');
    assert.equal(failures.length, 2);
    assert.equal(failures[0].payload.runId, run.runId);
    assert.equal(failures[0].payload.stage, 'process-check');
    assert.match(failures[0].payload.error, /fixture_process_probe_failed/);
    now += 30_000;
    await assert.rejects(recovery.recover(), /fixture_process_probe_failed/);
    assert.equal(checks, 3, 'the unchanged run may be retried after its bounded cooldown');
    for (const expectedDelayMs of [120_000, 240_000, 300_000, 300_000, 300_000]) {
      const backedOff = store.readRunState(run.projectId, 1);
      now = Number(backedOff.status.recoveryRetryAtMs);
      await assert.rejects(recovery.recover(), /fixture_process_probe_failed/);
      const retried = store.readRunState(run.projectId, 1);
      assert.equal(Number(retried.status.recoveryRetryAtMs) - now, expectedDelayMs);
    }
    store.runProcessAlive = original;
  } finally { if (recovery) await recovery.close(); store.close(); }
});

test('recovery persists backoff after its observer advances the same run before failing', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-recovery-progress-backoff-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const { RunNativeObserver } = require('../out/runNativeObserver.js');
  const originalObserve = RunNativeObserver.prototype.observe;
  let recovery;
  try {
    const identity = await store.registerProject({ root: project });
    let run = store.prepareRun(identity.projectId, identity.locationId, {
      root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '恢复观察', command: 'not executed', userMessage: '恢复观察',
      metadata: { interactiveSession: true, sessionProvider: 'codex' }, idempotencyKey: 'recovery-progress-run'
    });
    run = store.claimRun(run.projectId, { executionLogId: 1, expectedRevision: run.revision, agentPid: 1073741824,
      processBirth: 'proc:gone', idempotencyKey: 'recovery-progress-claim' });
    RunNativeObserver.prototype.observe = async function(observed) {
      const latest = store.readRunState(observed.projectId, 1);
      store.patchRunState(observed.projectId, { executionLogId: 1, generation: latest.generation, expectedRevision: latest.revision,
        patch: { codexNativeCursor: 42 }, idempotencyKey: 'observer-progress-before-failure' });
      throw new Error('observer_failed_after_progress');
    };
    recovery = new RunRecovery(store, undefined, () => 5_000);
    await assert.rejects(recovery.recover(), /observer_failed_after_progress/);
    const failed = store.readRunState(run.projectId, 1);
    assert.equal(failed.status.codexNativeCursor, 42);
    assert.equal(failed.status.recoveryBackoffRevision, failed.revision);
    assert.equal(failed.status.recoveryRetryAtMs, 35_000);
  } finally {
    RunNativeObserver.prototype.observe = originalObserve;
    if (recovery) await recovery.close();
    store.close();
  }
});
