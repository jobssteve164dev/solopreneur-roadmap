const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { startRuntimeControlServer, sendRuntimeDataRequest } = require('../out/autonomousRuntimeControl.js');
const { claimRuntimeLease } = require('../out/autonomousRuntime.js');
const { shellQuote } = require('../out/agentCli.js');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 15000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'isolated runner must make progress');
    await pause(30);
  }
}

test('reclaiming the same Runtime preserves its published endpoint and database overview', async t => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-lease-reentry-')), '.solomap-global');
  const owner = { runtimeId: 'same-owner', pid: process.pid };
  claimRuntimeLease(root, owner);
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: owner.runtimeId,
    onCommand: () => ({ status: 'running' }), onData: () => ({ contents: { records: 7 } }) });
  t.after(() => server.close());
  const file = path.join(root, 'runtime/control.json');
  const before = fs.readFileSync(file);
  assert.equal(claimRuntimeLease(root, owner).acquired, true);
  assert.ok(fs.readFileSync(file).equals(before), 'same identity cannot erase host, port and token');
  assert.equal((await sendRuntimeDataRequest(root, { operation: 'read_database_overview', input: {} })).contents.records, 7);
});

test('five real conversations survive missing discovery and lost acknowledgements and retain complete output', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-five-conversations-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project');
  fs.mkdirSync(project);
  execFileSync('git', ['init', '-q', project]);
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
  const store = new UnifiedDataStore(root), ops = createRuntimeDataOperations(store);
  const runners = [], output = [], errors = [], storageFailures = new Set();
  let loseAcknowledgement = false, storageUnavailable = false;
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'five-owner',
    onCommand: () => ({ status: 'running' }), onData: async request => {
      if (storageUnavailable && request.operation === 'append_run_log') {
        storageFailures.add(Number(request.input.executionLogId));
        throw new Error('database_fixture_storage_unavailable');
      }
      const result = await ops(request);
      if (loseAcknowledgement && request.operation === 'append_run_log') throw new Error('runtime_data_response_incomplete');
      return result;
    } });
  const endpointFile = path.join(root, 'runtime/control.json');
  const endpoint = fs.readFileSync(endpointFile);
  t.after(async () => {
    fs.writeFileSync(endpointFile, endpoint);
    loseAcknowledgement = false; storageUnavailable = false;
    for (const runner of runners) if (runner.exitCode === null && runner.signalCode === null) {
      const ended = once(runner, 'exit'); runner.kill('SIGINT'); await ended;
    }
    await server.close(); await ops.close(); store.close();
  });
  const read = id => ops({ operation: 'read_run_state', input: { root: project, executionLogId: id } });
  for (let id = 1; id <= 5; id++) {
    await ops({ operation: 'prepare_run', input: { root: project, executionLogId: id, nodeId: '__solo__', runKind: 'solo', prompt: 'isolated input', userMessage: 'parallel conversation',
      command: `${shellQuote(process.execPath)} -e ${shellQuote("let n=0;const nl=String.fromCharCode(10);process.stdout.write('ready'+nl);setInterval(()=>process.stdout.write(String(++n)+nl),100);setTimeout(()=>process.exit(0),60000)")}`,
      metadata: { interactiveSession: true }, idempotencyKey: `five:${id}` } });
    const runner = spawn(process.execPath, [path.resolve(__dirname, '../out/runAgentProcess.js'), '--global-data-path', root, '--project-path', project, '--execution-log-id', String(id)],
      { cwd: project, env: require('./analysis-fixture.js').anonymousToolEnv(), stdio: 'pipe' });
    runners.push(runner); output.push([]); errors.push([]);
    runner.stdout.on('data', bytes => output[id - 1].push(bytes));
    runner.stderr.on('data', bytes => errors[id - 1].push(bytes));
    await until(() => Buffer.concat(output[id - 1]).includes(Buffer.from('ready')));
    assert.ok(runners.every(child => child.exitCode === null && child.signalCode === null), 'new conversations must preserve existing processes');
  }
  fs.writeFileSync(endpointFile, JSON.stringify({ schemaVersion: 1, runtimeId: 'starting-owner', pid: process.pid }));
  await pause(5500); // Exceeds the actual three-second discovery window.
  const survived = runners.every(child => child.exitCode === null && child.signalCode === null);
  fs.writeFileSync(endpointFile, endpoint);
  for (let id = 1; id <= 5; id++) {
    const state = await read(id);
    assert.ok(require('../out/processIdentity.js').isProcessOwnerAlive(state.status.agentChildPid, state.status.processChildBirth), 'database discovery failure must not kill the actual Agent child');
  }
  assert.ok(survived, errors.map(bytes => Buffer.concat(bytes).toString()).join('\n'));
  await until(() => output.every(bytes => Buffer.concat(bytes).toString().replace(/\r/g, '').includes('40\n')));
  fs.writeFileSync(endpointFile, JSON.stringify({ ...JSON.parse(endpoint), token: 'temporary-token-mismatch' }));
  await pause(5500);
  fs.writeFileSync(endpointFile, endpoint);
  for (let id = 1; id <= 5; id++) {
    const state = await read(id);
    assert.ok(require('../out/processIdentity.js').isProcessOwnerAlive(state.status.agentChildPid, state.status.processChildBirth), 'discovery authentication drift cannot stop a live Agent');
  }
  loseAcknowledgement = true;
  await pause(1200);
  assert.ok(runners.every(child => child.exitCode === null && child.signalCode === null), 'lost commit acknowledgement cannot kill Agents');
  loseAcknowledgement = false;
  await until(() => output.every(bytes => Buffer.concat(bytes).toString().replace(/\r/g, '').includes('50\n')));
  storageUnavailable = true;
  await until(() => storageFailures.size === 5);
  await pause(300);
  storageUnavailable = false;
  for (let id = 1; id <= 5; id++) {
    const state = await read(id);
    assert.ok(require('../out/processIdentity.js').isProcessOwnerAlive(state.status.agentChildPid, state.status.processChildBirth), 'a storage failure cannot terminate a live Agent');
  }
  await until(() => output.every(bytes => Buffer.concat(bytes).toString().replace(/\r/g, '').includes('60\n')));
  for (let id = 1; id <= 5; id++) {
    assert.equal((await read(id)).status.interactiveSessionClosed, undefined);
    const head = await ops({ operation: 'read_run_log_head', input: { root: project, executionLogId: id, stream: 'stdout' } });
    const log = await ops({ operation: 'read_run_log', input: { root: project, executionLogId: id, stream: 'stdout', offset: 0, limit: head.totalBytes } });
    const lines = Buffer.from(log.bytes, 'base64').toString().replace(/\r\n/g, '\n').trim().split('\n');
    assert.equal(lines.shift(), 'ready');
    lines.forEach((line, index) => assert.equal(Number(line), index + 1, 'idempotent replay must neither lose nor duplicate output'));
  }
});

