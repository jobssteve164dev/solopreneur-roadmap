import * as fs from 'fs';
import * as path from 'path';

export const PROJECT_OUTPUT_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface ProjectOutputLogRetentionResult {
  projectPath: string;
  projectActivityAt: string;
  cutoffAt: string;
  scanned: number;
  deleted: number;
  protectedActive: number;
  errors: string[];
}

interface OutputLogCandidate {
  filePath: string;
  activityAtMs: number;
}

function readTimestampFile(filePath: string): number {
  try {
    const parsed = Date.parse(fs.readFileSync(filePath, 'utf8').trim());
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function getConversationActivityAt(outputFilePath: string): number {
  const runDir = path.dirname(outputFilePath);
  const finishedAt = readTimestampFile(path.join(runDir, 'finished_at'));
  if (finishedAt > 0) return finishedAt;
  const startedAt = readTimestampFile(path.join(runDir, 'started_at'));
  if (startedAt > 0) return startedAt;
  try {
    return fs.statSync(outputFilePath).mtimeMs;
  } catch {
    return 0;
  }
}

function collectOutputLogs(runsRoot: string): OutputLogCandidate[] {
  const logs: OutputLogCandidate[] = [];
  const pending = [runsRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name === 'output.log') {
        logs.push({ filePath: entryPath, activityAtMs: getConversationActivityAt(entryPath) });
      }
    }
  }
  return logs.filter((log) => log.activityAtMs > 0);
}

function collectActiveOutputLogs(projectPath: string): Set<string> {
  const active = new Set<string>();
  const statusPaths: string[] = [];
  const statusDir = path.join(projectPath, '.solopreneur', 'agent-status');
  try {
    for (const entry of fs.readdirSync(statusDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        statusPaths.push(path.join(statusDir, entry.name));
      }
    }
  } catch {}
  statusPaths.push(path.join(projectPath, '.agent_status.json'));

  for (const statusPath of statusPaths) {
    try {
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      const lifecycle = String(status?.status || '');
      const outputFilePath = String(status?.outputFilePath || '').trim();
      if (outputFilePath && lifecycle && lifecycle !== 'Processed') {
        active.add(path.resolve(outputFilePath));
      }
    } catch {}
  }
  return active;
}

/**
 * Keeps a rolling seven-day output window relative to this project's own
 * latest conversation activity. Conversation metadata and history stay intact.
 */
export function pruneProjectOutputLogs(
  projectPath: string,
  retentionMs = PROJECT_OUTPUT_LOG_RETENTION_MS
): ProjectOutputLogRetentionResult {
  const result: ProjectOutputLogRetentionResult = {
    projectPath,
    projectActivityAt: '',
    cutoffAt: '',
    scanned: 0,
    deleted: 0,
    protectedActive: 0,
    errors: []
  };
  if (!projectPath || !Number.isFinite(retentionMs) || retentionMs < 0) return result;

  const logs = collectOutputLogs(path.join(projectPath, '.solopreneur', 'agent-runs'));
  result.scanned = logs.length;
  const projectActivityAtMs = logs.reduce((latest, log) => Math.max(latest, log.activityAtMs), 0);
  if (!projectActivityAtMs) return result;

  const cutoffAtMs = projectActivityAtMs - retentionMs;
  result.projectActivityAt = new Date(projectActivityAtMs).toISOString();
  result.cutoffAt = new Date(cutoffAtMs).toISOString();
  const activeOutputLogs = collectActiveOutputLogs(projectPath);

  for (const log of logs) {
    if (log.activityAtMs >= cutoffAtMs) continue;
    if (activeOutputLogs.has(path.resolve(log.filePath))) {
      result.protectedActive += 1;
      continue;
    }
    try {
      fs.unlinkSync(log.filePath);
      result.deleted += 1;
    } catch (error) {
      result.errors.push(`${log.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

export function pruneProjectsOutputLogs(projectPaths: string[]): ProjectOutputLogRetentionResult[] {
  return [...new Set((projectPaths || []).map((item) => String(item || '').trim()).filter(Boolean))]
    .map((projectPath) => pruneProjectOutputLogs(projectPath));
}
