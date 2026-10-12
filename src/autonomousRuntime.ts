import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { buildProjectPortfolioSummaries, ProjectPortfolioSummary } from './projectPortfolio';
import { cognitiveRuntimeConfigRevision, readCognitiveRuntimeConfig } from './cognitiveRuntimeConfig';
import { getProjectsReadOnly, normalizeGlobalDataPathForExtension, SolopreneurProject } from './projectRegistry';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import type { RuntimeDataOperations } from './runtimeDataOperations';
import { isProcessOwnerAlive, readProcessBirthMarker } from './processIdentity.js';

const SHADOW_ALGORITHM_VERSION = 'today-shadow-v1';
const shadowDecisions = new Map<string, ShadowDecision>();
const shadowFeedback = new Map<string, Array<Record<string, unknown>>>();

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
  learningCandidateCount?: number;
  ledgerEventCount?: number;
  ledgerCandidateCount?: number;
  confirmedLearningCount?: number;
  engineId?: string;
  engineConfigRevision?: string;
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

export interface ShadowDecisionEvaluation {
  schemaVersion: 1;
  updatedAt: string;
  feedbackCount: number;
  acceptedCount: number;
  overriddenCount: number;
  ignoredCount: number;
  cognitiveWins: number;
  baselineWins: number;
  ties: number;
  netGain: number;
  result: 'gain' | 'no_gain' | 'insufficient_evidence';
}

interface ShadowCycleOptions {
  globalDataPath: string;
  projectRegistryFileName?: string;
  projects?: SolopreneurProject[];
  now?: Date;
  beforeCommit?: () => boolean;
  engineConfigRevision?: string;
}

export interface RuntimeState {
  schemaVersion: 1;
  runtimeId: string;
  pid: number;
  processBirth?: string;
  status: 'running' | 'paused' | 'stopped' | 'failed';
  startedAt: string;
  heartbeatAt: string;
  databaseId?: string;
}

interface RuntimeLeaseOptions {
  runtimeId: string;
  pid: number;
  processBirth?: string;
  now?: Date;
  isProcessAlive?: (pid: number) => boolean;
  isProcessOwnerAlive?: (pid: number, birth: string) => boolean;
}

function runtimeRoot(globalDataPath: string): string {
  return path.join(normalizeGlobalDataPathForExtension(globalDataPath), 'runtime');
}

function runtimeStatePath(globalDataPath: string): string {
  return path.join(runtimeRoot(globalDataPath), 'control.json');
}

