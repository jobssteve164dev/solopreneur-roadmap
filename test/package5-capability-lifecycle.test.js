const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');

function fixture(t, label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `solomap-${label}-`));
  const root = path.join(base, '.solomap-global');
  const store = new UnifiedDataStore(root);
  t.after(() => {
    store.close();
    const database = path.join(root, 'solomap.db');
    if (fs.existsSync(database)) fs.unlinkSync(database);
    if (fs.existsSync(root)) fs.rmdirSync(root);
    if (fs.existsSync(base)) fs.rmdirSync(base);
  });
  return { root, store };
}

function cleanupPromptFixture(root) {
  const data = path.join(root, '.solomap-global');
  for (const dir of [path.join(data, 'tmp', 'maintenance-workspace'), path.join(data, 'tmp', 'maintenance-runs'), path.join(data, 'tmp'), data, root]) {
    if (fs.existsSync(dir)) fs.rmdirSync(dir);
  }
}

test('a persisted targetless install survives restart and excludes physical operations until it settles', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-operation-'));
  const root = path.join(base, '.solomap-global');
  let store = new UnifiedDataStore(root);
  t.after(() => {
    store.close();
    const database = path.join(root, 'solomap.db');
    if (fs.existsSync(database)) fs.unlinkSync(database);
    if (fs.existsSync(root)) fs.rmdirSync(root);
    if (fs.existsSync(base)) fs.rmdirSync(base);
  });
  const installId = crypto.randomUUID();
  store.beginCapabilityOperation({ operationId: installId, kind: 'skill', action: 'install', requestKey: 'install-request' });
  store.attachCapabilityOperation({ operationId: installId, resultPath: path.join(root, 'tmp', installId, 'result.json'), runId: 'run-install' });
  store.close();
  store = new UnifiedDataStore(root);
  const active = store.readCapabilityOperations({ activeOnly: true });
  assert.equal(active.length, 1);
  assert.equal(active[0].operationId, installId);
  assert.throws(() => store.beginCapabilityOperation({ operationId: crypto.randomUUID(), kind: 'skill', action: 'uninstall', targetId: 'fixture-skill', requestKey: 'uninstall-during-install' }), /capability_operation_in_progress/);
  assert.throws(() => store.beginCapabilityOperation({ operationId: crypto.randomUUID(), kind: 'skill', action: 'install', requestKey: 'second-targetless-install' }), /capability_operation_in_progress/);
  store.failCapabilityOperation({ operationId: installId, error: 'controlled fixture failure' });
  const uninstallId = crypto.randomUUID();
  assert.doesNotThrow(() => store.beginCapabilityOperation({ operationId: uninstallId, kind: 'skill', action: 'uninstall', targetId: 'fixture-skill', requestKey: 'uninstall-after-install-failed' }));
});

test('targetless installs preserve existing toggles while an uninstall fences later toggles', t => {
  const { store } = fixture(t, 'capability-toggle-fencing');
  const initial = store.patchCapabilityRegistry({ kind: 'skill', entry: { id: 'existing-skill', status: 'installed', enabled: true }, expectedRevision: 0, idempotencyKey: 'existing-skill' });
  const installId = crypto.randomUUID();
  store.beginCapabilityOperation({ operationId: installId, kind: 'skill', action: 'install', requestKey: 'unknown-target-install' });
  const disableId = crypto.randomUUID();
  assert.doesNotThrow(() => store.beginCapabilityOperation({ operationId: disableId, kind: 'skill', action: 'disable', targetId: 'existing-skill', requestKey: 'disable-during-unrelated-install', expectedRevision: initial.revision }));
  store.completeCapabilityOperation({ operationId: disableId, targetId: 'existing-skill', entry: { id: 'existing-skill', status: 'installed', enabled: true } });
  store.failCapabilityOperation({ operationId: installId, error: 'controlled install failure' });
  const uninstallId = crypto.randomUUID();
  store.beginCapabilityOperation({ operationId: uninstallId, kind: 'skill', action: 'uninstall', targetId: 'existing-skill', requestKey: 'uninstall-existing', expectedRevision: 2 });
  assert.throws(() => store.beginCapabilityOperation({ operationId: crypto.randomUUID(), kind: 'skill', action: 'enable', targetId: 'existing-skill', requestKey: 'enable-during-uninstall', expectedRevision: 2 }), /capability_uninstall_in_progress/);
});

