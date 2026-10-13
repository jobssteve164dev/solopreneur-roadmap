import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { sendRuntimeControlCommand, sendRuntimeDataRequest, RuntimeControlCommand } from './autonomousRuntimeControl';
import { inspectAutonomousRuntimeHealth, waitForAutonomousRuntimeHealth } from './autonomousRuntimeHost';
import { claimRuntimeLease, readRuntimeState, registerRuntimeDatabaseAuthority, runtimeDatabaseAuthorityRegistered, runtimeRootRequiresExistingDatabase, RuntimeState, updateRuntimeState } from './autonomousRuntime';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import { cognitiveCliEnvironment } from './localAgentCliEngine';
import { sanitizeDiagnosticText } from './localDiagnostics';
import { runtimeBuildId, runtimeReleaseVersion } from './runtimeBuildIdentity';
import { UnifiedDataStore } from './db/unifiedDataStore';
import { createRuntimeDataOperations } from './runtimeDataOperations';
import { writeRuntimePauseState } from './runtimePauseState';
import { isProcessOwnerAlive } from './processIdentity';

type SupportedPlatform = 'linux' | 'darwin' | 'win32';
type Command = [string, string[]];

export interface RuntimeServicePlan {
  definitionPath: string;
  definition: string;
  prepareUpgradeCommand?: Command;
  statusCommand?: Command;
  reloadCommand?: Command;
  installCommand: Command;
  restartCommand?: Command;
  uninstallCommand: Command;
}

interface RuntimeServiceOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  extensionPath: string;
  globalDataPath: string;
  execPath?: string;
  environment?: NodeJS.ProcessEnv;
  runCommand?: (command: string, args: string[]) => void | Promise<void>;
  sendControl?: (command: RuntimeControlCommand, expectedRuntimeId?: string, replacementBuildId?: string, replacementVersion?: string) => Promise<unknown>;
  buildId?: string;
  releaseVersion?: string;
  waitForDrain?: (pid: number, runtimeId: string) => Promise<void>;
  waitForHealth?: () => Promise<void>;
  waitForRollbackHealth?: (excludedRuntimeId?: string) => Promise<void>;
  waitForServiceStop?: (pid: number) => Promise<void>;
  waitForTaskStopped?: () => Promise<void>;
  ignoreDisabled?: boolean;
}

interface RuntimeServiceRegistration {
  schemaVersion: 1;
  platform: SupportedPlatform;
  homeDir: string;
  extensionPath: string;
  globalDataPath: string;
  execPath: string;
}

function serviceRegistryPath(platform: NodeJS.Platform, homeDir: string, environment: NodeJS.ProcessEnv): string {
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'Application Support', 'SoloMap', 'runtime-service.json');
  if (platform === 'win32') return path.join(String(environment.APPDATA || path.join(homeDir, 'AppData', 'Roaming')), 'SoloMap', 'runtime-service.json');
  return path.join(homeDir, '.config', 'solomap', 'runtime-service.json');
}

interface RuntimeServiceRegistryLocation {
  platform?: NodeJS.Platform;
  homeDir?: string;
  environment?: NodeJS.ProcessEnv;
}

function readServiceRegistration(options: RuntimeServiceRegistryLocation = {}): RuntimeServiceRegistration | null {
  const platform = options.platform || process.platform;
  if (!['linux', 'darwin', 'win32'].includes(platform)) return null;
  const homeDir = options.homeDir || os.homedir();
  const environment = options.environment || cognitiveCliEnvironment();
  const registryPath = serviceRegistryPath(platform, homeDir, environment);
  if (!fs.existsSync(registryPath)) return null;
  const registration = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as RuntimeServiceRegistration;
  if (registration.schemaVersion !== 1 || !registration.globalDataPath) throw new Error('runtime_service_registration_invalid');
  return registration;
}

export function registeredAutonomousRuntimeDataRoot(options: RuntimeServiceRegistryLocation = {}): string {
  return readServiceRegistration(options)?.globalDataPath || '';
}

function serviceDisabledPath(globalDataPath: string): string {
  return path.join(normalizeGlobalDataPathForExtension(globalDataPath), 'runtime', 'service-disabled');
}

