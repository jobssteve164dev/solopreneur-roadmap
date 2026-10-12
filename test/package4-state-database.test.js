const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { importLegacyRuntimeState } = require('../out/runtimeStateMigration.js');
const { claimTelegramChannelLease, requestTelegramChannelTakeover } = require('../out/telegramChannelLease.js');
const { registerTelegramHostPresence, releaseTelegramHostPresence, withTelegramHostPresenceLock } = require('../out/telegramHostPresence.js');
const { persistTelegramRuntimeConfig } = require('../out/telegramRuntimeConfig.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { readProcessBirthMarker } = require('../out/processIdentity.js');
const { syncScheduledTaskDatabase } = require('../out/scheduledTaskLedger.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-p4-state-'));
  const store = new UnifiedDataStore(root);
  return { root, store };
}

function closeFixture(value) {
  value.store.close();
  for (const name of ['solomap.db-shm', 'solomap.db-wal', 'solomap.db']) {
    const file = path.join(value.root, name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  fs.rmdirSync(value.root);
}

test('one Telegram token has one cross-root poller lease and the waiting root can take over', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-p4-telegram-lease-'));
  const first = claimTelegramChannelLease('same-token', '/data/X', base);
  try {
    assert.ok(first);
    assert.equal(claimTelegramChannelLease('same-token', '/data/Y', base), null);
    first.release();
    const second = claimTelegramChannelLease('same-token', '/data/Y', base);
    assert.ok(second);
    second.release();
    assert.equal(fs.existsSync(base), false);
  } finally {
    first?.release();
    if (fs.existsSync(base)) fs.rmdirSync(base);
  }
});

test('Telegram lease release retires an outstanding takeover atomically while a new owner claims immediately', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-p4-telegram-atomic-release-'));
  const token = 'atomic-release-token';
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const lockPath = path.join(base, tokenHash);
  const first = claimTelegramChannelLease(token, '/data/X', base);
  const firstOwner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
  const retiredPath = `${lockPath}.retired-${firstOwner.leaseId}`;
  const originalRename = fs.renameSync;
  let second = null;
  try {
    assert.ok(first);
    assert.equal(requestTelegramChannelTakeover(token, '/data/Y', base), true);
    fs.renameSync = (from, to) => {
      originalRename(from, to);
      if (from === lockPath) second = claimTelegramChannelLease(token, '/data/Y', base);
    };
    first.release();
    fs.renameSync = originalRename;
    assert.ok(second);
    assert.equal(fs.existsSync(retiredPath), false);
    second.release();
    assert.equal(fs.existsSync(base), false);
  } finally {
    fs.renameSync = originalRename;
    first?.release(); second?.release();
    for (const directory of [lockPath, retiredPath]) {
      for (const name of ['takeover.json', 'owner.json']) {
        const file = path.join(directory, name); if (fs.existsSync(file)) fs.unlinkSync(file);
      }
      if (fs.existsSync(directory)) fs.rmdirSync(directory);
    }
    if (fs.existsSync(base)) fs.rmdirSync(base);
  }
});

test('Telegram lease release keeps its retry handle after a transient rename failure', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-p4-telegram-release-retry-'));
  const token = 'release-retry-token';
  const lockPath = path.join(base, crypto.createHash('sha256').update(token).digest('hex'));
  const first = claimTelegramChannelLease(token, '/data/X', base);
  const originalRename = fs.renameSync;
  let failed = false;
  try {
    assert.ok(first);
    assert.equal(requestTelegramChannelTakeover(token, '/data/Y', base), true);
    fs.renameSync = (from, to) => {
      if (!failed && from === lockPath) { failed = true; throw Object.assign(new Error('fixture_transient_rename'), { code: 'EBUSY' }); }
      return originalRename(from, to);
    };
    assert.equal(first.release(), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).globalDataPath, path.resolve('/data/X'));
    fs.renameSync = originalRename;
    assert.equal(first.release(), true);
    const second = claimTelegramChannelLease(token, '/data/Y', base);
    assert.ok(second);
    assert.equal(second.release(), true);
    assert.equal(fs.existsSync(base), false);
  } finally {
    fs.renameSync = originalRename;
    first?.release();
    const ownerFile = path.join(lockPath, 'owner.json'); if (fs.existsSync(ownerFile)) fs.unlinkSync(ownerFile);
    const takeoverFile = path.join(lockPath, 'takeover.json'); if (fs.existsSync(takeoverFile)) fs.unlinkSync(takeoverFile);
    if (fs.existsSync(lockPath)) fs.rmdirSync(lockPath);
    if (fs.existsSync(base)) fs.rmdirSync(base);
  }
});

test('a dead Telegram poller lease is reclaimed without waiting for its old root', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-p4-telegram-dead-lease-'));
  const first = claimTelegramChannelLease('crashed-token', '/data/X', base);
  const tokenHash = crypto.createHash('sha256').update('crashed-token').digest('hex');
  const ownerFile = path.join(base, tokenHash, 'owner.json');
  const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
  fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, pid: 999999, birth: 'dead-process' }));
  const second = claimTelegramChannelLease('crashed-token', '/data/Y', base);
  try {
    assert.ok(second);
    second.release();
    assert.equal(fs.existsSync(base), false);
  } finally {
    first?.release(); second?.release();
    if (fs.existsSync(ownerFile)) fs.unlinkSync(ownerFile);
    const lock = path.dirname(ownerFile); if (fs.existsSync(lock)) fs.rmdirSync(lock);
    if (fs.existsSync(base)) fs.rmdirSync(base);
  }
});

test('an old ownerless Telegram lease directory is recovered immediately', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-p4-telegram-ownerless-'));
  const token = 'ownerless-token';
  const lock = path.join(base, crypto.createHash('sha256').update(token).digest('hex'));
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - 120_000); fs.utimesSync(lock, old, old);
  const lease = claimTelegramChannelLease(token, '/data/recovered', base);
  try {
    assert.ok(lease);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).globalDataPath, path.resolve('/data/recovered'));
  } finally {
    lease?.release();
    if (fs.existsSync(path.join(lock, 'owner.json'))) fs.unlinkSync(path.join(lock, 'owner.json'));
    if (fs.existsSync(lock)) fs.rmdirSync(lock);
    if (fs.existsSync(base)) fs.rmdirSync(base);
  }
});

