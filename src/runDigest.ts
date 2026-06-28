import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';


function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function readStepMemoryObject(filePath: string): Record<string, unknown> {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toProjectRelativeRuntimePath(workspaceRoot: string, targetPath: string): string {
  const relativePath = path.relative(workspaceRoot, targetPath).replace(/\\/g, '/');
  return relativePath && !relativePath.startsWith('..') ? relativePath : targetPath;
}

export function getLegacyStepMemoryFilePath(workspaceRoot: string, nodeId: string): string {
  return path.join(workspaceRoot, '.solopreneur', 'step-memory', `${nodeId}.md`);
}

export function readStepHandoffSummary(filePath: string): string {
  const legacyFilePath = filePath.endsWith('.json') ? filePath.replace(/\.json$/, '.md') : '';
  const sourceFilePath = filePath && fs.existsSync(filePath)
    ? filePath
    : legacyFilePath && fs.existsSync(legacyFilePath)
      ? legacyFilePath
      : '';
  if (!sourceFilePath) {
    return '暂无交接总结。';
  }

  const content = fs.readFileSync(sourceFilePath, 'utf8').trim();
  if (content.startsWith('{')) {
    const memory = readStepMemoryObject(sourceFilePath);
    const entries = parseStepHandoffEntries(content);
    if (Object.keys(memory).length > 0) {
      return JSON.stringify({
        version: 1,
        format: String(memory.format || 'solopreneur.stepHandoff'),
        description: String(memory.description || 'Step memory used by SoloMap. completionCriteria defines when this roadmap step can be closed. entries keeps real Agent run handoffs.'),
        ...(
          normalizeStringList(memory.completionCriteria).length > 0
            ? { completionCriteria: normalizeStringList(memory.completionCriteria) }
            : {}
        ),
        ...(
          normalizeStringList(memory.lastCompletionEvidence).length > 0
            ? { lastCompletionEvidence: normalizeStringList(memory.lastCompletionEvidence) }
            : {}
        ),
        entries
      }, null, 2);
    }
  }
  return buildStepHandoffSummary(parseStepHandoffEntries(content)) || '暂无交接总结。';
}

export function compactLine(value: string, maxLength: number): string {
  const compacted = (value || '').replace(/\s+/g, ' ').trim();
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength)}...` : compacted;
}

export function buildRunHandoffEntry(
  status: string,
  changedFilesSummary: string,
  outputTail: string,
  completionReason: string
): Record<string, unknown> {
  const changedFiles = changedFilesSummary
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12)
    .filter((line) => !/^No (workspace|git|project) /i.test(line));

  const usefulSignals = outputTail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) =>
      line &&
      !/^\s*(npm|node|git|>|\[|\{)/i.test(line) &&
      !line.includes('Refreshing run status')
    )
    .slice(-12)
    .join('\n');

  return {
    timestamp: new Date().toISOString(),
    status,
    changedFiles: changedFiles.length > 0 ? changedFiles : [],
    usefulSignals: usefulSignals ? compactLine(usefulSignals, 1200) : compactLine(outputTail, 1200) || '',
    completionReason: completionReason || (status === 'Completed' ? '该环节已完成。' : '该环节仍需后续推进。')
  };
}

export interface RunDigest {
  schemaVersion: number;
  runId: string;
  executionLogId: number;
  projectPath: string;
  nodeId: string;
  runKind: string;
  agentCli: string;
  userIntent: string;
  outcome: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  changedFiles: string[];
  touchedFiles: string[];
  commandSignals: string[];
  verification: string[];
  failures: string[];
  reusableSignals: string[];
  tags: string[];
  handoff?: AgentHandoff;
  rawRefs?: {
    sqliteTable: string;
    executionLogId: number;
    digestPath?: string;
  };
}

export interface AgentHandoff {
  summary: string;
  nextAgentBrief: string;
  recommendedFirstActions: string[];
  filesToInspectFirst: string[];
  commandsToRunNext: string[];
  openQuestions: string[];
  blockedBy: string[];
  assumptions: string[];
  decisionsMade: string[];
  doNotRepeat: string[];
  confidence: 'low' | 'medium' | 'high';
  riskLevel: 'low' | 'medium' | 'high';
}

export interface ExecutionGraphRun {
  runId: string;
  executionLogId: number;
  nodeId: string;
  runKind: string;
  agentCli: string;
  status: string;
  finishedAt: string;
  changedFiles: string[];
  touchedFiles: string[];
  failures: string[];
  handoffSummary: string;
}

export type ExecutionExperienceNodeType = 'verification' | 'failure' | 'reusable_signal' | 'handoff_action' | 'decision';
export type ExecutionExperienceUsagePhase = 'observed' | 'prompt_injected' | 'verified' | 'failed';
export type ExecutionExperienceOutcome = 'win' | 'loss' | 'neutral';

export interface ExecutionExperienceStats {
  uses: number;
  wins: number;
  losses: number;
  neutral: number;
  alpha: number;
  beta: number;
  winRate: number;
  lastUsed: string;
}

export interface ExecutionExperienceNode {
  id: string;
  type: ExecutionExperienceNodeType;
  centralMeaning: string;
  sourceKinds: string[];
  sourceRefs: string[];
  appliesWhen: string[];
  doThis: string;
  avoidThis: string;
  checks: string[];
  stats: ExecutionExperienceStats;
}

export interface ExecutionExperienceUsageEdge {
  runId: string;
  experienceId: string;
  phase: ExecutionExperienceUsagePhase;
  outcome: ExecutionExperienceOutcome;
  evidenceRefs: string[];
  createdAt: string;
}

export interface ExecutionGraph {
  schemaVersion: number;
  updatedAt: string;
  runCount: number;
  indexes: {
    byNode: Record<string, string[]>;
    byAgent: Record<string, string[]>;
    byFile: Record<string, string[]>;
    byStatus: Record<string, string[]>;
    byFailure: Record<string, string[]>;
    byCommand: Record<string, string[]>;
    byExperience: Record<string, string[]>;
  };
  experienceNodes: Record<string, ExecutionExperienceNode>;
  usageEdges: ExecutionExperienceUsageEdge[];
  runs: ExecutionGraphRun[];
}

export interface RunDigestInput {
  workspaceRoot: string;
  nodeId: string;
  runKind: string;
  agentCli: string;
  executionLogId: number;
  userMessage: string;
  resolvedCommand: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  changedFilesSummary: string;
  touchedFilesSummary: string;
  outputTail: string;
  completionReason: string;
  failureCode: string;
  failureReason: string;
}

export interface ExecutionExperienceQuery {
  nodeId: string;
  runKind: string;
  contextText: string;
  supplementFiles?: string[];
}

function getRunDigestRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.solopreneur', 'run-digests');
}

function sanitizeRunDigestSegment(value: string): string {
  return (value || 'run')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'run';
}

function stripFileSummaryPrefix(line: string): string {
  return line.replace(/^[A-Z?]{1,2}\s+/, '').trim();
}

export function parseFileSummaryLines(summary: string): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const line of (summary || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /^No (workspace|git|project) /i.test(trimmed)) {
      continue;
    }
    const file = stripFileSummaryPrefix(trimmed);
    if (!file || seen.has(file)) {
      continue;
    }
    seen.add(file);
    files.push(file);
    if (files.length >= 24) {
      break;
    }
  }
  return files;
}

function extractLinesByPattern(value: string, pattern: RegExp, limit: number): string[] {
  const lines = (value || '')
    .split('\n')
    .map((line) => compactLine(line, 220))
    .filter((line) => line && pattern.test(line));
  return lines.slice(-limit);
}

function extractCommandSignals(resolvedCommand: string): string[] {
  const command = compactLine(resolvedCommand || '', 280);
  if (!command) {
    return [];
  }
  return [command];
}

export function extractVerificationSignals(outputTail: string, resolvedCommand: string, status: string): string[] {
  const signals = [
    ...extractLinesByPattern(outputTail, /\b(test|tests|passed|passing|validated|validation|verify|verified|tsc|vitest|jest|playwright|pytest|npm run|npm test|node --test)\b/i, 6)
  ];
  if (/\b(test|check|lint|validate|verify|tsc|vitest|jest|playwright|pytest)\b/i.test(resolvedCommand || '')) {
    signals.unshift(`Command: ${compactLine(resolvedCommand, 220)}`);
  }
  if (status === 'Completed' && signals.length === 0) {
    signals.push('Run completed without explicit verification signal in captured tail.');
  }
  return signals.filter((entry, index, all) => all.indexOf(entry) === index).slice(0, 6);
}

export function extractFailureSignals(outputTail: string, failureCode: string, failureReason: string, status: string): string[] {
  const signals = [
    failureCode ? `Failure category: ${compactLine(failureCode, 120)}` : '',
    failureReason ? `Failure reason: ${compactLine(failureReason, 260)}` : '',
    ...extractLinesByPattern(outputTail, /\b(error|failed|failure|exception|traceback|timeout|denied|invalid|cannot|could not)\b/i, 6)
  ].filter(Boolean);
  if (status === 'Failed' && signals.length === 0) {
    signals.push('Run failed without a captured failure line.');
  }
  return signals.filter((entry, index, all) => all.indexOf(entry) === index).slice(0, 8);
}

function extractReusableSignals(outputTail: string, completionReason: string, changedFiles: string[]): string[] {
  const signals = [
    completionReason ? `Completion: ${compactLine(completionReason, 260)}` : '',
    changedFiles.length > 0 ? `Changed files: ${changedFiles.slice(0, 6).join(', ')}` : '',
    ...extractLinesByPattern(outputTail, /\b(fix|fixed|implemented|added|updated|verified|validated|root cause|原因|修复|验证|完成|通过)\b/i, 4)
  ].filter(Boolean);
  return signals.filter((entry, index, all) => all.indexOf(entry) === index).slice(0, 6);
}

function uniqueCompactList(values: string[], limit: number, maxLength = 220): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const item = compactLine(value || '', maxLength);
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    result.push(item);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function extractHandoffActionLines(outputTail: string): string[] {
  return extractLinesByPattern(
    outputTail,
    /\b(next|todo|follow[- ]?up|remaining|继续|下一步|后续|待办|需要|建议|验证|检查)\b/i,
    8
  );
}

function extractDecisionSignals(outputTail: string, reusableSignals: string[]): string[] {
  return uniqueCompactList([
    ...reusableSignals.filter((signal) => /\b(decision|decided|选择|决定|采用|保留|改为)\b/i.test(signal)),
    ...extractLinesByPattern(outputTail, /\b(decision|decided|选择|决定|采用|保留|改为)\b/i, 6)
  ], 6);
}

function buildAgentHandoff(input: RunDigestInput, changedFiles: string[], touchedFiles: string[], verification: string[], failures: string[], reusableSignals: string[]): AgentHandoff {
  const status = String(input.status || '');
  const isFailed = status === 'Failed' || failures.length > 0;
  const summary = compactLine(input.completionReason || input.failureReason || (isFailed ? '上一轮未完成。' : '上一轮已结束。'), 500);
  const fileSignals = uniqueCompactList([...changedFiles, ...touchedFiles], 8);
  const actionLines = extractHandoffActionLines(input.outputTail);
  const firstActions = uniqueCompactList([
    isFailed && input.failureReason ? `先复核上一轮失败原因：${compactLine(input.failureReason, 180)}` : '',
    fileSignals.length > 0 ? `先阅读上一轮改动/触达文件：${fileSignals.slice(0, 4).join(', ')}` : '',
    ...actionLines,
    verification.length > 0 ? `复用或复跑验证信号：${verification.slice(0, 2).join(' / ')}` : ''
  ], 6);
  const commandsToRunNext = uniqueCompactList([
    ...verification
      .map((signal) => {
        const match = signal.match(/^Command:\s*(.+)$/i);
        return match ? match[1] : '';
      }),
    /\b(test|check|lint|validate|verify|tsc|vitest|jest|playwright|pytest|node --test)\b/i.test(input.resolvedCommand || '')
      ? input.resolvedCommand
      : ''
  ], 4, 300);
  const blockedBy = isFailed
    ? uniqueCompactList([
      input.failureCode ? `Failure category: ${input.failureCode}` : '',
      input.failureReason || '',
      ...failures
    ], 6)
    : [];
  const nextAgentBrief = compactLine([
    summary,
    fileSignals.length > 0 ? `优先查看 ${fileSignals.slice(0, 4).join(', ')}。` : '',
    blockedBy.length > 0 ? `阻塞/风险：${blockedBy.slice(0, 2).join(' / ')}。` : '',
    commandsToRunNext.length > 0 ? `建议验证：${commandsToRunNext.slice(0, 2).join(' / ')}。` : ''
  ].filter(Boolean).join(' '), 800);
  return {
    summary,
    nextAgentBrief,
    recommendedFirstActions: firstActions,
    filesToInspectFirst: fileSignals,
    commandsToRunNext,
    openQuestions: isFailed ? uniqueCompactList(failures, 4) : [],
    blockedBy,
    assumptions: uniqueCompactList(
      status === 'Completed' && verification.length === 0
        ? ['上一轮记录显示完成，但 captured tail 中没有明确验证信号；接手时应先补最窄验证。']
        : [],
      4
    ),
    decisionsMade: extractDecisionSignals(input.outputTail, reusableSignals),
    doNotRepeat: isFailed
      ? uniqueCompactList([
        input.failureReason ? `不要只重复上一轮失败路径：${input.failureReason}` : '',
        failures[0] ? `先处理风险信号再继续：${failures[0]}` : ''
      ], 4)
      : [],
    confidence: isFailed ? 'low' : verification.length > 0 ? 'high' : 'medium',
    riskLevel: isFailed ? 'high' : verification.length > 0 ? 'low' : 'medium'
  };
}

function tokenizeExperienceText(value: string): Set<string> {
  const tokens = (value || '')
    .toLowerCase()
    .split(/[^a-z0-9_\-/.]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 300);
  return new Set(tokens);
}

export function buildRunDigest(input: RunDigestInput): RunDigest {
  const changedFiles = parseFileSummaryLines(input.changedFilesSummary);
  const touchedFiles = parseFileSummaryLines(input.touchedFilesSummary);
  const commandSignals = extractCommandSignals(input.resolvedCommand);
  const verification = extractVerificationSignals(input.outputTail, input.resolvedCommand, input.status);
  const failures = extractFailureSignals(input.outputTail, input.failureCode, input.failureReason, input.status);
  const reusableSignals = extractReusableSignals(input.outputTail, input.completionReason, changedFiles);
  const runId = `${sanitizeRunDigestSegment(input.nodeId)}-${input.executionLogId || Date.parse(input.finishedAt) || Date.now()}`;
  const contextTokens = Array.from(tokenizeExperienceText([
    input.nodeId,
    input.runKind,
    input.userMessage,
    changedFiles.join(' '),
    touchedFiles.join(' '),
    input.completionReason,
    input.failureReason
  ].join('\n'))).slice(0, 24);
  return {
    schemaVersion: 2,
    runId,
    executionLogId: Number(input.executionLogId || 0),
    projectPath: input.workspaceRoot,
    nodeId: String(input.nodeId || ''),
    runKind: String(input.runKind || 'step'),
    agentCli: String(input.agentCli || 'unknown'),
    userIntent: compactLine(input.userMessage || '', 500),
    outcome: compactLine(input.completionReason || input.failureReason || '', 500),
    status: String(input.status || ''),
    startedAt: String(input.startedAt || ''),
    finishedAt: String(input.finishedAt || new Date().toISOString()),
    durationMs: Number(input.durationMs || 0),
    changedFiles,
    touchedFiles,
    commandSignals,
    verification,
    failures,
    reusableSignals,
    tags: contextTokens,
    handoff: buildAgentHandoff(
      input,
      changedFiles,
      touchedFiles,
      verification,
      failures,
      reusableSignals
    ),
    rawRefs: {
      sqliteTable: 'execution_logs',
      executionLogId: Number(input.executionLogId || 0)
    }
  };
}

export function writeRunDigest(workspaceRoot: string, digest: RunDigest): string {
  const digestRoot = getRunDigestRoot(workspaceRoot);
  fs.mkdirSync(digestRoot, { recursive: true });
  const digestPath = path.join(digestRoot, `${sanitizeRunDigestSegment(digest.runId)}.json`);
  const nextDigest: RunDigest = {
    ...digest,
    rawRefs: {
      ...(digest.rawRefs || { sqliteTable: 'execution_logs', executionLogId: Number(digest.executionLogId || 0) }),
      digestPath: toProjectRelativeRuntimePath(workspaceRoot, digestPath)
    }
  };
  fs.writeFileSync(digestPath, JSON.stringify(nextDigest, null, 2), 'utf8');
  try {
    writeExecutionGraph(workspaceRoot);
  } catch (error) {
    console.warn('Failed to update SoloMap execution graph:', error);
  }
  return digestPath;
}

function readRunDigests(workspaceRoot: string): RunDigest[] {
  const digestRoot = getRunDigestRoot(workspaceRoot);
  if (!fs.existsSync(digestRoot)) {
    return [];
  }
  return fs.readdirSync(digestRoot)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(digestRoot, file), 'utf8'));
        return parsed && (parsed.schemaVersion === 1 || parsed.schemaVersion === 2) ? parsed as RunDigest : null;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is RunDigest => Boolean(entry))
    .sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')))
    .slice(0, 120);
}

function getExecutionGraphPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.solopreneur', 'execution-graph.json');
}

function addExecutionGraphIndex(index: Record<string, string[]>, key: string, runId: string): void {
  const normalizedKey = compactLine(key || '', 180);
  if (!normalizedKey) {
    return;
  }
  if (!index[normalizedKey]) {
    index[normalizedKey] = [];
  }
  if (!index[normalizedKey].includes(runId)) {
    index[normalizedKey].push(runId);
  }
}

function stableExecutionExperienceId(type: ExecutionExperienceNodeType, centralMeaning: string): string {
  const hash = crypto
    .createHash('sha1')
    .update(`${type}\n${compactLine(centralMeaning || '', 360).toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);
  return `exp-${type.replace(/_/g, '-')}-${hash}`;
}

