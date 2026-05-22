const assert = require('node:assert/strict');
const fs = require('node:fs');
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
    async () => {}
  );
  const html = provider._getHtmlForWebview({});
  const script = extractLastScript(html);

  assert.doesNotThrow(() => new vm.Script(script));

  const { elements, postedMessages } = runScriptWithMinimalDom(script, [
    'tasks-list',
    'progress-bar',
    'progress-text',
    'btn-generate-sidebar',
    'ai-prompt-sidebar',
    'btn-open-full',
    'btn-toggle-settings',
    'btn-close-settings',
    'settings-panel',
    'setting-provider',
    'setting-key',
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
    'btn-generate',
    'ai-prompt',
    'btn-toggle-settings',
    'btn-close-settings',
    'settings-panel',
    'setting-provider',
    'setting-key',
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

test('agent command builder uses Codex exec and preserves Antigravity run path', () => {
  const extensionModule = loadCompiledModule(
    'out/extension.js',
    [
      'module.exports.__buildAgentCommand = buildAgentCommand;',
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
    "'antigravity-cli' run --task 'Build landing page'"
  );
});
