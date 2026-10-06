const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function open() {
  const modulePath = path.join(__dirname, '../out/db/unifiedDataStore.js');
  assert.ok(fs.existsSync(modulePath), 'the unified domain store is not implemented');
  const { UnifiedDataStore } = require(modulePath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-unified-'));
  return { root, store: new UnifiedDataStore(root) };
}

test('all project and global objects share typed, revisioned, immediately readable storage', () => {
  const { root, store } = open();
  try {
    const project = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'project', data: { name: 'first', type: 'app' } });
    const memory = store.write({ kind: 'memory', action: 'create', scope: project.objectId, idempotencyKey: 'memory', data: { category: 'project', title: '目标', status: 'verified', confidence: 1, content: '完整目标正文' } });
    const reader = new (require('../out/db/unifiedDataStore.js').UnifiedDataStore)(root);
    try {
      assert.equal(reader.read(memory.objectId).data.content, '完整目标正文');
      assert.equal(reader.read(memory.objectId).projectId, project.objectId);
      assert.deepEqual(store.write({ kind: 'memory', action: 'create', scope: project.objectId, idempotencyKey: 'memory', data: { category: 'project', title: '目标', status: 'verified', confidence: 1, content: '完整目标正文' } }), memory);
      assert.throws(() => store.write({ kind: 'memory', action: 'patch', objectId: memory.objectId, scope: project.objectId, expectedRevision: 0, idempotencyKey: 'late', data: { title: '过期修改' } }), /revision_conflict/);
      const patched = store.write({ kind: 'memory', action: 'patch', objectId: memory.objectId, scope: project.objectId, expectedRevision: 1, idempotencyKey: 'patch', data: { content: '更新正文' } });
      assert.equal(patched.revision, 2);
      assert.equal(reader.read(memory.objectId).data.content, '更新正文');
      assert.equal(reader.read(memory.objectId, 1).data.content, '完整目标正文');
      assert.equal(reader.read(memory.objectId).data.title, '目标');
      assert.throws(() => store.write({ kind: 'memory', action: 'create', scope: project.objectId, idempotencyKey: 'memory', data: { title: 'another' } }), /idempotency_conflict/);
      assert.equal(reader.search({ scope: project.objectId, query: '更新正文', kinds: ['memory'] }).items[0].objectId, memory.objectId);
      assert.deepEqual(fs.readdirSync(root).filter(name => !name.startsWith('solomap.db')), []);
    } finally { reader.close(); }
  } finally { store.close(); }
});

test('rollback, scope isolation, content integrity, backup and reopen preserve full bodies', async () => {
  const { root, store } = open();
  try {
    const first = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'first', data: { name: 'first' } });
    const second = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'second', data: { name: 'second' } });
    const body = '你好\n'.repeat(50000);
    const item = store.write({ kind: 'memory', action: 'create', scope: first.objectId, idempotencyKey: 'large', data: { category: 'project', title: 'large', status: 'verified', confidence: 1, content: body } });
    assert.throws(() => store.write({ kind: 'memory', action: 'patch', scope: second.objectId, objectId: item.objectId, expectedRevision: 1, idempotencyKey: 'cross-project', data: { title: 'wrong' } }), /scope_mismatch/);
    assert.throws(() => store.write({ kind: 'memory', action: 'patch', scope: first.objectId, objectId: item.objectId, expectedRevision: 1, idempotencyKey: 'invalid', data: { confidence: 2 } }), /constraint/i);
    assert.equal(store.read(item.objectId).revision, 1);
    assert.equal(store.read(item.objectId).data.content, body);
    assert.deepEqual(store.search({ scope: second.objectId, query: '你好' }).items, []);
    const destination = path.join(root, 'exports', 'backup.db');
    await store.backup(destination);
    const { DatabaseSync } = require('node:sqlite');
    const backup = new DatabaseSync(destination, { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(backup.prepare('SELECT count(*) AS n FROM objects').get().n, 3);
      assert.equal(backup.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 8);
    } finally { backup.close(); }
  } finally { store.close(); }
});

test('binary attachments retain exact bytes', () => {
  const { root, store } = open();
  try {
    const project = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'p', data: { name: 'binary' } });
    const bytes = Buffer.from([0, 255, 128, 10, 13, 42]);
    const asset = store.write({ kind: 'asset', action: 'create', scope: project.objectId, idempotencyKey: 'asset', data: { name: 'attachment.bin', origin: 'message', content: { encoding: 'base64', data: bytes.toString('base64'), mimeType: 'application/octet-stream' } } });
    const content = store.read(asset.objectId).data.content;
    assert.equal(content.encoding, 'base64');
    assert.deepEqual(Buffer.from(content.data, 'base64'), bytes);
  } finally { store.close(); }
});

test('export cannot follow a directory link outside exports', async () => {
  const { root, store } = open();
  try {
    const project = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'p', data: { name: 'export' } });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-export-outside-'));
    fs.mkdirSync(path.join(root, 'exports'));
    fs.symlinkSync(outside, path.join(root, 'exports/redirect'), 'dir');
    await assert.rejects(store.export({ ref: project.objectId, format: 'json', destination: path.join(root, 'exports/redirect/leak.json'), idempotencyKey: 'escape' }), /export_destination/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { store.close(); }
});

test('revision and audit records reuse full content without duplicating each body', () => {
  const { store } = open();
  try {
    const project = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'p', data: { name: 'retention' } });
    const content = '完整日志\n'.repeat(100000);
    const item = store.write({ kind: 'memory', action: 'create', scope: project.objectId, idempotencyKey: 'body', data: { category: 'project', title: 'initial', status: 'verified', content } });
    for (let revision = 1; revision < 4; revision++) store.write({ kind: 'memory', action: 'patch', objectId: item.objectId, scope: project.objectId, expectedRevision: revision, idempotencyKey: `edit-${revision}`, data: { title: `revision-${revision}` } });
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(store.filePath, { readOnly: true });
    try {
      const bytes = database.prepare('SELECT sum(byte_length) AS n FROM contents').get().n;
      assert.ok(bytes < Buffer.byteLength(content) + 20000, `stored ${bytes} bytes for one unchanged body`);
    } finally { database.close(); }
    for (let revision = 1; revision <= 4; revision++) assert.equal(store.read(item.objectId, revision).data.content, content);
  } finally { store.close(); }
});

test('large compressible bodies keep original hashes and full bytes with bounded disk storage', () => {
  const { store } = open();
  try {
    const project = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'p', data: { name: 'compression' } });
    const body = '原始日志不能截断\n'.repeat(200000);
    const item = store.write({ kind: 'memory', action: 'create', scope: project.objectId, idempotencyKey: 'compressed', data: { category: 'inbox', title: 'compressible', status: 'captured', content: body } });
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(store.filePath, { readOnly: true });
    try {
      const retained = database.prepare('SELECT sum(length(data)) AS n FROM contents').get().n;
      assert.ok(retained < Buffer.byteLength(body) / 10, `retained ${retained} stored bytes`);
      const contentId = store.read(item.objectId).data.content_id;
      const row = database.prepare('SELECT sha256,byte_length FROM contents WHERE id=?').get(contentId);
      assert.equal(row.byte_length, Buffer.byteLength(body));
      assert.equal(row.sha256, require('node:crypto').createHash('sha256').update(body).digest('hex'));
    } finally { database.close(); }
    assert.equal(store.read(item.objectId).data.content, body);
  } finally { store.close(); }
});
