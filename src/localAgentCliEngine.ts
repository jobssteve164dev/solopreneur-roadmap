import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { getAgentCliFamily, resolveAgentCliWithinFamily } from './agentCli';
import { CognitiveShadowEngine, CognitiveShadowInput, CognitiveShadowProposal } from './autonomousRuntime';

export interface CognitiveCliInvocation {
  command: string;
  args: string[];
  stdin: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell: false;
}

type CognitiveCliRunner = (invocation: CognitiveCliInvocation) => Promise<string>;

function modelArgs(model: string): string[] {
  return model && model !== 'auto' ? ['--model', model] : [];
}

export function buildCognitiveCliInvocation(agentCli: string, model: string, prompt: string, cwd?: string): CognitiveCliInvocation {
  const family = getAgentCliFamily(agentCli);
  const selectedModel = modelArgs(String(model || 'auto'));
  let args: string[];
  let stdin = prompt;
  if (family === 'codex') {
    args = ['exec', '--color', 'never', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules', ...selectedModel, '-'];
  } else if (family === 'copilot') {
    args = ['-s', '--available-tools', '--disable-builtin-mcps', '--no-custom-instructions', '--no-ask-user', '--no-auto-update', '--no-color', ...selectedModel];
  } else if (family === 'claude') {
    args = ['-p', '--permission-mode', 'plan', '--permission-prompts', 'none', '--tools', '', '--no-session-persistence', '--setting-sources', '', '--output-format', 'text', ...selectedModel];
  } else if (family === 'cursor') {
    args = ['-p', '--mode', 'plan', '--sandbox', 'enabled', '--output-format', 'text', ...selectedModel];
  } else if (family === 'antigravity') {
    args = ['--print', '--mode', 'plan', '--sandbox', '--disable-slash-commands', '--print-timeout', '5m', ...selectedModel];
  } else {
    throw new Error(`${family || agentCli} does not expose a safe headless cognitive mode.`);
  }
  return { command: agentCli, args, stdin, cwd, env: allowedEnvironment(), shell: false };
}

function allowedEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
    CODEX_SHARED_CONFIG_PATH: process.env.CODEX_SHARED_CONFIG_PATH,
    CODEX_SHARED_DEVICE_IDENTITY_PATH: process.env.CODEX_SHARED_DEVICE_IDENTITY_PATH,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    SystemRoot: process.env.SystemRoot,
    NO_COLOR: '1'
  }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function runInvocation(invocation: CognitiveCliInvocation, registerCancel: (cancel?: () => void) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env || allowedEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let terminationError: Error | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      registerCancel(undefined);
      callback();
    };
    const terminate = (error: Error) => {
      if (settled || terminationError) return;
      terminationError = error;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 2_000);
      forceKillTimer.unref();
    };
    registerCancel(() => terminate(new Error('Local Agent CLI cognitive call was cancelled.')));
    const timer = setTimeout(() => {
      terminate(new Error('Local Agent CLI cognitive call timed out.'));
    }, 60_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += String(chunk).slice(0, 65_536 - stdout.length); });
    child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 8_192 - stderr.length); });
    child.once('error', error => finish(() => reject(error)));
    child.once('close', code => finish(() => terminationError
      ? reject(terminationError)
      : code === 0
        ? resolve(stdout.trim())
        : reject(new Error(`Local Agent CLI cognitive call failed (${code ?? 'unknown'}): ${stderr.trim()}`))));
    child.stdin.end(invocation.stdin);
  });
}

function buildPrompt(input: CognitiveShadowInput): string {
  return [
    '你是 SoloMap 今日安排的只读决策器。',
    '只能从候选中选择今天最值得先推进的一项。不要调用工具，不要读取文件，不要执行任务。',
    '只输出一行合法 JSON：{"candidateId":"候选 ID","reason":"给最终用户的一句简短理由"}',
    JSON.stringify(input.candidates)
  ].join('\n');
}

function parseProposal(value: string): CognitiveShadowProposal {
  const source = String(value || '').trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || source.slice(source.indexOf('{'), source.lastIndexOf('}') + 1);
  const parsed = JSON.parse(candidate);
  return { candidateId: String(parsed.candidateId || '').trim(), reason: String(parsed.reason || '').trim() };
}

export class LocalAgentCliEngine implements CognitiveShadowEngine {
  public readonly id: string;
  private readonly agentCli: string;
  private readonly model: string;
  private readonly workingDirectory?: string;
  private readonly runner: CognitiveCliRunner;
  private cancelActive?: () => void;

  constructor(options: { agentCli: string; model?: string; configRevision?: string; workingDirectory?: string; runner?: CognitiveCliRunner }) {
    this.agentCli = options.runner ? options.agentCli : resolveAgentCliWithinFamily(options.agentCli, options.agentCli);
    this.model = String(options.model || 'auto');
    this.workingDirectory = options.workingDirectory;
    this.runner = options.runner || ((invocation) => runInvocation(invocation, cancel => { this.cancelActive = cancel; }));
    this.id = `agent-cli:${getAgentCliFamily(this.agentCli)}:${this.model}:${String(options.configRevision || 'unversioned')}`;
  }

  public async plan(input: CognitiveShadowInput): Promise<CognitiveShadowProposal> {
    if (this.workingDirectory) fs.mkdirSync(this.workingDirectory, { recursive: true });
    const invocation = buildCognitiveCliInvocation(this.agentCli, this.model, buildPrompt(input), this.workingDirectory);
    const proposal = parseProposal(await this.runner(invocation));
    if (!input.candidates.some(candidate => candidate.id === proposal.candidateId)) {
      throw new Error('Local Agent CLI selected an unknown Today arrangement candidate.');
    }
    if (!proposal.reason || proposal.reason.length > 240) {
      throw new Error('Local Agent CLI decision reason is missing or too long.');
    }
    return proposal;
  }

  public cancel(): void {
    this.cancelActive?.();
  }
}
