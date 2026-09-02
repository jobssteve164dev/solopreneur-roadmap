const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

function writeTranscript(codexHome, { sessionId, workspaceRoot, timestamp, userTexts }) {
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
    ...userTexts.map((text) => ({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }]
      }
    }))
  ];
  fs.writeFileSync(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return transcriptPath;
}

test('Codex compatibility locator requires one exact nonce match in the first user record', () => {
  const { locateCodexSessionByBindingNonce } = require(path.join(projectRoot, 'out', 'codexSessionIdentity.js'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-codex-identity-'));
  const workspaceRoot = '/workspace/solomap';
  const bindingNonce = 'f0f1f2f3f4f5f6f7f8f9a0a1a2a3a4a5';
  const sessionId = '019ecd99-4325-7050-8e71-7def92359d00';
  const transcriptPath = writeTranscript(codexHome, {
    sessionId,
    workspaceRoot,
    timestamp: '2026-09-02T00:00:01.000Z',
    userTexts: [`SoloMap binding nonce: ${bindingNonce}.`]
  });
  writeTranscript(codexHome, {
    sessionId: '019ecd99-4325-7050-8e71-7def92359d01',
    workspaceRoot,
    timestamp: '2026-09-02T00:00:02.000Z',
    userTexts: ['another conversation', `SoloMap binding nonce: ${bindingNonce}.`]
  });

  assert.deepEqual(locateCodexSessionByBindingNonce({
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

test('Codex compatibility locator reports ambiguity instead of selecting the newest transcript', () => {
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
    userTexts: [`SoloMap binding nonce: ${bindingNonce}.`]
  }));

  const result = locateCodexSessionByBindingNonce({
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
