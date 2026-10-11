const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');
const analytics = require('../out/projectAnalytics.js');

async function fixture(action) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-investment-authority-'));
  const workspace = path.join(base, 'project'); fs.mkdirSync(workspace);
  const root = path.join(base, '.solomap-global');
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'investment-test-owner', onCommand: () => ({ status: 'running' }), onData: ops });
  const project = (await ops({ operation: 'register_project', input: { root: workspace } })).projectId;
  const now = new Date('2026-10-09T12:00:00Z');
  const record = (id, durationMs, status = 'Completed') => ({ executionLogId: id, nodeId: '__solo__', runKind: 'solo', agentCli: 'codex', status, startedAt: '2026-10-09T10:00:00Z', finishedAt: new Date(Date.parse('2026-10-09T10:00:00Z') + durationMs).toISOString(), durationMs, outputPath: '', outputBytes: 0, outputTail: '', commandPath: '', promptPath: '', changesPath: '', touchedFilesPath: '', updatedAt: '2026-10-09T11:00:00Z' });
  const read = () => analytics.readProjectInvestmentStatsFromDatabase(workspace, path.resolve(__dirname, '..'), now, root);
  let closed = false;
  const closeServer = async () => { if (!closed) { await server.close(); closed = true; } };
  try { await action({ base, workspace, root, project, store, ops, closeServer, record, read }); }
  finally { await closeServer(); await ops.close(); store.close(); }
}

test('an empty authoritative investment result does not revive a conflicting legacy digest', () => fixture(async ({ workspace, read }) => {
  const folder = path.join(workspace, '.solopreneur', 'run-digests'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'old.json'), JSON.stringify({ schemaVersion: 2, runId: 'old', runKind: 'solo', status: 'Failed', startedAt: '2026-10-09T09:00:00Z', finishedAt: '2026-10-09T09:30:00Z', durationMs: 1800000 }));
  const result = await read();
  assert.equal(result.soloConversationCount, 0);
  assert.equal(result.failedRunCount, 0);
  assert.equal(result.totalDurationMs, 0);
  assert.equal(fs.existsSync(path.join(workspace, '.solopreneur', 'project_journal.db')), false);
}));

test('investment immediately reflects committed same-id updates and new runs without main-file cache invalidation', () => fixture(async ({ project, store, record, read, root }) => {
  store.upsertProjectRunIndex(project, record(1, 600000));
  const first = await read();
  assert.equal(first.soloConversationCount, 1); assert.equal(first.totalDurationMs, 600000);
  const mainStat = fs.statSync(path.join(root, 'solomap.db'));
  store.upsertProjectRunIndex(project, record(1, 1200000, 'Failed'));
  store.upsertProjectRunIndex(project, record(2, 300000));
  const updated = await read();
  assert.equal(updated.soloConversationCount, 2);
  assert.equal(updated.totalDurationMs, 1500000);
  assert.equal(updated.failedRunCount, 1);
  assert.equal(updated.completedRunCount, 1);
  assert.equal(updated.workHabits.observedSessionCount, 2);
  assert.equal(fs.statSync(path.join(root, 'solomap.db')).mtimeMs, mainStat.mtimeMs, 'the test changes WAL-backed state without a main-file signature change');
}));

test('an unavailable owner surfaces a read failure instead of returning an old investment result', () => fixture(async ({ workspace, closeServer, read }) => {
  const folder = path.join(workspace, '.solopreneur', 'run-digests'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'stale.json'), JSON.stringify({ schemaVersion: 2, runId: 'stale', runKind: 'solo', status: 'Completed', startedAt: '2026-10-09T09:00:00Z', finishedAt: '2026-10-09T09:30:00Z', durationMs: 1800000 }));
  await closeServer();
  await assert.rejects(read());
}));

test('investment source projection retains every session and excludes unrelated report bodies', () => fixture(async ({ workspace, project, ops, store, record }) => {
  for (let id = 1; id <= 503; id++) store.upsertProjectRunIndex(project, { ...record(id, 600000), outputTail: 'private output '.repeat(1000) }, [{ filePath: 'private-file', role: 'changed' }], [{ type: 'verification', value: 'private-check' }]);
  const otherRoot = path.join(workspace, 'other-project'); fs.mkdirSync(otherRoot);
  const other = (await ops({ operation: 'register_project', input: { root: otherRoot } })).projectId;
  store.upsertProjectRunIndex(other, record(1, 900000));
  const result = await ops({ operation: 'read_project_investment_runs', input: { root: workspace } });
  assert.equal(result.length, 503);
  assert.equal(result.reduce((n, run) => n + run.durationMs, 0), 301800000);
  assert.ok(result.every(run => run.runKind === 'solo' && run.status === 'Completed'));
  assert.doesNotMatch(JSON.stringify(result), /private output|private-file|private-check|outputTail|files|signals/);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 100000);
  assert.equal(store.readProjectRunIndexes(project)[0].outputTail, 'private output '.repeat(1000), 'complete evidence remains retained for its own consumers');
}));
