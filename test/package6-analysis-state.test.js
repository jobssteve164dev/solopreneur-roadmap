const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const childProcess = require('node:child_process');

const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');

function loadExternalSignalInternals() {
  const file = path.resolve(__dirname, '../out/projectExternalSignals.js');
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(`${fs.readFileSync(file, 'utf8')}\nmodule.exports.__beginExternalRefresh = beginExternalRefresh; module.exports.__commitExternalCache = commitExternalCache;`, file);
  return loaded.exports;
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-package6-analysis-'));
  const dataRoot = path.join(root, '.solomap-global');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(path.join(projectRoot, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.solopreneur', 'roadmap.csv'), 'id,title,status\n1,One,Pending\n');
  const store = new UnifiedDataStore(dataRoot);
  const project = await store.registerProject({ root: projectRoot });
  return { root, dataRoot, projectRoot, project, store };
}

function cleanupFixture(value) {
  for (const file of [
    path.join(value.projectRoot, '.solopreneur', 'roadmap.csv'),
    path.join(value.projectRoot, '.solopreneur', 'project.json'),
    path.join(value.dataRoot, 'solomap.db-shm'),
    path.join(value.dataRoot, 'solomap.db-wal'),
    path.join(value.dataRoot, 'solomap.db')
  ]) if (fs.existsSync(file)) fs.unlinkSync(file);
  for (const dir of [path.join(value.projectRoot, '.solopreneur'), value.projectRoot, value.dataRoot, value.root]) if (fs.existsSync(dir)) fs.rmdirSync(dir);
}

test('analysis state is durable, project scoped and compare-and-set', async (t) => {
  const first = await fixture();
  t.after(() => { first.store.close(); cleanupFixture(first); });
  assert.deepEqual(first.store.readAnalysisState(first.project.projectId, 'external', 'issues'), {
    objectId: null,
    revision: 0,
    value: null
  });
  const written = first.store.writeAnalysisState(first.project.projectId, {
    namespace: 'external', key: 'issues', expectedRevision: 0,
    value: { repo: 'owner/repo', issues: [{ number: 7 }] }, idempotencyKey: 'first'
  });
  assert.equal(written.revision, 1);
  assert.throws(() => first.store.writeAnalysisState(first.project.projectId, {
    namespace: 'external', key: 'issues', expectedRevision: 0,
    value: { repo: 'owner/repo', issues: [] }, idempotencyKey: 'stale'
  }), /revision_conflict/);
  first.store.close();
  const reopened = new UnifiedDataStore(first.dataRoot);
  first.store = reopened;
  assert.deepEqual(reopened.readAnalysisState(first.project.projectId, 'external', 'issues').value,
    { repo: 'owner/repo', issues: [{ number: 7 }] });
});

test('usage and conversation revisions come only from unified database rows', async (t) => {
  const first = await fixture();
  t.after(() => { first.store.close(); cleanupFixture(first); });
  const before = first.store.readProjectAnalysisSource(first.project.projectId);
  assert.equal(before.runCount, 0);
  first.store.appendProjectJournal(first.project.projectId, 'journal-1', {
    nodeId: '__solo__', timestamp: '2026-10-11T00:00:00.000Z', agentCli: 'codex', command: 'one', output: 'complete', status: 'Processed'
  });
  first.store.upsertProjectRunIndex(first.project.projectId, {
    executionLogId: 1, nodeId: '__solo__', runKind: 'solo', agentCli: 'codex', status: 'Processed',
    startedAt: '2026-10-11T00:00:00.000Z', finishedAt: '2026-10-11T00:01:00.000Z', durationMs: 60000,
    inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 3, outputPath: ''
  }, [], []);
  const after = first.store.readProjectAnalysisSource(first.project.projectId);
  assert.equal(after.runCount, 1);
  assert.equal(after.latestRunAt, '2026-10-11T00:01:00.000Z');
  assert.notEqual(after.conversationRevision, before.conversationRevision);
  assert.equal(after.recentActivityAt, '2026-10-11T00:01:00.000Z');
});

test('simultaneous usage events with the same timestamp both commit', async (t) => {
  const first = await fixture();
  const operations = createRuntimeDataOperations(first.store);
  const server = await startRuntimeControlServer({ globalDataPath: first.dataRoot, runtimeId: 'package6-usage-owner', onCommand: () => ({ status: 'running' }), onData: operations });
  const originalLoad = Module._load;
  const OriginalDate = global.Date;
  Module._load = function(request, parent, isMain) {
    if (request === 'vscode') return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  global.Date = class FixedDate extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : ['2026-10-12T12:00:00.000Z'])); }
    static now() { return OriginalDate.parse('2026-10-12T12:00:00.000Z'); }
  };
  t.after(async () => {
    global.Date = OriginalDate;
    Module._load = originalLoad;
    await server.close();
    await operations.close();
    first.store.close();
    const runtimeRoot = path.join(first.dataRoot, 'runtime');
    if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
    cleanupFixture(first);
  });
  delete require.cache[require.resolve('../out/localUsageStats.js')];
  const { recordLocalUsageEvent } = require('../out/localUsageStats.js');
  const context = { extension: { packageJSON: { version: '0.0.511' } } };
  const options = { globalDataPath: first.dataRoot, usageStatsFileName: 'unused.json', projects: [{ name: 'Project', path: first.projectRoot }] };

  await Promise.all([
    recordLocalUsageEvent(context, options, 'activation'),
    recordLocalUsageEvent(context, options, 'activation')
  ]);

  assert.equal(first.store.readAnalysisState(null, 'usage', 'local').value.counters.activations, 2);
});

