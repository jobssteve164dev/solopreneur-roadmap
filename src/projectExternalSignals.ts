import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { commandExists, resolveCommandOnSearchPath } from './agentCli';
import { ExternalDataLoadOptions, invalidateExternalData, loadExternalData } from './externalDataLoader';

const githubRepoSlugCache = new Map<string, string>();
const DELIVERY_WORKFLOW_RUN_DISPLAY_LIMIT = 3;
const DELIVERY_WORKFLOW_RUN_FETCH_LIMIT = 20;

export interface ProjectIssueItem {
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

export interface ProjectIssueComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface ProjectIssueSummary {
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


export interface IssueCacheFile {
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


export function createEmptyIssueSummary(message = ''): ProjectIssueSummary {
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

export interface ProjectDeliverySummary {
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

export interface ProjectSecurityAlert {
  source: string;
  title: string;
  severity: string;
  state: string;
  url: string;
}

export interface ProjectSecuritySummary {
  available: boolean;
  loading: boolean;
  stale: boolean;
  syncedAt: string;
  repo: string;
  openCriticalHigh: number;
  openTotal: number;
  status: 'healthy' | 'risk' | 'unconfigured' | 'unknown';
  alerts: ProjectSecurityAlert[];
  message: string;
}

export interface DeliveryCacheFile {
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

export interface SecurityCacheFile {
  schemaVersion: number;
  repo: string;
  syncedAt: string;
  alerts: ProjectSecurityAlert[];
  message: string;
}

export function createLoadingIssueSummary(): ProjectIssueSummary {
  return {
    ...createEmptyIssueSummary('Loading GitHub Issues'),
    loading: true
  };
}

export function createEmptyDeliverySummary(message = ''): ProjectDeliverySummary {
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

export function createLoadingDeliverySummary(): ProjectDeliverySummary {
  return {
    ...createEmptyDeliverySummary('Loading delivery signals'),
    loading: true
  };
}

export function createEmptySecuritySummary(message = ''): ProjectSecuritySummary {
  return {
    available: false,
    loading: false,
    stale: false,
    syncedAt: '',
    repo: '',
    openCriticalHigh: 0,
    openTotal: 0,
    status: message ? 'unknown' : 'unconfigured',
    alerts: [],
    message
  };
}

export function createLoadingSecuritySummary(): ProjectSecuritySummary {
  return {
    ...createEmptySecuritySummary('Loading security signals'),
    loading: true,
    status: 'unknown'
  };
}

export function getIssueCachePath(projectPath: string): string {
  return path.join(projectPath, '.solopreneur', 'issues-cache.json');
}

export function getDeliveryCachePath(projectPath: string): string {
  return path.join(projectPath, '.solopreneur', 'delivery-cache.json');
}

export function getSecurityCachePath(projectPath: string): string {
  return path.join(projectPath, '.solopreneur', 'security-cache.json');
}

function ensureIssueCacheGitignore(projectPath: string): void {
  const solopreneurDir = path.join(projectPath, '.solopreneur');
  const gitignorePath = path.join(solopreneurDir, '.gitignore');
  try {
    fs.mkdirSync(solopreneurDir, { recursive: true });
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    const missing = ['issues-cache.json', 'delivery-cache.json', 'security-cache.json']
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

export function readIssueCache(projectPath: string, repo = getGithubRepoSlug(projectPath)): IssueCacheFile | null {
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

export function writeIssueCache(projectPath: string, cache: IssueCacheFile): void {
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

export function readDeliveryCache(projectPath: string, repo = getGithubRepoSlug(projectPath)): DeliveryCacheFile | null {
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

export function writeDeliveryCache(projectPath: string, cache: DeliveryCacheFile): void {
  const cachePath = getDeliveryCachePath(projectPath);
  const tempPath = `${cachePath}.tmp`;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const payload = JSON.stringify(cache, null, 2);
  fs.writeFileSync(tempPath, payload, 'utf8');
  JSON.parse(fs.readFileSync(tempPath, 'utf8'));
  fs.renameSync(tempPath, cachePath);
  ensureIssueCacheGitignore(projectPath);
}

function normalizeSecuritySeverity(value: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (['critical', 'high', 'medium', 'low'].includes(normalized)) {
    return normalized;
  }
  if (['error', 'warning', 'note'].includes(normalized)) {
    return normalized === 'error' ? 'high' : normalized === 'warning' ? 'medium' : 'low';
  }
  return normalized || 'unknown';
}

function parseSecurityAlert(raw: any): ProjectSecurityAlert {
  return {
    source: String(raw?.source || ''),
    title: String(raw?.title || ''),
    severity: normalizeSecuritySeverity(raw?.severity || ''),
    state: String(raw?.state || 'open').toLowerCase(),
    url: String(raw?.url || '')
  };
}

function validateSecurityCache(raw: any, repo: string): SecurityCacheFile | null {
  if (!raw || raw.schemaVersion !== 1 || raw.repo !== repo || !Array.isArray(raw.alerts)) {
    return null;
  }
  return {
    schemaVersion: 1,
    repo,
    syncedAt: String(raw.syncedAt || ''),
    alerts: raw.alerts.map(parseSecurityAlert).filter((alert: ProjectSecurityAlert) => alert.title || alert.source),
    message: String(raw.message || '')
  };
}

export function readSecurityCache(projectPath: string, repo = getGithubRepoSlug(projectPath)): SecurityCacheFile | null {
  if (!repo) {
    return null;
  }
  try {
    const cachePath = getSecurityCachePath(projectPath);
    if (!fs.existsSync(cachePath)) {
      return null;
    }
    return validateSecurityCache(JSON.parse(fs.readFileSync(cachePath, 'utf8')), repo);
  } catch {
    return null;
  }
}

export function writeSecurityCache(projectPath: string, cache: SecurityCacheFile): void {
  const cachePath = getSecurityCachePath(projectPath);
  const tempPath = `${cachePath}.tmp`;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const payload = JSON.stringify(cache, null, 2);
  fs.writeFileSync(tempPath, payload, 'utf8');
  JSON.parse(fs.readFileSync(tempPath, 'utf8'));
  fs.renameSync(tempPath, cachePath);
  ensureIssueCacheGitignore(projectPath);
}

export function summarizeIssueItems(repo: string, items: ProjectIssueItem[], syncedAt = '', stale = false): ProjectIssueSummary {
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

export function summarizeSecurityCache(repo: string, cache: SecurityCacheFile, stale = false): ProjectSecuritySummary {
  const openAlerts = (cache.alerts || []).filter((alert) => !alert.state || alert.state === 'open');
  const priorityAlerts = openAlerts.filter((alert) => ['critical', 'high'].includes(alert.severity));
  return {
    available: true,
    loading: false,
    stale,
    syncedAt: cache.syncedAt,
    repo,
    openCriticalHigh: stale ? 0 : priorityAlerts.length,
    openTotal: stale ? 0 : openAlerts.length,
    status: stale ? 'unknown' : priorityAlerts.length > 0 ? 'risk' : 'healthy',
    alerts: priorityAlerts.concat(openAlerts.filter((alert) => !['critical', 'high'].includes(alert.severity))).slice(0, 5),
    message: stale ? 'Showing last synced security signals' : cache.message
  };
}

export function readCachedIssueSummary(projectPath: string): ProjectIssueSummary {
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

export function readCachedSecuritySummary(projectPath: string): ProjectSecuritySummary {
  const repo = getGithubRepoSlug(projectPath);
  if (!repo) {
    return createEmptySecuritySummary('No GitHub remote');
  }
  const cache = readSecurityCache(projectPath, repo);
  if (!cache) {
    return createLoadingSecuritySummary();
  }
  return summarizeSecurityCache(repo, cache, true);
}

export function summarizeDeliveryCache(repo: string, cache: DeliveryCacheFile, stale = false): ProjectDeliverySummary {
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

export function readCachedDeliverySummary(projectPath: string): ProjectDeliverySummary {
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

export function readCachedIssueDetails(projectPath: string, issueNumber: number): { ok: boolean; issue?: ProjectIssueItem; comments: ProjectIssueComment[]; message: string; stale: boolean } | null {
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

export function getProjectIssueLabels(category: string, priority: string): string[] {
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

export function parseIssueNumberFromOutput(output: string): number {
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

async function runGhApiCommandAsync(projectPath: string, endpoint: string, timeout = 6500): Promise<{ ok: boolean; stdout: string; stderr: string; repo: string }> {
  const repo = getGithubRepoSlug(projectPath);
  if (!repo) {
    return { ok: false, stdout: '', stderr: 'No GitHub remote', repo: '' };
  }
  const ghPath = resolveCommandOnSearchPath('gh');
  if (!ghPath) {
    return { ok: false, stdout: '', stderr: 'GitHub CLI not found', repo };
  }
  const result = await runProcessAsync(ghPath, ['api', endpoint], timeout);
  return { ...result, repo };
}

export function readProjectDeliverySummary(projectPath: string): ProjectDeliverySummary {
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

export function readProjectIssueSummary(projectPath: string): ProjectIssueSummary {
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

function parseDependabotAlert(raw: any): ProjectSecurityAlert {
  const advisory = raw?.security_advisory || {};
  const dependency = raw?.dependency || {};
  const packageName = String(dependency?.package?.name || advisory?.ghsa_id || 'Dependency alert');
  return {
    source: 'Dependabot',
    title: String(advisory?.summary || packageName),
    severity: normalizeSecuritySeverity(advisory?.severity || raw?.severity || ''),
    state: String(raw?.state || 'open').toLowerCase(),
    url: String(raw?.html_url || raw?.url || '')
  };
}

function parseCodeScanningAlert(raw: any): ProjectSecurityAlert {
  const rule = raw?.rule || {};
  return {
    source: String(raw?.tool?.name || 'Code scanning'),
    title: String(rule?.description || rule?.name || rule?.id || 'Code scanning alert'),
    severity: normalizeSecuritySeverity(rule?.security_severity_level || rule?.severity || ''),
    state: String(raw?.state || 'open').toLowerCase(),
    url: String(raw?.html_url || raw?.url || '')
  };
}

async function readProjectSecuritySummaryAsync(projectPath: string): Promise<ProjectSecuritySummary> {
  const repo = getGithubRepoSlug(projectPath);
  if (!repo) {
    return createEmptySecuritySummary('No GitHub remote');
  }
  if (!resolveCommandOnSearchPath('gh')) {
    const cache = readSecurityCache(projectPath, repo);
    return cache ? summarizeSecurityCache(repo, cache, true) : { ...createEmptySecuritySummary('GitHub CLI not found'), repo };
  }
  const [dependabotResult, codeScanningResult] = await Promise.all([
    runGhApiCommandAsync(projectPath, `/repos/${repo}/dependabot/alerts?state=open&per_page=100`, 6500),
    runGhApiCommandAsync(projectPath, `/repos/${repo}/code-scanning/alerts?state=open&per_page=100`, 6500)
  ]);
  const alerts: ProjectSecurityAlert[] = [];
  const messages: string[] = [];
  try {
    const dependabot = dependabotResult.ok ? JSON.parse(String(dependabotResult.stdout || '[]')) : [];
    if (Array.isArray(dependabot)) {
      alerts.push(...dependabot.map(parseDependabotAlert));
    } else if (!dependabotResult.ok) {
      messages.push(String(dependabotResult.stderr || 'Dependabot alerts unavailable').trim());
    }
  } catch {
    messages.push('Dependabot alerts could not be read');
  }
  try {
    const codeScanning = codeScanningResult.ok ? JSON.parse(String(codeScanningResult.stdout || '[]')) : [];
    if (Array.isArray(codeScanning)) {
      alerts.push(...codeScanning.map(parseCodeScanningAlert));
    } else if (!codeScanningResult.ok) {
      messages.push(String(codeScanningResult.stderr || 'Code scanning alerts unavailable').trim());
    }
  } catch {
    messages.push('Code scanning alerts could not be read');
  }
  if (!dependabotResult.ok && !codeScanningResult.ok) {
    const cache = readSecurityCache(projectPath, repo);
    return cache ? summarizeSecurityCache(repo, cache, true) : {
      ...createEmptySecuritySummary(messages.filter(Boolean).join(' / ') || 'GitHub security signals unavailable'),
      repo
    };
  }
  const cache: SecurityCacheFile = {
    schemaVersion: 1,
    repo,
    syncedAt: new Date().toISOString(),
    alerts: alerts.filter((alert) => alert.title || alert.source),
    message: messages.filter(Boolean).join(' / ')
  };
  try {
    writeSecurityCache(projectPath, cache);
  } catch {}
  return summarizeSecurityCache(repo, cache, false);
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

export function loadExternalIssueSummary(projectPath: string, options: ExternalDataLoadOptions = {}): Promise<ProjectIssueSummary> {
  return loadExternalData(
    'github-issues',
    projectPath,
    () => readProjectIssueSummaryAsync(projectPath),
    options
  );
}

export function loadExternalDeliverySummary(projectPath: string, options: ExternalDataLoadOptions = {}): Promise<ProjectDeliverySummary> {
  return loadExternalData(
    'github-delivery',
    projectPath,
    () => readProjectDeliverySummaryAsync(projectPath),
    options
  );
}

export function loadExternalSecuritySummary(projectPath: string, options: ExternalDataLoadOptions = {}): Promise<ProjectSecuritySummary> {
  return loadExternalData(
    'github-security',
    projectPath,
    () => readProjectSecuritySummaryAsync(projectPath),
    options
  );
}

export function invalidateExternalIssueSummary(projectPath: string): void {
  invalidateExternalData('github-issues', projectPath);
}

export function readProjectIssueDetails(projectPath: string, issueNumber: number): { ok: boolean; issue?: ProjectIssueItem; comments: ProjectIssueComment[]; message: string; stale?: boolean } {
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

export function createProjectIssue(projectPath: string, title: string, body: string, category: string, priority: string): { ok: boolean; message: string } {
  const labels = getProjectIssueLabels(category, priority);
  const args = ['issue', 'create', '--title', title, '--body', body || title];
  const result = runGhIssueCommand(projectPath, args, 10000);
  if (result.ok) {
    invalidateExternalIssueSummary(projectPath);
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

export function closeProjectIssue(projectPath: string, issueNumber: number): { ok: boolean; message: string } {
  const result = runGhIssueCommand(projectPath, ['issue', 'close', String(issueNumber)], 8000);
  if (result.ok) {
    invalidateExternalIssueSummary(projectPath);
    readProjectIssueSummary(projectPath);
  }
  return {
    ok: result.ok,
    message: String(result.stdout || result.stderr || '').trim()
  };
}
