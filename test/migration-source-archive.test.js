const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { importAnalysisCaches } = require('../out/analysisDatabaseMigration.js');
const { importMemoryDirectory, isArchivableMigrationConflict } = require('../out/memoryDatabaseMigration.js');
const { importLearningDirectory, importLearningReviewDirectory } = require('../out/learningDatabaseMigration.js');
const { importAgentRuns, importStepMemoryDirectory, importRunDigestDirectory } = require('../out/projectDataMigration.js');

const evidenceBytes = evidence => typeof evidence.data.content === 'string'
  ? Buffer.from(evidence.data.content)
  : Buffer.from(evidence.data.content.data, 'base64');

test('an unresolved legacy source is preserved through the normal evidence reader before it becomes recyclable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-source-archive-'));
  const store = new UnifiedDataStore(root);
  try {
    const bytes = Buffer.from('完整但不能安全归一化的旧数据🌿');
    const source = { identity: 'agent-status:/project', key: '71.json', hash: crypto.createHash('sha256').update(bytes).digest('hex') };
    store.captureMigrationSource(source, bytes, { mimeType: 'application/json', encoding: 'utf8', error: 'legacy_status_invalid' });

    const readMigrationSource = store.readMigrationSource.bind(store);
    store.readMigrationSource = () => { throw new Error('archive_must_bind_captured_content_without_materializing_it'); };
    const archived = store.archiveMigrationSource(source, bytes, {
      reason: 'legacy_status_invalid',
      mimeType: 'application/json',
      observedAt: 123
    });
    store.readMigrationSource = readMigrationSource;

    assert.equal(store.readMigrationSource(source.identity, source.key).stage, 'imported');
    const evidence = store.read(archived.objectId, archived.revision);
    assert.equal(evidence.kind, 'evidence');
    assert.equal(evidence.data.type, `legacy_migration_source:${source.identity}/${source.key}#legacy_status_invalid`);
    assert.equal(evidence.data.observed_at, 123);
    assert.deepEqual(evidenceBytes(evidence), bytes);
    assert.equal(archived.unchanged, false);
    assert.equal(store.archiveMigrationSource(source, bytes, { reason: 'legacy_status_invalid', mimeType: 'application/json', observedAt: 999 }).unchanged, true);
    const changedReason = store.archiveMigrationSource(source, bytes, { reason: 'historical_run_input_invalid', mimeType: 'application/json', observedAt: 999 });
    assert.equal(changedReason.unchanged, false);
    assert.equal(store.read(changedReason.objectId).data.type, `legacy_migration_source:${source.identity}/${source.key}#historical_run_input_invalid`);
  } finally { store.close(); }
});

test('unsupported step memory and run digests become exact evidence instead of permanent conflicts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-terminal-project-sources-'));
  const dataRoot = path.join(root, '.solomap-global'), project = path.join(root, 'project');
  const stepRoot = path.join(project, '.solopreneur', 'step-memory'), digestRoot = path.join(project, '.solopreneur', 'run-digests');
  fs.mkdirSync(stepRoot, { recursive: true }); fs.mkdirSync(digestRoot, { recursive: true });
  const stepFile = path.join(stepRoot, 'legacy.bin'), digestFile = path.join(digestRoot, 'legacy.txt');
  const stepBytes = Buffer.from([0, 1, 2, 255]), digestBytes = Buffer.from('retired digest format');
  fs.writeFileSync(stepFile, stepBytes); fs.writeFileSync(digestFile, digestBytes);
  const store = new UnifiedDataStore(dataRoot);
  try {
    const step = await importStepMemoryDirectory(store, stepRoot, { projectRoot: project, archiveUnresolved: true });
    const digest = await importRunDigestDirectory(store, digestRoot, { projectRoot: project, archiveUnresolved: true });
    assert.deepEqual(step.conflicts, []); assert.deepEqual(digest.conflicts, []);
    const stepEvidence = store.read(step.archivedSources[0].evidenceRef.split('/').at(-1));
    const digestEvidence = store.read(digest.archivedSources[0].evidenceRef.split('/').at(-1));
    assert.deepEqual(evidenceBytes(stepEvidence), stepBytes);
    assert.deepEqual(evidenceBytes(digestEvidence), digestBytes);
    const files = (await new (require('../out/migrationRecycling.js').MigrationRecycling)(store).prepare()).files.map(item => item.path);
    assert.ok(files.includes(stepFile)); assert.ok(files.includes(digestFile));
  } finally { store.close(); }
});

