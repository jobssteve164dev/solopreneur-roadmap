import * as childProcess from 'child_process';
import * as fs from 'fs';

import { RoadmapNode } from './db/types';
import { commandExists } from './agentCli';

const FEEDBACK_ISSUE_URL = 'https://github.com/jobssteve164dev/solopreneur-roadmap/issues/new';

export function buildFeedbackIssueUrl(title: string, body: string, category = '', usageSummary = ''): string {
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

function getGithubRepoSlug(workspaceRoot: string): string {
  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
    return '';
  }
  const result = childProcess.spawnSync('git', ['-C', workspaceRoot, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    timeout: 1800,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const remote = String(result.stdout || '').trim();
  const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/i);
  return match ? match[1].replace(/\.git$/i, '') : '';
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

export function buildGithubIssueContext(workspaceRoot: string, node: RoadmapNode): string {
  const repo = getGithubRepoSlug(workspaceRoot);
  if (!repo || !commandExists('gh')) {
    return '';
  }
  const listResult = childProcess.spawnSync('gh', [
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    '20',
    '--json',
    'number,title,body,labels,comments,url'
  ], {
    encoding: 'utf8',
    timeout: 4500,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (listResult.status !== 0) {
    return '';
  }
  let issues: any[] = [];
  try {
    issues = JSON.parse(String(listResult.stdout || '[]'));
  } catch {
    return '';
  }
  const nodeText = `${node.title || ''} ${node.description || ''} ${node.stage || ''}`.toLowerCase();
  const candidates = issues.map((issue) => {
    const labels = Array.isArray(issue.labels) ? issue.labels.map((label: any) => String(label?.name || label || '')) : [];
    const category = normalizeIssueCategory(labels);
    const priority = normalizeIssuePriority(labels);
    const title = String(issue.title || '');
    const score = (priority === 'P0' ? 5 : priority === 'P1' ? 3 : priority === 'P2' ? 1 : 0)
      + (category === 'bug' ? 4 : category === 'tech-debt' ? 2 : 0)
      + (nodeText && title && nodeText.includes(title.toLowerCase().slice(0, 16)) ? 2 : 0)
      + Math.min(Number(issue.comments || 0), 5);
    return { issue, labels, category, priority, score };
  }).sort((a, b) => b.score - a.score).slice(0, 3);
  if (!candidates.length) {
    return '';
  }
  const sections = candidates.map((candidate) => {
    const issueNumber = Number(candidate.issue.number || 0);
    const viewResult = childProcess.spawnSync('gh', [
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      repo,
      '--comments',
      '--json',
      'number,title,body,labels,comments,url'
    ], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let detail = candidate.issue;
    if (viewResult.status === 0) {
      try {
        detail = JSON.parse(String(viewResult.stdout || '{}'));
      } catch {}
    }
    const comments = Array.isArray(detail.comments)
      ? detail.comments.slice(-3).map((comment: any, index: number) => {
        const author = String(comment?.author?.login || `comment-${index + 1}`);
        const body = String(comment?.body || '').trim().replace(/\s+/g, ' ').slice(0, 500);
        return `${index + 1}. ${author}: ${body}`;
      })
      : [];
    return [
      `### Issue #${issueNumber}: ${String(detail.title || '').trim()}`,
      `分类：${candidate.category}${candidate.priority ? ` / ${candidate.priority}` : ''}`,
      `链接：${String(detail.url || '').trim()}`,
      String(detail.body || '').trim() ? `描述：${String(detail.body || '').trim().replace(/\s+/g, ' ').slice(0, 700)}` : '',
      comments.length ? ['最近评论：', ...comments].join('\n') : ''
    ].filter(Boolean).join('\n');
  });
  return ['当前环节关联的 GitHub Issues：', ...sections].join('\n\n');
}

export function buildGithubDeliveryContext(workspaceRoot: string): string {
  const repo = getGithubRepoSlug(workspaceRoot);
  if (!repo || !commandExists('gh')) {
    return '';
  }
  const releaseResult = childProcess.spawnSync('gh', [
    'release',
    'list',
    '--repo',
    repo,
    '--limit',
    '1',
    '--json',
    'tagName,name,publishedAt,url'
  ], {
    encoding: 'utf8',
    timeout: 4500,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const runResult = childProcess.spawnSync('gh', [
    'run',
    'list',
    '--repo',
    repo,
    '--limit',
    '3',
    '--json',
    'name,displayTitle,status,conclusion,createdAt,updatedAt,url'
  ], {
    encoding: 'utf8',
    timeout: 4500,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (releaseResult.status !== 0 && runResult.status !== 0) {
    return '';
  }
  let latestRelease = '';
  try {
    const releases = releaseResult.status === 0 ? JSON.parse(String(releaseResult.stdout || '[]')) : [];
    const release = Array.isArray(releases) ? releases[0] : null;
    if (release) {
      latestRelease = [
        `最新 Release：${String(release.tagName || release.name || '').trim()}`,
        String(release.publishedAt || '').trim() ? `发布时间：${String(release.publishedAt).trim()}` : '',
        String(release.url || '').trim() ? `链接：${String(release.url).trim()}` : ''
      ].filter(Boolean).join('\n');
    }
  } catch {}
  let workflowSummary = '';
  try {
    const runs = runResult.status === 0 ? JSON.parse(String(runResult.stdout || '[]')) : [];
    const lines = Array.isArray(runs)
      ? runs.slice(0, 3).map((run: any, index: number) => {
        const name = String(run.displayTitle || run.name || `workflow-${index + 1}`).trim();
        const state = [String(run.status || '').trim(), String(run.conclusion || '').trim()].filter(Boolean).join('/');
        const when = String(run.updatedAt || run.createdAt || '').trim();
        return `${index + 1}. ${name}：${state || 'unknown'}${when ? ` · ${when}` : ''}${run.url ? ` · ${String(run.url).trim()}` : ''}`;
      })
      : [];
    if (lines.length) {
      workflowSummary = ['最近 GitHub Actions：', ...lines].join('\n');
    }
  } catch {}
  const sections = [latestRelease, workflowSummary].filter(Boolean);
  return sections.length ? ['当前项目交付信号：', ...sections].join('\n\n') : '';
}
