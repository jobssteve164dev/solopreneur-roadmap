const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { importLegacyIntelligenceConversation } = require('../out/intelligenceConversationData.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { readProcessBirthMarker } = require('../out/processIdentity.js');

function fixture() {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-recycling-')), '.solomap-global');
  const id = '047c4416-2fbe-4562-b9b9-29e9e6d536be';
  const file = path.join(root, 'intelligence-conversations', id + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = JSON.stringify({ id, title: 'Old chat', createdAt: '2026-09-22T08:00:00.000Z', updatedAt: '2026-09-22T08:01:00.000Z', messages: [{ role: 'user', content: 'All old content' }, { role: 'assistant', content: 'All old answer' }] });
  fs.writeFileSync(file, original);
  const store = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(store);
  const call = (operation, input = {}) => operations({ operation, input });
  return { root, id, file, original, store, operations, call };
}

test('only fully migrated unchanged files enter an exact approved recycling plan; history remains usable and restorable', async () => {
  const f = fixture();
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const status = await f.call('migration_overview');
    assert.equal(status.reviewableFiles, 1);
    assert.equal(status.recyclableFiles, 0);
    const plan = await f.call('prepare_recycling');
    assert.deepEqual(plan.files.map(file => file.path), [f.file]);
    await assert.rejects(f.call('hold_recycling_file', { itemId: plan.files[0].itemId }), /recycling_confirmation_required/);
    await assert.rejects(f.call('execute_recycling_plan', { planId: plan.planId }), /recycling_items_retained/);
    assert.equal(f.store.recyclingItems()[0].status, 'prepared');
    await f.call('confirm_recycling', { planId: plan.planId });
    const held = await f.call('hold_recycling_file', { itemId: plan.files[0].itemId });
    assert.equal(fs.existsSync(f.file), false);
    assert.equal(fs.readFileSync(held.path, 'utf8'), f.original);
    assert.equal((await f.call('read_intelligence_conversation', { id: f.id })).conversation.messages.length, 2);
    const trash = path.join(f.root, 'fixture-system-trash.json');
    fs.renameSync(held.path, trash); // A test-owned stand-in for the native system trash.
    await f.call('finish_recycling_file', { itemId: plan.files[0].itemId });
    const recycled = await f.call('migration_overview');
    assert.equal(recycled.recycledFiles, 1);
    assert.equal(recycled.reviewableFiles, 0);
    await f.call('restore_recycling_file', { itemId: plan.files[0].itemId });
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
    fs.writeFileSync(f.file, 'Newer user content');
    await assert.rejects(f.call('restore_recycling_file', { itemId: plan.files[0].itemId }), /restore_target_exists/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'Newer user content');
  } finally { await f.operations.close(); f.store.close(); }
});

test('recycling a migrated project artifact prunes its now-empty legacy directory chain', async () => {
  const f = fixture();
  const projectRoot = path.join(path.dirname(f.root), 'project-with-retired-coverage');
  const sourceRoot = path.join(projectRoot, '.solopreneur', 'coverage');
  const sourceFile = path.join(sourceRoot, 'project-growth-coverage.json');
  try {
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, JSON.stringify({ version: 1, provider: 'c8-istanbul', status: 'ready', files: [] }));
    const project = await f.store.registerProject({ root: projectRoot });
    const bytes = fs.readFileSync(sourceFile);
    await require('../out/analysisDatabaseMigration.js').importAnalysisCaches(f.store, f.root, {
      projectScopes: { [projectRoot]: project.projectId },
      archiveUnresolved: true
    });
    const plan = await f.call('prepare_recycling');
    assert.deepEqual(plan.files.map(file => file.path), [sourceFile]);
    await f.call('confirm_recycling', { planId: plan.planId });
    assert.equal((await f.call('execute_recycling_plan', { planId: plan.planId })).recycledFiles, 1);
    assert.equal(fs.existsSync(sourceRoot), false);
    assert.equal(fs.existsSync(path.join(projectRoot, '.solopreneur')), true);
  } finally { await f.operations.close(); f.store.close(); }
});

test('migration overview is immediate and leaves byte validation to explicit review', async () => {
  const f = fixture();
  const readFile = fs.promises.readFile;
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    fs.promises.readFile = async () => { throw new Error('overview_must_not_read_source_bytes'); };
    const status = await f.call('migration_overview');
    assert.equal(status.reviewableFiles, 1);
    assert.equal(status.recyclableFiles, 0);
  } finally { fs.promises.readFile = readFile; await f.operations.close(); f.store.close(); }
});

test('recycling preview validates source files without loading each candidate into one buffer', async () => {
  const f = fixture();
  const readFile = fs.promises.readFile;
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    fs.promises.readFile = async (file, ...args) => {
      if (path.resolve(String(file)) === path.resolve(f.file)) throw new Error('whole_candidate_read');
      return readFile(file, ...args);
    };
    const plan = await f.call('prepare_recycling');
    assert.equal(plan.files.length, 1);
    assert.equal(plan.files[0].path, f.file);
    assert.equal(plan.files[0].bytes, Buffer.byteLength(f.original));
  } finally { fs.promises.readFile = readFile; await f.operations.close(); f.store.close(); }
});

