const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const Module = require('node:module');
const { openAnalysisOwner } = require('./analysis-fixture.js');
const { SyncEngine } = require('../out/db/syncEngine.js');

function cleanupExact(root) {
  if (!fs.existsSync(root)) return;
  const directories = [root], files = [];
  const inventory = directory => {
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name), stat = fs.lstatSync(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) { directories.push(target); inventory(target); }
      else files.push(target);
    }
  };
  inventory(root);
  files.forEach(file => fs.unlinkSync(file));
  directories.sort((left, right) => right.length - left.length).forEach(directory => fs.rmdirSync(directory));
}

function compiledFunction(name, next) {
  const compiled = fs.readFileSync(path.resolve(__dirname, '../out/extension.js'), 'utf8');
  const start = compiled.indexOf(`async function ${name}(`), end = compiled.indexOf(next, start);
  assert.ok(start > 0 && end > start, name);
  return compiled.slice(start, end);
}

async function roots(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-data-root-actions-'));
  const project = path.join(base, 'project'), a = path.join(base, 'a', '.solomap-global'), b = path.join(base, 'b', '.solomap-global');
  fs.mkdirSync(path.join(project, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(project, '.solopreneur', 'roadmap.csv'), 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,Keep roadmap,,Stage,,claude,,Pending,,');
  const closers = [], beforeClose = [], engines = new Set(), ownerContext = { after: close => closers.push(close) };
  t.after(async () => {
    try { for (const close of beforeClose) await close(); for (const engine of engines) { await engine.historyLoad; engine.close(); } for (const close of closers.reverse()) await close(); }
    finally { cleanupExact(base); }
  });
  return { base, project, a, b, engines, beforeClose, ownerA: await openAnalysisOwner(ownerContext, a, [{ path: project }]), ownerB: await openAnalysisOwner(ownerContext, b, [{ path: project }]) };
}

function ensureRollbackGitFixture(project) {
  const childProcess = require('node:child_process');
  childProcess.execFileSync('git', ['init', '--quiet', project]);
  childProcess.execFileSync('git', ['-C', project, 'config', 'user.email', 'fixture@example.invalid']);
  childProcess.execFileSync('git', ['-C', project, 'config', 'user.name', 'SoloMap Fixture']);
  childProcess.execFileSync('git', ['-C', project, 'add', '-A']);
  childProcess.execFileSync('git', ['-C', project, 'commit', '--quiet', '-m', 'fixture baseline']);
}

function engineHost(t, f, Engine = SyncEngine) {
  class OwnedEngine extends Engine { constructor(...args) { super(...args); f.engines.add(this); } }
  const scope = { fs, path, console, setTimeout: () => {}, syncEngine: null, activeProjectRoot: '', syncEngineReady: false,
    syncEngineInitPromise: null, syncEngineInitProjectRoot: '', syncEngineInitDataRoot: '', syncEngineInitGeneration: 0,
    projectSelectionGeneration: 0, sidebarProvider: null, projectRegistryFileName: 'projects.json', root: f.a, project: f.project,
    getSelectedProjectPath: () => f.project, getPersistedSettings: () => ({ globalDataPath: scope.root }),
    normalizeGlobalDataPathForExtension: root => root,
    autonomousRuntimeHost_1: { ensureHealthyAutonomousRuntime: async ({ globalDataPath }) => { scope.runtimeReadyRoot = globalDataPath; } },
    projectRegistry_1: { readProjectRegistry: () => ({ projects: [{ path: f.project }], selectedProjectPath: f.project }) },
    syncEngine_1: { SyncEngine: OwnedEngine }, sendNodesToWebview() {}, setupFileSentinelWatcher() {},
    postRoadmapLoadFailed: (_project, error) => assert.fail(String(error)), formatLocalDataError: String,
    vscode: { window: { showErrorMessage: message => assert.fail(message) } }
  };
  vm.runInNewContext(compiledFunction('ensureSyncEngine', 'async function openRoadmapPanel('), scope);
  return scope;
}

test('changing the data root routes the real action engine to the new journal', async t => {
  const f = await roots(t), scope = engineHost(t, f), context = { extensionPath: path.resolve(__dirname, '..') };
  assert.equal(await scope.ensureSyncEngine(context), true);
  const previous = scope.syncEngine;
  await previous.logAgentExecution('__solo__', 'claude', 'A', 'source A', 'Completed');
  scope.root = f.b; assert.equal(await scope.ensureSyncEngine(context), true);
  await scope.syncEngine.logAgentExecution('__solo__', 'claude', 'B', 'source B', 'Completed');
  const a = f.ownerA.store.readProjectJournal(f.ownerA.projectIds.get(f.project));
  const b = f.ownerB.store.readProjectJournal(f.ownerB.projectIds.get(f.project));
  assert.deepEqual(a.logs.map(log => log.output), ['source A']);
  assert.deepEqual(b.logs.map(log => log.output), ['source B']);
  assert.notEqual(scope.syncEngine, previous);
  assert.equal(scope.runtimeReadyRoot, f.b);
});

test('a default roadmap does not direct the Agent to retired project support files', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-default-roadmap-'));
  t.after(() => cleanupExact(base));
  const csv = path.join(base, '.solopreneur', 'roadmap.csv');
  const db = path.join(base, '.solopreneur', 'project_journal.db');
  fs.mkdirSync(path.dirname(csv), { recursive: true });
  const engine = new SyncEngine(csv, db, path.resolve(__dirname, '..'));
  t.after(() => engine.close());
  await engine.initAndSync();
  const prompt = engine.getNodes()[0].agentPrompt;
  assert.doesNotMatch(prompt, /bootstrap-roadmap-instructions\.md|roadmap-methodology\.md/);
  assert.match(prompt, /共享路线图校验器/);
});

test('a late roadmap refresh cannot overwrite a newer revision, including from revision zero', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-roadmap-refresh-order-'));
  t.after(() => cleanupExact(base));
  const csv = path.join(base, '.solopreneur', 'roadmap.csv');
  fs.mkdirSync(path.dirname(csv), { recursive: true });
  fs.writeFileSync(csv, 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,Initial,,Stage,,codex,,Pending,,');
  const engine = new SyncEngine(csv, path.join(base, '.solopreneur', 'project_journal.db'), path.resolve(__dirname, '..'), path.join(base, '.solomap-global'));
  t.after(() => engine.close());
  let releaseFirst;
  const firstSnapshot = new Promise(resolve => { releaseFirst = resolve; });
  let calls = 0;
  engine.readOrAcceptRoadmap = () => ++calls === 1
    ? firstSnapshot
    : Promise.resolve({ nodes: [{ id: 'new', title: 'New snapshot' }], revision: 2 });
  const first = engine.refreshNodes();
  await engine.refreshNodes();
  assert.equal(engine.getNodes()[0].title, 'New snapshot');
  releaseFirst({ nodes: [{ id: 'old', title: 'Old snapshot' }], revision: 1 });
  await first;
  assert.equal(engine.getNodes()[0].title, 'New snapshot');
});

test('a roadmap mutation invalidates an older refresh before it can overwrite the committed state', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-roadmap-refresh-write-order-'));
  t.after(() => cleanupExact(base));
  const csv = path.join(base, '.solopreneur', 'roadmap.csv');
  fs.mkdirSync(path.dirname(csv), { recursive: true });
  fs.writeFileSync(csv, 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,Initial,,Stage,,codex,,Pending,,');
  const engine = new SyncEngine(csv, path.join(base, '.solopreneur', 'project_journal.db'), path.resolve(__dirname, '..'), path.join(base, '.solomap-global'));
  t.after(() => engine.close());
  let releaseRefresh;
  engine.readOrAcceptRoadmap = () => new Promise(resolve => { releaseRefresh = resolve; });
  engine.roadmapRevision = 1;
  const refresh = engine.refreshNodes();
  engine.enqueueRoadmapMutation = async change => {
    engine.nodeCache = change([{ id: '1', title: 'Initial', status: 'Pending' }]);
    engine.roadmapRevision = 2;
  };
  await engine.updateNode('1', { status: 'Completed' });
  releaseRefresh({ nodes: [{ id: '1', title: 'Initial', status: 'Pending' }], revision: 1 });
  await refresh;
  assert.equal(engine.getNodes()[0].status, 'Completed');
  assert.equal(engine.roadmapRevision, 2);
});

test('a superseded roadmap refresh cannot surface its stale conflict after a local mutation', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-roadmap-refresh-error-order-'));
  t.after(() => cleanupExact(base));
  const csv = path.join(base, '.solopreneur', 'roadmap.csv');
  fs.mkdirSync(path.dirname(csv), { recursive: true });
  fs.writeFileSync(csv, 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,Initial,,Stage,,codex,,Pending,,');
  const engine = new SyncEngine(csv, path.join(base, '.solopreneur', 'project_journal.db'), path.resolve(__dirname, '..'), path.join(base, '.solomap-global'));
  t.after(() => engine.close());
  let rejectRefresh;
  engine.readOrAcceptRoadmap = () => new Promise((_resolve, reject) => { rejectRefresh = reject; });
  engine.roadmapRevision = 1;
  const refresh = engine.refreshNodes();
  engine.enqueueRoadmapMutation = async change => {
    engine.nodeCache = change([{ id: '1', title: 'Initial', status: 'Pending' }]);
    engine.roadmapRevision = 2;
  };
  await engine.updateNode('1', { status: 'Completed' });
  rejectRefresh(new Error('roadmap_projection_conflict'));
  await assert.doesNotReject(refresh);
  assert.equal(engine.getNodes()[0].status, 'Completed');
});

test('a late initialization from the previous root cannot replace the newer engine', async t => {
  const f = await roots(t); let releaseA, beganA;
  const startedA = new Promise(resolve => { beganA = resolve; }), gateA = new Promise(resolve => { releaseA = resolve; });
  class DelayedEngine extends SyncEngine {
    constructor(...args) { super(...args); this.testRoot = args[3]; }
    async initAndSync(options) { await super.initAndSync(options); if (this.testRoot === f.a) { beganA(); await gateA; } }
  }
  const scope = engineHost(t, f, DelayedEngine), context = { extensionPath: path.resolve(__dirname, '..') };
  const oldInitialization = scope.ensureSyncEngine(context); await startedA;
  scope.root = f.b;
  const currentInitialization = scope.ensureSyncEngine(context);
  // Let both complete; the late A result must not become the selected action dependency.
  releaseA(); await Promise.all([oldInitialization, currentInitialization]);
  await scope.syncEngine.logAgentExecution('__solo__', 'claude', 'B', 'after root switch', 'Completed');
  assert.deepEqual(f.ownerA.store.readProjectJournal(f.ownerA.projectIds.get(f.project)).logs, []);
  assert.deepEqual(f.ownerB.store.readProjectJournal(f.ownerB.projectIds.get(f.project)).logs.map(log => log.output), ['after root switch']);
});

function extensionHost(t, f, options = {}) {
  const extension = path.resolve(__dirname, '../out/extension.js');
  const source = fs.readFileSync(process.env.SOLOMAP_TEST_EXTENSION_FILE || extension, 'utf8'), localRequire = Module.createRequire(extension);
  const messages = [], deliveries = [], failures = [], dataRequests = [], globalStateValues = options.globalStateValues || new Map();
  const transport = localRequire('./autonomousRuntimeControl');
  const hostRequire = id => id === './agentCli' ? { ...localRequire(id), ensureAgentTaskAutomation: () => ({ ok: true }) } : id === './autonomousRuntimeControl' ? { ...transport, sendRuntimeDataRequest: async (root, request) => {
    dataRequests.push({ root, operation: request.operation, input: request.input });
    if (scope.requestHook) await scope.requestHook(root, request);
    if (scope.requestHandler && !['read_host_settings', 'patch_host_settings'].includes(request.operation)) return scope.requestHandler(root, request);
    return transport.sendRuntimeDataRequest(root, request);
  } } : id === './autonomousRuntimeHost' && options.stubRuntimeHealth ? { ...localRequire(id), ensureHealthyAutonomousRuntime: async input => {
    scope.runtimeHealthCalls.push(input.globalDataPath);
    if (scope.runtimeHealthHandler) return scope.runtimeHealthHandler(input);
    return {};
  } } : localRequire(id);
  const vscode = { ConfigurationTarget: { Global: 1 }, TerminalExitReason: { Shutdown: 4 }, ThemeIcon: class {}, ThemeColor: class {}, Uri: { joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts) }) }, workspace: { workspaceFolders: [{ uri: { fsPath: f.project } }],
      getConfiguration: () => ({ get: key => scope.settings[key], update: async () => {} }) },
    window: { terminals: [], showErrorMessage: message => failures.push(message), showWarningMessage: message => failures.push(message), showInformationMessage() {}, showInputBox: async () => '继续原任务' }
  };
  const scope = { require: hostRequire, exports: {}, __dirname: path.dirname(extension), process, console,
    Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    settings: { globalDataPath: f.a, cliPath: 'claude', globalPrompt: '来源库规则', enabledEnhancements: {}, taskPermissionMode: 'auto' },
    project: f.project, deliveries, failures, messages, dataRequests, runtimeHealthCalls: [], runtimeHealthHandler: null,
    context: { extensionPath: path.resolve(__dirname, '..'), extensionUri: { fsPath: path.resolve(__dirname, '..') }, subscriptions: [], globalState: { get: key => globalStateValues.get(key), keys: () => [...globalStateValues.keys()], update: async (key, value) => {
      if (options.globalStateUpdate) return options.globalStateUpdate(globalStateValues, key, value);
      if (value === undefined) globalStateValues.delete(key); else globalStateValues.set(key, value);
    } } },
    retainEngine: engine => f.engines.add(engine)
  };
  const host = vm.createContext(scope), originalLoad = Module._load;
  try {
    Module._load = function(id, ...args) { return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args); };
    vm.runInContext(source, host);
  } finally { Module._load = originalLoad; }
  vm.runInContext(`
    legacyConversationDeliveryHarnessForTests = ${options.productionTerminalContract === true ? 'false' : 'true'};
    getPersistedSettings = () => pendingPersistedSettings || settings;
    getProjects = () => [{ path: project, name: 'Project' }];
    getSelectedProjectPath = () => project;
    commandExists = () => true;
    sendNodesToWebview = () => {};
    setupFileSentinelWatcher = () => {};
    const actualLaunch = launchAgentConversationTerminal;
    this.useActualLaunch = () => { launchAgentConversationTerminal = actualLaunch; };
    this.launchTerminal = options => actualLaunch(options);
    this.closeTerminal = terminal => handleAgentTerminalClosed(terminal.name, undefined, typeof agentTerminalRunTargets === 'undefined' ? undefined : agentTerminalRunTargets.get(terminal));
    this.stopPoller = async () => {
      if (statusPoller) { clearInterval(statusPoller); statusPoller = null; }
      if (typeof activeRunConsumerPolls !== 'undefined') await Promise.all([...activeRunConsumerPolls.values()]);
      else if (activeRunConsumerPoll) await activeRunConsumerPoll;
      await new Promise(resolve => setTimeout(resolve, 0));
      while (processingAgentStatusFiles.size || pendingAgentStatusFiles.size) await new Promise(resolve => setTimeout(resolve, 10));
    };
    this.pollEffects = pollRunSettlementEffects;
    this.pollRuns = pollActiveConversations;
    this.processStatus = processAgentStatusFile;
    launchAgentConversationTerminal = async options => { deliveries.push(options); };
    activeProjectGrowthPath = project;
    activeProjectGrowthPanel = { webview: { postMessage: message => messages.push(message) } };
    extensionContextRef = context;
    this.hostEngine = () => syncEngine;
    this.continueTurn = handleContinueConversationTurn;
    this.resumeOrdinary = resumeOrdinaryConversation;
    this.prepareOrdinary = prepareOrdinaryConversation;
    this.deliverOrdinary = deliverOrdinaryConversation;
    this.startFlowRole = startFlowRoleRun;
    this.startReview = startAgentReviewRun;
    this.startReviewRevision = startAgentReviewRevisionRun;
    this.bindEngine = () => ensureSyncEngine(context);
    this.saveRoot = root => updatePersistedSettings(context, { globalDataPath: root });
    this.runPortable = (root, operation, input) => runDurablePortableOperation(context, root, operation, input);
    this.recoverPortable = root => recoverDurablePortableOperations(context, root);
    this.clearGrowthPanel = () => { activeProjectGrowthPanel = null; };
    this.mapTerminal = (id, name) => { setAgentTerminalBinding(project, id, name); };
    if (typeof captureConversationLaunchTarget === 'function') {
      const capture = captureConversationLaunchTarget;
      captureConversationLaunchTarget = async (...args) => { const target = await capture(...args); retainEngine(target.engine); return target; };
    }
  `, host);
  f.beforeClose.push(() => scope.stopPoller());
  vscode.window.createTerminal = options => {
    const terminal = { ...options, commands: [], processId: Promise.resolve(process.pid), show() {}, sendText(text) { terminal.commands.push(text); }, dispose() {} };
    vscode.window.terminals.push(terminal); return terminal;
  };
  // Execute the registered production message body, keeping its real continuation handler.
  const begin = source.indexOf('async (message) => {', source.indexOf('async function handleOpenProjectGrowth('));
  const currentEnd = source.indexOf('\n    });\n    growthPanel.onDidDispose', begin);
  const legacyEnd = source.indexOf('\n    });\n    activeProjectGrowthPanel.onDidDispose', begin);
  const end = currentEnd > begin ? currentEnd : legacyEnd;
  assert.ok(begin > 0 && end > begin);
  vm.runInContext('this.dispatchGrowth = ' + source.slice(begin, end) + '\n}', host);
  const bind = scope.bindEngine; scope.bindEngine = async () => { const result = await bind(); f.engines.add(scope.hostEngine()); return result; };
  return { scope, vscode, deliveries, failures, messages, globalStateValues };
}