export function isAutonomousRuntimeDisabled(globalDataPath: string): boolean {
  return fs.existsSync(serviceDisabledPath(globalDataPath));
}

export function enableAutonomousRuntime(globalDataPath: string): void {
  void globalDataPath;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runtimeArguments(extensionPath: string, globalDataPath: string, releaseVersion = ''): string[] {
  return [
    path.join(extensionPath, 'out', 'autonomousRuntimeProcess.js'),
    '--global-data-path', globalDataPath,
    '--runtime-owner', 'service',
    ...(releaseVersion ? ['--runtime-version', releaseVersion] : []),
    '--database-required'
  ];
}

export function buildRuntimeServicePlan(options: RuntimeServiceOptions): RuntimeServicePlan {
  const platform = options.platform || process.platform;
  if (!['linux', 'darwin', 'win32'].includes(platform)) {
    throw new Error(`SoloMap Runtime user service is not supported on ${platform}.`);
  }
  const homeDir = options.homeDir || os.homedir();
  const globalDataPath = normalizeGlobalDataPathForExtension(options.globalDataPath);
  const execPath = options.execPath || process.execPath;
  const environment = options.environment || cognitiveCliEnvironment();
  const runtimeEnvironment = Object.entries({ ...environment, ELECTRON_RUN_AS_NODE: '1' })
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1]));
  const releaseVersion = options.releaseVersion || (fs.existsSync(path.join(options.extensionPath, 'package.json')) ? runtimeReleaseVersion(options.extensionPath) : '');
  const args = runtimeArguments(options.extensionPath, globalDataPath, releaseVersion);
  if (platform === 'linux') {
    const quoted = [execPath, ...args].map(value => JSON.stringify(value)).join(' ');
    return {
      definitionPath: path.join(homeDir, '.config', 'systemd', 'user', 'solomap-runtime.service'),
      definition: [
        '[Unit]',
        'Description=SoloMap autonomous runtime',
        'After=default.target',
        '',
        '[Service]',
        'Type=simple',
        ...runtimeEnvironment.map(([key, value]) => `Environment=${JSON.stringify(`${key}=${value}`)}`),
        `ExecStart=${quoted}`,
        'Restart=on-failure',
        'RestartSec=3',
        '',
        '[Install]',
        'WantedBy=default.target',
        ''
      ].join('\n'),
      statusCommand: ['systemctl', ['--user', 'is-active', '--quiet', 'solomap-runtime.service']],
      reloadCommand: ['systemctl', ['--user', 'daemon-reload']],
      installCommand: ['systemctl', ['--user', 'enable', '--now', 'solomap-runtime.service']],
      restartCommand: ['systemctl', ['--user', 'restart', 'solomap-runtime.service']],
      uninstallCommand: ['systemctl', ['--user', 'disable', '--now', 'solomap-runtime.service']]
    };
  }
  if (platform === 'darwin') {
    const label = 'site.szlk.solomap.runtime';
    const argumentXml = [execPath, ...args].map(value => `      <string>${xmlEscape(value)}</string>`).join('\n');
    const definitionPath = path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
    return {
      definitionPath,
      definition: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0"><dict>',
        '  <key>Label</key><string>site.szlk.solomap.runtime</string>',
        '  <key>ProgramArguments</key><array>',
        argumentXml,
        '  </array>',
        `  <key>EnvironmentVariables</key><dict>${runtimeEnvironment.map(([key, value]) => `<key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`).join('')}</dict>`,
        '  <key>RunAtLoad</key><true/>',
        '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
        '</dict></plist>',
        ''
      ].join('\n'),
      prepareUpgradeCommand: ['launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}`, definitionPath]],
      statusCommand: ['launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${label}`]],
      installCommand: ['launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 0}`, definitionPath]],
      restartCommand: ['launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 0}/${label}`]],
      uninstallCommand: ['launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}`, definitionPath]]
    };
  }
  const definitionPath = path.join(path.dirname(serviceRegistryPath(platform, homeDir, environment)), 'solomap-runtime-task.xml');
  const command = [
    ...runtimeEnvironment.map(([key, value]) => `$env:${key}=${powerShellLiteral(value)}`),
    `& ${[execPath, ...args].map(powerShellLiteral).join(' ')}`
  ].join('; ');
  return {
    definitionPath,
    definition: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      '  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>',
      '  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>',
      '  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>',
      `  <Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>-NoProfile -NonInteractive -Command &quot;${xmlEscape(command)}&quot;</Arguments></Exec></Actions>`,
      '</Task>',
      ''
    ].join('\n'),
    prepareUpgradeCommand: ['schtasks.exe', ['/End', '/TN', 'SoloMap Runtime']],
    installCommand: ['schtasks.exe', ['/Create', '/TN', 'SoloMap Runtime', '/XML', definitionPath, '/F']],
    restartCommand: ['schtasks.exe', ['/Run', '/TN', 'SoloMap Runtime']],
    uninstallCommand: ['schtasks.exe', ['/Delete', '/TN', 'SoloMap Runtime', '/F']]
  };
}

export function runRuntimeServiceCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 2048 - stderr.length); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with status ${code ?? 'unknown'}${stderr.trim() ? `: ${sanitizeDiagnosticText(stderr)}` : '.'}`));
    });
  });
}

export async function isRuntimeServiceManagerAvailable(
  platform: NodeJS.Platform = process.platform,
  runCommand: (command: string, args: string[]) => void | Promise<void> = (command, args) => new Promise((resolve, reject) => {
    childProcess.execFile(command, args, { timeout: 3_000, windowsHide: true }, error => error ? reject(error) : resolve());
  }),
  hasUserManagerSocket: () => boolean = () => {
    const runtimeDir = process.env.XDG_RUNTIME_DIR || (process.getuid ? `/run/user/${process.getuid()}` : '');
    return Boolean(runtimeDir && fs.existsSync(path.join(runtimeDir, 'systemd', 'private')));
  }
): Promise<boolean> {
  if (platform !== 'linux') return true;
  if (!hasUserManagerSocket()) return false;
  try {
    await runCommand('systemctl', ['--user', 'show-environment']);
    return true;
  } catch {
    return false;
  }
}

function writeDefinition(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeServiceRegistration(options: RuntimeServiceOptions, platform: SupportedPlatform, homeDir: string, environment: NodeJS.ProcessEnv): void {
  writeDefinition(serviceRegistryPath(platform, homeDir, environment), JSON.stringify({
    schemaVersion: 1,
    platform,
    homeDir,
    extensionPath: options.extensionPath,
    globalDataPath: normalizeGlobalDataPathForExtension(options.globalDataPath),
    execPath: options.execPath || process.execPath
  } satisfies RuntimeServiceRegistration, null, 2) + '\n');
}

async function waitUntil(check: () => Promise<boolean> | boolean, message: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

export async function ensureAutonomousRuntimeService(options: RuntimeServiceOptions): Promise<{ installed: boolean; definitionPath: string; changed: boolean }> {
  const root = normalizeGlobalDataPathForExtension(options.globalDataPath);
  if (runtimeDatabaseAuthorityRegistered(root) && !fs.existsSync(path.join(root, 'solomap.db'))) throw new Error('database_restore_required');
  const plan = buildRuntimeServicePlan(options);
  const platform = (options.platform || process.platform) as SupportedPlatform;
  const homeDir = options.homeDir || os.homedir();
  const environment = options.environment || cognitiveCliEnvironment();
  const previous = fs.existsSync(plan.definitionPath) ? fs.readFileSync(plan.definitionPath, 'utf8') : null;
  const changed = previous !== plan.definition;
  const runCommand = options.runCommand || runRuntimeServiceCommand;
  const replacementBuildId = options.buildId || (fs.existsSync(path.join(options.extensionPath, 'out')) ? runtimeBuildId(options.extensionPath) : crypto.createHash('sha256').update(plan.definition).digest('hex'));
  const replacementVersion = options.releaseVersion || (fs.existsSync(path.join(options.extensionPath, 'package.json')) ? runtimeReleaseVersion(options.extensionPath) : '');
  const sendControl = options.sendControl || ((command: RuntimeControlCommand, expectedRuntimeId?: string, nextBuildId?: string, nextVersion?: string) => sendRuntimeControlCommand(options.globalDataPath, command, { expectedRuntimeId, replacementBuildId: nextBuildId, replacementVersion: nextVersion }));
  const waitForDrain = options.waitForDrain || ((pid: number, runtimeId: string) => waitUntil(
    () => {
      const state = readRuntimeState(options.globalDataPath);
      return !isProcessAlive(pid) && (!state || state.runtimeId !== runtimeId || state.status === 'stopped');
    },
    'SoloMap Runtime did not finish draining before service upgrade.'
  ));
  const waitForHealth = options.waitForHealth || (() => waitForAutonomousRuntimeHealth(
    options.globalDataPath, 30_000, undefined, runtimeArguments(options.extensionPath, options.globalDataPath)[0], runtimeBuildId(options.extensionPath), 'service', undefined, undefined, false, undefined, true));
  const waitForExistingHealth = options.waitForHealth || (() => waitForAutonomousRuntimeHealth(
    options.globalDataPath, 30_000, undefined, runtimeArguments(options.extensionPath, options.globalDataPath)[0], runtimeBuildId(options.extensionPath), 'service'));
  const waitForRollbackHealth = options.waitForRollbackHealth || ((excludedRuntimeId?: string) => waitForAutonomousRuntimeHealth(
    options.globalDataPath, 30_000, undefined, undefined, undefined, 'service', undefined, undefined, true, excludedRuntimeId, true));
  writeServiceRegistration(options, platform, homeDir, environment);
  const drainTarget = async (current: RuntimeState): Promise<void> => {
    const latest = readRuntimeState(options.globalDataPath);
    if (!latest || latest.runtimeId !== current.runtimeId || latest.pid !== current.pid) throw new Error('different_runtime');
    if (latest.status === 'stopped' || !isProcessAlive(latest.pid)) return;
    try {
      await sendControl('drain', current.runtimeId, replacementBuildId, replacementVersion);
    } catch (error) {
      if (error instanceof Error && error.message === 'different_runtime') throw error;
      throw new Error('control_unavailable');
    }
    await waitForDrain(current.pid, current.runtimeId);
  };
  const drainExisting = async (): Promise<boolean> => {
    const current = readRuntimeState(options.globalDataPath);
    if (!current || current.status === 'stopped' || !isProcessAlive(current.pid)) return false;
    await drainTarget(current);
    return true;
  };
  if (changed) {
    await drainExisting();
    if (previous !== null && plan.prepareUpgradeCommand) {
      try {
        await runCommand(...plan.prepareUpgradeCommand);
      } catch {
        // A stale definition may no longer be loaded.
      }
    }
    writeDefinition(plan.definitionPath, plan.definition);
  }
  try {
    if (!changed && !plan.statusCommand) {
      const current = readRuntimeState(options.globalDataPath);
      if (current) {
        const health = await inspectAutonomousRuntimeHealth(options.globalDataPath, current.pid, Date.now(), undefined,
          runtimeArguments(options.extensionPath, options.globalDataPath)[0], runtimeBuildId(options.extensionPath), 'service');
        if (health.healthy) {
          try {
            await runCommand('schtasks.exe', ['/Query', '/TN', 'SoloMap Runtime']);
          } catch {
            await runCommand(...plan.installCommand);
          }
          return { installed: true, definitionPath: plan.definitionPath, changed };
        }
      }
    }
    if (!changed && plan.statusCommand) {
      let loaded = false;
      try {
        await runCommand(...plan.statusCommand);
        loaded = true;
      } catch {
        // The definition exists but is not currently loaded.
      }
      if (loaded) {
        try {
          await waitForExistingHealth();
        } catch (error) {
          if (!plan.restartCommand) throw error;
          await drainExisting();
          await runCommand(...plan.restartCommand);
          await waitForHealth();
        }
        return { installed: true, definitionPath: plan.definitionPath, changed };
      }
    }
    if (!changed) await drainExisting();
    if (plan.reloadCommand) await runCommand(...plan.reloadCommand);
    await runCommand(...plan.installCommand);
    if ((changed || platform === 'win32') && plan.restartCommand) await runCommand(...plan.restartCommand);
    await waitForHealth();
    return { installed: true, definitionPath: plan.definitionPath, changed };
  } catch (error) {
    let rollbackRestored = false;
    if (changed) {
      if (previous === null) {
        let observedPid = 0;
        const current = readRuntimeState(options.globalDataPath);
        if (current && isProcessAlive(current.pid)) {
          observedPid = current.pid;
          const health = await inspectAutonomousRuntimeHealth(options.globalDataPath, current.pid, Date.now(), undefined,
            undefined, undefined, 'service');
          if (health.healthy) {
            try { await drainTarget(current); } catch { /* The task stop below still targets only this service. */ }
          } else {
            const fallback = await inspectAutonomousRuntimeHealth(options.globalDataPath, current.pid, Date.now(), undefined,
              undefined, undefined, 'fallback');
            if (fallback.healthy) observedPid = 0;
          }
        }
        if (platform === 'win32' && plan.prepareUpgradeCommand) {
          try { await runCommand(...plan.prepareUpgradeCommand); } catch { /* The failed task may already have ended. */ }
        }
        let cleanupFailed = false;
        if (platform === 'win32') {
          try {
            await (options.waitForTaskStopped || (() => waitUntil(async () => {
              try {
                await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
                  "$task = Get-ScheduledTask -TaskName 'SoloMap Runtime' -ErrorAction SilentlyContinue; if ($task -and $task.State -eq 'Running') { exit 1 }"]);
                return true;
              } catch {
                return false;
              }
            }, 'SoloMap Runtime task is still running after failed activation.')))();
          } catch {
            cleanupFailed = true;
          }
        }
        if (observedPid && platform === 'win32') {
          try {
            await (options.waitForServiceStop || ((pid: number) => waitUntil(
              () => !isProcessAlive(pid), 'SoloMap Runtime task did not stop after failed activation.'
            )))(observedPid);
          } catch {
            cleanupFailed = true;
          }
        }
        if (cleanupFailed) throw new Error('runtime_service_cleanup_failed');
        try { await runCommand(...plan.uninstallCommand); } catch { /* Service activation may have failed before registration. */ }
        if (fs.existsSync(plan.definitionPath)) fs.unlinkSync(plan.definitionPath);
      } else {
        const failedRuntimeId = readRuntimeState(options.globalDataPath)?.runtimeId;
        let canRestore = true;
        try {
          await drainExisting();
        } catch {
          canRestore = false;
        }
        try {
          if (canRestore && plan.prepareUpgradeCommand) await runCommand(...plan.prepareUpgradeCommand);
        } catch {
          // The failed replacement may already be unloaded.
        }
        writeDefinition(plan.definitionPath, previous);
        try {
          if (!canRestore) throw new Error('runtime_drain_timeout');
          if (plan.reloadCommand) await runCommand(...plan.reloadCommand);
          await runCommand(...plan.installCommand);
          if (plan.restartCommand) await runCommand(...plan.restartCommand);
          await waitForRollbackHealth(failedRuntimeId);
          rollbackRestored = true;
        } catch {
          // Preserve the original upgrade error while leaving the old definition on disk.
        }
      }
    }
    if (changed && previous !== null) {
      const failure = new Error(rollbackRestored ? 'runtime_service_rollback' : 'runtime_service_upgrade_failed');
      (failure as Error & { cause?: unknown }).cause = error;
      throw failure;
    }
    throw error;
  }
}

export async function uninstallAutonomousRuntimeService(options: RuntimeServiceOptions): Promise<void> {
  const plan = buildRuntimeServicePlan(options);
  const runCommand = options.runCommand || runRuntimeServiceCommand;
  const sendControl = options.sendControl || ((command: RuntimeControlCommand) => sendRuntimeControlCommand(options.globalDataPath, command));
  try {
    await sendControl('stop');
  } catch {
    // The service manager may already have stopped the Runtime.
  }
  try {
    await runCommand(...plan.uninstallCommand);
  } catch {
    // Missing service managers and already removed definitions are safe during cleanup.
  }
  if (fs.existsSync(plan.definitionPath)) fs.unlinkSync(plan.definitionPath);
  if (plan.reloadCommand) {
    try { await runCommand(...plan.reloadCommand); } catch { /* The service manager may be unavailable. */ }
  }
  const registryPath = serviceRegistryPath(options.platform || process.platform, options.homeDir || os.homedir(), options.environment || cognitiveCliEnvironment());
  if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
}

export async function revokePersistentRuntimeAuthorizations(globalDataPath: string): Promise<void> {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  if (runtimeDatabaseAuthorityRegistered(root) && !fs.existsSync(path.join(root, 'solomap.db'))) throw new Error('database_restore_required');
  let endpointError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await sendRuntimeDataRequest(root, { operation: 'revoke_project_autonomy_authorizations', input: { idempotencyKey: `project-autonomy-revoke:${Date.now()}` } });
      return;
    } catch (error) {
      endpointError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const owner = readRuntimeState(root);
  if (owner && isProcessOwnerAlive(owner.pid, owner.processBirth || '')) {
    const failure = new Error('runtime_owner_unavailable');
    (failure as Error & { cause?: unknown }).cause = endpointError;
    throw failure;
  }
  await withOfflineRuntimeDataOwner(root, operations => operations({ operation: 'revoke_project_autonomy_authorizations', input: { idempotencyKey: `project-autonomy-revoke:${Date.now()}` } }));
}

async function waitForRuntimeOwnerStopped(globalDataPath: string, timeoutMs = 10_000): Promise<void> {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const owner = readRuntimeState(root);
    if (!owner || !isProcessOwnerAlive(owner.pid, owner.processBirth || '')) return;
    if (Date.now() >= deadline) throw new Error('runtime_owner_still_running');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function withOfflineRuntimeDataOwner<T>(globalDataPath: string, action: (operations: ReturnType<typeof createRuntimeDataOperations>) => Promise<T>): Promise<T> {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  const runtimeWasInitialized = runtimeRootRequiresExistingDatabase(root);
  const runtimeId = `offline-maintenance:${crypto.randomUUID()}`;
  const lease = claimRuntimeLease(root, { runtimeId, pid: process.pid });
  if (!lease.acquired) throw new Error('runtime_owner_unavailable');
  let store: UnifiedDataStore | undefined;
  let operations: ReturnType<typeof createRuntimeDataOperations> | undefined;
  try {
    store = runtimeWasInitialized || fs.existsSync(path.join(root, 'solomap.db')) ? UnifiedDataStore.open(root) : new UnifiedDataStore(root);
    operations = createRuntimeDataOperations(store);
    return await action(operations);
  } finally {
    if (operations) await operations.close();
    store?.close();
    updateRuntimeState(root, runtimeId, { status: 'stopped' });
  }
}

async function persistDisabledStateOffline(globalDataPath: string, revoke = true): Promise<void> {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  if (runtimeDatabaseAuthorityRegistered(root) && !fs.existsSync(path.join(root, 'solomap.db'))) throw new Error('database_restore_required');
  await waitForRuntimeOwnerStopped(root);
  await withOfflineRuntimeDataOwner(root, async operations => {
    await writeRuntimePauseState(operations, true);
    if (revoke) await operations({ operation: 'revoke_project_autonomy_authorizations', input: { idempotencyKey: `project-autonomy-revoke:${Date.now()}` } });
  });
}

export async function disableAutonomousRuntimeService(options: RuntimeServiceOptions): Promise<void> {
  let persistedPause = false;
  let revoked = false;
  try {
    try {
      await sendRuntimeControlCommand(options.globalDataPath, 'pause');
      persistedPause = true;
    } catch { /* A stopped Runtime is persisted after uninstall. */ }
    try {
      await revokePersistentRuntimeAuthorizations(options.globalDataPath);
      revoked = true;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'runtime_owner_unavailable') throw error;
    }
    await uninstallAutonomousRuntimeService(options);
  } finally {
    if (!persistedPause || !revoked) await persistDisabledStateOffline(options.globalDataPath, !revoked);
  }
}

export async function uninstallRegisteredAutonomousRuntimeService(options: RuntimeServiceRegistryLocation = {}): Promise<void> {
  const registration = readServiceRegistration(options);
  if (!registration) return;
  const environment = options.environment || cognitiveCliEnvironment();
  registerRuntimeDatabaseAuthority(registration.globalDataPath);
  let revoked = false;
  try {
    try {
      await revokePersistentRuntimeAuthorizations(registration.globalDataPath);
      revoked = true;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'runtime_owner_unavailable') throw error;
    }
    await uninstallAutonomousRuntimeService({ ...registration, environment });
  } finally {
    if (!revoked) await persistDisabledStateOffline(registration.globalDataPath, true);
  }
}
