const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { IntelligenceRuntime } = require('../out/intelligenceRuntime.js');

function cleanupExact(root) {
  if (!fs.existsSync(root)) return;
  const directories = [root], files = [];
  const visit = directory => fs.readdirSync(directory).forEach(name => {
    const target = path.join(directory, name), stat = fs.lstatSync(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) { directories.push(target); visit(target); }
    else files.push(target);
  });
  visit(root); files.forEach(file => fs.unlinkSync(file));
  directories.sort((a, b) => b.length - a.length).forEach(directory => fs.rmdirSync(directory));
}

function envelope(overrides = {}) {
  return {
    schemaVersion: 1,
    conversationId: '41369741-8da0-45c0-8a30-78b99456e344',
    operationId: 'chat-operation-1',
    requestKey: 'sidebar-click-1',
    prompt: 'What should I do next?',
    attachments: [],
    baselineRevision: 0,
    source: 'sidebar',
    sourceGeneration: 1,
    projectScope: '',
    systemPrompt: 'system-v1',
    projectContext: { selectedProject: '', projects: [] },
    model: { provider: 'agent-cli', modelId: 'auto' },
    tools: [],
    executionProfile: 'pi-core-0.87.1-v1',
    options: { retry: 'native', compaction: 'native', toolExecution: 'sequential' },
    ...overrides
  };
}

test('Pi conversation admission is idempotent and fences stale Runtime owners', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-operation-'));
  t.after(() => cleanupExact(root));
  const database = new UnifiedDataStore(root);
  try {
    assert.equal(typeof database.claimPiExecutionOwner, 'function');
    const firstOwner = database.claimPiExecutionOwner('runtime-a');
    const first = database.admitPiConversationOperation(envelope(), firstOwner);
    const admittedTool = database.admitPiToolInvocation(first.operationId, firstOwner, {
      invocationId: 'tool-invocation-1', toolName: 'solomap_write', arguments: { idempotencyKey: 'write-1' }, replay: 'never'
    });
    assert.deepEqual(database.admitPiToolInvocation(first.operationId, firstOwner, {
      invocationId: 'tool-invocation-1', toolName: 'solomap_write', arguments: { idempotencyKey: 'write-1' }, replay: 'never'
    }), admittedTool);
    database.assertPiToolInvocationActive(first.operationId, 'tool-invocation-1', firstOwner);
    assert.deepEqual(database.admitPiConversationOperation(envelope(), firstOwner), first);
    assert.throws(() => database.admitPiConversationOperation(envelope({ prompt: 'different' }), firstOwner), /idempotency_conflict/);
    const staleStorage = database.createPiSessionStorage(first.sessionId, firstOwner);
    const secondOwner = database.claimPiExecutionOwner('runtime-b');
    await assert.rejects(staleStorage.commit([], {}), /pi_owner_fenced/);
    assert.throws(() => database.admitPiToolInvocation(first.operationId, firstOwner, {
      invocationId: 'tool-invocation-2', toolName: 'solomap_write', arguments: {}, replay: 'never'
    }), /pi_owner_fenced/);
    assert.throws(() => database.assertPiToolInvocationActive(first.operationId, 'tool-invocation-1', firstOwner), /pi_owner_fenced/);
    const operations = createRuntimeDataOperations(database);
    await assert.rejects(operations({ operation: 'read_database_overview', input: {}, piToolFence: {
      operationId: first.operationId, invocationId: 'tool-invocation-1', ownerId: firstOwner.ownerId, ownerGeneration: firstOwner.generation
    } }), /pi_owner_fenced/);
    await operations.close();
    const currentStorage = database.createPiSessionStorage(first.sessionId, secondOwner);
    await currentStorage.commit([], {});
    await currentStorage.close({});
  } finally { database.close(); }
});

