import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { collectGithubEvidence, GithubRead, projectGithubRepository, ReviewManifest, reviewHash } from './learningReview.js';
import { applyLearningReview, buildAgentExecutedLearningReviewPrompt, validateLearningReview } from './learningReviewApply.js';
import { readRegisteredTaskSources } from './growthReports.js';
import { learningTasksRoot, readLearningJson, writeLearningJson } from './taskReport.js';

const activeReviews = new Map<string, Promise<{ status: 'applied' | 'partial'; errors: string[] }>>();

interface ReviewLease { file: string; fd: number; token: string }

function processStartToken(pid: number): string {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(/\s+/)[21] || ''; } catch { return ''; }
}

function claimReviewLease(globalRoot: string, runId: string): ReviewLease {
  const file = path.join(globalRoot, 'maintenance', 'review.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomUUID();
  const createLease = (): ReviewLease => {
    const fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, processStart: processStartToken(process.pid), runId, token, startedAt: new Date().toISOString() }));
    return { file, fd, token };
  };
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return createLease();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let raw = '';
      try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
      let owner: any;
      try { owner = JSON.parse(raw); } catch { owner = undefined; }
      let alive = false; let ageMs = Number.POSITIVE_INFINITY;
      try { ageMs = Date.now() - fs.statSync(file).mtimeMs; } catch { ageMs = 0; }
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try {
          process.kill(owner.pid, 0);
          const currentStart = processStartToken(owner.pid);
          alive = owner.processStart && currentStart ? owner.processStart === currentStart : ageMs < 6 * 60 * 60_000;
        } catch (signalError) { alive = (signalError as NodeJS.ErrnoException).code !== 'ESRCH'; }
      } else {
        alive = ageMs < 5 * 60_000;
      }
      if (alive) throw new Error('另一窗口正在执行经验复盘；本次没有启动新的 Agent。');
      const recoveryDir = `${file}.recovery-${reviewHash(raw).slice(0, 24)}`;
      let recoveryOwned = false;
      try {
        try { fs.mkdirSync(recoveryDir); recoveryOwned = true; }
        catch (claimError) {
          if ((claimError as NodeJS.ErrnoException).code !== 'EEXIST') throw claimError;
          let claimAge = 0; try { claimAge = Date.now() - fs.statSync(recoveryDir).mtimeMs; } catch { continue; }
          if (claimAge < 5 * 60_000) throw new Error('另一窗口正在恢复经验复盘锁；本次没有启动新的 Agent。');
          try { fs.rmdirSync(recoveryDir); } catch { continue; }
          continue;
        }
        let current = '';
        try { current = fs.readFileSync(file, 'utf8'); } catch { continue; }
        if (current !== raw) continue;
        fs.unlinkSync(file);
        return createLease();
      } finally {
        if (recoveryOwned) try { fs.rmdirSync(recoveryDir); } catch { /* ephemeral recovery claim */ }
      }
    }
  }
  throw new Error('无法取得经验复盘执行锁。');
}

function releaseReviewLease(lease: ReviewLease): void {
  try { fs.closeSync(lease.fd); } catch { /* already closed */ }
  try {
    const owner = readLearningJson(lease.file);
    if (owner?.token === lease.token) fs.unlinkSync(lease.file);
  } catch { /* a lost ephemeral lease cannot apply review output */ }
}

function isWithin(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isSafeSourceFile(root: string, file: string): boolean {
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
}

function pendingReviewApplications(globalRoot: string, currentRunDir: string): Array<{ runDir: string; status: string; application: any }> {
  const runsRoot = path.join(globalRoot, 'maintenance', 'runs');
  if (!fs.existsSync(runsRoot)) return [];
  const pending: Array<{ runDir: string; status: string; application: any }> = [];
  for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const runDir = path.join(runsRoot, entry.name);
    if (path.resolve(runDir) === path.resolve(currentRunDir)) continue;
    const application = readLearningJson(path.join(runDir, 'application.json'));
    if (application && ['partial', 'applying'].includes(application.status)) pending.push({ runDir, status: application.status, application });
  }
  return pending;
}

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function comparableGithubEvidence(value: any): any {
  if (!value || typeof value !== 'object') return value;
  const result: any = {};
  for (const [key, item] of Object.entries(value)) if (key !== 'observedAt' && !key.endsWith('ObservedAt')) result[key] = item;
  return result;
}

