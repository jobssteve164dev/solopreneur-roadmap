const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');
const { SyncEngine } = require('../out/db/syncEngine.js');

test('project journal writes are immediate and concurrent through the single Runtime owner', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-journal-db-')), '.solomap-global');
  const project = path.join(path.dirname(root), 'project');
  fs.mkdirSync(project); fs.mkdirSync(root);
  const store = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(store);
  try {
    const writes = await Promise.all(Array.from({ length: 12 }, (_, index) => operations({ operation: 'append_project_journal', input: {
      root: project, idempotencyKey: `run-${index}`, entry: { nodeId: 'step', timestamp: new Date(2026, 0, 1, 0, index).toISOString(), agentCli: 'codex', command: `command-${index}`, output: `output-${index}`, status: 'Processed' }
    } })));
    assert.equal(new Set(writes.map(item => item.executionLogId)).size, 12);
    const page = await operations({ operation: 'read_project_journal', input: { root: project, nodeId: 'step', limit: 20, offset: 0 } });
    assert.equal(page.logs.length, 12);
    assert.equal(page.hasMore, false);
    await operations({ operation: 'update_project_journal', input: { root: project, executionLogId: writes[0].executionLogId, agentCli: 'codex', command: 'updated', output: 'ready', status: 'Completed' } });
    const updated = await operations({ operation: 'read_project_journal', input: { root: project, executionLogId: writes[0].executionLogId, limit: 1 } });
    assert.equal(updated.logs[0].output, 'ready');
    assert.equal(updated.logs[0].status, 'Completed');
  } finally { await operations.close(); store.close(); }
});

test('project journal IDs are isolated per project', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-journal-scope-')), '.solomap-global');
  const store = new UnifiedDataStore(root); const operations = createRuntimeDataOperations(store);
  const projects = [path.join(path.dirname(root), 'one'), path.join(path.dirname(root), 'two')];
  projects.forEach(project => fs.mkdirSync(project));
  try {
    for (const project of projects) await operations({ operation: 'append_project_journal', input: { root: project, executionLogId: 1, idempotencyKey: 'legacy:1', entry: { nodeId: 'step', timestamp: '2026-01-01T00:00:00.000Z', agentCli: 'codex', command: 'run', output: project, status: 'Completed' } } });
    const histories = await Promise.all(projects.map(project => operations({ operation: 'read_project_journal', input: { root: project } })));
    assert.deepEqual(histories.map(history => [history.logs[0].id, history.logs[0].output]), [[1, projects[0]], [1, projects[1]]]);
  } finally { await operations.close(); store.close(); }
});

test('SyncEngine loads complete journal pages and exposes writes only after durable commit', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-journal-sync-'));
  const root = path.join(fixture, '.solomap-global'); const project = path.join(fixture, 'project'); const solopreneur = path.join(project, '.solopreneur');
  fs.mkdirSync(solopreneur, { recursive: true });
  fs.writeFileSync(path.join(solopreneur, 'roadmap.csv'), 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,Plan,,Stage,,codex,,Pending,2026-01-01T00:00:00.000Z,');
  const store = new UnifiedDataStore(root); const operations = createRuntimeDataOperations(store);
  const registered = await store.registerProject({ root: project });
  for (let id = 1; id <= 510; id++) store.appendProjectJournal(registered.projectId, `seed:${id}`, { nodeId: 'step', timestamp: '2026-01-01T00:00:00.000Z', agentCli: 'codex', command: 'run', output: String(id), status: 'Completed' }, id);
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'journal-sync-owner', onCommand: () => ({ status: 'running' }), onData: operations });
  let serverOpen = true;
  const engine = new SyncEngine(path.join(solopreneur, 'roadmap.csv'), path.join(solopreneur, 'project_journal.db'), path.resolve(__dirname, '..'), root);
  try {
    await engine.initAndSync();
    assert.equal(engine.getProjectAgentExecutions().length, 510);
    const id = await engine.logAgentExecution('step', 'codex', 'new', 'durable', 'Running');
    assert.equal((await operations({ operation: 'read_project_journal', input: { root: project, executionLogId: id } })).logs[0].output, 'durable');
    await server.close(); serverOpen = false;
    const before = engine.getProjectAgentExecutions().length;
    await assert.rejects(engine.logAgentExecution('step', 'codex', 'failed', 'must not appear', 'Running'));
    assert.equal(engine.getProjectAgentExecutions().length, before);
    const restartedServer = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'journal-sync-restarted', onCommand: () => ({ status: 'running' }), onData: operations });
    serverOpen = true;
    const restartedEngine = new SyncEngine(path.join(solopreneur, 'roadmap.csv'), path.join(solopreneur, 'project_journal.db'), path.resolve(__dirname, '..'), root);
    await restartedEngine.initAndSync();
    assert.equal(restartedEngine.getProjectAgentExecutions().length, 511);
    assert.equal(restartedEngine.getProjectAgentExecutions().some(entry => entry.output === 'must not appear'), false);
    restartedEngine.close();
    await restartedServer.close(); serverOpen = false;
  } finally { if (serverOpen) await server.close(); await operations.close(); store.close(); }
});

