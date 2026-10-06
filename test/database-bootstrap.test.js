const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { sendRuntimeControlCommand, sendRuntimeDataRequest } = require('../out/autonomousRuntimeControl.js');

function launch(root) {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../out/autonomousRuntimeProcess.js'), '--global-data-path', root], { stdio: 'pipe' });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.stdout.resume();
  return { child, errors: () => stderr };
}
async function ready(run, root) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(root, 'runtime', 'control.json'))) {
    assert.equal(run.child.exitCode, null, run.errors());
    assert.ok(Date.now() < deadline, run.errors() || 'Runtime did not publish readiness');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function stop(run, root) {
  if (run.child.exitCode !== null) return;
  const exited = once(run.child, 'exit');
  try { await sendRuntimeControlCommand(root, 'stop'); }
  catch { run.child.kill(); }
  await exited;
}

test('normal Runtime startup creates the database and automatically imports legacy memory with stable project ownership', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-bootstrap-'));
  const root = path.join(fixture, '.solomap-global');
  const workspace = path.join(fixture, 'alpha');
  fs.mkdirSync(path.join(root, 'memory', 'projects'), { recursive: true });
  fs.mkdirSync(workspace);
  const original = path.join(root, 'memory', 'projects', 'alpha.md');
  fs.writeFileSync(original, 'Alpha original project history');
  fs.writeFileSync(path.join(root, 'memory', 'profile.md'), 'Original global preferences');
  fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify({ schemaVersion: 1, projects: [{ name: 'Alpha', path: workspace }], hiddenProjects: [] }));
  let run = launch(root);
  try {
    await ready(run, root);
    const project = await sendRuntimeDataRequest(root, { operation: 'register_project', input: { root: workspace } });
    const write = await sendRuntimeDataRequest(root, { operation: 'write', input: { kind: 'memory', action: 'create', scope: project.projectId, idempotencyKey: 'daily', data: { category: 'project', title: 'Daily', status: 'active', content: 'instant write' } } });
    assert.equal((await sendRuntimeDataRequest(root, { operation: 'read', input: { ref: write.objectId } })).data.content, 'instant write');
    let migrated;
    const deadline = Date.now() + 10000;
    do {
      migrated = await sendRuntimeDataRequest(root, { operation: 'search', input: { scope: project.projectId, kinds: ['memory'], query: 'alpha' } });
      if (migrated.items.length) break;
      assert.ok(Date.now() < deadline, 'startup must schedule the legacy import automatically');
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (true);
    const imported = await sendRuntimeDataRequest(root, { operation: 'read', input: { ref: migrated.items[0].objectId } });
    assert.equal(imported.data.content, 'Alpha original project history');
    assert.equal(fs.readFileSync(original, 'utf8'), 'Alpha original project history');
    await stop(run, root);
    const { DatabaseSync } = require('node:sqlite');
    let db = new DatabaseSync(path.join(root, 'solomap.db'), { readOnly: true });
    const id = db.prepare("SELECT value FROM database_meta WHERE key='database_id'").get().value;
    const events = db.prepare('SELECT count(*) AS total FROM events').get().total;
    const jobs = db.prepare('SELECT count(*) AS total FROM migration_jobs').get().total;
    db.close();
    run = launch(root);
    await ready(run, root);
    await stop(run, root);
    db = new DatabaseSync(path.join(root, 'solomap.db'), { readOnly: true });
    assert.equal(db.prepare("SELECT value FROM database_meta WHERE key='database_id'").get().value, id);
    assert.equal(db.prepare('SELECT count(*) AS total FROM events').get().total, events, 'unchanged startup must not replay domain mutations');
    assert.equal(db.prepare('SELECT count(*) AS total FROM migration_jobs').get().total, jobs, 'unchanged startup must not create another import job');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    db.close();
  } finally { await stop(run, root); }
});

