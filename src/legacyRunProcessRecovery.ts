import * as fs from 'fs';
import * as path from 'path';
import { UnifiedDataStore } from './db/unifiedDataStore';
import { isProcessOwnerAlive, readProcessBirthMarker } from './processIdentity.js';

export interface LegacyRunProcess {
  pid: number;
  birth: string;
  parentPid: number;
  projectRoot: string;
  runDirectory: string;
  executionLogId: number | null;
  scriptPath: string;
}

interface ProcessSnapshot {
  pid: number;
  parentPid: number;
  birth: string;
  argv: string[];
}

let cachedAt = 0;
let cachedProcesses: LegacyRunProcess[] = [];
let cachedPids = new Set<number>();

function processSnapshot(pid: number, knownArgv?: string[]): ProcessSnapshot | null {
  try {
    const info = fs.statSync(`/proc/${pid}`);
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return null;
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
    if (fields[0] === 'Z') return null;
    const argv = knownArgv || fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
    return { pid, parentPid: Number(fields[1] || 0), birth: `proc:${fields[19]}`, argv };
  } catch { return null; }
}

function snapshots(): ProcessSnapshot[] {
  if (process.platform !== 'linux') return [];
  let entries: string[];
  try { entries = fs.readdirSync('/proc'); }
  catch { return []; }
  return entries.filter(entry => /^\d+$/.test(entry)).map(entry => processSnapshot(Number(entry))).filter((entry): entry is ProcessSnapshot => Boolean(entry));
}

function procPids(): number[] {
  if (process.platform !== 'linux') return [];
  try { return fs.readdirSync('/proc').filter(entry => /^\d+$/.test(entry)).map(Number); }
  catch { return []; }
}

function legacySnapshots(pids = procPids()): ProcessSnapshot[] {
  const found: ProcessSnapshot[] = [];
  const marker = `${path.sep}.solopreneur${path.sep}agent-runs${path.sep}`;
  for (const pid of pids) {
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
      if (!argv.some(argument => argument.includes(marker) && path.basename(argument) === 'run-agent.sh')) continue;
      const snapshot = processSnapshot(pid, argv);
      if (snapshot) found.push(snapshot);
    } catch { /* The process exited while /proc was being read. */ }
  }
  return found;
}

function legacyRunProcess(entry: ProcessSnapshot): LegacyRunProcess | null {
  const scriptPath = entry.argv.find(argument => path.isAbsolute(argument) && path.basename(argument) === 'run-agent.sh' && argument.includes(`${path.sep}.solopreneur${path.sep}agent-runs${path.sep}`));
  if (!scriptPath) return null;
  const normalized = path.resolve(scriptPath);
  const marker = `${path.sep}.solopreneur${path.sep}agent-runs${path.sep}`;
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 1) return null;
  const declaredProjectRoot = normalized.slice(0, markerIndex);
  let projectRoot = declaredProjectRoot;
  let runDirectory = path.dirname(normalized);
  try { projectRoot = fs.realpathSync(declaredProjectRoot); } catch {}
  try { runDirectory = fs.realpathSync(runDirectory); } catch {}
  const relative = path.relative(path.join(projectRoot, '.solopreneur', 'agent-runs'), runDirectory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const parts = relative.split(path.sep);
  const executionLogId = parts.length === 2 && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null;
  return { pid: entry.pid, birth: entry.birth, parentPid: entry.parentPid, projectRoot, runDirectory, executionLogId, scriptPath: normalized };
}

export function discoverLegacyRunProcesses(projectRoot?: string, fresh = false): LegacyRunProcess[] {
  const now = Date.now();
  const currentPids = procPids();
  if (fresh || now - cachedAt > 30_000) {
    cachedProcesses = legacySnapshots(currentPids).map(legacyRunProcess).filter((entry): entry is LegacyRunProcess => Boolean(entry));
    cachedAt = now;
  } else {
    const newPids = currentPids.filter(pid => !cachedPids.has(pid));
    if (newPids.length) cachedProcesses.push(...legacySnapshots(newPids).map(legacyRunProcess).filter((entry): entry is LegacyRunProcess => Boolean(entry)));
  }
  cachedPids = new Set(currentPids);
  const resolved = projectRoot ? path.resolve(projectRoot) : '';
  return cachedProcesses.filter(entry => isProcessOwnerAlive(entry.pid, entry.birth) && (!resolved || path.resolve(entry.projectRoot) === resolved)).map(entry => ({ ...entry }));
}

