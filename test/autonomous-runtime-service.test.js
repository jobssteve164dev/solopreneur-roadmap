const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const service = require('../out/autonomousRuntimeService.js');

test('runtime service command failure retains the service manager reason without command arguments', async () => {
  const privateArgument = 'private-credential';
  await assert.rejects(
    service.runRuntimeServiceCommand(process.execPath, ['-e', `process.stderr.write('Failed to connect to bus: No such file or directory'); process.exit(1)`, privateArgument]),
    error => {
      assert.match(error.message, /Failed to connect to bus: No such file or directory/);
      assert.doesNotMatch(error.message, /private-credential/);
      return true;
    }
  );
});

test('fallback runtime health requires a matching live control response', async t => {
  const host = require('../out/autonomousRuntimeHost.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-health-'));
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const statePath = path.join(runtimeRoot, 'state.json');
  t.after(() => {
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
    if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
    if (fs.existsSync(globalRoot)) fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  });
  const live = async () => ({ ok: true, runtimeId: 'test', status: 'running' });
  assert.equal((await host.inspectAutonomousRuntimeHealth(globalRoot, process.pid, Date.now(), live)).reason, 'missing_state');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId: 'test', pid: process.pid, status: 'running', heartbeatAt: '2020-01-01T00:00:00.000Z' }));
  assert.equal((await host.inspectAutonomousRuntimeHealth(globalRoot, process.pid, Date.now(), live)).reason, 'stale_heartbeat');
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId: 'test', pid: process.pid, status: 'running', heartbeatAt: new Date().toISOString() }));
  assert.deepEqual(await host.inspectAutonomousRuntimeHealth(globalRoot, process.pid, Date.now(), async () => { throw new Error('connection refused'); }), { healthy: false, reason: 'control_unavailable' });
  assert.deepEqual(await host.inspectAutonomousRuntimeHealth(globalRoot, process.pid, Date.now(), async () => ({ ok: true, runtimeId: 'other', status: 'running' })), { healthy: false, reason: 'different_runtime' });
  assert.deepEqual(await host.inspectAutonomousRuntimeHealth(globalRoot, process.pid, Date.now(), live), { healthy: true, reason: 'running' });
  assert.deepEqual(await host.inspectAutonomousRuntimeHealth(globalRoot, process.pid, Date.now(),
    async () => ({ ok: true, runtimeId: 'test', status: 'running', entryPath: '/opt/old/out/autonomousRuntimeProcess.js' }),
    '/opt/new/out/autonomousRuntimeProcess.js'), { healthy: false, reason: 'different_runtime_build' });
  assert.deepEqual(await host.inspectAutonomousRuntimeHealth(globalRoot, process.pid, Date.now(),
    async () => ({ ok: true, runtimeId: 'test', status: 'running', entryPath: '/opt/new/out/autonomousRuntimeProcess.js', buildId: 'old' }),
    '/opt/new/out/autonomousRuntimeProcess.js', 'new'), { healthy: false, reason: 'different_runtime_build' });
  assert.deepEqual(await host.inspectAutonomousRuntimeHealth(globalRoot, process.pid, Date.now(),
    async () => ({ ok: true, runtimeId: 'test', status: 'running', owner: 'fallback' }),
    undefined, undefined, 'service'), { healthy: false, reason: 'different_runtime_owner' });
  await assert.rejects(host.waitForAutonomousRuntimeHealth(globalRoot, 200,
    async () => ({ ok: true, runtimeId: 'test', status: 'running', owner: 'fallback' }),
    undefined, undefined, 'service'), /different_runtime_owner/);
  assert.deepEqual(await host.inspectAutonomousRuntimeHealth(globalRoot, process.pid, Date.now(),
    async () => ({ ok: true, runtimeId: 'test', status: 'running', owner: 'fallback' }),
    undefined, undefined, 'service', true), { healthy: false, reason: 'different_runtime_owner' });
  await assert.rejects(host.waitForAutonomousRuntimeHealth(globalRoot, 200, live,
    undefined, undefined, undefined, 'another-runtime', process.pid), /different_runtime/);
  await assert.rejects(host.waitForAutonomousRuntimeHealth(globalRoot, 200, live,
    undefined, undefined, undefined, 'test', process.pid + 1), /different_process/);
  await assert.rejects(host.waitForAutonomousRuntimeHealth(globalRoot, 100, live,
    undefined, undefined, undefined, undefined, undefined, true, 'test'), /same_runtime/);
  let transitionalChecks = 0;
  await host.waitForAutonomousRuntimeHealth(globalRoot, 200, async () => {
    transitionalChecks += 1;
    return { ok: true, runtimeId: transitionalChecks === 1 ? 'previous' : 'test', status: 'running' };
  }, undefined, undefined, undefined, undefined, undefined, false, undefined, true);
  assert.equal(transitionalChecks, 2);
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId: 'test', pid: process.pid, status: 'paused', heartbeatAt: new Date().toISOString() }));
  assert.deepEqual(await host.inspectAutonomousRuntimeHealth(globalRoot, process.pid, Date.now(), async () => ({ ok: true, runtimeId: 'test', status: 'paused' })), { healthy: true, reason: 'paused' });
});

test('a live runtime without control cannot be adopted or replaced', async t => {
  const host = require('../out/autonomousRuntimeHost.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-handoff-'));
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const statePath = path.join(runtimeRoot, 'state.json');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId: 'legacy', pid: process.pid, status: 'running', heartbeatAt: new Date().toISOString() }));
  t.after(() => { fs.unlinkSync(statePath); fs.rmdirSync(runtimeRoot); fs.rmdirSync(globalRoot); fs.rmdirSync(root); });
  let spawned = false;
  await assert.rejects(host.ensureHealthyAutonomousRuntime({
    extensionPath: '/opt/solomap', globalDataPath: globalRoot, buildId: 'new',
    sendHealth: async () => { throw new Error('control endpoint missing'); },
    spawnProcess: () => { spawned = true; throw new Error('must not spawn'); }
  }), /control_unavailable/);
  assert.equal(spawned, false);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).runtimeId, 'legacy');
});

