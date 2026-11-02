const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { IntelligenceRuntime } = require('../out/intelligenceRuntime.js');
const { CognitiveCliProcessExecutor } = require('../out/cognitiveCliProcessExecutor.js');

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

test('Pi ingress is durable before preparation and preserves per-conversation admission order', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-ingress-'));
  t.after(() => cleanupExact(root));
  const database = new UnifiedDataStore(root);
  try {
    const owner = database.claimPiExecutionOwner('runtime-ingress');
    const firstInput = {
      conversationId: envelope().conversationId, operationId: 'ingress-operation-1', requestKey: 'ingress-request-1',
      text: 'first durable prompt', source: 'sidebar', sourceGeneration: 1, requireExisting: false
    };
    const first = database.admitPiConversationIngress(firstInput, owner);
    assert.equal(first.status, 'admitted');
    assert.equal(first.baselineRevision, 0);
    assert.deepEqual(database.admitPiConversationIngress(firstInput, owner), first);
    assert.throws(() => database.admitPiConversationIngress({ ...firstInput, text: 'changed prompt' }, owner), /idempotency_conflict/);

    const secondInput = { ...firstInput, operationId: 'ingress-operation-2', requestKey: 'ingress-request-2', text: 'second durable prompt' };
    const second = database.admitPiConversationIngress(secondInput, owner);
    database.db.run('UPDATE pi_conversation_ingress SET created_at=? WHERE operation_id IN (?,?)', [1, first.operationId, second.operationId]);
    assert.deepEqual(database.listRecoverablePiConversationIngresses().map(item => item.operationId), [first.operationId]);
    assert.deepEqual(database.listRecoverablePiConversationIngresses(first.conversationId).map(item => item.operationId), [first.operationId, second.operationId]);
    assert.throws(() => database.materializePiConversationIngress(second.operationId,
      envelope({ operationId: second.operationId, requestKey: second.requestKey, prompt: second.text }), owner), /pi_ingress_predecessor_pending/);

    const firstOperation = database.materializePiConversationIngress(first.operationId,
      envelope({ operationId: first.operationId, requestKey: first.requestKey, prompt: first.text }), owner);
    assert.equal(firstOperation.status, 'accepted');
    const secondOperation = database.materializePiConversationIngress(second.operationId,
      envelope({ operationId: second.operationId, requestKey: second.requestKey, prompt: second.text }), owner);
    assert.equal(secondOperation.status, 'queued');
    assert.equal(database.listRecoverablePiConversationIngresses().length, 0);
  } finally { database.close(); }
});

test('Pi ingress cancellation is monotonic and a delayed retry cannot revive accepted work', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-ingress-cancel-'));
  t.after(() => cleanupExact(root));
  const database = new UnifiedDataStore(root);
  try {
    const owner = database.claimPiExecutionOwner('runtime-ingress-cancel');
    const input = {
      conversationId: envelope().conversationId, operationId: 'cancelled-ingress-operation', requestKey: 'cancelled-ingress-request',
      text: 'do not revive this prompt', source: 'sidebar', sourceGeneration: 1, requireExisting: false
    };
    database.admitPiConversationIngress(input, owner);
    assert.deepEqual(database.requestPiConversationCancellation({ operationId: input.operationId }, owner), [input.operationId]);
    assert.equal(database.admitPiConversationIngress(input, owner).status, 'cancelled');
    assert.deepEqual(database.requestPiConversationCancellation({ operationId: input.operationId }, owner), [input.operationId]);
    assert.equal(database.readPiConversationIngress(input.operationId).status, 'cancelled');
  } finally { database.close(); }
});

test('preparation failures retain their root cause and durable retry schedule without becoming cancellations', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-ingress-retry-'));
  t.after(() => cleanupExact(root));
  const database = new UnifiedDataStore(root);
  try {
    const owner = database.claimPiExecutionOwner('runtime-ingress-retry');
    const input = {
      conversationId: envelope().conversationId, operationId: 'retry-ingress-operation', requestKey: 'retry-ingress-request',
      text: 'retain this accepted prompt', source: 'sidebar', sourceGeneration: 1, requireExisting: false
    };
    database.admitPiConversationIngress(input, owner);
    const retry = database.recordPiConversationIngressFailure(input.operationId, owner, new Error('MCP preparation unavailable'));
    const saved = database.readPiConversationIngress(input.operationId);
    assert.equal(saved.status, 'admitted');
    assert.equal(saved.lastError, 'MCP preparation unavailable');
    assert.equal(saved.retryCount, 1);
    assert.equal(saved.retryAt, retry.retryAt);
    assert.deepEqual(database.listRecoverablePiConversationIngresses(), [], 'backoff must not hot-loop a transient failure');
    database.db.run('UPDATE pi_conversation_ingress SET retry_at=0 WHERE operation_id=?', [input.operationId]);
    assert.deepEqual(database.listRecoverablePiConversationIngresses().map(item => item.operationId), [input.operationId]);
  } finally { database.close(); }
});