test('an unexpected database failure stays conflicted and cannot be converted into recyclable evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-source-operational-error-'));
  const dataRoot = path.join(root, '.solomap-global'), memoryRoot = path.join(root, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true }); fs.writeFileSync(path.join(memoryRoot, 'profile.md'), '# profile');
  const store = new UnifiedDataStore(dataRoot);
  const importObject = store.importObject.bind(store);
  store.importObject = () => { throw new Error('database_write_failed'); };
  try {
    const result = await importMemoryDirectory(store, memoryRoot, { archiveUnresolved: true });
    assert.deepEqual(result.conflicts, [{ source: 'profile.md', error: 'database_write_failed' }]);
    assert.deepEqual(result.archivedSources || [], []);
    assert.notEqual(store.readMigrationSource(`memory:${memoryRoot}`, 'profile.md').stage, 'imported');
  } finally { store.importObject = importObject; store.close(); }
});

test('temporary and unknown historical errors never become terminal archive decisions', () => {
  for (const error of ['historical_run_source_changed', 'historical_run_owner_alive', 'legacy_review_owner_alive', 'historical_future_error', 'SyntaxError: Unexpected end of JSON input']) {
    assert.equal(isArchivableMigrationConflict(error), false, error);
  }
  assert.equal(isArchivableMigrationConflict('historical_run_identity_ambiguous'), true);
  assert.equal(isArchivableMigrationConflict('historical_run_identity_invalid'), true);
  assert.equal(isArchivableMigrationConflict('execution_identity_conflict'), true);
});

test('a current database parse failure cannot be mistaken for malformed legacy analysis evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-analysis-database-parse-'));
  const dataRoot = path.join(root, '.solomap-global'), projectRoot = path.join(root, 'project');
  const metadata = path.join(projectRoot, '.solopreneur'); fs.mkdirSync(metadata, { recursive: true });
  const sourceFile = path.join(metadata, 'issues-cache.json'); fs.writeFileSync(sourceFile, '{"issues":[]}');
  const store = new UnifiedDataStore(dataRoot); const project = await store.registerProject({ root: projectRoot });
  const original = store.importAnalysisState.bind(store);
  store.importAnalysisState = () => { throw new SyntaxError('Unexpected end of JSON input'); };
  try {
    const result = await importAnalysisCaches(store, dataRoot, { projectScopes: { [projectRoot]: project.projectId }, archiveUnresolved: true });
    assert.equal(result.archivedSources?.length || 0, 0);
    assert.ok(result.conflicts.some(item => item.source === sourceFile && item.error.startsWith('SyntaxError:')));
    const key = path.relative(dataRoot, sourceFile).split(path.sep).join('/');
    assert.equal(store.readMigrationSource(`analysis-caches:${dataRoot}`, key).stage, 'conflict');
  } finally { store.importAnalysisState = original; store.close(); }
});

test('malformed legacy analysis JSON is archived with its explicit source error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-analysis-source-parse-'));
  const dataRoot = path.join(root, '.solomap-global'), projectRoot = path.join(root, 'project');
  const metadata = path.join(projectRoot, '.solopreneur'); fs.mkdirSync(metadata, { recursive: true });
  const sourceFile = path.join(metadata, 'issues-cache.json'), bytes = Buffer.from('{'); fs.writeFileSync(sourceFile, bytes);
  const store = new UnifiedDataStore(dataRoot); const project = await store.registerProject({ root: projectRoot });
  try {
    const result = await importAnalysisCaches(store, dataRoot, { projectScopes: { [projectRoot]: project.projectId }, archiveUnresolved: true });
    assert.deepEqual(result.conflicts, []); assert.equal(result.archivedSources.length, 1);
    assert.equal(result.archivedSources[0].error, 'Error: analysis_cache_source_invalid');
    assert.deepEqual(evidenceBytes(store.read(result.archivedSources[0].evidenceRef.split('/').at(-1))), bytes);
  } finally { store.close(); }
});