test('a verified SoloMap runtime without control is terminated before fallback recovery', async t => {
  const host = require('../out/autonomousRuntimeHost.js');
  const runtime = require('../out/autonomousRuntime.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-recover-hung-'));
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const statePath = path.join(runtimeRoot, 'state.json');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId: 'hung', pid: process.pid, status: 'running', heartbeatAt: new Date().toISOString() }));
  let spawnedChild;
  t.after(() => {
    if (spawnedChild) spawnedChild.kill('SIGKILL');
    fs.unlinkSync(statePath); fs.rmdirSync(runtimeRoot); fs.rmdirSync(globalRoot); fs.rmdirSync(root);
  });
  let oldAlive = true;
  let terminated = 0;
  const result = await host.ensureHealthyAutonomousRuntime({
    extensionPath: '/opt/solomap-new', globalDataPath: globalRoot, buildId: 'new',
    isProcessAlive: pid => pid === process.pid ? oldAlive : true,
    sendHealth: async () => {
      const state = runtime.readRuntimeState(globalRoot);
      if (state.runtimeId === 'hung') throw new Error('control endpoint timed out');
      return { ok: true, runtimeId: state.runtimeId, status: state.status, entryPath: '/opt/solomap-new/out/autonomousRuntimeProcess.js', buildId: 'new' };
    },
    verifyRuntimeProcess: (pid, runtimeId) => pid === process.pid && runtimeId === 'hung',
    async terminateProcess(pid) { terminated = pid; oldAlive = false; },
    spawnProcess(command, args) {
      assert.equal(args[0], '/opt/solomap-new/out/autonomousRuntimeProcess.js');
      spawnedChild = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      return { pid: spawnedChild.pid, unref() {} };
    }
  });
  assert.equal(terminated, process.pid);
  assert.equal(result.started, true);
  assert.equal(runtime.readRuntimeState(globalRoot).pid, spawnedChild.pid);
});

test('a healthy runtime is reused only after its control identity matches the lease', async t => {
  const host = require('../out/autonomousRuntimeHost.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-reuse-'));
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const statePath = path.join(runtimeRoot, 'state.json');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId: 'owner', pid: process.pid, status: 'running', heartbeatAt: new Date().toISOString() }));
  t.after(() => { fs.unlinkSync(statePath); fs.rmdirSync(runtimeRoot); fs.rmdirSync(globalRoot); fs.rmdirSync(root); });
  const options = { extensionPath: '/opt/solomap', globalDataPath: globalRoot, buildId: 'new', spawnProcess: () => { throw new Error('must not spawn'); } };
  await assert.rejects(host.ensureHealthyAutonomousRuntime({ ...options,
    sendHealth: async () => ({ ok: true, runtimeId: 'other', status: 'running', entryPath: '/opt/solomap/out/autonomousRuntimeProcess.js', buildId: 'new' })
  }), /different_runtime/);
  assert.deepEqual(await host.ensureHealthyAutonomousRuntime({ ...options,
    sendHealth: async () => ({ ok: true, runtimeId: 'owner', status: 'running', entryPath: '/opt/solomap/out/autonomousRuntimeProcess.js', buildId: 'new' })
  }), { started: false, pid: process.pid, runtimeId: 'owner' });
});

test('a healthy older build drains before the new fallback runtime takes its lease', async t => {
  const host = require('../out/autonomousRuntimeHost.js');
  const runtime = require('../out/autonomousRuntime.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-upgrade-'));
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const statePath = path.join(runtimeRoot, 'state.json');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId: 'old', pid: process.pid, status: 'running', heartbeatAt: new Date().toISOString() }));
  t.after(() => { fs.unlinkSync(statePath); fs.rmdirSync(runtimeRoot); fs.rmdirSync(globalRoot); fs.rmdirSync(root); });
  let drained = false;
  const newPath = '/opt/new/out/autonomousRuntimeProcess.js';
  const result = await host.ensureHealthyAutonomousRuntime({
    extensionPath: '/opt/new', globalDataPath: globalRoot, buildId: 'new',
    isProcessAlive: () => !drained,
    sendHealth: async () => {
      const state = runtime.readRuntimeState(globalRoot);
      return { ok: true, runtimeId: state.runtimeId, status: state.status, buildId: state.runtimeId === 'old' ? 'old' : 'new',
        entryPath: state.runtimeId === 'old' ? '/opt/old/out/autonomousRuntimeProcess.js' : newPath };
    },
    async sendControl(command) {
      assert.equal(command, 'drain');
      runtime.updateRuntimeState(globalRoot, 'old', { status: 'stopped' });
      drained = true;
    },
    spawnProcess(command, args) {
      assert.equal(drained, true);
      assert.equal(args[0], newPath);
      return { pid: process.pid, unref() {} };
    }
  });
  assert.equal(result.started, true);
  assert.notEqual(result.runtimeId, 'old');
  assert.equal(runtime.readRuntimeState(globalRoot).runtimeId, result.runtimeId);
});

test('a known different runtime build is rejected without a startup wait', async t => {
  const host = require('../out/autonomousRuntimeHost.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-wrong-build-'));
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const statePath = path.join(runtimeRoot, 'state.json');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId: 'old', pid: process.pid, status: 'running', heartbeatAt: new Date().toISOString() }));
  t.after(() => { fs.unlinkSync(statePath); fs.rmdirSync(runtimeRoot); fs.rmdirSync(globalRoot); fs.rmdirSync(root); });
  let calls = 0;
  await assert.rejects(host.waitForAutonomousRuntimeHealth(globalRoot, 200, async () => {
    calls += 1;
    return { ok: true, runtimeId: 'old', status: 'running', entryPath: '/opt/old/out/autonomousRuntimeProcess.js' };
  }, '/opt/new/out/autonomousRuntimeProcess.js'), /different_runtime_build/);
  assert.equal(calls, 1);
});

test('runtime build identity changes when bundled code changes at the same path', t => {
  const identity = require('../out/runtimeBuildIdentity.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-build-id-'));
  const out = path.join(root, 'out');
  const source = path.join(out, 'autonomousRuntimeProcess.js');
  fs.mkdirSync(out);
  fs.writeFileSync(source, 'module.exports = 1;');
  t.after(() => { fs.unlinkSync(source); fs.rmdirSync(out); fs.rmdirSync(root); });
  const before = identity.runtimeBuildId(root);
  fs.writeFileSync(source, 'module.exports = 2;');
  const after = identity.runtimeBuildId(root);
  assert.notEqual(before, after);
});

test('a competing live lease is not overwritten during fallback startup', t => {
  const host = require('../out/autonomousRuntimeHost.js');
  const runtime = require('../out/autonomousRuntime.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-race-'));
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const statePath = path.join(runtimeRoot, 'state.json');
  t.after(() => { fs.unlinkSync(statePath); fs.rmdirSync(runtimeRoot); fs.rmdirSync(globalRoot); fs.rmdirSync(root); });
  const result = host.ensureAutonomousRuntime({
    extensionPath: '/opt/solomap', globalDataPath: globalRoot,
    isProcessAlive: () => true,
    spawnProcess() {
      runtime.claimRuntimeLease(globalRoot, { runtimeId: 'competitor', pid: 43210, isProcessAlive: () => true });
      return { pid: 54321, unref() {} };
    }
  });
  assert.deepEqual(result, { started: false, pid: 43210, runtimeId: 'competitor' });
  assert.equal(runtime.readRuntimeState(globalRoot).runtimeId, 'competitor');
});

