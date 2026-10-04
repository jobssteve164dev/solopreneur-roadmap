const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const control = require('../out/autonomousRuntimeControl.js');

async function waitFor(check, message, timeout = 7000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

async function backgroundFixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-tg-background-'));
  const globalRoot = path.join(root, '.solomap-global');
  const runtimeRoot = path.join(globalRoot, 'runtime');
  const projectRoot = path.join(root, 'alpha');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.solopreneur', 'roadmap.csv'), 'id,title,stage,status,dependencies\n1,Ship Alpha,Build,Pending,\n');
  fs.writeFileSync(path.join(globalRoot, 'projects.json'), JSON.stringify({ schemaVersion: 1, projects: [{ name: 'Alpha', path: projectRoot }], hiddenProjects: [] }));
  const cli = path.join(root, 'codex');
  fs.writeFileSync(cli, '#!/usr/bin/env node\nlet input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>console.log(input.includes(\'"name":"Alpha"\') ? "Alpha 的下一步是 Ship Alpha。" : "{\\"toolCall\\":{\\"name\\":\\"get_current_project\\"}}"));\n', { mode: 0o700 });
  fs.writeFileSync(path.join(runtimeRoot, 'cognitive-config.json'), JSON.stringify({ schemaVersion: 1, revision: 'fixture', mode: 'agent_cli', agentCli: cli, model: 'auto' }));
  const configPath = path.join(runtimeRoot, 'telegram-config.json');
  const config = { schemaVersion: 1, enabled: true, botToken: 'fixture-token', chatId: '123456', selectedProjectPath: projectRoot, language: 'zh', bindingGeneration: 0, conversationIds: {}, ...overrides };
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const updates = [];
  const sent = [];
  const polls = [];
  const deliveryAttempts = [];
  let deliveryFailures = 0;
  const rejectedTexts = new Set();
  let child;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const payload = JSON.parse(body);
      const method = req.url.split('/').at(-1);
      let result = true;
      if (method === 'getUpdates') {
        polls.push(payload);
        result = updates.filter(u => u.update_id >= (payload.offset || 0));
      } else if (method === 'sendMessage') {
        deliveryAttempts.push(payload);
        if (rejectedTexts.has(payload.text)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: invalid message content' }));
          return;
        }
        if (deliveryFailures > 0) {
          deliveryFailures--;
          res.statusCode = 502;
          res.end(JSON.stringify({ ok: false, error_code: 502, description: 'Bad Gateway' }));
          return;
        }
        sent.push(payload);
        result = { message_id: sent.length, date: Math.floor(Date.now() / 1000), chat: { id: Number(payload.chat_id), type: 'private' }, text: payload.text };
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const preload = path.join(root, 'telegram-boundary.cjs');
  fs.writeFileSync(preload, `const https=require('https'),http=require('http'),Module=require('module');
const load=Module._load;Module._load=function(name,...rest){if(name==='vscode')throw Error('Editor API must not be loaded by background chat');return load.call(this,name,...rest)};
const request=https.request;https.request=function(options,callback){if(options.hostname==='api.telegram.org')return http.request({...options,hostname:'127.0.0.1',port:${server.address().port},agent:undefined},callback);throw Error('Unexpected external request in TG acceptance test')};\n`);
  async function start() {
    child = cp.spawn(process.execPath, ['--require', preload, path.resolve(__dirname, '../out/autonomousRuntimeProcess.js'), '--global-data-path', globalRoot, '--interval-ms', '5000'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    await waitFor(() => fs.existsSync(path.join(runtimeRoot, 'control.json')), 'Daemon must start its authenticated endpoint');
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    await control.sendRuntimeControlCommand(globalRoot, 'stop');
    await exited;
  }
  t.after(async () => {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    await new Promise(resolve => server.close(resolve));
    // This isolated fixture is retained as acceptance evidence, outside production data.
  });
  const update = (id, text) => ({ update_id: id, message: { message_id: id, from: { id: 123456, is_bot: false, first_name: 'Fixture' }, chat: { id: 123456, type: 'private' }, date: Math.floor(Date.now() / 1000), text } });
  return { root, globalRoot, runtimeRoot, projectRoot, cli, configPath, config, updates, sent, polls, deliveryAttempts,
    rejectText(text) { rejectedTexts.add(text); }, failDeliveries(count) { deliveryFailures = count; }, start, stop, update };
}

// Break caught: the real daemon never receives TG messages without a VS Code host.
test('standalone runtime receives, queries projects and replies without an editor, including after restart', async t => {
  const { globalRoot, runtimeRoot, configPath, updates, sent, polls, start, stop, update } = await backgroundFixture(t);
  await start();
  updates.push(update(100, '当前项目下一步是什么？'));
  await waitFor(() => sent.some(m => m.text === 'Alpha 的下一步是 Ship Alpha。'), 'Background TG must deliver an answer with no editor process');
  assert.ok(polls.length > 0);
  const conversations = fs.readdirSync(path.join(globalRoot, 'intelligence-conversations'));
  assert.equal(conversations.length, 1);
  await control.sendRuntimeControlCommand(globalRoot, 'pause');
  updates.push(update(101, '/status'));
  await waitFor(() => sent.some(m => m.text.includes('Alpha') && m.text.includes('路线图')), 'Pausing autonomous decisions must leave TG available');
  await stop();
  const beforeRestart = sent.length;
  await start();
  updates.push(update(102, '继续刚才的问题'));
  await waitFor(() => sent.length > beforeRestart && sent.at(-1).text === 'Alpha 的下一步是 Ship Alpha。', 'Restart must resume TG conversation');
  assert.equal(fs.readdirSync(path.join(globalRoot, 'intelligence-conversations')).length, 1);
  const conversation = JSON.parse(fs.readFileSync(path.join(globalRoot, 'intelligence-conversations', conversations[0])));
  assert.equal(conversation.messages.length, 4, 'Acknowledged messages must not be replayed after restart');
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  await stop();
});

// Break caught: a transient send failure loses the completed answer or notifications still depend on the editor.
test('background delivery retries the completed answer and sends queued notifications without an editor', async t => {
  const fixture = await backgroundFixture(t);
  const { queueTelegramBackgroundNotification } = require('../out/telegramRuntimeConfig.js');
  fixture.failDeliveries(1);
  await fixture.start();
  fixture.updates.push(fixture.update(300, '当前项目下一步是什么？'));
  await waitFor(() => fixture.sent.some(m => m.text === 'Alpha 的下一步是 Ship Alpha。'), 'A temporary transport failure must not discard the answer');
  assert.equal(fixture.deliveryAttempts.filter(m => m.text === 'Alpha 的下一步是 Ship Alpha。').length, 2);
  assert.equal(fixture.sent.filter(m => m.text === 'Alpha 的下一步是 Ship Alpha。').length, 1);
  queueTelegramBackgroundNotification(fixture.globalRoot, '任务完成');
  await waitFor(() => fixture.sent.some(m => m.text === '任务完成'), 'Queued task notifications must be sent by the daemon');
  await waitFor(() => fs.readdirSync(path.join(fixture.runtimeRoot, 'telegram-outbox')).length === 0, 'Successfully sent deliveries must be acknowledged');
  await fixture.stop();
});

// Break caught: reconnecting or closing the editor accidentally starts/stops TG polling.
test('editor binding, reconnect and disconnect preserve one background channel and reject revoked accounts', async t => {
  const fixture = await backgroundFixture(t, { chatId: '' });
  const { createTelegramBackgroundConnection } = require('../out/telegramBackgroundConnection.js');
  const { readTelegramRuntimeConfig, writeTelegramRuntimeConfig } = require('../out/telegramRuntimeConfig.js');
  let settings = { telegramEnabled: true, telegramBotToken: 'fixture-token', telegramChatId: '' };
  const commands = [];
  let connection;
  const options = {
    host: {
      getSettings: () => settings,
      async authorizeChat(_username, chatId) { assert.equal(chatId, '123456'); return true; },
      async bindChat() {},
      async executeCommand(command, ...args) { commands.push({ command, args }); return command === 'solopreneur.internalStopAgent'; }
    },
    async bindChat(chatId) { settings.telegramChatId = chatId; await connection.sync(fixture.globalRoot, fixture.projectRoot, 'zh'); },
    async ensureRuntime() {}
  };
  connection = createTelegramBackgroundConnection(options);
  t.after(() => connection.dispose());
  await connection.sync(fixture.globalRoot, fixture.projectRoot, 'zh');
  await fixture.start();
  fixture.updates.push(fixture.update(200, '绑定'));
  await waitFor(() => fixture.sent.some(m => m.text.includes('绑定成功')), 'First message must still require and complete editor approval');
  assert.equal(readTelegramRuntimeConfig(fixture.globalRoot).chatId, '123456');
  fixture.updates.push(fixture.update(201, '/stop'));
  await waitFor(() => fixture.sent.some(m => m.text.includes('成功终止')), 'Existing editor commands must reach their original handler');
  assert.deepEqual(commands, [{ command: 'solopreneur.internalStopAgent', args: [] }]);
  connection.dispose();
  connection = createTelegramBackgroundConnection(options);
  await connection.sync(fixture.globalRoot, fixture.projectRoot, 'zh');
  connection.dispose();
  fixture.updates.push(fixture.update(202, '当前项目下一步是什么？'));
  await waitFor(() => fixture.sent.some(m => m.text === 'Alpha 的下一步是 Ship Alpha。'), 'Closing editor after reconnect must leave background TG available');
  assert.equal(fixture.sent.filter(m => m.text === 'Alpha 的下一步是 Ship Alpha。').length, 1);
  writeTelegramRuntimeConfig(fixture.globalRoot, { chatId: '', conversationIds: {} });
  await new Promise(resolve => setTimeout(resolve, 1100));
  fixture.updates.push(fixture.update(203, '解除绑定后不应回答'));
  await waitFor(() => fixture.sent.some(m => m.text.includes('请打开 SoloMap')), 'An unbound account cannot continue chatting without approval');
  assert.equal(fixture.sent.filter(m => m.text === 'Alpha 的下一步是 Ship Alpha。').length, 1);
  await fixture.stop();
});

// Break caught: one permanently invalid message prevents every later delivery.
test('permanent delivery errors retain failed evidence and allow later messages through', async t => {
  const fixture = await backgroundFixture(t);
  const { queueTelegramBackgroundNotification } = require('../out/telegramRuntimeConfig.js');
  fixture.rejectText('不可投递的内容');
  queueTelegramBackgroundNotification(fixture.globalRoot, '不可投递的内容');
  await new Promise(resolve => setTimeout(resolve, 2));
  queueTelegramBackgroundNotification(fixture.globalRoot, '后续正常消息');
  await fixture.start();
  await waitFor(() => fixture.sent.some(m => m.text === '后续正常消息'), 'Permanent content failure must not block subsequent replies');
  const failed = fs.readdirSync(path.join(fixture.runtimeRoot, 'telegram-failed'));
  assert.equal(failed.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.runtimeRoot, 'telegram-failed', failed[0]))).text, '不可投递的内容');
  await fixture.stop();
});

