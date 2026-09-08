import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as childProcess from 'child_process';
import { learningTasksRoot, readLearningJson, writeLearningJson } from './taskReport.js';
import { readRegisteredProjectSources } from './growthReports.js';

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
  projectPath: string; repository: string; tasks: any[]; reports: any[]; api?: GithubRead;
};
type GithubEvidence = { repository: string; commits: any[]; gaps: string[] };
const factRequests = new Map<string, Promise<GithubEvidence>>();

export function collectGithubEvidence(input: EvidenceInput): Promise<GithubEvidence> {
  const scope = reviewHash(input.tasks.map(task => task.taskId).sort().join('\n'));
  const key = `${input.projectPath}:${input.repository}:${scope}`;
  const pending = factRequests.get(key); if (pending) return pending;
  const operation = collectGithubFacts(input, scope).finally(() => factRequests.delete(key));
  factRequests.set(key, operation); return operation;
}

async function collectGithubFacts(input: EvidenceInput, scope: string): Promise<GithubEvidence> {
  const { repository, tasks, reports } = input;
  const result: { repository: string; commits: any[]; gaps: string[] } = { repository, commits: [], gaps: [] };
  if (!repository) { result.gaps.push('No GitHub origin; only local reports are available.'); return result; }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid GitHub repository');
  const api = input.api || readGithubApi;
  const known = new Set<string>(tasks.map(task => task.taskId));
  const root = path.join(input.projectPath, '.solopreneur', 'agent-runs', 'learning-evidence');
  const cursorFile = path.join(root, `${reviewHash(repository)}-${scope}.json`);
  const factsFile = path.join(root, `${reviewHash(repository)}.facts.json`);
  const previous = readLearningJson(factsFile);
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
  const latest = readLearningJson(factsFile);
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
  writeLearningJson(factsFile, { schemaVersion: 1, repository, observedAt: new Date().toISOString(), commits: [...merged.values()], gaps: result.gaps });
  writeLearningJson(factsFile.replace('.facts.json', '.summary.json'), {
    schemaVersion: 1, repository, observedAt: new Date().toISOString(), gaps: result.gaps,
    commits: [...merged.values()].map(({ message, files, checks, statuses, ...commit }) => ({
      ...commit, files: (files || []).map((file: any) => ({ filename: file.filename, status: file.status, previous_filename: file.previous_filename })),
      checks: (checks || []).map((check: any) => ({ id: check.id, head_sha: check.head_sha, name: check.name, status: check.status, conclusion: check.conclusion, html_url: check.html_url })),
      statuses: (statuses || []).map((status: any) => ({ id: status.id, context: status.context, state: status.state, target_url: status.target_url }))
    }))
  });
  return result;
}

export interface ReviewSource { id: string; kind: string; projectPath?: string; file?: string; hash: string; value?: any }
export interface ReviewManifest {
  schemaVersion: 1; runId: string; globalRoot: string; globalPrompt: string; promptHash: string; persistedPromptHash?: string;
  projects: string[]; sources: ReviewSource[]; memory: { relativePath: string; hash: string; content: string }[]; gaps: string[];
}