function runtimeClaimPath(globalDataPath: string): string {
  return path.join(runtimeRoot(globalDataPath), 'control.claim');
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

export function readRuntimeState(globalDataPath: string): RuntimeState | null {
  const candidates = [
    runtimeStatePath(globalDataPath),
    path.join(runtimeRoot(globalDataPath), 'state.json'),
    path.join(runtimeRoot(globalDataPath), 'owner.json')
  ];
  for (const statePath of candidates) {
    if (!fs.existsSync(statePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as RuntimeState;
      if (parsed.schemaVersion === 1 && parsed.runtimeId && Number.isInteger(parsed.pid)) return parsed;
    } catch {
      // Legacy state is import-only; continue to the next known location.
    }
  }
  return null;
}

export function claimRuntimeLease(globalDataPath: string, options: RuntimeLeaseOptions): { acquired: boolean; owner: RuntimeState } {
  fs.mkdirSync(runtimeRoot(globalDataPath), { recursive: true });
  const claimPath = runtimeClaimPath(globalDataPath);
  const claimOwnerPath = path.join(claimPath, 'owner.json');
  const reclaimedPath = `${claimPath}.reclaimed`;
  const processBirth = options.processBirth ?? readProcessBirthMarker(options.pid);
  const ownerAlive = (pid: number, birth = '') => options.isProcessOwnerAlive
    ? options.isProcessOwnerAlive(pid, birth)
    : options.isProcessAlive
      ? options.isProcessAlive(pid)
      : isProcessOwnerAlive(pid, birth);
  const claimToken = crypto.randomBytes(24).toString('hex');
  let acquiredClaim = false;
  for (let attempt = 0; attempt < 200 && !acquiredClaim; attempt += 1) {
    try {
      fs.mkdirSync(claimPath, { mode: 0o700 });
      fs.writeFileSync(claimOwnerPath, JSON.stringify({ schemaVersion: 1, runtimeId: options.runtimeId, pid: options.pid, processBirth, token: claimToken, createdAt: Date.now() }) + '\n', { mode: 0o600 });
      acquiredClaim = true;
      if (fs.existsSync(reclaimedPath)) {
        const reclaimedOwner = path.join(reclaimedPath, 'owner.json');
        if (fs.existsSync(reclaimedOwner)) fs.unlinkSync(reclaimedOwner);
        fs.rmdirSync(reclaimedPath);
      }
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      let live = true;
      let legacyFile = false;
      try {
        legacyFile = fs.statSync(claimPath).isFile();
        const file = legacyFile ? claimPath : claimOwnerPath;
        const claim = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number; processBirth?: string };
        live = ownerAlive(Number(claim.pid || 0), String(claim.processBirth || ''));
      } catch {
        try { live = Date.now() - fs.statSync(claimPath).mtimeMs < 500; }
        catch (statError: any) { if (statError?.code !== 'ENOENT') throw statError; }
      }
      if (live) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        continue;
      }
      if (legacyFile) {
        try { fs.unlinkSync(claimPath); } catch (unlinkError: any) { if (unlinkError?.code !== 'ENOENT') throw unlinkError; }
        continue;
      }
      if (fs.existsSync(reclaimedPath)) {
        try {
          const current = JSON.parse(fs.readFileSync(claimOwnerPath, 'utf8')) as { pid?: number; processBirth?: string };
          if (ownerAlive(Number(current.pid || 0), String(current.processBirth || ''))) continue;
          const reclaimedOwner = path.join(reclaimedPath, 'owner.json');
          if (fs.existsSync(reclaimedOwner)) fs.unlinkSync(reclaimedOwner);
          fs.rmdirSync(reclaimedPath);
        } catch (cleanupError: any) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(cleanupError?.code)) throw cleanupError;
          continue;
        }
      }
      try { fs.renameSync(claimPath, reclaimedPath); }
      catch (renameError: any) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(renameError?.code)) throw renameError;
      }
    }
  }
  if (!acquiredClaim) throw new Error('SoloMap Runtime lease claim is busy.');
  try {
  const now = options.now || new Date();
  const current = readRuntimeState(globalDataPath);
  if (
    current
    && (current.runtimeId !== options.runtimeId || current.pid !== options.pid || Boolean(current.processBirth && processBirth && current.processBirth !== processBirth))
    && ownerAlive(current.pid, current.processBirth || '')
  ) {
    // A delayed heartbeat or closing endpoint does not release a live owner's database.
    return { acquired: false, owner: current };
  }
  const owner: RuntimeState = {
    schemaVersion: 1,
    runtimeId: options.runtimeId,
    pid: options.pid,
    ...(processBirth ? { processBirth } : {}),
    status: 'running',
    startedAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    ...(current?.databaseId ? { databaseId: current.databaseId } : {})
  };
  writeJsonAtomic(runtimeStatePath(globalDataPath), owner);
  return { acquired: true, owner };
  } finally {
    try {
      const claim = JSON.parse(fs.readFileSync(claimOwnerPath, 'utf8')) as { token?: string };
      if (claim.token === claimToken) { fs.unlinkSync(claimOwnerPath); fs.rmdirSync(claimPath); }
    } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  }
}

export function hasRuntimeLease(globalDataPath: string, runtimeId: string, pid: number): boolean {
  const current = readRuntimeState(globalDataPath);
  return Boolean(current && current.runtimeId === runtimeId && current.pid === pid
    && (!current.processBirth || isProcessOwnerAlive(pid, current.processBirth))
    && (current.status === 'running' || current.status === 'paused'));
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
  shadowDecisions.set(normalizeGlobalDataPathForExtension(globalDataPath), structuredClone(decision));
}

export function runShadowDecisionCycle(options: ShadowCycleOptions): ShadowDecision {
  const globalRoot = normalizeGlobalDataPathForExtension(options.globalDataPath);
  const projects = options.projects || getProjectsReadOnly({
    globalDataPath: globalRoot,
    projectRegistryFileName: options.projectRegistryFileName || 'projects.json',
    legacyProjects: [],
    legacyHiddenProjects: []
  });
  const sourceRevision = buildProjectSourceRevision(projects);
  const portfolio = buildProjectPortfolioSummaries(projects, { coreOnly: true });
  const decision = buildShadowDecision(projects, portfolio, sourceRevision, options.now || new Date());
  appendDecisionEvent(globalRoot, decision);
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
    ...(options.engineConfigRevision ? { engineConfigRevision: options.engineConfigRevision } : {}),
    engineStatus: 'completed'
  };
  if (options.beforeCommit && !options.beforeCommit()) {
    throw new Error('Cognitive decision lease is no longer current.');
  }
  appendDecisionEvent(options.globalDataPath, decision);
  return decision;
}

