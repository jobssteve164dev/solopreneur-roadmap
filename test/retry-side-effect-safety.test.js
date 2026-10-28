const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
const { getAgentRunDeliveryOwner } = require('../out/agentRunPreparation.js');
const { saveTimePlan } = require('../out/timePlan.js');

async function fixture(prefix = 'solomap-retry-side-effects-') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataRoot = path.join(base, '.solomap-global');
  const projectRoot = path.join(base, 'project');
  fs.mkdirSync(projectRoot);
  const store = new UnifiedDataStore(dataRoot);
  const project = await store.registerProject({ root: projectRoot });
  return {
    base, dataRoot, projectRoot, project, store,
    close() {
      store.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  };
}

function growthSnapshot(projectRoot, id, createdAt, durationMs = 1) {
  return {
    snapshot: {
      id,
      projectPath: projectRoot,
      createdAt,
      gitHead: 'same-head',
      scanReason: 'roadmap_revision',
      status: 'completed',
      durationMs,
      error: ''
    },
    nodes: [{
      snapshotId: id,
      nodeId: 'directory:.',
      parentId: '',
      kind: 'directory',
      path: '.',
      label: 'Project',
      language: '',
      bytes: 42,
      loc: 7,
      fileCount: 1,
      testFileCount: 0,
      generated: false,
      excluded: false,
      primaryRole: 'root',
      confidence: 1
    }],
    edges: [],
    signals: [{
      snapshotId: id,
      nodeId: 'directory:.',
      type: 'growth',
      level: 'info',
      value: 'unchanged',
      source: 'scanner',
      sourceRef: '.',
      createdAt
    }],
    labels: [{
      snapshotId: id,
      nodeId: 'directory:.',
      label: 'Core',
      role: 'primary',
      source: 'scanner',
      confidence: 1,
      updatedAt: createdAt
    }]
  };
}

test('replaying one growth reservation returns the original generation', async () => {
  const f = await fixture();
  try {
    const first = f.store.reserveProjectGrowthRefresh(f.project.projectId, 'stable-request');
    const replay = f.store.reserveProjectGrowthRefresh(f.project.projectId, 'stable-request');
    assert.deepEqual(replay, first);
    assert.equal(f.store.readAnalysisState(f.project.projectId, 'growth-refresh', 'current').revision, first.generation);
  } finally { f.close(); }
});

test('an old growth reservation replays its receipt without replacing a newer reservation', async () => {
  const f = await fixture();
  try {
    const first = f.store.reserveProjectGrowthRefresh(f.project.projectId, 'first-request');
    const newer = f.store.reserveProjectGrowthRefresh(f.project.projectId, 'newer-request');
    assert.deepEqual(f.store.reserveProjectGrowthRefresh(f.project.projectId, 'first-request'), first);
    assert.deepEqual(f.store.readAnalysisState(f.project.projectId, 'growth-refresh', 'current').value, { requestId: 'newer-request' });
    const stale = f.store.commitProjectGrowthRefresh(f.project.projectId, {
      ...first,
      data: growthSnapshot(f.projectRoot, 'stale-snapshot', '2026-10-16T14:00:00.000Z')
    });
    assert.deepEqual(stale, { accepted: false, snapshotId: null, unchanged: false });
    assert.equal(newer.generation, first.generation + 1);
  } finally { f.close(); }
});

test('unchanged growth retries write one snapshot and return only a lightweight receipt', async () => {
  const f = await fixture();
  try {
    const firstReservation = f.store.reserveProjectGrowthRefresh(f.project.projectId, 'growth-first');
    const first = f.store.commitProjectGrowthRefresh(f.project.projectId, {
      ...firstReservation,
      data: growthSnapshot(f.projectRoot, 'snapshot-first', '2026-10-16T14:00:00.000Z', 10)
    });
    const secondReservation = f.store.reserveProjectGrowthRefresh(f.project.projectId, 'growth-retry');
    const retriedSnapshot = growthSnapshot(f.projectRoot, 'snapshot-retry', '2026-10-16T14:01:00.000Z', 99);
    retriedSnapshot.snapshot.scanReason = 'agent_continuation';
    const second = f.store.commitProjectGrowthRefresh(f.project.projectId, {
      ...secondReservation,
      data: retriedSnapshot
    });

    assert.deepEqual(first, { accepted: true, snapshotId: first.snapshotId, unchanged: false });
    assert.deepEqual(second, { accepted: true, snapshotId: first.snapshotId, unchanged: true });
    assert.equal(Object.hasOwn(first, 'latest'), false);
    assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_snapshots WHERE project_id=?', [f.project.projectId])[0].count, 1);
    assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_live_items WHERE snapshot_id=?', [first.snapshotId])[0].count, 1);
    assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_live_signals WHERE snapshot_id=?', [first.snapshotId])[0].count, 1);
    assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_live_module_labels WHERE snapshot_id=?', [first.snapshotId])[0].count, 1);
    const plan = f.store.rows('EXPLAIN QUERY PLAN SELECT id,payload_hash FROM growth_snapshots WHERE project_id=? ORDER BY rowid DESC LIMIT 1', [f.project.projectId]);
    assert.match(plan.map(row => String(row.detail)).join('\n'), /growth_snapshots_scope/);
  } finally { f.close(); }
});

