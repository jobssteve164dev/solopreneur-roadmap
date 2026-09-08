import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { SqliteStore } from './db/sqliteStore.js';
import { learningTasksRoot, readLearningJson } from './taskReport.js';
import { extractContinuationParentConversationId } from './continuation.js';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const array = (value: any): any[] => Array.isArray(value) ? value : [];
const names = (dir: string): string[] => { try { return fs.readdirSync(dir); } catch { return []; } };
const sourceCache = new Map<string, { signature: string; value: any; hash: string }>();
function cachedSource(file: string): { value: any; hash: string } {
  const stat = fs.statSync(file);
  const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const previous = sourceCache.get(file);
  if (previous?.signature === signature) return previous;
  let content = ''; let value: any = null;
  try { content = fs.readFileSync(file, 'utf8'); value = JSON.parse(content); } catch { /* A later file version is retried. */ }
  const result = { signature, value, hash: hash(content) };
  sourceCache.set(file, result); return result;
}

export function containedRegularPath(root: string, target: string, directory = false): boolean {
  try {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return false;
    let current = path.resolve(root);
    if (fs.lstatSync(current).isSymbolicLink()) return false;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    }
    return directory ? fs.statSync(current).isDirectory() : fs.statSync(current).isFile();
  } catch { return false; }
}

export function reportRelativePath(value: any): string {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || /^[a-z]+:/i.test(value)) return '';
  const normalized = value.replace(/\\/g, '/');
  return normalized.split('/').some(part => part === '..' || !part) ? '' : normalized;
}

export function readRegisteredTaskSources(projectPath: string, taskId?: string, links: { id: number; parentId: number; nodeId: string }[] = []): { tasks: any[]; reports: any[]; observations: any[] } {
  const root = learningTasksRoot(projectPath);
  const tasks: any[] = []; const reports: any[] = []; const observations: any[] = [];
  for (const name of (taskId ? [`${taskId}.json`] : names(root)).filter(name => /^task-[a-zA-Z0-9-]+\.json$/.test(name))) {
    const file = path.join(root, name);
    if (!containedRegularPath(projectPath, file)) continue;
    const task = cachedSource(file).value;
    if (task?.schemaVersion !== 1 || task.projectPath !== projectPath || `${task.taskId}.json` !== name || !Array.isArray(task.executions)) continue;
    const executions = task.executions.filter((run: any) => Number.isSafeInteger(run.id) && run.id > 0 && typeof run.runDir === 'string'
      && containedRegularPath(path.join(projectPath, '.solopreneur', 'agent-runs'), run.runDir, true));
    for (const link of [...links].sort((a, b) => a.id - b.id)) {
      const parent = executions.find((run: any) => run.id === link.parentId && path.basename(path.dirname(run.runDir)) === link.nodeId);
      if (parent && !executions.some((run: any) => run.id === link.id)) executions.push({ id: link.id, runDir: parent.runDir });
    }
    const registeredTask = { ...task, executions, unreadableReports: false };
    tasks.push(registeredTask);
    for (const run of executions) {
      const sessionFile = path.join(run.runDir, 'session.json');
      const session = containedRegularPath(projectPath, sessionFile) ? cachedSource(sessionFile).value : null;
      const agent = typeof session?.provider === 'string' ? session.provider : '';
      for (const name of names(run.runDir).filter(name => /^task-report-\d+\.json$/.test(name))) {
        const file = path.join(run.runDir, name);
        if (!containedRegularPath(projectPath, file)) continue;
        const sequence = Number(name.match(/\d+/)![0]);
        const raw = cachedSource(file); const envelope = raw.value;
        if (!envelope && executions.filter((other: any) => other.runDir === run.runDir).length > 1) {
          registeredTask.unreadableReports = true; continue;
        }
        if (envelope?.executionLogId !== run.id && executions.some((other: any) => other.id === envelope?.executionLogId && other.runDir === run.runDir)) continue;
        const valid = envelope?.projectPath === projectPath && envelope?.taskId === task.taskId
          && envelope?.executionLogId === run.id && envelope?.turnId === `${sequence}:complete`
          && envelope.report && typeof envelope.report === 'object' && typeof envelope.report.summary === 'string';
        const observation = { taskId: task.taskId, executionLogId: run.id, sequence, turnId: `${sequence}:complete`, file, agent,
          createdAt: valid ? String(envelope.createdAt || '') : '', availability: valid ? 'recorded' : 'invalid', hash: raw.hash, envelope: valid ? envelope : null };
        observations.push(observation);
        if (valid) reports.push(envelope);
      }
      for (const name of names(run.runDir).filter(name => /^task-report-status-\d+\.json$/.test(name))) {
        const file = path.join(run.runDir, name);
        if (!containedRegularPath(projectPath, file)) continue;
        const receipt = cachedSource(file);
        const value = receipt.value; const sequence = Number(name.match(/\d+/)![0]);
        if (value?.projectPath !== projectPath || value.taskId !== task.taskId || value.executionLogId !== run.id || value.turnId !== `${sequence}:complete`
          || !['missing', 'invalid', 'save_failed'].includes(value.availability) || observations.some(item => item.taskId === task.taskId && item.executionLogId === run.id && item.sequence === sequence)) continue;
        observations.push({ taskId: task.taskId, executionLogId: run.id, sequence, turnId: value.turnId, file, agent, createdAt: value.createdAt,
          availability: value.availability, hash: receipt.hash, envelope: null });
      }
    }
  }
  return { tasks, reports, observations };
}

