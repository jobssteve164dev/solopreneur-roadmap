const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  applyCognitiveStrategyPyramidJudgment,
  buildStrategyPyramidCognitiveInput,
  buildCognitiveStrategyPyramidSnapshotData,
  createStrategyPyramidRequestGate,
  readCachedStrategyPyramidSnapshot
} = require('../out/strategyPyramid.js');

test('cognitive input uses opaque project ids instead of local paths', () => {
  const input = buildStrategyPyramidCognitiveInput({
    generatedAt: '2026-09-26T00:00:00.000Z', totalProjects: 1, buildCount: 1, sellCount: 0, learnCount: 0, improveCount: 0,
    learningSignals: [],
    projects: [{
      name: 'SoloMap 路径：/Users/alice/private', path: '/private/workspace/solomap', type: '查看[/home/alice/private] C:\\Users\\alice\\secret', actualMinutes: 0,
      role: '冻结项目', businessStage: 'sunset', revenueTier: 'stable', timeLoad: 'high', action: '冻结项目，减少维护', abilities: ['CLI 与开发者工具'],
      completedNodes: 0, failedNodes: 0, runningNodes: 0, inProgressNodes: 0, pendingNodes: 1, totalNodes: 1,
      nodes: [{ id: '/custom/alice/id', title: 'Read \\\\server\\share\\secret.txt', stage: 'C:\\work\\stage', status: '查看[/tmp]' }], progressPercent: 0
    }]
  });

  assert.equal(input.projects[0].id, 'project-1');
  assert.equal('path' in input.projects[0], false);
  assert.deepEqual(input.projects[0].strategy, {
    role: '冻结项目', businessStage: 'sunset', revenueTier: 'stable', timeLoad: 'high',
    action: '冻结项目，减少维护', abilities: ['CLI 与开发者工具']
  });
  assert.doesNotMatch(JSON.stringify(input), /private\/workspace|\/Users\/alice|\/home\/alice|\/custom\/alice|\/tmp|server|C:\\\\Users|C:\\\\work/i);
});

test('cognitive judgment replaces the strategy pyramid decisions while preserving collected facts', () => {
  const snapshot = {
    generatedAt: '2026-09-26T00:00:00.000Z',
    confidence: 'low',
    stageTitle: '规则阶段',
    stageProfile: { title: '规则阶段', priorityLayer: '旧层级', keyMetric: '旧指标', defaultQuestion: '旧问题' },
    mainJudgment: '规则判断',
    strategicAction: '规则动作',
    constraint: '规则约束',
    totalProjects: 1,
    buildCount: 3,
    sellCount: 0,
    learnCount: 1,
    improveCount: 0,
    risks: ['规则风险'],
    loops: [], layers: [], abilities: [], structureSignals: [], riskSignals: [], opportunitySignals: [], learningSignals: [], scenarios: [],
    moves: [{ horizon: '未来 30 天', title: '规则动作', reason: '规则原因', evidence: [] }],
    recommendedScenarioPath: '规则推荐',
    projects: [{
      name: 'SoloMap', path: '/workspace/solomap', type: 'core_product', role: '核心产品', businessStage: 'build',
      revenueTier: 'unknown', timeLoad: 'medium', strategicRelation: '规则关系', loop: 'build', action: '规则项目动作',
      risk: '规则项目风险', evidence: ['2/4 个环节已完成'], abilities: [], roleScores: {},
      advice: { doubleDown: '规则加码', reduce: '规则收缩', observe: '规则观察' },
      completedNodes: 2, failedNodes: 0, runningNodes: 0, inProgressNodes: 1, pendingNodes: 1, totalNodes: 4,
      progressPercent: 50, nodes: []
    }]
  };
  const judgment = {
    confidence: 'high',
    stageTitle: '市场验证期',
    mainJudgment: '交付基础已经形成，当前瓶颈是付费证据。',
    strategicAction: '集中完成一次真实付费验证。',
    constraint: '验证完成前不新增产品线。',
    risks: ['缺少真实收入信号。'],
    moves: [{ horizon: '未来 30 天', title: '验证付费', reason: '建设信号已足够。', evidence: ['SoloMap：2/4 个环节已完成'] }],
    recommendedScenarioPath: '先验证核心产品收入，再决定是否扩展组合。',
    projects: [{
      id: 'project-1', action: '加码付费验证', risk: '收入证据不足',
      advice: { doubleDown: '定价和转化', reduce: '新增功能', observe: '真实付费' }
    }]
  };

  const result = applyCognitiveStrategyPyramidJudgment(snapshot, judgment, {
    engineId: 'pi-agent:agent-cli:codex:gpt-test:strategy-1',
    engineConfigRevision: 'strategy-1'
  });

  assert.equal(result.mainJudgment, judgment.mainJudgment);
  assert.equal(result.strategicAction, judgment.strategicAction);
  assert.equal(result.projects[0].action, '规则项目动作');
  assert.equal(result.projects[0].intelligentAction, '加码付费验证');
  assert.equal(result.projects[0].intelligentRisk, '收入证据不足');
  assert.equal(result.projects[0].intelligentAdvice.doubleDown, '定价和转化');
  assert.equal(result.projects[0].completedNodes, 2);
  assert.equal(result.totalProjects, 1);
  assert.equal(result.decisionSource, 'cognitive');
  assert.equal(result.engineStatus, 'completed');
});

