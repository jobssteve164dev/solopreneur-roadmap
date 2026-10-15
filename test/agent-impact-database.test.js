const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');
const { buildAgentImpactSummaryFromDatabase } = require('../out/agentImpact.js');

function cleanupExact(root) {
  if (!fs.existsSync(root)) return;
  const directories = [root], files = [];
  const inventory = directory => {
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name);
      if (fs.lstatSync(target).isDirectory()) { directories.push(target); inventory(target); }
      else files.push(target);
    }
  };
  inventory(root);
  files.forEach(file => fs.unlinkSync(file));
  directories.sort((left, right) => right.length - left.length).forEach(directory => fs.rmdirSync(directory));
}

async function fixture(action) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-impact-native-'));
  const root = path.join(base, '.solomap-global'); const workspace = path.join(base, 'project'); fs.mkdirSync(workspace);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'impact-fixture-owner', onCommand: () => ({ status: 'running' }), onData: ops });
  let closed = false;
  const closeEndpoint = async () => { if (!closed) { await server.close(); closed = true; } };
  let ownerClosed = false;
  const closeOwner = async () => { if (!ownerClosed) { await closeEndpoint(); await ops.close(); store.close(); ownerClosed = true; } };
  const project = (await store.registerProject({ root: workspace })).projectId;
  const projects = [{ name: 'Project', path: workspace }];
  const record = (id, durationMs = 600000) => ({ executionLogId: id, nodeId: '__solo__', runKind: 'solo', agentCli: 'codex', status: 'Completed', startedAt: '2026-10-09T09:00:00Z', finishedAt: '2026-10-09T09:10:00Z', durationMs, totalTokens: 17, outputTail: 'full evidence remains retained', outputPath: '', outputBytes: 0, commandPath: '', promptPath: '', changesPath: '', touchedFilesPath: '', updatedAt: '2026-10-09T09:10:00Z' });
  const read = () => buildAgentImpactSummaryFromDatabase(projects, path.resolve(__dirname, '..'), new Date('2026-10-09T12:00:00Z'), root);
  try { await action({ root, workspace, project, projects, store, ops, record, read, closeEndpoint, closeOwner }); }
  finally { await closeOwner(); cleanupExact(base); }
}

test('agent contribution uses committed native runs, tokens and all changed files', () => fixture(async ({ workspace, project, store, record, read }) => {
  fs.writeFileSync(path.join(workspace, '.solopreneur', 'roadmap.csv'), 'id,status\n1,Completed\n2,Pending\n');
  store.upsertProjectRunIndex(project, { ...record(1, 180000), totalTokens: 12345 }, [{ filePath: 'src/view.ts', role: 'changed' }, { filePath: 'docs/result.md', role: 'touched' }]);
  store.upsertProjectRunIndex(project, { ...record(2, 60000), agentCli: 'claude', status: 'Failed', totalTokens: 0 }, [{ filePath: 'src/view.ts', role: 'changed' }, { filePath: 'src/api.ts', role: 'changed' }]);
  store.upsertProjectRunIndex(project, { ...record(3), runKind: 'skill_install', totalTokens: 999999 });
  const result = await read();
  assert.equal(result.totalRuns, 2); assert.equal(result.weekRuns, 2);
  assert.equal(result.completedRuns, 1); assert.equal(result.failedRuns, 1);
  assert.equal(result.totalMinutes, 4); assert.equal(result.totalTokens, 12345); assert.equal(result.tokenRuns, 1);
  assert.equal(result.changedFiles, 3); assert.equal(result.projectProgressPercent, 50);
  assert.deepEqual(result.byAgent.map(agent => [agent.agent, agent.runs, agent.minutes, agent.changedFiles]), [['codex', 1, 3, 2], ['claude', 1, 1, 2]]);
}));

test('empty native contribution ignores old digests and missing tokens never read an old output path', () => fixture(async ({ workspace, project, store, record, read }) => {
  const digestDir = path.join(workspace, '.solopreneur', 'run-digests'); fs.mkdirSync(digestDir);
  fs.writeFileSync(path.join(digestDir, 'old.json'), JSON.stringify({ runKind: 'solo', agentCli: 'claude', status: 'Failed', durationMs: 1800000 }));
  assert.equal((await read()).totalRuns, 0);
  const oldRun = path.join(workspace, '.solopreneur', 'agent-runs', '__solo__', '1'); fs.mkdirSync(oldRun, { recursive: true });
  const output = path.join(oldRun, 'output.log'); fs.writeFileSync(output, 'tokens used\n999,999');
  store.upsertProjectRunIndex(project, { ...record(1), totalTokens: 0, outputPath: output });
  const result = await read(); assert.equal(result.totalRuns, 1); assert.equal(result.totalTokens, 0); assert.equal(result.failedRuns, 0);
}));

test('agent contribution reads WAL commits immediately without a file signature cache', () => fixture(async ({ root, project, store, record, read }) => {
  store.upsertProjectRunIndex(project, record(1), [{ filePath: 'a.js', role: 'changed' }]);
  assert.equal((await read()).totalTokens, 17);
  const before = fs.statSync(path.join(root, 'solomap.db')).mtimeMs;
  store.upsertProjectRunIndex(project, { ...record(1), totalTokens: 88 }, [{ filePath: 'b.js', role: 'changed' }, { filePath: 'c.js', role: 'touched' }]);
  const result = await read(); assert.equal(result.totalRuns, 1); assert.equal(result.totalTokens, 88); assert.equal(result.changedFiles, 2);
  assert.equal(fs.statSync(path.join(root, 'solomap.db')).mtimeMs, before);
}));

test('a disconnected owner rejects contribution reads instead of reviving legacy results', () => fixture(async ({ workspace, closeEndpoint, read }) => {
  const dir = path.join(workspace, '.solopreneur', 'run-digests'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ runKind: 'solo', status: 'Completed', durationMs: 600000 }));
  await closeEndpoint(); await assert.rejects(read());
}));

test('contribution projection includes every session and file without unrelated full evidence', () => fixture(async ({ workspace, project, store, ops, record }) => {
  for (let id = 1; id <= 503; id++) store.upsertProjectRunIndex(project, { ...record(id), outputTail: 'private full output '.repeat(100) }, [{ filePath: 'changed.js', role: 'changed' }, { filePath: 'private-evidence', role: 'evidence' }], [{ type: 'verification', value: 'private check body' }]);
  const otherRoot = path.join(path.dirname(workspace), 'other'); fs.mkdirSync(otherRoot);
  const other = (await store.registerProject({ root: otherRoot })).projectId; store.upsertProjectRunIndex(other, record(1));
  const result = await ops({ operation: 'read_project_impact_runs', input: { root: workspace } });
  assert.equal(result.length, 503);
  assert.equal(result.reduce((sum, run) => sum + run.totalTokens, 0), 503 * 17);
  assert.ok(result.every(run => run.files.length === 1 && run.files[0].filePath === 'changed.js'));
  assert.doesNotMatch(JSON.stringify(result), /private full output|private-evidence|private check body|outputTail|outputPath/);
  assert.equal(store.readProjectRunIndexes(project)[0].files.length, 2);
}));

test('explicit raw history import restores old-only contribution and full token evidence', () => fixture(async ({ workspace, project, store, ops, read }) => {
  const source = path.join(workspace, '.solopreneur', 'agent-runs');
  for (const [relative, command, tokens] of [['__solo__/12', 'codex exec', 12345], ['step-two', 'claude -p', 67]]) {
    const directory = path.join(source, relative); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'command.txt'), command);
    fs.writeFileSync(path.join(directory, 'started_at'), '2026-10-09T09:00:00Z');
    fs.writeFileSync(path.join(directory, 'output.log'), '完整日志🌿'.repeat(10000) + `\nRun duration ms: 180000\ntokens used\n${tokens}`);
    fs.writeFileSync(path.join(directory, 'completion.json'), JSON.stringify({ markCompleted: true }));
    fs.writeFileSync(path.join(directory, 'changes.txt'), 'M src/result.js\n');
    fs.mkdirSync(path.join(directory, 'assets', '2024'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'assets', '2024', 'report.txt'), '完整内部证据🌿');
  }
  assert.equal((await read()).totalRuns, 0);
  const importOnce = async key => { const job = await ops({ operation: 'import_project_data', input: { collection: 'agent-runs', projectRoot: workspace, sourceRoot: source, idempotencyKey: key } }); await ops.waitForMigrations(); assert.equal(store.readMigrationJob(job.jobId).status, 'completed'); };
  await importOnce('raw-impact-first');
  const first = await read(); assert.equal(first.totalRuns, 2); assert.equal(first.totalTokens, 12412); assert.equal(first.totalMinutes, 6);
  const native = store.readProjectRunIndexes(project); assert.equal(native.length, 2);
  const anonymous = native.find(row => row.nodeId === 'step-two');
  assert.equal(Buffer.from(store.readRunArtifact(project, anonymous.executionLogId, 'step-two/command.txt').bytes, 'base64').toString(), 'claude -p');
  const raw = store.readRunArtifact(project, 12, '__solo__/12/output.log');
  assert.equal(store.readRunArtifact(project, 12, '__solo__/12/assets/2024/report.txt'), null, 'task workspace byproducts are not database records');
  assert.ok(!store.capturedMigrationSources().some(item => item.identity === `agent-runs:${workspace}` && item.key === '__solo__/12/assets/2024/report.txt'));
  assert.equal(Buffer.from(raw.bytes, 'base64').toString(), fs.readFileSync(path.join(source, '__solo__/12/output.log'), 'utf8'));
  await importOnce('raw-impact-again'); assert.deepEqual(await read(), first);
  fs.renameSync(source, `${source}-retained`); assert.deepEqual(await read(), first);
}));

test('storage maintenance classifies retained run data and removes previously imported byproducts without touching source files', () => fixture(async ({ workspace, project, store, ops }) => {
  const crypto = require('node:crypto');
  const sourceRoot = path.join(workspace, '.solopreneur', 'agent-runs');
  const run = path.join(sourceRoot, '__solo__', '44'); fs.mkdirSync(path.join(run, 'evidence'), { recursive: true });
  const prompt = Buffer.from('必须保留的完整用户请求🌿');
  const byproduct = crypto.randomBytes(2 * 1024 * 1024);
  const promptPath = '__solo__/44/prompt.txt'; const byproductPath = '__solo__/44/evidence/release.vsix'; const sharedByproductPath = '__solo__/44/evidence/request-copy.txt';
  fs.writeFileSync(path.join(run, 'prompt.txt'), prompt); fs.writeFileSync(path.join(run, 'evidence', 'release.vsix'), byproduct); fs.writeFileSync(path.join(run, 'evidence', 'request-copy.txt'), prompt);
  const put = bytes => store.putContent(bytes, 'application/octet-stream', 'binary');
  const promptContentId = put(prompt); const byproductContentId = put(byproduct);
  const now = Date.now();
  store.db.run('INSERT INTO project_run_artifacts(project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at) VALUES(?,?,?,?,?,?,?)', [project, 44, promptPath, promptContentId, crypto.createHash('sha256').update(prompt).digest('hex'), 'application/octet-stream', now]);
  store.db.run('INSERT INTO project_run_artifacts(project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at) VALUES(?,?,?,?,?,?,?)', [project, 44, byproductPath, byproductContentId, crypto.createHash('sha256').update(byproduct).digest('hex'), 'application/octet-stream', now]);
  store.db.run('INSERT INTO project_run_artifacts(project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at) VALUES(?,?,?,?,?,?,?)', [project, 44, sharedByproductPath, promptContentId, crypto.createHash('sha256').update(prompt).digest('hex'), 'application/octet-stream', now]);
  store.db.run('INSERT INTO project_run_artifacts(project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at) VALUES(?,CAST(? AS INTEGER),?,?,?,?,?)', [project, '10000000000000004', '__solo__/unsafe/evidence/release.vsix', byproductContentId, crypto.createHash('sha256').update(byproduct).digest('hex'), 'application/octet-stream', now]);
  store.db.run("INSERT INTO project_run_indexes VALUES(?,CAST(? AS INTEGER),?,'[]','[]',?)", [project, '10000000000000004', JSON.stringify({ executionLogId: '10000000000000004', outputPath: '' }), now]);
  for (const [key, bytes] of [[promptPath, prompt], [byproductPath, byproduct], [sharedByproductPath, prompt]]) store.captureMigrationSource({ identity: `agent-runs:${workspace}`, key, hash: crypto.createHash('sha256').update(bytes).digest('hex') }, bytes, { mimeType: 'application/octet-stream', encoding: 'binary' });
  assert.match(String(store.rows("EXPLAIN QUERY PLAN SELECT 1 FROM project_run_artifacts WHERE artifact_kind IN ('unclassified','byproduct') LIMIT 1")[0].detail), /project_run_artifacts_kind/);
  assert.match(String(store.rows("EXPLAIN QUERY PLAN SELECT 1 FROM migration_items WHERE source_identity LIKE 'agent-runs:%' AND source_kind IN ('unclassified','byproduct') LIMIT 1")[0].detail), /migration_items_source_kind/);
  const before = await ops({ operation: 'read_database_storage', input: {} });
  assert.equal(before.runArtifacts.pendingByproductRecords, 3); assert.ok(before.runArtifacts.pendingByproductStoredBytes >= byproduct.length);
  assert.equal(before.migrationSources.pendingByproductRecords, 2); assert.ok(before.migrationSources.pendingByproductStoredBytes >= byproduct.length);
  const cleaned = await ops({ operation: 'maintain_database_storage', input: { compact: true } });
  assert.equal(cleaned.deletedArtifacts, 3); assert.equal(cleaned.deletedSources, 2); assert.equal(cleaned.deletedContents, 1);
  assert.ok(cleaned.reclaimedStoredBytes >= byproduct.length); assert.equal(cleaned.pendingByproductRecords, 0);
  assert.equal(Buffer.from(store.readRunArtifact(project, 44, promptPath).bytes, 'base64').toString(), prompt.toString());
  assert.equal(store.readRunArtifact(project, 44, byproductPath), null);
  assert.equal(store.rows('SELECT id FROM contents WHERE id=?', [byproductContentId]).length, 0);
  assert.deepEqual(fs.readFileSync(path.join(run, 'evidence', 'release.vsix')), byproduct, 'database cleanup never deletes legacy source files');
  const after = await ops({ operation: 'read_database_storage', input: {} });
  assert.equal(after.runArtifacts.byKind.prompt.records, 1); assert.equal(after.runArtifacts.pendingByproductRecords, 0);
  assert.equal(after.migrationSources.byKind.prompt.records, 1); assert.equal(after.migrationSources.pendingByproductRecords, 0);
  assert.equal(after.lastMaintenance.deletedArtifacts, 3); assert.equal(after.lastMaintenance.deletedSources, 2);
  assert.equal(after.lastMaintenance.status, 'completed'); assert.equal(after.lastMaintenance.error, '');
  assert.ok(after.databaseBytes < before.databaseBytes);
  const repeated = await ops({ operation: 'maintain_database_storage', input: { compact: false } });
  assert.equal(repeated.deletedArtifacts, 0); assert.equal(repeated.deletedSources, 0); assert.equal(repeated.deletedContents, 0);
}));

test('every direct content reference has a leading index for bounded cleanup', () => fixture(async ({ store }) => {
  const missing = [];
  for (const tableRow of store.rows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
    const table = String(tableRow.name);
    const indexes = store.rows(`PRAGMA index_list("${table}")`).map(index =>
      store.rows(`PRAGMA index_info("${String(index.name)}")`).sort((left, right) => Number(left.seqno) - Number(right.seqno)).map(column => String(column.name)));
    for (const foreignKey of store.rows(`PRAGMA foreign_key_list("${table}")`)) {
      if (foreignKey.table === 'contents' && !indexes.some(columns => columns[0] === String(foreignKey.from))) missing.push(`${table}.${foreignKey.from}`);
    }
  }
  assert.deepEqual(missing, []);
}));

test('database compaction reserves space for both the vacuum image and WAL commit', () => fixture(async ({ store }) => {
  const pageSize = Number(store.rows('PRAGMA page_size')[0].page_size);
  const usedPages = Number(store.rows('PRAGMA page_count')[0].page_count) - Number(store.rows('PRAGMA freelist_count')[0].freelist_count);
  const available = Math.ceil(usedPages * pageSize * 1.5 + 64 * 1024 * 1024);
  const originalStatfs = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: available, bsize: 1 });
  try {
    assert.throws(() => store.compactDatabaseStorage(), /database_compaction_space_insufficient/);
  } finally {
    fs.statfsSync = originalStatfs;
  }
}));

test('storage maintenance retires empty vanished SoloMap test projects before future startup discovery', () => fixture(async ({ workspace, store, ops }) => {
  const staleRoot = path.join(path.dirname(workspace), 'solomap-old-init-Ab12cd');
  fs.mkdirSync(staleRoot);
  const stale = await store.registerProject({ root: staleRoot });
  cleanupExact(staleRoot);

  assert.equal(store.registeredProjectRoots().includes(staleRoot), false, 'startup discovery excludes vanished test fixtures immediately');
  assert.equal(store.rows("SELECT status FROM project_locations WHERE project_id=?", [stale.projectId])[0].status, 'active');
  const cleaned = await ops({ operation: 'maintain_database_storage', input: { compact: false } });

  assert.equal(cleaned.retiredTestProjects, 1);
  assert.equal(store.registeredProjectRoots().includes(staleRoot), false);
  assert.equal(store.rows("SELECT status FROM project_locations WHERE project_id=?", [stale.projectId])[0].status, 'removed_test_fixture');
  assert.equal(store.rows('SELECT hidden FROM projects WHERE id=?', [stale.projectId])[0].hidden, 1);
  const retired = store.rows('SELECT revision,archived_at FROM objects WHERE id=?', [stale.projectId])[0];
  assert.equal(retired.revision, 3); assert.ok(retired.archived_at);
  const original = store.read(stale.projectId, 1);
  assert.equal(original.revision, 1); assert.equal(original.archivedAt, null); assert.equal(original.data.hidden, 0);
}));

