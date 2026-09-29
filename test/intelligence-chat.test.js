const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

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
  const { createIntelligenceReadTools } = require('../out/intelligenceReadTools.js');
  let selected = 'Alpha';
  const prompts = [];
  const tools = createIntelligenceReadTools({
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
    { selectedProject: 'Alpha', projects: ['Alpha'] }, tools);
  assert.equal(reply, '当前项目 Beta 尚需验证付费。');
  assert.equal(prompts.length, 2);
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
  const { createIntelligenceReadTools } = require('../out/intelligenceReadTools.js');
  const tools = createIntelligenceReadTools({
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
    { selectedProject: '', projects: [] }, tools);
  assert.equal(answer, '当前智能内核使用 Codex 的 gpt-test 模型。');
  assert.equal(calls, 2);
});

test('smart kernel chat does not show broken tool JSON as a reply', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async () => '{"toolCall":{' });
  await assert.rejects(() => engine.chat([{ role: 'user', content: '查当前项目' }],
    { selectedProject: '', projects: [] }, { call: async () => ({}) }), /invalid read tool request/i);
});

test('smart kernel chat does not show an early truncated tool request as a reply', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async () => '{"toolCall"' });
  await assert.rejects(() => engine.chat([{ role: 'user', content: '查当前项目' }],
    { selectedProject: '', projects: [] }, { call: async () => ({}) }), /invalid read tool request/i);
});

test('smart kernel chat can answer with a plain code fragment', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async () => '{ key: value }' });
  assert.equal(await engine.chat([{ role: 'user', content: '给我一个对象片段' }],
    { selectedProject: '', projects: [] }, { call: async () => ({}) }), '{ key: value }');
});

test('smart kernel chat rejects an unlisted tool before returning an answer', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const { createIntelligenceReadTools } = require('../out/intelligenceReadTools.js');
  const tools = createIntelligenceReadTools({
    getProjects: () => [], getSelectedProjectPath: () => '', getCurrentSteps: () => null,
    getSettings: () => ({ language: 'zh' })
  });
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', runner: async () => '{"toolCall":{"name":"update_settings"}}'
  });
  await assert.rejects(() => engine.chat([{ role: 'user', content: '改设置' }],
    { selectedProject: '', projects: [] }, tools), /Unknown read tool/);
});

test('smart kernel chat does not show a malformed tool request as a reply', async () => {
  const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', runner: async () => '{"toolCall":{}}'
  });
  await assert.rejects(() => engine.chat([{ role: 'user', content: '查当前项目' }],
    { selectedProject: '', projects: [] }, { call: async () => ({}) }), /invalid read tool request/i);
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