test('strategy pyramid persists and caches the cognitive judgment for the current model configuration', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-strategy-cognitive-'));
  const projectPath = path.join(root, 'project');
  const globalDataPath = path.join(root, '.solomap-global');
  fs.mkdirSync(path.join(projectPath, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(projectPath, '.solopreneur', 'roadmap.csv'), [
    'id,title,stage,status',
    '1,Ship product,产品与 MVP,Completed',
    '2,Verify payment,营销与销售,Pending'
  ].join('\n'));
  const projects = [{ name: 'Project', path: projectPath, type: 'core_product' }];
  const engine = {
    id: 'pi-agent:agent-cli:codex:gpt-test:revision-1',
    async judgeStrategyPyramid(input) {
      assert.equal(input.projects[0].nodes[1].title, 'Verify payment');
      return {
        confidence: 'medium', stageTitle: '市场验证期', mainJudgment: '需要验证付费。',
        strategicAction: '完成一次真实付费。', constraint: '暂不增加产品线。', risks: ['收入证据不足。'],
        moves: [{ horizon: '未来 30 天', title: '验证付费', reason: '产品已交付。', evidence: ['1/2 个环节已完成'] }],
        recommendedScenarioPath: '先验证核心产品收入。',
        projects: [{ id: 'project-1', action: '验证付费', risk: '收入未知', advice: { doubleDown: '转化', reduce: '功能', observe: '付费' } }]
      };
    }
  };

  const snapshot = await buildCognitiveStrategyPyramidSnapshotData(
    projects, globalDataPath, projectPath, engine, 'revision-1'
  );

  assert.equal(snapshot.decisionSource, 'cognitive');
  assert.equal(snapshot.mainJudgment, '需要验证付费。');
  assert.equal(readCachedStrategyPyramidSnapshot(projects, globalDataPath, 'revision-1').mainJudgment, '需要验证付费。');
  assert.equal(readCachedStrategyPyramidSnapshot(projects, globalDataPath, 'revision-2'), null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(globalDataPath, 'strategy', 'pyramid-snapshot.json'))).decisionSource, 'cognitive');
});

test('cognitive judgment never overwrites the user saved project strategy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-strategy-user-marker-'));
  const projectPath = path.join(root, 'project');
  const globalDataPath = path.join(root, '.solomap-global');
  fs.mkdirSync(path.join(projectPath, '.solopreneur'), { recursive: true });
  fs.mkdirSync(path.join(globalDataPath, 'strategy'), { recursive: true });
  fs.writeFileSync(path.join(projectPath, '.solopreneur', 'roadmap.csv'), 'id,title,stage,status\n1,Build,产品与 MVP,Completed\n');
  fs.writeFileSync(path.join(globalDataPath, 'strategy', 'project-strategy.csv'), [
    'projectPath,role,businessStage,revenueTier,timeLoad,strategicAction,abilities,updatedAt',
    `${projectPath},core_product,build,unknown,low,maintain,cli-tools,2026-09-26T00:00:00.000Z`
  ].join('\n'));

  const savedBefore = fs.readFileSync(path.join(globalDataPath, 'strategy', 'project-strategy.csv'), 'utf8');
  await buildCognitiveStrategyPyramidSnapshotData(
    [{ name: 'Project', path: projectPath, type: 'core_product' }], globalDataPath, projectPath,
    {
      id: 'pi-agent:agent-cli:codex:gpt-test:read-only',
      async judgeStrategyPyramid() {
        return {
          confidence: 'medium', stageTitle: '验证期', mainJudgment: '需要验证', strategicAction: '组合动作', constraint: '不扩张', risks: [],
          moves: [{ horizon: '本月', title: '验证', reason: '缺证据', evidence: [] }], recommendedScenarioPath: '先验证',
          projects: [{ id: 'project-1', action: '模型自由文本动作', risk: '模型风险', advice: { doubleDown: '模型加码', reduce: '模型收缩', observe: '模型观察' } }]
        };
      }
    },
    'read-only'
  );

  const saved = fs.readFileSync(path.join(globalDataPath, 'strategy', 'project-strategy.csv'), 'utf8');
  assert.equal(saved, savedBefore);
});