test('capability upgrade preserves a newer user disable and complete evidence is directly pageable', t => {
  const { root, store } = fixture(t, 'capability-upgrade');
  const initial = store.patchCapabilityRegistry({ kind: 'mcp', entry: { id: 'fixture-mcp', title: 'Original', status: 'installed', enabled: true, userConfig: { channel: 'private' } }, expectedRevision: 0, idempotencyKey: 'initial' });
  const operationId = crypto.randomUUID();
  store.beginCapabilityOperation({ operationId, kind: 'mcp', action: 'upgrade', targetId: 'fixture-mcp', requestKey: 'upgrade-request', expectedRevision: initial.revision });
  const disableId = crypto.randomUUID();
  store.beginCapabilityOperation({ operationId: disableId, kind: 'mcp', action: 'disable', targetId: 'fixture-mcp', requestKey: 'user-disable', expectedRevision: initial.revision });
  store.completeCapabilityOperation({ operationId: disableId, targetId: 'fixture-mcp', entry: { id: 'fixture-mcp', title: 'Original', status: 'installed', enabled: true, userConfig: { channel: 'private' } } });
  const bytes = Buffer.from('完整能力证据🌿'.repeat(30000));
  const result = store.completeCapabilityOperation({ operationId, targetId: 'fixture-mcp', entry: { id: 'fixture-mcp', title: 'Upgraded', status: 'installed', enabled: true, version: '2.0.0' }, installationReceiptId: crypto.createHash('sha256').update(bytes).digest('hex'), attachments: [{ purpose: 'result', bytes: bytes.toString('base64'), mimeType: 'application/json' }] });
  assert.equal(result.operation.status, 'succeeded');
  const current = store.readCapabilityRegistry({ kind: 'mcp' }).entries[0];
  assert.equal(current.entry.status, 'disabled');
  assert.equal(current.entry.enabled, false);
  assert.deepEqual(current.entry.userConfig, { channel: 'private' });
  assert.equal(current.entry.version, '2.0.0');
  const first = store.readCapabilityEvidence({ kind: 'mcp', targetId: 'fixture-mcp', purpose: 'result', limit: 65536 });
  const second = store.readCapabilityEvidence({ kind: 'mcp', targetId: 'fixture-mcp', purpose: 'result', revision: first.revision, offset: first.nextOffset, limit: 1024 * 1024 });
  assert.ok(Buffer.concat([Buffer.from(first.bytes, 'base64'), Buffer.from(second.bytes, 'base64')]).equals(bytes));
  assert.equal(second.nextOffset, null);
  assert.equal(first.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('physical upgrade and uninstall operations are mutually exclusive for the same target', t => {
  const { store } = fixture(t, 'capability-uninstall-exclusion');
  const initial = store.patchCapabilityRegistry({ kind: 'skill', entry: { id: 'fixture-skill', status: 'installed', enabled: true }, expectedRevision: 0, idempotencyKey: 'initial' });
  const upgradeId = crypto.randomUUID();
  store.beginCapabilityOperation({ operationId: upgradeId, kind: 'skill', action: 'upgrade', targetId: 'fixture-skill', requestKey: 'upgrade-before-uninstall', expectedRevision: initial.revision });
  assert.throws(() => store.beginCapabilityOperation({ operationId: crypto.randomUUID(), kind: 'skill', action: 'upgrade', targetId: 'fixture-skill', requestKey: 'parallel-upgrade', expectedRevision: initial.revision }), /capability_operation_in_progress/);
  assert.throws(() => store.beginCapabilityOperation({ operationId: crypto.randomUUID(), kind: 'skill', action: 'uninstall', targetId: 'fixture-skill', requestKey: 'uninstall-during-upgrade', expectedRevision: initial.revision }), /capability_operation_in_progress/);
  store.failCapabilityOperation({ operationId: upgradeId, error: 'controlled upgrade failure' });
  const uninstallId = crypto.randomUUID();
  store.beginCapabilityOperation({ operationId: uninstallId, kind: 'skill', action: 'uninstall', targetId: 'fixture-skill', requestKey: 'exclusive-uninstall', expectedRevision: initial.revision });
  assert.throws(() => store.beginCapabilityOperation({ operationId: crypto.randomUUID(), kind: 'skill', action: 'upgrade', targetId: 'fixture-skill', requestKey: 'upgrade-after-uninstall', expectedRevision: initial.revision }), /capability_uninstall_in_progress/);
  const current = store.readCapabilityRegistry({ kind: 'skill' }).entries[0].entry;
  assert.equal(current.version, undefined);
});

test('a later uninstall fences an earlier enable receipt for the same target', t => {
  const { store } = fixture(t, 'capability-enable-uninstall-race');
  const initial = store.patchCapabilityRegistry({ kind: 'enhancement', entry: { id: 'fixture-enhancement', status: 'disabled', enabled: false }, expectedRevision: 0, idempotencyKey: 'initial' });
  const enableId = crypto.randomUUID();
  store.beginCapabilityOperation({ operationId: enableId, kind: 'enhancement', action: 'enable', targetId: 'fixture-enhancement', requestKey: 'enable-before-uninstall', expectedRevision: initial.revision });
  const uninstallId = crypto.randomUUID();
  store.beginCapabilityOperation({ operationId: uninstallId, kind: 'enhancement', action: 'uninstall', targetId: 'fixture-enhancement', requestKey: 'uninstall-after-enable', expectedRevision: initial.revision });
  store.completeCapabilityOperation({ operationId: uninstallId, targetId: 'fixture-enhancement', entry: { id: 'fixture-enhancement', status: 'uninstalled', enabled: false } });
  const late = store.completeCapabilityOperation({ operationId: enableId, targetId: 'fixture-enhancement', entry: { id: 'fixture-enhancement', status: 'installed', enabled: true } });
  assert.equal(late.stale, true);
  assert.equal(store.readCapabilityRegistry({ kind: 'enhancement' }).entries[0].entry.status, 'uninstalled');
});

for (const kind of ['skill', 'mcp', 'enhancement']) test(`${kind} uses the same persistent enable and disable lifecycle`, t => {
  const { store } = fixture(t, `capability-toggle-${kind}`);
  const targetId = `fixture-${kind}`;
  store.patchCapabilityRegistry({ kind, entry: { id: targetId, title: targetId, status: 'installed', enabled: true }, expectedRevision: 0, idempotencyKey: `${kind}-initial` });
  for (const [action, enabled] of [['disable', false], ['enable', true]]) {
    const operationId = crypto.randomUUID();
    const current = store.readCapabilityRegistry({ kind }).entries[0];
    store.beginCapabilityOperation({ operationId, kind, action, targetId, requestKey: `${kind}-${action}`, expectedRevision: current.revision });
    store.completeCapabilityOperation({ operationId, targetId, entry: current.entry });
    const updated = store.readCapabilityRegistry({ kind }).entries[0].entry;
    assert.equal(updated.enabled, enabled);
    assert.equal(updated.status, enabled ? 'installed' : 'disabled');
  }
});

test('documentation discovery never creates or rewrites the legacy manifest', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-documentation-authority-'));
  const project = path.join(base, 'project'), docs = path.join(project, 'docs'), legacyDir = path.join(project, '.solopreneur');
  fs.mkdirSync(docs, { recursive: true }); fs.mkdirSync(legacyDir);
  const readme = path.join(project, 'README.md'), guide = path.join(docs, 'guide.md'), legacy = path.join(legacyDir, 'documentation.json');
  fs.writeFileSync(readme, '# Project\n'); fs.writeFileSync(guide, '# Guide\n');
  const sentinel = Buffer.from('{"legacy":"import-only"}\n'); fs.writeFileSync(legacy, sentinel);
  t.after(() => {
    fs.unlinkSync(legacy); fs.unlinkSync(guide); fs.unlinkSync(readme);
    fs.rmdirSync(legacyDir); fs.rmdirSync(docs); fs.rmdirSync(project); fs.rmdirSync(base);
  });
  const documentation = require('../out/documentationManifest.js');
  const manifest = documentation.ensureDocumentationManifest(project, '2026-10-11T00:00:00.000Z');
  assert.equal(manifest.documents.some(item => item.path === 'README.md'), true);
  assert.equal(manifest.documents.some(item => item.path === 'docs/guide.md'), true);
  documentation.auditDocumentationAfterRun(project, { changedFilesSummary: 'M docs/guide.md', finishedAt: '2026-10-11T01:00:00.000Z' }, manifest);
  assert.ok(fs.readFileSync(legacy).equals(sentinel));
});

test('documentation index sync is database-authoritative and identical scans are idempotent', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-documentation-database-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'), docs = path.join(project, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), '# Product\n');
  fs.writeFileSync(path.join(docs, 'guide.md'), '# Guide\n');
  const store = new UnifiedDataStore(root), operations = createRuntimeDataOperations(store);
  t.after(async () => {
    await operations.close(); store.close();
    fs.unlinkSync(path.join(root, 'solomap.db')); fs.rmdirSync(root);
    fs.unlinkSync(path.join(project, '.solopreneur', 'project.json')); fs.rmdirSync(path.join(project, '.solopreneur'));
    if (fs.existsSync(path.join(docs, 'guide.md'))) fs.unlinkSync(path.join(docs, 'guide.md')); fs.rmdirSync(docs);
    fs.unlinkSync(path.join(project, 'README.md')); fs.rmdirSync(project); fs.rmdirSync(base);
  });
  const documentation = require('../out/documentationManifest.js');
  const empty = await operations({ operation: 'read_documentation_manifest', input: { root: project } });
  const manifest = documentation.refreshDocumentationManifest(project, empty, '2026-10-11T00:00:00.000Z');
  const input = { root: project, manifest, idempotencyKey: 'documentation-scan:fixture' };
  const first = await operations({ operation: 'sync_documentation_manifest', input });
  const second = await operations({ operation: 'sync_documentation_manifest', input: { ...input, idempotencyKey: 'documentation-scan:duplicate' } });
  assert.deepEqual(second, first);
  assert.equal(first.documents.some(item => item.path === 'README.md'), true);
  assert.equal(first.documents.some(item => item.path === 'docs/guide.md'), true);
  assert.equal(fs.existsSync(path.join(project, '.solopreneur', 'documentation.json')), false);
  const { DatabaseSync } = require('node:sqlite');
  const observer = new DatabaseSync(path.join(root, 'solomap.db'), { readOnly: true });
  assert.equal(observer.prepare("SELECT COUNT(*) AS total FROM evidence WHERE type='documentation_manifest'").get().total, 1);
  observer.close();

  fs.unlinkSync(path.join(docs, 'guide.md'));
  const afterDelete = documentation.refreshDocumentationManifest(project, first, '2026-10-11T02:00:00.000Z');
  assert.equal(afterDelete.documents.find(item => item.path === 'docs/guide.md').status, 'missing');
  const deleted = await operations({ operation: 'sync_documentation_manifest', input: {
    root: project, manifest: afterDelete, idempotencyKey: 'documentation-scan:after-delete'
  } });
  assert.equal(deleted.documents.find(item => item.path === 'docs/guide.md').status, 'missing');
  const persisted = await operations({ operation: 'read_documentation_manifest', input: { root: project } });
  assert.equal(persisted.documents.find(item => item.path === 'docs/guide.md').status, 'missing');
});

test('startup migration captures the legacy documentation index without rewriting the user file', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-documentation-migration-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'), metadata = path.join(project, '.solopreneur');
  fs.mkdirSync(metadata, { recursive: true });
  const legacyPath = path.join(metadata, 'documentation.json');
  const legacy = Buffer.from(JSON.stringify({ schemaVersion: 1, updatedAt: '2026-01-02T03:04:05.000Z', documents: [
    { path: 'docs/boundary.md', role: 'product-boundary', status: 'active', solves: 'Keep the exact product boundary', lastReviewedAt: '2026-01-01T00:00:00.000Z' }
  ], pendingReview: [{ path: 'docs/old.md', reason: 'Needs a decision', severity: 'warning', detectedAt: '2026-01-02T00:00:00.000Z', source: 'legacy' }] }));
  fs.writeFileSync(legacyPath, legacy);
  const docs = path.join(project, 'docs'); fs.mkdirSync(docs); fs.writeFileSync(path.join(docs, 'boundary.md'), '# Boundary\n');
  const store = new UnifiedDataStore(root), operations = createRuntimeDataOperations(store);
  t.after(async () => {
    await operations.close(); store.close();
    fs.unlinkSync(path.join(root, 'solomap.db')); fs.rmdirSync(root);
    fs.unlinkSync(legacyPath); fs.unlinkSync(path.join(metadata, 'project.json')); fs.rmdirSync(metadata);
    fs.unlinkSync(path.join(docs, 'boundary.md')); fs.rmdirSync(docs);
    fs.rmdirSync(project); fs.rmdirSync(base);
  });
  await store.registerProject({ root: project });
  await operations({ operation: 'sync_documentation_manifest', input: { root: project, manifest: {
    schemaVersion: 1, updatedAt: '2026-10-12T00:00:00.000Z', documents: [
      { path: 'docs/boundary.md', role: 'project-document', status: 'active', solves: 'Scanned markdown file', lastTouchedAt: '2026-10-12T00:00:00.000Z' }
    ], pendingReview: []
  }, idempotencyKey: 'documentation-scan:startup-race' } });
  const { enqueueAvailableDataMigrations } = require('../out/runtimeDatabaseBootstrap.js');
  const queued = await enqueueAvailableDataMigrations(store, operations, () => true);
  assert.ok(queued.queued >= 1);
  await operations.waitForMigrations();
  const imported = await operations({ operation: 'read_documentation_manifest', input: { root: project } });
  assert.equal(imported.documents[0].role, 'product-boundary');
  assert.equal(imported.documents[0].solves, 'Keep the exact product boundary');
  assert.equal(imported.pendingReview[0].reason, 'Needs a decision');
  assert.ok(fs.readFileSync(legacyPath).equals(legacy));
  const captured = store.readMigrationSource(`documentation:${fs.realpathSync(project)}`, '.solopreneur/documentation.json');
  assert.ok(captured.bytes.equals(legacy));
  assert.equal(captured.stage, 'imported');

  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(legacy.toString('utf8')), updatedAt: '2026-01-03T03:04:05.000Z' }));
  fs.writeFileSync(legacyPath, changed);
  const refreshed = await enqueueAvailableDataMigrations(store, operations, () => true);
  assert.ok(refreshed.queued >= 1, 'changed legacy bytes must enqueue a distinct migration attempt');
  await operations.waitForMigrations();
  const conflict = store.readMigrationSource(`documentation:${fs.realpathSync(project)}`, '.solopreneur/documentation.json');
  assert.ok(conflict.bytes.equals(changed));
  assert.equal(conflict.stage, 'imported', 'a changed retired source must be archived without replacing the database authority');
  assert.equal((await operations({ operation: 'read_documentation_manifest', input: { root: project } })).updatedAt, '2026-01-02T03:04:05.000Z');
  const jobs = (await operations({ operation: 'migration_overview', input: {} })).jobs.filter(job => job.args.collection === 'documentation');
  assert.equal(jobs.at(-1).status, 'completed');
  assert.equal(jobs.at(-1).progress.archivedSources.length, 1);
});

