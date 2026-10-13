const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  ProjectAutonomyAuthorizationStore,
  revokeAllProjectAutonomyAuthorizations
} = require('../out/projectAutonomyAuthorization.js');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { enqueueAvailableDataMigrations } = require('../out/runtimeDatabaseBootstrap.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-auth-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const dataStore = new UnifiedDataStore(root);
  t.after(() => {
    dataStore.close();
    for (const name of ['solomap.db-shm', 'solomap.db-wal', 'solomap.db']) { const file = path.join(root, name); if (fs.existsSync(file)) fs.unlinkSync(file); }
    for (const name of ['other', 'project']) { const directory = path.join(root, name); if (fs.existsSync(directory)) fs.rmdirSync(directory); }
    const legacyRoot = path.join(root, 'runtime', 'project-autonomy-authorizations');
    if (fs.existsSync(`${legacyRoot}.json`)) fs.unlinkSync(`${legacyRoot}.json`);
    if (fs.existsSync(legacyRoot)) { for (const name of fs.readdirSync(legacyRoot)) fs.unlinkSync(path.join(legacyRoot, name)); fs.rmdirSync(legacyRoot); }
    if (fs.existsSync(path.join(root, 'runtime'))) fs.rmdirSync(path.join(root, 'runtime'));
    fs.rmdirSync(root);
  });
  return { root, project, dataStore };
}

test('project authorization is persisted and advances its epoch only when the grant changes', t => {
  const { root, project, dataStore } = fixture(t);
  const store = new ProjectAutonomyAuthorizationStore({ globalDataPath: root, dataStore });

  const granted = store.setEnabled(project, true, [project]);
  assert.equal(granted.enabled, true);
  assert.equal(granted.toolNetworkDisabled, false);
  assert.equal(granted.epoch, 1);

  const restarted = new ProjectAutonomyAuthorizationStore({ globalDataPath: root, dataStore });
  assert.deepEqual(restarted.get(project), granted);

  const unchanged = restarted.setEnabled(project, true, [project]);
  assert.deepEqual(unchanged, granted);

  const revoked = restarted.setEnabled(project, false, [project]);
  assert.equal(revoked.enabled, false);
  assert.equal(revoked.epoch, 2);
  assert.equal(restarted.isCurrent(project, granted.epoch), false);
  assert.equal(restarted.isCurrent(project, revoked.epoch), false);
});

test('project tool network policy is persisted and invalidates the previous authorization epoch', t => {
  const { root, project, dataStore } = fixture(t);
  const store = new ProjectAutonomyAuthorizationStore({ globalDataPath: root, dataStore });
  const granted = store.setPolicy(project, { enabled: true, toolNetworkDisabled: false }, [project]);

  const offline = store.setPolicy(project, { enabled: true, toolNetworkDisabled: true }, [project]);
  assert.equal(offline.enabled, true);
  assert.equal(offline.toolNetworkDisabled, true);
  assert.equal(offline.epoch, granted.epoch + 1);
  assert.equal(store.isCurrent(project, granted.epoch), false);

  const unchanged = store.setPolicy(project, { enabled: true, toolNetworkDisabled: true }, [project]);
  assert.deepEqual(unchanged, offline);
  assert.deepEqual(new ProjectAutonomyAuthorizationStore({ globalDataPath: root, dataStore }).get(project), offline);
});

test('changing autonomy preserves the project tool network policy', t => {
  const { root, project, dataStore } = fixture(t);
  const store = new ProjectAutonomyAuthorizationStore({ globalDataPath: root, dataStore });
  store.setPolicy(project, { enabled: true, toolNetworkDisabled: true }, [project]);

  const revoked = store.setEnabled(project, false, [project]);
  assert.equal(revoked.enabled, false);
  assert.equal(revoked.toolNetworkDisabled, true);
});

test('project authorization rejects paths that are not registered', t => {
  const { root, project, dataStore } = fixture(t);
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  const store = new ProjectAutonomyAuthorizationStore({ globalDataPath: root, dataStore });

  assert.throws(
    () => store.setEnabled(other, true, [project]),
    /not registered/i
  );
  assert.equal(store.get(other).enabled, false);
});

