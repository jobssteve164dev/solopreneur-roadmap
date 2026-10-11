const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { once } = require('node:events');
const { promisify } = require('node:util');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { sendRuntimeDataRequest, sendRuntimeControlCommand } = require('../out/autonomousRuntimeControl.js');

for (const matches of [true, false]) test(`the shared checkpoint preserves the Claude provider observation before closing (${matches ? 'matching' : 'conflicting'})`, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-provider-checkpoint-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const native = await require('./analysis-fixture.js').openAnalysisOwner(t, root, [{ path: project }]);
  const prepared = await require('../out/agentRunPreparation.js').prepareAgentRun({ agentCli: 'claude', selectedModel: '', prompt: '完成用户任务', workspaceRoot: project, nodeId: '__solo__', executionLogId: 1, userMessage: '完成用户任务', runKind: 'solo', globalDataPath: root, taskPermissionMode: 'auto' }, (operation, input) => native.ops({ operation, input }));
  const before = await native.ops({ operation: 'read_run_binding', input: { root: project, executionLogId: 1 } });
  assert.equal(before.revisions.at(-1).state, 'planned');
  const expected = prepared.status.plannedNativeSessionId;
  const controlled = await native.ops({ operation: 'read_run_checkpoint_state', input: { root: project, executionLogId: 1 } });
  const env = { ...process.env, SOLOMAP_GLOBAL_DATA_PATH: root, SOLOMAP_PROJECT_ID: prepared.projectId, SOLOMAP_EXECUTION_LOG_ID: '1', SOLOMAP_RUN_GENERATION: String(prepared.generation), SOLOMAP_RUN_PROOF: controlled.proof, SOLOMAP_TASK_TURN_ID: prepared.turnId, CLAUDE_CODE_SESSION_ID: matches ? expected : 'different-provider-session' };
  const argv = [path.resolve(__dirname, '../out/taskCheckpointProcess.js'), 'complete', '--outcome', 'partial', '--summary', '本轮任务已完成'];
  const completed = JSON.parse((await promisify(execFile)(process.execPath, argv, { env })).stdout);
  assert.equal(completed.status.checkpointOutcome, 'partial', 'identity observations must not discard the business result');
  const binding = await native.ops({ operation: 'read_run_binding', input: { root: project, executionLogId: 1 } });
  assert.equal(binding.headRevision, 3);
  assert.equal(binding.revisions.at(-1).state, matches ? 'confirmed' : 'conflict');
  assert.equal(completed.status.nativeSessionIdIsCurrent, matches);
  assert.equal(completed.status.nativeSessionId, matches ? expected : '');
  if (matches) assert.equal(binding.resumableRevision, 3);
  else assert.equal(binding.revisions.at(-1).errorCode, 'identity_provider_mismatch');
  const statuses = await new (require('../out/runLifecycleClient.js').RunLifecycleClient)((operation, input) => native.ops({ operation, input }), root).listStatuses(project, true);
  assert.equal(statuses.length, 1, 'the completed business turn must remain available to its formal consumer');
  assert.equal(statuses[0].status.nativeSessionIdIsCurrent, matches, 'the formal consumer must see the committed binding projection');
  const queued = await native.ops({ operation: 'list_run_states', input: { root: project, pendingConsumer: true, cursor: 0, limit: 10 } });
  assert.equal(queued.items[0].revision, completed.revision, 'the queue must pin the final checkpoint, after its binding mutation');
  const walPath = path.join(root, 'solomap.db-wal');
  const wal = fs.existsSync(walPath) ? fs.readFileSync(walPath) : Buffer.alloc(0);
  const replay = JSON.parse((await promisify(execFile)(process.execPath, argv, { env })).stdout);
  assert.deepEqual(replay.receipt, completed.receipt);
  assert.equal((await native.ops({ operation: 'read_run_binding', input: { root: project, executionLogId: 1 } })).headRevision, 3);
  assert.deepEqual(fs.existsSync(walPath) ? fs.readFileSync(walPath) : Buffer.alloc(0), wal, 'an unchanged checkpoint retry must not amplify writes');
  const old = await native.ops({ operation: 'read_run_state', input: { root: project, executionLogId: 1, revision: prepared.revision } });
  assert.notEqual(old.status.nativeSessionIdIsCurrent, true, 'the older planned snapshot cannot inherit a later confirmation');
  assert.equal(fs.existsSync(path.join(project, '.solopreneur', 'agent-status')), false);
  assert.equal(fs.existsSync(path.join(project, '.solopreneur', 'agent-runs')), false);
});

