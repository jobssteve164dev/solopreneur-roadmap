const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function createUri(value) {
  return {
    fsPath: value,
    path: value,
    toString() {
      return value;
    }
  };
}

function createWebviewStub() {
  return {
    asWebviewUri(uri) {
      return String(uri && (uri.fsPath || uri.path || uri));
    }
  };
}

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
        return {
          Uri: {
            file: createUri,
            joinPath(base, ...segments) {
              return createUri(path.join(base.fsPath || base.path || String(base), ...segments));
            }
          },
          window: {
            terminals: [],
            showInformationMessage() {},
            showWarningMessage() {}
          }
        };
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
    classList: {
      values: new Set(),
      add(value) {
        this.values.add(value);
      },
      remove(value) {
        this.values.delete(value);
      },
      toggle(value, force) {
        if (force === undefined ? !this.values.has(value) : force) {
          this.values.add(value);
          return true;
        }
        this.values.delete(value);
        return false;
      },
      contains(value) {
        return this.values.has(value);
      }
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    appendChild() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
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

test('extension manifest uses SoloMap visible branding', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

  assert.equal(manifest.displayName, 'SoloMap: AI Roadmap & Agent Task Flow');
  assert.equal(manifest.description, 'Turn project ideas into AI roadmaps and local agent task flows in VS Code.');
  assert.deepEqual(manifest.categories, ['AI', 'Chat', 'Machine Learning', 'Visualization', 'Other']);
  assert.ok(manifest.keywords.includes('ai'));
  assert.ok(manifest.keywords.includes('chat'));
  assert.ok(manifest.keywords.includes('agent'));
  assert.ok(manifest.keywords.includes('roadmap'));
  assert.equal(manifest.contributes.commands[0].title, 'SoloMap: Show AI Roadmap');
  assert.equal(manifest.contributes.commands[0].category, 'SoloMap');
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].title, 'SoloMap');
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].icon, 'resources/activitybar.svg');
  assert.equal(manifest.contributes.views['solopreneur-sidebar-container'][0].name, 'SoloMap');
  assert.equal(manifest.contributes.configuration.title, 'SoloMap Settings');
  assert.equal(manifest.contributes.configuration.properties['solopreneur.globalPrompt'].default, '');
});

test('readme uses bilingual marketplace copy and stable remote logo', () => {
  const readme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8');

  assert.match(readme, /raw\.githubusercontent\.com\/jobssteve164dev\/solopreneur-roadmap\/main\/resources\/logo\.png/);
  assert.match(readme, /Why SoloMap\? \/ 为什么选择 SoloMap？/);
  assert.match(readme, /Core Capabilities \/ 核心能力/);
  assert.match(readme, /Quick Start \/ 快速开始/);
  assert.match(readme, /Local Agent CLI \/ 本地 Agent CLI/);
  assert.match(readme, /Data Location \/ 数据位置/);
  assert.match(readme, /Privacy \/ 隐私/);
  assert.match(readme, /Feedback \/ 反馈/);
});

test('sidebar webview runtime script parses and opens settings panel', () => {
  const { SolopreneurSidebarProvider } = loadCompiledModule(
    'out/sidebarProvider.js',
    ''
  );
  const provider = new SolopreneurSidebarProvider(
    createUri(projectRoot),
    { getNodes: () => [] },
    async () => {},
    () => ({ cliPath: 'codex', language: 'zh' }),
    async () => {},
    () => ({ projects: [{ name: 'app', path: '/workspace/app' }], selectedProjectPath: '/workspace/app' }),
    async () => {},
    async () => {}
  );
  const html = provider._getHtmlForWebview(createWebviewStub());
  const script = extractLastScript(html);

  assert.doesNotThrow(() => new vm.Script(script));

  const { elements, postedMessages } = runScriptWithMinimalDom(script, [
    'tasks-list',
    'progress-bar',
    'progress-text',
    'btn-open-full',
    'project-select',
    'btn-add-project',
    'portfolio-title',
    'portfolio-list',
    'portfolio-filters',
    'btn-toggle-settings',
    'btn-close-settings',
    'settings-panel',
    'setting-language',
    'setting-clipath',
    'setting-global-prompt',
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
  const html = extensionModule.__getWebviewHtml(createWebviewStub(), { extensionPath: projectRoot, extensionUri: createUri(projectRoot) });
  const script = extractLastScript(html);

  assert.doesNotThrow(() => new vm.Script(script));

  const { elements, postedMessages } = runScriptWithMinimalDom(script, [
    'canvas',
    'project-select',
    'btn-add-project',
    'btn-remove-project',
    'btn-toggle-roadmap-revision',
    'btn-close-roadmap-revision',
    'roadmap-revision-panel',
    'roadmap-revision-body',
    'btn-toggle-settings',
    'btn-close-settings',
    'settings-panel',
    'setting-language',
    'setting-clipath',
    'setting-global-prompt',
    'btn-test-cli',
    'btn-save-settings',
    'cli-test-badge'
  ]);
  elements.canvas.querySelector = () => createElement('flow-line');

  elements['btn-toggle-settings'].listeners.click();

  assert.equal(elements['settings-panel'].style.display, 'flex');
  assert.ok(postedMessages.some((message) => message.command === 'getSettings'));

  elements['btn-toggle-roadmap-revision'].listeners.click();

  assert.ok(elements['roadmap-revision-panel'].classList.contains('open'));
  assert.ok(elements['roadmap-revision-body'].innerHTML.includes('data-roadmap-revision-input'));
  assert.ok(postedMessages.some((message) => message.command === 'getNodeConversations' && message.nodeId === '__roadmap_revision__'));
});

test('full roadmap webview exposes node conversation history and language setting', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    'module.exports.__getWebviewHtml = getWebviewHtml;'
  );
  const html = extensionModule.__getWebviewHtml(createWebviewStub(), { extensionPath: projectRoot, extensionUri: createUri(projectRoot) });
  const script = extractLastScript(html);

  assert.match(html, /id="setting-language"/);
  assert.match(html, /id="setting-global-prompt"/);
  assert.match(html, /id="btn-remove-project"/);
  assert.match(html, /removeProject/);
  assert.doesNotMatch(html, /id="setting-provider"/);
  assert.doesNotMatch(html, /id="setting-key"/);
  assert.doesNotMatch(html, /id="ai-prompt"/);
  assert.doesNotMatch(html, /id="btn-generate"/);
  assert.match(script, /getNodeConversations/);
  assert.match(script, /nodeConversationsLoaded/);
  assert.match(script, /Start Agent Conversation|发起 Agent 对话/);
  assert.match(script, /Agent Conversation History|Agent 对话历史/);
  assert.match(script, /conversationPlaceholder/);
  assert.match(script, /conversation-composer/);
  assert.match(script, /data-attach-node-id/);
  assert.match(script, /chooseSupplementFiles/);
  assert.match(script, /supplementFilesSelected/);
  assert.match(script, /conversation-attachment-chip/);
  assert.match(script, /data-send-node-id/);
  assert.match(script, /data-agent-select-id/);
  assert.match(script, /data-retry-conversation-id/);
  assert.match(script, /renderAgentOptions/);
  assert.match(script, /summarizeConversation/);
  assert.match(script, /retryConversation/);
  assert.match(script, /showAgentTerminal/);
  assert.match(script, /stopAgentRun/);
  assert.match(script, /formatConversationDuration/);
  assert.match(script, /renderConversationOutcome/);
  assert.match(script, /extractAgentConclusion/);
  assert.match(script, /Open terminal|打开终端/);
  assert.match(script, /Failure reason|失败原因/);
  assert.match(script, /runRoadmapRevision/);
  assert.match(script, /Roadmap Revision History|路线图调整历史/);
  assert.match(script, /No roadmap revisions yet|还没有路线图调整记录/);
  assert.match(script, /completionCriteria/);
  assert.match(script, /renderCompletionCriteria/);
  assert.match(script, /confirmStepCompletion/);
  assert.match(script, /Completion criteria|完成标准/);
  assert.match(html, /id="btn-toggle-roadmap-revision"/);
  assert.match(html, /id="roadmap-revision-panel"/);
  assert.match(html, /id="roadmap-revision-body"/);
  assert.match(script, /renderRoadmapRevisionPanel/);
  assert.doesNotMatch(script, /canvas\.appendChild\(panel\)/);
  assert.doesNotMatch(script, /data-toggle-roadmap-revision/);
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
    createUri(projectRoot),
    { getNodes: () => [] },
    async () => {},
    () => ({ cliPath: 'codex', language: 'zh' }),
    async () => {},
    () => ({ projects: [{ name: 'app', path: '/workspace/app' }], selectedProjectPath: '/workspace/app' }),
    async () => {},
    async () => {}
  );
  const html = provider._getHtmlForWebview(createWebviewStub());

  assert.match(html, /id="project-select"/);
  assert.match(html, /id="btn-add-project"/);
  assert.match(html, /id="portfolio-list"/);
  assert.doesNotMatch(html, /id="next-action-panel"/);
  assert.match(html, /getNextActionNode/);
  assert.match(html, /renderProjectContinueComposer/);
  assert.match(html, /data-project-continue-composer/);
  assert.match(html, /data-project-continue-send/);
  assert.match(html, /data-select-project-path/);
  assert.match(html, /selectProject/);
  assert.match(html, /continueProjectFromPortfolio/);
  assert.match(html, /openProjectFromPortfolio/);
  assert.doesNotMatch(html, /ai-prompt-sidebar/);
  assert.doesNotMatch(html, /btn-generate-sidebar/);
});

