const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const { sendRuntimeControlCommand, sendRuntimeDataRequest } = require('../out/autonomousRuntimeControl.js');

for (const separateProjects of [false, true]) test(`external stdio clients concurrently use one Runtime owner (${separateProjects ? 'separate projects' : 'shared project'})`, async t => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-stdio-')), '.solomap-global');
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
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(__dirname, '../out/databaseMcpProcess.js'), '--global-data-path', root, '--project-id', i === 0 ? project.objectId : secondProject.objectId], stderr: 'pipe' });
      sessions.push({ client, transport });
      await client.connect(transport);
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
