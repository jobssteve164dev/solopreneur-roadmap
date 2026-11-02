const test = require('node:test');
const assert = require('node:assert/strict');

const { RuntimeExecutionScheduler } = require('../out/runtimePriorityScheduler.js');
const { runtimeOperationDefinition } = require('../out/runtimeOperationRegistry.js');

test('runtime scheduler admits user conversation control before queued background IO', async () => {
  const scheduler = new RuntimeExecutionScheduler();
  const order = [];
  const background = scheduler.submit('background-query', async () => { order.push('background-1'); });
  const background2 = scheduler.submit('background-query', async () => { order.push('background-2'); });
  const foreground = scheduler.submit('foreground-command', async () => { order.push('foreground'); });
  await Promise.all([background, background2, foreground]);
  assert.deepEqual(order, ['foreground', 'background-1', 'background-2']);
});

test('runtime scheduler reserves CPU between successive foreground quanta instead of immediately refilling it with background work', async () => {
  const scheduler = new RuntimeExecutionScheduler();
  let backgroundStarted = false;
  const background = scheduler.submit('background-query', async () => {
    backgroundStarted = true;
    return 'background';
  });
  assert.equal(await scheduler.submit('control-query', async () => 'control-1'), 'control-1');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(backgroundStarted, false, 'the next user action must retain a bounded CPU reservation window');
  assert.equal(await scheduler.submit('foreground-query', async () => 'control-2'), 'control-2');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(backgroundStarted, false, 'successive foreground work must extend the same reservation');
  assert.equal(await Promise.race([
    background,
    new Promise((_, reject) => setTimeout(() => reject(new Error('background_reservation_never_released')), 200))
  ]), 'background');
});

test('runtime operation registry expresses execution domains without name inference', () => {
  assert.equal(runtimeOperationDefinition('claim_run').domain, 'foreground-command');
  assert.equal(runtimeOperationDefinition('read_project_registry').domain, 'control-query');
  assert.equal(runtimeOperationDefinition('read_project_registry').executor, 'supervisor');
  assert.equal(runtimeOperationDefinition('read_intelligence_execution_mode').domain, 'control-query');
  assert.equal(runtimeOperationDefinition('read_intelligence_execution_mode').executor, 'supervisor');
  assert.equal(runtimeOperationDefinition('read_run_execution_plan').domain, 'foreground-query');
  assert.equal(runtimeOperationDefinition('read_run_execution_plan').executor, 'interactive-reader');
  assert.equal(runtimeOperationDefinition('read_run_artifact').domain, 'foreground-query');
  assert.equal(runtimeOperationDefinition('read_run_artifact').executor, 'interactive-reader');
  assert.equal(runtimeOperationDefinition('read_project_journal').executor, 'interactive-reader');
  assert.equal(runtimeOperationDefinition('read_agent_impact_summary').domain, 'background-query');
  assert.equal(runtimeOperationDefinition('read_agent_impact_summary').executor, 'background-reader');
  assert.equal(runtimeOperationDefinition('append_diagnostic_event').domain, 'runtime-event',
    'accepted lifecycle evidence must not starve behind a continuous foreground reservation');
  assert.equal(runtimeOperationDefinition('start_conversation').domain, 'external-job');
  assert.equal(runtimeOperationDefinition('start_conversation').executor, 'external-worker');
  assert.equal(runtimeOperationDefinition('write_internal_attachment').domain, 'foreground-command');
  assert.equal(runtimeOperationDefinition('read_database_overview').domain, 'background-query');
  assert.equal(runtimeOperationDefinition('sync_documentation_manifest').domain, 'background-command');
  assert.equal(runtimeOperationDefinition('backup').domain, 'maintenance');
  assert.equal(runtimeOperationDefinition('resolve_project_repository').domain, 'git-job');
  assert.equal(runtimeOperationDefinition('refresh_project_signal').domain, 'network-job');
});

