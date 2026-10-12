'use strict';

// Explicit migration fixture only. Production code must never import this module.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateTaskReport } = require('../../out/taskReport.js');

function writeLearningJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, file);
}

function readLearningJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function learningTasksRoot(workspaceRoot) {
  return path.join(workspaceRoot, '.solopreneur', 'agent-runs', 'learning-tasks');
}

function registerLearningTask(workspaceRoot, input) {
  const root = learningTasksRoot(workspaceRoot);
  fs.mkdirSync(root, { recursive: true });
  const tasks = fs.readdirSync(root).filter(name => name.endsWith('.json')).map(name => readLearningJson(path.join(root, name)));
  const parent = tasks.find(task => task && (task.taskId === input.taskId || (input.parentExecutionLogId && task.executions?.some(run => run.id === input.parentExecutionLogId))));
  const taskId = parent?.taskId || `task-${crypto.randomUUID()}`;
  const executions = [...(parent?.executions || [])].filter(run => run.id !== input.executionLogId);
  executions.push({ id: input.executionLogId, runDir: input.runDir });
  writeLearningJson(path.join(root, `${taskId}.json`), {
    schemaVersion: 1,
    taskId,
    projectPath: workspaceRoot,
    startedAt: parent?.startedAt || input.startedAt,
    userMessage: parent?.userMessage || input.userMessage,
    executions
  });
  return taskId;
}

function recordTaskReport(status, args, sequence) {
  const finish = result => {
    const runDir = path.dirname(status.outputFilePath || status.completionDecisionFilePath);
    writeLearningJson(path.join(runDir, `task-report-status-${sequence}.json`), {
      schemaVersion: 1,
      taskId: status.learningTaskId || '',
      projectPath: status.workspaceRoot,
      executionLogId: status.executionLogId,
      turnId: `${sequence}:complete`,
      createdAt: new Date().toISOString(),
      availability: result.taskReportStatus
    });
    return result;
  };
  if (!args['report-file']) return finish({ taskReportStatus: 'missing', taskReportPath: '', taskReportError: '' });
  try {
    const file = path.resolve(status.workspaceRoot, args['report-file']);
    if (fs.statSync(file).size > 1024 * 1024) throw new Error('report exceeds 1 MiB');
    const report = validateTaskReport(JSON.parse(fs.readFileSync(file, 'utf8')), status.workspaceRoot);
    const runDir = path.dirname(status.outputFilePath || status.completionDecisionFilePath);
    const taskReportPath = path.join(runDir, `task-report-${sequence}.json`);
    writeLearningJson(taskReportPath, {
      schemaVersion: 1,
      taskId: status.learningTaskId || '',
      projectPath: status.workspaceRoot,
      executionLogId: status.executionLogId,
      turnId: `${sequence}:complete`,
      createdAt: new Date().toISOString(),
      outcome: args.outcome || 'partial',
      report
    });
    return finish({ taskReportStatus: 'recorded', taskReportPath, taskReportError: '' });
  } catch (error) {
    return finish({ taskReportStatus: 'invalid', taskReportPath: '', taskReportError: String(error.message || error) });
  }
}

module.exports = { learningTasksRoot, readLearningJson, recordTaskReport, registerLearningTask, writeLearningJson };
