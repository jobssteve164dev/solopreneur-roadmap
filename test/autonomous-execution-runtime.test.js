const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { initializeAutonomousExecutionRuntime } = require('../out/autonomousExecutionRuntime.js');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');

test('runtime startup recovers executions and returns fail-closed sandbox readiness without a runtime JSON ledger', async t => {
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
  const dataStore = new UnifiedDataStore(root);
  t.after(() => {
    dataStore.close();
    for (const name of ['solomap.db-shm', 'solomap.db-wal', 'solomap.db']) { const file = path.join(root, name); if (fs.existsSync(file)) fs.unlinkSync(file); }
  });
  t.after(() => {
    fs.unlinkSync(path.join(stateDirectory, 'state.json'));
    fs.rmdirSync(stateDirectory);
    fs.rmdirSync(path.join(root, 'runtime', 'autonomous-executions', 'executions'));
    fs.rmdirSync(path.join(root, 'runtime', 'autonomous-executions'));
    fs.rmdirSync(path.join(root, 'runtime', 'isolated-workspaces'));
    fs.rmdirSync(path.join(root, 'runtime'));
    fs.rmdirSync(root);
  });

  const initialized = await initializeAutonomousExecutionRuntime({ globalDataPath: root, dataStore, sandbox });
  assert.deepEqual(initialized.recoveredExecutionIds, ['interrupted']);
  assert.equal(initialized.sandboxAvailable, false);
  const state = JSON.parse(fs.readFileSync(path.join(stateDirectory, 'state.json'), 'utf8'));
  assert.equal(state.status, 'failed');
  assert.equal(state.terminationReason, 'worker_interrupted_before_ready');
  assert.equal(fs.existsSync(path.join(root, 'runtime', 'execution-runtime.json')), false);
});
