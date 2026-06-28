const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const ledger = require(path.join(projectRoot, 'out', 'learningLedger.js'));
const runDigest = require(path.join(projectRoot, 'out', 'runDigest.js'));

test('isTrashOrLocalPrivate correctly identifies trash and local private candidates', () => {
  // 1. 垃圾占位符
  assert.equal(
    ledger.isTrashOrLocalPrivate({
      summary: 'Run completed without explicit verification signal in captured tail',
      appliesWhen: 'applies',
      doThis: 'do',
      avoidThis: 'avoid'
    }),
    true
  );

  // 2. 正常候选
  assert.equal(
    ledger.isTrashOrLocalPrivate({
      summary: 'Some useful summary',
      appliesWhen: 'applies',
      doThis: 'do',
      avoidThis: 'avoid'
    }),
    false
  );

  // 3. 包含特定私有路径且 promotionTarget 属于全局
  assert.equal(
    ledger.isTrashOrLocalPrivate({
      summary: 'Some global pattern',
      appliesWhen: 'applies',
      doThis: 'do check /home/ubuntu/project/.solopreneur/agent-runs/',
      avoidThis: 'avoid',
      promotionTarget: 'pattern'
    }),
    true
  );

  // 4. 包含特定临时 ID 且 promotionTarget 属于全局
  assert.equal(
    ledger.isTrashOrLocalPrivate({
      summary: 'Some global operating rule',
      appliesWhen: 'applies',
      doThis: 'do check __solo__ temp run',
      avoidThis: 'avoid',
      promotionTarget: 'operating_rule'
    }),
    true
  );
});

test('isArtifactOrTempFile correctly flags build artifacts and temporary files', () => {
  assert.equal(runDigest.isArtifactOrTempFile('out/extension.js.map'), true);
  assert.equal(runDigest.isArtifactOrTempFile('node_modules/lodash/index.js'), true);
  assert.equal(runDigest.isArtifactOrTempFile('.solopreneur/project_journal.db'), true);
  assert.equal(runDigest.isArtifactOrTempFile('src/extension.ts'), false);
});

test('buildLearningRetrievalContext filters out trash, local private data and applies deduplication', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-retrieval-test-'));
  const projectPath = path.join(root, 'app');
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(projectPath, { recursive: true });

  // 写入两个一模一样的有效 event 导致重复候选
  for (let i = 0; i < 2; i++) {
    ledger.appendLearningEvent(projectPath, globalRoot, {
      sourceType: 'user_correction',
      sourceRef: `ref-${i}`,
      eventType: 'corrected',
      summary: 'Same duplicate rule to check',
      evidenceRefs: [{ type: 'user', ref: 'user' }],
      tags: ['test'],
      metadata: {}
    });
  }

  // 写入一个包含垃圾占位符的 event
  ledger.appendLearningEvent(projectPath, globalRoot, {
    sourceType: 'flow_loop',
    sourceRef: 'trash-ref',
    eventType: 'verified',
    summary: 'Junk verification',
    evidenceRefs: [],
    tags: ['test'],
    metadata: {
      verification: ['Run completed without explicit verification signal in captured tail']
    }
  });

  // 写入一个含有特定本地绝对路径的 event，但是其 promotionTarget 是 pattern
  ledger.appendLearningEvent(projectPath, globalRoot, {
    sourceType: 'flow_loop',
    sourceRef: 'private-ref',
    eventType: 'verified',
    summary: 'Private path test',
    evidenceRefs: [],
    tags: ['test'],
    metadata: {
      verification: ['Command: cat /home/ubuntu/project/.solopreneur/agent-runs/__solo__/153/prompt.txt']
    }
  });

  const retrieval = ledger.buildLearningRetrievalContext(projectPath, globalRoot, {
    projectPath,
    runKind: 'solo',
    contextText: 'Duplicate rule check Junk verification /home/ubuntu',
    files: [],
    limit: 10
  });

  // 检查：
  // 1. "Same duplicate rule to check" 去重后应该只出现一次
  const occurrences = (retrieval.match(/Same duplicate rule to check/g) || []).length;
  assert.equal(occurrences, 1);

  // 2. 包含垃圾占位符的 "Run completed without explicit verification signal..." 应该被过滤掉，不能出现在 context 中
  assert.doesNotMatch(retrieval, /without explicit verification signal/);

  // 3. 包含本地绝对路径 /home/ubuntu 的应该被过滤掉
  assert.doesNotMatch(retrieval, /home\/ubuntu/);
});

