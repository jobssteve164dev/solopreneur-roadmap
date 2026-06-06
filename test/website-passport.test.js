const assert = require('node:assert/strict');
const test = require('node:test');

const projectRootUrl = new URL('../', `file://${__dirname}/`);

async function loadWebsiteWorker() {
  return import(new URL('website/src/worker.js', projectRootUrl));
}

test('website Pro CTA uses Passport authorization entry', async () => {
  const worker = await loadWebsiteWorker();
  const response = await worker.default.fetch(new Request('https://solomap.app/'), { SITE_ORIGIN: 'https://solomap.app' });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /href="\/api\/passport\/start"/);
  assert.doesNotMatch(html, /issues\/new[^"]*Join Pro Early Access/);
});

test('Passport start rejects non-extension callbacks', async () => {
  const worker = await loadWebsiteWorker();
  const response = await worker.default.fetch(
    new Request('https://solomap.app/api/passport/start?callback=https%3A%2F%2Fevil.example%2Fcb'),
    { SITE_ORIGIN: 'https://solomap.app' }
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.reason, 'invalid_callback');
});

test('Passport dev grant redirects to VS Code callback and verifies without exposing product secret', async () => {
  const worker = await loadWebsiteWorker();
  const env = {
    SITE_ORIGIN: 'https://solomap.app',
    SOLOMAP_PASSPORT_DEV_GRANTS: '1',
    SOLOMAP_PASSPORT_PRODUCT_SECRET: 'test-product-secret'
  };
  const callback = 'vscode://SZLK.solopreneur-roadmap/passport/callback';
  const start = await worker.default.fetch(
    new Request(`https://solomap.app/api/passport/start?callback=${encodeURIComponent(callback)}&email=pro%40solomap.app`),
    env
  );
  const location = start.headers.get('location') || '';
  const grant = new URL(location).searchParams.get('grant') || '';

  assert.equal(start.status, 302);
  assert.match(location, /^vscode:\/\/SZLK\.solopreneur-roadmap\/passport\/callback/);
  assert.ok(grant);
  assert.doesNotMatch(location, /test-product-secret/);

  const verified = await worker.default.fetch(
    new Request('https://solomap.app/api/passport/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product: 'solomap', feature: 'strategy_pyramid', grant })
    }),
    env
  );
  const body = await verified.json();

  assert.equal(verified.status, 200);
  assert.equal(body.allowed, true);
  assert.equal(body.email, 'pro@solomap.app');
  assert.ok(body.entitlements.includes('strategy_pyramid'));
});