function immutableGithubEvidence(value: any): any {
  const result: any = {};
  for (const key of ['repository', 'sha', 'taskIds', 'reportMissing', 'message', 'remoteExists', 'commitTaskIds', 'diffComplete', 'reportedScopes', 'files']) if (value?.[key] !== undefined) result[key] = value[key];
  return result;
}

function githubStatusAdvancedSafely(declared: any, actual: any): boolean {
  if (declared?.status === actual?.status && declared?.conclusion === actual?.conclusion) return true;
  return declared?.status !== 'completed' && actual?.status === 'completed' && ['success', 'neutral', 'skipped'].includes(actual?.conclusion);
}

function githubCommitStatusAdvancedSafely(declared: any, actual: any): boolean {
  if (declared?.state === actual?.state) return true;
  return ['pending', 'queued'].includes(declared?.state) && actual?.state === 'success';
}

function verifyGithubValue(declared: any, actual: any): boolean {
  if (canonical(immutableGithubEvidence(declared)) !== canonical(immutableGithubEvidence(actual))) return false;
  const declaredChecks = Array.isArray(declared?.checks) ? declared.checks : []; const actualChecks = Array.isArray(actual?.checks) ? actual.checks : [];
  if (declaredChecks.length !== actualChecks.length || declaredChecks.some((check: any) => {
    const current = actualChecks.find((item: any) => item.id === check.id && item.head_sha === check.head_sha && item.name === check.name);
    return !current || !githubStatusAdvancedSafely(check, current);
  })) return false;
  const declaredStatuses = Array.isArray(declared?.statuses) ? declared.statuses : []; const actualStatuses = Array.isArray(actual?.statuses) ? actual.statuses : [];
  if (declaredStatuses.length !== actualStatuses.length || declaredStatuses.some((status: any) => {
    const current = actualStatuses.find((item: any) => item.id === status.id && item.context === status.context);
    return !current || !githubCommitStatusAdvancedSafely(status, current);
  })) return false;
  return (actual?.gaps || []).every((gap: string) => (declared?.gaps || []).includes(gap));
}

async function verifyGithubSources(manifest: ReviewManifest, api?: GithubRead): Promise<void> {
  const actual = new Map<string, any>();
  for (const project of manifest.projects) {
    const repository = await projectGithubRepository(project);
    const { tasks, reports } = readRegisteredTaskSources(project);
    const evidence = await collectGithubEvidence({ projectPath: project, repository, tasks, reports, api, persist: false });
    for (const gap of evidence.gaps) if (!manifest.gaps.some(item => typeof item === 'string' && item.includes(gap))) throw new Error(`复盘 Agent 未记录 GitHub 核验缺口：${project}`);
    for (const commit of evidence.commits) actual.set(`${project}:${repository}:${commit.sha}`, commit);
  }
  const declared = manifest.sources.filter(source => source.kind === 'github');
  for (const source of declared) {
    const key = `${source.projectPath}:${source.value?.repository}:${source.value?.sha}`;
    const verified = actual.get(key);
    if (!verified || !verifyGithubValue(source.value, verified)) throw new Error('复盘 Agent 生成的 GitHub 来源与退出后核验的真实事实不一致，材料已保留。');
  }
  for (const [key, value] of actual) {
    if (!declared.some(source => `${source.projectPath}:${source.value?.repository}:${source.value?.sha}` === key
      && verifyGithubValue(source.value, value))) {
      throw new Error('复盘 Agent 生成的 GitHub 证据清单不完整，材料已保留。');
    }
  }
}

function readVerifiedPendingIntent(pending: { runDir: string; application: any }): { keys: string[]; proposal: any; manifest: ReviewManifest } {
  const items = pending.application?.items || {};
  const result = readLearningJson(path.join(pending.runDir, 'result.json'));
  const oldProposalFile = result?.proposalFile;
  const oldReviewFile = result?.checkFile; const oldManifest = readLearningJson(path.join(pending.runDir, 'manifest.json')) as ReviewManifest | undefined;
  const oldProposal = typeof oldProposalFile === 'string' && path.dirname(oldProposalFile) === pending.runDir ? readLearningJson(oldProposalFile) : undefined;
  const oldReview = typeof oldReviewFile === 'string' && path.dirname(oldReviewFile) === pending.runDir ? readLearningJson(oldReviewFile) : undefined;
  if (!oldManifest || !oldProposal || !oldReview || pending.application.proposalHash !== reviewHash(JSON.stringify(oldProposal))) throw new Error(`旧部分应用缺少可核验提案：${pending.runDir}`);
  validateLearningReview(oldManifest, oldProposal, oldReview);
  const keys = [
    ...(oldProposal.globalPrompt !== null ? ['globalPrompt'] : []),
    ...(oldProposal.memoryChanges || []).map((change: any) => `memory:${change.path}`),
    ...(oldProposal.lessons || []).map((_lesson: any, index: number) => `lesson:${index}`)
  ].filter(key => !items[key]);
  return { keys, proposal: oldProposal, manifest: oldManifest };
}