test('strategy pyramid discards a cognitive result when project facts change during judgment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-strategy-race-'));
  const projectPath = path.join(root, 'project');
  const globalDataPath = path.join(root, '.solomap-global');
  const roadmapPath = path.join(projectPath, '.solopreneur', 'roadmap.csv');
  fs.mkdirSync(path.dirname(roadmapPath), { recursive: true });
  fs.writeFileSync(roadmapPath, 'id,title,stage,status\n1,Build,产品与 MVP,Completed\n');
  let calls = 0;
  const snapshot = await buildCognitiveStrategyPyramidSnapshotData(
    [{ name: 'Project', path: projectPath, type: 'core_product' }],
    globalDataPath,
    projectPath,
    {
      id: 'pi-agent:agent-cli:codex:gpt-test:race',
      async judgeStrategyPyramid(input) {
        calls += 1;
        if (calls === 1) fs.appendFileSync(roadmapPath, '2,Sell,营销与销售,Pending\n');
        return {
          confidence: 'medium', stageTitle: '验证期', mainJudgment: `${input.projects[0].totalNodes} 个路线图环节`,
          strategicAction: '验证', constraint: '不扩张', risks: [],
          moves: [{ horizon: '本月', title: '验证', reason: '缺证据', evidence: [] }],
          recommendedScenarioPath: '先验证',
          projects: [{ id: 'project-1', action: '验证', risk: '证据不足', advice: { doubleDown: '验证', reduce: '功能', observe: '结果' } }]
        };
      }
    },
    'race'
  );

  assert.equal(calls, 2);
  assert.equal(snapshot.mainJudgment, '2 个路线图环节');
  assert.equal(snapshot.projects[0].totalNodes, 2);
});

test('strategy pyramid does not commit a judgment after its model configuration becomes stale', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-strategy-config-race-'));
  const projectPath = path.join(root, 'project');
  const globalDataPath = path.join(root, '.solomap-global');
  fs.mkdirSync(path.join(projectPath, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(projectPath, '.solopreneur', 'roadmap.csv'), 'id,title,stage,status\n1,Build,产品与 MVP,Completed\n');
  const projects = [{ name: 'Project', path: projectPath, type: 'core_product' }];

  await assert.rejects(
    buildCognitiveStrategyPyramidSnapshotData(
      projects,
      globalDataPath,
      projectPath,
      {
        id: 'pi-agent:agent-cli:codex:gpt-test:old-revision',
        async judgeStrategyPyramid() {
          return {
            confidence: 'medium', stageTitle: '验证期', mainJudgment: '旧模型判断',
            strategicAction: '验证', constraint: '不扩张', risks: [],
            moves: [{ horizon: '本月', title: '验证', reason: '缺证据', evidence: [] }],
            recommendedScenarioPath: '先验证',
            projects: [{ id: 'project-1', action: '验证', risk: '证据不足', advice: { doubleDown: '验证', reduce: '功能', observe: '结果' } }]
          };
        }
      },
      'old-revision',
      () => false
    ),
    /configuration changed/i
  );

  assert.equal(readCachedStrategyPyramidSnapshot(projects, globalDataPath, 'old-revision'), null);
});

test('only the latest strategy pyramid request may update the visible result', async () => {
  const gate = createStrategyPyramidRequestGate();
  let visible = '';
  let finishOld;
  const oldCurrent = gate.begin();
  const oldRequest = new Promise(resolve => { finishOld = resolve; }).then(value => {
    if (oldCurrent()) visible = value;
  });
  const newCurrent = gate.begin();
  if (newCurrent()) visible = 'new result';
  finishOld('old result');
  await oldRequest;
  assert.equal(visible, 'new result');

  let rejectOld;
  const oldFailureCurrent = gate.begin();
  const oldFailure = new Promise((resolve, reject) => { rejectOld = reject; }).catch(() => {
    if (oldFailureCurrent()) visible = 'old failure';
  });
  const newestCurrent = gate.begin();
  if (newestCurrent()) visible = 'newest result';
  rejectOld(new Error('late failure'));
  await oldFailure;
  assert.equal(visible, 'newest result');
});