async function databasePortableOperations(f, root = f.a) {
  const owner = root === f.a ? f.ownerA : f.ownerB;
  const result = await owner.ops({ operation: 'read_host_settings', input: { namespace: 'portable_operations', ownerScope: 'global' } });
  return result.items.map(item => item.value);
}

test('a portable operation reuses its persisted idempotency key after a host disconnect and restart', async t => {
  const f = await roots(t), globalStateValues = new Map(), seen = [];
  const first = extensionHost(t, f, { globalStateValues, stubRuntimeHealth: true });
  first.scope.requestHandler = async (_root, request) => { seen.push(request.input.idempotencyKey); throw new Error('simulated_host_disconnect_after_commit'); };
  await assert.rejects(first.scope.runPortable(f.a, 'backup', { destination: path.join(f.base, 'portable-restart.db') }), /simulated_host_disconnect_after_commit/);
  assert.equal((await databasePortableOperations(f)).filter(item => item.status === 'pending').length, 1);
  assert.equal([...globalStateValues.keys()].some(key => key.startsWith('solopreneur.pendingPortableOperation.v2.')), false);

  const restarted = extensionHost(t, f, { globalStateValues, stubRuntimeHealth: true });
  restarted.scope.requestHandler = async (_root, request) => { seen.push(request.input.idempotencyKey); return { bytes: 1 }; };
  await restarted.scope.recoverPortable(f.a);
  assert.equal(seen.length, 2);
  assert.equal(seen[1], seen[0]);
  assert.equal((await databasePortableOperations(f)).filter(item => item.status === 'pending').length, 0);
});

test('a completed portable operation gets a fresh identity when the user repeats it', async t => {
  const f = await roots(t), seen = [];
  const host = extensionHost(t, f, { stubRuntimeHealth: true });
  host.scope.requestHandler = async (_root, request) => { seen.push(request.input.idempotencyKey); return { bytes: 1 }; };
  const input = { destination: path.join(f.base, 'repeat-backup.db') };
  await host.scope.runPortable(f.a, 'backup', input);
  await host.scope.runPortable(f.a, 'backup', input);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[1], seen[0]);
});

