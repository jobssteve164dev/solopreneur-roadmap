import * as childProcess from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface AgentQuotaWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number;
  label?: string;
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
  usageState?: 'error';
}

interface AgentStatusTarget {
  family: string;
  command: string;
  installed: boolean;
}

interface CodexAccountSnapshot {
  account?: Record<string, unknown>;
  rateLimits?: Record<string, unknown>;
  usageState?: 'error';
}

interface AgentAccountReadOptions {
  readCodex?: (command: string) => Promise<CodexAccountSnapshot>;
  runJson?: (command: string, args: string[]) => Promise<unknown>;
  onStatus?: (status: AgentAccountStatus) => void;
  readCursor?: () => Promise<CursorAccountSnapshot>;
  readAntigravity?: (command: string) => Promise<AntigravityAccountSnapshot>;
}

interface AntigravityAccountSnapshot {
  signedOut?: boolean;
  plan?: string;
  usage?: AgentQuotaWindow[];
  usageState?: 'error';
}

async function readAntigravityAccount(command: string): Promise<AntigravityAccountSnapshot> {
  let credentials;
  const tokenPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  try {
    credentials = JSON.parse(await fs.readFile(tokenPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { signedOut: true };
    throw new Error('Antigravity account credentials could not be read.');
  }
  if (Date.parse(credentials.token?.expiry) <= Date.now()) {
    // Renew through the installed CLI; never implement or persist OAuth refresh ourselves.
    await new Promise<void>((resolve, reject) => {
      childProcess.execFile(command, ['models'], { env: commandEnvironment(), timeout: 15000,
        maxBuffer: 262144, killSignal: 'SIGKILL' }, error => {
        if (error) reject(new Error('Antigravity login renewal failed.'));
        else resolve();
      });
    });
    credentials = JSON.parse(await fs.readFile(tokenPath, 'utf8'));
  }
  const token = credentials.token?.access_token;
  if (typeof token !== 'string' || !token) return { signedOut: true };
  const request = async (method: string): Promise<any> => {
    const response = await fetch(`https://daily-cloudcode-pa.googleapis.com/v1internal:${method}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'User-Agent': 'antigravity/2.0', 'X-Goog-Api-Client': 'gl-go/1.26' },
      body: JSON.stringify(method === 'loadCodeAssist' ? { metadata: { ideType: 'ANTIGRAVITY' } } : {})
    });
    if (response.status === 401) throw new Error('Antigravity signed out.');
    if (!response.ok) throw new Error('Antigravity account request failed.');
    return response.json();
  };
  const [planResult, quotaResult] = await Promise.allSettled([request('loadCodeAssist'), request('retrieveUserQuotaSummary')]);
  if ([planResult, quotaResult].some(result => result.status === 'rejected' && result.reason?.message === 'Antigravity signed out.')) {
    return { signedOut: true };
  }
  if (planResult.status === 'rejected') throw new Error('Antigravity plan could not be read.');
  const tier = planResult.value.paidTier || planResult.value.currentTier;
  const plan = typeof tier?.name === 'string' ? tier.name : undefined;
  const usage: AgentQuotaWindow[] = [];
  if (quotaResult.status === 'fulfilled' && Array.isArray(quotaResult.value.groups)) {
    for (const group of quotaResult.value.groups) {
      for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
        const fraction = typeof bucket.remainingFraction === 'number' ? bucket.remainingFraction : null;
        const resetsAt = Date.parse(bucket.resetTime) / 1000;
        const windowMinutes = bucket.window === 'weekly' ? 10080 : bucket.window === '5h' ? 300 : 0;
        if (fraction === null || !Number.isFinite(fraction) || !Number.isFinite(resetsAt) || !windowMinutes) continue;
        usage.push({ usedPercent: (1 - fraction) * 100, windowMinutes, resetsAt,
          ...(typeof group.displayName === 'string' ? { label: group.displayName } : {}) });
      }
    }
  }
  return { plan, usage, ...(!usage.length ? { usageState: 'error' as const } : {}) };
}

interface CursorAccountSnapshot {
  signedOut?: boolean;
  planInfo?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  usageState?: 'error';
}

async function readCursorAccount(): Promise<CursorAccountSnapshot> {
  const configDirectory = process.platform === 'darwin' ? path.join(os.homedir(), '.cursor')
    : process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Cursor')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'cursor');
  let credentials;
  try {
    credentials = JSON.parse(await fs.readFile(path.join(configDirectory, 'auth.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { signedOut: true };
    throw new Error('Cursor account credentials could not be read.');
  }
  if (typeof credentials.accessToken !== 'string' || !credentials.accessToken) return { signedOut: true };
  // These are the same first-party DashboardService methods used by Cursor CLI.
  const request = async (method: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${credentials.accessToken}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      body: '{}'
    });
    if (response.status === 401) throw new Error('Cursor signed out.');
    if (!response.ok) throw new Error('Cursor account request failed.');
    return await response.json() as Record<string, unknown>;
  };
  const [plan, usage] = await Promise.allSettled([request('GetPlanInfo'), request('GetCurrentPeriodUsage')]);
  if ([plan, usage].some(result => result.status === 'rejected' && result.reason?.message === 'Cursor signed out.')) {
    return { signedOut: true };
  }
  if (plan.status === 'rejected') throw new Error('Cursor plan could not be read.');
  return {
    planInfo: plan.value.planInfo as Record<string, unknown>,
    ...(usage.status === 'fulfilled' ? { usage: usage.value } : { usageState: 'error' as const })
  };
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

function readCodexAccount(command: string, timeoutMs = 30000): Promise<CodexAccountSnapshot> {
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
      else resolve({ account, rateLimits, ...(quotaFailed ? { usageState: 'error' as const } : {}) });
    };
    let quotaFailed = false;
    const timer = setTimeout(() => {
      if (account && Object.keys(account).length) {
        quotaFailed = true;
        finish();
      } else finish(new Error('Codex account status timed out.'));
    }, timeoutMs);
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
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          send(2, 'account/read', { refreshToken: false });
        } else if (message.id === 1 && message.error) {
          finish(new Error('Codex initialization failed.'));
        } else if (message.id === 2) {
          if (message.error || !message.result) {
            finish(new Error('Codex account read failed.'));
          } else {
            account = message.result.account || {};
            if (!Object.keys(account!).length || account!.type === 'apiKey') finish();
            else send(3, 'account/rateLimits/read');
          }
        } else if (message.id === 3) {
          quotaFailed = Boolean(message.error);
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
    ...(credits ? { credits } : {}),
    ...(snapshot.usageState ? { usageState: snapshot.usageState } : {})
  };
}

async function readOneAgentStatus(
  agent: AgentStatusTarget,
  options: Pick<Required<AgentAccountReadOptions>, 'readCodex' | 'runJson' | 'readCursor' | 'readAntigravity'>
): Promise<AgentAccountStatus> {
  if (agent.family === 'codex') return parseCodexStatus(await options.readCodex(agent.command));
  if (agent.family === 'cursor') {
    const snapshot = await options.readCursor();
    if (snapshot.signedOut) return { family: agent.family, state: 'signed_out' };
    const plan = titleCasePlan(snapshot.planInfo?.planName);
    const raw = snapshot.usage?.planUsage as Record<string, unknown> | undefined;
    const limit = raw ? finiteNumber(raw.limit) : null;
    const includedSpend = raw ? finiteNumber(raw.includedSpend ?? 0) : null;
    const usedPercent = raw?.totalPercentUsed === undefined
      ? limit !== null && limit > 0 && includedSpend !== null ? includedSpend / limit * 100 : null
      : finiteNumber(raw.totalPercentUsed);
    const start = finiteNumber(snapshot.usage?.billingCycleStart);
    const end = finiteNumber(snapshot.usage?.billingCycleEnd);
    // Cursor DashboardService uses epoch milliseconds for billing-cycle timestamps.
    const usage = usedPercent !== null && start !== null && end !== null && end > start
      ? [{ usedPercent, windowMinutes: (end - start) / 60000, resetsAt: end / 1000, label: 'billing' }] : [];
    return { family: agent.family, state: 'ready', ...(plan ? { plan } : {}),
      ...(usage.length ? { usage } : {}),
      ...(snapshot.usageState || !usage.length ? { usageState: 'error' as const } : {}) };
  }
  if (agent.family === 'claude') {
    const raw = await options.runJson(agent.command, ['auth', 'status', '--json']);
    const auth = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return auth.loggedIn
      ? { family: agent.family, state: 'ready', usageHint: '/status' }
      : { family: agent.family, state: 'signed_out' };
  }
  if (agent.family === 'antigravity') {
    const snapshot = await options.readAntigravity(agent.command);
    if (snapshot.signedOut) return { family: agent.family, state: 'signed_out' };
    return { family: agent.family, state: 'ready',
      ...(snapshot.plan ? { plan: snapshot.plan } : {}),
      ...(snapshot.usage?.length ? { usage: snapshot.usage } : {}),
      ...(snapshot.usageState ? { usageState: snapshot.usageState } : {}) };
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
  const options = {
    readCodex: overrides.readCodex || readCodexAccount,
    runJson: overrides.runJson || runJsonCommand,
    readCursor: overrides.readCursor || readCursorAccount,
    readAntigravity: overrides.readAntigravity || readAntigravityAccount
  };
  return Promise.all(agents.filter((agent) => agent.installed && agent.command).map(async (agent) => {
    let status: AgentAccountStatus;
    try {
      status = await readOneAgentStatus(agent, options);
    } catch {
      status = { family: agent.family, state: 'error' };
    }
    overrides.onStatus?.(status);
    return status;
  }));
}
