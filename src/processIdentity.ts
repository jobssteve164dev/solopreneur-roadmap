import * as childProcess from 'child_process';

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
