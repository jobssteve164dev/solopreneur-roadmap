import * as fs from 'fs';
import * as path from 'path';
import * as Papa from 'papaparse';
import type * as vscode from 'vscode';
import { normalizeGlobalDataPathForExtension, SolopreneurProject } from './projectRegistry';
import { buildLocalDiagnosticSummary } from './localDiagnostics';

export interface LocalUsageStats {
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  extensionVersion: string;
  counters: {
    activations: number;
    roadmapOpens: number;
    projectsAdded: number;
    agentRuns: number;
    soloConversations: number;
    roadmapRevisions: number;
    feedbackIssuesOpened: number;
  };
  lastEventAt: Record<string, string>;
  snapshot: {
    registeredProjectCount: number;
    projectsWithRoadmap: number;
    roadmapNodeCount: number;
    completedNodeCount: number;
    failedNodeCount: number;
    runningNodeCount: number;
    inProgressNodeCount: number;
    pendingNodeCount: number;
    projectProgressPercent: number;
    issueCacheProjectCount: number;
    deliveryCacheProjectCount: number;
    agentRunDirectoryCount: number;
    latestAgentRunAt: string;
  };
}

export type LocalUsageEvent =
  | 'activation'
  | 'roadmapOpened'
  | 'projectAdded'
  | 'agentRun'
  | 'soloConversation'
  | 'roadmapRevision'
  | 'feedbackIssueOpened';

export interface LocalUsageStatsOptions {
  globalDataPath: string;
  usageStatsFileName: string;
  projects: SolopreneurProject[];
}

function getUsageStatsPath(globalDataPath: string, usageStatsFileName: string): string {
  return path.join(normalizeGlobalDataPathForExtension(globalDataPath), 'usage', usageStatsFileName);
}

function getExtensionVersion(context: vscode.ExtensionContext): string {
  return String((context as any).extension?.packageJSON?.version || '');
}

function createEmptyUsageStats(context: vscode.ExtensionContext, now = new Date().toISOString()): LocalUsageStats {
  return {
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    extensionVersion: getExtensionVersion(context),
    counters: {
      activations: 0,
      roadmapOpens: 0,
      projectsAdded: 0,
      agentRuns: 0,
      soloConversations: 0,
      roadmapRevisions: 0,
      feedbackIssuesOpened: 0
    },
    lastEventAt: {},
    snapshot: {
      registeredProjectCount: 0,
      projectsWithRoadmap: 0,
      roadmapNodeCount: 0,
      completedNodeCount: 0,
      failedNodeCount: 0,
      runningNodeCount: 0,
      inProgressNodeCount: 0,
      pendingNodeCount: 0,
      projectProgressPercent: 0,
      issueCacheProjectCount: 0,
      deliveryCacheProjectCount: 0,
      agentRunDirectoryCount: 0,
      latestAgentRunAt: ''
    }
  };
}

function normalizeUsageStats(context: vscode.ExtensionContext, raw: any): LocalUsageStats {
  const base = createEmptyUsageStats(context);
  const counters = raw && typeof raw.counters === 'object' ? raw.counters : {};
  const snapshot = raw && typeof raw.snapshot === 'object' ? raw.snapshot : {};
  return {
    ...base,
    createdAt: String(raw?.createdAt || base.createdAt),
    updatedAt: String(raw?.updatedAt || base.updatedAt),
    extensionVersion: String(raw?.extensionVersion || base.extensionVersion),
    counters: {
      activations: Number(counters.activations || 0),
      roadmapOpens: Number(counters.roadmapOpens || 0),
      projectsAdded: Number(counters.projectsAdded || 0),
      agentRuns: Number(counters.agentRuns || 0),
      soloConversations: Number(counters.soloConversations || 0),
      roadmapRevisions: Number(counters.roadmapRevisions || 0),
      feedbackIssuesOpened: Number(counters.feedbackIssuesOpened || 0)
    },
    lastEventAt: raw && typeof raw.lastEventAt === 'object'
      ? Object.fromEntries(Object.entries(raw.lastEventAt).map(([key, value]) => [String(key), String(value || '')]))
      : {},
    snapshot: {
      registeredProjectCount: Number(snapshot.registeredProjectCount || 0),
      projectsWithRoadmap: Number(snapshot.projectsWithRoadmap || 0),
      roadmapNodeCount: Number(snapshot.roadmapNodeCount || 0),
      completedNodeCount: Number(snapshot.completedNodeCount || 0),
      failedNodeCount: Number(snapshot.failedNodeCount || 0),
      runningNodeCount: Number(snapshot.runningNodeCount || 0),
      inProgressNodeCount: Number(snapshot.inProgressNodeCount || 0),
      pendingNodeCount: Number(snapshot.pendingNodeCount || 0),
      projectProgressPercent: Number(snapshot.projectProgressPercent || 0),
      issueCacheProjectCount: Number(snapshot.issueCacheProjectCount || 0),
      deliveryCacheProjectCount: Number(snapshot.deliveryCacheProjectCount || 0),
      agentRunDirectoryCount: Number(snapshot.agentRunDirectoryCount || 0),
      latestAgentRunAt: String(snapshot.latestAgentRunAt || '')
    }
  };
}