test('a previously retired agent-runs directory is a completed no-op on replay', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-missing-agent-runs-'));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(path.join(root, '.solomap-global'));
  try {
    const result = await importAgentRuns(store, path.join(project, '.solopreneur', 'agent-runs'), { projectRoot: project, archiveUnresolved: true });
    assert.deepEqual(result.conflicts, []); assert.equal(result.imported, 0); assert.equal(result.unchanged, 0);
  } finally { store.close(); }
});

test('a multi-file run conflict stays visible when any source evidence cannot be archived', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-partial-run-archive-'));
  const dataRoot = path.join(root, '.solomap-global'), project = path.join(root, 'project');
  const sourceRoot = path.join(project, '.solopreneur', 'agent-runs'), runRoot = path.join(sourceRoot, 'orphan');
  fs.mkdirSync(runRoot, { recursive: true });
  fs.writeFileSync(path.join(runRoot, 'prompt.txt'), 'prompt'); fs.writeFileSync(path.join(runRoot, 'output.log'), 'output');
  fs.writeFileSync(path.join(runRoot, 'completion.json'), '{}');
  const store = new UnifiedDataStore(dataRoot); await store.registerProject({ root: project });
  const archive = store.archiveMigrationSource.bind(store); let calls = 0;
  const importHistoricalRunIndex = store.importHistoricalRunIndex.bind(store);
  store.importHistoricalRunIndex = () => { throw new Error('historical_run_index_owner_unknown'); };
  store.archiveMigrationSource = (...args) => { if (++calls === 2) throw new Error('database_write_failed'); return archive(...args); };
  try {
    const result = await importAgentRuns(store, sourceRoot, { projectRoot: project, archiveUnresolved: true });
    assert.ok(result.conflicts.some(item => item.error.includes('historical_run_index_owner_unknown')));
    assert.ok(['prompt.txt', 'output.log', 'completion.json'].some(key => store.readMigrationSource(`agent-runs:${project}`, `orphan/${key}`).stage !== 'imported'));
  } finally { store.importHistoricalRunIndex = importHistoricalRunIndex; store.archiveMigrationSource = archive; store.close(); }
});

test('legacy project scopes resolve across case and relocation while truly unknown memory is archived outside global context', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-scope-recovery-'));
  const store = new UnifiedDataStore(path.join(root, '.solomap-global'));
  const memoryRoot = path.join(root, 'memory');
  fs.mkdirSync(path.join(memoryRoot, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(memoryRoot, 'projects', 'JW.md'), '# JW history');
  fs.writeFileSync(path.join(memoryRoot, 'projects', 'maoxuan.md'), '# 照见\n\n- Workspace: `/old/workspace/MX`');
  fs.writeFileSync(path.join(memoryRoot, 'projects', 'retired-alias.md'), '# Unmapped history');
  fs.writeFileSync(path.join(memoryRoot, 'projects', '另一个中文项目.md'), '# 不能静默错配');
  const learningRoot = path.join(root, 'learning');
  fs.mkdirSync(path.join(learningRoot, 'candidates'), { recursive: true });
  fs.writeFileSync(path.join(learningRoot, 'candidates', 'lesson.json'), JSON.stringify({
    schemaVersion: 1, id: 'lesson', projectPath: '/old/workspace/szlkblog', status: 'candidate',
    summary: '完整历史结论', appliesWhen: '同类条件', doThis: '执行动作', avoidThis: '避免动作', evidenceRefs: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  }));
  try {
    const jw = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'jw', data: { name: 'JW' } }).objectId;
    const mx = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'mx', data: { name: 'MX' } }).objectId;
    const blog = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'blog', data: { name: 'SZLKBlog' } }).objectId;
    const chinese = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'chinese', data: { name: '中文项目' } }).objectId;
    const memory = await importMemoryDirectory(store, memoryRoot, { projectScopes: { jw, '/current/workspace/MX': mx, '/current/workspace/中文项目': chinese }, archiveUnresolved: true });
    assert.deepEqual(memory.conflicts, []);
    assert.equal(store.search({ scope: jw, kinds: ['memory'] }).items.length, 1);
    assert.equal(store.search({ scope: mx, kinds: ['memory'] }).items.length, 1);
    assert.equal(store.search({ scope: null, kinds: ['memory'] }).items.length, 0);
    assert.equal(store.search({ scope: chinese, kinds: ['memory'] }).items.length, 0);
    assert.equal(memory.archivedSources.length, 2);
    const learning = await importLearningDirectory(store, learningRoot, { projectScopes: { '/current/workspace/SZLKBlog': blog }, archiveUnresolved: true });
    assert.deepEqual(learning.conflicts, []);
    assert.equal(store.search({ scope: blog, kinds: ['lesson'] }).items.length, 1);
  } finally { store.close(); }
});

