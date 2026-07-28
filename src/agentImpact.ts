import * as fs from 'fs';
import * as path from 'path';
import * as Papa from 'papaparse';
import { SqliteStore } from './db/sqliteStore';
import { RunIndexEntry } from './db/types';
import { AgentTokenUsage, extractRunTokenUsage, extractTokenUsageFromOutput, normalizeTokenUsage } from './tokenUsage';
import { getTrustedWorkDurationMs } from './workHabits';

export interface AgentImpactProject {
  name: string;
  path: string;
}

export interface AgentImpactSummary {
  weekRuns: number;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  totalMinutes: number;
  totalTokens: number;
  tokenRuns: number;
  changedFiles: number;
  projectProgressPercent: number;
  completedNodes: number;
  totalNodes: number;
  latestRunAt: string;
  byAgent: Array<{
    agent: string;
    runs: number;
    minutes: number;
    tokens: number;
    tokenRuns: number;
    changedFiles: number;
    latestRunAt: string;
  }>;
}

export interface AgentImpactStatus {
  impact: AgentImpactSummary;
}

interface RoadmapNodeLike {
  id: string;
  status: string;
}

interface AgentImpactRun {
  agent: string;
  status: 'completed' | 'failed' | 'unknown';
  timestamp: number;
  minutes: number;
  tokenUsage: AgentTokenUsage;
  changedFiles: string[];
}

function readFileIfExists(filePath: string): string {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch {
    return '';
  }
}

