const assert = require('node:assert/strict');
const events = require('node:events');
const https = require('node:https');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
const originalRequest = https.request;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.apply(this, arguments);
};

let destroyed = false;
let leaveRequestWithoutSocket = false;
let assignSocketWithoutFinishing = false;
let reuseSocket = false;
https.request = (options, onResponse) => {
  const request = new events.EventEmitter();
  request.reusedSocket = reuseSocket;
  request.write = () => {};
  request.end = () => {
    if (leaveRequestWithoutSocket) return;
    if (assignSocketWithoutFinishing) {
      request.emit('socket', new events.EventEmitter());
      return;
    }
    const response = new events.EventEmitter();
    response.statusCode = 200;
    onResponse(response);
    response.emit('data', Buffer.from('{"ok":'));
  };
  request.destroy = error => {
    destroyed = true;
    request.emit('error', error);
  };
  return request;
};

const { callTelegramApi } = require('../out/telegramRemote.js');

test.after(() => {
  https.request = originalRequest;
  Module._load = originalLoad;
});

test('Telegram polling has a wall clock deadline even when a response starts but never ends', async () => {
  const startedAt = Date.now();
  await assert.rejects(callTelegramApi('test-token', 'getUpdates', { timeout: 30 }, 40), /timed out while receiving response/);
  assert.equal(destroyed, true);
  assert.ok(Date.now() - startedAt < 500);
});

test('Telegram timeout reports when no socket was assigned', async () => {
  leaveRequestWithoutSocket = true;
  await assert.rejects(callTelegramApi('test-token', 'getUpdates', { timeout: 30 }, 40), /timed out while awaiting socket \(unassigned socket\)/);
  leaveRequestWithoutSocket = false;
});

test('Telegram timeout identifies socket reuse without guessing whether TLS or request writing stalled', async () => {
  assignSocketWithoutFinishing = true;
  await assert.rejects(callTelegramApi('test-token', 'getUpdates', { timeout: 30 }, 40), /timed out before request write completed \(new socket\)/);
  reuseSocket = true;
  await assert.rejects(callTelegramApi('test-token', 'getUpdates', { timeout: 30 }, 40), /timed out before request write completed \(reused socket\)/);
});
