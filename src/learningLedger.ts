import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

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
  confidence: 'low' | 'medium' | 'high';
  status: 'candidate' | 'approved' | 'rejected' | 'promoted';
  promotionTarget: 'project_memory' | 'pattern' | 'decision' | 'domain' | 'operating_rule' | 'strategy_signal';
  createdAt: string;
  updatedAt: string;
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

function normalizeSolomapGlobalPath(workspaceRoot: string, globalDataPath = ''): string {
  const trimmed = String(globalDataPath || '').trim();
  if (trimmed) {
    return trimmed.endsWith('.solomap-global') ? trimmed : path.join(trimmed, '.solomap-global');
  }
  const baseRoot = workspaceRoot || process.cwd();
  return path.join(path.dirname(baseRoot), '.solomap-global');
}

function slugify(value: string): string {
  return String(value || 'project')
    .replace(/^\.+/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'project';
}

function stableId(prefix: string, parts: Array<string | number>): string {
  const hash = crypto.createHash('sha1').update(parts.map((part) => String(part || '')).join('\n')).digest('hex').slice(0, 16);
  return `${prefix}-${hash}`;
}

function compactLine(value: string, maxLength = 260): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function isTrashOrLocalPrivate(candidate: {
  summary: string;
  appliesWhen: string;
  doThis: string;
  avoidThis: string;
  promotionTarget?: string;
}): boolean {
  const textToCheck = `${candidate.summary}\n${candidate.appliesWhen}\n${candidate.doThis}\n${candidate.avoidThis}`.toLowerCase();
  if (textToCheck.includes('run completed without explicit verification signal in captured tail')) {
    return true;
  }
  if (
    candidate.promotionTarget === 'pattern' ||
    candidate.promotionTarget === 'operating_rule' ||
    candidate.promotionTarget === 'decision' ||
    candidate.promotionTarget === 'domain' ||
    !candidate.promotionTarget
  ) {
    if (
      textToCheck.includes('/home/') ||
      textToCheck.includes('/users/') ||
      textToCheck.includes('/tmp/') ||
      textToCheck.includes('__solo__') ||
      textToCheck.includes('/agent-runs/')
    ) {
      return true;
    }
  }
  return false;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function getLearningLedgerPaths(workspaceRoot: string, globalDataPath = ''): {
  globalRoot: string;
  learningRoot: string;
  ledgerRoot: string;
  eventsPath: string;
  sourcesRoot: string;
  indexPath: string;
  candidatesRoot: string;
  approvedRoot: string;
  rejectedRoot: string;
  promotionSuggestionsRoot: string;
  candidateDecisionsRoot: string;
} {
  const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
  const learningRoot = path.join(globalRoot, 'learning');
  const ledgerRoot = path.join(learningRoot, 'ledger');
  return {
    globalRoot,
    learningRoot,
    ledgerRoot,
    eventsPath: path.join(ledgerRoot, 'events.jsonl'),
    sourcesRoot: path.join(ledgerRoot, 'sources'),
    indexPath: path.join(ledgerRoot, 'index.json'),
    candidatesRoot: path.join(learningRoot, 'candidates'),
    approvedRoot: path.join(learningRoot, 'approved'),
    rejectedRoot: path.join(learningRoot, 'rejected'),
    promotionSuggestionsRoot: path.join(learningRoot, 'promotion-suggestions'),
    candidateDecisionsRoot: path.join(learningRoot, 'candidate-decisions')
  };
}

export function ensureLearningLedgerStore(workspaceRoot: string, globalDataPath = ''): ReturnType<typeof getLearningLedgerPaths> {
  const paths = getLearningLedgerPaths(workspaceRoot, globalDataPath);
  [paths.learningRoot, paths.ledgerRoot, paths.sourcesRoot, paths.candidatesRoot, paths.approvedRoot, paths.rejectedRoot, paths.promotionSuggestionsRoot, paths.candidateDecisionsRoot].forEach(ensureDir);
  if (!fs.existsSync(paths.eventsPath)) {
    fs.writeFileSync(paths.eventsPath, '', 'utf8');
  }
  if (!fs.existsSync(paths.indexPath)) {
    fs.writeFileSync(paths.indexPath, JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), eventCount: 0, byProject: {} }, null, 2) + '\n', 'utf8');
  }
  return paths;
}