test('a takeover request from a dead requester cannot stop the current Telegram owner', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-p4-telegram-dead-request-'));
  const lease = claimTelegramChannelLease('handoff-token', '/data/X', base);
  const tokenHash = crypto.createHash('sha256').update('handoff-token').digest('hex');
  const takeoverFile = path.join(base, tokenHash, 'takeover.json');
  try {
    assert.ok(lease);
    assert.equal(requestTelegramChannelTakeover('handoff-token', '/data/Y', base), true);
    const request = JSON.parse(fs.readFileSync(takeoverFile, 'utf8'));
    fs.writeFileSync(takeoverFile, JSON.stringify({ ...request, pid: 999999, birth: 'dead-requester' }));
    assert.equal(lease.takeTakeoverRequest(), null);
    assert.equal(claimTelegramChannelLease('handoff-token', '/data/Y', base), null);
  } finally {
    lease?.release();
    if (fs.existsSync(takeoverFile)) fs.unlinkSync(takeoverFile);
    const lock = path.dirname(takeoverFile); if (fs.existsSync(lock)) fs.rmdirSync(lock);
    if (fs.existsSync(base)) fs.rmdirSync(base);
  }
});

test('Telegram editor presence stays bounded and preserves a root until its last host switches', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-p4-telegram-presence-'));
  const root = '/data/X'; const birth = readProcessBirthMarker(process.pid);
  const first = { hostId: crypto.randomUUID(), pid: process.pid, birth, updatedAt: new Date().toISOString() };
  const second = { hostId: crypto.randomUUID(), pid: process.pid, birth, updatedAt: new Date().toISOString() };
  assert.equal(await registerTelegramHostPresence(root, first, base), 1);
  for (let index = 0; index < 5; index++) assert.equal(await registerTelegramHostPresence(root, first, base), 1);
  assert.equal(await registerTelegramHostPresence(root, second, base), 2);
  const rootDirectory = path.join(base, crypto.createHash('sha256').update(path.resolve(root)).digest('hex'));
  assert.equal(fs.readdirSync(rootDirectory).filter(name => name.endsWith('.json')).length, 2);
  assert.equal(await releaseTelegramHostPresence(root, first.hostId, base), 1);
  assert.equal(await releaseTelegramHostPresence(root, second.hostId, base), 0);
  assert.equal(fs.existsSync(base), false);
});

test('Telegram editor presence requires both a live process and a recent heartbeat', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-p4-telegram-presence-expiry-'));
  const root = '/data/heartbeat-root'; const now = Date.now();
  const presence = { hostId: crypto.randomUUID(), pid: process.pid, birth: readProcessBirthMarker(process.pid), updatedAt: new Date(now).toISOString() };
  assert.equal(await registerTelegramHostPresence(root, presence, base, now), 1);
  assert.equal(require('../out/telegramHostPresence.js').countTelegramHostPresence(root, base, now + 80_000), 1);
  assert.equal(require('../out/telegramHostPresence.js').countTelegramHostPresence(root, base, now + 100_000), 0);
  assert.equal(await releaseTelegramHostPresence(root, presence.hostId, base, now + 100_000), 0);
  assert.equal(fs.existsSync(base), false);
});

test('Telegram presence coordination propagates an action failure once and remains acquirable', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-p4-telegram-presence-error-'));
  const root = '/data/error-root';
  let attempts = 0;
  await assert.rejects(withTelegramHostPresenceLock(root, async () => { attempts += 1; throw new Error('fixture_action_failure'); }, base), /fixture_action_failure/);
  assert.equal(attempts, 1);
  assert.equal(await withTelegramHostPresenceLock(root, () => 42, base), 42);
  assert.equal(fs.existsSync(base), false);
});

test('Telegram presence coordination cleans a contender when its final publication fails', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-p4-telegram-presence-publish-error-'));
  const root = '/data/publish-error-root';
  const originalRename = fs.renameSync;
  let coordinationRenames = 0;
  try {
    fs.renameSync = (from, to) => {
      if (String(to).includes('.coordination.') && ++coordinationRenames === 2) throw Object.assign(new Error('fixture_second_contender_write'), { code: 'EBUSY' });
      return originalRename(from, to);
    };
    await assert.rejects(withTelegramHostPresenceLock(root, () => 1, base), /fixture_second_contender_write/);
    fs.renameSync = originalRename;
    assert.equal(await withTelegramHostPresenceLock(root, () => 42, base), 42);
    assert.equal(fs.existsSync(base), false);
  } finally {
    fs.renameSync = originalRename;
    if (fs.existsSync(base)) {
      const roots = fs.readdirSync(base);
      assert.ok(roots.length <= 1);
      if (roots[0]) {
        const fixtureRoot = path.join(base, roots[0]);
        const files = fs.readdirSync(fixtureRoot);
        assert.ok(files.length <= 2);
        if (files[0]) fs.unlinkSync(path.join(fixtureRoot, files[0]));
        if (files[1]) fs.unlinkSync(path.join(fixtureRoot, files[1]));
        fs.rmdirSync(fixtureRoot);
      }
      fs.rmdirSync(base);
    }
  }
});

test('host setting patches preserve fields written by another window and replay exactly', () => {
  const value = fixture();
  try {
    const first = value.store.patchHostSettings({ namespace: 'extension', ownerScope: 'global', patches: [
      { key: 'language', expectedRevision: 0, value: 'zh' },
      { key: 'cliPath', expectedRevision: 0, value: 'codex' }
    ], idempotencyKey: 'settings-initial' });
    const language = first.items.find(item => item.key === 'language');
    const cli = first.items.find(item => item.key === 'cliPath');
    value.store.patchHostSettings({ namespace: 'extension', ownerScope: 'global', patches: [
      { key: 'language', expectedRevision: language.revision, value: 'en' }
    ], idempotencyKey: 'settings-window-a' });
    const replayed = value.store.patchHostSettings({ namespace: 'extension', ownerScope: 'global', patches: [
      { key: 'cliPath', expectedRevision: cli.revision, value: 'claude' }
    ], idempotencyKey: 'settings-window-b' });
    assert.deepEqual(value.store.readHostSettings({ namespace: 'extension', ownerScope: 'global' }).items.map(item => [item.key, item.value]), [
      ['cliPath', 'claude'], ['language', 'en']
    ]);
    assert.deepEqual(value.store.patchHostSettings({ namespace: 'extension', ownerScope: 'global', patches: [
      { key: 'cliPath', expectedRevision: cli.revision, value: 'claude' }
    ], idempotencyKey: 'settings-window-b' }), replayed);
  } finally { closeFixture(value); }
});

