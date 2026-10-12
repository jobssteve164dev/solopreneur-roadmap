import * as path from 'path';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { runtimeMcpSource } from './runtimeDataOperations';
import type { DataObject } from './db/unifiedDataStore';
import { isTrashOrLocalPrivate } from './learningQuality.js';
export { isTrashOrLocalPrivate } from './learningQuality.js';

export type LearningSourceType = 'step_run' | 'solo' | 'flow_loop' | 'review' | 'roadmap_revision' | 'issue' | 'release' | 'strategy' | 'user_correction';
export type LearningEventType = 'completed' | 'failed' | 'verified' | 'deviated' | 'corrected' | 'blocked' | 'reused' | 'partial' | 'needs_confirmation';
export type LessonType = 'verification_pattern' | 'boundary_rule' | 'planning_rule' | 'risk_pattern' | 'implementation_pattern' | 'strategy_signal' | 'user_preference';

export interface LearningEvidenceRef {
  type: 'file' | 'trace' | 'run_digest' | 'flow' | 'command' | 'memory' | 'user';
  ref: string;
  summary?: string;
}

export interface LearningEvent {
  schemaVersion: 1;
  id: string;
  projectId: string;
  projectPath: string;
  projectName: string;
  sourceType: LearningSourceType;
  sourceRef: string;
  eventType: LearningEventType;
  summary: string;
  evidenceRefs: LearningEvidenceRef[];
  tags: string[];
  createdAt: string;
  metadata?: Record<string, any>;
}

export interface LessonCandidate {
  verification?: string;
  doesNotApplyWhen?: string;
  schemaVersion: 1;
  id: string;
  projectId: string;
  projectPath: string;
  projectName: string;
  sourceEventIds: string[];
  sourceType: LearningSourceType;
  lessonType: LessonType;
  summary: string;
  appliesWhen: string;
  doThis: string;
  avoidThis: string;
  evidenceRefs: LearningEvidenceRef[];
  confidence: 'low' | 'medium' | 'high' | number;
  status: 'candidate' | 'approved' | 'rejected' | 'promoted';
  promotionTarget: 'project_memory' | 'pattern' | 'decision' | 'domain' | 'operating_rule' | 'strategy_signal';
  createdAt: string;
  updatedAt: string;
  sourceRef?: { objectId: string; revision: number };
}

export interface LearningPromotionSuggestion {
  schemaVersion: 1;
  id: string;
  candidateId: string;
  projectId: string;
  projectPath: string;
  projectName: string;
  lessonType: LessonType;
  promotionTarget: LessonCandidate['promotionTarget'];
  targetPath: string;
  reason: string;
  status: 'suggested';
  draftMarkdown: string;
  evidenceRefs: LearningEvidenceRef[];
  createdAt: string;
  updatedAt: string;
}

export interface LearningCandidateDecision {
  schemaVersion: 1;
  id: string;
  eventId: string;
  projectId: string;
  projectPath: string;
  projectName: string;
  decision: 'created' | 'skipped';
  candidateIds: string[];
  reason: string;
  checkedSignals: string[];
  evidenceRefs: LearningEvidenceRef[];
  createdAt: string;
  updatedAt: string;
}

export interface LearningSummary {
  globalRoot: string;
  eventCount: number;
  candidateCount: number;
  candidateDecisionCount: number;
  skippedCandidateDecisionCount: number;
  approvedCount: number;
  promotedCount: number;
  recentEvents: LearningEvent[];
  recentCandidates: LessonCandidate[];
  projectSignals: Array<{
    projectId: string;
    projectName: string;
    projectPath: string;
    eventCount: number;
    candidateCount: number;
    promotedCount: number;
    latestAt: string;
    riskSignals: number;
    verificationSignals: number;
    strategySignals: number;
  }>;
}

export interface LearningRetrievalQuery {
  projectPath: string;
  runKind: string;
  role?: string;
  contextText: string;
  files?: string[];
  limit?: number;
}

export type LearningOverview = Omit<LearningSummary, 'globalRoot' | 'recentEvents' | 'recentCandidates'>;

export async function readLearningOverview(workspaceRoot: string, globalDataPath = ''): Promise<LearningOverview> {
  return sendRuntimeDataRequest<LearningOverview>(normalizeSolomapGlobalPath(workspaceRoot, globalDataPath), { operation: 'read_learning_overview', input: {} });
}

function normalizeSolomapGlobalPath(workspaceRoot: string, globalDataPath = ''): string {
  return normalizeGlobalDataPathForExtension(globalDataPath, workspaceRoot);
}

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizeProjectPaths(text: string, workspaceRoot: string): string {
  if (!text) return '';
  let cleaned = text;
  const normalizedWorkspace = path.resolve(workspaceRoot).replace(/\\/g, '/');
  cleaned = cleaned.replace(new RegExp(escapeRegExp(normalizedWorkspace), 'gi'), '<projectRoot>');
  cleaned = cleaned.replace(/\/home\/[a-zA-Z0-9_-]+/gi, '<home>');
  cleaned = cleaned.replace(/\/Users\/[a-zA-Z0-9_-]+/gi, '<home>');
  cleaned = cleaned.replace(/\/tmp\/[a-zA-Z0-9_-]+/gi, '<tmp>');
  cleaned = cleaned.replace(/__solo__\/[0-9]+/gi, '__solo__/<runId>');
  cleaned = cleaned.replace(/agent-runs\/[^\/]+/gi, 'agent-runs/<runGroup>');
  return cleaned;
}

