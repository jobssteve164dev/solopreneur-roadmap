import { storage as sqlStorage } from './helpers/projection-storage.js';
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import worker from "../src/worker.js";
import { BlogProjection } from "../src/blogProjection.js";

const post = {
  id: "post-1",
  versionId: "version-1",
  contentDigest: "sha256:content",
  locale: "en",
  slug: "solo-developer-roadmap",
  translationKey: "roadmap-guide",
  title: "A practical roadmap for solo developers",
  description: "Move from an idea to verified product progress.",
  contentMarkdown: "## Start with one outcome\n\nBuild what users can actually try.\n\n- Ship\n- Learn",
  author: "SoloMap Team",
  category: "solo-operations",
  categoryLabel: "Solo Operations",
  tags: ["roadmap"],
  featured: true,
  readingTime: 4,
  seoTitle: "Solo Developer Roadmap | SoloMap",
  seoKeywords: ["solo developer roadmap"],
  ogImageUrl: null,
  canonicalUrl: "https://solomap.app/blog/solo-developer-roadmap",
  publishedAt: "2026-08-22T12:00:00.000Z",
  updatedAt: "2026-08-22T12:00:00.000Z"
};

function projectionNamespace(posts = [post]) {
  return {
    idFromName(name) { return name; },
    get() {
      return {
        async fetch() {
          return Response.json({ contractVersion: "2026-08-20", generatedAt: "2026-08-22T12:00:00.000Z", posts });
        }
      };
    }
  };
}

const ctx = { waitUntil() {} };

test("homepage, Blog index, article, and sitemap use one read-only projection", async () => {
  const env = { BLOG_PROJECTION: projectionNamespace(), SITE_ORIGIN: "https://solomap.app" };
  const homepage = await worker.fetch(new Request("https://solomap.app/"), env, ctx);
  const homepageHtml = await homepage.text();
  assert.match(homepageHtml, /OPC Blog/);
  assert.match(homepageHtml, /A practical roadmap for solo developers/);

  const index = await worker.fetch(new Request("https://solomap.app/blog"), env, ctx);
  assert.equal(index.status, 200);
  const indexHtml = await index.text();
  assert.match(indexHtml, /<link rel="canonical" href="https:\/\/solomap\.app\/blog">/);
  assert.match(indexHtml, /schema\.org/);

  const article = await worker.fetch(new Request("https://solomap.app/blog/solo-developer-roadmap"), env, ctx);
  assert.equal(article.status, 200);
  const articleHtml = await article.text();
  assert.match(articleHtml, /<h2>Start with one outcome<\/h2>/);
  assert.match(articleHtml, /"@type":"BlogPosting"/);
  assert.match(articleHtml, /version-1|A practical roadmap/);
  assert.doesNotMatch(articleHtml, /rel="alternate" hreflang="zh-Hans"/);
  assert.match(articleHtml, /class="language-link" href="\/zh\/blog\?lang=zh"/);
  const scripts = [...articleHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script[1]));

  const missing = await worker.fetch(new Request("https://solomap.app/blog/not-published"), env, ctx);
  assert.equal(missing.status, 404);
  const missingHtml = await missing.text();
  assert.match(missingHtml, /noindex,nofollow/);
  assert.doesNotMatch(missingHtml, /rel="canonical"|property="og:|hreflang=/);
  assert.doesNotMatch(missingHtml, /version-1|sha256:content|A practical roadmap/);

  const sitemap = await worker.fetch(new Request("https://solomap.app/sitemap.xml"), env, ctx);
  assert.equal(sitemap.status, 200);
  assert.match(await sitemap.text(), /\/blog\/solo-developer-roadmap/);
});

test("analytics endpoint rejects missing consent and enqueues an allowed anonymous page view", async () => {
  let received = null;
  const env = {
    ANALYTICS_OUTBOX: {
      idFromName(name) { return name; },
      get() {
        return {
          async fetch(_url, init) {
            received = JSON.parse(init.body);
            return Response.json({ accepted: true }, { status: 202 });
          }
        };
      }
    }
  };
  const body = JSON.stringify({ event_name: "page_view", anonymous_id: "visitor", page: "/blog" });
  const denied = await worker.fetch(new Request("https://solomap.app/api/analytics/events", {
    method: "POST", headers: { origin: "https://solomap.app", "content-type": "application/json" }, body
  }), env, ctx);
  assert.equal(denied.status, 403);

  const accepted = await worker.fetch(new Request("https://solomap.app/api/analytics/events", {
    method: "POST",
    headers: { origin: "https://solomap.app", cookie: "solomap_analytics_consent=yes", "content-type": "application/json" },
    body
  }), env, ctx);
  assert.equal(accepted.status, 202);
  assert.equal(received.event_name, "page_view");
  assert.equal(received.anonymous_id, "web:visitor");
  assert.equal(received.source, "solomap.web");
});

test("Blog projection activates a complete candidate atomically and deduplicates its event", async () => {
  const storage = sqlStorage();
  const object = new BlogProjection({ storage }, {});
  const event = {
    event_id: "event-1",
    event_type: "post.published",
    contract_version: "2026-08-20",
    project_key: "solomap",
    site_keys: ["solomap"],
    post: {
      id: post.id,
      locale: post.locale,
      slug: post.slug,
      version_id: post.versionId,
      content_digest: post.contentDigest,
      canonical_url: post.canonicalUrl
    }
  };
  const fetcher = async (url) => Response.json({ site_key: 'solomap', next_cursor: null, posts: new URL(url).searchParams.get('locale') === 'en' ? [{
    id: post.id, version_id: post.versionId, content_digest: post.contentDigest, locale: post.locale,
    slug: post.slug, title: post.title, description: post.description, content_markdown: post.contentMarkdown,
    canonical_url: post.canonicalUrl, published_at: post.publishedAt, updated_at: post.updatedAt,
  }] : [] });
  const activate = () => object.handle(event, fetcher);
  assert.equal((await activate()).status, 'activated');
  const snapshot = await (await object.fetch(new Request("https://blog-projection/snapshot"))).json();
  assert.equal(snapshot.posts[0].versionId, "version-1");
  assert.equal((await activate()).status, "already_current");
  event.event_id = "another-event-for-identical-content";
  assert.equal((await activate()).status, "already_current");
});
