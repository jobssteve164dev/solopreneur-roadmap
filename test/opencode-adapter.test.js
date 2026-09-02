const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const adapter = require(path.join(projectRoot, 'out', 'openCodeAdapter.js'));
const agentCli = require(path.join(projectRoot, 'out', 'agentCli.js'));
const sidebarDependencies = require(path.join(projectRoot, 'out', 'sidebarDependencies.js'));

test('OpenCode adapter normalizes providers and stores provider-scoped secret names', () => {
  assert.equal(adapter.normalizeOpenCodeProvider(' OpenAI '), 'openai');
  assert.equal(adapter.normalizeOpenCodeProvider('bad/provider'), '');
  assert.equal(adapter.getOpenCodeProviderFromModel('anthropic/claude-sonnet-4'), 'anthropic');
  assert.equal(adapter.getOpenCodeProviderFromModel('auto'), '');
  assert.equal(adapter.getOpenCodeApiKeySecretKey('openrouter'), 'solomap.opencode.apiKey.openrouter');
});

test('OpenCode adapter provides an immediate provider baseline without CLI discovery', () => {
  const providers = adapter.getDefaultOpenCodeProviderOptions();
  assert.ok(providers.length >= 10);
  assert.deepEqual(providers.find(provider => provider.value === 'openai'), { value: 'openai', label: 'OpenAI' });
  assert.deepEqual(providers.find(provider => provider.value === 'anthropic'), { value: 'anthropic', label: 'Anthropic' });
  assert.deepEqual(providers.find(provider => provider.value === 'openrouter'), { value: 'openrouter', label: 'OpenRouter' });
});

test('OpenCode adapter injects only the selected provider key into OpenCode terminals', () => {
  const env = adapter.buildOpenCodeTerminalEnvironment(
    'opencode',
    'anthropic/claude-sonnet-4',
    'openai',
    'secret-value'
  );
  assert.deepEqual(JSON.parse(env.OPENCODE_AUTH_CONTENT), {
    anthropic: { type: 'api', key: 'secret-value' }
  });
  assert.equal(adapter.buildOpenCodeTerminalEnvironment('codex', 'gpt-5', 'openai', 'secret-value'), undefined);
  assert.equal(adapter.buildOpenCodeTerminalEnvironment('opencode', 'auto', '', 'secret-value'), undefined);
});

test('OpenCode adapter stores and removes API keys by provider without exposing them as settings', async () => {
  const secrets = new Map();
  const secretStore = {
    get: async key => secrets.get(key),
    store: async (key, value) => { secrets.set(key, value); },
    delete: async key => { secrets.delete(key); }
  };
  await adapter.updateOpenCodeApiKey(secretStore, 'openai', '  secret-value  ');
  assert.equal(await adapter.readOpenCodeApiKey(secretStore, 'openai'), 'secret-value');
  assert.equal(await adapter.readOpenCodeApiKey(secretStore, 'anthropic'), '');
  await adapter.updateOpenCodeApiKey(secretStore, 'openai', '', true);
  assert.equal(await adapter.readOpenCodeApiKey(secretStore, 'openai'), '');
});

test('OpenCode task launches use its supported automatic permission mode', () => {
  const executable = '/usr/local/bin/opencode';
  const workspaceRoot = '/workspace/app';
  const promptFilePath = '/workspace/app/.solopreneur/agent-runs/2/prompt.txt';
  const status = agentCli.getAgentTaskAutomationStatus(executable);

  assert.deepEqual(status, {
    supported: true,
    preconfigured: false,
    permissionArgs: '--auto',
    message: `SoloMap can prepare ${executable} automatically for task runs.`
  });
  assert.equal(agentCli.ensureAgentTaskAutomation(executable).ok, true);
  assert.equal(
    agentCli.buildAgentCommand(executable, 'Ship the MVP', workspaceRoot, '', 'always'),
    "(cd '/workspace/app' && '/usr/local/bin/opencode' run --auto 'Ship the MVP')"
  );
  assert.match(
    agentCli.buildAgentCommandForPromptFile(executable, promptFilePath, workspaceRoot, 'always'),
    /^\(cd '\/workspace\/app' && '\/usr\/local\/bin\/opencode' run --auto /
  );
  assert.match(
    agentCli.buildInteractiveAgentCommandForPromptFile(executable, promptFilePath, workspaceRoot, 'always'),
    /^\(cd '\/workspace\/app' && '\/usr\/local\/bin\/opencode' --auto --prompt /
  );
  assert.match(
    agentCli.buildInteractiveAgentContinuationCommandForPromptFile(executable, promptFilePath, workspaceRoot, 'session-123', 'always'),
    /^\(cd '\/workspace\/app' && '\/usr\/local\/bin\/opencode' --session 'session-123' --auto --prompt /
  );
  assert.equal(
    agentCli.buildAgentCommandFromShellVar(executable, 'agent_prompt', workspaceRoot, 'always'),
    "'/usr/local/bin/opencode' run --auto \"$agent_prompt\""
  );
});

test('prepared OpenCode wrapper keeps --auto on the correct command layer', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-opencode-wrapper-'));
  const executable = path.join(fixtureRoot, 'opencode');
  fs.writeFileSync(executable, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n', { mode: 0o755 });
  const prepared = sidebarDependencies.buildAgentAutomationWrapper(executable, path.join(fixtureRoot, 'global'), []);
  assert.equal(prepared.ok, true);
  assert.ok(prepared.wrapperPath);

  const run = (command, env = {}) => {
    const result = childProcess.spawnSync('/bin/sh', ['-c', command], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: { ...process.env, ...env }
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split('\n');
  };
  const task = agentCli.buildAgentCommandForPromptFile(prepared.wrapperPath, '/workspace/prompt.txt', fixtureRoot);
  const interactive = agentCli.buildInteractiveAgentCommandForPromptFile(prepared.wrapperPath, '/workspace/prompt.txt', fixtureRoot);
  const continuation = agentCli.buildInteractiveAgentContinuationCommandForPromptFile(
    prepared.wrapperPath,
    '/workspace/prompt.txt',
    fixtureRoot,
    'session-123'
  );
  const shellVariable = agentCli.buildAgentCommandFromShellVar(prepared.wrapperPath, 'agent_prompt', fixtureRoot);

  assert.deepEqual(run(task).slice(0, 2), ['run', '--auto']);
  assert.deepEqual(run(interactive).slice(0, 2), ['--auto', '--prompt']);
  assert.deepEqual(run(continuation).slice(0, 4), ['--auto', '--session', 'session-123', '--prompt']);
  assert.deepEqual(run(shellVariable, { agent_prompt: 'Ship the MVP' }), ['run', '--auto', 'Ship the MVP']);
});

test('SoloMap settings expose OpenCode provider and secure key actions only for OpenCode', () => {
  const webview = fs.readFileSync(path.join(projectRoot, 'src', 'sidebarWebview.ts'), 'utf8');
  const contracts = fs.readFileSync(path.join(projectRoot, 'src', 'pluginContracts.ts'), 'utf8');
  assert.match(webview, /id="setting-opencode-provider"/);
  assert.match(webview, /id="setting-opencode-api-key"[^>]*type="password"|type="password"[^>]*id="setting-opencode-api-key"/);
  assert.match(webview, /getAgentFamilyKey\(getEffectiveSettingCliPath\(\)\) === 'opencode'/);
  assert.match(webview, /openCodeRemoveApiKey/);
  assert.doesNotMatch(contracts, /openCodeApiKey\??:/);
});
