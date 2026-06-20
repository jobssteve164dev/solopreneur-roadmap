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
  const vscodeTestState = {
    informationMessages: [],
    warningMessages: [],
    openedExternal: [],
    webviewPanels: [],
    uriHandlers: [],
    secrets: new Map(),
    nextInformationChoice: undefined,
    nextInformationChoices: [],
    nextInputBoxValue: undefined,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) })
  };
  const context = {
    exports,
    module,
    require: (id) => {
      if (id === 'child_process') {
        const cp = require('child_process');
        return new Proxy(cp, {
          get(target, prop) {
            if (prop === 'execFileSync') {
              return (file, args, options) => {
                if (args && args.some(arg => typeof arg === 'string' && (arg.includes('caveman') || arg.includes('caveman-shrink')))) {
                  return '0.1.0';
                }
                return cp.execFileSync(file, args, options);
              };
            }
            return target[prop];
          }
        });
      }
      if (id === 'vscode') {
        return {
          Uri: {
            parse: createUri,
            file: createUri,
            joinPath(base, ...segments) {
              return createUri(path.join(base.fsPath || base.path || String(base), ...segments));
            }
          },
          window: {
            terminals: [],
            showInformationMessage(message, ...items) {
              vscodeTestState.informationMessages.push({ message, items });
              if (vscodeTestState.nextInformationChoices.length > 0) {
                return Promise.resolve(vscodeTestState.nextInformationChoices.shift());
              }
              return Promise.resolve(vscodeTestState.nextInformationChoice);
            },
            showInputBox(options) {
              vscodeTestState.inputBoxOptions = options;
              return Promise.resolve(vscodeTestState.nextInputBoxValue);
            },
            showWarningMessage(message, ...items) {
              vscodeTestState.warningMessages.push({ message, items });
              return Promise.resolve(undefined);
            },
            showErrorMessage() {},
            createWebviewPanel(viewType, title) {
              const panel = {
                viewType,
                title,
                webview: {
                  html: '',
                  asWebviewUri(uri) {
                    return String(uri && (uri.fsPath || uri.path || uri));
                  },
                  onDidReceiveMessage() {}
                },
                reveal() {},
                onDidDispose() {}
              };
              vscodeTestState.webviewPanels.push(panel);
              return panel;
            },
            registerUriHandler(handler) {
              vscodeTestState.uriHandlers.push(handler);
              return { dispose() {} };
            },
            createTerminal() {
              return {
                name: 'Agent Console · test',
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
          env: {
            uriScheme: 'vscode',
            openExternal(uri) {
              vscodeTestState.openedExternal.push(String(uri && (uri.fsPath || uri.path || uri)));
              return Promise.resolve(true);
            }
          },
          ViewColumn: { One: 1 },
          ThemeIcon: class ThemeIcon {},
          ThemeColor: class ThemeColor {}
        };
      }
      if (id.startsWith('./')) {
        if (id === './documentationManifest') {
          return require(path.join(projectRoot, 'out/documentationManifest.js'));
        }
        if (id === './agentImpact') {
          return require(path.join(projectRoot, 'out/agentImpact.js'));
        }
        if (id === './flowStore') {
          return require(path.join(projectRoot, 'out/flowStore.js'));
        }
        if (id === './learningLedger') {
          return require(path.join(projectRoot, 'out/learningLedger.js'));
        }
        if (id === './projectSignals') {
          return require(path.join(projectRoot, 'out/projectSignals.js'));
        }
        if (id === './projectFoundation') {
          return require(path.join(projectRoot, 'out/projectFoundation.js'));
        }
        if (id === './roadmapWebview') {
          return require(path.join(projectRoot, 'out/roadmapWebview.js'));
        }
        if (id === './strategyPyramidWebview') {
          return require(path.join(projectRoot, 'out/strategyPyramidWebview.js'));
        }
        if (id === './strategyPyramid') {
          return require(path.join(projectRoot, 'out/strategyPyramid.js'));
        }
        if (id === './runDigest') {
          return require(path.join(projectRoot, 'out/runDigest.js'));
        }
        if (id === './solomapGlobal') {
          return loadCompiledModule('out/solomapGlobal.js', '');
        }
        if (id === './agentCli') {
          return require(path.join(projectRoot, 'out/agentCli.js'));
        }
        if (id === './continuation') {
          return require(path.join(projectRoot, 'out/continuation.js'));
        }
        return {};
      }
      return require(id);
    },
    console,
    process,
    URL,
    URLSearchParams,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: (...args) => vscodeTestState.fetchImpl(...args),
    __dirname: path.dirname(filename),
    __filename: filename
  };

  vm.runInNewContext(source, context, { filename });
  context.module.exports.__vscodeTestState = vscodeTestState;
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

function runScriptWithMinimalDom(script, ids, scriptSuffix = '') {
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
  wireSoloSelect(elements['project-type-select'], [
    { value: 'core_product', label: '核心产品' },
    { value: 'content_product', label: '内容产品' },
    { value: 'infrastructure', label: '基础设施' },
    { value: 'research', label: '试验研究' },
    { value: 'tooling', label: '工具脚手架' },
    { value: 'maintenance', label: '归档维护' }
  ]);
  wireSoloSelect(elements['project-priority-select'], [
    { value: 'P0', label: 'P0' },
    { value: 'P1', label: 'P1' },
    { value: 'P2', label: 'P2' },
    { value: 'P3', label: 'P3' }
  ]);
  wireSoloSelect(elements['setting-ability-select'], []);
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
    setTimeout,
    clearTimeout,
    acquireVsCodeApi: () => ({
      postMessage: (message) => postedMessages.push(message)
    })
  };

  vm.runInNewContext(script + '\n' + scriptSuffix, context);
  return {
    elements,
    postedMessages,
    context,
    dispatchMessage(message) {
      context.__messageListener({ data: message });
    }
  };
}

test('extension manifest uses SoloMap visible branding', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

  assert.equal(manifest.displayName, 'SoloMap - Local AI Agent Cockpit & Coding Roadmap Assistant');
  assert.equal(manifest.description, 'Stop losing momentum in scattered AI chats. SoloMap is a local AI Agent cockpit and coding roadmap assistant for solo developers. / 别让项目迷失在零散 AI 对话里。SoloMap 是专为独立开发者打造的本地 AI Agent 驾驶舱与编码路线图助手。');
  assert.deepEqual(manifest.categories, ['AI', 'Chat', 'Machine Learning', 'Visualization', 'Other']);
  assert.ok(manifest.keywords.includes('ai-agent'));
  assert.ok(manifest.keywords.includes('ai-coding'));
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
  assert.equal(manifest.contributes.configuration.properties['solopreneur.taskPermissionMode'], undefined);
});

test('ability settings copy is localized in English webviews', () => {
  const sources = [
    fs.readFileSync(path.join(projectRoot, 'src', 'roadmapWebview.ts'), 'utf8'),
    fs.readFileSync(path.join(projectRoot, 'src', 'sidebarProvider.ts'), 'utf8')
  ];

  for (const source of sources) {
    assert.match(source, /abilityManagerLabel:\s*'Ability Extensions & Execution Enhancements'/);
    assert.match(source, /abilityGroupSkills:\s*'Skills'/);
    assert.match(source, /abilityGroupConnectors:\s*'MCP Connectors'/);
    assert.match(source, /abilityGroupEnhancements:\s*'Execution Enhancements'/);
    assert.match(source, /skillInputRequired:\s*'Enter a skill link before installing\.'/);
    assert.match(source, /showAbilityActionMessage\(t\('installingEnhancementMessage'\)\)/);
    assert.doesNotMatch(source, /setText\('label-enhancement-toggles',\s*'能力扩展与执行增强'\)/);
    assert.doesNotMatch(source, /setText\('text-install-ability',\s*'安装'\)/);
    assert.doesNotMatch(source, /statusLabel:\s*'已安装'/);
    assert.doesNotMatch(source, /showAbilityActionMessage\('正在安装/);
  }
});

test('website-only changes do not trigger extension publishing', () => {
  const publishWorkflow = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'publish.yml'), 'utf8');
  const websiteWorkflow = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'deploy-website.yml'), 'utf8');

  assert.doesNotMatch(publishWorkflow, /-\s*'website\/\*\*'/);
  assert.doesNotMatch(publishWorkflow, /-\s*'\.github\/workflows\/deploy-website\.yml'/);
  assert.match(publishWorkflow, /id:\s*extension_changes/);
  assert.match(publishWorkflow, /should_publish=false/);
  assert.match(websiteWorkflow, /-\s*'website\/\*\*'/);
});

test('readme uses bilingual marketplace copy and marketplace-compatible remote logo', () => {
  const readme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8');

  assert.match(readme, /raw\.githubusercontent\.com\/jobssteve164dev\/solopreneur-roadmap\/main\/resources\/logo_with_text\.png/);
  assert.match(readme, /Are you suffering from "AI Chat Hell"\? \/ 你是否正陷入“AI 乱聊地狱”？/);
  assert.match(readme, /Core Capabilities \/ 核心能力/);
  assert.match(readme, /Quick Start \/ 快速开始/);
  assert.match(readme, /Integrated Agent CLIs \/ 本地 Agent 支持/);
  assert.match(readme, /Privacy & Architecture \/ 本地数据结构/);
  assert.match(readme, /Privacy/);
  assert.match(readme, /Feedback/);
});

test('feedback issue URL includes local usage summary when provided', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    'module.exports.__buildFeedbackIssueUrl = projectSignals_1.buildFeedbackIssueUrl;'
  );
  const url = new URL(extensionModule.__buildFeedbackIssueUrl(
    '加载问题',
    '侧边栏打开后没有继续动作。',
    'not_working',
    'Counters:\\n- Activations: 2\\nPrivacy:\\n- No project paths included.'
  ));

  assert.equal(url.searchParams.get('template'), 'seed-user-feedback.yml');
  assert.equal(url.searchParams.get('labels'), 'feedback,seed-user');
  assert.equal(url.searchParams.get('title'), '加载问题');
  assert.equal(url.searchParams.get('what_happened'), '侧边栏打开后没有继续动作。');
  assert.equal(url.searchParams.get('feedback_type'), 'not_working');
  assert.match(url.searchParams.get('local_usage_summary') || '', /Activations: 2/);
  const body = url.searchParams.get('body') || '';
  assert.match(body, /Feedback type: not_working/);
  assert.match(body, /侧边栏打开后没有继续动作。/);
  assert.match(body, /Local usage summary:/);
  assert.match(body, /Activations: 2/);
  assert.match(body, /No project paths included/);
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

test('attachment picker candidates are local project files and skip run artifacts', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    'module.exports.__listProjectAttachmentCandidates = listProjectAttachmentCandidates;'
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-attachment-candidates-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.solopreneur', 'agent-runs', 'step-1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'readme', 'utf8');
  fs.writeFileSync(path.join(root, 'docs', 'brief.md'), 'brief', 'utf8');
  fs.writeFileSync(path.join(root, '.solopreneur', 'agent-runs', 'step-1', 'output.log'), 'log', 'utf8');

  const files = extensionModule.__listProjectAttachmentCandidates(root);

  assert.ok(files.includes('README.md'));
  assert.ok(files.includes('docs/brief.md'));
  assert.ok(!files.some((file) => file.startsWith('.solopreneur/agent-runs/')));
  assert.ok(files.every((file) => !path.isAbsolute(file)));
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
  assert.match(html, /id="btn-toggle-feedback"/);
  assert.match(html, /id="feedback-panel"/);
  assert.match(html, /id="btn-open-strategy-pyramid"/);
  assert.doesNotMatch(html, /id="btn-open-full"/);
  assert.doesNotMatch(html, /id="strategy-pyramid-panel"/);
  assert.match(html, /data-open-pro-upgrade/);
  assert.doesNotMatch(html, /id="label-feedback"/);
  assert.match(script, /renderProjectIssuePanel/);
  assert.match(script, /renderProjectDeliveryPanel/);
  assert.match(script, /createIssue/);
  assert.match(script, /closeIssue/);
  assert.match(script, /getIssueDetails/);
  assert.match(script, /refreshProjectData/);
  assert.match(script, /data-refresh-project-path/);
  assert.match(script, /data-toggle-delivery-panel/);
  assert.match(script, /data-agent-fix-delivery-project-path/);
  assert.match(script, /data-agent-fix-security-project-path/);
  assert.match(script, /data-agent-fix-foundation-project-path/);
  assert.match(script, /projectSecurityLoaded/);
  assert.match(script, /securitySignalText/);
  assert.match(script, /foundationSignalText/);
  assert.match(script, /buildSecurityActionPrompt/);
  assert.match(script, /buildFoundationActionPrompt/);
  assert.match(script, /toggleProjectPinned/);
  assert.match(script, /getProjectConversationHistory/);
  assert.match(script, /checksCached/);
  assert.match(html, /id="dependency-panel"/);
  assert.match(html, /id="pro-account-panel"/);
  assert.match(html, /id="btn-open-pro-authorization"/);
  assert.match(html, /id="btn-paste-pro-code"/);
  assert.match(script, /openProAuthorization/);
  assert.match(script, /pasteProAuthorizationCode/);
  assert.match(html, /data-issue-panel/);
  assert.match(html, /data-toggle-issue-form/);

  const { elements, postedMessages, dispatchMessage } = runScriptWithMinimalDom(script, [
    'tasks-list',
    'progress-bar',
    'progress-text',
    'btn-open-strategy-pyramid',
    'project-select',
    'btn-add-project',
    'global-focus-panel',
    'portfolio-title',
    'portfolio-list',
    'portfolio-filters',
    'btn-toggle-feedback',
    'btn-close-feedback',
    'feedback-panel',
    'feedback-title',
    'feedback-type-not-working',
    'feedback-type-next-step',
    'feedback-type-feature',
    'btn-toggle-settings',
    'btn-close-settings',
    'settings-panel',
    'setting-language',
    'setting-cli-select',
    'setting-clipath-custom',
    'setting-global-prompt',
    'setting-global-data-path',
    'pro-account-panel',
    'btn-open-pro-authorization',
    'btn-paste-pro-code',
    'setting-feedback-title',
    'setting-feedback-body',
    'btn-open-feedback',
    'btn-test-cli',
    'btn-save-settings',
    'btn-check-dependencies',
    'btn-open-agent-install',
    'btn-prepare-agent-automation',
    'btn-open-agent-check',
    'btn-open-github-auth',
    'dependency-agent-status',
    'dependency-agent-message',
    'dependency-automation-status',
    'dependency-automation-message',
    'dependency-github-status',
    'dependency-github-message',
    'cli-test-badge'
  ]);

  elements['btn-open-strategy-pyramid'].listeners.click();
  assert.ok(postedMessages.some((message) => message.command === 'showStrategyPyramid'));
  postedMessages.length = 0;

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
  assert.ok(postedMessages.some((message) => message.command === 'updateSettings' && message.language === 'en' && message.globalDataPath === '/workspace/.solomap-global' && !Object.prototype.hasOwnProperty.call(message, 'taskPermissionMode')));
  postedMessages.length = 0;
  elements['btn-open-pro-authorization'].listeners.click();
  elements['btn-paste-pro-code'].listeners.click();
  assert.ok(postedMessages.some((message) => message.command === 'openProAuthorization'));
  assert.ok(postedMessages.some((message) => message.command === 'pasteProAuthorizationCode'));
  elements['btn-check-dependencies'].listeners.click();
  elements['btn-open-agent-install'].listeners.click();
  elements['btn-prepare-agent-automation'].listeners.click();
  elements['btn-open-github-auth'].listeners.click();
  elements['btn-toggle-feedback'].listeners.click();
  assert.equal(elements['feedback-panel'].style.display, 'block');
  elements['setting-feedback-title'].value = '希望加载更快';
  elements['setting-feedback-body'].value = '打开侧边栏时先显示项目。';
  elements['btn-open-feedback'].listeners.click();
  assert.ok(postedMessages.some((message) => message.command === 'checkDependencies'));
  assert.ok(postedMessages.some((message) => message.command === 'openDependencyAction' && message.action === 'agent-install'));
  assert.ok(postedMessages.some((message) => message.command === 'prepareAgentAutomation'));
  assert.ok(postedMessages.some((message) => message.command === 'openDependencyAction' && message.action === 'github-auth'));
  assert.ok(postedMessages.some((message) => message.command === 'openFeedbackIssue' && message.title === '希望加载更快' && message.category === 'not_working'));

  dispatchMessage({
    command: 'settingsLoaded',
    settings: { cliPath: '/workspace/.solomap-global/agent-cli/agy', language: 'zh', globalPrompt: '', globalDataPath: '/workspace/.solomap-global' }
  });
  assert.equal(elements['setting-cli-select'].getAttribute('data-value'), 'agy');
  assert.equal(elements['setting-clipath-custom'].style.display, 'none');
  postedMessages.length = 0;
  elements['btn-save-settings'].listeners.click();
  assert.ok(postedMessages.some((message) => message.command === 'updateSettings' && message.cliPath === '/workspace/.solomap-global/agent-cli/agy'));

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
  assert.match(elements['portfolio-list'].innerHTML, /data-refresh-project-path="\/workspace\/second"/);
  assert.match(elements['portfolio-list'].innerHTML, /codicon-refresh/);
  assert.doesNotMatch(elements['portfolio-list'].innerHTML, /data-expand-issue-number="12"/);
  assert.match(elements['portfolio-list'].innerHTML, /data-project-conversation-mode="continue"/);
  assert.match(elements['portfolio-list'].innerHTML, /data-project-conversation-mode="solo"/);
  assert.match(elements['portfolio-list'].innerHTML, /data-project-conversation-input/);
  assert.doesNotMatch(elements['portfolio-list'].innerHTML, /data-open-pro-upgrade|了解 Pro|Unlock Pro/);

  postedMessages.length = 0;
  elements['project-select'].listeners.click({
    target: elements['project-select'].__options.find((option) => option.getAttribute('data-solo-option-value') === '/workspace/app'),
    stopPropagation() {}
  });
  assert.equal(elements['project-select'].getAttribute('data-value'), '/workspace/app');
  assert.ok(postedMessages.some((message) => message.command === 'selectProject' && message.projectPath === '/workspace/app'));
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
        issues: { available: true, repo: 'owner/repo', total: 0, open: 0, byCategory: {}, byPriority: {}, items: [], message: '' }
      }]
    }
  });
  assert.equal(elements['project-select'].getAttribute('data-value'), '/workspace/app');
  elements['project-select'].listeners.click({
    target: elements['project-select'].__options.find((option) => option.getAttribute('data-solo-option-value') === '/workspace/second'),
    stopPropagation() {}
  });
  assert.ok(postedMessages.some((message) => message.command === 'getProjectConversationHistory' && message.projectPath === '/workspace/second'));
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
        issues: { available: true, repo: 'owner/repo', total: 0, open: 0, byCategory: {}, byPriority: {}, items: [], message: '' }
      }]
    }
  });

  dispatchMessage({
    command: 'settingsLoaded',
    settings: {
      cliPath: '/workspace/.solomap-global/agent-cli/agy',
      language: 'zh',
      globalPrompt: '',
      globalDataPath: '/workspace/.solomap-global',
      proEntitlements: { strategy_pyramid: true }
    }
  });
  assert.doesNotMatch(elements['portfolio-list'].innerHTML, /data-open-pro-upgrade|了解 Pro|Unlock Pro/);
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
  assert.match(elements['portfolio-list'].innerHTML, /最近一次推进|Latest run/);
  assert.match(elements['portfolio-list'].innerHTML, /data-sidebar-step-history/);
  dispatchMessage({
    command: 'sidebarProjectConversationLoaded',
    projectPath: '/workspace/second',
    conversations: [{
      id: 8,
      nodeId: 'another-step',
      agentCli: 'codex',
      status: 'Completed',
      timestamp: '2026-05-26T10:05:00.000Z',
      command: 'codex exec',
      output: 'User supplement:\n收尾另一个环节\n\nTouched project files:\nsrc/home.ts\n\nRun duration ms: 3000\n\nNative Agent session saved: .solopreneur/step-sessions/another-step.json (3350a3b7-7761-4ed5-9661-2e9c9de8f924)\n\nAgent output tail:\n另一个环节已完成。'
    }]
  });
  assert.match(elements['portfolio-list'].innerHTML, /收尾另一个环节/);
  assert.match(elements['portfolio-list'].innerHTML, /sidebar-conversation-latest-container/);
  assert.doesNotMatch(elements['portfolio-list'].innerHTML, /sidebar-conversations-tree-container/);
  assert.match(elements['portfolio-list'].innerHTML, /data-continue-sidebar-step-id="8"/);
  assert.match(elements['portfolio-list'].innerHTML, /data-continue-sidebar-step-node-id="another-step"/);
  assert.match(elements['portfolio-list'].innerHTML, /sidebar-conversation-mini-actions[\s\S]*data-continue-sidebar-step-id="8"/);
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
  assert.match(elements['portfolio-list'].innerHTML, /data-project-conversation-mode="continue"/);
  assert.match(elements['portfolio-list'].innerHTML, /data-project-conversation-mode="solo"/);
  assert.match(elements['portfolio-list'].innerHTML, /data-project-conversation-mode="flow"/);
  assert.match(elements['portfolio-list'].innerHTML, /打开路线大图|Open roadmap/);
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
    'module.exports.__getWebviewHtml = roadmapWebview_1.getWebviewHtml;'
  );
  const html = extensionModule.__getWebviewHtml(createWebviewStub(), { extensionPath: projectRoot, extensionUri: createUri(projectRoot) });
  const script = extractLastScript(html);
  const extensionSource = fs.readFileSync(path.join(projectRoot, 'src/extension.ts'), 'utf8');

  assert.doesNotThrow(() => new vm.Script(script));
  assert.doesNotMatch(html, /<select\b|<option\b/);
  assert.match(html, /data-solo-select/);
  assert.match(script, /renderSoloSelect/);
  assert.match(script, /bindPastedImageAttachments/);
  assert.match(script, /savePastedAttachments/);
  assert.match(script, /conversation-log-pre/);
  assert.ok(script.includes("querySelectorAll('[data-conversation-id] .conversation-row')"));
  assert.match(script, /hasActiveConversationDescendant/);
  assert.match(script, /findConversationRootId/);
  assert.match(script, /findRootByParent/);
  assert.match(script, /data-log-scroll-key/);
  assert.match(script, /captureConversationLogScrollPositions/);
  assert.match(script, /restoreConversationLogScrollPositions/);
  assert.match(script, /conversationLogScrollPositions/);
  assert.match(extensionSource, /resolveContinuationRootConversationFromList/);
  assert.match(extensionSource, /buildContinuationMetadataBlock\(rootConversationId, sessionId\)/);
  assert.match(script, /mousedown[\s\S]*stopPropagation/);
  assert.match(script, /touchstart[\s\S]*stopPropagation/);
  assert.match(script, /pointerdown[\s\S]*stopPropagation/);
  assert.match(html, /overflow:\s*auto !important/);
  assert.match(html, /touch-action:\s*pan-x pan-y/);
  assert.match(html, /\.conversation-children::before/);
  assert.match(html, /\.conversation-list-children/);
  assert.match(script, /runRoadmapRevision[\s\S]*supplementFiles/);
  assert.match(html, /id="btn-toggle-flow"/);
  assert.match(html, /id="flow-panel"/);
  assert.match(html, /id="btn-toggle-feedback"/);
  assert.match(html, /id="feedback-panel"/);
  assert.doesNotMatch(html, /id="label-feedback"/);

  const { elements, postedMessages, dispatchMessage } = runScriptWithMinimalDom(script, [
    'canvas',
    'project-select',
    'btn-remove-project',
    'btn-toggle-roadmap-view',
    'btn-toggle-solo',
    'btn-toggle-flow',
    'roadmap-view-tab-label',
    'solo-view-tab-label',
    'flow-view-tab-label',
    'solo-panel',
    'solo-body',
    'flow-panel',
    'flow-body',
    'btn-toggle-roadmap-revision',
    'btn-close-roadmap-revision',
    'roadmap-revision-panel',
    'roadmap-revision-body',
    'btn-toggle-feedback',
    'btn-close-feedback',
    'feedback-panel',
    'feedback-title',
    'feedback-type-not-working',
    'feedback-type-next-step',
    'feedback-type-feature',
    'btn-toggle-settings',
    'btn-close-settings',
    'settings-panel',
    'project-name-input',
    'project-description-input',
    'project-notes-input',
    'project-type-select',
    'project-priority-select',
    'setting-feedback-title',
    'setting-feedback-body',
    'btn-open-feedback',
    'btn-save-settings',
    'cli-test-badge'
  ]);
  elements.canvas.querySelector = () => createElement('flow-line');

  dispatchMessage({
    command: 'projectsLoaded',
    projects: {
      selectedProjectPath: '/workspace/app',
      projects: [{
        name: 'App',
        path: '/workspace/app',
        type: 'core_product',
        priority: 'P1',
        description: 'Old desc',
        notes: 'Old notes'
      }]
    }
  });
  postedMessages.length = 0;

  elements['btn-toggle-settings'].listeners.click();
  assert.equal(elements['settings-panel'].style.display, 'flex');
  assert.equal(elements['project-name-input'].value, 'App');
  assert.equal(elements['project-description-input'].value, 'Old desc');
  assert.equal(elements['project-notes-input'].value, 'Old notes');
  elements['project-name-input'].value = 'New App';
  elements['project-description-input'].value = 'Project intro';
  elements['project-notes-input'].value = 'Project notes';
  elements['project-type-select'].listeners.click({
    target: elements['project-type-select'].__options.find((option) => option.getAttribute('data-solo-option-value') === 'content'),
    stopPropagation() {}
  });
  elements['project-priority-select'].listeners.click({
    target: elements['project-priority-select'].__options.find((option) => option.getAttribute('data-solo-option-value') === 'P0'),
    stopPropagation() {}
  });
  elements['btn-save-settings'].listeners.click();

  assert.equal(elements['settings-panel'].style.display, 'none');
  assert.ok(postedMessages.some((message) =>
    message.command === 'updateProjectMetadata'
    && message.projectPath === '/workspace/app'
    && message.name === 'New App'
    && message.description === 'Project intro'
    && message.notes === 'Project notes'
    && message.projectType === 'content'
    && message.priority === 'P0'
  ));
  assert.ok(!postedMessages.some((message) => message.command === 'getSettings'));
  assert.ok(!postedMessages.some((message) => message.command === 'updateSettings'));
  elements['btn-toggle-feedback'].listeners.click();
  assert.equal(elements['feedback-panel'].style.display, 'flex');
  elements['setting-feedback-title'].value = '看不懂下一步';
  elements['setting-feedback-body'].value = '路线图打开后不知道先点哪里。';
  elements['btn-open-feedback'].listeners.click();
  assert.ok(postedMessages.some((message) => message.command === 'openFeedbackIssue' && message.title === '看不懂下一步' && message.category === 'not_working'));

  postedMessages.length = 0;
  elements['btn-toggle-solo'].listeners.click();
  assert.ok(elements['solo-body'].innerHTML.includes('data-value="antigravity"'));
  elements['btn-toggle-roadmap-view'].listeners.click();

  dispatchMessage({
    command: 'settingsLoaded',
    settings: { cliPath: '/workspace/.solomap-global/agent-cli/agy', language: 'zh', globalPrompt: '' }
  });

  elements['btn-toggle-solo'].listeners.click();

  assert.ok(elements['solo-panel'].classList.contains('active'));
  assert.ok(elements['solo-body'].innerHTML.includes('data-solo-input'));
  assert.ok(elements['solo-body'].innerHTML.includes('data-value="/workspace/.solomap-global/agent-cli/agy"'));
  assert.ok(elements['solo-body'].innerHTML.includes('>antigravity</button>'));
  assert.ok(!elements['solo-body'].innerHTML.includes('>/workspace/.solomap-global/agent-cli/agy</button>'));
  assert.ok(postedMessages.some((message) => message.command === 'getNodeConversations' && message.nodeId === '__solo__'));
  elements['btn-toggle-roadmap-view'].listeners.click();

  elements['btn-toggle-roadmap-revision'].listeners.click();

  assert.ok(elements['roadmap-revision-panel'].classList.contains('open'));
  assert.ok(elements['roadmap-revision-body'].innerHTML.includes('data-roadmap-revision-input'));
  assert.ok(postedMessages.some((message) => message.command === 'getNodeConversations' && message.nodeId === '__roadmap_revision__'));
});

