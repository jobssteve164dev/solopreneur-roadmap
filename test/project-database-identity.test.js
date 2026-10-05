const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');

test('project registration creates only its stable identity file and preserves it after a move', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-identities-'));
  const global = path.join(root, '.solomap-global');
  const project = path.join(root, 'first');
  fs.mkdirSync(project);
  const store = new UnifiedDataStore(global);
  const call = createRuntimeDataOperations(store);
  try {
    const first = await call({ operation: 'register_project', input: { root: project, name: 'First' } }).catch(error => ({ error: error.message }));
    assert.ok(first.projectId, first.error);
    const identity = JSON.parse(fs.readFileSync(path.join(project, '.solopreneur/project.json'), 'utf8'));
    assert.deepEqual(identity, { schemaVersion: 1, projectId: first.projectId });
    assert.deepEqual(fs.readdirSync(path.join(project, '.solopreneur')), ['project.json']);
    const retry = await call({ operation: 'register_project', input: { root: project, name: 'First' } });
    assert.equal(retry.projectId, first.projectId);
    const moved = path.join(root, 'moved');
    fs.renameSync(project, moved);
    const after = await call({ operation: 'register_project', input: { root: moved, name: 'First' } });
    assert.equal(after.projectId, first.projectId);
    assert.notEqual(after.locationId, first.locationId);
    assert.equal(store.search({ scope: null, kinds: ['project'] }).items.length, 1);
  } finally { store.close(); }
});

test('an invalid existing identity is refused without overwriting the user file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-identity-conflict-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.solopreneur'), { recursive: true });
  const file = path.join(project, '.solopreneur/project.json');
  const original = '{"schemaVersion":99,"projectId":"unknown"}';
  fs.writeFileSync(file, original);
  const store = new UnifiedDataStore(path.join(root, '.solomap-global'));
  const call = createRuntimeDataOperations(store);
  try {
    await assert.rejects(call({ operation: 'register_project', input: { root: project } }), /project_identity/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(store.search({ scope: null, kinds: ['project'] }).items, []);
  } finally { store.close(); }
});

test('a run cannot refer to another project location', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-location-scope-'));
  fs.mkdirSync(path.join(root, 'one')); fs.mkdirSync(path.join(root, 'two'));
  const store = new UnifiedDataStore(path.join(root, '.solomap-global'));
  try {
    const first = await store.registerProject({ root: path.join(root, 'one') });
    const second = await store.registerProject({ root: path.join(root, 'two') });
    const conversation = store.write({ kind: 'conversation', action: 'create', scope: first.projectId, idempotencyKey: 'conversation', data: { mode: 'solo', status: 'active', title: 'conversation' } });
    const task = store.write({ kind: 'task', action: 'create', scope: first.projectId, idempotencyKey: 'task', data: { conversation_id: conversation.objectId, original_request_content: 'request', status: 'active' } });
    assert.throws(() => store.write({ kind: 'run', action: 'create', scope: first.projectId, idempotencyKey: 'run', data: { task_id: task.objectId, conversation_id: conversation.objectId, location_id: second.locationId, run_kind: 'solo', actor_id: 'local-runtime', status: 'active', started_at: Date.now() } }), /FOREIGN KEY|scope_mismatch/);
    assert.equal(store.search({ scope: first.projectId, kinds: ['run'] }).items.length, 0);
  } finally { store.close(); }
});
