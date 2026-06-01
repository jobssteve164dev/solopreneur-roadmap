import * as fs from 'fs';
import * as path from 'path';
import * as Papa from 'papaparse';

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
  changedFiles: number;
  projectProgressPercent: number;
  completedNodes: number;
  totalNodes: number;
  latestRunAt: string;
  byAgent: Array<{
    agent: string;
    runs: number;
    minutes: number;
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

function readFileIfExists(filePath: string): string {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch {
    return '';
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
  const output = readFileIfExists(path.join(runDir, 'output.log'));
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
  const output = readFileIfExists(path.join(runDir, 'output.log'));
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

export function buildAgentImpactSummary(projects: AgentImpactProject[], now = new Date()): AgentImpactSummary {
  const weekStartMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const byAgent = new Map<string, { agent: string; runs: number; minutes: number; files: Set<string>; latestRunAtMs: number }>();
  const allChangedFiles = new Set<string>();
  let weekRuns = 0;
  let totalRuns = 0;
  let completedRuns = 0;
  let failedRuns = 0;
  let totalMinutes = 0;
  let latestRunAt = 0;
  let totalNodes = 0;
  let completedNodes = 0;

  for (const project of projects) {
    const nodes = readProjectRoadmapNodes(project.path);
    totalNodes += nodes.length;
    completedNodes += nodes.filter((node) => node.status === 'Completed').length;

    const runsRoot = path.join(project.path, '.solopreneur', 'agent-runs');
    let runNames: string[] = [];
    try {
      runNames = fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot) : [];
    } catch {
      runNames = [];
    }

    for (const runName of runNames) {
      const runDir = path.join(runsRoot, runName);
      try {
        if (!fs.statSync(runDir).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }

      const timestamp = getRunTimestamp(runDir);
      const command = readFileIfExists(path.join(runDir, 'command.txt'));
      const agent = inferAgentFromCommand(command);
      const minutes = getRunDurationMinutes(runDir, timestamp);
      const changedFiles = readRunChangedFiles(runDir).map((file) => `${project.path}:${file}`);
      const agentStats = byAgent.get(agent) || { agent, runs: 0, minutes: 0, files: new Set<string>(), latestRunAtMs: 0 };

      totalRuns += 1;
      agentStats.runs += 1;
      if (timestamp >= weekStartMs) {
        weekRuns += 1;
      }
      latestRunAt = Math.max(latestRunAt, timestamp);
      agentStats.latestRunAtMs = Math.max(agentStats.latestRunAtMs, timestamp);
      totalMinutes += minutes;
      agentStats.minutes += minutes;
      changedFiles.forEach((file) => {
        allChangedFiles.add(file);
        agentStats.files.add(file);
      });

      const status = inferRunStatus(runDir);
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
        changedFiles: item.files.size,
        latestRunAt: item.latestRunAtMs ? new Date(item.latestRunAtMs).toISOString() : ''
      }))
      .sort((a, b) => b.minutes - a.minutes || b.changedFiles - a.changedFiles || b.runs - a.runs || a.agent.localeCompare(b.agent))
  };
}

export function getAgentImpactStatus(projects: AgentImpactProject[]): AgentImpactStatus {
  return { impact: buildAgentImpactSummary(projects) };
}