test('a terminal maintenance run without its promised result can be settled as failed', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-missing-result-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root);
  t.after(() => {
    store.close();
    fs.unlinkSync(path.join(root, 'solomap.db')); fs.rmdirSync(root);
    const metadata = path.join(project, '.solopreneur', 'project.json');
    if (fs.existsSync(metadata)) fs.unlinkSync(metadata);
    if (fs.existsSync(path.dirname(metadata))) fs.rmdirSync(path.dirname(metadata));
    fs.rmdirSync(project); fs.rmdirSync(base);
  });
  const operationId = crypto.randomUUID();
  store.beginCapabilityOperation({ operationId, kind: 'skill', action: 'install', requestKey: 'missing-result' });
  assert.deepEqual(store.readCapabilityOperationRunState({ operationId }), { attached: false, terminal: false, status: '', exitCode: null });
  const registered = await store.registerProject({ root: project });
  const run = store.prepareRun(registered.projectId, registered.locationId, { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'skill_install', prompt: 'install', command: 'agy', userMessage: 'install', status: 'Failed', idempotencyKey: 'missing-result-run' });
  store.attachCapabilityOperation({ operationId, resultPath: path.join(root, 'tmp', operationId, 'result.json'), runId: run.runId });
  assert.deepEqual(store.readCapabilityOperationRunState({ operationId }), { attached: true, terminal: true, status: 'Failed', exitCode: null });
  const bytes = Buffer.from('{"ok":true,"skillId":"fixture-skill"}');
  store.writeRunDocument(registered.projectId, { executionLogId: 1, generation: run.generation, turnId: run.turnId, purpose: `maintenance_result_${run.generation}`, bytes: bytes.toString('base64'), mimeType: 'application/json', expectedRevision: 0, idempotencyKey: 'fixed-maintenance-result' });
  const fixed = store.readCapabilityOperationResult({ operationId });
  assert.deepEqual(Buffer.from(fixed.bytes, 'base64'), bytes);
  assert.equal(fixed.hash, crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('capability result files are ignored until the owning maintenance run is terminal', () => {
  const registry = require('../out/capabilityRegistry.js');
  assert.equal(registry.capabilityOperationSettlementDecision({ attached: true, terminal: false, status: 'Running', exitCode: null }, true), 'wait');
  assert.equal(registry.capabilityOperationSettlementDecision({ attached: true, terminal: true, status: 'In Progress', exitCode: 0 }, true), 'settle');
  assert.equal(registry.capabilityOperationSettlementDecision({ attached: true, terminal: true, status: 'Failed', exitCode: 2 }, false), 'fail_missing_result');
});

test('fresh capability operations are not failed while their maintenance run is being prepared', () => {
  const registry = require('../out/capabilityRegistry.js');
  const createdAt = 1_000_000;
  const pending = { resultPath: null, createdAt };
  assert.equal(registry.capabilityOperationNeedsLaunchRecovery(pending, createdAt + 59_999), false);
  assert.equal(registry.capabilityOperationNeedsLaunchRecovery(pending, createdAt + 60_000), true);
  assert.equal(registry.capabilityOperationNeedsLaunchRecovery({ resultPath: '/tmp/result.json', createdAt }, createdAt + 600_000), false);
});

test('launch recovery removes only its incomplete capability baseline', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-incomplete-baseline-'));
  const root = path.join(base, '.solomap-global');
  const store = new UnifiedDataStore(root);
  const operationId = store.beginCapabilityOperation({
    operationId: crypto.randomUUID(), kind: 'skill', action: 'install',
    sourceIntent: { input: 'fixture' }, requestKey: 'incomplete-baseline'
  }).operationId;
  const baselinesRoot = path.join(root, 'tmp', 'capability-operation-baselines');
  const incomplete = path.join(baselinesRoot, operationId);
  const unrelated = path.join(baselinesRoot, 'unrelated-operation');
  const keep = path.join(unrelated, 'keep.txt');
  fs.mkdirSync(path.join(incomplete, 'target'), { recursive: true });
  fs.writeFileSync(path.join(incomplete, 'target', 'partial.txt'), 'partial');
  fs.mkdirSync(unrelated, { recursive: true });
  fs.writeFileSync(keep, 'keep');
  t.after(() => {
    store.close();
    if (fs.existsSync(keep)) fs.unlinkSync(keep);
    for (const dir of [unrelated, baselinesRoot, path.join(root, 'tmp')]) if (fs.existsSync(dir)) fs.rmdirSync(dir);
    for (const file of [path.join(root, 'solomap.db-shm'), path.join(root, 'solomap.db-wal'), path.join(root, 'solomap.db')]) if (fs.existsSync(file)) fs.unlinkSync(file);
    for (const dir of [root, base]) if (fs.existsSync(dir)) fs.rmdirSync(dir);
  });

  await require('../out/solomapGlobal.js').rollbackCapabilityOperationFilesystem(root, operationId);

  assert.equal(fs.existsSync(incomplete), false);
  assert.equal(fs.readFileSync(keep, 'utf8'), 'keep');
  const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  assert.match(extensionSource, /capabilityOperationNeedsLaunchRecovery\(operation\)[\s\S]*failCapabilityOperationWithRollback\(globalRoot, operation, 'capability_operation_not_launched'\)/);
});