function readLocalUsageStats(context: vscode.ExtensionContext, options: LocalUsageStatsOptions): LocalUsageStats {
  const statsPath = getUsageStatsPath(options.globalDataPath, options.usageStatsFileName);
  if (!fs.existsSync(statsPath)) {
    return createEmptyUsageStats(context);
  }
  try {
    return normalizeUsageStats(context, JSON.parse(fs.readFileSync(statsPath, 'utf8')));
  } catch {
    return createEmptyUsageStats(context);
  }
}

function writeLocalUsageStats(options: LocalUsageStatsOptions, stats: LocalUsageStats): void {
  const statsPath = getUsageStatsPath(options.globalDataPath, options.usageStatsFileName);
  fs.mkdirSync(path.dirname(statsPath), { recursive: true });
  const payload = JSON.stringify(stats, null, 2);
  const tempPath = `${statsPath}.tmp`;
  fs.writeFileSync(tempPath, payload, 'utf8');
  JSON.parse(fs.readFileSync(tempPath, 'utf8'));
  fs.renameSync(tempPath, statsPath);
}

function readUsageRoadmapNodes(projectPath: string): Array<{ id: string; status: string }> {
  const roadmapPath = path.join(projectPath, '.solopreneur', 'roadmap.csv');
  if (!fs.existsSync(roadmapPath)) {
    return [];
  }
  try {
    const parsed = Papa.parse<{ id: string; status: string }>(fs.readFileSync(roadmapPath, 'utf8'), {
      header: true,
      skipEmptyLines: true
    });
    return parsed.data
      .map((node) => ({
        id: String(node.id || '').trim(),
        status: String(node.status || 'Pending').trim() || 'Pending'
      }))
      .filter((node) => node.id);
  } catch {
    return [];
  }
}

function getLatestRunTimestamp(runsRoot: string): { count: number; latestAt: string } {
  let count = 0;
  let latest = 0;
  try {
    const runNames = fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot) : [];
    for (const runName of runNames) {
      const runDir = path.join(runsRoot, runName);
      if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
        continue;
      }
      count += 1;
      const startedAtPath = path.join(runDir, 'started_at');
      let timestamp = 0;
      if (fs.existsSync(startedAtPath)) {
        const parsed = Date.parse(fs.readFileSync(startedAtPath, 'utf8').trim());
        timestamp = Number.isFinite(parsed) ? parsed : 0;
      }
      if (!timestamp) {
        timestamp = fs.statSync(runDir).mtimeMs;
      }
      latest = Math.max(latest, timestamp);
    }
  } catch {
    return { count, latestAt: latest ? new Date(latest).toISOString() : '' };
  }
  return { count, latestAt: latest ? new Date(latest).toISOString() : '' };
}

function refreshLocalUsageSnapshot(context: vscode.ExtensionContext, options: LocalUsageStatsOptions, stats: LocalUsageStats): LocalUsageStats {
  let projectsWithRoadmap = 0;
  let roadmapNodeCount = 0;
  let completedNodeCount = 0;
  let failedNodeCount = 0;
  let runningNodeCount = 0;
  let inProgressNodeCount = 0;
  let pendingNodeCount = 0;
  let issueCacheProjectCount = 0;
  let deliveryCacheProjectCount = 0;
  let agentRunDirectoryCount = 0;
  let latestAgentRunAtMs = 0;

  for (const project of options.projects) {
    const nodes = readUsageRoadmapNodes(project.path);
    if (nodes.length > 0) {
      projectsWithRoadmap += 1;
    }
    roadmapNodeCount += nodes.length;
    completedNodeCount += nodes.filter((node) => node.status === 'Completed').length;
    failedNodeCount += nodes.filter((node) => node.status === 'Failed').length;
    runningNodeCount += nodes.filter((node) => node.status === 'Running').length;
    inProgressNodeCount += nodes.filter((node) => node.status === 'In Progress').length;
    pendingNodeCount += nodes.filter((node) => node.status === 'Pending').length;
    if (fs.existsSync(path.join(project.path, '.solopreneur', 'issues-cache.json'))) {
      issueCacheProjectCount += 1;
    }
    if (fs.existsSync(path.join(project.path, '.solopreneur', 'delivery-cache.json'))) {
      deliveryCacheProjectCount += 1;
    }
    const runStats = getLatestRunTimestamp(path.join(project.path, '.solopreneur', 'agent-runs'));
    agentRunDirectoryCount += runStats.count;
    const runMs = runStats.latestAt ? Date.parse(runStats.latestAt) : 0;
    latestAgentRunAtMs = Number.isFinite(runMs) ? Math.max(latestAgentRunAtMs, runMs) : latestAgentRunAtMs;
  }

  return {
    ...stats,
    extensionVersion: getExtensionVersion(context) || stats.extensionVersion,
    snapshot: {
      registeredProjectCount: options.projects.length,
      projectsWithRoadmap,
      roadmapNodeCount,
      completedNodeCount,
      failedNodeCount,
      runningNodeCount,
      inProgressNodeCount,
      pendingNodeCount,
      projectProgressPercent: roadmapNodeCount > 0 ? Math.round((completedNodeCount / roadmapNodeCount) * 100) : 0,
      issueCacheProjectCount,
      deliveryCacheProjectCount,
      agentRunDirectoryCount,
      latestAgentRunAt: latestAgentRunAtMs ? new Date(latestAgentRunAtMs).toISOString() : ''
    }
  };
}

