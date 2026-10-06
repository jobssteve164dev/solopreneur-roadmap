const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('external CLI configuration installs a shared bridge without replacing other servers or permissions', () => {
  let module;
  try { module = require('../out/agentDatabaseConfig.js'); } catch {}
  assert.ok(module, 'external agent database configuration is missing');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-agent-config-'));
  const command = '/runtime path/node';
  for (const provider of ['codex', 'claude', 'cursor']) {
    const file = path.join(root, provider === 'codex' ? 'config.toml' : provider + '.json');
    const original = provider === 'codex' ? 'model = "keep-model"\n[mcp_servers.other]\ncommand = "keep-command"\n' : JSON.stringify({ mcpServers: { other: { command: 'keep-command' } }, permissions: { allow: ['keep-permission'] } });
    fs.writeFileSync(file, original);
    module.configureAgentDatabase({ provider, configPath: file, command, globalDataPath: '/global path' });
    const once = fs.readFileSync(file, 'utf8');
    module.configureAgentDatabase({ provider, configPath: file, command, globalDataPath: '/global path' });
    assert.equal(fs.readFileSync(file, 'utf8'), once, 'unchanged configuration must not churn');
    if (provider === 'codex') {
      assert.ok(once.includes(original));
      assert.match(once, /\[mcp_servers.solomap_data\]/);
      assert.ok(!once.includes('/extension path/'));
    } else {
      const parsed = JSON.parse(once);
      assert.equal(parsed.mcpServers.other.command, 'keep-command');
      assert.deepEqual(parsed.permissions, { allow: ['keep-permission'] });
      assert.equal(parsed.mcpServers.solomap_data.command, command);
      assert.deepEqual(parsed.mcpServers.solomap_data.args, ['-e', module.databaseBridgeLauncher(), '/global path/.solomap-global']);
      new (require('node:vm').Script)(parsed.mcpServers.solomap_data.args[1]);
      assert.equal(parsed.mcpServers.solomap_data.env.ELECTRON_RUN_AS_NODE, '1');
    }
  }
});

test('task instructions teach revision-safe database writes and complete content reads', () => {
  let module;
  try { module = require('../out/agentDatabaseConfig.js'); } catch {}
  assert.ok(module, 'database task instructions are missing');
  const instructions = module.buildAgentDatabaseInstructions();
  for (const keyword of ['solomap_context', 'solomap_search', 'solomap_read', 'solomap_write', 'expectedRevision', 'idempotencyKey', 'solomap://schema', 'cursor']) assert.ok(instructions.includes(keyword), keyword);
  assert.ok(!instructions.includes('solomap-memory.cjs'));
});

