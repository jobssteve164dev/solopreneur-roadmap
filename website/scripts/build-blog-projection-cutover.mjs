import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { experimental_readRawConfig } from 'wrangler';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler/package.json'))('esbuild');
const hash = (value) => createHash('sha256').update(value).digest('hex');
export function assertMatchingImplementations(sources) {
  const hashes = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, hash(source)]));
  if (new Set(Object.values(hashes)).size !== 1) throw new Error(`Divergent Blog projection implementations: ${JSON.stringify(hashes)}`);
  return Object.values(hashes)[0];
}
const targets = {
  maoxuan: { project: 'mx', site: 'bookreadme', secret: 'SZLKBLOG_WEBHOOK_SECRET', reader: ['src/worker/research.ts', 'activeProjectedPosts'] },
  neckmoves: { project: 'neckmoves', site: 'neckmoves', secret: 'SZLKBLOG_WEBHOOK_SECRET', reader: ['src/worker/blog.ts', 'activeBlogProjection'] },
  thekingmap: { project: 'tkm', site: 'thekingmap', secret: 'TKM_BLOG_WEBHOOK_SECRET', reader: ['src/integrations/blogProjection.ts', 'getActiveBlogProjection'] },
  'szlk-homepage': { project: 'szlk', site: 'szlk', secret: 'SZLK_BLOG_WEBHOOK_SECRET', legacyClass: 'BlogProjectionCoordinator', reader: ['src/blog-projection.js', 'getActiveBlogProjection', 'env.BLOG_PROJECTION'] },
  'solomap-website': { project: 'solomap', site: 'solomap', secret: 'SOLOMAP_BLOG_WEBHOOK_SECRET', legacyClass: 'BlogProjection', reader: ['src/blogProjection.js', 'getActiveBlogProjection'] },
};