test('capability operations retain the exact authorized source and active rows survive recent history limits', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-source-intent-'));
  const root = path.join(base, '.solomap-global');
  const store = new UnifiedDataStore(root);
  t.after(() => {
    store.close();
    for (const file of [path.join(root, 'solomap.db-shm'), path.join(root, 'solomap.db-wal'), path.join(root, 'solomap.db')]) if (fs.existsSync(file)) fs.unlinkSync(file);
    for (const dir of [root, base]) if (fs.existsSync(dir)) fs.rmdirSync(dir);
  });
  const operationId = crypto.randomUUID();
  const sourceIntent = { input: 'https://example.invalid/owner/skill@main', registrySource: { input: 'https://example.invalid/owner/skill@main', commit: 'abc123' } };
  const active = store.beginCapabilityOperation({ operationId, kind: 'skill', action: 'upgrade', targetId: 'fixture-skill', requestKey: 'source-bound-upgrade', expectedRevision: 4, sourceIntent });
  assert.deepEqual(active.sourceIntent, sourceIntent);
  assert.throws(() => store.beginCapabilityOperation({ operationId, kind: 'skill', action: 'upgrade', targetId: 'fixture-skill', requestKey: 'source-bound-upgrade', expectedRevision: 4, sourceIntent: { input: 'https://example.invalid/other/skill' } }), /idempotency_conflict/);
  for (let index = 0; index < 105; index++) {
    const id = crypto.randomUUID();
    store.beginCapabilityOperation({ operationId: id, kind: 'mcp', action: 'enable', targetId: `fixture-${index}`, requestKey: `settled-${index}` });
    store.failCapabilityOperation({ operationId: id, error: 'fixture_settled' });
  }
  const projected = store.readCapabilityOperations({ recentLimit: 100 });
  assert.ok(projected.some(item => item.operationId === operationId && item.status === 'pending'));
  assert.equal(projected.filter(item => item.status === 'failed').length, 100);
});

test('source locks must match the source authorized by the persisted operation', () => {
  const global = require('../out/solomapGlobal.js');
  const authorized = { input: 'owner/repository@skill', registrySource: { input: 'owner/repository@skill', commit: '0123456789abcdef' } };
  assert.deepEqual(global.validateCapabilitySourceLock({ input: 'owner/repository@skill', commit: 'fedcba9876543210' }, authorized), {
    input: 'owner/repository@skill', commit: 'fedcba9876543210'
  });
  assert.throws(() => global.validateCapabilitySourceLock({ input: 'other/repository@skill', commit: '0123456789abcdef' }, authorized), /capability_source_mismatch/);
  assert.deepEqual(global.validateCapabilitySourceLock({ source: { input: 'owner/repository@skill', commit: 'fedcba9876543210' }, packageHash: 'sha256:' + 'a'.repeat(64) }, authorized), {
    input: 'owner/repository@skill', commit: 'fedcba9876543210'
  });
  assert.throws(() => global.validateCapabilitySourceLock({
    input: 'owner/repository@skill', repo: 'trusted/repository', commit: '0123456789abcdef',
    source: { input: 'owner/repository@skill', repo: 'attacker/repository', commit: 'fedcba9876543210' }
  }, authorized), /capability_source_lock_ambiguous/);
});