test('remote projections reject late results with identical request timestamps', async (t) => {
  const first = await fixture();
  const operations = createRuntimeDataOperations(first.store);
  const server = await startRuntimeControlServer({ globalDataPath: first.dataRoot, runtimeId: 'package6-external-owner', onCommand: () => ({ status: 'running' }), onData: operations });
  t.after(async () => {
    await server.close();
    await operations.close();
    first.store.close();
    const runtimeRoot = path.join(first.dataRoot, 'runtime');
    if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
    cleanupFixture(first);
  });
  const { __beginExternalRefresh: begin, __commitExternalCache: commit } = loadExternalSignalInternals();
  const latest = { repo: 'owner/repo', marker: 'latest' };
  const late = { repo: 'owner/repo', marker: 'late-old' };
  const oldRequest = await begin(first.dataRoot, first.projectRoot, 'delivery');
  const latestRequest = await begin(first.dataRoot, first.projectRoot, 'delivery');
  oldRequest.requestedAt = latestRequest.requestedAt;
  assert.deepEqual(await commit(first.dataRoot, first.projectRoot, 'delivery', latestRequest, latest), latest);
  assert.deepEqual(await commit(first.dataRoot, first.projectRoot, 'delivery', oldRequest, late), latest);
  assert.equal(first.store.readAnalysisState(first.project.projectId, 'external', 'delivery').revision, 1);

  const sameMillisecondLater = { repo: 'owner/repo', marker: 'same-ms-later' };
  const sameTimeRequest = await begin(first.dataRoot, first.projectRoot, 'delivery');
  sameTimeRequest.requestedAt = latestRequest.requestedAt;
  assert.deepEqual(await commit(first.dataRoot, first.projectRoot, 'delivery', sameTimeRequest, sameMillisecondLater), sameMillisecondLater);
  const state = first.store.readAnalysisState(first.project.projectId, 'external', 'delivery');
  assert.equal(state.revision, 2);
  assert.equal(state.value.cache.marker, 'same-ms-later');

  const superseded = await begin(first.dataRoot, first.projectRoot, 'security');
  await begin(first.dataRoot, first.projectRoot, 'security');
  await assert.rejects(commit(first.dataRoot, first.projectRoot, 'security', superseded, { repo: 'owner/repo', marker: 'never-committed' }), /external_refresh_superseded/);
  assert.equal(first.store.readAnalysisState(first.project.projectId, 'external', 'security').value, null);
});