test('recycling preview resolves each physical candidate only before and after its identity-bound read', async () => {
  const f = fixture();
  const realpathSync = fs.realpathSync;
  let physicalResolutions = 0;
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    fs.realpathSync = file => {
      if (path.resolve(String(file)) === path.resolve(path.dirname(f.file))) physicalResolutions++;
      return realpathSync(file);
    };
    const plan = await f.call('prepare_recycling');
    assert.equal(plan.files.length, 1);
    assert.equal(physicalResolutions, 2, 'the preview keeps the two trust-boundary checks without a redundant middle traversal');
  } finally {
    fs.realpathSync = realpathSync;
    await f.operations.close(); f.store.close();
  }
});

test('recycling preview filters unfinished and already trashed history before resolving physical paths', async () => {
  const f = fixture();
  const registeredProjectScopes = f.store.registeredProjectScopes.bind(f.store);
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const bytes = Buffer.from('captured but not imported');
    const hash = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    for (let index = 0; index < 250; index++) {
      f.store.captureMigrationSource({ identity: 'step-memory:unfinished-project', key: `history/${index}.md`, hash }, bytes);
    }
    f.store.registeredProjectScopes = () => { throw new Error('unfinished_source_path_resolved'); };
    const first = await f.call('prepare_recycling');
    assert.deepEqual(first.files.map(file => file.path), [f.file]);
    f.store.registeredProjectScopes = registeredProjectScopes;
    await f.call('confirm_recycling', { planId: first.planId });
    await f.call('execute_recycling_plan', { planId: first.planId });
    assert.deepEqual(f.store.recyclingCandidateSources(), []);
    const repeated = await f.call('prepare_recycling');
    assert.deepEqual(repeated, { planId: null, files: [] });
  } finally {
    f.store.registeredProjectScopes = registeredProjectScopes;
    await f.operations.close(); f.store.close();
  }
});

test('recycling preview reuses one registered project snapshot for every eligible source path', async () => {
  const f = fixture();
  const registeredProjectScopes = f.store.registeredProjectScopes.bind(f.store);
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const projectRoot = path.join(path.dirname(f.root), 'project');
    fs.mkdirSync(path.join(projectRoot, '.solopreneur'), { recursive: true });
    await f.store.registerProject({ root: projectRoot });
    const identity = `analysis-caches:${f.root}`;
    for (const name of ['issues-cache.json', 'pull-requests-cache.json', 'delivery-cache.json']) {
      const file = path.join(projectRoot, '.solopreneur', name);
      const bytes = Buffer.from(JSON.stringify({ name }));
      const hash = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
      fs.writeFileSync(file, bytes);
      const key = path.relative(f.root, file).split(path.sep).join('/');
      f.store.captureMigrationSource({ identity, key, hash }, bytes);
      f.store.markMigrationSourceImported(identity, key);
    }
    let registryReads = 0;
    f.store.registeredProjectScopes = () => {
      registryReads++;
      return registeredProjectScopes();
    };
    const plan = await f.call('prepare_recycling');
    assert.equal(plan.files.length, 4);
    assert.equal(registryReads, 1, 'one preview must resolve all candidates against one registry snapshot');
  } finally {
    f.store.registeredProjectScopes = registeredProjectScopes;
    await f.operations.close(); f.store.close();
  }
});

test('recycling preview carries ordinary source state and kind in the candidate query', async () => {
  const f = fixture();
  const migrationSourceState = f.store.migrationSourceState.bind(f.store);
  const migrationSourceKind = f.store.migrationSourceKind.bind(f.store);
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    f.store.migrationSourceState = () => { throw new Error('candidate_state_requeried'); };
    f.store.migrationSourceKind = () => { throw new Error('candidate_kind_requeried'); };
    const plan = await f.call('prepare_recycling');
    assert.deepEqual(plan.files.map(file => file.path), [f.file]);
  } finally {
    f.store.migrationSourceState = migrationSourceState;
    f.store.migrationSourceKind = migrationSourceKind;
    await f.operations.close(); f.store.close();
  }
});

