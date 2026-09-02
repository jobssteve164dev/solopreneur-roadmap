const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

function writeTranscript(codexHome, { sessionId, workspaceRoot, timestamp, messages }) {
  const date = new Date(timestamp);
  const root = path.join(
    codexHome,
    'sessions',
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  );
  fs.mkdirSync(root, { recursive: true });
  const transcriptPath = path.join(root, `rollout-${sessionId}.jsonl`);
  const rows = [
    {
      timestamp,
      type: 'session_meta',
      payload: { id: sessionId, session_id: sessionId, cwd: workspaceRoot, timestamp }
    },
    ...messages.map(({ role, text }) => ({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role,
        content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }]
      }
    }))
  ];
  fs.writeFileSync(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return transcriptPath;
}

test('Codex compatibility locator accepts injected user prelude before the launch nonce', async () => {
  const { locateCodexSessionByBindingNonce } = require(path.join(projectRoot, 'out', 'codexSessionIdentity.js'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-codex-identity-'));
  const workspaceRoot = '/workspace/solomap';
  const bindingNonce = 'f0f1f2f3f4f5f6f7f8f9a0a1a2a3a4a5';
  const sessionId = '019ecd99-4325-7050-8e71-7def92359d00';
  const transcriptPath = writeTranscript(codexHome, {
    sessionId,
    workspaceRoot,
    timestamp: '2026-09-02T00:00:01.000Z',
    messages: [
      { role: 'user', text: '# AGENTS.md instructions' },
      { role: 'user', text: '<environment_context>...</environment_context>' },
      { role: 'user', text: `SoloMap binding nonce: ${bindingNonce}.` }
    ]
  });
  writeTranscript(codexHome, {
    sessionId: '019ecd99-4325-7050-8e71-7def92359d01',
    workspaceRoot,
    timestamp: '2026-09-02T00:00:02.000Z',
    messages: [
      { role: 'user', text: 'another conversation' },
      { role: 'assistant', text: 'The first turn is complete.' },
      { role: 'user', text: `A later turn repeated the nonce: ${bindingNonce}.` }
    ]
  });

  assert.deepEqual(await locateCodexSessionByBindingNonce({
    codexHome,
    workspaceRoot,
    bindingNonce,
    startedAt: '2026-09-02T00:00:00.000Z'
  }), {
    status: 'matched',
    sessionId,
    candidateSessionIds: [sessionId],
    transcriptPath,
    providerCreatedAt: '2026-09-02T00:00:01.000Z'
  });
});

test('Codex compatibility locator reports ambiguity instead of selecting the newest transcript', async () => {
  const { locateCodexSessionByBindingNonce } = require(path.join(projectRoot, 'out', 'codexSessionIdentity.js'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-codex-conflict-'));
  const workspaceRoot = '/workspace/solomap';
  const bindingNonce = 'e0e1e2e3e4e5e6e7e8e9b0b1b2b3b4b5';
  const ids = [
    '019ecd99-4325-7050-8e71-7def92359d10',
    '019ecd99-4325-7050-8e71-7def92359d11'
  ];
  ids.forEach((sessionId, index) => writeTranscript(codexHome, {
    sessionId,
    workspaceRoot,
    timestamp: `2026-09-02T00:00:0${index + 1}.000Z`,
    messages: [{ role: 'user', text: `SoloMap binding nonce: ${bindingNonce}.` }]
  }));

  const result = await locateCodexSessionByBindingNonce({
    codexHome,
    workspaceRoot,
    bindingNonce,
    startedAt: '2026-09-02T00:00:00.000Z'
  });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.sessionId, '');
  assert.deepEqual(result.candidateSessionIds, ids);
  assert.equal(result.transcriptPath, '');
});

test('Codex turn completion reader ignores a completed earlier turn', async () => {
  const { readCodexTurnCompletionSince } = require(path.join(projectRoot, 'out', 'codexSessionIdentity.js'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-codex-turn-complete-'));
  const transcriptPath = writeTranscript(codexHome, {
    sessionId: '019ecd99-4325-7050-8e71-7def92359d12',
    workspaceRoot: '/workspace/solomap',
    timestamp: '2026-09-02T00:40:00.000Z',
    messages: [{ role: 'user', text: 'first turn' }]
  });
  fs.appendFileSync(transcriptPath, [
    JSON.stringify({
      timestamp: '2026-09-02T00:40:10.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: '019ecd99-4325-7050-8e71-7def92359d91',
        last_agent_message: 'first answer',
        started_at: 1788309601,
        completed_at: 1788309610
      }
    }),
    JSON.stringify({
      timestamp: '2026-09-02T00:41:10.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: '019ecd99-4325-7050-8e71-7def92359d92',
        last_agent_message: 'second answer',
        started_at: 1788309661,
        completed_at: 1788309670
      }
    })
  ].join('\n') + '\n', 'utf8');

  const firstTurn = await readCodexTurnCompletionSince(transcriptPath, '2026-09-02T00:39:59.000Z', 0);
  assert.equal(firstTurn.completion.turnId, '019ecd99-4325-7050-8e71-7def92359d91');
  const result = await readCodexTurnCompletionSince(
    transcriptPath,
    '2026-09-02T00:40:30.000Z',
    firstTurn.nextOffset
  );
  assert.deepEqual(result.completion, {
    turnId: '019ecd99-4325-7050-8e71-7def92359d92',
    lastAgentMessage: 'second answer',
    completedAt: '2026-09-02T00:41:10.000Z'
  });
  assert.ok(result.nextOffset > firstTurn.nextOffset);
});

test('Codex turn completion reader recovers when the transcript was truncated below its cursor', async () => {
  const { readCodexTurnCompletionSince } = require(path.join(projectRoot, 'out', 'codexSessionIdentity.js'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-codex-turn-truncated-'));
  const transcriptPath = writeTranscript(codexHome, {
    sessionId: '019ecd99-4325-7050-8e71-7def92359d14',
    workspaceRoot: '/workspace/solomap',
    timestamp: '2026-09-02T01:00:00.000Z',
    messages: [{ role: 'user', text: 'old turn content that established a larger cursor' }]
  });
  const staleCursor = fs.statSync(transcriptPath).size + 1024;
  fs.writeFileSync(transcriptPath, `${JSON.stringify({
    timestamp: '2026-09-02T01:01:02.000Z',
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: '019ecd99-4325-7050-8e71-7def92359d95',
      last_agent_message: 'answer after transcript rotation',
      started_at: 1788310861,
      completed_at: 1788310862
    }
  })}\n`, 'utf8');

  const result = await readCodexTurnCompletionSince(
    transcriptPath,
    '2026-09-02T01:01:00.000Z',
    staleCursor
  );
  assert.equal(result.completion.turnId, '019ecd99-4325-7050-8e71-7def92359d95');
  assert.equal(result.nextOffset, fs.statSync(transcriptPath).size);
});

test('Codex compatibility locator streams only through the launch prelude', async () => {
  const { locateCodexSessionByBindingNonce } = require(path.join(projectRoot, 'out', 'codexSessionIdentity.js'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-codex-streaming-'));
  const workspaceRoot = '/workspace/solomap';
  const bindingNonce = 'aaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999';
  const sessionId = '019ecd99-4325-7050-8e71-7def92359d13';
  const transcriptPath = writeTranscript(codexHome, {
    sessionId,
    workspaceRoot,
    timestamp: '2026-09-02T00:50:00.000Z',
    messages: [
      { role: 'user', text: '# injected prelude' },
      { role: 'user', text: `SoloMap binding nonce: ${bindingNonce}.` },
      { role: 'assistant', text: 'first response' }
    ]
  });
  fs.appendFileSync(transcriptPath, `${JSON.stringify({ type: 'event_msg', payload: { type: 'large_suffix', text: 'x'.repeat(2 * 1024 * 1024) } })}\n`, 'utf8');
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
    if (path.resolve(String(filePath)) === path.resolve(transcriptPath)) {
      throw new Error('the locator must not synchronously read the complete transcript');
    }
    return originalReadFileSync.call(this, filePath, ...args);
  };
  let result;
  try {
    result = await locateCodexSessionByBindingNonce({
      codexHome,
      workspaceRoot,
      bindingNonce,
      startedAt: '2026-09-02T00:49:59.000Z'
    });
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.equal(result.status, 'matched');
  assert.equal(result.sessionId, sessionId);
});
