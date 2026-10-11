const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DiskDatabase } = require('../out/db/diskDatabase.js');
const { unifiedSchemaSql } = require('../out/db/unifiedSchema.js');
const { unifiedSchemaMigrations } = require('../out/db/unifiedSchemaMigrations.js');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations, runtimeMcpSource } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');
const { readLearningOverview } = require('../out/learningLedger.js');

async function fixture(action) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-learning-decisions-'));
  const root = path.join(base, '.solomap-global'); const workspace = path.join(base, 'project'); fs.mkdirSync(workspace);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'learning-decisions-owner', onCommand: () => ({ status: 'running' }), onData: ops });
  let client;
  try {
    const project = (await ops({ operation: 'register_project', input: { root: workspace } })).projectId;
    client = runtimeMcpSource(root, project, true);
    const sourceRoot = path.join(base, 'learning');
    for (const directory of ['ledger', 'candidates', 'candidate-decisions']) fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
    const event = { schemaVersion: 1, id: 'old-event', projectId: 'old-slug', projectPath: workspace, projectName: 'Project', sourceType: 'solo', sourceRef: 'legacy-run', eventType: 'completed', summary: 'Original source outcome', evidenceRefs: [], tags: [], createdAt: '2026-01-01T00:00:00Z' };
    const lesson = { schemaVersion: 1, id: 'old-lesson', projectId: 'old-slug', projectPath: workspace, projectName: 'Project', sourceType: 'solo', sourceEventIds: ['old-event'], lessonType: 'planning_rule', summary: 'Keep the intended result complete', appliesWhen: 'Working on the requested result', doThis: 'Finish all required outcomes', avoidThis: 'Do not stop after a partial check', confidence: 'medium', status: 'candidate', evidenceRefs: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    fs.writeFileSync(path.join(sourceRoot, 'ledger', 'events.jsonl'), JSON.stringify(event) + '\n');
    fs.writeFileSync(path.join(sourceRoot, 'candidates', 'old-lesson.json'), JSON.stringify(lesson) + '\n');
    const importNow = async key => {
      const job = await ops({ operation: 'import_project_data', input: { collection: 'learning', sourceRoot, projectScopes: { [workspace]: project }, idempotencyKey: key } });
      await ops.waitForMigrations(); return ops({ operation: 'migration_status', input: { jobId: job.jobId } });
    };
    await action({ store, ops, root, workspace, project, client, sourceRoot, event, lesson, importNow });
  } finally { if (client) await client.close(); await server.close(); await ops.close(); store.close(); }
}

async function importedMultiCandidate(context) {
  const { sourceRoot, workspace, lesson, importNow, store, project } = context;
  fs.writeFileSync(path.join(sourceRoot, 'candidates', 'second.json'), JSON.stringify({ ...lesson, id: 'second-lesson' }));
  fs.writeFileSync(path.join(sourceRoot, 'candidate-decisions', 'many.json'), JSON.stringify({ schemaVersion: 1, id: 'many-candidates', eventId: 'old-event', projectPath: workspace, decision: 'created', candidateIds: ['old-lesson', 'second-lesson'], reason: 'Original extraction', checkedSignals: [], evidenceRefs: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }));
  assert.equal((await importNow('multi-candidate-source')).status, 'completed');
  return store.read(store.search({ scope: project, kinds: ['lesson_decision'] }).items[0].objectId);
}

test('host links preserve all decision candidates in current and fixed revisions', () => fixture(async context => {
  const { store, ops, project } = context; const original = await importedMultiCandidate(context);
  const evidence = store.write({ kind: 'evidence', action: 'create', scope: project, idempotencyKey: 'additional-evidence', data: { type: 'host_observation', content: 'Additional verified observation', source_actor_id: original.data.actor_id, observed_at: Date.now() } });
  const input = { source: original.objectId, target: evidence.objectId, relation: 'evidence', expectedRevision: 1, idempotencyKey: 'decision-evidence-link' };
  const linked = await ops({ operation: 'link', input });
  assert.deepEqual(store.read(linked.objectId).data.candidate_refs, original.data.candidate_refs);
  assert.deepEqual(store.read(linked.objectId, 1).data.candidate_refs, original.data.candidate_refs);
  assert.deepEqual(await ops({ operation: 'link', input }), linked, 'retries preserve the committed version');
}));

