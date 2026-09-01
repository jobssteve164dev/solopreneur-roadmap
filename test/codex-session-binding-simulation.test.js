const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const projectRoot = path.resolve(__dirname, '..');
const simulationModulePath = path.join(projectRoot, 'scripts', 'simulate-codex-session-binding.mjs');

function interactivePromptInstruction(promptFilePath) {
  return `Read the complete SoloMap task prompt from ${promptFilePath} and follow that file exactly. The user request inside the file is the highest priority. Stay in this interactive session after completing the current turn.`;
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-session-binding-'));
  const createdDirectories = [root];
  const createdFiles = [];
  return {
    root,
    ensureDirectory(directoryPath) {
      const missing = [];
      let current = directoryPath;
      while (!fs.existsSync(current)) {
        missing.push(current);
        current = path.dirname(current);
      }
      for (const candidate of missing.reverse()) {
        fs.mkdirSync(candidate);
        createdDirectories.push(candidate);
      }
    },
    writeTranscript({
      sessionId,
      metaSessionId = sessionId,
      workspaceRoot,
      timestamp,
      userTexts,
      developerPrefixBytes = 0
    }) {
      const date = new Date(timestamp);
      const directoryPath = path.join(
        root,
        'sessions',
        String(date.getUTCFullYear()),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0')
      );
      this.ensureDirectory(directoryPath);
      const filePath = path.join(directoryPath, `rollout-${sessionId}.jsonl`);
      const rows = [
        {
          timestamp,
          type: 'session_meta',
          payload: {
            id: sessionId,
            session_id: metaSessionId,
            timestamp,
            cwd: workspaceRoot,
            originator: 'codex_cli_rs'
          }
        },
        {
          timestamp,
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: `Repository instructions.${'x'.repeat(developerPrefixBytes)}` }]
          }
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
      fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
      createdFiles.push(filePath);
      return filePath;
    },
    cleanup() {
      for (const filePath of createdFiles.reverse()) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      for (const directoryPath of createdDirectories.reverse()) {
        if (fs.existsSync(directoryPath)) fs.rmdirSync(directoryPath);
      }
    }
  };
}

async function loadSimulation() {
  assert.equal(
    fs.existsSync(simulationModulePath),
    true,
    'the isolated Codex session binding simulation has not been implemented'
  );
  return import(`${pathToFileURL(simulationModulePath).href}?test=${Date.now()}`);
}

test('selects the session whose workspace, start time, and SoloMap prompt path all match', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  const workspaceRoot = '/workspace/solomap';
  const promptFilePath = '/workspace/solomap/.solopreneur/agent-runs/__solo__/42/prompt.txt';
  const startedAt = '2026-09-01T12:00:00.000Z';

  fixture.writeTranscript({
    sessionId: '11111111-1111-4111-8111-111111111111',
    workspaceRoot,
    timestamp: '2026-09-01T11:59:00.000Z',
    userTexts: [interactivePromptInstruction(promptFilePath)]
  });
  fixture.writeTranscript({
    sessionId: '22222222-2222-4222-8222-222222222222',
    workspaceRoot: '/workspace/another-project',
    timestamp: '2026-09-01T12:00:01.000Z',
    userTexts: [interactivePromptInstruction(promptFilePath)]
  });
  fixture.writeTranscript({
    sessionId: '33333333-3333-4333-8333-333333333333',
    workspaceRoot,
    timestamp: '2026-09-01T12:00:02.000Z',
    userTexts: ['Read the complete SoloMap task prompt from /workspace/solomap/.solopreneur/agent-runs/__solo__/43/prompt.txt and follow that file exactly.']
  });
  fixture.writeTranscript({
    sessionId: '44444444-4444-4444-8444-444444444444',
    workspaceRoot,
    timestamp: '2026-09-01T12:00:03.000Z',
    userTexts: [
      'Repository instructions.',
      interactivePromptInstruction(promptFilePath)
    ]
  });

  const { locateCodexSessionForRun } = await loadSimulation();
  const result = await locateCodexSessionForRun({
    codexHome: fixture.root,
    workspaceRoot,
    promptFilePath,
    startedAt
  });

  assert.deepEqual(result, {
    status: 'matched',
    sessionId: '44444444-4444-4444-8444-444444444444',
    candidateSessionIds: ['44444444-4444-4444-8444-444444444444']
  });
});

