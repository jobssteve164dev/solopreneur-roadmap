const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

function callableProxy() {
  const value = () => undefined;
  return new Proxy(value, { get: () => callableProxy(), apply: () => undefined, construct: () => ({}) });
}

test('Webview delivery coalesces background state while foreground receipts bypass it', async () => {
  const { postWebviewMessage } = require('../out/panelMessages.js');
  const calls = [];
  let releaseBackground;
  const blockedBackground = new Promise(resolve => { releaseBackground = resolve; });
  const target = {
    postMessage(message) {
      calls.push(structuredClone(message));
      return message.command === 'projectIssuesLoaded' && calls.filter(call => call.command === 'projectIssuesLoaded').length === 1
        ? blockedBackground
        : Promise.resolve(true);
    }
  };

  const first = postWebviewMessage(target, { command: 'projectIssuesLoaded', projectPath: '/project/a', revision: 1 });
  await new Promise(resolve => setImmediate(resolve));
  const second = postWebviewMessage(target, { command: 'projectIssuesLoaded', projectPath: '/project/a', revision: 2 });
  const third = postWebviewMessage(target, { command: 'projectIssuesLoaded', projectPath: '/project/a', revision: 3 });
  await postWebviewMessage(target, { command: 'conversationActionAccepted', launchActionId: 'launch-1' });

  assert.deepEqual(calls.map(call => [call.command, call.revision]), [
    ['projectIssuesLoaded', 1],
    ['conversationActionAccepted', null]
  ], 'an unresolved background delivery must neither accumulate stale updates nor hold a foreground receipt');
  assert.equal(calls[0].protocolVersion, 1);
  assert.equal(calls[0].lane, 'background');
  assert.equal(calls[0].supersedesKey, 'projectIssuesLoaded:/project/a');
  assert.equal(calls[1].lane, 'foreground');
  assert.ok(calls[1].messageId);

  releaseBackground(true);
  await Promise.all([first, second, third]);
  assert.equal(calls.at(-1).command, 'projectIssuesLoaded');
  assert.equal(calls.at(-1).revision, 3);
  assert.equal(calls.filter(call => call.command === 'projectIssuesLoaded').length, 2);
});

test('Webview background delivery has bounded keys while foreground receipts remain lossless', async () => {
  const { postWebviewMessage } = require('../out/panelMessages.js');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const calls = [];
  const target = { postMessage: message => {
    calls.push(message);
    return calls.length === 1 ? held : Promise.resolve(true);
  } };
  const deliveries = [postWebviewMessage(target, { command: 'projectIssuesLoaded', projectPath: '/held' })];
  await new Promise(resolve => setImmediate(resolve));
  for (let index = 0; index < 200; index += 1) {
    deliveries.push(postWebviewMessage(target, { command: 'projectIssuesLoaded', projectPath: `/project/${index}` }));
  }
  await postWebviewMessage(target, { command: 'conversationActionAccepted', launchActionId: 'foreground' });
  release(true);
  const results = await Promise.all(deliveries);
  assert.ok(results.filter(Boolean).length <= 129, 'one active plus at most 128 queued keys may be delivered');
  assert.equal(calls.find(message => message.command === 'conversationActionAccepted')?.lane, 'foreground');
});

