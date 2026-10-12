const test = require('node:test');

test('Codex forwards current run and maintenance credentials without storing their values or dropping existing environment declarations', () => {
  const root = fixtureRoot('solomap-config-run-forward-');
  const file = path.join(root, 'config.toml');
  const module = require('../out/agentDatabaseConfig.js'), toml = require('@iarna/toml');
  module.configureAgentDatabase({ provider: 'codex', configPath: file, command: process.execPath, globalDataPath: '/global/.solomap-global' });
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\nenv_vars\s*=\s*\[[^\]]*\]/, '').replace('[mcp_servers.solomap_data]\n', '[mcp_servers.solomap_data]\nenv_vars=["USER_VARIABLE"]\n'));
  module.configureAgentDatabase({ provider: 'codex', configPath: file, command: process.execPath, globalDataPath: '/global/.solomap-global' });
  const parsed = toml.parse(fs.readFileSync(file, 'utf8')), server = parsed.mcp_servers.solomap_data;
  for (const name of [
    'USER_VARIABLE',
    'SOLOMAP_PROJECT_ID',
    'SOLOMAP_EXECUTION_LOG_ID',
    'SOLOMAP_RUN_GENERATION',
    'SOLOMAP_RUN_PROOF',
    'SOLOMAP_MAINTENANCE_TASK_ID',
    'SOLOMAP_MAINTENANCE_PROOF',
    'SOLOMAP_MAINTENANCE_LAUNCH_TOKEN',
    'SOLOMAP_MAINTENANCE_RUNTIME_ID',
    'SOLOMAP_MAINTENANCE_RUNTIME_PORT',
    'SOLOMAP_MAINTENANCE_ENTRY_PATH'
  ]) assert.ok(server.env_vars.includes(name), name);
  assert.equal(Object.hasOwn(server.env, 'SOLOMAP_RUN_PROOF'), false);
  const once = fs.readFileSync(file, 'utf8');
  module.configureAgentDatabase({ provider: 'codex', configPath: file, command: process.execPath, globalDataPath: '/global/.solomap-global' });
  assert.equal(fs.readFileSync(file, 'utf8'), once);
});
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fixtureRoots = [];
function fixtureRoot(prefix) { const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); fixtureRoots.push(root); return root; }
function cleanupExact(root) {
  if (!fs.existsSync(root)) return;
  const directories = [root], files = [];
  const inventory = directory => fs.readdirSync(directory).forEach(name => { const target = path.join(directory, name); if (fs.lstatSync(target).isDirectory()) { directories.push(target); inventory(target); } else files.push(target); });
  inventory(root); files.forEach(file => fs.unlinkSync(file)); directories.sort((a, b) => b.length - a.length).forEach(directory => fs.rmdirSync(directory));
}
test.after(() => fixtureRoots.forEach(cleanupExact));

test('external CLI configuration installs a shared bridge without replacing other servers or permissions', () => {
  let module;
  try { module = require('../out/agentDatabaseConfig.js'); } catch {}
  assert.ok(module, 'external agent database configuration is missing');
  const root = fixtureRoot('solomap-agent-config-');
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
  const root = fixtureRoot('solomap-agent-families-');
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
          assert.deepEqual(server.tools, ['solomap_context', 'solomap_search', 'solomap_read', 'solomap_write', 'solomap_link', 'solomap_export', 'solomap_migration_start', 'solomap_migration_status', 'solomap_migration_retry', 'solomap_recycling_preview', 'solomap_recycling_apply', 'solomap_maintenance_finish']);
        }
      }
    }
  }
});