test('continuous foreground reservations cannot starve accepted lifecycle evidence', async () => {
  const scheduler = new RuntimeExecutionScheduler();
  const observed = [];
  await scheduler.submit('control-query', async () => { observed.push('foreground'); });
  const background = scheduler.submit('background-command', async () => { observed.push('background'); });
  const lifecycle = scheduler.submit(runtimeOperationDefinition('append_diagnostic_event').domain,
    async () => { observed.push('lifecycle'); return 'persisted'; });

  assert.equal(await lifecycle, 'persisted');
  assert.deepEqual(observed, ['foreground', 'lifecycle']);
  await background;
  assert.deepEqual(observed, ['foreground', 'lifecycle', 'background']);
});

test('Runtime-memory control queries never wait behind database foreground readers', async () => {
  const scheduler = new RuntimeExecutionScheduler();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const readers = Array.from({ length: 8 }, () => scheduler.submit('foreground-query', () => gate, { label: 'read_project_registry' }));
  await new Promise(resolve => setImmediate(resolve));
  const mode = scheduler.submit('control-query', async () => 'harness', {
    label: 'read_intelligence_execution_mode', deadlineAt: Date.now() + 50
  });
  assert.equal(await mode, 'harness');
  release();
  await Promise.all(readers);
});

test('queued network jobs never occupy the Git scheduler or transport lane', async () => {
  const scheduler = new RuntimeExecutionScheduler();
  let releaseNetwork;
  const networkGate = new Promise(resolve => { releaseNetwork = resolve; });
  const network = [0, 1, 2].map(index => scheduler.submit('network-job', async () => {
    await networkGate;
    return index;
  }));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(await scheduler.submit('git-job', async () => 'git-visible'), 'git-visible');

  releaseNetwork();
  assert.deepEqual(await Promise.all(network), [0, 1, 2]);
});

test('long-lived Runtime event subscriptions never consume background query capacity', async () => {
  const scheduler = new RuntimeExecutionScheduler();
  let releaseEvents;
  const events = new Promise(resolve => { releaseEvents = resolve; });
  const subscriptions = Array.from({ length: 16 }, () => scheduler.submit('runtime-event', () => events));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(await scheduler.submit('background-query', async () => 'background-progress'), 'background-progress');
  const snapshot = scheduler.snapshot();
  assert.equal(snapshot['runtime-event'].active, 16);
  assert.equal(snapshot['background-query'].concurrency, 2);

  releaseEvents();
  await Promise.all(subscriptions);
});

test('background query admission is bounded even when many callers retry at full speed', async () => {
  const scheduler = new RuntimeExecutionScheduler();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const work = Array.from({ length: 8 }, () => scheduler.submit('background-query', () => gate));
  await new Promise(resolve => setImmediate(resolve));
  const snapshot = scheduler.snapshot()['background-query'];
  assert.equal(snapshot.active, 2);
  assert.equal(snapshot.queued, 6);
  assert.deepEqual(snapshot.blockers, { anonymous: 2 });
  release();
  await Promise.all(work);
});

