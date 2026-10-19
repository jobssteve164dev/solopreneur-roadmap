const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function removeDiagnosticTrace(globalRoot) {
  const directory = path.join(globalRoot, 'diagnostics', new Date().toISOString().slice(0, 10));
  const name = fs.existsSync(directory) && fs.readdirSync(directory).find(item => /^recent-operations\.\d+-[a-f0-9]{8}\.json$/.test(item));
  if (name) fs.unlinkSync(path.join(directory, name));
  if (fs.existsSync(directory)) fs.rmdirSync(directory);
  if (fs.existsSync(path.join(globalRoot, 'diagnostics'))) fs.rmdirSync(path.join(globalRoot, 'diagnostics'));
}
function operationFile(globalRoot) {
  const directory = path.join(globalRoot, 'diagnostics', new Date().toISOString().slice(0, 10));
  return path.join(directory, fs.readdirSync(directory).find(name => /^recent-operations\.\d+-[a-f0-9]{8}\.json$/.test(name)));
}

function cleanupExact(root) {
  if (!fs.existsSync(root)) return;
  const directories = [root], files = [];
  const visit = directory => fs.readdirSync(directory).forEach(name => {
    const target = path.join(directory, name), state = fs.lstatSync(target);
    if (state.isDirectory() && !state.isSymbolicLink()) { directories.push(target); visit(target); }
    else files.push(target);
  });
  visit(root);
  files.forEach(file => fs.unlinkSync(file));
  directories.sort((left, right) => right.length - left.length).forEach(directory => fs.rmdirSync(directory));
}

function captureDiagnosticEvents(t, diagnostics, globalRoot) {
  const entries = [];
  diagnostics.configureLocalDiagnosticPersistence({
    append(_root, event) {
      entries.push({ at: event.occurredAt, traceId: event.payload.traceId, stage: event.scope,
        status: event.payload.status, durationMs: event.payload.durationMs, ...(event.payload.message ? { message: event.payload.message } : {}) });
    }
  }, globalRoot);
  t.after(() => diagnostics.configureLocalDiagnosticPersistence(undefined));
  return entries;
}

function createConversationDataRequest() {
  const values = new Map();
  return async (_root, request) => {
    if (request.operation === 'read_intelligence_conversation') {
      const value = values.get(request.input.id);
      return value ? { conversation: structuredClone(value.conversation), revision: value.revision } : null;
    }
    if (request.operation === 'list_intelligence_conversations') {
      return [...values.values()].map(value => ({ id: value.conversation.id, title: value.conversation.title, updatedAt: value.conversation.updatedAt }))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }
    if (request.operation === 'write_intelligence_conversation') {
      const current = values.get(request.input.conversation.id);
      if ((current?.revision || 0) !== request.input.expectedRevision) throw new Error('revision_conflict');
      const revision = (current?.revision || 0) + 1;
      values.set(request.input.conversation.id, { conversation: structuredClone(request.input.conversation), revision });
      return { revision };
    }
    throw new Error(`unexpected intelligence operation: ${request.operation}`);
  };
}

test('smart kernel read tools are discovered and called through standard MCP', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { createIntelligenceMcpSession } = require('../out/intelligenceMcp.js');
  const session = await createIntelligenceMcpSession({
    getProjects: () => [{ name: 'Alpha', path: '/private/alpha' }],
    getSelectedProjectPath: () => '/private/alpha',
    getCurrentSteps: async () => [{ title: '完成登录', status: 'Pending' }],
    getSettings: () => ({ language: 'zh', cognitiveAgent: 'codex', cognitiveModel: 'gpt-test', telegramBotToken: 'secret' }),
    getTodayReview: () => ({ summary: '今天先验证付费', items: ['检查支付流程'] })
  });
  try {
    assert.ok(session.client instanceof Client);
    const tools = await session.client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(),
      ['get_current_project', 'get_plugin_settings', 'get_today_review', 'list_projects']);
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
    const today = await session.client.callTool({ name: 'get_today_review', arguments: {} });
    assert.deepEqual(JSON.parse(today.content[0].text), { summary: '今天先验证付费', items: ['检查支付流程'] });
    const write = await session.client.callTool({ name: 'update_settings', arguments: {} });
    assert.equal(write.isError, true);
  } finally {
    await session.close();
  }
});

