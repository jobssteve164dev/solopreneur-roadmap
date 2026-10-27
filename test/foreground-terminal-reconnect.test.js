const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const {
  ForegroundTerminalReconnectClient,
  ForegroundTerminalReconnectServer
} = require('../out/foregroundTerminalReconnect.js');
const { ReconnectedForegroundAgentTerminalBridge } = require('../out/foregroundAgentTerminal.js');

function onceOutput(client) {
  return new Promise(resolve => {
    const dispose = client.onOutput(bytes => {
      dispose();
      resolve(bytes.toString('utf8'));
    });
  });
}

test('the same runner accepts authenticated terminal reconnects without replaying live output twice', async t => {
  const input = [];
  const identity = { runId: 'run-1', generation: 3, deliveryId: 'delivery-1', nonce: 'secret-1' };
  const server = new ForegroundTerminalReconnectServer(identity, bytes => input.push(bytes.toString('utf8')));
  const endpoint = await server.start();
  t.after(async () => server.close());

  server.publish(Buffer.from('before-refresh'), 14);
  const first = new ForegroundTerminalReconnectClient(endpoint, 14);
  await first.connect();
  const firstLive = onceOutput(first);
  server.publish(Buffer.from('first-live'), 24);
  assert.equal(await firstLive, 'first-live');
  await first.writeInput(Buffer.from('first-input\r'));
  first.disconnect();

  server.publish(Buffer.from('while-detached'), 38);
  const second = new ForegroundTerminalReconnectClient(endpoint, 24);
  const replayed = [];
  second.onOutput(bytes => replayed.push(bytes.toString('utf8')));
  await second.connect();
  assert.deepEqual(replayed, ['while-detached']);
  await second.writeInput(Buffer.from('second-input\r'));
  assert.deepEqual(input, ['first-input\r', 'second-input\r']);
  second.disconnect();
});

test('terminal reconnect rejects a mismatched delivery identity before input reaches the runner', async t => {
  const input = [];
  const server = new ForegroundTerminalReconnectServer(
    { runId: 'run-2', generation: 1, deliveryId: 'delivery-2', nonce: 'secret-2' },
    bytes => input.push(bytes)
  );
  const endpoint = await server.start();
  t.after(async () => server.close());
  const invalid = new ForegroundTerminalReconnectClient({ ...endpoint, nonce: 'wrong' }, 0);
  await assert.rejects(invalid.connect(), /terminal_reconnect_unauthorized/);
  assert.deepEqual(input, []);
});

test('terminal reconnect reports a bounded replay gap instead of silently dropping output', async t => {
  const server = new ForegroundTerminalReconnectServer(
    { runId: 'run-3', generation: 1, deliveryId: 'delivery-3', nonce: 'secret-3' },
    () => undefined,
    { maxBufferedBytes: 8 }
  );
  const endpoint = await server.start();
  t.after(async () => server.close());
  server.publish(Buffer.from('12345678'), 8);
  server.publish(Buffer.from('abcdefgh'), 16);
  const client = new ForegroundTerminalReconnectClient(endpoint, 0);
  await assert.rejects(client.connect(), /terminal_reconnect_resync_required:8:16/);
});