test('full roadmap webview exposes node conversation history and project settings', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    'module.exports.__getWebviewHtml = roadmapWebview_1.getWebviewHtml;'
  );
  const html = extensionModule.__getWebviewHtml(createWebviewStub(), { extensionPath: projectRoot, extensionUri: createUri(projectRoot) });
  const script = extractLastScript(html);

  assert.match(html, /id="project-name-input"/);
  assert.match(html, /id="project-description-input"/);
  assert.match(html, /id="project-notes-input"/);
  assert.match(html, /id="project-type-select"/);
  assert.match(html, /id="project-priority-select"/);
  assert.match(script, /renderProjectSettings/);
  assert.match(script, /updateProjectMetadata/);
  assert.doesNotMatch(html, /id="btn-add-project"/);
  assert.doesNotMatch(html, /id="setting-language"/);
  assert.doesNotMatch(html, /id="setting-global-prompt"/);
  assert.doesNotMatch(html, /id="setting-global-data-path"/);
  assert.doesNotMatch(html, /id="agent-impact-panel"/);
  assert.doesNotMatch(html, /id="btn-refresh-agent-impact"/);
  assert.match(html, /id="btn-open-feedback"/);
  assert.match(script, /openFeedbackIssue/);
  assert.doesNotMatch(html, /id="setting-ability-select"/);
  assert.doesNotMatch(html, /id="setting-ability-url-input"/);
  assert.doesNotMatch(html, /id="btn-install-ability"/);
  assert.doesNotMatch(html, /id="btn-uninstall-ability"/);
  assert.doesNotMatch(html, /id="ability-detail-card"/);
  assert.doesNotMatch(html, /id="ability-action-badge"/);
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
  assert.match(script, /data-continue-native-node-id/);
  assert.doesNotMatch(script, /data-open-inline-continue-id/);
  assert.doesNotMatch(script, /data-continue-turn-send-id/);
  assert.match(script, /conversation-children-title/);
  assert.match(script, /sessionRoots/);
  assert.match(script, /const rootConversationId = conversation\.continuationRootConversationId \|\| findConversationRootId\(conversation\)/);
  assert.match(script, /Continuation first message/);
  assert.match(script, /showAgentTerminal/);
  assert.match(script, /stopAgentRun/);
  assert.match(script, /formatConversationDuration/);
  assert.match(script, /renderConversationOutcome/);
  assert.match(script, /extractAgentConclusion/);
  assert.match(script, /Open terminal|打开终端/);
  assert.match(script, /data-show-agent-terminal=.*conversation\.id/);
  assert.doesNotMatch(script, /node\.status === 'Running' \? 'disabled'/);
  assert.doesNotMatch(script, /Another Agent conversation is running/);
  assert.match(script, /Failure reason|失败原因/);
  assert.match(script, /runRoadmapRevision/);
  assert.match(script, /Roadmap Revision History|路线图调整历史/);
  assert.match(script, /No roadmap revisions yet|还没有路线图调整记录/);
  assert.match(script, /runSoloConversation/);
  assert.match(script, /linkSoloConversation/);
  assert.match(script, /soloTitle:\s*'Free Work'|soloTitle:\s*'自由研讨'/);
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
  assert.match(html, /\.methodology-shell\s*\{[\s\S]*?max-width:\s*min\(1280px,\s*100%\)/);
  assert.match(html, /\.node-row\s*\{[\s\S]*?max-width:\s*min\(1280px,\s*100%\)/);
  assert.match(html, /\.solo-view-inner\s*\{[\s\S]*?width:\s*min\(1280px,\s*100%\)/);
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

test('full roadmap conversation history keeps failed continuations under the main conversation', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    'module.exports.__getWebviewHtml = roadmapWebview_1.getWebviewHtml;'
  );
  const html = extensionModule.__getWebviewHtml(createWebviewStub(), { extensionPath: projectRoot, extensionUri: createUri(projectRoot) });
  const script = extractLastScript(html);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const { context } = runScriptWithMinimalDom(script, ids, 'globalThis.__renderConversationsForTest = renderConversations;');

  const rendered = context.__renderConversationsForTest('__solo__', [
    {
      id: 12,
      status: 'Recorded',
      agentCli: 'codex',
      command: 'codex resume',
      output: 'Continuation parent conversation: 20\nContinuation session id: 019ecd99-4325-7050-8e71-7def92359c9f\nERROR: No saved session found'
    },
    {
      id: 20,
      status: 'Completed',
      agentCli: 'codex',
      command: 'codex exec',
      output: 'User supplement:\n主对话\n\nNative Agent session saved: .solopreneur/step-sessions/__solo__.json (019ecd99-4325-7050-8e71-7def92359c9f)'
    }
  ], 'empty');

  assert.match(rendered, /data-conversation-id="__solo__:20"/);
  assert.doesNotMatch(rendered, /data-conversation-id="__solo__:12"/);
  assert.match(rendered, /续聊 1|Continuation/);
});

test('sidebar conversation result cards expose rollback actions for pre-session git hashes', () => {
  const sidebarSource = fs.readFileSync(path.join(projectRoot, 'out/sidebarProvider.js'), 'utf8');
  const extensionSource = [
    fs.readFileSync(path.join(projectRoot, 'out/extension.js'), 'utf8'),
    fs.readFileSync(path.join(projectRoot, 'out/roadmapWebview.js'), 'utf8')
  ].join('\n');

  assert.match(sidebarSource, /function extractPreGitHash\(output\)/);
  assert.match(sidebarSource, /data-rollback-sidebar-solo-hash/);
  assert.match(sidebarSource, /data-rollback-sidebar-step-hash/);
  assert.match(sidebarSource, /command:\s*'rollbackChanges'/);
  assert.match(sidebarSource, /this\._rollbackChanges/);

  assert.match(extensionSource, /function rollbackProjectToPreSessionGitHash/);
  assert.match(extensionSource, /rollback-safety/);
  assert.match(extensionSource, /data-rollback-hash/);
  assert.match(extensionSource, /rollbackConfirm/);
  assert.match(extensionSource, /window\.confirm\(t\('rollbackConfirm'\)\)/);
  assert.match(extensionSource, /\['restore', '--source', verifiedHash, '--staged', '--worktree', '--', '\.'\]/);
  assert.doesNotMatch(extensionSource, /\['reset', '--hard'/);
  assert.doesNotMatch(extensionSource, /\['clean', '-fd'\]/);
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
  const sidebarSource = fs.readFileSync(path.join(projectRoot, 'src/sidebarProvider.ts'), 'utf8');

  assert.match(html, /id="project-select"/);
  assert.match(html, /id="btn-add-project"/);
  assert.doesNotMatch(html, /sidebar-solo-card/);
  assert.doesNotMatch(html, /id="sidebar-solo-project"/);
  assert.doesNotMatch(html, /id="sidebar-solo-input"/);
  assert.match(html, /runSoloConversation/);
  assert.match(html, /chooseSoloSupplementFiles/);
  assert.match(html, /soloSupplementFilesSelected/);
  assert.match(html, /getSoloConversationHistory/);
  assert.match(html, /getProjectConversationHistory/);
  assert.match(html, /sidebarSoloConversationLoaded/);
  assert.match(html, /sidebarProjectConversationLoaded/);
  assert.match(html, /renderSidebarSoloHistoryContent/);
  assert.match(html, /renderSidebarStepHistoryContent/);
  assert.match(html, /function conversationStatusKey\(status\)/);
  assert.match(html, /Linked:\s*'已关联'/);
  assert.match(html, /linkedFromSolo:\s*'这是从 Solo 关联来的参考记录。'/);
  assert.match(html, /statusKey === 'Linked' \? t\('linkedFromSolo'\)/);
  assert.match(html, /renderSidebarConversationCard/);
  assert.match(html, /\.sidebar-conversation-mini-actions > span\s*\{/);
  assert.match(html, /place-items:\s*center/);
  assert.match(html, /\.sidebar-conversation-mini-actions > span \.codicon/);
  assert.match(html, /if \(!detailExpanded && rollbackBtn\)/);
  assert.match(html, /if \(!detailExpanded && continueBtn\)/);
  assert.match(sidebarSource, /sendProjectConversationHistory\(projectState\.selectedProjectPath\)/);
  assert.match(html, /latestSidebarProjectConversation/);
  assert.match(html, /sidebarConversationRefreshTtlMs\s*=\s*30000/);
  assert.match(html, /requestSidebarSoloConversationHistory/);
  assert.match(html, /requestSidebarProjectConversationHistory/);
  assert.match(html, /shouldRefreshSidebarProjectData/);
  assert.match(html, /projectPath === currentProjects\.selectedProjectPath\) return/);
  assert.doesNotMatch(html, /function buildConversationTree\(conversations\)/);
  assert.doesNotMatch(html, /sidebar-conversations-tree-container/);
  assert.doesNotMatch(html, /conversation\.status\.toLowerCase\(\)/);
  assert.match(html, /continueSoloConversation/);
  assert.match(html, /data-continue-sidebar-solo-id/);
  assert.match(html, /Continuation session id/);
  assert.match(html, /data-stop-sidebar-solo-id/);
  assert.match(html, /data-stop-sidebar-step-id/);
  assert.match(html, /stopConversation/);
  assert.match(html, /\.sidebar-conversation-card\s*\{[\s\S]*?flex-wrap:\s*wrap/);
  assert.match(html, /\.sidebar-conversation-body\s*\{[\s\S]*?flex:\s*1 1 130px/);
  assert.match(html, /@media \(max-width:\s*330px\)[\s\S]*?\.sidebar-conversation-right-col\s*\{[\s\S]*?width:\s*100%/);
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
  assert.match(html, /getTodayWorkRhythm/);
  assert.match(html, /todayRhythmMonday/);
  assert.match(html, /todayReasonFridayLearning/);
  assert.match(html, /todayReasonMonthReview/);
  assert.match(html, /data-run-daily-review/);
  assert.match(html, /runDailyReview/);
  assert.match(html, /dailyReviewLoaded/);
  assert.match(html, /dailyReviewButton/);
  assert.match(html, /todaySlotUrgent/);
  assert.doesNotMatch(html, /本周推进|Weekly Focus/);
  assert.match(html, /id="setting-global-data-path"/);
  assert.match(html, /id="agent-impact-panel"/);
  assert.match(html, /id="btn-refresh-agent-impact"/);
  assert.match(html, /getAgentImpact/);
  assert.match(html, /agentImpactLoaded/);
  assert.match(html, /id="setting-ability-select"/);
  assert.match(html, /id="setting-ability-url-input"/);
  assert.match(html, /id="btn-install-ability"/);
  assert.match(html, /id="btn-uninstall-ability"/);
  assert.match(html, /id="ability-detail-card"/);
  assert.match(html, /id="ability-action-badge"/);
  assert.match(html, /installSkill/);
  assert.match(html, /installMcp/);
  assert.match(html, /installEnhancement/);
  assert.match(html, /uninstallSkill/);
  assert.match(html, /uninstallMcp/);
  assert.match(html, /uninstallEnhancement/);
  assert.match(html, /setting-ability-select/);
  assert.match(html, /btn-install-ability"/);
  assert.match(html, /btn-uninstall-ability"/);
  assert.match(html, /abilityActionBadge/);
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

test('sidebar portfolio refresh preserves active project composer input state', () => {
  const { SolopreneurSidebarProvider } = loadCompiledModule(
    'out/sidebarProvider.js',
    ''
  );
  const provider = new SolopreneurSidebarProvider(
    createUri(projectRoot),
    { getNodes: () => [] },
    async () => {},
    () => ({ cliPath: 'codex', language: 'zh', globalPrompt: '', globalDataPath: '/workspace/.solomap-global' }),
    async () => {},
    () => ({ projects: [], selectedProjectPath: '' }),
    async () => {},
    async () => {}
  );
  const webviewView = {
    webview: {
      options: {},
      html: '',
      asWebviewUri(uri) {
        return String(uri && (uri.fsPath || uri.path || uri));
      },
      postMessage() {
        return Promise.resolve(true);
      },
      onDidReceiveMessage() {}
    }
  };
  provider.resolveWebviewView(webviewView, {}, {});
  const html = webviewView.webview.html;
  assert.match(html, /function rememberProjectConversationInput\(input\)/);
  assert.match(html, /function captureProjectConversationInputState\(\)[\s\S]*?document\.activeElement === input/);
  assert.match(html, /function restoreProjectConversationInputState\(state\)[\s\S]*?input\.focus\(\)[\s\S]*?input\.setSelectionRange/);
  assert.match(html, /function renderPortfolio\(portfolio, selectedProjectPath\) \{[\s\S]*?const preservedComposerState = captureProjectConversationInputState\(\)[\s\S]*?restoreProjectConversationInputState\(preservedComposerState\)/);
  assert.match(html, /case 'nodesUpdated':[\s\S]*?message\.projectPath !== activeProjectPath\) \{[\s\S]*?return;/);
  assert.doesNotMatch(html, /Object\.keys\(projectSoloDrafts\)\.forEach\(key => delete projectSoloDrafts\[key\]\)/);
  assert.doesNotMatch(html, /Object\.keys\(projectConversationAgentSelections\)\.forEach\(key => delete projectConversationAgentSelections\[key\]\)/);
});

test('sidebar keeps solo composer active when nodes load after the user starts typing', () => {
  const { SolopreneurSidebarProvider } = loadCompiledModule(
    'out/sidebarProvider.js',
    ''
  );
  const provider = new SolopreneurSidebarProvider(
    createUri(projectRoot),
    { getNodes: () => [] },
    async () => {},
    () => ({ cliPath: 'codex', language: 'zh', globalPrompt: '', globalDataPath: '/workspace/.solomap-global' }),
    async () => {},
    () => ({ projects: [], selectedProjectPath: '' }),
    async () => {},
    async () => {}
  );
  const webviewView = {
    webview: {
      options: {},
      html: '',
      asWebviewUri(uri) {
        return String(uri && (uri.fsPath || uri.path || uri));
      },
      postMessage() {
        return Promise.resolve(true);
      },
      onDidReceiveMessage() {}
    }
  };
  provider.resolveWebviewView(webviewView, {}, {});
  const script = extractLastScript(webviewView.webview.html);
  const suffix = `
    window.__soloModeAfterNodesLoaded = (() => {
      const projectPath = '/workspace/app';
      const project = { name: 'app', path: projectPath, nodes: [] };
      currentSettings = { cliPath: 'codex', language: 'zh' };
      currentProjects.selectedProjectPath = projectPath;
      currentProjects.portfolio = [project];
      activeProjectPath = projectPath;
      currentNodes = [];
      const beforeNodes = renderProjectConversationComposer(project, currentNodes);
      const input = {
        value: '正在输入 Solo 草稿',
        getAttribute(name) {
          if (name === 'data-conversation-mode') return 'solo';
          if (name === 'data-project-path') return projectPath;
          if (name === 'data-conversation-target-id') return 'solo:' + projectPath;
          return '';
        }
      };
      rememberProjectConversationInput(input);
      currentNodes = [{ id: '1', title: '下一步', status: 'Pending', dependencies: '', agentCli: 'codex' }];
      const afterNodes = renderProjectConversationComposer(project, currentNodes);
      return {
        beforeWasSolo: /data-conversation-mode="solo"/.test(beforeNodes),
        rememberedMode: projectConversationModes[projectPath],
        rememberedDraft: projectSoloDrafts[projectPath],
        afterStillSolo: /data-conversation-mode="solo"/.test(afterNodes),
        afterSoloButtonActive: /portfolio-mode-btn active" data-project-conversation-mode="solo"/.test(afterNodes),
        afterContinueInput: /data-conversation-mode="continue"/.test(afterNodes)
      };
    })();
  `;
  const { context } = runScriptWithMinimalDom(script, [
    'tasks-list',
    'progress-bar',
    'progress-text',
    'btn-open-strategy-pyramid',
    'project-select',
    'btn-add-project',
    'global-focus-panel',
    'portfolio-title',
    'portfolio-list',
    'portfolio-filters',
    'btn-toggle-feedback',
    'btn-close-feedback',
    'feedback-panel',
    'feedback-title',
    'feedback-type-not-working',
    'feedback-type-next-step',
    'feedback-type-feature',
    'btn-toggle-settings',
    'btn-close-settings',
    'settings-panel',
    'setting-language',
    'setting-cli-select',
    'setting-clipath-custom',
    'setting-global-prompt',
    'setting-global-data-path',
    'pro-account-panel',
    'btn-open-pro-authorization',
    'btn-paste-pro-code',
    'setting-feedback-title',
    'setting-feedback-body',
    'btn-open-feedback',
    'btn-test-cli',
    'btn-save-settings',
    'btn-check-dependencies',
    'btn-open-agent-install',
    'btn-prepare-agent-automation',
    'btn-open-agent-check',
    'btn-open-github-auth',
    'dependency-agent-status',
    'dependency-agent-message',
    'dependency-automation-status',
    'dependency-automation-message',
    'dependency-github-status',
    'dependency-github-message',
    'cli-test-badge'
  ], suffix);

  const result = context.window.__soloModeAfterNodesLoaded;
  assert.equal(result.beforeWasSolo, true);
  assert.equal(result.rememberedMode, 'solo');
  assert.equal(result.rememberedDraft, '正在输入 Solo 草稿');
  assert.equal(result.afterStillSolo, true);
  assert.equal(result.afterSoloButtonActive, true);
  assert.equal(result.afterContinueInput, false);
});

test('daily review prompt switches modes by engineering rhythm and signals', () => {
  const sidebarModule = loadCompiledModule(
    'out/sidebarProvider.js',
    [
      'module.exports.__getDailyReviewMode = getDailyReviewMode;',
      'module.exports.__buildDailyReviewPrompt = buildDailyReviewPrompt;'
    ].join('\n')
  );
  const baseProject = {
    name: 'ME',
    path: '/workspace/ME',
    projectType: 'content',
    globalPriority: 'P1',
    overallStatus: 'In Progress',
    progressPercent: 40,
    blocker: '',
    globalNextAction: '继续国际化渲染',
    recommendedNodeId: '2',
    recommendedNodeTitle: '继续国际化渲染',
    recommendedStatus: 'In Progress',
    failedNodes: 0,
    runningNodes: 0,
    inProgressNodes: 1,
    pendingNodes: 2,
    reusableSignals: 0,
    stageGap: '',
    issuePressure: '',
    issues: { byPriority: {} },
    delivery: { failedWorkflowRuns: 0 },
    deliverySignal: ''
  };
  const globalStore = {
    dataPath: '/workspace/.solomap-global',
    dependencies: [],
    learningCandidateCount: 0,
    portfolio: []
  };

  assert.equal(sidebarModule.__getDailyReviewMode('monday', [baseProject], globalStore), 'weekly_planning');
  assert.equal(sidebarModule.__getDailyReviewMode('friday', [{ ...baseProject, reusableSignals: 2 }], globalStore), 'learning_closeout');
  assert.equal(sidebarModule.__getDailyReviewMode('monthEnd', [baseProject], globalStore), 'monthly_review');
  assert.equal(sidebarModule.__getDailyReviewMode('daily', [{ ...baseProject, delivery: { failedWorkflowRuns: 1 } }], globalStore), 'exception_review');
  assert.equal(sidebarModule.__getDailyReviewMode('daily', [{ ...baseProject, reusableSignals: 1 }], globalStore), 'daily_learning');

  const prompt = sidebarModule.__buildDailyReviewPrompt({
    resultPath: '/workspace/.solomap-global/daily/2026-06-01.json',
    dateKey: '2026-06-01',
    rhythm: 'monday',
    reviewMode: 'weekly_planning',
    portfolio: [baseProject],
    globalStore,
    learningSummary: {
      eventCount: 2,
      candidateCount: 1,
      approvedCount: 1,
      promotedCount: 0,
      projectSignals: [{
        projectName: 'ME',
        projectPath: '/workspace/ME',
        candidateCount: 1,
        promotedCount: 0,
        riskSignals: 1,
        verificationSignals: 1,
        strategySignals: 0,
        eventCount: 2,
        latestAt: '2026-06-01T00:00:00.000Z'
      }],
      recentEvents: [],
      recentCandidates: [],
      globalRoot: '/workspace/.solomap-global'
    }
  });
  assert.match(prompt, /审视模式是：周一重点校准/);
  assert.match(prompt, /先检查 P0；确认本周 P1；保留 P2 备选；扫描外部变化和跨项目模式/);
  assert.match(prompt, /ledgerEventCount/);
  assert.match(prompt, /projectLearningSignals/);
  assert.match(prompt, /学习账本只作为行动证据/);
  assert.match(prompt, /reviewMode/);
  assert.match(prompt, /confirm_learning/);
  assert.doesNotMatch(prompt, /portfolio\.csv|dependencies\.csv/);
});

test('learning ledger writes events, extracts candidates, and retrieves reusable context', () => {
  const ledger = require(path.join(projectRoot, 'out', 'learningLedger.js'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-learning-ledger-'));
  const projectPath = path.join(root, 'app');
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(projectPath, { recursive: true });

  const event = ledger.appendLearningEvent(projectPath, globalRoot, {
    sourceType: 'flow_loop',
    sourceRef: 'flow-1:loop-1:verifier:1',
    eventType: 'deviated',
    summary: 'Verifier found implemented_unverified because final UI was not rendered.',
    evidenceRefs: [{ type: 'trace', ref: 'implemented_unverified', summary: 'H/I/J scoring reason' }],
    tags: ['flow', 'verifier'],
    metadata: {
      role: 'verifier',
      recommendedStatus: 'implemented_unverified',
      failures: ['final UI was not rendered'],
      verification: []
    }
  });

  const eventsPath = path.join(globalRoot, 'learning', 'ledger', 'events.jsonl');
  const candidatesDir = path.join(globalRoot, 'learning', 'candidates');
  assert.ok(fs.existsSync(eventsPath));
  assert.match(fs.readFileSync(eventsPath, 'utf8'), new RegExp(event.id));
  const candidateFiles = fs.readdirSync(candidatesDir).filter((name) => name.endsWith('.json'));
  assert.ok(candidateFiles.length >= 1);

  const summary = ledger.readLearningSummary(projectPath, globalRoot);
  assert.equal(summary.eventCount, 1);
  assert.equal(summary.candidateCount >= 1, true);
  assert.equal(summary.projectSignals[0].riskSignals >= 1, true);

  const retrieval = ledger.buildLearningRetrievalContext(projectPath, globalRoot, {
    projectPath,
    runKind: 'flow',
    role: 'planner',
    contextText: 'implemented_unverified final UI rendered verifier',
    files: [],
    limit: 3
  });
  assert.match(retrieval, /统一学习账本召回/);
  assert.match(retrieval, /Flow 验证暴露未闭环风险/);
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

test('local project actions use local refresh instead of external portfolio refresh', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src', 'extension.ts'), 'utf8');
  const functionBody = (name) => {
    const start = source.indexOf(`async function ${name}`);
    assert.notEqual(start, -1, `${name} should exist`);
    const next = source.indexOf('\nasync function ', start + 1);
    return source.slice(start, next === -1 ? source.length : next);
  };

  ['selectProject', 'updateProjectMetadata', 'toggleProjectPinned'].forEach((name) => {
    const body = functionBody(name);
    assert.match(body, /sendLocalProjectsToWebviews\(context\)/);
    assert.doesNotMatch(body, /sendProjectsToWebviews\(context\)/);
  });
});

test('sidebar local project refresh keeps reusable signal enrichment without external data loads', () => {
  const { SolopreneurSidebarProvider } = loadCompiledModule(
    'out/sidebarProvider.js',
    ''
  );
  const postedMessages = [];
  const provider = new SolopreneurSidebarProvider(
    createUri(projectRoot),
    { getNodes: () => [] },
    async () => {},
    () => ({ cliPath: 'codex', language: 'zh', globalDataPath: '' }),
    async () => {},
    () => ({
      projects: [{ name: 'app', path: '/workspace/app', pinnedAt: '2026-01-01T00:00:00.000Z' }],
      selectedProjectPath: '/workspace/app'
    }),
    async () => {},
    async () => {}
  );
  let portfolioEnrichments = 0;
  let externalLoads = 0;
  provider._view = {
    webview: {
      postMessage(message) {
        postedMessages.push(message);
        return Promise.resolve(true);
      }
    }
  };
  provider.schedulePortfolioEnrichment = () => { portfolioEnrichments += 1; };
  provider.scheduleIssueSummaryLoads = () => { externalLoads += 1; };
  provider.scheduleDeliverySummaryLoads = () => { externalLoads += 1; };

  provider.sendLocalProjects();

  assert.equal(portfolioEnrichments, 1);
  assert.equal(externalLoads, 0);
  assert.equal(provider._portfolioLoadRequest, 1);
  assert.equal(provider._issueLoadRequest, 1);
  assert.equal(provider._deliveryLoadRequest, 1);
  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].command, 'projectsLoaded');
  assert.equal(postedMessages[0].projects.portfolio[0].pinnedAt, '2026-01-01T00:00:00.000Z');
});

test('sidebar project portfolio summaries prioritize failed and in-progress work', () => {
  const sidebarModule = loadCompiledModule(
    'out/sidebarProvider.js',
    [
      'module.exports.__buildProjectPortfolioSummaries = buildProjectPortfolioSummaries;',
      'module.exports.__getRecommendedNode = getRecommendedNode;',
      'module.exports.__hasProEntitlement = hasProEntitlement;'
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
  const projectRootC = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-portfolio-c-'));
  const solopreneurC = path.join(projectRootC, '.solopreneur');
  fs.mkdirSync(solopreneurC, { recursive: true });
  fs.writeFileSync(path.join(solopreneurC, 'roadmap.csv'), [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '1,Backlog task,,产品与 MVP,,agy,,Pending,2026-01-01T00:00:00.000Z,'
  ].join('\n'));
  const projectRootD = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-portfolio-d-'));
  const solopreneurD = path.join(projectRootD, '.solopreneur');
  fs.mkdirSync(solopreneurD, { recursive: true });
  fs.writeFileSync(path.join(solopreneurD, 'roadmap.csv'), [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '1,Done,,产品与 MVP,,agy,,Completed,2026-01-01T00:00:00.000Z,2026-01-01T00:10:00.000Z'
  ].join('\n'));

  const summaries = sidebarModule.__buildProjectPortfolioSummaries([
    { name: 'Novel', path: projectRootA, type: 'content' },
    { name: 'CRM', path: projectRootB },
    { name: 'Backlog', path: projectRootC },
    { name: 'Done', path: projectRootD }
  ]);

  assert.equal(summaries.length, 4);
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
  assert.equal(summaries.find((summary) => summary.name === 'CRM')?.globalPriority, 'P1');
  assert.equal(summaries.find((summary) => summary.name === 'Backlog')?.globalPriority, 'P2');
  assert.equal(summaries.find((summary) => summary.name === 'Done')?.globalPriority, 'P3');
  assert.equal(sidebarModule.__getRecommendedNode([
    { id: '1', title: 'Failed step', status: 'Failed', stage: '产品与 MVP', dependencies: '' },
    { id: '2', title: 'Running step', status: 'Running', stage: '产品与 MVP', dependencies: '' }
  ]).title, 'Running step');
  assert.equal(sidebarModule.__hasProEntitlement({ proEntitlements: { strategy_pyramid: true } }, 'strategyPyramid'), true);
  assert.equal(sidebarModule.__hasProEntitlement({ proEntitlements: { pro: true } }, 'strategyPyramid'), true);
  assert.equal(sidebarModule.__hasProEntitlement({ proEntitlements: {} }, 'strategyPyramid'), false);
});

test('strategy pyramid webview renders the paid strategic cockpit without internal mechanics', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__getStrategyPyramidWebviewHtml = strategyPyramidWebview_1.getStrategyPyramidWebviewHtml;',
      'module.exports.__hasProEntitlement = hasProEntitlement;'
    ].join('\n')
  );
  const context = {
    extensionUri: createUri(projectRoot),
    extensionPath: projectRoot
  };
  const snapshot = {
    generatedAt: '2026-06-05T00:00:00.000Z',
    confidence: 'medium',
    stageTitle: 'Build 偏重期',
    mainJudgment: 'Build 信号明显偏重，继续新增功能会降低商业化验证效率。',
    strategicAction: '加码核心产品的商业化验证，补上销售与反馈信号。',
    constraint: '未来 30 天减少新功能建设，把时间转向商业化验证和用户反馈。',
    totalProjects: 1,
    buildCount: 2,
    sellCount: 1,
    learnCount: 1,
    improveCount: 1,
    risks: ['存在失败环节，应先收口再继续加码。'],
    loops: [
      { key: 'build', label: 'Build', title: '产品与交付', count: 2, projectNames: ['SoloMap'], judgment: '1 个项目形成 Build 信号' },
      { key: 'sell', label: 'Sell', title: '收入与市场', count: 1, projectNames: ['SoloMap'], judgment: '1 个项目形成 Sell 信号' },
      { key: 'learn', label: 'Learn', title: '学习与反馈', count: 1, projectNames: ['SoloMap'], judgment: '1 个项目形成 Learn 信号' },
      { key: 'improve', label: 'Improve', title: '改进与复利', count: 1, projectNames: ['SoloMap'], judgment: '1 个项目形成 Improve 信号' }
    ],
    layers: [
      { key: 'freedom-brand', title: '自由选择与个人品牌', health: 'watch', signal: '已有核心产品承载信誉积累。', action: '继续把市场反馈沉淀到核心产品。' },
      { key: 'revenue-system', title: '可复利收入系统', health: 'watch', signal: '1 个收入或市场动作可继续验证。', action: '把销售动作接到明确的升级或付费路径。' },
      { key: 'market-trust', title: '市场覆盖与信誉', health: 'watch', signal: '1 个学习信号可用于下一轮改进。', action: '把反馈转成下一轮取舍。' },
      { key: 'ability-compounding', title: '能力系统与产品交付', health: 'strong', signal: '1 项能力正在跨项目复用。', action: '把可复用能力产品化或品牌化。' },
      { key: 'reality-inventory', title: '现实锚点与投资库存', health: 'strong', signal: '1 个项目进入组合视野。', action: '冻结低复利项目，把注意力留给核心验证。' }
    ],
    moves: [
      { horizon: '未来 30 天', title: '补齐商业化与反馈验证', reason: '当前组合的建设动作多于市场信号。' },
      { horizon: '本季度', title: '减少低复利维护投入', reason: '组合价值来自复利关系。' }
    ],
    abilities: [
      { name: 'AI 产品编排', projectCount: 2, projectNames: ['SoloMap', 'Agent Kit'], value: '中高', judgment: '继续加码并对外表达' }
    ],
    stageProfile: {
      title: 'Build 偏重期',
      priorityLayer: '中层：项目组合 + 收入结构',
      keyMetric: '哪些项目在积累复利，哪些在消耗注意力',
      defaultQuestion: '应该加码、收缩还是暂停？'
    },
    structureSignals: [
      { key: 'portfolio', title: '项目组合', health: 'watch', summary: 'Build 偏重，Sell / Learn 信号不足。', evidence: ['Build: 2', 'Sell: 1'] },
      { key: 'time', title: '时间结构', health: 'watch', summary: '维护占用需要观察。', evidence: ['基于推进信号'] },
      { key: 'ability', title: '能力复利', health: 'strong', summary: 'AI 产品编排正在跨项目复用。', evidence: ['AI 产品编排: 2 项目'] },
      { key: 'trust', title: '市场信誉', health: 'watch', summary: '已有反馈信号但渠道证据不足。', evidence: ['Learn: 1'] }
    ],
    riskSignals: [
      { severity: 'medium', title: '中等结构风险', summary: 'Build 偏重，商业化与反馈验证不足。', evidence: ['Build: 2', 'Sell: 1', 'Learn: 1'] }
    ],
    opportunitySignals: [
      { severity: 'healthy', title: '结构机会', summary: '跨项目能力已经出现。', evidence: ['AI 产品编排: SoloMap / Agent Kit'] }
    ],
    scenarios: [
      { key: 'A', title: '场景 A：深化 SoloMap', investment: '集中核心产品', returnProfile: '单一产品商业化验证', cost: '压缩其他项目', risk: '单一产品依赖风险', timeline: '6-12 个月', summary: '适合信号增强后选择。' },
      { key: 'B', title: '场景 B：建立产品组合', investment: '核心产品加第二收入源', returnProfile: '平衡增长', cost: '投入强度下降', risk: '注意力分散风险', timeline: '12-18 个月', summary: '适合跨项目复利。' },
      { key: 'C', title: '场景 C：咨询/服务产品化', investment: '部分时间换收入反馈', returnProfile: '收入反馈更快', cost: '挤占产品时间', risk: '活跃收入反向锁死风险', timeline: '3-6 个月', summary: '适合补足市场信号。' }
    ],
    recommendedScenarioPath: '推荐路径：场景 B 运行 6 个月，若核心产品转化信号增强再切到场景 A。',
    projects: [{
      name: 'SoloMap',
      path: '/workspace/solomap',
      type: 'core_product',
      role: '核心产品',
      businessStage: 'commercial_validation',
      revenueTier: 'unknown',
      timeLoad: 'medium',
      strategicRelation: '高：承载收入、信誉和能力复利的主线',
      loop: 'sell',
      action: '继续当前推进',
      risk: '',
      evidence: ['2/5 个环节已完成', '当前有推进中的环节'],
      abilities: ['AI 产品编排'],
      roleScores: {
        abilityAccumulation: 4,
        revenueContribution: 5,
        marketTrust: 4,
        reusePotential: 4,
        brandValue: 5
      },
      advice: {
        doubleDown: '加码商业化验证、渠道建设和能沉淀信誉的交付',
        reduce: '收缩重复支持、临时修补和不产生学习信号的投入',
        observe: '观察反馈是否能转成定价、转化或明确取舍'
      },
      completedNodes: 2,
      failedNodes: 0,
      runningNodes: 1,
      inProgressNodes: 0,
      pendingNodes: 2,
      totalNodes: 5,
      progressPercent: 40,
      nodes: []
    }]
  };

  const proHtml = extensionModule.__getStrategyPyramidWebviewHtml(createWebviewStub(), context, snapshot);
  assert.match(proHtml, /一人公司战略驾驶舱/);
  assert.match(proHtml, /Build/);
  assert.match(proHtml, /Sell/);
  assert.match(proHtml, /Learn/);
  assert.match(proHtml, /Improve/);
  assert.match(proHtml, /当前战略状态|Build 偏重期/);
  assert.match(proHtml, /战略动作/);
  assert.match(proHtml, /边界约束/);
  assert.match(proHtml, /结构信号/);
  assert.match(proHtml, /战略阶段自适应/);
  assert.match(proHtml, /收入结构/);
  assert.match(proHtml, /市场信誉/);
  assert.match(proHtml, /时间结构/);
  assert.match(proHtml, /1-3 个月结构风险/);
  assert.match(proHtml, /结构机会/);
  assert.match(proHtml, /自由选择与个人品牌/);
  assert.match(proHtml, /可复利收入系统/);
  assert.match(proHtml, /市场覆盖与信誉/);
  assert.match(proHtml, /能力系统与产品交付/);
  assert.match(proHtml, /现实锚点与投资库存/);
  assert.match(proHtml, /项目组合结构/);
  assert.match(proHtml, /能力复利/);
  assert.match(proHtml, /未来 30 天战略动作/);
  assert.match(proHtml, /项目战略角色/);
  assert.match(proHtml, /能力积累/);
  assert.match(proHtml, /收入贡献/);
  assert.match(proHtml, /复用潜力/);
  assert.match(proHtml, /个人品牌价值/);
  assert.match(proHtml, /加码/);
  assert.match(proHtml, /收缩/);
  assert.match(proHtml, /观察/);
  assert.match(proHtml, /场景建模/);
  assert.match(proHtml, /场景 A/);
  assert.match(proHtml, /场景 B/);
  assert.match(proHtml, /场景 C/);
  assert.match(proHtml, /推荐路径/);
  assert.match(proHtml, /data-project-index="0"/);
  assert.doesNotMatch(proHtml, /查看项目|data-open-project|解锁战略金字塔|升级 Pro|GitHub|Passport|CloudMCP|entitlement|strategy_pyramid|snapshot|CSV|JSON|内部|配置|组件目的|来自 SoloMap 已确认|今日安排第|今天先跑/);
  assert.doesNotThrow(() => new vm.Script(extractLastScript(proHtml)));
  assert.equal(extensionModule.__hasProEntitlement({ proEntitlements: { strategy_pyramid: true } }, 'strategyPyramid'), true);
});

test('strategy pyramid snapshot aggregates portfolio signals and writes a reusable global view', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    'module.exports.__buildStrategyPyramidSnapshot = buildStrategyPyramidSnapshot;'
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-strategy-pyramid-'));
  const globalRoot = path.join(root, '.solomap-global');
  const coreProject = path.join(root, 'solomap');
  const contentProject = path.join(root, 'content');
  fs.mkdirSync(path.join(coreProject, '.solopreneur'), { recursive: true });
  fs.mkdirSync(path.join(contentProject, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(coreProject, '.solopreneur', 'roadmap.csv'), [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '1,Build Pro cockpit,,产品与 MVP,,,,Completed,,',
    '2,Sell Pro subscription,,销售与增长,,,,In Progress,,',
    '3,Learn from paid users,,反馈与学习,,,,Pending,,',
    '4,Improve onboarding,,改进与规模化,,,,Pending,,'
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(contentProject, '.solopreneur', 'roadmap.csv'), [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '1,Publish SEO content,,销售与增长,,,,Pending,,'
  ].join('\n'), 'utf8');
  fs.mkdirSync(globalRoot, { recursive: true });
  fs.writeFileSync(path.join(globalRoot, 'projects.json'), JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-06-06T00:00:00.000Z',
    hiddenProjects: [],
    projects: [
      { name: 'SoloMap', path: coreProject, type: 'core_product' },
      { name: 'Content Engine', path: contentProject, type: 'content' }
    ]
  }, null, 2), 'utf8');
  const ledger = require(path.join(projectRoot, 'out', 'learningLedger.js'));
  ledger.appendLearningEvent(coreProject, globalRoot, {
    sourceType: 'flow_loop',
    sourceRef: 'flow-1:loop-1:verifier:1',
    eventType: 'verified',
    summary: 'Verifier closed the checkout flow after running the final UI test.',
    evidenceRefs: [{ type: 'command', ref: 'node --test checkout-flow.test.js', summary: 'Verification signal' }],
    tags: ['flow', 'verifier'],
    metadata: {
      role: 'verifier',
      recommendedStatus: 'closed',
      verification: ['node --test checkout-flow.test.js'],
      failures: []
    }
  });

  const context = {
    globalState: {
      get(key) {
        if (key === 'solopreneur.settings') {
          return { cliPath: 'agy', language: 'zh', globalPrompt: '', globalDataPath: globalRoot };
        }
        return undefined;
      },
      update() {
        return Promise.resolve();
      }
    }
  };

  const snapshot = extensionModule.__buildStrategyPyramidSnapshot(context);
  const snapshotPath = path.join(globalRoot, 'strategy', 'pyramid-snapshot.json');
  const projectStrategyPath = path.join(globalRoot, 'strategy', 'project-strategy.csv');
  const abilityRegistryPath = path.join(globalRoot, 'strategy', 'ability-registry.csv');
  assert.equal(snapshot.totalProjects, 2);
  assert.equal(snapshot.stageTitle.length > 0, true);
  assert.equal(snapshot.stageProfile.defaultQuestion.length > 0, true);
  assert.match(snapshot.mainJudgment, /组合|项目|Build|收入|反馈|核心/);
  assert.match(snapshot.strategicAction, /商业化|核心产品|销售|反馈|收入/);
  assert.equal(snapshot.layers.length, 5);
  assert.equal(snapshot.structureSignals.length, 5);
  assert.ok(snapshot.structureSignals.some((signal) => signal.key === 'learning'));
  assert.ok(snapshot.riskSignals.length >= 1);
  assert.ok(snapshot.opportunitySignals.length >= 1);
  assert.ok(snapshot.opportunitySignals.some((signal) => /学习复利机会/.test(signal.title)));
  assert.ok(snapshot.learningSignals.some((signal) => signal.projectName === 'app' || signal.projectPath === coreProject));
  assert.equal(snapshot.scenarios.length, 3);
  assert.match(snapshot.recommendedScenarioPath, /推荐路径/);
  assert.ok(snapshot.loops.some((loop) => loop.key === 'sell' && loop.count >= 1));
  assert.ok(snapshot.moves.length >= 2);
  assert.ok(snapshot.projects.some((project) => project.name === 'SoloMap' && project.role === '核心产品' && project.roleScores.brandValue >= 1));
  assert.ok(fs.existsSync(snapshotPath));
  assert.ok(fs.existsSync(projectStrategyPath));
  assert.ok(fs.existsSync(abilityRegistryPath));
  const written = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert.equal(written.totalProjects, 2);
  assert.equal(written.layers.length, 5);
  assert.match(fs.readFileSync(projectStrategyPath, 'utf8'), /projectPath,role,businessStage,revenueTier,timeLoad,strategicAction,abilities,updatedAt/);
  assert.match(fs.readFileSync(abilityRegistryPath, 'utf8'), /abilityId,name,category,marketRelevance,notes,updatedAt/);
});

test('strategy pyramid command blocks free users with a Pro upgrade action', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__handleOpenStrategyPyramid = handleOpenStrategyPyramid;',
      'module.exports.__buildPassportStartUrl = buildPassportStartUrl;'
    ].join('\n')
  );
  extensionModule.__vscodeTestState.nextInformationChoices = ['升级 Pro', '浏览器回到 VS Code'];
  const context = {
    extensionUri: createUri(projectRoot),
    extensionPath: projectRoot,
    subscriptions: [],
    secrets: {
      get() {
        return Promise.resolve(undefined);
      },
      store() {
        return Promise.resolve();
      }
    },
    globalState: {
      get() {
        return {};
      },
      update() {
        return Promise.resolve();
      }
    }
  };

  await extensionModule.__handleOpenStrategyPyramid(context);

  assert.equal(extensionModule.__vscodeTestState.webviewPanels.length, 0);
  assert.equal(extensionModule.__vscodeTestState.informationMessages.length, 2);
  assert.match(extensionModule.__vscodeTestState.informationMessages[0].message, /战略金字塔是 Pro 功能/);
  assert.deepEqual(extensionModule.__vscodeTestState.informationMessages[0].items, ['升级 Pro']);
  assert.match(extensionModule.__vscodeTestState.informationMessages[1].message, /选择 SoloMap Pro 登录方式/);
  assert.equal(extensionModule.__vscodeTestState.openedExternal.length, 1);
  assert.match(extensionModule.__vscodeTestState.openedExternal[0], /https:\/\/solomap\.app\/pro/);
  assert.match(extensionModule.__vscodeTestState.openedExternal[0], /mode=callback/);
  assert.match(extensionModule.__vscodeTestState.openedExternal[0], /auth_nonce=/);
  assert.match(extensionModule.__buildPassportStartUrl('vscode://SZLK.solopreneur-roadmap/passport/callback'), /\/pro\?/);
  assert.match(extensionModule.__buildPassportStartUrl('vscode://SZLK.solopreneur-roadmap/passport/callback'), /callback=vscode%3A%2F%2FSZLK\.solopreneur-roadmap%2Fpassport%2Fcallback/);
});

test('strategy pyramid Pro upgrade supports device auth code entry', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    'module.exports.__handleOpenStrategyPyramid = handleOpenStrategyPyramid;'
  );
  extensionModule.__vscodeTestState.nextInformationChoices = ['升级 Pro', '使用登录码'];
  extensionModule.__vscodeTestState.nextInputBoxValue = 'signed-device-code';
  extensionModule.__vscodeTestState.fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith('/api/passport/verify')) {
      const body = JSON.parse(options.body);
      assert.equal(body.product, 'solomap');
      assert.equal(body.feature, 'strategy_pyramid');
      assert.equal(body.code, 'signed-device-code');
      assert.match(body.authNonce, /^[A-Za-z0-9_-]{24,160}$/);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          allowed: true,
          grant: 'final-device-grant',
          email: 'pro@solomap.app',
          userId: 'passport:user',
          entitlements: ['strategy_pyramid'],
          expiresAt: '2099-01-01T00:00:00.000Z'
        })
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const storedSecrets = new Map();
  const context = {
    extensionUri: createUri(projectRoot),
    extensionPath: projectRoot,
    subscriptions: [],
    secrets: {
      get() {
        return Promise.resolve(undefined);
      },
      store(key, value) {
        storedSecrets.set(key, value);
        return Promise.resolve();
      }
    },
    globalState: {
      get() {
        return {};
      },
      update() {
        return Promise.resolve();
      }
    }
  };

  await extensionModule.__handleOpenStrategyPyramid(context);

  assert.equal(extensionModule.__vscodeTestState.openedExternal.length, 1);
  assert.match(extensionModule.__vscodeTestState.openedExternal[0], /\/pro\?/);
  assert.match(extensionModule.__vscodeTestState.openedExternal[0], /mode=device/);
  assert.match(extensionModule.__vscodeTestState.openedExternal[0], /auth_nonce=/);
  assert.match(extensionModule.__vscodeTestState.inputBoxOptions.prompt, /粘贴网页上显示的授权码/);
  assert.ok([...storedSecrets.values()].some((value) => String(value).includes('final-device-grant')));
  assert.equal(extensionModule.__vscodeTestState.webviewPanels.length, 1);
});

test('passport callback verifies and stores a user grant before unlocking Pro', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    'module.exports.__handlePassportUri = handlePassportUri;'
  );
  extensionModule.__vscodeTestState.fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.product, 'solomap');
    assert.equal(body.feature, 'strategy_pyramid');
    assert.equal(body.grant, 'signed-grant');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        allowed: true,
        email: 'pro@solomap.app',
        userId: 'passport:user',
        entitlements: ['strategy_pyramid'],
        expiresAt: '2099-01-01T00:00:00.000Z'
      })
    };
  };
  const storedSecrets = new Map();
  const context = {
    extensionUri: createUri(projectRoot),
    extensionPath: projectRoot,
    subscriptions: [],
    secrets: {
      get(key) {
        return Promise.resolve(storedSecrets.get(key));
      },
      store(key, value) {
        storedSecrets.set(key, value);
        return Promise.resolve();
      }
    },
    globalState: {
      get() {
        return [];
      },
      update() {
        return Promise.resolve();
      }
    }
  };

  await extensionModule.__handlePassportUri(context, {
    authority: 'SZLK.solopreneur-roadmap',
    path: '/passport/callback',
    query: 'grant=signed-grant',
    toString() {
      return 'vscode://SZLK.solopreneur-roadmap/passport/callback?grant=signed-grant';
    }
  });

  assert.equal(extensionModule.__vscodeTestState.informationMessages.length, 1);
  assert.match(extensionModule.__vscodeTestState.informationMessages[0].message, /SoloMap Pro 已解锁/);
  assert.ok([...storedSecrets.values()].some((value) => String(value).includes('signed-grant')));
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
      },
      {
        name: 'Dependabot Updates',
        displayTitle: 'npm_and_yarn Update',
        status: 'completed',
        conclusion: 'cancelled',
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:01:00.000Z',
        url: 'https://github.com/owner/repo/actions/runs/dependabot'
      },
      {
        name: 'Publish',
        displayTitle: 'Publish',
        status: 'completed',
        conclusion: 'failure',
        createdAt: '2026-05-27T00:00:00.000Z',
        updatedAt: '2026-05-27T00:01:00.000Z',
        url: 'https://github.com/owner/repo/actions/runs/publish'
      }
    ]
  });
  const deliveryPath = sidebarModule.__getDeliveryCachePath(root);
  assert.equal(deliveryPath, path.join(root, '.solopreneur', 'delivery-cache.json'));
  assert.match(fs.readFileSync(path.join(root, '.solopreneur', '.gitignore'), 'utf8'), /delivery-cache\.json/);
  const deliveryCache = sidebarModule.__readDeliveryCache(root, 'owner/repo');
  const deliverySummary = sidebarModule.__summarizeDeliveryCache('owner/repo', deliveryCache, true);
  assert.equal(deliverySummary.latestRelease, 'v1.2.3');
  assert.equal(deliverySummary.failedWorkflowRuns, 0);
  assert.equal(deliverySummary.stale, true);
  const liveDeliverySummary = sidebarModule.__summarizeDeliveryCache('owner/repo', deliveryCache, false);
  assert.equal(liveDeliverySummary.failedWorkflowRuns, 1);
});

