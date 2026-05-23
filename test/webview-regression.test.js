const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function loadCompiledModule(relativePath, exportPatch) {
  const filename = path.join(projectRoot, relativePath);
  const source = fs.readFileSync(filename, 'utf8') + `\n${exportPatch}`;
  const exports = {};
  const module = { exports };
  const context = {
    exports,
    module,
    require: (id) => {
      if (id === 'vscode') {
        return {};
      }
      if (id.startsWith('./')) {
        return {};
      }
      return require(id);
    },
    console,
    URL,
    __dirname: path.dirname(filename),
    __filename: filename
  };

  vm.runInNewContext(source, context, { filename });
  return context.module.exports;
}

function extractLastScript(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0, 'webview HTML should include an inline runtime script');
  return scripts[scripts.length - 1][1];
}

function createElement(id) {
  return {
    id,
    style: { display: '' },
    listeners: {},
    value: '',
    textContent: '',
    className: '',
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    appendChild() {},
    querySelector() {
      return null;
    },
    set innerHTML(value) {
      this._innerHTML = value;
    },
    get innerHTML() {
      return this._innerHTML || '';
    }
  };
}

function runScriptWithMinimalDom(script, ids) {
  const elements = Object.fromEntries(ids.map((id) => [id, createElement(id)]));
  const postedMessages = [];
  const context = {
    document: {
      getElementById: (id) => elements[id] || null,
      createElement
    },
    window: {
      addEventListener() {}
    },
    acquireVsCodeApi: () => ({
      postMessage: (message) => postedMessages.push(message)
    })
  };

  vm.runInNewContext(script, context);
  return { elements, postedMessages };
}

test('sidebar webview runtime script parses and opens settings panel', () => {
  const { SolopreneurSidebarProvider } = loadCompiledModule(
    'out/sidebarProvider.js',
    ''
  );
  const provider = new SolopreneurSidebarProvider(
    {},
    { getNodes: () => [] },
    async () => {},
    async () => {},
    () => ({ apiProvider: 'Gemini', apiKey: '', cliPath: 'codex', language: 'zh' }),
    async () => {},
    () => ({ projects: [{ name: 'app', path: '/workspace/app' }], selectedProjectPath: '/workspace/app' }),
    async () => {},
    async () => {}
  );
  const html = provider._getHtmlForWebview({});
  const script = extractLastScript(html);

  assert.doesNotThrow(() => new vm.Script(script));

  const { elements, postedMessages } = runScriptWithMinimalDom(script, [
    'tasks-list',
    'progress-bar',
    'progress-text',
    'btn-open-full',
    'project-select',
    'btn-add-project',
    'btn-toggle-settings',
    'btn-close-settings',
    'settings-panel',
    'setting-provider',
    'setting-key',
    'setting-language',
    'api-key-container',
    'setting-clipath',
    'btn-test-cli',
    'btn-save-settings',
    'cli-test-badge'
  ]);

  elements['btn-toggle-settings'].listeners.click();

  assert.equal(elements['settings-panel'].style.display, 'block');
  assert.ok(postedMessages.some((message) => message.command === 'getSettings'));
});

test('full roadmap webview runtime script parses and opens settings panel', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    'module.exports.__getWebviewHtml = getWebviewHtml;'
  );
  const html = extensionModule.__getWebviewHtml({}, { extensionPath: projectRoot });
  const script = extractLastScript(html);

  assert.doesNotThrow(() => new vm.Script(script));

  const { elements, postedMessages } = runScriptWithMinimalDom(script, [
    'canvas',
    'project-select',
    'btn-add-project',
    'btn-toggle-settings',
    'btn-close-settings',
    'settings-panel',
    'setting-provider',
    'setting-key',
    'setting-language',
    'api-key-container',
    'setting-clipath',
    'btn-test-cli',
    'btn-save-settings',
    'cli-test-badge'
  ]);
  elements.canvas.querySelector = () => createElement('flow-line');

  elements['btn-toggle-settings'].listeners.click();

  assert.equal(elements['settings-panel'].style.display, 'flex');
  assert.ok(postedMessages.some((message) => message.command === 'getSettings'));
});

