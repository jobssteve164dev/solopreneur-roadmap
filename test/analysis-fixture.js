const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');
const { claimRuntimeLease } = require('../out/autonomousRuntime.js');
const { runtimeBuildId } = require('../out/runtimeBuildIdentity.js');
const fs = require('node:fs');
const path = require('node:path');

async function openAnalysisOwner(t, root, projects) {
  const store = new UnifiedDataStore(root);
  const ops = createRuntimeDataOperations(store);
  const runtimeId = 'analysis-fixture-owner';
  claimRuntimeLease(root, { runtimeId, pid: process.pid });
  const entryPath = path.resolve(__dirname, '../out/autonomousRuntimeProcess.js');
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId, entryPath, buildId: runtimeBuildId(path.resolve(__dirname, '..')),
    onCommand: () => ({ status: 'running' }), onData: ops });
  t.after(async () => {
    await server.close(); await ops.close(); store.close();
    const file = path.join(root, 'runtime', 'state.json');
    if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file)).runtimeId === runtimeId) fs.unlinkSync(file);
  });
  const projectIds = new Map();
  for (const project of projects) projectIds.set(project.path, (await store.registerProject({ root: project.path, name: project.name })).projectId);
  return { store, ops, projectIds };
}

function anonymousToolEnv() {
  const env = { ...process.env };
  for (const key of ['SOLOMAP_PROJECT_ID', 'SOLOMAP_EXECUTION_LOG_ID', 'SOLOMAP_RUN_GENERATION', 'SOLOMAP_RUN_PROOF', 'SOLOMAP_RUN_KIND', 'SOLOMAP_TERMINAL_DELIVERY_ID', 'SOLOMAP_DIAGNOSTIC_TRACE_ID', 'SOLOMAP_DELIVERY_STARTED_AT']) delete env[key];
  return env;
}

module.exports = { openAnalysisOwner, anonymousToolEnv };
