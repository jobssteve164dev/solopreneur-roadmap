const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');

function owner(id) {
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  return { id, pid: process.pid, birth: 'proc:' + stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19] };
}
async function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-automation-delivery-'));
  const root = path.join(base, '.solomap-global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  let store = new UnifiedDataStore(root); let ops = createRuntimeDataOperations(store);
  return { root, project, store: () => store, call: (operation, input) => ops({ operation, input }),
    async reopen() { await ops.close(); store.close(); store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store); },
    async close() {
      await ops.close(); store.close();
      const unlink = file => { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
      unlink(path.join(root, 'solomap.db-wal')); unlink(path.join(root, 'solomap.db-shm')); unlink(path.join(root, 'solomap.db'));
      unlink(path.join(project, '.solopreneur', 'project.json'));
      const second = path.join(base, 'second');
      unlink(path.join(second, '.solopreneur', 'project.json'));
      if (fs.existsSync(path.join(project, '.solopreneur'))) fs.rmdirSync(path.join(project, '.solopreneur'));
      if (fs.existsSync(path.join(second, '.solopreneur'))) fs.rmdirSync(path.join(second, '.solopreneur'));
      fs.rmdirSync(root); fs.rmdirSync(project);
      if (fs.existsSync(second)) fs.rmdirSync(second);
      fs.rmdirSync(base);
    } };
}

test('a living UI owner remains exclusive beyond thirty seconds and a dead process is recoverable', async () => {
  const f = await fixture(); const clock = Date.now;
  try {
    const action = await f.call('prepare_automation_delivery', { root: f.project, intentId: 'slow-sound', event: { trigger: 'completed', action: 'sound' }, payload: { kind: 'sound' } });
    const first = await f.call('claim_automation_delivery', { id: action.id, owner: owner('a'), token: 'slow-a' });
    Date.now = () => clock() + 120000;
    assert.equal(await f.call('claim_automation_delivery', { id: action.id, owner: owner('b'), token: 'slow-b' }), null);
    await f.call('settle_automation_delivery', { id: action.id, token: first.token, state: 'queued' });
    await f.call('claim_automation_delivery', { id: action.id, owner: { id: 'dead', pid: 2147483647, birth: 'proc:dead' }, token: 'dead-token' });
    assert.ok(await f.call('claim_automation_delivery', { id: action.id, owner: owner('b'), token: 'recovered' }));
  } finally { Date.now = clock; await f.close(); }
});

test('a focus reminder commits all enabled actions atomically and recovers both after a lost reply', async () => {
  const f = await fixture();
  const deliveries = [
    { intentId: 'focus:one:notify', event: { trigger: 'focus_time', action: 'reminder' }, payload: { kind: 'notification', message: '专注时间到了', warning: false } },
    { intentId: 'focus:one:sound', event: { trigger: 'focus_time', action: 'reminder' }, payload: { kind: 'sound' } }
  ];
  try {
    await f.call('prepare_automation_deliveries', { root: f.project, deliveries, metadataOnly: true });
    await f.reopen();
    const replay = await f.call('prepare_automation_deliveries', { root: f.project, deliveries, metadataOnly: true });
    assert.equal(replay.length, 2); assert.equal((await f.call('list_automation_deliveries', {})).items.length, 2);
    await assert.rejects(f.call('prepare_automation_deliveries', { root: f.project, deliveries: [{ ...deliveries[0], intentId: 'focus:bad:notify' }, { ...deliveries[1], intentId: 'focus:bad:sound', payload: { kind: 'invalid' } }] }), /invalid_automation_delivery/);
    assert.equal((await f.call('list_automation_deliveries', {})).items.length, 2, 'an invalid second action cannot leave a half reminder');
  } finally { await f.close(); }
});

