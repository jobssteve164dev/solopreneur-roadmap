import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface GitCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runGitCommand(projectPath: string, args: string[], timeoutMs = 30_000, env?: NodeJS.ProcessEnv): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    childProcess.execFile('git', args, {
      cwd: projectPath,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      maxBuffer: 4 * 1024 * 1024,
      ...(env ? { env } : {})
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

export async function retainPreSessionGitCommit(projectPath: string, revision: string): Promise<string | null> {
  const candidate = String(revision || '').trim().toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(candidate)) return null;
  const verified = await runGitCommand(projectPath, ['rev-parse', '--verify', `${candidate}^{commit}`], 5_000);
  const commit = verified.status === 0 ? verified.stdout.trim().toLowerCase() : '';
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) return null;
  const retained = await runGitCommand(projectPath, ['update-ref', '--no-deref', `refs/solomap/backups/${commit}`, commit], 5_000);
  if (retained.status !== 0) {
    console.warn('SoloMap pre-session Git snapshot retention failed:', retained.stderr);
    return null;
  }
  return commit;
}

export async function createPreSessionGitCommit(projectPath: string): Promise<string | null> {
  const indexPath = path.join(os.tmpdir(), `solomap-backup-index-${process.pid}-${crypto.randomUUID()}`);
  const indexLockPath = `${indexPath}.lock`;
  try {
    const isRepo = await runGitCommand(projectPath, ['rev-parse', '--is-inside-work-tree'], 5_000);
    if (isRepo.status !== 0) return null;
    const head = await runGitCommand(projectPath, ['rev-parse', '--verify', 'HEAD'], 5_000);
    const headRevision = head.status === 0 ? head.stdout.trim() : '';
    const snapshotEnv = {
      ...process.env,
      GIT_INDEX_FILE: indexPath,
      GIT_AUTHOR_NAME: 'SoloMap',
      GIT_AUTHOR_EMAIL: 'backup@solomap.local',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_NAME: 'SoloMap',
      GIT_COMMITTER_EMAIL: 'backup@solomap.local',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'
    };
    if (headRevision) {
      const readTree = await runGitCommand(projectPath, ['read-tree', headRevision], 5_000, snapshotEnv);
      if (readTree.status !== 0) {
        console.warn('SoloMap pre-session Git index initialization failed:', readTree.stderr);
        return null;
      }
    }
    const add = await runGitCommand(projectPath, ['add', '-A', '--', '.'], 30_000, snapshotEnv);
    if (add.status !== 0) {
      console.warn('SoloMap pre-session Git snapshot failed:', add.stderr);
      return null;
    }
    const tree = await runGitCommand(projectPath, ['write-tree'], 5_000, snapshotEnv);
    const treeRevision = tree.status === 0 ? tree.stdout.trim() : '';
    if (!treeRevision) return null;
    if (headRevision) {
      const headTree = await runGitCommand(projectPath, ['rev-parse', `${headRevision}^{tree}`], 5_000);
      if (headTree.status === 0 && headTree.stdout.trim() === treeRevision) {
        return retainPreSessionGitCommit(projectPath, headRevision);
      }
    }
    const message = 'SoloMap pre-session rollback snapshot';
    const commitArgs = ['commit-tree', treeRevision, ...(headRevision ? ['-p', headRevision] : []), '-m', message];
    const commit = await runGitCommand(projectPath, commitArgs, 5_000, snapshotEnv);
    const revision = commit.status === 0 ? commit.stdout.trim() : '';
    if (!revision) {
      console.warn('SoloMap pre-session Git snapshot commit failed:', commit.stderr);
      return null;
    }
    return retainPreSessionGitCommit(projectPath, revision);
  } catch (error) {
    console.error('Failed to create pre-session git commit:', error);
    return null;
  } finally {
    for (const file of [indexLockPath, indexPath]) {
      try { await fs.promises.unlink(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('SoloMap pre-session Git temporary index cleanup failed:', error); }
    }
  }
}