test('growth refresh generation rejects inverse completion and preserves one newest snapshot', async (t) => {
  const first = await fixture();
  t.after(() => { first.store.close(); cleanupFixture(first); });
  const snapshot = (id, label) => ({
    snapshot: { id, projectPath: first.projectRoot, createdAt: '2026-10-12T12:00:00.000Z', gitHead: '', scanReason: label, status: 'completed', durationMs: 1, error: '' },
    nodes: [{ snapshotId: id, nodeId: 'directory:.', parentId: '', kind: 'directory', path: '.', label, language: '', bytes: 1, loc: 1, fileCount: 1, testFileCount: 0, generated: false, excluded: false, primaryRole: 'root', confidence: 1 }],
    edges: [], signals: [], labels: []
  });
  const older = first.store.reserveProjectGrowthRefresh(first.project.projectId, 'older');
  const newer = first.store.reserveProjectGrowthRefresh(first.project.projectId, 'newer');
  assert.equal(first.store.commitProjectGrowthRefresh(first.project.projectId, { ...newer, data: snapshot('newer', 'newer') }).accepted, true);
  assert.equal(first.store.commitProjectGrowthRefresh(first.project.projectId, { ...older, data: snapshot('older', 'older') }).accepted, false);
  const state = first.store.readProjectGrowth(first.project.projectId, 12);
  assert.equal(state.latest.snapshot.scanReason, 'newer');
  assert.equal(state.history.length, 1);
});

test('sidebar source revision covers command output links and indexed run payloads and rejects stale publication', async (t) => {
  const first = await fixture();
  const operations = createRuntimeDataOperations(first.store);
  t.after(async () => { await operations.close(); first.store.close(); cleanupFixture(first); });
  const initial = first.store.readProjectAnalysisSource(first.project.projectId).conversationRevision;
  const journal = first.store.appendProjectJournal(first.project.projectId, 'full-journal', {
    nodeId: '__solo__', timestamp: '2026-10-12T12:00:00.000Z', agentCli: 'codex', command: 'codex exec', output: 'complete output', status: 'Processed'
  });
  const journalRevision = first.store.readProjectAnalysisSource(first.project.projectId).conversationRevision;
  assert.notEqual(journalRevision, initial);
  first.store.linkProjectJournal(first.project.projectId, journal.executionLogId, 'step-linked', '2026-10-12T12:00:30.000Z');
  const linkedRevision = first.store.readProjectAnalysisSource(first.project.projectId).conversationRevision;
  assert.notEqual(linkedRevision, journalRevision);
  assert.equal(first.store.readProjectJournal(first.project.projectId, { nodeId: 'step-linked' }).logs[0].status, 'Linked');
  first.store.upsertProjectRunIndex(first.project.projectId, {
    executionLogId: 1, nodeId: '__solo__', runKind: 'solo', agentCli: 'codex', status: 'Processed', startedAt: '2026-10-12T12:00:00.000Z', finishedAt: '2026-10-12T12:01:00.000Z', durationMs: 60000
  }, [{ filePath: 'src/a.ts', role: 'changed' }], [{ type: 'verification', value: 'passed', source: 'agent' }]);
  const indexedRevision = first.store.readProjectAnalysisSource(first.project.projectId).conversationRevision;
  assert.notEqual(indexedRevision, linkedRevision);
  const run = await operations({ operation: 'prepare_run', input: {
    root: first.projectRoot, executionLogId: 2, nodeId: '__solo__', runKind: 'solo', prompt: '完整任务', command: 'codex', userMessage: '交付结果', status: 'Running', idempotencyKey: 'package6-source-run'
  } });
  const preparedRevision = first.store.readProjectAnalysisSource(first.project.projectId).conversationRevision;
  assert.notEqual(preparedRevision, indexedRevision);
  first.store.writeRunDocument(first.project.projectId, {
    executionLogId: 2, generation: run.generation, turnId: run.turnId, purpose: `native_reply_${run.turnId.replace(/-/g, '')}`,
    bytes: Buffer.from('原生最终回复').toString('base64'), mimeType: 'text/plain', expectedRevision: 0, idempotencyKey: 'package6-native-reply'
  });
  const replyRevision = first.store.readProjectAnalysisSource(first.project.projectId).conversationRevision;
  assert.notEqual(replyRevision, preparedRevision);
  const completed = await operations({ operation: 'checkpoint_run', input: {
    projectId: run.projectId, executionLogId: 2, generation: run.generation, proof: run.proof,
    expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'partial', summary: '轮次总结', idempotencyKey: 'package6-source-complete'
  } });
  const completedRevision = first.store.readProjectAnalysisSource(first.project.projectId).conversationRevision;
  assert.notEqual(completedRevision, replyRevision);
  assert.equal(first.store.readProjectJournal(first.project.projectId, { executionLogId: 2 }).logs[0].dataState.conclusion, '原生最终回复');
  assert.ok(completed.revision > run.revision);
  assert.throws(() => first.store.writeAnalysisState(first.project.projectId, {
    namespace: 'sidebar', key: 'conversation', expectedRevision: 0, expectedSourceRevision: initial,
    value: { sourceRevision: initial, snapshot: { solo: [], project: [], flow: [], revision: [] } }, idempotencyKey: 'stale-sidebar'
  }), /analysis_source_conflict/);
  assert.equal(first.store.readAnalysisState(first.project.projectId, 'sidebar', 'conversation').value, null);
});