function pendingRecoveryItems(pending: { runDir: string; application: any }, proposal: any): string[] {
  const verified = readVerifiedPendingIntent(pending);
  const { keys, proposal: oldProposal, manifest: oldManifest } = verified;
  for (const key of keys) {
    if (key === 'globalPrompt' && proposal.globalPrompt && proposal.globalPrompt.value === oldProposal.globalPrompt?.value) continue;
    if (key.startsWith('memory:')) {
      const oldChange = oldProposal.memoryChanges?.find((change: any) => `memory:${change.path}` === key);
      if (oldChange && proposal.memoryChanges?.some((change: any) => `memory:${change.path}` === key && change.after === oldChange.after)) continue;
    }
    if (key.startsWith('lesson:')) {
      const oldIndex = Number(key.slice('lesson:'.length));
      const oldLesson = oldProposal.lessons?.[oldIndex];
      const oldId = oldLesson?.id || `lesson-${reviewHash(`${oldManifest.runId}:${oldIndex}`).slice(0, 24)}`;
      const semantic = (lesson: any) => canonical(Object.fromEntries(Object.entries(lesson || {}).filter(([name]) => name !== 'id')));
      if (oldLesson && proposal.lessons?.some((lesson: any) => lesson.id === oldId && semantic(lesson) === semantic(oldLesson))) continue;
    }
    throw new Error(`新提案未承接旧部分应用项目 ${key}：${pending.runDir}`);
  }
  return keys.sort();
}

interface RequiredReviewSource { kinds: Set<string>; projectPath?: string }

async function requiredLocalReviewSources(globalRoot: string, projects: string[]): Promise<Map<string, RequiredReviewSource>> {
  const required = new Map<string, RequiredReviewSource>();
  const add = (file: string, kind: string, sourceRoot: string, projectPath?: string) => {
    const resolved = path.resolve(file);
    if (!isSafeSourceFile(sourceRoot, resolved)) return;
    const current = required.get(resolved) || { kinds: new Set<string>(), projectPath };
    current.kinds.add(kind); required.set(resolved, current);
  };
  const addJsonDirectory = (directory: string, kind: string, sourceRoot: string, projectPath?: string) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.json')) add(path.join(directory, entry.name), kind, sourceRoot, projectPath);
  };
  const walkMemory = (directory: string) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walkMemory(file);
      else if (entry.name.endsWith('.md') && !entry.name.startsWith('_')) add(file, 'memory', globalRoot);
    }
  };
  add(path.join(globalRoot, 'context', 'global-default-prompt.md'), 'global_prompt_mirror', globalRoot);
  walkMemory(path.join(globalRoot, 'memory'));
  addJsonDirectory(path.join(globalRoot, 'memory', 'entries'), 'memory_entry', globalRoot);
  add(path.join(globalRoot, 'learning', 'ledger', 'index.json'), 'learning_ledger', globalRoot);
  add(path.join(globalRoot, 'learning', 'ledger', 'events.jsonl'), 'learning_ledger', globalRoot);
  addJsonDirectory(path.join(globalRoot, 'learning', 'ledger', 'sources'), 'learning_event_source', globalRoot);
  for (const directory of ['candidates', 'approved', 'rejected', 'promotion-suggestions', 'candidate-decisions']) {
    const directoryPath = path.join(globalRoot, 'learning', directory);
    if (!fs.existsSync(directoryPath)) continue;
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(directoryPath, entry.name); const value = readLearningJson(file);
      if (directory === 'candidate-decisions' && [1, 2].includes(value?.schemaVersion)) add(file, `legacy_${directory}`, globalRoot);
      else if (value?.schemaVersion === 1 && projects.includes(value?.projectPath)) add(file, `legacy_${directory}`, globalRoot, value.projectPath);
    }
  }
  for (const project of projects) {
    add(path.join(project, 'agent.md'), 'project_constraint', project, project); add(path.join(project, 'AGENTS.md'), 'project_constraint', project, project);
    add(path.join(project, 'PROJECT_MEMORY.md'), 'project_memory_legacy', project, project);
    const documentationFile = path.join(project, '.solopreneur', 'documentation.json');
    add(documentationFile, 'project_document_index', project, project);
    const documentation = readLearningJson(documentationFile);
    for (const item of Array.isArray(documentation?.documents) ? documentation.documents : []) if (item?.status === 'active' && typeof item.path === 'string') add(path.resolve(project, item.path), 'project_document', project, project);
    addJsonDirectory(path.join(project, '.solopreneur', 'run-digests'), 'run_digest', project, project);
    const taskRoot = learningTasksRoot(project);
    const { tasks, observations } = readRegisteredTaskSources(project);
    for (const task of tasks) {
      add(path.join(taskRoot, `${task.taskId}.json`), 'task', project, project);
      for (const observation of observations.filter(item => item.taskId === task.taskId && item.envelope)) add(observation.file, 'agent_report', project, project);
    }
  }
  return required;
}

