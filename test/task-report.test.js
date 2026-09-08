const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ensureTaskCheckpointRuntime } = require('../out/taskCheckpoint.js');

const reportBody = () => ({ schemaVersion: 1, summary: '导出已支持筛选，用户可以只保存需要的内容。', unmetRequirements: [], decisions: [], corrections: [], verification: [], commits: [], experienceUsage: [], lessons: [] });

test('report intake rejects excess prose without truncation or blocking task completion', () => {
  for (const [field, value] of [['summary', '字'.repeat(121)], ['verification', ['字'.repeat(501)]], ['lessons', ['x'.repeat(501)]], ['extra', 'x'.repeat(2000)]]) {
    const f = setup(); const input = path.join(f.root, 'report.json');
    const body = { ...reportBody(), [field]: value };
    fs.writeFileSync(input, JSON.stringify(body));
    const result = f.run('--report-file', input);
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(fs.readFileSync(f.state));
    assert.equal(status.taskReportStatus, 'invalid', field);
    assert.match(status.taskReportError, /character limit/);
    assert.deepEqual(JSON.parse(fs.readFileSync(input)), body, 'retain the input for revision');
    assert.equal(fs.existsSync(path.join(f.runDir, 'task-report-1.json')), false);
  }
});

test('report character budgets count Unicode code points and accept exact boundaries', () => {
  const { validateTaskReport } = require('../out/taskReport.js');
  const body = { ...reportBody(), summary: '𠮷'.repeat(120), verification: ['字'.repeat(380)] };
  assert.equal(validateTaskReport(body).summary, body.summary);
  assert.throws(() => validateTaskReport({ ...body, summary: body.summary + '字' }), /summary.*120/);
  assert.throws(() => validateTaskReport({ ...body, decisions: [{ reason: '字' }] }), /combined character limit 500/);
});

test('evidence annotations and unknown fields cannot bypass the combined prose budget', () => {
  const { validateTaskReport } = require('../out/taskReport.js');
  for (const extra of [
    { commits: [{ repository: 'owner/repo', sha: 'a'.repeat(40), files: ['src/app.js'], note: '字'.repeat(501) }] },
    { outputs: [{ path: 'src/app.js', explanation: '字'.repeat(300) }], artifacts: [{ file: 'src/app.js', note: '字'.repeat(300) }] },
    { extra: '字'.repeat(501) },
    { summary: '字'.repeat(120), verification: ['字'.repeat(380)], outputs: ['这是详细过程说明。'.repeat(40)] },
    { summary: '字'.repeat(120), verification: ['字'.repeat(380)], commits: [{ repository: 'owner/repo', sha: 'a'.repeat(40), files: ['这是详细过程说明。'.repeat(40)] }] }
  ]) assert.throws(() => validateTaskReport({ ...reportBody(), ...extra }), /combined character limit 500/);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-report-files-'));
  const body = { ...reportBody(), commits: [{ repository: 'owner/repo', sha: 'a'.repeat(40), files: Array.from({ length: 30 }, (_, i) => `src/component-${i}.js`) }] };
  fs.mkdirSync(path.join(workspace, 'src'));
  for (const file of body.commits[0].files) fs.writeFileSync(path.join(workspace, file), '');
  assert.deepEqual(validateTaskReport(body, workspace).commits, body.commits, 'keep the complete confirmed file scope');
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-report-'));
  const runtime = ensureTaskCheckpointRuntime(root);
  const runDir = path.join(root, '.solopreneur/agent-runs/__solo__/9');
  fs.mkdirSync(runDir, { recursive: true });
  const state = path.join(runDir, 'state.json');
  fs.writeFileSync(state, JSON.stringify({ workspaceRoot: root, nodeId: '__solo__', runKind: 'solo', rootExecutionLogId: 9, executionLogId: 9, interactiveSession: true, checkpointToken: 'secret', checkpointSequence: 0, status: 'Running', learningTaskId: 'task-123', outputFilePath: path.join(runDir, 'output.log') }));
  const run = (...args) => cp.spawnSync(process.execPath, [runtime, 'complete', '--outcome', 'partial', '--summary', 'done', ...args], { cwd: root, env: { ...process.env, SOLOMAP_TASK_STATUS_FILE: state, SOLOMAP_TASK_CHECKPOINT_TOKEN: 'secret' }, encoding: 'utf8' });
  return { root, runDir, state, run, runtime };
}

test('report file is bound to the current turn and cannot replace task identity', () => {
  const f = setup();
  const input = path.join(f.root, 'report.json');
  fs.writeFileSync(input, JSON.stringify({ schemaVersion: 1, taskId: 'forged', summary: 'fixed', unmetRequirements: [], decisions: [], corrections: [], verification: [], commits: [{ repository: 'owner/repo', sha: 'a'.repeat(40), files: ['app.js'] }], experienceUsage: [], lessons: [] }));
  const result = f.run('--report-file', input);
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(fs.readFileSync(f.state));
  assert.equal(status.taskReportStatus, 'recorded');
  const report = JSON.parse(fs.readFileSync(status.taskReportPath));
  assert.equal(report.taskId, 'task-123');
  assert.equal(report.turnId, '1:complete');
  assert.equal(report.report.commits[0].sha, 'a'.repeat(40));
  assert.equal(report.report.taskId, undefined);
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('invalid or absent reports never prevent completion or manufacture verified facts', () => {
  for (const content of [null, '{', JSON.stringify({ schemaVersion: 1, commits: [{ sha: 'bad' }] })]) {
    const f = setup();
    const input = path.join(f.root, 'report.json');
    if (content !== null) fs.writeFileSync(input, content);
    const result = f.run(...(content === null ? [] : ['--report-file', input]));
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(fs.readFileSync(f.state));
    assert.equal(status.status, 'In Progress');
    assert.equal(status.taskReportStatus, content === null ? 'missing' : 'invalid');
  }
});
