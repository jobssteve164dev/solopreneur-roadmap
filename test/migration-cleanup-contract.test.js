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

test('retired project scaffolding is archived for exact consumer readback while current and user files stay local', () => fixture(async f => {
  const solo = path.join(f.project, '.solopreneur');
  fs.mkdirSync(path.join(solo, 'attachments', 'solo'), { recursive: true });
  fs.mkdirSync(path.join(solo, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(solo, 'runtime', 'business-migration'), { recursive: true });
  fs.mkdirSync(path.join(solo, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(solo, 'step-sessions'), { recursive: true });
  fs.mkdirSync(path.join(solo, 'path-recovery-20260728T074000Z'), { recursive: true });
  fs.mkdirSync(path.join(solo, 'audits'), { recursive: true });
  const retired = new Map([
    ['README.md', Buffer.from('generated project data instructions')],
    ['execution-graph.json', Buffer.from('{"nodes":["complete legacy graph"]}')],
    ['runtime/task-checkpoint.cjs', Buffer.from('module.exports = "legacy checkpoint";')],
    ['step-sessions/__solo__.json', Buffer.from('{"sessionId":"legacy-session"}')],
    ['attachments/solo/context.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])],
    ['path-recovery-20260728T074000Z/recovered.txt', Buffer.from('preserved recovery evidence')]
  ]);
  for (const [relative, bytes] of retired) fs.writeFileSync(path.join(solo, relative), bytes);
  const retained = new Map([
    ['project.json', Buffer.from(JSON.stringify({ schemaVersion: 1, projectId: f.registered.projectId }))],
    ['roadmap.csv', Buffer.from('id,title\n1,Keep the roadmap\n')],
    ['path-recovery-20260728T074000Z/roadmap.csv', Buffer.from('id,title\n2,Keep the recovered roadmap too\n')],
    ['time-plan.json', Buffer.from('{"version":1,"status":"draft"}')],
    ['audits/user-review.md', Buffer.from('formal user-owned audit')],
    ['runtime/business-migration/manifest.json', Buffer.from('{"businessAsset":true}')],
    ['tmp/customer-export.sql', Buffer.from('select * from customer_data;')],
    ['product-notes.md', Buffer.from('unknown user document stays local')]
  ]);
  for (const [relative, bytes] of retained) fs.writeFileSync(path.join(solo, relative), bytes);

  const job = await f.call('import_project_data', {
    collection: 'project-legacy-files', projectRoot: f.project, sourceRoot: solo, idempotencyKey: 'legacy-project-files'
  });
  await f.ops.waitForMigrations();
  const status = f.store.readMigrationJob(job.jobId);
  assert.equal(status.status, 'completed');
  assert.equal(status.progress.imported, retired.size);
  assert.equal(status.progress.retainedFiles.length, retained.size);

  const graphBytes = retired.get('execution-graph.json');
  const graphVerification = await f.call('migration_status', { projectRoot: f.project, jobId: job.jobId, verifySourceKey: 'execution-graph.json' });
  assert.deepEqual(graphVerification.sourceVerification, {
    identity: `project-legacy-files:${f.project}`,
    key: 'execution-graph.json',
    hash: crypto.createHash('sha256').update(graphBytes).digest('hex'),
    bytes: graphBytes.length,
    verified: true,
    stage: 'imported'
  });

  const identity = `project-legacy-files:${f.project}`;
  for (const [relative, bytes] of retired) {
    const source = f.store.rows('SELECT stage FROM migration_items WHERE source_identity=? AND source_key=?', [identity, relative])[0];
    assert.equal(source.stage, 'imported');
    const evidenceRef = status.progress.archivedSources.find(item => item.source === relative).evidenceRef;
    const archived = f.store.read(evidenceRef.split('/').at(-1));
    assert.equal(archived.kind, 'evidence');
    assert.equal(archived.projectId, f.registered.projectId);
    const readback = typeof archived.data.content === 'string'
      ? Buffer.from(archived.data.content)
      : Buffer.from(archived.data.content.data, 'base64');
    assert.deepEqual(readback, bytes);
  }
  assert.deepEqual(
    f.store.rows('SELECT source_key FROM migration_items WHERE source_identity=? ORDER BY source_key', [identity]).map(row => row.source_key),
    [...retired.keys()].sort()
  );
  const plan = await f.call('prepare_recycling', { projectRoot: f.project });
  assert.deepEqual(plan.files.map(file => path.relative(solo, file.path)).sort(), [...retired.keys()].sort());
  await f.call('confirm_recycling', { projectRoot: f.project, planId: plan.planId, files: plan.files });
  const recycled = await f.call('execute_recycling_plan', { projectRoot: f.project, planId: plan.planId });
  assert.equal(recycled.recycledFiles, retired.size);
  for (const relative of retired.keys()) assert.equal(fs.existsSync(path.join(solo, relative)), false);
  for (const directory of ['attachments', 'step-sessions']) {
    assert.equal(fs.existsSync(path.join(solo, directory)), false, `${directory} must not remain as an empty legacy folder`);
  }
  assert.equal(fs.existsSync(path.join(solo, 'path-recovery-20260728T074000Z')), true, 'a legacy folder containing roadmap.csv must remain');
  assert.equal(fs.existsSync(path.join(solo, 'runtime')), true, 'runtime remains because it contains retained business data');
  for (const [relative, bytes] of retained) assert.deepEqual(fs.readFileSync(path.join(solo, relative)), bytes);
  const attachment = plan.files.find(file => file.path.endsWith('context.png'));
  await f.call('restore_recycling_file', { projectRoot: f.project, itemId: attachment.itemId });
  assert.deepEqual(fs.readFileSync(path.join(solo, 'attachments/solo/context.png')), retired.get('attachments/solo/context.png'));
}));

test('legacy project migration rejects a retired file reached through an ancestor symlink swapped during capture', () => fixture(async f => {
  const solo = path.join(f.project, '.solopreneur');
  const attachments = path.join(solo, 'attachments');
  const retainedAttachments = path.join(f.base, 'retained-attachments');
  const outside = path.join(f.base, 'outside');
  const source = path.join(attachments, 'evidence.txt');
  fs.mkdirSync(attachments, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(source, 'inside bytes');
  fs.writeFileSync(path.join(outside, 'evidence.txt'), 'outside bytes must never be archived');
  const lstat = fs.promises.lstat;
  let swapped = false;
  fs.promises.lstat = async file => {
    if (!swapped && file === source) {
      swapped = true;
      fs.renameSync(attachments, retainedAttachments);
      fs.symlinkSync(outside, attachments);
    }
    return lstat(file);
  };
  try {
    const job = await f.call('import_project_data', {
      collection: 'project-legacy-files', projectRoot: f.project, sourceRoot: solo, idempotencyKey: 'legacy-project-ancestor-symlink'
    });
    await f.ops.waitForMigrations();
    const status = f.store.readMigrationJob(job.jobId);
    assert.equal(status.status, 'completed_with_conflicts');
    assert.deepEqual(status.progress.conflicts, [{ source, error: 'migration_source_invalid' }]);
    assert.deepEqual(f.store.rows('SELECT source_key FROM migration_items WHERE source_identity=?', [`project-legacy-files:${f.project}`]), []);
    assert.deepEqual((await f.call('prepare_recycling', { projectRoot: f.project })).files, []);
  } finally { fs.promises.lstat = lstat; }
}));

test('legacy discovery does not enumerate an outside directory swapped in before readdir', () => fixture(async f => {
  const solo = path.join(f.project, '.solopreneur');
  const attachments = path.join(solo, 'attachments');
  const retainedAttachments = path.join(f.base, 'retained-attachments');
  const outside = path.join(f.base, 'outside');
  fs.mkdirSync(attachments, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(attachments, 'inside.txt'), 'inside evidence');
  fs.writeFileSync(path.join(outside, 'outside-only-secret-name.txt'), 'outside evidence');
  const readdir = fs.promises.readdir; let calls = 0;
  fs.promises.readdir = async (directory, options) => {
    calls++;
    if (calls === 2) {
      await fs.promises.rename(attachments, retainedAttachments);
      fs.symlinkSync(outside, attachments);
    }
    return readdir(directory, options);
  };
  try {
    const job = await f.call('import_project_data', {
      collection: 'project-legacy-files', projectRoot: f.project, sourceRoot: solo, idempotencyKey: 'legacy-project-discovery-ancestor-swap'
    });
    await f.ops.waitForMigrations();
    const status = f.store.readMigrationJob(job.jobId);
    assert.ok(!status.progress.conflicts.some(conflict => conflict.source.endsWith('outside-only-secret-name.txt')),
      'outside directory entry names must never enter migration results');
    assert.ok(!status.progress.archivedSources?.some(source => source.source.endsWith('outside-only-secret-name.txt')),
      'outside directory bytes must never enter migration evidence');
  } finally { fs.promises.readdir = readdir; }
}));

test('recycling retries empty legacy-directory pruning after the file was already retired', () => fixture(async f => {
  const solo = path.join(f.project, '.solopreneur');
  const attachmentDirectory = path.join(solo, 'attachments', 'solo');
  fs.mkdirSync(attachmentDirectory, { recursive: true });
  fs.writeFileSync(path.join(attachmentDirectory, 'old.txt'), 'archived attachment');
  const job = await f.call('import_project_data', {
    collection: 'project-legacy-files', projectRoot: f.project, sourceRoot: solo, idempotencyKey: 'legacy-project-prune-retry'
  });
  await f.ops.waitForMigrations();
  const plan = await f.call('prepare_recycling', { projectRoot: f.project });
  await f.call('confirm_recycling', { projectRoot: f.project, planId: plan.planId, files: plan.files });
  const rmdir = fs.promises.rmdir; let failed = false;
  fs.promises.rmdir = async directory => {
    if (!failed) { failed = true; throw Object.assign(new Error('fixture prune interruption'), { code: 'EACCES' }); }
    return rmdir(directory);
  };
  try {
    await assert.rejects(f.call('execute_recycling_plan', { projectRoot: f.project, planId: plan.planId }), /fixture prune interruption/);
  } finally { fs.promises.rmdir = rmdir; }
  assert.equal(fs.existsSync(path.join(attachmentDirectory, 'old.txt')), false);
  assert.equal(fs.existsSync(attachmentDirectory), true);
  await f.call('execute_recycling_plan', { projectRoot: f.project, planId: plan.planId });
  assert.equal(fs.existsSync(path.join(solo, 'attachments')), false);
}));

test('recycling cannot move an outside file when a source ancestor is swapped during the physical move', () => fixture(async f => {
  const solo = path.join(f.project, '.solopreneur');
  const attachments = path.join(solo, 'attachments');
  const retainedAttachments = path.join(f.base, 'retained-attachments');
  const outside = path.join(f.base, 'outside');
  const source = path.join(attachments, 'old.txt');
  fs.mkdirSync(attachments, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(source, 'same bytes');
  fs.writeFileSync(path.join(outside, 'old.txt'), 'same bytes');
  const job = await f.call('import_project_data', {
    collection: 'project-legacy-files', projectRoot: f.project, sourceRoot: solo, idempotencyKey: 'legacy-project-recycle-ancestor-swap'
  });
  await f.ops.waitForMigrations();
  const plan = await f.call('prepare_recycling', { projectRoot: f.project });
  await f.call('confirm_recycling', { projectRoot: f.project, planId: plan.planId, files: plan.files });
  const rename = fs.promises.rename; let swapped = false;
  fs.promises.rename = async (from, to) => {
    if (!swapped && String(to).includes('.migration-recycle')) {
      swapped = true;
      await rename(attachments, retainedAttachments);
      fs.symlinkSync(outside, attachments);
    }
    return rename(from, to);
  };
  try { await f.call('execute_recycling_plan', { projectRoot: f.project, planId: plan.planId }); }
  catch { /* A detected race may retain the source, but must never move the outside file. */ }
  finally { fs.promises.rename = rename; }
  assert.equal(fs.readFileSync(path.join(outside, 'old.txt'), 'utf8'), 'same bytes');
}));

test('empty-directory pruning cannot remove an outside directory when an ancestor is swapped during rmdir', () => fixture(async f => {
  const solo = path.join(f.project, '.solopreneur');
  const attachments = path.join(solo, 'attachments');
  const nested = path.join(attachments, 'solo');
  const retainedAttachments = path.join(f.base, 'retained-attachments');
  const outside = path.join(f.base, 'outside');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(outside, 'solo'), { recursive: true });
  fs.writeFileSync(path.join(nested, 'old.txt'), 'archived bytes');
  const job = await f.call('import_project_data', {
    collection: 'project-legacy-files', projectRoot: f.project, sourceRoot: solo, idempotencyKey: 'legacy-project-prune-ancestor-swap'
  });
  await f.ops.waitForMigrations();
  const plan = await f.call('prepare_recycling', { projectRoot: f.project });
  await f.call('confirm_recycling', { projectRoot: f.project, planId: plan.planId, files: plan.files });
  const rmdir = fs.promises.rmdir; let swapped = false;
  fs.promises.rmdir = async directory => {
    if (!swapped) {
      swapped = true;
      await fs.promises.rename(attachments, retainedAttachments);
      fs.symlinkSync(outside, attachments);
    }
    return rmdir(directory);
  };
  try { await f.call('execute_recycling_plan', { projectRoot: f.project, planId: plan.planId }); }
  finally { fs.promises.rmdir = rmdir; }
  assert.equal(fs.existsSync(path.join(outside, 'solo')), true);
}));

test('restore publishing cannot create a file outside the approved project when its ancestor is swapped during link', () => fixture(async f => {
  const solo = path.join(f.project, '.solopreneur');
  const attachments = path.join(solo, 'attachments');
  const source = path.join(attachments, 'old.txt');
  fs.mkdirSync(attachments, { recursive: true });
  fs.writeFileSync(source, 'archived bytes');
  const job = await f.call('import_project_data', {
    collection: 'project-legacy-files', projectRoot: f.project, sourceRoot: solo, idempotencyKey: 'legacy-project-restore-ancestor-swap'
  });
  await f.ops.waitForMigrations();
  const plan = await f.call('prepare_recycling', { projectRoot: f.project });
  await f.call('confirm_recycling', { projectRoot: f.project, planId: plan.planId, files: plan.files });
  await f.call('execute_recycling_plan', { projectRoot: f.project, planId: plan.planId });
  const retainedAttachments = path.join(f.base, 'retained-restore-directory');
  const outside = path.join(f.base, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const link = fs.promises.link; let swapped = false;
  fs.promises.link = async (from, to) => {
    if (!swapped) {
      swapped = true;
      await fs.promises.rename(attachments, retainedAttachments);
      fs.symlinkSync(outside, attachments);
    }
    return link(from, to);
  };
  try { await f.call('restore_recycling_file', { projectRoot: f.project, itemId: plan.files[0].itemId }); }
  catch { /* A detected race may require another restore, but cannot publish outside. */ }
  finally { fs.promises.link = link; }
  assert.equal(fs.existsSync(path.join(outside, 'old.txt')), false);
}));

test('a symlink that replaces a verified regular source during move remains recoverable through the formal restore path', () => fixture(async f => {
  const solo = path.join(f.project, '.solopreneur');
  const attachments = path.join(solo, 'attachments');
  const source = path.join(attachments, 'old.txt');
  fs.mkdirSync(attachments, { recursive: true });
  fs.writeFileSync(source, 'approved original bytes');
  const job = await f.call('import_project_data', {
    collection: 'project-legacy-files', projectRoot: f.project, sourceRoot: solo, idempotencyKey: 'legacy-project-leaf-symlink-swap'
  });
  await f.ops.waitForMigrations();
  const plan = await f.call('prepare_recycling', { projectRoot: f.project });
  await f.call('confirm_recycling', { projectRoot: f.project, planId: plan.planId, files: plan.files });
  const rename = fs.promises.rename; const link = fs.promises.link;
  let swapped = false; let blockedRollback = false;
  fs.promises.rename = async (from, to) => {
    if (!swapped) {
      swapped = true;
      fs.unlinkSync(source);
      fs.symlinkSync('replacement-target', source);
    }
    return rename(from, to);
  };
  fs.promises.link = async (from, to) => {
    if (swapped && !blockedRollback && path.basename(String(to)) === 'old.txt') {
      blockedRollback = true;
      throw Object.assign(new Error('fixture rollback unavailable'), { code: 'EPERM' });
    }
    return link(from, to);
  };
  try { await assert.rejects(f.call('execute_recycling_plan', { projectRoot: f.project, planId: plan.planId })); }
  finally { fs.promises.rename = rename; fs.promises.link = link; }
  assert.equal(fs.existsSync(source), false);
  await f.call('restore_recycling_file', { projectRoot: f.project, itemId: plan.files[0].itemId });
  assert.equal(fs.lstatSync(source).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(source), 'replacement-target');
}));

test('legacy project migration retains a symlink without reading or recycling its target', () => fixture(async f => {
  const solo = path.join(f.project, '.solopreneur');
  const attachments = path.join(solo, 'attachments');
  const outside = path.join(f.base, 'outside-secret.png');
  fs.mkdirSync(attachments, { recursive: true });
  fs.writeFileSync(outside, 'outside bytes must remain private');
  fs.symlinkSync(outside, path.join(attachments, 'escape.png'));

  const job = await f.call('import_project_data', {
    collection: 'project-legacy-files', projectRoot: f.project, sourceRoot: solo, idempotencyKey: 'legacy-project-symlink'
  });
  await f.ops.waitForMigrations();
  const status = f.store.readMigrationJob(job.jobId);
  assert.equal(status.status, 'completed_with_conflicts');
  assert.deepEqual(status.progress.conflicts, [{ source: path.join(attachments, 'escape.png'), error: 'migration_source_invalid' }]);
  assert.deepEqual((await f.call('prepare_recycling', { projectRoot: f.project })).files, []);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside bytes must remain private');
  assert.equal(fs.readlinkSync(path.join(attachments, 'escape.png')), outside);
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
