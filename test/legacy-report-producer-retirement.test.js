const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the shipped extension no longer exposes project-file report or checkpoint producers', () => {
  const reports = require('../out/taskReport.js');
  const checkpoints = require('../out/taskCheckpoint.js');

  for (const name of ['writeLearningJson', 'registerLearningTask', 'recordTaskReport']) {
    assert.equal(reports[name], undefined, `${name} must not remain a production write path`);
  }
  for (const name of ['ensureTaskCheckpointRuntime', 'taskCheckpointRuntimeRelativePath']) {
    assert.equal(checkpoints[name], undefined, `${name} must not remain a production write path`);
  }

  const shippedSource = [
    fs.readFileSync(path.resolve(__dirname, '../out/taskReport.js'), 'utf8'),
    fs.readFileSync(path.resolve(__dirname, '../out/taskCheckpoint.js'), 'utf8')
  ].join('\n');
  assert.doesNotMatch(shippedSource, /task-report-status-|task-report-\$\{|\.solopreneur\/runtime\/task-checkpoint\.cjs/);
});
