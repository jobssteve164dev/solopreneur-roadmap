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
  readCachedConversationSnapshot,
  readSidebarCoreProjections,
  writeCachedConversationSnapshot
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

test('sidebar core data reads the durable projection without synchronously rebuilding it', async () => {
  const transport = require('../out/autonomousRuntimeControl.js');
  const previous = transport.sendRuntimeDataRequest;
  const projectPath = '/fixture/project';
  let observed;
  transport.sendRuntimeDataRequest = async (_root, request) => {
    observed = request;
    return [{ summary: { name: 'Project', path: projectPath, recommendedNodeTitle: 'Ship' } }];
  };
  try {
    const projected = await readSidebarCoreProjections('/fixture/global');
    assert.equal(projected.length, 1);
    assert.equal(projected[0].path, projectPath);
    assert.equal(projected[0].recommendedNodeTitle, 'Ship');
    assert.equal(observed.operation, 'read_sidebar_core_projections');
    assert.deepEqual(observed.input, {});
  } finally {
    transport.sendRuntimeDataRequest = previous;
  }
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

test('retired view-level sidebar snapshot APIs are not exported', () => {
  const cache = require('../out/sidebarSnapshotCache.js');
  for (const name of [
    'buildSidebarProjectSignature',
    'readSidebarCoreSnapshot',
    'reserveSidebarPortfolioSnapshot',
    'commitSidebarPortfolioSnapshot',
    'writeSidebarPortfolioSnapshot'
  ]) assert.equal(cache[name], undefined, `${name} must not remain as a parallel production path`);
});