test('two extension hosts can finish the same portable identity without a false failure', async t => {
  const f = await roots(t), globalStateValues = new Map();
  const first = extensionHost(t, f, { globalStateValues, stubRuntimeHealth: true });
  const second = extensionHost(t, f, { globalStateValues, stubRuntimeHealth: true });
  let arrivals = 0, releaseOperation, completionReads = 0, releaseCompletionReads;
  const operationGate = new Promise(resolve => { releaseOperation = resolve; });
  const completionReadGate = new Promise(resolve => { releaseCompletionReads = resolve; });
  first.scope.requestHandler = second.scope.requestHandler = async () => {
    arrivals += 1;
    if (arrivals === 2) {
      vm.runInContext('Date.now = () => 1000', first.scope);
      vm.runInContext('Date.now = () => 2000', second.scope);
      releaseOperation();
    }
    await operationGate;
    return { bytes: 1 };
  };
  first.scope.requestHook = second.scope.requestHook = async (_root, request) => {
    if (arrivals < 2 || request.operation !== 'read_host_settings') return;
    completionReads += 1;
    if (completionReads === 2) releaseCompletionReads();
    await completionReadGate;
  };
  const input = { destination: path.join(f.base, 'same-concurrent-backup.db') };
  const results = await Promise.allSettled([
    first.scope.runPortable(f.a, 'backup', input),
    second.scope.runPortable(f.a, 'backup', input)
  ]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
  const operations = await databasePortableOperations(f);
  assert.equal(operations.filter(item => item.status === 'completed').length, 1);
});

test('portable operation recovery upgrades a legacy shared ledger entry without changing its identity', async t => {
  const f = await roots(t), globalStateValues = new Map(), seen = [];
  const input = { destination: path.join(f.base, 'legacy-ledger-backup.db') };
  const intent = crypto.createHash('sha256').update(JSON.stringify({ root: f.a, operation: 'backup', input })).digest('hex');
  globalStateValues.set('solopreneur.pendingPortableOperations.v1', [{ id: 'legacy-portable-id', root: f.a, operation: 'backup', input, intent }]);
  const host = extensionHost(t, f, { globalStateValues, stubRuntimeHealth: true });
  host.scope.requestHandler = async (_root, request) => { seen.push(request.input.idempotencyKey); return { bytes: 1 }; };
  await host.scope.recoverPortable(f.a);
  assert.deepEqual(seen, ['portable-operation:legacy-portable-id']);
  assert.equal(globalStateValues.has('solopreneur.pendingPortableOperations.v1'), true, 'the non-CAS legacy source stays import-only so a late old writer cannot be erased');
  assert.equal([...globalStateValues.keys()].some(key => key.startsWith('solopreneur.pendingPortableOperation.v2.')), false);
});

test('a completed legacy portable identity is imported into the database before its marker is retired', async t => {
  const f = await roots(t), globalStateValues = new Map(), seen = [];
  const input = { destination: path.join(f.base, 'legacy-completed.db') };
  const entry = { id: 'legacy-completed', root: f.a, operation: 'backup', input,
    intent: crypto.createHash('sha256').update(JSON.stringify({ root: f.a, operation: 'backup', input })).digest('hex') };
  globalStateValues.set('solopreneur.pendingPortableOperations.v1', [entry]);
  globalStateValues.set('solopreneur.completedLegacyPortableOperation.v1.legacy-completed', true);
  const host = extensionHost(t, f, { globalStateValues, stubRuntimeHealth: true });
  host.scope.requestHandler = async (_root, request) => { seen.push(request.input.idempotencyKey); return { bytes: 1 }; };
  await host.scope.recoverPortable(f.a);
  const operations = await databasePortableOperations(f);
  assert.equal(operations.filter(item => item.id === entry.id && item.status === 'completed').length, 1);
  assert.deepEqual(seen, []);
  assert.equal(globalStateValues.has('solopreneur.completedLegacyPortableOperation.v1.legacy-completed'), false);
});

test('a late legacy shared-ledger writer remains recoverable during migration', async t => {
  const f = await roots(t), globalStateValues = new Map(), seen = [];
  const inputA = { destination: path.join(f.base, 'legacy-race-a.db') };
  const inputB = { destination: path.join(f.base, 'legacy-race-b.db') };
  const entry = (id, input) => ({ id, root: f.a, operation: 'backup', input,
    intent: crypto.createHash('sha256').update(JSON.stringify({ root: f.a, operation: 'backup', input })).digest('hex') });
  const firstEntry = entry('legacy-race-a', inputA), lateEntry = entry('legacy-race-b', inputB);
  globalStateValues.set('solopreneur.pendingPortableOperations.v1', [firstEntry]);
  let injected = false;
  const host = extensionHost(t, f, { globalStateValues, stubRuntimeHealth: true });
  host.scope.requestHook = async (_root, request) => {
    if (!injected && request.operation === 'patch_host_settings') {
      injected = true;
      globalStateValues.set('solopreneur.pendingPortableOperations.v1', [firstEntry, lateEntry]);
    }
  };
  host.scope.requestHandler = async (_root, request) => { seen.push(request.input.idempotencyKey); return { bytes: 1 }; };
  await host.scope.recoverPortable(f.a);
  await host.scope.recoverPortable(f.a);
  assert.deepEqual(new Set(seen), new Set(['portable-operation:legacy-race-a', 'portable-operation:legacy-race-b']));
  const operations = await databasePortableOperations(f);
  assert.equal(operations.filter(item => item.id === lateEntry.id && item.status === 'completed').length, 1);
});

test('separate extension hosts migrate the complete legacy portable ledger before consuming entries', async t => {
  const f = await roots(t), globalStateValues = new Map(), seen = [];
  const firstInput = { destination: path.join(f.base, 'legacy-first.db') };
  const secondInput = { destination: path.join(f.base, 'legacy-second.db') };
  const entry = (id, input) => ({ id, root: f.a, operation: 'backup', input,
    intent: crypto.createHash('sha256').update(JSON.stringify({ root: f.a, operation: 'backup', input })).digest('hex') });
  globalStateValues.set('solopreneur.pendingPortableOperations.v1', [entry('legacy-first', firstInput), entry('legacy-second', secondInput)]);
  const options = { globalStateValues, stubRuntimeHealth: true,
    globalStateUpdate: async (values, key, value) => {
      if (key === 'solopreneur.pendingPortableOperations.v1') await new Promise(resolve => setTimeout(resolve, 30));
      if (value === undefined) values.delete(key); else values.set(key, value);
    }
  };
  const first = extensionHost(t, f, options), second = extensionHost(t, f, options);
  first.scope.requestHandler = second.scope.requestHandler = async (_root, request) => { seen.push(request.input.idempotencyKey); return { bytes: 1 }; };
  await Promise.all([
    first.scope.runPortable(f.a, 'backup', firstInput),
    second.scope.runPortable(f.a, 'backup', secondInput)
  ]);
  assert.equal(globalStateValues.has('solopreneur.pendingPortableOperations.v1'), true, 'the shared legacy source is retained only for compatibility');
  assert.equal([...globalStateValues.keys()].some(key => key.startsWith('solopreneur.pendingPortableOperation.v2.')), false);
  assert.deepEqual(new Set(seen), new Set(['portable-operation:legacy-first', 'portable-operation:legacy-second']));
  await first.scope.runPortable(f.a, 'backup', firstInput);
  assert.notEqual(seen.at(-1), 'portable-operation:legacy-first');
});

test('separate extension hosts retain different data roots in the portable recovery index', async t => {
  const f = await roots(t), globalStateValues = new Map();
  const first = extensionHost(t, f, { globalStateValues, stubRuntimeHealth: true });
  const second = extensionHost(t, f, { globalStateValues, stubRuntimeHealth: true });
  first.scope.requestHandler = second.scope.requestHandler = async () => { throw new Error('simulated_host_disconnect_after_commit'); };
  const results = await Promise.allSettled([
    first.scope.runPortable(f.a, 'backup', { destination: path.join(f.base, 'root-a.db') }),
    second.scope.runPortable(f.b, 'backup', { destination: path.join(f.base, 'root-b.db') })
  ]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
  const indexedRoots = [...globalStateValues.entries()].filter(([key]) => key.startsWith('solopreneur.portableOperationRoot.v2.')).map(([, value]) => value);
  assert.deepEqual(new Set(indexedRoots), new Set([f.a, f.b]));
  const restarted = extensionHost(t, f, { globalStateValues, stubRuntimeHealth: true });
  restarted.scope.requestHandler = async () => ({ bytes: 1 });
  await restarted.scope.recoverPortable(f.a);
  assert.equal((await databasePortableOperations(f, f.a)).filter(item => item.status === 'pending').length, 0);
  assert.equal((await databasePortableOperations(f, f.b)).filter(item => item.status === 'pending').length, 0);
});

test('an unavailable indexed root is not recreated and cannot block another root recovery', async t => {
  const f = await roots(t), globalStateValues = new Map(), seen = [];
  const missingRoot = path.join(f.base, 'offline-volume', '.solomap-global');
  const missingKey = `solopreneur.portableOperationRoot.v2.${crypto.createHash('sha256').update(missingRoot).digest('hex')}`;
  globalStateValues.set(missingKey, missingRoot);
  const first = extensionHost(t, f, { globalStateValues, stubRuntimeHealth: true });
  first.scope.requestHandler = async (_root, request) => {
    if (request.operation === 'backup') throw new Error('simulated_host_disconnect_after_commit');
    return { bytes: 1 };
  };
  await assert.rejects(first.scope.runPortable(f.b, 'backup', { destination: path.join(f.base, 'healthy-root.db') }), /simulated_host_disconnect_after_commit/);

  const restarted = extensionHost(t, f, { globalStateValues, stubRuntimeHealth: true });
  restarted.scope.runtimeHealthHandler = async ({ globalDataPath }) => {
    if (globalDataPath === missingRoot) throw new Error('database_restore_required');
    return {};
  };
  restarted.scope.requestHandler = async (root, request) => { if (request.operation === 'backup') seen.push(root); return { bytes: 1 }; };
  await restarted.scope.recoverPortable(f.a);
  assert.equal(fs.existsSync(missingRoot), false);
  assert.deepEqual(seen, [f.b]);
  assert.equal((await databasePortableOperations(f, f.b)).filter(item => item.status === 'pending').length, 0);
});

test('legacy portable operations with the same intent retain every historical identity', async t => {
  const f = await roots(t), globalStateValues = new Map(), seen = [];
  const input = { destination: path.join(f.base, 'same-intent.db') };
  const intent = crypto.createHash('sha256').update(JSON.stringify({ root: f.a, operation: 'backup', input })).digest('hex');
  globalStateValues.set('solopreneur.pendingPortableOperations.v1', [
    { id: 'same-intent-first', root: f.a, operation: 'backup', input, intent },
    { id: 'same-intent-second', root: f.a, operation: 'backup', input, intent }
  ]);
  const host = extensionHost(t, f, { globalStateValues, stubRuntimeHealth: true });
  host.scope.requestHandler = async (_root, request) => { seen.push(request.input.idempotencyKey); return { bytes: 1 }; };
  await host.scope.recoverPortable(f.a);
  assert.deepEqual(new Set(seen), new Set(['portable-operation:same-intent-first', 'portable-operation:same-intent-second']));
  const operations = await databasePortableOperations(f);
  assert.deepEqual(new Set(operations.map(item => item.id)), new Set(['same-intent-first', 'same-intent-second']));
  assert.ok(operations.every(item => item.status === 'completed'));
  assert.equal(globalStateValues.has('solopreneur.pendingPortableOperations.v1'), true, 'all identities remain replayable from the import-only legacy source');
});

test('a late legacy writer cannot block recovery after a newer same-intent operation', async t => {
  const f = await roots(t), globalStateValues = new Map(), seen = [];
  const input = { destination: path.join(f.base, 'late-same-intent.db') };
  const intent = crypto.createHash('sha256').update(JSON.stringify({ root: f.a, operation: 'backup', input })).digest('hex');
  const legacy = { id: 'late-same-intent', root: f.a, operation: 'backup', input, intent };
  globalStateValues.set('solopreneur.pendingPortableOperations.v1', [legacy]);
  const host = extensionHost(t, f, { globalStateValues, stubRuntimeHealth: true });
  host.scope.requestHandler = async (_root, request) => { seen.push(request.input.idempotencyKey); return { bytes: 1 }; };
  await host.scope.recoverPortable(f.a);
  await host.scope.runPortable(f.a, 'backup', input);
  globalStateValues.set('solopreneur.pendingPortableOperations.v1', [legacy]);
  await host.scope.recoverPortable(f.a);
  assert.equal(seen.filter(value => value === 'portable-operation:late-same-intent').length, 1);
  assert.equal(globalStateValues.has('solopreneur.pendingPortableOperations.v1'), true, 'the database result makes the retained legacy source non-authoritative');
});

test('a repeated portable operation archives the completed identity before accepting a late legacy writer', async t => {
  const f = await roots(t), globalStateValues = new Map(), seen = [];
  const input = { destination: path.join(f.base, 'current-history.db') };
  const intent = crypto.createHash('sha256').update(JSON.stringify({ root: f.a, operation: 'backup', input })).digest('hex');
  const host = extensionHost(t, f, { globalStateValues, stubRuntimeHealth: true });
  host.scope.requestHandler = async (_root, request) => { seen.push(request.input.idempotencyKey); return { bytes: 1 }; };
  await host.scope.runPortable(f.a, 'backup', input);
  const firstId = (await databasePortableOperations(f))[0].id;
  await host.scope.runPortable(f.a, 'backup', input);
  const afterRepeat = await databasePortableOperations(f);
  assert.equal(afterRepeat.filter(item => item.id === firstId && item.status === 'completed').length, 1);
  assert.equal(afterRepeat.filter(item => item.intent === intent && item.status === 'completed').length, 2);
  globalStateValues.set('solopreneur.pendingPortableOperations.v1', [{ id: firstId, root: f.a, operation: 'backup', input, intent }]);
  await host.scope.recoverPortable(f.a);
  assert.equal(seen.filter(value => value === `portable-operation:${firstId}`).length, 1);
});

test('a late legacy migration writer cannot resurrect an already completed portable identity', async t => {
  const f = await roots(t), globalStateValues = new Map(), seen = [];
  const firstInput = { destination: path.join(f.base, 'late-first.db') };
  const secondInput = { destination: path.join(f.base, 'late-second.db') };
  const entry = (id, input) => ({ id, root: f.a, operation: 'backup', input,
    intent: crypto.createHash('sha256').update(JSON.stringify({ root: f.a, operation: 'backup', input })).digest('hex') });
  globalStateValues.set('solopreneur.pendingPortableOperations.v1', [entry('late-first', firstInput), entry('late-second', secondInput)]);
  const first = extensionHost(t, f, { globalStateValues, stubRuntimeHealth: true });
  first.scope.requestHandler = async (_root, request) => {
    seen.push(request.input.idempotencyKey);
    return { bytes: 1 };
  };
  await first.scope.recoverPortable(f.a);
  assert.deepEqual(new Set(seen), new Set(['portable-operation:late-first', 'portable-operation:late-second']));
  globalStateValues.set('solopreneur.pendingPortableOperations.v1', [entry('late-first', firstInput)]);
  await first.scope.recoverPortable(f.a);
  assert.equal([...globalStateValues.values()].some(value => value?.id === 'late-first'), false);
  assert.equal(seen.filter(value => value === 'portable-operation:late-first').length, 1);
});

test('a completed legacy portable operation leaves no authoritative operation in globalState', async t => {
  const f = await roots(t), globalStateValues = new Map(), seen = [];
  const input = { destination: path.join(f.base, 'cleanup-after-success.db') };
  const intent = crypto.createHash('sha256').update(JSON.stringify({ root: f.a, operation: 'backup', input })).digest('hex');
  globalStateValues.set('solopreneur.pendingPortableOperations.v1', [{ id: 'cleanup-after-success', root: f.a, operation: 'backup', input, intent }]);
  const host = extensionHost(t, f, { globalStateValues, stubRuntimeHealth: true });
  host.scope.requestHandler = async (_root, request) => { seen.push(request.input.idempotencyKey); return { bytes: 7 }; };
  assert.deepEqual(await host.scope.runPortable(f.a, 'backup', input), { bytes: 7 });
  assert.equal(globalStateValues.has('solopreneur.pendingPortableOperation.v2.cleanup-after-success'), false);
  assert.equal((await databasePortableOperations(f))[0].status, 'completed');
  assert.deepEqual(await host.scope.runPortable(f.a, 'backup', input), { bytes: 7 });
  assert.notEqual(seen.at(-1), 'portable-operation:cleanup-after-success');
});

test('concurrent portable operations retain both recovery identities after host disconnects', async t => {
  const f = await roots(t), globalStateValues = new Map();
  const host = extensionHost(t, f, { globalStateValues, stubRuntimeHealth: true,
    globalStateUpdate: async (values, key, value) => {
      if (key === 'solopreneur.pendingPortableOperations.v1') await new Promise(resolve => setTimeout(resolve, 20));
      if (value === undefined) values.delete(key); else values.set(key, value);
    }
  });
  host.scope.requestHandler = async () => { throw new Error('simulated_disconnect_after_commit'); };
  const results = await Promise.allSettled([
    host.scope.runPortable(f.a, 'backup', { destination: path.join(f.base, 'first.db') }),
    host.scope.runPortable(f.a, 'backup', { destination: path.join(f.base, 'second.db') })
  ]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
  const pending = (await databasePortableOperations(f)).filter(item => item.status === 'pending');
  assert.equal(pending.length, 2);
  assert.equal(new Set(pending.map(item => item.id)).size, 2);
});

test('separate extension hosts retain both concurrent portable recovery identities', async t => {
  const f = await roots(t), globalStateValues = new Map();
  const options = { globalStateValues, stubRuntimeHealth: true,
    globalStateUpdate: async (values, key, value) => {
      if (key === 'solopreneur.pendingPortableOperations.v1') await new Promise(resolve => setTimeout(resolve, 20));
      if (value === undefined) values.delete(key); else values.set(key, value);
    }
  };
  const first = extensionHost(t, f, options), second = extensionHost(t, f, options);
  first.scope.requestHandler = second.scope.requestHandler = async () => { throw new Error('simulated_disconnect_after_commit'); };
  const results = await Promise.allSettled([
    first.scope.runPortable(f.a, 'backup', { destination: path.join(f.base, 'host-first.db') }),
    second.scope.runPortable(f.a, 'backup', { destination: path.join(f.base, 'host-second.db') })
  ]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
  const pending = (await databasePortableOperations(f)).filter(item => item.status === 'pending');
  assert.equal(pending.length, 2);
  assert.equal(new Set(pending.map(item => item.id)).size, 2);
});

async function nativeSource(f, root, owner, label, launch = {}) {
  const { prepareAgentRun } = require('../out/agentRunPreparation.js');
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const call = (operation, input) => owner.ops({ operation, input });
  // These root-routing fixtures exercise settlement ownership rather than a
  // provider transcript. Use a caller-assigned provider without a native observer so the
  // business checkpoint is immediately eligible for consumption.
  const prepared = await prepareAgentRun({ agentCli: launch.agentCli || 'copilot', selectedModel: 'source-model', prompt: `原任务 ${label}`,
    workspaceRoot: f.project, nodeId: '__solo__', executionLogId: 1, userMessage: `用户目标 ${label}`, runKind: 'solo',
    globalDataPath: root, taskPermissionMode: 'auto', ...(launch.metadata ? { metadata: launch.metadata } : {}) }, call);
  const client = new RunLifecycleClient(call), reference = runStatusReference(f.project, 1);
  const binding = await client.readBinding(reference);
  await client.writeBinding(reference, await client.readStatus(reference), { expectedHeadRevision: binding.headRevision,
    confirmSessionId: prepared.status.plannedNativeSessionId, evidence: { source: 'official_native_observation' }, idempotencyKey: `confirm:${label}` });
  owner.store.submitRunReport(prepared.projectId, { executionLogId: 1, generation: prepared.generation, turnId: prepared.turnId,
    report: { summary: `完整来源报告 ${label}` }, availability: 'available', idempotencyKey: `report:${label}` });
  return prepared;
}

for (const changeDuringInput of [false, true]) {
  test(`report continuation preserves its native task and source root ${changeDuringInput ? 'while the input is open' : 'after switching roots'}`, async t => {
    const f = await roots(t), a = await nativeSource(f, f.a, f.ownerA, 'A'), b = await nativeSource(f, f.b, f.ownerB, 'B');
    const { scope, vscode, deliveries, failures, messages } = extensionHost(t, f);
    await scope.bindEngine();
    let source = b, owner = f.ownerB, root = f.b;
    if (changeDuringInput) {
      source = a; owner = f.ownerA; root = f.a;
      vscode.window.showInputBox = async () => { scope.settings = { ...scope.settings, globalDataPath: f.b, globalPrompt: '其他库规则' }; await scope.bindEngine(); return '继续原任务'; };
    } else { scope.settings = { ...scope.settings, globalDataPath: f.b }; await scope.bindEngine(); }
    const beforeCsv = fs.readFileSync(path.join(f.project, '.solopreneur/roadmap.csv'));
    await scope.dispatchGrowth({ command: 'growth.reportAction', projectPath: f.project, taskId: `task-${source.taskId}`,
      executionLogId: 1, turnId: source.turnId, kind: 'continue', actionId: 'continue-source' });
    assert.equal(deliveries.length, 1, JSON.stringify({ failures, messages }));
    const delivery = deliveries[0]; assert.equal(delivery.globalDataPath, root);
    const plan = owner.store.readRunExecutionPlan(source.projectId, delivery.conversationId);
    assert.equal(plan.taskId, source.taskId); assert.equal(plan.status.plannedNativeSessionId, source.status.plannedNativeSessionId);
    assert.equal(plan.status.sourceParentTurnId, source.turnId);
    assert.match(plan.prompt, /继续原任务/); assert.match(plan.prompt, /完整来源报告/);
    assert.match(plan.prompt, /来源库规则/); assert.doesNotMatch(plan.prompt, /其他库规则|agent-runs\/|\.solopreneur\/runtime\/task-checkpoint/);
    assert.doesNotMatch(plan.command, /prompt\.txt|agent-runs/);
    assert.equal(f.ownerA.store.readProjectJournal(a.projectId).logs.length, changeDuringInput ? 2 : 1);
    assert.equal(f.ownerB.store.readProjectJournal(b.projectId).logs.length, changeDuringInput ? 1 : 2);
    assert.deepEqual(fs.readFileSync(path.join(f.project, '.solopreneur/roadmap.csv')), beforeCsv);
    assert.equal(fs.existsSync(path.join(f.project, '.solopreneur/agent-runs')), false);
  });
}

test('continuing a source report does not repair cleanup state in another root', async t => {
  const f = await roots(t), a = await nativeSource(f, f.a, f.ownerA, 'A'), b = await nativeSource(f, f.b, f.ownerB, 'B');
  const stateB = f.ownerB.store.readRunState(b.projectId, 1);
  await f.ownerB.ops({ operation: 'patch_run_state', input: { projectId: b.projectId, executionLogId: 1, generation: stateB.generation,
    expectedRevision: stateB.revision, patch: { failureCode: 'agent_process_cleanup_failed', cleanupRootConversationId: 1 }, idempotencyKey: 'other-root-cleanup' } });
  const beforeB = f.ownerB.store.readRunState(b.projectId, 1);
  const { scope, vscode, deliveries, messages } = extensionHost(t, f); await scope.bindEngine();
  vscode.window.showInputBox = async () => { scope.settings = { ...scope.settings, globalDataPath: f.b }; await scope.bindEngine(); return '继续来源任务'; };
  await scope.dispatchGrowth({ command: 'growth.reportAction', projectPath: f.project, taskId: `task-${a.taskId}`, executionLogId: 1,
    turnId: a.turnId, kind: 'continue', actionId: 'continue-with-other-cleanup' });
  assert.equal(deliveries.length, 1, JSON.stringify(messages));
  assert.equal(f.ownerB.store.readRunState(b.projectId, 1).revision, beforeB.revision);
  assert.equal(deliveries[0].globalDataPath, f.a);
});

test('saving a new root rebinds the already active action engine before any later action', async t => {
  const f = await roots(t), { scope } = extensionHost(t, f); await scope.bindEngine();
  scope.clearGrowthPanel();
  await scope.saveRoot(f.b);
  const current = scope.hostEngine(); f.engines.add(current); await current.initAndSync();
  await current.logAgentExecution('__solo__', 'claude', 'current root', 'after settings save', 'Completed');
  assert.deepEqual(f.ownerA.store.readProjectJournal(f.ownerA.projectIds.get(f.project)).logs, []);
  assert.deepEqual(f.ownerB.store.readProjectJournal(f.ownerB.projectIds.get(f.project)).logs.map(log => log.output), ['after settings save']);
});

test('a name-only terminal cannot receive a continuation and the new task keeps the selected root', async t => {
  const f = await roots(t), a = await nativeSource(f, f.a, f.ownerA, 'A'), b = await nativeSource(f, f.b, f.ownerB, 'B');
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  for (const [label, owner, source] of [['A', f.ownerA, a], ['B', f.ownerB, b]]) {
    const client = new RunLifecycleClient((operation, input) => owner.ops({ operation, input })), reference = runStatusReference(f.project, 1);
    await client.checkpoint(reference, await client.readStatus(reference), { action: 'complete', outcome: 'partial', summary: `已交付 ${label}`,
      report: { summary: `完整来源报告 ${label}` }, reportAvailability: 'available', idempotencyKey: `complete:${label}` });
    let state = owner.store.readRunState(source.projectId, 1);
    await owner.ops({ operation: 'patch_run_inputs', input: { projectId: source.projectId, executionLogId: 1, generation: state.generation,
      expectedRevision: state.revision, status: 'Waiting', idempotencyKey: `waiting:${label}` } });
    state = owner.store.readRunState(source.projectId, 1);
    await owner.ops({ operation: 'patch_run_state', input: { projectId: source.projectId, executionLogId: 1, generation: state.generation,
      expectedRevision: state.revision, patch: { terminalName: `source-${label}` }, idempotencyKey: `terminal:${label}` } });
  }
  const beforeB = f.ownerB.store.readRunState(b.projectId, 1);
  const { scope, vscode, deliveries, messages } = extensionHost(t, f, { productionTerminalContract: true }), sentA = [], sentB = [];
  vscode.window.terminals.push({ name: 'source-A', processId: Promise.resolve(process.pid), show() {}, sendText: text => sentA.push(text) },
    { name: 'source-B', processId: Promise.resolve(process.pid), show() {}, sendText: text => sentB.push(text) });
  scope.mapTerminal(1, 'source-B'); await scope.bindEngine();
  vscode.window.showInputBox = async () => { scope.settings = { ...scope.settings, globalDataPath: f.b }; await scope.bindEngine(); return '继续来源 A'; };
  await scope.dispatchGrowth({ command: 'growth.reportAction', projectPath: f.project, taskId: `task-${a.taskId}`, executionLogId: 1,
    turnId: a.turnId, kind: 'continue', actionId: 'continue-live-source' });
  assert.equal(deliveries.length, 1, JSON.stringify(messages)); assert.deepEqual(sentA, []); assert.deepEqual(sentB, []);
  const afterA = f.ownerA.store.readRunState(a.projectId, 2);
  assert.notEqual(afterA.turnId, a.turnId); assert.equal(afterA.taskId, a.taskId); assert.equal(afterA.status.journalExecutionLogId, 2);
  assert.equal(deliveries[0].globalDataPath, f.a); assert.equal(deliveries[0].conversationId, 2);
  const launchRequest = f.ownerA.store.readRunDocument(a.projectId, 2, 'launch_request');
  const launchPayload = Buffer.from(launchRequest.bytes, 'base64').toString('utf8');
  assert.match(launchPayload, /继续来源 A/);
  assert.equal(f.ownerB.store.readRunState(b.projectId, 1).revision, beforeB.revision);
  assert.equal(f.ownerB.store.readProjectJournal(b.projectId).logs.length, 1);
  assert.equal(fs.existsSync(path.join(f.project, '.solopreneur/agent-runs')), false);
});

test('an unconfirmed native binding cannot produce a continuation or a success receipt', async t => {
  const f = await roots(t), a = await nativeSource(f, f.a, f.ownerA, 'A');
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const client = new RunLifecycleClient((operation, input) => f.ownerA.ops({ operation, input })), reference = runStatusReference(f.project, 1);
  const binding = await client.readBinding(reference);
  await client.writeBinding(reference, await client.readStatus(reference), { expectedHeadRevision: binding.headRevision,
    revision: { method: 'caller_assigned', contract: 'official_stable', state: 'unavailable' }, idempotencyKey: 'native-identity-unavailable' });
  const { scope, deliveries, messages } = extensionHost(t, f); await scope.bindEngine();
  await scope.dispatchGrowth({ command: 'growth.reportAction', projectPath: f.project, taskId: `task-${a.taskId}`, executionLogId: 1,
    turnId: a.turnId, kind: 'continue', actionId: 'continue-unconfirmed' });
  assert.equal(deliveries.length, 0); assert.match(messages.at(-1).error, /尚未确认/);
  assert.equal(f.ownerA.store.readProjectJournal(a.projectId).logs.length, 1);
  assert.equal(fs.existsSync(path.join(f.project, '.solopreneur/agent-runs')), false);
});

test('formal Codex continuation preserves confirmed native evidence through observation and another continuation', async t => {
  const f = await roots(t), { prepareAgentRun } = require('../out/agentRunPreparation.js'), { RunNativeObserver } = require('../out/runNativeObserver.js');
  const home = path.join(path.dirname(f.project), 'original-codex-home'), transcript = path.join(home, 'sessions', 'original-session.jsonl');
  const sessionId = '019ecd99-4325-7050-8e71-7def92359d23';
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, [
    { timestamp: '2026-09-02T00:20:00.000Z', type: 'session_meta', payload: { id: sessionId, cwd: f.project, timestamp: '2026-09-02T00:20:00.000Z' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '之前已完成的回复' }] } }
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const originalHome = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
  let source;
  try {
    source = await prepareAgentRun({ agentCli: 'codex', selectedModel: '', prompt: '原始任务', workspaceRoot: f.project, nodeId: '__solo__', executionLogId: 1,
      userMessage: '继续长期会话', runKind: 'solo', globalDataPath: f.a, taskPermissionMode: 'auto', nativeSessionId: sessionId, continuation: true,
      metadata: { codexResumeTranscriptPath: transcript } }, (operation, input) => f.ownerA.ops({ operation, input }));
  } finally { if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome; }
  const { scope, deliveries } = extensionHost(t, f); await scope.bindEngine();
  await scope.continueTurn(scope.context, '__solo__', 1, '继续这个会话', '', [], true);
  assert.equal(deliveries.length, 1);
  const id = deliveries[0].conversationId, state = f.ownerA.store.readRunState(source.projectId, id);
  const binding = f.ownerA.store.readRunBinding(source.projectId, id), head = binding.revisions[binding.headRevision - 1];
  assert.equal(state.status.nativeSessionIdIsCurrent, true);
  assert.equal(head.state, 'confirmed'); assert.equal(head.sessionId, sessionId); assert.equal(head.evidence.transcriptPath, transcript);
  assert.equal(binding.revisions[0].providerContext.codex.codexHome, home);
  const began = Date.now() + 100, ended = began + 100;
  fs.appendFileSync(transcript, [
    { timestamp: new Date(began).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'native-next-turn', started_at: began / 1000 } },
    { timestamp: new Date(ended).toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'native-next-turn', started_at: began / 1000, completed_at: ended / 1000, last_agent_message: '本轮真实机器事件回复' } }
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  await new RunNativeObserver(f.ownerA.store).observe(state);
  const completed = f.ownerA.store.readRunState(source.projectId, id);
  assert.equal(completed.status.checkpointSummary, '本轮真实机器事件回复');
  assert.equal(f.ownerA.store.readMetadata(completed.turnId).data.outcome, 'partial');
  await scope.continueTurn(scope.context, '__solo__', id, '再继续一次', '', [], true);
  assert.equal(deliveries.length, 2);
  const next = f.ownerA.store.readRunState(source.projectId, deliveries[1].conversationId);
  assert.equal(next.taskId, source.taskId); assert.equal(next.status.nativeSessionIdIsCurrent, true);
  assert.equal(f.ownerA.store.readRunBinding(source.projectId, deliveries[1].conversationId).revisions.at(-1).evidence.transcriptPath, transcript);
  const beforeInvalid = f.ownerA.store.readProjectJournal(source.projectId).logs.length;
  fs.writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: '019ecd99-4325-7050-8e71-7def92359d99', cwd: f.project } }) + '\n');
  await assert.rejects(new RunNativeObserver(f.ownerA.store).observe(next), /identity_transcript_mismatch/);
  assert.equal(f.ownerA.store.readRunLogHead(source.projectId, deliveries[1].conversationId, 'native:codex').totalBytes, 0);
  await assert.rejects(scope.continueTurn(scope.context, '__solo__', deliveries[1].conversationId, '不得接续被替换的会话', '', [], true), /identity_transcript_mismatch/);
  assert.equal(deliveries.length, 2);
  assert.equal(f.ownerA.store.readProjectJournal(source.projectId).logs.length, beforeInvalid);
  fs.writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: path.join(f.project, 'other-project') } }) + '\n');
  await assert.rejects(scope.continueTurn(scope.context, '__solo__', deliveries[1].conversationId, '不得接续其他项目的会话', '', [], true), /identity_transcript_mismatch/);
  assert.equal(f.ownerA.store.readProjectJournal(source.projectId).logs.length, beforeInvalid);
  assert.equal(fs.existsSync(path.join(f.project, '.solopreneur/agent-runs')), false);
});

