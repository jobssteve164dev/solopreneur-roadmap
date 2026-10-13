const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function removeOwnedEntry(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`test_fixture_outside_owned_root:${target}`);
  const info = fs.lstatSync(target);
  if (info.isDirectory() && !info.isSymbolicLink()) {
    for (const name of fs.readdirSync(target)) removeOwnedEntry(root, path.join(target, name));
    fs.rmdirSync(target);
    return;
  }
  fs.unlinkSync(target);
}

const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-node-tests-'));
const testRunId = crypto.randomUUID();
const inheritedOwners = String(process.env.SOLOMAP_TEST_RUN_OWNERS || '').split(',').filter(Boolean);
const testRunOwners = [...inheritedOwners, testRunId].join(',');
const child = childProcess.spawn(process.execPath, ['--test', ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: { ...process.env, TMPDIR: ownedRoot, TMP: ownedRoot, TEMP: ownedRoot, SOLOMAP_TEST_RUN_OWNERS: testRunOwners },
  stdio: 'inherit',
  detached: process.platform !== 'win32'
});
let requestedSignal;

function ownedProcessIds() {
  if (process.platform !== 'linux') return [];
  const owned = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const entries = fs.readFileSync(`/proc/${name}/environ`).toString().split('\0');
      const owners = entries.find(entry => entry.startsWith('SOLOMAP_TEST_RUN_OWNERS='))?.slice('SOLOMAP_TEST_RUN_OWNERS='.length).split(',') || [];
      if (owners.includes(testRunId)) owned.push(Number(name));
    } catch {
      // Processes can exit while /proc is being scanned.
    }
  }
  return owned;
}

function processGroupAlive() {
  if (process.platform === 'win32') return false;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function testProcessesAlive() {
  return processGroupAlive() || ownedProcessIds().length > 0;
}

function waitForTestProcesses(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (testProcessesAlive() && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return !testProcessesAlive();
}

function stopTestProcessTree(signal) {
  if (process.platform === 'win32') {
    childProcess.spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    if (!child.killed) child.kill(signal === 'SIGHUP' ? 'SIGTERM' : signal);
    return;
  }
  const forwardedSignal = signal === 'SIGHUP' ? 'SIGTERM' : signal;
  const owned = ownedProcessIds();
  try { process.kill(-child.pid, forwardedSignal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  for (const pid of owned) {
    try { process.kill(pid, forwardedSignal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => {
    requestedSignal = signal;
    stopTestProcessTree(signal);
  });
}

child.once('error', error => {
  console.error(error.message);
});

child.once('close', (code, signal) => {
  try {
    if (testProcessesAlive()) {
      stopTestProcessTree('SIGTERM');
      if (!waitForTestProcesses(1500)) {
        stopTestProcessTree('SIGKILL');
        if (!waitForTestProcesses(500)) throw new Error('test_process_tree_cleanup_failed');
      }
    }
    removeOwnedEntry(ownedRoot, ownedRoot);
  } catch (error) {
    console.error(`SoloMap test fixture cleanup failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (requestedSignal) {
    process.removeAllListeners(requestedSignal);
    process.kill(process.pid, requestedSignal);
    return;
  }
  process.exitCode = code ?? (signal ? 1 : 0);
});
