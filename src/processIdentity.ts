import * as childProcess from 'child_process';
import * as fs from 'fs';

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
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
    if (fields[0] === 'Z') return '';
    return fields[19] ? `proc:${fields[19]}` : '';
  } catch {
    try {
      const value = childProcess.execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return value ? `ps:${value}` : '';
    } catch { return ''; }
  }
}

export function isProcessOwnerAlive(pid: number, birth = ''): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false; }
  const currentBirth = readProcessBirthMarker(pid);
  return !birth || !currentBirth || currentBirth === birth;
}