test('the shared checkpoint submits a report with its actual turn and leaves no status or report copies', async () => {
  const checkpoint = path.resolve(__dirname, '../out/taskCheckpointProcess.js');
  assert.ok(fs.existsSync(checkpoint), 'the packaged checkpoint must replace project program copies');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-checkpoint-process-'));
  const root = path.join(base, '.solomap-global');
  const projectRoot = path.join(base, 'project'); fs.mkdirSync(projectRoot);
  const seed = new UnifiedDataStore(root);
  const project = await seed.registerProject({ root: projectRoot });
  const prepared = seed.prepareRun(project.projectId, project.locationId, { root: projectRoot, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '输入', command: 'codex', userMessage: '用户目标', metadata: { interactiveSession: true }, idempotencyKey: 'prepare' });
  seed.close();
  const runtime = spawn(process.execPath, [path.resolve(__dirname, '../out/autonomousRuntimeProcess.js'), '--global-data-path', root], { stdio: 'pipe' });
  let errors = ''; runtime.stderr.on('data', b => { errors += b; }); runtime.stdout.resume();
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(path.join(root, 'runtime', 'control.json'))) {
      assert.equal(runtime.exitCode, null, errors); assert.ok(Date.now() < deadline, errors);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const env = { ...process.env, SOLOMAP_GLOBAL_DATA_PATH: root, SOLOMAP_PROJECT_ID: prepared.projectId, SOLOMAP_EXECUTION_LOG_ID: '1', SOLOMAP_RUN_GENERATION: String(prepared.generation), SOLOMAP_RUN_PROOF: prepared.proof, SOLOMAP_TASK_TURN_ID: prepared.turnId };
    const report = { schemaVersion: 1, summary: '已完成本轮核验', unmetRequirements: [], decisions: [], corrections: [], verification: [], commits: [], experienceUsage: [], lessons: [] };
    const args = [checkpoint, 'complete', '--message', '用户目标', '--outcome', 'partial', '--summary', '已完成本轮核验', '--report-json', JSON.stringify(report)];
    const completed = JSON.parse((await promisify(execFile)(process.execPath, args, { env })).stdout);
    assert.equal(completed.status.checkpointOutcome, 'partial');
    const replay = JSON.parse((await promisify(execFile)(process.execPath, args, { env })).stdout);
    assert.equal(replay.receipt.committedSequence, completed.receipt.committedSequence);
    const reports = await sendRuntimeDataRequest(root, { operation: 'search', input: { scope: prepared.projectId, kinds: ['report'], query: '' } });
    assert.equal(reports.items.length, 1);
    const saved = await sendRuntimeDataRequest(root, { operation: 'read', input: { ref: reports.items[0].objectId } });
    assert.equal(saved.data.turn_id, prepared.turnId);
    assert.deepEqual(JSON.parse(saved.data.content), report);
    const started = JSON.parse((await promisify(execFile)(process.execPath, [checkpoint, 'start', '--message', '继续核验'], { env })).stdout);
    assert.notEqual(started.turnId, prepared.turnId);
    assert.equal(started.taskId, prepared.taskId);
    const restarted = JSON.parse((await promisify(execFile)(process.execPath, [checkpoint, 'start', '--message', '继续核验'], { env })).stdout);
    assert.equal(restarted.receipt.committedSequence, started.receipt.committedSequence);
    assert.equal(restarted.turnId, started.turnId);
    const lateReplay = JSON.parse((await promisify(execFile)(process.execPath, [...args, '--turn-id', prepared.turnId], { env })).stdout);
    assert.equal(lateReplay.receipt.committedSequence, completed.receipt.committedSequence);
    assert.equal(lateReplay.turnId, prepared.turnId); assert.equal(lateReplay.revision, lateReplay.receipt.revision);
    const current = await sendRuntimeDataRequest(root, { operation: 'read_run_state', input: { projectId: prepared.projectId, executionLogId: 1 } });
    assert.equal(current.turnId, started.turnId); assert.equal(current.status.status, 'Running');
    await assert.rejects(promisify(execFile)(process.execPath, [checkpoint, 'complete', '--turn-id', prepared.turnId, '--outcome', 'partial', '--summary', 'different late intent'], { env }), /checkpoint_turn_conflict/);
    await assert.rejects(promisify(execFile)(process.execPath, [checkpoint, 'complete', '--outcome', 'partial', '--summary', 'wrong proof'], { env: { ...env, SOLOMAP_RUN_PROOF: 'bad' } }), /run_proof_denied/);
    assert.deepEqual(fs.readdirSync(path.join(projectRoot, '.solopreneur')), ['project.json']);
  } finally {
    if (runtime.exitCode === null) { const exited = once(runtime, 'exit'); await sendRuntimeControlCommand(root, 'stop'); await exited; }
  }
});
