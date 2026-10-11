const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');
const { openDataClient } = require('../resources/tools/solomap-data-client.cjs');

test('distributed data client writes large complete content and immediately reads its committed version', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-data-client-full-content-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const globalRoot = path.join(root, '.solomap-global'); const store = new UnifiedDataStore(globalRoot); const ops = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: globalRoot, runtimeId: 'data-client-full-content-owner', onCommand: () => ({ status: 'running' }), onData: ops });
  let client;
  try {
    const project = await ops({ operation: 'register_project', input: { root: workspace } });
    client = await openDataClient(globalRoot, workspace);
    const content = '完整原文🌿\n'.repeat(20000);
    assert.ok(content.length > 65536);
    const created = await client.call('write', { action: 'create', kind: 'memory', scope: project.projectId, idempotencyKey: 'large-distributed-client-write', data: { category: 'inbox', status: 'captured', title: '完整正文', content } });
    assert.equal(created.revision, 1);
    assert.equal(await client.content({ objectId: created.objectId, revision: created.revision }), content);
    const replay = await client.call('write', { action: 'create', kind: 'memory', scope: project.projectId, idempotencyKey: 'large-distributed-client-write', data: { category: 'inbox', status: 'captured', title: '完整正文', content } });
    assert.equal(replay.objectId, created.objectId); assert.equal(replay.revision, created.revision);
    const next = content + '后续完整修改';
    const patched = await client.call('write', { action: 'patch', kind: 'memory', scope: project.projectId, objectId: created.objectId, expectedRevision: 1, idempotencyKey: 'large-distributed-client-patch', data: { content: next } });
    assert.equal(patched.revision, 2);
    assert.equal(await client.content({ objectId: created.objectId, revision: 2 }), next);
    assert.equal(await client.content({ objectId: created.objectId, revision: 1 }), content);
  } finally { if (client) await client.close(); await server.close(); await ops.close(); store.close(); }
});
