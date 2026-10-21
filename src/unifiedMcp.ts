import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContentPage, DataObject } from './db/unifiedDataStore';
import { validateAgentLink, validateAgentWrite } from './dataAuthorization';
import { dataSchema, type DataField } from './db/dataSchema';
import { projectSignalKinds } from './projectSignalsRead';

export interface UnifiedMcpSource {
  scope: string | null;
  globalReads?: boolean;
  projectSignalsOnly?: boolean;
  close?(): Promise<void>;
  sessionInfo?(): Promise<{ runKind: string; migrationKind: string | null }>;
  setPiToolFence?(fence?: { operationId: string; invocationId: string; ownerId: string; ownerGeneration: number }): void;
  call(operation: string, input: Record<string, unknown>): Promise<unknown>;
}
export const unifiedToolNames = ['solomap_search', 'solomap_read', 'solomap_write', 'solomap_link', 'solomap_context', 'solomap_memory', 'solomap_experience', 'solomap_export', 'solomap_conversation_status', 'solomap_start_conversation', 'solomap_get_conversation', 'solomap_project_signals'];
export const migrationToolNames = ['solomap_migration_start', 'solomap_migration_status', 'solomap_migration_retry', 'solomap_recycling_preview', 'solomap_recycling_apply'];

function registerMigrationTools(server: McpServer, source: UnifiedMcpSource, includeRecyclingApply: boolean): void {
  const z = require('zod') as typeof import('zod');
  const projectRoot = z.string().min(1).optional();
  const register = (name: string, description: string, inputSchema: Record<string, any>, readOnly: boolean, operation: (input: any) => Promise<unknown>): void => {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: name === 'solomap_recycling_apply' } }, async input => {
      try { return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(input)) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }; }
    });
  };
  register('solomap_migration_start', '发现指定已登记项目中的旧数据并幂等加入后台迁移队列。', { projectRoot }, false, input => source.call('discover_migrations', input));
  register('solomap_migration_status', '读取指定项目的迁移进度和回收状态；提供 jobId 可读取该任务的完整来源和处理记录，verifySourceKey 完整校验该来源正文而不返回其内容。', { jobId: z.string().min(1).optional(), verifySourceKey: z.string().min(1).optional(), projectRoot }, true, input => input.jobId
    ? source.call('migration_status', input) : source.call('migration_overview', { ...input, summaryOnly: true }));
  register('solomap_migration_retry', '重试指定项目中一个明确失败或中断的迁移任务。', { jobId: z.string().min(1), projectRoot }, false, input => source.call('retry_migration', input));
  register('solomap_recycling_preview', '生成指定项目可回收文件的精确清单；本工具不会回收文件。', { projectRoot }, false, input => source.call('prepare_recycling', input));
  if (includeRecyclingApply) register('solomap_recycling_apply', '执行插件界面中已由用户逐项确认并绑定到本任务的回收清单。', { planId: z.string().min(1), projectRoot }, false, input => source.call('execute_recycling_plan', input));
}

export function registerMigrationMcpTools(server: McpServer, source: UnifiedMcpSource, includeRecyclingApply = true): void { registerMigrationTools(server, source, includeRecyclingApply); }

