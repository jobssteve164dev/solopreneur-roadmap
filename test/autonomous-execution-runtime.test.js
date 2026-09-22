const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { initializeAutonomousExecutionRuntime } = require('../out/autonomousExecutionRuntime.js');

test('runtime startup recovers executions and records fail-closed sandbox readiness', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-execution-runtime-'));
  const stateDirectory = path.join(root, 'runtime', 'autonomous-executions', 'executions', 'interrupted');
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.writeFileSync(path.join(stateDirectory, 'state.json'), JSON.stringify({
    executionId: 'interrupted', operationId: 'operation', preparedId: 'prepared',
    workspacePath: '/workspace', status: 'running', workerPid: 0,
    finishedAt: '', terminationReason: ''
  }));
  const sandbox = {
    probe: async () => ({ available: false, kind: 'test', reason: 'unavailable' }),
    buildInvocation() { throw new Error('must not run'); }
  };

  const initialized = await initializeAutonomousExecutionRuntime({ globalDataPath: root, sandbox });
  assert.deepEqual(initialized.recoveredExecutionIds, ['interrupted']);
  assert.equal(initialized.sandboxAvailable, false);
  const state = JSON.parse(fs.readFileSync(path.join(stateDirectory, 'state.json'), 'utf8'));
  assert.equal(state.status, 'failed');
  assert.equal(state.terminationReason, 'worker_interrupted_before_ready');
  const health = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'execution-runtime.json'), 'utf8'));
  assert.equal(health.readyForAutonomousWrites, false);
  assert.deepEqual(health.recoveredExecutions, [{ executionId: 'interrupted', status: 'failed' }]);
});
