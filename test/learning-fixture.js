const fs = require('node:fs');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');
const { buildLearningRetrievalContext } = require('../out/learningLedger.js');

async function readFormalLearningContext(projectRoot, globalRoot, query) {
  const store = new UnifiedDataStore(globalRoot); const ops = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: globalRoot, runtimeId: 'legacy-learning-fixture', onCommand: () => ({ status: 'running' }), onData: ops });
  try {
    const { projectId } = await ops({ operation: 'register_project', input: { root: projectRoot } });
    const sourceRoot = path.join(globalRoot, 'learning');
    if (fs.existsSync(sourceRoot)) {
      const job = await ops({ operation: 'import_project_data', input: { collection: 'learning', sourceRoot, projectScopes: { [projectRoot]: projectId }, idempotencyKey: `fixture-learning-${store.migrationJobCount()}` } });
      await ops.waitForMigrations();
      const status = store.readMigrationJob(job.jobId);
      if (status.status !== 'completed') throw new Error(JSON.stringify(status));
    }
    return await buildLearningRetrievalContext(projectRoot, globalRoot, query);
  } finally { await server.close(); await ops.close(); store.close(); }
}

module.exports = { readFormalLearningContext };
