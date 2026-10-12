const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createRuntimeDataOperations, runtimeMcpSource } = require('../out/runtimeDataOperations.js');
const { startRuntimeControlServer } = require('../out/autonomousRuntimeControl.js');
const ledger = require('../out/learningLedger.js');

async function fixture(action) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-learning-database-'));
  const root = path.join(base, '.solomap-global');
  const workspace = path.join(base, 'project'); fs.mkdirSync(workspace);
  const store = new UnifiedDataStore(root); const ops = createRuntimeDataOperations(store);
  const server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'learning-owner', onCommand: () => ({ status: 'running' }), onData: ops });
  let client;
  try {
    const project = (await ops({ operation: 'register_project', input: { root: workspace } })).projectId;
    client = runtimeMcpSource(root, project, true);
    const write = (key, data = {}, scope = project) => store.write({ kind: 'lesson', action: 'create', scope, idempotencyKey: key, data: { status: 'candidate', summary: key, applies_when: 'Changing behavior', do_this: 'Check actual outcomes', avoid_this: 'Do not guess', verification: 'Observe the final result', confidence: 0.9, ...data } });
    await action({ store, ops, root, workspace, project, client, write });
  } finally { if (client) await client.close(); await server.close(); await ops.close(); store.close(); }
}

async function importedLessonWithTwoSources({ root, workspace, project, store, ops }) {
  const sourceRoot = path.join(root, 'learning');
  for (const folder of ['ledger', 'candidates']) fs.mkdirSync(path.join(sourceRoot, folder), { recursive: true });
  const sourceIds = ['old-first-event', 'old-second-event'];
  const createdAt = '2026-01-01T00:00:00Z';
  fs.writeFileSync(path.join(sourceRoot, 'ledger', 'events.jsonl'), sourceIds.map(id => JSON.stringify({ schemaVersion: 1, id, projectPath: workspace, sourceType: 'solo', sourceRef: 'old-run', eventType: 'completed', summary: id, evidenceRefs: [], tags: [], createdAt })).join('\n') + '\n');
  fs.writeFileSync(path.join(sourceRoot, 'candidates', 'original.json'), JSON.stringify({ schemaVersion: 1, id: 'two-source-lesson', projectPath: workspace, status: 'candidate', sourceEventIds: sourceIds, summary: 'Keep both original sources', appliesWhen: 'Using a derived lesson', doThis: 'Read the actual sources', avoidThis: 'Do not replace evidence', evidenceRefs: [], createdAt, updatedAt: createdAt }));
  const job = await ops({ operation: 'import_project_data', input: { collection: 'learning', sourceRoot, projectScopes: { [workspace]: project }, idempotencyKey: 'two-source-import' } });
  await ops.waitForMigrations(); assert.equal(store.readMigrationJob(job.jobId).status, 'completed');
  const events = new Map(store.search({ scope: project, kinds: ['learning_event'] }).items.map(event => [JSON.parse(store.read(event.data.source_object_id, event.data.source_revision).data.content).id, event]));
  const lesson = store.search({ scope: project, kinds: ['lesson'] }).items[0];
  return { lesson, sourceIds, events, refs: sourceIds.map(sourceId => ({ sourceId, objectId: events.get(sourceId).objectId, revision: 1 })) };
}

for (const forgery of ['different-event', 'null-source', 'legacy-different-event', 'legacy-null-source']) {
  test(`ordinary edits of an imported lesson reject a ${forgery} source forgery`, () => fixture(async context => {
    const { store, project, client } = context; const { lesson, refs } = await importedLessonWithTwoSources(context);
    const declared = forgery.startsWith('legacy-') ? refs[0].sourceId : refs[0].objectId;
    const target = forgery.endsWith('null-source') ? null : refs[1].objectId;
    await assert.rejects(client.call('write', { kind: 'lesson', action: 'patch', scope: project, objectId: lesson.objectId, expectedRevision: 1, idempotencyKey: `imported-forgery:${forgery}`, data: { event_refs: [{ sourceId: declared, objectId: target, revision: target === null ? null : 1 }] } }), /learning_event_reference_mismatch/);
    assert.equal(store.read(lesson.objectId).revision, 1);
    assert.deepEqual(store.read(lesson.objectId).data.event_refs, refs);
  }));
}

for (const action of ['create', 'patch']) {
  test(`ordinary ${action} rejects an unbound alias pointing to an existing event`, () => fixture(async context => {
    const { store, project, client } = context;
    const { lesson, refs } = await importedLessonWithTwoSources(context);
    const data = { event_refs: [{ sourceId: 'unbound-old-event', objectId: refs[0].objectId, revision: 1 }] };
    const input = action === 'patch'
      ? { objectId: lesson.objectId, expectedRevision: 1, data }
      : { data: { status: 'candidate', summary: 'Use a declared source', applies_when: 'Checking evidence', do_this: 'Read the source', avoid_this: 'Do not invent identity', ...data } };
    await assert.rejects(client.call('write', { kind: 'lesson', action, scope: project, idempotencyKey: `unbound-source:${action}`, ...input }), /learning_event_reference_mismatch/);
    assert.equal(store.search({ scope: project, kinds: ['lesson'] }).items.length, 1);
    assert.equal(store.read(lesson.objectId).revision, 1);
    assert.deepEqual(store.read(lesson.objectId).data.event_refs, refs);
  }));
}

test('resolved legacy sources retain fixed references across reorder removal and addition', () => fixture(async context => {
  const { project, store, client } = context; const { lesson, sourceIds, events, refs } = await importedLessonWithTwoSources(context);
  const event = events.get(sourceIds[1]);
  store.write({ kind: 'learning_event', action: 'patch', scope: project, objectId: event.objectId, expectedRevision: 1, idempotencyKey: 'retained-source-new-head', data: { summary: 'A later claim' } });
  const patch = (revision, key, ids) => client.call('write', { kind: 'lesson', action: 'patch', scope: project, objectId: lesson.objectId, expectedRevision: revision, idempotencyKey: key, data: { source_event_ids_json: ids } });
  const reordered = await patch(1, 'reorder-resolved-aliases', [...sourceIds].reverse());
  assert.deepEqual(store.read(reordered.objectId).data.event_refs, [...refs].reverse());
  const reduced = await patch(2, 'remove-first-alias', [sourceIds[1]]);
  assert.deepEqual(store.read(reduced.objectId).data.event_refs, [refs[1]]);
  const added = await patch(3, 'add-native-source', [sourceIds[1], refs[0].objectId]);
  assert.deepEqual(store.read(added.objectId).data.event_refs, [refs[1], { sourceId: refs[0].objectId, objectId: refs[0].objectId, revision: 1 }]);
  const restored = await patch(4, 'restore-resolved-legacy-source', [sourceIds[1], refs[0].objectId, sourceIds[0]]);
  assert.deepEqual(store.read(restored.objectId).data.event_refs, [refs[1], { sourceId: refs[0].objectId, objectId: refs[0].objectId, revision: 1 }, refs[0]]);
  assert.deepEqual(store.read(added.objectId, 1).data.event_refs, refs);
}));

