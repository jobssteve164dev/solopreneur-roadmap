const assert = require('node:assert/strict');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  claimDueScheduledTasks,
  completeScheduledTaskOccurrence,
  failScheduledTaskOccurrence,
  getScheduledTaskLedgerPath,
  readScheduledTaskLedger,
  syncScheduledTaskLedger,
  validateScheduledTaskLedger
} = require('../out/scheduledTaskLedger.js');

test('scheduled task ledger persists, claims, retries and removes one-time occurrences', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-scheduled-ledger-'));
  const workspace = path.join(root, 'project');
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(workspace);
  const now = new Date('2026-07-23T10:00:00.000Z');
  const task = {
    id: 'once-1',
    title: 'Prepare release',
    enabled: true,
    projectPath: workspace,
    scheduleKind: 'once',
    scheduledAt: '2026-07-23T09:59:00.000Z',
    timeOfDay: '09:59',
    assignee: 'agent',
    prompt: 'Prepare the release.'
  };

  const ledger = syncScheduledTaskLedger(workspace, globalRoot, [task], now);
  assert.equal(ledger.tasks.length, 1);
  assert.equal(validateScheduledTaskLedger(ledger).length, 0);
  assert.equal(fs.existsSync(getScheduledTaskLedgerPath(workspace, globalRoot)), true);
  assert.match(childProcess.execFileSync(process.execPath, [
    path.join(__dirname, '..', 'resources', 'tools', 'validate-scheduled-tasks.cjs'),
    getScheduledTaskLedgerPath(workspace, globalRoot)
  ], { encoding: 'utf8' }), /^PASS:/);

  const claimed = claimDueScheduledTasks(workspace, globalRoot, 'window-a', now);
  assert.equal(claimed.length, 1);
  assert.equal(claimDueScheduledTasks(workspace, globalRoot, 'window-b', now).length, 0);

  failScheduledTaskOccurrence(workspace, globalRoot, claimed[0].occurrenceId, now);
  assert.equal(claimDueScheduledTasks(workspace, globalRoot, 'window-b', new Date(now.getTime() + 30_000)).length, 0);
  const retried = claimDueScheduledTasks(workspace, globalRoot, 'window-b', new Date(now.getTime() + 60_000));
  assert.equal(retried.length, 1);
  completeScheduledTaskOccurrence(workspace, globalRoot, retried[0].occurrenceId, now);
  assert.equal(readScheduledTaskLedger(workspace, globalRoot).tasks.length, 0);
});

test('scheduled task ledger stops retrying after three failed claims', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-scheduled-failure-'));
  const workspace = path.join(root, 'project');
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(workspace);
  const task = {
    id: 'failing-1', enabled: true, scheduleKind: 'once',
    scheduledAt: '2026-07-23T09:00:00.000Z', assignee: 'agent', prompt: 'Run.'
  };
  let now = new Date('2026-07-23T10:00:00.000Z');
  syncScheduledTaskLedger(workspace, globalRoot, [task], now);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimed = claimDueScheduledTasks(workspace, globalRoot, 'window-a', now);
    assert.equal(claimed.length, 1);
    const result = failScheduledTaskOccurrence(workspace, globalRoot, claimed[0].occurrenceId, now);
    assert.equal(result, attempt === 3 ? 'failed' : 'retry');
    now = new Date(now.getTime() + (attempt === 1 ? 60_000 : attempt === 2 ? 5 * 60_000 : 15 * 60_000));
  }
  const ledger = readScheduledTaskLedger(workspace, globalRoot);
  assert.equal(ledger.tasks.length, 0);
  assert.equal(ledger.failures.length, 1);
});

test('scheduled task ledger creates the next daily occurrence after completion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-scheduled-daily-'));
  const workspace = path.join(root, 'project');
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(workspace);
  const now = new Date('2026-07-23T08:00:00.000Z');
  const task = {
    id: 'daily-1',
    enabled: true,
    scheduleKind: 'daily',
    timeOfDay: '09:00',
    assignee: 'user',
    prompt: ''
  };
  const first = syncScheduledTaskLedger(workspace, globalRoot, [task], now).tasks[0];
  completeScheduledTaskOccurrence(workspace, globalRoot, first.occurrenceId, new Date('2026-07-23T09:01:00.000Z'));
  const next = readScheduledTaskLedger(workspace, globalRoot).tasks[0];
  assert.ok(next);
  assert.equal(next.taskId, task.id);
  assert.notEqual(next.occurrenceId, first.occurrenceId);
  assert.ok(Date.parse(next.dueAt) > Date.parse(first.dueAt));
});