test('all built-in Agent families receive their native MCP format without changing user settings', () => {
  const { configureAgentDatabase } = require('../out/agentDatabaseConfig.js');
  const { parse } = require('jsonc-parser');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-agent-families-'));
  for (const provider of ['opencode', 'copilot', 'grok', 'antigravity']) {
    const file = path.join(root, provider, provider === 'grok' ? 'config.toml' : provider === 'opencode' ? 'opencode.jsonc' : 'mcp_config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = provider === 'grok' ? 'model = "preserved"\n[mcp_servers.original]\ncommand = "preserved"\n' : '{\n// keep this user comment\n"permissions":{"allow":["preserved"]},\n' + (provider === 'opencode' ? '"mcp"' : '"mcpServers"') + ':{"original":{"command":"preserved"}},\n}';
    fs.writeFileSync(file, original);
    configureAgentDatabase({ provider, configPath: file, command: '/native/node', globalDataPath: '/shared/.solomap-global' });
    const once = fs.readFileSync(file, 'utf8');
    configureAgentDatabase({ provider, configPath: file, command: '/native/node', globalDataPath: '/shared/.solomap-global' });
    assert.equal(fs.readFileSync(file, 'utf8'), once);
    if (provider === 'grok') {
      assert.ok(once.includes(original));
      assert.match(once, /\[mcp_servers.solomap_data\]/);
    } else {
      assert.ok(once.includes('// keep this user comment'));
      const parsed = parse(once);
      assert.deepEqual(parsed.permissions, { allow: ['preserved'] });
      const server = (provider === 'opencode' ? parsed.mcp : parsed.mcpServers).solomap_data;
      if (provider === 'opencode') {
        assert.equal(server.type, 'local');
        assert.equal(server.command[0], '/native/node');
        assert.equal(server.environment.SOLOMAP_MANAGED_BRIDGE, '1');
      } else {
        assert.equal(server.command, '/native/node');
        if (provider === 'copilot') {
          assert.equal(server.type, 'local');
          assert.deepEqual(server.tools, ['solomap_context', 'solomap_search', 'solomap_read', 'solomap_write', 'solomap_link', 'solomap_export']);
        }
      }
    }
  }
});

test('native TOML conflicts remain byte-identical and managed server restrictions survive updates', () => {
  const { configureAgentDatabase } = require('../out/agentDatabaseConfig.js');
  const toml = require('@iarna/toml');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-toml-config-'));
  const file = path.join(root, 'config.toml');
  for (const original of ['mcp_servers = { solomap_data = { command = "user-server" } }\n', '["mcp_servers"."solomap_data"]\ncommand="user-server"\n']) {
    assert.ok(toml.parse(original).mcp_servers.solomap_data);
    fs.writeFileSync(file, original);
    assert.throws(() => configureAgentDatabase({ provider: 'codex', configPath: file, command: '/native/node', globalDataPath: '/shared/.solomap-global' }), /name_conflict/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
  fs.writeFileSync(file, 'model = "preserved"\n');
  configureAgentDatabase({ provider: 'codex', configPath: file, command: '/native/node', globalDataPath: '/shared/.solomap-global' });
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('[mcp_servers.solomap_data]\n', '[mcp_servers.solomap_data]\nenabled=false\nstartup_timeout_sec=45\n'));
  configureAgentDatabase({ provider: 'codex', configPath: file, command: '/updated/node', globalDataPath: '/shared/.solomap-global' });
  const saved = toml.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.mcp_servers.solomap_data.enabled, false);
  assert.equal(saved.mcp_servers.solomap_data.startup_timeout_sec, 45);
  assert.equal(saved.mcp_servers.solomap_data.command, '/updated/node');
  assert.equal(saved.model, 'preserved');
});

test('native TOML inline parent tables retain other servers, comments and restrictions', () => {
  const { configureAgentDatabase } = require('../out/agentDatabaseConfig.js');
  const toml = require('@iarna/toml');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-toml-inline-parent-'));
  for (const provider of ['codex', 'grok']) {
    const file = path.join(root, provider + '.toml');
    const original = '# keep header\nmodel = "preserved"\n"mcp_servers" = { other = { command = "other", args = ["{quoted}"] } } # keep comment\n';
    fs.writeFileSync(file, original);
    configureAgentDatabase({ provider, configPath: file, command: '/native/node', globalDataPath: '/shared/.solomap-global' });
    const first = fs.readFileSync(file, 'utf8');
    assert.ok(first.startsWith('# keep header\nmodel = "preserved"\n"mcp_servers" = { other = { command = "other", args = ["{quoted}"] }'));
    assert.ok(first.endsWith('} # keep comment\n'));
    configureAgentDatabase({ provider, configPath: file, command: '/native/node', globalDataPath: '/shared/.solomap-global' });
    assert.equal(fs.readFileSync(file, 'utf8'), first);
    configureAgentDatabase({ provider, configPath: file, command: '/updated/node', globalDataPath: '/shared/.solomap-global' });
    const saved = toml.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.mcp_servers.solomap_data.command, '/updated/node');
    assert.equal(saved.mcp_servers.other.command, 'other');
    assert.deepEqual(saved.mcp_servers.other.args, ['{quoted}']);
    assert.equal(saved.model, 'preserved');
  }
});
