import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContentPage, DataObject } from './db/unifiedDataStore';
import { validateAgentLink, validateAgentWrite } from './dataAuthorization';
import { dataSchema } from './db/dataSchema';

export interface UnifiedMcpSource {
  scope: string | null;
  globalReads?: boolean;
  close?(): Promise<void>;
  call(operation: string, input: Record<string, unknown>): Promise<unknown>;
}
export const unifiedToolNames = ['solomap_search', 'solomap_read', 'solomap_write', 'solomap_link', 'solomap_context', 'solomap_export'];
export const maintenanceToolNames = ['solomap_migration_status', 'solomap_migration_retry', 'solomap_recycling_preview', 'solomap_recycling_apply', 'solomap_maintenance_finish'];

export function registerMaintenanceMcpTools(server: McpServer, source: UnifiedMcpSource): void {
  const z = require('zod') as typeof import('zod');
  const register = (name: string, description: string, inputSchema: Record<string, any>, readOnly: boolean, operation: (input: any) => Promise<unknown>): void => {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: name === 'solomap_recycling_apply' } }, async input => {
      try { return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(input)) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }; }
    });
  };
  register('solomap_migration_status', '读取当前迁移进度、待处理项目和回收状态。', {}, true, () => source.call('migration_overview', {}));
  register('solomap_migration_retry', '重试一个明确失败或中断的迁移任务。', { jobId: z.string().min(1) }, false, input => source.call('retry_migration', input));
  register('solomap_recycling_preview', '生成并读取可回收文件的精确清单；本工具不会回收文件。', {}, false, () => source.call('prepare_recycling', {}));
  register('solomap_recycling_apply', '执行插件界面中已由用户逐项确认并绑定到本任务的回收清单。', { planId: z.string().min(1) }, false, input => source.call('execute_recycling_plan', input));
  register('solomap_maintenance_finish', '结束当前维护任务并保存结果状态。', { error: z.string().optional() }, false, input => source.call('complete_maintenance_task', input));
}

export function registerUnifiedMcpTools(server: McpServer, source: UnifiedMcpSource): void {
  const z = require('zod') as typeof import('zod');
  const scope = z.string().nullable().optional();
  const schema = dataSchema();
  const kinds = Object.keys(schema.kinds) as [string, ...string[]];
  const dataFields: Record<string, any> = {};
  for (const model of Object.values(schema.kinds)) for (const [key, field] of Object.entries(model.fields)) {
    dataFields[key] = (field.type === 'text' ? z.string() : field.type === 'number' ? z.number() : z.unknown()).nullable().optional();
  }
  const authorized = (object: DataObject): boolean => object.projectId === source.scope || object.objectId === source.scope ||
    (source.globalReads === true && object.projectId === null && ['memory', 'lesson', 'policy'].includes(object.kind) && ['verified', 'approved', 'active'].includes(String(object.data.status)));
  const read = async (ref: string, revision?: number): Promise<DataObject> => {
    const object = await source.call('read', { ref, ...(revision === undefined ? {} : { revision }) }) as DataObject;
    if (!authorized(object)) throw new Error('scope_denied');
    return object;
  };
  const readView = async (input: { ref: string; revision?: number; view?: string }): Promise<unknown> => {
    if (input.ref === 'solomap://schema') return schema;
    const result = await source.call('read', input) as DataObject | ContentPage;
    if (!authorized('object' in result ? result.object : result)) throw new Error('scope_denied');
    return result;
  };
  const register = (name: string, description: string, inputSchema: Record<string, any>, readOnly: boolean, operation: (input: any) => Promise<unknown>): void => {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: false } }, async input => {
      try { return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(input)) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }; }
    });
  };
  register('solomap_search', '查找项目记录、记忆和执行证据。', { scope, query: z.string().optional(), kinds: z.array(z.string()).optional(), limit: z.number().int().min(1).max(500).optional(), cursor: z.string().optional() }, true, async input => {
    if ((input.scope ?? source.scope) !== source.scope) throw new Error('scope_denied');
    return source.call('search', { ...input, scope: source.scope });
  });
  register('solomap_read', '读取全文、元数据或固定版本的内容分页；按 cursor 继续读取。ref="solomap://schema" 返回可写字段合同。', { ref: z.string(), revision: z.number().int().positive().optional(), view: z.enum(['full', 'metadata', 'content']).optional(), field: z.string().optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(1048576).optional() }, true, readView);
  register('solomap_write', '创建、修改或归档记录，返回已提交版本和回执。', {
    kind: z.enum(kinds), action: z.enum(['create', 'patch', 'archive']), scope,
    objectId: z.string().optional(), expectedRevision: z.number().int().nonnegative().optional(), idempotencyKey: z.string().min(1), data: z.object(dataFields).passthrough().describe('按 kind 使用 solomap://schema 中的字段；创建需提供 required 字段，补丁只提供本次修改的字段。')
  }, false, async input => {
    if ((input.scope ?? source.scope) !== source.scope) throw new Error('scope_denied');
    validateAgentWrite(input, input.objectId ? await read(input.objectId) : undefined);
    return source.call('write', { ...input, scope: source.scope });
  });
  register('solomap_link', '关联来源、证据、父子关系或依赖。', { source: z.string(), relation: z.string(), target: z.string(), expectedRevision: z.number().int().positive(), idempotencyKey: z.string().min(1) }, false, async input => {
    const object = await read(input.source);
    if (object.projectId !== source.scope) throw new Error('scope_denied');
    validateAgentLink(object, input.relation);
    await read(input.target);
    return source.call('link', input);
  });
  register('solomap_context', '获取与当前目标有关的项目经验和记忆。', { project: z.string().optional(), query: z.string().optional(), categories: z.array(z.string()).optional(), budget: z.number().int().positive().optional() }, true, async input => {
    if (!source.scope || (input.project && input.project !== source.scope)) throw new Error('scope_denied');
    const result = await source.call('context', { ...input, project: source.scope }) as { items: DataObject[] };
    return { ...result, items: result.items.filter(authorized) };
  });
  register('solomap_export', '按需导出记录全文，不覆盖已有产物。', { ref: z.string(), format: z.enum(['json', 'md', 'text']), destination: z.string(), idempotencyKey: z.string().min(1) }, false, async input => {
    await read(input.ref);
    return source.call('export', input);
  });
  const { ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js') as typeof import('@modelcontextprotocol/sdk/server/mcp.js');
  server.registerResource('solomap-schema', 'solomap://schema', { description: '可读写记录种类、字段、必填项与引用。正式状态和审核仍使用现有授权动作。', mimeType: 'application/json' }, uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(schema) }] }));
  server.registerResource('solomap-object', new ResourceTemplate('solomap://objects/{id}', { list: undefined }), {
    description: 'SoloMap 记录及其当前版本。', mimeType: 'application/json'
  }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await read(String(variables.id))) }] }));
}
