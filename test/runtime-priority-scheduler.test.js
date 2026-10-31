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

test('runtime operation registry expresses execution domains without name inference', () => {
  assert.equal(runtimeOperationDefinition('claim_run').domain, 'foreground-command');
  assert.equal(runtimeOperationDefinition('read_run_execution_plan').domain, 'interactive-query');
  assert.equal(runtimeOperationDefinition('start_conversation').domain, 'foreground-command');
  assert.equal(runtimeOperationDefinition('write_internal_attachment').domain, 'foreground-command');
  assert.equal(runtimeOperationDefinition('read_database_overview').domain, 'background-query');
  assert.equal(runtimeOperationDefinition('backup').domain, 'maintenance');
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
