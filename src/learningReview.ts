import * as crypto from 'crypto';
import * as childProcess from 'child_process';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl.js';

export const reviewHash = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
export type GithubRead = (endpoint: string) => Promise<any>;

export const readGithubApi: GithubRead = endpoint => new Promise((resolve, reject) => {
  childProcess.execFile('gh', ['api', '--method', 'GET', endpoint], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
    if (error) { reject(new Error(`GitHub read unavailable: ${endpoint.split('?')[0]}`)); return; }
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error('GitHub returned invalid JSON')); }
  });
});

export async function projectGithubRepository(projectPath: string): Promise<string> {
  return new Promise(resolve => childProcess.execFile('git', ['remote', 'get-url', 'origin'], { cwd: projectPath, encoding: 'utf8' }, (error, stdout) => {
    const match = !error && stdout.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
    resolve(match ? match[1] : '');
  }));
}

function taskTrailers(message: string, known: Set<string>): string[] {
  const lastParagraph = message.trim().split(/\r?\n\s*\r?\n/).pop() || '';
  return [...new Set(lastParagraph.split(/\r?\n/).map(line => line.match(/^SoloMap-Task:\s*(task-[A-Za-z0-9-]+)\s*$/)?.[1] || '').filter(id => known.has(id)))];
}

type EvidenceInput = {
  projectPath: string; repository: string; tasks: any[]; reports: any[]; api?: GithubRead; persist?: boolean; globalDataPath?: string;
};
type GithubEvidence = { repository: string; commits: any[]; gaps: string[] };
const factRequests = new Map<string, Promise<GithubEvidence>>();

export function collectGithubEvidence(input: EvidenceInput): Promise<GithubEvidence> {
  const scope = reviewHash(input.tasks.map(task => task.taskId).sort().join('\n'));
  const key = `${input.globalDataPath || ''}:${input.projectPath}:${input.repository}:${scope}:${input.persist === false ? 'read-only' : 'persist'}`;
  const pending = factRequests.get(key); if (pending) return pending;
  const operation = collectGithubFacts(input, scope).finally(() => factRequests.delete(key));
  factRequests.set(key, operation); return operation;
}

