import * as fs from 'fs';
import * as path from 'path';
import * as Papa from 'papaparse';

import { summarizeDocumentationForReview } from './documentationManifest';
import { readLearningSummary } from './learningLedger';
import { assessProjectFoundation, ProjectFoundationAssessment } from './projectFoundation';
import { ProjectInvestmentStats, readProjectInvestmentStats, readProjectInvestmentStatsFromDatabase } from './projectAnalytics';
import { buildWorkHabitStats } from './workHabits';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import {
  ProjectDeliverySummary,
  ProjectIssueSummary,
  ProjectPullRequestSummary,
  ProjectSecuritySummary,
  createEmptyDeliverySummary,
  createEmptyIssueSummary,
  createEmptyPullRequestSummary,
  createEmptySecuritySummary,
  readCachedDeliverySummary,
  readCachedIssueSummary,
  readCachedPullRequestSummary,
  readCachedSecuritySummary
} from './projectExternalSignals';

export interface SolopreneurProject {
  name: string;
  path: string;
  type?: string;
  priority?: string;
  pinnedAt?: string;
}

export interface ProjectPortfolioSummary {
  name: string;
  path: string;
  totalNodes: number;
  completedNodes: number;
  failedNodes: number;
  runningNodes: number;
  inProgressNodes: number;
  pendingNodes: number;
  progressPercent: number;
  currentStage: string;
  recommendedNodeId: string;
  recommendedNodeTitle: string;
  recommendedStatus: string;
  overallStatus: string;
  recentActivityAt: string;
  issues: ProjectIssueSummary;
  pullRequests: ProjectPullRequestSummary;
  globalPriority: string;
  projectType: string;
  blocker: string;
  globalNextAction: string;
  reusableSignals: number;
  issuePressure: string;
  stageGap: string;
  delivery: ProjectDeliverySummary;
  deliverySignal: string;
  security: ProjectSecuritySummary;
  securitySignal: string;
  foundation: ProjectFoundationAssessment;
  documentationDocumentCount: number;
  documentationPendingReview: number;
  pinnedAt?: string;
  investment: ProjectInvestmentStats;
  loopSummary: ProjectLoopSummary;
  nodes: RoadmapNodeLike[];
}

export interface ProjectLoopStageSummary {
  key: MethodologyStageKey;
  label: string;
  total: number;
  completed: number;
  focus: boolean;
  missing: boolean;
}

export interface ProjectLoopSummary {
  stages: ProjectLoopStageSummary[];
  focusKey: MethodologyStageKey;
  focusLabel: string;
  focusReason: string;
  nextTask: string;
}

export interface RoadmapNodeLike {
  id: string;
  title: string;
  stage: string;
  status: string;
  agentCli?: string;
  dependencies?: string;
}

export interface ProjectPortfolioBuildOptions {
  includeReusableSignals?: boolean;
  globalDataPath?: string;
  investmentStatsByProjectPath?: Map<string, ProjectInvestmentStats> | Record<string, ProjectInvestmentStats>;
  coreOnly?: boolean;
}

export function applyProjectRegistryToPortfolio(
  projects: SolopreneurProject[],
  portfolio: ProjectPortfolioSummary[]
): ProjectPortfolioSummary[] {
  const summariesByPath = new Map((portfolio || []).map((summary) => [summary.path, summary]));
  const merged: ProjectPortfolioSummary[] = [];
  for (const project of projects || []) {
    const summary = summariesByPath.get(project.path);
    if (!summary) {
      continue;
    }
    merged.push({
      ...summary,
      name: project.name,
      globalPriority: project.priority || inferGlobalPriority(summary),
      projectType: project.type || detectProjectType(summary.nodes || []),
      pinnedAt: project.pinnedAt || ''
    });
  }
  return merged;
}

function emptyFoundationAssessment(): ProjectFoundationAssessment {
  return { complete: false, missingCount: 0, missing: [], items: [], message: '' };
}

function emptyInvestmentStats(): ProjectInvestmentStats {
  return {
    schemaVersion: 1,
    generatedAt: '',
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
    workHabits: buildWorkHabitStats([])
  };
}

type MethodologyStageKey = 'build' | 'sell' | 'learn' | 'improve';
const methodologyStages: Array<{ key: MethodologyStageKey; label: string }> = [
  { key: 'build', label: 'Build' },
  { key: 'sell', label: 'Sell' },
  { key: 'learn', label: 'Learn' },
  { key: 'improve', label: 'Improve' }
];