test('Linux service manager is skipped when the user manager is unavailable', async () => {
  const calls = [];
  assert.equal(await service.isRuntimeServiceManagerAvailable('linux', async (command, args) => {
    calls.push([command, args]);
    throw new Error('Failed to connect to user scope bus');
  }, () => true), false);
  assert.deepEqual(calls, [['systemctl', ['--user', 'show-environment']]]);
  assert.equal(await service.isRuntimeServiceManagerAvailable('darwin', async () => { throw new Error('should not probe Linux manager'); }), true);
});

test('Linux service manager skips the probe when its socket is missing', async () => {
  let probes = 0;
  const available = await service.isRuntimeServiceManagerAvailable('linux', () => {
    probes++;
  }, () => false);
  assert.equal(available, false);
  assert.equal(probes, 0);
});

test('a disabled runtime stays disabled until resume clears its marker', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-disabled-'));
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const markerPath = path.join(runtimeRoot, 'service-disabled');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(markerPath, 'disabled\n');
  t.after(() => { if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath); fs.rmdirSync(runtimeRoot); fs.rmdirSync(globalRoot); fs.rmdirSync(root); });
  assert.equal(service.isAutonomousRuntimeDisabled(globalRoot), true);
  service.enableAutonomousRuntime(globalRoot);
  assert.equal(service.isAutonomousRuntimeDisabled(globalRoot), false);
});

test('linux runtime service starts at login and restarts after crashes', () => {
  const plan = service.buildRuntimeServicePlan({
    platform: 'linux',
    homeDir: '/home/alice',
    extensionPath: '/opt/solomap',
    globalDataPath: '/home/alice/.solomap-global',
    execPath: '/usr/bin/code',
    environment: { PATH: '/home/alice/.local/bin:/usr/bin' }
  });

  assert.equal(plan.definitionPath, '/home/alice/.config/systemd/user/solomap-runtime.service');
  assert.match(plan.definition, /WantedBy=default\.target/);
  assert.match(plan.definition, /Restart=on-failure/);
  assert.match(plan.definition, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(plan.definition, /PATH=\/home\/alice\/\.local\/bin:\/usr\/bin/);
  assert.match(plan.definition, /autonomousRuntimeProcess\.js/);
  assert.match(plan.definition, /"--runtime-owner" "service"/);
  assert.deepEqual(plan.installCommand, ['systemctl', ['--user', 'enable', '--now', 'solomap-runtime.service']]);
  assert.deepEqual(plan.statusCommand, ['systemctl', ['--user', 'is-active', '--quiet', 'solomap-runtime.service']]);
});

test('a healthy unchanged Linux runtime does not reload or reinstall during extension startup', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-existing-'));
  const homeDir = path.join(root, 'home');
  const globalRoot = path.join(root, '.solomap-global');
  const options = { platform: 'linux', homeDir, extensionPath: '/opt/solomap', globalDataPath: globalRoot, execPath: '/usr/bin/code' };
  const plan = service.buildRuntimeServicePlan(options);
  const registryPath = path.join(homeDir, '.config', 'solomap', 'runtime-service.json');
  fs.mkdirSync(path.dirname(plan.definitionPath), { recursive: true });
  fs.mkdirSync(globalRoot);
  fs.writeFileSync(plan.definitionPath, plan.definition);
  t.after(() => {
    if (fs.existsSync(plan.definitionPath)) fs.unlinkSync(plan.definitionPath);
    if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
    fs.rmdirSync(path.dirname(plan.definitionPath));
    fs.rmdirSync(path.dirname(path.dirname(plan.definitionPath)));
    fs.rmdirSync(path.dirname(registryPath));
    fs.rmdirSync(path.join(homeDir, '.config'));
    fs.rmdirSync(homeDir);
    fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  });
  const commands = [];
  const result = await service.ensureAutonomousRuntimeService({
    ...options,
    runCommand(command, args) { commands.push([command, args]); },
    async waitForHealth() {}
  });
  assert.equal(result.changed, false);
  assert.deepEqual(commands, [plan.statusCommand]);
  commands.length = 0;
  await service.ensureAutonomousRuntimeService({
    ...options,
    runCommand(command, args) {
      commands.push([command, args]);
      if (args.includes('is-active')) throw new Error('service inactive');
    },
    async waitForHealth() {}
  });
  assert.deepEqual(commands, [
    plan.statusCommand,
    plan.reloadCommand,
    plan.installCommand
  ]);
});

test('a loaded native service with an unhealthy runtime restarts and rechecks the shared health contract', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-restart-'));
  const homeDir = path.join(root, 'home');
  const globalRoot = path.join(root, '.solomap-global');
  const options = { platform: 'linux', homeDir, extensionPath: '/opt/solomap', globalDataPath: globalRoot, execPath: '/usr/bin/code' };
  const plan = service.buildRuntimeServicePlan(options);
  const registryPath = path.join(homeDir, '.config', 'solomap', 'runtime-service.json');
  fs.mkdirSync(path.dirname(plan.definitionPath), { recursive: true });
  fs.mkdirSync(globalRoot);
  fs.writeFileSync(plan.definitionPath, plan.definition);
  t.after(() => {
    fs.unlinkSync(plan.definitionPath);
    if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
    for (const dir of [path.dirname(plan.definitionPath), path.dirname(path.dirname(plan.definitionPath)), path.dirname(registryPath), path.join(homeDir, '.config'), homeDir, globalRoot, root]) {
      if (fs.existsSync(dir)) fs.rmdirSync(dir);
    }
  });
  const commands = [];
  let healthChecks = 0;
  const result = await service.ensureAutonomousRuntimeService({ ...options,
    runCommand(command, args) { commands.push([command, args]); },
    async waitForHealth() {
      healthChecks += 1;
      if (healthChecks === 1) throw new Error('different_runtime_build');
    }
  });
  assert.equal(result.installed, true);
  assert.equal(healthChecks, 2);
  assert.deepEqual(commands, [plan.statusCommand, plan.restartCommand]);
});

