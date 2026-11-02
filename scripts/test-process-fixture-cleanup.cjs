const childProcess = require('node:child_process');
const fs = require('node:fs');
const test = require('node:test');

function linuxProcessBirth(pid) {
  if (process.platform !== 'linux') return '';
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19] || '';
  } catch { return ''; }
}

function processBirth(pid) {
  const linuxBirth = linuxProcessBirth(pid);
  if (linuxBirth || process.platform === 'linux') return linuxBirth;
  if (process.platform === 'win32') return '';
  const result = childProcess.spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function processParents() {
  const parents = new Map();
  if (process.platform !== 'linux') return parents;
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = fs.readFileSync(`/proc/${name}/status`, 'utf8');
      const parent = Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1] || 0);
      parents.set(Number(name), parent);
    } catch {
      // A process can exit while /proc is being scanned.
    }
  }
  return parents;
}

function descendantProcesses() {
  const parents = processParents();
  const descendants = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of parents) {
      if (pid === process.pid || descendants.has(pid)) continue;
      if (parent !== process.pid && !descendants.has(parent)) continue;
      descendants.add(pid);
      changed = true;
    }
  }
  return [...descendants].map(pid => ({ pid, birth: linuxProcessBirth(pid) })).filter(owned => owned.birth || process.platform !== 'linux');
}

function signalDescendants(signal) {
  const processes = descendantProcesses().sort((left, right) => right.pid - left.pid);
  for (const owned of processes) {
    if (process.platform === 'linux' && linuxProcessBirth(owned.pid) !== owned.birth) continue;
    try { process.kill(owned.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

async function waitForDescendants(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (descendantProcesses().length === 0) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return descendantProcesses().length === 0;
}

function closeOwnedNetworkHandles() {
  const standardHandles = new Set([process.stdin, process.stdout, process.stderr]);
  const handles = process._getActiveHandles().filter(handle => !standardHandles.has(handle));
  for (const handle of handles) {
    if (handle?.constructor?.name === 'Socket' && typeof handle.destroy === 'function') handle.destroy();
  }
  for (const handle of handles) {
    if (handle?.constructor?.name === 'Server' && typeof handle.close === 'function') handle.close();
  }
}

if (process.env.NODE_TEST_CONTEXT) {
  const originalSpawn = childProcess.spawn;
  const trackedChildren = new Map();
  childProcess.spawn = function (...arguments_) {
    const optionsIndex = Array.isArray(arguments_[1]) ? 2 : 1;
    const originalOptions = arguments_[optionsIndex] || {};
    arguments_[optionsIndex] = {
      ...originalOptions,
      env: {
        ...(originalOptions.env || process.env),
        ...(process.env.SOLOMAP_TEST_RUN_OWNERS ? { SOLOMAP_TEST_RUN_OWNERS: process.env.SOLOMAP_TEST_RUN_OWNERS } : {})
      }
    };
    const child = originalSpawn.apply(childProcess, arguments_);
    if (child.pid) {
      const owned = { child, pid: child.pid, birth: processBirth(child.pid), detached: originalOptions.detached === true };
      trackedChildren.set(child.pid, owned);
      child.once('close', () => trackedChildren.delete(owned.pid));
    }
    return child;
  };
  const stopTrackedChildren = signal => {
    for (const owned of trackedChildren.values()) {
      if (owned.child.exitCode !== null || owned.child.signalCode !== null) continue;
      if (process.platform !== 'win32' && (!owned.birth || processBirth(owned.pid) !== owned.birth)) continue;
      try {
        if (process.platform === 'win32') childProcess.spawnSync('taskkill', ['/pid', String(owned.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else if (owned.detached) process.kill(-owned.pid, signal);
        else owned.child.kill(signal);
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const trackedChildrenAlive = () => [...trackedChildren.values()].some(owned => {
    if (owned.child.exitCode !== null || owned.child.signalCode !== null) return false;
    return process.platform === 'win32' || Boolean(owned.birth && processBirth(owned.pid) === owned.birth);
  });
  const waitForTrackedChildren = async timeoutMs => {
    const deadline = Date.now() + timeoutMs;
    while (trackedChildrenAlive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    return !trackedChildrenAlive();
  };
  const originalSetInterval = global.setInterval;
  const ownedIntervals = new Set();
  global.setInterval = (...arguments_) => {
    const interval = originalSetInterval(...arguments_);
    ownedIntervals.add(interval);
    return interval;
  };
  test.after(async () => {
    for (const interval of ownedIntervals) clearInterval(interval);
    ownedIntervals.clear();
    stopTrackedChildren('SIGTERM');
    if (!await waitForTrackedChildren(1500)) {
      stopTrackedChildren('SIGKILL');
      if (!await waitForTrackedChildren(500)) throw new Error('test_tracked_process_cleanup_failed');
    }
    if (process.platform === 'linux' && descendantProcesses().length > 0) {
      signalDescendants('SIGTERM');
      if (!await waitForDescendants(1500)) {
        signalDescendants('SIGKILL');
        if (!await waitForDescendants(500)) throw new Error('test_owned_process_cleanup_failed');
      }
    }
    closeOwnedNetworkHandles();
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => {
    stopTrackedChildren('SIGKILL');
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}