test('full roadmap webview exposes node conversation history and language setting', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    'module.exports.__getWebviewHtml = getWebviewHtml;'
  );
  const html = extensionModule.__getWebviewHtml({}, { extensionPath: projectRoot });
  const script = extractLastScript(html);

  assert.match(html, /id="setting-language"/);
  assert.doesNotMatch(html, /id="ai-prompt"/);
  assert.doesNotMatch(html, /id="btn-generate"/);
  assert.match(script, /getNodeConversations/);
  assert.match(script, /nodeConversationsLoaded/);
  assert.match(script, /Start Agent Conversation|发起 Agent 对话/);
  assert.match(script, /Agent Conversation History|Agent 对话历史/);
  assert.match(script, /conversationPlaceholder/);
  assert.match(script, /data-send-node-id/);
  assert.match(script, /data-agent-select-id/);
  assert.match(script, /data-retry-conversation-id/);
  assert.match(script, /renderAgentOptions/);
  assert.match(script, /summarizeConversation/);
  assert.match(script, /retryConversation/);
  assert.match(script, /completeNode/);
  assert.match(script, /Complete Step|完成环节/);
  assert.match(script, /resetProjectScopedState/);
  assert.match(script, /projectPath/);
});

test('sidebar keeps project creation focused on the project switcher', () => {
  const { SolopreneurSidebarProvider } = loadCompiledModule(
    'out/sidebarProvider.js',
    ''
  );
  const provider = new SolopreneurSidebarProvider(
    {},
    { getNodes: () => [] },
    async () => {},
    async () => {},
    () => ({ apiProvider: 'Gemini', apiKey: '', cliPath: 'codex', language: 'zh' }),
    async () => {},
    () => ({ projects: [{ name: 'app', path: '/workspace/app' }], selectedProjectPath: '/workspace/app' }),
    async () => {},
    async () => {}
  );
  const html = provider._getHtmlForWebview({});

  assert.match(html, /id="project-select"/);
  assert.match(html, /id="btn-add-project"/);
  assert.doesNotMatch(html, /ai-prompt-sidebar/);
  assert.doesNotMatch(html, /btn-generate-sidebar/);
});

