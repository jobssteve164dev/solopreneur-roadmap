const assert = require('node:assert/strict');
const test = require('node:test');

// Mock 'vscode' module
const registeredCommands = new Map();
let statusQueryCounter = 0;
let runAgentCounter = 0;
let stopAgentCounter = 0;
let approveNodeCounter = 0;
let denyNodeCounter = 0;

const vscodeMock = {
  commands: {
    registerCommand(commandId, callback) {
      registeredCommands.set(commandId, callback);
      return { dispose() {} };
    },
    async executeCommand(commandId, ...args) {
      if (commandId === 'solopreneur.internalGetStatus') {
        statusQueryCounter++;
        return {
          activeProject: true,
          name: 'test-project',
          path: '/home/ubuntu/project/test-project',
          progressPercent: 50,
          currentStep: '支持 TG 远程与运行状态异步通知',
          currentStepStatus: 'In Progress',
          activeNodeId: '12',
          recentExecutions: [
            {
              nodeId: '12',
              status: 'Running',
              agentCli: 'agy',
              finishedAt: '2026-07-10T09:00:00.000Z',
              completionReason: '',
              failureReason: ''
            }
          ]
        };
      }
      if (commandId === 'solopreneur.internalRunAgent') {
        runAgentCounter++;
        assert.equal(args[0], '12');
        return;
      }
      if (commandId === 'solopreneur.internalStopAgent') {
        stopAgentCounter++;
        return true;
      }
      if (commandId === 'solopreneur.internalApproveNode') {
        approveNodeCounter++;
        assert.equal(args[0], '12');
        return true;
      }
      if (commandId === 'solopreneur.internalDenyNode') {
        denyNodeCounter++;
        assert.equal(args[0], '12');
        return true;
      }
      const callback = registeredCommands.get(commandId);
      if (callback) {
        return callback(...args);
      }
      return undefined;
    }
  },
  workspace: {
    getConfiguration() {
      return {
        get(key) {
          if (key === 'telegramEnabled') return true;
          if (key === 'telegramBotToken') return 'mock-token-12345';
          if (key === 'telegramChatId') return '123456';
          return '';
        },
        async update() {
          return Promise.resolve();
        }
      };
    }
  },
  window: {
    terminals: [],
    async showWarningMessage() {
      return 'Approve / 授权';
    }
  },
  ConfigurationTarget: { Global: 1 }
};

// Override Module._load to return mock for 'vscode'
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeMock;
  }
  return originalLoad.apply(this, arguments);
};

// Set mock flag
process.env.SOLOMAP_MOCK_TELEGRAM = 'true';

const {
  startTelegramRemoteService,
  stopTelegramRemoteService,
  sendTelegramNotification,
  mockTelegramUpdates,
  mockTelegramSentMessages,
  mockTelegramApiFailures
} = require('../out/telegramRemote');

