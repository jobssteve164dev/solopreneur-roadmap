import * as childProcess from 'child_process';

export interface AgentQuotaWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number;
}

export interface AgentCreditStatus {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string;
}

export interface AgentAccountStatus {
  family: string;
  state: 'ready' | 'signed_out' | 'in_cli' | 'provider_managed' | 'unavailable' | 'error';
  plan?: string;
  usage?: AgentQuotaWindow[];
  credits?: AgentCreditStatus;
  usageHint?: string;
}

interface AgentStatusTarget {
  family: string;
  command: string;
  installed: boolean;
}

interface CodexAccountSnapshot {
  account?: Record<string, unknown>;
  rateLimits?: Record<string, unknown>;
}

interface AgentAccountReadOptions {
  readCodex?: (command: string) => Promise<CodexAccountSnapshot>;
  runJson?: (command: string, args: string[]) => Promise<unknown>;
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  env.NO_COLOR = '1';
  return env;
}

function terminateChild(child: childProcess.ChildProcess): void {
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const forceTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* Process already ended. */ }
    }
  }, 250);
  forceTimer.unref?.();
}

function runJsonCommand(command: string, args: string[], timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      env: commandEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      terminateChild(child);
      finish(new Error('Agent account status timed out.'));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 262144) {
        terminateChild(child);
        finish(new Error('Agent account status output was too large.'));
      }
    });
    child.stderr.resume();
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (settled) return;
      try {
        finish(undefined, JSON.parse(stdout));
      } catch {
        finish(new Error(code === 0
          ? 'Agent account status returned invalid JSON.'
          : 'Agent account status command failed.'));
      }
    });
  });
}

function readCodexAccount(command: string, timeoutMs = 7000): Promise<CodexAccountSnapshot> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, ['app-server', '--listen', 'stdio://'], {
      env: commandEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let buffer = '';
    let settled = false;
    let account: Record<string, unknown> | undefined;
    let rateLimits: Record<string, unknown> | undefined;
    const send = (id: number, method: string, params: Record<string, unknown> = {}) => {
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminateChild(child);
      if (error) reject(error);
      else resolve({ account, rateLimits });
    };
    const timer = setTimeout(() => finish(new Error('Codex account status timed out.')), timeoutMs);
    timer.unref?.();
    child.on('error', (error) => finish(error));
    child.stderr.resume();
    child.on('close', () => {
      if (!settled) finish(new Error('Codex account status ended before responding.'));
    });
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      if (buffer.length > 524288) {
        finish(new Error('Codex account status output was too large.'));
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          newline = buffer.indexOf('\n');
          continue;
        }
        if (message.id === 1 && message.result) {
          send(2, 'account/read', { refreshToken: false });
          send(3, 'account/rateLimits/read');
        } else if (message.id === 2) {
          account = message.result?.account || message.result || {};
        } else if (message.id === 3) {
          rateLimits = message.result || {};
        }
        if (account && rateLimits) finish();
        newline = buffer.indexOf('\n');
      }
    });
    child.on('spawn', () => {
      send(1, 'initialize', {
        clientInfo: { name: 'solomap', title: 'SoloMap', version: '1' },
        capabilities: {}
      });
    });
  });
}

function titleCasePlan(value: unknown): string {
  const plan = typeof value === 'string' ? value.trim() : '';
  if (!plan) return '';
  return plan
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.length <= 2 ? part.toUpperCase() : `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function quotaWindow(value: unknown): AgentQuotaWindow | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const usedPercent = finiteNumber(source.usedPercent);
  const windowMinutes = finiteNumber(source.windowDurationMins);
  const resetsAt = finiteNumber(source.resetsAt);
  if (usedPercent === null || windowMinutes === null || resetsAt === null) return null;
  return { usedPercent, windowMinutes, resetsAt };
}

function parseCodexStatus(snapshot: CodexAccountSnapshot): AgentAccountStatus {
  const account = snapshot.account || {};
  if (!Object.keys(account).length) return { family: 'codex', state: 'signed_out' };
  const root = snapshot.rateLimits || {};
  const limits = root.rateLimits && typeof root.rateLimits === 'object'
    ? root.rateLimits as Record<string, unknown>
    : {};
  const usage = [quotaWindow(limits.primary), quotaWindow(limits.secondary)]
    .filter((item): item is AgentQuotaWindow => Boolean(item));
  const rawCredits = limits.credits && typeof limits.credits === 'object'
    ? limits.credits as Record<string, unknown>
    : null;
  const credits = rawCredits ? {
    hasCredits: Boolean(rawCredits.hasCredits),
    unlimited: Boolean(rawCredits.unlimited),
    balance: typeof rawCredits.balance === 'string' ? rawCredits.balance : ''
  } : undefined;
  const plan = titleCasePlan(account.planType || limits.planType || (account.type === 'apiKey' ? 'API' : ''));
  return {
    family: 'codex',
    state: 'ready',
    ...(plan ? { plan } : {}),
    ...(usage.length ? { usage } : {}),
    ...(credits ? { credits } : {})
  };
}

function cursorPlan(value: unknown): string {
  if (typeof value === 'string') return titleCasePlan(value);
  if (!value || typeof value !== 'object') return '';
  const source = value as Record<string, unknown>;
  return titleCasePlan(source.label || source.name || source.tier || source.plan);
}

async function readOneAgentStatus(
  agent: AgentStatusTarget,
  options: Required<AgentAccountReadOptions>
): Promise<AgentAccountStatus> {
  if (agent.family === 'codex') return parseCodexStatus(await options.readCodex(agent.command));
  if (agent.family === 'cursor') {
    const [authRaw, aboutRaw] = await Promise.all([
      options.runJson(agent.command, ['status', '--format', 'json']),
      options.runJson(agent.command, ['about', '--format', 'json'])
    ]);
    const auth = authRaw && typeof authRaw === 'object' ? authRaw as Record<string, unknown> : {};
    if (!auth.isAuthenticated) return { family: agent.family, state: 'signed_out' };
    const about = aboutRaw && typeof aboutRaw === 'object' ? aboutRaw as Record<string, unknown> : {};
    const plan = cursorPlan(about.subscriptionTier);
    return { family: agent.family, state: 'ready', ...(plan ? { plan } : {}) };
  }
  if (agent.family === 'claude') {
    const raw = await options.runJson(agent.command, ['auth', 'status', '--json']);
    const auth = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return auth.loggedIn
      ? { family: agent.family, state: 'ready', usageHint: '/status' }
      : { family: agent.family, state: 'signed_out' };
  }
  if (agent.family === 'antigravity') {
    return { family: agent.family, state: 'in_cli', usageHint: '/usage · /credits' };
  }
  if (agent.family === 'copilot') {
    return { family: agent.family, state: 'in_cli', usageHint: '/clikit quota' };
  }
  if (agent.family === 'opencode') return { family: agent.family, state: 'provider_managed' };
  return { family: agent.family, state: 'unavailable' };
}

export async function readAgentAccountStatuses(
  agents: AgentStatusTarget[],
  overrides: AgentAccountReadOptions = {}
): Promise<AgentAccountStatus[]> {
  const options: Required<AgentAccountReadOptions> = {
    readCodex: overrides.readCodex || readCodexAccount,
    runJson: overrides.runJson || runJsonCommand
  };
  return Promise.all(agents.filter((agent) => agent.installed && agent.command).map(async (agent) => {
    try {
      return await readOneAgentStatus(agent, options);
    } catch {
      return { family: agent.family, state: 'error' } as AgentAccountStatus;
    }
  }));
}
