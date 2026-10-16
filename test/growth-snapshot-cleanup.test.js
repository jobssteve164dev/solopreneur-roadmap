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

test('cleanup preview freezes an immutable exact A-A-B-A-A segment manifest', async t => {
  const f = await fixture(t);
  const ids = await writeHistory(f, ['A', 'A', 'B', 'A', 'A']);

  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-segments' });

  assert.equal(preview.status, 'prepared');
  assert.match(preview.planId, /^[a-f0-9-]{36}$/);
  assert.match(preview.planHash, /^[a-f0-9]{64}$/);
  assert.equal(preview.manifest.title, '待删除数据库记录清单');
  assert.equal(preview.manifest.database.databaseId, f.store.databaseId);
  assert.equal(preview.manifest.database.snapshotCount, 5);
  assert.deepEqual(preview.manifest.retainedSnapshots.map(item => item.snapshotId), [ids[1], ids[2], ids[4]]);
  assert.deepEqual(preview.manifest.candidateSnapshots.map(item => item.snapshotId), [ids[0], ids[3]]);
  assert.deepEqual(preview.manifest.candidateSnapshots.map(item => item.retainedSnapshotId), [ids[1], ids[4]]);
  assert.equal(preview.manifest.records.growthSnapshots.count, 2);
  assert.equal(preview.manifest.records.growthItems.count, 4);
  assert.equal(preview.manifest.records.growthEdges.count, 2);
  assert.equal(preview.manifest.records.growthSignals.count, 2);
  assert.equal(preview.manifest.records.growthModuleLabels.count, 2);
  assert.equal(preview.manifest.records.objects.count, 2);
  assert.equal(preview.manifest.records.objectSearch.count, 2);
  assert.equal(preview.manifest.records.objectSearch.rowids.length, 2);
  assert.equal(preview.manifest.records.objectRevisions.count, 2);
  assert.equal(preview.manifest.records.events.count, 2);
  assert.equal(preview.manifest.records.requests.count, 2);
  assert.equal(preview.manifest.records.contents.candidateIds.length, 4);
  assert.equal(preview.manifest.records.contents.deletableIds.length, 4);
  assert.equal(preview.manifest.records.contentChunks.count, 0);
  assert.equal(preview.manifest.records.databaseStorageCleanupCandidates.count, 0);
  assert.deepEqual(await f.call('read_growth_snapshot_cleanup_plan', { planId: preview.planId }), preview);
  assert.deepEqual(await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-segments' }), preview);
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
    growthSnapshots: 2, growthItems: 4, growthEdges: 2, growthSignals: 2, growthModuleLabels: 2,
    objects: 2, objectSearch: 2, objectRevisions: 2, events: 2, outbox: 0, requests: 2,
    contentChunks: 0, databaseStorageCleanupCandidates: 0, contents: 4
  });
  assert.deepEqual((await f.call('read_project_growth', { root: f.projectRoot, historyLimit: 50 })).history.map(item => item.snapshot.id), [ids[4], ids[2], ids[1]]);
  assert.deepEqual(f.store.rows('PRAGMA foreign_key_check'), []);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM object_search WHERE rowid IN (?,?)', preview.manifest.records.objectSearch.rowids)[0].count, 0);
  assert.deepEqual(await f.call('apply_growth_snapshot_cleanup', input), applied);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM growth_snapshot_cleanup_batches WHERE plan_id=?', [preview.planId])[0].count, 2);
});

test('cleanup retains candidate content that still has any reference elsewhere in the database', async t => {
  const f = await fixture(t);
  const ids = await writeHistory(f, ['A', 'A']);
  const revision = f.store.rows('SELECT content_id FROM object_revisions WHERE object_id=?', [ids[0]])[0];
  const content = f.store.rows('SELECT sha256,mime_type FROM contents WHERE id=?', [revision.content_id])[0];
  f.store.db.run(`INSERT INTO project_run_artifacts
    (project_id,execution_log_id,relative_path,content_id,sha256,mime_type,updated_at,artifact_kind)
    VALUES(?,?,?,?,?,?,?,'retained')`, [f.projectId, 999, 'retained-growth-content.json', revision.content_id, content.sha256, content.mime_type, Date.now()]);

  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-shared-content' });

  assert.deepEqual(preview.manifest.candidateSnapshots.map(item => item.snapshotId), [ids[0]]);
  assert.ok(preview.manifest.records.contents.retainedSharedIds.includes(revision.content_id));
  assert.ok(!preview.manifest.records.contents.deletableIds.includes(revision.content_id));
  const applied = await f.call('apply_growth_snapshot_cleanup', {
    planId: preview.planId,
    planHash: preview.planHash,
    confirmation: '确认删除该清单记录',
    idempotencyKey: 'apply-shared-content'
  });
  assert.equal(applied.deleted.contents, preview.manifest.records.contents.deletableIds.length);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM contents WHERE id=?', [revision.content_id])[0].count, 1);
  assert.equal(f.store.rows("SELECT COUNT(*) AS count FROM project_run_artifacts WHERE relative_path='retained-growth-content.json'")[0].count, 1);
  assert.deepEqual(f.store.rows('PRAGMA foreign_key_check'), []);
});

