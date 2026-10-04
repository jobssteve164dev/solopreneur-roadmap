const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const agentCli = require('../out/agentCli.js');
const sidebarDependencies = require('../out/sidebarDependencies.js');

const workspaceRoot = '/workspace/app';
const promptFilePath = '/workspace/app/.solopreneur/agent-runs/2/prompt.txt';
const cliContracts = [
  {
    family: 'antigravity',
    executable: 'agy',
    installCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    permissionArgs: '--dangerously-skip-permissions'
  },
  {
    family: 'codex',
    executable: 'codex',
    installCommand: 'npm install -g @openai/codex',
    permissionArgs: '--dangerously-bypass-approvals-and-sandbox'
  },
  {
    family: 'cursor',
    executable: 'cursor-agent',
    installCommand: 'curl https://cursor.com/install -fsS | bash',
    permissionArgs: '--force'
  },
  {
    family: 'claude',
    executable: 'claude',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    permissionArgs: '--dangerously-skip-permissions'
  },
  {
    family: 'copilot',
    executable: 'copilot',
    installCommand: 'npm install -g @github/copilot',
    permissionArgs: '--allow-all --no-ask-user'
  },
  {
    family: 'opencode',
    executable: 'opencode',
    installCommand: 'npm install -g opencode-ai',
    permissionArgs: '--auto'
  },
  {
    family: 'grok',
    executable: 'grok',
    installCommand: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    permissionArgs: '--always-approve'
  }
];

for (const contract of cliContracts) {
  test(`${contract.family} setup uses its official installer and automatic permission flag`, () => {
    assert.ok(
      sidebarDependencies.buildAgentInstallCommand(contract.family).startsWith(contract.installCommand),
      `${contract.family} must start with its official install command`
    );
    assert.deepEqual(agentCli.getAgentTaskAutomationStatus(contract.executable), {
      supported: true,
      preconfigured: false,
      permissionArgs: contract.permissionArgs,
      message: `SoloMap can prepare ${contract.executable} automatically for task runs.`
    });

    const oneShot = agentCli.buildAgentCommandForPromptFile(
      contract.executable,
      promptFilePath,
      workspaceRoot,
      'always'
    );
    const interactive = agentCli.buildInteractiveAgentCommandForPromptFile(
      contract.executable,
      promptFilePath,
      workspaceRoot,
      'always'
    );
    assert.ok(oneShot.includes(contract.permissionArgs), `${contract.family} one-shot command must grant task permissions`);
    assert.ok(interactive.includes(contract.permissionArgs), `${contract.family} interactive command must grant task permissions`);
  });
}

test('review launches use the same automatic Agent permission contract as normal task runs', () => {
  const runDir = '/global/maintenance/runs/review';
  const prompt = `${runDir}/prompt.txt`;
  for (const contract of cliContracts) {
    const review = agentCli.buildAgentCommandForPromptFile(contract.executable, prompt, runDir, 'always');
    const normal = agentCli.buildAgentCommandForPromptFile(contract.executable, prompt, runDir, 'always');
    assert.equal(review, normal);
    assert.ok(review.includes(contract.permissionArgs), `${contract.family} must preserve the normal automatic task permission setting`);
  }
});

test('agy interactive commands bind the prompt to its flag before shell execution', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-agy-argv-'));
  const fakeAgy = path.join(fixtureRoot, 'agy');
  const capturedArgsPath = path.join(fixtureRoot, 'args.json');
  fs.writeFileSync(fakeAgy, `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.SOLOMAP_CAPTURE_ARGS, JSON.stringify(process.argv.slice(2)));
`, { mode: 0o755 });

  const cases = [
    {
      command: agentCli.buildInteractiveAgentCommandForPromptFile(
        fakeAgy,
        promptFilePath,
        workspaceRoot,
        'never'
      ),
      expectedPrompt: `Read the complete SoloMap task prompt from ${promptFilePath} and follow that file exactly. The user request inside the file is the highest priority. Stay in this interactive session after completing the current turn.`,
      expectedConversation: []
    },
    {
      command: agentCli.buildInteractiveAgentContinuationCommandForPromptFile(
        fakeAgy,
        promptFilePath,
        workspaceRoot,
        'session-123',
        'never'
      ),
      expectedPrompt: `Read the complete SoloMap continuation prompt from ${promptFilePath} and follow that file exactly. Continue the existing task in this interactive session.`,
      expectedConversation: ['--conversation', 'session-123']
    }
  ];

  for (const fixture of cases) {
    const result = childProcess.spawnSync('/bin/sh', ['-c', fixture.command], {
      encoding: 'utf8',
      env: { ...process.env, SOLOMAP_CAPTURE_ARGS: capturedArgsPath }
    });
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(fs.readFileSync(capturedArgsPath, 'utf8'));
    assert.deepEqual(args, [
      ...fixture.expectedConversation,
      `--add-dir=${workspaceRoot}`,
      `--prompt-interactive=${fixture.expectedPrompt}`
    ]);
  }
});

test('Cursor installer verifies the official user-local binary before PATH is refreshed', () => {
  const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-cursor-install-'));
  const installedCli = path.join(fixtureHome, '.local', 'bin', 'cursor-agent');
  fs.mkdirSync(path.dirname(installedCli), { recursive: true });
  fs.writeFileSync(installedCli, '#!/bin/sh\necho cursor-agent-test\n', { mode: 0o755 });

  const installCommand = sidebarDependencies.buildAgentInstallCommand('cursor');
  const verificationCommand = installCommand.slice(installCommand.indexOf('; ') + 2);
  const result = childProcess.spawnSync('/bin/sh', ['-c', verificationCommand], {
    encoding: 'utf8',
    env: { ...process.env, HOME: fixtureHome, PATH: '/usr/bin:/bin' }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`SoloMap: found ${installedCli.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.stdout, /cursor-agent-test/);
  assert.doesNotMatch(result.stdout, /not visible in this terminal PATH yet/);
});