test('selects a real conversation by an explicit unique binding marker', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  const marker = 'SOLOMAP_REAL_SESSION_SIMULATION_20260901_B';
  fixture.writeTranscript({
    sessionId: '55555555-5555-4555-8555-555555555555',
    workspaceRoot: '/workspace/solomap',
    timestamp: '2026-09-01T12:00:01.000Z',
    userTexts: [`${marker}. First real turn.`]
  });
  fixture.writeTranscript({
    sessionId: '66666666-6666-4666-8666-666666666666',
    workspaceRoot: '/workspace/solomap',
    timestamp: '2026-09-01T12:00:02.000Z',
    userTexts: ['SOLOMAP_REAL_SESSION_SIMULATION_20260901_D. Concurrent decoy turn.']
  });

  const { locateCodexSessionForRun } = await loadSimulation();
  const result = await locateCodexSessionForRun({
    codexHome: fixture.root,
    workspaceRoot: '/workspace/solomap',
    bindingMarker: marker,
    startedAt: '2026-09-01T12:00:00.000Z'
  });

  assert.deepEqual(result, {
    status: 'matched',
    sessionId: '55555555-5555-4555-8555-555555555555',
    candidateSessionIds: ['55555555-5555-4555-8555-555555555555']
  });
});

test('refuses to guess when two sessions contain the same binding marker', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  const promptFilePath = '/workspace/solomap/.solopreneur/agent-runs/__solo__/42/prompt.txt';
  const prompt = interactivePromptInstruction(promptFilePath);
  for (const [sessionId, timestamp] of [
    ['77777777-7777-4777-8777-777777777777', '2026-09-01T12:00:01.000Z'],
    ['88888888-8888-4888-8888-888888888888', '2026-09-01T12:00:02.000Z']
  ]) {
    fixture.writeTranscript({ sessionId, workspaceRoot: '/workspace/solomap', timestamp, userTexts: [prompt] });
  }

  const { locateCodexSessionForRun } = await loadSimulation();
  const result = await locateCodexSessionForRun({
    codexHome: fixture.root,
    workspaceRoot: '/workspace/solomap',
    promptFilePath,
    startedAt: '2026-09-01T12:00:00.000Z'
  });

  assert.deepEqual(result, {
    status: 'ambiguous',
    sessionId: '',
    candidateSessionIds: [
      '77777777-7777-4777-8777-777777777777',
      '88888888-8888-4888-8888-888888888888'
    ]
  });
});

test('rejects a transcript whose session_meta identifiers disagree', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  const marker = 'SOLOMAP_BINDING_META_MISMATCH';
  fixture.writeTranscript({
    sessionId: '99999999-9999-4999-8999-999999999999',
    metaSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workspaceRoot: '/workspace/solomap',
    timestamp: '2026-09-01T12:00:01.000Z',
    userTexts: [marker]
  });

  const { locateCodexSessionForRun } = await loadSimulation();
  const result = await locateCodexSessionForRun({
    codexHome: fixture.root,
    workspaceRoot: '/workspace/solomap',
    bindingMarker: marker,
    startedAt: '2026-09-01T12:00:00.000Z'
  });

  assert.deepEqual(result, { status: 'not_found', sessionId: '', candidateSessionIds: [] });
});

test('does not accept a longer lookalike prompt path', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  const promptFilePath = '/workspace/solomap/.solopreneur/agent-runs/__solo__/42/prompt.txt';
  fixture.writeTranscript({
    sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    workspaceRoot: '/workspace/solomap',
    timestamp: '2026-09-01T12:00:01.000Z',
    userTexts: [interactivePromptInstruction(`${promptFilePath}.backup`)]
  });

  const { locateCodexSessionForRun } = await loadSimulation();
  const result = await locateCodexSessionForRun({
    codexHome: fixture.root,
    workspaceRoot: '/workspace/solomap',
    promptFilePath,
    startedAt: '2026-09-01T12:00:00.000Z'
  });

  assert.deepEqual(result, { status: 'not_found', sessionId: '', candidateSessionIds: [] });
});

