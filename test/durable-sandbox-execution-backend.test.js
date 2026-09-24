const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { ProjectAutonomyAuthorizationStore } = require('../out/projectAutonomyAuthorization.js');
const {
  DurableSandboxExecutionBackend,
  recoverDurableExecutionStates
} = require('../out/durableSandboxExecutionBackend.js');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-durable-'));
  const project = path.join(root, 'project');
  const isolation = path.join(root, 'isolated');
  const workspace = path.join(isolation, 'task');
  const stateRoot = path.join(root, 'state');
  fs.mkdirSync(project);
  fs.mkdirSync(workspace, { recursive: true });
  const authorization = new ProjectAutonomyAuthorizationStore({ globalDataPath: root });
  const grant = authorization.setEnabled(project, true, [project]);
  const sandboxInputs = [];
  const sandbox = {
    probe: async () => ({ available: true, kind: 'test', reason: '' }),
    buildInvocation(input) {
      sandboxInputs.push(input);
      return { command: input.command, args: input.args || [], env: { PATH: process.env.PATH || '' } };
    }
  };
  const options = {
    isolationRoot: isolation,
    stateRoot,
    authorization,
    sandbox,
    readBaseRevision: async () => 'base-1',
    pollIntervalMs: 20
  };
  return { root, project, workspace, grant, options, authorization, sandboxInputs };
}

test('backend derives tool network access from the current project policy', async () => {
  const fixture = setup();
  const backend = new DurableSandboxExecutionBackend(fixture.options);
  await backend.prepare({
    projectPath: fixture.project, authorizationEpoch: fixture.grant.epoch,
    workspacePath: fixture.workspace, command: process.execPath, args: ['-e', ''],
    baseRevision: 'base-1', timeoutMs: 2_000
  });
  assert.equal(fixture.sandboxInputs[0].networkAccess, 'tool');

  const offline = fixture.authorization.setPolicy(
    fixture.project,
    { enabled: true, toolNetworkDisabled: true },
    [fixture.project]
  );
  const offlinePrepared = await backend.prepare({
    projectPath: fixture.project, authorizationEpoch: offline.epoch,
    workspacePath: fixture.workspace, command: process.execPath, args: ['-e', ''],
    baseRevision: 'base-1', timeoutMs: 2_000
  });
  assert.equal(fixture.sandboxInputs[1].networkAccess, 'offline');
  const offlineExecution = await backend.start(offlinePrepared.preparedId, 'operation-offline-evidence');
  const offlineEvidence = await backend.collectEvidence(offlineExecution.executionId);
  assert.equal(offlineEvidence.toolNetworkAccess, 'blocked');
});

test('an execution package can only narrow an enabled project network policy to offline', async () => {
  const fixture = setup();
  const backend = new DurableSandboxExecutionBackend(fixture.options);

  const prepared = await backend.prepare({
    projectPath: fixture.project, authorizationEpoch: fixture.grant.epoch,
    workspacePath: fixture.workspace, command: process.execPath, args: ['-e', ''],
    baseRevision: 'base-1', timeoutMs: 2_000, requestedNetworkAccess: 'offline'
  });

  assert.equal(fixture.sandboxInputs[0].networkAccess, 'offline');
  const execution = await backend.start(prepared.preparedId, 'operation-requested-offline');
  const evidence = await backend.collectEvidence(execution.executionId);
  assert.equal(evidence.toolNetworkAccess, 'blocked');
});

test('changing tool network policy stops work authorized by the previous epoch', async () => {
  const { project, workspace, grant, options, authorization } = setup();
  const backend = new DurableSandboxExecutionBackend(options);
  const prepared = await backend.prepare({
    projectPath: project, authorizationEpoch: grant.epoch, workspacePath: workspace,
    command: process.execPath, args: ['-e', 'setInterval(() => {}, 40)'],
    baseRevision: 'base-1', timeoutMs: 5_000
  });
  const started = await backend.start(prepared.preparedId, 'operation-network-policy-change');
  authorization.setPolicy(project, { enabled: true, toolNetworkDisabled: true }, [project]);

  const evidence = await backend.collectEvidence(started.executionId);
  assert.equal(evidence.status, 'cancelled');
  assert.equal(evidence.terminationReason, 'authorization_revoked');
  assert.equal(evidence.promotionEligible, false);
});

