const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const { sendRuntimeControlCommand, sendRuntimeDataRequest } = require('../out/autonomousRuntimeControl.js');
const { runtimeMcpSource } = require('../out/runtimeDataOperations.js');

function cleanupExact(root) {
  let stat;
  try { stat = fs.lstatSync(root); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) { fs.unlinkSync(root); return; }
  for (const name of fs.readdirSync(root)) cleanupExact(path.join(root, name));
  fs.rmdirSync(root);
}

test('the real MCP process saves local memory metadata while rejecting external identity and host observations', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-local-memory-mcp-'));
  require('node:child_process').execFileSync('git', ['init', '--quiet', base]);
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project');
  fs.mkdirSync(project);
  const owner = await require('./analysis-fixture.js').openAnalysisOwner(t, root, [{ path: project }]);
  t.after(() => cleanupExact(base));
  assert.equal(fs.realpathSync(owner.store.root), fs.realpathSync(root));
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'local-memory-metadata', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve(__dirname, '../out/databaseMcpProcess.js'), '--global-data-path', root, '--project-id', owner.projectIds.get(project)],
    cwd: project, env: require('./analysis-fixture.js').anonymousToolEnv(), stderr: 'pipe' });
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError, undefined, JSON.stringify(response.content));
    return JSON.parse(response.content[0].text);
  };
  try {
    await client.connect(transport);
    const input = { kind: 'memory', action: 'create', idempotencyKey: 'stdio-local-memory', data: { category: 'active', title: 'Local handoff', status: 'captured', layer: 'candidate', content: 'Current verified code facts', provenance_json: { sourceType: 'agent', evidenceRefs: ['src/dataAuthorization.ts'] }, validity_json: {}, supersedes_json: [], metadata_json: { purpose: 'handoff' } } };
    const created = await call('solomap_write', input);
    assert.deepEqual(await call('solomap_write', input), created);
    const memory = await call('solomap_read', { ref: created.objectId, revision: created.revision, view: 'full' });
    assert.equal(memory.data.status, 'captured');
    assert.equal(memory.data.layer, 'candidate');
    assert.equal(memory.data.external_source, null);
    assert.deepEqual(JSON.parse(memory.data.provenance_json), input.data.provenance_json);
    const patched = await call('solomap_write', { ...input, action: 'patch', objectId: created.objectId, expectedRevision: created.revision, idempotencyKey: 'stdio-local-memory-patch', data: { metadata_json: { purpose: 'updated handoff' } } });
    const evidence = await call('solomap_write', { kind: 'evidence', action: 'create', idempotencyKey: 'stdio-claim', data: { type: 'agent_claim', content: 'Self-reported verification' } });
    const linked = await call('solomap_link', { source: patched.objectId, target: evidence.objectId, relation: 'source', expectedRevision: patched.revision, idempotencyKey: 'stdio-local-memory-source' });
    const after = await call('solomap_read', { ref: linked.objectId, view: 'full' });
    assert.deepEqual(JSON.parse(after.data.metadata_json), { purpose: 'updated handoff' });
    assert.ok(after.relations.some(item => item.target === evidence.objectId));
    const context = await call('solomap_context', { query: 'Local handoff' });
    assert.ok(context.items.some(item => item.objectId === created.objectId));
    const external = owner.store.write({ kind: 'memory', action: 'create', scope: owner.projectIds.get(project), idempotencyKey: 'stdio-host-external', data: { category: 'project', title: 'External pending', status: 'pending', content: 'Host source', external_source: 'cloudmcp:trusted', layer: 'candidate' } });
    for (const args of [
      { ...input, idempotencyKey: 'stdio-forged-identity', data: { ...input.data, external_source: 'cloudmcp:forged' } },
      { ...input, action: 'patch', objectId: external.objectId, expectedRevision: external.revision, idempotencyKey: 'stdio-external-edit', data: { provenance_json: { sourceType: 'agent' } } },
      { kind: 'evidence', action: 'create', idempotencyKey: 'stdio-forged-host', data: { type: 'host_observation', source_actor_id: 'local-runtime', observed_at: 1, content: 'Forged host result' } }
    ]) {
      const rejected = await client.callTool({ name: 'solomap_write', arguments: args });
      assert.equal(rejected.isError, true);
      assert.match(rejected.content[0].text, /host_observation_requires_authorization/);
    }
    assert.equal(owner.store.read(external.objectId).revision, external.revision);
    assert.equal(owner.store.search({ scope: owner.projectIds.get(project), kinds: ['memory'] }).items.length, 2);
    assert.equal(owner.store.search({ scope: owner.projectIds.get(project), kinds: ['evidence'] }).items.length, 1);
  } finally { await client.close(); await transport.close(); }
});