test('sidebar provider drops an old data-root conversation after switching roots', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-package6-root-switch-'));
  const projectRoot = path.join(base, 'project');
  fs.mkdirSync(path.join(projectRoot, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.solopreneur', 'roadmap.csv'), 'id,title,status\n1,One,Pending\n');
  const rootParents = [path.join(base, 'root-a'), path.join(base, 'root-b')];
  const roots = rootParents.map(parent => path.join(parent, '.solomap-global'));
  const owners = [];
  for (const [index, dataRoot] of roots.entries()) {
    const store = new UnifiedDataStore(dataRoot); await store.registerProject({ root: projectRoot });
    const operations = createRuntimeDataOperations(store);
    const server = await startRuntimeControlServer({ globalDataPath: dataRoot, runtimeId: `root-switch-${index}`, onCommand: () => ({ status: 'running' }), onData: operations });
    owners.push({ store, operations, server, dataRoot });
  }
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'vscode') return { commands: { executeCommand() {} }, window: { showErrorMessage() {}, showInformationMessage() {} } };
    return originalLoad.call(this, request, parent, isMain);
  };
  let activeRoot = roots[0];
  const deferred = () => {
    let resolve; let started;
    return { promise: new Promise(done => { resolve = done; }), started: new Promise(done => { started = done; }), resolve, markStarted: started };
  };
  const old = { snapshot: deferred(), solo: deferred(), step: deferred(), project: deferred() };
  const posted = [];
  t.after(async () => {
    Module._load = originalLoad;
    for (const owner of owners) { await owner.server.close(); await owner.operations.close(); owner.store.close(); }
    for (const owner of owners) {
      for (const file of ['solomap.db-shm', 'solomap.db-wal', 'solomap.db']) { const target = path.join(owner.dataRoot, file); if (fs.existsSync(target)) fs.unlinkSync(target); }
      const runtimeRoot = path.join(owner.dataRoot, 'runtime'); if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
      fs.rmdirSync(owner.dataRoot);
    }
    for (const parent of rootParents) fs.rmdirSync(parent);
    for (const file of [path.join(projectRoot, '.solopreneur', 'roadmap.csv'), path.join(projectRoot, '.solopreneur', 'project.json')]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(path.join(projectRoot, '.solopreneur')); fs.rmdirSync(projectRoot); fs.rmdirSync(base);
  });
  delete require.cache[require.resolve('../out/sidebarProvider.js')];
  const { SolopreneurSidebarProvider } = require('../out/sidebarProvider.js');
  Module._load = originalLoad;
  const provider = new SolopreneurSidebarProvider({ fsPath: path.resolve(__dirname, '..') }, {}, {
    getSettings: () => ({ globalDataPath: activeRoot }), updateSettings: async () => {},
    getProjects: () => ({ projects: [{ name: 'Project', path: projectRoot }], selectedProjectPath: projectRoot }),
    getSoloConversationHistory: async () => {
      if (activeRoot === roots[0]) { old.solo.markStarted(); return old.solo.promise; }
      return [{ id: 12, nodeId: '__solo__', status: 'New' }];
    },
    getStepConversationHistory: async () => {
      if (activeRoot === roots[0]) { old.step.markStarted(); return old.step.promise; }
      return [{ id: 13, nodeId: 'step-1', status: 'New' }];
    },
    getProjectConversationHistory: async () => {
      if (activeRoot === roots[0]) { old.project.markStarted(); return old.project.promise; }
      return [{ id: 14, nodeId: 'step-1', status: 'New' }];
    },
    getProjectConversationSnapshot: async () => {
      if (activeRoot === roots[0]) { old.snapshot.markStarted(); return old.snapshot.promise; }
      return { solo: [{ id: 2, nodeId: '__solo__', status: 'New' }], project: [], flow: [], revision: [] };
    }
  });
  provider._view = { webview: { postMessage: message => { posted.push(message); return Promise.resolve(true); } } };
  const firstLoads = [
    provider.sendProjectConversationSnapshot(projectRoot, true, true),
    provider.sendSoloConversationHistory(projectRoot),
    provider.sendStepConversationHistory(projectRoot, 'step-1'),
    provider.sendProjectConversationHistory(projectRoot)
  ];
  await Promise.all(Object.values(old).map(value => value.started));
  activeRoot = roots[1];
  await Promise.all([
    provider.sendProjectConversationSnapshot(projectRoot, true, true),
    provider.sendSoloConversationHistory(projectRoot),
    provider.sendStepConversationHistory(projectRoot, 'step-1'),
    provider.sendProjectConversationHistory(projectRoot)
  ]);
  old.snapshot.resolve({ solo: [{ id: 1, nodeId: '__solo__', status: 'Old' }], project: [], flow: [], revision: [] });
  old.solo.resolve([{ id: 3, nodeId: '__solo__', status: 'Old' }]);
  old.step.resolve([{ id: 4, nodeId: 'step-1', status: 'Old' }]);
  old.project.resolve([{ id: 5, nodeId: 'step-1', status: 'Old' }]);
  await Promise.all(firstLoads);
  const snapshots = posted.filter(message => message.command === 'sidebarProjectConversationSnapshotLoaded');
  assert.deepEqual(snapshots.map(message => message.soloConversations[0].status), ['New']);
  assert.deepEqual(posted.filter(message => message.command === 'sidebarSoloConversationLoaded').map(message => message.conversations[0].status), ['New']);
  assert.deepEqual(posted.filter(message => message.command === 'sidebarStepConversationLoaded').map(message => message.conversations[0].status), ['New']);
  assert.deepEqual(posted.filter(message => message.command === 'sidebarProjectConversationLoaded').map(message => message.conversations[0].status), ['New']);
});

