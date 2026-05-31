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
            showWarningMessage() {},
            showErrorMessage() {},
            createTerminal() {
              return {
                name: 'SoloMap Agent Console · test',
                show() {},
                sendText() {},
                dispose() {}
              };
            }
          },
          workspace: {
            getConfiguration() {
              return {
                get() {
                  return '';
                }
              };
            }
          },
          ThemeIcon: class ThemeIcon {},
          ThemeColor: class ThemeColor {}
        };
      }
      if (id.startsWith('./')) {
        return {};
      }
      return require(id);
    },
    console,
    process,
    URL,
    Buffer,
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
    attributes: {},
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
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
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

  function wireSoloSelect(element, choices) {
    if (!element) return;
    const trigger = createElement(`${element.id}-trigger`);
    const label = createElement(`${element.id}-label`);
    const menu = createElement(`${element.id}-menu`);
    let options = choices.map(({ value, label: text }) => {
      const option = createElement(`${element.id}-${value}`);
      option.setAttribute('data-solo-option-value', value);
      option.textContent = text;
      option.closest = (selector) => selector === '[data-solo-option-value]' ? option : null;
      return option;
    });
    Object.defineProperty(menu, 'innerHTML', {
      set(value) {
        this._innerHTML = value;
        options = [...String(value).matchAll(/data-solo-option-value="([^"]+)"[^>]*>([^<]*)<\/button>/g)]
          .map((match) => {
            const option = createElement(`${element.id}-${match[1]}`);
            option.setAttribute('data-solo-option-value', match[1]);
            option.textContent = match[2];
            option.closest = (selector) => selector === '[data-solo-option-value]' ? option : null;
            return option;
          });
        element.__options = options;
      },
      get() {
        return this._innerHTML || '';
      }
    });
    trigger.closest = (selector) => selector === '[data-solo-trigger]' ? trigger : null;
    element.setAttribute('data-value', choices[0]?.value || '');
    element.querySelector = (selector) => {
      if (selector === '[data-solo-trigger]') return trigger;
      if (selector === '[data-solo-label]') return label;
      if (selector === '[data-solo-menu]') return menu;
      return null;
    };
    element.querySelectorAll = (selector) => selector === '[data-solo-option-value]' ? options : [];
    element.__options = options;
  }

  wireSoloSelect(elements['setting-language'], [
    { value: 'zh', label: '中文' },
    { value: 'en', label: 'English' }
  ]);
  wireSoloSelect(elements['setting-cli-select'], [
    { value: 'agy', label: 'agy' },
    { value: 'codex', label: 'codex' },
    { value: 'cursor', label: 'cursor' },
    { value: 'copilot', label: 'copilot' },
    { value: 'claude', label: 'claude' },
    { value: 'opencode', label: 'opencode' },
    { value: 'custom', label: 'Custom...' }
  ]);
  wireSoloSelect(elements['project-select'], []);
  const context = {
    document: {
      getElementById: (id) => elements[id] || null,
      createElement,
      querySelectorAll() {
        return [];
      },
      addEventListener() {}
    },
    window: {
      addEventListener(type, listener) {
        if (type === 'message') {
          context.__messageListener = listener;
        }
      }
    },
    acquireVsCodeApi: () => ({
      postMessage: (message) => postedMessages.push(message)
    })
  };

  vm.runInNewContext(script, context);
  return {
    elements,
    postedMessages,
    dispatchMessage(message) {
      context.__messageListener({ data: message });
    }
  };
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

test('pasted image attachments are saved as project-relative SoloMap files', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    'module.exports.__savePastedImageAttachments = savePastedImageAttachments;'
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-pasted-attachment-'));
  const files = extensionModule.__savePastedImageAttachments(root, 'step:1', [{
    name: 'clipboard.png',
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,aGVsbG8='
  }]);

  assert.equal(files.length, 1);
  assert.match(files[0], /^\.solopreneur\/attachments\/step-1\/.+\.png$/);
  assert.equal(fs.readFileSync(path.join(root, files[0]), 'utf8'), 'hello');
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
  assert.doesNotMatch(html, /<select\b|<option\b/);
  assert.match(html, /data-solo-select/);
  assert.match(script, /bindSoloSelect/);
  assert.match(script, /bindPastedImageAttachments/);
  assert.match(script, /savePastedAttachments/);
  assert.match(script, /checkDependencies/);
  assert.match(script, /openFeedbackIssue/);
  assert.match(script, /renderProjectIssuePanel/);
  assert.match(script, /createIssue/);
  assert.match(script, /closeIssue/);
  assert.match(script, /getIssueDetails/);
  assert.match(html, /id="dependency-panel"/);
  assert.match(html, /data-issue-panel/);
  assert.match(html, /data-toggle-issue-form/);

  const { elements, postedMessages, dispatchMessage } = runScriptWithMinimalDom(script, [
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
    'setting-cli-select',
    'setting-clipath-custom',
    'setting-global-prompt',
    'setting-global-data-path',
    'setting-feedback-title',
    'setting-feedback-body',
    'btn-open-feedback',
    'btn-test-cli',
    'btn-save-settings',
    'btn-check-dependencies',
    'btn-open-agent-install',
    'btn-open-agent-check',
    'btn-open-github-auth',
    'dependency-agent-status',
    'dependency-agent-message',
    'dependency-github-status',
    'dependency-github-message',
    'cli-test-badge'
  ]);

  elements['btn-toggle-settings'].listeners.click();
  assert.equal(elements['settings-panel'].style.display, 'block');
  elements['setting-language'].listeners.click({
    target: elements['setting-language'].__options[1],
    stopPropagation() {}
  });
  elements['setting-global-data-path'].value = '/workspace/.solomap-global';
  elements['btn-save-settings'].listeners.click();

  assert.equal(elements['settings-panel'].style.display, 'none');
  assert.ok(postedMessages.some((message) => message.command === 'getSettings'));
  assert.ok(postedMessages.some((message) => message.command === 'updateSettings' && message.language === 'en' && message.globalDataPath === '/workspace/.solomap-global'));
  elements['btn-check-dependencies'].listeners.click();
  elements['btn-open-agent-install'].listeners.click();
  elements['btn-open-github-auth'].listeners.click();
  elements['setting-feedback-title'].value = '希望加载更快';
  elements['setting-feedback-body'].value = '打开侧边栏时先显示项目。';
  elements['btn-open-feedback'].listeners.click();
  assert.ok(postedMessages.some((message) => message.command === 'checkDependencies'));
  assert.ok(postedMessages.some((message) => message.command === 'openDependencyAction' && message.action === 'agent-install'));
  assert.ok(postedMessages.some((message) => message.command === 'openDependencyAction' && message.action === 'github-auth'));
  assert.ok(postedMessages.some((message) => message.command === 'openFeedbackIssue' && message.title === '希望加载更快'));

  dispatchMessage({
    command: 'settingsLoaded',
    settings: { cliPath: 'copilot', language: 'zh', globalPrompt: '', globalDataPath: '/workspace/.solomap-global' }
  });

  dispatchMessage({
    command: 'projectsLoaded',
    projects: {
      projects: [{ name: 'app', path: '/workspace/app' }, { name: 'second', path: '/workspace/second' }],
      selectedProjectPath: '/workspace/second',
      portfolio: [{
        name: 'second',
        path: '/workspace/second',
        totalNodes: 1,
        completedNodes: 0,
        failedNodes: 0,
        runningNodes: 0,
        inProgressNodes: 0,
        pendingNodes: 1,
        progressPercent: 0,
        currentStage: '产品',
        recommendedNodeId: 'step-1',
        recommendedNodeTitle: '验证首页',
        recommendedStatus: 'Pending',
        overallStatus: 'Pending',
        recentActivityAt: '2026-05-26T10:00:00.000Z',
        issues: {
          available: true,
          repo: 'owner/repo',
          total: 3,
          open: 2,
          byCategory: { bug: 1, 'feature-request': 1 },
          byPriority: { P0: 1 },
          items: [{ number: 12, title: '页面加载慢', state: 'OPEN', category: 'bug', priority: 'P0', comments: 4, thumbsUp: 2, url: 'https://github.com/owner/repo/issues/12' }],
          message: ''
        }
      }]
    }
  });
  assert.match(elements['portfolio-list'].innerHTML, /data-project-continue-composer/);
  assert.match(elements['portfolio-list'].innerHTML, /data-issue-panel/);
  assert.match(elements['portfolio-list'].innerHTML, /data-toggle-issue-panel/);
  assert.doesNotMatch(elements['portfolio-list'].innerHTML, /页面加载慢/);
  assert.match(elements['portfolio-list'].innerHTML, /待关闭|Open/);
  assert.match(elements['portfolio-list'].innerHTML, /data-toggle-issue-form/);
  assert.doesNotMatch(elements['portfolio-list'].innerHTML, /data-expand-issue-number="12"/);
  assert.match(elements['portfolio-list'].innerHTML, /data-project-conversation-mode="continue"/);
  assert.match(elements['portfolio-list'].innerHTML, /data-project-conversation-mode="solo"/);
  assert.match(elements['portfolio-list'].innerHTML, /data-project-conversation-input/);
  dispatchMessage({
    command: 'nodesUpdated',
    projectPath: '/workspace/second',
    nodes: [{
      id: 'step-1',
      title: '验证首页',
      stage: '产品',
      status: 'Pending',
      agentCli: 'codex',
      dependencies: ''
    }]
  });
  dispatchMessage({ command: 'soloSupplementFilesSelected', targetId: 'step-1', files: ['docs/brief.md'] });
  assert.match(elements['portfolio-list'].innerHTML, /docs\/brief\.md/);

  dispatchMessage({
    command: 'sidebarSoloConversationLoaded',
    projectPath: '/workspace/second',
    conversations: [{
      id: 7,
      agentCli: 'codex',
      status: 'Completed',
      timestamp: '2026-05-26T10:00:00.000Z',
      command: 'codex exec',
      output: 'User supplement:\n判断首页方向\n\nTouched project files:\nsrc/view.ts\n\nRun duration ms: 2000\n\nNative Agent session saved: .solopreneur/step-sessions/__solo__.json (3350a3b7-7761-4ed5-9661-2e9c9de8f924)\n\nAgent output tail:\n方向可继续验证。'
    }]
  });
  dispatchMessage({
    command: 'nodesUpdated',
    projectPath: '/workspace/second',
    nodes: []
  });
  assert.match(elements['portfolio-list'].innerHTML, /判断首页方向/);
  assert.match(elements['portfolio-list'].innerHTML, /codex/);
  assert.match(elements['portfolio-list'].innerHTML, /耗时|Duration/);
  assert.match(elements['portfolio-list'].innerHTML, /data-continue-sidebar-solo-id/);
  assert.match(elements['portfolio-list'].innerHTML, /sidebar-conversation-footer/);
  dispatchMessage({ command: 'pastedAttachmentsSaved', targetId: 'solo:/workspace/second', files: ['.solopreneur/attachments/solo/paste.png'] });
  assert.match(elements['portfolio-list'].innerHTML, /paste\.png/);
  const actionsHtml = elements['portfolio-list'].innerHTML.match(/<div class="sidebar-conversation-actions">([\s\S]*?)<\/div>/)[1];
  assert.doesNotMatch(actionsHtml, /data-continue-sidebar-solo-id/);
});