// Render strings as text. Object labels are presentation only, never status or instructions.
export function reportText(value: any): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(reportText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  return Object.values(value).map(reportText).filter(Boolean).join('\n');
}

function presentReport(value: any): any {
  if (!value) return null;
  return Object.fromEntries(['summary', 'unmetRequirements', 'decisions', 'corrections', 'verification', 'experienceUsage', 'lessons'].map(key => [key,
    key === 'summary' ? String(value.summary || '') : array(value[key]).map(reportText)]));
}

export interface GrowthReportQuery { taskId?: string; offset?: number; limit?: number; unmetOnly?: boolean; moduleId?: string; capabilityId?: string }
export interface GrowthReportPage { projectPath: string; tasks: any[]; turns: any[]; total: number; nextOffset: number | null }
const queries = new Map<string, Promise<GrowthReportPage>>();
const runFileCache = new Map<string, { signature: string; files: any[]; links: { id: number; parentId: number; nodeId: string }[] }>();
async function runContext(projectPath: string, extensionPath: string): Promise<{ files: any[]; links: { id: number; parentId: number; nodeId: string }[] }> {
  const file = path.join(projectPath, '.solopreneur/project_journal.db');
  if (!fs.existsSync(file)) return { files: [], links: [] };
  const stat = fs.statSync(file); const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = runFileCache.get(projectPath); if (cached?.signature === signature) return cached;
  const journal = new SqliteStore(file, extensionPath); await journal.init();
  try {
    const result = { signature, files: journal.getGrowthRunFiles(), links: journal.getGrowthConversationHeaders().map(row => ({ id: row.id, parentId: extractContinuationParentConversationId(row.output), nodeId: row.nodeId })).filter(row => row.parentId > 0) };
    runFileCache.set(projectPath, result); return result;
  } finally { journal.close(); }
}