export function runManualLearningReview(input: {
  runDir: string; globalRoot: string; workspaceRoot?: string; projects: string[]; globalPrompt: string; persistedGlobalPrompt?: string;
  getGlobalPrompt: () => string; setGlobalPrompt: (value: string, expectedHash: string) => Promise<void>;
  onStart?: () => void; getProjects?: () => string[];
  launch: (promptFile: string, resultFile: string) => Promise<void>; api?: GithubRead;
}): Promise<{ status: 'applied' | 'partial'; errors: string[] }> {
  const key = path.resolve(input.globalRoot);
  const existing = activeReviews.get(key);
  if (existing) return existing;
  let lease: ReviewLease;
  try { lease = claimReviewLease(input.globalRoot, path.basename(input.runDir)); }
  catch (error) { return Promise.reject(error); }
  try { input.onStart?.(); }
  catch (error) { releaseReviewLease(lease); return Promise.reject(error); }
  const operation = Promise.resolve().then(async () => {
    const runId = path.basename(input.runDir);
    fs.mkdirSync(input.runDir, { recursive: true });
    const manifestFile = path.join(input.runDir, 'manifest.json');
    const proposalFile = path.join(input.runDir, 'proposal.json');
    const checkFile = path.join(input.runDir, 'review.json');
    const promptFile = path.join(input.runDir, 'prompt.txt');
    fs.writeFileSync(promptFile, buildAgentExecutedLearningReviewPrompt({
      runId, runDir: input.runDir, workspaceRoot: input.workspaceRoot || '', globalRoot: input.globalRoot,
      globalPrompt: input.globalPrompt, persistedPromptHash: reviewHash(input.persistedGlobalPrompt ?? input.globalPrompt),
      manifestFile, proposalFile, reviewFile: checkFile
    }), 'utf8');
    await input.launch(promptFile, proposalFile);
    const manifest = readLearningJson(manifestFile) as ReviewManifest | undefined;
    if (!manifest || manifest.schemaVersion !== 1 || manifest.runId !== runId || manifest.globalRoot !== input.globalRoot
      || manifest.globalPrompt !== input.globalPrompt || manifest.promptHash !== reviewHash(input.globalPrompt)
      || manifest.persistedPromptHash !== reviewHash(input.persistedGlobalPrompt ?? input.globalPrompt)
      || !Array.isArray(manifest.projects) || !Array.isArray(manifest.sources) || !Array.isArray(manifest.memory) || !Array.isArray(manifest.gaps)) {
      throw new Error('复盘 Agent 未生成与本次请求匹配的证据清单，材料已保留。');
    }
    const allowedProjects = input.getProjects ? input.getProjects() : input.projects;
    if (JSON.stringify([...manifest.projects].sort()) !== JSON.stringify([...allowedProjects].sort())) throw new Error('复盘 Agent 生成的项目范围与当前登记项目不一致，材料已保留。');
    const requiredSources = await requiredLocalReviewSources(input.globalRoot, manifest.projects);
    const sourceIds = new Set<string>();
    for (const source of manifest.sources) {
      if (typeof source.id !== 'string' || !source.id || sourceIds.has(source.id) || !/^[a-f0-9]{64}$/.test(source.hash)) throw new Error('复盘 Agent 生成了无效来源标识或哈希，材料已保留。');
      sourceIds.add(source.id);
      if (source.projectPath && !manifest.projects.includes(source.projectPath)) throw new Error('复盘 Agent 生成的来源项目未登记，材料已保留。');
      if (source.file) {
        const sourceRoot = isWithin(input.globalRoot, source.file) ? input.globalRoot : source.projectPath && isWithin(source.projectPath, source.file) ? source.projectPath : '';
        if (!path.isAbsolute(source.file) || !sourceRoot) throw new Error('复盘 Agent 生成的来源范围超出登记项目和全局数据目录，材料已保留。');
        if (!isSafeSourceFile(sourceRoot, source.file)) throw new Error('复盘 Agent 生成的来源文件不存在或经过符号链接，材料已保留。');
        const expected = requiredSources.get(path.resolve(source.file));
        if (!expected || !expected.kinds.has(source.kind) || expected.projectPath !== source.projectPath) throw new Error('复盘 Agent 生成的文件来源不在正式材料清单中，材料已保留。');
        if (reviewHash(fs.readFileSync(source.file, 'utf8')) !== source.hash) throw new Error('复盘 Agent 生成的文件来源哈希不匹配，材料已保留。');
      } else if (source.kind === 'github') {
        const value = source.value;
        if (!source.projectPath || !value || typeof value !== 'object' || !/^[^/\s]+\/[^/\s]+$/.test(value.repository)
          || !/^[a-f0-9]{40}$/.test(value.sha) || !Array.isArray(value.files) || !Array.isArray(value.checks) || !Array.isArray(value.statuses) || !Array.isArray(value.gaps)) {
          throw new Error('复盘 Agent 生成的 GitHub 来源结构无效，材料已保留。');
        }
        const stableValue = comparableGithubEvidence(value);
        if (reviewHash(JSON.stringify(stableValue)) !== source.hash) throw new Error('复盘 Agent 生成的 GitHub 来源哈希不匹配，材料已保留。');
      } else {
        throw new Error('复盘 Agent 生成了没有可复核文件的来源，材料已保留。');
      }
    }
    for (const [file, expected] of requiredSources) {
      if (!manifest.sources.some(source => source.file === file && expected.kinds.has(source.kind)
        && source.projectPath === expected.projectPath && source.hash === reviewHash(fs.readFileSync(file, 'utf8')))) {
        throw new Error(`复盘 Agent 生成的证据清单不完整，缺少正式材料：${file}`);
      }
    }
    await verifyGithubSources(manifest, input.api);
    const memoryRoot = path.join(input.globalRoot, 'memory');
    const memoryPaths = new Set<string>();
    for (const item of manifest.memory) {
      if (typeof item.relativePath !== 'string' || !item.relativePath.endsWith('.md') || path.isAbsolute(item.relativePath)
        || item.relativePath.split('/').some(part => !part || part === '.' || part === '..') || memoryPaths.has(item.relativePath)
        || typeof item.content !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash) || reviewHash(item.content) !== item.hash) {
        throw new Error('复盘 Agent 生成的记忆清单内容或路径无效，材料已保留。');
      }
      memoryPaths.add(item.relativePath);
      const file = path.join(memoryRoot, ...item.relativePath.split('/'));
      if (!isSafeSourceFile(memoryRoot, file) || reviewHash(fs.readFileSync(file, 'utf8')) !== item.hash
        || !manifest.sources.some(source => source.file === file && source.hash === item.hash)) {
        throw new Error('复盘 Agent 生成的记忆清单与当前文件不匹配，材料已保留。');
      }
    }
    for (const [file, expected] of requiredSources) {
      if (!expected.kinds.has('memory')) continue;
      const relativePath = path.relative(memoryRoot, file).replace(/\\/g, '/');
      if (!manifest.memory.some(item => item.relativePath === relativePath && item.hash === reviewHash(fs.readFileSync(file, 'utf8')) && item.content === fs.readFileSync(file, 'utf8'))) {
        throw new Error(`复盘 Agent 生成的记忆正文清单不完整：${file}`);
      }
    }
    const proposal = readLearningJson(proposalFile);
    if (!proposal) throw new Error('复盘未生成完整结果，材料已保留。');
    const pendingApplications = pendingReviewApplications(input.globalRoot, input.runDir);
    if (!Array.isArray(proposal.recovery) || proposal.recovery.length !== pendingApplications.length) throw new Error('复盘 Agent 未完整生成旧部分应用的恢复处置，材料已保留。');
    for (const pending of pendingApplications) {
      const disposition = Array.isArray(proposal.recovery) && proposal.recovery.find((item: any) => item?.runDir === pending.runDir && item?.status === pending.status);
      if (!disposition || !['resumed', 'superseded'].includes(disposition.decision) || typeof disposition.reason !== 'string' || !disposition.reason.trim() || !Array.isArray(disposition.items)) {
        throw new Error(`复盘 Agent 未完成旧部分应用的恢复处置：${pending.runDir}，材料已保留。`);
      }
      if (disposition.decision === 'resumed') {
        const expectedItems = pendingRecoveryItems(pending, proposal);
        if (canonical([...disposition.items].sort()) !== canonical(expectedItems)) throw new Error(`复盘 Agent 未精确承接旧部分应用：${pending.runDir}`);
      } else {
        if (disposition.items.length) throw new Error(`已取代的旧部分应用不能声明承接项目：${pending.runDir}`);
        let verified: ReturnType<typeof readVerifiedPendingIntent> | undefined;
        try { verified = readVerifiedPendingIntent(pending); } catch { verified = undefined; }
        if (verified) {
          const onlyStalePrompt = verified.keys.length > 0 && verified.keys.every(key => key === 'globalPrompt') && verified.manifest.globalPrompt !== input.globalPrompt;
          if (!onlyStalePrompt) throw new Error(`可核验的旧部分应用必须由新提案承接：${pending.runDir}`);
        }
      }
    }
    const review = readLearningJson(checkFile);
    if (!review) throw new Error('复盘子智能体未生成完整复核结果，材料已保留。');
    if (review.verdict !== 'pass') throw new Error('复盘子智能体尚未通过最终提案，材料已保留。');
    if (review.provenance?.method !== 'subagent' || review.provenance.parentRunId !== runId
      || typeof review.provenance.childRunId !== 'string' || !review.provenance.childRunId.trim() || review.provenance.childRunId === runId) {
      throw new Error('复盘子智能体缺少可区分的执行凭据，材料已保留。');
    }
    proposal.recovery.forEach((_item: any, index: number) => {
      if (!review.checks?.some((check: any) => check.target === `recovery:${index}` && check.safe === true && typeof check.reason === 'string' && check.reason.trim())) throw new Error(`复盘子智能体未复核 recovery:${index}，材料已保留。`);
    });
    writeLearningJson(path.join(input.runDir, 'result.json'), { proposalFile, checkFile });
    const applied = await applyLearningReview({ ...input, manifest, proposal, review });
    if (applied.status === 'applied') {
      for (const disposition of proposal.recovery) {
        const applicationFile = path.join(disposition.runDir, 'application.json'); const application = readLearningJson(applicationFile);
        writeLearningJson(applicationFile, { ...application, status: disposition.decision, recoveredBy: runId, recoveryReason: disposition.reason });
      }
    }
    return applied;
  }).finally(() => { activeReviews.delete(key); releaseReviewLease(lease); });
  activeReviews.set(key, operation);
  return operation;
}

export function buildLearningReviewRunScript(command: string, cwd: string, output: string, done: string, quote: (value: string) => string): string {
  const finish = 'const fs=require("fs");const file=process.argv[1];const tmp=file+"."+process.pid+".tmp";fs.writeFileSync(tmp,JSON.stringify({exitCode:Number(process.argv[2])}));fs.renameSync(tmp,file);';
  return [
    '#!/usr/bin/env bash',
    'set +e',
    `trap ${quote(`solomap_review_exit=$?; trap - EXIT; node -e ${quote(finish)} ${quote(done)} "$solomap_review_exit"`)} EXIT`,
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    `cd ${quote(cwd)} || exit 1`,
    `( ${command} ) 2>&1 | tee ${quote(output)}`,
    'solomap_review_exit=${PIPESTATUS[0]}',
    'exit "$solomap_review_exit"',
    ''
  ].join('\n');
}