test('Runtime operations use an exhaustive explicit execution-domain registry', () => {
  const {
    runtimeOperationDefinition,
    assertRuntimeOperationRegistryComplete
  } = require('../out/runtimeOperationRegistry.js');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtimeDataOperations.ts'), 'utf8');
  const implemented = [...source.matchAll(/case '([^']+)'/g)].map(match => match[1]);
  implemented.push('checkpoint_current_run', 'get_conversation', 'set_intelligence_time_schedule', 'start_conversation');
  assert.doesNotThrow(() => assertRuntimeOperationRegistryComplete(implemented));
  assert.equal(runtimeOperationDefinition('start_conversation').domain, 'foreground-command');
  assert.equal(runtimeOperationDefinition('read_run_execution_plan').domain, 'interactive-query');
  assert.equal(runtimeOperationDefinition('read_database_overview').domain, 'background-query');
  assert.equal(runtimeOperationDefinition('read_registered_report_sources').domain, 'foreground-command', 'a read that performs legacy backfill is a write-domain operation');
  assert.equal(runtimeOperationDefinition('backup').domain, 'maintenance');
  assert.equal(runtimeOperationDefinition('backup').executor, 'maintenance-worker');
  assert.equal(runtimeOperationDefinition('project_signals').executor, 'external-worker');
  assert.equal(runtimeOperationDefinition('read_intelligence_execution_mode').executor, 'supervisor');
  assert.equal(runtimeOperationDefinition('search').replay, 'safe');
  assert.throws(() => runtimeOperationDefinition('read_whatever_someone_adds_later'), /runtime_operation_unregistered/);
});

test('Runtime data transport multiplexes concurrent requests over one authenticated connection', async () => {
  const net = require('node:net');
  const control = require('../out/autonomousRuntimeControl.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-multiplex-'));
  const originalCreateConnection = net.createConnection;
  let connections = 0;
  net.createConnection = function(...args) {
    connections += 1;
    return originalCreateConnection.apply(this, args);
  };
  const server = await control.startRuntimeControlServer({
    globalDataPath: root,
    runtimeId: 'multiplex-runtime',
    onCommand: () => ({ status: 'running' }),
    onData: async request => {
      if (request.input.delay) await new Promise(resolve => setTimeout(resolve, Number(request.input.delay)));
      return request.input.value;
    }
  });
  try {
    const results = await Promise.all([
      control.sendRuntimeDataRequest(root, { operation: 'fixture_slow', input: { value: 'slow', delay: 20 } }),
      control.sendRuntimeDataRequest(root, { operation: 'fixture_fast', input: { value: 'fast' } })
    ]);
    assert.deepEqual(results, ['slow', 'fast']);
    assert.equal(connections, 1);
  } finally {
    net.createConnection = originalCreateConnection;
    await server.close();
  }
});

test('Runtime data transport keeps a one-shot child alive until its response arrives', async () => {
  const { promisify } = require('node:util');
  const { execFile } = require('node:child_process');
  const control = require('../out/autonomousRuntimeControl.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-one-shot-'));
  const server = await control.startRuntimeControlServer({
    globalDataPath: root,
    runtimeId: 'one-shot-runtime',
    onCommand: () => ({ status: 'running' }),
    onData: async request => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return request.input.value;
    }
  });
  try {
    const script = `const control=require(${JSON.stringify(path.join(projectRoot, 'out', 'autonomousRuntimeControl.js'))}); control.sendRuntimeDataRequest(${JSON.stringify(root)}, {operation:'fixture_child',input:{value:'child-response'}}).then(value=>process.stdout.write(JSON.stringify(value)));`;
    const result = await promisify(execFile)(process.execPath, ['-e', script]);
    assert.equal(result.stdout, '"child-response"');
  } finally {
    await server.close();
  }
});

test('Runtime data transport replays only reads and explicitly idempotent writes after an ambiguous disconnect', async t => {
  const net = require('node:net');
  const control = require('../out/autonomousRuntimeControl.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-replay-'));
  const root = path.join(base, '.solomap-global');
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  const attempts = new Map();
  const server = net.createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const frame = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        const key = `${frame.request.operation}:${frame.request.input.idempotencyKey || ''}`;
        const attempt = (attempts.get(key) || 0) + 1;
        attempts.set(key, attempt);
        if (attempt === 1) { socket.end(); return; }
        socket.write(JSON.stringify({ requestId: frame.requestId, ok: true, runtimeId: 'replay-runtime', result: { attempt } }) + '\n');
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  fs.writeFileSync(path.join(root, 'runtime', 'control.json'), JSON.stringify({
    schemaVersion: 1, runtimeId: 'replay-runtime', host: '127.0.0.1', port: address.port, token: 'fixture-token'
  }));

  assert.deepEqual(await control.sendRuntimeDataRequest(root, { operation: 'search', input: { query: 'safe read' } }), { attempt: 2 });
  assert.deepEqual(await control.sendRuntimeDataRequest(root, { operation: 'write', input: { idempotencyKey: 'safe-write' } }), { attempt: 2 });
  await assert.rejects(
    control.sendRuntimeDataRequest(root, { operation: 'retry_migration', input: { jobId: 'unsafe-write' } }),
    /runtime_data_response_incomplete/
  );
  assert.equal(attempts.get('retry_migration:'), 1);
});

