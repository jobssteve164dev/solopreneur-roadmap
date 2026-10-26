const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');

function windowsModules(overrides = {}) {
  const probes = [];
  const marker = pid => `win32:6389540123456789${pid}`;
  const probe = (command, args) => {
    assert.equal(command, 'powershell.exe', 'Windows identity must use the existing process creation marker');
    const pid = Number(args.join(' ').match(/Get-Process -Id (\d+)/)?.[1]);
    assert.ok(pid > 0); probes.push(pid);
    return marker(pid).slice(6) + '\r\n';
  };
  const nativeChild = require('node:child_process');
  const child = {
    ...nativeChild,
    execFileSync: probe,
    execFile: (command, args, options, callback) => setImmediate(() => {
      try { callback(null, probe(command, args)); } catch (error) { callback(error, ''); }
    }),
    ...overrides.child
  };
  const absent = () => { throw Object.assign(new Error('Windows has no procfs'), { code: 'ENOENT' }); };
  const mockedFs = { ...fs, readFileSync: (file, ...args) => String(file).startsWith('/proc/') ? absent() : fs.readFileSync(file, ...args),
    promises: { ...fs.promises, readFile: async (file, ...args) => String(file).startsWith('/proc/') ? absent() : fs.promises.readFile(file, ...args) } };
  const windowsProcess = Object.assign(new EventEmitter(), { ...process, platform: 'win32', pid: 42, env: {}, stdout: new PassThrough(), stderr: new PassThrough(), ...overrides.process });
  const cache = new Map();
  function load(file) {
    const resolved = path.resolve(__dirname, '../out', file), nativeRequire = createRequire(resolved);
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const module = { exports: {} }; cache.set(resolved, module);
    const modules = { fs: mockedFs, child_process: child, ...overrides.modules };
    vm.runInNewContext(fs.readFileSync(resolved, 'utf8'), {
      module, exports: module.exports, process: windowsProcess, Buffer, console, setTimeout, clearTimeout, setImmediate, clearImmediate,
      __dirname: path.dirname(resolved), __filename: resolved,
      require: id => modules[id] || (/processIdentity(?:\.js)?$/.test(id) ? load('processIdentity.js') : nativeRequire(id))
    }, { filename: resolved });
    return module.exports;
  }
  return { load, process: windowsProcess, probes, marker };
}

test('Windows host preparation produces a nonempty creation marker without blocking the caller', async () => {
  const w = windowsModules();
  let completed = false;
  const owner = w.load('agentRunPreparation.js').getAgentRunDeliveryOwner().then(value => { completed = true; return value; });
  await Promise.resolve(); assert.equal(completed, false);
  const result = await owner;
  assert.equal(result.pid, 42); assert.equal(result.birth, w.marker(42));
  assert.deepEqual(w.probes, [42]);
});

test('the final shared runner registers Windows wrapper and gated child identities before launch', async () => {
  const registrations = [];
  let state = { projectId: 'project', runId: 'run', turnId: 'ab12cd34-1234-4123-8123-ab12cd34ef56', generation: 1, revision: 1, proof: 'fixture-proof',
    status: { baseGitHash: 'base', interactiveSession: true, status: 'Running' } };
  const child = Object.assign(new EventEmitter(), { pid: 43, exitCode: null, signalCode: null, stdio: [new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough()] });
  child.stdin = child.stdio[0]; child.stdout = child.stdio[1]; child.stderr = child.stdio[2];
  child.kill = () => { child.exitCode = 143; setImmediate(() => child.emit('close', 143, null)); return true; };
  const w = windowsModules({
    process: { argv: ['node', 'runner', '--global-data-path', '/fixture/global', '--project-path', '/fixture/project', '--execution-log-id', '1'] },
    child: { spawn: () => child },
    modules: {
      './agentCli': { ...require('../out/agentCli.js'), getAgentProvider: () => 'fixture' },
      './preSessionGit': {
        createPreSessionGitCommit: async () => 'a'.repeat(40),
        retainPreSessionGitCommit: async () => 'a'.repeat(40)
      },
      './autonomousRuntimeControl': { ...require('../out/autonomousRuntimeControl.js'), sendRuntimeDataRequest: async (_root, request) => {
        const { operation, input } = request;
        if (operation === 'read_run_execution_plan') return { ...state, command: 'fixture command', prompt: '完整输入' };
        if (operation === 'claim_run') { registrations.push({ pid: input.agentPid, birth: input.processBirth }); return state; }
        if (operation === 'patch_run_state') {
          if (!input.patch.agentChildPid) {
            state = { ...state, revision: state.revision + 1, status: { ...state.status, ...input.patch } };
            return state;
          }
          registrations.push({ pid: input.patch.agentChildPid, birth: input.patch.processChildBirth });
          state = { ...state, status: { ...state.status, finishedAt: 'fixture-boundary' } };
          throw new Error('fixture stops before releasing the launch gate');
        }
        if (operation === 'read_run_state' || operation === 'checkpoint_run') return state;
        if (operation === 'read_run_document') return { bytes: 'e30=' };
        if (operation === 'read_run_log_head') return { nextSequence: 0, totalBytes: 0 };
        assert.fail(`unexpected operation ${operation}`);
      } }
    }
  });
  w.load('runAgentProcess.js');
  for (let i = 0; i < 30 && w.process.exitCode !== 1; i++) await new Promise(setImmediate);
  assert.equal(w.process.exitCode, 1, 'the fixture must stop at its chosen pre-launch boundary');
  assert.match(String(w.process.stderr.read() || ''), /fixture stops before releasing the launch gate/);
  assert.deepEqual(registrations, [{ pid: 42, birth: w.marker(42) }, { pid: 43, birth: w.marker(43) }]);
  assert.deepEqual(w.probes, [42, 43]);
  assert.equal(child.stdio[3].writableEnded, false, 'no external Agent command is released');
});