test('initial host setting creation replays after a lost response', () => {
  const value = fixture();
  try {
    const input = { namespace: 'extension', ownerScope: 'global', patches: [
      { key: 'language', expectedRevision: 0, value: 'zh' },
      { key: 'cliPath', expectedRevision: 0, value: 'codex' }
    ], idempotencyKey: 'settings-create-lost-response' };
    const created = value.store.patchHostSettings(input);
    value.store.close();
    value.store = UnifiedDataStore.open(value.root);
    assert.deepEqual(value.store.patchHostSettings(input), created);
  } finally { closeFixture(value); }
});

test('device UI keys use independent revisions and reject a stale overwrite', () => {
  const value = fixture();
  try {
    const initial = value.store.patchUiState({ view: 'sidebar', scopeKey: 'global', patches: [
      { key: 'draft', expectedRevision: 0, value: 'keep all text' },
      { key: 'expanded', expectedRevision: 0, value: ['settings'] }
    ], idempotencyKey: 'ui-initial' });
    const draft = initial.items.find(item => item.key === 'draft');
    const expanded = initial.items.find(item => item.key === 'expanded');
    value.store.patchUiState({ view: 'sidebar', scopeKey: 'global', patches: [
      { key: 'draft', expectedRevision: draft.revision, value: 'new draft' }
    ], idempotencyKey: 'ui-draft' });
    value.store.patchUiState({ view: 'sidebar', scopeKey: 'global', patches: [
      { key: 'expanded', expectedRevision: expanded.revision, value: ['settings', 'projects'] }
    ], idempotencyKey: 'ui-expanded' });
    assert.throws(() => value.store.patchUiState({ view: 'sidebar', scopeKey: 'global', patches: [
      { key: 'draft', expectedRevision: draft.revision, value: 'stale' }
    ], idempotencyKey: 'ui-stale' }), /revision_conflict/);
    assert.deepEqual(value.store.readUiState({ view: 'sidebar', scopeKey: 'global' }).items.map(item => [item.key, item.value]), [
      ['draft', 'new draft'], ['expanded', ['settings', 'projects']]
    ]);
  } finally { closeFixture(value); }
});

test('schedule occurrence survives restart and rejects the prior lease generation', () => {
  const value = fixture();
  try {
    value.store.syncSchedules({ schedules: [{ id: 'daily-review', timezone: 'UTC', trigger: { kind: 'daily', timeOfDay: '09:00' }, enabled: true, nextDueAt: 1000, task: { title: 'Review', prompt: 'review' } }], idempotencyKey: 'schedule-sync' });
    const first = value.store.claimDueSchedules({ owner: { id: 'runtime-a', pid: 101, birth: 'a' }, now: 1000, leaseMs: 100, limit: 10 });
    assert.equal(first.items.length, 1);
    value.store.close();
    value.store = UnifiedDataStore.open(value.root);
    const recovered = value.store.claimDueSchedules({ owner: { id: 'runtime-b', pid: 202, birth: 'b' }, now: 1200, leaseMs: 100, limit: 10 });
    assert.equal(recovered.items.length, 1);
    assert.equal(recovered.items[0].generation, first.items[0].generation + 1);
    assert.throws(() => value.store.settleScheduleOccurrence({ occurrenceId: first.items[0].occurrenceId, token: first.items[0].token, state: 'completed', idempotencyKey: 'old-settle' }), /schedule_lease_lost/);
    const completed = value.store.settleScheduleOccurrence({ occurrenceId: recovered.items[0].occurrenceId, token: recovered.items[0].token, state: 'completed', idempotencyKey: 'new-settle' });
    assert.equal(completed.state, 'completed');
    assert.equal(value.store.claimDueSchedules({ owner: { id: 'runtime-c', pid: 303, birth: 'c' }, now: 1300, leaseMs: 100, limit: 10 }).items.length, 0);
  } finally { closeFixture(value); }
});

test('completed daily schedule creates exactly one next occurrence', () => {
  const value = fixture();
  try {
    const firstDueAt = Date.parse('2026-01-01T09:00:00.000Z');
    value.store.syncSchedules({ schedules: [{ id: 'daily-review', timezone: 'UTC', trigger: { kind: 'daily', timeOfDay: '09:00' }, enabled: true, nextDueAt: firstDueAt, task: { id: 'daily-review', scheduleKind: 'daily', timeOfDay: '09:00', title: 'Review' } }], idempotencyKey: 'daily-sync' });
    const claimed = value.store.claimDueSchedules({ owner: { id: 'runtime-a', pid: 101, birth: 'a' }, now: firstDueAt, leaseMs: 100, limit: 10 });
    value.store.settleScheduleOccurrence({ occurrenceId: claimed.items[0].occurrenceId, token: claimed.items[0].token, state: 'completed', idempotencyKey: 'daily-complete' });
    const ledger = value.store.readScheduleLedger();
    assert.equal(ledger.tasks.length, 1);
    assert.equal(ledger.tasks[0].taskId, 'daily-review');
    assert.equal(ledger.tasks[0].status, 'pending');
    assert.equal(Date.parse(ledger.tasks[0].dueAt), Date.parse('2026-01-02T09:00:00.000Z'));
    assert.deepEqual(value.store.settleScheduleOccurrence({ occurrenceId: claimed.items[0].occurrenceId, token: claimed.items[0].token, state: 'completed', idempotencyKey: 'daily-complete' }), { occurrenceId: claimed.items[0].occurrenceId, state: 'completed', generation: 1 });
    assert.equal(value.store.readScheduleLedger().tasks.length, 1);
  } finally { closeFixture(value); }
});

