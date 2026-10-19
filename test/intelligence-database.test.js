const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');
const { IntelligenceConversationStore } = require('../out/intelligenceChat.js');

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

function messagePrefixHash(messages, count = messages.length) {
  return crypto.createHash('sha256').update(JSON.stringify(messages.slice(0, count))).digest('hex');
}

test('production conversation client submits one action to the Runtime owner', async () => {
  const id = '105f896d-ca66-4574-a166-74f32f69c876';
  const requests = [];
  const expected = { id, title: 'Owned by Runtime', createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }] };
  const store = new IntelligenceConversationStore('/unused', undefined, async (_root, request) => {
    requests.push(request);
    return expected;
  });
  assert.deepEqual(await store.send('hello', id), expected);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].operation, 'send_intelligence_message');
  assert.equal(requests[0].input.conversationId, id);
  assert.equal(requests[0].input.text, 'hello');
});

test('chat fails closed when the database owner is unavailable and never recreates legacy JSON', async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-chat-no-authority-'));
  t.after(() => cleanupExact(fixture));
  const root = path.join(fixture, '.solomap-global');
  const store = new IntelligenceConversationStore(root, async () => 'must not be persisted outside the database');
  await assert.rejects(store.send('Question without a database owner'));
  assert.equal(fs.existsSync(path.join(root, 'intelligence-conversations')), false);
});

test('sidebar and background chat share immediate durable history without producing conversation JSON files', async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-chat-database-'));
  t.after(() => cleanupExact(fixture));
  const root = path.join(fixture, '.solomap-global');
  const database = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(database);
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'conversation-owner', onCommand: () => ({ status: 'paused' }), onData: operations });
  try {
    const sidebar = new IntelligenceConversationStore(root, async () => 'First answer');
    const first = await sidebar.send('First question');
    assert.equal(fs.existsSync(path.join(root, 'intelligence-conversations')), false, 'new chat state belongs only to the shared database');
    const background = new IntelligenceConversationStore(root, async messages => {
      assert.deepEqual(messages.map(message => message.content), ['First question', 'First answer', 'Follow up']);
      return 'Second answer';
    });
    const second = await background.send('Follow up', first.id);
    assert.equal(second.id, first.id);
    assert.deepEqual((await sidebar.get(first.id)).messages, second.messages);
    assert.equal((await background.list())[0].id, first.id);
    assert.equal(database.search({ scope: null, kinds: ['conversation'] }).items.length, 1);
    assert.equal(database.search({ scope: null, kinds: ['message'] }).items.length, 4);
  } finally { await server.close(); await operations.close(); database.close(); }
});

test('Pi Harness checkpoint commits with the conversation and is reused after reopening', async t => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-chat-harness-checkpoint-'));
  t.after(() => cleanupExact(fixture));
  const root = path.join(fixture, '.solomap-global');
  const database = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(database);
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'conversation-owner', onCommand: () => ({ status: 'paused' }), onData: operations });
  const id = '5c43b45a-253f-4b38-b81d-9fdd00f61c18';
  const messages = [];
  for (let index = 0; index < 90; index += 1) {
    messages.push({ role: 'user', content: `old-question-${index}-${'u'.repeat(6_000)}` });
    messages.push({ role: 'assistant', content: `old-answer-${index}-${'a'.repeat(6_000)}` });
  }
  const createdAt = '2026-10-18T00:00:00.000Z';
  database.writeIntelligenceConversation({
    conversation: { id, title: 'Harness history', createdAt, updatedAt: createdAt, messages },
    expectedRevision: 0,
    idempotencyKey: 'seed-harness-history'
  });
  try {
    const firstPrompts = [];
    const firstEngine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async invocation => {
      firstPrompts.push(invocation.stdin);
      return invocation.stdin.includes('You are a context summarization assistant') ? 'PERSISTED-HARNESS-CHECKPOINT' : 'first answer';
    } });
    const firstStore = new IntelligenceConversationStore(root,
      (history, context) => firstEngine.chat(history, { selectedProject: '', projects: [] }, undefined, context));
    await firstStore.send('first current question', id);
    assert.equal(firstPrompts.length, 2);
    const committed = database.readIntelligenceConversation(id);
    assert.equal(committed.contextCheckpoint.engine, 'pi-harness');
    assert.equal(committed.contextCheckpoint.sourceMessageCount, 181);
    assert.equal(committed.contextCheckpoint.summary, 'PERSISTED-HARNESS-CHECKPOINT');

    const reopenedPrompts = [];
    const reopenedEngine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async invocation => {
      reopenedPrompts.push(invocation.stdin);
      if (invocation.stdin.includes('You are a context summarization assistant')) throw new Error('unchanged history was summarized twice');
      return 'second answer';
    } });
    const reopenedStore = new IntelligenceConversationStore(root,
      (history, context) => reopenedEngine.chat(history, { selectedProject: '', projects: [] }, undefined, context));
    await reopenedStore.send('second current question', id);
    assert.equal(reopenedPrompts.length, 1);
    assert.match(reopenedPrompts[0], /PERSISTED-HARNESS-CHECKPOINT/);
    assert.doesNotMatch(reopenedPrompts[0], /old-question-0-/);
    assert.match(reopenedPrompts[0], /first answer/);
    assert.match(reopenedPrompts[0], /second current question/);
  } finally { await server.close(); await operations.close(); database.close(); }
});

