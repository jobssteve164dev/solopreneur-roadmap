const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const runtime = require('../out/autonomousRuntime.js');
const runtimeHost = require('../out/autonomousRuntimeHost.js');
const cognitiveEngine = require('../out/copilotShadowEngine.js');
const cognitiveConfig = require('../out/cognitiveRuntimeConfig.js');

function createProject(root, name, rows) {
  const projectPath = path.join(root, name);
  const dataPath = path.join(projectPath, '.solopreneur');
  fs.mkdirSync(dataPath, { recursive: true });
  fs.writeFileSync(
    path.join(dataPath, 'roadmap.csv'),
    ['id,title,stage,status,dependencies', ...rows].join('\n') + '\n',
    'utf8'
  );
  return projectPath;
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-autonomous-runtime-'));
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(globalRoot);
  const alpha = createProject(root, 'alpha', ['a1,Ship Alpha,Build,Pending,']);
  const beta = createProject(root, 'beta', ['b1,Recover Beta,Build,Failed,']);
  const hidden = createProject(root, 'hidden', ['h1,Hidden task,Build,Failed,']);
  fs.writeFileSync(path.join(globalRoot, 'projects.json'), JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-09-22T00:00:00.000Z',
    projects: [
      { name: 'Alpha', path: alpha, priority: 'P1' },
      { name: 'Beta', path: beta, priority: 'P2' },
      { name: 'Hidden', path: hidden, priority: 'P0' }
    ],
    hiddenProjects: [hidden]
  }, null, 2));
  return { root, globalRoot, alpha, beta, hidden };
}

function removeFixture(fixture) {
  const runtimeRoot = path.join(fixture.globalRoot, 'runtime');
  const eventsPath = path.join(runtimeRoot, 'events.jsonl');
  const feedbackPath = path.join(runtimeRoot, 'shadow-feedback.jsonl');
  const snapshotPath = path.join(runtimeRoot, 'today-shadow.json');
  const statePath = path.join(runtimeRoot, 'state.json');
  const cognitiveConfigPath = path.join(runtimeRoot, 'cognitive-config.json');
  for (const filePath of [eventsPath, feedbackPath, snapshotPath, statePath, cognitiveConfigPath]) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  if (fs.existsSync(runtimeRoot)) fs.rmdirSync(runtimeRoot);
  fs.unlinkSync(path.join(fixture.globalRoot, 'projects.json'));
  fs.rmdirSync(fixture.globalRoot);
  for (const projectPath of [fixture.alpha, fixture.beta, fixture.hidden]) {
    fs.unlinkSync(path.join(projectPath, '.solopreneur', 'roadmap.csv'));
    fs.rmdirSync(path.join(projectPath, '.solopreneur'));
    fs.rmdirSync(projectPath);
  }
  fs.rmdirSync(fixture.root);
}

test('shadow cycle observes only registered visible projects and recommends the failed project', () => {
  const fixture = createFixture();
  try {
    const decision = runtime.runShadowDecisionCycle({
      globalDataPath: fixture.globalRoot,
      projectRegistryFileName: 'projects.json',
      now: new Date('2026-09-22T08:00:00.000Z')
    });

    assert.equal(decision.status, 'completed');
    assert.equal(decision.projectCount, 2);
    assert.equal(decision.recommendations[0].projectPath, fixture.beta);
    assert.equal(decision.recommendations.some(item => item.projectPath === fixture.hidden), false);
    assert.equal(decision.readOnly, true);
    assert.equal(fs.readFileSync(path.join(fixture.beta, '.solopreneur', 'roadmap.csv'), 'utf8').includes('Failed'), true);
  } finally {
    removeFixture(fixture);
  }
});

