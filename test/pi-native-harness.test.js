const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UnifiedDataStore } = require('../out/db/unifiedDataStore.js');
const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');

test('new MCP capabilities do not invalidate an accepted native operation or expand its frozen tools', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-native-snapshot-'));
  t.after(() => cleanupExact(root));
  const { prepareNativeIntelligenceExecution } = require('../out/piAgentEngine.js');
  const tools = [{ name: 'list_projects', description: 'projects', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }];
  const mcp = { listTools: async () => ({ tools }), callTool: async () => { throw new Error('no tools requested'); } };
  const projectContext = { selectedProject: '', projects: [] };
  const accepted = await prepareNativeIntelligenceExecution(projectContext, mcp);
  tools.push({ name: 'get_today_review', description: 'new-tool-after-acceptance', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } });
  const database = new UnifiedDataStore(root);
  try {
    const owner = database.claimPiExecutionOwner('snapshot-owner');
    const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async invocation => {
      assert.doesNotMatch(invocation.stdin, /new-tool-after-acceptance/);
      return 'Accepted task resumed';
    } });
    const result = await engine.chatNative({ sessionId: 'snapshot-session', lane: 'main', operationId: 'snapshot-operation',
      messages: [{ role: 'user', content: 'Continue the accepted task' }], projectContext,
      systemPrompt: accepted.systemPrompt, toolSnapshot: accepted.toolSnapshot
    }, database.createPiSessionStorage('snapshot-session', owner), mcp);
    assert.equal(result.finalAssistant, 'Accepted task resumed');
    const expanded = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async () => JSON.stringify({
      toolCall: { name: 'get_today_review', arguments: {} }
    }) });
    const denied = await expanded.chatNative({ sessionId: 'snapshot-denied', lane: 'main', operationId: 'snapshot-denied',
      messages: [{ role: 'user', content: 'Try the newly added tool' }], projectContext,
      systemPrompt: accepted.systemPrompt, toolSnapshot: accepted.toolSnapshot
    }, database.createPiSessionStorage('snapshot-denied', owner), mcp);
    assert.equal(denied.status, 'failed');
    for (const catalog of [[], [{ ...tools[0], inputSchema: { type: 'object', properties: { changed: { type: 'string' } } } }]]) {
      await assert.rejects(engine.chatNative({ sessionId: 'snapshot-changed', lane: 'main', operationId: 'snapshot-changed',
        messages: [{ role: 'user', content: 'Continue' }], projectContext,
        systemPrompt: accepted.systemPrompt, toolSnapshot: accepted.toolSnapshot
      }, database.createPiSessionStorage('snapshot-changed', owner), { ...mcp, listTools: async () => ({ tools: catalog }) }), /pi_execution_profile_unsupported/);
    }
  } finally { database.close(); }
});

function cleanupExact(root) {
  if (!fs.existsSync(root)) return;
  const directories = [root], files = [];
  const visit = directory => fs.readdirSync(directory).forEach(name => {
    const target = path.join(directory, name), stat = fs.lstatSync(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) { directories.push(target); visit(target); }
    else files.push(target);
  });
  visit(root); files.forEach(file => fs.unlinkSync(file));
  directories.sort((a, b) => b.length - a.length).forEach(directory => fs.rmdirSync(directory));
}

