import assert from 'node:assert/strict';
import test from 'node:test';
import { storage } from './helpers/projection-storage.js';
import { createProjectionObject } from '../src/blog-projection-store.js';

const migration = await import('../scripts/blog-projection-cutover-runtime.mjs').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

test('explicit authenticated preparation fills the new object while ordinary requests keep the old publication', async () => {
  assert.equal(typeof migration.createCutoverWorker, 'function', 'an explicit prefill path is required before hard cutover');
  const state = storage();
  let authorityCalls = 0;
  const event = { event_id: 'exact-event', project_key: 'allowed' };
  const Candidate = createProjectionObject({
    validateEvent(value) { assert.deepEqual(value, event); },
    async fetchPosts() { authorityCalls++; return [{ id: 'p', locale: 'en', slug: 'guide', versionId: 'v2', contentDigest: 'd2', body: 'new' }]; },
    validateSnapshot() { return 'activated'; },
  });
  const ObjectClass = migration.createCutoverObject(Candidate);
  const object = new ObjectClass({ storage: state }, {});
  const env = { SECRET: 'local-test-secret', STORE: {
    idFromName(name) { assert.equal(name, 'blog:site'); return name; },
    get() { return { fetch(input, init) { return object.fetch(new Request(input, init)); } }; },
  } };
  const worker = migration.createCutoverWorker({
    legacyWorker: { fetch() { return new Response('old'); } },
    async legacyRead() { return [{ id: 'p', locale: 'en', slug: 'guide', versionId: 'v1', contentDigest: 'd1', body: 'old' }]; },
    candidateWorker: { async fetch(_request, bindings) {
      const response = await bindings.BLOG_PROJECTION.get(bindings.BLOG_PROJECTION.idFromName('blog:site')).fetch('https://projection/snapshot');
      return new Response((await response.json()).posts[0].body);
    } },
    siteKey: 'site', secretName: 'SECRET', bindingName: 'STORE', event,
  });
  const request = (method = 'GET', authorized = true) => new Request('https://site/api/blog/projection-migration', {
    method, headers: authorized ? { authorization: 'Bearer local-test-secret' } : {},
  });
  assert.equal((await worker.fetch(request('POST', false), env, {})).status, 401);
  assert.equal(authorityCalls, 0);
  assert.equal(await (await worker.fetch(new Request('https://site/blog'), env, {})).text(), 'old');
  assert.equal((await worker.fetch(request('POST'), env, {})).status, 200);
  assert.equal((await worker.fetch(request('POST'), env, {})).status, 200);
  assert.equal(authorityCalls, 1);
  const manifest = await (await worker.fetch(request(), env, {})).json();
  assert.equal(manifest.posts[0].versionId, 'v2');
  assert.equal(manifest.posts[0].body, undefined, 'migration status does not export article bodies');
  assert.deepEqual(manifest.comparison, { previousCount: 1, currentCount: 1, unchangedVersions: 0, changedVersions: 1, missingIds: [], mismatches: [] });
  assert.equal(await (await worker.fetch(new Request('https://site/blog'), env, {})).text(), 'old');
  const preview = new Request('https://site/blog', { headers: { authorization: 'Bearer local-test-secret', 'x-blog-projection-preview': '1' } });
  assert.equal(await (await worker.fetch(preview, env, {})).text(), 'new');
  assert.equal((await worker.fetch(preview, env, {})).headers.get('cache-control'), 'private, no-store');
  assert.equal(authorityCalls, 1);
  state.db.close();
});

test('events arriving after preparation update both publications before acknowledgement', async () => {
  const state = storage();
  let version = 'v1';
  let failActivation = false;
  let legacyPosts;
  const posts = () => [{ id: 'p', locale: 'en', slug: 'guide', versionId: version, contentDigest: version }];
  const Candidate = createProjectionObject({ validateEvent() {}, fetchPosts: async () => { if (failActivation) throw new Error('local authority failure'); return posts(); }, validateSnapshot: () => 'activated' });
  const object = new (migration.createCutoverObject(Candidate))({ storage: state }, {});
  const env = { SECRET: 'local-test-secret', STORE: { idFromName: (name) => name,
    get: () => ({ fetch: (input, init) => object.fetch(new Request(input, init)) }) } };
  const worker = migration.createCutoverWorker({
    legacyWorker: { async fetch() { legacyPosts = posts(); return Response.json({ ok: true }); } },
    legacyRead: async () => legacyPosts || posts(), candidateWorker: {},
    siteKey: 'site', secretName: 'SECRET', bindingName: 'STORE', event: { event_id: 'seed' }, lifecyclePath: '/api/blog/lifecycle',
  });
  const headers = { authorization: 'Bearer local-test-secret', 'content-type': 'application/json' };
  await worker.fetch(new Request('https://site/api/blog/projection-migration', { method: 'POST', headers }), env, {});
  version = 'v2';
  const delivered = await worker.fetch(new Request('https://site/api/blog/lifecycle', { method: 'POST', headers, body: JSON.stringify({ event_id: 'later' }) }), env, {});
  assert.equal(delivered.status, 200);
  const manifest = await (await worker.fetch(new Request('https://site/api/blog/projection-migration', { headers }), env, {})).json();
  assert.equal(manifest.posts[0].versionId, 'v2');
  assert.equal(manifest.comparison.unchangedVersions, 1);
  version = 'v3';
  failActivation = true;
  const retryRequest = () => new Request('https://site/api/blog/lifecycle', { method: 'POST', headers, body: JSON.stringify({ event_id: 'retry-event' }) });
  const failed = await worker.fetch(retryRequest(), env, {});
  assert.equal(failed.status, 503, 'failed candidate must not acknowledge delivery');
  failActivation = false;
  assert.equal((await worker.fetch(retryRequest(), env, {})).status, 200);
  const recovered = await (await worker.fetch(new Request('https://site/api/blog/projection-migration', { headers }), env, {})).json();
  assert.equal(recovered.posts[0].versionId, 'v3');
  assert.equal(recovered.comparison.unchangedVersions, 1);
  state.db.close();
});
