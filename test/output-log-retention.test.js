const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PROJECT_OUTPUT_LOG_RETENTION_MS,
  pruneProjectOutputLogs,
  pruneProjectsOutputLogs
} = require('../out/outputLogRetention.js');

function writeConversation(projectPath, nodeId, conversationId, finishedAt) {
  const runDir = path.join(projectPath, '.solopreneur', 'agent-runs', nodeId, conversationId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'output.log'), `output ${conversationId}`, 'utf8');
  fs.writeFileSync(path.join(runDir, 'finished_at'), finishedAt, 'utf8');
  return path.join(runDir, 'output.log');
}

test('output retention uses each project own activity time instead of a global latest time', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-output-retention-projects-'));
  const projectA = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  const oldA = writeConversation(projectA, '__solo__', '1', '2026-08-01T00:00:00.000Z');
  const boundaryA = writeConversation(projectA, '__solo__', '2', '2026-08-03T00:00:00.000Z');
  writeConversation(projectA, '__solo__', '3', '2026-08-10T00:00:00.000Z');
  const olderButProjectRecentB = writeConversation(projectB, '__solo__', '1', '2026-01-01T00:00:00.000Z');

  const results = pruneProjectsOutputLogs([projectA, projectB]);

  assert.equal(PROJECT_OUTPUT_LOG_RETENTION_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(fs.existsSync(oldA), false);
  assert.equal(fs.existsSync(boundaryA), true);
  assert.equal(fs.existsSync(olderButProjectRecentB), true);
  assert.equal(results.find((result) => result.projectPath === projectA).projectActivityAt, '2026-08-10T00:00:00.000Z');
  assert.equal(results.find((result) => result.projectPath === projectB).projectActivityAt, '2026-01-01T00:00:00.000Z');
});

test('output retention only removes output.log and protects active conversations', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-output-retention-active-'));
  const oldOutput = writeConversation(project, 'step-1', '1', '2026-08-01T00:00:00.000Z');
  const oldRunDir = path.dirname(oldOutput);
  fs.writeFileSync(path.join(oldRunDir, 'prompt.txt'), 'keep prompt', 'utf8');
  const activeOutput = writeConversation(project, 'step-1', '2', '2026-08-02T00:00:00.000Z');
  writeConversation(project, 'step-1', '3', '2026-08-20T00:00:00.000Z');
  const statusDir = path.join(project, '.solopreneur', 'agent-status');
  fs.mkdirSync(statusDir, { recursive: true });
  fs.writeFileSync(path.join(statusDir, '2.json'), JSON.stringify({
    status: 'Running',
    outputFilePath: activeOutput
  }), 'utf8');

  const result = pruneProjectOutputLogs(project);

  assert.equal(fs.existsSync(oldOutput), false);
  assert.equal(fs.existsSync(path.join(oldRunDir, 'prompt.txt')), true);
  assert.equal(fs.existsSync(oldRunDir), true);
  assert.equal(fs.existsSync(activeOutput), true);
  assert.equal(result.deleted, 1);
  assert.equal(result.protectedActive, 1);
});
