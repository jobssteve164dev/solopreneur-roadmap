const test = require('node:test');
const assert = require('node:assert/strict');

const { RuntimePriorityScheduler, runtimeOperationPriority } = require('../out/runtimePriorityScheduler.js');

test('runtime scheduler admits user conversation control before queued background IO', async () => {
  const scheduler = new RuntimePriorityScheduler();
  const order = [];
  const background = scheduler.submit(2, async () => { order.push('background-1'); });
  const background2 = scheduler.submit(2, async () => { order.push('background-2'); });
  const foreground = scheduler.submit(0, async () => { order.push('foreground'); });
  await Promise.all([background, background2, foreground]);
  assert.deepEqual(order, ['foreground', 'background-1', 'background-2']);
});

test('runtime operation priorities keep task launch state ahead of logs and derived snapshots', () => {
  assert.equal(runtimeOperationPriority('claim_run'), 0);
  assert.equal(runtimeOperationPriority('read_run_execution_plan'), 0);
  assert.equal(runtimeOperationPriority('checkpoint_current_run'), 0);
  assert.equal(runtimeOperationPriority('start_conversation'), 0);
  assert.equal(runtimeOperationPriority('observe_run_task_ingress'), 0);
  assert.equal(runtimeOperationPriority('record_claude_native_event'), 0);
  assert.equal(runtimeOperationPriority('prepare_agent_database'), 0);
  assert.equal(runtimeOperationPriority('claim_run_effect'), 1, 'background effect claims must not impersonate foreground run delivery');
  assert.equal(runtimeOperationPriority('append_run_log'), 2);
  assert.equal(runtimeOperationPriority('write_project_growth'), 2);
  assert.equal(runtimeOperationPriority('read'), 1);
});

test('an admitted asynchronous background operation never holds the foreground queue', async () => {
  const scheduler = new RuntimePriorityScheduler();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const background = scheduler.submit(2, async () => { await blocked; return 'background'; });
  await new Promise(resolve => setImmediate(resolve));
  const foreground = scheduler.submit(0, async () => 'foreground');
  assert.equal(await foreground, 'foreground');
  release();
  assert.equal(await background, 'background');
});
