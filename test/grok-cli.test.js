const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const agentCli = require(path.join(projectRoot, 'out', 'agentCli.js'));
const agentModels = require(path.join(projectRoot, 'out', 'agentModels.js'));
const continuation = require(path.join(projectRoot, 'out', 'continuation.js'));
const sidebarDependencies = require(path.join(projectRoot, 'out', 'sidebarDependencies.js'));
const { getSharedWebviewRuntimeScript } = require(path.join(projectRoot, 'out', 'webviewSharedRuntime.js'));

test('Grok is a first-class Agent CLI in selection, detection, installation, and model discovery', () => {
  assert.equal(agentCli.getAgentCliFamily('/usr/local/bin/grok'), 'grok');
  assert.equal(agentCli.getAgentProvider('/usr/local/bin/grok'), 'grok');
  assert.equal(continuation.getContinuationAgentProvider('/usr/local/bin/grok'), 'grok');
  assert.deepEqual(agentCli.getKnownAgentCliCandidates('grok'), ['grok']);
  assert.ok(agentCli.getAgentCliCandidates('grok', '').includes('grok'));
  const grokStrategies = agentModels.getAgentModelDiscoveryStrategies('grok');
  assert.deepEqual(grokStrategies.map(strategy => `${strategy.kind}:${strategy.args.join(' ')}`), ['command:--no-auto-update models']);
  assert.deepEqual(grokStrategies[0].parse([
    'You are logged in with grok.com.',
    '',
    'Default model: grok-4.6',
    '',
    'Available models:',
    '  * grok-4.6 (default)',
    '  - composer-2.5',
    '',
    'Tips:',
    '  - Run grok update to upgrade'
  ].join('\n')), [
    { value: 'grok-4.6', label: 'grok-4.6', title: undefined },
    { value: 'composer-2.5', label: 'composer-2.5', title: undefined }
  ]);
  assert.match(sidebarDependencies.buildAgentInstallCommand('grok'), /https:\/\/x\.ai\/cli\/install\.sh/);

  const context = vm.createContext({});
  vm.runInContext(getSharedWebviewRuntimeScript(), context);
  const options = context.SoloMapWebview.getAgentOptions('codex', 'claude');
  assert.ok(options.some(option => option.value === 'grok' && option.label === 'grok'));
  assert.equal(context.SoloMapWebview.getCliPresetFromCliPath('/usr/local/bin/grok'), 'grok');
});

test('Grok task commands use the official working-directory, approval, model, and update flags', () => {
  const workspaceRoot = "/workspace/Steve's app";
  const promptFilePath = `${workspaceRoot}/.solopreneur/agent-runs/7/prompt.txt`;

  assert.equal(agentCli.getTaskPermissionArgs('grok', 'always'), '--always-approve');
  assert.equal(agentCli.getAgentModelFlag('grok', 'grok-4.6'), " --model 'grok-4.6'");

  const direct = agentCli.buildAgentCommand('grok', 'Fix the failing test', workspaceRoot, '', 'always', 'grok-4.6');
  assert.match(direct, /^'grok' --no-auto-update /);
  assert.match(direct, /--always-approve/);
  assert.match(direct, /--model 'grok-4\.6'/);
  assert.match(direct, /--cwd '\/workspace\/Steve'\\''s app'/);
  assert.match(direct, /--output-format plain -p 'Fix the failing test'$/);

  const fromFile = agentCli.buildAgentCommandForPromptFile('grok', promptFilePath, workspaceRoot, 'always');
  assert.match(fromFile, /^'grok' --no-auto-update /);
  assert.match(fromFile, /Read the complete SoloMap task prompt/);
  assert.match(fromFile, /--cwd '\/workspace\/Steve'\\''s app'/);

  const withSession = agentCli.buildAgentCommandForPromptFile(
    'grok', promptFilePath, workspaceRoot, 'always', '', '019ecd99-4325-7050-8e71-7def92359c9f'
  );
  assert.match(withSession, /--session-id '019ecd99-4325-7050-8e71-7def92359c9f'/);

  const fromVariable = agentCli.buildAgentCommandFromShellVar('grok', 'SOLOMAP_PROMPT', workspaceRoot, 'always');
  assert.match(fromVariable, /^'grok' --no-auto-update /);
  assert.match(fromVariable, /--output-format plain -p "\$SOLOMAP_PROMPT"$/);
});

test('Grok interactive and review commands preserve the existing SoloMap conversation paths', () => {
  const workspaceRoot = '/workspace/app';
  const promptFilePath = '/workspace/app/.solopreneur/agent-runs/7/prompt.txt';

  const interactive = agentCli.buildInteractiveAgentCommandForPromptFile(
    'grok', promptFilePath, workspaceRoot, 'always', 'grok-4.6', '019ecd99-4325-7050-8e71-7def92359c9f'
  );
  assert.match(interactive, /^'grok' --no-auto-update --no-alt-screen /);
  assert.match(interactive, /--cwd '\/workspace\/app'/);
  assert.match(interactive, /--always-approve/);
  assert.match(interactive, /--session-id '019ecd99-4325-7050-8e71-7def92359c9f'/);
  assert.match(interactive, /Stay in this interactive session/);
  assert.doesNotMatch(interactive, /(?:^|\s)-p(?:\s|$)/);

  const resumed = agentCli.buildInteractiveAgentContinuationCommandForPromptFile(
    'grok', promptFilePath, workspaceRoot, 'session-123', 'always', 'grok-4.6'
  );
  assert.match(resumed, /--resume 'session-123'/);
  assert.match(resumed, /Continue the existing task in this interactive session/);

  const nativeResume = agentCli.buildNativeContinueCommand('grok', 'session-123', workspaceRoot);
  assert.match(nativeResume, /^'grok' --no-auto-update --no-alt-screen /);
  assert.match(nativeResume, /--resume 'session-123'/);
  assert.match(nativeResume, /--cwd '\/workspace\/app'/);

  const review = agentCli.buildReadOnlyAgentCommandForPromptFile(
    'grok', promptFilePath, workspaceRoot, 'grok-4.6'
  );
  assert.match(review, /^'grok' --no-auto-update /);
  assert.match(review, /--sandbox read-only/);
  assert.match(review, /--always-approve/);
  assert.match(review, /--tools 'read_file,grep,list_dir'/);
  assert.match(review, /--deny 'Bash'/);
  assert.match(review, /--deny 'Edit'/);
  assert.match(review, /--deny 'Write'/);
  assert.match(review, /--deny 'MCPTool'/);
  assert.match(review, /--output-format plain/);
  assert.match(review, /-p 'Read the complete SoloMap review prompt/);
  assert.match(review, /Read the complete SoloMap review prompt/);

  const headlessContinuation = agentCli.buildAgentContinuationCommandForPromptFile(
    'grok', promptFilePath, workspaceRoot, 'session-123', 'always', 'grok-4.6'
  );
  assert.match(headlessContinuation, /--resume 'session-123'/);
  assert.match(headlessContinuation, /--output-format plain -p/);
});