test('imported lessons retain fixed event provenance through edits links archives and legacy source removal', () => fixture(async ({ root, workspace, project, store, ops, client }) => {
  const sourceRoot = path.join(root, 'learning');
  for (const folder of ['ledger', 'candidates']) fs.mkdirSync(path.join(sourceRoot, folder), { recursive: true });
  const event = { schemaVersion: 1, id: 'old-provenance-event', projectId: 'old', projectPath: workspace, projectName: 'Project', sourceType: 'solo', sourceRef: 'old-run', eventType: 'completed', summary: 'Original observed outcome', evidenceRefs: [], tags: [], createdAt: '2026-01-01T00:00:00Z' };
  const candidate = { schemaVersion: 1, id: 'old-provenance-lesson', projectPath: workspace, status: 'candidate', sourceEventIds: [event.id], summary: 'Keep the original outcome attached', appliesWhen: 'Using a derived lesson', doThis: 'Read the actual source', avoidThis: 'Do not replace historical evidence with the newest claim', evidenceRefs: [], confidence: 'medium', createdAt: event.createdAt, updatedAt: event.createdAt };
  fs.writeFileSync(path.join(sourceRoot, 'ledger', 'events.jsonl'), JSON.stringify(event) + '\n');
  fs.writeFileSync(path.join(sourceRoot, 'candidates', 'original.json'), JSON.stringify(candidate));
  const job = await ops({ operation: 'import_project_data', input: { collection: 'learning', sourceRoot, projectScopes: { [workspace]: project }, idempotencyKey: 'lesson-event-provenance' } });
  await ops.waitForMigrations(); assert.equal(store.readMigrationJob(job.jobId).status, 'completed');
  const lesson = store.search({ scope: project, kinds: ['lesson'] }).items[0];
  const nativeEvent = store.search({ scope: project, kinds: ['learning_event'] }).items[0];
  const expected = [{ sourceId: event.id, objectId: nativeEvent.objectId, revision: 1 }];
  assert.deepEqual((await client.call('read', { ref: lesson.objectId })).data.event_refs, expected);
  store.write({ kind: 'learning_event', action: 'patch', scope: project, objectId: nativeEvent.objectId, expectedRevision: 1, idempotencyKey: 'provenance-event-new-claim', data: { summary: 'Later changed outcome' } });
  const edited = store.write({ kind: 'lesson', action: 'patch', scope: project, objectId: lesson.objectId, expectedRevision: 1, idempotencyKey: 'provenance-lesson-edit', data: { summary: 'Updated lesson wording' } });
  const linked = store.link({ source: lesson.objectId, target: nativeEvent.data.source_object_id, relation: 'evidence', expectedRevision: edited.revision, idempotencyKey: 'provenance-lesson-link' });
  const archived = store.write({ kind: 'lesson', action: 'archive', scope: project, objectId: lesson.objectId, expectedRevision: linked.revision, idempotencyKey: 'provenance-lesson-archive', data: {} });
  assert.deepEqual(store.read(archived.objectId).data.event_refs, expected);
  assert.deepEqual(store.read(archived.objectId, 1).data.event_refs, expected);
  fs.renameSync(sourceRoot, path.join(root, 'retained-provenance-source'));
  assert.equal((await client.call('read', { ref: expected[0].objectId, revision: expected[0].revision })).data.summary, 'Original observed outcome');
  const destination = path.join(root, 'exports', 'lesson.json');
  await store.export({ ref: archived.objectId, format: 'json', destination, idempotencyKey: 'lesson-provenance-export' });
  assert.deepEqual(JSON.parse(fs.readFileSync(destination, 'utf8')).data.event_refs, expected);
  const replay = await ops({ operation: 'import_project_data', input: { collection: 'learning', sourceRoot: path.join(root, 'retained-provenance-source'), sourceIdentity: `learning:${sourceRoot}`, projectScopes: { [workspace]: project }, idempotencyKey: 'lesson-event-provenance-replay' } });
  await ops.waitForMigrations(); assert.equal(store.readMigrationJob(replay.jobId).progress.unchanged, 2);
  assert.equal(store.read(archived.objectId).revision, 4);
}));

test('a later event import resolves only the new lesson version and unchanged replay stays idempotent', () => fixture(async ({ root, workspace, project, store, ops }) => {
  const sourceRoot = path.join(root, 'learning'); fs.mkdirSync(path.join(sourceRoot, 'candidates'), { recursive: true });
  const candidate = { schemaVersion: 1, id: 'waiting-lesson', projectPath: workspace, status: 'candidate', sourceEventIds: ['later-event'], summary: 'Preserve the declared source while it is unavailable', appliesWhen: 'Checking the source', doThis: 'Read the original event', avoidThis: 'Do not invent evidence', evidenceRefs: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  fs.writeFileSync(path.join(sourceRoot, 'candidates', 'waiting.json'), JSON.stringify(candidate));
  const importNow = async key => { const job = await ops({ operation: 'import_project_data', input: { collection: 'learning', sourceRoot, projectScopes: { [workspace]: project }, idempotencyKey: key } }); await ops.waitForMigrations(); return store.readMigrationJob(job.jobId); };
  await importNow('before-event-source'); const lesson = store.search({ scope: project, kinds: ['lesson'] }).items[0];
  assert.deepEqual(store.read(lesson.objectId).data.event_refs, [{ sourceId: 'later-event', objectId: null, revision: null }]);
  fs.mkdirSync(path.join(sourceRoot, 'ledger'));
  fs.writeFileSync(path.join(sourceRoot, 'ledger', 'events.jsonl'), JSON.stringify({ schemaVersion: 1, id: 'later-event', projectPath: workspace, sourceType: 'solo', sourceRef: 'old-source', eventType: 'completed', summary: 'The original event has now been imported', evidenceRefs: [], tags: [], createdAt: candidate.createdAt }) + '\n');
  assert.equal((await importNow('with-event-source')).status, 'completed');
  const event = store.search({ scope: project, kinds: ['learning_event'] }).items[0];
  assert.deepEqual(store.read(lesson.objectId).data.event_refs, [{ sourceId: 'later-event', objectId: event.objectId, revision: 1 }]);
  assert.equal(store.read(lesson.objectId).revision, 2);
  assert.deepEqual(store.read(lesson.objectId, 1).data.event_refs, [{ sourceId: 'later-event', objectId: null, revision: null }]);
  await importNow('resolved-source-replay'); assert.equal(store.read(lesson.objectId).revision, 2);
}));

test('native lesson source references pin versions allow global sources and reject private cross-project sources', () => fixture(async ({ project, store, client, write }) => {
  assert.equal(require('../out/db/dataSchema.js').dataSchema().kinds.lesson.fields.event_refs?.type, 'json', 'the formal schema must describe the source reference input');
  const createEvent = (scope, key) => {
    const evidence = store.write({ kind: 'evidence', action: 'create', scope, idempotencyKey: `${key}:evidence`, data: { type: 'host_observation', source_actor_id: 'local-runtime', observed_at: Date.now(), content: `Source ${key}` } });
    return store.write({ kind: 'learning_event', action: 'create', scope, idempotencyKey: `${key}:event`, data: { source_object_id: evidence.objectId, source_revision: 1, event_type: 'completed', summary: `Outcome ${key}`, occurred_at: Date.now() } });
  };
  const own = createEvent(project, 'own'); const shared = createEvent(null, 'shared');
  const other = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'private-source-project', data: { name: 'Private source project' } });
  const foreign = createEvent(other.objectId, 'foreign');
  const created = write('native-source-lesson', { source_event_ids_json: [own.objectId, shared.objectId] });
  const expected = [{ sourceId: own.objectId, objectId: own.objectId, revision: 1 }, { sourceId: shared.objectId, objectId: shared.objectId, revision: 1 }];
  assert.deepEqual(store.read(created.objectId).data.event_refs, expected);
  store.write({ kind: 'learning_event', action: 'patch', scope: project, objectId: own.objectId, expectedRevision: 1, idempotencyKey: 'own-event-change', data: { summary: 'New claim' } });
  const same = await client.call('write', { kind: 'lesson', action: 'patch', scope: project, objectId: created.objectId, expectedRevision: 1, idempotencyKey: 'same-source-list', data: { source_event_ids_json: [own.objectId, shared.objectId], summary: 'New lesson wording' } });
  assert.deepEqual(store.read(same.objectId).data.event_refs, expected);
  assert.throws(() => write('private-source-forgery', { source_event_ids_json: [foreign.objectId] }), /scope_mismatch/);
  assert.throws(() => store.write({ kind: 'lesson', action: 'patch', scope: project, objectId: created.objectId, expectedRevision: 2, idempotencyKey: 'invalid-explicit-source', data: { event_refs: [{ sourceId: own.objectId, objectId: foreign.objectId, revision: 1 }, expected[1]] } }), /scope_mismatch/);
  assert.throws(() => store.write({ kind: 'lesson', action: 'patch', scope: project, objectId: created.objectId, expectedRevision: 2, idempotencyKey: 'mismatched-native-source', data: { event_refs: [{ sourceId: own.objectId, objectId: shared.objectId, revision: 1 }, expected[1]] } }), /learning_event_reference_mismatch/);
  assert.throws(() => store.write({ kind: 'lesson', action: 'patch', scope: project, objectId: created.objectId, expectedRevision: 2, idempotencyKey: 'missing-native-source', data: { event_refs: [{ sourceId: own.objectId, objectId: null, revision: null }, expected[1]] } }), /learning_event_reference_mismatch/);
  assert.throws(() => write('forged-legacy-source-identity', { legacy_lesson_id: 'claimed-history', source_event_ids_json: [own.objectId], event_refs: [{ sourceId: own.objectId, objectId: null, revision: null }] }), /learning_event_reference_mismatch/, 'an editable legacy label is not an authenticated import binding');
  assert.equal(store.read(created.objectId).revision, 2);
  const formatted = await client.call('write', { kind: 'lesson', action: 'patch', scope: project, objectId: created.objectId, expectedRevision: 2, idempotencyKey: 'format-only-source-list', data: { source_event_ids_json: JSON.stringify([own.objectId, shared.objectId], null, 2) } });
  assert.deepEqual(store.read(formatted.objectId).data.event_refs, expected, 'formatting the same declared IDs must not repin them to later source versions');
  const changed = await client.call('write', { kind: 'lesson', action: 'patch', scope: project, objectId: created.objectId, expectedRevision: 3, idempotencyKey: 'replace-source-list', data: { source_event_ids_json: [own.objectId] } });
  assert.deepEqual(store.read(changed.objectId).data.event_refs, [expected[0]], 'removing another source does not adopt a newer version of the retained one');
  assert.deepEqual(store.read(changed.objectId, 1).data.event_refs, expected);
  const adopted = await client.call('write', { kind: 'lesson', action: 'patch', scope: project, objectId: created.objectId, expectedRevision: 4, idempotencyKey: 'adopt-explicit-source-version', data: { event_refs: [{ sourceId: own.objectId, objectId: own.objectId, revision: 2 }] } });
  assert.deepEqual(store.read(adopted.objectId).data.event_refs, [{ sourceId: own.objectId, objectId: own.objectId, revision: 2 }]);
  assert.deepEqual(store.read(adopted.objectId, 4).data.event_refs, [expected[0]]);
}));

