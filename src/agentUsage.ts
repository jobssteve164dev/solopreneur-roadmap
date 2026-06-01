import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface AgentUsageProject {
  name: string;
  path: string;
}

export interface AgentUsageSummary {
  todayRuns: number;
  weekRuns: number;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  latestRunAt: string;
  byAgent: Array<{
    agent: string;
    todayRuns: number;
    weekRuns: number;
    totalRuns: number;
  }>;
}

export interface AgentQuotaInfo {
  family: string;
  label: string;
  command: string;
  available: boolean;
  quotaReadable: boolean;
  status: 'ready' | 'unknown' | 'missing';
  message: string;
  detail: string;
  checkedAt: string;
}

export interface AgentUsageStatus {
  usage: AgentUsageSummary;
  quotas: AgentQuotaInfo[];
}

const commandResolutionCache = new Map<string, string>();

function expandHomePath(value: string): string {
  const trimmed = String(value || '').trim();
  if (trimmed === '~') {
    return process.env.HOME || trimmed;
  }
  if (trimmed.startsWith('~/')) {
    return path.join(process.env.HOME || '~', trimmed.slice(2));
  }
  return trimmed;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCommandOnSearchPath(command: string): string {
  const trimmed = String(command || '').trim();
  if (!trimmed) {
    return '';
  }
  const cached = commandResolutionCache.get(trimmed);
  if (cached !== undefined) {
    return cached;
  }
  const expanded = expandHomePath(trimmed);
  if (path.isAbsolute(expanded) || expanded.includes(path.sep)) {
    const resolved = isExecutableFile(expanded) ? expanded : '';
    commandResolutionCache.set(trimmed, resolved);
    return resolved;
  }
  const home = process.env.HOME || '';
  const searchPaths = [
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    home ? path.join(home, '.local', 'bin') : '',
    home ? path.join(home, 'bin') : '',
    home ? path.join(home, '.npm-global', 'bin') : '',
    home ? path.join(home, '.bun', 'bin') : '',
    home ? path.join(home, '.cargo', 'bin') : ''
  ].filter(Boolean).filter((candidate, index, all) => all.indexOf(candidate) === index);
  for (const dir of searchPaths) {
    const candidate = path.join(dir, expanded);
    if (isExecutableFile(candidate)) {
      commandResolutionCache.set(trimmed, candidate);
      return candidate;
    }
  }
  commandResolutionCache.set(trimmed, '');
  return '';
}

function getKnownAgentCliCandidates(family: string): string[] {
  if (family === 'codex') return ['codex', 'codex-cli'];
  if (family === 'claude') return ['claude', 'claude-code', 'claude-code-cli'];
  if (family === 'cursor') return ['cursor', 'cursor-cli'];
  if (family === 'copilot') return ['copilot', 'copilot-cli'];
  if (family === 'opencode') return ['opencode', 'open-code', 'open-code-cli'];
  if (family === 'agy' || family === 'antigravity') return ['agy', 'antigravity', 'antigravity-cli'];
  return family ? [family] : [];
}

function getAgentFamily(command: string): string {
  const name = path.basename((command || '').trim()).toLowerCase();
  if (['codex', 'codex-cli'].includes(name)) return 'codex';
  if (['claude', 'claude-code', 'claude-code-cli'].includes(name)) return 'claude';
  if (['cursor', 'cursor-cli'].includes(name)) return 'cursor';
  if (['copilot', 'copilot-cli'].includes(name)) return 'copilot';
  if (['opencode', 'open-code', 'open-code-cli'].includes(name)) return 'opencode';
  if (['agy', 'antigravity', 'antigravity-cli'].includes(name)) return 'agy';
  return name || 'unknown';
}

function resolveFamilyCommand(family: string, configuredCli = ''): string {
  const configuredFamily = getAgentFamily(configuredCli);
  const candidates = [
    ...(configuredFamily === family ? [configuredCli] : []),
    ...getKnownAgentCliCandidates(family)
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = resolveCommandOnSearchPath(candidate);
    if (resolved) {
      return resolved;
    }
  }
  return '';
}

function readFileIfExists(filePath: string): string {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch {
    return '';
  }
}

function getRunTimestamp(runDir: string): number {
  const startedAtPath = path.join(runDir, 'started_at');
  const startedAt = readFileIfExists(startedAtPath).trim();
  const parsed = startedAt ? Date.parse(startedAt) : NaN;
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  try {
    return fs.statSync(runDir).mtimeMs;
  } catch {
    return 0;
  }
}

function inferAgentFromCommand(command: string): string {
  const lower = String(command || '').toLowerCase();
  if (/\bcodex(?:-cli)?\b/.test(lower)) return 'codex';
  if (/\bclaude(?:-code|-code-cli)?\b/.test(lower)) return 'claude';
  if (/\bcursor(?:-cli)?\b/.test(lower)) return 'cursor';
  if (/\bcopilot(?:-cli)?\b/.test(lower)) return 'copilot';
  if (/\b(?:opencode|open-code|open-code-cli)\b/.test(lower)) return 'opencode';
  if (/\b(?:agy|antigravity|antigravity-cli)\b/.test(lower)) return 'agy';
  return 'unknown';
}

function inferRunStatus(runDir: string): 'completed' | 'failed' | 'unknown' {
  const completionPath = path.join(runDir, 'completion.json');
  if (fs.existsSync(completionPath)) {
    try {
      const completion = JSON.parse(fs.readFileSync(completionPath, 'utf8'));
      if (completion?.markCompleted === true) {
        return 'completed';
      }
      if (completion?.markCompleted === false || completion?.failureReason || completion?.failureCode) {
        return 'failed';
      }
    } catch {
      return 'unknown';
    }
  }
  const output = readFileIfExists(path.join(runDir, 'output.log'));
  if (/Failure category:|Failure reason:|Agent CLI exited before completing/i.test(output)) {
    return 'failed';
  }
  return 'unknown';
}

export function buildAgentUsageSummary(projects: AgentUsageProject[], now = new Date()): AgentUsageSummary {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const weekStartMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const byAgent = new Map<string, { agent: string; todayRuns: number; weekRuns: number; totalRuns: number }>();
  let todayRuns = 0;
  let weekRuns = 0;
  let totalRuns = 0;
  let completedRuns = 0;
  let failedRuns = 0;
  let latestRunAt = 0;

  for (const project of projects) {
    const runsRoot = path.join(project.path, '.solopreneur', 'agent-runs');
    let runNames: string[] = [];
    try {
      runNames = fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot) : [];
    } catch {
      runNames = [];
    }
    for (const runName of runNames) {
      const runDir = path.join(runsRoot, runName);
      try {
        if (!fs.statSync(runDir).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
      const timestamp = getRunTimestamp(runDir);
      const command = readFileIfExists(path.join(runDir, 'command.txt'));
      const agent = inferAgentFromCommand(command);
      const agentStats = byAgent.get(agent) || { agent, todayRuns: 0, weekRuns: 0, totalRuns: 0 };
      totalRuns += 1;
      agentStats.totalRuns += 1;
      if (timestamp >= todayStart.getTime()) {
        todayRuns += 1;
        agentStats.todayRuns += 1;
      }
      if (timestamp >= weekStartMs) {
        weekRuns += 1;
        agentStats.weekRuns += 1;
      }
      latestRunAt = Math.max(latestRunAt, timestamp);
      const status = inferRunStatus(runDir);
      if (status === 'completed') {
        completedRuns += 1;
      } else if (status === 'failed') {
        failedRuns += 1;
      }
      byAgent.set(agent, agentStats);
    }
  }

  return {
    todayRuns,
    weekRuns,
    totalRuns,
    completedRuns,
    failedRuns,
    latestRunAt: latestRunAt ? new Date(latestRunAt).toISOString() : '',
    byAgent: [...byAgent.values()].sort((a, b) => b.weekRuns - a.weekRuns || b.totalRuns - a.totalRuns || a.agent.localeCompare(b.agent))
  };
}

function runProcessAsync(command: string, args: string[], timeout = 4500): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = childProcess.spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      resolve({ ok: false, stdout, stderr: stderr || `Timed out after ${timeout}ms` });
    }, timeout);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: String(error.message || error) });
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