export function registerUnifiedMcpTools(server: McpServer, source: UnifiedMcpSource, options: { readOnly?: boolean; conversationLifecycle?: boolean; conversationLaunch?: boolean; projectSignals?: boolean } = {}): void {
  const z = require('zod') as typeof import('zod');
  const scope = z.string().nullable().optional();
  const schema = dataSchema();
  const kinds = Object.keys(schema.kinds) as [string, ...string[]];
  const dataFields: Record<string, any> = {};
  const referenceField = (field: DataField): any => {
    let value: any = field.type === 'number' ? z.number() : z.string();
    if (field.integer) value = value.int();
    if (field.minimum !== undefined) value = value.min(field.minimum);
    if (field.nullable) value = value.nullable();
    if (!field.required) value = value.optional();
    return field.description ? value.describe(field.description) : value;
  };
  for (const model of Object.values(schema.kinds)) for (const [key, field] of Object.entries(model.fields)) {
    dataFields[key] = field.items
      ? z.array(z.object(Object.fromEntries(Object.entries(field.items).map(([name, item]) => [name, referenceField(item)]))).strict()).describe(field.description || '').optional()
      : (field.type === 'text' ? z.string() : field.type === 'number' ? z.number() : z.unknown()).nullable().optional();
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
  const assertBoundProject = async (project?: string): Promise<void> => {
    if (!source.scope) throw new Error('scope_denied');
    if (project === undefined || project === source.scope) return;
    const bound = await read(source.scope);
    if (bound.kind !== 'project' || project !== bound.data.name) throw new Error('scope_denied');
  };
  const scopedContext = async (input: Record<string, unknown>, contextKinds: Array<'memory' | 'lesson' | 'policy'>): Promise<{ items: DataObject[]; [key: string]: unknown }> => {
    await assertBoundProject(typeof input.project === 'string' ? input.project : undefined);
    const result = await source.call('context', { ...input, project: source.scope, kinds: contextKinds }) as { items: DataObject[]; [key: string]: unknown };
    return { ...result, items: result.items.filter(authorized) };
  };
  const allScopedContextItems = async (input: Record<string, unknown>, contextKinds: Array<'memory' | 'lesson' | 'policy'>): Promise<DataObject[]> => {
    const { cursor: _cursor, ...baseInput } = input;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const items: DataObject[] = [];
      let cursor: string | undefined;
      let changed = false;
      do {
        const page = await scopedContext({ ...baseInput, ...(cursor ? { cursor } : {}) }, contextKinds);
        if (page.sourceChanged === true) { changed = true; break; }
        items.push(...page.items);
        cursor = typeof page.cursor === 'string' && page.cursor ? page.cursor : undefined;
      } while (cursor);
      if (!changed) return items;
    }
    throw new Error('source_changed');
  };
  const searchAll = async (searchKinds: string[], search?: { query?: string; terms?: string[] }): Promise<DataObject[]> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const items: DataObject[] = [];
      let cursor: string | undefined;
      let changed = false;
      do {
        const page = await source.call('search', { scope: source.scope, kinds: searchKinds, limit: 500, ...(search?.query ? { query: search.query } : {}), ...(search?.terms ? { terms: search.terms } : {}), ...(cursor ? { cursor } : {}) }) as { items: DataObject[]; cursor?: string | null; sourceChanged?: boolean };
        if (page.sourceChanged) { changed = true; break; }
        items.push(...page.items.filter(authorized));
        cursor = page.cursor || undefined;
      } while (cursor);
      if (!changed) return items;
    }
    throw new Error('source_changed');
  };
  const parsedContent = (object: DataObject): unknown => {
    const value = object.data.content;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value.replace(/^\uFEFF/, '')); }
    catch { return value; }
  };
  const journalField = (output: string, title: string): string => {
    const lines = output.split(/\r?\n/);
    const prefix = `${title}:`;
    const index = lines.findIndex(line => line.startsWith(prefix));
    if (index < 0) return '';
    const inline = lines[index].slice(prefix.length).trim();
    if (inline) return inline;
    const body: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (/^[A-Z][^\n:]{2,80}:/.test(line)) break;
      body.push(line);
    }
    return body.join('\n').trim();
  };
  const journalList = (output: string, title: string): string[] => journalField(output, title).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  type ExperienceInput = { query?: string; terms?: string[]; node?: string; agent?: string; status?: string };
  const experienceTerms = (input: ExperienceInput): string[] => {
    if (input.query && input.terms) throw new Error('search_query_conflict');
    return [...new Set((input.terms || String(input.query || '').split(/\s+/)).map(term => term.trim().toLowerCase()).filter(Boolean))];
  };
  const experienceHeaders = async (input: ExperienceInput): Promise<DataObject[]> => {
    const metadata = await searchAll(['evidence']);
    const candidates = metadata.filter(item => item.data.type === 'run_digest_source' || item.data.type === 'project_journal');
    const digestLogIds = new Set(candidates.filter(item => item.data.type === 'run_digest_source').map(item => Number(item.projection?.executionLogId || 0)));
    let selected = candidates.filter(item => item.data.type !== 'project_journal' || !digestLogIds.has(Number(item.projection?.executionLogId || 0)))
      .filter(item => !input.node || String(item.projection?.nodeId || '') === input.node)
      .filter(item => !input.agent || String(item.projection?.agentCli || '') === input.agent)
      .filter(item => !input.status || String(item.projection?.status || '') === input.status)
      .sort((left, right) => String(right.projection?.finishedAt || '').localeCompare(String(left.projection?.finishedAt || '')));
    const terms = experienceTerms(input);
    if (terms.length) {
      let matching: Set<string> | undefined;
      for (const term of terms) {
        const hits = new Set((await searchAll(['evidence'], { query: term }))
          .filter(item => item.data.type === 'run_digest' || item.data.type === 'project_journal')
          .map(item => `${item.objectId}@${item.revision}`));
        matching = matching === undefined ? hits : new Set([...matching].filter(ref => hits.has(ref)));
        if (!matching.size) break;
      }
      selected = selected.filter(item => {
        const sourceRef = item.data.type === 'run_digest_source'
          ? item.projection?.sourceRef as { objectId?: unknown; revision?: unknown } | undefined
          : { objectId: item.objectId, revision: item.revision };
        return matching?.has(`${String(sourceRef?.objectId || '')}@${Number(sourceRef?.revision || 0)}`);
      });
    }
    return selected;
  };
  const experienceRecords = async (input: ExperienceInput, maxRecords: number, failuresOnly = false): Promise<{ records: Array<Record<string, any>>; totalRecords: number; byStatus: Record<string, number>; byAgent: Record<string, number> }> => {
    let selected = await experienceHeaders(input);
    if (failuresOnly) selected = selected.filter(item => String(item.projection?.status || '') === 'Failed' || Number(item.projection?.failureCount || 0) > 0);
    const byStatus: Record<string, number> = {}, byAgent: Record<string, number> = {};
    selected.forEach(item => { const status = String(item.projection?.status || 'unknown'), agent = String(item.projection?.agentCli || 'unknown'); byStatus[status] = (byStatus[status] || 0) + 1; byAgent[agent] = (byAgent[agent] || 0) + 1; });
    const records: Array<Record<string, any>> = [];
    for (const item of selected.slice(0, maxRecords)) {
      const projection = item.projection || {};
      const sourceRef = (item.data.type === 'run_digest_source' ? projection.sourceRef : { objectId: item.objectId, revision: item.revision }) as { objectId?: unknown; revision?: unknown };
      if (!sourceRef?.objectId) continue;
      const sourceObject = await read(String(sourceRef.objectId), Number(sourceRef.revision || 1));
      const body = parsedContent(sourceObject);
      if (!body || typeof body !== 'object' || Array.isArray(body)) continue;
      const value = body as Record<string, any>;
      const journalOutput = String(value.output || '');
      const failureCategory = journalField(journalOutput, 'Failure category');
      const failureReason = journalField(journalOutput, 'Failure reason');
      records.push(item.data.type === 'run_digest_source' ? {
        ...value,
        source: 'digest',
        sourceRef: { objectId: sourceObject.objectId, revision: sourceObject.revision }
      } : {
        source: 'database',
        sourceRef: { objectId: sourceObject.objectId, revision: sourceObject.revision },
        executionLogId: Number(projection.executionLogId || value.id || 0),
        nodeId: String(projection.nodeId || value.nodeId || ''),
        agentCli: String(projection.agentCli || value.agentCli || ''),
        status: String(projection.status || value.status || ''),
        finishedAt: String(projection.finishedAt || value.timestamp || ''),
        userIntent: String(value.userSupplement || journalField(journalOutput, 'User supplement')),
        outcome: String(value.completionDecision || journalField(journalOutput, 'Completion decision') || failureReason),
        changedFiles: journalList(journalOutput, 'Workspace changes'), touchedFiles: journalList(journalOutput, 'Touched project files'),
        failures: [value.failureCategory || failureCategory, value.failureReason || failureReason].filter(Boolean), handoff: null
      });
    }
    return { records, totalRecords: selected.length, byStatus, byAgent };
  };
  const approvedLessons = async (input: ExperienceInput, limit: number): Promise<DataObject[]> => {
    const terms = experienceTerms(input);
    const lessons = (await searchAll(['lesson']))
      .filter(item => item.data.status === 'approved')
      .filter(item => !terms.length || terms.every(term => JSON.stringify(item.data).toLowerCase().includes(term)))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return lessons.slice(0, limit);
  };
  const compactLine = (value: unknown, limit: number): string => {
    const line = String(value || '').replace(/\s+/g, ' ').trim();
    return line.length <= limit ? line : `${line.slice(0, Math.max(0, limit - 1))}…`;
  };
  const memoryRoute = async (input: { kind?: string; title?: string }): Promise<Record<string, unknown>> => {
    const aliases: Record<string, string> = { profile: 'profile', rules: 'rules', rule: 'rules', project: 'project', decision: 'decision', decisions: 'decision', pattern: 'pattern', patterns: 'pattern', domain: 'domain', domains: 'domain', inbox: 'inbox', active: 'active', handoff: 'active' };
    const kind = aliases[String(input.kind || '').trim().toLowerCase()];
    if (!kind) throw new Error('unknown_memory_kind');
    const title = compactLine(input.title, 120);
    if (['pattern', 'domain'].includes(kind) && !title) throw new Error('memory_title_required');
    const contracts: Record<string, { operation: string; appliesWhen: string; requiredStructure: string[] }> = {
      profile: { operation: '更新等价偏好；只有不存在等价项时才新增。', appliesWhen: '跨项目稳定成立的用户偏好、协作方式或禁忌。', requiredStructure: ['偏好', '证据或重复用户信号', '跨项目适用条件'] },
      rules: { operation: '优先合并等价规则；新增规则必须简洁且有已验证证据。', appliesWhen: '跨任务或跨项目可复用的执行规则。', requiredStructure: ['规则', '适用条件', '证据'] },
      project: { operation: '更新同一稳定事实；当前证据推翻旧事实时标记已取代。', appliesWhen: '只属于当前项目的稳定事实、入口或边界。', requiredStructure: ['稳定项目事实', '当前证据', '影响边界或入口'] },
      decision: { operation: '更新或追加同一决策，禁止创建语义重复项。', appliesWhen: '已有理由和未来影响的确认选择。', requiredStructure: ['决策', '理由', '证据', '影响'] },
      pattern: { operation: '创建或更新一个可复用模式，合并等价模式。', appliesWhen: '已有验证、可跨项目复用的实现或交付方法。', requiredStructure: ['模式', '证据', '适用条件', '这样做', '避免这样做'] },
      domain: { operation: '更新对应领域记录，分开事实与假设并标注时效。', appliesWhen: '跨项目成立的业务、平台、协议或技术领域知识。', requiredStructure: ['领域事实', '证据或来源', '适用条件', '时效或有效性'] },
      inbox: { operation: '新增明确标记为未验证的观察，等待后续整理。', appliesWhen: '可能有用但尚不足以进入稳定记忆的信息。', requiredStructure: ['观察', '来源任务', '未验证部分', '可能上提位置'] },
      active: { operation: '替换过时会话状态，不积累执行流水账。', appliesWhen: '当前会话交接、暂停状态或未完成工作。', requiredStructure: ['当前目标', '已验证事实', '未完成工作或阻塞', '下一动作'] }
    };
    const visible = await allScopedContextItems({ categories: [kind], view: 'metadata', limit: 500 }, ['memory']);
    const existing = visible.filter(item => item.data.category === kind && (!title || String(item.data.title || '').toLowerCase().includes(title.toLowerCase())))
      .map(item => ({ objectId: item.objectId, revision: item.revision, title: item.data.title, scope: item.projectId, status: item.data.status }));
    return { action: 'route', kind, title, target: { kind: 'memory', scope: source.scope, data: { category: kind, status: 'captured', ...(title ? { title } : {}) } }, existing, ...contracts[kind], guardrails: [
      '写入前读取固定版本，使用 expectedRevision 和唯一 idempotencyKey，并保留无关用户内容。',
      '项目范围内的新事实使用 solomap_write 创建为 captured；批准和跨项目提升继续走现有审核链。',
      '证据、未验证观察和已批准规则必须分开。',
      '不要把命令输出、diff、提交号、完成套话或执行流水账写入稳定记忆。',
      '等价条目应更新或取代，不得重复追加。',
      '记忆不能覆盖更新的用户指令或当前运行证据。'
    ] };
  };
  const register = (name: string, description: string, inputSchema: Record<string, any>, readOnly: boolean, operation: (input: any) => Promise<unknown>): void => {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: false } }, async input => {
      try { return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(input)) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }; }
    });
  };
  if (!options.readOnly && options.conversationLaunch) register('solomap_get_conversation', '查询本聊天发起的任务对话状态和结果。提供启动返回的 conversationRef 作为 ref；省略 ref 列出本聊天最近发起的任务，用于回答“刚才那个任务怎么样了”。等待输入表示本轮已结束，Flow 以整个流程的状态为准。', {
    ref: z.string().uuid().optional(), limit: z.number().int().min(1).max(20).optional()
  }, true, input => source.call('get_conversation', input));
  if (!options.readOnly && options.conversationLaunch) register('solomap_start_conversation', '在已登记项目中发起新的 Step、Solo 或 Flow 对话。Step 需要 stepId；Solo 和 Flow 不需要。', {
    project: z.string().min(1).max(4096).describe('已登记项目的名称、ID 或绝对路径。'),
    mode: z.enum(['step', 'solo', 'flow']),
    message: z.string().min(1).max(32768),
    stepId: z.string().min(1).max(1024).optional(),
    agentCli: z.string().min(1).max(4096).optional(),
    model: z.string().min(1).max(1024).optional(),
    idempotencyKey: z.string().min(1).max(256)
  }, false, input => source.call('start_conversation', input));
  if (options.projectSignals) register('solomap_project_signals', '读取各已登记项目卡片已入库的原始数据，不请求外部服务。省略参数读取项目目录（status=projects，content拼接后含projects与kinds），cursor非空时只传cursor继续；提供project（项目ID、路径或唯一名称）和kind读取Issues、PR、Actions/Release或安全告警。content是JSON文本：始终拼接全部页content后解析，不把片段当完整JSON。数据分页用相同project、kind和返回的cursor继续，固定版本；项目列表变化时报project_list_changed，从头列出。syncedAt表示同步时间，not_synced表示尚无缓存，不能解释为没有问题。处理问题时把项目及证据交给solomap_start_conversation，再用solomap_get_conversation查询结果。', {
    project: z.string().trim().min(1).max(4096).optional(), kind: z.enum(projectSignalKinds).optional(), cursor: z.string().min(1).max(2048).optional()
  }, true, input => source.call('project_signals', input));
  if (source.projectSignalsOnly) return;
  register('solomap_search', '查找项目记录、记忆和执行证据。', { scope, query: z.string().optional(), terms: z.array(z.string().min(1)).nonempty().optional(), kinds: z.array(z.string()).optional(), limit: z.number().int().min(1).max(500).optional(), cursor: z.string().optional() }, true, async input => {
    if ((input.scope ?? source.scope) !== source.scope) throw new Error('scope_denied');
    return source.call('search', { ...input, scope: source.scope });
  });
  register('solomap_read', '读取全文、元数据或固定版本的内容分页；按 cursor 继续读取。ref="solomap://schema" 返回可写字段合同。', { ref: z.string(), revision: z.number().int().positive().optional(), view: z.enum(['full', 'metadata', 'content']).optional(), field: z.string().optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(1048576).optional() }, true, readView);
  if (!options.readOnly) register('solomap_write', '创建、修改或归档记录，返回已提交版本和回执。', {
    kind: z.enum(kinds), action: z.enum(['create', 'patch', 'archive']), scope,
    objectId: z.string().optional(), expectedRevision: z.number().int().nonnegative().optional(), idempotencyKey: z.string().min(1), data: z.object(dataFields).passthrough().describe('按 kind 使用 solomap://schema 中的字段；创建需提供 required 字段，补丁只提供本次修改的字段。')
  }, false, async input => {
    if ((input.scope ?? source.scope) !== source.scope) throw new Error('scope_denied');
    validateAgentWrite(input, input.objectId ? await read(input.objectId) : undefined);
    return source.call('write', { ...input, scope: source.scope });
  });
  if (!options.readOnly) register('solomap_link', '关联来源、证据、父子关系或依赖。', { source: z.string(), relation: z.string(), target: z.string(), expectedRevision: z.number().int().positive(), idempotencyKey: z.string().min(1) }, false, async input => {
    const object = await read(input.source);
    if (object.projectId !== source.scope) throw new Error('scope_denied');
    validateAgentLink(object, input.relation);
    await read(input.target);
    return source.call('link', input);
  });
  register('solomap_context', '获取与当前目标有关的项目经验和记忆；metadata 返回固定版本引用，按 cursor 继续读取。', { project: z.string().optional().describe('当前项目名称或内部项目 ID；省略时使用当前项目。'), query: z.string().optional(), terms: z.array(z.string().min(1)).nonempty().optional(), categories: z.array(z.string()).optional(), kinds: z.array(z.enum(['memory', 'lesson', 'policy'])).nonempty().optional(), budget: z.number().int().positive().optional(), view: z.enum(['full', 'metadata']).optional(), limit: z.number().int().min(1).max(500).optional(), cursor: z.string().optional() }, true, async input => {
    await assertBoundProject(input.project);
    const result = await source.call('context', { ...input, project: source.scope }) as { items: DataObject[] };
    return { ...result, items: result.items.filter(authorized) };
  });
  register('solomap_memory', '从统一数据库检索正式记忆，或返回符合统一写入合同的记忆路由；不依赖全局 tools 文件夹。', {
    action: z.enum(['retrieve', 'route']).optional(), project: z.string().optional().describe('当前项目名称或内部项目 ID；省略时使用当前项目。'),
    query: z.string().optional(), terms: z.array(z.string().min(1)).nonempty().optional(), categories: z.array(z.string()).optional(),
    budget: z.number().int().positive().optional(), view: z.enum(['full', 'metadata']).optional(), limit: z.number().int().min(1).max(500).optional(), cursor: z.string().optional(),
    kind: z.enum(['profile', 'rules', 'rule', 'project', 'decision', 'decisions', 'pattern', 'patterns', 'domain', 'domains', 'inbox', 'active', 'handoff']).optional(), title: z.string().optional()
  }, true, async input => {
    await assertBoundProject(input.project);
    if (input.action === 'route') return memoryRoute(input);
    const { action: _action, kind: _kind, title: _title, ...contextInput } = input;
    return scopedContext(contextInput, ['memory']);
  });
  register('solomap_experience', '从统一数据库检索经验、执行历史、失败信号或跨 Agent 交接，不依赖脚本文件。', {
    action: z.enum(['retrieve', 'handoff', 'pack', 'summary', 'history', 'failures', 'latest-changes', 'search', 'rsi']).optional(),
    project: z.string().optional().describe('当前项目名称或内部项目 ID；省略时使用当前项目。'),
    query: z.string().optional(), terms: z.array(z.string().min(1)).nonempty().optional(), node: z.string().optional(), agent: z.string().optional(), status: z.string().optional(),
    budget: z.number().int().positive().optional(), limit: z.number().int().min(1).max(50).optional()
  }, true, async input => {
    await assertBoundProject(input.project);
    const action = input.action || 'retrieve';
    const limit = input.limit || 8;
    experienceTerms(input);
    if (action === 'rsi') {
      const metadata = await searchAll(['policy_use', 'evaluation']);
      const evaluations = new Map(metadata.filter(item => item.kind === 'evaluation').map(item => [String(item.data.policy_use_id), item]));
      const cycles = metadata.filter(item => item.kind === 'policy_use').sort((left, right) => right.createdAt - left.createdAt).flatMap(use => {
        const evaluation = evaluations.get(use.objectId);
        if (!evaluation) return [];
        let baseline: Record<string, unknown> = {};
        try { baseline = JSON.parse(String(evaluation.data.baseline_ref || '{}')); } catch { /* Historical malformed metadata stays visible without inventing fields. */ }
        return [{
          policyUseRef: { objectId: use.objectId, revision: use.revision },
          policyRef: { objectId: String(use.data.policy_id), revision: Number(use.data.policy_revision) },
          lessonRef: use.data.lesson_id ? { objectId: String(use.data.lesson_id), revision: Number(use.data.lesson_revision) } : null,
          runId: String(use.data.run_id), action: String(use.data.purpose), result: String(baseline.result || ''),
          evidence: Array.isArray(baseline.evidence) ? baseline.evidence : [], verdict: String(evaluation.data.verdict),
          reportedVerdict: String(baseline.reportedVerdict || 'unassessed'), currentPolicyStatus: String(use.projection?.currentPolicyStatus || ''),
          currentLessonStatus: use.projection?.currentLessonStatus == null ? null : String(use.projection.currentLessonStatus),
          evaluationRef: { objectId: evaluation.objectId, revision: evaluation.revision }
        }];
      }).slice(0, limit);
      return { action, cycles };
    }
    const experience = await experienceRecords(input, action === 'summary' ? 5 : action === 'retrieve' ? Math.min(limit, 3) : limit, action === 'failures');
    const records = experience.records;
    if (action === 'retrieve') {
      return { action, lessons: await approvedLessons(input, limit), evidenceLeads: records.slice(0, Math.min(limit, 3)) };
    }
    if (action === 'summary') {
      return { action, totalRecords: experience.totalRecords, byStatus: experience.byStatus, byAgent: experience.byAgent, latest: records.slice(0, 5).map(record => ({
        executionLogId: record.executionLogId || 0, nodeId: record.nodeId || '', agentCli: record.agentCli || '', status: record.status || '',
        finishedAt: record.finishedAt || '', outcome: compactLine(record.outcome || record.userIntent, 220), sourceRef: record.sourceRef
      })) };
    }
    if (action === 'latest-changes') {
      const files = [...new Set(records.flatMap(record => [...(record.changedFiles || []), ...(record.touchedFiles || [])]).map(String))].slice(0, limit);
      return { action, files };
    }
    const selected = records;
    if (action === 'handoff' || action === 'pack') return { action, records: selected.slice(0, limit).map(record => {
      const handoff = record.handoff || {};
      return { runId: record.runId || '', sourceRef: record.sourceRef, executionLogId: record.executionLogId || 0, nodeId: record.nodeId || '', agentCli: record.agentCli || '', status: record.status || '', finishedAt: record.finishedAt || '', brief: handoff.nextAgentBrief || record.outcome || record.userIntent || '', recommendedFirstActions: handoff.recommendedFirstActions || [], filesToInspectFirst: handoff.filesToInspectFirst || [...(record.changedFiles || []), ...(record.touchedFiles || [])], commandsToRunNext: handoff.commandsToRunNext || [], blockedBy: handoff.blockedBy || record.failures || [], openQuestions: handoff.openQuestions || [], doNotRepeat: handoff.doNotRepeat || [], confidence: handoff.confidence || 'medium', riskLevel: handoff.riskLevel || ((record.failures || []).length ? 'high' : 'medium') };
    }) };
    return { action, records: selected.slice(0, limit) };
  });
  if (!options.readOnly) register('solomap_export', '按需导出记录全文，不覆盖已有产物。', { ref: z.string(), format: z.enum(['json', 'md', 'text']), destination: z.string(), idempotencyKey: z.string().min(1) }, false, async input => {
    await read(input.ref);
    return source.call('export', input);
  });
  if (options.conversationLifecycle) register('solomap_conversation_status', '写入当前 Agent 对话的正式检查点状态。开始处理时使用 start；交付本轮结果时使用 complete。运行身份、版本和幂等性由插件绑定，不要自行读写账本。', {
    action: z.enum(['start', 'complete']),
    message: z.string().min(1).optional(),
    outcome: z.enum(['partial', 'candidate_complete', 'blocked_user', 'blocked_external', 'failed']).optional(),
    summary: z.string().min(1).optional(),
    next: z.string().optional(),
    report: z.unknown().optional()
  }, false, input => source.call('checkpoint_current_run', input));
  const { ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js') as typeof import('@modelcontextprotocol/sdk/server/mcp.js');
  server.registerResource('solomap-schema', 'solomap://schema', { description: '可读写记录种类、字段、必填项与引用。正式状态和审核仍使用现有授权动作。', mimeType: 'application/json' }, uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(schema) }] }));
  server.registerResource('solomap-object', new ResourceTemplate('solomap://objects/{id}', { list: undefined }), {
    description: 'SoloMap 记录及其当前版本。', mimeType: 'application/json'
  }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await read(String(variables.id))) }] }));
}