test('upgrade resumes a legacy operation and reports its former offline boundary', async () => {
  const { root, project, workspace, grant, options } = setup();
  const backend = new DurableSandboxExecutionBackend(options);
  const input = {
    projectPath: project, authorizationEpoch: grant.epoch, workspacePath: workspace,
    command: process.execPath, args: ['-e', ''], baseRevision: 'base-1', timeoutMs: 2_000
  };
  const prepared = await backend.prepare(input);
  const legacyFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    projectPath: fs.realpathSync(project), workspacePath: fs.realpathSync(workspace),
    baseRevision: input.baseRevision, authorizationEpoch: grant.epoch,
    command: input.command, args: input.args, stdin: '', timeoutMs: input.timeoutMs
  })).digest('hex');
  const operationId = 'legacy-operation';
  const executionId = 'legacy-execution';
  const directory = path.join(options.stateRoot, 'executions', executionId);
  const stdoutPath = path.join(directory, 'stdout.log');
  const stderrPath = path.join(directory, 'stderr.log');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(stdoutPath, 'legacy');
  fs.writeFileSync(stderrPath, '');
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    executionId, operationId, preparedId: 'legacy-prepared', workspacePath: fs.realpathSync(workspace),
    projectPath: fs.realpathSync(project), baseRevision: 'base-1', authorizationEpoch: grant.epoch,
    status: 'succeeded', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z',
    exitCode: 0, signal: null, terminationReason: '', workerPid: 0, childPid: 0,
    stdoutPath, stderrPath, executionFingerprint: legacyFingerprint
  }));
  const operationPath = path.join(options.stateRoot, 'operations', `${crypto.createHash('sha256').update(`${fs.realpathSync(project)}\0${operationId}`).digest('hex')}.json`);
  fs.mkdirSync(path.dirname(operationPath), { recursive: true });
  fs.writeFileSync(operationPath, JSON.stringify({
    executionId, operationId, preparedId: 'legacy-prepared', projectPath: fs.realpathSync(project),
    baseRevision: 'base-1', authorizationEpoch: grant.epoch, executionFingerprint: legacyFingerprint
  }));

  const resumed = await backend.start(prepared.preparedId, operationId);
  assert.equal(resumed.executionId, executionId);
  const evidence = await backend.collectEvidence(executionId);
  assert.equal(evidence.toolNetworkAccess, 'blocked');
});

test('a restarted backend resumes the same durable execution and operation id', async () => {
  const { project, workspace, grant, options } = setup();
  const first = new DurableSandboxExecutionBackend(options);
  const prepared = await first.prepare({
    projectPath: project,
    authorizationEpoch: grant.epoch,
    workspacePath: workspace,
    command: process.execPath,
    args: ['-e', 'setTimeout(() => process.stdout.write("done"), 120)'],
    baseRevision: 'base-1',
    timeoutMs: 2_000
  });
  const started = await first.start(prepared.preparedId, 'operation-1');

  const restarted = new DurableSandboxExecutionBackend(options);
  const resumed = await restarted.resume(started.executionId);
  const duplicate = await restarted.start(prepared.preparedId, 'operation-1');
  assert.equal(resumed.executionId, started.executionId);
  assert.equal(duplicate.executionId, started.executionId);

  const evidence = await restarted.collectEvidence(started.executionId);
  assert.equal(evidence.status, 'succeeded');
  assert.equal(evidence.stdout, 'done');
  assert.equal(evidence.promotionEligible, true);
  assert.equal(evidence.toolNetworkAccess, 'allowed');
});