test('a retired analysis cache cannot replace live state and is archived without remaining a conflict', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-analysis-archive-'));
  const dataRoot = path.join(root, '.solomap-global');
  const projectRoot = path.join(root, 'project');
  const metadata = path.join(projectRoot, '.solopreneur');
  fs.mkdirSync(metadata, { recursive: true });
  const sourceFile = path.join(metadata, 'issues-cache.json');
  const bytes = Buffer.from(JSON.stringify({ syncedAt: '2025-01-01T00:00:00.000Z', issues: [{ id: 'old' }] }));
  fs.writeFileSync(sourceFile, bytes);
  const store = new UnifiedDataStore(dataRoot);
  try {
    const project = await store.registerProject({ root: projectRoot });
    store.writeAnalysisState(project.projectId, { namespace: 'external', key: 'issues', expectedRevision: 0, value: { current: true }, idempotencyKey: 'live-state' });
    const result = await importAnalysisCaches(store, dataRoot, { projectScopes: { [projectRoot]: project.projectId }, archiveUnresolved: true });
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.archivedSources.length, 1);
    assert.deepEqual(store.readAnalysisState(project.projectId, 'external', 'issues').value, { current: true });
    const key = path.relative(dataRoot, sourceFile).split(path.sep).join('/');
    assert.equal(store.readMigrationSource(`analysis-caches:${dataRoot}`, key).stage, 'imported');
    const archived = store.read(result.archivedSources[0].evidenceRef.split('/').at(-1));
    assert.deepEqual(evidenceBytes(archived), bytes);
    const recycling = await new (require('../out/migrationRecycling.js').MigrationRecycling)(store).prepare();
    assert.ok(recycling.files.some(file => file.path === sourceFile));
  } finally { store.close(); }
});

test('a legacy project coverage cache imports into database state and becomes recyclable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-coverage-import-'));
  const dataRoot = path.join(root, '.solomap-global');
  const projectRoot = path.join(root, 'project');
  const coverageRoot = path.join(projectRoot, '.solopreneur', 'coverage');
  fs.mkdirSync(coverageRoot, { recursive: true });
  const sourceFile = path.join(coverageRoot, 'project-growth-coverage.json');
  const snapshot = {
    version: 1,
    provider: 'c8-istanbul',
    status: 'ready',
    generatedAt: '2026-10-16T00:00:00.000Z',
    lastAttemptAt: '2026-10-16T00:00:00.000Z',
    durationMs: 12,
    testPassed: true,
    files: [],
    error: ''
  };
  fs.writeFileSync(sourceFile, JSON.stringify(snapshot));
  const store = new UnifiedDataStore(dataRoot);
  try {
    const project = await store.registerProject({ root: projectRoot });
    const result = await importAnalysisCaches(store, dataRoot, { projectScopes: { [projectRoot]: project.projectId }, archiveUnresolved: true });
    assert.equal(result.imported, 1);
    assert.deepEqual(store.readAnalysisState(project.projectId, 'coverage', 'project-growth').value, snapshot);
    const recycling = await new (require('../out/migrationRecycling.js').MigrationRecycling)(store).prepare();
    assert.ok(recycling.files.some(file => file.path === sourceFile));
  } finally { store.close(); }
});