export function normalizeGlobalDataPath(rawPath: string, projects: SolopreneurProject[] = []): string {
  return normalizeGlobalDataPathForExtension(rawPath, projects[0]?.path || '');
}

export function getLocalDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function daysUntilMonthEnd(date: Date): number {
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return end.getDate() - date.getDate();
}

export function getDailyWorkRhythm(date = new Date()): string {
  const day = date.getDay();
  if (daysUntilMonthEnd(date) <= 2) return 'monthEnd';
  if (day === 1) return 'monday';
  if (day === 5) return 'friday';
  return 'daily';
}

export function commonParent(paths: string[]): string {
  const normalized = paths.filter(Boolean).map((item) => path.resolve(item));
  if (!normalized.length) return process.cwd();
  const splitPaths = normalized.map((item) => item.split(path.sep).filter(Boolean));
  const first = splitPaths[0];
  const common: string[] = [];
  for (let index = 0; index < first.length; index += 1) {
    if (splitPaths.every((parts) => parts[index] === first[index])) {
      common.push(first[index]);
    } else {
      break;
    }
  }
  const prefix = path.isAbsolute(normalized[0]) ? path.sep : '';
  return common.length ? path.join(prefix, ...common) : path.parse(normalized[0]).root || process.cwd();
}

export function slugifyProjectId(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'project';
}

