// Shared Worker projection contract: immutable articles, two complete releases,
// transactional activation, and bounded event deduplication.
export class ProjectionStore {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS projection_documents (key TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS projection_state (id INTEGER PRIMARY KEY CHECK (id = 1), active TEXT NOT NULL, previous TEXT, events TEXT NOT NULL)');
  }

  state() {
    const row = [...this.sql.exec('SELECT active, previous, events FROM projection_state WHERE id = 1')][0];
    return row ? { active: JSON.parse(row.active), previous: row.previous ? JSON.parse(row.previous) : null, events: JSON.parse(row.events) } : null;
  }

  hasEvent(eventId) {
    return Boolean(this.state()?.events.includes(eventId));
  }

  async read() {
    const state = this.state();
    if (!state) return null;
    const rows = [...this.sql.exec('SELECT d.payload FROM json_each(?) m JOIN projection_documents d ON d.key = m.value ORDER BY CAST(m.key AS INTEGER)', JSON.stringify(state.active.keys))];
    if (rows.length !== state.active.keys.length) throw new Error('Incomplete active Blog projection');
    const { keys, ...metadata } = state.active;
    return { ...metadata, posts: rows.map((row) => JSON.parse(row.payload)) };
  }

  async activate(eventId, posts) {
    if (!eventId || !Array.isArray(posts)) throw new Error('Invalid projection activation');
    const before = this.state();
    if (before?.events.includes(eventId)) return { status: 'already_current', setId: before.active.setId, postCount: before.active.keys.length };
    const identities = new Set();
    const documents = [];
    for (const post of posts) {
      const identity = JSON.stringify([post.locale, post.slug]);
      if (!post.id || !post.locale || !post.slug || !post.versionId || !post.contentDigest || identities.has(identity)) throw new Error('Invalid or duplicate projected article');
      identities.add(identity);
      const payload = JSON.stringify(post);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
      const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      documents.push({ key, payload });
    }
    const keys = documents.map((document) => document.key);
    // Fetch and activation are serialized by the owning Durable Object. Still
    // reject a concurrent writer rather than committing against a stale base.
    let result;
    this.storage.transactionSync(() => {
      const current = this.state();
      if (current?.active.setId !== before?.active.setId || JSON.stringify(current?.events) !== JSON.stringify(before?.events)) throw new Error('Concurrent Blog activation requires reconciliation');
      const events = [...(before?.events || []), eventId].slice(-200);
      if (before && JSON.stringify(keys) === JSON.stringify(before.active.keys)) {
        this.sql.exec('UPDATE projection_state SET events = ? WHERE id = 1', JSON.stringify(events));
        result = { status: 'already_current', setId: before.active.setId, postCount: keys.length };
        return;
      }
      const retained = new Set([...(before?.active.keys || []), ...keys]);
      const existing = new Set([...(before?.active.keys || []), ...(before?.previous?.keys || [])]);
      for (const document of documents) {
        if (!existing.has(document.key)) this.sql.exec('INSERT INTO projection_documents (key, payload) VALUES (?, ?)', document.key, document.payload);
      }
      const active = { keys, setId: crypto.randomUUID(), contractVersion: '2026-08-20', authority: 'szlkblog', generatedAt: new Date().toISOString(), sourceEventId: eventId };
      this.sql.exec('INSERT INTO projection_state (id, active, previous, events) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET active = excluded.active, previous = excluded.previous, events = excluded.events', JSON.stringify(active), before ? JSON.stringify(before.active) : null, JSON.stringify(events));
      // Only exact documents absent from both retained releases are retired.
      for (const key of before?.previous?.keys || []) {
        if (!retained.has(key)) this.sql.exec('DELETE FROM projection_documents WHERE key = ?', key);
      }
      result = { status: 'activated', setId: active.setId, postCount: keys.length };
    });
    return result;
  }
}

export function createProjectionObject({ validateEvent, fetchPosts, validateSnapshot }) {
  return class {
    constructor(state, env) {
      this.env = env;
      this.store = new ProjectionStore(state.storage);
      this.queue = Promise.resolve();
    }

    handle(event, fetcher = fetch) {
      const result = this.queue.then(async () => {
        validateEvent(event, this.env);
        if (this.store.hasEvent(event.event_id)) return { accepted: true, status: 'already_current' };
        const posts = await fetchPosts(this.env, fetcher);
        const status = validateSnapshot(event, posts);
        const activation = await this.store.activate(event.event_id, posts);
        return { accepted: true, ...activation, status: status === 'superseded' ? status : activation.status };
      });
      this.queue = result.then(() => undefined, () => undefined);
      return result;
    }

    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/snapshot') {
        const snapshot = await this.store.read();
        return Response.json(snapshot, { status: snapshot ? 200 : 503 });
      }
      if (request.method !== 'POST' || url.pathname !== '/activate') return new Response('Not found', { status: 404 });
      try {
        const { event } = await request.json();
        return Response.json(await this.handle(event));
      } catch (error) {
        console.error('Blog projection activation failed', { message: error instanceof Error ? error.message : String(error) });
        return Response.json({ error: 'Blog projection was not activated' }, { status: 503 });
      }
    }
  };
}

export function projectionStub(binding, siteKey) {
  if (!binding) throw new Error('Blog projection binding is unavailable');
  return binding.get(binding.idFromName(`blog:${siteKey}`));
}
