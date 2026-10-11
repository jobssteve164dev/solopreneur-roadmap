const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');

test('review path inputs preserve complete database bytes and clean only registered temporary files across restart', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-review-path-'));
  const root = path.join(base, 'global'); const projectRoot = path.join(base, 'project'); fs.mkdirSync(projectRoot);
  let store = new UnifiedDataStore(root); let ops = createRuntimeDataOperations(store);
  const call = (operation, input) => ops({ operation, input });
  try {
    const project = await store.registerProject({ root: projectRoot });
    const prompt = '完整🌿\n'.repeat(60000);
    const prepared = store.prepareRun(project.projectId, project.locationId, { root: projectRoot, executionLogId: 1, nodeId: 'step', runKind: 'agent_review', prompt, command: 'readonly', userMessage: '复核', idempotencyKey: 'prepare-temp-review' });
    const identity = { projectId: project.projectId, executionLogId: 1, generation: prepared.generation, proof: prepared.proof };
    const materialized = await call('materialize_run_prompt', identity);
    assert.equal(fs.readFileSync(materialized.path, 'utf8'), prompt);
    assert.ok(materialized.path.startsWith(path.join(root, 'tmp') + path.sep));
    assert.deepEqual(await call('materialize_run_prompt', identity), materialized);
    const unrelated = path.join(root, 'tmp', 'user-owned.txt'); fs.writeFileSync(unrelated, 'keep');
    await assert.rejects(call('release_run_prompt', { ...identity, proof: 'invalid' }), /run_proof_denied/);
    assert.ok(fs.existsSync(materialized.path));
    await ops.close(); store.close(); store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store);
    await call('recover_run_inputs', {});
    assert.equal(fs.existsSync(materialized.path), false);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
    assert.deepEqual(fs.readdirSync(path.join(projectRoot, '.solopreneur')), ['project.json']);
    assert.equal(store.listRunInputMaterializations().items.length, 0);
  } finally { await ops.close(); store.close(); }
});

test('a replacement generation retires the old input without touching its live replacement', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-review-generation-path-'));
  const root = path.join(base, 'global'); const projectRoot = path.join(base, 'project'); fs.mkdirSync(projectRoot);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  try {
    const project = await store.registerProject({ root: projectRoot });
    const prepared = store.prepareRun(project.projectId, project.locationId, { root: projectRoot, executionLogId: 1, nodeId: 'step', runKind: 'agent_review', prompt: '完整输入', command: 'readonly', userMessage: '复核', idempotencyKey: 'prepare-generations' });
    const old = await ops({ operation: 'materialize_run_prompt', input: { projectId: project.projectId, executionLogId: 1, generation: prepared.generation, proof: prepared.proof } });
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8'); const birth = `proc:${stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19]}`;
    const replacement = store.claimRun(project.projectId, { executionLogId: 1, expectedRevision: prepared.revision, agentPid: process.pid, processBirth: birth, idempotencyKey: 'replace-old-input-generation' });
    const identity = { projectId: project.projectId, executionLogId: 1, generation: replacement.generation, proof: replacement.proof };
    const next = await ops({ operation: 'materialize_run_prompt', input: identity });
    await ops({ operation: 'recover_run_inputs', input: {} });
    assert.equal(fs.existsSync(old.path), false);
    assert.equal(fs.readFileSync(next.path, 'utf8'), '完整输入');
    await ops({ operation: 'release_run_prompt', input: identity });
    assert.deepEqual(fs.readdirSync(path.join(root, 'tmp')), []);
  } finally { await ops.close(); store.close(); }
});

test('a corrupt registered input cannot prevent another project execution from recovering', async () => {
  const { RunRecovery } = require('../out/runRecovery.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-corrupt-input-recovery-'));
  const root = path.join(base, 'global'); const projectRoot = path.join(base, 'project'); fs.mkdirSync(projectRoot);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store); const recovery = new RunRecovery(store);
  try {
    const project = await store.registerProject({ root: projectRoot });
    const prepared = store.prepareRun(project.projectId, project.locationId, { root: projectRoot, executionLogId: 1, nodeId: 'step', runKind: 'agent_review', prompt: '完整输入', command: 'readonly', userMessage: '复核', idempotencyKey: 'prepare-conflicting-input' });
    const entry = await ops({ operation: 'materialize_run_prompt', input: { projectId: project.projectId, executionLogId: 1, generation: prepared.generation, proof: prepared.proof } });
    fs.writeFileSync(entry.path, 'outside content that must remain');
    const otherRoot = path.join(base, 'other-project'); fs.mkdirSync(otherRoot);
    const other = await store.registerProject({ root: otherRoot });
    const unfinished = store.prepareRun(other.projectId, other.locationId, { root: otherRoot, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '待恢复', command: 'unused', userMessage: '目标', idempotencyKey: 'other-unfinished' });
    store.claimRun(other.projectId, { executionLogId: 1, expectedRevision: unfinished.revision, agentPid: 2147483647, processBirth: 'proc:gone', idempotencyKey: 'other-dead-owner' });
    await assert.rejects(recovery.recover(), /run_input_file_conflict/);
    assert.equal(store.readRunState(other.projectId, 1).status.status, 'Failed');
    assert.equal(fs.readFileSync(entry.path, 'utf8'), 'outside content that must remain');
  } finally { await recovery.close(); await ops.close(); store.close(); }
});

test('a crash during prompt materialization preserves the partial bytes in the database and retires its own unfinished file', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-partial-input-recovery-'));
  const root = path.join(base, 'global'); const projectRoot = path.join(base, 'project'); fs.mkdirSync(projectRoot);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  try {
    const project = await store.registerProject({ root: projectRoot });
    const prepared = store.prepareRun(project.projectId, project.locationId, { root: projectRoot, executionLogId: 1, nodeId: 'step', runKind: 'agent_review', prompt: '完整输入🌿'.repeat(20000), command: 'readonly', userMessage: '复核', idempotencyKey: 'prepare-partial-input' });
    const entry = store.reserveRunInputMaterialization(project.projectId, 1, prepared.generation);
    fs.mkdirSync(path.dirname(entry.path), { recursive: true });
    const prefix = Buffer.from('完整输入🌿'.repeat(20000)).subarray(0, 103);
    fs.writeFileSync(entry.path, prefix, { flag: 'wx' });
    await ops({ operation: 'recover_run_inputs', input: {} });
    assert.equal(fs.existsSync(entry.path), false);
    const evidence = store.readRunDocument(project.projectId, 1, `temporary_observed_${prepared.generation}`);
    assert.deepEqual(Buffer.from(evidence.bytes, 'base64'), prefix);
    assert.equal(store.listRunInputMaterializations().items.length, 0);
  } finally { await ops.close(); store.close(); }
});
