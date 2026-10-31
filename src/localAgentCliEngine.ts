import * as childProcess from 'child_process';
import { performance } from 'node:perf_hooks';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BroadcastChannel } from 'node:worker_threads';

import { getAgentCliFamily, resolveAgentCliWithinFamily } from './agentCli';
import { CognitiveShadowEngine, CognitiveShadowInput, CognitiveShadowProposal } from './autonomousRuntime';
import { desktopSessionEnvironment } from './desktopSessionEnvironment';
import { recordCurrentDiagnosticStage } from './localDiagnostics';

export interface CognitiveCliInvocation {
  command: string;
  args: string[];
  stdin: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell: false;
  timeoutMs?: number;
  maxOutputCharacters?: number;
  outputSchema?: Record<string, unknown>;
}

export type CognitiveCliRunner = (invocation: CognitiveCliInvocation) => Promise<string>;

const cognitiveInvocationRegistryKey = Symbol.for('solomap.activeCognitiveCliInvocations');
const cognitiveShutdownEvent = 'solomap-runtime-cognitive-shutdown';
const cognitiveShutdownChannel = new BroadcastChannel('solomap-runtime-cognitive-lifecycle');
cognitiveShutdownChannel.unref();
const cognitiveInvocationGlobal = globalThis as Record<PropertyKey, unknown>;
const activeCognitiveCliInvocations = (cognitiveInvocationGlobal[cognitiveInvocationRegistryKey] as Set<() => void> | undefined)
  || new Set<() => void>();
const activeCognitiveCliPids = new Set<number>();
let cognitiveShutdownRequested = false;
cognitiveInvocationGlobal[cognitiveInvocationRegistryKey] = activeCognitiveCliInvocations;
cognitiveShutdownChannel.onmessage = event => {
  const message = (event as { data?: unknown }).data as { type?: string; pid?: number } | undefined;
  if (message?.type === 'active' && Number.isSafeInteger(message.pid)) activeCognitiveCliPids.add(message.pid!);
  if (message?.type === 'inactive' && Number.isSafeInteger(message.pid)) activeCognitiveCliPids.delete(message.pid!);
  if (message?.type === 'shutdown') {
    cognitiveShutdownRequested = true;
    cancelActiveCognitiveCliInvocations();
    terminateActiveCognitiveCliProcesses();
  }
};

function terminateActiveCognitiveCliProcesses(): void {
  for (const pid of [...activeCognitiveCliPids]) {
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    const force = setTimeout(() => {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }, 2_000);
    force.unref();
  }
}

export function cancelActiveCognitiveCliInvocations(): void {
  for (const cancel of [...activeCognitiveCliInvocations]) cancel();
}

export function activeCognitiveCliInvocationCount(): number {
  return activeCognitiveCliInvocations.size;
}

export function signalCognitiveCliShutdown(): void {
  cognitiveShutdownRequested = true;
  (process.emit as unknown as (event: string) => boolean)(cognitiveShutdownEvent);
  terminateActiveCognitiveCliProcesses();
  cognitiveShutdownChannel.postMessage({ type: 'shutdown' });
}

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
    args = ['--mode', 'plan', '--sandbox', '--disable-slash-commands', '--print-timeout', '5m', ...selectedModel, '--print'];
  } else {
    throw new Error(`${family || agentCli} does not expose a safe headless cognitive mode.`);
  }
  return { command: agentCli, args, stdin, cwd, env: cognitiveCliEnvironment(), shell: false };
}