test('an extension reload in the same host process releases obsolete delivery claims and fences the previous instance', async () => {
  const f = await fixture(); const previous = owner('extension-before-reload'); const current = owner('extension-after-reload');
  try {
    await f.call('register_automation_ui_owner', { owner: previous });
    const action = await f.call('prepare_automation_delivery', { root: f.project, intentId: 'reload-notice', event: { trigger: 'completed', action: 'notify' }, payload: { kind: 'notification', message: '保留原通知', warning: false } });
    await f.call('claim_automation_delivery', { id: action.id, owner: previous, token: 'old-instance' });
    await f.reopen();
    await f.call('register_automation_ui_owner', { owner: current });
    await f.call('register_automation_ui_owner', { owner: previous });
    await assert.rejects(f.call('claim_automation_delivery', { id: action.id, owner: previous, token: 'obsolete' }), /automation_ui_owner_obsolete/);
    const claimed = await f.call('claim_automation_delivery', { id: action.id, owner: current, token: 'new-instance' });
    assert.equal(claimed.payload.message, '保留原通知');
    await assert.rejects(f.call('settle_automation_delivery', { id: action.id, token: 'old-instance', state: 'delivered' }), /automation_delivery_lease_lost/);
  } finally { await f.close(); }
});

test('a settled claim token cannot be reused for another UI attempt', async () => {
  const f = await fixture();
  try {
    const action = await f.call('prepare_automation_delivery', { root: f.project, intentId: 'token-reuse', event: { trigger: 'completed', action: 'sound' }, payload: { kind: 'sound' } });
    await f.call('claim_automation_delivery', { id: action.id, owner: owner('a'), token: 'attempt-one' });
    await f.call('settle_automation_delivery', { id: action.id, token: 'attempt-one', state: 'queued' });
    await assert.rejects(f.call('claim_automation_delivery', { id: action.id, owner: owner('a'), token: 'attempt-one' }), /automation_delivery_token_reused/);
    assert.ok(await f.call('claim_automation_delivery', { id: action.id, owner: owner('a'), token: 'attempt-two' }));
  } finally { await f.close(); }
});

test('the original live UI instance recovers its committed claim after losing the response token', async () => {
  const f = await fixture(); const original = owner('same-live-instance');
  try {
    const action = await f.call('prepare_automation_delivery', { root: f.project, intentId: 'lost-claim', event: { trigger: 'completed', action: 'sound' }, payload: { kind: 'sound' } });
    const claim = await f.call('claim_automation_delivery', { id: action.id, owner: original, token: 'committed-token' });
    const retry = await f.call('claim_automation_delivery', { id: action.id, owner: original, token: 'new-request-token' });
    assert.equal(retry?.token, claim.token, 'the same live instance must recover the exact original attempt');
    assert.equal(retry.revision, claim.revision);
    assert.equal(await f.call('claim_automation_delivery', { id: action.id, owner: owner('different-live-window'), token: 'other-window' }), null);
    assert.equal(await f.call('claim_automation_delivery', { id: action.id, owner: { ...original, birth: 'proc:another-process' }, token: 'wrong-birth' }), null);
    assert.equal(await f.call('claim_automation_delivery', { id: action.id, owner: { ...original, pid: original.pid + 1 }, token: 'wrong-pid' }), null);
  } finally { await f.close(); }
});

test('a UI effect started by a dead owner remains unknown and is never displayed by a replacement owner', async () => {
  const f = await fixture();
  try {
    const action = await f.call('prepare_automation_delivery', { root: f.project, intentId: 'crash-after-visible', event: { trigger: 'completed', action: 'notify' }, payload: { kind: 'notification', message: '只显示一次', warning: false } });
    const dead = { id: 'crashed-window', pid: 2147483647, birth: 'proc:dead' };
    const claim = await f.call('claim_automation_delivery', { id: action.id, owner: dead, token: 'crashed-attempt' });
    await f.call('begin_automation_delivery', { id: action.id, token: claim.token });
    await f.reopen();
    const replay = await f.call('prepare_automation_delivery', { root: f.project, intentId: 'crash-after-visible', event: { trigger: 'completed', action: 'notify' }, payload: { kind: 'notification', message: '只显示一次', warning: false } });
    assert.equal(replay.state, 'delivery_unknown');
    assert.equal((await f.call('list_automation_deliveries', {})).items.length, 0);
    assert.equal(await f.call('claim_automation_delivery', { id: action.id, owner: owner('replacement-window'), token: 'replacement-attempt' }), null);
  } finally { await f.close(); }
});

