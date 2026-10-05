import * as path from 'path';
import { runtimeMcpSource } from './runtimeDataOperations';
import { registerUnifiedMcpTools } from './unifiedMcp';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : String(process.argv[index + 1] || '');
}

async function main(): Promise<void> {
  const globalDataPath = argument('--global-data-path');
  const projectId = argument('--project-id');
  if (!globalDataPath || !projectId) throw new Error('SoloMap MCP requires --global-data-path and --project-id.');
  const core = require('zod/v4/core') as typeof import('zod/v4/core');
  core.config({ jitless: true });
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js') as typeof import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js') as typeof import('@modelcontextprotocol/sdk/server/stdio.js');
  const source = runtimeMcpSource(path.resolve(globalDataPath), projectId, true);
  // The bridge owns no SQLite connection and starts no second persistence daemon.
  const project = await source.call('read', { ref: projectId }) as { kind: string };
  if (project.kind !== 'project') throw new Error('Unknown SoloMap project identity.');
  const server = new McpServer({ name: 'solomap-data', version: '1.0.0' });
  registerUnifiedMcpTools(server, source);
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
