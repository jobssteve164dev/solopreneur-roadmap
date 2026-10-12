import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as Papa from 'papaparse';
import type * as vscode from 'vscode';
import { normalizeGlobalDataPathForExtension, SolopreneurProject } from './projectRegistry';
import { buildLocalDiagnosticSummary } from './localDiagnostics';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';

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

interface AnalysisState<T> { objectId: string | null; revision: number; value: T | null }

function dataRoot(options: LocalUsageStatsOptions): string {
  return normalizeGlobalDataPathForExtension(options.globalDataPath, options.projects[0]?.path || process.cwd());
}

async function readLocalUsageStats(context: vscode.ExtensionContext, options: LocalUsageStatsOptions): Promise<AnalysisState<LocalUsageStats>> {
  const state = await sendRuntimeDataRequest<AnalysisState<LocalUsageStats>>(dataRoot(options), {
    operation: 'read_analysis_state', input: { namespace: 'usage', key: 'local' }
  });
  return { ...state, value: state.value ? normalizeUsageStats(context, state.value) : createEmptyUsageStats(context) };
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

async function refreshLocalUsageSnapshot(context: vscode.ExtensionContext, options: LocalUsageStatsOptions, stats: LocalUsageStats): Promise<LocalUsageStats> {
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

  const projectSources = await Promise.all(options.projects.map(async project => ({
    project,
    source: await sendRuntimeDataRequest<{ runCount: number; latestRunAt: string }>(dataRoot(options), { operation: 'read_project_analysis_source', input: { root: project.path } }),
    issue: await sendRuntimeDataRequest<AnalysisState<unknown>>(dataRoot(options), { operation: 'read_analysis_state', input: { root: project.path, namespace: 'external', key: 'issues' } }),
    delivery: await sendRuntimeDataRequest<AnalysisState<unknown>>(dataRoot(options), { operation: 'read_analysis_state', input: { root: project.path, namespace: 'external', key: 'delivery' } })
  })));
  for (const { project, source, issue, delivery } of projectSources) {
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
    if (issue.value) issueCacheProjectCount += 1;
    if (delivery.value) deliveryCacheProjectCount += 1;
    agentRunDirectoryCount += source.runCount;
    const runMs = source.latestRunAt ? Date.parse(source.latestRunAt) : 0;
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

export async function recordLocalUsageEvent(context: vscode.ExtensionContext, options: LocalUsageStatsOptions, event: LocalUsageEvent): Promise<LocalUsageStats> {
  const requestNonce = crypto.randomUUID();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await readLocalUsageStats(context, options);
    const now = new Date().toISOString();
    let stats = current.value!;
    const counters = { ...stats.counters };
    if (event === 'activation') counters.activations += 1;
    if (event === 'roadmapOpened') counters.roadmapOpens += 1;
    if (event === 'projectAdded') counters.projectsAdded += 1;
    if (event === 'agentRun') counters.agentRuns += 1;
    if (event === 'soloConversation') counters.soloConversations += 1;
    if (event === 'roadmapRevision') counters.roadmapRevisions += 1;
    if (event === 'feedbackIssueOpened') counters.feedbackIssuesOpened += 1;
    stats = { ...stats, updatedAt: now, extensionVersion: getExtensionVersion(context) || stats.extensionVersion, counters,
      lastEventAt: { ...stats.lastEventAt, [event]: now } };
    if (event === 'feedbackIssueOpened') stats = await refreshLocalUsageSnapshot(context, options, stats);
    try {
      const written = await sendRuntimeDataRequest<AnalysisState<LocalUsageStats>>(dataRoot(options), {
        operation: 'write_analysis_state', input: { namespace: 'usage', key: 'local', expectedRevision: current.revision,
          value: stats, idempotencyKey: `${event}:${requestNonce}:${attempt}` }
      });
      return normalizeUsageStats(context, written.value);
    } catch (error) {
      if (!/revision_conflict/.test(String(error)) || attempt === 3) throw error;
    }
  }
  throw new Error('usage_state_write_failed');
}

export async function buildFeedbackUsageSummary(
  context: vscode.ExtensionContext,
  options: LocalUsageStatsOptions,
  host: { appName?: string; version?: string; remoteName?: string; uiKind?: number; uriScheme?: string } = {}
): Promise<string> {
  const stats = await recordLocalUsageEvent(context, options, 'feedbackIssueOpened');
  const snapshot = stats.snapshot;
  return [
    'This anonymous local summary is included only because the user opened a feedback issue.',
    'Storage: SoloMap local database',
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
    `- Indexed local Agent runs: ${snapshot.agentRunDirectoryCount}`,
    `- Latest local Agent run: ${snapshot.latestAgentRunAt || 'none'}`,
    '',
    await buildLocalDiagnosticSummary(context, options.globalDataPath, host),
    '',
    'Privacy:',
    '- No project paths, project names, Issue titles, Agent outputs, prompts, logs, or file contents are included.'
  ].join('\n');
}