test('a restarted backend can re-prepare the same semantic operation and recover its execution', async () => {
  const { project, workspace, grant, options } = setup();
  const input = {
    projectPath: project, authorizationEpoch: grant.epoch, workspacePath: workspace,
    command: process.execPath, args: ['-e', 'setTimeout(() => {}, 80)'],
    baseRevision: 'base-1', timeoutMs: 2_000
  };
  const first = new DurableSandboxExecutionBackend(options);
  const firstPrepared = await first.prepare(input);
  const started = await first.start(firstPrepared.preparedId, 'operation-semantic-retry');
  const restarted = new DurableSandboxExecutionBackend(options);
  const secondPrepared = await restarted.prepare(input);
  const duplicate = await restarted.start(secondPrepared.preparedId, 'operation-semantic-retry');

  assert.notEqual(secondPrepared.preparedId, firstPrepared.preparedId);
  assert.equal(duplicate.executionId, started.executionId);
  await restarted.collectEvidence(started.executionId);
});

test('revoking project authorization stops a running execution and prevents promotion', async () => {
  const { project, workspace, grant, options, authorization } = setup();
  const backend = new DurableSandboxExecutionBackend(options);
  const prepared = await backend.prepare({
    projectPath: project,
    authorizationEpoch: grant.epoch,
    workspacePath: workspace,
    command: process.execPath,
    args: ['-e', 'setInterval(() => process.stdout.write("tick"), 40)'],
    baseRevision: 'base-1',
    timeoutMs: 5_000
  });
  const started = await backend.start(prepared.preparedId, 'operation-revoke');
  authorization.setEnabled(project, false, [project]);

  const evidence = await backend.collectEvidence(started.executionId);
  assert.equal(evidence.status, 'cancelled');
  assert.equal(evidence.terminationReason, 'authorization_revoked');
  assert.equal(evidence.promotionEligible, false);
});

test('saving an unchanged grant does not stop a running execution', async () => {
  const { project, workspace, grant, options, authorization } = setup();
  const backend = new DurableSandboxExecutionBackend(options);
  const prepared = await backend.prepare({
    projectPath: project,
    authorizationEpoch: grant.epoch,
    workspacePath: workspace,
    command: process.execPath,
    args: ['-e', 'setTimeout(() => process.stdout.write("done"), 100)'],
    baseRevision: 'base-1',
    timeoutMs: 2_000
  });
  const started = await backend.start(prepared.preparedId, 'operation-unchanged-grant');
  assert.equal(authorization.setEnabled(project, true, [project]).epoch, grant.epoch);

  const evidence = await backend.collectEvidence(started.executionId);
  assert.equal(evidence.status, 'succeeded');
  assert.equal(evidence.promotionEligible, true);
});

test('cancellation uses a separate durable signal and cannot roll a terminal state backward', async () => {
  const { project, workspace, grant, options } = setup();
  const backend = new DurableSandboxExecutionBackend(options);
  const prepared = await backend.prepare({
    projectPath: project, authorizationEpoch: grant.epoch, workspacePath: workspace,
    command: process.execPath, args: ['-e', 'setInterval(() => {}, 50)'],
    baseRevision: 'base-1', timeoutMs: 2_000
  });
  const started = await backend.start(prepared.preparedId, 'operation-cancel');
  const cancellation = await backend.cancel(started.executionId);
  const evidence = await backend.collectEvidence(started.executionId);
  assert.equal(cancellation.cancelled, true);
  assert.equal(evidence.status, 'cancelled');
  assert.equal(evidence.terminationReason, 'cancelled_by_user');
});

test('operation identity is scoped to its project', async () => {
  const firstFixture = setup();
  const secondProject = path.join(firstFixture.root, 'project-two');
  const secondWorkspace = path.join(firstFixture.root, 'isolated', 'task-two');
  fs.mkdirSync(secondProject);
  fs.mkdirSync(secondWorkspace);
  const secondGrant = firstFixture.authorization.setEnabled(secondProject, true, [firstFixture.project, secondProject]);
  const backend = new DurableSandboxExecutionBackend(firstFixture.options);
  const firstPrepared = await backend.prepare({
    projectPath: firstFixture.project, authorizationEpoch: firstFixture.grant.epoch,
    workspacePath: firstFixture.workspace, command: process.execPath,
    args: ['-e', ''], baseRevision: 'base-1', timeoutMs: 2_000
  });
  const secondPrepared = await backend.prepare({
    projectPath: secondProject, authorizationEpoch: secondGrant.epoch,
    workspacePath: secondWorkspace, command: process.execPath,
    args: ['-e', ''], baseRevision: 'base-1', timeoutMs: 2_000
  });

  const first = await backend.start(firstPrepared.preparedId, 'shared-operation');
  const second = await backend.start(secondPrepared.preparedId, 'shared-operation');
  assert.notEqual(first.executionId, second.executionId);
  await Promise.all([backend.collectEvidence(first.executionId), backend.collectEvidence(second.executionId)]);
});