async function collectGithubFacts(input: EvidenceInput, scope: string): Promise<GithubEvidence> {
  const { repository, tasks, reports } = input;
  const persist = input.persist !== false;
  const result: { repository: string; commits: any[]; gaps: string[] } = { repository, commits: [], gaps: [] };
  if (!repository) { result.gaps.push('No GitHub origin; only local reports are available.'); return result; }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid GitHub repository');
  if (persist && !input.globalDataPath) throw new Error('database_root_required');
  const api = input.api || readGithubApi;
  const known = new Set<string>(tasks.map(task => task.taskId));
  const loadFacts = async () => sendRuntimeDataRequest<{ revision: number; facts: any }>(input.globalDataPath!, { operation: 'read_github_facts', input: { root: input.projectPath, repository } });
  const previous = persist ? (await loadFacts()).facts : undefined;
  const cursorKey = `github-cursor:${repository}:${scope}`;
  const loadCursor = async () => (await sendRuntimeDataRequest<Array<{ key: string; value: any; revision: number }>>(input.globalDataPath!, { operation: 'read_growth_report_projection', input: { root: input.projectPath, prefix: cursorKey } })).find(row => row.key === cursorKey);
  const nativeCursor = persist ? await loadCursor() : undefined;
  let cursorRevision = nativeCursor?.revision || 0;
  let cursorSuperseded = false;
  const cursor = (persist ? nativeCursor?.value : undefined) || { discovered: {}, coveredHead: '', page: 1, scanHead: '' };
  const saveCursor = async (value: any) => {
    if (!persist) return;
    for (;;) {
      if (cursorSuperseded) {
        const latest = await loadCursor(); cursorRevision = latest?.revision || 0;
        const discovered: Record<string, string[]> = { ...value.discovered };
        for (const [sha, taskIds] of Object.entries(latest?.value.discovered || {})) discovered[sha] = [...new Set([...(discovered[sha] || []), ...(taskIds as string[])])];
        // Once superseded, later pages also preserve the other window's committed position.
        value = { ...(latest?.value || value), discovered };
      }
      try {
        const receipt = await sendRuntimeDataRequest<{ revisions: Array<{ key: string; revision: number }> }>(input.globalDataPath!, { operation: 'write_growth_report_projection', input: { root: input.projectPath, updates: [{ key: cursorKey, value, expectedRevision: cursorRevision }] } });
        cursorRevision = receipt.revisions.find(row => row.key === cursorKey)!.revision; return;
      } catch (error) {
        if (!String(error).includes('revision_conflict')) throw error;
        cursorSuperseded = true;
      }
    }
  };
  const discovered: Record<string, string[]> = cursor.discovered || {};
  const since = tasks.map(task => task.startedAt).filter(Boolean).sort()[0];
  if (known.size && since) {
    let page = cursor.page || 1;
    let scanHead = cursor.scanHead || '';
    let boundaryFound = false;
    try {
      while (true) {
        const query = `per_page=100&page=${page}&since=${encodeURIComponent(since)}${scanHead ? `&sha=${scanHead}` : ''}`;
        const commits = await api(`repos/${repository}/commits?${query}`);
        if (!Array.isArray(commits)) throw new Error('Invalid commit list');
        if (!scanHead && commits[0]) scanHead = commits[0].sha;
        for (const commit of commits) {
          if (commit.sha === cursor.coveredHead) { boundaryFound = true; break; }
          if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error('Invalid commit SHA');
          const ids = taskTrailers(String(commit.commit?.message || ''), known);
          if (ids.length) discovered[commit.sha] = [...new Set([...(discovered[commit.sha] || []), ...ids])];
        }
        if (boundaryFound || commits.length < 100) {
          if (cursor.coveredHead && !boundaryFound) result.gaps.push('Previous commit boundary was not found; history may have changed.');
          await saveCursor({ discovered, coveredHead: !cursor.coveredHead || boundaryFound ? scanHead : cursor.coveredHead, scanHead: '', page: 1 });
          break;
        }
        page += 1;
        await saveCursor({ discovered, coveredHead: cursor.coveredHead, scanHead, page });
      }
    } catch (error: any) {
      await saveCursor({ discovered, coveredHead: cursor.coveredHead, scanHead, page });
      result.gaps.push(String(error.message));
    }
  }
  for (const report of reports) {
    if (!known.has(report.taskId)) continue;
    for (const commit of report.report?.commits || []) {
      if (commit.repository !== repository) { result.gaps.push('A reported commit belongs to a different repository.'); continue; }
      if (/^[a-f0-9]{40}$/.test(commit.sha)) discovered[commit.sha] = [...new Set([...(discovered[commit.sha] || []), report.taskId])];
    }
  }
  for (const [sha, ids] of Object.entries(discovered)) {
    const taskIds = ids.filter(id => known.has(id));
    if (!taskIds.length) continue;
    const evidence: any = { sha, repository, taskIds, observedAt: new Date().toISOString(), reportMissing: !reports.some(report => taskIds.includes(report.taskId) && report.report?.commits?.some((commit: any) => commit.sha === sha && commit.repository === repository)), files: [], checks: [], statuses: [], gaps: [] };
    try {
      let page = 1;
      while (true) {
        const commit = await api(`repos/${repository}/commits/${sha}?per_page=100&page=${page}`);
        if (commit.sha !== sha || !Array.isArray(commit.files)) throw new Error('Commit response does not match requested SHA');
        evidence.message = String(commit.commit?.message || '');
        evidence.files.push(...commit.files);
        if (commit.files.length < 100) break;
        if (evidence.files.length >= 3000) { evidence.gaps.push('GitHub commit file limit reached; diff may be incomplete.'); break; }
        page += 1;
      }
      evidence.remoteExists = true;
      evidence.commitObservedAt = evidence.observedAt;
      const trailerParagraph = evidence.message.trim().split(/\r?\n\s*\r?\n/).pop() || '';
      evidence.commitTaskIds = [...new Set(trailerParagraph.split(/\r?\n/).map((line: string) => line.match(/^SoloMap-Task:\s*(task-[A-Za-z0-9-]+)\s*$/)?.[1]).filter(Boolean))];
      evidence.diffComplete = evidence.gaps.length === 0 && evidence.files.every((file: any) => typeof file.patch === 'string' || file.changes === 0);
      if (!evidence.diffComplete) evidence.gaps.push('Some file patches are unavailable; inspect original artifacts before confirming their behavior.');
      const associatedReports = reports.filter(report => taskIds.includes(report.taskId)).flatMap(report => (report.report?.commits || []).filter((commit: any) => commit.sha === sha && commit.repository === repository).map((commit: any) => ({ taskId: report.taskId, files: commit.files })));
      evidence.reportedScopes = associatedReports;
      if (taskIds.length > 1 && taskIds.some(taskId => !associatedReports.some(scope => scope.taskId === taskId && scope.files.length))) evidence.gaps.push('Shared commit lacks per-task file scope; do not attribute its entire diff to each task.');
    } catch (error: any) { evidence.gaps.push(String(error.message)); }
    try {
      for (let page = 1; ; page += 1) {
        const checks = await api(`repos/${repository}/commits/${sha}/check-runs?per_page=100&page=${page}`);
        if (!Array.isArray(checks.check_runs) || checks.check_runs.some((run: any) => run.head_sha !== sha)) throw new Error('Check runs do not match requested SHA');
        evidence.checks.push(...checks.check_runs);
        if (checks.check_runs.length < 100) break;
      }
      evidence.checksObservedAt = evidence.observedAt;
    } catch (error: any) { evidence.gaps.push(String(error.message)); }
    try {
      for (let page = 1; ; page += 1) {
        const statuses = await api(`repos/${repository}/commits/${sha}/status?per_page=100&page=${page}`);
        if (statuses.sha !== sha || !Array.isArray(statuses.statuses)) throw new Error('Statuses do not match requested SHA');
        evidence.statuses.push(...statuses.statuses);
        if (statuses.statuses.length < 100) break;
      }
      evidence.statusesObservedAt = evidence.observedAt;
    } catch (error: any) { evidence.gaps.push(String(error.message)); }
    const old = previous?.commits?.find((item: any) => item.sha === sha && item.repository === repository);
    for (const [timeKey, fields] of [
      ['commitObservedAt', ['files', 'message', 'remoteExists', 'diffComplete', 'reportedScopes']],
      ['checksObservedAt', ['checks']], ['statusesObservedAt', ['statuses']]
    ] as [string, string[]][]) {
      if (!evidence[timeKey] && old?.[timeKey]) {
        evidence[timeKey] = old[timeKey];
        for (const field of fields) evidence[field] = old[field];
      }
    }
    result.commits.push(evidence);
  }
  // Read again at publication: another task scope may have completed while this request awaited GitHub.
  if (!persist) return result;
  for (;;) {
  const state = await loadFacts(); const latest = state.facts;
  const merged = new Map<string, any>((latest?.commits || []).map((commit: any) => [commit.sha, commit]));
  for (const commit of result.commits) {
    const old = merged.get(commit.sha);
    const combined = { ...commit, taskIds: [...new Set([...(old?.taskIds || []), ...commit.taskIds])] };
    const scopes = new Map<string, any>([...(old?.reportedScopes || []), ...(commit.reportedScopes || [])].map((scope: any) => [`${scope.taskId}:${JSON.stringify(scope.files)}`, scope]));
    combined.reportedScopes = [...scopes.values()];
    for (const [timeKey, fields] of [['commitObservedAt', ['files', 'message', 'remoteExists', 'diffComplete']], ['checksObservedAt', ['checks']], ['statusesObservedAt', ['statuses']]] as [string, string[]][]) {
      if (old?.[timeKey] && (!combined[timeKey] || old[timeKey] > combined[timeKey])) {
        combined[timeKey] = old[timeKey]; for (const field of fields) combined[field] = old[field];
      }
    }
    merged.set(commit.sha, combined);
  }
  const facts = { schemaVersion: 1, repository, observedAt: new Date().toISOString(), commits: [...merged.values()], gaps: result.gaps };
  const summary = {
    schemaVersion: 1, repository, observedAt: new Date().toISOString(), gaps: result.gaps,
    commits: [...merged.values()].map(({ message, files, checks, statuses, ...commit }) => ({
      ...commit, files: (files || []).map((file: any) => ({ filename: file.filename, status: file.status, previous_filename: file.previous_filename })),
      checks: (checks || []).map((check: any) => ({ id: check.id, head_sha: check.head_sha, name: check.name, status: check.status, conclusion: check.conclusion, html_url: check.html_url })),
      statuses: (statuses || []).map((status: any) => ({ id: status.id, context: status.context, state: status.state, target_url: status.target_url }))
    }))
  };
  try { await sendRuntimeDataRequest(input.globalDataPath!, { operation: 'write_github_facts', input: { root: input.projectPath, repository, expectedRevision: state.revision, facts, summary } }); }
  catch (error) { if (String(error).includes('revision_conflict')) continue; throw error; }
  break;
  }
  return result;
}

