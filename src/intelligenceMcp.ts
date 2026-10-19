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

export interface IntelligenceTimeScheduleInput {
  title: string;
  scheduleKind: 'daily' | 'once';
  scheduledAt?: string;
  timeOfDay?: string;
  assignee: 'user' | 'agent';
  prompt?: string;
}

export interface IntelligenceActionSource {
  setTimeSchedule(input: IntelligenceTimeScheduleInput): Promise<unknown>;
}

export const intelligenceActionToolNames = ['set_time_schedule'];

export function validateIntelligenceTimeScheduleInput(input: IntelligenceTimeScheduleInput): IntelligenceTimeScheduleInput {
  const normalized: IntelligenceTimeScheduleInput = {
    title: String(input.title || '').trim(),
    scheduleKind: input.scheduleKind,
    assignee: input.assignee,
    ...(input.scheduledAt ? { scheduledAt: String(input.scheduledAt).trim() } : {}),
    ...(input.timeOfDay ? { timeOfDay: String(input.timeOfDay).trim() } : {}),
    ...(input.prompt ? { prompt: String(input.prompt).trim() } : {})
  };
  if (!normalized.title || normalized.title.length > 200) throw new Error('invalid_time_schedule');
  if (!['daily', 'once'].includes(normalized.scheduleKind) || !['user', 'agent'].includes(normalized.assignee)) throw new Error('invalid_time_schedule');
  if (normalized.scheduleKind === 'once') {
    if (!normalized.scheduledAt || !/(?:Z|[+-]\d{2}:\d{2})$/.test(normalized.scheduledAt)
      || !Number.isFinite(Date.parse(normalized.scheduledAt)) || Date.parse(normalized.scheduledAt) <= Date.now()) {
      throw new Error('一次性安排需要填写 ISO-8601 未来时间，且必须包含时区。');
    }
  } else if (!normalized.timeOfDay || !/^([01]\d|2[0-3]):[0-5]\d$/.test(normalized.timeOfDay)) {
    throw new Error('每日安排需要填写 HH:mm 格式的时间。');
  }
  if (normalized.assignee === 'agent' && !normalized.prompt) throw new Error('由 Agent 执行的安排需要填写明确的执行提示。');
  if ((normalized.prompt?.length || 0) > 4000) throw new Error('invalid_time_schedule');
  return normalized;
}

export function getIntelligenceMcpConnector(database = false): SolomapMcpRegistryEntry {
  return {
    id: 'builtin:solomap-intelligence',
    title: 'SoloMap 项目查询与时间安排',
    description: '供智能内核查询项目状态并创建时间安排。',
    status: 'installed',
    source: { kind: 'builtin' },
    permissions: {
      tools: [...toolDescriptions.map(tool => tool.name), ...intelligenceActionToolNames, ...(database ? unifiedToolNames : [])],
      requiresCredentials: false,
      externalAccess: false,
      writeAccess: true
    },
    risk: { level: 'low', canWriteExternal: false, requiresExplicitEnable: false }
  };
}

export function createIntelligenceMcpServer(source: IntelligenceReadToolSource, dataSource?: UnifiedMcpSource, actions?: IntelligenceActionSource): McpServer {
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
  if (actions) {
    const z = require('zod') as typeof import('zod');
    server.registerTool('set_time_schedule', {
      description: '为当前项目创建一个时间安排。一次性安排使用带时区的 scheduledAt；每日安排使用 HH:mm 格式的 timeOfDay。assignee=agent 时必须提供明确的执行提示 prompt。',
      inputSchema: {
        title: z.string().trim().min(1).max(200),
        scheduleKind: z.enum(['daily', 'once']),
        scheduledAt: z.string().trim().max(64).optional(),
        timeOfDay: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
        assignee: z.enum(['user', 'agent']),
        prompt: z.string().trim().max(4000).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false }
    }, async raw => {
      try {
        const input = validateIntelligenceTimeScheduleInput(raw as IntelligenceTimeScheduleInput);
        return { content: [{ type: 'text' as const, text: JSON.stringify(await actions.setTimeSchedule(input)) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] };
      }
    });
  }
  if (dataSource) registerUnifiedMcpTools(server, dataSource);
  return server;
}

export async function createIntelligenceMcpSession(source: IntelligenceReadToolSource, dataSource?: UnifiedMcpSource, actions?: IntelligenceActionSource): Promise<{
  client: Client;
  setPiToolFence(fence?: { operationId: string; invocationId: string; ownerId: string; ownerGeneration: number }): void;
  close(): Promise<void>;
}> {
  const server = createIntelligenceMcpServer(source, dataSource, actions);
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
    setPiToolFence(fence) { dataSource?.setPiToolFence?.(fence); },
    async close(): Promise<void> {
      await client.close();
      await server.close();
      await dataSource?.close?.();
    }
  };
}
