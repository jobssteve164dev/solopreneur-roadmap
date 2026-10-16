const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createIntelligenceMcpSession } = require('../out/intelligenceMcp.js');

test('MCP exposes the formal memory and experience tools with the shared operations', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-mcp-'));
  const store = new UnifiedDataStore(root);
  const project = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'p', data: { name: '项目' } });
  let afterAlphaSearch = null;
  const session = await createIntelligenceMcpSession({
    getProjects: () => [{ name: '项目', path: root }],
    getSelectedProjectPath: () => root,
    getCurrentSteps: () => [],
    getSettings: () => ({ language: 'zh' })
  }, {
    scope: project.objectId,
    globalReads: true,
    call: async (operation, input) => {
      if (operation === 'write') return store.write(input);
      if (operation === 'read') return store.read(input.ref, input.revision);
      if (operation === 'search') {
        const result = store.search(input);
        if (input.query === 'alpha' && afterAlphaSearch) { const mutate = afterAlphaSearch; afterAlphaSearch = null; mutate(); }
        return result;
      }
      if (operation === 'link') return store.link(input);
      if (operation === 'context') return store.context(input);
      if (operation === 'export') return store.export(input);
      throw new Error('unknown_operation');
    }
  });
  const call = async (name, args) => {
    const response = await session.client.callTool({ name, arguments: args });
    assert.equal(response.isError, undefined, JSON.stringify(response.content));
    return JSON.parse(response.content[0].text);
  };
  try {
    const names = (await session.client.listTools()).tools.map(tool => tool.name);
    for (const name of ['list_projects', 'get_current_project', 'get_plugin_settings', 'get_today_review', 'solomap_search', 'solomap_read', 'solomap_write', 'solomap_link', 'solomap_context', 'solomap_memory', 'solomap_experience', 'solomap_export']) assert.ok(names.includes(name), `missing ${name}`);
    const writeTool = (await session.client.listTools()).tools.find(tool => tool.name === 'solomap_write');
    assert.ok(writeTool.inputSchema.properties.kind.enum?.includes('memory'), 'supported kinds must be discoverable');
    const schema = await session.client.readResource({ uri: 'solomap://schema' });
    const model = JSON.parse(schema.contents[0].text);
    assert.equal(model.kinds.memory.fields.content.type, 'content');
    assert.equal(model.kinds.memory.fields.category.required, true);
    const eventField = model.kinds.lesson.fields.event_refs;
    assert.deepEqual(Object.keys(eventField.items || {}).sort(), ['objectId', 'revision', 'sourceId']);
    assert.equal(eventField.items.revision.integer, true);
    assert.equal(eventField.items.revision.minimum, 1);
    assert.equal(eventField.items.objectId.nullable, true);
    assert.match(eventField.description, /null/);
    assert.deepEqual(Object.keys(model.kinds.lesson_decision.fields.candidate_refs.items || {}).sort(), ['objectId', 'revision']);
    const eventInput = writeTool.inputSchema.properties.data.properties.event_refs;
    assert.equal(eventInput.type, 'array');
    assert.deepEqual(eventInput.items.required.sort(), ['objectId', 'revision', 'sourceId']);
    assert.equal(writeTool.inputSchema.properties.data.properties.candidate_refs.type, 'array');
    const source = store.write({ kind: 'evidence', action: 'create', scope: project.objectId, idempotencyKey: 'formal-ref-source', data: { type: 'host_observation', source_actor_id: 'local-runtime', observed_at: Date.now(), content: 'Observed original outcome' } });
    const event = store.write({ kind: 'learning_event', action: 'create', scope: project.objectId, idempotencyKey: 'formal-ref-event', data: { source_object_id: source.objectId, source_revision: 1, event_type: 'completed', summary: 'Original outcome', occurred_at: Date.now() } });
    const refs = [{ sourceId: event.objectId, objectId: event.objectId, revision: 1 }];
    const lesson = await call('solomap_write', { kind: 'lesson', action: 'create', idempotencyKey: 'formal-ref-lesson', data: { status: 'candidate', summary: 'Use the original outcome', event_refs: refs } });
    assert.deepEqual((await call('solomap_read', { ref: lesson.objectId })).data.event_refs, refs);
    for (const invalid of [{ objectId: event.objectId, revision: 1 }, { sourceId: event.objectId, objectId: event.objectId, revision: 0 }, { sourceId: event.objectId, objectId: null, revision: 1 }]) {
      const failed = await session.client.callTool({ name: 'solomap_write', arguments: { kind: 'lesson', action: 'create', idempotencyKey: `invalid-formal-ref:${JSON.stringify(invalid)}`, data: { status: 'candidate', summary: 'Invalid reference', event_refs: [invalid] } } });
      assert.equal(failed.isError, true);
    }
    assert.equal(store.search({ scope: project.objectId, kinds: ['lesson'] }).items.length, 1, 'invalid tool inputs must not create partial records');
    const created = await call('solomap_write', { kind: 'memory', action: 'create', scope: project.objectId, idempotencyKey: 'memory', data: { category: 'inbox', title: 'MCP目标', status: 'captured', content: '跨入口完整回读' } });
    assert.equal((await call('solomap_read', { ref: created.objectId })).data.content, '跨入口完整回读');
    assert.equal((await call('solomap_search', { scope: project.objectId, query: 'MCP目标' })).items[0].objectId, created.objectId);
    const second = await call('solomap_write', { kind: 'memory', action: 'create', scope: project.objectId, idempotencyKey: 'other', data: { category: 'inbox', title: 'source', status: 'captured', content: '证据' } });
    await call('solomap_link', { source: created.objectId, relation: 'source', target: second.objectId, expectedRevision: 1, idempotencyKey: 'link' });
    assert.equal((await call('solomap_read', { ref: created.objectId })).relations[0].target, second.objectId);
    assert.ok((await call('solomap_context', { project: project.objectId, query: 'MCP目标', budget: 1000 })).items.some(item => item.objectId === created.objectId));
    assert.ok((await call('solomap_context', { project: '项目', query: 'MCP目标', budget: 1000 })).items.some(item => item.objectId === created.objectId), 'the bound project name must be accepted as an alias for its internal id');
    const memory = await call('solomap_memory', { query: 'MCP目标', budget: 1000 });
    assert.ok(memory.items.some(item => item.objectId === created.objectId));
    assert.ok(memory.items.every(item => item.kind === 'memory'));
    const memoryRoute = await call('solomap_memory', { action: 'route', kind: 'project' });
    assert.deepEqual(memoryRoute.target, { kind: 'memory', scope: project.objectId, data: { category: 'project', status: 'captured' } });
    assert.ok(Array.isArray(memoryRoute.requiredStructure));
    assert.ok(Array.isArray(memoryRoute.guardrails));
    const approvedLesson = store.write({ kind: 'lesson', action: 'create', scope: project.objectId, idempotencyKey: 'approved-lesson', data: { status: 'approved', summary: '正式经验工具使用数据库经验', do_this: '调用正式 MCP', applies_when: '需要复用经验时' } });
    store.write({ kind: 'lesson', action: 'create', scope: project.objectId, idempotencyKey: 'candidate-lesson', data: { status: 'candidate', summary: '正式经验工具候选经验', do_this: '尚未批准', applies_when: '不能正式复用' } });
    store.write({ kind: 'lesson', action: 'create', scope: project.objectId, idempotencyKey: 'second-approved-lesson', data: { status: 'approved', summary: '正式经验工具第二条数据库经验', do_this: '调用正式 MCP', applies_when: '需要复用经验时' } });
    const experience = await call('solomap_experience', { action: 'retrieve', query: '正式经验工具', limit: 1 });
    assert.equal(experience.lessons.length, 1);
    assert.ok(experience.lessons.every(item => item.data.status === 'approved'));
    assert.ok(experience.lessons.every(item => item.kind === 'lesson'));
    assert.equal((await call('solomap_experience', { action: 'retrieve', query: '使用数据库经验', limit: 1 })).lessons[0].objectId, approvedLesson.objectId);
    const digestBody = { schemaVersion: 2, runId: 'mcp-search-run', nodeId: 'mcp-node', runKind: 'step', executionLogId: 9, agentCli: 'codex', status: 'Completed', startedAt: '2026-10-16T00:00:00Z', finishedAt: '2026-10-16T00:01:00Z', durationMs: 1, tokenUsage: {}, userIntent: 'unique intent phrase lives only in digest body', outcome: 'formal search result', changedFiles: ['src/formal-search.ts'], touchedFiles: [], commandSignals: [], verification: [], failures: [], reusableSignals: [], tags: [] };
    const digestBytes = Buffer.from(JSON.stringify(digestBody));
    const digestSource = { identity: `run-digests:${project.objectId}`, key: 'mcp-search.json', hash: crypto.createHash('sha256').update(digestBytes).digest('hex') };
    store.captureMigrationSource(digestSource, digestBytes);
    store.importRunDigestSource(project.objectId, { source: digestSource, bytes: digestBytes });
    const queriedExperience = await call('solomap_experience', { action: 'search', query: 'unique phrase digest body', limit: 1 });
    assert.equal(queriedExperience.records.length, 1);
    assert.equal(queriedExperience.records[0].userIntent, digestBody.userIntent);
    const termExperience = await call('solomap_experience', { action: 'search', terms: ['unique', 'phrase', 'digest', 'body'], limit: 1 });
    assert.equal(termExperience.records[0].runId, digestBody.runId);
    const conflictingSearch = await session.client.callTool({ name: 'solomap_experience', arguments: { action: 'search', query: 'unique', terms: ['digest'] } });
    assert.equal(conflictingSearch.isError, true);
    const changingJournal = store.appendProjectJournal(project.objectId, 'changing-journal', { nodeId: 'journal-node', timestamp: '2026-10-16T00:02:00Z', agentCli: 'codex', command: 'run', output: 'alpha', status: 'Recorded' }, 10);
    afterAlphaSearch = () => store.updateProjectJournal(project.objectId, changingJournal.executionLogId, { agentCli: 'codex', command: 'run', output: 'beta', status: 'Recorded' });
    const impossibleSnapshot = await call('solomap_experience', { action: 'search', terms: ['alpha', 'beta'], node: 'journal-node', limit: 1 });
    assert.deepEqual(impossibleSnapshot.records, []);
    store.appendProjectJournal(project.objectId, 'failure-journal', { nodeId: 'failure-node', timestamp: '2026-10-16T00:03:00Z', agentCli: 'codex', command: 'run', output: 'Failure category: verification_failed\nFailure reason:\nmissing result\nsecond detail\nWorkspace changes:\nM src/a.ts\nA src/b.ts\nTouched project files:\nsrc/a.ts\nsrc/b.ts\nAgent output tail:\ndone', status: 'Recorded' }, 11);
    const journalFailures = await call('solomap_experience', { action: 'failures', node: 'failure-node', limit: 1 });
    assert.equal(journalFailures.records.length, 1);
    assert.equal(journalFailures.records[0].nodeId, 'failure-node');
    assert.deepEqual(journalFailures.records[0].failures, ['verification_failed', 'missing result\nsecond detail']);
    assert.deepEqual(journalFailures.records[0].changedFiles, ['M src/a.ts', 'A src/b.ts']);
    assert.deepEqual(journalFailures.records[0].touchedFiles, ['src/a.ts', 'src/b.ts']);
    const contextPages = []; let contextCursor;
    do {
      const page = await call('solomap_context', { view: 'metadata', kinds: ['memory'], terms: ['MCP目标', 'source'], budget: 1, limit: 1, ...(contextCursor ? { cursor: contextCursor } : {}) });
      assert.equal(page.sourceChanged, false);
      assert.ok(page.items.every(item => !Object.hasOwn(item.data, 'content')));
      contextPages.push(...page.items); contextCursor = page.cursor;
    } while (contextCursor);
    assert.deepEqual(contextPages.map(item => item.objectId).sort(), [created.objectId, second.objectId].sort());
    store.write({ kind: 'memory', action: 'create', scope: project.objectId, idempotencyKey: 'local-profile', data: { category: 'profile', title: 'Local preference', status: 'captured', content: '当前项目偏好' } });
    const globalProfile = store.write({ kind: 'memory', action: 'create', scope: null, idempotencyKey: 'global-profile', data: { category: 'profile', title: 'Global preference', status: 'active', content: '跨项目正式偏好' } });
    const globalRoute = await call('solomap_memory', { action: 'route', kind: 'profile', title: 'Global' });
    assert.ok(globalRoute.existing.some(item => item.objectId === globalProfile.objectId));
    const exported = await call('solomap_export', { ref: created.objectId, format: 'json', destination: path.join(root, 'exports', 'memory.json'), idempotencyKey: 'export' });
    assert.equal(JSON.parse(fs.readFileSync(exported.destination, 'utf8')).data.content, '跨入口完整回读');
    const privateProject = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'private', data: { name: 'private' } });
    const denied = await session.client.callTool({ name: 'solomap_search', arguments: { scope: privateProject.objectId } });
    assert.equal(denied.isError, true);
    const deniedContext = await session.client.callTool({ name: 'solomap_context', arguments: { project: 'private' } });
    assert.equal(deniedContext.isError, true);
    const deniedEmptyContext = await session.client.callTool({ name: 'solomap_context', arguments: { project: '' } });
    assert.equal(deniedEmptyContext.isError, true);
  } finally { await session.close(); store.close(); }
});