test('the formal lesson reference list works without requiring callers to mirror internal source fields', () => fixture(async ({ project, store, client, write }) => {
  const evidence = store.write({ kind: 'evidence', action: 'create', scope: project, idempotencyKey: 'reference-only-evidence', data: { type: 'host_observation', source_actor_id: 'local-runtime', observed_at: Date.now(), content: 'Original result' } });
  const event = store.write({ kind: 'learning_event', action: 'create', scope: project, idempotencyKey: 'reference-only-event', data: { source_object_id: evidence.objectId, source_revision: 1, event_type: 'completed', summary: 'Original result', occurred_at: Date.now() } });
  const refs = [{ sourceId: event.objectId, objectId: event.objectId, revision: 1 }];
  const input = { kind: 'lesson', action: 'create', scope: project, idempotencyKey: 'reference-only-lesson', data: { status: 'candidate', summary: 'Use the original result', event_refs: refs } };
  const created = await client.call('write', input);
  assert.deepEqual((await client.call('read', { ref: created.objectId })).data.event_refs, refs);
  assert.deepEqual(JSON.parse(store.read(created.objectId).data.source_event_ids_json), [event.objectId]);
  assert.deepEqual(await client.call('write', input), created);
  const cleared = await client.call('write', { kind: 'lesson', action: 'patch', scope: project, objectId: created.objectId, expectedRevision: 1, idempotencyKey: 'reference-only-clear', data: { event_refs: [] } });
  assert.deepEqual(store.read(cleared.objectId).data.event_refs, []);
  assert.deepEqual(store.read(cleared.objectId, 1).data.event_refs, refs);
  assert.throws(() => write('conflicting-reference-input', { source_event_ids_json: [], event_refs: refs }), /learning_event_reference_invalid/);
}));

