const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const ledger = require(path.join(projectRoot, 'out', 'learningLedger.js'));
const runDigest = require(path.join(projectRoot, 'out', 'runDigest.js'));
const { readFormalLearningContext } = require('./learning-fixture.js');

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

test('the production learning module has no legacy file ledger producers', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src', 'learningLedger.ts'), 'utf8');
  for (const name of ['ensureLearningLedgerStore', 'appendLearningEvent', 'readLearningSummary', 'buildLearningPromotionContext']) {
    assert.equal(ledger[name], undefined);
    assert.doesNotMatch(source, new RegExp(`export (?:async )?function ${name}\\b`));
  }
  assert.doesNotMatch(source, /writeFile|appendFile|mkdirSync|events\.jsonl|promotion-suggestions/);
})

test('agent dispatch commands and empty verification placeholders are not verification signals', () => {
  const dispatchCommand = "cat '/home/ubuntu/project/app/.solopreneur/agent-runs/__solo__/2/prompt.txt' | codex exec --dangerously-bypass-approvals-and-sandbox -";
  assert.deepEqual(runDigest.extractVerificationSignals('', dispatchCommand, 'Completed'), []);
  assert.deepEqual(runDigest.extractVerificationSignals('', 'npm test', 'Completed'), ['Command: npm test']);
})

test('ordinary prompt construction cannot create a file promotion side channel', () => {
  assert.equal(ledger.buildLearningPromotionContext, undefined);
  assert.equal(ledger.appendLearningEvent, undefined);
})

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

  const prompt = runDigest.formatExecutionExperiencePrompt([{ digest, ref: { objectId: 'fixed-source', revision: 1 } }], {
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

test('legacy learning producer exports remain retired after compilation', () => {
  const compiled = fs.readFileSync(path.join(projectRoot, 'out', 'learningLedger.js'), 'utf8');
  assert.doesNotMatch(compiled, /exports\.(appendLearningEvent|ensureLearningLedgerStore|readLearningSummary|buildLearningPromotionContext)/);
});