test('repository changes cannot reuse a cached projection from the previous origin', async (t) => {
  const first = await fixture();
  const operations = createRuntimeDataOperations(first.store);
  const server = await startRuntimeControlServer({ globalDataPath: first.dataRoot, runtimeId: 'package6-repo-switch', onCommand: () => ({ status: 'running' }), onData: operations });
  const originalSpawnSync = childProcess.spawnSync;
  const originalPath = process.env.PATH;
  let repo = 'owner/old';
  childProcess.spawnSync = (command, args, options) => command === 'git'
    ? { status: 0, stdout: `https://github.com/${repo}.git\n`, stderr: '' }
    : originalSpawnSync(command, args, options);
  process.env.PATH = '';
  t.after(async () => {
    childProcess.spawnSync = originalSpawnSync;
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await server.close(); await operations.close(); first.store.close();
    const runtimeRoot = path.join(first.dataRoot, 'runtime'); if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
    cleanupFixture(first);
  });
  first.store.writeAnalysisState(first.project.projectId, {
    namespace: 'external', key: 'delivery', expectedRevision: 0,
    value: { requestedAt: 1, cache: { schemaVersion: 1, repo, syncedAt: '2026-10-12T10:00:00.000Z', latestRelease: { tagName: 'v-old', name: 'Old', publishedAt: '', url: '' }, workflowRuns: [] } }, idempotencyKey: 'old-repo-cache'
  });
  const signals = require('../out/projectExternalSignals.js');
  assert.equal((await signals.loadExternalDeliverySummary(first.projectRoot, { globalDataPath: first.dataRoot })).latestRelease, 'v-old');
  repo = 'owner/new';
  const changed = await signals.loadExternalDeliverySummary(first.projectRoot, { globalDataPath: first.dataRoot });
  assert.equal(changed.repo, 'owner/new');
  assert.equal(changed.latestRelease, '');
});

