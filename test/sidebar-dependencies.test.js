const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { getDependencyStatus } = require('../out/sidebarDependencies.js');

test('slow dependency probes leave the host event loop free and discover each shell only once', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-dependency-probe-'));
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  const shell = path.join(base, 'fixture-shell');
  const shellCalls = path.join(base, 'shell-calls');
  fs.writeFileSync(shell, `#!/bin/sh\nprintf x >> '${shellCalls}'\n/bin/sleep 0.15\nprintf '%s' '${bin}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\n/bin/sleep 0.15\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const previous = { SHELL: process.env.SHELL, PATH: process.env.PATH, HOME: process.env.HOME };
  Object.assign(process.env, { SHELL: shell, PATH: bin, HOME: base });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let heartbeat = false;
  const timer = setTimeout(() => { heartbeat = true; }, 10);
  t.after(() => clearTimeout(timer));

  const status = await getDependencyStatus('codex');

  assert.equal(heartbeat, true, 'a pending shell or GitHub check must not block unrelated card responses');
  assert.equal(status.agentReady, true);
  assert.equal(status.githubAuthReady, true);
  assert.equal(status.supportedAgents.find(agent => agent.family === 'codex').command, path.join(bin, 'codex'));
  assert.equal(fs.readFileSync(shellCalls, 'utf8'), 'x', 'one readiness check must not reopen the login shell for every executable');
});