test('managed capability paths reject linked parents before launch and after a parent swap', t => {
  const global = require('../out/solomapGlobal.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-parent-link-'));
  const root = path.join(base, '.solomap-global'), outside = path.join(base, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  const roots = [
    path.join(root, 'skills', 'installed'),
    path.join(root, 'mcp', 'servers'),
    path.join(root, 'enhancements', 'installed')
  ];
  for (const managedRoot of roots) fs.mkdirSync(managedRoot, { recursive: true });
  t.after(() => {
    for (const managedRoot of roots) {
      if (fs.existsSync(managedRoot) && fs.lstatSync(managedRoot).isSymbolicLink()) fs.unlinkSync(managedRoot);
      if (fs.existsSync(managedRoot)) fs.rmdirSync(managedRoot);
      const parent = path.dirname(managedRoot);
      if (fs.existsSync(parent)) fs.rmdirSync(parent);
    }
    fs.rmdirSync(outside); fs.rmdirSync(root); fs.rmdirSync(base);
  });
  for (const managedRoot of roots) {
    const candidate = path.join(managedRoot, 'fixture');
    assert.equal(global.managedCapabilityPathIsSafe(root, candidate), true);
    fs.symlinkSync(path.join(outside, 'missing-target'), candidate);
    assert.equal(global.managedCapabilityPathIsSafe(root, candidate), false, 'a dangling managed symlink is still a physical path entry');
    fs.unlinkSync(candidate);
    fs.rmdirSync(managedRoot);
    fs.symlinkSync(outside, managedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(global.managedCapabilityPathIsSafe(root, candidate), false);
    fs.unlinkSync(managedRoot);
    fs.mkdirSync(managedRoot);
  }
});

test('capability stores and uninstall settlement reject a linked managed parent', async t => {
  const global = require('../out/solomapGlobal.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-store-parent-link-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'), outside = path.join(base, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(project); fs.mkdirSync(outside);
  const cases = [
    { parent: path.join(root, 'skills'), leaf: 'installed', ensure: () => global.ensureSolomapSkillStore(project, root) },
    { parent: path.join(root, 'mcp'), leaf: 'servers', ensure: () => global.ensureSolomapMcpStore(project, root) }
  ];
  t.after(() => {
    for (const item of cases) {
      const linked = path.join(item.parent, item.leaf);
      if (fs.existsSync(linked) && fs.lstatSync(linked).isSymbolicLink()) fs.unlinkSync(linked);
      if (fs.existsSync(item.parent)) fs.rmdirSync(item.parent);
    }
    const result = path.join(root, 'tmp', 'result.json');
    if (fs.existsSync(result)) fs.unlinkSync(result);
    if (fs.existsSync(path.dirname(result))) fs.rmdirSync(path.dirname(result));
    fs.rmdirSync(outside); fs.rmdirSync(project); fs.rmdirSync(root); fs.rmdirSync(base);
  });
  for (const item of cases) {
    fs.mkdirSync(item.parent);
    fs.symlinkSync(outside, path.join(item.parent, item.leaf), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(Promise.resolve().then(item.ensure), /capability_managed_path_invalid/);
    fs.unlinkSync(path.join(item.parent, item.leaf));
    fs.rmdirSync(item.parent);
  }
  const installedParent = path.join(root, 'skills', 'installed');
  fs.mkdirSync(path.dirname(installedParent));
  fs.symlinkSync(outside, installedParent, process.platform === 'win32' ? 'junction' : 'dir');
  const result = path.join(root, 'tmp', 'result.json'); fs.mkdirSync(path.dirname(result));
  fs.writeFileSync(result, JSON.stringify({ ok: true, skillId: 'fixture-skill', removedPaths: [path.join(installedParent, 'fixture-skill')] }));
  const settled = await global.validateAndRegisterCapabilityUninstall(project, root, 'skill', 'fixture-skill', path.join(installedParent, 'fixture-skill'), result, crypto.randomUUID());
  assert.equal(settled.ok, false); assert.match(settled.message, /符号链接|数据根/);
});

test('skill registration atomically commits staged bytes and preserves the authorized source across upgrade', async t => {
  const global = require('../out/solomapGlobal.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-source-commit-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project');
  fs.mkdirSync(project); fs.mkdirSync(root);
  const store = new UnifiedDataStore(root), operations = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({
    globalDataPath: root,
    runtimeId: 'bound-source-fixture',
    onCommand: () => ({ status: 'running' }),
    onData: request => operations(request)
  });
  const sourceInput = 'owner/repository@bound-skill';
  const builtinSkillIds = ['solomap-cross-project-memory', 'solomap-global-execution-guide', 'solomap-project-docs-lifecycle', 'solomap-roadmap-planning'];
  t.after(async () => {
    await server.close(); await operations.close(); store.close();
    const files = [
      path.join(root, 'skills', 'installed', 'bound-skill', 'package', 'SKILL.md'),
      ...builtinSkillIds.map(id => path.join(root, 'skills', 'installed', id, 'package', 'SKILL.md')),
      ...['first', 'upgrade', 'lost-reply'].flatMap(label => [path.join(root, 'tmp', label, 'result.json'), path.join(root, 'tmp', label, 'solomap.skill.json'), path.join(root, 'tmp', label, 'source.lock.json')]),
      path.join(root, 'solomap.db-shm'), path.join(root, 'solomap.db-wal'), path.join(root, 'solomap.db')
    ];
    for (const file of files) if (fs.existsSync(file)) fs.unlinkSync(file);
    const dirs = [
      path.join(root, 'skills', 'installed', 'bound-skill', 'package'), path.join(root, 'skills', 'installed', 'bound-skill'),
      ...builtinSkillIds.flatMap(id => [path.join(root, 'skills', 'installed', id, 'package'), path.join(root, 'skills', 'installed', id)]),
      path.join(root, 'skills', 'installed'), path.join(root, 'skills'),
      path.join(root, 'tmp', 'first', 'candidate'), path.join(root, 'tmp', 'first'),
      path.join(root, 'tmp', 'upgrade', 'candidate'), path.join(root, 'tmp', 'upgrade'),
      path.join(root, 'tmp', 'lost-reply', 'candidate'), path.join(root, 'tmp', 'lost-reply'),
      path.join(root, 'tmp'), path.join(root, 'runtime'), root, project, base
    ];
    for (const dir of dirs) if (fs.existsSync(dir)) fs.rmdirSync(dir);
  });

  async function stagedInstall(label, operationId, contents, commit, expectedRevision = 0) {
    const staging = path.join(root, 'tmp', label), installed = path.join(staging, 'candidate', 'bound-skill');
    const packagePath = path.join(installed, 'package'), manifest = path.join(staging, 'solomap.skill.json');
    const lock = path.join(staging, 'source.lock.json'), result = path.join(staging, 'result.json');
    fs.mkdirSync(packagePath, { recursive: true });
    fs.writeFileSync(path.join(packagePath, 'SKILL.md'), contents);
    fs.writeFileSync(manifest, JSON.stringify({ id: 'bound-skill', title: 'Bound skill' }));
    fs.writeFileSync(lock, JSON.stringify({ input: sourceInput, repo: 'owner/repository', commit, packageHash: global.capabilityPackageHash(packagePath) }));
    fs.writeFileSync(result, JSON.stringify({ ok: true, skillId: 'bound-skill', installedPath: installed, packagePath, entryFile: path.join(packagePath, 'SKILL.md'), solomapSkillJson: manifest, sourceLockJson: lock }));
    store.beginCapabilityOperation({ operationId, kind: 'skill', action: label === 'first' ? 'install' : 'upgrade', ...(label === 'first' ? {} : { targetId: 'bound-skill', expectedRevision }), requestKey: `bound-source-${label}`, sourceIntent: { input: sourceInput, ...(label === 'first' ? {} : { registrySource: store.readCapabilityRegistry({ kind: 'skill' }).entries[0].entry.source }) } });
    store.attachCapabilityOperation({ operationId, resultPath: result });
    await global.prepareCapabilityOperationFilesystemBaseline(root, operationId);
    return { result, packagePath };
  }

  const operationId = crypto.randomUUID();
  const first = await stagedInstall('first', operationId, '# Bound skill\n', '0123456789abcdef');
  const stagedManifest = path.join(first.packagePath, 'solomap.skill.json');
  fs.writeFileSync(stagedManifest, JSON.stringify({ id: 'bound-skill', title: 'Wrong evidence location' }));
  const firstReceipt = JSON.parse(fs.readFileSync(first.result, 'utf8'));
  fs.writeFileSync(first.result, JSON.stringify({ ...firstReceipt, solomapSkillJson: stagedManifest }));
  fs.writeFileSync(path.join(root, 'tmp', 'first', 'source.lock.json'), JSON.stringify({ input: sourceInput, repo: 'owner/repository', commit: '0123456789abcdef', packageHash: global.capabilityPackageHash(first.packagePath) }));
  assert.match((await global.validateAndRegisterSkillInstall(project, root, first.result, operationId)).message, /capability_staged_evidence_path_invalid/);
  fs.unlinkSync(stagedManifest);
  fs.writeFileSync(first.result, JSON.stringify(firstReceipt));
  fs.writeFileSync(path.join(root, 'tmp', 'first', 'source.lock.json'), JSON.stringify({ input: 'attacker/other-skill', packageHash: global.capabilityPackageHash(first.packagePath) }));
  assert.match((await global.validateAndRegisterSkillInstall(project, root, first.result, operationId)).message, /capability_source_mismatch/);
  fs.writeFileSync(path.join(root, 'tmp', 'first', 'source.lock.json'), JSON.stringify({ input: sourceInput, repo: 'owner/repository', commit: '0123456789abcdef', packageHash: global.capabilityPackageHash(first.packagePath) }));
  assert.equal((await global.validateAndRegisterSkillInstall(project, root, first.result, operationId)).ok, true);
  const finalEntry = path.join(root, 'skills', 'installed', 'bound-skill', 'package', 'SKILL.md');
  assert.equal(fs.readFileSync(finalEntry, 'utf8'), '# Bound skill\n');
  let registered = store.readCapabilityRegistry({ kind: 'skill' }).entries[0];
  assert.equal(registered.entry.source.commit, '0123456789abcdef');

  const upgradeId = crypto.randomUUID();
  const upgrade = await stagedInstall('upgrade', upgradeId, '# Bound skill v2\n', 'fedcba9876543210', registered.revision);
  assert.equal((await global.validateAndRegisterSkillInstall(project, root, upgrade.result, upgradeId)).ok, true);
  assert.equal(fs.readFileSync(finalEntry, 'utf8'), '# Bound skill v2\n');
  registered = store.readCapabilityRegistry({ kind: 'skill' }).entries[0];
  assert.equal(registered.entry.source.commit, 'fedcba9876543210');

  const lostReplyId = crypto.randomUUID();
  const lostReply = await stagedInstall('lost-reply', lostReplyId, '# Bound skill v3\n', '0011223344556677', registered.revision);
  const transport = require('../out/autonomousRuntimeControl.js'), previousTransport = transport.sendRuntimeDataRequest;
  let dropReply = true, dropRecoveryRead = false;
  transport.sendRuntimeDataRequest = async (resolved, request) => {
    if (dropRecoveryRead && request.operation === 'read_capability_operations') {
      dropRecoveryRead = false;
      throw new Error('fixture_recovery_read_lost');
    }
    const response = await previousTransport(resolved, request);
    if (dropReply && request.operation === 'complete_capability_operation') {
      dropReply = false;
      dropRecoveryRead = true;
      throw new Error('fixture_reply_lost_after_commit');
    }
    return response;
  };
  try {
    await assert.rejects(global.validateAndRegisterSkillInstall(project, root, lostReply.result, lostReplyId), /capability_commit_state_unknown/);
    assert.equal(fs.readFileSync(finalEntry, 'utf8'), '# Bound skill v3\n');
    assert.equal(fs.existsSync(path.join(root, 'tmp', 'capability-operation-baselines', lostReplyId)), true);
  } finally {
    transport.sendRuntimeDataRequest = previousTransport;
  }
  await global.reconcileCapabilityOperationFilesystems(root);
  assert.equal(fs.existsSync(path.join(root, 'tmp', 'capability-operation-baselines', lostReplyId)), false);
  assert.equal((await global.validateAndRegisterSkillInstall(project, root, lostReply.result, lostReplyId)).ok, true);
  assert.equal(fs.readFileSync(finalEntry, 'utf8'), '# Bound skill v3\n');
  assert.equal(store.readCapabilityOperations({ activeOnly: true }).length, 0);
  assert.equal(fs.existsSync(path.join(root, 'tmp', 'capability-operation-baselines', lostReplyId)), false);
});

test('all Agent-maintained capability prompts publish result.json only once after final verification', t => {
  const global = require('../out/solomapGlobal.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-prompt-contract-'));
  t.after(() => cleanupPromptFixture(root));
  const project = path.join(root, 'project');
  const data = path.join(root, '.solomap-global');
  const result = path.join(data, 'tmp', 'operation', 'result.json');
  const prompts = [
    global.buildSkillInstallPrompt('/source/skill', project, data, result),
    global.buildMcpInstallPrompt('/source/mcp', project, data, result),
    global.buildCapabilityUninstallPrompt('skill', 'fixture-skill', path.join(data, 'skills', 'installed', 'fixture-skill'), result)
  ];
  for (const prompt of prompts) {
    assert.match(prompt, /全部物理操作和最终验证完成后/);
    assert.match(prompt, /原子重命名/);
    assert.match(prompt, /写入后不得再次修改/);
    assert.match(prompt, /solomap_conversation_status/);
    assert.match(prompt, /"outcome":"candidate_complete"/);
    assert.doesNotMatch(prompt, /用检查点命令|SOLOMAP_TASK_COMMAND|--outcome/);
    assert.match(prompt, /success.*不是合法的 outcome/);
    assert.match(prompt, /不要调用 session-close/);
  }
});

test('the host restores the exact pre-run filesystem baseline after a failed install or upgrade', async t => {
  const global = require('../out/solomapGlobal.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-host-rollback-'));
  const root = path.join(base, '.solomap-global'), installedRoot = path.join(root, 'skills', 'installed');
  const target = path.join(installedRoot, 'existing-skill'), entry = path.join(target, 'package', 'SKILL.md');
  fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.writeFileSync(entry, '# Original\n');
  const store = new UnifiedDataStore(root), operations = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'rollback-fixture', onCommand: () => ({ status: 'running' }), onData: request => operations(request) });
  t.after(async () => {
    await server.close(); await operations.close(); store.close();
    for (const file of [entry, path.join(root, 'solomap.db-shm'), path.join(root, 'solomap.db-wal'), path.join(root, 'solomap.db')]) if (fs.existsSync(file)) fs.unlinkSync(file);
    for (const dir of [path.dirname(entry), target, installedRoot, path.dirname(installedRoot), path.join(root, 'tmp'), path.join(root, 'runtime'), root, base]) if (fs.existsSync(dir)) fs.rmdirSync(dir);
  });
  const upgradeId = crypto.randomUUID();
  store.beginCapabilityOperation({ operationId: upgradeId, kind: 'skill', action: 'upgrade', targetId: 'existing-skill', requestKey: 'rollback-upgrade' });
  await global.prepareCapabilityOperationFilesystemBaseline(root, upgradeId);
  fs.writeFileSync(entry, '# Corrupted\n'); fs.writeFileSync(path.join(target, 'partial.txt'), 'partial');
  await global.rollbackCapabilityOperationFilesystem(root, upgradeId);
  assert.equal(fs.readFileSync(entry, 'utf8'), '# Original\n');
  assert.equal(fs.existsSync(path.join(target, 'partial.txt')), false);
  store.failCapabilityOperation({ operationId: upgradeId, error: 'fixture rollback complete' });

  const installId = crypto.randomUUID();
  store.beginCapabilityOperation({ operationId: installId, kind: 'skill', action: 'install', requestKey: 'rollback-install' });
  await global.prepareCapabilityOperationFilesystemBaseline(root, installId);
  const unexpected = path.join(installedRoot, 'partial-new-skill');
  fs.mkdirSync(unexpected); fs.writeFileSync(path.join(unexpected, 'partial.txt'), 'partial');
  await global.rollbackCapabilityOperationFilesystem(root, installId);
  assert.equal(fs.readFileSync(path.join(unexpected, 'partial.txt'), 'utf8'), 'partial');
  fs.unlinkSync(path.join(unexpected, 'partial.txt')); fs.rmdirSync(unexpected);
});