test('a replaced authenticated socket makes the old bridge non-live so recovery can retry', async t => {
  const identity = { runId: 'run-disconnect', generation: 1, deliveryId: 'delivery-disconnect', nonce: 'd'.repeat(64) };
  const server = new ForegroundTerminalReconnectServer(identity, async () => undefined);
  const endpoint = await server.start();
  t.after(async () => server.close());
  const bridge = new ReconnectedForegroundAgentTerminalBridge(endpoint, Buffer.alloc(0), 0);
  await bridge.connect();
  assert.equal(bridge.isRunning, true);
  const replacement = new ForegroundTerminalReconnectClient(endpoint, 0);
  await replacement.connect();
  for (let attempt = 0; bridge.isRunning && attempt < 100; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(bridge.isRunning, false);
  replacement.disconnect();
});

test('input acknowledgement waits until the runner has accepted stdin', async t => {
  let acceptInput;
  const accepted = new Promise(resolve => { acceptInput = resolve; });
  const server = new ForegroundTerminalReconnectServer(
    { runId: 'run-ack', generation: 1, deliveryId: 'delivery-ack', nonce: 'e'.repeat(64) },
    async () => accepted
  );
  const endpoint = await server.start();
  t.after(async () => server.close());
  const client = new ForegroundTerminalReconnectClient(endpoint, 0);
  await client.connect();
  let settled = false;
  const write = client.writeInput(Buffer.from('wait-for-stdin')).then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(settled, false, 'ACK must not precede the child stdin write callback');
  acceptInput();
  await write;
  assert.equal(settled, true);
  client.disconnect();
});

test('duplicate input request IDs are accepted by the runner at most once', async t => {
  let accepted = 0;
  const identity = { runId: 'run-dedup', generation: 1, deliveryId: 'delivery-dedup', nonce: 'f'.repeat(64) };
  const server = new ForegroundTerminalReconnectServer(identity, async () => { accepted += 1; });
  const endpoint = await server.start();
  t.after(async () => server.close());
  const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
  const replies = [];
  socket.setEncoding('utf8');
  socket.on('data', value => replies.push(value));
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(`${JSON.stringify({ type: 'attach', ...endpoint, sinceOffset: 0 })}\n`);
  while (!replies.join('').includes('"type":"ready"')) await new Promise(resolve => setTimeout(resolve, 5));
  const frame = `${JSON.stringify({ type: 'input', requestId: 'same-request', bytes: Buffer.from('once').toString('base64') })}\n`;
  socket.write(frame); socket.write(frame);
  while ((replies.join('').match(/input_ack/g) || []).length < 2) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(accepted, 1);
  socket.destroy();
});

test('a restored bridge bounds output while its terminal renderer is unopened', async t => {
  const server = new ForegroundTerminalReconnectServer(
    { runId: 'run-buffer', generation: 1, deliveryId: 'delivery-buffer', nonce: '1'.repeat(64) },
    async () => undefined,
    { maxBufferedBytes: 8 * 1024 * 1024 }
  );
  const endpoint = await server.start();
  t.after(async () => server.close());
  const bridge = new ReconnectedForegroundAgentTerminalBridge(endpoint, Buffer.alloc(0), 0);
  await bridge.connect();
  const chunk = Buffer.alloc(64 * 1024, 120);
  let offset = 0;
  for (let index = 0; index < 80; index += 1) { offset += chunk.length; server.publish(chunk, offset); }
  await server.close();
  const rendered = [];
  bridge.attachOutput(bytes => rendered.push(bytes));
  assert.ok(Buffer.concat(rendered).length <= 4 * 1024 * 1024, 'the unopened restored terminal buffer must stay bounded');
  bridge.detachForHostReload();
});

test('an unauthenticated peer cannot retain an unbounded protocol frame', async t => {
  const server = new ForegroundTerminalReconnectServer(
    { runId: 'run-frame-limit', generation: 1, deliveryId: 'delivery-frame-limit', nonce: '2'.repeat(64) },
    async () => undefined
  );
  const endpoint = await server.start();
  t.after(async () => server.close());
  const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
  await new Promise(resolve => socket.once('connect', resolve));
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.write(Buffer.alloc(1024 * 1024 + 1, 120));
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('oversized unauthenticated frame remained open')), 1000))]);
});

test('rejecting excess unauthenticated sockets never emits an unhandled server error', async t => {
  const server = new ForegroundTerminalReconnectServer(
    { runId: 'run-connection-limit', generation: 1, deliveryId: 'delivery-connection-limit', nonce: '3'.repeat(64) },
    async () => undefined
  );
  const endpoint = await server.start();
  t.after(async () => server.close());
  const sockets = [];
  t.after(() => sockets.forEach(socket => socket.destroy()));
  for (let index = 0; index < 9; index += 1) {
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    socket.on('error', () => undefined);
    sockets.push(socket);
    await new Promise(resolve => socket.once('connect', resolve));
  }
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(sockets.filter(socket => !socket.destroyed).length, 8);
});
