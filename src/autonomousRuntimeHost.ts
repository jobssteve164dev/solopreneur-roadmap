import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as path from 'path';

import { claimRuntimeLease, readRuntimeState } from './autonomousRuntime';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';

interface RuntimeChild {
  pid?: number;
  unref(): void;
}

interface RuntimeHostOptions {
  extensionPath: string;
  globalDataPath: string;
  execPath?: string;
  runtimeId?: string;
  cognitiveEngine?: 'copilot';
  now?: Date;
  isProcessAlive?: (pid: number) => boolean;
  spawnProcess?: (command: string, args: string[], options: childProcess.SpawnOptions) => RuntimeChild;
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function ensureAutonomousRuntime(options: RuntimeHostOptions): { started: boolean; pid: number; runtimeId: string } {
  const now = options.now || new Date();
  const globalDataPath = normalizeGlobalDataPathForExtension(options.globalDataPath);
  const isProcessAlive = options.isProcessAlive || defaultIsProcessAlive;
  const current = readRuntimeState(globalDataPath);
  if (
    current
    && current.status !== 'stopped'
    && now.getTime() - new Date(current.heartbeatAt).getTime() <= 90_000
    && isProcessAlive(current.pid)
  ) {
    return { started: false, pid: current.pid, runtimeId: current.runtimeId };
  }

  const runtimeId = options.runtimeId || crypto.randomUUID();
  const entryPath = path.join(options.extensionPath, 'out', 'autonomousRuntimeProcess.js');
  const spawnProcess = options.spawnProcess || childProcess.spawn;
  const args = [
    entryPath,
    '--global-data-path', globalDataPath,
    '--runtime-id', runtimeId
  ];
  if (options.cognitiveEngine) args.push('--cognitive-engine', options.cognitiveEngine);
  const child = spawnProcess(options.execPath || process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
  const pid = Number(child.pid || 0);
  if (!pid) throw new Error('SoloMap Runtime process did not return a process ID.');
  claimRuntimeLease(globalDataPath, { runtimeId, pid, now, isProcessAlive: () => false });
  child.unref();
  return { started: true, pid, runtimeId };
}