test('native Pi Harness executes and reopens the same durable operation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-native-'));
  t.after(() => cleanupExact(root));
  let calls = 0;
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async () => { calls += 1; return 'Native durable answer'; } });
  let database = new UnifiedDataStore(root);
  const owner = database.claimPiExecutionOwner('runtime-native');
  const storage = database.createPiSessionStorage('native-session', owner);
  assert.equal(typeof engine.chatNative, 'function');
  const first = await engine.chatNative({
    sessionId: 'native-session', lane: 'main', operationId: 'native-operation',
    messages: [{ role: 'user', content: 'Use the native harness' }],
    projectContext: { selectedProject: '', projects: [] }
  }, storage);
  assert.equal(first.status, 'completed');
  assert.equal(first.finalAssistant, 'Native durable answer');
  assert.equal(calls, 1);
  database.close();

  database = UnifiedDataStore.open(root);
  const reopenedOwner = database.claimPiExecutionOwner('runtime-native');
  const reopened = await engine.chatNative({
    sessionId: 'native-session', lane: 'main', operationId: 'native-operation',
    messages: [{ role: 'user', content: 'Use the native harness' }],
    projectContext: { selectedProject: '', projects: [] }
  }, database.createPiSessionStorage('native-session', reopenedOwner));
  assert.deepEqual(reopened, first);
  assert.equal(calls, 1, 'a terminal operation must never rerun the model');
  database.close();
});

test('native Pi Harness owns model retry and lets the model recover from a tool transport error', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-native-retry-'));
  t.after(() => cleanupExact(root));
  let modelCalls = 0, toolCalls = 0;
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async invocation => {
    modelCalls++;
    if (modelCalls === 1) throw new Error('connection refused by temporary model transport');
    if (modelCalls === 2) return JSON.stringify({ toolCall: { name: 'list_projects', arguments: {} } });
    assert.match(invocation.stdin, /Intelligence tool unavailable/);
    return 'Recovered through the native tool lifecycle';
  } });
  const readTools = {
    async listTools() { return { tools: [{ name: 'list_projects', description: 'projects', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false } }] }; },
    async callTool() { toolCalls++; throw new Error('temporary MCP transport failure'); }
  };
  const database = new UnifiedDataStore(root);
  const owner = database.claimPiExecutionOwner('runtime-native-retry');
  const result = await engine.chatNative({
    sessionId: 'native-retry-session', lane: 'main', operationId: 'native-retry-operation',
    messages: [{ role: 'user', content: 'Recover safely' }], projectContext: { selectedProject: '', projects: [] }
  }, database.createPiSessionStorage('native-retry-session', owner), readTools);
  assert.equal(result.status, 'completed');
  assert.equal(result.finalAssistant, 'Recovered through the native tool lifecycle');
  assert.equal(modelCalls, 3);
  assert.equal(toolCalls, 1);
  database.close();
});

test('native Pi Harness uses the structured Agent CLI turn protocol for tool calls and final answers', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-native-protocol-'));
  t.after(() => cleanupExact(root));
  let modelCalls = 0, toolCalls = 0;
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async invocation => {
    modelCalls++;
    assert.deepEqual(invocation.outputSchema, {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['tool_call', 'final'] },
        call: {
          type: ['object', 'null'],
          properties: {
            name: { type: 'string' },
            argumentsJson: { type: 'string' }
          },
          required: ['name', 'argumentsJson'],
          additionalProperties: false
        },
        content: { type: ['string', 'null'] }
      },
      required: ['kind', 'call', 'content'],
      additionalProperties: false
    }, 'Codex requires a root object without a top-level union');
    if (modelCalls === 1) {
      return JSON.stringify({ kind: 'tool_call', call: { name: 'list_projects', argumentsJson: '{}' }, content: null });
    }
    assert.match(invocation.stdin, /tool:native-protocol-operation:1/);
    assert.match(invocation.stdin, /project-a/);
    return JSON.stringify({ kind: 'final', call: null, content: 'Structured answer' });
  } });
  const readTools = {
    async listTools() { return { tools: [{ name: 'list_projects', description: 'projects', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false } }] }; },
    async callTool() { toolCalls++; return { content: [{ type: 'text', text: 'project-a' }] }; }
  };
  const database = new UnifiedDataStore(root);
  const owner = database.claimPiExecutionOwner('runtime-native-protocol');
  const result = await engine.chatNative({
    sessionId: 'native-protocol-session', lane: 'main', operationId: 'native-protocol-operation',
    messages: [{ role: 'user', content: 'List projects' }], projectContext: { selectedProject: '', projects: [] }
  }, database.createPiSessionStorage('native-protocol-session', owner), readTools);
  assert.equal(result.status, 'completed');
  assert.equal(result.finalAssistant, 'Structured answer');
  assert.equal(modelCalls, 2);
  assert.equal(toolCalls, 1);
  database.close();
});

