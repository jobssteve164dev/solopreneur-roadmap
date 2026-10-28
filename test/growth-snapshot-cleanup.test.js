const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');

async function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-growth-cleanup-'));
  const root = path.join(base, '.solomap-global');
  const projectRoot = path.join(base, 'project');
  fs.mkdirSync(projectRoot);
  const store = new UnifiedDataStore(root);
  const operations = createRuntimeDataOperations(store);
  const project = await store.registerProject({ root: projectRoot });
  t.after(async () => { await operations.close(); store.close(); });
  return { root, projectRoot, projectId: project.projectId, store, call: (operation, input) => operations({ operation, input }) };
}

function snapshot(projectRoot, id, state, minute) {
  const createdAt = `2026-10-16T12:${String(minute).padStart(2, '0')}:00.000Z`;
  return {
    snapshot: { id, projectPath: projectRoot, createdAt, gitHead: 'abc123', scanReason: `retry-${minute}`, status: 'completed', durationMs: minute + 1, error: '' },
    nodes: [
      { snapshotId: id, nodeId: 'directory:.', parentId: '', kind: 'directory', path: '.', label: state, language: '', bytes: 10, loc: 2, fileCount: 1, testFileCount: 0, generated: false, excluded: false, primaryRole: 'root', confidence: 1 },
      { snapshotId: id, nodeId: 'file:index.js', parentId: 'directory:.', kind: 'file', path: 'index.js', label: `${state}.js`, language: 'JavaScript', bytes: 10, loc: 2, fileCount: 1, testFileCount: 0, generated: false, excluded: false, primaryRole: 'source', confidence: 1 }
    ],
    edges: [{ snapshotId: id, sourceId: 'directory:.', targetId: 'file:index.js', kind: 'contains', weight: 1, evidence: state }],
    signals: [{ snapshotId: id, nodeId: 'file:index.js', type: 'state', level: 'info', value: state, source: 'test', sourceRef: state, createdAt }],
    labels: [{ snapshotId: id, nodeId: 'file:index.js', label: state, role: 'source', source: 'test', confidence: 1, updatedAt: createdAt }]
  };
}

async function writeHistory(f, states) {
  const ids = [];
  for (const [index, state] of states.entries()) {
    const id = `${state.toLowerCase()}-${index + 1}`;
    ids.push(f.store.writeProjectGrowth(f.projectId, snapshot(f.projectRoot, id, state, index), `growth-${index + 1}`).objectId);
  }
  return ids;
}

function fullManifest(f, preview) {
  return f.store.readGrowthSnapshotCleanupPlan(preview.planId).manifest;
}