test('growth history keeps lightweight totals while bounding full topology to the latest two snapshots', async () => {
  const f = await fixture();
  try {
    const storedIds = [];
    for (let index = 0; index < 3; index++) {
      const data = growthSnapshot(f.projectRoot, `snapshot-${index}`, `2026-10-16T14:0${index}:00.000Z`);
      data.nodes.push({
        snapshotId: data.snapshot.id,
        nodeId: 'file:src/index.ts',
        parentId: 'directory:.',
        kind: 'file',
        path: 'src/index.ts',
        label: `index-${index}.ts`,
        language: 'TypeScript',
        bytes: 100 + index,
        loc: 10 + index,
        fileCount: 1,
        testFileCount: 0,
        generated: false,
        excluded: false,
        primaryRole: 'source',
        confidence: 1
      });
      storedIds.push(f.store.writeProjectGrowth(f.project.projectId, data, `bounded-growth-${index}`).objectId);
    }

    assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_live_snapshots WHERE project_id=?', [f.project.projectId])[0].count, 2);
    assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_live_items WHERE project_id=?', [f.project.projectId])[0].count, 4);
    assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_items WHERE snapshot_id IN (?,?,?)', storedIds)[0].count, 0);

    const stored = f.store.readProjectGrowth(f.project.projectId, 12);
    assert.deepEqual(stored.history.map(item => item.snapshot.id), [...storedIds].reverse());
    assert.equal(stored.history[0].nodes.length, 2);
    assert.equal(stored.history[1].nodes.length, 2);
    assert.equal(stored.history[2].nodes.length, 0);
    assert.deepEqual(stored.history[2].summary, { files: 1, modules: 0, capabilities: 0, packages: 0, loc: 10, signals: 1 });
  } finally { f.close(); }
});

test('upgraded legacy growth history exposes only the latest two topologies and synthesizes older totals', async () => {
  const f = await fixture();
  try {
    const storedIds = [];
    for (let index = 0; index < 3; index++) {
      const data = growthSnapshot(f.projectRoot, `legacy-snapshot-${index}`, `2026-10-16T15:0${index}:00.000Z`);
      data.nodes.push({
        snapshotId: data.snapshot.id,
        nodeId: 'file:src/legacy.ts',
        parentId: 'directory:.',
        kind: 'file',
        path: 'src/legacy.ts',
        label: `legacy-${index}.ts`,
        language: 'TypeScript',
        bytes: 100 + index,
        loc: 20 + index,
        fileCount: 1,
        testFileCount: 0,
        generated: false,
        excluded: false,
        primaryRole: 'source',
        confidence: 1
      });
      const snapshotId = f.store.writeProjectGrowth(f.project.projectId, data, `legacy-growth-${index}`).objectId;
      storedIds.push(snapshotId);
      f.store.db.run(`INSERT INTO growth_items
        SELECT snapshot_id,item_id,parent_id,kind,relative_path,label,metrics_json,production_files,test_files,test_cases,bytes
        FROM growth_live_items WHERE snapshot_id=?`, [snapshotId]);
      f.store.db.run(`INSERT INTO growth_edges(snapshot_id,source_item_id,target_item_id,kind,weight,evidence_id,evidence)
        SELECT snapshot_id,source_item_id,target_item_id,kind,weight,NULL,evidence FROM growth_live_edges WHERE snapshot_id=?`, [snapshotId]);
      f.store.db.run(`INSERT INTO growth_signals(snapshot_id,signal_key,item_id,type,level,value,evidence_id,source,source_ref,created_at)
        SELECT snapshot_id,signal_key,item_id,type,level,value,NULL,source,source_ref,created_at FROM growth_live_signals WHERE snapshot_id=?`, [snapshotId]);
      f.store.db.run(`INSERT INTO growth_module_labels(snapshot_id,node_id,label,role,source,confidence,updated_at)
        SELECT snapshot_id,node_id,label,role,source,confidence,updated_at FROM growth_live_module_labels WHERE snapshot_id=?`, [snapshotId]);
      f.store.db.run('DELETE FROM growth_live_snapshots WHERE snapshot_id=?', [snapshotId]);
      f.store.db.run("UPDATE growth_snapshots SET summary_json='{}',semantic_hash='' WHERE id=?", [snapshotId]);
    }

    const stored = f.store.readProjectGrowth(f.project.projectId, 12);
    assert.deepEqual(stored.history.map(item => item.snapshot.id), [...storedIds].reverse());
    assert.equal(stored.history[0].nodes.length, 2);
    assert.equal(stored.history[1].nodes.length, 2);
    assert.equal(stored.history[2].nodes.length, 0);
    assert.equal(stored.history[2].topologyAvailable, false);
    assert.deepEqual(stored.history[2].summary, { files: 1, modules: 0, capabilities: 0, packages: 0, loc: 20, signals: 1 });
  } finally { f.close(); }
});

