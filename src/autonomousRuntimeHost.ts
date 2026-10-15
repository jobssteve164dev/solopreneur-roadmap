import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { claimRuntimeLease, readRuntimeState, RuntimeState, runtimeDatabaseAuthorityRegistered, runtimeRootRequiresExistingDatabase } from './autonomousRuntime';
import { RuntimeControlCommand, RuntimeControlResponse, sendRuntimeControlCommand } from './autonomousRuntimeControl';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import { PiMainPathRequest, PiMainPathResult } from './piMainPathDelivery';
import { runtimeBuildId, runtimeReleaseVersion } from './runtimeBuildIdentity';
import { isProcessOwnerAlive as processOwnerAlive, isProcessZombie } from './processIdentity.js';

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
  isProcessOwnerAlive?: (pid: number, birth: string) => boolean;
  spawnProcess?: (command: string, args: string[], options: childProcess.SpawnOptions) => RuntimeChild;
  sendHealth?: (dataPath: string) => Promise<RuntimeControlResponse>;
  sendControl?: (command: RuntimeControlCommand, expectedRuntimeId?: string, replacementBuildId?: string, replacementVersion?: string) => Promise<unknown>;
  buildId?: string;
  releaseVersion?: string;
  verifyRuntimeProcess?: (pid: number, runtimeId: string, globalDataPath: string) => boolean;
  terminateProcess?: (pid: number) => Promise<void>;
  drainTimeoutMs?: number;
}

const activeDataLeaseMaxAgeMs = 6 * 60 * 60 * 1000;

function isStrictlyNewerRuntimeRelease(current: string | undefined, requested: string): boolean {
  const parse = (value: string | undefined): [number, number, number] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ''));
    if (!match) return undefined;
    const parts = match.slice(1).map(Number);
    return parts.every(Number.isSafeInteger) ? parts as [number, number, number] : undefined;
  };
  const currentParts = parse(current);
  const requestedParts = parse(requested);
  if (!currentParts || !requestedParts) return false;
  for (let index = 0; index < currentParts.length; index++) {
    if (currentParts[index] !== requestedParts[index]) return currentParts[index] > requestedParts[index];
  }
  return false;
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return !isProcessZombie(pid);
  } catch {
    return false;
  }
}

function verifiedRuntimeProcess(pid: number, runtimeId: string, globalDataPath: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  const state = readRuntimeState(globalDataPath);
  if (!state || state.pid !== pid || state.runtimeId !== runtimeId) return false;
  try {
    const endpoint = JSON.parse(fs.readFileSync(path.join(globalDataPath, 'runtime', 'control.json'), 'utf8')) as { runtimeId?: string; entryPath?: string };
    const entryPath = path.resolve(String(endpoint.entryPath || ''));
    if (endpoint.runtimeId !== runtimeId || path.basename(entryPath) !== 'autonomousRuntimeProcess.js' || path.basename(path.dirname(entryPath)) !== 'out') return false;
    if (process.platform === 'linux') {
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const entryMatches = command.some(value => path.resolve(value) === entryPath);
      const dataIndex = command.indexOf('--global-data-path');
      const runtimeIndex = command.indexOf('--runtime-id');
      return entryMatches
        && dataIndex >= 0
        && path.resolve(command[dataIndex + 1] || '') === path.resolve(globalDataPath)
        && runtimeIndex >= 0
        && command[runtimeIndex + 1] === runtimeId;
    }
    const heartbeatAt = Date.parse(state.heartbeatAt);
    return Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= 90_000;
  } catch {
    return false;
  }
}

function registeredRuntimeEntryPath(globalDataPath: string, runtimeId: string): string {
  try {
    const endpoint = JSON.parse(fs.readFileSync(path.join(globalDataPath, 'runtime', 'control.json'), 'utf8')) as { runtimeId?: string; entryPath?: string };
    const entryPath = path.resolve(String(endpoint.entryPath || ''));
    return endpoint.runtimeId === runtimeId
      && path.basename(entryPath) === 'autonomousRuntimeProcess.js'
      && path.basename(path.dirname(entryPath)) === 'out'
      ? entryPath : '';
  } catch { return ''; }
}