test('agent command builder uses Codex exec and preserves Antigravity run path', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__buildAgentCommand = buildAgentCommand;',
      'module.exports.__buildAgentShellScript = buildAgentShellScript;',
      'module.exports.__buildAgentConversationPrompt = buildAgentConversationPrompt;',
      'module.exports.__buildRunHandoffEntry = buildRunHandoffEntry;',
      'module.exports.__parseStepHandoffEntries = parseStepHandoffEntries;',
      'module.exports.__buildStepHandoffSummary = buildStepHandoffSummary;',
      'module.exports.__updateStepHandoffSummary = updateStepHandoffSummary;',
      'module.exports.__readStepHandoffSummary = readStepHandoffSummary;',
      'module.exports.__buildSolopreneurDirectoryReadme = buildSolopreneurDirectoryReadme;',
      'module.exports.__getAgentCliCandidates = getAgentCliCandidates;',
      'module.exports.__getAgentProvider = getAgentProvider;',
      'module.exports.__getStepSessionFilePath = getStepSessionFilePath;',
      'module.exports.__readStepSessionState = readStepSessionState;',
      'module.exports.__getStoredAgentSession = getStoredAgentSession;',
      'module.exports.__updateStoredAgentSession = updateStoredAgentSession;',
      'module.exports.__clearStoredAgentSession = clearStoredAgentSession;',
      'module.exports.__extractUserSupplementFromExecutionOutput = extractUserSupplementFromExecutionOutput;',
      'module.exports.__buildLocalRoadmap = buildLocalRoadmap;',
      'module.exports.__processAgentStatusFile = processAgentStatusFile;',
      'module.exports.__shellQuote = shellQuote;'
    ].join('\n')
  );

  assert.equal(
    extensionModule.__buildAgentCommand('codex', 'Ship the MVP', '/workspace/app'),
    "'codex' exec -C '/workspace/app' 'Ship the MVP'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('codex-cli', "Don't skip tests", '/workspace/app'),
    "'codex-cli' exec -C '/workspace/app' 'Don'\\''t skip tests'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('codex', 'Continue the MVP', '/workspace/app', '019dc472-6a80-7c70-99a4-b2593a641d11'),
    "'codex' exec -C '/workspace/app' 'Continue the MVP'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('antigravity-cli', 'Build landing page', '/workspace/app'),
    "'antigravity-cli' --print --print-timeout=30m --add-dir='/workspace/app' 'Build landing page'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('agy', 'Build landing page', '/workspace/app'),
    "'agy' --print --print-timeout=30m --add-dir='/workspace/app' 'Build landing page'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('agy', 'Continue landing page', '/workspace/app', '3350a3b7-7761-4ed5-9661-2e9c9de8f924'),
    "'agy' --print --print-timeout=30m --add-dir='/workspace/app' 'Continue landing page'"
  );
  assert.equal(
    JSON.stringify(extensionModule.__getAgentCliCandidates('antigravity-cli', 'agy').slice(0, 4)),
    JSON.stringify(['agy', 'antigravity-cli', 'antigravity', 'codex'])
  );
  assert.equal(
    JSON.stringify(extensionModule.__getAgentCliCandidates('codex', 'codex').slice(0, 4)),
    JSON.stringify(['codex', 'codex-cli', 'agy', 'antigravity'])
  );

  const sidebarModule = loadCompiledModule(
    'out/sidebarProvider.js',
    [
      'module.exports.__getAgentCliCandidates = getAgentCliCandidates;',
      'module.exports.__getCliVersionArgs = getCliVersionArgs;',
      'module.exports.__formatCliTestMessage = formatCliTestMessage;'
    ].join('\n')
  );
  assert.equal(
    JSON.stringify(sidebarModule.__getAgentCliCandidates('antigravity-cli', 'agy').slice(0, 4)),
    JSON.stringify(['agy', 'antigravity-cli', 'antigravity', 'codex'])
  );
  assert.equal(
    JSON.stringify(sidebarModule.__getAgentCliCandidates('codex', 'codex').slice(0, 4)),
    JSON.stringify(['codex', 'codex-cli', 'agy', 'antigravity'])
  );
  assert.equal(JSON.stringify(sidebarModule.__getCliVersionArgs('agy')), JSON.stringify(['--version']));
  assert.match(sidebarModule.__formatCliTestMessage('agy', '1.0.1\n', ''), /agy · 1\.0\.1/);

  const shellScript = extensionModule.__buildAgentShellScript(
    "'codex' exec -C '/workspace/app' 'Ship the MVP'",
    '/workspace/app',
    '2',
    'codex',
    42,
    'Use a small smoke test.'
  );
  assert.ok(shellScript.finalCommand.includes('/workspace/app/.solopreneur/agent-runs/2/output.log'));
  assert.ok(shellScript.finalCommand.includes('/workspace/app/.solopreneur/agent-runs/2/touched-files.txt'));
  assert.ok(shellScript.finalCommand.includes("git -C"));
  assert.ok(shellScript.finalCommand.includes('/workspace/app'));
  assert.ok(shellScript.finalCommand.includes('status --short'));
  assert.ok(shellScript.finalCommand.includes('timed out waiting for response'));
  assert.ok(shellScript.finalCommand.includes('without project file changes or a completion decision'));
  assert.ok(shellScript.finalCommand.includes('.agent_status.json'));
  assert.ok(shellScript.finalCommand.includes('executionLogId'));
  assert.ok(shellScript.finalCommand.includes('sessionFilePath'));
  assert.ok(shellScript.finalCommand.includes('sessionMode'));
  assert.ok(shellScript.finalCommand.includes('commandFilePath'));
  assert.ok(shellScript.finalCommand.includes('/workspace/app/.solopreneur/agent-runs/2/command.txt'));
  assert.ok(shellScript.finalCommand.includes('.codex/sessions'));
  assert.ok(shellScript.finalCommand.includes('Use a small smoke test.'));
  assert.ok(shellScript.finalCommand.includes('In Progress'));
  assert.ok(shellScript.finalCommand.includes('markCompleted'));
  assert.equal(typeof extensionModule.__processAgentStatusFile, 'function');

  const agyShellScript = extensionModule.__buildAgentShellScript(
    "'agy' --print --print-timeout=30m --add-dir='/workspace/app' 'Ship the MVP'",
    '/workspace/app',
    '2',
    'agy',
    43,
    ''
  );
  assert.ok(agyShellScript.finalCommand.includes('antigravity-cli/cache/last_conversations.json'));
  assert.ok(agyShellScript.finalCommand.includes('antigravity-log'));

  const prompt = extensionModule.__buildAgentConversationPrompt(
    {
      title: 'Build onboarding',
      stage: '产品与 MVP',
      description: 'Create the first usable onboarding path.',
      agentPrompt: 'Implement the first slice.',
      status: 'In Progress'
    },
    'Use a small smoke test.',
    '/workspace/app',
    '/workspace/app/.solopreneur/step-memory/2.json',
    '/workspace/app/.solopreneur/agent-runs/2',
    '/workspace/app/.solopreneur/agent-runs/2/completion.json'
  );
  assert.match(prompt, /Use a small smoke test/);
  assert.match(prompt, /最高优先级规则/);
  assert.match(prompt, /唯一最高优先级指令/);
  assert.match(prompt, /必须先读取 Solopreneur 为本环节保存的项目上下文文件/);
  assert.match(prompt, /\.solopreneur\/step-memory\/2\.json/);
  assert.match(prompt, /\.solopreneur\/agent-runs\/2/);
  assert.doesNotMatch(prompt, /该环节交接总结 JSON/);
  assert.doesNotMatch(prompt, /Created README and ran npm test/);
  assert.match(prompt, /markCompleted/);
  assert.match(prompt, /正常退出 CLI 进程/);
  assert.match(prompt, /唯一任务/);
  assert.match(prompt, /Solopreneur Roadmap/);

  const followupPrompt = extensionModule.__buildAgentConversationPrompt(
    {
      title: 'Build onboarding',
      stage: '产品与 MVP',
      description: 'Create the first usable onboarding path.',
      agentPrompt: 'Implement the first slice.',
      status: 'In Progress'
    },
    'Keep the original novel ending.',
    '/workspace/app',
    '/workspace/app/.solopreneur/step-memory/2.json',
    '/workspace/app/.solopreneur/agent-runs/2',
    '/workspace/app/.solopreneur/agent-runs/2/completion.json',
    '3350a3b7-7761-4ed5-9661-2e9c9de8f924'
  );
  assert.match(followupPrompt, /Keep the original novel ending/);
  assert.match(followupPrompt, /高于旧会话中的既有结论/);
  assert.match(followupPrompt, /即使当前环节状态显示为 Completed 或 Failed/);
  assert.match(followupPrompt, /上轮同 Agent 原生会话参考/);
  assert.match(followupPrompt, /上一轮会话 ID：3350a3b7-7761-4ed5-9661-2e9c9de8f924/);
  assert.match(followupPrompt, /这只是可选参考，不是强制续接命令/);
  assert.match(followupPrompt, /只有在你判断确实需要查看上一轮对话细节时/);
  assert.match(followupPrompt, /项目目录：\/workspace\/app/);
  assert.match(followupPrompt, /环节说明：Create the first usable onboarding path/);
  assert.match(followupPrompt, /\.solopreneur\/step-memory\/2\.json/);
  assert.match(followupPrompt, /\.solopreneur\/agent-runs\/2/);
  assert.doesNotMatch(followupPrompt, /该环节交接总结 JSON/);
  assert.doesNotMatch(followupPrompt, /Old handoff should not be injected/);
  assert.doesNotMatch(followupPrompt, /继续当前路线图环节的原生 Agent 会话/);

  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-session-'));
  const sessionState = extensionModule.__updateStoredAgentSession(
    sessionRoot,
    '2',
    'agy',
    '3350a3b7-7761-4ed5-9661-2e9c9de8f924'
  );
  assert.equal(sessionState.sessions.antigravity.sessionId, '3350a3b7-7761-4ed5-9661-2e9c9de8f924');
  assert.equal(
    extensionModule.__getStoredAgentSession(sessionRoot, '2', 'antigravity-cli').sessionId,
    '3350a3b7-7761-4ed5-9661-2e9c9de8f924'
  );
  assert.equal(extensionModule.__clearStoredAgentSession(sessionRoot, '2', 'antigravity-cli'), true);
  assert.equal(extensionModule.__getStoredAgentSession(sessionRoot, '2', 'agy'), null);
  assert.match(extensionModule.__getStepSessionFilePath(sessionRoot, '2'), /\.solopreneur\/step-sessions\/2\.json$/);
  assert.equal(
    extensionModule.__extractUserSupplementFromExecutionOutput([
      'User supplement:',
      'Keep chapter three shorter.',
      '',
      'Sentinel captured state: Failed'
    ].join('\n')),
    'Keep chapter three shorter.'
  );

  const handoff = extensionModule.__buildRunHandoffEntry(
    'In Progress',
    'M README.md\nA docs/product-brief.md',
    'Implemented the first slice.\nRan npm test successfully.',
    ''
  );
  assert.equal(handoff.status, 'In Progress');
  assert.ok(handoff.changedFiles.some((line) => line.includes('README.md')));
  assert.match(handoff.usefulSignals, /Implemented the first slice/);

  const dirtySummary = [
    '# 环节交接总结',
    '',
    '这份总结供下一轮 Agent 对话续接上下文使用，只保留最近 10 次结构化交接。',
    '',
    '## 2026-05-23T06:30:00.784Z · Completed',
    '',
    '### 本轮文件变化',
    'docs/implementation-plan.md',
    '',
    '### 本轮关键信号',
    'Created implementation plan.',
    '',
    '### 完成判断',
    'First run complete.',
    '# 环节交接总结',
    '',
    '这份总结供下一轮 Agent 对话续接上下文使用，只保留最近 10 次结构化交接。',
    '',
    '## 2026-05-23T06:30:00.531Z · Completed',
    '',
    '### 本轮文件变化',
    'docs/implementation-plan.md',
    '',
    '### 本轮关键信号',
    'Created implementation plan.',
    '',
    '### 完成判断',
    'First run complete.'
  ].join('\n');
  const parsedDirty = extensionModule.__parseStepHandoffEntries(dirtySummary);
  assert.equal(parsedDirty.length, 1);
  assert.equal(JSON.stringify(parsedDirty[0].changedFiles), JSON.stringify(['docs/implementation-plan.md']));
  assert.match(parsedDirty[0].usefulSignals, /Created implementation plan/);

  const handoffPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-handoff-')), '2.json');
  const firstSummary = extensionModule.__updateStepHandoffSummary(handoffPath, handoff);
  const secondSummary = extensionModule.__updateStepHandoffSummary(handoffPath, handoff);
  assert.equal(extensionModule.__parseStepHandoffEntries(secondSummary).length, 1);
  assert.doesNotMatch(secondSummary, /# 环节交接总结/);
  assert.doesNotMatch(secondSummary, /\n\n---\n\n/);
  assert.equal(JSON.parse(secondSummary).entries.length, 1);
  assert.equal(extensionModule.__readStepHandoffSummary(handoffPath), secondSummary);
  assert.match(firstSummary, /solopreneur\.stepHandoff/);

  const legacyHandoffPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-handoff-legacy-')), '2.json');
  fs.writeFileSync(legacyHandoffPath.replace(/\.json$/, '.md'), dirtySummary, 'utf8');
  const migrated = extensionModule.__readStepHandoffSummary(legacyHandoffPath);
  assert.equal(JSON.parse(migrated).entries.length, 1);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-noop-agent-'));
  const noopRun = extensionModule.__buildAgentShellScript('printf ok', tempRoot, 'noop', 'agy', 7, '');
  childProcess.execSync(noopRun.finalCommand, { cwd: tempRoot, stdio: 'ignore' });
  const noopStatus = JSON.parse(fs.readFileSync(path.join(tempRoot, '.agent_status.json'), 'utf8'));
  assert.equal(noopStatus.status, 'Failed');
  assert.match(fs.readFileSync(noopRun.outputFilePath, 'utf8'), /without project file changes/);

  const dataReadme = extensionModule.__buildSolopreneurDirectoryReadme();
  assert.match(dataReadme, /Solopreneur Project Data/);
  assert.match(dataReadme, /roadmap\.csv/);
  assert.match(dataReadme, /step-memory/);
  assert.match(dataReadme, /step-sessions/);
  assert.match(dataReadme, /project_journal\.db/);
  assert.match(dataReadme, /Git\/GitHub/);
});