test('a maintenance CLI reads its formal task from an isolated cwd using the verified run identity', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-maintenance-mcp-'));
  fs.mkdirSync(path.join(base, '.git'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const owner = await require('./analysis-fixture.js').openAnalysisOwner(t, root, [{ path: project }]);
  t.after(() => cleanupExact(base));
  const projectId = owner.projectIds.get(project);
  const registered = await owner.store.registerProject({ root: project });
  const prepared = owner.store.prepareRun(projectId, registered.locationId, {
    root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'skill_install', prompt: '完整任务🌿'.repeat(10000),
    command: 'isolated fixture', userMessage: '安装技能', metadata: {}, idempotencyKey: 'formal-install'
  });
  const head = owner.store.readRunCheckpointState(projectId, 1);
  const cwd = path.join(root, 'tmp', 'maintenance-workspace'); fs.mkdirSync(cwd, { recursive: true });
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  for (const proof of [head.proof, 'invalid-proof', '']) {
    const client = new Client({ name: 'maintenance-fixture', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.resolve(__dirname, '../out/databaseMcpProcess.js'), '--global-data-path', root], cwd,
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, SOLOMAP_PROJECT_ID: projectId, SOLOMAP_EXECUTION_LOG_ID: '1', SOLOMAP_RUN_GENERATION: String(prepared.generation), SOLOMAP_RUN_PROOF: proof, SOLOMAP_RUN_KIND: 'solo' }, stderr: 'pipe' });
    let errors = ''; transport.stderr?.on('data', chunk => { errors += chunk; });
    try {
      if (proof !== head.proof) {
        await assert.rejects(client.connect(transport));
        assert.match(errors, proof ? /run_proof_denied/ : /project_identity_not_found/);
      } else {
        await client.connect(transport).catch(error => { throw new Error(`${error.message}: ${errors}`); });
        const tools = (await client.listTools()).tools.map(tool => tool.name);
        for (const name of ['solomap_migration_start', 'solomap_migration_status', 'solomap_migration_retry', 'solomap_recycling_preview', 'solomap_recycling_apply']) assert.ok(!tools.includes(name), `${name} must stay outside skill maintenance tasks`);
        const response = await client.callTool({ name: 'solomap_read', arguments: { ref: prepared.runId, view: 'full' } });
        assert.ok(!response.isError, JSON.stringify(response));
        assert.ok(response.content[0].text.includes('完整任务🌿'.repeat(10000)));
      }
    } finally { await client.close(); await transport.close(); }
  }
  assert.deepEqual(fs.readdirSync(path.join(project, '.solopreneur')), ['project.json']);
});

test('an ordinary Solo CLI receives project-scoped migration and preview tools without recycling apply', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-solo-mcp-'));
  fs.mkdirSync(path.join(base, '.git'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const owner = await require('./analysis-fixture.js').openAnalysisOwner(t, root, [{ path: project }]);
  t.after(() => cleanupExact(base));
  const projectId = owner.projectIds.get(project);
  const registered = await owner.store.registerProject({ root: project });
  const prepared = owner.store.prepareRun(projectId, registered.locationId, {
    root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: '迁移当前项目',
    command: 'codex', userMessage: '迁移当前项目', idempotencyKey: 'ordinary-solo-migration-tools'
  });
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'ordinary-solo-migration', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve(__dirname, '../out/databaseMcpProcess.js'), '--global-data-path', root], cwd: project,
    env: { ...process.env, SOLOMAP_PROJECT_ID: projectId, SOLOMAP_EXECUTION_LOG_ID: '1', SOLOMAP_RUN_GENERATION: String(prepared.generation), SOLOMAP_RUN_PROOF: prepared.proof, SOLOMAP_RUN_KIND: 'solo' }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ['solomap_migration_start', 'solomap_migration_status', 'solomap_migration_retry', 'solomap_recycling_preview']) assert.ok(tools.includes(name), `missing ${name}`);
    assert.ok(tools.includes('solomap_start_conversation'));
    assert.ok(!tools.includes('solomap_recycling_apply'));
    const migration = await client.callTool({ name: 'solomap_migration_status', arguments: { projectRoot: project } });
    assert.equal(migration.isError, undefined, JSON.stringify(migration.content));
  } finally { await client.close(); await transport.close(); }
});