test('repeating a shadow cycle for the same facts does not append another decision event', () => {
  const fixture = createFixture();
  try {
    const options = {
      globalDataPath: fixture.globalRoot,
      projectRegistryFileName: 'projects.json',
      now: new Date('2026-09-22T08:00:00.000Z')
    };
    const first = runtime.runShadowDecisionCycle(options);
    const second = runtime.runShadowDecisionCycle({ ...options, now: new Date('2026-09-22T08:05:00.000Z') });
    const events = fs.readFileSync(path.join(fixture.globalRoot, 'runtime', 'events.jsonl'), 'utf8').trim().split('\n');

    assert.equal(second.decisionId, first.decisionId);
    assert.equal(events.length, 1);
  } finally {
    removeFixture(fixture);
  }
});

test('a shadow decision loses display authority when roadmap facts change', () => {
  const fixture = createFixture();
  try {
    runtime.runShadowDecisionCycle({
      globalDataPath: fixture.globalRoot,
      projectRegistryFileName: 'projects.json',
      now: new Date('2026-09-22T08:00:00.000Z')
    });
    const projects = [
      { name: 'Alpha', path: fixture.alpha, priority: 'P1' },
      { name: 'Beta', path: fixture.beta, priority: 'P2' }
    ];
    assert.ok(runtime.readCurrentShadowDecision(fixture.globalRoot, projects));

    fs.appendFileSync(path.join(fixture.alpha, '.solopreneur', 'roadmap.csv'), 'a2,Verify Alpha,Build,Pending,\n');
    assert.equal(runtime.readCurrentShadowDecision(fixture.globalRoot, projects), null);
  } finally {
    removeFixture(fixture);
  }
});