test('managed Copilot configuration gains maintenance tools on upgrade', () => {
  const { configureAgentDatabase } = require('../out/agentDatabaseConfig.js');
  const root = fixtureRoot('solomap-copilot-upgrade-');
  const file = path.join(root, 'mcp-config.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { solomap_data: {
    type: 'local', command: '/old/node', args: [], env: { SOLOMAP_MANAGED_BRIDGE: '1' }, tools: ['solomap_context', 'solomap_search']
  } } }));
  configureAgentDatabase({ provider: 'copilot', configPath: file, command: '/new/node', globalDataPath: '/shared/.solomap-global' });
  const tools = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.solomap_data.tools;
  assert.ok(tools.includes('solomap_recycling_apply'));
  assert.ok(tools.includes('solomap_maintenance_finish'));
});

test('native TOML conflicts remain byte-identical and managed server restrictions survive updates', () => {
  const { configureAgentDatabase } = require('../out/agentDatabaseConfig.js');
  const toml = require('@iarna/toml');
  const root = fixtureRoot('solomap-toml-config-');
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
  const root = fixtureRoot('solomap-toml-inline-parent-');
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

test('Claude database configuration follows the native legacy config file without replacing its contents', () => {
  const root = fixtureRoot('solomap-claude-legacy-config-');
  const rawHome = path.join(root, 'home-e\u0301'); const nativeHome = rawHome.normalize('NFC');
  fs.mkdirSync(nativeHome);
  const legacy = path.join(nativeHome, '.config.json'); const value = { theme: 'dark', mcpServers: { other: { command: 'keep-command' } } };
  fs.writeFileSync(legacy, JSON.stringify(value));
  const previous = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = rawHome;
  try {
    const module = require('../out/agentDatabaseConfig.js');
    const selected = module.agentDatabaseConfigPath('claude'); assert.equal(selected, legacy);
    assert.equal(module.isAgentDatabaseConfigPath('claude', selected), true);
    module.configureAgentDatabase({ provider: 'claude', configPath: selected, command: process.execPath, globalDataPath: path.join(root, 'data') });
    const result = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    assert.equal(result.theme, 'dark'); assert.deepEqual(result.mcpServers.other, value.mcpServers.other);
    assert.ok(result.mcpServers.solomap_data);
    assert.equal(fs.existsSync(path.join(rawHome, '.claude.json')), false);
    const once = fs.readFileSync(legacy); module.configureAgentDatabase({ provider: 'claude', configPath: selected, command: process.execPath, globalDataPath: path.join(root, 'data') });
    assert.deepEqual(fs.readFileSync(legacy), once);
  } finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; }
});

test('a concurrent CLI configuration edit is preserved at the replacement boundary', () => {
  const { configureAgentDatabase } = require('../out/agentDatabaseConfig.js');
  const root = fixtureRoot('solomap-agent-config-race-'), file = path.join(root, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ userSetting: 'before' }));
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (source === file && destination.endsWith('.displaced')) fs.writeFileSync(file, JSON.stringify({ userSetting: 'CONCURRENT' }));
    return rename(source, destination);
  };
  try {
    assert.throws(() => configureAgentDatabase({ provider: 'cursor', configPath: file, command: process.execPath, globalDataPath: '/global' }), /changed_during_write/);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { userSetting: 'CONCURRENT' });
});

test('a concurrent rename replacement is preserved at the configuration boundary', () => {
  const { configureAgentDatabase } = require('../out/agentDatabaseConfig.js');
  const root = fixtureRoot('solomap-agent-config-rename-race-'), file = path.join(root, 'mcp.json'), concurrent = path.join(root, 'concurrent.json');
  fs.writeFileSync(file, JSON.stringify({ userSetting: 'before' }));
  fs.writeFileSync(concurrent, JSON.stringify({ userSetting: 'CONCURRENT_RENAME' }));
  const rename = fs.renameSync; let injected = false;
  fs.renameSync = (source, destination) => {
    if (!injected && source === file && destination.endsWith('.displaced')) { injected = true; rename(concurrent, file); }
    return rename(source, destination);
  };
  try {
    assert.throws(() => configureAgentDatabase({ provider: 'cursor', configPath: file, command: process.execPath, globalDataPath: '/global' }), /changed_during_write/);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { userSetting: 'CONCURRENT_RENAME' });
});