test('Pi tool fencing and the business mutation share one rollback boundary', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-tool-atomic-'));
  t.after(() => cleanupExact(root));
  const database = new UnifiedDataStore(root);
  try {
    const owner = database.claimPiExecutionOwner('runtime-a');
    const operation = database.admitPiConversationOperation(envelope(), owner);
    database.admitPiToolInvocation(operation.operationId, owner, {
      invocationId: 'tool-race', toolName: 'solomap_write', arguments: { title: 'must roll back' }, replay: 'never'
    });
    const originalWrite = database.write.bind(database);
    let takeoverAttempted = false;
    database.write = input => {
      const receipt = originalWrite(input);
      takeoverAttempted = true;
      database.claimPiExecutionOwner('runtime-b');
      return receipt;
    };
    const operations = createRuntimeDataOperations(database);
    await assert.rejects(operations({
      operation: 'write',
      input: { kind: 'memory', action: 'create', scope: null, idempotencyKey: 'pi-tool-race-write', data: { category: 'inbox', title: 'rollback proof', status: 'captured', content: 'must roll back' } },
      piToolFence: { operationId: operation.operationId, invocationId: 'tool-race', ownerId: owner.ownerId, ownerGeneration: owner.generation }
    }), /pi_owner_fenced/);
    assert.equal(takeoverAttempted, true);
    assert.equal(database.rows("SELECT COUNT(*) AS count FROM memories WHERE title='rollback proof'")[0].count, 0);
    await operations.close();
  } finally { database.close(); }
});

test('set_time_schedule keeps settings and schedule ledger inside one fenced transaction', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-schedule-atomic-'));
  t.after(() => cleanupExact(root));
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const database = new UnifiedDataStore(root);
  try {
    await database.registerProject({ root: projectRoot });
    const owner = database.claimPiExecutionOwner('runtime-a');
    const operation = database.admitPiConversationOperation(envelope({ projectScope: projectRoot }), owner);
    database.admitPiToolInvocation(operation.operationId, owner, {
      invocationId: 'schedule-race', toolName: 'set_time_schedule', arguments: { title: 'Must roll back' }, replay: 'never'
    });
    const originalPatch = database.patchHostSettings.bind(database);
    database.patchHostSettings = input => {
      const result = originalPatch(input);
      database.claimPiExecutionOwner('runtime-b');
      return result;
    };
    const operations = createRuntimeDataOperations(database);
    await assert.rejects(operations({
      operation: 'set_intelligence_time_schedule',
      input: { projectPath: projectRoot, projectName: 'Atomic project', title: 'Must roll back', scheduleKind: 'daily', timeOfDay: '09:00', assignee: 'user' },
      piToolFence: { operationId: operation.operationId, invocationId: 'schedule-race', ownerId: owner.ownerId, ownerGeneration: owner.generation }
    }), /pi_owner_fenced/);
    assert.equal(database.readHostSettings({ namespace: 'extension', ownerScope: 'global' }).items.some(item => item.key === 'automationTasks'), false);
    assert.equal(database.rows('SELECT COUNT(*) AS count FROM scheduled_occurrences')[0].count, 0);
    await operations.close();
  } finally { database.close(); }
});

test('Runtime close waits for in-flight native recovery before its database can close', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-recovery-drain-'));
  t.after(() => cleanupExact(root));
  const database = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(database);
  const runtime = new IntelligenceRuntime(root, database, operations, 'runtime-recovery', '0.0.605', 'build-recovery');
  try {
    const owner = runtime.owner;
    database.admitPiConversationOperation(envelope({ operationId: 'recover-on-close', requestKey: 'recover-on-close' }), owner);
    let release;
    const entered = new Promise(resolve => {
      runtime.execute = async () => {
        await new Promise(done => { release = done; resolve(); });
        return { id: envelope().conversationId, title: 'recovered', createdAt: '', updatedAt: '', messages: [] };
      };
    });
    const recovering = runtime.recover();
    await entered;
    let closed = false;
    const closing = runtime.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'close must not hand the database to shutdown while recovery is running');
    release();
    await recovering;
    await closing;
    assert.equal(closed, true);
  } finally {
    await operations.close();
    database.close();
  }
});

