const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const test = require('node:test');
const { startRuntimeControlServer, sendRuntimeControlCommand } = require('../out/autonomousRuntimeControl.js');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');

function request(root, input, token) {
  const endpoint = JSON.parse(fs.readFileSync(path.join(root, 'runtime/control.json'), 'utf8'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(JSON.stringify({ token: token || endpoint.token, command: 'data', request: input }) + '\n'));
    socket.on('data', chunk => { response += chunk; });
    socket.once('error', reject);
    socket.once('end', () => resolve(JSON.parse(response)));
  });
}

test('parallel authenticated callers share one owner and immediately read committed revisions while autonomy is paused', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-data-service-')), '.solomap-global');
  const store = new UnifiedDataStore(root);
  const server = await startRuntimeControlServer({
    globalDataPath: root,
    runtimeId: 'data-owner',
    onCommand: command => ({ status: command === 'pause' ? 'paused' : 'running' }),
    onData: input => input.operation === 'write' ? store.write(input.input) : store.read(input.input.ref)
  });
  try {
    await sendRuntimeControlCommand(root, 'pause');
    const invalid = await request(root, { operation: 'write', input: {} }, 'bad');
    assert.equal(invalid.ok, false);
    const project = await request(root, { operation: 'write', input: { kind: 'project', action: 'create', scope: null, idempotencyKey: 'project', data: { name: 'live' } } });
    assert.equal(project.ok, true, project.error);
    const body = '完整日志\n'.repeat(20000);
    const writes = await Promise.all(Array.from({ length: 12 }, (_, i) => request(root, { operation: 'write', input: { kind: 'memory', action: 'create', scope: project.result.objectId, idempotencyKey: `memory-${i}`, data: { category: 'project', title: `memory-${i}`, status: 'verified', confidence: 1, content: i === 0 ? body : `body-${i}` } } })));
    assert.ok(writes.every(result => result.ok), JSON.stringify(writes));
    assert.equal(new Set(writes.map(result => result.result.committedSequence)).size, 12);
    const read = await request(root, { operation: 'read', input: { ref: writes[0].result.objectId } });
    assert.equal(read.result.data.content, body);
    const conflicts = await Promise.all(['one', 'two'].map(key => request(root, { operation: 'write', input: { kind: 'memory', action: 'patch', scope: project.result.objectId, objectId: writes[0].result.objectId, expectedRevision: 1, idempotencyKey: key, data: { title: key } } })));
    assert.equal(conflicts.filter(result => result.ok).length, 1);
    assert.match(conflicts.find(result => !result.ok).error, /revision_conflict/);
  } finally { await server.close(); store.close(); }
});

test('unauthenticated peers cannot stream an unbounded request into the owner', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-untrusted-stream-')), '.solomap-global');
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'untrusted', onCommand: () => ({ status: 'running' }) });
  const endpoint = JSON.parse(fs.readFileSync(path.join(root, 'runtime/control.json'), 'utf8'));
  const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
  socket.on('error', () => {}); socket.resume();
  try {
    await new Promise(resolve => socket.once('connect', resolve));
    const closed = new Promise(resolve => socket.once('close', () => resolve(true)));
    socket.write('{"token":"bad","request":"' + 'x'.repeat(1000000));
    assert.equal(await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve(false), 500))]), true);
  } finally { socket.destroy(); await server.close(); }
});

test('memory migration runs through the same owner while other projects keep writing and reading', async () => {
  const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
  const crypto = require('node:crypto');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-live-memory-import-'));
  const root = path.join(fixture, '.solomap-global');
  const sourceRoot = path.join(fixture, 'original-memory');
  fs.mkdirSync(path.join(sourceRoot, 'domains'), { recursive: true });
  const originals = new Map();
  for (let i = 0; i < 30; i++) {
    const name = path.join(sourceRoot, 'domains', `source-${String(i).padStart(2, '0')}.md`);
    const bytes = Buffer.from(`原始记忆 ${i}\r\n` + '完整内容并发迁移\r\n'.repeat(1000));
    fs.writeFileSync(name, bytes);
    originals.set(name, crypto.createHash('sha256').update(bytes).digest('hex'));
  }
  const store = new UnifiedDataStore(root);
  const dispatch = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'import-owner', onCommand: () => ({ status: 'paused' }), onData: dispatch });
  try {
    const project = await request(root, { operation: 'write', input: { kind: 'project', action: 'create', scope: null, idempotencyKey: 'other-project', data: { name: '另一个项目' } } });
    let importDone = false;
    const importing = request(root, { operation: 'import_memory', input: { sourceRoot } }).then(result => { importDone = true; return result; });
    let first;
    for (let i = 0; i < 100; i++) {
      first = await request(root, { operation: 'search', input: { scope: null, kinds: ['memory'], query: 'source-00', limit: 1 } });
      if (first.result?.items.length || importDone) break;
      await new Promise(resolve => setImmediate(resolve));
    }
    if (first.result?.items.length) {
      const write = await request(root, { operation: 'write', input: { kind: 'memory', action: 'create', scope: project.result.objectId, idempotencyKey: 'during-migration', data: { category: 'project', title: '即时写入', status: 'captured', confidence: 0, content: '其他项目即时回读' } } });
      assert.equal(write.ok, true, write.error);
      assert.equal(importDone, false, 'a write must commit before the directory import finishes');
      const read = await request(root, { operation: 'read', input: { ref: write.result.objectId } });
      assert.equal(read.result.data.content, '其他项目即时回读');
    }
    const migrated = await importing.then(result => result.ok ? result : Promise.reject(new Error(result.error)));
    assert.equal(migrated.result.imported, 30);
    assert.equal(migrated.result.conflicts.length, 0);
    assert.equal(first.result?.items.length, 1, 'the owner must accept queries between source commits');
    const repeated = await request(root, { operation: 'import_memory', input: { sourceRoot } });
    assert.equal(repeated.result.unchanged, 30);
    for (const [name, hash] of originals) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(name)).digest('hex'), hash);
    const mcp = await request(root, { operation: 'open_mcp_session', input: { projectId: project.result.objectId } });
    const denied = await request(root, { operation: 'import_memory', input: { sourceRoot }, sessionToken: mcp.result.sessionToken });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, 'action_denied');
  } finally { await server.close(); store.close(); }
});
