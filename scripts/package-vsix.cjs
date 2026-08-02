#!/usr/bin/env node

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fail(message) {
  console.error(`VSIX packaging failed: ${message}`);
  process.exit(1);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function allowedProductionDependencies(projectRoot) {
  const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
  return new Set(Object.entries(lock.packages || {})
    .filter(([packagePath, metadata]) => packagePath.includes('node_modules/') && metadata.dev !== true)
    .map(([packagePath]) => packagePath));
}

function installedProductionDependencies(projectRoot) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = childProcess.spawnSync(npmCommand, [
    'list',
    '--omit=dev',
    '--parseable',
    '--depth=99999',
    '--loglevel=error'
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (!result.stdout.trim()) {
    throw new Error(result.stderr.trim() || 'npm did not return the installed production dependency list.');
  }
  return result.stdout
    .split(/\r?\n/)
    .map((dependencyPath) => path.relative(projectRoot, dependencyPath).replace(/\\/g, '/'))
    .filter((dependencyPath) => dependencyPath.startsWith('node_modules/'));
}

function createPackagingIgnore(projectRoot) {
  const allowedDependencies = allowedProductionDependencies(projectRoot);
  const installedDependencies = installedProductionDependencies(projectRoot);
  const excludedDependencies = installedDependencies
    .filter((dependencyPath) => !allowedDependencies.has(dependencyPath))
    .sort();
  const baseIgnore = fs.readFileSync(path.join(projectRoot, '.vscodeignore'), 'utf8').trimEnd();
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-vsix-ignore-'));
  const ignorePath = path.join(tempDirectory, '.vscodeignore');
  const dependencyRules = excludedDependencies.map((dependencyPath) => `${dependencyPath}/**`);
  fs.writeFileSync(ignorePath, `${baseIgnore}\n${dependencyRules.join('\n')}\n`, 'utf8');
  return { tempDirectory, ignorePath, excludedDependencies };
}

const projectRoot = path.resolve(__dirname, '..');
const outputArgument = argumentValue('--out');
if (!outputArgument) fail('Usage: node scripts/package-vsix.cjs --out <path-to-vsix>');
const outputPath = path.resolve(projectRoot, outputArgument);
if (fs.existsSync(outputPath)) fail(`refusing to overwrite existing package: ${outputPath}`);

let packagingIgnore;
try {
  packagingIgnore = createPackagingIgnore(projectRoot);
  if (packagingIgnore.excludedDependencies.length > 0) {
    console.log(`Excluding ${packagingIgnore.excludedDependencies.length} local dependencies that are not in the production lockfile.`);
  }
  const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  childProcess.execFileSync(npxCommand, [
    '--yes',
    '@vscode/vsce',
    'package',
    '--out',
    outputPath,
    '--ignoreFile',
    packagingIgnore.ignorePath
  ], { cwd: projectRoot, stdio: 'inherit' });
  childProcess.execFileSync(process.execPath, [
    path.join(projectRoot, 'scripts', 'verify-vsix-package.cjs'),
    outputPath
  ], { cwd: projectRoot, stdio: 'inherit' });
} catch (error) {
  console.error(`VSIX packaging failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (packagingIgnore?.ignorePath && fs.existsSync(packagingIgnore.ignorePath)) {
    fs.unlinkSync(packagingIgnore.ignorePath);
  }
  if (packagingIgnore?.tempDirectory && fs.existsSync(packagingIgnore.tempDirectory)) {
    fs.rmdirSync(packagingIgnore.tempDirectory);
  }
}
