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
  mockTelegramSentMessages
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