test('discarding an unconfirmed recycling plan removes only prepared receipts and leaves sources untouched', async () => {
  const f = fixture();
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    const result = await f.call('discard_recycling_plan', { planId: plan.planId });
    assert.deepEqual(result, { discarded: true, planId: plan.planId, files: 1, bytes: Buffer.byteLength(f.original) });
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
    assert.deepEqual(f.store.recyclingItems(), []);
    await assert.rejects(f.call('read_recycling_plan', { planId: plan.planId }), /recycling_plan_missing/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('the active global memory tree never enters a physical recycling plan', async () => {
  const f = fixture();
  try {
    const crypto = require('node:crypto');
    const memoryRoot = path.join(f.root, 'memory');
    const profile = path.join(memoryRoot, 'active', 'current-session.md');
    const nestedProject = path.join(memoryRoot, 'inbox');
    const retiredProjectFile = path.join(nestedProject, '.solopreneur', 'README.md');
    fs.mkdirSync(path.dirname(profile), { recursive: true });
    fs.mkdirSync(path.dirname(retiredProjectFile), { recursive: true });
    fs.writeFileSync(profile, 'current handoff must remain available');
    fs.writeFileSync(retiredProjectFile, 'nested memory fixture must remain available');
    const capture = (identity, key, file) => {
      const bytes = fs.readFileSync(file), hash = crypto.createHash('sha256').update(bytes).digest('hex');
      f.store.captureMigrationSource({ identity, key, hash }, bytes);
      f.store.markMigrationSourceImported(identity, key);
      return { identity, key, hash, path: file, bytes: bytes.length };
    };
    const profileSource = capture(`memory:${memoryRoot}`, 'active/current-session.md', profile);
    capture(`project-legacy-files:${nestedProject}`, 'README.md', retiredProjectFile);
    assert.deepEqual(await f.call('prepare_recycling'), { planId: null, files: [] });
    const oldPlan = f.store.createRecyclingPlan([profileSource]);
    f.store.approveRecyclingFiles(oldPlan.files.map(file => ({ itemId: file.itemId, expectedPath: file.path, path: file.path })));
    await assert.rejects(f.call('execute_recycling_plan', { planId: oldPlan.planId }), /recycling_items_retained/);
    assert.equal(fs.readFileSync(profile, 'utf8'), 'current handoff must remain available');
    assert.equal(fs.readFileSync(retiredProjectFile, 'utf8'), 'nested memory fixture must remain available');
  } finally { await f.operations.close(); f.store.close(); }
});

test('every roadmap.csv remains protected from new and previously prepared recycling plans', async () => {
  const f = fixture();
  try {
    const projectRoot = path.join(path.dirname(f.root), 'project-with-roadmap');
    const roadmap = path.join(projectRoot, '.solopreneur', 'path-recovery-20260728T074000Z', 'ROADMAP.CSV');
    fs.mkdirSync(path.dirname(roadmap), { recursive: true });
    const bytes = Buffer.from('id,title\n1,Keep every roadmap\n');
    fs.writeFileSync(roadmap, bytes);
    await f.store.registerProject({ root: projectRoot });
    const identity = `project-legacy-files:${projectRoot}`;
    const key = 'path-recovery-20260728T074000Z/ROADMAP.CSV';
    const hash = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    f.store.captureMigrationSource({ identity, key, hash }, bytes);
    f.store.markMigrationSourceImported(identity, key);
    assert.deepEqual(await f.call('prepare_recycling', { projectRoot }), { planId: null, files: [] });
    const oldPlan = f.store.createRecyclingPlan([{ identity, key, hash, path: roadmap, bytes: bytes.length }]);
    f.store.approveRecyclingFiles(oldPlan.files.map(file => ({ itemId: file.itemId, expectedPath: file.path, path: file.path })));
    await assert.rejects(f.call('execute_recycling_plan', { projectRoot, planId: oldPlan.planId }), /recycling_items_retained/);
    assert.deepEqual(fs.readFileSync(roadmap), bytes);
  } finally { await f.operations.close(); f.store.close(); }
});

test('an archived legacy status owned by a live process cannot enter a recycling plan', async () => {
  const f = fixture();
  try {
    const crypto = require('node:crypto');
    const projectRoot = path.join(path.dirname(f.root), 'project-with-live-legacy-status');
    const statusFile = path.join(projectRoot, '.solopreneur', 'agent-status', '8.json');
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    const bytes = Buffer.from(JSON.stringify({ agentPid: process.pid, processBirth: readProcessBirthMarker(process.pid) }));
    fs.writeFileSync(statusFile, bytes);
    const project = await f.store.registerProject({ root: projectRoot });
    const identity = `project-legacy-files:${projectRoot}`;
    const key = 'agent-status/8.json';
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    f.store.captureMigrationSource({ identity, key, hash }, bytes);
    f.store.archiveMigrationSource({ identity, key, hash }, bytes, { reason: 'retired SoloMap project file', projectId: project.projectId });
    assert.deepEqual(await f.call('prepare_recycling', { projectRoot }), { planId: null, files: [] });
    assert.deepEqual(fs.readFileSync(statusFile), bytes);
  } finally { await f.operations.close(); f.store.close(); }
});

test('the physical target of a symlinked global memory tree never enters a recycling plan through a project alias', async () => {
  const f = fixture();
  try {
    const crypto = require('node:crypto');
    const physicalMemory = path.join(path.dirname(f.root), 'physical-memory');
    const nestedProject = path.join(physicalMemory, 'inbox');
    const retiredProjectFile = path.join(nestedProject, '.solopreneur', 'README.md');
    fs.mkdirSync(path.dirname(retiredProjectFile), { recursive: true });
    fs.writeFileSync(retiredProjectFile, 'physical memory target must remain available');
    fs.symlinkSync(physicalMemory, path.join(f.root, 'memory'), 'dir');
    const bytes = fs.readFileSync(retiredProjectFile), hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const identity = `project-legacy-files:${nestedProject}`;
    f.store.captureMigrationSource({ identity, key: 'README.md', hash }, bytes);
    f.store.markMigrationSourceImported(identity, 'README.md');
    assert.deepEqual(await f.call('prepare_recycling'), { planId: null, files: [] });
    const oldPlan = f.store.createRecyclingPlan([{ identity, key: 'README.md', hash, path: retiredProjectFile, bytes: bytes.length }]);
    f.store.approveRecyclingFiles(oldPlan.files.map(file => ({ itemId: file.itemId, expectedPath: file.path, path: file.path })));
    await assert.rejects(f.call('execute_recycling_plan', { planId: oldPlan.planId }), /recycling_items_retained/);
    assert.equal(fs.readFileSync(retiredProjectFile, 'utf8'), 'physical memory target must remain available');
  } finally { await f.operations.close(); f.store.close(); }
});

test('discarding a confirmed recycling plan is rejected atomically', async () => {
  const f = fixture();
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    await f.call('confirm_recycling', { planId: plan.planId });
    await assert.rejects(f.call('discard_recycling_plan', { planId: plan.planId }), /recycling_plan_not_discardable/);
    assert.equal(f.store.recyclingItems().length, 1);
    assert.equal(f.store.recyclingItems()[0].status, 'approved');
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  } finally { await f.operations.close(); f.store.close(); }
});

test('migration overview stays small with populated history while job detail retains every source and conflict after restart', async () => {
  const f = fixture();
  const retainedFiles = Array.from({ length: 25000 }, (_, index) => `project/.solopreneur/agent-runs/step/${index}/output.log`);
  const conflicts = Array.from({ length: 300 }, (_, index) => ({ source: `projects/${index}.md`, error: 'project_scope_mapping_required' }));
  const progress = { imported: 24500, unchanged: 200, originalBytes: 987654321, retainedFiles, conflicts, interrupted: false };
  const job = f.store.enqueueMemoryMigration({ sourceRoot: path.join(f.root, 'memory') }, 'large-history');
  f.store.updateMigrationJob(job.jobId, 'completed_with_conflicts', progress);
  let restarted;
  try {
    const overview = await f.call('migration_overview');
    assert.ok(Buffer.byteLength(JSON.stringify(overview)) < 50000, 'routine status must not transport every retained path');
    assert.equal(overview.jobs[0].progress.retainedFileCount, 25000);
    assert.equal(overview.jobs[0].progress.conflictCount, 300);
    assert.equal(overview.jobs[0].progress.imported, 24500);
    assert.equal(overview.jobs[0].progress.originalBytes, 987654321);
    assert.equal(overview.jobs[0].progress.retainedFiles, undefined);
    assert.deepEqual(overview.jobs[0].progress.conflicts, conflicts, 'actionable conflicts remain visible in settings');
    assert.deepEqual((await f.call('migration_status', { jobId: job.jobId })).progress, progress);
    await f.operations.close(); f.store.close();
    restarted = UnifiedDataStore.open(f.root);
    assert.deepEqual(restarted.readMigrationJob(job.jobId).progress, progress);
  } finally {
    if (restarted) restarted.close();
    else { await f.operations.close(); f.store.close(); }
  }
});

test('migration overview shows only the newest job for each exact collection and source', async () => {
  const f = fixture();
  try {
    const sourceRoot = path.join(f.root, 'memory');
    const old = f.store.enqueueMemoryMigration({ sourceRoot }, 'older');
    f.store.updateMigrationJob(old.jobId, 'failed', { conflicts: [{ source: 'old.md', error: 'old failure' }] }, 'old failure');
    const latest = f.store.enqueueMemoryMigration({ sourceRoot, projectScopes: { first: 'mapped' } }, 'latest');
    f.store.updateMigrationJob(latest.jobId, 'completed', { imported: 10, retainedFiles: ['a.md', 'b.md'], conflicts: [] });
    const other = f.store.enqueueMemoryMigration({ sourceRoot, collection: 'intelligence' }, 'different-collection');
    const overview = await f.call('migration_overview');
    assert.deepEqual(overview.jobs.map(job => job.jobId), [latest.jobId, other.jobId]);
    assert.equal(overview.jobs[0].progress.conflictCount, 0);
    assert.equal(overview.jobs[0].progress.retainedFileCount, 2);
    assert.equal(overview.jobs[1].progress.conflictCount, 0);
    assert.equal(f.store.readMigrationJob(old.jobId).error, 'old failure');
  } finally { await f.operations.close(); f.store.close(); }
});

test('enqueueing a new migration does not decode unrelated completed history', async () => {
  const f = fixture();
  try {
    const old = f.store.enqueueMemoryMigration({ sourceRoot: path.join(f.root, 'old-memory') }, 'old-completed');
    f.store.updateMigrationJob(old.jobId, 'completed', {});
    f.store.db.run('UPDATE migration_jobs SET progress_json=? WHERE id=?', ['invalid historical progress', old.jobId]);
    const sourceRoot = path.join(f.root, 'new-memory');
    fs.mkdirSync(sourceRoot);
    const queued = await f.call('import_memory', { sourceRoot, idempotencyKey: 'new-source' });
    assert.equal(queued.scheduled, true);
    await f.operations.waitForMigrations();
    assert.equal(f.store.readMigrationJob(queued.jobId).status, 'completed');
  } finally { await f.operations.close(); f.store.close(); }
});

test('refresh discovery preserves a completed conflict until an explicit retry or a new migration identity', async () => {
  const f = fixture();
  try {
    const sourceRoot = path.join(f.root, 'memory');
    fs.mkdirSync(sourceRoot, { recursive: true });
    const job = f.store.enqueueMemoryMigration({ sourceRoot }, 'conflict-needs-a-decision');
    const progress = { imported: 2, conflicts: [{ source: 'profile.md', error: 'deterministic_conflict' }] };
    f.store.updateMigrationJob(job.jobId, 'completed_with_conflicts', progress);

    const discovered = await f.call('import_memory', { sourceRoot, idempotencyKey: 'conflict-needs-a-decision', refreshCompleted: true });

    assert.equal(discovered.scheduled, false);
    assert.equal(f.store.readMigrationJob(job.jobId).status, 'completed_with_conflicts');
    assert.deepEqual(f.store.readMigrationJob(job.jobId).progress, progress);
  } finally { await f.operations.close(); f.store.close(); }
});

test('legacy empty collection values share the default memory source status', async () => {
  const f = fixture();
  try {
    const sourceRoot = path.join(f.root, 'memory');
    f.store.enqueueMemoryMigration({ sourceRoot }, 'implicit-memory');
    const latest = f.store.enqueueMemoryMigration({ sourceRoot, collection: '' }, 'empty-memory');
    f.store.updateMigrationJob(latest.jobId, 'completed', { imported: 2 });
    const overview = await f.call('migration_overview');
    assert.deepEqual(overview.jobs.map(job => job.jobId), [latest.jobId]);
  } finally { await f.operations.close(); f.store.close(); }
});

test('jobs created in the same millisecond use commit order rather than UUID sorting for latest status', async () => {
  const f = fixture();
  try {
    const args = { sourceRoot: path.join(f.root, 'memory') };
    const old = f.store.enqueueMemoryMigration(args, 'old-in-same-millisecond');
    f.store.updateMigrationJob(old.jobId, 'failed', {}, 'old failure');
    const latest = f.store.enqueueMemoryMigration(args, 'new-in-same-millisecond');
    f.store.updateMigrationJob(latest.jobId, 'completed', {});
    f.store.db.run('UPDATE migration_jobs SET created_at=?,id=? WHERE id=?', [42, 'old-z', old.jobId]);
    f.store.db.run('UPDATE migration_jobs SET created_at=?,id=? WHERE id=?', [42, 'new-a', latest.jobId]);
    const overview = await f.call('migration_overview');
    assert.equal(overview.jobs.length, 1);
    assert.equal(overview.jobs[0].jobId, 'new-a');
    assert.equal(overview.jobs[0].status, 'completed');
  } finally { await f.operations.close(); f.store.close(); }
});

test('migration overview aggregates source counts without materializing every captured file', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/migrationRecycling.ts'), 'utf8');
  const body = source.slice(source.indexOf('public async overview('), source.indexOf('public async prepare('));
  assert.doesNotMatch(body, /capturedMigrationSources/);
  assert.match(body, /migrationSourceOverview/);
});

test('confirmation cannot recycle changed, mismatched, symlinked, or still used memory sources', async () => {
  const f = fixture();
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    await f.call('confirm_recycling', { planId: plan.planId });
    fs.writeFileSync(f.file, f.original + '\n');
    await assert.rejects(f.call('hold_recycling_file', { itemId: plan.files[0].itemId }), /recycling_source_changed/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original + '\n');
    const changed = await f.call('migration_overview');
    assert.equal(changed.recyclableFiles, 0);
    assert.equal(changed.reviewableFiles, 0);
    fs.renameSync(f.file, f.file + '.retained');
    fs.symlinkSync(f.file + '.retained', f.file);
    assert.equal((await f.call('migration_overview')).recyclableFiles, 0);
    const memory = Buffer.from('Still used by a legacy reader');
    f.store.captureMigrationSource({ identity: path.join(f.root, 'memory'), key: 'profile.md', hash: require('node:crypto').createHash('sha256').update(memory).digest('hex') }, memory);
    assert.equal((await f.call('migration_overview')).recyclableFiles, 0);
    const session = await f.call('register_project', { root: path.dirname(f.root) });
    const identity = await f.call('open_mcp_session', { projectId: session.projectId });
    await assert.rejects(f.operations({ operation: 'prepare_recycling', input: {}, sessionToken: identity.sessionToken }), /action_denied/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('held files and interrupted recycling survive owner restart, without creating another plan or losing bytes', async () => {
  const f = fixture();
  let next;
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    await f.call('confirm_recycling', { planId: plan.planId });
    const held = await f.call('hold_recycling_file', { itemId: plan.files[0].itemId });
    await f.operations.close(); f.store.close();
    next = UnifiedDataStore.open(f.root);
    const ops = createRuntimeDataOperations(next);
    try {
      const status = await ops({ operation: 'migration_overview', input: {} });
      assert.equal(status.heldFiles, 1);
      assert.equal(status.recycling[0].itemId, plan.files[0].itemId);
      const retry = await ops({ operation: 'hold_recycling_file', input: { itemId: plan.files[0].itemId } });
      assert.equal(retry.path, held.path);
      await ops({ operation: 'restore_recycling_file', input: { itemId: plan.files[0].itemId } });
      assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
      assert.equal(fs.existsSync(held.path), false, 'restoration leaves no held duplicate');
    } finally { await ops.close(); }
  } finally { if (next) next.close(); else { await f.operations.close(); f.store.close(); } }
});

test('a crash after native trash but before its acknowledgement can settle without trying to trash a missing file', async () => {
  const f = fixture();
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    await f.call('confirm_recycling', { planId: plan.planId });
    const held = await f.call('hold_recycling_file', { itemId: plan.files[0].itemId });
    fs.renameSync(held.path, path.join(f.root, 'fixture-crash-trash.json'));
    const recovered = await f.call('hold_recycling_file', { itemId: plan.files[0].itemId });
    assert.equal(recovered.recycled, true);
    assert.equal((await f.call('migration_overview')).recycledFiles, 1);
    await f.call('restore_recycling_file', { itemId: plan.files[0].itemId });
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  } finally { await f.operations.close(); f.store.close(); }
});

test('the approved recoverable database recycling path works when system trash is unavailable', async () => {
  const f = fixture();
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    await f.call('confirm_recycling', { planId: plan.planId });
    const held = await f.call('hold_recycling_file', { itemId: plan.files[0].itemId });
    await f.call('retire_recycling_file', { itemId: plan.files[0].itemId });
    assert.equal(fs.existsSync(held.path), false);
    await f.call('restore_recycling_file', { itemId: plan.files[0].itemId });
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  } finally { await f.operations.close(); f.store.close(); }
});

test('plan execution batches durable status changes while preserving per-file verification and restoration', async () => {
  const f = fixture();
  try {
    const files = [f.file];
    for (const suffix of ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']) {
      const file = path.join(path.dirname(f.file), suffix + '.json');
      fs.writeFileSync(file, JSON.stringify({ id: suffix, title: 'Old chat', createdAt: '2026-09-22T08:00:00.000Z', updatedAt: '2026-09-22T08:01:00.000Z', messages: [{ role: 'user', content: suffix }] }));
      files.push(file);
    }
    for (const file of files) await importLegacyIntelligenceConversation(f.store, file);
    const plan = await f.call('prepare_recycling');
    assert.equal(plan.files.length, 3);
    await f.call('confirm_recycling', { planId: plan.planId });
    const individual = f.store.setRecyclingStatus.bind(f.store);
    const allItems = f.store.recyclingItems.bind(f.store);
    let fullScans = 0;
    f.store.recyclingItems = () => {
      fullScans++;
      if (fullScans > 2) throw new Error('recycling_full_table_rescan');
      return allItems();
    };
    f.store.setRecyclingStatus = () => { throw new Error('individual_status_write_used'); };
    await f.call('execute_recycling_plan', { planId: plan.planId });
    f.store.setRecyclingStatus = individual;
    f.store.recyclingItems = allItems;
    assert.equal(fullScans, 2, 'execution scans the plan once and the final overview once');
    assert.equal(files.every(file => !fs.existsSync(file)), true);
    assert.deepEqual(f.store.recyclingItems().map(item => item.status), ['trashed', 'trashed', 'trashed']);
    await f.call('restore_recycling_file', { itemId: plan.files[1].itemId });
    assert.equal(fs.existsSync(plan.files[1].path), true);
  } finally { await f.operations.close(); f.store.close(); }
});

test('a dependency recycled by the same approved plan cannot invalidate a remaining migrated source', async () => {
  const f = fixture();
  try {
    const identity = `agent-runs:${f.root}`;
    const retiredPath = path.join(f.root, '.solopreneur', 'agent-runs', 'old', 'prompt.txt');
    const remainingPath = path.join(f.root, '.solopreneur', 'agent-status', '1.json');
    const sources = [
      { identity, key: 'old/prompt.txt', path: retiredPath, bytes: Buffer.from('old prompt') },
      { identity: `agent-status:${f.root}`, key: '1.json', path: remainingPath, bytes: Buffer.from('{"executionLogId":1}') }
    ].map(source => ({ ...source, hash: require('node:crypto').createHash('sha256').update(source.bytes).digest('hex') }));
    for (const source of sources) {
      fs.mkdirSync(path.dirname(source.path), { recursive: true });
      fs.writeFileSync(source.path, source.bytes);
      f.store.captureMigrationSource(source, source.bytes, { mimeType: 'application/octet-stream', encoding: 'binary' });
      f.store.markMigrationSourceImported(source.identity, source.key);
    }
    const plan = f.store.createRecyclingPlan(sources.map(source => ({ identity: source.identity, key: source.key, hash: source.hash, path: source.path, bytes: source.bytes.length })));
    f.store.approveRecyclingFiles(plan.files.map(file => ({ itemId: file.itemId, expectedPath: file.path, path: file.path })));
    f.store.setRecyclingStatus(plan.files.find(file => file.path === retiredPath).itemId, 'trashed');
    fs.unlinkSync(retiredPath);

    f.store.markMigrationSourceConflict(sources[1].identity, sources[1].key, `ENOENT: no such file or directory, lstat '${retiredPath}'`);
    assert.equal(f.store.migrationSourceState(sources[1].identity, sources[1].key).stage, 'imported');

    f.store.db.run("UPDATE migration_items SET stage='conflict',error=? WHERE source_identity=? AND source_key=?", [`ENOENT: no such file or directory, lstat '${retiredPath}'`, sources[1].identity, sources[1].key]);
    await f.call('execute_recycling_plan', { planId: plan.planId });
    assert.equal(fs.existsSync(remainingPath), false);
    assert.deepEqual(f.store.recyclingItems().map(file => file.status), ['trashed', 'trashed']);

    f.store.markMigrationSourceConflict(sources[1].identity, sources[1].key, `ENOENT: no such file or directory, lstat '${retiredPath}.unplanned'`);
    assert.equal(f.store.migrationSourceState(sources[1].identity, sources[1].key).stage, 'conflict');
  } finally { f.store.close(); }
});

test('batch execution rejects a source replaced after moving is durable and never retires the foreign file', async () => {
  const f = fixture();
  const foreign = path.join(f.root, 'foreign.json');
  const retained = f.file + '.retained';
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    await f.call('confirm_recycling', { planId: plan.planId });
    fs.writeFileSync(foreign, f.original);
    const batch = f.store.setRecyclingStatuses.bind(f.store);
    let replaced = false;
    f.store.setRecyclingStatuses = updates => {
      batch(updates);
      if (!replaced && updates.some(update => update.status === 'moving')) {
        replaced = true;
        fs.renameSync(f.file, retained);
        fs.symlinkSync(foreign, f.file);
      }
    };
    await assert.rejects(f.call('execute_recycling_plan', { planId: plan.planId }), /recycling_items_retained/);
    assert.equal(fs.readFileSync(retained, 'utf8'), f.original);
    assert.equal(fs.readFileSync(foreign, 'utf8'), f.original);
    assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true);
    assert.equal(f.store.recyclingItems()[0].status, 'changed');
  } finally { await f.operations.close(); f.store.close(); }
});

