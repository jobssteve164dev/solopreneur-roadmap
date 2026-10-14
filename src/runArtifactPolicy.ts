import * as path from 'path';

export type RunArtifactKind = 'prompt' | 'output' | 'control' | 'session' | 'change_evidence' | 'report';
export type RunArtifactStorageKind = RunArtifactKind | 'byproduct' | 'retained';

export function shouldDescendRunArtifactDirectory(relativePath: string): boolean {
  if (!relativePath) return true;
  const parts = relativePath.replace(/\\/g, '/').split('/');
  return parts.length === 1 || parts.length === 2 && /^\d+$/.test(parts[1]);
}

const namedKinds = new Map<string, RunArtifactKind>([
  ['prompt.txt', 'prompt'],
  ['output.log', 'output'],
  ['command.txt', 'control'],
  ['run-agent.sh', 'control'],
  ['completion.json', 'control'],
  ['started_at', 'control'],
  ['.agent_status.json', 'control'],
  ['session.json', 'session'],
  ['codex-home.txt', 'session'],
  ['touched-files.txt', 'change_evidence'],
  ['changes.txt', 'change_evidence'],
  ['workspace-before.json', 'change_evidence'],
  ['roadmap-before.csv', 'change_evidence'],
  ['task-report.json', 'report']
]);

/** Only durable inputs, outputs and recovery records belong in the database. */
export function runArtifactKind(relativePath: string): RunArtifactKind | null {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const parts = relativePath.replace(/\\/g, '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  if (parts.length === 1) return parts[0] === 'task-report.json' ? 'report' : null;
  if (parts[0] === 'learning-tasks') return parts.length === 2 && /^task-[a-zA-Z0-9-]+\.json$/.test(parts[1]) ? 'report' : null;
  if (!(parts.length === 2 || parts.length === 3 && /^\d+$/.test(parts[1]))) return null;
  const name = parts[parts.length - 1];
  if (/^task-report-(?:status-)?\d+\.json$/.test(name)) return 'report';
  return namedKinds.get(name) || null;
}

/** Unknown files directly inside a valid run may be status-declared legacy inputs. */
export function runArtifactStorageKind(relativePath: string): RunArtifactStorageKind {
  const kind = runArtifactKind(relativePath);
  if (kind) return kind;
  if (!relativePath || path.isAbsolute(relativePath)) return 'retained';
  const parts = relativePath.replace(/\\/g, '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return 'retained';
  const directRunFile = parts.length === 2 || parts.length === 3 && /^\d+$/.test(parts[1]);
  return directRunFile ? 'retained' : 'byproduct';
}