test('sidebar project portfolio summaries prioritize failed and in-progress work', () => {
  const sidebarModule = loadCompiledModule(
    'out/sidebarProvider.js',
    [
      'module.exports.__buildProjectPortfolioSummaries = buildProjectPortfolioSummaries;',
      'module.exports.__getRecommendedNode = getRecommendedNode;'
    ].join('\n')
  );

  const projectRootA = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-portfolio-a-'));
  const solopreneurA = path.join(projectRootA, '.solopreneur');
  fs.mkdirSync(solopreneurA, { recursive: true });
  fs.writeFileSync(path.join(solopreneurA, 'roadmap.csv'), [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '1,Brief,,商业规划,,agy,,Completed,2026-01-01T00:00:00.000Z,2026-01-01T00:10:00.000Z',
    '2,Build MVP,,产品与 MVP,1,agy,,Failed,2026-01-01T00:00:00.000Z,',
    '3,Launch,,营销与增长,2,agy,,Pending,2026-01-01T00:00:00.000Z,'
  ].join('\n'));

  const projectRootB = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-portfolio-b-'));
  const solopreneurB = path.join(projectRootB, '.solopreneur');
  fs.mkdirSync(solopreneurB, { recursive: true });
  fs.writeFileSync(path.join(solopreneurB, 'roadmap.csv'), [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '1,Plan,,商业规划,,agy,,Completed,2026-01-01T00:00:00.000Z,2026-01-01T00:10:00.000Z',
    '2,Implement,,产品与 MVP,1,agy,,In Progress,2026-01-01T00:00:00.000Z,',
    '3,Grow,,营销与增长,2,agy,,Pending,2026-01-01T00:00:00.000Z,'
  ].join('\n'));

  const summaries = sidebarModule.__buildProjectPortfolioSummaries([
    { name: 'Novel', path: projectRootA },
    { name: 'CRM', path: projectRootB }
  ]);

  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].failedNodes, 1);
  assert.equal(summaries[0].overallStatus, 'Failed');
  assert.equal(summaries[0].recommendedNodeTitle, 'Build MVP');
  assert.equal(summaries[0].recommendedStatus, 'Failed');
  assert.equal(summaries[0].progressPercent, 33);
  assert.equal(summaries[1].overallStatus, 'In Progress');
  assert.equal(summaries[1].recommendedNodeTitle, 'Implement');
  assert.equal(sidebarModule.__getRecommendedNode([
    { id: '1', title: 'Failed step', status: 'Failed', stage: '产品与 MVP', dependencies: '' },
    { id: '2', title: 'Running step', status: 'Running', stage: '产品与 MVP', dependencies: '' }
  ]).title, 'Running step');
});