test('service restart waits for the exact runtime observed after health failed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-late-owner-'));
  const homeDir = path.join(root, 'home');
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const options = { platform: 'linux', homeDir, extensionPath: '/opt/solomap', globalDataPath: globalRoot };
  const plan = service.buildRuntimeServicePlan(options);
  const statePath = path.join(runtimeRoot, 'state.json');
  const registryPath = path.join(homeDir, '.config', 'solomap', 'runtime-service.json');
  fs.mkdirSync(path.dirname(plan.definitionPath), { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(plan.definitionPath, plan.definition);
  t.after(() => {
    fs.unlinkSync(plan.definitionPath); fs.unlinkSync(statePath);
    if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
    for (const dir of [path.dirname(plan.definitionPath), path.dirname(path.dirname(plan.definitionPath)), path.dirname(registryPath), path.join(homeDir, '.config'), runtimeRoot, homeDir, globalRoot, root]) {
      if (fs.existsSync(dir)) fs.rmdirSync(dir);
    }
  });
  const actions = [];
  let healthChecks = 0;
  await service.ensureAutonomousRuntimeService({ ...options,
    runCommand(command, args) { actions.push(args.includes('restart') ? 'restart' : 'status'); },
    async waitForHealth() {
      if (++healthChecks === 1) {
        fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId: 'late-owner', pid: process.pid, status: 'running', heartbeatAt: new Date().toISOString() }));
        throw new Error('different_runtime_build');
      }
      actions.push('health');
    },
    async sendControl(command, runtimeId) { actions.push(`${command}:${runtimeId}`); },
    async waitForDrain(pid, runtimeId) { actions.push(`wait:${pid}:${runtimeId}`); }
  });
  assert.deepEqual(actions, ['status', 'drain:late-owner', `wait:${process.pid}:late-owner`, 'restart', 'health']);
});

test('an unchanged native definition drains an active fallback before service takeover', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-native-takeover-'));
  const homeDir = path.join(root, 'home');
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const options = { platform: 'linux', homeDir, extensionPath: '/opt/solomap', globalDataPath: globalRoot };
  const plan = service.buildRuntimeServicePlan(options);
  const statePath = path.join(runtimeRoot, 'state.json');
  const registryPath = path.join(homeDir, '.config', 'solomap', 'runtime-service.json');
  fs.mkdirSync(path.dirname(plan.definitionPath), { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(plan.definitionPath, plan.definition);
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId: 'fallback', pid: process.pid, status: 'running', heartbeatAt: new Date().toISOString() }));
  t.after(() => {
    fs.unlinkSync(plan.definitionPath); fs.unlinkSync(statePath);
    if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
    for (const dir of [path.dirname(plan.definitionPath), path.dirname(path.dirname(plan.definitionPath)), path.dirname(registryPath), path.join(homeDir, '.config'), runtimeRoot, homeDir, globalRoot, root]) {
      if (fs.existsSync(dir)) fs.rmdirSync(dir);
    }
  });
  const actions = [];
  await service.ensureAutonomousRuntimeService({ ...options,
    runCommand(command, args) {
      actions.push(args.at(-1) === 'solomap-runtime.service' && args.includes('is-active') ? 'status' : args.includes('daemon-reload') ? 'reload' : 'install');
      if (args.includes('is-active')) throw new Error('inactive');
    },
    async sendControl(command) {
      actions.push(command);
      fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId: 'fallback', pid: process.pid, status: 'stopped', heartbeatAt: new Date().toISOString() }));
    },
    async waitForDrain() { actions.push('wait-drain'); },
    async waitForHealth() { actions.push('health'); }
  });
  assert.deepEqual(actions, ['status', 'drain', 'wait-drain', 'reload', 'install', 'health']);
});

test('an unresponsive live native runtime is not force restarted', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-native-undrainable-'));
  const homeDir = path.join(root, 'home');
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const options = { platform: 'linux', homeDir, extensionPath: '/opt/solomap', globalDataPath: globalRoot };
  const plan = service.buildRuntimeServicePlan(options);
  const statePath = path.join(runtimeRoot, 'state.json');
  const registryPath = path.join(homeDir, '.config', 'solomap', 'runtime-service.json');
  fs.mkdirSync(path.dirname(plan.definitionPath), { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(plan.definitionPath, plan.definition);
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId: 'legacy', pid: process.pid, status: 'running', heartbeatAt: new Date().toISOString() }));
  t.after(() => {
    fs.unlinkSync(plan.definitionPath); fs.unlinkSync(statePath);
    if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
    for (const dir of [path.dirname(plan.definitionPath), path.dirname(path.dirname(plan.definitionPath)), path.dirname(registryPath), path.join(homeDir, '.config'), runtimeRoot, homeDir, globalRoot, root]) {
      if (fs.existsSync(dir)) fs.rmdirSync(dir);
    }
  });
  const commands = [];
  await assert.rejects(service.ensureAutonomousRuntimeService({ ...options,
    runCommand(command, args) { commands.push([command, args]); },
    async sendControl() { throw new Error('control endpoint missing'); },
    async waitForHealth() { throw new Error('control_unavailable'); }
  }), /control_unavailable/);
  assert.deepEqual(commands, [plan.statusCommand]);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).runtimeId, 'legacy');
});

test('service install drains a live runtime, writes atomically and activates the user service', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-service-'));
  const homeDir = path.join(root, 'home');
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const statePath = path.join(runtimeRoot, 'state.json');
  fs.mkdirSync(homeDir);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId: 'fallback', pid: process.pid, status: 'running', heartbeatAt: new Date().toISOString() }));
  const commands = [];
  const controls = [];
  let result;
  try {
    result = await service.ensureAutonomousRuntimeService({
      platform: 'linux',
      homeDir,
      extensionPath: '/opt/solomap',
      globalDataPath: globalRoot,
      execPath: '/usr/bin/code',
      async sendControl(command) { controls.push(command); },
      async waitForDrain() { controls.push('wait'); },
      async waitForHealth() { controls.push('health'); },
      runCommand(command, args) { commands.push([command, args]); }
    });

    assert.equal(result.installed, true);
    assert.deepEqual(controls, ['drain', 'wait', 'health']);
    assert.deepEqual(commands, [
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', 'solomap-runtime.service']],
      ['systemctl', ['--user', 'restart', 'solomap-runtime.service']]
    ]);
    assert.match(fs.readFileSync(result.definitionPath, 'utf8'), /Restart=on-failure/);
  } finally {
    if (result?.definitionPath && fs.existsSync(result.definitionPath)) fs.unlinkSync(result.definitionPath);
    const registryPath = path.join(homeDir, '.config', 'solomap', 'runtime-service.json');
    if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
    const solomapDir = path.dirname(registryPath);
    if (fs.existsSync(solomapDir)) fs.rmdirSync(solomapDir);
    const userDir = path.join(homeDir, '.config', 'systemd', 'user');
    const systemdDir = path.dirname(userDir);
    const configDir = path.dirname(systemdDir);
    fs.unlinkSync(statePath);
    for (const directoryPath of [userDir, systemdDir, configDir, homeDir, runtimeRoot, globalRoot, root]) {
      if (fs.existsSync(directoryPath)) fs.rmdirSync(directoryPath);
    }
  }
});

