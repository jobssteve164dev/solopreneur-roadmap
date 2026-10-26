const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const { sendTextWhenTerminalReady } = require(path.join(projectRoot, 'out', 'terminalCompatibility.js'));

test('terminal commands wait for a delayed shell process and keep their order', async () => {
  let resolveProcess;
  const delivered = [];
  const terminal = {
    processId: new Promise((resolve) => {
      resolveProcess = resolve;
    }),
    sendText(text, addNewLine) {
      delivered.push({ text, addNewLine });
    }
  };

  const preparing = sendTextWhenTerminalReady(terminal, 'prepare');
  const command = sendTextWhenTerminalReady(terminal, 'bash run-agent.sh');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, []);

  resolveProcess(4321);
  assert.equal(await preparing, true);
  assert.equal(await command, true);
  assert.deepEqual(delivered, [
    { text: 'prepare', addNewLine: true },
    { text: 'bash run-agent.sh', addNewLine: true }
  ]);
});

test('terminal commands remain compatible with hosts that do not expose processId', async () => {
  const delivered = [];
  const terminal = {
    sendText(text, addNewLine) {
      delivered.push({ text, addNewLine });
    }
  };

  assert.equal(await sendTextWhenTerminalReady(terminal, 'codex --version', false), true);
  assert.deepEqual(delivered, [{ text: 'codex --version', addNewLine: false }]);
});

test('terminal readiness timeout reports the exact failed stage and never submits the command', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const delivered = [];
  const events = [];
  const terminal = {
    processId: new Promise(() => {}),
    sendText(text, addNewLine) {
      delivered.push({ text, addNewLine });
    }
  };

  const pending = sendTextWhenTerminalReady(terminal, 'codex resume original-session', true, {
    readinessTimeoutMs: 10_000,
    observe: event => events.push(event)
  });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10_001);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(await Promise.race([pending, new Promise(resolve => setImmediate(() => resolve('still-pending')))]), false);
  assert.deepEqual(delivered, []);
  assert.deepEqual(events.map(event => [event.stage, event.status, event.error]), [
    ['terminal.process.wait', 'start', undefined],
    ['terminal.process.wait', 'error', 'terminal_process_timeout']
  ]);
});

test('a slow supported shell cannot receive commands when the five second display budget expires', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveProcess;
  const delivered = [];
  const terminal = {
    processId: new Promise(resolve => { resolveProcess = resolve; }),
    sendText(text, addNewLine) {
      delivered.push({ text, addNewLine });
    }
  };

  const preparing = sendTextWhenTerminalReady(terminal, 'prepare');
  const launching = sendTextWhenTerminalReady(terminal, 'codex resume original-session');
  try {
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(6000);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(delivered, [], 'a visible terminal is not evidence that its shell can accept input');
  } finally {
    resolveProcess(4321);
    await Promise.all([preparing, launching]);
  }
  assert.deepEqual(delivered, [
    { text: 'prepare', addNewLine: true },
    { text: 'codex resume original-session', addNewLine: true }
  ]);
});

test('a slow shell records the readiness budget breach without dropping the eventual command', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveProcess;
  const delivered = [];
  const events = [];
  const terminal = {
    processId: new Promise(resolve => { resolveProcess = resolve; }),
    sendText(text) { delivered.push(text); }
  };

  const pending = sendTextWhenTerminalReady(terminal, 'codex resume original-session', true, {
    readinessBudgetMs: 5_000,
    observe: event => events.push(event)
  });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(5_001);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.map(event => [event.stage, event.status, event.error]), [
    ['terminal.process.wait', 'start', undefined],
    ['terminal.process.slow', 'error', 'terminal_process_slow']
  ]);
  assert.deepEqual(delivered, []);

  resolveProcess(4321);
  assert.equal(await pending, true);
  assert.deepEqual(delivered, ['codex resume original-session']);
  assert.equal(events.at(-1).stage, 'terminal.command.send');
  assert.equal(events.at(-1).status, 'ok');
});

test('Codex continuation uses one explicit paste followed by submit outside the paste', async () => {
  const { agentTerminalInputFrame, sendAgentTextWhenTerminalReady } = require('../out/terminalCompatibility.js');
  const delivered = []; const terminal = { processId: Promise.resolve(123), sendText: (text, addNewLine) => delivered.push({ text, addNewLine }) };
  assert.equal(await sendAgentTextWhenTerminalReady(terminal, '第一行\n第二行', 'codex'), true);
  assert.deepEqual(delivered, [{ text: '\x1b[200~第一行\n第二行\x1b[201~\r', addNewLine: false }]);
  assert.equal(agentTerminalInputFrame('普通续聊\n下一行', 'claude').toString(), '\x1b[200~普通续聊\n下一行\x1b[201~\r');
});

test('all SoloMap-created command windows use the shared terminal readiness gate', () => {
  for (const relativePath of ['src/extension.ts', 'src/sidebarProvider.ts']) {
    const source = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
    assert.doesNotMatch(source, /\bterminal\.sendText\(/, `${relativePath} bypasses terminal readiness`);
    assert.match(source, /sendTextWhenTerminalReady/);
  }
});

test('the SoloMap experience baseline requires direct runner delivery and Provider task ingress', () => {
  const baseline = fs.readFileSync(
    path.join(projectRoot, 'docs/ui/local-first-loading-interaction-baseline.zh.md'),
    'utf8'
  );
  assert.match(baseline, /插件已取得与本次 interaction、run、generation 和 turn 精确绑定的 task-ingress 收据/);
  assert.match(baseline, /`provider_native` 收据/);
  assert.match(baseline, /`agent_acknowledged` 收据/);
  assert.match(baseline, /`sendText\(\)`\/PTY write 返回或观察普通输出都不算完成/);
  assert.match(baseline, /故意延迟或阻断普通终端 Shell\/PTY 进程创建/);
  assert.match(baseline, /进程树和 terminal bridge 仅作诊断\/transport，永不结束计时/);
});