test('Windows delivery ownership checks the process creation marker and recovers a reused PID', async () => {
  const filename = path.resolve(__dirname, '../out/db/unifiedDataStore.js'); const nativeRequire = createRequire(filename);
  let created = '638954012345678901'; let probes = 0;
  const mockedProcess = { ...process, platform: 'win32', kill: () => {} };
  const mockedFs = { ...fs, readFileSync: (...args) => { if (String(args[0]).startsWith('/proc/')) throw new Error('no-proc'); return fs.readFileSync(...args); } };
  const mockedChildProcess = { ...require('node:child_process'), execFileSync: (command, args) => {
    if (command !== 'powershell.exe') throw new Error('no-ps');
    probes++; assert.ok(args.some(arg => /Get-Process -Id 42/.test(arg))); return created + '\r\n';
  } };
  const modules = { fs: mockedFs, child_process: mockedChildProcess };
  function load(file) {
    const resolved = nativeRequire.resolve(file); const localRequire = createRequire(resolved); const exports = {}; const module = { exports };
    vm.runInNewContext(fs.readFileSync(resolved, 'utf8'), { exports, module, require: id => modules[id] || (id.endsWith('processIdentity.js') ? load(id.startsWith('..') ? id : '../processIdentity.js') : localRequire(id)), process: mockedProcess, Buffer, console, setTimeout, clearTimeout }, { filename: resolved });
    return module.exports;
  }
  const WindowsStore = load(filename).UnifiedDataStore;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-windows-delivery-owner-')); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new WindowsStore(path.join(base, 'global')); const ops = createRuntimeDataOperations(store);
  try {
    const action = await ops({ operation: 'prepare_automation_delivery', input: { root: project, intentId: 'windows-notice', event: { trigger: 'completed', action: 'notify' }, payload: { kind: 'notification', message: 'Windows 提醒', warning: false } } });
    const first = { id: 'first-window', pid: 42, birth: 'win32:' + created };
    await ops({ operation: 'claim_automation_delivery', input: { id: action.id, owner: first, token: 'windows-first' } });
    assert.equal(await ops({ operation: 'claim_automation_delivery', input: { id: action.id, owner: { ...first, id: 'second-window' }, token: 'windows-blocked' } }), null);
    assert.equal(probes, 1, 'the live owner must be verified using its Windows creation time');
    created = '638954012345678902';
    const recovered = await ops({ operation: 'claim_automation_delivery', input: { id: action.id, owner: { id: 'new-process', pid: 42, birth: 'win32:' + created }, token: 'windows-recovered' } });
    assert.equal(recovered?.token, 'windows-recovered', 'a reused PID must not keep the dead owner exclusive');
    assert.equal(probes, 2);
    await assert.rejects(ops({ operation: 'settle_automation_delivery', input: { id: action.id, token: 'windows-first', state: 'delivered' } }), /automation_delivery_lease_lost/);
  } finally { await ops.close(); store.close(); }
});