test('late source resolution preserves newer lesson edits and the original import conflict boundary', () => fixture(async ({ root, workspace, project, store, ops }) => {
  const sourceRoot = path.join(root, 'learning'); fs.mkdirSync(path.join(sourceRoot, 'candidates'), { recursive: true });
  const candidate = { schemaVersion: 1, id: 'edited-waiting-lesson', projectPath: workspace, status: 'candidate', sourceEventIds: ['first-late-event', 'second-late-event'], summary: 'Original wording', appliesWhen: 'Checking the source', doThis: 'Read the original event', avoidThis: 'Do not invent evidence', evidenceRefs: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  const file = path.join(sourceRoot, 'candidates', 'waiting.json'); fs.writeFileSync(file, JSON.stringify(candidate));
  const importNow = async key => { const job = await ops({ operation: 'import_project_data', input: { collection: 'learning', sourceRoot, projectScopes: { [workspace]: project }, idempotencyKey: key } }); await ops.waitForMigrations(); return store.readMigrationJob(job.jobId); };
  assert.equal((await importNow('edited-before-sources')).status, 'completed');
  const lesson = store.search({ scope: project, kinds: ['lesson'] }).items[0];
  store.write({ kind: 'lesson', action: 'patch', scope: project, objectId: lesson.objectId, expectedRevision: 1, idempotencyKey: 'edited-before-sources-wording', data: { summary: 'My newer wording', source_event_ids_json: [...candidate.sourceEventIds].reverse() } });
  fs.mkdirSync(path.join(sourceRoot, 'ledger'));
  fs.writeFileSync(path.join(sourceRoot, 'ledger', 'events.jsonl'), candidate.sourceEventIds.map(id => JSON.stringify({ schemaVersion: 1, id, projectPath: workspace, sourceType: 'solo', sourceRef: 'old-source', eventType: 'completed', summary: id, evidenceRefs: [], tags: [], createdAt: candidate.createdAt })).join('\n') + '\n');
  assert.equal((await importNow('edited-with-sources')).status, 'completed');
  const resolved = store.read(lesson.objectId);
  assert.equal(resolved.revision, 3); assert.equal(resolved.data.summary, 'My newer wording');
  assert.deepEqual(resolved.data.event_refs.map(ref => ref.sourceId), [...candidate.sourceEventIds].reverse());
  for (const ref of resolved.data.event_refs) {
    const event = store.read(ref.objectId, ref.revision);
    assert.equal(JSON.parse(store.read(event.data.source_object_id, event.data.source_revision).data.content).id, ref.sourceId);
  }
  assert.ok(store.read(lesson.objectId, 2).data.event_refs.every(ref => ref.objectId === null));
  await importNow('edited-sources-replay'); assert.equal(store.read(lesson.objectId).revision, 3);
  fs.writeFileSync(file, JSON.stringify({ ...candidate, summary: 'Older file must not overwrite my edit', updatedAt: '2026-01-02T00:00:00Z' }));
  assert.equal((await importNow('edited-source-changed')).status, 'completed_with_conflicts');
  assert.equal(store.read(lesson.objectId).data.summary, 'My newer wording');
}));

test('background learning ledger import preserves scoped sources and verified history without legacy reads', () => fixture(async ({ root, workspace, project, store, ops }) => {
  const otherRoot = path.join(path.dirname(workspace), 'other-project'); fs.mkdirSync(otherRoot);
  const other = (await ops({ operation: 'register_project', input: { root: otherRoot } })).projectId;
  const sourceRoot = path.join(root, 'learning'); fs.mkdirSync(path.join(sourceRoot, 'ledger'), { recursive: true });
  const event = { schemaVersion: 1, id: 'same-old-event', projectId: 'old-slug', projectPath: workspace, projectName: 'Project', sourceType: 'solo', sourceRef: 'old-source', eventType: 'verified', summary: 'The actual outcome was checked', evidenceRefs: [{ type: 'command', ref: 'npm test' }], tags: ['verification'], createdAt: '2026-01-01T00:00:00Z', metadata: { verification: ['Command: npm test'], unknown: { full: '保留🌿' } }, unrecognized: ['original extension'] };
  const firstLine = Buffer.from('\uFEFF' + JSON.stringify(event));
  const secondLine = Buffer.from(JSON.stringify({ ...event, projectPath: otherRoot, metadata: { verification: ['Run completed without explicit verification signal in captured tail.'] } }));
  const bytes = Buffer.concat([firstLine, Buffer.from('\r\n'), secondLine, Buffer.from('\n')]);
  const file = path.join(sourceRoot, 'ledger', 'events.jsonl'); fs.writeFileSync(file, bytes);
  const observedAfter = Date.now();
  const input = { collection: 'learning', sourceRoot, projectScopes: { [workspace]: project, [otherRoot]: other } };
  const first = await ops({ operation: 'import_project_data', input: { ...input, idempotencyKey: 'old-event-history' } }); await ops.waitForMigrations();
  const status = await ops({ operation: 'migration_status', input: { jobId: first.jobId } });
  assert.equal(status.status, 'completed', status.error);
  assert.equal(status.progress.imported, 2, 'each event must become its own typed object');
  const local = store.search({ scope: project, kinds: ['learning_event'] }).items;
  const foreign = store.search({ scope: other, kinds: ['learning_event'] }).items;
  assert.equal(local.length, 1); assert.equal(foreign.length, 1); assert.notEqual(local[0].objectId, foreign[0].objectId);
  assert.equal(local[0].data.source_type, 'solo'); assert.equal(local[0].data.verification_signal, 1); assert.equal(foreign[0].data.verification_signal, 0);
  const original = store.read(local[0].data.source_object_id, local[0].data.source_revision);
  assert.equal(original.projectId, project); assert.deepEqual(Buffer.from(original.data.content), firstLine);
  assert.deepEqual(store.readMigrationSource(`learning:${sourceRoot}`, 'ledger/events.jsonl').bytes, bytes);
  assert.equal(store.migrationSourceOverview('').capturedFiles, 1, 'one physical ledger must not be reported as one file for every event or evidence binding');
  assert.ok(original.data.observed_at >= observedAfter, 'source evidence records when this runtime actually observed the imported bytes');
  const beforeSequence = store.rows('SELECT max(sequence) AS last FROM events')[0].last;
  const repeated = await ops({ operation: 'import_project_data', input: { ...input, idempotencyKey: 'old-event-history-repeat' } }); await ops.waitForMigrations();
  const repeatedStatus = await ops({ operation: 'migration_status', input: { jobId: repeated.jobId } });
  assert.equal(repeatedStatus.progress.imported, 0); assert.equal(repeatedStatus.progress.unchanged, 2);
  assert.equal(store.read(local[0].objectId).revision, 1); assert.equal(store.read(original.objectId).revision, 1);
  assert.equal(store.rows("SELECT count(*) AS n FROM events WHERE sequence>? AND kind NOT LIKE 'migration.%'", [beforeSequence])[0].n, 0, 'unchanged replay must not create new event or evidence versions');
  fs.renameSync(sourceRoot, path.join(root, 'retained-learning-source'));
  const overview = await ops({ operation: 'read_learning_overview', input: {} });
  assert.equal(overview.eventCount, 2);
  assert.equal(overview.projectSignals.find(item => item.projectId === project).verificationSignals, 1);
  assert.equal(overview.projectSignals.find(item => item.projectId === other).verificationSignals, 0);
  assert.equal(fs.existsSync(sourceRoot), false, 'normal reads must not recreate the legacy source');
}));

test('learning ledger conflicts retain the whole source and never guess a project or overwrite native changes', () => fixture(async ({ root, workspace, project, store, ops }) => {
  const sourceRoot = path.join(root, 'learning'); fs.mkdirSync(path.join(sourceRoot, 'ledger'), { recursive: true });
  const file = path.join(sourceRoot, 'ledger', 'events.jsonl');
  const event = { schemaVersion: 1, id: 'legacy-feedback', projectId: 'slug-is-not-authority', projectPath: workspace, projectName: 'Project', sourceType: 'user_correction', sourceRef: 'old-input', eventType: 'corrected', summary: 'Keep the complete requested outcome', evidenceRefs: [], tags: [], createdAt: '2026-01-01T00:00:00Z', metadata: { keepUnknown: true } };
  const importNow = async key => {
    const job = await ops({ operation: 'import_project_data', input: { collection: 'learning', sourceRoot, projectScopes: { [workspace]: project }, idempotencyKey: key } });
    await ops.waitForMigrations(); return ops({ operation: 'migration_status', input: { jobId: job.jobId } });
  };
  const bytes = Buffer.from([JSON.stringify(event), JSON.stringify({ ...event, id: 'unknown', projectPath: path.join(workspace, 'missing') }), JSON.stringify({ ...event, id: 'duplicate', summary: 'First claim' }), JSON.stringify({ ...event, id: 'duplicate', summary: 'Incompatible second claim' }), JSON.stringify({ ...event, id: 'invalid-time', createdAt: 'bad-date' }), '{broken original line'].join('\n'));
  fs.writeFileSync(file, bytes);
  const partial = await importNow('conflicted-history');
  assert.equal(partial.status, 'completed_with_conflicts'); assert.equal(partial.progress.imported, 1);
  assert.ok(partial.progress.conflicts.some(item => item.error === 'project_scope_mapping_required'));
  assert.equal(partial.progress.conflicts.filter(item => item.error.includes('ambiguous_learning_event_identity')).length, 2);
  assert.ok(partial.progress.conflicts.some(item => item.error === 'legacy_learning_event_timestamp_invalid'));
  const captured = store.readMigrationSource(`learning:${sourceRoot}`, 'ledger/events.jsonl'); assert.deepEqual(captured.bytes, bytes); assert.equal(captured.stage, 'unmapped');
  const replay = await importNow('conflicted-history-replay');
  assert.equal(replay.progress.imported, 0); assert.equal(replay.progress.unchanged, 1);
  assert.equal(store.readMigrationSource(`learning:${sourceRoot}`, 'ledger/events.jsonl').sourceRevision, captured.sourceRevision, 'unchanged conflicts must not generate capture history on every replay');
  const original = store.search({ scope: project, kinds: ['learning_event'] }).items; assert.equal(original.length, 1);
  const native = store.write({ kind: 'learning_event', action: 'patch', scope: project, objectId: original[0].objectId, expectedRevision: 1, idempotencyKey: 'current-native-feedback', data: { summary: 'Preserve this newer native decision' } });
  const evidenceBefore = store.read(original[0].data.source_object_id);
  fs.writeFileSync(file, JSON.stringify({ ...event, summary: 'An edited older file' }) + '\n');
  const changed = await importNow('conflicted-history-changed');
  assert.equal(changed.status, 'completed_with_conflicts'); assert.equal(changed.progress.imported, 0);
  assert.match(changed.progress.conflicts[0].error, /newer_database_revision/);
  assert.equal(store.read(native.objectId).data.summary, 'Preserve this newer native decision');
  assert.equal(store.read(native.objectId).revision, 2);
  assert.deepEqual(store.read(evidenceBefore.objectId), evidenceBefore, 'failed event import must roll back its source evidence revision');
  assert.equal(store.read(native.objectId, 1).data.summary, 'Keep the complete requested outcome');
  assert.deepEqual(fs.readFileSync(file), store.readMigrationSource(`learning:${sourceRoot}`, 'ledger/events.jsonl').bytes);
}));

test('learning ledger background import resumes after owner restart without duplicating events or evidence', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-learning-ledger-restart-'));
  const root = path.join(base, '.solomap-global'); const workspace = path.join(base, 'project'); fs.mkdirSync(workspace);
  let store = new UnifiedDataStore(root); let ops = createRuntimeDataOperations(store); let server;
  try {
    const project = (await ops({ operation: 'register_project', input: { root: workspace } })).projectId;
    const sourceRoot = path.join(root, 'learning'); fs.mkdirSync(path.join(sourceRoot, 'ledger'), { recursive: true });
    const rows = Array.from({ length: 45 }, (_, i) => ({ schemaVersion: 1, id: `feedback-${i}`, projectId: 'old', projectPath: workspace, projectName: 'Project', sourceType: 'solo', sourceRef: `old-${i}`, eventType: 'failed', summary: `Preserved original feedback ${i}`, evidenceRefs: [], tags: [], createdAt: '2026-01-01T00:00:00Z' }));
    fs.writeFileSync(path.join(sourceRoot, 'ledger', 'events.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const importing = store.importLearningEventSource.bind(store); let imported = 0; let closing;
    store.importLearningEventSource = (...args) => { const receipt = importing(...args); if (++imported === 7) closing = ops.close(); return receipt; };
    const job = await ops({ operation: 'import_project_data', input: { collection: 'learning', sourceRoot, projectScopes: { [workspace]: project }, idempotencyKey: 'restart-ledger' } });
    await ops.waitForMigrations(); if (closing) await closing;
    assert.equal(store.readMigrationJob(job.jobId).status, 'interrupted'); assert.equal(imported, 7);
    const pinned = store.search({ scope: project, kinds: ['learning_event'] }).items[0];
    store.close(); store = new UnifiedDataStore(root); ops = createRuntimeDataOperations(store);
    ops.recoverMigrations(); await ops.waitForMigrations();
    assert.equal(store.readMigrationJob(job.jobId).status, 'completed');
    assert.equal(store.search({ scope: project, kinds: ['learning_event'], limit: 100 }).items.length, 45);
    assert.equal(store.search({ scope: project, kinds: ['evidence'], limit: 100 }).items.length, 45);
    assert.equal(store.read(pinned.objectId).revision, 1); assert.equal(store.read(pinned.data.source_object_id).revision, 1);
    fs.renameSync(sourceRoot, path.join(root, 'retained-learning-originals'));
    server = await startRuntimeControlServer({ globalDataPath: root, runtimeId: 'restarted-learning-owner', onCommand: () => ({ status: 'running' }), onData: ops });
    const overview = await ledger.readLearningOverview(workspace, root); assert.equal(overview.eventCount, 45); assert.equal(overview.projectSignals[0].riskSignals, 45);
    assert.equal(fs.existsSync(sourceRoot), false);
  } finally { if (server) await server.close(); await ops.close(); store.close(); }
});

test('formal lesson records retain role, provenance and legacy identity across revisions', () => fixture(async ({ client, project }) => {
  const input = { kind: 'lesson', action: 'create', scope: project, idempotencyKey: 'role-and-source', data: { status: 'candidate', summary: 'Validate login', confidence: 0.8, lesson_type: 'verification_pattern', source_type: 'flow_loop', promotion_target: 'project_memory', legacy_lesson_id: 'lesson-legacy-1', evidence_refs_json: [{ type: 'command', ref: 'npm test', summary: 'Login regression passed' }], source_event_ids_json: ['event-legacy-1'] } };
  let receipt;
  await assert.doesNotReject(async () => { receipt = await client.call('write', input); }, 'the shared operation must retain the existing lesson role and evidence');
  const first = await client.call('read', { ref: receipt.objectId, revision: receipt.revision });
  assert.equal(first.data.lesson_type, 'verification_pattern');
  assert.equal(first.data.source_type, 'flow_loop');
  assert.equal(first.data.promotion_target, 'project_memory');
  assert.equal(first.data.legacy_lesson_id, 'lesson-legacy-1');
  assert.deepEqual(JSON.parse(first.data.evidence_refs_json), [{ type: 'command', ref: 'npm test', summary: 'Login regression passed' }]);
  assert.deepEqual(JSON.parse(first.data.source_event_ids_json), ['event-legacy-1']);
  const next = await client.call('write', { kind: 'lesson', action: 'patch', scope: project, objectId: receipt.objectId, expectedRevision: 1, idempotencyKey: 'role-update', data: { verification: 'Observe authenticated response' } });
  const old = await client.call('read', { ref: receipt.objectId, revision: 1 });
  const current = await client.call('read', { ref: receipt.objectId });
  assert.equal(old.data.verification, null);
  assert.equal(current.data.verification, 'Observe authenticated response');
  assert.equal(next.revision, 2);
  assert.equal(current.data.lesson_type, 'verification_pattern');
  await assert.rejects(client.call('write', { kind: 'lesson', action: 'patch', scope: project, objectId: receipt.objectId, expectedRevision: 2, idempotencyKey: 'self-approval', data: { status: 'approved' } }), /promotion_requires_existing_review/);
}));

test('ordinary learning metadata selects only lessons and rejects unrelated kind escalation', () => fixture(async ({ store, project, client, write }) => {
  const local = write('local'); const global = write('global', { status: 'approved' }, null);
  write('private-global', {}, null);
  for (let i = 0; i < 30; i++) store.write({ kind: 'memory', action: 'create', scope: project, idempotencyKey: `irrelevant-${i}`, data: { category: 'rules', title: 'Unrelated memory', status: 'active', content: 'History🌿'.repeat(10000) } });
  const seen = []; let cursor;
  do {
    const page = await client.call('context', { project, kinds: ['lesson'], view: 'metadata', limit: 1, ...(cursor ? { cursor } : {}) });
    assert.ok(page.items.every(item => item.kind === 'lesson'), 'learning pages must not transfer unrelated memory history');
    seen.push(...page.items); cursor = page.cursor;
  } while (cursor);
  assert.deepEqual(seen.map(item => item.objectId).sort(), [local.objectId, global.objectId].sort());
  await assert.rejects(client.call('context', { project, kinds: ['report'], view: 'metadata' }), /invalid_context_kinds/);
}));

test('actual learning prompt recalls formal candidates with fixed sources and no legacy directories', () => fixture(async ({ root, workspace, write, store }) => {
  const local = write('Keep the current user selection', { status: 'approved', do_this: 'Retain the selected mode during asynchronous refresh', does_not_apply_when: 'The user explicitly selects another mode' });
  write('Rejected mistake', { status: 'rejected' });
  write('Run completed without explicit verification signal in captured tail');
  write('Do check /home/ubuntu/project/.solopreneur/agent-runs/', { do_this: 'Do check /home/ubuntu/project/.solopreneur/agent-runs/' });
  write('Unreviewed global candidate', {}, null);
  write('Approved global rule', { status: 'approved' }, null);
  const other = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'foreign', data: { name: 'Foreign' } });
  write('Foreign project rule', { status: 'approved' }, other.objectId);
  const prompt = await ledger.buildLearningRetrievalContext(workspace, root, { projectPath: workspace, runKind: 'solo', contextText: 'unmatched words', limit: 10 });
  assert.match(prompt, /Keep the current user selection/, 'own-project experience must retain its existing project priority even without query matches');
  assert.match(prompt, /Approved global rule/);
  assert.match(prompt, new RegExp(`solomap://objects/${local.objectId}.*revision=1`));
  assert.match(prompt, /Retain the selected mode during asynchronous refresh/);
  assert.match(prompt, /The user explicitly selects another mode/);
  assert.doesNotMatch(prompt, /Rejected mistake|without explicit verification signal|Do check|Unreviewed global|Foreign project/);
  assert.equal(fs.existsSync(path.join(root, 'learning')), false, 'a normal prompt must not initialize legacy learning files');
  assert.deepEqual(fs.readdirSync(path.join(workspace, '.solopreneur')), ['project.json']);
}));