test('an Agent CLI starts a new conversation in another registered project through the editor host', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-start-conversation-'));
  const root = path.join(base, '.solomap-global'), sourceProject = path.join(base, 'source'), targetProject = path.join(base, 'target');
  fs.mkdirSync(path.join(sourceProject, '.git'), { recursive: true });
  fs.mkdirSync(path.join(targetProject, '.git'), { recursive: true });
  t.after(() => cleanupExact(base));
  const owner = await require('./analysis-fixture.js').openAnalysisOwner(t, root, [
    { path: sourceProject, name: 'Source' }, { path: targetProject, name: 'Target' }
  ]);
  await owner.store.initializeProjectRegistry({ legacyProjects: [
    { path: sourceProject, name: 'Source' }, { path: targetProject, name: 'Target' }
  ] });
  const launches = [];
  const bridge = await require('../out/telegramExtensionBridge.js').startTelegramExtensionBridge(root, async (command, args) => {
    const payload = JSON.parse(args[0]); launches.push({ command, payload });
    await owner.ops({ operation: 'prepare_run_intent', input: { root: payload.projectPath, launchIntentId: payload.launchIntentId,
      nodeId: payload.stepId || '__solo__', runKind: payload.mode, prompt: payload.message, command: 'fixture-agent',
      userMessage: payload.message, status: 'Running', metadata: { interactiveSession: true, launchIntentHash: 'fixture-hash' },
      launchRequest: { workspaceRoot: payload.projectPath, agentCli: 'fixture-agent' }, idempotencyKey: payload.launchIntentId } });
    return { status: 'started', projectPath: targetProject, mode: payload.mode };
  });
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'conversation-launch-fixture', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve(__dirname, '../out/databaseMcpProcess.js'), '--global-data-path', root, '--project-id', owner.projectIds.get(sourceProject)], cwd: sourceProject, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: 'solomap_start_conversation', arguments: {
      project: 'Target', mode: 'step', stepId: 'S01', message: '开始目标项目环节', agentCli: 'codex', model: 'auto', idempotencyKey: 'cross-project-step'
    } });
    assert.equal(response.isError, undefined, JSON.stringify(response.content));
    assert.equal(launches.length, 1);
    assert.equal(launches[0].command, 'solopreneur.internalStartConversation');
    assert.deepEqual({ ...launches[0].payload, launchIntentId: '<stable>' }, {
      projectPath: targetProject, mode: 'step', stepId: 'S01', message: '开始目标项目环节', agentCli: 'codex', model: 'auto', launchIntentId: '<stable>'
    });
    const receipt = JSON.parse(response.content[0].text);
    assert.match(receipt.conversationRef, /^[a-f0-9-]{36}$/);
    assert.equal(launches[0].payload.launchIntentId, `mcp:${receipt.conversationRef}`);
    const query = await client.callTool({ name: 'solomap_get_conversation', arguments: { ref: receipt.conversationRef } });
    assert.equal(query.isError, undefined, JSON.stringify(query.content));
    assert.equal(JSON.parse(query.content[0].text).state, 'running');
    const state = owner.store.readRunCheckpointState(receipt.projectId, receipt.executionLogId);
    const done = await owner.ops({ operation: 'checkpoint_run', input: { projectId: state.projectId, executionLogId: receipt.executionLogId,
      generation: state.generation, proof: state.proof, expectedRevision: state.revision, expectedTurnId: state.turnId,
      action: 'complete', outcome: 'candidate_complete', summary: '目标环节已完成', idempotencyKey: 'stdio-task-complete' } });
    const scope = { projectId: state.projectId, executionLogId: receipt.executionLogId, generation: done.generation,
      expectedRevision: done.revision, expectedTurnId: done.turnId };
    const consumer = await owner.ops({ operation: 'claim_run_consumer', input: { ...scope, owner: await require('../out/agentRunPreparation.js').getAgentRunDeliveryOwner() } });
    await owner.ops({ operation: 'commit_run_settlement', input: { ...scope, token: consumer.token,
      journal: { agentCli: 'fixture-agent', command: 'fixture-agent', output: '任务结果', status: 'Completed' },
      digest: { schemaVersion: 2, runId: state.runId, executionLogId: receipt.executionLogId, nodeId: 'S01', outcome: '目标环节已完成' },
      idempotencyKey: 'stdio-task-settled' } });
    const completed = await client.callTool({ name: 'solomap_get_conversation', arguments: { ref: receipt.conversationRef } });
    assert.equal(completed.isError, undefined, JSON.stringify(completed.content));
    assert.equal(JSON.parse(completed.content[0].text).state, 'waiting');
    assert.equal(JSON.parse(completed.content[0].text).result.summary, '目标环节已完成');
    const crossProjectConflict = await client.callTool({ name: 'solomap_start_conversation', arguments: {
      project: 'Source', mode: 'step', stepId: 'S01', message: '开始目标项目环节', agentCli: 'codex', model: 'auto', idempotencyKey: 'cross-project-step'
    } });
    assert.equal(crossProjectConflict.isError, true);
    assert.match(crossProjectConflict.content[0].text, /idempotency_conflict/);
    const crossModeConflict = await client.callTool({ name: 'solomap_start_conversation', arguments: {
      project: 'Target', mode: 'flow', message: '开始目标项目环节', agentCli: 'codex', model: 'auto', idempotencyKey: 'cross-project-step'
    } });
    assert.equal(crossModeConflict.isError, true);
    assert.match(crossModeConflict.content[0].text, /idempotency_conflict/);
    assert.equal(launches.length, 1, 'one idempotency key cannot launch across projects or modes');
    const escapedMessage = '\\'.repeat(32768);
    const escaped = await client.callTool({ name: 'solomap_start_conversation', arguments: {
      project: 'Target', mode: 'solo', message: escapedMessage, idempotencyKey: 'maximum-escaped-message'
    } });
    assert.equal(escaped.isError, undefined, JSON.stringify(escaped.content));
    assert.equal(launches[1].payload.message, escapedMessage);
  } finally {
    await client.close(); await transport.close(); bridge.dispose();
  }
});