test('schedule synchronization supports A to B to A and delete to restore round trips', async () => {
  const value = fixture();
  const operation = async (name, input) => {
    if (name === 'read_schedule_sync_state') return value.store.readScheduleSyncState();
    if (name === 'sync_schedules') return value.store.syncSchedules(input);
    if (name === 'read_schedule_ledger') return value.store.readScheduleLedger();
    throw new Error(`unexpected operation ${name}`);
  };
  const now = new Date('2026-01-01T08:00:00.000Z');
  const task = prompt => ({ id: 'daily', title: prompt, enabled: true, scheduleKind: 'daily', timeOfDay: '09:00', prompt });
  try {
    await syncScheduledTaskDatabase('', value.root, [task('A')], now, operation);
    await syncScheduledTaskDatabase('', value.root, [task('B')], now, operation);
    await syncScheduledTaskDatabase('', value.root, [task('A')], now, operation);
    assert.equal(value.store.readScheduleLedger().tasks[0].task.prompt, 'A');
    await syncScheduledTaskDatabase('', value.root, [], now, operation);
    assert.equal(value.store.readScheduleLedger().tasks.length, 0);
    await syncScheduledTaskDatabase('', value.root, [task('A')], now, operation);
    assert.equal(value.store.readScheduleLedger().tasks[0].task.prompt, 'A');
  } finally { closeFixture(value); }
});

test('a running daily occurrence schedules the next run from the latest task template', () => {
  const value = fixture();
  try {
    const firstDueAt = Date.parse('2026-01-01T09:00:00.000Z');
    const schedule = task => ({ id: 'daily-review', timezone: 'UTC', trigger: { kind: 'daily', timeOfDay: '09:00' }, enabled: true, nextDueAt: firstDueAt, task });
    value.store.syncSchedules({ schedules: [schedule({ title: 'Old review', prompt: 'old' })], idempotencyKey: 'daily-template-initial' });
    const claimed = value.store.claimDueSchedules({ owner: { id: 'runtime-a', pid: 101, birth: 'a' }, now: firstDueAt, leaseMs: 100, limit: 10 }).items[0];
    value.store.syncSchedules({ schedules: [schedule({ title: 'New review', prompt: 'new' })], idempotencyKey: 'daily-template-update' });
    value.store.settleScheduleOccurrence({ occurrenceId: claimed.occurrenceId, token: claimed.token, state: 'completed', idempotencyKey: 'daily-template-complete' });
    assert.deepEqual(value.store.readScheduleLedger().tasks[0].task, { prompt: 'new', title: 'New review' });
  } finally { closeFixture(value); }
});

test('native configuration projection receipts are consumed once per active host without swallowing a user rollback', () => {
  const value = fixture();
  try {
    const valueHash = crypto.createHash('sha256').update(JSON.stringify('en')).digest('hex');
    assert.deepEqual(value.store.recordNativeProjection({ projectionId: 'window-a-language', settingKey: 'language', valueHash, createdAt: 2000 }), { recorded: true });
    assert.deepEqual(value.store.recordNativeProjection({ projectionId: 'window-c-language', settingKey: 'language', valueHash, createdAt: 2000 }), { recorded: true });
    assert.equal(value.store.consumeNativeProjection({ hostId: 'window-b', settingKey: 'language', valueHash, after: 1000, consumedAt: 200000 }).projected, true, 'an active host still recognizes a projection event delayed for more than two minutes');
    assert.equal(value.store.consumeNativeProjection({ hostId: 'window-b', settingKey: 'language', valueHash, after: 1000, consumedAt: 200001 }).projected, false, 'one host event consumes every duplicate projection so a later explicit rollback is accepted');
    assert.equal(value.store.consumeNativeProjection({ hostId: 'window-c', settingKey: 'language', valueHash, after: 2001, consumedAt: 2002 }).projected, false, 'a host activated after the projection cannot consume stale receipts');
    assert.equal(value.store.cancelNativeProjection({ projectionId: 'window-a-language' }).cancelled, true);
    assert.equal(value.store.consumeNativeProjection({ hostId: 'window-d', settingKey: 'language', valueHash, after: 2001 }).projected, false);
  } finally { closeFixture(value); }
});

test('a newer successful native projection supersedes a projection missed by another active host', () => {
  const value = fixture();
  try {
    const initial = value.store.patchHostSettings({ namespace: 'extension', ownerScope: 'global', patches: [{ key: 'language', expectedRevision: 0, value: 'en' }], idempotencyKey: 'native-projection-initial' });
    const revision = initial.items.find(item => item.key === 'language').revision;
    const enHash = crypto.createHash('sha256').update(JSON.stringify('en')).digest('hex');
    value.store.recordNativeProjection({ projectionId: 'missed-en-projection', settingKey: 'language', valueHash: enHash, createdAt: 2000 });
    value.store.patchHostSettings({ namespace: 'extension', ownerScope: 'global', patches: [{ key: 'language', expectedRevision: revision, value: 'zh' }], idempotencyKey: 'native-projection-authority-advanced' });
    assert.equal(value.store.consumeNativeProjection({ hostId: 'window-c', settingKey: 'language', valueHash: enHash, after: 1000 }).projected, true, 'the old receipt remains available while the native X event is still in flight');
    const zhHash = crypto.createHash('sha256').update(JSON.stringify('zh')).digest('hex');
    value.store.recordNativeProjection({ projectionId: 'current-zh-projection', settingKey: 'language', valueHash: zhHash, createdAt: 3000 });
    value.store.supersedeNativeProjections({ settingKey: 'language', keepProjectionId: 'current-zh-projection' });
    assert.equal(value.store.consumeNativeProjection({ hostId: 'window-b', settingKey: 'language', valueHash: enHash, after: 1000 }).projected, false, 'an old projection cannot hide an explicit rollback after the database has advanced');
    assert.equal(value.store.consumeNativeProjection({ hostId: 'window-b', settingKey: 'language', valueHash: zhHash, after: 1000 }).projected, true);
  } finally { closeFixture(value); }
});

