import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl.js';
import { ensureHealthyAutonomousRuntime } from './autonomousRuntimeHost.js';
import { normalizeGlobalDataPathForExtension } from './projectRegistry.js';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const array = (value: any): any[] => Array.isArray(value) ? value : [];
const names = (dir: string): string[] => { try { return fs.readdirSync(dir); } catch { return []; } };
const legacyLearningTasksRoot = (projectPath: string): string => path.join(projectPath, '.solopreneur', 'agent-runs', 'learning-tasks');
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
  const root = legacyLearningTasksRoot(projectPath);
  const tasks: any[] = []; const reports: any[] = []; const observations: any[] = [];
  for (const name of (taskId ? [`${taskId}.json`] : names(root)).filter(name => /^task-[a-zA-Z0-9-]+\.json$/.test(name))) {
    const file = path.join(root, name);
    if (!containedRegularPath(projectPath, file)) continue;
    const registration = cachedSource(file); const task = registration.value;
    if (task?.schemaVersion !== 1 || task.projectPath !== projectPath || `${task.taskId}.json` !== name || !Array.isArray(task.executions)) continue;
    const executions = task.executions.filter((run: any) => Number.isSafeInteger(run.id) && run.id > 0 && typeof run.runDir === 'string'
      && containedRegularPath(path.join(projectPath, '.solopreneur', 'agent-runs'), run.runDir, true));
    for (const link of [...links].sort((a, b) => a.id - b.id)) {
      const parent = executions.find((run: any) => run.id === link.parentId && path.basename(path.dirname(run.runDir)) === link.nodeId);
      if (parent && !executions.some((run: any) => run.id === link.id)) executions.push({ id: link.id, runDir: parent.runDir });
    }
    const registeredTask = { ...task, sourceHash: registration.hash, executions, unreadableReports: false };
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

async function readReportVersionBody(globalDataPath: string, projectPath: string, ref: { objectId: string; revision: number }): Promise<any> {
  const chunks: Buffer[] = []; let offset = 0, key = '';
  for (;;) {
    const page = await sendRuntimeDataRequest<{ key: string; data: string; offset: number; totalBytes: number; nextOffset: number | null }>(globalDataPath, {
      operation: 'read_report_versions', input: { root: projectPath, ref, offset, limit: 65536 }
    });
    if (!page || page.offset !== offset || key && page.key !== key) throw new Error('report_version_page_invalid');
    key = page.key; const bytes = Buffer.from(page.data, 'base64'); chunks.push(bytes);
    if (page.nextOffset === null) return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error('report_version_page_invalid');
    offset = page.nextOffset;
  }
}

async function readRegisteredReportSourcePages(globalDataPath: string, input: Record<string, unknown>): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let sourceRevision: number | undefined, changed = false;
    const merged = { tasks: [] as any[], reports: [] as any[], observations: [] as any[], runFiles: [] as any[], sourceRevision: 0 };
    const executions: any[] = [];
    const sections = input.metadataOnly === true ? ['tasks', 'executions', 'observations', 'runFiles'] : ['tasks', 'executions', 'observations', 'reports', 'runFiles'];
    for (const section of sections) {
      let cursor = 0;
      for (;;) {
        const page = await sendRuntimeDataRequest<any>(globalDataPath, { operation: 'read_registered_report_sources', input: { ...input, section, cursor, limit: 100 } });
        if (sourceRevision !== undefined && page.sourceRevision !== sourceRevision) { changed = true; break; }
        sourceRevision = Number(page.sourceRevision || 0); merged.sourceRevision = sourceRevision;
        if (section === 'executions') executions.push(...array(page.items));
        else (merged as any)[section].push(...array(page.items));
        if (page.nextCursor === null || page.nextCursor === undefined) break;
        if (!Number.isInteger(page.nextCursor) || page.nextCursor <= cursor) throw new Error('report_source_page_invalid');
        cursor = page.nextCursor;
      }
      if (changed) break;
    }
    if (changed) continue;
    const taskById = new Map(merged.tasks.map(task => [String(task.taskId), task]));
    for (const execution of executions) {
      const task = taskById.get(String(execution.taskId));
      if (!task || task.executions.some((item: any) => item.id === execution.id)) continue;
      task.executions.push({ id: execution.id, nodeId: execution.nodeId });
    }
    for (const task of merged.tasks) task.executions.sort((left: any, right: any) => left.id - right.id);
    if (input.metadataOnly !== true) {
      for (let index = 0; index < merged.observations.length; index += 8) await Promise.all(merged.observations.slice(index, index + 8).map(async observation => {
        if (observation.availability !== 'recorded' || observation.archived) return;
        observation.envelope = { schemaVersion: 1, taskId: observation.taskId, executionLogId: observation.executionLogId,
          turnId: observation.turnId, createdAt: observation.createdAt, sourceRef: observation.sourceRef,
          report: await readReportVersionBody(globalDataPath, String(input.root || ''), observation.sourceRef) };
      }));
      const reports = merged.reports;
      merged.reports = await Promise.all(reports.map(async report => ({ schemaVersion: 1, taskId: report.taskId, executionLogId: report.executionLogId,
        turnId: report.turnId, createdAt: report.createdAt, sourceRef: report.sourceRef,
        report: await readReportVersionBody(globalDataPath, String(input.root || ''), report.sourceRef) })));
    }
    return merged;
  }
  throw new Error('report_source_changed');
}

