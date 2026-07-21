const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const toolPath = path.join(projectRoot, 'resources', 'tools', 'solomap-experience.cjs');

test('experience retrieve returns structured lessons and rejects generic URL matches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-experience-retrieve-'));
  const workspace = path.join(root, 'app');
  const globalRoot = path.join(root, '.solomap-global');
  const digestRoot = path.join(workspace, '.solopreneur', 'run-digests');
  const candidateRoot = path.join(globalRoot, 'learning', 'candidates');
  fs.mkdirSync(digestRoot, { recursive: true });
  fs.mkdirSync(candidateRoot, { recursive: true });
  fs.writeFileSync(path.join(digestRoot, 'solo-1.json'), JSON.stringify({
    schemaVersion: 2,
    runId: 'solo-1',
    executionLogId: 7,
    nodeId: '__solo__',
    runKind: 'solo',
    agentCli: 'codex',
    status: 'Completed',
    finishedAt: '2026-07-21T00:00:00.000Z',
    userIntent: '优化首次提示词的经验账本索引',
    outcome: '首次提示词改为按需检索经验账本。',
    changedFiles: ['src/extension.ts'],
    touchedFiles: ['resources/tools/solomap-experience.cjs'],
    verification: ['node --test test/experience-tool.test.js'],
    failures: [],
    reusableSignals: []
  }));
  fs.writeFileSync(path.join(candidateRoot, 'valuable.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'valuable',
    projectPath: workspace,
    projectName: 'app',
    lessonType: 'implementation_pattern',
    summary: '首次提示词只保留经验账本入口，按具体功能和文件检索高价值结论。',
    appliesWhen: 'Agent 需要历史经验但当前提示词应保持精简时。',
    doThis: '使用 retrieve 查询，并优先读取结构化经验和证据入口。',
    avoidThis: '不要把原始运行记录或无关历史任务注入首次提示词。',
    evidenceRefs: [{ type: 'run_digest', ref: '.solopreneur/run-digests/solo-1.json', summary: 'verified run' }],
    confidence: 'high',
    status: 'candidate',
    updatedAt: '2026-07-21T00:00:00.000Z'
  }));
  fs.writeFileSync(path.join(candidateRoot, 'noise.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'noise',
    projectPath: workspace,
    projectName: 'app',
    lessonType: 'risk_pattern',
    summary: '执行失败模式待复用排障：ERROR: You have hit your usage limit. https://example.com/usage',
    appliesWhen: '任何任务。',
    doThis: '重试。',
    avoidThis: '无。',
    evidenceRefs: [],
    confidence: 'medium',
    status: 'candidate'
  }));

  const result = JSON.parse(childProcess.execFileSync(process.execPath, [
    toolPath,
    'retrieve',
    '--project', workspace,
    '--global', globalRoot,
    '--query', '首次提示词 经验账本索引',
    '--limit', '5',
    '--json'
  ], { encoding: 'utf8' }));

  assert.equal(result.command, 'retrieve');
  assert.equal(result.payload.lessons.length, 1);
  assert.equal(result.payload.lessons[0].id, 'valuable');
  assert.match(result.payload.lessons[0].doThis, /retrieve/);
  assert.equal(result.payload.evidenceLeads.length, 1);
  assert.doesNotMatch(JSON.stringify(result.payload), /usage limit|example\.com/);
});

test('experience retrieve refuses generic URL-only queries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-experience-generic-'));
  const workspace = path.join(root, 'app');
  fs.mkdirSync(workspace, { recursive: true });
  const result = JSON.parse(childProcess.execFileSync(process.execPath, [
    toolPath,
    'retrieve',
    '--project', workspace,
    '--query', 'https://example.com',
    '--json'
  ], { encoding: 'utf8' }));
  assert.deepEqual(result.payload.tokens, []);
  assert.deepEqual(result.payload.lessons, []);
  assert.match(result.payload.message, /具体功能、文件、错误或目标/);
});