test('batch execution revalidates a held file moved back to its original path before reporting physical reclamation', async () => {
  const f = fixture();
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    await f.call('confirm_recycling', { planId: plan.planId });
    const held = await f.call('hold_recycling_file', { itemId: plan.files[0].itemId });
    fs.renameSync(held.path, f.file);
    await f.call('execute_recycling_plan', { planId: plan.planId });
    assert.equal(fs.existsSync(f.file), false);
    assert.equal(f.store.recyclingItems()[0].status, 'trashed');
    await f.call('restore_recycling_file', { itemId: plan.files[0].itemId });
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  } finally { await f.operations.close(); f.store.close(); }
});

test('batch execution does not use an obsolete missing observation when a held source reappears', async () => {
  const f = fixture();
  const lstat = fs.promises.lstat;
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    await f.call('confirm_recycling', { planId: plan.planId });
    const held = await f.call('hold_recycling_file', { itemId: plan.files[0].itemId });
    const retained = held.path + '.fixture';
    fs.renameSync(held.path, retained);
    let reappeared = false;
    fs.promises.lstat = async file => {
      try { return await lstat(file); }
      catch (error) {
        if (!reappeared && file === f.file && error.code === 'ENOENT') {
          reappeared = true;
          fs.renameSync(retained, f.file);
        }
        throw error;
      }
    };
    await f.call('execute_recycling_plan', { planId: plan.planId });
    fs.promises.lstat = lstat;
    assert.equal(reappeared, true);
    assert.equal(fs.existsSync(f.file), false);
    assert.equal(f.store.recyclingItems()[0].status, 'trashed');
  } finally { fs.promises.lstat = lstat; await f.operations.close(); f.store.close(); }
});

