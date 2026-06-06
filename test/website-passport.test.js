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

test('Passport start redirects extension callbacks through OIDC', async () => {
  const worker = await loadWebsiteWorker();
  const response = await worker.default.fetch(
    new Request(`https://solomap.app/api/passport/start?callback=${encodeURIComponent('vscode://SZLK.solopreneur-roadmap/passport/callback')}`),
    {
      SITE_ORIGIN: 'https://solomap.app',
      SOLOMAP_PASSPORT_PRODUCT_SECRET: 'test-product-secret'
    }
  );
  const location = new URL(response.headers.get('location') || '');

  assert.equal(response.status, 302);
  assert.equal(location.origin, 'https://passport.szlk.ai');
  assert.equal(location.pathname, '/api/oidc/authorize');
  assert.equal(location.searchParams.get('client_id'), 'solomap-vscode');
  assert.equal(location.searchParams.get('redirect_uri'), 'https://solomap.app/api/passport/oidc/callback');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(location.searchParams.get('state'));
});

test('Passport OIDC callback signs an extension grant after upstream access check', async () => {
  const worker = await loadWebsiteWorker();
  const originalFetch = global.fetch;
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://passport.szlk.ai/api/oidc/token') {
      assert.equal(init.method, 'POST');
      return new Response(JSON.stringify({ access_token: 'passport-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://passport.szlk.ai/api/oidc/userinfo') {
      assert.equal(init.headers.authorization, 'Bearer passport-token');
      return new Response(JSON.stringify({ sub: 'passport-user', email: 'pro@solomap.app' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://passport.szlk.ai/api/v1/entitlements/access-check') {
      const body = JSON.parse(init.body);
      assert.equal(body.product, 'solomap');
      assert.equal(body.featureKey, 'strategy_pyramid');
      assert.equal(body.email, 'pro@solomap.app');
      return new Response(JSON.stringify({
        ok: true,
        data: {
          allowed: true,
          email: 'pro@solomap.app',
          userId: 'passport-user',
          entitlements: ['strategy_pyramid']
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const env = {
      SITE_ORIGIN: 'https://solomap.app',
      SOLOMAP_PASSPORT_PRODUCT_SECRET: 'test-product-secret',
      SOLOMAP_PASSPORT_VERIFY_URL: 'https://passport.szlk.ai/api/v1/entitlements/access-check'
    };
    const start = await worker.default.fetch(
      new Request(`https://solomap.app/api/passport/start?callback=${encodeURIComponent('vscode://SZLK.solopreneur-roadmap/passport/callback')}`),
      env
    );
    const state = new URL(start.headers.get('location') || '').searchParams.get('state');
    const callback = await worker.default.fetch(
      new Request(`https://solomap.app/api/passport/oidc/callback?code=auth-code&state=${encodeURIComponent(state || '')}`),
      env
    );
    const location = callback.headers.get('location') || '';
    const grant = new URL(location).searchParams.get('grant') || '';

    assert.equal(callback.status, 302);
    assert.match(location, /^vscode:\/\/SZLK\.solopreneur-roadmap\/passport\/callback/);
    assert.ok(grant);
    assert.doesNotMatch(location, /test-product-secret/);
  } finally {
    global.fetch = originalFetch;
  }
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
