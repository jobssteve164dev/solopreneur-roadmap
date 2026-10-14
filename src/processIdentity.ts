import * as childProcess from 'child_process';
import * as fs from 'fs';

function readLinuxProcessStat(pid: number): { state: string; birth: string } | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
    return { state: fields[0] || '', birth: fields[19] ? `proc:${fields[19]}` : '' };
  } catch { return undefined; }
}

export function isProcessZombie(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  return readLinuxProcessStat(pid)?.state === 'Z';
}

export function readWindowsProcessBirthMarker(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid < 1) return '';
  try {
    const ticks = childProcess.execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
    ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[1-9]\d*$/.test(ticks) ? `win32:${ticks}` : '';
  } catch {
    return '';
  }
}

export async function readWindowsProcessBirthMarkerAsync(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid < 1) return '';
  return new Promise(resolve => childProcess.execFile('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
  ], { encoding: 'utf8', windowsHide: true }, (error, output) => {
    const ticks = !error ? output.trim() : '';
    resolve(/^[1-9]\d*$/.test(ticks) ? `win32:${ticks}` : '');
  }));
}

export function readProcessBirthMarker(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid < 1) return '';
  if (process.platform === 'win32') return readWindowsProcessBirthMarker(pid);
  const linuxStat = readLinuxProcessStat(pid);
  if (linuxStat) return linuxStat.state === 'Z' ? '' : linuxStat.birth;
  try {
    const value = childProcess.execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return value ? `ps:${value}` : '';
  } catch { return ''; }
}

export function isProcessOwnerAlive(pid: number, birth = ''): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false; }
  if (isProcessZombie(pid)) return false;
  const currentBirth = readProcessBirthMarker(pid);
  return !birth || !currentBirth || currentBirth === birth;
}