export function readProjectRoadmapNodes(projectPath: string): RoadmapNodeLike[] {
  const roadmapPath = path.join(projectPath, '.solopreneur', 'roadmap.csv');
  if (!fs.existsSync(roadmapPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(roadmapPath, 'utf8');
    const parseResult = Papa.parse<RoadmapNodeLike>(content, {
      header: true,
      skipEmptyLines: true,
    });
    return parseResult.data.map((node) => ({
      id: String(node.id || '').trim(),
      title: String(node.title || '').trim(),
      stage: String(node.stage || '').trim(),
      status: String(node.status || 'Pending').trim() || 'Pending',
      agentCli: String((node as any).agentCli || '').trim(),
      dependencies: String(node.dependencies || '').trim()
    })).filter((node) => node.id);
  } catch {
    return [];
  }
}

function inferMethodologyStage(node: RoadmapNodeLike): MethodologyStageKey {
  const text = `${node.stage || ''} ${node.title || ''}`.toLowerCase();
  if (/营销|销售|分发|品牌|官网|发布|外联|获客|转化|sell|sales|market|launch|growth|distribution|outreach/.test(text)) {
    return 'sell';
  }
  if (/产品|mvp|构建|实现|开发|交付|源码|页面|功能|build|ship|implement|code|feature/.test(text)) {
    return 'build';
  }
  if (/调整|改进|复盘|规模化|路线图|优先级|下一轮|improve|iterate|iteration|roadmap|scale|optimi[sz]e/.test(text)) {
    return 'improve';
  }
  if (/问题|客户|发现|反馈|学习|访谈|指标|数据|issue|learn|feedback|customer|discovery|analytics|support/.test(text)) {
    return 'learn';
  }
  return 'build';
}

function summarizeMethodologyStages(nodes: RoadmapNodeLike[]): { counts: Record<MethodologyStageKey, number>; gap: string } {
  const counts: Record<MethodologyStageKey, number> = { build: 0, sell: 0, learn: 0, improve: 0 };
  nodes.forEach((node) => {
    counts[inferMethodologyStage(node)] += 1;
  });
  const gap = methodologyStages.find((stage) => counts[stage.key] === 0)?.label || '';
  return { counts, gap };
}

function buildProjectLoopSummary(
  nodes: RoadmapNodeLike[],
  recommendedNode: RoadmapNodeLike | null,
  stageSummary: { counts: Record<MethodologyStageKey, number>; gap: string }
): ProjectLoopSummary {
  const completedCounts: Record<MethodologyStageKey, number> = { build: 0, sell: 0, learn: 0, improve: 0 };
  nodes.forEach((node) => {
    if (node.status === 'Completed') {
      completedCounts[inferMethodologyStage(node)] += 1;
    }
  });
  const recommendedStage = recommendedNode ? inferMethodologyStage(recommendedNode) : null;
  const missingStage = methodologyStages.find((stage) => stageSummary.counts[stage.key] === 0) || null;
  const focusKey = (recommendedStage || missingStage?.key || 'build') as MethodologyStageKey;
  const focusLabel = methodologyStages.find((stage) => stage.key === focusKey)?.label || 'Build';
  return {
    stages: methodologyStages.map((stage) => ({
      key: stage.key,
      label: stage.label,
      total: stageSummary.counts[stage.key] || 0,
      completed: completedCounts[stage.key] || 0,
      focus: stage.key === focusKey,
      missing: (stageSummary.counts[stage.key] || 0) === 0
    })),
    focusKey,
    focusLabel,
    focusReason: recommendedNode
      ? `${focusLabel} 里最该推进的是 ${recommendedNode.title}`
      : missingStage
        ? `当前缺少 ${missingStage.label} 环节`
        : `先从 ${focusLabel} 形成下一步`,
    nextTask: recommendedNode?.title || (missingStage ? `调整路线图：补齐 ${missingStage.label}` : '开始下一步推进')
  };
}

function rankNodeForStageGap(node: RoadmapNodeLike, stageSummary: { gap: string }): number {
  const stage = inferMethodologyStage(node);
  if (!stageSummary.gap) {
    return 0;
  }
  if (stageSummary.gap === 'Sell' && stage === 'sell') return -3;
  if (stageSummary.gap === 'Learn' && stage === 'learn') return -3;
  if (stageSummary.gap === 'Improve' && stage === 'improve') return -3;
  if (stageSummary.gap === 'Build' && stage === 'build') return -3;
  return 0;
}

export function getRecommendedNode(nodes: RoadmapNodeLike[]): RoadmapNodeLike | null {
  if (!nodes.length) {
    return null;
  }
  const stageSummary = summarizeMethodologyStages(nodes);
  const completedIds = new Set(nodes.filter((node) => node.status === 'Completed').map((node) => node.id));
  const dependenciesSatisfied = (node: RoadmapNodeLike) => {
    const dependencies = String(node.dependencies || '')
      .split(',')
      .map((dependency) => dependency.trim())
      .filter(Boolean);
    return dependencies.every((dependency) => completedIds.has(dependency));
  };
  const byStatus = (status: string) => nodes.find((node) => node.status === status);
  const rankPending = (candidates: RoadmapNodeLike[]) => candidates
    .map((node, index) => ({ node, index, rank: rankNodeForStageGap(node, stageSummary) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)[0]?.node || null;
  const readyPending = rankPending(nodes.filter((node) => node.status === 'Pending' && dependenciesSatisfied(node)));
  const anyPending = rankPending(nodes.filter((node) => node.status === 'Pending'));
  return byStatus('Running')
    || byStatus('Failed')
    || byStatus('In Progress')
    || readyPending
    || anyPending
    || nodes.find((node) => node.status !== 'Completed')
    || nodes[0];
}

function getProjectRecentActivityAt(projectPath: string): string {
  const candidates = [
    path.join(projectPath, '.solopreneur', 'roadmap.csv'),
    path.join(projectPath, '.solopreneur', 'project_journal.db'),
    path.join(projectPath, '.solopreneur', 'agent-runs')
  ];
  let latestMtime = 0;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      const stat = fs.statSync(candidate);
      latestMtime = Math.max(latestMtime, stat.mtimeMs);
    } catch {}
  }
  return latestMtime ? new Date(latestMtime).toISOString() : '';
}

function detectProjectType(nodes: RoadmapNodeLike[]): string {
  const text = nodes.map((node) => `${node.stage} ${node.title}`).join(' ').toLowerCase();
  if (/能力|契约|接入|治理|infra|infrastructure|adapter|provider/.test(text)) return 'infra';
  if (/内容|发布|分发|文章|小说|报告|content/.test(text)) return 'content';
  if (/试验|实验|研究|验证假设|prototype|experiment|research/.test(text)) return 'experiment';
  if (/工具|脚手架|模板|自动化|tool|scaffold/.test(text)) return 'tool';
  if (/日常|事务|支持|运营|客服|排障|daily|routine|support|ops/.test(text)) return 'daily_work';
  if (/维护|监控|告警|归档|archive|maintenance/.test(text)) return 'archive';
  return 'core_product';
}

function inferGlobalPriority(summary: Pick<ProjectPortfolioSummary, 'failedNodes' | 'runningNodes' | 'inProgressNodes' | 'pendingNodes' | 'issues' | 'delivery' | 'security' | 'overallStatus'>): string {
  const p0Issues = Number((summary.issues?.byPriority || {}).P0 || 0);
  const failedWorkflowRuns = Number(summary.delivery?.failedWorkflowRuns || 0);
  const securityRisks = Number(summary.security?.openCriticalHigh || 0);
  if (securityRisks > 0 || p0Issues > 0 || failedWorkflowRuns > 0 || Number(summary.failedNodes || 0) > 0) return 'P0';
  if (Number(summary.runningNodes || 0) > 0 || Number(summary.inProgressNodes || 0) > 0) return 'P1';
  if (Number(summary.pendingNodes || 0) > 0) return 'P2';
  return 'P3';
}

function inferIssuePressure(issues: ProjectIssueSummary): string {
  if (!issues?.available) return '';
  const p0 = Number((issues.byPriority || {}).P0 || 0);
  const bugs = Number((issues.byCategory || {}).bug || 0);
  if (p0 > 0) return `${p0} P0`;
  if (bugs > 0) return `${bugs} bug`;
  return issues.open ? `${issues.open} open` : '';
}

export function inferDeliverySignal(delivery: ProjectDeliverySummary): string {
  if (!delivery?.available) return '';
  if (Number(delivery.failedWorkflowRuns || 0) > 0) return 'Delivery needs attention';
  if (delivery.latestRelease) return `Latest ${delivery.latestRelease}`;
  if (delivery.stale && delivery.syncedAt) return 'Delivery cached';
  if (delivery.latestWorkflowStatus) return 'Checks healthy';
  return '';
}

function inferSecuritySignal(security: ProjectSecuritySummary): string {
  if (!security?.available) return '';
  if (Number(security.openCriticalHigh || 0) > 0) return `${security.openCriticalHigh} security risk`;
  if (security.status === 'healthy') return 'Security healthy';
  if (security.stale && security.syncedAt) return 'Security cached';
  return '';
}

function countReusableSignals(projectPath: string, globalDataPath = ''): number {
  const candidates = [
    path.join(projectPath, '.solopreneur', 'step-memory'),
    path.join(projectPath, '.solopreneur', 'agent-runs')
  ];
  const legacyCount = candidates.reduce((count, candidate) => {
    try {
      return count + (fs.existsSync(candidate) ? fs.readdirSync(candidate).length : 0);
    } catch {
      return count;
    }
  }, 0);
  const ledgerSignalCount = (() => {
    try {
      const summary = readLearningSummary(projectPath, globalDataPath);
      const projectSignal = summary.projectSignals.find((item) => item.projectPath === projectPath);
      return projectSignal
        ? Number(projectSignal.candidateCount || 0) + Number(projectSignal.promotedCount || 0) + Number(projectSignal.riskSignals || 0) + Number(projectSignal.verificationSignals || 0)
        : 0;
    } catch {
      return 0;
    }
  })();
  return legacyCount + ledgerSignalCount;
}

function getInvestmentOverride(projectPath: string, options: ProjectPortfolioBuildOptions): ProjectInvestmentStats | null {
  const overrides = options.investmentStatsByProjectPath;
  if (!overrides) {
    return null;
  }
  if (overrides instanceof Map) {
    return overrides.get(projectPath) || null;
  }
  return overrides[projectPath] || null;
}

export function buildProjectPortfolioSummary(project: SolopreneurProject, options: ProjectPortfolioBuildOptions = {}): ProjectPortfolioSummary {
  const nodes = readProjectRoadmapNodes(project.path);
  const stageSummary = summarizeMethodologyStages(nodes);
  const totalNodes = nodes.length;
  const completedNodes = nodes.filter((node) => node.status === 'Completed').length;
  const failedNodes = nodes.filter((node) => node.status === 'Failed').length;
  const runningNodes = nodes.filter((node) => node.status === 'Running').length;
  const inProgressNodes = nodes.filter((node) => node.status === 'In Progress').length;
  const pendingNodes = nodes.filter((node) => node.status === 'Pending').length;
  const recommendedNode = getRecommendedNode(nodes);
  const overallStatus = runningNodes > 0
    ? 'Running'
    : failedNodes > 0
      ? 'Failed'
      : totalNodes > 0 && completedNodes === totalNodes
        ? 'Completed'
        : inProgressNodes > 0
          ? 'In Progress'
          : 'Pending';

  const baseSummary = {
    name: project.name,
    path: project.path,
    totalNodes,
    completedNodes,
    failedNodes,
    runningNodes,
    inProgressNodes,
    pendingNodes,
    progressPercent: totalNodes > 0 ? Math.round((completedNodes / totalNodes) * 100) : 0,
    currentStage: recommendedNode?.stage || '',
    recommendedNodeId: recommendedNode?.id || '',
    recommendedNodeTitle: recommendedNode?.title || '',
    recommendedStatus: recommendedNode?.status || '',
    overallStatus,
    recentActivityAt: options.coreOnly ? '' : getProjectRecentActivityAt(project.path),
    issues: options.coreOnly ? createEmptyIssueSummary() : readCachedIssueSummary(project.path),
    pullRequests: options.coreOnly ? createEmptyPullRequestSummary() : readCachedPullRequestSummary(project.path),
    delivery: options.coreOnly ? createEmptyDeliverySummary() : readCachedDeliverySummary(project.path),
    security: options.coreOnly ? createEmptySecuritySummary() : readCachedSecuritySummary(project.path),
    foundation: options.coreOnly ? emptyFoundationAssessment() : assessProjectFoundation(project.path)
  };
  const inferredPriority = inferGlobalPriority(baseSummary);
  const globalPriority = project.priority || inferredPriority;
  const deliverySignal = inferDeliverySignal(baseSummary.delivery);
  const securitySignal = inferSecuritySignal(baseSummary.security);
  const needsRelease = baseSummary.delivery.available && totalNodes > 0 && completedNodes === totalNodes && !baseSummary.delivery.latestRelease;
  const documentationSummary = options.coreOnly ? { documentCount: 0, pendingReviewCount: 0 } : summarizeDocumentationForReview(project.path);
  const investment = options.coreOnly ? emptyInvestmentStats() : (getInvestmentOverride(project.path, options) || readProjectInvestmentStats(project.path));
  const loopSummary = buildProjectLoopSummary(nodes, recommendedNode, stageSummary);
  return {
    ...baseSummary,
    nodes,
    globalPriority,
    projectType: project.type || detectProjectType(nodes),
    blocker: failedNodes > 0 ? (recommendedNode?.title || 'Failed roadmap step') : '',
    globalNextAction: baseSummary.security.openCriticalHigh > 0
      ? '修复安全风险'
      : baseSummary.delivery.failedWorkflowRuns > 0
        ? '修复发布检查'
        : recommendedNode?.title || (needsRelease ? '发布当前成果' : (totalNodes ? (stageSummary.gap ? `调整路线图：补齐 ${stageSummary.gap}` : 'Review completed roadmap') : '生成初始路线图')),
    reusableSignals: options.includeReusableSignals ? countReusableSignals(project.path, options.globalDataPath || '') : 0,
    issuePressure: inferIssuePressure(baseSummary.issues),
    stageGap: stageSummary.gap,
    delivery: baseSummary.delivery,
    deliverySignal,
    security: baseSummary.security,
    securitySignal,
    foundation: baseSummary.foundation,
    documentationDocumentCount: documentationSummary.documentCount,
    documentationPendingReview: documentationSummary.pendingReviewCount,
    pinnedAt: project.pinnedAt || '',
    investment,
    loopSummary
  };
}

export function buildProjectPortfolioSummaries(projects: SolopreneurProject[], options: ProjectPortfolioBuildOptions = {}): ProjectPortfolioSummary[] {
  return projects
    .map((project) => buildProjectPortfolioSummary(project, options))
    .sort((a, b) => {
      const pinnedA = a.pinnedAt ? 1 : 0;
      const pinnedB = b.pinnedAt ? 1 : 0;
      if (pinnedA !== pinnedB) {
        return pinnedB - pinnedA;
      }
      if (a.pinnedAt || b.pinnedAt) {
        return String(b.pinnedAt || '').localeCompare(String(a.pinnedAt || ''));
      }
      return 0;
    });
}

export async function buildProjectPortfolioSummariesFromDatabase(
  projects: SolopreneurProject[],
  extensionPath: string,
  options: ProjectPortfolioBuildOptions = {}
): Promise<ProjectPortfolioSummary[]> {
  const investmentStatsByProjectPath = new Map<string, ProjectInvestmentStats>();
  await Promise.all(projects.map(async (project) => {
    investmentStatsByProjectPath.set(
      project.path,
      await readProjectInvestmentStatsFromDatabase(project.path, extensionPath)
    );
  }));
  return buildProjectPortfolioSummaries(projects, {
    ...options,
    investmentStatsByProjectPath
  });
}