test('ordinary conversation reads ignore legacy JSON added after startup migration', async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-chat-no-live-json-'));
  t.after(() => cleanupExact(fixture));
  const root = path.join(fixture, '.solomap-global');
  const database = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(database);
  const id = '6b272a87-a937-4e9a-aa09-13ef93c6b92c';
  const directory = path.join(root, 'intelligence-conversations');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, id + '.json'), JSON.stringify({ id, title: 'Late legacy file', createdAt: '2026-09-22T08:00:00.000Z', updatedAt: '2026-09-22T08:01:00.000Z', messages: [] }));
  try {
    assert.equal(await operations({ operation: 'read_intelligence_conversation', input: { id } }), null);
    assert.deepEqual(await operations({ operation: 'list_intelligence_conversations', input: {} }), []);
    assert.equal(database.readIntelligenceConversation(id), null);
  } finally { await operations.close(); database.close(); }
});

test('a conversation transaction rolls back all message writes on conflict and unchanged retries add no history', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-chat-atomic-'));
  t.after(() => cleanupExact(fixture));
  const root = path.join(fixture, '.solomap-global');
  const database = new UnifiedDataStore(root);
  const conversation = { id: 'bb405aab-ff4c-41d5-b9f8-8d9fa025af81', title: 'Atomic chat', createdAt: '2026-09-22T08:00:00.000Z', updatedAt: '2026-09-22T08:00:00.000Z', messages: [] };
  try {
    const input = { conversation, expectedRevision: 0, idempotencyKey: 'initial' };
    const first = database.writeIntelligenceConversation(input);
    assert.deepEqual(database.writeIntelligenceConversation(input), first);
    database.write({ kind: 'message', action: 'create', scope: null, idempotencyKey: 'conflict:message:1', data: { conversation_id: conversation.id, sequence: 0, role: 'assistant', content: 'Existing authority' } });
    // The existing message is part of history, so append after it and deliberately collide
    // with a previously committed request key to fail the second nested message operation.
    const current = database.readIntelligenceConversation(conversation.id);
    database.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'append:message:2', data: { category: 'inbox', title: 'Conflicting request', status: 'captured', content: 'Different committed input' } });
    const before = database.search({ scope: null, kinds: ['message'] }).items.length;
    assert.throws(() => database.writeIntelligenceConversation({ conversation: { ...current.conversation, messages: [...current.conversation.messages, { role: 'user', content: 'New question' }, { role: 'assistant', content: 'New answer' }] }, expectedRevision: current.revision, idempotencyKey: 'append' }), /idempotency_conflict/);
    assert.equal(database.search({ scope: null, kinds: ['message'] }).items.length, before);
    assert.equal(database.readIntelligenceConversation(conversation.id).revision, current.revision);
  } finally { database.close(); }
});

test('an invalid Pi Harness checkpoint rolls back the complete conversation append', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-chat-checkpoint-atomic-'));
  t.after(() => cleanupExact(fixture));
  const root = path.join(fixture, '.solomap-global');
  const database = new UnifiedDataStore(root);
  const id = '5ec28f13-7d8b-47d4-943b-42cbdbeed692';
  const createdAt = '2026-10-18T00:00:00.000Z';
  try {
    database.writeIntelligenceConversation({
      conversation: { id, title: 'Atomic checkpoint', createdAt, updatedAt: createdAt, messages: [] },
      expectedRevision: 0,
      idempotencyKey: 'checkpoint-atomic-seed'
    });
    const current = database.readIntelligenceConversation(id);
    assert.throws(() => database.writeIntelligenceConversation({
      conversation: {
        ...current.conversation,
        updatedAt: '2026-10-18T00:01:00.000Z',
        messages: [{ role: 'user', content: 'must roll back' }, { role: 'assistant', content: 'must also roll back' }]
      },
      expectedRevision: current.revision,
      idempotencyKey: 'checkpoint-atomic-invalid',
      contextCheckpoint: {
        schemaVersion: 1,
        engine: 'pi-harness',
        sourceMessageCount: 1,
        sourceHash: '0'.repeat(64),
        retainedMessageCount: 1,
        tokensBefore: 200_000,
        summary: 'invalid source hash',
        createdAt: Date.now()
      }
    }), /intelligence_context_checkpoint_invalid/);
    const after = database.readIntelligenceConversation(id);
    assert.equal(after.revision, current.revision);
    assert.deepEqual(after.conversation.messages, []);
    assert.equal(after.contextCheckpoint, undefined);
  } finally { database.close(); }
});