test('a temporary health failure cannot terminate a verified current Runtime with a fresh heartbeat', async t => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-fresh-runtime-')), '.solomap-global');
  claimRuntimeLease(root, { runtimeId: 'fresh-owner', pid: process.pid });
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'fresh-owner',
    entryPath: '/fixture/out/autonomousRuntimeProcess.js', buildId: 'current-build', releaseVersion: '1.0.0',
    onCommand: () => ({ status: 'running' }) });
  t.after(() => server.close());
  const result = await require('../out/autonomousRuntimeHost.js').ensureHealthyAutonomousRuntime({
    extensionPath: '/fixture', globalDataPath: root, buildId: 'current-build', releaseVersion: '1.0.0',
    isProcessOwnerAlive: () => true, verifyRuntimeProcess: () => true,
    sendHealth: async () => { throw new Error('Runtime control request timed out.'); },
    terminateProcess: async () => assert.fail('a missed health response is not authority to terminate a live database owner'),
    spawnProcess: () => assert.fail('a second database owner must not start')
  });
  assert.deepEqual(result, { started: false, pid: process.pid, runtimeId: 'fresh-owner' });
});

test('explicit user interruption stops the Agent and preserves pending output until the same Runtime owner returns', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-offline-interrupt-'));
  const project = path.join(base, 'project'), root = path.join(base, '.solomap-global');
  fs.mkdirSync(project); execFileSync('git', ['init', '-q', project]);
  const store = new (require('../out/db/unifiedDataStore.js').UnifiedDataStore)(root);
  const ops = require('../out/runtimeDataOperations.js').createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'interrupt-owner',
    onCommand: () => ({ status: 'running' }), onData: ops });
  const file = path.join(root, 'runtime/control.json'), endpoint = fs.readFileSync(file);
  const release = path.join(base, 'release-output'), accepted = path.join(base, 'output-accepted');
  const source = `const fs=require('fs');process.stdout.write('ready\\n');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write('accepted offline🌿\\n',()=>fs.writeFileSync(${JSON.stringify(accepted)},'accepted'));setInterval(()=>{},1000)}},20)`;
  let runner;
  t.after(async () => {
    fs.writeFileSync(file, endpoint);
    if (runner && runner.exitCode === null && runner.signalCode === null) { const ended = once(runner, 'exit'); runner.kill('SIGINT'); await ended; }
    await server.close(); await ops.close(); store.close();
  });
  await ops({ operation: 'prepare_run', input: { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: 'isolated interruption', userMessage: 'explicit cancellation',
    command: `${shellQuote(process.execPath)} -e ${shellQuote(source)}`,
    metadata: { interactiveSession: true }, idempotencyKey: 'interrupt:prepare' } });
  runner = spawn(process.execPath, [path.resolve(__dirname, '../out/runAgentProcess.js'), '--global-data-path', root, '--project-path', project, '--execution-log-id', '1'],
    { cwd: project, env: require('./analysis-fixture.js').anonymousToolEnv(), stdio: 'pipe' });
  let visible = '';
  runner.stdout.on('data', bytes => { visible += bytes; }); runner.stderr.resume();
  await until(() => visible.includes('ready'));
  const state = await ops({ operation: 'read_run_state', input: { root: project, executionLogId: 1 } });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, runtimeId: 'starting', pid: process.pid }));
  fs.writeFileSync(release, 'release');
  await until(() => fs.existsSync(accepted));
  await pause(700);
  runner.kill('SIGINT');
  await until(() => !require('../out/processIdentity.js').isProcessOwnerAlive(state.status.agentChildPid, state.status.processChildBirth));
  assert.equal(runner.exitCode, null, 'received output must remain pending while persistence is unavailable');
  fs.writeFileSync(file, endpoint);
  await until(() => runner.exitCode !== null || runner.signalCode !== null);
  assert.equal(runner.exitCode, 130);
  assert.equal(require('../out/processIdentity.js').isProcessOwnerAlive(state.status.agentChildPid, state.status.processChildBirth), false);
  const log = await ops({ operation: 'read_run_log', input: { root: project, executionLogId: 1, stream: 'stdout' } });
  assert.equal(Buffer.from(log.bytes, 'base64').toString().replace(/\r/g, ''), 'ready\naccepted offline🌿\n');
});
