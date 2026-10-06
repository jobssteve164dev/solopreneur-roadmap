const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');

test('structured legacy entries retain validity, revocation, provenance and explicit project scope', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-json-'));
  const sourceRoot = path.join(root, 'memory');
  fs.mkdirSync(path.join(sourceRoot, 'entries'), { recursive: true });
  const source = path.join(sourceRoot, 'entries', 'entry.json');
  const entry = { schemaVersion: 1, objectType: 'memory_entry', entryId: 'legacy-id', scopeId: 'memory_scope:project:original', layer: 'stable', kind: 'project_fact', status: 'invalidated', title: 'Original', content: 'complete original content', tags: ['source-tag'], revision: 2, validity: { validFrom: '2026-01-01T00:00:00Z', validUntil: '2026-09-01T00:00:00Z' }, provenance: { sourceType: 'agent', evidenceRefs: ['original-evidence'] }, metadata: { invalidation: { reason: 'old claim withdrawn' } }, supersedes: ['older-entry'] };
  const bytes = Buffer.from(JSON.stringify(entry, null, 2) + '\r\n');
  fs.writeFileSync(source, bytes);
  const store = new UnifiedDataStore(path.join(root, 'database'));
  try {
    const { importMemoryDirectory } = require('../out/memoryDatabaseMigration.js');
    const first = await importMemoryDirectory(store, sourceRoot);
    assert.equal(first.conflicts.length, 1, 'unknown project scope must retain raw source without global disclosure');
    assert.deepEqual(store.readMigrationSource(`memory:${fs.realpathSync(sourceRoot)}`, 'entries/entry.json').bytes, bytes);
    assert.equal(store.search({ scope: null, kinds: ['memory'] }).items.length, 0);
    const project = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'original-project', data: { name: 'Original project' } });
    const imported = await importMemoryDirectory(store, sourceRoot, { projectScopes: { original: project.objectId } });
    assert.equal(imported.imported, 1);
    const object = store.search({ scope: project.objectId, kinds: ['memory'] }).items[0];
    const data = store.read(object.objectId).data;
    assert.equal(data.status, 'invalidated');
    assert.equal(data.content, entry.content);
    assert.equal(data.legacy_entry_id, 'legacy-id');
    assert.equal(data.external_entry_revision, 2);
    assert.equal(data.valid_until, Date.parse(entry.validity.validUntil));
    assert.deepEqual(JSON.parse(data.provenance_json), entry.provenance);
    assert.deepEqual(JSON.parse(data.metadata_json), entry.metadata);
    assert.deepEqual(JSON.parse(data.tags_json), entry.tags);
    assert.deepEqual(JSON.parse(data.supersedes_json), entry.supersedes);
    assert.equal(store.context({ project: project.objectId }).items.length, 0, 'withdrawn sources must not enter active context');
    assert.equal((await importMemoryDirectory(store, sourceRoot, { projectScopes: { original: project.objectId } })).unchanged, 1);
  } finally { store.close(); }
});

test('context applies both ends of imported validity and keeps withdrawn records readable as history', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-validity-'));
  const memory = path.join(root, 'memory');
  fs.mkdirSync(path.join(memory, 'entries'), { recursive: true });
  const now = Date.now();
  const entries = [
    { title: 'current', status: 'active', validity: { validFrom: new Date(now - 60000).toISOString(), validUntil: new Date(now + 60000).toISOString() } },
    { title: 'future', status: 'active', validity: { validFrom: new Date(now + 60000).toISOString(), validUntil: null } },
    { title: 'expired', status: 'active', validity: { validFrom: new Date(now - 120000).toISOString(), validUntil: new Date(now - 60000).toISOString() } },
    { title: 'withdrawn', status: 'invalidated', validity: { validFrom: null, validUntil: null } }
  ];
  for (const entry of entries) fs.writeFileSync(path.join(memory, 'entries', entry.title + '.json'), JSON.stringify({ schemaVersion: 1, objectType: 'memory_entry', entryId: entry.title, scopeId: 'memory_scope:global', kind: 'rules', content: entry.title, revision: 1, ...entry }));
  const store = new UnifiedDataStore(path.join(root, 'database'));
  try {
    const { importMemoryDirectory } = require('../out/memoryDatabaseMigration.js');
    assert.equal((await importMemoryDirectory(store, memory)).imported, 4);
    const project = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'context-project', data: { name: 'Context project' } });
    assert.deepEqual(store.context({ project: project.objectId }).items.map(item => item.data.title), ['current']);
    assert.equal(store.search({ scope: null, kinds: ['memory'] }).items.length, 4, 'validity filtering must preserve history');
  } finally { store.close(); }
});