test('storage maintenance preserves a vanished temporary project when database records still depend on it', () => fixture(async ({ workspace, store, ops, record }) => {
  const retainedRoot = path.join(path.dirname(workspace), 'solomap-old-init-Retain1');
  fs.mkdirSync(retainedRoot);
  const retained = await store.registerProject({ root: retainedRoot });
  store.upsertProjectRunIndex(retained.projectId, record(91));
  cleanupExact(retainedRoot);

  assert.ok(store.registeredProjectRoots().includes(retainedRoot));
  assert.equal((await ops({ operation: 'maintain_database_storage', input: { compact: false } })).retiredTestProjects, 0);
  assert.equal(store.rows("SELECT status FROM project_locations WHERE project_id=?", [retained.projectId])[0].status, 'active');
  assert.equal(store.rows('SELECT hidden FROM projects WHERE id=?', [retained.projectId])[0].hidden, 0);
  assert.equal(store.rows('SELECT archived_at FROM objects WHERE id=?', [retained.projectId])[0].archived_at, null);
}));

test('storage maintenance preserves vanished temporary projects with metadata, object references, or active migration work', () => fixture(async ({ workspace, store, ops }) => {
  const makeProject = async suffix => {
    const root = path.join(path.dirname(workspace), `solomap-old-init-${suffix}`);
    fs.mkdirSync(root);
    const project = await store.registerProject({ root });
    return { root, project };
  };
  const metadata = await makeProject('Metadata1');
  store.write({ kind: 'project', action: 'patch', scope: null, objectId: metadata.project.projectId, expectedRevision: 1,
    idempotencyKey: 'retain-test-project-metadata', data: { name: 'User project', notes_content: 'Keep this project' } });
  const referenced = await makeProject('Reference1');
  store.write({ kind: 'learning_event', action: 'create', scope: null, idempotencyKey: 'retain-test-project-reference',
    data: { source_object_id: referenced.project.projectId, source_revision: 1, event_type: 'completed', summary: 'Project is referenced', occurred_at: Date.now() } });
  const migrating = await makeProject('Migration1');
  store.enqueueMemoryMigration({ collection: 'documentation', projectRoot: migrating.root, sourceRoot: path.join(migrating.root, '.solopreneur', 'documentation.json') }, 'retain-active-project-migration');
  const scopedMigration = await makeProject('MigrationScope1');
  store.enqueueMemoryMigration({ sourceRoot: path.join(workspace, '.codex-memory'), projectScopes: { [scopedMigration.root]: scopedMigration.project.projectId } }, 'retain-active-project-scope-migration');
  const registered = await makeProject('Registry1');
  await store.initializeProjectRegistry({ legacyProjects: [{ name: path.basename(registered.root), path: registered.root }] });
  for (const item of [metadata, referenced, migrating, scopedMigration, registered]) cleanupExact(item.root);

  assert.equal((await ops({ operation: 'maintain_database_storage', input: { compact: false } })).retiredTestProjects, 0);
  for (const item of [metadata, referenced, migrating, scopedMigration, registered]) {
    assert.ok(store.registeredProjectRoots().includes(item.root));
    assert.equal(store.rows("SELECT status FROM project_locations WHERE project_id=?", [item.project.projectId])[0].status, 'active');
    assert.equal(store.rows('SELECT hidden FROM projects WHERE id=?', [item.project.projectId])[0].hidden, 0);
    assert.equal(store.rows('SELECT archived_at FROM objects WHERE id=?', [item.project.projectId])[0].archived_at, null);
  }
}));

test('storage maintenance checks shared content references once after multiple cleanup batches', () => fixture(async ({ project, store, ops }) => {
  const crypto = require('node:crypto'), bytes = Buffer.from('repeated task byproduct');
  const contentId = store.putContent(bytes, 'application/octet-stream', 'binary'), hash = crypto.createHash('sha256').update(bytes).digest('hex');
  store.db.run('BEGIN');
  try {
    for (let index = 0; index < 5001; index++) store.db.run('INSERT INTO project_run_artifacts(project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at) VALUES(?,?,?,?,?,?,?)', [project, 44, `__solo__/44/evidence/${index}.tmp`, contentId, hash, 'application/octet-stream', Date.now()]);
    store.db.run('COMMIT');
  } catch (error) { store.db.run('ROLLBACK'); throw error; }
  const referenceTables = store.rows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .flatMap(row => store.rows(`PRAGMA foreign_key_list(${row.name})`).filter(foreignKey => foreignKey.table === 'contents' && row.name !== 'content_chunks')).length;
  const originalRun = store.db.run.bind(store.db); let referenceSweeps = 0;
  store.db.run = (sql, values) => { if (String(sql).startsWith('DELETE FROM database_storage_cleanup_candidates WHERE content_id IN') && !String(sql).includes('storage_cleanup_batch')) referenceSweeps++; return originalRun(sql, values); };
  let cleaned;
  try { cleaned = await ops({ operation: 'maintain_database_storage', input: { compact: false } }); }
  finally { store.db.run = originalRun; }
  assert.equal(cleaned.deletedArtifacts, 5001); assert.equal(cleaned.deletedContents, 1);
  assert.equal(referenceSweeps, referenceTables, 'reference tables are swept once for the complete cleanup, not once per batch');
}));

test('direct references empty the cleanup queue before any historical JSON scan', () => fixture(async ({ project, store, ops }) => {
  const crypto = require('node:crypto'), bytes = Buffer.from('由耐久记录直接共享的正文');
  const contentId = store.putContent(bytes, 'application/octet-stream', 'binary'), hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const values = pathName => [project, 44, pathName, contentId, hash, 'application/octet-stream', Date.now()];
  store.db.run('INSERT INTO project_run_artifacts(project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at) VALUES(?,?,?,?,?,?,?)', values('__solo__/44/prompt.txt'));
  store.db.run('INSERT INTO project_run_artifacts(project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at) VALUES(?,?,?,?,?,?,?)', values('__solo__/44/evidence/copy.bin'));
  const protect = store.protectDatabaseStorageCleanupReferencesBatch;
  store.protectDatabaseStorageCleanupReferencesBatch = () => { throw new Error('unnecessary_history_scan'); };
  try { assert.equal((await ops({ operation: 'maintain_database_storage', input: { compact: false } })).deletedArtifacts, 1); }
  finally { store.protectDatabaseStorageCleanupReferencesBatch = protect; }
  assert.deepEqual(store.content(contentId), bytes);
}));

test('automatic storage maintenance skips current data without running a full inventory', () => fixture(async ({ store, ops }) => {
  const read = store.readDatabaseStorage; store.readDatabaseStorage = () => { throw new Error('full_inventory_called'); };
  try { assert.deepEqual(await ops({ operation: 'maintain_database_storage', input: { compact: false, automatic: true } }), { skipped: true, reason: 'storage_current' }); }
  finally { store.readDatabaseStorage = read; }
  assert.equal(store.rows('SELECT COUNT(*) AS count FROM database_storage_maintenance')[0].count, 0);
}));

test('database overview reads display metrics without running the full storage inventory', () => fixture(async ({ store, ops }) => {
  const original = store.readDatabaseStorage;
  store.readDatabaseStorage = () => { throw new Error('full_inventory_called'); };
  try {
    const overview = await ops({ operation: 'read_database_overview', input: {} });
    assert.equal(overview.contents.records, Number(store.rows('SELECT COUNT(*) AS records FROM contents INDEXED BY sqlite_autoindex_contents_1')[0].records));
    assert.ok(overview.databaseBytes > 0);
    assert.ok(overview.freePageBytes >= 0);
  } finally {
    store.readDatabaseStorage = original;
  }
}));

test('database overview reports a newer running maintenance instead of an older completion', () => fixture(async ({ store, ops }) => {
  store.db.run("INSERT INTO database_storage_maintenance VALUES(?,?,?,'completed','',0,0,0,0,0,?,?,?)", [
    'older-completed', 100, 200, 10, 9, 'ok'
  ]);
  store.db.run("INSERT INTO database_storage_maintenance VALUES(?,?,NULL,'running','',0,0,0,0,0,?,?,?)", [
    'newer-running', 300, 9, 9, 'not_checked'
  ]);
  const overview = await ops({ operation: 'read_database_overview', input: {} });
  assert.deepEqual(overview.lastMaintenance, { finishedAt: null, status: 'running' });
}));

test('automatic storage maintenance uses foreground-sized cleanup batches', () => fixture(async ({ project, store, ops }) => {
  const crypto = require('node:crypto');
  const bytes = Buffer.from('automatic cleanup must keep foreground requests responsive');
  const contentId = store.putContent(bytes, 'application/octet-stream', 'binary');
  store.db.run('INSERT INTO project_run_artifacts(project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at) VALUES(?,?,?,?,?,?,?)', [
    project, 44, '__solo__/44/evidence/automatic.tmp', contentId, crypto.createHash('sha256').update(bytes).digest('hex'), 'application/octet-stream', Date.now()
  ]);
  const originalCleanup = store.cleanupDatabaseStorageBatch.bind(store);
  const limits = [];
  store.cleanupDatabaseStorageBatch = (limit, maintenanceId) => {
    limits.push(limit);
    return originalCleanup(limit, maintenanceId);
  };
  try { await ops({ operation: 'maintain_database_storage', input: { compact: false, automatic: true } }); }
  finally { store.cleanupDatabaseStorageBatch = originalCleanup; }
  assert.ok(limits.length > 0);
  assert.ok(limits.every(limit => limit <= 250), `automatic cleanup batch was too large: ${limits.join(',')}`);
}));

test('manual storage maintenance waits for startup migration readiness', () => fixture(async ({ store, ops }) => {
  let release;
  ops.setStorageMaintenanceBarrier(new Promise(resolve => { release = resolve; }));
  const maintenance = ops({ operation: 'maintain_database_storage', input: { compact: false } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.rows('SELECT COUNT(*) AS count FROM database_storage_maintenance')[0].count, 0);
  release();
  assert.equal((await maintenance).pendingByproductRecords, 0);
}));

test('storage cleanup preserves content referenced from immutable object history', () => fixture(async ({ project, store, ops }) => {
  const crypto = require('node:crypto'), bytes = Buffer.from('仍由旧修订消费的完整正文🌿');
  const contentId = store.putContent(bytes, 'application/octet-stream', 'binary'), hash = crypto.createHash('sha256').update(bytes).digest('hex');
  store.db.run('INSERT INTO project_run_artifacts(project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at) VALUES(?,?,?,?,?,?,?)', [project, 44, '__solo__/44/evidence/historical-copy.bin', contentId, hash, 'application/octet-stream', Date.now()]);
  const evidence = store.write({ kind: 'evidence', action: 'create', scope: project, idempotencyKey: 'embedded-history-reference', data: { type: 'host_observation', source_actor_id: 'local-runtime', content: 'reference holder', observed_at: Date.now() } });
  const snapshot = store.putContent(JSON.stringify({ sourceContents: { original: contentId } }), 'application/json', 'utf8');
  store.db.run('UPDATE object_revisions SET content_id=? WHERE object_id=? AND revision=?', [snapshot, evidence.objectId, evidence.revision]);
  const cleaned = await ops({ operation: 'maintain_database_storage', input: { compact: false } });
  assert.equal(cleaned.deletedArtifacts, 1); assert.equal(cleaned.deletedContents, 0);
  assert.equal(store.rows('SELECT id FROM contents WHERE id=?', [contentId]).length, 1);
  assert.deepEqual(store.content(contentId), bytes);
}));

test('storage cleanup preserves source content referenced by a legacy review manifest', () => fixture(async ({ project, store, ops }) => {
  const crypto = require('node:crypto'), bytes = Buffer.from('旧复盘仍需读取的原始正文🌿');
  const contentId = store.putContent(bytes, 'application/octet-stream', 'binary'), hash = crypto.createHash('sha256').update(bytes).digest('hex');
  store.db.run('INSERT INTO project_run_artifacts(project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at) VALUES(?,?,?,?,?,?,?)', [project, 44, '__solo__/44/evidence/review-source.bin', contentId, hash, 'application/octet-stream', Date.now()]);
  const batch = store.write({ kind: 'review_batch', action: 'create', scope: null, idempotencyKey: 'legacy-review-reference', data: { input_cursor: 0, input_hash: hash, proposal_content: null, review_content: JSON.stringify({ sourceContents: { original: contentId } }), status: 'interrupted' } });
  const inputContentId = store.readMetadata(batch.objectId).data.review_content_id;
  store.db.run('INSERT INTO legacy_learning_review_controls VALUES(?,?,?,?)', [batch.objectId, inputContentId, 'legacy-review:test', 'run-1']);
  const cleaned = await ops({ operation: 'maintain_database_storage', input: { compact: false } });
  assert.equal(cleaned.deletedArtifacts, 1); assert.equal(cleaned.deletedContents, 0);
  assert.deepEqual(store.content(contentId), bytes);
}));

test('storage cleanup follows an old object revision through its review envelope to source content', () => fixture(async ({ project, store, ops }) => {
  const crypto = require('node:crypto'), bytes = Buffer.from('旧版本复盘信封间接引用的正文🌿');
  const contentId = store.putContent(bytes, 'application/octet-stream', 'binary'), hash = crypto.createHash('sha256').update(bytes).digest('hex');
  store.db.run('INSERT INTO project_run_artifacts(project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at) VALUES(?,?,?,?,?,?,?)', [project, 44, '__solo__/44/evidence/old-envelope-source.bin', contentId, hash, 'application/octet-stream', Date.now()]);
  const envelope = store.putContent(JSON.stringify({ sourceContents: { original: contentId } }), 'application/json', 'utf8');
  const evidence = store.write({ kind: 'evidence', action: 'create', scope: project, idempotencyKey: 'indirect-history-reference', data: { type: 'host_observation', source_actor_id: 'local-runtime', content: 'reference holder', observed_at: Date.now() } });
  const snapshot = store.putContent(JSON.stringify({ data: { review_content_id: envelope } }), 'application/json', 'utf8');
  store.db.run('UPDATE object_revisions SET content_id=? WHERE object_id=? AND revision=?', [snapshot, evidence.objectId, evidence.revision]);
  const cleaned = await ops({ operation: 'maintain_database_storage', input: { compact: false } });
  assert.equal(cleaned.deletedArtifacts, 1); assert.equal(cleaned.deletedContents, 0);
  assert.deepEqual(store.content(contentId), bytes);
}));

test('reusing queued content after the reference scan cancels its physical deletion', () => fixture(async ({ project, store }) => {
  const crypto = require('node:crypto'), bytes = Buffer.from('保护扫描后重新成为正式数据的正文🌿');
  const contentId = store.putContent(bytes, 'application/octet-stream', 'binary'), hash = crypto.createHash('sha256').update(bytes).digest('hex');
  store.db.run('INSERT INTO project_run_artifacts(project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at) VALUES(?,?,?,?,?,?,?)', [project, 44, '__solo__/44/evidence/reused.bin', contentId, hash, 'application/octet-stream', Date.now()]);
  assert.equal(store.cleanupDatabaseStorageBatch().deletedArtifacts, 1);
  store.prepareDatabaseStorageCleanup();
  for (const table of ['object_revisions', 'learning_review_controls', 'legacy_learning_review_controls', 'legacy_learning_review_cursor_inputs']) {
    let cursor = 0;
    for (;;) { const batch = store.protectDatabaseStorageCleanupReferencesBatch(table, cursor); if (batch.nextCursor === null) break; cursor = batch.nextCursor; }
  }
  assert.equal(store.putContent(bytes, 'application/octet-stream', 'binary'), contentId);
  assert.deepEqual(store.finalizeDatabaseStorageCleanupBatch(), { deletedContents: 0, reclaimedStoredBytes: 0, pending: false });
  assert.deepEqual(store.content(contentId), bytes);
}));

test('interrupted storage cleanup records failure and resumes its persistent content queue', () => fixture(async ({ project, store, ops }) => {
  const crypto = require('node:crypto'), bytes = crypto.randomBytes(128 * 1024), hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const contentId = store.putContent(bytes, 'application/octet-stream', 'binary');
  store.db.run('INSERT INTO project_run_artifacts(project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at) VALUES(?,?,?,?,?,?,?)', [project, 44, '__solo__/44/evidence/interrupted.bin', contentId, hash, 'application/octet-stream', Date.now()]);
  const interruptedId = store.beginDatabaseStorageMaintenance(Date.now(), store.databaseStorageFileSizes().databaseBytes);
  assert.equal(store.cleanupDatabaseStorageBatch(5000, interruptedId).deletedArtifacts, 1);
  const running = store.rows('SELECT status,deleted_artifacts FROM database_storage_maintenance WHERE id=?', [interruptedId])[0];
  assert.equal(running.status, 'running'); assert.equal(running.deleted_artifacts, 1);
  assert.equal(store.rows('SELECT COUNT(*) AS count FROM database_storage_cleanup_candidates')[0].count, 1);
  const resumed = await ops({ operation: 'maintain_database_storage', input: { compact: false } });
  assert.equal(resumed.deletedContents, 1); assert.equal(store.rows('SELECT id FROM contents WHERE id=?', [contentId]).length, 0);
  const failed = store.rows('SELECT status,error,deleted_artifacts FROM database_storage_maintenance WHERE id=?', [interruptedId])[0];
  assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'maintenance_interrupted'); assert.equal(failed.deleted_artifacts, 1);
  assert.equal(store.rows("SELECT COUNT(*) AS count FROM database_storage_maintenance WHERE status='completed'")[0].count, 1);
}));

