import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

function fileHash(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function moveRecoveryFile(sourcePath: string, targetPath: string): void {
  try {
    fs.renameSync(sourcePath, targetPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  const source = fs.lstatSync(sourcePath);
  if (source.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(sourcePath), targetPath);
  } else if (source.isFile()) {
    const sourceHash = fileHash(sourcePath);
    fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    const target = fs.lstatSync(targetPath);
    if (!target.isFile() || target.isSymbolicLink() || source.size !== target.size || sourceHash !== fileHash(targetPath)) {
      fs.unlinkSync(targetPath);
      throw new Error(`Rollback recovery copy verification failed: ${sourcePath}`);
    }
  } else {
    throw new Error(`Unsupported rollback recovery entry: ${sourcePath}`);
  }
  fs.unlinkSync(sourcePath);
}

export function moveUntrackedFilesToRollbackSafety(projectPath: string, globalDataPath: string): string {
  const listResult = childProcess.spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: projectPath,
    encoding: 'buffer'
  });
  if (listResult.status !== 0) throw new Error(String(listResult.stderr || 'Could not list untracked files.'));
  const untrackedFiles = Buffer.from(listResult.stdout || Buffer.alloc(0))
    .toString('utf8')
    .split('\0')
    .filter((item) => item.length > 0)
    .filter((item) => item !== '.solopreneur' && !item.startsWith('.solopreneur/'));
  if (untrackedFiles.length === 0) return '';

  const safeStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const projectKey = crypto.createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 16);
  const safetyRoot = path.join(globalDataPath, 'recovery', 'rollback-safety', projectKey, safeStamp);
  for (const relativeFile of untrackedFiles) {
    const sourcePath = path.resolve(projectPath, relativeFile);
    if (!sourcePath.startsWith(path.resolve(projectPath) + path.sep) || !fs.existsSync(sourcePath)) continue;
    const targetPath = path.join(safetyRoot, relativeFile);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    moveRecoveryFile(sourcePath, targetPath);
  }
  return safetyRoot;
}