test('Pi session commits and tool completion replay from durable receipts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-commit-receipt-'));
  t.after(() => cleanupExact(root));
  const database = new UnifiedDataStore(root);
  try {
    const owner = database.claimPiExecutionOwner('runtime-commit');
    const operation = database.admitPiConversationOperation(envelope(), owner);
    const storage = database.createPiSessionStorage(operation.sessionId, owner);
    const writes = [{ kind: 'value', op: 'set', namespace: 'receipt', key: 'proof', value: 'committed-once' }];
    const first = await storage.commit(writes, { commitId: 'commit-receipt-1' });
    assert.deepEqual(await storage.commit(writes, { commitId: 'commit-receipt-1' }), first);
    await assert.rejects(storage.commit([{ ...writes[0], value: 'different' }], { commitId: 'commit-receipt-1' }), /idempotency_conflict/);
    database.admitPiToolInvocation(operation.operationId, owner, {
      invocationId: 'tool-complete-replay', toolName: 'solomap_read', arguments: {}, replay: 'safe'
    });
    const result = { content: [{ type: 'text', text: 'persisted tool result' }] };
    database.completePiToolInvocation(operation.operationId, 'tool-complete-replay', owner, result);
    assert.doesNotThrow(() => database.completePiToolInvocation(operation.operationId, 'tool-complete-replay', owner, result));
    const replacementOwner = database.claimPiExecutionOwner('runtime-commit-replacement');
    const replay = database.admitPiToolInvocation(operation.operationId, replacementOwner, {
      invocationId: 'tool-complete-replay', toolName: 'solomap_read', arguments: {}, replay: 'safe'
    });
    assert.equal(replay.completed, true);
    assert.deepEqual(replay.result, result, 'a replacement Worker must reuse the committed result without replaying the tool');
    await storage.close({});
  } finally { database.close(); }
});

test('schema 72 gives pre-upgrade completed tools a durable non-replay receipt', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-tool-v71-'));
  t.after(() => cleanupExact(root));
  let database = new UnifiedDataStore(root);
  const owner = database.claimPiExecutionOwner('runtime-v71');
  const operation = database.admitPiConversationOperation(envelope({ operationId: 'legacy-tool-operation', requestKey: 'legacy-tool-operation' }), owner);
  database.admitPiToolInvocation(operation.operationId, owner, {
    invocationId: 'legacy-completed-tool', toolName: 'update_settings', arguments: {}, replay: 'never'
  });
  database.db.run("UPDATE pi_tool_invocations SET status='completed' WHERE operation_id=? AND invocation_id=?",
    [operation.operationId, 'legacy-completed-tool']);
  database.close();
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(path.join(root, 'solomap.db'));
  raw.exec(`PRAGMA foreign_keys=OFF;
    DROP INDEX content_ref_pi_tool_invocations_result;
    DROP INDEX content_ref_pi_ingress_last_error;
    DROP INDEX pi_conversation_ingress_recovery;
    ALTER TABLE pi_tool_invocations DROP COLUMN result_content_id;
    ALTER TABLE pi_conversation_ingress DROP COLUMN last_error_content_id;
    ALTER TABLE pi_conversation_ingress DROP COLUMN retry_count;
    ALTER TABLE pi_conversation_ingress DROP COLUMN retry_at;
    CREATE INDEX pi_conversation_ingress_recovery ON pi_conversation_ingress(status,created_at,operation_id);
    DELETE FROM schema_migrations WHERE version=72;
    PRAGMA foreign_keys=ON;`);
  raw.close();
  database = new UnifiedDataStore(root);
  try {
    const replacement = database.claimPiExecutionOwner('runtime-v72');
    const replay = database.admitPiToolInvocation(operation.operationId, replacement, {
      invocationId: 'legacy-completed-tool', toolName: 'update_settings', arguments: {}, replay: 'never'
    });
    assert.equal(replay.completed, true);
    assert.equal(replay.result.isError, true);
    assert.match(replay.result.content[0].text, /will not be executed again/i);
  } finally { database.close(); }
});