test('journal import enriches missing legacy token fields without changing a native index', () => fixture(async ({ workspace, project, store, ops, record, read }) => {
  const { SqliteStore } = require('../out/db/sqliteStore.js');
  const source = path.join(workspace, '.solopreneur', 'project_journal.db');
  const directory = path.join(workspace, '.solopreneur', 'agent-runs', '__solo__', '12'); fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, 'output.log'); fs.writeFileSync(output, '完整旧计量\ntokens used\n12,345');
  const legacy = new SqliteStore(source, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex({ ...record(12), totalTokens: 0, outputPath: output }, [{ filePath: 'old-result.js', role: 'changed' }]); legacy.upsertRunIndex({ ...record(13), totalTokens: 999, outputPath: output }); }
  finally { legacy.close(); }
  store.upsertProjectRunIndex(project, { ...record(13), totalTokens: 88 });
  const job = await ops({ operation: 'import_project_data', input: { collection: 'project-journal', projectRoot: workspace, sourceRoot: source, idempotencyKey: 'impact-journal-enrich' } });
  await ops.waitForMigrations(); assert.equal(store.readMigrationJob(job.jobId).status, 'completed');
  const result = await read(); assert.equal(result.totalRuns, 2); assert.equal(result.totalTokens, 12433);
  assert.equal(store.readProjectRunIndexes(project).find(row => row.executionLogId === 13).totalTokens, 88);
}));

test('journal enrichment preserves a custom run-local output as indexed output instead of a byproduct', () => fixture(async ({ workspace, project, store, ops, record, read }) => {
  const { SqliteStore } = require('../out/db/sqliteStore.js');
  const source = path.join(workspace, '.solopreneur', 'project_journal.db');
  const run = path.join(workspace, '.solopreneur', 'agent-runs', '__solo__', '12'); fs.mkdirSync(run, { recursive: true });
  const output = path.join(run, 'declared-output.data'), relative = path.relative(path.join(workspace, '.solopreneur', 'agent-runs'), output);
  fs.writeFileSync(output, '完整旧计量\ntokens used\n12,345');
  const legacy = new SqliteStore(source, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex({ ...record(12), totalTokens: 0, outputPath: output }); } finally { legacy.close(); }
  const job = await ops({ operation: 'import_project_data', input: { collection: 'project-journal', projectRoot: workspace, sourceRoot: source, idempotencyKey: 'impact-custom-output' } });
  await ops.waitForMigrations(); assert.equal(store.readMigrationJob(job.jobId).status, 'completed'); assert.equal((await read()).totalTokens, 12345);
  assert.equal(store.rows('SELECT artifact_kind FROM project_run_artifacts WHERE project_id=? AND execution_log_id=12 AND relative_path=?', [project, relative])[0].artifact_kind, 'output');
  assert.equal(store.rows('SELECT source_kind FROM migration_items WHERE source_identity=? AND source_key=?', [`agent-runs:${workspace}`, relative])[0].source_kind, 'output');
  await ops({ operation: 'maintain_database_storage', input: { compact: false } });
  assert.equal(Buffer.from(store.readRunArtifact(project, 12, relative).bytes, 'base64').toString(), fs.readFileSync(output, 'utf8'));
}));

test('journal enrichment reclassifies a custom archived output after its physical source is gone', () => fixture(async ({ workspace, project, store, ops, record, read }) => {
  const crypto = require('node:crypto'), { SqliteStore } = require('../out/db/sqliteStore.js');
  const source = path.join(workspace, '.solopreneur', 'project_journal.db');
  const run = path.join(workspace, '.solopreneur', 'agent-runs', '__solo__', '12'); fs.mkdirSync(run, { recursive: true });
  const output = path.join(run, 'archived-output.data'), relative = path.relative(path.join(workspace, '.solopreneur', 'agent-runs'), output);
  const bytes = Buffer.from('已归档的完整旧计量\ntokens used\n12,345'), hash = crypto.createHash('sha256').update(bytes).digest('hex'); fs.writeFileSync(output, bytes);
  const legacy = new SqliteStore(source, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex({ ...record(12), totalTokens: 0, outputPath: output }); } finally { legacy.close(); }
  const contentId = store.putContent(bytes, 'application/octet-stream', 'binary');
  store.db.run('INSERT INTO project_run_artifacts(project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at) VALUES(?,?,?,?,?,?,?)', [project, 12, relative, contentId, hash, 'application/octet-stream', Date.now()]);
  store.captureMigrationSource({ identity: `agent-runs:${workspace}`, key: relative, hash }, bytes, { mimeType: 'application/octet-stream', encoding: 'binary' });
  fs.unlinkSync(output);
  const job = await ops({ operation: 'import_project_data', input: { collection: 'project-journal', projectRoot: workspace, sourceRoot: source, idempotencyKey: 'impact-archived-custom-output' } });
  await ops.waitForMigrations(); assert.equal(store.readMigrationJob(job.jobId).status, 'completed'); assert.equal((await read()).totalTokens, 12345);
  assert.equal(store.rows('SELECT artifact_kind FROM project_run_artifacts WHERE project_id=? AND execution_log_id=12 AND relative_path=?', [project, relative])[0].artifact_kind, 'output');
  assert.equal(store.rows('SELECT source_kind FROM migration_items WHERE source_identity=? AND source_key=?', [`agent-runs:${workspace}`, relative])[0].source_kind, 'output');
  await ops({ operation: 'maintain_database_storage', input: { compact: false } });
  assert.equal(Buffer.from(store.readRunArtifact(project, 12, relative).bytes, 'base64').toString(), bytes.toString());
}));

test('storage cleanup preserves a nested archived output declared by the retained run index', () => fixture(async ({ workspace, project, store, ops, record }) => {
  const crypto = require('node:crypto'), relative = '__solo__/12/archive/native-output.data';
  const bytes = Buffer.from('只剩数据库副本的嵌套历史输出🌿'), hash = crypto.createHash('sha256').update(bytes).digest('hex');
  store.upsertProjectRunIndex(project, { ...record(12), outputPath: relative });
  const contentId = store.putContent(bytes, 'application/octet-stream', 'binary');
  store.db.run('INSERT INTO project_run_artifacts(project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at) VALUES(?,?,?,?,?,?,?)', [project, 12, relative, contentId, hash, 'application/octet-stream', Date.now()]);
  store.captureMigrationSource({ identity: `agent-runs:${workspace}`, key: relative, hash }, bytes, { mimeType: 'application/octet-stream', encoding: 'binary' });
  assert.equal(store.rows('SELECT source_kind FROM migration_items WHERE source_identity=? AND source_key=?', [`agent-runs:${workspace}`, relative])[0].source_kind, 'byproduct');
  await ops({ operation: 'maintain_database_storage', input: { compact: false } });
  assert.equal(store.rows('SELECT artifact_kind FROM project_run_artifacts WHERE project_id=? AND execution_log_id=? AND relative_path=?', [project, 12, relative])[0].artifact_kind, 'output');
  assert.equal(store.rows('SELECT source_kind FROM migration_items WHERE source_identity=? AND source_key=?', [`agent-runs:${workspace}`, relative])[0].source_kind, 'output');
  assert.equal(Buffer.from(store.readRunArtifact(project, 12, relative).bytes, 'base64').toString(), bytes.toString());
}));

for (const hasOutput of [true, false]) test(`journal history captures the exact full native transcript and imports only run-local usage: hasOutput=${hasOutput}`, () => fixture(async ({ workspace, project, store, ops, record, read }) => {
  const { SqliteStore } = require('../out/db/sqliteStore.js');
  const source = path.join(workspace, '.solopreneur', 'project_journal.db');
  const run = path.join(workspace, '.solopreneur', 'agent-runs', '__solo__', '12'); fs.mkdirSync(run, { recursive: true });
  const sessionId = '73fd451d-df8d-4c5a-bffd-b5e5b6838a72';
  const home = path.join(path.dirname(workspace), 'native-home'); const sessions = path.join(home, 'sessions'); fs.mkdirSync(sessions, { recursive: true });
  const transcript = path.join(sessions, `rollout-2026-10-09-${sessionId}.jsonl`);
  const full = [JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: workspace } }), JSON.stringify({ type: 'event_msg', timestamp: '2026-10-09T08:59:00Z', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 500 } } } }), JSON.stringify({ type: 'event_msg', timestamp: '2026-10-09T09:01:00Z', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 800 } } } }), JSON.stringify({ type: 'message', payload: 'full retained evidence🌿'.repeat(60000) })].join('\n');
  fs.writeFileSync(transcript, full); fs.writeFileSync(path.join(run, 'session.json'), JSON.stringify({ sessionId })); fs.writeFileSync(path.join(run, 'codex-home.txt'), home);
  const output = path.join(run, 'output.log'); if (hasOutput) fs.writeFileSync(output, '旧日志本身没有计量');
  const legacy = new SqliteStore(source, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex({ ...record(12), totalTokens: 0, outputPath: output }); } finally { legacy.close(); }
  const job = await ops({ operation: 'import_project_data', input: { collection: 'project-journal', projectRoot: workspace, sourceRoot: source, idempotencyKey: 'impact-native-transcript' } });
  await ops.waitForMigrations(); assert.equal(store.readMigrationJob(job.jobId).status, 'completed'); assert.equal((await read()).totalTokens, 300);
  if (!hasOutput) assert.ok(store.readMigrationJob(job.jobId).progress.retainedGaps.some(item => item.error === 'historical_run_output_missing'));
  const evidence = store.rows("SELECT c.id FROM migration_items m JOIN contents c ON c.id=m.source_content_id WHERE m.source_identity=?", [`native-token-evidence:${project}`]);
  assert.equal(evidence.length, 1); assert.equal(store.content(evidence[0].id).toString('utf8'), full);
  fs.renameSync(transcript, `${transcript}-retained`); assert.equal((await read()).totalTokens, 300);
}));

test('ambiguous old runs with the same numeric ID are retained as a conflict instead of merged', () => fixture(async ({ workspace, store, ops, read }) => {
  const source = path.join(workspace, '.solopreneur', 'agent-runs');
  for (const node of ['one', 'two']) {
    const run = path.join(source, node, '12'); fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, 'command.txt'), 'codex exec'); fs.writeFileSync(path.join(run, 'started_at'), '2026-10-09T09:00:00Z'); fs.writeFileSync(path.join(run, 'output.log'), 'tokens used\n17');
  }
  const job = await ops({ operation: 'import_project_data', input: { collection: 'agent-runs', projectRoot: workspace, sourceRoot: source, idempotencyKey: 'ambiguous-old-run-ids' } });
  await ops.waitForMigrations(); const state = store.readMigrationJob(job.jobId);
  assert.equal(state.status, 'completed_with_conflicts'); assert.equal((await read()).totalRuns, 1);
  assert.ok(state.progress.conflicts.some(item => /identity_ambiguous/.test(item.error)));
}));

test('reconciliation enriches a source-bound historical index and preserves an identical native write', () => fixture(async ({ workspace, project, store, ops, record, read }) => {
  const crypto = require('node:crypto'); const { SqliteStore } = require('../out/db/sqliteStore.js');
  const source = path.join(workspace, '.solopreneur', 'project_journal.db');
  const run = path.join(workspace, '.solopreneur', 'agent-runs', '__solo__', '12'); fs.mkdirSync(run, { recursive: true });
  const output = path.join(run, 'output.log'); fs.writeFileSync(output, 'tokens used\n12,345');
  const legacy = new SqliteStore(source, path.resolve(__dirname, '..')); await legacy.init(); let entries;
  try { for (const id of [12, 13]) legacy.upsertRunIndex({ ...record(id), totalTokens: 0, outputPath: output }); entries = legacy.getRunIndexEntries(); }
  finally { legacy.close(); }
  const first = entries.find(entry => entry.executionLogId === 12), second = entries.find(entry => entry.executionLogId === 13);
  store.upsertProjectRunIndex(project, second, second.files, second.signals);
  const bytes = fs.readFileSync(source); const identity = `project-journal:${workspace}`;
  store.captureMigrationSource({ identity, key: path.basename(source), hash: crypto.createHash('sha256').update(bytes).digest('hex') }, bytes);
  store.markMigrationSourceImported(identity, path.basename(source));
  const {files,signals,...original}=first;
  store.importHistoricalRunIndex(project,original,files,signals,{identity,key:path.basename(source),hash:crypto.createHash('sha256').update(bytes).digest('hex')},20);
  const job = await ops({ operation: 'import_project_data', input: { collection: 'project-journal', projectRoot: workspace, sourceRoot: source, idempotencyKey: 'impact-preexisting-reconcile' } });
  await ops.waitForMigrations(); assert.equal(store.readMigrationJob(job.jobId).status, 'completed');
  assert.equal((await read()).totalTokens, 12345);
  assert.equal(store.readProjectRunIndexes(project).find(row => row.executionLogId === 13).totalTokens, 0);
}));

for (const rawFirst of [true, false]) test(`digest and raw imports retain missing token evidence in either order: rawFirst=${rawFirst}`, () => fixture(async ({ workspace, store, ops, read }) => {
  const source = path.join(workspace, '.solopreneur', 'agent-runs'); const run = path.join(source, '__solo__', '12'); fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'command.txt'), 'codex'); fs.writeFileSync(path.join(run, 'started_at'), '2026-10-09T09:00:00Z'); fs.writeFileSync(path.join(run, 'output.log'), 'tokens used\n12,345');
  const digestRoot = path.join(workspace, '.solopreneur', 'run-digests'); fs.mkdirSync(digestRoot);
  fs.writeFileSync(path.join(digestRoot, '12.json'), JSON.stringify({ schemaVersion: 2, runId: 'solo:12', executionLogId: 12, nodeId: '__solo__', runKind: 'solo', agentCli: 'codex', status: 'Completed', startedAt: '2026-10-09T09:00:00Z', finishedAt: '2026-10-09T09:03:00Z', durationMs: 180000, changedFiles: ['digest-result.js'], tokenUsage: { totalTokens: 0 }, rawRefs: { executionLogId: 12, outputPath: '.solopreneur/agent-runs/__solo__/12/output.log' } }));
  const collections = rawFirst ? ['agent-runs', 'run-digests'] : ['run-digests', 'agent-runs'];
  const healthDuring = []; const importDigest = store.importRunDigestSource.bind(store);
  store.importRunDigestSource = (...args) => { const result = importDigest(...args); healthDuring.push(store.readRunIndexHealth(args[0]).ok); return result; };
  for (const collection of collections) { const job = await ops({ operation: 'import_project_data', input: { collection, projectRoot: workspace, sourceRoot: collection === 'agent-runs' ? source : digestRoot, idempotencyKey: `impact-order:${rawFirst}:${collection}` } }); await ops.waitForMigrations(); assert.equal(store.readMigrationJob(job.jobId).status, 'completed'); }
  assert.equal(healthDuring[0], false);
  const result = await read(); assert.equal(result.totalRuns, 1); assert.equal(result.totalTokens, 12345); assert.equal(result.completedRuns, 1); assert.equal(result.totalMinutes, 3); assert.equal(result.changedFiles, 1);
}));

test('changed raw evidence remains a captured conflict without replacing a previously committed contribution', () => fixture(async ({ workspace, project, store, ops, read }) => {
  const source = path.join(workspace, '.solopreneur', 'agent-runs'); const run = path.join(source, '__solo__', '12'); fs.mkdirSync(run, { recursive: true });
  const output = path.join(run, 'output.log'); fs.writeFileSync(output, 'tokens used\n17'); fs.writeFileSync(path.join(run, 'command.txt'), 'codex'); fs.writeFileSync(path.join(run, 'started_at'), '2026-10-09T09:00:00Z');
  const importOnce = async key => { const job = await ops({ operation: 'import_project_data', input: { collection: 'agent-runs', projectRoot: workspace, sourceRoot: source, idempotencyKey: key } }); await ops.waitForMigrations(); return store.readMigrationJob(job.jobId); };
  assert.equal((await importOnce('conflict-first')).status, 'completed'); const first = await read(); assert.equal(first.totalTokens, 17);
  fs.writeFileSync(output, '新完整原文\ntokens used\n88'); assert.equal((await importOnce('conflict-after-source-edit')).status, 'completed_with_conflicts');
  assert.deepEqual(await read(), first);
  assert.equal(Buffer.from(store.readRunArtifact(project, 12, '__solo__/12/output.log').bytes, 'base64').toString(), 'tokens used\n17');
  const capture = store.rows('SELECT source_content_id FROM migration_items WHERE source_identity=? AND source_key=?', [`agent-runs:${workspace}`, '__solo__/12/output.log'])[0];
  assert.equal(store.content(capture.source_content_id).toString(), '新完整原文\ntokens used\n88');
}));

test('a retained prompt-only old run is represented without inventing completion or token usage', () => fixture(async ({ workspace, store, ops, read }) => {
  const source = path.join(workspace, '.solopreneur', 'agent-runs'); const run = path.join(source, 'pending', '12'); fs.mkdirSync(run, { recursive: true }); fs.writeFileSync(path.join(run, 'prompt.txt'), '旧任务还未执行的完整要求');
  const job = await ops({ operation: 'import_project_data', input: { collection: 'agent-runs', projectRoot: workspace, sourceRoot: source, idempotencyKey: 'old-prompt-only' } });
  await ops.waitForMigrations(); assert.equal(store.readMigrationJob(job.jobId).status, 'completed');
  const result = await read(); assert.equal(result.totalRuns, 1); assert.equal(result.completedRuns, 0); assert.equal(result.totalTokens, 0);
}));

