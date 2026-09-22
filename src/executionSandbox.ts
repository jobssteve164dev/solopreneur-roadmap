import * as childProcess from 'child_process';
import * as fs from 'fs';

export interface SandboxProbe {
  available: boolean;
  kind: string;
  reason: string;
}

export interface SandboxLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface ExecutionSandbox {
  probe(): Promise<SandboxProbe>;
  buildInvocation(input: { workspacePath: string; command: string; args: string[] }): SandboxLaunch;
}

type ProbeRunner = (executable: string, args: string[]) => Promise<{ ok: boolean; reason: string }>;

function defaultProbeRunner(executable: string, args: string[]): Promise<{ ok: boolean; reason: string }> {
  return new Promise(resolve => {
    childProcess.execFile(executable, args, { timeout: 5_000, windowsHide: true }, (error, _stdout, stderr) => {
      resolve(error ? { ok: false, reason: String(stderr || error.message).trim() } : { ok: true, reason: '' });
    });
  });
}

export class LinuxBubblewrapSandbox implements ExecutionSandbox {
  private readonly executable: string;
  private readonly runProbe: ProbeRunner;
  private verified = false;

  constructor(options: { executable?: string; runProbe?: ProbeRunner } = {}) {
    this.executable = options.executable || '/usr/bin/bwrap';
    this.runProbe = options.runProbe || defaultProbeRunner;
  }

  public async probe(): Promise<SandboxProbe> {
    if (process.platform !== 'linux') {
      this.verified = false;
      return { available: false, kind: 'linux-bubblewrap', reason: 'This operating-system sandbox is available on Linux only.' };
    }
    const result = await this.runProbe(this.executable, [
      '--unshare-user', '--unshare-pid', '--unshare-net',
      '--ro-bind', '/usr', '/usr',
      '--proc', '/proc', '--dev', '/dev',
      '--', '/usr/bin/true'
    ]);
    this.verified = result.ok;
    return {
      available: result.ok,
      kind: 'linux-bubblewrap',
      reason: result.ok ? '' : (result.reason || 'The operating-system sandbox could not start.')
    };
  }

  public buildInvocation(input: { workspacePath: string; command: string; args: string[] }): SandboxLaunch {
    if (!this.verified) throw new Error('The operating-system sandbox must be verified before use.');
    const args = [
      '--die-with-parent', '--new-session',
      '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup', '--unshare-net',
      '--clearenv', '--setenv', 'HOME', '/home/solomap', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'NO_COLOR', '1',
      '--ro-bind', '/usr', '/usr'
    ];
    for (const systemPath of ['/bin', '/lib', '/lib64']) {
      if (fs.existsSync(systemPath)) args.push('--ro-bind', systemPath, systemPath);
    }
    args.push(
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--dir', '/home', '--dir', '/home/solomap',
      '--bind', input.workspacePath, '/workspace', '--chdir', '/workspace',
      '--', input.command, ...(input.args || [])
    );
    return { command: this.executable, args, env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' } };
  }
}