test('restore recreates an absent original directory after recycling and owner restart', async () => {
  const f = fixture(); let reopened;
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling'); const itemId = plan.files[0].itemId;
    await f.call('confirm_recycling', { planId: plan.planId });
    await f.call('execute_recycling_plan', { planId: plan.planId });
    fs.rmdirSync(path.dirname(f.file));
    await f.operations.close(); f.store.close(); reopened = UnifiedDataStore.open(f.root);
    const ops = createRuntimeDataOperations(reopened);
    try {
      await ops({ operation: 'restore_recycling_file', input: { itemId } });
      assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
      assert.equal(reopened.recyclingItems()[0].status, 'restored');
    } finally { await ops.close(); }
  } finally { if (reopened) reopened.close(); else { await f.operations.close(); f.store.close(); } }
});

test('interrupted restore publishes atomically and resumes its own target after owner restart', async () => {
  const f = fixture();
  let reopened;
  const link = fs.promises.link;
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    const itemId = plan.files[0].itemId;
    await f.call('confirm_recycling', { planId: plan.planId });
    await f.call('hold_recycling_file', { itemId });
    fs.promises.link = async (...args) => { await link(...args); throw new Error('fixture_exit_after_publish'); };
    await assert.rejects(f.call('restore_recycling_file', { itemId }), /fixture_exit_after_publish/);
    fs.promises.link = link;
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
    await f.operations.close(); f.store.close();
    reopened = UnifiedDataStore.open(f.root);
    const ops = createRuntimeDataOperations(reopened);
    try {
      await ops({ operation: 'restore_recycling_file', input: { itemId } });
      assert.equal(reopened.recyclingItems()[0].status, 'restored');
      assert.equal(fs.existsSync(path.join(f.root, '.migration-recycle', itemId + '.json')), false);
      assert.equal(fs.existsSync(path.join(f.root, '.migration-recycle', itemId + '.restore')), false);
      assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
    } finally { await ops.close(); }
  } finally { fs.promises.link = link; if (reopened) reopened.close(); else { await f.operations.close(); f.store.close(); } }
});