test('cognitive projection is fenced by the exact extension setting revisions', () => {
  const value = fixture();
  try {
    const initial = value.store.patchHostSettings({ namespace: 'extension', ownerScope: 'global', patches: [
      { key: 'cliPath', expectedRevision: 0, value: 'codex' },
      { key: 'agentModelPreferences', expectedRevision: 0, value: { codex: 'model-a' } },
      { key: 'cognitiveEngineAgent', expectedRevision: 0, value: 'follow_main' }
    ], idempotencyKey: 'cognitive-source-initial' });
    const revisions = Object.fromEntries(initial.items.map(item => [item.key, item.revision]));
    value.store.projectCognitiveRuntimeConfig({ expectedSourceRevisions: revisions, values: { mode: 'agent_cli', agentCli: 'codex', model: 'model-a' }, idempotencyKey: 'cognitive-projection-a' });
    const preferences = initial.items.find(item => item.key === 'agentModelPreferences');
    value.store.patchHostSettings({ namespace: 'extension', ownerScope: 'global', patches: [{ key: 'agentModelPreferences', expectedRevision: preferences.revision, value: { codex: 'model-b' } }], idempotencyKey: 'cognitive-source-b' });
    assert.throws(() => value.store.projectCognitiveRuntimeConfig({ expectedSourceRevisions: revisions, values: { mode: 'agent_cli', agentCli: 'codex', model: 'model-a' }, idempotencyKey: 'cognitive-stale-projection' }), /source_revision_conflict/);
    const latest = value.store.readHostSettings({ namespace: 'extension', ownerScope: 'global' });
    value.store.projectCognitiveRuntimeConfig({ expectedSourceRevisions: Object.fromEntries(latest.items.map(item => [item.key, item.revision])), values: { mode: 'agent_cli', agentCli: 'codex', model: 'model-b' }, idempotencyKey: 'cognitive-projection-b' });
    assert.equal(value.store.readHostSettings({ namespace: 'cognitive', ownerScope: 'global' }).items.find(item => item.key === 'model').value, 'model-b');
  } finally { closeFixture(value); }
});

test('legacy global-state Telegram conversations import once and never repopulate a changed bot', () => {
  const value = fixture();
  try {
    const ids = { '42': 'legacy-conversation' };
    const sourceHash = crypto.createHash('sha256').update(JSON.stringify(ids)).digest('hex');
    assert.deepEqual(value.store.importLegacyTelegramConversationIds({ sourceHash, ids }), { settled: true, imported: true });
    let current = new Map(value.store.readHostSettings({ namespace: 'telegram', ownerScope: 'global' }).items.map(item => [item.key, item]));
    value.store.patchHostSettings({ namespace: 'telegram', ownerScope: 'global', patches: [
      { key: 'botToken', expectedRevision: 0, value: 'bot-a' }, { key: 'chatId', expectedRevision: 0, value: '42' }
    ], idempotencyKey: 'legacy-conversation-first-bot' });
    current = new Map(value.store.readHostSettings({ namespace: 'telegram', ownerScope: 'global' }).items.map(item => [item.key, item]));
    value.store.patchHostSettings({ namespace: 'telegram', ownerScope: 'global', patches: [
      { key: 'botToken', expectedRevision: current.get('botToken').revision, value: 'bot-b' },
      { key: 'conversationIds', expectedRevision: current.get('conversationIds').revision, value: {} }
    ], idempotencyKey: 'legacy-conversation-switch-bot' });
    assert.deepEqual(value.store.importLegacyTelegramConversationIds({ sourceHash, ids }), { settled: true, imported: true });
    assert.deepEqual(value.store.readHostSettings({ namespace: 'telegram', ownerScope: 'global' }).items.find(item => item.key === 'conversationIds').value, {});
    assert.equal(value.store.capturedMigrationSources().filter(item => item.key === 'solopreneur.telegramIntelligenceConversations').length, 1);
  } finally { closeFixture(value); }
});

test('runtime registration and heartbeat replay without changing lease generation', () => {
  const value = fixture();
  try {
    const registration = { runtimeId: 'runtime-a', pid: 101, processStartedAt: 1000, status: 'running', buildId: 'build-a', heartbeatAt: 1100, leaseMs: 100, idempotencyKey: 'runtime-register' };
    const registered = value.store.registerRuntimeInstance(registration);
    assert.deepEqual(value.store.registerRuntimeInstance(registration), registered);
    const heartbeat = { runtimeId: 'runtime-a', generation: registered.generation, status: 'paused', heartbeatAt: 1150, leaseMs: 100, idempotencyKey: 'runtime-heartbeat' };
    const paused = value.store.heartbeatRuntimeInstance(heartbeat);
    value.store.close();
    value.store = UnifiedDataStore.open(value.root);
    assert.deepEqual(value.store.heartbeatRuntimeInstance(heartbeat), paused);
  } finally { closeFixture(value); }
});

test('a dead runtime owner is fenced and replaced before its database lease expiry', () => {
  const value = fixture();
  try {
    const first = value.store.registerRuntimeInstance({ runtimeId: 'dead-runtime', pid: 999999, processStartedAt: 1000, processBirth: 'dead-owner', status: 'running', buildId: 'build-a', heartbeatAt: 1100, leaseMs: 90_000, idempotencyKey: 'dead-runtime-register' });
    const second = value.store.registerRuntimeInstance({ runtimeId: 'replacement-runtime', pid: process.pid, processStartedAt: Date.now(), processBirth: readProcessBirthMarker(process.pid), status: 'running', buildId: 'build-a', heartbeatAt: 1200, leaseMs: 90_000, idempotencyKey: 'replacement-runtime-register' });
    assert.equal(second.generation, first.generation + 1);
    assert.throws(() => value.store.heartbeatRuntimeInstance({ runtimeId: 'dead-runtime', generation: first.generation, status: 'running', heartbeatAt: 1300, idempotencyKey: 'dead-runtime-late-heartbeat' }), /runtime_lease_lost/);
  } finally { closeFixture(value); }
});

test('telegram inbox deduplicates updates, detects identity conflicts, and persists acknowledgement', () => {
  const value = fixture();
  try {
    const accepted = value.store.acceptInboxMessage({ channel: 'telegram', sourceId: '42', generation: 3, payload: { update_id: 42, text: 'hello' }, idempotencyKey: 'tg-42' });
    assert.deepEqual(value.store.acceptInboxMessage({ channel: 'telegram', sourceId: '42', generation: 3, payload: { update_id: 42, text: 'hello' }, idempotencyKey: 'tg-42' }), accepted);
    assert.throws(() => value.store.acceptInboxMessage({ channel: 'telegram', sourceId: '42', generation: 3, payload: { update_id: 42, text: 'changed' }, idempotencyKey: 'tg-42-conflict' }), /inbox_identity_conflict/);
    const claimed = value.store.claimInboxMessages({ channel: 'telegram', generation: 3, owner: { id: 'runtime-a', pid: 101, birth: 'a' }, limit: 10 });
    assert.equal(claimed.items.length, 1);
    value.store.acknowledgeInboxMessage({ channel: 'telegram', sourceId: '42', generation: 3, token: claimed.items[0].token, idempotencyKey: 'tg-42-ack' });
    value.store.close();
    value.store = UnifiedDataStore.open(value.root);
    assert.equal(value.store.claimInboxMessages({ channel: 'telegram', generation: 3, owner: { id: 'runtime-b', pid: 202, birth: 'b' }, limit: 10 }).items.length, 0);
  } finally { closeFixture(value); }
});