async function readGrowthProjectionPages(globalDataPath: string, projectPath: string, prefix: string): Promise<Array<{ key: string; value: any; revision: number }>> {
  const rows: Array<{ key: string; value: any; revision: number }> = [];
  let afterKey = '';
  for (;;) {
    const page = await sendRuntimeDataRequest<Array<{ key: string; value: any; revision: number }>>(globalDataPath, {
      operation: 'read_growth_report_projection', input: { root: projectPath, prefix, afterKey, limit: 200 }
    });
    rows.push(...page);
    if (page.length < 200) return rows;
    const next = page[page.length - 1]?.key;
    if (!next || next <= afterKey) throw new Error('growth_projection_page_invalid');
    afterKey = next;
  }
}

export async function readRegisteredProjectSources(projectPath: string, extensionPath: string, globalDataPath = '', taskId = ''): Promise<ReturnType<typeof readRegisteredTaskSources>> {
  const dataRoot = normalizeGlobalDataPathForExtension(globalDataPath, projectPath);
  await ensureHealthyAutonomousRuntime({ extensionPath, globalDataPath: dataRoot });
  return readRegisteredReportSourcePages(dataRoot, { root: projectPath, ...(taskId ? { taskId } : {}) });
}
export function queryGrowthReports(projectPath: string, extensionPath: string, query: GrowthReportQuery, globalDataPath = ''): Promise<GrowthReportPage> {
  const dataRoot = normalizeGlobalDataPathForExtension(globalDataPath, projectPath);
  const key = `${dataRoot}:${projectPath}:${JSON.stringify(query)}`;
  const existing = queries.get(key); if (existing) return existing;
  const promise = readProjection(projectPath, extensionPath, query, dataRoot).finally(() => queries.delete(key));
  queries.set(key, promise); return promise;
}