test('an agent review MCP session exposes read-only database memory tools and its bound lifecycle tool', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-review-mcp-'));
  fs.mkdirSync(path.join(base, '.git'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project'); fs.mkdirSync(project);
  const owner = await require('./analysis-fixture.js').openAnalysisOwner(t, root, [{ path: project }]);
  t.after(() => cleanupExact(base));
  const projectId = owner.projectIds.get(project);
  const registered = await owner.store.registerProject({ root: project });
  const memory = owner.store.write({
    kind: 'memory', action: 'create', scope: projectId, idempotencyKey: 'review-memory',
    data: { category: 'patterns', title: 'review context', status: 'verified', content: 'use the database memory' }
  });
  const prepared = owner.store.prepareRun(projectId, registered.locationId, {
    root: project, executionLogId: 1, nodeId: '__review__', runKind: 'agent_review', prompt: 'review',
    command: 'codex review', userMessage: 'review', idempotencyKey: 'read-only-review-tools'
  });
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'agent-review-memory', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve(__dirname, '../out/databaseMcpProcess.js'), '--global-data-path', root], cwd: project,
    env: { ...process.env, SOLOMAP_PROJECT_ID: projectId, SOLOMAP_EXECUTION_LOG_ID: '1', SOLOMAP_RUN_GENERATION: String(prepared.generation), SOLOMAP_RUN_PROOF: prepared.proof, SOLOMAP_RUN_KIND: 'agent_review' }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(names, ['solomap_context', 'solomap_conversation_status', 'solomap_experience', 'solomap_memory', 'solomap_read', 'solomap_search']);
    const context = await client.callTool({ name: 'solomap_context', arguments: { project: projectId, query: 'review context' } });
    assert.equal(context.isError, undefined, JSON.stringify(context.content));
    assert.ok(JSON.parse(context.content[0].text).items.some(item => item.objectId === memory.objectId));
    const read = await client.callTool({ name: 'solomap_read', arguments: { ref: memory.objectId, revision: memory.revision, view: 'full' } });
    assert.equal(JSON.parse(read.content[0].text).data.content, 'use the database memory');
  } finally { await client.close(); await transport.close(); }
});

