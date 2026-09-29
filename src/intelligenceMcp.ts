import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createIntelligenceReadTools, IntelligenceReadToolName, IntelligenceReadToolSource } from './intelligenceReadTools';
import type { SolomapMcpRegistryEntry } from './solomapGlobal';

const toolDescriptions: Array<{ name: IntelligenceReadToolName; description: string }> = [
  { name: 'list_projects', description: '查询 SoloMap 中的项目名称、优先级和简介。' },
  { name: 'get_current_project', description: '查询当前项目和当前路线图步骤。' },
  { name: 'get_plugin_settings', description: '查询语言和智能内核所选 Agent、模型。' }
];

export function getIntelligenceMcpConnector(): SolomapMcpRegistryEntry {
  return {
    id: 'builtin:solomap-intelligence',
    title: 'SoloMap 项目与设置查询',
    description: '供智能内核查询项目、当前进展和语言设置。',
    status: 'installed',
    source: { kind: 'builtin' },
    permissions: {
      tools: toolDescriptions.map(tool => tool.name),
      requiresCredentials: false,
      externalAccess: false,
      writeAccess: false
    },
    risk: { level: 'low', canWriteExternal: false, requiresExplicitEnable: false }
  };
}

export function createIntelligenceMcpServer(source: IntelligenceReadToolSource): McpServer {
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
  return server;
}

export async function createIntelligenceMcpSession(source: IntelligenceReadToolSource): Promise<{
  client: Client;
  close(): Promise<void>;
}> {
  const server = createIntelligenceMcpServer(source);
  const client = new Client({ name: 'solomap-intelligence-kernel', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  } catch (error) {
    await client.close();
    await server.close();
    throw error;
  }
  return {
    client,
    async close(): Promise<void> {
      await client.close();
      await server.close();
    }
  };
}