test('project grants use independent database records so another project cannot restore a revoked epoch', t => {
  const { root, project, dataStore } = fixture(t);
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  const store = new ProjectAutonomyAuthorizationStore({ globalDataPath: root, dataStore });
  store.setEnabled(project, true, [project, other]);
  store.setEnabled(other, true, [project, other]);
  const revoked = store.setEnabled(project, false, [project, other]);
  store.setEnabled(other, false, [project, other]);

  assert.equal(dataStore.readHostSettings({ namespace: 'project_autonomy', ownerScope: 'global' }).items.length, 2);
  assert.equal(store.get(project).enabled, false);
  assert.equal(store.get(project).epoch, revoked.epoch);
});

test('global revocation preserves database records and advances the current epoch', t => {
  const { root, project, dataStore } = fixture(t);
  const store = new ProjectAutonomyAuthorizationStore({ globalDataPath: root, dataStore });
  const granted = store.setEnabled(project, true, [project]);

  revokeAllProjectAutonomyAuthorizations(dataStore, 'revoke-test');

  const revoked = store.get(project);
  assert.equal(revoked.enabled, false);
  assert.equal(revoked.epoch, granted.epoch + 1);
  assert.equal(dataStore.readHostSettings({ namespace: 'project_autonomy', ownerScope: 'global' }).items.length, 1);
});

test('ordinary authorization reads ignore legacy files after the database becomes authoritative', t => {
  const { root, project, dataStore } = fixture(t);
  const projectId = require('crypto').createHash('sha256').update(fs.realpathSync(project)).digest('hex');
  const legacyRoot = path.join(root, 'runtime', 'project-autonomy-authorizations');
  fs.mkdirSync(legacyRoot, { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, `${projectId}.json`), JSON.stringify({
    projectId, projectPath: fs.realpathSync(project), enabled: true, toolNetworkDisabled: false, epoch: 7, updatedAt: '2026-10-12T00:00:00.000Z'
  }));

  const authorization = new ProjectAutonomyAuthorizationStore({ globalDataPath: root, dataStore }).get(project);

  assert.equal(authorization.enabled, false);
  assert.equal(authorization.epoch, 0);
  assert.equal(dataStore.readHostSettings({ namespace: 'project_autonomy', ownerScope: 'global' }).items.length, 0);
});

test('startup migration imports legacy authorization once without making it a live source', async t => {
  const { root, project, dataStore } = fixture(t);
  const projectId = require('crypto').createHash('sha256').update(fs.realpathSync(project)).digest('hex');
  const legacyFile = path.join(root, 'runtime', 'project-autonomy-authorizations.json');
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, JSON.stringify({ schemaVersion: 1, projects: {
    [projectId]: { projectId, projectPath: fs.realpathSync(project), enabled: true, toolNetworkDisabled: true, epoch: 4, updatedAt: '2026-10-12T00:00:00.000Z' }
  } }));
  const operations = createRuntimeDataOperations(dataStore);
  t.after(async () => operations.close());

  await enqueueAvailableDataMigrations(dataStore, operations, () => true);
  await operations.waitForMigrations();
  const authorization = new ProjectAutonomyAuthorizationStore({ globalDataPath: root, dataStore });
  assert.deepEqual(authorization.get(project), {
    projectId, projectPath: fs.realpathSync(project), enabled: true, toolNetworkDisabled: true, epoch: 4, updatedAt: '2026-10-12T00:00:00.000Z'
  });

  fs.writeFileSync(legacyFile, JSON.stringify({ schemaVersion: 1, projects: {
    [projectId]: { projectId, projectPath: fs.realpathSync(project), enabled: false, toolNetworkDisabled: false, epoch: 9, updatedAt: '2026-10-12T01:00:00.000Z' }
  } }));
  assert.equal(authorization.get(project).enabled, true);
  assert.equal(authorization.get(project).epoch, 4);
});
