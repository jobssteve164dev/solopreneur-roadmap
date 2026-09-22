import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { buildProjectPortfolioSummaries, ProjectPortfolioSummary } from './projectPortfolio';
import { getProjectsReadOnly, normalizeGlobalDataPathForExtension, SolopreneurProject } from './projectRegistry';

const SHADOW_ALGORITHM_VERSION = 'today-shadow-v1';

export interface ShadowRecommendation {
  id: string;
  rank: number;
  projectPath: string;
  projectName: string;
  nodeId: string;
  title: string;
  reason: string;
  action: 'open_project' | 'continue_step';
  evidence: string[];
  score: number;
}

export interface ShadowDecision {
  schemaVersion: 1;
  decisionId: string;
  generatedAt: string;
  status: 'completed';
  source: 'runtime_shadow';
  algorithmVersion: string;
  sourceRevision: string;
  projectCount: number;
  readOnly: true;
  baselineProjectPath: string;
  recommendedProjectPath: string;
  summary: string;
  recommendations: ShadowRecommendation[];
  engineId?: string;
  engineStatus?: 'completed' | 'failed' | 'unavailable';
}

export interface CognitiveShadowInput {
  decisionId: string;
  candidates: Array<{
    id: string;
    name: string;
    title: string;
    reason: string;
    evidence: string[];
    baselineRank: number;
  }>;
}

export interface CognitiveShadowProposal {
  candidateId: string;
  reason: string;
}

export interface CognitiveShadowEngine {
  id: string;
  plan(input: CognitiveShadowInput): Promise<CognitiveShadowProposal>;
}

export interface ShadowFeedback {
  operationId: string;
  decisionId: string;
  recommendedProjectPath: string;
  selectedProjectPath: string;
  outcome: 'accepted' | 'overridden' | 'ignored';
  recordedAt: string;
}

interface ShadowCycleOptions {
  globalDataPath: string;
  projectRegistryFileName?: string;
  now?: Date;
}

export interface RuntimeState {
  schemaVersion: 1;
  runtimeId: string;
  pid: number;
  status: 'running' | 'paused' | 'stopped' | 'failed';
  startedAt: string;
  heartbeatAt: string;
  lastDecisionId?: string;
  error?: string;
}

interface RuntimeLeaseOptions {
  runtimeId: string;
  pid: number;
  now?: Date;
  isProcessAlive?: (pid: number) => boolean;
}

function runtimeRoot(globalDataPath: string): string {
  return path.join(normalizeGlobalDataPathForExtension(globalDataPath), 'runtime');
}

function shadowSnapshotPath(globalDataPath: string): string {
  return path.join(runtimeRoot(globalDataPath), 'today-shadow.json');
}

function runtimeStatePath(globalDataPath: string): string {
  return path.join(runtimeRoot(globalDataPath), 'state.json');
}

function runtimeClaimPath(globalDataPath: string): string {
  return path.join(runtimeRoot(globalDataPath), 'state.claim');
}

function stableHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function roadmapContent(projectPath: string): string {
  const roadmapPath = path.join(projectPath, '.solopreneur', 'roadmap.csv');
  try {
    return fs.readFileSync(roadmapPath, 'utf8');
  } catch {
    return '';
  }
}

export function buildProjectSourceRevision(projects: SolopreneurProject[]): string {
  const facts = (projects || []).map((project) => ({
    name: String(project.name || ''),
    path: String(project.path || ''),
    type: String(project.type || ''),
    priority: String(project.priority || ''),
    pinnedAt: String(project.pinnedAt || ''),
    roadmap: roadmapContent(project.path)
  }));
  return stableHash(JSON.stringify(facts));
}

function priorityRank(priority: string): number {
  return ({ P0: 0, P1: 1, P2: 2, P3: 3 } as Record<string, number>)[priority] ?? 4;
}

function shadowScore(project: ProjectPortfolioSummary): number {
  let score = 0;
  if (project.failedNodes > 0) score += 100;
  if (project.globalPriority === 'P0') score += 80;
  if (project.globalPriority === 'P1') score += 60;
  if (project.runningNodes > 0) score += 50;
  if (project.inProgressNodes > 0) score += 40;
  if (project.pendingNodes > 0) score += 20;
  if (project.completedNodes > 0 && project.completedNodes === project.totalNodes) score += 5;
  return score;
}

