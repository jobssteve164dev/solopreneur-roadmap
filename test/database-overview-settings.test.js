const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

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

test('both settings surfaces show one database overview and no migration cleanup controls', () => {
  const { getSidebarWebviewHtml } = require(path.join(projectRoot, 'out/sidebarWebview.js'));
  const { getWebviewHtml } = require(path.join(projectRoot, 'out/roadmapWebview.js'));
  for (const html of [
    getSidebarWebviewHtml(createWebviewStub(), createUri(projectRoot)),
    getWebviewHtml(createWebviewStub(), { extensionUri: createUri(projectRoot) })
  ]) {
    assert.equal((html.match(/data-database-overview-card/g) || []).length, 1);
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