test('memory migration preserves full source bytes, repeats without new writes, and retains old revisions', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-import-'));
  const root = path.join(fixture, '.solomap-global');
  const memoryRoot = path.join(root, 'memory');
  fs.mkdirSync(path.join(memoryRoot, 'domains'), { recursive: true });
  const source = path.join(memoryRoot, 'domains', 'data.md');
  const original = '# 数据\r\n完整正文🙂\r\n'.repeat(4000);
  fs.writeFileSync(source, original);
  const store = new UnifiedDataStore(root);
  const native = new DatabaseSync(store.filePath);
  try {
    let module;
    try { module = require('../out/memoryDatabaseMigration.js'); } catch { /* Assert the missing feature before requiring it. */ }
    assert.ok(module, 'official memory importer is missing');
    const first = await module.importMemoryDirectory(store, memoryRoot);
    assert.equal(first.imported, 1);
    const memory = store.search({ scope: null, kinds: ['memory'] }).items[0];
    assert.equal(store.read(memory.objectId).data.content, original);
    const before = native.prepare('SELECT COUNT(*) AS count FROM events').get().count;
    assert.equal((await module.importMemoryDirectory(store, memoryRoot)).unchanged, 1);
    assert.equal(native.prepare('SELECT COUNT(*) AS count FROM events').get().count, before);
    fs.writeFileSync(source, original + '新正文');
    const changed = await module.importMemoryDirectory(store, memoryRoot);
    assert.equal(changed.imported, 1);
    assert.equal(store.read(memory.objectId).revision, 2);
    assert.equal(store.read(memory.objectId, 1).data.content, original);
    assert.equal(store.read(memory.objectId).data.content, original + '新正文');
    assert.equal(native.prepare('SELECT COUNT(*) AS count FROM migration_items').get().count, 1);
    assert.equal(fs.readFileSync(source, 'utf8'), original + '新正文');
    assert.deepEqual(fs.readdirSync(memoryRoot), ['domains']);
  } finally { native.close(); store.close(); }
});

test('a changed legacy memory cannot overwrite a newer database edit', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-conflict-'));
  const memoryRoot = path.join(fixture, 'memory');
  fs.mkdirSync(memoryRoot);
  const source = path.join(memoryRoot, 'profile.md');
  fs.writeFileSync(source, 'old memory');
  const store = new UnifiedDataStore(path.join(fixture, '.solomap-global'));
  try {
    let module;
    try { module = require('../out/memoryDatabaseMigration.js'); } catch {}
    assert.ok(module, 'official memory importer is missing');
    await module.importMemoryDirectory(store, memoryRoot);
    const memory = store.search({ scope: null, kinds: ['memory'] }).items[0];
    store.write({ kind: 'memory', action: 'patch', scope: null, objectId: memory.objectId, expectedRevision: 1, idempotencyKey: 'user-edit', data: { content: 'new database edit' } });
    fs.writeFileSync(source, 'late legacy write');
    const result = await module.importMemoryDirectory(store, memoryRoot);
    assert.equal(result.conflicts.length, 1);
    assert.equal(store.read(memory.objectId).data.content, 'new database edit');
    assert.equal(store.read(memory.objectId).revision, 2);
    const audit = new DatabaseSync(store.filePath, { readOnly: true });
    try {
      const count = audit.prepare('SELECT COUNT(*) AS n FROM events').get().n;
      for (let retry = 0; retry < 3; retry++) assert.equal((await module.importMemoryDirectory(store, memoryRoot)).conflicts.length, 1);
      assert.equal(audit.prepare('SELECT COUNT(*) AS n FROM events').get().n, count, 'unchanged conflict retries must not manufacture source transitions');
    } finally { audit.close(); }
  } finally { store.close(); }
});

test('project runtime artifacts nested in the memory tree are not misclassified as global memory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-source-boundary-'));
  const memoryRoot = path.join(root, 'memory');
  const artifact = path.join(memoryRoot, 'inbox', '.solopreneur', 'agent-runs', 'prompt.md');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, 'project-private agent prompt');
  const store = new UnifiedDataStore(path.join(root, '.solomap-global'));
  try {
    const { importMemoryDirectory } = require('../out/memoryDatabaseMigration.js');
    const result = await importMemoryDirectory(store, memoryRoot);
    assert.equal(result.imported, 0);
    assert.equal(store.search({ scope: null, kinds: ['memory'] }).items.length, 0);
    assert.equal(fs.readFileSync(artifact, 'utf8'), 'project-private agent prompt');
  } finally { store.close(); }
});

test('a source can return to an earlier content version without colliding with its first import', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-revert-'));
  const memoryRoot = path.join(fixture, 'memory');
  fs.mkdirSync(memoryRoot);
  const source = path.join(memoryRoot, 'profile.md');
  const store = new UnifiedDataStore(path.join(fixture, '.solomap-global'));
  try {
    const { importMemoryDirectory } = require('../out/memoryDatabaseMigration.js');
    for (const content of ['A', 'B', 'A']) {
      fs.writeFileSync(source, content);
      const result = await importMemoryDirectory(store, memoryRoot);
      assert.equal(result.imported, 1);
      assert.deepEqual(result.conflicts, []);
      const object = store.search({ scope: null, kinds: ['memory'] }).items[0];
      assert.equal(store.read(object.objectId).data.content, content);
    }
    const object = store.search({ scope: null, kinds: ['memory'] }).items[0];
    assert.equal(object.revision, 3);
    assert.equal((await importMemoryDirectory(store, memoryRoot)).unchanged, 1);
  } finally { store.close(); }
});

