const assert = require('node:assert/strict');
const test = require('node:test');

const projectRootUrl = new URL('../', `file://${__dirname}/`);

async function loadWebsiteWorker() {
  return import(new URL('website/src/worker.js', projectRootUrl));
}

test('website Pro CTA uses dedicated subscription page before authorization', async () => {
  const worker = await loadWebsiteWorker();
  const response = await worker.default.fetch(new Request('https://solomap.app/'), { SITE_ORIGIN: 'https://solomap.app' });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /href="\/pro"/);
  assert.doesNotMatch(html, /issues\/new[^"]*Join Pro Early Access/);
});

test('Pro subscription page carries signed upgrade state into Passport start', async () => {
  const worker = await loadWebsiteWorker();
  const callback = 'vscode://SZLK.solopreneur-roadmap/passport/callback';
  const response = await worker.default.fetch(
    new Request(`https://solomap.app/pro?mode=callback&auth_nonce=${'a'.repeat(32)}&callback=${encodeURIComponent(callback)}`),
    {
      SITE_ORIGIN: 'https://solomap.app',
      SOLOMAP_PASSPORT_PRODUCT_SECRET: 'test-product-secret'
    }
  );
  const html = await response.text();
  const href = html.match(/href="([^"]*\/api\/passport\/start\?upgrade_state=[^"]+)"/)?.[1] || '';
  const start = await worker.default.fetch(new Request(new URL(href, 'https://solomap.app').toString()), {
    SITE_ORIGIN: 'https://solomap.app',
    SOLOMAP_PASSPORT_PRODUCT_SECRET: 'test-product-secret'
  });
  const location = new URL(start.headers.get('location') || '');

  assert.equal(response.status, 200);
  assert.match(html, /Know which project deserves your next month/);
  assert.match(html, /Free vs Pro/);
  assert.match(html, /Strategy Pyramid/);
  assert.match(html, /Reliable progress history/);
  assert.match(html, /Goal-driven autopilot/);
  assert.match(html, /VS Code Marketplace/);
  assert.match(html, /Privacy \/ Local-first note/);
  assert.doesNotMatch(html, /Passport|bridgeId|entitlement key|toolCount|CloudMCP|Planner|Builder|Verifier|scoring|micro execution|exchange code/);
  assert.doesNotMatch(html.replace(/<script[\s\S]*?<\/script>/g, ''), /framed as|configuration work|planned Pro outcomes|component purpose/);
  assert.ok(href);
  assert.equal(start.status, 302);
  assert.equal(location.origin, 'https://passport.szlk.ai');
  assert.equal(location.searchParams.get('redirect_uri'), 'https://solomap.app/api/passport/oidc/callback');
  assert.ok(location.searchParams.get('state'));
});

test('Chinese Pro subscription page stays inside the website frame and explains Pro value', async () => {
  const worker = await loadWebsiteWorker();
  const response = await worker.default.fetch(
    new Request(`https://solomap.app/zh/pro?mode=device&auth_nonce=${'b'.repeat(32)}`),
    {
      SITE_ORIGIN: 'https://solomap.app',
      SOLOMAP_PASSPORT_PRODUCT_SECRET: 'test-product-secret'
    }
  );
  const html = await response.text();
  const href = html.match(/href="([^"]*\/api\/passport\/start\?upgrade_state=[^"]+)"/)?.[1] || '';

  assert.equal(response.status, 200);
  assert.match(html, /<header class="topbar">/);
  assert.match(html, /<footer>/);
  assert.match(html, /Free 与 Pro 的区别/);
  assert.match(html, /战略金字塔/);
  assert.match(html, /可靠推进历史/);
  assert.match(html, /目标自动推进/);
  assert.match(html, /仍然本地优先/);
  assert.match(html, /href="\/pro" hreflang="en"/);
  assert.doesNotMatch(html, /Passport|bridgeId|entitlement key|toolCount|CloudMCP|Planner|Builder|Verifier|scoring|微观|证据链|exchange code/);
  assert.doesNotMatch(html.replace(/<script[\s\S]*?<\/script>/g, ''), /页面只表达|内部配置|功能规划|功能方向|不要求用户理解/);
  assert.ok(href);
});

test('Pro subscription page remains readable when signing is unavailable', async () => {
  const worker = await loadWebsiteWorker();
  const response = await worker.default.fetch(
    new Request(`https://solomap.app/zh/pro?mode=device&auth_nonce=${'c'.repeat(32)}`),
    { SITE_ORIGIN: 'https://solomap.app' }
  );
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Free 与 Pro 的区别/);
  assert.match(html, /href="\/api\/passport\/start"/);
  assert.doesNotMatch(html, /missing_product_secret|Passport|CloudMCP/);
});

