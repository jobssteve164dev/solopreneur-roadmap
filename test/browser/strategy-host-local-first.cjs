const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { chromium } = require('playwright');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('real Extension Host renders local strategy before a held model and delivers without losing edits', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-strategy-host-'));
  const repo = path.resolve(__dirname, '../..');
  const extensions = path.join(base, 'extensions'), driver = path.join(extensions, 'fixture.strategy-host-1.0.0');
  const workspace = path.join(base, 'portfolio', 'project-0');
  fs.mkdirSync(driver, { recursive: true }); fs.mkdirSync(workspace, { recursive: true });
  const receipt = path.join(base, 'receipt.json');
  fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ name: 'strategy-host', publisher: 'fixture', version: '1.0.0', engines: { vscode: '^1.106.0' }, main: './driver.cjs', activationEvents: ['onStartupFinished'], contributes: { commands: [
    { command: 'strategyHost.open', title: 'Strategy Host Fixture: Open' }, { command: 'strategyHost.complete', title: 'Strategy Host Fixture: Complete' }
  ] } }));
  const source = `
    const vscode = require('vscode'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
    const repo = ${JSON.stringify(repo)}, base = ${JSON.stringify(base)}, receipt = ${JSON.stringify(receipt)};
    const state = { ready: false, events: [] }; let cleanup;
    const write = () => fs.writeFileSync(receipt, JSON.stringify(state));
    exports.activate = async context => {
      try {
        const root = path.join(base, 'data');
        const { UnifiedDataStore } = require(path.join(repo, 'out/db/unifiedDataStore.js'));
        const { createRuntimeDataOperations } = require(path.join(repo, 'out/runtimeDataOperations.js'));
        const { startRuntimeControlServer } = require(path.join(repo, 'out/autonomousRuntimeControl.js'));
        const { claimRuntimeLease } = require(path.join(repo, 'out/autonomousRuntime.js'));
        const { runtimeBuildId } = require(path.join(repo, 'out/runtimeBuildIdentity.js'));
        const store = new UnifiedDataStore(root), ops = createRuntimeDataOperations(store);
        const runtimeId = 'strategy-host-fixture'; claimRuntimeLease(root, { runtimeId, pid: process.pid });
        const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId, entryPath: path.join(repo, 'out/autonomousRuntimeProcess.js'), buildId: runtimeBuildId(repo), onCommand: () => ({ status: 'running' }), onData: ops });
        cleanup = async () => { await server.close(); await ops.close(); store.close(); };
        const projects = [];
        for (let i = 0; i < 58; i++) {
          const project = path.join(base, 'portfolio', 'project-' + i);
          fs.mkdirSync(path.join(project, '.solopreneur'), { recursive: true });
          fs.writeFileSync(path.join(project, '.solopreneur/roadmap.csv'), 'id,title,stage,status\\n1,Deliver value,Build,Pending\\n');
          projects.push({ name: 'Host portfolio ' + i, path: project });
          await store.registerProject({ root: project, name: 'Host portfolio ' + i });
        }
        await require(path.join(repo, 'out/projectRegistry.js')).refreshProjectRegistry(root, () => ({ legacyProjects: projects }), (operation, input) => ops({ operation, input }));
        require(path.join(repo, 'out/cognitiveRuntimeConfig.js')).writeCognitiveRuntimeConfig(root, { mode: 'agent_cli', agentCli: 'codex', model: 'auto' });
        const diagnostics = require(path.join(repo, 'out/localDiagnostics.js'));
        diagnostics.configureLocalDiagnosticPersistence({ append: (_root, event) => store.appendDiagnosticEvent(event) });
        let completeModel; const held = new Promise(resolve => { completeModel = resolve; });
        // Only external services are fixtures; native database, host, webview bridge and rendering are real.
        require(path.join(repo, 'out/piAgentEngine.js')).EmbeddedPiAgentEngine = class {
          constructor() { this.id = 'host-fixture-model'; }
          async judgeStrategyPyramid(input) {
            state.modelWaiting = true; write(); await held;
            return { confidence: 'medium', stageTitle: '验证期', mainJudgment: 'Host verified intelligent judgment', strategicAction: '验证真实需求', constraint: '保持聚焦', risks: [], moves: [], recommendedScenarioPath: '先验证', projects: input.projects.map(project => ({ id: project.id, action: '观察', risk: '验证仍不足', advice: { doubleDown: '真实反馈', reduce: '无效扩张', observe: '转化结果' } })) };
          }
        };
        const filename = path.join(repo, 'out/extension.js');
        const subject = new Module(filename, module); subject.filename = filename; subject.paths = Module._nodeModulePaths(path.dirname(filename));
        subject._compile(fs.readFileSync(filename, 'utf8') + '\\nmodule.exports.fixtureOpen = openStrategyPyramidPanel; module.exports.fixturePanel = () => activeStrategyPyramidPanel; verifyPassportGrant = async () => ({ allowed: false, verificationUnavailable: true, reason: "offline_fixture" });', filename);
        const expiresAt = '2999-01-01T00:00:00Z';
        await context.globalState.update('solopreneur.settings', { globalDataPath: root, proEntitlements: { strategy_pyramid: true }, proAccount: { authenticated: true, allowed: true, email: 'fixture@example.invalid', expiresAt } });
        await context.secrets.store('solopreneur.passportGrant', JSON.stringify({ grant: 'host-fixture-grant', email: 'fixture@example.invalid', userId: 'fixture-user', expiresAt, entitlements: ['strategy_pyramid'] }));
        const viewContext = { extensionPath: repo, extensionUri: vscode.Uri.file(repo), subscriptions: context.subscriptions, globalState: context.globalState, secrets: context.secrets };
        context.subscriptions.push(vscode.commands.registerCommand('strategyHost.open', async () => {
          state.openedAt = performance.now(); write();
          await subject.exports.fixtureOpen(viewContext);
          subject.exports.fixturePanel().webview.onDidReceiveMessage(message => {
            if (message.command === 'strategy.rendered') { state.events.push({ phase: message.phase, elapsedMs: Math.round(performance.now() - state.openedAt) }); write(); }
          });
        }));
        context.subscriptions.push(vscode.commands.registerCommand('strategyHost.complete', () => completeModel()));
        state.ready = true; write();
      } catch (error) { state.error = error.stack; write(); }
    };
    exports.deactivate = async () => { if (cleanup) await cleanup(); };
  `;
  new vm.Script(source);
  fs.writeFileSync(path.join(driver, 'driver.cjs'), source);
  const config = path.join(base, 'server.yaml'); fs.writeFileSync(config, 'auth: none\n');
  const port = await freePort(), cdpPort = await freePort();
  const log = fs.openSync(path.join(base, 'host.log'), 'wx');
  const serverEnv = { ...process.env };
  for (const key of Object.keys(serverEnv)) if (/^VSCODE_|^ELECTRON_|^PORT$/.test(key)) delete serverEnv[key];
  const server = childProcess.spawn('code-server', ['--bind-addr', `127.0.0.1:${port}`, '--auth', 'none', '--config', config,
    '--user-data-dir', path.join(base, 'profile'), '--extensions-dir', extensions, '--disable-telemetry', '--disable-update-check', '--disable-workspace-trust', workspace], { env: serverEnv, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  let browser;
  const agentSession = `strategy-host-${process.pid}`;
  try {
    for (let attempt = 0; ; attempt++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch {}
      if (attempt >= 100) throw new Error('isolated_code_server_start_failed: ' + fs.readFileSync(path.join(base, 'host.log'), 'utf8'));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: [`--remote-debugging-port=${cdpPort}`] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000);
    await page.goto(`http://127.0.0.1:${port}/?folder=${encodeURIComponent(workspace)}`);
    await page.waitForSelector('.monaco-workbench');
    for (let attempt = 0; ; attempt++) {
      const state = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt)) : {};
      if (state.error) throw new Error(state.error);
      if (state.ready) break;
      if (attempt >= 300) throw new Error('fixture_extension_activation_failed');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const command = async title => {
      await page.keyboard.press('F1');
      await page.locator('.quick-input-widget input').fill('>' + title);
      await page.getByRole('option').filter({ hasText: title }).first().waitFor();
      await page.keyboard.press('Enter');
    };
    const started = performance.now(); await command('Strategy Host Fixture: Open');
    let frame;
    for (let attempt = 0; ; attempt++) {
      for (const candidate of page.frames()) if (await candidate.locator('#tab-portfolio').count()) { frame = candidate; break; }
      if (frame) break;
      if (attempt >= 100) throw new Error('strategy_host_webview_not_ready');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await frame.locator('[data-tab="portfolio"]').click();
    assert.equal(await frame.locator('.p-card').count(), 58);
    const localReadyMs = Math.round(performance.now() - started);
    assert.ok(localReadyMs < 10000, `host local readiness exceeded budget: ${localReadyMs}ms`);
    assert.equal(JSON.parse(fs.readFileSync(receipt)).modelWaiting, true);
    childProcess.execFileSync('agent-browser', ['--session', agentSession, '--cdp', String(cdpPort), 'snapshot', '-i'], { encoding: 'utf8', timeout: 20000 });
    await frame.locator('.p-card[data-p-index="0"]').click();
    await frame.locator('#field-abilities').fill('真实宿主中保留的草稿');
    await command('Strategy Host Fixture: Complete');
    await page.waitForTimeout(300);
    assert.equal(await frame.locator('#field-abilities').inputValue(), '真实宿主中保留的草稿');
    await frame.locator('#btn-close-drawer').click();
    await frame.getByText('Host verified intelligent judgment', { exact: true }).waitFor({ state: 'attached' });
    assert.equal(await frame.locator('.tab-btn.active').getAttribute('data-tab'), 'portfolio');
    await frame.locator('[data-tab="dashboard"]').click();
    await frame.getByText('Host verified intelligent judgment', { exact: true }).waitFor();
    await frame.locator('[data-tab="portfolio"]').click();
    await frame.locator('.p-card[data-p-index="0"]').click();
    await frame.locator('#field-abilities').fill('更新后的通信仍可使用');
    assert.equal(await frame.locator('#field-abilities').inputValue(), '更新后的通信仍可使用');
    const result = JSON.parse(fs.readFileSync(receipt));
    assert.ok(result.events.some(event => event.phase === 'local'));
    assert.ok(result.events.some(event => event.phase === 'complete'));
    t.diagnostic(JSON.stringify({ realExtensionHost: true, projects: 58, localReadyMs, hostEvents: result.events, backgroundBridgeAndEditing: true, externalServices: 'offline verification and held model fixtures' }));
  } finally {
    try { childProcess.execFileSync('agent-browser', ['--session', agentSession, 'close'], { stdio: 'ignore', timeout: 10000 }); } catch {}
    if (browser) await browser.close();
    server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode !== null || server.signalCode) resolve(); else server.once('exit', resolve); });
  }
});