export async function readRegisteredProjectSources(projectPath: string, extensionPath: string): Promise<ReturnType<typeof readRegisteredTaskSources>> {
  return readRegisteredTaskSources(projectPath, undefined, (await runContext(projectPath, extensionPath)).links);
}
function sourceStamp(projectPath: string, taskId?: string): string {
  const parts: string[] = [];
  const add = (file: string) => { try { const stat = fs.statSync(file); parts.push(`${file}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`); } catch { parts.push(`${file}:missing`); } };
  for (const name of names(learningTasksRoot(projectPath)).filter(name => /^task-[A-Za-z0-9-]+\.json$/.test(name) && (!taskId || name === `${taskId}.json`)).sort()) {
    const file = path.join(learningTasksRoot(projectPath), name); add(file);
    if (!containedRegularPath(projectPath, file)) continue;
    for (const run of array(cachedSource(file).value?.executions)) {
      if (typeof run.runDir !== 'string' || !containedRegularPath(path.join(projectPath, '.solopreneur/agent-runs'), run.runDir, true)) continue;
      add(run.runDir);
      for (const report of names(run.runDir).filter(name => /^task-report-(?:status-)?\d+\.json$/.test(name)).sort()) add(path.join(run.runDir, report));
    }
  }
  return hash(parts.join('\n'));
}

export function queryGrowthReports(projectPath: string, extensionPath: string, query: GrowthReportQuery): Promise<GrowthReportPage> {
  const key = `${projectPath}:${JSON.stringify(query)}:${sourceStamp(projectPath, query.taskId)}`;
  const existing = queries.get(key); if (existing) return existing;
  const promise = readProjection(projectPath, extensionPath, query).finally(() => queries.delete(key));
  queries.set(key, promise); return promise;
}