test('explicit unchanged scalar candidates preserve a multi-candidate decision', () => fixture(async context => {
  const { store, project } = context; const original = await importedMultiCandidate(context);
  const changed = store.write({ kind: 'lesson_decision', action: 'patch', scope: project, objectId: original.objectId, expectedRevision: 1, idempotencyKey: 'explicit-unchanged-candidate', data: { lesson_id: original.data.lesson_id, lesson_revision: original.data.lesson_revision } });
  assert.deepEqual(store.read(changed.objectId).data.candidate_refs, original.data.candidate_refs);
}));

test('host creates and changes decisions with fixed candidate versions', () => fixture(async context => {
  const { store, project } = context; const original = await importedMultiCandidate(context);
  const created = store.write({ kind: 'lesson_decision', action: 'create', scope: project, idempotencyKey: 'host-created-decision', data: { event_id: original.data.event_id, decision: 'created', reason: 'Host result', actor_id: original.data.actor_id, lesson_id: original.data.lesson_id, lesson_revision: 1 } });
  assert.deepEqual(store.read(created.objectId).data.candidate_refs, [{ objectId: original.data.lesson_id, revision: 1 }]);
  const next = original.data.candidate_refs[1];
  const changed = store.write({ kind: 'lesson_decision', action: 'patch', scope: project, objectId: original.objectId, expectedRevision: 1, idempotencyKey: 'replace-scalar-candidate', data: { lesson_id: next.objectId, lesson_revision: 1 } });
  assert.deepEqual(store.read(changed.objectId).data.candidate_refs, [next]);
  assert.deepEqual(store.read(changed.objectId, 1).data.candidate_refs, original.data.candidate_refs);
}));

test('host decision lists derive their scalar projection while preserving explicit consistency checks', () => fixture(async context => {
  const { store, ops, project } = context; const original = await importedMultiCandidate(context);
  const input = { kind: 'lesson_decision', action: 'create', scope: project, idempotencyKey: 'list-only-decision', data: { event_id: original.data.event_id, decision: 'created', reason: 'Host result', actor_id: original.data.actor_id, candidate_refs: original.data.candidate_refs } };
  const created = await ops({ operation: 'write', input });
  assert.deepEqual(store.read(created.objectId).data.candidate_refs, original.data.candidate_refs);
  assert.equal(store.read(created.objectId).data.lesson_id, original.data.lesson_id);
  assert.equal(store.read(created.objectId).data.lesson_revision, 1);
  assert.deepEqual(await ops({ operation: 'write', input }), created);
  const cleared = store.write({ kind: 'lesson_decision', action: 'patch', scope: project, objectId: created.objectId, expectedRevision: 1, idempotencyKey: 'list-only-decision-clear', data: { candidate_refs: [] } });
  assert.deepEqual(store.read(cleared.objectId).data.candidate_refs, []);
  assert.equal(store.read(cleared.objectId).data.lesson_id, null);
  assert.deepEqual(store.read(cleared.objectId, 1).data.candidate_refs, original.data.candidate_refs);
  assert.throws(() => store.write({ ...input, idempotencyKey: 'list-scalar-mismatch', data: { ...input.data, lesson_id: null, lesson_revision: null } }), /learning_candidate_reference_mismatch/);
}));

test('formal JSON export and search retain every decision candidate', () => fixture(async context => {
  const { store, ops, project, root } = context; const original = await importedMultiCandidate(context);
  const destination = path.join(root, 'exports', 'decision.json');
  const receipt = await ops({ operation: 'export', input: { ref: original.objectId, format: 'json', destination, idempotencyKey: 'decision-json-export' } });
  const exported = JSON.parse(fs.readFileSync(destination, 'utf8'));
  assert.equal(receipt.revision, 1);
  assert.deepEqual(exported.data.candidate_refs, original.data.candidate_refs);
  assert.deepEqual(store.search({ scope: project, kinds: ['lesson_decision'] }).items[0].data.candidate_refs, original.data.candidate_refs);
}));

