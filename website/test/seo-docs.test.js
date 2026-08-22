import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";

const ctx = { waitUntil() {} };

async function get(path, env = {}) {
  return worker.fetch(new Request(`https://solomap.app${path}`, { headers: { "user-agent": "Googlebot" } }), { SITE_ORIGIN: "https://solomap.app", ...env }, ctx);
}

test("the bilingual docs hub exposes start, problem, integration, comparison, and method guides", async () => {
  for (const path of ["/docs", "/zh/docs"]) {
    const response = await get(path);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /getting-started/);
    assert.match(html, /agents\/codex/);
    assert.match(html, /agents\/claude-code/);
    assert.match(html, /agents\/cursor/);
    assert.match(html, /compare\/solomap-vs-task-managers/);
    assert.match(html, /CollectionPage/);
    assert.match(html, /<main id="main-content" class="docs-page shell">/);
  }
});

test("nested guide routes have canonical metadata, breadcrumbs, authorship, FAQs, and related links", async () => {
  const response = await get("/docs/agents/codex");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /<link rel="canonical" href="https:\/\/solomap\.app\/docs\/agents\/codex">/);
  assert.match(html, /hreflang="zh-Hans" href="https:\/\/solomap\.app\/zh\/docs\/agents\/codex"/);
  assert.doesNotMatch(html, /hreflang="zh-TW"|hreflang="zh-HK"/);
  assert.match(html, /BreadcrumbList/);
  assert.match(html, /FAQPage/);
  assert.match(html, /TechArticle/);
  assert.match(html, /Maintained by the SoloMap team/);
  assert.match(html, /Continue reading/);
  assert.match(html, /<main id="main-content" class="docs-page shell">/);
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains; preload");
});

test("an explicit localized guide URL is not overridden by an older language cookie", async () => {
  const response = await worker.fetch(new Request("https://solomap.app/zh/docs/agents/codex", {
    headers: { cookie: "lang_pref=en" }
  }), { SITE_ORIGIN: "https://solomap.app" }, ctx);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /从真正需要执行的路线图环节启动 Codex/);
});

test("unknown pages return a dedicated noindex 404 instead of homepage content", async () => {
  const response = await get("/docs/not-a-real-guide");
  const html = await response.text();
  assert.equal(response.status, 404);
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /This page does not exist/);
  assert.doesNotMatch(html, /Let AI Agents Code/);
});

test("canonical host, trailing slashes, and outbound CTAs use explicit redirects", async () => {
  const www = await worker.fetch(new Request("https://www.solomap.app/docs?source=test"), {}, ctx);
  assert.equal(www.status, 301);
  assert.equal(www.headers.get("location"), "https://solomap.app/docs?source=test");

  const slash = await get("/docs/");
  assert.equal(slash.status, 301);
  assert.equal(slash.headers.get("location"), "https://solomap.app/docs");

  const outbound = await get("/go/marketplace");
  assert.equal(outbound.status, 302);
  assert.match(outbound.headers.get("location"), /marketplace\.visualstudio\.com/);
  assert.equal(outbound.headers.get("cache-control"), "no-store");
});

test("sitemap, social metadata, and llms index include the expanded docs system", async () => {
  const sitemap = await (await get("/sitemap.xml")).text();
  assert.match(sitemap, /2026-08-02/);
  assert.match(sitemap, /\/docs\/agents\/codex/);
  assert.match(sitemap, /\/zh\/docs\/compare\/solomap-vs-task-managers/);
  assert.doesNotMatch(sitemap, /zh-TW|zh-HK/);

  const docs = await (await get("/docs")).text();
  assert.match(docs, /og:image:width" content="1200"/);
  assert.match(docs, /twitter:image/);
  assert.match(docs, /\/solomap-social-card\.png/);

  const llms = await (await get("/llms.txt")).text();
  assert.match(llms, /\/docs\/resume-ai-coding-projects/);
  assert.match(llms, /\/docs\/agents\/cursor/);
});