async function readProjection(projectPath: string, extensionPath: string, query: GrowthReportQuery, globalDataPath: string): Promise<GrowthReportPage> {
  await ensureHealthyAutonomousRuntime({ extensionPath, globalDataPath });
  const nativeSource = await readRegisteredReportSourcePages(globalDataPath, { root: projectPath, taskId: query.taskId, metadataOnly: true });
  const requestedTaskId = query.taskId
    ? String(nativeSource.tasks.find((task: any) => task.taskId === query.taskId || task.sourceRef?.objectId === query.taskId || task.taskId === `task-${query.taskId}`)?.taskId || query.taskId)
    : query.taskId;
  const runs = nativeSource.runFiles || [];
  const readRows = async (prefix: string) => readGrowthProjectionPages(globalDataPath, projectPath, prefix);
  const writeRows = async (updates: { key: string; value: any }[]) => {
    if (updates.length) await sendRuntimeDataRequest(globalDataPath, { operation: 'write_growth_report_projection', input: { root: projectPath, updates, expectedSourceRevision: nativeSource.sourceRevision } });
  };
  {
    const source: ReturnType<typeof readRegisteredTaskSources> = nativeSource;
    const metadata: any[] = [];
    const turnMap = new Map<string, any>();
    for (const item of source.observations) {
      const old = turnMap.get(item.turnId);
      const recorded = item.availability === 'recorded' && !item.archived;
      turnMap.set(item.turnId, { ...old, ...item, summary: recorded ? item.summary : old?.summary || '', unmet: recorded ? item.unmet : old?.unmet ?? null,
        commits: recorded ? item.commits : old?.commits || [], files: recorded ? item.files : old?.files || [],
        bodyKey: recorded ? item.versionKey : old?.bodyKey, versions: [...(old?.versions || []), ...(recorded ? [item.versionKey] : [])],
        versionRefs: [...(old?.versionRefs || []), ...(recorded ? [item.sourceRef] : [])] });
    }
    metadata.push(...turnMap.values());
    let snapshot: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const first = await sendRuntimeDataRequest<{ latest: any }>(globalDataPath, { operation: 'read_project_growth', input: { root: projectPath, historyLimit: 1, detailOffset: 0, detailLimit: 200 } });
        snapshot = first.latest;
        if (!snapshot) break;
        const snapshotId = snapshot.snapshot.id;
        const detailToken = snapshot.detailToken;
        let detailOffset = snapshot.detailOffset || 0;
        while (snapshot.nextDetailOffset !== null && snapshot.nextDetailOffset !== undefined) {
          if (!Number.isInteger(snapshot.nextDetailOffset) || snapshot.nextDetailOffset <= detailOffset || !detailToken) throw new Error('growth_detail_page_invalid');
          detailOffset = snapshot.nextDetailOffset;
          const page = await sendRuntimeDataRequest<{ latest: any }>(globalDataPath, { operation: 'read_project_growth', input: {
            root: projectPath, historyLimit: 1, snapshotId, detailToken, detailOffset, detailLimit: 200
          } });
          if (!page.latest || page.latest.snapshot.id !== snapshotId || page.latest.detailToken !== detailToken) throw new Error('growth_detail_snapshot_changed');
          snapshot = { ...page.latest, nodes: [...snapshot.nodes, ...page.latest.nodes], edges: [...snapshot.edges, ...page.latest.edges],
            signals: [...snapshot.signals, ...page.latest.signals], labels: [...snapshot.labels, ...page.latest.labels] };
        }
        break;
      } catch (error) {
        snapshot = null;
        if (attempt === 0 && String((error as Error)?.message || error).includes('growth_detail_snapshot_changed')) continue;
        throw error;
      }
    }
    const nodes = new Map<string, any>(array(snapshot?.nodes).map((node: any) => [String(node.nodeId), node]));
    const moduleByPath = new Map<string, string>();
    for (const edge of snapshot?.edges || []) if (edge.kind === 'contains' && edge.sourceId.startsWith('module:')) {
      const file = nodes.get(edge.targetId); if (file) moduleByPath.set(file.path, edge.sourceId);
    }
    const evidence = (await readRows('github-summary:')).flatMap(row => array(row.value?.commits));
    const versionKey = (sha: string, files: string[]) => `${sha}\n${files.join('\n')}`;
    const historyKey = (sha: string, file: string) => `${sha}\n${file}`;
    const versionRequests = [...new Map(evidence.map(commit => {
      const files = array(commit.files).map(file => reportRelativePath(file.filename)).filter(Boolean);
      return [versionKey(String(commit.sha || ''), files), { sha: String(commit.sha || ''), files }];
    })).values()].slice(0, 1000);
    const historyRequests = [...new Map(metadata.flatMap(turn => array(turn.commits).flatMap(commit => array(commit.files).map(file => {
      const normalized = reportRelativePath(file);
      return [historyKey(String(commit.sha || ''), normalized), { sha: String(commit.sha || ''), file: normalized }];
    })))).values()].slice(0, 5000);
    const inspected = await sendRuntimeDataRequest<{ versions: string[]; history: boolean[] }>(globalDataPath, {
      operation: 'inspect_report_git_state', input: { root: projectPath, versions: versionRequests, history: historyRequests }
    });
    const versionStates = new Map(versionRequests.map((request, index) => [versionKey(request.sha, request.files), inspected.versions[index] || 'unknown']));
    const historyStates = new Map(historyRequests.map((request, index) => [historyKey(request.sha, request.file), inspected.history[index] === true]));
    const associations = new Map((await readRows('association:')).map(row => [row.key, row.value]));
    const associationUpdates: { key: string; value: any }[] = [];
    const rows = source.tasks.filter(task => !requestedTaskId || task.taskId === requestedTaskId).map(task => {
      const turns = metadata.filter(turn => turn.taskId === task.taskId).sort((a, b) => b.executionLogId - a.executionLogId || b.sequence - a.sequence);
      const latest = turns[0];
      const unmet = turns.find(turn => typeof turn.unmet === 'boolean')?.unmet ?? null;
      const modules = new Set<string>();
      const runFiles = runs.filter((run: any) => task.executions.some((execution: any) => execution.id === run.executionLogId) && ['changed', 'touched'].includes(run.role)).map((file: any) => reportRelativePath(file.filePath)).filter(Boolean);
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
          if (commits.length && !commits.some(commit => historyStates.get(historyKey(String(commit.sha || ''), file)) === true)) continue;
          associationUpdates.push({ key, value: { moduleId, identity, snapshotId: snapshot?.snapshot.id || '', sourceVersions: turns.filter(turn => array(turn.files).includes(file)).map(turn => turn.hash), basis: runFiles.includes(file) ? 'run_files' : diffFiles.includes(file) ? 'commit_diff' : 'agent_report' } });
        }
        modules.add(moduleId);
      }
      const capabilities = new Set<string>();
      for (const edge of snapshot?.edges || []) if (edge.kind === 'implements' && modules.has(edge.sourceId) && /run|user|confirmed/.test(edge.evidence)) capabilities.add(edge.targetId);
      const summary = latest?.summary || '';
      return { taskId: task.taskId, title: String(task.userMessage || ''), summary, latestSummary: summary,
        latestSequence: turns.length || undefined, latestExecutionLogId: latest?.executionLogId, createdAt: latest?.createdAt || task.startedAt,
        availability: latest?.availability || (task.unreadableReports ? 'invalid' : 'missing'), unmet, turnCount: turns.length,
        modules: [...modules].map(id => ({ id, label: nodes.get(id)?.label || id })),
        capabilities: [...capabilities].map(id => ({ id, label: nodes.get(id)?.label || id })),
        evidence: taskEvidence,
        executions: task.executions.map((run: any) => ({ id: run.id, nodeId: run.nodeId ?? path.basename(path.dirname(run.runDir)) })) };
    }).filter(task => (!query.unmetOnly || task.unmet === true)
      && (!query.moduleId || task.modules.some(module => module.id === query.moduleId))
      && (!query.capabilityId || task.capabilities.some(capability => capability.id === query.capabilityId)))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.taskId.localeCompare(a.taskId));
    const offset = Math.max(0, Number(query.offset) || 0); const limit = Math.max(1, Math.min(50, Number(query.limit) || 20));
    try { await writeRows(associationUpdates); }
    catch (error) { if (String(error).includes('report_source_changed')) return readProjection(projectPath, extensionPath, query, globalDataPath); throw error; }
    const taskTurns = metadata.filter(turn => turn.taskId === requestedTaskId).sort((a, b) => b.executionLogId - a.executionLogId || b.sequence - a.sequence);
    const selectedTurns = taskTurns.slice(offset, offset + limit);
    const bodies = new Map<string, any>();
    if (query.taskId) {
      const refs = selectedTurns.flatMap(turn => turn.versionRefs || []);
      for (let index = 0; index < refs.length; index += 8) await Promise.all(refs.slice(index, index + 8).map(async (ref: { objectId: string; revision: number }) => {
        bodies.set(`${ref.objectId}:${ref.revision}`, await readReportVersionBody(globalDataPath, projectPath, ref));
      }));
    }
    const turns = requestedTaskId && source.tasks.some(task => task.taskId === requestedTaskId)
      ? selectedTurns.map((turn, index) => ({
        ...turn, roundNumber: taskTurns.length - offset - index, report: turn.bodyKey ? presentReport(bodies.get(turn.bodyKey)) : null,
        history: (turn.versions || []).map((version: string) => ({ version, report: presentReport(bodies.get(version)) }))
      })) : [];
    const total = query.taskId ? taskTurns.length : rows.length;
    if ((await sendRuntimeDataRequest<{ revision: number }>(globalDataPath, { operation: 'read_report_source_revision', input: { root: projectPath } })).revision !== nativeSource.sourceRevision) return readProjection(projectPath, extensionPath, query, globalDataPath);
    return { projectPath, tasks: (query.taskId ? rows : rows.slice(offset, offset + limit)).map(task => ({ ...task, evidence: task.evidence.map(({ files, ...commit }) => {
      const scopedFiles = array(files).map(file => reportRelativePath(file.filename)).filter(Boolean);
      return { ...commit, versionState: versionStates.get(versionKey(String(commit.sha || ''), scopedFiles)) || 'unknown' };
    }) })), turns, total, nextOffset: offset + limit < total ? offset + limit : null };
  }
}

export function reportFiles(report: any): string[] {
  const references = [...array(report.outputs), ...array(report.artifacts), ...array(report.verification).flatMap(item => array(item?.evidence))];
  return [...new Set([...array(report.commits).flatMap(commit => array(commit?.files)),
    ...references.map(reference => typeof reference === 'string' ? reference : reference?.path || reference?.filePath || '')].map(reportRelativePath).filter(Boolean))];
}