test('Agent prompt delivery and security context reuse committed remote projections while disconnected', async (t) => {
  const first = await fixture();
  const operations = createRuntimeDataOperations(first.store);
  const server = await startRuntimeControlServer({ globalDataPath: first.dataRoot, runtimeId: 'package6-signal-owner', onCommand: () => ({ status: 'running' }), onData: operations });
  const originalSpawnSync = childProcess.spawnSync;
  const originalPath = process.env.PATH;
  t.after(async () => {
    childProcess.spawnSync = originalSpawnSync;
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await server.close();
    await operations.close();
    first.store.close();
    const runtimeRoot = path.join(first.dataRoot, 'runtime');
    if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
    cleanupFixture(first);
  });
  const write = (key, value, idempotencyKey) => first.store.writeAnalysisState(first.project.projectId, {
    namespace: 'external', key, expectedRevision: 0, value: { requestedAt: 1, cache: value }, idempotencyKey
  });
  write('delivery', {
    schemaVersion: 1, repo: 'owner/repo', syncedAt: '2026-10-12T10:00:00.000Z',
    latestRelease: { tagName: 'v1.2.3', name: 'Release 1.2.3', publishedAt: '2026-10-12T09:00:00.000Z', url: 'https://example.test/release' },
    workflowRuns: [{ name: 'CI', displayTitle: 'Verify', status: 'completed', conclusion: 'success', createdAt: '2026-10-12T08:00:00.000Z', updatedAt: '2026-10-12T08:01:00.000Z', url: 'https://example.test/ci' }]
  }, 'delivery-cache');
  write('security', {
    schemaVersion: 1, repo: 'owner/repo', syncedAt: '2026-10-12T10:00:00.000Z', message: '',
    alerts: [{ source: 'CodeQL', title: 'Unsafe flow', severity: 'high', state: 'open', url: 'https://example.test/security' }]
  }, 'security-cache');
  childProcess.spawnSync = (command, args, options) => command === 'git'
    ? { status: 0, stdout: 'https://github.com/owner/repo.git\n', stderr: '' }
    : originalSpawnSync(command, args, options);
  process.env.PATH = '';
  const signals = require('../out/projectSignals.js');

  const [delivery, security] = await Promise.all([
    signals.buildGithubDeliveryContext(first.projectRoot, first.dataRoot),
    signals.buildGithubSecurityContext(first.projectRoot, first.dataRoot)
  ]);

  assert.match(delivery, /v1\.2\.3/);
  assert.match(delivery, /Verify/);
  assert.match(security, /Unsafe flow/);
  for (const name of ['delivery-cache.json', 'security-cache.json']) assert.equal(fs.existsSync(path.join(first.projectRoot, '.solopreneur', name)), false);
});

test('external data cache isolates identical projects across global data roots', async () => {
  const { loadExternalData } = require('../out/externalDataLoader.js');
  let calls = 0;
  const load = async () => ({ call: ++calls });
  const first = await loadExternalData('package6-root-isolation', '/workspace/project', load, {}, '/data/root-a');
  const second = await loadExternalData('package6-root-isolation', '/workspace/project', load, {}, '/data/root-b');
  assert.equal(first.call, 1);
  assert.equal(second.call, 2);
});

test('same-millisecond growth snapshots receive distinct identities', () => {
  const { buildProjectGrowthSnapshot } = require('../out/projectGrowth.js');
  const now = new Date('2026-10-12T12:00:00.000Z');
  const first = buildProjectGrowthSnapshot(path.resolve(__dirname, '..'), [], [], { now, maxFiles: 1 });
  const second = buildProjectGrowthSnapshot(path.resolve(__dirname, '..'), [], [], { now, maxFiles: 1 });
  assert.notEqual(first.snapshot.id, second.snapshot.id);
});

