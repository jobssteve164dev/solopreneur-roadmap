const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ensureTaskCheckpointRuntime } = require('../out/taskCheckpoint.js');

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
