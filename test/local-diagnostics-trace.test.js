const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
function operationFile(globalRoot) {
  const directory = path.join(globalRoot, 'diagnostics', new Date().toISOString().slice(0, 10));
  return path.join(directory, fs.readdirSync(directory).find(name => /^recent-operations\.\d+-[a-f0-9]{8}\.json$/.test(name)));
}

test('diagnostic trace follows async stages and stores timings without message or chat identity', async t => {
  const diagnostics = require('../out/localDiagnostics.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-trace-'));
  const globalRoot = path.join(root, '.solomap-global');
  t.after(() => {
    fs.unlinkSync(operationFile(globalRoot));
    fs.rmdirSync(path.join(globalRoot, 'diagnostics', new Date().toISOString().slice(0, 10)));
    fs.rmdirSync(path.join(globalRoot, 'diagnostics'));
    fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  });
  const secret = '123456789:telegram-secret';
  const trace = diagnostics.createLocalDiagnosticTrace(globalRoot, 'telegram.chat');
  await diagnostics.withLocalDiagnosticTrace(trace, async () => {
    await diagnostics.observeLocalDiagnosticStage('model.cli', async () => {
      await new Promise(resolve => setImmediate(resolve));
      return 'answer';
    });
    diagnostics.recordCurrentDiagnosticStage('telegram.send', 'error', 18, new Error(`send failed for /bot${secret}/sendMessage`));
    await assert.rejects(() => diagnostics.observeLocalDiagnosticStage('model.cli', async () => {
      throw new Error('model failed while reading private prompt content');
    }), /private prompt content/);
  });
  const entries = JSON.parse(fs.readFileSync(operationFile(globalRoot), 'utf8')).entries;
  assert.equal(fs.statSync(operationFile(globalRoot)).mode & 0o777, 0o600);
  assert.deepEqual(entries.map(entry => entry.stage), ['telegram.chat', 'model.cli', 'model.cli', 'telegram.send', 'model.cli', 'model.cli']);
  assert.deepEqual(entries.map(entry => entry.status), ['start', 'start', 'ok', 'error', 'start', 'error']);
  assert.equal(new Set(entries.map(entry => entry.traceId)).size, 1);
  assert.ok(entries.every(entry => Number.isInteger(entry.durationMs) && entry.durationMs >= 0));
  assert.doesNotMatch(JSON.stringify(entries), /telegram-secret|123456789|sendMessage|private prompt content/);
  const summary = diagnostics.buildLocalDiagnosticSummary({ extensionMode: 1 }, globalRoot, { appName: 'Code' });
  assert.match(summary, /Recent operation events:/);
  assert.match(summary, /model\.cli/);
});

test('diagnostic stages retain actionable failure codes without arbitrary project text or credentials', t => {
  const diagnostics = require('../out/localDiagnostics.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-trace-private-'));
  const globalRoot = path.join(root, '.solomap-global');
  t.after(() => {
    fs.unlinkSync(operationFile(globalRoot));
    fs.rmdirSync(path.join(globalRoot, 'diagnostics', new Date().toISOString().slice(0, 10)));
    fs.rmdirSync(path.join(globalRoot, 'diagnostics'));
    fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  });
  const trace = diagnostics.createLocalDiagnosticTrace(globalRoot, 'runtime.reconcile');
  trace.record('mcp.connect', 'error', 1, new Error('MCP failed for project Alpha API_KEY=abc123'));
  trace.record('runtime.service', 'error', 2, new Error('Failed to connect to user scope bus via local transport: No such file or directory'));
  trace.record('model.cli', 'error', 3, new Error('Local Agent CLI cognitive call failed (1): authentication failed for project Alpha API_KEY=abc123'));
  trace.record('telegram.send', 'error', 4, new Error('Telegram sendMessage failed with HTTP 429: project Alpha API_KEY=abc123'));
  const summary = diagnostics.buildLocalDiagnosticSummary({ extensionMode: 1 }, globalRoot, { appName: 'Code' });
  assert.doesNotMatch(summary, /project Alpha|abc123|API_KEY/);
  assert.match(summary, /user_systemd_bus_unavailable/);
  assert.match(summary, /authentication_failed/);
  assert.match(summary, /telegram_http_429/);
});