test('agent dispatch commands and empty verification placeholders do not become learning candidates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-agent-dispatch-learning-'));
  const projectPath = path.join(root, 'app');
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(projectPath, { recursive: true });

  const dispatchCommand = "cat '/home/ubuntu/project/app/.solopreneur/agent-runs/__solo__/2/prompt.txt' | '/usr/local/bin/codex' exec --color always -C '/home/ubuntu/project/app' --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -";
  assert.deepEqual(
    runDigest.extractVerificationSignals('', dispatchCommand, 'Completed'),
    []
  );
  assert.deepEqual(
    runDigest.extractVerificationSignals('', 'npm test', 'Completed'),
    ['Command: npm test']
  );

  const placeholderEvent = ledger.appendLearningEvent(projectPath, globalRoot, {
    sourceType: 'solo',
    sourceRef: 'solo-placeholder',
    eventType: 'verified',
    summary: 'Solo conversation state: Completed',
    evidenceRefs: [{ type: 'run_digest', ref: '.solopreneur/run-digests/__solo__-2.json' }],
    tags: ['solo'],
    metadata: {
      verification: ['Run completed without explicit verification signal in captured tail.'],
      failures: []
    }
  });
  const dispatchEvent = ledger.appendLearningEvent(projectPath, globalRoot, {
    sourceType: 'solo',
    sourceRef: 'solo-dispatch-command',
    eventType: 'verified',
    summary: 'Solo conversation state: Completed',
    evidenceRefs: [{ type: 'command', ref: dispatchCommand }],
    tags: ['solo'],
    metadata: {
      verification: [`Command: ${dispatchCommand}`],
      failures: []
    }
  });

  const candidateDecisionFiles = fs.readdirSync(path.join(globalRoot, 'learning', 'candidate-decisions')).filter((name) => name.endsWith('.json'));
  const decisions = candidateDecisionFiles
    .map((name) => JSON.parse(fs.readFileSync(path.join(globalRoot, 'learning', 'candidate-decisions', name), 'utf8')));
  assert.equal(decisions.find((decision) => decision.eventId === placeholderEvent.id).decision, 'skipped');
  assert.equal(decisions.find((decision) => decision.eventId === dispatchEvent.id).decision, 'skipped');

  const retrieval = ledger.buildLearningRetrievalContext(projectPath, globalRoot, {
    projectPath,
    runKind: 'solo',
    contextText: 'codex agent dispatch verification',
    files: [],
    limit: 5
  });
  const promotionContext = ledger.buildLearningPromotionContext(projectPath, globalRoot);
  const summary = ledger.readLearningSummary(projectPath, globalRoot);

  assert.doesNotMatch(retrieval, /Run completed without explicit verification signal|codex' exec|agent-runs|prompt\.txt/);
  assert.doesNotMatch(promotionContext, /Run completed without explicit verification signal|codex' exec|agent-runs|prompt\.txt/);
  assert.equal(summary.candidateCount, 0);
  assert.equal(summary.projectSignals[0].verificationSignals, 0);
});

test('buildLearningPromotionContext filters suggestions and applies deduplication', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-promotion-test-'));
  const projectPath = path.join(root, 'app');
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(projectPath, { recursive: true });

  // 写入两个一模一样的高置信度 event 以生成晋升建议
  for (let i = 0; i < 2; i++) {
    ledger.appendLearningEvent(projectPath, globalRoot, {
      sourceType: 'user_correction',
      sourceRef: `ref-promo-${i}`,
      eventType: 'corrected',
      summary: 'Duplicate rule to promote',
      evidenceRefs: [{ type: 'user', ref: 'user' }],
      tags: ['test'],
      metadata: {}
    });
  }

  const promotionContext = ledger.buildLearningPromotionContext(projectPath, globalRoot);
  
  // 检查：
  // 1. 去重，"Duplicate rule to promote" 的晋升建议应该只出现一次
  const occurrences = (promotionContext.match(/Duplicate rule to promote/g) || []).length;
  assert.equal(occurrences, 1);
});