test('telegram inbox claim can be released immediately for restart recovery', () => {
  const value = fixture();
  try {
    value.store.acceptInboxMessage({ channel: 'telegram', sourceId: '77', generation: 4, payload: { update_id: 77 }, idempotencyKey: 'tg-77' });
    const claimed = value.store.claimInboxMessages({ channel: 'telegram', generation: 4, owner: { id: 'runtime-a', pid: 101, birth: 'a' }, limit: 1 }).items[0];
    value.store.releaseInboxMessage({ channel: 'telegram', sourceId: '77', generation: 4, token: claimed.token, idempotencyKey: 'tg-77-release' });
    const recovered = value.store.claimInboxMessages({ channel: 'telegram', generation: 4, owner: { id: 'runtime-b', pid: 202, birth: 'b' }, limit: 1 });
    assert.equal(recovered.items.length, 1);
  } finally { closeFixture(value); }
});

test('telegram generation change migrates a claimed message before any action starts', () => {
  const value = fixture();
  try {
    const payload = { update_id: 78, message: { text: '/help', chat: { id: 42 } } };
    value.store.acceptInboxMessage({ channel: 'telegram', sourceId: '78', generation: 4, payload, idempotencyKey: 'tg-78-old' });
    const claimed = value.store.claimInboxMessages({ channel: 'telegram', generation: 4, owner: { id: 'runtime-a', pid: 101, birth: 'a' }, limit: 1 }).items[0];
    const released = value.store.releaseInboxMessage({ channel: 'telegram', sourceId: '78', generation: 4, recoveryGeneration: 5, token: claimed.token, idempotencyKey: 'tg-78-migrate' });
    assert.equal(released.state, 'migrated');
    assert.equal(value.store.claimInboxMessages({ channel: 'telegram', generation: 4, owner: { id: 'runtime-old', pid: 102, birth: 'old' }, limit: 1 }).items.length, 0);
    value.store.close(); value.store = UnifiedDataStore.open(value.root);
    const recovered = value.store.claimInboxMessages({ channel: 'telegram', generation: 5, owner: { id: 'runtime-new', pid: 103, birth: 'new' }, limit: 1 });
    assert.equal(recovered.items.length, 1);
    assert.deepEqual(recovered.items[0].payload, payload);
  } finally { closeFixture(value); }
});

test('legacy runtime files are captured byte-for-byte and imported once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-p4-history-'));
  const runtime = path.join(root, 'runtime'); const scheduledRoot = path.join(runtime, 'scheduled-tasks');
  fs.mkdirSync(scheduledRoot, { recursive: true });
  const cognitivePath = path.join(runtime, 'cognitive-config.json');
  const telegramPath = path.join(runtime, 'telegram-config.json');
  const schedulePath = path.join(scheduledRoot, 'scheduled-tasks.json');
  const cognitiveBytes = Buffer.from('{"schemaVersion":1,"revision":"old","mode":"agent_cli","agentCli":"codex","model":"gpt-6-luna"}\n');
  const dueAt = '2026-01-01T09:00:00.000Z';
  fs.writeFileSync(cognitivePath, cognitiveBytes);
  fs.writeFileSync(telegramPath, JSON.stringify({ schemaVersion: 1, enabled: true, botToken: 'fixture-token', chatId: '42', bindingGeneration: 2, replyGeneration: 3, conversationIds: { '42': 'conversation' } }));
  fs.writeFileSync(schedulePath, JSON.stringify({ schemaVersion: 1, tasks: [{ occurrenceId: `daily@${dueAt}`, taskId: 'daily', dueAt, status: 'running', attempts: 2, task: { id: 'daily', scheduleKind: 'daily', timeOfDay: '09:00', title: 'Review' } }], failures: [] }));
  const store = new UnifiedDataStore(root);
  try {
    importLegacyRuntimeState(store, root);
    assert.deepEqual(store.readHostSettings({ namespace: 'cognitive', ownerScope: 'global' }).items.map(item => [item.key, item.value]), [['agentCli', 'codex'], ['mode', 'agent_cli'], ['model', 'gpt-6-luna']]);
    assert.equal(store.readHostSettings({ namespace: 'telegram', ownerScope: 'global' }).items.find(item => item.key === 'chatId').value, '42');
    assert.equal(store.readScheduleLedger().tasks[0].attempts, 2);
    const source = store.readMigrationSource(`runtime-state:${root}`, 'runtime/cognitive-config.json');
    assert.deepEqual(source.bytes, cognitiveBytes); assert.equal(source.stage, 'imported');
    const revisions = store.readHostSettings({ namespace: 'cognitive', ownerScope: 'global' }).items.map(item => item.revision);
    importLegacyRuntimeState(store, root);
    assert.deepEqual(store.readHostSettings({ namespace: 'cognitive', ownerScope: 'global' }).items.map(item => item.revision), revisions);
  } finally {
    store.close();
    for (const file of [cognitivePath, telegramPath, schedulePath, path.join(root, 'solomap.db-shm'), path.join(root, 'solomap.db-wal'), path.join(root, 'solomap.db')]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(scheduledRoot); fs.rmdirSync(runtime); fs.rmdirSync(root);
  }
});

test('legacy Telegram state resumes after config import was committed before a restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-p4-telegram-resume-'));
  const runtime = path.join(root, 'runtime'); fs.mkdirSync(runtime);
  const configPath = path.join(runtime, 'telegram-config.json');
  const statePath = path.join(runtime, 'telegram-state.json');
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, enabled: true, botToken: 'legacy-token', chatId: '42', bindingGeneration: 3 }));
  const store = new UnifiedDataStore(root);
  try {
    importLegacyRuntimeState(store, root);
    fs.writeFileSync(statePath, JSON.stringify({ offset: 87, bindingGeneration: 3, conversationIds: { '42': 'legacy-conversation' } }));
    importLegacyRuntimeState(store, root);
    const settings = new Map(store.readHostSettings({ namespace: 'telegram', ownerScope: 'global' }).items.map(item => [item.key, item.value]));
    assert.equal(settings.get('offset'), 87);
    assert.deepEqual(settings.get('conversationIds'), { '42': 'legacy-conversation' });
    assert.equal(store.migrationSourceState(`runtime-state:${root}`, 'runtime/telegram-state.json').stage, 'imported');
  } finally {
    store.close();
    for (const file of [configPath, statePath, path.join(root, 'solomap.db-shm'), path.join(root, 'solomap.db-wal'), path.join(root, 'solomap.db')]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(runtime); fs.rmdirSync(root);
  }
});