test('recovery exposes only the due head of each conversation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-ingress-order-'));
  t.after(() => cleanupExact(root));
  const database = new UnifiedDataStore(root);
  try {
    const owner = database.claimPiExecutionOwner('runtime-ingress-order');
    const first = { schemaVersion: 1, conversationId: envelope().conversationId, operationId: 'ordered-first', requestKey: 'ordered-first', prompt: 'first', text: 'first', source: 'sidebar', sourceGeneration: 1, requireExisting: false };
    const second = { ...first, operationId: 'ordered-second', requestKey: 'ordered-second', prompt: 'second', text: 'second' };
    database.admitPiConversationIngress(first, owner);
    database.recordPiConversationIngressFailure(first.operationId, owner, new Error('deferred'));
    database.admitPiConversationIngress(second, owner);
    assert.deepEqual(database.listRecoverablePiConversationIngresses(), [], 'a later due ingress cannot overtake a deferred head');
    assert.ok(database.nextPiConversationIngressRetryAt() > Date.now());
    assert.deepEqual(database.listRecoverablePiConversationIngresses(first.conversationId).map(item => item.operationId),
      ['ordered-first', 'ordered-second']);
  } finally { database.close(); }
});

test('Intelligence execution slots bound detached and recovery work to two concurrent model calls', async () => {
  const runtime = Object.create(IntelligenceRuntime.prototype);
  runtime.closed = false;
  runtime.activeExecutionSlots = 0;
  runtime.executionWaiters = [];
  let active = 0, maximum = 0;
  const releases = [];
  const action = () => runtime.withExecutionSlot(async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => releases.push(resolve));
    active--;
  });
  const work = [action(), action(), action(), action()];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(maximum, 2);
  assert.equal(active, 2);
  releases.shift()(); releases.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active, 2);
  while (releases.length) releases.shift()();
  await Promise.all(work);
  assert.equal(maximum, 2);
});

test('Intelligence execution slots transfer permits without allowing a newcomer to barge past a waiter', async () => {
  const runtime = Object.create(IntelligenceRuntime.prototype);
  runtime.closed = false;
  runtime.activeExecutionSlots = 0;
  runtime.executionWaiters = [];
  let active = 0, maximum = 0;
  const releases = [];
  const action = () => runtime.withExecutionSlot(async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => releases.push(resolve));
    active--;
  });
  const first = action(), second = action(), waiter = action();
  await new Promise(resolve => setImmediate(resolve));
  releases.shift()();
  const newcomer = action();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(maximum, 2);
  releases.shift()();
  releases.shift()();
  await new Promise(resolve => setImmediate(resolve));
  releases.shift()();
  await Promise.all([first, second, waiter, newcomer]);
});

test('Cognitive CLI permits transfer atomically to queued invocations', async () => {
  const executor = new CognitiveCliProcessExecutor();
  await executor.acquire();
  await executor.acquire();
  const waiter = executor.acquire();
  executor.release();
  const newcomer = executor.acquire();
  await Promise.resolve();
  assert.equal(executor.activeInvocations, 2);
  executor.release();
  await waiter;
  executor.release();
  await newcomer;
  executor.release();
  await executor.close();
});

test('recovery never waits for a submission queued behind the conversation lane it owns', async () => {
  const runtime = Object.create(IntelligenceRuntime.prototype);
  Object.assign(runtime, {
    closed: false, activeExecutionSlots: 0, executionWaiters: [], retryWaiters: new Set(),
    conversationLanes: new Map(), submissions: new Map(), backgroundMaintenance: new Set(), active: new Map(),
    persistence: {
      promoteRecoverable: async () => {},
      listRecoverable: async () => [{ operationId: 'recover-op', conversationId: 'recover-conversation' }],
      listRecoverableIngresses: async () => [],
      nextIngressRetryAt: async () => -1
    }
  });
  runtime.execute = async () => ({ id: 'recovered' });
  let releaseFirst, releaseSecond;
  const first = runtime.withExecutionSlot(() => new Promise(resolve => { releaseFirst = resolve; }));
  const second = runtime.withExecutionSlot(() => new Promise(resolve => { releaseSecond = resolve; }));
  const recovering = runtime.recoverPending();
  await new Promise(resolve => setImmediate(resolve));
  const submitted = runtime.withConversationLane('recover-conversation', async () => ({ id: 'submitted' }));
  runtime.submissions.set('recover-op', { identity: 'same', promise: submitted });
  releaseFirst();
  await Promise.race([
    recovering,
    new Promise((_, reject) => setTimeout(() => reject(new Error('recovery_lane_deadlock')), 500))
  ]);
  releaseSecond();
  await Promise.all([first, second, submitted]);
});

