const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  claimDueScheduledTaskDatabase,
  completeScheduledTaskDatabase,
  failScheduledTaskDatabase,
  readScheduledTaskDatabase,
  syncScheduledTaskDatabase
} = require('../out/scheduledTaskLedger.js');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');

function fixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, 'project');
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(workspace);
  const store = new UnifiedDataStore(globalRoot);
  const operations = createRuntimeDataOperations(store);
  const call = (operation, input) => operations({ operation, input });
  t.after(async () => {
    await operations.close(); store.close();
    const unlinkOwned = file => { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
    unlinkOwned(path.join(globalRoot, 'solomap.db-wal'));
    unlinkOwned(path.join(globalRoot, 'solomap.db-shm'));
    unlinkOwned(path.join(globalRoot, 'solomap.db'));
    fs.rmdirSync(globalRoot); fs.rmdirSync(workspace); fs.rmdirSync(root);
  });
  return { workspace, globalRoot, call };
}

test('scheduled task database persists, leases, retries and completes one-time occurrences', async t => {
  const f = fixture(t, 'solomap-scheduled-database-');
  const now = new Date('2026-07-23T10:00:00.000Z');
  const task = { id: 'once-1', title: 'Prepare release', enabled: true, projectPath: f.workspace, scheduleKind: 'once', scheduledAt: '2026-07-23T09:59:00.000Z', timeOfDay: '09:59', assignee: 'agent', prompt: 'Prepare the release.' };
  const ledger = await syncScheduledTaskDatabase(f.workspace, f.globalRoot, [task], now, f.call);
  assert.equal(ledger.tasks.length, 1);
  assert.equal(fs.existsSync(path.join(f.globalRoot, 'scheduled-tasks', 'scheduled-tasks.json')), false);
  const claimed = await claimDueScheduledTaskDatabase(f.workspace, f.globalRoot, 'window-a', now, f.call);
  assert.equal(claimed.length, 1);
  assert.equal((await claimDueScheduledTaskDatabase(f.workspace, f.globalRoot, 'window-b', now, f.call)).length, 0);
  assert.equal(await failScheduledTaskDatabase(f.workspace, f.globalRoot, claimed[0], now, f.call), 'retrying');
  assert.equal((await claimDueScheduledTaskDatabase(f.workspace, f.globalRoot, 'window-b', new Date(now.getTime() + 30_000), f.call)).length, 0);
  const retried = await claimDueScheduledTaskDatabase(f.workspace, f.globalRoot, 'window-b', new Date(now.getTime() + 60_000), f.call);
  assert.equal(retried.length, 1);
  await completeScheduledTaskDatabase(f.workspace, f.globalRoot, retried[0], f.call);
  assert.equal((await readScheduledTaskDatabase(f.workspace, f.globalRoot, f.call)).tasks.length, 0);
});

test('scheduled task database stops retrying after three failed leases', async t => {
  const f = fixture(t, 'solomap-scheduled-failure-');
  const task = { id: 'failing-1', enabled: true, scheduleKind: 'once', scheduledAt: '2026-07-23T09:00:00.000Z', assignee: 'agent', prompt: 'Run.' };
  let now = new Date('2026-07-23T10:00:00.000Z');
  await syncScheduledTaskDatabase(f.workspace, f.globalRoot, [task], now, f.call);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimed = await claimDueScheduledTaskDatabase(f.workspace, f.globalRoot, 'window-a', now, f.call);
    assert.equal(claimed.length, 1);
    assert.equal(await failScheduledTaskDatabase(f.workspace, f.globalRoot, claimed[0], now, f.call), attempt === 3 ? 'failed' : 'retrying');
    now = new Date(now.getTime() + attempt * 60_000);
  }
  const ledger = await readScheduledTaskDatabase(f.workspace, f.globalRoot, f.call);
  assert.equal(ledger.tasks.length, 0); assert.equal(ledger.failures.length, 1);
});

test('scheduled task database creates exactly one next daily occurrence after completion', async t => {
  const f = fixture(t, 'solomap-scheduled-daily-');
  const task = { id: 'daily-1', enabled: true, scheduleKind: 'daily', timeOfDay: '09:00', assignee: 'user', prompt: '' };
  await syncScheduledTaskDatabase(f.workspace, f.globalRoot, [task], new Date('2026-07-23T08:00:00.000Z'), f.call);
  const claimed = await claimDueScheduledTaskDatabase(f.workspace, f.globalRoot, 'window-a', new Date('2026-07-23T09:01:00.000Z'), f.call);
  assert.equal(claimed.length, 1);
  await completeScheduledTaskDatabase(f.workspace, f.globalRoot, claimed[0], f.call);
  const ledger = await readScheduledTaskDatabase(f.workspace, f.globalRoot, f.call);
  assert.equal(ledger.tasks.length, 1); assert.equal(ledger.tasks[0].taskId, task.id);
  assert.notEqual(ledger.tasks[0].occurrenceId, claimed[0].occurrenceId);
  assert.ok(Date.parse(ledger.tasks[0].dueAt) > Date.parse(claimed[0].dueAt));
});