// Helper to wait briefly for async updates
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('Telegram Remote Control Service handles start and polling', async () => {
  const contextMock = {
    globalState: {
      get(key) { return {}; },
      update(key, value) { return Promise.resolve(); }
    }
  };

  mockTelegramSentMessages.length = 0;
  mockTelegramUpdates.length = 0;

  // Start polling
  startTelegramRemoteService(contextMock);

  // Send /help command
  mockTelegramUpdates.push({
    update_id: 100,
    message: {
      message_id: 1,
      from: { id: 123456, is_bot: false, first_name: 'Steve' },
      chat: { id: 123456, type: 'private' },
      date: Date.now(),
      text: '/help'
    }
  });

  await wait(200);

  // Should reply with welcome instructions
  assert.ok(mockTelegramSentMessages.length > 0);
  assert.ok(mockTelegramSentMessages[0].text.includes('SoloMap 远程智能体驾驶舱'));
  assert.equal(mockTelegramSentMessages[0].chatId, '123456');

  // Clear sent messages
  mockTelegramSentMessages.length = 0;

  // Send /status command
  mockTelegramUpdates.push({
    update_id: 101,
    message: {
      message_id: 2,
      from: { id: 123456, is_bot: false, first_name: 'Steve' },
      chat: { id: 123456, type: 'private' },
      date: Date.now(),
      text: '/status'
    }
  });

  await wait(200);

  assert.equal(statusQueryCounter, 1);
  assert.ok(mockTelegramSentMessages.length > 0);
  assert.ok(mockTelegramSentMessages[0].text.includes('test-project'));
  assert.ok(mockTelegramSentMessages[0].text.includes('In Progress'));

  // Clear sent messages
  mockTelegramSentMessages.length = 0;

  // Send /run 12
  mockTelegramUpdates.push({
    update_id: 102,
    message: {
      message_id: 3,
      from: { id: 123456, is_bot: false, first_name: 'Steve' },
      chat: { id: 123456, type: 'private' },
      date: Date.now(),
      text: '/run 12'
    }
  });

  await wait(200);

  assert.equal(runAgentCounter, 1);
  assert.ok(mockTelegramSentMessages[0].text.includes('正在启动'));

  // Clear sent messages
  mockTelegramSentMessages.length = 0;

  // Send /stop
  mockTelegramUpdates.push({
    update_id: 103,
    message: {
      message_id: 4,
      from: { id: 123456, is_bot: false, first_name: 'Steve' },
      chat: { id: 123456, type: 'private' },
      date: Date.now(),
      text: '/stop'
    }
  });

  await wait(200);

  assert.equal(stopAgentCounter, 1);
  assert.ok(mockTelegramSentMessages[0].text.includes('成功终止'));

  // Clear sent messages
  mockTelegramSentMessages.length = 0;

  // Send /approve
  mockTelegramUpdates.push({
    update_id: 104,
    message: {
      message_id: 5,
      from: { id: 123456, is_bot: false, first_name: 'Steve' },
      chat: { id: 123456, type: 'private' },
      date: Date.now(),
      text: '/approve'
    }
  });

  await wait(200);

  assert.equal(approveNodeCounter, 1);
  assert.ok(mockTelegramSentMessages[0].text.includes('远程批准'));

  // Clear sent messages
  mockTelegramSentMessages.length = 0;

  // Send /deny
  mockTelegramUpdates.push({
    update_id: 105,
    message: {
      message_id: 6,
      from: { id: 123456, is_bot: false, first_name: 'Steve' },
      chat: { id: 123456, type: 'private' },
      date: Date.now(),
      text: '/deny'
    }
  });

  await wait(200);

  assert.equal(denyNodeCounter, 1);
  assert.ok(mockTelegramSentMessages[0].text.includes('远程拒绝'));

  // Stop polling
  stopTelegramRemoteService();
});

test('sendTelegramNotification sends active notifications', async () => {
  const contextMock = {
    globalState: {
      get(key) { return {}; },
      update(key, value) { return Promise.resolve(); }
    }
  };

  mockTelegramSentMessages.length = 0;

  await sendTelegramNotification(contextMock, 'Test Message from test runner');
  assert.equal(mockTelegramSentMessages.length, 1);
  assert.equal(mockTelegramSentMessages[0].text, 'Test Message from test runner');
  assert.equal(mockTelegramSentMessages[0].chatId, '123456');
});

test('bound Telegram text reaches the intelligence reply while remote commands keep working', async t => {
  t.after(stopTelegramRemoteService);
  const contextMock = { globalState: { get() { return {}; }, update() { return Promise.resolve(); } } };
  const questions = [];
  mockTelegramSentMessages.length = 0;
  mockTelegramUpdates.length = 0;
  startTelegramRemoteService(contextMock, async (chatId, text) => {
    questions.push({ chatId, text });
    return '当前项目下一步是验证付费。';
  });
  mockTelegramUpdates.push({
    update_id: 300,
    message: { message_id: 10, from: { id: 123456, is_bot: false, first_name: 'Steve' },
      chat: { id: 123456, type: 'private' }, date: Date.now(), text: '当前项目下一步是什么？' }
  });
  await wait(200);
  assert.deepEqual(questions, [{ chatId: '123456', text: '当前项目下一步是什么？' }]);
  assert.equal(mockTelegramSentMessages.at(-1).text, '当前项目下一步是验证付费。');
  mockTelegramUpdates.push({
    update_id: 301,
    message: { message_id: 11, from: { id: 123456, is_bot: false, first_name: 'Steve' },
      chat: { id: 123456, type: 'private' }, date: Date.now(), text: '/status' }
  });
  await wait(200);
  assert.equal(questions.length, 1);
  assert.match(mockTelegramSentMessages.at(-1).text, /test-project/);
  stopTelegramRemoteService();
});

test('Telegram reply transport failure does not stop later questions', async t => {
  t.after(() => { mockTelegramApiFailures.sendMessage = 0; stopTelegramRemoteService(); });
  const contextMock = { globalState: { get() { return {}; }, update() { return Promise.resolve(); } } };
  mockTelegramUpdates.length = 0;
  mockTelegramSentMessages.length = 0;
  mockTelegramApiFailures.sendMessage = 2;
  startTelegramRemoteService(contextMock, async (_, text) => `回答：${text}`);
  for (const [index, text] of ['第一次', '第二次'].entries()) {
    mockTelegramUpdates.push({
      update_id: 400 + index,
      message: { message_id: 20 + index, from: { id: 123456, is_bot: false, first_name: 'Steve' },
        chat: { id: 123456, type: 'private' }, date: Date.now(), text }
    });
    await wait(150);
  }
  assert.deepEqual(mockTelegramSentMessages.map(message => message.text), ['回答：第二次']);
});