test('the MCP bridge survives a Runtime handover longer than the old three-attempt window', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-mcp-handshake-'));
  t.after(() => cleanupExact(base));
  const root = path.join(base, '.solomap-global'), runtimeRoot = path.join(root, 'runtime'), project = path.join(base, 'project');
  fs.mkdirSync(runtimeRoot, { recursive: true }); fs.mkdirSync(project);
  let requests = 0;
  const server = net.createServer(socket => {
    socket.once('data', () => {
      requests += 1;
      if (requests <= 5) { socket.end(); return; }
      socket.end(JSON.stringify({ ok: true, runtimeId: 'fixture-runtime', result: { actorId: 'fixture-actor', proof: 'fixture-proof', sessionToken: 'fixture-session', runKind: 'solo', migrationKind: null } }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  fs.writeFileSync(path.join(runtimeRoot, 'control.json'), JSON.stringify({ schemaVersion: 1, runtimeId: 'fixture-runtime', host: '127.0.0.1', port: address.port, token: 'fixture-token' }));
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'retry-runtime-handshake', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve(__dirname, '../out/databaseMcpProcess.js'), '--global-data-path', root], cwd: project,
    env: { ...process.env, SOLOMAP_PROJECT_ID: '11111111-1111-4111-8111-111111111111', SOLOMAP_EXECUTION_LOG_ID: '1', SOLOMAP_RUN_GENERATION: '1', SOLOMAP_RUN_PROOF: 'fixture-run-proof', SOLOMAP_RUN_KIND: 'step' }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(tools.includes('solomap_migration_status'));
    assert.ok(!tools.includes('solomap_recycling_apply'));
    assert.equal(requests, 6);
  } finally { await client.close(); await transport.close(); }
});

test('an established MCP process resumes its database session after the Runtime is replaced', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-mcp-runtime-replacement-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(path.join(project, '.git'));
  new (require('../out/db/unifiedDataStore.js').UnifiedDataStore)(root).close();
  t.after(() => cleanupExact(base));
  const startRuntime = async runtimeId => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../out/autonomousRuntimeProcess.js'), '--global-data-path', root, '--runtime-id', runtimeId, '--database-required'], { stdio: 'pipe' });
    let stderr = ''; child.stderr.on('data', value => { stderr += value; }); child.stdout.resume();
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(path.join(root, 'runtime', 'control.json'))) {
      assert.equal(child.exitCode, null, stderr);
      assert.ok(Date.now() < deadline, stderr || 'runtime did not start');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return { child, stderr: () => stderr };
  };
  let owner = await startRuntime('mcp-owner-one');
  const registered = await sendRuntimeDataRequest(root, { operation: 'register_project', input: { root: project } });
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'runtime-replacement-client', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve(__dirname, '../out/databaseMcpProcess.js'), '--global-data-path', root, '--project-id', registered.projectId], cwd: project, stderr: 'pipe' });
  try {
    await client.connect(transport);
    assert.equal((await client.callTool({ name: 'solomap_search', arguments: { query: 'before' } })).isError, undefined);
    await sendRuntimeControlCommand(root, 'stop'); await once(owner.child, 'close');
    owner = await startRuntime('mcp-owner-two');
    const resumed = await client.callTool({ name: 'solomap_search', arguments: { query: 'after' } });
    assert.equal(resumed.isError, undefined, JSON.stringify(resumed.content));
  } finally {
    await client.close(); await transport.close();
    if (owner.child.exitCode === null) { await sendRuntimeControlCommand(root, 'stop'); await once(owner.child, 'close'); }
  }
});