test('agent command builder uses Codex exec and preserves Antigravity run path', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__buildAgentCommand = buildAgentCommand;',
      'module.exports.__buildAgentCommandForPromptFile = buildAgentCommandForPromptFile;',
      'module.exports.__buildAgentCommandFromShellVar = buildAgentCommandFromShellVar;',
      'module.exports.__buildAgentShellScript = buildAgentShellScript;',
      'module.exports.__buildAgentConversationPrompt = buildAgentConversationPrompt;',
      'module.exports.__buildRoadmapRevisionPrompt = buildRoadmapRevisionPrompt;',
      'module.exports.__buildRoadmapMethodologyInstructions = buildRoadmapMethodologyInstructions;',
      'module.exports.__getOutputTail = getOutputTail;',
      'module.exports.__buildRunHandoffEntry = buildRunHandoffEntry;',
      'module.exports.__buildBootstrapRoadmapInstructions = buildBootstrapRoadmapInstructions;',
      'module.exports.__parseStepHandoffEntries = parseStepHandoffEntries;',
      'module.exports.__buildStepHandoffSummary = buildStepHandoffSummary;',
      'module.exports.__updateStepHandoffSummary = updateStepHandoffSummary;',
      'module.exports.__readStepHandoffSummary = readStepHandoffSummary;',
      'module.exports.__buildSolopreneurDirectoryReadme = buildSolopreneurDirectoryReadme;',
      'module.exports.__buildCompletionCriteriaForNode = buildCompletionCriteriaForNode;',
      'module.exports.__ensureCompletionCriteriaForNodes = ensureCompletionCriteriaForNodes;',
      'module.exports.__readCompletionCriteria = readCompletionCriteria;',
      'module.exports.__getStepMemoryFilePath = getStepMemoryFilePath;',
      'module.exports.__getAgentCliCandidates = getAgentCliCandidates;',
      'module.exports.__getAgentProvider = getAgentProvider;',
      'module.exports.__getStepSessionFilePath = getStepSessionFilePath;',
      'module.exports.__readStepSessionState = readStepSessionState;',
      'module.exports.__getStoredAgentSession = getStoredAgentSession;',
      'module.exports.__updateStoredAgentSession = updateStoredAgentSession;',
      'module.exports.__clearStoredAgentSession = clearStoredAgentSession;',
      'module.exports.__extractUserSupplementFromExecutionOutput = extractUserSupplementFromExecutionOutput;',
      'module.exports.__buildLocalRoadmap = buildLocalRoadmap;',
      'module.exports.__validateBootstrapRoadmapRewrite = validateBootstrapRoadmapRewrite;',
      'module.exports.__validateRoadmapRevision = validateRoadmapRevision;',
      'module.exports.__processAgentStatusFile = processAgentStatusFile;',
      'module.exports.__shellQuote = shellQuote;'
    ].join('\n')
  );

  assert.equal(
    extensionModule.__buildAgentCommand('codex', 'Ship the MVP', '/workspace/app'),
    "'codex' exec --color always -C '/workspace/app' 'Ship the MVP'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('codex-cli', "Don't skip tests", '/workspace/app'),
    "'codex-cli' exec --color always -C '/workspace/app' 'Don'\\''t skip tests'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('codex', 'Continue the MVP', '/workspace/app', '019dc472-6a80-7c70-99a4-b2593a641d11'),
    "'codex' exec --color always -C '/workspace/app' 'Continue the MVP'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('antigravity-cli', 'Build landing page', '/workspace/app'),
    "'antigravity-cli' --print --add-dir='/workspace/app' 'Build landing page'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('agy', 'Build landing page', '/workspace/app'),
    "'agy' --print --add-dir='/workspace/app' 'Build landing page'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('agy', 'Continue landing page', '/workspace/app', '3350a3b7-7761-4ed5-9661-2e9c9de8f924'),
    "'agy' --print --add-dir='/workspace/app' 'Continue landing page'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('claude', 'Ship the MVP', '/workspace/app'),
    "'claude' -p --add-dir '/workspace/app' 'Ship the MVP'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('opencode', 'Ship the MVP', '/workspace/app'),
    "(cd '/workspace/app' && 'opencode' run 'Ship the MVP')"
  );
  assert.equal(
    extensionModule.__buildAgentCommandForPromptFile('agy', '/workspace/app/.solopreneur/agent-runs/2/prompt.txt', '/workspace/app'),
    "'agy' --print --add-dir='/workspace/app' @prompt-file:'/workspace/app/.solopreneur/agent-runs/2/prompt.txt'"
  );
  assert.equal(
    extensionModule.__buildAgentCommandForPromptFile('codex', '/workspace/app/.solopreneur/agent-runs/2/prompt.txt', '/workspace/app'),
    "cat '/workspace/app/.solopreneur/agent-runs/2/prompt.txt' | 'codex' exec --color always -C '/workspace/app' --skip-git-repo-check -"
  );
  assert.equal(
    extensionModule.__buildAgentCommandForPromptFile('claude', '/workspace/app/.solopreneur/agent-runs/2/prompt.txt', '/workspace/app'),
    "'claude' -p --add-dir '/workspace/app' \"$(cat '/workspace/app/.solopreneur/agent-runs/2/prompt.txt')\""
  );
  assert.equal(
    extensionModule.__buildAgentCommandForPromptFile('opencode', '/workspace/app/.solopreneur/agent-runs/2/prompt.txt', '/workspace/app'),
    "(cd '/workspace/app' && 'opencode' run \"$(cat '/workspace/app/.solopreneur/agent-runs/2/prompt.txt')\")"
  );
  assert.equal(
    extensionModule.__buildAgentCommandFromShellVar('codex', 'agent_prompt', '/workspace/app'),
    "printf %s \"$agent_prompt\" | 'codex' exec --color always -C '/workspace/app' --skip-git-repo-check -"
  );
  assert.equal(
    extensionModule.__buildAgentCommandFromShellVar('claude', 'agent_prompt', '/workspace/app'),
    "'claude' -p --add-dir '/workspace/app' \"$agent_prompt\""
  );
  assert.equal(
    extensionModule.__buildAgentCommandFromShellVar('opencode', 'agent_prompt', '/workspace/app'),
    "'opencode' run \"$agent_prompt\""
  );
  assert.equal(
    JSON.stringify(extensionModule.__getAgentCliCandidates('antigravity-cli', 'agy').slice(0, 4)),
    JSON.stringify(['agy', 'antigravity-cli', 'antigravity', 'codex'])
  );
  assert.equal(
    JSON.stringify(extensionModule.__getAgentCliCandidates('codex', 'codex').slice(0, 4)),
    JSON.stringify(['codex', 'codex-cli', 'agy', 'antigravity'])
  );
  assert.equal(
    JSON.stringify(extensionModule.__getAgentCliCandidates('claude', '').slice(0, 5)),
    JSON.stringify(['claude', 'claude-code', 'claude-code-cli', 'agy', 'antigravity'])
  );
  assert.equal(
    JSON.stringify(extensionModule.__getAgentCliCandidates('opencode', '').slice(0, 5)),
    JSON.stringify(['opencode', 'open-code', 'open-code-cli', 'agy', 'antigravity'])
  );
  assert.equal(extensionModule.__getAgentProvider('claude'), 'claude');
  assert.equal(extensionModule.__getAgentProvider('opencode'), 'opencode');

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
  assert.equal(
    JSON.stringify(sidebarModule.__getAgentCliCandidates('claude', '').slice(0, 5)),
    JSON.stringify(['claude', 'claude-code', 'claude-code-cli', 'agy', 'antigravity'])
  );
  assert.equal(
    JSON.stringify(sidebarModule.__getAgentCliCandidates('opencode', '').slice(0, 5)),
    JSON.stringify(['opencode', 'open-code', 'open-code-cli', 'agy', 'antigravity'])
  );
  assert.equal(JSON.stringify(sidebarModule.__getCliVersionArgs('agy')), JSON.stringify(['--version']));
  assert.match(sidebarModule.__formatCliTestMessage('agy', '1.0.1\n', ''), /agy · 1\.0\.1/);

  const shellRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-shell-'));
  const shellScript = extensionModule.__buildAgentShellScript(
    'codex',
    'Ship the MVP\nUse a small smoke test.',
    shellRoot,
    '2',
    42,
    'Use a small smoke test.'
  );
  assert.ok(shellScript.finalCommand.includes('run-agent.sh'));
  assert.ok(fs.existsSync(shellScript.runScriptPath));
  assert.ok(fs.existsSync(shellScript.promptFilePath));
  assert.ok(fs.existsSync(shellScript.commandFilePath));
  assert.match(fs.readFileSync(shellScript.commandFilePath, 'utf8'), /cat .*prompt\.txt.*codex' exec --color always -C .*--skip-git-repo-check -/);
  assert.match(fs.readFileSync(shellScript.promptFilePath, 'utf8'), /Ship the MVP/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /git -C/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /status --short/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /script -q -e -c/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /FORCE_COLOR/);
  assert.doesNotMatch(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /timed out waiting for response|Error: timed out/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /without project file changes or a completion decision/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /\.agent_status\.json/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /executionLogId/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /sessionFilePath/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /sessionMode/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /commandFilePath/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /\.codex\/sessions/);
  assert.doesNotMatch(shellScript.finalCommand, /Use a small smoke test\./);
  assert.doesNotMatch(shellScript.finalCommand, /Ship the MVP/);
  const coloredOutputPath = path.join(os.tmpdir(), 'solopreneur-colored-output.log');
  fs.writeFileSync(coloredOutputPath, '\u001b[32mDone\u001b[0m', 'utf8');
  assert.equal(extensionModule.__getOutputTail(coloredOutputPath), 'Done');
  assert.equal(typeof extensionModule.__processAgentStatusFile, 'function');

  const agyShellScript = extensionModule.__buildAgentShellScript(
    'agy',
    'Ship the MVP',
    fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-agy-shell-')),
    '2',
    43,
    ''
  );
  assert.match(fs.readFileSync(agyShellScript.runScriptPath, 'utf8'), /antigravity-cli\/cache\/last_conversations\.json/);
  assert.match(fs.readFileSync(agyShellScript.runScriptPath, 'utf8'), /antigravity-log/);

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
  assert.match(prompt, /必须先读取 SoloMap 为本环节保存的项目上下文文件/);
  assert.match(prompt, /\.solopreneur\/step-memory\/2\.json/);
  assert.match(prompt, /\.solopreneur\/agent-runs\/2/);
  assert.doesNotMatch(prompt, /\/workspace\/app\/\.solopreneur\/agent-runs\/2\/completion\.json/);
  assert.doesNotMatch(prompt, /该环节交接总结 JSON/);
  assert.doesNotMatch(prompt, /Created README and ran npm test/);
  assert.match(prompt, /markCompleted/);
  assert.match(prompt, /本环节完成标准/);
  assert.match(prompt, /MVP 或产品切片已经能被运行/);
  assert.match(prompt, /本轮交付和最终完成判断必须对照这些标准/);
  assert.match(prompt, /正常退出 CLI 进程/);
  assert.match(prompt, /唯一任务/);
  assert.match(prompt, /SoloMap/);

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

  const attachedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-attached-files-'));
  fs.mkdirSync(path.join(attachedRoot, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(attachedRoot, 'docs', 'brief.md'), 'Brief', 'utf8');
  const attachedPrompt = extensionModule.__buildAgentConversationPrompt(
    {
      title: 'Build onboarding',
      stage: '产品与 MVP',
      description: 'Create the first usable onboarding path.',
      agentPrompt: 'Implement the first slice.',
      status: 'In Progress'
    },
    'Use the attached brief.',
    attachedRoot,
    path.join(attachedRoot, '.solopreneur', 'step-memory', '2.json'),
    path.join(attachedRoot, '.solopreneur', 'agent-runs', '2'),
    path.join(attachedRoot, '.solopreneur', 'agent-runs', '2', 'completion.json'),
    '',
    ['docs/brief.md', '../outside.md'],
    'Always preserve public API compatibility.'
  );
  assert.match(attachedPrompt, /用户为本次对话选择了补充文件/);
  assert.match(attachedPrompt, /docs\/brief\.md/);
  assert.doesNotMatch(attachedPrompt, /\.\.\/outside\.md/);
  assert.match(attachedPrompt, /用户设置的全局默认要求/);
  assert.match(attachedPrompt, /Always preserve public API compatibility/);
  assert.match(attachedPrompt, /本次用户补充为准/);
  assert.match(attachedPrompt, /本环节完成标准/);
  assert.match(followupPrompt, /\.solopreneur\/agent-runs\/2/);
  assert.doesNotMatch(followupPrompt, /\/workspace\/app\/\.solopreneur\/agent-runs\/2\/completion\.json/);
  assert.doesNotMatch(followupPrompt, /该环节交接总结 JSON/);
  assert.doesNotMatch(followupPrompt, /Old handoff should not be injected/);
  assert.doesNotMatch(followupPrompt, /继续当前路线图环节的原生 Agent 会话/);

  const revisionPrompt = extensionModule.__buildRoadmapRevisionPrompt(
    '将发布准备提前，并增加支付验证环节。',
    '/workspace/app',
    'Always run focused checks.'
  );
  assert.match(revisionPrompt, /本次路线图调整要求（最高优先级）/);
  assert.match(revisionPrompt, /将发布准备提前，并增加支付验证环节/);
  assert.match(revisionPrompt, /直接更新项目目录中的 `\.solopreneur\/roadmap\.csv`/);
  assert.match(revisionPrompt, /不要把本段提示词、解释文字或执行日志写进 CSV/);
  assert.match(revisionPrompt, /Always run focused checks/);

  const criteriaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-criteria-'));
  const criteriaNodes = extensionModule.__ensureCompletionCriteriaForNodes(criteriaRoot, [{
    id: '2',
    title: '构建第一个可用 MVP 切片',
    stage: '产品与 MVP',
    description: '完成第一个可验证产品路径。',
    dependencies: '1',
    agentCli: 'codex',
    agentPrompt: '实现 MVP 并运行 npm test。',
    status: 'Pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: ''
  }]);
  assert.ok(Array.isArray(criteriaNodes[0].completionCriteria));
  assert.ok(criteriaNodes[0].completionCriteria.length >= 3);
  const criteriaFilePath = extensionModule.__getStepMemoryFilePath(criteriaRoot, '2');
  assert.ok(fs.existsSync(criteriaFilePath));
  const criteriaFile = JSON.parse(fs.readFileSync(criteriaFilePath, 'utf8'));
  assert.ok(criteriaFile.completionCriteria.some((line) => /MVP|产品切片/.test(line)));
  assert.ok(Array.isArray(criteriaFile.entries));
  assert.equal(
    JSON.stringify(extensionModule.__readCompletionCriteria(criteriaRoot, criteriaNodes[0])),
    JSON.stringify(criteriaFile.completionCriteria)
  );

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
  const noopRun = extensionModule.__buildAgentShellScript('agy', 'printf ok', tempRoot, 'noop', 7, '', undefined, '', 'printf ok');
  childProcess.execSync(noopRun.finalCommand, { cwd: tempRoot, stdio: 'ignore' });
  const noopStatus = JSON.parse(fs.readFileSync(path.join(tempRoot, '.agent_status.json'), 'utf8'));
  assert.equal(noopStatus.status, 'Failed');
  assert.equal(noopStatus.failureCode, 'no_deliverable_changes');
  assert.match(noopStatus.failureReason, /without project file changes/);
  assert.match(noopStatus.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(fs.readFileSync(noopRun.outputFilePath, 'utf8'), /without project file changes/);

  const writeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-write-agent-'));
  fs.mkdirSync(path.join(writeRoot, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(writeRoot, '.solopreneur', 'roadmap.csv'), 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n', 'utf8');
  const writeCommand = `node -e ${extensionModule.__shellQuote('const fs=require("fs"); fs.appendFileSync(".solopreneur/roadmap.csv","1,Init,,问题与客户发现,,codex,Prompt,Pending,2026-01-01T00:00:00.000Z,\\n");')}`;
  const writeRun = extensionModule.__buildAgentShellScript('codex', writeCommand, writeRoot, 'write', 8, '', undefined, '', writeCommand);
  childProcess.execSync(writeRun.finalCommand, { cwd: writeRoot, stdio: 'ignore' });
  const touchedFiles = fs.readFileSync(path.join(writeRoot, '.solopreneur/agent-runs/write/touched-files.txt'), 'utf8');
  assert.match(touchedFiles, /[AM] \.solopreneur\/roadmap\.csv/);

  const invalidBootstrapRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-bootstrap-invalid-'));
  fs.mkdirSync(path.join(invalidBootstrapRoot, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(invalidBootstrapRoot, '.solopreneur', 'roadmap.csv'), [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '1,生成初始路线图,desc,问题与客户发现,,agy,"你的唯一主任务是直接重写 .solopreneur/roadmap.csv",Pending,2026-01-01T00:00:00.000Z,'
  ].join('\n'));
  const invalidBootstrap = extensionModule.__validateBootstrapRoadmapRewrite(invalidBootstrapRoot, '1');
  assert.equal(invalidBootstrap.valid, false);
  assert.match(invalidBootstrap.reason, /环节数量不在 4 到 6 个之间|残留了初始化提示词|保留了原始 bootstrap 节点/);

  const validBootstrapRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-bootstrap-valid-'));
  fs.mkdirSync(path.join(validBootstrapRoot, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(validBootstrapRoot, '.solopreneur', 'roadmap.csv'), [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '10,梳理目标客户,整理 ICP 与定价假设,问题与客户发现,,agy,创建 docs/icp.md 并补充访谈假设,Pending,2026-01-01T00:00:00.000Z,',
    '20,实现首个 MVP 切片,完成最小闭环,产品与 MVP,10,agy,修改 src/app.js 并运行 npm test,Pending,2026-01-01T00:00:00.000Z,',
    '30,准备首轮外联,输出外联材料,营销与销售,20,agy,创建 outreach/email.md 并校验文案,Pending,2026-01-01T00:00:00.000Z,',
    '40,建立反馈循环,整理反馈和改进任务,反馈与规模化,30,agy,创建 docs/learning-loop.md 并记录指标,Pending,2026-01-01T00:00:00.000Z,'
  ].join('\n'));
  const validBootstrap = extensionModule.__validateBootstrapRoadmapRewrite(validBootstrapRoot, '1');
  assert.equal(validBootstrap.valid, true);

  fs.writeFileSync(path.join(validBootstrapRoot, '.solopreneur', 'roadmap.csv'), [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '10,梳理目标客户,整理 ICP 与定价假设,问题与客户发现,,agy,创建 docs/icp.md 并补充访谈假设,Pending,2026-01-01T00:00:00.000Z,',
    '30,实现首个 MVP 切片,完成最小闭环,产品与 MVP,20,agy,修改 src/app.js 并运行 npm test,Pending,2026-01-01T00:00:00.000Z,',
    '40,准备首轮外联,输出外联材料,营销与销售,30,agy,创建 outreach/email.md 并校验文案,Pending,2026-01-01T00:00:00.000Z,',
    '50,准备第二轮外联,补充销售材料,营销与销售,40,agy,创建 outreach/follow-up.md 并校验文案,Pending,2026-01-01T00:00:00.000Z,'
  ].join('\n'));
  assert.equal(extensionModule.__validateBootstrapRoadmapRewrite(validBootstrapRoot, '1').valid, false);
  assert.match(extensionModule.__validateBootstrapRoadmapRewrite(validBootstrapRoot, '1').reason, /缺少方法论阶段/);

  fs.writeFileSync(path.join(validBootstrapRoot, '.solopreneur', 'roadmap.csv'), [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '10,梳理目标客户,整理 ICP 与定价假设,问题与客户发现,,agy,创建 docs/icp.md 并补充访谈假设,Pending,2026-01-01T00:00:00.000Z,',
    '20,实现首个 MVP 切片,完成最小闭环,产品与 MVP,10,agy,修改 src/app.js 并运行 npm test,Pending,2026-01-01T00:00:00.000Z,',
    '30,准备首轮外联,输出外联材料,营销与销售,20,agy,创建 outreach/email.md 并校验文案,Pending,2026-01-01T00:00:00.000Z,',
    '40,建立反馈循环,整理反馈和改进任务,反馈与规模化,30,agy,创建 docs/learning-loop.md 并记录指标,Pending,2026-01-01T00:00:00.000Z,'
  ].join('\n'));

  assert.equal(extensionModule.__validateRoadmapRevision(validBootstrapRoot).valid, true);
  fs.writeFileSync(path.join(validBootstrapRoot, '.solopreneur', 'roadmap.csv'), [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '10,梳理目标客户,整理 ICP,问题与客户发现,99,agy,创建 docs/icp.md,Pending,2026-01-01T00:00:00.000Z,',
    '20,实现 MVP,完成切片,产品与 MVP,10,agy,修改 src/app.js,Pending,2026-01-01T00:00:00.000Z,',
    '30,准备外联,输出材料,营销与销售,20,agy,创建 outreach/email.md,Pending,2026-01-01T00:00:00.000Z,',
    '40,建立反馈,记录指标,反馈与规模化,30,agy,创建 docs/learning-loop.md,Pending,2026-01-01T00:00:00.000Z,'
  ].join('\n'));
  assert.match(extensionModule.__validateRoadmapRevision(validBootstrapRoot).reason, /无效依赖/);

  const dataReadme = extensionModule.__buildSolopreneurDirectoryReadme();
  const bootstrapInstructions = extensionModule.__buildBootstrapRoadmapInstructions('codex');
  const methodologyInstructions = extensionModule.__buildRoadmapMethodologyInstructions();
  assert.match(dataReadme, /SoloMap Project Data/);
  assert.match(dataReadme, /roadmap\.csv/);
  assert.match(dataReadme, /step-memory/);
  assert.match(dataReadme, /完成标准/);
  assert.match(dataReadme, /step-sessions/);
  assert.match(dataReadme, /project_journal\.db/);
  assert.match(dataReadme, /Git\/GitHub/);
  assert.match(bootstrapInstructions, /Bootstrap Roadmap Instructions/);
  assert.match(bootstrapInstructions, /roadmap-methodology\.md/);
  assert.match(bootstrapInstructions, /不要把本文件内容、提示词模板或解释性说明写回 CSV/);
  assert.match(methodologyInstructions, /发现问题 -> 打造产品 -> 卖给客户 -> 持续改进/);
  assert.match(methodologyInstructions, /完成标准判断/);
});

test('failed conversations render retry action in roadmap webview', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    'module.exports.__getWebviewHtml = getWebviewHtml;'
  );
  const html = extensionModule.__getWebviewHtml(createWebviewStub(), { extensionPath: projectRoot, extensionUri: createUri(projectRoot) });

  assert.match(html, /conversation-retry-btn/);
  assert.match(html, /Retry|重试/);
  assert.match(html, /retryConversation/);
  assert.match(html, /data-open-file-path/);
  assert.match(html, /openProjectFile/);
  assert.match(html, /修改文件|Changed Files/);
  assert.match(html, /conversation-control-btn/);
  assert.match(html, /data-show-agent-terminal/);
  assert.match(html, /data-stop-agent-run/);
  assert.match(html, /Run result|本轮结果/);
  assert.match(html, /Agent conclusion|Agent 结论/);
});

test('local roadmap fallback produces runnable dependent tasks', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    'module.exports.__buildLocalRoadmap = buildLocalRoadmap;'
  );
  const nodes = extensionModule.__buildLocalRoadmap('AI CRM for freelancers', 'codex');

  assert.equal(nodes.length, 5);
  assert.equal(nodes[0].dependencies, '');
  assert.equal(nodes[1].dependencies, '1');
  assert.equal(nodes[2].dependencies, '2');
  assert.equal(nodes[3].dependencies, '3');
  assert.equal(nodes[4].dependencies, '4');
  assert.ok(nodes.every((node) => node.agentCli === 'codex'));
  assert.match(nodes[0].title, /生成初始路线图/);
  assert.match(nodes[0].agentPrompt, /\.solopreneur\/bootstrap-roadmap-instructions\.md/);
  assert.doesNotMatch(nodes[0].agentPrompt, /字段顺序必须严格是/);
  assert.ok(nodes.some((node) => node.agentPrompt.includes('docs/problem-discovery.md')));
  assert.deepEqual([...new Set(nodes.map((node) => node.stage))], ['问题与客户发现', '产品与 MVP', '营销与销售', '反馈与规模化']);
});

test('roadmap csv generated by an agent is not overwritten by stale node state', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__processAgentStatusFile = processAgentStatusFile;',
      'module.exports.__setRuntimeForTest = (engine, projectRoot) => { syncEngine = engine; activeProjectRoot = projectRoot; };'
    ].join('\n')
  );

  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-roadmap-sync-'));
  const solopreneurDir = path.join(projectRoot, '.solopreneur');
  const runDir = path.join(solopreneurDir, 'agent-runs', '1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(solopreneurDir, 'roadmap.csv'), [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '10,梳理目标客户,整理 ICP 与定价假设,问题与客户发现,,codex,创建 docs/icp.md 并补充访谈假设,Pending,2026-01-01T00:00:00.000Z,',
    '20,实现首个 MVP 切片,完成最小闭环,产品与 MVP,10,codex,修改 src/app.js 并运行 npm test,Pending,2026-01-01T00:00:00.000Z,',
    '30,准备首轮外联,输出外联材料,营销与销售,20,codex,创建 outreach/email.md 并校验文案,Pending,2026-01-01T00:00:00.000Z,',
    '40,建立反馈循环,整理反馈和改进任务,反馈与规模化,30,codex,创建 docs/learning-loop.md 并记录指标,Pending,2026-01-01T00:00:00.000Z,'
  ].join('\n'));
  fs.writeFileSync(path.join(runDir, 'changes.txt'), 'M .solopreneur/roadmap.csv\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'touched-files.txt'), 'M .solopreneur/roadmap.csv\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'output.log'), 'Codex updated roadmap.csv\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'command.txt'), 'codex exec\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'completion.json'), '{"markCompleted":true,"reason":"路线图已生成"}', 'utf8');
  const statusFilePath = path.join(projectRoot, '.agent_status.json');
  fs.writeFileSync(statusFilePath, JSON.stringify({
    nodeId: '1',
    status: 'In Progress',
    agentCli: 'codex',
    commandFilePath: path.join(runDir, 'command.txt'),
    executionLogId: 1,
    userMessage: '',
    outputFilePath: path.join(runDir, 'output.log'),
    changesFilePath: path.join(runDir, 'changes.txt'),
    touchedFilesPath: path.join(runDir, 'touched-files.txt'),
    completionDecisionFilePath: path.join(runDir, 'completion.json'),
    sessionMode: 'fresh'
  }), 'utf8');

  let initAndSyncCalled = false;
  extensionModule.__setRuntimeForTest({
    getNodes: () => [{
      id: '1',
      title: '生成初始路线图',
      description: 'starter',
      stage: '问题与客户发现',
      dependencies: '',
      agentCli: 'codex',
      agentPrompt: '阅读 .solopreneur/bootstrap-roadmap-instructions.md',
      status: 'Running',
      createdAt: '',
      completedAt: ''
    }],
    updateNode: () => {
      throw new Error('stale node state must not be written back over an agent-generated roadmap.csv');
    },
    initAndSync: async () => {
      initAndSyncCalled = true;
    },
    updateAgentExecution: () => true,
    logAgentExecution: () => 1,
    getAgentExecutions: () => []
  }, projectRoot);

  await extensionModule.__processAgentStatusFile(statusFilePath);
  fs.writeFileSync(statusFilePath, JSON.stringify({
    nodeId: '10',
    status: 'Running',
    executionLogId: 2
  }), 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const finalCsv = fs.readFileSync(path.join(solopreneurDir, 'roadmap.csv'), 'utf8');
  assert.equal(initAndSyncCalled, true);
  assert.match(finalCsv, /梳理目标客户/);
  assert.doesNotMatch(finalCsv, /生成初始路线图/);
  assert.doesNotMatch(finalCsv, /bootstrap-roadmap-instructions/);
  assert.equal(JSON.parse(fs.readFileSync(statusFilePath, 'utf8')).executionLogId, 2);
});