test('journal importer rejects a source from a different physical project', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-package6-journal-scope-'));
  const dataRoot = path.join(root, '.solomap-global');
  const projectA = path.join(root, 'a');
  const projectB = path.join(root, 'b');
  fs.mkdirSync(projectA);
  const source = path.join(projectB, '.solopreneur', 'project_journal.db');
  const legacy = new (require('../out/db/sqliteStore.js').SqliteStore)(source, path.resolve(__dirname, '..'));
  await legacy.init();
  legacy.close();
  const store = new UnifiedDataStore(dataRoot);
  t.after(() => {
    store.close();
    for (const file of [source, `${source}-wal`, `${source}-shm`, path.join(dataRoot, 'solomap.db-wal'), path.join(dataRoot, 'solomap.db-shm'), path.join(dataRoot, 'solomap.db')]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    for (const dir of [path.dirname(source), projectB, projectA, dataRoot, root]) if (fs.existsSync(dir)) fs.rmdirSync(dir);
  });
  await assert.rejects(
    require('../out/projectDataMigration.js').importProjectJournal(store, source, { projectRoot: projectA }),
    /migration_source_scope_mismatch/
  );
  assert.equal(store.capturedMigrationSources().length, 0);
});

test('growth importer accepts an in-project alias and rejects another physical project', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-package6-growth-scope-'));
  const dataRoot = path.join(root, '.solomap-global');
  const projectA = path.join(root, 'a');
  const projectAlias = path.join(root, 'a-alias');
  const projectB = path.join(root, 'b');
  const sourceA = path.join(projectA, '.solopreneur', 'project_growth.db');
  const sourceB = path.join(projectB, '.solopreneur', 'project_growth.db');
  const { SqliteStore } = require('../out/db/sqliteStore.js');
  for (const source of [sourceA, sourceB]) { const legacy = new SqliteStore(source, path.resolve(__dirname, '..')); await legacy.init(); legacy.close(); }
  fs.symlinkSync(projectA, projectAlias, 'dir');
  const store = new UnifiedDataStore(dataRoot);
  t.after(() => {
    store.close();
    if (fs.existsSync(projectAlias)) fs.unlinkSync(projectAlias);
    for (const file of [sourceA, `${sourceA}-wal`, `${sourceA}-shm`, sourceB, `${sourceB}-wal`, `${sourceB}-shm`, path.join(projectA, '.solopreneur', 'project.json'), path.join(dataRoot, 'solomap.db-wal'), path.join(dataRoot, 'solomap.db-shm'), path.join(dataRoot, 'solomap.db')]) if (fs.existsSync(file)) fs.unlinkSync(file);
    for (const dir of [path.dirname(sourceB), projectB, path.dirname(sourceA), projectA, dataRoot, root]) if (fs.existsSync(dir)) fs.rmdirSync(dir);
  });
  const imported = await require('../out/projectDataMigration.js').importProjectGrowth(store, path.join(projectAlias, '.solopreneur', 'project_growth.db'), { projectRoot: projectAlias });
  assert.equal(imported.conflicts.length, 0);
  await assert.rejects(
    require('../out/projectDataMigration.js').importProjectGrowth(store, sourceB, { projectRoot: projectA }),
    /migration_source_scope_mismatch/
  );
});

test('journal importer reads one immutable WAL snapshot while the live source keeps changing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-package6-journal-wal-'));
  const dataRoot = path.join(root, '.solomap-global');
  const project = path.join(root, 'project');
  const source = path.join(project, '.solopreneur', 'project_journal.db');
  const { SqliteStore } = require('../out/db/sqliteStore.js');
  const initialized = new SqliteStore(source, path.resolve(__dirname, '..')); await initialized.init(); initialized.close();
  const { DatabaseSync } = require('node:sqlite');
  const writer = new DatabaseSync(source);
  const store = new UnifiedDataStore(dataRoot);
  t.after(() => {
    writer.close(); store.close();
    for (const file of [source, `${source}-wal`, `${source}-shm`, path.join(project, '.solopreneur', 'project.json'), path.join(dataRoot, 'solomap.db-wal'), path.join(dataRoot, 'solomap.db-shm'), path.join(dataRoot, 'solomap.db')]) if (fs.existsSync(file)) fs.unlinkSync(file);
    for (const dir of [path.dirname(source), project, dataRoot, root]) if (fs.existsSync(dir)) fs.rmdirSync(dir);
  });
  writer.exec('PRAGMA foreign_keys=OFF; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  const insert = writer.prepare('INSERT INTO execution_logs(nodeId,timestamp,agentCli,command,output,status) VALUES(?,?,?,?,?,?)');
  insert.run('__solo__', '2026-10-12T10:00:00.000Z', 'codex', 'first', 'first committed WAL row', 'Processed');
  assert.equal(fs.existsSync(`${source}-wal`), true);
  let changed = false;
  const beforeSnapshots = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('solomap-migration-snapshot-')));
  const result = await require('../out/projectDataMigration.js').importProjectJournal(store, source, {
    projectRoot: project,
    shouldContinue() {
      if (!changed) {
        changed = true;
        insert.run('__solo__', '2026-10-12T10:01:00.000Z', 'codex', 'second', 'written after backup', 'Processed');
      }
      return true;
    }
  });
  const registered = await store.registerProject({ root: project });
  const history = store.readProjectJournal(registered.projectId, { nodeId: '__solo__' });
  assert.equal(result.imported, 1);
  assert.deepEqual(history.logs.map(row => row.output), ['first committed WAL row']);
  const afterSnapshots = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('solomap-migration-snapshot-') && !beforeSnapshots.has(name));
  assert.deepEqual(afterSnapshots, []);
});

