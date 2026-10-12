const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('runtime handoff failures retain their diagnostic categories', () => {
  const diagnostics = require('../out/localDiagnostics.js');
  assert.equal(diagnostics.classifyDiagnosticFailure(new Error('different_runtime_build')), 'different_runtime_build');
  assert.equal(diagnostics.classifyDiagnosticFailure(new Error('runtime_drain_timeout')), 'runtime_drain_timeout');
});
test('diagnostic trace follows async stages through the database sink without writing JSON', async t => {
  const diagnostics = require('../out/localDiagnostics.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-trace-'));
  const globalRoot = path.join(root, '.solomap-global');
  const entries = [];
  diagnostics.configureLocalDiagnosticPersistence({ append: (_root, event) => { entries.push(event); } }, globalRoot);
  t.after(() => { diagnostics.configureLocalDiagnosticPersistence(undefined); fs.rmdirSync(root); });
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
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(entries.map(entry => entry.scope), ['telegram.chat', 'model.cli', 'model.cli', 'telegram.send', 'model.cli', 'model.cli']);
  assert.deepEqual(entries.map(entry => entry.payload.status), ['start', 'start', 'ok', 'error', 'start', 'error']);
  assert.equal(new Set(entries.map(entry => entry.payload.traceId)).size, 1);
  assert.ok(entries.every(entry => Number.isInteger(entry.payload.durationMs) && entry.payload.durationMs >= 0));
  assert.doesNotMatch(JSON.stringify(entries), /telegram-secret|123456789|sendMessage|private prompt content/);
  assert.equal(fs.existsSync(path.join(globalRoot, 'diagnostics')), false);
  const summary = await diagnostics.buildLocalDiagnosticSummary({ extensionMode: 1 }, globalRoot, { appName: 'Code' });
  assert.match(summary, /Recent operation events:/);
  assert.match(summary, /model\.cli/);
});

test('diagnostic stages retain actionable failure codes without arbitrary project text or credentials', async t => {
  const diagnostics = require('../out/localDiagnostics.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-trace-private-'));
  const globalRoot = path.join(root, '.solomap-global');
  diagnostics.configureLocalDiagnosticPersistence({ append() {} }, globalRoot);
  t.after(() => { diagnostics.configureLocalDiagnosticPersistence(undefined); fs.rmdirSync(root); });
  const trace = diagnostics.createLocalDiagnosticTrace(globalRoot, 'runtime.reconcile');
  trace.record('mcp.connect', 'error', 1, new Error('MCP failed for project Alpha API_KEY=abc123'));
  trace.record('runtime.service', 'error', 2, new Error('Failed to connect to user scope bus via local transport: No such file or directory'));
  trace.record('model.cli', 'error', 3, new Error('Local Agent CLI cognitive call failed (1): authentication failed for project Alpha API_KEY=abc123'));
  trace.record('telegram.send', 'error', 4, new Error('Telegram sendMessage failed with HTTP 429: project Alpha API_KEY=abc123'));
  const summary = await diagnostics.buildLocalDiagnosticSummary({ extensionMode: 1 }, globalRoot, { appName: 'Code' });
  assert.doesNotMatch(summary, /project Alpha|abc123|API_KEY/);
  assert.match(summary, /user_systemd_bus_unavailable/);
  assert.match(summary, /authentication_failed/);
  assert.match(summary, /telegram_http_429/);
});

test('legacy diagnostic JSON is imported explicitly and left untouched', async t => {
  const diagnostics = require('../out/localDiagnostics.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-trace-import-'));
  const globalRoot = path.join(root, '.solomap-global');
  const directory = path.join(globalRoot, 'diagnostics', new Date().toISOString().slice(0, 10));
  const legacy = path.join(directory, 'recent-errors.99999999-deadbeef.json');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ schemaVersion: 1, entries: [{ at: new Date().toISOString(), scope: 'legacy.failure', fingerprint: 'legacy', message: 'legacy_failure' }] }));
  const events = []; const captures = [];
  const imported = await diagnostics.importLegacyLocalDiagnostics(globalRoot, event => { events.push(event); }, (source, bytes) => captures.push({ source, bytes }));
  t.after(() => {
    fs.unlinkSync(legacy);
    fs.rmdirSync(directory);
    fs.rmdirSync(path.join(globalRoot, 'diagnostics'));
    fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  });
  assert.deepEqual(imported, { files: 1, events: 1 });
  assert.equal(events[0].payload.message, 'legacy_failure');
  assert.equal(captures[0].bytes.toString(), fs.readFileSync(legacy, 'utf8'));
  assert.equal(fs.existsSync(legacy), true);
});

