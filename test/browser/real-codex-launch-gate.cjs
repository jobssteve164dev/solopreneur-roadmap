const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

assert.ok(process.env.SOLOMAP_TEST_RUN_OWNERS, 'run this gate through scripts/run-node-tests.cjs so every owned process is reclaimed');
const candidateVsix = path.resolve(String(process.env.SOLOMAP_REAL_CODEX_VSIX || ''));
assert.ok(candidateVsix && fs.existsSync(candidateVsix), 'SOLOMAP_REAL_CODEX_VSIX must point to the packaged candidate');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(check, message, timeoutMs = 60_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

function runMetadata(databasePath, interactionId) {
  if (!fs.existsSync(databasePath)) return null;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT r.id AS run_id, r.status AS run_status, rc.generation, rc.current_turn_id, c.encoding, c.data
      FROM runs r
      JOIN run_control rc ON rc.run_id = r.id
      JOIN contents c ON c.id = rc.metadata_content_id
      ORDER BY r.started_at DESC
    `).all();
    for (const row of rows) {
      if (row.encoding !== 'utf8') continue;
      const status = JSON.parse(Buffer.from(row.data).toString('utf8'));
      if (status.interactionId === interactionId) return { ...row, status };
    }
    return null;
  } finally { database.close(); }
}

function interactionTimeline(databasePath, interactionId) {
  if (!fs.existsSync(databasePath)) return [];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(`
      SELECT occurred_at, scope, payload_json
      FROM diagnostic_events
      WHERE payload_json LIKE ?
      ORDER BY sequence
    `).all(`%${interactionId}%`).map(row => ({ occurredAt: row.occurred_at, scope: row.scope, payload: JSON.parse(row.payload_json) }));
  } finally { database.close(); }
}

test('packaged SoloMap enters a real Codex task within ten seconds under host load', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-real-codex-gate-'));
  const extensions = path.join(base, 'extensions');
  const userData = path.join(base, 'user-data');
  const workspace = path.join(base, 'workspace');
  const globalData = path.join(base, 'global-data');
  const driver = path.join(extensions, 'fixture.real-codex-gate-1.0.0');
  const receiptPath = path.join(base, 'receipt.json');
  const hostLogPath = path.join(base, 'host.log');
  for (const directory of [extensions, userData, workspace, globalData, driver, path.join(workspace, '.vscode')]) fs.mkdirSync(directory, { recursive: true });

  fs.writeFileSync(path.join(workspace, 'README.md'), '# Real Codex launch gate\n');
  childProcess.execFileSync('git', ['init', '--quiet', workspace]);
  childProcess.execFileSync('git', ['-C', workspace, 'config', 'user.email', 'gate@example.invalid']);
  childProcess.execFileSync('git', ['-C', workspace, 'config', 'user.name', 'SoloMap Gate']);
  childProcess.execFileSync('git', ['-C', workspace, 'add', 'README.md']);
  childProcess.execFileSync('git', ['-C', workspace, 'commit', '--quiet', '-m', 'gate baseline']);
  const originalHead = childProcess.execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Real Codex launch gate\n\ndirty rollback boundary\n');
  const originalReadme = fs.readFileSync(path.join(workspace, 'README.md'), 'utf8');
  fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({
    'solopreneur.cliPath': '/usr/local/bin/codex',
    'solopreneur.globalDataPath': globalData,
    'solopreneur.collaborationReviewMode': 'off',
    'solopreneur.taskPermissionMode': 'auto',
    'solopreneur.language': 'zh',
    'security.workspace.trust.enabled': false
  }, null, 2));

  const installEnv = { ...process.env, HOME: os.homedir() };
  childProcess.execFileSync('code-server', [
    '--user-data-dir', userData, '--extensions-dir', extensions,
    '--install-extension', candidateVsix, '--force'
  ], { env: installEnv, stdio: 'pipe' });

  fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({
    name: 'real-codex-gate', publisher: 'fixture', version: '1.0.0', engines: { vscode: '^1.106.0' },
    main: './driver.cjs', activationEvents: ['onStartupFinished']
  }));
  const driverSource = `
    const vscode = require('vscode'), crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os');
    const receiptPath = ${JSON.stringify(receiptPath)}, workspace = ${JSON.stringify(workspace)};
    const save = value => fs.writeFileSync(receiptPath, JSON.stringify(value));
    exports.activate = async () => {
      let interactionId = '';
      let acceptedWallMs = 0;
      save({ state: 'activating' });
      try {
        const extension = vscode.extensions.getExtension('szlk.solopreneur-roadmap');
        if (!extension) throw new Error('candidate_extension_missing');
        await extension.activate();
        interactionId = crypto.randomUUID();
        acceptedWallMs = Date.now();
        const budget = { schemaVersion: 1, interactionId, acceptedWallMs,
          acceptedBootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
          acceptedUptimeMs: Math.round(os.uptime() * 1000), elapsedFloorMs: 0 };
        save({ interactionId, acceptedWallMs, state: 'accepted' });
        const result = await vscode.commands.executeCommand('solopreneur.internalStartConversation', JSON.stringify({
          projectPath: workspace, mode: 'solo', agentCli: '/usr/local/bin/codex', model: '',
          message: '本轮仅做真实链路验证，不要修改任何文件。最终回复与 SoloMap 任务完成摘要都必须包含：REAL_CODEX_GATE_OK。',
          launchIntentId: 'real-codex-gate:' + interactionId, interactionBudget: budget
        }));
        save({ interactionId, acceptedWallMs, settledWallMs: Date.now(), state: 'started', result });
      } catch (error) {
        save({ interactionId, acceptedWallMs, settledWallMs: Date.now(), state: 'error',
          error: String(error && (error.stack || error.message) || error) });
      }
    };
  `;
  new vm.Script(driverSource);
  fs.writeFileSync(path.join(driver, 'driver.cjs'), driverSource);
  const extensionRegistryPath = path.join(extensions, 'extensions.json');
  const extensionRegistry = JSON.parse(fs.readFileSync(extensionRegistryPath, 'utf8'));
  extensionRegistry.push({
    identifier: { id: 'fixture.real-codex-gate' }, version: '1.0.0',
    location: { $mid: 1, path: driver, scheme: 'file' }, relativeLocation: path.basename(driver),
    metadata: { installedTimestamp: Date.now(), pinned: true, source: 'resource', isPreReleaseVersion: false }
  });
  fs.writeFileSync(extensionRegistryPath, JSON.stringify(extensionRegistry));

  const port = await freePort();
  const config = path.join(base, 'server.yaml');
  fs.writeFileSync(config, 'auth: none\n');
  const hostLog = fs.openSync(hostLogPath, 'wx');
  const env = { ...process.env, HOME: os.homedir() };
  for (const key of Object.keys(env)) if (/^VSCODE_|^ELECTRON_|^PORT$/.test(key)) delete env[key];
  const server = childProcess.spawn('code-server', [
    '--bind-addr', `127.0.0.1:${port}`, '--auth', 'none', '--config', config,
    '--user-data-dir', userData, '--extensions-dir', extensions,
    '--disable-telemetry', '--disable-update-check', '--disable-workspace-trust', workspace
  ], { env, stdio: ['ignore', hostLog, hostLog] });
  fs.closeSync(hostLog);
  const burners = [0, 1].map(() => childProcess.spawn(process.execPath, ['-e', 'for(;;){}'], { env, stdio: 'ignore' }));
  let browser;
  try {
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { return false; } }, 'isolated code-server did not start');
    browser = childProcess.spawn(process.env.CHROMIUM_PATH || '/usr/bin/chromium', [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-background-networking',
      `--user-data-dir=${path.join(base, 'chromium')}`,
      `http://127.0.0.1:${port}/?folder=${encodeURIComponent(workspace)}`
    ], { env, stdio: 'ignore' });
    let receipt;
    try {
      receipt = await waitFor(() => {
        const current = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : null;
        if (current?.state === 'error' && !current.interactionId) throw new Error(current.error);
        return current?.interactionId && ['accepted', 'started', 'error'].includes(current.state) ? current : null;
      }, 'driver did not accept the conversation', 30_000);
    } catch (error) {
      const hostTail = fs.existsSync(hostLogPath) ? fs.readFileSync(hostLogPath, 'utf8').slice(-12_000) : '';
      throw new Error(`${error.message}\n${hostTail}`);
    }
    const databasePath = path.join(globalData, '.solomap-global', 'solomap.db');
    const ingress = await waitFor(() => {
      const run = runMetadata(databasePath, receipt.interactionId);
      return run?.status.taskIngressReceipt ? run : null;
    }, 'Provider-native task ingress receipt was not persisted', 45_000, 100);
    const taskReceipt = ingress.status.taskIngressReceipt;
    assert.equal(taskReceipt.authority, 'provider_native');
    assert.equal(taskReceipt.kind, 'codex_task_started');
    assert.equal(taskReceipt.interactionId, receipt.interactionId);
    const completed = await waitFor(() => {
      const run = runMetadata(databasePath, receipt.interactionId);
      return run && String(run.status.checkpointEventId || '').endsWith(':complete') ? run : null;
    }, 'real Codex turn did not complete through the SoloMap MCP lifecycle', 180_000, 250);
    t.diagnostic(JSON.stringify({ interactionId: receipt.interactionId, taskIngressElapsedMs: taskReceipt.elapsedMs,
      observerDelayMs: taskReceipt.observerDelayMs, checkpointSummary: completed.status.checkpointSummary }));
    assert.match(String(completed.status.checkpointSummary || ''), /REAL_CODEX_GATE_OK/);
    assert.doesNotMatch(String(completed.status.checkpointSummary || ''), /工具.*不可用|not a function|未挂载|unavailable/i);
    const timeline = await waitFor(() => {
      const events = interactionTimeline(databasePath, receipt.interactionId);
      const scopes = new Set(events.map(event => event.scope));
      return ['terminal.delivery.runner.spawn', 'terminal.delivery.agent.spawn', 'terminal.delivery.agent.first-output', 'terminal.delivery.task.ingress']
        .every(scope => scopes.has(scope)) ? events : null;
    }, 'the conversation launch did not persist a correlated end-to-end diagnostic timeline', 10_000, 100);
    t.diagnostic(JSON.stringify({ interactionId: receipt.interactionId, timeline }));

    const profile = String(completed.status.agentLaunch?.codexProfile || '');
    assert.match(profile, /^solomap-[a-f0-9]{16}$/);
    const profilePath = path.join(process.env.CODEX_HOME, `${profile}.config.toml`);
    const parsedProfile = require('@iarna/toml').parse(fs.readFileSync(profilePath, 'utf8'));
    assert.equal(parsedProfile.mcp_servers.solomap_data.args.at(-1), path.join(globalData, '.solomap-global'));
    assert.match(String(completed.status.baseGitHash || ''), /^[a-f0-9]{40}$/);
    assert.equal(childProcess.execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), originalHead);
    assert.equal(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8'), originalReadme);
    assert.match(childProcess.execFileSync('git', ['-C', workspace, 'status', '--porcelain=v1', '--', 'README.md'], { encoding: 'utf8' }), /^ M README\.md\n$/);
    assert.equal(childProcess.execFileSync('git', ['-C', workspace, 'show', `${completed.status.baseGitHash}:README.md`], { encoding: 'utf8' }), '# Real Codex launch gate\n\ndirty rollback boundary\n');
    assert.equal(childProcess.execFileSync('git', ['-C', workspace, 'rev-parse', `refs/solomap/backups/${completed.status.baseGitHash}`], { encoding: 'utf8' }).trim(), completed.status.baseGitHash);
    assert.ok(taskReceipt.elapsedMs < 10_000, `real Codex task ingress took ${taskReceipt.elapsedMs}ms`);
    const finalReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.equal(finalReceipt.state, 'started', finalReceipt.error || 'conversation command did not settle successfully');
    t.diagnostic(JSON.stringify({ interactionId: receipt.interactionId, taskIngressElapsedMs: taskReceipt.elapsedMs,
      observerDelayMs: taskReceipt.observerDelayMs, profile, baseGitHash: completed.status.baseGitHash,
      productionMcpRoundTrip: true, cpuBurners: burners.length }));
  } finally {
    if (browser) browser.kill('SIGTERM');
    for (const burner of burners) burner.kill('SIGTERM');
    server.kill('SIGTERM');
    await Promise.all([server, ...burners, ...(browser ? [browser] : [])].map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode) resolve();
      else { child.once('exit', resolve); setTimeout(resolve, 2_000).unref(); }
    })));
  }
});
