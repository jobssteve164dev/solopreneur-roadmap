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
      'module.exports.__buildSolopreneurDirectoryReadme = buildSolopreneurDirectoryReadme;',
      'module.exports.__getAgentCliCandidates = getAgentCliCandidates;',
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
    extensionModule.__buildAgentCommand('antigravity-cli', 'Build landing page', '/workspace/app'),
    "'antigravity-cli' --print --print-timeout=30m --add-dir='/workspace/app' 'Build landing page'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('agy', 'Build landing page', '/workspace/app'),
    "'agy' --print --print-timeout=30m --add-dir='/workspace/app' 'Build landing page'"
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
    'codex'
  );
  assert.ok(shellScript.finalCommand.includes('/workspace/app/.solopreneur/agent-runs/2/output.log'));
  assert.ok(shellScript.finalCommand.includes('/workspace/app/.solopreneur/agent-runs/2/touched-files.txt'));
  assert.ok(shellScript.finalCommand.includes("git -C"));
  assert.ok(shellScript.finalCommand.includes('/workspace/app'));
  assert.ok(shellScript.finalCommand.includes('status --short'));
  assert.ok(shellScript.finalCommand.includes('timed out waiting for response'));
  assert.ok(shellScript.finalCommand.includes('without project file changes or a completion decision'));
  assert.ok(shellScript.finalCommand.includes('.agent_status.json'));
  assert.ok(shellScript.finalCommand.includes('In Progress'));
  assert.ok(shellScript.finalCommand.includes('markCompleted'));
  assert.equal(typeof extensionModule.__processAgentStatusFile, 'function');

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
    '# 环节交接总结\n\n## 2026-05-22 · In Progress\n\n### 本轮文件变化\nM README.md\n\n### 本轮关键信号\nCreated README and ran npm test.',
    '/workspace/app/.solopreneur/agent-runs/2/completion.json'
  );
  assert.match(prompt, /Use a small smoke test/);
  assert.match(prompt, /该环节交接总结/);
  assert.match(prompt, /Created README and ran npm test/);
  assert.match(prompt, /markCompleted/);
  assert.match(prompt, /正常退出 CLI 进程/);
  assert.match(prompt, /唯一任务/);
  assert.match(prompt, /Solopreneur Roadmap/);

  const handoff = extensionModule.__buildRunHandoffEntry(
    'In Progress',
    'M README.md\nA docs/product-brief.md',
    'Implemented the first slice.\nRan npm test successfully.',
    ''
  );
  assert.match(handoff, /本轮文件变化/);
  assert.match(handoff, /README.md/);
  assert.match(handoff, /本轮关键信号/);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-noop-agent-'));
  const noopRun = extensionModule.__buildAgentShellScript('printf ok', tempRoot, 'noop', 'agy');
  childProcess.execSync(noopRun.finalCommand, { cwd: tempRoot, stdio: 'ignore' });
  const noopStatus = JSON.parse(fs.readFileSync(path.join(tempRoot, '.agent_status.json'), 'utf8'));
  assert.equal(noopStatus.status, 'Failed');
  assert.match(fs.readFileSync(noopRun.outputFilePath, 'utf8'), /without project file changes/);

  const dataReadme = extensionModule.__buildSolopreneurDirectoryReadme();
  assert.match(dataReadme, /Solopreneur Project Data/);
  assert.match(dataReadme, /roadmap\.csv/);
  assert.match(dataReadme, /step-memory/);
  assert.match(dataReadme, /project_journal\.db/);
  assert.match(dataReadme, /Git\/GitHub/);
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
