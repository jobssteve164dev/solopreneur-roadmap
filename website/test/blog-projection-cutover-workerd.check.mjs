import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { buildCutover } from '../scripts/build-blog-projection-cutover.mjs';

const require = createRequire(import.meta.url);
const { Miniflare, Response: MFResponse } = createRequire(require.resolve('wrangler/package.json'))('miniflare');
const [workspace, baselineFile, inventoryFile, fixturesFile] = process.argv.slice(2);
if (!workspace || !baselineFile || !inventoryFile || !fixturesFile) throw new Error('Provide workspace, exact baseline, governed inventory and version fixtures');
const baseline = JSON.parse(readFileSync(baselineFile));
const inventory = JSON.parse(readFileSync(inventoryFile));
const fixtures = JSON.parse(readFileSync(fixturesFile));
const targets = [
  { repo: 'MX', project: 'mx', route: '/api/research', hook: '/api/research/lifecycle', secret: 'SZLKBLOG_WEBHOOK_SECRET', migration: 'migrations/0009_shared_blog_analytics.sql' },
  { repo: 'neckfit', project: 'neckmoves', route: '/api/blog?locale=en', hook: '/api/blog/lifecycle', secret: 'SZLKBLOG_WEBHOOK_SECRET', migration: 'migrations/0001_initial.sql' },
  { repo: 'TKM', project: 'tkm', hook: '/api/blog/lifecycle', secret: 'TKM_BLOG_WEBHOOK_SECRET' },
  { repo: 'SZLK', directory: 'homepage', project: 'szlk', hook: '/api/blog/lifecycle', secret: 'SZLK_BLOG_WEBHOOK_SECRET' },
  { repo: 'solopreneur-roadmap', directory: 'website', project: 'solomap', hook: '/api/blog/lifecycle', secret: 'SOLOMAP_BLOG_WEBHOOK_SECRET' },
];
const engines = targets.map((target) => {
  const dependency = createRequire(path.join(workspace, target.repo, target.directory || '', 'package.json'));
  const wranglerDependency = createRequire(dependency.resolve('wrangler/package.json'));
  const runtime = wranglerDependency('workerd');
  return { version: wranglerDependency('workerd/package.json').version, executable: typeof runtime === 'string' ? runtime : runtime.default };
}).sort((left, right) => right.version.localeCompare(left.version));
for (const target of targets) {
  const root = path.join(workspace, target.repo, target.directory || '');
  const originalWorkerdPath = process.env.MINIFLARE_WORKERD_PATH;
  process.env.MINIFLARE_WORKERD_PATH = engines[0].executable;
  const result = await buildCutover(root, baseline[target.repo].head, inventoryFile);
  const directory = path.dirname(result.config);
  const config = JSON.parse(readFileSync(result.config));
  const manifest = inventory.find((entry) => entry.project === target.project);
  const event = manifest.event;
  const origin = new URL(event.post.canonical_url).origin;
  const page = target.route ? origin + target.route : event.post.canonical_url;
  let fetches = 0;
  let unavailable = false;
  const options = {
    modules: true, script: readFileSync(path.join(directory, 'worker.js'), 'utf8'),
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags || [],
    bindings: { ...config.vars, [target.secret]: 'local-cutover-only' },
    durableObjects: Object.fromEntries(config.durable_objects.bindings.map((binding) => [binding.name, { className: binding.class_name, useSQLite: true }])),
    kvNamespaces: (config.kv_namespaces || []).map((binding) => binding.binding),
    d1Databases: (config.d1_databases || []).map((binding) => binding.binding),
    serviceBindings: { ASSETS: () => new MFResponse('asset', { status: 404 }), STATIC_ASSETS: () => new MFResponse('asset', { status: 404 }) },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.hostname === 'api.indexnow.org') return new MFResponse(null, { status: 202 });
      assert.equal(url.origin, 'https://szlkblog.szlk.ai', 'no external network is permitted');
      fetches++;
      if (unavailable) return new MFResponse('authority unavailable', { status: 503 });
      const locale = url.searchParams.get('locale');
      return MFResponse.json({ site_key: result.site, posts: fixtures[target.project].filter((post) => !locale || post.locale === locale), next_cursor: null });
    },
  };
  const mf = new Miniflare({ workers: [{ name: 'main', ...options }] });
  try {
    if (target.migration) {
      const db = await mf.getD1Database('DB');
      const sql = readFileSync(path.join(root, target.migration), 'utf8');
      for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) await db.prepare(statement).run();
    }
    if (target.project === 'tkm') {
      // The deployed reader requires an existing projection before processing events.
      const kv = await mf.getKVNamespace('PAGE_CACHE');
      await kv.put('blog:projection:active:v1', JSON.stringify({
        contractVersion: '2026-08-20', authority: 'szlkblog', generatedAt: event.occurred_at,
        sourceEventId: 'local-prior-event', eventIds: [],
        posts: [{ id: 'local-prior-post', versionId: 'local-prior-version',
          locale: event.post.locale, slug: 'local-prior-post',
          canonicalUrl: origin + '/blog/local-prior-post' }],
      }));
    }
    const headers = { authorization: 'Bearer local-cutover-only', 'content-type': 'application/json', 'x-szlkblog-event-id': event.event_id, 'x-szlkblog-event': event.event_type };
    const seeded = await mf.dispatchFetch(origin + target.hook, { method: 'POST', headers, body: JSON.stringify(event) });
    assert.equal(seeded.status, 200, `${target.project} baseline lifecycle: ${await seeded.text()}`);
    const before = await mf.dispatchFetch(page);
    assert.equal(before.status, 200, `${target.project} baseline page`);
    const beforeBody = await before.text();
    assert.ok(beforeBody.includes(fixtures[target.project][0].title) || beforeBody.includes(event.post.slug), `${target.project} baseline content`);
    const rejected = await mf.dispatchFetch(origin + '/api/blog/projection-migration', { method: 'POST' });
    assert.equal(rejected.status, 401);
    const prepared = await mf.dispatchFetch(origin + '/api/blog/projection-migration', { method: 'POST', headers });
    assert.equal(prepared.status, 200, `${target.project} preparation: ${await prepared.text()}`);
    const state = await mf.dispatchFetch(origin + '/api/blog/projection-migration', { headers });
    const stateBody = await state.json();
    assert.equal(state.status, 200, `${target.project} comparison: ${JSON.stringify(stateBody)}`);
    assert.deepEqual(stateBody.comparison.mismatches, []);
    assert.equal(stateBody.comparison.unchangedVersions, fixtures[target.project].length);
    assert.equal(stateBody.posts.length, fixtures[target.project].length);
    const authorityFetches = fetches;
    unavailable = true;
    assert.equal((await mf.dispatchFetch(page)).status, 200, `${target.project} old page during upstream outage`);
    const preview = await mf.dispatchFetch(page, { headers: { ...headers, 'x-blog-projection-preview': '1' } });
    assert.equal(preview.status, 200, `${target.project} candidate page`);
    assert.equal(preview.headers.get('cache-control'), 'private, no-store');
    await preview.text();
    const finalOptions = { ...options, script: readFileSync(path.join(directory, 'candidate.js'), 'utf8') };
    if (target.project === 'szlk') {
      finalOptions.kvNamespaces = [];
      finalOptions.durableObjects = { BLOG_PROJECTION: { className: 'BlogProjection', useSQLite: true } };
    }
    await mf.setOptions({ workers: [{ name: 'main', ...finalOptions }] });
    const after = await mf.dispatchFetch(page);
    assert.equal(after.status, 200, `${target.project} hard-cut page with upstream unavailable`);
    const afterBody = await after.text();
    assert.ok(afterBody.includes(fixtures[target.project][0].title) || afterBody.includes(event.post.slug), `${target.project} final content`);
    assert.equal(fetches, authorityFetches, `${target.project} materialized page must not refetch authority`);
    console.log(JSON.stringify({ project: target.project, status: 'passed', comparedPosts: stateBody.posts.length, finalPage: page, authorityFetches }));
  } finally {
    await mf.dispose();
    if (originalWorkerdPath === undefined) delete process.env.MINIFLARE_WORKERD_PATH;
    else process.env.MINIFLARE_WORKERD_PATH = originalWorkerdPath;
  }
}