test('actual learning overview counts formal history without creating learning or metrics files', () => fixture(async ({ root, workspace, write, store, project, client }) => {
  const { buildSolomapLearningContext } = require('../out/solomapGlobal.js');
  const candidate = write('Retain the user selected mode while refreshed results arrive', { lesson_type: 'risk_pattern' });
  write('Read the checked runtime outcome before applying the next rule', { status: 'approved', lesson_type: 'verification_pattern' });
  write('Use the accepted shared constraint only within its intended boundary', { status: 'approved' }, null);
  write('Run completed without explicit verification signal in captured tail');
  write('Rejected source must not influence learning decisions', { status: 'rejected' });
  store.write({ kind: 'learning_event', action: 'create', scope: project, idempotencyKey: 'overview-failure', data: { source_object_id: candidate.objectId, source_revision: 1, event_type: 'failed', summary: 'The selected mode was lost', occurred_at: Date.now() } });
  const snapshot = () => fs.readdirSync(root).sort(); const before = snapshot();
  const first = await buildSolomapLearningContext(workspace, root);
  assert.deepEqual(snapshot(), before, 'ordinary prompt preparation must not create learning or metrics directories');
  assert.match(first, /待审核学习候选：1/);
  assert.match(first, /统一学习账本事件：1/);
  assert.match(first, /已确认\/已晋升经验：2/);
  assert.match(first, /project: 2候选\/2风险\/1验证/);
  assert.equal(await buildSolomapLearningContext(workspace, root), first);
  await assert.rejects(client.call('read_learning_overview', {}), /action_denied/, 'an ordinary project session must not gain cross-project host reads');
  assert.equal(fs.existsSync(path.join(root, 'learning')), false); assert.equal(fs.existsSync(path.join(root, 'metrics')), false);
}));

