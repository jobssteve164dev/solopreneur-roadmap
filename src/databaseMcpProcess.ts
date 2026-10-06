import * as path from 'path';
import * as fs from 'fs';
import { runtimeMcpSource } from './runtimeDataOperations';
import { registerUnifiedMcpTools } from './unifiedMcp';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : String(process.argv[index + 1] || '');
}

async function main(): Promise<void> {
  const globalDataPath = argument('--global-data-path');
  let projectId = argument('--project-id');
  if (!globalDataPath) throw new Error('SoloMap MCP requires --global-data-path.');
  if (!projectId) {
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
