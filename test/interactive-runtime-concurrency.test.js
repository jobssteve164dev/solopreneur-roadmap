const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const test = require('node:test');
const { removeOwnedEntry } = require('../scripts/owned-fixture-cleanup.cjs');

const projectRoot = path.resolve(__dirname, '..');

function callableProxy() {
  const value = () => undefined;
  return new Proxy(value, { get: () => callableProxy(), apply: () => undefined, construct: () => ({}) });
}

test('Webview delivery coalesces background state while foreground receipts bypass it', async () => {
  const { postWebviewMessage } = require('../out/panelMessages.js');
  const calls = [];
  let releaseBackground;
  const blockedBackground = new Promise(resolve => { releaseBackground = resolve; });
  const target = {
    postMessage(message) {
      calls.push(structuredClone(message));
      return message.command === 'projectIssuesLoaded' && calls.filter(call => call.command === 'projectIssuesLoaded').length === 1
        ? blockedBackground
        : Promise.resolve(true);
    }
  };

  const first = postWebviewMessage(target, { command: 'projectIssuesLoaded', projectPath: '/project/a', revision: 1 });
  await new Promise(resolve => setImmediate(resolve));
  const second = postWebviewMessage(target, { command: 'projectIssuesLoaded', projectPath: '/project/a', revision: 2 });
  const third = postWebviewMessage(target, { command: 'projectIssuesLoaded', projectPath: '/project/a', revision: 3 });
  await postWebviewMessage(target, { command: 'conversationActionAccepted', launchActionId: 'launch-1' });

  assert.deepEqual(calls.map(call => [call.command, call.revision]), [
    ['projectIssuesLoaded', 1],
    ['conversationActionAccepted', null]
  ], 'an unresolved background delivery must neither accumulate stale updates nor hold a foreground receipt');
  assert.equal(calls[0].protocolVersion, 1);
  assert.equal(calls[0].lane, 'background');
  assert.equal(calls[0].supersedesKey, 'projectIssuesLoaded:/project/a');
  assert.equal(calls[1].lane, 'foreground');
  assert.ok(calls[1].messageId);

  releaseBackground(true);
  await Promise.all([first, second, third]);
  assert.equal(calls.at(-1).command, 'projectIssuesLoaded');
  assert.equal(calls.at(-1).revision, 3);
  assert.equal(calls.filter(call => call.command === 'projectIssuesLoaded').length, 2);
});

test('Webview background delivery has bounded keys while foreground receipts remain lossless', async () => {
  const { postWebviewMessage } = require('../out/panelMessages.js');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const calls = [];
  const target = { postMessage: message => {
    calls.push(message);
    return calls.length === 1 ? held : Promise.resolve(true);
  } };
  const deliveries = [postWebviewMessage(target, { command: 'projectIssuesLoaded', projectPath: '/held' })];
  await new Promise(resolve => setImmediate(resolve));
  for (let index = 0; index < 200; index += 1) {
    deliveries.push(postWebviewMessage(target, { command: 'projectIssuesLoaded', projectPath: `/project/${index}` }));
  }
  await postWebviewMessage(target, { command: 'conversationActionAccepted', launchActionId: 'foreground' });
  release(true);
  const results = await Promise.all(deliveries);
  assert.ok(results.filter(Boolean).length <= 129, 'one active plus at most 128 queued keys may be delivered');
  assert.equal(calls.find(message => message.command === 'conversationActionAccepted')?.lane, 'foreground');
});

test('Runtime operations use an exhaustive explicit execution-domain registry', () => {
  const {
    runtimeOperationDefinition,
    assertRuntimeOperationRegistryComplete
  } = require('../out/runtimeOperationRegistry.js');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtimeDataOperations.ts'), 'utf8');
  const implemented = [...source.matchAll(/case '([^']+)'/g)].map(match => match[1]);
  implemented.push('audit_documentation_manifest', 'backfill_run_indexes', 'checkpoint_current_run', 'execute_telegram_editor_command', 'get_conversation', 'prepare_conversation_launch', 'settle_conversation_launch', 'read_database_generation_reclaim_manifest', 'read_intelligence_execution_mode', 'refresh_documentation_manifest', 'refresh_project_growth', 'register_telegram_editor_endpoint', 'run_project_coverage_analysis',
    'set_intelligence_time_schedule', 'start_conversation');
  assert.doesNotThrow(() => assertRuntimeOperationRegistryComplete(implemented));
  assert.equal(runtimeOperationDefinition('start_conversation').domain, 'external-job');
  assert.equal(runtimeOperationDefinition('start_conversation').executor, 'external-worker');
  assert.equal(runtimeOperationDefinition('admit_intelligence_message').executor, 'external-worker');
  assert.equal(runtimeOperationDefinition('runtime_write_probe').kind, 'command');
  assert.equal(runtimeOperationDefinition('register_telegram_editor_endpoint').executor, 'supervisor');
  assert.equal(runtimeOperationDefinition('execute_telegram_editor_command').executor, 'supervisor');
  assert.equal(runtimeOperationDefinition('execute_telegram_editor_command').replay, 'never');
  assert.equal(runtimeOperationDefinition('read_database_generation_reclaim_manifest').executor, 'maintenance-worker');
  assert.equal(runtimeOperationDefinition('await_intelligence_message').replay, 'safe',
    'a durable operation id must be replayable across Runtime handoff');
  assert.equal(runtimeOperationDefinition('await_intelligence_message').handoff, undefined,
    'transport replay must not be coupled to response-socket backpressure during handoff');
  assert.equal(runtimeOperationDefinition('read_run_execution_plan').domain, 'foreground-query');
  assert.equal(runtimeOperationDefinition('read_run_state').domain, 'foreground-query');
  assert.equal(runtimeOperationDefinition('read_run_state').executor, 'foreground-reader');
  assert.equal(runtimeOperationDefinition('read_run_binding').executor, 'foreground-reader');
  assert.equal(runtimeOperationDefinition('read_project_registry').executor, 'supervisor',
    'versioned governance state must be served from the Writer-fed Supervisor projection');
  assert.equal(runtimeOperationDefinition('read').domain, 'foreground-query');
  assert.equal(runtimeOperationDefinition('read').executor, 'interactive-reader');
  assert.equal(runtimeOperationDefinition('read_database_overview').domain, 'background-query');
  assert.deepEqual(runtimeOperationDefinition('backfill_database_overview_projection'), {
    operation: 'backfill_database_overview_projection', domain: 'maintenance', kind: 'job',
    executor: 'writer-actor', replay: 'idempotency-key', authority: 'stateless'
  });
  assert.equal(runtimeOperationDefinition('append_diagnostic_event').domain, 'runtime-event');
  for (const operation of ['migration_overview', 'migration_status', 'read_recycling_plan']) {
    assert.equal(runtimeOperationDefinition(operation).executor, 'background-reader',
      `${operation} is a read model and must not occupy the Write Actor`);
    assert.equal(runtimeOperationDefinition(operation).kind, 'query');
  }
  assert.equal(runtimeOperationDefinition('read_today_roadmaps').domain, 'background-query');
  assert.equal(runtimeOperationDefinition('read_shadow_decision_inputs').domain, 'background-query');
  assert.equal(runtimeOperationDefinition('read_shadow_decision_inputs').executor, 'background-reader');
  assert.equal(runtimeOperationDefinition('read_registered_report_sources').executor, 'background-reader', 'report reads must never backfill on the Write Actor');
  assert.equal(runtimeOperationDefinition('read_project_registry').domain, 'control-query',
    'governance state must have a control-plane lane independent from conversation lifecycle reads');
  assert.equal(runtimeOperationDefinition('backup').domain, 'maintenance');
  assert.equal(runtimeOperationDefinition('backup').executor, 'writer-actor', 'maintenance may compute elsewhere, but every database mutation is committed by the single writer');
  assert.equal(runtimeOperationDefinition('project_signals').executor, 'background-reader');
  assert.equal(runtimeOperationDefinition('resolve_project_repository').executor, 'git-worker');
  assert.equal(runtimeOperationDefinition('capture_pre_session_git_snapshot').domain, 'foreground-command',
    'the launch rollback boundary must never queue behind background Git discovery');
  assert.equal(runtimeOperationDefinition('inspect_report_git_state').executor, 'git-worker');
  assert.equal(runtimeOperationDefinition('read_project_growth_git_facts').executor, 'git-worker');
  assert.equal(runtimeOperationDefinition('compare_git_file_version').executor, 'git-worker');
  assert.equal(runtimeOperationDefinition('refresh_project_signal').executor, 'network-worker');
  assert.equal(runtimeOperationDefinition('read_github_api').executor, 'network-worker');
  assert.equal(runtimeOperationDefinition('refresh_project_growth').executor, 'writer-actor');
  assert.equal(runtimeOperationDefinition('refresh_project_growth').domain, 'maintenance');
  assert.equal(runtimeOperationDefinition('run_project_coverage_analysis').domain, 'maintenance');
  assert.throws(() => runtimeOperationDefinition('build_project_growth_snapshot'), /runtime_operation_unregistered/);
  assert.throws(() => runtimeOperationDefinition('write_project_growth'), /runtime_operation_unregistered/);
  assert.throws(() => runtimeOperationDefinition('reserve_project_growth_refresh'), /runtime_operation_unregistered/);
  assert.throws(() => runtimeOperationDefinition('commit_project_growth_refresh'), /runtime_operation_unregistered/);
  assert.equal(runtimeOperationDefinition('wait_sidebar_core_projection_revision').domain, 'subscription-event');
  assert.equal(runtimeOperationDefinition('wait_sidebar_core_projection_revision').executor, 'supervisor',
    'long-lived subscriptions belong to the Supervisor event broker, never the database Writer');
  assert.equal(runtimeOperationDefinition('observe_run_task_ingress').domain, 'runtime-event',
    'Provider observation is an asynchronous lifecycle event, not part of the foreground launch command chain');
  assert.throws(() => runtimeOperationDefinition('ensure_sidebar_core_projections'), /runtime_operation_unregistered/);
  assert.throws(() => runtimeOperationDefinition('invalidate_sidebar_core_projections'), /runtime_operation_unregistered/);
  assert.equal(runtimeOperationDefinition('read_intelligence_execution_mode').executor, 'supervisor');
  assert.equal(runtimeOperationDefinition('read_intelligence_execution_mode').domain, 'control-query');
  assert.deepEqual(runtimeOperationDefinition('refresh_documentation_manifest'), {
    operation: 'refresh_documentation_manifest', domain: 'background-command', kind: 'command',
    executor: 'writer-actor', replay: 'idempotency-key', authority: 'stateless'
  });
  assert.deepEqual(runtimeOperationDefinition('project_cognitive_runtime_config'), {
    operation: 'project_cognitive_runtime_config', domain: 'foreground-command', kind: 'command',
    executor: 'writer-actor', replay: 'idempotency-key', authority: 'stateless'
  }, 'a transactional cognitive projection is a Writer command, never an interactive read');
  assert.throws(() => runtimeOperationDefinition('compact_database_storage'), /runtime_operation_unregistered/,
    'exclusive VACUUM must not be callable inside the interactive Runtime');
  assert.equal(runtimeOperationDefinition('search').replay, 'safe');
  assert.throws(() => runtimeOperationDefinition('read_whatever_someone_adds_later'), /runtime_operation_unregistered/);
});

test('Runtime Supervisor delegates autonomous decision cycles to a physically isolated worker', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src', 'autonomousRuntimeProcess.ts'), 'utf8');
  const longRunningRuntime = source.slice(source.indexOf("const runtimeId = argumentValue('--runtime-id')"));
  assert.match(source, /AutonomousCycleExecutor/);
  for (const forbidden of [
    'readCurrentRegisteredShadowDecision',
    'runCognitiveShadowDecisionCycle',
    'runShadowDecisionCycleFromDatabase',
    'EmbeddedPiAgentEngine'
  ]) {
    assert.doesNotMatch(longRunningRuntime, new RegExp(`\\b${forbidden}\\b`),
      `Runtime Supervisor must not execute ${forbidden} on its control-plane event loop`);
  }
  const workerSource = fs.readFileSync(path.join(projectRoot, 'src', 'autonomousCycleWorker.ts'), 'utf8');
  assert.doesNotMatch(workerSource, /updateRuntimeState/,
    'only the Supervisor may project the current paused/running control state');
});

test('Runtime Supervisor delegates Telegram ingress to its own physical channel worker', () => {
  const supervisor = fs.readFileSync(path.join(projectRoot, 'src', 'autonomousRuntimeProcess.ts'), 'utf8');
  const worker = fs.readFileSync(path.join(projectRoot, 'src', 'telegramRuntimeWorker.ts'), 'utf8');
  assert.match(supervisor, /new TelegramRuntimeWorkerHost/);
  assert.doesNotMatch(supervisor, /startTelegramBackgroundRuntime/);
  assert.match(supervisor, /'telegram-worker': telegram\?\.activity\(\)/);
  assert.match(worker, /startTelegramBackgroundRuntime/);
});