function safeReadJson<T>(filePath: string): T | null {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) as T : null;
  } catch {
    return null;
  }
}

function readJsonl<T>(filePath: string, limit = 500): T[] {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(Math.max(0, lines.length - limit)).map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

function listJsonFiles(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath).filter((name) => name.endsWith('.json')).map((name) => path.join(dirPath, name));
  } catch {
    return [];
  }
}

function updateLedgerIndex(paths: ReturnType<typeof getLearningLedgerPaths>, event: LearningEvent): void {
  const index = safeReadJson<any>(paths.indexPath) || { schemaVersion: 1, byProject: {} };
  const byProject = index.byProject || {};
  const current = byProject[event.projectId] || { projectName: event.projectName, projectPath: event.projectPath, eventCount: 0, latestAt: '' };
  byProject[event.projectId] = {
    ...current,
    projectName: event.projectName,
    projectPath: event.projectPath,
    eventCount: Number(current.eventCount || 0) + 1,
    latestAt: event.createdAt
  };
  fs.writeFileSync(paths.indexPath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    eventCount: Number(index.eventCount || 0) + 1,
    byProject
  }, null, 2) + '\n', 'utf8');
}

export function appendLearningEvent(
  workspaceRoot: string,
  globalDataPath: string,
  input: Omit<LearningEvent, 'schemaVersion' | 'id' | 'projectId' | 'projectPath' | 'projectName' | 'createdAt'> & {
    projectPath?: string;
    projectName?: string;
    createdAt?: string;
    sourcePayload?: unknown;
  }
): LearningEvent {
  const eventProjectPath = input.projectPath || workspaceRoot;
  const projectName = input.projectName || path.basename(eventProjectPath || workspaceRoot || 'project');
  const projectId = slugify(projectName);
  const createdAt = input.createdAt || new Date().toISOString();
  const event: LearningEvent = {
    schemaVersion: 1,
    id: stableId('evt', [projectId, input.sourceType, input.sourceRef, input.eventType, createdAt, input.summary]),
    projectId,
    projectPath: eventProjectPath,
    projectName,
    sourceType: input.sourceType,
    sourceRef: input.sourceRef,
    eventType: input.eventType,
    summary: compactLine(input.summary, 600),
    evidenceRefs: input.evidenceRefs || [],
    tags: (input.tags || []).map((tag) => slugify(tag.toLowerCase())).filter(Boolean).slice(0, 24),
    createdAt,
    metadata: input.metadata || {}
  };
  const paths = ensureLearningLedgerStore(workspaceRoot, globalDataPath);
  fs.appendFileSync(paths.eventsPath, JSON.stringify(event) + '\n', 'utf8');
  if (input.sourcePayload !== undefined) {
    const sourcePath = path.join(paths.sourcesRoot, `${event.id}.json`);
    fs.writeFileSync(sourcePath, JSON.stringify(input.sourcePayload, null, 2) + '\n', 'utf8');
  }
  updateLedgerIndex(paths, event);
  extractLessonCandidatesFromEvent(workspaceRoot, globalDataPath, event);
  return event;
}

function candidateFromEvent(event: LearningEvent, lessonType: LessonType, summary: string, options: Partial<LessonCandidate>): LessonCandidate {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: stableId('lesson', [event.id, lessonType, summary]),
    projectId: event.projectId,
    projectPath: event.projectPath,
    projectName: event.projectName,
    sourceEventIds: [event.id],
    sourceType: event.sourceType,
    lessonType,
    summary: compactLine(summary, 520),
    appliesWhen: options.appliesWhen || '后续任务出现相同目标、相同失败闸门、相同文件区域或相同验证需要时。',
    doThis: options.doThis || '在下一次执行前召回这条经验，并把它转成具体计划、边界或验证动作。',
    avoidThis: options.avoidThis || '不要只复述历史日志；必须用证据约束下一步动作。',
    evidenceRefs: event.evidenceRefs,
    confidence: options.confidence || 'medium',
    status: options.status || 'candidate',
    promotionTarget: options.promotionTarget || 'pattern',
    createdAt: now,
    updatedAt: now
  };
}

