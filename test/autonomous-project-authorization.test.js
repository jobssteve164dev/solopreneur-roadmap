const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  ProjectAutonomyAuthorizationStore,
  revokeAllProjectAutonomyAuthorizations
} = require('../out/projectAutonomyAuthorization.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-auth-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  return { root, project };
}

test('project authorization is persisted and advances its epoch only when the grant changes', () => {
  const { root, project } = fixture();
  const store = new ProjectAutonomyAuthorizationStore({ globalDataPath: root });

  const granted = store.setEnabled(project, true, [project]);
  assert.equal(granted.enabled, true);
  assert.equal(granted.toolNetworkDisabled, false);
  assert.equal(granted.epoch, 1);

  const restarted = new ProjectAutonomyAuthorizationStore({ globalDataPath: root });
  assert.deepEqual(restarted.get(project), granted);

  const unchanged = restarted.setEnabled(project, true, [project]);
  assert.deepEqual(unchanged, granted);

  const revoked = restarted.setEnabled(project, false, [project]);
  assert.equal(revoked.enabled, false);
  assert.equal(revoked.epoch, 2);
  assert.equal(restarted.isCurrent(project, granted.epoch), false);
  assert.equal(restarted.isCurrent(project, revoked.epoch), false);
});

test('project tool network policy is persisted and invalidates the previous authorization epoch', () => {
  const { root, project } = fixture();
  const store = new ProjectAutonomyAuthorizationStore({ globalDataPath: root });
  const granted = store.setPolicy(project, { enabled: true, toolNetworkDisabled: false }, [project]);

  const offline = store.setPolicy(project, { enabled: true, toolNetworkDisabled: true }, [project]);
  assert.equal(offline.enabled, true);
  assert.equal(offline.toolNetworkDisabled, true);
  assert.equal(offline.epoch, granted.epoch + 1);
  assert.equal(store.isCurrent(project, granted.epoch), false);

  const unchanged = store.setPolicy(project, { enabled: true, toolNetworkDisabled: true }, [project]);
  assert.deepEqual(unchanged, offline);
  assert.deepEqual(new ProjectAutonomyAuthorizationStore({ globalDataPath: root }).get(project), offline);
});

test('changing autonomy preserves the project tool network policy', () => {
  const { root, project } = fixture();
  const store = new ProjectAutonomyAuthorizationStore({ globalDataPath: root });
  store.setPolicy(project, { enabled: true, toolNetworkDisabled: true }, [project]);

  const revoked = store.setEnabled(project, false, [project]);
  assert.equal(revoked.enabled, false);
  assert.equal(revoked.toolNetworkDisabled, true);
});

test('project authorization rejects paths that are not registered', () => {
  const { root, project } = fixture();
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  const store = new ProjectAutonomyAuthorizationStore({ globalDataPath: root });

  assert.throws(
    () => store.setEnabled(other, true, [project]),
    /not registered/i
  );
  assert.equal(store.get(other).enabled, false);
});

test('project grants use independent atomic records so another project cannot restore a revoked epoch', () => {
  const { root, project } = fixture();
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  const store = new ProjectAutonomyAuthorizationStore({ globalDataPath: root });
  store.setEnabled(project, true, [project, other]);
  store.setEnabled(other, true, [project, other]);
  const revoked = store.setEnabled(project, false, [project, other]);
  store.setEnabled(other, false, [project, other]);

  assert.equal(fs.statSync(store.filePath).isDirectory(), true);
  assert.equal(fs.readdirSync(store.filePath).filter(name => name.endsWith('.json')).length, 2);
  assert.equal(store.get(project).enabled, false);
  assert.equal(store.get(project).epoch, revoked.epoch);
});

test('global revocation preserves records and advances beyond legacy authorization epochs', () => {
  const { root, project } = fixture();
  const store = new ProjectAutonomyAuthorizationStore({ globalDataPath: root });
  const granted = store.setEnabled(project, true, [project]);
  const record = JSON.parse(fs.readFileSync(path.join(store.filePath, `${granted.projectId}.json`), 'utf8'));
  fs.writeFileSync(`${store.filePath}.json`, JSON.stringify({
    schemaVersion: 1,
    projects: {
      [granted.projectId]: { ...record, enabled: true, epoch: granted.epoch + 4 }
    }
  }), 'utf8');

  revokeAllProjectAutonomyAuthorizations(root);

  const revoked = store.get(project);
  assert.equal(revoked.enabled, false);
  assert.equal(revoked.epoch, granted.epoch + 5);
  assert.equal(fs.existsSync(path.join(store.filePath, `${granted.projectId}.json`)), true);
  assert.equal(fs.existsSync(`${store.filePath}.json`), true);
});
