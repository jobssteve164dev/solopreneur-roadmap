import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { sendRuntimeControlCommand, RuntimeControlCommand } from './autonomousRuntimeControl';
import { inspectAutonomousRuntimeHealth, waitForAutonomousRuntimeHealth } from './autonomousRuntimeHost';
import { readRuntimeState, RuntimeState } from './autonomousRuntime';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import { cognitiveCliEnvironment } from './localAgentCliEngine';
import { revokeAllProjectAutonomyAuthorizations } from './projectAutonomyAuthorization';
import { sanitizeDiagnosticText } from './localDiagnostics';
import { runtimeBuildId } from './runtimeBuildIdentity';

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
  sendControl?: (command: RuntimeControlCommand, expectedRuntimeId?: string) => Promise<unknown>;
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

function serviceDisabledPath(globalDataPath: string): string {
  return path.join(normalizeGlobalDataPathForExtension(globalDataPath), 'runtime', 'service-disabled');
}

export function isAutonomousRuntimeDisabled(globalDataPath: string): boolean {
  return fs.existsSync(serviceDisabledPath(globalDataPath));
}

export function enableAutonomousRuntime(globalDataPath: string): void {
  const disabledPath = serviceDisabledPath(globalDataPath);
  if (fs.existsSync(disabledPath)) fs.unlinkSync(disabledPath);
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runtimeArguments(extensionPath: string, globalDataPath: string): string[] {
  return [path.join(extensionPath, 'out', 'autonomousRuntimeProcess.js'), '--global-data-path', globalDataPath, '--runtime-owner', 'service'];
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
  const args = runtimeArguments(options.extensionPath, globalDataPath);
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
  const plan = buildRuntimeServicePlan(options);
  const platform = (options.platform || process.platform) as SupportedPlatform;
  const homeDir = options.homeDir || os.homedir();
  const environment = options.environment || cognitiveCliEnvironment();
  if (isAutonomousRuntimeDisabled(options.globalDataPath) && !options.ignoreDisabled) {
    return { installed: false, definitionPath: plan.definitionPath, changed: false };
  }
  if (options.ignoreDisabled) enableAutonomousRuntime(options.globalDataPath);
  const previous = fs.existsSync(plan.definitionPath) ? fs.readFileSync(plan.definitionPath, 'utf8') : null;
  const changed = previous !== plan.definition;
  const runCommand = options.runCommand || runRuntimeServiceCommand;
  const sendControl = options.sendControl || ((command: RuntimeControlCommand, expectedRuntimeId?: string) => sendRuntimeControlCommand(options.globalDataPath, command, { expectedRuntimeId }));
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
      await sendControl('drain', current.runtimeId);
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

export function revokePersistentRuntimeAuthorizations(globalDataPath: string): void {
  revokeAllProjectAutonomyAuthorizations(normalizeGlobalDataPathForExtension(globalDataPath));
}

export async function disableAutonomousRuntimeService(options: RuntimeServiceOptions): Promise<void> {
  try {
    await uninstallAutonomousRuntimeService(options);
  } finally {
    revokePersistentRuntimeAuthorizations(options.globalDataPath);
    const disabledPath = serviceDisabledPath(options.globalDataPath);
    fs.mkdirSync(path.dirname(disabledPath), { recursive: true });
    fs.writeFileSync(disabledPath, 'disabled\n', { encoding: 'utf8', mode: 0o600 });
  }
}

export async function uninstallRegisteredAutonomousRuntimeService(): Promise<void> {
  const platform = process.platform as SupportedPlatform;
  if (!['linux', 'darwin', 'win32'].includes(platform)) return;
  const homeDir = os.homedir();
  const environment = cognitiveCliEnvironment();
  const registryPath = serviceRegistryPath(platform, homeDir, environment);
  if (!fs.existsSync(registryPath)) return;
  const registration = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as RuntimeServiceRegistration;
  try {
    await uninstallAutonomousRuntimeService({ ...registration, environment });
  } finally {
    revokePersistentRuntimeAuthorizations(registration.globalDataPath);
  }
}
