const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('smart kernel read tools are discovered and called through standard MCP', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { createIntelligenceMcpSession } = require('../out/intelligenceMcp.js');
  const session = await createIntelligenceMcpSession({
    getProjects: () => [{ name: 'Alpha', path: '/private/alpha' }],
    getSelectedProjectPath: () => '/private/alpha',
    getCurrentSteps: () => [{ title: '完成登录', status: 'Pending' }],
    getSettings: () => ({ language: 'zh', cognitiveAgent: 'codex', cognitiveModel: 'gpt-test', telegramBotToken: 'secret' })
  });
  try {
    assert.ok(session.client instanceof Client);
    const tools = await session.client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(),
      ['get_current_project', 'get_plugin_settings', 'list_projects']);
    assert.ok(tools.tools.every(tool => tool.annotations?.readOnlyHint === true && tool.inputSchema.type === 'object'));
    const project = await session.client.callTool({ name: 'get_current_project', arguments: {} });
    assert.deepEqual(JSON.parse(project.content[0].text), {
      selectedProject: { name: 'Alpha' }, currentSteps: [{ title: '完成登录', status: 'Pending' }]
    });
    assert.doesNotMatch(JSON.stringify(project), /\/private\/alpha/);
    const settings = await session.client.callTool({ name: 'get_plugin_settings', arguments: {} });
    assert.deepEqual(JSON.parse(settings.content[0].text), {
      language: 'zh', cognitiveAgent: 'codex', cognitiveModel: 'gpt-test'
    });
    assert.doesNotMatch(JSON.stringify(settings), /secret/);
    const write = await session.client.callTool({ name: 'update_settings', arguments: {} });
    assert.equal(write.isError, true);
  } finally {
    await session.close();
  }
});

test('smart kernel chat uses the selected read-only model pipe with conversation context', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const invocations = [];
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', model: 'gpt-test',
    runner: async invocation => {
      invocations.push(invocation);
      return '先确认登录问题影响了哪些用户。';
    }
  });
  const reply = await engine.chat([
    { role: 'user', content: '先修登录还是做导出？' },
    { role: 'assistant', content: '先确认影响范围。' },
    { role: 'user', content: '怎么确认？' }
  ], { selectedProject: '我的应用', projects: ['我的应用'] });
  assert.equal(reply, '先确认登录问题影响了哪些用户。');
  assert.equal(invocations.length, 1);
  assert.match(invocations[0].stdin, /先修登录还是做导出/);
  assert.match(invocations[0].stdin, /怎么确认/);
  assert.match(invocations[0].stdin, /我的应用/);
  assert.match(invocations[0].args.join(' '), /--sandbox read-only/);
});

test('smart kernel chat answers a project question after reading current plugin data', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const { createIntelligenceMcpSession } = require('../out/intelligenceMcp.js');
  let selected = 'Alpha';
  const prompts = [];
  const session = await createIntelligenceMcpSession({
    getProjects: () => [{ name: 'Alpha', path: '/alpha' }, { name: 'Beta', path: '/beta' }],
    getSelectedProjectPath: () => selected === 'Alpha' ? '/alpha' : '/beta',
    getCurrentSteps: () => [{ title: selected === 'Alpha' ? '完成登录' : '验证付费', status: 'Pending' }],
    getSettings: () => ({ language: 'zh' })
  });
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex',
    runner: async invocation => {
      prompts.push(invocation.stdin);
      return prompts.length === 1
        ? '{"toolCall":{"name":"get_current_project"}}'
        : '当前项目 Beta 尚需验证付费。';
    }
  });
  selected = 'Beta';
  const reply = await engine.chat([{ role: 'user', content: '当前项目还要做什么？' }],
    { selectedProject: 'Alpha', projects: ['Alpha'] }, session.client);
  await session.close();
  assert.equal(reply, '当前项目 Beta 尚需验证付费。');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /TOOLRESULT:/);
  assert.match(prompts[1], /Beta/);
  assert.match(prompts[1], /验证付费/);
  assert.doesNotMatch(prompts[1], /\/beta/);
});

test('smart kernel read tools expose current language without secrets or write methods', async () => {
  const { createIntelligenceReadTools } = require('../out/intelligenceReadTools.js');
  const tools = createIntelligenceReadTools({
    getProjects: () => [], getSelectedProjectPath: () => '', getCurrentSteps: () => [],
    getSettings: () => ({ language: 'en', cognitiveAgent: 'codex', cognitiveModel: 'gpt-test', telegramBotToken: 'secret' })
  });
  assert.deepEqual(await tools.call('get_plugin_settings'), {
    language: 'en', cognitiveAgent: 'codex', cognitiveModel: 'gpt-test'
  });
  await assert.rejects(() => tools.call('update_settings'), /Unknown read tool/);
});

test('smart kernel chat accepts a fenced read tool request and answers from its result', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const { createIntelligenceMcpSession } = require('../out/intelligenceMcp.js');
  const session = await createIntelligenceMcpSession({
    getProjects: () => [], getSelectedProjectPath: () => '', getCurrentSteps: () => null,
    getSettings: () => ({ language: 'en', cognitiveAgent: 'codex', cognitiveModel: 'gpt-test' })
  });
  let calls = 0;
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', runner: async invocation => {
      calls += 1;
      if (calls === 1) return '```json\n{"toolCall":{"name":"get_plugin_settings"}}\n```';
      assert.match(invocation.stdin, /gpt-test/);
      return '当前智能内核使用 Codex 的 gpt-test 模型。';
    }
  });
  const answer = await engine.chat([{ role: 'user', content: '现在用什么模型？' }],
    { selectedProject: '', projects: [] }, session.client);
  await session.close();
  assert.equal(answer, '当前智能内核使用 Codex 的 gpt-test 模型。');
  assert.equal(calls, 2);
});

