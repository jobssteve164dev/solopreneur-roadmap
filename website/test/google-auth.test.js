import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import worker from "../src/worker.js";

const ctx = { waitUntil() {} };
const env = {
  SITE_ORIGIN: "https://solomap.app",
  SOLOMAP_PASSPORT_PRODUCT_SECRET: "test-product-secret",
  SOLOMAP_PASSPORT_URL: "https://passport.test",
  SOLOMAP_PASSPORT_TOKEN_URL: "https://passport.test/api/oidc/token",
  SOLOMAP_PASSPORT_USERINFO_URL: "https://passport.test/api/oidc/userinfo",
  SOLOMAP_PASSPORT_VERIFY_URL: "https://passport.test/api/v1/entitlements/access-check"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function startGoogleLogin(path = "/workbench") {
  const response = await worker.fetch(new Request(`https://solomap.app/api/auth/google/start?return_to=${encodeURIComponent(path)}`), env, ctx);
  const authorizeUrl = new URL(response.headers.get("location"));
  const stateCookie = response.headers.get("set-cookie").match(/__Host-solomap_google_oauth=([^;,]+)/)?.[1] || "";
  return { response, authorizeUrl, stateCookie };
}

function callbackRequest(authorizeUrl, stateCookie) {
  return new Request(`https://solomap.app/api/passport/oidc/callback?code=code-1&state=${encodeURIComponent(authorizeUrl.searchParams.get("state"))}`, {
    headers: { cookie: `__Host-solomap_google_oauth=${stateCookie}` }
  });
}

test("login and registration pages offer a product-owned Google action with valid inline behavior", async () => {
  for (const [path, label] of [["/login?return_to=%2Fworkbench", "Continue with Google"], ["/zh/register", "使用 Google 继续"]]) {
    const response = await worker.fetch(new Request(`https://solomap.app${path}`), env, ctx);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, new RegExp(label));
    assert.match(html, /href="\/api\/auth\/google\/start\?lang=(?:en|zh)&amp;return_to=/);
    assert.doesNotMatch(html, /Passport|Cloudapi|identity_provider|PKCE/);
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new vm.Script(script[1]));
    }
  }
});