function emptyExperienceStats(): ExecutionExperienceStats {
  return {
    uses: 0,
    wins: 0,
    losses: 0,
    neutral: 0,
    alpha: 1,
    beta: 1,
    winRate: 0.5,
    lastUsed: ''
  };
}

function mergeUnique(values: string[], additions: string[], limit: number, maxLength = 220): string[] {
  return uniqueCompactList([...values, ...additions], limit, maxLength);
}

function updateExperienceStats(stats: ExecutionExperienceStats, edge: ExecutionExperienceUsageEdge): ExecutionExperienceStats {
  const next = {
    ...stats,
    uses: Number(stats.uses || 0) + 1,
    wins: Number(stats.wins || 0),
    losses: Number(stats.losses || 0),
    neutral: Number(stats.neutral || 0),
    alpha: Number(stats.alpha || 1),
    beta: Number(stats.beta || 1),
    lastUsed: String(edge.createdAt || stats.lastUsed || '')
  };
  if (edge.outcome === 'win') {
    next.wins += 1;
    next.alpha += 1;
  } else if (edge.outcome === 'loss') {
    next.losses += 1;
    next.beta += 1;
  } else {
    next.neutral += 1;
  }
  const denominator = next.alpha + next.beta;
  next.winRate = denominator > 0 ? Number((next.alpha / denominator).toFixed(4)) : 0.5;
  if (String(stats.lastUsed || '') > String(next.lastUsed || '')) {
    next.lastUsed = stats.lastUsed;
  }
  return next;
}

