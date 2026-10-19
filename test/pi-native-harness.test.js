const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');

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
