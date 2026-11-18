const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('./runtime-data-fixture.cjs');

async function fixture(t, suffix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-retirement-case-'));
  const store = new UnifiedDataStore(path.join(base, 'data')), operations = createRuntimeDataOperations(store);
  t.after(async () => { await operations.close(); store.close(); });
  const root = path.join(base, `solomap-old-init-${suffix}`); fs.mkdirSync(root);
  const project = await store.registerProject({ root }); fs.renameSync(root, path.join(base, 'retained-source'));
  return { base, root, store, operations, project };
}

for (const change of ['unindexed relation', 'registry', 'migration', 'recreated path', 'unrelated write', 'migration progress']) {
  test(`project retirement revalidates late ${change} without losing the original protection contract`, async t => {
    const value = await fixture(t, change.replaceAll(' ', ''));
    const { base, root, store, operations, project } = value;
    const memory = store.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'unrelated-memory', data: { category: 'inbox', title: 'unrelated', status: 'captured', content: 'retained' } });
    if (change === 'registry') await store.initializeProjectRegistry({ legacyProjects: [] });
    const job = change === 'migration progress' ? store.enqueueMemoryMigration({ collection: 'documentation', projectRoot: base, sourceRoot: path.join(base, 'documentation.json') }, 'unrelated-migration-progress') : null;
    const compute = store.storageLifecycleCompute, original = compute.qualifyProjectRetirement;
    let calls = 0;
    compute.qualifyProjectRetirement = async candidate => {
      const result = await original(candidate); calls++;
      if (calls === 1) {
        assert.equal(result, true, 'the stale proof must originally authorize retirement');
        if (change === 'unindexed relation') store.db.run('INSERT INTO relations VALUES(?,?,?)', [memory.objectId, 'source', project.projectId]);
        if (change === 'registry') {
          const registry = store.readProjectRegistry();
          store.patchProjectRegistry({ expectedRevision: registry.revision, projectPatches: [{ path: root, fields: { name: path.basename(root) } }], idempotencyKey: 'late-registry-root' });
        }
        if (change === 'migration') store.enqueueMemoryMigration({ sourceRoot: path.join(base, '.codex-memory'), projectScopes: { [root]: project.projectId } }, 'late-migration-scope');
        if (change === 'recreated path') fs.mkdirSync(root);
        if (change === 'unrelated write') store.write({ kind: 'memory', action: 'patch', scope: null, objectId: memory.objectId, expectedRevision: memory.revision, idempotencyKey: 'unrelated-memory-update', data: { title: 'still unrelated' } });
        if (change === 'migration progress') store.db.run("UPDATE migration_jobs SET status='running',progress_json='{}' WHERE id=?", [job.jobId]);
      }
      return result;
    };
    const result = await operations({ operation: 'maintain_database_storage', input: { compact: false } });
    const independent = change === 'unrelated write' || change === 'migration progress';
    assert.equal(result.retiredTestProjects, independent ? 1 : 0);
    assert.equal(store.rows('SELECT status FROM project_locations WHERE project_id=?', [project.projectId])[0].status, independent ? 'removed_test_fixture' : 'active');
    assert.equal(store.rows('SELECT hidden FROM projects WHERE id=?', [project.projectId])[0].hidden, independent ? 1 : 0);
    if (independent || change === 'recreated path') assert.equal(calls, 1, 'unrelated writes and unchanged active migration progress do not invalidate the proof');
    else assert.equal(calls, 2, 'a changed protection must be recomputed before any business write');
    assert.equal(store.rows('SELECT 1 FROM temp.solomap_project_retirement_watches').length, 0);
  });
}

test('retirement guard bootstrap rolls back all partial TEMP schema and the same Writer can retry', async t => {
  const { store, operations } = await fixture(t, 'bootstrap');
  const run = store.db.run.bind(store.db); let creates = 0;
  store.db.run = (sql, values) => {
    if (String(sql).startsWith('CREATE TEMP TRIGGER "solomap_retire_') && ++creates === 5) throw new Error('retirement-bootstrap-fault');
    return run(sql, values);
  };
  try { await assert.rejects(operations({ operation: 'maintain_database_storage', input: { compact: false } }), /retirement-bootstrap-fault/); }
  finally { store.db.run = run; }
  assert.equal(store.rows("SELECT name FROM temp.sqlite_schema WHERE name LIKE 'solomap_retire_%' OR name LIKE 'solomap_project_retirement_%'").length, 0);
  assert.equal((await operations({ operation: 'maintain_database_storage', input: { compact: false } })).retiredTestProjects, 1);
});

test('failed retirement qualification release keeps its cold retry responsibility without changing the accepted result', async t => {
  const { store, operations } = await fixture(t, 'release');
  const run = store.db.run.bind(store.db); let fail = true;
  store.db.run = (sql, values) => {
    if (fail && String(sql).startsWith('DELETE FROM temp.solomap_project_retirement_watches')) throw new Error('retirement-release-fault');
    return run(sql, values);
  };
  try {
    assert.equal((await operations({ operation: 'maintain_database_storage', input: { compact: false } })).retiredTestProjects, 1);
    assert.equal(store.rows('SELECT 1 FROM temp.solomap_project_retirement_watches').length, 1);
    await assert.rejects(operations({ operation: 'maintain_database_storage', input: { phase: 'cold' } }), /retirement-release-fault/);
    fail = false;
    await operations({ operation: 'maintain_database_storage', input: { phase: 'cold' } });
    assert.equal(store.rows('SELECT 1 FROM temp.solomap_project_retirement_watches').length, 0);
  } finally { store.db.run = run; }
});

test('complete maintenance retires a vanished empty fixture without Source registry, migration JSON or FK history scans', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-retirement-'));
  const store = new UnifiedDataStore(path.join(base, 'data'));
  const operations = createRuntimeDataOperations(store);
  t.after(async () => { await operations.close(); store.close(); });
  const root = path.join(base, 'solomap-old-init-Compute1'); fs.mkdirSync(root);
  const project = await store.registerProject({ root }); fs.renameSync(root, path.join(base, 'retained-fixture-source'));
  const rows = store.rows.bind(store), registry = store.readProjectRegistry;
  store.readProjectRegistry = () => assert.fail('retirement must parse the project registry in Compute');
  store.rows = (sql, values) => {
    assert.doesNotMatch(String(sql), /^SELECT args_json FROM migration_jobs|^SELECT DISTINCT /, 'Source must not scan migration arguments or historical reference tables');
    return rows(sql, values);
  };
  let result;
  try { result = await operations({ operation: 'maintain_database_storage', input: { compact: false } }); }
  finally { store.rows = rows; store.readProjectRegistry = registry; }
  assert.equal(result.retiredTestProjects, 1);
  assert.equal(rows('SELECT status FROM project_locations WHERE project_id=?', [project.projectId])[0].status, 'removed_test_fixture');
  assert.equal(rows('SELECT revision FROM objects WHERE id=?', [project.projectId])[0].revision, 3);
  assert.equal(store.read(project.projectId, 1).data.hidden, 0);
});