test('cleanup preview freezes an immutable exact A-A-B-A-A segment manifest', async t => {
  const f = await fixture(t);
  const ids = await writeHistory(f, ['A', 'A', 'B', 'A', 'A']);

  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-segments' });
  const manifest = fullManifest(f, preview);

  assert.equal(preview.status, 'prepared');
  assert.match(preview.planId, /^[a-f0-9-]{36}$/);
  assert.match(preview.planHash, /^[a-f0-9]{64}$/);
  assert.equal(preview.manifest.title, '待删除数据库记录清单');
  assert.equal(preview.manifest.database.databaseId, f.store.databaseId);
  assert.equal(preview.manifest.database.snapshotCount, 5);
  assert.equal(preview.manifest.retainedSnapshots.count, 3);
  assert.equal(preview.manifest.candidateSnapshots.count, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) < 10_000);
  assert.deepEqual(manifest.retainedSnapshots.map(item => item.snapshotId), [ids[1], ids[2], ids[4]]);
  assert.deepEqual(manifest.candidateSnapshots.map(item => item.snapshotId), [ids[0], ids[3]]);
  assert.deepEqual(manifest.candidateSnapshots.map(item => item.retainedSnapshotId), [ids[1], ids[4]]);
  assert.equal(preview.manifest.records.growthSnapshots.count, 2);
  assert.equal(preview.manifest.records.growthItems.count, 2);
  assert.equal(preview.manifest.records.growthEdges.count, 1);
  assert.equal(preview.manifest.records.growthSignals.count, 1);
  assert.equal(preview.manifest.records.growthModuleLabels.count, 1);
  assert.equal(preview.manifest.records.objects.count, 2);
  assert.equal(preview.manifest.records.objectSearch.count, 2);
  assert.equal(manifest.records.objectSearch.rowids.length, 2);
  assert.equal(preview.manifest.records.objectRevisions.count, 2);
  assert.equal(preview.manifest.records.events.count, 2);
  assert.equal(preview.manifest.records.requests.count, 2);
  assert.equal(preview.manifest.records.contents.candidateCount, 4);
  assert.equal(preview.manifest.records.contents.deletableCount, 0);
  assert.equal(preview.manifest.records.contentChunks.count, 0);
  assert.equal(preview.manifest.records.databaseStorageCleanupCandidates.count, 0);
  assert.deepEqual(await f.call('read_growth_snapshot_cleanup_plan', { planId: preview.planId }), preview);
  assert.deepEqual(await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-segments' }), preview);
  const firstPage = await f.call('read_growth_snapshot_cleanup_manifest_page', {
    planId: preview.planId, section: 'candidateSnapshots', cursor: 0, limit: 1
  });
  const secondPage = await f.call('read_growth_snapshot_cleanup_manifest_page', {
    planId: preview.planId, section: 'candidateSnapshots', cursor: firstPage.nextCursor, limit: 1
  });
  assert.deepEqual([...firstPage.items, ...secondPage.items], manifest.candidateSnapshots);
  assert.equal(firstPage.total, 2);
  assert.equal(secondPage.nextCursor, null);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_snapshots')[0].count, 5, 'preview must not delete snapshots');
});

test('cleanup apply requires the exact confirmation and rejects a drifted snapshot boundary', async t => {
  const f = await fixture(t);
  await writeHistory(f, ['A', 'A', 'B']);
  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-drift' });

  await assert.rejects(f.call('apply_growth_snapshot_cleanup', {
    planId: preview.planId, planHash: preview.planHash, confirmation: 'confirm', idempotencyKey: 'apply-drift'
  }), /growth_cleanup_confirmation_required/);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_snapshots')[0].count, 3);

  f.store.writeProjectGrowth(f.projectId, snapshot(f.projectRoot, 'c-4', 'C', 4), 'growth-drift');
  await assert.rejects(f.call('apply_growth_snapshot_cleanup', {
    planId: preview.planId, planHash: preview.planHash, confirmation: '确认删除该清单记录', idempotencyKey: 'apply-drift'
  }), /growth_cleanup_plan_invalidated/);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_snapshots')[0].count, 4);
  assert.equal((await f.call('read_growth_snapshot_cleanup_plan', { planId: preview.planId })).status, 'invalidated');
});

test('confirmed cleanup applies in idempotent batches and preserves A-B-A with valid foreign keys', async t => {
  const f = await fixture(t);
  const ids = await writeHistory(f, ['A', 'A', 'B', 'A', 'A']);
  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-apply' });
  const manifest = fullManifest(f, preview);
  const input = {
    planId: preview.planId,
    planHash: preview.planHash,
    confirmation: '确认删除该清单记录',
    idempotencyKey: 'apply-segments',
    batchSize: 1
  };

  const applied = await f.call('apply_growth_snapshot_cleanup', input);

  assert.equal(applied.status, 'applied');
  assert.equal(applied.planId, preview.planId);
  assert.equal(applied.planHash, preview.planHash);
  assert.equal(applied.batches.length, 2);
  assert.deepEqual(applied.deleted, {
    growthSnapshots: 2, growthItems: 2, growthEdges: 1, growthSignals: 1, growthModuleLabels: 1,
    objects: 2, objectSearch: 2, objectRevisions: 2, events: 2, outbox: 0, requests: 2,
    contentChunks: 0, databaseStorageCleanupCandidates: 0, contents: 0
  });
  assert.deepEqual((await f.call('read_project_growth', { root: f.projectRoot, historyLimit: 50 })).history.map(item => item.snapshot.id), [ids[4], ids[2], ids[1]]);
  assert.deepEqual(f.store.rows('PRAGMA foreign_key_check'), []);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM object_search WHERE rowid IN (?,?)', manifest.records.objectSearch.rowids)[0].count, 0);
  assert.deepEqual(await f.call('apply_growth_snapshot_cleanup', input), applied);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_snapshot_cleanup_batches WHERE plan_id=?', [preview.planId])[0].count, 2);
});

