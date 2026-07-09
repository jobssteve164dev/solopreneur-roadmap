import * as fs from 'fs';
import * as path from 'path';
import { SqliteStore } from './db/sqliteStore';
import { RunIndexEntry } from './db/types';
import { backfillRunIndexFromDigests } from './runIndexMaintenance';

export interface ProjectInvestmentStats {
  schemaVersion: number;
  generatedAt: string;
  taskRunCount: number;
  soloConversationCount: number;
  completedRunCount: number;
  failedRunCount: number;
  totalDurationMs: number;
  recentDurationMs: number;
  averageRunDurationMs: number;
  latestRunAt: string;
  investmentScore: number;
  momentumScore: number;
  focusScore: number;
}

interface CachedProjectInvestment {
  signature: string;
  generatedAtMs: number;
  stats: ProjectInvestmentStats;
}

interface InvestmentRun {
  runKind: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

const projectInvestmentCache = new Map<string, CachedProjectInvestment>();
const cacheTtlMs = 30 * 1000;
const recentWindowMs = 14 * 24 * 60 * 60 * 1000;

function emptyProjectInvestmentStats(now = new Date()): ProjectInvestmentStats {
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    taskRunCount: 0,
    soloConversationCount: 0,
    completedRunCount: 0,
    failedRunCount: 0,
    totalDurationMs: 0,
    recentDurationMs: 0,
    averageRunDurationMs: 0,
    latestRunAt: '',
    investmentScore: 0,
    momentumScore: 0,
    focusScore: 0
  };
}

function statSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${filePath}:${Math.round(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return `${filePath}:missing`;
  }
}

function directoryChildrenSignature(dirPath: string, maxChildren = 80): string {
  try {
    if (!fs.existsSync(dirPath)) {
      return `${dirPath}:missing`;
    }
    const entries = fs.readdirSync(dirPath)
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .slice(0, maxChildren);
    return [
      statSignature(dirPath),
      ...entries.map((entry) => statSignature(path.join(dirPath, entry)))
    ].join('|');
  } catch {
    return `${dirPath}:unavailable`;
  }
}

function getProjectInvestmentSignature(projectPath: string): string {
  const solopreneurRoot = path.join(projectPath, '.solopreneur');
  return [
    statSignature(path.join(solopreneurRoot, 'roadmap.csv')),
    statSignature(path.join(solopreneurRoot, 'project_journal.db')),
    directoryChildrenSignature(path.join(solopreneurRoot, 'run-digests')),
    directoryChildrenSignature(path.join(solopreneurRoot, 'agent-runs'))
  ].join('::');
}

function readText(filePath: string): string {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch {
    return '';
  }
}