test('shadow feedback records one accepted or overridden outcome per operation', () => {
  const fixture = createFixture();
  try {
    const decision = runtime.runShadowDecisionCycle({
      globalDataPath: fixture.globalRoot,
      projectRegistryFileName: 'projects.json',
      now: new Date('2026-09-22T08:00:00.000Z')
    });
    const input = {
      operationId: 'feedback-1',
      decisionId: decision.decisionId,
      recommendedProjectPath: fixture.beta,
      selectedProjectPath: fixture.alpha,
      outcome: 'overridden',
      recordedAt: '2026-09-22T08:10:00.000Z'
    };
    runtime.recordShadowDecisionFeedback(fixture.globalRoot, input);
    runtime.recordShadowDecisionFeedback(fixture.globalRoot, input);
    const rows = fs.readFileSync(path.join(fixture.globalRoot, 'runtime', 'shadow-feedback.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'overridden');
    assert.equal(rows[0].selectedProjectPath, fixture.alpha);
  } finally {
    removeFixture(fixture);
  }
});

test('runtime lease allows one live owner and reclaims a stopped owner', () => {
  const fixture = createFixture();
  try {
    const first = runtime.claimRuntimeLease(fixture.globalRoot, {
      runtimeId: 'runtime-a',
      pid: process.pid,
      now: new Date('2026-09-22T08:00:00.000Z'),
      isProcessAlive: pid => pid === process.pid
    });
    const competing = runtime.claimRuntimeLease(fixture.globalRoot, {
      runtimeId: 'runtime-b',
      pid: 424242,
      now: new Date('2026-09-22T08:00:10.000Z'),
      isProcessAlive: pid => pid === process.pid
    });
    const reclaimed = runtime.claimRuntimeLease(fixture.globalRoot, {
      runtimeId: 'runtime-c',
      pid: 434343,
      now: new Date('2026-09-22T08:02:00.000Z'),
      isProcessAlive: () => false
    });

    assert.equal(first.acquired, true);
    assert.equal(competing.acquired, false);
    assert.equal(competing.owner.runtimeId, 'runtime-a');
    assert.equal(reclaimed.acquired, true);
    assert.equal(reclaimed.owner.runtimeId, 'runtime-c');
  } finally {
    removeFixture(fixture);
  }
});

test('standalone runtime entry can create a shadow decision without VS Code', () => {
  const fixture = createFixture();
  try {
    const entry = path.resolve(__dirname, '../out/autonomousRuntimeProcess.js');
    const result = childProcess.spawnSync(process.execPath, [entry, '--once', '--global-data-path', fixture.globalRoot], {
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr);
    const decision = JSON.parse(fs.readFileSync(path.join(fixture.globalRoot, 'runtime', 'today-shadow.json'), 'utf8'));
    assert.equal(decision.source, 'runtime_shadow');
    assert.equal(decision.recommendedProjectPath, fixture.beta);
  } finally {
    removeFixture(fixture);
  }
});

test('shadow decision projects into the existing Today arrangement contract', () => {
  const fixture = createFixture();
  try {
    const decision = runtime.runShadowDecisionCycle({
      globalDataPath: fixture.globalRoot,
      projectRegistryFileName: 'projects.json',
      now: new Date('2026-09-22T08:00:00.000Z')
    });
    const review = runtime.projectShadowDecisionForToday(decision);

    assert.equal(review.source, 'runtime_shadow');
    assert.equal(review.status, 'completed');
    assert.equal(review.decisionId, decision.decisionId);
    assert.deepEqual(review.todos.map(item => item.projectPath), decision.recommendations.map(item => item.projectPath));
    assert.equal(review.todos[0].title, 'Recover Beta');
  } finally {
    removeFixture(fixture);
  }
});

test('extension host starts one detached runtime and reuses its live instance', () => {
  const fixture = createFixture();
  try {
    const launches = [];
    const spawnProcess = (command, args, options) => {
      launches.push({ command, args, options });
      return { pid: 31337, unref() {} };
    };
    const first = runtimeHost.ensureAutonomousRuntime({
      extensionPath: '/opt/solomap',
      globalDataPath: fixture.globalRoot,
      execPath: '/usr/bin/node',
      runtimeId: 'host-runtime',
      spawnProcess,
      isProcessAlive: () => false,
      now: new Date('2026-09-22T08:00:00.000Z')
    });
    const second = runtimeHost.ensureAutonomousRuntime({
      extensionPath: '/opt/solomap',
      globalDataPath: fixture.globalRoot,
      execPath: '/usr/bin/node',
      runtimeId: 'other-runtime',
      spawnProcess,
      isProcessAlive: pid => pid === 31337,
      now: new Date('2026-09-22T08:00:10.000Z')
    });

    assert.equal(first.started, true);
    assert.equal(second.started, false);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].command, '/usr/bin/node');
    assert.deepEqual(launches[0].args, [
      '/opt/solomap/out/autonomousRuntimeProcess.js',
      '--global-data-path', fixture.globalRoot,
      '--runtime-id', 'host-runtime'
    ]);
    assert.equal(launches[0].options.detached, true);
    assert.equal(launches[0].options.stdio, 'ignore');
  } finally {
    removeFixture(fixture);
  }
});

test('Today arrangement reads the current Runtime shadow decision', () => {
  const fixture = createFixture();
  const Module = require('node:module');
  const originalLoad = Module._load;
  try {
    runtime.runShadowDecisionCycle({
      globalDataPath: fixture.globalRoot,
      projectRegistryFileName: 'projects.json',
      now: new Date('2026-09-22T08:00:00.000Z')
    });
    Module._load = function(request, parent, isMain) {
      if (request === 'vscode') return { Uri: { joinPath() { return {}; } } };
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../out/dailyReview.js')];
    const { readTodayReview } = require('../out/dailyReview.js');
    const review = readTodayReview(fixture.globalRoot, [
      { name: 'Alpha', path: fixture.alpha, priority: 'P1' },
      { name: 'Beta', path: fixture.beta, priority: 'P2' }
    ]);

    assert.equal(review.source, 'runtime_shadow');
    assert.equal(review.todos[0].projectPath, fixture.beta);
    assert.equal(review.readOnly, true);
  } finally {
    Module._load = originalLoad;
    removeFixture(fixture);
  }
});

test('cognitive shadow engine can reorder opaque candidates without receiving local paths', async () => {
  const fixture = createFixture();
  try {
    let receivedInput = null;
    const decision = await runtime.runCognitiveShadowDecisionCycle({
      globalDataPath: fixture.globalRoot,
      projectRegistryFileName: 'projects.json',
      now: new Date('2026-09-22T08:00:00.000Z'),
      engine: {
        id: 'test-engine',
        async plan(input) {
          receivedInput = input;
          return {
            candidateId: input.candidates.find(candidate => candidate.name === 'Alpha').id,
            reason: 'Alpha 是今天最适合形成完整闭环的项目。'
          };
        }
      }
    });

    assert.equal(JSON.stringify(receivedInput).includes(fixture.root), false);
    assert.equal(decision.baselineProjectPath, fixture.beta);
    assert.equal(decision.recommendedProjectPath, fixture.alpha);
    assert.equal(decision.recommendations[0].projectPath, fixture.alpha);
    assert.equal(decision.recommendations[0].reason, 'Alpha 是今天最适合形成完整闭环的项目。');
    assert.equal(decision.engineId, 'test-engine');
    assert.equal(decision.engineStatus, 'completed');
  } finally {
    removeFixture(fixture);
  }
});

test('a cognitive snapshot loses display authority after the intelligence engine config changes', async () => {
  const fixture = createFixture();
  try {
    const initial = cognitiveConfig.writeCognitiveRuntimeConfig(fixture.globalRoot, {
      mode: 'agent_cli', agentCli: 'codex', model: 'auto'
    });
    await runtime.runCognitiveShadowDecisionCycle({
      globalDataPath: fixture.globalRoot,
      projectRegistryFileName: 'projects.json',
      now: new Date(),
      engineConfigRevision: initial.revision,
      engine: {
        id: `test-engine:${initial.revision}`,
        async plan(input) {
          return { candidateId: input.candidates[0].id, reason: '旧配置生成的结果。' };
        }
      }
    });
    assert.ok(runtime.readCurrentRegisteredShadowDecision(fixture.globalRoot));
    cognitiveConfig.writeCognitiveRuntimeConfig(fixture.globalRoot, {
      mode: 'agent_cli', agentCli: 'claude', model: 'auto'
    });
    assert.equal(runtime.readCurrentRegisteredShadowDecision(fixture.globalRoot), null);
  } finally {
    removeFixture(fixture);
  }
});

test('cognitive shadow result cannot publish after Runtime loses its lease', async () => {
  const fixture = createFixture();
  try {
    await assert.rejects(runtime.runCognitiveShadowDecisionCycle({
      globalDataPath: fixture.globalRoot,
      projectRegistryFileName: 'projects.json',
      now: new Date('2026-09-22T08:00:00.000Z'),
      beforeCommit: () => false,
      engine: {
        id: 'test-engine',
        async plan(input) {
          return { candidateId: input.candidates[0].id, reason: '不应发布的旧结果。' };
        }
      }
    }), /lease/i);
    const snapshot = JSON.parse(fs.readFileSync(path.join(fixture.globalRoot, 'runtime', 'today-shadow.json'), 'utf8'));
    assert.equal(snapshot.engineStatus, undefined);
  } finally {
    removeFixture(fixture);
  }
});

test('Copilot shadow engine exposes no tools and parses only a candidate choice', async () => {
  let invocation = null;
  const engine = new cognitiveEngine.CopilotCliShadowEngine({
    async run(command, args, stdin) {
      invocation = { command, args, stdin };
      return '```json\n{"candidateId":"candidate-b","reason":"先完成可在今天验证的闭环。"}\n```';
    }
  });
  const proposal = await engine.plan({
    decisionId: 'decision',
    candidates: [
      { id: 'candidate-a', name: 'Alpha', title: 'Alpha task', reason: 'A', evidence: ['A1'], baselineRank: 1 },
      { id: 'candidate-b', name: 'Beta', title: 'Beta task', reason: 'B', evidence: ['B1'], baselineRank: 2 }
    ]
  });

  assert.equal(proposal.candidateId, 'candidate-b');
  assert.equal(invocation.command, 'copilot');
  assert.ok(invocation.args.includes('--available-tools'));
  assert.equal(invocation.args.includes('--allow-all-tools'), false);
  assert.equal(invocation.args.includes('--allow-all-paths'), false);
  assert.match(invocation.stdin, /candidate-b/);
});
