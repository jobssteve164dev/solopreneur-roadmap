const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const events = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const control = require('../out/autonomousRuntimeControl.js');
const { RuntimeExecutionScheduler } = require('../out/runtimePriorityScheduler.js');

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for Runtime state.');
}

async function waitForAsync(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for Runtime state.');
}

test('runtime control lets independent maintenance run beside an admitted control read', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-shared-scheduler-'));
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(globalRoot);
  const scheduler = new RuntimeExecutionScheduler();
  let server;
  let releaseRead;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  try {
    server = await control.startRuntimeControlServer({
      globalDataPath: globalRoot,
      runtimeId: 'runtime-shared-scheduler',
      scheduler,
      onCommand() { return { status: 'running' }; },
      onData: async request => {
        if (request.operation === 'read_project_registry') await readGate;
        return { operation: request.operation };
      }
    });

    const read = control.sendRuntimeDataRequest(globalRoot, {
      operation: 'read_project_registry', input: {}, deadlineAt: Date.now() + 2_000
    });
    await waitFor(() => scheduler.snapshot()['control-query'].active === 1);
    let maintenanceStarted = false;
    const maintenance = scheduler.submit('maintenance', async () => {
      maintenanceStarted = true;
      return 'maintained';
    }, { label: 'internal:planner-statistics' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(maintenanceStarted, true, 'an admitted control read must not globally lock an independent maintenance executor');
    assert.equal(await maintenance, 'maintained');

    releaseRead();
    assert.deepEqual(await read, { operation: 'read_project_registry' });
  } finally {
    releaseRead?.();
    if (server) await server.close();
    const endpointPath = path.join(globalRoot, 'runtime', 'control.json');
    if (fs.existsSync(endpointPath)) fs.unlinkSync(endpointPath);
    const runtimeRoot = path.join(globalRoot, 'runtime');
    if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
    if (fs.existsSync(globalRoot)) fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  }
});

test('runtime control authenticates local health, pause and resume commands', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-control-'));
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(globalRoot);
  const calls = [];
  let server;
  try {
    server = await control.startRuntimeControlServer({
      globalDataPath: globalRoot,
      runtimeId: 'runtime-control-test',
      entryPath: '/opt/solomap/out/autonomousRuntimeProcess.js',
      buildId: 'build-a',
      releaseVersion: '0.0.513',
      executorActivity: () => ({ 'writer-actor': { threadId: 7, queued: [], active: [
        { id: 3, kind: 'request', label: 'write_run_binding', phase: 'binding.commit', postedAt: 10, startedAt: 11, ageMs: 5 }
      ] } }),
      onCommand(command, replacement) {
        calls.push(replacement ? `${command}:${replacement.releaseVersion}:${replacement.buildId}` : command);
        return { status: command === 'pause' ? 'paused' : 'running' };
      }
    });

    const health = await control.sendRuntimeControlCommand(globalRoot, 'health');
    const paused = await control.sendRuntimeControlCommand(globalRoot, 'pause');
    const resumed = await control.sendRuntimeControlCommand(globalRoot, 'resume');
    await assert.rejects(
      control.sendRuntimeControlCommand(globalRoot, 'drain', { expectedRuntimeId: 'runtime-control-test' }),
      /runtime_replacement_unverified/
    );
    await assert.rejects(
      control.sendRuntimeControlCommand(globalRoot, 'drain', {
        expectedRuntimeId: 'runtime-control-test', replacementBuildId: 'build-old', replacementVersion: '0.0.512'
      }),
      /runtime_downgrade_rejected/
    );
    const sameReleaseDrained = await control.sendRuntimeControlCommand(globalRoot, 'drain', {
      expectedRuntimeId: 'runtime-control-test', replacementBuildId: 'build-b', replacementVersion: '0.0.513'
    });
    const newerReleaseDrained = await control.sendRuntimeControlCommand(globalRoot, 'drain', {
      expectedRuntimeId: 'runtime-control-test', replacementBuildId: 'build-b', replacementVersion: '0.0.514'
    });
    await assert.rejects(control.sendRuntimeControlCommand(globalRoot, 'drain', { expectedRuntimeId: 'replaced-runtime' }), /different_runtime/);

    assert.equal(health.ok, true);
    assert.equal(health.runtimeId, 'runtime-control-test');
    assert.equal(health.entryPath, '/opt/solomap/out/autonomousRuntimeProcess.js');
    assert.equal(health.buildId, 'build-a');
    assert.equal(health.releaseVersion, '0.0.513');
    assert.deepEqual(health.scheduler['foreground-command'], { active: 0, queued: 0, capacity: 2048, concurrency: 16, blockers: {} });
    assert.equal(health.executors['writer-actor'].active[0].phase, 'binding.commit');
    assert.equal(paused.status, 'paused');
    assert.equal(resumed.status, 'running');
    assert.equal(sameReleaseDrained.status, 'running');
    assert.equal(newerReleaseDrained.status, 'running');
    assert.deepEqual(calls, ['health', 'pause', 'resume', 'drain:0.0.513:build-b', 'drain:0.0.514:build-b']);
    const endpointPath = path.join(globalRoot, 'runtime', 'control.json');
    assert.equal(fs.statSync(endpointPath).mode & 0o777, 0o600);
  } finally {
    if (server) await server.close();
    const endpointPath = path.join(globalRoot, 'runtime', 'control.json');
    if (fs.existsSync(endpointPath)) fs.unlinkSync(endpointPath);
    const runtimeRoot = path.join(globalRoot, 'runtime');
    if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
    if (fs.existsSync(globalRoot)) fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  }
});