function readTextTail(filePath: string, maxBytes = 64 * 1024): string {
  let fd: number | null = null;
  try {
    if (!fs.existsSync(filePath)) {
      return '';
    }
    const stat = fs.statSync(filePath);
    const length = Math.min(Math.max(0, stat.size), maxBytes);
    if (length <= 0) {
      return '';
    }
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function readJson(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeRunKind(value: unknown): string {
  const kind = String(value || '').trim();
  return kind || 'step';
}

function isInvestmentRun(kind: string): boolean {
  return /^(step|step_continue|solo|solo_continue|roadmap_revision)$/.test(kind);
}

function readRunsFromDigests(projectPath: string): InvestmentRun[] {
  const digestRoot = path.join(projectPath, '.solopreneur', 'run-digests');
  if (!fs.existsSync(digestRoot)) {
    return [];
  }
  let files: string[] = [];
  try {
    files = fs.readdirSync(digestRoot).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
  return files.map((file) => {
    const digest = readJson(path.join(digestRoot, file));
    if (!digest || typeof digest !== 'object') {
      return null;
    }
    const runKind = normalizeRunKind(digest.runKind);
    if (!isInvestmentRun(runKind)) {
      return null;
    }
    return {
      runKind,
      status: String(digest.status || ''),
      startedAt: String(digest.startedAt || ''),
      finishedAt: String(digest.finishedAt || digest.startedAt || ''),
      durationMs: Math.max(0, Number(digest.durationMs || 0))
    };
  }).filter((run): run is InvestmentRun => Boolean(run));
}

function readRunsFromRunIndexEntries(entries: RunIndexEntry[]): InvestmentRun[] {
  return entries.map((entry) => {
    const runKind = normalizeRunKind(entry.runKind);
    if (!isInvestmentRun(runKind)) {
      return null;
    }
    return {
      runKind,
      status: String(entry.status || ''),
      startedAt: String(entry.startedAt || ''),
      finishedAt: String(entry.finishedAt || entry.startedAt || ''),
      durationMs: Math.max(0, Number(entry.durationMs || 0))
    };
  }).filter((run): run is InvestmentRun => Boolean(run));
}

async function readRunsFromRunIndex(projectPath: string, extensionPath: string): Promise<InvestmentRun[]> {
  const dbPath = path.join(projectPath, '.solopreneur', 'project_journal.db');
  await backfillRunIndexFromDigests(projectPath, extensionPath);
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  const store = new SqliteStore(dbPath, extensionPath);
  try {
    await store.init();
    return readRunsFromRunIndexEntries(store.getRunIndexEntries());
  } catch {
    return [];
  } finally {
    store.close();
  }
}

function isAgentRunDir(runDir: string): boolean {
  return [
    'command.txt',
    'output.log',
    'completion.json',
    'touched-files.txt',
    'changes.txt',
    'prompt.txt'
  ].some((name) => fs.existsSync(path.join(runDir, name)));
}

function listAgentRunDirs(runsRoot: string): string[] {
  const result: string[] = [];
  const visit = (dir: string) => {
    let entries: string[] = [];
    try {
      entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    } catch {
      return;
    }
    if (isAgentRunDir(dir)) {
      result.push(dir);
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(dir, entry);
      try {
        if (fs.statSync(candidate).isDirectory()) {
          visit(candidate);
        }
      } catch {}
    }
  };
  visit(runsRoot);
  return result;
}

function readRunTimestamp(runDir: string): string {
  const startedAt = readText(path.join(runDir, 'started_at')).trim();
  if (startedAt && Number.isFinite(Date.parse(startedAt))) {
    return startedAt;
  }
  try {
    return new Date(fs.statSync(runDir).mtimeMs).toISOString();
  } catch {
    return '';
  }
}

function inferRunDurationMs(runDir: string, startedAt: string): number {
  const output = readTextTail(path.join(runDir, 'output.log'));
  const storedDuration = output.match(/Run duration ms:\s*(\d+)/);
  if (storedDuration) {
    return Math.max(0, Number(storedDuration[1] || 0));
  }
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) {
    return 0;
  }
  const latestMtime = [
    'completion.json',
    'touched-files.txt',
    'changes.txt',
    'output.log',
    'session.json'
  ].reduce((latest, file) => {
    try {
      const candidate = path.join(runDir, file);
      return fs.existsSync(candidate) ? Math.max(latest, fs.statSync(candidate).mtimeMs) : latest;
    } catch {
      return latest;
    }
  }, startedMs);
  return Math.max(0, latestMtime - startedMs);
}

function inferRunStatus(runDir: string): string {
  const completion = readJson(path.join(runDir, 'completion.json'));
  if (completion && typeof completion === 'object') {
    if (completion.markCompleted === true) {
      return 'Completed';
    }
    if (completion.markCompleted === false || completion.failureReason || completion.failureCode) {
      return 'Failed';
    }
  }
  const output = readTextTail(path.join(runDir, 'output.log'));
  if (/Failure category:|Failure reason:|Agent CLI exited before completing/i.test(output)) {
    return 'Failed';
  }
  if (/Run finished at:|Sentinel captured state:|Agent output tail:/i.test(output)) {
    return 'Completed';
  }
  return '';
}

function readRunsFromAgentDirs(projectPath: string): InvestmentRun[] {
  const runsRoot = path.join(projectPath, '.solopreneur', 'agent-runs');
  return listAgentRunDirs(runsRoot).map((runDir) => {
    const relative = path.relative(runsRoot, runDir).replace(/\\/g, '/');
    const runKind = relative.startsWith('__solo__/') ? 'solo' : relative.startsWith('__roadmap_revision__/') ? 'roadmap_revision' : 'step';
    const startedAt = readRunTimestamp(runDir);
    return {
      runKind,
      status: inferRunStatus(runDir),
      startedAt,
      finishedAt: startedAt,
      durationMs: inferRunDurationMs(runDir, startedAt)
    };
  });
}

function buildProjectInvestmentStatsFromRuns(runs: InvestmentRun[], now: Date): ProjectInvestmentStats {
  const stats = emptyProjectInvestmentStats(now);
  const nowMs = now.getTime();
  let latestRunAtMs = 0;
  for (const run of runs) {
    const kind = normalizeRunKind(run.runKind);
    if (!isInvestmentRun(kind)) {
      continue;
    }
    if (kind === 'solo' || kind === 'solo_continue') {
      stats.soloConversationCount += 1;
    } else {
      stats.taskRunCount += 1;
    }
    if (run.status === 'Completed') {
      stats.completedRunCount += 1;
    }
    if (run.status === 'Failed') {
      stats.failedRunCount += 1;
    }
    const durationMs = Math.max(0, Number(run.durationMs || 0));
    stats.totalDurationMs += durationMs;
    const timestamp = Date.parse(run.finishedAt || run.startedAt || '');
    if (Number.isFinite(timestamp)) {
      latestRunAtMs = Math.max(latestRunAtMs, timestamp);
      if (nowMs - timestamp <= recentWindowMs) {
        stats.recentDurationMs += durationMs;
      }
    }
  }
  const runCount = stats.taskRunCount + stats.soloConversationCount;
  stats.latestRunAt = latestRunAtMs ? new Date(latestRunAtMs).toISOString() : '';
  stats.averageRunDurationMs = runCount > 0 ? Math.round(stats.totalDurationMs / runCount) : 0;

  const recentMinutes = stats.recentDurationMs / 60000;
  const totalMinutes = stats.totalDurationMs / 60000;
  const recencyBoost = latestRunAtMs ? Math.max(0, 20 - Math.floor((nowMs - latestRunAtMs) / (24 * 60 * 60 * 1000))) : 0;
  stats.investmentScore = Math.min(60, Math.round(totalMinutes / 20)) + Math.min(40, runCount * 4);
  stats.momentumScore = Math.min(70, Math.round(recentMinutes / 10)) + Math.min(30, recencyBoost);
  stats.focusScore = Math.min(100, Math.round(stats.investmentScore * 0.45 + stats.momentumScore * 0.55));
  return stats;
}

export function clearProjectInvestmentCache(projectPath?: string): void {
  if (projectPath) {
    projectInvestmentCache.delete(projectPath);
    projectInvestmentCache.delete(`db:${projectPath}`);
    return;
  }
  projectInvestmentCache.clear();
}

export function readProjectInvestmentStats(projectPath: string, now = new Date()): ProjectInvestmentStats {
  if (!projectPath) {
    return emptyProjectInvestmentStats(now);
  }
  const signature = getProjectInvestmentSignature(projectPath);
  const cached = projectInvestmentCache.get(projectPath);
  const nowMs = now.getTime();
  if (cached && cached.signature === signature && nowMs - cached.generatedAtMs <= cacheTtlMs) {
    return cached.stats;
  }
  const digestRuns = readRunsFromDigests(projectPath);
  const runs = digestRuns.length > 0 ? digestRuns : readRunsFromAgentDirs(projectPath);
  const stats = buildProjectInvestmentStatsFromRuns(runs, now);
  projectInvestmentCache.set(projectPath, {
    signature,
    generatedAtMs: nowMs,
    stats
  });
  return stats;
}

export async function readProjectInvestmentStatsFromDatabase(projectPath: string, extensionPath: string, now = new Date()): Promise<ProjectInvestmentStats> {
  if (!projectPath) {
    return emptyProjectInvestmentStats(now);
  }
  const cacheKey = `db:${projectPath}`;
  const signature = getProjectInvestmentSignature(projectPath);
  const cached = projectInvestmentCache.get(cacheKey);
  const nowMs = now.getTime();
  if (cached && cached.signature === signature && nowMs - cached.generatedAtMs <= cacheTtlMs) {
    return cached.stats;
  }
  const indexedRuns = await readRunsFromRunIndex(projectPath, extensionPath);
  const runs = indexedRuns.length > 0
    ? indexedRuns
    : (() => {
        const digestRuns = readRunsFromDigests(projectPath);
        return digestRuns.length > 0 ? digestRuns : readRunsFromAgentDirs(projectPath);
      })();
  const stats = buildProjectInvestmentStatsFromRuns(runs, now);
  projectInvestmentCache.set(cacheKey, {
    signature,
    generatedAtMs: nowMs,
    stats
  });
  return stats;
}
