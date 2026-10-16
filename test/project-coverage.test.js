const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { sendRuntimeControlCommand } = require('../out/autonomousRuntimeControl.js');

const projectRoot = path.resolve(__dirname, '..');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function launchRuntime(root) {
  const child = spawn(process.execPath, [path.join(projectRoot, 'out', 'autonomousRuntimeProcess.js'), '--global-data-path', root], { stdio: 'pipe' });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.stdout.resume();
  return { child, errors: () => stderr };
}

async function waitForRuntime(run, root) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(root, 'runtime', 'control.json'))) {
    assert.equal(run.child.exitCode, null, run.errors());
    assert.ok(Date.now() < deadline, run.errors() || 'Runtime did not publish readiness');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function stopRuntime(run, root) {
  if (run.child.exitCode !== null) return;
  const exited = once(run.child, 'exit');
  try { await sendRuntimeControlCommand(root, 'stop'); } catch { run.child.kill(); }
  await exited;
}

test('coverage analysis runs c8 once, persists Istanbul evidence, and reuses the active run', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-coverage-'));
  const globalDataPath = path.join(tempRoot, '.solomap-global');
  const runtime = launchRuntime(globalDataPath);
  await waitForRuntime(runtime, globalDataPath);
  t.after(async () => { await stopRuntime(runtime, globalDataPath); fs.rmSync(tempRoot, { recursive: true, force: true }); });
  writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({
    name: 'coverage-fixture',
    private: true,
    scripts: { test: 'node --test test/*.test.js' }
  }));
  writeFile(path.join(tempRoot, 'src', 'math.js'), [
    'exports.add = (left, right) => left + right;',
    'exports.choose = (enabled) => enabled ? 1 : 0;'
  ].join('\n'));
  writeFile(path.join(tempRoot, 'test', 'math.test.js'), [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const { add } = require('../src/math.js');",
    "test('adds values', () => assert.equal(add(2, 3), 5));"
  ].join('\n'));

  const {
    loadProjectCoverageSnapshot,
    runProjectCoverageAnalysis
  } = require(path.join(projectRoot, 'out', 'projectCoverage.js'));
  const firstRun = runProjectCoverageAnalysis(tempRoot, projectRoot, globalDataPath);
  const duplicateRun = runProjectCoverageAnalysis(tempRoot, projectRoot, globalDataPath);
  assert.equal(firstRun, duplicateRun);

  const snapshot = await firstRun;
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.testPassed, true);
  assert.ok(snapshot.durationMs > 0);
  const mathCoverage = snapshot.files.find((file) => file.path === 'src/math.js');
  assert.ok(mathCoverage);
  assert.ok(mathCoverage.lines.covered > 0, JSON.stringify(snapshot.files));
  assert.ok(mathCoverage.functions.percent < 100);

  const persisted = await loadProjectCoverageSnapshot(tempRoot, globalDataPath);
  assert.deepEqual(persisted, snapshot);
  assert.equal(fs.existsSync(path.join(tempRoot, '.solopreneur', 'coverage')), false);

  writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'coverage-fixture', private: true }));
  const stale = await runProjectCoverageAnalysis(tempRoot, projectRoot, globalDataPath);
  assert.equal(stale.status, 'stale_failed');
  assert.equal(stale.generatedAt, snapshot.generatedAt);
  assert.deepEqual(stale.files, snapshot.files);
});

test('coverage analysis does not run a command when the project has no test script', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-coverage-empty-'));
  const globalDataPath = path.join(tempRoot, '.solomap-global');
  const runtime = launchRuntime(globalDataPath);
  await waitForRuntime(runtime, globalDataPath);
  t.after(async () => { await stopRuntime(runtime, globalDataPath); fs.rmSync(tempRoot, { recursive: true, force: true }); });
  writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'no-tests', private: true }));

  const { runProjectCoverageAnalysis } = require(path.join(projectRoot, 'out', 'projectCoverage.js'));
  const snapshot = await runProjectCoverageAnalysis(tempRoot, projectRoot, globalDataPath);
  assert.equal(snapshot.status, 'unavailable');
  assert.match(snapshot.error, /npm test/);
  assert.equal(fs.existsSync(path.join(tempRoot, '.solopreneur', 'coverage')), false);
});
