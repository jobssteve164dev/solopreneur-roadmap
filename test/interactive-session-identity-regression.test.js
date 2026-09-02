const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
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
  getStoredAgentSession,
  readRunSessionId,
  resolveNativeSessionIdForConversation,
  resolveContinuationRootConversationFromList,
  updateStoredAgentSession
} = require(path.join(projectRoot, 'out/continuation.js'));
const sessionIdentity = require(path.join(projectRoot, 'out/sessionIdentity.js'));
const agentCliUtils = require(path.join(projectRoot, 'out/agentCli.js'));

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

test('transcript-only legacy conversations remain separate roots but are not resumable identities', () => {
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
    [undefined, undefined]
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

test('a version 2 run cannot continue from a planned binding or a stale session ID in conversation output', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-confirmed-session-only-'));
  const runDir = path.join(workspaceRoot, '.solopreneur', 'agent-runs', '__solo__', '91');
  const sessionFilePath = path.join(runDir, 'session.json');
  const plannedSessionId = '019ecd99-4325-7050-8e71-7def92359cd0';
  const staleSessionId = '019ecd99-4325-7050-8e71-7def92359cd1';
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  sessionIdentity.createSessionBinding(sessionFilePath, {
    runId: '91',
    provider: 'codex',
    workspaceRoot,
    cliPath: agentCliUtils.resolveExecutableIdentityPath('codex') || agentCliUtils.resolveExecutablePath('codex') || 'codex',
    bindingNonce: 'confirmed-only-nonce',
    method: 'transcript_correlated_compat',
    contract: 'compatibility',
    providerContext: { codex: { codexHome } }
  });
  sessionIdentity.appendSessionBindingRevision(sessionFilePath, 1, {
    sessionId: plannedSessionId,
    method: 'transcript_correlated_compat',
    contract: 'compatibility',
    state: 'planned',
    providerContext: { codex: { codexHome } }
  });
  const conversation = {
    id: 91,
    nodeId: '__solo__',
    timestamp: '2026-09-02T00:00:00.000Z',
    agentCli: 'codex',
    command: `codex resume ${staleSessionId}`,
    output: `Native Agent session saved: session.json (${staleSessionId})`,
    status: 'Completed'
  };

  assert.equal(readRunSessionId(workspaceRoot, '__solo__', 91), '');
  assert.equal(resolveNativeSessionIdForConversation(workspaceRoot, '__solo__', conversation), '');

  sessionIdentity.confirmSessionBinding(sessionFilePath, 2, plannedSessionId);
  assert.equal(readRunSessionId(workspaceRoot, '__solo__', 91), plannedSessionId);
  assert.equal(resolveNativeSessionIdForConversation(workspaceRoot, '__solo__', conversation), plannedSessionId);
});

test('a damaged declared version 2 binding cannot continue from legacy conversation evidence', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-damaged-session-binding-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-damaged-session-binding-home-'));
  const runDir = path.join(workspaceRoot, '.solopreneur', 'agent-runs', '__solo__', '911');
  const sessionFilePath = path.join(runDir, 'session.json');
  const staleSessionId = '019ecd99-4325-7050-8e71-7def92359cd2';
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(sessionFilePath, '{"version":2,"revisions":', 'utf8');
  fs.writeFileSync(path.join(runDir, 'codex-home.txt'), `${codexHome}\n`, 'utf8');
  writeCodexTranscript(codexHome, workspaceRoot, staleSessionId, '2026-09-02T00:00:01.000Z', '911');

  assert.equal(resolveNativeSessionIdForConversation(workspaceRoot, '__solo__', {
    id: 911,
    nodeId: '__solo__',
    timestamp: '2026-09-02T00:00:00.000Z',
    agentCli: 'codex',
    command: `codex resume ${staleSessionId}`,
    output: `Native Agent session saved: session.json (${staleSessionId})`,
    status: 'Completed'
  }), '');
});

test('legacy output and transcripts cannot create a resumable identity without a saved binding', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-unsaved-legacy-session-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-unsaved-legacy-session-home-'));
  const runDir = path.join(workspaceRoot, '.solopreneur', 'agent-runs', '__solo__', '912');
  const staleSessionId = '019ecd99-4325-7050-8e71-7def92359cd3';
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'codex-home.txt'), `${codexHome}\n`, 'utf8');
  writeCodexTranscript(codexHome, workspaceRoot, staleSessionId, '2026-09-02T00:00:01.000Z', '912');

  assert.equal(resolveNativeSessionIdForConversation(workspaceRoot, '__solo__', {
    id: 912,
    nodeId: '__solo__',
    timestamp: '2026-09-02T00:00:00.000Z',
    agentCli: 'codex',
    command: `codex resume ${staleSessionId}`,
    output: `Native Agent session saved: session.json (${staleSessionId})`,
    status: 'Completed'
  }), '');
});