test('invalid Agent completion state is recorded as a visible failed conversation', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__processAgentStatusFile = processAgentStatusFile;',
      'module.exports.__setRuntimeForTest = (engine, projectRoot) => { syncEngine = engine; activeProjectRoot = projectRoot; };'
    ].join('\n')
  );
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-invalid-completion-'));
  const runDir = path.join(tempRoot, '.solopreneur', 'agent-runs', '2');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'completion.json'), '{broken-json', 'utf8');
  fs.writeFileSync(path.join(runDir, 'changes.txt'), 'M docs/work.md\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'touched-files.txt'), 'M docs/work.md\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'output.log'), 'Implemented a working draft.\n', 'utf8');
  const statusFilePath = path.join(tempRoot, '.agent_status.json');
  fs.writeFileSync(statusFilePath, JSON.stringify({
    nodeId: '2',
    status: 'In Progress',
    agentCli: 'codex',
    executionLogId: 9,
    outputFilePath: path.join(runDir, 'output.log'),
    changesFilePath: path.join(runDir, 'changes.txt'),
    touchedFilesPath: path.join(runDir, 'touched-files.txt'),
    completionDecisionFilePath: path.join(runDir, 'completion.json'),
    startedAt: '2026-05-24T00:00:00.000Z'
  }), 'utf8');

  let nodeUpdate = null;
  let loggedOutput = '';
  let loggedStatus = '';
  extensionModule.__setRuntimeForTest({
    getNodes: () => [{ id: '2', title: '实现 MVP', status: 'Running' }],
    updateNode: (_nodeId, update) => { nodeUpdate = update; },
    updateAgentExecution: (_id, _cli, _command, output, status) => {
      loggedOutput = output;
      loggedStatus = status;
      return true;
    },
    logAgentExecution: () => 1,
    getAgentExecutions: () => []
  }, tempRoot);

  await extensionModule.__processAgentStatusFile(statusFilePath);

  assert.equal(nodeUpdate.status, 'Failed');
  assert.equal(loggedStatus, 'Failed');
  assert.match(loggedOutput, /Failure category: completion_state_invalid/);
  assert.match(loggedOutput, /Failure reason:\nAgent completion decision file could not be parsed/);
});

