const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');

async function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-notification-outbox-'));
  const root = path.join(base, '.solomap-global');
  let store = new UnifiedDataStore(root), ops = createRuntimeDataOperations(store);
  return { root, call: (operation, input) => ops({ operation, input }),
    async restart() { await ops.close(); store.close(); store = UnifiedDataStore.open(root); ops = createRuntimeDataOperations(store); },
    async close() {
      await ops.close(); store.close();
      const unlink = file => { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
      unlink(path.join(root, 'solomap.db-wal')); unlink(path.join(root, 'solomap.db-shm')); unlink(path.join(root, 'solomap.db'));
      fs.rmdirSync(root); fs.rmdirSync(base);
    }
  };
}
const payload = { replyGeneration: 4, chatId: '123', text: '完整通知🌿'.repeat(8000), parseMode: 'HTML' };

test('a notification effect creates one durable delivery, retains full original content, and does not replay after restart', async () => {
  const f = await fixture();
  try {
    const request = { channel: 'telegram', intentId: 'run-effect:stable-notification', payload, idempotencyKey: 'notification:first' };
    const results = await Promise.all([f.call('enqueue_notification', request), f.call('enqueue_notification', request)]);
    assert.equal(results[0].id, results[1].id);
    const list = await f.call('list_notification_deliveries', { channel: 'telegram' });
    assert.equal(list.items.length, 1); assert.deepEqual(list.items[0].payload, payload);
    const original = await f.call('read', { ref: list.items[0].objectId, view: 'full' });
    assert.deepEqual(JSON.parse(original.data.content), { channel: 'telegram', intentId: request.intentId, payload });
    const receipt = await f.call('settle_notification_delivery', { id: list.items[0].id, expectedRevision: list.items[0].revision, state: 'delivered', response: { message_id: 7 }, idempotencyKey: 'notification:sent' });
    await f.restart();
    assert.equal((await f.call('list_notification_deliveries', { channel: 'telegram' })).items.length, 0);
    const replay = await f.call('enqueue_notification', request); assert.equal(replay.id, results[0].id); assert.equal(replay.state, 'delivered');
    assert.equal((await f.call('settle_notification_delivery', { id: replay.id, expectedRevision: list.items[0].revision, state: 'delivered', response: { message_id: 7 }, idempotencyKey: 'notification:sent' })).receipt.requestId, receipt.receipt.requestId);
    assert.deepEqual(fs.readdirSync(f.root).filter(name => !name.startsWith('solomap.db')), []);
  } finally { await f.close(); }
});

test('a changed notification intent is rejected and HTML retry never rewrites the original evidence', async () => {
  const f = await fixture();
  try {
    const first = await f.call('enqueue_notification', { channel: 'telegram', intentId: 'same-notification', payload, idempotencyKey: 'notification:original' });
    await assert.rejects(f.call('enqueue_notification', { channel: 'telegram', intentId: 'same-notification', payload: { ...payload, text: '另一个内容' }, idempotencyKey: 'notification:changed' }), /notification_identity_conflict/);
    const plain = { ...payload }; delete plain.parseMode; plain.text = '保留正文的纯文本';
    const attempt = await f.call('begin_notification_delivery', { id: first.id, expectedRevision: first.revision, idempotencyKey: 'notification:plaintext:begin' });
    const retry = await f.call('settle_notification_delivery', { id: first.id, expectedRevision: first.revision, state: 'queued', payload: plain, error: 'HTTP 400: formatting', attemptToken: attempt.token, idempotencyKey: 'notification:plaintext' });
    assert.equal(retry.revision, first.revision + 1);
    await assert.rejects(f.call('settle_notification_delivery', { id: first.id, expectedRevision: first.revision, state: 'delivered', idempotencyKey: 'notification:stale' }), /revision_conflict/);
    await f.restart();
    assert.deepEqual((await f.call('list_notification_deliveries', { channel: 'telegram' })).items[0].payload, plain);
    const evidence = await f.call('read', { ref: first.objectId, revision: 1, view: 'full' });
    assert.deepEqual(JSON.parse(evidence.data.content).payload, payload);
    const cancelled = await f.call('settle_notification_delivery', { id: first.id, expectedRevision: retry.revision, state: 'cancelled', idempotencyKey: 'notification:revoked' });
    assert.equal(cancelled.state, 'cancelled');
    await assert.rejects(f.call('settle_notification_delivery', { id: first.id, expectedRevision: cancelled.revision, state: 'queued', idempotencyKey: 'notification:revive' }), /notification_already_settled/);
  } finally { await f.close(); }
});