test('an unchanged growth request replays its first receipt after the project changes', async () => {
  const f = await fixture();
  try {
    const seedReservation = f.store.reserveProjectGrowthRefresh(f.project.projectId, 'seed-request');
    f.store.commitProjectGrowthRefresh(f.project.projectId, {
      ...seedReservation,
      data: growthSnapshot(f.projectRoot, 'seed-snapshot', '2026-10-16T14:00:00.000Z')
    });
    const effectReservation = f.store.reserveProjectGrowthRefresh(f.project.projectId, 'effect-request');
    const unchanged = f.store.commitProjectGrowthRefresh(f.project.projectId, {
      ...effectReservation,
      data: growthSnapshot(f.projectRoot, 'same-snapshot', '2026-10-16T14:01:00.000Z')
    });
    const changed = growthSnapshot(f.projectRoot, 'changed-snapshot', '2026-10-16T14:02:00.000Z');
    changed.nodes[0].label = 'Changed project';
    const replay = f.store.commitProjectGrowthRefresh(f.project.projectId, {
      ...f.store.reserveProjectGrowthRefresh(f.project.projectId, 'effect-request'),
      data: changed
    });
    assert.deepEqual(replay, unchanged);
    assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_snapshots WHERE project_id=?', [f.project.projectId])[0].count, 1);
  } finally { f.close(); }
});

test('replaying the same time plan does not create another database revision', async () => {
  const f = await fixture('solomap-time-plan-retry-');
  const operations = createRuntimeDataOperations(f.store);
  try {
    const plan = {
      version: 1,
      status: 'draft',
      generatedAt: '2026-10-16T14:00:00.000Z',
      request: '安排工作',
      items: [{ id: 'one', title: '完成修复', startAt: '2026-10-16T15:00:00.000Z', durationMinutes: 25, assignee: 'agent', prompt: '完成修复' }]
    };
    const call = (operation, input) => operations({ operation, input });
    await saveTimePlan(f.projectRoot, f.dataRoot, plan, call);
    const first = f.store.readAnalysisState(f.project.projectId, 'time-plan', 'current');
    await saveTimePlan(f.projectRoot, f.dataRoot, plan, call);
    const replay = f.store.readAnalysisState(f.project.projectId, 'time-plan', 'current');
    assert.equal(replay.objectId, first.objectId);
    assert.equal(replay.revision, first.revision);
  } finally {
    await operations.close();
    f.close();
  }
});

test('an older time-plan effect cannot replace a newer or confirmed plan', async () => {
  const f = await fixture('solomap-time-plan-order-');
  const operations = createRuntimeDataOperations(f.store);
  try {
    const call = (operation, input) => operations({ operation, input });
    const older = {
      version: 1, status: 'draft', generatedAt: '2026-10-16T14:00:00.000Z', request: '旧安排',
      items: [{ id: 'old', title: '旧任务', startAt: '2026-10-16T15:00:00.000Z', durationMinutes: 25, assignee: 'agent', prompt: '旧任务' }]
    };
    const newer = {
      version: 1, status: 'confirmed', generatedAt: '2026-10-16T14:05:00.000Z', confirmedAt: '2026-10-16T14:06:00.000Z', request: '新安排',
      items: [{ id: 'new', title: '新任务', startAt: '2026-10-16T16:00:00.000Z', durationMinutes: 25, assignee: 'agent', prompt: '新任务' }]
    };
    await saveTimePlan(f.projectRoot, f.dataRoot, newer, call);
    const beforeReplay = f.store.readAnalysisState(f.project.projectId, 'time-plan', 'current');
    const replay = await saveTimePlan(f.projectRoot, f.dataRoot, older, call);
    const afterReplay = f.store.readAnalysisState(f.project.projectId, 'time-plan', 'current');
    assert.equal(afterReplay.objectId, beforeReplay.objectId);
    assert.equal(afterReplay.revision, beforeReplay.revision);
    assert.equal(replay.plan.status, 'confirmed');
    assert.equal(replay.plan.request, '新安排');

    const staleDraft = { ...newer, status: 'draft' };
    delete staleDraft.confirmedAt;
    const confirmedReplay = await saveTimePlan(f.projectRoot, f.dataRoot, staleDraft, call);
    assert.equal(confirmedReplay.plan.status, 'confirmed');
    assert.equal(f.store.readAnalysisState(f.project.projectId, 'time-plan', 'current').revision, beforeReplay.revision);
  } finally {
    await operations.close();
    f.close();
  }
});

