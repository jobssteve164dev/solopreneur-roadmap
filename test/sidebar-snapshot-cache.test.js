const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildConversationDatabaseSignature,
  buildSidebarProjectSignature,
  readCachedConversationSnapshot,
  readSidebarCoreSnapshot,
  writeCachedConversationSnapshot,
  writeSidebarPortfolioSnapshot
} = require('../out/sidebarSnapshotCache.js');

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-sidebar-cache-'));
  const projectPath = path.join(root, 'project');
  const solopreneurPath = path.join(projectPath, '.solopreneur');
  const cachePath = path.join(root, 'cache');
  fs.mkdirSync(solopreneurPath, { recursive: true });
  fs.mkdirSync(cachePath, { recursive: true });
  fs.writeFileSync(path.join(solopreneurPath, 'roadmap.csv'), 'id,title,status\n1,Ship,Pending\n');
  fs.writeFileSync(path.join(solopreneurPath, 'project_journal.db'), 'journal-v1');
  return { root, projectPath, solopreneurPath, cachePath };
}

function cleanupFixture(fixture) {
  const projectKey = createHash('sha1').update(fixture.projectPath).digest('hex');
  for (const filePath of [
    path.join(fixture.cachePath, 'sidebar-core-snapshot-v1.json'),
    path.join(fixture.cachePath, 'conversations', `sidebar-conversation-${projectKey}-v1.json`),
    path.join(fixture.solopreneurPath, 'project_journal.db'),
    path.join(fixture.solopreneurPath, 'roadmap.csv')
  ]) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  const conversationCachePath = path.join(fixture.cachePath, 'conversations');
  if (fs.existsSync(conversationCachePath)) fs.rmdirSync(conversationCachePath);
  fs.rmdirSync(fixture.cachePath);
  fs.rmdirSync(fixture.solopreneurPath);
  fs.rmdirSync(fixture.projectPath);
  fs.rmdirSync(fixture.root);
}

test('sidebar core snapshot restores a complete cached portfolio until roadmap facts change', () => {
  const fixture = createFixture();
  try {
    const projects = [{ name: 'Project', path: fixture.projectPath }];
    const signature = buildSidebarProjectSignature(projects);
    const portfolio = [{ name: 'Project', path: fixture.projectPath, nodes: [{ id: '1', title: 'Ship', status: 'Pending' }] }];
    writeSidebarPortfolioSnapshot(fixture.cachePath, signature, portfolio);

    const cached = readSidebarCoreSnapshot(fixture.cachePath);
    assert.equal(cached.version, 2);
    assert.equal(cached.projectSignature, signature);
    assert.deepEqual(cached.portfolio, portfolio);

    fs.appendFileSync(path.join(fixture.solopreneurPath, 'roadmap.csv'), '2,Verify,Pending\n');
    assert.notEqual(buildSidebarProjectSignature(projects), cached.projectSignature);
  } finally {
    cleanupFixture(fixture);
  }
});

test('conversation snapshot cache is reused only while the local journal is unchanged', () => {
  const fixture = createFixture();
  try {
    const snapshot = {
      solo: [{ id: 1, nodeId: '__solo__', status: 'Completed' }],
      project: [{ id: 2, nodeId: 'step-1', status: 'Completed' }],
      flow: [{ id: 3, nodeId: '__flow__::flow-1::loop-1::builder', status: 'Completed' }]
    };
    writeCachedConversationSnapshot(fixture.cachePath, fixture.projectPath, snapshot);
    const projectKey = createHash('sha1').update(fixture.projectPath).digest('hex');
    assert.equal(
      fs.existsSync(path.join(fixture.cachePath, 'conversations', `sidebar-conversation-${projectKey}-v1.json`)),
      true
    );
    assert.equal(
      fs.existsSync(path.join(fixture.cachePath, `sidebar-conversation-${projectKey}-v1.json`)),
      false
    );
    assert.deepEqual(readCachedConversationSnapshot(fixture.cachePath, fixture.projectPath), snapshot);

    fs.appendFileSync(path.join(fixture.solopreneurPath, 'project_journal.db'), '-changed');
    assert.equal(readCachedConversationSnapshot(fixture.cachePath, fixture.projectPath), null);
  } finally {
    cleanupFixture(fixture);
  }
});

test('legacy conversation snapshots are moved out of the global root before reading', () => {
  const fixture = createFixture();
  try {
    const snapshot = {
      solo: [{ id: 1, nodeId: '__solo__', status: 'Completed' }],
      project: [],
      flow: []
    };
    const projectKey = createHash('sha1').update(fixture.projectPath).digest('hex');
    const fileName = `sidebar-conversation-${projectKey}-v1.json`;
    const legacyPath = path.join(fixture.cachePath, fileName);
    fs.writeFileSync(legacyPath, JSON.stringify({
      signature: buildConversationDatabaseSignature(fixture.projectPath),
      snapshot
    }));

    assert.deepEqual(readCachedConversationSnapshot(fixture.cachePath, fixture.projectPath), snapshot);
    assert.equal(fs.existsSync(legacyPath), false);
    assert.equal(fs.existsSync(path.join(fixture.cachePath, 'conversations', fileName)), true);
  } finally {
    cleanupFixture(fixture);
  }
});
