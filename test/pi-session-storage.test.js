const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');

function cleanupExact(root) {
  if (!fs.existsSync(root)) return;
  const directories = [root], files = [];
  const visit = directory => fs.readdirSync(directory).forEach(name => {
    const target = path.join(directory, name), stat = fs.lstatSync(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) { directories.push(target); visit(target); }
    else files.push(target);
  });
  visit(root); files.forEach(file => fs.unlinkSync(file));
  directories.sort((left, right) => right.length - left.length).forEach(directory => fs.rmdirSync(directory));
}

test('Pi session storage atomically persists mixed writes and survives reopening', async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-storage-'));
  t.after(() => cleanupExact(fixture));
  const sessionId = 'pi-storage-session';
  let database = new UnifiedDataStore(fixture);
  assert.equal(typeof database.createPiSessionStorage, 'function', 'UnifiedDataStore must expose the Pi Storage boundary');
  let storage = database.createPiSessionStorage(sessionId);
  const usage = {
    input: 2, output: 3, cacheRead: 1, cacheWrite: 1, totalTokens: 5,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.01, total: 0.32 }
  };
  const committed = await storage.commit([
    { kind: 'entry', entry: { id: 'entry-1', parentId: null, type: 'message', message: { role: 'user', content: 'hello', timestamp: 1 } } },
    { kind: 'value', op: 'set', namespace: 'test', key: 'name', value: 'durable' },
    { kind: 'usage', row: { id: 'usage-1', usage, adjustment: false, entryId: 'entry-1' } }
  ], {});
  assert.equal(committed.seqs.length, 3);
  await storage.close({});
  database.close();

  database = UnifiedDataStore.open(fixture);
  storage = database.createPiSessionStorage(sessionId);
  const entries = await storage.getEntries(['entry-1'], {});
  assert.equal(entries.get('entry-1').message.content, 'hello');
  assert.equal((await storage.getValue({ kind: 'value', namespace: 'test', key: 'name' }, {})).value, 'durable');
  assert.deepEqual((await storage.getStats({})).usage, usage);
  await storage.close({});
  database.close();
});

test('Pi session storage refuses an unknown forward storage version', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-storage-version-'));
  t.after(() => cleanupExact(fixture));
  const database = new UnifiedDataStore(fixture);
  try {
    database.createPiSessionStorage('future-session');
    database.rows("UPDATE pi_sessions SET storage_version=2 WHERE session_id='future-session'");
    assert.throws(() => database.createPiSessionStorage('future-session'), /unsupported_pi_storage_version/);
  } finally { database.close(); }
});

test('Pi session storage satisfies the official Pi core Storage conformance suite', async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-conformance-'));
  t.after(() => cleanupExact(fixture));
  const { createStorageConformance } = await import('@earendil-works/pi-agent-core/harness/session/testing');
  let ordinal = 0;
  const cases = createStorageConformance(async () => {
    const root = path.join(fixture, String(ordinal++));
    const database = new UnifiedDataStore(root);
    const storage = database.createPiSessionStorage('conformance');
    return {
      storage,
      async [Symbol.asyncDispose]() {
        await storage.close({});
        database.close();
      }
    };
  });
  for (const item of cases) await t.test(`${item.group}: ${item.name}`, () => item.run());
});