// Break caught: disable/re-enable between synchronization ticks admits a revoked pending reply.
test('quickly disabling and re-enabling invalidates pending replies while preserving chat identity', async t => {
  const fixture = await backgroundFixture(t);
  const { writeTelegramRuntimeConfig } = require('../out/telegramRuntimeConfig.js');
  const { IntelligenceConversationStore } = require('../out/intelligenceChat.js');
  const previous = await new IntelligenceConversationStore(fixture.globalRoot, async () => '已有回复').send('已有消息');
  writeTelegramRuntimeConfig(fixture.globalRoot, { conversationIds: { '123456': previous.id } });
  const marker = path.join(fixture.root, 'model-started');
  fs.writeFileSync(fixture.cli, '#!/usr/bin/env node\nconst fs=require("fs");let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{fs.writeFileSync('+JSON.stringify(marker)+',"started");setTimeout(()=>console.log("迟到的回复"),500)});\n', { mode: 0o700 });
  await fixture.start();
  fixture.updates.push(fixture.update(400, '延迟回答'));
  await waitFor(() => fs.existsSync(marker), 'Model request must be pending before revocation');
  writeTelegramRuntimeConfig(fixture.globalRoot, { enabled: false });
  writeTelegramRuntimeConfig(fixture.globalRoot, { enabled: true });
  await waitFor(() => fixture.polls.some(p => p.offset === 401), 'Revoked input must settle');
  assert.equal(fixture.sent.filter(m => m.text === '迟到的回复').length, 0);
  fixture.updates.push(fixture.update(401, '新的消息'));
  await waitFor(() => fixture.sent.some(m => m.text === '迟到的回复'), 'New messages after re-enable must still receive replies');
  assert.equal(fixture.sent.filter(m => m.text === '迟到的回复').length, 1, 'Revoked and newly accepted requests must not both reply');
  assert.equal(fs.readdirSync(path.join(fixture.globalRoot, 'intelligence-conversations')).length, 1, 'Enable changes must preserve established chat identity');
  await fixture.stop();
});