function checkedSignalsForEvent(event: LearningEvent): string[] {
  const metadata = event.metadata || {};
  return [
    `sourceType:${event.sourceType}`,
    `eventType:${event.eventType}`,
    metadata.recommendedStatus ? `recommendedStatus:${metadata.recommendedStatus}` : '',
    metadata.role ? `role:${metadata.role}` : '',
    Array.isArray(metadata.verification) && metadata.verification.length > 0 ? 'verification:present' : 'verification:empty',
    Array.isArray(metadata.failures) && metadata.failures.length > 0 ? 'failures:present' : 'failures:empty'
  ].filter(Boolean).map((item) => compactLine(item, 180));
}

function candidateDecisionPath(paths: ReturnType<typeof getLearningLedgerPaths>, eventId: string): string {
  return path.join(paths.candidateDecisionsRoot, `${stableId('cand-decision', [eventId])}.json`);
}

function writeCandidateDecision(
  paths: ReturnType<typeof getLearningLedgerPaths>,
  event: LearningEvent,
  candidates: LessonCandidate[],
  reason: string
): LearningCandidateDecision {
  const decisionPath = candidateDecisionPath(paths, event.id);
  const existing = safeReadJson<LearningCandidateDecision>(decisionPath);
  if (existing && existing.schemaVersion === 1) {
    return existing;
  }
  const now = new Date().toISOString();
  const decision: LearningCandidateDecision = {
    schemaVersion: 1,
    id: stableId('cand-decision', [event.id]),
    eventId: event.id,
    projectId: event.projectId,
    projectPath: event.projectPath,
    projectName: event.projectName,
    decision: candidates.length > 0 ? 'created' : 'skipped',
    candidateIds: candidates.map((candidate) => candidate.id),
    reason: compactLine(reason, 360),
    checkedSignals: checkedSignalsForEvent(event),
    evidenceRefs: event.evidenceRefs || [],
    createdAt: now,
    updatedAt: now
  };
  fs.writeFileSync(decisionPath, JSON.stringify(decision, null, 2) + '\n', 'utf8');
  return decision;
}