test('MCP receipts cannot register an absent physical install', async t => {
  const global = require('../out/solomapGlobal.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-physical-validation-'));
  const root = path.join(base, '.solomap-global');
  const project = path.join(base, 'project');
  fs.mkdirSync(project); fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const mcpResult = path.join(root, 'tmp', 'mcp-result.json');
  t.after(() => {
    for (const file of [mcpResult]) if (fs.existsSync(file)) fs.unlinkSync(file);
    for (const dir of [path.join(root, 'tmp'), root, project, base]) {
      if (fs.existsSync(dir)) fs.rmdirSync(dir);
    }
  });
  fs.writeFileSync(mcpResult, JSON.stringify({
    ok: true, mcpId: 'receipt-only',
    installedPath: path.join(root, 'mcp', 'servers', 'receipt-only'),
    packagePath: path.join(root, 'mcp', 'servers', 'receipt-only', 'package')
  }));
  assert.match((await global.validateAndRegisterMcpInstall(project, root, mcpResult)).message, /outside|does not exist/);
});

test('MCP install rejects a nonempty managed package whose manifest has no real server entry', async t => {
  const global = require('../out/solomapGlobal.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-mcp-missing-server-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project');
  const installed = path.join(root, 'mcp', 'servers', 'fixture-mcp'), packagePath = path.join(installed, 'package');
  const manifest = path.join(installed, 'solomap.mcp.json'), lock = path.join(installed, 'source.lock.json'), result = path.join(root, 'tmp', 'result.json');
  fs.mkdirSync(project); fs.mkdirSync(packagePath, { recursive: true }); fs.mkdirSync(path.dirname(result), { recursive: true });
  fs.writeFileSync(path.join(packagePath, 'README.md'), '# Nonempty package\n');
  fs.writeFileSync(manifest, JSON.stringify({ id: 'fixture-mcp', title: 'Fixture MCP', server: { entry: 'missing-server.js' } }));
  fs.writeFileSync(lock, JSON.stringify({ version: '1.0.0' }));
  fs.writeFileSync(result, JSON.stringify({ ok: true, mcpId: 'fixture-mcp', installedPath: installed, packagePath, solomapMcpJson: manifest, sourceLockJson: lock }));
  t.after(() => {
    for (const file of [result, lock, manifest, path.join(packagePath, 'server.js'), path.join(packagePath, 'README.md')]) if (fs.existsSync(file)) fs.unlinkSync(file);
    for (const dir of [packagePath, installed, path.join(root, 'mcp', 'servers'), path.join(root, 'mcp'), path.join(root, 'tmp'), root, project, base]) if (fs.existsSync(dir)) fs.rmdirSync(dir);
  });
  const rejected = await global.validateAndRegisterMcpInstall(project, root, result);
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /existing managed server entry|valid remote endpoint/);
  fs.writeFileSync(path.join(packagePath, 'server.js'), 'process.stdout.write("ready")\n');
  fs.writeFileSync(manifest, JSON.stringify({ id: 'another-mcp', title: 'Fixture MCP', server: { entry: 'server.js' } }));
  assert.match((await global.validateAndRegisterMcpInstall(project, root, result)).message, /manifest id does not match/);
  fs.writeFileSync(result, JSON.stringify({ ok: true, mcpId: 'another-mcp', installedPath: installed, packagePath, solomapMcpJson: manifest, sourceLockJson: lock }));
  assert.match((await global.validateAndRegisterMcpInstall(project, root, result)).message, /installedPath does not match/);
});

