const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

test('database overview uses a resumable exact projection instead of scanning the contents table', async () => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-overview-projection-'));
  let store = new UnifiedDataStore(root);
  const project = await store.registerProject({ root });
  for (let index = 0; index < 7; index++) {
    store.write({ kind: 'memory', action: 'create', scope: project.projectId,
      idempotencyKey: `overview-seed-${index}`, data: { category: 'project', title: `Seed ${index}`, status: 'active', content: `Body ${index}` } });
  }
  store.close();

  const databasePath = path.join(root, 'solomap.db');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    DROP TRIGGER database_overview_content_insert;
    DROP TRIGGER database_overview_content_delete;
    DROP TABLE database_overview_projection;
    DELETE FROM schema_migrations WHERE version=64;
  `);
  const expectedRecords = Number(legacy.prepare('SELECT COUNT(*) AS records FROM contents').get().records);
  legacy.close();

  store = UnifiedDataStore.open(root);
  let overview = store.readDatabaseOverview();
  assert.equal(overview.contents.records, null);
  assert.equal(overview.contents.exact, false);
  let batches = 0;
  while (!overview.contents.exact) {
    const result = store.backfillDatabaseOverviewProjectionBatch(3);
    batches++;
    assert.ok(result.processed <= 3);
    overview = store.readDatabaseOverview();
  }
  assert.ok(batches > 1, 'an upgraded database must reconcile through bounded resumable batches');
  assert.equal(overview.contents.records, expectedRecords);
  assert.equal(overview.contents.exact, true);

  const before = overview.contents.records;
  store.write({ kind: 'memory', action: 'create', scope: project.projectId,
    idempotencyKey: 'overview-live-insert', data: { category: 'project', title: 'Live insert', status: 'active', content: 'Unique live projection content' } });
  const after = store.readDatabaseOverview();
  assert.equal(after.contents.exact, true);
  assert.ok(after.contents.records > before, 'new content must update the exact projection transactionally');
  store.close();

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'unifiedDataStore.ts'), 'utf8');
  const body = source.slice(source.indexOf('public readDatabaseOverview()'), source.indexOf('public maintainPlannerStatistics'));
  assert.doesNotMatch(body, /COUNT\(\*\).*contents/i);
  assert.match(body, /database_overview_projection/);
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'src', 'autonomousRuntimeProcess.ts'), 'utf8');
  assert.match(runtime, /backfill_database_overview_projection/);
  assert.match(runtime, /scheduleDatabaseOverviewProjectionBackfill\(5_000\)/,
    'legacy projection reconciliation must start after the interactive startup window');
});

test('database overview reports the automatic reclamation phases and committed totals without changing them', t => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-reclamation-overview-'));
  const store = new UnifiedDataStore(root);
  t.after(() => store.close());
  const reclamation = () => store.readDatabaseOverview().reclamation;
  assert.deepEqual(reclamation(), { status: 'disabled', deletedContents: 0, reclaimedStoredBytes: 0 });

  const contentId = store.putContent('Accurately report the reference scan');
  store.db.run("UPDATE content_lifecycle_reference_progress SET cursor='',upper_id=? WHERE id=1", [contentId]);
  store.beginContentPreparationRecovery();
  store.activateStorageContentLifecycle();
  assert.equal(reclamation().status, 'checkingHistory');

  store.db.run('UPDATE content_lifecycle_reference_progress SET cursor=upper_id WHERE id=1');
  store.db.run('INSERT OR IGNORE INTO content_lifecycle_gc_debt(content_id) VALUES(?)', [contentId]);
  assert.equal(reclamation().status, 'checkingReferences');
  store.db.run('DELETE FROM content_lifecycle_gc_debt');
  assert.equal(reclamation().status, 'pending');

  store.db.run('UPDATE content_lifecycle_gc_state SET capture_hold=1 WHERE id=1');
  assert.equal(reclamation().status, 'paused');
  store.db.run('UPDATE content_lifecycle_gc_state SET capture_hold=0,cursor=upper_id,deleted_contents=7,reclaimed_stored_bytes=2048 WHERE id=1');
  store.db.run('DELETE FROM content_lifecycle_gc_pending');
  const changes = store.rows('SELECT total_changes() AS count')[0].count;
  assert.deepEqual(reclamation(), { status: 'idle', deletedContents: 7, reclaimedStoredBytes: 2048 });
  assert.equal(store.rows('SELECT total_changes() AS count')[0].count, changes);
});