test('the real continuation launcher and terminal close settle their captured root without stopping an equal-ID run in another root', async t => {
  const f = await roots(t), a = await nativeSource(f, f.a, f.ownerA, 'A'), b = await nativeSource(f, f.b, f.ownerB, 'B');
  const { prepareAgentRun } = require('../out/agentRunPreparation.js');
  await prepareAgentRun({ agentCli: 'claude', selectedModel: '', prompt: '独立 B 内容', workspaceRoot: f.project, nodeId: '__solo__', executionLogId: 2,
    parentExecutionLogId: 1, expectedParentTurnId: b.turnId, userMessage: '另一个库的继续', runKind: 'solo_continue', globalDataPath: f.b,
    taskPermissionMode: 'auto', nativeSessionId: String(b.status.plannedNativeSessionId), continuation: true }, (operation, input) => f.ownerB.ops({ operation, input }));
  const beforeB = f.ownerB.store.readRunState(b.projectId, 2), { scope, vscode, messages } = extensionHost(t, f);
  scope.useActualLaunch(); await scope.bindEngine();
  vscode.window.showInputBox = async () => { scope.settings = { ...scope.settings, globalDataPath: f.b }; await scope.bindEngine(); return '继续来源 A 并保留记录'; };
  await scope.dispatchGrowth({ command: 'growth.reportAction', projectPath: f.project, taskId: `task-${a.taskId}`, executionLogId: 1,
    turnId: a.turnId, kind: 'continue', actionId: 'continue-real-terminal' });
  assert.equal(vscode.window.terminals.length, 1, JSON.stringify(messages));
  const terminal = vscode.window.terminals[0]; assert.match(terminal.commands[0], /runAgentProcess/);
  assert.equal(await scope.closeTerminal(terminal), true);
  assert.equal(f.ownerB.store.readRunState(b.projectId, 2).revision, beforeB.revision, 'closing A cannot stop or settle B');
  const closedA = f.ownerA.store.readRunState(a.projectId, 2);
  assert.equal(closedA.status.interactiveSessionClosed, true);
  const settlements = f.ownerA.store.readRunSettlements(a.projectId, { executionLogId: 2 });
  assert.equal(settlements.items.length, 2, JSON.stringify(settlements.items));
  assert.ok(settlements.items.every(item => JSON.stringify(item).includes('继续来源 A 并保留记录')));
  assert.match(JSON.stringify(settlements.items), /Interactive session state: Closed/);
  assert.doesNotMatch(JSON.stringify(settlements.items), /独立 B 内容|另一个库的继续/);
  assert.equal(fs.existsSync(path.join(f.project, '.solopreneur/agent-runs')), false);
});

