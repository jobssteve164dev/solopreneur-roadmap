const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { ForegroundAgentTerminalBridge, ReconnectedForegroundAgentTerminalBridge, buildForegroundRunnerInvocation, settleForegroundTerminalExit } = require('../out/foregroundAgentTerminal.js');

function fakeChild(pid = 4321) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    destroyed: false,
    writes: [],
    write(bytes, callback) {
      this.writes.push(Buffer.from(bytes));
      callback?.();
      return true;
    }
  };
  child.exitCode = null;
  child.signalCode = null;
  child.killedWith = [];
  child.kill = signal => { child.killedWith.push(signal); return true; };
  return child;
}

test('foreground runner invocation bypasses shell and carries one complete delivery identity', () => {
  const invocation = buildForegroundRunnerInvocation({
    extensionOutputRoot: '/extension/out', globalDataPath: '/data/.solomap-global',
    workspaceRoot: '/workspace/project', executionLogId: 17, deliveryId: 'delivery-17',
    traceId: '0123456789abcdef', interactionId: 'entry-01234567-89ab-cdef', acceptedAtMs: 1700000000000,
    terminalColumns: 132, terminalRows: 41,
    environment: { OPENCODE_CONFIG_DIR: '/isolated/opencode' }
  }, { ...process.env, ELECTRON_RUN_AS_NODE: undefined });
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args, [
    '/extension/out/runAgentProcess.js', '--global-data-path', '/data/.solomap-global',
    '--project-path', '/workspace/project', '--execution-log-id', '17'
  ]);
  assert.equal(invocation.options.cwd, '/workspace/project');
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.detached, true);
  assert.deepEqual(invocation.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(invocation.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(invocation.options.env.SOLOMAP_TERMINAL_DELIVERY_ID, 'delivery-17');
  assert.equal(invocation.options.env.SOLOMAP_DIAGNOSTIC_TRACE_ID, '0123456789abcdef');
  assert.equal(invocation.options.env.SOLOMAP_INTERACTION_ID, 'entry-01234567-89ab-cdef');
  assert.equal(invocation.options.env.SOLOMAP_DELIVERY_STARTED_AT, '1700000000000');
  assert.equal(invocation.options.env.SOLOMAP_TERMINAL_COLUMNS, '132');
  assert.equal(invocation.options.env.SOLOMAP_TERMINAL_ROWS, '41');
  assert.equal(invocation.options.env.OPENCODE_CONFIG_DIR, '/isolated/opencode');
});

test('runner starts once before a terminal surface opens and replays early output exactly once', async () => {
  const child = fakeChild();
  const spawns = [];
  const bridge = new ForegroundAgentTerminalBridge({ executable: process.execPath, args: ['runner.js'], options: { cwd: '/workspace', env: {}, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] } },
    (executable, args, options) => { spawns.push({ executable, args, options }); return child; });
  const first = bridge.start();
  const second = bridge.start();
  assert.equal(first, second);
  assert.equal(spawns.length, 1);
  child.stdout.emit('data', Buffer.from('before-open'));
  const output = [];
  const detach = bridge.attachOutput(bytes => output.push(bytes.toString('utf8')));
  child.stderr.emit('data', Buffer.from('after-open'));
  assert.deepEqual(output, ['before-open', 'after-open']);
  detach();
  child.stdout.emit('data', Buffer.from('detached'));
  const reattached = [];
  bridge.attachOutput(bytes => reattached.push(bytes.toString('utf8')));
  assert.deepEqual(reattached, ['detached']);
});

test('plugin input is serialized as one frame and never waits for a VS Code terminal processId', async () => {
  const child = fakeChild();
  const bridge = new ForegroundAgentTerminalBridge({ executable: process.execPath, args: ['runner.js'], options: { cwd: '/workspace', env: {}, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] } },
    () => child);
  bridge.start();
  const first = bridge.writeInputFrame(Buffer.from('first\r'));
  const second = bridge.writeInputFrame(Buffer.from('second\r'));
  await Promise.all([first, second]);
  assert.deepEqual(child.stdin.writes.map(value => value.toString('utf8')), ['first\r', 'second\r']);
});

test('host deactivation detaches without killing while explicit terminal disposal stops the owned runner', () => {
  const child = fakeChild();
  const bridge = new ForegroundAgentTerminalBridge({ executable: process.execPath, args: ['runner.js'], options: { cwd: '/workspace', env: {}, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] } },
    () => child);
  bridge.start();
  bridge.detachForHostReload();
  assert.deepEqual(child.killedWith, []);
  bridge.stop('SIGTERM');
  assert.deepEqual(child.killedWith, ['SIGTERM']);
});