test('Write Actor keeps one physical thread while external awaits yield and lifecycle controls retain admission', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src', 'runtimeDataExecutionDomains.ts'), 'utf8');
  assert.match(source, /affinity === 'writer-actor' \? 8/);
  assert.match(source, /kind: 'control'/);
  assert.match(source, /this\.affinity === 'writer-actor'[\s\S]*?cancel_intelligence_operation'[\s\S]*?return this\.performControl/);
});

test('Agent launch completes filesystem identity preflight before opening the Writer transaction', () => {
  const operations = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtimeDataOperations.ts'), 'utf8');
  const launch = operations.slice(operations.indexOf("case 'prepare_agent_launch'"), operations.indexOf("case 'read_run_state'"));
  assert.ok(launch.indexOf('preflightAgentRunPreparation(launch)') < launch.indexOf('store.runAtomicCommand('));
  assert.match(launch, /store\.runAtomicCommand\(\(\) => prepareAgentRun\(launch, nested, preflight\)\)/);
});

test('Autonomous decision work cannot stall the Runtime Supervisor event loop', async () => {
  const { AutonomousCycleExecutor } = require('../out/autonomousCycleExecution.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-autonomy-worker-isolation-'));
  const workerEntryPath = path.join(root, 'blocking-worker.cjs');
  fs.writeFileSync(workerEntryPath, `
    const { parentPort } = require('node:worker_threads');
    parentPort.postMessage({ ready: true });
    parentPort.on('message', message => {
      if (message.type === 'run') {
        const until = Date.now() + 300;
        while (Date.now() < until) {}
        parentPort.postMessage({ id: message.id, completed: true });
      } else if (message.type === 'close') {
        parentPort.postMessage({ closed: true });
      }
    });
  `);
  const executor = new AutonomousCycleExecutor({
    globalDataPath: root,
    runtimeId: 'runtime-isolation',
    workerEntryPath
  });
  try {
    await executor.ready();
    const cycle = executor.run(false);
    const startedAt = Date.now();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(Date.now() - startedAt < 150,
      'a CPU-bound autonomy cycle must not occupy the Supervisor event loop');
    await cycle;
  } finally {
    await executor.close();
  }
});

test('Autonomous worker exit rejects accepted work instead of leaving a permanent pending cycle', async () => {
  const { AutonomousCycleExecutor } = require('../out/autonomousCycleExecution.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-autonomy-worker-exit-'));
  const workerEntryPath = path.join(root, 'exiting-worker.cjs');
  fs.writeFileSync(workerEntryPath, `
    const { parentPort } = require('node:worker_threads');
    parentPort.postMessage({ ready: true });
    parentPort.on('message', message => { if (message.type === 'run') process.exit(0); });
  `);
  const executor = new AutonomousCycleExecutor({
    globalDataPath: root,
    runtimeId: 'runtime-exit',
    workerEntryPath
  });
  await executor.ready();
  await assert.rejects(Promise.race([
    executor.run(false),
    new Promise((_, reject) => setTimeout(() => reject(new Error('worker_exit_left_cycle_pending')), 1_000))
  ]), /autonomous_cycle_worker_exited:0/);
  await executor.close();
});