test('the shared Windows liveness probe preserves an existing ps birth marker', () => {
  const prototype = UnifiedDataStore.prototype.hasLiveRunProcess.toString();
  const marker = 'Fri Oct 09 08:00:00 2026'; let psCalls = 0;
  const probe = vm.runInNewContext('(function' + prototype.slice(prototype.indexOf('(')) + ')', {
    process: { platform: 'win32', kill: () => {} },
    fs: { readFileSync: () => { throw new Error('no-proc'); } },
    childProcess: { execFileSync: command => { assert.equal(command, 'ps'); psCalls++; return marker; } },
    processIdentity_js_1: { readWindowsProcessBirthMarker: () => 'win32:638954012345678901' }
  });
  assert.equal(probe({ process_pid: 42, process_birth: 'ps:' + marker }), true, 'a living wrapper with the existing ps identity cannot be recovered as dead');
  assert.equal(psCalls, 1);
  assert.equal(probe({ process_pid: 42, process_birth: 'ps:older process' }), false, 'the legacy format must still detect PID reuse');
});

test('Windows ps owners remain exclusive through formal run recovery, delivery, settlement and effects', async () => {
  const f = await fixture(); const store = f.store(); const { RunRecovery } = require('../out/runRecovery.js');
  let startedAt = 'Fri Oct 09 08:00:00 2026';
  const marker = 'ps:' + startedAt; const owner = { id: 'existing-ps-window', pid: 42, birth: marker };
  const competitor = { ...owner, id: 'other-window' };
  const implementation = store.hasLiveRunProcess.toString();
  store.hasLiveRunProcess = vm.runInNewContext('(function' + implementation.slice(implementation.indexOf('(')) + ')', {
    process: { platform: 'win32', kill: () => {} }, fs: { readFileSync: () => { throw new Error('no-proc'); } },
    childProcess: { execFileSync: command => { assert.equal(command, 'ps'); return startedAt; } },
    processIdentity_js_1: { readWindowsProcessBirthMarker: () => 'win32:638954012345678901' }
  });
  const recovery = new RunRecovery(store);
  const prepare = (id, extra = {}) => f.call('prepare_run', { root: f.project, executionLogId: id, nodeId: 'step', runKind: 'step', prompt: '原任务', command: 'actual command', userMessage: '保持实际任务', metadata: { interactiveSession: true }, idempotencyKey: `ps-run:${id}`, ...extra });
  try {
    const run = await prepare(1, { metadata: { interactiveSession: true, agentPid: 42, processBirth: marker } });
    await recovery.recover();
    assert.equal((await f.call('read_run_state', { projectId: run.projectId, executionLogId: 1 })).status.status, 'Running');
    await assert.rejects(f.call('claim_run', { projectId: run.projectId, executionLogId: 1, expectedRevision: run.revision, idempotencyKey: 'ps-live-wrapper' }), /run_owner_alive/);
    const pending = await prepare(2, { deliveryOwner: owner });
    assert.equal((await f.call('list_run_deliveries', {})).items.length, 0);
    await assert.rejects(f.call('claim_run_delivery', { projectId: pending.projectId, executionLogId: 2, generation: pending.generation, expectedRevision: pending.revision, owner: competitor, idempotencyKey: 'ps-delivery-competing' }), /run_delivery_owner_alive/);
    const source = await prepare(3);
    const done = await f.call('checkpoint_run', { projectId: source.projectId, executionLogId: 3, generation: source.generation, proof: source.proof, expectedRevision: source.revision, expectedTurnId: source.turnId, action: 'complete', outcome: 'partial', summary: '正式来源', idempotencyKey: 'ps-done' });
    const scope = { projectId: source.projectId, executionLogId: 3, generation: done.generation, expectedRevision: done.revision, expectedTurnId: done.turnId };
    const lease = await f.call('claim_run_consumer', { ...scope, owner });
    assert.equal(await f.call('claim_run_consumer', { ...scope, owner: competitor }), null);
    await f.call('commit_run_settlement', { ...scope, token: lease.token, journal: { agentCli: 'claude', command: 'actual command', output: '完整实际结果', status: 'In Progress' }, digest: { schemaVersion: 2, nodeId: 'step', executionLogId: 3, runId: 'step:3' }, effects: [{ kind: 'automation', payload: { original: '完整后续动作' } }], idempotencyKey: 'ps-settlement' });
    const effect = (await f.call('list_run_effects', { projectId: source.projectId })).items[0];
    const held = await f.call('claim_run_effect', { projectId: source.projectId, effectId: effect.effectId, owner });
    assert.equal(await f.call('claim_run_effect', { projectId: source.projectId, effectId: effect.effectId, owner: competitor }), null);
    startedAt = 'Fri Oct 09 08:00:01 2026';
    const resumed = await f.call('claim_run_effect', { projectId: source.projectId, effectId: effect.effectId, owner: { ...competitor, birth: 'ps:' + startedAt } });
    assert.ok(resumed); assert.notEqual(resumed.token, held.token);
  } finally { await recovery.close(); await f.close(); }
});