export function extractLessonCandidatesFromEvent(workspaceRoot: string, globalDataPath: string, event: LearningEvent): LessonCandidate[] {
  const candidates: LessonCandidate[] = [];
  const metadata = event.metadata || {};
  const status = String(metadata.recommendedStatus || event.eventType || '').toLowerCase();
  const role = String(metadata.role || '').toLowerCase();
  const verification = Array.isArray(metadata.verification) ? metadata.verification : [];
  const failures = Array.isArray(metadata.failures) ? metadata.failures : [];

  if (event.eventType === 'corrected' || event.sourceType === 'user_correction') {
    candidates.push(candidateFromEvent(event, 'user_preference', `用户纠偏应成为后续执行约束：${event.summary}`, {
      appliesWhen: '后续任务出现相同用户体验、边界、文案、执行方式或偏航信号时。',
      doThis: '优先按用户纠偏后的语义执行，并在动手前检查是否会重复偏航。',
      avoidThis: '不要把用户纠偏降级成局部实现细节。',
      confidence: 'high',
      promotionTarget: 'operating_rule'
    }));
  }

  if (event.sourceType === 'flow_loop' && role === 'verifier' && ['deviated', 'partial', 'verified_failed', 'implemented_unverified', 'no_effect', 'needs_confirmation'].includes(status)) {
    candidates.push(candidateFromEvent(event, 'risk_pattern', `Flow 验证暴露未闭环风险：${event.summary}`, {
      appliesWhen: '后续 Flow 或普通执行出现相同 H/I/J 失败、无证据变更、偏离目标或部分完成时。',
      doThis: 'Planner 必须把失败闸门提前写进计划，Verifier 必须复核同类证据。',
      avoidThis: '不要把 partial、deviated 或 implemented_unverified 包装成完成。',
      confidence: 'high',
      promotionTarget: 'project_memory'
    }));
  }

  if ((event.eventType === 'failed' || event.eventType === 'blocked') && failures.length > 0) {
    candidates.push(candidateFromEvent(event, 'risk_pattern', `执行失败模式待复用排障：${compactLine(failures.join(' / '), 360)}`, {
      appliesWhen: '后续运行命中相同失败类别、相同命令或相同文件区域时。',
      doThis: '先复核已知失败原因，再决定重试、回退、补验证或调整计划。',
      avoidThis: '不要无视同类失败历史直接重复上一条路径。',
      confidence: 'medium',
      promotionTarget: 'project_memory'
    }));
  }

  if ((event.eventType === 'verified' || event.eventType === 'completed') && verification.length > 0) {
    candidates.push(candidateFromEvent(event, 'verification_pattern', `验证动作已证明有效：${compactLine(verification.join(' / '), 360)}`, {
      appliesWhen: '后续任务改动相同模块、运行同类测试或需要证明同类闭环时。',
      doThis: '优先复用或改写这组验证动作，直接验证最终产物。',
      avoidThis: '不要只凭实现描述宣称完成。',
      confidence: event.eventType === 'verified' ? 'high' : 'medium',
      promotionTarget: 'pattern'
    }));
  }

  if (event.sourceType === 'strategy') {
    candidates.push(candidateFromEvent(event, 'strategy_signal', `战略判断信号：${event.summary}`, {
      appliesWhen: '路线图调整、项目优先级排序、战略金字塔或今日推荐需要判断加码/收缩时。',
      doThis: '把这条战略信号作为组合判断证据，而不是执行日志。',
      avoidThis: '不要把未确认候选直接当成战略事实。',
      confidence: 'medium',
      promotionTarget: 'strategy_signal'
    }));
  }

  const paths = ensureLearningLedgerStore(workspaceRoot, globalDataPath);
  if (candidates.length === 0) {
    writeCandidateDecision(paths, event, [], 'no_reusable_candidate_signal_matched');
    return [];
  }
  const written: LessonCandidate[] = [];
  for (const candidate of candidates) {
    const candidatePath = path.join(paths.candidatesRoot, `${candidate.id}.json`);
    if (!fs.existsSync(candidatePath)) {
      fs.writeFileSync(candidatePath, JSON.stringify(candidate, null, 2) + '\n', 'utf8');
      written.push(candidate);
    }
  }
  writeCandidateDecision(paths, event, candidates, written.length > 0 ? 'candidate_created' : 'candidate_already_exists');
  maybeWritePromotionSuggestions(workspaceRoot, globalDataPath, written);
  return written;
}

export function reconcileLearningCandidateDecisions(workspaceRoot: string, globalDataPath = ''): {
  eventsChecked: number;
  decisionsCreated: number;
  candidatesCreated: number;
} {
  const paths = ensureLearningLedgerStore(workspaceRoot, globalDataPath);
  const events = readJsonl<LearningEvent>(paths.eventsPath, 2000).filter((event) => event && event.schemaVersion === 1);
  let decisionsCreated = 0;
  let candidatesCreated = 0;
  for (const event of events) {
    if (fs.existsSync(candidateDecisionPath(paths, event.id))) {
      continue;
    }
    const beforeDecisionExists = fs.existsSync(candidateDecisionPath(paths, event.id));
    const candidates = extractLessonCandidatesFromEvent(workspaceRoot, globalDataPath, event);
    if (!beforeDecisionExists && fs.existsSync(candidateDecisionPath(paths, event.id))) {
      decisionsCreated += 1;
    }
    candidatesCreated += candidates.length;
  }
  return {
    eventsChecked: events.length,
    decisionsCreated,
    candidatesCreated
  };
}

function reconcileLearningCandidateDecisionsBestEffort(workspaceRoot: string, globalDataPath = ''): void {
  try {
    reconcileLearningCandidateDecisions(workspaceRoot, globalDataPath);
  } catch {
    // Learning reconciliation must not block prompt retrieval or project summaries.
  }
}

function readCandidates(paths: ReturnType<typeof getLearningLedgerPaths>): LessonCandidate[] {
  const roots = [paths.candidatesRoot, paths.approvedRoot];
  return roots.flatMap((root) => listJsonFiles(root).map((file) => safeReadJson<LessonCandidate>(file)).filter((item): item is LessonCandidate => Boolean(item && item.schemaVersion === 1)));
}

function readCandidateDecisions(paths: ReturnType<typeof getLearningLedgerPaths>): LearningCandidateDecision[] {
  return listJsonFiles(paths.candidateDecisionsRoot)
    .map((file) => safeReadJson<LearningCandidateDecision>(file))
    .filter((item): item is LearningCandidateDecision => Boolean(item && item.schemaVersion === 1));
}