test('Autonomous worker exit terminates the exact cognitive child before a replacement can start', async () => {
  const { AutonomousCycleExecutor } = require('../out/autonomousCycleExecution.js');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-autonomy-child-owner-'));
  const workerEntryPath = path.join(fixture, 'worker.js');
  const pidPath = path.join(fixture, 'child.pid');
  fs.writeFileSync(workerEntryPath, `
    const {parentPort}=require('node:worker_threads');
    const fs=require('node:fs');
    parentPort.on('message', message => {
      if (message.type !== 'run') return;
      parentPort.postMessage({cognitiveInvocationId:1,cognitiveInvocation:{
        command:process.execPath,args:['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000)`)}],
        stdin:'',shell:false,timeoutMs:300000
      }});
      const wait=()=>fs.existsSync(${JSON.stringify(pidPath)})?setImmediate(()=>process.exit(1)):setTimeout(wait,5);
      wait();
    });
    parentPort.postMessage({ready:true});
  `);
  const executor = new AutonomousCycleExecutor({ globalDataPath: fixture, runtimeId: 'child-owner', workerEntryPath });
  await assert.rejects(executor.run(false), /autonomous_cycle_worker_exited:1/);
  await executor.close();
  const pid = Number(fs.readFileSync(pidPath, 'utf8'));
  assert.throws(() => process.kill(pid, 0), error => error?.code === 'ESRCH',
    'worker-owned cognitive child must be gone before the executor closes');
});

test('Runtime data transport multiplexes within a lane and isolates interactive responses from background payloads', async () => {
  const net = require('node:net');
  const control = require('../out/autonomousRuntimeControl.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-multiplex-'));
  const originalCreateConnection = net.createConnection;
  let connections = 0;
  net.createConnection = function(...args) {
    connections += 1;
    return originalCreateConnection.apply(this, args);
  };
  const server = await control.startRuntimeControlServer({
    globalDataPath: root,
    runtimeId: 'multiplex-runtime',
    onCommand: () => ({ status: 'running' }),
    onData: async request => {
      if (request.input.delay) await new Promise(resolve => setTimeout(resolve, Number(request.input.delay)));
      return request.input.value;
    }
  });
  let serverClosed = false;
  try {
    const results = await Promise.all([
      control.sendRuntimeDataRequest(root, { operation: 'fixture_slow', input: { value: 'slow', delay: 20 } }),
      control.sendRuntimeDataRequest(root, { operation: 'fixture_fast', input: { value: 'fast' } })
    ]);
    assert.deepEqual(results, ['slow', 'fast']);
    assert.equal(connections, 1);
    const isolated = await Promise.all([
      control.sendRuntimeDataRequest(root, { operation: 'read_project_registry', input: { value: 'interactive' } }),
      control.sendRuntimeDataRequest(root, { operation: 'read_database_overview', input: { value: 'background' } })
    ]);
    assert.deepEqual(isolated, ['interactive', 'background']);
    assert.equal(connections, 2, 'interactive and background traffic must not share one TCP response stream');
  } finally {
    net.createConnection = originalCreateConnection;
    await server.close();
  }
});

test('Runtime data transport uses one connection per request until an endpoint advertises multiplexing', async t => {
  const net = require('node:net');
  const control = require('../out/autonomousRuntimeControl.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-legacy-protocol-'));
  const root = path.join(base, '.solomap-global');
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  let connections = 0;
  const sockets = new Set();
  const server = net.createServer(socket => {
    connections += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const frame = JSON.parse(buffer.slice(0, newline));
      setTimeout(() => socket.end(JSON.stringify({ ok: true, runtimeId: 'legacy-runtime', result: frame.request.input.value })),
        frame.request.input.value === 'first' ? 20 : 0);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  }));
  const address = server.address();
  fs.writeFileSync(path.join(root, 'runtime', 'control.json'), JSON.stringify({
    schemaVersion: 1, runtimeId: 'legacy-runtime', host: '127.0.0.1', port: address.port, token: 'fixture-token'
  }));

  assert.deepEqual(await Promise.all([
    control.sendRuntimeDataRequest(root, { operation: 'search', input: { value: 'first' } }),
    control.sendRuntimeDataRequest(root, { operation: 'search', input: { value: 'second' } })
  ]), ['first', 'second']);
  assert.equal(connections, 2, 'an unversioned endpoint must never receive concurrent frames on one legacy socket');
});

test('diagnostic telemetry is idempotent without manufacturing generic objects and search revisions', () => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-diagnostic-telemetry-'));
  const store = new UnifiedDataStore(root);
  try {
    const count = table => Number(store.db.exec(`SELECT count(*) FROM ${table}`)[0].values[0][0]);
    const before = { objects: count('objects'), contents: count('contents'), events: count('events') };
    const event = { kind: 'operation', occurredAt: '2026-11-01T00:00:00.000Z', scope: 'conversation.entry',
      payload: { status: 'start' }, idempotencyKey: 'diagnostic-telemetry-idempotency' };
    assert.deepEqual(store.appendDiagnosticEvent(event), event);
    assert.deepEqual(store.appendDiagnosticEvent(event), event);
    assert.equal(count('diagnostic_events'), 1);
    assert.deepEqual({ objects: count('objects'), contents: count('contents'), events: count('events') }, before);
  } finally { store.close(); }
});

test('Runtime scheduler reserves foreground progress and coalesces only queued background work', async () => {
  const { RuntimeExecutionScheduler } = require('../out/runtimePriorityScheduler.js');
  const scheduler = new RuntimeExecutionScheduler();
  let releaseBackground;
  const backgroundGate = new Promise(resolve => { releaseBackground = resolve; });
  const background = Array.from({ length: 8 }, (_, index) => scheduler.submit('background-query', async () => {
    await backgroundGate;
    return index;
  }));
  await new Promise(resolve => setImmediate(resolve));
  let obsoleteRan = false;
  const obsolete = scheduler.submit('background-query', async () => { obsoleteRan = true; }, { supersedesKey: 'sidebar:/project/a' });
  const latest = scheduler.submit('background-query', async () => 'latest', { supersedesKey: 'sidebar:/project/a' });
  const foreground = scheduler.submit('foreground-command', async () => 'accepted');
  assert.equal(await foreground, 'accepted', 'background saturation must never consume the foreground reservation');
  await assert.rejects(obsolete, /runtime_request_superseded/);
  assert.equal(obsoleteRan, false);
  releaseBackground();
  assert.deepEqual(await Promise.all(background), Array.from({ length: 8 }, (_, index) => index));
  assert.equal(await latest, 'latest');
});

test('Runtime scheduler applies explicit admission deadlines before work starts', async () => {
  const { RuntimeExecutionScheduler } = require('../out/runtimePriorityScheduler.js');
  const scheduler = new RuntimeExecutionScheduler();
  let ran = false;
  await assert.rejects(
    scheduler.submit('background-query', async () => { ran = true; }, { deadlineAt: Date.now() - 1 }),
    /runtime_request_deadline_exceeded/
  );
  assert.equal(ran, false);
});

test('Runtime data transport keeps a one-shot child alive until its response arrives', async () => {
  const { promisify } = require('node:util');
  const { execFile } = require('node:child_process');
  const control = require('../out/autonomousRuntimeControl.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-one-shot-'));
  const server = await control.startRuntimeControlServer({
    globalDataPath: root,
    runtimeId: 'one-shot-runtime',
    onCommand: () => ({ status: 'running' }),
    onData: async request => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return request.input.value;
    }
  });
  try {
    const script = `const control=require(${JSON.stringify(path.join(projectRoot, 'out', 'autonomousRuntimeControl.js'))}); control.sendRuntimeDataRequest(${JSON.stringify(root)}, {operation:'fixture_child',input:{value:'child-response'}}).then(value=>process.stdout.write(JSON.stringify(value)));`;
    const result = await promisify(execFile)(process.execPath, ['-e', script]);
    assert.equal(result.stdout, '"child-response"');
  } finally {
    await server.close();
  }
});

test('Runtime drain cancels event subscriptions without waiting for their long-poll timeout', async () => {
  const control = require('../out/autonomousRuntimeControl.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-event-drain-'));
  let releaseEvent;
  const event = new Promise(resolve => { releaseEvent = resolve; });
  let markAccepted;
  const accepted = new Promise(resolve => { markAccepted = resolve; });
  const server = await control.startRuntimeControlServer({
    globalDataPath: root,
    runtimeId: 'event-drain-runtime',
    enforceOperationRegistry: true,
    onCommand: () => ({ status: 'running' }),
    onData: async request => {
      if (request.operation !== 'wait_sidebar_core_projection_revision') return null;
      markAccepted();
      return event;
    }
  });
  const waiting = control.sendRuntimeDataRequest(root, {
    operation: 'wait_sidebar_core_projection_revision', input: { afterRevision: 0 }
  });
  try {
    await accepted;
    await Promise.race([
      server.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Runtime drain waited for an event subscription')), 300))
    ]);
    await assert.rejects(waiting, /runtime_data_response_incomplete|connect|closed|reset|Invalid Runtime endpoint/i);
  } finally {
    releaseEvent({ revision: 0, projectPaths: [] });
  }
});

test('Runtime drain waits for accepted authoritative ingress while subscriptions remain cancellable', async () => {
  const control = require('../out/autonomousRuntimeControl.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-ingress-drain-'));
  let releaseIngress;
  const ingress = new Promise(resolve => { releaseIngress = resolve; });
  let markAccepted;
  const accepted = new Promise(resolve => { markAccepted = resolve; });
  const server = await control.startRuntimeControlServer({
    globalDataPath: root,
    runtimeId: 'ingress-drain-runtime',
    enforceOperationRegistry: true,
    onCommand: () => ({ status: 'running' }),
    onData: async request => {
      if (request.operation !== 'observe_run_task_ingress') return null;
      markAccepted();
      return ingress;
    }
  });
  const request = control.sendRuntimeDataRequest(root, {
    operation: 'observe_run_task_ingress', input: { projectId: 'project-a', idempotencyKey: 'ingress-drain' }
  });
  await accepted;
  let closed = false;
  const closing = server.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(closed, false, 'authoritative ingress is accepted work and must drain before shutdown');
  releaseIngress({ accepted: true });
  assert.deepEqual(await request, { accepted: true });
  await closing;
});

test('Runtime busy recovery lease represents a continuous work interval without filesystem churn per request', async () => {
  const control = require('../out/autonomousRuntimeControl.js');
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-busy-interval-')), '.solomap-global');
  const busyPath = path.join(root, 'runtime', 'control.busy.json');
  let releaseFirst;
  const firstHeld = new Promise(resolve => { releaseFirst = resolve; });
  const server = await control.startRuntimeControlServer({
    globalDataPath: root,
    runtimeId: 'busy-interval-runtime',
    onCommand: () => ({ status: 'running' }),
    onData: async request => {
      if (request.input.value === 0) await firstHeld;
      return request.input.value;
    }
  });
  try {
    const first = control.sendRuntimeDataRequest(root, {
      operation: 'fixture_busy_interval', input: { value: 0 }
    });
    const leaseDeadline = Date.now() + 1_000;
    while (!fs.existsSync(busyPath) && Date.now() < leaseDeadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(fs.existsSync(busyPath), true, 'accepted work must publish its recovery lease');
    const leaseMtime = fs.statSync(busyPath).mtimeMs;
    releaseFirst();
    assert.equal(await first, 0);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(busyPath), true,
      'a sub-idle gap between foreground requests must remain one continuous recovery interval');
    for (let index = 1; index < 20; index += 1) {
      assert.equal(await control.sendRuntimeDataRequest(root, {
        operation: 'fixture_busy_interval', input: { value: index }
      }), index);
    }
    assert.equal(fs.statSync(busyPath).mtimeMs, leaseMtime,
      'continuous requests must not rewrite the same recovery lease');
    await server.close();
    serverClosed = true;
  } finally {
    releaseFirst();
    if (!serverClosed) await server.close().catch(() => undefined);
  }
});

test('Runtime data transport replays only reads and explicitly idempotent writes after an ambiguous disconnect', async t => {
  const net = require('node:net');
  const control = require('../out/autonomousRuntimeControl.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-replay-'));
  const root = path.join(base, '.solomap-global');
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  const attempts = new Map();
  const connections = new Set();
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const frame = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        const key = `${frame.request.operation}:${frame.request.input.idempotencyKey || ''}`;
        const attempt = (attempts.get(key) || 0) + 1;
        attempts.set(key, attempt);
        if (attempt === 1) { socket.end(); return; }
        socket.write(JSON.stringify({ requestId: frame.requestId, ok: true, runtimeId: 'replay-runtime', result: { attempt } }) + '\n');
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => {
    for (const socket of connections) socket.destroy();
    server.close(resolve);
  }));
  const address = server.address();
  fs.writeFileSync(path.join(root, 'runtime', 'control.json'), JSON.stringify({
    schemaVersion: 1, runtimeId: 'replay-runtime', host: '127.0.0.1', port: address.port, token: 'fixture-token'
  }));

  assert.deepEqual(await control.sendRuntimeDataRequest(root, { operation: 'search', input: { query: 'safe read' } }), { attempt: 2 });
  assert.deepEqual(await control.sendRuntimeDataRequest(root, { operation: 'write', input: { idempotencyKey: 'safe-write' } }), { attempt: 2 });
  await assert.rejects(
    control.sendRuntimeDataRequest(root, { operation: 'retry_migration', input: { jobId: 'unsafe-write' } }),
    /runtime_data_response_incomplete/
  );
  assert.equal(attempts.get('retry_migration:'), 1);
});

test('Runtime control shutdown drains accepted persistent work and then closes its socket', async () => {
  const control = require('../out/autonomousRuntimeControl.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-drain-'));
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let markAccepted;
  const accepted = new Promise(resolve => { markAccepted = resolve; });
  const server = await control.startRuntimeControlServer({
    globalDataPath: root,
    runtimeId: 'drain-runtime',
    onCommand: () => ({ status: 'running' }),
    onData: async request => { markAccepted(); await held; return request.input.value; }
  });
  const response = control.sendRuntimeDataRequest(root, { operation: 'fixture_drain', input: { value: 'completed' } });
  await accepted;
  const closing = server.close();
  await new Promise(resolve => setTimeout(resolve, 150));
  release();
  assert.equal(await response, 'completed');
  await Promise.race([
    closing,
    new Promise((_, reject) => setTimeout(() => reject(new Error('runtime_control_close_timeout')), 1_000))
  ]);
});

test('Runtime control handoff drains accepted non-replayable work before closing its execution domain', async t => {
  const control = require('../out/autonomousRuntimeControl.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-handoff-'));
  t.after(() => {
    const globalRoot = path.join(root, '.solomap-global'), runtimeRoot = path.join(globalRoot, 'runtime');
    if (fs.existsSync(path.join(runtimeRoot, 'control.json'))) fs.unlinkSync(path.join(runtimeRoot, 'control.json'));
    if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
    if (fs.existsSync(globalRoot)) fs.rmdirSync(globalRoot);
    if (fs.existsSync(root)) fs.rmdirSync(root);
  });
  let release, markAccepted, markCompleted;
  const held = new Promise(resolve => { release = resolve; });
  const accepted = new Promise(resolve => { markAccepted = resolve; });
  const completed = new Promise(resolve => { markCompleted = resolve; });
  const server = await control.startRuntimeControlServer({
    globalDataPath: root,
    runtimeId: 'handoff-runtime',
    onCommand: () => ({ status: 'running' }),
    onData: async () => { markAccepted(); await held; markCompleted(); return { completed: true }; }
  });
  const response = control.sendRuntimeDataRequest(root, {
    operation: 'fixture_handoff_close', input: { operationId: 'durable-operation' }
  }).then(value => ({ value }), error => ({ error }));
  await accepted;
  let closed = false;
  const closing = server.close('handoff').then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(closed, false, 'handoff must not terminate a non-replayable accepted side effect');
  release();
  await completed;
  assert.deepEqual(await response, { value: { completed: true } });
  await closing;
});

test('upgrade handoff preserves durable cognitive work for replacement recovery', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'autonomousRuntimeProcess.ts'), 'utf8');
  const stop = source.slice(source.indexOf("const stop = (exitCode"), source.indexOf('const fatalFailure'));
  assert.match(stop, /const handoff = reason === 'upgrade_drain'/);
  assert.match(stop, /if \(!handoff\) \{\s*signalCognitiveCliShutdown\(\);\s*cancelActiveCognitiveCliInvocations\(\);/s,
    'an upgrade must leave durable model work recoverable instead of marking it failed before Worker handoff');
  assert.match(stop, /if \(!handoff\) terminateRuntimeOwnedChildProcesses\(\);/,
    'upgrade handoff must not terminate child work before the durable execution domains close');
  assert.match(stop, /if \(handoff\) \{[\s\S]*if \(!dataExecutionDomains\) throw new Error\('runtime_intelligence_drain_unavailable'\);[\s\S]*await dataExecutionDomains\.control\('drain_intelligence'\);[\s\S]*intelligenceDrained = true;[\s\S]*\}/,
    'upgrade handoff must hard-gate detached Intelligence drain instead of absorbing its failure');
  assert.doesNotMatch(stop, /attempt\(\(\) => dataExecutionDomains\?\.control\('drain_intelligence'\)\)/,
    'a failed Intelligence drain must stop handoff before proof issuance or execution-domain close');
  assert.match(stop, /reason === 'upgrade_drain' && replacement && intelligenceDrained/,
    'compatibility proof must require a successful internal Intelligence drain');
  assert.match(stop, /if \(reason !== 'upgrade_drain'\) process\.exit/,
    'a failed upgrade drain must keep the old process alive instead of killing unfinished intelligence work');
  assert.ok(stop.indexOf("await dataExecutionDomains.control('drain_intelligence')") < stop.indexOf('const controlClosed = controlServer?.close'),
    'the reversible Intelligence drain phase must finish before Control Server closure begins');
  assert.match(stop, /await dataExecutionDomains\.control\('resume_intelligence'\)[\s\S]*stopping = false;[\s\S]*shutdownPromise = undefined;/,
    'a failed reversible drain must restore Intelligence and allow the active Runtime to serve and retry');
  assert.match(stop, /catch \(resumeError\) \{[\s\S]*shutdownPromise = undefined;[\s\S]*throw resumeError;[\s\S]*\}[\s\S]*stopping = false;/,
    'Runtime may advertise recovered service only after Intelligence resume succeeds');
  assert.match(source, /function scheduleDatabaseOverviewProjectionBackfill\(delayMs: number\)/);
  assert.match(source, /function scheduleReportVersionBackfill\(delayMs: number\)/);
  assert.match(source, /function schedulePlannerMaintenance\(delayMs: number\)/,
    'rollback dependencies must be initialized before the Control endpoint can receive an upgrade request');
});

test('Runtime control shutdown rejects late frames on an already accepted persistent socket', async t => {
  const net = require('node:net');
  const control = require('../out/autonomousRuntimeControl.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-late-frame-'));
  const root = path.join(base, '.solomap-global');
  let release, accepted;
  const held = new Promise(resolve => { release = resolve; });
  const acceptedPromise = new Promise(resolve => { accepted = resolve; });
  const calls = [];
  const server = await control.startRuntimeControlServer({
    globalDataPath: root,
    runtimeId: 'late-frame-runtime',
    onCommand: () => ({ status: 'running' }),
    onData: async request => {
      calls.push(request.input.value);
      if (calls.length === 1) { accepted(); await held; }
      return request.input.value;
    }
  });
  const endpoint = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'control.json'), 'utf8'));
  const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
  t.after(() => socket.destroy());
  await new Promise(resolve => socket.once('connect', resolve));
  const frame = (requestId, value) => JSON.stringify({ token: endpoint.token, command: 'data', expectedRuntimeId: endpoint.runtimeId, requestId, request: { operation: 'fixture', input: { value } } }) + '\n';
  socket.write(frame('accepted', 'accepted'));
  await acceptedPromise;
  const closing = server.close();
  socket.write(frame('late', 'late'));
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(calls, ['accepted']);
  } finally {
    release();
    await closing;
  }
});

test('a request rejected by a draining persistent connection reconnects to the replacement Runtime', async t => {
  const control = require('../out/autonomousRuntimeControl.js');
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-handover-')), '.solomap-global');
  const first = await control.startRuntimeControlServer({
    globalDataPath: root,
    runtimeId: 'handover-old-runtime',
    onCommand: () => ({ status: 'running' }),
    onData: request => ({ owner: 'old', value: request.input.value })
  });
  assert.deepEqual(await control.sendRuntimeDataRequest(root, {
    operation: 'fixture_handover', input: { value: 'warm' }
  }), { owner: 'old', value: 'warm' });

  const closing = first.close();
  const replacement = await control.startRuntimeControlServer({
    globalDataPath: root,
    runtimeId: 'handover-new-runtime',
    onCommand: () => ({ status: 'running' }),
    onData: request => ({ owner: 'new', value: request.input.value })
  });
  t.after(() => replacement.close());

  assert.deepEqual(await control.sendRuntimeDataRequest(root, {
    operation: 'fixture_handover', input: { value: 'after-handover' }
  }), { owner: 'new', value: 'after-handover' });
  await closing;
});

test('Runtime control drains accepted work even when its client disconnects before the result', async () => {
  const net = require('node:net');
  const control = require('../out/autonomousRuntimeControl.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-disconnect-drain-'));
  const root = path.join(base, '.solomap-global');
  let release;
  let accepted;
  const held = new Promise(resolve => { release = resolve; });
  const acceptedPromise = new Promise(resolve => { accepted = resolve; });
  const server = await control.startRuntimeControlServer({
    globalDataPath: root,
    runtimeId: 'disconnect-drain-runtime',
    onCommand: () => ({ status: 'running' }),
    onData: async () => { accepted(); await held; return 'done'; }
  });
  const endpoint = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'control.json'), 'utf8'));
  const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(JSON.stringify({ token: endpoint.token, command: 'data', expectedRuntimeId: endpoint.runtimeId, requestId: 'lost-client', request: { operation: 'fixture', input: {} } }) + '\n');
  await acceptedPromise;
  socket.destroy();
  const closing = server.close();
  let closed = false;
  void closing.then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(closed, false);
  release();
  await closing;
});

test('Runtime drain lets an accepted Network Worker refresh commit through the internal Writer channel', async t => {
  const control = require('../out/autonomousRuntimeControl.js');
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
  const { RuntimeExecutionScheduler } = require('../out/runtimePriorityScheduler.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-network-drain-'));
  const root = path.join(base, 'global');
  const projectRoot = path.join(base, 'project');
  const bin = path.join(base, 'bin');
  const started = path.join(base, 'gh-started');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const gh = path.join(bin, 'gh');
  fs.writeFileSync(gh, `#!/usr/bin/env node