test('smart kernel gives Pi the current project context before tool selection', async () => {
  const { buildIntelligenceProjectContext } = require('../out/intelligenceReadTools.js');
  const context = await buildIntelligenceProjectContext({
    getProjects: async () => [
      { name: 'Alpha', path: '/private/alpha', priority: 'P1' },
      { name: 'Beta', path: '/private/beta', description: '验证付费路径' }
    ],
    getSelectedProjectPath: () => '/private/beta',
    getCurrentSteps: async () => [{ title: '完成结账回归', status: 'Running' }],
    getSettings: () => ({ language: 'zh' }),
    getTodayReview: async () => ({ summary: '今天先完成付费闭环', items: ['核对结账结果'] })
  });
  assert.deepEqual(context, {
    selectedProject: 'Beta',
    projects: [
      { name: 'Alpha', priority: 'P1' },
      { name: 'Beta', description: '验证付费路径' }
    ],
    today: { summary: '今天先完成付费闭环', items: ['核对结账结果'] },
    currentSteps: [{ title: '完成结账回归', status: 'Running' }]
  });

  const extension = fs.readFileSync(path.join(__dirname, '../out/extension.js'), 'utf8');
  const start = extension.indexOf('const getIntelligenceConversationStore');
  const end = extension.indexOf('// Register Sidebar Webview View Provider', start);
  const smartKernel = extension.slice(start, end);
  assert.match(smartKernel, /buildIntelligenceProjectContext/);
  assert.match(smartKernel, /readIntelligenceCurrentSteps/);
  assert.doesNotMatch(smartKernel, /syncEngine\.getNodes\(\)/);
  assert.doesNotMatch(smartKernel, /engine\.chat\(messages, \{ selectedProject: '', projects: \[\] \}/);
});

test('smart kernel treats a new project without a roadmap file as an empty authoritative roadmap', async () => {
  const { readIntelligenceCurrentSteps } = require('../out/intelligenceReadTools.js');
  const calls = [];
  const steps = await readIntelligenceCurrentSteps('/workspace/new-project', async (operation, input) => {
    calls.push({ operation, input });
    if (operation === 'read_roadmap') throw new Error('roadmap_import_required');
    const error = new Error('ENOENT: no such file or directory');
    error.code = 'ENOENT';
    throw error;
  });
  assert.deepEqual(steps, []);
  assert.deepEqual(calls, [
    { operation: 'read_roadmap', input: { root: '/workspace/new-project' } },
    { operation: 'accept_roadmap_csv', input: { root: '/workspace/new-project' } }
  ]);
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
  assert.match(invocations[0].stdin, /USER:\n先修登录还是做导出/);
  assert.match(invocations[0].stdin, /ASSISTANT:\n先确认影响范围/);
  assert.match(invocations[0].stdin, /USER:\n怎么确认/);
  assert.equal(invocations[0].stdin.split('怎么确认？').length - 1, 1, 'the current user message must be appended once');
  assert.match(invocations[0].stdin, /我的应用/);
  assert.match(invocations[0].stdin, /projectContext 是请求开始时从当前权威数据读取的快照/);
  assert.match(invocations[0].stdin, /所需事实不在 projectContext 中时/);
  assert.doesNotMatch(invocations[0].stdin, /USER:[\s\S]*"projectContext"/,
    'the project snapshot belongs to ephemeral system context, not a user envelope');
  assert.match(invocations[0].args.join(' '), /--sandbox read-only/);
});

test('smart kernel delegates long conversation compaction to Pi Harness', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const messages = [];
  for (let index = 0; index < 90; index += 1) {
    messages.push({ role: 'user', content: `question-${index}-${'u'.repeat(6_000)}` });
    messages.push({ role: 'assistant', content: `answer-${index}-${'a'.repeat(6_000)}` });
  }
  messages.push({ role: 'user', content: 'current-question-must-survive' });
  const invocations = [];
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', model: 'gpt-test', runner: async invocation => {
      invocations.push(invocation);
      return invocation.stdin.includes('You are a context summarization assistant')
        ? 'HARNESS-CHECKPOINT-SUMMARY'
        : 'answer after harness compaction';
    }
  });

  assert.equal(await engine.chat(messages, { selectedProject: '', projects: [] }), 'answer after harness compaction');
  assert.equal(invocations.length, 2, 'Pi Harness must make one summary request before the answer request');
  assert.equal(invocations[0].maxOutputCharacters, 52_428,
    'the Agent CLI summary boundary must consume Pi Harness maxTokens');
  assert.match(invocations[0].stdin, /Create a structured context checkpoint summary/);
  assert.match(invocations[0].stdin, /question-0-/);
  assert.match(invocations[1].stdin, /The conversation history before this point was compacted/);
  assert.match(invocations[1].stdin, /HARNESS-CHECKPOINT-SUMMARY/);
  assert.doesNotMatch(invocations[1].stdin, /question-0-/);
  assert.match(invocations[1].stdin, /question-89-/);
  assert.match(invocations[1].stdin, /current-question-must-survive/);
});

test('smart kernel adds no summary request or checkpoint below the Pi Harness threshold', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const prompts = [];
  const checkpoints = [];
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async invocation => {
    prompts.push(invocation.stdin);
    return 'ordinary answer';
  } });

  assert.equal(await engine.chat([{ role: 'user', content: 'short question' }],
    { selectedProject: '', projects: [] }, undefined, { stageCheckpoint: checkpoint => checkpoints.push(checkpoint) }), 'ordinary answer');
  assert.equal(prompts.length, 1);
  assert.deepEqual(checkpoints, []);
});

