import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { collectGithubEvidence, GithubRead, projectGithubRepository, registeredReviewSourceFiles, ReviewManifest, reviewHash } from './learningReview.js';
import { applyLearningReview, buildAgentExecutedLearningReviewPrompt, validateDirectGlobalPromptReview, validateLearningReview } from './learningReviewApply.js';
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

function isDeclaredReviewSource(globalRoot: string, source: any): boolean {
  if (!source?.file || typeof source.kind !== 'string') return false;
  const file = path.resolve(source.file);
  const within = (root: string, ...parts: string[]) => isWithin(path.join(root, ...parts), file);
  if (source.kind === 'global_prompt_mirror') return file === path.join(globalRoot, 'context', 'global-default-prompt.md');
  if (source.kind === 'memory') return within(globalRoot, 'memory') && file.endsWith('.md');
  if (source.kind === 'memory_entry') return within(globalRoot, 'memory', 'entries') && file.endsWith('.json');
  if (source.kind === 'learning_ledger') return [path.join(globalRoot, 'learning', 'ledger', 'index.json'), path.join(globalRoot, 'learning', 'ledger', 'events.jsonl')].includes(file);
  if (source.kind === 'learning_event_source') return within(globalRoot, 'learning', 'ledger', 'sources') && file.endsWith('.json');
  const legacy = source.kind.match(/^legacy_(candidates|approved|rejected|promotion-suggestions)$/)?.[1];
  if (legacy) return within(globalRoot, 'learning', legacy) && file.endsWith('.json');
  if (!source.projectPath) return false;
  const project = path.resolve(source.projectPath);
  if (source.kind === 'project_constraint') return [path.join(project, 'agent.md'), path.join(project, 'AGENTS.md')].includes(file);
  if (source.kind === 'project_memory_legacy') return file === path.join(project, 'PROJECT_MEMORY.md');
  if (source.kind === 'project_document_index') return file === path.join(project, '.solopreneur', 'documentation.json');
  if (source.kind === 'project_document') return isWithin(project, file);
  if (source.kind === 'run_digest') return within(project, '.solopreneur', 'run-digests') && file.endsWith('.json');
  if (source.kind === 'task') return within(project, '.solopreneur', 'agent-runs', 'learning-tasks') && file.endsWith('.json');
  return source.kind === 'agent_report' && within(project, '.solopreneur', 'agent-runs') && file.endsWith('.json');
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

function sourceMetadataMatches(source: any, stat: fs.Stats): boolean {
  return source?.size === stat.size && source?.mtimeMs === stat.mtimeMs && source?.ctimeMs === stat.ctimeMs
    && source?.dev === stat.dev && source?.ino === stat.ino;
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

async function requiredLocalReviewSources(globalRoot: string, projects: string[], previousSources: Record<string, any> = {}): Promise<Map<string, RequiredReviewSource>> {
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
  for (const project of projects) {
    add(path.join(project, 'agent.md'), 'project_constraint', project, project); add(path.join(project, 'AGENTS.md'), 'project_constraint', project, project);
    add(path.join(project, 'PROJECT_MEMORY.md'), 'project_memory_legacy', project, project);
    const documentationFile = path.join(project, '.solopreneur', 'documentation.json');
    add(documentationFile, 'project_document_index', project, project);
    const previousIndex = Object.values(previousSources).find((source: any) => source?.file === documentationFile && source?.kind === 'project_document_index');
    if (previousIndex && fs.existsSync(documentationFile) && sourceMetadataMatches(previousIndex, fs.statSync(documentationFile))) {
      const declared = Array.isArray((previousIndex as any)?.value?.activeDocumentPaths)
        ? (previousIndex as any).value.activeDocumentPaths
        : (Array.isArray(readLearningJson(documentationFile)?.documents) ? readLearningJson(documentationFile).documents : [])
            .filter((item: any) => item?.status === 'active' && typeof item.path === 'string').map((item: any) => path.resolve(project, item.path));
      for (const file of declared) add(file, 'project_document', project, project);
    } else {
      const documentation = readLearningJson(documentationFile);
      for (const item of Array.isArray(documentation?.documents) ? documentation.documents : []) if (item?.status === 'active' && typeof item.path === 'string') add(path.resolve(project, item.path), 'project_document', project, project);
    }
    addJsonDirectory(path.join(project, '.solopreneur', 'run-digests'), 'run_digest', project, project);
    const registered = registeredReviewSourceFiles(project, previousSources);
    for (const file of registered.tasks) add(file, 'task', project, project);
    for (const file of registered.reports) add(file, 'agent_report', project, project);
  }
  return required;
}

export function runManualLearningReview(input: {
  runDir: string; globalRoot: string; workspaceRoot?: string; projects: string[]; globalPrompt: string; persistedGlobalPrompt?: string;
  resultContract?: 'global-prompt-v1' | 'legacy-review-v2';
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
    const directResult = readLearningJson(proposalFile);
    if (typeof directResult?.globalPrompt === 'string') {
      const manifest = readLearningJson(manifestFile) as ReviewManifest | undefined;
      if (!manifest || manifest.schemaVersion !== 1 || manifest.runId !== runId || manifest.globalRoot !== input.globalRoot
        || manifest.globalPrompt !== input.globalPrompt || manifest.promptHash !== reviewHash(input.globalPrompt)
        || manifest.persistedPromptHash !== reviewHash(input.persistedGlobalPrompt ?? input.globalPrompt)
        || !Array.isArray(manifest.projects) || !Array.isArray(manifest.sources) || !Array.isArray(manifest.memory) || !Array.isArray(manifest.gaps)) {
        throw new Error('复盘 Agent 未生成与本次请求匹配的增量证据清单。');
      }
      const contextIndex = readLearningJson(path.join(input.runDir, 'context-index.json'));
      if (contextIndex?.schemaVersion !== 1 || contextIndex.runId !== runId || contextIndex.manifestHash !== reviewHash(JSON.stringify(manifest))) throw new Error('复盘 Agent 未保留与增量采集结果匹配的索引凭据。');
      const allowedProjects = input.getProjects ? input.getProjects() : input.projects;
      if (JSON.stringify([...manifest.projects].sort()) !== JSON.stringify([...allowedProjects].sort())) throw new Error('复盘 Agent 生成的项目范围与当前登记项目不一致。');
      const directKinds = new Set([
        'global_prompt_mirror', 'memory', 'memory_entry', 'learning_ledger', 'learning_event_source',
        'legacy_candidates', 'legacy_approved', 'legacy_rejected', 'legacy_promotion-suggestions',
        'project_constraint', 'project_memory_legacy', 'project_document_index', 'project_document',
        'run_digest', 'task', 'agent_report'
      ]);
      const priorState = readLearningJson(path.join(input.globalRoot, 'maintenance', 'review-state.json')) || {};
      const pendingApplications = pendingReviewApplications(input.globalRoot, input.runDir);
      const priorDeferredSources = Array.isArray(priorState.deferredSources)
        ? Object.fromEntries(priorState.deferredSources.filter((source: any) => source && typeof source.id === 'string').map((source: any) => [source.id, source]))
        : {};
      const pendingSnapshots = pendingApplications.flatMap(pending => [
        ...(Array.isArray(pending.application?.sourceCursor) ? pending.application.sourceCursor : []),
        ...(Array.isArray(pending.application?.deferredSources) ? pending.application.deferredSources : [])
      ]).filter((source: any) => source && typeof source.id === 'string');
      const priorSources = { ...(priorState.sources || {}), ...Object.fromEntries(pendingSnapshots.map((source: any) => [source.id, source])), ...priorDeferredSources };
      const requiredSources = await requiredLocalReviewSources(input.globalRoot, manifest.projects, priorSources);
      const directSourceIds = new Set<string>();
      for (const source of manifest.sources) {
        if (typeof source?.id !== 'string' || !source.id || directSourceIds.has(source.id) || !/^[a-f0-9]{64}$/.test(source.hash || '')) throw new Error('复盘 Agent 生成了无效来源标识或哈希。');
        directSourceIds.add(source.id);
        if (source.projectPath && !manifest.projects.includes(source.projectPath)) throw new Error('复盘 Agent 生成的来源项目未登记。');
        if (source.file) {
          const sourceRoot = isWithin(input.globalRoot, source.file) ? input.globalRoot : source.projectPath && isWithin(source.projectPath, source.file) ? source.projectPath : '';
          const expected = requiredSources.get(path.resolve(source.file));
          if (!path.isAbsolute(source.file) || !sourceRoot || !isSafeSourceFile(sourceRoot, source.file)
            || !directKinds.has(source.kind) || !isDeclaredReviewSource(input.globalRoot, source)
            || !expected || !expected.kinds.has(source.kind) || expected.projectPath !== source.projectPath
            || source.id !== `source-${reviewHash(`${source.file}:${source.kind}`).slice(0, 24)}`) throw new Error('复盘 Agent 引用了范围外或非正式证据来源。');
          const verifiedContent = fs.readFileSync(source.file, 'utf8');
          if (reviewHash(verifiedContent) !== source.hash || (source.content !== undefined && source.content !== verifiedContent)) throw new Error('复盘 Agent 引用的证据版本已变化。');
          source.content = verifiedContent;
        } else if (source.kind === 'deleted_source') {
          const previous = priorSources[source.id];
          const value = source.value;
          const repeatedTombstone = previous && typeof previous === 'object' && previous.kind === 'deleted_source'
            && previous.hash === source.hash && canonical(previous.value) === canonical(value)
            && ((typeof previous.content === 'string' && typeof source.content === 'string' && previous.content === source.content
              && reviewHash(source.content) === value?.previousHash) || (value?.contentUnavailable === true && previous.content === undefined && source.content === undefined))
            && typeof value?.file === 'string' && (!fs.existsSync(value.file) || value?.registrationRevoked === true);
          const newTombstone = previous && typeof previous === 'object' && previous.kind !== 'deleted_source' && typeof previous.file === 'string'
            && value && value.file === previous.file && value.previousHash === previous.hash && value.previousKind === previous.kind
            && typeof previous.content === 'string' && typeof source.content === 'string' && source.content === previous.content && reviewHash(source.content) === previous.hash
            && (!fs.existsSync(previous.file) || (value.registrationRevoked === true && previous.kind === 'agent_report')) && reviewHash(JSON.stringify(value)) === source.hash;
          const legacyTombstone = previous && typeof previous === 'object' && previous.kind !== 'deleted_source' && previous.content === undefined && source.content === undefined
            && value?.contentUnavailable === true && value.file === previous.file && value.previousHash === previous.hash && value.previousKind === previous.kind
            && (!fs.existsSync(previous.file) || (value.registrationRevoked === true && previous.kind === 'agent_report')) && reviewHash(JSON.stringify(value)) === source.hash;
          if (!repeatedTombstone && !newTombstone && !legacyTombstone) throw new Error('复盘 Agent 生成的删除来源证据无效。');
        } else if (source.kind === 'github') {
          const repository = source.value?.repository; const sha = source.value?.sha;
          const { observedAt, ...stableValue } = source.value || {};
          if (!source.projectPath || !manifest.projects.includes(source.projectPath)
            || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !/^[a-f0-9]{40}$/.test(sha || '')
            || source.id !== `github-${reviewHash(`${repository}:${sha}`).slice(0, 24)}`
            || source.hash !== reviewHash(JSON.stringify(stableValue))) throw new Error('复盘 Agent 生成的精确提交证据格式无效。');
        } else throw new Error('复盘 Agent 引用了无法定位的证据来源。');
      }
      if (manifest.sources.some(source => source.kind === 'github')) await verifyGithubSources(manifest, input.api);
      const cursorUpdates = Array.isArray(manifest.cursorUpdates) ? manifest.cursorUpdates : [];
      const cursorUpdateIds = new Set<string>();
      for (const source of cursorUpdates) {
        const previous = priorState.sources?.[source?.id];
        const previousHash = typeof previous === 'string' ? previous : previous?.hash;
        if (typeof source?.id !== 'string' || !source.id || cursorUpdateIds.has(source.id) || directSourceIds.has(source.id)
          || !source.file || !/^[a-f0-9]{64}$/.test(source.hash || '') || previousHash !== source.hash) throw new Error('复盘 Agent 生成了无效的游标更新。');
        cursorUpdateIds.add(source.id);
        if (previous && typeof previous === 'object' && (previous.file !== source.file || previous.kind !== source.kind || previous.projectPath !== source.projectPath)) throw new Error('复盘 Agent 生成的游标更新与既有来源身份不一致。');
        const sourceRoot = isWithin(input.globalRoot, source.file) ? input.globalRoot : source.projectPath && isWithin(source.projectPath, source.file) ? source.projectPath : '';
        if (!sourceRoot || !directKinds.has(source.kind) || !isSafeSourceFile(sourceRoot, source.file) || !isDeclaredReviewSource(input.globalRoot, source)) throw new Error('复盘 Agent 生成的游标更新超出正式来源范围。');
        const stat = fs.statSync(source.file);
        if (source.id !== `source-${reviewHash(`${source.file}:${source.kind}`).slice(0, 24)}`
          || reviewHash(fs.readFileSync(source.file, 'utf8')) !== source.hash || !sourceMetadataMatches(source, stat)) throw new Error('复盘 Agent 生成的游标更新与当前文件不一致。');
      }
      for (const [file, requirement] of requiredSources) {
        const kinds = [...requirement.kinds].filter(kind => kind !== 'legacy_candidate-decisions');
        if (!kinds.length) continue;
        const coveredByRun = [...manifest.sources, ...cursorUpdates].some(source => source.file === file && kinds.includes(source.kind));
        if (coveredByRun) continue;
        const stat = fs.statSync(file);
        const coveredByCursor = Object.values(priorState.sources || {}).some((source: any) => source && typeof source === 'object'
          && source.file === file && kinds.includes(source.kind) && sourceMetadataMatches(source, stat));
        if (!coveredByCursor) throw new Error(`复盘 Agent 的增量清单遗漏正式来源：${file}`);
      }
      validateDirectGlobalPromptReview(manifest, directResult);
      if (!Array.isArray(directResult.recovery) || directResult.recovery.length !== pendingApplications.length) throw new Error('复盘 Agent 未完整处置旧的部分应用结果。');
      const recoveryRuns = new Set<string>();
      for (const disposition of directResult.recovery) {
        if (!disposition || typeof disposition.runDir !== 'string' || recoveryRuns.has(disposition.runDir)
          || !['resumed', 'superseded'].includes(disposition.decision) || typeof disposition.reason !== 'string' || !disposition.reason.trim()) {
          throw new Error('复盘 Agent 生成了无效的旧结果恢复处置。');
        }
        recoveryRuns.add(disposition.runDir);
        const pending = pendingApplications.find(item => item.runDir === disposition.runDir && item.status === disposition.status);
        if (!pending) throw new Error('复盘 Agent 的旧结果恢复处置与当前状态不一致。');
        if (disposition.decision === 'resumed' && pending.application?.targetPromptHash !== reviewHash(directResult.globalPrompt)) throw new Error('复盘 Agent 声明承接旧结果，但最终提示词与旧目标版本不一致。');
        if (disposition.decision === 'superseded' && pending.application?.targetPromptHash !== manifest.promptHash
          && pending.application?.items?.globalPrompt !== pending.application?.targetPromptHash) throw new Error('尚未写入成功的旧完整提示词不能直接标记为已替代。');
      }
      const currentSourceIds = new Set([...manifest.sources, ...cursorUpdates].map(source => source.id));
      const recoveredSourceCursor: any[] = [];
      for (const pending of pendingApplications) {
        for (const source of Array.isArray(pending.application?.deferredSources) ? pending.application.deferredSources : []) {
          if (source && typeof source.id === 'string' && source.kind && !currentSourceIds.has(source.id)) throw new Error(`旧部分应用中的延期来源未由本轮承接：${source.id}`);
        }
        for (const source of Array.isArray(pending.application?.sourceCursor) ? pending.application.sourceCursor : []) {
          if (!source || typeof source.id !== 'string' || currentSourceIds.has(source.id) || priorState.sources?.[source.id]) continue;
          if (typeof source.file !== 'string' || !fs.existsSync(source.file) || !sourceMetadataMatches(source, fs.statSync(source.file))) {
            throw new Error(`旧部分应用中的已处理游标未由本轮承接：${source.id}`);
          }
          recoveredSourceCursor.push(source);
        }
      }
      const globalPrompt = directResult.globalPrompt;
      const processed = new Set<string>(directResult.processedSourceIds);
      const deferred = new Set<string>(directResult.deferredSourceIds || []);
      const deferredSources = manifest.sources.filter(source => deferred.has(source.id)).map(source => {
        const content = source.file ? fs.readFileSync(source.file, 'utf8') : source.content;
        if (source.file && reviewHash(content || '') !== source.hash) throw new Error(`延期来源在快照保存前已变化：${source.id}`);
        const previous = priorSources[source.id];
        const previousVersions = previous && typeof previous === 'object' && previous.hash !== source.hash
          ? [
              ...(Array.isArray(previous.previousVersions) ? previous.previousVersions : []),
              {
                id: previous.id || source.id, hash: previous.hash, file: previous.file, kind: previous.kind,
                projectPath: previous.projectPath, size: previous.size, mtimeMs: previous.mtimeMs,
                ctimeMs: previous.ctimeMs, dev: previous.dev, ino: previous.ino,
                content: previous.content, value: previous.value
              }
            ]
          : Array.isArray(previous?.previousVersions) ? previous.previousVersions : undefined;
        return {
          id: source.id, hash: source.hash, file: source.file, kind: source.kind, projectPath: source.projectPath,
          size: source.size, mtimeMs: source.mtimeMs, ctimeMs: source.ctimeMs, dev: source.dev, ino: source.ino, content, value: source.value,
          ...(previousVersions?.length ? { previousVersions } : {})
        };
      });
      const expectedHash = reviewHash(input.persistedGlobalPrompt ?? input.globalPrompt);
      if (reviewHash(input.getGlobalPrompt()) !== expectedHash) throw new Error('默认指令已被修改，请重新复盘以保留最新内容。');
      const applicationFile = path.join(input.runDir, 'application.json');
      const proposalHash = reviewHash(JSON.stringify(directResult));
      const journal: any = {
        schemaVersion: 1, proposalHash, targetPromptHash: reviewHash(globalPrompt), targetPrompt: globalPrompt, status: 'applying', items: {}, errors: [],
        sourceCursor: [...recoveredSourceCursor, ...manifest.sources.filter(source => processed.has(source.id)), ...cursorUpdates].map(source => ({
          id: source.id, hash: source.hash, file: source.file, kind: source.kind, projectPath: source.projectPath, size: source.size, mtimeMs: source.mtimeMs,
          ctimeMs: source.ctimeMs, dev: source.dev, ino: source.ino, content: source.content ?? priorSources[source.id]?.content, value: source.value ?? priorSources[source.id]?.value
        })),
        deferredSourceIds: [...deferred], deferredSources, recovery: directResult.recovery
      };
      writeLearningJson(applicationFile, journal);
      try {
        await input.setGlobalPrompt(globalPrompt, expectedHash);
        if (input.getGlobalPrompt() !== globalPrompt) throw new Error('全局默认提示词写入后回读不一致。');
        journal.items.globalPrompt = reviewHash(globalPrompt);
        const sources: Record<string, any> = { ...(priorState.sources || {}) };
        for (const id of deferred) delete sources[id];
        for (const source of [...recoveredSourceCursor, ...manifest.sources.filter(source => processed.has(source.id)), ...cursorUpdates]) {
          if (typeof source?.id === 'string' && /^[a-f0-9]{64}$/.test(source?.hash || '') && !deferred.has(source.id)) {
            if (source.kind === 'deleted_source') { delete sources[source.id]; continue; }
            sources[source.id] = source.file
              ? { hash: source.hash, file: source.file, kind: source.kind, projectPath: source.projectPath, size: source.size, mtimeMs: source.mtimeMs, ctimeMs: source.ctimeMs, dev: source.dev, ino: source.ino, content: source.content ?? priorSources[source.id]?.content, value: source.value ?? priorSources[source.id]?.value }
              : { hash: source.hash, kind: source.kind, projectPath: source.projectPath };
          }
        }
        writeLearningJson(path.join(input.globalRoot, 'maintenance', 'review-state.json'), {
          schemaVersion: 1,
          lastAppliedRunId: runId,
          appliedAt: new Date().toISOString(),
          promptHash: reviewHash(globalPrompt),
          sources,
          deferredSourceIds: [...deferred],
          deferredSources,
          unresolved: Array.isArray(directResult.unresolved) ? directResult.unresolved : []
        });
        for (const disposition of directResult.recovery) {
          const oldApplicationFile = path.join(disposition.runDir, 'application.json');
          const oldApplication = readLearningJson(oldApplicationFile);
          writeLearningJson(oldApplicationFile, { ...oldApplication, status: disposition.decision, recoveredBy: runId, recoveryReason: disposition.reason });
        }
        journal.status = 'applied';
      } catch (error: any) {
        journal.status = 'partial'; journal.errors = [String(error?.message || error)];
      }
      writeLearningJson(applicationFile, journal);
      return { status: journal.status as 'applied' | 'partial', errors: journal.errors };
    }
    if (input.resultContract === 'global-prompt-v1') throw new Error('复盘 Agent 未按当前契约生成完整全局提示词。');
    const manifest = readLearningJson(manifestFile) as ReviewManifest | undefined;
    if (!manifest || manifest.schemaVersion !== 1 || manifest.runId !== runId || manifest.globalRoot !== input.globalRoot
      || manifest.globalPrompt !== input.globalPrompt || manifest.promptHash !== reviewHash(input.globalPrompt)
      || manifest.persistedPromptHash !== reviewHash(input.persistedGlobalPrompt ?? input.globalPrompt)
      || !Array.isArray(manifest.projects) || !Array.isArray(manifest.sources) || !Array.isArray(manifest.memory) || !Array.isArray(manifest.gaps)) {
      throw new Error('复盘 Agent 未生成与本次请求匹配的证据清单，材料已保留。');
    }
    const allowedProjects = input.getProjects ? input.getProjects() : input.projects;
    if (JSON.stringify([...manifest.projects].sort()) !== JSON.stringify([...allowedProjects].sort())) throw new Error('复盘 Agent 生成的项目范围与当前登记项目不一致，材料已保留。');
    const allowedFileKinds = new Set([
      'global_prompt_mirror', 'memory', 'memory_entry', 'learning_ledger', 'learning_event_source',
      'legacy_candidates', 'legacy_approved', 'legacy_rejected', 'legacy_promotion-suggestions',
      'project_constraint', 'project_memory_legacy', 'project_document_index', 'project_document',
      'run_digest', 'task', 'agent_report'
    ]);
    const sourceIds = new Set<string>();
    for (const source of manifest.sources) {
      if (typeof source.id !== 'string' || !source.id || sourceIds.has(source.id) || !/^[a-f0-9]{64}$/.test(source.hash)) throw new Error('复盘 Agent 生成了无效来源标识或哈希，材料已保留。');
      sourceIds.add(source.id);
      if (source.projectPath && !manifest.projects.includes(source.projectPath)) throw new Error('复盘 Agent 生成的来源项目未登记，材料已保留。');
      if (source.file) {
        const sourceRoot = isWithin(input.globalRoot, source.file) ? input.globalRoot : source.projectPath && isWithin(source.projectPath, source.file) ? source.projectPath : '';
        if (!path.isAbsolute(source.file) || !sourceRoot) throw new Error('复盘 Agent 生成的来源范围超出登记项目和全局数据目录，材料已保留。');
        if (!isSafeSourceFile(sourceRoot, source.file)) throw new Error('复盘 Agent 生成的来源文件不存在或经过符号链接，材料已保留。');
        if (!allowedFileKinds.has(source.kind) || !isDeclaredReviewSource(input.globalRoot, source)) throw new Error('复盘 Agent 生成的文件来源不在正式材料范围内，材料已保留。');
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
    for (const source of manifest.sources.filter(item => item.kind === 'memory')) {
      const relativePath = path.relative(memoryRoot, source.file!).replace(/\\/g, '/');
      if (!manifest.memory.some(item => item.relativePath === relativePath && item.hash === source.hash)) {
        throw new Error(`复盘 Agent 引用的记忆来源缺少对应正文：${source.file}`);
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
    const provenance = review.provenance;
    const validSelfReview = provenance?.method === 'self-review' && provenance.parentRunId === runId;
    const validSubagentReview = provenance?.method === 'subagent' && provenance.parentRunId === runId
      && typeof provenance.childRunId === 'string' && provenance.childRunId.trim() && provenance.childRunId !== runId;
    if (!validSelfReview && !validSubagentReview) {
      throw new Error('复盘 Agent 缺少与本次提案匹配的结果自检，材料已保留。');
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