test('plugin restart reads legacy history immediately while its database migration is still queued', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-journal-restart-migration-'));
  const root = path.join(fixture, '.solomap-global'); const project = path.join(fixture, 'project'); const solopreneur = path.join(project, '.solopreneur');
  fs.mkdirSync(solopreneur, { recursive: true });
  fs.writeFileSync(path.join(solopreneur, 'roadmap.csv'), 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,Plan,,Stage,,codex,,Pending,2026-01-01T00:00:00.000Z,');
  const journal = new (require('../out/db/sqliteStore.js').SqliteStore)(path.join(solopreneur, 'project_journal.db'), path.resolve(__dirname, '..'));
  await journal.init(); const legacyId = journal.logExecution('step', 'codex', 'resume', 'legacy running task', 'Running'); journal.close();
  const store = new UnifiedDataStore(root); const operations = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'journal-restart-owner', onCommand: () => ({ status: 'running' }), onData: operations });
  try {
    const engine = new SyncEngine(path.join(solopreneur, 'roadmap.csv'), path.join(solopreneur, 'project_journal.db'), path.resolve(__dirname, '..'), root);
    await engine.initAndSync();
    assert.equal(engine.getAgentExecutions('step').find(entry => entry.id === legacyId)?.output, 'legacy running task');
    const newId = await engine.logAgentExecution('step', 'codex', 'new', 'new run during migration', 'Running');
    assert.equal(newId, legacyId + 1);
    await operations({ operation: 'import_project_data', input: { collection: 'project-journal', sourceRoot: path.join(solopreneur, 'project_journal.db'), projectRoot: project, idempotencyKey: 'restart-race' } });
    await operations.waitForMigrations();
    const history = await operations({ operation: 'read_project_journal', input: { root: project, limit: 10 } });
    assert.deepEqual(history.logs.map(entry => entry.output), ['new run during migration', 'legacy running task']);
  } finally { await server.close(); await operations.close(); store.close(); }
});

test('completed run artifacts are content-addressed in the global database', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-run-artifact-')), '.solomap-global');
  const project = path.join(path.dirname(root), 'project');
  fs.mkdirSync(project); fs.mkdirSync(root);
  const store = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(store);
  try {
    const content = Buffer.from('the final task report');
    await operations({ operation: 'write_run_artifact', input: { root: project, executionLogId: 41, relativePath: 'task-report.json', mimeType: 'application/json', bytes: content.toString('base64'), hash: require('node:crypto').createHash('sha256').update(content).digest('hex') } });
    const artifact = await operations({ operation: 'read_run_artifact', input: { root: project, executionLogId: 41, relativePath: 'task-report.json' } });
    assert.equal(Buffer.from(artifact.bytes, 'base64').toString(), content.toString());
  } finally { await operations.close(); store.close(); }
});

test('legacy project data migrates in the background while live-consumer run files stay local', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-project-data-migration-'));
  const root = path.join(fixture, '.solomap-global'); const project = path.join(fixture, 'project');
  const journalPath = path.join(project, '.solopreneur', 'project_journal.db'); const runsRoot = path.join(project, '.solopreneur', 'agent-runs');
  fs.mkdirSync(runsRoot, { recursive: true }); fs.mkdirSync(root);
  const { SqliteStore } = require('../out/db/sqliteStore.js'); const journal = new SqliteStore(journalPath, path.resolve(__dirname, '..'));
  await journal.init(); const executionLogId = journal.logExecution('step', 'codex', 'run', 'legacy output', 'Processed'); journal.close();
  const artifact = path.join(runsRoot, '1', String(executionLogId), 'task-report.json'); fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, '{"summary":"done"}');
  const recyclableArtifact = path.join(path.dirname(artifact), 'output.log'); fs.writeFileSync(recyclableArtifact, 'archived output');
  const store = new UnifiedDataStore(root); const operations = createRuntimeDataOperations(store);
  try {
    await operations({ operation: 'import_project_data', input: { collection: 'project-journal', sourceRoot: journalPath, projectRoot: project, idempotencyKey: 'journal' } });
    await operations({ operation: 'import_project_data', input: { collection: 'agent-runs', sourceRoot: runsRoot, projectRoot: project, idempotencyKey: 'runs' } });
    await operations.waitForMigrations();
    const history = await operations({ operation: 'read_project_journal', input: { root: project, nodeId: 'step' } });
    assert.equal(history.logs[0].output, 'legacy output');
    const archived = await operations({ operation: 'read_run_artifact', input: { root: project, executionLogId, relativePath: path.join('1', String(executionLogId), 'task-report.json') } });
    assert.equal(Buffer.from(archived.bytes, 'base64').toString(), '{"summary":"done"}');
    const overview = await operations({ operation: 'migration_overview', input: {} });
    assert.equal(overview.jobs.filter(job => ['project-journal', 'agent-runs'].includes(job.args.collection)).every(job => job.status === 'completed'), true);
    assert.equal(overview.recyclableFiles, 1);
    assert.equal(fs.existsSync(journalPath), true); assert.equal(fs.existsSync(artifact), true);
    const plan = await operations({ operation: 'prepare_recycling', input: {} });
    assert.deepEqual(plan.files.map(file => path.basename(file.path)), ['project_journal.db']);
    assert.equal(plan.files.some(file => file.path === artifact), false, 'task reports remain available to live consumers');
    const journalItem = plan.files.find(file => file.path === journalPath);
    await operations({ operation: 'confirm_recycling', input: { planId: plan.planId } });
    await operations({ operation: 'hold_recycling_file', input: { itemId: journalItem.itemId } });
    await operations({ operation: 'retire_recycling_file', input: { itemId: journalItem.itemId } });
    assert.equal(fs.existsSync(journalPath), false);
    await operations({ operation: 'restore_recycling_file', input: { itemId: journalItem.itemId } });
    assert.equal(fs.existsSync(journalPath), true);
  } finally { await operations.close(); store.close(); }
});
