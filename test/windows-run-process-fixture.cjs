const assert = require('node:assert/strict');
const vm = require('node:vm');
const { Worker, isMainThread, workerData } = require('node:worker_threads');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');

function marker(second) {
  return 'ps:Fri Oct 09 08:00:' + String(Atomics.load(second, 0)).padStart(2, '0') + ' 2026';
}

function installWindowsProbe(target, pid, second) {
  const original = target.hasLiveRunProcess;
  const implementation = original.toString();
  const windowsProbe = vm.runInNewContext('(function' + implementation.slice(implementation.indexOf('(')) + ')', {
    process: { platform: 'win32', kill: () => {} },
    fs: { readFileSync: () => { throw new Error('no-proc'); } },
    childProcess: { execFileSync: command => { assert.equal(command, 'ps'); return marker(second).slice(3); } },
    processIdentity_js_1: { readWindowsProcessBirthMarker: () => 'win32:638954012345678901' }
  });
  target.hasLiveRunProcess = function (row) {
    const probe = Number(row.process_pid) === pid ? windowsProbe : original;
    return probe.call(this, row);
  };
}

if (!isMainThread) {
  const { filename, pid, second } = workerData.windowsRunProcess;
  installWindowsProbe(UnifiedDataStore.prototype, pid, second);
  require(filename);
}

exports.createWindowsRunProcess = function createWindowsRunProcess(pid) {
  const second = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  return {
    marker: () => marker(second),
    reusePid: () => Atomics.add(second, 0, 1),
    install: store => installWindowsProbe(store, pid, second),
    createWorker: (filename, options) => new Worker(__filename, {
      ...options, workerData: { ...options.workerData, windowsRunProcess: { filename, pid, second } }
    })
  };
};