test('Runtime imports legacy project growth history in the background without removing its source', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-growth-import-'));
  const root = path.join(fixture, '.solomap-global');
  const workspace = path.join(fixture, 'project');
  const legacyPath = path.join(workspace, '.solopreneur', 'project_growth.db');
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify({ schemaVersion: 1, projects: [{ name: 'Project', path: workspace }], hiddenProjects: [] }));
  const { SqliteStore } = require('../out/db/sqliteStore.js');
  const legacy = new SqliteStore(legacyPath, path.resolve(__dirname, '..'));
  await legacy.init();
  for (let index = 0; index < 51; index++) legacy.writeGrowthSnapshot({ snapshot: { id: `legacy-growth-${index}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), projectPath: workspace, gitHead: 'abc', scanReason: 'legacy', status: 'completed', durationMs: 3, error: '' }, nodes: [{ snapshotId: `legacy-growth-${index}`, nodeId: 'directory:.', parentId: '', kind: 'directory', path: '.', label: 'Project', language: '', bytes: 1, loc: 1, fileCount: 1, testFileCount: 0, generated: false, excluded: false, primaryRole: 'root', confidence: 1 }], edges: [], signals: [], labels: [] });
  legacy.close();
  const { DatabaseSync } = require('node:sqlite');
  const oldDatabase = new DatabaseSync(legacyPath);
  oldDatabase.exec('DROP TABLE growth_report_projection');
  oldDatabase.close();
  const sourceHash = require('node:crypto').createHash('sha256').update(fs.readFileSync(legacyPath)).digest('hex');
  let run = launch(root);
  try {
    await ready(run, root);
    const deadline = Date.now() + 30000;
    let state;
    do {
      state = await sendRuntimeDataRequest(root, { operation: 'read_project_growth', input: { root: workspace, historyLimit: 5 } });
      if (state.latest) break;
      assert.ok(Date.now() < deadline, 'legacy growth history must be imported by background startup');
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (true);
    assert.equal(state.latest.snapshot.scanReason, 'legacy');
    assert.equal(state.latest.nodes[0].nodeId, 'directory:.');
    assert.equal(fs.existsSync(legacyPath), true);
    const migrationDeadline = Date.now() + 30000;
    while (true) {
      const audit = new DatabaseSync(path.join(root, 'solomap.db'), { readOnly: true });
      const importedCount = audit.prepare('SELECT count(*) AS total FROM growth_snapshots').get().total;
      audit.close();
      if (importedCount === 51) break;
      assert.ok(Date.now() < migrationDeadline, `legacy growth import stopped at ${importedCount} snapshots`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(legacyPath)).digest('hex'), sourceHash, 'legacy source bytes must stay unchanged');
    await stop(run, root);
    let db = new DatabaseSync(path.join(root, 'solomap.db'), { readOnly: true });
    const before = {
      snapshots: db.prepare('SELECT count(*) AS total FROM growth_snapshots').get().total,
      items: db.prepare('SELECT count(*) AS total FROM growth_items').get().total,
      events: db.prepare('SELECT count(*) AS total FROM events').get().total
    };
    assert.equal(before.snapshots, 51, 'all legacy growth history must migrate');
    db.close();
    run = launch(root); await ready(run, root);
    const replayDeadline = Date.now() + 10000;
    do {
      state = await sendRuntimeDataRequest(root, { operation: 'read_project_growth', input: { root: workspace, historyLimit: 5 } });
      if (state.latest) break;
      assert.ok(Date.now() < replayDeadline);
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (true);
    await stop(run, root);
    db = new DatabaseSync(path.join(root, 'solomap.db'), { readOnly: true });
    assert.deepEqual({
      snapshots: db.prepare('SELECT count(*) AS total FROM growth_snapshots').get().total,
      items: db.prepare('SELECT count(*) AS total FROM growth_items').get().total,
      events: db.prepare('SELECT count(*) AS total FROM events').get().total
    }, before, 'unchanged legacy growth must not be rewritten on restart');
    db.close();
  } finally { await stop(run, root); }
});

test('a previously initialized Runtime refuses to silently replace a missing authority with an empty database', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-bootstrap-loss-')), '.solomap-global');
  fs.mkdirSync(root);
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  new UnifiedDataStore(root).close();
  let run = launch(root);
  try {
    await ready(run, root);
    await stop(run, root);
    fs.renameSync(path.join(root, 'solomap.db'), path.join(root, 'retained-original.db'));
    run = launch(root);
    const exited = once(run.child, 'exit');
    let timer;
    const result = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); })]);
    clearTimeout(timer);
    assert.ok(result, 'a missing initialized authority must fail instead of starting without the data service');
    const [code] = result;
    assert.notEqual(code, 0);
    assert.match(run.errors(), /database_restore_required/);
    assert.equal(fs.existsSync(path.join(root, 'solomap.db')), false);
    assert.equal(fs.existsSync(path.join(root, 'retained-original.db')), true);
  } finally { await stop(run, root); }
});

test('a damaged project registry cannot block global memory import or assign unproven project memory globally', async () => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
  const { enqueueStartupMemoryMigration } = require('../out/runtimeDatabaseBootstrap.js');
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-bootstrap-registry-')), '.solomap-global');
  fs.mkdirSync(path.join(root, 'memory', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory', 'profile.md'), 'global preferences survive');
  fs.writeFileSync(path.join(root, 'memory', 'projects', 'alpha.md'), 'unproven private project history');
  fs.writeFileSync(path.join(root, 'projects.json'), '{damaged');
  const store = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(store);
  try {
    await enqueueStartupMemoryMigration(store, operations, () => true);
    await operations.waitForMigrations();
    const items = store.search({ scope: null, kinds: ['memory'] }).items;
    assert.equal(items.length, 1);
    assert.equal(store.read(items[0].objectId).data.content, 'global preferences survive');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(store.filePath, { readOnly: true });
    assert.equal(db.prepare('SELECT count(*) AS total FROM migration_items').get().total, 2);
    db.close();
  } finally { await operations.close(); store.close(); }
});

test('disabled autonomous work still permits database requests without starting autonomous cycles', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-data-only-')), '.solomap-global');
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime', 'service-disabled'), 'disabled\n');
  const run = launch(root);
  try {
    await ready(run, root);
    assert.equal((await sendRuntimeControlCommand(root, 'health')).status, 'paused');
    const write = await sendRuntimeDataRequest(root, { operation: 'write', input: { kind: 'memory', action: 'create', scope: null, idempotencyKey: 'disabled-daily', data: { category: 'profile', title: 'Daily write', status: 'active', content: 'available without autonomy' } } });
    assert.equal((await sendRuntimeDataRequest(root, { operation: 'read', input: { ref: write.objectId } })).data.content, 'available without autonomy');
    assert.equal(fs.existsSync(path.join(root, 'runtime', 'today-shadow.json')), false);
    assert.equal(fs.readFileSync(path.join(root, 'runtime', 'service-disabled'), 'utf8'), 'disabled\n');
  } finally { await stop(run, root); }
});

test('a disconnected project with the same legacy slug prevents assigning ambiguous memory to another project', async () => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
  const { enqueueStartupMemoryMigration } = require('../out/runtimeDatabaseBootstrap.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-bootstrap-collision-'));
  const root = path.join(base, '.solomap-global');
  const current = path.join(base, 'first', 'alpha');
  const disconnected = path.join(base, 'disconnected', 'alpha');
  fs.mkdirSync(current, { recursive: true });
  fs.mkdirSync(path.join(root, 'memory', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify({ projects: [{ path: current }, { path: disconnected }] }));
  fs.writeFileSync(path.join(root, 'memory', 'projects', 'alpha.md'), 'Unproven project identity');
  const store = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(store);
  try {
    await enqueueStartupMemoryMigration(store, operations, () => true);
    await operations.waitForMigrations();
    const project = await store.registerProject({ root: current });
    assert.equal(store.search({ scope: project.projectId, kinds: ['memory'] }).items.length, 0);
    const source = store.readMigrationSource('memory:' + path.join(root, 'memory'), 'projects/alpha.md');
    assert.equal(source.bytes.toString(), 'Unproven project identity');
    assert.equal(source.stage, 'unmapped');
  } finally { await operations.close(); store.close(); }
});

test('an unreadable memory source does not prevent queuing independent chat migration', async () => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
  const { enqueueStartupDataMigrations } = require('../out/runtimeDatabaseBootstrap.js');
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-bootstrap-independent-')), '.solomap-global');
  fs.mkdirSync(path.join(root, 'intelligence-conversations'), { recursive: true });
  const store = new UnifiedDataStore(root);
  const ops = createRuntimeDataOperations(store);
  const stat = fs.promises.stat;
  fs.promises.stat = async file => { if (file === path.join(root, 'memory')) throw Object.assign(new Error('fixture_memory_denied'), { code: 'EACCES' }); return stat(file); };
  try {
    await enqueueStartupDataMigrations(store, ops, () => true);
    assert.equal(store.migrationJobs().filter(job => job.args.collection === 'intelligence').length, 1);
  } finally { fs.promises.stat = stat; await ops.close(); store.close(); }
});

test('the extension chat readiness gate reconnects after owner exit and preserves immediate reads', async () => {
  const vm = require('node:vm');
  const host = require('../out/autonomousRuntimeHost.js');
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-chat-reconnect-')), '.solomap-global');
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime/service-disabled'), 'disabled\n');
  const compiled = fs.readFileSync(path.resolve(__dirname, '../out/extension.js'), 'utf8');
  const start = compiled.indexOf('const dataReadiness =');
  const end = compiled.indexOf('const reconcileIntelligenceServiceOnce =', start);
  assert.ok(start >= 0 && end > start);
  const options = { extensionPath: path.resolve(__dirname, '..'), globalDataPath: root };
  const gate = vm.runInNewContext(compiled.slice(start, end) + '\nensureDataReady;', {
    context: { extensionPath: options.extensionPath },
    getPersistedSettings: () => ({ globalDataPath: root }),
    normalizeGlobalDataPathForExtension: require('../out/projectRegistry.js').normalizeGlobalDataPathForExtension,
    autonomousRuntimeHost_1: host,
    reconcileBackgroundIntelligenceService: () => host.ensureHealthyAutonomousRuntime(options).then(() => undefined)
  });
  let pid;
  const shutDown = async () => {
    if (!pid) return;
    try { process.kill(pid, 0); } catch { pid = undefined; return; }
    await sendRuntimeControlCommand(root, 'stop');
    while (true) { try { process.kill(pid, 0); } catch { break; } await new Promise(resolve => setTimeout(resolve, 10)); }
    pid = undefined;
  };
  try {
    await Promise.all(Array.from({ length: 8 }, () => gate()));
    pid = require('../out/autonomousRuntime.js').readRuntimeState(root).pid;
    const receipt = await sendRuntimeDataRequest(root, { operation: 'write', input: { kind: 'memory', action: 'create', scope: null, idempotencyKey: 'reconnect-content', data: { category: 'profile', title: 'Reconnect', status: 'active', content: 'Keep committed bytes' } } });
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(root, 'solomap.db'), { readOnly: true });
    const counts = () => JSON.stringify(db.prepare('SELECT (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM requests) AS requests, (SELECT count(*) FROM migration_jobs) AS jobs').get());
    const before = counts();
    const timings = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      await gate();
      timings.push(performance.now() - started);
    }
    assert.equal(counts(), before, 'unchanged readiness checks do not append database events, requests or migration jobs');
    db.close();
    console.log(JSON.stringify({ readinessChecks: 20, averageMs: timings.reduce((sum,value)=>sum+value,0)/20, maxMs: Math.max(...timings), unchangedDatabaseCounts: true, backgroundPollingAdded: false, paidOperations: 0 }));
    await shutDown();
    await Promise.all(Array.from({ length: 8 }, () => gate()));
    pid = require('../out/autonomousRuntime.js').readRuntimeState(root).pid;
    const current = await sendRuntimeDataRequest(root, { operation: 'read', input: { ref: receipt.objectId } });
    assert.equal(current.data.content, 'Keep committed bytes');
    assert.equal((await sendRuntimeControlCommand(root, 'health')).status, 'paused');
  } finally { await shutDown(); }
});

test('parallel first tasks wait for the same owner rather than failing while its endpoint starts', async () => {
  const { ensureHealthyAutonomousRuntime } = require('../out/autonomousRuntimeHost.js');
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-parallel-first-')), '.solomap-global');
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime/service-disabled'), 'disabled\n');
  const options = { extensionPath: path.resolve(__dirname, '..'), globalDataPath: root };
  try {
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => ensureHealthyAutonomousRuntime(options)));
    assert.ok(outcomes.every(outcome => outcome.status === 'fulfilled'), JSON.stringify(outcomes.map(outcome => outcome.status === 'rejected' ? String(outcome.reason) : outcome.value)));
    assert.equal(new Set(outcomes.map(outcome => outcome.value.runtimeId)).size, 1);
    assert.equal(new Set(outcomes.map(outcome => outcome.value.pid)).size, 1);
    assert.equal((await sendRuntimeControlCommand(root, 'health')).status, 'paused');
  } finally {
    if (fs.existsSync(path.join(root, 'runtime/control.json'))) await sendRuntimeControlCommand(root, 'stop');
  }
});