test('a superseded strategy pyramid request cannot overwrite the latest cached judgment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-strategy-late-cache-'));
  const projectPath = path.join(root, 'project');
  const globalDataPath = path.join(root, '.solomap-global');
  fs.mkdirSync(path.join(projectPath, '.solopreneur'), { recursive: true });
  fs.writeFileSync(path.join(projectPath, '.solopreneur', 'roadmap.csv'), 'id,title,stage,status\n1,Build,产品与 MVP,Completed\n');
  const projects = [{ name: 'Project', path: projectPath, type: 'core_product' }];
  const judgment = mainJudgment => ({
    confidence: 'medium', stageTitle: '验证期', mainJudgment, strategicAction: '验证', constraint: '不扩张', risks: [],
    moves: [{ horizon: '本月', title: '验证', reason: '缺证据', evidence: [] }], recommendedScenarioPath: '先验证',
    projects: [{ id: 'project-1', action: '验证', risk: '证据不足', advice: { doubleDown: '验证', reduce: '功能', observe: '结果' } }]
  });
  const gate = createStrategyPyramidRequestGate();
  let finishOld;
  const oldResult = new Promise(resolve => { finishOld = resolve; });
  const oldCurrent = gate.begin();
  const oldRequest = buildCognitiveStrategyPyramidSnapshotData(projects, globalDataPath, projectPath, {
    id: 'pi-agent:agent-cli:codex:gpt-test:same-revision',
    async judgeStrategyPyramid() { return oldResult; }
  }, 'same-revision', oldCurrent);

  const newCurrent = gate.begin();
  await buildCognitiveStrategyPyramidSnapshotData(projects, globalDataPath, projectPath, {
    id: 'pi-agent:agent-cli:codex:gpt-test:same-revision',
    async judgeStrategyPyramid() { return judgment('NEW'); }
  }, 'same-revision', newCurrent);
  finishOld(judgment('OLD'));
  await assert.rejects(oldRequest, /configuration changed/i);

  assert.equal(readCachedStrategyPyramidSnapshot(projects, globalDataPath, 'same-revision').mainJudgment, 'NEW');
});

test('cognitive input keeps learning signals for every registered project', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-strategy-learning-'));
  const globalDataPath = path.join(root, '.solomap-global');
  const projects = Array.from({ length: 9 }, (_, index) => {
    const projectPath = path.join(root, `project-${index + 1}`);
    fs.mkdirSync(path.join(projectPath, '.solopreneur'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.solopreneur', 'roadmap.csv'), `id,title,stage,status\n1,Build ${index + 1},产品与 MVP,Completed\n`);
    return { name: `Project ${index + 1}`, path: projectPath, type: 'core_product' };
  });
  const eventsPath = path.join(globalDataPath, 'learning', 'ledger', 'events.jsonl');
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  fs.writeFileSync(eventsPath, projects.map((project, index) => JSON.stringify({
    schemaVersion: 1,
    id: `event-${index + 1}`,
    projectId: `project-id-${index + 1}`,
    projectPath: project.path,
    projectName: project.name,
    sourceType: 'strategy',
    eventType: 'partial',
    summary: `Signal ${index + 1}`,
    createdAt: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    metadata: {}
  })).join('\n') + '\n');
  let receivedInput;

  await buildCognitiveStrategyPyramidSnapshotData(projects, globalDataPath, projects[0].path, {
    id: 'pi-agent:agent-cli:codex:gpt-test:all-learning',
    async judgeStrategyPyramid(input) {
      receivedInput = input;
      return {
        confidence: 'medium', stageTitle: '验证期', mainJudgment: '组合判断', strategicAction: '验证', constraint: '不扩张', risks: [],
        moves: [{ horizon: '本月', title: '验证', reason: '缺证据', evidence: [] }], recommendedScenarioPath: '先验证',
        projects: input.projects.map(project => ({ id: project.id, action: '验证', risk: '证据不足', advice: { doubleDown: '验证', reduce: '功能', observe: '结果' } }))
      };
    }
  }, 'all-learning');

  assert.equal(receivedInput.projects.length, 9);
  assert.deepEqual(receivedInput.projects.map(project => project.learning.eventCount), Array(9).fill(1));
  assert.deepEqual(receivedInput.projects.map(project => project.learning.strategySignals), Array(9).fill(1));
});
