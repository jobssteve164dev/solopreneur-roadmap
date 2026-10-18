const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function createUri(value) {
  return { fsPath: value, toString: () => `file://${value}` };
}

function createWebviewStub() {
  return { cspSource: 'vscode-webview:', asWebviewUri: uri => uri };
}

function loadOverviewModule() {
  try {
    return require(path.join(projectRoot, 'out/databaseOverviewSettings.js'));
  } catch {
    return null;
  }
}

test('only sidebar settings show the database overview and neither surface shows migration cleanup controls', () => {
  const { getSidebarWebviewHtml } = require(path.join(projectRoot, 'out/sidebarWebview.js'));
  const { getWebviewHtml } = require(path.join(projectRoot, 'out/roadmapWebview.js'));
  const sidebar = getSidebarWebviewHtml(createWebviewStub(), createUri(projectRoot));
  const roadmap = getWebviewHtml(createWebviewStub(), { extensionUri: createUri(projectRoot) });
  assert.equal((sidebar.match(/data-database-overview-card/g) || []).length, 1);
  assert.equal((roadmap.match(/data-database-overview-card/g) || []).length, 0);
  for (const html of [sidebar, roadmap]) {
    assert.doesNotMatch(html, /data-migration-settings-card/);
    assert.doesNotMatch(html, /清理旧数据|Cleanup old data|dataMigration\./);
  }
});

test('database overview keeps stable placeholders and exposes only a read-only refresh action', () => {
  const overview = loadOverviewModule();
  assert.ok(overview, 'database overview settings module must exist');
  const html = overview.getDatabaseOverviewCardHtml();
  assert.match(html, /data-database-overview-card/);
  assert.match(html, /数据库占用/);
  assert.match(html, /内容条目/);
  assert.match(html, /可复用空间/);
  assert.match(html, /data-database-overview-refresh/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /迁移|回收|清理|WAL|SQLite|dataMigration\./);
  const values = overview.formatDatabaseOverview({
    databaseBytes: 12 * 1024 * 1024 * 1024,
    freePageBytes: 256 * 1024 * 1024,
    contents: { records: 59174 },
    lastMaintenance: { finishedAt: Date.UTC(2026, 9, 15, 4), status: 'completed' }
  }, 'zh');
  assert.deepEqual(values, {
    databaseSize: '12 GB',
    contentCount: '59,174',
    reusableSpace: '256 MB',
    status: '运行正常 · 最近维护 2026/10/15'
  });
  assert.equal(overview.formatDatabaseOverview({
    databaseBytes: 1,
    freePageBytes: 0,
    contents: { records: 1 },
    lastMaintenance: { finishedAt: null, status: 'running' }
  }, 'zh').status, '维护中 · 当前数据可正常使用');
  assert.equal(overview.formatDatabaseOverview({
    databaseBytes: 1,
    freePageBytes: 0,
    contents: { records: 1 },
    lastMaintenance: { finishedAt: Date.UTC(2026, 9, 15, 4), status: 'failed' }
  }, 'en').status, 'Available · Last maintenance incomplete');
  assert.match(overview.getDatabaseOverviewScript(), /databaseOverview\.get/);
  assert.doesNotMatch(overview.getDatabaseOverviewScript(), /read_database_storage|maintain_database_storage|dataMigration\./);
});

test('database overview action reads storage without exposing maintenance operations', async () => {
  const overview = loadOverviewModule();
  assert.ok(overview, 'database overview settings module must exist');
  const calls = [];
  const result = await overview.readDatabaseOverview('/data/.solomap-global', {
    ensureReady: async root => { calls.push(['ready', root]); },
    readStorage: async root => {
      calls.push(['read', root]);
      return {
        databaseBytes: 12 * 1024 * 1024 * 1024,
        freePageBytes: 256 * 1024 * 1024,
        contents: { records: 59174 },
        lastMaintenance: { finishedAt: '2026-10-15T04:00:00.000Z', status: 'completed' }
      };
    }
  });
  assert.deepEqual(calls, [
    ['ready', '/data/.solomap-global'],
    ['read', '/data/.solomap-global']
  ]);
  assert.equal(result.contents.records, 59174);
});

test('database overview reconnects after discovery changes between readiness and the read', async () => {
  const overview = loadOverviewModule();
  let ready = 0, reads = 0;
  const result = await overview.readDatabaseOverview('/isolated/.solomap-global', {
    ensureReady: async () => { ready++; },
    readStorage: async () => {
      if (++reads === 1) throw new Error('Invalid Runtime endpoint.');
      return { databaseBytes: 4096, freePageBytes: 0, contents: { records: 3 }, lastMaintenance: null };
    }
  });
  assert.equal(result.contents.records, 3);
  assert.equal(ready, 2);
  assert.equal(reads, 2);
});

test('database overview preserves real query errors instead of masking them as a reconnect', async () => {
  let reads = 0;
  await assert.rejects(loadOverviewModule().readDatabaseOverview('/isolated/.solomap-global', {
    ensureReady: async () => {},
    readStorage: async () => { reads++; throw new Error('no such table: contents'); }
  }), /no such table: contents/);
  assert.equal(reads, 1);
});

test('database overview reloads every time settings opens', () => {
  const overview = loadOverviewModule();
  const elements = new Map();
  const listeners = new Map();
  const messages = [];
  let observe;
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      disabled: false,
      textContent: '',
      classList: { toggle() {} },
      addEventListener: (name, listener) => listeners.set(selector + '-' + name, listener)
    });
    return elements.get(selector);
  };
  const panel = { style: { display: 'none' } };
  const card = {
    querySelector: element,
    setAttribute() {}
  };
  vm.runInNewContext(overview.getDatabaseOverviewScript(), {
    currentLanguage: 'zh',
    vscode: { postMessage: message => messages.push(message) },
    document: { getElementById: id => id === 'settings-panel' ? panel : card },
    window: { addEventListener: (name, listener) => listeners.set(name, listener) },
    MutationObserver: class {
      constructor(callback) { observe = callback; }
      observe() {}
      disconnect() {}
    }
  });

  listeners.get('message')({ data: { command: 'settingsLoaded', settings: { globalDataPath: '/data' } } });
  panel.style.display = 'block';
  observe();
  const first = messages.at(-1);
  assert.equal(first.command, 'databaseOverview.get');
  listeners.get('message')({ data: {
    command: 'databaseOverviewLoaded',
    requestId: first.requestId,
    overview: { databaseBytes: 10, freePageBytes: 0, contents: { records: 1 }, lastMaintenance: null }
  } });

  panel.style.display = 'none';
  observe();
  panel.style.display = 'block';
  observe();
  assert.equal(messages.filter(message => message.command === 'databaseOverview.get').length, 2);
});