test('project foundation writes only missing minimal baseline files', () => {
  const foundationModule = require(path.join(projectRoot, 'out/projectFoundation.js'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-foundation-'));
  fs.writeFileSync(path.join(root, 'README.md'), '# Existing\n', 'utf8');

  const assessment = foundationModule.ensureProjectFoundation(root, 'tool');

  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '# Existing\n');
  assert.equal(assessment.complete, true);
  assert.ok(fs.existsSync(path.join(root, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(root, 'PROJECT_MEMORY.md')));
  assert.ok(fs.existsSync(path.join(root, '.github', 'workflows', 'ci.yml')));
  assert.ok(fs.existsSync(path.join(root, '.github', 'workflows', 'security.yml')));
  assert.match(fs.readFileSync(path.join(root, 'PROJECT_MEMORY.md'), 'utf8'), /Stable Decisions/);
});

test('sidebar security summary counts only live critical and high alerts', () => {
  const sidebarModule = loadCompiledModule(
    'out/sidebarProvider.js',
    [
      'module.exports.__summarizeSecurityCache = summarizeSecurityCache;',
      'module.exports.__writeSecurityCache = writeSecurityCache;',
      'module.exports.__readSecurityCache = readSecurityCache;',
      'module.exports.__getSecurityCachePath = getSecurityCachePath;'
    ].join('\n')
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-security-'));
  childProcess.execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  childProcess.execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], { cwd: root, stdio: 'ignore' });
  const cache = {
    schemaVersion: 1,
    repo: 'owner/repo',
    syncedAt: '2026-06-20T00:00:00.000Z',
    message: '',
    alerts: [
      { source: 'Dependabot', title: 'critical package', severity: 'critical', state: 'open', url: 'https://github.com/owner/repo/security/dependabot/1' },
      { source: 'CodeQL', title: 'high code path', severity: 'high', state: 'open', url: 'https://github.com/owner/repo/security/code-scanning/2' },
      { source: 'Dependabot', title: 'medium package', severity: 'medium', state: 'open', url: '' },
      { source: 'CodeQL', title: 'fixed path', severity: 'critical', state: 'fixed', url: '' }
    ]
  };

  sidebarModule.__writeSecurityCache(root, cache);
  assert.equal(sidebarModule.__getSecurityCachePath(root), path.join(root, '.solopreneur', 'security-cache.json'));
  assert.match(fs.readFileSync(path.join(root, '.solopreneur', '.gitignore'), 'utf8'), /security-cache\.json/);
  const read = sidebarModule.__readSecurityCache(root, 'owner/repo');
  const live = sidebarModule.__summarizeSecurityCache('owner/repo', read, false);
  assert.equal(live.openCriticalHigh, 2);
  assert.equal(live.openTotal, 3);
  assert.equal(live.status, 'risk');
  const stale = sidebarModule.__summarizeSecurityCache('owner/repo', read, true);
  assert.equal(stale.openCriticalHigh, 0);
  assert.equal(stale.status, 'unknown');
});

test('sidebar delivery summary ignores cancelled and superseded workflow runs', () => {
  const sidebarModule = loadCompiledModule(
    'out/sidebarProvider.js',
    'module.exports.__summarizeDeliveryCache = summarizeDeliveryCache;'
  );
  const cache = {
    schemaVersion: 1,
    repo: 'owner/repo',
    syncedAt: '2026-06-01T00:00:00.000Z',
    latestRelease: null,
    workflowRuns: [
      {
        name: 'Daily Security Scan',
        displayTitle: 'Daily Security Scan',
        status: 'completed',
        conclusion: 'success',
        createdAt: '2026-05-31T06:19:54Z',
        updatedAt: '2026-05-31T06:20:32Z',
        url: 'https://github.com/owner/repo/actions/runs/3'
      },
      {
        name: 'Daily Security Scan',
        displayTitle: 'Daily Security Scan',
        status: 'completed',
        conclusion: 'success',
        createdAt: '2026-05-30T05:48:55Z',
        updatedAt: '2026-05-30T05:49:36Z',
        url: 'https://github.com/owner/repo/actions/runs/2'
      },
      {
        name: 'Dependabot Updates',
        displayTitle: 'npm_and_yarn Update',
        status: 'completed',
        conclusion: 'cancelled',
        createdAt: '2026-05-29T14:12:43Z',
        updatedAt: '2026-05-30T14:12:48Z',
        url: 'https://github.com/owner/repo/actions/runs/dependabot'
      },
      {
        name: 'Daily Security Scan',
        displayTitle: 'Daily Security Scan',
        status: 'completed',
        conclusion: 'failure',
        createdAt: '2026-05-26T06:07:41Z',
        updatedAt: '2026-05-26T06:07:45Z',
        url: 'https://github.com/owner/repo/actions/runs/old-failure'
      }
    ]
  };

  const summary = sidebarModule.__summarizeDeliveryCache('owner/repo', cache, false);
  assert.equal(summary.failedWorkflowRuns, 0);
  assert.equal(summary.latestWorkflowConclusion, 'success');
});

test('sidebar delivery summary ignores failures outside the most recent three runs', () => {
  const sidebarModule = loadCompiledModule(
    'out/sidebarProvider.js',
    'module.exports.__summarizeDeliveryCache = summarizeDeliveryCache;'
  );
  const cache = {
    schemaVersion: 1,
    repo: 'owner/repo',
    syncedAt: '2026-06-12T00:00:00.000Z',
    latestRelease: null,
    workflowRuns: [
      {
        name: 'Publish VS Code Extension',
        displayTitle: 'latest publish 1',
        status: 'completed',
        conclusion: 'success',
        createdAt: '2026-06-12T03:00:00Z',
        updatedAt: '2026-06-12T03:01:00Z',
        url: 'https://github.com/owner/repo/actions/runs/31'
      },
      {
        name: 'Publish VS Code Extension',
        displayTitle: 'latest publish 2',
        status: 'completed',
        conclusion: 'success',
        createdAt: '2026-06-12T02:00:00Z',
        updatedAt: '2026-06-12T02:01:00Z',
        url: 'https://github.com/owner/repo/actions/runs/30'
      },
      {
        name: 'Publish VS Code Extension',
        displayTitle: 'latest publish 3',
        status: 'completed',
        conclusion: 'success',
        createdAt: '2026-06-12T01:00:00Z',
        updatedAt: '2026-06-12T01:01:00Z',
        url: 'https://github.com/owner/repo/actions/runs/29'
      },
      {
        name: 'Deploy Website to Cloudflare',
        displayTitle: 'older deploy failure',
        status: 'completed',
        conclusion: 'failure',
        createdAt: '2026-06-11T23:00:00Z',
        updatedAt: '2026-06-11T23:01:00Z',
        url: 'https://github.com/owner/repo/actions/runs/28'
      }
    ]
  };

  const summary = sidebarModule.__summarizeDeliveryCache('owner/repo', cache, false);
  assert.equal(summary.failedWorkflowRuns, 1);
  assert.equal(summary.latestWorkflowConclusion, 'success');
  assert.equal(summary.recentWorkflowRuns.length, 2);
});

test('sidebar delivery signal avoids raw failed-check wording', () => {
  const sidebarModule = loadCompiledModule(
    'out/sidebarProvider.js',
    'module.exports.__inferDeliverySignal = inferDeliverySignal;'
  );
  const signal = sidebarModule.__inferDeliverySignal({
    available: true,
    loading: false,
    stale: false,
    syncedAt: '2026-06-12T00:00:00.000Z',
    repo: 'owner/repo',
    latestRelease: '',
    latestReleaseAt: '',
    latestReleaseUrl: '',
    failedWorkflowRuns: 1,
    latestWorkflowName: 'Deploy Website to Cloudflare',
    latestWorkflowStatus: 'completed',
    latestWorkflowConclusion: 'failure',
    latestWorkflowUrl: 'https://github.com/owner/repo/actions/runs/28',
    recentWorkflowRuns: [],
    message: ''
  });
  assert.equal(signal, 'Delivery needs attention');
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

test('agent command builder uses non-interactive task runs and native continuation commands', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__buildAgentCommand = agentCli_1.buildAgentCommand;',
      'module.exports.__buildAgentCommandForPromptFile = agentCli_1.buildAgentCommandForPromptFile;',
      'module.exports.__buildAgentCommandFromShellVar = agentCli_1.buildAgentCommandFromShellVar;',
      'module.exports.__buildNativeContinueCommand = agentCli_1.buildNativeContinueCommand;',
      'module.exports.__buildSessionCaptureScript = buildSessionCaptureScript;',
      'module.exports.__buildSdkSentinelCommandLabel = agentCli_1.buildSdkSentinelCommandLabel;',
      'module.exports.__supportsSdkContinuation = agentCli_1.supportsSdkContinuation;',
      'module.exports.__extractCodexSessionIdFromOutputText = continuation_1.extractCodexSessionIdFromOutputText;',
      'module.exports.__resolveNativeSessionIdForConversation = resolveNativeSessionIdForConversation;',
      'module.exports.__setActiveProjectRootForSessionTest = (projectRoot) => { activeProjectRoot = projectRoot; };',
      'module.exports.__findCodexTranscriptFile = continuation_1.findCodexTranscriptFile;',
      'module.exports.__extractFirstCodexUserMessageAfter = continuation_1.extractFirstCodexUserMessageAfter;',
      'module.exports.__buildInteractiveContinuationPrompt = buildInteractiveContinuationPrompt;',
      'module.exports.__buildCodexContinuationRunnerScript = buildCodexContinuationRunnerScript;',
      'module.exports.__extractContinuationParentConversationId = continuation_1.extractContinuationParentConversationId;',
      'module.exports.__resolveContinuationLeafConversationFromList = continuation_1.resolveContinuationLeafConversationFromList;',
      'module.exports.__resolveContinuationSessionConversationFromList = continuation_1.resolveContinuationSessionConversationFromList;',
      'module.exports.__hydrateConversationContinuations = continuation_1.hydrateConversationContinuations;',
      'module.exports.__getTaskPermissionArgs = agentCli_1.getTaskPermissionArgs;',
      'module.exports.__makeAgentTerminalName = makeAgentTerminalName;',
      'module.exports.__buildAgentShellScript = buildAgentShellScript;',
      'module.exports.__buildAgentConversationPrompt = buildAgentConversationPrompt;',
      'module.exports.__buildRoadmapRevisionPrompt = buildRoadmapRevisionPrompt;',
      'module.exports.__buildSoloConversationPrompt = buildSoloConversationPrompt;',
      'module.exports.__buildSoloMapSystemMemoryPrompt = solomapGlobal_1.buildSoloMapSystemMemoryPrompt;',
      'module.exports.__ensureSolomapMemoryStore = solomapGlobal_1.ensureSolomapMemoryStore;',
      'module.exports.__ensureSolomapSkillStore = solomapGlobal_1.ensureSolomapSkillStore;',
      'module.exports.__readSolomapSkillRegistry = solomapGlobal_1.readSolomapSkillRegistry;',
      'module.exports.__writeSolomapSkillRegistry = solomapGlobal_1.writeSolomapSkillRegistry;',
      'module.exports.__buildSolomapSkillCandidateInstructions = solomapGlobal_1.buildSolomapSkillCandidateInstructions;',
      'module.exports.__buildSkillInstallPrompt = solomapGlobal_1.buildSkillInstallPrompt;',
      'module.exports.__validateAndRegisterSkillInstall = solomapGlobal_1.validateAndRegisterSkillInstall;',
      'module.exports.__ensureSolomapMcpStore = solomapGlobal_1.ensureSolomapMcpStore;',
      'module.exports.__readSolomapMcpRegistry = solomapGlobal_1.readSolomapMcpRegistry;',
      'module.exports.__writeSolomapMcpRegistry = solomapGlobal_1.writeSolomapMcpRegistry;',
      'module.exports.__buildSolomapMcpCandidateInstructions = solomapGlobal_1.buildSolomapMcpCandidateInstructions;',
      'module.exports.__buildMcpInstallPrompt = solomapGlobal_1.buildMcpInstallPrompt;',
      'module.exports.__validateAndRegisterMcpInstall = solomapGlobal_1.validateAndRegisterMcpInstall;',
      'module.exports.__ensureSolomapEnhancementStore = solomapGlobal_1.ensureSolomapEnhancementStore;',
      'module.exports.__readSolomapEnhancementRegistry = solomapGlobal_1.readSolomapEnhancementRegistry;',
      'module.exports.__writeSolomapEnhancementRegistry = solomapGlobal_1.writeSolomapEnhancementRegistry;',
      'module.exports.__buildSolomapEnhancementCandidateInstructions = solomapGlobal_1.buildSolomapEnhancementCandidateInstructions;',
      'module.exports.__ensureSolomapEnhancementRuntime = solomapGlobal_1.ensureSolomapEnhancementRuntime;',
      'module.exports.__buildEnhancementInstallPrompt = solomapGlobal_1.buildEnhancementInstallPrompt;',
      'module.exports.__buildEnhancementUninstallPrompt = solomapGlobal_1.buildEnhancementUninstallPrompt;',
      'module.exports.__validateAndRegisterEnhancementInstall = solomapGlobal_1.validateAndRegisterEnhancementInstall;',
      'module.exports.__validateAndRegisterEnhancementUninstall = solomapGlobal_1.validateAndRegisterEnhancementUninstall;',
      'module.exports.__getSolomapEnhancementStatusSummaries = solomapGlobal_1.getSolomapEnhancementStatusSummaries;',
      'module.exports.__checkAndRegisterEnhancement = solomapGlobal_1.checkAndRegisterEnhancement;',
      'module.exports.__setSolomapEnhancementEnabled = solomapGlobal_1.setSolomapEnhancementEnabled;',
      'module.exports.__uninstallSolomapEnhancement = solomapGlobal_1.uninstallSolomapEnhancement;',
      'module.exports.__buildRoadmapMethodologyInstructions = buildRoadmapMethodologyInstructions;',
      'module.exports.__buildRoadmapValidationScript = buildRoadmapValidationScript;',
      'module.exports.__ensureRoadmapValidationScript = ensureRoadmapValidationScript;',
      'module.exports.__getOutputTail = getOutputTail;',
      'module.exports.__buildRunHandoffEntry = runDigest_1.buildRunHandoffEntry;',
      'module.exports.__buildRunDigest = runDigest_1.buildRunDigest;',
      'module.exports.__writeRunDigest = runDigest_1.writeRunDigest;',
      'module.exports.__writeExecutionGraph = runDigest_1.writeExecutionGraph;',
      'module.exports.__buildExecutionExperiencePrompt = runDigest_1.buildExecutionExperiencePrompt;',
      'module.exports.__buildCrossAgentHandoffInstructions = runDigest_1.buildCrossAgentHandoffInstructions;',
      'module.exports.__buildBootstrapRoadmapInstructions = buildBootstrapRoadmapInstructions;',
      'module.exports.__parseStepHandoffEntries = runDigest_1.parseStepHandoffEntries;',
      'module.exports.__buildStepHandoffSummary = runDigest_1.buildStepHandoffSummary;',
      'module.exports.__updateStepHandoffSummary = runDigest_1.updateStepHandoffSummary;',
      'module.exports.__readStepHandoffSummary = runDigest_1.readStepHandoffSummary;',
      'module.exports.__buildSolopreneurDirectoryReadme = buildSolopreneurDirectoryReadme;',
      'module.exports.__buildCompletionCriteriaForNode = buildCompletionCriteriaForNode;',
      'module.exports.__ensureCompletionCriteriaForNodes = ensureCompletionCriteriaForNodes;',
      'module.exports.__readCompletionCriteria = readCompletionCriteria;',
      'module.exports.__getStepMemoryFilePath = getStepMemoryFilePath;',
      'module.exports.__getAgentCliCandidates = agentCli_1.getAgentCliCandidates;',
      'module.exports.__resolveExecutablePath = agentCli_1.resolveExecutablePath;',
      'module.exports.__commandExists = agentCli_1.commandExists;',
      'module.exports.__getAgentProvider = agentCli_1.getAgentProvider;',
      'module.exports.__hasProEntitlement = hasProEntitlement;',
      'module.exports.__getStepSessionFilePath = continuation_1.getStepSessionFilePath;',
      'module.exports.__readStepSessionState = continuation_1.readStepSessionState;',
      'module.exports.__getStoredAgentSession = continuation_1.getStoredAgentSession;',
      'module.exports.__updateStoredAgentSession = continuation_1.updateStoredAgentSession;',
      'module.exports.__clearStoredAgentSession = continuation_1.clearStoredAgentSession;',
      'module.exports.__extractSavedNativeSessionIdFromExecutionOutput = continuation_1.extractSavedNativeSessionIdFromExecutionOutput;',
      'module.exports.__extractNativeSessionIdFromExecutionOutput = continuation_1.extractNativeSessionIdFromExecutionOutput;',
      'module.exports.__extractUserSupplementFromExecutionOutput = extractUserSupplementFromExecutionOutput;',
      'module.exports.__buildLocalRoadmap = buildLocalRoadmap;',
      'module.exports.__validateBootstrapRoadmapRewrite = validateBootstrapRoadmapRewrite;',
      'module.exports.__validateRoadmapRevision = validateRoadmapRevision;',
      'module.exports.__processAgentStatusFile = processAgentStatusFile;',
      'module.exports.__recordSolomapLearningCycle = solomapGlobal_1.recordSolomapLearningCycle;',
      'module.exports.__buildSolomapLearningContext = solomapGlobal_1.buildSolomapLearningContext;',
      'module.exports.__shellQuote = agentCli_1.shellQuote;'
    ].join('\n')
  );

  assert.equal(
    extensionModule.__buildAgentCommand('codex', 'Ship the MVP', '/workspace/app'),
    "'codex' exec --color always -C '/workspace/app' --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox 'Ship the MVP'"
  );
  assert.equal(extensionModule.__hasProEntitlement({ proEntitlements: { strategy_pyramid: true } }, 'strategy_pyramid'), true);
  assert.equal(extensionModule.__hasProEntitlement({ proEntitlements: {} }, 'strategy_pyramid'), false);
  assert.equal(
    extensionModule.__buildAgentCommand('codex-cli', "Don't skip tests", '/workspace/app'),
    "'codex-cli' exec --color always -C '/workspace/app' --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox 'Don'\\''t skip tests'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('codex', 'Continue the MVP', '/workspace/app', '019dc472-6a80-7c70-99a4-b2593a641d11'),
    "'codex' exec --color always -C '/workspace/app' --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox 'Continue the MVP'"
  );
  assert.equal(
    extensionModule.__buildAgentCommand('cursor-agent', 'Build landing page', '/workspace/app'),
    "'cursor-agent' -p --force --output-format text 'Build landing page'"
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
    "cat '/workspace/app/.solopreneur/agent-runs/2/prompt.txt' | 'agy' --print --dangerously-skip-permissions --add-dir='/workspace/app'"
  );
  assert.equal(
    extensionModule.__buildAgentCommandForPromptFile('codex', '/workspace/app/.solopreneur/agent-runs/2/prompt.txt', '/workspace/app'),
    "cat '/workspace/app/.solopreneur/agent-runs/2/prompt.txt' | 'codex' exec --color always -C '/workspace/app' --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -"
  );
  assert.equal(
    extensionModule.__buildAgentCommandForPromptFile('cursor-agent', '/workspace/app/.solopreneur/agent-runs/2/prompt.txt', '/workspace/app'),
    "'cursor-agent' -p --force --output-format text 'Read the complete SoloMap task prompt from /workspace/app/.solopreneur/agent-runs/2/prompt.txt and follow that file exactly. The user request inside the file is the highest priority. Do not answer this wrapper sentence.'"
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
    "'codex' resume --include-non-interactive --all -C '/workspace/app' '019dc472-6a80-7c70-99a4-b2593a641d11'"
  );
  assert.equal(
    extensionModule.__buildNativeContinueCommand('cursor-agent', '3350a3b7-7761-4ed5-9661-2e9c9de8f924', '/workspace/app'),
    "(cd '/workspace/app' && 'cursor-agent' resume '3350a3b7-7761-4ed5-9661-2e9c9de8f924')"
  );
  assert.equal(
    extensionModule.__buildNativeContinueCommand('agy', '3350a3b7-7761-4ed5-9661-2e9c9de8f924', '/workspace/app'),
    "'agy' --conversation '3350a3b7-7761-4ed5-9661-2e9c9de8f924' --add-dir='/workspace/app'"
  );
  assert.equal(
    extensionModule.__buildNativeContinueCommand('copilot', '3350a3b7-7761-4ed5-9661-2e9c9de8f924', '/workspace/app'),
    "'copilot' --connect '3350a3b7-7761-4ed5-9661-2e9c9de8f924' -C '/workspace/app' --add-dir '/workspace/app'"
  );
  assert.equal(
    extensionModule.__buildSdkSentinelCommandLabel('codex', '/workspace/app', '019dc472-6a80-7c70-99a4-b2593a641d11'),
    "'codex' resume [tracked 019dc472-6a80-7c70-99a4-b2593a641d11 @ /workspace/app]"
  );
  assert.equal(extensionModule.__supportsSdkContinuation('codex'), true);
  assert.equal(extensionModule.__supportsSdkContinuation('agy'), false);
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-codex-home-'));
  const transcriptDir = path.join(codexHome, 'sessions', '2026', '06', '13');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const transcriptSessionId = '019dc472-6a80-7c70-99a4-b2593a641d11';
  const transcriptPath = path.join(transcriptDir, `rollout-2026-06-13T10-00-00-${transcriptSessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ timestamp: '2026-06-13T10:00:00.000Z', type: 'session_meta', payload: { id: transcriptSessionId } }),
    JSON.stringify({ timestamp: '2026-06-13T10:00:03.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'before run' } }),
    JSON.stringify({ timestamp: '2026-06-13T10:00:11.000Z', type: 'event_msg', payload: { type: 'user_message', message: '继续修复续聊标题' } })
  ].join('\n') + '\n', 'utf8');
  assert.equal(extensionModule.__findCodexTranscriptFile(codexHome, transcriptSessionId), transcriptPath);
  assert.equal(
    extensionModule.__extractFirstCodexUserMessageAfter(codexHome, transcriptSessionId, '2026-06-13T10:00:10.000Z'),
    '继续修复续聊标题'
  );
  assert.equal(
    extensionModule.__extractNativeSessionIdFromExecutionOutput('Continuation session id: 019dc472-6a80-7c70-99a4-b2593a641d11'),
    '019dc472-6a80-7c70-99a4-b2593a641d11'
  );
  assert.equal(
    extensionModule.__extractSavedNativeSessionIdFromExecutionOutput('Continuation session id: 019dc472-6a80-7c70-99a4-b2593a641d11'),
    ''
  );
  assert.equal(
    extensionModule.__extractContinuationParentConversationId('Continuation parent conversation: 42\nUser supplement:\ncontinue'),
    42
  );
  const leafConversation = extensionModule.__resolveContinuationLeafConversationFromList([
    { id: 10, output: 'User supplement:\nroot' },
    { id: 11, output: 'Continuation parent conversation: 10\nUser supplement:\nchild 1' },
    { id: 12, output: 'Continuation parent conversation: 11\nUser supplement:\nchild 2' },
    { id: 13, output: 'Continuation parent conversation: 10\nUser supplement:\nolder sibling' }
  ], 10);
  assert.equal(leafConversation && leafConversation.id, 13);
  const sessionConversation = extensionModule.__resolveContinuationSessionConversationFromList([
    { id: 20, output: 'Native Agent session saved: /workspace/app/.solopreneur/session.json (019dc472-6a80-7c70-99a4-b2593a641d11)' },
    { id: 21, output: 'Continuation parent conversation: 20\nUser supplement:\nfirst continue' },
    { id: 22, output: 'Continuation parent conversation: 21\nUser supplement:\nsecond continue' }
  ], 20);
  assert.equal(sessionConversation && sessionConversation.id, 20);
  const failedChildSessionConversation = extensionModule.__resolveContinuationSessionConversationFromList([
    { id: 30, output: 'Native Agent session saved: /workspace/app/.solopreneur/session.json (019ecd99-4325-7050-8e71-7def92359c9f)' },
    { id: 31, output: 'Continuation parent conversation: 30\nContinuation session id: 019dc472-6a80-7c70-99a4-b2593a641d11\nFailure reason:\nNo saved session found.' }
  ], 30);
  assert.equal(failedChildSessionConversation && failedChildSessionConversation.id, 30);
  assert.equal(
    extensionModule.__buildAgentCommandForPromptFile('agy', '/workspace/app/.solopreneur/agent-runs/2/prompt.txt', '/workspace/app', 'never'),
    "cat '/workspace/app/.solopreneur/agent-runs/2/prompt.txt' | 'agy' --print --add-dir='/workspace/app'"
  );
  assert.equal(
    extensionModule.__getTaskPermissionArgs('opencode', 'always'),
    ''
  );
  const configuredAgyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-agy-wrapper-'));
  const configuredAgyPath = path.join(configuredAgyDir, 'agy');
  fs.writeFileSync(configuredAgyPath, '#!/bin/sh\nexec /usr/bin/agy --dangerously-skip-permissions "$@"\n', 'utf8');
  assert.equal(
    extensionModule.__buildAgentCommandForPromptFile(configuredAgyPath, '/workspace/app/.solopreneur/agent-runs/2/prompt.txt', '/workspace/app', 'auto'),
    `cat '/workspace/app/.solopreneur/agent-runs/2/prompt.txt' | '${configuredAgyPath}' --print --add-dir='/workspace/app'`
  );
  assert.equal(
    extensionModule.__buildAgentCommandForPromptFile(configuredAgyPath, '/workspace/app/.solopreneur/agent-runs/2/prompt.txt', '/workspace/app', 'always'),
    `cat '/workspace/app/.solopreneur/agent-runs/2/prompt.txt' | '${configuredAgyPath}' --print --dangerously-skip-permissions --add-dir='/workspace/app'`
  );
  const configuredCursorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-cursor-wrapper-'));
  const configuredCursorPath = path.join(configuredCursorDir, 'cursor-agent');
  fs.writeFileSync(configuredCursorPath, '#!/bin/sh\nexec /usr/bin/cursor-agent --force "$@"\n', 'utf8');
  assert.equal(
    extensionModule.__buildAgentCommandForPromptFile(configuredCursorPath, '/workspace/app/.solopreneur/agent-runs/2/prompt.txt', '/workspace/app', 'auto'),
    `'${configuredCursorPath}' -p --output-format text 'Read the complete SoloMap task prompt from /workspace/app/.solopreneur/agent-runs/2/prompt.txt and follow that file exactly. The user request inside the file is the highest priority. Do not answer this wrapper sentence.'`
  );
  const firstTerminalName = extensionModule.__makeAgentTerminalName('/workspace/project-a', 'step-2-42');
  const secondTerminalName = extensionModule.__makeAgentTerminalName('/workspace/project-a', 'step-2-43');
  assert.match(firstTerminalName, /^project-a · step-2-42 · \d+ \(solomap\)$/);
  assert.match(secondTerminalName, /^project-a · step-2-43 · \d+ \(solomap\)$/);
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
    JSON.stringify(['antigravity-cli', 'agy', 'antigravity', 'codex'])
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
    JSON.stringify(['cursor-agent', 'cursor', 'cursor-cli', 'agy', 'antigravity'])
  );
  assert.equal(extensionModule.__getAgentProvider('claude'), 'claude');
  assert.equal(extensionModule.__getAgentProvider('copilot'), 'copilot');
  assert.equal(extensionModule.__getAgentProvider('opencode'), 'opencode');
  const continuationPrompt = extensionModule.__buildInteractiveContinuationPrompt(
    { id: '2', title: 'Ship MVP', description: '', stage: 'Build', dependencies: '', agentCli: 'codex', agentPrompt: '', status: 'In Progress', createdAt: '', completedAt: '' },
    '继续把登录态和订阅校验打通',
    '/workspace/app',
    '/workspace/app/.solopreneur/agent-runs/2/99/completion.json',
    [],
    '',
    '/workspace/.solomap-global'
  );
  assert.match(continuationPrompt, /继续 SoloMap 中已经存在的一段对话/);
  assert.match(continuationPrompt, /继续把登录态和订阅校验打通/);
  assert.match(continuationPrompt, /completion\.json/);
  const runnerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-codex-runner-'));
  const runnerPath = path.join(runnerDir, 'run-codex-continuation.cjs');
  extensionModule.__buildCodexContinuationRunnerScript(
    runnerPath,
    '/workspace/app',
    '019ec0df-b5de-78f2-a3e9-43689bc8c2ad',
    'Continue the task',
    '/workspace/app/.solopreneur/agent-runs/2/99/session.json',
    'gpt-5.4'
  );
  const runnerSource = fs.readFileSync(runnerPath, 'utf8');
  assert.match(runnerSource, /spawn\('codex', \['app-server'\]/);
  assert.match(runnerSource, /method: 'thread\/resume'/);
  assert.match(runnerSource, /method: 'turn\/start'/);
  assert.match(runnerSource, /sessionFilePath/);

  const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-codex-capture-'));
  const outputFilePath = path.join(captureDir, 'output.log');
  const startedAtFilePath = path.join(captureDir, 'started_at');
  const sessionFilePath = path.join(captureDir, 'session.json');
  fs.writeFileSync(startedAtFilePath, '', 'utf8');
  fs.writeFileSync(outputFilePath, [
    '用户本次要求：继续旧对话',
    'Continuation session id: 019dc472-6a80-7c70-99a4-b2593a641d11',
    '\u001b[1msession id:\u001b[0m 019ecd99-4325-7050-8e71-7def92359c9f'
  ].join('\n'), 'utf8');
  childProcess.execFileSync('bash', ['-lc', extensionModule.__buildSessionCaptureScript('codex', '/workspace/app', startedAtFilePath, outputFilePath, sessionFilePath)], {
    cwd: captureDir,
    env: { ...process.env, HOME: captureDir }
  });
  assert.equal(
    JSON.parse(fs.readFileSync(sessionFilePath, 'utf8')).sessionId,
    '019ecd99-4325-7050-8e71-7def92359c9f'
  );
  assert.equal(
    extensionModule.__extractCodexSessionIdFromOutputText('Continuation session id: 019dc472-6a80-7c70-99a4-b2593a641d11\nsession id: 019ecd99-4325-7050-8e71-7def92359c9f'),
    '019ecd99-4325-7050-8e71-7def92359c9f'
  );
  const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-codex-recover-'));
  const recoveryRunDir = path.join(recoveryRoot, '.solopreneur', 'agent-runs', '__solo__', '20');
  fs.mkdirSync(recoveryRunDir, { recursive: true });
  const recoveredSessionId = '019ecd99-4325-7050-8e71-7def92359c9f';
  const recoveredTranscriptDir = path.join(codexHome, 'sessions', '2026', '06', '17');
  fs.mkdirSync(recoveredTranscriptDir, { recursive: true });
  fs.writeFileSync(path.join(recoveredTranscriptDir, `rollout-2026-06-17T00-00-00-${recoveredSessionId}.jsonl`), [
    JSON.stringify({ timestamp: '2026-06-17T00:00:00.000Z', type: 'session_meta', payload: { id: recoveredSessionId } }),
    JSON.stringify({ timestamp: '2026-06-17T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'recover exact run' } })
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(recoveryRunDir, 'codex-home.txt'), codexHome, 'utf8');
  fs.writeFileSync(path.join(recoveryRunDir, 'output.log'), [
    'OpenAI Codex v0.140.0',
    `session id: ${recoveredSessionId}`
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(recoveryRunDir, 'session.json'), JSON.stringify({
    sessionId: recoveredSessionId,
    source: 'codex-output'
  }), 'utf8');
  fs.writeFileSync(path.join(recoveryRoot, '.solopreneur', 'agent-runs', '__solo__', 'session.json'), JSON.stringify({
    sessionId: '019dc472-6a80-7c70-99a4-b2593a641d11',
    source: 'legacy-shared-node-run'
  }), 'utf8');
  extensionModule.__setActiveProjectRootForSessionTest(recoveryRoot);
  assert.equal(
    extensionModule.__resolveNativeSessionIdForConversation('__solo__', {
      id: 20,
      agentCli: 'codex',
      output: 'Native Agent session saved: .solopreneur/step-sessions/__solo__.json (019dc472-6a80-7c70-99a4-b2593a641d11)'
    }),
    recoveredSessionId
  );
  const stepRecoveryRunDir = path.join(recoveryRoot, '.solopreneur', 'agent-runs', 'build-step', '22');
  fs.mkdirSync(stepRecoveryRunDir, { recursive: true });
  fs.writeFileSync(path.join(stepRecoveryRunDir, 'codex-home.txt'), codexHome, 'utf8');
  fs.writeFileSync(path.join(stepRecoveryRunDir, 'session.json'), JSON.stringify({
    sessionId: recoveredSessionId,
    source: 'codex-output'
  }), 'utf8');
  const hydratedStepConversations = extensionModule.__hydrateConversationContinuations(recoveryRoot, 'build-step', [
    {
      id: 22,
      nodeId: 'build-step',
      agentCli: 'codex',
      command: 'codex exec',
      output: 'Native Agent session saved: .solopreneur/step-sessions/build-step.json (019dc472-6a80-7c70-99a4-b2593a641d11)',
      status: 'Completed'
    }
  ]);
  assert.equal(hydratedStepConversations[0].resumableNativeSessionId, recoveredSessionId);
  assert.equal(hydratedStepConversations[0].continuationRootConversationId, 22);
  const missingTranscriptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-codex-missing-transcript-'));
  const missingRunDir = path.join(missingTranscriptRoot, '.solopreneur', 'agent-runs', '__solo__', '21');
  const emptyCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-empty-codex-home-'));
  fs.mkdirSync(missingRunDir, { recursive: true });
  fs.writeFileSync(path.join(missingRunDir, 'codex-home.txt'), emptyCodexHome, 'utf8');
  fs.writeFileSync(path.join(missingRunDir, 'session.json'), JSON.stringify({
    sessionId: '019dc472-6a80-7c70-99a4-b2593a641d11',
    source: 'old-missing-transcript'
  }), 'utf8');
  extensionModule.__setActiveProjectRootForSessionTest(missingTranscriptRoot);
  assert.equal(
    extensionModule.__resolveNativeSessionIdForConversation('__solo__', {
      id: 21,
      agentCli: 'codex',
      output: 'Continuation session id: 019dc472-6a80-7c70-99a4-b2593a641d11'
    }),
    ''
  );

  const sidebarModule = loadCompiledModule(
    'out/sidebarProvider.js',
    [
      'module.exports.__getAgentCliCandidates = getAgentCliCandidates;',
      'module.exports.__resolveExecutablePath = resolveExecutablePath;',
      'module.exports.__commandExists = commandExists;',
      'module.exports.__getCliVersionArgs = getCliVersionArgs;',
      'module.exports.__formatCliTestMessage = formatCliTestMessage;',
      'module.exports.__buildAgentInstallCommand = buildAgentInstallCommand;',
      'module.exports.__getDependencyStatus = getDependencyStatus;',
      'module.exports.__buildAgentAutomationWrapper = buildAgentAutomationWrapper;'
    ].join('\n')
  );
  assert.equal(
    JSON.stringify(sidebarModule.__getAgentCliCandidates('antigravity-cli', 'agy').slice(0, 4)),
    JSON.stringify(['antigravity-cli', 'agy', 'antigravity', 'codex'])
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
    JSON.stringify(['cursor-agent', 'cursor', 'cursor-cli', 'agy', 'antigravity'])
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
  const fakeAgyPath = path.join(cliHome, '.local', 'bin', 'agy');
  fs.writeFileSync(fakeAgyPath, '#!/bin/sh\necho agy\n', 'utf8');
  fs.chmodSync(fakeAgyPath, 0o755);
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
    const dependencyStatus = sidebarModule.__getDependencyStatus('agy');
    assert.equal(dependencyStatus.agentAutomationReady, true);
    assert.equal(dependencyStatus.agentAutomationCanPrepare, true);
    const wrapperRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-wrapper-root-'));
    const prepared = sidebarModule.__buildAgentAutomationWrapper('agy', wrapperRoot, []);
    assert.equal(prepared.ok, true);
    assert.match(prepared.wrapperPath, /agent-cli\/agy$/);
    assert.match(fs.readFileSync(prepared.wrapperPath, 'utf8'), /--dangerously-skip-permissions/);
    assert.equal(sidebarModule.__getDependencyStatus(prepared.wrapperPath).agentAutomationPreconfigured, true);
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
  assert.match(fs.readFileSync(shellScript.commandFilePath, 'utf8'), /cat .*prompt\.txt.*codex' exec --color always -C .*--skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -/);
  assert.match(fs.readFileSync(shellScript.promptFilePath, 'utf8'), /Ship the MVP/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /git -C/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /status --short/);
  assert.doesNotMatch(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /script -q -e -c/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /tee .*output\.log/);
  assert.match(fs.readFileSync(shellScript.runScriptPath, 'utf8'), /codex' exec --color always -C .*--skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -/);
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
  const ttyOutputPath = path.join(os.tmpdir(), 'solopreneur-tty-output.log');
  fs.writeFileSync(ttyOutputPath, '\u001b]0;⠦ solopreneur-roadmap\u0007Done\n0;⠧ solopreneur-roadmap\u0007\nFinished', 'utf8');
  assert.equal(extensionModule.__getOutputTail(ttyOutputPath), 'Done\nFinished');
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
  [
    'solomap-global-execution-guide',
    'solomap-roadmap-planning',
    'solomap-project-docs-lifecycle',
    'solomap-cross-project-memory',
    'solomap-enhancement-installer'
  ].forEach((skillId) => {
    const builtinSkillPath = path.join(skillStore.skillsRoot, 'installed', skillId);
    assert.ok(fs.existsSync(path.join(builtinSkillPath, 'package', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(builtinSkillPath, 'solomap.skill.json')));
    assert.ok(fs.existsSync(path.join(builtinSkillPath, 'source.lock.json')));
  });
  const builtinRegistry = extensionModule.__readSolomapSkillRegistry('/workspace/app', skillStoreRoot);
  assert.equal(builtinRegistry.skills.filter((skill) => skill.defaultCandidate).length, 4);
  assert.equal(builtinRegistry.skills.find((skill) => skill.id === 'solomap-global-execution-guide')?.defaultCandidate, true);
  assert.equal(builtinRegistry.skills.find((skill) => skill.id === 'solomap-roadmap-planning')?.defaultCandidate, true);
  assert.equal(builtinRegistry.skills.find((skill) => skill.id === 'solomap-project-docs-lifecycle')?.defaultCandidate, true);
  assert.equal(builtinRegistry.skills.find((skill) => skill.id === 'solomap-cross-project-memory')?.defaultCandidate, true);
  assert.equal(builtinRegistry.skills.find((skill) => skill.id === 'solomap-enhancement-installer')?.defaultCandidate, false);
  const builtinInstructions = extensionModule.__buildSolomapSkillCandidateInstructions('/workspace/app', skillStoreRoot, '调整路线图，更新项目文档，并沉淀跨项目记忆');
  assert.match(builtinInstructions, /SoloMap Global Execution Guide/);
  assert.match(builtinInstructions, /installed\/solomap-global-execution-guide\/package\/SKILL\.md/);
  assert.match(builtinInstructions, /SoloMap Roadmap Planning/);
  assert.match(builtinInstructions, /installed\/solomap-roadmap-planning\/package\/SKILL\.md/);
  assert.match(builtinInstructions, /SoloMap Project Docs Lifecycle/);
  assert.match(builtinInstructions, /installed\/solomap-project-docs-lifecycle\/package\/SKILL\.md/);
  assert.match(builtinInstructions, /SoloMap Cross-Project Memory/);
  assert.match(builtinInstructions, /installed\/solomap-cross-project-memory\/package\/SKILL\.md/);
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

  const enhancementStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-enhancement-store-'));
  const enhancementStore = extensionModule.__ensureSolomapEnhancementStore('/workspace/app', enhancementStoreRoot);
  assert.ok(fs.existsSync(path.join(enhancementStore.enhancementsRoot, 'installed')));
  assert.ok(fs.existsSync(path.join(enhancementStore.enhancementsRoot, 'runs')));
  extensionModule.__writeSolomapEnhancementRegistry('/workspace/app', enhancementStoreRoot, {
    version: 1,
    updatedAt: '',
    enhancements: [{
      id: 'rtk-output-filter',
      title: 'rtk Output Filter',
      description: 'Compress command output before Agent reads it.',
      status: 'installed',
      configPath: 'installed/rtk-output-filter/solomap.enhancement.json',
      benefit: 'Reduce noisy command output token usage.',
      adapter: { type: 'command_rewrite', fallback: 'use_original_path' },
      activation: { keywords: ['token', '命令输出'], useWhen: ['任务需要减少命令输出 token'] },
      risk: { level: 'low', requiresExplicitEnable: false, hidesRawOutput: true },
      evidencePolicy: { mustReadRawWhen: ['失败日志', '关键判断'] }
    }, {
      id: 'agent-config-writer',
      title: 'Agent Config Writer',
      status: 'installed',
      activation: { keywords: ['agent'] },
      adapter: { type: 'prompt_policy' },
      risk: { level: 'high', modifiesAgentConfig: true, requiresExplicitEnable: true }
    }]
  });
  const disabledBuiltinInstructions = extensionModule.__buildSolomapEnhancementCandidateInstructions('/workspace/app', enhancementStoreRoot, '需要减少命令输出 token，同时保留失败日志');
  assert.doesNotMatch(disabledBuiltinInstructions, /Command Output Optimizer/);

  const builtinInstalledRegistry = extensionModule.__readSolomapEnhancementRegistry('/workspace/app', enhancementStoreRoot);
  extensionModule.__writeSolomapEnhancementRegistry('/workspace/app', enhancementStoreRoot, {
    ...builtinInstalledRegistry,
    enhancements: builtinInstalledRegistry.enhancements.concat([{
      id: 'command-output-optimizer',
      title: 'Command Output Optimizer',
      status: 'installed',
      enabled: true,
      version: '1.0.0',
      health: { ok: true, version: '1.0.0', message: 'Ready' }
    }, {
      id: 'code-structure-assistant',
      title: 'Code Structure Assistant',
      status: 'installed',
      enabled: true,
      version: '2.0.0',
      health: { ok: true, version: '2.0.0', message: 'Ready' }
    }, {
      id: 'mcp-description-compressor',
      title: 'MCP Description Compressor',
      status: 'installed',
      enabled: true,
      version: '3.0.0',
      health: { ok: true, version: '3.0.0', message: 'Ready' }
    }])
  });

  const enabledBuiltinInstructions = extensionModule.__buildSolomapEnhancementCandidateInstructions(
    '/workspace/app',
    enhancementStoreRoot,
    '需要减少命令输出 token，同时保留失败日志',
    { 'command-output-optimizer': true, 'code-structure-assistant': true, 'mcp-description-compressor': true }
  );
  assert.match(enabledBuiltinInstructions, /Command Output Optimizer/);
  assert.match(enabledBuiltinInstructions, /command_rewrite/);
  assert.match(enabledBuiltinInstructions, /原始证据要求/);

  const codeGraphInstructions = extensionModule.__buildSolomapEnhancementCandidateInstructions(
    '/workspace/app',
    enhancementStoreRoot,
    '重构前需要检查函数引用和调用影响面',
    { 'command-output-optimizer': true, 'code-structure-assistant': true, 'mcp-description-compressor': true }
  );
  assert.match(codeGraphInstructions, /Code Structure Assistant/);
  assert.match(codeGraphInstructions, /mcp/);

  const mcpShrinkInstructions = extensionModule.__buildSolomapEnhancementCandidateInstructions(
    '/workspace/app',
    enhancementStoreRoot,
    'MCP tool description 和 schema 占用太多上下文',
    { 'command-output-optimizer': true, 'code-structure-assistant': true, 'mcp-description-compressor': true }
  );
  assert.match(mcpShrinkInstructions, /MCP Description Compressor/);
  assert.match(mcpShrinkInstructions, /external_mcp_proxy/);

  const enhancementInstructions = extensionModule.__buildSolomapEnhancementCandidateInstructions('/workspace/app', enhancementStoreRoot, '需要减少命令输出 token，同时保留失败日志', { 'command-output-optimizer': true, 'code-structure-assistant': true, 'mcp-description-compressor': true });
  assert.match(enhancementInstructions, /Command Output Optimizer/);
  assert.match(enhancementInstructions, /command_rewrite/);
  assert.match(enhancementInstructions, /原始证据要求/);
  assert.doesNotMatch(enhancementInstructions, /Agent Config Writer/);

  const enhancementRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-enhancement-runtime-'));
  const runtime = extensionModule.__ensureSolomapEnhancementRuntime('/workspace/app', enhancementRuntimeRoot, {
    'command-output-optimizer': true,
    'code-structure-assistant': true,
    'mcp-description-compressor': true
  });
  assert.ok(fs.existsSync(path.join(runtime.binRoot, 'git')));
  assert.match(fs.readFileSync(path.join(runtime.binRoot, 'git'), 'utf8'), /exec rtk "\$cmd" "\$@"/);
  assert.match(fs.readFileSync(path.join(runtime.binRoot, 'git'), 'utf8'), /SOLOMAP_RTK_BYPASS/);
  assert.match(runtime.envLines.join('\n'), /SOLOMAP_RTK_OUTPUT_OPTIMIZER=1/);
  assert.doesNotMatch(runtime.preflightLines.join('\n'), /codegraph init -i/);

  const enhancementInstallPrompt = extensionModule.__buildEnhancementInstallPrompt(
    'code-structure-assistant',
    '/workspace/app',
    enhancementRuntimeRoot,
    path.join(enhancementRuntimeRoot, 'enhancements/runs/run/result.json')
  );
  assert.match(enhancementInstallPrompt, /solomap-enhancement-installer/);
  assert.match(enhancementInstallPrompt, /code-structure-assistant/);
  assert.match(enhancementInstallPrompt, /安装结果 JSON 必须写入/);
  assert.doesNotMatch(enhancementInstallPrompt, /codegraph install --target=auto --location=global --yes\s*\|\| true/);

  const validationEnhancementStore = extensionModule.__ensureSolomapEnhancementStore('/workspace/app', enhancementRuntimeRoot);
  const fakeEnhancementRoot = path.join(validationEnhancementStore.installedRoot, 'code-structure-assistant');
  fs.mkdirSync(fakeEnhancementRoot, { recursive: true });
  const fakeEnhancementJson = path.join(fakeEnhancementRoot, 'solomap.enhancement.json');
  const fakeSourceLock = path.join(fakeEnhancementRoot, 'source.lock.json');
  const fakeHealth = path.join(fakeEnhancementRoot, 'health.json');
  fs.writeFileSync(fakeEnhancementJson, JSON.stringify({
    id: 'code-structure-assistant',
    title: 'Code Structure Assistant',
    description: 'Use code graph lookup.',
    status: 'installed',
    version: '1.2.3',
    activation: { keywords: ['codegraph'] },
    risk: { level: 'low' }
  }, null, 2), 'utf8');
  fs.writeFileSync(fakeSourceLock, JSON.stringify({ source: { name: 'CodeGraph' }, version: '1.2.3' }, null, 2), 'utf8');
  fs.writeFileSync(fakeHealth, JSON.stringify({ ok: true, version: '1.2.3', message: 'Ready' }, null, 2), 'utf8');
  const fakeEnhancementResult = path.join(enhancementRuntimeRoot, 'enhancement-result.json');
  fs.writeFileSync(fakeEnhancementResult, JSON.stringify({
    ok: true,
    enhancementId: 'code-structure-assistant',
    installedPath: fakeEnhancementRoot,
    solomapEnhancementJson: fakeEnhancementJson,
    sourceLockJson: fakeSourceLock,
    healthJson: fakeHealth,
    metadata: { version: '1.2.3' },
    health: { ok: true, version: '1.2.3', message: 'Ready' }
  }, null, 2), 'utf8');
  const enhancementValidation = extensionModule.__validateAndRegisterEnhancementInstall('/workspace/app', enhancementRuntimeRoot, fakeEnhancementResult);
  assert.equal(enhancementValidation.ok, true);
  const enhancementStatuses = extensionModule.__getSolomapEnhancementStatusSummaries('/workspace/app', enhancementRuntimeRoot);
  const codeGraphStatus = enhancementStatuses.find((item) => item.id === 'code-structure-assistant');
  assert.equal(codeGraphStatus.installed, true);
  assert.equal(codeGraphStatus.enabled, true);
  assert.equal(codeGraphStatus.version, '1.2.3');

  const enabledAfterInstallInstructions = extensionModule.__buildSolomapEnhancementCandidateInstructions(
    '/workspace/app',
    enhancementRuntimeRoot,
    '重构前需要用 codegraph 检查函数引用和调用影响面',
    { 'code-structure-assistant': true }
  );
  assert.match(enabledAfterInstallInstructions, /Code Structure Assistant/);
  const enableCodeGraph = extensionModule.__setSolomapEnhancementEnabled('/workspace/app', enhancementRuntimeRoot, 'code-structure-assistant', true);
  assert.equal(enableCodeGraph.ok, true);
  const enabledCodeGraphStatus = extensionModule.__getSolomapEnhancementStatusSummaries('/workspace/app', enhancementRuntimeRoot).find((item) => item.id === 'code-structure-assistant');
  assert.equal(enabledCodeGraphStatus.enabled, true);
  const disableCodeGraph = extensionModule.__setSolomapEnhancementEnabled('/workspace/app', enhancementRuntimeRoot, 'code-structure-assistant', false);
  assert.equal(disableCodeGraph.ok, true);
  const enhancementUninstallPrompt = extensionModule.__buildEnhancementUninstallPrompt(
    'code-structure-assistant',
    '/workspace/app',
    enhancementRuntimeRoot,
    path.join(enhancementRuntimeRoot, 'enhancements/runs/run/uninstall-result.json')
  );
  assert.match(enhancementUninstallPrompt, /卸载结果 JSON 必须写入/);
  assert.match(enhancementUninstallPrompt, /彻底移除该增强/);
  const fakeEnhancementUninstallResult = path.join(enhancementRuntimeRoot, 'enhancement-uninstall-result.json');
  fs.writeFileSync(fakeEnhancementUninstallResult, JSON.stringify({
    ok: true,
    enhancementId: 'code-structure-assistant',
    removedItems: ['codegraph mcp profile'],
    remainingItems: [],
    health: { ok: true, message: 'Removed from user environment.' }
  }, null, 2), 'utf8');
  const uninstallCodeGraph = extensionModule.__validateAndRegisterEnhancementUninstall('/workspace/app', enhancementRuntimeRoot, fakeEnhancementUninstallResult);
  assert.equal(uninstallCodeGraph.ok, true);
  const uninstalledCodeGraph = extensionModule.__getSolomapEnhancementStatusSummaries('/workspace/app', enhancementRuntimeRoot).find((item) => item.id === 'code-structure-assistant');
  assert.equal(uninstalledCodeGraph.installed, false);
  assert.equal(uninstalledCodeGraph.enabled, false);
  const fakeCodegraphBin = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-fake-codegraph-'));
  const fakeCodegraph = path.join(fakeCodegraphBin, 'codegraph');
  fs.writeFileSync(fakeCodegraph, '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "codegraph 1.2.3"; else echo "ready"; fi\n', 'utf8');
  fs.chmodSync(fakeCodegraph, 0o755);
  const oldCodegraphPath = process.env.PATH;
  process.env.PATH = `${fakeCodegraphBin}:/usr/bin:/bin`;
  try {
    const recheckUninstalledCodeGraph = extensionModule.__checkAndRegisterEnhancement('/workspace/app', enhancementRuntimeRoot, 'code-structure-assistant');
    assert.equal(recheckUninstalledCodeGraph.ok, false);
  } finally {
    process.env.PATH = oldCodegraphPath;
  }
  const stillUninstalledCodeGraph = extensionModule.__getSolomapEnhancementStatusSummaries('/workspace/app', enhancementRuntimeRoot).find((item) => item.id === 'code-structure-assistant');
  assert.equal(stillUninstalledCodeGraph.installed, false);
  assert.equal(stillUninstalledCodeGraph.enabled, false);
  assert.equal(stillUninstalledCodeGraph.status, 'uninstalled');

  const mcpEnhancementRoot = path.join(validationEnhancementStore.installedRoot, 'mcp-description-compressor');
  fs.mkdirSync(mcpEnhancementRoot, { recursive: true });
  fs.writeFileSync(path.join(mcpEnhancementRoot, 'solomap.enhancement.json'), JSON.stringify({
    id: 'mcp-description-compressor',
    title: 'MCP Description Compressor',
    description: 'Shrink MCP tool descriptions.',
    status: 'installed',
    version: '0.1.0',
    source: { package: 'caveman-shrink' },
    health: { ok: true, version: '0.1.0', message: 'Ready' }
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(mcpEnhancementRoot, 'health.json'), JSON.stringify({
    ok: true,
    version: '0.1.0',
    message: 'Ready',
    commandChecks: [{ command: 'npm list -g caveman-shrink', ok: true, version: '0.1.0' }]
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(mcpEnhancementRoot, 'source.lock.json'), JSON.stringify({
    source: { package: 'caveman-shrink' },
    packages: [{ name: 'caveman-shrink', version: '0.1.0' }],
    installerCommandSummary: 'npm install -g caveman-installer caveman-shrink'
  }, null, 2), 'utf8');
  extensionModule.__writeSolomapEnhancementRegistry('/workspace/app', enhancementRuntimeRoot, {
    ...extensionModule.__readSolomapEnhancementRegistry('/workspace/app', enhancementRuntimeRoot),
    enhancements: [{
      id: 'mcp-description-compressor',
      title: 'MCP Description Compressor',
      status: 'installed',
      version: '0.1.0',
      health: { ok: true, version: '0.1.0', message: 'Ready' },
      installedPath: 'installed/mcp-description-compressor',
      configPath: 'installed/mcp-description-compressor/solomap.enhancement.json'
    }]
  });
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-fake-caveman-'));
  const fakeCaveman = path.join(fakeBin, 'caveman');
  fs.writeFileSync(fakeCaveman, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  fs.chmodSync(fakeCaveman, 0o755);
  const fakeCheckWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-enhancement-check-workspace-'));
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  try {
    const recheck = extensionModule.__checkAndRegisterEnhancement(fakeCheckWorkspace, enhancementRuntimeRoot, 'mcp-description-compressor');
    assert.equal(recheck.ok, true);
  } finally {
    process.env.PATH = oldPath;
  }
  const mcpStatus = extensionModule.__getSolomapEnhancementStatusSummaries(fakeCheckWorkspace, enhancementRuntimeRoot).find((item) => item.id === 'mcp-description-compressor');
  assert.equal(mcpStatus.installed, true);
  assert.equal(mcpStatus.version, '0.1.0');
  const preservedMcpHealth = JSON.parse(fs.readFileSync(path.join(mcpEnhancementRoot, 'health.json'), 'utf8'));
  const preservedMcpSourceLock = JSON.parse(fs.readFileSync(path.join(mcpEnhancementRoot, 'source.lock.json'), 'utf8'));
  assert.equal(preservedMcpHealth.version, '0.1.0');
  assert.equal(preservedMcpSourceLock.packages[0].version, '0.1.0');

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
  assert.match(fs.readFileSync(agyShellScript.runScriptPath, 'utf8'), /cat .*prompt\.txt' \| 'agy' --print --dangerously-skip-permissions --add-dir/);
  assert.doesNotMatch(fs.readFileSync(agyShellScript.runScriptPath, 'utf8'), /Read the complete SoloMap task prompt from .*prompt\.txt/);
  assert.doesNotMatch(fs.readFileSync(agyShellScript.runScriptPath, 'utf8'), /agy' --print .*"\$agent_prompt"/);
  assert.doesNotMatch(fs.readFileSync(agyShellScript.runScriptPath, 'utf8'), /agy' --print .*"\$\(cat/);
  assert.doesNotMatch(fs.readFileSync(agyShellScript.runScriptPath, 'utf8'), /@prompt-file/);

  const enhancedShellRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-enhanced-shell-'));
  const enhancedShellScript = extensionModule.__buildAgentShellScript(
    'agy',
    'Ship the MVP',
    enhancedShellRoot,
    '2',
    46,
    '检查函数引用和影响面',
    undefined,
    '',
    '',
    'step',
    '',
    enhancementRuntimeRoot,
    'auto',
    '',
    'high_risk',
    { 'command-output-optimizer': true, 'code-structure-assistant': true }
  );
  const enhancedRunScript = fs.readFileSync(enhancedShellScript.runScriptPath, 'utf8');
  const enhancedPrompt = fs.readFileSync(enhancedShellScript.promptFilePath, 'utf8');
  assert.match(enhancedRunScript, /SOLOMAP_RTK_OUTPUT_OPTIMIZER=1/);
  assert.match(enhancedRunScript, /export PATH=.*enhancements\/runtime\/bin/);
  assert.doesNotMatch(enhancedRunScript, /codegraph init -i/);
  assert.match(enhancedRunScript, /harness-enhancements\.md/);
  assert.match(enhancedRunScript, /timeout 6s/);
  assert.match(enhancedRunScript, /codegraph status/);
  assert.match(enhancedRunScript, /codegraph query/);
  assert.match(enhancedRunScript, /codegraph affected --stdin --quiet/);
  assert.match(enhancedPrompt, /SoloMap Harness 增强运行时/);
  assert.match(enhancedPrompt, /SOLOMAP_RTK_BYPASS=1/);
  childProcess.execFileSync('bash', ['-n', enhancedShellScript.runScriptPath]);

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
  assert.match(revisionPrompt, /validate-roadmap\.cjs --mode revision/);
  assert.match(revisionPrompt, /核心产品（商业化产品）/);
  assert.match(revisionPrompt, /不可强行套用营销或销售任务/);
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
  assert.match(soloPrompt, /SoloMap 项目文档 Harness/);
  assert.match(soloPrompt, /documentation\.json/);
  assert.match(soloPrompt, /不要新建 `docs\/summary\.md`/);
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

  const manifestPath = path.join(soloAttachmentRoot, '.solopreneur', 'documentation.json');
  assert.ok(fs.existsSync(manifestPath));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.ok(Array.isArray(manifest.documents));

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

  const digestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-run-digest-'));
  const digest = extensionModule.__buildRunDigest({
    workspaceRoot: digestRoot,
    nodeId: '2',
    runKind: 'step',
    agentCli: 'codex',
    executionLogId: 42,
    userMessage: '修复 src/extension.ts 的 prompt 注入。',
    resolvedCommand: 'npm test',
    status: 'Completed',
    startedAt: '2026-06-02T00:00:00.000Z',
    finishedAt: '2026-06-02T00:01:00.000Z',
    durationMs: 60000,
    changedFilesSummary: 'M src/extension.ts\nM test/webview-regression.test.js',
    touchedFilesSummary: 'M src/extension.ts',
    outputTail: 'Implemented prompt injection.\nRAW_LOG_SHOULD_NOT_APPEAR\nnpm test passed',
    completionReason: '相关执行经验已接入 prompt。',
    failureCode: '',
    failureReason: ''
  });
  assert.equal(digest.schemaVersion, 2);
  assert.match(digest.handoff.nextAgentBrief, /相关执行经验已接入 prompt/);
  assert.ok(digest.handoff.filesToInspectFirst.includes('src/extension.ts'));
  assert.ok(digest.handoff.commandsToRunNext.includes('npm test'));
  const digestPath = extensionModule.__writeRunDigest(digestRoot, digest);
  assert.ok(fs.existsSync(digestPath));
  const graphPath = path.join(digestRoot, '.solopreneur', 'execution-graph.json');
  assert.ok(fs.existsSync(graphPath));
  const graphFile = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  assert.equal(graphFile.runCount, 1);
  assert.ok(graphFile.indexes.byFile['src/extension.ts'].includes(digest.runId));
  const experiencePrompt = extensionModule.__buildExecutionExperiencePrompt(digestRoot, {
    nodeId: '2',
    runKind: 'step',
    contextText: '继续修复 src/extension.ts 的 SoloMap prompt 注入。',
    supplementFiles: ['src/extension.ts']
  });
  assert.match(experiencePrompt, /SoloMap 相关执行经验/);
  assert.match(experiencePrompt, /修复 src\/extension\.ts/);
  assert.match(experiencePrompt, /src\/extension\.ts/);
  assert.match(experiencePrompt, /下一位 Agent 交接/);
  assert.match(experiencePrompt, /建议先看/);
  assert.match(experiencePrompt, /npm test passed/);
  assert.doesNotMatch(experiencePrompt, /RAW_LOG_SHOULD_NOT_APPEAR/);
  const crossAgentInstructions = extensionModule.__buildCrossAgentHandoffInstructions(digestRoot, '2', 'step');
  assert.match(crossAgentInstructions, /solomap-experience\.cjs handoff/);
  assert.match(crossAgentInstructions, /solomap-cross-agent-handoff\/SKILL\.md/);

  const SQL = await require('sql.js')();
  const cliDbPath = path.join(digestRoot, '.solopreneur', 'project_journal.db');
  const db = new SQL.Database();
  db.run('CREATE TABLE execution_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, nodeId TEXT, timestamp TEXT, agentCli TEXT, command TEXT, output TEXT, status TEXT)');
  db.run(
    'INSERT INTO execution_logs (nodeId, timestamp, agentCli, command, output, status) VALUES (?, ?, ?, ?, ?, ?)',
    [
      '2',
      '2026-06-02T00:01:00.000Z',
      'codex',
      'npm test',
      [
        'User supplement:',
        '继续修复 prompt 注入',
        '',
        'Workspace changes:',
        'M src/extension.ts',
        '',
        'Completion decision:',
        '相关执行经验已接入 prompt。',
        '',
        'Agent output tail:',
        'RAW_SQLITE_LOG_SHOULD_NOT_APPEAR',
        'npm test passed'
      ].join('\n'),
      'Completed'
    ]
  );
  fs.writeFileSync(cliDbPath, Buffer.from(db.export()));
  db.close();
  const cliOutput = childProcess.execFileSync(
    process.execPath,
    [
      path.join(projectRoot, 'resources/tools/solomap-experience.cjs'),
      'handoff',
      '--project',
      digestRoot,
      '--node',
      '2',
      '--json'
    ],
    { encoding: 'utf8' }
  );
  const cliJson = JSON.parse(cliOutput);
  assert.equal(cliJson.command, 'handoff');
  assert.equal(cliJson.payload[0].executionLogId, 42);
  assert.match(cliJson.payload[0].brief, /相关执行经验已接入 prompt/);
  assert.ok(cliJson.payload[0].filesToInspectFirst.includes('src/extension.ts'));
  assert.doesNotMatch(cliOutput, /RAW_SQLITE_LOG_SHOULD_NOT_APPEAR/);

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
  assert.match(bootstrapInstructions, /validate-roadmap\.cjs --mode bootstrap/);
  assert.match(bootstrapInstructions, /按项目真实目标选择适用的推进框架/);
  assert.match(bootstrapInstructions, /6 个类别/);
  assert.match(bootstrapInstructions, /Build->Sell->Learn->Improve/);
  assert.match(bootstrapInstructions, /不要把本文件内容、提示词模板或解释性说明写回 CSV/);
  assert.match(extensionModule.__buildRoadmapValidationScript(), /--mode bootstrap/);
  assert.match(extensionModule.__buildRoadmapValidationScript(), /--mode revision/);
  assert.match(extensionModule.__buildLocalRoadmap('SaaS app', 'codex')[0].agentPrompt, /validate-roadmap\.cjs --mode bootstrap/);
  const scriptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-roadmap-script-'));
  const scriptSolopreneurDir = path.join(scriptRoot, '.solopreneur');
  fs.mkdirSync(scriptSolopreneurDir, { recursive: true });
  extensionModule.__ensureRoadmapValidationScript(scriptSolopreneurDir);
  fs.writeFileSync(path.join(scriptSolopreneurDir, 'roadmap.csv'), [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '10,梳理目标客户,整理 ICP 与定价假设,问题与客户发现,,agy,创建 docs/icp.md 并补充访谈假设,Pending,2026-01-01T00:00:00.000Z,',
    '20,实现首个 MVP 切片,完成最小闭环,产品与 MVP,10,agy,修改 src/app.js 并运行 npm test,Pending,2026-01-01T00:00:00.000Z,'
  ].join('\n'), 'utf8');
  const scriptPassOutput = childProcess.execFileSync(process.execPath, ['.solopreneur/validate-roadmap.cjs', '--mode', 'bootstrap'], { cwd: scriptRoot, encoding: 'utf8' });
  assert.match(scriptPassOutput, /PASS roadmap validation: bootstrap/);
  fs.writeFileSync(path.join(scriptSolopreneurDir, 'roadmap.csv'), [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '10,生成初始路线图,desc,问题与客户发现,,agy,"你的唯一主任务是直接重写 .solopreneur/roadmap.csv",Pending,2026-01-01T00:00:00.000Z,'
  ].join('\n'), 'utf8');
  assert.throws(
    () => childProcess.execFileSync(process.execPath, ['.solopreneur/validate-roadmap.cjs', '--mode', 'bootstrap'], { cwd: scriptRoot, encoding: 'utf8', stdio: 'pipe' }),
    /FAIL roadmap validation/
  );
  assert.match(methodologyInstructions, /商业化产品的默认四阶段/);
  assert.match(methodologyInstructions, /底层判断模型/);
  assert.match(methodologyInstructions, /不要为了满足模板/);
  assert.match(methodologyInstructions, /完成标准判断/);
});

test('documentation manifest indexes project docs and flags noisy docs after runs', () => {
  const documentation = require(path.join(projectRoot, 'out/documentationManifest.js'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-doc-manifest-'));
  fs.mkdirSync(path.join(tempRoot, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'docs', 'methodology'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'README.md'), '# Product\n\nA useful project.', 'utf8');
  fs.writeFileSync(path.join(tempRoot, 'docs', 'methodology', 'methodology.zh.md'), [
    '# 生命周期模型',
    '',
    '## 这份文档解决什么判断',
    '说明项目如何推进。',
    '',
    '## 适用范围',
    '项目路线图。'
  ].join('\n'), 'utf8');

  const manifest = documentation.ensureDocumentationManifest(tempRoot, '2026-06-01T00:00:00.000Z');
  assert.ok(fs.existsSync(path.join(tempRoot, '.solopreneur', 'documentation.json')));
  assert.ok(manifest.documents.some((document) => document.path === 'README.md' && document.role === 'direction'));
  assert.ok(manifest.documents.some((document) => document.path === 'docs/methodology/methodology.zh.md' && document.role === 'methodology'));

  fs.writeFileSync(path.join(tempRoot, 'docs', 'summary.md'), [
    '# Summary',
    '',
    '$ npm test',
    'Workspace changes:',
    'M src/app.ts',
    'Touched project files:',
    'M docs/summary.md',
    'Agent output tail:',
    'Run duration ms: 1200'
  ].join('\n'), 'utf8');

  const audit = documentation.auditDocumentationAfterRun(tempRoot, {
    nodeId: '2',
    runKind: 'step',
    status: 'Completed',
    changedFilesSummary: 'A docs/summary.md\nM src/app.ts\n',
    touchedFilesSummary: 'A docs/summary.md\n',
    finishedAt: '2026-06-01T01:00:00.000Z'
  });

  assert.match(audit.summary, /建议确认/);
  assert.ok(audit.pendingReview.some((item) => /低语义/.test(item.reason)));
  assert.ok(audit.pendingReview.some((item) => /prompt|终端输出|执行流水/.test(item.reason)));
  const written = JSON.parse(fs.readFileSync(path.join(tempRoot, '.solopreneur', 'documentation.json'), 'utf8'));
  assert.equal(written.lastAudit.action, 'needs_review');
  assert.ok(written.pendingReview.length >= 2);
});

test('failed conversations render retry action in roadmap webview', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    'module.exports.__getWebviewHtml = roadmapWebview_1.getWebviewHtml;'
  );
  const html = extensionModule.__getWebviewHtml(createWebviewStub(), { extensionPath: projectRoot, extensionUri: createUri(projectRoot) });

  assert.match(html, /conversation-retry-btn/);
  assert.match(html, /Retry|重试/);
  assert.match(html, /retryConversation/);
  assert.match(html, /data-open-file-path/);
  assert.match(html, /data-open-file-hash/);
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
  const source = [
    fs.readFileSync(path.join(projectRoot, 'src', 'extension.ts'), 'utf8'),
    fs.readFileSync(path.join(projectRoot, 'src', 'roadmapWebview.ts'), 'utf8')
  ].join('\n');
  assert.match(source, /function extractConversationPreGitHash/);
  assert.match(source, /openProjectFileDiff/);
  assert.match(source, /vscode\.commands\.executeCommand\('vscode\.diff'/);
  assert.match(source, /rollbackChange/);
  const projectSignalsSource = fs.readFileSync(path.join(projectRoot, 'src', 'projectSignals.ts'), 'utf8');
  assert.match(projectSignalsSource, /当前项目交付信号/);
  assert.match(projectSignalsSource, /'3'/);
  assert.match(projectSignalsSource, /'run',\s*'list'/);
  assert.match(projectSignalsSource, /'release',\s*'list'/);
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

test('agent impact summary counts local SoloMap contribution by agent', () => {
  const { buildAgentImpactSummary } = require(path.join(projectRoot, 'out/agentImpact.js'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-agent-impact-'));
  const solopreneurDir = path.join(tempRoot, '.solopreneur');
  const runsRoot = path.join(tempRoot, '.solopreneur', 'agent-runs');
  const runToday = path.join(runsRoot, '1');
  const runWeek = path.join(runsRoot, '2');
  fs.mkdirSync(runToday, { recursive: true });
  fs.mkdirSync(runWeek, { recursive: true });
  fs.writeFileSync(path.join(solopreneurDir, 'roadmap.csv'), [
    'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt',
    '1,Plan,,目标与路径确认,,codex,,Completed,2026-01-01T00:00:00.000Z,2026-01-01T00:10:00.000Z',
    '2,Ship,,交付与验证,1,codex,,Pending,2026-01-01T00:00:00.000Z,'
  ].join('\n'));
  fs.writeFileSync(path.join(runToday, 'started_at'), '2026-06-01T10:00:00.000Z', 'utf8');
  fs.writeFileSync(path.join(runToday, 'command.txt'), "cat prompt.txt | codex exec -", 'utf8');
  fs.writeFileSync(path.join(runToday, 'output.log'), 'Run duration ms: 120000', 'utf8');
  fs.writeFileSync(path.join(runToday, 'touched-files.txt'), 'M src/view.ts\nA docs/result.md\n', 'utf8');
  fs.writeFileSync(path.join(runToday, 'completion.json'), JSON.stringify({ markCompleted: true }), 'utf8');
  fs.writeFileSync(path.join(runWeek, 'started_at'), '2026-05-30T10:00:00.000Z', 'utf8');
  fs.writeFileSync(path.join(runWeek, 'command.txt'), "claude -p 'ship'", 'utf8');
  fs.writeFileSync(path.join(runWeek, 'output.log'), 'Run duration ms: 60000', 'utf8');
  fs.writeFileSync(path.join(runWeek, 'touched-files.txt'), 'M src/view.ts\nM src/api.ts\n', 'utf8');
  fs.writeFileSync(path.join(runWeek, 'completion.json'), JSON.stringify({ markCompleted: false, failureReason: 'stopped' }), 'utf8');

  const summary = buildAgentImpactSummary(
    [{ name: 'Impact Project', path: tempRoot }],
    new Date('2026-06-01T12:00:00.000Z')
  );

  assert.equal(summary.weekRuns, 2);
  assert.equal(summary.totalRuns, 2);
  assert.equal(summary.completedRuns, 1);
  assert.equal(summary.failedRuns, 1);
  assert.equal(summary.totalMinutes, 3);
  assert.equal(summary.changedFiles, 3);
  assert.equal(summary.projectProgressPercent, 50);
  assert.deepEqual(summary.byAgent.map((item) => [item.agent, item.runs, item.minutes, item.changedFiles]), [['codex', 1, 2, 2], ['claude', 1, 1, 2]]);
});

test('step conversations can start independently while dependencies or other runs are active', async () => {
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
      const id = 41 + executionLogs.length;
      executionLogs.push({ id, nodeId, agentCli, command, output, status });
      return id;
    },
    updateAgentExecution: (id, agentCli, command, output, status) => {
      const entry = executionLogs.find((candidate) => candidate.id === id);
      if (entry) {
        Object.assign(entry, { agentCli, command, output, status });
      }
      return Boolean(entry);
    },
    getAgentExecutions: () => []
  }, projectRoot);

  await extensionModule.__handleRunAgent({
    globalState: {
      get: () => ({ cliPath: 'codex', language: 'zh', globalPrompt: '' })
    }
  }, '2', '先讨论可交付的 MVP 范围。', 'codex');
  nodes[1].status = 'Running';
  await extensionModule.__handleRunAgent({
    globalState: {
      get: () => ({ cliPath: 'codex', language: 'zh', globalPrompt: '' })
    }
  }, '2', '并行评估另一版 MVP 范围。', 'codex');

  assert.ok(updates.some((entry) => entry.nodeId === '2' && entry.update.status === 'Running'));
  assert.equal(executionLogs.length, 2);
  assert.equal(executionLogs[0].nodeId, '2');
  assert.equal(executionLogs[0].status, 'Running');
  assert.equal(executionLogs[1].nodeId, '2');
  assert.equal(executionLogs[1].status, 'Running');
  assert.ok(fs.existsSync(path.join(projectRoot, '.solopreneur', 'agent-runs', '2', '41', 'run-agent.sh')));
  assert.ok(fs.existsSync(path.join(projectRoot, '.solopreneur', 'agent-runs', '2', '42', 'run-agent.sh')));
  assert.ok(fs.readFileSync(path.join(projectRoot, '.solopreneur', 'agent-runs', '2', '41', 'run-agent.sh'), 'utf8').includes('.solopreneur/agent-status/41.json'));
  assert.ok(fs.readFileSync(path.join(projectRoot, '.solopreneur', 'agent-runs', '2', '42', 'run-agent.sh'), 'utf8').includes('.solopreneur/agent-status/42.json'));
});

test('finishing one parallel step conversation keeps the node running without rewriting that conversation status', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__processAgentStatusFile = processAgentStatusFile;',
      'module.exports.__setRuntimeForTest = (engine, projectRoot) => { syncEngine = engine; activeProjectRoot = projectRoot; };'
    ].join('\n')
  );
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-parallel-finish-'));
  const runDir = path.join(projectRoot, '.solopreneur', 'agent-runs', '2', '21');
  fs.mkdirSync(runDir, { recursive: true });
  const outputFilePath = path.join(runDir, 'output.log');
  const changesFilePath = path.join(runDir, 'changes.txt');
  const touchedFilesPath = path.join(runDir, 'touched-files.txt');
  const completionDecisionFilePath = path.join(runDir, 'completion.json');
  fs.writeFileSync(outputFilePath, 'Done.\n', 'utf8');
  fs.writeFileSync(changesFilePath, ' M src/app.ts\n', 'utf8');
  fs.writeFileSync(touchedFilesPath, 'src/app.ts\n', 'utf8');
  fs.writeFileSync(completionDecisionFilePath, JSON.stringify({ markCompleted: true, reason: '已完成这一条对话。' }), 'utf8');
  const statusFilePath = path.join(projectRoot, '.solopreneur', 'agent-status', '21.json');
  fs.mkdirSync(path.dirname(statusFilePath), { recursive: true });
  fs.writeFileSync(statusFilePath, JSON.stringify({
    nodeId: '2',
    runKind: 'step',
    status: 'In Progress',
    agentCli: 'codex',
    command: 'codex exec',
    executionLogId: 21,
    userMessage: '完成第一条并发对话',
    outputFilePath,
    changesFilePath,
    touchedFilesPath,
    completionDecisionFilePath,
    startedAt: '2026-06-06T00:00:00.000Z'
  }), 'utf8');
  let nodeUpdate = null;
  let executionUpdate = null;
  extensionModule.__setRuntimeForTest({
    getNodes: () => [{ id: '2', title: '实现 MVP', status: 'Running' }],
    updateNode: (_nodeId, update) => { nodeUpdate = update; },
    getAgentExecutions: () => [
      { id: 22, nodeId: '2', agentCli: 'codex', command: 'codex exec', output: 'Still running.', status: 'Running' },
      { id: 21, nodeId: '2', agentCli: 'codex', command: 'codex exec', output: 'Agent conversation started.', status: 'Running' }
    ],
    updateAgentExecution: (id, agentCli, command, output, status) => {
      executionUpdate = { id, agentCli, command, output, status };
      return true;
    },
    logAgentExecution: () => 99
  }, projectRoot);

  await extensionModule.__processAgentStatusFile(statusFilePath);

  assert.equal(nodeUpdate.status, 'Running');
  assert.equal(executionUpdate.id, 21);
  assert.equal(executionUpdate.status, 'Completed');
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

test('completed step starts read-only Agent review before marking the step complete', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__processAgentStatusFile = processAgentStatusFile;',
      'module.exports.__setRuntimeForTest = (engine, projectRoot) => { syncEngine = engine; activeProjectRoot = projectRoot; };',
      'module.exports.__setCommandExistsForTest = (fn) => { commandExists = fn; };',
      'module.exports.__setTerminalForTest = (fn) => { createAgentTerminal = fn; };'
    ].join('\n')
  );
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-agent-review-start-'));
  const runDir = path.join(tempRoot, '.solopreneur', 'agent-runs', '2');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'completion.json'), '{"markCompleted":true,"reason":"实现已完成"}', 'utf8');
  fs.writeFileSync(path.join(runDir, 'changes.txt'), 'M src/app.js\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'touched-files.txt'), 'M src/app.js\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'output.log'), 'Implemented and validated.\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'command.txt'), 'codex exec\n', 'utf8');
  const statusFilePath = path.join(tempRoot, '.agent_status.json');
  fs.writeFileSync(statusFilePath, JSON.stringify({
    nodeId: '2',
    runKind: 'step',
    status: 'In Progress',
    agentCli: 'codex',
    reviewerCliPath: 'agy',
    collaborationReviewMode: 'high_risk',
    executionLogId: 12,
    userMessage: '完成 MVP',
    outputFilePath: path.join(runDir, 'output.log'),
    changesFilePath: path.join(runDir, 'changes.txt'),
    touchedFilesPath: path.join(runDir, 'touched-files.txt'),
    commandFilePath: path.join(runDir, 'command.txt'),
    completionDecisionFilePath: path.join(runDir, 'completion.json'),
    startedAt: '2026-05-24T00:00:00.000Z'
  }), 'utf8');

  let nodeUpdate = null;
  const executionUpdates = [];
  const executionLogs = [];
  let reviewCommand = '';
  extensionModule.__setCommandExistsForTest(() => true);
  extensionModule.__setTerminalForTest(() => ({
    show() {},
    sendText(command) {
      reviewCommand = command;
    }
  }));
  extensionModule.__setRuntimeForTest({
    getNodes: () => [{ id: '2', title: '实现 MVP', status: 'Running' }],
    updateNode: (_nodeId, update) => { nodeUpdate = update; },
    updateAgentExecution: (_id, _cli, _command, output, status) => {
      executionUpdates.push({ output, status });
      return true;
    },
    logAgentExecution: (nodeId, agentCli, command, output, status) => {
      executionLogs.push({ nodeId, agentCli, command, output, status });
      return 88;
    },
    getAgentExecutions: () => []
  }, tempRoot);

  await extensionModule.__processAgentStatusFile(statusFilePath);

  assert.equal(nodeUpdate.status, 'In Progress');
  assert.match(executionUpdates[0].output, /正在等待副 Agent 复核/);
  assert.equal(executionLogs.length, 1);
  assert.equal(path.basename(executionLogs[0].agentCli), 'agy');
  assert.equal(executionLogs[0].status, 'Running');
  assert.match(executionLogs[0].output, /Agent review started/);
  assert.match(reviewCommand, /run-agent-review\.sh/);
  const reviewPrompt = fs.readFileSync(path.join(runDir, 'review-12', 'prompt.txt'), 'utf8');
  assert.match(reviewPrompt, /只读复核 Agent/);
  assert.match(reviewPrompt, /不要修改项目文件/);
});

test('completed Solo conversation starts configured review Agent when review mode is every task', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__processAgentStatusFile = processAgentStatusFile;',
      'module.exports.__setRuntimeForTest = (engine, projectRoot) => { syncEngine = engine; activeProjectRoot = projectRoot; };',
      'module.exports.__setCommandExistsForTest = (fn) => { commandExists = fn; };',
      'module.exports.__setTerminalForTest = (fn) => { createAgentTerminal = fn; };'
    ].join('\n')
  );
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-solo-agent-review-start-'));
  const runDir = path.join(tempRoot, '.solopreneur', 'agent-runs', '__solo__', '21');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'changes.txt'), '', 'utf8');
  fs.writeFileSync(path.join(runDir, 'touched-files.txt'), '', 'utf8');
  fs.writeFileSync(path.join(runDir, 'output.log'), 'Solo task completed.\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'command.txt'), 'codex exec\n', 'utf8');
  const statusFilePath = path.join(tempRoot, '.agent_status-21.json');
  fs.writeFileSync(statusFilePath, JSON.stringify({
    nodeId: '__solo__',
    runKind: 'solo',
    status: 'In Progress',
    agentCli: 'codex',
    reviewerCliPath: 'agy',
    collaborationReviewMode: 'all',
    executionLogId: 21,
    userMessage: '检查 Solo 任务复核',
    outputFilePath: path.join(runDir, 'output.log'),
    changesFilePath: path.join(runDir, 'changes.txt'),
    touchedFilesPath: path.join(runDir, 'touched-files.txt'),
    commandFilePath: path.join(runDir, 'command.txt'),
    startedAt: '2026-05-24T00:00:00.000Z'
  }), 'utf8');

  const executionUpdates = [];
  const executionLogs = [];
  let reviewCommand = '';
  extensionModule.__setCommandExistsForTest(() => true);
  extensionModule.__setTerminalForTest(() => ({
    show() {},
    sendText(command) {
      reviewCommand = command;
    }
  }));
  extensionModule.__setRuntimeForTest({
    getNodes: () => [],
    updateNode: () => { throw new Error('Solo review must not update roadmap nodes.'); },
    updateAgentExecution: (_id, _cli, _command, output, status) => {
      executionUpdates.push({ output, status });
      return true;
    },
    logAgentExecution: (nodeId, agentCli, command, output, status) => {
      executionLogs.push({ nodeId, agentCli, command, output, status });
      return 89;
    },
    getAgentExecutions: () => [],
    getProjectAgentExecutions: () => []
  }, tempRoot);

  await extensionModule.__processAgentStatusFile(statusFilePath);

  assert.equal(executionUpdates[0].status, 'Completed');
  assert.match(executionUpdates[0].output, /Solo conversation state: Completed/);
  assert.equal(executionLogs.length, 1);
  assert.equal(executionLogs[0].nodeId, '__solo__');
  assert.equal(path.basename(executionLogs[0].agentCli), 'agy');
  assert.equal(executionLogs[0].status, 'Running');
  assert.match(executionLogs[0].output, /Agent review started/);
  assert.match(reviewCommand, /run-agent-review\.sh/);
  const reviewPrompt = fs.readFileSync(path.join(tempRoot, '.solopreneur', 'agent-runs', '__solo__', 'review-21', 'prompt.txt'), 'utf8');
  assert.match(reviewPrompt, /只读复核 Agent/);
  assert.match(reviewPrompt, /runKind: solo/);
});

test('passing Agent review completes the deferred roadmap step', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__processAgentStatusFile = processAgentStatusFile;',
      'module.exports.__setRuntimeForTest = (engine, projectRoot) => { syncEngine = engine; activeProjectRoot = projectRoot; };'
    ].join('\n')
  );
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-agent-review-pass-'));
  const runDir = path.join(tempRoot, '.solopreneur', 'agent-runs', '2', 'review-12');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'review-result.json'), JSON.stringify({
    status: 'pass',
    summary: '复核通过，可以完成环节。',
    findings: [],
    nextAction: '写入完成证据'
  }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'changes.txt'), '', 'utf8');
  fs.writeFileSync(path.join(runDir, 'touched-files.txt'), '', 'utf8');
  fs.writeFileSync(path.join(runDir, 'output.log'), 'Review passed.\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'command.txt'), 'agy review\n', 'utf8');
  const statusFilePath = path.join(tempRoot, '.agent_status.json');
  fs.writeFileSync(statusFilePath, JSON.stringify({
    nodeId: '2',
    runKind: 'agent_review',
    status: 'In Progress',
    agentCli: 'agy',
    executionLogId: 88,
    reviewOfExecutionLogId: 12,
    reviewTargetStatus: 'Completed',
    reviewResultFilePath: path.join(runDir, 'review-result.json'),
    outputFilePath: path.join(runDir, 'output.log'),
    changesFilePath: path.join(runDir, 'changes.txt'),
    touchedFilesPath: path.join(runDir, 'touched-files.txt'),
    commandFilePath: path.join(runDir, 'command.txt'),
    startedAt: '2026-05-24T00:00:00.000Z'
  }), 'utf8');

  let nodeUpdate = null;
  let loggedOutput = '';
  let loggedStatus = '';
  extensionModule.__setRuntimeForTest({
    getNodes: () => [{ id: '2', title: '实现 MVP', status: 'In Progress' }],
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

  assert.equal(nodeUpdate.status, 'Completed');
  assert.ok(nodeUpdate.completedAt);
  assert.equal(loggedStatus, 'Completed');
  assert.match(loggedOutput, /Review decision: pass/);
  assert.match(loggedOutput, /复核通过，可以完成环节/);
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
  assert.match(loggedOutput, /Execution digest saved: \.solopreneur\/run-digests\/__solo__-77\.json/);
  assert.ok(fs.existsSync(path.join(solopreneurDir, 'run-digests', '__solo__-77.json')));
  assert.equal(fs.readFileSync(path.join(solopreneurDir, 'roadmap.csv'), 'utf8'), originalCsv);
});

test('continuation runs are recorded without task status judgment while preserving file changes', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__processAgentStatusFile = processAgentStatusFile;',
      'module.exports.__setRuntimeForTest = (engine, projectRoot) => { syncEngine = engine; activeProjectRoot = projectRoot; };'
    ].join('\n')
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-continuation-recorded-'));
  const runDir = path.join(root, '.solopreneur', 'agent-runs', '2', '88');
  fs.mkdirSync(runDir, { recursive: true });
  const outputFilePath = path.join(runDir, 'output.log');
  const changesFilePath = path.join(runDir, 'changes.txt');
  const touchedFilesPath = path.join(runDir, 'touched-files.txt');
  fs.writeFileSync(outputFilePath, 'User continued the native session.\n', 'utf8');
  fs.writeFileSync(changesFilePath, ' M src/extension.ts\n', 'utf8');
  fs.writeFileSync(touchedFilesPath, 'src/extension.ts\n', 'utf8');
  const statusFilePath = path.join(root, '.solopreneur', 'agent-status', '88.json');
  fs.mkdirSync(path.dirname(statusFilePath), { recursive: true });
  fs.writeFileSync(statusFilePath, JSON.stringify({
    nodeId: '2',
    runKind: 'step_continue',
    status: 'Failed',
    failureCode: 'agent_exit_failed',
    failureReason: 'Native terminal closed.',
    agentCli: 'codex',
    command: 'codex resume',
    executionLogId: 88,
    outputFilePath,
    changesFilePath,
    touchedFilesPath,
    nativeSessionId: '019dc472-6a80-7c70-99a4-b2593a641d11',
    startedAt: '2026-06-15T00:00:00.000Z'
  }), 'utf8');

  let updateNodeCalled = false;
  let loggedOutput = '';
  let loggedStatus = '';
  extensionModule.__setRuntimeForTest({
    getNodes: () => [{ id: '2', title: '实现 MVP', status: 'In Progress' }],
    updateNode: () => { updateNodeCalled = true; },
    getAgentExecutions: () => [{ id: 88, nodeId: '2', agentCli: 'codex', command: 'codex resume', output: 'Agent continuation started.\n\nContinuation parent conversation: 12', status: 'Running' }],
    updateAgentExecution: (_id, _cli, _command, output, status) => {
      loggedOutput = output;
      loggedStatus = status;
      return true;
    },
    logAgentExecution: () => 88,
    initAndSync: async () => {}
  }, root);

  await extensionModule.__processAgentStatusFile(statusFilePath);

  assert.equal(updateNodeCalled, false);
  assert.equal(loggedStatus, 'Recorded');
  assert.match(loggedOutput, /Continuation record state: Recorded/);
  assert.match(loggedOutput, /续聊已记录；不参与任务完成、失败或进行中判断。/);
  assert.match(loggedOutput, /Workspace changes:\n\nM src\/extension\.ts/);
  assert.doesNotMatch(loggedOutput, /Failure category: agent_exit_failed/);
  assert.ok(fs.existsSync(path.join(root, '.solopreneur', 'run-digests', '2-88.json')));
});

test('linking a Solo conversation records a reference without changing the step state', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__linkSoloConversationToNode = linkSoloConversationToNode;',
      'module.exports.__setRuntimeForTest = (engine, projectRoot, panel) => { syncEngine = engine; activeProjectRoot = projectRoot; activePanel = panel; };'
    ].join('\n')
  );
  let linkedRecord = null;
  const postedMessages = [];
  let stepConversationReadCount = 0;
  extensionModule.__setRuntimeForTest({
    getNodes: () => [{ id: '2', title: '实现 MVP', status: 'In Progress' }],
    updateNode: () => { throw new Error('linking a Solo reference must not change step status'); },
    getAgentExecutions: (nodeId) => {
      if (nodeId === '__solo__') {
        return [{ id: 12, nodeId, agentCli: 'codex', command: 'codex exec', output: '结论：关联实现 MVP。', status: 'Completed' }];
      }
      if (nodeId === '2') {
        stepConversationReadCount += 1;
        return stepConversationReadCount === 1
          ? [{ id: 7, nodeId, agentCli: 'agy', command: 'agy run', output: '既有环节对话。', status: 'Completed' }]
          : [];
      }
      return [];
    },
    logAgentExecution: (nodeId, agentCli, command, output, status) => {
      linkedRecord = { nodeId, agentCli, command, output, status };
      return 88;
    }
  }, '/workspace/app', {
    webview: {
      postMessage(message) {
        postedMessages.push(message);
      }
    }
  });

  extensionModule.__linkSoloConversationToNode(12, '2');

  assert.equal(linkedRecord.nodeId, '2');
  assert.equal(linkedRecord.status, 'Linked');
  assert.match(linkedRecord.output, /Linked from Solo conversation/);
  assert.match(linkedRecord.output, /Solo reference ID: 12/);
  const stepRefresh = postedMessages.find((message) => message.command === 'nodeConversationsLoaded' && message.nodeId === '2');
  assert.equal(stepRefresh.conversations.length, 2);
  assert.equal(stepRefresh.conversations[0].id, 88);
  assert.equal(stepRefresh.conversations[0].status, 'Linked');
  assert.equal(stepRefresh.conversations[1].id, 7);
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

test('stopping a continuation records it without marking the task failed', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__stopAgentRun = stopAgentRun;',
      'module.exports.__setRuntimeForTest = (engine, projectRoot) => { syncEngine = engine; activeProjectRoot = projectRoot; };'
    ].join('\n')
  );
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-stop-continuation-'));
  const runDir = path.join(tempRoot, '.solopreneur', 'agent-runs', '3', '31');
  fs.mkdirSync(runDir, { recursive: true });
  const outputFilePath = path.join(runDir, 'output.log');
  fs.writeFileSync(outputFilePath, 'Working inside native continuation.\n', 'utf8');
  const statusFilePath = path.join(tempRoot, '.solopreneur', 'agent-status', '31.json');
  fs.mkdirSync(path.dirname(statusFilePath), { recursive: true });
  fs.writeFileSync(statusFilePath, JSON.stringify({
    nodeId: '3',
    runKind: 'step_continue',
    status: 'Running',
    executionLogId: 31,
    agentCli: 'codex',
    outputFilePath,
    startedAt: '2026-05-24T00:00:00.000Z'
  }), 'utf8');
  let nodeUpdated = false;
  let updatedStatus = '';
  let updatedOutput = '';
  extensionModule.__setRuntimeForTest({
    getNodes: () => [{ id: '3', title: '完善体验', status: 'Running' }],
    updateNode: () => { nodeUpdated = true; },
    getAgentExecutions: () => [{ id: 31, nodeId: '3', agentCli: 'codex', command: 'codex resume', output: 'Agent continuation started.', status: 'Running' }],
    updateAgentExecution: (_id, _cli, _command, output, status) => {
      updatedOutput = output;
      updatedStatus = status;
      return true;
    },
    logAgentExecution: () => 31
  }, tempRoot);

  await extensionModule.__stopAgentRun('3', 31);

  assert.equal(nodeUpdated, false);
  assert.equal(updatedStatus, 'Recorded');
  assert.match(updatedOutput, /Continuation record state: Recorded/);
  assert.doesNotMatch(updatedOutput, /Failure category: stopped_by_user/);
  assert.match(fs.readFileSync(outputFilePath, 'utf8'), /Continuation terminal stopped by user/);
});

test('closing a continuation terminal records the conversation as stopped', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__handleAgentTerminalClosed = handleAgentTerminalClosed;',
      'module.exports.__setRuntimeForTest = (engine, projectRoot) => { syncEngine = engine; activeProjectRoot = projectRoot; };',
      'module.exports.__setAgentTerminalForTest = (conversationId, terminalName, projectRoot) => { agentTerminalNamesByConversationId.set(Number(conversationId), terminalName); agentTerminalProjectRootsByConversationId.set(Number(conversationId), projectRoot); };'
    ].join('\n')
  );
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-close-continuation-'));
  const runDir = path.join(tempRoot, '.solopreneur', 'agent-runs', '__solo__', '41');
  fs.mkdirSync(runDir, { recursive: true });
  const outputFilePath = path.join(runDir, 'output.log');
  fs.writeFileSync(outputFilePath, 'Working inside native continuation.\n', 'utf8');
  const statusFilePath = path.join(tempRoot, '.solopreneur', 'agent-status', '41.json');
  fs.mkdirSync(path.dirname(statusFilePath), { recursive: true });
  fs.writeFileSync(statusFilePath, JSON.stringify({
    nodeId: '__solo__',
    runKind: 'solo_continue',
    status: 'Running',
    executionLogId: 41,
    agentCli: 'codex',
    outputFilePath,
    nativeSessionId: '019dc472-6a80-7c70-99a4-b2593a641d11',
    startedAt: '2026-05-24T00:00:00.000Z'
  }), 'utf8');
  let updatedStatus = '';
  let updatedOutput = '';
  extensionModule.__setRuntimeForTest({
    getNodes: () => [],
    updateNode: () => { throw new Error('closing a continuation terminal must not update roadmap node state'); },
    getAgentExecutions: () => [{
      id: 41,
      nodeId: '__solo__',
      agentCli: 'codex',
      command: 'codex resume',
      output: 'Agent continuation started.\n\nContinuation parent conversation: 39',
      status: 'Running'
    }],
    updateAgentExecution: (_id, _cli, _command, output, status) => {
      updatedOutput = output;
      updatedStatus = status;
      return true;
    },
    logAgentExecution: () => 41
  }, tempRoot);
  extensionModule.__setAgentTerminalForTest(41, 'solomap close test', tempRoot);

  const handled = await extensionModule.__handleAgentTerminalClosed('solomap close test');

  assert.equal(handled, true);
  assert.equal(updatedStatus, 'Recorded');
  assert.match(updatedOutput, /Continuation record state: Recorded/);
  assert.match(updatedOutput, /Continuation session id: 019dc472-6a80-7c70-99a4-b2593a641d11/);
  assert.match(fs.readFileSync(outputFilePath, 'utf8'), /Continuation terminal closed/);
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
  assert.equal(logs[0].status, 'Completed');
  assert.match(logs[0].output, /Done/);

  store.logExecution('3', 'agy', 'agy --print task', 'Launched command in integrated terminal', 'Running');
  store.logExecution('3', 'agy', 'agy --print task', 'Agent output tail:\nFinished.', 'In Progress');
  const cleanedLogs = store.getExecutionLogs('3');
  assert.equal(cleanedLogs.length, 1);
  assert.equal(cleanedLogs[0].status, 'Completed');
  store.close();
});

test('project-level execution history returns latest roadmap run across nodes', async () => {
  const extensionSource = fs.readFileSync(path.join(projectRoot, 'src/extension.ts'), 'utf8');
  const { SqliteStore } = require(path.join(projectRoot, 'out/db/sqliteStore.js'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-project-history-'));
  const store = new SqliteStore(path.join(tempRoot, 'journal.db'), projectRoot);
  await store.init();

  store.logExecution('1', 'agy', 'agy first', 'Agent output tail:\nFirst.', 'Completed');
  store.logExecution('__solo__', 'agy', 'agy solo', 'Agent output tail:\nSolo.', 'Completed');
  const latestRoadmapLogId = store.logExecution('3', 'codex', 'codex latest', 'Agent output tail:\nLatest roadmap run.', 'In Progress');
  const logs = store.getAllExecutionLogs().filter((conversation) => !['__solo__', '__roadmap_revision__'].includes(String(conversation.nodeId || '')));

  assert.equal(logs[0].id, latestRoadmapLogId);
  assert.equal(logs[0].nodeId, '3');
  assert.match(logs[0].output, /Latest roadmap run/);
  assert.match(extensionSource, /const sidebarProjectConversationHistoryLimit = 10/);
  assert.match(extensionSource, /getProjectAgentExecutions\(\)[\s\S]*?\.slice\(0, sidebarProjectConversationHistoryLimit\)/);
  assert.match(extensionSource, /getAllExecutionLogs\(\)[\s\S]*?\.slice\(0, sidebarProjectConversationHistoryLimit\)/);
  store.close();
});

test('posting a step conversation refreshes the sidebar project-level latest run card', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__postNodeConversations = postNodeConversations;',
      'module.exports.__setRuntimeForTest = (engine, projectRoot, sidebar) => { syncEngine = engine; activeProjectRoot = projectRoot; sidebarProvider = sidebar; };'
    ].join('\n')
  );
  const calls = [];
  extensionModule.__setRuntimeForTest({
    getAgentExecutions: () => []
  }, '/workspace/project', {
    sendStepConversationHistory(projectPath, nodeId) {
      calls.push(['step', projectPath, nodeId]);
    },
    sendProjectConversationHistory(projectPath) {
      calls.push(['project', projectPath]);
    },
    sendSoloConversationHistory(projectPath) {
      calls.push(['solo', projectPath]);
    }
  });

  extensionModule.__postNodeConversations('3');

  assert.deepEqual(calls, [
    ['step', '/workspace/project', '3'],
    ['project', '/workspace/project']
  ]);
});

test('project registry persists projects and pin state in the global SoloMap file', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__getProjects = getProjects;',
      'module.exports.__toggleProjectPinned = toggleProjectPinned;'
    ].join('\n')
  );
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-project-registry-'));
  const globalRoot = path.join(tempRoot, '.solomap-global');
  const makeContext = (legacyProjects = []) => {
    const map = new Map([
      ['solopreneur.settings', { cliPath: 'agy', language: 'zh', globalPrompt: '', globalDataPath: globalRoot }],
      ['solopreneur.projects', legacyProjects],
      ['solopreneur.hiddenProjects', []]
    ]);
    return {
      extensionPath: projectRoot,
      globalState: {
        get(key) {
          return map.get(key);
        },
        update(key, value) {
          map.set(key, value);
          return Promise.resolve();
        }
      }
    };
  };

  const firstContext = makeContext([
    { name: 'Alpha', path: '/workspace/alpha' },
    { name: 'Beta', path: '/workspace/beta' }
  ]);
  assert.equal(extensionModule.__getProjects(firstContext).length, 2);
  await extensionModule.__toggleProjectPinned(firstContext, '/workspace/beta');

  const registryPath = path.join(globalRoot, 'projects.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.equal(registry.projects.find((project) => project.path === '/workspace/beta').pinnedAt.length > 0, true);

  const secondContext = makeContext([]);
  const sharedProjects = extensionModule.__getProjects(secondContext);
  assert.equal(sharedProjects[0].path, '/workspace/beta');
  assert.equal(sharedProjects[1].path, '/workspace/alpha');
});

test('Flow pause and abandon commands work correctly', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__setRuntimeForTest = (engine, projectRoot, context) => { syncEngine = engine; activeProjectRoot = projectRoot; extensionContextRef = context; };',
      'module.exports.__updateFlowTrace = flowStore_1.updateFlowTrace;',
      'module.exports.__readFlowTrace = flowStore_1.readFlowTrace;'
    ].join('\n')
  );
  
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-flow-ctrl-'));
  const mockContext = {
    globalState: {
      get: (key) => ({}),
      update: (key, val) => Promise.resolve()
    }
  };
  extensionModule.__setRuntimeForTest(null, tempRoot, mockContext);
  
  const trace = {
    schemaVersion: 1,
    flowId: 'test-flow-123',
    projectPath: tempRoot,
    goal: 'Test flow control',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: { type: 'goal', userInput: 'Test flow control' },
    currentLoopIndex: 1,
    loops: [
      {
        loopId: 'loop-1',
        index: 1,
        goal: 'Test flow control',
        status: 'created',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        planner: { status: 'pending' },
        builder: { status: 'pending' },
        verifier: { status: 'pending' }
      }
    ]
  };
  
  const flowsDir = path.join(tempRoot, '.solopreneur', 'flows');
  fs.mkdirSync(flowsDir, { recursive: true });
  fs.writeFileSync(path.join(flowsDir, 'test-flow-123.json'), JSON.stringify(trace), 'utf8');

  extensionModule.__updateFlowTrace(tempRoot, 'test-flow-123', (t) => {
    t.status = 'paused';
    t.latestSummary = 'Flow 已被用户手动暂停推进。';
    return t;
  });
  
  const pausedTrace = extensionModule.__readFlowTrace(tempRoot, 'test-flow-123');
  assert.equal(pausedTrace.status, 'paused');
  assert.match(pausedTrace.latestSummary, /暂停推进/);

  extensionModule.__updateFlowTrace(tempRoot, 'test-flow-123', (t) => {
    t.status = 'abandoned';
    t.latestSummary = 'Flow 已被用户手动放弃。';
    if (t.loops.length > 0) {
      t.loops[t.loops.length - 1].status = 'abandoned';
    }
    return t;
  });

  const abandonedTrace = extensionModule.__readFlowTrace(tempRoot, 'test-flow-123');
  assert.equal(abandonedTrace.status, 'abandoned');
  assert.equal(abandonedTrace.loops[0].status, 'abandoned');
});

test('Verifier successful close auto-attributes roadmap step status to Completed', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__setRuntimeForTest = (engine, projectRoot, context) => { syncEngine = engine; activeProjectRoot = projectRoot; extensionContextRef = context; };',
      'module.exports.__processFlowStatusFile = processFlowStatusFile;',
      'module.exports.__readFlowTrace = flowStore_1.readFlowTrace;'
    ].join('\n')
  );
  
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-flow-attribution-'));
  const mockContext = {
    globalState: {
      get: (key) => ({}),
      update: (key, val) => Promise.resolve()
    }
  };
  extensionModule.__setRuntimeForTest(null, tempRoot, mockContext);
  
  const mockNodes = [
    { id: 'step-1', title: 'Task 1', status: 'In Progress', dependencies: '' }
  ];
  const mockEngine = {
    updateNode(id, fields) {
      const node = mockNodes.find(n => n.id === id);
      if (node) {
        Object.assign(node, fields);
      }
    },
    getNodes() {
      return mockNodes;
    },
    updateAgentExecution() {},
    logAgentExecution() {
      return 123;
    }
  };
  extensionModule.__setRuntimeForTest(mockEngine, tempRoot);

  const trace = {
    schemaVersion: 1,
    flowId: 'test-flow-456',
    projectPath: tempRoot,
    goal: 'Complete Task 1',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: { type: 'goal', userInput: 'Complete Task 1', roadmapStepId: 'step-1' },
    currentLoopIndex: 1,
    loops: [
      {
        loopId: 'loop-1',
        index: 1,
        goal: 'Complete Task 1',
        status: 'verifying',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        planner: { status: 'completed' },
        builder: { status: 'completed' },
        verifier: { status: 'running' }
      }
    ]
  };
  
  const flowsDir = path.join(tempRoot, '.solopreneur', 'flows');
  fs.mkdirSync(flowsDir, { recursive: true });
  fs.writeFileSync(path.join(flowsDir, 'test-flow-456.json'), JSON.stringify(trace), 'utf8');

  const logDir = path.join(tempRoot, '.solopreneur', 'flows', 'test-flow-456', 'loop-1', 'verifier', '123');
  fs.mkdirSync(logDir, { recursive: true });
  
  const verifierJson = {
    checks: [{ criterion: 'Verify CRM', status: 'pass', evidence: [], reason: '' }],
    H: { pass: true, reason: 'Files modified' },
    I: { pass: true, reason: 'Aligns with goal' },
    J: { pass: true, reason: 'Good design' },
    recommendedStatus: 'closed',
    summary: 'Task 1 fully closed'
  };
  
  fs.writeFileSync(
    path.join(logDir, 'output.log'),
    `SOLOMAP_FLOW_JSON_START\n${JSON.stringify(verifierJson)}\nSOLOMAP_FLOW_JSON_END`,
    'utf8'
  );

  const statusData = {
    nodeId: '__flow__::test-flow-456::loop-1::verifier',
    status: 'In Progress',
    executionLogId: 123,
    outputFilePath: path.join(logDir, 'output.log'),
    changesFilePath: '',
    touchedFilesPath: '',
    commandFilePath: ''
  };

  await extensionModule.__processFlowStatusFile(null, statusData);

  const updatedTrace = extensionModule.__readFlowTrace(tempRoot, 'test-flow-456');
  assert.equal(updatedTrace.status, 'completed');
  assert.equal(mockNodes[0].status, 'Completed');
});

test('Flow role output validation error triggers self-correction loop', async () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__setRuntimeForTest = (engine, projectRoot, context) => { syncEngine = engine; activeProjectRoot = projectRoot; extensionContextRef = context; };',
      'module.exports.__processFlowStatusFile = processFlowStatusFile;',
      'module.exports.__readFlowTrace = flowStore_1.readFlowTrace;',
      'module.exports.__setStartFlowRoleRun = (fn) => { startFlowRoleRun = fn; };'
    ].join('\n')
  );
  
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-flow-retry-'));
  const mockContext = {
    globalState: {
      get: (key) => ({}),
      update: (key, val) => Promise.resolve()
    }
  };
  extensionModule.__setRuntimeForTest(null, tempRoot, mockContext);
  
  let startRoleRunCalled = false;
  let startRoleRunPayload = null;
  extensionModule.__setStartFlowRoleRun(async (context, payload) => {
    startRoleRunCalled = true;
    startRoleRunPayload = payload;
  });

  const mockEngine = {
    updateAgentExecution() {},
    logAgentExecution() {
      return 789;
    }
  };
  extensionModule.__setRuntimeForTest(mockEngine, tempRoot);

  const trace = {
    schemaVersion: 1,
    flowId: 'test-flow-789',
    projectPath: tempRoot,
    goal: 'Test validation correction',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: { type: 'goal', userInput: 'Test validation correction' },
    currentLoopIndex: 1,
    loops: [
      {
        loopId: 'loop-1',
        index: 1,
        goal: 'Test validation correction',
        status: 'created',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        planner: { status: 'running', retryCount: 0 },
        builder: { status: 'pending' },
        verifier: { status: 'pending' }
      }
    ]
  };
  
  const flowsDir = path.join(tempRoot, '.solopreneur', 'flows');
  fs.mkdirSync(flowsDir, { recursive: true });
  fs.writeFileSync(path.join(flowsDir, 'test-flow-789.json'), JSON.stringify(trace), 'utf8');

  const logDir = path.join(tempRoot, '.solopreneur', 'flows', 'test-flow-789', 'loop-1', 'planner', '789');
  fs.mkdirSync(logDir, { recursive: true });
  
  const invalidPlannerJson = {
    goal: '',
    scope: [],
    successCriteria: []
  };
  
  fs.writeFileSync(
    path.join(logDir, 'output.log'),
    `SOLOMAP_FLOW_JSON_START\n${JSON.stringify(invalidPlannerJson)}\nSOLOMAP_FLOW_JSON_END`,
    'utf8'
  );

  const statusData = {
    nodeId: '__flow__::test-flow-789::loop-1::planner',
    status: 'In Progress',
    executionLogId: 789,
    outputFilePath: path.join(logDir, 'output.log'),
    changesFilePath: '',
    touchedFilesPath: '',
    commandFilePath: ''
  };

  await extensionModule.__processFlowStatusFile(null, statusData);

  const updatedTrace = extensionModule.__readFlowTrace(tempRoot, 'test-flow-789');
  assert.equal(updatedTrace.loops[0].planner.retryCount, 1);
  assert.equal(startRoleRunCalled, true);
  assert.equal(startRoleRunPayload.role, 'planner');
  assert.match(startRoleRunPayload.prompt, /自检修正/);
});
