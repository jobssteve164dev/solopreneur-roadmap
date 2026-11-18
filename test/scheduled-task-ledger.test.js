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
const { createRuntimeDataOperations } = require('./runtime-data-fixture.cjs');

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
  return { workspace, globalRoot, call, store };
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

test('scheduled claim prepares complete bodies and keeps the original batch rollback', async t => {
  const f = fixture(t, 'solomap-scheduled-prepared-claim-');
  const now = new Date('2026-07-23T10:00:00.000Z');
  const prompt = '完整调度任务正文🌿'.repeat(14000);
  const task = { id: 'full-claim', enabled: true, scheduleKind: 'once', scheduledAt: '2026-07-23T09:00:00.000Z', assignee: 'agent', prompt };
  await syncScheduledTaskDatabase(f.workspace, f.globalRoot, [task], now, f.call);
  f.store.claimDueSchedules = () => { throw new Error('synchronous_schedule_claim_called'); };
  f.store.db.run("CREATE TEMP TRIGGER reject_schedule_claim BEFORE UPDATE OF claim_token ON scheduled_occurrences WHEN NEW.claim_token IS NOT NULL BEGIN SELECT RAISE(ABORT,'original_schedule_claim_sql'); END");
  const claim = () => claimDueScheduledTaskDatabase(f.workspace, f.globalRoot, 'prepared-window', now, f.call);
  await assert.rejects(claim(), /original_schedule_claim_sql/);
  assert.equal((await readScheduledTaskDatabase(f.workspace, f.globalRoot, f.call)).tasks[0].attempts, 0);
  f.store.db.run('DROP TRIGGER temp.reject_schedule_claim');
  const [actual] = await claim();
  assert.equal(actual.task.prompt === prompt, true);
  assert.equal(actual.attempts, 1);
  assert.equal(actual.generation, 1);
  assert.equal(typeof actual.token, 'string');
  assert.deepEqual(await claim(), []);
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

test('default claim lease starts at Native publication after preparation', async t => {
  const f = fixture(t, 'solomap-scheduled-claim-clock-');
  const now = new Date('2026-07-23T10:00:00.000Z');
  const task = { id: 'claim-clock', enabled: true, scheduleKind: 'once', scheduledAt: '2026-07-23T09:59:00.000Z', assignee: 'user' };
  await syncScheduledTaskDatabase(f.workspace, f.globalRoot, [task], now, f.call);
  const after = now.getTime() + 100;
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  const inspect = f.store.inspectProjectMigration.bind(f.store);
  f.store.inspectProjectMigration = async request => {
    const result = await inspect(request);
    if (request.kind === 'scheduleClaims') t.mock.timers.setTime(after);
    return result;
  };
  const owner = { id: 'first-window', pid: process.pid, birth: 'first-birth' };
  const result = await f.call('claim_due_schedules', { owner, leaseMs: 20 });
  assert.equal(result.items.length, 1);
  assert.equal(f.store.rows('SELECT lease_expires_at FROM scheduled_occurrences WHERE id=?', [result.items[0].occurrenceId])[0].lease_expires_at, after + 20);
  assert.deepEqual(await f.call('claim_due_schedules', { owner: { ...owner, id: 'second-window' }, leaseMs: 20 }), { items: [] });
});

test('daily settlement prepares the latest full template and rolls back on next occurrence failure', async t => {
  const f = fixture(t, 'solomap-scheduled-prepared-settlement-');
  const now = new Date('2026-07-23T09:01:00.000Z');
  const task = { id: 'prepared-daily', enabled: true, scheduleKind: 'daily', timeOfDay: '09:00', assignee: 'agent', prompt: 'Previous prompt' };
  await syncScheduledTaskDatabase(f.workspace, f.globalRoot, [task], now, f.call);
  const [claimed] = await claimDueScheduledTaskDatabase(f.workspace, f.globalRoot, 'window-a', now, f.call);
  const prompt = '下一次使用完整的新正文🌿'.repeat(14000);
  await syncScheduledTaskDatabase(f.workspace, f.globalRoot, [{ ...task, prompt }], now, f.call);
  f.store.settleScheduleOccurrence = () => { throw new Error('synchronous_schedule_settlement_called'); };
  f.store.db.run("CREATE TEMP TRIGGER reject_schedule_next BEFORE INSERT ON scheduled_occurrences BEGIN SELECT RAISE(ABORT,'original_schedule_next_sql'); END");
  const input = { occurrenceId: claimed.occurrenceId, token: claimed.token, state: 'completed', idempotencyKey: 'complete-prepared-daily' };
  await assert.rejects(f.call('settle_schedule_occurrence', input), /original_schedule_next_sql/);
  const held = (await readScheduledTaskDatabase(f.workspace, f.globalRoot, f.call)).tasks;
  assert.equal(held.length, 1);
  assert.equal(held[0].occurrenceId, claimed.occurrenceId);
  assert.equal(held[0].status, 'running');
  f.store.db.run('DROP TRIGGER temp.reject_schedule_next');
  const completed = await f.call('settle_schedule_occurrence', input);
  assert.deepEqual(await f.call('settle_schedule_occurrence', input), completed);
  const request = f.store.rows('SELECT * FROM requests WHERE idempotency_key=?', [input.idempotencyKey])[0];
  const receipt = JSON.parse(f.store.requestResult(request).toString());
  const contentId = f.store.readMetadata(receipt.objectId, receipt.revision).data.content_id;
  const accepted = f.store.content(contentId);
  const damaged = Buffer.from(f.store.rows('SELECT data FROM contents WHERE id=?', [contentId])[0].data);
  damaged[0] ^= 1;
  f.store.db.run('UPDATE contents SET data=? WHERE id=?', [damaged, contentId]);
  const inspect = f.store.inspectProjectMigration.bind(f.store);
  let repaired = false;
  f.store.inspectProjectMigration = async request => {
    const result = await inspect(request);
    if (request.kind === 'scheduleSettlement' && result.resultFailure && !repaired) {
      repaired = true;
      assert.equal(f.store.putContent(accepted, 'application/json'), contentId);
    }
    return result;
  };
  assert.deepEqual(await f.call('settle_schedule_occurrence', input), completed);
  assert.equal(repaired, true);
  const next = (await readScheduledTaskDatabase(f.workspace, f.globalRoot, f.call)).tasks;
  assert.equal(next.length, 1);
  assert.equal(next[0].task.prompt === prompt, true);
  assert.ok(Date.parse(next[0].dueAt) > Date.parse(claimed.dueAt));
});