test('Runtime control shutdown drains accepted persistent work and then closes its socket', async () => {
  const control = require('../out/autonomousRuntimeControl.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-drain-'));
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const server = await control.startRuntimeControlServer({
    globalDataPath: root,
    runtimeId: 'drain-runtime',
    onCommand: () => ({ status: 'running' }),
    onData: async request => { await held; return request.input.value; }
  });
  const response = control.sendRuntimeDataRequest(root, { operation: 'fixture_drain', input: { value: 'completed' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  const closing = server.close();
  await new Promise(resolve => setTimeout(resolve, 150));
  release();
  assert.equal(await response, 'completed');
  await Promise.race([
    closing,
    new Promise((_, reject) => setTimeout(() => reject(new Error('runtime_control_close_timeout')), 1_000))
  ]);
});

test('Runtime control drains accepted work even when its client disconnects before the result', async () => {
  const net = require('node:net');
  const control = require('../out/autonomousRuntimeControl.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-disconnect-drain-'));
  const root = path.join(base, '.solomap-global');
  let release;
  let accepted;
  const held = new Promise(resolve => { release = resolve; });
  const acceptedPromise = new Promise(resolve => { accepted = resolve; });
  const server = await control.startRuntimeControlServer({
    globalDataPath: root,
    runtimeId: 'disconnect-drain-runtime',
    onCommand: () => ({ status: 'running' }),
    onData: async () => { accepted(); await held; return 'done'; }
  });
  const endpoint = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'control.json'), 'utf8'));
  const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(JSON.stringify({ token: endpoint.token, command: 'data', expectedRuntimeId: endpoint.runtimeId, requestId: 'lost-client', request: { operation: 'fixture', input: {} } }) + '\n');
  await acceptedPromise;
  socket.destroy();
  const closing = server.close();
  let closed = false;
  void closing.then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(closed, false);
  release();
  await closing;
});

test('Runtime readers open SQLite without acquiring write authority', () => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-read-domain-'));
  const writer = new UnifiedDataStore(root);
  const databaseId = writer.databaseId;
  writer.close();
  const reader = UnifiedDataStore.openReadOnly(root, databaseId);
  assert.equal(reader.databaseId, databaseId);
  assert.ok(reader.readDatabaseOverview().databaseBytes > 0);
  assert.throws(() => reader.appendDiagnosticEvent({
    kind: 'operation', occurredAt: new Date().toISOString(), scope: 'test', payload: {}, idempotencyKey: 'reader-write'
  }), /read-only|readonly|query_only/i);
  reader.close();
});