test('runtime control rejects requests without its private token', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-control-auth-'));
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(globalRoot);
  let server;
  try {
    server = await control.startRuntimeControlServer({
      globalDataPath: globalRoot,
      runtimeId: 'runtime-control-auth',
      onCommand() { return { status: 'running' }; }
    });
    await assert.rejects(
      control.sendRuntimeControlCommand(globalRoot, 'health', { token: 'wrong-token' }),
      /authentication/i
    );
  } finally {
    if (server) await server.close();
    const endpointPath = path.join(globalRoot, 'runtime', 'control.json');
    if (fs.existsSync(endpointPath)) fs.unlinkSync(endpointPath);
    const runtimeRoot = path.join(globalRoot, 'runtime');
    if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
    if (fs.existsSync(globalRoot)) fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  }
});

test('runtime control publishes an exact busy lease around accepted data work', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-control-busy-'));
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(globalRoot);
  let server;
  let release;
  let releaseInternal;
  try {
    const gate = new Promise(resolve => { release = resolve; });
    server = await control.startRuntimeControlServer({
      globalDataPath: globalRoot,
      runtimeId: 'runtime-control-busy',
      entryPath: '/opt/solomap/out/autonomousRuntimeProcess.js',
      buildId: 'build-busy',
      releaseVersion: '0.0.526',
      onCommand() { return { status: 'paused' }; },
      async onData() { await gate; return { done: true }; }
    });
    const endpointPath = path.join(globalRoot, 'runtime', 'control.json');
    const busyPath = path.join(globalRoot, 'runtime', 'control.busy.json');
    const pending = control.sendRuntimeDataRequest(globalRoot, { operation: 'slow_database_read', input: {} });
    await waitFor(() => fs.existsSync(busyPath));
    const endpoint = JSON.parse(fs.readFileSync(endpointPath, 'utf8'));
    const busy = JSON.parse(fs.readFileSync(busyPath, 'utf8'));
    assert.equal(endpoint.host, '127.0.0.1');
    assert.ok(Number.isInteger(endpoint.port) && endpoint.port > 0);
    assert.ok(typeof endpoint.token === 'string' && endpoint.token.length >= 32);
    assert.equal(busy.entryPath, '/opt/solomap/out/autonomousRuntimeProcess.js');
    assert.equal(busy.buildId, 'build-busy');
    assert.equal(busy.releaseVersion, '0.0.526');
    releaseInternal = server.beginBusy();
    release();
    assert.deepEqual(await pending, { done: true });
    assert.equal(fs.existsSync(busyPath), true, 'external completion must preserve an active internal lease');
    releaseInternal();
    releaseInternal = undefined;
    await waitFor(() => !fs.existsSync(busyPath));
  } finally {
    releaseInternal?.();
    release?.();
    if (server) await server.close();
    const endpointPath = path.join(globalRoot, 'runtime', 'control.json');
    if (fs.existsSync(endpointPath)) fs.unlinkSync(endpointPath);
    const runtimeRoot = path.join(globalRoot, 'runtime');
    if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
    if (fs.existsSync(globalRoot)) fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  }
});