test('a confirmed binding copied from another run cannot resume the wrong conversation', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-cross-run-binding-'));
  const sourceFilePath = path.join(workspaceRoot, '.solopreneur', 'agent-runs', '__solo__', '913', 'session.json');
  const targetFilePath = path.join(workspaceRoot, '.solopreneur', 'agent-runs', '__solo__', '914', 'session.json');
  const sessionId = '019ecd99-4325-7050-8e71-7def92359cd4';
  sessionIdentity.createSessionBinding(sourceFilePath, {
    runId: '913',
    provider: 'claude',
    workspaceRoot,
    cliPath: agentCliUtils.resolveExecutablePath('claude') || 'claude',
    bindingNonce: 'cross-run-binding-nonce',
    method: 'caller_assigned',
    contract: 'official_stable'
  });
  sessionIdentity.appendSessionBindingRevision(sourceFilePath, 1, {
    sessionId,
    method: 'caller_assigned',
    contract: 'official_stable',
    state: 'planned'
  });
  sessionIdentity.confirmSessionBinding(sourceFilePath, 2, sessionId);
  fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
  fs.copyFileSync(sourceFilePath, targetFilePath);

  assert.equal(resolveNativeSessionIdForConversation(workspaceRoot, '__solo__', {
    id: 914,
    nodeId: '__solo__',
    timestamp: '2026-09-02T00:00:00.000Z',
    agentCli: 'claude',
    command: 'claude --resume',
    output: '',
    status: 'Completed'
  }), '');
});

test('a confirmed Codex binding cannot resume under a different CODEX_HOME', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-codex-home-binding-'));
  const originalCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-codex-home-original-'));
  const differentCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-codex-home-different-'));
  const sessionFilePath = path.join(workspaceRoot, '.solopreneur', 'agent-runs', '__solo__', '915', 'session.json');
  const sessionId = '019ecd99-4325-7050-8e71-7def92359cd5';
  sessionIdentity.createSessionBinding(sessionFilePath, {
    runId: '915',
    provider: 'codex',
    workspaceRoot,
    cliPath: agentCliUtils.resolveExecutablePath('codex') || 'codex',
    bindingNonce: 'codex-home-binding-nonce',
    method: 'transcript_correlated_compat',
    contract: 'compatibility',
    providerContext: { codex: { codexHome: originalCodexHome } }
  });
  sessionIdentity.appendSessionBindingRevision(sessionFilePath, 1, {
    sessionId,
    method: 'transcript_correlated_compat',
    contract: 'compatibility',
    state: 'planned',
    providerContext: { codex: { codexHome: originalCodexHome } }
  });
  sessionIdentity.confirmSessionBinding(sessionFilePath, 2, sessionId);
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = differentCodexHome;
  try {
    assert.equal(resolveNativeSessionIdForConversation(workspaceRoot, '__solo__', {
      id: 915,
      nodeId: '__solo__',
      timestamp: '2026-09-02T00:00:00.000Z',
      agentCli: 'codex',
      command: 'codex resume',
      output: '',
      status: 'Completed'
    }), '');
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});

test('the official Cursor agent alias resumes its confirmed version 2 binding', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-cursor-agent-alias-binding-'));
  const sessionFilePath = path.join(workspaceRoot, '.solopreneur', 'agent-runs', '__solo__', '916', 'session.json');
  const sessionId = '019ecd99-4325-7050-8e71-7def92359cd6';
  sessionIdentity.createSessionBinding(sessionFilePath, {
    runId: '916',
    provider: 'cursor',
    workspaceRoot,
    cliPath: agentCliUtils.resolveExecutableIdentityPath('agent') || agentCliUtils.resolveExecutablePath('agent') || 'agent',
    bindingNonce: 'cursor-agent-alias-binding-nonce',
    method: 'provider_created',
    contract: 'official_stable'
  });
  sessionIdentity.appendSessionBindingRevision(sessionFilePath, 1, {
    sessionId,
    method: 'provider_created',
    contract: 'official_stable',
    state: 'planned'
  });
  sessionIdentity.confirmSessionBinding(sessionFilePath, 2, sessionId);

  assert.equal(resolveNativeSessionIdForConversation(workspaceRoot, '__solo__', {
    id: 916,
    nodeId: '__solo__',
    timestamp: '2026-09-02T00:00:00.000Z',
    agentCli: 'agent',
    command: 'agent --resume',
    output: '',
    status: 'Completed'
  }), sessionId);
});

