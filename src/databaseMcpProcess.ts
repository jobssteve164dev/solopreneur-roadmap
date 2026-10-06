import * as path from 'path';
import * as fs from 'fs';
import { runtimeMaintenanceEndpointMcpSource, runtimeMaintenanceMcpSource, runtimeMcpSource } from './runtimeDataOperations';
import { registerMaintenanceMcpTools, registerUnifiedMcpTools } from './unifiedMcp';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : String(process.argv[index + 1] || '');
}

async function main(): Promise<void> {
  const globalDataPath = argument('--global-data-path');
  const maintenanceTaskId = String(process.env.SOLOMAP_MAINTENANCE_TASK_ID || '');
  const maintenanceProof = String(process.env.SOLOMAP_MAINTENANCE_PROOF || '');
  const maintenanceLaunchToken = String(process.env.SOLOMAP_MAINTENANCE_LAUNCH_TOKEN || '');
  const maintenanceRuntimeId = String(process.env.SOLOMAP_MAINTENANCE_RUNTIME_ID || '');
  const maintenanceRuntimePort = Number(process.env.SOLOMAP_MAINTENANCE_RUNTIME_PORT || 0);
  let projectId = argument('--project-id');
  if (!globalDataPath && !(maintenanceTaskId && maintenanceRuntimeId && Number.isInteger(maintenanceRuntimePort))) throw new Error('SoloMap MCP requires a Runtime endpoint.');
  if (!maintenanceTaskId && !projectId) {
    let root = path.resolve(argument('--project-root') || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    let body: string | undefined;
    for (;;) {
      try { body = await fs.promises.readFile(path.join(root, '.solopreneur', 'project.json'), 'utf8'); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = path.dirname(root);
      if (parent === root || fs.existsSync(path.join(root, '.git'))) throw new Error('project_identity_not_found');
      root = parent;
    }
    const identity = JSON.parse(body) as { schemaVersion: number; projectId: string };
    if (identity.schemaVersion !== 1 || typeof identity.projectId !== 'string') throw new Error('project_identity_invalid');
    projectId = identity.projectId;
  }
  const core = require('zod/v4/core') as typeof import('zod/v4/core');
  core.config({ jitless: true });
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js') as typeof import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js') as typeof import('@modelcontextprotocol/sdk/server/stdio.js');
  const source = maintenanceTaskId
    ? maintenanceRuntimeId && Number.isInteger(maintenanceRuntimePort) && maintenanceRuntimePort > 0
      ? runtimeMaintenanceEndpointMcpSource({ runtimeId: maintenanceRuntimeId, host: '127.0.0.1', port: maintenanceRuntimePort }, maintenanceTaskId, maintenanceProof, maintenanceLaunchToken)
      : runtimeMaintenanceMcpSource(path.resolve(globalDataPath), maintenanceTaskId, maintenanceProof, maintenanceLaunchToken)
    : runtimeMcpSource(path.resolve(globalDataPath), projectId, true);
  // The bridge owns no SQLite connection and starts no second persistence daemon.
  if (!maintenanceTaskId) {
    const project = await source.call('read', { ref: projectId }) as { kind: string };
    if (project.kind !== 'project') throw new Error('Unknown SoloMap project identity.');
  }
  const server = new McpServer({ name: 'solomap-data', version: '1.0.0' });
  if (maintenanceTaskId) registerMaintenanceMcpTools(server, source);
  else registerUnifiedMcpTools(server, source);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ||= (async () => { await server.close(); await source.close?.(); })();
  process.stdin.once('end', () => { void close().catch(error => process.stderr.write(String(error) + '\n')); });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close().catch(error => process.stderr.write(String(error) + '\n')); });
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
