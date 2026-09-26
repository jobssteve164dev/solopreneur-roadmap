const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { EmbeddedPiAgentEngine } = require('../out/piAgentEngine.js');
const { buildStrategyPyramidCognitiveInput } = require('../out/strategyPyramid.js');

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

test('embedded Pi Agent judges the strategy pyramid from project facts through the selected model pipe', async () => {
  const invocations = [];
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex',
    model: 'gpt-test',
    configRevision: 'strategy-1',
    runner: async invocation => {
      invocations.push(invocation);
      return JSON.stringify({
        confidence: 'high',
        stageTitle: '市场验证期',
        mainJudgment: '核心产品已经形成交付基础，当前瓶颈是付费验证。',
        strategicAction: '集中验证一个明确付费入口。',
        constraint: '本轮不新增产品线。',
        risks: ['销售证据仍不足。'],
        moves: [{ horizon: '未来 30 天', title: '完成付费验证', reason: '现有 Build 信号已经足够。', evidence: ['SoloMap：2 个已完成环节'] }],
        recommendedScenarioPath: '先验证核心产品收入，再决定是否扩展组合。',
        projects: [{
          id: 'project-1',
          action: '加码付费验证',
          risk: '收入证据不足',
          advice: { doubleDown: '定价和转化', reduce: '新增功能', observe: '真实付费' }
        }]
      });
    }
  });

  const judgment = await engine.judgeStrategyPyramid(buildStrategyPyramidCognitiveInput({
    generatedAt: '2026-09-26T00:00:00.000Z',
    totalProjects: 1, buildCount: 3, sellCount: 0, learnCount: 1, improveCount: 0,
    learningSignals: [],
    projects: [{
      name: 'SoloMap /Users/alice/private', path: '/workspace/solomap', type: 'core_product C:\\Users\\alice\\secret', actualMinutes: 120,
      role: '冻结项目', businessStage: 'sunset', revenueTier: 'stable', timeLoad: 'high', action: '冻结项目，减少维护', abilities: ['CLI 与开发者工具'],
      completedNodes: 2, failedNodes: 0, runningNodes: 0, inProgressNodes: 1, pendingNodes: 1,
      totalNodes: 4, nodes: [{ id: '/home/alice/id', title: '验证付费 /home/alice/secret', stage: '销售与增长', status: 'Pending' }]
    }]
  }));

  assert.equal(judgment.stageTitle, '市场验证期');
  assert.equal(judgment.projects[0].action, '加码付费验证');
  assert.equal(invocations.length, 1);
  assert.match(invocations[0].stdin, /验证付费/);
  assert.match(invocations[0].stdin, /冻结项目/);
  assert.doesNotMatch(invocations[0].stdin, /workspace\/solomap|\/Users\/alice|\/home\/alice|C:\\\\Users/i);
  assert.doesNotMatch(invocations[0].args.join(' '), /验证付费/);
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

test('embedded Pi Agent rejects a strategy judgment that omits a project', async () => {
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex',
    runner: async () => JSON.stringify({
      confidence: 'medium', stageTitle: '验证期', mainJudgment: '需要验证。', strategicAction: '验证。',
      constraint: '不扩张。', risks: [], moves: [{ horizon: '本月', title: '验证', reason: '缺证据', evidence: [] }],
      recommendedScenarioPath: '先验证。', projects: []
    })
  });

  await assert.rejects(() => engine.judgeStrategyPyramid({
    generatedAt: '2026-09-26T00:00:00.000Z',
    totals: { projects: 1, build: 1, sell: 0, learn: 0, improve: 0 },
    projects: [{
      id: 'project-1', name: 'Alpha', type: 'core_product', actualMinutes: 0,
      completedNodes: 0, failedNodes: 0, runningNodes: 0, inProgressNodes: 0, pendingNodes: 1, totalNodes: 1,
      nodes: [], learning: { eventCount: 0, candidateCount: 0, promotedCount: 0, riskSignals: 0, verificationSignals: 0, strategySignals: 0 }
    }]
  }), /invalid strategy pyramid judgment/);
});

test('embedded Pi Agent rejects non-text strategy evidence', async () => {
  const engine = new EmbeddedPiAgentEngine({
    agentCli: 'codex',
    runner: async () => JSON.stringify({
      confidence: 'medium', stageTitle: '验证期', mainJudgment: '需要验证。', strategicAction: '验证。',
      constraint: '不扩张。', risks: [], moves: [{ horizon: '本月', title: '验证', reason: '缺证据', evidence: [null] }],
      recommendedScenarioPath: '先验证。',
      projects: [{ id: 'project-1', action: '验证', risk: '证据不足', advice: { doubleDown: '验证', reduce: '功能', observe: '结果' } }]
    })
  });

  await assert.rejects(() => engine.judgeStrategyPyramid({
    generatedAt: '2026-09-26T00:00:00.000Z', totals: { projects: 1, build: 1, sell: 0, learn: 0, improve: 0 },
    projects: [{
      id: 'project-1', name: 'Alpha', type: 'core_product', actualMinutes: 0,
      completedNodes: 0, failedNodes: 0, runningNodes: 0, inProgressNodes: 0, pendingNodes: 1, totalNodes: 1,
      nodes: [], learning: { eventCount: 0, candidateCount: 0, promotedCount: 0, riskSignals: 0, verificationSignals: 0, strategySignals: 0 }
    }]
  }), /invalid strategy pyramid judgment/);
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
