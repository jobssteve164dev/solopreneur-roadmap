const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

function cleanupExact(root) {
  let stat;
  try { stat = fs.lstatSync(root); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) { fs.unlinkSync(root); return; }
  for (const name of fs.readdirSync(root)) cleanupExact(path.join(root, name));
  fs.rmdirSync(root);
}

const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { importLegacyIntelligenceConversation } = require('../out/intelligenceConversationData.js');
const { sendRuntimeControlCommand, sendRuntimeDataRequest } = require('../out/autonomousRuntimeControl.js');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-migration-agent-'));
  t.after(() => cleanupExact(base));
  const root = path.join(base, '.solomap-global');
  const store = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(store);
  return { base, root, store, operations, call: (operation, input = {}) => operations({ operation, input }) };
}

async function formalMigrationSession(f, kind, executionLogId = 1, targetId, projectRoot) {
  const project = path.join(f.base, 'project');
  fs.mkdirSync(project, { recursive: true });
  const run = await f.call('prepare_run', {
    root: project, executionLogId, nodeId: '__solo__', runKind: kind,
    prompt: 'migration task', command: 'codex', userMessage: 'migration task', status: 'Running',
    metadata: { ...(targetId ? { migrationTargetId: targetId } : {}), ...(projectRoot ? { migrationProjectRoot: projectRoot } : {}) },
    idempotencyKey: `shared-migration-run:${executionLogId}`
  });
  const session = await f.call('open_mcp_session', {
    projectId: run.projectId,
    runIdentity: { executionLogId, generation: run.generation, proof: run.proof }
  });
  return { project, run, session };
}