test('snapshot cleanup leaves directly referenced content to separate garbage collection', async t => {
  const f = await fixture(t);
  const ids = await writeHistory(f, ['A', 'A']);
  const revision = f.store.rows('SELECT content_id FROM object_revisions WHERE object_id=?', [ids[0]])[0];
  const content = f.store.rows('SELECT sha256,mime_type FROM contents WHERE id=?', [revision.content_id])[0];
  f.store.db.run(`INSERT INTO project_run_artifacts
    (project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at,artifact_kind)
    VALUES(?,?,?,?,?,?,?,'retained')`, [f.projectId, 999, 'retained-growth-content.json', revision.content_id, content.sha256, content.mime_type, Date.now()]);

  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-shared-content' });
  const manifest = fullManifest(f, preview);

  assert.deepEqual(manifest.candidateSnapshots.map(item => item.snapshotId), [ids[0]]);
  assert.ok(manifest.records.contents.retainedSharedIds.includes(revision.content_id));
  assert.ok(!manifest.records.contents.deletableIds.includes(revision.content_id));
  const applied = await f.call('apply_growth_snapshot_cleanup', {
    planId: preview.planId,
    planHash: preview.planHash,
    confirmation: '确认删除该清单记录',
    idempotencyKey: 'apply-shared-content'
  });
  assert.equal(applied.deleted.contents, manifest.records.contents.deletableIds.length);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM contents WHERE id=?', [revision.content_id])[0].count, 1);
  assert.equal(f.store.rows("SELECT COUNT(*) AS count FROM project_run_artifacts WHERE relative_path='retained-growth-content.json'")[0].count, 1);
  assert.deepEqual(f.store.rows('PRAGMA foreign_key_check'), []);
});

test('snapshot cleanup leaves content referenced from retained JSON untouched', async t => {
  const f = await fixture(t);
  const ids = await writeHistory(f, ['A', 'A']);
  const revision = f.store.rows('SELECT content_id FROM object_revisions WHERE object_id=?', [ids[0]])[0];
  f.store.write({
    kind: 'review_batch', action: 'create', scope: null, idempotencyKey: 'embedded-growth-reference',
    data: { input_cursor: 0, input_hash: 'a'.repeat(64), proposal_content: null,
      review_content: JSON.stringify({ sourceContents: { candidate: revision.content_id } }), status: 'interrupted' }
  });

  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-embedded-content' });
  const manifest = fullManifest(f, preview);

  assert.ok(manifest.records.contents.retainedSharedIds.includes(revision.content_id));
  assert.ok(!manifest.records.contents.deletableIds.includes(revision.content_id));
  const applied = await f.call('apply_growth_snapshot_cleanup', {
    planId: preview.planId,
    planHash: preview.planHash,
    confirmation: '确认删除该清单记录',
    idempotencyKey: 'apply-embedded-content'
  });
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM contents WHERE id=?', [revision.content_id])[0].count, 1);
  assert.equal(applied.deleted.contents, manifest.records.contents.deletableIds.length);
});

test('snapshot cleanup does not depend on scanning arbitrary live JSON roots', async t => {
  const f = await fixture(t);
  const ids = await writeHistory(f, ['A', 'A']);
  const revision = f.store.rows('SELECT content_id FROM object_revisions WHERE object_id=?', [ids[0]])[0];
  const rootContentId = f.store.putContent('{unrelated invalid json', 'application/json');
  const actor = f.store.rows('SELECT actor_id FROM requests ORDER BY rowid LIMIT 1')[0];
  f.store.db.run("INSERT INTO requests(actor_id,idempotency_key,id,input_hash,result_content_id,status) VALUES(?,?,?,?,?,'committed')",
    [actor.actor_id, 'external-embedded-root', 'external-embedded-root', 'b'.repeat(64), rootContentId]);

  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-all-embedded-roots' });
  const manifest = fullManifest(f, preview);

  assert.ok(manifest.records.contents.retainedSharedIds.includes(revision.content_id));
  assert.ok(!manifest.records.contents.deletableIds.includes(revision.content_id));
});

