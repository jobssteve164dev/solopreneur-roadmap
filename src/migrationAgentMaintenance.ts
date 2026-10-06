import * as fs from 'fs';
import * as path from 'path';
import { shellQuote } from './agentCli';

export type MigrationMaintenanceKind = 'migration_review' | 'recycling_apply';
const maintenanceTools = ['solomap_migration_status', 'solomap_migration_retry', 'solomap_recycling_preview', 'solomap_recycling_apply', 'solomap_maintenance_finish'];

export function applyNativeMigrationAgentBoundary(command: string, agentCli: string, provider: string, mcpConfig: string): string {
  const executable = shellQuote(agentCli);
  if (provider !== 'claude') throw new Error('maintenance_agent_native_boundary_unsupported');
  const configuration = JSON.parse(mcpConfig) as { mcpServers?: Record<string, unknown> };
  if (!configuration.mcpServers || Object.keys(configuration.mcpServers).length !== 1 || !configuration.mcpServers.solomap_data) throw new Error('maintenance_agent_mcp_boundary_invalid');
  const restrictions = ` --restricted --safe-mode --strict-mcp-config --mcp-config ${shellQuote(mcpConfig)} --tools '' --allowedTools ${shellQuote(maintenanceTools.map(name => `mcp__solomap_data__${name}`).join(','))} --permission-mode dontAsk --permission-prompts none --disable-slash-commands --no-session-persistence`;
  if (!command.startsWith(executable)) throw new Error('maintenance_agent_command_invalid');
  return executable + restrictions + command.slice(executable.length);
}

function parentDirectories(file: string): string[] {
  const result: string[] = [];
  for (let current = path.dirname(path.resolve(file)); current !== path.parse(current).root; current = path.dirname(current)) result.unshift(current);
  return result;
}

export function buildMigrationAgentSandboxCommand(input: {
  command: string;
  workspacePath: string;
  extensionPath: string;
  configPaths: string[];
  environment: Record<string, string | undefined>;
  executable?: string;
}): string {
  const args = [
    '--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup',
    '--clearenv'
  ];
  const directories = new Set<string>();
  const mounts = [
    { source: input.workspacePath, readOnly: false },
    { source: input.extensionPath, readOnly: true },
    ...input.configPaths.filter(candidate => fs.existsSync(candidate)).map(source => ({ source, readOnly: true }))
  ];
  mounts.push(...['/etc/resolv.conf', '/etc/nsswitch.conf', '/etc/hosts', '/etc/host.conf', '/etc/gai.conf', '/etc/ssl/certs', '/etc/ssl/openssl.cnf']
    .filter(candidate => fs.existsSync(candidate)).map(source => ({ source, readOnly: true })));
  for (const mount of mounts) for (const directory of parentDirectories(mount.source)) directories.add(directory);
  for (const directory of directories) args.push('--dir', directory);
  for (const systemPath of ['/usr', '/bin', '/lib', '/lib64']) if (fs.existsSync(systemPath)) args.push('--ro-bind', systemPath, systemPath);
  for (const mount of mounts) args.push(mount.readOnly ? '--ro-bind' : '--bind', mount.source, mount.source);
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--chdir', input.workspacePath);
  for (const [name, value] of Object.entries(input.environment)) if (value !== undefined && value !== '') args.push('--setenv', name, value);
  args.push('--', '/bin/bash', '-lc', input.command);
  return [input.executable || '/usr/bin/bwrap', ...args].map(shellQuote).join(' ');
}

export function buildMigrationMaintenancePrompt(kind: MigrationMaintenanceKind, planId = ''): string {
  const common = [
    '你正在执行 SoloMap 数据维护任务。只使用 MCP 服务器 solomap_data 提供的维护工具；不要调用 shell、文件系统或其他工具，不要直接读取或修改任何数据库或旧文件。',
    '先调用 solomap_migration_status，所有迁移与回收写入都由 SoloMap Runtime 串行执行。',
  ];
  const steps = kind === 'migration_review' ? [
    '对 failed、interrupted 或 completed_with_conflicts 的任务，逐个调用 solomap_migration_retry。',
    '调用 solomap_recycling_preview 生成精确回收清单；不要调用 solomap_recycling_apply，回收必须回到插件界面由用户确认。',
    '再次调用 solomap_migration_status，然后调用 solomap_maintenance_finish。'
  ] : [
    `本任务只允许执行插件已确认的回收清单 ${planId}。调用 solomap_recycling_apply，planId 必须逐字等于该值。`,
    '完成后再次调用 solomap_migration_status，然后调用 solomap_maintenance_finish。'
  ];
  return [...common, ...steps,
    '维护结果和续接状态以数据库任务为准，不创建结果文件。',
    '工具失败时不要绕过权限或自行处理文件；调用 solomap_maintenance_finish 写入 error。'
  ].join('\n');
}
