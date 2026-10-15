const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { LocalAgentCliEngine, buildCognitiveCliInvocation } = require('../out/localAgentCliEngine.js');
const { cognitiveRuntimeConfigRevision, persistCognitiveRuntimeConfig, readCognitiveRuntimeConfig, refreshCognitiveRuntimeConfig, writeCognitiveRuntimeConfig } = require('../out/cognitiveRuntimeConfig.js');

test('Codex cognitive invocation is headless, read-only, and shell-free', () => {
  const previousBus = process.env.DBUS_SESSION_BUS_ADDRESS;
  const previousKeyring = process.env.GNOME_KEYRING_CONTROL;
  process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/tmp/solomap-fixture-bus';
  process.env.GNOME_KEYRING_CONTROL = '/tmp/solomap-fixture-keyring';
  const invocation = buildCognitiveCliInvocation('/usr/local/bin/codex', 'gpt-5', '{"goal":"choose"}');
  if (previousBus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
  else process.env.DBUS_SESSION_BUS_ADDRESS = previousBus;
  if (previousKeyring === undefined) delete process.env.GNOME_KEYRING_CONTROL;
  else process.env.GNOME_KEYRING_CONTROL = previousKeyring;
  assert.equal(invocation.command, '/usr/local/bin/codex');
  assert.deepEqual(invocation.args, ['exec', '--color', 'never', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--model', 'gpt-5', '-']);
  assert.equal(invocation.stdin, '{"goal":"choose"}');
  assert.equal(invocation.shell, false);
  assert.equal(invocation.env.CODEX_HOME, process.env.CODEX_HOME);
  assert.equal(invocation.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/tmp/solomap-fixture-bus');
  assert.equal(invocation.env.GNOME_KEYRING_CONTROL, '/tmp/solomap-fixture-keyring');
  assert.equal(Object.hasOwn(invocation.env, 'OPENAI_API_KEY'), false);
  assert.equal(invocation.args.some(value => /dangerously|allow-all/i.test(value)), false);
});

test('local Agent CLI engine parses one schema-bound decision without opening a terminal', async () => {
  let received;
  const engine = new LocalAgentCliEngine({
    agentCli: 'copilot', model: 'auto',
    runner: async invocation => {
      received = invocation;
      return '```json\n{"candidateId":"candidate-b","reason":"先完成可以在今天验收的结果。"}\n```';
    }
  });
  const result = await engine.plan({
    decisionId: 'decision-1',
    candidates: [
      { id: 'candidate-a', name: 'Alpha', title: 'A', reason: 'A', evidence: [], baselineRank: 1 },
      { id: 'candidate-b', name: 'Beta', title: 'B', reason: 'B', evidence: [], baselineRank: 2 }
    ]
  });
  assert.equal(result.candidateId, 'candidate-b');
  assert.equal(received.command, 'copilot');
  assert.equal(received.shell, false);
  assert.ok(received.args.includes('--available-tools'));
  assert.equal(received.args.includes('--allow-all-tools'), false);
});

test('supported cognitive adapters keep candidate data out of process arguments', () => {
  for (const agentCli of ['agy', 'codex', 'cursor-agent', 'copilot', 'claude']) {
    const prompt = `private-candidate-${agentCli}`;
    const invocation = buildCognitiveCliInvocation(agentCli, 'auto', prompt);
    assert.equal(invocation.stdin, prompt, agentCli);
    assert.equal(invocation.args.some(value => value.includes(prompt)), false, agentCli);
    assert.equal(invocation.shell, false, agentCli);
  }
  assert.throws(
    () => buildCognitiveCliInvocation('grok', 'auto', 'private-candidate-grok'),
    /safe headless cognitive mode/
  );
});

test('Antigravity cognitive mode leaves print last so stdin remains the prompt', () => {
  const invocation = buildCognitiveCliInvocation('agy', 'auto', 'private decision');
  assert.equal(invocation.args.at(-1), '--print');
  assert.deepEqual(invocation.args.slice(0, -1), [
    '--mode', 'plan', '--sandbox', '--disable-slash-commands', '--print-timeout', '5m'
  ]);
});

test('Runtime reloads a normalized local Agent CLI choice from its config file', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-cognitive-config-'));
  const root = path.join(parent, '.solomap-global');
  try {
    writeCognitiveRuntimeConfig(root, { mode: 'agent_cli', agentCli: 'codex', model: 'gpt-5' });
    const config = readCognitiveRuntimeConfig(root);
    assert.deepEqual({ ...config, revision: undefined }, { schemaVersion: 1, mode: 'agent_cli', agentCli: 'codex', model: 'gpt-5', revision: undefined });
    assert.match(config.revision, /^[a-zA-Z0-9._-]+$/);
  } finally {
    const file = path.join(root, 'runtime', 'cognitive-config.json');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const runtimeRoot = path.join(root, 'runtime');
    if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
    if (fs.existsSync(root)) fs.rmdirSync(root);
    fs.rmdirSync(parent);
  }
});

test('cognitive config revision changes when the selected model pipe changes', () => {
  const local = { schemaVersion: 1, revision: 'epoch-a', mode: 'local_only', agentCli: '', model: 'auto' };
  const codex = { schemaVersion: 1, revision: 'epoch-b', mode: 'agent_cli', agentCli: 'codex', model: 'auto' };
  assert.notEqual(cognitiveRuntimeConfigRevision(local), cognitiveRuntimeConfigRevision(codex));
  assert.equal(cognitiveRuntimeConfigRevision(codex), cognitiveRuntimeConfigRevision({ ...codex }));
});

test('cognitive config epochs do not return to an earlier value after an A-B-A switch', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-cognitive-epoch-'));
  const root = path.join(parent, '.solomap-global');
  try {
    const first = writeCognitiveRuntimeConfig(root, { mode: 'agent_cli', agentCli: 'codex', model: 'auto' });
    const second = writeCognitiveRuntimeConfig(root, { mode: 'agent_cli', agentCli: 'claude', model: 'auto' });
    const third = writeCognitiveRuntimeConfig(root, { mode: 'agent_cli', agentCli: 'codex', model: 'auto' });
    assert.notEqual(first.revision, second.revision);
    assert.notEqual(first.revision, third.revision);
  } finally {
    const file = path.join(root, 'runtime', 'cognitive-config.json');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const runtimeRoot = path.join(root, 'runtime');
    if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
    if (fs.existsSync(root)) fs.rmdirSync(root);
    fs.rmdirSync(parent);
  }
});

test('a late cognitive refresh cannot replace a newer configuration snapshot', async () => {
  const root = path.join(os.tmpdir(), `solomap-cognitive-refresh-race-${process.pid}-${Date.now()}`);
  let releaseOlder;
  const older = refreshCognitiveRuntimeConfig(root, async () => {
    await new Promise(resolve => { releaseOlder = resolve; });
    return { items: [
      { key: 'mode', revision: 1, value: 'agent_cli' },
      { key: 'agentCli', revision: 1, value: 'codex' },
      { key: 'model', revision: 1, value: 'old' }
    ] };
  });
  await new Promise(resolve => setImmediate(resolve));
  const newer = refreshCognitiveRuntimeConfig(root, async () => ({ items: [
    { key: 'mode', revision: 2, value: 'agent_cli' },
    { key: 'agentCli', revision: 2, value: 'codex' },
    { key: 'model', revision: 2, value: 'new' }
  ] }));

  await newer;
  releaseOlder();
  await older;

  assert.equal(readCognitiveRuntimeConfig(root).model, 'new');
});

test('a valid cold refresh remains usable while another refresh is still pending', async () => {
  const root = path.join(os.tmpdir(), `solomap-cognitive-refresh-pending-${process.pid}-${Date.now()}`);
  let releaseEarlier;
  let releaseLater;
  const earlier = refreshCognitiveRuntimeConfig(root, async () => {
    await new Promise(resolve => { releaseEarlier = resolve; });
    return { items: [
      { key: 'mode', revision: 1, value: 'agent_cli' },
      { key: 'agentCli', revision: 1, value: 'codex' },
      { key: 'model', revision: 1, value: 'ready' }
    ] };
  });
  const later = refreshCognitiveRuntimeConfig(root, async () => {
    await new Promise(resolve => { releaseLater = resolve; });
    return { items: [
      { key: 'mode', revision: 2, value: 'agent_cli' },
      { key: 'agentCli', revision: 2, value: 'codex' },
      { key: 'model', revision: 2, value: 'newer' }
    ] };
  });

  releaseEarlier();
  assert.equal((await earlier).model, 'ready');
  assert.equal(readCognitiveRuntimeConfig(root).model, 'ready');
  releaseLater();
  await later;
  assert.equal(readCognitiveRuntimeConfig(root).model, 'newer');
});

test('a concurrent failed refresh cannot suppress a requested cognitive persistence', async () => {
  const root = path.join(os.tmpdir(), `solomap-cognitive-persist-race-${process.pid}-${Date.now()}`);
  const setting = (revision, model) => [
    { key: 'mode', revision, value: 'agent_cli' },
    { key: 'agentCli', revision, value: 'codex' },
    { key: 'model', revision, value: model }
  ];
  await refreshCognitiveRuntimeConfig(root, async () => ({ items: setting(1, 'old') }));
  let databaseItems = setting(2, 'new');
  let releasePersistRead;
  let releaseCompetingRead;
  let persistReadCount = 0;
  const patches = [];
  const operation = async request => {
    if (request.operation === 'read_host_settings') {
      persistReadCount += 1;
      if (persistReadCount === 1) await new Promise(resolve => { releasePersistRead = resolve; });
      return { items: databaseItems };
    }
    if (request.operation === 'patch_host_settings') {
      patches.push(...request.input.patches);
      const values = new Map(databaseItems.map(item => [item.key, item.value]));
      for (const patch of request.input.patches) values.set(patch.key, patch.value);
      databaseItems = ['mode', 'agentCli', 'model'].map(key => ({ key, revision: key === 'model' ? 3 : 2, value: values.get(key) }));
      return { items: databaseItems };
    }
    throw new Error(`unexpected operation: ${request.operation}`);
  };
  const persistence = persistCognitiveRuntimeConfig(root, { mode: 'agent_cli', agentCli: 'codex', model: 'old' }, operation, 'persist-old');
  await new Promise(resolve => setImmediate(resolve));
  const competing = refreshCognitiveRuntimeConfig(root, async () => {
    await new Promise(resolve => { releaseCompetingRead = resolve; });
    throw new Error('competing refresh failed');
  });

  releasePersistRead();
  const result = await persistence;
  releaseCompetingRead();
  await assert.rejects(competing, /competing refresh failed/);

  assert.deepEqual(patches, [{ key: 'model', expectedRevision: 2, value: 'old' }]);
  assert.equal(result.model, 'old');
  assert.equal(readCognitiveRuntimeConfig(root).model, 'old');
});