test('queued actions in another root complete while the first root is waiting', async t => {
  const f = await roots(t), { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const { getAgentRunDeliveryOwner } = require('../out/agentRunPreparation.js');
  const clients = [];
  for (const [label, root, owner] of [['A', f.a, f.ownerA], ['B', f.b, f.ownerB]]) {
    const source = await nativeSource(f, root, owner, label);
    const client = new RunLifecycleClient((operation, input) => owner.ops({ operation, input }), root);
    const reference = runStatusReference(f.project, 1);
    const done = await client.checkpoint(reference, await client.readStatus(reference), {
      action: 'complete', outcome: 'partial', summary: `结论 ${label}`, idempotencyKey: `effect-complete:${label}`
    });
    const lease = await client.claimConsumer(reference, done, await getAgentRunDeliveryOwner());
    await client.commitSettlement(reference, done, lease, {
      journal: { agentCli: 'claude', command: `command ${label}`, output: `source ${label}`, status: 'In Progress' },
      digest: { schemaVersion: 2, runId: `__solo__:1`, source: label, nodeId: '__solo__', executionLogId: 1 }, effects: [{ kind: 'refresh', payload: { workspaceRoot: f.project, nodeId: '__solo__', executionLogId: 1, originalExecutionLogId: 1, globalDataPath: root } }],
      idempotencyKey: `effect-settle:${label}`
    });
    assert.equal((await client.listEffects()).items.length, 1);
    clients.push(client);
  }
  const { scope } = extensionHost(t, f); await scope.bindEngine();
  let releaseA, enteredA;
  const gate = new Promise(resolve => { releaseA = resolve; }), started = new Promise(resolve => { enteredA = resolve; });
  const listA = clients[0].listEffects.bind(clients[0]);
  clients[0].listEffects = async cursor => { enteredA(); await gate; return listA(cursor); };
  const flightA = scope.pollEffects(clients[0]); await started;
  let timer;
  try {
    const result = await Promise.race([scope.pollEffects(clients[1]).then(() => 'completed'), new Promise(resolve => { timer = setTimeout(() => resolve('blocked by other root'), 2000); })]);
    assert.equal(result, 'completed');
    assert.equal((await clients[1].listEffects()).items.length, 0);
    assert.equal((await listA()).items.length, 1);
  } finally { clearTimeout(timer); releaseA(); await flightA; }
  assert.equal((await listA()).items.length, 0);
});

test('concurrent equal-ID settlement and its queued retry retain their respective data roots', async t => {
  const f = await roots(t), { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const statuses = [];
  for (const [label, root, owner] of [['A', f.a, f.ownerA], ['B', f.b, f.ownerB]]) {
    await nativeSource(f, root, owner, label);
    const client = new RunLifecycleClient((operation, input) => owner.ops({ operation, input }), root);
    const reference = runStatusReference(f.project, 1);
    statuses.push(await client.checkpoint(reference, await client.readStatus(reference), {
      action: 'complete', outcome: 'partial', summary: `本轮结论 ${label}`, idempotencyKey: `concurrent-complete:${label}`
    }));
  }
  const { scope } = extensionHost(t, f); scope.settings.globalDataPath = f.b; await scope.bindEngine();
  const reference = runStatusReference(f.project, 1);
  let releaseA, enteredA, retryA, held = false;
  const gate = new Promise(resolve => { releaseA = resolve; }), started = new Promise(resolve => { enteredA = resolve; });
  const retried = new Promise(resolve => { retryA = resolve; });
  scope.requestHook = async (root, request) => {
    if (root !== f.a) return;
    if (request.operation === 'claim_run_consumer' && !held) { held = true; enteredA(); await gate; }
    if (request.operation === 'list_run_states' && held) retryA();
  };
  const flightA = scope.processStatus(reference, statuses[0], f.a); await started;
  let timer;
  try {
    await scope.processStatus(reference, undefined, f.a);
    await scope.processStatus(reference, statuses[1], f.b);
    const b = f.ownerB.store.readRunSettlements(f.ownerB.projectIds.get(f.project), { executionLogId: 1 });
    assert.equal(b.items.length, 1, 'B must settle independently while A is held');
    assert.match(JSON.stringify(b.items[0]), /本轮结论 B/);
    assert.doesNotMatch(JSON.stringify(b.items[0]), /本轮结论 A/);
  } finally { releaseA(); await flightA; }
  try {
    const result = await Promise.race([retried.then(() => 'A'), new Promise(resolve => { timer = setTimeout(() => resolve('missing source retry'), 2000); })]);
    assert.equal(result, 'A');
  } finally { clearTimeout(timer); }
  const a = f.ownerA.store.readRunSettlements(f.ownerA.projectIds.get(f.project), { executionLogId: 1 });
  assert.equal(a.items.length, 1); assert.match(JSON.stringify(a.items[0]), /本轮结论 A/);
  assert.doesNotMatch(JSON.stringify(a.items[0]), /本轮结论 B/);
  assert.equal(scope.settings.globalDataPath, f.b);
  assert.equal(fs.existsSync(path.join(f.project, '.solopreneur/agent-runs')), false);
});

test('closing a terminal from an earlier generation cannot stop the current run', async t => {
  const f = await roots(t), source = await nativeSource(f, f.a, f.ownerA, 'A');
  const { scope, vscode } = extensionHost(t, f); scope.useActualLaunch(); await scope.bindEngine();
  await scope.continueTurn(scope.context, '__solo__', 1, '新建可接续终端', '', [], true);
  assert.equal(vscode.window.terminals.length, 1);
  await scope.stopPoller();
  const before = f.ownerA.store.readRunState(source.projectId, 2);
  const current = await f.ownerA.ops({ operation: 'claim_run', input: { root: f.project, executionLogId: 2,
    expectedRevision: before.revision, idempotencyKey: 'replacement-generation' } });
  assert.equal(current.generation, before.generation + 1);
  await assert.rejects(scope.launchTerminal({ workspaceRoot: f.project, label: 'solo_continue', conversationId: 2, nodeId: '__solo__',
    statusFilePath: require('../out/runLifecycleClient.js').runStatusReference(f.project, 2), runKind: 'solo_continue', globalDataPath: f.a,
    command: 'the old terminal must not launch another wrapper', context: scope.context, agentCli: 'claude' }), /run_already_delivered/);
  assert.equal(await scope.closeTerminal(vscode.window.terminals[0]), false);
  assert.equal(f.ownerA.store.readRunState(source.projectId, 2).revision, current.revision);
  assert.equal(f.ownerA.store.readRunState(source.projectId, 2).status.interactiveSessionClosed, undefined);
});

test('two clients polling one root do not apply the same queued action twice', async t => {
  const f = await roots(t), source = await nativeSource(f, f.a, f.ownerA, 'A');
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const { getAgentRunDeliveryOwner } = require('../out/agentRunPreparation.js');
  let claims = 0;
  const call = (operation, input) => { if (operation === 'claim_run_effect') claims++; return f.ownerA.ops({ operation, input }); };
  const client = new RunLifecycleClient(call, f.a), otherClient = new RunLifecycleClient(call, f.a), reference = runStatusReference(f.project, 1);
  const done = await client.checkpoint(reference, await client.readStatus(reference), {
    action: 'complete', outcome: 'partial', summary: '一次结论', idempotencyKey: 'same-root-complete'
  });
  const lease = await client.claimConsumer(reference, done, await getAgentRunDeliveryOwner());
  await client.commitSettlement(reference, done, lease, {
    journal: { agentCli: 'claude', command: 'same root', output: '完整结论', status: 'In Progress' },
    digest: { schemaVersion: 2, runId: '__solo__:1', nodeId: '__solo__', executionLogId: 1 },
    effects: [{ kind: 'refresh', payload: { workspaceRoot: f.project, nodeId: '__solo__', executionLogId: 1, originalExecutionLogId: 1, globalDataPath: f.a } }],
    idempotencyKey: 'same-root-settle'
  });
  const { scope } = extensionHost(t, f); await scope.bindEngine();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const claim = client.claimEffect.bind(client);
  client.claimEffect = async (...args) => { const effect = await claim(...args); entered(); await gate; return effect; };
  const first = scope.pollEffects(client); await started;
  const second = scope.pollEffects(otherClient); await new Promise(resolve => setImmediate(resolve));
  release(); await Promise.all([first, second]);
  assert.equal(claims, 1); assert.equal((await client.listEffects()).items.length, 0);
  assert.equal(f.ownerA.store.readRunSettlements(source.projectId, { executionLogId: 1 }).items.length, 1);
});

test('a captured owner root takes precedence over the run metadata retained from its previous location', async t => {
  const f = await roots(t), source = await nativeSource(f, f.a, f.ownerA, 'A');
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const client = new RunLifecycleClient((operation, input) => f.ownerA.ops({ operation, input }), f.a);
  const reference = runStatusReference(f.project, 1), status = await client.readStatus(reference);
  await client.writeStatus(reference, { ...status, globalDataPath: f.b });
  const done = await client.checkpoint(reference, await client.readStatus(reference), {
    action: 'complete', outcome: 'partial', summary: '原根迁入后的完整结果', idempotencyKey: 'retained-location-complete'
  });
  const { scope } = extensionHost(t, f); scope.settings.globalDataPath = f.b; await scope.bindEngine();
  await scope.processStatus(reference, done, f.a);
  const settlements = f.ownerA.store.readRunSettlements(source.projectId, { executionLogId: 1 });
  assert.equal(settlements.items.length, 1);
  assert.match(JSON.stringify(settlements.items[0]), /原根迁入后的完整结果/);
  assert.equal((await client.listEffects()).items.length, 0);
  assert.equal(f.ownerB.store.readProjectJournal(f.ownerB.projectIds.get(f.project)).logs.length, 0);
  assert.ok(scope.dataRequests.every(request => request.operation !== 'claim_run_consumer' || request.root === f.a));
});

test('pending deliveries in another root continue while the previous root poll is waiting', async t => {
  const f = await roots(t), { getAgentRunDeliveryOwner } = require('../out/agentRunPreparation.js');
  for (const [label, root, owner] of [['A', f.a, f.ownerA], ['B', f.b, f.ownerB]]) {
    const source = await nativeSource(f, root, owner, label);
    await owner.ops({ operation: 'release_run_delivery', input: { projectId: source.projectId, executionLogId: 1, generation: source.generation,
      owner: await getAgentRunDeliveryOwner(), error: 'creating window released before delivery', idempotencyKey: `queued-delivery:${label}` } });
    assert.equal(owner.store.listRunDeliveries({}).items.length, 1);
  }
  const { scope, deliveries } = extensionHost(t, f); await scope.bindEngine();
  let releaseA, enteredA, held = false, timer;
  const gate = new Promise(resolve => { releaseA = resolve; }), started = new Promise(resolve => { enteredA = resolve; });
  scope.requestHook = async (root, request) => {
    if (root === f.a && request.operation === 'list_run_deliveries' && !held) { held = true; enteredA(); await gate; }
  };
  const flightA = scope.pollRuns(scope.context); await started;
  const repeatedA = scope.pollRuns(scope.context); await new Promise(resolve => setImmediate(resolve));
  assert.equal(scope.dataRequests.filter(request => request.root === f.a && request.operation === 'list_run_deliveries').length, 1);
  let flightB;
  try {
    scope.settings = { ...scope.settings, globalDataPath: f.b }; await scope.bindEngine();
    flightB = scope.pollRuns(scope.context);
    const result = await Promise.race([flightB.then(() => 'B completed'), new Promise(resolve => { timer = setTimeout(() => resolve('B blocked'), 2000); })]);
    assert.equal(result, 'B completed');
    assert.equal(deliveries.length, 1); assert.equal(deliveries[0].globalDataPath, f.b);
  } finally { clearTimeout(timer); releaseA(); await Promise.all([flightA, repeatedA, flightB]); }
  assert.deepEqual(deliveries.map(item => item.globalDataPath), [f.b, f.a]);
});

test('a restored queued delivery uses its physical owner in preparation and the final runner command', async t => {
  const f = await roots(t), { getAgentRunDeliveryOwner } = require('../out/agentRunPreparation.js');
  const a = await nativeSource(f, f.b, f.ownerA, 'restored A'), b = await nativeSource(f, f.b, f.ownerB, 'old B');
  await f.ownerA.ops({ operation: 'release_run_delivery', input: { projectId: a.projectId, executionLogId: 1, generation: a.generation,
    owner: await getAgentRunDeliveryOwner(), error: 'source window closed', idempotencyKey: 'restored-delivery-release' } });
  assert.equal(f.ownerA.store.listRunDeliveries({}).items.length, 1);
  const document = f.ownerA.store.readRunDocument(a.projectId, 1, 'launch_request');
  const bRevision = f.ownerB.store.readRunState(b.projectId, 1).revision;
  const { scope, deliveries } = extensionHost(t, f); await scope.bindEngine();
  await scope.pollRuns(scope.context);
  assert.equal(deliveries.length, 1, 'a queued task must resume from the owner that listed it');
  assert.equal(deliveries[0].globalDataPath, f.a);
  const { shellQuote } = require('../out/agentCli.js');
  assert.ok(deliveries[0].command.includes(`--global-data-path ${shellQuote(f.a)}`));
  assert.ok(!deliveries[0].command.includes(`--global-data-path ${shellQuote(f.b)}`));
  assert.equal(f.ownerA.store.readRunState(a.projectId, 1).runId, a.runId);
  assert.equal(f.ownerB.store.readRunState(b.projectId, 1).revision, bRevision);
  assert.deepEqual(f.ownerA.store.readRunDocument(a.projectId, 1, 'launch_request'), document, 'original launch intent remains unchanged');
});

test('a restored queued effect executes in its claiming owner despite a retained old payload root', async t => {
  const f = await roots(t), { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const { getAgentRunDeliveryOwner } = require('../out/agentRunPreparation.js');
  const a = await nativeSource(f, f.a, f.ownerA, 'restored effect A'), b = await nativeSource(f, f.b, f.ownerB, 'old effect B');
  const client = new RunLifecycleClient((operation, input) => f.ownerA.ops({ operation, input }), f.a), reference = runStatusReference(f.project, 1);
  const done = await client.checkpoint(reference, await client.readStatus(reference), { action: 'complete', outcome: 'partial', summary: '恢复后的结果', idempotencyKey: 'restored-effect-complete' });
  const lease = await client.claimConsumer(reference, done, await getAgentRunDeliveryOwner());
  await client.commitSettlement(reference, done, lease, { journal: { agentCli: 'claude', command: 'original', output: '完整来源 A', status: 'In Progress' },
    digest: { schemaVersion: 2, runId: '__solo__:1', nodeId: '__solo__', executionLogId: 1 },
    effects: [{ kind: 'refresh', payload: { workspaceRoot: f.project, nodeId: '__solo__', executionLogId: 1, originalExecutionLogId: 1, globalDataPath: f.b } }], idempotencyKey: 'restored-effect-settle' });
  const bRevision = f.ownerB.store.readRunState(b.projectId, 1).revision;
  const { scope } = extensionHost(t, f); await scope.bindEngine();
  await scope.pollEffects(client);
  assert.equal((await client.listEffects()).items.length, 0);
  assert.ok(scope.dataRequests.some(request => request.root === f.a && request.operation === 'read_run_state'));
  assert.ok(!scope.dataRequests.some(request => request.root === f.b), 'retained payload paths cannot route execution to another owner');
  assert.equal(f.ownerB.store.readRunState(b.projectId, 1).revision, bRevision);
  assert.equal(f.ownerA.store.readRunState(a.projectId, 1).runId, a.runId);
});

for (const restored of [false, true]) test(`closing a terminal that executed its final runner stops its own first claimed generation${restored ? ' after restoring from an old root' : ''}`, async t => {
  const { spawn } = require('node:child_process'), { once } = require('node:events');
  const { prepareAgentRun, getAgentRunDeliveryOwner } = require('../out/agentRunPreparation.js');
  const { shellQuote } = require('../out/agentCli.js');
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const f = await roots(t);
  ensureRollbackGitFixture(f.project);
  const cliDir = path.join(path.dirname(f.project), 'fake-cli'); fs.mkdirSync(cliDir);
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cliDir;
  t.after(() => {
    if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
  });
  const cli = path.join(cliDir, 'claude'); fs.writeFileSync(cli, '#!/bin/sh\nprintf -- "--session-id\\n"\n', { mode: 0o755 });
  const b = await nativeSource(f, f.b, f.ownerB, 'other owner', { agentCli: cli, metadata: { agentDatabaseConfigPath: path.join(cliDir, '.claude.json') } });
  const prepared = await prepareAgentRun({ agentCli: cli, selectedModel: '', prompt: '保持运行直到关闭终端', workspaceRoot: f.project,
    nodeId: '__solo__', executionLogId: 1, userMessage: '原始用户目标', runKind: 'solo', globalDataPath: restored ? f.b : f.a, taskPermissionMode: 'auto',
    directExecutionCommand: `${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write('OWN_TERMINAL_READY\\n');setInterval(()=>{},1000)")}`,
    metadata: { agentDatabaseConfigPath: path.join(cliDir, '.claude.json') } }, (operation, input) => f.ownerA.ops({ operation, input }));
  const bRevision = f.ownerB.store.readRunState(b.projectId, 1).revision;
  const { scope, vscode } = extensionHost(t, f, { stubRuntimeHealth: true }); await scope.bindEngine();
  let child, closed; const stderr = [];
  const client = new RunLifecycleClient((operation, input) => f.ownerA.ops({ operation, input }), f.a), reference = runStatusReference(f.project, 1);
  f.beforeClose.unshift(async () => {
    const state = await client.readStatus(reference);
    if (!state.interactiveSessionClosed) await client.stop(reference, state, '结束本轮测试运行', 'executed-terminal-test-cleanup');
    if (closed) await closed;
  });
  const createTerminal = vscode.window.createTerminal;
  vscode.window.createTerminal = options => {
    const terminal = createTerminal(options);
    terminal.sendText = text => {
      terminal.commands.push(text);
      if (!text.includes('runAgentProcess')) return;
      assert.ok(text.includes(`--global-data-path ${shellQuote(f.a)}`), 'the final command must use the owned fixture before any process starts');
      assert.equal(child, undefined);
      child = spawn('bash', ['-c', text], { cwd: f.project, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      closed = once(child, 'close'); child.stdout.resume(); child.stderr.on('data', bytes => stderr.push(bytes));
    };
    return terminal;
  };
  const originalLaunch = f.ownerA.store.readRunDocument(prepared.projectId, 1, 'launch_request');
  let terminal;
  if (restored) {
    await f.ownerA.ops({ operation: 'release_run_delivery', input: { projectId: prepared.projectId, executionLogId: 1, generation: prepared.generation,
      owner: await getAgentRunDeliveryOwner(), error: 'old source window closed', idempotencyKey: 'actual-restored-release' } });
    assert.equal(f.ownerA.store.listRunDeliveries({}).items.length, 1);
    scope.useActualLaunch(); await scope.pollRuns(scope.context);
    assert.equal(vscode.window.terminals.length, 1, 'the recovered task reaches the actual final launcher');
    assert.ok(child, 'the recovered source launches its own actual runner');
    terminal = vscode.window.terminals[0];
  } else {
    terminal = await scope.launchTerminal({ workspaceRoot: f.project, label: 'solo', conversationId: 1, nodeId: '__solo__',
      statusFilePath: reference, runKind: 'solo', globalDataPath: f.a, command: prepared.finalCommand, context: scope.context, agentCli: cli });
  }
  const deadline = Date.now() + 10000;
  while (!Buffer.from(f.ownerA.store.readRunLog(prepared.projectId, { executionLogId: 1, stream: 'stdout', offset: 0, limit: 65536 }).bytes, 'base64').includes(Buffer.from('OWN_TERMINAL_READY'))) {
    assert.equal(child.exitCode, null, Buffer.concat(stderr).toString());
    assert.ok(Date.now() < deadline, 'the actual packaged runner must reach its child');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const running = f.ownerA.store.readRunState(prepared.projectId, 1);
  assert.equal(running.generation, prepared.generation + 1);
  assert.ok(Number(running.status.agentPid) > 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cliDir, '.claude.json'), 'utf8')).mcpServers.solomap_data.args.at(-1), f.a);
  scope.settings = { ...scope.settings, globalDataPath: f.b }; await scope.bindEngine();
  assert.equal(await scope.closeTerminal(terminal), true, 'the normal first runner claim still belongs to this terminal');
  await closed;
  assert.equal(f.ownerA.store.readRunState(prepared.projectId, 1).status.interactiveSessionClosed, true);
  assert.equal(f.ownerB.store.readRunState(b.projectId, 1).revision, bRevision);
  const settlements = f.ownerA.store.readRunSettlements(prepared.projectId, { executionLogId: 1 }).items;
  assert.equal(settlements.length, 2);
  assert.match(JSON.stringify(settlements), /Interactive session state: Closed/);
  assert.deepEqual(f.ownerA.store.readRunDocument(prepared.projectId, 1, 'launch_request'), originalLaunch);
  assert.equal(fs.existsSync(path.join(f.project, '.solopreneur', 'agent-runs')), false);
});

for (const entry of ['resume', 'prepare', 'review', 'review-revision']) test(`ordinary ${entry} retry preserves the current owner while retaining the original launch intent`, async t => {
  const f = await roots(t), { prepareAgentRun } = require('../out/agentRunPreparation.js');
  const input = { agentCli: 'claude', selectedModel: 'original-model', prompt: '完整原始意图', workspaceRoot: f.project,
    nodeId: '__solo__', executionLogId: 0, userMessage: '原任务重试', runKind: 'solo', globalDataPath: f.b,
    taskPermissionMode: 'auto', launchIntentId: `restored-ordinary-${entry}`,
    metadata: { reviewerCliPath: '', collaborationReviewMode: 'high_risk' }, ...(entry === 'review' ? { readOnlyReview: true } : {}) };
  const a = await prepareAgentRun(input, (operation, input) => f.ownerA.ops({ operation, input }));
  const b = await prepareAgentRun(input, (operation, input) => f.ownerB.ops({ operation, input }));
  const id = Number(a.status.rootExecutionLogId), original = f.ownerA.store.readRunDocument(a.projectId, id, 'launch_request');
  const bBefore = f.ownerB.store.readRunState(b.projectId, Number(b.status.rootExecutionLogId));
  const { scope, deliveries } = extensionHost(t, f); await scope.bindEngine();
  if (entry === 'resume') await scope.resumeOrdinary(scope.context, f.project, input.launchIntentId, f.a);
  else if (entry === 'review') await scope.startReview({ workspaceRoot: f.project, nodeId: '__solo__', reviewerCli: 'claude', globalDataPath: f.a, launchIntentId: input.launchIntentId });
  else if (entry === 'review-revision') await scope.startReviewRevision({ workspaceRoot: f.project, nodeId: '__solo__', mainAgentCli: 'claude', globalDataPath: f.a, launchIntentId: input.launchIntentId });
  else await scope.deliverOrdinary(scope.context, await scope.prepareOrdinary(scope.context, { ...input, globalDataPath: f.a }));
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0].globalDataPath, f.a);
  const { shellQuote } = require('../out/agentCli.js');
  assert.ok(deliveries[0].command.includes(`--global-data-path ${shellQuote(f.a)}`));
  assert.ok(!deliveries[0].command.includes(`--global-data-path ${shellQuote(f.b)}`));
  assert.deepEqual(f.ownerA.store.readRunDocument(a.projectId, id, 'launch_request'), original);
  assert.deepEqual(f.ownerB.store.readRunState(b.projectId, Number(b.status.rootExecutionLogId)), bBefore);
  assert.ok(!scope.dataRequests.some(request => request.root === f.b));
  assert.equal(fs.existsSync(path.join(f.project, '.solopreneur', 'agent-runs')), false);
});

test('a recovered Flow effect prepares and delivers its next role in the claiming owner after the selected root changes', async t => {
  const f = await roots(t), { createFlowTrace, createFlowLoop } = require('../out/flowStore.js');
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const { getAgentRunDeliveryOwner } = require('../out/agentRunPreparation.js');
  const b = await nativeSource(f, f.b, f.ownerB, 'Flow B');
  const flow = createFlowTrace(f.project, '来源 A 的完整 Flow 目标', { selectedAgentCli: 'claude', selectedModel: 'flow-source-model' });
  flow.loops = [createFlowLoop(flow.goal, 1)];
  const { prepareAgentRun } = require('../out/agentRunPreparation.js');
  const a = await prepareAgentRun({ agentCli: 'claude', selectedModel: 'flow-source-model', prompt: '完整 Planner 输入', workspaceRoot: f.project,
    nodeId: `__flow__::${flow.flowId}::loop-1::planner`, executionLogId: 0, userMessage: flow.goal, runKind: 'flow_planner', globalDataPath: f.a, taskPermissionMode: 'auto',
    flowRole: { flowId: flow.flowId, loopId: 'loop-1', role: 'planner', attempt: 0, initialFlow: flow } }, (operation, input) => f.ownerA.ops({ operation, input }));
  const created = f.ownerA.store.readFlowTrace(a.projectId, flow.flowId);
  const updated = structuredClone(created.flow); updated.loops[0].planner = { ...updated.loops[0].planner, status: 'completed', data: { goal: '来源 A 计划', scope: ['original'], plan: ['实现完整目标'] } };
  await f.ownerA.ops({ operation: 'write_flow_trace', input: { root: f.project, flow: updated, expectedRevision: created.revision, idempotencyKey: 'effect-flow-A' } });
  const decoy = structuredClone(flow); decoy.goal = '其他库 B 目标'; decoy.loops[0].goal = decoy.goal;
  await f.ownerB.ops({ operation: 'write_flow_trace', input: { root: f.project, flow: decoy, expectedRevision: 0, idempotencyKey: 'effect-flow-B' } });
  const bBefore = f.ownerB.store.readFlowTrace(b.projectId, flow.flowId);
  const bRunBefore = f.ownerB.store.readRunState(b.projectId, 1);
  const client = new RunLifecycleClient((operation, input) => f.ownerA.ops({ operation, input }), f.a), reference = runStatusReference(f.project, 1);
  const done = await client.checkpoint(reference, await client.readStatus(reference), { action: 'complete', outcome: 'partial', summary: '推进到 Builder', idempotencyKey: 'effect-flow-checkpoint' });
  const lease = await client.claimConsumer(reference, done, await getAgentRunDeliveryOwner());
  await client.commitSettlement(reference, done, lease, { journal: { agentCli: 'claude', command: 'original', output: '完整角色结果', status: 'In Progress' },
    digest: { schemaVersion: 2, runId: `${a.status.nodeId}:1`, nodeId: a.status.nodeId, executionLogId: 1 },
    effects: [{ kind: 'flow', payload: { workspaceRoot: f.project, nodeId: a.status.nodeId, executionLogId: 1, originalExecutionLogId: 1,
      globalDataPath: f.b, flowId: flow.flowId, nextRole: 'builder', nextLoopIndex: 1 } }], idempotencyKey: 'effect-flow-settlement' });
  const { scope, deliveries } = extensionHost(t, f); scope.settings = { ...scope.settings, globalDataPath: f.b }; await scope.bindEngine();
  await scope.pollEffects(client);
  assert.equal(deliveries.length, 1, 'the actual Flow effect must start its next role');
  assert.equal(deliveries[0].globalDataPath, f.a);
  const { shellQuote } = require('../out/agentCli.js'); assert.ok(deliveries[0].command.includes(`--global-data-path ${shellQuote(f.a)}`));
  const next = f.ownerA.store.readFlowTrace(a.projectId, flow.flowId).flow.loops[0].builder;
  assert.equal(next.executionLogId, deliveries[0].conversationId);
  const plan = f.ownerA.store.readRunExecutionPlan(a.projectId, next.executionLogId);
  assert.match(plan.prompt, /来源 A 的完整 Flow 目标/); assert.match(plan.prompt, /来源 A 计划/);
  assert.equal(plan.status.selectedModel, 'flow-source-model'); assert.equal(plan.status.globalDataPath, f.a);
  assert.deepEqual(f.ownerB.store.readFlowTrace(b.projectId, flow.flowId), bBefore);
  assert.deepEqual(f.ownerB.store.readRunState(b.projectId, 1), bRunBefore);
  const ownerRequests = scope.dataRequests.filter(request => !['read_project_journal', 'register_project'].includes(request.operation));
  assert.ok(!ownerRequests.some(request => request.root === f.b && ['prepare_flow_role', 'read_run_state', 'read_learning_context', 'context'].includes(request.operation)));
  assert.equal((await client.listEffects()).items.length, 0); const count = deliveries.length; await scope.pollEffects(client); assert.equal(deliveries.length, count);
  assert.equal(fs.existsSync(path.join(f.project, '.solopreneur', 'agent-runs')), false);
});

for (const entry of ['resume', 'prepare', 'review', 'review-revision']) test(`ordinary ${entry} retry returns the already claimed task without another delivery`, async t => {
  const f = await roots(t), { prepareAgentRun } = require('../out/agentRunPreparation.js');
  const input = { agentCli: 'claude', selectedModel: '', prompt: '完整已投递任务', workspaceRoot: f.project, nodeId: '__solo__',
    executionLogId: 0, userMessage: '重复同一意图', runKind: 'solo', globalDataPath: f.a, taskPermissionMode: 'auto',
    launchIntentId: `claimed-ordinary-${entry}`, metadata: { reviewerCliPath: '', collaborationReviewMode: 'high_risk' },
    ...(entry === 'review' ? { readOnlyReview: true } : {}) };
  const a = await prepareAgentRun(input, (operation, input) => f.ownerA.ops({ operation, input }));
  const id = Number(a.status.rootExecutionLogId);
  await f.ownerA.ops({ operation: 'claim_run', input: { projectId: a.projectId, executionLogId: id, expectedRevision: a.revision, idempotencyKey: `actual-claim-${entry}` } });
  const before = f.ownerA.store.readRunState(a.projectId, id); assert.equal(before.status.deliveryPending, false);
  const { scope, deliveries } = extensionHost(t, f); await scope.bindEngine();
  await assert.doesNotReject(async () => {
    if (entry === 'resume') assert.equal(await scope.resumeOrdinary(scope.context, f.project, input.launchIntentId, f.a), id);
    else if (entry === 'prepare') assert.equal(await scope.deliverOrdinary(scope.context, await scope.prepareOrdinary(scope.context, input)), id);
    else if (entry === 'review') await scope.startReview({ workspaceRoot: f.project, nodeId: '__solo__', reviewerCli: 'claude', globalDataPath: f.a, launchIntentId: input.launchIntentId });
    else await scope.startReviewRevision({ workspaceRoot: f.project, nodeId: '__solo__', mainAgentCli: 'claude', globalDataPath: f.a, launchIntentId: input.launchIntentId });
  });
  assert.equal(deliveries.length, 0); assert.deepEqual(f.ownerA.store.readRunState(a.projectId, id), before);
  assert.equal(f.ownerA.store.readProjectJournal(a.projectId).logs.length, 1);
});

for (const completed of [false, true]) for (const changed of ['moved', 'replaced']) test(`accepted Codex intent retry preserves its durable result when transcript is ${changed}${completed ? ' after completion' : ''}`, async t => {
  const f = await roots(t), { prepareAgentRun, resumePreparedAgentRun } = require('../out/agentRunPreparation.js');
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const call = (operation, input) => f.ownerA.ops({ operation, input });
  const home = path.join(path.dirname(f.project), 'source-codex-home'), transcript = path.join(home, 'sessions', 'source.jsonl');
  const sessionId = '019ecd99-4325-7050-8e71-7def92359d23';
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: f.project } }) + '\n');
  const input = { agentCli: 'codex', selectedModel: '', prompt: '完整已接受 Codex 任务🌿', workspaceRoot: f.project, nodeId: '__solo__',
    executionLogId: 0, userMessage: '重试原意图', runKind: 'solo', globalDataPath: f.b, taskPermissionMode: 'auto',
    launchIntentId: `accepted-codex-${completed}-${changed}`, nativeSessionId: sessionId, continuation: true,
    metadata: { codexResumeTranscriptPath: transcript, nativeResumeProviderContext: { codex: { codexHome: home } },
      reviewerCliPath: '', collaborationReviewMode: 'high_risk' } };
  const prepared = await prepareAgentRun(input, call), id = Number(prepared.status.rootExecutionLogId);
  await call('claim_run', { projectId: prepared.projectId, executionLogId: id, expectedRevision: prepared.revision, idempotencyKey: 'actual-codex-claim' });
  if (completed) {
    const client = new RunLifecycleClient(call), reference = runStatusReference(f.project, id);
    await client.checkpoint(reference, await client.readStatus(reference), { action: 'complete', outcome: 'partial', summary: '持久结果', idempotencyKey: 'completed-codex-intent' });
  }
  const before = f.ownerA.store.readRunState(prepared.projectId, id), binding = f.ownerA.store.readRunBinding(prepared.projectId, id);
  const document = await call('read_run_document', { projectId: prepared.projectId, executionLogId: id, purpose: 'launch_request' });
  assert.equal(before.status.deliveryPending, false); assert.equal(binding.revisions.at(-1).state, 'confirmed');
  if (changed === 'moved') fs.renameSync(transcript, transcript + '.retained');
  else fs.writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: '019ecd99-4325-7050-8e71-7def92359d99', cwd: f.project } }) + '\n');
  const replay = await resumePreparedAgentRun(before, call, f.a);
  assert.deepEqual(replay.status, before.status); assert.equal(replay.dataRoot, f.a);
  const { shellQuote } = require('../out/agentCli.js'); assert.ok(replay.finalCommand.includes(`--global-data-path ${shellQuote(f.a)}`));
  const { scope, deliveries } = extensionHost(t, f); await scope.bindEngine();
  assert.equal(await scope.deliverOrdinary(scope.context, await scope.prepareOrdinary(scope.context, { ...input, globalDataPath: f.a })), id);
  assert.equal(deliveries.length, 0); assert.deepEqual(f.ownerA.store.readRunState(prepared.projectId, id), before);
  assert.deepEqual(f.ownerA.store.readRunBinding(prepared.projectId, id), binding);
  assert.deepEqual(await call('read_run_document', { projectId: prepared.projectId, executionLogId: id, purpose: 'launch_request' }), document);
  assert.equal(f.ownerA.store.readProjectJournal(prepared.projectId).logs.length, 1);
  assert.equal(fs.existsSync(path.join(f.project, '.solopreneur', 'agent-runs')), false);
});