test('cleanup derives a semantic index when legacy payload hashes differ for equal details', async t => {
  const f = await fixture(t);
  const ids = await writeHistory(f, ['A', 'A']);
  f.store.db.run('UPDATE growth_snapshots SET payload_hash=? WHERE id=?', ['1'.repeat(64), ids[0]]);
  f.store.db.run('UPDATE growth_snapshots SET payload_hash=? WHERE id=?', ['2'.repeat(64), ids[1]]);
  f.store.readProjectGrowth = () => { throw new Error('snapshot detail should not be reread'); };
  const originalRows = f.store.rows.bind(f.store);
  f.store.rows = (sql, values) => {
    if (/SELECT .* FROM growth_(?:items|edges|signals|module_labels)\s+WHERE snapshot_id=/s.test(String(sql))) {
      throw new Error('snapshot details must be streamed instead of materialized');
    }
    return originalRows(sql, values);
  };

  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-bounded-roots' });
  const manifest = fullManifest(f, preview);
  f.store.rows = originalRows;

  assert.deepEqual(manifest.candidateSnapshots.map(item => item.snapshotId), [ids[0]]);
  assert.equal(manifest.candidateSnapshots[0].semanticFingerprint, manifest.retainedSnapshots[0].semanticFingerprint);
  assert.notEqual(manifest.candidateSnapshots[0].semanticFingerprint, '1'.repeat(64));
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_snapshot_semantic_index')[0].count, 2);

  const stored = JSON.parse(f.store.rows('SELECT metrics_json FROM growth_live_items WHERE snapshot_id=? ORDER BY item_id LIMIT 1', [ids[0]])[0].metrics_json);
  f.store.db.run('UPDATE growth_live_items SET metrics_json=? WHERE snapshot_id=? AND item_id=?',
    [JSON.stringify({ ...stored, label: 'changed' }), ids[0], stored.nodeId]);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_snapshot_semantic_index WHERE snapshot_id=?', [ids[0]])[0].count, 0);

  const changed = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-reindexed-details' });
  assert.deepEqual(fullManifest(f, changed).candidateSnapshots, []);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_snapshot_semantic_index')[0].count, 2);
});

test('cleanup invalidates manifests created before the semantic index contract', async t => {
  const f = await fixture(t);
  await writeHistory(f, ['A', 'A']);
  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-legacy-manifest' });
  const plan = f.store.readGrowthSnapshotCleanupPlan(preview.planId);
  const originalRead = f.store.readGrowthSnapshotCleanupPlan.bind(f.store);
  f.store.readGrowthSnapshotCleanupPlan = () => ({ ...plan, manifest: { ...plan.manifest, schemaVersion: 1 } });

  await assert.rejects(f.call('apply_growth_snapshot_cleanup', {
    planId: preview.planId,
    planHash: preview.planHash,
    confirmation: '确认删除该清单记录',
    idempotencyKey: 'apply-legacy-manifest'
  }), /growth_cleanup_plan_invalidated/);
  f.store.readGrowthSnapshotCleanupPlan = originalRead;
  assert.equal(originalRead(preview.planId).status, 'invalidated');
});

