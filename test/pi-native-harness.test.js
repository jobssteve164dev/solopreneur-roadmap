const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');

test('new MCP capabilities do not invalidate an accepted native operation or expand its frozen tools', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-native-snapshot-'));
  t.after(() => cleanupExact(root));
  const { prepareNativeIntelligenceExecution } = require('../out/piAgentEngine.js');
  const tools = [{ name: 'list_projects', description: 'projects', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }];
  const mcp = { listTools: async () => ({ tools }), callTool: async () => { throw new Error('no tools requested'); } };
  const projectContext = { selectedProject: '', projects: [] };
  const accepted = await prepareNativeIntelligenceExecution(projectContext, mcp);
  tools.push({ name: 'get_today_review', description: 'new-tool-after-acceptance', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } });
  const database = new UnifiedDataStore(root);
  try {
    const owner = database.claimPiExecutionOwner('snapshot-owner');
    const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async invocation => {
      assert.doesNotMatch(invocation.stdin, /new-tool-after-acceptance/);
      return 'Accepted task resumed';
    } });
    const result = await engine.chatNative({ sessionId: 'snapshot-session', lane: 'main', operationId: 'snapshot-operation',
      messages: [{ role: 'user', content: 'Continue the accepted task' }], projectContext,
      systemPrompt: accepted.systemPrompt, toolSnapshot: accepted.toolSnapshot
    }, database.createPiSessionStorage('snapshot-session', owner), mcp);
    assert.equal(result.finalAssistant, 'Accepted task resumed');
    const expanded = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async () => JSON.stringify({
      toolCall: { name: 'get_today_review', arguments: {} }
    }) });
    const denied = await expanded.chatNative({ sessionId: 'snapshot-denied', lane: 'main', operationId: 'snapshot-denied',
      messages: [{ role: 'user', content: 'Try the newly added tool' }], projectContext,
      systemPrompt: accepted.systemPrompt, toolSnapshot: accepted.toolSnapshot
    }, database.createPiSessionStorage('snapshot-denied', owner), mcp);
    assert.equal(denied.status, 'failed');
    for (const catalog of [[], [{ ...tools[0], inputSchema: { type: 'object', properties: { changed: { type: 'string' } } } }]]) {
      await assert.rejects(engine.chatNative({ sessionId: 'snapshot-changed', lane: 'main', operationId: 'snapshot-changed',
        messages: [{ role: 'user', content: 'Continue' }], projectContext,
        systemPrompt: accepted.systemPrompt, toolSnapshot: accepted.toolSnapshot
      }, database.createPiSessionStorage('snapshot-changed', owner), { ...mcp, listTools: async () => ({ tools: catalog }) }), /pi_execution_profile_unsupported/);
    }
  } finally { database.close(); }
});

function cleanupExact(root) {
  if (!fs.existsSync(root)) return;
  const directories = [root], files = [];
  const visit = directory => fs.readdirSync(directory).forEach(name => {
    const target = path.join(directory, name), stat = fs.lstatSync(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) { directories.push(target); visit(target); }
    else files.push(target);
  });
  visit(root); files.forEach(file => fs.unlinkSync(file));
  directories.sort((a, b) => b.length - a.length).forEach(directory => fs.rmdirSync(directory));
}

test('native Pi Harness executes and reopens the same durable operation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-native-'));
  t.after(() => cleanupExact(root));
  let calls = 0;
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async () => { calls += 1; return 'Native durable answer'; } });
  let database = new UnifiedDataStore(root);
  const owner = database.claimPiExecutionOwner('runtime-native');
  const storage = database.createPiSessionStorage('native-session', owner);
  assert.equal(typeof engine.chatNative, 'function');
  const first = await engine.chatNative({
    sessionId: 'native-session', lane: 'main', operationId: 'native-operation',
    messages: [{ role: 'user', content: 'Use the native harness' }],
    projectContext: { selectedProject: '', projects: [] }
  }, storage);
  assert.equal(first.status, 'completed');
  assert.equal(first.finalAssistant, 'Native durable answer');
  assert.equal(calls, 1);
  database.close();

  database = UnifiedDataStore.open(root);
  const reopenedOwner = database.claimPiExecutionOwner('runtime-native');
  const reopened = await engine.chatNative({
    sessionId: 'native-session', lane: 'main', operationId: 'native-operation',
    messages: [{ role: 'user', content: 'Use the native harness' }],
    projectContext: { selectedProject: '', projects: [] }
  }, database.createPiSessionStorage('native-session', reopenedOwner));
  assert.deepEqual(reopened, first);
  assert.equal(calls, 1, 'a terminal operation must never rerun the model');
  database.close();
});

test('native Pi Harness owns model retry and lets the model recover from a tool transport error', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-native-retry-'));
  t.after(() => cleanupExact(root));
  let modelCalls = 0, toolCalls = 0;
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async invocation => {
    modelCalls++;
    if (modelCalls === 1) throw new Error('connection refused by temporary model transport');
    if (modelCalls === 2) return JSON.stringify({ toolCall: { name: 'list_projects', arguments: {} } });
    assert.match(invocation.stdin, /Intelligence tool unavailable/);
    return 'Recovered through the native tool lifecycle';
  } });
  const readTools = {
    async listTools() { return { tools: [{ name: 'list_projects', description: 'projects', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false } }] }; },
    async callTool() { toolCalls++; throw new Error('temporary MCP transport failure'); }
  };
  const database = new UnifiedDataStore(root);
  const owner = database.claimPiExecutionOwner('runtime-native-retry');
  const result = await engine.chatNative({
    sessionId: 'native-retry-session', lane: 'main', operationId: 'native-retry-operation',
    messages: [{ role: 'user', content: 'Recover safely' }], projectContext: { selectedProject: '', projects: [] }
  }, database.createPiSessionStorage('native-retry-session', owner), readTools);
  assert.equal(result.status, 'completed');
  assert.equal(result.finalAssistant, 'Recovered through the native tool lifecycle');
  assert.equal(modelCalls, 3);
  assert.equal(toolCalls, 1);
  database.close();
});