test('service activation cannot replace a live runtime without a drain response', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-undrainable-'));
  const homeDir = path.join(root, 'home');
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  fs.mkdirSync(homeDir);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const statePath = path.join(runtimeRoot, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId: 'legacy', pid: process.pid, status: 'running', heartbeatAt: new Date().toISOString() }));
  t.after(() => {
    const registryPath = path.join(homeDir, '.config', 'solomap', 'runtime-service.json');
    const definitionPath = path.join(homeDir, '.config', 'systemd', 'user', 'solomap-runtime.service');
    if (fs.existsSync(definitionPath)) fs.unlinkSync(definitionPath);
    for (const directoryPath of [path.dirname(definitionPath), path.join(homeDir, '.config', 'systemd')]) {
      if (fs.existsSync(directoryPath)) fs.rmdirSync(directoryPath);
    }
    if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
    if (fs.existsSync(path.dirname(registryPath))) fs.rmdirSync(path.dirname(registryPath));
    if (fs.existsSync(path.join(homeDir, '.config'))) fs.rmdirSync(path.join(homeDir, '.config'));
    fs.unlinkSync(statePath); fs.rmdirSync(runtimeRoot); fs.rmdirSync(globalRoot); fs.rmdirSync(homeDir); fs.rmdirSync(root);
  });
  const commands = [];
  await assert.rejects(service.ensureAutonomousRuntimeService({
    platform: 'linux', homeDir, extensionPath: '/opt/solomap', globalDataPath: globalRoot,
    sendControl: async () => { throw new Error('missing endpoint'); },
    runCommand: async (command, args) => { commands.push([command, args]); },
    waitForHealth: async () => {}
  }), /control_unavailable/);
  assert.deepEqual(commands, []);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).runtimeId, 'legacy');
});

test('macOS reuses a loaded service and Windows disables task time and battery limits', async () => {
  const macPlan = service.buildRuntimeServicePlan({
    platform: 'darwin', homeDir: '/Users/alice', extensionPath: '/opt/solomap',
    globalDataPath: '/Users/alice/.solomap-global', execPath: '/usr/local/bin/code'
  });
  const windowsPlan = service.buildRuntimeServicePlan({
    platform: 'win32', homeDir: 'C:\\Users\\alice', extensionPath: 'C:\\solomap',
    globalDataPath: 'C:\\Users\\alice\\.solomap-global', execPath: 'C:\\Code\\Code.exe'
  });
  assert.deepEqual(macPlan.statusCommand, ['launchctl', ['print', `gui/${process.getuid?.() ?? 0}/site.szlk.solomap.runtime`]]);
  assert.match(windowsPlan.definition, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(windowsPlan.definition, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(windowsPlan.definition, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
});

test('Windows rollback ends the failed task before starting and validating the restored task', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-win-rollback-'));
  const homeDir = path.join(root, 'home');
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const appData = path.join(homeDir, 'AppData', 'Roaming');
  const options = { platform: 'win32', homeDir, extensionPath: 'C:\\SoloMap-new', globalDataPath: globalRoot,
    execPath: 'C:\\Code\\Code.exe', environment: { APPDATA: appData } };
  const plan = service.buildRuntimeServicePlan(options);
  const registryPath = path.join(appData, 'SoloMap', 'runtime-service.json');
  const statePath = path.join(runtimeRoot, 'state.json');
  fs.mkdirSync(path.dirname(plan.definitionPath), { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(plan.definitionPath, 'old task definition');
  t.after(() => {
    fs.unlinkSync(plan.definitionPath); fs.unlinkSync(statePath);
    if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
    for (const dir of [path.dirname(plan.definitionPath), appData, path.dirname(appData), path.dirname(path.dirname(appData)), homeDir, runtimeRoot, globalRoot, root]) {
      if (fs.existsSync(dir)) fs.rmdirSync(dir);
    }
  });
  const actions = [];
  let runs = 0;
  await assert.rejects(service.ensureAutonomousRuntimeService({ ...options,
    runCommand(command, args) {
      actions.push(args[0]);
      if (args[0] === '/Run' && ++runs === 1) {
        fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId: 'failed-new', pid: process.pid, status: 'running', heartbeatAt: new Date().toISOString() }));
      }
    },
    async sendControl(command, runtimeId) { actions.push(`${command}:${runtimeId}`); },
    async waitForDrain() { actions.push('wait-drain'); },
    async waitForHealth() { throw new Error('new task unhealthy'); },
    async waitForRollbackHealth(excludedRuntimeId) {
      actions.push(`health-excludes:${excludedRuntimeId}`);
    }
  }), /runtime_service_rollback/);
  assert.deepEqual(actions, ['/End', '/Create', '/Run', 'drain:failed-new', 'wait-drain', '/End', '/Create', '/Run', 'health-excludes:failed-new']);
  assert.equal(fs.readFileSync(plan.definitionPath, 'utf8'), 'old task definition');
});

test('a healthy unchanged Windows service is reused without draining or rerunning the task', async t => {
  const control = require('../out/autonomousRuntimeControl.js');
  const identity = require('../out/runtimeBuildIdentity.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-windows-reuse-'));
  const homeDir = path.join(root, 'home');
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const extensionPath = path.join(root, 'extension');
  const outRoot = path.join(extensionPath, 'out');
  const entryPath = path.join(outRoot, 'autonomousRuntimeProcess.js');
  const appData = path.join(homeDir, 'AppData', 'Roaming');
  const options = { platform: 'win32', homeDir, extensionPath, globalDataPath: globalRoot,
    execPath: 'C:\\Code\\Code.exe', environment: { APPDATA: appData } };
  const plan = service.buildRuntimeServicePlan(options);
  const registryPath = path.join(appData, 'SoloMap', 'runtime-service.json');
  const statePath = path.join(runtimeRoot, 'state.json');
  fs.mkdirSync(path.dirname(plan.definitionPath), { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(outRoot, { recursive: true });
  fs.writeFileSync(plan.definitionPath, plan.definition);
  fs.writeFileSync(entryPath, 'module.exports = {};');
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId: 'windows-service', pid: process.pid, status: 'running', heartbeatAt: new Date().toISOString() }));
  const server = await control.startRuntimeControlServer({ globalDataPath: globalRoot, runtimeId: 'windows-service',
    entryPath, buildId: identity.runtimeBuildId(extensionPath), owner: 'service', onCommand() { return { status: 'running' }; }
  });
  t.after(async () => {
    await server.close();
    for (const filePath of [statePath, plan.definitionPath, registryPath, entryPath]) if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    for (const dir of [path.dirname(plan.definitionPath), appData, path.dirname(appData), path.dirname(path.dirname(appData)), homeDir, runtimeRoot, globalRoot, outRoot, extensionPath, root]) {
      if (fs.existsSync(dir)) fs.rmdirSync(dir);
    }
  });
  const commands = [];
  const controls = [];
  const result = await service.ensureAutonomousRuntimeService({ ...options,
    runCommand(command, args) { commands.push([command, args]); },
    async sendControl(command) { controls.push(command); }
  });
  assert.equal(result.installed, true);
  assert.equal(result.changed, false);
  assert.deepEqual(commands, [['schtasks.exe', ['/Query', '/TN', 'SoloMap Runtime']]]);
  assert.deepEqual(controls, []);
  commands.length = 0;
  await service.ensureAutonomousRuntimeService({ ...options,
    runCommand(command, args) {
      commands.push([command, args]);
      if (args[0] === '/Query') throw new Error('task not registered');
    },
    async sendControl(command) { controls.push(command); }
  });
  assert.deepEqual(commands, [['schtasks.exe', ['/Query', '/TN', 'SoloMap Runtime']], plan.installCommand]);
  assert.deepEqual(controls, []);
});

