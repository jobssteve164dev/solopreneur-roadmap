import { RunImpactRecord } from './db/types';
import { AgentTokenUsage, normalizeTokenUsage } from './tokenUsage';
import { getTrustedWorkDurationMs } from './workHabits';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import { observeLocalDiagnosticStage } from './localDiagnostics';

export interface AgentImpactProject {
  name: string;
  path: string;
}

export interface AgentImpactSummary {
  weekRuns: number;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  totalMinutes: number;
  totalTokens: number;
  tokenRuns: number;
  changedFiles: number;
  projectProgressPercent: number;
  completedNodes: number;
  totalNodes: number;
  latestRunAt: string;
  byAgent: Array<{
    agent: string;
    runs: number;
    minutes: number;
    tokens: number;
    tokenRuns: number;
    changedFiles: number;
    latestRunAt: string;
  }>;
}

export interface AgentImpactStatus {
  impact: AgentImpactSummary;
}

interface RoadmapNodeLike {
  id: string;
  status: string;
}

export interface AgentImpactRun {
  agent: string;
  status: 'completed' | 'failed' | 'unknown';
  timestamp: number;
  minutes: number;
  tokenUsage: AgentTokenUsage;
  changedFiles: string[];
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

function normalizeRunKind(value: unknown): string {
  const kind = String(value || '').trim();
  return kind || 'step';
}

function isImpactRunKind(kind: string): boolean {
  return /^(step|step_continue|solo|solo_continue|roadmap_revision)$/.test(kind);
}

function statusFromDigest(value: unknown): 'completed' | 'failed' | 'unknown' {
  const status = String(value || '').trim();
  if (status === 'Completed' || status === 'Recorded' || status === 'In Progress') {
    return 'completed';
  }
  if (status === 'Failed') {
    return 'failed';
  }
  return 'unknown';
}

export function readRunsFromRunIndexEntries(entries: RunImpactRecord[]): AgentImpactRun[] {
  return entries.map((entry) => {
    const runKind = normalizeRunKind(entry.runKind);
    if (!isImpactRunKind(runKind)) {
      return null;
    }
    const timestamp = Date.parse(String(entry.finishedAt || entry.startedAt || ''));
    const tokenUsage = normalizeTokenUsage({
      inputTokens: entry.inputTokens,
      cachedInputTokens: entry.cachedInputTokens,
      outputTokens: entry.outputTokens,
      reasoningOutputTokens: entry.reasoningOutputTokens,
      totalTokens: entry.totalTokens
    });
    return {
      agent: inferAgentFromCommand(entry.agentCli),
      status: statusFromDigest(entry.status),
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      minutes: Number(entry.durationMs || 0) > 0 ? Math.max(1, Math.round(Number(entry.durationMs || 0) / 60000)) : 0,
      tokenUsage,
      changedFiles: entry.files
        .filter((file) => file.role === 'changed' || file.role === 'touched')
        .map((file) => String(file.filePath || '').trim())
        .filter(Boolean)
    };
  }).filter((run): run is AgentImpactRun => Boolean(run));
}

export function buildAgentImpactSummaryFromProjectRuns(
  projects: AgentImpactProject[],
  getRuns: (project: AgentImpactProject) => AgentImpactRun[],
  getRoadmapNodes: (project: AgentImpactProject) => RoadmapNodeLike[],
  now = new Date()
): AgentImpactSummary {
  const weekStartMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const byAgent = new Map<string, { agent: string; runs: number; minutes: number; tokens: number; tokenRuns: number; files: Set<string>; latestRunAtMs: number }>();
  const allChangedFiles = new Set<string>();
  let weekRuns = 0;
  let totalRuns = 0;
  let completedRuns = 0;
  let failedRuns = 0;
  let totalMinutes = 0;
  let totalTokens = 0;
  let tokenRuns = 0;
  let latestRunAt = 0;
  let totalNodes = 0;
  let completedNodes = 0;

  for (const project of projects) {
    const nodes = getRoadmapNodes(project);
    totalNodes += nodes.length;
    completedNodes += nodes.filter((node) => node.status === 'Completed').length;

    const runs = getRuns(project);
    for (const run of runs) {
      const agent = run.agent;
      const timestamp = run.timestamp;
      const trustedDurationMs = getTrustedWorkDurationMs({
        startedAt: timestamp ? new Date(timestamp - run.minutes * 60000).toISOString() : '',
        finishedAt: timestamp ? new Date(timestamp).toISOString() : '',
        durationMs: run.minutes * 60000
      });
      const minutes = trustedDurationMs === null ? 0 : run.minutes;
      const changedFiles = run.changedFiles.map((file) => `${project.path}:${file}`);
      const agentStats = byAgent.get(agent) || { agent, runs: 0, minutes: 0, tokens: 0, tokenRuns: 0, files: new Set<string>(), latestRunAtMs: 0 };

      totalRuns += 1;
      agentStats.runs += 1;
      if (timestamp >= weekStartMs) {
        weekRuns += 1;
      }
      latestRunAt = Math.max(latestRunAt, timestamp);
      agentStats.latestRunAtMs = Math.max(agentStats.latestRunAtMs, timestamp);
      totalMinutes += minutes;
      agentStats.minutes += minutes;
      if (run.tokenUsage.totalTokens > 0) {
        totalTokens += run.tokenUsage.totalTokens;
        tokenRuns += 1;
        agentStats.tokens += run.tokenUsage.totalTokens;
        agentStats.tokenRuns += 1;
      }
      changedFiles.forEach((file) => {
        allChangedFiles.add(file);
        agentStats.files.add(file);
      });

      const status = run.status;
      if (status === 'completed') {
        completedRuns += 1;
      } else if (status === 'failed') {
        failedRuns += 1;
      }
      byAgent.set(agent, agentStats);
    }
  }

  return {
    weekRuns,
    totalRuns,
    completedRuns,
    failedRuns,
    totalMinutes,
    totalTokens,
    tokenRuns,
    changedFiles: allChangedFiles.size,
    projectProgressPercent: totalNodes > 0 ? Math.round((completedNodes / totalNodes) * 100) : 0,
    completedNodes,
    totalNodes,
    latestRunAt: latestRunAt ? new Date(latestRunAt).toISOString() : '',
    byAgent: [...byAgent.values()]
      .map((item) => ({
        agent: item.agent,
        runs: item.runs,
        minutes: item.minutes,
        tokens: item.tokens,
        tokenRuns: item.tokenRuns,
        changedFiles: item.files.size,
        latestRunAt: item.latestRunAtMs ? new Date(item.latestRunAtMs).toISOString() : ''
      }))
      .sort((a, b) => b.minutes - a.minutes || b.changedFiles - a.changedFiles || b.runs - a.runs || a.agent.localeCompare(b.agent))
  };
}

export async function buildAgentImpactSummaryFromDatabase(projects: AgentImpactProject[], _extensionPath: string, now = new Date(), globalDataPath = ''): Promise<AgentImpactSummary> {
  const root = normalizeGlobalDataPathForExtension(globalDataPath, projects[0]?.path || '');
  return observeLocalDiagnosticStage('agentImpact.aggregate', () => sendRuntimeDataRequest<AgentImpactSummary>(root, {
    operation: 'read_agent_impact_summary',
    input: { projects: projects.map(project => ({ name: project.name, path: project.path })), now: now.toISOString() }
  }));
}

export async function getAgentImpactStatusFromDatabase(projects: AgentImpactProject[], extensionPath: string, globalDataPath = ''): Promise<AgentImpactStatus> {
  return { impact: await buildAgentImpactSummaryFromDatabase(projects, extensionPath, new Date(), globalDataPath) };
}