function readPromotionSuggestions(paths: ReturnType<typeof getLearningLedgerPaths>): LearningPromotionSuggestion[] {
  return listJsonFiles(paths.promotionSuggestionsRoot)
    .map((file) => safeReadJson<LearningPromotionSuggestion>(file))
    .filter((item): item is LearningPromotionSuggestion => Boolean(item && item.schemaVersion === 1));
}

function getProjectMemoryFilePath(projectPath: string, globalRoot: string): string {
  const projectSlug = slugify(path.basename(projectPath || 'project').toLowerCase());
  return path.join(globalRoot, 'memory', 'projects', `${projectSlug}.md`);
}

function promotionTargetPath(candidate: LessonCandidate, globalRoot: string): string {
  const memoryRoot = path.join(globalRoot, 'memory');
  if (candidate.promotionTarget === 'operating_rule') {
    return path.join(memoryRoot, 'operating-rules.md');
  }
  if (candidate.promotionTarget === 'project_memory') {
    return getProjectMemoryFilePath(candidate.projectPath, globalRoot);
  }
  if (candidate.promotionTarget === 'pattern') {
    return path.join(memoryRoot, 'patterns', `${slugify(candidate.lessonType)}.md`);
  }
  if (candidate.promotionTarget === 'decision') {
    return path.join(memoryRoot, 'decisions', `${new Date().toISOString().slice(0, 10)}-${slugify(candidate.lessonType)}.md`);
  }
  if (candidate.promotionTarget === 'domain') {
    return path.join(memoryRoot, 'domains', `${slugify(candidate.lessonType)}.md`);
  }
  return path.join(memoryRoot, 'inbox', 'strategy-signals.md');
}

function normalizedLessonKey(candidate: LessonCandidate): string {
  return [
    candidate.projectId,
    candidate.lessonType,
    candidate.promotionTarget,
    compactLine(candidate.summary, 120).toLowerCase().replace(/[^a-z0-9一-龥]+/g, ' ').trim()
  ].join('|');
}

function countSimilarCandidates(candidate: LessonCandidate, allCandidates: LessonCandidate[]): number {
  const key = normalizedLessonKey(candidate);
  return allCandidates.filter((item) => normalizedLessonKey(item) === key).length;
}

function hasEvidence(candidate: LessonCandidate): boolean {
  return Array.isArray(candidate.evidenceRefs) && candidate.evidenceRefs.length > 0;
}

function promotionReason(candidate: LessonCandidate, allCandidates: LessonCandidate[]): string {
  if (candidate.confidence === 'high' && hasEvidence(candidate)) {
    return 'high_confidence_with_evidence';
  }
  if (candidate.lessonType === 'verification_pattern' && candidate.evidenceRefs.some((ref) => ref.type === 'command')) {
    return 'verified_command_pattern';
  }
  if (countSimilarCandidates(candidate, allCandidates) >= 2 && hasEvidence(candidate)) {
    return 'repeated_candidate_with_evidence';
  }
  return '';
}

function buildPromotionDraft(candidate: LessonCandidate, reason: string): string {
  return [
    `## ${candidate.summary}`,
    '',
    `- Source candidate: ${candidate.id}`,
    `- Lesson type: ${candidate.lessonType}`,
    `- Promotion reason: ${reason}`,
    `- Applies when: ${candidate.appliesWhen}`,
    `- Do this: ${candidate.doThis}`,
    `- Avoid: ${candidate.avoidThis}`,
    candidate.evidenceRefs.length
      ? `- Evidence: ${candidate.evidenceRefs.slice(0, 5).map((ref) => `${ref.type}:${ref.ref}`).join('；')}`
      : '- Evidence: none',
    ''
  ].join('\n');
}

