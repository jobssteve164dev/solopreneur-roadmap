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
