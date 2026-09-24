import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { sendRuntimeControlCommand, RuntimeControlCommand } from './autonomousRuntimeControl';
import { readRuntimeState } from './autonomousRuntime';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import { cognitiveCliEnvironment } from './localAgentCliEngine';
import { revokeAllProjectAutonomyAuthorizations } from './projectAutonomyAuthorization';

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
  runCommand?: (command: string, args: string[]) => void;
  sendControl?: (command: RuntimeControlCommand) => Promise<unknown>;
  waitForDrain?: () => Promise<void>;
  waitForHealth?: () => Promise<void>;
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

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runtimeArguments(extensionPath: string, globalDataPath: string): string[] {
  return [path.join(extensionPath, 'out', 'autonomousRuntimeProcess.js'), '--global-data-path', globalDataPath];
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
    installCommand: ['schtasks.exe', ['/Create', '/TN', 'SoloMap Runtime', '/XML', definitionPath, '/F']],
    restartCommand: ['schtasks.exe', ['/Run', '/TN', 'SoloMap Runtime']],
    uninstallCommand: ['schtasks.exe', ['/Delete', '/TN', 'SoloMap Runtime', '/F']]
  };
}

function defaultRunCommand(command: string, args: string[]): void {
  childProcess.execFileSync(command, args, { stdio: 'ignore', windowsHide: true });
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
  const disabledPath = serviceDisabledPath(options.globalDataPath);
  if (fs.existsSync(disabledPath) && !options.ignoreDisabled) {
    return { installed: false, definitionPath: plan.definitionPath, changed: false };
  }
  if (options.ignoreDisabled && fs.existsSync(disabledPath)) fs.unlinkSync(disabledPath);
  const previous = fs.existsSync(plan.definitionPath) ? fs.readFileSync(plan.definitionPath, 'utf8') : null;
  const changed = previous !== plan.definition;
  const runCommand = options.runCommand || defaultRunCommand;
  const sendControl = options.sendControl || ((command: RuntimeControlCommand) => sendRuntimeControlCommand(options.globalDataPath, command));
  const drainingPid = Number(readRuntimeState(options.globalDataPath)?.pid || 0);
  const waitForDrain = options.waitForDrain || (() => waitUntil(
    () => readRuntimeState(options.globalDataPath)?.status === 'stopped' && !isProcessAlive(drainingPid),
    'SoloMap Runtime did not finish draining before service upgrade.'
  ));
  const waitForHealth = options.waitForHealth || (() => waitUntil(async () => {
    try {
      const response = await sendRuntimeControlCommand(options.globalDataPath, 'health', { timeoutMs: 500 });
      return response.ok;
    } catch {
      return false;
    }
  }, 'SoloMap Runtime service did not become healthy after activation.'));
  writeServiceRegistration(options, platform, homeDir, environment);
  let drained = false;
  if (changed) {
    try {
      await sendControl('drain');
      drained = true;
    } catch {
      // First install and stale endpoints have no live Runtime to drain.
    }
    if (drained) await waitForDrain();
    if (previous !== null && plan.prepareUpgradeCommand) {
      try {
        runCommand(...plan.prepareUpgradeCommand);
      } catch {
        // A stale definition may no longer be loaded.
      }
    }
    writeDefinition(plan.definitionPath, plan.definition);
  }
  try {
    if (!changed && plan.statusCommand) {
      let loaded = false;
      try {
        runCommand(...plan.statusCommand);
        loaded = true;
      } catch {
        // The definition exists but is not currently loaded.
      }
      if (loaded) {
        await waitForHealth();
        return { installed: true, definitionPath: plan.definitionPath, changed };
      }
    }
    if (plan.reloadCommand) runCommand(...plan.reloadCommand);
    runCommand(...plan.installCommand);
    if (changed && plan.restartCommand) runCommand(...plan.restartCommand);
    await waitForHealth();
    return { installed: true, definitionPath: plan.definitionPath, changed };
  } catch (error) {
    if (changed) {
      if (previous === null) {
        try { await sendControl('stop'); } catch { /* The failed service may not have opened IPC. */ }
        try { runCommand(...plan.uninstallCommand); } catch { /* Service activation may have failed before registration. */ }
        if (fs.existsSync(plan.definitionPath)) fs.unlinkSync(plan.definitionPath);
      } else {
        try {
          if (plan.prepareUpgradeCommand) runCommand(...plan.prepareUpgradeCommand);
        } catch {
          // The failed replacement may already be unloaded.
        }
        writeDefinition(plan.definitionPath, previous);
        try {
          if (plan.reloadCommand) runCommand(...plan.reloadCommand);
          runCommand(...plan.installCommand);
          if (plan.restartCommand) runCommand(...plan.restartCommand);
          await waitForHealth();
        } catch {
          // Preserve the original upgrade error while leaving the old definition on disk.
        }
      }
    }
    throw error;
  }
}

export async function uninstallAutonomousRuntimeService(options: RuntimeServiceOptions): Promise<void> {
  const plan = buildRuntimeServicePlan(options);
  const runCommand = options.runCommand || defaultRunCommand;
  const sendControl = options.sendControl || ((command: RuntimeControlCommand) => sendRuntimeControlCommand(options.globalDataPath, command));
  try {
    await sendControl('stop');
  } catch {
    // The service manager may already have stopped the Runtime.
  }
  try {
    runCommand(...plan.uninstallCommand);
  } catch {
    // Missing service managers and already removed definitions are safe during cleanup.
  }
  if (fs.existsSync(plan.definitionPath)) fs.unlinkSync(plan.definitionPath);
  if (plan.reloadCommand) {
    try { runCommand(...plan.reloadCommand); } catch { /* The service manager may be unavailable. */ }
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