test('staged MCP validation maps the formal runtime entry to the candidate bytes', async t => {
  const global = require('../out/solomapGlobal.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-mcp-formal-entry-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project');
  const staging = path.join(root, 'tmp', 'mcp-formal'), installed = path.join(staging, 'candidate', 'fixture-mcp');
  const packagePath = path.join(installed, 'package'), serverPath = path.join(packagePath, 'server.js');
  const manifest = path.join(staging, 'solomap.mcp.json'), lock = path.join(staging, 'source.lock.json');
  const profiles = path.join(staging, 'profiles'), result = path.join(staging, 'result.json');
  const finalServer = path.join(root, 'mcp', 'servers', 'fixture-mcp', 'package', 'server.js');
  fs.mkdirSync(project); fs.mkdirSync(packagePath, { recursive: true }); fs.mkdirSync(profiles);
  fs.writeFileSync(serverPath, 'process.stdin.resume();\n');
  fs.writeFileSync(manifest, JSON.stringify({ id: 'fixture-mcp', title: 'Fixture MCP', server: { transport: 'stdio', command: 'node', args: [finalServer] } }));
  fs.writeFileSync(lock, JSON.stringify({ input: '/fixture/mcp', packageHash: global.capabilityPackageHash(packagePath) }));
  fs.writeFileSync(result, JSON.stringify({ ok: true, mcpId: 'fixture-mcp', installedPath: installed, packagePath, solomapMcpJson: manifest, sourceLockJson: lock, profilesPath: profiles }));
  const store = new UnifiedDataStore(root), operations = createRuntimeDataOperations(store);
  const control = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'mcp-formal-entry', onCommand: () => ({ status: 'running' }), onData: request => operations(request) });
  const operationId = crypto.randomUUID();
  store.beginCapabilityOperation({ operationId, kind: 'mcp', action: 'install', requestKey: 'mcp-formal-entry', sourceIntent: { input: '/fixture/mcp' } });
  store.attachCapabilityOperation({ operationId, resultPath: result });
  await global.prepareCapabilityOperationFilesystemBaseline(root, operationId);
  t.after(async () => {
    await control.close(); await operations.close(); store.close();
    for (const file of [finalServer, path.join(root, 'solomap.db-shm'), path.join(root, 'solomap.db-wal'), path.join(root, 'solomap.db'), result, lock, manifest]) if (fs.existsSync(file)) fs.unlinkSync(file);
    for (const dir of [path.dirname(finalServer), path.dirname(path.dirname(finalServer)), path.join(root, 'mcp', 'servers'), path.join(root, 'mcp'), profiles, path.join(staging, 'candidate'), staging, path.join(root, 'tmp'), path.join(root, 'runtime'), root, project, base]) if (fs.existsSync(dir)) fs.rmdirSync(dir);
  });
  const accepted = await global.validateAndRegisterMcpInstall(project, root, result, operationId);
  assert.equal(accepted.ok, true);
  assert.equal(fs.readFileSync(finalServer, 'utf8'), 'process.stdin.resume();\n');
});

test('capability receipts reject unmanaged results, invalid source locks, and linked MCP profiles', async t => {
  const global = require('../out/solomapGlobal.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-receipt-boundary-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project');
  const installed = path.join(root, 'mcp', 'servers', 'fixture-mcp'), packagePath = path.join(installed, 'package');
  const staging = path.join(root, 'tmp', 'operation'), outside = path.join(base, 'outside');
  const manifest = path.join(staging, 'solomap.mcp.json'), lock = path.join(staging, 'source.lock.json');
  const profiles = path.join(staging, 'profiles'), result = path.join(staging, 'result.json'), rogue = path.join(base, 'result.json');
  fs.mkdirSync(project); fs.mkdirSync(packagePath, { recursive: true }); fs.mkdirSync(staging, { recursive: true }); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(packagePath, 'server.js'), 'process.stdout.write("ready")\n');
  fs.writeFileSync(manifest, JSON.stringify({ id: 'fixture-mcp', server: { entry: 'server.js' } }));
  fs.writeFileSync(lock, JSON.stringify({ source: 'fixture/mcp' }));
  const receipt = { ok: true, mcpId: 'fixture-mcp', installedPath: installed, packagePath, solomapMcpJson: manifest, sourceLockJson: lock, profilesPath: profiles };
  fs.writeFileSync(result, JSON.stringify(receipt));
  fs.symlinkSync(outside, profiles);
  t.after(() => {
    for (const file of [rogue, result, lock, manifest, path.join(packagePath, 'server.js')]) if (fs.existsSync(file)) fs.unlinkSync(file);
    if (fs.existsSync(profiles)) fs.lstatSync(profiles).isSymbolicLink() ? fs.unlinkSync(profiles) : fs.rmdirSync(profiles);
    for (const dir of [packagePath, installed, path.join(root, 'mcp', 'servers'), path.join(root, 'mcp'), staging, path.join(root, 'tmp'), root, project, outside, base]) if (fs.existsSync(dir)) fs.rmdirSync(dir);
  });
  assert.match((await global.validateAndRegisterMcpInstall(project, root, result)).message, /profiles path is outside/);
  fs.unlinkSync(profiles); fs.mkdirSync(profiles);
  fs.writeFileSync(lock, 'not json');
  assert.match((await global.validateAndRegisterMcpInstall(project, root, result)).message, /invalid/);
  fs.writeFileSync(lock, JSON.stringify({ source: 'fixture/mcp' }));
  fs.writeFileSync(rogue, JSON.stringify(receipt));
  assert.match((await global.validateAndRegisterMcpInstall(project, root, rogue)).message, /was not created/);
  fs.writeFileSync(result, JSON.stringify({ ...receipt, mcpId: 'fixture/mcp' }));
  assert.match((await global.validateAndRegisterMcpInstall(project, root, result)).message, /missing mcpId/);
});