test('an accepted ingress waits through preparation retry and cannot be overtaken in its conversation', async () => {
  const runtime = Object.create(IntelligenceRuntime.prototype);
  const early = { operationId: 'early', conversationId: 'ordered-conversation', retryAt: 0 };
  const target = { operationId: 'target', conversationId: 'ordered-conversation', retryAt: 0 };
  const pending = [early, target];
  const attempts = [], ingressState = new Map(pending.map(item => [item.operationId, { ...item, status: 'admitted' }]));
  Object.assign(runtime, {
    closed: false, activeExecutionSlots: 0, executionWaiters: [], retryWaiters: new Set(), conversationLanes: new Map(),
    persistence: {
      listRecoverable: async () => [],
      listRecoverableIngresses: async () => [...pending],
      readIngress: async id => ingressState.get(id) || null,
      readOperation: async () => null
    }
  });
  let failedOnce = false;
  runtime.executeIngress = async ingress => {
    attempts.push(ingress.operationId);
    if (ingress.operationId === 'early' && !failedOnce) {
      failedOnce = true;
      const deferred = { ...early, status: 'admitted', retryAt: Date.now() + 25 };
      ingressState.set('early', deferred);
      pending[0] = deferred;
      throw new Error('preparation_temporarily_unavailable');
    }
    pending.shift();
    ingressState.delete(ingress.operationId);
    return { id: ingress.operationId };
  };
  const keptAlive = setTimeout(() => {}, 100);
  try {
    assert.deepEqual(await runtime.runIngress(target), { id: 'target' });
  } finally { clearTimeout(keptAlive); }
  assert.deepEqual(attempts, ['early', 'early', 'target']);
});

test('an earlier recovery deadline replaces a later pending timer', async () => {
  const runtime = Object.create(IntelligenceRuntime.prototype);
  let recoveredAt = 0;
  Object.assign(runtime, {
    closed: false, recoveryRequested: false, recoveryTimer: undefined, recoveryTimerAt: 0,
    recover: async () => { recoveredAt = Date.now(); return { recovered: 0, failed: 0 }; }
  });
  const started = Date.now();
  const keptAlive = setTimeout(() => {}, 150);
  try {
    runtime.scheduleRecovery(100);
    runtime.scheduleRecovery(15);
    while (!recoveredAt) await new Promise(resolve => setTimeout(resolve, 5));
  } finally {
    clearTimeout(keptAlive);
    if (runtime.recoveryTimer) clearTimeout(runtime.recoveryTimer);
  }
  assert.ok(recoveredAt - started < 70, `earlier recovery was delayed ${recoveredAt - started}ms`);
});

test('a settled intelligence result replays from durable conversation state', async () => {
  const runtime = Object.create(IntelligenceRuntime.prototype);
  const target = { operationId: 'settled-operation', conversationId: 'settled-conversation', retryAt: 0 };
  Object.assign(runtime, {
    closed: false, activeExecutionSlots: 0, executionWaiters: [], retryWaiters: new Set(), conversationLanes: new Map(),
    persistence: {
      listRecoverable: async () => [],
      listRecoverableIngresses: async () => [],
      readOperation: async () => ({ ...target, status: 'settled' }),
      readConversation: async () => ({ revision: 2, conversation: { id: target.conversationId, messages: ['durable-result'] } }),
      readIngress: async () => ({ ...target, status: 'materialized' })
    }
  });
  runtime.execute = async () => { throw new Error('settled_result_must_not_execute'); };
  assert.deepEqual(await runtime.runIngress(target), { id: target.conversationId, messages: ['durable-result'] });
});

test('a materialized predecessor recovers before a later admitted ingress takes its conversation lane', async () => {
  const runtime = Object.create(IntelligenceRuntime.prototype);
  const predecessor = { operationId: 'materialized-predecessor', conversationId: 'materialized-conversation', status: 'accepted' };
  const target = { operationId: 'later-ingress', conversationId: predecessor.conversationId, retryAt: 0, status: 'admitted' };
  let recoverable = [predecessor], admitted = [target];
  const order = [];
  Object.assign(runtime, {
    closed: false, activeExecutionSlots: 0, executionWaiters: [], retryWaiters: new Set(), conversationLanes: new Map(),
    persistence: {
      listRecoverable: async conversationId => conversationId === target.conversationId ? recoverable : [],
      listRecoverableIngresses: async () => admitted,
      readOperation: async () => null,
      readIngress: async id => id === target.operationId && admitted.length ? target : null
    }
  });
  runtime.execute = async operation => { order.push(operation.operationId); recoverable = []; return { id: operation.operationId }; };
  runtime.executeIngress = async ingress => { order.push(ingress.operationId); admitted = []; return { id: ingress.operationId }; };
  assert.deepEqual(await runtime.runIngress(target), { id: target.operationId });
  assert.deepEqual(order, [predecessor.operationId, target.operationId]);
});