test('Runtime supervisor routes interactive and background reads to distinct SQLite workers', async () => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-domain-workers-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-domain-project-'));
  const writerStore = new UnifiedDataStore(root);
  await writerStore.registerProject({ root: project });
  let writerCalls = 0;
  const domains = await RuntimeDataExecutionDomains.start({
    root,
    databaseId: writerStore.databaseId,
    writer: async () => { writerCalls += 1; throw new Error('read_reached_writer'); }
  });
  try {
    const topology = domains.topology();
    assert.ok(topology.interactiveQuery.threadId > 0);
    assert.ok(topology.backgroundQuery.threadId > 0);
    assert.ok(topology.externalJob.threadId > 0);
    assert.ok(topology.maintenance.threadId > 0);
    assert.notEqual(topology.interactiveQuery.threadId, topology.backgroundQuery.threadId);
    const [registry, overview, growth, analysis] = await Promise.all([
      domains.dispatch({ operation: 'read_project_registry', input: {} }),
      domains.dispatch({ operation: 'read_database_overview', input: {} }),
      domains.dispatch({ operation: 'read_project_growth', input: { root: project } }),
      domains.dispatch({ operation: 'read_analysis_state', input: { root: project, namespace: 'test', key: 'empty' } })
    ]);
    assert.equal(registry, null);
    assert.ok(overview.databaseBytes > 0);
    assert.deepEqual(growth, { latest: null, history: [] });
    assert.deepEqual(analysis, { objectId: null, revision: 0, value: null });
    assert.equal(writerCalls, 0);
    const mode = await RuntimeDataExecutionDomains.start({
      root,
      databaseId: writerStore.databaseId,
      writer: async () => { throw new Error('writer'); },
      supervisor: async request => request.operation === 'read_intelligence_execution_mode' ? { mode: 'harness' } : null
    });
    try {
      assert.deepEqual(await mode.dispatch({ operation: 'read_intelligence_execution_mode', input: {} }), { mode: 'harness' });
    } finally { await mode.close(); }
  } finally {
    await domains.close();
    writerStore.close();
  }
});

test('Daily review is loaded by invalidation or user action, never by an idle polling loop', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidebarWebview.ts'), 'utf8');
  assert.doesNotMatch(source, /function startDailyReviewPolling\s*\(/);
  assert.doesNotMatch(source, /dailyReviewPollTimer/);
  assert.match(source, /vscode\.postMessage\(\{ command: 'getDailyReview' \}\)/, 'initial visible state still loads once');
});

test('Sidebar core projection leaves the Extension Host and returns one portfolio snapshot', async () => {
  const { buildSidebarCoreProjection } = require('../out/sidebarCoreProjection.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-core-projection-'));
  const projects = ['a', 'b', 'c'].map(name => {
    const projectPath = path.join(root, name);
    fs.mkdirSync(projectPath, { recursive: true });
    return { name: name.toUpperCase(), path: projectPath };
  });
  const result = await buildSidebarCoreProjection(projects);
  assert.equal(result.portfolio.length, 3);
  assert.ok(result.workerThreadId > 0);
  assert.notEqual(result.workerThreadId, require('node:worker_threads').threadId);
  assert.deepEqual(result.portfolio.map(project => project.name), ['A', 'B', 'C']);
});