test('capability lifecycle prompts carry the exact user-authorized physical action', t => {
  const global = require('../out/solomapGlobal.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-action-contract-'));
  t.after(() => cleanupPromptFixture(root));
  const project = path.join(root, 'project');
  const data = path.join(root, '.solomap-global');
  const result = path.join(data, 'tmp', 'operation', 'result.json');
  const skillUpgrade = global.buildSkillInstallPrompt('/source/skill', project, data, result, 'fixture-skill');
  const mcpUpgrade = global.buildMcpInstallPrompt('/source/mcp', project, data, result, 'fixture-mcp');
  for (const prompt of [skillUpgrade, mcpUpgrade]) {
    assert.match(prompt, /用户已在 SoloMap 界面明确请求更新/);
    assert.match(prompt, /完整候选只能写入/);
    assert.match(prompt, /宿主.*原子/);
    assert.match(prompt, /不得直接修改正式目录/);
    assert.match(prompt, /同级其他能力/);
  }
  const skillUninstall = global.buildCapabilityUninstallPrompt('skill', 'fixture-skill', path.join(data, 'skills', 'installed', 'fixture-skill'), result);
  for (const prompt of [skillUninstall]) {
    assert.match(prompt, /用户已在 SoloMap 界面明确请求卸载/);
    assert.match(prompt, /只核对并记录.*完整物理清单/);
    assert.match(prompt, /不得删除、移动或修改/);
  }
});

test('retired execution enhancements are absent from the plugin capability surface', () => {
  const global = require('../out/solomapGlobal.js');
  assert.equal(global.BUILTIN_SOLOMAP_ENHANCEMENTS, undefined);
  assert.equal(global.buildEnhancementInstallPrompt, undefined);
  assert.equal(global.ensureSolomapEnhancementRuntime, undefined);
  assert.equal(global.BUILTIN_SOLOMAP_SKILLS.some(skill => skill.id === 'solomap-enhancement-installer'), false);
  const actions = fs.readFileSync(path.join(__dirname, '..', 'src', 'pluginActions.ts'), 'utf8');
  const runner = fs.readFileSync(path.join(__dirname, '..', 'src', 'runAgentProcess.ts'), 'utf8');
  const lifecycle = fs.readFileSync(path.join(__dirname, '..', 'src', 'runLifecycleTypes.ts'), 'utf8');
  assert.doesNotMatch(actions, /ability\.(?:install|check|setEnabled|uninstall)Enhancement/);
  assert.doesNotMatch(runner, /enhancementEnvLines|enhancementPreflightLines/);
  assert.doesNotMatch(lifecycle, /enhancement_(?:install|uninstall)/);
});

test('capability uninstall validates the exact target receipt before committing the registry state', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-uninstall-boundary-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project');
  const resultDir = path.join(root, 'tmp', 'uninstall'), resultPath = path.join(resultDir, 'result.json');
  const installedPath = path.join(root, 'skills', 'installed', 'fixture-skill');
  const packagePath = path.join(installedPath, 'package'), entryPath = path.join(packagePath, 'SKILL.md');
  fs.mkdirSync(project); fs.mkdirSync(resultDir, { recursive: true }); fs.mkdirSync(packagePath, { recursive: true }); fs.writeFileSync(entryPath, '# Fixture\n');
  const store = new UnifiedDataStore(root), operations = createRuntimeDataOperations(store);
  store.patchCapabilityRegistry({ kind: 'skill', entry: { id: 'fixture-skill', title: 'Fixture', status: 'installed', enabled: true }, expectedRevision: 0, idempotencyKey: 'uninstall-fixture' });
  const operationId = crypto.randomUUID();
  store.beginCapabilityOperation({ operationId, kind: 'skill', action: 'uninstall', targetId: 'fixture-skill', requestKey: 'uninstall-exact-target' });
  store.attachCapabilityOperation({ operationId, resultPath });
  fs.writeFileSync(resultPath, JSON.stringify({ ok: true, skillId: 'fixture-skill', inventoryPaths: [installedPath, packagePath, entryPath] }));
  const transport = require('../out/autonomousRuntimeControl.js'), previous = transport.sendRuntimeDataRequest;
  let rejectCommit = true;
  transport.sendRuntimeDataRequest = (resolved, request) => {
    assert.equal(resolved, root);
    if (rejectCommit && request.operation === 'complete_capability_operation') { rejectCommit = false; throw new Error('fixture_transient_commit_failure'); }
    return operations(request);
  };
  t.after(async () => {
    transport.sendRuntimeDataRequest = previous; await operations.close(); store.close();
    fs.unlinkSync(resultPath); fs.rmdirSync(resultDir); fs.rmdirSync(path.join(root, 'tmp'));
    fs.unlinkSync(path.join(root, 'solomap.db'));
    fs.rmdirSync(path.join(root, 'skills', 'installed')); fs.rmdirSync(path.join(root, 'skills'));
    fs.rmdirSync(root);
    fs.rmdirSync(project); fs.rmdirSync(base);
  });
  const global = require('../out/solomapGlobal.js');
  await global.prepareCapabilityOperationFilesystemBaseline(root, operationId);
  await assert.rejects(global.validateAndRegisterCapabilityUninstall(project, root, 'skill', 'fixture-skill', installedPath, resultPath, operationId), /fixture_transient_commit_failure/);
  assert.equal(fs.readFileSync(entryPath, 'utf8'), '# Fixture\n');
  const accepted = await global.validateAndRegisterCapabilityUninstall(project, root, 'skill', 'fixture-skill', installedPath, resultPath, operationId);
  assert.equal(accepted.ok, true);
  assert.equal(fs.existsSync(installedPath), false);
  assert.equal(store.readCapabilityRegistry({ kind: 'skill' }).entries[0].entry.status, 'uninstalled');
  assert.equal(store.readCapabilityOperations({ activeOnly: true }).length, 0);
});

test('pasted internal images use database assets with complete pageable bytes and no project attachment writer', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-internal-asset-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root), operations = createRuntimeDataOperations(store);
  const transport = require('../out/autonomousRuntimeControl.js'), previous = transport.sendRuntimeDataRequest;
  transport.sendRuntimeDataRequest = (resolved, request) => { assert.equal(resolved, root); return operations(request); };
  t.after(async () => {
    transport.sendRuntimeDataRequest = previous; await operations.close(); store.close();
    fs.unlinkSync(path.join(root, 'solomap.db')); fs.rmdirSync(root);
    fs.unlinkSync(path.join(project, '.solopreneur', 'project.json')); fs.rmdirSync(path.join(project, '.solopreneur'));
    fs.rmdirSync(project); fs.rmdirSync(base);
  });
  const attachments = require('../out/attachments.js');
  const bytes = Buffer.from('完整内部图片🌿'.repeat(30000));
  const [ref] = await attachments.savePastedImageAttachmentsAsync(project, 'solo', [{ mimeType: 'image/png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }], root);
  assert.match(ref, /^solomap:\/\/asset\/[a-f0-9-]{36}$/);
  assert.deepEqual(attachments.filterProjectRelativeFiles(project, [ref]), [ref]);
  assert.equal(fs.existsSync(path.join(project, '.solopreneur', 'attachments')), false);
  const assetId = ref.split('/').pop();
  const first = await operations({ operation: 'read_internal_attachment', input: { root: project, assetId, limit: 65536 } });
  const second = await operations({ operation: 'read_internal_attachment', input: { root: project, assetId, offset: first.nextOffset, limit: 1024 * 1024 } });
  assert.ok(Buffer.concat([Buffer.from(first.bytes, 'base64'), Buffer.from(second.bytes, 'base64')]).equals(bytes));
  assert.equal(second.nextOffset, null);
  const throughUri = await operations({ operation: 'read', input: { ref, view: 'content', limit: 65536 } });
  assert.equal(throughUri.sha256, first.sha256);
});
