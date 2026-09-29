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