test('a stale child cannot consume frames after its bridge generation exits', async () => {
  const child = fakeChild();
  const bridge = new ForegroundAgentTerminalBridge({ executable: process.execPath, args: ['runner.js'], options: { cwd: '/workspace', env: {}, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] } },
    () => child);
  bridge.start();
  child.exitCode = 0;
  child.emit('close', 0, null);
  await assert.rejects(bridge.writeInputFrame(Buffer.from('late\r')), /foreground_runner_not_running/);
  assert.deepEqual(child.stdin.writes, []);
});

test('completed Agent runners keep every conversation terminal available until the user closes it', () => {
  for (const inputMode of ['closed', 'prompt_turn', 'session_reentry']) {
    const writes = []; const closes = [];
    const result = settleForegroundTerminalExit(inputMode, 0, value => writes.push(value), value => closes.push(value));
    assert.equal(result, 'retained', `${inputMode} must retain the terminal`);
    assert.deepEqual(closes, [], `${inputMode} must not close the PTY`);
    assert.match(writes.join(''), /任务已结束/);
  }
});

test('a broken runner input is reported to the continuation caller', async () => {
  const child = fakeChild();
  child.stdin.write = (_bytes, callback) => { callback(new Error('broken pipe')); return false; };
  const bridge = new ForegroundAgentTerminalBridge({ executable: process.execPath, args: ['runner.js'], options: { cwd: '/workspace', env: {}, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] } },
    () => child);
  bridge.start();
  await assert.rejects(bridge.writeInputFrame(Buffer.from('continue\r')), /broken pipe/);
});

test('the shared conversation delivery starts the runner through the foreground bridge without a terminal processId gate', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8');
  const start = source.indexOf('async function launchAgentConversationTerminal');
  const end = source.indexOf('\nfunction getAgentProcessCleanupKey', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /buildForegroundRunnerInvocation/);
  assert.match(body, /ForegroundAgentTerminalBridge/);
  assert.match(body, /foregroundBridge\.start\(\)/);
  assert.match(body, /await awaitAgentTaskIngress/);
  assert.match(body, /agentInputMode/);
  assert.match(body, /session_reentry/);
  assert.match(body, /foreground_terminal_surface_unavailable/);
  assert.match(source, /let legacyConversationDeliveryHarnessForTests = false/);
  assert.doesNotMatch(body, /sendTextWhenTerminalReady/);
  assert.doesNotMatch(body, /terminal\.processId/);
});

test('a terminal is reusable only while this Extension Host owns its live foreground bridge', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8');
  const start = source.indexOf('async function findReusableAgentTerminal');
  const end = source.indexOf('\nfunction createAgentTerminal', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /foregroundAgentTerminalSurfaces\.get\(mappedTerminal\)\?\.bridge\?\.isRunning/);
  assert.match(body, /foregroundAgentTerminalSurfaces\.get\(candidate\)\?\.bridge\?\.isRunning/);
});

