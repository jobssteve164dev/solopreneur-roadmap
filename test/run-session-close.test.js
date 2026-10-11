const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { snapshotWorkspace, workspaceDocumentPurpose } = require('../out/runWorkspace.js');

for (const status of ['Waiting', 'Processed']) test(`closing an unfinished ${status} turn settles its original evidence and report without leaving a recovery orphan`, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-idle-session-close-'));
  const root = path.join(base, '.solomap-global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    fs.writeFileSync(path.join(project, 'result.txt'), 'before');
    const run = await call('prepare_run', { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '完整输入', command: 'codex', userMessage: '用户目标', status, metadata: { interactiveSession: true }, idempotencyKey: 'idle-run' });
    const identity = { projectId: run.projectId, executionLogId: 1, generation: run.generation, proof: run.proof };
    await call('write_run_document', { ...identity, turnId: run.turnId, purpose: workspaceDocumentPurpose(run.turnId, 'before'), bytes: Buffer.from(JSON.stringify(await snapshotWorkspace(project))).toString('base64'), mimeType: 'application/json', expectedRevision: 0, idempotencyKey: 'idle-baseline' });
    fs.writeFileSync(path.join(project, 'result.txt'), 'changed before close');
    const intent = { ...identity, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'session-close', exitCode: 143, idempotencyKey: 'idle-close' };
    const closed = await call('checkpoint_run', intent);
    const turn = store.read(run.turnId);
    assert.ok(turn.data.finished_at); assert.equal(turn.data.outcome, 'failed');
    assert.equal(closed.turnId, run.turnId); assert.equal(closed.status.status, 'Session Closed');
    assert.equal(closed.status.interactiveSessionClosed, true);
    const changes = await call('read_run_document', { ...identity, purpose: workspaceDocumentPurpose(run.turnId, 'changes') });
    assert.equal(Buffer.from(changes.bytes, 'base64').toString(), 'M result.txt');
    assert.equal(store.read(closed.status.taskReportObjectId).data.availability, 'missing');
    await call('recover_run_executions', {});
    const replay = await call('checkpoint_run', intent); assert.equal(replay.receipt.committedSequence, closed.receipt.committedSequence);
    assert.equal((await call('read_run_state', identity)).revision, closed.revision);
    assert.equal(store.recoverableRunStates().items.length, 0);
  } finally { await ops.close(); store.close(); }
});
