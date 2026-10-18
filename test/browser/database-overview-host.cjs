const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { chromium } = require('playwright');
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
(async () => {
  const repo = path.resolve(__dirname, '../..');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-overview-host-'));
  const extensions = path.join(base, 'extensions'), driver = path.join(extensions, 'fixture.overview-1.0.0');
  const workspace = path.join(base, 'workspace'), receipt = path.join(base, 'receipt.json');
  fs.mkdirSync(driver, { recursive: true }); fs.mkdirSync(workspace);
  cp.execFileSync('git', ['init', '-q', workspace]);
  fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ name: 'overview', publisher: 'fixture', version: '1.0.0', engines: { vscode: '^1.106.0' }, main: './driver.cjs', activationEvents: ['onStartupFinished'],
    contributes: { commands: [{ command: 'overview.open', title: 'Overview Fixture: Open' }, { command: 'overview.fail', title: 'Overview Fixture: Fail' }, { command: 'overview.restore', title: 'Overview Fixture: Restore' }],
      viewsContainers: { activitybar: [{ id: 'overview-fixture', title: 'SoloMap', icon: 'icon.svg' }] }, views: { 'overview-fixture': [{ type: 'webview', id: 'solopreneur.sidebar', name: 'SoloMap' }] } } }));
  fs.writeFileSync(path.join(driver, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path fill="white" d="M4 4h16v16H4z"/></svg>');
  const source = `
    const vscode=require('vscode'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
    const repo=${JSON.stringify(repo)},base=${JSON.stringify(base)},receipt=${JSON.stringify(receipt)};
    let cleanup; const state={ready:false,fail:false,reads:0,reconnected:false};
    const save=()=>fs.writeFileSync(receipt,JSON.stringify(state));
    exports.activate=async context=>{try{
      const root=path.join(base,'.solomap-global');
      const store=new (require(path.join(repo,'out/db/unifiedDataStore.js')).UnifiedDataStore)(root);
      const ops=require(path.join(repo,'out/runtimeDataOperations.js')).createRuntimeDataOperations(store);
      require(path.join(repo,'out/autonomousRuntime.js')).claimRuntimeLease(root,{runtimeId:'overview-fixture',pid:process.pid});
      const server=await require(path.join(repo,'out/autonomousRuntimeControl.js')).startRuntimeControlServer({globalDataPath:root,runtimeId:'overview-fixture',entryPath:path.join(repo,'out/autonomousRuntimeProcess.js'),buildId:require(path.join(repo,'out/runtimeBuildIdentity.js')).runtimeBuildId(repo),onCommand:()=>({status:'running'}),onData:async request=>{
        if(request.operation==='read_database_overview'){
          state.reads++;save();
          if(state.reads===1){state.reconnected=true;save();throw new Error('runtime_data_response_incomplete');}
          if(state.fail)throw new Error('database_fixture_unavailable');
        }
        return ops(request);
      }});
      cleanup=async()=>{await server.close();await ops.close();store.close();};
      state.expectedRecords=store.readDatabaseOverview().contents.records;
      const settings={globalDataPath:root,language:'zh',cliPath:'agy',agentModelPreferences:{},automationTasks:{}};
      const filename=path.join(repo,'out/extension.js'),subject=new Module(filename,module);subject.filename=filename;subject.paths=Module._nodeModulePaths(path.dirname(filename));
      subject._compile(fs.readFileSync(filename,'utf8')+'\\nmodule.exports.action=handleSharedWebviewAction;module.exports.connect=(settings,provider)=>{getPersistedSettings=()=>settings;getProjects=()=>[];sidebarProvider=provider;};',filename);
      const Provider=require(path.join(repo,'out/sidebarProvider.js')).SolopreneurSidebarProvider;
      const provider=new Provider(vscode.Uri.file(repo),{getNodes:()=>[]},{getSettings:()=>settings,updateSettings:async()=>{},getProjects:()=>({projects:[],selectedProjectPath:''}),readAgentAccountStatuses:async()=>[],dispatchSharedAction:async(message,target)=>{
        if(message.command==='databaseOverview.get')return subject.exports.action({extensionPath:repo},message,'sidebar',target);
        if(['bootstrap.get','settings.get','getSettings'].includes(message.command)){await target.postMessage({command:'settingsLoaded',settings});return true;}
        return true;
      }});
      subject.exports.connect(settings,provider);
      context.subscriptions.push(vscode.window.registerWebviewViewProvider('solopreneur.sidebar',provider));
      context.subscriptions.push(vscode.commands.registerCommand('overview.open',()=>vscode.commands.executeCommand('workbench.view.extension.overview-fixture')));
      context.subscriptions.push(vscode.commands.registerCommand('overview.fail',()=>{state.fail=true;save();}));
      context.subscriptions.push(vscode.commands.registerCommand('overview.restore',()=>{state.fail=false;save();}));
      state.ready=true;save();
    }catch(error){state.error=error.stack;save();}};
    exports.deactivate=async()=>{if(cleanup)await cleanup();};
  `;
  new vm.Script(source); fs.writeFileSync(path.join(driver, 'driver.cjs'), source);
  const html = require('../../out/sidebarWebview.js').getSidebarWebviewHtml({ asWebviewUri: () => '', cspSource: '' }, { fsPath: repo });
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  const config = path.join(base, 'server.yaml'); fs.writeFileSync(config, 'auth: none\n');
  const env = { ...process.env, HOME: path.join(base, 'home'), SOLOMAP_GLOBAL_DATA_PATH: path.join(base, '.solomap-global'), CODEX_HOME: path.join(base, 'codex') };
  for (const key of Object.keys(env)) if (/^VSCODE_|^ELECTRON_|^SOLOMAP_(PROJECT_ID|EXECUTION_LOG_ID|RUN_|TASK_)|^PORT$/.test(key)) delete env[key];
  fs.mkdirSync(env.HOME);
  const port = await freePort(), log = fs.openSync(path.join(base, 'host.log'), 'wx');
  const server = cp.spawn('code-server', ['--bind-addr', `127.0.0.1:${port}`, '--auth', 'none', '--config', config, '--user-data-dir', path.join(base, 'profile'), '--extensions-dir', extensions, '--disable-telemetry', '--disable-update-check', '--disable-workspace-trust', workspace], { env, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  let browser;
  try {
    const wait = async check => { for (let i = 0; !await check(); i++) { assert.ok(i < 300, 'isolated host readiness'); await new Promise(resolve => setTimeout(resolve, 100)); } };
    await wait(async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { return false; } });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
    await page.goto(`http://127.0.0.1:${port}/?folder=${encodeURIComponent(workspace)}`);
    await page.waitForSelector('.monaco-workbench');
    await wait(() => { const s = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt)) : {}; if (s.error) throw new Error(s.error); return s.ready; });
    const command = async title => { await page.keyboard.press('F1'); await page.locator('.quick-input-widget input').fill('>' + title); await page.getByRole('option').filter({ hasText: title }).first().waitFor(); await page.keyboard.press('Enter'); };
    await command('Overview Fixture: Open');
    let frame;
    await wait(async () => { for (const candidate of page.frames()) if (await candidate.locator('#database-overview-card').count()) { frame = candidate; return true; } return false; });
    await frame.locator('#btn-toggle-settings').click();
    const status = frame.locator('[data-database-overview-status]');
    await status.getByText('运行正常', { exact: true }).waitFor();
    assert.equal(await frame.locator('[data-database-records]').innerText(), String(JSON.parse(fs.readFileSync(receipt)).expectedRecords));
    assert.equal(JSON.parse(fs.readFileSync(receipt)).reconnected, true);
    await command('Overview Fixture: Fail'); await frame.locator('[data-database-overview-refresh]').click();
    await status.getByText('暂时无法读取数据库概览，请重试。', { exact: true }).waitFor();
    assert.notEqual(await frame.locator('[data-database-size]').innerText(), '—');
    assert.equal(await frame.locator('[data-database-overview-refresh]').isEnabled(), true);
    await command('Overview Fixture: Restore'); await frame.locator('[data-database-overview-refresh]').click();
    await status.getByText('运行正常', { exact: true }).waitFor();
    assert.equal(await frame.locator('#database-overview-card').getAttribute('aria-busy'), 'false');
    console.log(JSON.stringify({ realExtensionHost: true, generatedScriptsParse: true, automaticReconnect: true, failedReadRetainsMetrics: true, refreshRecovers: true, base }));
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    if (server.exitCode === null && server.signalCode === null) await onceExit(server);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
function onceExit(child) { return new Promise(resolve => child.once('exit', resolve)); }