test('cleanup detail lookups use snapshot-prefixed database indexes', async t => {
  const f = await fixture(t);
  const [snapshotId] = await writeHistory(f, ['A']);

  const queries = [
    'SELECT metrics_json FROM growth_items WHERE snapshot_id=? ORDER BY item_id',
    'SELECT source_item_id,target_item_id,kind,weight,evidence FROM growth_edges WHERE snapshot_id=? ORDER BY source_item_id,target_item_id,kind',
    'SELECT item_id,type,level,value,source,source_ref FROM growth_signals WHERE snapshot_id=? ORDER BY item_id,type,level,value,source,source_ref',
    'SELECT node_id,label,role,source,confidence FROM growth_module_labels WHERE snapshot_id=? ORDER BY node_id'
  ];
  for (const query of queries) {
    const details = f.store.rows(`EXPLAIN QUERY PLAN ${query}`, [snapshotId]).map(row => String(row.detail)).join('\n');
    assert.match(details, /USING (?:COVERING )?INDEX/);
    assert.match(details, /snapshot_id=\?/);
    assert.doesNotMatch(details, /USE TEMP B-TREE/);
  }
  const parentLookup = f.store.rows('EXPLAIN QUERY PLAN SELECT 1 FROM growth_items WHERE snapshot_id=? AND parent_id=?', [snapshotId, 'directory:.'])
    .map(row => String(row.detail)).join('\n');
  assert.match(parentLookup, /growth_items_parent \(snapshot_id=\? AND parent_id=\?\)/);
});

test('cleanup invalidates old plans that attempted unindexed content deletion', async t => {
  const f = await fixture(t);
  await writeHistory(f, ['A', 'A']);
  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-old-content-plan' });
  const plan = f.store.readGrowthSnapshotCleanupPlan(preview.planId);
  const originalRead = f.store.readGrowthSnapshotCleanupPlan.bind(f.store);
  f.store.readGrowthSnapshotCleanupPlan = () => ({
    ...plan,
    manifest: {
      ...plan.manifest,
      records: {
        ...plan.manifest.records,
        contents: { ...plan.manifest.records.contents, deletableIds: [plan.manifest.records.contents.candidateIds[0]] }
      }
    }
  });

  await assert.rejects(f.call('apply_growth_snapshot_cleanup', {
    planId: preview.planId,
    planHash: preview.planHash,
    confirmation: '确认删除该清单记录',
    idempotencyKey: 'apply-old-content-plan'
  }), /growth_cleanup_plan_invalidated/);
  f.store.readGrowthSnapshotCleanupPlan = originalRead;
  assert.equal(originalRead(preview.planId).status, 'invalidated');
});

test('cleanup retains content blobs for separate indexed garbage collection', async t => {
  const f = await fixture(t);
  const ids = await writeHistory(f, ['A', 'A']);
  const chunkedContentId = f.store.putContent(JSON.stringify({ payload: 'x'.repeat(70_000) }), 'application/json');
  f.store.db.run('UPDATE object_revisions SET content_id=? WHERE object_id=?', [chunkedContentId, ids[0]]);
  f.store.db.run('INSERT INTO database_storage_cleanup_candidates SELECT id,stored_byte_length FROM contents WHERE id=?', [chunkedContentId]);
  const chunkCount = Number(f.store.rows('SELECT COUNT(*) AS count FROM content_chunks WHERE content_id=?', [chunkedContentId])[0].count);
  assert.ok(chunkCount > 0);

  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-physical-records' });
  const manifest = fullManifest(f, preview);

  assert.equal(preview.manifest.records.objectSearch.count, 1);
  assert.equal(preview.manifest.records.contentChunks.count, 0);
  assert.deepEqual(manifest.records.contents.deletableIds, []);
  assert.ok(manifest.records.contents.retainedSharedIds.includes(chunkedContentId));
  assert.deepEqual(manifest.records.databaseStorageCleanupCandidates.contentIds, []);
  const applied = await f.call('apply_growth_snapshot_cleanup', {
    planId: preview.planId,
    planHash: preview.planHash,
    confirmation: '确认删除该清单记录',
    idempotencyKey: 'apply-physical-records'
  });

  assert.equal(applied.deleted.objectSearch, 1);
  assert.equal(applied.deleted.contentChunks, 0);
  assert.equal(applied.deleted.databaseStorageCleanupCandidates, 0);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM contents WHERE id=?', [chunkedContentId])[0].count, 1);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM content_chunks WHERE content_id=?', [chunkedContentId])[0].count, chunkCount);
});