test('native Pi Harness preserves structured MCP results and resources for the next turn', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-native-result-'));
  t.after(() => cleanupExact(root));
  let modelCalls = 0;
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async invocation => {
    modelCalls++;
    if (modelCalls === 1) return JSON.stringify({ kind: 'tool_call', call: { name: 'list_projects', arguments: {} } });
    assert.match(invocation.stdin, /structuredContent.*projects.*project-a/);
    assert.match(invocation.stdin, /solomap:\/\/project-a/);
    assert.match(invocation.stdin, /project resource body/);
    assert.match(invocation.stdin, /provider warning/);
    return JSON.stringify({ kind: 'final', content: 'Result preserved' });
  } });
  const readTools = {
    async listTools() { return { tools: [{ name: 'list_projects', description: 'projects', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false } }] }; },
    async callTool() {
      return {
        content: [
          { type: 'resource', resource: { uri: 'solomap://project-a', mimeType: 'application/json', text: 'project resource body' } },
          { type: 'text', text: 'provider warning' }
        ],
        structuredContent: { projects: [{ id: 'project-a' }] }
      };
    }
  };
  const database = new UnifiedDataStore(root);
  const owner = database.claimPiExecutionOwner('runtime-native-result');
  const result = await engine.chatNative({
    sessionId: 'native-result-session', lane: 'main', operationId: 'native-result-operation',
    messages: [{ role: 'user', content: 'List projects' }], projectContext: { selectedProject: '', projects: [] }
  }, database.createPiSessionStorage('native-result-session', owner), readTools);
  assert.equal(result.status, 'completed');
  assert.equal(result.finalAssistant, 'Result preserved');
  database.close();
});

test('native Pi Harness preserves an MCP error payload for model recovery', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-native-tool-error-'));
  t.after(() => cleanupExact(root));
  let modelCalls = 0;
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async invocation => {
    modelCalls++;
    if (modelCalls === 1) return JSON.stringify({ kind: 'tool_call', call: { name: 'list_projects', arguments: {} } });
    assert.match(invocation.stdin, /missing required project scope/);
    assert.match(invocation.stdin, /INVALID_ARGUMENT/);
    return JSON.stringify({ kind: 'final', content: 'Explained the tool error' });
  } });
  const readTools = {
    async listTools() { return { tools: [{ name: 'list_projects', description: 'projects', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false } }] }; },
    async callTool() {
      return { isError: true, content: [{ type: 'text', text: 'missing required project scope' }], structuredContent: { code: 'INVALID_ARGUMENT' } };
    }
  };
  const database = new UnifiedDataStore(root);
  const owner = database.claimPiExecutionOwner('runtime-native-tool-error');
  const result = await engine.chatNative({
    sessionId: 'native-tool-error-session', lane: 'main', operationId: 'native-tool-error-operation',
    messages: [{ role: 'user', content: 'List projects' }], projectContext: { selectedProject: '', projects: [] }
  }, database.createPiSessionStorage('native-tool-error-session', owner), readTools);
  assert.equal(result.status, 'completed');
  assert.equal(result.finalAssistant, 'Explained the tool error');
  database.close();
});