const { SqliteStore } = require('../out/db/sqliteStore.js');
for (const family of ['codex', 'claude']) for (const finished of ['valid', 'missing', 'invalid']) test(`historical ${family} ${finished} usage ends at each retained run boundary within one continued native session`, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-impact-session-boundary-'));
  const workspace = path.join(base, 'project'); fs.mkdirSync(workspace);
  const dataRoot = path.join(base, 'global'); const nativeHome = path.join(base, 'native-home');
  const previousHome = process.env.HOME;
  if (family === 'claude') process.env.HOME = nativeHome;
  const sessionId = '73fd451d-df8d-4c5a-bffd-b5e5b6838a72';
  const transcripts = family === 'codex' ? path.join(nativeHome, 'sessions') : path.join(nativeHome, '.claude', 'projects', 'fixture');
  fs.mkdirSync(transcripts, {recursive:true});
  const transcript = path.join(transcripts, family === 'codex' ? `rollout-2026-10-09-${sessionId}.jsonl` : `${sessionId}.jsonl`);
  const event = (timestamp, total, id) => family === 'codex'
    ? {type:'event_msg',timestamp,payload:{type:'token_count',info:{total_token_usage:{total_tokens:total}}}}
    : {type:'assistant',timestamp,cwd:workspace,message:{id,usage:{input_tokens:total,output_tokens:0}}};
  const full = [family === 'codex' ? {type:'session_meta',payload:{id:sessionId,cwd:workspace}} : {type:'user',cwd:workspace},
    ...(family === 'codex' ? [event('2026-10-09T08:59:00Z',500,'before')] : []),
    event('2026-10-09T09:05:00Z',family === 'codex' ? 800 : 300,'first'),
    event('2026-10-09T10:05:00Z',family === 'codex' ? 1200 : 400,'second')].map(x=>JSON.stringify(x)).join('\n');
  fs.writeFileSync(transcript,full);
  const source = path.join(workspace,'.solopreneur','project_journal.db');
  const store = new UnifiedDataStore(dataRoot); const ops = createRuntimeDataOperations(store);
  const legacy = new SqliteStore(source,path.resolve(__dirname,'..'));
  try {
    const project = (await store.registerProject({root:workspace})).projectId;
    await legacy.init();
    for (const [id,startedAt,finishedAt] of [[12,'2026-10-09T09:00:00Z','2026-10-09T09:10:00Z'],[13,'2026-10-09T10:00:00Z','2026-10-09T10:10:00Z']]) {
      const run = path.join(workspace,'.solopreneur','agent-runs','__solo__',String(id));fs.mkdirSync(run,{recursive:true});
      const outputPath=path.join(run,'output.log');fs.writeFileSync(outputPath,'完整旧日志无计量');
      fs.writeFileSync(path.join(run,'session.json'),JSON.stringify({sessionId}));
      if(family==='codex')fs.writeFileSync(path.join(run,'codex-home.txt'),nativeHome);
      legacy.upsertRunIndex({executionLogId:id,nodeId:'__solo__',runKind:'solo',agentCli:family,status:'Completed',startedAt,finishedAt:finished==='valid'?finishedAt:finished==='invalid'?'2026-10-09T08:00:00Z':'',durationMs:600000,totalTokens:0,outputPath});
    }
    legacy.close();
    const job=await ops({operation:'import_project_data',input:{collection:'project-journal',projectRoot:workspace,sourceRoot:source,idempotencyKey:'bounded-session-history'}});
    await ops.waitForMigrations();assert.equal(store.readMigrationJob(job.jobId).status,'completed');
    assert.deepEqual(store.readProjectRunIndexes(project).sort((a,b)=>a.executionLogId-b.executionLogId).map(x=>x.totalTokens),finished==='valid'?[300,400]:[0,0]);
    if(finished!=='valid') assert.equal(store.readMigrationJob(job.jobId).progress.retainedGaps.filter(x=>x.error==='historical_token_window_missing').length,2);
    const captured=store.rows('SELECT source_content_id FROM migration_items WHERE source_identity=?',[`native-token-evidence:${project}`]);
    assert.equal(captured.length,1);assert.equal(store.content(captured[0].source_content_id).toString(),full);
  } finally {
    try{legacy.close();}catch{}
    await ops.close();store.close();
    if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;
    cleanupExact(base);
  }
});

const {enqueueStartupDataMigrations,historicalRunOwnerStateStamp}=require('../out/runtimeDatabaseBootstrap.js');
test('automatic migration discovery never enters task byproduct directories',async()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-impact-discovery-'));
 const workspace=path.join(base,'project');fs.mkdirSync(workspace);
 const store=new UnifiedDataStore(path.join(base,'global'));const ops=createRuntimeDataOperations(store);
 const run=path.join(workspace,'.solopreneur','agent-runs','__solo__','12'),evidence=path.join(run,'evidence');fs.mkdirSync(evidence,{recursive:true});
 fs.writeFileSync(path.join(run,'prompt.txt'),'耐久提示词');fs.writeFileSync(path.join(evidence,'toolchain.bin'),'副产物');
 await store.registerProject({root:workspace});
 const original=fs.promises.readdir;let byproductReads=0;
 fs.promises.readdir=async function(directory,...args){if(path.resolve(String(directory))===path.resolve(evidence))byproductReads++;return original.call(this,directory,...args);};
 try{
  await historicalRunOwnerStateStamp(store,()=>true);
  await enqueueStartupDataMigrations(store,ops,()=>true);await ops.waitForMigrations();
  assert.equal(byproductReads,0);
 }finally{fs.promises.readdir=original;await ops.close();store.close();cleanupExact(base);}
});
test('normal upgrade supersedes the last agent-run migration version and enables unresolved source archiving',async()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-impact-startup-upgrade-'));
 const workspace=path.join(base,'project');fs.mkdirSync(workspace);
 const store=new UnifiedDataStore(path.join(base,'global'));const ops=createRuntimeDataOperations(store);
 try{
  const project=(await store.registerProject({root:workspace})).projectId;
  const sourceRoot=path.join(workspace,'.solopreneur','agent-runs');const run=path.join(sourceRoot,'__solo__','12');fs.mkdirSync(run,{recursive:true});
  fs.writeFileSync(path.join(run,'command.txt'),'codex');fs.writeFileSync(path.join(run,'output.log'),'完整历史日志\ntokens used\n12,345');
  const args={collection:'agent-runs',sourceRoot,projectRoot:workspace};
  let currentKey='';
  await enqueueStartupDataMigrations(store,async request=>{
   if(request.operation==='import_project_data'&&request.input.collection==='agent-runs')currentKey=request.input.idempotencyKey;
   return {jobId:'key-probe',status:'completed'};
  },()=>true);
  assert.match(currentKey,/^startup-agent-runs-v10:/);
  const prior=store.enqueueMemoryMigration(args,currentKey.replace(/^startup-agent-runs-v10:/,'startup-agent-runs-v9:'));
  store.updateMigrationJob(prior.jobId,'completed_with_conflicts',{imported:0,unchanged:0,originalBytes:fs.statSync(path.join(run,'output.log')).size,conflicts:[{source:run,error:'Error: historical_run_identity_ambiguous'}],retainedFiles:[run],interrupted:false});
  assert.equal(store.readProjectImpactRuns(project).length,0);
  await enqueueStartupDataMigrations(store,ops,()=>true);await ops.waitForMigrations();
  assert.deepEqual(store.readProjectRunIndexes(project).map(x=>[x.executionLogId,x.totalTokens]),[[12,12345]]);
  const upgraded=store.migrationJobs().find(job=>job.args.collection==='agent-runs'&&job.jobId!==prior.jobId);
  assert.equal(upgraded.args.archiveUnresolved,true);
  const jobs=store.migrationJobCount();const sourceState=store.rows('SELECT source_identity,source_key,source_hash,source_capture_revision FROM migration_items ORDER BY source_key');
  await enqueueStartupDataMigrations(store,ops,()=>true);await ops.waitForMigrations();
  assert.equal(store.migrationJobCount(),jobs);assert.deepEqual(store.rows('SELECT source_identity,source_key,source_hash,source_capture_revision FROM migration_items ORDER BY source_key'),sourceState);
 }finally{await ops.close();store.close();cleanupExact(base);}
});

test('normal upgrade supersedes an old agent-run conflict after its entire legacy source root was retired',async()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'solomap-impact-retired-upgrade-'));
 const workspace=path.join(base,'project');fs.mkdirSync(workspace);
 const store=new UnifiedDataStore(path.join(base,'global'));const ops=createRuntimeDataOperations(store);
 try{
  await store.registerProject({root:workspace});
  const sourceRoot=path.join(workspace,'.solopreneur','agent-runs');
  const prior=store.enqueueMemoryMigration({collection:'agent-runs',sourceRoot,projectRoot:workspace},`startup-agent-runs-v9:${workspace}:retired`);
  store.updateMigrationJob(prior.jobId,'completed_with_conflicts',{conflicts:[{source:path.join(workspace,'.solopreneur','agent-status','1.json'),error:'historical_run_input_missing'}]});
  await enqueueStartupDataMigrations(store,ops,()=>true);await ops.waitForMigrations();
  const latest=store.migrationJobSummaries().find(job=>job.args.collection==='agent-runs'&&job.args.sourceRoot===sourceRoot);
  assert.notEqual(latest.jobId,prior.jobId);
  assert.equal(latest.args.archiveUnresolved,true);
  assert.equal(latest.status,'completed');
 }finally{await ops.close();store.close();cleanupExact(base);}
});

test('normal upgrade rechecks journal conflicts with the dependency-ordered reconciliation version', () => fixture(async ({ workspace, store, ops, record }) => {
  const source = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(source, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex({ ...record(12), totalTokens: 0, outputPath: path.join(workspace, '.solopreneur', 'agent-runs', '__solo__', '12', 'output.log') }); } finally { legacy.close(); }
  const args = { collection: 'project-journal', sourceRoot: source, projectRoot: workspace };
  const old = store.enqueueMemoryMigration(args, `startup-project-journal-v5:${workspace}`);
  store.updateMigrationJob(old.jobId, 'completed_with_conflicts', { conflicts: [{ source, error: 'historical_run_output_missing' }] });
  const before = store.migrationJobs().filter(job => job.args.collection === 'project-journal').length; await enqueueStartupDataMigrations(store, ops, () => true); await ops.waitForMigrations();
  assert.equal(store.migrationJobs().filter(job => job.args.collection === 'project-journal').length, before + 1);
  const latest = store.migrationJobSummaries().find(job => job.args.collection === 'project-journal' && job.args.sourceRoot === source);
  assert.equal(latest.status, 'completed');
  assert.deepEqual(latest.progress.conflicts, []);
  assert.ok(store.migrationJobs().some(job => job.progress.retainedGaps?.some(item => item.error === 'historical_run_output_missing')));
  const afterUpgrade = store.migrationJobCount();
  await enqueueStartupDataMigrations(store, ops, () => true); await ops.waitForMigrations();
  assert.equal(store.migrationJobCount(), afterUpgrade);
  assert.equal(store.readMigrationJob(latest.jobId).status, 'completed');
}));

test('startup queues historical run evidence before the journal that reconciles it', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-impact-migration-order-'));
  const workspace = path.join(base, 'project'); fs.mkdirSync(path.join(workspace, '.solopreneur', 'agent-runs'), { recursive: true });
  const source = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(source, path.resolve(__dirname, '..')); await legacy.init(); legacy.close();
  const store = new UnifiedDataStore(path.join(base, 'global')); const requests = [];
  let ops;
  try {
    await store.registerProject({ root: workspace });
    await enqueueStartupDataMigrations(store, async request => {
      requests.push(request);
      const { idempotencyKey, refreshCompleted: _refreshCompleted, ...args } = request.input;
      return store.enqueueMemoryMigration(args, idempotencyKey);
    }, () => true);
    const physical = requests.filter(request => request.operation === 'import_project_data' && ['agent-runs', 'project-journal'].includes(request.input.collection));
    assert.deepEqual(physical.map(request => request.input.collection), ['agent-runs', 'project-journal']);
    const jobs = store.rows("SELECT id,json_extract(args_json,'$.collection') AS collection FROM migration_jobs WHERE json_extract(args_json,'$.sourceRoot') IN (?,?) ORDER BY rowid", [path.join(workspace, '.solopreneur', 'agent-runs'), source]);
    assert.deepEqual(jobs.map(job => job.collection), ['agent-runs', 'project-journal']);
    store.db.run('UPDATE migration_jobs SET id=?,created_at=? WHERE id=?', ['run-z', 42, jobs[0].id]);
    store.db.run('UPDATE migration_jobs SET id=?,created_at=? WHERE id=?', ['journal-a', 42, jobs[1].id]);
    assert.deepEqual(store.pendingMigrationJobs().filter(job => ['run-z', 'journal-a'].includes(job.jobId)).map(job => job.args.collection), ['agent-runs', 'project-journal']);
    const started = [], update = store.updateMigrationJob.bind(store);
    store.updateMigrationJob = (jobId, status, progress, error) => { if (status === 'running' && ['run-z', 'journal-a'].includes(jobId)) started.push(store.readMigrationJob(jobId).args.collection); return update(jobId, status, progress, error); };
    ops = createRuntimeDataOperations(store); ops.recoverMigrations(); await ops.waitForMigrations();
    assert.deepEqual(started, ['agent-runs', 'project-journal']);
  } finally { if (ops) await ops.close(); store.close(); cleanupExact(base); }
});


test('published unmarked index is reconciled by equal source content without claiming its ownership', async () => {
  const crypto = require('node:crypto');
  const { DiskDatabase } = require('../out/db/diskDatabase.js');
  const { unifiedSchemaSql } = require('../out/db/unifiedSchema.js');
  const { unifiedSchemaMigrations } = require('../out/db/unifiedSchemaMigrations.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-impact-published-native-'));
  const root = path.join(base, 'global'); const workspace = path.join(base, 'project'); fs.mkdirSync(workspace);
  const project = crypto.randomUUID(); const now = Date.now();
  const run = path.join(workspace, '.solopreneur', 'agent-runs', '__solo__', '12'); fs.mkdirSync(run, {recursive:true});
  fs.writeFileSync(path.join(workspace, '.solopreneur', 'project.json'), JSON.stringify({schemaVersion:1,projectId:project}));
  const output = path.join(run,'output.log'); const outputBody='完整历史计量\ntokens used\n12,345';fs.writeFileSync(output,outputBody);
  const source = path.join(workspace,'.solopreneur','project_journal.db');
  const legacy = new SqliteStore(source,path.resolve(__dirname,'..')); await legacy.init();let entry;
  try {
    legacy.upsertRunIndex({executionLogId:12,nodeId:'__solo__',runKind:'solo',agentCli:'codex',status:'Completed',startedAt:'2026-10-09T09:00:00Z',finishedAt:'2026-10-09T09:10:00Z',durationMs:600000,totalTokens:0,outputPath:output});
    entry=legacy.getRunIndexEntries()[0];
  } finally {legacy.close();}
  const {files,signals,...record}=entry;
  const db=new DiskDatabase(path.join(root,'solomap.db'),{foreignKeys:false});
  const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');const sql=unifiedSchemaSql();
  try {
    db.run(sql);db.run('INSERT INTO schema_migrations VALUES(1,?,?)',[hash(sql),now]);
    for(const migration of unifiedSchemaMigrations.filter(item=>item.version<=11)){db.run(migration.sql);db.run('INSERT INTO schema_migrations VALUES(?,?,?)',[migration.version,hash(migration.sql),now]);}
    db.run('INSERT INTO database_meta VALUES(?,?)',['database_id',crypto.randomUUID()]);db.run('INSERT INTO database_meta VALUES(?,?)',['protocol_version','1']);
    db.run('INSERT INTO actors(id,kind,provider) VALUES(?,?,?)',['local-runtime','runtime','solomap']);
    db.run('INSERT INTO objects VALUES(?,?,NULL,?,?,?,NULL)',[project,'project',1,now,now]);db.run('INSERT INTO projects(id,name) VALUES(?,?)',[project,'Historical project']);
    db.run('INSERT INTO project_run_indexes VALUES(?,?,?,?,?,?)',[project,12,JSON.stringify(record),JSON.stringify(files),JSON.stringify(signals),now]);
  }finally{db.close();}
  let store=new UnifiedDataStore(root);let ops=createRuntimeDataOperations(store);
  try{
    await store.registerProject({root:workspace});
    const bytes=fs.readFileSync(source);const identity=`project-journal:${workspace}`;
    store.captureMigrationSource({identity,key:path.basename(source),hash:hash(bytes)},bytes);store.markMigrationSourceImported(identity,path.basename(source));
    const job=await ops({operation:'import_project_data',input:{collection:'project-journal',projectRoot:workspace,sourceRoot:source,idempotencyKey:'published-native-reconcile'}});
    await ops.waitForMigrations();
    assert.equal(store.readProjectRunIndexes(project)[0].totalTokens,0,'an imported source is not ownership proof of an equal native index');
    assert.equal(store.readMigrationJob(job.jobId).status,'completed');
    assert.deepEqual(store.readMigrationJob(job.jobId).progress.conflicts,[]);
    assert.equal(store.rows('SELECT * FROM run_index_import_sources WHERE project_id=? AND execution_log_id=?',[project,12]).length,0,'content reconciliation must not invent historical ownership');
    assert.equal(Buffer.from(store.readRunArtifact(project,12,'__solo__/12/output.log').bytes,'base64').toString(),outputBody);
    assert.equal(store.readMigrationSource(identity,path.basename(source)).bytes.compare(bytes),0);
    assert.equal(store.readMigrationSource(identity,path.basename(source)).stage,'imported');
    const {MigrationRecycling}=require('../out/migrationRecycling.js');
    assert.deepEqual((await new MigrationRecycling(store).prepare()).files.map(item=>item.path),[source]);
    await ops.close();store.close();store=new UnifiedDataStore(root);ops=createRuntimeDataOperations(store);
    assert.equal(store.readProjectRunIndexes(project)[0].totalTokens,0);
  }finally{await ops.close();store.close();cleanupExact(base);}
});

test('published unmarked index with different content remains an ownership conflict', () => fixture(async ({ workspace, project, store, record }) => {
  const sourceRecord = record(12); const currentRecord = { ...sourceRecord, status: 'Failed' };
  store.importProjectRunIndex(project, currentRecord, [], []);
  assert.throws(() => store.importHistoricalRunIndex(project, sourceRecord, [], [], {
    identity: `project-journal:${workspace}`, key: 'project_journal.db', hash: 'source-hash'
  }, 20, sourceRecord), /historical_run_index_owner_unknown/);
  assert.equal(store.readProjectRunIndexes(project)[0].status, 'Failed');
  assert.equal(store.rows('SELECT * FROM run_index_import_sources WHERE project_id=? AND execution_log_id=?', [project, 12]).length, 0);
}));

