import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';

function directChildProcessIds(parentPid: number): number[] {
  if (process.platform === 'linux') {
    const children: number[] = [];
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[1]) === parentPid) children.push(Number(name));
      } catch {
        // A child can exit while the process table is being read.
      }
    }
    return children;
  }
  try {
    if (process.platform === 'win32') {
      const output = childProcess.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${parentPid}').ProcessId`], { encoding: 'utf8', windowsHide: true });
      return output.split(/\s+/).filter(value => /^\d+$/.test(value)).map(Number);
    }
    const output = childProcess.execFileSync('ps', ['-o', 'pid=', '-P', String(parentPid)], { encoding: 'utf8' });
    return output.split(/\s+/).filter(value => /^\d+$/.test(value)).map(Number);
  } catch {
    return [];
  }
}

function descendantProcessIds(parentPid: number): number[] {
  const discovered: number[] = [];
  const pending = [parentPid];
  const seen = new Set<number>(pending);
  while (pending.length) {
    const parent = pending.shift()!;
    for (const child of directChildProcessIds(parent)) {
      if (seen.has(child)) continue;
      seen.add(child);
      discovered.push(child);
      pending.push(child);
    }
  }
  return discovered.reverse();
}

function signalProcesses(processIds: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of processIds) {
    try { process.kill(pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        console.error(`SoloMap could not signal Runtime child ${pid}:`, error);
      }
    }
  }
}

export function terminateRuntimeOwnedChildProcesses(): void {
  const children = descendantProcessIds(process.pid);
  signalProcesses(children, 'SIGTERM');
  if (!children.length) return;
  const force = setTimeout(() => {
    signalProcesses(children, 'SIGKILL');
  }, 2_000);
  force.unref();
}