async function readProjection(projectPath: string, extensionPath: string, query: GrowthReportQuery): Promise<GrowthReportPage> {
  const context = await runContext(projectPath, extensionPath); const runs = context.files;
  const store = new SqliteStore(path.join(projectPath, '.solopreneur', 'project_growth.db'), extensionPath);
  fs.mkdirSync(path.join(projectPath, '.solopreneur'), { recursive: true });
  await store.init();
  try {
    store.reloadGrowthDatabase();
    const sourceVersion = sourceStamp(projectPath, query.taskId);
    const source = { tasks: [] as any[], reports: [] as any[], observations: [] as any[] };
    for (const name of names(learningTasksRoot(projectPath)).filter(name => /^task-[A-Za-z0-9-]+\.json$/.test(name) && (!query.taskId || name === `${query.taskId}.json`))) {
      const item = readRegisteredTaskSources(projectPath, name.slice(0, -5), context.links);
      source.tasks.push(...item.tasks); source.observations.push(...item.observations);
      // Incremental indexing yields to the host between tasks; ordinary reads reuse unchanged bodies.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (sourceStamp(projectPath, query.taskId) !== sourceVersion) return readProjection(projectPath, extensionPath, query);
    store.reloadGrowthDatabase();
    const previous = new Map(store.getGrowthReportProjection(query.taskId ? `turn:${query.taskId}:` : 'turn:').map(row => [row.key, row.value]));
    const updates: { key: string; value: any }[] = [];
    const seen = new Set<string>();
    const metadata: any[] = [];
    for (const item of source.observations) {
      const key = `turn:${item.taskId}:${item.executionLogId}:${item.turnId}`;
      seen.add(key);
      const old = previous.get(key);
      const versionKey = `body:${item.taskId}:${item.executionLogId}:${item.turnId}:${item.hash}`;
      const body = item.envelope?.report;
      const value = body ? {
        ...item, envelope: undefined, bodyKey: versionKey, summary: body.summary,
        unmet: Array.isArray(body.unmetRequirements) ? body.unmetRequirements.length > 0 : null,
        commits: array(body.commits), files: reportFiles(body),
        versions: old?.versions?.[old.versions.length - 1] === item.hash ? old.versions : [...(old?.versions || []), item.hash]
      } : { ...old, ...item, envelope: undefined, createdAt: old?.createdAt || item.createdAt || '', versions: old?.versions || [] };
      if (!old || old.hash !== item.hash || old.availability !== item.availability) {
        updates.push({ key, value });
        if (body) updates.push({ key: versionKey, value: body });
      }
      metadata.push(value);
    }
    for (const [key, value] of previous) {
      if (!seen.has(key) && source.tasks.some(task => task.taskId === value.taskId)
        && !source.observations.some(item => item.file === value.file && item.availability === 'recorded')) metadata.push({ ...value, availability: containedRegularPath(projectPath, value.file) ? 'invalid' : 'missing' });
    }
    store.putGrowthReportProjection(updates);
    const snapshot = store.getLatestGrowthSnapshot();
    const nodes = new Map((snapshot?.nodes || []).map(node => [node.nodeId, node]));
    const moduleByPath = new Map<string, string>();
    for (const edge of snapshot?.edges || []) if (edge.kind === 'contains' && edge.sourceId.startsWith('module:')) {
      const file = nodes.get(edge.targetId); if (file) moduleByPath.set(file.path, edge.sourceId);
    }
    const evidenceRoot = path.join(projectPath, '.solopreneur/agent-runs/learning-evidence');
    const evidence = names(evidenceRoot).filter(name => name.endsWith('.summary.json')).flatMap(name => array(cachedSource(path.join(evidenceRoot, name)).value?.commits));
    const associations = new Map(store.getGrowthReportProjection('association:').map(row => [row.key, row.value]));
    const associationUpdates: { key: string; value: any }[] = [];
    const rows = source.tasks.filter(task => !query.taskId || task.taskId === query.taskId).map(task => {
      const turns = metadata.filter(turn => turn.taskId === task.taskId).sort((a, b) => b.executionLogId - a.executionLogId || b.sequence - a.sequence);
      const latest = turns[0];
      const unmet = turns.find(turn => typeof turn.unmet === 'boolean')?.unmet ?? null;
      const modules = new Set<string>();
      const runFiles = runs.filter(run => task.executions.some((execution: any) => execution.id === run.executionLogId) && ['changed', 'touched'].includes(run.role)).map(file => reportRelativePath(file.filePath)).filter(Boolean);
      const taskEvidence = evidence.filter(commit => array(commit.taskIds).includes(task.taskId));
      const diffFiles = taskEvidence.flatMap(commit => {
        const scope = array(commit.reportedScopes).filter(scope => scope.taskId === task.taskId).flatMap(scope => array(scope.files));
        return array(commit.files).filter(file => (array(commit.commitTaskIds).length === 1 && commit.commitTaskIds[0] === task.taskId) || scope.includes(file.filename)).map(file => reportRelativePath(file.filename));
      }).filter(Boolean);
      for (const file of [...turns.flatMap(turn => turn.files || []), ...runFiles, ...diffFiles]) {
        const moduleId = moduleByPath.get(file);
        if (!moduleId || !containedRegularPath(projectPath, path.join(projectPath, file))) continue;
        const key = `association:${task.taskId}:${file}`;
        const old = associations.get(key);
        const stat = fs.statSync(path.join(projectPath, file));
        const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
        if (old && (old.moduleId !== moduleId || old.identity !== identity)) continue;
        if (!old) {
          // A missing historic file or a delete/recreate path cannot establish present ownership.
          const commits = turns.flatMap(turn => array(turn.commits)).filter(commit => array(commit.files).includes(file));
          if (commits.length && !commits.some(commit => hasContinuousFileHistory(projectPath, commit.sha, file))) continue;
          associationUpdates.push({ key, value: { moduleId, identity, snapshotId: snapshot?.snapshot.id || '', sourceVersions: turns.filter(turn => array(turn.files).includes(file)).map(turn => turn.hash), basis: runFiles.includes(file) ? 'run_files' : diffFiles.includes(file) ? 'commit_diff' : 'agent_report' } });
        }
        modules.add(moduleId);
      }
      const capabilities = new Set<string>();
      for (const edge of snapshot?.edges || []) if (edge.kind === 'implements' && modules.has(edge.sourceId) && /run|user|confirmed/.test(edge.evidence)) capabilities.add(edge.targetId);
      return { taskId: task.taskId, title: String(task.userMessage || ''), latestSummary: latest?.summary || '',
        latestSequence: turns.length || undefined, latestExecutionLogId: latest?.executionLogId, createdAt: latest?.createdAt || task.startedAt,
        availability: latest?.availability || (task.unreadableReports ? 'invalid' : 'missing'), unmet, turnCount: turns.length,
        modules: [...modules].map(id => ({ id, label: nodes.get(id)?.label || id })),
        capabilities: [...capabilities].map(id => ({ id, label: nodes.get(id)?.label || id })),
        evidence: taskEvidence,
        executions: task.executions.map((run: any) => ({ id: run.id, nodeId: path.basename(path.dirname(run.runDir)) })) };
    }).filter(task => (!query.unmetOnly || task.unmet === true)
      && (!query.moduleId || task.modules.some(module => module.id === query.moduleId))
      && (!query.capabilityId || task.capabilities.some(capability => capability.id === query.capabilityId)))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.taskId.localeCompare(a.taskId));
    const offset = Math.max(0, Number(query.offset) || 0); const limit = Math.max(1, Math.min(50, Number(query.limit) || 20));
    store.putGrowthReportProjection(associationUpdates);
    const taskTurns = metadata.filter(turn => turn.taskId === query.taskId).sort((a, b) => b.executionLogId - a.executionLogId || b.sequence - a.sequence);
    const turns = query.taskId && source.tasks.some(task => task.taskId === query.taskId)
      ? taskTurns.slice(offset, offset + limit).map((turn, index) => ({
        ...turn, roundNumber: taskTurns.length - offset - index, report: turn.bodyKey ? presentReport(store.getGrowthReportProjection(turn.bodyKey).find(row => row.key === turn.bodyKey)?.value) : null,
        history: (turn.versions || []).map((version: string) => ({ version, report: presentReport(store.getGrowthReportProjection(`body:${turn.taskId}:${turn.executionLogId}:${turn.turnId}:${version}`)[0]?.value) }))
      })) : [];
    const total = query.taskId ? taskTurns.length : rows.length;
    return { projectPath, tasks: (query.taskId ? rows : rows.slice(offset, offset + limit)).map(task => ({ ...task, evidence: task.evidence.map(({ files, ...commit }) => ({ ...commit, versionState: commitVersionState(projectPath, commit.sha, array(files).map(file => file.filename)) })) })), turns, total, nextOffset: offset + limit < total ? offset + limit : null };
  } finally { store.close(); }
}

