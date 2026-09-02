const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildInteractiveAgentCommandForPromptFile,
  buildInteractiveAgentContinuationCommandForPromptFile
} = require('../out/agentCli.js');
const {
  ensureTaskCheckpointRuntime
} = require('../out/taskCheckpoint.js');

test('interactive user conversations do not use one-shot CLI modes', () => {
  const workspaceRoot = '/workspace/app';
  const promptFilePath = '/workspace/app/.solopreneur/agent-runs/2/prompt.txt';
  const commands = {
    codex: buildInteractiveAgentCommandForPromptFile('codex', promptFilePath, workspaceRoot),
    cursor: buildInteractiveAgentCommandForPromptFile('cursor-agent', promptFilePath, workspaceRoot),
    agy: buildInteractiveAgentCommandForPromptFile('agy', promptFilePath, workspaceRoot),
    claude: buildInteractiveAgentCommandForPromptFile('claude', promptFilePath, workspaceRoot),
    copilot: buildInteractiveAgentCommandForPromptFile('copilot', promptFilePath, workspaceRoot),
    opencode: buildInteractiveAgentCommandForPromptFile('opencode', promptFilePath, workspaceRoot)
  };

  assert.match(commands.codex, /codex.*--no-alt-screen/);
  assert.doesNotMatch(commands.codex, /\bexec\b/);
  assert.doesNotMatch(commands.cursor, /(?:^|\s)-p(?:\s|$)|--print/);
  assert.match(commands.agy, /--prompt-interactive/);
  assert.doesNotMatch(commands.agy, /(?:^|\s)--print(?:\s|$)/);
  assert.doesNotMatch(commands.claude, /(?:^|\s)-p(?:\s|$)|--print/);
  assert.match(commands.copilot, /(?:^|\s)-i\s/);
  assert.doesNotMatch(commands.copilot, /(?:^|\s)-p(?:\s|$)|--prompt=/);
  assert.match(commands.opencode, /--prompt/);
  assert.doesNotMatch(commands.opencode, /\srun\s/);

  const resumed = buildInteractiveAgentContinuationCommandForPromptFile(
    'codex',
    promptFilePath,
    workspaceRoot,
    'session-123'
  );
  assert.match(resumed, /resume.*session-123/);
  assert.doesNotMatch(resumed, /\bexec\b/);
});

test('caller-assigned interactive providers launch with the exact planned session ID', () => {
  const workspaceRoot = '/workspace/app';
  const promptFilePath = '/workspace/app/.solopreneur/agent-runs/2/prompt.txt';
  const plannedSessionId = '019ecd99-4325-7050-8e71-7def92359c9f';

  const claude = buildInteractiveAgentCommandForPromptFile(
    'claude', promptFilePath, workspaceRoot, 'auto', '', plannedSessionId
  );
  const copilot = buildInteractiveAgentCommandForPromptFile(
    'copilot', promptFilePath, workspaceRoot, 'auto', '', plannedSessionId
  );
  const grok = buildInteractiveAgentCommandForPromptFile(
    'grok', promptFilePath, workspaceRoot, 'auto', '', plannedSessionId
  );

  assert.match(claude, /--session-id '019ecd99-4325-7050-8e71-7def92359c9f'/);
  assert.match(copilot, /--session-id '019ecd99-4325-7050-8e71-7def92359c9f'/);
  assert.match(grok, /--session-id '019ecd99-4325-7050-8e71-7def92359c9f'/);
});