test('cleanup invalidates a partially applied plan when the remaining batch drifts before resume', async t => {
  const f = await fixture(t);
  const ids = await writeHistory(f, ['A', 'A', 'A']);
  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-resume-drift' });
  const input = {
    planId: preview.planId,
    planHash: preview.planHash,
    confirmation: '确认删除该清单记录',
    idempotencyKey: 'apply-resume-drift',
    batchSize: 1
  };
  const originalRun = f.store.db.run.bind(f.store.db);
  let completedBatches = 0;
  f.store.db.run = (sql, parameters) => {
    if (String(sql).startsWith("UPDATE growth_snapshot_cleanup_batches SET status='applied'") && completedBatches++ === 1) {
      throw new Error('simulated_process_exit');
    }
    return originalRun(sql, parameters);
  };

  await assert.rejects(f.call('apply_growth_snapshot_cleanup', input), /simulated_process_exit/);
  f.store.db.run = originalRun;
  assert.equal(f.store.rows('SELECT status FROM growth_snapshot_cleanup_batches WHERE plan_id=? ORDER BY batch_index', [preview.planId])[0].status, 'applied');
  f.store.db.run('UPDATE growth_snapshots SET status=? WHERE id=?', ['drifted', ids[1]]);

  await assert.rejects(f.call('apply_growth_snapshot_cleanup', input), /growth_cleanup_plan_invalidated/);
  assert.equal((await f.call('read_growth_snapshot_cleanup_plan', { planId: preview.planId })).status, 'invalidated');
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_snapshots WHERE id=?', [ids[1]])[0].count, 1, 'resume must not delete the drifted batch');
});

test('cleanup resumes an unchanged partially applied plan from its durable batch receipts', async t => {
  const f = await fixture(t);
  const ids = await writeHistory(f, ['A', 'A', 'A']);
  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-resume-clean' });
  const input = {
    planId: preview.planId,
    planHash: preview.planHash,
    confirmation: '确认删除该清单记录',
    idempotencyKey: 'apply-resume-clean',
    batchSize: 1
  };
  const originalRun = f.store.db.run.bind(f.store.db);
  let completedBatches = 0;
  f.store.db.run = (sql, parameters) => {
    if (String(sql).startsWith("UPDATE growth_snapshot_cleanup_batches SET status='applied'") && completedBatches++ === 1) {
      throw new Error('simulated_process_exit');
    }
    return originalRun(sql, parameters);
  };

  await assert.rejects(f.call('apply_growth_snapshot_cleanup', input), /simulated_process_exit/);
  f.store.db.run = originalRun;
  const applied = await f.call('apply_growth_snapshot_cleanup', input);

  assert.equal(applied.status, 'applied');
  assert.deepEqual((await f.call('read_project_growth', { root: f.projectRoot, historyLimit: 50 })).history.map(item => item.snapshot.id), [ids[2]]);
  assert.deepEqual(f.store.rows('PRAGMA foreign_key_check'), []);
});

test('cleanup rejects an exact event tuple drift committed between batches even when counts stay unchanged', async t => {
  const f = await fixture(t);
  const ids = await writeHistory(f, ['A', 'A', 'A']);
  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-between-batch-drift' });
  const originalRun = f.store.db.run.bind(f.store.db);
  let commits = 0;
  f.store.db.run = (sql, parameters) => {
    const result = originalRun(sql, parameters);
    if (String(sql) === 'COMMIT' && ++commits === 2) originalRun('UPDATE events SET kind=? WHERE subject_id=?', ['drifted-kind', ids[1]]);
    return result;
  };

  await assert.rejects(f.call('apply_growth_snapshot_cleanup', {
    planId: preview.planId,
    planHash: preview.planHash,
    confirmation: '确认删除该清单记录',
    idempotencyKey: 'apply-between-batch-drift',
    batchSize: 1
  }), /growth_cleanup_plan_invalidated/);
  f.store.db.run = originalRun;

  assert.equal((await f.call('read_growth_snapshot_cleanup_plan', { planId: preview.planId })).status, 'invalidated');
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_snapshots WHERE id=?', [ids[1]])[0].count, 1);
});

