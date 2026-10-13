import * as path from 'path';
import * as fs from 'fs';
import { runtimeMcpSource } from './runtimeDataOperations';
import { registerMigrationMcpTools, registerUnifiedMcpTools } from './unifiedMcp';
import { migrationRunKinds, soloConversationRunKinds } from './runLifecycleTypes';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : String(process.argv[index + 1] || '');
}

async function main(): Promise<void> {
  const globalDataPath = argument('--global-data-path');
  let projectId = argument('--project-id') || (process.env.SOLOMAP_RUN_PROOF ? String(process.env.SOLOMAP_PROJECT_ID || '') : '');
  if (!globalDataPath) throw new Error('SoloMap MCP requires a Runtime endpoint.');
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
  const source = runtimeMcpSource(path.resolve(globalDataPath), projectId, true, process.env.SOLOMAP_RUN_PROOF ? {
      executionLogId: Number(process.env.SOLOMAP_EXECUTION_LOG_ID), generation: Number(process.env.SOLOMAP_RUN_GENERATION), proof: process.env.SOLOMAP_RUN_PROOF,
    } : undefined);
  // The bridge owns no SQLite connection and starts no second persistence daemon.
  let sessionInfo: { runKind: string; migrationKind: string | null } | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { sessionInfo = await source.sessionInfo?.(); break; }
    catch (error) {
      if (attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 50));
    }
  }
  const runKind = String(sessionInfo?.runKind || '');
  const migrationRun = migrationRunKinds.includes(runKind as typeof migrationRunKinds[number]);
  const soloConversationRun = soloConversationRunKinds.includes(runKind as typeof soloConversationRunKinds[number]);
  const server = new McpServer({ name: 'solomap-data', version: '1.0.0' });
  if (migrationRun) registerMigrationMcpTools(server, source);
  else {
    registerUnifiedMcpTools(server, source);
    if (soloConversationRun) registerMigrationMcpTools(server, source, false);
  }
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
