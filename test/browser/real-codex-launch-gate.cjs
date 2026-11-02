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
const { chromium } = require('playwright');
const { sendRuntimeControlCommand } = require('../../out/autonomousRuntimeControl.js');

assert.ok(process.env.SOLOMAP_TEST_RUN_OWNERS, 'run this gate through scripts/run-node-tests.cjs so every owned process is reclaimed');
const candidateVsix = path.resolve(String(process.env.SOLOMAP_REAL_CODEX_VSIX || ''));
assert.ok(candidateVsix && fs.existsSync(candidateVsix), 'SOLOMAP_REAL_CODEX_VSIX must point to the packaged candidate');
const sharedDataRoot = String(process.env.SOLOMAP_REAL_CODEX_DATA_ROOT || '').trim()
  ? path.resolve(String(process.env.SOLOMAP_REAL_CODEX_DATA_ROOT)) : '';
if (sharedDataRoot) assert.equal(path.basename(sharedDataRoot), '.solomap-global', 'shared gate data root must be an exact .solomap-global root');
const loadGateReceipt = String(process.env.SOLOMAP_LOAD_GATE_RECEIPT || '').trim();
const loadGateReady = String(process.env.SOLOMAP_LOAD_GATE_READY || '').trim();
const loadGateStart = String(process.env.SOLOMAP_LOAD_GATE_START || '').trim();

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

