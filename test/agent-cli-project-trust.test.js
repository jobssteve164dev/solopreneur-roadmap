const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildInteractiveAgentCommandForPromptFile,
  buildInteractiveAgentContinuationCommandForPromptFile
} = require('../out/agentCli.js');

test('interactive Codex launch uses one isolated native TUI after preflight persisted project trust', () => {
  const command = buildInteractiveAgentCommandForPromptFile(
    'codex',
    '/workspace/fresh project/.solopreneur/agent-runs/1/prompt.txt',
    '/workspace/fresh project'
  );

  assert.match(command, /--profile solomap --no-daemon --no-alt-screen -C '\/workspace\/fresh project'/);
  assert.doesNotMatch(command, /--remote|SOLOMAP_CODEX_REMOTE/);
  assert.doesNotMatch(command, /projects\..*trust_level/);
});

test('interactive Codex process continuation uses one isolated native TUI', () => {
  const command = buildInteractiveAgentContinuationCommandForPromptFile(
    'codex',
    '/workspace/fresh project/.solopreneur/agent-runs/1/prompt.txt',
    '/workspace/fresh project',
    '019dc472-6a80-7c70-99a4-b2593a641d11'
  );

  assert.match(command, /--profile solomap --no-daemon resume --no-alt-screen -C '\/workspace\/fresh project'/);
  assert.doesNotMatch(command, /--remote|SOLOMAP_CODEX_REMOTE/);
  assert.doesNotMatch(command, /projects\..*trust_level/);
});

test('interactive Codex launch accepts a data-root-isolated profile without changing its native transport', () => {
  const command = buildInteractiveAgentCommandForPromptFile(
    'codex',
    '',
    '/workspace/project',
    'auto',
    '',
    '',
    '',
    'Read the task',
    'solomap-0123456789abcdef'
  );

  assert.match(command, /--profile solomap-0123456789abcdef --no-daemon --no-alt-screen/);
  assert.doesNotMatch(command, /--remote/);
});
