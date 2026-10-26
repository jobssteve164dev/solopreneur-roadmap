const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { commandExists, resolveExecutablePath } = require('../out/agentCli.js');

test('the managed test runner provides isolated Agent CLI executables without using the host account', () => {
  const fixtureRoot = process.env.SOLOMAP_TEST_AGENT_CLI_FIXTURE_DIR || '';
  assert.ok(fixtureRoot, 'the test wrapper must publish its owned Agent CLI fixture root');
  for (const name of ['agy', 'codex', 'claude', 'copilot', 'cursor-agent', 'opencode', 'grok']) {
    const expected = path.join(fixtureRoot, process.platform === 'win32' ? `${name}.cmd` : name);
    assert.equal(fs.existsSync(expected), true, `${name} fixture must exist`);
    assert.equal(commandExists(name), true, `${name} fixture must be discoverable`);
    assert.equal(path.resolve(resolveExecutablePath(name)), path.resolve(expected));
    assert.match(childProcess.execFileSync(expected, ['--version'], { encoding: 'utf8' }), /SoloMap test Agent CLI fixture/);
  }
});
