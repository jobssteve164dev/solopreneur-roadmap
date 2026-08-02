#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 40 * 1024 * 1024;
const REQUIRED_FILES = [
  'extension/out/extension.js',
  'extension/resources/activitybar.svg',
  'extension/resources/logo.png',
  'extension/resources/logo_with_text.svg',
  'extension/resources/tools/solomap-experience.cjs',
  'extension/resources/tools/solomap-memory.cjs',
  'extension/node_modules/@vscode/codicons/dist/codicon.css',
  'extension/node_modules/c8/bin/c8.js',
  'extension/node_modules/dependency-cruiser/bin/dependency-cruise.mjs',
  'extension/node_modules/istanbul-lib-coverage/index.js',
  'extension/node_modules/papaparse/papaparse.js',
  'extension/node_modules/sql.js/dist/sql-wasm.js',
  'extension/node_modules/sql.js/dist/sql-wasm.wasm'
];
const FORBIDDEN_PREFIXES = [
  'extension/.agents/',
  'extension/.playwright-cli/',
  'extension/.solopreneur/',
  'extension/cache/',
  'extension/docs/',
  'extension/output/',
  'extension/scripts/',
  'extension/src/',
  'extension/test/',
  'extension/website/'
];
const FORBIDDEN_FILES = new Set([
  'extension/AGENTS.md',
  'extension/PROJECT_MEMORY.md',
  'extension/agent.md',
  'extension/skills-lock.json',
  'extension/tsconfig.json'
]);
const ALLOWED_SQL_DIST_FILES = new Set([
  'extension/node_modules/sql.js/dist/sql-wasm.js',
  'extension/node_modules/sql.js/dist/sql-wasm.wasm'
]);

function fail(message) {
  console.error(`VSIX audit failed: ${message}`);
  process.exit(1);
}

function readZipEntries(vsixPath) {
  const archive = fs.readFileSync(vsixPath);
  const minimumOffset = Math.max(0, archive.length - 0xffff - 22);
  let directoryOffset = -1;
  let entryCount = 0;

  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) !== 0x06054b50) continue;
    entryCount = archive.readUInt16LE(offset + 10);
    directoryOffset = archive.readUInt32LE(offset + 16);
    break;
  }
  if (directoryOffset < 0 || entryCount === 0xffff || directoryOffset === 0xffffffff) {
    throw new Error('Unsupported or invalid ZIP central directory.');
  }

  const entries = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid ZIP entry at central directory offset ${offset}.`);
    }
    const compressedBytes = archive.readUInt32LE(offset + 20);
    const uncompressedBytes = archive.readUInt32LE(offset + 24);
    const fileNameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    if (compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff) {
      throw new Error('ZIP64 entries are not supported by the package audit.');
    }
    const nameStart = offset + 46;
    const name = archive.toString('utf8', nameStart, nameStart + fileNameLength);
    entries.push({ name, compressedBytes, uncompressedBytes });
    offset = nameStart + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function packagedDependencyPath(entryName) {
  if (!entryName.startsWith('extension/node_modules/')) return '';
  const segments = entryName.slice('extension/'.length).split('/');
  if (!segments[1] || segments[1] === '.bin') return '';
  const packageEnd = segments[1].startsWith('@') ? 2 : 1;
  if (!segments[packageEnd]) return '';
  return segments.slice(0, packageEnd + 1).join('/');
}

function allowedProductionDependencies(projectRoot) {
  const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
  return new Set(Object.entries(lock.packages || {})
    .filter(([packagePath, metadata]) => packagePath.includes('node_modules/') && metadata.dev !== true)
    .map(([packagePath]) => packagePath));
}

const vsixPath = process.argv[2];
if (!vsixPath) fail('Usage: node scripts/verify-vsix-package.cjs <path-to-vsix>');
if (!fs.existsSync(vsixPath)) fail(`Package does not exist: ${vsixPath}`);

try {
  const projectRoot = path.resolve(__dirname, '..');
  const entries = readZipEntries(vsixPath);
  const entryNames = new Set(entries.map((entry) => entry.name));
  const archiveBytes = fs.statSync(vsixPath).size;
  const uncompressedBytes = entries.reduce((total, entry) => total + entry.uncompressedBytes, 0);
  const allowedDependencies = allowedProductionDependencies(projectRoot);
  const unexpectedDependencies = new Set();

  for (const entry of entries) {
    const packagePath = packagedDependencyPath(entry.name);
    if (packagePath && !allowedDependencies.has(packagePath)) unexpectedDependencies.add(packagePath);
  }

  const missingFiles = REQUIRED_FILES.filter((file) => !entryNames.has(file));
  const forbiddenFiles = entries
    .map((entry) => entry.name)
    .filter((name) => FORBIDDEN_FILES.has(name)
      || FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix))
      || /^extension\/out\/.*\.js\.map$/.test(name)
      || /^extension\/resources\/(?:logo_with_text\.png|solomap_)/.test(name)
      || (name.startsWith('extension/node_modules/sql.js/dist/') && !ALLOWED_SQL_DIST_FILES.has(name)));

  if (missingFiles.length > 0) fail(`missing runtime files:\n- ${missingFiles.join('\n- ')}`);
  if (forbiddenFiles.length > 0) fail(`non-runtime files were packaged:\n- ${forbiddenFiles.slice(0, 20).join('\n- ')}`);
  if (unexpectedDependencies.size > 0) {
    fail(`dependencies outside the production lockfile were packaged:\n- ${[...unexpectedDependencies].sort().join('\n- ')}`);
  }
  if (archiveBytes > MAX_COMPRESSED_BYTES) {
    fail(`compressed package is ${(archiveBytes / 1024 / 1024).toFixed(2)} MiB; limit is ${MAX_COMPRESSED_BYTES / 1024 / 1024} MiB.`);
  }
  if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
    fail(`uncompressed package is ${(uncompressedBytes / 1024 / 1024).toFixed(2)} MiB; limit is ${MAX_UNCOMPRESSED_BYTES / 1024 / 1024} MiB.`);
  }

  console.log(`VSIX audit passed: ${entries.length} files, ${(archiveBytes / 1024 / 1024).toFixed(2)} MiB compressed, ${(uncompressedBytes / 1024 / 1024).toFixed(2)} MiB uncompressed.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
