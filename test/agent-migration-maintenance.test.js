const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');

const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { importLegacyIntelligenceConversation } = require('../out/intelligenceConversationData.js');
const { readMaintenanceRuntimeEndpoint, sendRuntimeControlCommand, sendRuntimeDataRequest, sendRuntimeMaintenanceRequest } = require('../out/autonomousRuntimeControl.js');

function fixture() {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-maintenance-')), '.solomap-global');
  const store = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(store);
  return { root, store, operations, call: (operation, input = {}) => operations({ operation, input }) };
}

test('maintenance credentials persist across Runtime restarts and ordinary project sessions stay denied', async () => {
  const f = fixture();
  let reopened;
  try {
    const created = await f.call('create_maintenance_task', { kind: 'migration_review' });
    const session = await f.call('open_maintenance_mcp_session', created);
    const overview = await f.operations({ operation: 'migration_overview', input: {}, sessionToken: session.sessionToken });
    assert.ok(Array.isArray(overview.jobs));

    const project = await f.call('register_project', { root: path.dirname(f.root) });
    const ordinary = await f.call('open_mcp_session', { projectId: project.projectId });
    await assert.rejects(f.operations({ operation: 'migration_overview', input: {}, sessionToken: ordinary.sessionToken }), /action_denied/);

    await f.operations.close(); f.store.close();
    reopened = UnifiedDataStore.open(f.root);
    const next = createRuntimeDataOperations(reopened);
    const resumed = await next({ operation: 'claim_maintenance_task', input: { taskId: created.taskId } });
    assert.equal(resumed.taskId, created.taskId);
    const nextSession = await next({ operation: 'open_maintenance_mcp_session', input: resumed });
    assert.ok(await next({ operation: 'migration_overview', input: {}, sessionToken: nextSession.sessionToken }));
    await next({ operation: 'complete_maintenance_task', input: {}, sessionToken: nextSession.sessionToken });
    const completed = await next({ operation: 'maintenance_task_status', input: { taskId: created.taskId } });
    assert.equal(completed.status, 'completed');
    await assert.rejects(next({ operation: 'migration_overview', input: {}, sessionToken: nextSession.sessionToken }), /(?:maintenance_task_inactive|mcp_session_expired)/);
    await next.close();
  } finally {
    if (reopened) reopened.close();
    else { await f.operations.close(); f.store.close(); }
  }
});

test('only one active maintenance task can own the same action target', async () => {
  const f = fixture();
  try {
    await f.call('create_maintenance_task', { kind: 'migration_review' });
    await assert.rejects(f.call('create_maintenance_task', { kind: 'migration_review' }), /maintenance_task_in_use/);
  } finally { await f.operations.close(); f.store.close(); }
});

test('a maintenance launch can be claimed after Runtime restart but not twice', async () => {
  const f = fixture();
  let reopened;
  try {
    const created = await f.call('create_maintenance_task', { kind: 'migration_review' });
    await f.operations.close(); f.store.close();
    reopened = UnifiedDataStore.open(f.root);
    const next = createRuntimeDataOperations(reopened);
    const claimed = await next({ operation: 'claim_maintenance_task', input: { taskId: created.taskId } });
    assert.equal(claimed.taskId, created.taskId);
    await assert.rejects(next({ operation: 'claim_maintenance_task', input: { taskId: created.taskId } }), /maintenance_task_in_use/);
    await assert.rejects(next({ operation: 'open_maintenance_mcp_session', input: created }), /maintenance_launch_denied/);
    const session = await next({ operation: 'open_maintenance_mcp_session', input: claimed });
    assert.ok(session.sessionToken);
    await next.close();
  } finally { if (reopened) reopened.close(); else { await f.operations.close(); f.store.close(); } }
});

test('a maintenance launch remains usable while an Agent CLI is still starting', async () => {
  const f = fixture();
  const realNow = Date.now;
  try {
    const created = await f.call('create_maintenance_task', { kind: 'migration_review' });
    Date.now = () => realNow() + 2 * 60_000;
    const session = await f.call('open_maintenance_mcp_session', created);
    assert.ok(session.sessionToken);
  } finally {
    Date.now = realNow;
    await f.operations.close(); f.store.close();
  }
});

test('migration overview always includes active maintenance tasks beyond history pagination', async () => {
  const f = fixture();
  try {
    const active = await f.call('create_maintenance_task', { kind: 'migration_review' });
    const now = Date.now();
    for (let index = 0; index < 12; index += 1) {
      f.store.db.run('INSERT INTO maintenance_tasks VALUES(?,?,?,?,?,?,?,?)', [
        `history-${String(index).padStart(2, '0')}`, 'migration_review', null, 'completed', null,
        now + index + 1, now + index + 1, now + 7 * 24 * 60 * 60 * 1000
      ]);
    }
    const overview = await f.call('migration_overview');
    assert.ok(overview.maintenanceTasks.some(task => task.taskId === active.taskId));
    assert.equal(overview.maintenanceTasks.filter(task => task.status === 'completed').length, 10);
  } finally { await f.operations.close(); f.store.close(); }
});

