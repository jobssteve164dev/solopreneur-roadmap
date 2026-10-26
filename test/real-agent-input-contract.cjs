const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { sendRuntimeControlCommand } = require('../out/autonomousRuntimeControl.js');
const { buildNativeContinueCommand, shellQuote } = require('../out/agentCli.js');

assert.ok(process.env.SOLOMAP_TEST_RUN_OWNERS, 'run this gate through scripts/run-node-tests.cjs so every owned process is reclaimed');

async function waitFor(check, message, timeoutMs, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(message);
}

function copyIfPresent(source, target) {
  if (fs.existsSync(source)) fs.copyFileSync(source, target);
}

function filesBelow(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const name of fs.readdirSync(root)) {
    const entry = path.join(root, name);
    const info = fs.lstatSync(entry);
    if (info.isDirectory() && !info.isSymbolicLink()) result.push(...filesBelow(entry));
    else result.push(entry);
  }
  return result;
}

function userMessageCount(transcriptPath) {
  return fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(line => line.includes('"type":"user_message"')).length;
}

test('real Codex honors closed stdin and resume-only reentry without a synthetic prompt', async t => {
  const codex = '/usr/local/bin/codex';
  assert.ok(fs.existsSync(codex), 'real Codex CLI is required');
  const sourceHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-real-input-contract-'));
  const codexHome = path.join(base, 'codex-home');
  const globalDataPath = path.join(base, '.solomap-global');
  const workspaceRoot = path.join(base, 'workspace');
  fs.mkdirSync(codexHome); fs.mkdirSync(workspaceRoot);
  copyIfPresent(path.join(sourceHome, 'auth.json'), path.join(codexHome, 'auth.json'));
  copyIfPresent(path.join(sourceHome, 'config.toml'), path.join(codexHome, 'config.toml'));
  copyIfPresent(path.join(sourceHome, 'solomap.config.toml'), path.join(codexHome, 'solomap.config.toml'));
  childProcess.execFileSync('git', ['init', '--quiet', workspaceRoot]);
  fs.writeFileSync(path.join(workspaceRoot, 'README.md'), '# real input contract\n');
  childProcess.execFileSync('git', ['-C', workspaceRoot, '-c', 'user.name=SoloMap Gate', '-c', 'user.email=gate@example.invalid', 'add', 'README.md']);
  childProcess.execFileSync('git', ['-C', workspaceRoot, '-c', 'user.name=SoloMap Gate', '-c', 'user.email=gate@example.invalid', 'commit', '--quiet', '-m', 'baseline']);

  const store = new UnifiedDataStore(globalDataPath);
  const project = await store.registerProject({ root: workspaceRoot });
  const command = `${shellQuote(codex)} --profile solomap exec --json -C ${shellQuote(workspaceRoot)} --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox ${shellQuote('Reply with exactly REAL_INPUT_CONTRACT_OK. Do not use tools or modify files.')}`;
  store.prepareRun(project.projectId, project.locationId, {
    root: workspaceRoot, executionLogId: 1, nodeId: '__solo__', runKind: 'flow_planner',
    prompt: 'real closed stdin gate', command, userMessage: 'real closed stdin gate',
    metadata: { interactiveSession: false, agentInputMode: 'closed', agentCli: codex }, idempotencyKey: 'real-input-contract'
  });
  store.close();

  const env = { ...process.env, CODEX_HOME: codexHome };
  const runtime = childProcess.spawn(process.execPath, [path.resolve(__dirname, '../out/autonomousRuntimeProcess.js'), '--global-data-path', globalDataPath], { env, stdio: 'pipe' });
  runtime.stdout.resume(); let runtimeError = ''; runtime.stderr.on('data', bytes => { runtimeError += bytes; });
  let runner; let resume;
  try {
    await waitFor(() => fs.existsSync(path.join(globalDataPath, 'runtime', 'control.json')), `Runtime did not start: ${runtimeError}`, 10_000);
    const startedAt = Date.now();
    runner = childProcess.spawn(process.execPath, [path.resolve(__dirname, '../out/runAgentProcess.js'), '--global-data-path', globalDataPath, '--project-path', workspaceRoot, '--execution-log-id', '1'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = []; runner.stdout.on('data', bytes => output.push(bytes)); runner.stderr.on('data', bytes => output.push(bytes));
    const taskStarted = await waitFor(() => {
      const text = Buffer.concat(output).toString('utf8');
      return text.split(/\r?\n/).some(line => { try { return JSON.parse(line).type === 'turn.started'; } catch { return false; } });
    }, 'real noninteractive Codex did not enter its turn within ten seconds', 10_000);
    assert.equal(taskStarted, true);
    const ingressElapsedMs = Date.now() - startedAt;
    const [runnerCode] = await Promise.race([
      once(runner, 'exit'),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('real noninteractive Codex did not finish')), 180_000); timer.unref(); })
    ]);
    const text = Buffer.concat(output).toString('utf8');
    assert.equal(runnerCode, 0, text.slice(-4000));
    assert.match(text, /REAL_INPUT_CONTRACT_OK/);
    const thread = text.split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(event => event?.type === 'thread.started');
    const sessionId = String(thread?.thread_id || '');
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    const transcriptPath = filesBelow(path.join(codexHome, 'sessions')).find(file => path.basename(file).includes(sessionId));
    assert.ok(transcriptPath, 'isolated Codex transcript was not found');
    const beforeMessages = userMessageCount(transcriptPath);

    const resumeCommand = buildNativeContinueCommand(codex, sessionId, workspaceRoot, 'auto', '', 'solomap');
    assert.doesNotMatch(resumeCommand, /REAL_INPUT_CONTRACT_OK|Read the complete SoloMap task prompt|Continue|\u7ee7\u7eed当前/);
    const resumeStartedAt = Date.now(); const resumeOutput = [];
    resume = childProcess.spawn('bash', ['-c', `exec script -q -f -e -c ${shellQuote(resumeCommand)} /dev/null`], { cwd: workspaceRoot, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    resume.stdout.on('data', bytes => resumeOutput.push(bytes)); resume.stderr.on('data', bytes => resumeOutput.push(bytes));
    await waitFor(() => Buffer.concat(resumeOutput).length > 200 && resume.exitCode === null, 'resume-only Codex TUI did not become visible within ten seconds', 10_000);
    const reentryElapsedMs = Date.now() - resumeStartedAt;
    await new Promise(resolve => setTimeout(resolve, 1_000));
    assert.equal(userMessageCount(transcriptPath), beforeMessages, 'resume-only startup must not append a user message');
    t.diagnostic(JSON.stringify({ ingressElapsedMs, reentryElapsedMs, sessionId, stdinClosed: true,
      codexReportedAdditionalInputRead: /Reading additional input from stdin/.test(text), syntheticPromptSubmitted: false }));
  } finally {
    if (resume && resume.exitCode === null && resume.signalCode === null) {
      try { if (process.platform === 'win32') resume.kill('SIGTERM'); else process.kill(-resume.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await Promise.race([once(resume, 'exit'), new Promise(resolve => setTimeout(resolve, 2_000))]);
    }
    if (runner && runner.exitCode === null && runner.signalCode === null) runner.kill('SIGTERM');
    if (runtime.exitCode === null && runtime.signalCode === null) {
      const exited = once(runtime, 'exit'); await sendRuntimeControlCommand(globalDataPath, 'stop').catch(() => runtime.kill('SIGTERM')); await exited;
    }
  }
});