test('growth and time-plan work are durable post-settlement effects', async () => {
  const f = await fixture('solomap-settlement-side-effects-');
  const operations = createRuntimeDataOperations(f.store);
  const call = (operation, input) => operations({ operation, input });
  try {
    const run = await call('prepare_run', {
      root: f.projectRoot,
      executionLogId: 1,
      nodeId: '__solo__',
      runKind: 'solo',
      prompt: '生成时间安排',
      command: 'codex',
      userMessage: '生成时间安排',
      metadata: { interactiveSession: true },
      idempotencyKey: 'side-effect-run'
    });
    const done = await call('checkpoint_run', {
      projectId: run.projectId,
      executionLogId: 1,
      generation: run.generation,
      proof: run.proof,
      expectedRevision: run.revision,
      expectedTurnId: run.turnId,
      action: 'complete',
      outcome: 'partial',
      summary: '完成',
      idempotencyKey: 'side-effect-checkpoint'
    });
    const owner = await getAgentRunDeliveryOwner();
    const lease = await call('claim_run_consumer', {
      projectId: run.projectId,
      executionLogId: 1,
      generation: done.generation,
      expectedRevision: done.revision,
      expectedTurnId: done.turnId,
      owner
    });
    const effects = [{
      kind: 'refresh',
      payload: { workspaceRoot: f.projectRoot, captureGrowth: true, growthScanReason: 'solo', timePlan: { version: 1 } }
    }];
    const settlement = {
      projectId: run.projectId,
      executionLogId: 1,
      generation: done.generation,
      expectedRevision: done.revision,
      expectedTurnId: done.turnId,
      token: lease.token,
      journal: { agentCli: 'codex', command: 'codex', output: '完成', status: 'In Progress' },
      digest: { schemaVersion: 2, runId: '__solo__:1', nodeId: '__solo__', executionLogId: 1 },
      effects,
      idempotencyKey: 'side-effect-settlement'
    };
    await call('commit_run_settlement', settlement);
    await call('commit_run_settlement', settlement);
    const pending = await call('list_run_effects', { projectId: run.projectId });
    assert.deepEqual(pending.items.map(item => item.kind), ['refresh']);
    const effect = await call('claim_run_effect', { projectId: run.projectId, effectId: pending.items[0].effectId, owner });
    assert.equal(effect.payload.captureGrowth, true);
    assert.equal(effect.payload.growthScanReason, 'solo');
    assert.deepEqual(effect.payload.timePlan, { version: 1 });
  } finally {
    await operations.close();
    f.close();
  }
});

test('the status consumer queues mutable auxiliary work instead of running it before settlement', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const consumer = source.slice(source.indexOf('async function processAgentStatusFile('), source.indexOf('async function applyRunSettlementEffect('));
  assert.doesNotMatch(consumer, /await refreshProjectGrowthSnapshot\(/);
  assert.doesNotMatch(consumer, /await saveTimePlan\(/);
  assert.match(consumer, /captureGrowth:/);
  assert.match(consumer, /timePlan:/);
  const effects = source.slice(source.indexOf('async function applyRunSettlementEffect('), source.indexOf('const activeRunEffectPolls'));
  assert.match(effects, /effect\.payload\.captureGrowth === true/);
  assert.match(effects, /shouldCommit:/);
  assert.match(effects, /could not capture the post-run growth snapshot/);
  assert.match(effects, /effect\.kind === 'refresh' && effect\.payload\.timePlan/);
  const growthSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'projectGrowth.ts'), 'utf8');
  const capture = growthSource.slice(growthSource.indexOf('export async function captureProjectGrowthSnapshot('), growthSource.indexOf('export async function getProjectGrowthView('));
  assert.match(capture, /options\.shouldCommit\?\.\(\) === false/);
  assert.ok(capture.lastIndexOf('options.shouldCommit?.() === false') > capture.indexOf('await finalizeProjectGrowthSnapshot('));
});