test('ordinary edits cannot rewrite an observed learning signal as a new claim', () => fixture(async ({ store, client, project, write }) => {
  const source = write('Keep the original verified conclusion attached to its evidence');
  const event = store.write({ kind: 'learning_event', action: 'create', scope: project, idempotencyKey: 'host-checked-event', data: { source_object_id: source.objectId, source_revision: 1, event_type: 'verified', summary: 'Original host observation', occurred_at: 0, verification_signal: 1 } });
  const input = { kind: 'learning_event', action: 'patch', scope: project, objectId: event.objectId, expectedRevision: 1, idempotencyKey: 'ordinary-event-edit', data: { summary: 'A different ordinary claim' } };
  await assert.rejects(client.call('write', input), /host_observation_requires_authorization/);
  assert.equal((await client.call('read', { ref: event.objectId })).data.verification_signal, 1);
  assert.equal((await client.call('read', { ref: event.objectId, revision: 1 })).data.verification_signal, 1);
  assert.equal(store.readLearningOverview().projectSignals[0].verificationSignals, 1);
}));

test('learning overview queries start from their own records and never decode unrelated history', () => fixture(async ({ store, ops, project, write }) => {
  write('Keep the original action while background history is refreshed');
  for (let i = 0; i < 30; i++) store.write({ kind: 'memory', action: 'create', scope: project, idempotencyKey: `overview-unrelated-history-${i}`, data: { category: 'history', title: `Large unrelated memory ${i}`, status: 'active', content: 'Unrelated retained history🌿'.repeat(10000) } });
  const rows = store.rows.bind(store); const queries = []; let capture = true;
  store.rows = (sql, values = []) => { const result = rows(sql, values); if (capture) queries.push({ sql, values }); return result; };
  const decoded = store.decodedContent.bind(store); let decodes = 0;
  store.decodedContent = (...args) => { decodes++; return decoded(...args); };
  const result = await ops({ operation: 'read_learning_overview', input: {} }); capture = false;
  assert.equal(result.candidateCount, 1); assert.equal(decodes, 0);
  const domainQueries = queries.filter(query => /FROM (lessons|lesson_decisions)\b/.test(query.sql));
  assert.equal(domainQueries.length, 2);
  for (const query of domainQueries) {
    const plan = rows('EXPLAIN QUERY PLAN ' + query.sql, query.values);
    assert.ok(!plan.some(row => /^SCAN o(?: |$)/.test(row.detail)), 'unrelated object kinds must not drive learning statistics');
  }
}));

test('learning event claims cannot insert an unreadable date or claim an observed verification signal', () => fixture(async ({ client, project, write }) => {
  const source = write('Preserve original feedback before changing behavior');
  const data = { source_object_id: source.objectId, source_revision: 1, event_type: 'failed', summary: 'Actual user feedback', occurred_at: 0 };
  for (const value of [1e20, 'invalid-date', 1.5]) await assert.rejects(client.call('write', { kind: 'learning_event', action: 'create', scope: project, idempotencyKey: `event-invalid-date-${value}`, data: { ...data, occurred_at: value } }), /learning_timestamp_invalid/);
  const valid = await client.call('write', { kind: 'learning_event', action: 'create', scope: project, idempotencyKey: 'valid-event-date', data });
  await assert.rejects(client.call('write', { kind: 'learning_event', action: 'patch', scope: project, objectId: valid.objectId, expectedRevision: 1, idempotencyKey: 'event-invalid-date-patch', data: { occurred_at: 1e20 } }), /learning_timestamp_invalid/);
  await assert.rejects(client.call('write', { kind: 'learning_event', action: 'patch', scope: project, objectId: valid.objectId, expectedRevision: 1, idempotencyKey: 'event-forged-observation', data: { verification_signal: 1 } }), /host_observation_requires_authorization/);
  assert.equal((await client.call('read', { ref: valid.objectId })).revision, 1);
}));

test('learning prompt finishes every lesson page and preserves role priority and duplicate suppression', () => fixture(async ({ root, workspace, write }) => {
  const verification = write('Verify the user-visible outcome', { status: 'approved', lesson_type: 'verification_pattern', evidence_refs_json: [{ type: 'command', ref: 'npm test', summary: 'Regression proved the response' }] });
  write('Build the smallest complete change', { status: 'approved', lesson_type: 'implementation_pattern' });
  for (let i = 0; i < 105; i++) write('Repeated generic advice', { status: 'approved', lesson_type: 'boundary_rule' });
  const prompt = await ledger.buildLearningRetrievalContext(workspace, root, { projectPath: workspace, runKind: 'solo', role: 'verifier', contextText: 'unmatched', limit: 200 });
  assert.match(prompt, /^SoloMap[^\n]*\n1\. Verify the user-visible outcome/);
  assert.equal((prompt.match(/Repeated generic advice/g) || []).length, 1);
  assert.match(prompt, /Build the smallest complete change/);
  assert.match(prompt, /npm test/);
  assert.match(prompt, new RegExp(`${verification.objectId}.*revision=1`));
}));

test('the durable background queue imports legacy lesson history into the actual prompt', () => fixture(async ({ root, workspace, project, ops, store }) => {
  const sourceRoot = path.join(root, 'learning');
  fs.mkdirSync(path.join(sourceRoot, 'candidates'), { recursive: true });
  const file = path.join(sourceRoot, 'candidates', 'lesson-legacy.json');
  const legacy = { schemaVersion: 1, id: 'lesson-legacy', projectId: 'old-path-slug', projectPath: workspace, projectName: 'Project', sourceEventIds: ['event-old'], sourceType: 'review', lessonType: 'verification_pattern', summary: 'Validate the entire generated result', appliesWhen: 'Generating a script', doThis: 'Run the final generated script', avoidThis: 'Check only its template', verification: 'Observe successful initialization', doesNotApplyWhen: 'No generated executable', evidenceRefs: [{ type: 'command', ref: 'node --check generated.js' }], confidence: 'high', status: 'approved', promotionTarget: 'project_memory', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', preservedUnknown: { original: 'unabridged' } };
  const bytes = Buffer.from(JSON.stringify(legacy)); fs.writeFileSync(file, bytes);
  const input = { collection: 'learning', sourceRoot, projectScopes: { [workspace]: project }, idempotencyKey: 'learning-history' };
  const job = await ops({ operation: 'import_project_data', input });
  await ops.waitForMigrations();
  const status = await ops({ operation: 'migration_status', input: { jobId: job.jobId } });
  assert.equal(status.status, 'completed', status.error);
  assert.equal(status.progress.imported, 1);
  const lessons = store.search({ scope: project, kinds: ['lesson'] }).items;
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].data.legacy_lesson_id, 'lesson-legacy');
  assert.equal(lessons[0].data.lesson_type, 'verification_pattern');
  assert.equal(lessons[0].data.confidence, 1);
  assert.equal(lessons[0].data.external_confidence, 'high', 'the original confidence label must remain available without invented display thresholds');
  assert.deepEqual(store.readMigrationSource(`learning:${sourceRoot}`, 'candidates/lesson-legacy.json').bytes, bytes);
  fs.renameSync(sourceRoot, path.join(root, 'retained-learning-evidence'));
  const prompt = await ledger.buildLearningRetrievalContext(workspace, root, { projectPath: workspace, runKind: 'solo', role: 'verifier', contextText: 'script' });
  assert.match(prompt, /Validate the entire generated result/);
  assert.match(prompt, /node --check generated.js/);
  assert.match(prompt, /置信度：high/);
  assert.match(prompt, new RegExp(`${lessons[0].objectId}.*revision=1`));
  assert.equal(fs.existsSync(sourceRoot), false);
}));

