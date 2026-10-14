const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');

async function fixture(action) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-cleanup-contract-'));
  const root = path.join(base, 'global');
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  const store = new UnifiedDataStore(root);
  const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const registered = await call('register_project', { root: project });
    await action({ base, root, project, store, ops, call, registered });
  } finally {
    await ops.close();
    store.close();
  }
}

test('published journal entries with embedded relations reconcile through their complete consumer projection', () => fixture(async f => {
  const record = { executionLogId: 7, nodeId: '__solo__', runKind: 'solo', agentCli: 'codex', status: 'Completed', startedAt: '2026-01-01', finishedAt: '2026-01-02', durationMs: 5, totalTokens: 17 };
  const files = [{ filePath: 'src/full.ts', role: 'changed' }];
  const signals = [{ executionLogId: 7, type: 'reusable', value: 'complete relationship' }];
  f.store.importProjectRunIndex(f.registered.projectId, { ...record, files, signals }, files, signals);
  const before = f.store.readProjectRunIndexes(f.registered.projectId);
  assert.equal(f.store.importHistoricalRunIndex(f.registered.projectId, record, files, signals, { identity: `project-journal:${f.project}`, key: 'project_journal.db', hash: 'verified-source' }, 20, record), false);
  assert.deepEqual(f.store.readProjectRunIndexes(f.registered.projectId), before);
  assert.throws(() => f.store.importHistoricalRunIndex(f.registered.projectId, record, files, [{ ...signals[0], value: 'changed' }], { identity: `project-journal:${f.project}`, key: 'project_journal.db', hash: 'changed-source' }, 20, record), /historical_run_index_owner_unknown/);
  f.store.importProjectRunIndex(f.registered.projectId, { ...record, executionLogId: 8, files: [{ filePath: 'hidden.ts', role: 'changed' }], signals }, files, signals);
  const other = { ...record, executionLogId: 8 };
  assert.throws(() => f.store.importHistoricalRunIndex(f.registered.projectId, other, files, signals, { identity: `project-journal:${f.project}`, key: 'project_journal.db', hash: 'ambiguous-source' }, 20, other), /historical_run_index_owner_unknown/);
}));

test('a coarse run-directory projection preserves an existing complete index without claiming ownership', () => fixture(async f => {
  const record = { executionLogId: 7, nodeId: '__solo__', runKind: 'solo', agentCli: 'codex', status: 'Completed', startedAt: '2026-01-01', finishedAt: '2026-01-02', durationMs: 5, totalTokens: 17 };
  const files = [{ filePath: 'src/verified.ts', role: 'changed' }];
  const signals = [{ executionLogId: 7, type: 'verification', value: 'original complete signal' }];
  f.store.importProjectRunIndex(f.registered.projectId, record, files, signals);
  const before = f.store.readProjectRunIndexes(f.registered.projectId);
  assert.equal(f.store.importHistoricalRunIndex(f.registered.projectId, { ...record, status: 'unknown', durationMs: 0, totalTokens: 0 }, [], [], { identity: `agent-runs:${f.project}`, key: '__solo__/7', hash: 'directory-proof' }, 10), false);
  assert.deepEqual(f.store.readProjectRunIndexes(f.registered.projectId), before);
  assert.equal(f.store.rows('SELECT count(*) AS n FROM run_index_import_sources')[0].n, 0);
  assert.throws(() => f.store.importHistoricalRunIndex(f.registered.projectId, { ...record, nodeId: 'foreign-node' }, [], [], { identity: `agent-runs:${f.project}`, key: 'foreign-node/7', hash: 'foreign-proof' }, 10), /historical_run_identity_ambiguous/);
}));

test('a selected historical growth graph remains complete beyond the recent fifty snapshots', () => fixture(async f => {
  let first;
  for (let index = 0; index < 52; index++) {
    const id = `old-${index}`;
    const data = {
      snapshot: { id, projectPath: f.project, createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), gitHead: `commit-${index}`, scanReason: 'history', status: 'completed', durationMs: index, error: '' },
      nodes: [{ snapshotId: id, nodeId: 'root', parentId: '', kind: 'directory', path: '', label: 'root', language: '', bytes: 17, loc: 2, fileCount: 1, testFileCount: 0, generated: false, excluded: false, primaryRole: 'feature', confidence: 1 }],
      edges: [{ snapshotId: id, sourceId: 'root', targetId: 'root', kind: 'depends_on', weight: 1, evidence: 'complete relationship' }],
      signals: [{ snapshotId: id, nodeId: 'root', type: 'verification', level: 'info', value: 'full signal', source: 'test', sourceRef: 'proof', createdAt: '2026-01-01T00:00:00.000Z' }],
      labels: [{ snapshotId: id, nodeId: 'root', label: 'full label', role: 'feature', source: 'test', confidence: 1, updatedAt: '2026-01-01T00:00:00.000Z' }]
    };
    const receipt = f.store.writeProjectGrowth(f.registered.projectId, data, `snapshot-${index}`);
    if (!index) first = receipt.objectId;
  }
  const recent = await f.call('read_project_growth', { root: f.project, historyLimit: 50 });
  assert.equal(recent.history.length, 50);
  assert.equal(recent.latest.snapshot.gitHead, 'commit-51');
  const selected = await f.call('read_project_growth', { root: f.project, snapshotId: first });
  assert.equal(selected.history.length, 1);
  assert.equal(selected.latest.snapshot.gitHead, 'commit-0');
  assert.equal(selected.latest.nodes[0].bytes, 17);
  assert.equal(selected.latest.edges[0].evidence, 'complete relationship');
  assert.equal(selected.latest.signals[0].value, 'full signal');
  assert.equal(selected.latest.labels[0].label, 'full label');
  const other = path.join(f.base, 'other'); fs.mkdirSync(other);
  await f.call('register_project', { root: other });
  await assert.rejects(f.call('read_project_growth', { root: other, snapshotId: first }), /growth_snapshot_missing/);
}));

