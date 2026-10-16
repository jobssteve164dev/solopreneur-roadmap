const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { MigrationRecycling } = require('../out/migrationRecycling.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { enqueueAvailableDataMigrations } = require('../out/runtimeDatabaseBootstrap.js');
const { globalRetiredDataStamp, importGlobalRetiredData } = require('../out/globalRetiredDataMigration.js');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('global retired data is archived exactly while active and secret-bearing paths stay outside the migration', async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-global-retired-'));
  const root = path.join(fixture, '.solomap-global');
  fs.mkdirSync(path.join(root, 'skills', 'runs', 'old-run'), { recursive: true });
  fs.mkdirSync(path.join(root, 'active-conversations', 'records'), { recursive: true });
  fs.mkdirSync(path.join(root, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(root, 'maintenance', 'runs', 'old-review'), { recursive: true });
  fs.mkdirSync(path.join(root, 'daily'), { recursive: true });
  fs.mkdirSync(path.join(root, 'metrics'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime', 'telegram-outbox'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  const conversationKey = 'a'.repeat(40);
  const activeKey = 'b'.repeat(64);
  const sources = new Map([
    [`active-conversations/records/${activeKey}.json`, Buffer.from('{"executionLogId":7}')],
    [`conversations/sidebar-conversation-${conversationKey}-v1.json.legacy-1`, Buffer.from('{"old":true}')],
    ['daily/2024-01-02.json', Buffer.from('{"status":"completed"}')],
    ['metrics/monthly-summary.md', Buffer.from('# historical summary')],
    ['runtime/events.jsonl', Buffer.from('{"kind":"old"}\n')]
  ]);
  for (const [key, bytes] of sources) fs.writeFileSync(path.join(root, ...key.split('/')), bytes);
  fs.writeFileSync(path.join(root, 'skills', 'runs', 'old-run', 'result.json'), '{"token":"must-stay-outside"}');
  fs.writeFileSync(path.join(root, 'skills', 'runs', 'old-run', '.env'), 'API_TOKEN=must-stay-outside');
  fs.writeFileSync(path.join(root, 'runtime', 'telegram-outbox', 'old.json'), '{"chatId":"42","text":"private"}');
  fs.writeFileSync(path.join(root, 'maintenance', 'runs', 'old-review', 'manifest.json'), '{"sources":[]}');
  fs.writeFileSync(path.join(root, 'projects.json'), '{"projects":[],"hiddenProjects":[]}');
  fs.writeFileSync(path.join(root, 'runtime', 'telegram-config.json'), '{"botToken":"do-not-capture"}');
  fs.writeFileSync(path.join(root, 'memory', 'profile.md'), 'still active');
  const store = new UnifiedDataStore(root);
  t.after(() => { store.close(); fs.rmSync(fixture, { recursive: true, force: true }); });

  const first = await importGlobalRetiredData(store, root, {});

  assert.equal(first.imported, 5);
  assert.equal(first.unchanged, 0);
  assert.equal(first.originalBytes, [...sources.values()].reduce((total, bytes) => total + bytes.length, 0));
  assert.deepEqual(first.conflicts, []);
  for (const [key, bytes] of sources) {
    const captured = store.readMigrationSource(`global-retired:${root}`, key);
    assert.equal(captured.hash, digest(bytes));
    assert.deepEqual(captured.bytes, bytes);
    assert.equal(captured.stage, 'imported');
  }
  assert.equal(store.migrationSourceState(`global-retired:${root}`, 'runtime/telegram-config.json'), null);
  assert.equal(store.migrationSourceState(`global-retired:${root}`, 'memory/profile.md'), null);
  assert.equal(store.migrationSourceState(`global-retired:${root}`, 'maintenance/runs/old-review/manifest.json'), null);
  assert.equal(store.migrationSourceState(`global-retired:${root}`, 'projects.json'), null);
  assert.equal(store.migrationSourceState(`global-retired:${root}`, 'skills/runs/old-run/result.json'), null);
  assert.equal(store.migrationSourceState(`global-retired:${root}`, 'skills/runs/old-run/.env'), null);
  assert.equal(store.migrationSourceState(`global-retired:${root}`, 'runtime/telegram-outbox/old.json'), null);
  const evidenceCount = () => Number(store.db.exec("SELECT count(*) AS total FROM evidence WHERE type LIKE 'legacy_migration_source:global-retired:%'")[0].values[0][0]);
  const evidenceBefore = evidenceCount();

  const second = await importGlobalRetiredData(store, root, {});

  assert.equal(second.imported, 0);
  assert.equal(second.unchanged, 5);
  assert.equal(evidenceCount(), evidenceBefore);
  const plan = await new MigrationRecycling(store).prepare();
  assert.deepEqual(plan.files.map(file => file.path).sort(), [...sources.keys()].map(key => path.join(root, ...key.split('/'))).sort());
  assert.equal(plan.files.some(file => /telegram-config|memory\/profile/.test(file.path)), false);
});

test('database-owned prompt and sidebar state archive stale file copies without replacing current authority', async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-global-retired-database-owned-'));
  const root = path.join(fixture, '.solomap-global');
  const conversationKey = 'c'.repeat(40);
  const promptKey = 'context/global-default-prompt.md';
  const conversationFileKey = `conversations/sidebar-conversation-${conversationKey}-v1.json`;
  const promptBytes = Buffer.from('legacy prompt mirror\n');
  const conversationBytes = Buffer.from('{"signature":"old","snapshot":{"solo":[]}}');
  fs.mkdirSync(path.join(root, 'context'), { recursive: true });
  fs.mkdirSync(path.join(root, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(root, ...promptKey.split('/')), promptBytes);
  fs.writeFileSync(path.join(root, ...conversationFileKey.split('/')), conversationBytes);
  const store = new UnifiedDataStore(root);
  t.after(() => { store.close(); fs.rmSync(fixture, { recursive: true, force: true }); });
  store.saveGlobalPrompt({ policy: null, content: 'database authority\n', source: 'user', idempotencyKey: 'database-authority' });

  const result = await importGlobalRetiredData(store, root, {});

  assert.equal(result.imported, 2);
  assert.equal(result.unchanged, 0);
  assert.equal(result.originalBytes, promptBytes.length + conversationBytes.length);
  assert.deepEqual(result.conflicts, []);
  assert.equal(store.readGlobalPromptPolicy().data.content, 'database authority\n');
  for (const [key, bytes] of [[promptKey, promptBytes], [conversationFileKey, conversationBytes]]) {
    const captured = store.readMigrationSource(`global-retired:${root}`, key);
    assert.equal(captured.hash, digest(bytes));
    assert.deepEqual(captured.bytes, bytes);
    assert.equal(captured.stage, 'imported');
  }
  assert.deepEqual((await new MigrationRecycling(store).prepare()).files.map(file => file.path).sort(), [
    path.join(root, ...promptKey.split('/')),
    path.join(root, ...conversationFileKey.split('/'))
  ].sort());
});

test('global retired import is bound to the database authority root', async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-global-retired-scope-'));
  const root = path.join(fixture, '.solomap-global');
  const external = path.join(fixture, 'external');
  fs.mkdirSync(path.join(external, 'daily'), { recursive: true });
  fs.writeFileSync(path.join(external, 'daily', '2024-01-02.json'), '{}');
  const store = new UnifiedDataStore(root);
  t.after(() => { store.close(); fs.rmSync(fixture, { recursive: true, force: true }); });

  await assert.rejects(importGlobalRetiredData(store, external, {}), /migration_source_scope_mismatch/);
  assert.equal(store.migrationSourceState(`global-retired:${external}`, 'daily/2024-01-02.json'), null);
});

test('an empty global root does not schedule a retired-data migration signature', async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-global-retired-empty-'));
  const root = path.join(fixture, '.solomap-global');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  assert.equal(await globalRetiredDataStamp(root, () => true), '');
});

test('runtime discovery owns the retired-data migration and only queues a new observed source set', async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-global-retired-runtime-'));
  const root = path.join(fixture, '.solomap-global');
  const runRoot = path.join(root, 'daily');
  fs.mkdirSync(runRoot, { recursive: true });
  fs.writeFileSync(path.join(runRoot, '2024-01-01.json'), '{"first":true}');
  const store = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(store);
  t.after(async () => { await operations.close(); store.close(); fs.rmSync(fixture, { recursive: true, force: true }); });

  const first = await enqueueAvailableDataMigrations(store, operations, () => true);
  await operations.waitForMigrations();
  assert.equal(first.queued, 1);
  assert.equal(store.migrationJobs().filter(job => job.args.collection === 'global-retired').length, 1);
  assert.equal(store.readMigrationSource(`global-retired:${root}`, 'daily/2024-01-01.json').stage, 'imported');

  assert.equal((await enqueueAvailableDataMigrations(store, operations, () => true)).queued, 0);
  fs.writeFileSync(path.join(runRoot, '2024-01-02.json'), '{"second":true}');
  assert.equal((await enqueueAvailableDataMigrations(store, operations, () => true)).queued, 1);
  await operations.waitForMigrations();
  assert.equal(store.migrationJobs().filter(job => job.args.collection === 'global-retired').length, 2);
  assert.equal(store.readMigrationSource(`global-retired:${root}`, 'daily/2024-01-02.json').stage, 'imported');
});

