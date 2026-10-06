import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createIntelligenceReadTools, IntelligenceReadToolName, IntelligenceReadToolSource } from './intelligenceReadTools';
import type { SolomapMcpRegistryEntry } from './solomapGlobal';
import { registerUnifiedMcpTools, UnifiedMcpSource, unifiedToolNames } from './unifiedMcp';

const toolDescriptions: Array<{ name: IntelligenceReadToolName; description: string }> = [
  { name: 'list_projects', description: '查询 SoloMap 中的项目名称、优先级和简介。' },
  { name: 'get_current_project', description: '查询当前项目和当前路线图步骤。' },
  { name: 'get_plugin_settings', description: '查询语言和智能内核所选 Agent、模型。' },
  { name: 'get_today_review', description: '查询今天的安排与待办。' }
];

export function getIntelligenceMcpConnector(database = false): SolomapMcpRegistryEntry {
  return {
    id: 'builtin:solomap-intelligence',
    title: 'SoloMap 项目与设置查询',
    description: '供智能内核查询项目、当前进展和语言设置。',
    status: 'installed',
    source: { kind: 'builtin' },
    permissions: {
      tools: [...toolDescriptions.map(tool => tool.name), ...(database ? unifiedToolNames : [])],
      requiresCredentials: false,
      externalAccess: false,
      writeAccess: database
    },
    risk: { level: 'low', canWriteExternal: false, requiresExplicitEnable: false }
  };
}

export function createIntelligenceMcpServer(source: IntelligenceReadToolSource, dataSource?: UnifiedMcpSource): McpServer {
  // VS Code's extension host guards the Node navigator global; Zod's JIT probe reads it.
  const zodCore = require('zod/v4/core') as typeof import('zod/v4/core');
  zodCore.config({ jitless: true });
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js') as typeof import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'solomap-intelligence', version: '1.0.0' });
  const readTools = createIntelligenceReadTools(source);
  for (const tool of toolDescriptions) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false }
    }, async () => ({
      content: [{ type: 'text', text: JSON.stringify(await readTools.call(tool.name)) }]
    }));
  }
  if (dataSource) registerUnifiedMcpTools(server, dataSource);
  return server;
}

export async function createIntelligenceMcpSession(source: IntelligenceReadToolSource, dataSource?: UnifiedMcpSource): Promise<{
  client: Client;
  close(): Promise<void>;
}> {
  const server = createIntelligenceMcpServer(source, dataSource);
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js') as typeof import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js') as typeof import('@modelcontextprotocol/sdk/inMemory.js');
  const client = new Client({ name: 'solomap-intelligence-kernel', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  } catch (error) {
    await client.close();
    await server.close();
    await dataSource?.close?.();
    throw error;
  }
  return {
    client,
    async close(): Promise<void> {
      await client.close();
      await server.close();
      await dataSource?.close?.();
    }
  };
}
