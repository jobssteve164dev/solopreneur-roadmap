import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import worker from "../src/worker.js";

const ctx = { waitUntil() {} };

async function get(path, env = {}) {
  return worker.fetch(new Request(`https://solomap.app${path}`, { headers: { "user-agent": "Googlebot" } }), { SITE_ORIGIN: "https://solomap.app", ...env }, ctx);
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function metadataFrom(html) {
  return {
    title: decodeHtml(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] || ""),
    description: decodeHtml(html.match(/<meta name="description" content="([^"]*)">/)?.[1] || ""),
  };
}

function sharedDescriptionsFrom(html) {
  return {
    standard: decodeHtml(html.match(/<meta name="description" content="([^"]*)">/)?.[1] || ""),
    openGraph: decodeHtml(html.match(/<meta property="og:description" content="([^"]*)">/)?.[1] || ""),
    twitter: decodeHtml(html.match(/<meta name="twitter:description" content="([^"]*)">/)?.[1] || "")
  };
}

function legalResponse(url) {
  const requestUrl = new URL(url);
  const locale = requestUrl.searchParams.get("locale");
  const title = locale === "zh-CN" ? "隐私政策" : "Privacy Policy";
  const common = {
    effective_at: "2026-07-08",
    product: { id: "solomap", name: "SoloMap", domain: "solomap.app" },
    composition: [],
  };
  const body = requestUrl.pathname.endsWith("product-supplement")
    ? { success: true, supplement: common }
    : { success: true, document: { ...common, title } };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function blogProjectionNamespace() {
  const posts = [{
    id: "seo-post",
    versionId: "seo-version",
    contentDigest: "sha256:seo",
    locale: "en",
    slug: "verified-solo-roadmap",
    translationKey: null,
    title: "A verified roadmap for solo developers",
    description: "Build a focused solo developer roadmap that connects one user outcome to implementation, verification, release evidence, and the next informed product decision.",
    contentMarkdown: "## Start with the user outcome\n\nShip one result people can verify.",
    author: "SoloMap Team",
    category: "project-roadmaps",
    categoryLabel: "Project Roadmaps",
    tags: ["roadmap"],
    featured: false,
    readingTime: 3,
    seoTitle: "Verified Solo Developer Roadmap from Goal to Release | SoloMap",
    seoKeywords: ["solo developer roadmap"],
    ogImageUrl: null,
    canonicalUrl: "https://solomap.app/blog/verified-solo-roadmap",
    publishedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z"
  }, {
    id: "seo-post-zh",
    versionId: "seo-version-zh",
    contentDigest: "sha256:seo-zh",
    locale: "zh",
    slug: "verified-solo-roadmap",
    translationKey: null,
    title: "独立开发者的可验证项目路线图",
    description: "建立一份从用户结果出发的独立开发路线图，把执行任务、验证证据、发布动作和下一次产品决策连接起来，让每一步都能被真实用户检查和继续推进。",
    contentMarkdown: "## 从用户结果开始\n\n交付一个真实用户可以验证的结果。",
    author: "SoloMap Team",
    category: "project-roadmaps",
    categoryLabel: "项目路线图",
    tags: ["路线图"],
    featured: false,
    readingTime: 3,
    seoTitle: "独立开发者可验证项目路线图：从目标到发布 | SoloMap",
    seoKeywords: ["独立开发者路线图"],
    ogImageUrl: null,
    canonicalUrl: "https://solomap.app/zh/blog/verified-solo-roadmap",
    publishedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z"
  }];
  return {
    idFromName(name) { return name; },
    get() {
      return { async fetch() { return Response.json({ contractVersion: "2026-08-20", posts }); } };
    }
  };
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

test("every indexable sitemap page gives searchers a descriptive title and summary", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => legalResponse(url);
  try {
    const env = { BLOG_PROJECTION: blogProjectionNamespace() };
    const sitemap = await (await get("/sitemap.xml", env)).text();
    const paths = [...sitemap.matchAll(/<loc>https:\/\/solomap\.app([^<]*)<\/loc>/g)]
      .map((match) => match[1] || "/");
    assert.ok(paths.includes("/blog/verified-solo-roadmap"));
    assert.ok(paths.includes("/zh/blog/verified-solo-roadmap"));
    const failures = [];

    for (const path of paths) {
      const response = await get(path, env);
      const html = await response.text();
      const metadata = metadataFrom(html);
      const isChinese = path === "/zh" || path.startsWith("/zh/");
      const minimumTitleLength = isChinese ? 18 : 45;
      const minimumDescriptionLength = isChinese ? 65 : 140;
      const maximumTitleLength = isChinese ? 45 : 68;
      const maximumDescriptionLength = isChinese ? 100 : 170;

      if (response.status !== 200) failures.push(`${path} should remain indexable (status ${response.status})`);
      if (metadata.title.length < minimumTitleLength) failures.push(`${path} title is too short: ${metadata.title.length}`);
      if (metadata.title.length > maximumTitleLength) failures.push(`${path} title is too long: ${metadata.title.length}`);
      if (metadata.description.length < minimumDescriptionLength) {
        failures.push(`${path} meta description is too short: ${metadata.description.length}`);
      }
      if (metadata.description.length > maximumDescriptionLength) {
        failures.push(`${path} meta description is too long: ${metadata.description.length}`);
      }
      if (metadata.description === metadata.title) failures.push(`${path} repeats the title as its meta description`);
    }
    assert.deepEqual(failures, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("metadata overrides give search and social previews the same final description", async () => {
  const html = await (await get("/docs/getting-started")).text();
  const descriptions = sharedDescriptionsFrom(html);
  assert.ok(descriptions.standard.length >= 140);
  assert.equal(descriptions.openGraph, descriptions.standard);
  assert.equal(descriptions.twitter, descriptions.standard);
});

test("official extension listings and the GitHub README point visitors to the SoloMap website", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const readme = fs.readFileSync(new URL("../../README.md", import.meta.url), "utf8");

  assert.equal(manifest.homepage, "https://solomap.app");
  assert.match(readme, /href="https:\/\/solomap\.app"/);
});
