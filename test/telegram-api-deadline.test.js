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
https.request = (options, onResponse) => {
  const request = new events.EventEmitter();
  request.write = () => {};
  request.end = () => {
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
  await assert.rejects(callTelegramApi('test-token', 'getUpdates', { timeout: 30 }, 40), /timed out/);
  assert.equal(destroyed, true);
  assert.ok(Date.now() - startedAt < 500);
});