test('full text search finds a decision by its first and later candidate IDs', () => fixture(async context => {
  const { ops, project } = context; const original = await importedMultiCandidate(context);
  for (const candidate of original.data.candidate_refs) {
    const page = await ops({ operation: 'search', input: { scope: project, kinds: ['lesson_decision'], query: candidate.objectId } });
    assert.deepEqual(page.items.map(item => item.objectId), [original.objectId]);
    assert.deepEqual(page.items[0].data.candidate_refs, original.data.candidate_refs);
  }
}));

test('replacing or clearing a scalar candidate changes only the new decision version', () => fixture(async context => {
  const { store, project } = context; const original = await importedMultiCandidate(context);
  const next = original.data.candidate_refs[1];
  const changed = store.write({ kind: 'lesson_decision', action: 'patch', scope: project, objectId: original.objectId, expectedRevision: 1, idempotencyKey: 'replace-original-candidate', data: { lesson_id: next.objectId, lesson_revision: 1 } });
  assert.deepEqual(store.read(changed.objectId).data.candidate_refs, [next]);
  const cleared = store.write({ kind: 'lesson_decision', action: 'patch', scope: project, objectId: original.objectId, expectedRevision: 2, idempotencyKey: 'clear-original-candidates', data: { lesson_id: null, lesson_revision: null } });
  assert.deepEqual(store.read(cleared.objectId).data.candidate_refs, []);
  assert.deepEqual(store.read(cleared.objectId, 1).data.candidate_refs, original.data.candidate_refs);
  assert.deepEqual(store.read(cleared.objectId, 2).data.candidate_refs, [next]);
}));

test('global host decisions retain fixed global candidates', () => fixture(async ({ store }) => {
  const evidence = store.write({ kind: 'evidence', action: 'create', scope: null, idempotencyKey: 'global-decision-source', data: { type: 'host_observation', content: 'Global observation', source_actor_id: 'local-runtime', observed_at: Date.now() } });
  const event = store.write({ kind: 'learning_event', action: 'create', scope: null, idempotencyKey: 'global-decision-event', data: { source_object_id: evidence.objectId, source_revision: 1, event_type: 'completed', summary: 'Global result', occurred_at: Date.now() } });
  const lesson = store.write({ kind: 'lesson', action: 'create', scope: null, idempotencyKey: 'global-decision-lesson', data: { status: 'candidate', summary: 'Global candidate' } });
  const decision = store.write({ kind: 'lesson_decision', action: 'create', scope: null, idempotencyKey: 'global-host-decision', data: { event_id: event.objectId, lesson_id: lesson.objectId, decision: 'created', reason: 'Global extraction', actor_id: 'local-runtime' } });
  assert.deepEqual(store.read(decision.objectId).data.candidate_refs, [{ objectId: lesson.objectId, revision: 1 }]);
  store.write({ kind: 'lesson', action: 'patch', scope: null, objectId: lesson.objectId, expectedRevision: 1, idempotencyKey: 'global-lesson-change', data: { summary: 'New global rule' } });
  assert.equal(store.read(decision.objectId).data.lesson_revision, 1);
}));

test('project decisions accept global lessons and continue rejecting other projects private lessons', () => fixture(async context => {
  const { store, project } = context; const original = await importedMultiCandidate(context);
  const lesson = store.write({ kind: 'lesson', action: 'create', scope: null, idempotencyKey: 'shared-global-lesson', data: { status: 'candidate', summary: 'Global lesson available to authorized review' } });
  const input = { kind: 'lesson_decision', action: 'create', scope: project, idempotencyKey: 'project-global-candidate', data: { event_id: original.data.event_id, lesson_id: lesson.objectId, lesson_revision: 1, decision: 'created', reason: 'Existing global reference contract', actor_id: 'local-runtime' } };
  const decision = store.write(input); const expected = [{ objectId: lesson.objectId, revision: 1 }];
  assert.deepEqual(store.read(decision.objectId).data.candidate_refs, expected);
  const patched = store.write({ ...input, action: 'patch', objectId: decision.objectId, expectedRevision: 1, idempotencyKey: 'shared-global-reason', data: { reason: 'Updated reason' } });
  const linked = store.link({ source: patched.objectId, target: original.data.source_object_id, relation: 'evidence', expectedRevision: 2, idempotencyKey: 'shared-global-evidence' });
  const archived = store.write({ ...input, action: 'archive', objectId: decision.objectId, expectedRevision: 3, idempotencyKey: 'shared-global-archive', data: {} });
  assert.equal(linked.revision, 3); assert.deepEqual(store.read(archived.objectId).data.candidate_refs, expected);
  const other = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'other-candidate-project', data: { name: 'Other private project' } });
  const privateLesson = store.write({ kind: 'lesson', action: 'create', scope: other.objectId, idempotencyKey: 'other-private-lesson', data: { status: 'candidate', summary: 'Private lesson' } });
  assert.throws(() => store.write({ ...input, idempotencyKey: 'reject-other-private', data: { ...input.data, lesson_id: privateLesson.objectId } }), /scope_mismatch/);
  assert.throws(() => store.write({ ...input, idempotencyKey: 'reject-other-private-list', data: { ...input.data, candidate_refs: [...expected, { objectId: privateLesson.objectId, revision: 1 }] } }), /scope_mismatch/);
}));

