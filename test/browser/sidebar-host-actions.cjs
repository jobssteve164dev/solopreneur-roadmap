const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { chromium } = require('playwright');

assert.ok(process.env.SOLOMAP_TEST_RUN_OWNERS, 'run this host fixture through scripts/run-node-tests.cjs so its owned temporary root is reclaimed');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(check, message, attempts = 300) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

test('real Extension Host keeps sidebar actions alive across a card refresh', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-sidebar-host-'));
  const repo = path.resolve(__dirname, '../..');
  const extensions = path.join(base, 'extensions');
  const driver = path.join(extensions, 'fixture.sidebar-host-1.0.0');
  const workspace = path.join(base, 'workspace');
  const receipt = path.join(base, 'receipt.json');
  const refreshMarker = path.join(base, 'refresh.marker');
  const nativeReceipt = path.join(base, 'native-receipt.json');
  const nativeCli = path.join(base, 'claude');
  fs.mkdirSync(driver, { recursive: true });
  fs.mkdirSync(path.join(workspace, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.solopreneur', 'roadmap.csv'),
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,Ship the fix,Preserve the current goal,Build,,claude,Ship the fix,Pending,2026-10-21T00:00:00.000Z,\n');
  childProcess.execFileSync('git', ['init', '--quiet', workspace]);
  childProcess.execFileSync('git', ['-C', workspace, 'config', 'user.email', 'fixture@example.invalid']);
  childProcess.execFileSync('git', ['-C', workspace, 'config', 'user.name', 'Fixture']);
  fs.writeFileSync(nativeCli, '#!/usr/bin/env node\n' + `
    const fs = require('node:fs');
    if (process.argv.includes('--help')) console.log('--session-id --resume --plugin-dir');
    else if (process.argv.includes('--version')) console.log('2.1.287');
    else fs.appendFileSync(${JSON.stringify(nativeReceipt)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
  `, { mode: 0o700 });
  fs.writeFileSync(path.join(driver, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path fill="white" d="M4 4h16v16H4z"/></svg>');
  fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({
    name: 'sidebar-host', publisher: 'fixture', version: '1.0.0', engines: { vscode: '^1.106.0' },
    main: './driver.cjs', activationEvents: ['onStartupFinished'],
    contributes: {
      commands: [{ command: 'sidebarHost.open', title: 'Sidebar Host Fixture: Open' }],
      viewsContainers: { activitybar: [{ id: 'sidebar-host', title: 'SoloMap', icon: 'icon.svg' }] },
      views: { 'sidebar-host': [{ type: 'webview', id: 'solopreneur.sidebar', name: 'SoloMap' }] }
    }
  }));
  const source = `
    const vscode = require('vscode'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
    const repo = ${JSON.stringify(repo)}, receipt = ${JSON.stringify(receipt)}, refreshMarker = ${JSON.stringify(refreshMarker)};
    const project = { path: ${JSON.stringify(workspace)}, name: 'Host project' };
    const settings = { globalDataPath: ${JSON.stringify(path.join(base, '.solomap-global'))}, language: 'zh', cliPath: ${JSON.stringify(nativeCli)}, globalPrompt: '宿主保存的设置', collaborationReviewMode: 'off', agentModelPreferences: {}, automationTasks: {} };
    const state = { ready: false, commands: [], refreshes: 0, errors: [], roadmap: false, growth: false, diagnostics: [] };
    const save = () => fs.writeFileSync(receipt, JSON.stringify(state));
    let provider;
    exports.activate = async context => { try {
      require(path.join(repo, 'out/localDiagnostics.js')).configureLocalDiagnosticPersistence({ append: (_root, event) => { state.diagnostics.push(event); save(); } });
      const filename = path.join(repo, 'out/extension.js');
      const subject = new Module(filename, module); subject.filename = filename; subject.paths = Module._nodeModulePaths(path.dirname(filename));
      subject._compile(fs.readFileSync(filename, 'utf8') + '\\nmodule.exports.action=handleSharedWebviewAction;module.exports.connect=(p,pr,se)=>{sidebarProvider=p;getPersistedSettings=()=>se;getSettingsWithRuntimeState=()=>se;getSettingsWithOpenCodeSecretState=async()=>se;refreshExtensionSettingsFromDatabase=async()=>{};refreshProAccountStatus=async()=>{};autonomousRuntimeHost_1.ensureHealthyAutonomousRuntime=async()=>({started:false});getProjects=()=>[pr];getProjectState=()=>({projects:[{...pr,autonomyEnabled:false,toolNetworkDisabled:false,autonomyEpoch:0}],selectedProjectPath:pr.path});readProjectRegistry=()=>({schemaVersion:1,updatedAt:new Date().toISOString(),projects:[pr],hiddenProjects:[],selectedProjectPath:pr.path});refreshProjectRegistryForContext=async()=>({registry:readProjectRegistry()});refreshProjectAutonomyAuthorizations=async()=>{};readUiState=async()=>({});patchUiState=async()=>({});activeProjectRoot=pr.path;};module.exports.bindEngine=(e,p)=>{syncEngine=e;syncEngineReady=true;getSelectedProjectPath=()=>p;};module.exports.snapshot=(c,p)=>getProjectConversationSnapshotForProject(c,p);module.exports.panels=()=>({roadmap:Boolean(activePanel),growth:Boolean(activeProjectGrowthPanel)});', filename);
      const store = new (require(path.join(repo, 'out/db/unifiedDataStore.js')).UnifiedDataStore)(settings.globalDataPath);
      const operations = require(path.join(repo, 'out/runtimeDataOperations.js')).createRuntimeDataOperations(store);
      const registered = await store.registerProject({ root: project.path });
      store.upsertProjectRunIndex(registered.projectId, { executionLogId: 1, nodeId: '__solo__', runKind: 'solo', agentCli: 'codex', status: 'Completed', durationMs: 600000, startedAt: '2026-10-19T09:00:00Z', finishedAt: '2026-10-19T09:10:00Z', totalTokens: 123 }, [{ filePath: 'src/result.ts', role: 'changed' }]);
      await require(path.join(repo, 'out/autonomousRuntimeControl.js')).startRuntimeControlServer({ globalDataPath: settings.globalDataPath, runtimeId: 'sidebar-host-fixture', onCommand: () => ({ status: 'running' }), onData: operations });
      const Provider = require(path.join(repo, 'out/sidebarProvider.js')).SolopreneurSidebarProvider;
      const actionContext = { ...context, extensionPath: repo, extensionUri: vscode.Uri.file(repo) };
      provider = new Provider(vscode.Uri.file(repo), { getNodes: () => engine.getNodes() }, {
        getSettings: () => settings, updateSettings: async () => {},
        getProjects: () => ({ projects: [project], selectedProjectPath: project.path }),
        readAgentAccountStatuses: async () => [],
        getProjectConversationSnapshot: projectPath => subject.exports.snapshot(actionContext, projectPath),
        dispatchSharedAction: async (message, target) => {
          state.commands.push(message.command); save();
          if (message.command === 'issue.getDetails') {
            await target.postMessage({ command: 'issueDetailsLoaded', projectPath: project.path, ok: true,
              issue: { number: 13, title: 'Improve home', state: 'OPEN' }, comments: [] });
            return true;
          }
          const handled = await subject.exports.action(actionContext, message, 'sidebar', target);
          if (message.command === 'project.openRoadmap' || message.command === 'project.openGrowth') {
            await new Promise(resolve => setTimeout(resolve, 100));
            Object.assign(state, subject.exports.panels()); save();
          }
          return handled;
        }
      });
      // External provider results are supplied by the isolated fixture below.
      provider._projectLoader.scheduleExternalSignals = () => {};
      const engine = new (require(path.join(repo, 'out/db/syncEngine.js')).SyncEngine)(path.join(project.path, '.solopreneur/roadmap.csv'), path.join(project.path, '.solopreneur/project_journal.db'), repo, settings.globalDataPath);
      const call = (operation, input) => operations({ operation, input });
      const parent = await require(path.join(repo, 'out/agentRunPreparation.js')).prepareAgentRun({
        agentCli: ${JSON.stringify(nativeCli)}, selectedModel: '', prompt: '继续完善首页', workspaceRoot: project.path,
        nodeId: '__solo__', executionLogId: 42, userMessage: '继续完善首页', runKind: 'solo', globalDataPath: settings.globalDataPath, taskPermissionMode: 'auto'
      }, call);
      await call('write_run_binding', { projectId: parent.projectId, executionLogId: 42, generation: parent.generation, expectedHeadRevision: 2,
        confirmSessionId: parent.status.plannedNativeSessionId, evidence: { source: 'isolated-host-fixture' }, idempotencyKey: 'host-confirm-session' });
      const client = new (require(path.join(repo, 'out/runLifecycleClient.js')).RunLifecycleClient)(call, settings.globalDataPath);
      const ref = require(path.join(repo, 'out/runLifecycleClient.js')).runStatusReference(project.path, 42);
      await client.stop(ref, await client.readStatus(ref), '关闭隔离的原对话', 'host-parent-stopped');
      await engine.initAndSync();
      subject.exports.connect(provider, project, settings);
      subject.exports.bindEngine(engine, project.path);
      fs.watchFile(refreshMarker, { interval: 20 }, () => {
        state.refreshes += 1; save();
        const deliver = message => { const current = provider.reconcileProjectMessage(message); if (current) void provider.postMessage(current); };
        deliver({ command: 'projectIssuesLoaded', projectPath: project.path, issues: { available: true, open: state.refreshes,
          items: [{ number: 13, title: 'Improve home', state: 'OPEN' }] } });
        deliver({ command: 'projectDeliveryLoaded', projectPath: project.path,
          delivery: { available: true, recentWorkflowRuns: [{ name: 'CI', conclusion: 'failure' }] } });
      });
      context.subscriptions.push(vscode.window.registerWebviewViewProvider('solopreneur.sidebar', provider));
      context.subscriptions.push(vscode.commands.registerCommand('sidebarHost.open', () => vscode.commands.executeCommand('workbench.view.extension.sidebar-host')));
      state.ready = true; save();
    } catch (error) { state.errors.push(String(error.stack || error)); save(); } };
    exports.deactivate = () => fs.unwatchFile(refreshMarker);
  `;
  new vm.Script(source);
  fs.writeFileSync(path.join(driver, 'driver.cjs'), source);
  const config = path.join(base, 'server.yaml');
  fs.writeFileSync(config, 'auth: none\n');
  const port = await freePort();
  const logPath = path.join(base, 'host.log');
  const log = fs.openSync(logPath, 'wx');
  const env = { ...process.env, HOME: path.join(base, 'home') };
  for (const key of Object.keys(env)) if (/^VSCODE_|^ELECTRON_|^SOLOMAP_|^PORT$/.test(key)) delete env[key];
  fs.mkdirSync(env.HOME);
  const server = childProcess.spawn('code-server', [
    '--bind-addr', `127.0.0.1:${port}`, '--auth', 'none', '--config', config,
    '--user-data-dir', path.join(base, 'profile'), '--extensions-dir', extensions,
    '--disable-telemetry', '--disable-update-check', '--disable-workspace-trust', workspace
  ], { env, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  let browser;
  try {
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { return false; } }, 'isolated code-server did not start');
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(15000);
    await page.goto(`http://127.0.0.1:${port}/?folder=${encodeURIComponent(workspace)}`);
    await page.waitForSelector('.monaco-workbench');
    await waitFor(() => {
      const current = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, 'utf8')) : {};
      if (current.errors?.length) throw new Error(current.errors.join('\n'));
      return current.ready;
    }, 'fixture extension did not activate');
    await page.keyboard.press('F1');
    await page.locator('.quick-input-widget input').fill('>Sidebar Host Fixture: Open');
    await page.getByRole('option').filter({ hasText: 'Sidebar Host Fixture: Open' }).first().waitFor();
    await page.keyboard.press('Enter');
    const frame = await waitFor(async () => {
      for (const candidate of page.frames()) if (await candidate.locator('[data-open-project-path]').count()) return candidate;
      return null;
    }, 'sidebar webview did not render');
    assert.equal(await frame.locator('.portfolio-card').count(), 1);
    const coreReady = await waitFor(() => JSON.parse(fs.readFileSync(receipt, 'utf8')).diagnostics.find(event => event.scope === 'sidebar.browser.core.ready'), 'the browser never confirmed complete local core data');
    assert.match(await frame.locator('[data-project-continue-step]').textContent(), /1.*Ship the fix/);
    await frame.locator('[data-project-conversation-mode="solo"]').click();
    assert.ok(await frame.locator('[data-conversation-expand-id="42"]').count(), 'the saved recent conversation must be rendered');
    assert.ok(coreReady.payload.elapsedMs <= 15000, 'cold core data must render within the local experience baseline');
    t.diagnostic(JSON.stringify({ coldCoreMs: Math.round(coreReady.payload.elapsedMs), completeLocalCore: true }));
    await frame.locator('#btn-toggle-settings').click();
    assert.equal(await frame.locator('#setting-global-prompt').inputValue(), '宿主保存的设置');
    await waitFor(async () => await frame.locator('#impact-tokens').textContent() === '123', 'project data card did not receive its actual database contribution');
    await waitFor(async () => await frame.locator('#database-overview-card [data-database-size]').textContent() !== '—', 'database overview did not render its actual storage metrics');
    assert.equal(await frame.locator('#impact-minutes').textContent(), '10');
    assert.equal(await frame.locator('#impact-files').textContent(), '1');
    assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).commands.filter(command => command === 'agentImpact.get').length, 1, 'hydration and optional enrichment must retain the opening contribution request');
    await frame.locator('#btn-close-settings').click();

    const roadmapButton = frame.locator('[data-open-project-path]');
    const box = await waitFor(async () => {
      if (!await roadmapButton.isVisible()) return null;
      try {
        await roadmapButton.scrollIntoViewIfNeeded({ timeout: 500 });
        return await roadmapButton.boundingBox({ timeout: 500 });
      } catch (error) {
        if (/not attached|Timeout/.test(error.message)) return null;
        throw error;
      }
    }, 'roadmap pointer target did not settle after closing settings');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const roadmapOpenedAt = performance.now();
    await page.mouse.down();
    fs.writeFileSync(refreshMarker, String(Date.now()));
    await waitFor(() => JSON.parse(fs.readFileSync(receipt, 'utf8')).refreshes > 0, 'host refresh did not reach the webview');
    await page.mouse.up();
    await waitFor(() => JSON.parse(fs.readFileSync(receipt, 'utf8')).roadmap, 'roadmap action was swallowed');
    await waitFor(async () => {
      for (const candidate of page.frames()) {
        if (await candidate.locator('[data-node-card-id="1"]').count()) return true;
      }
      return false;
    }, 'the roadmap opened without its saved local task');
    const roadmapCompleteMs = Math.round(performance.now() - roadmapOpenedAt);
    assert.ok(roadmapCompleteMs <= 20000, 'the roadmap must render its complete local nodes within twenty seconds');

    await frame.locator('[data-open-project-growth-path]').focus();
    await frame.locator('[data-open-project-growth-path]').press('Enter');
    await waitFor(() => JSON.parse(fs.readFileSync(receipt, 'utf8')).growth, 'growth action did not reach the host');

    await frame.locator('[data-project-conversation-mode="solo"]').click();
    await frame.locator('[data-conversation-expand-id="42"]').click();
    const continuedAt = performance.now();
    await frame.locator('[data-continue-id="42"]').click();
    await waitFor(() => fs.existsSync(nativeReceipt), 'native continuation did not reach the isolated CLI');
    const nativeLaunch = JSON.parse(fs.readFileSync(nativeReceipt, 'utf8').trim().split('\n')[0]);
    assert.equal(nativeLaunch.cwd, workspace);
    assert.ok(nativeLaunch.args.includes('--resume'));
    const nativeContinuationMs = Math.round(performance.now() - continuedAt);
    assert.ok(nativeContinuationMs <= 5000, 'continuation must actually execute its CLI within five seconds');
    t.diagnostic(JSON.stringify({ nativeContinuationMs, realTerminalDelivery: true, isolatedNativeCli: true }));
    await frame.locator('[data-toggle-delivery-panel]').click();
    const actionStartedAt = performance.now();
    await frame.locator('[data-agent-fix-delivery-project-path]').click();
    await waitFor(() => fs.readFileSync(nativeReceipt, 'utf8').trim().split('\n').length >= 2, 'Actions button did not launch its Agent');
    const actionLaunchMs = Math.round(performance.now() - actionStartedAt);
    assert.ok(actionLaunchMs <= 5000, 'Actions must execute its CLI within five seconds');
    await waitFor(async () => await frame.locator('[data-agent-fix-delivery-project-path]').isEnabled(), 'Actions button did not receive its completion acknowledgement');
    const issueData = { command: 'projectIssuesLoaded', projectPath: workspace,
      issues: { available: true, open: 1, items: [{ number: 13, title: 'Improve home', state: 'OPEN' }] } };
    await frame.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), issueData);
    await frame.locator('[data-toggle-issue-panel]').click();
    await frame.locator('[data-expand-issue-number="13"]').click();
    const issueStartedAt = performance.now();
    await frame.locator('[data-agent-fix-issue]').click();
    await waitFor(() => fs.readFileSync(nativeReceipt, 'utf8').trim().split('\n').length >= 3, 'Issue button did not launch its Agent');
    const issueLaunchMs = Math.round(performance.now() - issueStartedAt);
    assert.ok(issueLaunchMs <= 5000, 'Issues must execute its CLI within five seconds');
    await waitFor(async () => await frame.locator('[data-agent-fix-issue]').isEnabled(), 'Issue button did not receive its completion acknowledgement');
    const result = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    assert.equal(result.errors.length, 0);
    assert.ok(result.commands.includes('settings.get'));
    assert.ok(result.commands.includes('project.getAll'));
    assert.ok(result.commands.includes('uiState.load'));
    assert.ok(result.commands.includes('project.openRoadmap'));
    assert.ok(result.commands.includes('project.openGrowth'));
    assert.ok(result.commands.includes('conversation.continue'));
    assert.equal(result.commands.filter(command => command === 'conversation.runSolo').length, 2);
    t.diagnostic(JSON.stringify({ roadmapCompleteMs, actionLaunchMs, issueLaunchMs }));
    t.diagnostic(JSON.stringify({ realExtensionHost: true, productionBridge: true, settingsLoaded: true, projectDataLoaded: true, contributionRendered: true, databaseOverviewRendered: true, uiStateLoaded: true, refreshDuringPointerAction: true, roadmapOpened: true, growthOpened: true }));
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode !== null || server.signalCode) resolve(); else server.once('exit', resolve); });
  }
});