test('archived global sources and abandoned atomic status temporaries enter the exact recycling plan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-archive-recycling-'));
  const dataRoot = path.join(root, '.solomap-global'), learningRoot = path.join(dataRoot, 'learning');
  const projectRoot = path.join(root, 'project'), statusRoot = path.join(projectRoot, '.solopreneur', 'agent-status');
  fs.mkdirSync(learningRoot, { recursive: true }); fs.mkdirSync(statusRoot, { recursive: true });
  const learningFile = path.join(learningRoot, 'retired.json'), temporary = path.join(statusRoot, '5.json.1234.abcdef.tmp');
  fs.writeFileSync(learningFile, '{"legacy":true}'); fs.writeFileSync(temporary, '');
  const store = new UnifiedDataStore(dataRoot);
  try {
    for (const [identity, key, file] of [
      [`learning:${learningRoot}`, 'retired.json', learningFile],
      [`agent-status:${projectRoot}`, path.basename(temporary), temporary]
    ]) {
      const bytes = fs.readFileSync(file), source = { identity, key, hash: crypto.createHash('sha256').update(bytes).digest('hex') };
      store.captureMigrationSource(source, bytes, { error: 'legacy_source_unresolved' });
      store.archiveMigrationSource(source, bytes, { reason: 'legacy_source_unresolved' });
    }
    const files = (await new (require('../out/migrationRecycling.js').MigrationRecycling)(store).prepare()).files.map(item => item.path);
    assert.ok(files.includes(learningFile));
    assert.ok(files.includes(temporary));
  } finally { store.close(); }
});

test('an incomplete review run keeps an exact formal inventory and every captured file becomes recyclable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-review-archive-'));
  const dataRoot = path.join(root, '.solomap-global'), reviewRoot = path.join(dataRoot, 'maintenance');
  const runRoot = path.join(reviewRoot, 'runs', 'old-review'), resultFile = path.join(runRoot, 'result.json');
  fs.mkdirSync(runRoot, { recursive: true }); fs.writeFileSync(resultFile, '{"partial":true}');
  const store = new UnifiedDataStore(dataRoot);
  try {
    const result = await importLearningReviewDirectory(store, reviewRoot, { archiveUnresolved: true });
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.archivedSources.length, 1);
    assert.equal(store.readMigrationSource(`learning-review:${reviewRoot}`, 'runs/old-review/result.json').stage, 'imported');
    const evidence = store.read(result.archivedSources[0].evidenceRef.split('/').at(-1));
    const sourceEntry = JSON.parse(evidence.data.content).sources[0];
    assert.equal(sourceEntry.key, 'runs/old-review/result.json');
    const sourceEvidence = store.read(sourceEntry.evidenceRef.split('/').at(-1));
    assert.deepEqual(evidenceBytes(sourceEvidence), Buffer.from('{"partial":true}'));
    const recycling = await new (require('../out/migrationRecycling.js').MigrationRecycling)(store).prepare();
    assert.ok(recycling.files.some(file => file.path === resultFile));
  } finally { store.close(); }
});

test('an invalid learning ledger remains readable as exact evidence and no longer blocks retirement', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-ledger-archive-'));
  const dataRoot = path.join(root, '.solomap-global'), learningRoot = path.join(dataRoot, 'learning');
  const ledger = path.join(learningRoot, 'ledger', 'events.jsonl'), bytes = Buffer.from('{"broken":true}\n');
  fs.mkdirSync(path.dirname(ledger), { recursive: true }); fs.writeFileSync(ledger, bytes);
  const store = new UnifiedDataStore(dataRoot);
  try {
    const result = await importLearningDirectory(store, learningRoot, { archiveUnresolved: true });
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.archivedSources.length, 1);
    const evidence = store.read(result.archivedSources[0].evidenceRef.split('/').at(-1));
    assert.deepEqual(evidenceBytes(evidence), bytes);
    const recycling = await new (require('../out/migrationRecycling.js').MigrationRecycling)(store).prepare();
    assert.ok(recycling.files.some(file => file.path === ledger));
  } finally { store.close(); }
});

