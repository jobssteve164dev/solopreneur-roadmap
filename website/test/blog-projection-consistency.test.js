import assert from 'node:assert/strict';
import test from 'node:test';

const builder = await import('../scripts/build-blog-projection-cutover.mjs');

test('release preparation rejects divergent consumer implementations', () => {
  assert.equal(typeof builder.assertMatchingImplementations, 'function');
  assert.doesNotThrow(() => builder.assertMatchingImplementations({ first: 'same source', second: 'same source' }));
  assert.throws(() => builder.assertMatchingImplementations({ first: 'same source', second: 'different source' }), /divergent/i);
});
