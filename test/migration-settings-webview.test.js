const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { getSidebarWebviewHtml } = require('../out/sidebarWebview.js');
const { getWebviewHtml } = require('../out/roadmapWebview.js');
const { getMigrationSettingsCardHtml, getMigrationSettingsScript } = require('../out/migrationSettingsWebview.js');

test('both generated settings surfaces include the same accessible migration and recycling card with valid final scripts', () => {
  const uri = { path: '/isolated/extension', fsPath: '/isolated/extension', toString: () => '/isolated/extension' };
  const webview = { asWebviewUri: value => value.toString(), cspSource: 'fixture' };
  for (const html of [getSidebarWebviewHtml(webview, uri), getWebviewHtml(webview, { extensionUri: uri, extensionPath: uri.fsPath })]) {
    assert.equal((html.match(/id="migration-settings-card"/g) || []).length, 1);
    assert.match(html, /data-migration-preview/);
    assert.match(html, /data-migration-confirm/);
    assert.match(html, /data-migration-status[^>]*role="status"/);
    assert.ok(html.indexOf('id="migration-settings-card"') > html.lastIndexOf('<div class="settings-card"'), 'the temporary migration card must be the final settings card');
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  }
  assert.match(getMigrationSettingsCardHtml(), /overflow-wrap:\s*anywhere/);
  new vm.Script(getMigrationSettingsScript());
});

test('reviewing an exact file list pauses polling and stale responses cannot hide the confirmation', () => {
  const elements = new Map();
  const listeners = new Map();
  const timers = new Map();
  const messages = [];
  let observe;
  let timerId = 0;
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { hidden: false, disabled: false, style: {}, attributes: {}, textContent: '', innerHTML: '', setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; } });
    return elements.get(selector);
  };
  const panel = { style: { display: 'block' } };
  const card = { querySelector: element, querySelectorAll: () => [], setAttribute() {}, addEventListener: (name, listener) => listeners.set(name, listener) };
  const context = { currentLanguage: 'zh', vscode: { postMessage: value => messages.push(value) }, document: { getElementById: id => id === 'settings-panel' ? panel : card }, window: { addEventListener: (name, listener) => listeners.set('window-' + name, listener) }, MutationObserver: class { constructor(callback) { observe = callback; } observe() {} disconnect() {} }, setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id) };
  vm.runInNewContext(getMigrationSettingsScript(), context);
  assert.equal(card.hidden, true, 'the temporary card stays hidden when there is no work');
  observe();
  const first = messages.at(-1);
  const deliver = data => listeners.get('window-message')({ data: { command: 'dataMigrationLoaded', ...data } });
  deliver({ requestId: first.requestId, dataRoot: '/isolated', overview: { jobs: [{ jobId: 'job', status: 'running', args: {}, progress: {} }], capturedFiles: 1, migratedFiles: 1, recyclableFiles: 1, recyclableBytes: 42, recycling: [] } });
  assert.equal(card.hidden, false);
  assert.equal(timers.size, 1);
  const target = { disabled: false, hasAttribute: name => name === 'data-migration-preview', closest() { return this; } };
  listeners.get('click')({ target });
  const preview = messages.at(-1);
  deliver({ requestId: preview.requestId, plan: { planId: 'plan', files: [{ itemId: 'one', path: '/isolated/old.json' }] } });
  assert.equal(element('[data-migration-plan]').hidden, false);
  assert.equal(timers.size, 0, 'automatic refresh must not interrupt a file-list review');
  deliver({ requestId: first.requestId, overview: {} });
  assert.equal(element('[data-migration-plan]').hidden, false);
  assert.match(element('[data-migration-files]').innerHTML, /old\.json/);
  panel.style.display = 'none'; observe();
  assert.equal(timers.size, 0);
});