test('unmapped project memory is preserved in the database without becoming global memory, then resolves to its project', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-unmapped-'));
  const sourceRoot = path.join(fixture, 'memory');
  fs.mkdirSync(path.join(sourceRoot, 'projects'), { recursive: true });
  const source = path.join(sourceRoot, 'projects', 'unknown.md');
  const bytes = Buffer.from('# 原项目\r\n只有该项目应看到的完整内容🙂\r\n');
  fs.writeFileSync(source, bytes);
  const store = new UnifiedDataStore(path.join(fixture, '.solomap-global'));
  const db = new DatabaseSync(store.filePath, { readOnly: true });
  try {
    const { importMemoryDirectory } = require('../out/memoryDatabaseMigration.js');
    const first = await importMemoryDirectory(store, sourceRoot, { sourceIdentity: 'legacy-memory' });
    assert.equal(first.conflicts.length, 1);
    assert.equal(store.search({ scope: null, kinds: ['memory'] }).items.length, 0);
    const item = db.prepare('SELECT * FROM migration_items WHERE source_identity=? AND source_key=?').get('legacy-memory', 'projects/unknown.md');
    assert.ok(item?.source_content_id, 'unmapped original bytes must be retained in the database');
    assert.equal(item.object_id, null);
    assert.equal(item.stage, 'unmapped');
    assert.equal(item.error, 'project_scope_mapping_required');
    const preserved = store.readMigrationSource('legacy-memory', 'projects/unknown.md');
    assert.deepEqual(preserved.bytes, bytes);
    const before = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
    await importMemoryDirectory(store, sourceRoot, { sourceIdentity: 'legacy-memory' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, before);
    const project = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'project', data: { name: 'actual project' } }).objectId;
    const resolved = await importMemoryDirectory(store, sourceRoot, { sourceIdentity: 'legacy-memory', projectScopes: { unknown: project } });
    assert.equal(resolved.imported, 1);
    assert.deepEqual(resolved.conflicts, []);
    assert.equal(store.search({ scope: null, kinds: ['memory'] }).items.length, 0);
    const memory = store.search({ scope: project, kinds: ['memory'] }).items[0];
    assert.deepEqual(Buffer.from(store.read(memory.objectId).data.content), bytes);
    assert.equal(db.prepare('SELECT stage FROM migration_items WHERE source_identity=? AND source_key=?').get('legacy-memory', 'projects/unknown.md').stage, 'imported');
    const other = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'other-project', data: { name: 'different project' } }).objectId;
    const wronglyRemapped = await importMemoryDirectory(store, sourceRoot, { sourceIdentity: 'legacy-memory', projectScopes: { unknown: other } });
    assert.equal(wronglyRemapped.unchanged, 0, 'same bytes do not confirm a different project mapping');
    assert.equal(wronglyRemapped.conflicts.length, 1);
    assert.match(wronglyRemapped.conflicts[0].error, /source_binding_mismatch/);
    assert.equal(store.search({ scope: other, kinds: ['memory'] }).items.length, 0);
    assert.equal(store.read(memory.objectId).projectId, project);
    assert.equal(store.read(memory.objectId).revision, 1);
    const binding = db.prepare('SELECT * FROM migration_items WHERE source_identity=? AND source_key=?').get('legacy-memory', 'projects/unknown.md');
    assert.equal(binding.stage, 'conflict');
    assert.throws(() => store.importObject({ kind: 'lesson', action: 'create', scope: project, idempotencyKey: 'wrong-kind', data: {} }, { identity: 'legacy-memory', key: 'projects/unknown.md', hash: binding.source_hash }), /source_binding_mismatch/);
    assert.deepEqual(fs.readFileSync(source), bytes);
  } finally { db.close(); store.close(); }
});

test('an unchanged captured source keeps its committed receipt when another host resumes migration', () => {
  const crypto = require('node:crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-source-owner-'));
  const first = new UnifiedDataStore(root, 'first-migration-host');
  let second;
  try {
    const bytes = Buffer.from('完整来源');
    const source = { identity: 'legacy-source', key: 'unmapped.md', hash: crypto.createHash('sha256').update(bytes).digest('hex') };
    const receipt = first.captureMigrationSource(source, bytes);
    second = new UnifiedDataStore(root, 'second-migration-host');
    const replay = second.captureMigrationSource(source, bytes);
    assert.equal(replay.unchanged, true);
    assert.equal(replay.requestId, receipt.requestId);
    assert.equal(replay.committedSequence, receipt.committedSequence);
    assert.deepEqual(second.readMigrationSource(source.identity, source.key).bytes, bytes);
  } finally { second?.close(); first.close(); }
});