export function cognitiveCliEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries({
    ...desktopSessionEnvironment(),
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

export function runCognitiveCliInvocation(invocation: CognitiveCliInvocation, registerCancel: (cancel?: () => void) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    if (cognitiveShutdownRequested) { reject(new Error('Local Agent CLI cognitive call was cancelled.')); return; }
    const started = performance.now();
    recordCurrentDiagnosticStage('model.cli.spawn', 'start');
    let schemaDirectory: string | undefined;
    let schemaFile: string | undefined;
    const args = [...invocation.args];
    const retireSchema = () => {
      if (schemaFile && fs.existsSync(schemaFile)) fs.unlinkSync(schemaFile);
      if (schemaDirectory) fs.rmdirSync(schemaDirectory);
      schemaFile = undefined; schemaDirectory = undefined;
    };
    try {
      if (invocation.outputSchema && getAgentCliFamily(invocation.command) === 'codex') {
        schemaDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-cognitive-schema-'));
        schemaFile = path.join(schemaDirectory, 'judgment.json');
        fs.writeFileSync(schemaFile, JSON.stringify(invocation.outputSchema), { mode: 0o600, flag: 'wx' });
        args.push('--output-schema', schemaFile);
      }
    } catch (error) { retireSchema(); reject(error); return; }
    const child = (() => { try { return childProcess.spawn(invocation.command, args, {
      cwd: invocation.cwd,
      env: invocation.env || cognitiveCliEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    }); } catch (error) { retireSchema(); throw error; } })();
    if (child.pid) {
      activeCognitiveCliPids.add(child.pid);
      cognitiveShutdownChannel.postMessage({ type: 'active', pid: child.pid });
    }
    let stdout = '';
    let stderr = '';
    let stderrTail = '';
    let stderrTruncated = false;
    let stdoutBytes = 0; let stderrBytes = 0;
    const timeoutMs = invocation.timeoutMs || 60_000;
    child.once('spawn', () => recordCurrentDiagnosticStage('model.cli.spawn', 'ok', performance.now() - started, undefined, { pid: child.pid, timeoutMs }));
    let settled = false;
    let terminationError: Error | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let cancelInvocation: () => void = () => {};
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (child.pid) {
        activeCognitiveCliPids.delete(child.pid);
        cognitiveShutdownChannel.postMessage({ type: 'inactive', pid: child.pid });
      }
      activeCognitiveCliInvocations.delete(cancelInvocation);
      process.off(cognitiveShutdownEvent, cancelInvocation);
      registerCancel(undefined);
      try { retireSchema(); } catch (error) { reject(error); return; }
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
    cancelInvocation = () => terminate(new Error('Local Agent CLI cognitive call was cancelled.'));
    activeCognitiveCliInvocations.add(cancelInvocation);
    process.on(cognitiveShutdownEvent, cancelInvocation);
    registerCancel(cancelInvocation);
    const timer = setTimeout(() => {
      recordCurrentDiagnosticStage('model.cli.timeout', 'error', performance.now() - started, new Error('timeout'), { pid: child.pid, timeoutMs });
      terminate(new Error('Local Agent CLI cognitive call timed out.'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      const text = String(chunk);
      if (stdoutBytes === 0) recordCurrentDiagnosticStage('model.cli.first_output', 'ok', performance.now() - started, undefined, { pid: child.pid });
      stdoutBytes += Buffer.byteLength(text);
      if (invocation.maxOutputCharacters !== undefined && stdout.length + text.length > invocation.maxOutputCharacters) {
        terminate(new Error(`Local Agent CLI exceeded its ${invocation.maxOutputCharacters}-character output budget.`));
        return;
      }
      stdout += text;
    });
    child.stderr.on('data', chunk => {
      const text = String(chunk);
      stderrBytes += Buffer.byteLength(text);
      if (!stderrTruncated) {
        const combined = stderr + text;
        if (combined.length <= 8_192) stderr = combined;
        else {
          stderrTruncated = true;
          stderr = combined.slice(0, 4_096);
          stderrTail = combined.slice(-4_096);
        }
      } else stderrTail = (stderrTail + text).slice(-4_096);
    });
    child.once('error', error => { recordCurrentDiagnosticStage('model.cli.spawn', 'error', performance.now() - started, error); finish(() => reject(error)); });
    child.once('close', (code, signal) => {
      recordCurrentDiagnosticStage('model.cli.exit', code === 0 && !terminationError ? 'ok' : 'error', performance.now() - started, terminationError || (code === 0 ? undefined : new Error(`process exited (${code})`)), { pid: child.pid, exitCode: code, signal, stdoutBytes, stderrBytes });
      const diagnosticStderr = stderrTruncated
        ? `${stderr}\n...[stderr truncated; ${stderrBytes} bytes total]...\n${stderrTail}`
        : stderr;
      finish(() => terminationError
      ? reject(terminationError)
      : code === 0
        ? resolve(stdout.trim())
        : reject(new Error(`Local Agent CLI cognitive call failed (${code ?? 'unknown'}): ${diagnosticStderr.trim()}`)));
    });
    child.stdin.end(invocation.stdin);
  });
}

export function buildCognitiveDecisionPrompt(input: CognitiveShadowInput): string {
  return [
    '你是 SoloMap 今日安排的只读决策器。',
    '只能从候选中选择今天最值得先推进的一项。不要调用工具，不要读取文件，不要执行任务。',
    '只输出一行合法 JSON：{"candidateId":"候选 ID","reason":"给最终用户的一句简短理由"}',
    JSON.stringify(input.candidates)
  ].join('\n');
}

export function parseCognitiveDecisionProposal(value: string): CognitiveShadowProposal {
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
    this.runner = options.runner || ((invocation) => runCognitiveCliInvocation(invocation, cancel => { this.cancelActive = cancel; }));
    this.id = `agent-cli:${getAgentCliFamily(this.agentCli)}:${this.model}:${String(options.configRevision || 'unversioned')}`;
  }

  public async plan(input: CognitiveShadowInput): Promise<CognitiveShadowProposal> {
    if (this.workingDirectory) fs.mkdirSync(this.workingDirectory, { recursive: true });
    const invocation = buildCognitiveCliInvocation(this.agentCli, this.model, buildCognitiveDecisionPrompt(input), this.workingDirectory);
    const proposal = parseCognitiveDecisionProposal(await this.runner(invocation));
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