test('invalid full candidate lists roll back and valid host replacements preserve old lists', () => fixture(async context => {
  const { store, project } = context; const original = await importedMultiCandidate(context);
  const makeInput = (refs, key) => ({ kind: 'lesson_decision', action: 'patch', scope: project, objectId: original.objectId, expectedRevision: 1, idempotencyKey: key, data: { candidate_refs: refs } });
  assert.throws(() => store.write(makeInput(null, 'invalid-null-candidates')), /learning_candidate_reference_invalid/);
  assert.throws(() => store.write(makeInput([{ objectId: original.data.lesson_id, revision: 0 }], 'invalid-candidate-version')), /learning_candidate_reference_invalid/);
  assert.throws(() => store.write(makeInput([{ objectId: original.data.event_id, revision: 1 }], 'invalid-candidate-kind')), /relation_kind_mismatch/);
  assert.throws(() => store.write(makeInput([{ objectId: original.data.lesson_id, revision: 99 }], 'invalid-missing-version')), /revision_missing/);
  assert.equal(store.read(original.objectId).revision, 1);
  const refs = original.data.candidate_refs.slice(0, 1);
  const replaced = store.write(makeInput(refs, 'host-replace-complete-list'));
  assert.deepEqual(store.read(replaced.objectId).data.candidate_refs, refs);
  assert.deepEqual(store.read(replaced.objectId, 1).data.candidate_refs, original.data.candidate_refs);
}));