test('only a durable Pi terminal with a non-empty final assistant settles one visible pair', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-settlement-'));
  t.after(() => cleanupExact(root));
  const database = new UnifiedDataStore(root);
  try {
    const owner = database.claimPiExecutionOwner('runtime-a');
    const failed = database.admitPiConversationOperation(envelope(), owner);
    assert.throws(() => database.settlePiConversationOperation(failed.operationId, owner, { status: 'failed', tipId: null }), /pi_operation_not_completed/);
    assert.equal(database.readIntelligenceConversation(envelope().conversationId), null);
    assert.throws(() => database.settlePiConversationOperation(failed.operationId, owner, { status: 'completed', tipId: 'assistant-1', finalAssistant: 'must not replace a terminal failure' }), /pi_operation_terminal/);
    const completedEnvelope = envelope({
      conversationId: 'cbd95c4a-cc8d-4442-b0c6-a8ee13e03849',
      operationId: 'chat-operation-2',
      requestKey: 'sidebar-click-2'
    });
    const admitted = database.admitPiConversationOperation(completedEnvelope, owner);
    assert.throws(() => database.settlePiConversationOperation(admitted.operationId, owner, { status: 'completed', tipId: 'assistant-1', finalAssistant: '  ' }), /missing_final_assistant/);
    const thirdEnvelope = envelope({
      conversationId: '037a6f12-d68b-418e-b095-80b82e4a0802',
      operationId: 'chat-operation-3',
      requestKey: 'sidebar-click-3'
    });
    const third = database.admitPiConversationOperation(thirdEnvelope, owner);
    const storage = database.createPiSessionStorage(third.sessionId, owner);
    const assistant = { role: 'assistant', content: [{ type: 'text', text: 'A focused answer.' }], api: 'agent-cli', provider: 'agent-cli', model: 'auto',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    await storage.commit([
      { kind: 'entry', entry: { id: 'assistant-2', parentId: null, type: 'message', message: assistant } },
      { kind: 'value', op: 'set', namespace: 'pi.branch.tip', key: 'main', value: 'assistant-2' },
      { kind: 'value', op: 'set', namespace: 'pi.result', key: third.operationId,
        value: { operationId: third.operationId, kind: 'run', status: 'completed', fromTipId: null, tipId: 'assistant-2', startedAt: Date.now() - 1, endedAt: Date.now() } }
    ], {});
    const settled = database.settlePiConversationOperation(third.operationId, owner, { status: 'completed', tipId: 'assistant-2', finalAssistant: 'A focused answer.' });
    assert.deepEqual(database.settlePiConversationOperation(third.operationId, owner, { status: 'completed', tipId: 'assistant-2', finalAssistant: 'A focused answer.' }), settled);
    const visible = database.readIntelligenceConversation(thirdEnvelope.conversationId).conversation.messages;
    assert.deepEqual(visible, [
      { role: 'user', content: 'What should I do next?' },
      { role: 'assistant', content: 'A focused answer.' }
    ]);

    const wrongKindEnvelope = envelope({ conversationId: '7eca7d4c-9a70-4664-884e-88a827bebf9c', operationId: 'wrong-kind', requestKey: 'wrong-kind' });
    const wrongKind = database.admitPiConversationOperation(wrongKindEnvelope, owner);
    const wrongKindStorage = database.createPiSessionStorage(wrongKind.sessionId, owner);
    await wrongKindStorage.commit([
      { kind: 'entry', entry: { id: 'wrong-kind-tip', parentId: null, type: 'message', message: assistant } },
      { kind: 'value', op: 'set', namespace: 'pi.branch.tip', key: 'main', value: 'wrong-kind-tip' },
      { kind: 'value', op: 'set', namespace: 'pi.result', key: wrongKind.operationId,
        value: { operationId: wrongKind.operationId, kind: 'compaction', status: 'completed', fromTipId: null, tipId: 'wrong-kind-tip' } }
    ], {});
    assert.throws(() => database.settlePiConversationOperation(wrongKind.operationId, owner,
      { status: 'completed', tipId: 'wrong-kind-tip', finalAssistant: 'A focused answer.' }), /pi_terminal_mismatch/);

    const wrongPathEnvelope = envelope({ conversationId: '486e3ad1-1684-4115-b58f-7923605fcd71', operationId: 'wrong-path', requestKey: 'wrong-path' });
    const wrongPath = database.admitPiConversationOperation(wrongPathEnvelope, owner);
    const wrongPathStorage = database.createPiSessionStorage(wrongPath.sessionId, owner);
    await wrongPathStorage.commit([
      { kind: 'entry', entry: { id: 'path-origin', parentId: null, type: 'message', message: { role: 'user', content: 'origin', timestamp: Date.now() } } },
      { kind: 'entry', entry: { id: 'detached-tip', parentId: null, type: 'message', message: assistant } },
      { kind: 'value', op: 'set', namespace: 'pi.branch.tip', key: 'main', value: 'detached-tip' },
      { kind: 'value', op: 'set', namespace: 'pi.result', key: wrongPath.operationId,
        value: { operationId: wrongPath.operationId, kind: 'run', status: 'completed', fromTipId: 'path-origin', tipId: 'detached-tip' } }
    ], {});
    assert.throws(() => database.settlePiConversationOperation(wrongPath.operationId, owner,
      { status: 'completed', tipId: 'detached-tip', finalAssistant: 'A focused answer.' }), /pi_terminal_path_mismatch/);
  } finally { database.close(); }
});

