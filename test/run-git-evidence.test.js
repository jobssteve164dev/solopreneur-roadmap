const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');

test('checkpoint seals the complete Git evidence and later review never re-reads changed workspace files', async () => {
  const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-sealed-git-evidence-'));
  const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(project, 'result.txt'), '原始文件\n'); git('add', 'result.txt'); git('commit', '-q', '-m', 'fixture baseline');
  const baseline = git('rev-parse', 'HEAD');
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const run = await call('prepare_run', { root: project, executionLogId: 1, nodeId: 'step', runKind: 'step', prompt: '原始目标', command: 'actual CLI', userMessage: '目标', metadata: { interactiveSession: true, baseGitHash: baseline }, idempotencyKey: 'git-evidence-run' });
    const changed = '本轮完整交付🌿\n'.repeat(30000);
    fs.writeFileSync(path.join(project, 'result.txt'), changed); fs.writeFileSync(path.join(project, 'new-result.txt'), '本轮新增产物🌿');
    await call('checkpoint_run', { projectId: run.projectId, executionLogId: 1, generation: run.generation, proof: run.proof, expectedRevision: run.revision, expectedTurnId: run.turnId, action: 'complete', outcome: 'candidate_complete', summary: '本轮交付', idempotencyKey: 'git-evidence-complete' });
    const source = (await call('list_run_states', { root: project, pendingConsumer: true })).items[0];
    const client = new RunLifecycleClient(call); const ref = runStatusReference(project, 1); const accepted = await client.readStatus(ref, source.revision);
    fs.writeFileSync(path.join(project, 'result.txt'), '下一轮不同内容'); fs.writeFileSync(path.join(project, 'new-result.txt'), '下一轮新增不同内容');
    const evidence = await client.readGitEvidence(ref, accepted);
    assert.equal(evidence.baseGitHash, baseline); assert.equal(evidence.available, true);
    assert.equal(evidence.files['result.txt'].digest, require('node:crypto').createHash('sha256').update(changed).digest('hex'));
    assert.equal(evidence.files['new-result.txt'].digest, require('node:crypto').createHash('sha256').update('本轮新增产物🌿').digest('hex'));
    assert.ok(evidence.patch.includes(changed.split('\n')[0])); assert.ok(evidence.patch.includes('本轮新增产物🌿'));
    assert.ok(evidence.patch.length > 300000); assert.ok(!evidence.patch.includes('下一轮不同内容'));
    assert.equal((await client.readGitEvidence(ref, accepted)).patch, evidence.patch);
    assert.deepEqual(fs.readdirSync(path.join(project, '.solopreneur')), ['project.json']);
  } finally { await ops.close(); store.close(); }
});

for (const mode of ['recovery', 'stop', 'native', 'recovery-pending', 'stop-pending']) {
  test(`${mode} closure seals the Git evidence without the window checkpoint dispatcher`, async () => {
    const { RunLifecycleClient, runStatusReference } = require('../out/runLifecycleClient.js');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `solomap-${mode}-git-evidence-`));
    const root = path.join(base, 'global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
    const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(project, 'result.txt'), '原始文件'); git('add', 'result.txt'); git('commit', '-q', '-m', 'fixture baseline');
    const baseline = git('rev-parse', 'HEAD');
    const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
    const call = (operation, input) => ops({ operation, input });
    try {
      const run = await call('prepare_run', { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '原始目标', command: 'actual CLI', userMessage: '目标', metadata: { interactiveSession: mode === 'native' || mode === 'stop', baseGitHash: baseline }, idempotencyKey: `${mode}-git-run` });
      let state = await call('claim_run', { projectId: run.projectId, executionLogId: 1, expectedRevision: run.revision, ...(mode.endsWith('-pending') ? { agentPid: process.pid } : {}), idempotencyKey: `${mode}-claim` });
      if (mode.endsWith('-pending')) {
        state = await call('checkpoint_run', { projectId: run.projectId, executionLogId: 1, generation: state.generation, proof: state.proof, expectedRevision: state.revision, expectedTurnId: state.turnId, action: 'complete', outcome: 'partial', summary: '结果已接受，宿主还有输出', idempotencyKey: 'pending-git-result' });
        assert.equal(state.status.hostOutputPending, true);
        state = await call('patch_run_state', { projectId: run.projectId, executionLogId: 1, generation: state.generation, expectedRevision: state.revision, patch: { agentPid: 0 }, idempotencyKey: 'dead-git-host' });
      }
      if (mode === 'native') {
        const { snapshotWorkspace, workspaceDocumentPurpose } = require('../out/runWorkspace.js');
        const before = await snapshotWorkspace(project);
        await call('write_run_document', { projectId: run.projectId, executionLogId: 1, generation: state.generation, turnId: state.turnId, purpose: workspaceDocumentPurpose(state.turnId, 'before'), bytes: Buffer.from(JSON.stringify(before)).toString('base64'), mimeType: 'application/json', expectedRevision: 0, idempotencyKey: 'native-git-host-before' });
      }
      fs.writeFileSync(path.join(project, 'result.txt'), '此轮最终完整产物🌿');
      if (mode === 'native') {
        const { RunNativeObserver } = require('../out/runNativeObserver.js'); const observer = new RunNativeObserver(store);
        const current = () => store.readRunCheckpointState(run.projectId, 1);
        const patch = (fields, event) => { const head = current(); return store.patchRunState(run.projectId, { executionLogId: 1, generation: head.generation, expectedRevision: head.revision, patch: fields, idempotencyKey: `native-git:${event}:${head.revision}` }); };
        const timestamp = new Date().toISOString();
        await observer.observeRow(current, patch, { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: 'native-git-one', started_at: timestamp } }, 0);
        await observer.observeRow(current, patch, { type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: 'native-git-one', started_at: timestamp, last_agent_message: '本轮交付' } }, 100);
        state = current();
        const nextTime = new Date(Date.now() + 1).toISOString();
        await observer.observeRow(current, patch, { type: 'event_msg', timestamp: nextTime, payload: { type: 'task_started', turn_id: 'native-git-two', started_at: nextTime } }, 200);
        assert.equal(current().status.baseGitHash, baseline, 'machine-started turns retain their own Git baseline');
      } else if (mode.startsWith('stop')) {
        state = await call('stop_run', { projectId: run.projectId, executionLogId: 1, generation: state.generation, expectedRevision: state.revision, expectedTurnId: state.turnId, reason: '用户停止', idempotencyKey: 'git-stop' });
      } else {
        await call('recover_run_executions', {}); state = await call('read_run_state', { projectId: run.projectId, executionLogId: 1 });
      }
      const client = new RunLifecycleClient(call); const ref = runStatusReference(project, 1); const snapshot = await client.readStatus(ref, state.revision);
      assert.notEqual(snapshot.hostOutputPending, true);
      const evidence = await client.readGitEvidence(ref, snapshot);
      assert.ok(evidence, `${mode} must save the full sealed Git evidence`);
      assert.equal(evidence.baseGitHash, baseline); assert.ok(evidence.patch.includes('此轮最终完整产物🌿'));
      assert.deepEqual(fs.readdirSync(path.join(project, '.solopreneur')), ['project.json']);
    } finally { await ops.close(); store.close(); }
  });
}