const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(started)},'started');
setTimeout(()=>process.stdout.write('[]'),200);
`);
  fs.chmodSync(gh, 0o700);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath || ''}`;
  t.after(() => { process.env.PATH = originalPath; });
  const bootstrap = new UnifiedDataStore(root);
  const project = await bootstrap.registerProject({ root: projectRoot });
  const databaseId = bootstrap.databaseId;
  bootstrap.close();
  const delegateScheduler = new RuntimeExecutionScheduler();
  const schedulerAdmissions = [];
  const domains = await RuntimeDataExecutionDomains.start({ root, databaseId, scheduler: {
    submit(domain, action, options) {
      schedulerAdmissions.push({ domain, label: options?.label || '' });
      return delegateScheduler.submit(domain, action, options);
    }
  } });
  const server = await control.startRuntimeControlServer({
    globalDataPath: root,
    runtimeId: 'network-drain-runtime',
    enforceOperationRegistry: true,
    onCommand: () => ({ status: 'running' }),
    onData: request => domains.dispatch(request)
  });
  try {
    const refresh = control.sendRuntimeDataRequest(root, {
      operation: 'refresh_project_signal',
      input: { root: projectRoot, kind: 'issues', repo: 'owner/repository', force: true }
    });
    const deadline = Date.now() + 3_000;
    while (!fs.existsSync(started) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(started), true, 'the network fetch must be in flight before drain begins');
    const closing = server.close();
    const result = await refresh;
    await closing;
    assert.equal(result.repo, 'owner/repository');
    assert.equal(result.value.available, true);
    assert.ok(schedulerAdmissions.some(item => item.label === 'internal-worker:commit_external_refresh'),
      'Network and Intelligence worker callbacks must re-enter the one shared Runtime scheduler before Writer admission');
    const reader = UnifiedDataStore.openReadOnly(root, databaseId);
    try {
      const state = reader.readAnalysisState(project.projectId, 'external', 'issues');
      assert.equal(state.value.cache.repo, 'owner/repository');
    } finally { reader.close(); }
  } finally {
    await domains.close();
  }
});

test('Runtime readers open SQLite without acquiring write authority', () => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-read-domain-'));
  const writer = new UnifiedDataStore(root);
  const databaseId = writer.databaseId;
  writer.close();
  const reader = UnifiedDataStore.openReadOnly(root, databaseId);
  assert.equal(reader.databaseId, databaseId);
  assert.ok(reader.readDatabaseOverview().databaseBytes > 0);
  assert.throws(() => reader.appendDiagnosticEvent({
    kind: 'operation', occurredAt: new Date().toISOString(), scope: 'test', payload: {}, idempotencyKey: 'reader-write'
  }), /read-only|readonly|query_only/i);
  reader.close();
});

test('Capability registry query uses a read snapshot without acquiring a Writer transaction', async () => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-capability-reader-'));
  const bootstrapStore = new UnifiedDataStore(root);
  const databaseId = bootstrapStore.databaseId;
  bootstrapStore.close();
  const domains = await RuntimeDataExecutionDomains.start({ root, databaseId });
  try {
    const result = await domains.dispatch({ operation: 'read_capability_registry', input: { kind: 'skill' } });
    assert.equal(result.kind, 'skill');
    assert.ok(Array.isArray(result.entries));
  } finally {
    await domains.close();
  }
});

test('authenticated MCP queries use a signed read authority on the interactive reader while mutations stay on the Writer', async () => {
  const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
  const calls = [];
  const domains = Object.create(RuntimeDataExecutionDomains.prototype);
  domains.writer = { request: async request => { calls.push(['writer', request.operation]); return 'writer'; } };
  domains.interactive = { request: async request => { calls.push(['interactive', request.operation]); return 'interactive'; } };
  domains.background = { request: async request => { calls.push(['background', request.operation]); return 'background'; } };
  domains.git = { request: async request => { calls.push(['git', request.operation]); return 'git'; } };
  domains.network = { request: async request => { calls.push(['network', request.operation]); return 'network'; } };

  const authority = 'signed-reader-authority';
  assert.equal(await domains.dispatch({ operation: 'search', input: { scope: 'project' }, sessionToken: 'writer-session', readAuthority: authority }), 'interactive');
  assert.equal(await domains.dispatch({ operation: 'write', input: {}, sessionToken: 'writer-session', readAuthority: authority }), 'writer');
  assert.deepEqual(calls, [['interactive', 'search'], ['writer', 'write']]);
});

test('non-projected governance reads use the physical control reader instead of the conversation lifecycle reader pool', async () => {
  const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
  const calls = [];
  const domains = Object.create(RuntimeDataExecutionDomains.prototype);
  domains.controlReader = { request: async request => { calls.push(['control', request.operation]); return 'control'; } };
  domains.foreground = { request: async request => { calls.push(['foreground', request.operation]); return 'foreground'; } };
  domains.writer = { request: async request => { calls.push(['writer', request.operation]); return 'writer'; } };
  assert.equal(await domains.dispatch({ operation: 'read_host_settings', input: {} }), 'control');
  assert.equal(await domains.dispatch({ operation: 'read_run_state', input: { root: '/fixture', executionLogId: 1 } }), 'foreground');
  assert.deepEqual(calls, [['control', 'read_host_settings'], ['foreground', 'read_run_state']]);
});

test('foreground run preparation keeps child workspace Git work on the foreground Git executor', async () => {
  const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
  const calls = [];
  const domains = Object.create(RuntimeDataExecutionDomains.prototype);
  domains.foregroundGit = { request: async request => { calls.push(['foreground-git', request.operation]); return 'foreground-git'; } };
  domains.git = { request: async request => { calls.push(['background-git', request.operation]); return 'background-git'; } };
  domains.workspaceGit = { run: (_request, action) => action() };
  const request = { operation: 'compute_workspace_snapshot', input: { root: '/fixture' } };
  assert.equal(await domains.dispatchThroughWorker(request, false, { id: 1, domain: 'foreground-command' }), 'foreground-git');
  assert.equal(await domains.dispatchThroughWorker(request, false), 'background-git');
  assert.deepEqual(calls, [
    ['foreground-git', 'compute_workspace_snapshot'],
    ['background-git', 'compute_workspace_snapshot']
  ]);
});

test('a read-only operation worker verifies Writer-signed MCP authority without copying Writer session memory', async () => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-reader-authority-'));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-reader-authority-project-'));
  const secret = 'test-reader-authority-secret';
  const writerStore = new UnifiedDataStore(root);
  const project = await writerStore.registerProject({ root: projectRoot });
  const writerOperations = createRuntimeDataOperations(writerStore, undefined, secret);
  const session = await writerOperations({ operation: 'open_mcp_session', input: { projectId: project.projectId, openRequestId: 'reader-authority-open-request' } });
  const readerStore = UnifiedDataStore.openReadOnly(root, writerStore.databaseId);
  const readerOperations = createRuntimeDataOperations(readerStore, undefined, secret);
  try {
    const result = await readerOperations({
      operation: 'search', input: { scope: project.projectId, query: 'nothing' },
      sessionToken: session.sessionToken, readAuthority: session.readAuthority
    });
    assert.ok(result);
    await assert.rejects(readerOperations({
      operation: 'search', input: { scope: project.projectId, query: 'nothing' },
      sessionToken: session.sessionToken, readAuthority: `${session.readAuthority}tampered`
    }), /mcp_read_authority_invalid/);
  } finally {
    await readerOperations.close();
    await writerOperations.close();
    readerStore.close();
    writerStore.close();
  }
});

test('a signed read authority preserves field authorization and discovery filtering inside the Reader', async () => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-reader-projection-authority-'));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-reader-projection-project-'));
  const secret = 'test-reader-projection-authority-secret';
  const writerStore = new UnifiedDataStore(root);
  const writerOperations = createRuntimeDataOperations(writerStore, undefined, secret);
  const project = await writerOperations({ operation: 'register_project', input: { root: projectRoot } });
  const hiddenFromDiscovery = writerStore.write({
    kind: 'memory', action: 'create', scope: project.projectId, idempotencyKey: 'reader-private-discovery',
    data: { category: 'rules', title: 'Reader private discovery marker', content: 'reader-private-discovery-marker', status: 'captured', layer: 'candidate', external_source: 'private-review' }
  });
  const batch = await writerOperations({
    operation: 'prepare_learning_review',
    input: { runId: 'reader-authority-review', workspaceRoot: projectRoot, globalPrompt: '保留用户目标。', persistedGlobalPrompt: '保留用户目标。' }
  });
  let run = await writerOperations({
    operation: 'prepare_run',
    input: { root: projectRoot, executionLogId: 1, nodeId: '__solo__', runKind: 'learning_review', prompt: '完整提示词复盘。', command: 'formal-review', userMessage: '复盘经验', metadata: { learningReviewBatchId: batch.objectId }, idempotencyKey: 'reader-review-prepare-run' }
  });
  run = await writerOperations({
    operation: 'claim_run',
    input: { root: projectRoot, executionLogId: 1, expectedRevision: run.revision, agentPid: process.pid, processBirth: '', idempotencyKey: 'reader-review-claim-run' }
  });
  const session = await writerOperations({
    operation: 'open_mcp_session',
    input: { projectId: project.projectId, runIdentity: { executionLogId: 1, generation: run.generation, proof: run.proof }, openRequestId: 'reader-projection-authority-open' }
  });
  const readerStore = UnifiedDataStore.openReadOnly(root, writerStore.databaseId);
  const readerOperations = createRuntimeDataOperations(readerStore, undefined, secret);
  const request = (operation, input) => readerOperations({
    operation, input, sessionToken: session.sessionToken, readAuthority: session.readAuthority
  });
  try {
    await assert.rejects(
      request('read', { ref: batch.objectId, view: 'content', field: 'review_content', limit: 64 }),
      /review_input_requires_host/
    );
    const result = await request('search', { scope: project.projectId, kinds: ['memory'], query: 'reader private discovery marker' });
    assert.equal(result.items.some(item => item.objectId === hiddenFromDiscovery.objectId), false);
  } finally {
    await readerOperations.close();
    await writerOperations.close();
    readerStore.close();
    writerStore.close();
  }
});

test('Git worker serializes direct and Writer-child workspace evidence through one scheduled lane', async () => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-git-lane-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-git-lane-project-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-git-lane-bin-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-git-lane-state-'));
  const fakeGit = path.join(bin, 'git');
  fs.writeFileSync(fakeGit, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const root=process.env.SOLOMAP_GIT_LANE_STATE,lock=path.join(root,'active'),overlap=path.join(root,'overlap');
try { fs.mkdirSync(lock); } catch { fs.writeFileSync(overlap,'1'); }
setTimeout(() => {
  const args=process.argv.slice(2).join(' ');
  process.stdout.write(args.includes('remote get-url origin') ? 'https://github.com/example/project.git\\n' : '${'a'.repeat(40)}\\n');
  try { fs.rmdirSync(lock); } catch {}
}, 120);
`);
  fs.chmodSync(fakeGit, 0o700);
  const bootstrap = new UnifiedDataStore(root), databaseId = bootstrap.databaseId;
  bootstrap.close();
  const originalPath = process.env.PATH, originalState = process.env.SOLOMAP_GIT_LANE_STATE;
  process.env.PATH = `${bin}${path.delimiter}${originalPath || ''}`;
  process.env.SOLOMAP_GIT_LANE_STATE = state;
  const domains = await RuntimeDataExecutionDomains.start({ root, databaseId });
  process.env.PATH = originalPath;
  if (originalState === undefined) delete process.env.SOLOMAP_GIT_LANE_STATE; else process.env.SOLOMAP_GIT_LANE_STATE = originalState;
  try {
    const results = await Promise.all([
      domains.dispatch({ operation: 'resolve_project_repository', input: { root: project } }),
      domains.dispatch({ operation: 'compute_workspace_git_head', input: { root: project } })
    ]);
    assert.deepEqual(results, [{ repo: 'example/project' }, 'a'.repeat(40)]);
    assert.equal(fs.existsSync(path.join(state, 'overlap')), false);
    const workerSource = fs.readFileSync(path.join(projectRoot, 'src', 'runtimeDataDomainWorker.ts'), 'utf8');
    assert.doesNotMatch(workerSource, /gitComputePort|git_compute_port|MessageChannel/);
  } finally { await domains.close(); }
});

test('foreground rollback capture has a physical Git lane independent from blocked background repository discovery', async t => {
  const childProcess = require('node:child_process');
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-foreground-git-'));
  const root = path.join(base, 'global'), project = path.join(base, 'project'), backgroundProject = path.join(base, 'background');
  const bin = path.join(base, 'bin'), entered = path.join(base, 'background-entered');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(backgroundProject, { recursive: true }); fs.mkdirSync(bin, { recursive: true });
  for (const repository of [project, backgroundProject]) {
    childProcess.execFileSync('/usr/bin/git', ['init', '--quiet'], { cwd: repository });
    childProcess.execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository });
    childProcess.execFileSync('/usr/bin/git', ['config', 'user.name', 'SoloMap Test'], { cwd: repository });
    fs.writeFileSync(path.join(repository, 'README.md'), 'baseline\n');
    childProcess.execFileSync('/usr/bin/git', ['add', 'README.md'], { cwd: repository });
    childProcess.execFileSync('/usr/bin/git', ['commit', '--quiet', '-m', 'baseline'], { cwd: repository });
  }
  childProcess.execFileSync('/usr/bin/git', ['remote', 'add', 'origin', 'https://github.com/example/background.git'], { cwd: backgroundProject });
  fs.writeFileSync(path.join(project, 'README.md'), 'dirty rollback boundary\n');
  const fakeGit = path.join(bin, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh
case " $* " in
*" remote get-url origin "*)
  : > "$SOLOMAP_FOREGROUND_GIT_ENTERED"
  sleep 1.5
  ;;
esac
exec /usr/bin/git "$@"
`, { mode: 0o755 });
  const bootstrap = new UnifiedDataStore(root), databaseId = bootstrap.databaseId;
  bootstrap.close();
  const originalPath = process.env.PATH, originalEntered = process.env.SOLOMAP_FOREGROUND_GIT_ENTERED;
  process.env.PATH = `${bin}${path.delimiter}${originalPath || ''}`;
  process.env.SOLOMAP_FOREGROUND_GIT_ENTERED = entered;
  t.after(() => {
    process.env.PATH = originalPath;
    if (originalEntered === undefined) delete process.env.SOLOMAP_FOREGROUND_GIT_ENTERED;
    else process.env.SOLOMAP_FOREGROUND_GIT_ENTERED = originalEntered;
  });
  const domains = await RuntimeDataExecutionDomains.start({ root, databaseId });
  try {
    const background = domains.dispatch({ operation: 'resolve_project_repository', input: { root: backgroundProject } });
    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(entered) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(entered), true);
    const snapshot = await Promise.race([
      domains.dispatch({ operation: 'capture_pre_session_git_snapshot', input: { root: project } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('foreground Git snapshot queued behind background discovery')), 1_000))
    ]);
    assert.match(String(snapshot.revision || ''), /^[a-f0-9]{40}$/);
    assert.equal(childProcess.execFileSync('/usr/bin/git', ['show', `${snapshot.revision}:README.md`], { cwd: project, encoding: 'utf8' }), 'dirty rollback boundary\n');
    assert.deepEqual(await background, { repo: 'example/background' });
  } finally { await domains.close(); }
});