test('a project-scoped migration discovers, reports, retries, and previews only that physical project', async t => {
  const f = fixture(t);
  try {
    const projectA = path.join(f.base, 'project');
    const projectB = path.join(f.base, 'project-b');
    for (const root of [projectA, projectB]) {
      fs.mkdirSync(path.join(root, '.solopreneur'), { recursive: true });
      fs.writeFileSync(path.join(root, '.solopreneur', 'documentation.json'), JSON.stringify({ schemaVersion: 1, files: [] }));
      await f.store.registerProject({ root });
    }
    const migration = await formalMigrationSession(f, 'migration_apply', 1, undefined, projectA);
    await f.operations({ operation: 'discover_migrations', input: { projectRoot: projectA }, sessionToken: migration.session.sessionToken });
    await f.operations.waitForMigrations();
    const overview = await f.operations({ operation: 'migration_overview', input: { projectRoot: projectA }, sessionToken: migration.session.sessionToken });
    assert.ok(overview.jobs.length > 0);
    assert.ok(overview.jobs.every(job => path.resolve(job.args.projectRoot) === path.resolve(projectA)));
    await assert.rejects(f.operations({ operation: 'migration_overview', input: { projectRoot: projectB }, sessionToken: migration.session.sessionToken }), /maintenance_scope_denied/);
    const foreign = f.store.enqueueMemoryMigration({ collection: 'documentation', sourceRoot: path.join(projectB, '.solopreneur', 'documentation.json'), projectRoot: projectB }, 'foreign-project');
    f.store.updateMigrationJob(foreign.jobId, 'failed', {}, 'fixture');
    await assert.rejects(f.operations({ operation: 'migration_status', input: { jobId: foreign.jobId, projectRoot: projectA }, sessionToken: migration.session.sessionToken }), /maintenance_scope_denied/);
    await assert.rejects(f.operations({ operation: 'retry_migration', input: { jobId: foreign.jobId, projectRoot: projectA }, sessionToken: migration.session.sessionToken }), /maintenance_scope_denied/);

    for (const [root, body] of [[projectA, Buffer.from('project-a')], [projectB, Buffer.from('project-b')]]) {
      const file = path.join(root, '.solopreneur', 'project_growth.db');
      fs.writeFileSync(file, body);
      const identity = `project-growth:${root}`;
      const hash = crypto.createHash('sha256').update(body).digest('hex');
      f.store.captureMigrationSource({ identity, key: 'project_growth.db', hash }, body, { mimeType: 'application/x-sqlite3', encoding: 'binary' });
      f.store.markMigrationSourceImported(identity, 'project_growth.db');
    }
    const mixedPlan = await f.call('prepare_recycling');
    assert.equal(mixedPlan.files.length, 3);
    const ready = await f.operations({ operation: 'migration_overview', input: { projectRoot: projectA }, sessionToken: migration.session.sessionToken });
    assert.equal(ready.reviewableFiles, 1, 'an unconfirmed cross-project plan cannot hide this project from its own review');
    const plan = await f.operations({ operation: 'prepare_recycling', input: { projectRoot: projectA }, sessionToken: migration.session.sessionToken });
    assert.deepEqual(plan.files.map(file => file.path).sort(), [
      path.join(projectA, '.solopreneur', 'documentation.json'),
      path.join(projectA, '.solopreneur', 'project_growth.db')
    ].sort());
    assert.notEqual(plan.planId, mixedPlan.planId);
    assert.equal((await f.operations({ operation: 'prepare_recycling', input: { projectRoot: projectA }, sessionToken: migration.session.sessionToken })).planId, plan.planId, 'the host must retrieve the exact project plan prepared by the Agent');
    await assert.rejects(f.operations({ operation: 'read_recycling_plan', input: { planId: plan.planId, projectRoot: projectB }, sessionToken: migration.session.sessionToken }), /maintenance_scope_denied/);
    const foreignItem = mixedPlan.files.find(file => file.path === path.join(projectB, '.solopreneur', 'project_growth.db'));
    assert.ok(foreignItem);
    await assert.rejects(f.call('restore_recycling_file', { itemId: foreignItem.itemId, projectRoot: projectA }), /maintenance_scope_denied/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('a formal migration session rejects project metadata that does not belong to its run', async t => {
  const f = fixture(t);
  try {
    const projectA = path.join(f.base, 'project');
    const projectB = path.join(f.base, 'project-b');
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });
    await f.store.registerProject({ root: projectB });
    const run = await f.call('prepare_run', {
      root: projectA, executionLogId: 1, nodeId: '__solo__', runKind: 'migration_apply',
      prompt: 'migration task', command: 'codex', userMessage: 'migration task', status: 'Running',
      metadata: { migrationProjectRoot: projectB }, idempotencyKey: 'wrong-project-metadata'
    });
    await assert.rejects(f.call('open_mcp_session', { projectId: run.projectId, runIdentity: { executionLogId: 1, generation: run.generation, proof: run.proof } }), /maintenance_scope_denied/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('a project-scoped migration session rejects a symlink retargeted after authorization', async t => {
  const f = fixture(t);
  try {
    const projectA = path.join(f.base, 'project-a');
    const projectB = path.join(f.base, 'project-b');
    const alias = path.join(f.base, 'selected-project');
    fs.mkdirSync(projectA);
    fs.mkdirSync(projectB);
    fs.symlinkSync(projectA, alias, 'dir');
    const identityA = await f.store.registerProject({ root: projectA });
    await f.store.registerProject({ root: projectB });
    const run = f.store.prepareRun(identityA.projectId, identityA.locationId, {
      root: projectA, executionLogId: 1, nodeId: '__solo__', runKind: 'migration_apply',
      prompt: 'migration task', command: 'codex', userMessage: 'migration task',
      metadata: { migrationProjectRoot: alias }, idempotencyKey: 'symlink-scope'
    });
    const session = await f.call('open_mcp_session', {
      projectId: identityA.projectId,
      runIdentity: { executionLogId: 1, generation: run.generation, proof: run.proof }
    });
    fs.unlinkSync(alias);
    fs.symlinkSync(projectB, alias, 'dir');
    await assert.rejects(f.operations({ operation: 'migration_overview', input: { projectRoot: alias }, sessionToken: session.sessionToken }), /maintenance_scope_denied/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('an ordinary Solo migration session rejects its registered project path after physical replacement', async t => {
  const f = fixture(t);
  try {
    const projectA = path.join(f.base, 'project-a');
    const originalA = path.join(f.base, 'project-a-original');
    const projectB = path.join(f.base, 'project-b');
    fs.mkdirSync(projectA);
    fs.mkdirSync(projectB);
    const run = await f.call('prepare_run', {
      root: projectA, executionLogId: 1, nodeId: '__solo__', runKind: 'solo',
      prompt: 'task', command: 'codex', userMessage: 'task', status: 'Running', idempotencyKey: 'ordinary-physical-scope'
    });
    const session = await f.call('open_mcp_session', {
      projectId: run.projectId,
      runIdentity: { executionLogId: 1, generation: run.generation, proof: run.proof }
    });
    fs.renameSync(projectA, originalA);
    fs.symlinkSync(projectB, projectA, 'dir');
    await assert.rejects(f.operations({ operation: 'migration_overview', input: { projectRoot: projectA }, sessionToken: session.sessionToken }), /maintenance_scope_denied/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('scoped maintenance history uses immutable project identity after metadata paths change', async t => {
  const f = fixture(t);
  try {
    const projectA = path.join(f.base, 'project-a');
    const projectB = path.join(f.base, 'project-b');
    const alias = path.join(f.base, 'selected-project');
    fs.mkdirSync(projectA);
    fs.mkdirSync(projectB);
    fs.symlinkSync(projectA, alias, 'dir');
    const identityA = await f.store.registerProject({ root: projectA });
    const identityB = await f.store.registerProject({ root: projectB });
    const runA = f.store.prepareRun(identityA.projectId, identityA.locationId, {
      root: projectA, executionLogId: 1, nodeId: '__solo__', runKind: 'migration_review',
      prompt: 'review a', command: 'codex', userMessage: 'review a',
      metadata: { migrationProjectRoot: alias }, idempotencyKey: 'history-a'
    });
    const runB = f.store.prepareRun(identityB.projectId, identityB.locationId, {
      root: projectB, executionLogId: 2, nodeId: '__solo__', runKind: 'migration_review',
      prompt: 'review b', command: 'codex', userMessage: 'review b', metadata: {}, idempotencyKey: 'history-b'
    });
    fs.unlinkSync(alias);
    fs.symlinkSync(projectB, alias, 'dir');
    const overviewA = await f.call('migration_overview', { projectRoot: projectA });
    const overviewB = await f.call('migration_overview', { projectRoot: projectB });
    assert.ok(overviewA.maintenanceTasks.some(task => task.taskId === runA.taskId));
    assert.ok(!overviewA.maintenanceTasks.some(task => task.taskId === runB.taskId));
    assert.ok(overviewB.maintenanceTasks.some(task => task.taskId === runB.taskId));
    assert.ok(!overviewB.maintenanceTasks.some(task => task.taskId === runA.taskId));
  } finally { await f.operations.close(); f.store.close(); }
});

test('an ordinary Solo run can migrate and prepare an exact recycling preview but cannot apply it', async t => {
  const f = fixture(t);
  try {
    const migration = await formalMigrationSession(f, 'migration_apply');
    assert.ok(Array.isArray((await f.operations({ operation: 'migration_overview', input: {}, sessionToken: migration.session.sessionToken })).jobs));
    assert.deepEqual(await f.operations({ operation: 'prepare_recycling', input: {}, sessionToken: migration.session.sessionToken }), { planId: null, files: [] });
    const ordinary = await f.call('prepare_run', {
      root: migration.project, executionLogId: 2, nodeId: '__solo__', runKind: 'solo',
      prompt: 'task', command: 'codex', userMessage: 'task', status: 'Running', idempotencyKey: 'ordinary-run'
    });
    const ordinarySession = await f.call('open_mcp_session', {
      projectId: ordinary.projectId,
      runIdentity: { executionLogId: 2, generation: ordinary.generation, proof: ordinary.proof }
    });
    assert.ok(Array.isArray((await f.operations({ operation: 'migration_overview', input: { projectRoot: migration.project }, sessionToken: ordinarySession.sessionToken })).jobs));
    const legacy = path.join(migration.project, '.solopreneur', 'project_growth.db');
    const bytes = Buffer.from('registered legacy project growth');
    fs.writeFileSync(legacy, bytes);
    const identity = `project-growth:${migration.project}`;
    f.store.captureMigrationSource({ identity, key: 'project_growth.db', hash: crypto.createHash('sha256').update(bytes).digest('hex') }, bytes);
    f.store.markMigrationSourceImported(identity, 'project_growth.db');
    const preview = await f.operations({ operation: 'prepare_recycling', input: { projectRoot: migration.project }, sessionToken: ordinarySession.sessionToken });
    assert.deepEqual(preview.files.map(file => file.path), [legacy]);
    assert.equal(preview.files[0].bytes, bytes.length);
    await assert.rejects(f.operations({ operation: 'migration_overview', input: {}, sessionToken: ordinarySession.sessionToken }), /project_scope_required/);
    await assert.rejects(f.operations({ operation: 'discard_recycling_plan', input: { planId: preview.planId }, sessionToken: ordinarySession.sessionToken }), /action_denied/);
    await assert.rejects(f.operations({ operation: 'execute_recycling_plan', input: { planId: preview.planId, projectRoot: migration.project }, sessionToken: ordinarySession.sessionToken }), /action_denied/);
    await f.call('claim_run', { projectId: ordinary.projectId, executionLogId: 2, expectedRevision: ordinary.revision, idempotencyKey: 'replacement-ordinary-owner' });
    await assert.rejects(f.operations({ operation: 'migration_overview', input: { projectRoot: migration.project }, sessionToken: ordinarySession.sessionToken }), /run_owner_conflict/);

    for (const [executionLogId, runKind] of [[3, 'step'], [4, 'skill_install'], [5, 'agent_review']]) {
      const run = await f.call('prepare_run', {
        root: migration.project, executionLogId, nodeId: runKind === 'step' ? 'step-one' : '__solo__', runKind,
        prompt: runKind, command: 'codex', userMessage: runKind, status: 'Running', idempotencyKey: `non-solo-run:${runKind}`
      });
      const session = await f.call('open_mcp_session', {
        projectId: run.projectId,
        runIdentity: { executionLogId, generation: run.generation, proof: run.proof }
      });
      await assert.rejects(f.operations({ operation: 'migration_overview', input: { projectRoot: migration.project }, sessionToken: session.sessionToken }), /action_denied/);
    }
  } finally { await f.operations.close(); f.store.close(); }
});

test('migration overview projects formal shared-runner activity without a second maintenance lifecycle', async t => {
  const f = fixture(t);
  try {
    const { run } = await formalMigrationSession(f, 'recycling_apply', 1, 'confirmed-plan');
    const overview = await f.call('migration_overview');
    assert.ok(overview.maintenanceTasks.some(task => task.taskId === run.taskId && task.kind === 'recycling_apply' && task.targetId === 'confirmed-plan'));
    assert.ok(overview.activeMaintenanceTaskIds.includes(run.taskId));
    assert.deepEqual(overview.launchingMaintenanceTaskIds, []);
  } finally { await f.operations.close(); f.store.close(); }
});

test('legacy maintenance rows remain inert history and cannot enter the current migration overview', async t => {
  const f = fixture(t);
  try {
    const now = Date.now();
    f.store.db.run('INSERT INTO maintenance_tasks VALUES(?,?,?,?,?,?,?,?)', ['legacy-ready', 'migration_review', null, 'ready', null, now, now, now + 60_000]);
    const overview = await f.call('migration_overview');
    assert.ok(!overview.maintenanceTasks.some(task => task.taskId === 'legacy-ready'));
    assert.ok(!overview.activeMaintenanceTaskIds.includes('legacy-ready'));
  } finally { await f.operations.close(); f.store.close(); }
});

test('two project windows on one data root atomically reuse one active shared migration run', async t => {
  const f = fixture(t);
  try {
    const { prepareAgentRun } = require('../out/agentRunPreparation.js');
    const projectA = path.join(f.base, 'project-a');
    const projectB = path.join(f.base, 'project-b');
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });
    const input = {
      globalDataPath: f.root, agentCli: 'codex', selectedModel: '',
      nodeId: '__solo__', executionLogId: 0, runKind: 'migration_review',
      userMessage: '检查旧数据迁移状态。', prompt: 'use shared migration tools', taskPermissionMode: 'auto',
      launchSlotId: 'settings:migration_review:all', launchSlotScope: 'global', metadata: { migrationTargetId: '' }
    };
    const [left, right] = await Promise.all([
      prepareAgentRun({ ...input, workspaceRoot: projectA }, f.call),
      prepareAgentRun({ ...input, workspaceRoot: projectB }, f.call)
    ]);
    assert.equal(left.runId, right.runId);
    assert.equal(left.status.rootExecutionLogId, right.status.rootExecutionLogId);
    const overview = await f.call('migration_overview');
    assert.equal(overview.maintenanceTasks.filter(task => task.kind === 'migration_review' && ['ready', 'running'].includes(task.status)).length, 1);
    f.store.db.run("UPDATE runs SET status='Completed',finished_at=? WHERE id=?", [Date.now(), left.runId]);
    const next = await prepareAgentRun({ ...input, workspaceRoot: projectB }, f.call);
    assert.notEqual(next.runId, left.runId, 'a completed shared run must not prevent a later user retry');
  } finally { await f.operations.close(); f.store.close(); }
});

test('formal migration runs read complete retained source details while sessions without a run identity remain denied', async t => {
  const f = fixture(t);
  try {
    const progress = { retainedFiles: ['first.md', 'last.md'], conflicts: [{ source: 'last.md', error: 'project_scope_mapping_required' }] };
    const job = f.store.enqueueMemoryMigration({ sourceRoot: path.join(f.root, 'memory') }, 'detail');
    f.store.updateMigrationJob(job.jobId, 'completed_with_conflicts', progress);
    const migration = await formalMigrationSession(f, 'migration_review');
    const detail = await f.operations({ operation: 'migration_status', input: { jobId: job.jobId }, sessionToken: migration.session.sessionToken });
    assert.deepEqual(detail.progress, progress);
    const ordinary = await f.call('open_mcp_session', { projectId: migration.run.projectId });
    await assert.rejects(f.operations({ operation: 'migration_status', input: { jobId: job.jobId }, sessionToken: ordinary.sessionToken }), /action_denied/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('a recycling run is locked to the exact host-confirmed plan and resumes remaining files', async t => {
  const f = fixture(t);
  try {
    for (const [id, title] of [['047c4416-2fbe-4562-b9b9-29e9e6d536be', 'First'], ['147c4416-2fbe-4562-b9b9-29e9e6d536be', 'Second']]) {
      const file = path.join(f.root, 'intelligence-conversations', `${id}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ id, title, createdAt: '2026-09-22T08:00:00.000Z', updatedAt: '2026-09-22T08:01:00.000Z', messages: [{ role: 'user', content: title }] }));
      await importLegacyIntelligenceConversation(f.store, file);
    }
    const plan = await f.call('prepare_recycling');
    await f.call('confirm_recycling', { planId: plan.planId });
    const migration = await formalMigrationSession(f, 'recycling_apply', 1, plan.planId);
    await assert.rejects(f.operations({ operation: 'execute_recycling_plan', input: { planId: 'different-plan' }, sessionToken: migration.session.sessionToken }), /maintenance_target_denied/);
    const first = await f.call('hold_recycling_file', { itemId: plan.files[0].itemId });
    await f.call('retire_recycling_file', { itemId: plan.files[0].itemId });
    assert.equal(fs.existsSync(first.path), false);
    const result = await f.operations({ operation: 'execute_recycling_plan', input: { planId: plan.planId }, sessionToken: migration.session.sessionToken });
    assert.equal(result.recycledFiles, 2);
  } finally { await f.operations.close(); f.store.close(); }
});

test('migration prompt supplies tools without defining a private runtime or result lifecycle', () => {
  const { buildMigrationMaintenancePrompt } = require('../out/migrationAgentMaintenance.js');
  const review = buildMigrationMaintenancePrompt('migration_review');
  for (const name of ['solomap_migration_status', 'solomap_migration_retry', 'solomap_recycling_preview']) assert.match(review, new RegExp(name));
  for (const implementation of ['solomap_maintenance_finish', 'SOLOMAP_MAINTENANCE_', 'sandbox', 'result.json', 'Claude']) assert.doesNotMatch(review, new RegExp(implementation, 'i'));
  const apply = buildMigrationMaintenancePrompt('migration_apply');
  assert.match(apply, /solomap_migration_start/);
  assert.match(apply, /solomap_migration_status/);
  const scoped = buildMigrationMaintenancePrompt('migration_apply', '', '/workspace/packer');
  assert.match(scoped, /projectRoot="\/workspace\/packer"/);
  assert.match(scoped, /不得读取或处理其他项目/);
  assert.match(apply, /单次工具失败不代表迁移失败/);
  assert.match(apply, /重新调用 solomap_migration_status/);
  assert.match(apply, /状态读取连续 3 次无法建立/);
  assert.match(apply, /连续 3 次/);
  assert.match(apply, /不得宣称迁移失败/);
  assert.match(apply, /queued 或 running/);
  assert.match(apply, /继续等待并查询/);
  assert.match(apply, /completed_with_conflicts 不得原样重试/);
  assert.match(apply, /继续处理其他任务并生成当前安全回收清单/);
  assert.doesNotMatch(apply, /工具失败时[^。]*停止/);
});

test('external Agent CLI receives migration tools from the ordinary managed MCP bridge', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-migration-stdio-'));
  t.after(() => cleanupExact(base));
  const root = path.join(base, '.solomap-global');
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  const seed = new UnifiedDataStore(root);
  const identity = await seed.registerProject({ root: project });
  const retainedFiles = Array.from({ length: 500 }, (_, index) => `history/${index}.log`);
  const conflicts = Array.from({ length: 500 }, (_, index) => ({ source: `history/${index}.log`, error: 'migration_source_changed' }));
  const job = seed.enqueueMemoryMigration({ collection: 'documentation', sourceRoot: path.join(project, '.solopreneur', 'documentation.json'), projectRoot: project }, 'stdio-detail');
  seed.updateMigrationJob(job.jobId, 'completed_with_conflicts', { retainedFiles, conflicts, imported: 500 });
  const prepared = seed.prepareRun(identity.projectId, identity.locationId, {
    root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'migration_apply', prompt: 'migrate', command: 'codex',
    userMessage: 'migrate', metadata: { migrationProjectRoot: project }, idempotencyKey: 'stdio-migration-run'
  });
  seed.close();
  const runtime = spawn(process.execPath, [path.resolve(__dirname, '../out/autonomousRuntimeProcess.js'), '--global-data-path', root, '--runtime-id', 'migration-owner'], { stdio: 'pipe' });
  let stderr = '';
  runtime.stderr.on('data', chunk => { stderr += chunk; });
  runtime.stdout.resume();
  let client;
  let transport;
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(path.join(root, 'runtime/control.json'))) {
      assert.equal(runtime.exitCode, null, stderr);
      assert.ok(Date.now() < deadline, stderr || 'runtime did not start');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const state = await sendRuntimeDataRequest(root, { operation: 'read_run_checkpoint_state', input: { projectId: identity.projectId, executionLogId: 1 } });
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const { databaseBridgeLauncher } = require('../out/agentDatabaseConfig.js');
    client = new Client({ name: 'migration-agent', version: '1' });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['-e', databaseBridgeLauncher(), root],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SOLOMAP_PROJECT_ID: identity.projectId, SOLOMAP_EXECUTION_LOG_ID: '1', SOLOMAP_RUN_GENERATION: String(prepared.generation), SOLOMAP_RUN_PROOF: state.proof, SOLOMAP_RUN_KIND: 'migration_apply' },
      cwd: project, stderr: 'pipe'
    });
    await client.connect(transport);
    const listedTools = (await client.listTools()).tools;
    const names = listedTools.map(tool => tool.name).sort();
    assert.deepEqual(names, ['solomap_context', 'solomap_migration_retry', 'solomap_migration_start', 'solomap_migration_status', 'solomap_read', 'solomap_recycling_apply', 'solomap_recycling_preview', 'solomap_search']);
    assert.ok(listedTools.filter(tool => tool.name.startsWith('solomap_migration_') || tool.name.startsWith('solomap_recycling_')).every(tool => tool.inputSchema.properties.projectRoot), 'every migration tool must carry the explicit project boundary');
    for (const name of ['solomap_write', 'solomap_link', 'solomap_export']) assert.ok(!names.includes(name));
    const context = await client.callTool({ name: 'solomap_context', arguments: { project: identity.projectId, query: 'migration' } });
    assert.equal(context.isError, undefined, JSON.stringify(context.content));
    const overview = await client.callTool({ name: 'solomap_migration_status', arguments: { projectRoot: project } });
    assert.equal(overview.isError, undefined, JSON.stringify(overview.content));
    const summary = JSON.parse(overview.content[0].text);
    assert.equal(summary.jobs[0].progress.conflictCount, conflicts.length);
    assert.equal(summary.jobs[0].progress.retainedFileCount, retainedFiles.length);
    assert.equal(summary.jobs[0].progress.conflicts, undefined, 'the Agent overview must stay compact and use jobId for complete conflict details');
    assert.ok(Buffer.byteLength(overview.content[0].text) < 50000);
    const status = await client.callTool({ name: 'solomap_migration_status', arguments: { jobId: job.jobId, projectRoot: project } });
    assert.equal(status.isError, undefined, JSON.stringify(status.content));
    assert.deepEqual(JSON.parse(status.content[0].text).progress.retainedFiles, retainedFiles);
    assert.deepEqual(JSON.parse(status.content[0].text).progress.conflicts, conflicts);
    const preview = await client.callTool({ name: 'solomap_recycling_preview', arguments: { projectRoot: project } });
    assert.equal(preview.isError, undefined, JSON.stringify(preview.content));
    assert.deepEqual(JSON.parse(preview.content[0].text), { planId: null, files: [] });
  } finally {
    if (client) await client.close();
    if (transport) await transport.close();
    if (runtime.exitCode === null) {
      const exited = once(runtime, 'exit');
      await sendRuntimeControlCommand(root, 'stop');
      await exited;
    }
  }
});