test('buildExecutionExperiencePrompt filters compiler artifacts and temp files from file lists and commands', () => {
  const digestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-digest-test-'));
  
  const digest = runDigest.buildRunDigest({
    workspaceRoot: digestRoot,
    nodeId: '3',
    runKind: 'step',
    agentCli: 'codex',
    executionLogId: 100,
    userMessage: 'Test message',
    resolvedCommand: 'npm test',
    status: 'Completed',
    startedAt: '2026-06-02T00:00:00.000Z',
    finishedAt: '2026-06-02T00:01:00.000Z',
    durationMs: 1000,
    changedFilesSummary: 'M out/extension.js.map\nM src/extension.ts\nM node_modules/lodash/index.js',
    touchedFilesSummary: 'M src/extension.ts',
    outputTail: 'Tail',
    completionReason: 'Completed successfully',
    failureCode: '',
    failureReason: '',
    verification: [
      'Run completed without explicit verification signal in captured tail',
      'Command: cat /home/ubuntu/project/.solopreneur/agent-runs/__solo__/153/prompt.txt',
      'Command: npm test'
    ]
  });

  // 1. 验证 buildRunDigest 后的 handoff 已经被过滤净化
  assert.ok(digest.handoff.filesToInspectFirst.includes('src/extension.ts'));
  assert.ok(!digest.handoff.filesToInspectFirst.includes('out/extension.js.map'));
  assert.ok(!digest.handoff.filesToInspectFirst.includes('node_modules/lodash/index.js'));
  
  // commandsToRunNext 不应包含绝对路径的 cat 命令
  assert.ok(digest.handoff.commandsToRunNext.includes('npm test'));
  assert.ok(!digest.handoff.commandsToRunNext.some(cmd => cmd.includes('cat /home/ubuntu')));

  // 2. 写入 digest，再跑 prompt 召回，检查格式化文本
  runDigest.writeRunDigest(digestRoot, digest);

  const prompt = runDigest.buildExecutionExperiencePrompt(digestRoot, {
    nodeId: '3',
    runKind: 'step',
    contextText: 'Test message src/extension.ts',
    supplementFiles: ['src/extension.ts']
  });

  // 检查：
  // 1. 文件列表中不应该有编译产物和 node_modules
  assert.ok(prompt.includes('src/extension.ts'));
  assert.ok(!prompt.includes('extension.js.map'));
  
  // 2. 验证信号中不应有垃圾占位符和绝对路径命令
  assert.ok(prompt.includes('Command: npm test') || prompt.includes('npm test'));
  assert.ok(!prompt.includes('without explicit verification signal'));
  assert.ok(!prompt.includes('cat /home/ubuntu'));
});

test('sanitizeProjectPaths correctly sanitizes local absolute paths and temp directories', () => {
  const ws = '/home/ubuntu/project/solopreneur-roadmap';
  const raw = 'Run command on /home/ubuntu/project/solopreneur-roadmap/src/extension.ts in /home/otheruser/foo and /tmp/run-123 and __solo__/153/prompt.txt';
  const cleaned = ledger.sanitizeProjectPaths(raw, ws);
  
  assert.equal(cleaned.includes('/home/ubuntu/project/solopreneur-roadmap'), false);
  assert.equal(cleaned.includes('<projectRoot>'), true);
  assert.equal(cleaned.includes('<home>'), true);
  assert.equal(cleaned.includes('<tmp>'), true);
  assert.equal(cleaned.includes('<runId>'), true);
});

test('appendLearningEvent filters and rejects pure junk events from ledger index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solopreneur-junk-test-'));
  const projectPath = path.join(root, 'app');
  const globalRoot = path.join(root, '.solomap-global');
  fs.mkdirSync(projectPath, { recursive: true });

  const ret = ledger.appendLearningEvent(projectPath, globalRoot, {
    sourceType: 'solo',
    sourceRef: 'solo-junk',
    eventType: 'verified',
    summary: 'Run completed without explicit verification signal in captured tail',
    evidenceRefs: [],
    tags: [],
    metadata: {}
  });

  assert.equal(ret.id, 'skipped-junk-event');
  
  // 确认 events.jsonl 文件中不包含该 skipped-junk-event
  const eventsPath = path.join(globalRoot, 'learning', 'ledger', 'events.jsonl');
  if (fs.existsSync(eventsPath)) {
    const fileContent = fs.readFileSync(eventsPath, 'utf8');
    assert.equal(fileContent.includes('skipped-junk-event'), false);
  }
});