test('a slow Source read cannot queue Agent launch snapshot work behind the Source Git lane', async t => {
  const childProcess = require('node:child_process');
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-source-git-lane-'));
  const root = path.join(base, 'global'), sourceProject = path.join(base, 'source-project'), agentProject = path.join(base, 'agent-project');
  const bin = path.join(base, 'bin'), entered = path.join(base, 'source-entered');
  fs.mkdirSync(sourceProject, { recursive: true }); fs.mkdirSync(agentProject, { recursive: true }); fs.mkdirSync(bin, { recursive: true });
  for (const repository of [sourceProject, agentProject]) {
    childProcess.execFileSync('/usr/bin/git', ['init', '--quiet'], { cwd: repository });
    childProcess.execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository });
    childProcess.execFileSync('/usr/bin/git', ['config', 'user.name', 'SoloMap Test'], { cwd: repository });
    fs.writeFileSync(path.join(repository, 'README.md'), 'baseline\n');
    childProcess.execFileSync('/usr/bin/git', ['add', 'README.md'], { cwd: repository });
    childProcess.execFileSync('/usr/bin/git', ['commit', '--quiet', '-m', 'baseline'], { cwd: repository });
  }
  fs.writeFileSync(path.join(agentProject, 'README.md'), 'launch boundary\n');
  const fakeGit = path.join(bin, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh
case " $* " in
*" for-each-ref --count=201 "*)
  : > "$SOLOMAP_SOURCE_GIT_ENTERED"
  sleep 1.5
  ;;
esac
exec /usr/bin/git "$@"
`, { mode: 0o755 });
  const bootstrap = new UnifiedDataStore(root), databaseId = bootstrap.databaseId;
  bootstrap.close();
  const originalPath = process.env.PATH, originalEntered = process.env.SOLOMAP_SOURCE_GIT_ENTERED;
  process.env.PATH = `${bin}${path.delimiter}${originalPath || ''}`;
  process.env.SOLOMAP_SOURCE_GIT_ENTERED = entered;
  t.after(() => {
    process.env.PATH = originalPath;
    if (originalEntered === undefined) delete process.env.SOLOMAP_SOURCE_GIT_ENTERED;
    else process.env.SOLOMAP_SOURCE_GIT_ENTERED = originalEntered;
    removeOwnedEntry(base, base);
  });
  const domains = await RuntimeDataExecutionDomains.start({ root, databaseId });
  try {
    const sourceRead = domains.dispatch({ operation: 'read_project_source_snapshot', input: { root: sourceProject } });
    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(entered) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(entered), true);
    const snapshot = await Promise.race([
      domains.dispatch({ operation: 'capture_pre_session_git_snapshot', input: { root: agentProject } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Agent launch snapshot queued behind Source Git')), 1_000))
    ]);
    assert.match(String(snapshot.revision || ''), /^[a-f0-9]{40}$/);
    assert.equal(childProcess.execFileSync('/usr/bin/git', ['show', `${snapshot.revision}:README.md`], { cwd: agentProject, encoding: 'utf8' }), 'launch boundary\n');
    assert.equal((await sourceRead).available, true);
  } finally { await domains.close(); }
});

test('Source branch mutation and Agent launch snapshot serialize only for the same workspace', async t => {
  const childProcess = require('node:child_process');
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-source-agent-git-lock-'));
  const root = path.join(base, 'global'), project = path.join(base, 'project'), bin = path.join(base, 'bin');
  const entered = path.join(base, 'source-switch-entered');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(bin, { recursive: true });
  childProcess.execFileSync('/usr/bin/git', ['init', '--quiet', '-b', 'main'], { cwd: project });
  childProcess.execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.invalid'], { cwd: project });
  childProcess.execFileSync('/usr/bin/git', ['config', 'user.name', 'SoloMap Test'], { cwd: project });
  fs.writeFileSync(path.join(project, 'README.md'), 'main branch\n');
  childProcess.execFileSync('/usr/bin/git', ['add', 'README.md'], { cwd: project });
  childProcess.execFileSync('/usr/bin/git', ['commit', '--quiet', '-m', 'main'], { cwd: project });
  childProcess.execFileSync('/usr/bin/git', ['switch', '--quiet', '-c', 'feature/source-lock'], { cwd: project });
  fs.writeFileSync(path.join(project, 'README.md'), 'feature branch\n');
  childProcess.execFileSync('/usr/bin/git', ['add', 'README.md'], { cwd: project });
  childProcess.execFileSync('/usr/bin/git', ['commit', '--quiet', '-m', 'feature'], { cwd: project });
  childProcess.execFileSync('/usr/bin/git', ['switch', '--quiet', 'main'], { cwd: project });
  const fakeGit = path.join(bin, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh
case " $* " in
*" switch feature/source-lock "*)
  : > "$SOLOMAP_SOURCE_SWITCH_ENTERED"
  sleep 1.5
  ;;
esac
exec /usr/bin/git "$@"
`, { mode: 0o755 });
  const bootstrap = new UnifiedDataStore(root), databaseId = bootstrap.databaseId;
  bootstrap.close();
  const originalPath = process.env.PATH, originalEntered = process.env.SOLOMAP_SOURCE_SWITCH_ENTERED;
  process.env.PATH = `${bin}${path.delimiter}${originalPath || ''}`;
  process.env.SOLOMAP_SOURCE_SWITCH_ENTERED = entered;
  t.after(() => {
    process.env.PATH = originalPath;
    if (originalEntered === undefined) delete process.env.SOLOMAP_SOURCE_SWITCH_ENTERED;
    else process.env.SOLOMAP_SOURCE_SWITCH_ENTERED = originalEntered;
    removeOwnedEntry(base, base);
  });
  const domains = await RuntimeDataExecutionDomains.start({ root, databaseId });
  try {
    const sourceSwitch = domains.dispatch({ operation: 'switch_project_branch', input: { root: project, branch: 'feature/source-lock' } });
    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(entered) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(entered), true);
    const agentSnapshot = domains.dispatch({ operation: 'capture_pre_session_git_snapshot', input: { root: project } });
    assert.equal((await sourceSwitch).currentBranch, 'feature/source-lock');
    const snapshot = await agentSnapshot;
    assert.equal(childProcess.execFileSync('/usr/bin/git', ['show', `${snapshot.revision}:README.md`], { cwd: project, encoding: 'utf8' }), 'feature branch\n');
  } finally { await domains.close(); }
});

test('Writer is single-threaded but cooperatively yields while external jobs are pending', () => {
  const domainsSource = fs.readFileSync(path.join(projectRoot, 'src', 'runtimeDataExecutionDomains.ts'), 'utf8');
  const workerSource = fs.readFileSync(path.join(projectRoot, 'src', 'runtimeDataDomainWorker.ts'), 'utf8');
  assert.match(domainsSource, /affinity === 'writer-actor' \? 8/);
  assert.match(domainsSource, /this\.activeAuxiliaryRequests >= 6/,
    'six auxiliary awaits leave two Writer admission slots structurally reserved for user work');
  assert.match(domainsSource, /'control-query', 'foreground-command', 'foreground-query', 'interactive-query'/,
    'the Writer mailbox must select user work ahead of auxiliary queues');
  assert.match(workerSource, /operation: 'compute_workspace_snapshot'/);
});

test('a blocked Writer-child Git job yields the Writer to an unrelated commit', async t => {
  const childProcess = require('node:child_process');
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-writer-yield-'));
  const root = path.join(base, 'global'), project = path.join(base, 'project'), bin = path.join(base, 'bin');
  const entered = path.join(base, 'git-entered');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  childProcess.execFileSync('git', ['init'], { cwd: project });
  childProcess.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: project });
  childProcess.execFileSync('git', ['config', 'user.name', 'SoloMap Test'], { cwd: project });
  fs.writeFileSync(path.join(project, 'README.md'), 'writer yield\n');
  childProcess.execFileSync('git', ['add', '.'], { cwd: project });
  childProcess.execFileSync('git', ['commit', '-m', 'fixture'], { cwd: project });
  const realGit = childProcess.execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const fakeGit = path.join(bin, 'git');
  fs.writeFileSync(fakeGit, `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
fs.writeFileSync(process.env.SOLOMAP_WRITER_YIELD_ENTERED,'1');
const delayed=process.env.SOLOMAP_WRITER_YIELD_ENTERED+'.delayed',wait=fs.existsSync(delayed)?0:1500;try{fs.writeFileSync(delayed,'1',{flag:'wx'});}catch{}
setTimeout(()=>{const result=cp.spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{cwd:process.cwd(),encoding:'buffer'});process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??1);},wait);
`);
  fs.chmodSync(fakeGit, 0o700);
  const bootstrap = new UnifiedDataStore(root), databaseId = bootstrap.databaseId;
  bootstrap.close();
  const originalPath = process.env.PATH, originalEntered = process.env.SOLOMAP_WRITER_YIELD_ENTERED;
  process.env.PATH = `${bin}${path.delimiter}${originalPath || ''}`;
  process.env.SOLOMAP_WRITER_YIELD_ENTERED = entered;
  t.after(() => {
    process.env.PATH = originalPath;
    if (originalEntered === undefined) delete process.env.SOLOMAP_WRITER_YIELD_ENTERED;
    else process.env.SOLOMAP_WRITER_YIELD_ENTERED = originalEntered;
  });
  const domains = await RuntimeDataExecutionDomains.start({ root, databaseId });
  try {
    const registered = await domains.dispatch({ operation: 'register_project', input: { root: project } });
    let run = await domains.dispatch({ operation: 'prepare_run', input: {
      root: project, executionLogId: 1, nodeId: '__solo__', runKind: 'solo_conversation', prompt: 'test', command: 'test',
      userMessage: 'test', idempotencyKey: 'writer-yield-run'
    } });
    run = await domains.dispatch({ operation: 'claim_run', input: {
      root: project, executionLogId: 1, expectedRevision: run.revision, agentPid: process.pid, processBirth: '', idempotencyKey: 'writer-yield-claim'
    } });
    const session = await domains.dispatch({ operation: 'open_mcp_session', input: {
      projectId: registered.projectId, runIdentity: { executionLogId: 1, generation: run.generation, proof: run.proof }, openRequestId: 'writer-yield-session'
    } });
    const checkpoint = domains.dispatch({ operation: 'checkpoint_current_run', sessionToken: session.sessionToken, input: { action: 'start' } });
    void checkpoint.catch(() => undefined);
    const deadline = Date.now() + 3_000;
    while (!fs.existsSync(entered) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(entered), true);
    const probe = await Promise.race([
      domains.dispatch({ operation: 'runtime_write_probe', input: { probeId: 'fb373b8d-59db-48dd-a30e-c1b4b45c43bc' } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('writer_did_not_yield')), 500))
    ]);
    assert.equal(probe.probeId, 'fb373b8d-59db-48dd-a30e-c1b4b45c43bc');
    await checkpoint;
  } finally { await domains.close(); }
});