function recommendationReason(project: ProjectPortfolioSummary): { reason: string; evidence: string[] } {
  if (project.failedNodes > 0) {
    return { reason: '先处理失败环节，避免它继续阻塞项目推进。', evidence: [`失败环节 ${project.failedNodes} 个`] };
  }
  if (project.globalPriority === 'P0') {
    return { reason: '这是当前最高优先级项目。', evidence: ['项目优先级 P0'] };
  }
  if (project.runningNodes > 0) {
    return { reason: '已有工作正在进行，先把当前结果收口。', evidence: [`运行中环节 ${project.runningNodes} 个`] };
  }
  if (project.inProgressNodes > 0) {
    return { reason: '继续已有进展比切换项目更容易形成结果。', evidence: [`进行中环节 ${project.inProgressNodes} 个`] };
  }
  if (project.globalPriority === 'P1') {
    return { reason: '它是当前主要推进方向，并且已有明确下一步。', evidence: ['项目优先级 P1'] };
  }
  if (project.pendingNodes > 0) {
    return { reason: '已有可以直接开始的下一步。', evidence: [`待开始环节 ${project.pendingNodes} 个`] };
  }
  return { reason: '检查现有结果并决定下一步。', evidence: ['当前没有进行中的环节'] };
}

export function buildShadowDecision(
  projects: SolopreneurProject[],
  portfolio: ProjectPortfolioSummary[],
  sourceRevision: string,
  now = new Date()
): ShadowDecision {
  const sorted = [...portfolio].sort((a, b) => (
    shadowScore(b) - shadowScore(a)
    || priorityRank(a.globalPriority) - priorityRank(b.globalPriority)
    || a.name.localeCompare(b.name)
    || a.path.localeCompare(b.path)
  ));
  const decisionId = stableHash(`${SHADOW_ALGORITHM_VERSION}:${now.toISOString().slice(0, 10)}:${sourceRevision}`);
  const recommendations = sorted.map((project, index) => {
    const explanation = recommendationReason(project);
    return {
      id: stableHash(`${decisionId}:${project.path}`),
      rank: index + 1,
      projectPath: project.path,
      projectName: project.name,
      nodeId: project.recommendedNodeId,
      title: project.recommendedNodeTitle || project.globalNextAction || `打开 ${project.name}`,
      reason: explanation.reason,
      action: project.recommendedNodeId ? 'continue_step' as const : 'open_project' as const,
      evidence: explanation.evidence,
      score: shadowScore(project)
    };
  });
  return {
    schemaVersion: 1,
    decisionId,
    generatedAt: now.toISOString(),
    status: 'completed',
    source: 'runtime_shadow',
    algorithmVersion: SHADOW_ALGORITHM_VERSION,
    sourceRevision,
    projectCount: projects.length,
    readOnly: true,
    baselineProjectPath: recommendations[0]?.projectPath || '',
    recommendedProjectPath: recommendations[0]?.projectPath || '',
    summary: recommendations.length
      ? `今天先推进 ${recommendations[0].projectName}：${recommendations[0].title}`
      : '当前没有可以安排的项目。',
    recommendations
  };
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readRuntimeState(globalDataPath: string): RuntimeState | null {
  const statePath = runtimeStatePath(globalDataPath);
  if (!fs.existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as RuntimeState;
    if (parsed.schemaVersion !== 1 || !parsed.runtimeId || !Number.isInteger(parsed.pid)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function claimRuntimeLease(globalDataPath: string, options: RuntimeLeaseOptions): { acquired: boolean; owner: RuntimeState } {
  fs.mkdirSync(runtimeRoot(globalDataPath), { recursive: true });
  const claimPath = runtimeClaimPath(globalDataPath);
  let claimFd: number | undefined;
  for (let attempt = 0; attempt < 100 && claimFd === undefined; attempt += 1) {
    try {
      claimFd = fs.openSync(claimPath, 'wx', 0o600);
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  if (claimFd === undefined) throw new Error('SoloMap Runtime lease claim is busy.');
  try {
  const now = options.now || new Date();
  const isProcessAlive = options.isProcessAlive || defaultIsProcessAlive;
  const current = readRuntimeState(globalDataPath);
  const heartbeatAgeMs = current ? now.getTime() - new Date(current.heartbeatAt).getTime() : Number.POSITIVE_INFINITY;
  if (
    current
    && current.status !== 'stopped'
    && current.runtimeId !== options.runtimeId
    && heartbeatAgeMs <= 90_000
    && isProcessAlive(current.pid)
  ) {
    return { acquired: false, owner: current };
  }
  const owner: RuntimeState = {
    schemaVersion: 1,
    runtimeId: options.runtimeId,
    pid: options.pid,
    status: 'running',
    startedAt: now.toISOString(),
    heartbeatAt: now.toISOString()
  };
  writeJsonAtomic(runtimeStatePath(globalDataPath), owner);
  return { acquired: true, owner };
  } finally {
    fs.closeSync(claimFd);
    fs.unlinkSync(claimPath);
  }
}

export function hasRuntimeLease(globalDataPath: string, runtimeId: string, pid: number): boolean {
  const current = readRuntimeState(globalDataPath);
  return Boolean(current && current.runtimeId === runtimeId && current.pid === pid && current.status === 'running');
}

export function updateRuntimeState(globalDataPath: string, runtimeId: string, patch: Partial<RuntimeState>, now = new Date()): RuntimeState | null {
  const current = readRuntimeState(globalDataPath);
  if (!current || current.runtimeId !== runtimeId) return null;
  const next: RuntimeState = {
    ...current,
    ...patch,
    schemaVersion: 1,
    runtimeId,
    heartbeatAt: now.toISOString()
  };
  writeJsonAtomic(runtimeStatePath(globalDataPath), next);
  return next;
}

function appendDecisionEvent(globalDataPath: string, decision: ShadowDecision): void {
  const eventPath = path.join(runtimeRoot(globalDataPath), 'events.jsonl');
  let lastDecisionId = '';
  if (fs.existsSync(eventPath)) {
    const lines = fs.readFileSync(eventPath, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length) {
      try {
        lastDecisionId = String(JSON.parse(lines[lines.length - 1]).decisionId || '');
      } catch {
        lastDecisionId = '';
      }
    }
  }
  if (lastDecisionId === decision.decisionId) return;
  fs.mkdirSync(path.dirname(eventPath), { recursive: true });
  fs.appendFileSync(eventPath, JSON.stringify({
    type: 'shadow_decision_created',
    decisionId: decision.decisionId,
    generatedAt: decision.generatedAt,
    sourceRevision: decision.sourceRevision,
    baselineProjectPath: decision.baselineProjectPath,
    recommendedProjectPath: decision.recommendedProjectPath
  }) + '\n', { encoding: 'utf8', mode: 0o600 });
}

export function runShadowDecisionCycle(options: ShadowCycleOptions): ShadowDecision {
  const globalRoot = normalizeGlobalDataPathForExtension(options.globalDataPath);
  const projects = getProjectsReadOnly({
    globalDataPath: globalRoot,
    projectRegistryFileName: options.projectRegistryFileName || 'projects.json',
    legacyProjects: [],
    legacyHiddenProjects: []
  });
  const sourceRevision = buildProjectSourceRevision(projects);
  const portfolio = buildProjectPortfolioSummaries(projects, { coreOnly: true });
  const decision = buildShadowDecision(projects, portfolio, sourceRevision, options.now || new Date());
  appendDecisionEvent(globalRoot, decision);
  writeJsonAtomic(shadowSnapshotPath(globalRoot), decision);
  return decision;
}

export async function runCognitiveShadowDecisionCycle(
  options: ShadowCycleOptions & { engine: CognitiveShadowEngine }
): Promise<ShadowDecision> {
  const baseline = runShadowDecisionCycle(options);
  if (!baseline.recommendations.length) return baseline;
  const input: CognitiveShadowInput = {
    decisionId: baseline.decisionId,
    candidates: baseline.recommendations.map((item) => ({
      id: item.id,
      name: item.projectName,
      title: item.title,
      reason: item.reason,
      evidence: [...item.evidence],
      baselineRank: item.rank
    }))
  };
  const proposal = await options.engine.plan(input);
  const selected = baseline.recommendations.find((item) => item.id === String(proposal?.candidateId || ''));
  if (!selected) throw new Error('Cognitive engine selected an unknown Today arrangement candidate.');
  const reason = String(proposal.reason || '').trim();
  if (!reason) throw new Error('Cognitive engine did not explain its Today arrangement choice.');
  const recommendations = [
    { ...selected, reason },
    ...baseline.recommendations.filter((item) => item.id !== selected.id)
  ].map((item, index) => ({ ...item, rank: index + 1 }));
  const decision: ShadowDecision = {
    ...baseline,
    decisionId: stableHash(`${baseline.decisionId}:${options.engine.id}:${selected.id}:${reason}`),
    algorithmVersion: `${SHADOW_ALGORITHM_VERSION}+cognitive`,
    recommendedProjectPath: selected.projectPath,
    summary: `今天先推进 ${selected.projectName}：${selected.title}`,
    recommendations,
    engineId: options.engine.id,
    engineStatus: 'completed'
  };
  appendDecisionEvent(options.globalDataPath, decision);
  writeJsonAtomic(shadowSnapshotPath(options.globalDataPath), decision);
  return decision;
}

export function readCurrentShadowDecision(globalDataPath: string, projects: SolopreneurProject[]): ShadowDecision | null {
  const snapshotPath = shadowSnapshotPath(globalDataPath);
  if (!fs.existsSync(snapshotPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as ShadowDecision;
    if (parsed.schemaVersion !== 1 || parsed.source !== 'runtime_shadow' || parsed.status !== 'completed') return null;
    if (parsed.generatedAt.slice(0, 10) !== new Date().toISOString().slice(0, 10)) return null;
    if (parsed.sourceRevision !== buildProjectSourceRevision(projects)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readCurrentRegisteredShadowDecision(globalDataPath: string, projectRegistryFileName = 'projects.json'): ShadowDecision | null {
  const projects = getProjectsReadOnly({
    globalDataPath,
    projectRegistryFileName,
    legacyProjects: [],
    legacyHiddenProjects: []
  });
  return readCurrentShadowDecision(globalDataPath, projects);
}

export function projectShadowDecisionForToday(decision: ShadowDecision): any {
  return {
    schemaVersion: 1,
    decisionId: decision.decisionId,
    date: decision.generatedAt.slice(0, 10),
    generatedAt: decision.generatedAt,
    finishedAt: decision.generatedAt,
    rhythm: 'runtime',
    reviewMode: 'shadow_decision',
    source: 'runtime_shadow',
    status: 'completed',
    summary: decision.summary,
    todos: decision.recommendations.map((item) => ({
      id: item.id,
      title: item.title,
      reason: item.reason,
      projectPath: item.projectPath,
      nodeId: item.nodeId,
      action: item.action
    })),
    needsConfirmation: [],
    inputSnapshot: {
      projectCount: decision.projectCount,
      learningCandidateCount: 0,
      blockedDependencyCount: 0,
      reviewMode: 'shadow_decision'
    },
    baselineProjectPath: decision.baselineProjectPath,
    recommendedProjectPath: decision.recommendedProjectPath,
    sourceRevision: decision.sourceRevision,
    readOnly: true
  };
}

export function recordShadowDecisionFeedback(globalDataPath: string, input: ShadowFeedback): void {
  const feedbackPath = path.join(runtimeRoot(globalDataPath), 'shadow-feedback.jsonl');
  const operationId = String(input.operationId || '').trim();
  if (!operationId) throw new Error('Shadow feedback requires an operationId.');
  const snapshotPath = shadowSnapshotPath(globalDataPath);
  if (!fs.existsSync(snapshotPath)) throw new Error('Shadow feedback requires a current decision.');
  const decision = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as ShadowDecision;
  if (decision.decisionId !== input.decisionId) throw new Error('Shadow feedback decision is no longer current.');
  const selectedProjectPath = String(input.selectedProjectPath || '');
  if (!decision.recommendations.some(item => item.projectPath === selectedProjectPath)) {
    throw new Error('Shadow feedback target is not part of the current decision.');
  }
  const recommendedProjectPath = decision.recommendedProjectPath;
  const outcome = recommendedProjectPath === selectedProjectPath ? 'accepted' : 'overridden';
  const existing = fs.existsSync(feedbackPath)
    ? fs.readFileSync(feedbackPath, 'utf8').split('\n').filter(Boolean).some((line) => {
      try {
        return String(JSON.parse(line).operationId || '') === operationId;
      } catch {
        return false;
      }
    })
    : false;
  if (existing) return;
  fs.mkdirSync(path.dirname(feedbackPath), { recursive: true });
  fs.appendFileSync(feedbackPath, JSON.stringify({
    operationId,
    decisionId: String(input.decisionId || ''),
    baselineProjectPath: decision.baselineProjectPath,
    recommendedProjectPath,
    selectedProjectPath,
    outcome,
    recordedAt: String(input.recordedAt || new Date().toISOString())
  }) + '\n', { encoding: 'utf8', mode: 0o600 });
}
