const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const { captureRunLog, responsiveRunLogBatchMaxDelayMs } = require('../out/runLogBatching.js');

async function* chunks(values, pauseMs = 0) {
  for (const value of values) {
    yield Buffer.from(value);
    if (pauseMs) await new Promise(resolve => setTimeout(resolve, pauseMs));
  }
}

test('captureRunLog coalesces rapid terminal frames without losing display bytes', async () => {
  const values = Array.from({ length: 120 }, (_, index) => `\u001b[${index % 40};1Hframe-${index}\u001b[0m`);
  const appended = [];
  const forwarded = [];
  const order = [];

  await captureRunLog(chunks(values), {
    maxBytes: 256 * 1024,
    maxDelayMs: 1_000,
    append: async bytes => { order.push('append'); appended.push(Buffer.from(bytes)); },
    forward: async bytes => { order.push('forward'); forwarded.push(Buffer.from(bytes)); }
  });

  const expected = Buffer.concat(values.map(value => Buffer.from(value)));
  assert.deepEqual(Buffer.concat(forwarded), expected);
  assert.deepEqual(Buffer.concat(appended), expected);
  assert.equal(forwarded.length, 1);
  assert.equal(appended.length, 1);
  assert.deepEqual(order, ['append', 'forward']);
});

test('captureRunLog flushes by byte limit and keeps batches in order', async () => {
  const values = ['abcd', 'efgh', 'ijkl'];
  const appended = [];

  await captureRunLog(chunks(values), {
    maxBytes: 6,
    maxDelayMs: 1_000,
    append: async bytes => appended.push(Buffer.from(bytes)),
    forward: async () => undefined
  });

  assert.deepEqual(appended.map(bytes => bytes.toString()), values);
});

for (const failingStage of ['append', 'forward']) test(`captureRunLog closes its iterator when ${failingStage} fails`, async () => {
  let returned = 0;
  let reads = 0;
  const iterator = {
    next() {
      reads++;
      if (reads === 1) return Promise.resolve({ done: false, value: Buffer.from('frame') });
      return new Promise(() => undefined);
    },
    return() { returned++; return Promise.resolve({ done: true }); }
  };
  const stream = { [Symbol.asyncIterator]: () => iterator };
  const failure = new Error(`${failingStage}_failed`);

  await assert.rejects(captureRunLog(stream, {
    maxBytes: 5,
    maxDelayMs: 1_000,
    append: async () => { if (failingStage === 'append') throw failure; },
    forward: async () => { if (failingStage === 'forward') throw failure; }
  }), failure);

  assert.equal(returned, 1);
});

test('captureRunLog propagates an append failure without waiting for an idle Node stream to close', async () => {
  const stream = new PassThrough();
  const failure = new Error('append_failed');
  stream.write('frame');
  try {
    const outcome = await Promise.race([
      captureRunLog(stream, {
        maxBytes: 5,
        maxDelayMs: 1_000,
        append: async () => { throw failure; },
        forward: async () => undefined
      }).then(() => ({ type: 'resolved' }), error => ({ type: 'rejected', error })),
      new Promise(resolve => setTimeout(() => resolve({ type: 'timeout' }), 100))
    ]);
    assert.deepEqual(outcome, { type: 'rejected', error: failure });
  } finally {
    stream.destroy();
  }
});

test('captureRunLog durably flushes a quiet stream before the next chunk arrives', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  async function* quietChunks() {
    yield Buffer.from('first');
    await gate;
    yield Buffer.from('second');
  }
  const appended = [];
  const forwarded = [];

  const capturing = captureRunLog(quietChunks(), {
    maxBytes: 256 * 1024,
    maxDelayMs: 20,
    append: async bytes => appended.push(bytes.toString()),
    forward: async bytes => forwarded.push(bytes.toString())
  });

  const deadline = Date.now() + 1_000;
  while (!appended.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(appended, ['first']);
  assert.deepEqual(forwarded, ['first']);
  release();
  await capturing;
  assert.deepEqual(appended, ['first', 'second']);
  assert.deepEqual(forwarded, ['first', 'second']);
});

test('captureRunLog reschedules an existing batch when its latency policy changes', async () => {
  const stream = new PassThrough();
  let responsive = false;
  let notifyDelayChange = () => {};
  const order = [];
  const capturing = captureRunLog(stream, {
    maxBytes: 256 * 1024,
    maxDelayMs: () => responsive ? 20 : 1_000,
    onDidChangeMaxDelay: listener => {
      notifyDelayChange = listener;
      return () => { notifyDelayChange = undefined; };
    },
    append: async bytes => order.push(`append:${bytes.toString()}`),
    forward: async bytes => order.push(`forward:${bytes.toString()}`)
  });
  try {
    stream.write('pending');
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(order, []);
    responsive = true;
    const startedAt = Date.now();
    notifyDelayChange();
    const deadline = startedAt + 200;
    while (order.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(order, ['append:pending', 'forward:pending']);
    assert.ok(Date.now() - startedAt < 200, 'the existing batch kept its original delay after the policy changed');
    responsive = false;
    stream.write('background');
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(order, ['append:pending', 'forward:pending'], 'background output lost its ordinary batching delay');
  } finally {
    stream.end();
    await capturing;
  }
  assert.deepEqual(order, ['append:pending', 'forward:pending', 'append:background', 'forward:background']);
});

test('responsive capture keeps sustained output below its database transaction ceiling', async () => {
  const stream = new PassThrough();
  let batches = 0;
  const startedAt = Date.now();
  const capturing = captureRunLog(stream, {
    maxDelayMs: responsiveRunLogBatchMaxDelayMs,
    append: async () => { batches++; },
    forward: async () => undefined
  });
  const interval = setInterval(() => stream.write('frame'), 1);
  try {
    await new Promise(resolve => setTimeout(resolve, 1_000));
  } finally {
    clearInterval(interval);
    stream.end();
  }
  await capturing;
  const elapsedMs = Date.now() - startedAt;
  const transactionsPerSecond = batches * 1_000 / elapsedMs;
  assert.ok(transactionsPerSecond <= 35,
    `responsive batching persisted ${transactionsPerSecond.toFixed(1)} transactions per second`);
});