test('native Pi Harness repairs one malformed tool envelope before executing anything', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-native-repair-'));
  t.after(() => cleanupExact(root));
  let modelCalls = 0, toolCalls = 0;
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async invocation => {
    modelCalls++;
    if (modelCalls === 1) return 'I will call a tool.\n{"kind":"tool_call","call":{"name":"list_projects","arguments":{}}}';
    if (modelCalls === 2) {
      assert.match(invocation.stdin, /上一轮输出不符合回合协议/);
      assert.equal(toolCalls, 0, 'a malformed envelope must never execute a tool');
      return JSON.stringify({ kind: 'tool_call', call: { name: 'list_projects', arguments: {} } });
    }
    return JSON.stringify({ kind: 'final', content: 'Envelope repaired' });
  } });
  const readTools = {
    async listTools() { return { tools: [{ name: 'list_projects', description: 'projects', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false } }] }; },
    async callTool() { toolCalls++; return { content: [{ type: 'text', text: 'project-a' }] }; }
  };
  const database = new UnifiedDataStore(root);
  const owner = database.claimPiExecutionOwner('runtime-native-repair');
  const result = await engine.chatNative({
    sessionId: 'native-repair-session', lane: 'main', operationId: 'native-repair-operation',
    messages: [{ role: 'user', content: 'List projects' }], projectContext: { selectedProject: '', projects: [] }
  }, database.createPiSessionStorage('native-repair-session', owner), readTools);
  assert.equal(result.status, 'completed');
  assert.equal(result.finalAssistant, 'Envelope repaired');
  assert.equal(modelCalls, 3);
  assert.equal(toolCalls, 1);
  database.close();
});

test('native Pi Harness reports semantic no-progress after three identical tool outcomes without a global call cap', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-native-no-progress-'));
  t.after(() => cleanupExact(root));
  let modelCalls = 0, toolCalls = 0;
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async invocation => {
    modelCalls++;
    if (modelCalls <= 3) return JSON.stringify({ kind: 'tool_call', call: { name: 'list_projects', arguments: { cursor: 'same' } } });
    assert.match(invocation.stdin, /tool_loop_no_progress/);
    return JSON.stringify({ kind: 'final', content: 'Stopped repeating' });
  } });
  const readTools = {
    async listTools() { return { tools: [{ name: 'list_projects', description: 'projects', inputSchema: { type: 'object', properties: { cursor: { type: 'string' } } }, annotations: { readOnlyHint: true, destructiveHint: false } }] }; },
    async callTool() { toolCalls++; return { content: [{ type: 'text', text: 'same-result' }] }; }
  };
  const database = new UnifiedDataStore(root);
  const owner = database.claimPiExecutionOwner('runtime-native-no-progress');
  const result = await engine.chatNative({
    sessionId: 'native-no-progress-session', lane: 'main', operationId: 'native-no-progress-operation',
    messages: [{ role: 'user', content: 'Keep checking until useful' }], projectContext: { selectedProject: '', projects: [] }
  }, database.createPiSessionStorage('native-no-progress-session', owner), readTools);
  assert.equal(result.status, 'completed');
  assert.equal(result.finalAssistant, 'Stopped repeating');
  assert.equal(modelCalls, 4);
  assert.equal(toolCalls, 3);
  database.close();
});

test('native Pi Harness counts repeated MCP errors and resets the streak when an outcome changes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-native-error-loop-'));
  t.after(() => cleanupExact(root));
  let modelCalls = 0, toolCalls = 0;
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async invocation => {
    modelCalls++;
    if (modelCalls <= 5) return JSON.stringify({ kind: 'tool_call', call: { name: 'list_projects', arguments: { cursor: modelCalls === 2 ? 'different' : 'same' } } });
    assert.match(invocation.stdin, /tool_loop_no_progress/);
    return JSON.stringify({ kind: 'final', content: 'Stopped repeated errors' });
  } });
  const readTools = {
    async listTools() { return { tools: [{ name: 'list_projects', description: 'projects', inputSchema: { type: 'object', properties: { cursor: { type: 'string' } } }, annotations: { readOnlyHint: true, destructiveHint: false } }] }; },
    async callTool() { toolCalls++; return { isError: true, content: [{ type: 'text', text: 'same provider error' }] }; }
  };
  const database = new UnifiedDataStore(root);
  const owner = database.claimPiExecutionOwner('runtime-native-error-loop');
  const result = await engine.chatNative({
    sessionId: 'native-error-loop-session', lane: 'main', operationId: 'native-error-loop-operation',
    messages: [{ role: 'user', content: 'Retry if needed' }], projectContext: { selectedProject: '', projects: [] }
  }, database.createPiSessionStorage('native-error-loop-session', owner), readTools);
  assert.equal(result.status, 'completed');
  assert.equal(result.finalAssistant, 'Stopped repeated errors');
  assert.equal(modelCalls, 6);
  assert.equal(toolCalls, 5);
  database.close();
});

