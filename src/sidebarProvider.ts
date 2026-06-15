import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import * as Papa from 'papaparse';
import { SyncEngine } from './db/syncEngine';
import { AgentConversation } from './db/types';
import { getAgentImpactStatus } from './agentImpact';
import { summarizeDocumentationForReview } from './documentationManifest';

interface SolopreneurSettings {
  cliPath: string;
  agentModelPreferences?: Record<string, string>;
  language: string;
  globalPrompt: string;
  globalDataPath: string;
  taskPermissionMode?: string;
  reviewerCliPath?: string;
  collaborationReviewMode?: string;
  proEntitlements?: Record<string, boolean>;
  proAccount?: ProAccountStatus;
  enabledEnhancements?: Record<string, boolean>;
  enhancementStatuses?: Array<{
    id: string;
    title: string;
    description: string;
    status: string;
    statusLabel: string;
    version: string;
    installed: boolean;
    enabled: boolean;
    action: string;
    message: string;
    updatedAt: string;
  }>;
}

interface AgentModelOption {
  value: string;
  label: string;
  title?: string;
}

interface AgentModelCatalog {
  family: string;
  command: string;
  models: AgentModelOption[];
  selectedValue: string;
  supportsDiscovery: boolean;
}

interface ProAccountStatus {
  authenticated: boolean;
  allowed: boolean;
  email?: string;
  expiresAt?: string;
}

interface SolopreneurProject {
  name: string;
  path: string;
  type?: string;
  priority?: string;
  pinnedAt?: string;
}

interface ProjectPortfolioSummary {
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
  globalPriority: string;
  projectType: string;
  blocker: string;
  globalNextAction: string;
  reusableSignals: number;
  issuePressure: string;
  stageGap: string;
  delivery: ProjectDeliverySummary;
  deliverySignal: string;
  documentationDocumentCount: number;
  documentationPendingReview: number;
  pinnedAt?: string;
}

interface GlobalEngineeringSnapshot {
  dataPath: string;
  portfolio: Array<{
    id: string;
    name: string;
    path: string;
    type: string;
    status: string;
    priority: string;
    blocker: string;
    nextAction: string;
    updatedAt: string;
  }>;
  dependencies: Array<{
    fromProject: string;
    toProject: string;
    capability: string;
    status: string;
    priorityImpact: string;
    reason: string;
    updatedAt: string;
  }>;
  learningCandidateCount: number;
}

interface DailyReviewTodo {
  title: string;
  reason: string;
  projectPath?: string;
  nodeId?: string;
  action?: string;
}

interface DailyReviewArtifact {
  schemaVersion: number;
  date: string;
  generatedAt: string;
  finishedAt?: string;
  rhythm: string;
  reviewMode?: string;
  source: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  summary: string;
  todos: DailyReviewTodo[];
  needsConfirmation: DailyReviewTodo[];
  inputSnapshot: {
    projectCount: number;
    learningCandidateCount: number;
    blockedDependencyCount: number;
    reviewMode?: string;
  };
  resultPath?: string;
  promptPath?: string;
  outputLog?: string;
  error?: string;
}

interface ProjectIssueItem {
  number: number;
  title: string;
  body: string;
  state: string;
  category: string;
  priority: string;
  labels: string[];
  comments: number;
  thumbsUp: number;
  url: string;
  updatedAt: string;
}

interface ProjectIssueComment {
  author: string;
  body: string;
  createdAt: string;
}

interface ProjectIssueSummary {
  available: boolean;
  loading: boolean;
  stale: boolean;
  syncedAt: string;
  repo: string;
  total: number;
  open: number;
  byCategory: Record<string, number>;
  byPriority: Record<string, number>;
  items: ProjectIssueItem[];
  message: string;
}

interface DependencyStatus {
  agentReady: boolean;
  agentMessage: string;
  agentAutomationReady: boolean;
  agentAutomationPreconfigured: boolean;
  agentAutomationMessage: string;
  agentAutomationCanPrepare: boolean;
  githubCliReady: boolean;
  githubAuthReady: boolean;
  githubMessage: string;
}

interface IssueCacheFile {
  schemaVersion: number;
  repo: string;
  syncedAt: string;
  issues: ProjectIssueItem[];
  details: Record<string, {
    syncedAt: string;
    issue: ProjectIssueItem;
    comments: ProjectIssueComment[];
  }>;
}

interface RoadmapNodeLike {
  id: string;
  title: string;
  stage: string;
  status: string;
  agentCli?: string;
  dependencies?: string;
}

type MethodologyStageKey = 'build' | 'sell' | 'learn' | 'improve';
type ProFeatureKey = 'strategyPyramid';

const methodologyStages: Array<{ key: MethodologyStageKey; label: string }> = [
  { key: 'build', label: 'Build' },
  { key: 'sell', label: 'Sell' },
  { key: 'learn', label: 'Learn' },
  { key: 'improve', label: 'Improve' }
];
const PRO_FEATURES: Record<ProFeatureKey, string> = {
  strategyPyramid: 'strategy_pyramid'
};
const DELIVERY_WORKFLOW_RUN_DISPLAY_LIMIT = 3;
const DELIVERY_WORKFLOW_RUN_FETCH_LIMIT = 20;
const FEEDBACK_ISSUE_URL = 'https://github.com/jobssteve164dev/solopreneur-roadmap/issues/new';
const githubRepoSlugCache = new Map<string, string>();
const commandResolutionCache = new Map<string, string>();
let executableSearchPathsCache: string[] | null = null;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeTaskPermissionMode(value: unknown): string {
  return ['auto', 'always', 'never'].includes(String(value || '')) ? String(value) : 'auto';
}

function getTaskPermissionDetectionTokens(agentCli: string): string[] {
  const executableName = path.basename(agentCli).toLowerCase();
  const commonTokens = [
    '--dangerously-skip-permissions',
    '--dangerously-bypass-approvals-and-sandbox',
    '--ask-for-approval never',
    '--ask-for-approval=never',
    '-a never',
    '--permission-mode bypasspermissions',
    '--permission-mode=bypasspermissions',
    '--permission-mode dontask',
    '--permission-mode=dontask',
    '--allow-all',
    '--allow-all-tools',
    '--yolo'
  ];
  if (executableName === 'cursor' || executableName === 'cursor-cli' || executableName === 'cursor-agent') {
    return ['--force'];
  }
  return commonTokens;
}

function commandAlreadyGrantsTaskPermissions(agentCli: string): boolean {
  const raw = String(agentCli || '').toLowerCase();
  const knownTokens = getTaskPermissionDetectionTokens(agentCli);
  if (knownTokens.some((token) => raw.includes(token))) {
    return true;
  }
  if (!path.isAbsolute(agentCli)) {
    return false;
  }
  try {
    const stat = fs.statSync(agentCli);
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      return false;
    }
    const content = fs.readFileSync(agentCli, 'utf8').toLowerCase();
    return knownTokens.some((token) => content.includes(token));
  } catch {
    return false;
  }
}

function getTaskPermissionArgs(agentCli: string, mode = 'auto'): string {
  const normalizedMode = normalizeTaskPermissionMode(mode);
  if (normalizedMode === 'never') {
    return '';
  }
  if (normalizedMode === 'auto' && commandAlreadyGrantsTaskPermissions(agentCli)) {
    return '';
  }
  const executableName = path.basename(agentCli).toLowerCase();
  if (executableName === 'codex' || executableName === 'codex-cli') {
    return '--dangerously-bypass-approvals-and-sandbox';
  }
  if (executableName === 'cursor' || executableName === 'cursor-cli' || executableName === 'cursor-agent') {
    return '--force';
  }
  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return '--dangerously-skip-permissions';
  }
  if (executableName === 'claude' || executableName === 'claude-code' || executableName === 'claude-code-cli') {
    return '--dangerously-skip-permissions';
  }
  if (executableName === 'copilot' || executableName === 'copilot-cli') {
    return '--allow-all --no-ask-user';
  }
  return '';
}

function getAgentTaskAutomationStatus(agentCli: string): { supported: boolean; preconfigured: boolean; permissionArgs: string; message: string } {
  const preconfigured = commandAlreadyGrantsTaskPermissions(agentCli);
  const permissionArgs = getTaskPermissionArgs(agentCli, 'always');
  if (preconfigured) {
    return {
      supported: true,
      preconfigured: true,
      permissionArgs,
      message: `${agentCli} is already prepared for automatic task runs.`
    };
  }
  if (permissionArgs) {
    return {
      supported: true,
      preconfigured: false,
      permissionArgs,
      message: `SoloMap can prepare ${agentCli} for automatic task runs.`
    };
  }
  return {
    supported: false,
    preconfigured: false,
    permissionArgs: '',
    message: `${agentCli} does not expose a supported automatic task mode yet.`
  };
}

function buildFeedbackIssueUrl(title: string, body: string, category = '', usageSummary = ''): string {
  const params = new URLSearchParams();
  const issueTitle = String(title || '').trim();
  const issueBody = String(body || '').trim();
  const issueCategory = String(category || '').trim();
  const localUsageSummary = String(usageSummary || '').trim();
  if (issueTitle) {
    params.set('title', issueTitle);
  }
  const categoryLabel = issueCategory ? `Feedback type: ${issueCategory}` : '';
  const defaultBody = [
    categoryLabel,
    '',
    issueBody,
    '',
    'Core path check:',
    '- [ ] Added a local project',
    '- [ ] Generated or opened a roadmap',
    '- [ ] Ran an Agent or Solo conversation',
    '',
    'Local usage summary:',
    localUsageSummary || 'No local usage summary file was available.',
    '',
    'What happened:',
    '',
    'What I expected:'
  ].join('\n').trim();
  if (defaultBody) {
    params.set('body', defaultBody);
  }
  if (issueBody) {
    params.set('what_happened', issueBody);
  }
  if (issueCategory) {
    params.set('feedback_type', issueCategory);
  }
  if (localUsageSummary) {
    params.set('local_usage_summary', localUsageSummary);
  }
  params.set('template', 'seed-user-feedback.yml');
  params.set('labels', 'feedback,seed-user');
  return `${FEEDBACK_ISSUE_URL}${params.toString() ? `?${params.toString()}` : ''}`;
}

function expandHomePath(value: string): string {
  const trimmed = String(value || '').trim();
  if (trimmed === '~') {
    return process.env.HOME || trimmed;
  }
  if (trimmed.startsWith('~/')) {
    return path.join(process.env.HOME || '~', trimmed.slice(2));
  }
  return trimmed;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readShellPath(shellPath: string): string[] {
  const shell = expandHomePath(shellPath);
  if (!shell || !fs.existsSync(shell)) {
    return [];
  }
  try {
    const result = childProcess.spawnSync(shell, ['-lc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 1800,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (result.status !== 0) {
      return [];
    }
    return String(result.stdout || '').split(path.delimiter).filter(Boolean);
  } catch {
    return [];
  }
}

function getExecutableSearchPaths(): string[] {
  if (executableSearchPathsCache) {
    return executableSearchPathsCache;
  }
  const configuredPath = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const shellPaths = [
    ...readShellPath(process.env.SHELL || ''),
    ...readShellPath('/bin/zsh'),
    ...readShellPath('/bin/bash')
  ];
  const home = process.env.HOME || '';
  const commonPaths = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    home ? path.join(home, '.local', 'bin') : '',
    home ? path.join(home, 'bin') : '',
    home ? path.join(home, '.npm-global', 'bin') : '',
    home ? path.join(home, '.npm', 'bin') : '',
    home ? path.join(home, '.yarn', 'bin') : '',
    home ? path.join(home, '.bun', 'bin') : '',
    home ? path.join(home, '.cargo', 'bin') : ''
  ].filter(Boolean);
  executableSearchPathsCache = [...configuredPath, ...shellPaths, ...commonPaths]
    .map(expandHomePath)
    .filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
  return executableSearchPathsCache;
}

function resolveCommandOnSearchPath(command: string): string {
  const trimmed = String(command || '').trim();
  if (!trimmed) {
    return '';
  }
  const cached = commandResolutionCache.get(trimmed);
  if (cached !== undefined) {
    return cached;
  }
  const expanded = expandHomePath(trimmed);
  if (path.isAbsolute(expanded) || expanded.includes(path.sep)) {
    const resolved = isExecutableFile(expanded) ? expanded : '';
    commandResolutionCache.set(trimmed, resolved);
    return resolved;
  }
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const dir of getExecutableSearchPaths()) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${expanded}${ext}`);
      if (isExecutableFile(candidate)) {
        commandResolutionCache.set(trimmed, candidate);
        return candidate;
      }
    }
  }
  commandResolutionCache.set(trimmed, '');
  return '';
}

function escapeHtmlText(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function commandExists(command: string): boolean {
  return Boolean(resolveCommandOnSearchPath(command));
}

function resolveExecutablePath(command: string): string {
  const trimmed = (command || '').trim();
  if (!trimmed) {
    return '';
  }
  return resolveCommandOnSearchPath(trimmed) || expandHomePath(trimmed);
}

function getAgentCliFamily(command: string): string {
  const name = path.basename((command || '').trim()).toLowerCase();
  if (['codex', 'codex-cli'].includes(name)) return 'codex';
  if (['claude', 'claude-code', 'claude-code-cli'].includes(name)) return 'claude';
  if (['cursor', 'cursor-cli', 'cursor-agent'].includes(name)) return 'cursor';
  if (['copilot', 'copilot-cli'].includes(name)) return 'copilot';
  if (['opencode', 'open-code', 'open-code-cli'].includes(name)) return 'opencode';
  if (['', 'agy', 'antigravity', 'antigravity-cli'].includes(name)) return 'antigravity';
  return name;
}

function getKnownAgentCliCandidates(family: string): string[] {
  if (family === 'codex') return ['codex', 'codex-cli'];
  if (family === 'claude') return ['claude', 'claude-code', 'claude-code-cli'];
  if (family === 'cursor') return ['cursor-agent', 'cursor', 'cursor-cli'];
  if (family === 'copilot') return ['copilot', 'copilot-cli'];
  if (family === 'opencode') return ['opencode', 'open-code', 'open-code-cli'];
  if (family === 'antigravity') return ['agy', 'antigravity', 'antigravity-cli'];
  return family ? [family] : [];
}

function getAgentCliCandidates(agentCli: string, configuredCliPath: string): string[] {
  const requestedCli = (agentCli || '').trim();
  const configuredCli = (configuredCliPath || '').trim();
  const requestedFamily = getAgentCliFamily(requestedCli);
  const configuredFamily = getAgentCliFamily(configuredCli);
  const preferredFamily = requestedCli ? requestedFamily : configuredFamily;
  const requestedCandidate = path.basename(requestedCli).toLowerCase() === 'cursor' ? '' : requestedCli;
  const configuredCandidate = path.basename(configuredCli).toLowerCase() === 'cursor' ? '' : configuredCli;
  const familyOrder = [
    preferredFamily,
    configuredFamily,
    requestedFamily,
    'antigravity',
    'codex',
    'claude',
    'copilot',
    'opencode'
  ].filter(Boolean);
  const preferredCandidates = requestedCli
    ? [requestedCandidate, configuredCandidate]
    : [configuredCandidate, requestedCandidate];
  const candidates = [
    ...preferredCandidates,
    ...familyOrder.flatMap(getKnownAgentCliCandidates)
  ];

  return candidates.filter(Boolean).filter((candidate, index, all) => all.indexOf(candidate) === index);
}

function resolveAgentCli(agentCli: string, configuredCliPath: string): string {
  const candidates = getAgentCliCandidates(agentCli, configuredCliPath);

  for (const candidate of candidates) {
    if (commandExists(candidate)) {
      return resolveExecutablePath(candidate);
    }
  }

  return candidates[0] || 'agy';
}

function buildAgentCommandForPromptFile(agentCli: string, promptFilePath: string, workspaceRoot: string, taskPermissionMode = 'auto'): string {
  const executableName = path.basename(agentCli).toLowerCase();
  const quotedCli = shellQuote(agentCli);
  const quotedPromptFile = shellQuote(promptFilePath);
  const permissionArgs = getTaskPermissionArgs(agentCli, taskPermissionMode);
  const permissionSegment = permissionArgs ? ` ${permissionArgs}` : '';
  const promptFileInstruction = `Read the complete SoloMap task prompt from ${promptFilePath} and follow that file exactly. The user request inside the file is the highest priority. Do not answer this wrapper sentence.`;
  const quotedPromptFileInstruction = shellQuote(promptFileInstruction);

  if (executableName === 'codex' || executableName === 'codex-cli') {
    return `cat ${quotedPromptFile} | ${quotedCli} exec --color always -C ${shellQuote(workspaceRoot)} --skip-git-repo-check${permissionSegment} -`;
  }
  if (executableName === 'cursor' || executableName === 'cursor-cli' || executableName === 'cursor-agent') {
    return `${quotedCli} -p${permissionSegment} --output-format text ${quotedPromptFileInstruction}`;
  }
  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return `cat ${quotedPromptFile} | ${quotedCli} --print${permissionSegment} --add-dir=${shellQuote(workspaceRoot)}`;
  }
  if (executableName === 'claude' || executableName === 'claude-code' || executableName === 'claude-code-cli') {
    return `${quotedCli} -p${permissionSegment} --add-dir ${shellQuote(workspaceRoot)} ${quotedPromptFileInstruction}`;
  }
  if (executableName === 'copilot' || executableName === 'copilot-cli') {
    return `${quotedCli} -p ${quotedPromptFileInstruction} -C ${shellQuote(workspaceRoot)} --add-dir ${shellQuote(workspaceRoot)}${permissionSegment} --output-format text`;
  }
  if (executableName === 'opencode' || executableName === 'open-code' || executableName === 'open-code-cli') {
    return `(cd ${shellQuote(workspaceRoot)} && ${quotedCli} run ${quotedPromptFileInstruction})`;
  }
  return `${quotedCli} run --task ${quotedPromptFileInstruction}`;
}

function createEmptyIssueSummary(message = ''): ProjectIssueSummary {
  return {
    available: false,
    loading: false,
    stale: false,
    syncedAt: '',
    repo: '',
    total: 0,
    open: 0,
    byCategory: {},
    byPriority: {},
    items: [],
    message
  };
}

interface ProjectDeliverySummary {
  available: boolean;
  loading: boolean;
  stale: boolean;
  syncedAt: string;
  repo: string;
  latestRelease: string;
  latestReleaseAt: string;
  latestReleaseUrl: string;
  failedWorkflowRuns: number;
  latestWorkflowName: string;
  latestWorkflowStatus: string;
  latestWorkflowConclusion: string;
  latestWorkflowUrl: string;
  recentWorkflowRuns: Array<{
    name: string;
    displayTitle: string;
    status: string;
    conclusion: string;
    createdAt: string;
    updatedAt: string;
    url: string;
  }>;
  message: string;
}

interface DeliveryCacheFile {
  schemaVersion: number;
  repo: string;
  syncedAt: string;
  latestRelease: {
    tagName: string;
    name: string;
    publishedAt: string;
    url: string;
  } | null;
  workflowRuns: Array<{
    name: string;
    displayTitle: string;
    status: string;
    conclusion: string;
    createdAt: string;
    updatedAt: string;
    url: string;
  }>;
}

function createLoadingIssueSummary(): ProjectIssueSummary {
  return {
    ...createEmptyIssueSummary('Loading GitHub Issues'),
    loading: true
  };
}

function createEmptyDeliverySummary(message = ''): ProjectDeliverySummary {
  return {
    available: false,
    loading: false,
    stale: false,
    syncedAt: '',
    repo: '',
    latestRelease: '',
    latestReleaseAt: '',
    latestReleaseUrl: '',
    failedWorkflowRuns: 0,
    latestWorkflowName: '',
    latestWorkflowStatus: '',
    latestWorkflowConclusion: '',
    latestWorkflowUrl: '',
    recentWorkflowRuns: [],
    message
  };
}

function createLoadingDeliverySummary(): ProjectDeliverySummary {
  return {
    ...createEmptyDeliverySummary('Loading delivery signals'),
    loading: true
  };
}

function getIssueCachePath(projectPath: string): string {
  return path.join(projectPath, '.solopreneur', 'issues-cache.json');
}

function getDeliveryCachePath(projectPath: string): string {
  return path.join(projectPath, '.solopreneur', 'delivery-cache.json');
}

function ensureIssueCacheGitignore(projectPath: string): void {
  const solopreneurDir = path.join(projectPath, '.solopreneur');
  const gitignorePath = path.join(solopreneurDir, '.gitignore');
  try {
    fs.mkdirSync(solopreneurDir, { recursive: true });
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    const missing = ['issues-cache.json', 'delivery-cache.json']
      .filter((entry) => !(new RegExp(`(^|\\n)${entry.replace('.', '\\.')}($|\\n)`).test(existing)));
    if (missing.length) {
      const next = `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`;
      fs.writeFileSync(gitignorePath, next, 'utf8');
    }
  } catch {}
}

function validateIssueCache(raw: any, repo: string): IssueCacheFile | null {
  if (!raw || raw.schemaVersion !== 1 || raw.repo !== repo || !Array.isArray(raw.issues) || typeof raw.details !== 'object' || raw.details === null) {
    return null;
  }
  const issues = raw.issues.map(parseGithubIssue).filter((issue: ProjectIssueItem) => issue.number && issue.title && issue.state);
  const details: IssueCacheFile['details'] = {};
  for (const [key, value] of Object.entries(raw.details)) {
    const detail = value as any;
    if (!detail || !detail.issue) {
      continue;
    }
    const issue = parseGithubIssue(detail.issue);
    if (!issue.number || !issue.title || !issue.state) {
      continue;
    }
    details[String(key)] = {
      syncedAt: String(detail.syncedAt || ''),
      issue,
      comments: Array.isArray(detail.comments)
        ? detail.comments.map((comment: any) => ({
          author: String(comment?.author || ''),
          body: String(comment?.body || ''),
          createdAt: String(comment?.createdAt || '')
        }))
        : []
    };
  }
  return {
    schemaVersion: 1,
    repo,
    syncedAt: String(raw.syncedAt || ''),
    issues,
    details
  };
}

function readIssueCache(projectPath: string, repo = getGithubRepoSlug(projectPath)): IssueCacheFile | null {
  if (!repo) {
    return null;
  }
  try {
    const cachePath = getIssueCachePath(projectPath);
    if (!fs.existsSync(cachePath)) {
      return null;
    }
    return validateIssueCache(JSON.parse(fs.readFileSync(cachePath, 'utf8')), repo);
  } catch {
    return null;
  }
}

function writeIssueCache(projectPath: string, cache: IssueCacheFile): void {
  const cachePath = getIssueCachePath(projectPath);
  const tempPath = `${cachePath}.tmp`;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const payload = JSON.stringify(cache, null, 2);
  fs.writeFileSync(tempPath, payload, 'utf8');
  JSON.parse(fs.readFileSync(tempPath, 'utf8'));
  fs.renameSync(tempPath, cachePath);
  ensureIssueCacheGitignore(projectPath);
}

function validateDeliveryCache(raw: any, repo: string): DeliveryCacheFile | null {
  if (!raw || raw.schemaVersion !== 1 || raw.repo !== repo || !Array.isArray(raw.workflowRuns)) {
    return null;
  }
  const latestRelease = raw.latestRelease && typeof raw.latestRelease === 'object'
    ? {
      tagName: String(raw.latestRelease.tagName || ''),
      name: String(raw.latestRelease.name || ''),
      publishedAt: String(raw.latestRelease.publishedAt || ''),
      url: String(raw.latestRelease.url || '')
    }
    : null;
  const workflowRuns = raw.workflowRuns.map((run: any) => ({
    name: String(run.name || ''),
    displayTitle: String(run.displayTitle || ''),
    status: String(run.status || ''),
    conclusion: String(run.conclusion || ''),
    createdAt: String(run.createdAt || ''),
    updatedAt: String(run.updatedAt || ''),
    url: String(run.url || '')
  }));
  return {
    schemaVersion: 1,
    repo,
    syncedAt: String(raw.syncedAt || ''),
    latestRelease,
    workflowRuns
  };
}

function readDeliveryCache(projectPath: string, repo = getGithubRepoSlug(projectPath)): DeliveryCacheFile | null {
  if (!repo) {
    return null;
  }
  try {
    const cachePath = getDeliveryCachePath(projectPath);
    if (!fs.existsSync(cachePath)) {
      return null;
    }
    return validateDeliveryCache(JSON.parse(fs.readFileSync(cachePath, 'utf8')), repo);
  } catch {
    return null;
  }
}

function writeDeliveryCache(projectPath: string, cache: DeliveryCacheFile): void {
  const cachePath = getDeliveryCachePath(projectPath);
  const tempPath = `${cachePath}.tmp`;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const payload = JSON.stringify(cache, null, 2);
  fs.writeFileSync(tempPath, payload, 'utf8');
  JSON.parse(fs.readFileSync(tempPath, 'utf8'));
  fs.renameSync(tempPath, cachePath);
  ensureIssueCacheGitignore(projectPath);
}

function summarizeIssueItems(repo: string, items: ProjectIssueItem[], syncedAt = '', stale = false): ProjectIssueSummary {
  const byCategory: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  for (const issue of items.filter((issue) => issue.state === 'OPEN')) {
    byCategory[issue.category] = (byCategory[issue.category] || 0) + 1;
    if (issue.priority) {
      byPriority[issue.priority] = (byPriority[issue.priority] || 0) + 1;
    }
  }
  return {
    available: true,
    loading: false,
    stale,
    syncedAt,
    repo,
    total: items.length,
    open: items.filter((issue) => issue.state === 'OPEN').length,
    byCategory,
    byPriority,
    items: items
      .filter((issue) => issue.state === 'OPEN')
      .sort((a, b) => {
        const priorityRank: Record<string, number> = { P0: 0, P1: 1, P2: 2, '': 3 };
        return (priorityRank[a.priority] ?? 3) - (priorityRank[b.priority] ?? 3) || b.thumbsUp - a.thumbsUp || b.comments - a.comments;
      })
      .slice(0, 5),
    message: stale ? 'Showing last synced GitHub Issues' : ''
  };
}

function readCachedIssueSummary(projectPath: string): ProjectIssueSummary {
  const repo = getGithubRepoSlug(projectPath);
  if (!repo) {
    return createEmptyIssueSummary('No GitHub remote');
  }
  const cache = readIssueCache(projectPath, repo);
  if (!cache) {
    return createLoadingIssueSummary();
  }
  return summarizeIssueItems(repo, cache.issues, cache.syncedAt, true);
}

function summarizeDeliveryCache(repo: string, cache: DeliveryCacheFile, stale = false): ProjectDeliverySummary {
  const allRuns = Array.isArray(cache.workflowRuns) ? cache.workflowRuns : [];
  const latestRun = allRuns[0] || null;

  // Group by workflow name and keep only the latest run for each workflow
  const uniqueRunsMap = new Map();
  for (const run of allRuns) {
    const wfName = run.name || run.displayTitle || 'default';
    if (!uniqueRunsMap.has(wfName)) {
      uniqueRunsMap.set(wfName, run);
    }
  }
  const latestRunsOfEachWorkflow = Array.from(uniqueRunsMap.values());

  const failedWorkflowRuns = stale
    ? 0
    : latestRunsOfEachWorkflow
      .filter((run) => ['failure', 'timed_out', 'action_required'].includes(String(run.conclusion || '').toLowerCase()))
      .length;

  return {
    available: true,
    loading: false,
    stale,
    syncedAt: cache.syncedAt,
    repo,
    latestRelease: cache.latestRelease?.tagName || cache.latestRelease?.name || '',
    latestReleaseAt: cache.latestRelease?.publishedAt || '',
    latestReleaseUrl: cache.latestRelease?.url || '',
    failedWorkflowRuns,
    latestWorkflowName: latestRun?.displayTitle || latestRun?.name || '',
    latestWorkflowStatus: latestRun?.status || '',
    latestWorkflowConclusion: latestRun?.conclusion || '',
    latestWorkflowUrl: latestRun?.url || '',
    recentWorkflowRuns: latestRunsOfEachWorkflow,
    message: stale ? 'Showing last synced delivery signals' : ''
  };
}

function readCachedDeliverySummary(projectPath: string): ProjectDeliverySummary {
  const repo = getGithubRepoSlug(projectPath);
  if (!repo) {
    return createEmptyDeliverySummary('No GitHub remote');
  }
  const cache = readDeliveryCache(projectPath, repo);
  if (!cache) {
    return createLoadingDeliverySummary();
  }
  return summarizeDeliveryCache(repo, cache, true);
}

function createIssueCache(repo: string, issues: ProjectIssueItem[], details: IssueCacheFile['details'] = {}): IssueCacheFile {
  return {
    schemaVersion: 1,
    repo,
    syncedAt: new Date().toISOString(),
    issues,
    details
  };
}

function readCachedIssueDetails(projectPath: string, issueNumber: number): { ok: boolean; issue?: ProjectIssueItem; comments: ProjectIssueComment[]; message: string; stale: boolean } | null {
  const repo = getGithubRepoSlug(projectPath);
  const cache = readIssueCache(projectPath, repo);
  const detail = cache?.details[String(issueNumber)];
  if (!detail) {
    return null;
  }
  return {
    ok: true,
    issue: detail.issue,
    comments: detail.comments,
    message: 'Showing last synced issue discussion',
    stale: true
  };
}

function getGithubRepoSlug(projectPath: string): string {
  if (!projectPath || !fs.existsSync(projectPath)) {
    return '';
  }
  const cached = githubRepoSlugCache.get(projectPath);
  if (cached !== undefined) {
    return cached;
  }
  let result: childProcess.SpawnSyncReturns<string>;
  try {
    result = childProcess.spawnSync('git', ['-C', projectPath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      timeout: 1800,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    githubRepoSlugCache.set(projectPath, '');
    return '';
  }
  const remote = String(result.stdout || '').trim();
  if (!remote) {
    githubRepoSlugCache.set(projectPath, '');
    return '';
  }
  const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/i);
  const repo = match ? match[1].replace(/\.git$/i, '') : '';
  githubRepoSlugCache.set(projectPath, repo);
  return repo;
}

function normalizeIssueLabel(label: string): string {
  return String(label || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeIssueCategory(labels: string[]): string {
  const normalized = labels.map(normalizeIssueLabel);
  const has = (candidates: string[]) => normalized.some((label) => candidates.includes(label));
  if (has(['bug', 'type: bug', 'kind/bug', 'defect', 'regression', 'perf'])) return 'bug';
  if (has(['tech debt', 'tech-debt', 'debt', 'refactor', 'cleanup', 'maintenance', 'architecture'])) return 'tech-debt';
  if (has(['feature', 'enhancement', 'request', 'feature request', 'feature-request', 'type: feature', 'customer'])) return 'feature-request';
  if (has(['docs', 'documentation', 'readme'])) return 'documentation';
  if (has(['quick-note', 'quick note', 'note'])) return 'quick-note';
  if (has(['discussion', 'question', 'idea', 'proposal', 'rfc'])) return 'discussion';
  return 'discussion';
}

function normalizeIssuePriority(labels: string[]): string {
  const normalized = labels.map(normalizeIssueLabel);
  const has = (candidates: string[]) => normalized.some((label) => candidates.includes(label));
  if (has(['p0', 'priority: critical', 'critical', 'urgent', 'blocker', 'sev1'])) return 'P0';
  if (has(['p1', 'priority: high', 'high', 'sev2'])) return 'P1';
  if (has(['p2', 'priority: medium', 'medium', 'normal', 'sev3'])) return 'P2';
  return '';
}

function getReactionCount(reactionGroups: any[], content: string): number {
  const group = Array.isArray(reactionGroups)
    ? reactionGroups.find((candidate) => String(candidate?.content || '').toUpperCase() === content)
    : null;
  return Number(group?.users?.totalCount || 0);
}

function toGithubLabel(category: string): string {
  if (category === 'bug') return 'bug';
  if (category === 'feature-request') return 'feature-request';
  if (category === 'tech-debt') return 'tech-debt';
  if (category === 'documentation') return 'documentation';
  if (category === 'quick-note') return 'quick-note';
  return 'discussion';
}

function getProjectIssueLabels(category: string, priority: string): string[] {
  return [toGithubLabel(category), priority].filter(Boolean);
}

function getGithubIssueLabelMeta(label: string): { color: string; description: string } {
  if (label === 'bug') return { color: 'd73a4a', description: 'Something is not working' };
  if (label === 'feature-request') return { color: '7c4dff', description: 'New capability or product request' };
  if (label === 'tech-debt') return { color: 'fbca04', description: 'Technical debt or maintenance work' };
  if (label === 'documentation') return { color: '0075ca', description: 'Documentation improvement' };
  if (label === 'discussion') return { color: 'd4c5f9', description: 'Open discussion or decision input' };
  if (label === 'quick-note') return { color: '00e676', description: 'Quick note or task' };
  if (label === 'P0') return { color: 'b60205', description: 'Critical priority' };
  if (label === 'P1') return { color: 'd93f0b', description: 'High priority' };
  if (label === 'P2') return { color: 'fbca04', description: 'Medium priority' };
  return { color: 'ededed', description: 'SoloMap issue label' };
}

function ensureGithubIssueLabel(projectPath: string, label: string): void {
  const meta = getGithubIssueLabelMeta(label);
  runGhIssueCommand(projectPath, [
    'label',
    'create',
    label,
    '--color',
    meta.color,
    '--description',
    meta.description,
    '--force'
  ], 6000);
}

function parseIssueNumberFromOutput(output: string): number {
  const match = String(output || '').match(/\/issues\/(\d+)(?:\b|$)/);
  return match ? Number(match[1]) : 0;
}

function parseGithubIssue(rawIssue: any): ProjectIssueItem {
  const labels = Array.isArray(rawIssue.labels) ? rawIssue.labels.map((label: any) => String(label?.name || label || '')) : [];
  return {
    number: Number(rawIssue.number || 0),
    title: String(rawIssue.title || ''),
    body: String(rawIssue.body || ''),
    state: String(rawIssue.state || ''),
    category: normalizeIssueCategory(labels),
    priority: normalizeIssuePriority(labels),
    labels,
    comments: Number(rawIssue.comments || 0),
    thumbsUp: getReactionCount(rawIssue.reactionGroups || [], 'THUMBS_UP'),
    url: String(rawIssue.url || ''),
    updatedAt: String(rawIssue.updatedAt || '')
  };
}

function runGhIssueCommand(projectPath: string, args: string[], timeout = 6000): { ok: boolean; stdout: string; stderr: string; repo: string } {
  const repo = getGithubRepoSlug(projectPath);
  if (!repo) {
    return { ok: false, stdout: '', stderr: 'No GitHub remote', repo: '' };
  }
  if (!commandExists('gh')) {
    return { ok: false, stdout: '', stderr: 'GitHub CLI not found', repo };
  }
  const result = childProcess.spawnSync('gh', args.includes('--repo') ? args : [...args, '--repo', repo], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    repo
  };
}

function runProcessAsync(command: string, args: string[], timeout = 6000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = childProcess.spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let settled = false;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      resolve({ ok: false, stdout, stderr: stderr || `Command timed out after ${timeout}ms` });
    }, timeout);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: String(error.message || error) });
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

async function runGhIssueCommandAsync(projectPath: string, args: string[], timeout = 6000): Promise<{ ok: boolean; stdout: string; stderr: string; repo: string }> {
  const repo = getGithubRepoSlug(projectPath);
  if (!repo) {
    return { ok: false, stdout: '', stderr: 'No GitHub remote', repo: '' };
  }
  const ghPath = resolveCommandOnSearchPath('gh');
  if (!ghPath) {
    return { ok: false, stdout: '', stderr: 'GitHub CLI not found', repo };
  }
  const result = await runProcessAsync(ghPath, args.includes('--repo') ? args : [...args, '--repo', repo], timeout);
  return { ...result, repo };
}

function readProjectDeliverySummary(projectPath: string): ProjectDeliverySummary {
  const repo = getGithubRepoSlug(projectPath);
  if (!repo) {
    return createEmptyDeliverySummary('No GitHub remote');
  }
  if (!commandExists('gh')) {
    const cache = readDeliveryCache(projectPath, repo);
    return cache ? summarizeDeliveryCache(repo, cache, true) : { ...createEmptyDeliverySummary('GitHub CLI not found'), repo };
  }
  const releaseResult = runGhIssueCommand(projectPath, [
    'release',
    'list',
    '--limit',
    '1',
    '--json',
    'tagName,name,publishedAt'
  ], 4500);
  const runResult = runGhIssueCommand(projectPath, [
    'run',
    'list',
    '--limit',
    String(DELIVERY_WORKFLOW_RUN_FETCH_LIMIT),
    '--json',
    'name,displayTitle,status,conclusion,createdAt,updatedAt,url'
  ], 4500);
  if (!releaseResult.ok && !runResult.ok) {
    const cache = readDeliveryCache(projectPath, repo);
    return cache ? summarizeDeliveryCache(repo, cache, true) : {
      ...createEmptyDeliverySummary(String(releaseResult.stderr || runResult.stderr || 'GitHub delivery signals unavailable').trim()),
      repo
    };
  }
  let latestRelease: DeliveryCacheFile['latestRelease'] = null;
  let workflowRuns: DeliveryCacheFile['workflowRuns'] = [];
  try {
    const releases = releaseResult.ok ? JSON.parse(String(releaseResult.stdout || '[]')) : [];
    const release = Array.isArray(releases) ? releases[0] : null;
    latestRelease = release
      ? {
        tagName: String(release.tagName || ''),
        name: String(release.name || ''),
        publishedAt: String(release.publishedAt || ''),
        url: release.url ? String(release.url) : 'https://github.com/' + repo + '/releases/tag/' + encodeURIComponent(release.tagName || '')
      }
      : null;
  } catch {}
  try {
    const runs = runResult.ok ? JSON.parse(String(runResult.stdout || '[]')) : [];
    workflowRuns = Array.isArray(runs)
      ? runs.map((run: any) => ({
        name: String(run.name || ''),
        displayTitle: String(run.displayTitle || ''),
        status: String(run.status || ''),
        conclusion: String(run.conclusion || ''),
        createdAt: String(run.createdAt || ''),
        updatedAt: String(run.updatedAt || ''),
        url: String(run.url || '')
      })).slice(0, DELIVERY_WORKFLOW_RUN_FETCH_LIMIT)
      : [];
  } catch {}
  const cache: DeliveryCacheFile = {
    schemaVersion: 1,
    repo,
    syncedAt: new Date().toISOString(),
    latestRelease,
    workflowRuns
  };
  try {
    writeDeliveryCache(projectPath, cache);
  } catch {}
  return summarizeDeliveryCache(repo, cache, false);
}

function readProjectIssueSummary(projectPath: string): ProjectIssueSummary {
  const repo = getGithubRepoSlug(projectPath);
  if (!repo) {
    return createEmptyIssueSummary('No GitHub remote');
  }
  const result = runGhIssueCommand(projectPath, [
    'issue',
    'list',
    '--state',
    'all',
    '--limit',
    '100',
    '--json',
    'number,title,body,state,labels,comments,reactionGroups,updatedAt,url'
  ], 4500);
  if (!result.ok) {
    const cache = readIssueCache(projectPath, repo);
    if (cache) {
      return summarizeIssueItems(repo, cache.issues, cache.syncedAt, true);
    }
    return {
      ...createEmptyIssueSummary(String(result.stderr || result.stdout || 'GitHub issues unavailable').trim()),
      repo
    };
  }
  let rawIssues: any[] = [];
  try {
    rawIssues = JSON.parse(String(result.stdout || '[]'));
  } catch {
    const cache = readIssueCache(projectPath, repo);
    if (cache) {
      return summarizeIssueItems(repo, cache.issues, cache.syncedAt, true);
    }
    return { ...createEmptyIssueSummary('GitHub issue data could not be read'), repo };
  }
  const items = rawIssues.map(parseGithubIssue).filter((issue) => issue.number > 0);
  const existing = readIssueCache(projectPath, repo);
  const cache = createIssueCache(repo, items, existing?.details || {});
  try {
    writeIssueCache(projectPath, cache);
  } catch {
    return summarizeIssueItems(repo, items, cache.syncedAt, false);
  }
  return summarizeIssueItems(repo, items, cache.syncedAt, false);
}

async function readProjectDeliverySummaryAsync(projectPath: string): Promise<ProjectDeliverySummary> {
  const repo = getGithubRepoSlug(projectPath);
  if (!repo) {
    return createEmptyDeliverySummary('No GitHub remote');
  }
  if (!resolveCommandOnSearchPath('gh')) {
    const cache = readDeliveryCache(projectPath, repo);
    return cache ? summarizeDeliveryCache(repo, cache, true) : { ...createEmptyDeliverySummary('GitHub CLI not found'), repo };
  }
  const [releaseResult, runResult] = await Promise.all([
    runGhIssueCommandAsync(projectPath, [
      'release',
      'list',
      '--limit',
      '1',
      '--json',
      'tagName,name,publishedAt'
    ], 4500),
    runGhIssueCommandAsync(projectPath, [
      'run',
      'list',
      '--limit',
      String(DELIVERY_WORKFLOW_RUN_FETCH_LIMIT),
      '--json',
      'name,displayTitle,status,conclusion,createdAt,updatedAt,url'
    ], 4500)
  ]);
  if (!releaseResult.ok && !runResult.ok) {
    const cache = readDeliveryCache(projectPath, repo);
    return cache ? summarizeDeliveryCache(repo, cache, true) : {
      ...createEmptyDeliverySummary(String(releaseResult.stderr || runResult.stderr || 'GitHub delivery signals unavailable').trim()),
      repo
    };
  }
  let latestRelease: DeliveryCacheFile['latestRelease'] = null;
  let workflowRuns: DeliveryCacheFile['workflowRuns'] = [];
  try {
    const releases = releaseResult.ok ? JSON.parse(String(releaseResult.stdout || '[]')) : [];
    const release = Array.isArray(releases) ? releases[0] : null;
    latestRelease = release
      ? {
        tagName: String(release.tagName || ''),
        name: String(release.name || ''),
        publishedAt: String(release.publishedAt || ''),
        url: release.url ? String(release.url) : 'https://github.com/' + repo + '/releases/tag/' + encodeURIComponent(release.tagName || '')
      }
      : null;
  } catch {}
  try {
    const runs = runResult.ok ? JSON.parse(String(runResult.stdout || '[]')) : [];
    workflowRuns = Array.isArray(runs)
      ? runs.map((run: any) => ({
        name: String(run.name || ''),
        displayTitle: String(run.displayTitle || ''),
        status: String(run.status || ''),
        conclusion: String(run.conclusion || ''),
        createdAt: String(run.createdAt || ''),
        updatedAt: String(run.updatedAt || ''),
        url: String(run.url || '')
      })).slice(0, DELIVERY_WORKFLOW_RUN_FETCH_LIMIT)
      : [];
  } catch {}
  const cache: DeliveryCacheFile = {
    schemaVersion: 1,
    repo,
    syncedAt: new Date().toISOString(),
    latestRelease,
    workflowRuns
  };
  try {
    writeDeliveryCache(projectPath, cache);
  } catch {}
  return summarizeDeliveryCache(repo, cache, false);
}

async function readProjectIssueSummaryAsync(projectPath: string): Promise<ProjectIssueSummary> {
  const repo = getGithubRepoSlug(projectPath);
  if (!repo) {
    return createEmptyIssueSummary('No GitHub remote');
  }
  const result = await runGhIssueCommandAsync(projectPath, [
    'issue',
    'list',
    '--state',
    'all',
    '--limit',
    '100',
    '--json',
    'number,title,body,state,labels,comments,reactionGroups,updatedAt,url'
  ], 4500);
  if (!result.ok) {
    const cache = readIssueCache(projectPath, repo);
    if (cache) {
      return summarizeIssueItems(repo, cache.issues, cache.syncedAt, true);
    }
    return {
      ...createEmptyIssueSummary(String(result.stderr || result.stdout || 'GitHub issues unavailable').trim()),
      repo
    };
  }
  let rawIssues: any[] = [];
  try {
    rawIssues = JSON.parse(String(result.stdout || '[]'));
  } catch {
    const cache = readIssueCache(projectPath, repo);
    if (cache) {
      return summarizeIssueItems(repo, cache.issues, cache.syncedAt, true);
    }
    return { ...createEmptyIssueSummary('GitHub issue data could not be read'), repo };
  }
  const items = rawIssues.map(parseGithubIssue).filter((issue) => issue.number > 0);
  const existing = readIssueCache(projectPath, repo);
  const cache = createIssueCache(repo, items, existing?.details || {});
  try {
    writeIssueCache(projectPath, cache);
  } catch {
    return summarizeIssueItems(repo, items, cache.syncedAt, false);
  }
  return summarizeIssueItems(repo, items, cache.syncedAt, false);
}

function readProjectIssueDetails(projectPath: string, issueNumber: number): { ok: boolean; issue?: ProjectIssueItem; comments: ProjectIssueComment[]; message: string; stale?: boolean } {
  const result = runGhIssueCommand(projectPath, [
    'issue',
    'view',
    String(issueNumber),
    '--comments',
    '--json',
    'number,title,body,state,labels,comments,reactionGroups,updatedAt,url'
  ], 7000);
  if (!result.ok) {
    return readCachedIssueDetails(projectPath, issueNumber)
      || { ok: false, comments: [], message: String(result.stderr || result.stdout || 'GitHub issue unavailable').trim() };
  }
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    const issue = parseGithubIssue(parsed);
    const comments = Array.isArray(parsed.comments)
      ? parsed.comments.map((comment: any) => ({
        author: String(comment?.author?.login || ''),
        body: String(comment?.body || ''),
        createdAt: String(comment?.createdAt || '')
      }))
      : [];
    const existing = readIssueCache(projectPath, result.repo);
    const issues = existing?.issues || [];
    const issueIndex = issues.findIndex((item) => item.number === issue.number);
    const nextIssues = issueIndex >= 0
      ? issues.map((item) => item.number === issue.number ? issue : item)
      : [issue, ...issues];
    const cache = createIssueCache(result.repo, nextIssues, {
      ...(existing?.details || {}),
      [String(issueNumber)]: {
        syncedAt: new Date().toISOString(),
        issue,
        comments
      }
    });
    try {
      writeIssueCache(projectPath, cache);
    } catch {}
    return { ok: true, issue, comments, message: '', stale: false };
  } catch {
    return readCachedIssueDetails(projectPath, issueNumber)
      || { ok: false, comments: [], message: 'GitHub issue data could not be read' };
  }
}

function createProjectIssue(projectPath: string, title: string, body: string, category: string, priority: string): { ok: boolean; message: string } {
  const labels = getProjectIssueLabels(category, priority);
  const args = ['issue', 'create', '--title', title, '--body', body || title];
  const result = runGhIssueCommand(projectPath, args, 10000);
  if (result.ok) {
    const issueNumber = parseIssueNumberFromOutput(result.stdout);
    if (issueNumber && labels.length) {
      labels.forEach((label) => ensureGithubIssueLabel(projectPath, label));
      runGhIssueCommand(projectPath, ['issue', 'edit', String(issueNumber), '--add-label', labels.join(',')], 8000);
    }
    readProjectIssueSummary(projectPath);
  }
  return {
    ok: result.ok,
    message: String(result.stdout || result.stderr || '').trim()
  };
}

function closeProjectIssue(projectPath: string, issueNumber: number): { ok: boolean; message: string } {
  const result = runGhIssueCommand(projectPath, ['issue', 'close', String(issueNumber)], 8000);
  if (result.ok) {
    readProjectIssueSummary(projectPath);
  }
  return {
    ok: result.ok,
    message: String(result.stdout || result.stderr || '').trim()
  };
}

function getDependencyStatus(cliPath: string): DependencyStatus {
  const agentCli = resolveAgentCli(cliPath || 'agy', cliPath || 'agy');
  const agentReady = commandExists(agentCli);
  const automation = agentReady
    ? getAgentTaskAutomationStatus(agentCli)
    : { supported: false, preconfigured: false, permissionArgs: '', message: 'Agent CLI is not ready yet.' };
  const githubCliReady = commandExists('gh');
  let githubAuthReady = false;
  let githubMessage = githubCliReady ? 'GitHub CLI is installed.' : 'GitHub CLI is not installed.';
  if (githubCliReady) {
    const auth = childProcess.spawnSync('gh', ['auth', 'status'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    githubAuthReady = auth.status === 0;
    githubMessage = githubAuthReady ? 'GitHub is authorized.' : 'GitHub authorization is needed.';
  }
  return {
    agentReady,
    agentMessage: agentReady ? `${agentCli} is ready.` : `Agent CLI not found. Tried: ${getAgentCliCandidates(cliPath || 'agy', cliPath || 'agy').join(', ')}`,
    agentAutomationReady: agentReady && automation.supported,
    agentAutomationPreconfigured: Boolean(automation.preconfigured),
    agentAutomationMessage: automation.message,
    agentAutomationCanPrepare: agentReady && automation.supported && !automation.preconfigured,
    githubCliReady,
    githubAuthReady,
    githubMessage
  };
}

function getCliVersionArgs(agentCli: string): string[] {
  const executableName = path.basename(agentCli).toLowerCase();
  if (executableName === 'codex' || executableName === 'codex-cli') {
    return ['--version'];
  }
  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return ['--version'];
  }
  return ['--version'];
}

function formatCliTestMessage(agentCli: string, stdout: string, stderr: string): string {
  const version = (stdout.trim() || stderr.trim() || 'available').split('\n')[0];
  return `${agentCli} · ${version}`;
}

function buildAgentInstallCommand(cliPath: string): string {
  const family = getAgentCliFamily(cliPath || 'agy');
  const verifyCandidates = getKnownAgentCliCandidates(family)
    .filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
  const verifyScript = [
    'echo ""',
    'echo "SoloMap: verifying Agent CLI..."',
    `for c in ${verifyCandidates.map(shellQuote).join(' ')}; do if command -v "$c" >/dev/null 2>&1; then echo "SoloMap: found $(command -v "$c")"; "$c" --version || true; exit 0; fi; done`,
    'echo "SoloMap: install command finished, but the CLI is not visible in this terminal PATH yet."',
    'echo "SoloMap: restart VS Code/code-server or paste the executable absolute path into SoloMap settings."'
  ].join('; ');

  if (family === 'codex') {
    return `npm install -g @openai/codex; ${verifyScript}`;
  }
  if (family === 'claude') {
    return `npm install -g @anthropic-ai/claude-code; ${verifyScript}`;
  }
  if (family === 'copilot') {
    return `npm install -g @github/copilot; ${verifyScript}`;
  }
  if (family === 'opencode') {
    return `npm install -g opencode-ai; ${verifyScript}`;
  }
  if (family === 'antigravity') {
    return `curl -fsSL https://antigravity.google/cli/install.sh | bash; ${verifyScript}`;
  }
  if (family === 'cursor') {
    return [
      'echo "SoloMap: Cursor CLI is installed from the Cursor app command palette."',
      'echo "Open Cursor, run the command to install the cursor command, then return here and click Check."',
      'echo "If the command already exists, paste its absolute path into SoloMap settings."'
    ].join('; ');
  }
  return [
    `echo "SoloMap: no built-in installer is available for ${String(cliPath || 'this custom CLI').replace(/"/g, '\\"')}."`,
    'echo "Install that CLI with its official installer, then paste its executable absolute path into SoloMap settings."'
  ].join('; ');
}

function buildAgentAutomationWrapper(cliPath: string, globalDataPath: string, projects: SolopreneurProject[]): { ok: boolean; message: string; wrapperPath?: string } {
  const agentCli = resolveAgentCli(cliPath || 'agy', cliPath || 'agy');
  if (!commandExists(agentCli)) {
    return { ok: false, message: `Agent CLI not found. Tried: ${getAgentCliCandidates(cliPath || 'agy', cliPath || 'agy').join(', ')}` };
  }
  const automation = getAgentTaskAutomationStatus(agentCli);
  if (!automation.supported) {
    return { ok: false, message: automation.message };
  }
  if (automation.preconfigured) {
    return { ok: true, message: automation.message, wrapperPath: agentCli };
  }
  const family = getAgentCliFamily(agentCli || cliPath || 'agy');
  const wrapperNameByFamily: Record<string, string> = {
    antigravity: 'agy',
    codex: 'codex',
    cursor: 'cursor-agent',
    claude: 'claude',
    copilot: 'copilot'
  };
  const wrapperName = wrapperNameByFamily[family] || path.basename(agentCli).replace(/[^a-z0-9_-]/gi, '-') || 'agent';
  const wrapperDir = path.join(normalizeGlobalDataPath(globalDataPath, projects), 'agent-cli');
  const wrapperPath = path.join(wrapperDir, wrapperName);
  fs.mkdirSync(wrapperDir, { recursive: true });
  const script = [
    '#!/bin/sh',
    `exec ${shellQuote(agentCli)} ${automation.permissionArgs} "$@"`
  ].join('\n');
  fs.writeFileSync(wrapperPath, `${script}\n`, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(wrapperPath, 0o755);
  return { ok: true, message: `Agent prepared for automatic task runs: ${wrapperPath}`, wrapperPath };
}

function readProjectRoadmapNodes(projectPath: string): RoadmapNodeLike[] {
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

function slugifyProjectId(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'project';
}

function csvEscape(value: string | number): string {
  const raw = String(value ?? '');
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function normalizeGlobalDataPath(rawPath: string, projects: SolopreneurProject[] = []): string {
  const trimmed = String(rawPath || '').trim();
  if (trimmed) {
    return trimmed.endsWith('.solomap-global') ? trimmed : path.join(trimmed, '.solomap-global');
  }
  const firstProjectPath = projects[0]?.path || process.cwd();
  return path.join(path.dirname(firstProjectPath), '.solomap-global');
}

function getLocalDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function daysUntilMonthEnd(date: Date): number {
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return end.getDate() - date.getDate();
}

function getDailyWorkRhythm(date = new Date()): string {
  const day = date.getDay();
  if (daysUntilMonthEnd(date) <= 2) return 'monthEnd';
  if (day === 1) return 'monday';
  if (day === 5) return 'friday';
  return 'daily';
}

function getDailyReviewMode(
  rhythm: string,
  portfolio: ProjectPortfolioSummary[],
  globalStore: Pick<GlobalEngineeringSnapshot, 'dependencies' | 'learningCandidateCount'>
): string {
  const hasUrgentSignal = portfolio.some((project) => (
    Number(project.delivery?.failedWorkflowRuns || 0) > 0
    || Number(project.failedNodes || 0) > 0
    || Number((project.issues?.byPriority || {}).P0 || 0) > 0
    || project.globalPriority === 'P0'
    || Boolean(project.blocker)
  ));
  if (hasUrgentSignal || (globalStore.dependencies || []).length > 0) {
    return 'exception_review';
  }
  if (rhythm === 'monday') {
    return 'weekly_planning';
  }
  if (rhythm === 'friday') {
    return 'learning_closeout';
  }
  if (rhythm === 'monthEnd') {
    return 'monthly_review';
  }
  if (Number(globalStore.learningCandidateCount || 0) > 0 || portfolio.some((project) => Number(project.reusableSignals || 0) > 0)) {
    return 'daily_learning';
  }
  if (portfolio.some((project) => Number(project.documentationPendingReview || 0) > 0)) {
    return 'daily_learning';
  }
  return 'daily_check';
}

function describeDailyReviewMode(mode: string): { title: string; instruction: string; checks: string[] } {
  if (mode === 'exception_review') {
    return {
      title: '异常优先审视',
      instruction: '先判断是否存在必须立刻处理的发布失败、失败环节、P0 反馈或跨项目阻断；只有没有紧急项时才给常规推进建议。',
      checks: [
        '把 P0、失败检查、失败环节和阻断排在所有规划动作之前。',
        '如果某个项目的下一步被阻断，给出打开项目、继续环节或调整路线图的最短动作。',
        '不要输出学习归档建议，除非它直接解除当前阻断。'
      ]
    };
  }
  if (mode === 'weekly_planning') {
    return {
      title: '周一重点校准',
      instruction: '把全局工程执行指南的周一规划内化成一次本周重点判断：检查 P0，确认本周 P1，给出 P2 备选，并扫描外部变化。',
      checks: [
        '先确认有没有项目应该升为 P0。',
        '明确本周最该推进的 1 个 P1 项目，并用用户能理解的理由说明。',
        '如果没有紧急项，优先给可开始、可闭环的新推进动作。'
      ]
    };
  }
  if (mode === 'learning_closeout') {
    return {
      title: '周五收尾与学习审视',
      instruction: '把全局工程执行指南的周五审核内化成一次收尾判断：检查学习候选、复用机会、下周起点和潜在 blocker。',
      checks: [
        '优先找本周已经完成、接近完成或可沉淀的项目。',
        '只把未来大概率复用的经验放入 needsConfirmation，避免把内部归档工作转嫁给用户。',
        '如果下周 P1 已显露 blocker，给出提前处理动作。'
      ]
    };
  }
  if (mode === 'monthly_review') {
    return {
      title: '月末优先级与复用回顾',
      instruction: '把全局工程执行指南的月末审视内化成一次月度判断：回顾执行效率、优先级准确度、知识沉淀质量和跨项目协调。',
      checks: [
        '优先识别优先级可能要调整的项目。',
        '检查可复用经验是否真的支撑了推进，而不是只被记录。',
        '如果跨项目依赖影响下月推进，给出调整路线图或打开项目的动作。'
      ]
    };
  }
  if (mode === 'daily_learning') {
    return {
      title: '日常学习消化',
      instruction: '在日常行动建议之外，轻量检查可复用线索和学习候选是否已经到了需要用户确认的程度。',
      checks: [
        '先给今天最该推进的动作。',
        '只有当经验明显跨项目可复用时，才放入 needsConfirmation。',
        '不要让学习整理压过当前最重要的推进动作。'
      ]
    };
  }
  return {
    title: '每日快速自查',
    instruction: '把全局工程执行指南的每日自查内化成一次快速判断：今天做什么，是否切换项目，是否有 blocker，是否能用已有经验解决。',
    checks: [
      '先判断今天应该继续当前项目还是切换到更高优先级项目。',
      '检查进行中、可开始和失败状态。',
      '如果没有异常，给出最容易形成闭环的一步。'
    ]
  };
}

function getDailyReviewDir(globalRoot: string): string {
  return path.join(globalRoot, 'daily');
}

function getDailyReviewPath(globalRoot: string, dateKey = getLocalDateKey()): string {
  return path.join(getDailyReviewDir(globalRoot), `${dateKey}.json`);
}

function normalizeDailyReviewTodo(value: any): DailyReviewTodo {
  return {
    title: String(value?.title || '').trim(),
    reason: String(value?.reason || '').trim(),
    projectPath: String(value?.projectPath || '').trim(),
    nodeId: String(value?.nodeId || '').trim(),
    action: String(value?.action || '').trim()
  };
}

function normalizeDailyReviewArtifact(value: any, resultPath = ''): DailyReviewArtifact | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const todos = Array.isArray(value.todos) ? value.todos.map(normalizeDailyReviewTodo).filter((item: DailyReviewTodo) => item.title) : [];
  const needsConfirmation = Array.isArray(value.needsConfirmation)
    ? value.needsConfirmation.map(normalizeDailyReviewTodo).filter((item: DailyReviewTodo) => item.title)
    : [];
  const status = ['running', 'completed', 'failed'].includes(String(value.status || '')) ? String(value.status) as DailyReviewArtifact['status'] : 'completed';
  return {
    schemaVersion: Number(value.schemaVersion || 1),
    date: String(value.date || getLocalDateKey()),
    generatedAt: String(value.generatedAt || ''),
    finishedAt: String(value.finishedAt || ''),
    rhythm: String(value.rhythm || 'daily'),
    reviewMode: String(value.reviewMode || ''),
    source: String(value.source || 'agent_review'),
    status,
    summary: String(value.summary || ''),
    todos,
    needsConfirmation,
    inputSnapshot: {
      projectCount: Number(value.inputSnapshot?.projectCount || 0),
      learningCandidateCount: Number(value.inputSnapshot?.learningCandidateCount || 0),
      blockedDependencyCount: Number(value.inputSnapshot?.blockedDependencyCount || 0),
      reviewMode: String(value.inputSnapshot?.reviewMode || value.reviewMode || '')
    },
    resultPath: String(value.resultPath || resultPath),
    promptPath: String(value.promptPath || ''),
    outputLog: String(value.outputLog || ''),
    error: String(value.error || '')
  };
}

function readTodayReview(globalDataPath: string, projects: SolopreneurProject[]): DailyReviewArtifact | null {
  const globalRoot = normalizeGlobalDataPath(globalDataPath, projects);
  const resultPath = getDailyReviewPath(globalRoot);
  if (!fs.existsSync(resultPath)) {
    return null;
  }
  try {
    return normalizeDailyReviewArtifact(JSON.parse(fs.readFileSync(resultPath, 'utf8')), resultPath);
  } catch {
    return {
      schemaVersion: 1,
      date: getLocalDateKey(),
      generatedAt: '',
      rhythm: getDailyWorkRhythm(),
      source: 'agent_review',
      status: 'failed',
      summary: '',
      todos: [],
      needsConfirmation: [],
      inputSnapshot: { projectCount: projects.length, learningCandidateCount: 0, blockedDependencyCount: 0, reviewMode: getDailyWorkRhythm() },
      resultPath,
      error: 'Today review cache is not valid JSON.'
    };
  }
}

function commonParent(paths: string[]): string {
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

function writeFileIfMissing(filePath: string, content: string): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

function writeSolomapMemoryExamples(memoryRoot: string, learningCandidatesDir: string): void {
  const examples: Array<{ filePath: string; content: string }> = [
    {
      filePath: path.join(memoryRoot, 'projects', '_example.md'),
      content: [
        '# Project Memory Example',
        '',
        'Create real project files as `projects/<project-slug>.md`. Keep only stable facts that help future work on that project.',
        '',
        '## Stable Facts',
        '- YYYY-MM-DD: Fact confirmed by current files, tests, logs, or user decision.',
        '',
        '## Decisions',
        '- YYYY-MM-DD: Decision, reason, and impact.',
        '',
        '## Current Handoff',
        '- Goal:',
        '- Confirmed state:',
        '- Next useful action:',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'patterns', '_example.md'),
      content: [
        '# Pattern Example',
        '',
        'Use one file per reusable delivery, implementation, debugging, or verification pattern.',
        '',
        '## Applies When',
        '- Situation where this pattern is useful.',
        '',
        '## Steps',
        '1. Action that reliably helps.',
        '2. Action that verifies the result.',
        '',
        '## Evidence',
        '- Where this pattern was validated.',
        '',
        '## Risks',
        '- When not to apply it.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'decisions', '_example.md'),
      content: [
        '# Decision Example',
        '',
        'Use one file per stable cross-project decision.',
        '',
        '## Status',
        '- proposed | accepted | superseded',
        '',
        '## Context',
        '- Why this decision exists.',
        '',
        '## Decision',
        '- What should happen from now on.',
        '',
        '## Impact',
        '- Projects, workflows, or user experience affected.',
        '',
        '## Review Trigger',
        '- When this decision should be revisited.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'domains', '_example.md'),
      content: [
        '# Domain Memory Example',
        '',
        'Use one file per domain that can help multiple projects.',
        '',
        '## Scope',
        '- What this domain memory covers.',
        '',
        '## Stable Knowledge',
        '- Verified domain fact or constraint.',
        '',
        '## Reuse Notes',
        '- How future projects should apply it.',
        '',
        '## Sources',
        '- File, user decision, command output, or trusted source that supports it.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'inbox', '_example.md'),
      content: [
        '# Inbox Example',
        '',
        'Use inbox for observations that may become memory but are not verified enough yet.',
        '',
        '## Observation',
        '- What was noticed.',
        '',
        '## Evidence',
        '- Where it came from.',
        '',
        '## Confidence',
        '- low | medium | high',
        '',
        '## Promotion Target',
        '- projects | patterns | decisions | domains | operating-rules | profile',
        '',
        '## Next Check',
        '- What must be verified before promotion.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(memoryRoot, 'active', '_example.md'),
      content: [
        '# Active Session Example',
        '',
        'Use active memory for temporary handoff only. Promote stable information elsewhere before it becomes long-lived.',
        '',
        '## Current Goal',
        '- What is being handled now.',
        '',
        '## Confirmed Facts',
        '- Current facts verified in this session.',
        '',
        '## Next Action',
        '- The next concrete action if work resumes.',
        '',
        '## Open Risks',
        '- Known unresolved risks.',
        ''
      ].join('\n')
    },
    {
      filePath: path.join(learningCandidatesDir, '_example.md'),
      content: [
        '# Learning Candidate Example',
        '',
        'Use this area for reusable lessons before they are promoted into long-term memory.',
        '',
        '## Candidate Lesson',
        '- What future agents may reuse.',
        '',
        '## Source Task',
        '- Project, date, and task where it was observed.',
        '',
        '## Evidence',
        '- File, test, log, command output, or user decision that supports it.',
        '',
        '## Applies When',
        '- Conditions where this lesson is useful.',
        '',
        '## Promotion Target',
        '- memory/projects | memory/patterns | memory/decisions | memory/domains | memory/inbox',
        ''
      ].join('\n')
    }
  ];
  examples.forEach((example) => {
    fs.mkdirSync(path.dirname(example.filePath), { recursive: true });
    writeFileIfMissing(example.filePath, example.content);
  });
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

function inferGlobalPriority(summary: Pick<ProjectPortfolioSummary, 'failedNodes' | 'runningNodes' | 'inProgressNodes' | 'pendingNodes' | 'issues' | 'delivery' | 'overallStatus'>): string {
  const p0Issues = Number((summary.issues?.byPriority || {}).P0 || 0);
  const failedWorkflowRuns = Number(summary.delivery?.failedWorkflowRuns || 0);
  if (p0Issues > 0 || failedWorkflowRuns > 0 || Number(summary.failedNodes || 0) > 0) return 'P0';
  if (Number(summary.runningNodes || 0) > 0 || Number(summary.inProgressNodes || 0) > 0) return 'P1';
  if (summary.overallStatus === 'Completed') return 'P2';
  return Number(summary.pendingNodes || 0) > 0 ? 'P1' : 'P2';
}

function inferIssuePressure(issues: ProjectIssueSummary): string {
  if (!issues?.available) return '';
  const p0 = Number((issues.byPriority || {}).P0 || 0);
  const bugs = Number((issues.byCategory || {}).bug || 0);
  if (p0 > 0) return `${p0} P0`;
  if (bugs > 0) return `${bugs} bug`;
  return issues.open ? `${issues.open} open` : '';
}

function inferDeliverySignal(delivery: ProjectDeliverySummary): string {
  if (!delivery?.available) return '';
  if (Number(delivery.failedWorkflowRuns || 0) > 0) return 'Delivery needs attention';
  if (delivery.latestRelease) return `Latest ${delivery.latestRelease}`;
  if (delivery.stale && delivery.syncedAt) return 'Delivery cached';
  if (delivery.latestWorkflowStatus) return 'Checks healthy';
  return '';
}

function countReusableSignals(projectPath: string): number {
  const candidates = [
    path.join(projectPath, '.solopreneur', 'step-memory'),
    path.join(projectPath, '.solopreneur', 'agent-runs')
  ];
  return candidates.reduce((count, candidate) => {
    try {
      return count + (fs.existsSync(candidate) ? fs.readdirSync(candidate).length : 0);
    } catch {
      return count;
    }
  }, 0);
}

function createGlobalEngineeringSnapshotPlaceholder(dataPath: string, portfolio: ProjectPortfolioSummary[]): GlobalEngineeringSnapshot {
  const normalizedPath = normalizeGlobalDataPath(dataPath);
  return {
    dataPath: normalizedPath,
    portfolio: portfolio.map((project) => ({
      id: slugifyProjectId(project.name || path.basename(project.path)),
      name: project.name,
      path: project.path,
      type: project.projectType || 'core_product',
      status: project.overallStatus || 'Pending',
      priority: project.globalPriority || 'P2',
      blocker: project.blocker || '',
      nextAction: project.globalNextAction || project.recommendedNodeTitle || '',
      updatedAt: project.recentActivityAt || ''
    })),
    dependencies: portfolio
      .filter((project) => project.blocker)
      .map((project) => ({
        fromProject: slugifyProjectId(project.name || path.basename(project.path)),
        toProject: '',
        capability: project.blocker,
        status: 'blocked',
        priorityImpact: 'raise_to_P0',
        reason: project.blocker,
        updatedAt: project.recentActivityAt || ''
      })),
    learningCandidateCount: 0
  };
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

function getRecommendedNode(nodes: RoadmapNodeLike[]): RoadmapNodeLike | null {
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

function hasProEntitlement(settings: Partial<SolopreneurSettings> | undefined, feature: ProFeatureKey): boolean {
  const entitlements = settings?.proEntitlements || {};
  return Boolean(entitlements[PRO_FEATURES[feature]] || entitlements[feature] || entitlements.pro || entitlements.solomap_pro);
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

function buildProjectPortfolioSummary(project: SolopreneurProject, options: { includeReusableSignals?: boolean } = {}): ProjectPortfolioSummary {
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
    recentActivityAt: getProjectRecentActivityAt(project.path),
    issues: readCachedIssueSummary(project.path),
    delivery: readCachedDeliverySummary(project.path)
  };
  const inferredPriority = inferGlobalPriority(baseSummary);
  const globalPriority = project.priority || inferredPriority;
  const deliverySignal = inferDeliverySignal(baseSummary.delivery);
  const needsRelease = baseSummary.delivery.available && totalNodes > 0 && completedNodes === totalNodes && !baseSummary.delivery.latestRelease;
  const documentationSummary = summarizeDocumentationForReview(project.path);
  return {
    ...baseSummary,
    globalPriority,
    projectType: project.type || detectProjectType(nodes),
    blocker: failedNodes > 0 ? (recommendedNode?.title || 'Failed roadmap step') : '',
    globalNextAction: baseSummary.delivery.failedWorkflowRuns > 0
      ? '修复发布检查'
      : recommendedNode?.title || (needsRelease ? '发布当前成果' : (totalNodes ? (stageSummary.gap ? `调整路线图：补齐 ${stageSummary.gap}` : 'Review completed roadmap') : 'Initialize roadmap')),
    reusableSignals: options.includeReusableSignals ? countReusableSignals(project.path) : 0,
    issuePressure: inferIssuePressure(baseSummary.issues),
    stageGap: stageSummary.gap,
    delivery: baseSummary.delivery,
    deliverySignal,
    documentationDocumentCount: documentationSummary.documentCount,
    documentationPendingReview: documentationSummary.pendingReviewCount,
    pinnedAt: project.pinnedAt || ''
  };
}

function buildProjectPortfolioSummaries(projects: SolopreneurProject[], options: { includeReusableSignals?: boolean } = {}): ProjectPortfolioSummary[] {
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

function ensureGlobalEngineeringStore(dataPath: string, portfolio: ProjectPortfolioSummary[]): GlobalEngineeringSnapshot {
  const normalizedPath = normalizeGlobalDataPath(dataPath);
  const learningDir = path.join(normalizedPath, 'learning', 'candidates');
  const learningApprovedDir = path.join(normalizedPath, 'learning', 'approved');
  const learningRejectedDir = path.join(normalizedPath, 'learning', 'rejected');
  const metricsDir = path.join(normalizedPath, 'metrics');
  const memoryRoot = path.join(normalizedPath, 'memory');
  fs.mkdirSync(learningDir, { recursive: true });
  fs.mkdirSync(learningApprovedDir, { recursive: true });
  fs.mkdirSync(learningRejectedDir, { recursive: true });
  fs.mkdirSync(metricsDir, { recursive: true });
  ['projects', 'patterns', 'decisions', 'domains', 'inbox', 'active'].forEach((dir) => {
    fs.mkdirSync(path.join(memoryRoot, dir), { recursive: true });
  });

  const now = new Date().toISOString();
  const records = portfolio.map((project) => ({
    id: slugifyProjectId(project.name || path.basename(project.path)),
    name: project.name,
    path: project.path,
    type: project.projectType || 'core_product',
    status: project.overallStatus || 'Pending',
    priority: project.globalPriority || 'P2',
    blocker: project.blocker || '',
    nextAction: project.globalNextAction || project.recommendedNodeTitle || '',
    updatedAt: now
  }));
  const dependencies = portfolio
    .filter((project) => project.blocker)
    .map((project) => ({
      fromProject: slugifyProjectId(project.name || path.basename(project.path)),
      toProject: '',
      capability: project.blocker,
      status: 'blocked',
      priorityImpact: 'raise_to_P0',
      reason: project.blocker,
      updatedAt: now
    }));

  const portfolioCsv = [
    'id,name,path,type,status,priority,blocker,next_action,updated_at',
    ...records.map((record) => [
      record.id,
      record.name,
      record.path,
      record.type,
      record.status,
      record.priority,
      record.blocker,
      record.nextAction,
      record.updatedAt
    ].map(csvEscape).join(','))
  ].join('\n') + '\n';
  const dependenciesCsv = [
    'from_project,to_project,capability,status,priority_impact,reason,updated_at',
    ...dependencies.map((record) => [
      record.fromProject,
      record.toProject,
      record.capability,
      record.status,
      record.priorityImpact,
      record.reason,
      record.updatedAt
    ].map(csvEscape).join(','))
  ].join('\n') + '\n';
  const capabilityCsvPath = path.join(normalizedPath, 'capability-registry.csv');
  const decisionsCsvPath = path.join(normalizedPath, 'decision-conflicts.csv');
  const readmePath = path.join(normalizedPath, 'README.md');
  const memoryReadmePath = path.join(memoryRoot, 'README.md');
  const profilePath = path.join(memoryRoot, 'profile.md');
  const operatingRulesPath = path.join(memoryRoot, 'operating-rules.md');
  const executionSpeedPath = path.join(metricsDir, 'execution-speed.csv');
  const reuseRatePath = path.join(metricsDir, 'reuse-rate.csv');
  const priorityAccuracyPath = path.join(metricsDir, 'priority-accuracy.csv');
  const monthlySummaryPath = path.join(metricsDir, 'monthly-summary.md');
  fs.writeFileSync(path.join(normalizedPath, 'portfolio.csv'), portfolioCsv, 'utf8');
  fs.writeFileSync(path.join(normalizedPath, 'dependencies.csv'), dependenciesCsv, 'utf8');
  if (!fs.existsSync(capabilityCsvPath)) {
    fs.writeFileSync(capabilityCsvPath, 'capability,first_project,reused_by,status,reuse_success_rate,last_improvement\n', 'utf8');
  }
  if (!fs.existsSync(decisionsCsvPath)) {
    fs.writeFileSync(decisionsCsvPath, 'topic,projects,conflict,resolution,status,owner,updated_at\n', 'utf8');
  }
  if (!fs.existsSync(executionSpeedPath)) {
    fs.writeFileSync(executionSpeedPath, 'project,node_id,stage,status,duration_ms,completed_at\n', 'utf8');
  }
  if (!fs.existsSync(reuseRatePath)) {
    fs.writeFileSync(reuseRatePath, 'project,node_id,reusable_signals,learning_candidates,recorded_at\n', 'utf8');
  }
  if (!fs.existsSync(priorityAccuracyPath)) {
    fs.writeFileSync(priorityAccuracyPath, 'project,priority,next_action,outcome,recorded_at\n', 'utf8');
  }
  if (!fs.existsSync(monthlySummaryPath)) {
    fs.writeFileSync(monthlySummaryPath, '# Monthly Learning Summary\n\nSoloMap uses this file to collect low-frequency cross-project learning signals.\n', 'utf8');
  }
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, [
      '# SoloMap Global Data',
      '',
      'This directory stores cross-project SoloMap coordination data.',
      '',
      '- `portfolio.csv`: project portfolio, priority, blocker, and next action.',
      '- `dependencies.csv`: cross-project blockers that affect priority.',
      '- `capability-registry.csv`: reusable capabilities confirmed or under review.',
      '- `decision-conflicts.csv`: cross-project decision conflicts.',
      '- `learning/candidates/`: learning candidates before they are promoted to long-term memory.',
      '- `learning/approved/`: candidates approved for promotion.',
      '- `learning/rejected/`: candidates that should stay out of long-term memory.',
      '- `metrics/`: low-frequency portfolio review metrics.',
      '- `memory/`: cross-project experience memory used by SoloMap agents.',
      '',
      'Do not delete this directory unless you intentionally want to remove SoloMap global coordination state.',
      ''
    ].join('\n'), 'utf8');
  }
  if (!fs.existsSync(memoryReadmePath)) {
    fs.writeFileSync(memoryReadmePath, [
      '# SoloMap Memory',
      '',
      'This directory stores reusable SoloMap experience across projects.',
      '',
      '- `profile.md`: stable user preferences and collaboration style.',
      '- `operating-rules.md`: reusable execution rules that apply across projects.',
      '- `projects/`: one memory file per project.',
      '- `patterns/`: reusable implementation, debugging, and delivery patterns.',
      '- `decisions/`: confirmed cross-project decisions and their rationale.',
      '- `domains/`: domain knowledge that can help future projects.',
      '- `inbox/`: unverified observations and learning candidates before promotion.',
      '- `active/`: current session handoff and temporary working context.',
      '',
      'Agents should treat memory as context, not as stronger evidence than current files, tests, logs, or the user request.',
      ''
    ].join('\n'), 'utf8');
  }
  if (!fs.existsSync(profilePath)) {
    fs.writeFileSync(profilePath, '# Profile\n\nStable user preferences and collaboration style promoted by SoloMap.\n', 'utf8');
  }
  if (!fs.existsSync(operatingRulesPath)) {
    fs.writeFileSync(operatingRulesPath, '# Operating Rules\n\nReusable execution rules promoted by SoloMap.\n', 'utf8');
  }
  writeSolomapMemoryExamples(memoryRoot, learningDir);
  const learningCandidateCount = (() => {
    try {
      return fs.readdirSync(learningDir).filter((name) => name.endsWith('.md') && name !== '_example.md').length;
    } catch {
      return 0;
    }
  })();
  return { dataPath: normalizedPath, portfolio: records, dependencies, learningCandidateCount };
}

function buildDailyReviewPrompt(options: {
  resultPath: string;
  dateKey: string;
  rhythm: string;
  reviewMode: string;
  portfolio: ProjectPortfolioSummary[];
  globalStore: GlobalEngineeringSnapshot;
}): string {
  const mode = describeDailyReviewMode(options.reviewMode);
  const snapshot = {
    date: options.dateKey,
    rhythm: options.rhythm,
    reviewMode: options.reviewMode,
    learningCandidateCount: options.globalStore.learningCandidateCount || 0,
    blockedDependencyCount: (options.globalStore.dependencies || []).length,
    projects: options.portfolio.map((project) => ({
      name: project.name,
      path: project.path,
      type: project.projectType,
      priority: project.globalPriority,
      status: project.overallStatus,
      progressPercent: project.progressPercent,
      blocker: project.blocker,
      nextAction: project.globalNextAction || project.recommendedNodeTitle,
      recommendedNodeId: project.recommendedNodeId,
      recommendedNodeTitle: project.recommendedNodeTitle,
      recommendedStatus: project.recommendedStatus,
      failedNodes: project.failedNodes,
      runningNodes: project.runningNodes,
      inProgressNodes: project.inProgressNodes,
      pendingNodes: project.pendingNodes,
      reusableSignals: project.reusableSignals,
      stageGap: project.stageGap,
      issuePressure: project.issuePressure,
      deliverySignal: project.deliverySignal,
      documentationDocumentCount: project.documentationDocumentCount || 0,
      documentationPendingReview: project.documentationPendingReview || 0
    }))
  };
  return [
    '# SoloMap 今日审视',
    '',
    '你要按 SoloMap 全局工程执行指南做一次轻量审视，只输出一个简单、可执行的今日 Todo 清单。',
    `本次按钮背后的审视模式是：${mode.title}。`,
    '',
    '## 必须遵守',
    '- 用户目标：少判断，直接知道今天该先做什么。',
    '- 不要改路线图、不要改优先级、不要创建新任务系统、不要写除结果 JSON 以外的文件。',
    '- 不要把 `.solomap-global`、CSV 字段、评分公式、内部目录结构暴露给用户。',
    '- Todo 必须回到已有项目、路线图环节、Issue 或路线图调整入口；如果拿不准，用项目级 action。',
    '- 最多输出 5 条 todos，最多 3 条 needsConfirmation。',
    '- 文案用用户行动语言，避免工程自描述。',
    '- needsConfirmation 只放确实需要用户确认的学习、优先级或阻断判断；不要把后台归档动作包装成用户任务。',
    '- 如果项目有文档待确认，只在周五、月末、日常学习或异常相关时放入 needsConfirmation；普通推进日不要让文档整理压过主行动。',
    '- action 只能使用 open_project、continue_step、adjust_roadmap、confirm_learning、ignore_suggestion、open_issue。',
    '',
    '## 本次情景化审视逻辑',
    mode.instruction,
    ...mode.checks.map((item) => `- ${item}`),
    '',
    '## 全局工程执行指南第一部分已内化为这些判断',
    '- 每日：今天先做什么；是否继续当前项目；是否切换到更高优先级；blocker 是否能用已有经验解决。',
    '- 周一：先检查 P0；确认本周 P1；保留 P2 备选；扫描外部变化和跨项目模式。',
    '- 周五：检查学习候选；判断经验是否值得复用；预览下周 P1；提前识别 blocker。',
    '- 月末：回顾执行效率、优先级准确度、知识沉淀质量和跨项目协调。',
    '- 异常：只要出现失败检查、失败环节、P0 反馈或依赖阻断，先处理异常，再考虑周期节奏。',
    '',
    '## 输出优先级',
    '1. 异常处理：发布检查、失败环节、P0 Issue、跨项目阻断。',
    '2. 当前推进：本周 P1、Running/In Progress、可开始 Pending。',
    '3. 收尾复利：完成验证、学习候选、可复用经验、路线图调整。',
    '4. 文档卫生：只处理 documentationPendingReview 指出的正式文档风险，不新增文档后台或独立任务系统。',
    '',
    '## 当前本地事实快照',
    '```json',
    JSON.stringify(snapshot, null, 2),
    '```',
    '',
    '## 写入结果',
    `请把结果写入这个 JSON 文件：${options.resultPath}`,
    '',
    '结果必须是合法 JSON，结构如下：',
    '```json',
    JSON.stringify({
      schemaVersion: 1,
      date: options.dateKey,
      generatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      rhythm: options.rhythm,
      reviewMode: options.reviewMode,
      source: 'agent_review',
      status: 'completed',
      summary: '一句话说明今天的安排判断。',
      todos: [
        {
          title: '行动标题',
          reason: '为什么今天做它',
          projectPath: '/absolute/project/path',
          nodeId: 'optional-roadmap-node-id',
          action: 'open_project'
        }
      ],
      needsConfirmation: [
        {
          title: '需要用户确认的选择',
          reason: '为什么需要确认',
          projectPath: '/absolute/project/path',
          action: 'confirm_priority'
        }
      ],
      inputSnapshot: {
        projectCount: snapshot.projects.length,
        learningCandidateCount: snapshot.learningCandidateCount,
        blockedDependencyCount: snapshot.blockedDependencyCount,
        reviewMode: options.reviewMode
      }
    }, null, 2),
    '```',
    '',
    '完成后不要再解释，只确保文件已经写好。'
  ].join('\n');
}

function startDailyReviewAgent(settings: SolopreneurSettings, projects: SolopreneurProject[], extensionUri?: vscode.Uri): DailyReviewArtifact {
  const portfolio = buildProjectPortfolioSummaries(projects, { includeReusableSignals: true });
  const globalStore = ensureGlobalEngineeringStore(settings.globalDataPath, portfolio);
  const dateKey = getLocalDateKey();
  const rhythm = getDailyWorkRhythm();
  const reviewMode = getDailyReviewMode(rhythm, portfolio, globalStore);
  const dailyDir = getDailyReviewDir(globalStore.dataPath);
  const runDir = path.join(dailyDir, 'runs', `${dateKey}-${Date.now()}`);
  const resultPath = getDailyReviewPath(globalStore.dataPath, dateKey);
  const promptPath = path.join(runDir, 'prompt.txt');
  const outputLog = path.join(runDir, 'output.log');
  const runScriptPath = path.join(runDir, 'run.sh');
  fs.mkdirSync(runDir, { recursive: true });

  const artifact: DailyReviewArtifact = {
    schemaVersion: 1,
    date: dateKey,
    generatedAt: new Date().toISOString(),
    rhythm,
    reviewMode,
    source: 'agent_review',
    status: 'running',
    summary: '',
    todos: [],
    needsConfirmation: [],
    inputSnapshot: {
      projectCount: projects.length,
      learningCandidateCount: globalStore.learningCandidateCount || 0,
      blockedDependencyCount: (globalStore.dependencies || []).length,
      reviewMode
    },
    resultPath,
    promptPath,
    outputLog
  };
  fs.writeFileSync(resultPath, JSON.stringify(artifact, null, 2), 'utf8');

  const prompt = buildDailyReviewPrompt({ resultPath, dateKey, rhythm, reviewMode, portfolio, globalStore });
  fs.writeFileSync(promptPath, prompt, 'utf8');

  const requestedAgentCli = (settings.cliPath || 'agy').trim();
  const agentCli = resolveAgentCli(requestedAgentCli, settings.cliPath);
  if (!commandExists(agentCli)) {
    artifact.status = 'failed';
    artifact.error = `Agent CLI not found. Tried: ${getAgentCliCandidates(requestedAgentCli, settings.cliPath).join(', ')}.`;
    artifact.finishedAt = new Date().toISOString();
    fs.writeFileSync(resultPath, JSON.stringify(artifact, null, 2), 'utf8');
    return artifact;
  }

  const workspaceRoot = commonParent([
    path.dirname(globalStore.dataPath),
    ...projects.map((project) => project.path)
  ]);
  const agentCommand = buildAgentCommandForPromptFile(agentCli, promptPath, workspaceRoot, settings.taskPermissionMode);
  const finalizer = [
    'const fs = require("fs");',
    `const resultPath = ${JSON.stringify(resultPath)};`,
    `const outputLog = ${JSON.stringify(outputLog)};`,
    'const code = Number(process.env.SOLOMAP_AGENT_STATUS || 0);',
    'let data = {};',
    'try { data = JSON.parse(fs.readFileSync(resultPath, "utf8")); } catch {}',
    'if (data.status !== "completed" && data.status !== "failed") {',
    '  data = Object.assign({}, data, {',
    '    schemaVersion: 1,',
    `    date: ${JSON.stringify(dateKey)},`,
    `    rhythm: ${JSON.stringify(rhythm)},`,
    `    reviewMode: ${JSON.stringify(reviewMode)},`,
    '    source: "agent_review",',
    '    status: "failed",',
    '    summary: "",',
    '    todos: Array.isArray(data.todos) ? data.todos : [],',
    '    needsConfirmation: Array.isArray(data.needsConfirmation) ? data.needsConfirmation : [],',
    '    finishedAt: new Date().toISOString(),',
    '    outputLog,',
    '    error: code === 0 ? "Agent finished but did not write the review JSON." : "Agent review command failed. Open the run log for details."',
    '  });',
    '  fs.writeFileSync(resultPath, JSON.stringify(data, null, 2), "utf8");',
    '}'
  ].join('\n');
  const script = [
    '#!/usr/bin/env bash',
    'set +e',
    `cd ${shellQuote(workspaceRoot)}`,
    `${agentCommand} 2>&1 | tee ${shellQuote(outputLog)}`,
    'status=${PIPESTATUS[0]}',
    `SOLOMAP_AGENT_STATUS=$status node -e ${shellQuote(finalizer)}`,
    'exit $status'
  ].join('\n');
  fs.writeFileSync(runScriptPath, script, 'utf8');

  const terminalOpts: vscode.TerminalOptions = {
    name: `Agent Review · ${dateKey}`,
    cwd: workspaceRoot,
  };
  if (extensionUri) {
    terminalOpts.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'logo.svg');
  }
  const terminal = vscode.window.createTerminal(terminalOpts);
  terminal.show(true);
  terminal.sendText(`bash ${shellQuote(runScriptPath)}`);
  return artifact;
}

export class SolopreneurSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'solopreneur.sidebar';
  private _view?: vscode.WebviewView;
  private _portfolioLoadRequest = 0;
  private _issueLoadRequest = 0;
  private _deliveryLoadRequest = 0;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _syncEngine: SyncEngine,
    private readonly _onRunAgent: (nodeId: string, userMessage?: string, agentCli?: string, model?: string, supplementFiles?: string[]) => Promise<void>,
    private readonly _getSettings: () => SolopreneurSettings,
    private readonly _updateSettings: (settings: SolopreneurSettings) => Promise<void>,
    private readonly _getProjects: () => { projects: SolopreneurProject[]; selectedProjectPath: string },
    private readonly _selectProject: (projectPath: string) => Promise<void>,
    private readonly _addProject: () => Promise<void>,
    private readonly _onRunSolo?: (projectPath: string, userMessage?: string, agentCli?: string, model?: string, supplementFiles?: string[]) => Promise<void>,
    private readonly _onRunFlow?: (projectPath: string, goal?: string, agentCli?: string, model?: string, supplementFiles?: string[]) => Promise<void>,
    private readonly _getAgentModels?: (agentCli: string) => Promise<AgentModelCatalog>,
    private readonly _chooseSoloSupplementFiles?: (projectPath: string) => Promise<string[]>,
    private readonly _getSoloConversationHistory?: (projectPath: string) => Promise<AgentConversation[]>,
    private readonly _continueSoloConversation?: (projectPath: string, conversationId: number) => Promise<void>,
    private readonly _continueStepConversation?: (projectPath: string, nodeId: string, conversationId: number) => Promise<void>,
    private readonly _getStepConversationHistory?: (projectPath: string, nodeId: string) => Promise<AgentConversation[]>,
    private readonly _getProjectConversationHistory?: (projectPath: string) => Promise<AgentConversation[]>,
    private readonly _toggleProjectPinned?: (projectPath: string) => Promise<void>,
    private readonly _savePastedAttachments?: (projectPath: string, scope: string, attachments: any[]) => Promise<string[]>,
    private readonly _installSkill?: (skillInput: string) => Promise<void>,
    private readonly _installMcp?: (mcpInput: string) => Promise<void>,
    private readonly _installEnhancement?: (enhancementId: string) => Promise<void>,
    private readonly _checkEnhancement?: (enhancementId: string) => Promise<void>,
    private readonly _setEnhancementEnabled?: (enhancementId: string, enabled: boolean) => Promise<void>,
    private readonly _uninstallEnhancement?: (enhancementId: string) => Promise<void>,
    private readonly _uninstallSkill?: (skillId: string) => Promise<void>,
    private readonly _uninstallMcp?: (mcpId: string) => Promise<void>,
    private readonly _getFeedbackUsageSummary?: () => string,
    private readonly _stopConversation?: (projectPath: string, nodeId: string, conversationId: number) => Promise<void>,
    private readonly _rollbackChanges?: (projectPath: string, gitHash: string) => Promise<void>,
    private readonly _manageProAuthorization?: (action?: string) => Promise<void>
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    try {
      // Allow scripts and configure local resource roots
      webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: [this._extensionUri]
      };

      webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    } catch (error) {
      console.error('SoloMap sidebar failed to render initial HTML:', error);
      webviewView.webview.html = this.getSidebarFallbackHtml('SoloMap sidebar could not render. Open the command palette and run "Developer: Reload Window".');
    }

    // Listen to messages from the webview
    webviewView.webview.onDidReceiveMessage(async (data) => {
      try {
        switch (data.command) {
          case 'getNodes':
            this.sendNodesToWebview();
            break;
          case 'runAgent':
            await this._onRunAgent(data.nodeId, data.userMessage || '', data.agentCli || '', data.model || '', data.supplementFiles || []);
            break;
          case 'runSoloConversation':
            if (this._onRunSolo) {
              await this._onRunSolo(data.projectPath || '', data.userMessage || '', data.agentCli || '', data.model || '', data.supplementFiles || []);
              await this.sendSoloConversationHistory(data.projectPath || '');
            }
            break;
          case 'runFlow':
            if (this._onRunFlow) {
              await this._onRunFlow(data.projectPath || '', data.goal || '', data.agentCli || '', data.model || '', data.supplementFiles || []);
            }
            break;
          case 'getAgentModels':
            if (this._getAgentModels) {
              const requestedAgentCli = data.agentCli || '';
              const catalog = await this._getAgentModels(requestedAgentCli);
              this._view?.webview.postMessage({
                command: 'agentModelsLoaded',
                requestId: String(data.requestId || ''),
                targetId: String(data.targetId || ''),
                agentCli: requestedAgentCli,
                catalog
              });
            }
            break;
          case 'chooseSoloSupplementFiles':
            if (this._chooseSoloSupplementFiles) {
              const files = await this._chooseSoloSupplementFiles(data.projectPath || '');
              this._view?.webview.postMessage({ command: 'soloSupplementFilesSelected', targetId: data.targetId || '', files });
            }
            break;
          case 'savePastedAttachments':
            if (this._savePastedAttachments) {
              const files = await this._savePastedAttachments(data.projectPath || '', data.scope || data.targetId || 'conversation', data.attachments || []);
              this._view?.webview.postMessage({ command: 'pastedAttachmentsSaved', targetId: data.targetId || '', files });
            }
            break;
          case 'getSoloConversationHistory':
            await this.sendSoloConversationHistory(data.projectPath || '');
            break;
          case 'getStepConversationHistory':
            await this.sendStepConversationHistory(data.projectPath || '', data.nodeId || '');
            break;
          case 'getProjectConversationHistory':
            await this.sendProjectConversationHistory(data.projectPath || '');
            break;
          case 'continueSoloConversation':
            if (this._continueSoloConversation) {
              await this._continueSoloConversation(data.projectPath || '', Number(data.conversationId || 0));
            }
            break;
          case 'continueStepConversation':
            if (this._continueStepConversation) {
              await this._continueStepConversation(data.projectPath || '', data.nodeId || '', Number(data.conversationId || 0));
            }
            break;
          case 'stopConversation':
            if (this._stopConversation) {
              await this._stopConversation(data.projectPath || '', data.nodeId || '', Number(data.conversationId || 0));
              await this.sendProjectConversationHistory(data.projectPath || '');
              await this.sendSoloConversationHistory(data.projectPath || '');
              if (data.nodeId) {
                await this.sendStepConversationHistory(data.projectPath || '', data.nodeId || '');
              }
            }
            break;
          case 'rollbackChanges':
            if (this._rollbackChanges) {
              await this._rollbackChanges(data.projectPath || '', data.gitHash || '');
              await this.sendSoloConversationHistory(data.projectPath || '');
              if (data.nodeId) {
                await this.sendStepConversationHistory(data.projectPath || '', data.nodeId || '');
              }
            }
            break;
          case 'toggleProjectPinned':
            if (this._toggleProjectPinned) {
              await this._toggleProjectPinned(data.projectPath || '');
            }
            break;
          case 'showStrategyPyramid':
            vscode.commands.executeCommand('solopreneur.showStrategyPyramid');
            break;
          case 'showFullRoadmap':
            vscode.commands.executeCommand('solopreneur.showRoadmap');
            break;
          case 'showFlowView':
            vscode.commands.executeCommand('solopreneur.showFlow');
            break;
          case 'openProAuthorization':
            if (this._manageProAuthorization) {
              await this._manageProAuthorization('login');
            } else {
              await vscode.commands.executeCommand('solopreneur.manageProAuthorization', 'login');
            }
            this.sendSettings();
            break;
          case 'pasteProAuthorizationCode':
            if (this._manageProAuthorization) {
              await this._manageProAuthorization('paste');
            } else {
              await vscode.commands.executeCommand('solopreneur.manageProAuthorization', 'paste');
            }
            this.sendSettings();
            break;
          case 'getSettings':
            this.sendSettings();
            break;
          case 'updateSettings':
            await this._updateSettings({
              cliPath: data.cliPath,
              language: data.language,
              globalPrompt: data.globalPrompt,
              globalDataPath: data.globalDataPath,
              reviewerCliPath: data.reviewerCliPath,
              collaborationReviewMode: data.collaborationReviewMode,
              taskPermissionMode: 'auto'
            });
            vscode.window.showInformationMessage('SoloMap settings saved successfully!');
            // Broadcast to sync both Webviews
            this.sendSettings();
            // Trigger updates on the full screen view if active
            vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
            break;
          case 'installSkill':
            if (this._installSkill) {
              await this._installSkill(data.skillInput || '');
            }
            break;
          case 'installMcp':
            if (this._installMcp) {
              await this._installMcp(data.mcpInput || '');
            }
            break;
          case 'installEnhancement':
            if (this._installEnhancement) {
              await this._installEnhancement(data.enhancementId || '');
            }
            break;
          case 'checkEnhancement':
            if (this._checkEnhancement) {
              await this._checkEnhancement(data.enhancementId || '');
            }
            break;
          case 'setEnhancementEnabled':
            if (this._setEnhancementEnabled) {
              await this._setEnhancementEnabled(data.enhancementId || '', Boolean(data.enabled));
            }
            break;
          case 'uninstallEnhancement':
            if (this._uninstallEnhancement) {
              await this._uninstallEnhancement(data.enhancementId || '');
            }
            break;
          case 'uninstallSkill':
            if (this._uninstallSkill) {
              await this._uninstallSkill(data.skillId || '');
            }
            break;
          case 'uninstallMcp':
            if (this._uninstallMcp) {
              await this._uninstallMcp(data.mcpId || '');
            }
            break;
          case 'testCli':
            const cliToTest = resolveAgentCli('antigravity-cli', data.cliPath || '');
            childProcess.execFile(cliToTest, getCliVersionArgs(cliToTest), (error: any, stdout: string, stderr: string) => {
              const success = !error;
              let msg = error ? error.message : formatCliTestMessage(cliToTest, stdout, stderr);
              if (!success) {
                const candidates = getAgentCliCandidates('antigravity-cli', data.cliPath || '').join(', ');
                msg = `Command not found or failed. Tried: ${candidates}`;
              }
              this._view?.webview.postMessage({
                command: 'cliTestResult',
                success,
                message: msg
              });
            });
            break;
          case 'checkDependencies':
            this._view?.webview.postMessage({
              command: 'dependenciesChecked',
              status: getDependencyStatus(data.cliPath || this._getSettings().cliPath || 'agy')
            });
            break;
          case 'prepareAgentAutomation': {
            const settings = this._getSettings();
            const projectState = this._getProjects();
            const prepared = buildAgentAutomationWrapper(data.cliPath || settings.cliPath || 'agy', settings.globalDataPath, projectState.projects || []);
            if (prepared.ok && prepared.wrapperPath) {
              await this._updateSettings({
                ...settings,
                cliPath: prepared.wrapperPath,
                taskPermissionMode: 'auto'
              });
              this.sendSettings();
              vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
            }
            this._view?.webview.postMessage({
              command: 'dependenciesChecked',
              status: getDependencyStatus(prepared.wrapperPath || data.cliPath || settings.cliPath || 'agy')
            });
            if (prepared.ok) {
              vscode.window.showInformationMessage(prepared.message);
            } else {
              vscode.window.showErrorMessage(prepared.message);
            }
            break;
          }
          case 'getAgentImpact':
            this._view?.webview.postMessage({
              command: 'agentImpactLoaded',
              status: getAgentImpactStatus(this._getProjects().projects)
            });
            break;
          case 'getDailyReview':
            this.sendDailyReview();
            break;
          case 'runDailyReview': {
            const review = startDailyReviewAgent(this._getSettings(), this._getProjects().projects, this._extensionUri);
            this._view?.webview.postMessage({ command: 'dailyReviewLoaded', review });
            break;
          }
          case 'openDependencyAction':
            this.openDependencyAction(data.action || '', data.cliPath || this._getSettings().cliPath || 'agy');
            break;
          case 'openExternal':
            if (data.url) {
              vscode.env.openExternal(vscode.Uri.parse(String(data.url)));
            }
            break;
          case 'openFeedbackIssue':
            vscode.env.openExternal(vscode.Uri.parse(buildFeedbackIssueUrl(data.title || '', data.body || '', data.category || '', this._getFeedbackUsageSummary ? this._getFeedbackUsageSummary() : '')));
            break;
          case 'getIssueDetails':
            this.sendIssueDetails(data.projectPath || '', Number(data.issueNumber || 0));
            break;
          case 'createIssue': {
            const result = createProjectIssue(
              data.projectPath || '',
              String(data.title || '').trim(),
              String(data.body || '').trim(),
              String(data.category || 'discussion'),
              String(data.priority || '')
            );
            this._view?.webview.postMessage({
              command: 'issueActionCompleted',
              projectPath: data.projectPath || '',
              success: result.ok,
              message: result.message
            });
            this.sendProjects();
            break;
          }
          case 'closeIssue': {
            const result = closeProjectIssue(data.projectPath || '', Number(data.issueNumber || 0));
            this._view?.webview.postMessage({
              command: 'issueActionCompleted',
              projectPath: data.projectPath || '',
              success: result.ok,
              message: result.message
            });
            this.sendProjects();
            break;
          }
          case 'refreshProjectData': {
            const projectPath = String(data.projectPath || '');
            let issues: ProjectIssueSummary | null = null;
            let delivery: ProjectDeliverySummary | null = null;
            try {
              [issues, delivery] = await Promise.all([
                readProjectIssueSummaryAsync(projectPath),
                readProjectDeliverySummaryAsync(projectPath)
              ]);
            } catch (error) {
              console.error('SoloMap sidebar failed to refresh project data:', error);
            }
            if (issues) {
              this._view?.webview.postMessage({
                command: 'projectIssuesLoaded',
                projectPath,
                issues
              });
            }
            if (delivery) {
              this._view?.webview.postMessage({
                command: 'projectDeliveryLoaded',
                projectPath,
                delivery
              });
            }
            this._view?.webview.postMessage({
              command: 'projectRefreshCompleted',
              projectPath,
              success: Boolean(issues?.available || delivery?.available),
              message: issues?.message || delivery?.message || ''
            });
            break;
          }
          case 'getProjects':
            this.sendProjects();
            break;
          case 'selectProject':
            await this._selectProject(data.projectPath);
            break;
          case 'addProject':
            await this._addProject();
            break;
          case 'openProjectFromPortfolio':
            await this._selectProject(data.projectPath);
            vscode.commands.executeCommand('solopreneur.showRoadmap');
            break;
          case 'continueProjectFromPortfolio':
            await this._selectProject(data.projectPath);
            if (data.nodeId) {
              await this._onRunAgent(data.nodeId);
            } else {
              vscode.commands.executeCommand('solopreneur.showRoadmap');
            }
            break;
        }
      } catch (error) {
        console.error('SoloMap sidebar message failed:', data?.command, error);
        this._view?.webview.postMessage({
          command: 'sidebarActionFailed',
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });

    // Request initial data push
    this.sendInitialDataToWebview();
  }

  /**
   * Refreshes the sidebar view with updated node states.
   */
  public sendNodesToWebview() {
    try {
      if (!this._view || !this._syncEngine) {
        return;
      }
      const nodes = this._syncEngine.getNodes();
      this._view.webview.postMessage({
        command: 'nodesUpdated',
        nodes: nodes,
        projectPath: this._getProjects().selectedProjectPath
      });
    } catch (error) {
      console.error('SoloMap sidebar failed to send nodes:', error);
    }
  }

  /**
   * Reads and pushes active configuration settings to the sidebar.
   */
  public sendSettings() {
    try {
      if (!this._view) {
        return;
      }
      this._view.webview.postMessage({
        command: 'settingsLoaded',
        settings: this._getSettings()
      });
    } catch (error) {
      console.error('SoloMap sidebar failed to send settings:', error);
    }
  }

  public postSkillInstallResult(success: boolean, message: string) {
    this._view?.webview.postMessage({
      command: 'skillInstallResult',
      success,
      message,
      settings: this._getSettings()
    });
  }

  public postMcpInstallResult(success: boolean, message: string) {
    this._view?.webview.postMessage({
      command: 'mcpInstallResult',
      success,
      message,
      settings: this._getSettings()
    });
  }

  public postEnhancementInstallResult(success: boolean, message: string) {
    this._view?.webview.postMessage({
      command: 'enhancementInstallResult',
      success,
      message,
      settings: this._getSettings()
    });
  }

  public sendProjects() {
    try {
      if (!this._view) {
        return;
      }
      const projectState = this._getProjects();
      const portfolio = buildProjectPortfolioSummaries(projectState.projects);
      const globalStore = createGlobalEngineeringSnapshotPlaceholder(this._getSettings().globalDataPath, portfolio);
      this._view.webview.postMessage({
        command: 'projectsLoaded',
        projects: {
          ...projectState,
          portfolio,
          globalStore
        }
      });
      void this.sendSoloConversationHistory(projectState.selectedProjectPath);
      void this.sendProjectConversationHistory(projectState.selectedProjectPath);
      this.sendDailyReview();
      this.schedulePortfolioEnrichment(projectState.projects, projectState.selectedProjectPath);
      this.scheduleIssueSummaryLoads(projectState.projects, projectState.selectedProjectPath);
      this.scheduleDeliverySummaryLoads(projectState.projects, projectState.selectedProjectPath);
    } catch (error) {
      console.error('SoloMap sidebar failed to send projects:', error);
      this._view?.webview.postMessage({
        command: 'projectsLoaded',
        projects: {
          projects: [],
          selectedProjectPath: '',
          portfolio: [],
          globalStore: {
            dataPath: '',
            portfolio: [],
            dependencies: [],
            learningCandidateCount: 0
          }
        }
      });
    }
  }

  public sendLocalProjects() {
    try {
      if (!this._view) {
        return;
      }
      this._portfolioLoadRequest += 1;
      this._issueLoadRequest += 1;
      this._deliveryLoadRequest += 1;
      const projectState = this._getProjects();
      const portfolio = buildProjectPortfolioSummaries(projectState.projects);
      const globalStore = createGlobalEngineeringSnapshotPlaceholder(this._getSettings().globalDataPath, portfolio);
      this._view.webview.postMessage({
        command: 'projectsLoaded',
        projects: {
          ...projectState,
          portfolio,
          globalStore
        }
      });
    } catch (error) {
      console.error('SoloMap sidebar failed to send local projects:', error);
    }
  }

  private schedulePortfolioEnrichment(projects: SolopreneurProject[], selectedProjectPath: string) {
    const requestId = ++this._portfolioLoadRequest;
    setTimeout(() => {
      try {
        if (!this._view || requestId !== this._portfolioLoadRequest) {
          return;
        }
        const portfolio = buildProjectPortfolioSummaries(projects, { includeReusableSignals: true });
        let globalStore: GlobalEngineeringSnapshot;
        try {
          globalStore = ensureGlobalEngineeringStore(this._getSettings().globalDataPath, portfolio);
        } catch {
          globalStore = createGlobalEngineeringSnapshotPlaceholder(this._getSettings().globalDataPath, portfolio);
        }
        this._view.webview.postMessage({
          command: 'projectsLoaded',
          projects: {
            projects,
            selectedProjectPath,
            portfolio,
            globalStore
          }
        });
      } catch (error) {
        console.error('SoloMap sidebar failed to enrich portfolio:', error);
      }
    }, 1000);
  }

  private scheduleIssueSummaryLoads(projects: SolopreneurProject[], selectedProjectPath: string) {
    const requestId = ++this._issueLoadRequest;
    const ordered = [
      ...projects.filter((project) => project.path === selectedProjectPath),
      ...projects.filter((project) => project.path !== selectedProjectPath)
    ];
    ordered.forEach((project, index) => {
      setTimeout(() => {
        if (!this._view || requestId !== this._issueLoadRequest) {
          return;
        }
        void readProjectIssueSummaryAsync(project.path).then((issues) => {
          if (!this._view || requestId !== this._issueLoadRequest) {
            return;
          }
          this._view.webview.postMessage({
            command: 'projectIssuesLoaded',
            projectPath: project.path,
            issues
          });
        }).catch((error) => {
          console.error('SoloMap sidebar failed to refresh issue summary:', error);
        });
      }, 1200 + 80 * index);
    });
  }

  private scheduleDeliverySummaryLoads(projects: SolopreneurProject[], selectedProjectPath: string) {
    const requestId = ++this._deliveryLoadRequest;
    const ordered = [
      ...projects.filter((project) => project.path === selectedProjectPath),
      ...projects.filter((project) => project.path !== selectedProjectPath)
    ];
    ordered.forEach((project, index) => {
      setTimeout(() => {
        if (!this._view || requestId !== this._deliveryLoadRequest) {
          return;
        }
        void readProjectDeliverySummaryAsync(project.path).then((delivery) => {
          if (!this._view || requestId !== this._deliveryLoadRequest) {
            return;
          }
          this._view.webview.postMessage({
            command: 'projectDeliveryLoaded',
            projectPath: project.path,
            delivery
          });
        }).catch((error) => {
          console.error('SoloMap sidebar failed to refresh delivery summary:', error);
        });
      }, 1400 + 120 * index);
    });
  }

  private sendIssueDetails(projectPath: string, issueNumber: number) {
    if (!projectPath || !issueNumber) {
      return;
    }
    const cached = readCachedIssueDetails(projectPath, issueNumber);
    if (cached) {
      this._view?.webview.postMessage({
        command: 'issueDetailsLoaded',
        projectPath,
        issueNumber,
        ...cached
      });
    }
    setTimeout(() => {
      if (!this._view) {
        return;
      }
      this._view.webview.postMessage({
        command: 'issueDetailsLoaded',
        projectPath,
        issueNumber,
        ...readProjectIssueDetails(projectPath, issueNumber)
      });
    }, 0);
  }

  public async sendSoloConversationHistory(projectPath: string) {
    try {
      if (!this._view || !this._getSoloConversationHistory || !projectPath) {
        return;
      }
      const conversations = await this._getSoloConversationHistory(projectPath);
      this._view.webview.postMessage({
        command: 'sidebarSoloConversationLoaded',
        projectPath,
        conversations
      });
    } catch (error) {
      console.error('SoloMap sidebar failed to send solo conversation history:', error);
    }
  }

  public async sendStepConversationHistory(projectPath: string, nodeId: string) {
    try {
      if (!this._view || !this._getStepConversationHistory || !projectPath || !nodeId) {
        return;
      }
      const conversations = await this._getStepConversationHistory(projectPath, nodeId);
      this._view.webview.postMessage({
        command: 'sidebarStepConversationLoaded',
        projectPath,
        nodeId,
        conversations
      });
    } catch (error) {
      console.error('SoloMap sidebar failed to send step conversation history:', error);
    }
  }

  public async sendProjectConversationHistory(projectPath: string) {
    try {
      if (!this._view || !this._getProjectConversationHistory || !projectPath) {
        return;
      }
      const conversations = await this._getProjectConversationHistory(projectPath);
      this._view.webview.postMessage({
        command: 'sidebarProjectConversationLoaded',
        projectPath,
        conversations
      });
    } catch (error) {
      console.error('SoloMap sidebar failed to send project conversation history:', error);
    }
  }

  public sendDailyReview() {
    try {
      if (!this._view) {
        return;
      }
      const projectState = this._getProjects();
      this._view.webview.postMessage({
        command: 'dailyReviewLoaded',
        review: readTodayReview(this._getSettings().globalDataPath, projectState.projects)
      });
    } catch (error) {
      console.error('SoloMap sidebar failed to send daily review:', error);
    }
  }

  private sendInitialDataToWebview() {
    this.sendNodesToWebview();
    this.sendSettings();
    this.sendProjects();
  }

  private getSidebarFallbackHtml(message: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SoloMap</title>
  <style>
    body { margin: 0; padding: 14px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
    .title { font-size: 13px; font-weight: 700; margin-bottom: 8px; }
    .message { font-size: 12px; line-height: 1.45; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <div class="title">SoloMap</div>
  <div class="message">${escapeHtmlText(message)}</div>
</body>
</html>`;
  }

  private openDependencyAction(action: string, cliPath: string) {
    const terminal = vscode.window.createTerminal({
      name: 'Setup',
      iconPath: vscode.Uri.joinPath(this._extensionUri, 'resources', 'logo.svg'),
    });
    terminal.show(true);
    if (action === 'github-auth') {
      terminal.sendText('gh auth login');
      return;
    }
    if (action === 'github-install') {
      terminal.sendText('gh --version || echo "Install GitHub CLI from https://cli.github.com/"');
      return;
    }
    if (action === 'agent-install') {
      terminal.sendText(buildAgentInstallCommand(cliPath || 'agy'));
      return;
    }
    if (action === 'agent-check') {
      const command = resolveAgentCli(cliPath || 'agy', cliPath || 'agy');
      terminal.sendText(`${shellQuote(command)} --version`);
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
    const wordmarkUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'logo_with_text.svg'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SoloMap</title>
  <!-- Load Inter & Outfit Fonts Asynchronously -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=Outfit:wght@400;600;800&display=swap" media="print" onload="this.media='all'">
  <link rel="stylesheet" href="${codiconsUri}">
  <noscript>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=Outfit:wght@400;600;800&display=swap" rel="stylesheet">
  </noscript>

  <style>
    :root {
      --bg-dark: #0f111a;
      --bg-glass: rgba(22, 28, 45, 0.5);
      --border-glass: rgba(255, 255, 255, 0.08);
      --glow-blue: rgba(0, 229, 255, 0.8);
      --glow-green: rgba(0, 230, 118, 0.8);
      --text-main: #e2e8f0;
      --text-muted: #94a3b8;
    }

    * {
      scrollbar-width: thin;
      scrollbar-color: rgba(148, 163, 184, 0.28) transparent;
    }

    *::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }

    *::-webkit-scrollbar-track {
      background: transparent;
    }

    *::-webkit-scrollbar-thumb {
      border: 2px solid transparent;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.26);
      background-clip: content-box;
    }

    *::-webkit-scrollbar-thumb:hover {
      background: rgba(148, 163, 184, 0.42);
      background-clip: content-box;
    }

    body {
      margin: 0;
      padding: 12px 12px 78px;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC', Roboto, Helvetica, Arial, sans-serif;
      background: var(--vscode-sidebar-background, var(--bg-dark));
      color: var(--text-main);
      overflow-x: hidden;
    }

    .header-container {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
    }

    h2 {
      font-family: 'Outfit', sans-serif;
      font-size: 15px;
      font-weight: 800;
      margin: 0;
      background: linear-gradient(135deg, #00e5ff 0%, #7c4dff 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -0.5px;
    }

    .header-actions {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .btn-gear {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-muted);
      padding: 4px;
      display: flex;
      align-items: center;
      transition: color 0.2s;
    }

    .codicon {
      font-size: 15px;
      line-height: 1;
    }

    .brand-title {
      display: inline-flex;
      align-items: center;
      gap: 7px;
    }

    .brand-wordmark {
      width: 120px;
      height: auto;
      flex-shrink: 0;
    }

    .btn-gear:hover {
      color: #00e5ff;
    }

    /* Settings Panel Overlay */
    .settings-overlay,
    .feedback-overlay {
      position: absolute;
      top: 45px;
      left: 10px;
      right: 10px;
      background: rgba(15, 17, 26, 0.95);
      backdrop-filter: blur(14px);
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      padding: 12px;
      z-index: 50;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
      display: none;
      max-height: calc(100vh - 70px);
      overflow-y: auto;
      animation: slide-down 0.2s ease-out;
    }

    .feedback-type-row {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
      margin-bottom: 8px;
    }

    .feedback-type-btn {
      border: 1px solid var(--border-glass);
      background: rgba(255, 255, 255, 0.04);
      color: var(--text-muted);
      border-radius: 6px;
      padding: 7px 5px;
      font-size: 10px;
      cursor: pointer;
    }

    .feedback-type-btn.active {
      color: #00e5ff;
      border-color: rgba(0, 229, 255, 0.55);
      background: rgba(0, 229, 255, 0.08);
    }

    @keyframes slide-down {
      from { transform: translateY(-8px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .settings-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      border-bottom: 1px solid var(--border-glass);
      padding-bottom: 4px;
    }

    .settings-header h3 {
      font-family: 'Outfit', sans-serif;
      font-size: 12px;
      margin: 0;
      font-weight: 800;
      color: #00e5ff;
    }

    .btn-close-settings {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-muted);
      font-size: 16px;
      font-weight: bold;
      padding: 0 4px;
    }

    .btn-close-settings:hover {
      color: #ff1744;
    }

    .settings-field {
      margin-bottom: 8px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .settings-card {
      border: 1px solid rgba(255, 255, 255, 0.10);
      background: rgba(255, 255, 255, 0.035);
      border-radius: 7px;
      padding: 9px;
      margin-bottom: 9px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .settings-card-title {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 10.5px;
      font-weight: 800;
      color: var(--text-main);
    }

    .enhancement-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
    }

    .enhancement-card {
      border: 1px solid var(--border-glass);
      background: rgba(255, 255, 255, 0.04);
      border-radius: 7px;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 7px;
    }

    .enhancement-card-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }

    .enhancement-title {
      color: var(--text-main);
      font-size: 11px;
      font-weight: 800;
    }

    .enhancement-desc {
      color: var(--text-muted);
      font-size: 8.5px;
      line-height: 1.35;
      margin-top: 2px;
    }

    .enhancement-status {
      flex: 0 0 auto;
      border: 1px solid rgba(56, 189, 248, 0.28);
      background: rgba(56, 189, 248, 0.10);
      color: #d7f3ff;
      border-radius: 999px;
      padding: 2px 6px;
      font-size: 8.5px;
      font-weight: 800;
      white-space: nowrap;
    }

    .enhancement-status.failed,
    .enhancement-status.unavailable {
      border-color: rgba(255, 23, 68, 0.32);
      background: rgba(255, 23, 68, 0.10);
      color: #ffd7df;
    }

    .enhancement-meta {
      color: var(--text-muted);
      font-size: 8.5px;
    }

    .enhancement-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
    }

    .settings-lbl-title {
      font-size: 8.5px;
      text-transform: uppercase;
      font-weight: 700;
      color: var(--text-muted);
      letter-spacing: 0.2px;
    }

    .settings-input {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 4px;
      padding: 5px 6px;
      color: var(--text-main);
      font-family: inherit;
      font-size: 11px;
      outline: none;
    }

    .settings-input:focus {
      border-color: #00e5ff;
    }

    .settings-textarea {
      min-height: 66px;
      resize: vertical;
      line-height: 1.4;
    }

    .dependency-panel {
      border: 1px solid var(--border-glass);
      border-radius: 6px;
      padding: 8px;
      background: rgba(255, 255, 255, 0.035);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .dependency-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 0;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }

    .dependency-row:first-child {
      border-top: 0;
      padding-top: 0;
    }

    .dependency-main {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .dependency-name {
      font-size: 10.5px;
      font-weight: 700;
      color: var(--text-main);
    }

    .dependency-message {
      font-size: 9px;
      color: var(--text-muted);
      overflow-wrap: anywhere;
    }

    .dependency-status {
      flex-shrink: 0;
      border-radius: 999px;
      padding: 3px 7px;
      font-size: 9px;
      font-weight: 800;
      border: 1px solid var(--border-glass);
      color: var(--text-muted);
    }

    .dependency-status.ready {
      border-color: rgba(0, 230, 118, 0.25);
      color: #00e676;
      background: rgba(0, 230, 118, 0.08);
    }

    .dependency-status.needs-action {
      border-color: rgba(255, 183, 77, 0.28);
      color: #ffcc80;
      background: rgba(255, 183, 77, 0.08);
    }

    .dependency-actions {
      display: flex;
      gap: 6px;
    }

    .dependency-action-btn {
      border: 1px solid rgba(0, 229, 255, 0.24);
      border-radius: 5px;
      background: rgba(0, 229, 255, 0.08);
      color: #d8fbff;
      padding: 5px 7px;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
    }

    .impact-panel {
      border: 1px solid var(--border-glass);
      border-radius: 6px;
      padding: 8px;
      background: rgba(255, 255, 255, 0.035);
      display: flex;
      flex-direction: column;
      gap: 7px;
    }

    .impact-summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }

    .impact-metric {
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 5px;
      padding: 6px;
      background: rgba(0, 0, 0, 0.12);
      min-width: 0;
    }

    .impact-metric-value {
      font-size: 15px;
      font-weight: 800;
      color: var(--text-main);
      line-height: 1.1;
    }

    .impact-metric-label {
      margin-top: 2px;
      font-size: 8.5px;
      color: var(--text-muted);
    }

    .agent-impact-list {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .impact-agent-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: flex-start;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      padding-top: 6px;
    }

    .impact-agent-row:first-child {
      border-top: 0;
      padding-top: 0;
    }

    .impact-agent-main {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .impact-agent-name {
      font-size: 10.5px;
      font-weight: 800;
      color: var(--text-main);
    }

    .impact-agent-detail {
      font-size: 8.8px;
      color: var(--text-muted);
      overflow-wrap: anywhere;
    }

    .impact-status {
      flex-shrink: 0;
      border-radius: 999px;
      padding: 3px 7px;
      font-size: 8.8px;
      font-weight: 800;
      border: 1px solid var(--border-glass);
      color: var(--text-muted);
    }

    .impact-status.ready {
      border-color: rgba(0, 230, 118, 0.25);
      color: #00e676;
      background: rgba(0, 230, 118, 0.08);
    }

    .impact-status.unknown {
      border-color: rgba(255, 183, 77, 0.28);
      color: #ffcc80;
      background: rgba(255, 183, 77, 0.08);
    }

    .impact-status.missing {
      border-color: rgba(255, 82, 82, 0.24);
      color: #ff8a80;
      background: rgba(255, 82, 82, 0.08);
    }

    .project-switcher {
      display: flex;
      gap: 6px;
      margin-bottom: 12px;
    }

    .project-select {
      flex: 1;
      min-width: 0;
    }

    .solo-select {
      position: relative;
      min-width: 0;
      font-size: 11px;
    }

    .solo-select-trigger {
      width: 100%;
      min-height: 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 5px;
      padding: 5px 7px;
      color: var(--text-main);
      font: inherit;
      cursor: pointer;
      text-align: left;
    }

    .solo-select-trigger-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .solo-select-caret {
      flex-shrink: 0;
      color: var(--text-muted);
      transition: transform 0.18s ease;
    }

    .solo-select.open .solo-select-caret {
      transform: rotate(180deg);
    }

    .solo-select.open .solo-select-trigger,
    .solo-select-trigger:focus {
      border-color: rgba(0, 229, 255, 0.7);
      box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.18);
      outline: none;
    }

    .solo-select-menu {
      display: none;
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      z-index: 80;
      padding: 4px;
      border: 1px solid rgba(0, 229, 255, 0.22);
      border-radius: 7px;
      background: #151a29;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.42);
      max-height: 190px;
      overflow-y: auto;
    }

    .solo-select.open .solo-select-menu {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .solo-select-group-header {
      padding: 6px 7px;
      font-size: 10px;
      font-weight: 700;
      color: var(--text-muted);
      background: rgba(255, 255, 255, 0.03);
      border-bottom: 1px solid var(--border-glass);
      margin: 4px 0 2px;
      pointer-events: none;
    }

    .solo-select-option {
      border: none;
      border-radius: 5px;
      padding: 6px 7px;
      background: transparent;
      color: var(--text-main);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }

    .solo-select-option:hover,
    .solo-select-option[aria-selected="true"] {
      background: rgba(0, 229, 255, 0.12);
      color: #d8fbff;
    }

    .solo-select.is-disabled {
      opacity: 0.52;
    }

    .solo-select.is-disabled .solo-select-trigger {
      cursor: not-allowed;
    }

    .btn-project-add {
      width: 28px;
      border: 1px solid var(--border-glass);
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-main);
      cursor: pointer;
      font-weight: 800;
    }

    .portfolio-panel {
      position: relative;
      z-index: 1;
      background: var(--bg-glass);
      backdrop-filter: blur(8px);
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      padding: 10px;
      margin-bottom: 14px;
    }

    .global-focus-panel {
      position: relative;
      z-index: 1;
      border: 1px solid rgba(0, 229, 255, 0.18);
      border-radius: 8px;
      padding: 10px;
      margin-bottom: 10px;
      background: linear-gradient(145deg, rgba(0, 229, 255, 0.08), rgba(124, 77, 255, 0.07));
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.16);
    }

    .global-focus-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }

    .global-focus-title {
      font-size: 11px;
      font-weight: 800;
      color: #d8fbff;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }

    .global-focus-path {
      font-size: 8.5px;
      color: var(--text-muted);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .global-review-btn {
      flex-shrink: 0;
      border: 1px solid rgba(0, 229, 255, 0.22);
      border-radius: 6px;
      background: rgba(0, 229, 255, 0.08);
      color: #d8fbff;
      padding: 4px 7px;
      font-size: 9px;
      font-weight: 800;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .global-review-btn:hover {
      border-color: rgba(0, 229, 255, 0.42);
      background: rgba(0, 229, 255, 0.14);
    }

    .global-review-btn[disabled] {
      cursor: wait;
      opacity: 0.72;
    }

    .global-focus-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .global-focus-item {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.13);
      padding: 7px;
      cursor: pointer;
    }

    .global-focus-item:hover {
      border-color: rgba(0, 229, 255, 0.28);
    }

    .global-focus-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }

    .global-focus-main {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .global-focus-name {
      font-size: 11px;
      font-weight: 800;
      color: var(--text-main);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .global-focus-action {
      font-size: 9.5px;
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .global-focus-slot {
      flex-shrink: 0;
      min-width: 46px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.045);
      color: #d8fbff;
      padding: 3px 7px;
      font-size: 9px;
      font-weight: 800;
      text-align: center;
    }

    .global-priority {
      flex-shrink: 0;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.1);
      padding: 3px 7px;
      font-size: 9px;
      font-weight: 900;
    }

    .global-priority.P0 {
      color: #ff8a9c;
      background: rgba(255, 23, 68, 0.12);
      border-color: rgba(255, 23, 68, 0.25);
    }

    .global-priority.P1 {
      color: #ffddad;
      background: rgba(255, 183, 77, 0.11);
      border-color: rgba(255, 183, 77, 0.24);
    }

    .global-priority.P2,
    .global-priority.P3 {
      color: #7dd3fc;
      background: rgba(56, 189, 248, 0.1);
      border-color: rgba(56, 189, 248, 0.22);
    }

    .global-focus-foot {
      margin-top: 7px;
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }

    .daily-review-panel {
      margin-top: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .daily-review-summary {
      font-size: 9.5px;
      line-height: 1.45;
      color: var(--text-muted);
    }

    .daily-review-list {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .daily-review-item {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.035);
      padding: 6px;
      cursor: pointer;
    }

    .daily-review-item:hover {
      border-color: rgba(0, 229, 255, 0.25);
    }

    .daily-review-title {
      font-size: 10px;
      font-weight: 800;
      color: var(--text-main);
      overflow-wrap: anywhere;
    }

    .daily-review-reason {
      margin-top: 2px;
      font-size: 9px;
      line-height: 1.35;
      color: var(--text-muted);
      overflow-wrap: anywhere;
    }

    .global-chip {
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.045);
      color: var(--text-muted);
      padding: 3px 7px;
      font-size: 9px;
      font-weight: 700;
    }

    .portfolio-compose-tool {
      min-height: 44px;
      width: 36px;
      flex-shrink: 0;
      border: 1px solid var(--border-glass);
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .portfolio-compose-tool:hover {
      border-color: rgba(124, 77, 255, 0.48);
      color: #d9ccff;
    }

    .sidebar-solo-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin: 8px 0 2px;
    }

    .sidebar-solo-file {
      max-width: 100%;
      display: inline-flex;
      gap: 5px;
      align-items: center;
      border: 1px solid rgba(124, 77, 255, 0.28);
      border-radius: 999px;
      background: rgba(124, 77, 255, 0.1);
      color: #dfd5ff;
      padding: 3px 7px;
      font-size: 10px;
    }

    .sidebar-solo-file-name {
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sidebar-solo-file-remove {
      border: 0;
      background: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 0;
    }

    .portfolio-compose-input {
      flex: 1;
      min-height: 44px;
      max-height: 96px;
      resize: vertical;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border-glass);
      border-radius: 5px;
      padding: 7px;
      color: var(--text-main);
      font-family: inherit;
      font-size: 11px;
      line-height: 1.35;
      outline: none;
    }

    .portfolio-compose-input:focus {
      border-color: rgba(124, 77, 255, 0.65);
    }

    .portfolio-compose-send {
      border: none;
      border-radius: 5px;
      min-height: 44px;
      padding: 0 10px;
      background: linear-gradient(135deg, #7c4dff 0%, #00b0ff 100%);
      color: #fff;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      align-self: stretch;
    }

    .portfolio-mode-toggle {
      display: flex;
      gap: 4px;
      margin-bottom: 7px;
    }

    .portfolio-mode-btn {
      flex: 1;
      border: 1px solid var(--border-glass);
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.04);
      color: var(--text-muted);
      padding: 5px 7px;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
    }

    .portfolio-mode-btn.active {
      background: rgba(0, 229, 255, 0.14);
      border-color: rgba(0, 229, 255, 0.35);
      color: #d8fbff;
    }

    .portfolio-mode-btn[data-project-conversation-mode="solo"].active {
      background: rgba(124, 77, 255, 0.2);
      border-color: rgba(124, 77, 255, 0.55);
      color: #dfd5ff;
    }

    .portfolio-mode-btn[data-project-conversation-mode="flow"].active {
      background: rgba(245, 158, 11, 0.2);
      border-color: rgba(245, 158, 11, 0.52);
      color: #fff2c2;
    }

    .sidebar-solo-history {
      margin-top: 10px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 8px;
    }

    .sidebar-solo-history-title {
      font-size: 10px;
      font-weight: 700;
      color: var(--text-muted);
      margin-bottom: 6px;
    }

    .sidebar-solo-empty {
      font-size: 10px;
      color: var(--text-muted);
    }

    .sidebar-conversation-latest-container {
      margin-top: 8px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-width: 100%;
    }

    .sidebar-conversation-node-wrap {
      display: flex;
      flex-direction: column;
      position: relative;
    }

    .sidebar-conversation-card {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      padding: 8px 10px;
      border: 1px solid var(--border-glass, rgba(255, 255, 255, 0.08));
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.02);
      cursor: pointer;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
      user-select: none;
      gap: 8px;
      min-width: 0;
    }

    .sidebar-conversation-card:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(255, 255, 255, 0.18);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      transform: translateY(-1px);
    }

    .sidebar-conversation-card.expanded {
      background: rgba(255, 255, 255, 0.04);
      border-color: rgba(255, 255, 255, 0.15);
      border-bottom-left-radius: 0;
      border-bottom-right-radius: 0;
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
    }

    /* 树圆点指示器 */
    .sidebar-conversation-bullet-col {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .tree-bullet {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
      border: 1.5px solid transparent;
      box-sizing: border-box;
    }

    .status-dot-completed {
      background: #10b981; /* 翡翠绿 */
      box-shadow: 0 0 6px rgba(16, 185, 129, 0.4);
    }

    .status-dot-failed {
      background: #f43f5e; /* 玫瑰红 */
      box-shadow: 0 0 6px rgba(244, 63, 94, 0.4);
    }

    .status-dot-running {
      background: #3b82f6; /* 皇家蓝 */
    }

    /* 运行中呼吸灯 */
    .status-dot-running-glow {
      animation: status-pulse 2s infinite ease-in-out;
    }

    @keyframes status-pulse {
      0% {
        transform: scale(0.9);
        box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7);
      }
      50% {
        transform: scale(1.15);
        box-shadow: 0 0 8px 3px rgba(59, 130, 246, 0.3);
      }
      100% {
        transform: scale(0.9);
        box-shadow: 0 0 0 0 rgba(59, 130, 246, 0);
      }
    }

    /* 卡片主体 */
    .sidebar-conversation-body {
      flex: 1 1 130px;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .sidebar-conversation-header-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 9px;
      color: var(--text-muted, #94a3b8);
      min-width: 0;
      flex-wrap: wrap;
    }

    .sidebar-conversation-agent-tag {
      max-width: 100%;
      font-weight: 700;
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.1);
      padding: 1px 4px;
      border-radius: 4px;
      text-transform: uppercase;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sidebar-conversation-time-meta {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sidebar-conversation-duration-meta {
      display: flex;
      align-items: center;
      gap: 2px;
      color: var(--text-muted);
    }

    .sidebar-conversation-duration-meta .codicon {
      font-size: 9px;
    }

    .sidebar-conversation-summary-row {
      font-size: 10px;
      font-weight: 500;
      color: var(--text-main, #f8fafc);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* 右侧列 */
    .sidebar-conversation-right-col {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 0 1 auto;
      min-width: 0;
      margin-left: auto;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    /* 新状态徽章 */
    .status-badge-new {
      flex-shrink: 0;
      font-size: 9px;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    .status-badge-new.completed {
      background: rgba(16, 185, 129, 0.12);
      color: #34d399;
    }

    .status-badge-new.failed {
      background: rgba(244, 63, 94, 0.12);
      color: #fb7185;
    }

    .status-badge-new.running {
      background: rgba(59, 130, 246, 0.12);
      color: #60a5fa;
    }

    /* 迷你快速动作按钮 */
    .sidebar-conversation-mini-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .sidebar-conversation-mini-actions > span {
      display: inline-grid;
      place-items: center;
      width: 18px;
      height: 18px;
      line-height: 1;
      padding: 0;
      border-radius: 4px;
      cursor: pointer;
      color: var(--text-muted);
      transition: all 0.2s ease;
      background: rgba(255, 255, 255, 0.05);
    }

    .sidebar-conversation-mini-actions > span:hover {
      color: #ffffff;
      transform: scale(1.08);
    }

    .sidebar-conversation-mini-actions .mini-btn-continue:hover {
      background: rgba(16, 185, 129, 0.25);
      color: #34d399;
    }

    .sidebar-conversation-mini-actions .mini-btn-rollback:hover {
      background: rgba(245, 158, 11, 0.25);
      color: #fbbf24;
    }

    .sidebar-conversation-mini-actions .mini-btn-stop:hover {
      background: rgba(239, 68, 68, 0.25);
      color: #f87171;
    }

    .sidebar-conversation-mini-actions > span .codicon {
      width: 1em;
      height: 1em;
      font-size: 11px;
      display: inline-grid;
      place-items: center;
      line-height: 1;
      background: transparent;
      color: inherit;
      cursor: inherit;
    }

    .expand-arrow-icon {
      flex-shrink: 0;
      font-size: 11px;
      color: var(--text-muted);
      transition: transform 0.2s ease;
    }

    @media (max-width: 330px) {
      .sidebar-conversation-card {
        align-items: flex-start;
        gap: 7px;
      }

      .sidebar-conversation-body {
        flex-basis: calc(100% - 24px);
      }

      .sidebar-conversation-right-col {
        width: 100%;
        margin-left: 16px;
      }
    }

    /* 详情展开面板 */
    .sidebar-conversation-detail-panel {
      border: 1px solid var(--border-glass, rgba(255, 255, 255, 0.08));
      border-top: none;
      border-bottom-left-radius: 8px;
      border-bottom-right-radius: 8px;
      background: rgba(255, 255, 255, 0.015);
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-width: 100%;
      box-sizing: border-box;
    }

    .detail-item-outcome {
      font-size: 10px;
      padding: 6px 8px;
      border-radius: 6px;
      line-height: 1.4;
    }

    .detail-item-outcome.completed {
      background: rgba(16, 185, 129, 0.06);
      border-left: 3px solid #10b981;
      color: #a7f3d0;
    }

    .detail-item-outcome.failed {
      background: rgba(244, 63, 94, 0.06);
      border-left: 3px solid #f43f5e;
      color: #fecdd3;
    }

    .detail-item-outcome.running {
      background: rgba(59, 130, 246, 0.06);
      border-left: 3px solid #3b82f6;
      color: #bfdbfe;
    }

    .detail-item-outcome strong {
      color: #ffffff;
      margin-right: 4px;
    }

    /* 代理结论引用块 */
    .detail-item-conclusion {
      display: flex;
      gap: 6px;
      background: rgba(255, 255, 255, 0.02);
      border-left: 2px solid rgba(255, 255, 255, 0.15);
      padding: 6px 8px;
      border-radius: 4px;
    }

    .detail-item-conclusion .codicon-quote {
      font-size: 10px;
      color: #38bdf8;
      margin-top: 2px;
      flex-shrink: 0;
    }

    .conclusion-content {
      font-size: 10px;
      line-height: 1.4;
      color: var(--text-muted);
    }

    .conclusion-content strong {
      color: #ffffff;
    }

    .conclusion-content p {
      margin: 2px 0 0 0;
    }

    /* 详情中的大按钮 */
    .sidebar-conversation-large-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 4px;
    }

    .sidebar-conv-action-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      padding: 4px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 500;
      transition: all 0.2s ease;
      border: 1px solid transparent;
    }

    .sidebar-conv-action-btn.continue {
      background: rgba(16, 185, 129, 0.15);
      border-color: rgba(16, 185, 129, 0.4);
      color: #34d399;
    }

    .sidebar-conv-action-btn.continue:hover {
      background: rgba(16, 185, 129, 0.25);
      border-color: rgba(16, 185, 129, 0.6);
      box-shadow: 0 2px 8px rgba(16, 185, 129, 0.2);
    }

    .sidebar-conv-action-btn.rollback {
      background: rgba(245, 158, 11, 0.15);
      border-color: rgba(245, 158, 11, 0.4);
      color: #fbbf24;
    }

    .sidebar-conv-action-btn.rollback:hover {
      background: rgba(245, 158, 11, 0.25);
      border-color: rgba(245, 158, 11, 0.6);
      box-shadow: 0 2px 8px rgba(245, 158, 11, 0.2);
    }

    .sidebar-conv-action-btn.stop {
      background: rgba(239, 68, 68, 0.15);
      border-color: rgba(239, 68, 68, 0.4);
      color: #f87171;
    }

    .sidebar-conv-action-btn.stop:hover {
      background: rgba(239, 68, 68, 0.25);
      border-color: rgba(239, 68, 68, 0.6);
      box-shadow: 0 2px 8px rgba(239, 68, 68, 0.2);
    }

    /* 日志控制行 */
    .sidebar-conversation-logs-toggle-row {
      margin-top: 4px;
      display: flex;
    }

    .logs-toggle-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 9px;
      color: var(--text-muted);
      background: transparent;
      border: none;
      cursor: pointer;
      padding: 2px 0;
      transition: color 0.2s ease;
    }

    .logs-toggle-btn:hover {
      color: #ffffff;
    }

    .logs-toggle-btn .codicon {
      font-size: 11px;
    }

    /* 日志展示区域 */
    .sidebar-conversation-logs-container {
      margin-top: 6px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-width: 100%;
      box-sizing: border-box;
    }

    .log-block-title {
      font-size: 8px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 2px;
    }

    .log-pre {
      margin: 0 0 6px 0;
      padding: 6px;
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid rgba(255, 255, 255, 0.05);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      color: rgba(255, 255, 255, 0.75);
      font-size: 8.5px;
      font-family: var(--vscode-editor-font-family, monospace);
      box-sizing: border-box;
      max-width: 100%;
      max-height: 180px;
      overflow: auto;
    }

    /* 简单的渐入渐出动画 */
    .animate-fade-in {
      animation: fadeIn 0.22s cubic-bezier(0.4, 0, 0.2, 1) forwards;
    }

    .animate-slide-down {
      animation: slideDown 0.22s cubic-bezier(0.4, 0, 0.2, 1) forwards;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-2px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes slideDown {
      from { height: 0; opacity: 0; overflow: hidden; }
      to { height: auto; opacity: 1; }
    }

    /* Regression compatibility styles */
    .sidebar-conversation-footer {
      justify-content: flex-end;
    }
    .sidebar-conversation-detail {
      overflow-wrap: anywhere;
    }
    .sidebar-conversation-detail pre {
      max-width: 100%;
    }

    .portfolio-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }

    .portfolio-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-main);
    }

    .portfolio-filters {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 10px;
    }

    .portfolio-filter-btn {
      border: 1px solid var(--border-glass);
      border-radius: 999px;
      background: rgba(255,255,255,0.04);
      color: var(--text-muted);
      padding: 3px 8px;
      font-size: 10px;
      cursor: pointer;
    }

    .portfolio-filter-btn.active {
      background: rgba(0, 229, 255, 0.14);
      color: #d8fbff;
      border-color: rgba(0, 229, 255, 0.25);
    }

    .portfolio-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-bottom: 8px;
    }

    .empty-portfolio {
      color: var(--text-muted);
      font-size: 11px;
      text-align: center;
      padding: 10px 4px;
    }

    .onboarding-panel {
      border: 1px solid rgba(0, 229, 255, 0.18);
      border-radius: 8px;
      background: linear-gradient(135deg, rgba(0, 229, 255, 0.08), rgba(124, 77, 255, 0.08));
      padding: 12px;
      box-sizing: border-box;
    }

    .onboarding-kicker {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: #7dd3fc;
      font-size: 10px;
      font-weight: 800;
      margin-bottom: 7px;
    }

    .onboarding-title {
      color: var(--text-main);
      font-size: 14px;
      font-weight: 800;
      line-height: 1.25;
      margin-bottom: 6px;
    }

    .onboarding-copy {
      color: var(--text-muted);
      font-size: 11px;
      line-height: 1.45;
      margin-bottom: 10px;
    }

    .onboarding-steps {
      display: flex;
      flex-direction: column;
      gap: 7px;
      margin-bottom: 11px;
    }

    .onboarding-step {
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr);
      gap: 7px;
      align-items: start;
      color: var(--text-main);
      font-size: 10.5px;
      line-height: 1.35;
    }

    .onboarding-step-index {
      width: 18px;
      height: 18px;
      border-radius: 999px;
      background: rgba(0, 229, 255, 0.12);
      border: 1px solid rgba(0, 229, 255, 0.24);
      color: #a5f3fc;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 800;
    }

    .onboarding-action {
      width: 100%;
      border: none;
      border-radius: 6px;
      padding: 8px 10px;
      background: linear-gradient(135deg, #7c4dff 0%, #00b0ff 100%);
      color: #fff;
      font-size: 11px;
      font-weight: 800;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }

    .portfolio-card {
      border: 1px solid var(--border-glass);
      border-radius: 6px;
      padding: 9px;
      background: rgba(255,255,255,0.03);
      cursor: pointer;
    }

    .portfolio-card.is-selected {
      border-color: rgba(0, 229, 255, 0.28);
      background: rgba(0, 229, 255, 0.07);
    }

    .portfolio-card-head,
    .portfolio-card-meta,
    .portfolio-card-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .portfolio-card-controls {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .portfolio-refresh-btn {
      width: 22px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 5px;
      background: rgba(255,255,255,0.045);
      color: var(--text-muted);
      cursor: pointer;
      padding: 0;
    }

    .portfolio-refresh-btn:hover {
      color: var(--text-main);
      border-color: rgba(0, 229, 255, 0.3);
    }

    .portfolio-refresh-btn.is-pinned {
      color: #ffd166;
      border-color: rgba(255, 209, 102, 0.32);
      background: rgba(255, 209, 102, 0.08);
    }

    .portfolio-refresh-btn.is-refreshing .codicon {
      animation: solomap-spin 0.9s linear infinite;
    }

    @keyframes solomap-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .portfolio-card-meta {
      margin-top: 6px;
      font-size: 10px;
      color: var(--text-muted);
      flex-wrap: wrap;
    }

    .portfolio-project-name {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-main);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .portfolio-stage,
    .portfolio-updated,
    .portfolio-recommendation {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .portfolio-status {
      font-size: 10px;
      font-weight: 700;
    }

    .portfolio-global-row {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 7px;
    }

    .portfolio-progress {
      margin-top: 8px;
    }

    .portfolio-progress-track {
      height: 5px;
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
      overflow: hidden;
    }

    .portfolio-progress-fill {
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, #00e5ff, #7c4dff);
    }

    .portfolio-card-actions {
      margin-top: 8px;
    }

    .portfolio-action-btn {
      flex: 1;
      border: 1px solid var(--border-glass);
      border-radius: 5px;
      background: rgba(255,255,255,0.05);
      color: var(--text-main);
      font-size: 10px;
      font-weight: 700;
      padding: 5px 8px;
      cursor: pointer;
    }

    .portfolio-action-btn.primary {
      background: linear-gradient(135deg, #00e5ff 0%, #00b0ff 100%);
      color: #000;
      border-color: transparent;
    }

    .portfolio-compose {
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 7px;
      margin-top: 0;
      cursor: default;
    }

    .portfolio-compose-row {
      display: flex;
      gap: 6px;
      align-items: stretch;
    }

    .portfolio-compose-input {
      flex: 1;
      min-width: 0;
      min-height: 44px;
      max-height: 96px;
      resize: vertical;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border-glass);
      border-radius: 5px;
      padding: 7px;
      color: var(--text-main);
      font-family: inherit;
      font-size: 11px;
      line-height: 1.35;
      outline: none;
    }

    .portfolio-compose-agent {
      min-width: 0;
    }

    .portfolio-compose-agent-row {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      margin-bottom: 7px;
    }

    .portfolio-compose-model {
      min-width: 0;
    }

    .portfolio-compose-send {
      border: none;
      border-radius: 5px;
      min-height: 44px;
      background: linear-gradient(135deg, #7c4dff 0%, #00b0ff 100%);
      color: #fff;
      font-size: 11px;
      font-weight: 800;
      padding: 0 10px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
    }

    .portfolio-compose-send:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }

    .project-synced-tag {
      font-size: 8px;
      padding: 1px 4px;
      border-radius: 2.5px;
      background: rgba(102, 187, 106, 0.07);
      color: #a5d6a7;
      border: 1px solid rgba(102, 187, 106, 0.14);
      margin-left: 5px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 2px;
      vertical-align: middle;
      cursor: help;
      opacity: 0.82;
    }

    .project-synced-tag .codicon {
      font-size: 8px !important;
    }

    .feedback-rating-card {
      margin-top: 10px;
      padding: 10px;
      border: 1px solid rgba(255, 215, 0, 0.16);
      border-radius: 6px;
      background: linear-gradient(135deg, rgba(255, 215, 0, 0.03) 0%, rgba(255, 215, 0, 0.06) 100%);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .rating-card-title {
      font-size: 10.5px;
      font-weight: 800;
      color: #ffd54f;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .rating-star-icon {
      font-size: 11px;
      color: #ffd54f;
    }

    .rating-card-desc {
      font-size: 9px;
      color: var(--text-muted);
      line-height: 1.35;
    }

    .settings-action-btn.rating-btn {
      background: linear-gradient(135deg, #ffd54f 0%, #ffb300 100%);
      color: #000000;
      margin-top: 2px;
      font-weight: 800;
      font-size: 10px;
    }

    .settings-action-btn.rating-btn:hover {
      box-shadow: 0 0 8px rgba(255, 213, 79, 0.35);
    }

    .portfolio-issue-panel {
      margin-top: 9px;
      padding: 9px;
      border: 1px solid rgba(255, 183, 77, 0.2);
      border-radius: 6px;
      background: rgba(255, 183, 77, 0.055);
      cursor: default;
    }

    .portfolio-delivery-panel {
      margin-top: 10px;
      padding: 10px 12px;
      border: 1px solid rgba(0, 176, 255, 0.18);
      border-radius: 8px;
      background: linear-gradient(135deg, rgba(0, 176, 255, 0.04) 0%, rgba(0, 176, 255, 0.08) 100%);
      backdrop-filter: blur(10px);
      transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
      cursor: default;
      position: relative;
      overflow: hidden;
    }

    .portfolio-delivery-panel.is-failed {
      border-color: rgba(239, 83, 80, 0.25);
      background: linear-gradient(135deg, rgba(239, 83, 80, 0.05) 0%, rgba(239, 83, 80, 0.09) 100%);
    }

    .portfolio-delivery-panel.is-healthy {
      border-color: rgba(102, 187, 106, 0.25);
      background: linear-gradient(135deg, rgba(102, 187, 106, 0.05) 0%, rgba(102, 187, 106, 0.09) 100%);
    }

    .portfolio-delivery-panel:hover {
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      transform: translateY(-1px);
    }

    .delivery-collapsed-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      width: 100%;
    }

    .delivery-header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }

    .delivery-title-wrapper {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 700;
      color: var(--vscode-foreground, #cccccc);
    }

    .delivery-rocket-icon {
      font-size: 14px;
      color: #64b5f6;
    }

    .is-failed .delivery-rocket-icon {
      color: #ef5350;
    }

    .is-healthy .delivery-rocket-icon {
      color: #66bb6a;
    }

    .delivery-panel-title {
      font-size: 11px;
      letter-spacing: 0.5px;
      font-weight: 800;
    }

    .delivery-status-badge {
      font-size: 9.5px;
      padding: 2.5px 8px;
      border-radius: 999px;
      font-weight: 700;
      white-space: nowrap;
      max-width: 160px;
      overflow: hidden;
      margin-left: auto;
      text-overflow: ellipsis;
      border: 1px solid transparent;
    }

    .delivery-status-badge.status-failed {
      background: rgba(239, 83, 80, 0.15);
      color: #ff8a80;
      border-color: rgba(239, 83, 80, 0.25);
    }

    .delivery-status-badge.status-healthy {
      background: rgba(102, 187, 106, 0.15);
      color: #b9f6ca;
      border-color: rgba(102, 187, 106, 0.25);
    }

    .delivery-toggle-btn {
      background: transparent;
      border: none;
      color: var(--text-muted, #888888);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 4px;
      transition: all 0.2s ease;
      padding: 0;
    }

    .delivery-toggle-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-main, #ffffff);
      transform: scale(1.05);
    }

    .delivery-toggle-btn:active {
      transform: scale(0.95);
    }

    .delivery-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 10px;
    }

    .delivery-card {
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 6px;
      padding: 8px 10px;
      background: rgba(0, 0, 0, 0.15);
      display: flex;
      flex-direction: column;
      gap: 4px;
      transition: border-color 0.2s ease;
    }

    .delivery-card:hover {
      border-color: rgba(255, 255, 255, 0.12);
    }

    .delivery-card-title {
      font-size: 8.5px;
      color: var(--text-muted, #888888);
      text-transform: uppercase;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .delivery-card-title .codicon {
      font-size: 10px;
    }

    .delivery-card-value {
      font-size: 11px;
      font-weight: 800;
      color: var(--text-main, #ffffff);
    }

    .failed-count-highlight {
      color: #ff8a80;
    }

    .healthy-highlight {
      color: #b9f6ca;
    }

    .release-version-highlight {
      color: #80d8ff;
    }

    .no-release-highlight {
      color: var(--text-muted, #888888);
    }

    .delivery-meta-info {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 8.5px;
      color: var(--text-muted, #888888);
      margin-bottom: 10px;
      padding: 0 2px;
    }

    .delivery-repo-text {
      max-width: 60%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }

    .delivery-repo-text .codicon {
      font-size: 9.5px;
    }

    .delivery-runs-section {
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      padding-top: 8px;
      margin-bottom: 10px;
    }

    .delivery-section-title {
      font-size: 9px;
      font-weight: 700;
      color: var(--text-muted, #888888);
      margin-bottom: 6px;
    }

    .delivery-toast-message {
      font-size: 9.5px;
      background: rgba(0, 176, 255, 0.1);
      border: 1px solid rgba(0, 176, 255, 0.2);
      border-radius: 4px;
      color: #80d8ff;
      padding: 6px 8px;
      margin-bottom: 10px;
      animation: fadeIn 0.3s ease;
    }

    .delivery-footer-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 8px;
    }

    .delivery-action-btn {
      flex: 1;
      min-width: fit-content;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      font-size: 9.5px;
      font-weight: 700;
      padding: 5px 8px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: inherit;
    }

    .delivery-action-btn .codicon {
      font-size: 11px;
    }

    .delivery-action-btn.secondary-btn {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: var(--text-main, #ffffff);
    }

    .delivery-action-btn.secondary-btn:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .delivery-action-btn.secondary-btn:active:not(:disabled) {
      transform: scale(0.97);
    }

    .delivery-action-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .delivery-action-btn.primary-btn {
      background: linear-gradient(135deg, #e53935 0%, #d32f2f 100%);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #ffffff;
      font-weight: 800;
      box-shadow: 0 2px 6px rgba(229, 57, 53, 0.2);
    }

    .delivery-action-btn.primary-btn:hover {
      background: linear-gradient(135deg, #ef5350 0%, #e53935 100%);
      box-shadow: 0 4px 10px rgba(229, 57, 53, 0.4);
      transform: translateY(-0.5px);
    }

    .delivery-action-btn.primary-btn:active {
      transform: translateY(0.5px) scale(0.97);
    }

    .pulse-glow {
      animation: pulseGlow 2s infinite;
    }

    @keyframes pulseGlow {
      0% {
        box-shadow: 0 0 0 0 rgba(229, 57, 53, 0.4);
      }
      70% {
        box-shadow: 0 0 0 4px rgba(229, 57, 53, 0);
      }
      100% {
        box-shadow: 0 0 0 0 rgba(229, 57, 53, 0);
      }
    }

    @keyframes spin {
      100% {
        transform: rotate(360deg);
      }
    }

    .loading-spin {
      animation: spin 1s linear infinite;
    }

    .portfolio-issue-head,
    .portfolio-issue-metrics,
    .portfolio-issue-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .portfolio-issue-actions {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .portfolio-issue-create {
      border: 1px solid rgba(255, 183, 77, 0.32);
      border-radius: 5px;
      background: rgba(255, 183, 77, 0.1);
      color: #ffddad;
      padding: 4px 7px;
      font-size: 10px;
      font-weight: 800;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .portfolio-issue-title {
      font-size: 10.5px;
      font-weight: 800;
      color: #ffcc80;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }

    .portfolio-issue-repo {
      font-size: 9px;
      color: var(--text-muted);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .portfolio-issue-metrics {
      justify-content: flex-start;
      flex-wrap: wrap;
      margin-top: 7px;
    }

    .portfolio-issue-pill {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.045);
      color: var(--text-main);
      padding: 3px 7px;
      font-size: 9.5px;
      font-weight: 700;
      white-space: nowrap;
    }

    .portfolio-issue-tag-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 5px;
      margin-top: 8px;
    }

    .portfolio-issue-tag {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 5px;
      padding: 6px;
      background: rgba(0, 0, 0, 0.12);
      color: var(--text-main);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-size: 10px;
      font-weight: 700;
    }

    .portfolio-issue-list {
      display: flex;
      flex-direction: column;
      gap: 5px;
      margin-top: 8px;
    }

    .portfolio-delivery-list {
      display: flex;
      flex-direction: column;
      gap: 5px;
      margin-top: 8px;
    }

    .portfolio-issue-row {
      width: 100%;
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 5px;
      background: rgba(0, 0, 0, 0.14);
      color: var(--text-main);
      padding: 6px;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }

    .portfolio-issue-row:hover {
      border-color: rgba(255, 183, 77, 0.32);
    }

    .portfolio-delivery-row {
      width: 100%;
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 5px;
      background: rgba(0, 0, 0, 0.14);
      color: var(--text-main);
      padding: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .portfolio-delivery-summary {
      flex: 1;
      min-width: 0;
      font-size: 10px;
      color: var(--text-main);
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .portfolio-issue-main {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .portfolio-issue-name {
      font-size: 10px;
      font-weight: 700;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .portfolio-issue-sub {
      font-size: 9px;
      color: var(--text-muted);
    }

    .portfolio-issue-empty {
      margin-top: 7px;
      font-size: 10px;
      color: var(--text-muted);
    }

    .portfolio-issue-form,
    .portfolio-issue-detail {
      margin-top: 8px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.12);
      padding: 8px;
    }

    .portfolio-quick-issue-input {
      border: 1px solid var(--border-glass);
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.055);
      color: var(--text-main);
      font: inherit;
      font-size: 10px;
      padding: 4px 6px;
      width: 120px;
      outline: none;
      transition: border-color 0.2s, background 0.2s;
    }
    .portfolio-quick-issue-input:focus {
      border-color: rgba(255, 183, 77, 0.5);
      background: rgba(255, 255, 255, 0.08);
    }

    .portfolio-issue-input,
    .portfolio-issue-textarea {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--border-glass);
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.055);
      color: var(--text-main);
      font: inherit;
      font-size: 10.5px;
      padding: 6px;
      outline: none;
    }

    .portfolio-issue-textarea {
      min-height: 58px;
      margin-top: 6px;
      resize: vertical;
    }

    .portfolio-issue-form-row,
    .portfolio-issue-detail-actions {
      display: flex;
      gap: 6px;
      margin-top: 6px;
    }

    .portfolio-issue-form-row .solo-select {
      flex: 1;
    }

    .portfolio-issue-action {
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-main);
      padding: 5px 7px;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
    }

    .portfolio-issue-action.primary {
      background: rgba(255, 183, 77, 0.16);
      border-color: rgba(255, 183, 77, 0.35);
      color: #ffddad;
    }

    .portfolio-issue-action.danger {
      background: rgba(255, 23, 68, 0.1);
      border-color: rgba(255, 23, 68, 0.26);
      color: #ff8a9c;
    }

    .portfolio-issue-comment {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.07);
      font-size: 10px;
      color: var(--text-muted);
      line-height: 1.4;
      overflow-wrap: anywhere;
    }

    .portfolio-issue-comment strong {
      color: var(--text-main);
    }

    .portfolio-action-zone {
      margin-top: 4px;
      padding-top: 0;
    }

    .settings-actions {
      display: flex;
      gap: 6px;
      margin-top: 10px;
    }

    .settings-action-btn {
      flex: 1;
      padding: 6px;
      font-size: 10.5px;
      font-weight: 700;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      transition: all 0.2s;
    }

    .settings-action-btn.test-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border-glass);
      color: var(--text-main);
    }

    .settings-action-btn.test-btn:hover {
      background: rgba(255, 255, 255, 0.12);
    }

    .settings-action-btn.save-btn {
      background: linear-gradient(135deg, #00e5ff 0%, #00b0ff 100%);
      color: #000;
    }

    .settings-action-btn.save-btn:hover {
      box-shadow: 0 0 8px rgba(0, 229, 255, 0.3);
    }

    .cli-badge {
      margin-top: 8px;
      font-size: 9.5px;
      padding: 4px 6px;
      border-radius: 4px;
      font-weight: 600;
      text-align: center;
      line-height: 1.2;
    }

    .cli-badge.success {
      background: rgba(0, 230, 118, 0.1);
      color: #00e676;
      border: 1px solid rgba(0, 230, 118, 0.15);
    }

    .cli-badge.error {
      background: rgba(255, 23, 68, 0.1);
      color: #ff1744;
      border: 1px solid rgba(255, 23, 68, 0.15);
    }

    /* Progress Widget */
    .progress-widget {
      background: var(--bg-glass);
      backdrop-filter: blur(8px);
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      padding: 10px;
      margin-bottom: 14px;
    }

    .progress-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      color: var(--text-muted);
      font-weight: 600;
    }

    .progress-bar-bg {
      background: rgba(255, 255, 255, 0.08);
      height: 6px;
      border-radius: 3px;
      overflow: hidden;
      margin-top: 6px;
    }

    .progress-bar-fill {
      background: linear-gradient(90deg, #00e5ff, #7c4dff);
      height: 100%;
      width: 0%;
      border-radius: 3px;
      transition: width 0.6s cubic-bezier(0.16, 1, 0.3, 1);
    }

    /* AI Input Box */
    .ai-generator {
      margin-bottom: 16px;
    }

    .ai-input-group {
      display: flex;
      gap: 6px;
    }

    .ai-input {
      flex: 1;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 4px;
      padding: 6px 8px;
      color: var(--text-main);
      font-family: inherit;
      font-size: 11px;
      outline: none;
      transition: all 0.3s ease;
    }

    .ai-input:focus {
      border-color: #00e5ff;
      box-shadow: 0 0 8px rgba(0, 229, 255, 0.2);
    }

    .ai-btn {
      background: linear-gradient(135deg, #00e5ff 0%, #00b0ff 100%);
      color: #000;
      font-weight: 600;
      border: none;
      border-radius: 4px;
      padding: 6px 10px;
      cursor: pointer;
      font-family: inherit;
      font-size: 11px;
      transition: all 0.2s ease;
    }

    .ai-btn:hover {
      box-shadow: 0 0 10px rgba(0, 229, 255, 0.4);
      transform: translateY(-0.5px);
    }

    /* Compact Node List */
    .node-list-container {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 60px;
    }

    .node-card {
      background: var(--bg-glass);
      border: 1px solid var(--border-glass);
      border-radius: 6px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: all 0.3s ease;
      cursor: pointer;
    }

    .node-card:hover {
      border-color: rgba(255, 255, 255, 0.15);
      background: rgba(22, 28, 45, 0.7);
    }

    /* Status Indicators */
    .node-card.status-Pending { border-left: 3px solid #64748b; }
    .node-card.status-Running { border-left: 3px solid #00e5ff; animation: pulse-border 1.5s infinite; }
    .node-card.status-In-Progress { border-left: 3px solid #facc15; }
    .node-card.status-Completed { border-left: 3px solid #00e676; }
    .node-card.status-Failed { border-left: 3px solid #ff1744; }

    @keyframes pulse-border {
      0% { box-shadow: 0 0 0 0 rgba(0, 229, 255, 0.25); }
      70% { box-shadow: 0 0 0 6px rgba(0, 229, 255, 0); }
      100% { box-shadow: 0 0 0 0 rgba(0, 229, 255, 0); }
    }

    .node-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .node-title {
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      text-overflow: ellipsis;
      overflow: hidden;
    }

    .node-badge {
      font-size: 9px;
      font-weight: 700;
      padding: 2px 5px;
      border-radius: 3px;
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--border-glass);
    }

    .stage-Business-Planning { color: #818cf8; }
    .stage-Brand---Setup { color: #f472b6; }
    .stage-Product---MVP { color: #38bdf8; }
    .stage-Marketing---Growth { color: #34d399; }

    .node-action-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 2px;
    }

    .status-lbl {
      font-size: 10px;
      font-weight: 600;
    }

    .status-lbl.Pending { color: #94a3b8; }
    .status-lbl.Running { color: #00e5ff; }
    .status-lbl.In-Progress { color: #facc15; }
    .status-lbl.Completed { color: #00e676; }
    .status-lbl.Failed { color: #ff1744; }

    .btn-run-small {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      color: var(--text-main);
      padding: 3px 6px;
      font-size: 10px;
      font-weight: 600;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 3px;
      transition: all 0.2s ease;
    }

    .btn-run-small:hover {
      background: #00e5ff;
      color: #000;
      border-color: #00e5ff;
    }

    .node-card.status-Running .btn-run-small {
      pointer-events: none;
      opacity: 0.4;
    }

    /* Fixed Premium Footer Button */
    .sidebar-footer {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 10px 12px;
      background: linear-gradient(to top, rgba(15,17,26,0.95), rgba(15,17,26,0.8));
      backdrop-filter: blur(8px);
      border-top: 1px solid var(--border-glass);
      z-index: 100;
    }

    .btn-large {
      background: linear-gradient(135deg, #7c4dff 0%, #00b0ff 100%);
      color: #fff;
      font-weight: 700;
      border: none;
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 11px;
      cursor: pointer;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      box-shadow: 0 4px 12px rgba(124, 77, 255, 0.35);
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .btn-large:hover {
      box-shadow: 0 6px 16px rgba(0, 229, 255, 0.5);
      transform: translateY(-0.5px);
    }
  </style>
</head>
<body>
  <div class="header-container">
    <h2 class="brand-title"><img class="brand-wordmark" src="${wordmarkUri}" width="120" height="31" alt="SoloMap"></h2>
    <div class="header-actions">
      <button class="btn-gear" id="btn-toggle-feedback" title="Feedback"><span class="codicon codicon-comment-discussion"></span></button>
      <button class="btn-gear" id="btn-toggle-settings" title="SoloMap Settings"><span class="codicon codicon-settings-gear"></span></button>
    </div>
  </div>

  <div class="project-switcher">
    <div class="solo-select project-select" id="project-select" data-solo-select data-value="">
      <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
        <span class="solo-select-trigger-label" data-solo-label></span>
        <span class="codicon codicon-chevron-down solo-select-caret"></span>
      </button>
      <div class="solo-select-menu" data-solo-menu role="listbox"></div>
    </div>
    <button class="btn-project-add" id="btn-add-project" title="Add project folder"><span class="codicon codicon-add"></span></button>
  </div>

  <div class="global-focus-panel" id="global-focus-panel"></div>

  <div class="feedback-overlay" id="feedback-panel">
    <div class="settings-header">
      <h3><span class="codicon codicon-comment-discussion"></span> <span id="feedback-title">Feedback</span></h3>
      <button class="btn-close-settings" id="btn-close-feedback"><span class="codicon codicon-close"></span></button>
    </div>
    <div class="feedback-type-row">
      <button class="feedback-type-btn active" type="button" data-feedback-type="not_working" id="feedback-type-not-working">没跑通</button>
      <button class="feedback-type-btn" type="button" data-feedback-type="next_step" id="feedback-type-next-step">不懂下一步</button>
      <button class="feedback-type-btn" type="button" data-feedback-type="feature_request" id="feedback-type-feature">想要能力</button>
    </div>
    <div class="settings-field">
      <input
        type="text"
        class="settings-input"
        id="setting-feedback-title"
        placeholder="What should be improved?"
      >
      <textarea class="settings-input settings-textarea" id="setting-feedback-body" placeholder="Add what happened and what you expected." style="min-height: 78px; margin-top: 5px;"></textarea>
      <button class="settings-action-btn test-btn" id="btn-open-feedback" style="margin-top: 6px; width: 100%;"><span class="codicon codicon-github"></span><span id="text-open-feedback">Send Feedback</span></button>
    </div>
    
    <div class="feedback-rating-card">
      <div class="rating-card-title">
        <span class="codicon codicon-star-full rating-star-icon"></span>
        <span id="text-rating-title">觉得 SoloMap 挺好用？</span>
      </div>
      <div class="rating-card-desc" id="text-rating-desc">给个五星好评，支持我们持续更新！</div>
      <button class="settings-action-btn rating-btn" id="btn-rate-extension" type="button">
        <span class="codicon codicon-heart-filled"></span>
        <span id="text-rate-btn">去评五星好评</span>
      </button>
    </div>
  </div>

  <div class="portfolio-panel">
    <div class="portfolio-header">
      <div class="portfolio-title" id="portfolio-title">项目总览</div>
    </div>
    <div class="portfolio-filters" id="portfolio-filters"></div>
    <div class="portfolio-list" id="portfolio-list"></div>
  </div>

  <!-- Settings Panel Overlay -->
  <div class="settings-overlay" id="settings-panel">
    <div class="settings-header">
      <h3><span class="codicon codicon-settings-gear"></span> <span id="settings-title">SoloMap Settings</span></h3>
      <button class="btn-close-settings" id="btn-close-settings"><span class="codicon codicon-close"></span></button>
    </div>

    <div class="settings-card">
      <div class="settings-card-title"><span class="codicon codicon-globe"></span><span id="settings-section-basic">Basics</span></div>
    <div class="settings-field">
      <label class="settings-lbl-title" id="label-language">Language</label>
      <div class="solo-select settings-select" id="setting-language" data-solo-select data-value="zh">
        <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
          <span class="solo-select-trigger-label" data-solo-label>中文</span>
          <span class="codicon codicon-chevron-down solo-select-caret"></span>
        </button>
        <div class="solo-select-menu" data-solo-menu role="listbox">
          <button type="button" class="solo-select-option" data-solo-option-value="zh" aria-selected="true">中文</button>
          <button type="button" class="solo-select-option" data-solo-option-value="en" aria-selected="false">English</button>
        </div>
      </div>
    </div>
    </div>

    <div class="settings-card">
      <div class="settings-card-title"><span class="codicon codicon-account"></span><span id="settings-section-account">SoloMap Pro</span></div>
      <div class="settings-field">
        <div class="dependency-panel" id="pro-account-panel"></div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px;">
          <button class="settings-action-btn save-btn" id="btn-open-pro-authorization"><span class="codicon codicon-lock"></span><span id="text-open-pro-authorization">登录 / 升级 Pro</span></button>
          <button class="settings-action-btn test-btn" id="btn-paste-pro-code"><span class="codicon codicon-key"></span><span id="text-paste-pro-code">粘贴授权码</span></button>
        </div>
      </div>
    </div>

    <div class="settings-card">
      <div class="settings-card-title"><span class="codicon codicon-robot"></span><span id="settings-section-agent">Agent Collaboration</span></div>
    <div class="settings-field">
      <label class="settings-lbl-title" id="label-cli-path">CLI Command or Path</label>
      <div class="settings-cli-select-wrap">
        <div class="solo-select settings-select" id="setting-cli-select" data-solo-select data-value="agy">
          <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
            <span class="solo-select-trigger-label" data-solo-label>agy</span>
            <span class="codicon codicon-chevron-down solo-select-caret"></span>
          </button>
          <div class="solo-select-menu" data-solo-menu role="listbox">
            <button type="button" class="solo-select-option" data-solo-option-value="agy" aria-selected="true">agy</button>
            <button type="button" class="solo-select-option" data-solo-option-value="codex" aria-selected="false">codex</button>
            <button type="button" class="solo-select-option" data-solo-option-value="cursor" aria-selected="false">cursor</button>
            <button type="button" class="solo-select-option" data-solo-option-value="copilot" aria-selected="false">copilot</button>
            <button type="button" class="solo-select-option" data-solo-option-value="claude" aria-selected="false">claude</button>
            <button type="button" class="solo-select-option" data-solo-option-value="opencode" aria-selected="false">opencode</button>
            <button type="button" class="solo-select-option" data-solo-option-value="custom" aria-selected="false">Custom...</button>
          </div>
        </div>
        <input
          type="text"
          class="settings-input"
          id="setting-clipath-custom"
          placeholder="e.g. /usr/local/bin/cursor-cli or my-copilot"
          style="display:none; margin-top: 6px;"
        >
      </div>
      <div id="help-cli-path" style="font-size: 8.5px; color: var(--text-muted); margin-top: 2px;">
        Name of globally installed CLI (e.g. <code>agy</code>, <code>codex</code>, <code>cursor</code>, <code>claude</code>, <code>copilot</code>, <code>opencode</code>) or the absolute path to its executable.
      </div>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-agent-model">Default Model</label>
      <div class="solo-select settings-select" id="setting-agent-model-select" data-solo-select data-value="auto">
        <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
          <span class="solo-select-trigger-label" data-solo-label>Auto</span>
          <span class="codicon codicon-chevron-down solo-select-caret"></span>
        </button>
        <div class="solo-select-menu" data-solo-menu role="listbox">
          <button type="button" class="solo-select-option" data-solo-option-value="auto" aria-selected="true">Auto</button>
        </div>
      </div>
      <div id="help-agent-model" style="font-size: 8.5px; color: var(--text-muted); margin-top: 2px;">
        Uses the selected Agent family default unless you pin a specific model.
      </div>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-reviewer-cli-path">Review Agent</label>
      <div class="settings-cli-select-wrap">
        <div class="solo-select settings-select" id="setting-reviewer-cli-select" data-solo-select data-value="">
          <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
            <span class="solo-select-trigger-label" data-solo-label>Same as main Agent</span>
            <span class="codicon codicon-chevron-down solo-select-caret"></span>
          </button>
          <div class="solo-select-menu" data-solo-menu role="listbox">
            <button type="button" class="solo-select-option" data-solo-option-value="" aria-selected="true" id="option-reviewer-same">Same as main Agent</button>
            <button type="button" class="solo-select-option" data-solo-option-value="agy" aria-selected="false">agy</button>
            <button type="button" class="solo-select-option" data-solo-option-value="codex" aria-selected="false">codex</button>
            <button type="button" class="solo-select-option" data-solo-option-value="cursor" aria-selected="false">cursor</button>
            <button type="button" class="solo-select-option" data-solo-option-value="copilot" aria-selected="false">copilot</button>
            <button type="button" class="solo-select-option" data-solo-option-value="claude" aria-selected="false">claude</button>
            <button type="button" class="solo-select-option" data-solo-option-value="opencode" aria-selected="false">opencode</button>
            <button type="button" class="solo-select-option" data-solo-option-value="custom" aria-selected="false">Custom...</button>
          </div>
        </div>
        <input
          type="text"
          class="settings-input"
          id="setting-reviewer-clipath-custom"
          placeholder="e.g. /usr/local/bin/codex"
          style="display:none; margin-top: 6px;"
        >
      </div>
      <div id="help-reviewer-cli-path" style="font-size: 8.5px; color: var(--text-muted); margin-top: 2px;">
        Optional secondary CLI for read-only review after task runs.
      </div>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-collaboration-review-mode">Auto Review</label>
      <div class="solo-select settings-select" id="setting-collaboration-review-mode" data-solo-select data-value="high_risk">
        <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
          <span class="solo-select-trigger-label" data-solo-label>High-risk tasks</span>
          <span class="codicon codicon-chevron-down solo-select-caret"></span>
        </button>
        <div class="solo-select-menu" data-solo-menu role="listbox">
          <button type="button" class="solo-select-option" data-solo-option-value="high_risk" aria-selected="true" id="option-review-high-risk">High-risk tasks</button>
          <button type="button" class="solo-select-option" data-solo-option-value="all" aria-selected="false" id="option-review-all">Every task</button>
          <button type="button" class="solo-select-option" data-solo-option-value="off" aria-selected="false" id="option-review-off">Off</button>
        </div>
      </div>
      <div id="help-collaboration-review-mode" style="font-size: 8.5px; color: var(--text-muted); margin-top: 2px;">
        Review runs are read-only and appear as a separate conversation in the same step.
      </div>
    </div>
    </div>

    <div class="settings-card">
      <div class="settings-card-title"><span class="codicon codicon-database"></span><span id="settings-section-data">Project Data</span></div>
    <div class="settings-field">
      <label class="settings-lbl-title" id="label-global-data-path">Global Data Directory</label>
      <input
        type="text"
        class="settings-input"
        id="setting-global-data-path"
        placeholder="e.g. /home/ubuntu/project/.solomap-global"
      >
      <div id="help-global-data-path" style="font-size: 8.5px; color: var(--text-muted); margin-top: 2px;">
        Directory used to store cross-project SoloMap data such as portfolio, dependencies, learning candidates, and metrics.
      </div>
    </div>

    <div class="settings-field">
      <label class="settings-lbl-title" id="label-agent-impact">Agent Impact</label>
      <div class="impact-panel" id="agent-impact-panel">
        <div class="impact-summary">
          <div class="impact-metric">
            <div class="impact-metric-value" id="impact-minutes">0</div>
            <div class="impact-metric-label" id="impact-minutes-label">Minutes</div>
          </div>
          <div class="impact-metric">
            <div class="impact-metric-value" id="impact-files">0</div>
            <div class="impact-metric-label" id="impact-files-label">Files changed</div>
          </div>
          <div class="impact-metric">
            <div class="impact-metric-value" id="impact-progress">0</div>
            <div class="impact-metric-label" id="impact-progress-label">Project progress</div>
          </div>
        </div>
        <div class="agent-impact-list" id="agent-impact-list"></div>
        <button class="dependency-action-btn" id="btn-refresh-agent-impact" style="width: 100%;"><span class="codicon codicon-refresh"></span><span id="text-refresh-agent-impact">Refresh Impact</span></button>
      </div>
    </div>
    </div>

    <div class="settings-card">
      <div class="settings-card-title"><span class="codicon codicon-edit"></span><span id="settings-section-instructions">Instructions</span></div>
    <div class="settings-field">
      <label class="settings-lbl-title" id="label-global-prompt">Default Agent Instructions</label>
      <textarea class="settings-input settings-textarea" id="setting-global-prompt" placeholder="e.g. Keep changes minimal and run the narrowest relevant test."></textarea>
      <div id="help-global-prompt" style="font-size: 8.5px; color: var(--text-muted); margin-top: 2px;">
        Injected into every task conversation. Current conversation guidance takes priority.
      </div>
    </div>
    </div>

    <div class="settings-card">
      <div class="settings-card-title"><span class="codicon codicon-extensions"></span><span id="settings-section-abilities">Abilities</span></div>
      <div class="settings-field">
        <label class="settings-lbl-title" id="label-enhancement-toggles">能力扩展与执行增强</label>
        <div id="help-enhancement-toggles" style="font-size: 8.5px; color: var(--text-muted); margin-top: 2px;">
          在这里管理您的已安装技能 (Skills)、连接器 (MCP Connectors) 与内置的执行增强 (Enhancements)。
        </div>
        
        <div id="settings-ability-url-input-container" style="display: none; margin-bottom: 6px; margin-top: 6px;">
          <input
            type="text"
            class="settings-input"
            id="setting-ability-url-input"
            placeholder=""
          >
          <div id="help-ability-url-input" style="font-size: 8px; color: var(--text-muted); margin-top: 2px;"></div>
        </div>

        <div class="solo-select settings-select" id="setting-ability-select" data-solo-select data-value="" style="margin-top: 6px;">
          <button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false">
            <span class="solo-select-trigger-label" data-solo-label>请选择能力或增强...</span>
            <span class="codicon codicon-chevron-down solo-select-caret"></span>
          </button>
          <div class="solo-select-menu" data-solo-menu role="listbox" style="max-height: 250px; overflow-y: auto;">
          </div>
        </div>

        <div class="enhancement-card" id="ability-detail-card" style="margin-top: 8px; display: none;">
          <div class="enhancement-card-head">
            <div>
              <div class="enhancement-title" id="ability-detail-title"></div>
              <div class="enhancement-desc" id="ability-detail-desc" style="white-space: pre-wrap; font-size: 11px;"></div>
            </div>
            <span class="enhancement-status" id="ability-detail-status"></span>
          </div>
          <div class="enhancement-meta" id="ability-detail-meta"></div>
        </div>

        <div class="enhancement-actions" style="margin-top: 8px;">
          <button class="settings-action-btn test-btn" id="btn-install-ability" disabled><span class="codicon codicon-cloud-download"></span><span id="text-install-ability">安装</span></button>
          <button class="settings-action-btn test-btn" id="btn-uninstall-ability" disabled><span class="codicon codicon-trash"></span><span id="text-uninstall-ability">卸载</span></button>
        </div>
        
        <div class="cli-badge" id="ability-action-badge" style="display:none; margin-top: 6px;"></div>
      </div>
    </div>

    <div class="settings-card">
      <div class="settings-card-title"><span class="codicon codicon-checklist"></span><span id="settings-section-readiness">Readiness</span></div>
    <div class="settings-field">
      <label class="settings-lbl-title" id="label-dependencies">Local readiness</label>
      <div class="dependency-panel" id="dependency-panel">
        <div class="dependency-row">
          <div class="dependency-main">
            <span class="dependency-name" id="dependency-agent-name">Agent CLI</span>
            <span class="dependency-message" id="dependency-agent-message">Not checked yet.</span>
          </div>
          <span class="dependency-status" id="dependency-agent-status">Check</span>
        </div>
        <div class="dependency-row">
          <div class="dependency-main">
            <span class="dependency-name" id="dependency-automation-name">Task automation</span>
            <span class="dependency-message" id="dependency-automation-message">Not checked yet.</span>
          </div>
          <span class="dependency-status" id="dependency-automation-status">Check</span>
        </div>
        <div class="dependency-row">
          <div class="dependency-main">
            <span class="dependency-name" id="dependency-github-name">GitHub</span>
            <span class="dependency-message" id="dependency-github-message">Not checked yet.</span>
          </div>
          <span class="dependency-status" id="dependency-github-status">Check</span>
        </div>
        <div class="dependency-actions">
          <button class="dependency-action-btn" id="btn-check-dependencies"><span class="codicon codicon-search"></span><span id="text-check-dependencies">Check</span></button>
          <button class="dependency-action-btn" id="btn-open-agent-install"><span class="codicon codicon-cloud-download"></span><span id="text-open-agent-install">Install</span></button>
          <button class="dependency-action-btn" id="btn-prepare-agent-automation"><span class="codicon codicon-shield"></span><span id="text-prepare-agent-automation">Prepare</span></button>
          <button class="dependency-action-btn" id="btn-open-agent-check"><span class="codicon codicon-terminal"></span><span id="text-open-agent-check">Agent</span></button>
          <button class="dependency-action-btn" id="btn-open-github-auth"><span class="codicon codicon-github"></span><span id="text-open-github-auth">GitHub</span></button>
        </div>
      </div>
    </div>
    </div>

    <div class="settings-actions">
      <button class="settings-action-btn test-btn" id="btn-test-cli"><span class="codicon codicon-debug-start"></span><span id="text-test-cli">Test CLI</span></button>
      <button class="settings-action-btn save-btn" id="btn-save-settings"><span class="codicon codicon-save"></span><span id="text-save-settings">Save</span></button>
    </div>
    <div class="cli-badge" id="cli-test-badge" style="display:none;"></div>
  </div>

  <!-- Footer CTA -->
  <div class="sidebar-footer">
    <button class="btn-large" id="btn-open-strategy-pyramid">
      <span class="codicon codicon-type-hierarchy-sub"></span><span id="text-open-strategy-pyramid">Open Strategy Pyramid</span>
    </button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const tasksList = document.getElementById('tasks-list');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const btnOpenStrategyPyramid = document.getElementById('btn-open-strategy-pyramid');
    const projectSelect = document.getElementById('project-select');
    const btnAddProject = document.getElementById('btn-add-project');
    const globalFocusPanel = document.getElementById('global-focus-panel');
    const portfolioList = document.getElementById('portfolio-list');
    const portfolioFilters = document.getElementById('portfolio-filters');

    // Settings elements
    const btnToggleFeedback = document.getElementById('btn-toggle-feedback');
    const btnCloseFeedback = document.getElementById('btn-close-feedback');
    const feedbackPanel = document.getElementById('feedback-panel');
    const btnToggleSettings = document.getElementById('btn-toggle-settings');
    const btnCloseSettings = document.getElementById('btn-close-settings');
    const settingsPanel = document.getElementById('settings-panel');
    const settingCliSelect = document.getElementById('setting-cli-select');
    const settingAgentModelSelect = document.getElementById('setting-agent-model-select');
    const settingCliPathCustom = document.getElementById('setting-clipath-custom');
    const settingLanguage = document.getElementById('setting-language');
    const settingGlobalPrompt = document.getElementById('setting-global-prompt');
    const settingGlobalDataPath = document.getElementById('setting-global-data-path');
    const settingReviewerCliSelect = document.getElementById('setting-reviewer-cli-select');
    const settingReviewerCliPathCustom = document.getElementById('setting-reviewer-clipath-custom');
    const settingCollaborationReviewMode = document.getElementById('setting-collaboration-review-mode');
    const proAccountPanel = document.getElementById('pro-account-panel');
    const btnOpenProAuthorization = document.getElementById('btn-open-pro-authorization');
    const btnPasteProCode = document.getElementById('btn-paste-pro-code');
    const settingAbilitySelect = document.getElementById('setting-ability-select');
    const settingsAbilityUrlInputContainer = document.getElementById('settings-ability-url-input-container');
    const settingAbilityUrlInput = document.getElementById('setting-ability-url-input');
    const helpAbilityUrlInput = document.getElementById('help-ability-url-input');
    const abilityDetailCard = document.getElementById('ability-detail-card');
    const abilityDetailTitle = document.getElementById('ability-detail-title');
    const abilityDetailDesc = document.getElementById('ability-detail-desc');
    const abilityDetailStatus = document.getElementById('ability-detail-status');
    const abilityDetailMeta = document.getElementById('ability-detail-meta');
    const btnInstallAbility = document.getElementById('btn-install-ability');
    const btnUninstallAbility = document.getElementById('btn-uninstall-ability');
    const abilityActionBadge = document.getElementById('ability-action-badge');
    const settingFeedbackTitle = document.getElementById('setting-feedback-title');
    const settingFeedbackBody = document.getElementById('setting-feedback-body');
    const btnOpenFeedback = document.getElementById('btn-open-feedback');
    const btnTestCli = document.getElementById('btn-test-cli');
    const btnSaveSettings = document.getElementById('btn-save-settings');
    const cliTestBadge = document.getElementById('cli-test-badge');
    const btnRefreshAgentImpact = document.getElementById('btn-refresh-agent-impact');
    const agentImpactList = document.getElementById('agent-impact-list');
    const btnCheckDependencies = document.getElementById('btn-check-dependencies');
    const btnOpenAgentInstall = document.getElementById('btn-open-agent-install');
    const btnPrepareAgentAutomation = document.getElementById('btn-prepare-agent-automation');
    const btnOpenAgentCheck = document.getElementById('btn-open-agent-check');
    const btnOpenGithubAuth = document.getElementById('btn-open-github-auth');
    let currentLanguage = 'zh';
    let currentNodes = [];
    let activeProjectPath = '';
    let activePortfolioFilter = 'all';
    let sidebarSoloConversations = [];
    const sidebarExpandedConversations = {};
    const sidebarLogsExpandedConversations = {};
    const sidebarStepConversations = {};
    const sidebarProjectConversations = {};
    const sidebarStepConversationRequested = {};
    const sidebarProjectConversationRequested = {};
    const sidebarSoloConversationRequestedAt = {};
    const sidebarProjectConversationRequestedAt = {};
    const sidebarConversationRefreshTtlMs = 30000;
    let expandedIssueNumber = 0;
    let issueDetails = null;
    let issuePanelExpanded = false;
    let deliveryActionPanelExpanded = false;
    let issueFormOpen = false;
    let issueDraftTitle = '';
    let quickIssueDraftTitle = '';
    let issueDraftBody = '';
    let issueDraftCategory = 'bug';
    let issueDraftPriority = '';
    let issueActionMessage = '';
    let deliveryActionMessage = '';
    let currentDailyReview = null;
    let dailyReviewPollTimer = null;
    let currentFeedbackType = 'not_working';
    let currentCliPath = 'agy';
    let currentSettings = {};
    let selectedEnhancementId = '';
    const projectConversationModes = {};
    const agentModelCatalogs = {};
    const agentModelPreferenceMap = {};
    const projectConversationModelSelections = {};
    const projectConversationAgentSelections = {};
    let agentModelRequestSeq = 0;
    const projectContinueFiles = {};
    const projectContinueDrafts = {};
    const projectSoloFiles = {};
    const projectSoloDrafts = {};
    const projectRefreshPaths = new Set();
    const currentProjects = { projects: [], selectedProjectPath: '', portfolio: [], globalStore: null };

    function rememberProjectConversationInput(input) {
      if (!input) return;
      const mode = input.getAttribute('data-conversation-mode') || 'continue';
      const projectPath = input.getAttribute('data-project-path') || currentProjects.selectedProjectPath || '';
      const targetId = input.getAttribute('data-conversation-target-id') || '';
      if (projectPath && (mode === 'solo' || mode === 'flow')) {
        projectConversationModes[projectPath] = mode;
      }
      if (mode === 'solo') {
        projectSoloDrafts[projectPath] = input.value || '';
      } else if (mode === 'flow') {
        projectContinueDrafts['flow:' + projectPath] = input.value || '';
      } else if (targetId) {
        projectContinueDrafts[targetId] = input.value || '';
      }
    }

    function captureProjectConversationInputState() {
      const input = portfolioList && portfolioList.querySelector ? portfolioList.querySelector('[data-project-conversation-input]') : null;
      if (!input) return null;
      rememberProjectConversationInput(input);
      return {
        projectPath: input.getAttribute('data-project-path') || currentProjects.selectedProjectPath || '',
        mode: input.getAttribute('data-conversation-mode') || 'continue',
        targetId: input.getAttribute('data-conversation-target-id') || '',
        value: input.value || '',
        wasFocused: document.activeElement === input,
        selectionStart: typeof input.selectionStart === 'number' ? input.selectionStart : null,
        selectionEnd: typeof input.selectionEnd === 'number' ? input.selectionEnd : null,
        scrollTop: typeof input.scrollTop === 'number' ? input.scrollTop : 0
      };
    }

    function restoreProjectConversationInputState(state) {
      if (!state || !portfolioList || !portfolioList.querySelectorAll) return;
      const input = Array.from(portfolioList.querySelectorAll('[data-project-conversation-input]')).find(candidate => (
        (candidate.getAttribute('data-project-path') || '') === state.projectPath
        && (candidate.getAttribute('data-conversation-mode') || 'continue') === state.mode
        && (candidate.getAttribute('data-conversation-target-id') || '') === state.targetId
      ));
      if (!input) return;
      if (input.value !== state.value) {
        input.value = state.value;
        rememberProjectConversationInput(input);
      }
      if (typeof input.scrollTop === 'number') {
        input.scrollTop = state.scrollTop || 0;
      }
      if (state.wasFocused && typeof input.focus === 'function') {
        input.focus();
        if (typeof input.setSelectionRange === 'function' && state.selectionStart !== null && state.selectionEnd !== null) {
          input.setSelectionRange(state.selectionStart, state.selectionEnd);
        }
      }
    }

    const i18n = {
      zh: {
        title: 'SoloMap',
        portfolioTitle: '项目总览',
        openStrategyPyramid: '打开战略金字塔视图',
        globalFocusTitle: '今日安排',
        globalFocusEmpty: '今天还没有明确安排，先添加或选择一个项目。',
        todaySlotUrgent: '先处理',
        todaySlotMain: '主推进',
        todaySlotClose: '收尾',
        todayReasonDelivery: '发布检查需要处理',
        todayReasonFailed: '失败环节需要收口',
        todayReasonIssue: '高优先级反馈需要处理',
        todayReasonRunning: 'Agent 正在执行，先看状态',
        todayReasonInProgress: '已经开始，今天最容易形成进展',
        todayReasonPending: '可以开始推进',
        todayReasonReview: '成果已完成，适合复盘或调整下一轮',
        todayReasonWeeklyFocus: '周一先确认本周主线',
        todayReasonFridayLearning: '周五适合收尾沉淀',
        todayReasonMonthReview: '月末适合回顾优先级和复用效果',
        todayReasonNewProject: '新项目先确认起点',
        todayReasonReusable: '已有可复用经验，推进成本更低',
        todayRhythmDaily: '每日自查',
        todayRhythmMonday: '周一确认主线',
        todayRhythmFriday: '周五收尾复盘',
        todayRhythmMonthEnd: '月末回顾',
        dailyReviewButton: 'Agent 审视',
        dailyReviewRunning: 'Agent 正在捋今天的安排...',
        dailyReviewFailed: '审视失败，请打开运行日志查看原因。',
        dailyReviewEmpty: '还没有 Agent 审视结果。',
        dailyReviewConfirm: '需要确认',
        onboardingKicker: '新手开始',
        onboardingTitle: '先把一个项目交给 SoloMap',
        onboardingCopy: '选择一个本地项目文件夹。SoloMap 会带你确认项目类型，然后生成第一张可推进路线图。',
        onboardingStepProject: '添加本地项目文件夹',
        onboardingStepType: '选择这个项目更像哪一类',
        onboardingStepRoadmap: '在“生成初始路线图”里输入目标，让 Agent 产出第一版路线图',
        onboardingAction: '添加第一个项目',
        globalDataPath: '跨项目数据目录',
        globalDataPathPlaceholder: '例如：/home/ubuntu/project/.solomap-global',
        globalDataPathHelp: '保存跨项目组合、依赖、学习候选和指标；可填 .solomap-global 目录路径，或填其父目录。',
        reviewerCliPath: '复核 Agent',
        reviewerCliPathPlaceholder: '留空则使用主 Agent',
        reviewerCliPathHelp: '可选的副 Agent CLI，只读复核任务结果，不直接改文件。',
        collaborationReviewMode: '自动复核',
        collaborationReviewHelp: '复核会作为同一环节的一条独立对话记录。',
        reviewerSame: '跟随主 Agent',
        settingsSectionBasic: '基础',
        settingsSectionAccount: '账户与 Pro',
        settingsSectionAgent: 'Agent 协作',
        settingsSectionData: '项目数据',
        settingsSectionInstructions: '默认指令',
        settingsSectionAbilities: '能力扩展',
        settingsSectionReadiness: '本地状态',
        proFeatureName: '战略金字塔',
        proUnlocked: '已解锁',
        proLocked: '未解锁',
        proAccountAnonymous: '未登录',
        proValidUntil: '有效期至',
        proExpirationHelp: '注：此为本地授权缓存过期时间。每次联网或执行任务时，系统都会静默刷新授权，为您顺延有效期（如购买的是年会员请放心使用）。',
        proLogin: '登录 / 升级 Pro',
        proPasteCode: '粘贴授权码',
        proAccountHelp: '登录后即可打开 Pro 功能；本地项目数据仍留在你的工作区。',
        reviewHighRisk: '高风险任务',
        reviewAll: '每次任务',
        reviewOff: '关闭',
        skillInstall: '安装技能',
        skillInstallPlaceholder: '例如：https://skills.sh/owner/repo 或 owner/repo@skill',
        skillInstallHelp: '粘贴 skills.sh 或 GitHub 技能链接，SoloMap 会安装到全局技能库。',
        installSkill: '安装技能',
        installingSkill: '正在启动安装...',
        mcpInstall: '安装连接器',
        mcpInstallPlaceholder: '例如：GitHub MCP server、npm 包名或配置片段',
        mcpInstallHelp: '粘贴 MCP 来源，SoloMap 会注册到全局能力连接器库。',
        installMcp: '安装连接器',
        installingMcp: '正在启动安装...',
        enhancementToggles: '执行增强',
        enhancementTogglesHelp: '选择一个执行增强后安装或卸载。SoloMap 会让 Agent CLI 完成用户环境里的真实安装和彻底卸载；状态会自动检测。',
        abilityManagerLabel: '能力扩展与执行增强',
        abilityManagerHelp: '在这里管理您的已安装技能 (Skills)、连接器 (MCP Connectors) 与内置的执行增强 (Enhancements)。',
        abilitySelectPlaceholder: '请选择能力或增强...',
        abilityGroupSkills: '技能 (Skills)',
        abilityGroupConnectors: '连接器 (MCP Connectors)',
        abilityGroupEnhancements: '执行增强 (Enhancements)',
        addSkill: '➕ 新增技能...',
        addSkillDescription: '安装外部技能以扩展能力',
        addConnector: '➕ 新增连接器...',
        addConnectorDescription: '集成外部 MCP 服务生态',
        installedStatus: '已安装',
        readyStatus: '已就绪',
        notInstalledStatus: '未安装',
        skillMetaPrefix: '技能路径：',
        connectorMetaPrefix: '连接器类型：',
        enhancementMetaPrefix: '内置增强 · 版本：',
        skillInstallInputHelp: '粘贴 skills.sh 或 GitHub 技能仓库链接。SoloMap 会将其安装到全局技能库中。',
        mcpInstallInputHelp: '粘贴 MCP 连接器源。SoloMap 将其注册为全局连接器。',
        skillInputRequired: '请先输入要安装的技能链接。',
        mcpInputRequired: '请先输入要安装的连接器源。',
        installingSkillMessage: '正在安装技能...',
        installingMcpMessage: '正在安装连接器...',
        installingEnhancementMessage: '正在安装执行增强...',
        uninstallingSkillMessage: '正在卸载技能...',
        uninstallingMcpMessage: '正在卸载连接器...',
        uninstallingEnhancementMessage: '正在卸载执行增强...',
        selectEnhancement: '选择增强功能',
        installingEnhancement: '正在启动安装...',
        uninstallingEnhancement: '正在启动卸载...',
        installEnhancement: '安装',
        repairEnhancement: '修复',
        enableEnhancement: '启用',
        disableEnhancement: '禁用',
        uninstallEnhancement: '卸载',
        checkEnhancement: '重新检测',
        enhancementVersion: '版本',
        enhancementStateEnabled: '已启用',
        enhancementStateDisabled: '未启用',
        stopRun: '停止',
        feedback: '建议反馈',
        feedbackNotWorking: '没跑通',
        feedbackNextStep: '不懂下一步',
        feedbackFeature: '想要能力',
        feedbackPanelTitle: '反馈',
        feedbackTitlePlaceholder: '一句话说明想反馈的问题...',
        feedbackBodyPlaceholder: '补充现象、期望结果或改进建议...',
        openFeedback: '提交到 GitHub Issue',
        globalType: '类型',
        globalReusable: '可复用线索',
        globalLearning: '学习候选',
        globalDependencies: '阻断',
        soloPlaceholder: '说说你现在想处理的问题...',
        soloSend: '发送',
        soloAttach: '添加补充文件',
        soloHistory: '最近一次 Solo 对话',
        noSoloConversations: '还没有 Solo 对话。',
        continueHistory: '最近一次推进',
        noContinueConversations: '还没有推进记录。',
        continueCompleted: '本次推进已结束。',
        continueWorking: 'Agent 正在执行这次推进。',
        soloCompleted: '本次 Solo 对话已结束。',
        stillWorking: 'Agent 正在执行这次对话。',
        runResult: '本轮结果',
        failureLabel: '失败原因',
        agentConclusion: 'Agent 结论',
        command: '命令',
        output: '输出',
        elapsed: '已运行',
        duration: '耗时',
        changedCount: '本轮修改文件数',
        continueNative: '继续',
        filterAll: '全部',
        filterActive: '进行中',
        filterFailed: '有失败',
        filterCompleted: '已完成',
        projectOpen: '打开路线大图',
        projectContinue: '继续推进',
        projectReviewFailure: '处理失败',
        refreshProjectData: '刷新项目数据',
        refreshProjectDataDone: '已刷新',
        pinProject: '置顶项目',
        unpinProject: '取消置顶',
        checksCached: '检查缓存',
        deliverySignalAttention: '交付需处理',
        deliverySignalHealthy: '最近检查正常',
        deliverySignalRelease: '最近发布',
        feedbackRatingTitle: '觉得 SoloMap 挺好用？',
        feedbackRatingDesc: '给个五星好评，支持我们持续更新！',
        feedbackRatingButton: '去评五星好评',
        deliveryActionTitle: 'Action',
        deliveryActionShow: '展开',
        deliveryActionHide: '收起',
        deliveryActionOpenRun: '查看失败 Run',
        deliveryActionRefresh: '刷新交付状态',
        deliveryActionAgent: '交给 Agent 修复',
        deliveryActionRepoMissing: '还没有可用的 GitHub 交付信号。',
        deliveryActionLatestChecks: '最近 3 次检查',
        deliveryActionLatestRelease: '最近发布',
        deliveryActionLatestResult: '最近一次 Action 结果',
        deliveryActionWorkflow: '工作流',
        deliveryActionCached: '当前显示的是缓存结果。',
        deliveryActionHealthy: '最近 3 次检查没有失败。',
        deliveryActionInvestigate: '最近检查里有异常，先处理它再继续推进。',
        deliveryActionStarted: '已交给 Agent 检查并修复交付问题。',
        deliveryActionFailureTag: '失败',
        deliveryActionTimeoutTag: '超时',
        deliveryActionRequiredTag: '需处理',
        projectModeContinue: '环节推进',
        projectModeSolo: '自由研讨',
        projectModeFlow: '自动闭环',
        flowPlaceholder: '写下你想让 Flow 自动推进完成的目标...',
        flowLocked: 'Flow 为 Pro 用户提供自动滚动执行。',
        flowUnlock: '升级 Pro',
        flowOpen: '打开 Flow',
        emptyPortfolio: '还没有已登记项目。',
        noPortfolioMatch: '当前筛选下没有项目。',
        latestUpdate: '最近更新',
        currentStage: '当前阶段',
        nextAction: '下一步',
        nextActionSubtitle: '当前最该推进',
        nextActionReasonRunning: 'Agent 正在处理这个环节，先查看运行状态。',
        nextActionReasonFailed: '这个环节失败过，优先重试或补充要求。',
        nextActionReasonInProgress: '这个环节已经开始，继续推进最容易形成闭环。',
        nextActionReasonPending: '前置环节已满足，可以开始推进。',
        nextActionReasonComplete: '所有环节已完成，可以打开大图调整路线图。',
        nextActionPlaceholder: '补充这次要 Agent 做什么...',
        nextActionSend: '发送',
        continuePlaceholder: '补充这次推进要求...',
        continueSend: '发送',
        failures: '失败',
        selected: '当前项目',
        settingsTitle: 'SoloMap 设置',
        language: '界面语言',
        cliPath: 'Agent CLI 命令或路径',
        cliPathHelp: '填写全局安装的 CLI 命令（如 agy、codex、cursor、claude、copilot、opencode）或可执行文件绝对路径。',
        globalPrompt: '全局默认提示词',
        globalPromptPlaceholder: '例如：始终保持改动范围最小，并运行最相关的验证。',
        globalPromptHelp: '会注入每一次任务对话；环节内本次补充要求优先级更高。',
        dependencies: '本地依赖状态',
        checkDependencies: '检查',
        dependencyReady: '就绪',
        dependencyAction: '处理',
        dependencyNotChecked: '尚未检查。',
        dependencyAgent: 'Agent CLI',
        dependencyAutomation: '自动任务',
        dependencyGithub: 'GitHub 授权',
        prepareAgentAutomation: '准备 Agent',
        agentImpact: 'Agent 贡献',
        impactMinutes: '工作分钟',
        impactFiles: '改动文件',
        impactProgress: '项目推进',
        refreshAgentImpact: '刷新贡献',
        impactLoading: '正在统计贡献...',
        impactEmpty: '还没有可统计的 Agent 贡献。',
        impactRunUnit: '次',
        impactMinuteUnit: '分钟',
        impactFileUnit: '个文件',
        openAgentInstall: '安装 Agent',
        openAgentCheck: 'Agent',
        openGithubAuth: 'GitHub',
        issues: 'Issues',
        issueOpen: '待关闭',
        issueTotal: '总数',
        issueUnavailable: '连接 GitHub 后显示 Issues。',
        issueBug: 'Bug',
        issueQuickNote: '快速笔记',
        quickIssuePlaceholder: '快速新建笔记...',
        issueFeature: '需求',
        issueDebt: '技术债',
        issueDiscussion: '讨论',
        issueDocs: '文档',
        issueComments: '评论',
        issueCreate: '新建 Issue',
        issueExpand: '展开',
        issueCollapse: '收起',
        issueTitlePlaceholder: '一句话描述问题或想法...',
        issueBodyPlaceholder: '补充背景、现象、期望结果...',
        issueCategory: '分类',
        issuePriority: '优先级',
        issueClose: '关闭',
        issueCancel: '取消',
        issueSubmit: '创建',
        issueNoComments: '还没有评论。',
        issueLoading: '正在读取评论...',
        issueSynced: '已同步',
        issueCached: '缓存',
        testCli: '测试 CLI',
        save: '保存',
        chooseProject: '选择项目文件夹',
        progress: '路线图进度',
        tasks: '个任务',
        empty: '还没有路线图。请先添加项目文件夹，或在路线图中推进“生成初始路线图”环节。',
        run: '对话',
        testing: '正在测试连接...',
        connectionOk: '连接正常：',
        connectionFailed: '连接失败：',
        linkedFromSolo: '这是从 Solo 关联来的参考记录。',
        status: { Pending: '待处理', 'In Progress': '推进中', Running: '对话中', Completed: '已完成', Failed: '失败', Linked: '已关联' }
      },
      en: {
        title: 'SoloMap',
        portfolioTitle: 'Project Portfolio',
        openStrategyPyramid: 'Open Strategy Pyramid',
        globalFocusTitle: 'Today',
        globalFocusEmpty: 'No clear plan yet. Add or choose a project first.',
        todaySlotUrgent: 'Handle',
        todaySlotMain: 'Push',
        todaySlotClose: 'Close',
        todayReasonDelivery: 'Release checks need attention',
        todayReasonFailed: 'A failed step needs closure',
        todayReasonIssue: 'High-priority feedback needs attention',
        todayReasonRunning: 'The Agent is running; check status first',
        todayReasonInProgress: 'Already in motion and easiest to move forward',
        todayReasonPending: 'Ready to start',
        todayReasonReview: 'Completed work is ready for review or the next loop',
        todayReasonWeeklyFocus: 'Confirm this week’s main line first',
        todayReasonFridayLearning: 'Friday is best for closure and learning',
        todayReasonMonthReview: 'Month end is best for priority and reuse review',
        todayReasonNewProject: 'Confirm the starting point for this new project',
        todayReasonReusable: 'Reusable experience lowers today’s effort',
        todayRhythmDaily: 'Daily check',
        todayRhythmMonday: 'Monday focus',
        todayRhythmFriday: 'Friday closure',
        todayRhythmMonthEnd: 'Month-end review',
        dailyReviewButton: 'Agent Review',
        dailyReviewRunning: 'Agent is reviewing today’s plan...',
        dailyReviewFailed: 'Review failed. Open the run log for details.',
        dailyReviewEmpty: 'No Agent review yet.',
        dailyReviewConfirm: 'Needs confirmation',
        onboardingKicker: 'Get started',
        onboardingTitle: 'Give SoloMap one local project first',
        onboardingCopy: 'Choose a local project folder. SoloMap will ask for its type, then help create the first actionable roadmap.',
        onboardingStepProject: 'Add a local project folder',
        onboardingStepType: 'Choose what kind of project it is',
        onboardingStepRoadmap: 'Use "Generate Initial Roadmap" to describe the goal and let the Agent create the first roadmap',
        onboardingAction: 'Add first project',
        globalDataPath: 'Global Data Directory',
        globalDataPathPlaceholder: 'e.g. /home/ubuntu/project/.solomap-global',
        globalDataPathHelp: 'Stores cross-project portfolio, dependencies, learning candidates, and metrics. Use the .solomap-global path or its parent directory.',
        reviewerCliPath: 'Review Agent',
        reviewerCliPathPlaceholder: 'Leave empty to use the main Agent',
        reviewerCliPathHelp: 'Optional secondary CLI for read-only review after task runs.',
        collaborationReviewMode: 'Auto Review',
        collaborationReviewHelp: 'Review runs appear as a separate conversation in the same step.',
        reviewerSame: 'Same as main Agent',
        settingsSectionBasic: 'Basics',
        settingsSectionAccount: 'Account & Pro',
        settingsSectionAgent: 'Agent Collaboration',
        settingsSectionData: 'Project Data',
        settingsSectionInstructions: 'Instructions',
        settingsSectionAbilities: 'Abilities',
        settingsSectionReadiness: 'Readiness',
        proFeatureName: 'Strategy Pyramid',
        proUnlocked: 'Unlocked',
        proLocked: 'Locked',
        proAccountAnonymous: 'Not signed in',
        proValidUntil: 'Valid until',
        proExpirationHelp: 'Note: This is the local authorization cache expiration. The system will automatically and silently refresh the authorization to extend this date whenever you are online.',
        proLogin: 'Sign in / Upgrade Pro',
        proPasteCode: 'Paste authorization code',
        proAccountHelp: 'Sign in to open Pro features; local project data stays in your workspace.',
        reviewHighRisk: 'High-risk tasks',
        reviewAll: 'Every task',
        reviewOff: 'Off',
        skillInstall: 'Install Skill',
        skillInstallPlaceholder: 'e.g. https://skills.sh/owner/repo or owner/repo@skill',
        skillInstallHelp: 'Paste a skills.sh or GitHub skill link. SoloMap installs it into the global skill library.',
        installSkill: 'Install Skill',
        installingSkill: 'Starting install...',
        mcpInstall: 'Install Connector',
        mcpInstallPlaceholder: 'e.g. GitHub MCP server, npm package, or config snippet',
        mcpInstallHelp: 'Paste an MCP source. SoloMap registers it in the global connector library.',
        installMcp: 'Install Connector',
        installingMcp: 'Starting install...',
        enhancementToggles: 'Harness Enhancements',
        enhancementTogglesHelp: 'Choose one enhancement, then install or uninstall it. SoloMap asks the Agent CLI to perform the real user-environment install or full uninstall; status is detected automatically.',
        abilityManagerLabel: 'Ability Extensions & Execution Enhancements',
        abilityManagerHelp: 'Manage installed Skills, MCP Connectors, and built-in execution enhancements here.',
        abilitySelectPlaceholder: 'Select an ability or enhancement...',
        abilityGroupSkills: 'Skills',
        abilityGroupConnectors: 'MCP Connectors',
        abilityGroupEnhancements: 'Execution Enhancements',
        addSkill: '➕ Add Skill...',
        addSkillDescription: 'Install an external skill to extend SoloMap.',
        addConnector: '➕ Add Connector...',
        addConnectorDescription: 'Connect an external MCP service.',
        installedStatus: 'Installed',
        readyStatus: 'Ready',
        notInstalledStatus: 'Not installed',
        skillMetaPrefix: 'Skill path: ',
        connectorMetaPrefix: 'Connector type: ',
        enhancementMetaPrefix: 'Built-in enhancement · Version: ',
        skillInstallInputHelp: 'Paste a skills.sh or GitHub skill repository link. SoloMap installs it into the global skill library.',
        mcpInstallInputHelp: 'Paste an MCP connector source. SoloMap registers it as a global connector.',
        skillInputRequired: 'Enter a skill link before installing.',
        mcpInputRequired: 'Enter a connector source before installing.',
        installingSkillMessage: 'Installing skill...',
        installingMcpMessage: 'Installing connector...',
        installingEnhancementMessage: 'Installing execution enhancement...',
        uninstallingSkillMessage: 'Uninstalling skill...',
        uninstallingMcpMessage: 'Uninstalling connector...',
        uninstallingEnhancementMessage: 'Uninstalling execution enhancement...',
        selectEnhancement: 'Select enhancement',
        installingEnhancement: 'Starting install...',
        uninstallingEnhancement: 'Starting uninstall...',
        installEnhancement: 'Install',
        repairEnhancement: 'Repair',
        enableEnhancement: 'Enable',
        disableEnhancement: 'Disable',
        uninstallEnhancement: 'Uninstall',
        checkEnhancement: 'Check',
        enhancementVersion: 'Version',
        enhancementStateEnabled: 'Enabled',
        enhancementStateDisabled: 'Disabled',
        stopRun: 'Stop',
        feedback: 'Feedback',
        feedbackNotWorking: 'Not working',
        feedbackNextStep: 'Next step unclear',
        feedbackFeature: 'Feature request',
        feedbackPanelTitle: 'Feedback',
        feedbackTitlePlaceholder: 'Summarize the issue or idea...',
        feedbackBodyPlaceholder: 'Add what happened, what you expected, or the suggestion...',
        openFeedback: 'Open GitHub Issue',
        globalType: 'Type',
        globalReusable: 'Reusable signals',
        globalLearning: 'Learning candidates',
        globalDependencies: 'Blockers',
        soloPlaceholder: 'Describe what you want to handle...',
        soloSend: 'Send',
        soloAttach: 'Attach files',
        soloHistory: 'Latest Solo conversation',
        noSoloConversations: 'No Solo conversations yet.',
        continueHistory: 'Latest run',
        noContinueConversations: 'No runs yet.',
        continueCompleted: 'This run has finished.',
        continueWorking: 'The Agent is running this step.',
        soloCompleted: 'This Solo conversation has finished.',
        stillWorking: 'The Agent is running this conversation.',
        runResult: 'Run result',
        failureLabel: 'Failure reason',
        agentConclusion: 'Agent conclusion',
        command: 'Command',
        output: 'Output',
        elapsed: 'Elapsed',
        duration: 'Duration',
        changedCount: 'Files changed in this run',
        continueNative: 'Continue',
        filterAll: 'All',
        filterActive: 'Active',
        filterFailed: 'Failed',
        filterCompleted: 'Done',
        projectOpen: 'Open Roadmap',
        projectContinue: 'Continue',
        projectReviewFailure: 'Review Failure',
        refreshProjectData: 'Refresh project data',
        refreshProjectDataDone: 'Refreshed',
        pinProject: 'Pin project',
        unpinProject: 'Unpin project',
        checksCached: 'Checks cached',
        deliverySignalAttention: 'Delivery needs attention',
        deliverySignalHealthy: 'Checks look healthy',
        deliverySignalRelease: 'Latest release',
        feedbackRatingTitle: 'Loving SoloMap?',
        feedbackRatingDesc: 'Give us a 5-star rating on the marketplace to support our updates!',
        feedbackRatingButton: 'Rate on Marketplace',
        deliveryActionTitle: 'Action',
        deliveryActionShow: 'Expand',
        deliveryActionHide: 'Collapse',
        deliveryActionOpenRun: 'Open failed run',
        deliveryActionRefresh: 'Refresh delivery',
        deliveryActionAgent: 'Let Agent fix it',
        deliveryActionRepoMissing: 'No GitHub delivery signal is available yet.',
        deliveryActionLatestChecks: 'Latest 3 checks',
        deliveryActionLatestRelease: 'Latest release',
        deliveryActionLatestResult: 'Latest action result',
        deliveryActionWorkflow: 'Workflow',
        deliveryActionCached: 'The current delivery state is from cache.',
        deliveryActionHealthy: 'The latest 3 checks have no failures.',
        deliveryActionInvestigate: 'A recent delivery check failed. Resolve it before pushing forward.',
        deliveryActionStarted: 'Asked the Agent to inspect and fix the delivery issue.',
        deliveryActionFailureTag: 'Failed',
        deliveryActionTimeoutTag: 'Timed out',
        deliveryActionRequiredTag: 'Needs action',
        projectModeContinue: 'Step Progress',
        projectModeSolo: 'Free Work',
        projectModeFlow: 'Auto Loop',
        flowPlaceholder: 'Describe the goal you want Flow to drive to completion...',
        flowLocked: 'Flow automatic execution is available for Pro users.',
        flowUnlock: 'Upgrade Pro',
        flowOpen: 'Open Flow',
        emptyPortfolio: 'No registered projects yet.',
        noPortfolioMatch: 'No projects match this filter.',
        latestUpdate: 'Updated',
        currentStage: 'Stage',
        nextAction: 'Next',
        nextActionSubtitle: 'Current focus',
        nextActionReasonRunning: 'The Agent is already working on this step. Check the running state first.',
        nextActionReasonFailed: 'This step failed before. Retry it with clearer guidance.',
        nextActionReasonInProgress: 'This step is already in motion. Continue it to close the loop.',
        nextActionReasonPending: 'Dependencies are ready. This is the next step to start.',
        nextActionReasonComplete: 'All steps are complete. Open the roadmap to revise the next loop.',
        nextActionPlaceholder: 'Add guidance for this Agent run...',
        nextActionSend: 'Send',
        continuePlaceholder: 'Add guidance for this run...',
        continueSend: 'Send',
        failures: 'Failures',
        selected: 'Current project',
        settingsTitle: 'SoloMap Settings',
        language: 'Language',
        cliPath: 'CLI Command or Path',
        cliPathHelp: 'Name of a globally installed CLI such as agy, codex, cursor, claude, copilot, or opencode, or an absolute executable path.',
        globalPrompt: 'Default Agent Instructions',
        globalPromptPlaceholder: 'e.g. Keep changes minimal and run the narrowest relevant test.',
        globalPromptHelp: 'Injected into every task conversation; current conversation guidance takes priority.',
        dependencies: 'Local readiness',
        checkDependencies: 'Check',
        dependencyReady: 'Ready',
        dependencyAction: 'Action',
        dependencyNotChecked: 'Not checked yet.',
        dependencyAgent: 'Agent CLI',
        dependencyAutomation: 'Task automation',
        dependencyGithub: 'GitHub authorization',
        prepareAgentAutomation: 'Prepare Agent',
        agentImpact: 'Agent Impact',
        impactMinutes: 'Minutes',
        impactFiles: 'Files changed',
        impactProgress: 'Project progress',
        refreshAgentImpact: 'Refresh Impact',
        impactLoading: 'Collecting impact...',
        impactEmpty: 'No Agent impact recorded yet.',
        impactRunUnit: 'runs',
        impactMinuteUnit: 'min',
        impactFileUnit: 'files',
        openAgentInstall: 'Install Agent',
        openAgentCheck: 'Agent',
        openGithubAuth: 'GitHub',
        issues: 'Issues',
        issueOpen: 'Open',
        issueTotal: 'Total',
        issueUnavailable: 'Connect GitHub to show Issues.',
        issueBug: 'Bug',
        issueQuickNote: 'Quick Note',
        quickIssuePlaceholder: 'Quick new note...',
        issueFeature: 'Feature',
        issueDebt: 'Tech debt',
        issueDiscussion: 'Discussion',
        issueDocs: 'Docs',
        issueComments: 'comments',
        issueCreate: 'New Issue',
        issueExpand: 'Expand',
        issueCollapse: 'Collapse',
        issueTitlePlaceholder: 'Summarize the issue or idea...',
        issueBodyPlaceholder: 'Add context, observed behavior, and expected outcome...',
        issueCategory: 'Category',
        issuePriority: 'Priority',
        issueClose: 'Close',
        issueCancel: 'Cancel',
        issueSubmit: 'Create',
        issueNoComments: 'No comments yet.',
        issueLoading: 'Loading comments...',
        issueSynced: 'Synced',
        issueCached: 'Cached',
        testCli: 'Test CLI',
        save: 'Save',
        chooseProject: 'Choose project folder',
        progress: 'Roadmap Sync Progress',
        tasks: 'Tasks',
        empty: 'No roadmap yet. Add a project folder, or run the "Generate Initial Roadmap" step first.',
        run: 'Run',
        testing: 'Testing connection...',
        connectionOk: 'Connection OK: ',
        connectionFailed: 'Connection Failed: ',
        linkedFromSolo: 'This is a reference linked from Solo.',
        status: { Pending: 'Pending', 'In Progress': 'In Progress', Running: 'Running', Completed: 'Completed', Failed: 'Failed', Linked: 'Linked' }
      }
    };

    function t(key) {
      return i18n[currentLanguage][key] || i18n.en[key] || key;
    }

    function statusText(status) {
      return (i18n[currentLanguage].status || {})[status] || status;
    }

    function conversationStatusText(status) {
      if (status === 'Completed') {
        return currentLanguage === 'zh' ? '已结束' : 'Finished';
      }
      return statusText(status);
    }

    function conversationStatusKey(status) {
      const value = String(status || '').trim();
      return value || 'Completed';
    }

    function statusClass(status) {
      return String(status || '').replace(/[^a-zA-Z0-9]/g, '-');
    }

    function setText(id, value) {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    }

    function resetProjectScopedState(projectPath, clearNodes) {
      activeProjectPath = projectPath || '';
      expandedIssueNumber = 0;
      issueDetails = null;
      issuePanelExpanded = false;
      deliveryActionPanelExpanded = false;
      issueFormOpen = false;
      issueActionMessage = '';
      deliveryActionMessage = '';
      if (clearNodes) {
        currentNodes = [];
      }
    }

    function shouldRefreshSidebarProjectData(projectPath, cache, force) {
      const key = String(projectPath || '');
      if (!key) return false;
      if (force) return true;
      const lastRequestedAt = Number(cache[key] || 0);
      return !lastRequestedAt || Date.now() - lastRequestedAt > sidebarConversationRefreshTtlMs;
    }

    function requestSidebarSoloConversationHistory(projectPath, force = false) {
      const key = String(projectPath || '');
      if (!shouldRefreshSidebarProjectData(key, sidebarSoloConversationRequestedAt, force)) {
        return;
      }
      sidebarSoloConversationRequestedAt[key] = Date.now();
      vscode.postMessage({ command: 'getSoloConversationHistory', projectPath: key });
    }

    function requestSidebarProjectConversationHistory(projectPath, force = false) {
      const key = String(projectPath || '');
      if (!shouldRefreshSidebarProjectData(key, sidebarProjectConversationRequestedAt, force)) {
        return;
      }
      sidebarProjectConversationRequested[key] = true;
      sidebarProjectConversationRequestedAt[key] = Date.now();
      vscode.postMessage({ command: 'getProjectConversationHistory', projectPath: key });
    }

    function applyLanguage() {
      setText('sidebar-title', t('title'));
      setText('portfolio-title', t('portfolioTitle'));
      btnToggleSettings.title = t('settingsTitle');
      if (btnToggleFeedback) btnToggleFeedback.title = t('feedbackPanelTitle');
      btnAddProject.title = t('chooseProject');
      setText('feedback-title', t('feedbackPanelTitle'));
      setText('feedback-type-not-working', t('feedbackNotWorking'));
      setText('text-rating-title', t('feedbackRatingTitle'));
      setText('text-rating-desc', t('feedbackRatingDesc'));
      setText('text-rate-btn', t('feedbackRatingButton'));
      setText('feedback-type-next-step', t('feedbackNextStep'));
      setText('feedback-type-feature', t('feedbackFeature'));
      setText('settings-title', t('settingsTitle'));
      setText('label-language', t('language'));
      setText('label-cli-path', t('cliPath'));
      setText('help-cli-path', t('cliPathHelp'));
      setText('label-agent-model', currentLanguage === 'zh' ? '默认模型' : 'Default Model');
      setText('help-agent-model', currentLanguage === 'zh'
        ? '默认跟随当前 Agent 系列的自动模型；固定后会优先使用该模型。'
        : 'Uses the selected Agent family default unless you pin a specific model.');
      setText('label-global-prompt', t('globalPrompt'));
      settingGlobalPrompt.placeholder = t('globalPromptPlaceholder');
      setText('help-global-prompt', t('globalPromptHelp'));
      setText('label-global-data-path', t('globalDataPath'));
      if (settingGlobalDataPath) settingGlobalDataPath.placeholder = t('globalDataPathPlaceholder');
      setText('help-global-data-path', t('globalDataPathHelp'));
      setText('label-reviewer-cli-path', t('reviewerCliPath'));
      if (settingReviewerCliPathCustom) settingReviewerCliPathCustom.placeholder = t('reviewerCliPathPlaceholder');
      setText('help-reviewer-cli-path', t('reviewerCliPathHelp'));
      setText('label-collaboration-review-mode', t('collaborationReviewMode'));
      setText('help-collaboration-review-mode', t('collaborationReviewHelp'));
      setText('option-reviewer-same', t('reviewerSame'));
      if (settingReviewerCliSelect) setSoloSelectValue(settingReviewerCliSelect, getSoloSelectValue(settingReviewerCliSelect));
      setText('settings-section-basic', t('settingsSectionBasic'));
      setText('settings-section-account', t('settingsSectionAccount'));
      setText('settings-section-agent', t('settingsSectionAgent'));
      setText('settings-section-data', t('settingsSectionData'));
      setText('settings-section-instructions', t('settingsSectionInstructions'));
      setText('settings-section-abilities', t('settingsSectionAbilities'));
      setText('settings-section-readiness', t('settingsSectionReadiness'));
      setText('option-review-high-risk', t('reviewHighRisk'));
      setText('option-review-all', t('reviewAll'));
      setText('option-review-off', t('reviewOff'));
      if (settingCollaborationReviewMode) setSoloSelectValue(settingCollaborationReviewMode, getSoloSelectValue(settingCollaborationReviewMode) || 'high_risk');
      setText('label-agent-impact', t('agentImpact'));
      setText('impact-minutes-label', t('impactMinutes'));
      setText('impact-files-label', t('impactFiles'));
      setText('impact-progress-label', t('impactProgress'));
      setText('text-refresh-agent-impact', t('refreshAgentImpact'));
      setText('text-open-pro-authorization', t('proLogin'));
      setText('text-paste-pro-code', t('proPasteCode'));
      setText('label-enhancement-toggles', t('abilityManagerLabel'));
      setText('help-enhancement-toggles', t('abilityManagerHelp'));
      setText('text-install-ability', t('installEnhancement'));
      setText('text-uninstall-ability', t('uninstallEnhancement'));
      if (settingFeedbackTitle) settingFeedbackTitle.placeholder = t('feedbackTitlePlaceholder');
      if (settingFeedbackBody) settingFeedbackBody.placeholder = t('feedbackBodyPlaceholder');
      setText('text-open-feedback', t('openFeedback'));
      setText('label-dependencies', t('dependencies'));
      setText('dependency-agent-name', t('dependencyAgent'));
      setText('dependency-automation-name', t('dependencyAutomation'));
      setText('dependency-github-name', t('dependencyGithub'));
      setText('text-check-dependencies', t('checkDependencies'));
      setText('text-open-agent-install', t('openAgentInstall'));
      setText('text-prepare-agent-automation', t('prepareAgentAutomation'));
      setText('text-open-agent-check', t('openAgentCheck'));
      setText('text-open-github-auth', t('openGithubAuth'));
      setText('text-test-cli', t('testCli'));
      setText('text-save-settings', t('save'));
      setText('progress-label', t('progress'));
      setText('text-open-strategy-pyramid', t('openStrategyPyramid'));
      renderProjects(currentProjects.projects, currentProjects.selectedProjectPath);
      renderPortfolioFilters();
      renderGlobalFocus(currentProjects.portfolio, currentProjects.selectedProjectPath);
      renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
      renderProAccount(currentSettings);
      renderSidebar(currentNodes);
    }

    // Toggle settings panel
    if (btnToggleFeedback) {
      btnToggleFeedback.addEventListener('click', () => {
        if (feedbackPanel.style.display === 'block') {
          feedbackPanel.style.display = 'none';
        } else {
          settingsPanel.style.display = 'none';
          feedbackPanel.style.display = 'block';
        }
      });
    }

    if (btnCloseFeedback) {
      btnCloseFeedback.addEventListener('click', () => {
        feedbackPanel.style.display = 'none';
      });
    }

    btnToggleSettings.addEventListener('click', () => {
      if (settingsPanel.style.display === 'block') {
        settingsPanel.style.display = 'none';
      } else {
        feedbackPanel.style.display = 'none';
        settingsPanel.style.display = 'block';
        vscode.postMessage({ command: 'getSettings' });
        requestAgentImpact();
      }
    });

    btnCloseSettings.addEventListener('click', () => {
      settingsPanel.style.display = 'none';
      cliTestBadge.style.display = 'none';
    });

    bindSoloSelect(settingLanguage, (value) => {
      currentLanguage = value;
      applyLanguage();
    });

    bindSoloSelect(settingCliSelect, () => {
      const selected = getSoloSelectValue(settingCliSelect);
      settingCliPathCustom.style.display = selected === 'custom' ? 'block' : 'none';
      currentCliPath = selected === 'custom' ? getEffectiveSettingCliPath() : selected || 'agy';
      ensureAgentModelsLoaded(currentCliPath, 'settings');
      syncSettingAgentModelSelect();
    });
    if (settingCliPathCustom) {
      const refreshCustomCliModels = () => {
        if (getSoloSelectValue(settingCliSelect) !== 'custom') return;
        currentCliPath = getEffectiveSettingCliPath();
        ensureAgentModelsLoaded(currentCliPath, 'settings');
        syncSettingAgentModelSelect();
      };
      settingCliPathCustom.addEventListener('input', refreshCustomCliModels);
      settingCliPathCustom.addEventListener('change', refreshCustomCliModels);
    }
    bindSoloSelect(settingAgentModelSelect, (value) => {
      const family = getAgentFamilyKey(getEffectiveSettingCliPath());
      if (!family) return;
      agentModelPreferenceMap[family] = value || 'auto';
    });
    bindSoloSelect(settingReviewerCliSelect, () => {
      const selected = getSoloSelectValue(settingReviewerCliSelect);
      if (settingReviewerCliPathCustom) {
        settingReviewerCliPathCustom.style.display = selected === 'custom' ? 'block' : 'none';
      }
    });
    bindSoloSelect(settingCollaborationReviewMode, () => {});

    if (btnOpenProAuthorization) {
      btnOpenProAuthorization.addEventListener('click', () => {
        vscode.postMessage({ command: 'openProAuthorization' });
      });
    }

    if (btnPasteProCode) {
      btnPasteProCode.addEventListener('click', () => {
        vscode.postMessage({ command: 'pasteProAuthorizationCode' });
      });
    }

    function showAbilityActionMessage(message, isError = false) {
      if (!abilityActionBadge) return;
      abilityActionBadge.style.display = 'block';
      abilityActionBadge.className = isError ? 'cli-badge error' : 'cli-badge';
      abilityActionBadge.style.background = isError ? '' : 'rgba(255,255,255,0.05)';
      abilityActionBadge.style.color = isError ? '' : 'var(--text-muted)';
      abilityActionBadge.textContent = message;
    }

    function getCliPresetFromCliPath(cliPath) {
      const raw = String(cliPath || '').trim();
      if (!raw) return 'agy';
      // NOTE: this code runs inside a Webview <script> string; escaping must survive TS template literal parsing.
      const base = raw.split(/[\\\\/]/).pop().toLowerCase();
      if (['agy', 'antigravity', 'antigravity-cli'].includes(base)) return 'agy';
      if (['codex', 'codex-cli'].includes(base)) return 'codex';
      if (['cursor', 'cursor-cli', 'cursor-agent'].includes(base)) return 'cursor';
      if (['copilot', 'copilot-cli'].includes(base)) return 'copilot';
      if (['claude', 'claude-code', 'claude-code-cli'].includes(base)) return 'claude';
      if (['opencode', 'open-code', 'open-code-cli'].includes(base)) return 'opencode';
      return 'custom';
    }

    function getAgentFamilyKey(agentCli) {
      const normalized = normalizeAgentOptionLabel(agentCli || getEffectiveSettingCliPath() || currentCliPath || 'agy');
      return String(normalized || 'agy').toLowerCase();
    }

    function getAutoOnlyModelCatalog(agentCli) {
      return {
        agentCli: getAgentFamilyKey(agentCli),
        supportsDiscovery: false,
        models: [{ value: 'auto', label: 'Auto' }]
      };
    }

    function getAgentModelCatalog(agentCli) {
      const family = getAgentFamilyKey(agentCli);
      return agentModelCatalogs[family] || getAutoOnlyModelCatalog(family);
    }

    function getAgentModelOptions(agentCli) {
      const catalog = getAgentModelCatalog(agentCli);
      const options = Array.isArray(catalog.models) && catalog.models.length
        ? catalog.models
        : getAutoOnlyModelCatalog(agentCli).models;
      return options.map(option => ({
        value: String(option.value || 'auto'),
        label: String(option.label || option.value || 'Auto'),
        title: String(option.description || option.label || option.value || 'Auto')
      }));
    }

    function sanitizeModelValue(agentCli, value) {
      const selectedValue = String(value || 'auto');
      return getAgentModelOptions(agentCli).some(option => option.value === selectedValue) ? selectedValue : 'auto';
    }

    function getStoredModelPreference(agentCli) {
      return sanitizeModelValue(agentCli, agentModelPreferenceMap[getAgentFamilyKey(agentCli)] || 'auto');
    }

    function getTargetModelValue(targetId, agentCli) {
      if (targetId && projectConversationModelSelections[targetId]) {
        return sanitizeModelValue(agentCli, projectConversationModelSelections[targetId]);
      }
      return getStoredModelPreference(agentCli);
    }

    function setTargetModelValue(targetId, agentCli, value, persistPreference) {
      const nextValue = sanitizeModelValue(agentCli, value);
      if (targetId) {
        projectConversationModelSelections[targetId] = nextValue;
      }
      if (persistPreference) {
        agentModelPreferenceMap[getAgentFamilyKey(agentCli)] = nextValue;
      }
      return nextValue;
    }

    function ensureAgentModelsLoaded(agentCli, targetId) {
      const requestId = 'models-' + (++agentModelRequestSeq);
      vscode.postMessage({
        command: 'getAgentModels',
        requestId,
        targetId: targetId || '',
        agentCli: String(agentCli || '').trim() || currentCliPath || 'agy'
      });
    }

    function syncSettingAgentModelSelect() {
      if (!settingAgentModelSelect) return;
      const agentCli = getEffectiveSettingCliPath();
      setSoloSelectOptions(settingAgentModelSelect, getAgentModelOptions(agentCli), getStoredModelPreference(agentCli));
    }

    function getEffectiveSettingCliPath() {
      const selected = getSoloSelectValue(settingCliSelect);
      if (selected === 'custom') {
        return (settingCliPathCustom.value || '').trim() || 'agy';
      }
      if (currentCliPath && getCliPresetFromCliPath(currentCliPath) === selected) {
        return currentCliPath;
      }
      return selected || 'agy';
    }

    function applySettingCliPath(cliPath) {
      const raw = String(cliPath || '').trim() || 'agy';
      const preset = getCliPresetFromCliPath(raw);
      currentCliPath = raw;
      setSoloSelectValue(settingCliSelect, preset);
      if (preset === 'custom') {
        settingCliPathCustom.value = raw;
        settingCliPathCustom.style.display = 'block';
      } else {
        settingCliPathCustom.value = '';
        settingCliPathCustom.style.display = 'none';
      }
    }

    function getEffectiveReviewerCliPath() {
      const selected = getSoloSelectValue(settingReviewerCliSelect);
      if (!selected) return '';
      if (selected === 'custom') {
        return (settingReviewerCliPathCustom.value || '').trim();
      }
      return selected;
    }

    function applyReviewerCliPath(cliPath) {
      const raw = String(cliPath || '').trim();
      if (!raw) {
        setSoloSelectValue(settingReviewerCliSelect, '');
        if (settingReviewerCliPathCustom) {
          settingReviewerCliPathCustom.value = '';
          settingReviewerCliPathCustom.style.display = 'none';
        }
        return;
      }
      const preset = getCliPresetFromCliPath(raw);
      setSoloSelectValue(settingReviewerCliSelect, preset);
      if (settingReviewerCliPathCustom) {
        if (preset === 'custom') {
          settingReviewerCliPathCustom.value = raw;
          settingReviewerCliPathCustom.style.display = 'block';
        } else {
          settingReviewerCliPathCustom.value = '';
          settingReviewerCliPathCustom.style.display = 'none';
        }
      }
    }

    function hasStrategyPyramidPro(settings) {
      const entitlements = (settings && settings.proEntitlements) || {};
      const account = (settings && settings.proAccount) || {};
      return Boolean(account.allowed || entitlements.strategy_pyramid || entitlements.strategyPyramid || entitlements.pro || entitlements.solomap_pro);
    }

    function hasFlowPro(settings) {
      const entitlements = (settings && settings.proEntitlements) || {};
      const account = (settings && settings.proAccount) || {};
      return Boolean(account.allowed || entitlements.flow_mode || entitlements.flowMode || entitlements.pro || entitlements.solomap_pro);
    }

    function renderProAccount(settings) {
      if (!proAccountPanel) return;
      const account = (settings && settings.proAccount) || {};
      const unlocked = hasStrategyPyramidPro(settings || {});
      const email = String(account.email || '').trim();
      const expiresAt = String(account.expiresAt || '').trim();
      let expiresText = '';
      if (expiresAt) {
        const dateText = new Date(expiresAt).toLocaleDateString(currentLanguage === 'zh' ? 'zh-CN' : 'en-US');
        expiresText = '<div class="dependency-message">' + escapeHtml(t('proValidUntil')) + ' ' + escapeHtml(dateText) + '</div>'
          + '<div class="dependency-message" style="font-size: 10px; opacity: 0.8; line-height: 1.35; margin-top: 2px; color: var(--vscode-descriptionForeground, var(--text-muted));">' + escapeHtml(t('proExpirationHelp')) + '</div>';
      }
      proAccountPanel.innerHTML =
        '<div class="dependency-item">'
        + '<div class="dependency-info">'
        + '<div class="dependency-name">' + escapeHtml(t('proFeatureName')) + '</div>'
        + '<div class="dependency-message">' + escapeHtml(email || t('proAccountAnonymous')) + '</div>'
        + expiresText
        + '<div class="dependency-message">' + escapeHtml(t('proAccountHelp')) + '</div>'
        + '</div>'
        + '<span class="dependency-status ' + (unlocked ? 'ready' : 'missing') + '">' + escapeHtml(unlocked ? t('proUnlocked') : t('proLocked')) + '</span>'
        + '</div>';
    }

    let selectedAbilityId = '';
    let currentAbilitySettings = null;

    function renderAbilitiesAndEnhancements(settings) {
      if (!settingAbilitySelect || !settingsAbilityUrlInputContainer || !settingAbilityUrlInput || !helpAbilityUrlInput || !abilityDetailCard || !btnInstallAbility || !btnUninstallAbility) {
        return;
      }
      currentAbilitySettings = settings;
      const skills = Array.isArray(settings.skills) ? settings.skills : [];
      const connectors = Array.isArray(settings.connectors) ? settings.connectors : [];
      const enhancements = Array.isArray(settings.enhancementStatuses) ? settings.enhancementStatuses : [];

      const items = [];
      skills.forEach(s => {
        items.push({
          id: 'skill-' + s.id,
          type: 'skill',
          originId: s.id,
          title: s.title || s.id,
          description: s.description || '',
          installed: true,
          statusLabel: t('installedStatus'),
          statusClass: 'ready',
          meta: t('skillMetaPrefix') + (s.entry || '')
        });
      });
      items.push({
        id: 'add-new-skill',
        type: 'add-new-skill',
        title: t('addSkill'),
        description: t('addSkillDescription'),
        installed: false
      });

      connectors.forEach(c => {
        items.push({
          id: 'connector-' + c.id,
          type: 'connector',
          originId: c.id,
          title: c.title || c.id,
          description: c.description || '',
          installed: true,
          statusLabel: t('installedStatus'),
          statusClass: 'ready',
          meta: t('connectorMetaPrefix') + (c.type || 'mcp')
        });
      });
      items.push({
        id: 'add-new-connector',
        type: 'add-new-connector',
        title: t('addConnector'),
        description: t('addConnectorDescription'),
        installed: false
      });

      enhancements.forEach(e => {
        const isInstalled = e.status === 'ready' || e.installed;
        items.push({
          id: 'enhancement-' + e.id,
          type: 'enhancement',
          originId: e.id,
          title: e.title || e.id,
          description: e.description || '',
          installed: isInstalled,
          statusLabel: e.statusLabel || (isInstalled ? t('readyStatus') : t('notInstalledStatus')),
          statusClass: e.status || (isInstalled ? 'ready' : 'missing'),
          meta: t('enhancementMetaPrefix') + (e.version || 'unknown')
        });
      });

      if (!selectedAbilityId || !items.some(item => item.id === selectedAbilityId)) {
        selectedAbilityId = items.length > 0 ? items[0].id : '';
      }
      const selectedItem = items.find(item => item.id === selectedAbilityId) || items[0];

      let optionsHtml = '';
      
      optionsHtml += '<div class="solo-select-group-header">' + escapeHtml(t('abilityGroupSkills')) + '</div>';
      optionsHtml += items.filter(i => i.type === 'skill' || i.type === 'add-new-skill').map(item => 
        '<button type="button" class="solo-select-option" data-solo-option-value="' + escapeHtml(item.id) + '" aria-selected="' + (item.id === selectedItem.id ? 'true' : 'false') + '">' + escapeHtml(item.title) + '</button>'
      ).join('');

      optionsHtml += '<div class="solo-select-group-header">' + escapeHtml(t('abilityGroupConnectors')) + '</div>';
      optionsHtml += items.filter(i => i.type === 'connector' || i.type === 'add-new-connector').map(item => 
        '<button type="button" class="solo-select-option" data-solo-option-value="' + escapeHtml(item.id) + '" aria-selected="' + (item.id === selectedItem.id ? 'true' : 'false') + '">' + escapeHtml(item.title) + '</button>'
      ).join('');

      optionsHtml += '<div class="solo-select-group-header">' + escapeHtml(t('abilityGroupEnhancements')) + '</div>';
      optionsHtml += items.filter(i => i.type === 'enhancement').map(item => 
        '<button type="button" class="solo-select-option" data-solo-option-value="' + escapeHtml(item.id) + '" aria-selected="' + (item.id === selectedItem.id ? 'true' : 'false') + '">' + escapeHtml(item.title) + '</button>'
      ).join('');

      const selectMenu = settingAbilitySelect.querySelector('[data-solo-menu]');
      if (selectMenu) {
        selectMenu.innerHTML = optionsHtml;
      }
      
      const selectLabel = settingAbilitySelect.querySelector('[data-solo-label]');
      if (selectLabel) {
        selectLabel.textContent = selectedItem.title;
      }
      settingAbilitySelect.setAttribute('data-value', selectedItem.id);

      if (selectedItem.type === 'add-new-skill') {
        settingsAbilityUrlInputContainer.style.display = 'block';
        settingAbilityUrlInput.placeholder = 'e.g. https://skills.sh/owner/repo or owner/repo@skill';
        helpAbilityUrlInput.textContent = t('skillInstallInputHelp');
        abilityDetailCard.style.display = 'none';
        btnInstallAbility.removeAttribute('disabled');
        btnUninstallAbility.setAttribute('disabled', 'true');
      } else if (selectedItem.type === 'add-new-connector') {
        settingsAbilityUrlInputContainer.style.display = 'block';
        settingAbilityUrlInput.placeholder = 'e.g. GitHub MCP server URL, npm package, or config snippet';
        helpAbilityUrlInput.textContent = t('mcpInstallInputHelp');
        abilityDetailCard.style.display = 'none';
        btnInstallAbility.removeAttribute('disabled');
        btnUninstallAbility.setAttribute('disabled', 'true');
      } else {
        settingsAbilityUrlInputContainer.style.display = 'none';
        abilityDetailCard.style.display = 'block';
        abilityDetailTitle.textContent = selectedItem.title;
        abilityDetailDesc.textContent = selectedItem.description;
        abilityDetailStatus.textContent = selectedItem.statusLabel;
        abilityDetailStatus.className = 'enhancement-status ' + selectedItem.statusClass;
        abilityDetailMeta.textContent = selectedItem.meta || '';
        
        if (selectedItem.type === 'enhancement') {
          if (selectedItem.installed) {
            btnInstallAbility.setAttribute('disabled', 'true');
            btnUninstallAbility.removeAttribute('disabled');
          } else {
            btnInstallAbility.removeAttribute('disabled');
            btnUninstallAbility.setAttribute('disabled', 'true');
          }
        } else {
          btnInstallAbility.setAttribute('disabled', 'true');
          btnUninstallAbility.removeAttribute('disabled');
        }
      }

      bindSoloSelect(settingAbilitySelect, (value) => {
        selectedAbilityId = value || '';
        renderAbilitiesAndEnhancements(settings);
      });
    }

    if (btnInstallAbility) {
      btnInstallAbility.addEventListener('click', () => {
        if (!selectedAbilityId || !currentAbilitySettings) return;
        
        if (selectedAbilityId === 'add-new-skill') {
          const urlVal = settingAbilityUrlInput.value.trim();
          if (!urlVal) {
            showAbilityActionMessage(t('skillInputRequired'), true);
            return;
          }
          showAbilityActionMessage(t('installingSkillMessage'));
          vscode.postMessage({ command: 'installSkill', skillInput: urlVal });
        } else if (selectedAbilityId === 'add-new-connector') {
          const urlVal = settingAbilityUrlInput.value.trim();
          if (!urlVal) {
            showAbilityActionMessage(t('mcpInputRequired'), true);
            return;
          }
          showAbilityActionMessage(t('installingMcpMessage'));
          vscode.postMessage({ command: 'installMcp', mcpInput: urlVal });
        } else if (selectedAbilityId.startsWith('enhancement-')) {
          const originId = selectedAbilityId.substring('enhancement-'.length);
          showAbilityActionMessage(t('installingEnhancementMessage'));
          vscode.postMessage({ command: 'installEnhancement', enhancementId: originId });
        }
      });
    }

    if (btnUninstallAbility) {
      btnUninstallAbility.addEventListener('click', () => {
        if (!selectedAbilityId || !currentAbilitySettings) return;
        
        if (selectedAbilityId.startsWith('skill-')) {
          const originId = selectedAbilityId.substring('skill-'.length);
          showAbilityActionMessage(t('uninstallingSkillMessage'));
          vscode.postMessage({ command: 'uninstallSkill', skillId: originId });
        } else if (selectedAbilityId.startsWith('connector-')) {
          const originId = selectedAbilityId.substring('connector-'.length);
          showAbilityActionMessage(t('uninstallingMcpMessage'));
          vscode.postMessage({ command: 'uninstallMcp', mcpId: originId });
        } else if (selectedAbilityId.startsWith('enhancement-')) {
          const originId = selectedAbilityId.substring('enhancement-'.length);
          showAbilityActionMessage(t('uninstallingEnhancementMessage'));
          vscode.postMessage({ command: 'uninstallEnhancement', enhancementId: originId });
        }
      });
    }

    // Request configurations and nodes on load
    vscode.postMessage({ command: 'getNodes' });
    vscode.postMessage({ command: 'getSettings' });
    vscode.postMessage({ command: 'getProjects' });
    vscode.postMessage({ command: 'getDailyReview' });

    // Handle messages
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.command) {
        case 'nodesUpdated':
          if (message.projectPath && activeProjectPath && message.projectPath !== activeProjectPath) {
            return;
          }
          if (message.projectPath && !activeProjectPath) {
            activeProjectPath = message.projectPath;
          }
          currentNodes = message.nodes || [];
          renderSidebar(message.nodes);
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          break;

        case 'settingsLoaded':
          currentSettings = message.settings || {};
          Object.keys(agentModelPreferenceMap).forEach(key => delete agentModelPreferenceMap[key]);
          Object.assign(agentModelPreferenceMap, (message.settings && message.settings.agentModelPreferences) || {});
          applySettingCliPath(message.settings.cliPath || 'agy');
          settingGlobalPrompt.value = message.settings.globalPrompt || '';
          if (settingGlobalDataPath) settingGlobalDataPath.value = message.settings.globalDataPath || '';
          applyReviewerCliPath(message.settings.reviewerCliPath || '');
          if (settingCollaborationReviewMode) setSoloSelectValue(settingCollaborationReviewMode, message.settings.collaborationReviewMode || 'high_risk');
          syncSettingAgentModelSelect();
          ensureAgentModelsLoaded(getEffectiveSettingCliPath(), 'settings');
          renderProAccount(currentSettings);
          renderAbilitiesAndEnhancements(message.settings);
          setSoloSelectValue(settingLanguage, message.settings.language || 'zh');
          currentLanguage = getSoloSelectValue(settingLanguage);
          applyLanguage();
          break;

        case 'agentModelsLoaded': {
          const catalog = message.catalog || getAutoOnlyModelCatalog(message.targetId || '');
          agentModelCatalogs[String(catalog.family || getAgentFamilyKey(message.agentCli || currentCliPath || 'agy')).toLowerCase()] = catalog;
          syncSettingAgentModelSelect();
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          break;
        }

        case 'projectsLoaded':
          const incomingSelectedProjectPath = message.projects.selectedProjectPath || '';
          const selectedProjectPath = activeProjectPath && incomingSelectedProjectPath && incomingSelectedProjectPath !== activeProjectPath
            ? activeProjectPath
            : incomingSelectedProjectPath;
          if (
            selectedProjectPath &&
            activeProjectPath &&
            selectedProjectPath !== activeProjectPath
          ) {
            resetProjectScopedState(selectedProjectPath, true);
            renderSidebar(currentNodes);
          } else if (selectedProjectPath && !activeProjectPath) {
            activeProjectPath = selectedProjectPath;
          }
          currentProjects.projects = message.projects.projects || [];
          currentProjects.selectedProjectPath = selectedProjectPath || '';
          currentProjects.portfolio = message.projects.portfolio || [];
          currentProjects.globalStore = message.projects.globalStore || null;
          renderProjects(message.projects.projects, currentProjects.selectedProjectPath);
          renderGlobalFocus(currentProjects.portfolio, currentProjects.selectedProjectPath);
          renderPortfolio(message.projects.portfolio || [], currentProjects.selectedProjectPath || '');
          break;

        case 'projectIssuesLoaded':
          currentProjects.portfolio = (currentProjects.portfolio || []).map(project => (
            project.path === message.projectPath ? { ...project, issues: message.issues } : project
          ));
          renderGlobalFocus(currentProjects.portfolio, currentProjects.selectedProjectPath);
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          break;

        case 'projectDeliveryLoaded':
          currentProjects.portfolio = (currentProjects.portfolio || []).map(project => (
            project.path === message.projectPath ? { ...project, delivery: message.delivery, deliverySignal: deliverySignalText(message.delivery) } : project
          ));
          if (message.projectPath === currentProjects.selectedProjectPath) {
            deliveryActionMessage = '';
          }
          renderGlobalFocus(currentProjects.portfolio, currentProjects.selectedProjectPath);
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          break;

        case 'projectRefreshCompleted':
          projectRefreshPaths.delete(message.projectPath || '');
          if (message.projectPath === currentProjects.selectedProjectPath) {
            deliveryActionMessage = message.success ? t('refreshProjectDataDone') : (message.message || '');
          }
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          break;

        case 'cliTestResult':
          cliTestBadge.style.display = 'block';
          if (message.success) {
            cliTestBadge.className = 'cli-badge success';
            cliTestBadge.textContent = t('connectionOk') + message.message;
          } else {
            cliTestBadge.className = 'cli-badge error';
            cliTestBadge.textContent = t('connectionFailed') + message.message;
          }
          break;

        case 'dependenciesChecked':
          renderDependencyStatus(message.status || {});
          break;

        case 'agentImpactLoaded':
          renderAgentImpact(message.status || {});
          break;

        case 'dailyReviewLoaded':
          currentDailyReview = message.review || null;
          renderGlobalFocus(currentProjects.portfolio, currentProjects.selectedProjectPath);
          break;

        case 'skillInstallResult':
          if (abilityActionBadge) {
            abilityActionBadge.style.display = 'block';
            abilityActionBadge.className = message.success ? 'cli-badge success' : 'cli-badge error';
            abilityActionBadge.textContent = message.message || '';
          }
          if (message.settings) renderAbilitiesAndEnhancements(message.settings);
          break;
        case 'mcpInstallResult':
          if (abilityActionBadge) {
            abilityActionBadge.style.display = 'block';
            abilityActionBadge.className = message.success ? 'cli-badge success' : 'cli-badge error';
            abilityActionBadge.textContent = message.message || '';
          }
          if (message.settings) renderAbilitiesAndEnhancements(message.settings);
          break;
        case 'enhancementInstallResult':
          if (abilityActionBadge) {
            abilityActionBadge.style.display = 'block';
            abilityActionBadge.className = message.success ? 'cli-badge success' : 'cli-badge error';
            abilityActionBadge.textContent = message.message || '';
          }
          if (message.settings) renderAbilitiesAndEnhancements(message.settings);
          break;
        case 'soloSupplementFilesSelected':
          if (message.targetId) {
            if (String(message.targetId).startsWith('solo:')) {
              projectSoloFiles[message.targetId] = mergeAttachmentFiles(projectSoloFiles[message.targetId] || [], message.files || []);
            } else {
              const input = portfolioList.querySelector('[data-project-conversation-input]');
              projectContinueDrafts[message.targetId] = input ? input.value : (projectContinueDrafts[message.targetId] || '');
              projectContinueFiles[message.targetId] = mergeAttachmentFiles(projectContinueFiles[message.targetId] || [], message.files || []);
            }
            renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          }
          break;

        case 'pastedAttachmentsSaved':
          if (message.targetId && String(message.targetId).startsWith('solo:')) {
            projectSoloFiles[message.targetId] = mergeAttachmentFiles(projectSoloFiles[message.targetId] || [], message.files || []);
            renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          } else if (message.targetId) {
            const input = portfolioList.querySelector('[data-project-conversation-input]');
            projectContinueDrafts[message.targetId] = input ? input.value : (projectContinueDrafts[message.targetId] || '');
            projectContinueFiles[message.targetId] = mergeAttachmentFiles(projectContinueFiles[message.targetId] || [], message.files || []);
            renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          }
          break;

        case 'sidebarSoloConversationLoaded':
          if (message.projectPath !== currentProjects.selectedProjectPath) return;
          sidebarSoloConversations = message.conversations || [];
          for (const k in sidebarExpandedConversations) delete sidebarExpandedConversations[k];
          for (const k in sidebarLogsExpandedConversations) delete sidebarLogsExpandedConversations[k];
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          break;

        case 'sidebarStepConversationLoaded': {
          if (message.projectPath !== currentProjects.selectedProjectPath) return;
          const key = stepConversationKey(message.projectPath, message.nodeId);
          sidebarStepConversations[key] = message.conversations || [];
          sidebarStepConversationRequested[key] = true;
          for (const k in sidebarExpandedConversations) delete sidebarExpandedConversations[k];
          for (const k in sidebarLogsExpandedConversations) delete sidebarLogsExpandedConversations[k];
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          break;
        }

        case 'sidebarProjectConversationLoaded':
          if (message.projectPath !== currentProjects.selectedProjectPath) return;
          sidebarProjectConversations[message.projectPath] = message.conversations || [];
          sidebarProjectConversationRequested[message.projectPath] = true;
          for (const k in sidebarExpandedConversations) delete sidebarExpandedConversations[k];
          for (const k in sidebarLogsExpandedConversations) delete sidebarLogsExpandedConversations[k];
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          break;

        case 'issueDetailsLoaded':
          if (message.projectPath !== currentProjects.selectedProjectPath) return;
          issueDetails = message.ok ? { issue: message.issue, comments: message.comments || [], stale: !!message.stale } : { error: message.message || '' };
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          break;

        case 'issueActionCompleted':
          if (message.projectPath !== currentProjects.selectedProjectPath) return;
          issueActionMessage = message.message || '';
          if (message.success) {
            issueFormOpen = false;
            issueDraftTitle = '';
            quickIssueDraftTitle = '';
            issueDraftBody = '';
            issueDraftCategory = 'bug';
            issueDraftPriority = '';
            expandedIssueNumber = 0;
            issueDetails = null;
          }
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          break;
      }
    });

    // Save Settings
    btnSaveSettings.addEventListener('click', () => {
      const effectiveCliPath = getEffectiveSettingCliPath();
      vscode.postMessage({
        command: 'updateSettings',
        cliPath: effectiveCliPath,
        agentModelPreferences: agentModelPreferenceMap,
        language: getSoloSelectValue(settingLanguage),
        globalPrompt: settingGlobalPrompt.value.trim(),
        globalDataPath: settingGlobalDataPath ? settingGlobalDataPath.value.trim() : '',
        reviewerCliPath: getEffectiveReviewerCliPath(),
        collaborationReviewMode: settingCollaborationReviewMode ? getSoloSelectValue(settingCollaborationReviewMode) : 'high_risk'
      });
      settingsPanel.style.display = 'none';
      cliTestBadge.style.display = 'none';
    });

    // Test CLI connection
    btnTestCli.addEventListener('click', () => {
      cliTestBadge.style.display = 'block';
      cliTestBadge.className = 'cli-badge';
      cliTestBadge.style.background = 'rgba(255,255,255,0.05)';
      cliTestBadge.style.color = 'var(--text-muted)';
      cliTestBadge.textContent = t('testing');

      vscode.postMessage({
        command: 'testCli',
        cliPath: getEffectiveSettingCliPath()
      });
    });

    if (btnRefreshAgentImpact) {
      btnRefreshAgentImpact.addEventListener('click', () => {
        requestAgentImpact();
      });
    }


    if (btnOpenFeedback) {
      btnOpenFeedback.addEventListener('click', () => {
        vscode.postMessage({
          command: 'openFeedbackIssue',
          title: settingFeedbackTitle ? settingFeedbackTitle.value.trim() : '',
          body: settingFeedbackBody ? settingFeedbackBody.value.trim() : '',
          category: currentFeedbackType
        });
      });
    }

    const btnRateExtension = document.getElementById('btn-rate-extension');
    if (btnRateExtension) {
      btnRateExtension.addEventListener('click', () => {
        vscode.postMessage({
          command: 'openExternal',
          url: 'https://marketplace.visualstudio.com/items?itemName=SZLK.solopreneur-roadmap'
        });
      });
    }

    document.querySelectorAll('[data-feedback-type]').forEach(button => {
      button.addEventListener('click', () => {
        currentFeedbackType = button.getAttribute('data-feedback-type') || 'not_working';
        document.querySelectorAll('[data-feedback-type]').forEach(item => {
          item.classList.toggle('active', item === button);
        });
      });
    });

    btnCheckDependencies.addEventListener('click', () => {
      setDependencyPending();
      vscode.postMessage({
        command: 'checkDependencies',
        cliPath: getEffectiveSettingCliPath()
      });
    });

    btnOpenAgentCheck.addEventListener('click', () => {
      vscode.postMessage({
        command: 'openDependencyAction',
        action: 'agent-check',
        cliPath: getEffectiveSettingCliPath()
      });
    });

    btnOpenAgentInstall.addEventListener('click', () => {
      vscode.postMessage({
        command: 'openDependencyAction',
        action: 'agent-install',
        cliPath: getEffectiveSettingCliPath()
      });
    });

    if (btnPrepareAgentAutomation) {
      btnPrepareAgentAutomation.addEventListener('click', () => {
        vscode.postMessage({
          command: 'prepareAgentAutomation',
          cliPath: getEffectiveSettingCliPath()
        });
      });
    }

    btnOpenGithubAuth.addEventListener('click', () => {
      vscode.postMessage({
        command: 'openDependencyAction',
        action: 'github-auth',
        cliPath: getEffectiveSettingCliPath()
      });
    });

    btnOpenStrategyPyramid.addEventListener('click', () => {
      vscode.postMessage({ command: 'showStrategyPyramid' });
    });

    bindSoloSelect(projectSelect, (value) => {
      activateProjectInSidebar(value);
      vscode.postMessage({
        command: 'selectProject',
        projectPath: value
      });
    });

    btnAddProject.addEventListener('click', () => {
      vscode.postMessage({ command: 'addProject' });
    });

    function setDependencyPending() {
      setText('dependency-agent-message', t('testing'));
      setText('dependency-automation-message', t('testing'));
      setText('dependency-github-message', t('testing'));
      const agentStatus = document.getElementById('dependency-agent-status');
      const automationStatus = document.getElementById('dependency-automation-status');
      const githubStatus = document.getElementById('dependency-github-status');
      [agentStatus, automationStatus, githubStatus].forEach(item => {
        if (!item) return;
        item.className = 'dependency-status';
        item.textContent = t('checkDependencies');
      });
    }

    function requestAgentImpact() {
      setAgentImpactPending();
      vscode.postMessage({
        command: 'getAgentImpact',
        cliPath: getEffectiveSettingCliPath()
      });
    }

    function setAgentImpactPending() {
      setText('impact-minutes', '...');
      setText('impact-files', '...');
      setText('impact-progress', '...');
      if (agentImpactList) {
        agentImpactList.innerHTML = '<div class="impact-agent-detail">' + escapeHtml(t('impactLoading')) + '</div>';
      }
    }

    function readClipboardImage(file) {
      return new Promise((resolve) => {
        if (typeof FileReader === 'undefined' || !file) {
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve({
          name: file.name || 'pasted-image',
          mimeType: file.type || 'image/png',
          dataUrl: String(reader.result || '')
        });
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
    }

    function bindPastedImageAttachments(input, targetId, getProjectPath, scope) {
      if (!input || input.getAttribute('data-paste-image-bound') === 'true') return;
      input.setAttribute('data-paste-image-bound', 'true');
      input.addEventListener('paste', async (event) => {
        const items = Array.from((event.clipboardData && event.clipboardData.items) || []);
        const files = items
          .filter(item => item.kind === 'file' && String(item.type || '').startsWith('image/'))
          .map(item => item.getAsFile())
          .filter(Boolean);
        if (!files.length) return;
        event.preventDefault();
        const attachments = (await Promise.all(files.map(readClipboardImage))).filter(Boolean);
        if (!attachments.length) return;
        vscode.postMessage({
          command: 'savePastedAttachments',
          projectPath: typeof getProjectPath === 'function' ? getProjectPath() : currentProjects.selectedProjectPath,
          targetId,
          scope: scope || targetId || 'conversation',
          attachments
        });
      });
    }

    function mergeAttachmentFiles(existing, incoming) {
      const seen = new Set();
      return [...(existing || []), ...(incoming || [])]
        .map(file => String(file || '').trim())
        .filter(file => {
          if (!file || seen.has(file)) return false;
          seen.add(file);
          return true;
        });
    }

    function extractPreGitHash(output) {
      const match = String(output || '').match(/SoloMapPreGitHash:\\s*([a-f0-9]+)/i);
      return match ? match[1] : '';
    }

    function formatDurationMs(durationMs) {
      if (!Number.isFinite(durationMs) || durationMs < 0) return '';
      const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
      const minutes = Math.floor(totalSeconds / 60);
      const remainder = totalSeconds % 60;
      if (minutes > 0) return minutes + 'm ' + remainder + 's';
      return remainder + 's';
    }

    function formatSoloDuration(conversation) {
      const output = String(conversation.output || '');
      const storedDuration = output.match(/Run duration ms:\\s*(\\d+)/);
      if (storedDuration) {
        return formatDurationMs(Number(storedDuration[1]));
      }
      if (conversationStatusKey(conversation.status) !== 'Running' || !conversation.timestamp) {
        return '';
      }
      return formatDurationMs(Date.now() - new Date(conversation.timestamp).getTime());
    }

    function extractNativeSessionId(output) {
      const match = String(output || '').match(/Native Agent session saved:[^\\n]*\\(([0-9a-fA-F-]{36})\\)/);
      return match ? match[1] : '';
    }

    function soloConclusion(output) {
      const match = String(output || '').match(/Agent output tail:\\n([\\s\\S]*)$/);
      if (!match || !match[1]) return '';
      return match[1]
        .split('\\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('SoloMap:'))
        .slice(-3)
        .join(' ')
        .replace(/\\s+/g, ' ')
        .slice(0, 240);
    }

    function countSoloChangedFiles(output) {
      const match = String(output || '').match(/Touched project files:\\n([\\s\\S]*?)(?:\\n\\n|$)/);
      if (!match || !match[1]) return 0;
      return match[1]
        .split('\\n')
        .map(line => line.trim())
        .filter(line => line && !line.includes('No project files') && line !== '无')
        .length;
    }

    function summarizeSoloConversation(conversation) {
      const output = String(conversation.output || '');
      const continuationFirstMessage = output.match(/Continuation first message:\\n([\\s\\S]*?)(\\n\\n|$)/);
      if (continuationFirstMessage && continuationFirstMessage[1].trim()) {
        return continuationFirstMessage[1].trim().replace(/\\s+/g, ' ').slice(0, 120);
      }
      const userMatch = output.match(/User supplement:\\n([\\s\\S]*?)(\\n\\n|$)/);
      if (userMatch && userMatch[1].trim()) {
        return userMatch[1].trim().replace(/\\s+/g, ' ').slice(0, 120);
      }
      const changedMatch = output.match(/Touched project files:\\n([\\s\\S]*?)(\\n\\n|$)/);
      if (changedMatch && changedMatch[1].trim() && !changedMatch[1].includes('No project files')) {
        return changedMatch[1].trim().replace(/\\s+/g, ' ').slice(0, 120);
      }
      const tailMatch = output.match(/Agent output tail:\\n([\\s\\S]*)$/);
      const fallback = tailMatch ? tailMatch[1] : output;
      return fallback.trim().replace(/\\s+/g, ' ').slice(0, 120) || statusText(conversationStatusKey(conversation.status));
    }

    function renderAgentImpact(status) {
      const impact = status.impact || {};
      setText('impact-minutes', String(impact.totalMinutes || 0));
      setText('impact-files', String(impact.changedFiles || 0));
      setText('impact-progress', String(impact.projectProgressPercent || 0) + '%');
      if (!agentImpactList) return;
      const agents = Array.isArray(impact.byAgent) ? impact.byAgent : [];
      if (!agents.length) {
        agentImpactList.innerHTML = '<div class="impact-agent-detail">' + escapeHtml(t('impactEmpty')) + '</div>';
        return;
      }
      agentImpactList.innerHTML = agents.map((agent) => {
        const detail = [
          (agent.runs || 0) + ' ' + t('impactRunUnit'),
          (agent.minutes || 0) + ' ' + t('impactMinuteUnit'),
          (agent.changedFiles || 0) + ' ' + t('impactFileUnit')
        ].join(' · ');
        return \`
          <div class="impact-agent-row">
            <div class="impact-agent-main">
              <div class="impact-agent-name">\${escapeHtml(agent.agent || '')}</div>
              <div class="impact-agent-detail">\${escapeHtml(detail)}</div>
            </div>
            <span class="impact-status ready">\${escapeHtml(String(agent.changedFiles || 0))}</span>
          </div>
        \`;
      }).join('');
    }

    function renderSidebarConversationCard(projectPath, nodeId, conversation, isSolo) {
      const convId = String(conversation.id || '');
      const statusKey = conversationStatusKey(conversation.status);
      const detailExpanded = !!sidebarExpandedConversations[convId];
      const logsExpanded = !!sidebarLogsExpandedConversations[convId];
      const when = conversation.timestamp ? new Date(conversation.timestamp).toLocaleString() : '';
      const duration = formatSoloDuration(conversation);
      const failureReasonMatch = String(conversation.output || '').match(new RegExp('Failure reason:\\\\n([\\\\s\\\\S]*?)(?:\\\\n\\\\n|$)'));
      const outcomeText = statusKey === 'Running' ? (isSolo ? t('stillWorking') : t('continueWorking'))
        : statusKey === 'Failed' ? (((failureReasonMatch || [])[1] || '').trim() || statusText(statusKey))
        : statusKey === 'Linked' ? t('linkedFromSolo')
        : (isSolo ? t('soloCompleted') : t('continueCompleted'));
        
      const conclusion = statusKey === 'Running' ? '' : soloConclusion(conversation.output);
      const changedCount = statusKey === 'Running' ? 0 : countSoloChangedFiles(conversation.output);
      const resultMsg = outcomeText + (changedCount ? ' ' + t('changedCount') + ': ' + changedCount + '.' : '');
      const preGitHash = statusKey === 'Running' ? '' : extractPreGitHash(conversation.output);
      const hasLogs = !!(conversation.command || conversation.output);
      const conversationNodeId = String(conversation.nodeId || nodeId || '');
      
      const rollbackBtn = preGitHash
        ? '<button class="sidebar-conv-action-btn rollback" data-rollback-hash="' + escapeHtml(preGitHash) + '" data-rollback-node-id="' + escapeHtml(conversationNodeId) + '" data-is-solo="' + isSolo + '" data-rollback-sidebar-solo-hash="' + escapeHtml(preGitHash) + '" data-rollback-sidebar-step-hash="' + escapeHtml(preGitHash) + '" title="撤销本次修改"><span class="codicon codicon-discard"></span> 撤销修改</button>'
        : '';
        
      const continueBtn = statusKey !== 'Running' && extractNativeSessionId(conversation.output)
        ? '<button class="sidebar-conv-action-btn continue" data-continue-id="' + escapeHtml(convId) + '" data-continue-node-id="' + escapeHtml(conversationNodeId) + '" data-is-solo="' + isSolo + '" data-continue-sidebar-solo-id="' + escapeHtml(convId) + '" data-continue-sidebar-step-id="' + escapeHtml(convId) + '" data-continue-sidebar-step-node-id="' + escapeHtml(conversationNodeId) + '" title="' + escapeHtml(t('continueNative')) + '"><span class="codicon codicon-play"></span> ' + escapeHtml(t('continueNative')) + '</button>'
        : '';
        
      const stopBtn = statusKey === 'Running'
        ? '<button class="sidebar-conv-action-btn stop" data-stop-id="' + escapeHtml(convId) + '" data-stop-node-id="' + escapeHtml(conversationNodeId) + '" data-is-solo="' + isSolo + '" data-stop-sidebar-solo-id="' + escapeHtml(convId) + '" data-stop-sidebar-step-id="' + escapeHtml(convId) + '" data-stop-sidebar-step-node-id="' + escapeHtml(conversationNodeId) + '" title="' + escapeHtml(t('stopRun')) + '"><span class="codicon codicon-debug-stop"></span> ' + escapeHtml(t('stopRun')) + '</button>'
        : '';

      const fullSummary = summarizeSoloConversation(conversation);
      const shortSummary = fullSummary.length > 28 ? fullSummary.substring(0, 26) + '...' : fullSummary;
      
      const statusClassName = statusClass(statusKey).toLowerCase();
      let statusDotClass = 'status-dot-' + statusClassName;
      if (statusKey === 'Running') {
        statusDotClass += ' status-dot-running-glow';
      }

      let miniActions = '<div class="sidebar-conversation-mini-actions">';
      if (stopBtn) {
        miniActions += '<span class="mini-btn-stop" data-stop-id="' + escapeHtml(convId) + '" data-stop-node-id="' + escapeHtml(conversationNodeId) + '" data-is-solo="' + isSolo + '" title="停止运行"><span class="codicon codicon-debug-stop"></span></span>';
      }
      if (!detailExpanded && rollbackBtn) {
        miniActions += '<span class="mini-btn-rollback" data-rollback-hash="' + escapeHtml(preGitHash) + '" data-rollback-node-id="' + escapeHtml(conversationNodeId) + '" data-is-solo="' + isSolo + '" title="撤销修改"><span class="codicon codicon-discard"></span></span>';
      }
      if (!detailExpanded && continueBtn) {
        miniActions += '<span class="mini-btn-continue" data-continue-id="' + escapeHtml(convId) + '" data-continue-node-id="' + escapeHtml(conversationNodeId) + '" data-is-solo="' + isSolo + '" data-continue-sidebar-solo-id="' + escapeHtml(convId) + '" data-continue-sidebar-step-id="' + escapeHtml(convId) + '" data-continue-sidebar-step-node-id="' + escapeHtml(conversationNodeId) + '" title="继续对话"><span class="codicon codicon-play"></span></span>';
      }
      miniActions += '</div>';

      return \`
        <div class="sidebar-conversation-node-wrap" data-conv-id="\${escapeHtml(convId)}">
          <div class="sidebar-conversation-card \${detailExpanded ? 'expanded' : ''}" data-card-trigger-id="\${escapeHtml(convId)}">
            
            <div class="sidebar-conversation-bullet-col">
              <span class="tree-bullet \${statusDotClass}"></span>
            </div>

            <div class="sidebar-conversation-body">
              <div class="sidebar-conversation-header-row">
                <div class="sidebar-conversation-agent-tag">\${escapeHtml(conversation.agentCli || '')}</div>
                <div class="sidebar-conversation-time-meta">\${escapeHtml(when)}</div>
                \${duration ? \`<div class="sidebar-conversation-duration-meta"><span class="codicon codicon-history"></span> \${escapeHtml(duration)}</div>\` : ''}
              </div>
              <div class="sidebar-conversation-summary-row" title="\${escapeHtml(fullSummary)}">
                \${escapeHtml(shortSummary)}
              </div>
            </div>

            <div class="sidebar-conversation-right-col">
              \${miniActions}
              <span class="status-badge-new \${statusClassName}">\${escapeHtml(conversationStatusText(statusKey))}</span>
              <span class="expand-arrow-icon codicon \${detailExpanded ? 'codicon-chevron-up' : 'codicon-chevron-down'}"></span>
            </div>

          </div>

          \${detailExpanded ? \`
            <div class="sidebar-conversation-detail-panel animate-fade-in">
              <div class="detail-item-outcome \${statusClassName}">
                <strong>\${escapeHtml(statusKey === 'Failed' ? t('failureLabel') : t('runResult'))}:</strong>
                <span>\${escapeHtml(resultMsg)}</span>
              </div>

              \${conclusion ? \`
                <div class="detail-item-conclusion">
                  <span class="codicon codicon-quote"></span>
                  <div class="conclusion-content">
                    <strong>\${escapeHtml(t('agentConclusion'))}:</strong>
                    <p>\${escapeHtml(conclusion)}</p>
                  </div>
                </div>
              \` : ''}

              \${rollbackBtn || continueBtn || stopBtn ? \`
                <div class="sidebar-conversation-large-actions">
                  \${stopBtn}
                  \${rollbackBtn}
                  \${continueBtn}
                </div>
              \` : ''}

              \${hasLogs ? \`
                <div class="sidebar-conversation-logs-toggle-row">
                  <button class="logs-toggle-btn \${logsExpanded ? 'active' : ''}" data-logs-toggle-id="\${escapeHtml(convId)}">
                    <span class="codicon \${logsExpanded ? 'codicon-eye-closed' : 'codicon-eye'}"></span>
                    <span>\${logsExpanded ? '隐藏执行明细日志' : '查看执行明细日志 (Command & Output)'}</span>
                  </button>
                </div>
                \${logsExpanded ? \`
                  <div class="sidebar-conversation-logs-container animate-slide-down">
                    \${conversation.command ? \`
                      <div class="log-block-title">执行命令</div>
                      <pre class="log-pre command-pre">\${escapeHtml(conversation.command)}</pre>
                    \` : ''}
                    \${conversation.output ? \`
                      <div class="log-block-title">控制台输出</div>
                      <pre class="log-pre output-pre">\${escapeHtml(conversation.output)}</pre>
                    \` : ''}
                  </div>
                \` : ''}
              \` : ''}
            </div>
          \` : ''}

        </div>
      \`;
    }

    function renderSidebarSoloHistoryContent() {
      if (!sidebarSoloConversations || sidebarSoloConversations.length === 0) {
        return '<div class="sidebar-solo-history-title">' + escapeHtml(t('soloHistory')) + '</div><div class="sidebar-solo-empty">' + escapeHtml(t('noSoloConversations')) + '</div>';
      }
      const latest = sidebarSoloConversations[0];
      if (!latest) {
        return '<div class="sidebar-solo-history-title">' + escapeHtml(t('soloHistory')) + '</div><div class="sidebar-solo-empty">' + escapeHtml(t('noSoloConversations')) + '</div>';
      }
      
      const projectPath = currentProjects.selectedProjectPath || '';
      const cardHtml = renderSidebarConversationCard(projectPath, '__solo__', latest, true);
      
      return \`
        <div class="sidebar-solo-history-title">\${escapeHtml(t('soloHistory'))}</div>
        <div class="sidebar-conversation-latest-container">
          \${cardHtml}
        </div>
      \`;
    }

    function renderSidebarStepHistoryContent(projectPath, node) {
      const key = String(projectPath || '');
      const conversations = sidebarProjectConversations[key] || [];
      if (!conversations || conversations.length === 0) {
        return '<div class="sidebar-solo-history-title">' + escapeHtml(t('continueHistory')) + '</div><div class="sidebar-solo-empty">' + escapeHtml(t('noContinueConversations')) + '</div>';
      }
      const latest = latestSidebarProjectConversation(conversations);
      if (!latest) {
        return '<div class="sidebar-solo-history-title">' + escapeHtml(t('continueHistory')) + '</div><div class="sidebar-solo-empty">' + escapeHtml(t('noContinueConversations')) + '</div>';
      }

      const nodeId = String(node?.id || '');
      const cardHtml = renderSidebarConversationCard(projectPath, nodeId, latest, false);

      return \`
        <div class="sidebar-solo-history-title">\${escapeHtml(t('continueHistory'))}</div>
        <div class="sidebar-conversation-latest-container">
          \${cardHtml}
        </div>
      \`;
    }

    function latestSidebarProjectConversation(conversations) {
      return (conversations || [])
        .filter(conversation => {
          const nodeId = String(conversation.nodeId || '');
          return nodeId && nodeId !== '__solo__' && nodeId !== '__roadmap_revision__';
        })
        .sort((a, b) => {
          const idDiff = Number(b.id || 0) - Number(a.id || 0);
          if (idDiff) return idDiff;
          return Date.parse(String(b.timestamp || '')) - Date.parse(String(a.timestamp || ''));
        })[0] || null;
    }

    function bindConversationsTree(container, projectPath, nodeId, isSolo) {
      if (!isSolo && projectPath) {
        requestSidebarProjectConversationHistory(projectPath);
      }

      container.querySelectorAll('[data-card-trigger-id]').forEach(card => {
        card.addEventListener('click', (event) => {
          if (event.target.closest('button') || event.target.closest('.sidebar-conversation-mini-actions') || event.target.closest('span.codicon')) {
            if (event.target.closest('.sidebar-conversation-mini-actions') || event.target.closest('button')) {
              return;
            }
          }
          const convId = card.getAttribute('data-card-trigger-id');
          sidebarExpandedConversations[convId] = !sidebarExpandedConversations[convId];
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
        });
      });

      container.querySelectorAll('[data-logs-toggle-id]').forEach(btn => {
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          const convId = btn.getAttribute('data-logs-toggle-id');
          sidebarLogsExpandedConversations[convId] = !sidebarLogsExpandedConversations[convId];
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
        });
      });

      container.querySelectorAll('[data-continue-id]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          const conversationId = item.getAttribute('data-continue-id');
          const targetNodeId = item.getAttribute('data-continue-node-id') || nodeId;
          if (isSolo) {
            vscode.postMessage({
              command: 'continueSoloConversation',
              projectPath,
              conversationId
            });
          } else {
            vscode.postMessage({
              command: 'continueStepConversation',
              projectPath,
              nodeId: targetNodeId,
              conversationId
            });
          }
        });
      });

      container.querySelectorAll('[data-stop-id]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          const conversationId = item.getAttribute('data-stop-id');
          const targetNodeId = item.getAttribute('data-stop-node-id') || nodeId;
          vscode.postMessage({
            command: 'stopConversation',
            projectPath,
            nodeId: isSolo ? '__solo__' : targetNodeId,
            conversationId
          });
        });
      });

      container.querySelectorAll('[data-rollback-hash]').forEach(item => {
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          const gitHash = item.getAttribute('data-rollback-hash');
          const targetNodeId = item.getAttribute('data-rollback-node-id') || nodeId;
          vscode.postMessage({
            command: 'rollbackChanges',
            projectPath,
            nodeId: isSolo ? '__solo__' : targetNodeId,
            gitHash
          });
        });
      });
    }

    function formatRelativeTime(value) {
      if (!value) return '';
      const time = new Date(value).getTime();
      if (Number.isNaN(time)) return '';
      const diffMinutes = Math.max(0, Math.round((Date.now() - time) / 60000));
      if (diffMinutes < 1) return currentLanguage === 'zh' ? '刚刚' : 'just now';
      if (diffMinutes < 60) return currentLanguage === 'zh' ? (diffMinutes + ' 分钟前') : (diffMinutes + 'm');
      const diffHours = Math.round(diffMinutes / 60);
      if (diffHours < 24) return currentLanguage === 'zh' ? (diffHours + ' 小时前') : (diffHours + 'h');
      const diffDays = Math.round(diffHours / 24);
      return currentLanguage === 'zh' ? (diffDays + ' 天前') : (diffDays + 'd');
    }

    function shouldShowPortfolioProject(project) {
      if (activePortfolioFilter === 'failed') {
        return Number(project.failedNodes || 0) > 0;
      }
      if (activePortfolioFilter === 'completed') {
        return Number(project.totalNodes || 0) > 0 && project.overallStatus === 'Completed';
      }
      if (activePortfolioFilter === 'active') {
        return project.overallStatus === 'Running' || project.overallStatus === 'In Progress' || Number(project.failedNodes || 0) > 0;
      }
      return true;
    }

    function dependenciesSatisfied(node, nodes) {
      const completedIds = new Set((nodes || []).filter(candidate => candidate.status === 'Completed').map(candidate => String(candidate.id)));
      const dependencies = String(node.dependencies || '')
        .split(',')
        .map(dependency => dependency.trim())
        .filter(Boolean);
      return dependencies.every(dependency => completedIds.has(dependency));
    }

    function getNextActionNode(nodes) {
      if (!nodes || nodes.length === 0) return null;
      const byStatus = status => nodes.find(node => node.status === status);
      return byStatus('Running')
        || byStatus('Failed')
        || byStatus('In Progress')
        || nodes.find(node => node.status === 'Pending' && dependenciesSatisfied(node, nodes))
        || byStatus('Pending')
        || nodes.find(node => node.status !== 'Completed')
        || nodes[0];
    }

    function getNextActionReason(node, nodes) {
      if (!node) return '';
      if (node.status === 'Running') return t('nextActionReasonRunning');
      if (node.status === 'Failed') return t('nextActionReasonFailed');
      if (node.status === 'In Progress') return t('nextActionReasonInProgress');
      if (node.status === 'Pending') return t('nextActionReasonPending');
      if ((nodes || []).every(candidate => candidate.status === 'Completed')) return t('nextActionReasonComplete');
      return t('nextActionReasonPending');
    }

    function projectTypeLabel(value) {
      const labels = currentLanguage === 'zh'
        ? {
          core_product: '核心产品',
          infra: '基础设施',
          content: '内容产品',
          experiment: '试验研究',
          tool: '工具脚手架',
          daily_work: '日常工作处理',
          archive: '归档维护'
        }
        : {
          core_product: 'Core product',
          infra: 'Infrastructure',
          content: 'Content product',
          experiment: 'Experiment',
          tool: 'Tooling',
          daily_work: 'Daily work',
          archive: 'Maintenance'
        };
      return labels[String(value || '')] || value || '-';
    }

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function closeSoloSelects(except) {
      document.querySelectorAll('[data-solo-select]').forEach(select => {
        if (select !== except) {
          select.classList.remove('open');
          const trigger = select.querySelector('[data-solo-trigger]');
          if (trigger) trigger.setAttribute('aria-expanded', 'false');
        }
      });
    }

    function setSoloSelectValue(select, value) {
      if (!select) return;
      const choices = Array.from(select.querySelectorAll('[data-solo-option-value]'));
      const selected = choices.find(choice => choice.getAttribute('data-solo-option-value') === String(value || '')) || choices[0];
      const selectedValue = selected ? selected.getAttribute('data-solo-option-value') || '' : '';
      select.setAttribute('data-value', selectedValue);
      const label = select.querySelector('[data-solo-label]');
      if (label) label.textContent = selected ? selected.textContent || '' : '';
      choices.forEach(choice => choice.setAttribute('aria-selected', choice === selected ? 'true' : 'false'));
    }

    function getSoloSelectValue(select) {
      return select ? select.getAttribute('data-value') || '' : '';
    }

    function setSoloSelectOptions(select, options, selectedValue) {
      const menu = select && select.querySelector('[data-solo-menu]');
      if (!menu) return;
      menu.innerHTML = (options || []).map(option => (
        '<button type="button" class="solo-select-option" data-solo-option-value="' + escapeHtml(option.value) +
        '" title="' + escapeHtml(option.title || option.label) + '" aria-selected="false">' +
        escapeHtml(option.label) + '</button>'
      )).join('');
      setSoloSelectValue(select, selectedValue);
    }

    function renderProjects(projects, selectedProjectPath) {
      const options = (projects || []).map(project => ({
        value: project.path || '',
        label: project.name || project.path || t('project'),
        title: project.path || project.name || ''
      })).filter(option => option.value);
      setSoloSelectOptions(projectSelect, options, selectedProjectPath || (options[0] ? options[0].value : ''));
    }

    function renderPortfolioFilters() {
      if (!portfolioFilters) return;
      const filters = [
        { key: 'all', label: t('filterAll') },
        { key: 'active', label: t('filterActive') },
        { key: 'failed', label: t('filterFailed') },
        { key: 'completed', label: t('filterCompleted') }
      ];
      portfolioFilters.innerHTML = filters.map(filter => (
        '<button type="button" class="portfolio-filter-btn ' + (activePortfolioFilter === filter.key ? 'active' : '') +
        '" data-portfolio-filter="' + escapeHtml(filter.key) + '">' + escapeHtml(filter.label) + '</button>'
      )).join('');
      portfolioFilters.querySelectorAll('[data-portfolio-filter]').forEach(button => {
        button.addEventListener('click', () => {
          activePortfolioFilter = button.getAttribute('data-portfolio-filter') || 'all';
          renderPortfolioFilters();
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
        });
      });
    }

    function renderSoloSelect(className, attributes, options, disabled, selectedValue) {
      const selected = options.find(option => String(option.value || '') === String(selectedValue || '')) || options[0] || { value: '', label: '' };
      const disabledClass = disabled ? ' is-disabled' : '';
      const disabledAttribute = disabled ? ' disabled' : '';
      return '<div class="solo-select ' + className + disabledClass + '" data-solo-select data-value="' + escapeHtml(selected.value) + '" ' + attributes + '>' +
        '<button type="button" class="solo-select-trigger" data-solo-trigger aria-haspopup="listbox" aria-expanded="false"' + disabledAttribute + '>' +
        '<span class="solo-select-trigger-label" data-solo-label>' + escapeHtml(selected.label) + '</span>' +
        '<span class="codicon codicon-chevron-down solo-select-caret"></span></button>' +
        '<div class="solo-select-menu" data-solo-menu role="listbox">' +
        options.map((option, index) => '<button type="button" class="solo-select-option" data-solo-option-value="' + escapeHtml(option.value) +
          '" aria-selected="' + (String(option.value || '') === String(selected.value || '') || (!selected.value && index === 0) ? 'true' : 'false') + '">' + escapeHtml(option.label) + '</button>').join('') +
        '</div></div>';
    }

    function bindSoloSelect(select, onChange) {
      if (!select || select.getAttribute('data-solo-bound') === 'true') return;
      select.setAttribute('data-solo-bound', 'true');
      select.addEventListener('click', event => {
        event.stopPropagation();
        const option = event.target.closest('[data-solo-option-value]');
        if (option) {
          const previousValue = getSoloSelectValue(select);
          setSoloSelectValue(select, option.getAttribute('data-solo-option-value'));
          select.classList.remove('open');
          const trigger = select.querySelector('[data-solo-trigger]');
          if (trigger) trigger.setAttribute('aria-expanded', 'false');
          if (onChange && previousValue !== getSoloSelectValue(select)) {
            onChange(getSoloSelectValue(select));
          }
          return;
        }
        if (event.target.closest('[data-solo-trigger]') && !select.classList.contains('is-disabled')) {
          const open = !select.classList.contains('open');
          closeSoloSelects(select);
          select.classList.toggle('open', open);
          const trigger = select.querySelector('[data-solo-trigger]');
          if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
      });
      select.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          select.classList.remove('open');
          const trigger = select.querySelector('[data-solo-trigger]');
          if (trigger) trigger.setAttribute('aria-expanded', 'false');
          return;
        }
        if ((event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') && event.target.closest('[data-solo-trigger]')) {
          event.preventDefault();
          closeSoloSelects(select);
          select.classList.add('open');
          event.target.setAttribute('aria-expanded', 'true');
        }
      });
    }

    function bindSoloSelects(container) {
      container.querySelectorAll('[data-solo-select]').forEach(select => bindSoloSelect(select));
    }

    document.addEventListener('click', () => closeSoloSelects());

    function getAgentOptions(node) {
      const options = [];
      function add(value) {
        const option = buildAgentOption(value);
        if (!option || options.some(existing => existing.label === option.label)) return;
        options.push(option);
      }
      add(getEffectiveSettingCliPath() || 'agy');
      add(node && node.agentCli);
      add('antigravity');
      add('codex');
      add('cursor');
      add('copilot');
      add('claude');
      add('opencode');
      return options;
    }

    function buildAgentOption(value) {
      const normalized = String(value || '').trim();
      const label = normalizeAgentOptionLabel(normalized);
      if (!label) return null;
      const optionValue = normalized.includes('/') || normalized.includes('\\\\') ? normalized : label;
      return { value: optionValue, label };
    }

    function normalizeAgentOptionLabel(value) {
      const normalized = String(value || '').trim();
      const name = normalized.split(/[\\\\/]/).pop().toLowerCase();
      if (name === 'codex-cli') return 'codex';
      if (name === 'solomap-codex-auto') return 'codex';
      if (name === 'cursor-cli' || name === 'cursor-agent') return 'cursor';
      if (name === 'solomap-cursor-auto') return 'cursor';
      if (name === 'copilot-cli') return 'copilot';
      if (name === 'solomap-copilot-auto') return 'copilot';
      if (name === 'agy' || name === 'antigravity-cli') return 'antigravity';
      if (name === 'solomap-antigravity-auto') return 'antigravity';
      if (name === 'claude-code' || name === 'claude-code-cli') return 'claude';
      if (name === 'solomap-claude-auto') return 'claude';
      if (name === 'open-code' || name === 'open-code-cli') return 'opencode';
      return normalized;
    }

    function projectSoloTargetId(projectPath) {
      return 'solo:' + String(projectPath || '');
    }

    function renderProjectConversationComposer(project, nodes) {
      const node = getNextActionNode(nodes || []);
      const projectPath = project.path || '';
      const mode = projectConversationModes[projectPath] || (projectSoloDrafts[projectPath] ? 'solo' : 'continue');
      const soloTargetId = projectSoloTargetId(projectPath);
      const activeMode = mode === 'flow'
        ? 'flow'
        : (mode === 'solo' || !node ? 'solo' : 'continue');
      const flowUnlocked = hasFlowPro(currentSettings || {});
      const targetId = activeMode === 'solo' ? soloTargetId : activeMode === 'flow' ? ('flow:' + projectPath) : (node ? node.id : '');
      const disabled = activeMode === 'continue' && (!node || node.status === 'Running' || node.status === 'Completed');
      const files = activeMode === 'solo' ? (projectSoloFiles[soloTargetId] || []) : (projectContinueFiles[targetId] || []);
      const draft = activeMode === 'solo'
        ? (projectSoloDrafts[projectPath] || '')
        : activeMode === 'flow'
          ? (projectContinueDrafts['flow:' + projectPath] || '')
          : (projectContinueDrafts[targetId] || '');
      const agentOptions = activeMode === 'solo'
        ? getAgentOptions({ agentCli: getEffectiveSettingCliPath() || 'agy' })
        : activeMode === 'flow'
          ? getAgentOptions({ agentCli: getEffectiveSettingCliPath() || 'agy' })
          : getAgentOptions(node);
      const modelTargetId = activeMode === 'flow' ? ('flow:' + projectPath) : targetId;
      const selectedAgentCli = projectConversationAgentSelections[modelTargetId] || ((activeMode === 'solo' || activeMode === 'flow') ? (getEffectiveSettingCliPath() || 'agy') : (node?.agentCli || getEffectiveSettingCliPath() || 'agy'));
      return \`
        <div class="portfolio-compose" data-project-continue-composer>
          <div class="portfolio-mode-toggle">
            <button class="portfolio-mode-btn \${activeMode === 'continue' ? 'active' : ''}" data-project-conversation-mode="continue" data-project-path="\${escapeHtml(projectPath)}" \${node ? '' : 'disabled'}>\${escapeHtml(t('projectModeContinue'))}</button>
            <button class="portfolio-mode-btn \${activeMode === 'solo' ? 'active' : ''}" data-project-conversation-mode="solo" data-project-path="\${escapeHtml(projectPath)}">\${escapeHtml(t('projectModeSolo'))}</button>
            <button class="portfolio-mode-btn \${activeMode === 'flow' ? 'active' : ''}" data-project-conversation-mode="flow" data-project-path="\${escapeHtml(projectPath)}">\${escapeHtml(t('projectModeFlow'))}</button>
          </div>
          \${activeMode === 'flow' && !flowUnlocked ? \`
            <div class="sidebar-solo-history">
              <div class="sidebar-solo-empty">\${escapeHtml(t('flowLocked'))}</div>
              <div class="portfolio-card-actions" style="margin-top: 10px;">
                <button class="portfolio-action-btn primary" data-open-pro-upgrade>\${escapeHtml(t('flowUnlock'))}</button>
                <button class="portfolio-action-btn" data-open-flow-view>\${escapeHtml(t('flowOpen'))}</button>
              </div>
            </div>
          \` : \`
          <div class="portfolio-compose-agent-row">
            \${renderSoloSelect('portfolio-compose-agent', 'data-project-continue-agent data-conversation-target-id="' + escapeHtml(modelTargetId) + '"', agentOptions, disabled, selectedAgentCli)}
            \${renderSoloSelect('portfolio-compose-model', 'data-project-continue-model data-conversation-target-id="' + escapeHtml(modelTargetId) + '"', getAgentModelOptions(selectedAgentCli), disabled, getTargetModelValue(modelTargetId, selectedAgentCli))}
          </div>
          <div class="portfolio-compose-row">
            <button class="portfolio-compose-tool" data-project-attach-files data-project-path="\${escapeHtml(projectPath)}" data-conversation-target-id="\${escapeHtml(targetId)}" data-conversation-mode="\${escapeHtml(activeMode)}" title="\${escapeHtml(t('soloAttach'))}"><span class="codicon codicon-attach"></span></button>
            <textarea class="portfolio-compose-input" data-project-conversation-input data-conversation-target-id="\${escapeHtml(activeMode === 'flow' ? ('flow:' + projectPath) : targetId)}" data-conversation-mode="\${escapeHtml(activeMode)}" data-project-path="\${escapeHtml(projectPath)}" placeholder="\${escapeHtml(activeMode === 'solo' ? t('soloPlaceholder') : activeMode === 'flow' ? t('flowPlaceholder') : t('continuePlaceholder'))}" \${disabled ? 'disabled' : ''}>\${escapeHtml(draft)}</textarea>
            <button class="portfolio-compose-send" data-project-continue-send data-next-node-id="\${escapeHtml(node?.id || '')}" data-project-path="\${escapeHtml(projectPath)}" data-conversation-target-id="\${escapeHtml(activeMode === 'flow' ? ('flow:' + projectPath) : targetId)}" data-conversation-mode="\${escapeHtml(activeMode)}" \${disabled ? 'disabled' : ''}>
              <span class="codicon codicon-send"></span><span>\${escapeHtml(t('continueSend'))}</span>
            </button>
          </div>
          \${renderProjectConversationFiles(targetId, files)}
          \${activeMode === 'solo' ? \`<div class="sidebar-solo-history" data-sidebar-solo-history>\${renderSidebarSoloHistoryContent()}</div>\` : ''}
          \${activeMode === 'continue' && node ? \`<div class="sidebar-solo-history" data-sidebar-step-history>\${renderSidebarStepHistoryContent(projectPath, node)}</div>\` : ''}
          \`}
        </div>
      \`;
    }

    function renderProjectConversationFiles(targetId, files) {
      if (!files || files.length === 0) return '';
      return \`
        <div class="sidebar-solo-attachments">
          \${files.map((file, index) => \`
            <span class="sidebar-solo-file" title="\${escapeHtml(file)}">
              <span class="sidebar-solo-file-name">\${escapeHtml(file)}</span>
              <button class="sidebar-solo-file-remove" data-remove-project-file="\${escapeHtml(targetId)}::\${index}" title="Remove">&times;</button>
            </span>
          \`).join('')}
        </div>
      \`;
    }

    function bindProjectContinueComposer(container) {
      container.querySelectorAll('[data-project-conversation-mode]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const projectPath = button.getAttribute('data-project-path') || '';
          const input = container.querySelector('[data-project-conversation-input]');
          if (input) {
            rememberProjectConversationInput(input);
          }
          projectConversationModes[projectPath] = button.getAttribute('data-project-conversation-mode') || 'continue';
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
        });
      });
      container.querySelectorAll('[data-project-attach-files]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const projectPath = button.getAttribute('data-project-path') || currentProjects.selectedProjectPath;
          const targetId = button.getAttribute('data-conversation-target-id') || '';
          if (!projectPath || !targetId) return;
          vscode.postMessage({ command: 'chooseSoloSupplementFiles', projectPath, targetId });
        });
      });
      container.querySelectorAll('[data-project-continue-send]').forEach(sendButton => {
        sendButton.addEventListener('click', (event) => {
          event.stopPropagation();
          const panel = sendButton.closest('[data-project-continue-composer]');
          const input = panel ? panel.querySelector('[data-project-conversation-input]') : null;
          const agentSelect = panel ? panel.querySelector('[data-project-continue-agent]') : null;
          const modelSelect = panel ? panel.querySelector('[data-project-continue-model]') : null;
          const mode = sendButton.getAttribute('data-conversation-mode') || 'continue';
          const projectPath = sendButton.getAttribute('data-project-path') || currentProjects.selectedProjectPath;
          const targetId = sendButton.getAttribute('data-conversation-target-id') || '';
          const userMessage = input ? input.value : '';
          if (mode === 'solo') {
            if (!projectPath || !userMessage.trim()) return;
            vscode.postMessage({
              command: 'runSoloConversation',
              projectPath,
              userMessage,
              agentCli: getSoloSelectValue(agentSelect),
              model: getSoloSelectValue(modelSelect),
              supplementFiles: projectSoloFiles[targetId] || []
            });
            if (input) input.value = '';
            projectSoloDrafts[projectPath] = '';
            projectSoloFiles[targetId] = [];
            requestSidebarSoloConversationHistory(projectPath, true);
            renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
            return;
          }
          if (mode === 'flow') {
            if (!projectPath || !userMessage.trim()) return;
            vscode.postMessage({
              command: 'runFlow',
              projectPath,
              goal: userMessage,
              agentCli: getSoloSelectValue(agentSelect),
              model: getSoloSelectValue(modelSelect),
              supplementFiles: projectContinueFiles['flow:' + projectPath] || []
            });
            if (input) input.value = '';
            projectContinueDrafts['flow:' + projectPath] = '';
            projectContinueFiles['flow:' + projectPath] = [];
            renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
            return;
          }
          const nodeId = sendButton.getAttribute('data-next-node-id');
          runNodeAgent(nodeId, userMessage, getSoloSelectValue(agentSelect), getSoloSelectValue(modelSelect), projectContinueFiles[nodeId] || []);
          if (input) input.value = '';
          projectContinueDrafts[nodeId] = '';
          projectContinueFiles[nodeId] = [];
          if (projectPath && nodeId) {
            requestSidebarProjectConversationHistory(projectPath, true);
          }
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
        });
      });
      container.querySelectorAll('[data-project-conversation-input], [data-project-continue-agent]').forEach(item => {
        item.addEventListener('click', (event) => event.stopPropagation());
      });
      container.querySelectorAll('[data-project-continue-agent]').forEach(select => {
        const targetId = select.getAttribute('data-conversation-target-id') || '';
        bindSoloSelect(select, (value) => {
          projectConversationAgentSelections[targetId] = value || getEffectiveSettingCliPath() || 'agy';
          setTargetModelValue(targetId, projectConversationAgentSelections[targetId], getTargetModelValue(targetId, projectConversationAgentSelections[targetId]), false);
          ensureAgentModelsLoaded(projectConversationAgentSelections[targetId], targetId);
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
        });
      });
      container.querySelectorAll('[data-project-continue-model]').forEach(select => {
        const targetId = select.getAttribute('data-conversation-target-id') || '';
        bindSoloSelect(select, (value) => {
          const cli = projectConversationAgentSelections[targetId] || getEffectiveSettingCliPath() || 'agy';
          setTargetModelValue(targetId, cli, value, true);
        });
      });
      bindSoloSelects(container);
      container.querySelectorAll('[data-project-conversation-input]').forEach(input => {
        input.addEventListener('input', () => {
          rememberProjectConversationInput(input);
        });
        const targetId = input.getAttribute('data-conversation-target-id') || '';
        bindPastedImageAttachments(input, targetId, () => currentProjects.selectedProjectPath, targetId);
        input.addEventListener('keydown', (event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            const composer = input.closest('[data-project-continue-composer]');
            const sendButton = composer ? composer.querySelector('[data-project-continue-send]') : null;
            if (sendButton) sendButton.click();
          }
        });
      });
      container.querySelectorAll('[data-remove-project-file]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const value = button.getAttribute('data-remove-project-file') || '';
          const parts = value.split('::');
          const targetId = parts[0] || '';
          const index = Number(parts[1] || 0);
          if (targetId.startsWith('solo:')) {
            projectSoloFiles[targetId] = (projectSoloFiles[targetId] || []).filter((_, fileIndex) => fileIndex !== index);
          } else {
            projectContinueFiles[targetId] = (projectContinueFiles[targetId] || []).filter((_, fileIndex) => fileIndex !== index);
          }
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
        });
      });
      container.querySelectorAll('[data-open-pro-upgrade]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({ command: 'openProAuthorization' });
        });
      });
      container.querySelectorAll('[data-open-flow-view]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({ command: 'showFlowView' });
        });
      });

      const projectPath = currentProjects.selectedProjectPath;
      if (projectPath) {
        bindConversationsTree(container, projectPath, '__solo__', true);
        const project = currentProjects.portfolio && currentProjects.portfolio.projects
          ? currentProjects.portfolio.projects.find(p => p.path === projectPath)
          : null;
        const node = project ? getNextActionNode(project.nodes || []) : null;
        if (node) {
          bindConversationsTree(container, projectPath, node.id, false);
        }
      }
    }

    function issueCategoryLabel(category) {
      if (category === 'bug') return t('issueBug');
      if (category === 'feature-request') return t('issueFeature');
      if (category === 'tech-debt') return t('issueDebt');
      if (category === 'documentation') return t('issueDocs');
      if (category === 'quick-note') return t('issueQuickNote');
      return t('issueDiscussion');
    }

    function getIssueCategories() {
      return [
        { value: 'bug', label: t('issueBug') },
        { value: 'feature-request', label: t('issueFeature') },
        { value: 'tech-debt', label: t('issueDebt') },
        { value: 'discussion', label: t('issueDiscussion') },
        { value: 'documentation', label: t('issueDocs') },
        { value: 'quick-note', label: t('issueQuickNote') }
      ];
    }

    function getIssuePriorities() {
      return [
        { value: '', label: '-' },
        { value: 'P0', label: 'P0' },
        { value: 'P1', label: 'P1' },
        { value: 'P2', label: 'P2' }
      ];
    }

    function selectFirstOption(options, selectedValue) {
      const selected = String(selectedValue || '');
      const found = (options || []).find(option => option.value === selected);
      return found ? [found, ...(options || []).filter(option => option !== found)] : options;
    }

    function renderIssueStatsLine(project) {
      const issues = project.issues || {};
      if (issues.loading) {
        return '<span class="portfolio-updated">' + escapeHtml(t('issues')) + ': ' + escapeHtml(t('issueLoading')) + '</span>';
      }
      if (!issues.available) {
        return '<span class="portfolio-updated">' + escapeHtml(t('issues')) + ': ' + escapeHtml(t('issueUnavailable')) + '</span>';
      }
      const syncText = issues.syncedAt ? ' · ' + escapeHtml(issues.stale ? t('issueCached') : t('issueSynced')) + ' ' + escapeHtml(formatRelativeTime(issues.syncedAt)) : '';
      return '<span class="portfolio-updated">' + escapeHtml(t('issues')) + ': ' + escapeHtml(t('issueTotal')) + ' ' + escapeHtml(issues.total || 0) + ' · ' + escapeHtml(t('issueOpen')) + ' ' + escapeHtml(issues.open || 0) + syncText + '</span>';
    }

    function priorityRank(priority) {
      return ({ P0: 0, P1: 1, P2: 2, P3: 3 })[priority] ?? 4;
    }

    function sortPinnedProjects(projects) {
      return (projects || []).slice().sort((a, b) => {
        const pinnedA = a && a.pinnedAt ? 1 : 0;
        const pinnedB = b && b.pinnedAt ? 1 : 0;
        if (pinnedA !== pinnedB) return pinnedB - pinnedA;
        if ((a && a.pinnedAt) || (b && b.pinnedAt)) {
          return String((b && b.pinnedAt) || '').localeCompare(String((a && a.pinnedAt) || ''));
        }
        return 0;
      });
    }

    function applyLocalPinnedState(projectPath) {
      const now = new Date().toISOString();
      const toggle = project => {
        if (!project || project.path !== projectPath) return project;
        if (project.pinnedAt) {
          const next = { ...project };
          delete next.pinnedAt;
          return next;
        }
        return { ...project, pinnedAt: now };
      };
      currentProjects.projects = sortPinnedProjects((currentProjects.projects || []).map(toggle));
      currentProjects.portfolio = sortPinnedProjects((currentProjects.portfolio || []).map(toggle));
    }

    function daysUntilMonthEnd(date) {
      const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
      return end.getDate() - date.getDate();
    }

    function getTodayWorkRhythm(date) {
      const current = date || new Date();
      const day = current.getDay();
      if (daysUntilMonthEnd(current) <= 2) return 'monthEnd';
      if (day === 1) return 'monday';
      if (day === 5) return 'friday';
      return 'daily';
    }

    function todayWorkRhythmLabel(rhythm) {
      if (rhythm === 'monthEnd') return t('todayRhythmMonthEnd');
      if (rhythm === 'monday') return t('todayRhythmMonday');
      if (rhythm === 'friday') return t('todayRhythmFriday');
      return t('todayRhythmDaily');
    }

    function isNewProjectStart(project) {
      return Number(project.progressPercent || 0) <= 0 && Number(project.completedNodes || 0) <= 0 && Number(project.pendingNodes || 0) > 0;
    }

    function hasCloseoutValue(project) {
      return Number(project.reusableSignals || 0) > 0 || project.overallStatus === 'Completed' || !!project.stageGap;
    }

    function todayPlanScore(project) {
      let score = 0;
      const rhythm = getTodayWorkRhythm();
      if (Number(project.delivery && project.delivery.failedWorkflowRuns || 0) > 0) score += 120;
      if (Number(project.failedNodes || 0) > 0) score += 100;
      if (Number(((project.issues || {}).byPriority || {}).P0 || 0) > 0) score += 90;
      if (project.globalPriority === 'P0') score += 80;
      if (project.globalPriority === 'P1') score += 60;
      if (Number(project.runningNodes || 0) > 0) score += 50;
      if (Number(project.inProgressNodes || 0) > 0) score += 40;
      if (Number(project.pendingNodes || 0) > 0) score += 20;
      if (Number(project.reusableSignals || 0) > 0) score += 10;
      if (isNewProjectStart(project)) score += rhythm === 'monday' ? 35 : 12;
      if (rhythm === 'monday' && project.globalPriority === 'P1') score += 35;
      if (rhythm === 'monday' && Number(project.pendingNodes || 0) > 0) score += 10;
      if (rhythm === 'friday' && hasCloseoutValue(project)) score += 45;
      if (rhythm === 'friday' && Number(project.inProgressNodes || 0) > 0) score += 15;
      if (rhythm === 'monthEnd' && hasCloseoutValue(project)) score += 55;
      if (rhythm === 'monthEnd' && (project.globalPriority === 'P0' || project.blocker)) score += 20;
      return score;
    }

    function todayPlanReason(project) {
      const rhythm = getTodayWorkRhythm();
      if (Number(project.delivery && project.delivery.failedWorkflowRuns || 0) > 0) return t('todayReasonDelivery');
      if (Number(project.failedNodes || 0) > 0) return t('todayReasonFailed');
      if (Number(((project.issues || {}).byPriority || {}).P0 || 0) > 0) return t('todayReasonIssue');
      if (rhythm === 'monthEnd' && hasCloseoutValue(project)) return t('todayReasonMonthReview');
      if (rhythm === 'friday' && hasCloseoutValue(project)) return t('todayReasonFridayLearning');
      if (rhythm === 'monday' && (project.globalPriority === 'P1' || isNewProjectStart(project))) return t('todayReasonWeeklyFocus');
      if (isNewProjectStart(project)) return t('todayReasonNewProject');
      if (Number(project.runningNodes || 0) > 0) return t('todayReasonRunning');
      if (Number(project.inProgressNodes || 0) > 0) return t('todayReasonInProgress');
      if (Number(project.reusableSignals || 0) > 0) return t('todayReasonReusable');
      if (Number(project.pendingNodes || 0) > 0) return t('todayReasonPending');
      return t('todayReasonReview');
    }

    function buildTodayPlanItems(portfolio) {
      const projects = (portfolio || [])
        .filter(project => project && project.path)
        .slice()
        .sort((a, b) => todayPlanScore(b) - todayPlanScore(a) || priorityRank(a.globalPriority) - priorityRank(b.globalPriority));
      const used = new Set();
      const take = (slot, predicate) => {
        const project = projects.find(candidate => !used.has(candidate.path) && predicate(candidate));
        if (!project) return null;
        used.add(project.path);
        return { slot, project };
      };
      return [
        take(t('todaySlotUrgent'), project => Number(project.delivery && project.delivery.failedWorkflowRuns || 0) > 0 || Number(project.failedNodes || 0) > 0 || Number(((project.issues || {}).byPriority || {}).P0 || 0) > 0 || project.globalPriority === 'P0'),
        take(t('todaySlotMain'), project => project.globalPriority === 'P1' || Number(project.runningNodes || 0) > 0 || Number(project.inProgressNodes || 0) > 0 || Number(project.pendingNodes || 0) > 0),
        take(t('todaySlotClose'), project => Number(project.reusableSignals || 0) > 0 || project.overallStatus === 'Completed' || project.stageGap)
      ].filter(Boolean).concat(
        projects
          .filter(project => !used.has(project.path))
          .slice(0, 3)
          .map((project, index) => ({ slot: index === 0 ? t('todaySlotMain') : t('todaySlotClose'), project }))
      ).slice(0, 3);
    }

    function startDailyReviewPolling() {
      if (dailyReviewPollTimer) {
        clearTimeout(dailyReviewPollTimer);
        dailyReviewPollTimer = null;
      }
      if (!currentDailyReview || currentDailyReview.status !== 'running') return;
      dailyReviewPollTimer = setTimeout(() => {
        vscode.postMessage({ command: 'getDailyReview' });
      }, 2500);
    }

    function renderDailyReview(review) {
      if (!review) return '';
      if (review.status === 'running') {
        return '<div class="daily-review-panel"><div class="daily-review-summary">' + escapeHtml(t('dailyReviewRunning')) + '</div></div>';
      }
      if (review.status === 'failed') {
        return '<div class="daily-review-panel"><div class="daily-review-summary">' + escapeHtml(review.error || t('dailyReviewFailed')) + '</div></div>';
      }
      const todos = Array.isArray(review.todos) ? review.todos.slice(0, 5) : [];
      const confirmations = Array.isArray(review.needsConfirmation) ? review.needsConfirmation.slice(0, 3) : [];
      if (!todos.length && !confirmations.length && !review.summary) return '';
      return \`
        <div class="daily-review-panel">
          \${review.summary ? \`<div class="daily-review-summary">\${escapeHtml(review.summary)}</div>\` : ''}
          \${todos.length ? \`
            <div class="daily-review-list">
              \${todos.map((todo, index) => \`
                <div class="daily-review-item" data-daily-review-index="\${index}">
                  <div class="daily-review-title">\${escapeHtml(todo.title || '')}</div>
                  <div class="daily-review-reason">\${escapeHtml(todo.reason || '')}</div>
                </div>
              \`).join('')}
            </div>
          \` : ''}
          \${confirmations.length ? \`
            <div class="daily-review-summary">\${escapeHtml(t('dailyReviewConfirm'))}</div>
            <div class="daily-review-list">
              \${confirmations.map((todo, index) => \`
                <div class="daily-review-item" data-daily-confirm-index="\${index}">
                  <div class="daily-review-title">\${escapeHtml(todo.title || '')}</div>
                  <div class="daily-review-reason">\${escapeHtml(todo.reason || '')}</div>
                </div>
              \`).join('')}
            </div>
          \` : ''}
        </div>
      \`;
    }

    function openDailyReviewTarget(item) {
      const projectPath = item && item.projectPath ? String(item.projectPath) : '';
      if (!projectPath) return;
      activateProjectInSidebar(projectPath);
      vscode.postMessage({ command: 'selectProject', projectPath });
      if (item.nodeId) {
        vscode.postMessage({ command: 'showFullRoadmap' });
      }
    }

    function renderGlobalFocus(portfolio, selectedProjectPath) {
      if (!globalFocusPanel) return;
      const items = buildTodayPlanItems(portfolio);
      const store = currentProjects.globalStore || {};
      const rhythm = getTodayWorkRhythm();
      if (!items.length) {
        globalFocusPanel.innerHTML = \`
          <div class="global-focus-head">
            <span class="global-focus-title"><span class="codicon codicon-target"></span>\${escapeHtml(t('globalFocusTitle'))}</span>
          </div>
          <div class="empty-portfolio">\${escapeHtml(t('globalFocusEmpty'))}</div>
        \`;
        return;
      }
      globalFocusPanel.innerHTML = \`
        <div class="global-focus-head">
          <span class="global-focus-title"><span class="codicon codicon-target"></span>\${escapeHtml(t('globalFocusTitle'))}</span>
          <button class="global-review-btn" type="button" data-run-daily-review \${currentDailyReview && currentDailyReview.status === 'running' ? 'disabled' : ''}><span class="codicon codicon-sparkle"></span>\${escapeHtml(t('dailyReviewButton'))}</button>
        </div>
        <div class="global-focus-list">
          \${items.map(item => \`
            <div class="global-focus-item \${item.project.path === selectedProjectPath ? 'is-selected' : ''}" data-global-focus-project="\${escapeHtml(item.project.path)}">
              <div class="global-focus-row">
                <span class="global-focus-main">
                  <span class="global-focus-name">\${escapeHtml(item.project.name || '')}</span>
                  <span class="global-focus-action">\${escapeHtml(todayPlanReason(item.project))} · \${escapeHtml(item.project.blocker || item.project.globalNextAction || item.project.recommendedNodeTitle || '-')}</span>
                </span>
                <span class="global-focus-slot">\${escapeHtml(item.slot)}</span>
                <span class="global-priority \${escapeHtml(item.project.globalPriority || 'P2')}">\${escapeHtml(item.project.globalPriority || 'P2')}</span>
              </div>
            </div>
          \`).join('')}
        </div>
        <div class="global-focus-foot">
          <span class="global-chip">\${escapeHtml(todayWorkRhythmLabel(rhythm))}</span>
          <span class="global-chip">\${escapeHtml(t('globalLearning'))}: \${escapeHtml(store.learningCandidateCount || 0)}</span>
          <span class="global-chip">\${escapeHtml(t('globalDependencies'))}: \${escapeHtml((store.dependencies || []).length || 0)}</span>
        </div>
        \${renderDailyReview(currentDailyReview)}
      \`;
      const reviewButton = globalFocusPanel.querySelector('[data-run-daily-review]');
      if (reviewButton) {
        reviewButton.addEventListener('click', () => {
          currentDailyReview = {
            status: 'running',
            summary: '',
            todos: [],
            needsConfirmation: []
          };
          renderGlobalFocus(currentProjects.portfolio, currentProjects.selectedProjectPath);
          vscode.postMessage({ command: 'runDailyReview' });
          startDailyReviewPolling();
        });
      }
      globalFocusPanel.querySelectorAll('[data-global-focus-project]').forEach(item => {
        item.addEventListener('click', () => {
          const projectPath = item.getAttribute('data-global-focus-project') || '';
          if (projectPath === currentProjects.selectedProjectPath) return;
          activateProjectInSidebar(projectPath);
          vscode.postMessage({
            command: 'selectProject',
            projectPath
          });
        });
      });
      globalFocusPanel.querySelectorAll('[data-daily-review-index]').forEach(item => {
        item.addEventListener('click', () => {
          const index = Number(item.getAttribute('data-daily-review-index') || 0);
          openDailyReviewTarget((currentDailyReview && currentDailyReview.todos || [])[index]);
        });
      });
      globalFocusPanel.querySelectorAll('[data-daily-confirm-index]').forEach(item => {
        item.addEventListener('click', () => {
          const index = Number(item.getAttribute('data-daily-confirm-index') || 0);
          openDailyReviewTarget((currentDailyReview && currentDailyReview.needsConfirmation || [])[index]);
        });
      });
      startDailyReviewPolling();
    }

    function renderOnboardingPanel() {
      return \`
        <div class="onboarding-panel">
          <div class="onboarding-kicker"><span class="codicon codicon-compass"></span>\${escapeHtml(t('onboardingKicker'))}</div>
          <div class="onboarding-title">\${escapeHtml(t('onboardingTitle'))}</div>
          <div class="onboarding-copy">\${escapeHtml(t('onboardingCopy'))}</div>
          <div class="onboarding-steps">
            <div class="onboarding-step"><span class="onboarding-step-index">1</span><span>\${escapeHtml(t('onboardingStepProject'))}</span></div>
            <div class="onboarding-step"><span class="onboarding-step-index">2</span><span>\${escapeHtml(t('onboardingStepType'))}</span></div>
            <div class="onboarding-step"><span class="onboarding-step-index">3</span><span>\${escapeHtml(t('onboardingStepRoadmap'))}</span></div>
          </div>
          <button class="onboarding-action" data-onboarding-add-project>
            <span class="codicon codicon-add"></span>\${escapeHtml(t('onboardingAction'))}
          </button>
        </div>
      \`;
    }

    function renderProjectIssuePanel(project) {
      const issues = project.issues || {};
      const expanded = issuePanelExpanded || issueFormOpen || expandedIssueNumber;
      const issueHead = \`
        <div class="portfolio-issue-head">
          <span class="portfolio-issue-title"><span class="codicon codicon-issues"></span>\${escapeHtml(t('issues'))}</span>
          <div class="portfolio-issue-actions">
            \${!expanded ? \`<input type="text" class="portfolio-quick-issue-input" placeholder="\${escapeHtml(t('quickIssuePlaceholder'))}" value="\${escapeHtml(quickIssueDraftTitle)}" data-quick-issue-input data-project-path="\${escapeHtml(project.path)}" />\` : ''}
            \${expanded ? \`<button class="portfolio-issue-create" data-toggle-issue-form data-project-path="\${escapeHtml(project.path)}"><span class="codicon codicon-add"></span>\${escapeHtml(t('issueCreate'))}</button>\` : ''}
            <button class="delivery-toggle-btn" data-toggle-issue-panel data-project-path="\${escapeHtml(project.path)}" title="\${escapeHtml(expanded ? t('issueCollapse') : t('issueExpand'))}">
              <span class="codicon codicon-chevron-\${expanded ? 'up' : 'down'}"></span>
            </button>
          </div>
        </div>
      \`;
      if (!expanded) {
        return \`
          <div class="portfolio-issue-panel" data-issue-panel>
            \${issueHead}
          </div>
        \`;
      }
      if (issues.loading) {
        return \`
          <div class="portfolio-issue-panel" data-issue-panel>
            \${issueHead}
            <div class="portfolio-issue-empty">\${escapeHtml(t('issueLoading'))}</div>
            \${issueFormOpen ? renderIssueCreateForm(project.path) : ''}
          </div>
        \`;
      }
      if (!issues.available) {
        return \`
          <div class="portfolio-issue-panel" data-issue-panel>
            \${issueHead}
            <div class="portfolio-issue-empty">\${escapeHtml(t('issueUnavailable'))}</div>
            \${issueFormOpen ? renderIssueCreateForm(project.path) : ''}
          </div>
        \`;
      }
      const categoryTags = getIssueCategories()
        .map(item => \`<span class="portfolio-issue-tag"><span>\${escapeHtml(item.label)}</span><strong>\${escapeHtml(Number((issues.byCategory || {})[item.value] || 0))}</strong></span>\`)
        .join('');
      const priorityPills = ['P0', 'P1', 'P2']
        .map(priority => ({ priority, count: Number((issues.byPriority || {})[priority] || 0) }))
        .filter(item => item.count > 0)
        .map(item => \`<span class="portfolio-issue-pill">\${escapeHtml(item.priority)} \${escapeHtml(item.count)}</span>\`)
        .join('');
      const issueRows = (issues.items || []).map(issue => \`
        <button class="portfolio-issue-row" data-expand-issue-number="\${escapeHtml(issue.number)}" data-project-path="\${escapeHtml(project.path)}">
          <span class="portfolio-issue-main">
            <span class="portfolio-issue-name">#\${escapeHtml(issue.number)} \${escapeHtml(issue.title || '')}</span>
            <span class="portfolio-issue-sub">\${escapeHtml(issue.priority || issueCategoryLabel(issue.category))} · \${escapeHtml(issueCategoryLabel(issue.category))} · \${escapeHtml(issue.comments || 0)} \${escapeHtml(t('issueComments'))}\${Number(issue.thumbsUp || 0) ? ' · +' + escapeHtml(issue.thumbsUp) : ''}</span>
          </span>
          <span class="codicon codicon-chevron-down"></span>
        </button>
      \`).join('');
      return \`
        <div class="portfolio-issue-panel" data-issue-panel>
          \${issueHead}
          <div class="portfolio-issue-repo">\${escapeHtml(issues.repo || '')}\${issues.syncedAt ? ' · ' + escapeHtml(issues.stale ? t('issueCached') : t('issueSynced')) + ' ' + escapeHtml(formatRelativeTime(issues.syncedAt)) : ''}</div>
          <div class="portfolio-issue-metrics">
            <span class="portfolio-issue-pill">\${escapeHtml(t('issueTotal'))} \${escapeHtml(issues.total || 0)}</span>
            <span class="portfolio-issue-pill">\${escapeHtml(t('issueOpen'))} \${escapeHtml(issues.open || 0)}</span>
            \${priorityPills}
          </div>
          <div class="portfolio-issue-tag-grid">\${categoryTags}</div>
          \${issueFormOpen ? renderIssueCreateForm(project.path) : ''}
          \${issueActionMessage ? \`<div class="portfolio-issue-empty">\${escapeHtml(issueActionMessage)}</div>\` : ''}
          \${issueRows ? \`<div class="portfolio-issue-list">\${issueRows}</div>\` : \`<div class="portfolio-issue-empty">\${escapeHtml(t('noPortfolioMatch'))}</div>\`}
          \${expandedIssueNumber ? renderIssueDetail(project.path) : ''}
        </div>
      \`;
    }

    function renderIssueCreateForm(projectPath) {
      const categoryOptions = selectFirstOption(getIssueCategories(), issueDraftCategory);
      const priorityOptions = selectFirstOption(getIssuePriorities(), issueDraftPriority);
      return \`
        <div class="portfolio-issue-form" data-issue-create-form>
          <input class="portfolio-issue-input" data-issue-title placeholder="\${escapeHtml(t('issueTitlePlaceholder'))}" value="\${escapeHtml(issueDraftTitle)}">
          <textarea class="portfolio-issue-textarea" data-issue-body placeholder="\${escapeHtml(t('issueBodyPlaceholder'))}">\${escapeHtml(issueDraftBody)}</textarea>
          <div class="portfolio-issue-form-row">
            \${renderSoloSelect('portfolio-issue-category', 'data-issue-category', categoryOptions, false)}
            \${renderSoloSelect('portfolio-issue-priority', 'data-issue-priority', priorityOptions, false)}
          </div>
          <div class="portfolio-issue-form-row">
            <button class="portfolio-issue-action primary" data-create-issue data-project-path="\${escapeHtml(projectPath)}">\${escapeHtml(t('issueSubmit'))}</button>
            <button class="portfolio-issue-action" data-cancel-issue-form>\${escapeHtml(t('issueCancel'))}</button>
          </div>
        </div>
      \`;
    }

    function renderIssueDetail(projectPath) {
      if (!issueDetails) {
        return \`<div class="portfolio-issue-detail"><div class="portfolio-issue-empty">\${escapeHtml(t('issueLoading'))}</div></div>\`;
      }
      if (issueDetails.error) {
        return \`<div class="portfolio-issue-detail"><div class="portfolio-issue-empty">\${escapeHtml(issueDetails.error)}</div></div>\`;
      }
      const issue = issueDetails.issue || {};
      const comments = issueDetails.comments || [];
      return \`
        <div class="portfolio-issue-detail">
          <div class="portfolio-issue-name">#\${escapeHtml(issue.number)} \${escapeHtml(issue.title || '')}</div>
          \${issueDetails.stale ? \`<div class="portfolio-issue-empty">\${escapeHtml(t('issueCached'))}</div>\` : ''}
          \${issue.body ? \`<div class="portfolio-issue-comment">\${escapeHtml(issue.body).slice(0, 900)}</div>\` : ''}
          <div class="portfolio-issue-detail-actions">
            \${issue.url ? \`<button class="portfolio-issue-action" data-open-issue-url="\${escapeHtml(issue.url)}">\${escapeHtml(t('projectOpen'))}</button>\` : ''}
            \${issue.state === 'OPEN' ? \`<button class="portfolio-issue-action danger" data-close-issue="\${escapeHtml(issue.number)}" data-project-path="\${escapeHtml(projectPath)}">\${escapeHtml(t('issueClose'))}</button>\` : ''}
          </div>
          \${comments.length ? comments.map(comment => \`
            <div class="portfolio-issue-comment"><strong>\${escapeHtml(comment.author || '')}</strong><br>\${escapeHtml(comment.body || '').slice(0, 900)}</div>
          \`).join('') : \`<div class="portfolio-issue-empty">\${escapeHtml(t('issueNoComments'))}</div>\`}
        </div>
      \`;
    }

    function isFailedDeliveryConclusion(conclusion) {
      return ['failure', 'timed_out', 'action_required'].includes(String(conclusion || '').toLowerCase());
    }

    function deliveryConclusionLabel(conclusion) {
      const normalized = String(conclusion || '').toLowerCase();
      if (normalized === 'failure') return t('deliveryActionFailureTag');
      if (normalized === 'timed_out') return t('deliveryActionTimeoutTag');
      if (normalized === 'action_required') return t('deliveryActionRequiredTag');
      return normalized || '-';
    }

    function deliverySignalText(delivery) {
      if (!delivery || !delivery.available) return '';
      if (Number(delivery.failedWorkflowRuns || 0) > 0) return t('deliverySignalAttention');
      if (delivery.latestRelease) return t('deliverySignalRelease') + ' ' + delivery.latestRelease;
      if (delivery.stale && delivery.syncedAt) return t('checksCached');
      if (delivery.latestWorkflowStatus) return t('deliverySignalHealthy');
      return '';
    }

    function buildDeliveryActionPrompt(project) {
      const delivery = project && project.delivery ? project.delivery : {};
      const failedRuns = Array.isArray(delivery.recentWorkflowRuns)
        ? delivery.recentWorkflowRuns.filter(run => isFailedDeliveryConclusion(run.conclusion))
        : [];
      const failedSummary = failedRuns.length
        ? failedRuns.map((run, index) => {
          const title = run.displayTitle || run.name || 'Unknown run';
          const updated = formatRelativeTime(run.updatedAt || run.createdAt || '');
          const suffix = updated ? ' · ' + updated : '';
          return (index + 1) + '. ' + title + ' · ' + deliveryConclusionLabel(run.conclusion) + suffix;
        }).join('\\n')
        : (currentLanguage === 'zh' ? '最近 3 次检查里没有保留下来的失败明细。' : 'No failed run details were preserved from the latest 3 checks.');
      const releaseLine = delivery.latestRelease
        ? (currentLanguage === 'zh' ? '最近发布：' : 'Latest release: ') + delivery.latestRelease
        : (currentLanguage === 'zh' ? '最近发布：暂无' : 'Latest release: none');
      if (currentLanguage === 'zh') {
        return [
          '请检查这个项目当前的 GitHub Actions / 发布异常，并直接修复真正的根因。',
          '已知事实：',
          '1. 只看最近 3 次检查判断当前状态。',
          '2. 当前项目卡片显示交付异常，需要确认失败检查是否仍然成立。',
          '3. 失败检查：',
          failedSummary,
          '4. ' + releaseLine,
          '要求：先查明是哪一个工作流失败、为什么失败、是否已经被后续成功覆盖；如果仍有问题，直接改代码并验证。'
        ].join('\\n');
      }
      return [
        'Inspect the current GitHub Actions / release issue for this project and fix the real root cause.',
        'Known facts:',
        '1. Only the latest 3 checks define the current delivery state.',
        '2. The project card is showing a delivery exception that needs verification.',
        '3. Failed checks:',
        failedSummary,
        '4. ' + releaseLine,
        'Requirements: identify which workflow failed, why it failed, whether it has already been superseded by later success, and if the issue is still real, fix it in code and verify it.'
      ].join('\\n');
    }

    function renderProjectDeliveryPanel(project) {
      const delivery = project && project.delivery ? project.delivery : null;
      if (!delivery || (!delivery.available && !delivery.loading && !delivery.message)) {
        return '';
      }
      const recentRuns = Array.isArray(delivery.recentWorkflowRuns) ? delivery.recentWorkflowRuns : [];
      const failedRuns = recentRuns.filter(run => isFailedDeliveryConclusion(run.conclusion));
      const hasFailure = failedRuns.length > 0;
      const expanded = deliveryActionPanelExpanded;
      const refreshBusy = projectRefreshPaths.has(project.path);

      const runRows = failedRuns.map(run => {
        const title = run.displayTitle || run.name || '-';
        const time = formatRelativeTime(run.updatedAt || run.createdAt || '');
        return '<div class="portfolio-delivery-row">'
          + '<span class="portfolio-issue-main">'
          + '<span class="portfolio-issue-name">' + escapeHtml(title) + '</span>'
          + '<span class="portfolio-issue-sub">' + escapeHtml(deliveryConclusionLabel(run.conclusion)) + (time ? ' · ' + escapeHtml(time) : '') + '</span>'
          + '</span>'
          + (run.url ? '<button class="portfolio-issue-action" data-open-delivery-run="' + escapeHtml(run.url) + '">' + escapeHtml(t('projectOpen')) + '</button>' : '')
          + '</div>';
      }).join('');

      const latestRunUrl = failedRuns[0]?.url || delivery.latestWorkflowUrl || '';

      // 收起时的简短状态文字
      const checksFailedLabel = currentLanguage === 'zh' ? '检查失败' : 'Checks failed';
      const checksHealthyLabel = currentLanguage === 'zh' ? '检查正常' : 'Checks healthy';
      
      let miniStatusText = '';
      if (delivery.loading) {
        miniStatusText = t('issueLoading');
      } else if (!delivery.available) {
        miniStatusText = currentLanguage === 'zh' ? '暂无信号' : 'No signal';
      } else if (hasFailure) {
        miniStatusText = checksFailedLabel + ' ' + failedRuns.length;
      } else {
        const releaseStr = delivery.latestRelease ? ' · ' + delivery.latestRelease : '';
        miniStatusText = checksHealthyLabel + releaseStr;
      }

      if (!expanded) {
        return '<div class="portfolio-delivery-panel ' + (hasFailure ? 'is-failed' : 'is-healthy') + '" data-delivery-action-panel>'
          + '<div class="delivery-collapsed-row">'
          + '<div class="delivery-title-wrapper">'
          + '<span class="codicon codicon-rocket delivery-rocket-icon"></span>'
          + '<span class="delivery-panel-title">' + escapeHtml(t('deliveryActionTitle')) + '</span>'
          + '</div>'
          + '<div class="delivery-status-badge ' + (hasFailure ? 'status-failed' : 'status-healthy') + '">'
          + escapeHtml(miniStatusText)
          + '</div>'
          + '<button class="delivery-toggle-btn" data-toggle-delivery-panel title="' + escapeHtml(t('deliveryActionShow')) + '">'
          + '<span class="codicon codicon-chevron-down"></span>'
          + '</button>'
          + '</div>'
          + '</div>';
      }

      return '<div class="portfolio-delivery-panel is-expanded ' + (hasFailure ? 'is-failed' : 'is-healthy') + '" data-delivery-action-panel>'
        + '<div class="delivery-header-row">'
        + '<div class="delivery-title-wrapper">'
        + '<span class="codicon codicon-rocket delivery-rocket-icon"></span>'
        + '<span class="delivery-panel-title">' + escapeHtml(t('deliveryActionTitle')) + '</span>'
        + '</div>'
        + '<button class="delivery-toggle-btn" data-toggle-delivery-panel title="' + escapeHtml(t('deliveryActionHide')) + '">'
        + '<span class="codicon codicon-chevron-up"></span>'
        + '</button>'
        + '</div>'
        + '<div class="delivery-grid">'
        + '<div class="delivery-card checks-card ' + (hasFailure ? 'card-failed' : 'card-healthy') + '">'
        + '<div class="delivery-card-title"><span class="codicon codicon-tasklist"></span>' + escapeHtml(t('deliveryActionLatestChecks')) + '</div>'
        + '<div class="delivery-card-value">'
        + (hasFailure
          ? '<span class="failed-count-highlight">' + failedRuns.length + ' ' + (currentLanguage === 'zh' ? '次失败' : 'failed') + '</span>'
          : '<span class="healthy-highlight">' + (currentLanguage === 'zh' ? '全部正常' : 'Healthy') + '</span>')
        + '</div>'
        + '</div>'
        + '<div class="delivery-card release-card">'
        + '<div class="delivery-card-title"><span class="codicon codicon-tag"></span>' + escapeHtml(t('deliveryActionLatestRelease')) + '</div>'
        + '<div class="delivery-card-value">'
        + (delivery.latestRelease
          ? '<span class="release-version-highlight">' + escapeHtml(delivery.latestRelease) + '</span>'
          : '<span class="no-release-highlight">-</span>')
        + '</div>'
        + '</div>'
        + '</div>'
        + '<div class="delivery-meta-info">'
        + '<span class="delivery-repo-text" title="' + escapeHtml(delivery.repo || '') + '">'
        + '<span class="codicon codicon-github"></span> ' + escapeHtml(delivery.repo || t('deliveryActionRepoMissing'))
        + '</span>'
        + (delivery.syncedAt
          ? '<span>' + escapeHtml(delivery.stale ? t('issueCached') : t('issueSynced')) + ' ' + escapeHtml(formatRelativeTime(delivery.syncedAt)) + '</span>'
          : '')
        + '</div>'
        + (hasFailure
          ? '<div class="delivery-runs-section">'
            + '<div class="delivery-section-title">' + (currentLanguage === 'zh' ? '未通过的检查：' : 'Failed checks:') + '</div>'
            + '<div class="portfolio-delivery-list">' + runRows + '</div>'
            + '</div>'
          : '')
        + (deliveryActionMessage
          ? '<div class="delivery-toast-message">' + escapeHtml(deliveryActionMessage) + '</div>'
          : '')
        + '<div class="delivery-footer-actions">'
        + '<button class="delivery-action-btn secondary-btn" data-refresh-delivery-project-path="' + escapeHtml(project.path) + '"' + (refreshBusy ? ' disabled' : '') + '>'
        + '<span class="codicon codicon-refresh' + (refreshBusy ? ' loading-spin' : '') + '"></span>'
        + escapeHtml(refreshBusy ? t('testing') : t('deliveryActionRefresh'))
        + '</button>'
        + (latestRunUrl
          ? '<button class="delivery-action-btn secondary-btn" data-open-delivery-run="' + escapeHtml(latestRunUrl) + '">'
            + '<span class="codicon codicon-link-external"></span>'
            + escapeHtml(t('deliveryActionOpenRun'))
            + '</button>'
          : '')
        + (hasFailure
          ? '<button class="delivery-action-btn primary-btn pulse-glow" data-agent-fix-delivery-project-path="' + escapeHtml(project.path) + '">'
            + '<span class="codicon codicon-tools"></span>'
            + escapeHtml(t('deliveryActionAgent'))
            + '</button>'
          : '')
        + '</div>'
        + '</div>';
    }

    function renderPortfolio(portfolio, selectedProjectPath) {
      const preservedComposerState = captureProjectConversationInputState();
      if (!portfolio || portfolio.length === 0) {
        portfolioList.innerHTML = renderOnboardingPanel();
        bindOnboardingActions(portfolioList);
        restoreProjectConversationInputState(preservedComposerState);
        return;
      }

      const visibleProjects = portfolio.filter(shouldShowPortfolioProject);
      if (!visibleProjects.length) {
        portfolioList.innerHTML = '<div class="empty-portfolio">' + t('noPortfolioMatch') + '</div>';
        restoreProjectConversationInputState(preservedComposerState);
        return;
      }

      portfolioList.innerHTML = visibleProjects.map(project => {
        const isSelected = project.path === selectedProjectPath;
        const nextActionLabel = Number(project.failedNodes || 0) > 0 ? t('projectReviewFailure') : t('projectContinue');
        const relativeTime = formatRelativeTime(project.recentActivityAt);
        const recommendation = project.recommendedNodeTitle || '';
        const isRefreshing = projectRefreshPaths.has(project.path);
        const isPinned = Boolean(project.pinnedAt);
        const deliverySignal = deliverySignalText(project.delivery) || project.deliverySignal || '';
        return \`
          <div class="portfolio-card \${isSelected ? 'is-selected' : ''}" data-select-project-path="\${escapeHtml(project.path)}">
            <div class="portfolio-card-head">
              <span class="portfolio-project-name">
                \${escapeHtml(project.name)}
                \${project.issues && project.issues.syncedAt
                  ? \`<span class="project-synced-tag" title="\${escapeHtml(project.issues.stale ? t('issueCached') : t('issueSynced'))} \${escapeHtml(formatRelativeTime(project.issues.syncedAt))}"><span class="codicon codicon-sync"></span>\${escapeHtml(t('issueSynced'))}</span>\`
                  : ''
                }
              </span>
              <span class="portfolio-card-controls">
                <button class="portfolio-refresh-btn \${isRefreshing ? 'is-refreshing' : ''}" type="button" title="\${escapeHtml(t('refreshProjectData'))}" aria-label="\${escapeHtml(t('refreshProjectData'))}" data-refresh-project-path="\${escapeHtml(project.path)}" \${isRefreshing ? 'disabled' : ''}><span class="codicon codicon-refresh"></span></button>
                <button class="portfolio-refresh-btn \${isPinned ? 'is-pinned' : ''}" type="button" title="\${escapeHtml(t(isPinned ? 'unpinProject' : 'pinProject'))}" aria-label="\${escapeHtml(t(isPinned ? 'unpinProject' : 'pinProject'))}" data-toggle-pin-project-path="\${escapeHtml(project.path)}"><span class="codicon codicon-pinned"></span></button>
                <span class="global-priority \${escapeHtml(project.globalPriority || 'P2')}">\${escapeHtml(project.globalPriority || 'P2')}</span>
              </span>
            </div>
            <div class="portfolio-global-row">
              <span class="global-chip">\${escapeHtml(t('globalType'))}: \${escapeHtml(projectTypeLabel(project.projectType))}</span>
              <span class="global-chip">\${escapeHtml(statusText(project.overallStatus))}</span>
              \${project.reusableSignals ? \`<span class="global-chip">\${escapeHtml(t('globalReusable'))}: \${escapeHtml(project.reusableSignals)}</span>\` : ''}
              \${project.issuePressure ? \`<span class="global-chip">\${escapeHtml(t('issues'))}: \${escapeHtml(project.issuePressure)}</span>\` : ''}
              \${deliverySignal ? \`<span class="global-chip">\${escapeHtml(deliverySignal)}</span>\` : ''}
            </div>
            <div class="portfolio-card-meta">
              <span class="portfolio-recommendation">\${t('nextAction')}: \${escapeHtml(project.globalNextAction || recommendation || '-')}</span>
            </div>
            <div class="portfolio-card-meta">
              <span class="portfolio-updated">\${t('latestUpdate')}: \${relativeTime || '-'}</span>
              \${isSelected ? \`<span>\${t('selected')}</span>\` : ''}
            </div>
            <div class="portfolio-card-actions">
              <button class="portfolio-action-btn" data-open-project-path="\${escapeHtml(project.path)}">\${t('projectOpen')}</button>
              \${isSelected ? '' : \`<button class="portfolio-action-btn primary" data-continue-project-path="\${escapeHtml(project.path)}" data-continue-node-id="\${escapeHtml(project.recommendedNodeId || '')}">\${nextActionLabel}</button>\`}
            </div>
            \${isSelected ? renderProjectDeliveryPanel(project) + renderProjectIssuePanel(project) + '<div class="portfolio-action-zone">' + renderProjectConversationComposer(project, currentNodes) + '</div>' : ''}
          </div>
        \`;
      }).join('');

      portfolioList.querySelectorAll('[data-select-project-path]').forEach(card => {
        card.addEventListener('click', (event) => {
          if (event.target.closest('button') || event.target.closest('input') || event.target.closest('textarea') || event.target.closest('[data-solo-select]') || event.target.closest('[data-sidebar-solo-history]') || event.target.closest('[data-issue-panel]') || event.target.closest('[data-delivery-action-panel]')) return;
          const projectPath = card.getAttribute('data-select-project-path') || '';
          if (projectPath === currentProjects.selectedProjectPath) return;
          activateProjectInSidebar(projectPath);
          vscode.postMessage({
            command: 'selectProject',
            projectPath
          });
        });
      });
      portfolioList.querySelectorAll('[data-open-project-path]').forEach(button => {
        button.addEventListener('click', () => {
          vscode.postMessage({
            command: 'openProjectFromPortfolio',
            projectPath: button.getAttribute('data-open-project-path')
          });
        });
      });
      portfolioList.querySelectorAll('[data-refresh-project-path]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const projectPath = button.getAttribute('data-refresh-project-path') || '';
          if (!projectPath || projectRefreshPaths.has(projectPath)) return;
          projectRefreshPaths.add(projectPath);
          deliveryActionMessage = '';
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          vscode.postMessage({
            command: 'refreshProjectData',
            projectPath
          });
          requestSidebarSoloConversationHistory(projectPath, true);
          requestSidebarProjectConversationHistory(projectPath, true);
        });
      });
      portfolioList.querySelectorAll('[data-toggle-delivery-panel]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          deliveryActionPanelExpanded = !deliveryActionPanelExpanded;
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
        });
      });
      portfolioList.querySelectorAll('[data-open-delivery-run]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const url = button.getAttribute('data-open-delivery-run') || '';
          if (!url) return;
          vscode.postMessage({ command: 'openExternal', url });
        });
      });
      portfolioList.querySelectorAll('[data-refresh-delivery-project-path]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const projectPath = button.getAttribute('data-refresh-delivery-project-path') || '';
          if (!projectPath || projectRefreshPaths.has(projectPath)) return;
          projectRefreshPaths.add(projectPath);
          deliveryActionMessage = '';
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          vscode.postMessage({ command: 'refreshProjectData', projectPath });
          requestSidebarProjectConversationHistory(projectPath, true);
        });
      });
      portfolioList.querySelectorAll('[data-agent-fix-delivery-project-path]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const projectPath = button.getAttribute('data-agent-fix-delivery-project-path') || '';
          const project = (currentProjects.portfolio || []).find(item => item.path === projectPath);
          if (!projectPath || !project) return;
          const targetId = projectSoloTargetId(projectPath);
          const agentCli = projectConversationAgentSelections[targetId] || getEffectiveSettingCliPath() || 'agy';
          const model = getTargetModelValue(targetId, agentCli);
          projectConversationModes[projectPath] = 'solo';
          deliveryActionMessage = t('deliveryActionStarted');
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          vscode.postMessage({
            command: 'runSoloConversation',
            projectPath,
            userMessage: buildDeliveryActionPrompt(project),
            agentCli,
            model,
            supplementFiles: []
          });
        });
      });
      portfolioList.querySelectorAll('[data-toggle-pin-project-path]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const projectPath = button.getAttribute('data-toggle-pin-project-path') || '';
          if (!projectPath) return;
          applyLocalPinnedState(projectPath);
          renderProjects(currentProjects.projects, currentProjects.selectedProjectPath);
          renderGlobalFocus(currentProjects.portfolio, currentProjects.selectedProjectPath);
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          vscode.postMessage({
            command: 'toggleProjectPinned',
            projectPath
          });
        });
      });
      portfolioList.querySelectorAll('[data-continue-project-path]').forEach(button => {
        button.addEventListener('click', () => {
          vscode.postMessage({
            command: 'continueProjectFromPortfolio',
            projectPath: button.getAttribute('data-continue-project-path'),
            nodeId: button.getAttribute('data-continue-node-id')
          });
        });
      });
      portfolioList.querySelectorAll('[data-open-issue-url]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const url = button.getAttribute('data-open-issue-url') || '';
          if (url) {
            vscode.postMessage({ command: 'openExternal', url });
          }
        });
      });
      portfolioList.querySelectorAll('[data-toggle-issue-form]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const panel = button.closest('[data-issue-panel]');
          const quickInput = panel ? panel.querySelector('[data-quick-issue-input]') : null;
          const quickValue = quickInput ? quickInput.value.trim() : '';
          if (quickValue) {
            vscode.postMessage({
              command: 'createIssue',
              projectPath: button.getAttribute('data-project-path') || currentProjects.selectedProjectPath,
              title: quickValue,
              body: '',
              category: 'quick-note',
              priority: ''
            });
            quickIssueDraftTitle = '';
            if (quickInput) {
              quickInput.value = '';
            }
          } else {
            issueFormOpen = !issueFormOpen;
            issuePanelExpanded = true;
            issueActionMessage = '';
            renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          }
        });
      });
      portfolioList.querySelectorAll('[data-quick-issue-input]').forEach(input => {
        input.addEventListener('input', () => {
          quickIssueDraftTitle = input.value;
        });
        input.addEventListener('click', (event) => event.stopPropagation());
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            const value = input.value.trim();
            if (value) {
              vscode.postMessage({
                command: 'createIssue',
                projectPath: input.getAttribute('data-project-path') || currentProjects.selectedProjectPath,
                title: value,
                body: '',
                category: 'quick-note',
                priority: ''
              });
              quickIssueDraftTitle = '';
              input.value = '';
            }
          }
        });
      });
      portfolioList.querySelectorAll('[data-toggle-issue-panel]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          issuePanelExpanded = !issuePanelExpanded;
          if (!issuePanelExpanded) {
            expandedIssueNumber = 0;
            issueDetails = null;
          }
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
        });
      });
      portfolioList.querySelectorAll('[data-cancel-issue-form]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          issueFormOpen = false;
          issueDraftTitle = '';
          issueDraftBody = '';
          issueDraftCategory = 'bug';
          issueDraftPriority = '';
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
        });
      });
      portfolioList.querySelectorAll('[data-issue-title]').forEach(input => {
        input.addEventListener('input', () => {
          issueDraftTitle = input.value;
        });
        input.addEventListener('click', (event) => event.stopPropagation());
      });
      portfolioList.querySelectorAll('[data-issue-body]').forEach(input => {
        input.addEventListener('input', () => {
          issueDraftBody = input.value;
        });
        input.addEventListener('click', (event) => event.stopPropagation());
      });
      portfolioList.querySelectorAll('[data-issue-category]').forEach(select => {
        bindSoloSelect(select, (value) => {
          issueDraftCategory = value || 'bug';
        });
      });
      portfolioList.querySelectorAll('[data-issue-priority]').forEach(select => {
        bindSoloSelect(select, (value) => {
          issueDraftPriority = value || '';
        });
      });
      portfolioList.querySelectorAll('[data-create-issue]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const form = button.closest('[data-issue-create-form]');
          const title = form ? form.querySelector('[data-issue-title]') : null;
          const body = form ? form.querySelector('[data-issue-body]') : null;
          const category = form ? form.querySelector('[data-issue-category]') : null;
          const priority = form ? form.querySelector('[data-issue-priority]') : null;
          if (!title || !title.value.trim()) return;
          issueDraftTitle = title.value.trim();
          issueDraftBody = body ? body.value.trim() : '';
          issueDraftCategory = getSoloSelectValue(category) || issueDraftCategory || 'bug';
          issueDraftPriority = getSoloSelectValue(priority) || issueDraftPriority || '';
          issueActionMessage = '';
          vscode.postMessage({
            command: 'createIssue',
            projectPath: button.getAttribute('data-project-path') || currentProjects.selectedProjectPath,
            title: issueDraftTitle,
            body: issueDraftBody,
            category: issueDraftCategory,
            priority: issueDraftPriority
          });
        });
      });
      portfolioList.querySelectorAll('[data-expand-issue-number]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const issueNumber = Number(button.getAttribute('data-expand-issue-number') || 0);
          if (!issueNumber) return;
          if (expandedIssueNumber === issueNumber && issueDetails) {
            expandedIssueNumber = 0;
            issueDetails = null;
            renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
            return;
          }
          expandedIssueNumber = issueNumber;
          issueDetails = null;
          renderPortfolio(currentProjects.portfolio, currentProjects.selectedProjectPath);
          vscode.postMessage({
            command: 'getIssueDetails',
            projectPath: button.getAttribute('data-project-path') || currentProjects.selectedProjectPath,
            issueNumber
          });
        });
      });
      portfolioList.querySelectorAll('[data-close-issue]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({
            command: 'closeIssue',
            projectPath: button.getAttribute('data-project-path') || currentProjects.selectedProjectPath,
            issueNumber: Number(button.getAttribute('data-close-issue') || 0)
          });
        });
      });
      bindProjectContinueComposer(portfolioList);
      restoreProjectConversationInputState(preservedComposerState);
    }

    function activateProjectInSidebar(projectPath) {
      if (!projectPath) return;
      if (projectPath !== activeProjectPath) {
        currentNodes = [];
      }
      activeProjectPath = projectPath;
      currentProjects.selectedProjectPath = projectPath;
      setSoloSelectValue(projectSelect, projectPath);
      activePortfolioFilter = 'all';
      renderPortfolioFilters();
      renderGlobalFocus(currentProjects.portfolio, projectPath);
      renderPortfolio(currentProjects.portfolio, projectPath);
      requestSidebarSoloConversationHistory(projectPath);
      requestSidebarProjectConversationHistory(projectPath);
      setTimeout(() => {
        const selectedCard = portfolioList && portfolioList.querySelector ? portfolioList.querySelector('.portfolio-card.is-selected') : null;
        if (selectedCard && typeof selectedCard.scrollIntoView === 'function') {
          selectedCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }, 0);
    }

    function renderSidebar(nodes) {
      if (!tasksList || !progressBar || !progressText) {
        return;
      }
      tasksList.innerHTML = '';

      if (!nodes || nodes.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.style.color = 'var(--text-muted)';
        emptyState.style.fontSize = '11px';
        emptyState.style.textAlign = 'center';
        emptyState.style.padding = '20px 0';
        emptyState.textContent = t('empty');
        tasksList.appendChild(emptyState);

        progressBar.style.width = '0%';
        progressText.textContent = '0 / 0 ' + t('tasks');
        return;
      }

      // Calculate progress metrics
      const total = nodes.length;
      const completed = nodes.filter(n => n.status === 'Completed').length;
      const percent = Math.round((completed / total) * 100);

      progressBar.style.width = percent + '%';
      progressText.textContent = completed + ' / ' + total + ' ' + t('tasks') + ' (' + percent + '%)';

      nodes.forEach(node => {
        const card = document.createElement('div');
        card.className = 'node-card status-' + statusClass(node.status);
        card.addEventListener('click', (e) => {
          // Prevent triggers clicking the run button itself
          if (e.target.closest('button')) return;
          // Open full visual editor on clicking the card
          vscode.postMessage({ command: 'showFullRoadmap' });
        });

        // Small run button if applicable
        const actionHtml = (node.status === 'Pending' || node.status === 'Failed' || node.status === 'In Progress')
          ? '<button class="btn-run-small" data-run-node-id="' + node.id + '"><span class="codicon codicon-comment-discussion"></span>' + t('run') + '</button>'
          : '';

        const cleanStage = node.stage.replace(/[^a-zA-Z0-9]/g, '-');

        card.innerHTML = \`
          <div class="node-meta">
            <span class="node-title">\${node.title}</span>
            <span class="node-badge stage-\${cleanStage}">\${node.stage}</span>
          </div>
          <div class="node-action-bar">
            <span class="status-lbl \${statusClass(node.status)}">\${statusText(node.status)}</span>
            \${actionHtml}
          </div>
        \`;

        const runButton = card.querySelector('[data-run-node-id]');
        if (runButton) {
          runButton.addEventListener('click', () => {
            runNodeAgent(node.id, '', node.agentCli || '', '', []);
          });
        }

        tasksList.appendChild(card);
      });
    }

    function bindOnboardingActions(container) {
      container.querySelectorAll('[data-onboarding-add-project]').forEach(button => {
        button.addEventListener('click', () => {
          vscode.postMessage({ command: 'addProject' });
        });
      });
    }

    function runNodeAgent(nodeId, userMessage, agentCli, model, supplementFiles) {
      vscode.postMessage({
        command: 'runAgent',
        nodeId: nodeId,
        userMessage: userMessage || '',
        agentCli: agentCli || '',
        model: model || '',
        supplementFiles: supplementFiles || []
      });
    }
  </script>
</body>
</html>`;
  }
}