for (const mode of ['native', 'reused', 'legacy-ps', 'unverified-resume']) test(`formal Windows stop ${mode === 'unverified-resume' ? 'rejects unverified resume before signaling any process' : mode === 'reused' ? 'preserves a reused wrapper PID' : mode === 'legacy-ps' ? 'preserves existing ps identities' : 'closes the recorded wrapper and child'}`, async () => {
  const strict = mode === 'unverified-resume', reused = mode === 'reused' || strict, legacy = mode === 'legacy-ps';
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-windows-stop-')), project = path.join(base, 'project'); fs.mkdirSync(project);
  const store = new UnifiedDataStore(path.join(base, 'global'));
  const live = new Set([42, 43]), signals = [];
  const ps = 'Fri Oct 09 08:00:00 2026';
  const w = windowsModules({ ...(legacy ? { child: { execFile: (command, args, options, callback) => {
    assert.equal(command, 'ps'); setImmediate(() => callback(null, ps));
  } } } : {}), process: { pid: 44, kill: (pid, signal) => {
    if (!live.has(pid)) throw Object.assign(new Error('process absent'), { code: 'ESRCH' });
    if (signal !== 0) { signals.push([pid, signal]); live.delete(pid); }
  } } });
  const birth = pid => legacy ? `ps:${ps}` : w.marker(pid);
  const service = new (w.load('runStop.js').RunStop)(store);
  try {
    const identity = await store.registerProject({ root: project });
    let run = store.prepareRun(identity.projectId, identity.locationId, { root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo',
      prompt: '完整输入', command: '正式命令', userMessage: '停止当前会话', metadata: { interactiveSession: true, finishedAt: 'already-settled', hostOutputPending: false, nativeOutputPending: false,
        agentPid: 42, processBirth: reused ? 'win32:an-older-process' : birth(42) }, idempotencyKey: 'windows-stop-run' });
    run = store.patchRunState(run.projectId, { executionLogId: 1, generation: run.generation, expectedRevision: run.revision,
      patch: { agentChildPid: 43, processChildBirth: birth(43) }, idempotencyKey: 'windows-child-registration' });
    assert.equal(run.status.agentChildPid, 43, 'the formal run must contain the child identity before stopping');
    const stopping = service.stop(run.projectId, { executionLogId: 1, generation: run.generation, expectedRevision: run.revision, expectedTurnId: run.turnId, reason: '用户停止', idempotencyKey: 'windows-stop', ...(strict ? { requireVerifiedIdentity: true } : {}) });
    if (strict) {
      await assert.rejects(stopping, /run_process_identity_unverified/);
      assert.deepEqual(signals, []);
      assert.deepEqual([...live], [42, 43]);
      assert.notEqual(store.readRunState(run.projectId, 1).status.interactiveSessionClosed, true);
      return;
    }
    const stopped = await stopping;
    assert.equal(stopped.status.interactiveSessionClosed, true);
    assert.deepEqual(signals, reused ? [[43, 'SIGTERM']] : [[43, 'SIGTERM'], [42, 'SIGTERM']]);
    assert.equal(stopped.status.stopRequested, true);
    assert.equal(stopped.status.deliveryPending, false);
  } finally { await service.close(); store.close(); }
});
