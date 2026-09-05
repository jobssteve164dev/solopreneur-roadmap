import { ProjectionStore } from '../../src/blog-projection-store.js';

export class CostProjection {
  constructor(state) { this.state = state; }
  async fetch() {
    let reads = 0;
    let writes = 0;
    const storage = {
      sql: { exec: (query, ...args) => {
        const cursor = this.state.storage.sql.exec(query, ...args);
        const rows = cursor.toArray();
        reads += cursor.rowsRead;
        writes += cursor.rowsWritten;
        return rows;
      } },
      transactionSync: (fn) => this.state.storage.transactionSync(fn),
    };
    const store = new ProjectionStore(storage);
    const posts = Array.from({ length: 1000 }, (_, i) => ({ id: `p${i}`, locale: 'en', slug: `p${i}`, versionId: 'v1', contentDigest: `d${i}`, body: 'article '.repeat(100) }));
    await store.activate('first', posts);
    const seeded = { reads, writes };
    await store.activate('first', posts);
    const duplicate = { reads: reads - seeded.reads, writes: writes - seeded.writes };
    reads = 0; writes = 0;
    await store.activate('same-content', posts);
    const unchanged = { reads, writes };
    reads = 0; writes = 0;
    posts[500] = { ...posts[500], versionId: 'v2', body: 'changed' };
    await store.activate('second', posts);
    const changed = { reads, writes };
    const snapshot = await new ProjectionStore(storage).read();
    return Response.json({ seeded, duplicate, unchanged, changed, count: snapshot.posts.length, changedBody: snapshot.posts[500].body });
  }
}

export default { fetch() { return new Response('Local projection cost test'); } };