test('a state-only Telegram import cannot carry conversations into the first configured bot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-p4-telegram-state-only-'));
  const runtime = path.join(root, 'runtime'); fs.mkdirSync(runtime);
  const statePath = path.join(runtime, 'telegram-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ offset: 87, conversationIds: { '42': 'legacy-conversation' } }));
  const store = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(store);
  try {
    importLegacyRuntimeState(store, root);
    const imported = new Map(store.readHostSettings({ namespace: 'telegram', ownerScope: 'global' }).items.map(item => [item.key, item.value]));
    assert.deepEqual(imported.get('conversationIds'), { '42': 'legacy-conversation' });
    const configured = await persistTelegramRuntimeConfig(root, { enabled: true, botToken: 'new-token', chatId: '42' }, operations);
    assert.equal(configured.offset, 0);
    assert.deepEqual(configured.conversationIds, {});
    assert.equal(configured.bindingGeneration, 1);
    assert.equal(configured.replyGeneration, 1);
  } finally {
    await operations.close(); store.close();
    for (const file of [statePath, path.join(root, 'solomap.db-shm'), path.join(root, 'solomap.db-wal'), path.join(root, 'solomap.db')]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(runtime); fs.rmdirSync(root);
  }
});

test('legacy Telegram state cannot cross into a newer bot binding', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-p4-telegram-conflict-'));
  const runtime = path.join(root, 'runtime'); fs.mkdirSync(runtime);
  const configPath = path.join(runtime, 'telegram-config.json');
  const statePath = path.join(runtime, 'telegram-state.json');
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, enabled: true, botToken: 'legacy-token', chatId: '42', bindingGeneration: 3 }));
  const store = new UnifiedDataStore(root);
  try {
    importLegacyRuntimeState(store, root);
    const token = store.readHostSettings({ namespace: 'telegram', ownerScope: 'global' }).items.find(item => item.key === 'botToken');
    store.patchHostSettings({ namespace: 'telegram', ownerScope: 'global', patches: [{ key: 'botToken', expectedRevision: token.revision, value: 'new-token' }], idempotencyKey: 'switch-telegram-bot' });
    fs.writeFileSync(statePath, JSON.stringify({ offset: 87, bindingGeneration: 3, conversationIds: { '42': 'legacy-conversation' } }));
    importLegacyRuntimeState(store, root);
    const settings = new Map(store.readHostSettings({ namespace: 'telegram', ownerScope: 'global' }).items.map(item => [item.key, item.value]));
    assert.equal(settings.get('botToken'), 'new-token');
    assert.equal(settings.get('offset'), 0);
    assert.deepEqual(settings.get('conversationIds'), {});
    assert.equal(store.migrationSourceState(`runtime-state:${root}`, 'runtime/telegram-state.json').stage, 'conflict');
  } finally {
    store.close();
    for (const file of [configPath, statePath, path.join(root, 'solomap.db-shm'), path.join(root, 'solomap.db-wal'), path.join(root, 'solomap.db')]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(runtime); fs.rmdirSync(root);
  }
});

test('malformed legacy runtime sources are isolated while valid shadow and Telegram sources continue', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-p4-malformed-'));
  const runtime = path.join(root, 'runtime'); fs.mkdirSync(runtime);
  const files = {
    cognitive: path.join(runtime, 'cognitive-config.json'), telegram: path.join(runtime, 'telegram-config.json'),
    decision: path.join(runtime, 'today-shadow.json'), evaluation: path.join(runtime, 'shadow-evaluation.json'),
    feedback: path.join(runtime, 'shadow-feedback.jsonl')
  };
  fs.writeFileSync(files.cognitive, '{"truncated":');
  fs.writeFileSync(files.telegram, JSON.stringify({ enabled: true, botToken: 'valid-token', chatId: '42', bindingGeneration: 1 }));
  fs.writeFileSync(files.decision, JSON.stringify({ decisionId: 'decision-a' }));
  fs.writeFileSync(files.evaluation, JSON.stringify({ evaluationId: 'evaluation-a' }));
  fs.writeFileSync(files.feedback, '{bad-json}\n');
  const store = new UnifiedDataStore(root);
  try {
    assert.doesNotThrow(() => importLegacyRuntimeState(store, root));
    assert.equal(store.migrationSourceState(`runtime-state:${root}`, 'runtime/cognitive-config.json').stage, 'conflict');
    assert.equal(store.migrationSourceState(`runtime-state:${root}`, 'runtime/shadow-feedback.jsonl').stage, 'conflict');
    const telegram = new Map(store.readHostSettings({ namespace: 'telegram', ownerScope: 'global' }).items.map(item => [item.key, item.value]));
    assert.equal(telegram.get('botToken'), undefined);
    assert.equal(store.readHostSettings({ namespace: 'telegram', ownerScope: 'global' }).items.find(item => item.key === 'botToken').secretRef, 'vscode-secret://solopreneur.telegramBotToken');
    const shadow = new Map(store.readHostSettings({ namespace: 'runtime_shadow', ownerScope: 'global' }).items.map(item => [item.key, item.value]));
    assert.deepEqual(shadow.get('decision'), { decisionId: 'decision-a' });
    assert.deepEqual(shadow.get('evaluation'), { evaluationId: 'evaluation-a' });
    fs.writeFileSync(files.feedback, '{"signal":"keep"}\n');
    importLegacyRuntimeState(store, root);
    const afterRepair = new Map(store.readHostSettings({ namespace: 'runtime_shadow', ownerScope: 'global' }).items.map(item => [item.key, item]));
    assert.deepEqual(afterRepair.get('feedback').value, [{ signal: 'keep' }]);
    const revisions = [...afterRepair].map(([key, item]) => [key, item.revision]);
    importLegacyRuntimeState(store, root);
    assert.deepEqual(store.readHostSettings({ namespace: 'runtime_shadow', ownerScope: 'global' }).items.map(item => [item.key, item.revision]), revisions);
    assert.equal(store.appendDiagnosticEvent({ kind: 'operation', occurredAt: new Date().toISOString(), scope: 'runtime.health', payload: { status: 'ok' }, idempotencyKey: 'runtime-still-writable' }).scope, 'runtime.health');
  } finally {
    store.close();
    for (const file of [...Object.values(files), path.join(root, 'solomap.db-shm'), path.join(root, 'solomap.db-wal'), path.join(root, 'solomap.db')]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(runtime); fs.rmdirSync(root);
  }
});

