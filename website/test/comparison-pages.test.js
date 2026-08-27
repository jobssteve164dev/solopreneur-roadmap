import assert from "node:assert/strict";
import test from "node:test";
import { comparisonCatalog } from "../src/comparisonCatalog.js";
import worker from "../src/worker.js";

const ctx = { waitUntil() {} };

function get(path) {
  return worker.fetch(new Request(`https://solomap.app${path}`, { headers: { "user-agent": "Googlebot" } }), { SITE_ORIGIN: "https://solomap.app" }, ctx);
}

test("bilingual comparison and alternatives hubs expose the complete page family", async () => {
  for (const locale of ["en", "zh"]) {
    for (const family of ["compare", "alternatives"]) {
      const prefix = locale === "zh" ? "/zh" : "";
      const response = await get(`${prefix}/${family}`);
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(html, /CollectionPage/);
      assert.match(html, /ItemList/);
      assert.match(html, /compare-card/);
      assert.match(html, new RegExp(`href="${prefix}/compare`));
    }
  }
});

test("every comparison page is localized, canonical, sourced, and structured", async () => {
  for (const [slug, englishPage] of Object.entries(comparisonCatalog.en.pages)) {
    for (const locale of ["en", "zh"]) {
      const prefix = locale === "zh" ? "/zh" : "";
      const family = englishPage.kind === "alternative" ? "alternatives" : "compare";
      const response = await get(`${prefix}/${family}/${slug}`);
      const html = await response.text();
      assert.equal(response.status, 200, `${locale}:${slug}`);
      assert.match(html, new RegExp(`<link rel="canonical" href="https://solomap\\.app${prefix}/${family}/${slug}">`));
      assert.match(html, /hreflang="en"/);
      assert.match(html, /hreflang="zh-Hans"/);
      assert.match(html, /TechArticle/);
      assert.match(html, /FAQPage/);
      assert.match(html, /BreadcrumbList/);
      assert.match(html, /2026-08-27/);
      assert.match(html, /Official sources|官方来源/);
      assert.match(html, /decision-table/);
      if (locale === "zh") assert.match(html, /快速结论/);
    }
  }
});

test("comparison routes enforce intent instead of duplicating pages under both folders", async () => {
  const misplaced = await get("/alternatives/solomap-vs-codex");
  assert.equal(misplaced.status, 404);
  assert.equal(misplaced.headers.get("cache-control"), "no-store");
  assert.equal((await get("/compare/claude-code")).status, 404);
});

test("sitemap and llms index contain the comparison corridor", async () => {
  const sitemap = await (await get("/sitemap.xml")).text();
  const llms = await (await get("/llms.txt")).text();
  assert.match(sitemap, /\/compare\/solomap-vs-claude-code/);
  assert.match(sitemap, /\/zh\/compare\/claude-code-vs-codex/);
  assert.match(sitemap, /\/alternatives\/ai-coding-project-management/);
  assert.match(sitemap, /2026-08-27/);
  assert.match(llms, /Comparison center/);
  assert.match(llms, /\/compare\/solomap-vs-codex/);
});

test("comparison tables become labeled cards on narrow screens", async () => {
  const html = await (await get("/compare/solomap-vs-codex")).text();
  assert.match(html, /@media\(max-width:560px\)/);
  assert.match(html, /content:attr\(data-label\)/);
  assert.match(html, /data-label="Decision"/);
});