test('failed first Windows activation drains its own runtime and ends the task before deletion', async t => {
  const control = require('../out/autonomousRuntimeControl.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-win-first-fail-'));
  const homeDir = path.join(root, 'home');
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const appData = path.join(homeDir, 'AppData', 'Roaming');
  const options = { platform: 'win32', homeDir, extensionPath: 'C:\\SoloMap', globalDataPath: globalRoot,
    execPath: 'C:\\Code\\Code.exe', environment: { APPDATA: appData } };
  const plan = service.buildRuntimeServicePlan(options);
  const registryPath = path.join(appData, 'SoloMap', 'runtime-service.json');
  const statePath = path.join(runtimeRoot, 'state.json');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  let server;
  t.after(async () => {
    if (server) await server.close();
    for (const filePath of [statePath, plan.definitionPath, registryPath]) if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    for (const dir of [path.dirname(plan.definitionPath), appData, path.dirname(appData), path.dirname(path.dirname(appData)), homeDir, runtimeRoot, globalRoot, root]) {
      if (fs.existsSync(dir)) fs.rmdirSync(dir);
    }
  });
  const actions = [];
  await assert.rejects(service.ensureAutonomousRuntimeService({ ...options,
    async runCommand(command, args) {
      actions.push(args[0]);
      if (args[0] === '/Run') {
        fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId: 'failed-service', pid: process.pid, status: 'running', heartbeatAt: new Date().toISOString() }));
        server = await control.startRuntimeControlServer({ globalDataPath: globalRoot, runtimeId: 'failed-service', owner: 'service',
          onCommand() { return { status: 'running' }; }
        });
      }
    },
    async sendControl(command, runtimeId) { actions.push(`${command}:${runtimeId}`); },
    async waitForDrain() { actions.push('wait-drain'); },
    async waitForTaskStopped() { actions.push('task-stopped'); },
    async waitForServiceStop(pid) { assert.equal(pid, process.pid); actions.push('wait-stop'); },
    async waitForHealth() { throw new Error('bad build'); }
  }), /bad build/);
  assert.deepEqual(actions, ['/Create', '/Run', 'drain:failed-service', 'wait-drain', '/End', 'task-stopped', 'wait-stop', '/Delete']);
});

test('first activation cleanup never drains a fallback that takes the lease after health', async t => {
  const control = require('../out/autonomousRuntimeControl.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-win-cleanup-race-'));
  const homeDir = path.join(root, 'home');
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const appData = path.join(homeDir, 'AppData', 'Roaming');
  const options = { platform: 'win32', homeDir, extensionPath: 'C:\\SoloMap', globalDataPath: globalRoot,
    execPath: 'C:\\Code\\Code.exe', environment: { APPDATA: appData } };
  const plan = service.buildRuntimeServicePlan(options);
  const registryPath = path.join(appData, 'SoloMap', 'runtime-service.json');
  const statePath = path.join(runtimeRoot, 'state.json');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const writeState = runtimeId => fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId,
    pid: process.pid, status: 'running', heartbeatAt: new Date().toISOString() }));
  let server;
  t.after(async () => {
    if (server) await server.close();
    for (const filePath of [statePath, plan.definitionPath, registryPath]) if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    for (const dir of [path.dirname(plan.definitionPath), appData, path.dirname(appData), path.dirname(path.dirname(appData)), homeDir, runtimeRoot, globalRoot, root]) {
      if (fs.existsSync(dir)) fs.rmdirSync(dir);
    }
  });
  const actions = [];
  await assert.rejects(service.ensureAutonomousRuntimeService({ ...options,
    async runCommand(command, args) {
      actions.push(args[0]);
      if (args[0] === '/Run') {
        writeState('service-before-race');
        server = await control.startRuntimeControlServer({ globalDataPath: globalRoot, runtimeId: 'service-before-race', owner: 'service',
          onCommand() { writeState('fallback-after-race'); return { status: 'running' }; }
        });
      }
    },
    async sendControl(command) { actions.push(command); },
    async waitForHealth() { throw new Error('unhealthy'); },
    async waitForTaskStopped() { actions.push('task-stopped'); },
    async waitForServiceStop() { actions.push('service-stopped'); }
  }), /unhealthy/);
  assert.deepEqual(actions, ['/Create', '/Run', '/End', 'task-stopped', 'service-stopped', '/Delete']);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).runtimeId, 'fallback-after-race');
});