test('native Pi Harness ignores host-generated idempotency keys when detecting semantic repetition', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-native-idempotency-loop-'));
  t.after(() => cleanupExact(root));
  let modelCalls = 0, toolCalls = 0;
  const generatedKeys = [];
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async invocation => {
    modelCalls++;
    if (modelCalls <= 3) return JSON.stringify({ kind: 'tool_call', call: { name: 'set_time_schedule', arguments: { schedule: 'tomorrow' } } });
    assert.match(invocation.stdin, /tool_loop_no_progress/);
    return JSON.stringify({ kind: 'final', content: 'Stopped duplicate writes' });
  } });
  const readTools = {
    async listTools() { return { tools: [{ name: 'set_time_schedule', description: 'schedule', inputSchema: { type: 'object', properties: { schedule: { type: 'string' }, idempotencyKey: { type: 'string' } }, required: ['schedule'] }, annotations: { readOnlyHint: false, destructiveHint: false } }] }; },
    async callTool({ arguments: args }) { toolCalls++; generatedKeys.push(args.idempotencyKey); return { content: [{ type: 'text', text: 'scheduled' }] }; }
  };
  const database = new UnifiedDataStore(root);
  const owner = database.claimPiExecutionOwner('runtime-native-idempotency-loop');
  const result = await engine.chatNative({
    sessionId: 'native-idempotency-loop-session', lane: 'main', operationId: 'native-idempotency-loop-operation',
    messages: [{ role: 'user', content: 'Schedule it' }], projectContext: { selectedProject: '', projects: [] }
  }, database.createPiSessionStorage('native-idempotency-loop-session', owner), readTools);
  assert.equal(result.status, 'completed');
  assert.equal(result.finalAssistant, 'Stopped duplicate writes');
  assert.equal(modelCalls, 4);
  assert.equal(toolCalls, 3);
  assert.equal(new Set(generatedKeys).size, 3, 'the host keys should differ while semantic repetition still matches');
  database.close();
});