test('Recycling candidate hashing delegates file computation outside the Write Actor', async () => {
  const crypto = require('node:crypto');
  const { MigrationRecycling } = require('../out/migrationRecycling.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-recycling-compute-'));
  const file = path.join(root, 'candidate.bin');
  const bytes = Buffer.from('maintenance-worker-candidate');
  fs.writeFileSync(file, bytes);
  const expectedHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const calls = [];
  const recycling = new MigrationRecycling({
    root,
    migrationSourceKind: () => 'file',
    digestMaintenanceFile: async candidate => {
      calls.push(candidate);
      return { sha256: expectedHash, bytes: bytes.length };
    }
  });

  const size = await recycling.candidateSize(file, expectedHash, { identity: `memory:${root}`, key: 'candidate.bin' });

  assert.equal(size, bytes.length);
  assert.deepEqual(calls, [file]);
});

test('Maintenance compute restarts after an isolated worker exit instead of leaving future jobs pending', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtimeDataDomainWorker.ts'), 'utf8');
  assert.match(source, /function startMaintenanceComputeWorker\(\): Promise<void>/);
  assert.match(source, /maintenanceComputeWorker = undefined;[\s\S]*?maintenanceComputeRestartTimer = setTimeout/);
  assert.match(source, /await startMaintenanceComputeWorker\(\);[\s\S]*?maintenanceComputeWorker!\.postMessage/);
});

test('Runtime supervisor owns no SQLite connection and routes every mutation to one Write Actor', async () => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-domain-workers-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-domain-project-'));
  const bootstrapStore = new UnifiedDataStore(root);
  const databaseId = bootstrapStore.databaseId;
  bootstrapStore.close();
  const domains = await RuntimeDataExecutionDomains.start({
    root,
    databaseId
  });
  try {
    assert.equal(domains.topology().sourceGitCommand.threadId, 0, 'Source adds no worker to Runtime startup before the user requests it');
    await domains.dispatch({ operation: 'read_project_source_snapshot', input: { root: project } });
    const topology = domains.topology();
    assert.ok(topology.writerActor.threadId > 0);
    assert.equal(topology.writerActor.readOnly, false);
    assert.ok(topology.controlQuery.threadId > 0);
    assert.equal(topology.controlQuery.readOnly, true);
    assert.equal(topology.controlQuery.concurrency, 1);
    assert.ok(topology.foregroundQuery.threadIds.every(id => id > 0));
    assert.ok(topology.interactiveQuery.threadIds.every(id => id > 0));
    assert.ok(topology.backgroundQuery.threadIds.every(id => id > 0));
    assert.ok(topology.gitJob.threadId > 0);
    assert.ok(topology.foregroundGitCommand.threadId > 0);
    assert.ok(topology.sourceGitCommand.threadId > 0);
    assert.ok(topology.networkJob.threadId > 0);
    assert.ok(topology.intelligenceJob.threadId > 0);
    assert.equal(topology.gitJob.concurrency, 1);
    assert.equal(topology.foregroundGitCommand.concurrency, 1);
    assert.equal(topology.sourceGitCommand.concurrency, 1);
    assert.notEqual(topology.foregroundGitCommand.threadId, topology.gitJob.threadId);
    assert.notEqual(topology.sourceGitCommand.threadId, topology.foregroundGitCommand.threadId);
    assert.notEqual(topology.sourceGitCommand.threadId, topology.gitJob.threadId);
    assert.equal(topology.networkJob.concurrency, 2);
    assert.equal(topology.intelligenceJob.concurrency, 2);
    assert.notEqual(topology.intelligenceJob.threadId, topology.writerActor.threadId);
    assert.notEqual(topology.intelligenceJob.threadId, topology.networkJob.threadId);
    assert.notEqual(topology.controlQuery.threadId, topology.writerActor.threadId);
    assert.ok(!topology.foregroundQuery.threadIds.includes(topology.controlQuery.threadId));
    assert.equal(topology.maintenanceCommit.threadId, topology.writerActor.threadId);
    assert.equal(topology.maintenanceCommit.readOnly, false);
    assert.ok(topology.maintenanceJob.threadId > 0);
    assert.notEqual(topology.maintenanceJob.threadId, topology.writerActor.threadId);
    assert.equal(topology.maintenanceJob.readOnly, true);
    assert.ok(topology.foregroundQuery.threadIds.length >= 1 && topology.foregroundQuery.threadIds.length <= 2);
    assert.ok(topology.interactiveQuery.threadIds.length >= 1 && topology.interactiveQuery.threadIds.length <= 2);
    assert.equal(topology.backgroundQuery.threadIds.length, 1);
    assert.ok(topology.foregroundQuery.threadIds.length + topology.interactiveQuery.threadIds.length
      + topology.backgroundQuery.threadIds.length <= 5,
    'bounded read pools must not create more SQLite workers than the current CPU topology can use');
    assert.ok(!topology.foregroundQuery.threadIds.includes(topology.writerActor.threadId));
    assert.ok(topology.foregroundQuery.threadIds.every(id => !topology.interactiveQuery.threadIds.includes(id)));
    assert.notEqual(topology.gitJob.threadId, topology.networkJob.threadId);
    await domains.dispatch({ operation: 'register_project', input: { root: project } });
    const secondProject = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-domain-project-'));
    const backup = domains.dispatch({ operation: 'backup', input: {
      destination: path.join(root, 'snapshots', 'runtime-domain-backup.db'),
      idempotencyKey: 'runtime-domain-backup'
    } });
    const backupSettlement = backup.then(
      result => ({ status: 'fulfilled', result }),
      error => ({ status: 'rejected', error })
    );
    const foregroundWhileMaintaining = domains.dispatch({ operation: 'register_project', input: { root: secondProject } });
    const foregroundSettlement = foregroundWhileMaintaining.then(
      () => ({ status: 'accepted' }),
      error => ({ status: 'rejected', error })
    );
    assert.equal((await Promise.race([
      foregroundSettlement,
      new Promise(resolve => setTimeout(() => resolve({ status: 'blocked' }), 5_000))
    ])).status, 'accepted', 'maintenance file computation must not own the Write Actor event loop');
    const settledBackup = await backupSettlement;
    if (settledBackup.status === 'rejected') throw settledBackup.error;
    assert.ok(settledBackup.result.bytes > 0);
    const [overview, growth, analysis] = await Promise.all([
      domains.dispatch({ operation: 'read_database_overview', input: {} }),
      domains.dispatch({ operation: 'read_project_growth', input: { root: project } }),
      domains.dispatch({ operation: 'read_analysis_state', input: { root: project, namespace: 'test', key: 'empty' } })
    ]);
    assert.ok(overview.databaseBytes > 0);
    const serializedOverview = JSON.parse(await domains.dispatchSerialized({ operation: 'read_database_overview', input: {} }));
    assert.deepEqual(serializedOverview.contents, overview.contents,
      'the physical reader, not the supervisor event loop, encodes external RPC results');
    assert.equal(serializedOverview.freePageBytes, overview.freePageBytes);
    assert.equal(serializedOverview.lastMaintenance, overview.lastMaintenance);
    assert.ok(serializedOverview.databaseBytes > 0,
      'physical file bytes may grow between independent read snapshots but must remain observable');
    assert.deepEqual(growth, { latest: null, history: [] });
    assert.deepEqual(analysis, { objectId: null, revision: 0, value: null });
    assert.throws(() => domains.dispatch({ operation: 'read_project_registry', input: {} }), /runtime_supervisor_operation_unavailable/);
    assert.throws(() => domains.dispatch({ operation: 'read_intelligence_execution_mode', input: {} }), /runtime_supervisor_operation_unavailable/);
  } finally {
    await domains.close();
  }
});

test('Writer publishes every committed project-registry revision to the Supervisor before resolving the mutation', async () => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-control-projection-'));
  const bootstrapStore = new UnifiedDataStore(root);
  const databaseId = bootstrapStore.databaseId;
  bootstrapStore.close();
  const projected = [];
  const domains = await RuntimeDataExecutionDomains.start({
    root,
    databaseId,
    onProjectRegistryProjection: snapshot => projected.push(structuredClone(snapshot))
  });
  try {
    assert.equal(await domains.control('read_project_registry_projection'), null);
    const initial = await domains.dispatch({ operation: 'initialize_project_registry', input: {
      legacyProjects: [{ name: 'Alpha', path: '/project/alpha' }]
    } });
    assert.equal(projected.at(-1).revision, initial.revision);
    assert.deepEqual(projected.at(-1).registry, initial.registry);

    const patched = await domains.dispatch({ operation: 'patch_project_registry', input: {
      expectedRevision: initial.revision,
      projectPatches: [{ path: '/project/alpha', fields: { name: 'Updated Alpha' } }],
      idempotencyKey: 'control-projection-patch'
    } });
    assert.equal(projected.at(-1).revision, patched.revision);
    assert.equal(projected.at(-1).registry.projects[0].name, 'Updated Alpha');
    assert.deepEqual(await domains.control('read_project_registry_projection'), patched);
  } finally {
    await domains.close();
  }
});

test('a pending Sidebar subscription never occupies the Writer or blocks complete foreground launch preparation', async () => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-executor-health-'));
  const bootstrapStore = new UnifiedDataStore(root);
  const databaseId = bootstrapStore.databaseId;
  bootstrapStore.close();
  const domains = await RuntimeDataExecutionDomains.start({ root, databaseId });
  try {
    const waiting = domains.dispatch({
      operation: 'wait_sidebar_core_projection_revision',
      input: { afterRevision: 0 }
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    const writer = domains.activitySnapshot()['writer-actor'];
    assert.ok(writer.threadId > 0);
    assert.equal(writer.active.some(item => item.label === 'wait_sidebar_core_projection_revision'), false);
    assert.equal(writer.queued.some(item => item.label === 'wait_sidebar_core_projection_revision'), false);
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-executor-health-project-'));
    await Promise.race([
      domains.dispatch({ operation: 'prepare_agent_launch', input: {
        agentCli: 'claude', selectedModel: '', prompt: '完整用户目标', workspaceRoot: project,
        nodeId: '__solo__', executionLogId: 0, userMessage: '完整用户目标', runKind: 'solo',
        globalDataPath: root, taskPermissionMode: 'auto', launchIntentId: 'subscription-independent-launch'
      } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('foreground launch was blocked by the pending subscription')), 2_000))
    ]);
    await waiting;
    assert.equal(domains.activitySnapshot()['writer-actor'].active.length, 0);
  } finally {
    await domains.close();
  }
});

test('documentation authority returns before its one-quantum durable projection pump', async () => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-writer-priority-'));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-writer-priority-project-'));
  const bootstrap = new UnifiedDataStore(root);
  const databaseId = bootstrap.databaseId;
  bootstrap.close();
  const domains = await RuntimeDataExecutionDomains.start({ root, databaseId });
  try {
    const run = await domains.dispatch({ operation: 'prepare_run', input: {
      root: projectRoot, executionLogId: 1, nodeId: '__solo__', runKind: 'solo',
      prompt: '完成用户目标', command: '', userMessage: '完成用户目标',
      metadata: { interactiveSession: true, sessionProvider: 'codex', bindingNonce: 'a'.repeat(64) },
      idempotencyKey: 'writer-priority-run'
    } });
    const manifest = await domains.dispatch({ operation: 'sync_documentation_manifest', input: {
      root: projectRoot,
      manifest: {
        schemaVersion: 1,
        updatedAt: '2026-11-01T00:00:00.000Z',
        documents: Array.from({ length: 400 }, (_, index) => ({
          path: `docs/${String(index).padStart(4, '0')}.md`, role: 'project-document', status: 'active',
          solves: `用户文档 ${index}`, lastTouchedAt: '2026-11-01T00:00:00.000Z'
        })),
        pendingReview: []
      },
      idempotencyKey: 'writer-priority-manifest'
    } });
    const authoritative = await domains.dispatch({ operation: 'read_documentation_manifest', input: { root: projectRoot } });
    assert.equal(authoritative.documents.length, 400,
      'the authoritative manifest must be visible before its searchable document projection finishes');
    const audit = await domains.dispatch({ operation: 'audit_documentation_manifest', input: {
      root: projectRoot,
      options: { changedFilesSummary: 'M docs/doc-0.md', finishedAt: '2026-11-01T00:00:00.000Z' }
    } });
    assert.deepEqual(audit.touchedDocuments, ['docs/doc-0.md'],
      'post-run file inspection must execute through the isolated Maintenance Compute worker');
    const bindingStartedAt = Date.now();
    const binding = await domains.dispatch({ operation: 'write_run_binding', input: {
      projectId: run.projectId, executionLogId: 1, generation: run.generation,
      expectedHeadRevision: 0,
      seed: {
        runId: '1', provider: 'codex', workspaceRoot: projectRoot, cliPath: 'codex',
        bindingNonce: 'a'.repeat(64), method: 'provider_callback', contract: 'official_stable'
      },
      idempotencyKey: 'writer-priority-binding'
    } });
    assert.equal(binding.headRevision, 1);
    assert.ok(Date.now() - bindingStartedAt < 250, 'publishing authority must not retain the Writer for derived projection work');
    assert.equal(manifest.documents.length, 400);
    let quanta = 0;
    for (;;) {
      const result = await domains.control('drain_documentation_projections');
      quanta += 1;
      if (!result.pending) break;
      assert.ok(quanta < 1_000, 'the durable projection pump must make bounded progress');
    }
    assert.ok(quanta >= 800, 'each pump request may commit at most one binding or document quantum');
  } finally {
    await domains.close();
  }
});