test('startup recovery drains every newly exposed conversation head and rebuilds a deferred deadline', async () => {
  const runtime = Object.create(IntelligenceRuntime.prototype);
  const first = { operationId: 'restart-first', conversationId: 'restart-conversation' };
  const second = { operationId: 'restart-second', conversationId: 'restart-conversation' };
  let heads = [first], nextRetryAt = 0;
  const submitted = [], scheduled = [];
  Object.assign(runtime, {
    closed: false,
    persistence: {
      promoteRecoverable: async () => {},
      listRecoverable: async () => [],
      listRecoverableIngresses: async conversationId => conversationId ? [] : heads,
      nextIngressRetryAt: async () => nextRetryAt
    }
  });
  runtime.submitIngress = async ingress => {
    submitted.push(ingress.operationId);
    heads = ingress === first ? [second] : [];
    if (ingress === second) nextRetryAt = Date.now() + 2_000;
    return { id: ingress.operationId };
  };
  runtime.scheduleRecovery = delay => scheduled.push(delay);
  await runtime.recoverPending();
  assert.deepEqual(submitted, [first.operationId, second.operationId]);
  assert.ok(scheduled.length === 1 && scheduled[0] > 0 && scheduled[0] <= 2_000);
});

test('startup recovery converts a deadline crossed between queries into an immediate wakeup', async () => {
  const runtime = Object.create(IntelligenceRuntime.prototype);
  const scheduled = [];
  Object.assign(runtime, {
    closed: false,
    persistence: {
      promoteRecoverable: async () => {}, listRecoverable: async () => [], listRecoverableIngresses: async () => [],
      nextIngressRetryAt: async () => Date.now() - 1
    }
  });
  runtime.scheduleRecovery = delay => scheduled.push(delay);
  await runtime.recoverPending();
  assert.deepEqual(scheduled, [0]);
});

test('cancelling an ingress wakes durable backoff immediately without entering preparation', async () => {
  const runtime = Object.create(IntelligenceRuntime.prototype);
  const target = { operationId: 'cancel-backoff', conversationId: 'cancel-conversation', retryAt: Date.now() + 30_000, status: 'admitted' };
  let state = target, prepared = false;
  Object.assign(runtime, {
    closed: false, activeExecutionSlots: 0, executionWaiters: [], retryWaiters: new Set(), conversationLanes: new Map(),
    submissions: new Map(), active: new Map(), owner: { ownerId: 'cancel-owner', generation: 1 },
    persistence: {
      listRecoverable: async () => [],
      listRecoverableIngresses: async () => state.status === 'admitted' ? [state] : [],
      readOperation: async () => null,
      readIngress: async () => state,
      requestCancellation: async () => { state = { ...state, status: 'cancelled' }; return [target.operationId]; }
    }
  });
  runtime.executeIngress = async () => { prepared = true; return { id: 'unexpected' }; };
  runtime.scheduleRecovery = () => {};
  const submission = runtime.runIngress(target);
  runtime.submissions.set(target.operationId, { identity: 'cancel', promise: submission });
  await new Promise(resolve => setImmediate(resolve));
  const result = await Promise.race([
    runtime.cancel({ operationId: target.operationId }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('cancel_waited_for_retry_deadline')), 250))
  ]);
  assert.deepEqual(result, { cancelled: true });
  assert.equal(prepared, false);
});

test('cancelling one ingress does not wake an unrelated conversation backoff', async () => {
  const runtime = Object.create(IntelligenceRuntime.prototype);
  Object.assign(runtime, {
    closed: false, retryWaiters: new Set(), submissions: new Map(), active: new Map(),
    owner: { ownerId: 'scoped-cancel-owner', generation: 1 },
    persistence: { requestCancellation: async () => ['cancel-a'] }
  });
  runtime.scheduleRecovery = () => {};
  let aWoke = false, bWoke = false;
  const a = runtime.waitForRetry(Date.now() + 30_000, 'cancel-a').then(() => { aWoke = true; });
  const b = runtime.waitForRetry(Date.now() + 30_000, 'keep-b').then(() => { bWoke = true; });
  await new Promise(resolve => setImmediate(resolve));
  await runtime.cancel({ operationId: 'cancel-a' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aWoke, true);
  assert.equal(bWoke, false);
  runtime.closed = true;
  for (const waiter of runtime.retryWaiters) waiter.wake();
  await Promise.allSettled([a, b]);
});

test('cancelling a durable-only deferred head immediately schedules its newly exposed conversation head', async () => {
  const runtime = Object.create(IntelligenceRuntime.prototype);
  Object.assign(runtime, {
    closed: false, retryWaiters: new Set(), submissions: new Map(), active: new Map(),
    owner: { ownerId: 'durable-cancel-owner', generation: 1 },
    persistence: { requestCancellation: async () => ['durable-future-head'] }
  });
  const scheduled = [];
  runtime.scheduleRecovery = delay => scheduled.push(delay);
  assert.deepEqual(await runtime.cancel({ operationId: 'durable-future-head' }), { cancelled: true });
  assert.deepEqual(scheduled, [0]);
});

test('handoff drain waits for detached active intelligence without cancelling its engine', async () => {
  const runtime = Object.create(IntelligenceRuntime.prototype);
  let release, cancelled = false;
  const active = new Promise(resolve => { release = resolve; });
  Object.assign(runtime, {
    draining: false, drainPromise: undefined, recoveryRequested: true, recoveryTimer: undefined, recoveryTimerAt: 0,
    retryWaiters: new Set(), submissions: new Map(), recoveryPromise: undefined,
    active: new Map([['detached-operation', { engine: { cancel: () => { cancelled = true; } }, promise: active }]])
  });
  let drained = false;
  const draining = runtime.drain().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  assert.equal(cancelled, false);
  runtime.active.clear();
  release({ id: 'completed' });
  await draining;
  assert.equal(cancelled, false);
});

test('handoff drain releases durable retry waiters for replacement recovery without waiting for their deadline', async () => {
  const runtime = Object.create(IntelligenceRuntime.prototype);
  const target = { operationId: 'handoff-retry', conversationId: 'handoff-retry-conversation', retryAt: Date.now() + 30_000, status: 'admitted' };
  let executed = false;
  Object.assign(runtime, {
    closed: false, draining: false, drainPromise: undefined, recoveryRequested: false, recoveryTimer: undefined, recoveryTimerAt: 0,
    activeExecutionSlots: 0, executionWaiters: [], retryWaiters: new Set(), conversationLanes: new Map(),
    submissions: new Map(), active: new Map(), recoveryPromise: undefined,
    persistence: {
      listRecoverable: async () => [], listRecoverableIngresses: async () => [target],
      readOperation: async () => null, readIngress: async () => target
    }
  });
  runtime.executeIngress = async () => { executed = true; return { id: 'unexpected' }; };
  const submission = runtime.submitIngress(target);
  const settled = Promise.allSettled([submission]);
  await new Promise(resolve => setImmediate(resolve));
  await Promise.race([
    runtime.drain(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('handoff_waited_for_retry_deadline')), 250))
  ]);
  assert.equal(executed, false);
  assert.match((await settled)[0].reason.message, /intelligence_runtime_draining/);
});

