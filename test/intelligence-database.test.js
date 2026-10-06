const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');
const { IntelligenceConversationStore } = require('../out/intelligenceChat.js');

test('sidebar and background chat share immediate durable history without producing conversation JSON files', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-chat-database-'));
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

test('a conversation transaction rolls back all message writes on conflict and unchanged retries add no history', () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-chat-atomic-')), '.solomap-global');
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

test('legacy conversation resumes with its original identity and full messages while its source remains untouched', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-chat-legacy-'));
  const root = path.join(fixture, '.solomap-global');
  const id = '8ea610cf-9db2-4c07-a7c0-5eb012d1fb45';
  const directory = path.join(root, 'intelligence-conversations');
  fs.mkdirSync(directory, { recursive: true });
  const original = JSON.stringify({ id, title: 'Existing title', createdAt: '2026-09-22T08:00:00.000Z', updatedAt: '2026-09-22T08:01:00.000Z', messages: [{ role: 'user', content: 'Complete old question' }, { role: 'assistant', content: 'Complete old answer' }] });
  const source = path.join(directory, id + '.json');
  fs.writeFileSync(source, original);
  const database = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(database);
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
