const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const {
  buildConversationPresentations,
  selectLatestConversationRoots
} = require(path.join(projectRoot, 'out/conversationPresentation.js'));
const { normalizeAgentConversationLifecycle } = require(path.join(projectRoot, 'out/conversationLifecycle.js'));
const {
  findCodexSessionIdForRun,
  resolveContinuationRootConversationFromList
} = require(path.join(projectRoot, 'out/continuation.js'));

function writeCodexTranscript(codexHome, workspaceRoot, sessionId, createdAt, conversationId = 'previous') {
  const createdDate = new Date(createdAt);
  const transcriptDir = path.join(
    codexHome,
    'sessions',
    String(createdDate.getUTCFullYear()),
    String(createdDate.getUTCMonth() + 1).padStart(2, '0'),
    String(createdDate.getUTCDate()).padStart(2, '0')
  );
  fs.mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, `rollout-${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({
      timestamp: createdAt,
      type: 'session_meta',
      payload: {
        id: sessionId,
        cwd: workspaceRoot
      }
    }),
    JSON.stringify({
      timestamp: createdAt,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: `Read the complete SoloMap task prompt from ${path.join(workspaceRoot, '.solopreneur', 'agent-runs', '__solo__', String(conversationId), 'prompt.txt')} and follow that file exactly.`
      }
    })
  ].join('\n') + '\n', 'utf8');
}

function writeInteractiveRun(workspaceRoot, codexHome, conversationId) {
  const runDir = path.join(
    workspaceRoot,
    '.solopreneur',
    'agent-runs',
    '__solo__',
    String(conversationId)
  );
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'codex-home.txt'), codexHome, 'utf8');
  fs.writeFileSync(path.join(runDir, 'prompt.txt'), `prompt for conversation ${conversationId}\n`, 'utf8');
  fs.writeFileSync(path.join(runDir, 'output.log'), 'interactive output still open\n', 'utf8');
}

test('independent interactive conversations use their own live Codex sessions and remain separate roots', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-interactive-session-identity-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-interactive-codex-home-'));
  const previousSessionId = '019dc472-6a80-7c70-99a4-b2593a641d11';
  const firstSessionId = '01a05222-a982-7861-8a0a-bec38f8bc21b';
  const secondSessionId = '01a05234-7c73-7101-8993-41560839b585';

  writeCodexTranscript(codexHome, workspaceRoot, previousSessionId, '2026-08-30T09:00:00.000Z');
  writeCodexTranscript(codexHome, workspaceRoot, firstSessionId, '2026-08-30T10:06:41.026Z', 314);
  writeCodexTranscript(codexHome, workspaceRoot, secondSessionId, '2026-08-30T10:26:08.686Z', 315);
  writeInteractiveRun(workspaceRoot, codexHome, 314);
  writeInteractiveRun(workspaceRoot, codexHome, 315);

  const conversations = [
    {
      id: 314,
      nodeId: '__solo__',
      timestamp: '2026-08-30T10:06:37.475Z',
      agentCli: 'codex',
      command: 'codex --no-alt-screen',
      output: [
        'Run started at: 2026-08-30T10:06:37.475Z',
        `Native Agent session saved: ${previousSessionId}`,
        'Interactive session root: 314',
        'Interactive session state: Waiting'
      ].join('\n\n'),
      status: 'Completed'
    },
    {
      id: 315,
      nodeId: '__solo__',
      timestamp: '2026-08-30T10:25:55.569Z',
      agentCli: 'codex',
      command: 'codex --no-alt-screen',
      output: [
        'Run started at: 2026-08-30T10:25:55.569Z',
        `Native Agent session saved: ${previousSessionId}`,
        'Interactive session root: 315',
        'Interactive session state: Waiting'
      ].join('\n\n'),
      status: 'Completed'
    }
  ];

  const presented = buildConversationPresentations(workspaceRoot, '__solo__', conversations);

  assert.deepEqual(
    presented.map((conversation) => conversation.resumableNativeSessionId),
    [firstSessionId, secondSessionId]
  );
  assert.deepEqual(
    selectLatestConversationRoots(presented, 10).map((conversation) => conversation.id),
    [315, 314]
  );
  assert.equal(presented.every((conversation) => conversation.capabilities.canContinue), true);
});

test('a quiet long-running conversation remains running while its authoritative status is running', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-long-running-session-'));
  const statusDir = path.join(workspaceRoot, '.solopreneur', 'agent-status');
  const outputFilePath = path.join(workspaceRoot, '.solopreneur', 'agent-runs', '__solo__', '51', 'output.log');
  const statusFilePath = path.join(statusDir, '51.json');
  fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
  fs.mkdirSync(statusDir, { recursive: true });
  fs.writeFileSync(outputFilePath, 'still working\n', 'utf8');
  fs.writeFileSync(statusFilePath, JSON.stringify({
    nodeId: '__solo__',
    runKind: 'solo',
    status: 'Running',
    executionLogId: 51,
    outputFilePath
  }), 'utf8');
  const oldDate = new Date('2026-08-31T10:00:00.000Z');
  fs.utimesSync(outputFilePath, oldDate, oldDate);
  fs.utimesSync(statusFilePath, oldDate, oldDate);

  const normalized = normalizeAgentConversationLifecycle(workspaceRoot, {
    id: 51,
    nodeId: '__solo__',
    timestamp: '2026-08-31T10:00:00.000Z',
    agentCli: 'codex',
    command: 'codex --no-alt-screen',
    output: 'Interactive session state: Running',
    status: 'Running'
  }, {
    nowMs: Date.parse('2026-08-31T10:30:00.000Z')
  });

  assert.equal(normalized.status, 'Running');
});

test('a continuation whose parent is outside the current page does not merge into an unrelated session root', () => {
  const sharedSessionId = '019dc472-6a80-7c70-99a4-b2593a641d11';
  const conversations = [
    {
      id: 307,
      output: `Native Agent session saved: session.json (${sharedSessionId})`
    },
    {
      id: 312,
      output: [
        'Continuation parent conversation: 304',
        `Continuation session id: ${sharedSessionId}`
      ].join('\n')
    }
  ];

  assert.equal(resolveContinuationRootConversationFromList(conversations, 312)?.id, 312);
});

test('a newly created transcript is found after the same-day run index was already cached', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-live-session-cache-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-live-session-cache-home-'));
  const firstSessionId = '01a05222-a982-7861-8a0a-bec38f8bc21b';
  const secondSessionId = '01a05234-7c73-7101-8993-41560839b585';
  writeInteractiveRun(workspaceRoot, codexHome, 314);
  writeCodexTranscript(codexHome, workspaceRoot, firstSessionId, '2026-08-30T10:06:41.026Z', 314);
  const firstPrompt = path.join(workspaceRoot, '.solopreneur', 'agent-runs', '__solo__', '314', 'prompt.txt');
  assert.equal(
    findCodexSessionIdForRun(codexHome, workspaceRoot, firstPrompt, '2026-08-30T10:06:37.475Z'),
    firstSessionId
  );

  writeInteractiveRun(workspaceRoot, codexHome, 315);
  writeCodexTranscript(codexHome, workspaceRoot, secondSessionId, '2026-08-30T10:26:08.686Z', 315);
  const secondPrompt = path.join(workspaceRoot, '.solopreneur', 'agent-runs', '__solo__', '315', 'prompt.txt');
  assert.equal(
    findCodexSessionIdForRun(codexHome, workspaceRoot, secondPrompt, '2026-08-30T10:25:55.569Z'),
    secondSessionId
  );
});

test('a newly started native conversation recovers its live session before the terminal closes', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-current-native-session-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-current-native-session-home-'));
  const sessionId = '01a05810-ded0-75f1-be1a-fb55d5f8b10f';
  writeInteractiveRun(workspaceRoot, codexHome, 322);
  writeCodexTranscript(codexHome, workspaceRoot, sessionId, '2026-08-31T13:44:55.000Z', 322);

  const [presented] = buildConversationPresentations(workspaceRoot, '__solo__', [{
    id: 322,
    nodeId: '__solo__',
    timestamp: '2026-08-31T13:44:50.669Z',
    agentCli: 'codex',
    command: 'codex --no-alt-screen',
    output: [
      'Run started at: 2026-08-31T13:44:50.668Z',
      'Starting a new native codex session. Previous session available as optional reference: 01a05053-01c1-7df0-8898-23af3ad6208f'
    ].join('\n\n'),
    status: 'Running'
  }]);

  assert.equal(presented.resumableNativeSessionId, sessionId);
});