test('handoff recovery does not acquire newly discovered materialized work after draining begins', async () => {
  const runtime = Object.create(IntelligenceRuntime.prototype);
  let executed = false;
  Object.assign(runtime, {
    closed: false, draining: true, submissions: new Map(), conversationLanes: new Map(),
    activeExecutionSlots: 0, executionWaiters: [],
    persistence: {
      promoteRecoverable: async () => {},
      listRecoverable: async () => [{ operationId: 'replacement-work', conversationId: 'replacement-conversation' }],
      listRecoverableIngresses: async () => [], nextIngressRetryAt: async () => -1
    }
  });
  runtime.execute = async () => { executed = true; return { id: 'unexpected' }; };
  await runtime.recoverPending();
  assert.equal(executed, false);
});

test('a failed reversible handoff can resume Intelligence recovery on the same Runtime', async () => {
  const runtime = Object.create(IntelligenceRuntime.prototype);
  Object.assign(runtime, { closed: false, draining: true, drainPromise: Promise.resolve() });
  const scheduled = [];
  runtime.scheduleRecovery = delay => scheduled.push(delay);
  await runtime.resume();
  assert.equal(runtime.draining, false);
  assert.equal(runtime.drainPromise, undefined);
  assert.deepEqual(scheduled, [0]);
});

test('a failed Intelligence resume never clears draining or advertises recovery', async () => {
  const runtime = Object.create(IntelligenceRuntime.prototype);
  const failure = Promise.reject(new Error('drain_settlement_failed'));
  failure.catch(() => undefined);
  Object.assign(runtime, { closed: false, draining: true, drainPromise: failure });
  let scheduled = false;
  runtime.scheduleRecovery = () => { scheduled = true; };
  await assert.rejects(runtime.resume(), /drain_settlement_failed/);
  assert.equal(runtime.draining, true);
  assert.equal(runtime.drainPromise, failure);
  assert.equal(scheduled, false);
});

test('Remote Pi commits replay one ambiguous durable batch across an External Worker restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-remote-commit-'));
  t.after(() => cleanupExact(root));
  const database = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(database);
  try {
    const owner = database.claimPiExecutionOwner('runtime-remote-commit');
    const operation = database.admitPiConversationOperation(envelope({ operationId: 'remote-commit-operation', requestKey: 'remote-commit-operation' }), owner);
    let failAcknowledgement = true;
    const request = async request => {
      if (request.operation === 'ack_pi_session_commit' && failAcknowledgement) {
        failAcknowledgement = false;
        throw new Error('connection_lost_after_commit');
      }
      return operations(request);
    };
    const { RemoteIntelligencePersistence } = require('../out/intelligencePersistence.js');
    const writes = [{ kind: 'value', op: 'set', namespace: 'receipt', key: 'ambiguous', value: 'committed-once' }];
    const first = await new RemoteIntelligencePersistence(request).sessionStorage(operation.sessionId, owner, operation.operationId);
    await assert.rejects(first.commit(writes), /connection_lost_after_commit/);
    await first.close();
    const nextSeq = Number(database.rows('SELECT next_seq FROM pi_sessions WHERE session_id=?', [operation.sessionId])[0].next_seq);
    const restarted = await new RemoteIntelligencePersistence(request).sessionStorage(operation.sessionId, owner, operation.operationId);
    await restarted.commit(writes);
    await restarted.close();
    assert.equal(Number(database.rows('SELECT next_seq FROM pi_sessions WHERE session_id=?', [operation.sessionId])[0].next_seq), nextSeq);
    assert.equal(database.rows('SELECT COUNT(*) AS count FROM pi_session_commits WHERE session_id=?', [operation.sessionId])[0].count, 1);
  } finally { await operations.close(); database.close(); }
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

