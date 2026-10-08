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

test('the temporary data cleanup card speaks in user actions and keeps advanced detail secondary', () => {
  const html = getMigrationSettingsCardHtml();
  assert.match(html, /旧数据整理/);
  assert.match(html, /一次性整理/);
  assert.match(html, /<button(?=[^>]*data-migration-delegate)(?=[^>]*save-btn)/);
  assert.match(html, /data-migration-metrics/);
  assert.match(html, /data-migration-details[^>]*hidden/);
  assert.match(html, /data-migration-history-section[^>]*hidden/);
  assert.doesNotMatch(html, />数据迁移与回收</);
  assert.match(html, />交给 Agent 迁移</);
  assert.doesNotMatch(html, />查看可回收文件/);
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
  assert.equal(element('[data-migration-status]').textContent, '正在安全导入旧数据，你可以照常使用。');
  assert.equal(element('[data-migration-saved]').textContent, '1');
  assert.equal(element('[data-migration-imported]').textContent, '1');
  assert.equal(element('[data-migration-cleanable]').textContent, '1');
  assert.equal(element('[data-migration-cleanable-label]').textContent, '待检查');
  assert.equal(element('[data-migration-agent]').textContent, '检查旧数据');
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
  const cancel = { disabled: false, hasAttribute: name => name === 'data-migration-cancel', closest() { return this; } };
  listeners.get('click')({ target: cancel });
  const refresh = { disabled: false, hasAttribute: name => name === 'data-migration-refresh', closest() { return this; } };
  listeners.get('click')({ target: refresh });
  const refreshed = messages.at(-1);
  deliver({ requestId: refreshed.requestId, overview: {
    jobs: [], capturedFiles: 1, migratedFiles: 1, reviewableFiles: 0,
    maintenanceTasks: [
      { taskId: 'cleanup', kind: 'recycling_apply', targetId: 'recycle-plan', status: 'ready', validUntil: Date.now() + 60_000, updatedAt: 3 },
      { taskId: 'review-ok', kind: 'migration_review', targetId: null, status: 'completed', updatedAt: 2 },
      { taskId: 'review-old', kind: 'migration_review', targetId: null, status: 'failed', updatedAt: 1 }
    ],
    recycling: [{ itemId: 'recycle-item', planId: 'recycle-plan', path: '/isolated/recycle.json', status: 'approved' }]
  } });
  assert.equal(element('[data-migration-status]').textContent, '有清理操作等待继续。');
  assert.equal(element('[data-migration-agent]').textContent, '检查旧数据', 'an old failure cannot override a newer successful review');
  const continueCleanup = { disabled: false, hasAttribute: name => name === 'data-migration-retry-recycling', getAttribute: name => name === 'data-migration-retry-recycling' ? 'recycle-plan' : null, closest() { return this; } };
  listeners.get('click')({ target: continueCleanup });
  assert.equal(messages.at(-1).command, 'dataMigration.retryRecycling');
  assert.equal(messages.at(-1).planId, 'recycle-plan', 'paused cleanup continues its exact confirmed plan');
  const cleanupRequest = messages.at(-1);
  deliver({ requestId: cleanupRequest.requestId, overview: {
    jobs: [], capturedFiles: 1, migratedFiles: 1, reviewableFiles: 0,
    maintenanceTasks: [{ taskId: 'cleanup', kind: 'recycling_apply', targetId: 'recycle-plan', status: 'running', validUntil: Date.now() + 60_000, updatedAt: 4 }],
    activeMaintenanceTaskIds: ['cleanup'],
    recycling: [{ itemId: 'recycle-item', planId: 'recycle-plan', path: '/isolated/recycle.json', status: 'moving' }]
  } });
  assert.equal(element('[data-migration-status]').textContent, '正在后台清理旧文件，你可以照常使用。');
  assert.match(element('[data-migration-history]').innerHTML, /data-action-disabled disabled/, 'a running cleanup is shown as active instead of ready to continue');
  panel.style.display = 'none'; observe();
  assert.equal(timers.size, 0);
});