test('maintenance yields through the bounded foreground reservation and then runs beside admitted asynchronous work', async () => {
  const scheduler = new RuntimeExecutionScheduler();
  let releaseForeground;
  const foregroundGate = new Promise(resolve => { releaseForeground = resolve; });
  const foreground = Array.from({ length: 16 }, () => scheduler.submit('foreground-command', () => foregroundGate));
  await new Promise(resolve => setImmediate(resolve));
  let releaseQueued;
  const queuedGate = new Promise(resolve => { releaseQueued = resolve; });
  const queuedForeground = scheduler.submit('foreground-command', () => queuedGate);
  let maintenanceStarted = false;
  const maintenance = scheduler.submit('maintenance', async () => { maintenanceStarted = true; return 'maintenance'; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(maintenanceStarted, false, 'queued user-visible admission retains priority');
  releaseForeground('foreground'); await Promise.all(foreground);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(maintenanceStarted, false, 'the foreground handoff retains its bounded CPU reservation');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(maintenanceStarted, true, 'an asynchronous foreground wait cannot globally lock an independent executor');
  releaseQueued('foreground-query');
  assert.equal(await queuedForeground, 'foreground-query');
  assert.equal(await maintenance, 'maintenance');
});

test('an admitted foreground query can await formal maintenance without a cross-domain scheduler deadlock', async () => {
  const scheduler = new RuntimeExecutionScheduler();
  const result = scheduler.submit('interactive-query', async () => scheduler.submit('maintenance', async () => 'imported'));
  assert.equal(await Promise.race([
    result,
    new Promise((_, reject) => setTimeout(() => reject(new Error('cross_domain_scheduler_deadlock')), 100))
  ]), 'imported');
});

test('admission deadline evidence names the rejected operation and active blockers', async () => {
  const scheduler = new RuntimeExecutionScheduler();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const active = Array.from({ length: 32 }, () => scheduler.submit('interactive-query', () => gate, { label: 'read_run_state' }));
  await new Promise(resolve => setImmediate(resolve));
  const keepAlive = setTimeout(() => {}, 50);
  try {
    await assert.rejects(
      scheduler.submit('interactive-query', async () => 'late', {
        label: 'read_project_registry', deadlineAt: Date.now() + 20
      }),
      /runtime_request_deadline_exceeded:interactive-query:read_project_registry:active=32:queued=0:blockers=read_run_state\*32/
    );
  } finally { clearTimeout(keepAlive); }
  release();
  await Promise.all(active);
});

test('an admitted asynchronous background operation never holds the foreground execution lane', async () => {
  const scheduler = new RuntimeExecutionScheduler();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const background = scheduler.submit('background-query', async () => { await blocked; return 'background'; });
  await new Promise(resolve => setImmediate(resolve));
  const foreground = scheduler.submit('foreground-command', async () => 'foreground');
  assert.equal(await foreground, 'foreground');
  release();
  assert.equal(await background, 'background');
});

test('an admitted asynchronous command cannot hold a later foreground command', async () => {
  const scheduler = new RuntimeExecutionScheduler();
  let releaseWrite;
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  const firstWrite = scheduler.submit('foreground-command', async () => { await writeGate; return 'write-1'; });
  let secondStarted = false;
  const secondWrite = scheduler.submit('foreground-command', async () => { secondStarted = true; return 'write-2'; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondStarted, true, 'end-to-end async work must not reserve the short SQLite admission turn');
  assert.equal(await scheduler.submit('interactive-query', async () => 'visible-project'), 'visible-project');
  assert.equal(await scheduler.submit('background-query', async () => 'projection'), 'projection');
  releaseWrite();
  assert.deepEqual(await Promise.all([firstWrite, secondWrite]), ['write-1', 'write-2']);
});

test('child work of an admitted external job does not reacquire and deadlock its parent lane', async () => {
  const scheduler = new RuntimeExecutionScheduler();
  let releaseParents;
  const parentGate = new Promise(resolve => { releaseParents = resolve; });
  const parents = Array.from({ length: 4 }, (_, index) => scheduler.submit('external-job', async admission => {
    if (index === 0) {
      return scheduler.submitChild(admission, async () => 'editor-started', { label: 'execute_telegram_editor_command' });
    }
    await parentGate;
    return `parent-${index}`;
  }, { label: `send_intelligence_message:${index}` }));
  assert.equal(await Promise.race([
    parents[0],
    new Promise((_, reject) => setTimeout(() => reject(new Error('nested_external_scheduler_deadlock')), 100))
  ]), 'editor-started');
  releaseParents();
  assert.deepEqual(await Promise.all(parents), ['editor-started', 'parent-1', 'parent-2', 'parent-3']);
});

test('foreground admission is bounded while already accepted conversations still drain', async () => {
  const scheduler = new RuntimeExecutionScheduler();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const active = Array.from({ length: 16 }, () => scheduler.submit('foreground-command', () => gate));
  await new Promise(resolve => setImmediate(resolve));
  const queued = Array.from({ length: 2048 }, () => scheduler.submit('foreground-command', async () => 'queued'));
  const overflow = scheduler.submit('foreground-command', async () => 'overflow');
  const overflowRejected = assert.rejects(overflow, /runtime_domain_queue_full:foreground-command/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduler.snapshot()['foreground-command'].queued, 2048);
  release();
  await Promise.all(active);
  await Promise.all(queued);
  await overflowRejected;
});
