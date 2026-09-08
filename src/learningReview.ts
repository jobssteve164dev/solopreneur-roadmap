import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as childProcess from 'child_process';
import { learningTasksRoot, readLearningJson, writeLearningJson } from './taskReport.js';

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

export async function collectGithubEvidence(input: {
  projectPath: string; repository: string; tasks: any[]; reports: any[]; api?: GithubRead;
}): Promise<{ repository: string; commits: any[]; gaps: string[] }> {
  const { repository, tasks, reports } = input;
  const result: { repository: string; commits: any[]; gaps: string[] } = { repository, commits: [], gaps: [] };
  if (!repository) { result.gaps.push('No GitHub origin; only local reports are available.'); return result; }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid GitHub repository');
  const api = input.api || readGithubApi;
  const known = new Set<string>(tasks.map(task => task.taskId));
  const root = path.join(input.projectPath, '.solopreneur', 'agent-runs', 'learning-evidence');
  const cursorFile = path.join(root, `${reviewHash(repository)}.json`);
  const cursor = readLearningJson(cursorFile) || { discovered: {}, coveredHead: '', page: 1, scanHead: '' };
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
          writeLearningJson(cursorFile, { discovered, coveredHead: !cursor.coveredHead || boundaryFound ? scanHead : cursor.coveredHead, scanHead: '', page: 1 });
          break;
        }
        page += 1;
        writeLearningJson(cursorFile, { discovered, coveredHead: cursor.coveredHead, scanHead, page });
      }
    } catch (error: any) {
      writeLearningJson(cursorFile, { discovered, coveredHead: cursor.coveredHead, scanHead, page });
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
    } catch (error: any) { evidence.gaps.push(String(error.message)); }
    try {
      for (let page = 1; ; page += 1) {
        const statuses = await api(`repos/${repository}/commits/${sha}/status?per_page=100&page=${page}`);
        if (statuses.sha !== sha || !Array.isArray(statuses.statuses)) throw new Error('Statuses do not match requested SHA');
        evidence.statuses.push(...statuses.statuses);
        if (statuses.statuses.length < 100) break;
      }
    } catch (error: any) { evidence.gaps.push(String(error.message)); }
    result.commits.push(evidence);
  }
  return result;
}

export interface ReviewSource { id: string; kind: string; projectPath?: string; file?: string; hash: string; value?: any }
export interface ReviewManifest {
  schemaVersion: 1; runId: string; globalRoot: string; globalPrompt: string; promptHash: string; persistedPromptHash?: string;
  projects: string[]; sources: ReviewSource[]; memory: { relativePath: string; hash: string; content: string }[]; gaps: string[];
}

export async function collectReviewManifest(input: { runId: string; globalRoot: string; globalPrompt: string; projects: string[]; api?: GithubRead; repositoryForProject?: (project: string) => Promise<string> }): Promise<ReviewManifest> {
  const manifest: ReviewManifest = { schemaVersion: 1, runId: input.runId, globalRoot: input.globalRoot, globalPrompt: input.globalPrompt, promptHash: reviewHash(input.globalPrompt), projects: input.projects, sources: [], memory: [], gaps: [] };
  const addFile = (file: string, kind: string, projectPath?: string) => {
    const content = fs.readFileSync(file, 'utf8');
    manifest.sources.push({ id: `source-${reviewHash(file).slice(0, 24)}`, kind, projectPath, file, hash: reviewHash(content) });
  };
  for (const project of input.projects) {
    const taskRoot = learningTasksRoot(project);
    const tasks = fs.existsSync(taskRoot) ? fs.readdirSync(taskRoot).filter(name => name.endsWith('.json')).map(name => readLearningJson(path.join(taskRoot, name))).filter(task => task?.schemaVersion === 1 && task.projectPath === project) : [];
    const reports: any[] = [];
    for (const task of tasks) {
      addFile(path.join(taskRoot, `${task.taskId}.json`), 'task', project);
      for (const run of task.executions || []) {
        if (!fs.existsSync(run.runDir)) continue;
        for (const name of fs.readdirSync(run.runDir).filter(name => /^task-report-\d+\.json$/.test(name))) {
          const file = path.join(run.runDir, name); const report = readLearningJson(file);
          if (report?.taskId !== task.taskId || report.projectPath !== project) continue;
          reports.push(report); addFile(file, 'agent_report', project);
        }
      }
    }
    try {
      const repository = await (input.repositoryForProject || projectGithubRepository)(project);
      const evidence = await collectGithubEvidence({ projectPath: project, repository, tasks, reports, api: input.api });
      manifest.gaps.push(...evidence.gaps.map(gap => `${project}: ${gap}`));
      for (const commit of evidence.commits) {
        const { observedAt, ...stableEvidence } = commit;
        manifest.sources.push({ id: `github-${reviewHash(`${repository}:${commit.sha}`).slice(0, 24)}`, kind: 'github', projectPath: project, hash: reviewHash(JSON.stringify(stableEvidence)), value: commit });
      }
    } catch (error: any) { manifest.gaps.push(`${project}: ${error.message}`); }
  }
  const walkMemory = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walkMemory(file);
      else if (entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
        const content = fs.readFileSync(file, 'utf8');
        manifest.memory.push({ relativePath: path.relative(path.join(input.globalRoot, 'memory'), file).replace(/\\/g, '/'), hash: reviewHash(content), content });
        addFile(file, 'memory');
      }
    }
  };
  walkMemory(path.join(input.globalRoot, 'memory'));
  for (const dir of ['candidates', 'approved', 'promotion-suggestions', 'candidate-decisions']) {
    const root = path.join(input.globalRoot, 'learning', dir);
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root).filter(name => name.endsWith('.json'))) {
      const file = path.join(root, name); const value = readLearningJson(file);
      if (value?.schemaVersion === 1 && input.projects.includes(value?.projectPath)) addFile(file, `legacy_${dir}` , value.projectPath);
    }
  }
  manifest.sources = manifest.sources.filter(source => {
    if (source.kind === 'memory' || source.kind === 'task' || source.kind.startsWith('legacy_')) return true;
    const decision = readLearningJson(path.join(input.globalRoot, 'learning', 'candidate-decisions', `semantic-${reviewHash(`${source.id}:${source.hash}`)}.json`));
    return !(decision?.schemaVersion === 2 && decision.id === source.id && decision.hash === source.hash && ['created', 'skipped'].includes(decision.decision));
  });
  return manifest;
}
