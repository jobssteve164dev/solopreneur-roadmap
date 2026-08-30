import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/worker.js";

const ctx = { waitUntil() {} };
const env = {
  SOLOMAP_PASSPORT_PRODUCT_SECRET: "test-product-secret",
  SOLOMAP_PASSPORT_URL: "https://passport.test",
  SOLOMAP_PASSPORT_VERIFY_URL: "https://passport.test/api/v1/entitlements/access-check",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function loginRequest() {
  return new Request("https://solomap.app/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://solomap.app",
    },
    body: JSON.stringify({
      email: "builder@example.com",
      password: "valid-password",
      returnTo: "/workbench",
    }),
  });
}

test("headless login binds the SoloMap product identity before issuing a session", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/v1/auth/login")) {
      return json({ ok: true, data: { user: { id: "passport-user", email: "builder@example.com", name: "Builder", emailVerified: true }, needsEmailVerification: false } });
    }
    if (url.includes("/api/v1/passport/lookup?")) {
      return json({ ok: true, data: { products: [{ product: "aif", productUid: "aif-user" }, { product: "solomap", productUid: "solomap-user" }] } });
    }
    if (url.endsWith("/api/v1/passport/link")) {
      assert.deepEqual(JSON.parse(init.body), {
        email: "builder@example.com",
        product: "solomap",
        productUid: "solomap-user",
        metadata: { identityProvider: "password", passportUserId: "passport-user" },
      });
      return json({ ok: true, data: { linked: true, userId: "passport-user", productUid: "solomap-user" } });
    }
    if (url.endsWith("/api/v1/entitlements/access-check")) {
      return json({ ok: true, data: { allowed: false, entitlements: [] } });
    }
    if (url.endsWith("/api/v1/billing/catalog")) {
      return json({ ok: true, data: { plans: [] } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const response = await worker.fetch(loginRequest(), env, ctx);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /__Host-solomap_session=/);
    assert.deepEqual(calls.map((url) => new URL(url).pathname), [
      "/api/v1/auth/login",
      "/api/v1/passport/lookup",
      "/api/v1/passport/link",
      "/api/v1/entitlements/access-check",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("headless login does not issue a session when product linking fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/v1/auth/login")) {
      return json({ ok: true, data: { user: { id: "passport-user", email: "builder@example.com", emailVerified: true }, needsEmailVerification: false } });
    }
    if (url.includes("/api/v1/passport/lookup?")) {
      return json({ ok: true, data: { products: [] } });
    }
    if (url.endsWith("/api/v1/passport/link")) {
      return json({ ok: false, error: { code: "product_identity_conflict", message: "Product identity is already linked" } }, 409);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const response = await worker.fetch(loginRequest(), env, ctx);
    assert.equal(response.status, 409);
    assert.doesNotMatch(response.headers.get("set-cookie") || "", /solomap_session=/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
