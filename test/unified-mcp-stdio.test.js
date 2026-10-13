const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const { sendRuntimeControlCommand, sendRuntimeDataRequest } = require('../out/autonomousRuntimeControl.js');

function cleanupExact(root) {
  let stat;
  try { stat = fs.lstatSync(root); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) { fs.unlinkSync(root); return; }
  for (const name of fs.readdirSync(root)) cleanupExact(path.join(root, name));
  fs.rmdirSync(root);
}

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
    assert.ok(!tools.includes('solomap_recycling_apply'));
    const migration = await client.callTool({ name: 'solomap_migration_status', arguments: { projectRoot: project } });
    assert.equal(migration.isError, undefined, JSON.stringify(migration.content));
  } finally { await client.close(); await transport.close(); }
});

test('the MCP bridge retries one interrupted Runtime handshake before exposing verified Solo tools', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-mcp-handshake-'));
  t.after(() => cleanupExact(base));
  const root = path.join(base, '.solomap-global'), runtimeRoot = path.join(root, 'runtime'), project = path.join(base, 'project');
  fs.mkdirSync(runtimeRoot, { recursive: true }); fs.mkdirSync(project);
  let requests = 0;
  const server = net.createServer(socket => {
    socket.once('data', () => {
      requests += 1;
      if (requests === 1) { socket.end(); return; }
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
    assert.equal(requests, 2);
  } finally { await client.close(); await transport.close(); }
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
