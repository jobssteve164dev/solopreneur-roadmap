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

test('all SoloMap-created command windows use the shared terminal readiness gate', () => {
  for (const relativePath of ['src/extension.ts', 'src/dailyReview.ts', 'src/sidebarProvider.ts']) {
    const source = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
    assert.doesNotMatch(source, /\bterminal\.sendText\(/, `${relativePath} bypasses terminal readiness`);
    assert.match(source, /sendTextWhenTerminalReady/);
  }
});

test('the SoloMap experience baseline requires terminal readiness and final script execution', () => {
  const baseline = fs.readFileSync(
    path.join(projectRoot, 'docs/ui/local-first-loading-interaction-baseline.zh.md'),
    'utf8'
  );
  assert.match(baseline, /终端进程已就绪，正式命令已被接收并开始执行/);
  assert.match(baseline, /不允许各入口直接调用 `sendText`/);
  assert.match(baseline, /故意延迟终端 Shell 进程创建/);
  assert.match(baseline, /最终运行脚本已经执行并产出状态文件/);
});