test('native Pi Harness restores tool IDs and no-progress state after a committed-result acknowledgement loss', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-native-loop-recovery-'));
  t.after(() => cleanupExact(root));
  let modelCalls = 0, toolCalls = 0, persistedResults = 0, injected = false;
  const runner = async invocation => {
    modelCalls++;
    if (modelCalls <= 3) return JSON.stringify({ kind: 'tool_call', call: { name: 'list_projects', arguments: { cursor: 'same' } } });
    assert.match(invocation.stdin, /tool:native-loop-recovery-operation:1/);
    assert.match(invocation.stdin, /tool:native-loop-recovery-operation:2/);
    assert.match(invocation.stdin, /tool:native-loop-recovery-operation:3/);
    assert.match(invocation.stdin, /tool_loop_no_progress/);
    return JSON.stringify({ kind: 'final', content: 'Recovered and stopped' });
  };
  const readTools = {
    async listTools() { return { tools: [{ name: 'list_projects', description: 'projects', inputSchema: { type: 'object', properties: { cursor: { type: 'string' } } }, annotations: { readOnlyHint: true, destructiveHint: false } }] }; },
    async callTool() { toolCalls++; return { content: [{ type: 'text', text: 'same-result' }] }; }
  };
  const database = new UnifiedDataStore(root);
  const owner = database.claimPiExecutionOwner('runtime-native-loop-recovery');
  const baseStorage = database.createPiSessionStorage('native-loop-recovery-session', owner);
  const interruptedStorage = {
    ...baseStorage,
    metadata: baseStorage.metadata,
    async commit(writes, context) {
      const hasToolResult = writes.some(write => write.kind === 'entry' && write.entry.message?.role === 'toolResult');
      const committed = await baseStorage.commit(writes, context);
      if (hasToolResult) persistedResults++;
      if (persistedResults === 2 && !injected) {
        injected = true;
        throw new Error('injected post-commit acknowledgement loss');
      }
      return committed;
    }
  };
  const firstEngine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner });
  await assert.rejects(firstEngine.chatNative({
    sessionId: 'native-loop-recovery-session', lane: 'main', operationId: 'native-loop-recovery-operation',
    messages: [{ role: 'user', content: 'Keep checking' }], projectContext: { selectedProject: '', projects: [] }
  }, interruptedStorage, readTools), /AgentHarness storage or invariant fault/);

  const recoveredEngine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner });
  const result = await recoveredEngine.chatNative({
    sessionId: 'native-loop-recovery-session', lane: 'main', operationId: 'native-loop-recovery-operation',
    messages: [{ role: 'user', content: 'Keep checking' }], projectContext: { selectedProject: '', projects: [] }
  }, database.createPiSessionStorage('native-loop-recovery-session', owner), readTools);
  assert.equal(result.status, 'completed');
  assert.equal(result.finalAssistant, 'Recovered and stopped');
  assert.equal(modelCalls, 4);
  assert.equal(toolCalls, 3);
  const entries = await database.createPiSessionStorage('native-loop-recovery-session', owner).scanEntries({ type: 'message', order: 'asc' });
  const ids = entries.flatMap(entry => entry.message?.role === 'assistant'
    ? entry.message.content.filter(item => item.type === 'toolCall').map(item => item.id)
    : []);
  assert.deepEqual(ids, [
    'tool:native-loop-recovery-operation:1',
    'tool:native-loop-recovery-operation:2',
    'tool:native-loop-recovery-operation:3'
  ]);
  database.close();
});

test('native Pi Harness keeps the no-progress streak across an in-operation compaction boundary', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-native-loop-compaction-'));
  t.after(() => cleanupExact(root));
  const history = [];
  for (let index = 0; index < 70; index++) {
    history.push({ role: 'user', content: `question-${index}-${'u'.repeat(4_000)}` });
    history.push({ role: 'assistant', content: `answer-${index}-${'a'.repeat(4_000)}` });
  }
  let toolTurns = 0, summaryTurns = 0, toolCalls = 0;
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'antigravity', runner: async invocation => {
    if (invocation.stdin.includes('summarization assistant')) {
      summaryTurns++;
      return JSON.stringify({ kind: 'final', content: 'Earlier project discussion was compacted.' });
    }
    toolTurns++;
    if (toolTurns <= 3) return JSON.stringify({ kind: 'tool_call', call: { name: 'list_projects', arguments: { cursor: 'same' } } });
    assert.match(invocation.stdin, /tool_loop_no_progress/);
    return JSON.stringify({ kind: 'final', content: 'Stopped after compaction' });
  } });
  const readTools = {
    async listTools() { return { tools: [{ name: 'list_projects', description: 'projects', inputSchema: { type: 'object', properties: { cursor: { type: 'string' } } }, annotations: { readOnlyHint: true, destructiveHint: false } }] }; },
    async callTool() { toolCalls++; return { content: [{ type: 'text', text: `same-start-${'r'.repeat(49_000)}-same-end` }] }; }
  };
  const database = new UnifiedDataStore(root);
  const owner = database.claimPiExecutionOwner('runtime-native-loop-compaction');
  const result = await engine.chatNative({
    sessionId: 'native-loop-compaction-session', lane: 'main', operationId: 'native-loop-compaction-operation',
    messages: [...history, { role: 'user', content: 'Keep checking' }], projectContext: { selectedProject: '', projects: [] }
  }, database.createPiSessionStorage('native-loop-compaction-session', owner), readTools);
  assert.equal(result.status, 'completed');
  assert.equal(result.finalAssistant, 'Stopped after compaction');
  assert.ok(summaryTurns >= 1, 'the test must cross a real Pi compaction boundary');
  assert.equal(toolCalls, 3);
  database.close();
});

