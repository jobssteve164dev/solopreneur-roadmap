const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { prepareAgentRun } = require('../out/agentRunPreparation.js');

async function fixture(provider) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-native-preflight-'));
  const root = path.join(base, '.solomap-global'); const project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(root); const operations = createRuntimeDataOperations(store);
  const call = (operation, input) => operations({ operation, input });
  const state = await prepareAgentRun({ agentCli: provider, selectedModel: 'model', prompt: '用户完整目标', workspaceRoot: project, nodeId: '__solo__', executionLogId: 1, userMessage: '用户目标', runKind: 'solo', globalDataPath: root, taskPermissionMode: 'auto' }, call);
  return { base, root, project, state, call, async close() { await operations.close(); store.close(); } };
}

for (const provider of ['claude', 'copilot', 'grok']) test(`${provider} preserves required official session capability before launching`, async () => {
  const modulePath = path.resolve(__dirname, '../out/agentRunPreflight.js');
  assert.ok(fs.existsSync(modulePath), 'shared launch must retain the native session capability preflight');
  const { prepareNativeAgentLaunch } = require(modulePath);
  const f = await fixture(provider); const calls = [];
  try {
    await assert.rejects(prepareNativeAgentLaunch({ state: f.state, workspaceRoot: f.project, operation: f.call, prepareDatabase: false, execute: async command => { calls.push(command); return { code: 0, stdout: Buffer.from('old CLI without the required flag'), stderr: Buffer.alloc(0) }; } }), error => error.exitCode === 126);
    assert.equal(calls.length, 1); assert.match(calls[0], /--help/);
    const binding = await f.call('read_run_binding', { root: f.project, executionLogId: 1 });
    assert.equal(binding.revisions.at(-1).state, 'unavailable');
    assert.equal(binding.revisions.at(-1).errorCode, 'identity_capability_missing');
    const state = await f.call('read_run_state', { projectId: f.state.projectId, executionLogId: 1 });
    assert.equal(state.status.failureCode, 'identity_capability_missing');
    assert.equal(fs.existsSync(path.join(f.project, '.solopreneur', 'agent-runs')), false);
  } finally { await f.close(); }
});

test('Cursor creates one exact native chat and persists its planned binding before the Agent starts', async () => {
  const modulePath = path.resolve(__dirname, '../out/agentRunPreflight.js'); assert.ok(fs.existsSync(modulePath));
  const { prepareNativeAgentLaunch } = require(modulePath); const f = await fixture('cursor-agent'); const commands = [];
  try {
    const prepared = await prepareNativeAgentLaunch({ state: f.state, workspaceRoot: f.project, operation: f.call, prepareDatabase: false, execute: async command => { commands.push(command); return { code: 0, stdout: Buffer.from(command.endsWith('create-chat') ? 'native-chat-exact-123\n' : '--resume supported\n'), stderr: Buffer.alloc(0) }; } });
    assert.equal(commands.length, 3); assert.equal(commands.filter(command => command.endsWith('create-chat')).length, 1);
    assert.equal(prepared.status.plannedNativeSessionId, 'native-chat-exact-123');
    const binding = await f.call('read_run_binding', { root: f.project, executionLogId: 1 });
    assert.equal(binding.revisions[1].sessionId, 'native-chat-exact-123'); assert.equal(binding.revisions[1].state, 'planned');
    assert.equal(binding.revisions.at(-1).state, 'confirmed');
    const replay = await prepareNativeAgentLaunch({ state: prepared, workspaceRoot: f.project, operation: f.call, prepareDatabase: false, execute: async () => { throw Error('a recorded chat cannot be created twice'); } });
    assert.equal(replay.status.plannedNativeSessionId, 'native-chat-exact-123');
  } finally { await f.close(); }
});