test('Harness activation requires an exact drain handoff from an older compatible release', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-rollout-'));
  t.after(() => cleanupExact(root));
  const database = new UnifiedDataStore(root);
  try {
    assert.equal(database.registerPiCompatibilityRelease('0.0.605', 'build-605', 'runtime-605').mode, 'legacy');
    assert.equal(database.recordPiCompatibilityDrain({
      runtimeId: 'runtime-605', releaseVersion: '0.0.605', buildId: 'build-605',
      replacementVersion: '0.0.605', replacementBuildId: 'build-605'
    }), false);
    assert.equal(database.rows('SELECT COUNT(*) AS count FROM pi_release_drains')[0].count, 0);
    database.recordPiCompatibilityDrain({
      runtimeId: 'runtime-605', releaseVersion: '0.0.605', buildId: 'build-605',
      replacementVersion: '0.0.606', replacementBuildId: 'wrong-build'
    });
    assert.equal(database.registerPiCompatibilityRelease('0.0.606', 'build-606', 'runtime-606').mode, 'legacy');
    database.recordPiCompatibilityDrain({
      runtimeId: 'runtime-605', releaseVersion: '0.0.605', buildId: 'build-605',
      replacementVersion: '0.0.606', replacementBuildId: 'build-606'
    });
    assert.equal(database.registerPiCompatibilityRelease('0.0.606', 'build-606', 'runtime-606').mode, 'harness');
  } finally { database.close(); }
});

test('conversation binding and complete visible-history bootstrap commit atomically before admission', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-bootstrap-'));
  t.after(() => cleanupExact(root));
  const database = new UnifiedDataStore(root);
  try {
    const conversationId = 'e4439f84-6d34-4bf9-aee9-53b02a5a70c3';
    const now = new Date().toISOString();
    database.writeIntelligenceConversation({ conversation: { id: conversationId, title: 'history', createdAt: now, updatedAt: now,
      messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'second' }] }, expectedRevision: 0, idempotencyKey: 'bootstrap-history' });
    const owner = database.claimPiExecutionOwner('runtime-bootstrap');
    const operation = database.admitPiConversationOperation(envelope({ conversationId, operationId: 'bootstrap-operation', requestKey: 'bootstrap-operation', baselineRevision: 1 }), owner);
    const storage = database.createPiSessionStorage(operation.sessionId, owner);
    const tip = await storage.getValue({ kind: 'value', namespace: 'pi.branch.tip', key: 'main' }, {});
    assert.ok(tip?.value);
    const entries = await storage.scanBranch({ start: tip.value, order: 'oldestFirst' }, {});
    assert.deepEqual(entries.map(entry => entry.message && { role: entry.message.role, content: typeof entry.message.content === 'string' ? entry.message.content : entry.message.content[0].text }), [
      { role: 'user', content: 'first' }, { role: 'assistant', content: 'second' }
    ]);
  } finally { database.close(); }
});

test('later conversation inputs are durably queued and freeze acceptance only when promoted', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-queue-'));
  t.after(() => cleanupExact(root));
  const database = new UnifiedDataStore(root);
  try {
    const owner = database.claimPiExecutionOwner('runtime-queue');
    const first = database.admitPiConversationOperation(envelope(), owner);
    const second = database.admitPiConversationOperation(envelope({ operationId: 'chat-operation-2', requestKey: 'sidebar-click-2' }), owner);
    assert.equal(first.status, 'accepted');
    assert.equal(second.status, 'queued');
    assert.deepEqual(database.requestPiConversationCancellation({ operationId: second.operationId }, owner), [second.operationId]);
    assert.equal(database.readPiConversationOperation(second.operationId).status, 'aborted');
    assert.equal(database.readPiConversationOperation(second.operationId).cancelRequested, true);
    const third = database.admitPiConversationOperation(envelope({ operationId: 'chat-operation-3', requestKey: 'sidebar-click-3' }), owner);
    assert.equal(third.status, 'queued');
    const storage = database.createPiSessionStorage(first.sessionId, owner);
    const assistant = { role: 'assistant', content: [{ type: 'text', text: 'first answer' }], api: 'agent-cli', provider: 'agent-cli', model: 'auto',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    await storage.commit([
      { kind: 'entry', entry: { id: 'queue-first-answer', parentId: null, type: 'message', message: assistant } },
      { kind: 'value', op: 'set', namespace: 'pi.branch.tip', key: 'main', value: 'queue-first-answer' },
      { kind: 'value', op: 'set', namespace: 'pi.result', key: first.operationId,
        value: { operationId: first.operationId, kind: 'run', status: 'completed', fromTipId: null, tipId: 'queue-first-answer' } }
    ], {});
    database.settlePiConversationOperation(first.operationId, owner, { status: 'completed', tipId: 'queue-first-answer', finalAssistant: 'first answer' });
    const promoted = database.promoteNextPiConversationOperation(first.conversationId, owner);
    assert.equal(promoted.operationId, third.operationId);
    assert.equal(promoted.status, 'accepted');
    assert.equal(promoted.baselineRevision, 1);
    assert.equal(promoted.baselineRevision, promoted.acceptance.baselineRevision, 'the admitted envelope and settlement guard must freeze the same revision');
    assert.deepEqual(database.admitPiConversationOperation(envelope({ operationId: 'chat-operation-3', requestKey: 'sidebar-click-3' }), owner), promoted,
      'retrying the original queued request must preserve idempotency after promotion');
  } finally { database.close(); }
});

