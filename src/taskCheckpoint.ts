import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const taskCheckpointRuntimeRelativePath = '.solopreneur/runtime/task-checkpoint.cjs';

export type TaskCheckpointOutcome = 'partial' | 'candidate_complete' | 'blocked_user' | 'blocked_external' | 'failed';

export function isInteractiveConversationRunKind(runKind: string): boolean {
  return ['solo', 'step', 'solo_continue', 'step_continue'].includes(String(runKind || ''));
}

export function buildTaskCheckpointInstructions(workspaceRoot: string, isFirstTurn = true): string {
  const commandPath = path.join(workspaceRoot, taskCheckpointRuntimeRelativePath);
  return [
    'SoloMap 任务检查点协议（必须遵守）：',
    `- 检查点命令已由插件生成：${commandPath}`,
    isFirstTurn
      ? '- 当前首轮已经登记为执行中，不要再运行 start。'
      : '- 开始处理当前用户消息前，先登记本轮：node "$SOLOMAP_TASK_COMMAND" start --message "用一句话概括当前用户要求"',
    ...(isFirstTurn ? ['- 从下一条用户消息开始，每轮处理前先运行：node "$SOLOMAP_TASK_COMMAND" start --message "用一句话概括当前用户要求"'] : []),
    '- 在向用户给出本轮最终回答之前，必须且只能选择下面一种结果，并运行一次完成命令：',
    '  - 本轮取得可继续推进的阶段成果：node "$SOLOMAP_TASK_COMMAND" complete --message "当前用户要求" --outcome partial --summary "本轮结果" --next "下一步"',
    '  - 整个路线图环节已达到完成标准：node "$SOLOMAP_TASK_COMMAND" complete --message "当前用户要求" --outcome candidate_complete --summary "完成依据"',
    '  - 需要用户补充信息：node "$SOLOMAP_TASK_COMMAND" complete --message "当前用户要求" --outcome blocked_user --summary "阻塞原因" --next "需要用户提供什么"',
    '  - 被外部条件阻塞：node "$SOLOMAP_TASK_COMMAND" complete --message "当前用户要求" --outcome blocked_external --summary "阻塞原因" --next "恢复条件"',
    '  - 本轮执行失败：node "$SOLOMAP_TASK_COMMAND" complete --message "当前用户要求" --outcome failed --summary "失败原因"',
    '- complete 只结算当前一轮，不会关闭交互会话。命令成功后再输出面向用户的最终回答，并留在当前 CLI 中等待下一条消息。',
    '- candidate_complete 只是提交完成候选；插件仍会按既有完成标准和复核规则决定路线图环节是否完成。',
    '- 不要直接编辑 .agent_status.json、completion.json 或项目账本；只使用上述命令。'
  ].join('\n');
}

