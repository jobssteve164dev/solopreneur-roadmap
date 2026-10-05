const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const test = require('node:test');
const { SqliteStore } = require('../out/db/sqliteStore.js');

function databasePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-concurrent-')), 'journal.db');
}

test('an already-open reader immediately sees another connection commit', async () => {
  const file = databasePath();
  const first = new SqliteStore(file, path.resolve(__dirname, '..'));
  const second = new SqliteStore(file, path.resolve(__dirname, '..'));
  await first.init();
  await second.init();
  try {
    const id = first.logExecution('first-project', 'codex', 'first command', '完整正文', 'Completed');
    assert.equal(second.getExecutionLogs('first-project')[0]?.output, '完整正文');
    second.logExecution('second-project', 'claude', 'second command', 'second output', 'Completed');
    assert.equal(first.getExecutionLogs('first-project')[0]?.id, id);
    assert.equal(first.getExecutionLogs('second-project')[0]?.output, 'second output');
  } finally {
    first.close();
    second.close();
  }
});

test('simultaneous processes keep every committed execution and distinct identity', async () => {
  const file = databasePath();
  const initial = new SqliteStore(file, path.resolve(__dirname, '..'));
  await initial.init();
  initial.close();
  const children = [];
  try {
    const workers = Array.from({ length: 4 }, (_, index) => {
      const child = fork(path.join(__dirname, 'fixtures', 'database-writer.cjs'), [file, String(index)], { silent: true });
      children.push(child);
      let errors = '';
      child.stderr.on('data', chunk => { errors += chunk; });
      return {
        ready: new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('message', resolve);
        }),
        done: new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', code => code === 0 ? resolve() : reject(new Error(errors || `writer exit ${code}`)));
        }),
        child
      };
    });
    await Promise.all(workers.map(worker => worker.ready));
    workers.forEach(worker => worker.child.send('write'));
    await Promise.all(workers.map(worker => worker.done));
    const reader = new SqliteStore(file, path.resolve(__dirname, '..'));
    await reader.init();
    try {
      const rows = Array.from({ length: 4 }, (_, i) => reader.getExecutionLogs(`project-${i}`)).flat();
      assert.equal(rows.length, 80, 'all four writers must retain all twenty commits');
      assert.equal(new Set(rows.map(row => row.id)).size, 80);
      assert.equal(new Set(rows.map(row => row.output)).size, 80);
    } finally { reader.close(); }
  } finally {
    children.forEach(child => { if (child.exitCode === null) child.kill(); });
  }
});

test('a rejected roadmap batch rolls back every change', async () => {
  const store = new SqliteStore(databasePath(), path.resolve(__dirname, '..'));
  await store.init();
  const node = { id: 'original', title: '原路线图', description: '', stage: '', dependencies: '', agentCli: 'codex', agentPrompt: '', status: 'Pending', createdAt: '', completedAt: '' };
  try {
    store.syncNodesFromList([node]);
    assert.throws(() => store.syncNodesFromList([{ ...node, id: 'new' }, { ...node, id: 'new' }]), /UNIQUE constraint/);
    assert.deepEqual(store.getAllNodes(), [node]);
  } finally { store.close(); }
});
