const assert = require('node:assert/strict');
const test = require('node:test');

const projectRootUrl = new URL('../', `file://${__dirname}/`);

async function loadWebsiteWorker() {
  return import(new URL('website/src/worker.js', projectRootUrl));
}

async function sessionCookie(env, user) {
  const { createSessionCookie } = await import(new URL('website/src/headlessAuth.js', projectRootUrl));
  return (await createSessionCookie(new Request('https://solomap.app/login'), env, user)).split(';')[0];
}

const testProPlan = {
  planId: 'solomap_pro_catalog_plan',
  label: 'SoloMap Pro Catalog Plan',
  labelZh: 'SoloMap Pro 目录计划',
  interval: 'year',
  currency: 'usd',
  amountCents: 3100,
  featureKeys: ['strategy_pyramid', 'flow_mode', 'collaboration_pro'],
  metadata: {
    schemaVersion: 1,
    deviceLimit: 5,
    refundDays: 14,
    customerDisplay: {
      en: { name: 'SoloMap Pro Catalog Plan', billingSuffix: '/ year', offerLabel: 'Early Access', summary: 'Catalog-backed Pro benefits.' },
      zh: { name: 'SoloMap Pro 目录计划', billingSuffix: '/ 年', offerLabel: '早鸟计划', summary: '由中央目录提供的 Pro 权益。' }
    },
    features: [
      { key: 'strategy_pyramid', name: { en: 'Strategy Pyramid', zh: '战略金字塔' }, free: { en: 'Not included', zh: '不包含' }, paid: { en: 'Portfolio strategy.', zh: '项目组合战略。' } },
      { key: 'flow_mode', name: { en: 'Flow Mode', zh: 'Flow Mode' }, free: { en: 'Not included', zh: '不包含' }, paid: { en: 'Goal-driven execution.', zh: '围绕目标持续执行。' } },
      { key: 'collaboration_pro', name: { en: 'Co-create rooms', zh: '共创房间' }, free: { en: 'Account limits.', zh: '账号额度。' }, paid: { en: 'Higher limits.', zh: '更高额度。' } }
    ],
    quotas: {
      collaboration: {
        anonymous: { maxActiveRooms: 1, maxDailyRooms: 3, maxLifetimeHours: 2 },
        account: { maxActiveRooms: 5, maxDailyRooms: 20, maxLifetimeHours: 24 },
        paid: { maxActiveRooms: 20, maxDailyRooms: 100, maxLifetimeHours: 72 }
      }
    }
  }
};
const testCatalogPayload = { ok: true, data: { plans: [testProPlan] } };
const testCatalogUrl = `data:application/json,${encodeURIComponent(JSON.stringify(testCatalogPayload))}`;