test('concurrent background process errors are retained in separate process stores', async t => {
  const diagnostics = require('../out/localDiagnostics.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-trace-processes-'));
  const globalRoot = path.join(root, '.solomap-global');
  const directory = path.join(globalRoot, 'diagnostics', new Date().toISOString().slice(0, 10));
  const childScript = `require(${JSON.stringify(path.resolve(__dirname, '../out/localDiagnostics.js'))}).recordLocalDiagnosticError(${JSON.stringify(globalRoot)}, 'runtime.child', 'child_failure')`;
  diagnostics.recordLocalDiagnosticError(globalRoot, 'runtime.parent', 'parent_failure');
  childProcess.execFileSync(process.execPath, ['-e', childScript]);
  const concurrentScript = `const d=require(${JSON.stringify(path.resolve(__dirname, '../out/localDiagnostics.js'))}); for(let i=0;i<10;i++)d.recordLocalDiagnosticError(${JSON.stringify(globalRoot)}, 'runtime.concurrent', String(process.pid)+'-'+i)`;
  await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    childProcess.execFile(process.execPath, ['-e', concurrentScript], error => error ? reject(error) : resolve());
  })));
  t.after(() => {
    fs.unlinkSync(path.join(directory, files[0]));
    fs.unlinkSync(path.join(directory, files[1]));
    fs.unlinkSync(path.join(directory, files[2]));
    fs.unlinkSync(path.join(directory, files[3]));
    fs.unlinkSync(path.join(directory, files[4]));
    fs.unlinkSync(path.join(directory, files[5]));
    fs.rmdirSync(directory);
    fs.rmdirSync(path.join(globalRoot, 'diagnostics'));
    fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  });
  const files = fs.readdirSync(directory).filter(name => /^recent-errors\.\d+-[a-f0-9]{8}\.json$/.test(name));
  assert.equal(files.length, 6);
  const entries = files.flatMap(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')).entries);
  assert.equal(entries.length, 42);
  assert.ok(entries.some(entry => entry.scope === 'runtime.parent' && entry.message === 'parent_failure'));
  assert.ok(entries.some(entry => entry.scope === 'runtime.child' && entry.message === 'child_failure'));
});

test('older diagnostic files remain untouched while the summary reads recent days', t => {
  const diagnostics = require('../out/localDiagnostics.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-trace-archive-'));
  const globalRoot = path.join(root, '.solomap-global');
  const diagnosticsRoot = path.join(globalRoot, 'diagnostics');
  const oldDay = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const oldDirectory = path.join(diagnosticsRoot, oldDay);
  const currentDirectory = path.join(diagnosticsRoot, today);
  const oldFile = path.join(oldDirectory, 'recent-errors.99999999-deadbeef.json');
  fs.mkdirSync(oldDirectory, { recursive: true });
  fs.writeFileSync(oldFile, JSON.stringify({ schemaVersion: 1, entries: [{ at: new Date(Date.now() - 30 * 86_400_000).toISOString(), scope: 'old.failure', fingerprint: 'old', message: 'old_failure' }] }));
  diagnostics.recordLocalDiagnosticError(globalRoot, 'new.failure', 'new_failure');
  const newFile = path.join(currentDirectory, fs.readdirSync(currentDirectory).find(name => /^recent-errors\.\d+-[a-f0-9]{8}\.json$/.test(name)));
  t.after(() => {
    fs.unlinkSync(newFile);
    fs.unlinkSync(oldFile);
    fs.rmdirSync(currentDirectory);
    fs.rmdirSync(oldDirectory);
    fs.rmdirSync(diagnosticsRoot);
    fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  });
  assert.equal(fs.existsSync(oldFile), true);
  const summary = diagnostics.buildLocalDiagnosticSummary({ extensionMode: 1 }, globalRoot, { appName: 'Code' });
  assert.match(summary, /new_failure/);
  assert.doesNotMatch(summary, /old_failure/);
});
