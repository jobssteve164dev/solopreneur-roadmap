const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const events = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const control = require('../out/autonomousRuntimeControl.js');

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
      onCommand(command) {
        calls.push(command);
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
    await assert.rejects(
      control.sendRuntimeControlCommand(globalRoot, 'drain', {
        expectedRuntimeId: 'runtime-control-test', replacementBuildId: 'build-b', replacementVersion: '0.0.513'
      }),
      /runtime_same_version_build_conflict/
    );
    const drained = await control.sendRuntimeControlCommand(globalRoot, 'drain', {
      expectedRuntimeId: 'runtime-control-test', replacementBuildId: 'build-b', replacementVersion: '0.0.514'
    });
    await assert.rejects(control.sendRuntimeControlCommand(globalRoot, 'drain', { expectedRuntimeId: 'replaced-runtime' }), /different_runtime/);

    assert.equal(health.ok, true);
    assert.equal(health.runtimeId, 'runtime-control-test');
    assert.equal(health.entryPath, '/opt/solomap/out/autonomousRuntimeProcess.js');
    assert.equal(health.buildId, 'build-a');
    assert.equal(health.releaseVersion, '0.0.513');
    assert.equal(paused.status, 'paused');
    assert.equal(resumed.status, 'running');
    assert.equal(drained.status, 'running');
    assert.deepEqual(calls, ['health', 'pause', 'resume', 'drain']);
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

test('busy marker cleanup never replaces the accepted database error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-control-busy-error-'));
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(globalRoot);
  let server;
  let release;
  const originalUnlink = fs.unlinkSync;
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
    fs.unlinkSync = target => {
      if (path.resolve(String(target)) === path.resolve(busyPath)) throw Object.assign(new Error('cleanup ENOSPC'), { code: 'ENOSPC' });
      return originalUnlink(target);
    };
    release();
    await assert.rejects(pending, /SQLITE_FULL/);
    fs.unlinkSync = originalUnlink;
    assert.equal(fs.existsSync(busyPath), true);
  } finally {
    fs.unlinkSync = originalUnlink;
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