test('An asynchronous Pi tool guard never absorbs an unrelated foreground commit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-tool-guard-'));
  t.after(() => cleanupExact(root));
  const database = new UnifiedDataStore(root);
  try {
    const owner = database.claimPiExecutionOwner('runtime-a');
    const operation = database.admitPiConversationOperation(envelope(), owner);
    database.admitPiToolInvocation(operation.operationId, owner, {
      invocationId: 'tool-export', toolName: 'solomap_export', arguments: {}, replay: 'safe'
    });
    let rejectGuarded;
    const guarded = database.withPiToolInvocationGuard(operation.operationId, 'tool-export', owner,
      () => new Promise((_resolve, reject) => { rejectGuarded = reject; }));
    await new Promise(resolve => setImmediate(resolve));
    database.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'independent-foreground-write',
      data: { category: 'inbox', title: 'must survive guarded failure', status: 'captured', content: 'committed independently' } });
    assert.equal(database.rows("SELECT COUNT(*) AS count FROM memories WHERE title='must survive guarded failure'")[0].count, 1);
    rejectGuarded(new Error('injected_guarded_failure'));
    await assert.rejects(guarded, /injected_guarded_failure/);
    assert.equal(database.rows("SELECT COUNT(*) AS count FROM memories WHERE title='must survive guarded failure'")[0].count, 1,
      'a failed asynchronous tool must not roll back an already acknowledged unrelated write');
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
  const { LocalIntelligencePersistence } = require('../out/intelligencePersistence.js');
  const runtime = await IntelligenceRuntime.create(root, new LocalIntelligencePersistence(database), operations, 'runtime-recovery', '0.0.605', 'build-recovery');
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

test('durable intelligence admission transfers execution responsibility before returning its receipt', async () => {
  const runtime = Object.create(IntelligenceRuntime.prototype);
  runtime.closed = false;
  runtime.executionMode = 'harness';
  runtime.submissions = new Map();
  runtime.persistence = {
    admitIngress: async input => ({ ...input, status: 'admitted', baselineRevision: 0, ownerGeneration: 1, createdAt: 123, updatedAt: 123 })
  };
  let dispatched = 0;
  runtime.recover = () => { dispatched += 1; return Promise.resolve({ recovered: 0, failed: 0 }); };
  const operationId = crypto.randomUUID(), conversationId = crypto.randomUUID();

  const receipt = await runtime.admit({ text: 'accepted work', operationId, requestId: operationId, conversationId, source: 'sidebar' });

  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.operationId, operationId);
  assert.equal(dispatched, 1, 'the durable dispatcher owns execution before the caller can disappear after receiving the receipt');
});

