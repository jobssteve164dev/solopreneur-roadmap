const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { LocalAgentCliEngine, buildCognitiveCliInvocation } = require('../out/localAgentCliEngine.js');
const { cognitiveRuntimeConfigRevision, readCognitiveRuntimeConfig, writeCognitiveRuntimeConfig } = require('../out/cognitiveRuntimeConfig.js');

test('Codex cognitive invocation is headless, read-only, and shell-free', () => {
  const invocation = buildCognitiveCliInvocation('/usr/local/bin/codex', 'gpt-5', '{"goal":"choose"}');
  assert.equal(invocation.command, '/usr/local/bin/codex');
  assert.deepEqual(invocation.args, ['exec', '--color', 'never', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--model', 'gpt-5', '-']);
  assert.equal(invocation.stdin, '{"goal":"choose"}');
  assert.equal(invocation.shell, false);
  assert.equal(invocation.env.CODEX_HOME, process.env.CODEX_HOME);
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
    fs.rmdirSync(root);
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
    fs.rmdirSync(root);
    fs.rmdirSync(parent);
  }
});