export async function buildCutover(root, baseline, inventoryFile) {
  root = path.resolve(root);
  if (!/^[a-f0-9]{40}$/.test(baseline)) throw new Error('An exact baseline commit is required');
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
  const workspace = path.dirname(repo);
  const copies = ['MX/src/worker', 'neckfit/src/worker', 'TKM/src/integrations', 'SZLK/homepage/src', 'solopreneur-roadmap/website/src'];
  const implementationSha256 = assertMatchingImplementations(Object.fromEntries(copies.map((copy) => [copy, readFileSync(path.join(workspace, copy, 'blog-projection-store.js'))])));
  assertMatchingImplementations(Object.fromEntries(copies.map((copy) => [copy, readFileSync(path.join(workspace, copy, 'blog-projection-store.d.ts'))])));
  const configName = ['wrangler.jsonc', 'wrangler.toml'].find((name) => existsSync(path.join(root, name)));
  if (!configName) throw new Error('Existing Wrangler configuration is required');
  const { rawConfig: current } = experimental_readRawConfig({ config: path.join(root, configName) });
  const target = targets[current.name];
  if (!target) throw new Error('Worker is outside the five approved targets');
  const inventory = JSON.parse(readFileSync(inventoryFile, 'utf8')).find((entry) => entry.project === target.project);
  if (!inventory?.event || inventory.event.project_key !== target.project || !inventory.event.site_keys.includes(target.site)) {
    throw new Error('A governed exact event for this project and site is required');
  }
  const output = path.join(root, '.wrangler', 'blog-cutover', hash(baseline + JSON.stringify(inventory)).slice(0, 16));
  mkdirSync(output, { recursive: true });
  const baselineConfig = execFileSync('git', ['show', `${baseline}:${path.relative(repo, path.join(root, configName))}`], { cwd: repo });
  const baselineConfigFile = path.join(output, `baseline.${configName}`);
  writeFileSync(baselineConfigFile, baselineConfig);
  const { rawConfig: previous } = experimental_readRawConfig({ config: baselineConfigFile });
  const options = {
    absWorkingDir: root, entryPoints: [path.resolve(root, current.main)], bundle: true,
    write: false, format: 'esm', platform: 'browser', target: 'es2022', metafile: true,
    external: ['cloudflare:*', 'node:*'],
    ...(existsSync(path.join(root, 'tsconfig.json')) ? { tsconfig: path.join(root, 'tsconfig.json') } : {}),
  };
  const legacyEntry = `export { default } from ${JSON.stringify(path.resolve(root, current.main))};
export * from ${JSON.stringify(path.resolve(root, current.main))};
import { ${target.reader[1]} as read } from ${JSON.stringify(path.resolve(root, target.reader[0]))};
export const readLegacyProjection = (env) => read(${target.reader[2] || 'env'});`;
  const legacy = await build({ ...options, entryPoints: undefined, stdin: { contents: legacyEntry, resolveDir: root, sourcefile: 'baseline-entry.js' }, plugins: [{ name: 'exact-baseline', setup(builder) {
    builder.onLoad({ filter: /\.(?:js|mjs|ts|tsx|jsx|json)$/ }, ({ path: filename }) => {
      if (!filename.startsWith(repo + path.sep) || filename.includes('/node_modules/')) return;
      const relative = path.relative(repo, filename);
      const contents = execFileSync('git', ['show', `${baseline}:${relative}`], { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      const extension = path.extname(filename).slice(1);
      return { contents, loader: extension === 'mjs' ? 'js' : extension, resolveDir: path.dirname(filename) };
    });
  } }] });
  const candidate = await build(options);
  writeFileSync(path.join(output, 'legacy.js'), legacy.outputFiles[0].contents);
  writeFileSync(path.join(output, 'candidate.js'), candidate.outputFiles[0].contents);
  const preservedExports = Object.values(legacy.metafile.outputs)[0].exports.filter((name) => !['default', 'readLegacyProjection', target.legacyClass].includes(name));
  const bindingName = current.name === 'szlk-homepage' ? 'BLOG_PROJECTION_NEXT' : 'BLOG_PROJECTION';
  const runtime = fileURLToPath(new URL('./blog-projection-cutover-runtime.mjs', import.meta.url));
  const entry = `import legacyWorker, * as legacy from './legacy.js';
import candidateWorker, { BlogProjection as Candidate } from './candidate.js';
import { createCutoverObject, createCutoverWorker } from ${JSON.stringify(runtime)};
${preservedExports.length ? `export { ${preservedExports.join(', ')} } from './legacy.js';` : ''}
export const BlogProjection = createCutoverObject(Candidate, ${target.legacyClass ? `legacy.${target.legacyClass}` : 'undefined'});
export default createCutoverWorker({ legacyWorker, legacyRead: legacy.readLegacyProjection, candidateWorker, siteKey: ${JSON.stringify(target.site)}, secretName: ${JSON.stringify(target.secret)}, bindingName: ${JSON.stringify(bindingName)}, lifecyclePath: ${JSON.stringify(target.project === 'mx' ? '/api/research/lifecycle' : '/api/blog/lifecycle')}, event: ${JSON.stringify(inventory.event)} });`;
  const prepared = await build({ stdin: { contents: entry, resolveDir: output, sourcefile: 'cutover-entry.js' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: options.external });
  writeFileSync(path.join(output, 'worker.js'), prepared.outputFiles[0].contents);
  const config = structuredClone(current);
  delete config.$schema;
  config.main = './worker.js';
  if (config.assets?.directory) config.assets.directory = path.resolve(root, config.assets.directory);
  for (const database of config.d1_databases || []) if (database.migrations_dir) database.migrations_dir = path.resolve(root, database.migrations_dir);
  if (current.name === 'szlk-homepage') {
    config.kv_namespaces = previous.kv_namespaces.map((binding) => {
      if (binding.binding !== 'BLOG_PROJECTION') throw new Error('Unexpected legacy KV binding');
      return { ...binding, id: 'b7bda9a94454439384373f6e3a75ba24' };
    });
    config.durable_objects.bindings = [
      { name: bindingName, class_name: 'BlogProjection' },
      { name: 'BLOG_PROJECTION_COORDINATOR', class_name: 'BlogProjection' },
    ];
  }
  writeFileSync(path.join(output, 'wrangler.json'), JSON.stringify(config, null, 2) + '\n');
  const evidence = { worker: current.name, project: target.project, site: target.site, baseline, implementationSha256, eventId: inventory.event.event_id,
    postCount: inventory.posts.length, legacySha256: hash(legacy.outputFiles[0].contents), candidateSha256: hash(candidate.outputFiles[0].contents), migrationSha256: hash(prepared.outputFiles[0].contents) };
  writeFileSync(path.join(output, 'artifact.json'), JSON.stringify(evidence, null, 2) + '\n');
  return { ...evidence, config: path.join(output, 'wrangler.json') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, baseline, inventory] = process.argv.slice(2);
  if (!root || !baseline || !inventory) throw new Error('Usage: build-blog-projection-cutover.mjs <product-directory> <baseline-sha> <governed-inventory.json>');
  console.log(JSON.stringify(await buildCutover(root, baseline, inventory)));
}