function scoreCandidate(candidate: LessonCandidate, query: LearningRetrievalQuery): number {
  const projectMatch = candidate.projectPath === query.projectPath ? 20 : 0;
  const context = `${query.contextText || ''} ${(query.files || []).join(' ')} ${query.runKind || ''} ${query.role || ''}`.toLowerCase();
  const haystack = [
    candidate.summary,
    candidate.appliesWhen,
    candidate.doThis,
    candidate.avoidThis,
    candidate.lessonType,
    candidate.evidenceRefs.map((ref) => `${ref.ref} ${ref.summary || ''}`).join(' ')
  ].join(' ').toLowerCase();
  const tokens = context.split(/[^a-z0-9_\-/.一-龥]+/i).map((token) => token.trim()).filter((token) => token.length >= 2).slice(0, 80);
  const tokenScore = tokens.reduce((score, token) => score + (haystack.includes(token) ? 2 : 0), 0);
  const roleScore = query.role === 'verifier' && candidate.lessonType === 'verification_pattern' ? 8
    : query.role === 'planner' && (candidate.lessonType === 'planning_rule' || candidate.lessonType === 'risk_pattern') ? 8
      : query.role === 'builder' && candidate.lessonType === 'implementation_pattern' ? 8
        : 0;
  const statusScore = candidate.status === 'promoted' || candidate.status === 'approved' ? 8 : 2;
  return projectMatch + tokenScore + roleScore + statusScore;
}

function lessonCandidateFromObject(object: DataObject, workspaceRoot: string, projectId: string): LessonCandidate {
  const data = object.data;
  const list = (field: string): any[] => {
    if (data[field] == null) return [];
    const value = JSON.parse(String(data[field]));
    if (!Array.isArray(value)) throw new Error(`lesson_field_invalid: ${field}`);
    return value;
  };
  return {
    schemaVersion: 1, id: object.objectId, projectId: object.projectId || '',
    projectPath: object.projectId === projectId ? workspaceRoot : '',
    projectName: object.projectId === projectId ? path.basename(workspaceRoot) : '',
    sourceEventIds: list('source_event_ids_json'),
    sourceType: String(data.source_type || '') as LearningSourceType,
    lessonType: String(data.lesson_type || '') as LessonType,
    summary: String(data.summary || ''), appliesWhen: String(data.applies_when || ''),
    doThis: String(data.do_this || ''), avoidThis: String(data.avoid_this || ''),
    doesNotApplyWhen: String(data.does_not_apply_when || ''), verification: String(data.verification || ''),
    evidenceRefs: list('evidence_refs_json'), confidence: ({ low: 0, medium: 0.5, high: 1 } as Record<string, number>)[String(data.external_confidence)] === data.confidence ? String(data.external_confidence) as LessonCandidate['confidence'] : Number(data.confidence),
    status: String(data.status) as LessonCandidate['status'],
    promotionTarget: String(data.promotion_target || '') as LessonCandidate['promotionTarget'],
    createdAt: new Date(Number(data.external_created_at ?? object.createdAt)).toISOString(), updatedAt: new Date(Number(data.external_updated_at ?? object.updatedAt)).toISOString(),
    sourceRef: { objectId: object.objectId, revision: object.revision }
  };
}

export async function buildLearningRetrievalContext(workspaceRoot: string, globalDataPath: string, query: LearningRetrievalQuery): Promise<string> {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const { projectId } = await sendRuntimeDataRequest<{ projectId: string }>(globalRoot, { operation: 'register_project', input: { root: workspaceRoot } });
  const source = runtimeMcpSource(globalRoot, projectId, true);
  let objects: DataObject[];
  try {
    for (;;) {
      const items: DataObject[] = []; let cursor: string | null = null; let changed = false;
      do {
        const page = await source.call('context', { project: projectId, kinds: ['lesson'], view: 'metadata', limit: 100, ...(cursor ? { cursor } : {}) }) as { items: DataObject[]; cursor: string | null; sourceChanged: boolean };
        if (page.sourceChanged) { changed = true; break; }
        items.push(...page.items); cursor = page.cursor;
      } while (cursor);
      if (!changed) { objects = items; break; }
    }
  } finally { await source.close?.(); }
  const scored = objects.map(object => lessonCandidateFromObject(object, workspaceRoot, projectId))
    .filter(candidate => candidate.status === 'approved')
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, query) }))
    .filter((entry) => entry.score >= 6 && !isTrashOrLocalPrivate(entry.candidate))
    .sort((a, b) => b.score - a.score || String(b.candidate.updatedAt || '').localeCompare(String(a.candidate.updatedAt || '')));

  const seenSummaries = new Set<string>();
  const candidates: LessonCandidate[] = [];
  for (const entry of scored) {
    const key = entry.candidate.summary.trim().toLowerCase();
    if (seenSummaries.has(key)) {
      continue;
    }
    seenSummaries.add(key);
    candidates.push(entry.candidate);
    if (candidates.length >= (query.limit || 5)) {
      break;
    }
  }

  if (candidates.length === 0) {
    return '';
  }
  return [
    'SoloMap 统一学习账本召回：',
    ...candidates.map((candidate, index) => [
      `${index + 1}. ${candidate.summary}`,
      `   - 经验标识：${candidate.id}`,
      `   - 来源：solomap://objects/${candidate.sourceRef!.objectId} · revision=${candidate.sourceRef!.revision}`,
      `   - 类型：${candidate.lessonType} / 状态：${candidate.status} / 置信度：${candidate.confidence}`,
      `   - 适用：${candidate.appliesWhen}`,
      `   - 本轮应做：${candidate.doThis}`,
      `   - 避免：${candidate.avoidThis}`,
      ...(candidate.doesNotApplyWhen ? [`   - 不适用：${candidate.doesNotApplyWhen}`] : []),
      ...(candidate.verification ? [`   - 验证：${candidate.verification}`] : []),
      `   - 证据：${candidate.evidenceRefs.map(ref => ref.ref).join('；')}`
    ].join('\n'))
  ].join('\n');
}