test('a duplicate operation cannot bypass a revoked authorization after restart', async () => {
  const { project, workspace, grant, options, authorization } = setup();
  const backend = new DurableSandboxExecutionBackend(options);
  const prepared = await backend.prepare({
    projectPath: project, authorizationEpoch: grant.epoch, workspacePath: workspace,
    command: process.execPath, args: ['-e', ''], baseRevision: 'base-1', timeoutMs: 2_000
  });
  const started = await backend.start(prepared.preparedId, 'operation-stale');
  await backend.collectEvidence(started.executionId);
  authorization.setEnabled(project, false, [project]);

  const restarted = new DurableSandboxExecutionBackend(options);
  await assert.rejects(() => restarted.start(prepared.preparedId, 'operation-stale'), /revoked|stale/i);
});

test('runtime startup keeps live executions and explicitly terminates unrecoverable ones', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-recover-'));
  const executions = path.join(root, 'executions');
  const liveId = 'live-execution';
  const deadId = 'dead-execution';
  const unreadyId = 'unready-execution';
  for (const [executionId, workerPid] of [[liveId, process.pid], [deadId, 99999999], [unreadyId, 0]]) {
    const directory = path.join(executions, executionId);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
      executionId,
      operationId: `operation-${executionId}`,
      preparedId: `prepared-${executionId}`,
      workspacePath: '/isolated/workspace',
      status: 'running',
      workerPid,
      finishedAt: '',
      terminationReason: ''
    }));
  }

  const recovered = recoverDurableExecutionStates(root);
  assert.equal(recovered.find(item => item.executionId === liveId).status, 'running');
  assert.equal(recovered.find(item => item.executionId === deadId).status, 'failed');
  assert.equal(recovered.find(item => item.executionId === unreadyId).status, 'failed');
  const deadState = JSON.parse(fs.readFileSync(path.join(executions, deadId, 'state.json'), 'utf8'));
  assert.equal(deadState.terminationReason, 'worker_interrupted');
  const unreadyState = JSON.parse(fs.readFileSync(path.join(executions, unreadyId, 'state.json'), 'utf8'));
  assert.equal(unreadyState.terminationReason, 'worker_interrupted_before_ready');
});

test('runtime recovery rejects a reused live PID when the durable worker identity does not match', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-recover-reused-pid-'));
  const executionId = 'reused-pid';
  const directory = path.join(root, 'executions', executionId);
  const readyPath = path.join(directory, 'worker-ready');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(readyPath, '');
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    executionId, operationId: 'operation', preparedId: 'prepared', workspacePath: '/workspace',
    status: 'running', workerPid: process.pid, workerToken: 'not-this-process', readyPath,
    finishedAt: '', terminationReason: ''
  }));

  const recovered = recoverDurableExecutionStates(root);
  assert.equal(recovered[0].status, 'failed');
  const state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'));
  assert.equal(state.terminationReason, 'worker_interrupted');
});

test('runtime recovery fails an alive worker that never received its durable ready signal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-recover-unready-'));
  const executionId = 'unready-live-worker';
  const directory = path.join(root, 'executions', executionId);
  const readyPath = path.join(directory, 'worker-ready');
  const workerToken = 'solomap-unready-test-token';
  fs.mkdirSync(directory, { recursive: true });
  const worker = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', workerToken], { stdio: 'ignore' });
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    executionId, operationId: 'operation', preparedId: 'prepared', workspacePath: '/workspace',
    status: 'running', workerPid: worker.pid, workerToken, readyPath,
    finishedAt: '', terminationReason: ''
  }));

  const recovered = recoverDurableExecutionStates(root);
  assert.equal(recovered[0].status, 'failed');
  const state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'));
  assert.equal(state.terminationReason, 'worker_interrupted_before_ready');
  await new Promise(resolve => worker.once('close', resolve));
});
