const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');
const { sendRuntimeControlCommand, sendRuntimeDataRequest } = require('../out/autonomousRuntimeControl.js');
const { readTodayReviewFromDatabase } = require('../out/dailyReview.js');
const { buildAgentImpactSummaryFromDatabase } = require('../out/agentImpact.js');
const { readCompleteJson } = require('./validation-json-receipt.cjs');
const packageVersion = require('../package.json').version;

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

const requestedDataRoot = argumentValue('--data-root');
const candidateReleaseVersion = argumentValue('--release-version');
const candidateVsix = path.resolve(argumentValue('--candidate-vsix'));
assert.ok(requestedDataRoot, 'formal_data_root_required: pass --data-root explicitly');
assert.match(candidateReleaseVersion, /^\d+\.\d+\.\d+$/, 'formal_release_version_required: pass --release-version explicitly');
assert.equal(candidateReleaseVersion, packageVersion,
  `formal_release_version_unbound:${candidateReleaseVersion}:package_version:${packageVersion}`);
assert.ok(candidateVsix && fs.existsSync(candidateVsix), 'formal_candidate_vsix_required: pass --candidate-vsix explicitly');
const sourceDataRoot = path.resolve(requestedDataRoot);
const extensionPath = path.resolve(__dirname, '..');
const expectedBuildId = candidateRuntimeBuildId(candidateVsix);
const launchDeadlineMs = 60_000;
const backgroundConcurrency = 8;
const formalMemoryLimitBytes = 16 * 1024 ** 3;
const minimumFormalProjectCount = 57;
let activeDataRoot = '';
let activeRuntimeId = '';
let activeRuntimePid = 0;
let activeSnapshotPath = '';
let activeLaunchReceiptPath = '';
let activeReadyReceiptPath = '';
let activeLoadStartPath = '';
let activeGateRoot = '';
let activeRealLaunch;
let activeRealLaunchOutput = '';
let stopActiveLoad = () => {};
let oomKillsBefore = null;

function cgroupMemoryValue(name) {
  const file = path.join('/sys/fs/cgroup', name);
  try { return Number(fs.readFileSync(file, 'utf8').trim()); }
  catch { return null; }
}