test('smart kernel chat answers a project question after reading current plugin data', async t => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const { createIntelligenceMcpSession } = require('../out/intelligenceMcp.js');
  const diagnostics = require('../out/localDiagnostics.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-trace-'));
  const globalRoot = path.join(root, '.solomap-global');
  const events = captureDiagnosticEvents(t, diagnostics, globalRoot);
  t.after(() => {
    removeDiagnosticTrace(globalRoot);
    if (fs.existsSync(globalRoot)) fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  });
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
  const trace = diagnostics.createLocalDiagnosticTrace(globalRoot, 'sidebar.chat');
  const reply = await diagnostics.withLocalDiagnosticTrace(trace, () => engine.chat([{ role: 'user', content: '当前项目还要做什么？' }],
    { selectedProject: '', projects: [] }, session.client));
  await session.close();
  assert.equal(reply, '当前项目 Beta 尚需验证付费。');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /USER:\n当前项目还要做什么/);
  assert.match(prompts[1], /ASSISTANT:\n[^\n]*"type":"toolCall"[^\n]*"id":"read-1"[^\n]*"name":"get_current_project"[^\n]*"arguments":\{\}/);
  assert.match(prompts[1], /TOOLRESULT:\n[^\n]*"toolCallId":"read-1"[^\n]*"toolName":"get_current_project"/);
  assert.match(prompts[1], /Beta/);
  assert.match(prompts[1], /验证付费/);
  assert.doesNotMatch(prompts[0], /Alpha/);
  assert.doesNotMatch(prompts[1], /\/beta/);
  assert.equal(events.filter(event => event.stage === 'model.cli' && event.status === 'ok').length, 2);
  assert.ok(events.some(event => event.stage === 'mcp.list' && event.status === 'ok'));
  assert.ok(events.some(event => event.stage === 'mcp.get_current_project' && event.status === 'ok'));
  assert.doesNotMatch(JSON.stringify(events), /完成登录|验证付费|\/beta/);
});

test('smart kernel uses Pi Harness compaction boundaries while retaining complete recent turns', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const messages = [];
  for (let index = 0; index < 90; index += 1) {
    messages.push({ role: 'user', content: `question-${index}-${'u'.repeat(6_000)}` });
    messages.push({ role: 'assistant', content: `answer-${index}-${'a'.repeat(6_000)}` });
  }
  messages.push({ role: 'user', content: 'current-question-must-survive' });
  const originalMessages = structuredClone(messages);
  let prompt = '';
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', runner: async invocation => {
      prompt = invocation.stdin;
      return 'bounded answer';
    }
  });

  assert.equal(await engine.chat(messages, { selectedProject: '', projects: [] }), 'bounded answer');
  assert.doesNotMatch(prompt, /question-0-|answer-0-/);
  assert.match(prompt, /The conversation history before this point was compacted/);
  assert.match(prompt, /USER:\nquestion-89-/);
  assert.match(prompt, /ASSISTANT:\nanswer-89-/);
  assert.match(prompt, /USER:\ncurrent-question-must-survive/);
  assert.equal(prompt.split('current-question-must-survive').length - 1, 1);
  assert.deepEqual(messages, originalMessages, 'context projection must not mutate durable conversation messages');
});

test('smart kernel leaves a request below the selected Pi catalog model threshold intact', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const messages = [{ role: 'user', content: `current-start-${'x'.repeat(700_000)}-current-end` }];
  const originalMessages = structuredClone(messages);
  let prompt = '';
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', model: 'gpt-5.5', runner: async invocation => {
      prompt = invocation.stdin;
      return 'bounded answer';
    }
  });

  assert.equal(await engine.chat(messages, { selectedProject: '', projects: [] }), 'bounded answer');
  assert.match(prompt, /USER:\ncurrent-start-/);
  assert.match(prompt, /-current-end/);
  assert.doesNotMatch(prompt, /context truncated/);
  assert.deepEqual(messages, originalMessages);
});

test('smart kernel leaves a tool result below the Pi Harness output limit intact', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const { createIntelligenceMcpSession } = require('../out/intelligenceMcp.js');
  const prompts = [];
  const session = await createIntelligenceMcpSession({
    getProjects: () => [{ name: 'Alpha', path: '/alpha' }],
    getSelectedProjectPath: () => '/alpha',
    getCurrentSteps: () => [{ title: `tool-start-${'t'.repeat(40_000)}-tool-end`, status: 'Pending' }],
    getSettings: () => ({ language: 'zh' })
  });
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', runner: async invocation => {
      prompts.push(invocation.stdin);
      return prompts.length === 1 ? '{"toolCall":{"name":"get_current_project"}}' : 'bounded tool answer';
    }
  });

  try {
    assert.equal(await engine.chat([{ role: 'user', content: 'keep-current-turn' }],
      { selectedProject: '', projects: [] }, session.client), 'bounded tool answer');
  } finally {
    await session.close();
  }
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /USER:\nkeep-current-turn/);
  assert.match(prompts[1], /"type":"toolCall","id":"read-1","name":"get_current_project"/);
  assert.match(prompts[1], /TOOLRESULT:\n[^\n]*"toolCallId":"read-1","toolName":"get_current_project"/);
  assert.match(prompts[1], /tool-start-/);
  assert.match(prompts[1], /-tool-end/);
  assert.doesNotMatch(prompts[1], /context truncated/);
});

