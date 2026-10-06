const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');

test('database-backed initialization stops generating memory and example Markdown while preserving existing user files', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-no-memory-md-'));
  const root = path.join(fixture, '.solomap-global');
  const store = new UnifiedDataStore(root);
  fs.mkdirSync(path.join(root, 'memory'));
  const original = path.join(root, 'memory', 'profile.md');
  fs.writeFileSync(original, 'existing user-owned preferences');
  try {
    const { ensureSolomapMemoryStore } = require('../out/solomapGlobal.js');
    const { ensureGlobalEngineeringStore } = require('../out/globalEngineeringStore.js');
    ensureSolomapMemoryStore(path.join(fixture, 'project'), root);
    ensureGlobalEngineeringStore(root, []);
    const markdown = [];
    const scan = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) scan(file);
        else if (entry.name.endsWith('.md')) markdown.push(path.relative(root, file));
      }
    };
    scan(root);
    assert.deepEqual(markdown, ['memory/profile.md']);
    assert.equal(fs.readFileSync(original, 'utf8'), 'existing user-owned preferences');
  } finally { store.close(); }
});

test('migration acknowledges before slow source IO and permits immediate project writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-background-import-'));
  const memory = path.join(root, 'memory');
  fs.mkdirSync(memory);
  const source = path.join(memory, 'profile.md');
  fs.writeFileSync(source, 'preserved legacy memory');
  const store = new UnifiedDataStore(path.join(root, 'database'));
  const operations = createRuntimeDataOperations(store);
  const readFile = fs.promises.readFile;
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { started = resolve; });
  fs.promises.readFile = async function(file, ...args) {
    const bytes = await readFile.call(this, file, ...args);
    if (file === source) { started(); await gate; }
    return bytes;
  };
  try {
    const request = { operation: 'import_memory', input: { sourceRoot: memory, idempotencyKey: 'background-one' } };
    const pending = operations(request);
    await reading;
    const acknowledgement = await Promise.race([pending, new Promise(resolve => setImmediate(() => resolve(null)))]);
    assert.ok(acknowledgement?.jobId, 'migration request must acknowledge while source IO is still pending');
    fs.mkdirSync(path.join(root, 'project'));
    const project = await operations({ operation: 'register_project', input: { root: path.join(root, 'project'), name: 'Daily project' } });
    const written = await operations({ operation: 'write', input: { kind: 'memory', action: 'create', scope: project.projectId, idempotencyKey: 'daily-write', data: { category: 'project', title: 'Now', status: 'active', content: 'immediately visible' } } });
    assert.equal((await operations({ operation: 'read', input: { ref: written.objectId } })).data.content, 'immediately visible');
    assert.equal((await operations(request)).jobId, acknowledgement.jobId);
    release();
    await operations.waitForMigrations();
    const status = await operations({ operation: 'migration_status', input: { jobId: acknowledgement.jobId } });
    assert.equal(status.status, 'completed');
    assert.equal(status.progress.imported, 1);
    assert.equal(fs.readFileSync(source, 'utf8'), 'preserved legacy memory');
  } finally {
    release();
    fs.promises.readFile = readFile;
    if (operations.close) await operations.close();
    store.close();
  }
});

test('an interrupted background job resumes after reopening without duplicate source revisions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-background-resume-'));
  const memory = path.join(root, 'memory');
  fs.mkdirSync(memory);
  fs.writeFileSync(path.join(memory, 'operating-rules.md'), 'first imported source');
  const second = path.join(memory, 'profile.md');
  fs.writeFileSync(second, 'second imported source');
  const store = new UnifiedDataStore(path.join(root, 'database'));
  const operations = createRuntimeDataOperations(store);
  const readFile = fs.promises.readFile;
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { started = resolve; });
  fs.promises.readFile = async function(file, ...args) {
    const bytes = await readFile.call(this, file, ...args);
    if (file === second) { started(); await gate; }
    return bytes;
  };
  let job;
  try {
    job = await operations({ operation: 'import_memory', input: { sourceRoot: memory, idempotencyKey: 'restart-safe' } });
    await reading;
    const stopping = operations.close();
    release();
    await stopping;
    assert.equal(store.readMigrationJob(job.jobId).status, 'interrupted');
    assert.equal(store.search({ scope: null, kinds: ['memory'] }).items.length, 1);
  } finally { release(); fs.promises.readFile = readFile; await operations.close(); store.close(); }
  const reopened = new UnifiedDataStore(path.join(root, 'database'));
  const resumed = createRuntimeDataOperations(reopened);
  try {
    resumed.recoverMigrations();
    await resumed.waitForMigrations();
    const result = reopened.readMigrationJob(job.jobId);
    assert.equal(result.status, 'completed');
    assert.equal(result.progress.imported, 1);
    assert.equal(result.progress.unchanged, 1);
    const objects = reopened.search({ scope: null, kinds: ['memory'] }).items;
    assert.equal(objects.length, 2);
    assert.ok(objects.every(object => object.revision === 1));
    assert.equal((await resumed({ operation: 'import_memory', input: { sourceRoot: memory, idempotencyKey: 'restart-safe' } })).jobId, job.jobId);
    assert.throws(() => reopened.enqueueMemoryMigration({ sourceRoot: 'different' }, 'restart-safe'), /idempotency_conflict/);
  } finally { await resumed.close(); reopened.close(); }
});

test('V1 databases upgrade in place with their original schema checksum and data intact', () => {
  const { DatabaseSync } = require('node:sqlite');
  const crypto = require('node:crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-v1-upgrade-'));
  const file = path.join(root, 'solomap.db');
  const sql = fs.readFileSync(path.join(__dirname, 'fixtures', 'unified-schema-v1.sql'), 'utf8');
  const checksum = crypto.createHash('sha256').update(sql).digest('hex');
  const previous = new DatabaseSync(file);
  previous.exec(sql);
  previous.prepare('INSERT INTO schema_migrations VALUES(1,?,?)').run(checksum, 1);
  previous.prepare('INSERT INTO database_meta VALUES(?,?)').run('database_id', 'preserved-identity');
  previous.exec("INSERT INTO actors(id,kind) VALUES('old-owner','runtime')");
  previous.close();
  const store = new UnifiedDataStore(root);
  const audit = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(audit.prepare('SELECT checksum FROM schema_migrations WHERE version=1').get().checksum, checksum);
    assert.equal(audit.prepare("SELECT value FROM database_meta WHERE key='database_id'").get().value, 'preserved-identity');
    assert.equal(audit.prepare("SELECT kind FROM actors WHERE id='old-owner'").get().kind, 'runtime');
    assert.deepEqual(audit.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version), [1, 2, 3, 4, 5, 6]);
    assert.ok(store.enqueueMemoryMigration({ sourceRoot: 'old-memory' }, 'upgrade').jobId);
    assert.equal(audit.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { audit.close(); store.close(); }
});