export function readCurrentShadowDecision(globalDataPath: string, projects: SolopreneurProject[]): ShadowDecision | null {
  const parsed = shadowDecisions.get(normalizeGlobalDataPathForExtension(globalDataPath));
  if (!parsed) return null;
  try {
    if (parsed.schemaVersion !== 1 || parsed.source !== 'runtime_shadow' || parsed.status !== 'completed') return null;
    if (parsed.generatedAt.slice(0, 10) !== new Date().toISOString().slice(0, 10)) return null;
    if (parsed.sourceRevision !== buildProjectSourceRevision(projects)) return null;
    if (
      parsed.engineStatus === 'completed'
      && parsed.engineConfigRevision
      && parsed.engineConfigRevision !== cognitiveRuntimeConfigRevision(readCognitiveRuntimeConfig(globalDataPath))
    ) return null;
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

export function projectShadowDecisionForToday(decision: ShadowDecision, feedbackOutcome = ''): any {
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
    todos: decision.recommendations.slice(0, 6).map((item, index) => ({
      id: item.id,
      title: item.title,
      reason: item.reason,
      projectPath: item.projectPath,
      nodeId: item.nodeId,
      action: item.action,
      suggestionGroup: index < 3 ? 'today' : 'other'
    })),
    needsConfirmation: [],
    inputSnapshot: {
      projectCount: decision.projectCount,
      learningCandidateCount: decision.learningCandidateCount || 0,
      ledgerEventCount: decision.ledgerEventCount || 0,
      ledgerCandidateCount: decision.ledgerCandidateCount || 0,
      confirmedLearningCount: decision.confirmedLearningCount || 0,
      blockedDependencyCount: 0,
      reviewMode: 'shadow_decision'
    },
    baselineProjectPath: decision.baselineProjectPath,
    recommendedProjectPath: decision.recommendedProjectPath,
    sourceRevision: decision.sourceRevision,
    readOnly: true,
    ...(feedbackOutcome ? { feedbackOutcome } : {})
  };
}

export function readShadowDecisionFeedbackOutcome(globalDataPath: string, decisionId: string): string {
  const rows = shadowFeedback.get(normalizeGlobalDataPathForExtension(globalDataPath)) || [];
  for (let index = rows.length - 1; index >= 0; index -= 1) if (String(rows[index].decisionId || '') === decisionId) return String(rows[index].outcome || '');
  return '';
}

export async function recordShadowDecisionFeedback(globalDataPath: string, input: ShadowFeedback, operation?: RuntimeDataOperations): Promise<void> {
  await refreshShadowRuntimeState(globalDataPath, operation);
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  const operationId = String(input.operationId || '').trim();
  if (!operationId) throw new Error('Shadow feedback requires an operationId.');
  const decision = shadowDecisions.get(root);
  if (!decision) throw new Error('Shadow feedback requires a current decision.');
  if (decision.decisionId !== input.decisionId) throw new Error('Shadow feedback decision is no longer current.');
  if (readShadowDecisionFeedbackOutcome(globalDataPath, decision.decisionId) === 'ignored') return;
  const selectedProjectPath = String(input.selectedProjectPath || '');
  const ignored = input.outcome === 'ignored';
  if (!ignored && !decision.recommendations.some(item => item.projectPath === selectedProjectPath)) {
    throw new Error('Shadow feedback target is not part of the current decision.');
  }
  const recommendedProjectPath = decision.recommendedProjectPath;
  const outcome = ignored ? 'ignored' : recommendedProjectPath === selectedProjectPath ? 'accepted' : 'overridden';
  const rows = shadowFeedback.get(root) || [];
  const existing = rows.some(row => String(row.operationId || '') === operationId);
  if (existing) return;
  rows.push({
    operationId,
    decisionId: String(input.decisionId || ''),
    baselineProjectPath: decision.baselineProjectPath,
    recommendedProjectPath,
    selectedProjectPath,
    outcome,
    cognitive: decision.engineStatus === 'completed' && Boolean(decision.engineId),
    engineId: decision.engineId || '',
    recordedAt: String(input.recordedAt || new Date().toISOString())
  });
  shadowFeedback.set(root, rows);
  await persistShadowRuntimeState(root, operation, `shadow-feedback:${operationId}`);
}

function buildShadowDecisionEvaluation(globalDataPath: string): ShadowDecisionEvaluation {
  const rows = shadowFeedback.get(normalizeGlobalDataPathForExtension(globalDataPath)) || [];
  let cognitiveWins = 0;
  let baselineWins = 0;
  let ties = 0;
  for (const row of rows) {
    if (row.outcome === 'ignored' || row.cognitive !== true) continue;
    if (row.recommendedProjectPath === row.baselineProjectPath) {
      if (row.selectedProjectPath === row.recommendedProjectPath) ties += 1;
    } else if (row.selectedProjectPath === row.recommendedProjectPath) {
      cognitiveWins += 1;
    } else if (row.selectedProjectPath === row.baselineProjectPath) {
      baselineWins += 1;
    }
  }
  const netGain = cognitiveWins - baselineWins;
  const comparisonCount = cognitiveWins + baselineWins + ties;
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    feedbackCount: rows.length,
    acceptedCount: rows.filter(row => row.outcome === 'accepted').length,
    overriddenCount: rows.filter(row => row.outcome === 'overridden').length,
    ignoredCount: rows.filter(row => row.outcome === 'ignored').length,
    cognitiveWins,
    baselineWins,
    ties,
    netGain,
    result: comparisonCount === 0 ? 'insufficient_evidence' : netGain > 0 ? 'gain' : 'no_gain'
  };
}