test('published unmarked index reconciles equal files and signals stored in a different order', () => fixture(async ({ workspace, project, store, record }) => {
  const sourceRecord = record(12);
  const files = [{ filePath: 'src/a.ts', role: 'changed' }, { filePath: 'docs/a.md', role: 'touched' }];
  const signals = [
    { executionLogId: 12, type: 'failure', value: 'first failure' },
    { executionLogId: 12, type: 'reusable', value: 'reusable result' },
    { executionLogId: 12, type: 'failure', value: 'second failure' }
  ];
  store.importProjectRunIndex(project, sourceRecord, [...files].reverse(), [...signals].reverse());
  assert.equal(store.importHistoricalRunIndex(project, sourceRecord, files, signals, {
    identity: `project-journal:${workspace}`, key: 'project_journal.db', hash: 'source-hash'
  }, 20, sourceRecord), false);
  assert.deepEqual(store.readProjectRunIndexes(project)[0].files, [...files].reverse());
  assert.deepEqual(store.readProjectRunIndexes(project)[0].signals, [...signals].reverse());
  assert.equal(store.rows('SELECT * FROM run_index_import_sources WHERE project_id=? AND execution_log_id=?', [project, 12]).length, 0);
}));

test('agent run replay reconciles an equal unmarked index but keeps every run file outside recycling', () => fixture(async ({ workspace, project, store, ops }) => {
  const source = path.join(workspace, '.solopreneur', 'agent-runs'); const run = path.join(source, '__solo__', '12'); fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'command.txt'), 'codex'); fs.writeFileSync(path.join(run, 'started_at'), '2026-10-09T09:00:00Z'); fs.writeFileSync(path.join(run, 'output.log'), 'tokens used\n17');
  const first = await ops({ operation: 'import_project_data', input: { collection: 'agent-runs', projectRoot: workspace, sourceRoot: source, idempotencyKey: 'unmarked-agent-run-first' } });
  await ops.waitForMigrations(); assert.equal(store.readMigrationJob(first.jobId).status, 'completed');
  store.db.run('DELETE FROM run_index_import_sources WHERE project_id=? AND execution_log_id=?', [project, 12]);
  const { MigrationRecycling } = require('../out/migrationRecycling.js');
  assert.deepEqual((await new MigrationRecycling(store).prepare()).files, []);
  const replay = await ops({ operation: 'import_project_data', input: { collection: 'agent-runs', projectRoot: workspace, sourceRoot: source, idempotencyKey: 'unmarked-agent-run-replay' } });
  await ops.waitForMigrations(); assert.equal(store.readMigrationJob(replay.jobId).status, 'completed');
  assert.deepEqual(store.readMigrationJob(replay.jobId).progress.conflicts, []);
  assert.deepEqual((await new MigrationRecycling(store).prepare()).files, []);
}));

test('an approved run recycling plan stops when its run index loses source ownership', () => fixture(async ({ workspace, project, store, ops }) => {
  const source = path.join(workspace, '.solopreneur', 'agent-runs'); const run = path.join(source, '__solo__', '12'); fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'command.txt'), 'codex'); fs.writeFileSync(path.join(run, 'started_at'), '2026-10-09T09:00:00Z'); fs.writeFileSync(path.join(run, 'output.log'), 'tokens used\n17');
  const job = await ops({ operation: 'import_project_data', input: { collection: 'agent-runs', projectRoot: workspace, sourceRoot: source, idempotencyKey: 'owned-agent-run' } });
  await ops.waitForMigrations(); assert.equal(store.readMigrationJob(job.jobId).status, 'completed');
  const { MigrationRecycling } = require('../out/migrationRecycling.js'); const recycling = new MigrationRecycling(store);
  const plan = await recycling.prepare(); assert.ok(plan.files.length >= 3); recycling.confirm(plan.planId);
  store.db.run('DELETE FROM run_index_import_sources WHERE project_id=? AND execution_log_id=?', [project, 12]);
  const result = await recycling.recycleBatch(plan.files.map(item => item.itemId));
  assert.deepEqual(new Set(result.failures), new Set(plan.files.map(item => item.itemId)));
  for (const item of plan.files) assert.equal(fs.existsSync(item.path), true);
}));


for(const journalPath of ['declared','absent']) test(`journal conversion restores precise archived output with ${journalPath} path when raw physical evidence is unavailable and keeps tokens across restart`, () => fixture(async ({workspace,root,project,store,ops,record,closeOwner}) => {
  const sourceRoot=path.join(workspace,'.solopreneur','agent-runs');const run=path.join(sourceRoot,'__solo__','12');fs.mkdirSync(run,{recursive:true});
  const outputPath=path.join(run,'output.log');const body='完整归档计量🌿'.repeat(1000)+'\ntokens used\n12,345';fs.writeFileSync(outputPath,body);fs.writeFileSync(path.join(run,'command.txt'),'codex');
  const journal=path.join(workspace,'.solopreneur','project_journal.db');const legacy=new SqliteStore(journal,path.resolve(__dirname,'..'));await legacy.init();
  try{legacy.upsertRunIndex({...record(12),totalTokens:0,outputPath:journalPath==='declared'?outputPath:''});}finally{legacy.close();}
  const raw=await ops({operation:'import_project_data',input:{collection:'agent-runs',sourceRoot,projectRoot:workspace,idempotencyKey:'archive-before-journal'}});await ops.waitForMigrations();assert.equal(store.readMigrationJob(raw.jobId).status,'completed');assert.equal(store.readProjectRunIndexes(project)[0].totalTokens,12345);
  fs.renameSync(sourceRoot,sourceRoot+'-retained');
  const job=await ops({operation:'import_project_data',input:{collection:'project-journal',sourceRoot:journal,projectRoot:workspace,idempotencyKey:'journal-after-archive'}});await ops.waitForMigrations();
  assert.equal(store.readProjectRunIndexes(project)[0].totalTokens,12345);
  assert.equal(store.readMigrationJob(job.jobId).status,'completed');
  assert.equal(Buffer.from(store.readRunArtifact(project,12,'__solo__/12/output.log').bytes,'base64').toString(),body);
  const {MigrationRecycling}=require('../out/migrationRecycling.js');assert.deepEqual((await new MigrationRecycling(store).prepare()).files.map(x=>x.path),[journal]);
  await closeOwner();const reopened=new UnifiedDataStore(root);try{assert.equal(reopened.readProjectRunIndexes(project)[0].totalTokens,12345);assert.equal(Buffer.from(reopened.readRunArtifact(project,12,'__solo__/12/output.log').bytes,'base64').toString(),body);}finally{reopened.close();}
}));

for(const knownTokens of [0,88]) test(`missing declared historical output is recorded as a non-retryable gap with known tokens=${knownTokens}`,()=>fixture(async({workspace,project,store,ops,record})=>{
  const journal=path.join(workspace,'.solopreneur','project_journal.db');const outputPath=path.join(workspace,'.solopreneur','agent-runs','__solo__','12','output.log');
  const legacy=new SqliteStore(journal,path.resolve(__dirname,'..'));await legacy.init();try{legacy.upsertRunIndex({...record(12),totalTokens:knownTokens,outputPath});}finally{legacy.close();}
  const bytes=fs.readFileSync(journal);const job=await ops({operation:'import_project_data',input:{collection:'project-journal',sourceRoot:journal,projectRoot:workspace,idempotencyKey:'missing-historical-body'}});await ops.waitForMigrations();
  assert.equal(store.readMigrationJob(job.jobId).status,'completed');
  assert.deepEqual(store.readMigrationJob(job.jobId).progress.conflicts,[]);
  assert.ok(store.readMigrationJob(job.jobId).progress.retainedGaps.some(x=>x.error==='historical_run_output_missing'));
  assert.equal(store.readProjectRunIndexes(project)[0].totalTokens,knownTokens);
  assert.equal(store.readMigrationSource(`project-journal:${workspace}`,path.basename(journal)).bytes.compare(bytes),0);
  assert.equal(store.readMigrationSource(`project-journal:${workspace}`,path.basename(journal)).stage,'imported');
  const {MigrationRecycling}=require('../out/migrationRecycling.js');assert.deepEqual((await new MigrationRecycling(store).prepare()).files.map(item=>item.path),[journal]);
}));

test('retained migration gaps remain auditable after the database owner restarts', () => fixture(async ({ root, workspace, store, ops, record, closeOwner }) => {
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex({ ...record(12), totalTokens: 0, outputPath: path.join(workspace, '.solopreneur', 'agent-runs', '__solo__', '12', 'output.log') }); } finally { legacy.close(); }
  const job = await ops({ operation: 'import_project_data', input: { collection: 'project-journal', sourceRoot: journal, projectRoot: workspace, idempotencyKey: 'retained-gap-restart' } });
  await ops.waitForMigrations(); await closeOwner();
  const reopened = UnifiedDataStore.open(root);
  try { assert.deepEqual(reopened.readMigrationJob(job.jobId).progress.retainedGaps.map(item => item.error), ['historical_run_output_missing']); }
  finally { reopened.close(); }
}));


test('journal cannot adopt a different node that shares a raw historical numeric run ID',()=>fixture(async({workspace,project,store,ops,record})=>{
 const sourceRoot=path.join(workspace,'.solopreneur','agent-runs');const run=path.join(sourceRoot,'__solo__','12');fs.mkdirSync(run,{recursive:true});
 fs.writeFileSync(path.join(run,'command.txt'),'codex');fs.writeFileSync(path.join(run,'output.log'),'tokens used\n12,345');
 const raw=await ops({operation:'import_project_data',input:{collection:'agent-runs',sourceRoot,projectRoot:workspace,idempotencyKey:'raw-numeric-identity'}});await ops.waitForMigrations();assert.equal(store.readMigrationJob(raw.jobId).status,'completed');
 const otherRun=path.join(sourceRoot,'other-node','12');fs.mkdirSync(otherRun,{recursive:true});const outputPath=path.join(otherRun,'output.log');fs.writeFileSync(outputPath,'tokens used\n999');
 const journal=path.join(workspace,'.solopreneur','project_journal.db');const legacy=new SqliteStore(journal,path.resolve(__dirname,'..'));await legacy.init();try{legacy.upsertRunIndex({...record(12),nodeId:'other-node',totalTokens:0,outputPath});}finally{legacy.close();}
 const job=await ops({operation:'import_project_data',input:{collection:'project-journal',sourceRoot:journal,projectRoot:workspace,idempotencyKey:'journal-numeric-identity'}});await ops.waitForMigrations();
 assert.equal(store.readProjectRunIndexes(project)[0].nodeId,'__solo__');assert.equal(store.readProjectRunIndexes(project)[0].totalTokens,12345);assert.ok(store.readMigrationJob(job.jobId).progress.conflicts.some(x=>x.error.includes('historical_run_identity_ambiguous')));
 assert.equal(Buffer.from(store.readRunArtifact(project,12,'other-node/12/output.log').bytes,'base64').toString(),'tokens used\n999');
}));


test('historical import follows the registered project alias without losing the original output scope',()=>fixture(async({workspace,project,store,ops,record})=>{
 const alias=path.join(path.dirname(workspace),'project-alias');fs.symlinkSync(workspace,alias,'dir');
 const run=path.join(workspace,'.solopreneur','agent-runs','__solo__','12');fs.mkdirSync(run,{recursive:true});fs.writeFileSync(path.join(run,'output.log'),'完整alias日志\ntokens used\n12345');
 const journal=path.join(alias,'.solopreneur','project_journal.db');const legacy=new SqliteStore(journal,path.resolve(__dirname,'..'));await legacy.init();try{legacy.upsertRunIndex({...record(12),totalTokens:0,outputPath:path.join(alias,'.solopreneur','agent-runs','__solo__','12','output.log')});}finally{legacy.close();}
 const job=await ops({operation:'import_project_data',input:{collection:'project-journal',projectRoot:alias,sourceRoot:journal,idempotencyKey:'history-project-alias'}});await ops.waitForMigrations();
 assert.equal(store.readMigrationJob(job.jobId).status,'completed');assert.equal(store.readProjectRunIndexes(project)[0].totalTokens,12345);assert.equal(Buffer.from(store.readRunArtifact(project,12,'__solo__/12/output.log').bytes,'base64').toString(),'完整alias日志\ntokens used\n12345');
}));

for (const collection of ['project-journal', 'agent-runs']) for (const aliasFirst of [false, true]) test(`physical historical source survives alias re-entry and restart: ${collection}, aliasFirst=${aliasFirst}`, () => fixture(async ({ workspace, project, store, ops, record, closeOwner }) => {
  const alias = path.join(path.dirname(workspace), 'history-source-alias'); fs.symlinkSync(workspace, alias, 'dir');
  const run = path.join(workspace, '.solopreneur', 'agent-runs', '__solo__', '12'); fs.mkdirSync(run, { recursive: true });
  const body = '完整来源与alias重查\ntokens used\n12345'; fs.writeFileSync(path.join(run, 'output.log'), body); fs.writeFileSync(path.join(run, 'command.txt'), 'codex');
  if (collection === 'project-journal') {
    const legacy = new SqliteStore(path.join(workspace, '.solopreneur', 'project_journal.db'), path.resolve(__dirname, '..')); await legacy.init();
    try { legacy.upsertRunIndex({ ...record(12), totalTokens: 0, outputPath: path.join(run, 'output.log') }); } finally { legacy.close(); }
  }
  const input = root => ({ collection, projectRoot: root, sourceRoot: path.join(root, '.solopreneur', collection === 'project-journal' ? 'project_journal.db' : 'agent-runs') });
  const first = await ops({ operation: 'import_project_data', input: { ...input(aliasFirst ? alias : workspace), idempotencyKey: 'alias-first-import' } }); await ops.waitForMigrations();
  assert.equal(store.readMigrationJob(first.jobId).status, 'completed');
  await closeOwner(); const reopened = UnifiedDataStore.open(store.root); const reopenedOps = createRuntimeDataOperations(reopened);
  try {
    const second = await reopenedOps({ operation: 'import_project_data', input: { ...input(aliasFirst ? workspace : alias), idempotencyKey: 'physical-reentry-import' } }); await reopenedOps.waitForMigrations();
    assert.equal(reopened.readMigrationJob(second.jobId).status, 'completed', JSON.stringify(reopened.readMigrationJob(second.jobId).progress.conflicts));
    assert.equal(reopened.readProjectRunIndexes(project).length, 1); assert.equal(reopened.readProjectRunIndexes(project)[0].totalTokens, 12345);
    assert.equal(Buffer.from(reopened.readRunArtifact(project, 12, '__solo__/12/output.log').bytes, 'base64').toString(), body);
  } finally { await reopenedOps.close(); reopened.close(); }
}));

for (const aliasFirst of [false, true]) test(`physical recycling deduplicates aliases through execute and restart: aliasFirst=${aliasFirst}`, () => fixture(async ({ workspace, store, ops, record, closeOwner }) => {
  const { importProjectJournal } = require('../out/projectDataMigration.js');
  const alias = path.join(path.dirname(workspace), 'recycling-source-alias'); fs.symlinkSync(workspace, alias, 'dir');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex({ ...record(12), totalTokens: 88 }); } finally { legacy.close(); }
  const original = fs.readFileSync(journal);
  for (const root of aliasFirst ? [alias, workspace] : [workspace, alias]) {
    const result = await importProjectJournal(store, path.join(root, '.solopreneur', 'project_journal.db'), { projectRoot: root });
    assert.equal(result.conflicts.length, 0);
  }
  await closeOwner(); const reopened = UnifiedDataStore.open(store.root); const reopenedOps = createRuntimeDataOperations(reopened);
  try {
    const call = (operation, input = {}) => reopenedOps({ operation, input });
    const plan = await call('prepare_recycling'); assert.equal(plan.files.length, 1, 'one physical file gets one approved entry');
    assert.equal(plan.files[0].bytes, original.length);
    assert.equal((await call('prepare_recycling')).planId, plan.planId);
    await call('confirm_recycling', { planId: plan.planId });
    assert.equal((await call('prepare_recycling')).files.length, 0, 'an approved physical file cannot be claimed by its other alias');
    const done = await call('execute_recycling_plan', { planId: plan.planId }); assert.equal(done.recycledFiles, 1);
    assert.equal(fs.existsSync(journal), false);
    await call('restore_recycling_file', { itemId: plan.files[0].itemId });
    assert.deepEqual(fs.readFileSync(journal), original);
  } finally { await reopenedOps.close(); reopened.close(); }
}));

test('explicit recycling review reads source metadata once and reuses unchanged file validation', () => fixture(async ({ workspace, store, ops, record }) => {
  const crypto = require('node:crypto'); const { importProjectJournal } = require('../out/projectDataMigration.js');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex({ ...record(12), totalTokens: 88 }); } finally { legacy.close(); }
  await importProjectJournal(store, journal, { projectRoot: workspace });
  const bytes = Buffer.from('完整保留的历史运行内容'); const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  for (let index = 0; index < 503; index++) store.captureMigrationSource({ identity: `agent-runs:${workspace}`, key: `__solo__/${index}/output.log`, hash }, bytes);
  let sourceMetadataReads = 0; let wholeFileReads = 0;
  const rows = store.rows.bind(store); const readFile = fs.promises.readFile;
  store.rows = (sql, args) => { if (sql.startsWith('SELECT source_identity,source_key,contents.sha256')) sourceMetadataReads++; return rows(sql, args); };
  fs.promises.readFile = async (...args) => { if (String(args[0]) === journal) wholeFileReads++; return readFile(...args); };
  try {
    const before = store.rows('SELECT COUNT(*) AS count FROM migration_items')[0].count;
    const plan = await ops({ operation: 'prepare_recycling', input: {} }); assert.equal(plan.files.length, 1);
    assert.equal(sourceMetadataReads, 1, 'byte authorization must not rescan every captured source');
    assert.equal(wholeFileReads, 0, 'explicit review must not load the whole legacy database into one buffer');
    sourceMetadataReads = 0;
    assert.equal((await ops({ operation: 'prepare_recycling', input: {} })).planId, plan.planId);
    assert.equal(sourceMetadataReads, 1); assert.equal(wholeFileReads, 0, 'unchanged explicit review does not reread the whole legacy database');
    assert.equal(store.rows('SELECT COUNT(*) AS count FROM migration_items')[0].count, before);
  } finally { store.rows = rows; fs.promises.readFile = readFile; }
}));