test('a confirmed binding remains resumable after the CLI at the same path changes version', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-cli-version-binding-'));
  const fakeBinRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-cli-version-bin-'));
  const fakeClaudePath = path.join(fakeBinRoot, 'claude');
  const sessionFilePath = path.join(workspaceRoot, '.solopreneur', 'agent-runs', '__solo__', '917', 'session.json');
  const sessionId = '019ecd99-4325-7050-8e71-7def92359cd7';
  fs.writeFileSync(fakeClaudePath, '#!/usr/bin/env bash\nprintf \'%s\\n\' \'fake-claude 1.0.0\'\n', { encoding: 'utf8', mode: 0o755 });
  sessionIdentity.createSessionBinding(sessionFilePath, {
    runId: '917',
    provider: 'claude',
    workspaceRoot,
    cliPath: fakeClaudePath,
    cliVersion: 'fake-claude 1.0.0',
    bindingNonce: 'cli-version-binding-nonce',
    method: 'caller_assigned',
    contract: 'official_stable'
  });
  sessionIdentity.appendSessionBindingRevision(sessionFilePath, 1, {
    sessionId,
    method: 'caller_assigned',
    contract: 'official_stable',
    state: 'planned'
  });
  sessionIdentity.confirmSessionBinding(sessionFilePath, 2, sessionId);
  fs.writeFileSync(fakeClaudePath, '#!/usr/bin/env bash\nprintf \'%s\\n\' \'fake-claude 2.0.0\'\n', { encoding: 'utf8', mode: 0o755 });

  assert.equal(resolveNativeSessionIdForConversation(workspaceRoot, '__solo__', {
    id: 917,
    nodeId: '__solo__',
    timestamp: '2026-09-02T00:00:00.000Z',
    agentCli: fakeClaudePath,
    command: `${fakeClaudePath} --resume`,
    output: '',
    status: 'Completed'
  }), sessionId);
});

test('the step session index is only a pointer to the still-confirmed run binding', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-session-index-pointer-'));
  const runDir = path.join(workspaceRoot, '.solopreneur', 'agent-runs', '5', '92');
  const sessionFilePath = path.join(runDir, 'session.json');
  const sessionId = '019ecd99-4325-7050-8e71-7def92359ce0';
  sessionIdentity.createSessionBinding(sessionFilePath, {
    runId: '92',
    provider: 'claude',
    workspaceRoot,
    cliPath: agentCliUtils.resolveExecutablePath('claude') || 'claude',
    bindingNonce: 'index-pointer-nonce',
    method: 'caller_assigned',
    contract: 'official_stable'
  });
  sessionIdentity.appendSessionBindingRevision(sessionFilePath, 1, {
    sessionId,
    method: 'caller_assigned',
    contract: 'official_stable',
    state: 'planned'
  });
  sessionIdentity.confirmSessionBinding(sessionFilePath, 2, sessionId);
  updateStoredAgentSession(workspaceRoot, '5', 'claude', sessionId, { runId: '92', revision: 3 });

  const stored = getStoredAgentSession(workspaceRoot, '5', 'claude');
  assert.equal(stored.sessionId, sessionId);
  assert.equal(stored.runId, '92');
  assert.equal(stored.revision, 3);

  sessionIdentity.appendSessionBindingRevision(sessionFilePath, 3, {
    sessionId: '019ecd99-4325-7050-8e71-7def92359ce1',
    supersedesRevision: 3,
    method: 'caller_assigned',
    contract: 'official_stable',
    state: 'conflict',
    errorCode: 'identity_provider_mismatch'
  });
  assert.equal(getStoredAgentSession(workspaceRoot, '5', 'claude'), null);
});

test('an older confirmed run cannot overwrite a newer step session pointer when it closes later', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-step-pointer-order-'));
  const nodeId = '6';
  const sessions = [
    { runId: '100', sessionId: '019ecd99-4325-7050-8e71-7def92359ce2', createdAt: '2026-09-02T00:00:00.000Z' },
    { runId: '101', sessionId: '019ecd99-4325-7050-8e71-7def92359ce3', createdAt: '2026-09-02T00:01:00.000Z' }
  ];
  for (const item of sessions) {
    const sessionFilePath = path.join(workspaceRoot, '.solopreneur', 'agent-runs', nodeId, item.runId, 'session.json');
    sessionIdentity.createSessionBinding(sessionFilePath, {
      runId: item.runId,
      provider: 'claude',
      workspaceRoot,
      cliPath: agentCliUtils.resolveExecutableIdentityPath('claude') || agentCliUtils.resolveExecutablePath('claude') || 'claude',
      bindingNonce: `step-pointer-order-${item.runId}`,
      method: 'caller_assigned',
      contract: 'official_stable',
      createdAt: item.createdAt
    });
    sessionIdentity.appendSessionBindingRevision(sessionFilePath, 1, {
      sessionId: item.sessionId,
      method: 'caller_assigned',
      contract: 'official_stable',
      state: 'planned',
      createdAt: item.createdAt
    });
    sessionIdentity.confirmSessionBinding(sessionFilePath, 2, item.sessionId, item.createdAt);
  }

  updateStoredAgentSession(workspaceRoot, nodeId, 'claude', sessions[1].sessionId, { runId: '101', revision: 3 });
  updateStoredAgentSession(workspaceRoot, nodeId, 'claude', sessions[0].sessionId, { runId: '100', revision: 3 });

  const stored = getStoredAgentSession(workspaceRoot, nodeId, 'claude');
  assert.equal(stored.sessionId, sessions[1].sessionId);
  assert.equal(stored.runId, '101');
});