test('accepted data work never performs busy-lease filesystem writes on the control-plane event loop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-control-async-busy-'));
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(globalRoot);
  let server;
  let release;
  const originalWriteFileSync = fs.writeFileSync;
  const originalRenameSync = fs.renameSync;
  const originalUnlinkSync = fs.unlinkSync;
  try {
    const gate = new Promise(resolve => { release = resolve; });
    server = await control.startRuntimeControlServer({
      globalDataPath: globalRoot,
      runtimeId: 'runtime-control-async-busy',
      entryPath: '/opt/solomap/out/autonomousRuntimeProcess.js',
      buildId: 'build-async-busy',
      releaseVersion: '0.0.638',
      onCommand() { return { status: 'running' }; },
      async onData() { await gate; return { done: true }; }
    });
    const busyPath = path.join(globalRoot, 'runtime', 'control.busy.json');
    const touchedSynchronously = [];
    fs.writeFileSync = (target, ...args) => {
      if (String(target).startsWith(busyPath)) touchedSynchronously.push(['write', String(target)]);
      return originalWriteFileSync(target, ...args);
    };
    fs.renameSync = (source, target) => {
      if (String(source).startsWith(busyPath) || String(target) === busyPath) touchedSynchronously.push(['rename', String(target)]);
      return originalRenameSync(source, target);
    };
    fs.unlinkSync = target => {
      if (String(target) === busyPath) touchedSynchronously.push(['unlink', String(target)]);
      return originalUnlinkSync(target);
    };
    const pending = control.sendRuntimeDataRequest(globalRoot, { operation: 'slow_database_read', input: {} });
    await waitFor(() => fs.existsSync(busyPath));
    release();
    assert.deepEqual(await pending, { done: true });
    await waitFor(() => !fs.existsSync(busyPath));
    assert.deepEqual(touchedSynchronously, []);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    fs.renameSync = originalRenameSync;
    fs.unlinkSync = originalUnlinkSync;
    release?.();
    if (server) await server.close();
    const endpointPath = path.join(globalRoot, 'runtime', 'control.json');
    if (fs.existsSync(endpointPath)) fs.unlinkSync(endpointPath);
    const runtimeRoot = path.join(globalRoot, 'runtime');
    if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
    if (fs.existsSync(globalRoot)) fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  }
});

test('the control plane streams worker-encoded results without serializing their data on its event loop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-control-encoded-result-'));
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(globalRoot);
  let server;
  const originalStringify = JSON.stringify;
  let controlPlaneDataSerializations = 0;
  try {
    server = await control.startRuntimeControlServer({
      globalDataPath: globalRoot,
      runtimeId: 'runtime-control-encoded-result',
      onCommand() { return { status: 'running' }; },
      onData() { return control.serializedRuntimeDataResult('{"value":"worker-encoded"}'); }
    });
    JSON.stringify = (value, ...args) => {
      if (value?.result) controlPlaneDataSerializations += 1;
      return originalStringify(value, ...args);
    };
    assert.deepEqual(await control.sendRuntimeDataRequest(globalRoot, { operation: 'slow_database_read', input: {} }), { value: 'worker-encoded' });
    assert.equal(controlPlaneDataSerializations, 0);
  } finally {
    JSON.stringify = originalStringify;
    if (server) await server.close();
    const endpointPath = path.join(globalRoot, 'runtime', 'control.json');
    if (fs.existsSync(endpointPath)) fs.unlinkSync(endpointPath);
    const runtimeRoot = path.join(globalRoot, 'runtime');
    if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
    if (fs.existsSync(globalRoot)) fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  }
});

test('worker-encoded responses are written in bounded frames without corrupting multiplexed replies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-control-bounded-frame-'));
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(globalRoot);
  const encoded = JSON.stringify({ value: 'x'.repeat(2 * 1024 * 1024) });
  let server;
  const originalWrite = net.Socket.prototype.write;
  const writes = [];
  try {
    server = await control.startRuntimeControlServer({
      globalDataPath: globalRoot,
      runtimeId: 'runtime-control-bounded-frame',
      onCommand() { return { status: 'running' }; },
      onData(request) {
        if (request.operation === 'read_project_registry') return control.serializedRuntimeDataResult(encoded);
        return { mode: 'harness' };
      }
    });
    net.Socket.prototype.write = function(chunk, ...args) {
      writes.push(Buffer.byteLength(typeof chunk === 'string' ? chunk : Buffer.from(chunk)));
      return originalWrite.call(this, chunk, ...args);
    };
    const large = control.sendRuntimeDataRequest(globalRoot, { operation: 'read_project_registry', input: {} });
    const mode = control.sendRuntimeDataRequest(globalRoot, { operation: 'read_intelligence_execution_mode', input: {}, deadlineAt: Date.now() + 500 });
    assert.deepEqual(await mode, { mode: 'harness' });
    assert.equal((await large).value.length, 2 * 1024 * 1024);
    assert.ok(Math.max(...writes) <= 64 * 1024, `unbounded_control_write:${Math.max(...writes)}`);
  } finally {
    net.Socket.prototype.write = originalWrite;
    if (server) await server.close();
    const endpointPath = path.join(globalRoot, 'runtime', 'control.json');
    if (fs.existsSync(endpointPath)) fs.unlinkSync(endpointPath);
    const runtimeRoot = path.join(globalRoot, 'runtime');
    if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
    if (fs.existsSync(globalRoot)) fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  }
});