test('first Telegram message binds the approved chat before Pi questions are accepted', async t => {
  t.after(stopTelegramRemoteService);
  let saved = { telegramEnabled: true, telegramBotToken: 'mock-token-12345', telegramChatId: '' };
  const contextMock = { globalState: {
    get() { return saved; },
    async update(_, value) { saved = value; }
  } };
  mockTelegramUpdates.length = 0;
  mockTelegramSentMessages.length = 0;
  const questions = [];
  startTelegramRemoteService(contextMock, async (chatId, text) => {
    questions.push({ chatId, text });
    return '项目已选中。';
  });
  const message = (id, chatId, text) => ({ update_id: id, message: {
    message_id: id, from: { id: chatId, is_bot: false, first_name: 'Steve' },
    chat: { id: chatId, type: 'private' }, date: Date.now(), text
  } });
  mockTelegramUpdates.push(message(500, 123456, '你好'));
  await wait(150);
  assert.equal(saved.telegramChatId, '123456');
  assert.match(mockTelegramSentMessages.at(-1).text, /绑定成功/);
  assert.deepEqual(questions, []);
  mockTelegramUpdates.push(message(501, 999999, '当前项目？'));
  mockTelegramUpdates.push(message(502, 123456, '当前项目？'));
  await wait(200);
  assert.deepEqual(questions, [{ chatId: '123456', text: '当前项目？' }]);
  assert.ok(mockTelegramSentMessages.some(sent => sent.chatId === '999999' && sent.text.includes('无访问权限')));
  assert.equal(mockTelegramSentMessages.at(-1).text, '项目已选中。');
});

test('a reply started before disconnect is not sent after the same chat reconnects', async t => {
  t.after(stopTelegramRemoteService);
  const contextMock = { globalState: { get() { return {}; }, update() { return Promise.resolve(); } } };
  mockTelegramUpdates.length = 0;
  mockTelegramSentMessages.length = 0;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  startTelegramRemoteService(contextMock, async () => { await waiting; return '旧答案'; });
  mockTelegramUpdates.push({ update_id: 600, message: {
    message_id: 30, from: { id: 123456, is_bot: false, first_name: 'Steve' },
    chat: { id: 123456, type: 'private' }, date: Date.now(), text: '旧问题'
  } });
  await wait(100);
  stopTelegramRemoteService();
  startTelegramRemoteService(contextMock, async () => '新答案');
  mockTelegramUpdates.push({ update_id: 601, message: {
    message_id: 31, from: { id: 123456, is_bot: false, first_name: 'Steve' },
    chat: { id: 123456, type: 'private' }, date: Date.now(), text: '新问题'
  } });
  await wait(100);
  assert.deepEqual(mockTelegramSentMessages.map(sent => sent.text), ['新答案']);
  release();
  await wait(50);
  assert.deepEqual(mockTelegramSentMessages.map(sent => sent.text), ['新答案']);
});

test('a pending Telegram approval cannot bind after the service stops', async t => {
  t.after(() => { vscodeMock.window.showWarningMessage = async () => 'Approve / 授权'; stopTelegramRemoteService(); });
  let saved = { telegramEnabled: true, telegramBotToken: 'mock-token-12345', telegramChatId: '' };
  const contextMock = { globalState: {
    get() { return saved; },
    async update(_, value) { saved = value; }
  } };
  let approve;
  vscodeMock.window.showWarningMessage = () => new Promise(resolve => { approve = resolve; });
  mockTelegramUpdates.length = 0;
  mockTelegramSentMessages.length = 0;
  startTelegramRemoteService(contextMock, async () => '回答');
  mockTelegramUpdates.push({ update_id: 700, message: {
    message_id: 40, from: { id: 123456, is_bot: false, first_name: 'Steve' },
    chat: { id: 123456, type: 'private' }, date: Date.now(), text: '绑定'
  } });
  await wait(80);
  assert.equal(typeof approve, 'function');
  stopTelegramRemoteService();
  approve('Approve / 授权');
  await wait(50);
  assert.equal(saved.telegramChatId, '');
  assert.deepEqual(mockTelegramSentMessages, []);
});