for (const status of ['prepared', 'approved', 'moving', 'held', 'trashed']) test(`legacy logical-path recycling receipt survives exact confirmation or selected recovery after restart: ${status}`, () => fixture(async ({ workspace, store, record, closeOwner }) => {
  const { importProjectJournal } = require('../out/projectDataMigration.js');
  const alias = path.join(path.dirname(workspace), 'legacy-receipt-alias'); fs.symlinkSync(workspace, alias, 'dir');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db');
  const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex({ ...record(12), totalTokens: 88 }); } finally { legacy.close(); }
  const original = fs.readFileSync(journal);
  const identity = `project-journal:${alias}`; const key = 'project_journal.db';
  await importProjectJournal(store, path.join(alias, '.solopreneur', key), { projectRoot: alias });
  const source = store.capturedMigrationSources().find(value => value.identity === identity && value.key === key);
  // The published store persisted the declared alias unchanged in original_path.
  const plan = store.createRecyclingPlan([{ identity, key, hash: source.hash, path: path.join(alias, '.solopreneur', key), bytes: original.length }]);
  const itemId = plan.files[0].itemId;
  if (status !== 'prepared') store.setRecyclingStatus(itemId, status);
  if (['moving', 'held', 'trashed'].includes(status)) {
    const heldRoot = path.join(store.root, '.migration-recycle'); fs.mkdirSync(heldRoot);
    fs.renameSync(journal, path.join(heldRoot, itemId + '.json'));
    if (status === 'trashed') fs.unlinkSync(path.join(heldRoot, itemId + '.json'));
  }
  await closeOwner();
  const reopened = UnifiedDataStore.open(store.root); const operations = createRuntimeDataOperations(reopened);
  try {
    if (['prepared', 'approved'].includes(status)) {
      const reviewed = await operations({ operation: 'read_recycling_plan', input: { planId: plan.planId } });
      assert.equal(reopened.recyclingItems()[0].path, path.join(alias, '.solopreneur', key), 'preview does not grant new authorization');
      await operations({ operation: 'confirm_recycling', input: { planId: plan.planId, files: reviewed.files } });
      await operations({ operation: 'execute_recycling_plan', input: { planId: plan.planId } });
    }
    await operations({ operation: 'restore_recycling_file', input: { itemId, ...(!['prepared', 'approved'].includes(status) ? { destination: journal } : {}) } });
    assert.deepEqual(fs.readFileSync(journal), original);
    assert.equal(reopened.recyclingItems()[0].status, 'restored');
    assert.equal(reopened.recyclingSnapshot(itemId).hash, source.hash);
    assert.equal(reopened.recyclingItems()[0].planId, plan.planId);
  } finally { await operations.close(); reopened.close(); }
}));

for (const status of ['prepared', 'approved', 'held', 'trashed']) test(`legacy receipt cannot follow an alias changed before its first upgrade: ${status}`, () => fixture(async ({ workspace, store, record, closeOwner }) => {
  const { importProjectJournal } = require('../out/projectDataMigration.js');
  const alias = path.join(path.dirname(workspace), 'pre-upgrade-source-alias'); fs.symlinkSync(workspace, alias, 'dir');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex({ ...record(12), totalTokens: 88 }); } finally { legacy.close(); }
  const original = fs.readFileSync(journal); const identity = `project-journal:${alias}`; const key = 'project_journal.db';
  await importProjectJournal(store, path.join(alias, '.solopreneur', key), { projectRoot: alias });
  const source = store.capturedMigrationSources().find(value => value.identity === identity && value.key === key);
  const declared = path.join(alias, '.solopreneur', key);
  const plan = store.createRecyclingPlan([{ identity, key, hash: source.hash, path: declared, bytes: original.length }]);
  const itemId = plan.files[0].itemId; if (status !== 'prepared') store.setRecyclingStatus(itemId, status);
  if (['held', 'trashed'].includes(status)) {
    const heldRoot = path.join(store.root, '.migration-recycle'); fs.mkdirSync(heldRoot); fs.renameSync(journal, path.join(heldRoot, itemId + '.json'));
    if (status === 'trashed') fs.unlinkSync(path.join(heldRoot, itemId + '.json'));
  }
  const other = path.join(path.dirname(workspace), 'pre-upgrade-other-project'); fs.mkdirSync(other); await store.registerProject({ root: other });
  const target = path.join(other, '.solopreneur', key); if (['prepared', 'approved'].includes(status)) fs.writeFileSync(target, original);
  await closeOwner(); fs.unlinkSync(alias); fs.symlinkSync(other, alias, 'dir');
  const reopened = UnifiedDataStore.open(store.root); const operations = createRuntimeDataOperations(reopened);
  const operation = status === 'prepared' ? 'confirm_recycling' : status === 'approved' ? 'hold_recycling_file' : 'restore_recycling_file';
  try {
    await assert.rejects(operations({ operation, input: status === 'prepared' ? { planId: plan.planId } : { itemId } }), /recycling_path_(invalid|identity_unavailable)/);
    assert.equal(reopened.recyclingItems()[0].path, declared, 'failed validation must preserve the original receipt');
    assert.equal(reopened.recyclingItems()[0].status, status);
    assert.deepEqual(reopened.recyclingSnapshot(itemId).bytes, original);
    if (['prepared', 'approved'].includes(status)) assert.deepEqual(fs.readFileSync(target), original);
    else assert.equal(fs.existsSync(target), false);
  } finally { await operations.close(); reopened.close(); }
}));

test('a legacy alias imported into two projects cannot acquire either project as its approved owner', () => fixture(async ({ workspace, store, ops, record }) => {
  const { importProjectJournal } = require('../out/projectDataMigration.js');
  const alias = path.join(path.dirname(workspace), 'ambiguous-receipt-alias'); fs.symlinkSync(workspace, alias, 'dir');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex(record(12)); } finally { legacy.close(); }
  await importProjectJournal(store, path.join(alias, '.solopreneur', 'project_journal.db'), { projectRoot: alias });
  const original = fs.readFileSync(journal); const source = store.capturedMigrationSources().find(value => value.identity === `project-journal:${alias}`);
  const declared = path.join(alias, '.solopreneur', source.key);
  const plan = store.createRecyclingPlan([{ ...source, path: declared, bytes: original.length }]); store.setRecyclingStatus(plan.files[0].itemId, 'approved');
  const other = path.join(path.dirname(workspace), 'ambiguous-other-project'); fs.mkdirSync(other); await store.registerProject({ root: other });
  const target = path.join(other, '.solopreneur', source.key); fs.writeFileSync(target, original);
  fs.unlinkSync(alias); fs.symlinkSync(other, alias, 'dir');
  assert.equal((await importProjectJournal(store, target, { projectRoot: alias })).conflicts.length, 0);
  await assert.rejects(ops({ operation: 'hold_recycling_file', input: { itemId: plan.files[0].itemId } }), /recycling_path_(invalid|identity_unavailable)/);
  assert.equal(store.recyclingItems()[0].path, declared); assert.equal(store.recyclingItems()[0].status, 'approved');
  assert.deepEqual(fs.readFileSync(journal), original); assert.deepEqual(fs.readFileSync(target), original);
}));

test('an unbound published legacy alias receipt preserves its snapshot instead of guessing a physical owner', () => fixture(async ({ workspace, store, record, closeOwner }) => {
  const { importProjectJournal } = require('../out/projectDataMigration.js');
  const alias = path.join(path.dirname(workspace), 'unbound-published-alias'); fs.symlinkSync(workspace, alias, 'dir');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex(record(12)); } finally { legacy.close(); }
  await importProjectJournal(store, path.join(alias, '.solopreneur', 'project_journal.db'), { projectRoot: alias });
  const original = fs.readFileSync(journal); const source = store.capturedMigrationSources().find(value => value.identity === `project-journal:${alias}`);
  const declared = path.join(alias, '.solopreneur', source.key);
  const plan = store.createRecyclingPlan([{ ...source, path: declared, bytes: original.length }]);
  // Published V11 had no run_index_import_sources mapping. Do not invent one.
  store.db.run('DELETE FROM run_index_import_sources');
  store.setRecyclingStatus(plan.files[0].itemId, 'held');
  const heldRoot = path.join(store.root, '.migration-recycle'); fs.mkdirSync(heldRoot); fs.renameSync(journal, path.join(heldRoot, plan.files[0].itemId + '.json'));
  await closeOwner(); const reopened = UnifiedDataStore.open(store.root); const operations = createRuntimeDataOperations(reopened);
  try {
    await assert.rejects(operations({ operation: 'restore_recycling_file', input: { itemId: plan.files[0].itemId } }), /recycling_path_identity_unavailable/);
    assert.equal(reopened.recyclingItems()[0].path, declared); assert.equal(reopened.recyclingItems()[0].status, 'held');
    assert.deepEqual(reopened.recyclingSnapshot(plan.files[0].itemId).bytes, original);
    assert.deepEqual(fs.readFileSync(path.join(heldRoot, plan.files[0].itemId + '.json')), original);
    assert.equal(fs.existsSync(journal), false);
  } finally { await operations.close(); reopened.close(); }
}));

for (const operation of ['hold_recycling_file', 'restore_recycling_file']) test(`later reimport cannot authorize an unbound published receipt: ${operation}`, () => fixture(async ({ workspace, store, ops, record }) => {
  const { importProjectJournal } = require('../out/projectDataMigration.js');
  const alias = path.join(path.dirname(workspace), 'published-reimport-alias'); fs.symlinkSync(workspace, alias, 'dir');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex(record(12)); } finally { legacy.close(); }
  const original = fs.readFileSync(journal); const declared = path.join(alias, '.solopreneur', 'project_journal.db');
  await importProjectJournal(store, declared, { projectRoot: alias });
  const source = store.capturedMigrationSources().find(value => value.identity === `project-journal:${alias}`);
  const plan = store.createRecyclingPlan([{ ...source, path: declared, bytes: original.length }]); const itemId = plan.files[0].itemId;
  store.db.run('DELETE FROM run_index_import_sources');
  store.setRecyclingStatus(itemId, operation === 'hold_recycling_file' ? 'approved' : 'trashed');
  const other = path.join(path.dirname(workspace), 'published-reimport-target'); fs.mkdirSync(other); await store.registerProject({ root: other });
  const target = path.join(other, '.solopreneur', source.key); fs.writeFileSync(target, original);
  fs.unlinkSync(alias); fs.symlinkSync(other, alias, 'dir');
  await importProjectJournal(store, target, { projectRoot: alias });
  if (operation === 'restore_recycling_file') fs.unlinkSync(target);
  await assert.rejects(ops({ operation, input: { itemId } }), /recycling_path_identity_unavailable/);
  assert.equal(store.recyclingItems()[0].path, declared);
  assert.deepEqual(store.recyclingSnapshot(itemId).bytes, original);
  assert.deepEqual(fs.readFileSync(journal), original);
  if (operation === 'hold_recycling_file') assert.deepEqual(fs.readFileSync(target), original);
  else assert.equal(fs.existsSync(target), false);
}));

test('an unbound legacy snapshot restores to a selected physical destination and survives owner restart', () => fixture(async ({ workspace, store, ops, record, closeOwner }) => {
  const { importProjectJournal } = require('../out/projectDataMigration.js');
  const alias = path.join(path.dirname(workspace), 'selected-recovery-alias'); fs.symlinkSync(workspace, alias, 'dir');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex(record(12)); } finally { legacy.close(); }
  const original = fs.readFileSync(journal); const declared = path.join(alias, '.solopreneur', 'project_journal.db');
  await importProjectJournal(store, declared, { projectRoot: alias });
  const source = store.capturedMigrationSources().find(value => value.identity === `project-journal:${alias}`);
  const plan = store.createRecyclingPlan([{ ...source, path: declared, bytes: original.length }]); const itemId = plan.files[0].itemId;
  store.db.run('DELETE FROM run_index_import_sources'); store.setRecyclingStatus(itemId, 'trashed');
  const destination = path.join(workspace, 'recovered-journal.db');
  await ops({ operation: 'restore_recycling_file', input: { itemId, destination } });
  assert.deepEqual(fs.readFileSync(destination), original); assert.deepEqual(fs.readFileSync(journal), original);
  await closeOwner(); const reopened = UnifiedDataStore.open(store.root);
  try {
    assert.equal(reopened.recyclingItems()[0].restorePath, destination);
    assert.equal(reopened.recyclingItems()[0].status, 'restored');
    assert.equal(reopened.rows('SELECT original_path FROM migration_recycling WHERE id=?', [itemId])[0].original_path, declared);
    assert.deepEqual(reopened.recyclingSnapshot(itemId).bytes, original);
  } finally { reopened.close(); }
}));

test('an alias changed after the displayed confirmation cannot approve a different physical file', () => fixture(async ({ workspace, store, ops, record }) => {
  const { importProjectJournal } = require('../out/projectDataMigration.js');
  const alias = path.join(path.dirname(workspace), 'displayed-confirmation-alias'); fs.symlinkSync(workspace, alias, 'dir');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex(record(12)); } finally { legacy.close(); }
  const original = fs.readFileSync(journal); const declared = path.join(alias, '.solopreneur', 'project_journal.db');
  await importProjectJournal(store, declared, { projectRoot: alias });
  const source = store.capturedMigrationSources().find(value => value.identity === `project-journal:${alias}`);
  const plan = store.createRecyclingPlan([{ ...source, path: declared, bytes: original.length }]);
  const reviewed = await ops({ operation: 'read_recycling_plan', input: { planId: plan.planId } });
  assert.equal(reviewed.requiresConfirmation, true); assert.equal(store.recyclingItems()[0].path, declared);
  const other = path.join(path.dirname(workspace), 'displayed-confirmation-target'); fs.mkdirSync(other); await store.registerProject({ root: other });
  const target = path.join(other, '.solopreneur', source.key); fs.writeFileSync(target, original);
  fs.unlinkSync(alias); fs.symlinkSync(other, alias, 'dir');
  await importProjectJournal(store, target, { projectRoot: alias });
  await assert.rejects(ops({ operation: 'confirm_recycling', input: { planId: plan.planId, files: reviewed.files } }), /recycling_source_changed/);
  assert.equal(store.recyclingItems()[0].status, 'prepared'); assert.equal(store.recyclingItems()[0].path, declared);
  assert.deepEqual(fs.readFileSync(journal), original); assert.deepEqual(fs.readFileSync(target), original);
}));

test('a selected recovery destination survives interruption without following the old alias', () => fixture(async ({ workspace, store, ops, record, closeOwner }) => {
  const { importProjectJournal } = require('../out/projectDataMigration.js');
  const alias = path.join(path.dirname(workspace), 'interrupted-recovery-alias'); fs.symlinkSync(workspace, alias, 'dir');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex(record(12)); } finally { legacy.close(); }
  const original = fs.readFileSync(journal); const declared = path.join(alias, '.solopreneur', 'project_journal.db');
  await importProjectJournal(store, declared, { projectRoot: alias });
  const source = store.capturedMigrationSources().find(value => value.identity === `project-journal:${alias}`);
  const plan = store.createRecyclingPlan([{ ...source, path: declared, bytes: original.length }]); const itemId = plan.files[0].itemId;
  store.setRecyclingStatus(itemId, 'trashed');
  const destination = path.join(workspace, 'recovery', 'complete.db'); const link = fs.promises.link;
  fs.promises.link = async () => { throw new Error('fixture_publish_interrupted'); };
  try { await assert.rejects(ops({ operation: 'restore_recycling_file', input: { itemId, destination } }), /fixture_publish_interrupted/); }
  finally { fs.promises.link = link; }
  assert.equal(store.recyclingItems()[0].status, 'restoring');
  await closeOwner(); const other = path.join(path.dirname(workspace), 'interrupted-recovery-other'); fs.mkdirSync(other); fs.unlinkSync(alias); fs.symlinkSync(other, alias, 'dir');
  const reopened = UnifiedDataStore.open(store.root); const operations = createRuntimeDataOperations(reopened);
  try {
    await operations({ operation: 'restore_recycling_file', input: { itemId } });
    assert.deepEqual(fs.readFileSync(destination), original); assert.deepEqual(fs.readFileSync(journal), original);
    assert.equal(reopened.recyclingItems()[0].status, 'restored');
    assert.equal(fs.existsSync(path.join(other, '.solopreneur', source.key)), false);
  } finally { await operations.close(); reopened.close(); }
}));