test('a legacy diagnostic file created after the first scan is imported on the next startup scan', async t => {
  const diagnostics = require('../out/localDiagnostics.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-trace-late-import-'));
  const globalRoot = path.join(root, '.solomap-global');
  const directory = path.join(globalRoot, 'diagnostics', new Date().toISOString().slice(0, 10));
  const legacy = path.join(directory, 'recent-operations.99999999-deadbeef.json');
  const events = [];
  assert.deepEqual(await diagnostics.importLegacyLocalDiagnostics(globalRoot, event => events.push(event), () => {}), { files: 0, events: 0 });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ entries: [{ at: new Date().toISOString(), traceId: 'late-trace', stage: 'runtime.start', status: 'ok', durationMs: 3 }] }));
  assert.deepEqual(await diagnostics.importLegacyLocalDiagnostics(globalRoot, event => events.push(event), () => {}), { files: 1, events: 1 });
  assert.equal(events[0].payload.traceId, 'late-trace');
  t.after(() => {
    fs.unlinkSync(legacy); fs.rmdirSync(directory); fs.rmdirSync(path.join(globalRoot, 'diagnostics')); fs.rmdirSync(globalRoot); fs.rmdirSync(root);
  });
});

test('ordinary summary ignores legacy JSON and reads only the configured database sink cache', async t => {
  const diagnostics = require('../out/localDiagnostics.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-trace-archive-'));
  const globalRoot = path.join(root, '.solomap-global');
  const diagnosticsRoot = path.join(globalRoot, 'diagnostics');
  const directory = path.join(diagnosticsRoot, new Date().toISOString().slice(0, 10));
  const oldFile = path.join(directory, 'recent-errors.99999999-deadbeef.json');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(oldFile, JSON.stringify({ schemaVersion: 1, entries: [{ at: new Date().toISOString(), scope: 'old.failure', fingerprint: 'old', message: 'old_failure' }] }));
  diagnostics.configureLocalDiagnosticPersistence({ append() {} }, globalRoot);
  diagnostics.recordLocalDiagnosticError(globalRoot, 'new.failure', 'new_failure');
  t.after(() => {
    diagnostics.configureLocalDiagnosticPersistence(undefined);
    fs.unlinkSync(oldFile);
    fs.rmdirSync(directory);
    fs.rmdirSync(diagnosticsRoot);
    fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  });
  assert.equal(fs.existsSync(oldFile), true);
  const summary = await diagnostics.buildLocalDiagnosticSummary({ extensionMode: 1 }, globalRoot, { appName: 'Code' });
  assert.match(summary, /new_failure/);
  assert.doesNotMatch(summary, /old_failure/);
});

test('the first summary after restart waits for persisted database diagnostics', async t => {
  const diagnostics = require('../out/localDiagnostics.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-trace-first-summary-'));
  const globalRoot = path.join(root, '.solomap-global');
  diagnostics.configureLocalDiagnosticPersistence({
    append() {},
    async read() {
      await new Promise(resolve => setImmediate(resolve));
      return { items: [{ kind: 'error', occurredAt: '2026-10-11T00:00:00.000Z', scope: 'runtime.restart', payload: { fingerprint: 'persisted', message: 'persisted_failure' } }] };
    }
  }, globalRoot);
  t.after(() => { diagnostics.configureLocalDiagnosticPersistence(undefined); fs.rmdirSync(root); });
  const summary = await diagnostics.buildLocalDiagnosticSummary({ extensionMode: 1 }, globalRoot, { appName: 'Code' });
  assert.match(summary, /runtime\.restart/);
  assert.match(summary, /persisted_failure/);
});