test('smart kernel applies the Pi Harness tool-output limit before the next model request', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const prompts = [];
  const readTools = {
    async listTools() {
      return { tools: [{
        name: 'get_current_project', description: 'Read current project',
        inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }
      }] };
    },
    async callTool() {
      return {
        content: Array.from({ length: 20_000 }, (_, index) => ({
          type: 'text', text: `block-${index}-${'v'.repeat(32)}`
        }))
      };
    }
  };
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', runner: async invocation => {
      prompts.push(invocation.stdin);
      if (invocation.stdin.includes('You are a context summarization assistant')) return 'MULTI-BLOCK-HARNESS-CHECKPOINT';
      return prompts.length === 1 ? '{"toolCall":{"name":"get_current_project"}}' : 'bounded blocks answer';
    }
  });

  assert.equal(await engine.chat([{ role: 'user', content: 'keep-many-blocks-turn' }],
    { selectedProject: '', projects: [] }, readTools), 'bounded blocks answer');
  assert.equal(prompts.length, 2, 'bounded tool output must not need conversation compaction');
  assert.match(prompts[1], /USER:\nkeep-many-blocks-turn/);
  assert.match(prompts[1], /"type":"toolCall","id":"read-1","name":"get_current_project"/);
  assert.match(prompts[1], /TOOLRESULT:\n[^\n]*"toolCallId":"read-1","toolName":"get_current_project"/);
  assert.match(prompts[1], /block-0-/);
  assert.doesNotMatch(prompts[1], /block-19999-/);
  assert.match(prompts[1], /Pi Harness tool output limit/);
  assert.ok(prompts[1].length < 128_000 * 4, 'the final provider input must stay inside the model window');
});

test('smart kernel uses Pi catalog context windows for an explicitly selected Agent CLI model', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const messages = [];
  for (let index = 0; index < 50; index += 1) {
    messages.push({ role: 'user', content: `question-${index}-${'u'.repeat(4_500)}` });
    messages.push({ role: 'assistant', content: `answer-${index}-${'a'.repeat(4_500)}` });
  }
  messages.push({ role: 'user', content: 'catalog-window-question' });
  const compactModelCalls = [];
  const compactModel = new EmbeddedPiAgentEngine({
    agentCli: 'codex', model: 'gpt-5.3-codex-spark', runner: async invocation => {
      compactModelCalls.push(invocation);
      return invocation.stdin.includes('You are a context summarization assistant') ? 'CATALOG-SUMMARY' : 'compact answer';
    }
  });
  const largeModelCalls = [];
  const largeModel = new EmbeddedPiAgentEngine({
    agentCli: 'codex', model: 'gpt-5.5', runner: async invocation => {
      largeModelCalls.push(invocation);
      return 'large-window answer';
    }
  });

  assert.equal(await compactModel.chat(messages, { selectedProject: '', projects: [] }), 'compact answer');
  assert.equal(await largeModel.chat(messages, { selectedProject: '', projects: [] }), 'large-window answer');
  assert.ok(compactModelCalls.length > 1, 'the 128k Pi catalog model must compact this history');
  assert.equal(largeModelCalls.length, 1, 'the 272k Pi catalog model must keep the same history intact');
});

test('smart kernel preserves Pi split-turn summary budgets across the Agent CLI boundary', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const calls = [];
  const messages = [
    { role: 'user', content: `old-question-${'q'.repeat(60_000)}` },
    { role: 'assistant', content: `old-answer-${'r'.repeat(60_000)}` },
    { role: 'user', content: 'large-turn-question' },
    { role: 'assistant', content: `large-turn-answer-${'s'.repeat(350_000)}` },
    { role: 'user', content: 'current-split-turn-question' }
  ];
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', model: 'gpt-5.3-codex-spark', runner: async invocation => {
      calls.push(invocation);
      if (invocation.stdin.includes('You are a context summarization assistant')) return 'SPLIT-TURN-SUMMARY';
      return 'split-turn answer';
    }
  });

  assert.equal(await engine.chat(messages, { selectedProject: '', projects: [] }), 'split-turn answer');
  const summaryCalls = calls.filter(call => call.stdin.includes('You are a context summarization assistant'));
  assert.deepEqual(summaryCalls.map(call => call.maxOutputCharacters), [52_428, 32_768]);
  assert.ok(calls.at(-1).stdin.length < 128_000 * 4, 'the rebuilt split turn must fit the Pi catalog model window');
});

test('smart kernel rejects a compaction response beyond the Pi Harness output budget', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const messages = [];
  for (let index = 0; index < 50; index += 1) {
    messages.push({ role: 'user', content: `question-${index}-${'u'.repeat(4_500)}` });
    messages.push({ role: 'assistant', content: `answer-${index}-${'a'.repeat(4_500)}` });
  }
  messages.push({ role: 'user', content: 'summary-budget-question' });
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', model: 'gpt-5.3-codex-spark', runner: async invocation =>
      invocation.stdin.includes('You are a context summarization assistant') ? 'x'.repeat(52_429) : 'must not answer'
  });

  await assert.rejects(() => engine.chat(messages, { selectedProject: '', projects: [] }), /summary output budget/i);
});