for (const interrupt of [false, true]) test(`recovery publishes across filesystems without losing restart ownership: interrupted=${interrupt}`, () => fixture(async ({ workspace, store, ops, record, closeOwner }) => {
  const { importProjectJournal } = require('../out/projectDataMigration.js');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex(record(12)); } finally { legacy.close(); }
  const original = fs.readFileSync(journal); await importProjectJournal(store, journal, { projectRoot: workspace });
  const plan = await ops({ operation: 'prepare_recycling', input: {} }); const itemId = plan.files[0].itemId;
  await ops({ operation: 'confirm_recycling', input: { planId: plan.planId } }); await ops({ operation: 'execute_recycling_plan', input: { planId: plan.planId } });
  const destination = path.join(workspace, 'cross-volume-recovery.db'); const link = fs.promises.link; let links = 0;
  fs.promises.link = async (...args) => {
    links++;
    if (links === 1) { const error = new Error('fixture_cross_device'); error.code = 'EXDEV'; throw error; }
    if (interrupt) throw new Error('fixture_local_publish_interrupted');
    return link(...args);
  };
  try {
    if (interrupt) await assert.rejects(ops({ operation: 'restore_recycling_file', input: { itemId, destination } }), /fixture_local_publish_interrupted/);
    else await ops({ operation: 'restore_recycling_file', input: { itemId, destination } });
  } finally { fs.promises.link = link; }
  assert.equal(links, 2, 'publication must retry from a private stage on the selected filesystem');
  await closeOwner(); const reopened = UnifiedDataStore.open(store.root); const operations = createRuntimeDataOperations(reopened);
  try {
    if (interrupt) await operations({ operation: 'restore_recycling_file', input: { itemId } });
    assert.deepEqual(fs.readFileSync(destination), original);
    assert.equal(reopened.recyclingItems()[0].status, 'restored');
    assert.equal(fs.existsSync(journal), false);
    assert.deepEqual(fs.readdirSync(workspace).filter(name => name.startsWith('.solomap-restore-')), [], 'private materialization leaves no completed residue');
    assert.equal(fs.existsSync(path.join(store.root, '.migration-recycle', itemId + '.restore')), false);
  } finally { await operations.close(); reopened.close(); }
}));

test('a recovery blocked by an unrelated same-byte file accepts a new location after owner restart', () => fixture(async ({ workspace, store, ops, record, closeOwner }) => {
  const { importProjectJournal } = require('../out/projectDataMigration.js');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex(record(12)); } finally { legacy.close(); }
  const original = fs.readFileSync(journal); await importProjectJournal(store, journal, { projectRoot: workspace });
  const plan = await ops({ operation: 'prepare_recycling', input: {} }); const itemId = plan.files[0].itemId;
  await ops({ operation: 'confirm_recycling', input: { planId: plan.planId } }); await ops({ operation: 'execute_recycling_plan', input: { planId: plan.planId } });
  const destination = path.join(workspace, 'occupied-recovery.db'); const link = fs.promises.link;
  fs.promises.link = async (...args) => { fs.writeFileSync(destination, original); return link(...args); };
  try { await assert.rejects(ops({ operation: 'restore_recycling_file', input: { itemId, destination } }), /restore_target_exists/); }
  finally { fs.promises.link = link; }
  const unrelatedInode = fs.statSync(destination).ino; assert.equal(store.recyclingItems()[0].status, 'restoring');
  await closeOwner(); const reopened = UnifiedDataStore.open(store.root); const operations = createRuntimeDataOperations(reopened);
  const alternative = path.join(workspace, 'selected-alternative.db');
  try {
    await operations({ operation: 'restore_recycling_file', input: { itemId, destination: alternative } });
    assert.deepEqual(fs.readFileSync(alternative), original); assert.deepEqual(fs.readFileSync(destination), original);
    assert.equal(fs.statSync(destination).ino, unrelatedInode, 'equal bytes never authorize replacing the unrelated file');
    assert.equal(reopened.recyclingItems()[0].status, 'restored');
    assert.equal(reopened.recyclingItems()[0].restorePath, alternative);
  } finally { await operations.close(); reopened.close(); }
}));

test('a live recovery creator cleans its exact empty directory when ownership registration fails', () => fixture(async ({ workspace, store, ops, record }) => {
  const { importProjectJournal } = require('../out/projectDataMigration.js');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex(record(12)); } finally { legacy.close(); }
  const original = fs.readFileSync(journal); await importProjectJournal(store, journal, { projectRoot: workspace });
  const plan = await ops({ operation: 'prepare_recycling', input: {} }); const itemId = plan.files[0].itemId;
  await ops({ operation: 'confirm_recycling', input: { planId: plan.planId } }); await ops({ operation: 'execute_recycling_plan', input: { planId: plan.planId } });
  const destination = path.join(workspace, 'live-creator-recovery.db'); const link = fs.promises.link; const register = store.registerRecyclingRestoreStage.bind(store);
  fs.promises.link = async () => { const error = new Error('fixture_cross_device'); error.code = 'EXDEV'; throw error; };
  store.registerRecyclingRestoreStage = () => { throw new Error('fixture_registration_interrupted'); };
  try { await assert.rejects(ops({ operation: 'restore_recycling_file', input: { itemId, destination } }), /fixture_registration_interrupted/); }
  finally { fs.promises.link = link; store.registerRecyclingRestoreStage = register; }
  assert.deepEqual(fs.readdirSync(workspace).filter(name => name.startsWith('.solomap-restore-')), [], 'registration failure must not orphan a directory whose exact inode is still known by its live creator');
  assert.equal(fs.existsSync(destination), false); assert.deepEqual(store.recyclingSnapshot(itemId).bytes, original);
}));

for (const interruption of ['before_create', 'after_create', 'after_create_relocated', 'register_failure', 'foreign_directory']) test(`local recovery intent survives ${interruption} and preserves unrelated files`, () => fixture(async ({ workspace, store, ops, record, closeOwner }) => {
  const { importProjectJournal } = require('../out/projectDataMigration.js');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex(record(12)); } finally { legacy.close(); }
  const original = fs.readFileSync(journal); await importProjectJournal(store, journal, { projectRoot: workspace });
  const plan = await ops({ operation: 'prepare_recycling', input: {} }); const itemId = plan.files[0].itemId;
  await ops({ operation: 'confirm_recycling', input: { planId: plan.planId } }); await ops({ operation: 'execute_recycling_plan', input: { planId: plan.planId } });
  const destination = path.join(workspace, 'intent-recovery.db'); const link = fs.promises.link; const mkdir = fs.promises.mkdir;
  const register = store.registerRecyclingRestoreStage.bind(store); let links = 0; let intended; let foreignInode;
  fs.promises.link = async (...args) => { if (++links === 1) { const error = new Error('fixture_cross_device'); error.code = 'EXDEV'; throw error; } return link(...args); };
  fs.promises.mkdir = async (directory, options) => {
    if (!path.basename(directory).startsWith('.solomap-restore-') || intended) return mkdir(directory, options);
    intended = directory;
    const intents = store.recyclingRestoreIntents(itemId);
    assert.equal(intents.find(value => value.directory === directory)?.status, 'planned', 'the exact physical path must be committed before creation');
    if (interruption === 'before_create') throw new Error('fixture_creation_interrupted');
    if (interruption === 'foreign_directory') {
      fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'user-note.txt'), 'Keep my unrelated directory'); foreignInode = fs.statSync(directory).ino;
      const error = new Error('fixture_foreign_directory'); error.code = 'EEXIST'; throw error;
    }
    await mkdir(directory, options);
    if (interruption.startsWith('after_create')) throw new Error('fixture_creation_interrupted'); // The owner disappears before the async creation result is observed.
  };
  if (interruption === 'register_failure') store.registerRecyclingRestoreStage = () => { throw new Error('fixture_registration_interrupted'); };
  try {
    if (interruption === 'foreign_directory') await ops({ operation: 'restore_recycling_file', input: { itemId, destination } });
    else await assert.rejects(ops({ operation: 'restore_recycling_file', input: { itemId, destination } }), /fixture_(creation|registration)_interrupted/);
  } finally { fs.promises.link = link; fs.promises.mkdir = mkdir; store.registerRecyclingRestoreStage = register; }
  assert.ok(intended, 'exclusive directory creation is exercised');
  const before = store.recyclingRestoreIntents(itemId); assert.ok(before.some(value => value.directory === intended));
  if (interruption === 'register_failure') assert.equal(fs.existsSync(intended), false, 'a live creator can remove its own unchanged empty inode');
  await closeOwner(); const reopened = UnifiedDataStore.open(store.root); const operations = createRuntimeDataOperations(reopened);
  try {
    const alternative = path.join(workspace, 'selected-after-interruption', 'restored.db');
    if (interruption !== 'foreign_directory') await operations({ operation: 'restore_recycling_file', input: { itemId, ...(interruption === 'after_create_relocated' ? { destination: alternative } : {}) } });
    assert.deepEqual(fs.readFileSync(interruption === 'after_create_relocated' ? alternative : destination), original); assert.equal(reopened.recyclingItems()[0].status, 'restored');
    if (interruption === 'after_create_relocated') assert.equal(fs.existsSync(destination), false);
    const intents = reopened.recyclingRestoreIntents(itemId); const unknown = intents.filter(value => value.status === 'ownership_unknown');
    if (interruption.startsWith('after_create') || interruption === 'foreign_directory') {
      assert.deepEqual(unknown.map(value => value.directory), [intended]);
      assert.equal(fs.existsSync(intended), true, 'missing inode evidence never authorizes deleting or adopting a directory');
      if (interruption === 'foreign_directory') { assert.equal(fs.statSync(intended).ino, foreignInode); assert.equal(fs.readFileSync(path.join(intended, 'user-note.txt'), 'utf8'), 'Keep my unrelated directory'); }
      const overview = await operations({ operation: 'migration_overview', input: {} });
      assert.ok(overview.recoveryConflicts.some(value => value.itemId === itemId && value.path === intended), 'the retained exact conflict remains discoverable after restoration');
    } else assert.deepEqual(unknown, []);
    assert.deepEqual(fs.readdirSync(workspace).filter(name => name.startsWith('.solomap-restore-')).sort(), unknown.map(value => path.basename(value.directory)).sort(), 'all remaining physical stages have a durable exact conflict');
    const intentCount = intents.length;
    for (let index = 0; index < 3; index++) { await assert.rejects(operations({ operation: 'restore_recycling_file', input: { itemId } }), /restore_target_exists/); await operations({ operation: 'migration_overview', input: {} }); }
    assert.equal(reopened.recyclingRestoreIntents(itemId).length, intentCount, 'repeated completion never creates additional attempts');
    assert.equal(reopened.recyclingRestoreStage(itemId), null);
  } finally { await operations.close(); reopened.close(); }
}));

test('a removed local recovery directory settles its durable receipt after a cleanup interruption', () => fixture(async ({ workspace, store, ops, record, closeOwner }) => {
  const { importProjectJournal } = require('../out/projectDataMigration.js');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex(record(12)); } finally { legacy.close(); }
  const original = fs.readFileSync(journal); await importProjectJournal(store, journal, { projectRoot: workspace });
  const plan = await ops({ operation: 'prepare_recycling', input: {} }); const itemId = plan.files[0].itemId;
  await ops({ operation: 'confirm_recycling', input: { planId: plan.planId } }); await ops({ operation: 'execute_recycling_plan', input: { planId: plan.planId } });
  const destination = path.join(workspace, 'cleanup-recovery.db'); const link = fs.promises.link; let links = 0;
  fs.promises.link = async (...args) => { if (++links === 1) { const error = new Error('fixture_cross_device'); error.code = 'EXDEV'; throw error; } return link(...args); };
  const clear = store.clearRecyclingRestoreStage.bind(store); store.clearRecyclingRestoreStage = () => { throw new Error('fixture_cleanup_commit_interrupted'); };
  try { await assert.rejects(ops({ operation: 'restore_recycling_file', input: { itemId, destination } }), /fixture_cleanup_commit_interrupted/); }
  finally { fs.promises.link = link; store.clearRecyclingRestoreStage = clear; }
  assert.equal(store.recyclingItems()[0].status, 'restored');
  assert.equal(fs.existsSync(store.recyclingRestoreStage(itemId).directory), false);
  await closeOwner(); const reopened = UnifiedDataStore.open(store.root); const operations = createRuntimeDataOperations(reopened);
  try {
    assert.equal((await operations({ operation: 'restore_recycling_file', input: { itemId } })).restored, true);
    assert.equal(reopened.recyclingRestoreStage(itemId), null);
    assert.deepEqual(fs.readFileSync(destination), original);
  } finally { await operations.close(); reopened.close(); }
}));

for (const operation of ['confirm_recycling', 'hold_recycling_file', 'restore_recycling_file']) test(`upgraded legacy receipt rejects alias redirection after restart: ${operation}`, () => fixture(async ({ workspace, store, ops, record, closeOwner }) => {
  const { importProjectJournal } = require('../out/projectDataMigration.js');
  const alias = path.join(path.dirname(workspace), 'pinned-legacy-receipt-alias'); fs.symlinkSync(workspace, alias, 'dir');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex({ ...record(12), totalTokens: 88 }); } finally { legacy.close(); }
  const original = fs.readFileSync(journal); const identity = `project-journal:${alias}`; const key = 'project_journal.db';
  await importProjectJournal(store, path.join(alias, '.solopreneur', key), { projectRoot: alias });
  const source = store.capturedMigrationSources().find(value => value.identity === identity && value.key === key);
  const plan = store.createRecyclingPlan([{ identity, key, hash: source.hash, path: path.join(alias, '.solopreneur', key), bytes: original.length }]);
  const { MigrationRecycling } = require('../out/migrationRecycling.js');
  const reviewed = new MigrationRecycling(store).readPlan(plan.planId);
  assert.equal(reviewed.files[0].path, journal);
  assert.equal(store.recyclingItems()[0].path, path.join(alias, '.solopreneur', key), 'reading a receipt cannot grant authorization');
  await ops({ operation: 'confirm_recycling', input: { planId: plan.planId, files: reviewed.files } });
  assert.equal(store.recyclingItems()[0].path, journal, 'exact confirmation survives owner restart');
  if (operation === 'restore_recycling_file') await ops({ operation: 'execute_recycling_plan', input: { planId: plan.planId } });
  await closeOwner();
  const other = path.join(path.dirname(workspace), 'other-legacy-target'); fs.mkdirSync(path.join(other, '.solopreneur'), { recursive: true });
  const target = path.join(other, '.solopreneur', key);
  if (operation !== 'restore_recycling_file') fs.writeFileSync(target, original);
  fs.unlinkSync(alias); fs.symlinkSync(other, alias, 'dir');
  const reopened = UnifiedDataStore.open(store.root); const operations = createRuntimeDataOperations(reopened);
  try {
    await assert.rejects(operations({ operation, input: operation === 'confirm_recycling' ? { planId: plan.planId } : { itemId: plan.files[0].itemId } }), /recycling_path_invalid/);
    if (operation === 'restore_recycling_file') assert.equal(fs.existsSync(target), false);
    else assert.deepEqual(fs.readFileSync(target), original);
    assert.equal(reopened.recyclingSnapshot(plan.files[0].itemId).hash, source.hash);
  } finally { await operations.close(); reopened.close(); }
}));

test('alias-only recycling restores the complete original after owner restart', () => fixture(async ({ workspace, store, ops, record, closeOwner }) => {
  const { importProjectJournal } = require('../out/projectDataMigration.js');
  const alias = path.join(path.dirname(workspace), 'only-recycling-alias'); fs.symlinkSync(workspace, alias, 'dir');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex({ ...record(12), totalTokens: 88 }); } finally { legacy.close(); }
  const original = fs.readFileSync(journal);
  assert.equal((await importProjectJournal(store, path.join(alias, '.solopreneur', 'project_journal.db'), { projectRoot: alias })).conflicts.length, 0);
  const plan = await ops({ operation: 'prepare_recycling', input: {} }); assert.equal(plan.files.length, 1);
  await ops({ operation: 'confirm_recycling', input: { planId: plan.planId } });
  await ops({ operation: 'execute_recycling_plan', input: { planId: plan.planId } });
  await closeOwner(); const reopened = UnifiedDataStore.open(store.root); const reopenedOps = createRuntimeDataOperations(reopened);
  try {
    await reopenedOps({ operation: 'restore_recycling_file', input: { itemId: plan.files[0].itemId } });
    assert.deepEqual(fs.readFileSync(journal), original);
    assert.equal(reopened.recyclingItems()[0].status, 'restored');
  } finally { await reopenedOps.close(); reopened.close(); }
}));

for (const phase of ['queued', 'running', 'failed', 'completed']) test(`migration overview exposes the latest retry of an older journal job after restart: ${phase}`, () => fixture(async ({ workspace, store, ops, closeOwner }) => {
  const sourceRoot = path.join(workspace, '.solopreneur', 'project_journal.db');
  const args = { collection: 'project-journal', projectRoot: workspace, sourceRoot };
  const old = store.enqueueMemoryMigration(args, 'older-visible-job'); store.updateMigrationJob(old.jobId, 'completed', {});
  const newer = store.enqueueMemoryMigration(args, 'newer-visible-job'); store.updateMigrationJob(newer.jobId, 'completed', {});
  assert.equal(store.requeueCompletedMigration(old.jobId), true);
  if (phase !== 'queued') store.updateMigrationJob(old.jobId, phase, { conflicts: phase === 'failed' ? [{ source: sourceRoot, error: 'verify failed' }] : [] }, phase === 'failed' ? 'verify failed' : null);
  const check = async operation => {
    const overview = await operation({ operation: 'migration_overview', input: {} });
    assert.equal(overview.jobs.length, 1); assert.equal(overview.jobs[0].jobId, old.jobId); assert.equal(overview.jobs[0].status, phase);
    if (phase === 'failed') { assert.equal(overview.jobs[0].error, 'verify failed'); assert.equal(overview.jobs[0].progress.conflictCount, 1); }
  };
  await check(ops); await closeOwner(); const reopened = UnifiedDataStore.open(store.root); const reopenedOps = createRuntimeDataOperations(reopened);
  try { await check(reopenedOps); } finally { await reopenedOps.close(); reopened.close(); }
}));

test('migration overview keeps an active older reconciliation visible while a newer job completes', () => fixture(async ({ workspace, store, ops }) => {
  const args = { collection: 'project-journal', projectRoot: workspace, sourceRoot: path.join(workspace, '.solopreneur', 'project_journal.db') };
  const active = store.enqueueMemoryMigration(args, 'older-still-active'); store.updateMigrationJob(active.jobId, 'running', {});
  const completed = store.enqueueMemoryMigration(args, 'newer-while-active'); store.updateMigrationJob(completed.jobId, 'completed', {});
  const overview = await ops({ operation: 'migration_overview', input: {} });
  assert.equal(overview.jobs.length, 1); assert.equal(overview.jobs[0].jobId, active.jobId); assert.equal(overview.jobs[0].status, 'running');
}));