test('busy marker cleanup never replaces the accepted database error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-control-busy-error-'));
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(globalRoot);
  let server;
  let release;
  const originalUnlink = fs.promises.unlink;
  try {
    const gate = new Promise(resolve => { release = resolve; });
    server = await control.startRuntimeControlServer({
      globalDataPath: globalRoot, runtimeId: 'runtime-control-busy-error',
      entryPath: '/opt/solomap/out/autonomousRuntimeProcess.js', buildId: 'build-error', releaseVersion: '0.0.526',
      onCommand() { return { status: 'paused' }; },
      async onData() { await gate; throw new Error('SQLITE_FULL'); }
    });
    const busyPath = path.join(globalRoot, 'runtime', 'control.busy.json');
    const pending = control.sendRuntimeDataRequest(globalRoot, { operation: 'failing_database_write', input: {} });
    await waitFor(() => fs.existsSync(busyPath));
    fs.promises.unlink = async target => {
      if (path.resolve(String(target)) === path.resolve(busyPath)) throw Object.assign(new Error('cleanup ENOSPC'), { code: 'ENOSPC' });
      return originalUnlink.call(fs.promises, target);
    };
    release();
    await assert.rejects(pending, /SQLITE_FULL/);
    fs.promises.unlink = originalUnlink;
    assert.equal(fs.existsSync(busyPath), true);
  } finally {
    fs.promises.unlink = originalUnlink;
    release?.();
    if (server) await server.close();
    for (const file of ['control.busy.json', 'control.json']) {
      const target = path.join(globalRoot, 'runtime', file);
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    const runtimeRoot = path.join(globalRoot, 'runtime');
    if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
    if (fs.existsSync(globalRoot)) fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  }
});

test('runtime control frames split TCP requests and closes idle clients', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-control-frame-'));
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(globalRoot);
  let server;
  try {
    server = await control.startRuntimeControlServer({
      globalDataPath: globalRoot,
      runtimeId: 'runtime-control-frame',
      onCommand() { return { status: 'running' }; }
    });
    const endpoint = JSON.parse(fs.readFileSync(path.join(globalRoot, 'runtime', 'control.json'), 'utf8'));
    const response = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
      let body = '';
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        const request = JSON.stringify({ token: endpoint.token, command: 'health' }) + '\n';
        socket.write(request.slice(0, 12));
        setTimeout(() => socket.write(request.slice(12)), 5);
      });
      socket.on('data', chunk => { body += chunk; });
      socket.once('error', reject);
      socket.once('end', () => resolve(JSON.parse(body)));
    });
    assert.equal(response.ok, true);
    const idle = net.createConnection({ host: endpoint.host, port: endpoint.port });
    await events.once(idle, 'connect');
    await server.close();
    server = undefined;
    if (!idle.destroyed) await events.once(idle, 'close');
    assert.equal(idle.destroyed, true);
  } finally {
    if (server) await server.close();
    const endpointPath = path.join(globalRoot, 'runtime', 'control.json');
    if (fs.existsSync(endpointPath)) fs.unlinkSync(endpointPath);
    const runtimeRoot = path.join(globalRoot, 'runtime');
    if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
    fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  }
});