test('published native decisions retain unversioned historical candidates across upgrade and edits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-decision-v11-'));
  const db = new DiskDatabase(path.join(root, 'solomap.db'), { foreignKeys: false });
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const sql = unifiedSchemaSql(); const now = Date.now();
  try {
    db.run(sql); db.run('INSERT INTO schema_migrations VALUES(1,?,?)', [hash(sql), now]);
    for (const migration of unifiedSchemaMigrations.filter(item => item.version <= 11)) { db.run(migration.sql); db.run('INSERT INTO schema_migrations VALUES(?,?,?)', [migration.version, hash(migration.sql), now]); }
    db.run('INSERT INTO database_meta VALUES(?,?)', ['database_id', crypto.randomUUID()]);
    db.run('INSERT INTO database_meta VALUES(?,?)', ['protocol_version', '1']);
    db.run('INSERT INTO actors(id,kind,provider) VALUES(?,?,?)', ['local-runtime', 'runtime', 'solomap']);
    const add = (id, kind, table, data, revision = 1, scope = kind === 'project' ? null : 'old-native-project') => {
      if (revision === 1) {
        db.run('INSERT INTO objects VALUES(?,?,?,?,?,?,NULL)', [id, kind, scope, revision, now, now]);
        const keys = Object.keys(data); db.run(`INSERT INTO ${table}(id,project_id,${keys.join(',')}) VALUES(?,?,${keys.map(() => '?').join(',')})`, [id, scope, ...keys.map(key => data[key])]);
      } else {
        db.run('UPDATE objects SET revision=? WHERE id=?', [revision, id]);
        const keys = Object.keys(data); db.run(`UPDATE ${table} SET ${keys.map(key => `${key}=?`).join(',')} WHERE id=?`, [...keys.map(key => data[key]), id]);
      }
      const snapshot = Buffer.from(JSON.stringify({ objectId: id, kind, projectId: scope, revision, createdAt: now, updatedAt: now, archivedAt: null, data, relations: [] }));
      const contentId = crypto.randomUUID(); db.run('INSERT INTO contents VALUES(?,?,?,?,?,?,?,NULL)', [contentId, hash(snapshot), 'application/json', 'utf8', snapshot.length, snapshot.length, snapshot]);
      db.run('INSERT INTO object_revisions VALUES(?,?,?,?,?,?)', [id, revision, contentId, 'local-runtime', 'create', now]);
    };
    add('old-native-project', 'project', 'projects', { name: 'Historical project' });
    const source = Buffer.from('Original native evidence');
    db.run('INSERT INTO contents VALUES(?,?,?,?,?,?,?,NULL)', ['old-native-content', hash(source), 'text/plain', 'utf8', source.length, source.length, source]);
    add('old-native-source', 'evidence', 'evidence', { type: 'host_observation', content_id: 'old-native-content', source_actor_id: 'local-runtime', observed_at: now });
    add('old-native-event', 'learning_event', 'learning_events', { source_object_id: 'old-native-source', event_type: 'completed', summary: 'Historical result', occurred_at: now, source_revision: 1 });
    add('old-native-lesson', 'lesson', 'lessons', { status: 'candidate', summary: 'Historical candidate', confidence: 0.5 });
    add('old-native-lesson', 'lesson', 'lessons', { status: 'candidate', summary: 'Later candidate', confidence: 0.5 }, 2);
    add('old-global-lesson', 'lesson', 'lessons', { status: 'candidate', summary: 'Global historical lesson', confidence: 0.5 }, 1, null);
    add('old-global-decision', 'lesson_decision', 'lesson_decisions', { event_id: 'old-native-event', lesson_id: 'old-global-lesson', decision: 'created', reason: 'Existing project to global reference', actor_id: 'local-runtime' });
    add('old-native-decision', 'lesson_decision', 'lesson_decisions', { event_id: 'old-native-event', lesson_id: 'old-native-lesson', decision: 'created', reason: 'Original unpinned reference', actor_id: 'local-runtime' });
    add('old-cleared-decision', 'lesson_decision', 'lesson_decisions', { event_id: 'old-native-event', lesson_id: 'old-native-lesson', decision: 'created', reason: 'Before clearing', actor_id: 'local-runtime' });
    add('old-cleared-decision', 'lesson_decision', 'lesson_decisions', { event_id: 'old-native-event', lesson_id: null, decision: 'skipped', reason: 'After clearing', actor_id: 'local-runtime' }, 2);
  } finally { db.close(); }
  let store = new UnifiedDataStore(root);
  try {
    const expected = [{ objectId: 'old-native-lesson', revision: null }];
    assert.deepEqual(store.read('old-native-decision').data.candidate_refs, expected, 'old schema did not pin a candidate version; preserve the relationship without inventing one');
    assert.deepEqual(store.read('old-cleared-decision', 1).data.candidate_refs, expected, 'current cleared state must not remove the old version relationship');
    assert.deepEqual(store.read('old-cleared-decision').data.candidate_refs, []);
    const globalExpected = [{ objectId: 'old-global-lesson', revision: null }];
    assert.deepEqual(store.read('old-global-decision').data.candidate_refs, globalExpected);
    const globalPatched = store.write({ kind: 'lesson_decision', action: 'patch', scope: 'old-native-project', objectId: 'old-global-decision', expectedRevision: 1, idempotencyKey: 'old-global-reason', data: { reason: 'Edited legacy reason' } });
    const linked = store.link({ source: globalPatched.objectId, target: 'old-native-source', relation: 'evidence', expectedRevision: 2, idempotencyKey: 'old-global-link' });
    store.write({ kind: 'lesson_decision', action: 'archive', scope: 'old-native-project', objectId: linked.objectId, expectedRevision: 3, idempotencyKey: 'old-global-archive', data: {} });
    assert.deepEqual(store.read('old-global-decision').data.candidate_refs, globalExpected);
    assert.deepEqual(store.read('old-global-decision', 1).data.candidate_refs, globalExpected);
    const patched = store.write({ kind: 'lesson_decision', action: 'patch', scope: 'old-native-project', objectId: 'old-native-decision', expectedRevision: 1, idempotencyKey: 'old-native-reason-edit', data: { reason: 'Updated reason' } });
    assert.deepEqual(store.read(patched.objectId).data.candidate_refs, expected);
    assert.deepEqual(store.read(patched.objectId, 1).data.candidate_refs, expected);
    assert.deepEqual(store.read('old-global-decision').data.candidate_refs, globalExpected);
    store.close(); store = new UnifiedDataStore(root);
    assert.equal(store.read(patched.objectId).revision, 2);
    assert.deepEqual(store.read(patched.objectId, 1).data.candidate_refs, expected);
  } finally { store.close(); }
});