test('smart kernel does not treat a historical project as the current topic for a greeting', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  let prompt = '';
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', runner: async invocation => {
      prompt = invocation.stdin;
      return '你好，我可以帮你查询项目和插件信息。';
    }
  });
  const answer = await engine.chat([
    { role: 'assistant', content: 'SZLKlaws 的路线图已更新。' },
    { role: 'user', content: '你好' }
  ], { selectedProject: '', projects: [] });
  assert.match(prompt, /历史回答里出现的项目名称不代表当前项目/);
  assert.match(prompt, /泛问候、能力介绍和无关话题不要主动带入项目/);
  assert.equal(answer, '你好，我可以帮你查询项目和插件信息。');
});

test('Telegram replies continue in the sidebar Pi conversation and can use read-only MCP', async t => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const { createIntelligenceMcpSession } = require('../out/intelligenceMcp.js');
  const { IntelligenceConversationStore } = require('../out/intelligenceChat.js');
  const { createTelegramIntelligenceReply } = require('../out/telegramIntelligenceChat.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-tg-pi-'));
  t.after(() => {
    cleanupExact(root);
  });
  const prompts = [];
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', runner: async invocation => {
      prompts.push(invocation.stdin);
      if (prompts.length === 1) return '{"toolCall":{"name":"get_current_project"}}';
      return prompts.length === 2 ? '当前项目 Beta 尚需验证付费。' : '先验证付费流程。';
    }
  });
  const dataRequest = createConversationDataRequest();
  const store = new IntelligenceConversationStore(root, async messages => {
    const session = await createIntelligenceMcpSession({
      getProjects: () => [{ name: 'Beta', path: '/private/beta' }],
      getSelectedProjectPath: () => '/private/beta',
      getCurrentSteps: () => [{ title: '验证付费', status: 'Pending' }],
      getSettings: () => ({ language: 'zh' })
    });
    try {
      return await engine.chat(messages, { selectedProject: 'Beta', projects: ['Beta'] }, session.client);
    } finally {
      await session.close();
    }
  }, dataRequest);
  const sidebarConversation = await store.send('当前项目还要做什么？');
  let savedIds = { '123456': sidebarConversation.id };
  const reply = createTelegramIntelligenceReply(() => store, () => savedIds, async ids => { savedIds = ids; }, () => 0);
  assert.equal(await reply('123456', '先做哪一步？'), '先验证付费流程。');
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.get(savedIds['123456'])).messages.length, 4);
  assert.match(prompts[1], /"toolCallId":"read-1"/);
  assert.match(prompts[1], /验证付费/);
  assert.match(prompts[2], /当前项目 Beta 尚需验证付费/);
  assert.doesNotMatch(prompts[2], /"toolCallId":"read-1"/,
    'internal tool messages from a completed turn must not be persisted into the next request');
  assert.doesNotMatch(prompts.join('\n'), /\/private\/beta/);
});

test('each request uses a fresh project snapshot without storing snapshots in conversation history', async t => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const { IntelligenceConversationStore } = require('../out/intelligenceChat.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-project-snapshot-'));
  t.after(() => cleanupExact(root));
  const prompts = [];
  let projectContext = { selectedProject: 'snapshot-alpha', projects: ['snapshot-alpha'] };
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', runner: async invocation => {
      prompts.push(invocation.stdin);
      return prompts.length === 1 ? 'first-visible-answer' : 'second-visible-answer';
    }
  });
  const store = new IntelligenceConversationStore(root,
    messages => engine.chat(messages, projectContext), createConversationDataRequest());

  const first = await store.send('first-user-question');
  projectContext = { selectedProject: 'snapshot-beta', projects: ['snapshot-beta'] };
  const second = await store.send('second-user-question', first.id);

  assert.match(prompts[0], /snapshot-alpha/);
  assert.match(prompts[1], /snapshot-beta/);
  assert.doesNotMatch(prompts[1], /snapshot-alpha/);
  assert.doesNotMatch(JSON.stringify(second.messages), /snapshot-alpha|snapshot-beta/);
});