function buildTaskCheckpointRuntimeSource(): string {
  return `#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const statusFile = String(process.env.SOLOMAP_TASK_STATUS_FILE || '').trim();
const expectedToken = String(process.env.SOLOMAP_TASK_CHECKPOINT_TOKEN || '');
const action = String(process.argv[2] || '').trim();
const allowedOutcomes = new Set(['partial', 'candidate_complete', 'blocked_user', 'blocked_external', 'failed']);

function fail(message) {
  process.stderr.write('SoloMap checkpoint: ' + message + '\\n');
  process.exit(2);
}

function readArgs() {
  const values = {};
  for (let index = 3; index < process.argv.length; index += 1) {
    const key = process.argv[index];
    if (!key.startsWith('--')) fail('unexpected argument ' + key);
    const value = process.argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail('missing value for ' + key);
    values[key.slice(2)] = value;
    index += 1;
  }
  return values;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

function shouldSkip(rel) {
  if (rel === '.git' || rel.startsWith('.git/')) return true;
  if (rel === 'node_modules' || rel.startsWith('node_modules/')) return true;
  if (rel === '.solopreneur') return false;
  if (rel.startsWith('.solopreneur/')) return rel !== '.solopreneur/roadmap.csv';
  return rel === '.agent_status.json';
}

function shouldSkipFallbackDirectory(rel) {
  const name = rel.split('/').pop();
  return ['out', 'dist', 'build', 'coverage', '.next', '.nuxt', '.cache', '.turbo'].includes(name);
}

function gitFiles(root) {
  const result = cp.spawnSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split('\\0').filter(Boolean) : null;
}

function ignoredFiles(root, files) {
  const candidates = files.filter((rel) => rel !== '.solopreneur/roadmap.csv');
  if (!candidates.length) return new Set();
  const result = cp.spawnSync('git', ['-C', root, 'check-ignore', '--no-index', '-z', '--stdin'], {
    input: candidates.join('\\0') + '\\0',
    encoding: 'utf8'
  });
  return new Set(String(result.stdout || '').split('\\0').filter(Boolean));
}

function snapshotWorkspace(root) {
  const snapshot = {};
  function record(rel) {
    if (shouldSkip(rel)) return;
    const full = path.join(root, rel);
    let stat;
    try { stat = fs.statSync(full); } catch { return; }
    if (stat.isFile()) snapshot[rel] = { size: stat.size, mtimeMs: stat.mtimeMs };
  }
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\\\/g, '/');
      if (shouldSkip(rel)) continue;
      if (entry.isDirectory()) {
        if (!shouldSkipFallbackDirectory(rel)) walk(full);
      } else if (entry.isFile()) {
        record(rel);
      }
    }
  }
  const files = gitFiles(root);
  if (files) {
    const ignored = ignoredFiles(root, files);
    for (const rel of files) if (!ignored.has(rel)) record(rel);
  } else if (fs.existsSync(root)) {
    walk(root);
  }
  return snapshot;
}

function writeWorkspaceDiff(status) {
  let before = {};
  try { before = JSON.parse(fs.readFileSync(status.workspaceSnapshotPath, 'utf8')) || {}; } catch {}
  const after = snapshotWorkspace(status.workspaceRoot);
  const changes = [];
  for (const [rel, meta] of Object.entries(after)) {
    const previous = before[rel];
    if (!previous) changes.push('A ' + rel);
    else if (previous.size !== meta.size || Math.round(previous.mtimeMs) !== Math.round(meta.mtimeMs)) changes.push('M ' + rel);
  }
  for (const rel of Object.keys(before)) if (!after[rel]) changes.push('D ' + rel);
  changes.sort((left, right) => left.localeCompare(right));
  const content = changes.join('\\n');
  for (const output of [status.touchedFilesPath, status.changesFilePath]) {
    if (!output) continue;
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, content, 'utf8');
  }
  return after;
}

if (!statusFile) fail('SOLOMAP_TASK_STATUS_FILE is missing');
if (!expectedToken) fail('SOLOMAP_TASK_CHECKPOINT_TOKEN is missing');
if (!['start', 'complete', 'session-close'].includes(action)) fail('expected start, complete, or session-close');

let status;
try { status = JSON.parse(fs.readFileSync(statusFile, 'utf8')); }
catch { fail('the task status file is unavailable or invalid'); }
if (status.interactiveSession !== true) fail('this run is not an interactive SoloMap conversation');
if (String(status.checkpointToken || '') !== expectedToken) fail('this command does not belong to the active conversation');

const args = readArgs();
const now = new Date().toISOString();
const sequence = Number(status.checkpointSequence || 0) + 1;

if (action === 'start') {
  if (!['Waiting', 'Processed'].includes(String(status.status || ''))) {
    fail('the previous turn has not settled yet');
  }
  if (status.workspaceSnapshotPath) atomicWriteJson(status.workspaceSnapshotPath, snapshotWorkspace(status.workspaceRoot));
  if (status.completionDecisionFilePath) atomicWriteJson(status.completionDecisionFilePath, { markCompleted: false });
  atomicWriteJson(statusFile, {
    ...status,
    status: 'Turn Started',
    checkpointSequence: sequence,
    checkpointEventId: sequence + ':start',
    checkpointMessage: String(args.message || '').trim(),
    checkpointImplicitTurn: false,
    checkpointOutcome: '',
    checkpointSummary: '',
    checkpointNext: '',
    providerReportedSessionId: String(process.env.CLAUDE_CODE_SESSION_ID || '').trim(),
    turnStartedAt: now,
    startedAt: now,
    finishedAt: ''
  });
  process.stdout.write('SoloMap: current turn registered.\\n');
  process.exit(0);
}

if (action === 'complete') {
  const previousStatus = String(status.status || '');
  if (!['Running', 'Waiting', 'Processed', 'Turn Started'].includes(previousStatus)) {
    fail('the previous turn has not settled or this session is already closed');
  }
  const outcome = String(args.outcome || 'partial').trim();
  const summary = String(args.summary || '').trim();
  if (!allowedOutcomes.has(outcome)) fail('unsupported outcome ' + outcome);
  if (!summary) fail('--summary is required');
  const implicitTurn = previousStatus !== 'Running';
  const checkpointMessage = String(args.message || '').trim()
    || (implicitTurn ? '终端内继续对话（Agent 未登记开始检查点）' : String(status.checkpointMessage || status.userMessage || '').trim());
  const snapshot = writeWorkspaceDiff(status);
  if (status.completionDecisionFilePath) {
    atomicWriteJson(status.completionDecisionFilePath, outcome === 'candidate_complete'
      ? { markCompleted: true, reason: summary, source: 'agent_checkpoint' }
      : { markCompleted: false, reason: summary, source: 'agent_checkpoint' });
  }
  if (status.workspaceSnapshotPath) atomicWriteJson(status.workspaceSnapshotPath, snapshot);
  atomicWriteJson(statusFile, {
    ...status,
    status: outcome === 'failed' ? 'Failed' : 'In Progress',
    checkpointSequence: sequence,
    checkpointEventId: sequence + ':complete',
    checkpointImplicitTurn: implicitTurn,
    checkpointMessage,
    checkpointOutcome: outcome,
    checkpointSummary: summary,
    checkpointNext: String(args.next || '').trim(),
    providerReportedSessionId: String(process.env.CLAUDE_CODE_SESSION_ID || '').trim(),
    checkpointAt: now,
    turnStartedAt: implicitTurn ? now : String(status.turnStartedAt || status.startedAt || now),
    startedAt: implicitTurn ? now : String(status.startedAt || status.turnStartedAt || now),
    finishedAt: now,
    ...(outcome === 'failed' ? {
      failureCode: 'agent_reported_failure',
      failureReason: summary
    } : {})
  });
  process.stdout.write('SoloMap: current turn checkpoint recorded.\\n');
  process.exit(0);
}

const previousStatus = String(status.status || '');
if (previousStatus === 'Waiting' || previousStatus === 'Processed') {
  atomicWriteJson(statusFile, {
    ...status,
    status: 'Session Closed',
    checkpointSequence: sequence,
    checkpointEventId: sequence + ':session-close',
    sessionClosePreviousStatus: previousStatus,
    sessionExitCode: Number(args.code || 0),
    finishedAt: now
  });
} else {
  atomicWriteJson(statusFile, {
    ...status,
    status: 'Failed',
    checkpointSequence: sequence,
    checkpointEventId: sequence + ':session-close',
    interactiveSessionClosed: true,
    failureCode: 'checkpoint_missing',
    failureReason: 'The interactive Agent session closed before reporting a turn checkpoint.',
    sessionExitCode: Number(args.code || 0),
    finishedAt: now
  });
}
process.stdout.write('SoloMap: interactive session closed.\\n');
`;
}

export function ensureTaskCheckpointRuntime(workspaceRoot: string): string {
  const runtimePath = path.join(workspaceRoot, taskCheckpointRuntimeRelativePath);
  const source = buildTaskCheckpointRuntimeSource();
  let current = '';
  try { current = fs.readFileSync(runtimePath, 'utf8'); } catch {}
  if (current !== source) {
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
    const temporaryPath = `${runtimePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporaryPath, source, { encoding: 'utf8', mode: 0o755 });
    fs.renameSync(temporaryPath, runtimePath);
    fs.chmodSync(runtimePath, 0o755);
  }
  return runtimePath;
}