test('legacy work drains before an atomic conversation cutover and late legacy work is fenced', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-cutover-'));
  t.after(() => cleanupExact(root));
  const database = new UnifiedDataStore(root);
  try {
    const acceptance = envelope({ conversationId: '254a696c-f4c4-4ebc-b060-ddeb888cbf72' });
    const unknown = database.admitLegacyIntelligenceOperation({
      operationId: 'legacy-unknown', conversationId: acceptance.conversationId, requestKey: 'legacy-unknown',
      prompt: 'unfinished', baselineRevision: 0, source: 'sidebar', ownerPid: process.pid, ownerBirth: 'test-owner'
    });
    database.markLegacyIntelligenceOperation(unknown.operationId, 'unknown');
    const owner = database.claimPiExecutionOwner('runtime-cutover');
    assert.throws(() => database.admitPiConversationOperation(acceptance, owner), /上一次处理尚未完成/);

    const cleanConversation = '6cc738ce-42b4-459d-b327-5356b4680ad7';
    const legacy = database.admitLegacyIntelligenceOperation({
      operationId: 'legacy-settled', conversationId: cleanConversation, requestKey: 'legacy-settled',
      prompt: 'legacy question', baselineRevision: 0, source: 'sidebar', ownerPid: process.pid, ownerBirth: 'test-owner'
    });
    const now = new Date().toISOString();
    database.writeLegacyIntelligenceConversation(legacy.operationId, {
      conversation: { id: cleanConversation, title: 'legacy question', createdAt: now, updatedAt: now,
        messages: [{ role: 'user', content: 'legacy question' }, { role: 'assistant', content: 'legacy answer' }] },
      expectedRevision: 0, idempotencyKey: 'legacy-write'
    });
    const native = database.admitPiConversationOperation(envelope({
      conversationId: cleanConversation, operationId: 'native-after-legacy', requestKey: 'native-after-legacy', baselineRevision: 1
    }), owner);
    assert.equal(native.status, 'accepted');
    assert.throws(() => database.writeIntelligenceConversation({ conversation: {
      id: cleanConversation, title: 'legacy question', createdAt: now, updatedAt: new Date().toISOString(),
      messages: [{ role: 'user', content: 'legacy question' }, { role: 'assistant', content: 'legacy answer' },
        { role: 'user', content: 'late' }, { role: 'assistant', content: 'late answer' }]
    }, expectedRevision: 1, idempotencyKey: 'late-visible-write' }), /intelligence_conversation_migrated/);
    assert.throws(() => database.writeIntelligenceConversation({ conversation: {
      id: cleanConversation, title: 'legacy question', createdAt: now, updatedAt: new Date().toISOString(),
      messages: [{ role: 'user', content: 'legacy question' }, { role: 'assistant', content: 'legacy answer' },
        { role: 'user', content: 'spoofed' }, { role: 'assistant', content: 'spoofed answer' }]
    }, expectedRevision: 1, idempotencyKey: 'pi-settlement:spoofed-old-writer' }), /intelligence_conversation_migrated/);
    assert.throws(() => database.admitLegacyIntelligenceOperation({
      operationId: 'legacy-late', conversationId: cleanConversation, requestKey: 'legacy-late',
      prompt: 'late question', baselineRevision: 1, source: 'sidebar', ownerPid: process.pid, ownerBirth: 'test-owner'
    }), /intelligence_conversation_migrated/);

    const crashedConversation = 'c526b6ce-7d6f-4244-8d74-f5e2d59ce865';
    database.admitLegacyIntelligenceOperation({ operationId: 'legacy-crashed-clean', conversationId: crashedConversation,
      requestKey: 'legacy-crashed-clean', prompt: 'crashed before tools', baselineRevision: 0, source: 'sidebar',
      ownerPid: 999999, ownerBirth: 'missing-process' });
    const afterCleanCrash = database.admitPiConversationOperation(envelope({ conversationId: crashedConversation,
      operationId: 'native-after-clean-crash', requestKey: 'native-after-clean-crash' }), owner);
    assert.equal(afterCleanCrash.status, 'accepted');
    assert.equal(database.readLegacyIntelligenceOperation('legacy-crashed-clean').status, 'failed');
  } finally { database.close(); }
});