test('malformed formal lesson provenance is rejected before it can poison ordinary prompts', () => fixture(async ({ client, project }) => {
  for (const [field, value] of [['evidence_refs_json', 'not-json'], ['evidence_refs_json', [null]], ['evidence_refs_json', [{ type: 'command' }]], ['source_event_ids_json', { event: 'wrong-shape' }], ['source_event_ids_json', [123]]]) {
    await assert.rejects(client.call('write', { kind: 'lesson', action: 'create', scope: project, idempotencyKey: `bad-${field}-${JSON.stringify(value)}`, data: { status: 'candidate', summary: 'Malformed provenance', [field]: value } }), /lesson_field_invalid/);
  }
  const page = await client.call('search', { scope: project, kinds: ['lesson'] });
  assert.equal(page.items.length, 0);
}));

test('lesson copies share one scoped identity, rejected history remains readable and reimport protects newer database edits', () => fixture(async ({ root, workspace, project, ops, store }) => {
  const sourceRoot = path.join(root, 'learning');
  for (const folder of ['candidates', 'rejected']) fs.mkdirSync(path.join(sourceRoot, folder), { recursive: true });
  const firstFile = path.join(sourceRoot, 'candidates', 'lesson-same.json');
  const lastFile = path.join(sourceRoot, 'rejected', 'lesson-same.json');
  const candidate = { schemaVersion: 1, id: 'lesson-same', projectPath: workspace, summary: 'Observe the real outcome', appliesWhen: 'Changing behavior', doThis: 'Check the final result', avoidThis: 'Guessing', status: 'candidate', updatedAt: '2026-01-01T00:00:00Z', evidenceRefs: [] };
  fs.writeFileSync(firstFile, JSON.stringify(candidate));
  fs.writeFileSync(lastFile, JSON.stringify({ ...candidate, status: 'rejected', updatedAt: '2026-01-02T00:00:00Z' }));
  const migrate = async key => {
    const job = await ops({ operation: 'import_project_data', input: { collection: 'learning', sourceRoot, projectScopes: { [workspace]: project }, idempotencyKey: key } });
    await ops.waitForMigrations(); return ops({ operation: 'migration_status', input: { jobId: job.jobId } });
  };
  const status = await migrate('initial-history');
  assert.equal(status.status, 'completed', status.error);
  assert.equal(status.progress.imported, 2);
  let lessons = store.search({ scope: project, kinds: ['lesson'] }).items;
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].revision, 2);
  assert.equal(lessons[0].data.status, 'rejected');
  assert.equal(store.read(lessons[0].objectId, 1).data.status, 'candidate');
  assert.equal(await ledger.buildLearningRetrievalContext(workspace, root, { projectPath: workspace, runKind: 'solo', contextText: 'outcome' }), '');
  const again = await migrate('repeat-history');
  assert.equal(again.status, 'completed'); assert.equal(again.progress.unchanged, 2);
  assert.equal(store.read(lessons[0].objectId).revision, 2);
  store.write({ kind: 'lesson', action: 'patch', scope: project, objectId: lessons[0].objectId, expectedRevision: 2, idempotencyKey: 'current-native-edit', data: { status: 'approved', summary: 'New approved outcome' } });
  const changed = Buffer.from(JSON.stringify({ ...candidate, summary: 'Old file changed after migration', updatedAt: '2026-01-03T00:00:00Z' }));
  fs.writeFileSync(lastFile, changed);
  const conflict = await migrate('native-edit-conflict');
  assert.equal(conflict.status, 'completed_with_conflicts');
  assert.ok(conflict.progress.conflicts.some(item => /newer_database_revision/.test(item.error)));
  assert.equal(store.read(lessons[0].objectId).data.summary, 'New approved outcome');
  assert.deepEqual(store.readMigrationSource(`learning:${sourceRoot}`, 'rejected/lesson-same.json').bytes, changed);
  assert.deepEqual(fs.readFileSync(lastFile), changed);
}));

test('unmapped or malformed legacy lessons remain captured conflicts and never enter another project', () => fixture(async ({ root, workspace, project, ops, store }) => {
  const sourceRoot = path.join(root, 'learning'); fs.mkdirSync(path.join(sourceRoot, 'candidates'), { recursive: true });
  const foreign = Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'lesson-foreign', projectPath: path.join(workspace, 'other'), summary: 'Foreign private source', appliesWhen: '', doThis: '', avoidThis: '', evidenceRefs: [], status: 'candidate', updatedAt: '2026-01-01' }));
  const invalid = Buffer.from('{"schemaVersion":1,"id":"lesson-invalid","status":');
  fs.writeFileSync(path.join(sourceRoot, 'candidates', 'foreign.json'), foreign);
  fs.writeFileSync(path.join(sourceRoot, 'candidates', 'invalid.json'), invalid);
  const job = await ops({ operation: 'import_project_data', input: { collection: 'learning', sourceRoot, projectScopes: { [workspace]: project }, idempotencyKey: 'unmapped-lessons' } });
  await ops.waitForMigrations(); const status = await ops({ operation: 'migration_status', input: { jobId: job.jobId } });
  assert.equal(status.status, 'completed_with_conflicts', status.error);
  assert.equal(status.progress.conflicts.length, 2);
  assert.ok(status.progress.conflicts.some(item => item.error === 'project_scope_mapping_required'));
  assert.equal(store.search({ scope: project, kinds: ['lesson'] }).items.length, 0);
  for (const [key, bytes] of [['foreign.json', foreign], ['invalid.json', invalid]]) {
    const source = store.readMigrationSource(`learning:${sourceRoot}`, `candidates/${key}`);
    assert.equal(source.stage, 'unmapped'); assert.deepEqual(source.bytes, bytes);
  }
}));

test('startup discovers legacy learning without a memory directory and uses exact project scope', () => fixture(async ({ root, workspace, project, ops, store }) => {
  const sourceRoot = path.join(root, 'learning'); fs.mkdirSync(path.join(sourceRoot, 'candidates'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'candidates', 'lesson-startup.json'), JSON.stringify({ schemaVersion: 1, id: 'lesson-startup', projectPath: workspace, summary: 'Preserve the current selection', appliesWhen: 'Loading an asynchronous view', doThis: 'Keep the selected mode', avoidThis: 'Resetting the current choice', evidenceRefs: [], status: 'approved', updatedAt: '2026-01-01' }));
  const { enqueueAvailableDataMigrations } = require('../out/runtimeDatabaseBootstrap.js');
  await enqueueAvailableDataMigrations(store, ops, () => true);
  const jobs = store.migrationJobs().filter(job => job.args.collection === 'learning');
  assert.equal(jobs.length, 1, 'learning sources must be discovered independently of memory sources');
  assert.equal(jobs[0].args.projectScopes[workspace], project);
  await ops.waitForMigrations();
  assert.equal(store.readMigrationJob(jobs[0].jobId).status, 'completed');
  await enqueueAvailableDataMigrations(store, ops, () => true);
  assert.equal(store.migrationJobs().filter(job => job.args.collection === 'learning').length, 1);
  const prompt = await ledger.buildLearningRetrievalContext(workspace, root, { projectPath: workspace, contextText: 'unmatched', runKind: 'solo' });
  assert.match(prompt, /Preserve the current selection/);
  assert.equal(fs.existsSync(path.join(root, 'memory')), false);
}));