// Break caught: revocation also has to invalidate previously queued deliveries.
test('disabled channel invalidates queued replies and bad HTML is delivered as plain text', async t => {
  const fixture = await backgroundFixture(t);
  const { queueTelegramBackgroundNotification, writeTelegramRuntimeConfig } = require('../out/telegramRuntimeConfig.js');
  queueTelegramBackgroundNotification(fixture.globalRoot, '撤销前排队的回复');
  writeTelegramRuntimeConfig(fixture.globalRoot, { enabled: false });
  writeTelegramRuntimeConfig(fixture.globalRoot, { enabled: true });
  fixture.rejectText('<b>任务完成</b>');
  queueTelegramBackgroundNotification(fixture.globalRoot, '<b>任务完成</b>', 'HTML');
  await fixture.start();
  await waitFor(() => fixture.sent.some(m => m.text === '任务完成'), 'Invalid HTML must be retried as readable plain text');
  assert.equal(fixture.sent.some(m => m.text === '撤销前排队的回复'), false);
  assert.equal(fixture.sent.find(m => m.text === '任务完成').parse_mode, undefined);
  await fixture.stop();
});

// Break caught: waiting for a model reply prevents receiving an urgent stop command.
test('a pending chat does not block stop commands and survives a background restart', async t => {
  const fixture = await backgroundFixture(t);
  const { createTelegramBackgroundConnection } = require('../out/telegramBackgroundConnection.js');
  const marker = path.join(fixture.root, 'slow-model-started');
  const released = path.join(fixture.root, 'release-model');
  fs.writeFileSync(fixture.cli, '#!/usr/bin/env node\nconst fs=require("fs");process.stdin.resume();process.stdin.on("end",()=>{fs.writeFileSync('+JSON.stringify(marker)+',"started");const timer=setInterval(()=>{if(fs.existsSync('+JSON.stringify(released)+')){clearInterval(timer);console.log("慢聊天完成")}},25)});\n', { mode: 0o700 });
  const commands = [];
  const connection = createTelegramBackgroundConnection({
    host: { getSettings: () => ({ telegramEnabled: true, telegramBotToken: 'fixture-token', telegramChatId: '123456' }),
      async authorizeChat() { return false; }, async bindChat() {},
      async executeCommand(command) { commands.push(command); return true; } },
    async bindChat() {}, async ensureRuntime() {}
  });
  t.after(() => connection.dispose());
  await connection.sync(fixture.globalRoot, fixture.projectRoot, 'zh');
  await fixture.start();
  fixture.updates.push(fixture.update(500, '慢聊天'));
  await waitFor(() => fs.existsSync(marker), 'Chat model must be pending');
  fixture.updates.push(fixture.update(501, '/stop'));
  await waitFor(() => commands.includes('solopreneur.internalStopAgent'), 'Urgent stop must reach editor before the chat completes');
  assert.equal(fixture.sent.some(m => m.text === '慢聊天完成'), false);
  await fixture.stop();
  connection.dispose();
  fs.writeFileSync(released, 'release');
  const beforeRestart = fixture.sent.length;
  await fixture.start();
  await waitFor(() => fixture.sent.slice(beforeRestart).some(m => m.text === '慢聊天完成'), 'Accepted pending chat must survive daemon restart');
  await waitFor(() => fs.readdirSync(path.join(fixture.runtimeRoot, 'telegram-inbox')).length === 0, 'Finished chat must leave no pending input');
  await fixture.stop();
});
