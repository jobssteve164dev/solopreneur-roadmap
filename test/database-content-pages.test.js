const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');

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

test('paged reads reconstruct every original byte and keep the same revision while newer writes commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-content-pages-'));
  const store = new UnifiedDataStore(root);
  const call = createRuntimeDataOperations(store);
  try {
    const project = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'project', data: { name: 'pages' } }).objectId;
    const original = Buffer.from('日志全文🙂\r\n'.repeat(10000));
    const memory = store.write({ kind: 'memory', action: 'create', scope: project, idempotencyKey: 'memory', data: { category: 'inbox', title: 'pages', status: 'captured', content: original.toString('utf8') } });
    const first = await call({ operation: 'read', input: { ref: memory.objectId, view: 'content', limit: 1001 } });
    assert.equal(first.encoding, 'base64', 'content page protocol is missing');
    assert.equal(first.revision, 1);
    assert.equal(first.sha256, crypto.createHash('sha256').update(original).digest('hex'));
    store.write({ kind: 'memory', action: 'patch', scope: project, objectId: memory.objectId, expectedRevision: 1, idempotencyKey: 'new-version', data: { content: 'new body' } });
    const chunks = [Buffer.from(first.data, 'base64')];
    let cursor = first.cursor;
    while (cursor) {
      const page = await call({ operation: 'read', input: { ref: memory.objectId, view: 'content', cursor, limit: 1001 } });
      assert.equal(page.revision, 1);
      assert.equal(page.byteOffset, chunks.reduce((total, chunk) => total + chunk.length, 0));
      chunks.push(Buffer.from(page.data, 'base64'));
      cursor = page.cursor;
    }
    assert.deepEqual(Buffer.concat(chunks), original);
    assert.equal(store.read(memory.objectId).data.content, 'new body');
    const metadata = await call({ operation: 'read', input: { ref: memory.objectId, view: 'metadata' } });
    assert.equal(metadata.data.content, undefined);
    assert.equal(metadata.revision, 2);
  } finally { store.close(); cleanupExact(root); }
});

test('a page reads and validates only the relevant independently verifiable content chunks', () => {
  const { DatabaseSync } = require('node:sqlite');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-page-work-'));
  const store = new UnifiedDataStore(root);
  const db = new DatabaseSync(store.filePath);
  try {
    const bytes = crypto.randomBytes(2 * 1024 * 1024);
    const object = store.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'large-binary', data: { category: 'inbox', title: 'large binary', status: 'captured', content: { encoding: 'base64', data: bytes.toString('base64') } } });
    const contentId = store.readMetadata(object.objectId).data.content_id;
    const row = db.prepare('SELECT * FROM contents WHERE id=?').get(contentId);
    assert.ok(row.chunk_index_json, 'large content has no bounded-read chunk index');
    const index = JSON.parse(row.chunk_index_json);
    assert.ok(index.length > 1);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='content_chunks'").get(), 'payload chunks must be separate physical rows');
    const sizes = db.prepare('SELECT max(length(data)) AS maximum,sum(length(data)) AS total FROM content_chunks WHERE content_id=?').get(contentId);
    assert.ok(sizes.maximum <= 65536, 'page lookup must not load a whole large BLOB');
    assert.equal(sizes.total, row.stored_byte_length);
    const corrupted = Buffer.from(db.prepare('SELECT data FROM content_chunks WHERE content_id=? AND ordinal=1').get(contentId).data);
    corrupted[0] ^= 1;
    db.prepare('UPDATE content_chunks SET data=? WHERE content_id=? AND ordinal=1').run(corrupted, contentId);
    const first = store.readPage({ ref: object.objectId, limit: 1000 });
    assert.deepEqual(Buffer.from(first.data, 'base64'), bytes.subarray(0, 1000));
    assert.throws(() => store.read(object.objectId), /content_integrity_error/);
    assert.throws(() => store.readPage({ ref: object.objectId, limit: 100000 }), /content_integrity_error/);
  } finally { db.close(); store.close(); cleanupExact(root); }
});

test('an authoritative identical write repairs corrupted deduplicated content', () => {
  const { DatabaseSync } = require('node:sqlite');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-content-repair-'));
  const store = new UnifiedDataStore(root); const db = new DatabaseSync(store.filePath);
  try {
    const bytes = crypto.randomBytes(192 * 1024);
    const project = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'content-repair-project', data: { name: 'content repair' } }).objectId;
    store.writeHistoricalRunArtifact(project, { executionLogId: 1, relativePath: '__solo__/1/output.log', bytes: bytes.toString('base64'), hash: crypto.createHash('sha256').update(bytes).digest('hex') }, 'output');
    const contentId = db.prepare('SELECT content_id FROM project_run_artifacts WHERE execution_log_id=1').get().content_id;
    db.prepare('DELETE FROM content_chunks WHERE content_id=? AND ordinal=1').run(contentId);
    assert.throws(() => store.readRunArtifact(project, 1, '__solo__/1/output.log'), /content_integrity_error/);
    const materialize = store.content;
    store.content = () => { throw new Error('full_content_materialization'); };
    assert.doesNotThrow(() => store.writeHistoricalRunArtifact(project, { executionLogId: 1, relativePath: '__solo__/1/output.log', bytes, hash: crypto.createHash('sha256').update(bytes).digest('hex') }, 'output'));
    store.content = materialize;
    assert.deepEqual(Buffer.from(store.readRunArtifact(project, 1, '__solo__/1/output.log').bytes, 'base64'), bytes);
  } finally { db.close(); store.close(); cleanupExact(root); }
});

test('an unchanged migration source repairs its corrupted captured content', () => {
  const { DatabaseSync } = require('node:sqlite');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-source-repair-'));
  const store = new UnifiedDataStore(root);
  const db = new DatabaseSync(store.filePath);
  try {
    const bytes = crypto.randomBytes(2 * 1024 * 1024);
    const source = { identity: 'agent-runs:/workspace/project', key: '__solo__/1/output.log', hash: crypto.createHash('sha256').update(bytes).digest('hex') };
    store.captureMigrationSource(source, bytes, { mimeType: 'application/octet-stream', encoding: 'binary', sourceKind: 'output' });
    const contentId = db.prepare('SELECT source_content_id FROM migration_items WHERE source_identity=? AND source_key=?').get(source.identity, source.key).source_content_id;
    db.prepare('DELETE FROM content_chunks WHERE content_id=? AND ordinal=1').run(contentId);
    assert.throws(() => store.readMigrationSource(source.identity, source.key), /content_integrity_error/);
    assert.equal(store.captureMigrationSource(source, bytes, { mimeType: 'application/octet-stream', encoding: 'binary', sourceKind: 'output' }).unchanged, true);
    assert.deepEqual(store.readMigrationSource(source.identity, source.key).bytes, bytes);
  } finally { db.close(); store.close(); cleanupExact(root); }
});