test('a send attempt with no confirmation remains unknown after restart and is never offered for replay', async () => {
  const f = await fixture();
  try {
    const delivery = await f.call('enqueue_notification', { channel: 'telegram', intentId: 'confirmation-window', payload, idempotencyKey: 'notification:confirmation-window' });
    const attempt = await f.call('begin_notification_delivery', { id: delivery.id, expectedRevision: delivery.revision, idempotencyKey: 'notification:confirmation-window:begin' });
    assert.match(attempt.token, /^[a-f0-9]{48}$/);
    await f.restart();
    assert.equal((await f.call('list_notification_deliveries', { channel: 'telegram' })).items.length, 0);
    const current = await f.call('read_notification', { intentId: 'confirmation-window' });
    assert.equal(current.state, 'delivery_unknown');
    await assert.rejects(f.call('begin_notification_delivery', { id: delivery.id, expectedRevision: delivery.revision, idempotencyKey: 'notification:confirmation-window:second-begin' }), /notification_delivery_unknown/);
    await assert.rejects(f.call('settle_notification_delivery', { id: delivery.id, expectedRevision: delivery.revision, state: 'delivered', attemptToken: 'wrong', idempotencyKey: 'notification:confirmation-window:wrong-confirmation' }), /notification_attempt_mismatch/);
  } finally { await f.close(); }
});

test('the task notification producer reuses the accepted effect even after binding changes without writing an outbox file', async () => {
  const f = await fixture();
  const transport = require('../out/autonomousRuntimeControl.js'); const previous = transport.sendRuntimeDataRequest;
  transport.sendRuntimeDataRequest = (_root, request) => f.call(request.operation, request.input);
  const { persistTelegramRuntimeConfig, queueTelegramBackgroundNotification } = require('../out/telegramRuntimeConfig.js');
  const operation = request => f.call(request.operation, request.input);
  try {
    await persistTelegramRuntimeConfig(f.root, { enabled: true, botToken: 'fixture-token', chatId: '123' }, operation);
    const first = await queueTelegramBackgroundNotification(f.root, payload.text, 'HTML', 'run-effect:queue-producer', operation);
    assert.ok(first?.id, 'the producer must commit a formal delivery before returning');
    await persistTelegramRuntimeConfig(f.root, { enabled: false, chatId: '456' }, operation);
    const replay = await queueTelegramBackgroundNotification(f.root, payload.text, 'HTML', 'run-effect:queue-producer', operation);
    assert.equal(replay.id, first.id);
    assert.equal(fs.existsSync(path.join(f.root, 'runtime')), false);
    assert.equal((await f.call('list_notification_deliveries', { channel: 'telegram' })).items.length, 1);
  } finally { transport.sendRuntimeDataRequest = previous; await f.close(); }
});

test('the notification producer rejects changed content under an accepted effect and accepts the original after a plain-text retry', async () => {
  const f = await fixture();
  const transport = require('../out/autonomousRuntimeControl.js'); const previous = transport.sendRuntimeDataRequest;
  transport.sendRuntimeDataRequest = (_root, request) => f.call(request.operation, request.input);
  const { persistTelegramRuntimeConfig, queueTelegramBackgroundNotification } = require('../out/telegramRuntimeConfig.js');
  const operation = request => f.call(request.operation, request.input);
  try {
    await persistTelegramRuntimeConfig(f.root, { enabled: true, botToken: 'fixture-token', chatId: '123' }, operation);
    const first = await queueTelegramBackgroundNotification(f.root, '<b>正式原文🌿</b>', 'HTML', 'effect-original-content', operation);
    await assert.rejects(queueTelegramBackgroundNotification(f.root, '篡改后的正文', 'HTML', 'effect-original-content', operation), /notification_identity_conflict/);
    const plain = { ...first.payload, text: '正式原文🌿' }; delete plain.parseMode;
    await f.call('settle_notification_delivery', { id: first.id, expectedRevision: first.revision, state: 'queued', payload: plain, idempotencyKey: 'effect-original-plaintext' });
    const replay = await queueTelegramBackgroundNotification(f.root, '<b>正式原文🌿</b>', 'HTML', 'effect-original-content', operation);
    assert.equal(replay.id, first.id); assert.deepEqual(replay.payload, plain);
  } finally { transport.sendRuntimeDataRequest = previous; await f.close(); }
});