test('sidebar resolve survives persisted state and startup data failures', async () => {
  const { SolopreneurSidebarProvider } = loadCompiledModule(
    'out/sidebarProvider.js',
    ''
  );
  const postedMessages = [];
  let messageListener = null;
  const webviewView = {
    webview: {
      options: {},
      html: '',
      asWebviewUri(uri) {
        return String(uri && (uri.fsPath || uri.path || uri));
      },
      postMessage(message) {
        postedMessages.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage(listener) {
        messageListener = listener;
      }
    }
  };
  const provider = new SolopreneurSidebarProvider(
    createUri(projectRoot),
    { getNodes: () => { throw new Error('stale sync engine'); } },
    async () => { throw new Error('agent failed'); },
    () => { throw new Error('settings unavailable'); },
    async () => {},
    () => { throw new Error('persisted projects unavailable'); },
    async () => {},
    async () => {}
  );

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => provider.resolveWebviewView(webviewView, {}, {}));
    assert.match(webviewView.webview.html, /SoloMap/);
    assert.ok(postedMessages.some((message) => message.command === 'projectsLoaded'));

    await messageListener({ command: 'runAgent', nodeId: '1' });
    assert.ok(postedMessages.some((message) => message.command === 'sidebarActionFailed' && /agent failed/.test(message.message)));
  } finally {
    console.error = originalConsoleError;
  }
});

test('full roadmap webview runtime script parses and opens settings panel', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    'module.exports.__getWebviewHtml = getWebviewHtml;'
  );
  const html = extensionModule.__getWebviewHtml(createWebviewStub(), { extensionPath: projectRoot, extensionUri: createUri(projectRoot) });
  const script = extractLastScript(html);

  assert.doesNotThrow(() => new vm.Script(script));
  assert.doesNotMatch(html, /<select\b|<option\b/);
  assert.match(html, /data-solo-select/);
  assert.match(script, /renderSoloSelect/);
  assert.match(script, /bindPastedImageAttachments/);
  assert.match(script, /savePastedAttachments/);
  assert.match(script, /runRoadmapRevision[\s\S]*supplementFiles/);

  const { elements, postedMessages, dispatchMessage } = runScriptWithMinimalDom(script, [
    'canvas',
    'project-select',
    'btn-add-project',
    'btn-remove-project',
    'btn-toggle-roadmap-view',
    'btn-toggle-solo',
    'roadmap-view-tab-label',
    'solo-view-tab-label',
    'solo-panel',
    'solo-body',
    'btn-toggle-roadmap-revision',
    'btn-close-roadmap-revision',
    'roadmap-revision-panel',
    'roadmap-revision-body',
    'btn-toggle-settings',
    'btn-close-settings',
    'settings-panel',
    'setting-language',
    'setting-cli-select',
    'setting-clipath-custom',
    'setting-global-prompt',
    'btn-test-cli',
    'btn-save-settings',
    'cli-test-badge'
  ]);
  elements.canvas.querySelector = () => createElement('flow-line');

  elements['btn-toggle-settings'].listeners.click();
  assert.equal(elements['settings-panel'].style.display, 'flex');
  elements['setting-language'].listeners.click({
    target: elements['setting-language'].__options[1],
    stopPropagation() {}
  });
  elements['btn-save-settings'].listeners.click();

  assert.equal(elements['settings-panel'].style.display, 'none');
  assert.ok(postedMessages.some((message) => message.command === 'getSettings'));
  assert.ok(postedMessages.some((message) => message.command === 'updateSettings' && message.language === 'en'));

  postedMessages.length = 0;
  elements['btn-toggle-solo'].listeners.click();
  assert.ok(elements['solo-body'].innerHTML.includes('data-value="antigravity"'));
  elements['btn-toggle-roadmap-view'].listeners.click();

  dispatchMessage({
    command: 'settingsLoaded',
    settings: { cliPath: 'copilot', language: 'zh', globalPrompt: '' }
  });

  elements['btn-toggle-solo'].listeners.click();

  assert.ok(elements['solo-panel'].classList.contains('active'));
  assert.ok(elements['solo-body'].innerHTML.includes('data-solo-input'));
  assert.ok(elements['solo-body'].innerHTML.includes('data-value="copilot"'));
  assert.ok(postedMessages.some((message) => message.command === 'getNodeConversations' && message.nodeId === '__solo__'));
  elements['btn-toggle-roadmap-view'].listeners.click();

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
  assert.match(html, /id="btn-open-feedback"/);
  assert.match(script, /openFeedbackIssue/);
  assert.match(html, /id="setting-mcp-input"/);
  assert.match(html, /id="btn-install-mcp"/);
  assert.match(script, /installMcp/);
  assert.match(script, /mcpInstallResult/);
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
  assert.match(html, /\.conversation-compose\s*\{[\s\S]*?align-items:\s*stretch/);
  assert.match(script, /data-attach-node-id/);
  assert.match(script, /chooseSupplementFiles/);
  assert.match(script, /supplementFilesSelected/);
  assert.match(script, /conversation-attachment-chip/);
  assert.match(script, /data-send-node-id/);
  assert.match(script, /data-agent-select-id/);
  assert.match(script, /data-retry-conversation-id/);
  assert.match(script, /getAgentOptions/);
  assert.match(script, /normalizeAgentOption/);
  assert.match(script, /summarizeConversation/);
  assert.match(script, /retryConversation/);
  assert.match(script, /continueNativeConversation/);
  assert.match(script, /data-continue-native-conversation-id/);
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
  assert.match(script, /runSoloConversation/);
  assert.match(script, /linkSoloConversation/);
  assert.match(script, /Start directly|直接开始/);
  assert.match(script, /This Solo conversation has finished|本次 Solo 对话已结束/);
  assert.match(script, /renderSoloPanel/);
  assert.match(script, /data-attach-solo/);
  assert.match(script, /renderSupplementFiles\(soloConversationId/);
  assert.match(script, /supplementFiles: nodeSupplementFiles\[soloConversationId\]/);
  assert.match(script, /data-link-solo-id/);
  assert.match(script, /completionCriteria/);
  assert.match(script, /renderCompletionCriteria/);
  assert.match(script, /renderOnboardingPanel/);
  assert.match(script, /data-onboarding-add-project/);
  assert.match(script, /添加第一个项目|Add first project/);
  assert.match(script, /vscode\.postMessage\(\{ command: 'addProject' \}\)/);
  assert.doesNotMatch(script, /confirmStepCompletion|completeConfirm/);
  assert.match(script, /Completion criteria|完成标准/);
  assert.match(html, /id="btn-toggle-roadmap-revision"/);
  assert.match(html, /id="roadmap-revision-panel"/);
  assert.match(html, /id="roadmap-revision-body"/);
  assert.match(html, /id="btn-toggle-roadmap-view"/);
  assert.match(html, /id="btn-toggle-solo"/);
  assert.match(html, /id="solo-panel"/);
  assert.match(html, /id="solo-body"/);
  assert.match(html, /class="view-tab solo-tab"/);
  assert.match(html, /class="solo-view view-panel"/);
  assert.match(html, /\.roadmap-canvas\.view-panel:not\(\.active\),\s*\.solo-view\.view-panel:not\(\.active\)\s*\{[\s\S]*?display:\s*none/);
  assert.match(html, /\.methodology-shell\s*\{[\s\S]*?max-width:\s*min\(920px,\s*100%\)/);
  assert.match(html, /\.methodology-stage-card\.active/);
  assert.doesNotMatch(html, /solo-conversation-popover/);
  assert.match(script, /renderRoadmapRevisionPanel/);
  assert.match(script, /roadmapLoading/);
  assert.match(script, /currentRoadmapLoading/);
  assert.match(script, /data-methodology-stage/);
  assert.match(script, /activeMethodologyStage/);
  assert.match(script, /data-methodology-row-stage/);
  assert.match(script, /scrollIntoView/);
  assert.match(script, /methodologyBuild/);
  assert.match(script, /methodologyCompleted/);
  assert.doesNotMatch(script, /canvas\.appendChild\(panel\)/);
  assert.doesNotMatch(script, /data-toggle-roadmap-revision/);
  assert.match(script, /completeNode/);
  assert.match(script, /Complete Step|完成环节/);
  assert.match(script, /vscode\.postMessage\(\{ command: 'completeNode', nodeId: node\.id \}\)/);
  assert.doesNotMatch(html, /\.node-card\.status-Running \.btn-run\s*\{[\s\S]*?pointer-events:\s*none/);
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
  assert.doesNotMatch(html, /sidebar-solo-card/);
  assert.doesNotMatch(html, /id="sidebar-solo-project"/);
  assert.doesNotMatch(html, /id="sidebar-solo-input"/);
  assert.match(html, /runSoloConversation/);
  assert.match(html, /chooseSoloSupplementFiles/);
  assert.match(html, /soloSupplementFilesSelected/);
  assert.match(html, /getSoloConversationHistory/);
  assert.match(html, /sidebarSoloConversationLoaded/);
  assert.match(html, /renderSidebarSoloHistoryContent/);
  assert.match(html, /continueSoloConversation/);
  assert.match(html, /data-continue-sidebar-solo-id/);
  assert.match(html, /\.portfolio-compose-row\s*\{[\s\S]*?align-items:\s*stretch/);
  assert.match(html, /\.portfolio-compose-input\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(html, /\.portfolio-action-zone\s*\{[\s\S]*?margin-top:\s*4px[\s\S]*?padding-top:\s*0/);
  assert.match(html, /issueDraftTitle/);
  assert.match(html, /\.portfolio-compose-agent-row\s*\{[\s\S]*?margin-bottom:\s*7px/);
  assert.match(html, /\.sidebar-solo-attachments\s*\{[\s\S]*?margin:\s*8px 0 2px/);
  assert.match(html, /\.portfolio-mode-btn\[data-project-conversation-mode="solo"\]\.active\s*\{[\s\S]*?rgba\(124, 77, 255, 0\.2\)/);
  assert.match(html, /\.sidebar-conversation-footer\s*\{[\s\S]*?justify-content:\s*flex-end/);
  assert.match(html, /\.sidebar-conversation-detail\s*\{[\s\S]*?overflow-wrap:\s*anywhere/);
  assert.match(html, /\.sidebar-conversation-detail pre\s*\{[\s\S]*?max-width:\s*100%/);
  assert.match(html, /function normalizeAgentOption/);
  assert.match(html, /add\('antigravity'\)/);
  assert.doesNotMatch(html, /add\('codex-cli'\)/);
  assert.doesNotMatch(html, /add\('antigravity-cli'\)/);
  assert.match(html, /\.portfolio-panel\s*\{[\s\S]*?z-index:\s*1/);
  assert.match(html, /Solo 对话|Solo conversation/);
  assert.match(html, /id="portfolio-list"/);
  assert.doesNotMatch(html, /id="next-action-panel"/);
  assert.match(html, /getNextActionNode/);
  assert.match(html, /renderProjectConversationComposer/);
  assert.match(html, /data-project-continue-composer/);
  assert.match(html, /data-project-conversation-mode="continue"/);
  assert.match(html, /data-project-conversation-mode="solo"/);
  assert.match(html, /data-project-conversation-input/);
  assert.match(html, /portfolio-compose-agent-row/);
  assert.match(html, /data-project-continue-send/);
  assert.match(html, /data-select-project-path/);
  assert.match(html, /id="global-focus-panel"/);
  assert.match(html, /今日安排|Today/);
  assert.match(html, /todayPlanScore/);
  assert.match(html, /todaySlotUrgent/);
  assert.doesNotMatch(html, /本周推进|Weekly Focus/);
  assert.match(html, /id="setting-global-data-path"/);
  assert.match(html, /id="setting-mcp-input"/);
  assert.match(html, /id="btn-install-mcp"/);
  assert.match(html, /installMcp/);
  assert.match(html, /mcpInstallResult/);
  assert.match(html, /\.onboarding-panel\s*\{/);
  assert.match(html, /renderOnboardingPanel/);
  assert.match(html, /data-onboarding-add-project/);
  assert.match(html, /添加第一个项目|Add first project/);
  assert.match(html, /vscode\.postMessage\(\{ command: 'addProject' \}\)/);
  assert.doesNotMatch(html, /id="tasks-list"/);
  assert.doesNotMatch(html, /id="progress-bar"/);
  assert.doesNotMatch(html, /id="progress-text"/);
  assert.match(html, /function activateProjectInSidebar/);
  assert.match(html, /padding:\s*12px 12px 78px/);
  assert.match(html, /bindSoloSelect\(projectSelect,\s*\(value\) => \{[\s\S]*?activateProjectInSidebar\(value\)/);
  assert.match(html, /selectProject/);
  assert.match(html, /continueProjectFromPortfolio/);
  assert.match(html, /openProjectFromPortfolio/);
  assert.doesNotMatch(html, /ai-prompt-sidebar/);
  assert.doesNotMatch(html, /btn-generate-sidebar/);
});

test('adding a project asks for a global methodology project type', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src', 'extension.ts'), 'utf8');

  assert.match(source, /showQuickPick\(\[/);
  assert.match(source, /这个项目更像哪一类/);
  assert.match(source, /核心产品/);
  assert.match(source, /基础设施/);
  assert.match(source, /内容产品/);
  assert.match(source, /试验研究/);
  assert.match(source, /工具脚手架/);
  assert.match(source, /归档维护/);
  assert.match(source, /type:\s*projectType\.value/);
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
    { name: 'Novel', path: projectRootA, type: 'content' },
    { name: 'CRM', path: projectRootB }
  ]);

  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].failedNodes, 1);
  assert.equal(summaries[0].overallStatus, 'Failed');
  assert.equal(summaries[0].recommendedNodeTitle, 'Build MVP');
  assert.equal(summaries[0].recommendedStatus, 'Failed');
  assert.equal(summaries[0].progressPercent, 33);
  assert.equal(summaries[0].globalPriority, 'P0');
  assert.equal(summaries[0].globalNextAction, 'Build MVP');
  assert.equal(summaries[0].projectType, 'content');
  assert.equal(summaries[1].overallStatus, 'In Progress');
  assert.equal(summaries[1].recommendedNodeTitle, 'Implement');
  assert.equal(sidebarModule.__getRecommendedNode([
    { id: '1', title: 'Failed step', status: 'Failed', stage: '产品与 MVP', dependencies: '' },
    { id: '2', title: 'Running step', status: 'Running', stage: '产品与 MVP', dependencies: '' }
  ]).title, 'Running step');
});

test('global engineering store writes git-friendly portfolio files', () => {
  const sidebarModule = loadCompiledModule(
    'out/sidebarProvider.js',
    [
      'module.exports.__ensureGlobalEngineeringStore = ensureGlobalEngineeringStore;',
      'module.exports.__normalizeGlobalDataPath = normalizeGlobalDataPath;'
    ].join('\n')
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-global-store-'));
  const globalRoot = path.join(root, '.solomap-global');
  const snapshot = sidebarModule.__ensureGlobalEngineeringStore(globalRoot, [{
    name: 'SoloMap',
    path: '/workspace/solomap',
    projectType: 'core_product',
    overallStatus: 'Failed',
    globalPriority: 'P0',
    blocker: 'Build MVP',
    globalNextAction: 'Build MVP',
    recommendedNodeTitle: 'Build MVP',
    issues: { available: true, open: 1, byPriority: { P0: 1 }, byCategory: { bug: 1 } }
  }]);

  assert.equal(snapshot.dataPath, globalRoot);
  assert.ok(fs.existsSync(path.join(globalRoot, 'portfolio.csv')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'dependencies.csv')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'capability-registry.csv')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'decision-conflicts.csv')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'learning', 'candidates')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'learning', 'approved')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'learning', 'rejected')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'metrics', 'execution-speed.csv')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'metrics', 'reuse-rate.csv')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'metrics', 'priority-accuracy.csv')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'metrics', 'monthly-summary.md')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'memory', 'README.md')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'memory', 'profile.md')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'memory', 'operating-rules.md')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'memory', 'projects')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'memory', 'patterns')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'memory', 'decisions')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'memory', 'domains')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'memory', 'inbox')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'memory', 'active')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'memory', 'projects', '_example.md')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'memory', 'patterns', '_example.md')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'memory', 'decisions', '_example.md')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'memory', 'domains', '_example.md')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'memory', 'inbox', '_example.md')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'memory', 'active', '_example.md')));
  assert.ok(fs.existsSync(path.join(globalRoot, 'learning', 'candidates', '_example.md')));
  assert.equal(snapshot.learningCandidateCount, 0);
  assert.match(fs.readFileSync(path.join(globalRoot, 'portfolio.csv'), 'utf8'), /SoloMap/);
  assert.match(fs.readFileSync(path.join(globalRoot, 'dependencies.csv'), 'utf8'), /Build MVP/);
  assert.equal(sidebarModule.__normalizeGlobalDataPath(root, []), globalRoot);
});