test('growth view cache follows the selected global database root', async (t) => {
  const first = await fixture();
  const second = await fixture();
  const firstOperations = createRuntimeDataOperations(first.store);
  const secondOperations = createRuntimeDataOperations(second.store);
  const entryPath = path.resolve(__dirname, '../out/autonomousRuntimeProcess.js');
  const buildId = require('../out/runtimeBuildIdentity.js').runtimeBuildId(path.resolve(__dirname, '..'));
  const runtime = require('../out/autonomousRuntime.js');
  runtime.claimRuntimeLease(first.dataRoot, { runtimeId: 'package6-growth-root-a', pid: process.pid });
  runtime.claimRuntimeLease(second.dataRoot, { runtimeId: 'package6-growth-root-b', pid: process.pid });
  const firstServer = await startRuntimeControlServer({ globalDataPath: first.dataRoot, runtimeId: 'package6-growth-root-a', entryPath, buildId, owner: 'autonomous-runtime', onCommand: () => ({ status: 'running' }), onData: firstOperations });
  const secondServer = await startRuntimeControlServer({ globalDataPath: second.dataRoot, runtimeId: 'package6-growth-root-b', entryPath, buildId, owner: 'autonomous-runtime', onCommand: () => ({ status: 'running' }), onData: secondOperations });
  const secondProject = await second.store.registerProject({ root: first.projectRoot });
  const snapshot = (id, createdAt, label) => ({
    snapshot: { id, projectPath: first.projectRoot, createdAt, gitHead: '', scanReason: label, status: 'completed', durationMs: 1, error: '' },
    nodes: [{ snapshotId: id, nodeId: 'directory:.', parentId: '', kind: 'directory', path: '.', label, language: '', bytes: 1, loc: 1, fileCount: 1, testFileCount: 0, generated: false, excluded: false, primaryRole: 'root', confidence: 1 }],
    edges: [], signals: [], labels: []
  });
  first.store.writeProjectGrowth(first.project.projectId, snapshot('first', '2026-10-12T10:00:00.000Z', 'root-a'), 'root-a');
  second.store.writeProjectGrowth(secondProject.projectId, snapshot('second', '2026-10-12T11:00:00.000Z', 'root-b'), 'root-b');
  t.after(async () => {
    await firstServer.close(); await secondServer.close();
    await firstOperations.close(); await secondOperations.close();
    first.store.close(); second.store.close();
    for (const value of [second, first]) {
      const runtimeRoot = path.join(value.dataRoot, 'runtime');
      const ownerPath = path.join(runtimeRoot, 'owner.json');
      if (fs.existsSync(ownerPath)) fs.unlinkSync(ownerPath);
      if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
      cleanupFixture(value);
    }
  });
  const growth = require('../out/projectGrowth.js');
  growth.clearProjectGrowthViewCache();
  const fromA = await growth.getProjectGrowthView(first.projectRoot, path.resolve(__dirname, '..'), { globalDataPath: first.dataRoot, refreshIfMissing: false });
  const fromB = await growth.getProjectGrowthView(first.projectRoot, path.resolve(__dirname, '..'), { globalDataPath: second.dataRoot, refreshIfMissing: false });
  assert.equal(fromA.treemap.label, 'root-a');
  assert.equal(fromB.treemap.label, 'root-b');
});
