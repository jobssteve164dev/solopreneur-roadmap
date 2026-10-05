const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');

test('opening a missing authority never creates an empty replacement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-missing-authority-'));
  assert.equal(typeof UnifiedDataStore.open, 'function', 'explicit open contract is missing');
  assert.throws(() => UnifiedDataStore.open(root), /database_restore_required/);
  assert.equal(fs.existsSync(path.join(root, 'solomap.db')), false);
});

test('a committed export recovers after restart without overwriting a conflicting user file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-outbox-'));
  let store = new UnifiedDataStore(root);
  const project = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'project', data: { name: 'recovery' } }).objectId;
  const memory = store.write({ kind: 'memory', action: 'create', scope: project, idempotencyKey: 'memory', data: { category: 'project', title: 'recovery', status: 'captured', content: 'durable full content' } });
  const destination = path.join(root, 'exports', 'content.txt');
  fs.mkdirSync(path.dirname(destination));
  fs.writeFileSync(destination, 'user file');
  await assert.rejects(store.export({ ref: memory.objectId, format: 'text', destination, idempotencyKey: 'export' }), /EEXIST/);
  store.close();
  store = new UnifiedDataStore(root);
  try {
    assert.equal(typeof store.recoverOutbox, 'function', 'restart recovery is missing');
    const blocked = await store.recoverOutbox();
    assert.equal(blocked.pending.length, 1);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'user file');
    fs.renameSync(destination, path.join(root, 'exports', 'user-file-preserved.txt'));
    const recovered = await store.recoverOutbox();
    assert.equal(recovered.pending.length, 0);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'durable full content');
    assert.equal((await store.recoverOutbox()).delivered, 0);
  } finally { store.close(); }
});

test('binary text export preserves the original bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-binary-export-'));
  const store = new UnifiedDataStore(root);
  try {
    const bytes = Buffer.from([0, 255, 128, 10]);
    const project = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'project', data: { name: 'binary' } }).objectId;
    const asset = store.write({ kind: 'asset', action: 'create', scope: project, idempotencyKey: 'asset', data: { name: 'bytes', content: { encoding: 'base64', data: bytes.toString('base64') } } });
    const destination = path.join(root, 'exports', 'original.bin');
    await store.export({ ref: asset.objectId, format: 'text', destination, idempotencyKey: 'export' });
    assert.deepEqual(fs.readFileSync(destination), bytes);
  } finally { store.close(); }
});