test('Conversation launch coordinator starts terminal and Runtime preparation concurrently', async () => {
  const { coordinateConversationLaunch } = require('../out/conversationLaunchCoordinator.js');
  const started = [];
  let releaseTerminal;
  let releaseRuntime;
  const terminalGate = new Promise(resolve => { releaseTerminal = resolve; });
  const runtimeGate = new Promise(resolve => { releaseRuntime = resolve; });
  const launch = coordinateConversationLaunch({
    captureSnapshot: () => ({ project: '/visible' }),
    openTerminal: async () => { started.push('terminal'); await terminalGate; return { id: 'terminal' }; },
    prepareRuntime: async () => { started.push('runtime'); await runtimeGate; return { id: 'target' }; },
    execute: async ({ terminal, target }) => `${terminal.id}:${target.id}`,
    releaseTerminal: () => started.push('release-terminal'),
    releaseTarget: () => started.push('release-target')
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['terminal', 'runtime']);
  releaseTerminal();
  releaseRuntime();
  assert.equal(await launch, 'terminal:target');
  assert.deepEqual(started.slice(-2), ['release-target', 'release-terminal']);
});

test('Sidebar startup restores only the selected cached conversation and leaves background projects demand-driven', async () => {
  const cachePath = require.resolve('../out/sidebarSnapshotCache.js');
  const providerPath = require.resolve('../out/sidebarProvider.js');
  const cache = require(cachePath);
  const originalRead = cache.readCachedConversationSnapshot;
  const originalLoad = Module._load;
  const reads = [];
  cache.readCachedConversationSnapshot = async (_root, projectPath) => {
    reads.push(projectPath);
    return { solo: [], project: [], flow: [], revision: [] };
  };
  Module._load = function(request, parent, isMain) {
    if (request === 'vscode') return callableProxy();
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[providerPath];
  try {
    const { SolopreneurSidebarProvider } = require(providerPath);
    const projects = ['/project/a', '/project/b', '/project/c'].map((projectPath, index) => ({
      path: projectPath,
      name: `Project ${index + 1}`
    }));
    const posted = [];
    const provider = new SolopreneurSidebarProvider({ fsPath: projectRoot }, { getNodes: () => [] }, {
      getSettings: () => ({ globalDataPath: '/data/root' }),
      updateSettings: async () => {},
      getProjects: () => ({ projects, selectedProjectPath: projects[0].path, projectGeneration: 1 }),
      readAgentAccountStatuses: async () => []
    });
    provider._view = { webview: { postMessage: async message => { posted.push(message); return true; } } };
    provider._latestPortfolio = projects.map(project => ({ ...project, overallStatus: 'Pending' }));
    provider._projectLoader.scheduleExternalSignals = () => {};
    provider.scheduleCorePortfolio = () => {};
    provider.sendDailyReview = () => {};

    await provider.sendProjects();
    for (let turn = 0; turn < 10; turn += 1) await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(reads, [projects[0].path]);
    assert.ok(posted.some(message => message.command === 'sidebarProjectConversationSnapshotLoaded'));
  } finally {
    cache.readCachedConversationSnapshot = originalRead;
    Module._load = originalLoad;
    delete require.cache[providerPath];
  }
});

test('Solo send leaves the Webview before any portfolio rebuild can run', async t => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { t.skip('Playwright is unavailable in this host.'); return; }

  const webview = { asWebviewUri: () => '', cspSource: '' };
  const html = require('../out/sidebarWebview.js').getSidebarWebviewHtml(webview, { fsPath: projectRoot });
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error && error.message || error)));
    await page.route('**/*', route => route.abort());
    await page.evaluate(() => {
      window.__posted = [];
      window.acquireVsCodeApi = () => ({
        postMessage(message) { window.__posted.push(structuredClone(message)); },
        getState() { return {}; },
        setState() {}
      });
    });
    await page.setContent(html);
    const send = message => page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), message);
    const project = { path: '/fixture/current', name: 'Current project' };
    await send({ command: 'settingsLoaded', settings: { language: 'zh', cliPath: 'codex', agentModelPreferences: {} } });
    await send({
      command: 'projectsLoaded',
      projects: {
        projects: [project],
        selectedProjectPath: project.path,
        projectGeneration: 1,
        portfolio: [{ ...project, overallStatus: 'In Progress', globalPriority: 'P1' }]
      }
    });
    await page.locator('[data-project-conversation-mode="solo"]').click();
    await page.locator('[data-project-conversation-input]').fill('从用户动作直接启动');
    await page.evaluate(() => {
      window.__posted = [];
      const portfolio = document.getElementById('portfolio-list');
      const original = portfolio.querySelectorAll.bind(portfolio);
      portfolio.querySelectorAll = selector => {
        if (selector === '[data-select-project-path]') throw new Error('foreground_launch_rebuilt_portfolio');
        return original(selector);
      };
    });

    await page.locator('[data-project-continue-send]').click();
    await page.waitForTimeout(25);

    const launches = await page.evaluate(() => window.__posted.filter(message => message.command === 'conversation.runSolo'));
    assert.equal(launches.length, 1);
    assert.equal(launches[0].projectPath, project.path);
    assert.equal(launches[0].userMessage, '从用户动作直接启动');
    assert.deepEqual(pageErrors, [], 'foreground send must not enter the portfolio renderer');
  } finally {
    await browser.close();
  }
});
