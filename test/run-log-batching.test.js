const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const {
  captureRunLog,
  interactiveRunLogBatchMaxDelayMs,
  runLogBatchMaxBytes,
  runLogBatchMaxDelayFor,
  runLogBatchMaxDelayMs
} = require('../out/runLogBatching.js');

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

test('the batching profile isolates low latency to formal interactive PTY output', () => {
  assert.ok(interactiveRunLogBatchMaxDelayMs >= 150 && interactiveRunLogBatchMaxDelayMs <= 160,
    'interactive persistence must amortize SQLite transactions instead of committing terminal frames at display cadence');
  assert.equal(runLogBatchMaxDelayFor({ terminal: true, executionKind: 'formal', stream: 'stdout' }),
    interactiveRunLogBatchMaxDelayMs);
  assert.equal(runLogBatchMaxDelayFor({ terminal: false, executionKind: 'formal', stream: 'stdout' }), runLogBatchMaxDelayMs);
  assert.equal(runLogBatchMaxDelayFor({ terminal: true, executionKind: 'preflight', stream: 'stdout' }), runLogBatchMaxDelayMs);
  assert.equal(runLogBatchMaxDelayFor({ terminal: true, executionKind: 'formal', stream: 'stderr' }), runLogBatchMaxDelayMs);
});

test('an idle interactive capture performs no persistence writes', async () => {
  const stream = new PassThrough();
  let batches = 0;
  const capturing = captureRunLog(stream, {
    maxDelayMs: interactiveRunLogBatchMaxDelayMs,
    append: async () => { batches++; },
    forward: async () => undefined
  });
  await new Promise(resolve => setTimeout(resolve, interactiveRunLogBatchMaxDelayMs * 2));
  assert.equal(batches, 0);
  stream.end();
  await capturing;
  assert.equal(batches, 0);
});

test('interactive capture bounds ordinary small-frame persistence frequency', async () => {
  const stream = new PassThrough();
  let batches = 0;
  const startedAt = Date.now();
  const capturing = captureRunLog(stream, {
    maxDelayMs: interactiveRunLogBatchMaxDelayMs,
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
  assert.ok(transactionsPerSecond <= 7,
    `interactive batching persisted ${transactionsPerSecond.toFixed(1)} transactions per second`);
});

test('interactive capture flushes at the byte ceiling instead of growing an unbounded batch', async () => {
  const stream = new PassThrough();
  const batches = [];
  const capturing = captureRunLog(stream, {
    maxDelayMs: 1_000,
    append: async bytes => { batches.push(bytes.length); },
    forward: async () => undefined
  });
  stream.write(Buffer.alloc(runLogBatchMaxBytes));
  const deadline = Date.now() + 200;
  while (!batches.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(batches, [runLogBatchMaxBytes]);
  stream.end();
  await capturing;
});