export function recordLocalUsageEvent(context: vscode.ExtensionContext, options: LocalUsageStatsOptions, event: LocalUsageEvent): LocalUsageStats {
  const now = new Date().toISOString();
  let stats = readLocalUsageStats(context, options);
  const counters = { ...stats.counters };
  if (event === 'activation') counters.activations += 1;
  if (event === 'roadmapOpened') counters.roadmapOpens += 1;
  if (event === 'projectAdded') counters.projectsAdded += 1;
  if (event === 'agentRun') counters.agentRuns += 1;
  if (event === 'soloConversation') counters.soloConversations += 1;
  if (event === 'roadmapRevision') counters.roadmapRevisions += 1;
  if (event === 'feedbackIssueOpened') counters.feedbackIssuesOpened += 1;
  stats = {
    ...stats,
    updatedAt: now,
    extensionVersion: getExtensionVersion(context) || stats.extensionVersion,
    counters,
    lastEventAt: {
      ...stats.lastEventAt,
      [event]: now
    }
  };
  if (event === 'feedbackIssueOpened') {
    stats = refreshLocalUsageSnapshot(context, options, stats);
  }
  try {
    writeLocalUsageStats(options, stats);
  } catch (error) {
    console.error('SoloMap failed to write local usage stats:', error);
  }
  return stats;
}

export function buildFeedbackUsageSummary(
  context: vscode.ExtensionContext,
  options: LocalUsageStatsOptions,
  host: { appName?: string; version?: string; remoteName?: string; uiKind?: number; uriScheme?: string } = {}
): string {
  const stats = recordLocalUsageEvent(context, options, 'feedbackIssueOpened');
  const snapshot = stats.snapshot;
  return [
    'This anonymous local summary is included only because the user opened a feedback issue.',
    `Stats file: .solomap-global/usage/${options.usageStatsFileName}`,
    `Extension version: ${stats.extensionVersion || 'unknown'}`,
    `First opened: ${stats.createdAt || 'unknown'}`,
    `Last updated: ${stats.updatedAt || 'unknown'}`,
    '',
    'Counters:',
    `- Activations: ${stats.counters.activations}`,
    `- Roadmap opens: ${stats.counters.roadmapOpens}`,
    `- Projects added: ${stats.counters.projectsAdded}`,
    `- Agent runs requested: ${stats.counters.agentRuns}`,
    `- Solo conversations requested: ${stats.counters.soloConversations}`,
    `- Roadmap revisions requested: ${stats.counters.roadmapRevisions}`,
    '',
    'Local snapshot:',
    `- Registered projects: ${snapshot.registeredProjectCount}`,
    `- Projects with roadmap: ${snapshot.projectsWithRoadmap}`,
    `- Roadmap nodes: ${snapshot.roadmapNodeCount}`,
    `- Completed / failed / running / in progress / pending: ${snapshot.completedNodeCount} / ${snapshot.failedNodeCount} / ${snapshot.runningNodeCount} / ${snapshot.inProgressNodeCount} / ${snapshot.pendingNodeCount}`,
    `- Project progress: ${snapshot.projectProgressPercent}%`,
    `- Projects with Issue cache: ${snapshot.issueCacheProjectCount}`,
    `- Projects with delivery cache: ${snapshot.deliveryCacheProjectCount}`,
    `- Local Agent run directories: ${snapshot.agentRunDirectoryCount}`,
    `- Latest local Agent run: ${snapshot.latestAgentRunAt || 'none'}`,
    '',
    buildLocalDiagnosticSummary(context, options.globalDataPath, host),
    '',
    'Privacy:',
    '- No project paths, project names, Issue titles, Agent outputs, prompts, logs, or file contents are included.'
  ].join('\n');
}
