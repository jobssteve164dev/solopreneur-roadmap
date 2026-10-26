const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { prepareAgentRun } = require('../out/agentRunPreparation.js');
const { snapshotWorkspace, workspaceDocumentPurpose } = require('../out/runWorkspace.js');

function duration(row) {
  const boundary = { ...row, type: 'system', subtype: 'turn_duration', uuid: `${row.uuid}-duration`, parentUuid: row.uuid, durationMs: 1 };
  delete boundary.message;
  return boundary;
}

async function fixture(unicodeHome = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-claude-native-'));
  const root = path.join(base, 'data'); const project = path.join(base, 'project');
  const configDirOverride = path.join(base, unicodeHome ? 'claude-home-e\u0301' : 'claude-home');
  const claudeHome = configDirOverride.normalize('NFC'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDirOverride;
  let run;
  try {
    run = await prepareAgentRun({ agentCli: 'claude', selectedModel: '', prompt: '完整用户目标', workspaceRoot: project,
      nodeId: '__solo__', executionLogId: 1, userMessage: '完整用户目标', runKind: 'solo', globalDataPath: root, taskPermissionMode: 'auto' }, call);
  } finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; }
  const scope = { projectId: run.projectId, executionLogId: 1, generation: run.generation };
  const claimed = await call('claim_run', { ...scope, expectedRevision: run.revision, agentPid: process.pid, idempotencyKey: 'claude-native-owner' });
  scope.generation = claimed.generation;
  const directory = path.join(claudeHome, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(directory, { recursive: true });
  const transcript = path.join(directory, run.status.plannedNativeSessionId + '.jsonl');
  const row = { type: 'user', uuid: 'native-user-1', sessionId: run.status.plannedNativeSessionId, cwd: project,
    timestamp: new Date().toISOString(), isSidechain: false, message: { role: 'user', content: '完整用户目标🌿\n'.repeat(20000) } };
  return { base, root, project, claudeHome, configDirOverride, store, ops, call, run: claimed, scope, transcript, row };
}

test('Claude end_turn in one append batch cannot seal a reply before later blocks and its whole-turn boundary', async () => {
  const f = await fixture();
  try {
    const block = (uuid, index, text, parentUuid) => ({ ...f.row, type: 'assistant', uuid, parentUuid, timestamp: new Date().toISOString(), apiBlockIndex: index,
      message: { id: 'split-message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
    const first = block('split-1', 0, '第一块🌿\n', f.row.uuid);
    fs.writeFileSync(f.transcript, [f.row, first].map(JSON.stringify).join('\n') + '\n');
    await f.call('recover_run_executions', {});
    assert.equal(f.store.readMetadata(f.run.turnId).data.finished_at, null, 'an API response stop is not a whole-turn boundary');
    const second = block('split-2', 1, '第二块🧭\n', first.uuid);
    const boundary = { ...f.row, type: 'system', subtype: 'turn_duration', uuid: 'split-duration', parentUuid: second.uuid, timestamp: new Date().toISOString(), durationMs: 10 };
    fs.appendFileSync(f.transcript, [second, boundary].map(JSON.stringify).join('\n') + '\n');
    await f.call('recover_run_executions', {});
    assert.notEqual(f.store.readMetadata(f.run.turnId).data.finished_at, null);
    assert.equal(Buffer.from(f.store.readRunDocument(f.run.projectId, 1, `native_reply_${f.run.turnId.replace(/-/g, '')}`).bytes, 'base64').toString('utf8'), '第一块🌿\n\n第二块🧭\n');
  } finally { await f.ops.close(); f.store.close(); }
});

for (const crashAfterReceipt of [false, true]) test(`a confirmed Claude child exit preserves the complete print reply without native hooks (cold interruption=${crashAfterReceipt})`, async () => {
  const f = await fixture(); let child;
  try {
    child = require('node:child_process').spawn(process.execPath, ['-e', "process.stdout.write('ready');process.stdin.once('data',()=>process.exit(0))"], { stdio: ['pipe', 'pipe', 'pipe'] });
    await require('node:events').once(child.stdout, 'data');
    const stat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
    const birth = 'proc:' + stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19];
    let state = f.store.readRunCheckpointState(f.run.projectId, 1);
    f.store.patchRunState(f.run.projectId, { ...f.scope, expectedRevision: state.revision, patch: { agentChildPid: child.pid, processChildBirth: birth }, idempotencyKey: 'exit-child' });
    const reply = { ...f.row, type: 'assistant', uuid: 'print-reply', parentUuid: f.row.uuid, message: { role: 'assistant', id: 'print', content: [{ type: 'text', text: '完整原生正文🌿\n' }], stop_reason: 'end_turn' } };
    fs.writeFileSync(f.transcript, [f.row, reply].map(JSON.stringify).join('\n') + '\n');
    await f.call('recover_run_executions', {});
    assert.equal(f.store.readMetadata(f.run.turnId).data.finished_at, null, 'a live child and API end_turn must not seal the native turn');
    const exited = require('node:events').once(child, 'exit'); child.stdin.end('exit'); await exited;
    if (crashAfterReceipt) {
      const write = f.store.writeRunDocument.bind(f.store);
      f.store.writeRunDocument = (...args) => { const result = write(...args); if (args[1].purpose.startsWith('claude_exit_')) throw Error('forced_after_exit_receipt'); return result; };
      state = f.store.readRunCheckpointState(f.run.projectId, 1);
      await assert.rejects(f.call('checkpoint_run', { ...f.scope, proof: f.run.proof, expectedRevision: state.revision, expectedTurnId: state.turnId, action: 'session-close', exitCode: 0, idempotencyKey: 'print-exit-close' }), /forced_after_exit_receipt/);
      await f.ops.close(); f.store.close(); f.store = new UnifiedDataStore(f.root); f.ops = createRuntimeDataOperations(f.store);
      f.call = (operation, input) => f.ops({ operation, input });
    }
    for (;;) {
      state = f.store.readRunCheckpointState(f.run.projectId, 1);
      try {
        await f.call('checkpoint_run', { ...f.scope, proof: f.run.proof, expectedRevision: state.revision, expectedTurnId: state.turnId, action: 'session-close', exitCode: 0, idempotencyKey: 'print-exit-close' });
        break;
      } catch (error) { if (error.message !== 'revision_conflict') throw error; }
    }
    const document = f.store.readRunDocument(f.run.projectId, 1, `native_reply_${f.run.turnId.replace(/-/g, '')}`);
    assert.ok(document, 'real process closure must save the full native reply');
    assert.equal(Buffer.from(document.bytes, 'base64').toString('utf8'), reply.message.content[0].text);
    assert.equal(f.store.read(f.run.turnId).data.outcome, 'partial');
    assert.equal(f.store.readRunCheckpointState(f.run.projectId, 1).status.interactiveSessionClosed, true);
  } finally {
    if (child && child.exitCode === null) { const exited = require('node:events').once(child, 'exit'); child.stdin.end('exit'); await exited; }
    await f.ops.close(); f.store.close();
  }
});

for (const action of ['session-close', 'complete']) test(`a live Claude child cannot seal native output with ${action} and a submitted exit code`, async () => {
  const f = await fixture();
  try {
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const birth = 'proc:' + stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19];
    let state = f.store.readRunCheckpointState(f.run.projectId, 1);
    f.store.patchRunState(f.run.projectId, { ...f.scope, expectedRevision: state.revision, patch: { agentChildPid: process.pid, processChildBirth: birth }, idempotencyKey: 'live-child' });
    fs.writeFileSync(f.transcript, JSON.stringify(f.row) + '\n');
    await f.call('recover_run_executions', {});
    state = f.store.readRunCheckpointState(f.run.projectId, 1);
    if (action === 'session-close') {
      await assert.rejects(f.call('checkpoint_run', { ...f.scope, proof: f.run.proof, expectedRevision: state.revision, expectedTurnId: state.turnId,
        action, exitCode: 0, idempotencyKey: 'premature-close' }), /native_session_still_running/);
      assert.notEqual(f.store.readRunCheckpointState(f.run.projectId, 1).status.interactiveSessionClosed, true);
      return;
    }
    await f.call('checkpoint_run', { ...f.scope, proof: f.run.proof, expectedRevision: state.revision, expectedTurnId: state.turnId,
      action: 'complete', exitCode: 0, outcome: 'partial', summary: '业务结果仍可提交', idempotencyKey: 'live-business-result' });
    const after = f.store.readRunCheckpointState(f.run.projectId, 1);
    assert.equal(after.status.checkpointSummary, '业务结果仍可提交');
    assert.equal(after.status.nativeOutputPending, true, 'the user-facing decision can be saved while native output remains open');
    assert.equal(f.store.readRunDocument(f.run.projectId, 1, `native_reply_${f.run.turnId.replace(/-/g, '')}`), null);
  } finally { await f.ops.close(); f.store.close(); }
});

test('Claude machine completion persists before flush and only seals after every pinned assistant UUID survives cold recovery', async () => {
  const f = await fixture(); let store = f.store; let ops = f.ops;
  try {
    let state = store.readRunCheckpointState(f.run.projectId, 1);
    store.patchRunState(f.run.projectId, { ...f.scope, expectedRevision: state.revision, patch: { claudeNativeContract: 'mods-v1' }, idempotencyKey: 'machine-contract' });
    const block = (uuid, index, text, parentUuid) => ({ ...f.row, type: 'assistant', uuid, parentUuid, timestamp: new Date().toISOString(), apiBlockIndex: index,
      message: { id: 'fenced-message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
    const first = block('fence-1', 0, '第一块全文🌿\n', f.row.uuid); const second = block('fence-2', 1, '第二块全文🧭\n', first.uuid);
    fs.writeFileSync(f.transcript, [f.row, first].map(JSON.stringify).join('\n') + '\n');
    const event = { schemaVersion: 1, sequence: 1, sessionId: f.row.sessionId, providerTurnId: require('node:crypto').randomUUID(), userUuid: f.row.uuid,
      assistantUuids: [first.uuid, second.uuid], startedAt: f.row.timestamp, completedAt: new Date().toISOString(), reason: 'answer' };
    const input = { ...f.scope, proof: f.run.proof, event };
    await f.call('record_claude_native_event', input);
    assert.equal(store.readMetadata(f.run.turnId).data.finished_at, null);
    assert.equal(store.readRunCheckpointState(f.run.projectId, 1).status.claudeNativeEventHead, 1);
    await ops.close(); store.close(); store = new UnifiedDataStore(f.root); ops = createRuntimeDataOperations(store);
    fs.appendFileSync(f.transcript, JSON.stringify(second) + '\n');
    await ops({ operation: 'recover_run_executions', input: {} });
    assert.notEqual(store.readMetadata(f.run.turnId).data.finished_at, null);
    assert.equal(Buffer.from(store.readRunDocument(f.run.projectId, 1, `native_reply_${f.run.turnId.replace(/-/g, '')}`).bytes, 'base64').toString('utf8'), '第一块全文🌿\n\n第二块全文🧭\n');
    const revision = store.readRunCheckpointState(f.run.projectId, 1).revision;
    await ops({ operation: 'record_claude_native_event', input });
    assert.equal(store.readRunCheckpointState(f.run.projectId, 1).revision, revision);
    await assert.rejects(ops({ operation: 'record_claude_native_event', input: { ...input, proof: 'wrong-proof', event: { ...event, sequence: 2 } } }), /proof/);
  } finally { await ops.close(); store.close(); }
});

for (const mode of ['settled', 'pending-ack', 'delayed-flush']) test(`Claude module reload restores an unfinished native turn and queued prompt (${mode})`, async () => {
  const reloadDuringAppend = mode === 'pending-ack'; const delayedFlush = mode === 'delayed-flush';
  const f = await fixture(); let pendingAppend; let releaseAppend;
  let withheldRow;
  try {
    const state = f.store.readRunCheckpointState(f.run.projectId, 1);
    f.store.patchRunState(f.run.projectId, { ...f.scope, expectedRevision: state.revision, patch: { claudeNativeObserverCapable: true }, idempotencyKey: 'reload-capable' });
    const source = fs.readFileSync(path.resolve(__dirname, '../resources/claude-observer/hooks/register.js'), 'utf8');
    const { register } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    const $ = { clock: { now: async () => Date.now(), sleep: async () => {} }, session: { id: async () => f.row.sessionId },
      env: { get: async name => ({ SOLOMAP_NODE_EXECUTABLE: '/node', SOLOMAP_TASK_COMMAND: '/checkpoint.js' })[name] },
      process: { run: async (argv, options) => {
        const event = JSON.parse(options.stdin);
        if (reloadDuringAppend && event.uuid === 'reload-tail-reply' && tailKept) await new Promise(resolve => { releaseAppend = resolve; });
        try {
        const result = await f.call(argv[2] === 'native-ready' ? 'record_claude_native_ready' : argv[2] === 'native-append' ? 'record_claude_native_append' : 'record_claude_native_event',
          { ...f.scope, proof: f.run.proof, ...(argv[2] === 'native-ready' ? { sessionId: event.sessionId } : { event }) });
        return { exitCode: 0, stdout: JSON.stringify({ nextSequence: Number(result.status.claudeNativeEventHead || 0) + 1, resume: result.claudeNativeResume }) };
        } catch (error) { return { exitCode: 3, stderr: error.message }; }
      } } };
    let hooks; let tailKept = false; let notifyKept;
    const tailCommitted = new Promise(resolve => { notifyKept = resolve; });
    const load = async () => { hooks = new Map(); register((name, handler) => hooks.set(name, handler)); await hooks.get('session.start')($, {}, async e => e); };
    const append = async row => {
      const kept = { uuid: row.uuid, message: { ...row.message, type: row.type } };
      assert.equal(await hooks.get('session.append')($, { uuid: row.uuid, door: row.type === 'user' ? 'prompt' : 'response', message: kept.message }, async () => {
        if (delayedFlush && row.uuid === 'reload-tail-reply') withheldRow = row;
        else fs.appendFileSync(f.transcript, JSON.stringify(row) + '\n');
        if (row.uuid === 'reload-tail-reply') { tailKept = true; notifyKept(); }
        return kept;
      }), kept);
    };
    await load(); await append(f.row);
    const firstId = require('node:crypto').randomUUID();
    await hooks.get('turn.start')($, { turnId: firstId }, async e => e);
    const first = { ...f.row, type: 'assistant', uuid: 'reload-first-reply', parentUuid: f.row.uuid, message: { role: 'assistant', id: 'reload-message', content: [{ type: 'text', text: '模块重载前的完整回复🌿\n' }], stop_reason: 'end_turn' } };
    await append(first);
    const queued = { ...f.row, uuid: 'reload-queued-user', message: { role: 'user', content: '模块重载后继续第二轮' } };
    await append(queued);
    let expectedReply = first.message.content[0].text;
    if (reloadDuringAppend || delayedFlush) {
      const tail = { ...first, uuid: 'reload-tail-reply', parentUuid: first.uuid, message: { ...first.message, content: [{ type: 'text', text: '不能遗漏的回复末块🧭\n' }] } };
      pendingAppend = append(tail); await tailCommitted;
      expectedReply += '\n' + tail.message.content[0].text;
    }
    await load();
    await hooks.get('turn.complete')($, { turnId: firstId, reason: 'answer' }, async e => e);
    if (delayedFlush) {
      assert.equal(f.store.readMetadata(f.run.turnId).data.finished_at, null, 'a restored UUID fence must wait for the actual tail body');
      assert.equal(f.store.readRunCheckpointState(f.run.projectId, 1).status.claudeNativeEventCursor, 1);
      fs.appendFileSync(f.transcript, JSON.stringify(withheldRow) + '\n');
      await f.call('recover_run_executions', {});
    }
    assert.notEqual(f.store.readMetadata(f.run.turnId).data.finished_at, null, 'reload must restore the original active turn and its committed assistant UUID');
    assert.equal(Buffer.from(f.store.readRunDocument(f.run.projectId, 1, `native_reply_${f.run.turnId.replace(/-/g, '')}`).bytes, 'base64').toString('utf8'), expectedReply);
    const secondId = require('node:crypto').randomUUID();
    await hooks.get('turn.start')($, { turnId: secondId }, async e => e);
    const next = f.store.readRunCheckpointState(f.run.projectId, 1);
    assert.notEqual(next.turnId, f.run.turnId); assert.equal(f.store.read(next.turnId).data.request_content, queued.message.content);
    const second = { ...first, uuid: 'reload-second-reply', parentUuid: queued.uuid, message: { ...first.message, id: 'reload-second', content: [{ type: 'text', text: '第二轮完整回复🧭\n' }] } };
    await append(second); await hooks.get('turn.complete')($, { turnId: secondId, reason: 'answer' }, async e => e);
    assert.equal(f.store.read(next.turnId).data.summary_content, second.message.content[0].text);
    assert.equal(f.store.readRunCheckpointState(f.run.projectId, 1).status.claudeNativeEventCursor, 4);
  } finally { releaseAppend?.(); await pendingAppend; await f.ops.close(); f.store.close(); }
});

test('Claude reload receipts retain compact UUIDs without rereading full native requests on every committed message', async t => {
  const f = await fixture();
  try {
    let state = f.store.readRunCheckpointState(f.run.projectId, 1);
    f.store.patchRunState(f.run.projectId, { ...f.scope, expectedRevision: state.revision, patch: { claudeNativeObserverCapable: true }, idempotencyKey: 'append-capable' });
    await f.call('record_claude_native_ready', { ...f.scope, proof: f.run.proof, sessionId: f.row.sessionId });
    fs.writeFileSync(f.transcript, JSON.stringify(f.row) + '\n');
    const event = { schemaVersion: 1, phase: 'start', sequence: 1, sessionId: f.row.sessionId, providerTurnId: require('node:crypto').randomUUID(), userUuid: f.row.uuid,
      assistantUuids: [], startedAt: f.row.timestamp, completedAt: f.row.timestamp, reason: 'answer' };
    await f.call('record_claude_native_event', { ...f.scope, proof: f.run.proof, event });
    let logBytes = 0; let documentBytes = 0;
    const readLog = f.store.readRunLog.bind(f.store); const readDocument = f.store.readRunDocument.bind(f.store);
    f.store.readRunLog = (...args) => { const result = readLog(...args); logBytes += Buffer.from(result.bytes, 'base64').length; return result; };
    f.store.readRunDocument = (...args) => { const result = readDocument(...args); if (result) documentBytes += Buffer.from(result.bytes, 'base64').length; return result; };
    try {
      for (let i = 0; i < 40; i++) {
        const input = { ...f.scope, proof: f.run.proof, event: { schemaVersion: 1, kind: 'assistant', sessionId: f.row.sessionId, userUuid: f.row.uuid, providerTurnId: event.providerTurnId, uuid: `reload-cost-${i}` } };
        await f.call('record_claude_native_append', input); await f.call('record_claude_native_append', input);
      }
      const ready = await f.call('record_claude_native_ready', { ...f.scope, proof: f.run.proof, sessionId: f.row.sessionId });
      assert.equal(ready.claudeNativeResume.active.assistantUuids.length, 40);
      assert.equal(logBytes, 0, 'committed UUID receipts must not reread the retained request or reply body');
      assert.ok(documentBytes < 50000, `compact receipt reads unexpectedly grew to ${documentBytes} bytes`);
      t.diagnostic(`messages=40 duplicatedDelivery=40 retainedRequestBytes=${Buffer.byteLength(JSON.stringify(f.row))} rawLogBodyBytesRead=${logBytes} compactDocumentBytesRead=${documentBytes}`);
    } finally { f.store.readRunLog = readLog; f.store.readRunDocument = readDocument; }
  } finally { await f.ops.close(); f.store.close(); }
});

test('Claude queued prompts cannot steal the current reply and retain their own machine turn after a cold reopen', async () => {
  const f = await fixture(); let store = f.store; let ops = f.ops;
  try {
    const state = store.readRunCheckpointState(f.run.projectId, 1);
    store.patchRunState(f.run.projectId, { ...f.scope, expectedRevision: state.revision, patch: { claudeNativeContract: 'mods-v1' }, idempotencyKey: 'queued-contract' });
    const queued = { ...f.row, uuid: 'queued-user', parentUuid: f.row.uuid, message: { role: 'user', content: '排队的第二轮请求' } };
    const assistant = (uuid, parentUuid, text) => ({ ...f.row, type: 'assistant', uuid, parentUuid, timestamp: new Date().toISOString(), message: { role: 'assistant', id: uuid, content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
    const first = assistant('queued-reply-1', f.row.uuid, '第一轮结果'); const second = assistant('queued-reply-2', queued.uuid, '第二轮结果');
    fs.writeFileSync(f.transcript, [f.row, queued, first, second].map(JSON.stringify).join('\n') + '\n');
    const event = (sequence, user, reply) => ({ schemaVersion: 1, sequence, sessionId: f.row.sessionId, providerTurnId: require('node:crypto').randomUUID(), userUuid: user.uuid,
      assistantUuids: [reply.uuid], startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), reason: 'answer' });
    await f.call('record_claude_native_event', { ...f.scope, proof: f.run.proof, event: event(1, f.row, first) });
    assert.equal(store.read(f.run.turnId).data.summary_content, '第一轮结果');
    await ops.close(); store.close(); store = new UnifiedDataStore(f.root); ops = createRuntimeDataOperations(store);
    await ops({ operation: 'record_claude_native_event', input: { ...f.scope, proof: f.run.proof, event: event(2, queued, second) } });
    const next = store.readRunCheckpointState(f.run.projectId, 1);
    assert.notEqual(next.turnId, f.run.turnId);
    assert.equal(store.read(next.turnId).data.request_content, '排队的第二轮请求');
    assert.equal(store.read(next.turnId).data.summary_content, '第二轮结果');
    assert.equal(store.read(f.run.turnId).data.summary_content, '第一轮结果');
  } finally { await ops.close(); store.close(); }
});

test('Claude whole-turn interruption before any assistant block closes a failed turn without inventing a reply', async () => {
  const f = await fixture();
  try {
    const state = f.store.readRunCheckpointState(f.run.projectId, 1);
    f.store.patchRunState(f.run.projectId, { ...f.scope, expectedRevision: state.revision, patch: { claudeNativeContract: 'mods-v1' }, idempotencyKey: 'abort-contract' });
    fs.writeFileSync(f.transcript, JSON.stringify(f.row) + '\n');
    const event = { schemaVersion: 1, sequence: 1, sessionId: f.row.sessionId, providerTurnId: require('node:crypto').randomUUID(), userUuid: f.row.uuid,
      assistantUuids: [], startedAt: f.row.timestamp, completedAt: new Date().toISOString(), reason: 'aborted' };
    await f.call('record_claude_native_event', { ...f.scope, proof: f.run.proof, event });
    const turn = f.store.read(f.run.turnId);
    assert.notEqual(turn.data.finished_at, null); assert.equal(turn.data.outcome, 'failed');
    assert.equal(Buffer.from(f.store.readRunDocument(f.run.projectId, 1, `native_reply_${f.run.turnId.replace(/-/g, '')}`).bytes, 'base64').length, 0);
    assert.equal(f.store.readRunCheckpointState(f.run.projectId, 1).status.claudeNativeEventCursor, 1);
  } finally { await f.ops.close(); f.store.close(); }
});

test('Claude event source relation and consumed cursor survive a cold interruption as one acknowledgement', async () => {
  const f = await fixture(); let store = f.store; let ops = f.ops;
  try {
    const state = store.readRunCheckpointState(f.run.projectId, 1);
    store.patchRunState(f.run.projectId, { ...f.scope, expectedRevision: state.revision, patch: { claudeNativeContract: 'mods-v1' }, idempotencyKey: 'ack-contract' });
    const reply = { ...f.row, type: 'assistant', uuid: 'ack-reply', parentUuid: f.row.uuid, message: { role: 'assistant', id: 'ack-message', content: [{ type: 'text', text: '中断后完整正文🌿\n' }] } };
    fs.writeFileSync(f.transcript, [f.row, reply].map(JSON.stringify).join('\n') + '\n');
    const event = { schemaVersion: 1, sequence: 1, sessionId: f.row.sessionId, providerTurnId: require('node:crypto').randomUUID(), userUuid: f.row.uuid,
      assistantUuids: [reply.uuid], startedAt: f.row.timestamp, completedAt: new Date().toISOString(), reason: 'answer' };
    const patch = store.patchRunState.bind(store);
    store.patchRunState = (...args) => { if (args[1].patch.claudeNativeEventCursor) throw Error('forced_cursor_ack_failure'); return patch(...args); };
    await assert.rejects(f.call('record_claude_native_event', { ...f.scope, proof: f.run.proof, event }), /forced_cursor_ack_failure/);
    const unacknowledged = store.readRunDocument(f.run.projectId, 1, `claude_event_${f.scope.generation}_1`);
    assert.deepEqual(store.rows("SELECT target_id FROM relations WHERE source_id=? AND relation='source'", [unacknowledged.objectId]), [], 'failed cursor acknowledgement must roll back the source relation too');
    await ops.close(); store.close(); store = new UnifiedDataStore(f.root); ops = createRuntimeDataOperations(store);
    await ops({ operation: 'record_claude_native_event', input: { ...f.scope, proof: f.run.proof, event } });
    const final = store.readRunCheckpointState(f.run.projectId, 1);
    assert.equal(final.status.claudeNativeEventCursor, 1);
    assert.equal(final.turnId, f.run.turnId);
    assert.equal(Buffer.from(store.readRunDocument(f.run.projectId, 1, `native_reply_${f.run.turnId.replace(/-/g, '')}`).bytes, 'base64').toString('utf8'), reply.message.content[0].text);
    const document = store.readRunDocument(f.run.projectId, 1, `claude_event_${f.scope.generation}_1`);
    assert.deepEqual(store.rows("SELECT target_id FROM relations WHERE source_id=? AND relation='source'", [document.objectId]).map(row => row.target_id), [f.run.turnId]);
  } finally { await ops.close(); store.close(); }
});

test('Claude machine event body and queue head roll back together and reject changed replay or old ownership', async () => {
  const f = await fixture();
  const patch = f.store.patchRunState.bind(f.store);
  try {
    const state = f.store.readRunCheckpointState(f.run.projectId, 1);
    patch(f.run.projectId, { ...f.scope, expectedRevision: state.revision, patch: { claudeNativeContract: 'mods-v1' }, idempotencyKey: 'atomic-contract' });
    const event = { schemaVersion: 1, sequence: 1, sessionId: f.row.sessionId, providerTurnId: require('node:crypto').randomUUID(), userUuid: f.row.uuid,
      assistantUuids: ['not-flushed-yet'], startedAt: f.row.timestamp, completedAt: new Date().toISOString(), reason: 'answer' };
    f.store.patchRunState = (...args) => { if (args[1].patch.claudeNativeEventHead) throw Error('forced_atomic_failure'); return patch(...args); };
    await assert.rejects(f.call('record_claude_native_event', { ...f.scope, proof: f.run.proof, event }), /forced_atomic_failure/);
    assert.equal(f.store.readRunDocument(f.run.projectId, 1, `claude_event_${f.scope.generation}_1`), null);
    assert.equal(f.store.readRunCheckpointState(f.run.projectId, 1).status.claudeNativeEventHead || 0, 0);
    f.store.patchRunState = patch;
    await f.call('record_claude_native_event', { ...f.scope, proof: f.run.proof, event });
    await assert.rejects(f.call('record_claude_native_event', { ...f.scope, proof: f.run.proof, event: { ...event, userUuid: 'different-user' } }), /native_event_conflict/);
    await assert.rejects(f.call('record_claude_native_event', { ...f.scope, generation: f.scope.generation + 1, proof: f.run.proof, event }), /run_owner_conflict/);
  } finally { f.store.patchRunState = patch; await f.ops.close(); f.store.close(); }
});

test('a pending Claude UUID fence reads only new log bytes while unchanged recovery does not rescan full requests', async (t) => {
  const f = await fixture();
  try {
    const state = f.store.readRunCheckpointState(f.run.projectId, 1);
    f.store.patchRunState(f.run.projectId, { ...f.scope, expectedRevision: state.revision, patch: { claudeNativeContract: 'mods-v1' }, idempotencyKey: 'cost-contract' });
    fs.writeFileSync(f.transcript, JSON.stringify(f.row) + '\n');
    const event = { schemaVersion: 1, sequence: 1, sessionId: f.row.sessionId, providerTurnId: require('node:crypto').randomUUID(), userUuid: f.row.uuid,
      assistantUuids: ['late-fenced-reply'], startedAt: f.row.timestamp, completedAt: new Date().toISOString(), reason: 'answer' };
    await f.call('record_claude_native_event', { ...f.scope, proof: f.run.proof, event });
    let bytesRead = 0; let appendedBytes = 0; const read = f.store.readRunLog.bind(f.store);
    f.store.readRunLog = (...args) => { const page = read(...args); bytesRead += Buffer.from(page.bytes, 'base64').length; return page; };
    try {
      for (let i = 0; i < 10; i++) await f.call('recover_run_executions', {});
      assert.equal(bytesRead, 0, 'pending completion with unchanged source must not scan the retained request');
      for (let i = 0; i < 10; i++) {
        const row = { ...f.row, type: 'progress', uuid: `pending-fence-${i}`, parentUuid: f.row.uuid }; delete row.message;
        const line = JSON.stringify(row) + '\n'; appendedBytes += Buffer.byteLength(line); fs.appendFileSync(f.transcript, line);
        await f.call('recover_run_executions', {});
      }
      assert.ok(bytesRead <= appendedBytes * 2, `${bytesRead} body bytes for ${appendedBytes} new bytes`);
      t.diagnostic(`retainedRequestBytes=${Buffer.byteLength(JSON.stringify(f.row)) + 1} appendedBytes=${appendedBytes} databaseBodyBytesRead=${bytesRead}`);
    } finally { f.store.readRunLog = read; }
    assert.equal(f.store.readMetadata(f.run.turnId).data.finished_at, null);
    assert.equal(f.store.readRunCheckpointState(f.run.projectId, 1).status.claudeNativeEventCursor || 0, 0);
  } finally { await f.ops.close(); f.store.close(); }
});

test('Claude machine start immediately opens the next running turn before its response completes', async () => {
  const f = await fixture();
  try {
    const state = f.store.readRunCheckpointState(f.run.projectId, 1);
    f.store.patchRunState(f.run.projectId, { ...f.scope, expectedRevision: state.revision, patch: { claudeNativeContract: 'mods-v1' }, idempotencyKey: 'start-contract' });
    const reply = { ...f.row, type: 'assistant', uuid: 'start-first-reply', parentUuid: f.row.uuid, message: { role: 'assistant', id: 'first', content: [{ type: 'text', text: '第一轮结果' }] } };
    fs.writeFileSync(f.transcript, [f.row, reply].map(JSON.stringify).join('\n') + '\n');
    const first = { schemaVersion: 1, sequence: 1, sessionId: f.row.sessionId, providerTurnId: require('node:crypto').randomUUID(), userUuid: f.row.uuid,
      assistantUuids: [reply.uuid], startedAt: f.row.timestamp, completedAt: new Date().toISOString(), reason: 'answer' };
    await f.call('record_claude_native_event', { ...f.scope, proof: f.run.proof, event: first });
    const queued = { ...f.row, uuid: 'start-next-user', message: { role: 'user', content: '现在开始第二轮' } };
    fs.appendFileSync(f.transcript, JSON.stringify(queued) + '\n');
    const startedAt = new Date().toISOString();
    await f.call('record_claude_native_event', { ...f.scope, proof: f.run.proof, event: { ...first, phase: 'start', sequence: 2, providerTurnId: require('node:crypto').randomUUID(),
      userUuid: queued.uuid, assistantUuids: [], startedAt, completedAt: startedAt } });
    const next = f.store.readRunCheckpointState(f.run.projectId, 1);
    assert.notEqual(next.turnId, f.run.turnId); assert.equal(next.status.status, 'Running');
    assert.equal(f.store.read(next.turnId).data.request_content, '现在开始第二轮'); assert.equal(f.store.readMetadata(next.turnId).data.finished_at, null);
    const cards = require('../out/conversationPresentation.js').buildConversationPresentations(f.project, '__solo__', f.store.readProjectJournal(f.run.projectId).logs);
    const current = cards.filter(card => card.summary === '现在开始第二轮');
    assert.equal(current.length, 1); assert.equal(current[0].capabilities.canStop, true);
  } finally { await f.ops.close(); f.store.close(); }
});

test('Claude accepts a pre-stop transcript turn only when its byte range is inside the trusted stop boundary', async () => {
  const f = await fixture();
  try {
    const reply = { ...f.row, type: 'assistant', uuid: 'stop-first-reply', parentUuid: f.row.uuid,
      message: { role: 'assistant', id: 'stop-first', content: [{ type: 'text', text: '第一轮结果' }] } };
    fs.writeFileSync(f.transcript, [f.row, reply, duration(reply)].map(JSON.stringify).join('\n') + '\n');
    const { RunNativeObserver } = require('../out/runNativeObserver.js');
    const observer = new RunNativeObserver(f.store);
    await observer.observe(f.store.readRunCheckpointState(f.run.projectId, 1));
    const first = f.store.readRunCheckpointState(f.run.projectId, 1);
    assert.notEqual(f.store.readMetadata(first.turnId).data.finished_at, null);
    const nextUser = { ...f.row, uuid: 'stop-next-user', timestamp: new Date().toISOString(), message: { role: 'user', content: '停止前已经提交的第二轮' } };
    fs.appendFileSync(f.transcript, JSON.stringify(nextUser) + '\n');
    const stopped = f.store.requestRunStop(f.run.projectId, {
      ...f.scope, expectedRevision: first.revision, expectedTurnId: first.turnId, reason: '关闭当前终端', idempotencyKey: 'claude-stop-boundary'
    }, { nativeStopStream: 'native:claude', nativeStopLogBoundary: fs.statSync(f.transcript).size });
    await observer.observe(stopped);
    const observed = f.store.readRunCheckpointState(f.run.projectId, 1);
    assert.notEqual(observed.turnId, first.turnId, 'the already-submitted native turn must not be lost behind the accepted stop');
    assert.equal(f.store.read(observed.turnId).data.request_content, '停止前已经提交的第二轮');
  } finally { await f.ops.close(); f.store.close(); }
});

test('a late Claude completion cannot be accepted as the next native turn after cold recovery', async () => {
  const f = await fixture(); let store = f.store; let ops = f.ops;
  try {
    const state = store.readRunCheckpointState(f.run.projectId, 1);
    store.patchRunState(f.run.projectId, { ...f.scope, expectedRevision: state.revision, patch: { claudeNativeContract: 'mods-v1' }, idempotencyKey: 'late-contract' });
    const reply = { ...f.row, type: 'assistant', uuid: 'late-first-reply', parentUuid: f.row.uuid, message: { role: 'assistant', id: 'first', content: [{ type: 'text', text: '第一轮结果' }] } };
    fs.writeFileSync(f.transcript, [f.row, reply].map(JSON.stringify).join('\n') + '\n');
    const first = { schemaVersion: 1, phase: 'start', sequence: 1, sessionId: f.row.sessionId, providerTurnId: require('node:crypto').randomUUID(), userUuid: f.row.uuid,
      assistantUuids: [], startedAt: f.row.timestamp, completedAt: f.row.timestamp, reason: 'answer' };
    const call = event => ops({ operation: 'record_claude_native_event', input: { ...f.scope, proof: f.run.proof, event } });
    await call(first);
    const complete = { ...first, phase: 'complete', sequence: 2, assistantUuids: [reply.uuid], completedAt: new Date().toISOString() };
    await call(complete);
    const queued = { ...f.row, uuid: 'late-next-user', message: { role: 'user', content: '第二轮仍在运行' } };
    fs.appendFileSync(f.transcript, JSON.stringify(queued) + '\n');
    const startedAt = new Date().toISOString();
    await call({ ...first, sequence: 3, providerTurnId: require('node:crypto').randomUUID(), userUuid: queued.uuid, startedAt, completedAt: startedAt });
    const next = store.readRunCheckpointState(f.run.projectId, 1);
    await ops.close(); store.close(); store = new UnifiedDataStore(f.root); ops = createRuntimeDataOperations(store);
    await assert.rejects(call({ ...complete, sequence: 4 }), /native_event_turn_conflict/);
    assert.equal(store.readRunDocument(f.run.projectId, 1, `claude_event_${f.scope.generation}_4`), null);
    const after = store.readRunCheckpointState(f.run.projectId, 1);
    assert.equal(after.revision, next.revision); assert.equal(after.status.claudeNativeEventHead, 3);
    assert.equal(store.readMetadata(next.turnId).data.finished_at, null);
    assert.equal(store.read(f.run.turnId).data.summary_content, '第一轮结果');
    await call(complete);
    assert.equal(store.readRunCheckpointState(f.run.projectId, 1).revision, next.revision, 'exact old replay remains idempotent');
  } finally { await ops.close(); store.close(); }
});

test('Claude API failure retains partial user-facing text and keeps its error record in the full native log', async () => {
  const f = await fixture();
  try {
    const state = f.store.readRunCheckpointState(f.run.projectId, 1);
    f.store.patchRunState(f.run.projectId, { ...f.scope, expectedRevision: state.revision, patch: { claudeNativeContract: 'mods-v1' }, idempotencyKey: 'error-contract' });
    const reply = { ...f.row, type: 'assistant', uuid: 'partial-valid', parentUuid: f.row.uuid, message: { role: 'assistant', id: 'valid', content: [{ type: 'text', text: '已经完成的部分正文🌿\n' }] } };
    const error = { ...reply, uuid: 'api-error', parentUuid: reply.uuid, isApiErrorMessage: true, message: { ...reply.message, id: 'error', content: [{ type: 'text', text: 'API connection failed' }] } };
    const bytes = Buffer.from([f.row, reply, error].map(JSON.stringify).join('\n') + '\n'); fs.writeFileSync(f.transcript, bytes);
    const event = { schemaVersion: 1, sequence: 1, sessionId: f.row.sessionId, providerTurnId: require('node:crypto').randomUUID(), userUuid: f.row.uuid,
      assistantUuids: [reply.uuid, error.uuid], startedAt: f.row.timestamp, completedAt: new Date().toISOString(), reason: 'error' };
    await f.call('record_claude_native_event', { ...f.scope, proof: f.run.proof, event });
    assert.equal(f.store.read(f.run.turnId).data.outcome, 'failed');
    assert.equal(Buffer.from(f.store.readRunDocument(f.run.projectId, 1, `native_reply_${f.run.turnId.replace(/-/g, '')}`).bytes, 'base64').toString('utf8'), reply.message.content[0].text);
    assert.equal(f.store.readRunLogHead(f.run.projectId, 1, 'native:claude').totalBytes, bytes.length);
  } finally { await f.ops.close(); f.store.close(); }
});

test('an unchanged pending machine fence does not reread a large unterminated Claude assistant record', async () => {
  const f = await fixture();
  try {
    const state = f.store.readRunCheckpointState(f.run.projectId, 1);
    f.store.patchRunState(f.run.projectId, { ...f.scope, expectedRevision: state.revision, patch: { claudeNativeContract: 'mods-v1' }, idempotencyKey: 'partial-machine-contract' });
    const reply = { ...f.row, type: 'assistant', uuid: 'unterminated-reply', parentUuid: f.row.uuid, message: { role: 'assistant', id: 'partial', content: [{ type: 'text', text: '完整正文🌿'.repeat(20000) }] } };
    fs.writeFileSync(f.transcript, JSON.stringify(f.row) + '\n' + JSON.stringify(reply));
    const event = { schemaVersion: 1, sequence: 1, sessionId: f.row.sessionId, providerTurnId: require('node:crypto').randomUUID(), userUuid: f.row.uuid,
      assistantUuids: [reply.uuid], startedAt: f.row.timestamp, completedAt: new Date().toISOString(), reason: 'answer' };
    await f.call('record_claude_native_event', { ...f.scope, proof: f.run.proof, event });
    let bytesRead = 0; const read = f.store.readRunLog.bind(f.store);
    f.store.readRunLog = (...args) => { const page = read(...args); bytesRead += Buffer.from(page.bytes, 'base64').length; return page; };
    try { for (let i = 0; i < 5; i++) await f.call('recover_run_executions', {}); }
    finally { f.store.readRunLog = read; }
    assert.equal(bytesRead, 0);
    fs.appendFileSync(f.transcript, '\n'); await f.call('recover_run_executions', {});
    assert.equal(Buffer.from(f.store.readRunDocument(f.run.projectId, 1, `native_reply_${f.run.turnId.replace(/-/g, '')}`).bytes, 'base64').toString('utf8'), reply.message.content[0].text);
  } finally { await f.ops.close(); f.store.close(); }
});

test('Claude uses transcript boundaries until the actual loaded native adapter confirms this generation and session', async () => {
  const f = await fixture();
  try {
    const state = f.store.readRunCheckpointState(f.run.projectId, 1);
    f.store.patchRunState(f.run.projectId, { ...f.scope, expectedRevision: state.revision, patch: { claudeNativeContract: 'transcript-v1', claudeNativeObserverCapable: true }, idempotencyKey: 'ready-contract' });
    const reply = { ...f.row, type: 'assistant', uuid: 'fallback-reply', parentUuid: f.row.uuid, message: { role: 'assistant', id: 'fallback', content: [{ type: 'text', text: '用户禁止 hooks 时仍能结束' }] } };
    fs.writeFileSync(f.transcript, [f.row, reply, duration(reply)].map(JSON.stringify).join('\n') + '\n');
    await f.call('recover_run_executions', {});
    assert.equal(f.store.read(f.run.turnId).data.summary_content, reply.message.content[0].text);
    await assert.rejects(f.call('record_claude_native_ready', { ...f.scope, proof: f.run.proof, sessionId: require('node:crypto').randomUUID() }), /identity_provider_mismatch/);
    await f.call('record_claude_native_ready', { ...f.scope, proof: f.run.proof, sessionId: f.row.sessionId });
    const ready = f.store.readRunCheckpointState(f.run.projectId, 1);
    assert.equal(ready.status.claudeNativeContract, 'mods-v1'); assert.equal(ready.status.claudeNativeObserverGeneration, f.scope.generation);
    const revision = ready.revision;
    await f.call('record_claude_native_ready', { ...f.scope, proof: f.run.proof, sessionId: f.row.sessionId });
    assert.equal(f.store.readRunCheckpointState(f.run.projectId, 1).revision, revision);
  } finally { await f.ops.close(); f.store.close(); }
});

test('Claude identity and complete native bytes are read from the captured native home without Agent self-reporting', async () => {
  const f = await fixture(); let store = f.store; let ops = f.ops;
  try {
    const initial = Buffer.from(JSON.stringify(f.row) + '\n'); fs.writeFileSync(f.transcript, initial);
    await f.call('recover_run_executions', { ...f.scope, identityOnly: true });
    const binding = await f.call('read_run_binding', f.scope);
    assert.equal(binding.revisions.at(-1).state, 'confirmed');
    assert.equal(binding.revisions.at(-1).sessionId, f.row.sessionId);
    assert.equal(binding.revisions.at(-1).evidence.source, 'claude_native_transcript');
    assert.equal(binding.revisions.at(-1).providerContext.claude.claudeHome, f.claudeHome);
    await f.call('recover_run_executions', {});
    const log = await f.call('read_run_log_head', { ...f.scope, stream: 'native:claude' });
    assert.equal(log.totalBytes, initial.length);
    const before = await f.call('read_run_state', f.scope);
    let reads = 0; const originalRead = fs.createReadStream; const originalOpen = fs.promises.open;
    fs.createReadStream = function (file, ...args) { if (file === f.transcript) reads++; return originalRead.call(this, file, ...args); };
    fs.promises.open = async function (file, ...args) {
      const handle = await originalOpen.call(this, file, ...args); const read = handle.read.bind(handle);
      if (file === f.transcript) handle.read = (...parameters) => { reads++; return read(...parameters); };
      return handle;
    };
    try { for (let attempt = 0; attempt < 20; attempt++) await f.call('recover_run_executions', {}); }
    finally { fs.createReadStream = originalRead; fs.promises.open = originalOpen; }
    assert.equal(reads, 0, 'unchanged native history must not be reread on every recovery tick');
    assert.equal((await f.call('read_run_state', f.scope)).revision, before.revision);
    assert.equal((await f.call('read_run_log_head', { ...f.scope, stream: 'native:claude' })).nextSequence, log.nextSequence);
    await ops.close(); store.close();
    store = new UnifiedDataStore(f.root); ops = createRuntimeDataOperations(store);
    const appended = Buffer.from(JSON.stringify({ ...f.row, uuid: 'native-user-2', message: { role: 'user', content: '后续完整消息🧭'.repeat(10000) } }) + '\n');
    fs.appendFileSync(f.transcript, appended);
    await ops({ operation: 'recover_run_executions', input: {} });
    const expected = Buffer.concat([initial, appended]); const chunks = [];
    for (let offset = 0; offset < expected.length;) {
      const page = store.readRunLog(f.run.projectId, { executionLogId: 1, stream: 'native:claude', offset, limit: 65536 });
      const bytes = Buffer.from(page.bytes, 'base64'); assert.ok(bytes.length); chunks.push(bytes); offset += bytes.length;
    }
    assert.deepEqual(Buffer.concat(chunks), expected);
    assert.equal(store.readRunCheckpointState(f.run.projectId, 1).turnId, f.run.turnId);
    assert.deepEqual(fs.readdirSync(path.join(f.project, '.solopreneur')), ['project.json']);
  } finally { await ops.close(); store.close(); }
});

test('a symlink outside the captured Claude native root cannot confirm a session', async () => {
  const f = await fixture();
  try {
    const other = path.join(f.base, 'other-session.jsonl'); fs.writeFileSync(other, JSON.stringify(f.row) + '\n');
    fs.symlinkSync(other, f.transcript);
    await assert.rejects(f.call('recover_run_executions', { ...f.scope, identityOnly: true }), /identity_transcript_scope_mismatch/);
    assert.equal((await f.call('read_run_binding', f.scope)).revisions.at(-1).state, 'planned');
    assert.equal((await f.call('read_run_log_head', { ...f.scope, stream: 'native:claude' })).totalBytes, 0);
  } finally { await f.ops.close(); f.store.close(); }
});

test('Claude source replacement between verification and capture cannot import bytes from the replacement', async () => {
  const f = await fixture(); const originalRead = fs.createReadStream; const originalOpen = fs.promises.open;
  try {
    f.row.message.content = 'verified native source'.repeat(100);
    const expected = Buffer.from(JSON.stringify(f.row) + '\n'); fs.writeFileSync(f.transcript, expected);
    const outside = path.join(f.base, 'outside.jsonl'); fs.writeFileSync(outside, 'outside unrelated bytes');
    let reads = 0;
    const replace = () => { fs.renameSync(f.transcript, f.transcript + '.original'); fs.symlinkSync(outside, f.transcript); };
    fs.createReadStream = function (file, ...args) {
      if (file === f.transcript && ++reads === 2) replace();
      return originalRead.call(this, file, ...args);
    };
    fs.promises.open = async function (file, ...args) {
      const handle = await originalOpen.call(this, file, ...args); const read = handle.read.bind(handle);
      if (file === f.transcript) handle.read = (...parameters) => { if (++reads === 2) replace(); return read(...parameters); };
      return handle;
    };
    const { RunNativeObserver } = require('../out/runNativeObserver.js');
    await new RunNativeObserver(f.store).observe(f.run).catch(error => { assert.match(error.message, /identity_transcript_scope_mismatch|native_transcript_replaced/); });
    const head = f.store.readRunLogHead(f.run.projectId, 1, 'native:claude');
    if (head.totalBytes) {
      const chunks = []; for (let offset = 0; offset < head.totalBytes;) {
        const page = f.store.readRunLog(f.run.projectId, { executionLogId: 1, stream: 'native:claude', offset, limit: 65536 }); const bytes = Buffer.from(page.bytes, 'base64'); assert.ok(bytes.length); chunks.push(bytes); offset += bytes.length;
      }
      assert.equal(require('node:crypto').createHash('sha256').update(Buffer.concat(chunks)).digest('hex'), require('node:crypto').createHash('sha256').update(expected).digest('hex'));
    }
  } finally { fs.createReadStream = originalRead; fs.promises.open = originalOpen; await f.ops.close(); f.store.close(); }
});

test('simultaneous native observers append each Claude source byte exactly once', async () => {
  const f = await fixture(); const originalRead = fs.createReadStream; const originalOpen = fs.promises.open;
  try {
    f.row.message.content = 'native source chunk'.repeat(6000);
    const expected = Buffer.from(JSON.stringify(f.row) + '\n'); fs.writeFileSync(f.transcript, expected);
    await f.call('recover_run_executions', { ...f.scope, identityOnly: true });
    const { RunNativeObserver } = require('../out/runNativeObserver.js');
    let captures = 0; let firstDone;
    const firstFinished = new Promise(resolve => { firstDone = resolve; });
    fs.createReadStream = function (file, options) {
      const source = originalRead.call(this, file, options);
      if (file === f.transcript && options?.end !== undefined) {
        const ordinal = ++captures; const iterator = source[Symbol.asyncIterator].bind(source);
        source[Symbol.asyncIterator] = async function* () {
          if (ordinal === 1) await new Promise(resolve => setTimeout(resolve, 50));
          else await firstFinished;
          yield* iterator();
        };
      }
      return source;
    };
    fs.promises.open = async function (file, ...args) {
      const handle = await originalOpen.call(this, file, ...args); const read = handle.read.bind(handle); let starts = 0;
      if (file === f.transcript) handle.read = async (...parameters) => {
        if (parameters[3] === 0 && ++starts === 2) {
          const ordinal = ++captures;
          if (ordinal === 1) await new Promise(resolve => setTimeout(resolve, 50)); else await firstFinished;
        }
        return read(...parameters);
      };
      return handle;
    };
    const first = new RunNativeObserver(f.store).observe(f.run).finally(() => firstDone());
    const second = new RunNativeObserver(f.store).observe(f.run);
    await Promise.all([first, second]);
    assert.equal(f.store.readRunLogHead(f.run.projectId, 1, 'native:claude').totalBytes, expected.length);
    await f.call('recover_run_executions', {});
    assert.equal(f.store.readRunLogHead(f.run.projectId, 1, 'native:claude').totalBytes, expected.length);
  } finally { fs.createReadStream = originalRead; fs.promises.open = originalOpen; await f.ops.close(); f.store.close(); }
});

test('Claude preserves the original configuration spelling while observing its native NFC transcript directory', async () => {
  const f = await fixture(true);
  try {
    const binding = await f.call('read_run_binding', f.scope);
    assert.equal(binding.revisions.at(-1).providerContext.claude.claudeHome, f.claudeHome);
    assert.equal(binding.revisions.at(-1).providerContext.claude.configDirOverride, f.configDirOverride);
    assert.equal(binding.revisions.at(-1).providerContext.claude.configPath, path.join(f.configDirOverride, '.claude.json'));
    fs.writeFileSync(f.transcript, JSON.stringify(f.row) + '\n');
    await f.call('recover_run_executions', { ...f.scope, identityOnly: true });
    assert.equal((await f.call('read_run_binding', f.scope)).revisions.at(-1).state, 'confirmed');
  } finally { await f.ops.close(); f.store.close(); }
});

for (const mismatch of ['cwd', 'sessionId', 'isSidechain']) test(`Claude native ${mismatch} mismatch cannot confirm or import another session`, async () => {
  const f = await fixture();
  try {
    const row = { ...f.row, [mismatch]: mismatch === 'cwd' ? f.base : mismatch === 'sessionId' ? '00000000-0000-0000-0000-000000000000' : true };
    fs.writeFileSync(f.transcript, JSON.stringify(row) + '\n');
    await assert.rejects(f.call('recover_run_executions', { ...f.scope, identityOnly: true }), /identity_provider_mismatch/);
    assert.equal((await f.call('read_run_binding', f.scope)).revisions.at(-1).state, 'planned');
    assert.equal((await f.call('read_run_log_head', { ...f.scope, stream: 'native:claude' })).totalBytes, 0);
  } finally { await f.ops.close(); f.store.close(); }
});

test('Claude native user and completed assistant records settle successive machine turns with full replies after a cold Runtime reopen', async () => {
  const f = await fixture(); let store = f.store; let ops = f.ops;
  const call = (operation, input = {}) => ops({ operation, input: { ...f.scope, ...input } });
  try {
    await call('write_run_document', { turnId: f.run.turnId, purpose: workspaceDocumentPurpose(f.run.turnId, 'before'), bytes: Buffer.from(JSON.stringify(await snapshotWorkspace(f.project))).toString('base64'), mimeType: 'application/json', expectedRevision: 0, idempotencyKey: 'claude-before' });
    const reply = '第一轮完整回复🌿\n'.repeat(20000);
    const completed = { ...f.row, type: 'assistant', uuid: 'native-assistant-1', parentUuid: f.row.uuid, timestamp: new Date().toISOString(), message: { id: 'message-1', role: 'assistant', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { input_tokens: 15, output_tokens: 20, cache_read_input_tokens: 5 } } };
    fs.writeFileSync(f.transcript, [f.row, completed, duration(completed)].map(value => JSON.stringify(value)).join('\n') + '\n');
    fs.writeFileSync(path.join(f.project, 'result.txt'), 'first result');
    await call('recover_run_executions');
    const first = await call('read_run_state');
    assert.equal(first.status.status, 'In Progress'); assert.equal(first.turnId, f.run.turnId);
    assert.equal(store.read(first.turnId).data.summary_content, reply);
    assert.equal(store.read(first.turnId).data.outcome, 'partial');
    const firstReply = Buffer.from(store.readRunDocument(f.run.projectId, 1, `native_reply_${first.turnId.replace(/-/g, '')}`).bytes, 'base64').toString('utf8');
    assert.equal(firstReply, reply);
    assert.equal(first.status.nativeTokenUsage.outputTokens, 20);
    await ops.close(); store.close(); store = new UnifiedDataStore(f.root); ops = createRuntimeDataOperations(store);
    const request = '第二轮完整输入🧭'.repeat(10000); const secondUser = { ...f.row, uuid: 'native-user-2', parentUuid: completed.uuid, timestamp: new Date().toISOString(), message: { role: 'user', content: request } };
    fs.appendFileSync(f.transcript, JSON.stringify(secondUser) + '\n');
    await call('recover_run_executions');
    const second = await call('read_run_state');
    assert.notEqual(second.turnId, first.turnId); assert.equal(second.taskId, first.taskId);
    assert.equal(second.status.status, 'Running'); assert.equal(store.read(second.turnId).data.request_content, request);
    const end = { ...completed, uuid: 'native-assistant-2', parentUuid: secondUser.uuid, timestamp: new Date().toISOString(), message: { ...completed.message, id: 'message-2', content: [{ type: 'text', text: '第二轮完整回复' }], usage: { input_tokens: 25, output_tokens: 30 } } };
    fs.appendFileSync(f.transcript, [end, duration(end)].map(JSON.stringify).join('\n') + '\n'); await call('recover_run_executions');
    const done = await call('read_run_state'); assert.equal(done.status.status, 'In Progress');
    assert.equal(store.read(second.turnId).data.summary_content, '第二轮完整回复');
    assert.equal(store.read(first.turnId).data.summary_content, reply);
    assert.equal(done.status.nativeTokenUsage.outputTokens, 30);
    const revision = done.revision; await call('recover_run_executions'); assert.equal((await call('read_run_state')).revision, revision);
    const logs = store.readRunTurnJournal(f.run.projectId, 1, second.turnId);
    assert.ok(logs.entry.output.includes(request)); assert.ok(logs.entry.output.includes('第二轮完整回复'));
    assert.ok(!logs.entry.output.includes(reply), 'turn output ranges must not include the previous turn reply');
    const presented = require('../out/conversationPresentation.js').buildConversationPresentations(f.project, '__solo__', store.readProjectJournal(f.run.projectId).logs);
    const oldCard = presented.find(value => value.id === 1); const newCard = presented.find(value => value.id === logs.executionLogId);
    assert.equal(oldCard.summary, '完整用户目标', 'the first card uses the actual user request, rather than the expanded CLI prompt');
    assert.equal(oldCard.conclusion, reply, 'the earlier turn keeps its own complete reply after a cold owner and later turn');
    assert.equal(newCard.summary, request.slice(0, 120)); assert.equal(newCard.conclusion, '第二轮完整回复');
  } finally { await ops.close(); store.close(); }
});

// An early business receipt must not publish an incomplete result to downstream consumers.
test('Claude business receipt waits for the full native reply across a cold Runtime reopen', async () => {
  const f = await fixture(); let store = f.store; let ops = f.ops;
  const call = (operation, input = {}) => ops({ operation, input: { ...f.scope, ...input } });
  try {
    fs.writeFileSync(f.transcript, JSON.stringify(f.row) + '\n'); await call('recover_run_executions');
    const state = store.readRunCheckpointState(f.run.projectId, 1);
    const report = { schemaVersion: 1, summary: '原目标已完成', unmetRequirements: [], decisions: [], corrections: [], verification: [], commits: [], experienceUsage: [], lessons: [] };
    const accepted = await call('checkpoint_run', { proof: state.proof, expectedRevision: state.revision, expectedTurnId: state.turnId, action: 'complete', outcome: 'candidate_complete', summary: '原目标已完成', report, idempotencyKey: 'claude-business-receipt' });
    assert.equal(accepted.status.nativeOutputPending, true);
    assert.equal(store.listRunStates({ projectId: f.run.projectId, pendingConsumer: true }).items.length, 0);
    await ops.close(); store.close(); store = new UnifiedDataStore(f.root); ops = createRuntimeDataOperations(store);
    const reply = '检查点之后的完整机器回复🌿'.repeat(12000);
    const end = { ...f.row, type: 'assistant', uuid: 'native-business-end', parentUuid: f.row.uuid, timestamp: new Date().toISOString(), message: { id: 'business-reply', role: 'assistant', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { input_tokens: 15, output_tokens: 22 } } };
    fs.appendFileSync(f.transcript, [end, duration(end)].map(JSON.stringify).join('\n') + '\n'); fs.writeFileSync(path.join(f.project, 'result.txt'), 'business result');
    await call('recover_run_executions');
    const done = store.readRunCheckpointState(f.run.projectId, 1);
    assert.equal(done.turnId, accepted.turnId); assert.equal(done.status.nativeOutputPending, false);
    assert.equal(done.status.checkpointOutcome, 'candidate_complete'); assert.equal(done.status.checkpointSummary, '原目标已完成');
    assert.equal(done.status.taskReportObjectId, accepted.status.taskReportObjectId);
    assert.equal(store.listRunStates({ projectId: f.run.projectId, pendingConsumer: true }).items.length, 1);
    const { RunLifecycleClient, runStatusReference, runDataReference } = require('../out/runLifecycleClient.js');
    const client = new RunLifecycleClient((operation, input) => call(operation, input)); const ref = runStatusReference(f.project, 1);
    const output = await client.readData(runDataReference(ref, 'output'), await client.readStatus(ref, done.revision));
    assert.equal(output.toString('utf8'), reply);
    assert.equal(done.status.nativeTokenUsage.outputTokens, 22);
    const presented = require('../out/conversationPresentation.js').buildConversationPresentations(f.project, '__solo__', store.readProjectJournal(f.run.projectId).logs)[0];
    assert.equal(presented.conclusion, reply, 'the saved native reply takes precedence over the earlier business receipt without truncation');
  } finally { await ops.close(); store.close(); }
});

test('Claude foreign branches cannot complete the current turn or inflate its native usage', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(f.transcript, JSON.stringify(f.row) + '\n'); await f.call('recover_run_executions', {});
    const foreign = { ...f.row, type: 'assistant', uuid: 'foreign-assistant', parentUuid: 'unrelated-user', timestamp: new Date().toISOString(), message: { id: 'foreign-message', role: 'assistant', content: [{ type: 'text', text: 'unrelated reply' }], stop_reason: 'end_turn', usage: { input_tokens: 999, output_tokens: 1000 } } };
    fs.appendFileSync(f.transcript, JSON.stringify(foreign) + '\n'); await f.call('recover_run_executions', {});
    assert.equal((await f.call('read_run_state', f.scope)).status.status, 'Running');
    const valid = { ...foreign, uuid: 'valid-assistant', parentUuid: f.row.uuid, message: { ...foreign.message, id: 'valid-message', content: [{ type: 'text', text: 'current reply' }], usage: { input_tokens: 10, output_tokens: 8 } } };
    fs.appendFileSync(f.transcript, [valid, duration(valid)].map(JSON.stringify).join('\n') + '\n'); await f.call('recover_run_executions', {});
    const done = await f.call('read_run_state', f.scope);
    assert.equal(done.status.status, 'In Progress'); assert.equal(done.status.nativeTokenUsage.outputTokens, 8);
    assert.equal(f.store.read(f.run.turnId).data.summary_content, 'current reply');
  } finally { await f.ops.close(); f.store.close(); }
});

test('an unchanged incomplete Claude record is retained without repeated database body reads', async () => {
  const f = await fixture();
  try {
    const reply = '尚未完整写出的回复🌿'.repeat(10000);
    const end = { ...f.row, type: 'assistant', uuid: 'partial-assistant', parentUuid: f.row.uuid, timestamp: new Date().toISOString(), message: { id: 'partial-message', role: 'assistant', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { output_tokens: 8 } } };
    const original = JSON.stringify(f.row) + '\n' + JSON.stringify(end);
    fs.writeFileSync(f.transcript, original); await f.call('recover_run_executions', {});
    const before = await f.call('read_run_state', f.scope); assert.equal(before.status.status, 'Running');
    const read = f.store.readRunLog.bind(f.store); let reads = 0;
    f.store.readRunLog = (...args) => { reads++; return read(...args); };
    try { for (let i = 0; i < 5; i++) await f.call('recover_run_executions', {}); }
    finally { f.store.readRunLog = read; }
    assert.equal(reads, 0, 'an unchanged partial record must not reread its body on every recovery tick');
    assert.equal((await f.call('read_run_state', f.scope)).revision, before.revision);
    assert.equal((await f.call('read_run_log_head', { ...f.scope, stream: 'native:claude' })).totalBytes, Buffer.byteLength(original));
    fs.appendFileSync(f.transcript, '\n'); await f.call('recover_run_executions', {});
    assert.equal((await f.call('read_run_state', f.scope)).status.status, 'Running');
    fs.appendFileSync(f.transcript, JSON.stringify(duration(end)) + '\n'); await f.call('recover_run_executions', {});
    assert.equal((await f.call('read_run_state', f.scope)).status.status, 'In Progress');
    assert.equal(f.store.read(f.run.turnId).data.summary_content, reply);
  } finally { await f.ops.close(); f.store.close(); }
});

test('Claude tool progress cannot replace the main message lineage or start a user turn', async () => {
  const f = await fixture();
  try {
    const time = new Date().toISOString();
    const assistant = { ...f.row, type: 'assistant', uuid: 'tool-assistant', parentUuid: f.row.uuid, timestamp: time, message: { id: 'tool-message', role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'result.txt' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 7 } } };
    const progress = { ...f.row, type: 'progress', uuid: 'progress-1', parentUuid: assistant.uuid, data: { type: 'hook_progress', hookName: 'PreToolUse:Read' } }; delete progress.message;
    const result = { ...f.row, uuid: 'tool-result-user', parentUuid: assistant.uuid, timestamp: time, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'complete tool result' }] } };
    const end = { ...assistant, uuid: 'tool-final', parentUuid: result.uuid, message: { ...assistant.message, id: 'final-message', content: [{ type: 'text', text: '工具完成后的真实回复' }], stop_reason: 'end_turn', usage: { input_tokens: 15, output_tokens: 20 } } };
    fs.writeFileSync(f.transcript, [f.row, assistant, progress, result, end, duration(end)].map(value => JSON.stringify(value)).join('\n') + '\n');
    await f.call('recover_run_executions', {});
    const done = await f.call('read_run_state', f.scope);
    assert.equal(done.status.status, 'In Progress'); assert.equal(done.turnId, f.run.turnId);
    assert.equal(f.store.read(f.run.turnId).data.summary_content, '工具完成后的真实回复');
    assert.equal(done.status.nativeTokenUsage.outputTokens, 27);
    assert.equal(f.store.read(f.run.turnId).data.request_content, '完整用户目标');
  } finally { await f.ops.close(); f.store.close(); }
});

test('Claude auxiliary transcript ancestors keep later main messages reachable without becoming user turns', async () => {
  const f = await fixture();
  try {
    const time = new Date().toISOString();
    const progress = { ...f.row, type: 'progress', uuid: 'ancestor-progress', parentUuid: f.row.uuid, timestamp: time, data: { type: 'hook_progress' } }; delete progress.message;
    const system = { ...progress, type: 'system', uuid: 'ancestor-system', parentUuid: progress.uuid };
    const end = { ...f.row, type: 'assistant', uuid: 'ancestor-reply', parentUuid: system.uuid, timestamp: time, message: { id: 'ancestor-message', role: 'assistant', content: [{ type: 'text', text: '辅助记录后的完整回复' }], stop_reason: 'end_turn', usage: { output_tokens: 12 } } };
    fs.writeFileSync(f.transcript, [f.row, progress, system].map(value => JSON.stringify(value)).join('\n') + '\n');
    await f.call('recover_run_executions', {});
    assert.equal((await f.call('read_run_state', f.scope)).turnId, f.run.turnId);
    fs.appendFileSync(f.transcript, [end, duration(end)].map(JSON.stringify).join('\n') + '\n'); await f.call('recover_run_executions', {});
    const done = await f.call('read_run_state', f.scope);
    assert.equal(done.status.status, 'In Progress'); assert.equal(done.turnId, f.run.turnId);
    assert.equal(f.store.read(f.run.turnId).data.summary_content, '辅助记录后的完整回复');
    assert.equal(done.status.nativeTokenUsage.outputTokens, 12);
  } finally { await f.ops.close(); f.store.close(); }
});

for (const allCompleted of [false, true]) test(`Claude split text blocks retain the entire fixed reply${allCompleted ? ' when every persisted block carries end_turn' : ''}`, async () => {
  const f = await fixture();
  try {
    const time = new Date().toISOString();
    const first = { ...f.row, type: 'assistant', uuid: 'block-assistant-1', parentUuid: f.row.uuid, timestamp: time, apiBlockIndex: 0, message: { id: 'split-message', role: 'assistant', content: [{ type: 'text', text: '第一段完整文字🌿' }], stop_reason: allCompleted ? 'end_turn' : null, usage: { output_tokens: 13 } } };
    const last = { ...first, uuid: 'block-assistant-2', parentUuid: first.uuid, apiBlockIndex: 1, message: { ...first.message, content: [{ type: 'text', text: '第二段完整文字🧭' }], stop_reason: 'end_turn' } };
    fs.writeFileSync(f.transcript, [f.row, first, last, duration(last)].map(value => JSON.stringify(value)).join('\n') + '\n');
    await f.call('recover_run_executions', {});
    const done = await f.call('read_run_state', f.scope); assert.equal(done.status.status, 'In Progress');
    const { RunLifecycleClient, runStatusReference, runDataReference } = require('../out/runLifecycleClient.js');
    const client = new RunLifecycleClient((operation, input) => f.call(operation, input)); const ref = runStatusReference(f.project, 1);
    const output = await client.readData(runDataReference(ref, 'output'), await client.readStatus(ref, done.revision));
    assert.equal(output.toString('utf8'), '第一段完整文字🌿\n第二段完整文字🧭');
    assert.equal(done.status.nativeTokenUsage.outputTokens, 13);
  } finally { await f.ops.close(); f.store.close(); }
});

test('continued Claude log growth does not repeatedly scan already captured full user text', async (t) => {
  const f = await fixture();
  try {
    const initial = JSON.stringify(f.row) + '\n'; fs.writeFileSync(f.transcript, initial); await f.call('recover_run_executions', {});
    let bytesRead = 0; let appendedBytes = 0; const read = f.store.readRunLog.bind(f.store);
    f.store.readRunLog = (...args) => { const page = read(...args); bytesRead += Buffer.from(page.bytes, 'base64').length; return page; };
    try {
      for (let i = 0; i < 10; i++) {
        const row = { ...f.row, type: 'progress', uuid: `tick-${i}`, parentUuid: f.row.uuid, timestamp: new Date().toISOString(), data: { type: 'hook_progress' } }; delete row.message;
        const line = JSON.stringify(row) + '\n'; appendedBytes += Buffer.byteLength(line); fs.appendFileSync(f.transcript, line); await f.call('recover_run_executions', {});
      }
    } finally { f.store.readRunLog = read; }
    assert.ok(bytesRead <= Buffer.byteLength(initial) * 2 + appendedBytes * 4, `historical body reread: ${bytesRead} bytes for ${appendedBytes} appended bytes`);
    t.diagnostic(`initialBytes=${Buffer.byteLength(initial)} appendedBytes=${appendedBytes} databaseBodyBytesRead=${bytesRead}`);
    assert.equal((await f.call('read_run_log_head', { ...f.scope, stream: 'native:claude' })).totalBytes, Buffer.byteLength(initial) + appendedBytes);
    assert.equal((await f.call('read_run_state', f.scope)).status.status, 'Running');
  } finally { await f.ops.close(); f.store.close(); }
});

test('a cold Claude owner rebuilds auxiliary ancestry from the complete stored log', async (t) => {
  const f = await fixture(); let store = f.store; let ops = f.ops;
  try {
    const progress = { ...f.row, type: 'progress', uuid: 'cold-progress', parentUuid: f.row.uuid, data: { type: 'hook_progress' } }; delete progress.message;
    const initial = [f.row, progress].map(value => JSON.stringify(value)).join('\n') + '\n';
    fs.writeFileSync(f.transcript, initial); await f.call('recover_run_executions', {});
    await ops.close(); store.close(); store = new UnifiedDataStore(f.root); ops = createRuntimeDataOperations(store);
    let bytesRead = 0; const read = store.readRunLog.bind(store);
    store.readRunLog = (...args) => { const page = read(...args); bytesRead += Buffer.from(page.bytes, 'base64').length; return page; };
    let appendedBytes = 0; let parentUuid = progress.uuid;
    for (let i = 0; i < 5; i++) {
      const row = { ...progress, uuid: `cold-tick-${i}`, parentUuid }; parentUuid = row.uuid;
      const line = JSON.stringify(row) + '\n'; appendedBytes += Buffer.byteLength(line); fs.appendFileSync(f.transcript, line);
      await ops({ operation: 'recover_run_executions', input: {} });
    }
    assert.ok(bytesRead <= Buffer.byteLength(initial) + appendedBytes * 4, `cold recovery reread historical body: ${bytesRead}`);
    t.diagnostic(`coldInitialBytes=${Buffer.byteLength(initial)} appendedBytes=${appendedBytes} databaseBodyBytesRead=${bytesRead}`);
    const end = { ...f.row, type: 'assistant', uuid: 'cold-final', parentUuid, timestamp: new Date().toISOString(), message: { id: 'cold-message', role: 'assistant', content: [{ type: 'text', text: '冷恢复后的完整回复🌿'.repeat(10000) }], stop_reason: 'end_turn', usage: { output_tokens: 12 } } };
    fs.appendFileSync(f.transcript, [end, duration(end)].map(JSON.stringify).join('\n') + '\n'); await ops({ operation: 'recover_run_executions', input: {} });
    const done = store.readRunCheckpointState(f.run.projectId, 1); assert.equal(done.status.status, 'In Progress');
    assert.equal(store.read(f.run.turnId).data.summary_content, end.message.content[0].text);
    assert.equal(done.status.nativeTokenUsage.outputTokens, 12);
  } finally { await ops.close(); store.close(); }
});