test('runtime data reports an interrupted response without leaking a JSON parser error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-data-response-'));
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    socket.once('data', () => socket.end());
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    fs.writeFileSync(path.join(runtimeRoot, 'control.json'), JSON.stringify({
      schemaVersion: 1, runtimeId: 'interrupted-runtime', host: '127.0.0.1', port: address.port, token: 'fixture-token'
    }));
    await assert.rejects(
      control.sendRuntimeDataRequest(globalRoot, { operation: 'migration_overview', input: {} }),
      /runtime_data_response_incomplete/
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
    const endpoint = path.join(runtimeRoot, 'control.json');
    if (fs.existsSync(endpoint)) fs.unlinkSync(endpoint);
    fs.rmdirSync(runtimeRoot);
    fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  }
});

test('runtime data reconnects once when the endpoint is replaced before the request connects', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-data-replaced-'));
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const live = await control.startRuntimeControlServer({
    globalDataPath: globalRoot,
    runtimeId: 'replacement-runtime',
    onCommand() { return { status: 'running' }; },
    async onData(request) { return { operation: request.operation, recovered: true }; }
  });
  const endpointPath = path.join(runtimeRoot, 'control.json');
  const replacement = fs.readFileSync(endpointPath);
  const unavailable = net.createServer();
  await new Promise((resolve, reject) => {
    unavailable.once('error', reject);
    unavailable.listen(0, '127.0.0.1', resolve);
  });
  const address = unavailable.address();
  assert.ok(address && typeof address !== 'string');
  const stalePort = address.port;
  await new Promise(resolve => unavailable.close(resolve));
  fs.writeFileSync(endpointPath, JSON.stringify({
    schemaVersion: 1, runtimeId: 'stale-runtime', host: '127.0.0.1', port: stalePort, token: 'stale-token'
  }));
  const originalReadFile = fs.promises.readFile;
  let swapped = false;
  fs.promises.readFile = async function(file, ...args) {
    const bytes = await originalReadFile.call(this, file, ...args);
    if (!swapped && path.resolve(String(file)) === path.resolve(endpointPath)) {
      swapped = true;
      fs.writeFileSync(endpointPath, replacement);
    }
    return bytes;
  };
  try {
    const pending = control.sendRuntimeDataRequest(globalRoot, { operation: 'resume_conversation', input: { id: 1 } });
    assert.deepEqual(await pending, { operation: 'resume_conversation', recovered: true });
    assert.equal(swapped, true);
  } finally {
    fs.promises.readFile = originalReadFile;
    await live.close();
    if (fs.existsSync(endpointPath)) fs.unlinkSync(endpointPath);
    fs.rmdirSync(runtimeRoot); fs.rmdirSync(globalRoot); fs.rmdirSync(root);
  }
});

test('runtime data waits for a stale endpoint to be replaced during a handover', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-data-delayed-replacement-'));
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const live = await control.startRuntimeControlServer({
    globalDataPath: globalRoot,
    runtimeId: 'delayed-replacement-runtime',
    onCommand() { return { status: 'running' }; },
    async onData(request) { return { operation: request.operation, recovered: true }; }
  });
  const endpointPath = path.join(runtimeRoot, 'control.json');
  const replacement = fs.readFileSync(endpointPath);
  const unavailable = net.createServer();
  await new Promise((resolve, reject) => { unavailable.once('error', reject); unavailable.listen(0, '127.0.0.1', resolve); });
  const address = unavailable.address(); assert.ok(address && typeof address !== 'string');
  await new Promise(resolve => unavailable.close(resolve));
  fs.writeFileSync(endpointPath, JSON.stringify({ schemaVersion: 1, runtimeId: 'stale-runtime', host: '127.0.0.1', port: address.port, token: 'stale-token' }));
  const timer = setTimeout(() => fs.writeFileSync(endpointPath, replacement), 200);
  try {
    assert.deepEqual(await control.sendRuntimeDataRequest(globalRoot, { operation: 'resume_conversation', input: { id: 1 } }), { operation: 'resume_conversation', recovered: true });
  } finally {
    clearTimeout(timer); await live.close();
    if (fs.existsSync(endpointPath)) fs.unlinkSync(endpointPath);
    fs.rmdirSync(runtimeRoot); fs.rmdirSync(globalRoot); fs.rmdirSync(root);
  }
});