async function terminateProcessTree(target: LegacyRunProcess): Promise<void> {
  const root = discoverLegacyRunProcesses(undefined, true).find(entry => entry.pid === target.pid && entry.birth === target.birth && entry.scriptPath === target.scriptPath);
  if (!root) return;
  const table = snapshots();
  const byParent = new Map<number, ProcessSnapshot[]>();
  for (const entry of table) {
    const children = byParent.get(entry.parentPid) || [];
    children.push(entry);
    byParent.set(entry.parentPid, children);
  }
  const owned: ProcessSnapshot[] = [];
  const pending = [root.pid];
  while (pending.length) {
    const parent = pending.pop()!;
    for (const child of byParent.get(parent) || []) { owned.push(child); pending.push(child.pid); }
  }
  const identities = [{ pid: root.pid, birth: root.birth }, ...owned.map(entry => ({ pid: entry.pid, birth: entry.birth }))];
  for (const identity of identities) {
    if (!isProcessOwnerAlive(identity.pid, identity.birth)) continue;
    try { process.kill(identity.pid, 'SIGTERM'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  const forceAfter = Date.now() + 1500;
  while (identities.some(identity => isProcessOwnerAlive(identity.pid, identity.birth)) && Date.now() < forceAfter) await new Promise(resolve => setTimeout(resolve, 25));
  for (const identity of identities) {
    if (!isProcessOwnerAlive(identity.pid, identity.birth)) continue;
    try { process.kill(identity.pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  const settleBy = Date.now() + 500;
  while (identities.some(identity => isProcessOwnerAlive(identity.pid, identity.birth)) && Date.now() < settleBy) await new Promise(resolve => setTimeout(resolve, 25));
  if (identities.some(identity => isProcessOwnerAlive(identity.pid, identity.birth))) throw new Error(`legacy_run_process_cleanup_failed:${target.pid}`);
}

function terminal(state: ReturnType<UnifiedDataStore['readRunCheckpointState']>, candidate: LegacyRunProcess): boolean {
  return Boolean(
    state.status.interactiveSessionClosed
    || state.status.stopRequested
    || ['Completed', 'Failed', 'Stopped'].includes(String(state.status.status))
    || state.status.finishedAt && !fs.existsSync(candidate.scriptPath)
  );
}

export async function reapFinishedLegacyRunProcesses(store: UnifiedDataStore): Promise<{ stopped: number; conflicts: string[] }> {
  let stopped = 0;
  const conflicts: string[] = [];
  const registered = new Map(store.existingRegisteredProjectScopes().map(project => [path.resolve(project.root), project.projectId]));
  for (const candidate of discoverLegacyRunProcesses(undefined, true)) {
    const projectId = registered.get(path.resolve(candidate.projectRoot));
    if (!candidate.executionLogId || !projectId) continue;
    let observed: ReturnType<UnifiedDataStore['readRunCheckpointState']>;
    try { observed = store.readRunCheckpointState(projectId, candidate.executionLogId); }
    catch { continue; }
    if (!terminal(observed, candidate)) continue;
    try {
      const current = store.readRunCheckpointState(projectId, candidate.executionLogId);
      if (current.runId !== observed.runId || current.revision !== observed.revision || !terminal(current, candidate)) continue;
      await terminateProcessTree(candidate);
      if (!isProcessOwnerAlive(candidate.pid, candidate.birth)) stopped++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      conflicts.push(`${candidate.scriptPath}: ${message}`);
    }
  }
  return { stopped, conflicts };
}