test('native Pi Harness restores pre-compaction outcomes from the complete durable branch', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-pi-native-compacted-recovery-'));
  t.after(() => cleanupExact(root));
  const operationId = 'native-compacted-recovery-operation';
  const database = new UnifiedDataStore(root);
  const owner = database.claimPiExecutionOwner('runtime-native-compacted-recovery');
  const storage = database.createPiSessionStorage('native-compacted-recovery-session', owner);
  const resultContent = [{ type: 'text', text: JSON.stringify({ content: [{ type: 'text', text: 'same-result' }] }, null, 2) }];
  const firstCall = { role: 'assistant', content: [{ type: 'toolCall', id: `tool:${operationId}:1`, name: 'list_projects', arguments: { cursor: 'same' } }], stopReason: 'toolUse', timestamp: 1 };
  const firstResult = { role: 'toolResult', toolCallId: `tool:${operationId}:1`, toolName: 'list_projects', content: resultContent, isError: false, timestamp: 2 };
  const secondCall = { role: 'assistant', content: [{ type: 'toolCall', id: `tool:${operationId}:2`, name: 'list_projects', arguments: { cursor: 'same' } }], stopReason: 'toolUse', timestamp: 3 };
  const secondResult = { role: 'toolResult', toolCallId: `tool:${operationId}:2`, toolName: 'list_projects', content: resultContent, isError: false, timestamp: 4 };
  await storage.commit([
    { kind: 'entry', entry: { id: 'seed-call-1', parentId: null, type: 'message', message: firstCall } },
    { kind: 'entry', entry: { id: 'seed-result-1', parentId: 'seed-call-1', type: 'message', message: firstResult } },
    { kind: 'entry', entry: { id: 'seed-call-2', parentId: 'seed-result-1', type: 'message', message: secondCall } },
    { kind: 'entry', entry: { id: 'seed-result-2', parentId: 'seed-call-2', type: 'message', message: secondResult } },
    { kind: 'entry', entry: { id: 'seed-compaction', parentId: 'seed-result-2', type: 'compaction', summary: 'Earlier tool history compacted.', retainedTail: [secondCall, secondResult], tokensBefore: 40_000, fromHook: false } },
    { kind: 'value', op: 'set', namespace: 'pi.branch.tip', key: 'main', value: 'seed-compaction' }
  ]);
  let modelCalls = 0, toolCalls = 0;
  const engine = new EmbeddedPiAgentEngine({ agentCli: 'codex', runner: async invocation => {
    modelCalls++;
    if (modelCalls === 1) return JSON.stringify({ kind: 'tool_call', call: { name: 'list_projects', arguments: { cursor: 'same' } } });
    assert.match(invocation.stdin, /tool:native-compacted-recovery-operation:3/);
    assert.match(invocation.stdin, /tool_loop_no_progress/);
    return JSON.stringify({ kind: 'final', content: 'Recovered complete branch state' });
  } });
  const readTools = {
    async listTools() { return { tools: [{ name: 'list_projects', description: 'projects', inputSchema: { type: 'object', properties: { cursor: { type: 'string' } } }, annotations: { readOnlyHint: true, destructiveHint: false } }] }; },
    async callTool() { toolCalls++; return { content: [{ type: 'text', text: 'same-result' }] }; }
  };
  const result = await engine.chatNative({
    sessionId: 'native-compacted-recovery-session', lane: 'main', operationId,
    messages: [{ role: 'user', content: 'Keep checking' }], projectContext: { selectedProject: '', projects: [] }
  }, storage, readTools);
  assert.equal(result.status, 'completed');
  assert.equal(result.finalAssistant, 'Recovered complete branch state');
  assert.equal(modelCalls, 2);
  assert.equal(toolCalls, 1);
  database.close();
});