test('recycling maintenance is locked to the exact host-confirmed plan', async () => {
  const f = fixture();
  try {
    const id = '047c4416-2fbe-4562-b9b9-29e9e6d536be';
    const file = path.join(f.root, 'intelligence-conversations', id + '.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ id, title: 'Old chat', createdAt: '2026-09-22T08:00:00.000Z', updatedAt: '2026-09-22T08:01:00.000Z', messages: [{ role: 'user', content: 'Old content' }] }));
    await importLegacyIntelligenceConversation(f.store, file);
    const plan = await f.call('prepare_recycling');
    await assert.rejects(f.call('create_maintenance_task', { kind: 'recycling_apply', targetId: plan.planId }), /maintenance_target_unconfirmed/);
    await f.call('confirm_recycling', { planId: plan.planId });
    const overview = await f.call('migration_overview');
    assert.equal(overview.recycling[0].planId, plan.planId);
    const task = await f.call('create_maintenance_task', { kind: 'recycling_apply', targetId: plan.planId });
    const session = await f.call('open_maintenance_mcp_session', task);
    await assert.rejects(f.call('open_maintenance_mcp_session', task), /maintenance_task_in_use/);
    await assert.rejects(
      f.operations({ operation: 'execute_recycling_plan', input: { planId: 'plan-b' }, sessionToken: session.sessionToken }),
      /maintenance_target_denied/
    );
  } finally { await f.operations.close(); f.store.close(); }
});

test('a recycling Agent resumes the remaining exact files after Runtime interruption', async () => {
  const f = fixture();
  try {
    for (const [id, title] of [['047c4416-2fbe-4562-b9b9-29e9e6d536be', 'First'], ['147c4416-2fbe-4562-b9b9-29e9e6d536be', 'Second']]) {
      const file = path.join(f.root, 'intelligence-conversations', id + '.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ id, title, createdAt: '2026-09-22T08:00:00.000Z', updatedAt: '2026-09-22T08:01:00.000Z', messages: [{ role: 'user', content: title }] }));
      await importLegacyIntelligenceConversation(f.store, file);
    }
    const plan = await f.call('prepare_recycling');
    await f.call('confirm_recycling', { planId: plan.planId });
    const task = await f.call('create_maintenance_task', { kind: 'recycling_apply', targetId: plan.planId });
    const first = await f.call('hold_recycling_file', { itemId: plan.files[0].itemId });
    await f.call('retire_recycling_file', { itemId: plan.files[0].itemId });
    assert.equal(fs.existsSync(first.path), false);
    const session = await f.call('open_maintenance_mcp_session', task);
    const result = await f.operations({ operation: 'execute_recycling_plan', input: { planId: plan.planId }, sessionToken: session.sessionToken });
    assert.equal(result.recycledFiles, 2);
  } finally { await f.operations.close(); f.store.close(); }
});

test('Agent migration prompt uses only maintenance MCP tools and keeps its result in the database', () => {
  const { applyNativeMigrationAgentBoundary, buildMigrationMaintenancePrompt, buildMigrationAgentSandboxCommand } = require('../out/migrationAgentMaintenance.js');
  const prompt = buildMigrationMaintenancePrompt('migration_review');
  for (const name of ['solomap_migration_status', 'solomap_migration_retry', 'solomap_recycling_preview', 'solomap_maintenance_finish']) assert.match(prompt, new RegExp(name));
  assert.match(prompt, /不创建结果文件/);
  assert.doesNotMatch(prompt, /sqlite|solomap\.db/i);
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-agent-sandbox-'));
  const configPath = path.join(sandboxRoot, '.codex');
  fs.mkdirSync(configPath);
  const command = buildMigrationAgentSandboxCommand({
    command: "'codex' exec 'prompt'",
    workspacePath: '/isolated/work',
    extensionPath: '/extensions/solomap',
    configPaths: [configPath],
    environment: { HOME: '/home/user', SOLOMAP_MAINTENANCE_RUNTIME_PORT: '43123' }
  });
  assert.match(command, /^'\/usr\/bin\/bwrap'/);
  assert.match(command, /'--clearenv'/);
  assert.match(command, /'--ro-bind' '\/extensions\/solomap' '\/extensions\/solomap'/);
  assert.match(command, new RegExp("'--ro-bind' '" + configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "' '"));
  assert.match(command, /'SOLOMAP_MAINTENANCE_RUNTIME_PORT' '43123'/);
  assert.match(command, /'\/bin\/bash' '-lc'/);
  const inlineMcp = JSON.stringify({ mcpServers: { solomap_data: { command: process.execPath, args: ['bridge'] } } });
  const native = applyNativeMigrationAgentBoundary("'/usr/local/bin/claude' -p 'prompt'", '/usr/local/bin/claude', 'claude', inlineMcp);
  for (const flag of ['--restricted', '--safe-mode', '--strict-mcp-config', '--mcp-config', '--tools']) assert.match(native, new RegExp(flag));
  assert.match(native, /--tools ''/);
  assert.match(native, new RegExp(inlineMcp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.throws(() => applyNativeMigrationAgentBoundary("'/usr/local/bin/agy' --print 'prompt'", '/usr/local/bin/agy', 'antigravity', inlineMcp), /native_boundary_unsupported/);
  assert.throws(() => applyNativeMigrationAgentBoundary("'codex' exec 'prompt'", 'codex', 'codex'), /native_boundary_unsupported/);
});

test('external Agent CLI discovers only authorized maintenance tools through the managed MCP bridge', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-maintenance-stdio-')), '.solomap-global');
  fs.mkdirSync(root);
  new UnifiedDataStore(root).close();
  const runtime = spawn(process.execPath, [path.resolve(__dirname, '../out/autonomousRuntimeProcess.js'), '--global-data-path', root, '--runtime-id', 'maintenance-owner'], { stdio: 'pipe' });
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
    const task = await sendRuntimeDataRequest(root, { operation: 'create_maintenance_task', input: { kind: 'migration_review' } });
    const endpoint = await readMaintenanceRuntimeEndpoint(root);
    const emptyCredentialResponse = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
      let response = '';
      socket.setEncoding('utf8');
      socket.once('connect', () => socket.write(JSON.stringify({ command: 'maintenance_data', expectedRuntimeId: endpoint.runtimeId, taskId: '', proof: '', request: { operation: 'create_maintenance_task', input: { kind: 'migration_review' } } }) + '\n'));
      socket.on('data', chunk => { response += chunk; });
      socket.once('error', reject);
      socket.once('end', () => resolve(JSON.parse(response)));
    });
    assert.equal(emptyCredentialResponse.ok, false);
    assert.match(emptyCredentialResponse.error, /maintenance_transport_denied/);
    await assert.rejects(sendRuntimeMaintenanceRequest(endpoint, task.taskId, task.proof, { operation: 'read', input: { ref: 'solomap://schema' } }), /action_denied/);
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const { databaseBridgeLauncher } = require('../out/agentDatabaseConfig.js');
    client = new Client({ name: 'maintenance-agent', version: '1' });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['-e', databaseBridgeLauncher(), '/not-mounted/.solomap-global'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SOLOMAP_MAINTENANCE_TASK_ID: task.taskId, SOLOMAP_MAINTENANCE_PROOF: task.proof, SOLOMAP_MAINTENANCE_LAUNCH_TOKEN: task.launchToken, SOLOMAP_MAINTENANCE_RUNTIME_ID: endpoint.runtimeId, SOLOMAP_MAINTENANCE_RUNTIME_PORT: String(endpoint.port), SOLOMAP_MAINTENANCE_ENTRY_PATH: path.resolve(__dirname, '../out/databaseMcpProcess.js') },
      cwd: path.dirname(root), stderr: 'pipe'
    });
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(names, ['solomap_maintenance_finish', 'solomap_migration_retry', 'solomap_migration_status', 'solomap_recycling_apply', 'solomap_recycling_preview']);
    assert.ok(!names.includes('solomap_write'));
    const status = await client.callTool({ name: 'solomap_migration_status', arguments: {} });
    assert.equal(status.isError, undefined, JSON.stringify(status.content));
    const finish = await client.callTool({ name: 'solomap_maintenance_finish', arguments: {} });
    assert.equal(finish.isError, undefined, JSON.stringify(finish.content));
    const afterFinish = await client.callTool({ name: 'solomap_migration_status', arguments: {} });
    assert.equal(afterFinish.isError, true);
    assert.match(afterFinish.content[0].text, /maintenance_task_(?:inactive|expired)/);
    assert.equal((await sendRuntimeDataRequest(root, { operation: 'maintenance_task_status', input: { taskId: task.taskId } })).status, 'completed');
    await client.close();
    client = undefined;
    await transport.close();
    transport = undefined;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual((await sendRuntimeDataRequest(root, { operation: 'migration_overview', input: {} })).activeMaintenanceTaskIds, []);
  } finally {
    if (client) await client.close();
    if (transport) await transport.close();
    if (runtime.exitCode === null) {
      try { await sendRuntimeControlCommand(root, 'stop'); } catch { runtime.kill(); }
      await once(runtime, 'exit');
    }
  }
});