export interface ReviewSource { id: string; kind: string; projectPath?: string; file?: string; ref?: { objectId: string; revision: number; scope: string | null }; hash: string; contentHash?: string; size?: number; mtimeMs?: number; ctimeMs?: number; dev?: number; ino?: number; content?: string; value?: any; previousVersions?: any[] }

/** Old fact hashes identify semantic versions; contentHash identifies the complete transport bytes. */
export function legacyReviewSourceBody(source: ReviewSource): string {
  if (!source || typeof source.id !== 'string' || !source.id || source.id.includes(':') || typeof source.kind !== 'string'
    || !/^[a-f0-9]{64}$/.test(source.hash || '') || (source.previousVersions !== undefined && !Array.isArray(source.previousVersions))) throw new Error('legacy_review_source_invalid');
  const value = source.value;
  if (source.kind === 'github') {
    const { observedAt, ...stable } = value || {};
    if (!value || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository || '') || !/^[a-f0-9]{40}$/.test(value.sha || '')
      || source.id !== `github-${reviewHash(`${value.repository}:${value.sha}`).slice(0, 24)}` || source.hash !== reviewHash(JSON.stringify(stable))) throw new Error('legacy_review_source_invalid');
    const body = JSON.stringify(value);
    if (source.content !== undefined && source.content !== body) throw new Error('legacy_review_source_invalid');
    return body;
  }
  if (source.kind === 'deleted_source') {
    if (!value || typeof value.file !== 'string' || !value.file || typeof value.previousKind !== 'string' || !value.previousKind
      || !/^[a-f0-9]{64}$/.test(value.previousHash || '') || reviewHash(JSON.stringify(value)) !== source.hash) throw new Error('legacy_review_source_invalid');
    if (source.content === undefined && value.contentUnavailable === true) return JSON.stringify(value);
    if (typeof source.content !== 'string' || reviewHash(source.content) !== value.previousHash || value.contentUnavailable === true) throw new Error('legacy_review_source_invalid');
    return source.content;
  }
  if (typeof source.content !== 'string' || reviewHash(source.content) !== source.hash) throw new Error('legacy_review_source_invalid');
  return source.content;
}
export interface ReviewManifest {
  schemaVersion: 1; runId: string; globalRoot: string; globalPrompt: string; promptHash: string; persistedPromptHash?: string;
  projects: string[]; sources: ReviewSource[]; memory: { relativePath: string; hash: string; content: string }[]; gaps: string[];
  cursorUpdates?: ReviewSource[];
}