test('sitemap exposes indexable canonical URLs with hreflang and freshness signals', async () => {
  const worker = await loadWebsiteWorker();
  const response = await worker.default.fetch(
    new Request('https://solomap.app/sitemap.xml'),
    { SITE_ORIGIN: 'https://solomap.app' }
  );
  const xml = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
  assert.match(xml, /<loc>https:\/\/solomap\.app\/pro<\/loc>/);
  assert.match(xml, /<loc>https:\/\/solomap\.app\/zh\/pro<\/loc>/);
  assert.match(xml, /<lastmod>2026-06-06<\/lastmod>/);
  assert.match(xml, /<changefreq>weekly<\/changefreq>/);
  assert.match(xml, /<priority>0\.9<\/priority>/);
  assert.match(xml, /hreflang="x-default" href="https:\/\/solomap\.app\/pro"/);
  assert.doesNotMatch(xml, /upgrade_state|auth_nonce|callback|\/api\/passport/);
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

test('Passport start accepts Code OSS extension callbacks through OIDC', async () => {
  const worker = await loadWebsiteWorker();
  const response = await worker.default.fetch(
    new Request(`https://solomap.app/api/passport/start?product=solomap&feature=strategy_pyramid&callback=${encodeURIComponent('code-oss://SZLK.solopreneur-roadmap/passport/callback')}`),
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

test('Pro upgrade callback returns a nonce-bound exchange code', async () => {
  const worker = await loadWebsiteWorker();
  const originalFetch = global.fetch;
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://passport.szlk.ai/api/oidc/token') {
      return new Response(JSON.stringify({ access_token: 'passport-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://passport.szlk.ai/api/oidc/userinfo') {
      return new Response(JSON.stringify({ sub: 'passport-user', email: 'pro@solomap.app' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://passport.szlk.ai/api/v1/entitlements/access-check') {
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
    const callback = 'vscode://SZLK.solopreneur-roadmap/passport/callback';
    const authNonce = 'n'.repeat(32);
    const pro = await worker.default.fetch(
      new Request(`https://solomap.app/pro?mode=callback&auth_nonce=${authNonce}&callback=${encodeURIComponent(callback)}`),
      env
    );
    const href = (await pro.text()).match(/href="([^"]*\/api\/passport\/start\?upgrade_state=[^"]+)"/)?.[1] || '';
    const start = await worker.default.fetch(new Request(new URL(href, 'https://solomap.app').toString()), env);
    const state = new URL(start.headers.get('location') || '').searchParams.get('state');
    const callbackResponse = await worker.default.fetch(
      new Request(`https://solomap.app/api/passport/oidc/callback?code=auth-code&state=${encodeURIComponent(state || '')}`),
      env
    );
    const location = callbackResponse.headers.get('location') || '';
    const code = new URL(location).searchParams.get('code') || '';
    const denied = await worker.default.fetch(
      new Request('https://solomap.app/api/passport/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, authNonce: 'wrong'.repeat(8), callback })
      }),
      env
    );
    const allowed = await worker.default.fetch(
      new Request('https://solomap.app/api/passport/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, authNonce, callback })
      }),
      env
    );
    const deniedBody = await denied.json();
    const allowedBody = await allowed.json();

    assert.equal(callbackResponse.status, 302);
    assert.match(location, /^vscode:\/\/SZLK\.solopreneur-roadmap\/passport\/callback\?code=/);
    assert.ok(code);
    assert.equal(deniedBody.allowed, false);
    assert.equal(deniedBody.reason, 'auth_context_mismatch');
    assert.equal(allowedBody.allowed, true);
    assert.ok(allowedBody.grant);
    assert.notEqual(allowedBody.grant, code);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Passport OIDC callback redirects unpaid extension users to Pro checkout', async () => {
  const worker = await loadWebsiteWorker();
  const originalFetch = global.fetch;
  let checkoutPayload = null;
  let checkoutCalls = 0;
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://passport.szlk.ai/api/oidc/token') {
      return new Response(JSON.stringify({ access_token: 'passport-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://passport.szlk.ai/api/oidc/userinfo') {
      return new Response(JSON.stringify({ sub: 'passport-user-free', email: 'free@solomap.app' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://passport.szlk.ai/api/v1/entitlements/access-check') {
      return new Response(JSON.stringify({
        ok: true,
        data: {
          allowed: false,
          reason: 'not_entitled',
          email: 'free@solomap.app',
          userId: 'passport-user-free',
          entitlements: []
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://passport.szlk.ai/api/v1/billing/checkout-link') {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['x-szlk-product'], 'solomap');
      assert.equal(init.headers['x-szlk-secret'], 'test-product-secret');
      checkoutCalls += 1;
      checkoutPayload = JSON.parse(init.body);
      return new Response(JSON.stringify({
        ok: true,
        data: {
          checkout: {
            url: 'https://checkout.stripe.com/c/pay/cs_solomap_pro'
          }
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
    const callback = 'vscode://SZLK.solopreneur-roadmap/passport/callback';
    const start = await worker.default.fetch(
      new Request(`https://solomap.app/api/passport/start?callback=${encodeURIComponent(callback)}`),
      env
    );
    const state = new URL(start.headers.get('location') || '').searchParams.get('state');
    const response = await worker.default.fetch(
      new Request(`https://solomap.app/api/passport/oidc/callback?code=auth-code&state=${encodeURIComponent(state || '')}`),
      env
    );

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_solomap_pro');
    assert.equal(checkoutPayload.product, 'solomap');
    assert.equal(checkoutPayload.planId, 'solomap_pro_early_access_yearly');
    assert.equal(checkoutPayload.customerEmail, 'free@solomap.app');
    assert.equal(checkoutPayload.userId, 'passport-user-free');
    assert.match(checkoutPayload.successUrl, /^https:\/\/solomap\.app\/api\/passport\/checkout\/success\?/);
    const successUrl = new URL(checkoutPayload.successUrl);
    assert.ok(successUrl.searchParams.get('state'));
    assert.equal(checkoutPayload.cancelUrl, 'https://solomap.app/#pro');
    const pending = await worker.default.fetch(new Request(checkoutPayload.successUrl), env);
    assert.equal(pending.status, 200);
    assert.match(await pending.text(), /正在确认 SoloMap Pro/);
    assert.equal(checkoutCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Passport device auth returns a browser login URL and verifies the pasted grant', async () => {
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
      new Request('https://solomap.app/api/passport/device/start', { method: 'POST' }),
      env
    );
    const startBody = await start.json();
    const authorize = await worker.default.fetch(new Request(startBody.loginUrl), env);
    const authorizeLocation = new URL(authorize.headers.get('location') || '');
    const state = authorizeLocation.searchParams.get('state');
    const callback = await worker.default.fetch(
      new Request(`https://solomap.app/api/passport/oidc/callback?code=auth-code&state=${encodeURIComponent(state || '')}`),
      env
    );
    const html = await callback.text();
    const grant = html.match(/<textarea id="code" readonly>([^<]+)<\/textarea>/)?.[1] || '';
    const verify = await worker.default.fetch(
      new Request('https://solomap.app/api/passport/device/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: startBody.deviceCode, code: grant })
      }),
      env
    );
    const verifyBody = await verify.json();

    assert.equal(start.status, 200);
    assert.equal(startBody.ok, true);
    assert.equal(startBody.expiresIn, 1800);
    assert.match(startBody.loginUrl, /^https:\/\/solomap\.app\/api\/passport\/device\/authorize\?device=/);
    assert.equal(authorize.status, 302);
    assert.equal(authorizeLocation.origin, 'https://passport.szlk.ai');
    assert.equal(callback.status, 200);
    assert.match(html, /SoloMap Pro 已授权/);
    assert.ok(grant);
    assert.equal(verify.status, 200);
    assert.equal(verifyBody.allowed, true);
    assert.deepEqual(verifyBody.entitlements, ['strategy_pyramid']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Passport device auth redirects unpaid users to Pro checkout and resumes device authorization', async () => {
  const worker = await loadWebsiteWorker();
  const originalFetch = global.fetch;
  let checkoutPayload = null;
  let checkoutCalls = 0;
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://passport.szlk.ai/api/oidc/token') {
      return new Response(JSON.stringify({ access_token: 'passport-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://passport.szlk.ai/api/oidc/userinfo') {
      return new Response(JSON.stringify({ sub: 'passport-user-free', email: 'free@solomap.app' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://passport.szlk.ai/api/v1/entitlements/access-check') {
      return new Response(JSON.stringify({
        ok: true,
        data: {
          allowed: false,
          reason: 'not_entitled',
          email: 'free@solomap.app',
          userId: 'passport-user-free',
          entitlements: []
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://passport.szlk.ai/api/v1/billing/checkout-link') {
      checkoutCalls += 1;
      checkoutPayload = JSON.parse(init.body);
      return new Response(JSON.stringify({
        ok: true,
        data: {
          checkout: {
            url: 'https://checkout.stripe.com/c/pay/cs_solomap_device'
          }
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
      new Request('https://solomap.app/api/passport/device/start', { method: 'POST' }),
      env
    );
    const startBody = await start.json();
    const authorize = await worker.default.fetch(new Request(startBody.loginUrl), env);
    const state = new URL(authorize.headers.get('location') || '').searchParams.get('state');
    const response = await worker.default.fetch(
      new Request(`https://solomap.app/api/passport/oidc/callback?code=auth-code&state=${encodeURIComponent(state || '')}`),
      env
    );

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_solomap_device');
    assert.equal(checkoutPayload.planId, 'solomap_pro_early_access_yearly');
    assert.match(checkoutPayload.successUrl, /^https:\/\/solomap\.app\/api\/passport\/checkout\/success\?/);
    assert.ok(new URL(checkoutPayload.successUrl).searchParams.get('state'));
    const pending = await worker.default.fetch(new Request(checkoutPayload.successUrl), env);
    assert.equal(pending.status, 200);
    assert.match(await pending.text(), /正在确认 SoloMap Pro/);
    assert.equal(checkoutCalls, 1);
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