test('opening an MCP session is idempotent for one client request across a lost response', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-mcp-open-idempotency-'));
  const root = path.join(base, '.solomap-global'), projectRoot = path.join(base, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
  let store = new UnifiedDataStore(root);
  let operations = createRuntimeDataOperations(store);
  try {
    const project = await store.registerProject({ root: projectRoot });
    const request = { operation: 'open_mcp_session', input: { projectId: project.projectId, openRequestId: 'fixture-open-request' } };
    const first = await operations(request);
    const replay = await operations(request);
    assert.deepEqual(replay, first);
    await operations.close(); store.close();
    store = new UnifiedDataStore(root);
    operations = createRuntimeDataOperations(store);
    const afterRestart = await operations(request);
    assert.equal(afterRestart.actorId, first.actorId);
    assert.equal(afterRestart.proof, first.proof);
    assert.notEqual(afterRestart.sessionToken, first.sessionToken);
  } finally { await operations.close(); store.close(); cleanupExact(base); }
});

test('an established MCP source retries the request that races a Runtime handover', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-mcp-runtime-race-'));
  const root = path.join(base, '.solomap-global'), runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  let opens = 0, searches = 0;
  const openInputs = [], initialSearches = [], closedSessions = [];
  const server = net.createServer(socket => {
    let body = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      body += chunk;
      const newline = body.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(body.slice(0, newline)).request;
      if (request.operation === 'open_mcp_session') {
        opens += 1;
        openInputs.push(request.input);
        socket.end(JSON.stringify({ ok: true, runtimeId: 'fixture-runtime', result: {
          actorId: 'fixture-actor', proof: 'fixture-proof', sessionToken: `fixture-session-${opens}`, runKind: 'solo', migrationKind: null
        } }));
      } else if (request.operation === 'search') {
        searches += 1;
        if (searches <= 2) {
          initialSearches.push(socket);
          if (initialSearches.length === 2) for (const pending of initialSearches) pending.end(JSON.stringify({ ok: false, runtimeId: 'fixture-runtime', error: 'different_runtime' }));
        } else socket.end(JSON.stringify({ ok: true, runtimeId: 'fixture-runtime', result: { items: [], cursor: null } }));
      } else {
        closedSessions.push(request.input.sessionToken);
        socket.end(JSON.stringify({ ok: true, runtimeId: 'fixture-runtime', result: { closed: true } }));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  fs.writeFileSync(path.join(runtimeRoot, 'control.json'), JSON.stringify({
    schemaVersion: 1, runtimeId: 'fixture-runtime', status: 'running', heartbeatAt: new Date().toISOString(),
    host: '127.0.0.1', port: address.port, token: 'fixture-token'
  }));
  const source = runtimeMcpSource(root, '11111111-1111-4111-8111-111111111111', true);
  t.after(async () => { await source.close(); await new Promise(resolve => server.close(resolve)); cleanupExact(base); });
  assert.equal((await source.sessionInfo()).runKind, 'solo');
  assert.deepEqual(await Promise.all([
    source.call('search', { query: 'handover-a' }),
    source.call('search', { query: 'handover-b' })
  ]), [{ items: [], cursor: null }, { items: [], cursor: null }]);
  assert.equal(opens, 2);
  assert.equal(searches, 4);
  assert.equal(openInputs[0].resume, undefined);
  assert.deepEqual(openInputs[1].resume, { actorId: 'fixture-actor', proof: 'fixture-proof' });
  await source.close();
  assert.deepEqual(closedSessions, ['fixture-session-2']);
});

test('an MCP source only replays an ambiguous Runtime response when the operation has an idempotency contract', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-mcp-runtime-replay-'));
  const root = path.join(base, '.solomap-global'), runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  let opens = 0, retries = 0;
  const openInputs = [];
  const writes = [];
  const server = net.createServer(socket => {
    let body = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      body += chunk;
      const newline = body.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(body.slice(0, newline)).request;
      if (request.operation === 'open_mcp_session') {
        opens += 1;
        openInputs.push(request.input);
        if (opens === 1) socket.end();
        else socket.end(JSON.stringify({ ok: true, runtimeId: 'fixture-runtime', result: {
          actorId: 'fixture-actor', proof: 'fixture-proof', sessionToken: 'fixture-session', runKind: 'solo', migrationKind: null
        } }));
      } else if (request.operation === 'retry_migration') {
        retries += 1;
        if (retries === 1) socket.end();
        else socket.end(JSON.stringify({ ok: true, runtimeId: 'fixture-runtime', result: { status: 'queued' } }));
      } else if (request.operation === 'write') {
        writes.push(request.input);
        if (writes.length === 1) socket.end();
        else socket.end(JSON.stringify({ ok: true, runtimeId: 'fixture-runtime', result: { objectId: 'fixture-object', revision: 1 } }));
      } else socket.end(JSON.stringify({ ok: true, runtimeId: 'fixture-runtime', result: { closed: true } }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  fs.writeFileSync(path.join(runtimeRoot, 'control.json'), JSON.stringify({
    schemaVersion: 1, runtimeId: 'fixture-runtime', status: 'running', heartbeatAt: new Date().toISOString(),
    host: '127.0.0.1', port: address.port, token: 'fixture-token'
  }));
  const source = runtimeMcpSource(root, '11111111-1111-4111-8111-111111111111', true);
  t.after(async () => { await source.close(); await new Promise(resolve => server.close(resolve)); cleanupExact(base); });
  await source.sessionInfo();
  assert.equal(typeof openInputs[0].openRequestId, 'string');
  assert.equal(openInputs[0].openRequestId, openInputs[1].openRequestId);
  await assert.rejects(source.call('retry_migration', { jobId: 'fixture-job' }), /runtime_data_response_incomplete/);
  assert.equal(retries, 1);
  const input = { kind: 'memory', action: 'create', scope: '11111111-1111-4111-8111-111111111111', idempotencyKey: 'fixture-write', data: { title: 'fixture' } };
  assert.deepEqual(await source.call('write', input), { objectId: 'fixture-object', revision: 1 });
  assert.deepEqual(writes, [input, input]);
  assert.equal(opens, 2);
});

test('the MCP bridge exits promptly when its owning client session closes', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-mcp-owner-stop-'));
  const root = path.join(base, '.solomap-global'), project = path.join(base, 'project');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(path.join(project, '.git'));
  const owner = await require('./analysis-fixture.js').openAnalysisOwner(t, root, [{ path: project }]);
  t.after(() => cleanupExact(base));
  const projectId = owner.projectIds.get(project);
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'mcp-owner-stop', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve(__dirname, '../out/databaseMcpProcess.js'), '--global-data-path', root, '--project-id', projectId], cwd: project, stderr: 'pipe' });
  let errors = ''; transport.stderr?.on('data', chunk => { errors += chunk; });
  try {
    await client.connect(transport);
    const pid = transport.pid;
    assert.ok(pid, 'MCP bridge must expose its child pid after connecting');
    await client.close();
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); }
      catch (error) { if (error.code === 'ESRCH') break; throw error; }
    }
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', errors || `MCP bridge ${pid} stayed alive after its client session closed`);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
});