test('migration status verifies the complete captured source without exposing its body', () => fixture(async f => {
  const bytes = Buffer.from('full original source\n'.repeat(10000));
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  f.store.captureMigrationSource({ identity: `project-growth:${f.project}`, key: 'project_growth.db', hash }, bytes);
  const job = f.store.enqueueMemoryMigration({ collection: 'project-growth', projectRoot: f.project, sourceRoot: path.join(f.project, '.solopreneur/project_growth.db') }, 'capture-job');
  f.store.updateMigrationJob(job.jobId, 'completed', { imported: 1, conflicts: [] });
  const result = await f.call('migration_status', { projectRoot: f.project, jobId: job.jobId, verifySourceKey: 'project_growth.db' });
  assert.deepEqual(result.sourceVerification, { identity: `project-growth:${f.project}`, key: 'project_growth.db', hash, bytes: bytes.length, verified: true, stage: 'captured' });
  assert.doesNotMatch(JSON.stringify(result), /full original source/);
  await assert.rejects(f.call('migration_status', { projectRoot: f.project, jobId: job.jobId, verifySourceKey: '../private' }), /migration_source_scope_mismatch/);
}));

test('fully imported step memory is physically retired through the existing exact approval and restore chain', () => fixture(async f => {
  const sourceRoot = path.join(f.project, '.solopreneur/step-memory'); fs.mkdirSync(sourceRoot);
  const file = path.join(sourceRoot, 'step.json');
  const bytes = JSON.stringify({ completionCriteria: ['complete original criteria'], entries: [{ raw: 'all original handoff content' }], custom: 'preserve unknown fields' });
  fs.writeFileSync(file, bytes);
  const job = await f.call('import_project_data', { collection: 'step-memory', projectRoot: f.project, sourceRoot, idempotencyKey: 'step-import' });
  await f.ops.waitForMigrations();
  assert.equal(f.store.readMigrationJob(job.jobId).status, 'completed');
  const plan = await f.call('prepare_recycling', { projectRoot: f.project });
  assert.deepEqual(plan.files.map(item => item.path), [file]);
  await assert.rejects(f.call('hold_recycling_file', { itemId: plan.files[0].itemId }), /recycling_confirmation_required/);
  await f.call('confirm_recycling', { projectRoot: f.project, planId: plan.planId, files: plan.files });
  await f.call('hold_recycling_file', { itemId: plan.files[0].itemId });
  await f.call('retire_recycling_file', { itemId: plan.files[0].itemId });
  assert.equal(fs.existsSync(file), false);
  const consumer = await f.call('read_step_memory', { root: f.project, nodeId: 'step' });
  assert.deepEqual(consumer.data.completionCriteria, ['complete original criteria']);
  assert.equal(consumer.data.entries[0].raw, 'all original handoff content');
  assert.equal(consumer.data.custom, 'preserve unknown fields');
  await f.call('restore_recycling_file', { projectRoot: f.project, itemId: plan.files[0].itemId });
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
}));

test('recycling refuses a nested directory replaced by a link to a matching foreign file', () => fixture(async f => {
  const sourceRoot = path.join(f.project, '.solopreneur/step-memory');
  const directory = path.join(sourceRoot, 'a/b'); fs.mkdirSync(directory, { recursive: true });
  const bytes = JSON.stringify({ completionCriteria: ['exact original criterion'] });
  fs.writeFileSync(path.join(directory, 'step.json'), bytes);
  await f.call('import_project_data', { collection: 'step-memory', projectRoot: f.project, sourceRoot, idempotencyKey: 'nested-import' });
  await f.ops.waitForMigrations();
  fs.renameSync(path.join(sourceRoot, 'a'), path.join(f.base, 'retained-original'));
  const foreign = path.join(f.base, 'foreign'); fs.mkdirSync(path.join(foreign, 'b'), { recursive: true });
  fs.writeFileSync(path.join(foreign, 'b/step.json'), bytes);
  fs.symlinkSync(foreign, path.join(sourceRoot, 'a'));
  const plan = await f.call('prepare_recycling', { projectRoot: f.project });
  assert.deepEqual(plan.files, []);
  assert.equal(fs.readFileSync(path.join(foreign, 'b/step.json'), 'utf8'), bytes);
}));

test('ordinary artifact archiving cannot grant physical recycling eligibility without lifecycle adoption', () => fixture(async f => {
  const key = '__solo__/71/prompt.txt';
  const file = path.join(f.project, '.solopreneur/agent-runs', key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.from('complete original prompt'); fs.writeFileSync(file, bytes);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  await f.call('write_run_artifact', { root: f.project, executionLogId: 71, relativePath: key, sourceKey: key, bytes: bytes.toString('base64'), hash });
  assert.equal(f.store.rows('SELECT count(*) AS n FROM run_control')[0].n, 0);
  assert.deepEqual((await f.call('prepare_recycling', { projectRoot: f.project })).files, []);
  assert.equal(f.store.readMigrationSource(`agent-runs:${f.project}`, key).stage, 'captured');
  assert.equal(fs.readFileSync(file).compare(bytes), 0);
}));