function testCatalogResponse() {
  return new Response(JSON.stringify(testCatalogPayload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

let oidcKeyPromise;
async function oidcKeys() {
  if (!oidcKeyPromise) {
    oidcKeyPromise = import(new URL('website/node_modules/jose/dist/webapi/index.js', projectRootUrl)).then(async (jose) => {
      const pair = await jose.generateKeyPair('ES256');
      return {
        jose,
        privateKey: pair.privateKey,
        publicJwk: { ...(await jose.exportJWK(pair.publicKey)), alg: 'ES256', kid: 'test-key', use: 'sig' }
      };
    });
  }
  return oidcKeyPromise;
}

async function passportTokenResponse(nonce, { sub = 'passport-user', email = 'pro@solomap.app' } = {}) {
  const keys = await oidcKeys();
  const idToken = await new keys.jose.SignJWT({ email, email_verified: true, nonce })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setSubject(sub)
    .setIssuer('https://passport.szlk.ai')
    .setAudience('solomap-vscode')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys.privateKey);
  return new Response(JSON.stringify({ access_token: 'passport-token', id_token: idToken }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function passportJwksResponse() {
  return new Response(JSON.stringify({ keys: [(await oidcKeys()).publicJwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function passportLookupResponse() {
  return new Response(JSON.stringify({ ok: true, data: { products: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function passportLinkResponse(init, passportUserId) {
  const body = JSON.parse(init.body);
  return new Response(JSON.stringify({ ok: true, data: { linked: true, userId: passportUserId, productUid: body.productUid } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('website Pro CTA uses dedicated subscription page before authorization', async () => {
  const worker = await loadWebsiteWorker();
  const response = await worker.default.fetch(new Request('https://solomap.app/'), { SITE_ORIGIN: 'https://solomap.app' });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /href="\/pro"/);
  assert.doesNotMatch(html, /issues\/new[^"]*Join Pro Early Access/);
});

test('homepage install buttons render refreshed marketplace download counts', async () => {
  const worker = await loadWebsiteWorker();
  worker.resetStatsCacheForTest();

  const originalFetch = global.fetch;
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://passport.szlk.ai/api/v1/billing/catalog') return testCatalogResponse();
    if (url === 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery') {
      assert.equal(init.method, 'POST');
      return new Response(JSON.stringify({
        results: [{
          extensions: [{
            statistics: [
              { statisticName: 'install', value: 1234 }
            ]
          }]
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://open-vsx.org/api/SZLK/solopreneur-roadmap') {
      return new Response(JSON.stringify({ downloadCount: 56789 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return originalFetch(input, init);
  };

  try {
    const response = await worker.default.fetch(new Request('https://solomap.app/'), { SITE_ORIGIN: 'https://solomap.app' });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /VS Code Marketplace \(1,234 installs\)/);
    assert.match(html, /Open VSX \(56,789 downloads\)/);
  } finally {
    global.fetch = originalFetch;
    worker.resetStatsCacheForTest();
  }
});

test('Pro subscription page carries signed upgrade state into Passport start', async () => {
  const worker = await loadWebsiteWorker();
  const callback = 'vscode://SZLK.solopreneur-roadmap/passport/callback';
  const response = await worker.default.fetch(
    new Request(`https://solomap.app/pro?mode=callback&auth_nonce=${'a'.repeat(32)}&callback=${encodeURIComponent(callback)}`),
    {
      SITE_ORIGIN: 'https://solomap.app',
      SOLOMAP_PASSPORT_PRODUCT_SECRET: 'test-product-secret',
      SOLOMAP_PASSPORT_CATALOG_URL: testCatalogUrl
    }
  );
  const html = await response.text();
  const href = html.match(/href="([^"]*\/api\/passport\/start\?upgrade_state=[^"]+)"/)?.[1] || '';
  const start = await worker.default.fetch(new Request(new URL(href, 'https://solomap.app').toString()), {
    SITE_ORIGIN: 'https://solomap.app',
    SOLOMAP_PASSPORT_PRODUCT_SECRET: 'test-product-secret',
    SOLOMAP_PASSPORT_CATALOG_URL: testCatalogUrl
  });
  const location = new URL(start.headers.get('location') || '');

  assert.equal(response.status, 200);
  assert.match(html, /Know which project deserves your next month/);
  assert.match(html, /Free vs Pro/);
  assert.match(html, /Strategy Pyramid/);
  assert.match(html, /Reliable progress history/);
  assert.match(html, /Goal-driven autopilot/);
  assert.match(html, /Already subscribed\? Get activation code/);
  assert.match(html, /\$31\.00/);
  assert.match(html, /"price":"31\.00"/);
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
      SOLOMAP_PASSPORT_PRODUCT_SECRET: 'test-product-secret',
      SOLOMAP_PASSPORT_CATALOG_URL: testCatalogUrl
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
  assert.match(html, /已订阅？取回激活码/);
  assert.match(html, /仍然本地优先/);
  assert.match(html, /href="\/pro\?lang=en" hreflang="en"/);
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
  assert.match(html, /href="\/api\/passport\/recover\?intent=checkout"/);
  assert.match(html, /href="\/api\/passport\/recover\?intent=recover"/);
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
  assert.match(xml, /<lastmod>2026-08-02<\/lastmod>/);
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
  let oidcNonce = '';
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://passport.szlk.ai/api/v1/billing/catalog') return testCatalogResponse();
    if (url === 'https://passport.szlk.ai/api/oidc/token') {
      assert.equal(init.method, 'POST');
      return passportTokenResponse(oidcNonce);
    }
    if (url === 'https://passport.szlk.ai/api/oidc/jwks') return passportJwksResponse();
    if (url === 'https://passport.szlk.ai/api/oidc/userinfo') {
      assert.equal(init.headers.authorization, 'Bearer passport-token');
      return new Response(JSON.stringify({ sub: 'passport-user', email: 'pro@solomap.app', email_verified: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://passport.szlk.ai/api/v1/passport/lookup?')) return passportLookupResponse();
    if (url === 'https://passport.szlk.ai/api/v1/passport/link') return passportLinkResponse(init, 'passport-user');
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
    oidcNonce = new URL(start.headers.get('location') || '').searchParams.get('nonce') || '';
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
  let oidcNonce = '';
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://passport.szlk.ai/api/v1/billing/catalog') return testCatalogResponse();
    if (url === 'https://passport.szlk.ai/api/oidc/token') {
      return passportTokenResponse(oidcNonce);
    }
    if (url === 'https://passport.szlk.ai/api/oidc/jwks') return passportJwksResponse();
    if (url === 'https://passport.szlk.ai/api/oidc/userinfo') {
      return new Response(JSON.stringify({ sub: 'passport-user', email: 'pro@solomap.app', email_verified: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://passport.szlk.ai/api/v1/passport/lookup?')) return passportLookupResponse();
    if (url === 'https://passport.szlk.ai/api/v1/passport/link') return passportLinkResponse(init, 'passport-user');
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
    oidcNonce = new URL(start.headers.get('location') || '').searchParams.get('nonce') || '';
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
  let oidcNonce = '';
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://passport.szlk.ai/api/v1/billing/catalog') return testCatalogResponse();
    if (url === 'https://passport.szlk.ai/api/oidc/token') {
      return passportTokenResponse(oidcNonce, { sub: 'passport-user-free', email: 'free@solomap.app' });
    }
    if (url === 'https://passport.szlk.ai/api/oidc/jwks') return passportJwksResponse();
    if (url === 'https://passport.szlk.ai/api/oidc/userinfo') {
      return new Response(JSON.stringify({ sub: 'passport-user-free', email: 'free@solomap.app', email_verified: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://passport.szlk.ai/api/v1/passport/lookup?')) return passportLookupResponse();
    if (url === 'https://passport.szlk.ai/api/v1/passport/link') return passportLinkResponse(init, 'passport-user-free');
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
    oidcNonce = new URL(start.headers.get('location') || '').searchParams.get('nonce') || '';
    const response = await worker.default.fetch(
      new Request(`https://solomap.app/api/passport/oidc/callback?code=auth-code&state=${encodeURIComponent(state || '')}`),
      env
    );

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_solomap_pro');
    assert.equal(checkoutPayload.product, 'solomap');
    assert.equal(checkoutPayload.planId, testProPlan.planId);
    assert.equal(checkoutPayload.customerEmail, 'free@solomap.app');
    assert.equal(checkoutPayload.userId, 'passport-user-free');
    assert.equal(checkoutPayload.metadata.catalogVersion, 1);
    assert.equal(Object.hasOwn(checkoutPayload.metadata, 'deviceLimit'), false);
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
  let accessAllowed = true;
  let accessChecks = 0;
  let oidcNonce = '';
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://passport.szlk.ai/api/v1/billing/catalog') return testCatalogResponse();
    if (url === 'https://passport.szlk.ai/api/oidc/token') {
      assert.equal(init.method, 'POST');
      return passportTokenResponse(oidcNonce);
    }
    if (url === 'https://passport.szlk.ai/api/oidc/jwks') return passportJwksResponse();
    if (url === 'https://passport.szlk.ai/api/oidc/userinfo') {
      assert.equal(init.headers.authorization, 'Bearer passport-token');
      return new Response(JSON.stringify({ sub: 'passport-user', email: 'pro@solomap.app', email_verified: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://passport.szlk.ai/api/v1/passport/lookup?')) return passportLookupResponse();
    if (url === 'https://passport.szlk.ai/api/v1/passport/link') return passportLinkResponse(init, 'passport-user');
    if (url === 'https://passport.szlk.ai/api/v1/entitlements/access-check') {
      accessChecks += 1;
      return new Response(JSON.stringify({
        ok: true,
        data: {
          allowed: accessAllowed,
          reason: accessAllowed ? 'feature_granted' : 'not_entitled',
          email: 'pro@solomap.app',
          userId: 'passport-user',
          entitlements: accessAllowed ? ['strategy_pyramid'] : []
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
    const cookie = await sessionCookie(env, { id: 'passport-user', email: 'pro@solomap.app' });
    const callback = await worker.default.fetch(new Request(startBody.loginUrl, { headers: { cookie } }), env);
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
    assert.equal(new URL(authorize.headers.get('location') || '').pathname, '/login');
    assert.equal(callback.status, 200);
    assert.match(html, /SoloMap Pro 已授权/);
    assert.match(html, /最多 5 台个人设备/);
    assert.match(html, /pro@solomap\.app/);
    assert.match(html, /打开账户页面/);
    assert.match(html, /href="https:\/\/solomap\.app\/workbench"/);
    assert.ok(grant);
    assert.equal(verify.status, 200);
    assert.equal(verifyBody.allowed, true);
    assert.deepEqual(verifyBody.entitlements, ['strategy_pyramid']);
    assert.equal(verifyBody.deviceLimit, 5);
    accessAllowed = false;
    const revoked = await worker.default.fetch(
      new Request('https://solomap.app/api/passport/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant: verifyBody.grant || grant })
      }),
      env
    );
    const revokedBody = await revoked.json();
    assert.equal(revokedBody.authenticated, true);
    assert.equal(revokedBody.allowed, false);
    assert.deepEqual(revokedBody.entitlements, []);
    assert.ok(accessChecks >= 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test('paid website users can recover an activation code from the Pro page', async () => {
  const worker = await loadWebsiteWorker();
  const originalFetch = global.fetch;
  let oidcNonce = '';
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://passport.szlk.ai/api/v1/billing/catalog') return testCatalogResponse();
    if (url === 'https://passport.szlk.ai/api/oidc/token') {
      assert.equal(init.method, 'POST');
      return passportTokenResponse(oidcNonce);
    }
    if (url === 'https://passport.szlk.ai/api/oidc/jwks') return passportJwksResponse();
    if (url === 'https://passport.szlk.ai/api/oidc/userinfo') {
      return new Response(JSON.stringify({ sub: 'passport-user', email: 'pro@solomap.app', email_verified: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://passport.szlk.ai/api/v1/passport/lookup?')) return passportLookupResponse();
    if (url === 'https://passport.szlk.ai/api/v1/passport/link') return passportLinkResponse(init, 'passport-user');
    if (url === 'https://passport.szlk.ai/api/v1/entitlements/access-check') {
      return new Response(JSON.stringify({
        ok: true,
        data: {
          allowed: true,
          email: 'pro@solomap.app',
          userId: 'passport-user',
          entitlements: ['strategy_pyramid'],
          deviceLimit: 5
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
    const page = await worker.default.fetch(new Request('https://solomap.app/zh/pro'), env);
    const html = await page.text();
    const recoverHref = html.match(/href="([^"]*\/api\/passport\/recover\?intent=recover[^"]*)"/)?.[1] || '';
    const recover = await worker.default.fetch(new Request(new URL(recoverHref, 'https://solomap.app').toString()), env);
    const recoverLocation = recover.headers.get('location') || '';
    const deviceCode = new URL(recoverLocation).searchParams.get('device') || '';
    const authorize = await worker.default.fetch(new Request(recoverLocation), env);
    const cookie = await sessionCookie(env, { id: 'passport-user', email: 'pro@solomap.app' });
    const callback = await worker.default.fetch(new Request(recoverLocation, { headers: { cookie } }), env);
    const accountHtml = await callback.text();
    const grant = accountHtml.match(/<textarea id="code" readonly>([^<]+)<\/textarea>/)?.[1] || '';
    const verified = await worker.default.fetch(
      new Request('https://solomap.app/api/passport/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant, deviceCode })
      }),
      env
    );
    const verifiedBody = await verified.json();

    assert.equal(page.status, 200);
    assert.ok(recoverHref);
    assert.equal(recover.status, 302);
    assert.match(recoverLocation, /^https:\/\/solomap\.app\/api\/passport\/device\/authorize\?device=/);
    assert.equal(authorize.status, 302);
    assert.equal(callback.status, 200);
    assert.match(accountHtml, /SoloMap Pro 已授权/);
    assert.match(accountHtml, /复制下面的激活码/);
    assert.match(accountHtml, /最多 5 台个人设备/);
    assert.match(accountHtml, /href="https:\/\/solomap\.app\/workbench"/);
    assert.ok(grant);
    assert.equal(verifiedBody.allowed, true);
    assert.equal(verifiedBody.deviceLimit, 5);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Passport device auth redirects unpaid users to Pro checkout and resumes device authorization', async () => {
  const worker = await loadWebsiteWorker();
  const originalFetch = global.fetch;
  let checkoutPayload = null;
  let checkoutCalls = 0;
  let oidcNonce = '';
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://passport.szlk.ai/api/v1/billing/catalog') return testCatalogResponse();
    if (url === 'https://passport.szlk.ai/api/oidc/token') {
      return passportTokenResponse(oidcNonce, { sub: 'passport-user-free', email: 'free@solomap.app' });
    }
    if (url === 'https://passport.szlk.ai/api/oidc/jwks') return passportJwksResponse();
    if (url === 'https://passport.szlk.ai/api/oidc/userinfo') {
      return new Response(JSON.stringify({ sub: 'passport-user-free', email: 'free@solomap.app', email_verified: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://passport.szlk.ai/api/v1/passport/lookup?')) return passportLookupResponse();
    if (url === 'https://passport.szlk.ai/api/v1/passport/link') return passportLinkResponse(init, 'passport-user-free');
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
    const cookie = await sessionCookie(env, { id: 'passport-user-free', email: 'free@solomap.app' });
    const response = await worker.default.fetch(new Request(startBody.loginUrl, { headers: { cookie } }), env);

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_solomap_device');
    assert.equal(checkoutPayload.planId, testProPlan.planId);
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

test('Passport dev grant flag cannot bypass Passport OIDC', async () => {
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
  const location = new URL(start.headers.get('location') || '');

  assert.equal(start.status, 302);
  assert.equal(location.origin, 'https://passport.szlk.ai');
  assert.equal(location.pathname, '/api/oidc/authorize');
  assert.equal(location.searchParams.get('client_id'), 'solomap-vscode');
  assert.equal(location.searchParams.has('grant'), false);
});

test('GEO language redirection and Cookie preferences work correctly', async () => {
  const worker = await loadWebsiteWorker();
  const env = { SITE_ORIGIN: 'https://solomap.app' };

  // 1. Accept-language: zh-CN triggers redirect to /zh
  const req1 = new Request('https://solomap.app/', {
    headers: { 'accept-language': 'zh-CN,zh;q=0.9' }
  });
  const res1 = await worker.default.fetch(req1, env);
  assert.equal(res1.status, 302);
  assert.equal(res1.headers.get('location'), 'https://solomap.app/zh');
  assert.match(res1.headers.get('set-cookie') || '', /lang_pref=zh/);

  // 2. CF Country: CN triggers redirect
  const req2 = new Request('https://solomap.app/');
  req2.cf = { country: 'CN' };
  const res2 = await worker.default.fetch(req2, env);
  assert.equal(res2.status, 302);
  assert.equal(res2.headers.get('location'), 'https://solomap.app/zh');

  // 3. cookie lang_pref=en bypasses redirect
  const req3 = new Request('https://solomap.app/', {
    headers: { 'accept-language': 'zh-CN,zh;q=0.9', 'cookie': 'lang_pref=en' }
  });
  const res3 = await worker.default.fetch(req3, env);
  assert.equal(res3.status, 200);

  // 4. lang=en param updates cookie to en
  const req4 = new Request('https://solomap.app/?lang=en');
  const res4 = await worker.default.fetch(req4, env);
  assert.equal(res4.status, 200);
  assert.match(res4.headers.get('set-cookie') || '', /lang_pref=en/);
});

test('Pro subscription page renders SEO keywords and Pro FAQs', async () => {
  const worker = await loadWebsiteWorker();
  const env = { SITE_ORIGIN: 'https://solomap.app' };

  // 1. English Pro Page
  const resEn = await worker.default.fetch(new Request('https://solomap.app/pro'), env);
  const htmlEn = await resEn.text();
  assert.equal(resEn.status, 200);
  assert.match(htmlEn, /name="keywords" content="[^"]*solomap pro/);
  assert.match(htmlEn, /Pro Subscription FAQ/);
  assert.match(htmlEn, /class="faq-item"/);
  assert.match(htmlEn, /class="faq-icon"/);
  assert.match(htmlEn, /Is my code sent to any servers if I subscribe to Pro\?/);

  // 2. Chinese Pro Page
  const resZh = await worker.default.fetch(new Request('https://solomap.app/zh/pro'), env);
  const htmlZh = await resZh.text();
  assert.equal(resZh.status, 200);
  assert.match(htmlZh, /name="keywords" content="[^"]*SoloMap Pro/);
  assert.match(htmlZh, /Pro 订阅常见问题/);
  assert.match(htmlZh, /订阅 Pro 后，我的代码会被上传到服务器吗/);
});

test('HTML structured sitemap directory and search engine crawlers bypass redirection', async () => {
  const worker = await loadWebsiteWorker();
  const env = { SITE_ORIGIN: 'https://solomap.app' };

  // 1. Googlebot crawler requesting / with zh-CN Accept-Language should NOT be redirected
  const googlebotReq = new Request('https://solomap.app/', {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'accept-language': 'zh-CN,zh;q=0.9'
    }
  });
  const googlebotRes = await worker.default.fetch(googlebotReq, env);
  assert.equal(googlebotRes.status, 200); // Excluded from 302 redirect

  // 2. Normal user requesting / with zh-CN should be redirected
  const normalReq = new Request('https://solomap.app/', {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'accept-language': 'zh-CN,zh;q=0.9'
    }
  });
  const normalRes = await worker.default.fetch(normalReq, env);
  assert.equal(normalRes.status, 302);
  assert.equal(normalRes.headers.get('location'), 'https://solomap.app/zh');

  // 3. English HTML Sitemap Page renders correctly
  const resEn = await worker.default.fetch(new Request('https://solomap.app/sitemap'), env);
  const htmlEn = await resEn.text();
  assert.equal(resEn.status, 200);
  assert.match(htmlEn, /Site Directory &amp; Structured Sitemap/);
  assert.match(htmlEn, /href="\/docs\/solomap-method"/);
  assert.match(htmlEn, /href="\/pro"/);

  // 4. Chinese HTML Sitemap Page renders correctly
  const resZh = await worker.default.fetch(new Request('https://solomap.app/zh/sitemap'), env);
  const htmlZh = await resZh.text();
  assert.equal(resZh.status, 200);
  assert.match(htmlZh, /网站地图与结构化目录/);
  assert.match(htmlZh, /href="\/zh\/docs\/solomap-method"/);
  assert.match(htmlZh, /href="\/zh\/pro"/);

  // 5. XML Sitemap includes sitemap.xml entries for HTML Sitemap and references stylesheet
  const resXml = await worker.default.fetch(new Request('https://solomap.app/sitemap.xml'), env);
  const xml = await resXml.text();
  assert.equal(resXml.status, 200);
  assert.match(xml, /<\?xml-stylesheet type="text\/xsl" href="\/sitemap\.xsl"\?>/);
  assert.match(xml, /<loc>https:\/\/solomap\.app\/sitemap<\/loc>/);
  assert.match(xml, /<loc>https:\/\/solomap\.app\/zh\/sitemap<\/loc>/);

  // 6. XSL Stylesheet renders correctly
  const resXsl = await worker.default.fetch(new Request('https://solomap.app/sitemap.xsl'), env);
  const xsl = await resXsl.text();
  assert.equal(resXsl.status, 200);
  assert.equal(resXsl.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.match(xsl, /<xsl:stylesheet/);
  assert.match(xsl, /SoloMap XML Sitemap/);
});

test('Privacy Policy and Terms of Service endpoints render correct bilingual copies', async () => {
  const worker = await loadWebsiteWorker();
  const env = { SITE_ORIGIN: 'https://solomap.app' };

  // 1. English Privacy Policy
  const resPrivacyEn = await worker.default.fetch(new Request('https://solomap.app/privacy-policy'), env);
  const privacyEn = await resPrivacyEn.text();
  assert.equal(resPrivacyEn.status, 200);
  assert.match(privacyEn, /<h1>Privacy Policy<\/h1>/);
  assert.match(privacyEn, /Company Identity/);

  // 2. Chinese Privacy Policy
  const resPrivacyZh = await worker.default.fetch(new Request('https://solomap.app/zh/privacy-policy'), env);
  const privacyZh = await resPrivacyZh.text();
  assert.equal(resPrivacyZh.status, 200);
  assert.match(privacyZh, /<h1>隐私政策<\/h1>/);
  assert.match(privacyZh, /公司主体/);

  // 3. English Terms of Service
  const resTermsEn = await worker.default.fetch(new Request('https://solomap.app/terms-of-service'), env);
  const termsEn = await resTermsEn.text();
  assert.equal(resTermsEn.status, 200);
  assert.match(termsEn, /<h1>Terms of Service<\/h1>/);
  assert.match(termsEn, /Company Identity/);

  // 4. Chinese Terms of Service
  const resTermsZh = await worker.default.fetch(new Request('https://solomap.app/zh/terms-of-service'), env);
  const termsZh = await resTermsZh.text();
  assert.equal(resTermsZh.status, 200);
  assert.match(termsZh, /<h1>服务条款<\/h1>/);
  assert.match(termsZh, /公司主体/);
});

test('website headless auth renders product-owned forms and creates a protected workbench session', async () => {
  const worker = await loadWebsiteWorker();
  const env = { SITE_ORIGIN: 'https://solomap.app', SOLOMAP_PASSPORT_PRODUCT_SECRET: 'test-product-secret' };
  const originalFetch = global.fetch;
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('https://passport.szlk.ai/api/v1/passport/lookup?')) {
      return new Response(JSON.stringify({ ok: true, data: { products: [{ product: 'solomap', productUid: 'user-1' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://passport.szlk.ai/api/v1/passport/link') {
      assert.deepEqual(JSON.parse(init.body), {
        email: 'developer@solomap.app',
        product: 'solomap',
        productUid: 'user-1',
        metadata: { identityProvider: 'password', passportUserId: 'user-1' }
      });
      return new Response(JSON.stringify({ ok: true, data: { linked: true, userId: 'user-1', productUid: 'user-1' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://passport.szlk.ai/api/v1/entitlements/access-check') {
      return new Response(JSON.stringify({ ok: true, data: { allowed: false, reason: 'not_entitled', email: 'developer@solomap.app', userId: 'user-1', entitlements: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://passport.szlk.ai/api/v1/billing/catalog') {
      return new Response(JSON.stringify({ ok: true, data: { plans: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    assert.equal(url, 'https://passport.szlk.ai/api/v1/auth/login');
    assert.equal(init.headers['x-szlk-product'], 'solomap');
    assert.equal(init.headers['x-szlk-secret'], 'test-product-secret');
    assert.deepEqual(JSON.parse(init.body), { email: 'developer@solomap.app', password: 'correct-password' });
    return new Response(JSON.stringify({ ok: true, data: { user: { id: 'user-1', email: 'developer@solomap.app', name: 'Solo Dev', emailVerified: true } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const loginPage = await worker.default.fetch(new Request('https://solomap.app/login'), env);
    const loginHtml = await loginPage.text();
    assert.equal(loginPage.status, 200);
    assert.match(loginHtml, /Sign in to SoloMap/);
    assert.match(loginHtml, /Create one/);
    assert.doesNotMatch(loginHtml, /api\/oidc\/authorize/);

    const registerPage = await worker.default.fetch(new Request('https://solomap.app/zh/register'), env);
    assert.match(await registerPage.text(), /创建 SoloMap 账号/);

    const anonymousWorkbench = await worker.default.fetch(new Request('https://solomap.app/workbench'), env);
    assert.equal(anonymousWorkbench.status, 302);
    assert.match(anonymousWorkbench.headers.get('location') || '', /\/login\?return_to=/);

    const login = await worker.default.fetch(new Request('https://solomap.app/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://solomap.app' },
      body: JSON.stringify({ email: 'developer@solomap.app', password: 'correct-password', returnTo: '/workbench' })
    }), env);
    const cookie = login.headers.get('set-cookie') || '';
    assert.equal(login.status, 200);
    assert.match(cookie, /^__Host-solomap_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);

    const callback = 'vscode://SZLK.solopreneur-roadmap/passport/callback';
    const authNonce = 'l'.repeat(32);
    const accountStart = await worker.default.fetch(new Request(
      `https://solomap.app/api/collaboration/account/start?auth_nonce=${authNonce}&callback=${encodeURIComponent(callback)}`,
      { headers: { cookie } }
    ), env);
    const callbackLocation = new URL(accountStart.headers.get('location') || '');
    assert.equal(accountStart.status, 302);
    assert.equal(callbackLocation.origin, 'null');
    assert.equal(callbackLocation.protocol, 'vscode:');
    assert.equal(callbackLocation.searchParams.get('intent'), 'collaboration');
    const accountVerify = await worker.default.fetch(new Request('https://solomap.app/api/passport/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: callbackLocation.searchParams.get('code'),
        authNonce,
        callback
      })
    }), env);
    const accountGrant = await accountVerify.json();
    assert.equal(accountGrant.authenticated, true);
    assert.equal(accountGrant.allowed, false);
    assert.deepEqual(accountGrant.entitlements, ['collaboration_lobby']);

    const workbench = await worker.default.fetch(new Request('https://solomap.app/workbench', { headers: { cookie } }), env);
    const workbenchHtml = await workbench.text();
    assert.equal(workbench.status, 200);
    assert.match(workbenchHtml, /Welcome back, Solo Dev/);
    assert.match(workbenchHtml, /class="desk shell"/);
    assert.match(workbenchHtml, /@media\(max-width:960px\)/);
    assert.match(workbenchHtml, /Your projects will appear here/);
    assert.match(workbenchHtml, /Project data in the extension stays local/);
    assert.match(workbenchHtml, /<footer>/);
    assert.match(workbenchHtml, /Local-first roadmap and strategy cockpit/);
    assert.doesNotMatch(workbenchHtml, /Pro Feature Roadmap &amp; Voting/);
  } finally {
    global.fetch = originalFetch;
  }
});
