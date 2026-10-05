const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const childProcess = require('node:child_process');

const accountStatus = require('../out/agentAccountStatus.js');

function loadWithAccountService(handler, extraModules = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../out/agentAccountStatus.js'), 'utf8'), {
    module, exports: module.exports, process, Buffer, setTimeout, clearTimeout, AbortSignal,
    fetch: handler,
    require(name) {
      if (extraModules[name]) return extraModules[name];
      if (name === 'fs/promises') return { readFile: async file => file.endsWith('auth.json')
        ? JSON.stringify({ accessToken: 'fixture-token' })
        : JSON.stringify({ token: { access_token: 'fixture-token' } }) };
      return require(name);
    }
  });
  return module.exports;
}

test('Agy reads the first-party plan and both grouped quota windows', async () => {
  const requests = [];
  const service = loadWithAccountService(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, json: async () => url.endsWith('loadCodeAssist')
      ? { paidTier: { name: 'Google AI Pro' } }
      : { groups: [{ displayName: 'Gemini Models', buckets: [
        { window: '5h', remainingFraction: 0.75, resetTime: '2030-01-01T00:00:00Z' },
        { window: 'weekly', remainingFraction: 0.9, resetTime: '2030-01-08T00:00:00Z' }
      ] }] } };
  });
  const [status] = await service.readAgentAccountStatuses([{ family: 'antigravity', command: 'agy', installed: true }]);
  assert.equal(status.plan, 'Google AI Pro');
  assert.equal(status.usage[0].usedPercent, 25);
  assert.equal(status.usage[0].label, 'Gemini Models');
  assert.equal(status.usage[1].windowMinutes, 10080);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.match(request.url, /^https:\/\/daily-cloudcode-pa\.googleapis\.com\/v1internal:/);
    assert.equal(request.options.headers['User-Agent'], 'antigravity/2.0');
    assert.equal(request.options.redirect, 'error');
  }
  assert.ok(!JSON.stringify(status).includes('fixture-token'));
});

test('Agy lets its own CLI renew an expired login before reading usage', async () => {
  let renewed = false;
  const service = loadWithAccountService(async () => {
    assert.equal(renewed, true);
    return { ok: true, status: 200, json: async () => ({ paidTier: { name: 'Google AI Pro' }, groups: [] }) };
  }, {
    'fs/promises': { readFile: async () => JSON.stringify({ token: {
      access_token: renewed ? 'new-fixture-token' : 'old-fixture-token',
      expiry: renewed ? '2099-01-01T00:00:00Z' : '2000-01-01T00:00:00Z'
    } }) },
    child_process: { ...childProcess, execFile(command, args, options, callback) {
      assert.equal(command, 'agy');
      assert.deepEqual(Array.from(args), ['models']);
      renewed = true;
      callback(null, '', '');
    } }
  });
  const [status] = await service.readAgentAccountStatuses([{ family: 'antigravity', command: 'agy', installed: true }]);
  assert.equal(renewed, true);
  assert.equal(status.plan, 'Google AI Pro');
});

test('Cursor transport maps actual HTTP 401 to signed out', async () => {
  const service = loadWithAccountService(async () => ({ ok: false, status: 401 }));
  const [status] = await service.readAgentAccountStatuses([{ family: 'cursor', command: 'cursor', installed: true }]);
  assert.equal(status.state, 'signed_out');
});

test('Cursor verifies the saved login remotely and shows billing-period usage', async () => {
  const [status] = await accountStatus.readAgentAccountStatuses([
    { family: 'cursor', command: 'cursor', installed: true }
  ], {
    readCursor: async () => ({ planInfo: { planName: 'pro_plus' }, usage: {
      billingCycleStart: '1893456000000', billingCycleEnd: '1896134400000',
      planUsage: { totalPercentUsed: 35 }
    } }),
    runJson: async () => { throw new Error('should use account service'); }
  });
  assert.equal(status.plan, 'Pro Plus');
  assert.equal(status.usage[0].usedPercent, 35);
  assert.equal(status.usage[0].resetsAt, 1896134400);
});

test('Cursor rejected credentials do not appear logged in', async () => {
  const [status] = await accountStatus.readAgentAccountStatuses([
    { family: 'cursor', command: 'cursor', installed: true }
  ], { readCursor: async () => ({ signedOut: true }) });
  assert.equal(status.state, 'signed_out');
});

test('Cursor handles omitted optional percentage using included spend, like its CLI', async () => {
  const [status] = await accountStatus.readAgentAccountStatuses([{ family: 'cursor', command: 'cursor', installed: true }], {
    readCursor: async () => ({ planInfo: { planName: 'pro' }, usage: {
      billingCycleStart: '1893456000000', billingCycleEnd: '1896134400000',
      planUsage: { includedSpend: 500, limit: 2000 }
    } })
  });
  assert.equal(status.usage?.[0].usedPercent, 25);
});

function loadWithRpcFixture() {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../out/agentAccountStatus.js'), 'utf8'), {
    module, exports: module.exports, process, Buffer, setTimeout, clearTimeout,
    require(name) {
      if (name === 'child_process') return {
        ...childProcess,
        spawn(command, args, options) {
          assert.deepEqual(Array.from(args), ['app-server', '--listen', 'stdio://']);
          return childProcess.spawn(process.execPath, [path.join(__dirname, 'fixtures/agent-account-rpc.cjs'), command], options);
        }
      };
      return require(name);
    }
  });
  return module.exports;
}