test('an unrelated identical target is never mistaken for an interrupted restore', async () => {
  const f = fixture();
  const link = fs.promises.link;
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    const itemId = plan.files[0].itemId;
    await f.call('confirm_recycling', { planId: plan.planId });
    await f.call('hold_recycling_file', { itemId });
    fs.promises.link = async () => { throw new Error('fixture_exit_before_publish'); };
    await assert.rejects(f.call('restore_recycling_file', { itemId }), /fixture_exit_before_publish/);
    fs.promises.link = link;
    fs.writeFileSync(f.file, f.original);
    const inode = fs.statSync(f.file).ino;
    await assert.rejects(f.call('restore_recycling_file', { itemId }), /restore_target_exists/);
    assert.equal(fs.statSync(f.file).ino, inode);
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  } finally { fs.promises.link = link; await f.operations.close(); f.store.close(); }
});

test('a partial private restore write is recoverable without publishing partial bytes', async () => {
  const f = fixture();
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    const itemId = plan.files[0].itemId;
    await f.call('confirm_recycling', { planId: plan.planId });
    await f.call('hold_recycling_file', { itemId });
    fs.writeFileSync(path.join(f.root, '.migration-recycle', itemId + '.restore.writing'), f.original.slice(0, 17));
    assert.equal(fs.existsSync(f.file), false);
    await f.call('restore_recycling_file', { itemId });
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
    assert.equal(fs.existsSync(path.join(f.root, '.migration-recycle', itemId + '.restore.writing')), false);
  } finally { await f.operations.close(); f.store.close(); }
});

