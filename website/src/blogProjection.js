const BLOG_CONTRACT_VERSION = "2026-08-20";
const BLOG_PROJECT_KEY = "solomap";
const BLOG_SITE_KEY = "solomap";
const BLOG_PUBLIC_ORIGIN = "https://szlkblog.szlk.ai";
const SITE_ORIGIN = "https://solomap.app";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Blog projection is missing ${field}`);
  return value;
}

function canonicalFor(locale, slug) {
  return `${SITE_ORIGIN}${locale === "zh" ? "/zh" : ""}/blog/${slug}`;
}

function normalizePost(item) {
  const locale = requiredString(item.locale, "locale");
  const slug = requiredString(item.slug, "slug");
  if (!new Set(["en", "zh"]).has(locale)) throw new Error(`Unsupported Blog locale: ${locale}`);
  const canonicalUrl = requiredString(item.canonical_url, "canonical_url");
  if (canonicalUrl !== canonicalFor(locale, slug)) throw new Error(`Blog canonical mismatch: ${locale}:${slug}`);
  return {
    id: requiredString(item.id, "id"),
    versionId: requiredString(item.version_id, "version_id"),
    contentDigest: requiredString(item.content_digest, "content_digest"),
    locale,
    slug,
    translationKey: item.translation_key || null,
    title: requiredString(item.title, "title"),
    description: requiredString(item.description, "description"),
    contentMarkdown: requiredString(item.content_markdown, "content_markdown"),
    author: item.author?.name || "SoloMap Team",
    category: item.category?.key || "build-with-ai",
    categoryLabel: item.category?.name || item.category?.label || "Build with AI",
    tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
    featured: Boolean(item.featured),
    readingTime: Math.max(1, Number(item.reading_time) || 1),
    seoTitle: item.seo_title || item.title,
    seoKeywords: Array.isArray(item.seo_keywords) ? item.seo_keywords.map(String) : [],
    ogImageUrl: item.og_image_url || null,
    canonicalUrl,
    publishedAt: requiredString(item.published_at, "published_at"),
    updatedAt: requiredString(item.updated_at, "updated_at")
  };
}

export async function fetchCompleteBlogProjection(fetcher = fetch) {
  const posts = [];
  for (const locale of ["en", "zh"]) {
    let cursor = null;
    do {
      const url = new URL(`/v1/public/sites/${BLOG_SITE_KEY}/posts`, BLOG_PUBLIC_ORIGIN);
      url.searchParams.set("locale", locale);
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetcher(url, { headers: { accept: "application/json" } });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.site_key !== BLOG_SITE_KEY || !Array.isArray(payload.posts)) {
        throw new Error(`SZLKBlog snapshot failed with ${response.status}`);
      }
      posts.push(...payload.posts.map(normalizePost));
      cursor = payload.next_cursor || null;
    } while (cursor);
  }
  const identities = new Set(posts.map((post) => `${post.locale}:${post.slug}`));
  if (identities.size !== posts.length) throw new Error("Blog projection contains duplicate locale/slug identities");
  return posts.sort((left, right) => `${left.locale}:${left.slug}`.localeCompare(`${right.locale}:${right.slug}`));
}

function validateEvent(event) {
  if (!event || event.contract_version !== BLOG_CONTRACT_VERSION || event.project_key !== BLOG_PROJECT_KEY) {
    throw new Error("Lifecycle event is outside the SoloMap Blog contract");
  }
  if (!Array.isArray(event.site_keys) || !event.site_keys.includes(BLOG_SITE_KEY)) {
    throw new Error("Lifecycle event has the wrong site binding");
  }
  if (!["post.published", "post.unpublished", "post.archived"].includes(event.event_type)) {
    throw new Error("Unsupported lifecycle event type");
  }
  requiredString(event.event_id, "event_id");
  requiredString(event.post?.id, "post.id");
  requiredString(event.post?.locale, "post.locale");
  requiredString(event.post?.slug, "post.slug");
}

function validateEventAgainstSnapshot(event, posts) {
  const projected = posts.find((post) => post.id === event.post.id);
  if (event.event_type === "post.published") {
    if (projected && projected.versionId !== event.post.version_id) return "superseded";
    if (!projected || projected.locale !== event.post.locale || projected.slug !== event.post.slug ||
      projected.versionId !== event.post.version_id || projected.contentDigest !== event.post.content_digest ||
      projected.canonicalUrl !== event.post.canonical_url) {
      throw new Error("Published lifecycle event does not match the authoritative snapshot");
    }
  } else if (projected) {
    throw new Error("Removed article is still present in the authoritative snapshot");
  }
  return "activated";
}

async function secretMatches(expected, supplied) {
  if (!expected || !supplied) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied))
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

export class BlogProjection {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/snapshot") {
      return json(await this.state.storage.get("active") || {
        contractVersion: BLOG_CONTRACT_VERSION,
        generatedAt: null,
        sourceEventId: null,
        posts: []
      });
    }
    if (request.method !== "POST" || url.pathname !== "/activate") return json({ error: "Not found" }, 404);
    const { event, posts } = await request.json();
    validateEvent(event);
    if (!Array.isArray(posts)) throw new Error("Projection candidate is invalid");
    const seen = await this.state.storage.get("eventIds") || [];
    if (seen.includes(event.event_id)) return json({ accepted: true, status: "already_current" });
    const status = validateEventAgainstSnapshot(event, posts);
    if (status === "superseded") {
      await this.state.storage.put("eventIds", [...seen, event.event_id].slice(-200));
      return json({ accepted: true, status });
    }
    const candidate = {
      contractVersion: BLOG_CONTRACT_VERSION,
      generatedAt: new Date().toISOString(),
      sourceEventId: event.event_id,
      posts
    };
    await this.state.storage.put({ active: candidate, eventIds: [...seen, event.event_id].slice(-200) });
    return json({ accepted: true, status, postCount: posts.length });
  }
}

function projectionStub(env) {
  const id = env.BLOG_PROJECTION.idFromName("solomap-active");
  return env.BLOG_PROJECTION.get(id);
}

export async function getActiveBlogProjection(env) {
  if (!env.BLOG_PROJECTION) return { contractVersion: BLOG_CONTRACT_VERSION, generatedAt: null, posts: [] };
  const response = await projectionStub(env).fetch("https://blog-projection/snapshot");
  if (!response.ok) throw new Error(`Blog projection read failed with ${response.status}`);
  return response.json();
}

export async function handleBlogLifecycle(request, env) {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!await secretMatches(env.SOLOMAP_BLOG_WEBHOOK_SECRET || "", supplied)) return json({ error: "Unauthorized" }, 401);
  let event;
  try { event = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  if (request.headers.get("x-szlkblog-event-id") !== event.event_id ||
    request.headers.get("x-szlkblog-event") !== event.event_type) {
    return json({ error: "Lifecycle headers do not match the event" }, 400);
  }
  try {
    const posts = await fetchCompleteBlogProjection();
    const response = await projectionStub(env).fetch("https://blog-projection/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, posts })
    });
    return new Response(response.body, { status: response.status, headers: response.headers });
  } catch (error) {
    console.error("Blog projection activation failed", {
      eventId: event?.event_id || null,
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "Blog projection was not activated" }, 503);
  }
}

export { BLOG_CONTRACT_VERSION, BLOG_PROJECT_KEY, BLOG_SITE_KEY, canonicalFor };