test('roadmap revision accepts valid CSV updates and restores the previous roadmap after invalid output', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__processAgentStatusFile = processAgentStatusFile;',
      'module.exports.__setRuntimeForTest = (engine, projectRoot) => { syncEngine = engine; activeProjectRoot = projectRoot; };'
    ].join('\n')
  );
  const createRevisionRun = (suffix, revisedCsv) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `solopreneur-revision-${suffix}-`));
    const solopreneurDir = path.join(root, '.solopreneur');
    const runDir = path.join(solopreneurDir, 'agent-runs', 'roadmap-revision');
    fs.mkdirSync(runDir, { recursive: true });
    const originalCsv = [
      'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
      '1,Original step,Keep existing work,规划,,codex,Continue original work,In Progress,2026-01-01T00:00:00.000Z,'
    ].join('\n');
    fs.writeFileSync(path.join(solopreneurDir, 'roadmap.csv'), revisedCsv, 'utf8');
    fs.writeFileSync(path.join(runDir, 'roadmap-before.csv'), originalCsv, 'utf8');
    fs.writeFileSync(path.join(runDir, 'changes.txt'), 'M .solopreneur/roadmap.csv\n', 'utf8');
    fs.writeFileSync(path.join(runDir, 'touched-files.txt'), 'M .solopreneur/roadmap.csv\n', 'utf8');
    fs.writeFileSync(path.join(runDir, 'output.log'), 'Updated the roadmap for the new priority.\n', 'utf8');
    const statusPath = path.join(root, '.agent_status.json');
    fs.writeFileSync(statusPath, JSON.stringify({
      nodeId: '__roadmap_revision__',
      runKind: 'roadmap_revision',
      roadmapBackupFilePath: path.join(runDir, 'roadmap-before.csv'),
      status: 'In Progress',
      agentCli: 'codex',
      executionLogId: suffix === 'valid' ? 31 : 32,
      outputFilePath: path.join(runDir, 'output.log'),
      changesFilePath: path.join(runDir, 'changes.txt'),
      touchedFilesPath: path.join(runDir, 'touched-files.txt'),
      startedAt: '2026-05-24T00:00:00.000Z'
    }), 'utf8');
    return { root, statusPath, originalCsv };
  };
  const validCsv = [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '1,Validate customer problem,Keep existing discovery,问题与客户发现,,codex,Create docs/problem-discovery.md,Completed,2026-01-01T00:00:00.000Z,2026-05-24T00:00:00.000Z',
    '2,Validate payment MVP,Confirm checkout direction,产品与 MVP,1,codex,Create a payment validation plan,Pending,2026-05-24T00:00:00.000Z,',
    '3,Prepare checkout launch,Write launch message,营销与销售,2,codex,Create docs/launch-message.md,Pending,2026-05-24T00:00:00.000Z,',
    '4,Create learning loop,Track feedback and metrics,反馈与规模化,3,codex,Create docs/learning-loop.md,Pending,2026-05-24T00:00:00.000Z,'
  ].join('\n');
  const validRun = createRevisionRun('valid', validCsv);
  let validStatus = '';
  let validOutput = '';
  let validRefresh = false;
  extensionModule.__setRuntimeForTest({
    getNodes: () => [],
    updateNode: () => { throw new Error('roadmap revision is not a roadmap step'); },
    updateAgentExecution: (_id, _cli, _command, output, status) => {
      validOutput = output;
      validStatus = status;
      return true;
    },
    logAgentExecution: () => 31,
    getAgentExecutions: () => [],
    initAndSync: async () => { validRefresh = true; }
  }, validRun.root);

  await extensionModule.__processAgentStatusFile(validRun.statusPath);
  assert.equal(validStatus, 'Completed');
  assert.equal(validRefresh, true);
  assert.match(validOutput, /路线图已按本次要求更新并通过校验/);
  assert.equal(fs.readFileSync(path.join(validRun.root, '.solopreneur', 'roadmap.csv'), 'utf8'), validCsv);

  const invalidRun = createRevisionRun('invalid', [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '2,Broken dependency,Cannot proceed,产品,404,codex,Try work,Pending,2026-05-24T00:00:00.000Z,'
  ].join('\n'));
  let invalidStatus = '';
  let invalidOutput = '';
  extensionModule.__setRuntimeForTest({
    getNodes: () => [],
    updateNode: () => { throw new Error('invalid roadmap revision must not become a node update'); },
    updateAgentExecution: (_id, _cli, _command, output, status) => {
      invalidOutput = output;
      invalidStatus = status;
      return true;
    },
    logAgentExecution: () => 32,
    getAgentExecutions: () => []
  }, invalidRun.root);

  await extensionModule.__processAgentStatusFile(invalidRun.statusPath);
  assert.equal(invalidStatus, 'Failed');
  assert.match(invalidOutput, /Failure category: roadmap_validation_failed/);
  assert.match(invalidOutput, /已保留调整前的路线图/);
  assert.equal(fs.readFileSync(path.join(invalidRun.root, '.solopreneur', 'roadmap.csv'), 'utf8'), invalidRun.originalCsv);

  const stoppedRun = createRevisionRun('stopped', validCsv);
  const stoppedStatusData = JSON.parse(fs.readFileSync(stoppedRun.statusPath, 'utf8'));
  fs.writeFileSync(stoppedRun.statusPath, JSON.stringify({
    ...stoppedStatusData,
    status: 'Failed',
    failureCode: 'stopped_by_user',
    failureReason: 'Stopped by user.'
  }), 'utf8');
  let stoppedOutput = '';
  extensionModule.__setRuntimeForTest({
    getNodes: () => [],
    updateNode: () => { throw new Error('stopped roadmap revision must not become a node update'); },
    updateAgentExecution: (_id, _cli, _command, output) => {
      stoppedOutput = output;
      return true;
    },
    logAgentExecution: () => 33,
    getAgentExecutions: () => []
  }, stoppedRun.root);

  await extensionModule.__processAgentStatusFile(stoppedRun.statusPath);
  assert.match(stoppedOutput, /Failure category: stopped_by_user/);
  assert.match(stoppedOutput, /Stopped by user\. 已保留调整前的路线图。/);
  assert.equal(fs.readFileSync(path.join(stoppedRun.root, '.solopreneur', 'roadmap.csv'), 'utf8'), stoppedRun.originalCsv);
});