test('finds the binding marker after more than 160 KiB of transcript prefix', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  const marker = 'SOLOMAP_BINDING_AFTER_LARGE_PREFIX';
  fixture.writeTranscript({
    sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    workspaceRoot: '/workspace/solomap',
    timestamp: '2026-09-01T12:00:01.000Z',
    developerPrefixBytes: 192 * 1024,
    userTexts: [marker]
  });

  const { locateCodexSessionForRun } = await loadSimulation();
  const result = await locateCodexSessionForRun({
    codexHome: fixture.root,
    workspaceRoot: '/workspace/solomap',
    bindingMarker: marker,
    startedAt: '2026-09-01T12:00:00.000Z'
  });

  assert.equal(result.status, 'matched');
  assert.equal(result.sessionId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
});

test('requires exactly one selector instead of letting a correct prompt hide a wrong marker', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  const promptFilePath = '/workspace/solomap/.solopreneur/agent-runs/__solo__/42/prompt.txt';
  fixture.writeTranscript({
    sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    workspaceRoot: '/workspace/solomap',
    timestamp: '2026-09-01T12:00:01.000Z',
    userTexts: [interactivePromptInstruction(promptFilePath)]
  });

  const { locateCodexSessionForRun } = await loadSimulation();
  await assert.rejects(
    locateCodexSessionForRun({
      codexHome: fixture.root,
      workspaceRoot: '/workspace/solomap',
      bindingMarker: 'SOLOMAP_MARKER_THAT_IS_NOT_PRESENT',
      promptFilePath,
      startedAt: '2026-09-01T12:00:00.000Z'
    }),
    /exactly one of bindingMarker or promptFilePath/
  );
});

test('rejects a transcript whose session metadata omits cwd', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  const marker = 'SOLOMAP_BINDING_MISSING_CWD';
  fixture.writeTranscript({
    sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    workspaceRoot: undefined,
    timestamp: '2026-09-01T12:00:01.000Z',
    userTexts: [marker]
  });

  const { locateCodexSessionForRun } = await loadSimulation();
  const result = await locateCodexSessionForRun({
    codexHome: fixture.root,
    workspaceRoot: projectRoot,
    bindingMarker: marker,
    startedAt: '2026-09-01T12:00:00.000Z'
  });

  assert.deepEqual(result, { status: 'not_found', sessionId: '', candidateSessionIds: [] });
});

test('requires the complete interactive SoloMap wrapper in prompt-path compatibility mode', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  const promptFilePath = '/workspace/solomap/.solopreneur/agent-runs/__solo__/42/prompt.txt';
  fixture.writeTranscript({
    sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    workspaceRoot: '/workspace/solomap',
    timestamp: '2026-09-01T12:00:01.000Z',
    userTexts: [`Read the complete SoloMap task prompt from ${promptFilePath} and follow that file exactly.`]
  });

  const { locateCodexSessionForRun } = await loadSimulation();
  const result = await locateCodexSessionForRun({
    codexHome: fixture.root,
    workspaceRoot: '/workspace/solomap',
    promptFilePath,
    startedAt: '2026-09-01T12:00:00.000Z'
  });

  assert.deepEqual(result, { status: 'not_found', sessionId: '', candidateSessionIds: [] });
});

test('matches a marker only in a user message and rejects longer lookalike markers', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  const marker = 'SOLOMAP_EXACT_BINDING_MARKER';
  const transcript = fixture.writeTranscript({
    sessionId: 'abababab-abab-4bab-8bab-abababababab',
    workspaceRoot: '/workspace/solomap',
    timestamp: '2026-09-01T12:00:01.000Z',
    userTexts: [`${marker}_LOOKALIKE`]
  });
  fs.appendFileSync(transcript, `${JSON.stringify({
    timestamp: '2026-09-01T12:00:02.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: marker }]
    }
  })}\n`, 'utf8');

  const { locateCodexSessionForRun } = await loadSimulation();
  const result = await locateCodexSessionForRun({
    codexHome: fixture.root,
    workspaceRoot: '/workspace/solomap',
    bindingMarker: marker,
    startedAt: '2026-09-01T12:00:00.000Z'
  });

  assert.deepEqual(result, { status: 'not_found', sessionId: '', candidateSessionIds: [] });
});

