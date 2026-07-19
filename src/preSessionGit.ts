import * as childProcess from 'child_process';

export interface GitCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runGitCommand(projectPath: string, args: string[], timeoutMs = 30_000): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    childProcess.execFile('git', args, {
      cwd: projectPath,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      maxBuffer: 4 * 1024 * 1024
    }, (error, stdout, stderr) => {
      const processError = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean } | null;
      resolve({
        status: processError ? (typeof processError.code === 'number' ? processError.code : null) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || processError?.message || ''),
        timedOut: Boolean(processError?.killed)
      });
    });
  });
}

export async function createPreSessionGitCommit(projectPath: string): Promise<string | null> {
  try {
    const isRepo = await runGitCommand(projectPath, ['rev-parse', '--is-inside-work-tree'], 5_000);
    if (isRepo.status !== 0) return null;

    const status = await runGitCommand(projectPath, ['status', '--porcelain'], 15_000);
    if (status.status !== 0) return null;

    if (status.stdout.trim()) {
      const add = await runGitCommand(projectPath, ['add', '-A']);
      if (add.status !== 0) {
        console.warn('SoloMap pre-session Git staging failed:', add.stderr);
        return null;
      }
      const message = `SoloMap pre-session auto-backup [${new Date().toISOString()}]`;
      const commit = await runGitCommand(projectPath, ['commit', '-m', message, '--no-verify']);
      if (commit.status !== 0) {
        console.warn('SoloMap pre-session Git commit failed:', commit.stderr);
        return null;
      }
    }

    const revision = await runGitCommand(projectPath, ['rev-parse', 'HEAD'], 5_000);
    return revision.status === 0 ? revision.stdout.trim() || null : null;
  } catch (error) {
    console.error('Failed to create pre-session git commit:', error);
    return null;
  }
}