test('learning decisions reference the imported event and lesson revisions without relying on files', () => fixture(async ({ store, ops, root, workspace, project, client, sourceRoot, importNow }) => {
  assert.equal((await importNow('decision-sources')).progress.imported, 2);
  const event = store.search({ scope: project, kinds: ['learning_event'] }).items[0];
  const lesson = store.search({ scope: project, kinds: ['lesson'] }).items[0];
  store.write({ kind: 'learning_event', action: 'patch', scope: project, objectId: event.objectId, expectedRevision: 1, idempotencyKey: 'event-new-claim', data: { summary: 'New native claim' } });
  store.write({ kind: 'lesson', action: 'patch', scope: project, objectId: lesson.objectId, expectedRevision: 1, idempotencyKey: 'lesson-new-claim', data: { summary: 'New native lesson' } });
  const decision = { schemaVersion: 1, id: 'old-decision', eventId: 'old-event', projectId: 'old-slug', projectPath: workspace, projectName: 'Project', decision: 'created', candidateIds: ['old-lesson'], reason: 'candidate_created', checkedSignals: ['verification:present'], evidenceRefs: [{ type: 'command', ref: 'npm test' }], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', untouched: { original: '全部保留🌿' } };
  const bytes = Buffer.from('\uFEFF' + JSON.stringify(decision) + '\n');
  fs.writeFileSync(path.join(sourceRoot, 'candidate-decisions', 'created.json'), bytes);
  fs.writeFileSync(path.join(sourceRoot, 'candidate-decisions', 'skipped.json'), JSON.stringify({ ...decision, id: 'old-skipped', candidateIds: [], decision: 'skipped', reason: 'no_reusable_candidate_signal_matched' }) + '\n');
  const imported = await importNow('decision-history');
  assert.equal(imported.status, 'completed', JSON.stringify(imported.progress.conflicts));
  assert.equal(imported.progress.imported, 2, 'the original decisions must become typed records');
  const decisions = (await ops({ operation: 'search', input: { scope: project, kinds: ['lesson_decision'] } })).items;
  assert.equal(decisions.length, 2);
  const created = decisions.find(item => item.data.decision === 'created');
  const skipped = decisions.find(item => item.data.decision === 'skipped');
  assert.equal(created.data.legacy_decision_id, 'old-decision');
  assert.equal(created.data.event_id, event.objectId); assert.equal(created.data.event_revision, 1);
  assert.equal(created.data.lesson_id, lesson.objectId); assert.equal(created.data.lesson_revision, 1);
  assert.equal(skipped.data.lesson_id, null); assert.equal(skipped.data.lesson_revision, null);
  const original = await client.call('read', { ref: created.data.source_object_id, revision: created.data.source_revision });
  assert.equal(original.projectId, project); assert.deepEqual(Buffer.from(original.data.content), bytes);
  assert.equal(store.read(event.objectId, created.data.event_revision).data.summary, 'Original source outcome');
  assert.equal(store.read(lesson.objectId, created.data.lesson_revision).data.summary, 'Keep the intended result complete');
  assert.equal(store.read(event.objectId).revision, 2); assert.equal(store.read(lesson.objectId).revision, 2);
  const replay = await importNow('decision-history-replay'); assert.equal(replay.progress.imported, 0); assert.equal(replay.progress.unchanged, 4);
  assert.equal(store.read(created.objectId).revision, 1); assert.equal(store.read(original.objectId).revision, 1);
  assert.equal(store.migrationSourceOverview('').capturedFiles, 4);
  await assert.rejects(client.call('write', { kind: 'lesson_decision', action: 'patch', scope: project, objectId: created.objectId, expectedRevision: 1, idempotencyKey: 'ordinary-decision-forgery', data: { decision: 'created' } }), /action_requires_existing_authorization/);
  fs.renameSync(sourceRoot, path.join(path.dirname(sourceRoot), 'retained-original-decisions'));
  const overview = await readLearningOverview(workspace, root);
  assert.equal(overview.candidateDecisionCount, 2); assert.equal(overview.skippedCandidateDecisionCount, 1);
  assert.equal(fs.existsSync(sourceRoot), false);
}));

test('learning decisions preserve every candidate reference and reject missing legacy references', () => fixture(async ({ store, ops, workspace, project, sourceRoot, lesson, importNow }) => {
  fs.writeFileSync(path.join(sourceRoot, 'candidates', 'second.json'), JSON.stringify({ ...lesson, id: 'second-lesson', summary: 'Check the final behavior before using the next rule' }));
  const decision = { schemaVersion: 1, id: 'many-candidates', eventId: 'old-event', projectPath: workspace, decision: 'created', candidateIds: ['old-lesson', 'second-lesson'], reason: 'Original candidate extraction', checkedSignals: [], evidenceRefs: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  fs.writeFileSync(path.join(sourceRoot, 'candidate-decisions', 'many.json'), JSON.stringify(decision));
  fs.writeFileSync(path.join(sourceRoot, 'candidate-decisions', 'missing-event.json'), JSON.stringify({ ...decision, id: 'missing-event-decision', eventId: 'absent-old-event' }));
  fs.writeFileSync(path.join(sourceRoot, 'candidate-decisions', 'missing-lesson.json'), JSON.stringify({ ...decision, id: 'missing-lesson-decision', candidateIds: ['absent-old-lesson'] }));
  const status = await importNow('many-and-missing');
  assert.equal(status.status, 'completed_with_conflicts');
  assert.ok(status.progress.conflicts.some(item => item.error === 'learning_event_mapping_required'));
  assert.ok(status.progress.conflicts.some(item => item.error === 'learning_lesson_mapping_required'));
  const decisions = (await ops({ operation: 'search', input: { scope: project, kinds: ['lesson_decision'] } })).items;
  assert.equal(decisions.length, 1);
  const native = await ops({ operation: 'read', input: { ref: decisions[0].objectId } });
  const lessons = store.search({ scope: project, kinds: ['lesson'] }).items;
  assert.equal(native.data.candidate_refs.length, 2);
  assert.deepEqual(native.data.candidate_refs.map(ref => ref.objectId).sort(), lessons.map(item => item.objectId).sort());
  assert.ok(native.data.candidate_refs.every(ref => ref.revision === 1));
  assert.equal((await ops({ operation: 'read_learning_overview', input: {} })).candidateDecisionCount, 1, 'a decision with two candidates remains one original decision');
  const edited = store.write({ kind: 'lesson_decision', action: 'patch', scope: project, objectId: native.objectId, expectedRevision: 1, idempotencyKey: 'host-decision-reason', data: { reason: 'Reviewed original reason without changing its candidates' } });
  const current = await ops({ operation: 'read', input: { ref: edited.objectId } });
  assert.deepEqual(current.data.candidate_refs, native.data.candidate_refs, 'a reason edit must retain every original candidate relationship');
  assert.deepEqual((await ops({ operation: 'read', input: { ref: edited.objectId, revision: 1 } })).data.candidate_refs, native.data.candidate_refs);
  const archived = store.write({ kind: 'lesson_decision', action: 'archive', scope: project, objectId: edited.objectId, expectedRevision: 2, idempotencyKey: 'host-decision-archive', data: {} });
  assert.deepEqual((await ops({ operation: 'read', input: { ref: archived.objectId } })).data.candidate_refs, native.data.candidate_refs, 'archiving a decision must preserve all historical candidate relationships');
  assert.equal((await ops({ operation: 'read_learning_overview', input: {} })).candidateDecisionCount, 0);
}));