test('cleanup invalidates when another database connection changes a retained snapshot between batches', async t => {
  const f = await fixture(t);
  const ids = await writeHistory(f, ['A', 'A', 'A']);
  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-retained-between-batch-drift' });
  const external = UnifiedDataStore.open(f.root, f.store.databaseId);
  t.after(() => external.close());
  const originalRun = f.store.db.run.bind(f.store.db);
  let commits = 0;
  f.store.db.run = (sql, parameters) => {
    const result = originalRun(sql, parameters);
    if (String(sql) === 'COMMIT' && ++commits === 2) {
      const row = external.rows('SELECT rowid,metrics_json FROM growth_items WHERE snapshot_id=? ORDER BY rowid LIMIT 1', [ids[2]])[0];
      const metrics = JSON.parse(String(row.metrics_json));
      external.db.run('UPDATE growth_items SET metrics_json=? WHERE rowid=?', [JSON.stringify({ ...metrics, label: 'drifted-retained' }), row.rowid]);
    }
    return result;
  };

  await assert.rejects(f.call('apply_growth_snapshot_cleanup', {
    planId: preview.planId,
    planHash: preview.planHash,
    confirmation: '确认删除该清单记录',
    idempotencyKey: 'apply-retained-between-batch-drift',
    batchSize: 1
  }), /growth_cleanup_plan_invalidated/);
  f.store.db.run = originalRun;

  assert.equal((await f.call('read_growth_snapshot_cleanup_plan', { planId: preview.planId })).status, 'invalidated');
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_snapshots WHERE id=?', [ids[1]])[0].count, 1);
});

test('cleanup invalidates when a candidate gains an external object or content reference after preview', async t => {
  const f = await fixture(t);
  const ids = await writeHistory(f, ['A', 'A']);
  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-reference-drift' });
  const retainedContent = f.store.rows('SELECT content_id FROM object_revisions WHERE object_id=?', [ids[0]])[0];
  f.store.db.run('INSERT INTO relations(source_id,relation,target_id) VALUES(?,?,?)', [ids[1], 'late-reference', ids[0]]);
  const content = f.store.rows('SELECT sha256,mime_type FROM contents WHERE id=?', [retainedContent.content_id])[0];
  f.store.db.run(`INSERT INTO project_run_artifacts
    (project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at,artifact_kind)
    VALUES(?,?,?,?,?,?,?,'retained')`, [f.projectId, 1000, 'late-reference.json', retainedContent.content_id, content.sha256, content.mime_type, Date.now()]);

  await assert.rejects(f.call('apply_growth_snapshot_cleanup', {
    planId: preview.planId,
    planHash: preview.planHash,
    confirmation: '确认删除该清单记录',
    idempotencyKey: 'apply-reference-drift'
  }), /growth_cleanup_plan_invalidated/);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_snapshots')[0].count, 2);
});

test('cleanup keeps a request shared across batches until all of its events are deleted', async t => {
  const f = await fixture(t);
  const ids = await writeHistory(f, ['A', 'A', 'A']);
  const firstEvent = f.store.rows('SELECT request_id FROM events WHERE subject_id=?', [ids[0]])[0];
  const secondEvent = f.store.rows('SELECT request_id FROM events WHERE subject_id=?', [ids[1]])[0];
  f.store.db.run('UPDATE events SET request_id=? WHERE subject_id=?', [firstEvent.request_id, ids[1]]);
  f.store.db.run('DELETE FROM requests WHERE id=?', [secondEvent.request_id]);
  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-shared-request' });

  assert.equal(preview.manifest.records.requests.count, 1);
  const applied = await f.call('apply_growth_snapshot_cleanup', {
    planId: preview.planId,
    planHash: preview.planHash,
    confirmation: '确认删除该清单记录',
    idempotencyKey: 'apply-shared-request',
    batchSize: 1
  });

  assert.equal(applied.deleted.requests, 1);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM requests WHERE id=?', [firstEvent.request_id])[0].count, 0);
  assert.deepEqual(f.store.rows('PRAGMA foreign_key_check'), []);
});
