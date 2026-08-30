import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  commandExists,
  getAgentCliCandidates,
  getAgentCliFamily,
  getAgentTaskAutomationStatus,
  getKnownAgentCliCandidates,
  resolveExecutablePath,
  resolveAgentCli,
  shellQuote
} from './agentCli';
import { normalizeGlobalDataPath, SolopreneurProject } from './projectPortfolio';

export interface DependencyStatus {
  agentReady: boolean;
  agentMessage: string;
  agentAutomationReady: boolean;
  agentAutomationPreconfigured: boolean;
  agentAutomationMessage: string;
  agentAutomationCanPrepare: boolean;
  githubCliReady: boolean;
  githubAuthReady: boolean;
  githubMessage: string;
  supportedAgents: SupportedAgentStatus[];
}

export interface SupportedAgentStatus {
  family: string;
  title: string;
  candidates: string[];
  command: string;
  installed: boolean;
  selected: boolean;
  automationReady: boolean;
  automationPreconfigured: boolean;
  automationCanPrepare: boolean;
  loginState: 'trial_required' | 'not_installed';
  message: string;
}

const supportedAgentFamilies = [
  { family: 'antigravity', title: 'Agy / Antigravity' },
  { family: 'codex', title: 'Codex' },
  { family: 'cursor', title: 'Cursor' },
  { family: 'claude', title: 'Claude' },
  { family: 'copilot', title: 'Copilot' },
  { family: 'opencode', title: 'OpenCode' },
  { family: 'grok', title: 'Grok' }
];

export function getSupportedAgentStatuses(configuredCliPath: string): SupportedAgentStatus[] {
  const selectedCli = resolveAgentCli(configuredCliPath || 'agy', configuredCliPath || 'agy');
  const selectedFamily = getAgentCliFamily(selectedCli || configuredCliPath || 'agy');

  return supportedAgentFamilies.map((agent) => {
    const candidates = getKnownAgentCliCandidates(agent.family);
    const detected = candidates.find(commandExists) || '';
    const command = detected ? resolveExecutablePath(detected) : '';
    const automation = command
      ? getAgentTaskAutomationStatus(command)
      : { supported: false, preconfigured: false, permissionArgs: '', message: 'Agent CLI is not installed.' };
    const installed = Boolean(command);
    return {
      family: agent.family,
      title: agent.title,
      candidates,
      command,
      installed,
      selected: selectedFamily === agent.family,
      automationReady: installed && automation.supported,
      automationPreconfigured: Boolean(automation.preconfigured),
      automationCanPrepare: installed && automation.supported && !automation.preconfigured,
      loginState: installed ? 'trial_required' : 'not_installed',
      message: installed
        ? 'Installed. Run a task or use the Agent login action if this CLI asks you to sign in.'
        : `Not found. Tried: ${candidates.join(', ')}`
    };
  });
}