for (const separateProjects of [false, true]) test(`external stdio clients concurrently use one Runtime owner (${separateProjects ? 'separate projects' : 'shared project'})`, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-stdio-'));
  t.after(() => cleanupExact(base));
  const root = path.join(base, '.solomap-global');
  fs.mkdirSync(root);
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  new UnifiedDataStore(root).close();
  const runtime = spawn(process.execPath, [path.resolve(__dirname, '../out/autonomousRuntimeProcess.js'), '--global-data-path', root, '--runtime-id', 'stdio-owner'], { stdio: 'pipe' });
  let stderr = '';
  runtime.stderr.on('data', chunk => { stderr += chunk; });
  runtime.stdout.resume();
  const deadline = Date.now() + 10000;
  const sessions = [];
  try {
    while (!fs.existsSync(path.join(root, 'runtime/control.json'))) {
      assert.equal(runtime.exitCode, null, stderr);
      assert.ok(Date.now() < deadline, stderr || 'runtime did not start');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await sendRuntimeControlCommand(root, 'pause');
    const project = await sendRuntimeDataRequest(root, { operation: 'write', input: { kind: 'project', action: 'create', scope: null, idempotencyKey: 'project', data: { name: 'stdio' } } });
    const secondProject = separateProjects ? await sendRuntimeDataRequest(root, { operation: 'write', input: { kind: 'project', action: 'create', scope: null, idempotencyKey: 'second-project', data: { name: 'second stdio project' } } }) : project;
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    for (let i = 0; i < 2; i++) {
      const client = new Client({ name: `external-${i}`, version: '1' });
      const workspace = path.join(root, `workspace-${i}`);
      fs.mkdirSync(path.join(workspace, '.solopreneur'), { recursive: true });
      fs.writeFileSync(path.join(workspace, '.solopreneur', 'project.json'), JSON.stringify({ schemaVersion: 1, projectId: i === 0 ? project.objectId : secondProject.objectId }));
      const { configureAgentDatabase } = require('../out/agentDatabaseConfig.js');
      const configPath = path.join(workspace, 'cli-mcp.json');
      configureAgentDatabase({ provider: 'cursor', configPath, command: process.execPath, globalDataPath: i === 0 ? path.dirname(root) : root });
      const configured = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.solomap_data;
      const workingDirectory = i === 0 ? workspace : path.join(workspace, 'src');
      fs.mkdirSync(workingDirectory, { recursive: true });
      const transport = new StdioClientTransport({ ...configured, cwd: workingDirectory, stderr: 'pipe' });
      sessions.push({ client, transport });
      await client.connect(transport);
      const schemaByTool = await client.callTool({ name: 'solomap_read', arguments: { ref: 'solomap://schema' } });
      assert.ok(!schemaByTool.isError, JSON.stringify(schemaByTool));
      assert.equal(JSON.parse(schemaByTool.content[0].text).kinds.memory.fields.content.required, true);
    }
    const receipts = await Promise.all(sessions.map(async ({ client }, i) => {
      const result = await client.callTool({ name: 'solomap_write', arguments: { kind: 'memory', action: 'create', idempotencyKey: 'first-write', data: { category: 'inbox', title: `external-${i}`, status: 'captured', content: `即时正文-${i}` } } });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      return JSON.parse(result.content[0].text);
    }));
    const result = await sessions[1].client.callTool({ name: 'solomap_read', arguments: { ref: receipts[0].objectId } });
    if (separateProjects) {
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /scope_denied/);
    } else assert.equal(JSON.parse(result.content[0].text).data.content, '即时正文-0');
    const resource = await sessions[1].client.readResource({ uri: `solomap://objects/${receipts[1].objectId}` });
    assert.equal(JSON.parse(resource.contents[0].text).data.content, '即时正文-1');
    const latencies = await Promise.all(Array.from({ length: 24 }, async (_, i) => {
      const client = sessions[i % 2].client;
      const start = performance.now();
      const response = await client.callTool({ name: 'solomap_write', arguments: { kind: 'memory', action: 'create', idempotencyKey: `parallel-${i}`, data: { category: 'inbox', title: `parallel-${i}`, status: 'captured', content: `parallel body ${i}` } } });
      assert.equal(response.isError, undefined, JSON.stringify(response.content));
      const receipt = JSON.parse(response.content[0].text);
      const read = await client.callTool({ name: 'solomap_read', arguments: { ref: receipt.objectId } });
      assert.equal(JSON.parse(read.content[0].text).data.content, `parallel body ${i}`);
      return performance.now() - start;
    }));
    latencies.sort((a, b) => a - b);
    t.diagnostic(JSON.stringify({ concurrentWrites: 24, committedAndReadP50Ms: latencies[12], committedAndReadP95Ms: latencies[22], fixtureOnly: true }));
    assert.equal((await sendRuntimeControlCommand(root, 'health')).runtimeId, 'stdio-owner');
  } finally {
    await Promise.all(sessions.map(async ({ client, transport }) => { await client.close(); await transport.close(); }));
    if (runtime.exitCode === null) {
      try { await sendRuntimeControlCommand(root, 'stop'); } catch { runtime.kill(); }
      await once(runtime, 'exit');
    }
  }
});