function maybeWritePromotionSuggestions(workspaceRoot: string, globalDataPath: string, candidates: LessonCandidate[]): LearningPromotionSuggestion[] {
  if (candidates.length === 0) {
    return [];
  }
  const paths = ensureLearningLedgerStore(workspaceRoot, globalDataPath);
  const allCandidates = readCandidates(paths);
  const written: LearningPromotionSuggestion[] = [];
  for (const candidate of candidates) {
    if (candidate.status !== 'candidate') {
      continue;
    }
    if (isTrashOrLocalPrivate(candidate)) {
      continue;
    }
    const reason = promotionReason(candidate, allCandidates);
    if (!reason) {
      continue;
    }
    const now = new Date().toISOString();
    const suggestion: LearningPromotionSuggestion = {
      schemaVersion: 1,
      id: stableId('promote', [candidate.id, candidate.promotionTarget, reason]),
      candidateId: candidate.id,
      projectId: candidate.projectId,
      projectPath: candidate.projectPath,
      projectName: candidate.projectName,
      lessonType: candidate.lessonType,
      promotionTarget: candidate.promotionTarget,
      targetPath: promotionTargetPath(candidate, paths.globalRoot),
      reason,
      status: 'suggested',
      draftMarkdown: buildPromotionDraft(candidate, reason),
      evidenceRefs: candidate.evidenceRefs,
      createdAt: now,
      updatedAt: now
    };
    const suggestionPath = path.join(paths.promotionSuggestionsRoot, `${suggestion.id}.json`);
    if (!fs.existsSync(suggestionPath)) {
      fs.writeFileSync(suggestionPath, JSON.stringify(suggestion, null, 2) + '\n', 'utf8');
      written.push(suggestion);
    }
  }
  return written;
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

export function buildLearningRetrievalContext(workspaceRoot: string, globalDataPath: string, query: LearningRetrievalQuery): string {
  let paths: ReturnType<typeof getLearningLedgerPaths>;
  try {
    paths = ensureLearningLedgerStore(workspaceRoot, globalDataPath);
  } catch {
    return '';
  }
  reconcileLearningCandidateDecisionsBestEffort(workspaceRoot, globalDataPath);
  const scored = readCandidates(paths)
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
      `   - 类型：${candidate.lessonType} / 状态：${candidate.status} / 置信度：${candidate.confidence}`,
      `   - 适用：${candidate.appliesWhen}`,
      `   - 本轮应做：${candidate.doThis}`,
      `   - 避免：${candidate.avoidThis}`
    ].join('\n'))
  ].join('\n');
}

export function buildLearningPromotionContext(workspaceRoot: string, globalDataPath: string, limit = 5): string {
  let paths: ReturnType<typeof getLearningLedgerPaths>;
  try {
    paths = ensureLearningLedgerStore(workspaceRoot, globalDataPath);
  } catch {
    return '';
  }
  reconcileLearningCandidateDecisionsBestEffort(workspaceRoot, globalDataPath);
  maybeWritePromotionSuggestions(workspaceRoot, globalDataPath, readCandidates(paths).filter((candidate) => candidate.status === 'candidate'));
  
  const rawSuggestions = readPromotionSuggestions(paths)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  const seenTargets = new Set<string>();
  const suggestions: LearningPromotionSuggestion[] = [];
  for (const sug of rawSuggestions) {
    const draftText = sug.draftMarkdown.toLowerCase();
    if (draftText.includes('run completed without explicit verification signal in captured tail')) {
      continue;
    }
    if (
      sug.promotionTarget === 'pattern' ||
      sug.promotionTarget === 'operating_rule' ||
      sug.promotionTarget === 'decision' ||
      sug.promotionTarget === 'domain'
    ) {
      if (
        draftText.includes('/home/') ||
        draftText.includes('/users/') ||
        draftText.includes('/tmp/') ||
        draftText.includes('__solo__') ||
        draftText.includes('/agent-runs/')
      ) {
        continue;
      }
    }
    const cleanDraft = sug.draftMarkdown.replace(/-\s+Source candidate:\s+[^\n]+/gi, '').trim().toLowerCase();
    const key = `${sug.targetPath}|${cleanDraft}`;
    if (seenTargets.has(key)) {
      continue;
    }
    seenTargets.add(key);
    suggestions.push(sug);
    if (suggestions.length >= limit) {
      break;
    }
  }

  if (suggestions.length === 0) {
    return '';
  }
  return [
    'SoloMap 自动晋升建议（插件侧生成）：',
    ...suggestions.map((suggestion, index) => [
      `${index + 1}. ${suggestion.reason} -> ${suggestion.promotionTarget}`,
      `   - 候选：${suggestion.candidateId}`,
      `   - 目标位置：${suggestion.targetPath}`,
      `   - 摘要：${compactLine(suggestion.draftMarkdown.replace(/\s+/g, ' '), 260)}`
    ].join('\n')),
    '   - 执行规则：如本轮继续验证该建议成立，Agent 应直接写入目标位置；若证据不足，保留建议，不要求用户手工筛选。'
  ].join('\n');
}