test("Google start uses Passport headless OIDC with PKCE, nonce, a bound state cookie, and no offline scope", async () => {
  const { response, authorizeUrl, stateCookie } = await startGoogleLogin("//attacker.example");
  assert.equal(response.status, 302);
  assert.equal(authorizeUrl.origin, "https://passport.szlk.ai");
  assert.equal(authorizeUrl.pathname, "/api/oidc/authorize");
  assert.equal(authorizeUrl.searchParams.get("identity_provider"), "google");
  assert.equal(authorizeUrl.searchParams.get("scope"), "openid profile email");
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  assert.match(authorizeUrl.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.match(authorizeUrl.searchParams.get("nonce"), /^[A-Za-z0-9_-]+$/);
  assert.ok(stateCookie);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(response.headers.get("set-cookie"), /SameSite=Lax/);
  assert.doesNotMatch(authorizeUrl.searchParams.get("scope"), /offline_access/);
});

test("a returning paid Google account reuses its product identity, links before access check, and receives a local paid session", async () => {
  const { authorizeUrl, stateCookie } = await startGoogleLogin();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/api/oidc/token")) return json({ access_token: "passport-access" });
    if (url.endsWith("/api/oidc/userinfo")) return json({ sub: "passport-user-1", email: "PAID@example.com", email_verified: true, name: "Paid Builder" });
    if (url.includes("/api/v1/passport/lookup?")) return json({ ok: true, data: { products: [{ productUid: "solomap-user-1" }] } });
    if (url.endsWith("/api/v1/passport/link")) return json({ ok: true, data: { linked: true, userId: "passport-user-1", productUid: "solomap-user-1" } });
    if (url.endsWith("/api/v1/entitlements/access-check")) return json({ ok: true, data: { allowed: true, email: "paid@example.com", userId: "solomap-user-1", entitlements: ["strategy_pyramid", "solomap_pro"] } });
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const response = await worker.fetch(callbackRequest(authorizeUrl, stateCookie), env, ctx);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://solomap.app/workbench");
    const setCookie = response.headers.get("set-cookie");
    assert.match(setCookie, /__Host-solomap_session=/);
    assert.match(setCookie, /__Host-solomap_google_oauth=;/);

    const linkIndex = calls.findIndex((call) => call.url.endsWith("/api/v1/passport/link"));
    const accessIndex = calls.findIndex((call) => call.url.endsWith("/api/v1/entitlements/access-check"));
    assert.ok(linkIndex > calls.findIndex((call) => call.url.includes("/api/v1/passport/lookup?")));
    assert.ok(accessIndex > linkIndex);
    assert.deepEqual(JSON.parse(calls[linkIndex].init.body), {
      email: "paid@example.com",
      product: "solomap",
      productUid: "solomap-user-1",
      metadata: { identityProvider: "google", passportUserId: "passport-user-1" }
    });

    const sessionCookie = setCookie.match(/__Host-solomap_session=([^;,]+)/)?.[1];
    const sessionResponse = await worker.fetch(new Request("https://solomap.app/api/auth/session", {
      headers: { cookie: `__Host-solomap_session=${sessionCookie}` }
    }), env, ctx);
    const session = await sessionResponse.json();
    assert.equal(session.authenticated, true);
    assert.equal(session.user.id, "solomap-user-1");
    assert.equal(session.user.email, "paid@example.com");
    assert.equal(session.access.allowed, true);
    assert.deepEqual(session.access.entitlements, ["strategy_pyramid", "solomap_pro"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a new Google account links its stable Passport subject and signs in without receiving paid access", async () => {
  const { authorizeUrl, stateCookie } = await startGoogleLogin();
  const originalFetch = globalThis.fetch;
  let linkedProductUid = "";
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/api/oidc/token")) return json({ access_token: "passport-access" });
    if (url.endsWith("/api/oidc/userinfo")) return json({ sub: "passport-new-user", email: "new@example.com", email_verified: true, name: "New Builder" });
    if (url.includes("/api/v1/passport/lookup?")) return json({ ok: true, data: { products: [] } });
    if (url.endsWith("/api/v1/passport/link")) {
      linkedProductUid = JSON.parse(init.body).productUid;
      return json({ ok: true, data: { linked: true, userId: "passport-new-user", productUid: "passport-new-user" } });
    }
    if (url.endsWith("/api/v1/entitlements/access-check")) return json({ ok: true, data: { allowed: false, reason: "feature_not_granted", entitlements: [] } });
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const response = await worker.fetch(callbackRequest(authorizeUrl, stateCookie), env, ctx);
    assert.equal(response.status, 302);
    assert.equal(linkedProductUid, "passport-new-user");
    assert.match(response.headers.get("set-cookie"), /__Host-solomap_session=/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Google callbacks fail closed when state binding, verified email, or product linking is invalid", async () => {
  const { authorizeUrl, stateCookie } = await startGoogleLogin("/zh/workbench");
  const missingCookie = await worker.fetch(callbackRequest(authorizeUrl, "wrong-state-cookie"), env, ctx);
  assert.equal(missingCookie.status, 302);
  assert.match(missingCookie.headers.get("location"), /google_login_state_invalid/);
  assert.doesNotMatch(missingCookie.headers.get("set-cookie"), /__Host-solomap_session=/);

  const originalFetch = globalThis.fetch;
  for (const scenario of ["unverified", "link-conflict"]) {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/oidc/token")) return json({ access_token: "passport-access" });
      if (url.endsWith("/api/oidc/userinfo")) return json({ sub: "passport-user", email: "user@example.com", email_verified: scenario !== "unverified" });
      if (url.includes("/api/v1/passport/lookup?")) return json({ ok: true, data: { products: [] } });
      if (url.endsWith("/api/v1/passport/link")) return json({ ok: false, error: { code: "product_identity_conflict", message: "Product identity is already linked" } }, 409);
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const response = await worker.fetch(callbackRequest(authorizeUrl, stateCookie), env, ctx);
    assert.equal(response.status, 302);
    assert.match(response.headers.get("location"), /\/login\?error=/);
    assert.doesNotMatch(response.headers.get("set-cookie"), /__Host-solomap_session=/);
  }
  globalThis.fetch = originalFetch;
});
