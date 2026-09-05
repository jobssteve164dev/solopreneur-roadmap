import assert from 'node:assert/strict';
import test from 'node:test';
import { storage } from './helpers/projection-storage.js';

const module = await import('../src/blog-projection-store.js').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});


test('one changed article writes bounded rows; identical snapshots and duplicate events do not rewrite content', async () => {
  assert.equal(typeof module.ProjectionStore, 'function', 'incremental projection storage is required');
  const state = storage();
  const store = new module.ProjectionStore(state);
  const posts = Array.from({ length: 1000 }, (_, i) => ({ id: `p${i}`, locale: 'en', slug: `article-${i}`, versionId: 'v1', contentDigest: `d${i}`, body: 'a'.repeat(300) }));
  await store.activate('e1', posts);
  const initialWrites = state.written;
  assert.equal((await store.read()).posts.length, 1000);
  assert.equal((await store.activate('e1', posts)).status, 'already_current');
  assert.equal(state.written, initialWrites);
  assert.equal((await store.activate('e2', posts)).status, 'already_current');
  const before = state.written;
  const next = structuredClone(posts);
  next[500].versionId = 'v2'; next[500].body = 'updated';
  assert.equal((await store.activate('e3', next)).status, 'activated');
  assert.ok(state.written - before <= 5, `one article wrote ${state.written - before} rows`);
  assert.equal((await store.read()).posts[500].body, 'updated');
  const restarted = new module.ProjectionStore(state);
  assert.deepEqual((await restarted.read()).posts, next);
  state.db.close();
});

test('empty publication removes public articles; failed transaction keeps the prior complete publication', async () => {
  assert.equal(typeof module.ProjectionStore, 'function', 'incremental projection storage is required');
  const state = storage();
  const store = new module.ProjectionStore(state);
  const posts = [{ id: 'p', locale: 'en', slug: 'guide', versionId: 'v1', contentDigest: 'd1' }];
  await store.activate('first', posts);
  state.db.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON projection_state BEGIN SELECT RAISE(ABORT, 'disk failure'); END;");
  await assert.rejects(() => store.activate('failed', [{ ...posts[0], versionId: 'v2' }]), /disk failure/);
  assert.deepEqual((await new module.ProjectionStore(state).read()).posts, posts);
  state.db.exec('DROP TRIGGER reject_update');
  await store.activate('removed', []);
  assert.deepEqual((await new module.ProjectionStore(state).read()).posts, []);
  state.db.close();
});

test('authority fetches are serialized and an upstream failure never replaces the last complete snapshot', async () => {
  assert.equal(typeof module.createProjectionObject, 'function', 'serialized authority reconciliation is required');
  const state = storage();
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const ObjectClass = module.createProjectionObject({
    validateEvent(event) { assert.equal(event.project_key, 'allowed'); },
    async fetchPosts(_env, fetcher) { return fetcher(); },
    validateSnapshot() { return 'activated'; },
  });
  const object = new ObjectClass({ storage: state }, {});
  const makePosts = (version) => [{ id: 'p', locale: 'en', slug: 'guide', versionId: version, contentDigest: version }];
  const event = { event_id: 'one', project_key: 'allowed', event_type: 'post.published', post: {} };
  const first = object.handle(event, async () => { calls++; await paused; return makePosts('one'); });
  const second = object.handle({ ...event, event_id: 'two' }, async () => { calls++; return makePosts('two'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal((await object.store.read()).posts[0].versionId, 'two');
  await assert.rejects(() => object.handle({ ...event, event_id: 'three' }, async () => { throw new Error('authority unavailable'); }), /authority unavailable/);
  assert.equal((await object.store.read()).posts[0].versionId, 'two');
  await assert.rejects(() => object.handle({ ...event, project_key: 'other' }, async () => { throw new Error('must not fetch'); }));
  state.db.close();
});

test('a late publication event converges to the current authority snapshot and is then deduplicated', async () => {
  const state = storage();
  let calls = 0;
  const ObjectClass = module.createProjectionObject({
    validateEvent() {},
    async fetchPosts() { calls++; return [{ id: 'p', locale: 'en', slug: 'guide', versionId: 'new', contentDigest: 'new' }]; },
    validateSnapshot() { return 'superseded'; },
  });
  const object = new ObjectClass({ storage: state }, {});
  assert.equal((await object.handle({ event_id: 'late' })).status, 'superseded');
  assert.equal((await object.store.read())?.posts[0].versionId, 'new');
  const restarted = new ObjectClass({ storage: state }, {});
  assert.equal((await restarted.handle({ event_id: 'late' })).status, 'already_current');
  assert.equal(calls, 1);
  state.db.close();
});