for (const changed of ['moved', 'replaced']) test(`pending Codex delivery still rejects a ${changed} transcript`, async t => {
  const f = await roots(t), { prepareAgentRun, resumePreparedAgentRun } = require('../out/agentRunPreparation.js');
  const call = (operation, input) => f.ownerA.ops({ operation, input });
  const transcript = path.join(path.dirname(f.project), 'pending-codex.jsonl'), sessionId = '019ecd99-4325-7050-8e71-7def92359d23';
  fs.writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: f.project } }) + '\n');
  const state = await prepareAgentRun({ agentCli: 'codex', selectedModel: '', prompt: '仍待执行', workspaceRoot: f.project, nodeId: '__solo__',
    executionLogId: 0, userMessage: '必须核验身份', runKind: 'solo', globalDataPath: f.a, taskPermissionMode: 'auto',
    launchIntentId: `pending-codex-${changed}`, nativeSessionId: sessionId, continuation: true, metadata: { codexResumeTranscriptPath: transcript } }, call);
  assert.equal(state.status.deliveryPending, true);
  if (changed === 'moved') fs.renameSync(transcript, transcript + '.retained');
  else fs.writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: '019ecd99-4325-7050-8e71-7def92359d99', cwd: f.project } }) + '\n');
  await assert.rejects(resumePreparedAgentRun(state, call, f.a), changed === 'moved' ? /ENOENT|identity_transcript_unavailable/ : /identity_transcript_mismatch/);
  assert.equal(f.ownerA.store.readRunState(state.projectId, Number(state.status.rootExecutionLogId)).status.deliveryPending, true);
  assert.equal(f.ownerA.store.readProjectJournal(state.projectId).logs.length, 1);
});

