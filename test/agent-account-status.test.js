const assert = require('node:assert/strict');
const test = require('node:test');

const accountStatus = require('../out/agentAccountStatus.js');

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
    plan: 'Pro Plus'
  });
  assert.deepEqual(statuses.find(item => item.family === 'claude'), {
    family: 'claude',
    state: 'ready',
    usageHint: '/status'
  });
  assert.deepEqual(statuses.find(item => item.family === 'antigravity'), {
    family: 'antigravity',
    state: 'in_cli',
    usageHint: '/usage · /credits'
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
    plan: 'Ultra'
  });
});
