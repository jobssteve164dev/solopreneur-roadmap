const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const adapter = require(path.join(projectRoot, 'out', 'openCodeAdapter.js'));

test('OpenCode adapter normalizes providers and stores provider-scoped secret names', () => {
  assert.equal(adapter.normalizeOpenCodeProvider(' OpenAI '), 'openai');
  assert.equal(adapter.normalizeOpenCodeProvider('bad/provider'), '');
  assert.equal(adapter.getOpenCodeProviderFromModel('anthropic/claude-sonnet-4'), 'anthropic');
  assert.equal(adapter.getOpenCodeProviderFromModel('auto'), '');
  assert.equal(adapter.getOpenCodeApiKeySecretKey('openrouter'), 'solomap.opencode.apiKey.openrouter');
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

test('SoloMap settings expose OpenCode provider and secure key actions only for OpenCode', () => {
  const webview = fs.readFileSync(path.join(projectRoot, 'src', 'sidebarWebview.ts'), 'utf8');
  const contracts = fs.readFileSync(path.join(projectRoot, 'src', 'pluginContracts.ts'), 'utf8');
  assert.match(webview, /id="setting-opencode-provider"/);
  assert.match(webview, /id="setting-opencode-api-key"[^>]*type="password"|type="password"[^>]*id="setting-opencode-api-key"/);
  assert.match(webview, /getAgentFamilyKey\(getEffectiveSettingCliPath\(\)\) === 'opencode'/);
  assert.match(webview, /openCodeRemoveApiKey/);
  assert.doesNotMatch(contracts, /openCodeApiKey\??:/);
});