test('Extension Host delegates documentation discovery instead of scanning project files synchronously', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  assert.match(source, /operation:\s*'refresh_documentation_manifest'/);
  assert.doesNotMatch(source, /refreshDocumentationManifest\(projectRoot,\s*current\)/);
});

test('Extension Host delegates post-run documentation audit instead of scanning project files synchronously', () => {
  const { runtimeOperationDefinition } = require('../out/runtimeOperationRegistry.js');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  assert.match(source, /operation:\s*'audit_documentation_manifest'/);
  assert.doesNotMatch(source, /buildDocumentationAudit\(workspaceRoot/);
  const definition = runtimeOperationDefinition('audit_documentation_manifest');
  assert.equal(definition.domain, 'background-query');
  assert.equal(definition.executor, 'maintenance-worker');
});

test('Sidebar projection resumes its durable revision backlog after its isolated worker exits', async () => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-projection-restart-'));
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-projection-first-'));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-projection-second-'));
  const bootstrap = new UnifiedDataStore(root); const databaseId = bootstrap.databaseId; bootstrap.close();
  const domains = await RuntimeDataExecutionDomains.start({ root, databaseId });
  try {
    await domains.dispatch({ operation: 'register_project', input: { root: firstRoot } });
    assert.equal((await domains.control('restart_sidebar_projection')).restarted, true);
    await domains.dispatch({ operation: 'register_project', input: { root: secondRoot } });
    const deadline = Date.now() + 10_000;
    for (;;) {
      const rows = await domains.dispatch({ operation: 'read_sidebar_core_projections', input: { projectPaths: [secondRoot] } });
      if (rows.length === 1 && rows[0].summary.path === secondRoot) break;
      assert.ok(Date.now() < deadline, 'restarted projection worker must drain the persisted source revision');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } finally { await domains.close(); }
});

test('Write Actor failure is fatal to the Runtime topology instead of leaving a live zombie control plane', async () => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-writer-fatal-'));
  const bootstrapStore = new UnifiedDataStore(root);
  const databaseId = bootstrapStore.databaseId;
  bootstrapStore.close();
  const domains = await RuntimeDataExecutionDomains.start({ root, databaseId });
  try {
    const fatal = domains.waitForFatalFailure();
    await domains.writer.worker.terminate();
    await assert.rejects(fatal, /runtime_data_domain_exited:writer-actor/);
    await assert.rejects(domains.dispatch({ operation: 'register_project', input: { root } }), /runtime_data_domain_exited:writer-actor/);
  } finally {
    await domains.close();
  }
});

test('formal load gate binds production evidence and real VSIX ingress to one isolated candidate Runtime', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'validate-runtime-load-gate.cjs'), 'utf8');
  assert.doesNotMatch(source, /worker_threads/);
  assert.match(source, /sendRuntimeDataRequest/);
  assert.doesNotMatch(source, /sourceVersion|versionParts|process\.argv\[2\] \|\|/);
  assert.match(source, /argumentValue\('--data-root'\)/);
  assert.match(source, /argumentValue\('--release-version'\)/);
  assert.match(source, /argumentValue\('--candidate-vsix'\)/);
  assert.match(source, /candidateRuntimeBuildId\(candidateVsix\)/);
  assert.doesNotMatch(source, /runtimeBuildId\(extensionPath\)/,
    'the installed candidate must be verified from packaged bytes, not from extra worktree output');
  assert.doesNotMatch(source, /--allow-production-writes|SOLOMAP_ALLOW_LIVE_RUNTIME_UPGRADE|refresh_project_signal|runtime_write_probe/);
  assert.match(source, /new DatabaseSync\(sourceDatabasePath, \{ readOnly: true \}\)/);
  const productionProbe = source.slice(source.indexOf('(async () => {'), source.indexOf('VACUUM INTO'));
  assert.doesNotMatch(productionProbe, /sendRuntimeDataRequest\(sourceDataRoot/,
    'formal production evidence must not mutate even the live Runtime control lease');
  assert.match(productionProbe, /readSourceProjectRegistry/,
    'formal production identity must be read directly through the read-only SQLite snapshot source');
  assert.doesNotMatch(productionProbe, /operation: '(?:register_project|patch_project_registry|refresh_project_signal)'/,
    'formal production evidence must not mutate the live Runtime');
  assert.match(source, /VACUUM INTO/);
  assert.match(source, /POSIX_FADV_DONTNEED/);
  assert.match(source, /releaseSnapshotPageCache\(sourceDatabasePath, false\)/,
    'snapshot preparation must release source-read cache as well as candidate snapshot cache');
  assert.match(source, /formal_candidate_oom_killed/);
  assert.match(source, /formalMemoryLimitBytes = 16 \* 1024 \*\* 3/);
  assert.match(source, /formal_memory_current_unavailable/);
  assert.match(source, /formal_oom_counter_unavailable/);
  assert.ok(source.indexOf('assert.equal(oomKillsAfter, oomKillsBefore') < source.indexOf('passed: true'),
    'a successful receipt is impossible unless the candidate caused zero new cgroup OOM kills');
  assert.match(source, /memory\.stat/);
  assert.match(source, /inactive_file/);
  assert.match(source, /effectiveHeadroom/,
    'the formal gate must count cgroup-declared reclaimable cold file cache without lowering its fixed headroom');
  assert.match(source, /effectiveHeadroom >= 8 \* 1024 \*\* 3/);
  assert.match(source, /terminateExactSnapshotRuntime/);
  assert.match(source, /snapshotRuntimeIdentityMatches/,
    'failure cleanup may signal only the exact Runtime process that owns the isolated snapshot');
  assert.ok(source.indexOf('VACUUM INTO') < source.indexOf('const loadStarted ='),
    'the immutable production snapshot and its cache release must finish before measured load starts');
  assert.match(source, /test\/browser\/real-codex-launch-gate\.cjs/);
  assert.match(source, /SOLOMAP_REAL_CODEX_DATA_ROOT: dataRoot/);
  assert.match(source, /SOLOMAP_LOAD_GATE_RECEIPT: launchReceiptPath/);
  assert.match(source, /SOLOMAP_LOAD_GATE_READY: readyReceiptPath/);
  assert.match(source, /SOLOMAP_LOAD_GATE_START: loadStartPath/);
  assert.match(source, /formal_real_agent_process_launch_deadline_exceeded/,
    'the gate must measure the real Agent process, not only the Webview action receipt');
  assert.match(source, /formal_real_agent_first_output_deadline_exceeded/);
  assert.doesNotMatch(source, /ensureHealthyAutonomousRuntime/);
  assert.ok(source.indexOf('formal_candidate_host_not_ready') < source.indexOf('const loadStarted ='), 'the installed VSIX Host must own the Runtime before measured load starts');
  assert.match(source, /formal_runtime_not_owned_by_candidate_vsix/);
  assert.match(source, /formal_production_project_missing/);
  assert.match(source, /formal_unexpected_project_registered/);
  assert.doesNotMatch(source, /formal_interactive_registry_changed/,
    'opening the gate workspace may add that one user project without invalidating the 57-project production baseline');
  assert.match(source, /operation: 'read_project_registry'/);
  assert.match(source, /operation: 'read_project_investment_runs'/);
  assert.match(source, /operation: 'read_github_api'/);
  assert.doesNotMatch(source, /operation: 'read_github_facts'/);
  assert.match(source, /observeConcurrentWork/,
    'every concurrent load promise must be observed immediately so its exact failure reaches gate cleanup');
  assert.match(source, /Promise\.all/);
  assert.match(source, /removeGeneratedTree\(activeGateRoot\)/,
    'the formal gate must release its exact owned fixture tree after success or failure');
  const browserGate = fs.readFileSync(path.join(__dirname, 'browser', 'real-codex-launch-gate.cjs'), 'utf8');
  assert.match(browserGate, /\[data-project-conversation-input\]/);
  assert.match(browserGate, /\[data-project-continue-send\]/);
  assert.match(browserGate, /Real Codex Gate: Open SoloMap/);
  assert.match(browserGate, /terminal\.delivery\.agent\.launch/);
  assert.match(browserGate, /terminal\.delivery\.agent\.first-output/);
  assert.match(browserGate, /the authoritative Agent launch timing was not persisted/,
    'the gate must wait for asynchronous diagnostic persistence while enforcing original event elapsed times');
  assert.doesNotMatch(browserGate, /internalStartConversation/,
    'the formal ingress gate must start from the packaged Webview instead of an internal Host command');
});

test('Runtime run-index transport is page-bounded and host consumers never rebuild portfolio aggregates', () => {
  const operationsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtimeDataOperations.ts'), 'utf8');
  const growthSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'projectGrowth.ts'), 'utf8');
  const maintenanceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'maintenanceComputeWorker.ts'), 'utf8');
  const runtimeRefreshSource = growthSource.slice(growthSource.indexOf('async function refreshProjectGrowthInRuntime('), growthSource.indexOf('async function readProjectGrowthPages('));
  const syncSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'syncEngine.ts'), 'utf8');
  const analyticsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'projectAnalytics.ts'), 'utf8');
  const impactSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'agentImpact.ts'), 'utf8');
  assert.match(operationsSource, /PROJECT_RUN_INDEX_PAGE_SIZE = 200/);
  assert.match(operationsSource, /Math\.min\(PROJECT_RUN_INDEX_PAGE_SIZE/);
  assert.match(maintenanceSource, /GROWTH_STAGE_PAGE_SIZE = 200/);
  assert.match(maintenanceSource, /beforeExecutionLogId/);
  assert.doesNotMatch(runtimeRefreshSource, /readProjectRunEntries|roadmapNodes|runEntries|commit_project_growth_refresh/);
  assert.match(syncSource, /beforeExecutionLogId/);
  assert.match(analyticsSource, /beforeExecutionLogId/);
  assert.match(impactSource, /operation: 'read_agent_impact_summary'/);
  assert.doesNotMatch(impactSource, /beforeExecutionLogId|read_project_impact_runs/,
    'Agent impact is one Runtime-owned aggregate instead of a 57-project Host paging loop');
  assert.match(maintenanceSource, /page\.length < GROWTH_STAGE_PAGE_SIZE/);
});

test('autonomous Runtime does not poll retired legacy run directories after startup migration', () => {
  const processSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'autonomousRuntimeProcess.ts'), 'utf8');
  const domainsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtimeDataExecutionDomains.ts'), 'utf8');
  const workerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtimeDataDomainWorker.ts'), 'utf8');
  assert.doesNotMatch(processSource, /historicalOwnerStamp|refresh_historical_migrations|historical_owner_stamp/);
  assert.doesNotMatch(domainsSource, /refresh_historical_migrations|historical_owner_stamp/);
  assert.doesNotMatch(workerSource, /refreshHistoricalRunMigrations|historicalRunOwnerStateStamp/);
});