function verifiedDrainedRuntimeProcess(current: RuntimeState, globalDataPath: string, entryPath: string): boolean {
  if (!entryPath || current.pid === process.pid || !processOwnerAlive(current.pid, current.processBirth || '')) return false;
  if (process.platform !== 'linux') return true;
  try {
    const command = fs.readFileSync(`/proc/${current.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const dataIndex = command.indexOf('--global-data-path');
    const runtimeIndex = command.indexOf('--runtime-id');
    return command.some(value => path.resolve(value) === entryPath)
      && dataIndex >= 0
      && path.resolve(command[dataIndex + 1] || '') === path.resolve(globalDataPath)
      && runtimeIndex >= 0
      && command[runtimeIndex + 1] === current.runtimeId;
  } catch { return false; }
}

function runtimeHasActiveDataLease(globalDataPath: string, runtimeId: string, entryPath: string, buildId: string, releaseVersion: string, preserveNewerRelease = false): boolean {
  try {
    const endpoint = JSON.parse(fs.readFileSync(path.join(globalDataPath, 'runtime', 'control.json'), 'utf8')) as {
      schemaVersion?: number; runtimeId?: string; host?: string; port?: number; token?: string; entryPath?: string; buildId?: string; releaseVersion?: string;
    };
    const lease = JSON.parse(fs.readFileSync(path.join(globalDataPath, 'runtime', 'control.busy.json'), 'utf8')) as {
      schemaVersion?: number; runtimeId?: string; entryPath?: string; buildId?: string; releaseVersion?: string; busySince?: string;
    };
    const busySince = typeof lease.busySince === 'string' ? Date.parse(lease.busySince) : NaN;
    const busyAge = Date.now() - busySince;
    const endpointEntryPath = path.resolve(String(endpoint.entryPath || ''));
    const leaseEntryPath = path.resolve(String(lease.entryPath || ''));
    const exactRequestedBuild = endpointEntryPath === path.resolve(entryPath)
      && endpoint.buildId === buildId
      && endpoint.releaseVersion === releaseVersion;
    const validNewerBuild = preserveNewerRelease
      && path.basename(endpointEntryPath) === 'autonomousRuntimeProcess.js'
      && path.basename(path.dirname(endpointEntryPath)) === 'out'
      && typeof endpoint.buildId === 'string'
      && endpoint.buildId.length > 0
      && isStrictlyNewerRuntimeRelease(endpoint.releaseVersion, releaseVersion);
    return endpoint.schemaVersion === 1
      && endpoint.runtimeId === runtimeId
      && endpoint.host === '127.0.0.1'
      && Number.isInteger(endpoint.port) && Number(endpoint.port) > 0
      && typeof endpoint.token === 'string' && endpoint.token.length >= 32
      && (exactRequestedBuild || validNewerBuild)
      && lease.schemaVersion === 1
      && lease.runtimeId === runtimeId
      && leaseEntryPath === endpointEntryPath
      && lease.buildId === endpoint.buildId
      && lease.releaseVersion === endpoint.releaseVersion
      && Number.isFinite(busyAge)
      && busyAge >= -5_000
      && busyAge <= activeDataLeaseMaxAgeMs;
  } catch {
    return false;
  }
}

async function terminateVerifiedRuntimeProcess(pid: number): Promise<void> {
  process.kill(pid, 'SIGTERM');
  const gracefulDeadline = Date.now() + 2_000;
  while (Date.now() < gracefulDeadline && defaultIsProcessAlive(pid)) await new Promise(resolve => setTimeout(resolve, 50));
  if (defaultIsProcessAlive(pid)) process.kill(pid, 'SIGKILL');
  const forcedDeadline = Date.now() + 3_000;
  while (Date.now() < forcedDeadline && defaultIsProcessAlive(pid)) await new Promise(resolve => setTimeout(resolve, 50));
  if (defaultIsProcessAlive(pid)) throw new Error('runtime_termination_failed');
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
): Promise<{ healthy: boolean; reason: string; releaseVersion?: string }> {
  const state = readRuntimeState(globalDataPath);
  if (!state) return { healthy: false, reason: 'missing_state' };
  if (state.pid !== pid) return { healthy: false, reason: 'different_process' };
  if (state.status !== 'running' && state.status !== 'paused') return { healthy: false, reason: 'not_running' };
  const heartbeatAge = now - Date.parse(state.heartbeatAt);
  if (!defaultIsProcessAlive(pid)) return { healthy: false, reason: 'process_exited' };
  try {
    const response = await sendHealth(globalDataPath);
    if (response.runtimeId !== state.runtimeId) return { healthy: false, reason: 'different_runtime' };
    if (!response.ok || response.status !== state.status) return { healthy: false, reason: 'control_not_running' };
    if (expectedEntryPath && path.resolve(response.entryPath || '') !== path.resolve(expectedEntryPath)) {
      return { healthy: false, reason: 'different_runtime_build', ...(response.releaseVersion ? { releaseVersion: response.releaseVersion } : {}) };
    }
    if (expectedBuildId && response.buildId !== expectedBuildId) {
      return { healthy: false, reason: 'different_runtime_build', ...(response.releaseVersion ? { releaseVersion: response.releaseVersion } : {}) };
    }
    if (expectedOwner && response.owner !== expectedOwner && !(allowMissingOwner && !response.owner)) {
      return { healthy: false, reason: 'different_runtime_owner' };
    }
  } catch {
    return !Number.isFinite(heartbeatAge) || heartbeatAge > 90_000
      ? { healthy: false, reason: 'stale_heartbeat' }
      : { healthy: false, reason: 'control_unavailable' };
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

const runtimeHealthRequests = new Map<string, Promise<{ started: boolean; pid: number; runtimeId: string }>>();

export function ensureHealthyAutonomousRuntime(options: RuntimeHostOptions): Promise<{ started: boolean; pid: number; runtimeId: string }> {
  const globalDataPath = normalizeGlobalDataPathForExtension(options.globalDataPath);
  const buildId = options.buildId || runtimeBuildId(options.extensionPath);
  const releaseVersion = options.releaseVersion || (!options.buildId ? runtimeReleaseVersion(options.extensionPath) : '');
  const key = JSON.stringify([globalDataPath, path.resolve(options.extensionPath), buildId]);
  let pending = runtimeHealthRequests.get(key);
  if (pending) return pending;
  if (runtimeDatabaseAuthorityRegistered(globalDataPath) && !fs.existsSync(path.join(globalDataPath, 'solomap.db'))) {
    return Promise.reject(new Error('database_restore_required'));
  }
  pending = ensureHealthyAutonomousRuntimeOnce({ ...options, globalDataPath, buildId, releaseVersion })
    .finally(() => { runtimeHealthRequests.delete(key); });
  runtimeHealthRequests.set(key, pending);
  return pending;
}

async function ensureHealthyAutonomousRuntimeOnce(options: RuntimeHostOptions): Promise<{ started: boolean; pid: number; runtimeId: string }> {
  const globalDataPath = normalizeGlobalDataPathForExtension(options.globalDataPath);
  const entryPath = path.join(options.extensionPath, 'out', 'autonomousRuntimeProcess.js');
  const buildId = options.buildId || runtimeBuildId(options.extensionPath);
  const releaseVersion = options.releaseVersion || (!options.buildId ? runtimeReleaseVersion(options.extensionPath) : '');
  const current = readRuntimeState(globalDataPath);
  const isProcessAlive = options.isProcessAlive || defaultIsProcessAlive;
  const isOwnerAlive = options.isProcessOwnerAlive || (options.isProcessAlive ? ((pid: number) => options.isProcessAlive!(pid)) : processOwnerAlive);
  if (current && isOwnerAlive(current.pid, current.processBirth || '')) {
    let health = await inspectAutonomousRuntimeHealth(globalDataPath, current.pid, Date.now(), options.sendHealth, entryPath, buildId);
    if (health.healthy) return { started: false, pid: current.pid, runtimeId: current.runtimeId };
    if (health.reason === 'control_unavailable' || health.reason === 'stale_heartbeat') {
      await new Promise(resolve => setTimeout(resolve, 250));
      health = await inspectAutonomousRuntimeHealth(globalDataPath, current.pid, Date.now(), options.sendHealth, entryPath, buildId);
      if (health.healthy) return { started: false, pid: current.pid, runtimeId: current.runtimeId };
      const verify = options.verifyRuntimeProcess || verifiedRuntimeProcess;
      if (!['control_unavailable', 'stale_heartbeat'].includes(health.reason) || !verify(current.pid, current.runtimeId, globalDataPath)) throw new Error(health.reason);
      // A packaged Runtime can be temporarily unable to answer health while a
      // synchronous SQLite request owns its event loop. Preserve the exact
      // build or a strictly newer build while its accepted-work lease is
      // bounded; an expired lease still follows stale-owner recovery below.
      if (releaseVersion && runtimeHasActiveDataLease(globalDataPath, current.runtimeId, entryPath, buildId, releaseVersion, true)) {
        return { started: false, pid: current.pid, runtimeId: current.runtimeId };
      }
      await (options.terminateProcess || terminateVerifiedRuntimeProcess)(current.pid);
      if (isOwnerAlive(current.pid, current.processBirth || '')) throw new Error('runtime_termination_failed');
    } else {
      if (health.reason !== 'different_runtime_build') throw new Error(health.reason);
      if (isStrictlyNewerRuntimeRelease(health.releaseVersion, releaseVersion)) {
        return { started: false, pid: current.pid, runtimeId: current.runtimeId };
      }
      const drainingEntryPath = registeredRuntimeEntryPath(globalDataPath, current.runtimeId);
      try {
        await (options.sendControl || ((command, expectedRuntimeId, replacementBuildId, replacementVersion) => sendRuntimeControlCommand(globalDataPath, command, { expectedRuntimeId, replacementBuildId, replacementVersion })))('drain', current.runtimeId, buildId, releaseVersion);
      } catch (error) {
        if (error instanceof Error && error.message === 'different_runtime') throw error;
        throw new Error('control_unavailable');
      }
      const deadline = Date.now() + (options.drainTimeoutMs ?? 30_000);
      while (Date.now() < deadline) {
        if (!isOwnerAlive(current.pid, current.processBirth || '')) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (isOwnerAlive(current.pid, current.processBirth || '')) {
        const verified = options.verifyRuntimeProcess
          ? options.verifyRuntimeProcess(current.pid, current.runtimeId, globalDataPath)
          : verifiedDrainedRuntimeProcess(current, globalDataPath, drainingEntryPath);
        if (!verified) throw new Error('runtime_drain_timeout');
        await (options.terminateProcess || terminateVerifiedRuntimeProcess)(current.pid);
        if (isOwnerAlive(current.pid, current.processBirth || '')) throw new Error('runtime_termination_failed');
      }
    }
  }
  const result = ensureAutonomousRuntime(options);
  await waitForAutonomousRuntimeHealth(globalDataPath, 30_000, options.sendHealth, entryPath, buildId, undefined, result.runtimeId, result.pid, false, undefined, true);
  return result;
}

export function ensureAutonomousRuntime(options: RuntimeHostOptions): { started: boolean; pid: number; runtimeId: string } {
  const now = options.now || new Date();
  const globalDataPath = normalizeGlobalDataPathForExtension(options.globalDataPath);
  const isProcessAlive = options.isProcessAlive || defaultIsProcessAlive;
  const isOwnerAlive = options.isProcessOwnerAlive || (options.isProcessAlive ? ((pid: number) => options.isProcessAlive!(pid)) : processOwnerAlive);
  const current = readRuntimeState(globalDataPath);
  const databaseRequired = runtimeRootRequiresExistingDatabase(globalDataPath);
  if (runtimeDatabaseAuthorityRegistered(globalDataPath) && !fs.existsSync(path.join(globalDataPath, 'solomap.db'))) throw new Error('database_restore_required');
  if (
    current
    && isOwnerAlive(current.pid, current.processBirth || '')
  ) {
    return { started: false, pid: current.pid, runtimeId: current.runtimeId };
  }

  const runtimeId = options.runtimeId || crypto.randomUUID();
  const entryPath = path.join(options.extensionPath, 'out', 'autonomousRuntimeProcess.js');
  const spawnProcess = options.spawnProcess || childProcess.spawn;
  const args = [
    entryPath,
    '--global-data-path', globalDataPath,
    '--runtime-id', runtimeId,
    ...(options.releaseVersion ? ['--runtime-version', options.releaseVersion] : []),
    ...(databaseRequired ? ['--database-required'] : [])
  ];
  const child = spawnProcess(options.execPath || process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
  const pid = Number(child.pid || 0);
  if (!pid) throw new Error('SoloMap Runtime process did not return a process ID.');
  const lease = claimRuntimeLease(globalDataPath, { runtimeId, pid, now, isProcessOwnerAlive: isOwnerAlive });
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
  const requestPath = path.join(os.tmpdir(), `solomap-pi-delivery-${crypto.randomUUID()}.json`);
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