test('a committed UI delivery survives a lost enqueue reply and restart with its original complete payload', async () => {
  const f = await fixture();
  const original = '原用户提醒🌿'.repeat(10000);
  const intent = { root: f.project, intentId: 'scheduled:occurrence:reminder', event: { trigger: 'scheduled_time', action: 'reminder', title: '原标题', status: 'ok' }, payload: { kind: 'notification', message: original, warning: false } };
  try {
    const prepared = await f.call('prepare_automation_delivery', intent);
    assert.equal(prepared.state, 'queued');
    await f.reopen();
    const replayed = await f.call('prepare_automation_delivery', { ...intent, event: { ...intent.event, title: '用户后来编辑的标题' }, payload: { ...intent.payload, message: '后来编辑的通知' } });
    assert.equal(replayed.id, prepared.id); assert.deepEqual(replayed.payload, intent.payload);
    const page = await f.call('list_automation_deliveries', { limit: 1 });
    assert.equal(page.items.length, 1); assert.equal(page.items[0].id, prepared.id);
    const source = await f.call('read', { ref: prepared.objectId });
    assert.equal(JSON.parse(source.data.content).title, '原标题');
    assert.equal(JSON.parse(source.data.content).delivery.payload.message, original, 'the same formal source read must expose the complete notification text');
    assert.deepEqual(fs.readdirSync(path.join(f.project, '.solopreneur')), ['project.json']);
  } finally { await f.close(); }
});

test('two window owners cannot deliver the same UI action and failed acknowledgement remains recoverable', async () => {
  const f = await fixture();
  try {
    const prepared = await f.call('prepare_automation_delivery', { root: f.project, intentId: 'effect:notify', event: { trigger: 'completed', action: 'notify', status: 'ok' }, payload: { kind: 'notification', message: '任务已完成', warning: false } });
    const claimed = await f.call('claim_automation_delivery', { id: prepared.id, owner: owner('window-a'), token: 'claim-a' });
    assert.ok(claimed);
    assert.equal(await f.call('claim_automation_delivery', { id: prepared.id, owner: owner('window-b'), token: 'claim-b' }), null);
    await assert.rejects(f.call('settle_automation_delivery', { id: prepared.id, token: 'other', state: 'delivered' }), /automation_delivery_lease_lost/);
    await f.call('settle_automation_delivery', { id: prepared.id, token: claimed.token, state: 'queued', error: '显示窗口已关闭' });
    const resumed = await f.call('claim_automation_delivery', { id: prepared.id, owner: owner('window-b'), token: 'claim-b' });
    assert.ok(resumed); assert.deepEqual(resumed.payload, prepared.payload);
    await assert.rejects(f.call('settle_automation_delivery', { id: prepared.id, token: claimed.token, state: 'delivered' }), /automation_delivery_lease_lost/);
    const done = await f.call('settle_automation_delivery', { id: prepared.id, token: resumed.token, state: 'delivered' });
    assert.equal(done.state, 'delivered');
    await f.reopen();
    assert.equal(await f.call('claim_automation_delivery', { id: prepared.id, owner: owner('window-c'), token: 'claim-c' }), null);
    assert.equal((await f.call('list_automation_deliveries', {})).items.length, 0);
    assert.deepEqual(await f.call('settle_automation_delivery', { id: prepared.id, token: resumed.token, state: 'delivered' }), done);
  } finally { await f.close(); }
});

