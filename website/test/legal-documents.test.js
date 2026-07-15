import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";
import { findLegalRoute, getLegalContent, legalRoutes } from "../src/legalDocuments.js";

function legalPayload(productId = "solomap") {
  return {
    success: true,
    document: {
      type: "privacy_policy",
      title: "Privacy Policy",
      effective_at: "2026-07-08",
      product: { id: productId, name: "SoloMap", domain: "solomap.app" },
      composition: [{
        scope: "ecosystem_common",
        sections: [{ id: "company_identity", title: "Company Identity", body_markdown: "Operated by SZLK LTD." }],
      }],
    },
  };
}

test("all shared legal files and the standalone supplement resolve in both locales", () => {
  for (const route of legalRoutes) {
    assert.equal(findLegalRoute(`/${route.slug}`).type, route.type);
    assert.equal(findLegalRoute(`/zh/${route.slug}`).locale, "zh");
  }
  assert.equal(findLegalRoute("/legal-supplement").supplement, true);
  assert.equal(findLegalRoute("/zh/legal-supplement").supplement, true);
});

test("legal API responses must identify SoloMap", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(legalPayload("me")), {
    headers: { "content-type": "application/json" },
  });
  try {
    await assert.rejects(
      getLegalContent({}, findLegalRoute("/privacy-policy")),
      /wrong product/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the production worker route renders governed legal content", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /product=solomap/);
    return new Response(JSON.stringify(legalPayload()), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const response = await worker.fetch(
      new Request("https://solomap.app/privacy-policy"),
      {},
      { waitUntil() {} },
    );
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Privacy Policy/);
    assert.match(html, /Operated by SZLK LTD/);
    assert.match(html, /\/zh\/privacy-policy/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the production worker refuses another product's legal document", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(legalPayload("me")), {
    headers: { "content-type": "application/json" },
  });
  try {
    const response = await worker.fetch(
      new Request("https://solomap.app/privacy-policy"),
      {},
      { waitUntil() {} },
    );
    const html = await response.text();
    assert.equal(response.status, 502);
    assert.match(html, /temporarily unavailable/);
    assert.doesNotMatch(html, /MysticEast/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