test('the compiled report Continue action resumes a migrated historical task after its old files are isolated', async t => {
  const f = await roots(t), { registerLearningTask, writeLearningJson } = require('./fixtures/legacy-task-report.cjs');
  const { createSessionBindingValue, appendSessionBindingValue } = require('../out/sessionIdentity.js');
  const { importAgentRuns } = require('../out/projectDataMigration.js'), { prepareAgentRun } = require('../out/agentRunPreparation.js');
  const startedAt = '2026-09-01T10:00:00.000Z', endedAt = '2026-09-01T10:01:00.000Z', nonce = 'historical-source-nonce';
  const runDir = path.join(f.project, '.solopreneur', 'agent-runs', '__solo__', '71'), sessionId = require('node:crypto').randomUUID();
  const taskId = registerLearningTask(f.project, { executionLogId: 71, runDir, userMessage: '原历史任务完整目标', startedAt });
  let binding = createSessionBindingValue({ runId: '71', provider: 'claude', workspaceRoot: f.project, cliPath: 'claude', bindingNonce: nonce, method: 'caller_assigned', contract: 'official_stable', createdAt: startedAt });
  binding = appendSessionBindingValue(binding, 1, { sessionId, method: 'caller_assigned', contract: 'official_stable', state: 'planned', createdAt: startedAt });
  binding = appendSessionBindingValue(binding, 2, { sessionId, method: 'caller_assigned', contract: 'official_stable', state: 'confirmed', createdAt: endedAt, confirmedAt: endedAt, evidence: { source: 'official_native_observation' } });
  fs.mkdirSync(runDir, { recursive: true });
  for (const [name, body] of Object.entries({ 'session.json': JSON.stringify(binding), 'prompt.txt': '原完整提示词', 'command.txt': 'claude original', 'output.log': '原完整日志', 'started_at': startedAt })) fs.writeFileSync(path.join(runDir, name), body);
  writeLearningJson(path.join(runDir, 'task-report-1.json'), { schemaVersion: 1, projectPath: f.project, taskId, executionLogId: 71, turnId: '1:complete', createdAt: endedAt, report: { summary: '历史来源完整报告' } });
  const statuses = path.join(f.project, '.solopreneur', 'agent-status');
  writeLearningJson(path.join(statuses, '71.json'), { workspaceRoot: f.project, nodeId: '__solo__', rootExecutionLogId: 71, executionLogId: 71, learningTaskId: taskId, runKind: 'solo', agentCli: 'claude', selectedModel: 'historical-model', globalDataPath: f.a, status: 'Waiting', interactiveSession: true, startedAt, finishedAt: endedAt, checkpointSequence: 1, checkpointOutcome: 'partial', checkpointSummary: '历史结果', bindingNonce: nonce, sessionProvider: 'claude', sessionBindingHeadRevision: 3, nativeSessionId: sessionId, nativeSessionIdIsCurrent: true });
  const projectId = f.ownerA.projectIds.get(f.project);
  f.ownerA.store.importProjectJournal(projectId, { id: 71, nodeId: '__solo__', timestamp: startedAt, agentCli: 'claude', command: 'claude original', output: '原项目日志完整内容', status: 'Waiting' });
  assert.deepEqual((await importAgentRuns(f.ownerA.store, path.dirname(path.dirname(runDir)), { projectRoot: f.project })).conflicts, []);
  const source = f.ownerA.store.readRunState(projectId, 71);
  const decoy = await prepareAgentRun({ agentCli: 'claude', selectedModel: '', prompt: '独立对照任务', workspaceRoot: f.project, nodeId: '__solo__', executionLogId: 71, userMessage: '不应修改的对照目标', runKind: 'solo', globalDataPath: f.b, taskPermissionMode: 'auto' }, (operation, input) => f.ownerB.ops({ operation, input }));
  const beforeB = f.ownerB.store.readRunState(decoy.projectId, 71), csv = fs.readFileSync(path.join(f.project, '.solopreneur', 'roadmap.csv'));
  fs.renameSync(path.join(f.project, '.solopreneur', 'agent-runs'), path.join(path.dirname(f.project), 'retained-historical-runs'));
  fs.renameSync(statuses, path.join(path.dirname(f.project), 'retained-historical-statuses'));
  const { scope, vscode, deliveries, messages, failures } = extensionHost(t, f); await scope.bindEngine();
  vscode.window.showInputBox = async () => { scope.settings = { ...scope.settings, globalDataPath: f.b }; await scope.bindEngine(); return '继续历史任务'; };
  await scope.dispatchGrowth({ command: 'growth.reportAction', projectPath: f.project, taskId, executionLogId: 71, turnId: source.turnId, kind: 'continue', actionId: 'continue-migrated-history' });
  assert.equal(deliveries.length, 1, JSON.stringify({ messages, failures })); assert.equal(deliveries[0].globalDataPath, f.a);
  const next = f.ownerA.store.readRunExecutionPlan(projectId, deliveries[0].conversationId);
  assert.equal(next.taskId, source.taskId); assert.equal(next.conversationId, source.conversationId); assert.equal(next.status.learningTaskId, taskId);
  assert.equal(next.status.plannedNativeSessionId, sessionId); assert.equal(next.status.sourceParentTurnId, source.turnId);
  assert.match(next.prompt, /历史来源完整报告/); assert.ok(next.prompt.includes(`SoloMap-Task: ${taskId}`));
  assert.deepEqual(f.ownerB.store.readRunState(decoy.projectId, 71), beforeB); assert.deepEqual(fs.readFileSync(path.join(f.project, '.solopreneur', 'roadmap.csv')), csv);
  assert.equal(fs.existsSync(path.join(f.project, '.solopreneur', 'agent-runs')), false); assert.equal(fs.existsSync(statuses), false);
});