test('checkpoint command scopes writes, records a turn, and captures its workspace delta', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-checkpoint-'));
  const runtimePath = ensureTaskCheckpointRuntime(workspaceRoot);
  const syntax = cp.spawnSync(process.execPath, ['--check', runtimePath], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  const runDir = path.join(workspaceRoot, '.solopreneur', 'agent-runs', 'step-1', '1');
  const statusFilePath = path.join(workspaceRoot, '.solopreneur', 'agent-status', '1.json');
  const snapshotFilePath = path.join(runDir, 'workspace-before.json');
  const changesFilePath = path.join(runDir, 'changes.txt');
  const touchedFilesPath = path.join(runDir, 'touched-files.txt');
  const completionDecisionFilePath = path.join(runDir, 'completion.json');
  fs.mkdirSync(path.dirname(statusFilePath), { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'existing.txt'), 'before\n', 'utf8');
  fs.writeFileSync(snapshotFilePath, JSON.stringify({ 'existing.txt': fs.statSync(path.join(workspaceRoot, 'existing.txt')) }), 'utf8');
  fs.writeFileSync(statusFilePath, JSON.stringify({
    workspaceRoot,
    nodeId: 'step-1',
    runKind: 'step',
    executionLogId: 1,
    rootExecutionLogId: 1,
    interactiveSession: true,
    checkpointToken: 'expected-token',
    checkpointSequence: 1,
    status: 'Waiting',
    workspaceSnapshotPath: snapshotFilePath,
    changesFilePath,
    touchedFilesPath,
    completionDecisionFilePath
  }), 'utf8');

  const env = {
    ...process.env,
    SOLOMAP_TASK_COMMAND: runtimePath,
    SOLOMAP_TASK_STATUS_FILE: statusFilePath,
    SOLOMAP_TASK_CHECKPOINT_TOKEN: 'expected-token',
    CLAUDE_CODE_SESSION_ID: '019ecd99-4325-7050-8e71-7def92359cf0'
  };
  const started = cp.spawnSync(process.execPath, [runtimePath, 'start', '--message', '继续修正'], {
    cwd: workspaceRoot,
    env,
    encoding: 'utf8'
  });
  assert.equal(started.status, 0, started.stderr);
  const startedStatus = JSON.parse(fs.readFileSync(statusFilePath, 'utf8'));
  assert.equal(startedStatus.status, 'Turn Started');
  assert.equal(startedStatus.checkpointMessage, '继续修正');
  assert.equal(startedStatus.providerReportedSessionId, '019ecd99-4325-7050-8e71-7def92359cf0');

  fs.writeFileSync(statusFilePath, JSON.stringify({ ...startedStatus, status: 'Running' }), 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'existing.txt'), 'after and longer\n', 'utf8');
  const completed = cp.spawnSync(process.execPath, [
    runtimePath,
    'complete',
    '--outcome',
    'partial',
    '--summary',
    '完成最小修正',
    '--next',
    '等待下一轮'
  ], { cwd: workspaceRoot, env, encoding: 'utf8' });
  assert.equal(completed.status, 0, completed.stderr);
  const completedStatus = JSON.parse(fs.readFileSync(statusFilePath, 'utf8'));
  assert.equal(completedStatus.status, 'In Progress');
  assert.equal(completedStatus.checkpointOutcome, 'partial');
  assert.equal(completedStatus.checkpointSummary, '完成最小修正');
  assert.match(fs.readFileSync(changesFilePath, 'utf8'), /M existing\.txt/);
  assert.deepEqual(JSON.parse(fs.readFileSync(completionDecisionFilePath, 'utf8')), {
    markCompleted: false,
    reason: '完成最小修正',
    source: 'agent_checkpoint'
  });

  const wrongToken = cp.spawnSync(process.execPath, [runtimePath, 'complete', '--outcome', 'partial', '--summary', '不应写入'], {
    cwd: workspaceRoot,
    env: { ...env, SOLOMAP_TASK_CHECKPOINT_TOKEN: 'wrong-token' },
    encoding: 'utf8'
  });
  assert.notEqual(wrongToken.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(statusFilePath, 'utf8')).checkpointSummary, '完成最小修正');
});

test('completion checkpoint recovers a missing start without overwriting the previous turn identity', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-checkpoint-recovery-'));
  const runtimePath = ensureTaskCheckpointRuntime(workspaceRoot);
  const runDir = path.join(workspaceRoot, '.solopreneur', 'agent-runs', '__solo__', '7');
  const statusFilePath = path.join(workspaceRoot, '.solopreneur', 'agent-status', '7.json');
  const snapshotFilePath = path.join(runDir, 'workspace-before.json');
  const changesFilePath = path.join(runDir, 'changes.txt');
  const touchedFilesPath = path.join(runDir, 'touched-files.txt');
  const completionDecisionFilePath = path.join(runDir, 'completion.json');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.dirname(statusFilePath), { recursive: true });
  fs.writeFileSync(snapshotFilePath, '{}', 'utf8');
  fs.writeFileSync(statusFilePath, JSON.stringify({
    workspaceRoot,
    nodeId: '__solo__',
    runKind: 'solo',
    executionLogId: 9,
    rootExecutionLogId: 7,
    interactiveSession: true,
    checkpointToken: 'recovery-token',
    checkpointSequence: 4,
    status: 'Waiting',
    workspaceSnapshotPath: snapshotFilePath,
    changesFilePath,
    touchedFilesPath,
    completionDecisionFilePath
  }), 'utf8');

  const result = cp.spawnSync(process.execPath, [
    runtimePath,
    'complete',
    '--message',
    '补充审计结果',
    '--outcome',
    'partial',
    '--summary',
    '已完成补充审计'
  ], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      SOLOMAP_TASK_COMMAND: runtimePath,
      SOLOMAP_TASK_STATUS_FILE: statusFilePath,
      SOLOMAP_TASK_CHECKPOINT_TOKEN: 'recovery-token',
      CLAUDE_CODE_SESSION_ID: '019ecd99-4325-7050-8e71-7def92359cf1'
    },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  const completedStatus = JSON.parse(fs.readFileSync(statusFilePath, 'utf8'));
  assert.equal(completedStatus.status, 'In Progress');
  assert.equal(completedStatus.executionLogId, 9, 'the command leaves identity allocation to the plugin consumer');
  assert.equal(completedStatus.checkpointImplicitTurn, true);
  assert.equal(completedStatus.checkpointMessage, '补充审计结果');
  assert.equal(completedStatus.checkpointEventId, '5:complete');
  assert.equal(completedStatus.providerReportedSessionId, '019ecd99-4325-7050-8e71-7def92359cf1');
});