test('standalone runtime keeps Today suggestions fresh while autonomous execution is paused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-process-control-'));
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  fs.mkdirSync(globalRoot);
  fs.writeFileSync(path.join(globalRoot, 'projects.json'), JSON.stringify({ schemaVersion: 1, projects: [], hiddenProjects: [] }));
  new (require('../out/db/unifiedDataStore.js').UnifiedDataStore)(globalRoot).close();
  const child = childProcess.spawn(process.execPath, [
    path.resolve(__dirname, '../out/autonomousRuntimeProcess.js'),
    '--global-data-path', globalRoot,
    '--runtime-id', 'runtime-process-control',
    '--runtime-version', '0.0.514',
    '--interval-ms', '5000'
  ], { stdio: 'ignore' });
  try {
    await waitFor(() => fs.existsSync(path.join(runtimeRoot, 'control.json')));
    const health = await control.sendRuntimeControlCommand(globalRoot, 'health');
    assert.equal(health.owner, 'fallback');
    assert.equal(health.releaseVersion, '0.0.514');
    const readDecision = async () => {
      const state = await control.sendRuntimeDataRequest(globalRoot, {
        operation: 'read_host_settings',
        input: { namespace: 'runtime_shadow', ownerScope: 'global' }
      });
      return state.items.find(item => item.key === 'decision')?.value;
    };
    let decisionBeforeRefresh;
    await waitForAsync(async () => Boolean(decisionBeforeRefresh = await readDecision()));
    await control.sendRuntimeControlCommand(globalRoot, 'pause');
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'control.json'), 'utf8')).status, 'paused');
    const generatedBeforeRefresh = decisionBeforeRefresh.generatedAt;
    await new Promise(resolve => setTimeout(resolve, 20));
    const refreshed = await control.sendRuntimeControlCommand(globalRoot, 'refresh');
    assert.equal(refreshed.status, 'paused');
    await waitForAsync(async () => (await readDecision())?.generatedAt !== generatedBeforeRefresh);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'control.json'), 'utf8')).status, 'paused');
    const pauseState = await control.sendRuntimeDataRequest(globalRoot, {
      operation: 'read_host_settings',
      input: { namespace: 'runtime', ownerScope: 'global' }
    });
    assert.equal(pauseState.items.find(item => item.key === 'autonomyPaused').value, true);
    await control.sendRuntimeControlCommand(globalRoot, 'resume');
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'control.json'), 'utf8')).status, 'running');
    await assert.rejects(control.sendRuntimeControlCommand(globalRoot, 'drain', {
      expectedRuntimeId: 'runtime-process-control', replacementBuildId: 'older-build', replacementVersion: '0.0.513'
    }), /runtime_downgrade_rejected/);
    assert.equal((await control.sendRuntimeControlCommand(globalRoot, 'health')).status, 'running');
    await control.sendRuntimeControlCommand(globalRoot, 'stop');
    await events.once(child, 'exit');
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'control.json')), false);
    const stoppedStore = require('../out/db/unifiedDataStore.js').UnifiedDataStore.open(globalRoot);
    try {
      const events = stoppedStore.readDiagnosticEvents({ kind: 'operation', limit: 100 }).items;
      assert.ok(events.some(event => event.scope === 'runtime.shutdown.control_stop' && event.payload.pid === child.pid),
        'Runtime shutdown must retain its initiating reason and exact process identity');
    } finally { stoppedStore.close(); }
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    for (const fileName of ['control.json', 'owner.json', 'events.jsonl', 'execution-runtime.json', 'today-shadow.json']) {
      const filePath = path.join(runtimeRoot, fileName);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    for (const directoryName of ['autonomous-executions', 'isolated-workspaces']) {
      const directoryPath = path.join(runtimeRoot, directoryName);
      if (fs.existsSync(directoryPath)) fs.rmdirSync(directoryPath);
    }
    if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
    fs.unlinkSync(path.join(globalRoot, 'projects.json'));
    for (const name of ['solomap.db', 'solomap.db-wal', 'solomap.db-shm']) {
      const file = path.join(globalRoot, name);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    const diagnosticsRoot = path.join(globalRoot, 'diagnostics');
    const diagnosticsDay = path.join(diagnosticsRoot, new Date().toISOString().slice(0, 10));
    if (fs.existsSync(diagnosticsDay)) {
      const ownedDiagnostics = fs.readdirSync(diagnosticsDay);
      assert.ok(ownedDiagnostics.length <= 2, 'the fixture must not delete unclassified diagnostic files');
      if (ownedDiagnostics[0]) fs.unlinkSync(path.join(diagnosticsDay, ownedDiagnostics[0]));
      if (ownedDiagnostics[1]) fs.unlinkSync(path.join(diagnosticsDay, ownedDiagnostics[1]));
      fs.rmdirSync(diagnosticsDay); fs.rmdirSync(diagnosticsRoot);
    }
    fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  }
});