test('a second extension host rereads the step pointer after acquiring the cross-process lease', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-step-pointer-lease-'));
  const nodeId = '7';
  const sessions = [
    { runId: '200', sessionId: '019ecd99-4325-7050-8e71-7def92359ce4', createdAt: '2026-09-02T00:00:00.000Z' },
    { runId: '201', sessionId: '019ecd99-4325-7050-8e71-7def92359ce5', createdAt: '2026-09-02T00:01:00.000Z' }
  ];
  for (const item of sessions) {
    const sessionFilePath = path.join(workspaceRoot, '.solopreneur', 'agent-runs', nodeId, item.runId, 'session.json');
    sessionIdentity.createSessionBinding(sessionFilePath, {
      runId: item.runId,
      provider: 'claude',
      workspaceRoot,
      cliPath: agentCliUtils.resolveExecutableIdentityPath('claude') || agentCliUtils.resolveExecutablePath('claude') || 'claude',
      bindingNonce: `step-pointer-lease-${item.runId}`,
      method: 'caller_assigned',
      contract: 'official_stable',
      createdAt: item.createdAt
    });
    sessionIdentity.appendSessionBindingRevision(sessionFilePath, 1, {
      sessionId: item.sessionId,
      method: 'caller_assigned',
      contract: 'official_stable',
      state: 'planned',
      createdAt: item.createdAt
    });
    sessionIdentity.confirmSessionBinding(sessionFilePath, 2, item.sessionId, item.createdAt);
  }

  const stepFilePath = path.join(workspaceRoot, '.solopreneur', 'step-sessions', `${nodeId}.json`);
  const leaseFilePath = `${stepFilePath}.lease`;
  fs.mkdirSync(path.dirname(stepFilePath), { recursive: true });
  const leaseFd = fs.openSync(leaseFilePath, 'wx');
  const childScript = [
    "const path = require('node:path');",
    "const continuation = require(path.join(process.argv[1], 'out/continuation.js'));",
    "process.stdout.write('ready\\n');",
    "continuation.updateStoredAgentSession(process.argv[2], process.argv[3], 'claude', process.argv[4], { runId: process.argv[5], revision: 3 });",
    "process.stdout.write('done\\n');"
  ].join('');
  const writer = childProcess.spawn(process.execPath, [
    '-e',
    childScript,
    projectRoot,
    workspaceRoot,
    nodeId,
    sessions[0].sessionId,
    sessions[0].runId
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  writer.stdout.on('data', chunk => { stdout += String(chunk); });
  writer.stderr.on('data', chunk => { stderr += String(chunk); });
  while (!stdout.includes('ready\n') && writer.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await new Promise(resolve => setTimeout(resolve, 100));

  try {
    assert.equal(writer.exitCode, null, `writer bypassed the lease: ${stdout}${stderr}`);
    assert.doesNotMatch(stdout, /done/);
    fs.writeFileSync(stepFilePath, JSON.stringify({
      version: 2,
      nodeId,
      sessions: {
        claude: {
          agentCli: 'claude',
          provider: 'claude',
          sessionId: sessions[1].sessionId,
          runId: sessions[1].runId,
          revision: 3,
          runStartedAt: sessions[1].createdAt,
          updatedAt: sessions[1].createdAt
        }
      }
    }, null, 2), 'utf8');
  } finally {
    fs.closeSync(leaseFd);
    fs.unlinkSync(leaseFilePath);
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`writer did not finish: ${stdout}${stderr}`)), 3000);
    writer.once('exit', code => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Error(`writer failed with ${code}: ${stdout}${stderr}`));
    });
  });
  const stored = getStoredAgentSession(workspaceRoot, nodeId, 'claude');
  assert.equal(stored.sessionId, sessions[1].sessionId);
  assert.equal(stored.runId, sessions[1].runId);
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

test('a newly started native conversation does not expose a transcript-only session identity', () => {
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

  assert.equal(presented.resumableNativeSessionId, undefined);
});