test('a retired review symlink is archived, recycled, and restored without following its target', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-review-link-'));
  const dataRoot = path.join(root, '.solomap-global'), reviewRoot = path.join(dataRoot, 'maintenance');
  const runRoot = path.join(reviewRoot, 'runs', 'old-review', 'backups'), link = path.join(runRoot, 'tool.symlink');
  const target = '/retired/tool/version/bin';
  fs.mkdirSync(runRoot, { recursive: true }); fs.symlinkSync(target, link);
  const store = new UnifiedDataStore(dataRoot);
  try {
    const result = await importLearningReviewDirectory(store, reviewRoot, { archiveUnresolved: true });
    assert.deepEqual(result.conflicts, []);
    const identity = `learning-review:${reviewRoot}`, key = 'runs/old-review/backups/tool.symlink';
    assert.equal(store.migrationSourceKind(identity, key), 'symlink');
    const recycling = new (require('../out/migrationRecycling.js').MigrationRecycling)(store);
    const plan = await recycling.prepare(), item = plan.files.find(file => file.path === link);
    assert.ok(item); recycling.confirm(plan.planId);
    assert.deepEqual((await recycling.recycleBatch([item.itemId])).failures, []);
    assert.equal(fs.existsSync(link), false);
    const unlink = fs.promises.unlink, linkFile = fs.promises.link; let interrupted = false, links = 0;
    fs.promises.link = async (...args) => {
      if (++links === 1) { const error = new Error('fixture_cross_device'); error.code = 'EXDEV'; throw error; }
      return linkFile(...args);
    };
    fs.promises.unlink = async file => {
      if (!interrupted && String(file).endsWith(`${item.itemId}.restore`)) { interrupted = true; throw new Error('injected_restore_cleanup_failure'); }
      return unlink(file);
    };
    try { await assert.rejects(recycling.restore(item.itemId), /injected_restore_cleanup_failure/); }
    finally { fs.promises.unlink = unlink; fs.promises.link = linkFile; }
    await recycling.restore(item.itemId);
    await recycling.restore(item.itemId);
    assert.ok(links >= 2);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(link), target);
  } finally { store.close(); }
});

test('a retired review symlink can be restored to its persisted alternate destination across filesystems', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-review-link-destination-'));
  const dataRoot = path.join(root, '.solomap-global'), reviewRoot = path.join(dataRoot, 'maintenance');
  const runRoot = path.join(reviewRoot, 'runs', 'old-review', 'backups'), link = path.join(runRoot, 'tool.symlink');
  const destination = path.join(root, 'recovered', 'tool.symlink'), target = '/retired/tool/version/bin';
  fs.mkdirSync(runRoot, { recursive: true }); fs.symlinkSync(target, link);
  const store = new UnifiedDataStore(dataRoot);
  try {
    await importLearningReviewDirectory(store, reviewRoot, { archiveUnresolved: true });
    const recycling = new (require('../out/migrationRecycling.js').MigrationRecycling)(store);
    const plan = await recycling.prepare(), item = plan.files.find(file => file.path === link);
    assert.ok(item); recycling.confirm(plan.planId);
    assert.deepEqual((await recycling.recycleBatch([item.itemId])).failures, []);
    const linkFile = fs.promises.link; let links = 0;
    fs.promises.link = async (...args) => {
      if (++links === 1) { const error = new Error('fixture_cross_device'); error.code = 'EXDEV'; throw error; }
      return linkFile(...args);
    };
    try { await recycling.restore(item.itemId, destination); }
    finally { fs.promises.link = linkFile; }
    await recycling.restore(item.itemId, destination);
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(destination), target);
  } finally { store.close(); }
});

