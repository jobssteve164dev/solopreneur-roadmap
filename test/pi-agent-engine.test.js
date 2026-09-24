const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');

test('Pi runtime is bundled for VSIX delivery instead of shipping its full provider dependency tree', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.match(manifest.scripts.compile, /bundle-pi-runtime/);
  assert.equal(manifest.dependencies['@earendil-works/pi-agent-core'], undefined);
  assert.equal(manifest.devDependencies['@earendil-works/pi-agent-core'], '0.87.1');
  assert.ok(fs.existsSync(path.join(projectRoot, 'out', 'piAgentRuntime.mjs')));
});

test('embedded Pi Agent plans through the selected Agent CLI model pipe', async () => {
  const invocations = [];
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex',
    model: 'gpt-test',
    configRevision: 'revision-7',
    runner: async invocation => {
      invocations.push(invocation);
      return '{"candidateId":"candidate-b","reason":"先完成已进入收口阶段的工作。"}';
    }
  });

  const proposal = await engine.plan({
    decisionId: 'decision-1',
    candidates: [
      { id: 'candidate-a', name: 'Alpha', title: 'A', reason: 'A', evidence: [], baselineRank: 1 },
      { id: 'candidate-b', name: 'Beta', title: 'B', reason: 'B', evidence: [], baselineRank: 2 }
    ]
  });

  assert.deepEqual(proposal, {
    candidateId: 'candidate-b',
    reason: '先完成已进入收口阶段的工作。'
  });
  assert.equal(engine.framework, '@earendil-works/pi-agent-core');
  assert.equal(engine.id, 'pi-agent:agent-cli:codex:gpt-test:revision-7');
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].shell, false);
  assert.equal(invocations[0].command, 'codex');
  assert.match(invocations[0].args.join(' '), /--sandbox read-only/);
  assert.match(invocations[0].stdin, /candidate-b/);
  assert.doesNotMatch(invocations[0].args.join(' '), /candidate-b/);
});

test('embedded Pi Agent rejects tool calls from the Agent CLI model pipe', async () => {
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex',
    runner: async () => '{"toolCall":{"name":"read_file"}}'
  });

  await assert.rejects(() => engine.plan({
    decisionId: 'decision-2',
    candidates: [
      { id: 'candidate-a', name: 'Alpha', title: 'A', reason: 'A', evidence: [], baselineRank: 1 }
    ]
  }), /valid JSON decision/);
});

test('embedded Pi Agent creates a file delivery proposal through the selected Agent CLI model pipe', async () => {
  const invocations = [];
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex', model: 'gpt-test', configRevision: 'delivery-1',
    runner: async invocation => {
      invocations.push(invocation);
      return JSON.stringify({
        summary: '补充主路径说明',
        operations: [{ type: 'replace_text', path: 'docs/runtime.md', oldText: '旧内容', newText: '新内容' }]
      });
    }
  });

  const proposal = await engine.proposeDelivery({
    taskId: 'docs-smoke', instruction: '补充主路径说明',
    allowedFiles: [{ path: 'docs/runtime.md', content: '旧内容' }]
  });

  assert.equal(proposal.engineId, 'pi-agent:agent-cli:codex:gpt-test:delivery-1');
  assert.equal(proposal.modelPipe, 'codex');
  assert.deepEqual(proposal.operations, [
    { type: 'replace_text', path: 'docs/runtime.md', oldText: '旧内容', newText: '新内容' }
  ]);
  assert.equal(invocations.length, 1);
  assert.match(invocations[0].stdin, /docs\/runtime\.md/);
});

test('cancelling while Pi loads prevents the Agent CLI allowance pipe from starting', async () => {
  let calls = 0;
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex',
    runner: async () => {
      calls += 1;
      return '{"candidateId":"candidate-a","reason":"should not run"}';
    }
  });
  const pending = engine.plan({
    decisionId: 'decision-cancel',
    candidates: [{ id: 'candidate-a', name: 'Alpha', title: 'A', reason: 'A', evidence: [], baselineRank: 1 }]
  });
  engine.cancel();

  await assert.rejects(pending, /cancelled/i);
  assert.equal(calls, 0);
});