test('cleanup follows retained JSON content references before classifying candidate content as deletable', async t => {
  const f = await fixture(t);
  const ids = await writeHistory(f, ['A', 'A']);
  const revision = f.store.rows('SELECT content_id FROM object_revisions WHERE object_id=?', [ids[0]])[0];
  f.store.write({
    kind: 'review_batch', action: 'create', scope: null, idempotencyKey: 'embedded-growth-reference',
    data: { input_cursor: 0, input_hash: 'a'.repeat(64), proposal_content: null,
      review_content: JSON.stringify({ sourceContents: { candidate: revision.content_id } }), status: 'interrupted' }
  });

  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-embedded-content' });

  assert.ok(preview.manifest.records.contents.retainedSharedIds.includes(revision.content_id));
  assert.ok(!preview.manifest.records.contents.deletableIds.includes(revision.content_id));
  const applied = await f.call('apply_growth_snapshot_cleanup', {
    planId: preview.planId,
    planHash: preview.planHash,
    confirmation: '确认删除该清单记录',
    idempotencyKey: 'apply-embedded-content'
  });
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM contents WHERE id=?', [revision.content_id])[0].count, 1);
  assert.equal(applied.deleted.contents, preview.manifest.records.contents.deletableIds.length);
});

test('cleanup follows embedded references from every live database content root', async t => {
  const f = await fixture(t);
  const ids = await writeHistory(f, ['A', 'A']);
  const revision = f.store.rows('SELECT content_id FROM object_revisions WHERE object_id=?', [ids[0]])[0];
  const rootContentId = f.store.putContent(JSON.stringify({ sourceContents: { candidate: revision.content_id } }), 'application/json');
  const actor = f.store.rows('SELECT actor_id FROM requests ORDER BY rowid LIMIT 1')[0];
  f.store.db.run("INSERT INTO requests(actor_id,idempotency_key,id,input_hash,result_content_id,status) VALUES(?,?,?,?,?,'committed')",
    [actor.actor_id, 'external-embedded-root', 'external-embedded-root', 'b'.repeat(64), rootContentId]);

  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-all-embedded-roots' });

  assert.ok(preview.manifest.records.contents.retainedSharedIds.includes(revision.content_id));
  assert.ok(!preview.manifest.records.contents.deletableIds.includes(revision.content_id));
});

test('cleanup manifest inventories every physical FTS, chunk, and cleanup-queue record it deletes', async t => {
  const f = await fixture(t);
  const ids = await writeHistory(f, ['A', 'A']);
  const chunkedContentId = f.store.putContent(JSON.stringify({ payload: 'x'.repeat(70_000) }), 'application/json');
  f.store.db.run('UPDATE object_revisions SET content_id=? WHERE object_id=?', [chunkedContentId, ids[0]]);
  f.store.db.run('INSERT INTO database_storage_cleanup_candidates SELECT id,stored_byte_length FROM contents WHERE id=?', [chunkedContentId]);
  const chunkCount = Number(f.store.rows('SELECT COUNT(*) AS count FROM content_chunks WHERE content_id=?', [chunkedContentId])[0].count);
  assert.ok(chunkCount > 0);

  const preview = await f.call('preview_growth_snapshot_cleanup', { idempotencyKey: 'preview-physical-records' });

  assert.equal(preview.manifest.records.objectSearch.count, 1);
  assert.equal(preview.manifest.records.contentChunks.count, chunkCount);
  assert.deepEqual(preview.manifest.records.databaseStorageCleanupCandidates.contentIds, [chunkedContentId]);
  const applied = await f.call('apply_growth_snapshot_cleanup', {
    planId: preview.planId,
    planHash: preview.planHash,
    confirmation: '确认删除该清单记录',
    idempotencyKey: 'apply-physical-records'
  });

  assert.equal(applied.deleted.objectSearch, 1);
  assert.equal(applied.deleted.contentChunks, chunkCount);
  assert.equal(applied.deleted.databaseStorageCleanupCandidates, 1);
  assert.equal(f.store.rows('SELECT COUNT(*) AS count FROM contents WHERE id=?', [chunkedContentId])[0].count, 0);
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