test('a retired review symlink resumes after its private restore stage is written before state commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-review-link-stage-crash-'));
  const dataRoot = path.join(root, '.solomap-global'), reviewRoot = path.join(dataRoot, 'maintenance');
  const runRoot = path.join(reviewRoot, 'runs', 'old-review', 'backups'), link = path.join(runRoot, 'tool.symlink');
  const target = '/retired/tool/version/bin';
  fs.mkdirSync(runRoot, { recursive: true }); fs.symlinkSync(target, link);
  let store = new UnifiedDataStore(dataRoot);
  try {
    await importLearningReviewDirectory(store, reviewRoot, { archiveUnresolved: true });
    const recycling = new (require('../out/migrationRecycling.js').MigrationRecycling)(store);
    const plan = await recycling.prepare(), item = plan.files.find(file => file.path === link);
    assert.ok(item); recycling.confirm(plan.planId);
    assert.deepEqual((await recycling.recycleBatch([item.itemId])).failures, []);
    const setStatus = store.setRecyclingStatus.bind(store); let interrupted = false;
    store.setRecyclingStatus = (...args) => {
      if (!interrupted && args[1] === 'restoring') { interrupted = true; throw new Error('injected_before_restore_state_commit'); }
      return setStatus(...args);
    };
    await assert.rejects(recycling.restore(item.itemId), /injected_before_restore_state_commit/);
    assert.equal(fs.lstatSync(path.join(dataRoot, '.migration-recycle', `${item.itemId}.restore`)).isSymbolicLink(), true);
    store.close(); store = new UnifiedDataStore(dataRoot);
    await new (require('../out/migrationRecycling.js').MigrationRecycling)(store).restore(item.itemId);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(link), target);
  } finally { store.close(); }
});

test('an interrupted cross-filesystem symlink recovery can move to another persisted destination after restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-review-link-relocate-'));
  const dataRoot = path.join(root, '.solomap-global'), reviewRoot = path.join(dataRoot, 'maintenance');
  const runRoot = path.join(reviewRoot, 'runs', 'old-review', 'backups'), link = path.join(runRoot, 'tool.symlink');
  const firstDestination = path.join(root, 'first', 'tool.symlink'), secondDestination = path.join(root, 'second', 'tool.symlink');
  const target = '/retired/tool/version/bin';
  fs.mkdirSync(runRoot, { recursive: true }); fs.symlinkSync(target, link);
  let store = new UnifiedDataStore(dataRoot);
  try {
    await importLearningReviewDirectory(store, reviewRoot, { archiveUnresolved: true });
    const recycling = new (require('../out/migrationRecycling.js').MigrationRecycling)(store);
    const plan = await recycling.prepare(), item = plan.files.find(file => file.path === link);
    assert.ok(item); recycling.confirm(plan.planId);
    assert.deepEqual((await recycling.recycleBatch([item.itemId])).failures, []);
    const linkFile = fs.promises.link; let links = 0;
    fs.promises.link = async (...args) => {
      if (++links === 1) { const error = new Error('fixture_cross_device'); error.code = 'EXDEV'; throw error; }
      if (links === 2) throw new Error('injected_before_symlink_publish');
      return linkFile(...args);
    };
    try { await assert.rejects(recycling.restore(item.itemId, firstDestination), /injected_before_symlink_publish/); }
    finally { fs.promises.link = linkFile; }
    assert.equal(store.recyclingItem(item.itemId).status, 'restoring');
    assert.ok(store.recyclingRestoreStage(item.itemId));
    store.close(); store = new UnifiedDataStore(dataRoot);
    await new (require('../out/migrationRecycling.js').MigrationRecycling)(store).restore(item.itemId, secondDestination);
    assert.equal(fs.existsSync(firstDestination), false);
    assert.equal(fs.lstatSync(secondDestination).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(secondDestination), target);
  } finally { store.close(); }
});