function runMetadataByMarker(databasePath, marker) {
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
      if (JSON.stringify(status).includes(marker)) return { ...row, status };
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

test('packaged SoloMap returns a durable real Codex launch within ten seconds and reconciles Provider ingress', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-real-codex-gate-'));
  const extensions = path.join(base, 'extensions');
  const userData = path.join(base, 'user-data');
  const workspace = path.join(base, 'workspace');
  const globalData = sharedDataRoot || path.join(base, 'global-data');
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
    main: './driver.cjs', activationEvents: ['onStartupFinished'],
    contributes: { commands: [{ command: 'realCodexGate.open', title: 'Real Codex Gate: Open SoloMap' }] }
  }));
  const driverSource = `
    const vscode = require('vscode'), fs = require('node:fs');
    const receiptPath = ${JSON.stringify(receiptPath)}, workspace = ${JSON.stringify(workspace)};
    const loadGateReady = ${JSON.stringify(loadGateReady)}, loadGateStart = ${JSON.stringify(loadGateStart)};
    const terminalEvents = { opened: [], closed: [] };
    let receipt = { state: 'activating' };
    const isSoloMapTerminal = terminal => terminal.name.includes('(solomap)');
    const soloMapTerminals = () => vscode.window.terminals.filter(isSoloMapTerminal).map(terminal => terminal.name);
    const save = value => {
      let shared = {};
      try { shared = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); } catch {}
      receipt = { ...receipt, ...shared, ...value, terminals: soloMapTerminals(), terminalEvents };
      fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    };
    exports.activate = async context => {
      vscode.window.onDidOpenTerminal(terminal => {
        if (isSoloMapTerminal(terminal)) terminalEvents.opened.push(terminal.name);
        save({});
      });
      vscode.window.onDidCloseTerminal(terminal => {
        if (isSoloMapTerminal(terminal)) terminalEvents.closed.push(terminal.name);
        save({});
      });
      save({ state: 'activating' });
      try {
        const extension = vscode.extensions.getExtension('szlk.solopreneur-roadmap');
        if (!extension) throw new Error('candidate_extension_missing');
        await extension.activate();
        context.subscriptions.push(vscode.commands.registerCommand('realCodexGate.open', () =>
          vscode.commands.executeCommand('workbench.view.extension.solopreneur-sidebar-container')));
        if (loadGateReady) {
          fs.writeFileSync(loadGateReady, JSON.stringify({ schemaVersion: 1, extensionPath: extension.extensionPath,
            workspacePath: workspace, readyWallMs: Date.now() }), { flag: 'wx' });
          const deadline = Date.now() + 120000;
          while (!fs.existsSync(loadGateStart)) {
            if (Date.now() >= deadline) throw new Error('load_gate_start_timeout');
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        }
        save({ state: 'ready' });
      } catch (error) {
        save({ settledWallMs: Date.now(), state: 'error',
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
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
      args: ['--disable-dev-shm-usage', '--disable-gpu', '--disable-background-networking']
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(15_000);
    await page.goto(`http://127.0.0.1:${port}/?folder=${encodeURIComponent(workspace)}`);
    await page.waitForSelector('.monaco-workbench');
    try {
      await waitFor(() => {
        const current = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : null;
        if (current?.state === 'error') throw new Error(current.error);
        return current?.state === 'ready' ? current : null;
      }, 'driver did not make the real Webview ready', 120_000);
    } catch (error) {
      const hostTail = fs.existsSync(hostLogPath) ? fs.readFileSync(hostLogPath, 'utf8').slice(-12_000) : '';
      throw new Error(`${error.message}\n${hostTail}`);
    }
    const commandInput = page.locator('.quick-input-widget input').filter({ visible: true });
    for (let attempt = 0; attempt < 3 && !await commandInput.isVisible(); attempt += 1) {
      await page.locator('.monaco-workbench').click({ position: { x: 8, y: 8 } });
      await page.keyboard.press('Control+Shift+P');
      try { await commandInput.waitFor({ state: 'visible', timeout: 5_000 }); }
      catch { await page.keyboard.press('Escape'); }
    }
    await commandInput.waitFor({ state: 'visible', timeout: 5_000 });
    await commandInput.fill('>Real Codex Gate: Open SoloMap');
    await page.getByRole('option').filter({ hasText: 'Real Codex Gate: Open SoloMap' }).first().waitFor();
    await page.keyboard.press('Enter');
    const frame = await waitFor(async () => {
      for (const candidate of page.frames()) if (await candidate.locator('[data-project-conversation-input]').count()) return candidate;
      return null;
    }, 'the packaged SoloMap sidebar Webview did not render', 30_000);
    const workspaceProjectSelector = `[data-project-path=${JSON.stringify(workspace)}]`;
    const workspaceCard = frame.locator(`[data-select-project-path=${JSON.stringify(workspace)}]`).first();
    await workspaceCard.waitFor({ state: 'visible', timeout: 15_000 });
    await workspaceCard.evaluate(card => card.click());
    const workspaceComposer = frame.locator(`[data-project-conversation-input]${workspaceProjectSelector}`).first();
    await workspaceComposer.waitFor({ state: 'visible', timeout: 15_000 });
    await frame.locator(`[data-project-conversation-mode="solo"]${workspaceProjectSelector}`).click();
    const marker = `REAL_CODEX_GATE_OK_${crypto.randomUUID()}`;
    const prompt = `本轮仅做真实链路验证，不要修改任何文件。最终回复与 SoloMap 任务完成摘要都必须包含：${marker}。`;
    const composer = workspaceComposer;
    await composer.fill(prompt);
    const acceptedWallMs = Date.now();
    await frame.locator(`[data-project-continue-send]${workspaceProjectSelector}`).click();
    const databaseRoot = sharedDataRoot || path.join(globalData, '.solomap-global');
    const databasePath = path.join(databaseRoot, 'solomap.db');
    let launched;
    try {
      launched = await waitFor(() => {
        const run = runMetadataByMarker(databasePath, marker);
        if (!run?.status?.interactionId) return null;
        return { acceptedWallMs, marker, interactionId: run.status.interactionId, settledWallMs: Date.now() };
      }, 'the durable conversation launch did not return', 15_000, 25);
    } catch (error) {
      const currentReceipt = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : null;
      let run = null, timeline = [], runtimeHealth = null;
      try { run = runMetadataByMarker(databasePath, marker); } catch {}
      try { timeline = run?.status?.interactionId ? interactionTimeline(databasePath, run.status.interactionId) : []; } catch {}
      try { runtimeHealth = await sendRuntimeControlCommand(databaseRoot, 'health', { timeoutMs: 1_000 }); } catch {}
      const hostTail = fs.existsSync(hostLogPath) ? fs.readFileSync(hostLogPath, 'utf8').slice(-12_000) : '';
      throw new Error(`${error.message}\nreceipt=${JSON.stringify(currentReceipt)}\nrun=${JSON.stringify(run)}\ntimeline=${JSON.stringify(timeline)}\nruntimeHealth=${JSON.stringify(runtimeHealth)}\n${hostTail}`);
    }
    const launchElapsedMs = launched.settledWallMs - launched.acceptedWallMs;
    if (launchElapsedMs >= 10_000) {
      let run = null, timeline = [], runtimeHealth = null;
      try { run = runMetadata(databasePath, launched.interactionId); } catch {}
      try { timeline = interactionTimeline(databasePath, launched.interactionId); } catch {}
      try { runtimeHealth = await sendRuntimeControlCommand(databaseRoot, 'health', { timeoutMs: 1_000 }); } catch {}
      const hostTail = fs.existsSync(hostLogPath) ? fs.readFileSync(hostLogPath, 'utf8').slice(-12_000) : '';
      assert.fail(`real SoloMap conversation launch took ${launchElapsedMs}ms\nrun=${JSON.stringify(run)}\ntimeline=${JSON.stringify(timeline)}\nruntimeHealth=${JSON.stringify(runtimeHealth)}\n${hostTail}`);
    }
    const ingress = await waitFor(() => {
      const run = runMetadata(databasePath, launched.interactionId);
      return run?.status.taskIngressReceipt ? run : null;
    }, 'Provider-native task ingress receipt was not persisted', 45_000, 100);
    const taskReceipt = ingress.status.taskIngressReceipt;
    assert.equal(taskReceipt.authority, 'provider_native');
    assert.equal(taskReceipt.kind, 'codex_task_started');
    assert.equal(taskReceipt.interactionId, launched.interactionId);
    const launchTiming = await waitFor(() => {
      const timeline = interactionTimeline(databasePath, launched.interactionId);
      const agentLaunchElapsedMs = Number(timeline.find(event =>
        event.scope === 'terminal.delivery.agent.launch' && event.payload.status === 'ok')?.payload.elapsedMs);
      const firstOutputElapsedMs = Number(timeline.find(event =>
        event.scope === 'terminal.delivery.agent.first-output' && event.payload.status === 'ok')?.payload.elapsedMs);
      return Number.isFinite(agentLaunchElapsedMs) && Number.isFinite(firstOutputElapsedMs)
        ? { agentLaunchElapsedMs, firstOutputElapsedMs }
        : null;
    }, 'the authoritative Agent launch timing was not persisted', 15_000, 50);
    const { agentLaunchElapsedMs, firstOutputElapsedMs } = launchTiming;
    assert.ok(Number.isFinite(agentLaunchElapsedMs) && agentLaunchElapsedMs < 10_000,
      `real SoloMap Agent process did not launch within ten seconds: ${agentLaunchElapsedMs}`);
    assert.ok(Number.isFinite(firstOutputElapsedMs) && firstOutputElapsedMs < 15_000,
      `real SoloMap Agent did not produce first output within fifteen seconds: ${firstOutputElapsedMs}`);
    if (loadGateReceipt) {
      const temporaryReceipt = `${loadGateReceipt}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporaryReceipt, JSON.stringify({
      schemaVersion: 1, interactionId: launched.interactionId, acceptedWallMs: launched.acceptedWallMs,
      launchSettledWallMs: launched.settledWallMs,
      ingressObservedWallMs: Date.now(), taskIngressElapsedMs: taskReceipt.elapsedMs,
      agentLaunchElapsedMs, firstOutputElapsedMs, authority: taskReceipt.authority
      }), { flag: 'wx' });
      fs.renameSync(temporaryReceipt, loadGateReceipt);
    }
    const completed = await waitFor(() => {
      const run = runMetadata(databasePath, launched.interactionId);
      return run && String(run.status.checkpointEventId || '').endsWith(':complete') ? run : null;
    }, 'real Codex turn did not complete through the SoloMap MCP lifecycle', 180_000, 250);
    t.diagnostic(JSON.stringify({ interactionId: launched.interactionId, taskIngressElapsedMs: taskReceipt.elapsedMs,
      observerDelayMs: taskReceipt.observerDelayMs, checkpointSummary: completed.status.checkpointSummary }));
    assert.match(String(completed.status.checkpointSummary || ''), new RegExp(marker));
    assert.doesNotMatch(String(completed.status.checkpointSummary || ''), /工具.*不可用|not a function|未挂载|unavailable/i);
    const timeline = await waitFor(() => {
      const events = interactionTimeline(databasePath, launched.interactionId);
      const scopes = new Set(events.map(event => event.scope));
      return ['terminal.delivery.runner.spawn', 'terminal.delivery.agent.spawn', 'terminal.delivery.agent.first-output', 'terminal.delivery.task.ingress']
        .every(scope => scopes.has(scope)) ? events : null;
    }, 'the conversation launch did not persist a correlated end-to-end diagnostic timeline', 10_000, 100);
    t.diagnostic(JSON.stringify({ interactionId: launched.interactionId, timeline }));
    await new Promise(resolve => setTimeout(resolve, 1_000));
    const terminalReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.equal(terminalReceipt.terminals.length, 1, `one accepted conversation must keep exactly one terminal: ${JSON.stringify(terminalReceipt)}`);
    assert.equal(terminalReceipt.terminalEvents.opened.length, 1, `recovery must not create a second terminal: ${JSON.stringify(terminalReceipt)}`);
    assert.deepEqual(terminalReceipt.terminalEvents.closed, [], `runner exit must not close the terminal: ${JSON.stringify(terminalReceipt)}`);

    const profile = String(completed.status.agentLaunch?.codexProfile || '');
    assert.match(profile, /^solomap-[a-f0-9]{16}$/);
    const profilePath = path.join(process.env.CODEX_HOME, `${profile}.config.toml`);
    const parsedProfile = require('@iarna/toml').parse(fs.readFileSync(profilePath, 'utf8'));
    assert.equal(parsedProfile.mcp_servers.solomap_data.args.at(-1), databaseRoot);
    assert.match(String(completed.status.baseGitHash || ''), /^[a-f0-9]{40}$/);
    assert.equal(childProcess.execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), originalHead);
    assert.equal(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8'), originalReadme);
    assert.match(childProcess.execFileSync('git', ['-C', workspace, 'status', '--porcelain=v1', '--', 'README.md'], { encoding: 'utf8' }), /^ M README\.md\n$/);
    assert.equal(childProcess.execFileSync('git', ['-C', workspace, 'show', `${completed.status.baseGitHash}:README.md`], { encoding: 'utf8' }), '# Real Codex launch gate\n\ndirty rollback boundary\n');
    assert.equal(childProcess.execFileSync('git', ['-C', workspace, 'rev-parse', `refs/solomap/backups/${completed.status.baseGitHash}`], { encoding: 'utf8' }).trim(), completed.status.baseGitHash);
    assert.ok(Number.isFinite(taskReceipt.elapsedMs) && taskReceipt.elapsedMs >= 0);
    const finalReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.equal(finalReceipt.state, 'ready', finalReceipt.error || 'conversation command did not settle successfully');
    t.diagnostic(JSON.stringify({ interactionId: launched.interactionId, taskIngressElapsedMs: taskReceipt.elapsedMs,
      observerDelayMs: taskReceipt.observerDelayMs, profile, baseGitHash: completed.status.baseGitHash,
      productionMcpRoundTrip: true, cpuBurners: burners.length, retainedTerminals: terminalReceipt.terminals.length,
      openedTerminals: terminalReceipt.terminalEvents.opened.length, closedTerminals: terminalReceipt.terminalEvents.closed.length }));
  } finally {
    if (browser) await browser.close();
    for (const burner of burners) burner.kill('SIGTERM');
    server.kill('SIGTERM');
    await Promise.all([server, ...burners].map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode) resolve();
      else { child.once('exit', resolve); setTimeout(resolve, 2_000).unref(); }
    })));
  }
});