test('publishes completed account data without waiting for another Agent', async () => {
  let releaseCodex;
  const updates = [];
  const reading = accountStatus.readAgentAccountStatuses([
    { family: 'codex', command: 'codex', installed: true },
    { family: 'cursor', command: 'cursor-agent', installed: true }
  ], {
    readCodex: () => new Promise(resolve => { releaseCodex = resolve; }),
    readCursor: async () => ({ planInfo: { planName: 'pro' }, usage: { billingCycleStart: 1893456000000, billingCycleEnd: 1896134400000, planUsage: { totalPercentUsed: 0 } } }),
    runJson: async (_command, args) => args[0] === 'status'
      ? { isAuthenticated: true } : { subscriptionTier: 'pro' },
    onStatus: status => updates.push(status)
  });
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(updates.find(item => item.family === 'cursor')?.plan, 'Pro');
  } finally {
    releaseCodex({ account: {} });
    await reading;
  }
});

test('Codex account probe completes the initialized handshake before fetching quota', async () => {
  const statuses = await loadWithRpcFixture().readAgentAccountStatuses([
    { family: 'codex', command: 'handshake', installed: true }
  ]);
  assert.equal(statuses[0].state, 'ready');
  assert.equal(statuses[0].usage?.[0].usedPercent, 25);
});

test('Codex quota RPC failure remains visible rather than reporting a quota-less success', async () => {
  const statuses = await loadWithRpcFixture().readAgentAccountStatuses([
    { family: 'codex', command: 'quota-error', installed: true }
  ]);
  assert.equal(statuses[0].plan, 'Pro');
  assert.equal(statuses[0].usageState, 'error');
});

test('Codex with no account is signed out rather than ready', async () => {
  const statuses = await loadWithRpcFixture().readAgentAccountStatuses([
    { family: 'codex', command: 'signed-out', installed: true }
  ]);
  assert.equal(statuses[0].state, 'signed_out');
});

test('reads official structured account state without inventing unavailable quotas', async () => {
  const agents = [
    { family: 'codex', command: '/bin/codex', installed: true },
    { family: 'cursor', command: '/bin/cursor-agent', installed: true },
    { family: 'claude', command: '/bin/claude', installed: true },
    { family: 'antigravity', command: '/bin/agy', installed: true },
    { family: 'opencode', command: '/bin/opencode', installed: true },
    { family: 'grok', command: '', installed: false }
  ];
  const statuses = await accountStatus.readAgentAccountStatuses(agents, {
    readCursor: async () => ({ planInfo: { planName: 'pro_plus' } }),
    readAntigravity: async () => ({ signedOut: true }),
    readCodex: async () => ({
      account: { type: 'chatgpt', planType: 'pro' },
      rateLimits: {
        ordinaryUsageAllowed: true,
        rateLimits: {
          primary: { usedPercent: 61, windowDurationMins: 300, resetsAt: 1893456000 },
          secondary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: 1894060800 },
          credits: { hasCredits: true, unlimited: false, balance: '7.25' },
          planType: 'pro'
        }
      }
    }),
    runJson: async (_command, args) => {
      if (args[0] === 'about') return { subscriptionTier: 'pro_plus' };
      if (args[0] === 'status') return { isAuthenticated: true };
      if (args[0] === 'auth') return { loggedIn: true, authMethod: 'claude.ai' };
      throw new Error(`unexpected command: ${args.join(' ')}`);
    }
  });

  assert.deepEqual(statuses.find(item => item.family === 'codex'), {
    family: 'codex',
    state: 'ready',
    plan: 'Pro',
    usage: [
      { usedPercent: 61, windowMinutes: 300, resetsAt: 1893456000 },
      { usedPercent: 22, windowMinutes: 10080, resetsAt: 1894060800 }
    ],
    credits: { hasCredits: true, unlimited: false, balance: '7.25' }
  });
  assert.deepEqual(statuses.find(item => item.family === 'cursor'), {
    family: 'cursor',
    state: 'ready',
    plan: 'Pro Plus',
    usageState: 'error'
  });
  assert.deepEqual(statuses.find(item => item.family === 'claude'), {
    family: 'claude',
    state: 'ready',
    usageHint: '/status'
  });
  assert.deepEqual(statuses.find(item => item.family === 'antigravity'), {
    family: 'antigravity',
    state: 'signed_out'
  });
  assert.deepEqual(statuses.find(item => item.family === 'opencode'), {
    family: 'opencode',
    state: 'provider_managed'
  });
  assert.equal(statuses.some(item => item.family === 'grok'), false);
});

test('isolates a provider read failure so other installed Agents still report state', async () => {
  const statuses = await accountStatus.readAgentAccountStatuses([
    { family: 'codex', command: '/bin/codex', installed: true },
    { family: 'cursor', command: '/bin/cursor-agent', installed: true }
  ], {
    readCodex: async () => { throw new Error('offline'); },
    readCursor: async () => ({ planInfo: { planName: 'ultra' } }),
    runJson: async (_command, args) => (
      args[0] === 'status' ? { isAuthenticated: true } : { subscriptionTier: 'ultra' }
    )
  });

  assert.deepEqual(statuses.find(item => item.family === 'codex'), {
    family: 'codex',
    state: 'error'
  });
  assert.deepEqual(statuses.find(item => item.family === 'cursor'), {
    family: 'cursor',
    state: 'ready',
    plan: 'Ultra',
    usageState: 'error'
  });
});
