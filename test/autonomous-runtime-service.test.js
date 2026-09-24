const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const service = require('../out/autonomousRuntimeService.js');

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
  assert.deepEqual(plan.installCommand, ['systemctl', ['--user', 'enable', '--now', 'solomap-runtime.service']]);
});

test('service install drains a live runtime, writes atomically and activates the user service', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-service-'));
  const homeDir = path.join(root, 'home');
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(homeDir);
  fs.mkdirSync(globalRoot);
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
    for (const directoryPath of [userDir, systemdDir, configDir, homeDir, globalRoot, root]) {
      if (fs.existsSync(directoryPath)) fs.rmdirSync(directoryPath);
    }
  }
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
      runCommand(command, args) {
        commands.push([command, args]);
        if (!failed && args.includes('restart')) {
          failed = true;
          throw new Error('restart failed');
        }
      }
    }), /restart failed/);

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

test('failed first activation stops and unregisters a newly loaded service while retaining cleanup registration', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-first-failure-'));
  const homeDir = path.join(root, 'home');
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(homeDir);
  fs.mkdirSync(globalRoot);
  const commands = [];
  const controls = [];
  const definitionPath = path.join(homeDir, '.config', 'systemd', 'user', 'solomap-runtime.service');
  const registryPath = path.join(homeDir, '.config', 'solomap', 'runtime-service.json');
  try {
    await assert.rejects(service.ensureAutonomousRuntimeService({
      platform: 'linux', homeDir, extensionPath: '/opt/solomap', globalDataPath: globalRoot,
      execPath: '/usr/bin/code',
      async sendControl(command) { controls.push(command); },
      async waitForDrain() {},
      async waitForHealth() { throw new Error('unhealthy'); },
      runCommand(command, args) { commands.push([command, args]); }
    }), /unhealthy/);

    assert.ok(controls.includes('stop'));
    assert.ok(commands.some(([command, args]) => command === 'systemctl' && args.includes('disable')));
    assert.equal(fs.existsSync(definitionPath), false);
    assert.equal(fs.existsSync(registryPath), true);
  } finally {
    for (const filePath of [definitionPath, registryPath]) if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    for (const directoryPath of [path.dirname(registryPath), path.dirname(definitionPath), path.join(homeDir, '.config', 'systemd'), path.join(homeDir, '.config'), homeDir, globalRoot, root]) {
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
      runCommand(command, args) { commands.push([command, args]); }
    }), /new service unhealthy/);

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
