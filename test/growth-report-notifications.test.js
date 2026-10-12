const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { openAnalysisOwner } = require('./analysis-fixture.js');
const { sendRuntimeDataRequest } = require('../out/autonomousRuntimeControl.js');

async function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-report-notification-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  return { ...await openAnalysisOwner(t, root, [{ path: project }]), root, project };
}

test('the real growth panel observes native reports without watching retired report files', async t => {
  const f = await fixture(t); const changed = [];
  const compiled = fs.readFileSync(path.resolve(__dirname, '../out/extension.js'), 'utf8');
  const start = compiled.indexOf('async function refreshProjectGrowthPanel(');
  const end = compiled.indexOf('    const project = getProjects(context)', start);
  assert.ok(start > 0 && end > start);
  const scope = { context: { subscriptions: [] }, projectPath: f.project, activeProjectGrowthPanel: { visible: true, webview: { postMessage: m => changed.push(m) } },
    activeProjectGrowthPath: f.project, projectGrowthLoadSequence: 0, growthReportWatchPath: '', growthReportWatcher: null,
    getPersistedSettings: () => ({ globalDataPath: f.root }), normalizeGlobalDataPathForExtension: x => x,
    vscode: { workspace: { createFileSystemWatcher: () => assert.fail('ordinary native reports must not watch retired directories') }, RelativePattern: class {} },
    setTimeout, console };
  const observer = path.resolve(__dirname, '../out/growthReportObserver.js');
  if (fs.existsSync(observer)) scope.growthReportObserver_js_1 = require(observer);
  await new vm.Script(compiled.slice(start, end) + '\n}\nrefreshProjectGrowthPanel(context,projectPath)') .runInNewContext(scope);
  t.after(() => scope.growthReportWatcher?.dispose());
  await scope.growthReportWatcher.ready;
  const projectId = f.projectIds.get(f.project);
  const registration = await f.store.registerProject({ root: f.project });
  const run = f.store.prepareRun(projectId, registration.locationId, { root: f.project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '需求', command: 'codex', userMessage: '开始', idempotencyKey: 'notification-run' });
  f.store.submitRunReport(projectId, { executionLogId: 1, generation: run.generation, turnId: run.turnId, report: { summary: '刚提交的新汇报' }, availability: 'available', idempotencyKey: 'notification-report' });
  for (let attempt = 0; attempt < 40 && !changed.length; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(changed.length, 1);
  assert.equal(changed[0].command, 'growth.reportsChanged'); assert.equal(changed[0].projectPath, f.project);
  assert.equal(fs.existsSync(path.join(f.project, '.solopreneur/agent-runs')), false);
});

test('a stale GitHub scan in another process preserves the newer cursor and both discoveries', async t => {
  const f = await fixture(t), taskId = 'task-native-cursor', newer = 'b'.repeat(40), older = 'a'.repeat(40);
  const input = { projectPath: f.project, globalDataPath: f.root, repository: 'owner/repo', tasks: [{ taskId, startedAt: '2026-09-01' }], reports: [] };
  const script = `const {collectGithubEvidence}=require(${JSON.stringify(path.resolve(__dirname, '../out/learningReview.js'))});
    const input=JSON.parse(process.argv[1]),sha='a'.repeat(40);
    let first=true;const api=async endpoint=>{if(endpoint.includes('/commits?')){if(!first)return [];first=false;process.stdout.write('ready\\n');await new Promise(resolve=>process.stdin.once('data',resolve));return Array.from({length:100},()=>({sha,commit:{message:'fix: retained\\n\\nSoloMap-Task: task-native-cursor'}}));}
      if(endpoint.includes('/check-runs?'))return {check_runs:[]};if(endpoint.includes('/status?'))return {sha,statuses:[]};return {sha,commit:{message:'fix'},files:[]};};
    collectGithubEvidence({...input,api}).then(()=>{process.stdin.destroy();process.stdout.write('done\\n');},e=>{console.error(e);process.exitCode=1;process.stdin.destroy();});`;
  const child = spawn(process.execPath, ['-e', script, JSON.stringify(input)], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await closed; });
  for (let attempt = 0; attempt < 100 && !output.includes('ready\n'); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(output.includes('ready\n'), errors);
  await require('../out/learningReview.js').collectGithubEvidence({ ...input, api: async endpoint => {
    if (endpoint.includes('/commits?')) return [{ sha: newer, commit: { message: `fix: current\n\nSoloMap-Task: ${taskId}` } }];
    if (endpoint.includes('/check-runs?')) return { check_runs: [] };
    if (endpoint.includes('/status?')) return { sha: newer, statuses: [] };
    return { sha: newer, commit: { message: 'fix' }, files: [] };
  } });
  child.stdin.write('continue\n'); const [code] = await closed; assert.equal(code, 0, errors);
  const key = `github-cursor:owner/repo:${require('../out/learningReview.js').reviewHash(taskId)}`;
  const cursor = f.store.readGrowthReportProjection(f.projectIds.get(f.project), key)[0].value;
  assert.equal(cursor.coveredHead, newer, 'a late older scan cannot replace the newer committed boundary');
  assert.deepEqual(Object.keys(cursor.discovered).sort(), [older, newer].sort(), 'neither window may lose a discovered commit');
  assert.equal(fs.existsSync(path.join(f.project, '.solopreneur/agent-runs')), false);
});

test('native projection cursor CAS rejects stale writes and unchanged retries do not grow WAL', async t => {
  const f = await fixture(t), key = 'github-cursor:owner/repo:scope';
  const write = updates => sendRuntimeDataRequest(f.root, { operation: 'write_growth_report_projection', input: { root: f.project, updates } });
  await write([{ key, value: { page: 2 }, expectedRevision: 0 }]);
  const row = f.store.readGrowthReportProjection(f.projectIds.get(f.project), key)[0];
  assert.equal(row.revision, 1);
  const wal = path.join(f.root, 'solomap.db-wal'), before = fs.statSync(wal).size;
  await write([{ key, value: { page: 2 }, expectedRevision: row.revision }]);
  assert.equal(fs.statSync(wal).size, before, 'unchanged cursor content must not write the authority again');
  await assert.rejects(write([{ key, value: { page: 1 }, expectedRevision: 0 }]), /revision_conflict/);
  assert.equal(f.store.readGrowthReportProjection(f.projectIds.get(f.project), key)[0].value.page, 2);
});

test('a disposed observer cannot notify after its pending native read completes', async t => {
  const f = await fixture(t);
  const changed = [], { observeGrowthReports } = require('../out/growthReportObserver.js');
  const observer = observeGrowthReports(f.root, f.project, () => changed.push(true));
  observer.dispose(); await observer.ready;
  assert.equal(changed.length, 0);
  let laterReads = 0; f.store.reportSourceRevision = () => { laterReads++; return 1; };
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(laterReads, 0, 'disposal must cancel reconnects and subsequent polling');
});

test('unchanged native observation reads no bodies and resumes after the owner endpoint restarts', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-report-observer-restart-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const closers = [], after = { after: close => closers.push(close) };
  let owner = await openAnalysisOwner(after, root, [{ path: project }]);
  t.after(async () => { for (const close of closers.reverse()) await close(); });
  const { observeGrowthReports } = require('../out/growthReportObserver.js'); const changes = [];
  const observer = observeGrowthReports(root, project, () => changes.push(true)); t.after(() => observer.dispose());
  await observer.ready;
  let decoded = 0; const decode = owner.store.decodedContent.bind(owner.store);
  owner.store.decodedContent = (...args) => { decoded++; return decode(...args); };
  const wal = path.join(root, 'solomap.db-wal'), bytes = fs.statSync(wal).size;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(changes.length, 0); assert.equal(decoded, 0); assert.equal(fs.statSync(wal).size, bytes);
  await closers.pop()();
  // Leave one failed poll between owners; the observer must reconnect without old discovery files.
  await new Promise(resolve => setTimeout(resolve, 1100));
  owner = await openAnalysisOwner(after, root, [{ path: project }]);
  const projectId = owner.projectIds.get(project);
  owner.store.writeGithubFacts(projectId, { repository: 'owner/repo', expectedRevision: 0, facts: { commits: [] }, summary: { commits: [] } });
  for (let attempt = 0; attempt < 40 && !changes.length; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(changes.length, 1);
});

test('a hidden panel suspends database polling and catches committed changes when visible again', async t => {
  const f = await fixture(t), { observeGrowthReports } = require('../out/growthReportObserver.js');
  let visible = true, reads = 0; const changes = [];
  const observer = observeGrowthReports(f.root, f.project, () => changes.push(true), () => visible);
  t.after(() => observer.dispose()); await observer.ready; visible = false;
  const read = f.store.reportSourceRevision.bind(f.store);
  f.store.reportSourceRevision = (...args) => { reads++; return read(...args); };
  f.store.writeGithubFacts(f.projectIds.get(f.project), { repository: 'owner/repo', expectedRevision: 0, facts: { commits: [] }, summary: { commits: [] } });
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(reads, 0, 'hidden panels must not keep reading the authority'); assert.equal(changes.length, 0);
  visible = true;
  for (let attempt = 0; attempt < 40 && !changes.length; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(changes.length, 1);
});

test('the first successful observation after connection failure refreshes an already loaded page', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-report-first-connect-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const changes = [], { observeGrowthReports } = require('../out/growthReportObserver.js');
  const observer = observeGrowthReports(root, project, () => changes.push(true)); t.after(() => observer.dispose());
  await observer.ready;
  const owner = await openAnalysisOwner(t, root, [{ path: project }]);
  // A page can load successfully before the observer's next reconnect.
  owner.store.writeGithubFacts(owner.projectIds.get(project), { repository: 'owner/repo', expectedRevision: 0, facts: { commits: [] }, summary: { commits: [] } });
  for (let attempt = 0; attempt < 40 && !changes.length; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(changes.length, 1, 'the first recovered generation cannot be silently swallowed');
});

function growthSettingsScope(context, initialSettings, changed) {
  const compiled = fs.readFileSync(path.resolve(__dirname, '../out/extension.js'), 'utf8');
  const start = compiled.indexOf('async function refreshProjectGrowthPanel('), end = compiled.indexOf('async function handleOpenStrategyPyramid(', start);
  const settingsStart = compiled.indexOf('async function updatePersistedSettings('), settingsEnd = compiled.indexOf('async function syncCognitiveRuntimeConfig(', settingsStart);
  const nativeProjections = new Map();
  const scope = { context, path, setTimeout, console, crypto: require('node:crypto'), currentSettings: initialSettings,
    activeProjectGrowthPanel: { visible: true, webview: { postMessage: m => changed.push(m), html: '' } }, activeProjectGrowthPath: '',
    projectGrowthLoadSequence: 0, growthReportWatchPath: '', growthReportWatcher: null,
    persistedSettingsWriteQueue: Promise.resolve(), pendingPersistedSettings: null, persistedSettingsCache: null,
    persistedGlobalDataPathWrite: undefined,
    databaseSettingsByRoot: new Map(), databaseSettingKeys: [], nativeConfigurationKeys: ['globalDataPath'],
    nativeConfigurationProjectionValues: new Map(),
    syncEngine: null, syncEngineInitPromise: null,
    getPersistedSettings: () => scope.pendingPersistedSettings || scope.currentSettings,
    normalizeGlobalDataPathForExtension: value => value, getProjects: () => [], isSoloMapLanguageZh: () => true,
    getProjectGrowthPanelCopy: () => ({}), getProjectGrowthWebviewHtml: (_w, _c, value) => value.marker,
    postLocalDataLoad: require('../out/localDataLoader.js').postLocalDataLoad,
    getProjectGrowthView: async (_project, _extension, options) => ({ snapshotId: 'native', marker: options.globalDataPath }),
    growthReportObserver_js_1: require('../out/growthReportObserver.js'),
    mergeAgentModelPreferences: (old, patch) => ({ ...old, ...patch }), normalizeOpenCodeProvider: x => x || '',
    normalizeCollaborationReviewMode: x => x || 'high_risk', mergeAutomationSettings: (old, patch) => ({ ...old, ...patch }), normalizeAutomationSettings: x => x || {},
    getEnabledEnhancementMap: () => ({}), getSettingsEnhancementWorkspaceRoot: () => '', normalizeProAccountStatus: x => x,
    invalidatePersistedSettingsCache: () => {}, syncCognitiveRuntimeConfig: () => {}, synchronizeTelegramChannel: () => {},
    persistExtensionSettingsToDatabase: async () => {}, refreshExtensionSettingsFromDatabase: async () => {},
    recordNativeConfigurationProjection: async (root, key, value) => {
      const id = `fixture-projection-${nativeProjections.size + 1}`;
      nativeProjections.set(id, { root, key, value: JSON.stringify(value) }); return id;
    },
    consumeNativeConfigurationProjection: async (root, key, value) => {
      const match = [...nativeProjections].find(([, item]) => item.root === root && item.key === key && item.value === JSON.stringify(value));
      if (!match) return false; nativeProjections.delete(match[0]); return true;
    },
    supersedeNativeConfigurationProjections: async (root, key, keep) => {
      for (const [id, item] of nativeProjections) if (id !== keep && item.root === root && item.key === key) nativeProjections.delete(id);
    },
    cancelNativeConfigurationProjection: async (_root, id) => { nativeProjections.delete(id); },
    refreshSettingsAfterConfigurationChange: async () => {},
    cognitiveRuntimeConfig_1: { persistCognitiveRuntimeConfig: async () => {} }, activateObservedBackgroundRuntime: async () => {},
    autonomousRuntimeHost_1: { ensureHealthyAutonomousRuntime: async () => ({ started: false }) },
    settingsKey: 'settings', vscode: { ConfigurationTarget: { Global: 1 }, workspace: { getConfiguration: () => ({ get: () => undefined, update: async () => {} }) }, window: { showInformationMessage: () => {} } }
  };
  scope.localDataLoader_1 = { postLocalDataLoad: scope.postLocalDataLoad };
  scope.projectGrowth_1 = { getProjectGrowthView: (...args) => scope.getProjectGrowthView(...args) };
  scope.projectGrowthWebview_1 = { getProjectGrowthWebviewHtml: scope.getProjectGrowthWebviewHtml };
  scope.agentModelSelection_1 = { mergeAgentModelPreferences: scope.mergeAgentModelPreferences };
  scope.openCodeAdapter_1 = { normalizeOpenCodeProvider: scope.normalizeOpenCodeProvider, updateOpenCodeApiKey: async () => {} };
  scope.proAccount_1 = { normalizeProAccountStatus: scope.normalizeProAccountStatus };
  scope.solomapGlobal_1 = { getEnabledEnhancementMap: scope.getEnabledEnhancementMap };
  scope.cognitiveRuntimeConfig_2 = scope.cognitiveRuntimeConfig_1;
  const vmContext = vm.createContext(scope);
  vm.runInContext(compiled.slice(start, end) + '\n' + compiled.slice(settingsStart, settingsEnd), vmContext);
  const handlerStart = compiled.indexOf("'settings.update': async (request) => {"), handlerEnd = compiled.indexOf("'telegram.unbind':", handlerStart);
  scope.updateOpenCodeApiKey = async () => {}; scope.getSettingsWithOpenCodeSecretState = async () => scope.getPersistedSettings(); scope.respond = async () => {}; scope.broadcastSettings = async () => {};
  vm.runInContext('settingsUpdate = ({' + compiled.slice(handlerStart, handlerEnd) + '})["settings.update"];', vmContext);
  const listenerStart = compiled.indexOf("if (typeof vscode.workspace.onDidChangeConfiguration === 'function')"), listenerEnd = compiled.indexOf('context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider', listenerStart);
  scope.listenForConfigurationChanges = () => vm.runInContext(compiled.slice(listenerStart, listenerEnd), vmContext);
  return scope;
}

test('saving a data root rebinds an open report panel and rejects the old pending load', async t => {
  const f = await fixture(t), newRoot = path.join(path.dirname(f.root), 'new-data-root');
  const newer = await openAnalysisOwner(t, newRoot, [{ path: f.project }]);
  const changes = []; let scope;
  const context = { subscriptions: [], secrets: {}, extensionPath: path.resolve(__dirname, '..'), globalState: { update: async (_key, value) => { scope.currentSettings = value; } } };
  scope = growthSettingsScope(context, { globalDataPath: f.root }, changes);
  t.after(() => scope.growthReportWatcher?.dispose());
  let finishOld;
  const load = scope.getProjectGrowthView;
  scope.getProjectGrowthView = (_project, _extension, options) => options.globalDataPath === f.root
    ? new Promise(resolve => { finishOld = resolve; }) : load(_project, _extension, options);
  const oldLoad = scope.refreshProjectGrowthPanel(context, f.project); await scope.growthReportWatcher.ready;
  let oldReads = 0; const oldRead = f.store.reportSourceRevision.bind(f.store);
  f.store.reportSourceRevision = (...args) => { oldReads++; return oldRead(...args); };
  await scope.settingsUpdate({ globalDataPath: newRoot });
  await scope.growthReportWatcher.ready;
  finishOld({ snapshotId: 'old', marker: 'stale previous root' }); await oldLoad;
  newer.store.writeGithubFacts(newer.projectIds.get(f.project), { repository: 'owner/repo', expectedRevision: 0, facts: { commits: [] }, summary: { commits: [] } });
  for (let attempt = 0; attempt < 40 && !changes.length; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(scope.activeProjectGrowthPanel.webview.html, newRoot, 'the previous root cannot overwrite the new page');
  assert.equal(changes.length, 1, 'the newly selected database must drive notifications');
  assert.equal(oldReads, 0, 'the previous database must no longer be polled');
});

test('an external data-root configuration change rebinds an already open report panel', async t => {
  const f = await fixture(t), newRoot = path.join(path.dirname(f.root), 'external-data-root');
  const newer = await openAnalysisOwner(t, newRoot, [{ path: f.project }]); const changes = [];
  let scope;
  const context = { subscriptions: [], extensionPath: path.resolve(__dirname, '..'), globalState: { update: async (_key, value) => { scope.currentSettings = value; } } };
  scope = growthSettingsScope(context, { globalDataPath: f.root }, changes); t.after(() => scope.growthReportWatcher?.dispose());
  await scope.refreshProjectGrowthPanel(context, f.project); await scope.growthReportWatcher.ready;
  let configChanged;
  scope.vscode.workspace.onDidChangeConfiguration = listener => { configChanged = listener; return { dispose() {} }; };
  scope.vscode.workspace.getConfiguration = () => ({ get: key => key === 'globalDataPath' ? newRoot : undefined, update: async () => {} });
  scope.listenForConfigurationChanges();
  configChanged({ affectsConfiguration: section => section === 'solopreneur' || section === 'solopreneur.globalDataPath' });
  await new Promise(resolve => setImmediate(resolve));
  await scope.growthReportWatcher.ready;
  newer.store.writeGithubFacts(newer.projectIds.get(f.project), { repository: 'owner/repo', expectedRevision: 0, facts: { commits: [] }, summary: { commits: [] } });
  for (let attempt = 0; attempt < 40 && !changes.length; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(scope.activeProjectGrowthPanel.webview.html, newRoot);
  assert.equal(changes.length, 1);
});

for (const deferredEvent of [false, true]) {
  test(`overlapping root saves preserve the latest choice with ${deferredEvent ? 'deferred' : 'synchronous'} configuration echoes`, async t => {
    const f = await fixture(t), newRoot = path.join(path.dirname(f.root), 'latest-root');
    await openAnalysisOwner(t, newRoot, [{ path: f.project }]);
    let scope, releaseFirstSave, listener, configuredRoot = f.root, writes = 0;
    const firstSave = new Promise(resolve => { releaseFirstSave = resolve; });
    let saves = 0; const runtimeRoots = [], failures = [];
    const context = { subscriptions: [], extensionPath: path.resolve(__dirname, '..'), globalState: {
      update: async (_key, value) => { if (++saves === 1) await firstSave; scope.currentSettings = value; }
    } };
    scope = growthSettingsScope(context, { globalDataPath: f.root }, []);
    scope.console = { ...console, error: (...args) => failures.push(args) };
    scope.activateObservedBackgroundRuntime = async (_extension, root) => { runtimeRoots.push(root); };
    t.after(() => scope.growthReportWatcher?.dispose());
    scope.vscode.workspace.onDidChangeConfiguration = callback => { listener = callback; return { dispose() {} }; };
    const event = { affectsConfiguration: section => section === 'solopreneur' || section === 'solopreneur.globalDataPath' };
    scope.vscode.workspace.getConfiguration = () => ({ get: key => key === 'globalDataPath' ? configuredRoot : undefined,
      update: async (key, value) => {
        if (key !== 'globalDataPath') return;
        configuredRoot = value;
        // Bound a broken feedback loop in the host so the assertion can report it.
        if (++writes > 12) throw new Error('configuration feedback did not settle');
        if (deferredEvent) setImmediate(() => listener(event)); else listener(event);
      }
    });
    scope.listenForConfigurationChanges();
    await scope.refreshProjectGrowthPanel(context, f.project);
    const intermediate = scope.updatePersistedSettings(context, { globalDataPath: path.join(path.dirname(f.root), 'intermediate-root') });
    const latest = scope.updatePersistedSettings(context, { globalDataPath: newRoot });
    releaseFirstSave(); await Promise.all([intermediate, latest]);
    for (let i = 0; i < 20; i++) { await scope.persistedSettingsWriteQueue.catch(() => {}); await new Promise(resolve => setImmediate(resolve)); }
    assert.ok(writes <= 2, `two choices caused ${writes} configuration writes`);
    assert.equal(configuredRoot, newRoot); assert.equal(scope.getPersistedSettings().globalDataPath, newRoot);
    assert.equal(scope.activeProjectGrowthPanel.webview.html, newRoot);
    assert.equal(runtimeRoots.at(-1), newRoot); assert.deepEqual(failures, []);
  });
}

test('a real external root change during an owned save remains the newest intent', async t => {
  const f = await fixture(t), externalRoot = path.join(path.dirname(f.root), 'external-latest-root');
  await openAnalysisOwner(t, externalRoot, [{ path: f.project }]);
  let scope, listener, releaseWrite, configuredRoot = f.root, rootWrites = 0;
  const delayedWrite = new Promise(resolve => { releaseWrite = resolve; });
  const context = { subscriptions: [], extensionPath: path.resolve(__dirname, '..'), globalState: { update: async (_key, value) => { scope.currentSettings = value; } } };
  scope = growthSettingsScope(context, { globalDataPath: f.root }, []); t.after(() => scope.growthReportWatcher?.dispose());
  const event = { affectsConfiguration: section => section === 'solopreneur' || section === 'solopreneur.globalDataPath' };
  scope.vscode.workspace.onDidChangeConfiguration = callback => { listener = callback; return { dispose() {} }; };
  scope.vscode.workspace.getConfiguration = () => ({ get: key => key === 'globalDataPath' ? configuredRoot : undefined,
    update: async (key, value) => {
      if (key !== 'globalDataPath') return;
      configuredRoot = value; listener(event);
      if (++rootWrites === 1) await delayedWrite;
    }
  });
  scope.listenForConfigurationChanges(); await scope.refreshProjectGrowthPanel(context, f.project);
  const saving = scope.updatePersistedSettings(context, { globalDataPath: path.join(path.dirname(f.root), 'owned-root') });
  while (!rootWrites) await new Promise(resolve => setImmediate(resolve));
  configuredRoot = externalRoot; listener(event); releaseWrite(); await saving;
  await scope.persistedSettingsWriteQueue;
  assert.equal(configuredRoot, externalRoot); assert.equal(scope.getPersistedSettings().globalDataPath, externalRoot);
  assert.equal(scope.activeProjectGrowthPanel.webview.html, externalRoot);
});

test('an external return to the last owned root supersedes a queued external selection', async t => {
  const f = await fixture(t), a = path.join(path.dirname(f.root), 'last-owned-root'), b = path.join(path.dirname(f.root), 'external-root');
  await openAnalysisOwner(t, a, [{ path: f.project }]); await openAnalysisOwner(t, b, [{ path: f.project }]);
  let scope, listener, configuredRoot = f.root, releaseB, beganB;
  const gate = new Promise(resolve => { releaseB = resolve; }), started = new Promise(resolve => { beganB = resolve; });
  const context = { subscriptions: [], extensionPath: path.resolve(__dirname, '..'), globalState: {
    update: async (_key, value) => { if (value.globalDataPath === b) { beganB(); await gate; } scope.currentSettings = value; }
  } };
  scope = growthSettingsScope(context, { globalDataPath: f.root }, []); t.after(() => scope.growthReportWatcher?.dispose());
  const event = { affectsConfiguration: section => section === 'solopreneur' || section === 'solopreneur.globalDataPath' };
  scope.vscode.workspace.onDidChangeConfiguration = callback => { listener = callback; return { dispose() {} }; };
  scope.vscode.workspace.getConfiguration = () => ({ get: key => key === 'globalDataPath' ? configuredRoot : undefined,
    update: async (key, value) => { if (key === 'globalDataPath') { configuredRoot = value; listener(event); } }
  });
  scope.listenForConfigurationChanges(); await scope.refreshProjectGrowthPanel(context, f.project);
  await scope.updatePersistedSettings(context, { globalDataPath: a });
  configuredRoot = b; listener(event); await started;
  configuredRoot = a; listener(event); releaseB();
  for (let i = 0; i < 10; i++) { await scope.persistedSettingsWriteQueue; await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(configuredRoot, a); assert.equal(scope.getPersistedSettings().globalDataPath, a);
  assert.equal(scope.activeProjectGrowthPanel.webview.html, a);
});

for (const writeCompleted of [false, true]) {
  test(`an old owned configuration echo cannot replace a newer UI root after write ${writeCompleted ? 'completion' : 'start'}`, async t => {
    const f = await fixture(t), a = path.join(path.dirname(f.root), 'owned-echo-root'), b = path.join(path.dirname(f.root), 'latest-ui-root');
    await openAnalysisOwner(t, a, [{ path: f.project }]); await openAnalysisOwner(t, b, [{ path: f.project }]);
    let scope, listener, configuredRoot = f.root, releaseA, enteredA, releaseB, enteredB, rootWrites = 0;
    const aGate = new Promise(resolve => { releaseA = resolve; }), aStarted = new Promise(resolve => { enteredA = resolve; });
    const bGate = new Promise(resolve => { releaseB = resolve; }), bStarted = new Promise(resolve => { enteredB = resolve; });
    const runtimeRoots = [], failures = [];
    const context = { subscriptions: [], extensionPath: path.resolve(__dirname, '..'), globalState: {
      update: async (_key, value) => { if (value.globalDataPath === b) { enteredB(); await bGate; } scope.currentSettings = value; }
    } };
    scope = growthSettingsScope(context, { globalDataPath: f.root }, []);
    scope.console = { ...console, error: (...args) => failures.push(args) };
    scope.activateObservedBackgroundRuntime = async (_extension, root) => { runtimeRoots.push(root); };
    t.after(() => scope.growthReportWatcher?.dispose());
    t.after(() => { releaseA(); releaseB(); });
    const event = { affectsConfiguration: section => section === 'solopreneur' || section === 'solopreneur.globalDataPath' };
    scope.vscode.workspace.onDidChangeConfiguration = callback => { listener = callback; return { dispose() {} }; };
    scope.vscode.workspace.getConfiguration = () => ({ get: key => key === 'globalDataPath' ? configuredRoot : undefined,
      update: async (key, value) => {
        if (key !== 'globalDataPath') return;
        configuredRoot = value;
        if (++rootWrites === 1) { enteredA(); await aGate; }
        else listener(event);
      }
    });
    scope.listenForConfigurationChanges(); await scope.refreshProjectGrowthPanel(context, f.project);
    const ownSave = scope.updatePersistedSettings(context, { globalDataPath: a }); await aStarted;
    if (writeCompleted) { releaseA(); await ownSave; }
    const latest = scope.updatePersistedSettings(context, { globalDataPath: b });
    if (writeCompleted) await bStarted;
    // A has really been written. Its own notification arrives after the UI selected B.
    listener(event); releaseA(); releaseB(); await Promise.all([ownSave, latest]);
    for (let i = 0; i < 10; i++) { await scope.persistedSettingsWriteQueue; await new Promise(resolve => setImmediate(resolve)); }
    assert.equal(configuredRoot, b); assert.equal(scope.getPersistedSettings().globalDataPath, b);
    assert.equal(scope.activeProjectGrowthPanel.webview.html, b);
    assert.equal(runtimeRoots.at(-1), b); assert.equal(rootWrites, 2); assert.deepEqual(failures, []);
  });
}

test('an external return during the unfinished owned configuration write remains the latest choice', async t => {
  const f = await fixture(t), a = path.join(path.dirname(f.root), 'writing-owned-root'), b = path.join(path.dirname(f.root), 'queued-external-root');
  await openAnalysisOwner(t, a, [{ path: f.project }]); await openAnalysisOwner(t, b, [{ path: f.project }]);
  let scope, listener, configuredRoot = f.root, releaseA, enteredA, writes = 0;
  const gate = new Promise(resolve => { releaseA = resolve; }), started = new Promise(resolve => { enteredA = resolve; });
  const context = { subscriptions: [], extensionPath: path.resolve(__dirname, '..'), globalState: {
    update: async (_key, value) => { scope.currentSettings = value; }
  } };
  scope = growthSettingsScope(context, { globalDataPath: f.root }, []); t.after(() => scope.growthReportWatcher?.dispose());
  const event = { affectsConfiguration: section => section === 'solopreneur' || section === 'solopreneur.globalDataPath' };
  scope.vscode.workspace.onDidChangeConfiguration = callback => { listener = callback; return { dispose() {} }; };
  scope.vscode.workspace.getConfiguration = () => ({ get: key => key === 'globalDataPath' ? configuredRoot : undefined,
    update: async (key, value) => {
      if (key !== 'globalDataPath') return;
      configuredRoot = value; listener(event);
      if (++writes === 1) { enteredA(); await gate; }
    }
  });
  scope.listenForConfigurationChanges(); await scope.refreshProjectGrowthPanel(context, f.project);
  const ownSave = scope.updatePersistedSettings(context, { globalDataPath: a });
  await started;
  configuredRoot = b; listener(event);
  configuredRoot = a; listener(event);
  releaseA(); await ownSave;
  for (let i = 0; i < 10; i++) { await scope.persistedSettingsWriteQueue; await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(configuredRoot, a); assert.equal(scope.getPersistedSettings().globalDataPath, a);
  assert.equal(scope.activeProjectGrowthPanel.webview.html, a);
});
