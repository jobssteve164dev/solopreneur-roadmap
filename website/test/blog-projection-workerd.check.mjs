import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = wranglerRequire('miniflare');
const { build } = wranglerRequire('esbuild');

test('final bundled projection uses bounded SQLite writes in actual workerd', async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/blog-projection-cost.worker.js', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser' });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-08-01', durableObjects: { STORE: { className: 'CostProjection', useSQLite: true } } });
  try {
    const namespace = await mf.getDurableObjectNamespace('STORE');
    const response = await namespace.get(namespace.idFromName('local-cost')).fetch('https://cost/check');
    assert.equal(response.status, 200);
    const result = await response.json();
    console.log('SQLite projection cost:', JSON.stringify(result));
    assert.equal(result.count, 1000);
    assert.equal(result.changedBody, 'changed');
    assert.equal(result.duplicate.writes, 0);
    assert.ok(result.unchanged.writes <= 2);
    assert.ok(result.changed.writes <= 5);
  } finally { await mf.dispose(); }
});