export function readLearningSummary(workspaceRoot: string, globalDataPath = ''): LearningSummary {
  let paths: ReturnType<typeof getLearningLedgerPaths>;
  try {
    paths = ensureLearningLedgerStore(workspaceRoot, globalDataPath);
  } catch {
    const globalRoot = normalizeSolomapGlobalPath(workspaceRoot, globalDataPath);
    return {
      globalRoot,
      eventCount: 0,
      candidateCount: 0,
      candidateDecisionCount: 0,
      skippedCandidateDecisionCount: 0,
      approvedCount: 0,
      promotedCount: 0,
      recentEvents: [],
      recentCandidates: [],
      projectSignals: []
    };
  }
  reconcileLearningCandidateDecisionsBestEffort(workspaceRoot, globalDataPath);
  const events = readJsonl<LearningEvent>(paths.eventsPath, 1000).filter((event) => event && event.schemaVersion === 1);
  const candidates = readCandidates(paths);
  const candidateDecisions = readCandidateDecisions(paths);
  const byProject = new Map<string, LearningSummary['projectSignals'][number]>();
  for (const event of events) {
    const current = byProject.get(event.projectId) || {
      projectId: event.projectId,
      projectName: event.projectName,
      projectPath: event.projectPath,
      eventCount: 0,
      candidateCount: 0,
      promotedCount: 0,
      latestAt: '',
      riskSignals: 0,
      verificationSignals: 0,
      strategySignals: 0
    };
    current.eventCount += 1;
    current.latestAt = String(event.createdAt || '') > String(current.latestAt || '') ? event.createdAt : current.latestAt;
    if (['failed', 'blocked', 'deviated', 'partial', 'needs_confirmation'].includes(event.eventType)) current.riskSignals += 1;
    if (event.eventType === 'verified' || event.metadata?.recommendedStatus === 'closed') current.verificationSignals += 1;
    if (event.sourceType === 'strategy') current.strategySignals += 1;
    byProject.set(event.projectId, current);
  }
  for (const candidate of candidates) {
    const current = byProject.get(candidate.projectId) || {
      projectId: candidate.projectId,
      projectName: candidate.projectName,
      projectPath: candidate.projectPath,
      eventCount: 0,
      candidateCount: 0,
      promotedCount: 0,
      latestAt: '',
      riskSignals: 0,
      verificationSignals: 0,
      strategySignals: 0
    };
    current.candidateCount += 1;
    if (candidate.status === 'promoted' || candidate.status === 'approved') current.promotedCount += 1;
    if (candidate.lessonType === 'risk_pattern') current.riskSignals += 1;
    if (candidate.lessonType === 'verification_pattern') current.verificationSignals += 1;
    if (candidate.lessonType === 'strategy_signal') current.strategySignals += 1;
    current.latestAt = String(candidate.updatedAt || candidate.createdAt || '') > String(current.latestAt || '') ? (candidate.updatedAt || candidate.createdAt) : current.latestAt;
    byProject.set(candidate.projectId, current);
  }
  return {
    globalRoot: paths.globalRoot,
    eventCount: events.length,
    candidateCount: candidates.filter((candidate) => candidate.status === 'candidate').length,
    candidateDecisionCount: candidateDecisions.length,
    skippedCandidateDecisionCount: candidateDecisions.filter((decision) => decision.decision === 'skipped').length,
    approvedCount: candidates.filter((candidate) => candidate.status === 'approved').length,
    promotedCount: candidates.filter((candidate) => candidate.status === 'promoted').length,
    recentEvents: events.slice(-8).reverse(),
    recentCandidates: candidates.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, 8),
    projectSignals: [...byProject.values()].sort((a, b) => String(b.latestAt || '').localeCompare(String(a.latestAt || '')))
  };
}