function experienceOutcomeForDigest(digest: RunDigest, positiveWhenCompleted = true): ExecutionExperienceOutcome {
  const status = String(digest.status || '').toLowerCase();
  if (status === 'failed') {
    return 'loss';
  }
  if (positiveWhenCompleted && (status === 'completed' || status === 'recorded')) {
    return 'win';
  }
  return 'neutral';
}

function buildExperienceNodeSeed(
  digest: RunDigest,
  type: ExecutionExperienceNodeType,
  signal: string
): ExecutionExperienceNode {
  const centralMeaning = compactLine(signal, 360);
  const fileContext = [...(digest.changedFiles || []), ...(digest.touchedFiles || [])]
    .filter((file, index, all) => file && all.indexOf(file) === index)
    .slice(0, 5);
  const commandContext = (digest.commandSignals || []).slice(0, 3);
  const commonChecks = mergeUnique(commandContext, digest.verification || [], 5, 260);
  if (type === 'verification') {
    return {
      id: stableExecutionExperienceId(type, centralMeaning),
      type,
      centralMeaning,
      sourceKinds: [digest.runKind || 'run'],
      sourceRefs: [digest.runId],
      appliesWhen: mergeUnique(fileContext, [
        digest.nodeId ? `同一路线图入口：${digest.nodeId}` : '',
        '后续任务需要证明相同区域或相同命令链路已闭环'
      ], 6),
      doThis: '优先复用或改写这组验证动作，并验证最终产物。',
      avoidThis: '不要只凭实现描述或完成摘要宣称闭环。',
      checks: commonChecks,
      stats: emptyExperienceStats()
    };
  }
  if (type === 'failure') {
    return {
      id: stableExecutionExperienceId(type, centralMeaning),
      type,
      centralMeaning,
      sourceKinds: [digest.runKind || 'run'],
      sourceRefs: [digest.runId],
      appliesWhen: mergeUnique(fileContext, [
        digest.nodeId ? `同一路线图入口：${digest.nodeId}` : '',
        '后续任务出现相同失败、相同命令或相同文件区域'
      ], 6),
      doThis: '先复核已知失败原因，再决定重试、回退、补验证或调整计划。',
      avoidThis: '不要无视同类失败历史直接重复上一条路径。',
      checks: commonChecks,
      stats: emptyExperienceStats()
    };
  }
  if (type === 'handoff_action') {
    return {
      id: stableExecutionExperienceId(type, centralMeaning),
      type,
      centralMeaning,
      sourceKinds: [digest.runKind || 'run'],
      sourceRefs: [digest.runId],
      appliesWhen: mergeUnique(fileContext, [
        digest.nodeId ? `接手同一路线图入口：${digest.nodeId}` : '',
        '后续 Agent 需要接续上一轮未完全显式化的上下文'
      ], 6),
      doThis: '把这条交接动作转成当前任务的第一步检查或验证。',
      avoidThis: '不要把 handoff 当成已验证结论；先和当前代码、日志、测试对齐。',
      checks: commonChecks,
      stats: emptyExperienceStats()
    };
  }
  if (type === 'decision') {
    return {
      id: stableExecutionExperienceId(type, centralMeaning),
      type,
      centralMeaning,
      sourceKinds: [digest.runKind || 'run'],
      sourceRefs: [digest.runId],
      appliesWhen: mergeUnique(fileContext, [
        digest.nodeId ? `同一路线图入口：${digest.nodeId}` : '',
        '后续任务可能重新触碰相同边界或方案取舍'
      ], 6),
      doThis: '先确认该决策仍被当前代码和用户要求支持，再沿用。',
      avoidThis: '不要把单次运行决策升级成全局规则。',
      checks: commonChecks,
      stats: emptyExperienceStats()
    };
  }
  return {
    id: stableExecutionExperienceId(type, centralMeaning),
    type,
    centralMeaning,
    sourceKinds: [digest.runKind || 'run'],
    sourceRefs: [digest.runId],
    appliesWhen: mergeUnique(fileContext, [
      digest.nodeId ? `同一路线图入口：${digest.nodeId}` : '',
      '后续任务出现相同目标、文件或验证需求'
    ], 6),
    doThis: '在下一次执行前召回这条经验，并转成具体动作或验证。',
    avoidThis: '不要只复述历史摘要；必须用当前证据确认适用性。',
    checks: commonChecks,
    stats: emptyExperienceStats()
  };
}