test('a durable restored receipt can finish cleanup after interruption', async () => {
  const f = fixture();
  const unlink = fs.promises.unlink;
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    const itemId = plan.files[0].itemId;
    await f.call('confirm_recycling', { planId: plan.planId });
    await f.call('hold_recycling_file', { itemId });
    const receipt = path.join(f.root, '.migration-recycle', itemId + '.restore');
    fs.promises.unlink = async file => { if (file === receipt) throw new Error('fixture_exit_after_settle'); return unlink(file); };
    await assert.rejects(f.call('restore_recycling_file', { itemId }), /fixture_exit_after_settle/);
    fs.promises.unlink = unlink;
    assert.equal(f.store.recyclingItems()[0].status, 'restored');
    await f.call('restore_recycling_file', { itemId });
    assert.equal(fs.existsSync(receipt), false);
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  } finally { fs.promises.unlink = unlink; await f.operations.close(); f.store.close(); }
});

test('restoration interrupted before durable completion resumes after reopening the owner', async () => {
  const f = fixture();
  let reopened;
  const settle = f.store.setRecyclingStatus.bind(f.store);
  try {
    await importLegacyIntelligenceConversation(f.store, f.file);
    const plan = await f.call('prepare_recycling');
    const itemId = plan.files[0].itemId;
    await f.call('confirm_recycling', { planId: plan.planId });
    await f.call('hold_recycling_file', { itemId });
    f.store.setRecyclingStatus = (id, status, error) => {
      if (status === 'restored') throw new Error('fixture_exit_before_durable_completion');
      return settle(id, status, error);
    };
    await assert.rejects(f.call('restore_recycling_file', { itemId }), /fixture_exit_before_durable_completion/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
    await f.operations.close(); f.store.close();
    reopened = UnifiedDataStore.open(f.root);
    const ops = createRuntimeDataOperations(reopened);
    try {
      await ops({ operation: 'restore_recycling_file', input: { itemId } });
      assert.equal(reopened.recyclingItems()[0].status, 'restored');
      assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
    } finally { await ops.close(); }
  } finally { if (reopened) reopened.close(); else { await f.operations.close(); f.store.close(); } }
});
