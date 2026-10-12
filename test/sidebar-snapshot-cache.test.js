const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');
const {
  buildConversationDatabaseSignature,
  buildSidebarProjectSignature,
  readCachedConversationSnapshot,
  readSidebarCoreSnapshot,
  reserveSidebarPortfolioSnapshot,
  commitSidebarPortfolioSnapshot,
  writeCachedConversationSnapshot,
  writeSidebarPortfolioSnapshot
} = require('../out/sidebarSnapshotCache.js');

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-sidebar-cache-db-'));
  const projectPath = path.join(root, 'project');
  const solopreneurPath = path.join(projectPath, '.solopreneur');
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(solopreneurPath, { recursive: true });
  fs.writeFileSync(path.join(solopreneurPath, 'roadmap.csv'), 'id,title,status\n1,Ship,Pending\n');
  const store = new UnifiedDataStore(globalRoot);
  const operations = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: globalRoot, runtimeId: `sidebar-cache-${Date.now()}`, onCommand: () => ({ status: 'running' }), onData: operations });
  const project = await store.registerProject({ root: projectPath });
  return { root, projectPath, solopreneurPath, globalRoot, store, operations, server, project };
}

async function cleanupFixture(fixture) {
  await fixture.server.close();
  await fixture.operations.close();
  fixture.store.close();
  for (const file of ['solomap.db-wal', 'solomap.db-shm', 'solomap.db']) {
    const target = path.join(fixture.globalRoot, file);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  const runtimeRoot = path.join(fixture.globalRoot, 'runtime');
  if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
  fs.rmdirSync(fixture.globalRoot);
  fs.unlinkSync(path.join(fixture.solopreneurPath, 'roadmap.csv'));
  const projectIdentity = path.join(fixture.solopreneurPath, 'project.json');
  if (fs.existsSync(projectIdentity)) fs.unlinkSync(projectIdentity);
  fs.rmdirSync(fixture.solopreneurPath);
  fs.rmdirSync(fixture.projectPath);
  fs.rmdirSync(fixture.root);
}

test('sidebar core snapshot is stored in the unified database and tracks the roadmap contract', async () => {
  const fixture = await createFixture();
  try {
    const projects = [{ name: 'Project', path: fixture.projectPath }];
    const signature = buildSidebarProjectSignature(projects);
    const portfolio = [{ name: 'Project', path: fixture.projectPath, nodes: [{ id: '1', title: 'Ship', status: 'Pending' }] }];
    await writeSidebarPortfolioSnapshot(fixture.globalRoot, signature, portfolio);
    const cached = await readSidebarCoreSnapshot(fixture.globalRoot);
    assert.equal(cached.version, 3);
    assert.equal(cached.projectSignature, signature);
    assert.deepEqual(cached.portfolio, portfolio);
    assert.deepEqual(fs.readdirSync(fixture.globalRoot).filter(name => name !== 'runtime' && !name.startsWith('solomap.db')), []);
    fs.appendFileSync(path.join(fixture.solopreneurPath, 'roadmap.csv'), '2,Verify,Pending\n');
    assert.notEqual(buildSidebarProjectSignature(projects), cached.projectSignature);
  } finally { await cleanupFixture(fixture); }
});

test('conversation snapshot is invalidated only by a newer unified journal revision', async () => {
  const fixture = await createFixture();
  try {
    const snapshot = {
      solo: [{ id: 1, nodeId: '__solo__', status: 'Completed' }],
      project: [{ id: 2, nodeId: 'step-1', status: 'Completed' }],
      flow: [], revision: []
    };
    const sourceRevision = await buildConversationDatabaseSignature(fixture.globalRoot, fixture.projectPath);
    await writeCachedConversationSnapshot(fixture.globalRoot, fixture.projectPath, sourceRevision, snapshot);
    assert.deepEqual(await readCachedConversationSnapshot(fixture.globalRoot, fixture.projectPath), snapshot);
    fixture.store.appendProjectJournal(fixture.project.projectId, 'later', {
      nodeId: '__solo__', timestamp: '2026-10-11T20:00:00.000Z', agentCli: 'codex', command: 'later', output: 'done', status: 'Processed'
    });
    assert.equal(await readCachedConversationSnapshot(fixture.globalRoot, fixture.projectPath), null);
    assert.equal(fs.existsSync(path.join(fixture.globalRoot, 'conversations')), false);
  } finally { await cleanupFixture(fixture); }
});

test('same-millisecond sidebar snapshot writers use independent idempotency identities', async () => {
  const fixture = await createFixture();
  const originalNow = Date.now;
  Date.now = () => 1770800000000;
  try {
    const first = [{ name: 'Project', path: fixture.projectPath, nodes: [{ id: '1', title: 'First', status: 'Pending' }] }];
    const second = [{ name: 'Project', path: fixture.projectPath, nodes: [{ id: '1', title: 'Second', status: 'Completed' }] }];
    await Promise.all([
      writeSidebarPortfolioSnapshot(fixture.globalRoot, 'first', first),
      writeSidebarPortfolioSnapshot(fixture.globalRoot, 'second', second)
    ]);
    const cached = await readSidebarCoreSnapshot(fixture.globalRoot);
    assert.ok(['first', 'second'].includes(cached.projectSignature));
  } finally {
    Date.now = originalNow;
    await cleanupFixture(fixture);
  }
});

test('sidebar core snapshot generation rejects inverse completion', async () => {
  const fixture = await createFixture();
  try {
    const older = await reserveSidebarPortfolioSnapshot(fixture.globalRoot);
    const newer = await reserveSidebarPortfolioSnapshot(fixture.globalRoot);
    const latest = [{ name: 'Project', path: fixture.projectPath, nodes: [{ id: '1', title: 'Latest', status: 'Completed' }] }];
    const stale = [{ name: 'Project', path: fixture.projectPath, nodes: [{ id: '1', title: 'Stale', status: 'Pending' }] }];
    assert.equal(await commitSidebarPortfolioSnapshot(fixture.globalRoot, newer, 'latest', latest), true);
    assert.equal(await commitSidebarPortfolioSnapshot(fixture.globalRoot, older, 'stale', stale), false);
    const cached = await readSidebarCoreSnapshot(fixture.globalRoot);
    assert.equal(cached.projectSignature, 'latest');
    assert.deepEqual(cached.portfolio, latest);
  } finally { await cleanupFixture(fixture); }
});