test('sidebar GitHub issue cache is validated and ignored by git', () => {
  const sidebarModule = loadCompiledModule(
    'out/sidebarProvider.js',
    [
      'module.exports.__getIssueCachePath = getIssueCachePath;',
      'module.exports.__getDeliveryCachePath = getDeliveryCachePath;',
      'module.exports.__readIssueCache = readIssueCache;',
      'module.exports.__writeIssueCache = writeIssueCache;',
      'module.exports.__readDeliveryCache = readDeliveryCache;',
      'module.exports.__writeDeliveryCache = writeDeliveryCache;',
      'module.exports.__summarizeDeliveryCache = summarizeDeliveryCache;',
      'module.exports.__summarizeIssueItems = summarizeIssueItems;'
    ].join('\n')
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-issue-cache-'));
  const issue = {
    number: 12,
    title: '页面加载慢',
    body: '首屏等待过久',
    state: 'OPEN',
    category: 'bug',
    priority: 'P0',
    labels: ['bug', 'P0'],
    comments: 2,
    thumbsUp: 3,
    url: 'https://github.com/owner/repo/issues/12',
    updatedAt: '2026-05-29T00:00:00.000Z'
  };
  const cache = {
    schemaVersion: 1,
    repo: 'owner/repo',
    syncedAt: '2026-05-29T00:00:00.000Z',
    issues: [issue],
    details: {
      '12': {
        syncedAt: '2026-05-29T00:00:00.000Z',
        issue,
        comments: [{ author: 'user', body: '仍然很慢', createdAt: '2026-05-29T00:01:00.000Z' }]
      }
    }
  };

  sidebarModule.__writeIssueCache(root, cache);

  const cachePath = sidebarModule.__getIssueCachePath(root);
  assert.equal(cachePath, path.join(root, '.solopreneur', 'issues-cache.json'));
  assert.ok(fs.existsSync(cachePath));
  assert.match(fs.readFileSync(path.join(root, '.solopreneur', '.gitignore'), 'utf8'), /issues-cache\.json/);
  assert.equal(sidebarModule.__readIssueCache(root, 'other/repo'), null);

  const read = sidebarModule.__readIssueCache(root, 'owner/repo');
  assert.equal(read.repo, 'owner/repo');
  assert.equal(read.issues.length, 1);
  assert.equal(read.details['12'].comments[0].body, '仍然很慢');

  const summary = sidebarModule.__summarizeIssueItems('owner/repo', read.issues, read.syncedAt, true);
  assert.equal(summary.available, true);
  assert.equal(summary.stale, true);
  assert.equal(summary.total, 1);
  assert.equal(summary.open, 1);
  assert.equal(summary.byCategory.bug, 1);
  assert.equal(summary.byPriority.P0, 1);

  sidebarModule.__writeDeliveryCache(root, {
    schemaVersion: 1,
    repo: 'owner/repo',
    syncedAt: '2026-05-29T00:00:00.000Z',
    latestRelease: {
      tagName: 'v1.2.3',
      name: 'v1.2.3',
      publishedAt: '2026-05-29T00:00:00.000Z',
      url: 'https://github.com/owner/repo/releases/tag/v1.2.3'
    },
    workflowRuns: [
      {
        name: 'CI',
        displayTitle: 'CI',
        status: 'completed',
        conclusion: 'success',
        createdAt: '2026-05-29T00:03:00.000Z',
        updatedAt: '2026-05-29T00:04:00.000Z',
        url: 'https://github.com/owner/repo/actions/runs/4'
      },
      {
        name: 'CI',
        displayTitle: 'CI',
        status: 'completed',
        conclusion: 'success',
        createdAt: '2026-05-29T00:02:00.000Z',
        updatedAt: '2026-05-29T00:03:00.000Z',
        url: 'https://github.com/owner/repo/actions/runs/3'
      },
      {
        name: 'CI',
        displayTitle: 'CI',
        status: 'completed',
        conclusion: 'failure',
        createdAt: '2026-05-29T00:01:00.000Z',
        updatedAt: '2026-05-29T00:02:00.000Z',
        url: 'https://github.com/owner/repo/actions/runs/2'
      },
      {
        name: 'CI',
        displayTitle: 'CI',
        status: 'completed',
        conclusion: 'failure',
        createdAt: '2026-05-29T00:00:00.000Z',
        updatedAt: '2026-05-29T00:01:00.000Z',
        url: 'https://github.com/owner/repo/actions/runs/1'
      }
    ]
  });
  const deliveryPath = sidebarModule.__getDeliveryCachePath(root);
  assert.equal(deliveryPath, path.join(root, '.solopreneur', 'delivery-cache.json'));
  assert.match(fs.readFileSync(path.join(root, '.solopreneur', '.gitignore'), 'utf8'), /delivery-cache\.json/);
  const deliveryCache = sidebarModule.__readDeliveryCache(root, 'owner/repo');
  const deliverySummary = sidebarModule.__summarizeDeliveryCache('owner/repo', deliveryCache, true);
  assert.equal(deliverySummary.latestRelease, 'v1.2.3');
  assert.equal(deliverySummary.failedWorkflowRuns, 1);
  assert.equal(deliverySummary.stale, true);
});

test('sidebar issue creation keeps labels auxiliary to creation', () => {
  const sidebarModule = loadCompiledModule(
    'out/sidebarProvider.js',
    [
      'module.exports.__getProjectIssueLabels = getProjectIssueLabels;',
      'module.exports.__parseIssueNumberFromOutput = parseIssueNumberFromOutput;'
    ].join('\n')
  );

  assert.equal(JSON.stringify(sidebarModule.__getProjectIssueLabels('feature-request', 'P1')), JSON.stringify(['feature-request', 'P1']));
  assert.equal(JSON.stringify(sidebarModule.__getProjectIssueLabels('discussion', '')), JSON.stringify(['discussion']));
  assert.equal(
    sidebarModule.__parseIssueNumberFromOutput('https://github.com/owner/repo/issues/123'),
    123
  );
  assert.equal(sidebarModule.__parseIssueNumberFromOutput('created issue'), 0);
});

test('agent command builder uses non-interactive task runs and native continuation commands', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__buildAgentCommand = buildAgentCommand;',
      'module.exports.__buildAgentCommandForPromptFile = buildAgentCommandForPromptFile;',
      'module.exports.__buildAgentCommandFromShellVar = buildAgentCommandFromShellVar;',
      'module.exports.__buildNativeContinueCommand = buildNativeContinueCommand;',
      'module.exports.__makeAgentTerminalName = makeAgentTerminalName;',
      'module.exports.__buildAgentShellScript = buildAgentShellScript;',
      'module.exports.__buildAgentConversationPrompt = buildAgentConversationPrompt;',
      'module.exports.__buildRoadmapRevisionPrompt = buildRoadmapRevisionPrompt;',
      'module.exports.__buildSoloConversationPrompt = buildSoloConversationPrompt;',
      'module.exports.__buildSoloMapSystemMemoryPrompt = buildSoloMapSystemMemoryPrompt;',
      'module.exports.__ensureSolomapMemoryStore = ensureSolomapMemoryStore;',
      'module.exports.__ensureSolomapSkillStore = ensureSolomapSkillStore;',
      'module.exports.__readSolomapSkillRegistry = readSolomapSkillRegistry;',
      'module.exports.__writeSolomapSkillRegistry = writeSolomapSkillRegistry;',
      'module.exports.__buildSolomapSkillCandidateInstructions = buildSolomapSkillCandidateInstructions;',
      'module.exports.__buildSkillInstallPrompt = buildSkillInstallPrompt;',
      'module.exports.__validateAndRegisterSkillInstall = validateAndRegisterSkillInstall;',
      'module.exports.__ensureSolomapMcpStore = ensureSolomapMcpStore;',
      'module.exports.__readSolomapMcpRegistry = readSolomapMcpRegistry;',
      'module.exports.__writeSolomapMcpRegistry = writeSolomapMcpRegistry;',
      'module.exports.__buildSolomapMcpCandidateInstructions = buildSolomapMcpCandidateInstructions;',
      'module.exports.__buildMcpInstallPrompt = buildMcpInstallPrompt;',
      'module.exports.__validateAndRegisterMcpInstall = validateAndRegisterMcpInstall;',
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
      'module.exports.__resolveExecutablePath = resolveExecutablePath;',
      'module.exports.__commandExists = commandExists;',
      'module.exports.__getAgentProvider = getAgentProvider;',
      'module.exports.__getStepSessionFilePath = getStepSessionFilePath;',
      'module.exports.__readStepSessionState = readStepSessionState;',
      'module.exports.__getStoredAgentSession = getStoredAgentSession;',
      'module.exports.__updateStoredAgentSession = updateStoredAgentSession;',
      'module.exports.__clearStoredAgentSession = clearStoredAgentSession;',
      'module.exports.__extractNativeSessionIdFromExecutionOutput = extractNativeSessionIdFromExecutionOutput;',
      'module.exports.__extractUserSupplementFromExecutionOutput = extractUserSupplementFromExecutionOutput;',
      'module.exports.__buildLocalRoadmap = buildLocalRoadmap;',
      'module.exports.__validateBootstrapRoadmapRewrite = validateBootstrapRoadmapRewrite;',
      'module.exports.__validateRoadmapRevision = validateRoadmapRevision;',
      'module.exports.__processAgentStatusFile = processAgentStatusFile;',
      'module.exports.__recordSolomapLearningCycle = recordSolomapLearningCycle;',
      'module.exports.__buildSolomapLearningContext = buildSolomapLearningContext;',
      'module.exports.__shellQuote = shellQuote;'
    ].join('\n')
  );

  assert.equal(
    extensionModule.__buildAgentCommand('codex', 'Ship the MVP', '/workspace/app'),
    "'codex' exec --color always -C '/workspace/app' --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox 'Ship the MVP'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('codex-cli', "Don't skip tests", '/workspace/app'),
    "'codex-cli' exec --color always -C '/workspace/app' --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox 'Don'\\''t skip tests'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('codex', 'Continue the MVP', '/workspace/app', '019dc472-6a80-7c70-99a4-b2593a641d11'),
    "'codex' exec --color always -C '/workspace/app' --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox 'Continue the MVP'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('antigravity-cli', 'Build landing page', '/workspace/app'),
    "'antigravity-cli' --print --dangerously-skip-permissions --add-dir='/workspace/app' 'Build landing page'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('agy', 'Build landing page', '/workspace/app'),
    "'agy' --print --dangerously-skip-permissions --add-dir='/workspace/app' 'Build landing page'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('agy', 'Continue landing page', '/workspace/app', '3350a3b7-7761-4ed5-9661-2e9c9de8f924'),
    "'agy' --print --dangerously-skip-permissions --add-dir='/workspace/app' 'Continue landing page'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('claude', 'Ship the MVP', '/workspace/app'),
    "'claude' -p --dangerously-skip-permissions --add-dir '/workspace/app' 'Ship the MVP'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('copilot', 'Ship the MVP', '/workspace/app'),
    "'copilot' -p 'Ship the MVP' -C '/workspace/app' --add-dir '/workspace/app' --allow-all --no-ask-user --output-format text"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('opencode', 'Ship the MVP', '/workspace/app'),
    "(cd '/workspace/app' && 'opencode' run 'Ship the MVP')"
  );
  assert.equal(
    extensionModule.__buildAgentCommandForPromptFile('agy', '/workspace/app/.solopreneur/agent-runs/2/prompt.txt', '/workspace/app'),
    "'agy' --print --dangerously-skip-permissions --add-dir='/workspace/app' 'Read the complete SoloMap task prompt from /workspace/app/.solopreneur/agent-runs/2/prompt.txt and follow that file exactly. The user request inside the file is the highest priority. Do not answer this wrapper sentence.'"
  );
  assert.equal(
    extensionModule.__buildAgentCommandForPromptFile('codex', '/workspace/app/.solopreneur/agent-runs/2/prompt.txt', '/workspace/app'),
    "cat '/workspace/app/.solopreneur/agent-runs/2/prompt.txt' | 'codex' exec --color always -C '/workspace/app' --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -"
  );
  assert.equal(
    extensionModule.__buildAgentCommandForPromptFile('claude', '/workspace/app/.solopreneur/agent-runs/2/prompt.txt', '/workspace/app'),
    "'claude' -p --dangerously-skip-permissions --add-dir '/workspace/app' 'Read the complete SoloMap task prompt from /workspace/app/.solopreneur/agent-runs/2/prompt.txt and follow that file exactly. The user request inside the file is the highest priority. Do not answer this wrapper sentence.'"
  );
  assert.equal(
    extensionModule.__buildAgentCommandForPromptFile('copilot', '/workspace/app/.solopreneur/agent-runs/2/prompt.txt', '/workspace/app'),
    "'copilot' -p 'Read the complete SoloMap task prompt from /workspace/app/.solopreneur/agent-runs/2/prompt.txt and follow that file exactly. The user request inside the file is the highest priority. Do not answer this wrapper sentence.' -C '/workspace/app' --add-dir '/workspace/app' --allow-all --no-ask-user --output-format text"
  );
  assert.equal(
    extensionModule.__buildAgentCommandForPromptFile('opencode', '/workspace/app/.solopreneur/agent-runs/2/prompt.txt', '/workspace/app'),
    "(cd '/workspace/app' && 'opencode' run 'Read the complete SoloMap task prompt from /workspace/app/.solopreneur/agent-runs/2/prompt.txt and follow that file exactly. The user request inside the file is the highest priority. Do not answer this wrapper sentence.')"
  );
  assert.equal(
    extensionModule.__buildAgentCommandFromShellVar('codex', 'agent_prompt', '/workspace/app'),
    "printf %s \"$agent_prompt\" | 'codex' exec --color always -C '/workspace/app' --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -"
  );
  assert.equal(
    extensionModule.__buildAgentCommandFromShellVar('agy', 'agent_prompt', '/workspace/app'),
    "'agy' --print --dangerously-skip-permissions --add-dir='/workspace/app' \"$agent_prompt\""
  );
  assert.equal(
    extensionModule.__buildAgentCommandFromShellVar('copilot', 'agent_prompt', '/workspace/app'),
    "'copilot' -p \"$agent_prompt\" -C '/workspace/app' --add-dir '/workspace/app' --allow-all --no-ask-user --output-format text"
  );
  assert.equal(
    extensionModule.__buildNativeContinueCommand('codex', '019dc472-6a80-7c70-99a4-b2593a641d11', '/workspace/app'),
    "'codex' resume -C '/workspace/app' '019dc472-6a80-7c70-99a4-b2593a641d11'"
  );
  assert.equal(
    extensionModule.__buildNativeContinueCommand('agy', '3350a3b7-7761-4ed5-9661-2e9c9de8f924', '/workspace/app'),
    "'agy' --conversation '3350a3b7-7761-4ed5-9661-2e9c9de8f924' --prompt-interactive --dangerously-skip-permissions --add-dir='/workspace/app'"
  );
  assert.equal(
    extensionModule.__buildNativeContinueCommand('copilot', '3350a3b7-7761-4ed5-9661-2e9c9de8f924', '/workspace/app'),
    "'copilot' --connect '3350a3b7-7761-4ed5-9661-2e9c9de8f924' -C '/workspace/app' --add-dir '/workspace/app' --allow-all --no-ask-user"
  );
  const firstTerminalName = extensionModule.__makeAgentTerminalName('step-2-42');
  const secondTerminalName = extensionModule.__makeAgentTerminalName('step-2-43');
  assert.match(firstTerminalName, /^SoloMap Agent Console · step-2-42 · \d+$/);
  assert.match(secondTerminalName, /^SoloMap Agent Console · step-2-43 · \d+$/);
  assert.notEqual(firstTerminalName, secondTerminalName);
  assert.equal(
    extensionModule.__buildAgentCommandFromShellVar('claude', 'agent_prompt', '/workspace/app'),
    "'claude' -p --dangerously-skip-permissions --add-dir '/workspace/app' \"$agent_prompt\""
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
  assert.equal(
    JSON.stringify(extensionModule.__getAgentCliCandidates('copilot', '').slice(0, 5)),
    JSON.stringify(['copilot', 'copilot-cli', 'agy', 'antigravity', 'antigravity-cli'])
  );
  assert.equal(
    JSON.stringify(extensionModule.__getAgentCliCandidates('cursor', '').slice(0, 5)),
    JSON.stringify(['cursor', 'cursor-cli', 'codex', 'codex-cli', 'agy'])
  );
  assert.equal(extensionModule.__getAgentProvider('claude'), 'claude');
  assert.equal(extensionModule.__getAgentProvider('copilot'), 'copilot');
  assert.equal(extensionModule.__getAgentProvider('opencode'), 'opencode');

  const sidebarModule = loadCompiledModule(
    'out/sidebarProvider.js',
    [
      'module.exports.__getAgentCliCandidates = getAgentCliCandidates;',
      'module.exports.__resolveExecutablePath = resolveExecutablePath;',
      'module.exports.__commandExists = commandExists;',
      'module.exports.__getCliVersionArgs = getCliVersionArgs;',
      'module.exports.__formatCliTestMessage = formatCliTestMessage;',
      'module.exports.__buildAgentInstallCommand = buildAgentInstallCommand;'
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
  assert.equal(
    JSON.stringify(sidebarModule.__getAgentCliCandidates('cursor', '').slice(0, 5)),
    JSON.stringify(['cursor', 'cursor-cli', 'codex', 'codex-cli', 'agy'])
  );
  assert.equal(JSON.stringify(sidebarModule.__getCliVersionArgs('agy')), JSON.stringify(['--version']));
  assert.match(sidebarModule.__formatCliTestMessage('agy', '1.0.1\n', ''), /agy · 1\.0\.1/);
  assert.match(sidebarModule.__buildAgentInstallCommand('codex'), /npm install -g @openai\/codex/);
  assert.match(sidebarModule.__buildAgentInstallCommand('claude'), /npm install -g @anthropic-ai\/claude-code/);
  assert.match(sidebarModule.__buildAgentInstallCommand('copilot'), /npm install -g @github\/copilot/);
  assert.match(sidebarModule.__buildAgentInstallCommand('opencode'), /npm install -g opencode-ai/);
  assert.match(sidebarModule.__buildAgentInstallCommand('agy'), /https:\/\/antigravity\.google\/cli\/install\.sh/);
  assert.match(sidebarModule.__buildAgentInstallCommand('cursor'), /Cursor CLI/);

  const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-cli-home-'));
  const fakeCliPath = path.join(cliHome, '.local', 'bin', 'solo-test-agent');
  fs.mkdirSync(path.dirname(fakeCliPath), { recursive: true });
  fs.writeFileSync(fakeCliPath, '#!/bin/sh\necho solo-test-agent\n', 'utf8');
  fs.chmodSync(fakeCliPath, 0o755);
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const previousShell = process.env.SHELL;
  process.env.HOME = cliHome;
  process.env.PATH = '';
  process.env.SHELL = '';
  try {
    assert.equal(extensionModule.__resolveExecutablePath('solo-test-agent'), fakeCliPath);
    assert.equal(extensionModule.__commandExists('solo-test-agent'), true);
    assert.equal(sidebarModule.__resolveExecutablePath('solo-test-agent'), fakeCliPath);
    assert.equal(sidebarModule.__commandExists('solo-test-agent'), true);
  } finally {
    process.env.HOME = previousHome;
    process.env.PATH = previousPath;
    process.env.SHELL = previousShell;
  }

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
  assert.doesNotMatch(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /script -q -e -c/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /tee .*output\.log/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /codex' exec --color always -C .*--skip-git-repo-check -/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /FORCE_COLOR/);
  assert.doesNotMatch(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /timed out waiting for response|Error: timed out/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /without project file changes or a completion decision/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /\.agent_status\.json/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /executionLogId/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /sessionFilePath/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /sessionMode/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /commandFilePath/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /\.codex\/sessions/);
  const globalShellScript = extensionModule.__buildAgentShellScript(
    'codex',
    'Use the configured global memory path.',
    shellRoot,
    'global-path',
    43,
    '',
    undefined,
    '',
    '',
    'step',
    '',
    '/workspace/.solomap-global'
  );
  assert.match(fs.readFileSync(globalShellScript.runScriptPath, 'utf8'), /"globalDataPath":"\/workspace\/\.solomap-global"/);
  assert.doesNotMatch(shellScript.finalCommand, /Use a small smoke test\./);
  assert.doesNotMatch(shellScript.finalCommand, /Ship the MVP/);
  const coloredOutputPath = path.join(os.tmpdir(), 'solopreneur-colored-output.log');
  fs.writeFileSync(coloredOutputPath, '\u001b[32mDone\u001b[0m', 'utf8');
  assert.equal(extensionModule.__getOutputTail(coloredOutputPath), 'Done');
  assert.equal(typeof extensionModule.__processAgentStatusFile, 'function');

  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-memory-'));
  const ensuredMemory = extensionModule.__ensureSolomapMemoryStore('/workspace/app', memoryRoot);
  assert.equal(ensuredMemory.globalRoot, path.join(memoryRoot, '.solomap-global'));
  assert.equal(ensuredMemory.memoryRoot, path.join(memoryRoot, '.solomap-global', 'memory'));
  assert.ok(fs.existsSync(path.join(ensuredMemory.memoryRoot, 'README.md')));
  assert.ok(fs.existsSync(path.join(ensuredMemory.memoryRoot, 'projects', 'app.md')));
  assert.ok(fs.existsSync(path.join(ensuredMemory.memoryRoot, 'projects', '_example.md')));
  assert.ok(fs.existsSync(path.join(ensuredMemory.memoryRoot, 'patterns', '_example.md')));
  assert.ok(fs.existsSync(path.join(ensuredMemory.memoryRoot, 'decisions', '_example.md')));
  assert.ok(fs.existsSync(path.join(ensuredMemory.memoryRoot, 'domains', '_example.md')));
  assert.ok(fs.existsSync(path.join(ensuredMemory.memoryRoot, 'inbox', '_example.md')));
  assert.ok(fs.existsSync(path.join(ensuredMemory.memoryRoot, 'active', '_example.md')));
  assert.ok(fs.existsSync(path.join(ensuredMemory.globalRoot, 'learning', 'candidates', '_example.md')));
  assert.ok(fs.existsSync(path.join(ensuredMemory.globalRoot, 'learning', 'approved')));
  assert.ok(fs.existsSync(path.join(ensuredMemory.globalRoot, 'learning', 'rejected')));
  assert.ok(fs.existsSync(path.join(ensuredMemory.globalRoot, 'metrics', 'execution-speed.csv')));
  assert.ok(fs.existsSync(path.join(ensuredMemory.globalRoot, 'metrics', 'reuse-rate.csv')));
  assert.ok(fs.existsSync(path.join(ensuredMemory.globalRoot, 'metrics', 'priority-accuracy.csv')));
  assert.ok(fs.existsSync(path.join(ensuredMemory.globalRoot, 'metrics', 'monthly-summary.md')));
  extensionModule.__recordSolomapLearningCycle(
    '/workspace/app',
    memoryRoot,
    {
      id: '2',
      title: 'Improve roadmap',
      stage: '反馈与规模化',
      description: 'Use feedback to adjust the roadmap.',
      agentPrompt: 'Review learning signals.',
      status: 'In Progress'
    },
    'Completed',
    'M docs/learning-loop.md',
    'M docs/learning-loop.md',
    'Updated the learning loop.',
    1234,
    '2026-05-31T00:00:00.000Z'
  );
  assert.match(fs.readFileSync(path.join(ensuredMemory.globalRoot, 'metrics', 'execution-speed.csv'), 'utf8'), /反馈与规模化.*1234/);
  assert.ok(fs.readdirSync(path.join(ensuredMemory.globalRoot, 'learning', 'candidates')).some((name) => name.endsWith('.md') && name !== '_example.md'));
  assert.match(extensionModule.__buildSolomapLearningContext('/workspace/app', memoryRoot), /待审核学习候选：1/);
  assert.match(extensionModule.__buildSolomapLearningContext('/workspace/app', memoryRoot), /最近执行速度记录/);
  const defaultMemoryPrompt = extensionModule.__buildSoloMapSystemMemoryPrompt('/workspace/app', memoryRoot);
  assert.match(defaultMemoryPrompt, /SoloMap 默认系统提示词/);
  assert.match(defaultMemoryPrompt, /\.solomap-global\/memory/);
  assert.match(defaultMemoryPrompt, /projects\/app\.md/);
  assert.match(defaultMemoryPrompt, /learning\/candidates/);
  assert.match(defaultMemoryPrompt, /写入协议/);
  assert.match(defaultMemoryPrompt, /_example\.md/);
  assert.match(defaultMemoryPrompt, /不要覆盖/);
  assert.match(defaultMemoryPrompt, /写入位置/);
  assert.match(defaultMemoryPrompt, /旧 `\.codex-memory\/`/);
  assert.match(defaultMemoryPrompt, /当前用户请求、当前项目文件、测试、日志和命令输出/);
  assert.match(defaultMemoryPrompt, /新项目或新环节开始时/);
  assert.match(defaultMemoryPrompt, /项目类型用于选择路线图形态/);

  const skillStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-skill-store-'));
  const skillStore = extensionModule.__ensureSolomapSkillStore('/workspace/app', skillStoreRoot);
  assert.ok(fs.existsSync(path.join(skillStore.skillsRoot, 'installed')));
  assert.ok(fs.existsSync(path.join(skillStore.skillsRoot, 'runs')));
  extensionModule.__writeSolomapSkillRegistry('/workspace/app', skillStoreRoot, {
    version: 1,
    updatedAt: '',
    skills: [{
      id: 'frontend-ui',
      title: 'Frontend UI',
      description: 'Review UI work.',
      entry: 'installed/frontend-ui/package/SKILL.md',
      packagePath: 'installed/frontend-ui/package',
      status: 'installed',
      activation: {
        keywords: ['UI', '界面'],
        useWhen: ['任务涉及前台 UI 实现、交互修复或视觉验收'],
        doNotUseWhen: ['任务只涉及后端 API']
      },
      risk: { hasScripts: false, hasExecutables: false }
    }, {
      id: 'manual-only',
      title: 'Manual Only',
      entry: 'installed/manual-only/package/SKILL.md',
      status: 'installed',
      activation: { keywords: ['UI'], manualOnly: true },
      risk: {}
    }]
  });
  const skillInstructions = extensionModule.__buildSolomapSkillCandidateInstructions('/workspace/app', skillStoreRoot, '修复侧边栏 UI 交互问题');
  assert.match(skillInstructions, /Frontend UI/);
  assert.match(skillInstructions, /installed\/frontend-ui\/package\/SKILL\.md/);
  assert.match(skillInstructions, /这些只是候选，不是强制项/);
  assert.doesNotMatch(skillInstructions, /Manual Only/);

  const installPrompt = extensionModule.__buildSkillInstallPrompt('https://skills.sh/owner/repo/skill-name', '/workspace/app', skillStoreRoot, path.join(skillStore.runsRoot, 'run', 'result.json'));
  assert.match(installPrompt, /受控安装任务/);
  assert.match(installPrompt, /完整 skill package/);
  assert.match(installPrompt, /solomap\.skill\.json/);
  assert.match(installPrompt, /source\.lock\.json/);
  assert.match(installPrompt, /DISABLE_TELEMETRY=1/);

  const fakeSkillDir = path.join(skillStore.skillsRoot, 'installed', 'frontend-ui');
  fs.mkdirSync(path.join(fakeSkillDir, 'package'), { recursive: true });
  fs.writeFileSync(path.join(fakeSkillDir, 'package', 'SKILL.md'), '---\nname: frontend-ui\n---\n# Frontend UI\n', 'utf8');
  fs.writeFileSync(path.join(fakeSkillDir, 'solomap.skill.json'), JSON.stringify({
    id: 'frontend-ui',
    title: 'Frontend UI',
    description: 'Review UI work.',
    entry: 'installed/frontend-ui/package/SKILL.md',
    packagePath: 'installed/frontend-ui/package',
    status: 'installed',
    activation: { keywords: ['UI'], useWhen: ['UI work'] },
    risk: { hasScripts: false, hasExecutables: false }
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(fakeSkillDir, 'source.lock.json'), JSON.stringify({ source: 'owner/repo' }, null, 2), 'utf8');
  const fakeResultPath = path.join(skillStore.runsRoot, 'fake-result.json');
  fs.writeFileSync(fakeResultPath, JSON.stringify({
    ok: true,
    skillId: 'frontend-ui',
    installedPath: path.join(skillStore.skillsRoot, 'installed', 'frontend-ui'),
    packagePath: path.join(fakeSkillDir, 'package'),
    entryFile: path.join(fakeSkillDir, 'package', 'SKILL.md'),
    solomapSkillJson: path.join(fakeSkillDir, 'solomap.skill.json'),
    sourceLockJson: path.join(fakeSkillDir, 'source.lock.json'),
    metadata: { name: 'frontend-ui', description: 'Review UI work.' },
    source: { input: 'owner/repo' },
    risk: { hasScripts: false, hasExecutables: false }
  }, null, 2), 'utf8');
  const validation = extensionModule.__validateAndRegisterSkillInstall('/workspace/app', skillStoreRoot, fakeResultPath);
  assert.equal(validation.ok, true);
  const registryAfterValidation = extensionModule.__readSolomapSkillRegistry('/workspace/app', skillStoreRoot);
  assert.equal(registryAfterValidation.skills.some((skill) => skill.id === 'frontend-ui'), true);

  const mcpStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-mcp-store-'));
  const mcpStore = extensionModule.__ensureSolomapMcpStore('/workspace/app', mcpStoreRoot);
  assert.ok(fs.existsSync(path.join(mcpStore.mcpRoot, 'servers')));
  assert.ok(fs.existsSync(path.join(mcpStore.mcpRoot, 'runs')));
  assert.ok(fs.existsSync(path.join(mcpStore.mcpRoot, 'profiles')));
  extensionModule.__writeSolomapMcpRegistry('/workspace/app', mcpStoreRoot, {
    version: 1,
    updatedAt: '',
    connectors: [{
      id: 'github-readonly',
      title: 'GitHub Readonly',
      description: 'Read GitHub issues and pull requests.',
      status: 'installed',
      configPath: 'servers/github-readonly/solomap.mcp.json',
      activation: { keywords: ['GitHub', 'Issue'], useWhen: ['任务需要读取 GitHub Issue 背景'] },
      permissions: { tools: ['issues.list'], requiresCredentials: false, externalAccess: true, writeAccess: false },
      risk: { level: 'low', requiresExplicitEnable: false }
    }, {
      id: 'email-sender',
      title: 'Email Sender',
      status: 'installed',
      activation: { keywords: ['email'] },
      risk: { level: 'high', canSendMessages: true, requiresExplicitEnable: true }
    }]
  });
  const mcpInstructions = extensionModule.__buildSolomapMcpCandidateInstructions('/workspace/app', mcpStoreRoot, '读取 GitHub Issue 来判断当前任务背景');
  assert.match(mcpInstructions, /GitHub Readonly/);
  assert.match(mcpInstructions, /issues\.list/);
  assert.match(mcpInstructions, /这些只是候选能力连接器/);
  assert.doesNotMatch(mcpInstructions, /Email Sender/);

  const mcpInstallPrompt = extensionModule.__buildMcpInstallPrompt('https://github.com/owner/mcp-server', '/workspace/app', mcpStoreRoot, path.join(mcpStore.runsRoot, 'run', 'result.json'));
  assert.match(mcpInstallPrompt, /跨 Agent 通用 MCP 能力连接器/);
  assert.match(mcpInstallPrompt, /solomap\.mcp\.json/);
  assert.match(mcpInstallPrompt, /不要启动 MCP server/);
  assert.match(mcpInstallPrompt, /profiles/);

  const fakeMcpDir = path.join(mcpStore.mcpRoot, 'servers', 'github-readonly');
  fs.mkdirSync(path.join(fakeMcpDir, 'package'), { recursive: true });
  fs.mkdirSync(path.join(fakeMcpDir, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(fakeMcpDir, 'solomap.mcp.json'), JSON.stringify({
    id: 'github-readonly',
    title: 'GitHub Readonly',
    description: 'Read GitHub issues.',
    status: 'installed',
    activation: { keywords: ['GitHub'], useWhen: ['GitHub Issue context'] },
    permissions: { tools: ['issues.list'], requiresCredentials: false, externalAccess: true, writeAccess: false },
    risk: { level: 'low', requiresExplicitEnable: false }
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(fakeMcpDir, 'source.lock.json'), JSON.stringify({ source: 'owner/mcp-server' }, null, 2), 'utf8');
  const fakeMcpResultPath = path.join(mcpStore.runsRoot, 'fake-result.json');
  fs.writeFileSync(fakeMcpResultPath, JSON.stringify({
    ok: true,
    mcpId: 'github-readonly',
    installedPath: fakeMcpDir,
    packagePath: path.join(fakeMcpDir, 'package'),
    solomapMcpJson: path.join(fakeMcpDir, 'solomap.mcp.json'),
    sourceLockJson: path.join(fakeMcpDir, 'source.lock.json'),
    profilesPath: path.join(fakeMcpDir, 'profiles'),
    metadata: { name: 'github-readonly', description: 'Read GitHub issues.' },
    permissions: { tools: ['issues.list'], requiresCredentials: false },
    risk: { level: 'low', requiresExplicitEnable: false }
  }, null, 2), 'utf8');
  const mcpValidation = extensionModule.__validateAndRegisterMcpInstall('/workspace/app', mcpStoreRoot, fakeMcpResultPath);
  assert.equal(mcpValidation.ok, true);
  const mcpRegistryAfterValidation = extensionModule.__readSolomapMcpRegistry('/workspace/app', mcpStoreRoot);
  assert.equal(mcpRegistryAfterValidation.connectors.some((connector) => connector.id === 'github-readonly'), true);

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
  assert.match(fs.readFileSync(agyShellScript.runScriptPath, 'utf8'), /Read the complete SoloMap task prompt from .*prompt\.txt/);
  assert.doesNotMatch(fs.readFileSync(agyShellScript.runScriptPath, 'utf8'), /agy' --print .*"\$agent_prompt"/);
  assert.doesNotMatch(fs.readFileSync(agyShellScript.runScriptPath, 'utf8'), /@prompt-file/);

  const claudeShellScript = extensionModule.__buildAgentShellScript(
    'claude',
    'Ship the MVP',
    fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-claude-shell-')),
    '2',
    44,
    ''
  );
  assert.match(fs.readFileSync(claudeShellScript.runScriptPath, 'utf8'), /Read the complete SoloMap task prompt from .*prompt\.txt/);
  assert.doesNotMatch(fs.readFileSync(claudeShellScript.runScriptPath, 'utf8'), /\$\(cat .*prompt\.txt/);
  assert.doesNotMatch(fs.readFileSync(claudeShellScript.runScriptPath, 'utf8'), /claude' .*"\$agent_prompt"/);

  const copilotShellScript = extensionModule.__buildAgentShellScript(
    'copilot',
    'Ship the MVP',
    fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-copilot-shell-')),
    '2',
    45,
    ''
  );
  assert.match(fs.readFileSync(copilotShellScript.runScriptPath, 'utf8'), /Read the complete SoloMap task prompt from .*prompt\.txt/);
  assert.doesNotMatch(fs.readFileSync(copilotShellScript.runScriptPath, 'utf8'), /\$\(cat .*prompt\.txt/);
  assert.doesNotMatch(fs.readFileSync(copilotShellScript.runScriptPath, 'utf8'), /copilot' .*"\$agent_prompt"/);

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
  assert.match(prompt, /SoloMap 默认系统提示词/);
  assert.match(prompt, /\.solomap-global\/memory/);
  assert.match(prompt, /待沉淀候选目录/);

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
    'Always preserve public API compatibility.',
    '',
    path.join(attachedRoot, '.solomap-global')
  );
  assert.match(attachedPrompt, /用户为本次对话选择了补充文件/);
  assert.match(attachedPrompt, /docs\/brief\.md/);
  assert.doesNotMatch(attachedPrompt, /\.\.\/outside\.md/);
  assert.match(attachedPrompt, /用户设置的全局默认要求/);
  assert.match(attachedPrompt, /Always preserve public API compatibility/);
  assert.match(attachedPrompt, /本次用户补充为准/);
  assert.match(attachedPrompt, /本环节完成标准/);
  assert.match(attachedPrompt, new RegExp(`${attachedRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/\\.solomap-global\\/memory`));
  const issueContextPrompt = extensionModule.__buildAgentConversationPrompt(
    {
      title: 'Fix onboarding bug',
      stage: '产品与 MVP',
      description: 'Resolve high priority onboarding defects.',
      agentPrompt: 'Fix the onboarding flow.',
      status: 'In Progress'
    },
    '',
    attachedRoot,
    path.join(attachedRoot, '.solopreneur', 'step-memory', '2.json'),
    path.join(attachedRoot, '.solopreneur', 'agent-runs', '2'),
    path.join(attachedRoot, '.solopreneur', 'agent-runs', '2', 'completion.json'),
    '',
    [],
    '',
    '当前环节关联的 GitHub Issues：\n\n### Issue #12: 页面加载慢\n最近评论：\n1. user: P0'
  );
  assert.match(issueContextPrompt, /当前环节关联的 GitHub Issues/);
  assert.match(issueContextPrompt, /Issue #12: 页面加载慢/);
  assert.match(followupPrompt, /\.solopreneur\/agent-runs\/2/);
  assert.doesNotMatch(followupPrompt, /\/workspace\/app\/\.solopreneur\/agent-runs\/2\/completion\.json/);
  assert.doesNotMatch(followupPrompt, /该环节交接总结 JSON/);
  assert.doesNotMatch(followupPrompt, /Old handoff should not be injected/);
  assert.doesNotMatch(followupPrompt, /继续当前路线图环节的原生 Agent 会话/);

  const revisionPrompt = extensionModule.__buildRoadmapRevisionPrompt(
    '将发布准备提前，并增加支付验证环节。',
    '/workspace/app',
    'Always run focused checks.',
    [],
    '/workspace/.solomap-global'
  );
  assert.match(revisionPrompt, /本次路线图调整要求（最高优先级）/);
  assert.match(revisionPrompt, /将发布准备提前，并增加支付验证环节/);
  assert.match(revisionPrompt, /直接更新项目目录中的 `\.solopreneur\/roadmap\.csv`/);
  assert.match(revisionPrompt, /不要把本段提示词、解释文字或执行日志写进 CSV/);
  assert.match(revisionPrompt, /面向外部用户并需要获客或转化/);
  assert.match(revisionPrompt, /不要虚构营销或销售任务/);
  assert.match(revisionPrompt, /Always run focused checks/);
  assert.match(revisionPrompt, /SoloMap 默认系统提示词/);
  assert.match(revisionPrompt, /\/workspace\/\.solomap-global\/memory/);

  const soloPrompt = extensionModule.__buildSoloConversationPrompt(
    '帮我判断这个文案方向。',
    '/workspace/app',
    'Keep answers brief.',
    [],
    '/workspace/.solomap-global'
  );
  assert.match(soloPrompt, /Solo 模式/);
  assert.match(soloPrompt, /尚未归属于任何路线图环节/);
  assert.match(soloPrompt, /不要求产生文件修改/);
  assert.match(soloPrompt, /关联某个已有环节/);
  assert.match(soloPrompt, /Keep answers brief/);
  assert.match(soloPrompt, /SoloMap 默认系统提示词/);
  assert.match(soloPrompt, /\/workspace\/\.solomap-global\/memory/);
  assert.doesNotMatch(soloPrompt, /本环节完成标准/);

  const soloAttachmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-solo-attached-files-'));
  fs.mkdirSync(path.join(soloAttachmentRoot, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(soloAttachmentRoot, 'docs', 'brief.md'), 'Brief', 'utf8');
  const attachedSoloPrompt = extensionModule.__buildSoloConversationPrompt(
    '根据补充资料判断方向。',
    soloAttachmentRoot,
    '',
    ['docs/brief.md', '../outside.md']
  );
  assert.match(attachedSoloPrompt, /用户为本次 Solo 对话选择了补充文件/);
  assert.match(attachedSoloPrompt, /docs\/brief\.md/);
  assert.doesNotMatch(attachedSoloPrompt, /\.\.\/outside\.md/);

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
    extensionModule.__extractNativeSessionIdFromExecutionOutput('Native Agent session saved: .solopreneur/step-sessions/2.json (3350a3b7-7761-4ed5-9661-2e9c9de8f924)'),
    '3350a3b7-7761-4ed5-9661-2e9c9de8f924'
  );
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

  const soloRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-solo-agent-'));
  const soloRun = extensionModule.__buildAgentShellScript('agy', 'printf ok', soloRoot, '__solo__', 71, 'brainstorm', undefined, '', 'printf ok', 'solo');
  childProcess.execSync(soloRun.finalCommand, { cwd: soloRoot, stdio: 'ignore' });
  const soloStatus = JSON.parse(fs.readFileSync(path.join(soloRoot, '.agent_status.json'), 'utf8'));
  assert.equal(soloStatus.status, 'In Progress');
  assert.equal(soloStatus.runKind, 'solo');

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
  assert.match(invalidBootstrap.reason, /环节数量不在 2 到 8 个之间|残留了初始化提示词|保留了原始 bootstrap 节点/);

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
    '10,确认迁移边界,整理系统约束与验收条件,范围确认,,agy,创建 docs/migration-scope.md,Pending,2026-01-01T00:00:00.000Z,',
    '20,执行数据迁移,完成可验证迁移脚本,迁移交付,10,agy,修改 scripts/migrate.js 并运行验证,Pending,2026-01-01T00:00:00.000Z,',
    '30,验证回滚与验收,保存验收记录,验收与复盘,20,agy,创建 docs/migration-verification.md,Pending,2026-01-01T00:00:00.000Z,'
  ].join('\n'));
  assert.equal(extensionModule.__validateBootstrapRoadmapRewrite(validBootstrapRoot, '1').valid, true);

  fs.writeFileSync(path.join(validBootstrapRoot, '.solopreneur', 'roadmap.csv'), [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '10,确认迁移边界,整理验收条件,范围确认,,agy,创建 docs/migration-scope.md,Pending,2026-01-01T00:00:00.000Z,',
    '20,执行数据迁移,完成迁移脚本,迁移交付,404,agy,修改 scripts/migrate.js 并运行验证,Pending,2026-01-01T00:00:00.000Z,'
  ].join('\n'));
  assert.match(extensionModule.__validateBootstrapRoadmapRewrite(validBootstrapRoot, '1').reason, /无效依赖/);

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
    '10,确认内部迁移目标,整理验收边界,范围确认,,agy,创建 docs/migration-scope.md,Completed,2026-01-01T00:00:00.000Z,2026-01-02T00:00:00.000Z',
    '20,验证迁移工具,完成验证结果,交付与验收,10,agy,运行迁移校验并记录结果,Pending,2026-01-01T00:00:00.000Z,'
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
  assert.match(bootstrapInstructions, /按项目真实目标选择适用的推进框架/);
  assert.match(bootstrapInstructions, /内部工具、迁移、研究、内容或基础设施项目不得被强行改写成营销销售路线/);
  assert.match(bootstrapInstructions, /Build -> Sell -> Learn -> Improve 作为底层审查/);
  assert.match(bootstrapInstructions, /不要把本文件内容、提示词模板或解释性说明写回 CSV/);
  assert.match(methodologyInstructions, /商业化产品的默认四阶段/);
  assert.match(methodologyInstructions, /底层判断模型/);
  assert.match(methodologyInstructions, /不要为了满足模板/);
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
  assert.match(html, /methodology-overview/);
  assert.match(html, /methodology-stage-card/);
  assert.match(html, /data-open-roadmap-revision/);
  const source = fs.readFileSync(path.join(projectRoot, 'src', 'extension.ts'), 'utf8');
  assert.match(source, /当前项目交付信号/);
  assert.match(source, /'3'/);
  assert.match(source, /'run',\s*'list'/);
  assert.match(source, /'release',\s*'list'/);
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
  assert.match(nodes[0].title, /生成初始路线图/);
  assert.match(nodes[0].agentPrompt, /\.solopreneur\/bootstrap-roadmap-instructions\.md/);
  assert.doesNotMatch(nodes[0].agentPrompt, /字段顺序必须严格是/);
  assert.ok(nodes.some((node) => node.agentPrompt.includes('docs/project-brief.md')));
  assert.deepEqual([...new Set(nodes.map((node) => node.stage))], ['目标与路径确认', '交付与验证', '结果反馈与迭代']);
});

test('new empty project seed does not assume a commercial product workflow', async () => {
  const { SyncEngine } = require(path.join(projectRoot, 'out/db/syncEngine.js'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-neutral-seed-'));
  const solopreneurDir = path.join(tempRoot, '.solopreneur');
  fs.mkdirSync(solopreneurDir, { recursive: true });
  const engine = new SyncEngine(
    path.join(solopreneurDir, 'roadmap.csv'),
    path.join(solopreneurDir, 'project_journal.db'),
    projectRoot
  );

  await engine.initAndSync();
  const nodes = engine.getNodes();

  assert.equal(nodes.length, 4);
  assert.ok(nodes.some((node) => node.title === '明确交付目标与成功标准'));
  assert.ok(nodes.some((node) => node.agentPrompt.includes('docs/project-brief.md')));
  assert.equal(nodes.some((node) => node.stage === '营销与销售'), false);
  assert.equal(nodes.some((node) => node.stage === '反馈与规模化'), false);
});

test('sync engine does not rewrite the journal when roadmap csv is unchanged', async () => {
  const { SyncEngine } = require(path.join(projectRoot, 'out/db/syncEngine.js'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-sync-no-rewrite-'));
  const solopreneurDir = path.join(tempRoot, '.solopreneur');
  const csvPath = path.join(solopreneurDir, 'roadmap.csv');
  const dbPath = path.join(solopreneurDir, 'project_journal.db');
  fs.mkdirSync(solopreneurDir, { recursive: true });
  fs.writeFileSync(csvPath, [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '1,Plan,,目标与路径确认,,agy,,Pending,2026-01-01T00:00:00.000Z,'
  ].join('\n'));

  const firstEngine = new SyncEngine(csvPath, dbPath, projectRoot);
  await firstEngine.initAndSync();
  const oldTime = new Date('2026-01-01T00:00:00.000Z');
  fs.utimesSync(dbPath, oldTime, oldTime);

  const secondEngine = new SyncEngine(csvPath, dbPath, projectRoot);
  await secondEngine.initAndSync();

  assert.equal(fs.statSync(dbPath).mtimeMs, oldTime.getTime());
  assert.equal(secondEngine.getNodes()[0].title, 'Plan');
});

test('step conversation can start while roadmap dependencies are still incomplete', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__handleRunAgent = handleRunAgent;',
      'module.exports.__setRuntimeForTest = (engine, projectRoot) => { syncEngine = engine; activeProjectRoot = projectRoot; };'
    ].join('\n')
  );
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-parallel-conversation-'));
  const updates = [];
  const executionLogs = [];
  const nodes = [
    {
      id: '1',
      title: 'Validate customer need',
      description: 'Talk to early users.',
      stage: '问题与客户发现',
      dependencies: '',
      agentCli: 'codex',
      agentPrompt: 'Create interview notes.',
      status: 'Pending',
      createdAt: '',
      completedAt: ''
    },
    {
      id: '2',
      title: 'Draft MVP',
      description: 'Prepare the first product slice.',
      stage: '产品与 MVP',
      dependencies: '1',
      agentCli: 'codex',
      agentPrompt: 'Draft an MVP scope document.',
      status: 'Pending',
      createdAt: '',
      completedAt: ''
    }
  ];
  extensionModule.__setRuntimeForTest({
    initAndSync: async () => {},
    getNodes: () => nodes,
    updateNode: (nodeId, update) => updates.push({ nodeId, update }),
    logAgentExecution: (nodeId, agentCli, command, output, status) => {
      executionLogs.push({ nodeId, agentCli, command, output, status });
      return 41;
    },
    getAgentExecutions: () => []
  }, projectRoot);

  await extensionModule.__handleRunAgent({
    globalState: {
      get: () => ({ cliPath: 'codex', language: 'zh', globalPrompt: '' })
    }
  }, '2', '先讨论可交付的 MVP 范围。', 'codex');

  assert.ok(updates.some((entry) => entry.nodeId === '2' && entry.update.status === 'Running'));
  assert.equal(executionLogs.length, 1);
  assert.equal(executionLogs[0].nodeId, '2');
  assert.equal(executionLogs[0].status, 'Running');
  assert.ok(fs.existsSync(path.join(projectRoot, '.solopreneur', 'agent-runs', '2', 'run-agent.sh')));
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

test('manual completion immediately persists the user decision for an active Agent run', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__completeNodeManually = completeNodeManually;',
      'module.exports.__setRuntimeForTest = (engine, projectRoot) => { syncEngine = engine; activeProjectRoot = projectRoot; };'
    ].join('\n')
  );
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-manual-action-'));
  const runDir = path.join(tempRoot, '.solopreneur', 'agent-runs', '2');
  fs.mkdirSync(runDir, { recursive: true });
  const completionDecisionFilePath = path.join(runDir, 'completion.json');
  fs.writeFileSync(completionDecisionFilePath, '{"markCompleted":false}', 'utf8');
  fs.writeFileSync(path.join(tempRoot, '.agent_status.json'), JSON.stringify({
    nodeId: '2',
    status: 'Running',
    completionDecisionFilePath
  }), 'utf8');
  let nodeUpdate = null;
  extensionModule.__setRuntimeForTest({
    getNodes: () => [],
    updateNode: (_nodeId, update) => { nodeUpdate = update; }
  }, tempRoot);

  extensionModule.__completeNodeManually('2');

  assert.equal(nodeUpdate.status, 'Completed');
  const decision = JSON.parse(fs.readFileSync(completionDecisionFilePath, 'utf8'));
  assert.equal(decision.markCompleted, true);
  assert.equal(decision.source, 'user');
});

test('manual completion is not overwritten when an in-flight Agent run refreshes the roadmap afterward', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__processAgentStatusFile = processAgentStatusFile;',
      'module.exports.__setRuntimeForTest = (engine, projectRoot) => { syncEngine = engine; activeProjectRoot = projectRoot; };'
    ].join('\n')
  );
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-manual-complete-'));
  const runDir = path.join(tempRoot, '.solopreneur', 'agent-runs', '2');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'completion.json'), '{"markCompleted":false}', 'utf8');
  fs.writeFileSync(path.join(runDir, 'changes.txt'), 'M .solopreneur/roadmap.csv\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'touched-files.txt'), 'M .solopreneur/roadmap.csv\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'output.log'), 'Agent finished additional work.\n', 'utf8');
  const statusFilePath = path.join(tempRoot, '.agent_status.json');
  fs.writeFileSync(statusFilePath, JSON.stringify({
    nodeId: '2',
    status: 'In Progress',
    agentCli: 'codex',
    executionLogId: 10,
    outputFilePath: path.join(runDir, 'output.log'),
    changesFilePath: path.join(runDir, 'changes.txt'),
    touchedFilesPath: path.join(runDir, 'touched-files.txt'),
    completionDecisionFilePath: path.join(runDir, 'completion.json')
  }), 'utf8');

  let nodes = [{ id: '2', title: '实现 MVP', status: 'Completed', completedAt: '2026-05-25T00:00:00.000Z' }];
  let nodeUpdate = null;
  let refreshed = false;
  let loggedStatus = '';
  extensionModule.__setRuntimeForTest({
    getNodes: () => nodes,
    updateNode: (_nodeId, update) => {
      nodeUpdate = update;
      nodes = [{ ...nodes[0], ...update }];
    },
    initAndSync: async () => {
      refreshed = true;
      nodes = [{ id: '2', title: '实现 MVP', status: 'Pending', completedAt: '' }];
    },
    updateAgentExecution: (_id, _cli, _command, _output, status) => {
      loggedStatus = status;
      return true;
    },
    logAgentExecution: () => 1,
    getAgentExecutions: () => []
  }, tempRoot);

  await extensionModule.__processAgentStatusFile(statusFilePath);

  assert.equal(refreshed, true);
  assert.equal(nodeUpdate.status, 'Completed');
  assert.equal(nodes[0].status, 'Completed');
  assert.equal(loggedStatus, 'In Progress');
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

test('Solo completion stays project-scoped and preserves the existing roadmap', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__processAgentStatusFile = processAgentStatusFile;',
      'module.exports.__setRuntimeForTest = (engine, projectRoot) => { syncEngine = engine; activeProjectRoot = projectRoot; };'
    ].join('\n')
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-solo-completion-'));
  const solopreneurDir = path.join(root, '.solopreneur');
  const runDir = path.join(solopreneurDir, 'agent-runs', '__solo__');
  fs.mkdirSync(runDir, { recursive: true });
  const originalCsv = [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '2,实现 MVP,完成可运行切片,产品与 MVP,,codex,Ship MVP,In Progress,2026-01-01T00:00:00.000Z,'
  ].join('\n');
  fs.writeFileSync(path.join(solopreneurDir, 'roadmap.csv'), originalCsv.replace('实现 MVP', 'Changed without permission'), 'utf8');
  fs.writeFileSync(path.join(runDir, 'roadmap-before.csv'), originalCsv, 'utf8');
  fs.writeFileSync(path.join(runDir, 'changes.txt'), 'M .solopreneur/roadmap.csv\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'touched-files.txt'), 'M .solopreneur/roadmap.csv\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'output.log'), '建议将这个想法留在 Solo。\n', 'utf8');
  const statusFilePath = path.join(root, '.agent_status.json');
  fs.writeFileSync(statusFilePath, JSON.stringify({
    nodeId: '__solo__',
    runKind: 'solo',
    roadmapBackupFilePath: path.join(runDir, 'roadmap-before.csv'),
    status: 'In Progress',
    agentCli: 'codex',
    executionLogId: 77,
    outputFilePath: path.join(runDir, 'output.log'),
    changesFilePath: path.join(runDir, 'changes.txt'),
    touchedFilesPath: path.join(runDir, 'touched-files.txt')
  }), 'utf8');

  let loggedOutput = '';
  let loggedStatus = '';
  extensionModule.__setRuntimeForTest({
    getNodes: () => [{ id: '2', title: '实现 MVP', status: 'In Progress' }],
    updateNode: () => { throw new Error('Solo conversation must not update a roadmap node'); },
    updateAgentExecution: (_id, _cli, _command, output, status) => {
      loggedOutput = output;
      loggedStatus = status;
      return true;
    },
    logAgentExecution: () => 77,
    getAgentExecutions: () => []
  }, root);

  await extensionModule.__processAgentStatusFile(statusFilePath);

  assert.equal(loggedStatus, 'Completed');
  assert.match(loggedOutput, /Solo conversation state: Completed/);
  assert.match(loggedOutput, /等待用户决定是否关联到路线图环节/);
  assert.match(loggedOutput, /Solo 对话不会直接调整路线图/);
  assert.equal(fs.readFileSync(path.join(solopreneurDir, 'roadmap.csv'), 'utf8'), originalCsv);
});

test('linking a Solo conversation records a reference without changing the step state', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__linkSoloConversationToNode = linkSoloConversationToNode;',
      'module.exports.__setRuntimeForTest = (engine, projectRoot) => { syncEngine = engine; activeProjectRoot = projectRoot; };'
    ].join('\n')
  );
  let linkedRecord = null;
  extensionModule.__setRuntimeForTest({
    getNodes: () => [{ id: '2', title: '实现 MVP', status: 'In Progress' }],
    updateNode: () => { throw new Error('linking a Solo reference must not change step status'); },
    getAgentExecutions: (nodeId) => nodeId === '__solo__'
      ? [{ id: 12, nodeId, agentCli: 'codex', command: 'codex exec', output: '结论：关联实现 MVP。', status: 'Completed' }]
      : [],
    logAgentExecution: (nodeId, agentCli, command, output, status) => {
      linkedRecord = { nodeId, agentCli, command, output, status };
      return 88;
    }
  }, '/workspace/app');

  extensionModule.__linkSoloConversationToNode(12, '2');

  assert.equal(linkedRecord.nodeId, '2');
  assert.equal(linkedRecord.status, 'Linked');
  assert.match(linkedRecord.output, /Linked from Solo conversation/);
  assert.match(linkedRecord.output, /Solo reference ID: 12/);
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