test('smart kernel chat does not show broken tool JSON as a reply', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async () => '{"toolCall":{' });
  await assert.rejects(() => engine.chat([{ role: 'user', content: '查当前项目' }],
    { selectedProject: '', projects: [] }, { listTools: async () => ({ tools: [] }) }), /invalid read tool request/i);
});

test('smart kernel chat does not show an early truncated tool request as a reply', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async () => '{"toolCall"' });
  await assert.rejects(() => engine.chat([{ role: 'user', content: '查当前项目' }],
    { selectedProject: '', projects: [] }, { listTools: async () => ({ tools: [] }) }), /invalid read tool request/i);
});

test('smart kernel chat can answer with a plain code fragment', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async () => '{ key: value }' });
  assert.equal(await engine.chat([{ role: 'user', content: '给我一个对象片段' }],
    { selectedProject: '', projects: [] }, { listTools: async () => ({ tools: [] }) }), '{ key: value }');
});

test('smart kernel chat rejects an unlisted tool before returning an answer', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const { createIntelligenceMcpSession } = require('../out/intelligenceMcp.js');
  const session = await createIntelligenceMcpSession({
    getProjects: () => [], getSelectedProjectPath: () => '', getCurrentSteps: () => null,
    getSettings: () => ({ language: 'zh' })
  });
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', runner: async () => '{"toolCall":{"name":"update_settings"}}'
  });
  await assert.rejects(() => engine.chat([{ role: 'user', content: '改设置' }],
    { selectedProject: '', projects: [] }, session.client), /Unknown read tool/);
  await session.close();
});

test('smart kernel refuses a writable tool returned by an MCP server', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const server = new McpServer({ name: 'mixed-tools', version: '1.0.0' });
  let writes = 0;
  server.registerTool('update_settings', {
    description: 'Change settings', inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, async () => {
    writes += 1;
    return { content: [{ type: 'text', text: 'changed' }] };
  });
  const client = new Client({ name: 'kernel-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async () => '{"toolCall":{"name":"update_settings"}}' });
    await assert.rejects(() => engine.chat([{ role: 'user', content: '改设置' }],
      { selectedProject: '', projects: [] }, client), /Unknown read tool/);
    assert.equal(writes, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test('smart kernel refuses an unapproved MCP tool falsely marked read-only', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const server = new McpServer({ name: 'mixed-tools', version: '1.0.0' });
  let writes = 0;
  server.registerTool('update_settings', {
    description: 'Change settings', inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false }
  }, async () => {
    writes += 1;
    return { content: [{ type: 'text', text: 'changed' }] };
  });
  const client = new Client({ name: 'kernel-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async () => '{"toolCall":{"name":"update_settings"}}' });
    await assert.rejects(() => engine.chat([{ role: 'user', content: '改设置' }],
      { selectedProject: '', projects: [] }, client), /Unknown read tool/);
    assert.equal(writes, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test('smart kernel chat does not show a malformed tool request as a reply', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', runner: async () => '{"toolCall":{}}'
  });
  await assert.rejects(() => engine.chat([{ role: 'user', content: '查当前项目' }],
    { selectedProject: '', projects: [] }, { listTools: async () => ({ tools: [] }) }), /invalid read tool request/i);
});

test('smart kernel chat reports an MCP transport failure instead of answering from an error result', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  let calls = 0;
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', runner: async () => ++calls === 1
      ? '{"toolCall":{"name":"get_current_project"}}'
      : '当前项目正常。'
  });
  const readTools = {
    listTools: async () => ({ tools: [{ name: 'get_current_project', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false } }] }),
    callTool: async () => { throw new Error('MCP transport disconnected'); }
  };
  await assert.rejects(() => engine.chat([{ role: 'user', content: '当前项目状态？' }],
    { selectedProject: '', projects: [] }, readTools), /MCP transport disconnected/);
});

test('smart kernel chat saves a separate durable conversation and resumes its history', async t => {
  const { IntelligenceConversationStore } = require('../out/intelligenceChat.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-intelligence-chat-'));
  const replies = [];
  let conversationId = '';
  const store = new IntelligenceConversationStore(root, async messages => {
    replies.push(messages.map(message => message.content));
    return replies.length === 1 ? '先确认影响范围。' : '查看最近的登录失败反馈。';
  });
  t.after(() => {
    const globalRoot = path.join(root, '.solomap-global');
    const folder = path.join(globalRoot, 'intelligence-conversations');
    if (conversationId) fs.unlinkSync(path.join(folder, `${conversationId}.json`));
    fs.rmdirSync(folder);
    fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  });
  const first = await store.send('先修登录还是做导出？');
  conversationId = first.id;
  assert.equal(first.messages.length, 2);
  const second = await store.send('怎么确认影响范围？', first.id);
  assert.equal(second.id, first.id);
  assert.equal(second.messages.length, 4);
  assert.deepEqual(replies[1], ['先修登录还是做导出？', '先确认影响范围。', '怎么确认影响范围？']);
  const reopened = new IntelligenceConversationStore(root, async () => 'unused');
  assert.equal(reopened.list()[0].id, first.id);
  assert.deepEqual(reopened.get(first.id).messages, second.messages);
});

test('smart kernel chat keeps the draft available when generation fails', async t => {
  const { IntelligenceConversationStore } = require('../out/intelligenceChat.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-intelligence-chat-failure-'));
  t.after(() => fs.rmdirSync(root));
  const store = new IntelligenceConversationStore(root, async () => { throw new Error('model unavailable'); });
  await assert.rejects(() => store.send('继续这个问题'), /model unavailable/);
  assert.deepEqual(store.list(), []);
});
