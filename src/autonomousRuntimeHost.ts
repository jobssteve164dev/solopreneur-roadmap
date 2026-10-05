import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { claimRuntimeLease, readRuntimeState } from './autonomousRuntime';
import { RuntimeControlCommand, RuntimeControlResponse, sendRuntimeControlCommand } from './autonomousRuntimeControl';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import { PiMainPathRequest, PiMainPathResult } from './piMainPathDelivery';
import { runtimeBuildId } from './runtimeBuildIdentity';

interface RuntimeChild {
  pid?: number;
  unref(): void;
}

interface RuntimeHostOptions {
  extensionPath: string;
  globalDataPath: string;
  execPath?: string;
  runtimeId?: string;
  now?: Date;
  isProcessAlive?: (pid: number) => boolean;
  spawnProcess?: (command: string, args: string[], options: childProcess.SpawnOptions) => RuntimeChild;
  sendHealth?: (dataPath: string) => Promise<RuntimeControlResponse>;
  sendControl?: (command: RuntimeControlCommand, expectedRuntimeId?: string) => Promise<unknown>;
  buildId?: string;
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

export async function inspectAutonomousRuntimeHealth(
  globalDataPath: string,
  pid: number,
  now = Date.now(),
  sendHealth: (dataPath: string) => Promise<RuntimeControlResponse> =
    dataPath => sendRuntimeControlCommand(dataPath, 'health', { timeoutMs: 1_000 }),
  expectedEntryPath?: string,
  expectedBuildId?: string,
  expectedOwner?: string,
  allowMissingOwner = false
): Promise<{ healthy: boolean; reason: string }> {
  const state = readRuntimeState(globalDataPath);
  if (!state) return { healthy: false, reason: 'missing_state' };
  if (state.pid !== pid) return { healthy: false, reason: 'different_process' };
  if (state.status !== 'running' && state.status !== 'paused') return { healthy: false, reason: 'not_running' };
  const heartbeatAge = now - Date.parse(state.heartbeatAt);
  if (!Number.isFinite(heartbeatAge) || heartbeatAge > 90_000) return { healthy: false, reason: 'stale_heartbeat' };
  if (!defaultIsProcessAlive(pid)) return { healthy: false, reason: 'process_exited' };
  try {
    const response = await sendHealth(globalDataPath);
    if (response.runtimeId !== state.runtimeId) return { healthy: false, reason: 'different_runtime' };
    if (!response.ok || response.status !== state.status) return { healthy: false, reason: 'control_not_running' };
    if (expectedEntryPath && path.resolve(response.entryPath || '') !== path.resolve(expectedEntryPath)) {
      return { healthy: false, reason: 'different_runtime_build' };
    }
    if (expectedBuildId && response.buildId !== expectedBuildId) return { healthy: false, reason: 'different_runtime_build' };
    if (expectedOwner && response.owner !== expectedOwner && !(allowMissingOwner && !response.owner)) {
      return { healthy: false, reason: 'different_runtime_owner' };
    }
  } catch {
    return { healthy: false, reason: 'control_unavailable' };
  }
  return { healthy: true, reason: state.status };
}

export async function waitForAutonomousRuntimeHealth(
  globalDataPath: string,
  timeoutMs = 30_000,
  sendHealth?: (dataPath: string) => Promise<RuntimeControlResponse>,
  expectedEntryPath?: string,
  expectedBuildId?: string,
  expectedOwner?: string,
  expectedRuntimeId?: string,
  expectedPid?: number,
  allowMissingOwner = false,
  excludedRuntimeId?: string,
  retryIdentityMismatch = false
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let reason = 'missing_state';
  do {
    const state = readRuntimeState(globalDataPath);
    const result = state && excludedRuntimeId && state.runtimeId === excludedRuntimeId
      ? { healthy: false, reason: 'same_runtime' }
      : state && expectedRuntimeId && state.runtimeId !== expectedRuntimeId
      ? { healthy: false, reason: 'different_runtime' }
      : state && expectedPid && state.pid !== expectedPid
      ? { healthy: false, reason: 'different_process' }
      : state
      ? await inspectAutonomousRuntimeHealth(globalDataPath, state.pid, Date.now(), sendHealth, expectedEntryPath, expectedBuildId, expectedOwner, allowMissingOwner)
      : { healthy: false, reason: 'missing_state' };
    if (result.healthy) return;
    reason = result.reason;
    if ((reason === 'different_runtime_build' || reason === 'different_runtime_owner' || reason === 'different_runtime')
      && (!retryIdentityMismatch || (expectedRuntimeId && state?.runtimeId !== expectedRuntimeId))) break;
    if (expectedPid && reason === 'different_process') break;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
  throw new Error(reason);
}

export async function ensureHealthyAutonomousRuntime(options: RuntimeHostOptions): Promise<{ started: boolean; pid: number; runtimeId: string }> {
  const globalDataPath = normalizeGlobalDataPathForExtension(options.globalDataPath);
  const entryPath = path.join(options.extensionPath, 'out', 'autonomousRuntimeProcess.js');
  const buildId = options.buildId || runtimeBuildId(options.extensionPath);
  const current = readRuntimeState(globalDataPath);
  const isProcessAlive = options.isProcessAlive || defaultIsProcessAlive;
  if (current && isProcessAlive(current.pid)) {
    const health = await inspectAutonomousRuntimeHealth(globalDataPath, current.pid, Date.now(), options.sendHealth, entryPath, buildId);
    if (health.healthy) return { started: false, pid: current.pid, runtimeId: current.runtimeId };
    if (health.reason !== 'different_runtime_build') throw new Error(health.reason);
    try {
      await (options.sendControl || ((command, expectedRuntimeId) => sendRuntimeControlCommand(globalDataPath, command, { expectedRuntimeId })))('drain', current.runtimeId);
    } catch (error) {
      if (error instanceof Error && error.message === 'different_runtime') throw error;
      throw new Error('control_unavailable');
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const state = readRuntimeState(globalDataPath);
      if ((!state || state.runtimeId !== current.runtimeId || state.status === 'stopped') && !isProcessAlive(current.pid)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (isProcessAlive(current.pid)) throw new Error('runtime_drain_timeout');
  }
  const result = ensureAutonomousRuntime(options);
  await waitForAutonomousRuntimeHealth(globalDataPath, 30_000, options.sendHealth, entryPath, buildId, undefined, result.runtimeId, result.pid, false, undefined, true);
  return result;
}

export function ensureAutonomousRuntime(options: RuntimeHostOptions): { started: boolean; pid: number; runtimeId: string } {
  const now = options.now || new Date();
  const globalDataPath = normalizeGlobalDataPathForExtension(options.globalDataPath);
  const isProcessAlive = options.isProcessAlive || defaultIsProcessAlive;
  const current = readRuntimeState(globalDataPath);
  if (
    current
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
  const child = spawnProcess(options.execPath || process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
  const pid = Number(child.pid || 0);
  if (!pid) throw new Error('SoloMap Runtime process did not return a process ID.');
  const lease = claimRuntimeLease(globalDataPath, { runtimeId, pid, now, isProcessAlive });
  child.unref();
  if (!lease.acquired) return { started: false, pid: lease.owner.pid, runtimeId: lease.owner.runtimeId };
  return { started: true, pid, runtimeId };
}

export function startPiMainPathDelivery(options: {
  extensionPath: string;
  globalDataPath: string;
  request: PiMainPathRequest;
  execPath?: string;
}): Promise<PiMainPathResult> {
  const globalDataPath = normalizeGlobalDataPathForExtension(options.globalDataPath);
  const requestRoot = path.join(globalDataPath, 'runtime', 'pi-delivery-requests');
  fs.mkdirSync(requestRoot, { recursive: true });
  const requestPath = path.join(requestRoot, `${crypto.randomUUID()}.json`);
  fs.writeFileSync(requestPath, JSON.stringify(options.request), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const entryPath = path.join(options.extensionPath, 'out', 'autonomousRuntimeProcess.js');
  return new Promise((resolve, reject) => {
    childProcess.execFile(options.execPath || process.execPath, [
      entryPath,
      '--global-data-path', globalDataPath,
      '--delivery-request-file', requestPath
    ], {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      try { fs.unlinkSync(requestPath); } catch { /* The exact one-shot request may already be gone. */ }
      if (error) {
        reject(new Error(`SoloMap Pi delivery failed: ${String(stderr || error.message).trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as PiMainPathResult);
      } catch {
        reject(new Error('SoloMap Pi delivery returned an invalid result.'));
      }
    });
  });
}
