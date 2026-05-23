const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  EXTENSION_ID,
  DEV_DIRNAME,
  prepareLocalDevExtension,
  buildExtensionsRegistryEntry,
  updateExtensionsRegistry,
  validateLocalDevInstall,
  installLocalDevExtension
} = require('../scripts/install-local-dev.js');

const projectRoot = path.resolve(__dirname, '..');

test('local dev installer creates stable repo-backed links and resolves runtime deps', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-local-install-'));
  const installDir = prepareLocalDevExtension(projectRoot, tempRoot);

  assert.equal(path.basename(installDir), DEV_DIRNAME);
  for (const name of ['package.json', 'README.md', 'out', 'resources', 'node_modules']) {
    const linkPath = path.join(installDir, name);
    assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(linkPath), path.join(projectRoot, name));
  }

  assert.doesNotThrow(() => validateLocalDevInstall(installDir));
});

test('local dev installer writes stable extensions.json entry instead of version-chain path', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-local-registry-'));
  fs.writeFileSync(path.join(tempRoot, 'extensions.json'), JSON.stringify([
    {
      identifier: { id: EXTENSION_ID },
      version: '0.0.1',
      location: { path: '/old/version/path' },
      relativeLocation: `${EXTENSION_ID}-0.0.1-link`
    }
  ], null, 2));

  const entry = updateExtensionsRegistry(projectRoot, tempRoot);
  const savedEntries = JSON.parse(fs.readFileSync(path.join(tempRoot, 'extensions.json'), 'utf8'));

  assert.equal(savedEntries.length, 1);
  assert.equal(savedEntries[0].identifier.id, EXTENSION_ID);
  assert.equal(savedEntries[0].relativeLocation, DEV_DIRNAME);
  assert.equal(savedEntries[0].location.path, path.join(tempRoot, DEV_DIRNAME));
  assert.equal(entry.relativeLocation, DEV_DIRNAME);
});

test('local dev installer end-to-end output keeps extension activation path stable', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-local-e2e-'));
  const { installDir, registryEntry } = installLocalDevExtension(projectRoot, tempRoot);
  const packageJson = require(path.join(projectRoot, 'package.json'));
  const rebuiltEntry = buildExtensionsRegistryEntry(projectRoot, packageJson.version, tempRoot);

  assert.equal(installDir, path.join(tempRoot, DEV_DIRNAME));
  assert.equal(registryEntry.version, packageJson.version);
  assert.deepEqual(registryEntry, rebuiltEntry);
  assert.doesNotThrow(() => require.resolve('papaparse', { paths: [installDir] }));
});