test('Cursor keeps ambiguous create-chat evidence and refuses a guessed identity', async () => {
  const modulePath = path.resolve(__dirname, '../out/agentRunPreflight.js'); assert.ok(fs.existsSync(modulePath));
  const { prepareNativeAgentLaunch } = require(modulePath); const f = await fixture('cursor-agent');
  try {
    await assert.rejects(prepareNativeAgentLaunch({ state: f.state, workspaceRoot: f.project, operation: f.call, prepareDatabase: false, execute: async command => ({ code: 0, stdout: Buffer.from(command.endsWith('create-chat') ? 'candidate-one\ncandidate-two\n' : '--resume supported'), stderr: Buffer.alloc(0) }) }), error => error.exitCode === 126 && error.code === 'native_session_id_ambiguous');
    const binding = await f.call('read_run_binding', { root: f.project, executionLogId: 1 });
    assert.equal(binding.revisions.at(-1).state, 'unavailable'); assert.equal(binding.revisions.at(-1).errorCode, 'native_session_id_ambiguous');
    assert.equal((await f.call('read_run_state', { root: f.project, executionLogId: 1 })).status.nativeSessionIdIsCurrent, false);
  } finally { await f.close(); }
});

test('Cursor confirms the official create-chat acknowledgment without an Agent checkpoint', async () => {
  const { prepareNativeAgentLaunch } = require('../out/agentRunPreflight.js');
  const f = await fixture('cursor-agent');
  try {
    const prepared = await prepareNativeAgentLaunch({ state: f.state, workspaceRoot: f.project, operation: f.call, prepareDatabase: false, execute: async command => ({ code: 0, stdout: Buffer.from(command.endsWith('create-chat') ? 'official-cursor-chat-456\n' : '--resume supported'), stderr: Buffer.alloc(0) }) });
    const binding = await f.call('read_run_binding', { root: f.project, executionLogId: 1 });
    assert.equal(binding.revisions[1].state, 'planned', 'the returned identity remains independently versioned');
    assert.equal(binding.revisions.at(-1).state, 'confirmed');
    assert.equal(binding.resumableRevision, 3);
    assert.equal(prepared.status.nativeSessionId, 'official-cursor-chat-456');
    assert.equal(prepared.status.nativeSessionIdIsCurrent, true);
    assert.equal(prepared.turnId, f.state.turnId, 'native acknowledgment cannot create a business turn');
    assert.equal(prepared.status.checkpointSequence || 0, 0);
    const walPath = path.join(f.root, 'solomap.db-wal'); const wal = fs.readFileSync(walPath);
    await prepareNativeAgentLaunch({ state: prepared, workspaceRoot: f.project, operation: f.call, prepareDatabase: false, execute: async () => { throw new Error('the same acknowledged chat must not be recreated'); } });
    assert.deepEqual(fs.readFileSync(walPath), wal, 'unchanged preflight retry must not write');
  } finally { await f.close(); }
});

test('Cursor resumes a recorded create-chat acknowledgment after interruption before status projection', async () => {
  const { prepareNativeAgentLaunch } = require('../out/agentRunPreflight.js');
  const f = await fixture('cursor-agent'); const commands = [];
  try {
    const scope = { root: f.project, executionLogId: 1, generation: f.state.generation };
    const binding = await f.call('read_run_binding', scope);
    await f.call('write_run_binding', { ...scope, expectedHeadRevision: binding.headRevision, revision: { sessionId: 'recorded-cursor-chat-789', method: 'provider_created', contract: 'official_stable', state: 'planned', evidence: { source: 'cursor_create_chat' } }, idempotencyKey: 'recorded-native-ack' });
    const prepared = await prepareNativeAgentLaunch({ state: f.state, workspaceRoot: f.project, operation: f.call, prepareDatabase: false, execute: async command => { commands.push(command); return { code: 0, stdout: Buffer.from(command.endsWith('create-chat') ? 'wrong-new-chat-000\n' : '--resume supported'), stderr: Buffer.alloc(0) }; } });
    assert.equal(commands.length, 0, 'the already recorded official acknowledgment must be reused');
    assert.equal(prepared.status.plannedNativeSessionId, 'recorded-cursor-chat-789');
    assert.equal(prepared.status.nativeSessionId, 'recorded-cursor-chat-789');
    assert.equal((await f.call('read_run_binding', scope)).headRevision, 3);
  } finally { await f.close(); }
});