test('an unreadable legacy source is diagnosed without blocking other imports or database writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-p4-unreadable-'));
  const runtime = path.join(root, 'runtime'); fs.mkdirSync(runtime);
  const cognitive = path.join(runtime, 'cognitive-config.json');
  const telegram = path.join(runtime, 'telegram-config.json');
  fs.writeFileSync(cognitive, JSON.stringify({ mode: 'agent_cli', agentCli: 'codex' }));
  fs.writeFileSync(telegram, JSON.stringify({ enabled: true, botToken: 'still-imported', chatId: '42' }));
  const store = new UnifiedDataStore(root);
  const readFileSync = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (path.resolve(String(file)) === path.resolve(cognitive)) {
      const error = new Error('legacy source cannot be read'); error.code = 'EACCES'; throw error;
    }
    return readFileSync.call(this, file, ...args);
  };
  try {
    assert.doesNotThrow(() => importLegacyRuntimeState(store, root));
    const config = new Map(store.readHostSettings({ namespace: 'telegram', ownerScope: 'global' }).items.map(item => [item.key, item.value]));
    assert.equal(config.get('botToken'), undefined);
    assert.equal(store.readHostSettings({ namespace: 'telegram', ownerScope: 'global' }).items.find(item => item.key === 'botToken').secretRef, 'vscode-secret://solopreneur.telegramBotToken');
    assert.equal(store.readDiagnosticEvents({ kind: 'error', limit: 10 }).items.some(item => item.scope === 'runtime.migration' && item.payload.source === 'runtime/cognitive-config.json'), true);
    assert.equal(store.appendDiagnosticEvent({ kind: 'operation', occurredAt: new Date().toISOString(), scope: 'runtime.health', payload: { status: 'ok' }, idempotencyKey: 'runtime-write-after-unreadable-source' }).scope, 'runtime.health');
  } finally {
    fs.readFileSync = readFileSync;
    store.close();
    for (const file of [cognitive, telegram, path.join(root, 'solomap.db-shm'), path.join(root, 'solomap.db-wal'), path.join(root, 'solomap.db')]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(runtime); fs.rmdirSync(root);
  }
});

test('stale legacy schedules cannot overwrite or disable current database schedules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-p4-schedule-conflict-'));
  const runtime = path.join(root, 'runtime'); const scheduledRoot = path.join(runtime, 'scheduled-tasks'); fs.mkdirSync(scheduledRoot, { recursive: true });
  const schedulePath = path.join(scheduledRoot, 'scheduled-tasks.json');
  const store = new UnifiedDataStore(root);
  try {
    const dueAt = Date.parse('2026-02-01T09:00:00.000Z');
    store.syncSchedules({ schedules: [
      { id: 'a', timezone: 'UTC', trigger: { kind: 'daily', timeOfDay: '09:00' }, enabled: true, nextDueAt: dueAt, task: { title: 'A new' } },
      { id: 'b', timezone: 'UTC', trigger: { kind: 'daily', timeOfDay: '10:00' }, enabled: true, nextDueAt: dueAt + 3600000, task: { title: 'B current' } }
    ], idempotencyKey: 'current-schedules' });
    fs.writeFileSync(schedulePath, JSON.stringify({ tasks: [{ occurrenceId: `a@${new Date(dueAt).toISOString()}`, taskId: 'a', dueAt: new Date(dueAt).toISOString(), status: 'pending', task: { id: 'a', scheduleKind: 'daily', timeOfDay: '09:00', title: 'A stale' } }], failures: [] }));
    importLegacyRuntimeState(store, root);
    assert.deepEqual(store.readScheduleLedger().tasks.map(item => [item.taskId, item.task.title]), [['a', 'A new'], ['b', 'B current']]);
    assert.equal(store.migrationSourceState(`runtime-state:${root}`, 'runtime/scheduled-tasks/scheduled-tasks.json').stage, 'conflict');
  } finally {
    store.close();
    for (const file of [schedulePath, path.join(root, 'solomap.db-shm'), path.join(root, 'solomap.db-wal'), path.join(root, 'solomap.db')]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(scheduledRoot); fs.rmdirSync(runtime); fs.rmdirSync(root);
  }
});

test('dead Telegram actions from every generation reconcile into the current delivery generation', () => {
  const value = fixture();
  try {
    for (const generation of [4, 5]) {
      value.store.acceptInboxMessage({ channel: 'telegram', sourceId: '88', generation, payload: { update_id: 88, message: { chat: { id: 42 } } }, idempotencyKey: `tg-${generation}-accept` });
      const claim = value.store.claimInboxMessages({ channel: 'telegram', generation, owner: { id: `dead-${generation}`, pid: 999999, birth: `dead-${generation}` }, limit: 1 }).items[0];
      value.store.beginInboxAction({ channel: 'telegram', sourceId: '88', generation, token: claim.token, action: 'stop', idempotencyKey: `tg-${generation}-begin` });
      if (generation === 5) value.store.settleInboxAction({ channel: 'telegram', sourceId: '88', generation, token: claim.token, action: 'stop', state: 'confirmed', idempotencyKey: 'tg-5-confirm' });
    }
    const reconciled = value.store.reconcileUnknownInboxActions({ channel: 'telegram', recoveryGeneration: 6 });
    assert.deepEqual(reconciled.items.map(item => [item.sourceId, item.state]), [['88', 'unknown'], ['88', 'confirmed']]);
    const deliveries = value.store.listNotificationDeliveries({ channel: 'telegram' }).items;
    assert.equal(deliveries.length, 2);
    assert.ok(deliveries.every(item => item.payload.replyGeneration === 6));
    assert.equal(value.store.reconcileUnknownInboxActions({ channel: 'telegram', recoveryGeneration: 6 }).items.length, 0);
  } finally { closeFixture(value); }
});
