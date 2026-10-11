const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const registry = require('../out/projectRegistry.js');
const { openAnalysisOwner } = require('./analysis-fixture.js');

async function hydrate(t, parent, bootstrap) {
  const root = path.join(parent, '.solomap-global');
  await openAnalysisOwner(t, root, []);
  await registry.refreshProjectRegistry(root, () => bootstrap || {});
}

test('read-only project enumeration never creates the registry', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-registry-readonly-'));
  const workspace = path.join(parent, 'workspace');
  const legacy = path.join(parent, 'legacy');
  fs.mkdirSync(workspace);
  fs.mkdirSync(legacy);
  await hydrate(t, parent, { legacyProjects: [{ name: 'Legacy', path: legacy }], workspaceRoot: workspace });
  const projects = registry.getProjectsReadOnly({
    globalDataPath: parent,
    projectRegistryFileName: 'projects.json',
    legacyProjects: [{ name: 'Legacy', path: legacy }],
    legacyHiddenProjects: [],
    workspaceRoot: workspace
  });
  assert.deepEqual(projects.map(project => project.path), [workspace, legacy]);
  assert.equal(fs.existsSync(path.join(parent, '.solomap-global', 'projects.json')), false);
});

test('conversation project snapshot preserves an offline selected project without writing the registry', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-conversation-projects-'));
  await hydrate(t, parent, { legacyProjects: [{ name: 'Offline', path: path.join(parent, 'offline') }, { name: 'Online', path: parent }], legacySelectedProjectPath: path.join(parent, 'offline') });
  const projects = registry.getProjectsSnapshot({
    globalDataPath: parent,
    projectRegistryFileName: 'projects.json',
    legacyProjects: [{ name: 'Offline', path: path.join(parent, 'offline') }, { name: 'Online', path: parent }],
    legacyHiddenProjects: [],
    workspaceRoot: parent
  });
  assert.equal(registry.getSelectedProjectPath(projects, path.join(parent, 'offline')), path.join(parent, 'offline'));
  assert.equal(fs.existsSync(path.join(parent, '.solomap-global', 'projects.json')), false);
});

test('read-only project enumeration excludes paths recorded as hidden', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-registry-hidden-'));
  const visible = path.join(parent, 'visible');
  const hidden = path.join(parent, 'hidden');
  const globalRoot = path.join(parent, '.solomap-global');
  fs.mkdirSync(visible);
  fs.mkdirSync(hidden);
  fs.mkdirSync(globalRoot);
  fs.writeFileSync(path.join(globalRoot, 'projects.json'), JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-09-18T00:00:00.000Z',
    projects: [{ name: 'Visible', path: visible }, { name: 'Hidden', path: hidden }],
    hiddenProjects: [hidden]
  }));
  await hydrate(t, parent);
  const projects = registry.getProjectsReadOnly({
    globalDataPath: parent,
    projectRegistryFileName: 'projects.json',
    legacyProjects: [],
    legacyHiddenProjects: [],
    workspaceRoot: visible
  });
  assert.deepEqual(projects.map(project => project.path), [visible]);
});

test('read-only project enumeration matches the Agent rule for stale and non-absolute registry paths', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-registry-stale-'));
  const visible = path.join(parent, 'visible');
  const stale = path.join(parent, 'deleted');
  const globalRoot = path.join(parent, '.solomap-global');
  fs.mkdirSync(visible);
  fs.mkdirSync(globalRoot);
  fs.writeFileSync(path.join(globalRoot, 'projects.json'), JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-09-18T00:00:00.000Z',
    projects: [{ name: 'Visible', path: visible }, { name: 'Deleted', path: stale }, { name: 'Relative', path: 'relative/project' }],
    hiddenProjects: []
  }));
  await hydrate(t, parent);
  const projects = registry.getProjectsReadOnly({
    globalDataPath: parent,
    projectRegistryFileName: 'projects.json',
    legacyProjects: [],
    legacyHiddenProjects: [],
    workspaceRoot: visible
  });
  assert.deepEqual(projects.map(project => project.path), [visible]);
});