export function readShadowDecisionEvaluation(globalDataPath: string): ShadowDecisionEvaluation {
  return buildShadowDecisionEvaluation(globalDataPath);
}

function shadowOperation(globalDataPath: string, operation?: RuntimeDataOperations) {
  return (name: string, input: Record<string, unknown>) => operation ? operation({ operation: name, input }) : sendRuntimeDataRequest(globalDataPath, { operation: name, input });
}

export async function refreshShadowRuntimeState(globalDataPath: string, operation?: RuntimeDataOperations): Promise<void> {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  const result = await shadowOperation(root, operation)('read_host_settings', { namespace: 'runtime_shadow', ownerScope: 'global' }) as { items: Array<{ key: string; value?: unknown }> };
  const values = new Map(result.items.map(item => [item.key, item.value]));
  const decision = values.get('decision');
  const feedback = values.get('feedback');
  if (decision && typeof decision === 'object') shadowDecisions.set(root, decision as ShadowDecision);
  if (Array.isArray(feedback)) shadowFeedback.set(root, feedback as Array<Record<string, unknown>>);
}

export async function persistShadowRuntimeState(globalDataPath: string, operation?: RuntimeDataOperations, idempotencyKey = `runtime-shadow:${crypto.randomUUID()}`): Promise<void> {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  const call = shadowOperation(root, operation);
  const desiredDecision = shadowDecisions.get(root) ? structuredClone(shadowDecisions.get(root)!) : undefined;
  if (desiredDecision) {
    const learning = await call('read_learning_overview', {}) as {
      eventCount?: number;
      candidateCount?: number;
      approvedCount?: number;
      promotedCount?: number;
    };
    desiredDecision.learningCandidateCount = Number(learning.candidateCount || 0);
    desiredDecision.ledgerEventCount = Number(learning.eventCount || 0);
    desiredDecision.ledgerCandidateCount = Number(learning.candidateCount || 0);
    desiredDecision.confirmedLearningCount = Number(learning.approvedCount || 0) + Number(learning.promotedCount || 0);
    shadowDecisions.set(root, structuredClone(desiredDecision));
  }
  const desiredFeedback = structuredClone(shadowFeedback.get(root) || []);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await call('read_host_settings', { namespace: 'runtime_shadow', ownerScope: 'global' }) as { items: Array<{ key: string; revision: number; value?: unknown }> };
    const fields = new Map(result.items.map(item => [item.key, item]));
    const remoteDecision = fields.get('decision')?.value as ShadowDecision | undefined;
    const decision = !remoteDecision || desiredDecision && Date.parse(desiredDecision.generatedAt) >= Date.parse(remoteDecision.generatedAt)
      ? desiredDecision
      : remoteDecision;
    const feedbackByOperation = new Map<string, Record<string, unknown>>();
    const remoteFeedback = Array.isArray(fields.get('feedback')?.value) ? fields.get('feedback')!.value as Array<Record<string, unknown>> : [];
    for (const row of [...remoteFeedback, ...desiredFeedback]) {
      const operationId = String(row.operationId || '').trim();
      if (operationId) feedbackByOperation.set(operationId, row);
    }
    const feedback = [...feedbackByOperation.values()];
    if (decision) shadowDecisions.set(root, decision);
    shadowFeedback.set(root, feedback);
    const patches = [
      ...(decision ? [{ key: 'decision', expectedRevision: fields.get('decision')?.revision || 0, value: decision }] : []),
      { key: 'feedback', expectedRevision: fields.get('feedback')?.revision || 0, value: feedback },
      { key: 'evaluation', expectedRevision: fields.get('evaluation')?.revision || 0, value: buildShadowDecisionEvaluation(root) }
    ];
    try {
      await call('patch_host_settings', { namespace: 'runtime_shadow', ownerScope: 'global', patches, idempotencyKey });
      return;
    } catch (error) {
      if ((error as Error).message !== 'revision_conflict' || attempt === 4) throw error;
    }
  }
}
