#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXTENSION_ID = 'szlk.solopreneur-roadmap';
const DEV_DIRNAME = `${EXTENSION_ID}-dev`;
const LINK_NAMES = ['package.json', 'README.md', 'out', 'resources', 'node_modules'];

function getRepoRoot() {
  return path.resolve(__dirname, '..');
}

function getDefaultExtensionsBase() {
  return process.env.CODE_SERVER_EXTENSIONS_DIR || path.join(os.homedir(), '.local', 'share', 'code-server', 'extensions');
}

function getDevInstallDir(extensionsBase = getDefaultExtensionsBase()) {
  return path.join(extensionsBase, DEV_DIRNAME);
}

function ensureSafeLinkSlot(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink() || stat.isFile()) {
    fs.unlinkSync(targetPath);
    return;
  }

  throw new Error(`Refusing to overwrite non-link directory: ${targetPath}`);
}

function prepareLocalDevExtension(repoRoot = getRepoRoot(), extensionsBase = getDefaultExtensionsBase()) {
  const installDir = getDevInstallDir(extensionsBase);
  fs.mkdirSync(installDir, { recursive: true });

  for (const name of LINK_NAMES) {
    const linkPath = path.join(installDir, name);
    ensureSafeLinkSlot(linkPath);
    fs.symlinkSync(path.join(repoRoot, name), linkPath);
  }

  return installDir;
}

function buildExtensionsRegistryEntry(repoRoot, version, extensionsBase = getDefaultExtensionsBase()) {
  const installDir = getDevInstallDir(extensionsBase);
  return {
    identifier: { id: EXTENSION_ID },
    version,
    location: {
      $mid: 1,
      fsPath: installDir,
      external: `file://${installDir}`,
      path: installDir,
      scheme: 'file'
    },
    relativeLocation: path.basename(installDir)
  };
}

function updateExtensionsRegistry(repoRoot = getRepoRoot(), extensionsBase = getDefaultExtensionsBase()) {
  const packageJson = require(path.join(repoRoot, 'package.json'));
  const registryPath = path.join(extensionsBase, 'extensions.json');
  const currentEntries = fs.existsSync(registryPath)
    ? JSON.parse(fs.readFileSync(registryPath, 'utf8'))
    : [];
  const nextEntry = buildExtensionsRegistryEntry(repoRoot, packageJson.version, extensionsBase);
  const nextEntries = currentEntries.filter((entry) => entry.identifier?.id !== EXTENSION_ID);
  nextEntries.push(nextEntry);
  fs.writeFileSync(registryPath, JSON.stringify(nextEntries, null, 2));
  return nextEntry;
}

function validateLocalDevInstall(installDir) {
  const missing = LINK_NAMES.filter((name) => !fs.existsSync(path.join(installDir, name)));
  if (missing.length > 0) {
    throw new Error(`Missing local dev extension assets: ${missing.join(', ')}`);
  }

  require.resolve('papaparse', { paths: [installDir] });
  require.resolve('sql.js', { paths: [installDir] });
}

function installLocalDevExtension(repoRoot = getRepoRoot(), extensionsBase = getDefaultExtensionsBase()) {
  const installDir = prepareLocalDevExtension(repoRoot, extensionsBase);
  const registryEntry = updateExtensionsRegistry(repoRoot, extensionsBase);
  validateLocalDevInstall(installDir);
  return { installDir, registryEntry };
}

if (require.main === module) {
  const { installDir, registryEntry } = installLocalDevExtension();
  console.log(`Installed ${EXTENSION_ID} local dev extension at ${installDir}`);
  console.log(`Registered version ${registryEntry.version}`);
}

module.exports = {
  EXTENSION_ID,
  DEV_DIRNAME,
  LINK_NAMES,
  getDevInstallDir,
  prepareLocalDevExtension,
  buildExtensionsRegistryEntry,
  updateExtensionsRegistry,
  validateLocalDevInstall,
  installLocalDevExtension
};