function buildExperienceEdgesForDigest(digest: RunDigest): Array<{ node: ExecutionExperienceNode; edge: ExecutionExperienceUsageEdge }> {
  const items: Array<{ type: ExecutionExperienceNodeType; signal: string; phase: ExecutionExperienceUsagePhase; outcome: ExecutionExperienceOutcome }> = [];
  for (const signal of digest.verification || []) {
    items.push({ type: 'verification', signal, phase: 'verified', outcome: experienceOutcomeForDigest(digest, true) });
  }
  for (const signal of digest.failures || []) {
    items.push({ type: 'failure', signal, phase: 'failed', outcome: String(digest.status || '').toLowerCase() === 'failed' ? 'loss' : 'neutral' });
  }
  for (const signal of digest.reusableSignals || []) {
    items.push({ type: 'reusable_signal', signal, phase: 'observed', outcome: experienceOutcomeForDigest(digest, true) });
  }
  for (const signal of digest.handoff?.recommendedFirstActions || []) {
    items.push({ type: 'handoff_action', signal, phase: 'observed', outcome: 'neutral' });
  }
  for (const signal of digest.handoff?.decisionsMade || []) {
    items.push({ type: 'decision', signal, phase: 'observed', outcome: experienceOutcomeForDigest(digest, false) });
  }
  const seen = new Set<string>();
  return items
    .filter((item) => {
      const key = `${item.type}\n${compactLine(item.signal, 360)}`;
      if (!item.signal || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 18)
    .map((item) => {
      const node = buildExperienceNodeSeed(digest, item.type, item.signal);
      return {
        node,
        edge: {
          runId: digest.runId,
          experienceId: node.id,
          phase: item.phase,
          outcome: item.outcome,
          evidenceRefs: uniqueCompactList([
            digest.rawRefs?.digestPath ? `digest:${digest.rawRefs.digestPath}` : '',
            digest.rawRefs?.executionLogId ? `execution_logs:${digest.rawRefs.executionLogId}` : '',
            ...node.checks.map((check) => `check:${check}`)
          ], 6, 260),
          createdAt: String(digest.finishedAt || new Date().toISOString())
        }
      };
    });
}

function buildExecutionGraph(workspaceRoot: string): ExecutionGraph {
  const digests = readRunDigests(workspaceRoot);
  const graph: ExecutionGraph = {
    schemaVersion: 2,
    updatedAt: new Date().toISOString(),
    runCount: digests.length,
    indexes: {
      byNode: {},
      byAgent: {},
      byFile: {},
      byStatus: {},
      byFailure: {},
      byCommand: {},
      byExperience: {}
    },
    experienceNodes: {},
    usageEdges: [],
    runs: []
  };
  for (const digest of digests) {
    const runId = String(digest.runId || '');
    if (!runId) {
      continue;
    }
    graph.runs.push({
      runId,
      executionLogId: Number(digest.executionLogId || 0),
      nodeId: String(digest.nodeId || ''),
      runKind: String(digest.runKind || ''),
      agentCli: String(digest.agentCli || ''),
      status: String(digest.status || ''),
      finishedAt: String(digest.finishedAt || ''),
      changedFiles: (digest.changedFiles || []).slice(0, 24),
      touchedFiles: (digest.touchedFiles || []).slice(0, 24),
      failures: (digest.failures || []).slice(0, 8),
      handoffSummary: compactLine(digest.handoff?.nextAgentBrief || digest.outcome || '', 800)
    });
    addExecutionGraphIndex(graph.indexes.byNode, digest.nodeId, runId);
    addExecutionGraphIndex(graph.indexes.byAgent, digest.agentCli, runId);
    addExecutionGraphIndex(graph.indexes.byStatus, digest.status, runId);
    for (const file of [...(digest.changedFiles || []), ...(digest.touchedFiles || [])]) {
      addExecutionGraphIndex(graph.indexes.byFile, file, runId);
    }
    for (const failure of digest.failures || []) {
      addExecutionGraphIndex(graph.indexes.byFailure, failure, runId);
    }
    for (const command of digest.commandSignals || []) {
      addExecutionGraphIndex(graph.indexes.byCommand, command, runId);
    }
    for (const { node, edge } of buildExperienceEdgesForDigest(digest)) {
      const existing = graph.experienceNodes[node.id];
      if (existing) {
        existing.sourceKinds = mergeUnique(existing.sourceKinds, node.sourceKinds, 8);
        existing.sourceRefs = mergeUnique(existing.sourceRefs, node.sourceRefs, 24);
        existing.appliesWhen = mergeUnique(existing.appliesWhen, node.appliesWhen, 8);
        existing.checks = mergeUnique(existing.checks, node.checks, 8, 260);
        existing.stats = updateExperienceStats(existing.stats, edge);
      } else {
        node.stats = updateExperienceStats(node.stats, edge);
        graph.experienceNodes[node.id] = node;
      }
      graph.usageEdges.push(edge);
      addExecutionGraphIndex(graph.indexes.byExperience, node.id, runId);
    }
  }
  return graph;
}

export function writeExecutionGraph(workspaceRoot: string): string {
  const graphPath = getExecutionGraphPath(workspaceRoot);
  fs.mkdirSync(path.dirname(graphPath), { recursive: true });
  fs.writeFileSync(graphPath, JSON.stringify(buildExecutionGraph(workspaceRoot), null, 2), 'utf8');
  return graphPath;
}

function scoreRunDigest(digest: RunDigest, query: ExecutionExperienceQuery): { score: number; reasons: string[] } {
  const context = query.contextText || '';
  const contextTokens = tokenizeExperienceText([
    context,
    ...(query.supplementFiles || [])
  ].join('\n'));
  let score = 0;
  const reasons: string[] = [];
  if (digest.nodeId && digest.nodeId === query.nodeId) {
    score += 8;
    reasons.push('同一任务入口');
  }
  if (digest.runKind && digest.runKind === query.runKind) {
    score += 2;
    reasons.push('同类运行');
  }
  const digestFiles = [...(digest.changedFiles || []), ...(digest.touchedFiles || [])];
  const matchedFiles = digestFiles.filter((file) => file && context.includes(file)).slice(0, 3);
  if (matchedFiles.length > 0) {
    score += matchedFiles.length * 5;
    reasons.push(`文件相关：${matchedFiles.join(', ')}`);
  }
  const matchedTags = (digest.tags || []).filter((tag) => contextTokens.has(tag)).slice(0, 6);
  if (matchedTags.length > 0) {
    score += matchedTags.length;
    reasons.push(`语义相关：${matchedTags.slice(0, 3).join(', ')}`);
  }
  return { score, reasons };
}

export function buildExecutionExperiencePrompt(workspaceRoot: string, query: ExecutionExperienceQuery): string {
  const matches = readRunDigests(workspaceRoot)
    .map((digest) => ({ digest, ...scoreRunDigest(digest, query) }))
    .filter((entry) => entry.score >= 3)
    .sort((a, b) => b.score - a.score || String(b.digest.finishedAt || '').localeCompare(String(a.digest.finishedAt || '')))
    .slice(0, 3);
  if (matches.length === 0) {
    return '';
  }
  const blocks = matches.map((entry, index) => {
    const digest = entry.digest;
    const fileSignals = [...(digest.changedFiles || []), ...(digest.touchedFiles || [])]
      .filter((file, fileIndex, all) => file && all.indexOf(file) === fileIndex)
      .slice(0, 6);
    const handoff = digest.handoff;
    return [
      `${index + 1}. 命中原因：${entry.reasons.join('；') || '近期相关执行'}`,
      digest.userIntent ? `   - 上次目标：${digest.userIntent}` : '',
      digest.outcome ? `   - 上次结果：${digest.outcome}` : `   - 上次状态：${digest.status}`,
      handoff?.nextAgentBrief ? `   - 下一位 Agent 交接：${handoff.nextAgentBrief}` : '',
      fileSignals.length > 0 ? `   - 相关文件：${fileSignals.join(', ')}` : '',
      handoff?.filesToInspectFirst?.length ? `   - 建议先看：${handoff.filesToInspectFirst.slice(0, 5).join(', ')}` : '',
      handoff?.recommendedFirstActions?.length ? `   - 建议动作：${handoff.recommendedFirstActions.slice(0, 3).join(' / ')}` : '',
      handoff?.commandsToRunNext?.length ? `   - 建议验证：${handoff.commandsToRunNext.slice(0, 2).join(' / ')}` : '',
      handoff?.doNotRepeat?.length ? `   - 避免重复：${handoff.doNotRepeat.slice(0, 2).join(' / ')}` : '',
      (digest.reusableSignals || []).length > 0 ? `   - 可复用信号：${(digest.reusableSignals || []).slice(0, 3).join(' / ')}` : '',
      (digest.verification || []).length > 0 ? `   - 验证信号：${(digest.verification || []).slice(0, 2).join(' / ')}` : '',
      (digest.failures || []).length > 0 ? `   - 风险信号：${(digest.failures || []).slice(0, 2).join(' / ')}` : ''
    ].filter(Boolean).join('\n');
  });
  return [
    'SoloMap 相关执行经验（自动召回，最多 3 条）：',
    '这些是历史结构化摘要，不是本轮事实；只能帮助减少重复探索，不能覆盖用户本轮要求、当前代码、测试或日志。',
    ...blocks
  ].join('\n');
}

export function buildCrossAgentHandoffInstructions(workspaceRoot: string, nodeId: string, runKind: string): string {
  const relativeTool = 'resources/tools/solomap-experience.cjs';
  const skillPath = 'resources/skills/solomap-cross-agent-handoff/SKILL.md';
  const nodeFilter = nodeId ? ` --node ${JSON.stringify(nodeId)}` : '';
  return [
    'SoloMap 跨 Agent 协作入口：',
    `- 如果本轮是在接续、复核、修复失败运行、跨不同 Agent CLI 协作，或你不确定上一轮到底改了什么，先读取 ${skillPath}，再运行：`,
    `  node ${relativeTool} handoff --project ${JSON.stringify(workspaceRoot)}${nodeFilter} --limit 3`,
    `- 需要进一步查看 SQLite 中的结构化历史信号时，用同一工具的 \`summary\`、\`history\`、\`failures\`、\`latest-changes\` 或 \`search\` 子命令；当前运行类型：${runKind || 'unknown'}。`,
    '- 这些历史信号只能降低重复探索，不能覆盖本轮用户最新要求、当前文件、测试和命令输出。',
    '- 不要把原始 execution log 全文复制进最终回复；只提炼对用户有帮助的结论、改动、验证和风险。'
  ].join('\n');
}

function normalizeStepHandoffEntry(entry: any): Record<string, unknown> | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const changedFiles = Array.isArray(entry.changedFiles)
    ? entry.changedFiles.map((line: unknown) => String(line || '').trim()).filter(Boolean).slice(0, 12)
    : String(entry.changedFiles || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 12);
  return {
    timestamp: String(entry.timestamp || new Date().toISOString()),
    status: String(entry.status || 'In Progress'),
    changedFiles,
    usefulSignals: compactLine(String(entry.usefulSignals || ''), 1200),
    completionReason: compactLine(String(entry.completionReason || ''), 600)
  };
}

function parseLegacyMarkdownHandoffEntry(entry: string): Record<string, unknown> | null {
  const cleaned = entry.replace(/\n# 环节交接总结[\s\S]*$/g, '').trim();
  const header = cleaned.match(/^##\s+([^\n]+?)\s+·\s+([^\n]+)\n/);
  if (!header) {
    return null;
  }
  const section = (title: string) => {
    const match = cleaned.match(new RegExp(`### ${title}\\n([\\s\\S]*?)(?=\\n\\n### |$)`));
    return match ? match[1].trim() : '';
  };
  const changedFiles = section('本轮文件变化')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^No (workspace|git|project) /i.test(line))
    .slice(0, 12);
  return {
    timestamp: header[1].trim(),
    status: header[2].trim(),
    changedFiles,
    usefulSignals: compactLine(section('本轮关键信号'), 1200),
    completionReason: compactLine(section('完成判断'), 600)
  };
}

function handoffEntryDedupeKey(entry: Record<string, unknown>): string {
  return JSON.stringify({
    status: entry.status || '',
    changedFiles: entry.changedFiles || [],
    usefulSignals: entry.usefulSignals || '',
    completionReason: entry.completionReason || ''
  });
}

export function parseStepHandoffEntries(content: string): Record<string, unknown>[] {
  const body = (content || '').trim();
  if (!body || body === '暂无交接总结。') {
    return [];
  }

  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      const parsed = JSON.parse(body);
      const rawEntries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.entries) ? parsed.entries : [];
      const seen = new Set<string>();
      const entries: Record<string, unknown>[] = [];
      for (const rawEntry of rawEntries) {
        const entry = normalizeStepHandoffEntry(rawEntry);
        if (!entry) continue;
        const key = handoffEntryDedupeKey(entry);
        if (!seen.has(key)) {
          seen.add(key);
          entries.push(entry);
        }
      }
      return entries.slice(0, 10);
    } catch {
      return [];
    }
  }

  const normalized = body
    .replace(/^# 环节交接总结[\s\S]*?(?=\n##\s+\d{4}-\d{2}-\d{2}T|\n##\s+\d{4}-\d{2}-\d{2}\s|$)/, '')
    .trim();
  if (!normalized) {
    return [];
  }

  const rawEntries = normalized
    .split(/\n\n---\n\n|(?=\n##\s+\d{4}-\d{2}-\d{2}(?:T|\s))/)
    .map((entry) => entry.trim())
    .filter((entry) => /^##\s+\d{4}-\d{2}-\d{2}(?:T|\s)/.test(entry));

  const seen = new Set<string>();
  const entries: Record<string, unknown>[] = [];
  for (const entry of rawEntries) {
    const parsedEntry = parseLegacyMarkdownHandoffEntry(entry);
    if (!parsedEntry) continue;
    const key = handoffEntryDedupeKey(parsedEntry);
    if (!seen.has(key)) {
      seen.add(key);
      entries.push(parsedEntry);
    }
  }
  return entries;
}

export function buildStepHandoffSummary(entries: Record<string, unknown>[]): string {
  const seen = new Set<string>();
  const validEntries = entries
    .map((entry) => normalizeStepHandoffEntry(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => {
      const key = handoffEntryDedupeKey(entry);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 10);
  if (validEntries.length === 0) {
    return '';
  }
  return JSON.stringify({
    version: 1,
    format: 'solopreneur.stepHandoff',
    description: 'Only real Agent run handoff entries are kept here. Newest first, max 10.',
    entries: validEntries
  }, null, 2);
}

export function updateStepHandoffSummary(filePath: string, entry: Record<string, unknown>): string {
  const legacyFilePath = filePath.endsWith('.json') ? filePath.replace(/\.json$/, '.md') : '';
  const existing = filePath && fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : legacyFilePath && fs.existsSync(legacyFilePath)
      ? fs.readFileSync(legacyFilePath, 'utf8')
      : '';
  const existingObject = readStepMemoryObject(filePath);
  const normalizedEntry = normalizeStepHandoffEntry(entry);
  const entries = normalizedEntry ? [normalizedEntry, ...parseStepHandoffEntries(existing)] : parseStepHandoffEntries(existing);
  const completionCriteria = normalizeStringList(existingObject.completionCriteria);
  const existingCompletionEvidence = normalizeStringList(existingObject.lastCompletionEvidence);
  const entryEvidence = normalizedEntry
    ? [
      ...normalizeStringList(normalizedEntry.changedFiles),
      String(normalizedEntry.completionReason || '').trim()
    ].filter(Boolean)
    : [];
  const lastCompletionEvidence = entryEvidence.length > 0
    ? [...entryEvidence, ...existingCompletionEvidence].filter((item, index, all) => all.indexOf(item) === index).slice(0, 8)
    : existingCompletionEvidence;
  const nextContent = JSON.stringify({
    version: 1,
    format: 'solopreneur.stepHandoff',
    description: 'Step memory used by SoloMap. completionCriteria defines when this roadmap step can be closed. entries keeps real Agent run handoffs.',
    ...(completionCriteria.length > 0 ? { completionCriteria } : {}),
    ...(lastCompletionEvidence.length > 0 ? { lastCompletionEvidence } : {}),
    entries: parseStepHandoffEntries(buildStepHandoffSummary(entries))
  }, null, 2).slice(0, 12000);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, nextContent, 'utf8');
  return nextContent;
}