test('a normal model failure durably terminates the operation and releases the next conversation item', async t => {
  const runtime = Object.create(IntelligenceRuntime.prototype);
  runtime.closed = false;
  runtime.active = new Map();
  runtime.backgroundMaintenance = new Set();
  runtime.cognitiveRunnerFactory = undefined;
  const statuses = [], promoted = [];
  runtime.persistence = {
    readConversation: async () => null,
    markOperation: async (_id, _owner, terminal) => { statuses.push(terminal.status); return {}; },
    readOperation: async () => ({ cancelRequested: false }),
    sessionStorage: async () => ({ close: async () => undefined }),
    promoteNext: async conversationId => { promoted.push(conversationId); return null; },
    maintainRetention: async () => undefined
  };
  runtime.owner = { ownerId: 'failure-owner', generation: 1 };
  runtime.globalDataPath = '/tmp/unused-intelligence-failure';
  runtime.prepare = async () => ({ projectPath: '', projectContext: {}, mcp: { client: {}, close: async () => undefined, setPiToolFence() {} } });
  runtime.scheduleRetention = () => undefined;
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const original = EmbeddedPiAgentEngine.prototype.chatNative;
  EmbeddedPiAgentEngine.prototype.chatNative = async () => { throw new Error('injected_model_failure'); };
  t.after(() => { EmbeddedPiAgentEngine.prototype.chatNative = original; });
  const operation = envelope({ operationId: 'failed-operation', requestKey: 'failed-operation',
    options: { agentCli: 'codex', configRevision: 'failure-test', retry: 'native', compaction: 'native', toolExecution: 'sequential' } });

  await assert.rejects(runtime.execute({
    operationId: operation.operationId, conversationId: operation.conversationId, sessionId: 'failure-session', lane: 'main',
    status: 'accepted', ownerGeneration: 1, baselineRevision: 0, cancelRequested: false, acceptance: operation
  }), /injected_model_failure/);

  assert.deepEqual(statuses, ['running', 'failed']);
  assert.deepEqual(promoted, [operation.conversationId]);
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

test('an authenticated same-version replacement build survives Runtime compatibility handoff', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-same-release-handoff-'));
  t.after(() => cleanupExact(root));
  const database = new UnifiedDataStore(root);
  try {
    assert.equal(database.registerPiCompatibilityRelease('0.0.605', 'build-605', 'runtime-605').mode, 'legacy');
    assert.equal(database.recordPiCompatibilityDrain({
      runtimeId: 'runtime-605', releaseVersion: '0.0.605', buildId: 'build-605',
      replacementVersion: '0.0.605', replacementBuildId: 'build-605-hotfix'
    }), true);
    assert.equal(database.registerPiCompatibilityRelease('0.0.605', 'build-605-hotfix', 'runtime-605-hotfix').mode, 'harness');
    assert.equal(database.rows("SELECT COUNT(*) AS count FROM pi_compatible_releases WHERE release_version='0.0.605'")[0].count, 2);
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

test('Pi bootstrap drains every visible-history page before binding a long conversation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-long-bootstrap-'));
  t.after(() => cleanupExact(root));
  const database = new UnifiedDataStore(root);
  try {
    const conversationId = 'a6c91f0d-c9af-45f1-8fab-1d7840f54e54';
    const now = new Date().toISOString();
    const messages = Array.from({ length: 202 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `visible-${index + 1}`
    }));
    database.writeIntelligenceConversation({ conversation: { id: conversationId, title: 'long history', createdAt: now, updatedAt: now, messages }, expectedRevision: 0, idempotencyKey: 'long-bootstrap-history' });
    const owner = database.claimPiExecutionOwner('runtime-long-bootstrap');
    const operation = database.admitPiConversationOperation(envelope({ conversationId, operationId: 'long-bootstrap-operation', requestKey: 'long-bootstrap-operation', baselineRevision: 1 }), owner);
    const storage = database.createPiSessionStorage(operation.sessionId, owner);
    const tip = await storage.getValue({ kind: 'value', namespace: 'pi.branch.tip', key: 'main' }, {});
    const entries = await storage.scanBranch({ start: tip.value, order: 'oldestFirst' }, {});
    assert.equal(entries.length, 202);
    assert.equal(entries[0].message.content, 'visible-1');
    assert.equal(entries[201].message.content[0].text, 'visible-202');
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
      const ingress = database.admitPiConversationIngress({ conversationId,
        operationId: `retention-operation-${index}`, requestKey: `retention-request-${index}`,
        text: `retention prompt ${index}`, source: 'sidebar', sourceGeneration: 1, requireExisting: false }, owner);
      const operation = database.materializePiConversationIngress(ingress.operationId, envelope({ conversationId,
        operationId: ingress.operationId, requestKey: ingress.requestKey, prompt: ingress.text }), owner);
      database.admitPiToolInvocation(operation.operationId, owner, {
        invocationId: `retention-tool-${index}`, toolName: 'solomap_read', arguments: { index }, replay: 'safe'
      });
      const storage = database.createPiSessionStorage(operation.sessionId, owner);
      await storage.commit([{ kind: 'value', op: 'set', namespace: 'retention', key: String(index), value: index }],
        { commitId: `retention-commit-${index}`, operationId: operation.operationId });
      await storage.close();
      database.markPiConversationOperation(operation.operationId, owner, { status: 'failed', tipId: null });
    }
    const before = Number(database.rows('SELECT COUNT(*) AS count FROM pi_tool_invocations')[0].count);
    const retention = database.maintainPiExecutionRetention(conversationId, owner);
    assert.equal(before, 140);
    assert.equal(retention.prunedToolInvocations, 12);
    assert.equal(database.rows('SELECT COUNT(*) AS count FROM pi_tool_invocations')[0].count, 128);
    assert.equal(database.rows('SELECT COUNT(*) AS count FROM pi_conversation_ingress')[0].count, 128);
    assert.equal(database.rows('SELECT COUNT(*) AS count FROM pi_session_commits')[0].count, 128);

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
