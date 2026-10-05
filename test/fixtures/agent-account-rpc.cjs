const readline = require('node:readline');
const scenario = process.argv[2];
let initialized = false;
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    send({ id: request.id, result: { userAgent: 'fixture' } });
  } else if (request.method === 'initialized') {
    initialized = true;
  } else if (scenario === 'handshake' && !initialized) {
    send({ id: request.id, error: { code: -32600, message: 'Not initialized' } });
  } else if (request.method === 'account/read') {
    send({ id: request.id, result: { account: scenario === 'signed-out' ? null : { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true } });
  } else if (request.method === 'account/rateLimits/read') {
    if (scenario === 'quota-error' || scenario === 'signed-out') {
      send({ id: request.id, error: { code: -32600, message: 'Unable to retrieve account quota' } });
    } else {
      send({ id: request.id, result: { rateLimits: {
        limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1893456000 }, secondary: null
      }, rateLimitsByLimitId: null } });
    }
  }
});