test('UI delivery intent identities remain isolated between projects and reject changes of action kind', async () => {
  const f = await fixture(); const second = path.join(path.dirname(f.project), 'second'); fs.mkdirSync(second);
  try {
    const input = { root: f.project, intentId: 'same-intent', event: { trigger: 'completed', action: 'notify' }, payload: { kind: 'notification', message: '项目A', warning: false } };
    const a = await f.call('prepare_automation_delivery', input);
    const b = await f.call('prepare_automation_delivery', { ...input, root: second, payload: { ...input.payload, message: '项目B' } });
    assert.notEqual(a.id, b.id); assert.notEqual(a.projectId, b.projectId);
    await assert.rejects(f.call('prepare_automation_delivery', { ...input, payload: { kind: 'sound' } }), /automation_delivery_identity_conflict/);
    await assert.rejects(f.call('prepare_automation_delivery', { ...input, intentId: 'secret-invalid', payload: { ...input.payload, botToken: 'must-not-store' } }), /invalid_automation_delivery/);
  } finally { await f.close(); }
});

test('cancelling an obsolete UI action keeps its original evidence and prevents later delivery', async () => {
  const f = await fixture();
  try {
    const action = await f.call('prepare_automation_delivery', { root: f.project, intentId: 'cancelled-focus', event: { trigger: 'focus_time', action: 'reminder', focusMinutes: 25 }, payload: { kind: 'notification', message: '旧专注提醒', warning: false } });
    const claim = await f.call('claim_automation_delivery', { id: action.id, owner: owner('window-a'), token: 'cancel-focus' });
    assert.equal((await f.call('settle_automation_delivery', { id: action.id, token: claim.token, state: 'cancelled' })).state, 'cancelled');
    await f.reopen();
    assert.equal(await f.call('claim_automation_delivery', { id: action.id, owner: owner('window-b'), token: 'after-cancel' }), null);
    assert.equal((await f.call('list_automation_deliveries', {})).items.length, 0);
    assert.equal(JSON.parse((await f.call('read', { ref: action.objectId })).data.content).focusMinutes, 25);
  } finally { await f.close(); }
});

test('unchanged UI delivery metadata retries do not decode the complete notification payload again', async () => {
  const f = await fixture();
  const input = { root: f.project, intentId: 'large-notice', event: { trigger: 'completed', action: 'notification' }, payload: { kind: 'notification', message: '完整历史正文🌿'.repeat(20000), warning: false }, metadataOnly: true };
  let content; const store = f.store(); let decoded = 0;
  try {
    const prepared = await f.call('prepare_automation_delivery', input);
    const source = await f.call('read', { ref: prepared.objectId, view: 'metadata' });
    const contentId = source.data.content_id; content = store.content;
    store.content = function(id, ...args) { if (id === contentId) decoded++; return content.call(this, id, ...args); };
    for (let index = 0; index < 20; index++) {
      const repeated = await f.call('prepare_automation_delivery', input);
      assert.equal(repeated.id, prepared.id); assert.equal(repeated.state, 'queued'); assert.equal(repeated.payload.kind, 'notification');
    }
    assert.equal(decoded, 0, 'queue preparation must return indexed metadata rather than reloading the large message before every claim');
    const claimed = await f.call('claim_automation_delivery', { id: prepared.id, owner: owner('window-a'), token: 'large-notice-claim' });
    assert.equal(claimed.payload.message, input.payload.message);
    assert.equal(decoded, 1, 'the accepted owner reads the full message once for the actual delivery');
  } finally { if (content) store.content = content; await f.close(); }
});
