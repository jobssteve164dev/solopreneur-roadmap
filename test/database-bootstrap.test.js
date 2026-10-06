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