export function reportFiles(report: any): string[] {
  const references = [...array(report.outputs), ...array(report.artifacts), ...array(report.verification).flatMap(item => array(item?.evidence))];
  return [...new Set([...array(report.commits).flatMap(commit => array(commit?.files)),
    ...references.map(reference => typeof reference === 'string' ? reference : reference?.path || reference?.filePath || '')].map(reportRelativePath).filter(Boolean))];
}

export function commitVersionState(projectPath: string, sha: string, files: string[]): 'current' | 'stale' | 'unknown' {
  if (!/^[a-f0-9]{40}$/.test(sha) || !files.length || files.some(file => !reportRelativePath(file))) return 'unknown';
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: projectPath, stdio: 'ignore' });
    const changed = execFileSync('git', ['diff', '--name-only', sha, '--', ...files], { cwd: projectPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return changed.trim() ? 'stale' : 'current';
  } catch { return 'unknown'; }
}

function hasContinuousFileHistory(projectPath: string, sha: string, file: string): boolean {
  if (!/^[a-f0-9]{40}$/.test(sha)) return false;
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}:${file}`], { cwd: projectPath, stdio: 'ignore' });
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: projectPath, stdio: 'ignore' });
    return !execFileSync('git', ['log', '--format=%H', '--diff-filter=DR', `${sha}..HEAD`, '--', file], { cwd: projectPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return false; }
}