test('uncertain Windows task cleanup retains registration and blocks fallback', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-win-cleanup-fail-'));
  const homeDir = path.join(root, 'home');
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const statePath = path.join(runtimeRoot, 'state.json');
  const appData = path.join(homeDir, 'AppData', 'Roaming');
  const options = { platform: 'win32', homeDir, extensionPath: 'C:\\SoloMap', globalDataPath: globalRoot,
    execPath: 'C:\\Code\\Code.exe', environment: { APPDATA: appData } };
  const plan = service.buildRuntimeServicePlan(options);
  const registryPath = path.join(appData, 'SoloMap', 'runtime-service.json');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  t.after(() => {
    for (const filePath of [plan.definitionPath, registryPath, statePath]) if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    for (const dir of [path.dirname(plan.definitionPath), appData, path.dirname(appData), path.dirname(path.dirname(appData)), homeDir, runtimeRoot, globalRoot, root]) {
      if (fs.existsSync(dir)) fs.rmdirSync(dir);
    }
  });
  const commands = [];
  await assert.rejects(service.ensureAutonomousRuntimeService({ ...options,
    runCommand(command, args) {
      commands.push(args[0]);
      if (args[0] === '/Run') fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1,
        runtimeId: 'unreachable-service', pid: process.pid, status: 'stopped', heartbeatAt: new Date().toISOString() }));
    },
    async waitForHealth() { throw new Error('unhealthy'); },
    async waitForTaskStopped() {},
    async waitForServiceStop(pid) { assert.equal(pid, process.pid); throw new Error('runtime still alive'); }
  }), /runtime_service_cleanup_failed/);
  assert.deepEqual(commands, ['/Create', '/Run', '/End']);
  assert.equal(fs.existsSync(plan.definitionPath), true);
});

test('an unchanged Windows scheduled task is started after registration', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-windows-start-'));
  const homeDir = path.join(root, 'home');
  const globalRoot = path.join(root, '.solomap-global');
  const appData = path.join(homeDir, 'AppData', 'Roaming');
  const options = { platform: 'win32', homeDir, extensionPath: 'C:\\SoloMap', globalDataPath: globalRoot,
    execPath: 'C:\\Code\\Code.exe', environment: { APPDATA: appData } };
  const plan = service.buildRuntimeServicePlan(options);
  const registryPath = path.join(appData, 'SoloMap', 'runtime-service.json');
  fs.mkdirSync(path.dirname(plan.definitionPath), { recursive: true });
  fs.mkdirSync(globalRoot);
  fs.writeFileSync(plan.definitionPath, plan.definition);
  t.after(() => {
    fs.unlinkSync(plan.definitionPath);
    if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
    for (const dir of [path.dirname(plan.definitionPath), appData, path.dirname(appData), path.dirname(path.dirname(appData)), homeDir, globalRoot, root]) {
      if (fs.existsSync(dir)) fs.rmdirSync(dir);
    }
  });
  const commands = [];
  let running = false;
  const result = await service.ensureAutonomousRuntimeService({ ...options,
    runCommand(command, args) {
      commands.push([command, args]);
      if (args[0] === '/Run') running = true;
    },
    async waitForHealth() {
      if (!running) throw new Error('task is not running');
    }
  });
  assert.equal(result.installed, true);
  assert.deepEqual(commands, [plan.installCommand, plan.restartCommand]);
});

test('extension CI and publishing use the Node runtime required by bundled Pi', () => {
  const projectRoot = path.resolve(__dirname, '..');
  for (const workflow of ['ci.yml', 'publish.yml', 'security.yml']) {
    const source = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', workflow), 'utf8');
    assert.doesNotMatch(source, /node-version:\s*20\b/);
  }
});

test('extension exposes pause, resume and service removal through the authenticated runtime control path', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const extensionSource = fs.readFileSync(path.join(projectRoot, 'src', 'extension.ts'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const commands = manifest.contributes.commands.map(item => item.command);

  assert.match(extensionSource, /ensureAutonomousRuntimeService/);
  assert.match(extensionSource, /sendRuntimeControlCommand/);
  assert.match(extensionSource, /disableAutonomousRuntimeService/);
  assert.ok(commands.includes('solopreneur.pauseAutonomousRuntime'));
  assert.ok(commands.includes('solopreneur.resumeAutonomousRuntime'));
  assert.ok(commands.includes('solopreneur.removeAutonomousRuntimeService'));
  assert.equal(manifest.scripts['vscode:uninstall'], 'node ./out/autonomousRuntimeUninstall.js');
});

test('sidebar registration and initial data request do not wait for background intelligence startup', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const extensionSource = fs.readFileSync(path.join(projectRoot, 'src', 'extension.ts'), 'utf8');
  const activation = extensionSource.slice(
    extensionSource.indexOf('export async function activate('),
    extensionSource.indexOf('\nlet projectActionLaunchQueue:')
  );
  const providerRegistration = activation.indexOf('registerWebviewViewProvider(');
  const runtimeStart = activation.lastIndexOf('ensureAutonomousRuntimeService({');
  assert.ok(providerRegistration >= 0 && runtimeStart > providerRegistration);
  assert.doesNotMatch(activation.slice(0, activation.indexOf('const showRoadmapDisposable')), /ensureAutonomousRuntimeService/);
  assert.match(activation.slice(0, providerRegistration), /onInitialDataReady: reconcileIntelligenceServiceOnce/);
  assert.ok(activation.indexOf('ensureSolomapMemoryStore(activationProjectRoot') > providerRegistration);
  assert.match(activation.slice(providerRegistration), /reconcileIntelligenceServiceOnce\(\);/);
});

test('failed service upgrade restores and restarts the previous definition', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-rollback-'));
  const homeDir = path.join(root, 'home');
  const globalRoot = path.join(root, '.solomap-global');
  const definitionPath = path.join(homeDir, '.config', 'systemd', 'user', 'solomap-runtime.service');
  fs.mkdirSync(path.dirname(definitionPath), { recursive: true });
  fs.mkdirSync(globalRoot);
  fs.writeFileSync(definitionPath, 'previous-service-definition\n', 'utf8');
  const commands = [];
  let failed = false;
  try {
    await assert.rejects(service.ensureAutonomousRuntimeService({
      platform: 'linux',
      homeDir,
      extensionPath: '/opt/solomap-new',
      globalDataPath: globalRoot,
      execPath: '/usr/bin/code',
      async sendControl() {},
      async waitForDrain() {},
      async waitForHealth() {},
      async waitForRollbackHealth() {},
      runCommand(command, args) {
        commands.push([command, args]);
        if (!failed && args.includes('restart')) {
          failed = true;
          throw new Error('restart failed');
        }
      }
    }), /runtime_service_rollback/);

    assert.equal(fs.readFileSync(definitionPath, 'utf8'), 'previous-service-definition\n');
    assert.deepEqual(commands.slice(-3), [
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', 'solomap-runtime.service']],
      ['systemctl', ['--user', 'restart', 'solomap-runtime.service']]
    ]);
  } finally {
    if (fs.existsSync(definitionPath)) fs.unlinkSync(definitionPath);
    const registryPath = path.join(homeDir, '.config', 'solomap', 'runtime-service.json');
    if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
    if (fs.existsSync(path.dirname(registryPath))) fs.rmdirSync(path.dirname(registryPath));
    for (const directoryPath of [path.dirname(definitionPath), path.join(homeDir, '.config', 'systemd'), path.join(homeDir, '.config'), homeDir, globalRoot, root]) {
      if (fs.existsSync(directoryPath)) fs.rmdirSync(directoryPath);
    }
  }
});

