const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { HeadlessProcessExecutionBackend } = require('../out/headlessExecutionBackend.js');

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-headless-backend-'));
  const workspace = path.join(root, 'isolated-workspace');
  const outside = path.join(os.tmpdir(), `solomap-outside-${process.pid}-${Date.now()}`);
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  return { root, workspace, outside };
}

function removeFixture(fixture) {
  fs.rmdirSync(fixture.workspace);
  fs.rmdirSync(fixture.outside);
  fs.rmdirSync(fixture.root);
}

test('prepare rejects a workspace outside the configured isolation root before execution', async () => {
  const fixture = createFixture();
  try {
    const backend = new HeadlessProcessExecutionBackend({
      isolationRoot: fixture.root,
      readBaseRevision: async () => 'base-1'
    });

    await assert.rejects(
      backend.prepare({
        workspacePath: fixture.outside,
        command: process.execPath,
        args: ['-e', 'process.stdout.write("unexpected")'],
        baseRevision: 'base-1',
        timeoutMs: 5_000
      }),
      /outside the configured isolation root/
    );
  } finally {
    removeFixture(fixture);
  }
});

test('prepare rejects a stale base revision before execution', async () => {
  const fixture = createFixture();
  try {
    const backend = new HeadlessProcessExecutionBackend({
      isolationRoot: fixture.root,
      readBaseRevision: async () => 'base-current'
    });

    await assert.rejects(
      backend.prepare({
        workspacePath: fixture.workspace,
        command: process.execPath,
        args: ['-e', 'process.stdout.write("unexpected")'],
        baseRevision: 'base-stale',
        timeoutMs: 5_000
      }),
      /base revision changed/
    );
  } finally {
    removeFixture(fixture);
  }
});

test('start is idempotent for the same operation and collects process evidence', async () => {
  const fixture = createFixture();
  try {
    const backend = new HeadlessProcessExecutionBackend({
      isolationRoot: fixture.root,
      readBaseRevision: async () => 'base-1'
    });
    const prepared = await backend.prepare({
      workspacePath: fixture.workspace,
      command: process.execPath,
      args: ['-e', 'process.stdout.write("done")'],
      baseRevision: 'base-1',
      timeoutMs: 5_000
    });

    const [first, second] = await Promise.all([
      backend.start(prepared.preparedId, 'operation-1'),
      backend.start(prepared.preparedId, 'operation-1')
    ]);
    const evidence = await backend.collectEvidence(first.executionId);

    assert.equal(second.executionId, first.executionId);
    assert.equal(evidence.status, 'succeeded');
    assert.equal(evidence.exitCode, 0);
    assert.equal(evidence.stdout, 'done');
    assert.equal(evidence.workspacePath, fixture.workspace);
    assert.equal(evidence.baseRevision, 'base-1');
  } finally {
    removeFixture(fixture);
  }
});

test('start rejects a base revision that changed after prepare', async () => {
  const fixture = createFixture();
  let revision = 'base-1';
  try {
    const backend = new HeadlessProcessExecutionBackend({
      isolationRoot: fixture.root,
      readBaseRevision: async () => revision
    });
    const prepared = await backend.prepare({
      workspacePath: fixture.workspace,
      command: process.execPath,
      args: ['-e', 'process.stdout.write("unexpected")'],
      baseRevision: 'base-1',
      timeoutMs: 5_000
    });
    revision = 'base-2';

    await assert.rejects(
      backend.start(prepared.preparedId, 'operation-stale-after-prepare'),
      /base revision changed.*before start/
    );
  } finally {
    removeFixture(fixture);
  }
});

test('cancel stops a running headless process and reports the started side effect', async () => {
  const fixture = createFixture();
  try {
    const backend = new HeadlessProcessExecutionBackend({
      isolationRoot: fixture.root,
      readBaseRevision: async () => 'base-1'
    });
    const prepared = await backend.prepare({
      workspacePath: fixture.workspace,
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      baseRevision: 'base-1',
      timeoutMs: 10_000
    });
    const handle = await backend.start(prepared.preparedId, 'operation-cancel');

    const result = await backend.cancel(handle.executionId);
    const evidence = await backend.collectEvidence(handle.executionId);

    assert.equal(result.cancelled, true);
    assert.deepEqual(result.irreversibleSideEffects, ['process_started']);
    assert.equal(evidence.status, 'cancelled');
  } finally {
    removeFixture(fixture);
  }
});

test('timeout waits for the process to exit before publishing terminal evidence', async () => {
  const fixture = createFixture();
  try {
    const backend = new HeadlessProcessExecutionBackend({
      isolationRoot: fixture.root,
      readBaseRevision: async () => 'base-1'
    });
    const prepared = await backend.prepare({
      workspacePath: fixture.workspace,
      command: process.execPath,
      args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      baseRevision: 'base-1',
      timeoutMs: 20
    });
    const handle = await backend.start(prepared.preparedId, 'operation-timeout');

    const evidence = await backend.collectEvidence(handle.executionId);

    assert.equal(evidence.status, 'timed_out');
    assert.ok(['SIGTERM', 'SIGKILL'].includes(evidence.signal));
  } finally {
    removeFixture(fixture);
  }
});