test('startup archives the retired sidebar snapshot without importing it as current analysis state', async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-retired-sidebar-startup-'));
  const root = path.join(fixture, '.solomap-global');
  const workspace = path.join(fixture, 'project');
  fs.mkdirSync(path.join(root, 'conversations'), { recursive: true });
  fs.mkdirSync(workspace);
  const store = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(store);
  t.after(async () => { await operations.close(); store.close(); fs.rmSync(fixture, { recursive: true, force: true }); });
  const project = await store.registerProject({ root: workspace });
  const projectKey = crypto.createHash('sha1').update(workspace).digest('hex');
  const key = `conversations/sidebar-conversation-${projectKey}-v1.json`;
  const rootKey = `sidebar-conversation-${projectKey}-v1.json`;
  const bytes = Buffer.from('{"snapshot":{"stale":true}}');
  fs.writeFileSync(path.join(root, key), bytes);
  fs.writeFileSync(path.join(root, rootKey), bytes);

  await enqueueAvailableDataMigrations(store, operations, () => true);
  await operations.waitForMigrations();

  assert.deepEqual(store.readAnalysisState(project.projectId, 'sidebar', 'conversation'), { objectId: null, revision: 0, value: null });
  const archived = store.readMigrationSource(`global-retired:${root}`, key);
  assert.equal(archived.stage, 'imported');
  assert.deepEqual(archived.bytes, bytes);
  assert.equal(store.readMigrationSource(`global-retired:${root}`, rootKey).stage, 'imported');
  assert.equal(store.migrationSourceState(`analysis-caches:${root}`, key), null);
  assert.equal(store.migrationSourceState(`analysis-caches:${root}`, rootKey), null);
});