test('unlinking Telegram during a Pi answer cannot restore its old conversation', async t => {
  const { IntelligenceConversationStore } = require('../out/intelligenceChat.js');
  const { createTelegramIntelligenceReply } = require('../out/telegramIntelligenceChat.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-tg-unlink-'));
  t.after(() => {
    cleanupExact(root);
  });
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const store = new IntelligenceConversationStore(root, async () => { await waiting; return '旧答案'; }, createConversationDataRequest());
  let savedIds = {};
  let generation = 0;
  const reply = createTelegramIntelligenceReply(() => store, () => savedIds,
    async ids => { savedIds = ids; }, () => generation);
  const pending = reply('123456', '旧问题');
  generation++;
  savedIds = {};
  release();
  await assert.rejects(pending, /intelligence_reply_revoked/);
  assert.deepEqual(savedIds, {});
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

test('smart kernel and Telegram conversations can set a time schedule through the shared MCP tool', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const { createIntelligenceMcpSession } = require('../out/intelligenceMcp.js');
  const scheduled = [];
  const session = await createIntelligenceMcpSession({
    getProjects: () => [{ name: 'Alpha', path: '/alpha' }],
    getSelectedProjectPath: () => '/alpha',
    getCurrentSteps: () => null,
    getSettings: () => ({ language: 'zh' })
  }, undefined, {
    setTimeSchedule: async input => {
      scheduled.push(input);
      return { taskId: 'intelligence-task-1', scheduledAt: input.scheduledAt };
    }
  });
  let calls = 0;
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', runner: async invocation => {
      calls += 1;
      if (calls === 1) {
        assert.match(invocation.stdin, /set_time_schedule/);
        return JSON.stringify({ toolCall: { name: 'set_time_schedule', arguments: {
          title: '检查发布结果', scheduleKind: 'once', scheduledAt: '2099-10-18T09:00:00+08:00',
          assignee: 'user'
        } } });
      }
      assert.match(invocation.stdin, /intelligence-task-1/);
      return '已安排在明天上午 9 点。';
    }
  });
  try {
    assert.equal(await engine.chat([{ role: 'user', content: '明天上午 9 点提醒我检查发布结果' }],
      { selectedProject: 'Alpha', projects: ['Alpha'] }, session.client), '已安排在明天上午 9 点。');
    assert.deepEqual(scheduled, [{
      title: '检查发布结果', scheduleKind: 'once', scheduledAt: '2099-10-18T09:00:00+08:00',
      assignee: 'user'
    }]);
  } finally {
    await session.close();
  }
});

test('time schedule validation returns Chinese guidance for user-correctable fields', () => {
  const { validateIntelligenceTimeScheduleInput } = require('../out/intelligenceMcp.js');
  assert.throws(() => validateIntelligenceTimeScheduleInput({ title: '提醒', scheduleKind: 'once', scheduledAt: 'tomorrow', assignee: 'user' }), /未来时间.*时区/);
  assert.throws(() => validateIntelligenceTimeScheduleInput({ title: '提醒', scheduleKind: 'daily', assignee: 'user' }), /每日安排.*HH:mm/);
  assert.throws(() => validateIntelligenceTimeScheduleInput({ title: '执行', scheduleKind: 'daily', timeOfDay: '09:00', assignee: 'agent' }), /Agent.*执行提示/);
});

test('standalone Telegram scheduling writes the authoritative settings and schedule ledger idempotently', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-intelligence-schedule-'));
  const globalRoot = path.join(base, 'global'), projectRoot = path.join(base, 'project');
  fs.mkdirSync(projectRoot);
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
  const { setIntelligenceTimeScheduleInDatabase } = require('../out/intelligenceTimeSchedule.js');
  const store = new UnifiedDataStore(globalRoot), operations = createRuntimeDataOperations(store);
  const call = (operation, input) => operations({ operation, input });
  const input = { title: '检查发布结果', scheduleKind: 'once', scheduledAt: '2099-10-18T09:00:00+08:00', assignee: 'user' };
  try {
    const first = await setIntelligenceTimeScheduleInDatabase(globalRoot, { name: 'Alpha', path: projectRoot }, input, call);
    const second = await setIntelligenceTimeScheduleInDatabase(globalRoot, { name: 'Alpha', path: projectRoot }, input, call);
    assert.equal(second.taskId, first.taskId);
    const settings = await call('read_host_settings', { namespace: 'extension', ownerScope: 'global' });
    const automation = settings.items.find(item => item.key === 'automationTasks').value;
    assert.equal(automation.scheduledTasks.length, 1);
    assert.equal(automation.scheduledTasks[0].id, first.taskId);
    const ledger = await call('read_schedule_ledger', {});
    assert.equal(ledger.tasks.length, 1);
    assert.equal(ledger.tasks[0].taskId, first.taskId);
  } finally {
    await operations.close(); store.close(); cleanupExact(base);
  }
});

