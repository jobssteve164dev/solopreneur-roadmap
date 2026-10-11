const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { createIntelligenceMcpSession } = require('../out/intelligenceMcp.js');

test('MCP exposes the six shared operations and retains the four existing read tools', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-mcp-'));
  const store = new UnifiedDataStore(root);
  const project = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'p', data: { name: '项目' } });
  const session = await createIntelligenceMcpSession({
    getProjects: () => [{ name: '项目', path: root }],
    getSelectedProjectPath: () => root,
    getCurrentSteps: () => [],
    getSettings: () => ({ language: 'zh' })
  }, {
    scope: project.objectId,
    call: async (operation, input) => {
      if (operation === 'write') return store.write(input);
      if (operation === 'read') return store.read(input.ref, input.revision);
      if (operation === 'search') return store.search(input);
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
    for (const name of ['list_projects', 'get_current_project', 'get_plugin_settings', 'get_today_review', 'solomap_search', 'solomap_read', 'solomap_write', 'solomap_link', 'solomap_context', 'solomap_export']) assert.ok(names.includes(name), `missing ${name}`);
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
    const contextPages = []; let contextCursor;
    do {
      const page = await call('solomap_context', { view: 'metadata', kinds: ['memory'], terms: ['MCP目标', 'source'], budget: 1, limit: 1, ...(contextCursor ? { cursor: contextCursor } : {}) });
      assert.equal(page.sourceChanged, false);
      assert.ok(page.items.every(item => !Object.hasOwn(item.data, 'content')));
      contextPages.push(...page.items); contextCursor = page.cursor;
    } while (contextCursor);
    assert.deepEqual(contextPages.map(item => item.objectId).sort(), [created.objectId, second.objectId].sort());
    const exported = await call('solomap_export', { ref: created.objectId, format: 'json', destination: path.join(root, 'exports', 'memory.json'), idempotencyKey: 'export' });
    assert.equal(JSON.parse(fs.readFileSync(exported.destination, 'utf8')).data.content, '跨入口完整回读');
    const privateProject = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'private', data: { name: 'private' } });
    const denied = await session.client.callTool({ name: 'solomap_search', arguments: { scope: privateProject.objectId } });
    assert.equal(denied.isError, true);
  } finally { await session.close(); store.close(); }
});