test('post-ready startup migration never occupies a user foreground lane', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'autonomousRuntimeProcess.ts'), 'utf8');
  const start = source.indexOf('const startupMigrationReady');
  const end = source.indexOf('void startupMigrationReady.catch');
  const migration = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(migration, /const registry = controlProjection\.readProjectRegistry\(\{\}\)/,
    'startup migration discovery must consume the same committed Supervisor projection as external control reads');
  assert.doesNotMatch(migration, /dataOperations\(\{ operation: 'read_project_registry'/,
    'the retired physical Reader route must have no internal Runtime consumer');
  assert.match(migration, /startupMaintenanceQuantum\(\s*\(\) => dataOperations\(request\)/);
  assert.doesNotMatch(migration, /scheduledOperations\(\{ operation: 'read_project_registry'/);
  assert.doesNotMatch(migration, /await scheduledOperations\(request\)/);
});

test('Sidebar core is an event-driven database projection, not a view-time project scan', async () => {
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { RuntimeDataExecutionDomains } = require('../out/runtimeDataExecutionDomains.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-sidebar-projection-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-sidebar-projection-project-'));
  fs.mkdirSync(path.join(project, '.solopreneur'));
  fs.writeFileSync(path.join(project, 'README.md'), '# Projection fixture\n');
  fs.writeFileSync(path.join(project, '.solopreneur', 'roadmap.csv'), 'id,title,description,stage,dependencies,agentCli,agentPrompt,status,createdAt,completedAt\n1,Ship projection,,Build,,,,Pending,,\n');
  const bootstrapStore = new UnifiedDataStore(root);
  const databaseId = bootstrapStore.databaseId;
  bootstrapStore.close();
  const domains = await RuntimeDataExecutionDomains.start({ root, databaseId });
  try {
    await domains.dispatch({ operation: 'accept_roadmap_csv', input: { root: project } });
    const projectionDeadline = Date.now() + 2_000;
    let projected = [];
    while (Date.now() < projectionDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      projected = await domains.dispatch({ operation: 'read_sidebar_core_projections', input: {} });
      if (projected[0]?.summary?.recommendedNodeTitle === 'Ship projection'
        && projected[0].sourceRevision === projected[0].projectionRevision) break;
    }
    assert.equal(projected.length, 1);
    assert.equal(projected[0].summary.path, project);
    assert.equal(projected[0].summary.totalNodes, 1);
    assert.equal(projected[0].summary.recommendedNodeTitle, 'Ship projection');
    assert.equal(projected[0].summary.foundation.missingCount, 4, 'filesystem-derived foundation data is computed in the projection worker, not the Extension Host');
    assert.equal(projected[0].summary.investment.schemaVersion, 1);
    assert.equal(projected[0].sourceRevision, projected[0].projectionRevision);
    const restartedSubscriber = await Promise.race([
      domains.dispatch({ operation: 'wait_sidebar_core_projection_revision', input: { afterRevision: 999 } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('subscriber revision from a prior Runtime was not invalidated')), 200))
    ]);
    assert.equal(restartedSubscriber.revision < 999, true);
    assert.deepEqual(restartedSubscriber.projectPaths, []);

    fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Agent instructions\n');
    const deadline = Date.now() + 2_000;
    let refreshed = projected;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      refreshed = await domains.dispatch({ operation: 'read_sidebar_core_projections', input: {} });
      if (refreshed[0]?.summary?.foundation?.missingCount === 3) break;
    }
    assert.equal(refreshed[0].summary.foundation.missingCount, 3,
      'the Runtime-owned filesystem observer must refresh foundation state without opening the Sidebar or asking the Host to scan projects');

    const offline = `${project}-offline`;
    fs.renameSync(project, offline);
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.mkdirSync(path.join(project, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(project, 'README.md'), '# Back online\n');
    fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Rules\n');
    fs.writeFileSync(path.join(project, 'PROJECT_MEMORY.md'), '# Memory\n');
    fs.writeFileSync(path.join(project, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
    fs.writeFileSync(path.join(project, '.github', 'workflows', 'security.yml'), 'name: Security\n');
    const remountDeadline = Date.now() + 2_000;
    while (Date.now() < remountDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      refreshed = await domains.dispatch({ operation: 'read_sidebar_core_projections', input: {} });
      if (refreshed[0]?.summary?.foundation?.missingCount === 0) break;
    }
    assert.equal(refreshed[0].summary.foundation.missingCount, 0,
      'an offline project root must be observed again when its directory is recreated or remounted');
  } finally {
    await domains.close();
  }
});

test('Daily review is loaded by invalidation or user action, never by an idle polling loop', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidebarWebview.ts'), 'utf8');
  assert.doesNotMatch(source, /function startDailyReviewPolling\s*\(/);
  assert.doesNotMatch(source, /dailyReviewPollTimer/);
  assert.match(source, /vscode\.postMessage\(\{ command: 'getDailyReview' \}\)/, 'initial visible state still loads once');
});

test('Sidebar Git and network refreshes cross the Runtime External Worker boundary', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidebarProjectLoader.ts'), 'utf8');
  assert.match(source, /operation: 'resolve_project_repository'/);
  assert.match(source, /operation: 'refresh_project_signal'/);
  assert.doesNotMatch(source, /resolveGithubRepoSlug|loadExternalIssueSummary|loadExternalPullRequestSummary|loadExternalDeliverySummary|loadExternalSecuritySummary/);
  assert.doesNotMatch(source, /child_process|spawn\s*\(|fetch\s*\(/);
});

test('Issue and pull-request user actions never execute GitHub or Git commands in the Extension Host', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const start = source.indexOf("'issue.getDetails': async");
  const end = source.indexOf("'project.refreshExternalData': async", start);
  const handlers = source.slice(start, end);
  for (const operation of ['resolve_project_repository', 'read_cached_project_issue_details', 'read_project_issue_details', 'create_project_issue', 'close_project_issue', 'close_project_pull_request']) {
    assert.match(handlers, new RegExp(`operation: '${operation}'`));
  }
  assert.doesNotMatch(handlers, /readCachedIssueDetails|readProjectIssueDetails|createProjectIssue|closeProjectIssue|closeProjectPullRequest|spawnSync|execFileSync/);
});

test('Project diff and rollback actions execute Git work only through the Runtime Git Worker', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const start = source.indexOf('async function openProjectFileDiff');
  const end = source.indexOf('/**\n * Executes a CLI agent', start);
  const handlers = source.slice(start, end);
  for (const operation of ['read_git_file_at_revision', 'inspect_project_git_rollback', 'execute_project_git_rollback']) {
    assert.match(handlers, new RegExp(`operation: '${operation}'`));
  }
  assert.doesNotMatch(handlers, /spawnSync\('git'|execFileSync\('git'|getGitCommandOutput|readGitFileAtRevision|moveUntrackedFilesToRollbackSafety/);
});

test('Sidebar portfolio enrichment is entirely projection-backed in the Extension Host', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidebarProjectLoader.ts'), 'utf8');
  const providerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidebarProvider.ts'), 'utf8');
  assert.doesNotMatch(source, /readProjectInvestmentStatsFromDatabase|readLearningOverview|buildProjectPortfolioSummary/);
  assert.doesNotMatch(source, /read_project_reusable_source_count|read_documentation_manifest|read_project_analysis_source/);
  assert.doesNotMatch(providerSource, /foundationSignature|syncFoundationWatchers|reconcileFoundationSources|RelativePattern/,
    'the Extension Host must only consume persisted projections and must never scan or watch every registered project');
});

test('Sidebar background card updates patch one stable keyed card without rebuilding the portfolio region', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidebarWebview.ts'), 'utf8');
  const start = source.indexOf('function renderPortfolio(portfolio');
  const end = source.indexOf('function selectProjectInSidebar', start);
  const body = source.slice(start, end);
  const updatedBranchStart = body.indexOf('if (updatedProjectPath)');
  const updatedBranch = body.slice(updatedBranchStart, body.indexOf('} else {', updatedBranchStart));
  assert.match(body, /if \(updatedProjectPath\)[\s\S]*?currentCard\.replaceWith\(nextCard\)/);
  assert.match(body, /portfolioBindingRoot\.querySelectorAll/);
  assert.doesNotMatch(updatedBranch, /portfolioList\.innerHTML\s*=/);
  assert.match(source, /content-visibility:\s*auto/);
});

test('Retired view-time Sidebar projection cannot be called as a parallel core path', () => {
  const legacy = require('../out/sidebarCoreProjection.js');
  assert.equal(legacy.buildSidebarCoreProjection, undefined);
  const providerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidebarProvider.ts'), 'utf8');
  assert.doesNotMatch(providerSource, /sidebarCoreProjection|buildSidebarCoreProjection/);
});

test('Conversation launch coordinator starts terminal and Runtime preparation concurrently', async () => {
  const { coordinateConversationLaunch } = require('../out/conversationLaunchCoordinator.js');
  const started = [];
  let releaseTerminal;
  let releaseRuntime;
  const terminalGate = new Promise(resolve => { releaseTerminal = resolve; });
  const runtimeGate = new Promise(resolve => { releaseRuntime = resolve; });
  const launch = coordinateConversationLaunch({
    captureSnapshot: () => ({ project: '/visible' }),
    openTerminal: async () => { started.push('terminal'); await terminalGate; return { id: 'terminal' }; },
    prepareRuntime: async () => { started.push('runtime'); await runtimeGate; return { id: 'target' }; },
    execute: async ({ terminal, target }) => `${terminal.id}:${target.id}`,
    releaseTerminal: () => started.push('release-terminal'),
    releaseTarget: () => started.push('release-target')
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['terminal', 'runtime']);
  releaseTerminal();
  releaseRuntime();
  assert.equal(await launch, 'terminal:target');
  assert.deepEqual(started.slice(-2), ['release-target', 'release-terminal']);
});

test('Solo launch does not synchronously load the roadmap in the Extension Host', () => {
  const extension = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const handler = extension.slice(extension.indexOf('async function handleRunSoloConversation'), extension.indexOf('async function startFlowRoleRun'));
  assert.doesNotMatch(handler, /refreshNodes|initAndSync|getAgentExecutions/);
  assert.match(extension, /captureRegisteredConversationLaunchTarget\(context, workspaceRoot, snapshot, true\)/);
  assert.match(extension, /skipRoadmap \? \{ roadmap: 'skip' \} : undefined/);
});

test('Sidebar startup restores only the selected cached conversation and leaves background projects demand-driven', async () => {
  const cachePath = require.resolve('../out/sidebarSnapshotCache.js');
  const providerPath = require.resolve('../out/sidebarProvider.js');
  const cache = require(cachePath);
  const originalRead = cache.readCachedConversationSnapshot;
  const originalLoad = Module._load;
  const reads = [];
  cache.readCachedConversationSnapshot = async (_root, projectPath) => {
    reads.push(projectPath);
    return { solo: [], project: [], flow: [], revision: [] };
  };
  Module._load = function(request, parent, isMain) {
    if (request === 'vscode') return callableProxy();
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[providerPath];
  try {
    const { SolopreneurSidebarProvider } = require(providerPath);
    const projects = ['/project/a', '/project/b', '/project/c'].map((projectPath, index) => ({
      path: projectPath,
      name: `Project ${index + 1}`
    }));
    const posted = [];
    const provider = new SolopreneurSidebarProvider({ fsPath: projectRoot }, { getNodes: () => [] }, {
      getSettings: () => ({ globalDataPath: '/data/root' }),
      updateSettings: async () => {},
      getProjects: () => ({ projects, selectedProjectPath: projects[0].path, projectGeneration: 1 }),
      readAgentAccountStatuses: async () => []
    });
    provider._view = { webview: { postMessage: async message => { posted.push(message); return true; } } };
    provider._latestPortfolio = projects.map(project => ({ ...project, overallStatus: 'Pending' }));
    provider._projectLoader.scheduleExternalSignals = () => {};
    provider.scheduleCorePortfolio = () => {};
    provider.sendDailyReview = () => {};

    await provider.sendProjects();
    for (let turn = 0; turn < 10; turn += 1) await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(reads, [projects[0].path]);
    assert.ok(posted.some(message => message.command === 'sidebarProjectConversationSnapshotLoaded'));
  } finally {
    cache.readCachedConversationSnapshot = originalRead;
    Module._load = originalLoad;
    delete require.cache[providerPath];
  }
});

test('Solo send leaves the Webview before any portfolio rebuild can run', async t => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { t.skip('Playwright is unavailable in this host.'); return; }

  const webview = { asWebviewUri: () => '', cspSource: '' };
  const html = require('../out/sidebarWebview.js').getSidebarWebviewHtml(webview, { fsPath: projectRoot });
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error && error.message || error)));
    await page.route('**/*', route => route.abort());
    await page.evaluate(() => {
      window.__posted = [];
      window.acquireVsCodeApi = () => ({
        postMessage(message) { window.__posted.push(structuredClone(message)); },
        getState() { return {}; },
        setState() {}
      });
    });
    await page.setContent(html);
    const send = message => page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: value })), message);
    const project = { path: '/fixture/current', name: 'Current project' };
    await send({ command: 'settingsLoaded', settings: { language: 'zh', cliPath: 'codex', agentModelPreferences: {} } });
    await send({
      command: 'projectsLoaded',
      projects: {
        projects: [project],
        selectedProjectPath: project.path,
        projectGeneration: 1,
        portfolio: [{ ...project, overallStatus: 'In Progress', globalPriority: 'P1' }]
      }
    });
    await page.locator('[data-project-conversation-mode="solo"]').click();
    await page.locator('[data-project-conversation-input]').fill('从用户动作直接启动');
    await page.evaluate(() => {
      window.__posted = [];
      const portfolio = document.getElementById('portfolio-list');
      const original = portfolio.querySelectorAll.bind(portfolio);
      portfolio.querySelectorAll = selector => {
        if (selector === '[data-select-project-path]') throw new Error('foreground_launch_rebuilt_portfolio');
        return original(selector);
      };
    });

    await page.locator('[data-project-continue-send]').click();
    await page.waitForTimeout(25);

    const launches = await page.evaluate(() => window.__posted.filter(message => message.command === 'conversation.runSolo'));
    assert.equal(launches.length, 1);
    assert.equal(launches[0].projectPath, project.path);
    assert.equal(launches[0].userMessage, '从用户动作直接启动');
    assert.deepEqual(pageErrors, [], 'foreground send must not enter the portfolio renderer');
  } finally {
    await browser.close();
  }
});