test('a retained foreground terminal stops forwarding input after its runner exits', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8');
  const start = source.indexOf('function createForegroundAgentTerminalSurface');
  const end = source.indexOf('\nfunction bridgeDetach', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /if \(!acceptingInput\) return/);
  assert.match(body, /writeInputFrame\(Buffer\.from\(data\)\)\.catch\(\(\) => undefined\)/);
  assert.match(body, /bridge\.onExit\(code => \{\s*acceptingInput = false/);
});

test('foreground continuation and legacy cleanup never wait indefinitely for a terminal processId', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8');
  const deliveryStart = source.indexOf('async function deliverAgentTerminalInput');
  const deliveryEnd = source.indexOf('\nconst reservedAgentTerminalsByProject', deliveryStart);
  const closeStart = source.indexOf('async function closeConversationProcessesForContinuation');
  const closeEnd = source.indexOf('\nasync function handleContinueNativeConversation', closeStart);
  assert.ok(deliveryStart >= 0 && deliveryEnd > deliveryStart && closeStart >= 0 && closeEnd > closeStart);
  assert.match(source.slice(deliveryStart, deliveryEnd), /surface\.writeInputFrame\(agentTerminalInputFrame/);
  assert.match(source.slice(closeStart, closeEnd), /readTerminalProcessIdBestEffort\(terminal\)/);
  assert.doesNotMatch(source.slice(closeStart, closeEnd), /await terminal\.processId/);
});

test('interactive runner starts the formal CLI before waiting for the full workspace baseline', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/runAgentProcess.ts'), 'utf8');
  const formal = source.indexOf('const formalExecution = execute(');
  const baseline = source.indexOf('if (interactive) await baselinePersistence');
  assert.ok(formal >= 0, 'formal interactive execution must be named explicitly');
  assert.ok(baseline > formal, 'the full workspace baseline must not remain ahead of formal task ingress');
  assert.ok(source.indexOf('const baselinePersistence = persistBaseline()') < formal,
    'baseline capture must begin after the rollback snapshot and overlap native CLI initialization');
  assert.match(source, /stdio:\s*\[terminal \? 'pipe' : 'ignore'/,
    'the runner must close stdin for every noninteractive Agent');
  assert.match(source, /process\.stdin\.on\('data', forwardProcessInput\)/,
    'terminal input must be forwarded while keeping the child stdin open across host EOF');
  assert.match(source, /process\.stdin\.pause\(\)/,
    'the runner must release its own input handle after the Agent exits');
});

test('the real direct bridge reaches an interactive child without a VS Code shell or processId within ten seconds', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-direct-bridge-'));
  const globalDataPath = path.join(base, '.solomap-global');
  const workspaceRoot = path.join(base, 'project');
  fs.mkdirSync(workspaceRoot);
  execFileSync('git', ['init', '-q', workspaceRoot]);
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
  const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');
  const { shellQuote } = require('../out/agentCli.js');
  const store = new UnifiedDataStore(globalDataPath);
  const operations = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath, runtimeId: 'direct-bridge-test', onCommand: () => ({ status: 'running' }), onData: operations });
  let bridge;
  t.after(async () => {
    if (bridge?.isRunning) {
      const exited = new Promise(resolve => bridge.onExit(resolve));
      bridge.stop('SIGINT');
      await exited;
    }
    await server.close();
    await operations.close();
    store.close();
    if (fs.existsSync(base)) {
      const recoverableRoot = path.join(os.tmpdir(), 'solomap-recoverable-trash');
      fs.mkdirSync(recoverableRoot, { recursive: true });
      fs.renameSync(base, path.join(recoverableRoot, `${path.basename(base)}-${Date.now()}`));
    }
  });
  await operations({ operation: 'prepare_run', input: {
    root: workspaceRoot, executionLogId: 1, nodeId: '__solo__', runKind: 'solo', prompt: 'direct bridge', userMessage: 'direct bridge',
    command: "printf 'provider-ready:'; stty size; while IFS= read -r line; do printf 'echo:%s\\n' \"$line\"; done",
    metadata: { interactiveSession: true }, idempotencyKey: 'direct-bridge-prepare'
  } });
  const invocation = buildForegroundRunnerInvocation({ extensionOutputRoot: path.resolve(__dirname, '../out'), globalDataPath, workspaceRoot,
    executionLogId: 1, deliveryId: '', traceId: '0123456789abcdef', interactionId: 'direct-bridge-interaction', acceptedAtMs: Date.now(), terminalColumns: 120, terminalRows: 30,
    environment: require('./analysis-fixture.js').anonymousToolEnv() });
  bridge = new ForegroundAgentTerminalBridge(invocation);
  const output = [];
  bridge.attachOutput(bytes => output.push(bytes));
  const startedAt = Date.now();
  bridge.start();
  while (!Buffer.concat(output).includes(Buffer.from('provider-ready'))) {
    assert.ok(Date.now() - startedAt <= 10_000, Buffer.concat(output).toString('utf8'));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(Date.now() - startedAt <= 10_000);
  assert.match(Buffer.concat(output).toString('utf8'), /provider-ready:30 120/);
  let state;
  while (!(state?.status?.terminalReconnect)) {
    assert.ok(Date.now() - startedAt <= 10_000, 'runner did not publish its reconnect endpoint');
    state = await operations({ operation: 'read_run_state', input: { root: workspaceRoot, executionLogId: 1 } });
    if (!state.status.terminalReconnect) await new Promise(resolve => setTimeout(resolve, 20));
  }
  const head = await operations({ operation: 'read_run_log_head', input: { root: workspaceRoot, executionLogId: 1, stream: 'output' } });
  const log = await operations({ operation: 'read_run_log', input: { root: workspaceRoot, executionLogId: 1, stream: 'output', offset: 0, limit: Math.max(1, head.totalBytes) } });
  const runnerPid = bridge.pid;
  bridge.detachForHostReload();
  const restored = new ReconnectedForegroundAgentTerminalBridge(state.status.terminalReconnect, Buffer.from(log.bytes, 'base64'), head.totalBytes);
  const restoredOutput = [];
  restored.attachOutput(bytes => restoredOutput.push(bytes));
  await restored.connect();
  await restored.writeInputFrame(Buffer.from('after-refresh\n'));
  while (!Buffer.concat(restoredOutput).includes(Buffer.from('echo:after-refresh'))) {
    assert.ok(Date.now() - startedAt <= 10_000, Buffer.concat(restoredOutput).toString('utf8'));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(restored.pid, runnerPid, 'refresh must reconnect to the same runner process');
  restored.detachForHostReload();
});