test('Pi Harness checkpoint replacement stays single-current and queues the retired body for cleanup', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-chat-checkpoint-retention-'));
  t.after(() => cleanupExact(fixture));
  const root = path.join(fixture, '.solomap-global');
  const database = new UnifiedDataStore(root);
  const id = '3f1e1c08-1916-43cf-b68f-98d2a216c9b9';
  const createdAt = '2026-10-18T00:00:00.000Z';
  const firstMessages = [{ role: 'user', content: 'first question' }, { role: 'assistant', content: 'first answer' }];
  try {
    database.writeIntelligenceConversation({
      conversation: { id, title: 'Checkpoint retention', createdAt, updatedAt: createdAt, messages: firstMessages },
      expectedRevision: 0,
      idempotencyKey: 'checkpoint-retention-first',
      contextCheckpoint: {
        schemaVersion: 1, engine: 'pi-harness', sourceMessageCount: 1,
        sourceHash: messagePrefixHash(firstMessages, 1), retainedMessageCount: 1,
        tokensBefore: 200_000, summary: 'first checkpoint', createdAt: Date.now()
      }
    });
    const current = database.readIntelligenceConversation(id);
    const secondMessages = [...firstMessages, { role: 'user', content: 'second question' }, { role: 'assistant', content: 'second answer' }];
    database.writeIntelligenceConversation({
      conversation: { ...current.conversation, updatedAt: '2026-10-18T00:01:00.000Z', messages: secondMessages },
      expectedRevision: current.revision,
      idempotencyKey: 'checkpoint-retention-second',
      contextCheckpoint: {
        schemaVersion: 1, engine: 'pi-harness', sourceMessageCount: 3,
        sourceHash: messagePrefixHash(secondMessages, 3), retainedMessageCount: 1,
        tokensBefore: 210_000, summary: 'second checkpoint', createdAt: Date.now() + 1
      }
    });
    assert.equal(database.readIntelligenceConversation(id).contextCheckpoint.summary, 'second checkpoint');
    assert.equal(database.hasDatabaseStorageCleanupCandidates(), true);
    database.prepareDatabaseStorageCleanup();
    const cleanup = database.finalizeDatabaseStorageCleanupBatch();
    assert.equal(cleanup.deletedContents, 1);
    assert.equal(cleanup.pending, false);
    assert.equal(database.readIntelligenceConversation(id).contextCheckpoint.summary, 'second checkpoint');
  } finally { database.close(); }
});

test('Runtime reclaims retired Pi Harness checkpoint bodies without requiring a restart', async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-chat-checkpoint-runtime-cleanup-'));
  t.after(() => cleanupExact(fixture));
  const root = path.join(fixture, '.solomap-global');
  const database = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(database);
  const id = 'cf151efe-78de-4116-a819-40b91299f76f';
  const createdAt = '2026-10-18T00:00:00.000Z';
  const firstMessages = [{ role: 'user', content: 'first question' }, { role: 'assistant', content: 'first answer' }];
  try {
    const first = await operations({
      operation: 'write_intelligence_conversation',
      input: {
        conversation: { id, title: 'Runtime cleanup', createdAt, updatedAt: createdAt, messages: firstMessages },
        expectedRevision: 0,
        idempotencyKey: 'runtime-cleanup-first',
        contextCheckpoint: {
          schemaVersion: 1, engine: 'pi-harness', sourceMessageCount: 1,
          sourceHash: messagePrefixHash(firstMessages, 1), retainedMessageCount: 1,
          tokensBefore: 200_000, summary: 'first runtime checkpoint', createdAt: Date.now()
        }
      }
    });
    const secondMessages = [...firstMessages, { role: 'user', content: 'second question' }, { role: 'assistant', content: 'second answer' }];
    await operations({
      operation: 'write_intelligence_conversation',
      input: {
        conversation: { id, title: 'Runtime cleanup', createdAt, updatedAt: '2026-10-18T00:01:00.000Z', messages: secondMessages },
        expectedRevision: first.revision,
        idempotencyKey: 'runtime-cleanup-second',
        contextCheckpoint: {
          schemaVersion: 1, engine: 'pi-harness', sourceMessageCount: 3,
          sourceHash: messagePrefixHash(secondMessages, 3), retainedMessageCount: 1,
          tokensBefore: 210_000, summary: 'second runtime checkpoint', createdAt: Date.now() + 1
        }
      }
    });

    await operations.close();
    assert.equal(database.hasDatabaseStorageCleanupCandidates(), false);
    assert.equal(database.readIntelligenceConversation(id).contextCheckpoint.summary, 'second runtime checkpoint');
  } finally { database.close(); }
});

