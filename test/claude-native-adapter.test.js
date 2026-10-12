const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildDatabaseAgentCommand } = require('../out/agentDatabaseLaunch.js');

test('the shared Claude adapter keeps native hook results unchanged and sends one UUID fence per main turn', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../resources/claude-observer/hooks/register.js'), 'utf8');
  const { register } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const hooks = new Map(); register((event, handler) => hooks.set(event, handler));
  const calls = [];
  const events = () => calls.filter(call => call.argv[2] === 'native-event');
  const appends = () => calls.filter(call => call.argv[2] === 'native-append').map(call => JSON.parse(call.options.stdin));
  const $ = { clock: { now: async () => Date.now() }, session: { id: async () => 'session-main' },
    env: { get: async name => ({ SOLOMAP_NODE_EXECUTABLE: '/node', SOLOMAP_TASK_COMMAND: '/checkpoint.js' })[name] },
    process: { run: async (argv, options) => { calls.push({ argv, options }); return { exitCode: 0 }; } } };
  const append = async (uuid, type = 'user', agentId) => {
    const result = { uuid, message: { type, role: type, content: [] } };
    assert.equal(await hooks.get('session.append')($, { uuid, door: type === 'user' ? 'prompt' : 'response', message: result.message, ...(agentId ? { agentId } : {}) }, async () => result), result);
  };
  await hooks.get('session.start')($, {}, async event => event);
  calls.length = 0;
  await append('user-1');
  const started = { turnId: 'provider-1', text: 'first' };
  assert.equal(await hooks.get('turn.start')($, started, async event => event), started);
  await append('assistant-1', 'assistant'); await append('subagent-assistant', 'assistant', 'subagent');
  await append('queued-user-2'); await append('assistant-2', 'assistant');
  const result = { text: 'native response unchanged' };
  const completed = { turnId: 'provider-1', answer: 'only last block', reason: 'answer', isAborted: false };
  assert.equal(await hooks.get('turn.complete')($, completed, async () => result), result);
  assert.equal(events().length, 2);
  assert.equal(JSON.parse(events()[0].options.stdin).phase, 'start');
  assert.deepEqual(appends().map(item => item.uuid), ['user-1', 'assistant-1', 'queued-user-2', 'assistant-2']);
  const event = JSON.parse(events()[1].options.stdin);
  assert.equal(event.userUuid, 'user-1'); assert.deepEqual(event.assistantUuids, ['assistant-1', 'assistant-2']);
  assert.equal(event.providerTurnId, 'provider-1'); assert.equal(event.sessionId, 'session-main'); assert.equal(event.sequence, 2);
  assert.equal(event.answer, undefined); assert.deepEqual(events()[0].argv, ['/node', '/checkpoint.js', 'native-event']);
  await hooks.get('turn.start')($, { turnId: 'provider-2', text: 'second' }, async event => event);
  await append('assistant-3', 'assistant');
  await hooks.get('turn.complete')($, { ...completed, turnId: 'provider-2' }, async () => result);
  assert.equal(JSON.parse(events()[3].options.stdin).userUuid, 'queued-user-2');
  assert.equal(JSON.parse(events()[3].options.stdin).sequence, 4);
  await hooks.get('turn.complete')($, { ...completed, agentId: 'subagent' }, async () => result);
  assert.equal(events().length, 4);
  assert.equal(appends().length, 5);
});

test('the loaded Claude adapter confirms its native session and retries delivery without requiring another user turn', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../resources/claude-observer/hooks/register.js'), 'utf8');
  const { register } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const hooks = new Map(); register((event, handler) => hooks.set(event, handler));
  assert.equal(typeof hooks.get('session.start'), 'function');
  const calls = []; let failures = 2; let sleeps = 0;
  const $ = { clock: { now: async () => Date.now(), sleep: async () => { sleeps++; } }, session: { id: async () => 'native-ready-session' },
    env: { get: async name => ({ SOLOMAP_NODE_EXECUTABLE: '/node', SOLOMAP_TASK_COMMAND: '/checkpoint.js' })[name] },
    process: { run: async (argv, options) => { calls.push({ argv, options }); return { exitCode: failures-- > 0 ? 2 : 0 }; } } };
  const result = { unchanged: true };
  assert.equal(await hooks.get('session.start')($, {}, async () => result), result);
  assert.equal(calls.length, 3); assert.equal(sleeps, 2);
  assert.deepEqual(calls[0].argv, ['/node', '/checkpoint.js', 'native-ready']);
  assert.equal(JSON.parse(calls[0].options.stdin).sessionId, 'native-ready-session');
  assert.equal(calls[0].options.stdin, calls[1].options.stdin); assert.equal(calls[1].options.stdin, calls[2].options.stdin);
});

test('only a supported managed Claude launch adds the shared plugin flag to its final executable command', () => {
  const launch = { schemaVersion: 1, agentCli: '/native path/claude', selectedModel: '', taskPermissionMode: 'auto', continuation: false, direct: false };
  const runId = '11111111-1111-4111-8111-111111111111';
  for (const interactive of [false, true]) for (const continuation of [false, true]) {
    const plain = buildDatabaseAgentCommand({ ...launch, continuation }, runId, 1, '/workspace path', interactive, runId);
    const observed = buildDatabaseAgentCommand({ ...launch, continuation }, runId, 1, '/workspace path', interactive, runId, '', true);
    assert.equal(plain.includes('--plugin-dir'), false);
    assert.match(observed, /--plugin-dir/);
    assert.match(observed, /claude-observer/);
  }
});