function quotaCommandsForFamily(family: string): string[][] {
  if (family === 'codex') return [['login', 'status'], ['doctor']];
  if (family === 'copilot') return [['auth', 'status'], ['--version']];
  if (family === 'claude') return [['status'], ['--version']];
  if (family === 'opencode') return [['auth', 'status'], ['--version']];
  if (family === 'cursor') return [['--version']];
  if (family === 'agy') return [['--version']];
  return [['--version']];
}

function extractQuotaDetail(output: string): string {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const quotaLines = lines.filter((line) => /(remaining|left|quota|limit|usage|used|reset|allowance|剩余|额度|限制|重置)/i.test(line));
  return quotaLines.slice(0, 3).join(' · ');
}

async function queryQuotaForFamily(family: string, configuredCli = ''): Promise<AgentQuotaInfo> {
  const command = resolveFamilyCommand(family, configuredCli);
  const checkedAt = new Date().toISOString();
  if (!command) {
    return {
      family,
      label: family,
      command: '',
      available: false,
      quotaReadable: false,
      status: 'missing',
      message: 'CLI not found',
      detail: '',
      checkedAt
    };
  }

  for (const args of quotaCommandsForFamily(family)) {
    const result = await runProcessAsync(command, args, 4500);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (!result.ok && args[0] !== '--version') {
      continue;
    }
    const detail = extractQuotaDetail(output);
    return {
      family,
      label: family,
      command: path.basename(command),
      available: true,
      quotaReadable: Boolean(detail),
      status: detail ? 'ready' : 'unknown',
      message: detail ? 'Quota signal available' : 'CLI available; readable quota not exposed',
      detail,
      checkedAt
    };
  }

  return {
    family,
    label: family,
    command: path.basename(command),
    available: true,
    quotaReadable: false,
    status: 'unknown',
    message: 'CLI available; quota check did not return readable usage',
    detail: '',
    checkedAt
  };
}

export async function getAgentUsageStatus(projects: AgentUsageProject[], configuredCli = ''): Promise<AgentUsageStatus> {
  const families = ['agy', 'codex', 'cursor', 'copilot', 'claude', 'opencode'];
  const usage = buildAgentUsageSummary(projects);
  const quotas = await Promise.all(families.map((family) => queryQuotaForFamily(family, configuredCli)));
  return { usage, quotas };
}