test('failed conversations render retry action in roadmap webview', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    'module.exports.__getWebviewHtml = getWebviewHtml;'
  );
  const html = extensionModule.__getWebviewHtml({}, { extensionPath: projectRoot });

  assert.match(html, /conversation-retry-btn/);
  assert.match(html, /Retry|重试/);
  assert.match(html, /retryConversation/);
});

test('local roadmap fallback produces runnable dependent tasks', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    'module.exports.__buildLocalRoadmap = buildLocalRoadmap;'
  );
  const nodes = extensionModule.__buildLocalRoadmap('AI CRM for freelancers', 'codex');

  assert.equal(nodes.length, 4);
  assert.equal(nodes[0].dependencies, '');
  assert.equal(nodes[1].dependencies, '1');
  assert.equal(nodes[2].dependencies, '2');
  assert.equal(nodes[3].dependencies, '3');
  assert.ok(nodes.every((node) => node.agentCli === 'codex'));
  assert.ok(nodes.some((node) => node.agentPrompt.includes('docs/product-brief.md')));
});

test('agent execution log updates one conversation instead of creating a duplicate', async () => {
  const { SqliteStore } = require(path.join(projectRoot, 'out/db/sqliteStore.js'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-log-update-'));
  const store = new SqliteStore(path.join(tempRoot, 'journal.db'), projectRoot);
  await store.init();

  const logId = store.logExecution('2', 'agy', 'agy --print task', 'Agent conversation started.', 'Running');
  const updated = store.updateExecution(logId, 'agy', 'agy --print task', 'Agent output tail:\nDone.', 'In Progress');
  const logs = store.getExecutionLogs('2');

  assert.equal(updated, true);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].id, logId);
  assert.equal(logs[0].status, 'In Progress');
  assert.match(logs[0].output, /Done/);

  store.logExecution('3', 'agy', 'agy --print task', 'Launched command in integrated terminal', 'Running');
  store.logExecution('3', 'agy', 'agy --print task', 'Agent output tail:\nFinished.', 'In Progress');
  const cleanedLogs = store.getExecutionLogs('3');
  assert.equal(cleanedLogs.length, 1);
  assert.equal(cleanedLogs[0].status, 'In Progress');
  store.close();
});
