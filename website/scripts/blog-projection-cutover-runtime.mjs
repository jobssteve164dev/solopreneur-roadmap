// Build-only migration support. Never imported by the final Worker entrypoint.
const PREFIX = '/__blog_incremental';
const MIGRATION_PATH = '/api/blog/projection-migration';

async function authorized(request, expected) {
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (!expected || !supplied) return false;
  const encoder = new TextEncoder();
  const hashes = await Promise.all([expected, supplied].map((value) => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const left = new Uint8Array(hashes[0]);
  const right = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

function candidateBinding(binding) {
  return {
    idFromName(name) { return binding.idFromName(name); },
    get(id) {
      const stub = binding.get(id);
      return { fetch(input, init) {
        const request = new Request(input, init);
        const url = new URL(request.url);
        url.pathname = PREFIX + url.pathname;
        return stub.fetch(new Request(url, request));
      } };
    },
  };
}

export function createCutoverObject(Candidate, Legacy) {
  return class {
    constructor(state, env) { this.state = state; this.env = env; }
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith(PREFIX + '/')) {
        this.candidate ||= new Candidate(this.state, this.env);
        url.pathname = url.pathname.slice(PREFIX.length);
        return this.candidate.fetch(new Request(url, request));
      }
      if (Legacy) {
        this.legacy ||= new Legacy(this.state, this.env);
        return this.legacy.fetch(request);
      }
      return new Response('Not found', { status: 404 });
    }
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function createCutoverWorker({ legacyWorker, legacyRead, candidateWorker, siteKey, secretName, bindingName, event, lifecyclePath }) {
  return {
    ...legacyWorker,
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const preview = request.headers.get('x-blog-projection-preview') === '1';
      if (url.pathname === lifecyclePath && request.method === 'POST') {
        if (!await authorized(request, env[secretName])) return new Response('Unauthorized', { status: 401 });
        const incoming = request.clone();
        const legacy = await legacyWorker.fetch(request, env, ctx);
        if (!legacy.ok) return legacy;
        const binding = candidateBinding(env[bindingName]);
        const stub = binding.get(binding.idFromName(`blog:${siteKey}`));
        const activated = await stub.fetch('https://projection/activate', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event: await incoming.json() }),
        });
        // A failed candidate activation remains retryable in the existing sender outbox.
        if (!activated.ok) return activated;
        return legacy;
      }
      if (url.pathname !== MIGRATION_PATH && !preview) return legacyWorker.fetch(request, env, ctx);
      if (!await authorized(request, env[secretName])) return new Response('Unauthorized', { status: 401 });
      const binding = candidateBinding(env[bindingName]);
      if (preview) {
        if (request.method !== 'GET' || !/^\/(?:blog(?:\/|$)|api\/(?:blog|research)(?:\/|$)|research(?:\/|$)|sitemap[^/]*\.xml$|(?:en|zh|ja)(?:\/blog)(?:\/|$))/.test(url.pathname)) {
          return new Response('Preview is limited to Blog reads', { status: 405 });
        }
        const response = await candidateWorker.fetch(request, { ...env, BLOG_PROJECTION: binding }, ctx);
        const headers = new Headers(response.headers);
        headers.set('cache-control', 'private, no-store');
        headers.set('cdn-cache-control', 'no-store');
        return new Response(response.body, { status: response.status, headers });
      }
      const stub = binding.get(binding.idFromName(`blog:${siteKey}`));
      if (request.method === 'POST') {
        return stub.fetch('https://projection/activate', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event }),
        });
      }
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const response = await stub.fetch('https://projection/snapshot');
      if (!response.ok) return response;
      const snapshot = await response.json();
      const previous = await legacyRead(env);
      const previousPosts = Array.isArray(previous) ? previous : previous?.posts;
      if (!Array.isArray(previousPosts)) return Response.json({ error: 'Previous projection is unavailable' }, { status: 503 });
      const byId = new Map(snapshot.posts.map((post) => [post.id, post]));
      const comparison = { previousCount: previousPosts.length, currentCount: snapshot.posts.length, unchangedVersions: 0, changedVersions: 0, missingIds: [], mismatches: [] };
      for (const post of previousPosts) {
        const current = byId.get(post.id);
        if (!current) { comparison.missingIds.push(post.id); continue; }
        if (current.versionId !== post.versionId) { comparison.changedVersions++; continue; }
        comparison.unchangedVersions++;
        if (JSON.stringify(canonical(current)) !== JSON.stringify(canonical(post))) comparison.mismatches.push(post.id);
      }
      const posts = snapshot.posts.map(({ id, locale, slug, versionId, contentDigest, canonicalUrl, translationKey, publishedAt, updatedAt }) => ({
        id, locale, slug, versionId, contentDigest, canonicalUrl, translationKey, publishedAt, updatedAt,
      }));
      return Response.json({ setId: snapshot.setId, sourceEventId: snapshot.sourceEventId, posts, comparison }, {
        status: comparison.mismatches.length ? 409 : 200, headers: { 'cache-control': 'private, no-store' },
      });
    },
  };
}