export function getDependencyStatus(cliPath: string): DependencyStatus {
  const agentCli = resolveAgentCli(cliPath || 'agy', cliPath || 'agy');
  const agentReady = commandExists(agentCli);
  const automation = agentReady
    ? getAgentTaskAutomationStatus(agentCli)
    : { supported: false, preconfigured: false, permissionArgs: '', message: 'Agent CLI is not ready yet.' };
  const githubCliReady = commandExists('gh');
  let githubAuthReady = false;
  let githubMessage = githubCliReady ? 'GitHub CLI is installed.' : 'GitHub CLI is not installed.';
  if (githubCliReady) {
    const auth = childProcess.spawnSync('gh', ['auth', 'status'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    githubAuthReady = auth.status === 0;
    githubMessage = githubAuthReady ? 'GitHub is authorized.' : 'GitHub authorization is needed.';
  }
  return {
    agentReady,
    agentMessage: agentReady ? `${agentCli} is ready.` : `Agent CLI not found. Tried: ${getAgentCliCandidates(cliPath || 'agy', cliPath || 'agy').join(', ')}`,
    agentAutomationReady: agentReady && automation.supported,
    agentAutomationPreconfigured: Boolean(automation.preconfigured),
    agentAutomationMessage: automation.message,
    agentAutomationCanPrepare: agentReady && automation.supported && !automation.preconfigured,
    githubCliReady,
    githubAuthReady,
    githubMessage,
    supportedAgents: getSupportedAgentStatuses(cliPath || 'agy')
  };
}

export function buildAgentInstallCommand(cliPath: string): string {
  const family = getAgentCliFamily(cliPath || 'agy');
  const verifyCandidates = getKnownAgentCliCandidates(family)
    .filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
  const verifyScript = [
    'echo ""',
    'echo "SoloMap: verifying Agent CLI..."',
    `for c in ${verifyCandidates.map(shellQuote).join(' ')}; do if command -v "$c" >/dev/null 2>&1; then echo "SoloMap: found $(command -v "$c")"; "$c" --version || true; exit 0; fi; done`,
    'echo "SoloMap: install command finished, but the CLI is not visible in this terminal PATH yet."',
    'echo "SoloMap: restart VS Code/code-server or paste the executable absolute path into SoloMap settings."'
  ].join('; ');

  if (family === 'codex') return `npm install -g @openai/codex; ${verifyScript}`;
  if (family === 'claude') return `npm install -g @anthropic-ai/claude-code; ${verifyScript}`;
  if (family === 'copilot') return `npm install -g @github/copilot; ${verifyScript}`;
  if (family === 'opencode') return `npm install -g opencode-ai; ${verifyScript}`;
  if (family === 'antigravity') return `curl -fsSL https://antigravity.google/cli/install.sh | bash; ${verifyScript}`;
  if (family === 'grok') return `curl -fsSL https://x.ai/cli/install.sh | bash; ${verifyScript}`;
  if (family === 'cursor') {
    return [
      'echo "SoloMap: Cursor CLI is installed from the Cursor app command palette."',
      'echo "Open Cursor, run the command to install the cursor command, then return here and click Check."',
      'echo "If the command already exists, paste its absolute path into SoloMap settings."'
    ].join('; ');
  }
  return [
    `echo "SoloMap: no built-in installer is available for ${String(cliPath || 'this custom CLI').replace(/"/g, '\\"')}."`,
    'echo "Install that CLI with its official installer, then paste its executable absolute path into SoloMap settings."'
  ].join('; ');
}

export function buildAgentAutomationWrapper(
  cliPath: string,
  globalDataPath: string,
  projects: SolopreneurProject[]
): { ok: boolean; message: string; wrapperPath?: string } {
  const agentCli = resolveAgentCli(cliPath || 'agy', cliPath || 'agy');
  if (!commandExists(agentCli)) {
    return { ok: false, message: `Agent CLI not found. Tried: ${getAgentCliCandidates(cliPath || 'agy', cliPath || 'agy').join(', ')}` };
  }
  const automation = getAgentTaskAutomationStatus(agentCli);
  if (!automation.supported) return { ok: false, message: automation.message };
  if (automation.preconfigured) return { ok: true, message: automation.message, wrapperPath: agentCli };

  const family = getAgentCliFamily(agentCli || cliPath || 'agy');
  const wrapperNameByFamily: Record<string, string> = {
    antigravity: 'agy',
    codex: 'codex',
    cursor: 'cursor-agent',
    claude: 'claude',
    copilot: 'copilot',
    grok: 'grok'
  };
  const wrapperName = wrapperNameByFamily[family] || path.basename(agentCli).replace(/[^a-z0-9_-]/gi, '-') || 'agent';
  const wrapperDir = path.join(normalizeGlobalDataPath(globalDataPath, projects), 'agent-cli');
  const wrapperPath = path.join(wrapperDir, wrapperName);
  fs.mkdirSync(wrapperDir, { recursive: true });
  fs.writeFileSync(wrapperPath, `#!/bin/sh\nexec ${shellQuote(agentCli)} ${automation.permissionArgs} "$@"\n`, {
    encoding: 'utf8',
    mode: 0o755
  });
  fs.chmodSync(wrapperPath, 0o755);
  return { ok: true, message: `Agent prepared for automatic task runs: ${wrapperPath}`, wrapperPath };
}