test('standalone Telegram scheduling preserves the active focus reminder in the shared schedule ledger', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-intelligence-focus-schedule-'));
  const globalRoot = path.join(base, 'global'), projectRoot = path.join(base, 'project');
  fs.mkdirSync(projectRoot);
  const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
  const { createRuntimeDataOperations } = require('../out/runtimeDataOperations.js');
  const { setIntelligenceTimeScheduleInDatabase } = require('../out/intelligenceTimeSchedule.js');
  const { syncScheduledTaskDatabase } = require('../out/scheduledTaskLedger.js');
  const store = new UnifiedDataStore(globalRoot), operations = createRuntimeDataOperations(store);
  const call = (operation, input) => operations({ operation, input });
  const focus = { id: '__solomap_focus_reminder__', title: '专注时间提醒', enabled: true, assignee: 'user', scheduleKind: 'once',
    scheduledAt: '2099-10-18T08:30:00+08:00', projectPath: projectRoot, internalKind: 'focus_reminder', focusMinutes: 25, notify: true, sound: false };
  try {
    await syncScheduledTaskDatabase(projectRoot, globalRoot, [focus], new Date('2099-10-18T00:00:00Z'), call);
    const scheduled = await setIntelligenceTimeScheduleInDatabase(globalRoot, { name: 'Alpha', path: projectRoot },
      { title: '检查发布结果', scheduleKind: 'once', scheduledAt: '2099-10-18T09:00:00+08:00', assignee: 'user' }, call);
    const ledger = await call('read_schedule_ledger', {});
    assert.deepEqual(new Set(ledger.tasks.map(item => item.taskId)), new Set([focus.id, scheduled.taskId]));
  } finally {
    await operations.close(); store.close(); cleanupExact(base);
  }
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

test('smart kernel chat lets the model answer after an MCP transport failure', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  let calls = 0;
  const prompts = [];
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', runner: async invocation => {
      prompts.push(invocation.stdin);
      return ++calls === 1
        ? '{"toolCall":{"name":"get_current_project"}}'
        : '暂时无法读取当前项目，请稍后再试。';
    }
  });
  const readTools = {
    listTools: async () => ({ tools: [{ name: 'get_current_project', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false } }] }),
    callTool: async () => { throw new Error('MCP transport disconnected'); }
  };
  assert.equal(await engine.chat([{ role: 'user', content: '当前项目状态？' }],
    { selectedProject: '', projects: [] }, readTools), '暂时无法读取当前项目，请稍后再试。');
  assert.equal(calls, 2);
  assert.match(prompts[1], /"isError":true/);
  assert.match(prompts[1], /mcp_transport_error/);
  assert.doesNotMatch(prompts[1], /MCP transport disconnected/);
});

test('smart kernel records an MCP tool error and lets the model continue', async t => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const diagnostics = require('../out/localDiagnostics.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-mcp-error-'));
  const globalRoot = path.join(root, '.solomap-global');
  const events = captureDiagnosticEvents(t, diagnostics, globalRoot);
  t.after(() => {
    removeDiagnosticTrace(globalRoot);
    if (fs.existsSync(globalRoot)) fs.rmdirSync(globalRoot);
    fs.rmdirSync(root);
  });
  let modelCalls = 0;
  const prompts = [];
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async invocation => {
    prompts.push(invocation.stdin);
    return ++modelCalls === 1
      ? '{"toolCall":{"name":"get_current_project"}}'
      : '无法读取当前项目。';
  } });
  const tools = {
    listTools: async () => ({ tools: [{ name: 'get_current_project', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false } }] }),
    callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'private project detail' }] })
  };
  const trace = diagnostics.createLocalDiagnosticTrace(globalRoot, 'sidebar.chat');
  assert.equal(await diagnostics.withLocalDiagnosticTrace(trace, () => engine.chat([{ role: 'user', content: '查项目' }],
    { selectedProject: '', projects: [] }, tools)), '无法读取当前项目。');
  assert.equal(modelCalls, 2);
  assert.match(prompts[1], /"isError":true/);
  assert.match(prompts[1], /mcp_tool_error/);
  assert.doesNotMatch(prompts[1], /private project detail/);
  assert.ok(events.some(event => event.stage === 'mcp.get_current_project' && event.status === 'error' && event.message === 'mcp_tool_error'));
  assert.ok(!events.some(event => event.stage === 'mcp.get_current_project' && event.status === 'ok'));
  assert.doesNotMatch(JSON.stringify(events), /private project detail/);
});

test('smart kernel chat saves a separate durable conversation and resumes its history', async t => {
  const { IntelligenceConversationStore } = require('../out/intelligenceChat.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-intelligence-chat-'));
  const replies = [];
  let conversationId = '';
  const dataRequest = createConversationDataRequest();
  const store = new IntelligenceConversationStore(root, async messages => {
    replies.push(messages.map(message => message.content));
    return replies.length === 1 ? '先确认影响范围。' : '查看最近的登录失败反馈。';
  }, dataRequest);
  t.after(() => {
    cleanupExact(root);
  });
  const first = await store.send('先修登录还是做导出？');
  conversationId = first.id;
  assert.equal(first.messages.length, 2);
  const second = await store.send('怎么确认影响范围？', first.id);
  assert.equal(second.id, first.id);
  assert.equal(second.messages.length, 4);
  assert.deepEqual(replies[1], ['先修登录还是做导出？', '先确认影响范围。', '怎么确认影响范围？']);
  const reopened = new IntelligenceConversationStore(root, async () => 'unused', dataRequest);
  assert.equal((await reopened.list())[0].id, first.id);
  assert.deepEqual((await reopened.get(first.id)).messages, second.messages);
});