test('rollback accepts the restored old service through the real health contract', async t => {
  const control = require('../out/autonomousRuntimeControl.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-old-service-'));
  const homeDir = path.join(root, 'home');
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const statePath = path.join(runtimeRoot, 'state.json');
  const options = { platform: 'linux', homeDir, extensionPath: '/opt/solomap-new', globalDataPath: globalRoot };
  const definitionPath = service.buildRuntimeServicePlan(options).definitionPath;
  const registryPath = path.join(homeDir, '.config', 'solomap', 'runtime-service.json');
  fs.mkdirSync(path.dirname(definitionPath), { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(definitionPath, 'old service definition');
  let server;
  const serve = async runtimeId => {
    if (server) await server.close();
    fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId, pid: process.pid, status: 'running', heartbeatAt: new Date().toISOString() }));
    server = await control.startRuntimeControlServer({ globalDataPath: globalRoot, runtimeId,
      onCommand() { return { status: 'running' }; }
    });
  };
  t.after(async () => {
    if (server) await server.close();
    fs.unlinkSync(statePath); fs.unlinkSync(definitionPath);
    if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
    for (const dir of [path.dirname(definitionPath), path.dirname(path.dirname(definitionPath)), path.dirname(registryPath), path.join(homeDir, '.config'), runtimeRoot, homeDir, globalRoot, root]) {
      if (fs.existsSync(dir)) fs.rmdirSync(dir);
    }
  });
  let restarts = 0;
  await assert.rejects(service.ensureAutonomousRuntimeService({ ...options,
    async sendControl() {}, async waitForDrain() {},
    async waitForHealth() { throw new Error('new build unhealthy'); },
    async runCommand(command, args) {
      if (args.includes('restart')) await serve(++restarts === 1 ? 'failed-new' : 'restored-old');
    }
  }), /runtime_service_rollback/);
  assert.equal(restarts, 2);
  assert.equal(fs.readFileSync(definitionPath, 'utf8'), 'old service definition');
});

test('failed first activation unregisters its service without stopping a competing runtime', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-first-failure-'));
  const homeDir = path.join(root, 'home');
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(homeDir);
  fs.mkdirSync(globalRoot);
  const commands = [];
  const controls = [];
  const definitionPath = path.join(homeDir, '.config', 'systemd', 'user', 'solomap-runtime.service');
  const registryPath = path.join(homeDir, '.config', 'solomap', 'runtime-service.json');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const statePath = path.join(runtimeRoot, 'state.json');
  try {
    await assert.rejects(service.ensureAutonomousRuntimeService({
      platform: 'linux', homeDir, extensionPath: '/opt/solomap', globalDataPath: globalRoot,
      execPath: '/usr/bin/code',
      async sendControl(command) { controls.push(command); },
      async waitForDrain() {},
      async waitForHealth() {
        fs.mkdirSync(runtimeRoot, { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, runtimeId: 'competing-fallback', pid: process.pid, status: 'running', heartbeatAt: new Date().toISOString() }));
        throw new Error('unhealthy');
      },
      runCommand(command, args) { commands.push([command, args]); }
    }), /unhealthy/);

    assert.deepEqual(controls, []);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).runtimeId, 'competing-fallback');
    assert.ok(commands.some(([command, args]) => command === 'systemctl' && args.includes('disable')));
    assert.equal(fs.existsSync(definitionPath), false);
    assert.equal(fs.existsSync(registryPath), true);
  } finally {
    for (const filePath of [definitionPath, registryPath]) if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
    for (const directoryPath of [path.dirname(registryPath), path.dirname(definitionPath), path.join(homeDir, '.config', 'systemd'), path.join(homeDir, '.config'), homeDir, runtimeRoot, globalRoot, root]) {
      if (fs.existsSync(directoryPath)) fs.rmdirSync(directoryPath);
    }
  }
});

test('macOS rollback unloads the failed service before restoring the previous definition', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-mac-rollback-'));
  const homeDir = path.join(root, 'home');
  const globalRoot = path.join(root, '.solomap-global');
  const definitionPath = path.join(homeDir, 'Library', 'LaunchAgents', 'site.szlk.solomap.runtime.plist');
  fs.mkdirSync(path.dirname(definitionPath), { recursive: true });
  fs.mkdirSync(globalRoot);
  fs.writeFileSync(definitionPath, 'previous-plist\n', 'utf8');
  const commands = [];
  let healthChecks = 0;
  try {
    await assert.rejects(service.ensureAutonomousRuntimeService({
      platform: 'darwin', homeDir, extensionPath: '/opt/solomap-new', globalDataPath: globalRoot,
      execPath: '/usr/local/bin/code',
      async sendControl() {},
      async waitForDrain() {},
      async waitForHealth() {
        healthChecks += 1;
        if (healthChecks === 1) throw new Error('new service unhealthy');
      },
      async waitForRollbackHealth() { healthChecks += 1; },
      runCommand(command, args) { commands.push([command, args]); }
    }), /runtime_service_rollback/);

    assert.equal(fs.readFileSync(definitionPath, 'utf8'), 'previous-plist\n');
    assert.deepEqual(commands.slice(-3).map(([command, args]) => [command, args[0]]), [
      ['launchctl', 'bootout'],
      ['launchctl', 'bootstrap'],
      ['launchctl', 'kickstart']
    ]);
    assert.equal(healthChecks, 2);
  } finally {
    if (fs.existsSync(definitionPath)) fs.unlinkSync(definitionPath);
    const registryPath = path.join(homeDir, 'Library', 'Application Support', 'SoloMap', 'runtime-service.json');
    if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
    if (fs.existsSync(path.dirname(registryPath))) fs.rmdirSync(path.dirname(registryPath));
    const applicationSupportPath = path.dirname(path.dirname(registryPath));
    if (fs.existsSync(applicationSupportPath)) fs.rmdirSync(applicationSupportPath);
    for (const directoryPath of [path.dirname(definitionPath), path.join(homeDir, 'Library'), homeDir, globalRoot, root]) {
      if (fs.existsSync(directoryPath)) fs.rmdirSync(directoryPath);
    }
  }
});