export async function collectReviewManifest(input: { runId: string; globalRoot: string; globalPrompt: string; projects: string[]; api?: GithubRead; repositoryForProject?: (project: string) => Promise<string> }): Promise<ReviewManifest> {
  const manifest: ReviewManifest = { schemaVersion: 1, runId: input.runId, globalRoot: input.globalRoot, globalPrompt: input.globalPrompt, promptHash: reviewHash(input.globalPrompt), projects: input.projects, sources: [], memory: [], gaps: [] };
  const safeFile = (root: string, file: string): boolean => {
    try {
      const relative = path.relative(path.resolve(root), path.resolve(file));
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
      let current = path.resolve(root);
      for (const part of relative.split(path.sep)) {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) return false;
      }
      return fs.statSync(current).isFile();
    } catch { return false; }
  };
  const addFile = (file: string, kind: string, projectPath?: string) => {
    if (manifest.sources.some(source => source.file === file && source.kind === kind)) return;
    const content = fs.readFileSync(file, 'utf8');
    const originalId = `source-${reviewHash(file).slice(0, 24)}`;
    const id = manifest.sources.some(source => source.id === originalId) ? `source-${reviewHash(`${file}:${kind}`).slice(0, 24)}` : originalId;
    manifest.sources.push({ id, kind, projectPath, file, hash: reviewHash(content) });
  };
  const addDirectoryFiles = (root: string, directory: string, kind: string, projectPath?: string, pattern = /\.json$/) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isFile() && pattern.test(entry.name) && safeFile(root, file)) addFile(file, kind, projectPath);
    }
  };
  const promptMirror = path.join(input.globalRoot, 'context', 'global-default-prompt.md');
  if (safeFile(input.globalRoot, promptMirror)) addFile(promptMirror, 'global_prompt_mirror');
  for (const project of input.projects) {
    for (const name of ['agent.md', 'AGENTS.md']) {
      const file = path.join(project, name);
      if (safeFile(project, file)) addFile(file, 'project_constraint', project);
    }
    const legacyProjectMemory = path.join(project, 'PROJECT_MEMORY.md');
    if (safeFile(project, legacyProjectMemory)) addFile(legacyProjectMemory, 'project_memory_legacy', project);
    const documentationFile = path.join(project, '.solopreneur', 'documentation.json');
    if (safeFile(project, documentationFile)) {
      addFile(documentationFile, 'project_document_index', project);
      const documentation = readLearningJson(documentationFile);
      for (const item of Array.isArray(documentation?.documents) ? documentation.documents : []) {
        if (item?.status !== 'active' || typeof item.path !== 'string') continue;
        const file = path.resolve(project, item.path);
        if (safeFile(project, file)) addFile(file, 'project_document', project);
      }
    }
    addDirectoryFiles(project, path.join(project, '.solopreneur', 'run-digests'), 'run_digest', project);
    const taskRoot = learningTasksRoot(project);
    const { tasks, reports, observations } = await readRegisteredProjectSources(project, path.resolve(__dirname, '..'));
    for (const task of tasks) {
      addFile(path.join(taskRoot, `${task.taskId}.json`), 'task', project);
      for (const observation of observations.filter(item => item.taskId === task.taskId && item.envelope)) addFile(observation.file, 'agent_report', project);
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
  addDirectoryFiles(input.globalRoot, path.join(input.globalRoot, 'memory', 'entries'), 'memory_entry');
  for (const name of ['index.json', 'events.jsonl']) {
    const file = path.join(input.globalRoot, 'learning', 'ledger', name);
    if (safeFile(input.globalRoot, file)) addFile(file, 'learning_ledger');
  }
  addDirectoryFiles(input.globalRoot, path.join(input.globalRoot, 'learning', 'ledger', 'sources'), 'learning_event_source');
  for (const dir of ['candidates', 'approved', 'rejected', 'promotion-suggestions', 'candidate-decisions']) {
    const root = path.join(input.globalRoot, 'learning', dir);
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root).filter(name => name.endsWith('.json'))) {
      const file = path.join(root, name); const value = readLearningJson(file);
      if (dir === 'candidate-decisions' && [1, 2].includes(value?.schemaVersion)) addFile(file, `legacy_${dir}`);
      else if (value?.schemaVersion === 1 && input.projects.includes(value?.projectPath)) addFile(file, `legacy_${dir}` , value.projectPath);
    }
  }
  manifest.sources = manifest.sources.filter(source => {
    if (['memory', 'memory_entry', 'task', 'global_prompt_mirror', 'project_constraint', 'project_memory_legacy', 'project_document_index', 'project_document', 'run_digest', 'learning_ledger', 'learning_event_source'].includes(source.kind) || source.kind.startsWith('legacy_')) return true;
    const decision = readLearningJson(path.join(input.globalRoot, 'learning', 'candidate-decisions', `semantic-${reviewHash(`${source.id}:${source.hash}`)}.json`));
    return !(decision?.schemaVersion === 2 && decision.id === source.id && decision.hash === source.hash && ['created', 'skipped'].includes(decision.decision));
  });
  return manifest;
}