test('a revision retry regenerates from committed history and commits one complete turn', async t => {
  const { IntelligenceConversationStore } = require('../out/intelligenceChat.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-intelligence-revision-'));
  t.after(() => cleanupExact(root));
  const values = new Map();
  let firstWrite = true;
  const requests = async (_root, request) => {
    if (request.operation === 'read_intelligence_conversation') {
      const value = values.get(request.input.id);
      return value ? structuredClone(value) : null;
    }
    if (request.operation === 'list_intelligence_conversations') return [];
    if (request.operation === 'write_intelligence_conversation') {
      if (firstWrite) {
        assert.equal(request.input.contextCheckpoint?.summary, 'discard with conflicted generation');
        firstWrite = false;
        const requested = request.input.conversation;
        values.set(requested.id, {
          revision: 1,
          conversation: {
            ...structuredClone(requested),
            messages: [
              { role: 'user', content: '另一入口的问题' },
              { role: 'assistant', content: '另一入口的回答' }
            ]
          }
        });
        throw new Error('revision_conflict');
      }
      const current = values.get(request.input.conversation.id);
      assert.equal(request.input.expectedRevision, current.revision);
      assert.equal(Object.prototype.hasOwnProperty.call(request.input, 'contextCheckpoint'), false,
        'a checkpoint staged against conflicted history must not leak into the retry');
      values.set(request.input.conversation.id, {
        revision: current.revision + 1,
        conversation: structuredClone(request.input.conversation)
      });
      return { revision: current.revision + 1 };
    }
    throw new Error(`unexpected intelligence operation: ${request.operation}`);
  };
  const seen = [];
  const store = new IntelligenceConversationStore(root, async (messages, context) => {
    seen.push(structuredClone(messages));
    if (seen.length === 1) context.stageCheckpoint({
      schemaVersion: 1,
      engine: 'pi-harness',
      sourceMessageCount: messages.length,
      sourceHash: '0'.repeat(64),
      retainedMessageCount: 1,
      tokensBefore: 200_000,
      summary: 'discard with conflicted generation',
      createdAt: Date.now()
    });
    return seen.length === 1 ? '应被冲突丢弃的回答' : '基于最新历史的回答';
  }, requests);

  const conversation = await store.send('我的问题');
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].map(message => message.content), ['另一入口的问题', '另一入口的回答', '我的问题']);
  assert.deepEqual(conversation.messages.map(message => message.content),
    ['另一入口的问题', '另一入口的回答', '我的问题', '基于最新历史的回答']);
  assert.equal(conversation.messages.filter(message => message.content === '我的问题').length, 1);
  assert.equal(conversation.messages.filter(message => message.role === 'assistant').length, 2);
});

test('smart kernel chat keeps the draft available when generation fails', async t => {
  const { IntelligenceConversationStore } = require('../out/intelligenceChat.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-intelligence-chat-failure-'));
  t.after(() => {
    cleanupExact(root);
  });
  const store = new IntelligenceConversationStore(root, async () => { throw new Error('model unavailable'); }, createConversationDataRequest());
  await assert.rejects(() => store.send('继续这个问题'), /model unavailable/);
  assert.deepEqual(await store.list(), []);
});

test('a failed answer persists neither the turn nor a staged Pi Harness checkpoint', async t => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const { IntelligenceConversationStore } = require('../out/intelligenceChat.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-intelligence-compaction-failure-'));
  t.after(() => cleanupExact(root));
  const dataRequest = createConversationDataRequest();
  const messages = [];
  for (let index = 0; index < 90; index += 1) {
    messages.push({ role: 'user', content: `question-${index}-${'u'.repeat(6_000)}` });
    messages.push({ role: 'assistant', content: `answer-${index}-${'a'.repeat(6_000)}` });
  }
  let writes = 0;
  const observingRequest = async (databaseRoot, request) => {
    if (request.operation === 'read_intelligence_conversation') {
      return { revision: 1, conversation: { id: request.input.id, title: 'Long history', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), messages } };
    }
    if (request.operation === 'write_intelligence_conversation') writes += 1;
    return dataRequest(databaseRoot, request);
  };
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async invocation => {
    if (invocation.stdin.includes('You are a context summarization assistant')) return 'UNCOMMITTED-CHECKPOINT';
    throw new Error('answer generation failed');
  } });
  const store = new IntelligenceConversationStore(root,
    (history, context) => engine.chat(history, { selectedProject: '', projects: [] }, undefined, context), observingRequest);

  await assert.rejects(() => store.send('current question', 'be9f6c55-2cee-4fad-bf47-c4635c5884e8'), /answer generation failed/);
  assert.equal(writes, 0);
});

test('cancelling a Pi chat commits neither the current user nor a partial assistant turn', async t => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const { IntelligenceConversationStore } = require('../out/intelligenceChat.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-intelligence-cancel-'));
  t.after(() => cleanupExact(root));
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', runner: async () => {
      await waiting;
      return '取消后到达的回答';
    }
  });
  const store = new IntelligenceConversationStore(root,
    messages => engine.chat(messages, { selectedProject: '', projects: [] }), createConversationDataRequest());
  const pending = store.send('不要留下半轮消息');
  await new Promise(resolve => setImmediate(resolve));
  engine.cancel();
  release();

  await assert.rejects(pending, /cancelled|aborted/i);
  assert.deepEqual(await store.list(), []);
});