test('stopping an Agent run records the user decision on the active conversation', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__stopAgentRun = stopAgentRun;',
      'module.exports.__setRuntimeForTest = (engine, projectRoot) => { syncEngine = engine; activeProjectRoot = projectRoot; };'
    ].join('\n')
  );
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-stop-run-'));
  const runDir = path.join(tempRoot, '.solopreneur', 'agent-runs', '3');
  fs.mkdirSync(runDir, { recursive: true });
  const outputFilePath = path.join(runDir, 'output.log');
  fs.writeFileSync(outputFilePath, 'Working on the task.\n', 'utf8');
  fs.writeFileSync(path.join(tempRoot, '.agent_status.json'), JSON.stringify({
    nodeId: '3',
    status: 'Running',
    executionLogId: 11,
    agentCli: 'codex',
    outputFilePath,
    startedAt: '2026-05-24T00:00:00.000Z'
  }), 'utf8');
  let updatedStatus = '';
  let updatedOutput = '';
  extensionModule.__setRuntimeForTest({
    getNodes: () => [{ id: '3', title: '完善体验', status: 'Running' }],
    updateNode: () => {},
    getAgentExecutions: () => [{ id: 11, nodeId: '3', agentCli: 'codex', command: 'codex exec', output: 'Agent conversation started.', status: 'Running' }],
    updateAgentExecution: (_id, _cli, _command, output, status) => {
      updatedOutput = output;
      updatedStatus = status;
      return true;
    },
    logAgentExecution: () => 11
  }, tempRoot);

  await extensionModule.__stopAgentRun('3', 11);

  assert.equal(updatedStatus, 'Failed');
  assert.match(updatedOutput, /Failure category: stopped_by_user/);
  assert.match(fs.readFileSync(outputFilePath, 'utf8'), /Task stopped by user/);
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