test('settled Pi detail is bounded and native compaction safely re-roots the recoverable branch', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-retention-'));
  t.after(() => cleanupExact(root));
  const database = new UnifiedDataStore(root);
  try {
    const owner = database.claimPiExecutionOwner('runtime-retention');
    const conversationId = 'd99364db-5409-4828-ad6c-7a20639cd67c';
    for (let index = 0; index < 140; index += 1) {
      const operation = database.admitPiConversationOperation(envelope({ conversationId,
        operationId: `retention-operation-${index}`, requestKey: `retention-request-${index}` }), owner);
      database.admitPiToolInvocation(operation.operationId, owner, {
        invocationId: `retention-tool-${index}`, toolName: 'solomap_read', arguments: { index }, replay: 'safe'
      });
      database.markPiConversationOperation(operation.operationId, owner, { status: 'failed', tipId: null });
    }
    const before = Number(database.rows('SELECT COUNT(*) AS count FROM pi_tool_invocations')[0].count);
    const retention = database.maintainPiExecutionRetention(conversationId, owner);
    assert.equal(before, 140);
    assert.equal(retention.prunedToolInvocations, 12);
    assert.equal(database.rows('SELECT COUNT(*) AS count FROM pi_tool_invocations')[0].count, 128);

    const compactConversation = '9b8ddf67-e01f-46bd-9a5b-3693380569e9';
    const operation = database.admitPiConversationOperation(envelope({ conversationId: compactConversation,
      operationId: 'compaction-run', requestKey: 'compaction-run' }), owner);
    const storage = database.createPiSessionStorage(operation.sessionId, owner);
    const assistant = { role: 'assistant', content: [{ type: 'text', text: 'answer before compaction' }], api: 'agent-cli', provider: 'agent-cli', model: 'auto',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    await storage.commit([
      { kind: 'entry', entry: { id: 'settled-assistant', parentId: null, type: 'message', message: assistant } },
      { kind: 'value', op: 'set', namespace: 'pi.branch.tip', key: 'main', value: 'settled-assistant' },
      { kind: 'value', op: 'set', namespace: 'pi.result', key: operation.operationId,
        value: { operationId: operation.operationId, kind: 'run', status: 'completed', fromTipId: null, tipId: 'settled-assistant' } }
    ], {});
    database.settlePiConversationOperation(operation.operationId, owner,
      { status: 'completed', tipId: 'settled-assistant', finalAssistant: 'answer before compaction' });
    await storage.commit([
      { kind: 'entry', entry: { id: 'native-compaction', parentId: 'settled-assistant', type: 'compaction', summary: 'durable summary', retainedTail: [], tokensBefore: 20, fromHook: false } },
      { kind: 'value', op: 'set', namespace: 'pi.branch.tip', key: 'main', value: 'native-compaction' }
    ], {});
    const compacted = database.maintainPiExecutionRetention(compactConversation, owner);
    assert.equal(compacted.compacted, true);
    assert.equal(database.rows("SELECT COUNT(*) AS count FROM pi_entries WHERE session_id=? AND id='settled-assistant'", [operation.sessionId])[0].count, 0);
    assert.equal(database.rows("SELECT parent_id FROM pi_entries WHERE session_id=? AND id='native-compaction'", [operation.sessionId])[0].parent_id, null);
    assert.deepEqual(database.settlePiConversationOperation(operation.operationId, owner,
      { status: 'completed', tipId: 'settled-assistant', finalAssistant: 'answer before compaction' }),
    database.settlePiConversationOperation(operation.operationId, owner,
      { status: 'completed', tipId: 'settled-assistant', finalAssistant: 'answer before compaction' }));
  } finally { database.close(); }
});
