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
      onCommand(command) {
        calls.push(command);
        return { status: command === 'pause' ? 'paused' : 'running' };
      }
    });

    const health = await control.sendRuntimeControlCommand(globalRoot, 'health');
    const paused = await control.sendRuntimeControlCommand(globalRoot, 'pause');
    const resumed = await control.sendRuntimeControlCommand(globalRoot, 'resume');

    assert.equal(health.ok, true);
    assert.equal(health.runtimeId, 'runtime-control-test');
    assert.equal(paused.status, 'paused');
    assert.equal(resumed.status, 'running');
    assert.deepEqual(calls, ['health', 'pause', 'resume']);
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

test('standalone runtime stays paused and resumes through its authenticated control endpoint', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-process-control-'));
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  fs.mkdirSync(globalRoot);
  fs.writeFileSync(path.join(globalRoot, 'projects.json'), JSON.stringify({ schemaVersion: 1, projects: [], hiddenProjects: [] }));
  const child = childProcess.spawn(process.execPath, [
    path.resolve(__dirname, '../out/autonomousRuntimeProcess.js'),
    '--global-data-path', globalRoot,
    '--runtime-id', 'runtime-process-control',
    '--interval-ms', '5000'
  ], { stdio: 'ignore' });
  try {
    await waitFor(() => fs.existsSync(path.join(runtimeRoot, 'control.json')));
    await control.sendRuntimeControlCommand(globalRoot, 'pause');
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'state.json'), 'utf8')).status, 'paused');
    await control.sendRuntimeControlCommand(globalRoot, 'resume');
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'state.json'), 'utf8')).status, 'running');
    await control.sendRuntimeControlCommand(globalRoot, 'stop');
    await events.once(child, 'exit');
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'state.json'), 'utf8')).status, 'stopped');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    for (const fileName of ['control.json', 'events.jsonl', 'execution-runtime.json', 'state.json', 'today-shadow.json']) {
      const filePath = path.join(runtimeRoot, fileName);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    for (const directoryName of ['autonomous-executions', 'isolated-workspaces']) {
      const directoryPath = path.join(runtimeRoot, directoryName);
      if (fs.existsSync(directoryPath)) fs.rmdirSync(directoryPath);
    }
    if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
    fs.unlinkSync(path.join(globalRoot, 'projects.json'));
    fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  }
});