function readFileTailIfExists(filePath: string, maxBytes = 64 * 1024): string {
  let fd: number | null = null;
  try {
    if (!fs.existsSync(filePath)) {
      return '';
    }
    const stat = fs.statSync(filePath);
    const length = Math.min(Math.max(0, stat.size), maxBytes);
    if (length <= 0) {
      return '';
    }
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function getRunTimestamp(runDir: string): number {
  const startedAtPath = path.join(runDir, 'started_at');
  const startedAt = readFileIfExists(startedAtPath).trim();
  const parsed = startedAt ? Date.parse(startedAt) : NaN;
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  try {
    return fs.statSync(runDir).mtimeMs;
  } catch {
    return 0;
  }
}

function getRunDurationMinutes(runDir: string, startedAtMs: number): number {
  const output = readFileTailIfExists(path.join(runDir, 'output.log'));
  const storedDuration = output.match(/Run duration ms:\s*(\d+)/);
  if (storedDuration) {
    return Math.max(1, Math.round(Number(storedDuration[1] || 0) / 60000));
  }
  const candidates = [
    'completion.json',
    'touched-files.txt',
    'changes.txt',
    'output.log',
    'session.json'
  ].map((name) => path.join(runDir, name));
  const latestMtime = candidates.reduce((latest, candidate) => {
    try {
      return fs.existsSync(candidate) ? Math.max(latest, fs.statSync(candidate).mtimeMs) : latest;
    } catch {
      return latest;
    }
  }, startedAtMs);
  const durationMs = Math.max(0, latestMtime - startedAtMs);
  return durationMs > 0 ? Math.max(1, Math.round(durationMs / 60000)) : 0;
}

function inferAgentFromCommand(command: string): string {
  const lower = String(command || '').toLowerCase();
  if (/\bcodex(?:-cli)?\b/.test(lower)) return 'codex';
  if (/\bclaude(?:-code|-code-cli)?\b/.test(lower)) return 'claude';
  if (/\bcursor(?:-cli)?\b/.test(lower)) return 'cursor';
  if (/\bcopilot(?:-cli)?\b/.test(lower)) return 'copilot';
  if (/\b(?:opencode|open-code|open-code-cli)\b/.test(lower)) return 'opencode';
  if (/\b(?:agy|antigravity|antigravity-cli)\b/.test(lower)) return 'agy';
  return 'unknown';
}

function inferRunStatus(runDir: string): 'completed' | 'failed' | 'unknown' {
  const completionPath = path.join(runDir, 'completion.json');
  if (fs.existsSync(completionPath)) {
    try {
      const completion = JSON.parse(fs.readFileSync(completionPath, 'utf8'));
      if (completion?.markCompleted === true) {
        return 'completed';
      }
      if (completion?.markCompleted === false || completion?.failureReason || completion?.failureCode) {
        return 'failed';
      }
    } catch {
      return 'unknown';
    }
  }
  const output = readFileTailIfExists(path.join(runDir, 'output.log'));
  if (/Failure category:|Failure reason:|Agent CLI exited before completing/i.test(output)) {
    return 'failed';
  }
  return 'unknown';
}

function parseChangedFiles(content: string): string[] {
  return String(content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^(?:[AMDRCU?!]{1,2}|\?\?)\s+/, '').trim())
    .filter((line) => line && !line.startsWith('.solopreneur/agent-runs/'));
}

function readRunChangedFiles(runDir: string): string[] {
  const touched = parseChangedFiles(readFileIfExists(path.join(runDir, 'touched-files.txt')));
  if (touched.length > 0) {
    return touched;
  }
  return parseChangedFiles(readFileIfExists(path.join(runDir, 'changes.txt')));
}

function isAgentRunDir(runDir: string): boolean {
  return [
    'command.txt',
    'output.log',
    'completion.json',
    'touched-files.txt',
    'changes.txt',
    'prompt.txt'
  ].some((name) => fs.existsSync(path.join(runDir, name)));
}

function listAgentRunDirs(runsRoot: string): string[] {
  const result: string[] = [];
  const visit = (dir: string) => {
    let entries: string[] = [];
    try {
      entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    } catch {
      return;
    }
    if (isAgentRunDir(dir)) {
      result.push(dir);
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(dir, entry);
      try {
        if (fs.statSync(candidate).isDirectory()) {
          visit(candidate);
        }
      } catch {
        // Ignore partial run directories while an Agent is still starting.
      }
    }
  };
  visit(runsRoot);
  return result;
}

function normalizeRunKind(value: unknown): string {
  const kind = String(value || '').trim();
  return kind || 'step';
}

function isImpactRunKind(kind: string): boolean {
  return /^(step|step_continue|solo|solo_continue|roadmap_revision)$/.test(kind);
}

function statusFromDigest(value: unknown): 'completed' | 'failed' | 'unknown' {
  const status = String(value || '').trim();
  if (status === 'Completed' || status === 'Recorded' || status === 'In Progress') {
    return 'completed';
  }
  if (status === 'Failed') {
    return 'failed';
  }
  return 'unknown';
}

function inferAgentFromDigest(digest: any): string {
  const agentCli = String(digest?.agentCli || '').trim();
  if (agentCli) {
    return inferAgentFromCommand(agentCli);
  }
  const commandSignal = Array.isArray(digest?.commandSignals) ? String(digest.commandSignals[0] || '') : '';
  return inferAgentFromCommand(commandSignal);
}

function readRunsFromRunIndexEntries(entries: RunIndexEntry[], projectPath: string): AgentImpactRun[] {
  return entries.map((entry) => {
    const runKind = normalizeRunKind(entry.runKind);
    if (!isImpactRunKind(runKind)) {
      return null;
    }
    const timestamp = Date.parse(String(entry.finishedAt || entry.startedAt || ''));
    let tokenUsage = normalizeTokenUsage({
      inputTokens: entry.inputTokens,
      cachedInputTokens: entry.cachedInputTokens,
      outputTokens: entry.outputTokens,
      reasoningOutputTokens: entry.reasoningOutputTokens,
      totalTokens: entry.totalTokens
    });
    if (tokenUsage.totalTokens <= 0 && entry.outputPath) {
      const outputPath = path.isAbsolute(entry.outputPath) ? entry.outputPath : path.join(projectPath, entry.outputPath);
      const runDir = path.dirname(outputPath);
      let sessionId = '';
      try {
        sessionId = String(JSON.parse(readFileIfExists(path.join(runDir, 'session.json')))?.sessionId || '').trim();
      } catch {}
      tokenUsage = extractRunTokenUsage({
        agentCli: entry.agentCli,
        outputText: readFileTailIfExists(outputPath),
        workspaceRoot: projectPath,
        startedAt: entry.startedAt,
        sessionId,
        codexHome: readFileIfExists(path.join(runDir, 'codex-home.txt')).trim()
      });
    }
    return {
      agent: inferAgentFromCommand(entry.agentCli),
      status: statusFromDigest(entry.status),
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      minutes: Number(entry.durationMs || 0) > 0 ? Math.max(1, Math.round(Number(entry.durationMs || 0) / 60000)) : 0,
      tokenUsage,
      changedFiles: entry.files
        .filter((file) => file.role === 'changed' || file.role === 'touched')
        .map((file) => String(file.filePath || '').trim())
        .filter(Boolean)
    };
  }).filter((run): run is AgentImpactRun => Boolean(run));
}

async function readRunsFromRunIndex(projectPath: string, extensionPath: string): Promise<AgentImpactRun[]> {
  const dbPath = path.join(projectPath, '.solopreneur', 'project_journal.db');
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  const store = new SqliteStore(dbPath, extensionPath);
  try {
    await store.init();
    return readRunsFromRunIndexEntries(store.getRunIndexEntries(), projectPath);
  } catch {
    return [];
  } finally {
    store.close();
  }
}

function readRunsFromDigests(projectPath: string): AgentImpactRun[] {
  const digestRoot = path.join(projectPath, '.solopreneur', 'run-digests');
  if (!fs.existsSync(digestRoot)) {
    return [];
  }
  let files: string[] = [];
  try {
    files = fs.readdirSync(digestRoot).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
  return files.map((file) => {
    let digest: any = null;
    try {
      digest = JSON.parse(fs.readFileSync(path.join(digestRoot, file), 'utf8'));
    } catch {
      return null;
    }
    if (!digest || typeof digest !== 'object') {
      return null;
    }
    const runKind = normalizeRunKind(digest.runKind);
    if (!isImpactRunKind(runKind)) {
      return null;
    }
    const timestamp = Date.parse(String(digest.finishedAt || digest.startedAt || ''));
    const durationMs = Math.max(0, Number(digest.durationMs || 0));
    const changedFiles = [
      ...(Array.isArray(digest.changedFiles) ? digest.changedFiles : []),
      ...(Array.isArray(digest.touchedFiles) ? digest.touchedFiles : [])
    ].map((item) => String(item || '').trim()).filter(Boolean);
    return {
      agent: inferAgentFromDigest(digest),
      status: statusFromDigest(digest.status),
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      minutes: durationMs > 0 ? Math.max(1, Math.round(durationMs / 60000)) : 0,
      tokenUsage: normalizeTokenUsage(digest.tokenUsage),
      changedFiles
    };
  }).filter((run): run is AgentImpactRun => Boolean(run));
}

function readRunsFromAgentDirs(projectPath: string): AgentImpactRun[] {
  const runsRoot = path.join(projectPath, '.solopreneur', 'agent-runs');
  return listAgentRunDirs(runsRoot).map((runDir) => {
    const timestamp = getRunTimestamp(runDir);
    const command = readFileIfExists(path.join(runDir, 'command.txt'));
    const output = readFileTailIfExists(path.join(runDir, 'output.log'));
    return {
      agent: inferAgentFromCommand(command),
      status: inferRunStatus(runDir),
      timestamp,
      minutes: getRunDurationMinutes(runDir, timestamp),
      tokenUsage: extractTokenUsageFromOutput(output, command),
      changedFiles: readRunChangedFiles(runDir)
    };
  });
}

function readProjectRoadmapNodes(projectPath: string): RoadmapNodeLike[] {
  const roadmapPath = path.join(projectPath, '.solopreneur', 'roadmap.csv');
  if (!fs.existsSync(roadmapPath)) {
    return [];
  }
  try {
    const content = fs.readFileSync(roadmapPath, 'utf8');
    const parsed = Papa.parse<RoadmapNodeLike>(content, {
      header: true,
      skipEmptyLines: true
    });
    return parsed.data
      .map((node) => ({
        id: String(node.id || '').trim(),
        status: String(node.status || 'Pending').trim() || 'Pending'
      }))
      .filter((node) => node.id);
  } catch {
    return [];
  }
}

function buildAgentImpactSummaryFromProjectRuns(
  projects: AgentImpactProject[],
  getRuns: (project: AgentImpactProject) => AgentImpactRun[],
  now = new Date()
): AgentImpactSummary {
  const weekStartMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const byAgent = new Map<string, { agent: string; runs: number; minutes: number; tokens: number; tokenRuns: number; files: Set<string>; latestRunAtMs: number }>();
  const allChangedFiles = new Set<string>();
  let weekRuns = 0;
  let totalRuns = 0;
  let completedRuns = 0;
  let failedRuns = 0;
  let totalMinutes = 0;
  let totalTokens = 0;
  let tokenRuns = 0;
  let latestRunAt = 0;
  let totalNodes = 0;
  let completedNodes = 0;

  for (const project of projects) {
    const nodes = readProjectRoadmapNodes(project.path);
    totalNodes += nodes.length;
    completedNodes += nodes.filter((node) => node.status === 'Completed').length;

    const runs = getRuns(project);
    for (const run of runs) {
      const agent = run.agent;
      const timestamp = run.timestamp;
      const trustedDurationMs = getTrustedWorkDurationMs({
        startedAt: timestamp ? new Date(timestamp - run.minutes * 60000).toISOString() : '',
        finishedAt: timestamp ? new Date(timestamp).toISOString() : '',
        durationMs: run.minutes * 60000
      });
      const minutes = trustedDurationMs === null ? 0 : run.minutes;
      const changedFiles = run.changedFiles.map((file) => `${project.path}:${file}`);
      const agentStats = byAgent.get(agent) || { agent, runs: 0, minutes: 0, tokens: 0, tokenRuns: 0, files: new Set<string>(), latestRunAtMs: 0 };

      totalRuns += 1;
      agentStats.runs += 1;
      if (timestamp >= weekStartMs) {
        weekRuns += 1;
      }
      latestRunAt = Math.max(latestRunAt, timestamp);
      agentStats.latestRunAtMs = Math.max(agentStats.latestRunAtMs, timestamp);
      totalMinutes += minutes;
      agentStats.minutes += minutes;
      if (run.tokenUsage.totalTokens > 0) {
        totalTokens += run.tokenUsage.totalTokens;
        tokenRuns += 1;
        agentStats.tokens += run.tokenUsage.totalTokens;
        agentStats.tokenRuns += 1;
      }
      changedFiles.forEach((file) => {
        allChangedFiles.add(file);
        agentStats.files.add(file);
      });

      const status = run.status;
      if (status === 'completed') {
        completedRuns += 1;
      } else if (status === 'failed') {
        failedRuns += 1;
      }
      byAgent.set(agent, agentStats);
    }
  }

  return {
    weekRuns,
    totalRuns,
    completedRuns,
    failedRuns,
    totalMinutes,
    totalTokens,
    tokenRuns,
    changedFiles: allChangedFiles.size,
    projectProgressPercent: totalNodes > 0 ? Math.round((completedNodes / totalNodes) * 100) : 0,
    completedNodes,
    totalNodes,
    latestRunAt: latestRunAt ? new Date(latestRunAt).toISOString() : '',
    byAgent: [...byAgent.values()]
      .map((item) => ({
        agent: item.agent,
        runs: item.runs,
        minutes: item.minutes,
        tokens: item.tokens,
        tokenRuns: item.tokenRuns,
        changedFiles: item.files.size,
        latestRunAt: item.latestRunAtMs ? new Date(item.latestRunAtMs).toISOString() : ''
      }))
      .sort((a, b) => b.minutes - a.minutes || b.changedFiles - a.changedFiles || b.runs - a.runs || a.agent.localeCompare(b.agent))
  };
}

export function buildAgentImpactSummary(projects: AgentImpactProject[], now = new Date()): AgentImpactSummary {
  return buildAgentImpactSummaryFromProjectRuns(projects, (project) => {
    const digestRuns = readRunsFromDigests(project.path);
    return digestRuns.length > 0 ? digestRuns : readRunsFromAgentDirs(project.path);
  }, now);
}

export async function buildAgentImpactSummaryFromDatabase(projects: AgentImpactProject[], extensionPath: string, now = new Date()): Promise<AgentImpactSummary> {
  const runsByProject = new Map<string, AgentImpactRun[]>();
  for (const project of projects) {
    const indexedRuns = await readRunsFromRunIndex(project.path, extensionPath);
    if (indexedRuns.length > 0) {
      runsByProject.set(project.path, indexedRuns);
      continue;
    }
    const digestRuns = readRunsFromDigests(project.path);
    runsByProject.set(project.path, digestRuns.length > 0 ? digestRuns : readRunsFromAgentDirs(project.path));
  }
  return buildAgentImpactSummaryFromProjectRuns(projects, (project) => runsByProject.get(project.path) || [], now);
}

export function getAgentImpactStatus(projects: AgentImpactProject[]): AgentImpactStatus {
  return { impact: buildAgentImpactSummary(projects) };
}

export async function getAgentImpactStatusFromDatabase(projects: AgentImpactProject[], extensionPath: string): Promise<AgentImpactStatus> {
  return { impact: await buildAgentImpactSummaryFromDatabase(projects, extensionPath) };
}