test('unchanged invalid learning sources keep one captured revision on retry', () => fixture(async ({ root, workspace, project, ops, store }) => {
  const sourceRoot = path.join(root, 'learning'); fs.mkdirSync(path.join(sourceRoot, 'candidates'), { recursive: true });
  const key = 'candidates/invalid.json'; const bytes = Buffer.from('{invalid legacy source'); fs.writeFileSync(path.join(sourceRoot, key), bytes);
  const migrate = async idempotencyKey => {
    const job = await ops({ operation: 'import_project_data', input: { collection: 'learning', sourceRoot, projectScopes: { [workspace]: project }, idempotencyKey } });
    await ops.waitForMigrations(); assert.equal(store.readMigrationJob(job.jobId).status, 'completed_with_conflicts');
    return store.readMigrationSource(`learning:${sourceRoot}`, key);
  };
  const first = await migrate('invalid-first'); const retry = await migrate('invalid-retry');
  assert.equal(retry.sourceRevision, first.sourceRevision, 'unchanged conflict retries must not manufacture new source history');
  assert.deepEqual(retry.bytes, bytes);
}));

test('ordinary lesson dates reject unreadable create and patch values before prompt preparation', () => fixture(async ({ root, workspace, client, project, store }) => {
  const valid = await client.call('write', { kind: 'lesson', action: 'create', scope: project, idempotencyKey: 'valid-dated-lesson', data: { status: 'candidate', summary: 'Candidate used to verify date validation', external_updated_at: 0 } });
  const visible = store.write({ kind: 'lesson', action: 'create', scope: project, idempotencyKey: 'approved-dated-lesson', data: { status: 'approved', summary: 'Keep the last meaningful user selection', external_updated_at: 0 } });
  for (const field of ['external_created_at', 'external_updated_at']) {
    for (const value of [1e20, 'invalid-date', 1.5]) {
      await assert.rejects(client.call('write', { kind: 'lesson', action: 'create', scope: project, idempotencyKey: `bad-create-${field}-${value}`, data: { status: 'candidate', summary: 'Unreadable date must not block any prompt', [field]: value } }), /lesson_timestamp_invalid/);
      await assert.rejects(client.call('write', { kind: 'lesson', action: 'patch', scope: project, objectId: valid.objectId, expectedRevision: 1, idempotencyKey: `bad-patch-${field}-${value}`, data: { [field]: value } }), /lesson_timestamp_invalid/);
    }
  }
  const prompt = await ledger.buildLearningRetrievalContext(workspace, root, { projectPath: workspace, runKind: 'solo', contextText: 'unmatched' });
  assert.match(prompt, /Keep the last meaningful user selection/);
  assert.match(prompt, new RegExp(`${visible.objectId}.*revision=1`));
  assert.equal((await client.call('search', { scope: project, kinds: ['lesson'] })).items.length, 2);
}));

test('ordinary lesson writes cannot claim a manual review and revisions invalidate imported review provenance', () => fixture(async ({ client, project, store }) => {
  const provenance = { schemaVersion: 2, runId: 'old-review', proposalHash: 'source-proposal-hash', evidence: ['evidence-1'], target: '', reason: 'Independently checked original source' };
  await assert.rejects(client.call('write', { kind: 'lesson', action: 'create', scope: project, idempotencyKey: 'forged-semantic-review', data: { status: 'candidate', summary: 'An ordinary claim cannot declare manual review', semantic_review_json: provenance } }), /action_requires_existing_authorization/);
  const reviewed = store.write({ kind: 'lesson', action: 'create', scope: project, idempotencyKey: 'host-reviewed-source', data: { status: 'candidate', summary: 'Original manually reviewed conclusion', semantic_review_json: provenance } });
  await assert.rejects(client.call('write', { kind: 'lesson', action: 'patch', scope: project, objectId: reviewed.objectId, expectedRevision: 1, idempotencyKey: 'forged-semantic-review-patch', data: { semantic_review_json: provenance } }), /action_requires_existing_authorization/);
  const input = { kind: 'lesson', action: 'patch', scope: project, objectId: reviewed.objectId, expectedRevision: 1, idempotencyKey: 'ordinary-reviewed-source-edit', data: { summary: 'A new ordinary candidate conclusion' } };
  const next = await client.call('write', input); const replay = await client.call('write', input);
  assert.equal(next.revision, 2); assert.equal(replay.revision, 2);
  assert.equal((await client.call('read', { ref: reviewed.objectId })).data.semantic_review_json, null);
  assert.deepEqual(JSON.parse((await client.call('read', { ref: reviewed.objectId, revision: 1 })).data.semantic_review_json), provenance);
}));

test('ordinary lesson edits use current recency while retaining the imported date in fixed history', () => fixture(async ({ store, client, project, write }) => {
  const original = write('Retain the revised applicability of the original checked behavior', { external_created_at: 0, external_updated_at: 0 });
  await client.call('write', { kind: 'lesson', action: 'patch', scope: project, objectId: original.objectId, expectedRevision: 1, idempotencyKey: 'revise-original-lesson', data: { verification: 'The latest actual check updates this conclusion' } });
  const current = await client.call('read', { ref: original.objectId });
  assert.equal(store.readLearningOverview().projectSignals[0].latestAt, new Date(current.updatedAt).toISOString(), 'a newer native revision must not remain dated as its legacy source');
  assert.equal((await client.call('read', { ref: original.objectId, revision: 1 })).data.external_updated_at, 0);
}));

test('one disconnected registered project cannot prevent available learning history discovery', () => fixture(async ({ root, workspace, project, ops, store }) => {
  const disconnected = path.join(path.dirname(workspace), 'disconnected'); fs.mkdirSync(disconnected);
  await ops({ operation: 'register_project', input: { root: disconnected } });
  const sourceRoot = path.join(root, 'learning'); fs.mkdirSync(path.join(sourceRoot, 'candidates'), { recursive: true });
  const lesson = { schemaVersion: 1, id: 'lesson-available', projectPath: workspace, summary: 'Keep user choices during asynchronous refresh', appliesWhen: 'Refreshing views', doThis: 'Keep the selected mode', avoidThis: 'Resetting user state', evidenceRefs: [], status: 'approved', updatedAt: '2026-01-01' };
  fs.writeFileSync(path.join(sourceRoot, 'candidates', 'available.json'), JSON.stringify(lesson));
  const bytes = Buffer.from(JSON.stringify({ ...lesson, id: 'lesson-disconnected', projectPath: disconnected }));
  fs.writeFileSync(path.join(sourceRoot, 'candidates', 'disconnected.json'), bytes);
  fs.renameSync(disconnected, `${disconnected}-retained-evidence`);
  const { enqueueAvailableDataMigrations } = require('../out/runtimeDatabaseBootstrap.js');
  await enqueueAvailableDataMigrations(store, ops, () => true);
  const jobs = store.migrationJobs().filter(job => job.args.collection === 'learning');
  assert.equal(jobs.length, 1, 'an unavailable project must not abort learning discovery for others');
  await ops.waitForMigrations();
  const status = store.readMigrationJob(jobs[0].jobId);
  assert.equal(status.status, 'completed_with_conflicts');
  assert.equal(status.progress.imported, 1);
  assert.ok(status.progress.conflicts.some(item => item.source === 'candidates/disconnected.json' && item.error === 'project_scope_mapping_required'));
  const captured = store.readMigrationSource(`learning:${sourceRoot}`, 'candidates/disconnected.json');
  assert.equal(captured.stage, 'unmapped'); assert.deepEqual(captured.bytes, bytes);
  assert.equal(store.search({ scope: project, kinds: ['lesson'] }).items.length, 1);
  const prompt = await ledger.buildLearningRetrievalContext(workspace, root, { projectPath: workspace, runKind: 'solo', contextText: 'unmatched' });
  assert.match(prompt, /Keep user choices during asynchronous refresh/);
}));
