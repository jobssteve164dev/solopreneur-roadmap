import { buildWorkHabitStats, getTrustedWorkDurationMs, WorkHabitStats } from './workHabits';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';

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
  workHabits: WorkHabitStats;
}

interface InvestmentRun {
  runKind: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

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
    focusScore: 0,
    workHabits: buildWorkHabitStats([], now)
  };
}

function normalizeRunKind(value: unknown): string {
  const kind = String(value || '').trim();
  return kind || 'step';
}

function isInvestmentRun(kind: string): boolean {
  return /^(step|step_continue|solo|solo_continue|roadmap_revision)$/.test(kind);
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
    const durationMs = getTrustedWorkDurationMs(run) ?? 0;
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
  stats.workHabits = buildWorkHabitStats(runs, now);
  stats.latestRunAt = latestRunAtMs ? new Date(latestRunAtMs).toISOString() : '';
  stats.averageRunDurationMs = stats.workHabits.observedSessionCount > 0
    ? Math.round(stats.totalDurationMs / stats.workHabits.observedSessionCount)
    : 0;

  const recentMinutes = stats.recentDurationMs / 60000;
  const totalMinutes = stats.totalDurationMs / 60000;
  const recencyBoost = latestRunAtMs ? Math.max(0, 20 - Math.floor((nowMs - latestRunAtMs) / (24 * 60 * 60 * 1000))) : 0;
  stats.investmentScore = Math.min(60, Math.round(totalMinutes / 20)) + Math.min(40, runCount * 4);
  stats.momentumScore = Math.min(70, Math.round(recentMinutes / 10)) + Math.min(30, recencyBoost);
  stats.focusScore = Math.min(100, Math.round(stats.investmentScore * 0.45 + stats.momentumScore * 0.55));
  return stats;
}

export async function readProjectInvestmentStatsFromDatabase(projectPath: string, extensionPath: string, now = new Date(), globalDataPath = ''): Promise<ProjectInvestmentStats> {
  if (!projectPath) {
    return emptyProjectInvestmentStats(now);
  }
  const root = normalizeGlobalDataPathForExtension(globalDataPath, projectPath);
  const runs = await sendRuntimeDataRequest<InvestmentRun[]>(root, { operation: 'read_project_investment_runs', input: { root: projectPath } });
  return buildProjectInvestmentStatsFromRuns(runs, now);
}