test('a revoked Telegram generation cannot commit a conversation turn or Pi Harness checkpoint', async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-chat-telegram-generation-'));
  t.after(() => cleanupExact(fixture));
  const root = path.join(fixture, '.solomap-global');
  const database = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(database);
  const id = 'fe36fb5a-c241-4934-979e-b1f08601738d';
  const createdAt = '2026-10-18T00:00:00.000Z';
  try {
    database.patchHostSettings({
      namespace: 'telegram', ownerScope: 'global', idempotencyKey: 'telegram-generation-1',
      patches: [{ key: 'replyGeneration', expectedRevision: 0, value: 1 }]
    });
    const seeded = database.writeIntelligenceConversation({
      conversation: { id, title: 'Revoked Telegram', createdAt, updatedAt: createdAt, messages: [] },
      expectedRevision: 0,
      idempotencyKey: 'telegram-generation-seed'
    });
    const setting = database.readHostSettings({ namespace: 'telegram', ownerScope: 'global' }).items.find(item => item.key === 'replyGeneration');
    database.patchHostSettings({
      namespace: 'telegram', ownerScope: 'global', idempotencyKey: 'telegram-generation-2',
      patches: [{ key: 'replyGeneration', expectedRevision: setting.revision, value: 2 }]
    });
    const messages = [{ role: 'user', content: 'stale question' }, { role: 'assistant', content: 'stale answer' }];

    await assert.rejects(() => operations({
      operation: 'write_intelligence_conversation',
      input: {
        conversation: { id, title: 'Revoked Telegram', createdAt, updatedAt: '2026-10-18T00:01:00.000Z', messages },
        expectedRevision: seeded.revision,
        idempotencyKey: 'telegram-generation-stale-write',
        commitGuard: { type: 'telegram-reply-generation', generation: 1 },
        contextCheckpoint: {
          schemaVersion: 1, engine: 'pi-harness', sourceMessageCount: 1,
          sourceHash: messagePrefixHash(messages, 1), retainedMessageCount: 1,
          tokensBefore: 200_000, summary: 'must not commit', createdAt: Date.now()
        }
      }
    }), /intelligence_reply_revoked/);
    const current = database.readIntelligenceConversation(id);
    assert.equal(current.revision, seeded.revision);
    assert.deepEqual(current.conversation.messages, []);
    assert.equal(current.contextCheckpoint, undefined);
  } finally { await operations.close(); database.close(); }
});

test('legacy conversation resumes with its original identity and full messages while its source remains untouched', async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-chat-legacy-'));
  t.after(() => cleanupExact(fixture));
  const root = path.join(fixture, '.solomap-global');
  const id = '8ea610cf-9db2-4c07-a7c0-5eb012d1fb45';
  const directory = path.join(root, 'intelligence-conversations');
  fs.mkdirSync(directory, { recursive: true });
  const original = JSON.stringify({ id, title: 'Existing title', createdAt: '2026-09-22T08:00:00.000Z', updatedAt: '2026-09-22T08:01:00.000Z', messages: [{ role: 'user', content: 'Complete old question' }, { role: 'assistant', content: 'Complete old answer' }] });
  const source = path.join(directory, id + '.json');
  fs.writeFileSync(source, original);
  const database = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(database);
  await operations({ operation: 'import_intelligence', input: { sourceRoot: directory, idempotencyKey: `test-import:${id}` } });
  await operations.waitForMigrations();
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'legacy-chat-owner', onCommand: () => ({ status: 'running' }), onData: operations });
  try {
    const store = new IntelligenceConversationStore(root, async messages => {
      assert.equal(messages[1].content, 'Complete old answer');
      return 'New answer';
    });
    const resumed = await store.send('Continue', id);
    assert.equal(resumed.id, id);
    assert.equal(resumed.title, 'Existing title');
    assert.equal(resumed.createdAt, '2026-09-22T08:00:00.000Z');
    assert.equal(resumed.messages.length, 4);
    assert.equal(fs.readFileSync(source, 'utf8'), original);
    assert.equal(database.search({ scope: null, kinds: ['message'] }).items.length, 4);
  } finally { await server.close(); await operations.close(); database.close(); }
});