test('finds a live transcript after the first user wrapper is appended', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  const promptFilePath = '/workspace/solomap/.solopreneur/agent-runs/__solo__/42/prompt.txt';
  const timestamp = '2026-09-01T12:00:01.000Z';
  const sessionId = '12121212-1212-4212-8212-121212121212';
  const transcript = fixture.writeTranscript({
    sessionId,
    workspaceRoot: '/workspace/solomap',
    timestamp,
    userTexts: []
  });
  const { locateCodexSessionForRun } = await loadSimulation();
  const input = {
    codexHome: fixture.root,
    workspaceRoot: '/workspace/solomap',
    promptFilePath,
    startedAt: '2026-09-01T12:00:00.000Z'
  };

  assert.equal((await locateCodexSessionForRun(input)).status, 'not_found');
  fs.appendFileSync(transcript, `${JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: interactivePromptInstruction(promptFilePath) }]
    }
  })}\n`, 'utf8');

  assert.deepEqual(await locateCodexSessionForRun(input), {
    status: 'matched',
    sessionId,
    candidateSessionIds: [sessionId]
  });
});

test('skips a transcript that disappears during scanning and still finds the unique match', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  fixture.writeTranscript({
    sessionId: '01010101-0101-4101-8101-010101010101',
    workspaceRoot: '/workspace/solomap',
    timestamp: '2026-09-01T12:00:01.000Z',
    developerPrefixBytes: 2 * 1024 * 1024,
    userTexts: ['unrelated']
  });
  const disappearing = fixture.writeTranscript({
    sessionId: '02020202-0202-4202-8202-020202020202',
    workspaceRoot: '/workspace/solomap',
    timestamp: '2026-09-01T12:00:02.000Z',
    userTexts: ['unrelated']
  });
  const marker = 'SOLOMAP_BINDING_AFTER_IO_RACE';
  fixture.writeTranscript({
    sessionId: '03030303-0303-4303-8303-030303030303',
    workspaceRoot: '/workspace/solomap',
    timestamp: '2026-09-01T12:00:03.000Z',
    userTexts: [marker]
  });

  const { locateCodexSessionForRun } = await loadSimulation();
  setImmediate(() => {
    if (fs.existsSync(disappearing)) fs.unlinkSync(disappearing);
  });
  const result = await locateCodexSessionForRun({
    codexHome: fixture.root,
    workspaceRoot: '/workspace/solomap',
    bindingMarker: marker,
    startedAt: '2026-09-01T12:00:00.000Z'
  });

  assert.deepEqual(result, {
    status: 'matched',
    sessionId: '03030303-0303-4303-8303-030303030303',
    candidateSessionIds: ['03030303-0303-4303-8303-030303030303']
  });
});

test('CLI returns structured output and the documented exit codes', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  const marker = 'SOLOMAP_BINDING_CLI_E2E';
  fixture.writeTranscript({
    sessionId: '04040404-0404-4404-8404-040404040404',
    workspaceRoot: '/workspace/solomap',
    timestamp: '2026-09-01T12:00:01.000Z',
    userTexts: [marker]
  });

  const result = spawnSync(process.execPath, [
    simulationModulePath,
    '--codex-home', fixture.root,
    '--workspace', '/workspace/solomap',
    '--marker', marker,
    '--started-at', '2026-09-01T12:00:00.000Z'
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sessionId, '04040404-0404-4404-8404-040404040404');

  fixture.writeTranscript({
    sessionId: '05050505-0505-4505-8505-050505050505',
    workspaceRoot: '/workspace/solomap',
    timestamp: '2026-09-01T12:00:02.000Z',
    userTexts: [marker]
  });
  const ambiguous = spawnSync(process.execPath, [
    simulationModulePath,
    '--codex-home', fixture.root,
    '--workspace', '/workspace/solomap',
    '--marker', marker,
    '--started-at', '2026-09-01T12:00:00.000Z'
  ], { encoding: 'utf8' });
  assert.equal(ambiguous.status, 3, ambiguous.stderr);
  assert.equal(JSON.parse(ambiguous.stdout).status, 'ambiguous');

  const missing = spawnSync(process.execPath, [
    simulationModulePath,
    '--codex-home', fixture.root,
    '--workspace', '/workspace/solomap',
    '--marker', 'SOLOMAP_BINDING_CLI_MISSING',
    '--started-at', '2026-09-01T12:00:00.000Z'
  ], { encoding: 'utf8' });
  assert.equal(missing.status, 2, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).status, 'not_found');

  const invalid = spawnSync(process.execPath, [
    simulationModulePath,
    '--codex-home', fixture.root,
    '--workspace', '/workspace/solomap',
    '--marker', marker,
    '--prompt', '/workspace/solomap/prompt.txt',
    '--started-at', '2026-09-01T12:00:00.000Z'
  ], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /exactly one of bindingMarker or promptFilePath/);
});