function cgroupMemoryStat(name) {
  try {
    const entries = Object.fromEntries(fs.readFileSync('/sys/fs/cgroup/memory.stat', 'utf8').trim().split(/\n/)
      .map(line => line.trim().split(/\s+/, 2)));
    const value = Number(entries[name]);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch { return null; }
}

function cgroupOomKills() {
  try {
    const entries = Object.fromEntries(fs.readFileSync('/sys/fs/cgroup/memory.events', 'utf8').trim().split(/\n/)
      .map(line => line.trim().split(/\s+/, 2)));
    return Number(entries.oom_kill || 0);
  } catch { return null; }
}

function releaseSnapshotPageCache(snapshotPath, syncBeforeRelease = true) {
  if (syncBeforeRelease) {
    const synced = childProcess.spawnSync('sync', ['-f', snapshotPath], { encoding: 'utf8' });
    assert.equal(synced.status, 0, `formal_snapshot_sync_failed:${String(synced.stderr || '').trim()}`);
  }
  const released = childProcess.spawnSync('python3', ['-c', [
    'import os,sys',
    'fd=os.open(sys.argv[1], os.O_RDONLY)',
    'try: os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)',
    'finally: os.close(fd)'
  ].join('\n'), snapshotPath], { encoding: 'utf8' });
  assert.equal(released.status, 0, `formal_snapshot_cache_release_failed:${String(released.stderr || '').trim()}`);
}

function candidateRuntimeBuildId(archivePath) {
  const listing = childProcess.spawnSync('unzip', ['-Z1', archivePath], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
  });
  assert.equal(listing.status, 0, `formal_candidate_vsix_listing_failed:${String(listing.stderr || '').trim()}`);
  const prefix = 'extension/out/';
  const entries = String(listing.stdout || '').split(/\r?\n/)
    .filter(entry => entry.startsWith(prefix) && /\.(?:js|mjs)$/.test(entry))
    .sort();
  assert.ok(entries.length > 0, 'formal_candidate_vsix_runtime_files_missing');
  const hash = crypto.createHash('sha256');
  for (const entry of entries) {
    const extracted = childProcess.spawnSync('unzip', ['-p', archivePath, entry], {
      encoding: null, maxBuffer: 64 * 1024 * 1024
    });
    assert.equal(extracted.status, 0, `formal_candidate_vsix_read_failed:${entry}:${String(extracted.stderr || '').trim()}`);
    hash.update(entry.slice(prefix.length));
    hash.update('\0');
    hash.update(extracted.stdout);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function sqlString(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function observeConcurrentWork(label, promise) {
  return Promise.resolve(promise).then(
    value => ({ label, value }),
    error => ({ label, error })
  );
}
function concurrentWorkValue(result) {
  if (!result.error) return result.value;
  const detail = result.error instanceof Error ? result.error.stack || result.error.message : String(result.error);
  throw new Error(`formal_concurrent_work_failed:${result.label}:${detail}`, { cause: result.error });
}
function readSourceProjectRegistry(database) {
  const row = database.prepare(`
    SELECT c.encoding,c.data
    FROM settings s
    JOIN objects o ON o.id=s.id
    JOIN contents c ON c.id=s.content_id
    WHERE s.namespace='project_registry' AND s.key='registry' AND s.owner_scope='global' AND o.archived_at IS NULL
  `).get();
  assert.ok(row && row.encoding === 'utf8', 'formal_source_project_registry_unavailable');
  return JSON.parse(Buffer.from(row.data).toString('utf8'));
}
function unlinkGenerated(file) {
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function removeGeneratedTree(root) {
  const resolvedRoot = path.resolve(root);
  assert.equal(path.dirname(resolvedRoot), path.resolve(os.tmpdir()),
    `formal_fixture_cleanup_outside_tmp:${resolvedRoot}`);
  assert.match(path.basename(resolvedRoot), /^solomap-runtime-load-gate-[A-Za-z0-9_-]+$/,
    `formal_fixture_cleanup_invalid_root:${resolvedRoot}`);
  const removeEntry = entry => {
    const resolvedEntry = path.resolve(entry);
    assert.ok(resolvedEntry === resolvedRoot || resolvedEntry.startsWith(`${resolvedRoot}${path.sep}`),
      `formal_fixture_cleanup_outside_root:${resolvedEntry}`);
    let stat;
    try { stat = fs.lstatSync(resolvedEntry); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fs.unlinkSync(resolvedEntry);
      return;
    }
    for (const child of fs.readdirSync(resolvedEntry)) removeEntry(path.join(resolvedEntry, child));
    fs.rmdirSync(resolvedEntry);
  };
  removeEntry(resolvedRoot);
}
async function waitForExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`formal_snapshot_runtime_stop_timeout:${pid}`);
}
function snapshotRuntimeIdentityMatches(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2 || !activeDataRoot || process.platform !== 'linux') return false;
  try {
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    return command.some(value => /autonomousRuntimeProcess\.js$/.test(value)) && command.includes(activeDataRoot);
  } catch { return false; }
}
async function terminateExactSnapshotRuntime(pid) {
  assert.equal(snapshotRuntimeIdentityMatches(pid), true, `formal_snapshot_runtime_identity_changed:${pid}`);
  process.kill(pid, 'SIGTERM');
  try { await waitForExit(pid, 3_000); return; } catch (error) {
    if (!/formal_snapshot_runtime_stop_timeout/.test(String(error))) throw error;
  }
  assert.equal(snapshotRuntimeIdentityMatches(pid), true, `formal_snapshot_runtime_identity_changed:${pid}`);
  process.kill(pid, 'SIGKILL');
  await waitForExit(pid, 3_000);
}
async function stopSnapshotRuntime() {
  if (!activeDataRoot) return;
  if (!activeRuntimeId) {
    try {
      const endpoint = JSON.parse(fs.readFileSync(path.join(activeDataRoot, 'runtime', 'control.json'), 'utf8'));
      activeRuntimeId = String(endpoint.runtimeId || ''); activeRuntimePid = Number(endpoint.pid || 0);
    } catch { return; }
  }
  let stopError;
  try { await sendRuntimeControlCommand(activeDataRoot, 'stop', { expectedRuntimeId: activeRuntimeId, timeoutMs: 3_000 }); }
  catch (error) { stopError = error; }
  if (activeRuntimePid) {
    try { await waitForExit(activeRuntimePid, 5_000); }
    catch (error) {
      if (!/formal_snapshot_runtime_stop_timeout/.test(String(error))) throw error;
      await terminateExactSnapshotRuntime(activeRuntimePid);
    }
  } else if (stopError && !/ECONNREFUSED|ENOENT|control_unavailable|Invalid Runtime endpoint/.test(String(stopError))) throw stopError;
  activeRuntimeId = ''; activeRuntimePid = 0;
}
async function cleanupSnapshotFiles() {
  let runtimeStopped = false;
  try {
    await stopSnapshotRuntime();
    runtimeStopped = true;
    if (activeLaunchReceiptPath) unlinkGenerated(activeLaunchReceiptPath);
    if (activeReadyReceiptPath) unlinkGenerated(activeReadyReceiptPath);
    if (activeLoadStartPath) unlinkGenerated(activeLoadStartPath);
    if (activeSnapshotPath) {
      for (const suffix of ['-wal', '-shm', '-journal', '']) unlinkGenerated(`${activeSnapshotPath}${suffix}`);
    }
  } finally {
    if (runtimeStopped) {
      if (activeGateRoot) removeGeneratedTree(activeGateRoot);
      activeGateRoot = '';
      activeDataRoot = '';
      activeLaunchReceiptPath = ''; activeReadyReceiptPath = ''; activeLoadStartPath = ''; activeSnapshotPath = '';
    }
  }
}

async function waitForJsonReceipt(file, child, output, timeoutMs, failure) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = readCompleteJson(file);
    if (receipt !== undefined) return receipt;
    if (child.exitCode !== null || child.signalCode) throw new Error(`${failure}:child_exit:${child.exitCode}:${output().slice(-8000)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`${failure}:${output().slice(-8000)}`);
}

async function waitForRuntimeHealth(root, child, output, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) throw new Error(`formal_candidate_runtime_child_exit:${child.exitCode}:${output().slice(-8000)}`);
    try { return await sendRuntimeControlCommand(root, 'health', { timeoutMs: 1_000 }); }
    catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`formal_candidate_runtime_not_ready:${String(lastError)}:${output().slice(-8000)}`);
}

(async () => {
  const sourceHealth = await sendRuntimeControlCommand(sourceDataRoot, 'health', { timeoutMs: 3_000 });
  const sourceDatabasePath = path.join(sourceDataRoot, 'solomap.db');
  const sourceDatabase = new DatabaseSync(sourceDatabasePath, { readOnly: true });
  const sourceRegistry = readSourceProjectRegistry(sourceDatabase);
  const sourceProjects = (Array.isArray(sourceRegistry?.projects) ? sourceRegistry.projects : [])
    .map(project => ({ path: String(project.path || '') }));
  const sourceDatabaseBytes = fs.statSync(sourceDatabasePath).size;
  const sourceProjectCount = sourceProjects.length;
  assert.ok(sourceProjectCount >= minimumFormalProjectCount,
    `formal_source_project_count_too_small:${sourceProjectCount}:minimum=${minimumFormalProjectCount}`);
  assert.ok(sourceDatabaseBytes >= 19_000_000_000, `formal_source_database_too_small:${sourceDatabaseBytes}`);
  const productionProjectPaths = new Set(sourceProjects.map(project => path.resolve(String(project.path || ''))));

  const gateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-runtime-load-gate-'));
  activeGateRoot = gateRoot;
  const dataRoot = path.join(gateRoot, '.solomap-global');
  fs.mkdirSync(dataRoot);
  activeSnapshotPath = path.join(dataRoot, 'solomap.db');
  try { sourceDatabase.exec(`VACUUM INTO ${sqlString(activeSnapshotPath)}`); }
  finally { sourceDatabase.close(); }
  releaseSnapshotPageCache(sourceDatabasePath, false);
  releaseSnapshotPageCache(activeSnapshotPath);
  oomKillsBefore = cgroupOomKills();
  const memoryCurrent = cgroupMemoryValue('memory.current');
  const memoryLimit = cgroupMemoryValue('memory.max');
  assert.ok(Number.isFinite(memoryCurrent) && memoryCurrent >= 0, 'formal_memory_current_unavailable');
  assert.ok(Number.isFinite(oomKillsBefore) && oomKillsBefore >= 0, 'formal_oom_counter_unavailable');
  assert.ok(Number.isFinite(memoryLimit) && memoryLimit > 0 && memoryLimit <= formalMemoryLimitBytes,
    `formal_memory_limit_invalid:${memoryLimit}:maximum=${formalMemoryLimitBytes}`);
  const rawHeadroom = memoryLimit - memoryCurrent;
  const reclaimableInactiveFile = cgroupMemoryStat('inactive_file');
  assert.ok(Number.isFinite(reclaimableInactiveFile) && reclaimableInactiveFile >= 0, 'formal_memory_stat_unavailable');
  const effectiveHeadroom = rawHeadroom + reclaimableInactiveFile;
  assert.ok(effectiveHeadroom >= 8 * 1024 ** 3,
    `formal_memory_headroom_insufficient:raw=${rawHeadroom}:inactive_file=${reclaimableInactiveFile}:effective=${effectiveHeadroom}`);
  activeDataRoot = dataRoot;
  const launchReceiptPath = path.join(gateRoot, 'real-launch-receipt.json');
  const readyReceiptPath = path.join(gateRoot, 'candidate-host-ready.json');
  const loadStartPath = path.join(gateRoot, 'load-start');
  activeLaunchReceiptPath = launchReceiptPath; activeReadyReceiptPath = readyReceiptPath; activeLoadStartPath = loadStartPath;
  const realLaunch = childProcess.spawn(process.execPath, ['scripts/run-node-tests.cjs', 'test/browser/real-codex-launch-gate.cjs'], {
    cwd: extensionPath,
    env: { ...process.env, SOLOMAP_REAL_CODEX_VSIX: candidateVsix, SOLOMAP_REAL_CODEX_DATA_ROOT: dataRoot,
      SOLOMAP_LOAD_GATE_RECEIPT: launchReceiptPath, SOLOMAP_LOAD_GATE_READY: readyReceiptPath, SOLOMAP_LOAD_GATE_START: loadStartPath },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  activeRealLaunch = realLaunch;
  let realLaunchOutput = '';
  const captureRealLaunchOutput = chunk => {
    realLaunchOutput += chunk;
    activeRealLaunchOutput = realLaunchOutput.slice(-32_000);
  };
  realLaunch.stdout.on('data', captureRealLaunchOutput);
  realLaunch.stderr.on('data', captureRealLaunchOutput);
  const realLaunchExit = new Promise(resolve => realLaunch.once('exit', (code, signal) => resolve({ code, signal })));
  const hostReady = await waitForJsonReceipt(readyReceiptPath, realLaunch, () => realLaunchOutput, 120_000, 'formal_candidate_host_not_ready');
  const health = await waitForRuntimeHealth(dataRoot, realLaunch, () => realLaunchOutput, 30_000);
  const runtimeEndpoint = JSON.parse(fs.readFileSync(path.join(dataRoot, 'runtime', 'control.json'), 'utf8'));
  activeRuntimeId = String(health.runtimeId || ''); activeRuntimePid = Number(runtimeEndpoint.pid || 0);
  assert.equal(health.buildId, expectedBuildId, `formal_runtime_build_mismatch:${health.buildId || 'missing'}`);
  assert.equal(health.releaseVersion, candidateReleaseVersion, `formal_runtime_release_mismatch:${health.releaseVersion || 'missing'}`);
  assert.ok(path.resolve(String(health.entryPath || '')).startsWith(path.resolve(String(hostReady.extensionPath)) + path.sep),
    `formal_runtime_not_owned_by_candidate_vsix:${health.entryPath || 'missing'}`);
  const [registrySnapshot, overview] = await Promise.all([
    sendRuntimeDataRequest(dataRoot, { operation: 'read_project_registry', input: {} }),
    sendRuntimeDataRequest(dataRoot, { operation: 'read_database_overview', input: {} })
  ]);
  const candidateProjects = Array.isArray(registrySnapshot?.registry?.projects) ? registrySnapshot.registry.projects : [];
  const gateWorkspacePath = path.resolve(String(hostReady.workspacePath || ''));
  const candidateProjectPaths = new Set(candidateProjects.map(project => path.resolve(String(project.path || ''))));
  for (const productionPath of productionProjectPaths) {
    assert.ok(candidateProjectPaths.has(productionPath), `formal_production_project_missing:${productionPath}`);
  }
  const initialUnexpectedProjects = candidateProjects
    .map(project => path.resolve(String(project.path || '')))
    .filter(projectPath => !productionProjectPaths.has(projectPath));
  assert.ok(initialUnexpectedProjects.every(projectPath => projectPath === gateWorkspacePath),
    `formal_unexpected_project_registered:${initialUnexpectedProjects.join(',')}`);
  assert.ok(initialUnexpectedProjects.length <= 1, `formal_unexpected_project_registered:${initialUnexpectedProjects.join(',')}`);
  const projects = candidateProjects.filter(project => productionProjectPaths.has(path.resolve(String(project.path || ''))));
  const projectCount = projects.length;
  let observedProjectCount = candidateProjects.length;
  const databaseBytes = Number(overview?.databaseBytes || 0);
  assert.equal(projectCount, sourceProjectCount,
    `formal_project_count_changed:${projectCount}:source=${sourceProjectCount}`);
  assert.ok(databaseBytes > 0 && databaseBytes <= sourceDatabaseBytes, `formal_snapshot_database_invalid:${databaseBytes}`);
  let networkTarget = null;
  for (const project of projects) {
    const resolved = await sendRuntimeDataRequest(dataRoot, { operation: 'resolve_project_repository', input: { root: project.path }, deadlineAt: Date.now() + 2_000 });
    if (resolved?.repo) { networkTarget = { project, repo: resolved.repo }; break; }
  }
  assert.ok(networkTarget, 'formal_network_repository_unavailable');

  const loadStarted = performance.now(), loadStartedWallMs = Date.now();
  const loadDeadline = loadStarted + launchDeadlineMs;
  let loadActive = true;
  stopActiveLoad = () => { loadActive = false; };
  let backgroundReads = 0;
  let backgroundRows = 0;
  const workload = (lane, project) => {
    switch (lane) {
      case 0: return { operation: 'read_project_investment_runs', input: { root: project.path, limit: 200 } };
      case 1: return { operation: 'read_project_impact_runs', input: { root: project.path, limit: 200 } };
      case 2: return { operation: 'read_database_overview', input: {} };
      case 3: return { operation: 'read_diagnostic_events', input: { limit: 50 } };
      case 4: return { operation: 'read_sidebar_core_projections', input: {} };
      case 5: return { operation: 'migration_overview', input: {} };
      case 6: return { operation: 'resolve_project_repository', input: { root: project.path } };
      default: return { operation: 'read_today_roadmaps', input: { roots: projects.map(item => item.path) } };
    }
  };
  const backgroundWork = observeConcurrentWork('background-readers', Promise.all(Array.from({ length: backgroundConcurrency }, async (_, lane) => {
    let index = lane;
    while (loadActive && performance.now() < loadDeadline) {
      const request = workload(lane, projects[index % projects.length]);
      const rows = await sendRuntimeDataRequest(dataRoot, request);
      assert.notEqual(rows, undefined, `formal_background_query_invalid:${request.operation}`);
      backgroundReads += 1;
      backgroundRows += Array.isArray(rows) ? rows.length : 1;
      index += backgroundConcurrency;
    }
  })));

  const networkWork = observeConcurrentWork('network-worker', sendRuntimeDataRequest(dataRoot, {
    operation: 'read_github_api', input: { endpoint: `repos/${networkTarget.repo}/issues?state=open&per_page=1` }, deadlineAt: Date.now() + 30_000
  }));
  const dailyReviewWork = observeConcurrentWork('daily-review', readTodayReviewFromDatabase(dataRoot, projects));
  const agentImpactWork = observeConcurrentWork('agent-impact', buildAgentImpactSummaryFromDatabase(projects, extensionPath, new Date(), dataRoot));
  fs.writeFileSync(loadStartPath, JSON.stringify({ schemaVersion: 1, loadStartedWallMs }), { flag: 'wx' });

  const latencies = [], foregroundLatencies = [];
  let launchReceipt;
  while (performance.now() < loadDeadline) {
    const started = performance.now();
    const current = await sendRuntimeDataRequest(dataRoot, {
      operation: 'read_project_registry', input: {}, deadlineAt: Date.now() + 500
    });
    const currentProjects = Array.isArray(current?.registry?.projects) ? current.registry.projects : [];
    const currentPaths = new Set(currentProjects.map(project => path.resolve(String(project.path || ''))));
    for (const productionPath of productionProjectPaths) {
      assert.ok(currentPaths.has(productionPath), `formal_production_project_missing:${productionPath}`);
    }
    const unexpectedProjects = currentProjects.map(project => path.resolve(String(project.path || '')))
      .filter(projectPath => !productionProjectPaths.has(projectPath));
    assert.ok(unexpectedProjects.length <= 1 && unexpectedProjects.every(projectPath => projectPath === gateWorkspacePath),
      `formal_unexpected_project_registered:${unexpectedProjects.join(',')}`);
    observedProjectCount = Math.max(observedProjectCount, currentProjects.length);
    latencies.push(performance.now() - started);
    const foregroundStarted = performance.now();
    const foreground = await sendRuntimeDataRequest(dataRoot, {
      operation: 'read_intelligence_execution_mode', input: {}, deadlineAt: Date.now() + 500
    });
    assert.ok(['legacy', 'harness'].includes(String(foreground?.mode || '')), 'formal_writer_coordination_query_invalid');
    foregroundLatencies.push(performance.now() - foregroundStarted);
    const candidateLaunchReceipt = readCompleteJson(launchReceiptPath);
    if (candidateLaunchReceipt !== undefined) {
      launchReceipt = candidateLaunchReceipt;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  loadActive = false;
  stopActiveLoad = () => {};
  assert.ok(launchReceipt, `formal_real_launch_receipt_missing:${realLaunchOutput.slice(-4000)}`);
  assert.ok(Number(launchReceipt.acceptedWallMs) >= loadStartedWallMs, 'formal_real_launch_started_before_load');
  assert.ok(Number(launchReceipt.ingressObservedWallMs) <= Date.now(), 'formal_real_launch_receipt_clock_invalid');
  assert.ok(Number(launchReceipt.launchSettledWallMs) - Number(launchReceipt.acceptedWallMs) < 10_000,
    `formal_real_launch_deadline_exceeded:${Number(launchReceipt.launchSettledWallMs) - Number(launchReceipt.acceptedWallMs)}`);
  assert.ok(Number(launchReceipt.agentLaunchElapsedMs) < 10_000,
    `formal_real_agent_process_launch_deadline_exceeded:${Number(launchReceipt.agentLaunchElapsedMs)}`);
  assert.ok(Number(launchReceipt.firstOutputElapsedMs) < 15_000,
    `formal_real_agent_first_output_deadline_exceeded:${Number(launchReceipt.firstOutputElapsedMs)}`);
  const concurrentResults = await Promise.all([networkWork, dailyReviewWork, agentImpactWork, backgroundWork]);
  const [networkResult, dailyReview, agentImpact] = concurrentResults.slice(0, 3).map(concurrentWorkValue);
  concurrentWorkValue(concurrentResults[3]);
  const realLaunchResult = await realLaunchExit;
  activeRealLaunch = undefined;
  assert.equal(realLaunchResult.code, 0, `formal_real_launch_gate_failed:${realLaunchResult.signal || ''}:${realLaunchOutput.slice(-8000)}`);
  assert.ok(networkResult === null || typeof networkResult === 'object', 'formal_network_read_invalid');
  assert.ok(dailyReview === null || typeof dailyReview === 'object', 'formal_daily_review_invalid');
  assert.ok(agentImpact && Number.isFinite(agentImpact.totalRuns), 'formal_agent_impact_invalid');
  latencies.sort((left, right) => left - right);
  foregroundLatencies.sort((left, right) => left - right);
  const p95 = latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)];
  const maximum = latencies.at(-1);
  const foregroundP95 = foregroundLatencies[Math.max(0, Math.ceil(foregroundLatencies.length * 0.95) - 1)];
  const foregroundMaximum = foregroundLatencies.at(-1);
  process.stdout.write(`${JSON.stringify({
    formalLatencyEvidence: true,
    interactiveSamples: latencies.length,
    interactiveP95Ms: Number(p95.toFixed(3)),
    interactiveMaxMs: Number(maximum.toFixed(3)),
    foregroundSamples: foregroundLatencies.length,
    foregroundP95Ms: Number(foregroundP95.toFixed(3)),
    foregroundMaxMs: Number(foregroundMaximum.toFixed(3))
  })}\n`);
  assert.ok(latencies.length >= 10, `interactive_sample_too_small:${latencies.length}`);
  assert.ok(p95 < 100, `interactive_read_p95_exceeded:${p95.toFixed(3)}`);
  assert.ok(maximum < 250, `interactive_read_hard_limit_exceeded:${maximum.toFixed(3)}`);
  assert.ok(foregroundLatencies.length >= 10, `foreground_sample_too_small:${foregroundLatencies.length}`);
  assert.ok(foregroundP95 < 100, `foreground_command_p95_exceeded:${foregroundP95.toFixed(3)}`);
  assert.ok(foregroundMaximum < 250, `foreground_command_hard_limit_exceeded:${foregroundMaximum.toFixed(3)}`);
  const oomKillsAfter = cgroupOomKills();
  assert.ok(Number.isFinite(oomKillsAfter) && oomKillsAfter >= 0, 'formal_oom_counter_unavailable');
  assert.equal(oomKillsAfter, oomKillsBefore,
    `formal_candidate_oom_killed:${oomKillsBefore}->${oomKillsAfter}`);
  const result = {
    schemaVersion: 2,
    sourceRuntimeId: sourceHealth.runtimeId,
    runtimeId: health.runtimeId,
    runtimeBuildId: health.buildId,
    runtimeReleaseVersion: health.releaseVersion,
    packageVersion,
    candidateReleaseVersion,
    sourceDataRoot,
    sourceDatabaseBytes,
    databaseBytes,
    projectCount,
    observedProjectCount,
    agentIngress: { interactionId: launchReceipt.interactionId, authority: launchReceipt.authority,
      elapsedMs: Number(launchReceipt.taskIngressElapsedMs || 0), acceptedWallMs: Number(launchReceipt.acceptedWallMs),
      launchSettledWallMs: Number(launchReceipt.launchSettledWallMs),
      agentLaunchElapsedMs: Number(launchReceipt.agentLaunchElapsedMs),
      firstOutputElapsedMs: Number(launchReceipt.firstOutputElapsedMs),
      observedWallMs: Number(launchReceipt.ingressObservedWallMs) },
    backgroundConcurrency,
    backgroundReads,
    backgroundRows,
    backgroundOperations: ['investment', 'impact', 'overview', 'diagnostics', 'sidebar-projection', 'migration', 'git', 'today-roadmaps', 'network', 'daily-review', 'agent-impact'],
    backgroundDurationMs: Number((performance.now() - loadStarted).toFixed(3)),
    interactiveSamples: latencies.length,
    interactiveP95Ms: Number(p95.toFixed(3)),
    interactiveMaxMs: Number(maximum.toFixed(3)),
    foregroundSamples: foregroundLatencies.length,
    foregroundP95Ms: Number(foregroundP95.toFixed(3)),
    foregroundMaxMs: Number(foregroundMaximum.toFixed(3)),
    oomKillsBefore,
    oomKillsAfter,
    memoryLimitBytes: memoryLimit,
    passed: true
  };
  await cleanupSnapshotFiles();
  process.stdout.write(`${JSON.stringify(result)}\n`);
})().catch(async error => {
  stopActiveLoad();
  if (activeRealLaunch && activeRealLaunch.exitCode === null && !activeRealLaunch.signalCode) {
    activeRealLaunch.kill('SIGTERM');
    await Promise.race([new Promise(resolve => activeRealLaunch.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 5_000))]);
  }
  try { await cleanupSnapshotFiles(); }
  catch (cleanupError) { process.stderr.write(`${cleanupError instanceof Error ? cleanupError.stack : String(cleanupError)}\n`); }
  const launchContext = activeRealLaunchOutput ? `\n--- real launch output ---\n${activeRealLaunchOutput}` : '';
  const oomKillsAfter = cgroupOomKills();
  const oomContext = oomKillsBefore !== null && oomKillsAfter !== null && oomKillsAfter > oomKillsBefore
    ? `formal_candidate_oom_killed:${oomKillsBefore}->${oomKillsAfter}:` : '';
  process.stderr.write(`${oomContext}${error instanceof Error ? error.stack : String(error)}${launchContext}\n`);
  process.exitCode = 1;
});