for (const operation of ['confirm_recycling', 'hold_recycling_file', 'restore_recycling_file']) test(`a changed project alias cannot redirect ${operation} to another physical directory`, () => fixture(async ({ workspace, store, ops, record, closeOwner }) => {
  const { importProjectJournal } = require('../out/projectDataMigration.js');
  const alias = path.join(path.dirname(workspace), 'redirected-recycling-alias'); fs.symlinkSync(workspace, alias, 'dir');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex({ ...record(12), totalTokens: 88 }); } finally { legacy.close(); }
  const original = fs.readFileSync(journal);
  await importProjectJournal(store, path.join(alias, '.solopreneur', 'project_journal.db'), { projectRoot: alias });
  const plan = await ops({ operation: 'prepare_recycling', input: {} }); const itemId = plan.files[0].itemId;
  if (operation !== 'confirm_recycling') await ops({ operation: 'confirm_recycling', input: { planId: plan.planId } });
  if (operation === 'restore_recycling_file') await ops({ operation: 'execute_recycling_plan', input: { planId: plan.planId } });
  const other = path.join(path.dirname(workspace), 'other-physical-project'); fs.mkdirSync(path.join(other, '.solopreneur'), { recursive: true });
  const target = path.join(other, '.solopreneur', 'project_journal.db');
  if (operation !== 'restore_recycling_file') fs.writeFileSync(target, original);
  fs.unlinkSync(alias); fs.symlinkSync(other, alias, 'dir');
  await closeOwner(); const reopened = UnifiedDataStore.open(store.root); const reopenedOps = createRuntimeDataOperations(reopened);
  try {
    await assert.rejects(reopenedOps({ operation, input: operation === 'confirm_recycling' ? { planId: plan.planId } : { itemId } }), /recycling_path_invalid/);
    if (operation === 'restore_recycling_file') assert.equal(fs.existsSync(target), false);
    else { assert.deepEqual(fs.readFileSync(target), original); assert.deepEqual(fs.readFileSync(journal), original); }
  } finally { await reopenedOps.close(); reopened.close(); }
}));

for (const operation of ['confirm', 'hold', 'finish', 'retire']) for (const phase of ['queued', 'running', 'failed']) test(`older alias retry cannot hide behind a newer completed source before ${operation}: ${phase}`, () => fixture(async ({ workspace, store, record, closeOwner }) => {
  const { MigrationRecycling } = require('../out/migrationRecycling.js'); const { importProjectJournal } = require('../out/projectDataMigration.js');
  const alias = path.join(path.dirname(workspace), 'older-migration-alias'); fs.symlinkSync(workspace, alias, 'dir');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex({ ...record(12), totalTokens: 88 }); } finally { legacy.close(); }
  const args = root => ({ collection: 'project-journal', projectRoot: root, sourceRoot: path.join(root, '.solopreneur', 'project_journal.db') });
  const older = store.enqueueMemoryMigration(args(alias), 'older-alias-attempt');
  const imported = await importProjectJournal(store, journal, { projectRoot: workspace }); assert.equal(imported.conflicts.length, 0);
  store.updateMigrationJob(older.jobId, 'completed', {});
  const newer = store.enqueueMemoryMigration(args(workspace), 'newer-physical-attempt');
  await importProjectJournal(store, journal, { projectRoot: workspace }); store.updateMigrationJob(newer.jobId, 'completed', {});
  const recycling = new MigrationRecycling(store); const plan = await recycling.prepare(); assert.equal(plan.files.length, 1); const itemId = plan.files[0].itemId;
  if (operation !== 'confirm') recycling.confirm(plan.planId);
  let retained = journal;
  if (['finish', 'retire'].includes(operation)) retained = (await recycling.hold(itemId)).path;
  if (operation === 'finish') { const held = retained; retained += '.test-retained'; fs.renameSync(held, retained); }
  const bytes = fs.readFileSync(retained);
  assert.equal(store.requeueCompletedMigration(older.jobId), true);
  if (phase !== 'queued') store.updateMigrationJob(older.jobId, phase, {}, phase === 'failed' ? 'source verification failed' : null);
  const reject = async current => {
    const gate = new MigrationRecycling(current);
    if (operation === 'confirm') assert.throws(() => gate.confirm(plan.planId), /recycling_source_not_reconciled/);
    else await assert.rejects(() => gate[operation](itemId), /recycling_source_not_reconciled/);
    assert.equal(fs.readFileSync(retained).compare(bytes), 0);
  };
  await reject(store); await closeOwner(); const reopened = UnifiedDataStore.open(store.root);
  try { await reject(reopened); } finally { reopened.close(); }
}));

test('a successful recheck of the older alias restores the verified physical source after failure', () => fixture(async ({ workspace, store, record, closeOwner }) => {
  const { MigrationRecycling } = require('../out/migrationRecycling.js'); const { importProjectJournal } = require('../out/projectDataMigration.js');
  const alias = path.join(path.dirname(workspace), 'restored-source-alias'); fs.symlinkSync(workspace, alias, 'dir');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex({ ...record(12), totalTokens: 88 }); } finally { legacy.close(); }
  const older = store.enqueueMemoryMigration({ collection: 'project-journal', projectRoot: alias, sourceRoot: path.join(alias, '.solopreneur', 'project_journal.db') }, 'restore-older-alias');
  await importProjectJournal(store, journal, { projectRoot: workspace }); store.updateMigrationJob(older.jobId, 'completed', {});
  const newer = store.enqueueMemoryMigration({ collection: 'project-journal', projectRoot: workspace, sourceRoot: journal }, 'restore-newer-physical');
  await importProjectJournal(store, journal, { projectRoot: workspace }); store.updateMigrationJob(newer.jobId, 'completed', {});
  const plan = await new MigrationRecycling(store).prepare();
  store.requeueCompletedMigration(older.jobId); store.updateMigrationJob(older.jobId, 'failed', {}, 'verification failed');
  assert.throws(() => new MigrationRecycling(store).confirm(plan.planId), /recycling_source_not_reconciled/);
  store.updateMigrationJob(older.jobId, 'queued', {});
  const result = await importProjectJournal(store, path.join(alias, '.solopreneur', 'project_journal.db'), { projectRoot: alias }); assert.equal(result.conflicts.length, 0);
  store.updateMigrationJob(older.jobId, 'completed', {});
  assert.equal(new MigrationRecycling(store).confirm(plan.planId).confirmed, true);
  await closeOwner(); const reopened = UnifiedDataStore.open(store.root);
  try { assert.equal(new MigrationRecycling(reopened).confirm(plan.planId).confirmed, true); } finally { reopened.close(); }
}));


for(const approvedBeforeImport of [false,true]) test(`an earlier journal recycling plan remains valid after a recorded external body gap: approved=${approvedBeforeImport}`,()=>fixture(async({workspace,project,store,ops,record})=>{
 const crypto=require('node:crypto');const {MigrationRecycling}=require('../out/migrationRecycling.js');const recycling=new MigrationRecycling(store);
 const journal=path.join(workspace,'.solopreneur','project_journal.db');const legacy=new SqliteStore(journal,path.resolve(__dirname,'..'));await legacy.init();try{legacy.upsertRunIndex({...record(12),totalTokens:0,outputPath:path.join(workspace,'.solopreneur','agent-runs','__solo__','12','output.log')});}finally{legacy.close();}
 const bytes=fs.readFileSync(journal);const identity=`project-journal:${workspace}`;store.captureMigrationSource({identity,key:path.basename(journal),hash:crypto.createHash('sha256').update(bytes).digest('hex')},bytes);store.markMigrationSourceImported(identity,path.basename(journal));
 const plan=await recycling.prepare();assert.equal(plan.files.length,1);if(approvedBeforeImport)recycling.confirm(plan.planId);
 const job=await ops({operation:'import_project_data',input:{collection:'project-journal',sourceRoot:journal,projectRoot:workspace,idempotencyKey:'journal-gap-after-old-plan'}});await ops.waitForMigrations();assert.equal(store.readMigrationJob(job.jobId).status,'completed');
 assert.ok(store.readMigrationJob(job.jobId).progress.retainedGaps.some(item=>item.error==='historical_run_output_missing'));
 if(approvedBeforeImport){const held=await recycling.hold(plan.files[0].itemId);assert.equal(fs.readFileSync(held.path).compare(bytes),0);}
 else assert.equal(recycling.confirm(plan.planId).confirmed,true);
 if(!approvedBeforeImport)assert.equal(fs.readFileSync(journal).compare(bytes),0);assert.equal(store.readProjectRunIndexes(project)[0].totalTokens,0);
}));

for (const operation of ['hold', 'finish', 'retire']) test(`a held journal remains recoverable when reconciliation changes before ${operation}`, () => fixture(async ({ workspace, store }) => {
  const crypto = require('node:crypto'); const { MigrationRecycling } = require('../out/migrationRecycling.js');
  const recycling = new MigrationRecycling(store); const journal = path.join(workspace, '.solopreneur', 'project_journal.db');
  fs.mkdirSync(path.dirname(journal), { recursive: true }); const bytes = Buffer.from('test-owned fully captured journal'); fs.writeFileSync(journal, bytes);
  const identity = `project-journal:${workspace}`; const key = path.basename(journal);
  store.captureMigrationSource({ identity, key, hash: crypto.createHash('sha256').update(bytes).digest('hex') }, bytes); store.markMigrationSourceImported(identity, key);
  const plan = await recycling.prepare(); recycling.confirm(plan.planId); const itemId = plan.files[0].itemId; const held = await recycling.hold(itemId);
  let retained = held.path;
  if (operation === 'finish') { retained += '.test-retained'; fs.renameSync(held.path, retained); }
  store.markMigrationSourceConflict(identity, key, 'migration_target_changed');
  await assert.rejects(() => recycling[operation](itemId), /recycling_source_not_reconciled/);
  assert.equal(fs.readFileSync(retained).compare(bytes), 0);
  assert.equal(store.recyclingItems().find(item => item.itemId === itemId).status, 'held');
  assert.equal(store.recyclingSnapshot(itemId).bytes.compare(bytes), 0);
}));

for (const operation of ['confirm', 'hold', 'finish', 'retire']) for (const phase of ['queued', 'running']) for (const aliasRoot of [false, true]) test(`${phase} journal reconciliation invalidates earlier ${operation} immediately: alias=${aliasRoot}`, () => fixture(async ({ workspace, store, ops, record }) => {
  const crypto = require('node:crypto'); const { MigrationRecycling } = require('../out/migrationRecycling.js'); const recycling = new MigrationRecycling(store);
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { legacy.upsertRunIndex({ ...record(12), totalTokens: 0, outputPath: path.join(workspace, '.solopreneur', 'agent-runs', '__solo__', '12', 'output.log') }); } finally { legacy.close(); }
  const bytes = fs.readFileSync(journal); const identity = `project-journal:${workspace}`; const key = path.basename(journal);
  store.captureMigrationSource({ identity, key, hash: crypto.createHash('sha256').update(bytes).digest('hex') }, bytes); store.markMigrationSourceImported(identity, key);
  const plan = await recycling.prepare(); const itemId = plan.files[0].itemId;
  if (operation !== 'confirm') recycling.confirm(plan.planId);
  let retained = journal;
  if (['finish', 'retire'].includes(operation)) retained = (await recycling.hold(itemId)).path;
  if (operation === 'finish') { const held = retained; retained += '.test-retained'; fs.renameSync(held, retained); }
  const targetRoot = aliasRoot ? path.join(path.dirname(workspace), 'reconciliation-project-alias') : workspace;
  if (aliasRoot) fs.symlinkSync(workspace, targetRoot, 'dir');
  const source = path.join(targetRoot, '.solopreneur', path.basename(journal));
  const lstat = fs.promises.lstat; let release; let entered;
  const gate = new Promise(resolve => { release = resolve; }); const paused = new Promise(resolve => { entered = resolve; }); let heldAtSource = false;
  if (phase === 'running') fs.promises.lstat = async (file, ...args) => {
    if (file === source && !heldAtSource) { heldAtSource = true; entered(); await gate; }
    return lstat(file, ...args);
  };
  try {
    const job = await ops({ operation: 'import_project_data', input: { collection: 'project-journal', sourceRoot: source, projectRoot: targetRoot, idempotencyKey: `reconciliation-${operation}-${phase}-${aliasRoot}` } });
    if (phase === 'running') await paused;
    assert.equal(store.readMigrationJob(job.jobId).status, phase);
    if (operation === 'confirm') assert.throws(() => recycling.confirm(plan.planId), /recycling_source_not_reconciled/);
    else await assert.rejects(() => recycling[operation](itemId), /recycling_source_not_reconciled/);
    assert.equal(fs.readFileSync(retained).compare(bytes), 0);
  } finally { release(); fs.promises.lstat = lstat; await ops.waitForMigrations(); }
}));

test('an interrupted journal recheck after detecting a gap cannot restore old imported eligibility', () => fixture(async ({ workspace, store, record, closeOwner }) => {
  const crypto = require('node:crypto'); const { MigrationRecycling } = require('../out/migrationRecycling.js'); const { importProjectJournal } = require('../out/projectDataMigration.js');
  const journal = path.join(workspace, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
  try { for (const id of [12, 13]) legacy.upsertRunIndex({ ...record(id), totalTokens: 0, outputPath: path.join(workspace, '.solopreneur', 'agent-runs', '__solo__', String(id), 'output.log') }); } finally { legacy.close(); }
  const bytes = fs.readFileSync(journal); const identity = `project-journal:${workspace}`; const key = path.basename(journal);
  store.captureMigrationSource({ identity, key, hash: crypto.createHash('sha256').update(bytes).digest('hex') }, bytes); store.markMigrationSourceImported(identity, key);
  const recycling = new MigrationRecycling(store); const plan = await recycling.prepare(); let checks = 0;
  const result = await importProjectJournal(store, journal, { projectRoot: workspace, shouldContinue: () => ++checks < 2 });
  assert.equal(result.interrupted, true); assert.ok(result.retainedGaps.some(item => item.error === 'historical_run_output_missing'));
  assert.throws(() => recycling.confirm(plan.planId), /recycling_source_not_reconciled/);
  assert.equal(fs.readFileSync(journal).compare(bytes), 0);
  await closeOwner(); const reopened = UnifiedDataStore.open(store.root);
  try {
    assert.throws(() => new MigrationRecycling(reopened).confirm(plan.planId), /recycling_source_not_reconciled/);
    assert.equal(reopened.readMigrationSource(identity, key).bytes.compare(bytes), 0);
  } finally { reopened.close(); }
}));

for (const family of ['codex', 'claude']) for (const differentProject of [false, true]) test(`${family} transcript through a registered alias checks physical identity: differentProject=${differentProject}`, () => fixture(async ({ workspace, project, store, ops, record }) => {
  const alias = path.join(path.dirname(workspace), 'transcript-project-alias'); fs.symlinkSync(workspace, alias, 'dir');
  const sessionId = '73fd451d-df8d-4c5a-bffd-b5e5b6838a72'; const home = path.join(path.dirname(workspace), 'alias-native-home');
  const previousHome = process.env.HOME; if (family === 'claude') process.env.HOME = home;
  try {
    const directory = family === 'codex' ? path.join(home, 'sessions') : path.join(home, '.claude', 'projects', 'fixture'); fs.mkdirSync(directory, { recursive: true });
    const transcript = path.join(directory, family === 'codex' ? `rollout-2026-10-09-${sessionId}.jsonl` : `${sessionId}.jsonl`);
    const cwd = differentProject ? path.join(path.dirname(workspace), 'different-physical-project') : workspace;
    if (differentProject) fs.mkdirSync(cwd);
    const body = [family === 'codex' ? { type: 'session_meta', payload: { id: sessionId, cwd } } : { type: 'user', cwd },
      family === 'codex' ? { type: 'event_msg', timestamp: '2026-10-09T09:01:00Z', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 300 } } } } : { type: 'assistant', timestamp: '2026-10-09T09:01:00Z', cwd, message: { id: 'alias-message', usage: { input_tokens: 300, output_tokens: 0 } } }].map(entry => JSON.stringify(entry)).join('\n');
    fs.writeFileSync(transcript, body); const run = path.join(alias, '.solopreneur', 'agent-runs', '__solo__', '12'); fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, 'output.log'), '完整日志没有计量'); fs.writeFileSync(path.join(run, 'session.json'), JSON.stringify({ sessionId })); fs.writeFileSync(path.join(run, 'codex-home.txt'), home);
    const journal = path.join(alias, '.solopreneur', 'project_journal.db'); const legacy = new SqliteStore(journal, path.resolve(__dirname, '..')); await legacy.init();
    try { legacy.upsertRunIndex({ ...record(12), agentCli: family, totalTokens: 0, outputPath: path.join(run, 'output.log') }); } finally { legacy.close(); }
    const job = await ops({ operation: 'import_project_data', input: { collection: 'project-journal', sourceRoot: journal, projectRoot: alias, idempotencyKey: `native-transcript-alias-${family}` } }); await ops.waitForMigrations();
    assert.equal(store.readMigrationJob(job.jobId).status, differentProject ? 'completed_with_conflicts' : 'completed');
    if (differentProject) assert.equal(store.readProjectRunIndexes(project).length, 0);
    else assert.equal(store.readProjectRunIndexes(project)[0].totalTokens, 300);
    const evidence = store.rows('SELECT source_content_id FROM migration_items WHERE source_identity=?', [`native-token-evidence:${project}`]);
    if (differentProject) {
      assert.ok(store.readMigrationJob(job.jobId).progress.conflicts.some(item => item.error.includes('historical_native_session_scope_mismatch')));
      assert.equal(evidence.length, 0); assert.equal(fs.readFileSync(transcript, 'utf8'), body);
    } else { assert.equal(evidence.length, 1); assert.equal(store.content(evidence[0].source_content_id).toString(), body); }
  } finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; }
}));
