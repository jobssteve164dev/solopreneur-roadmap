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
    const created = await call('solomap_write', { kind: 'memory', action: 'create', scope: project.objectId, idempotencyKey: 'memory', data: { category: 'inbox', title: 'MCP目标', status: 'captured', content: '跨入口完整回读' } });
    assert.equal((await call('solomap_read', { ref: created.objectId })).data.content, '跨入口完整回读');
    assert.equal((await call('solomap_search', { scope: project.objectId, query: 'MCP目标' })).items[0].objectId, created.objectId);
    const second = await call('solomap_write', { kind: 'memory', action: 'create', scope: project.objectId, idempotencyKey: 'other', data: { category: 'inbox', title: 'source', status: 'captured', content: '证据' } });
    await call('solomap_link', { source: created.objectId, relation: 'source', target: second.objectId, expectedRevision: 1, idempotencyKey: 'link' });
    assert.equal((await call('solomap_read', { ref: created.objectId })).relations[0].target, second.objectId);
    assert.ok((await call('solomap_context', { project: project.objectId, query: 'MCP目标', budget: 1000 })).items.some(item => item.objectId === created.objectId));
    const exported = await call('solomap_export', { ref: created.objectId, format: 'json', destination: path.join(root, 'exports', 'memory.json'), idempotencyKey: 'export' });
    assert.equal(JSON.parse(fs.readFileSync(exported.destination, 'utf8')).data.content, '跨入口完整回读');
    const privateProject = store.write({ kind: 'project', action: 'create', scope: null, idempotencyKey: 'private', data: { name: 'private' } });
    const denied = await session.client.callTool({ name: 'solomap_search', arguments: { scope: privateProject.objectId } });
    assert.equal(denied.isError, true);
  } finally { await session.close(); store.close(); }
});
