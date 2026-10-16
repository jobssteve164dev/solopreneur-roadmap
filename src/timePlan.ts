import * as crypto from 'crypto';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';

export type TimePlanAssignee = 'user' | 'agent';

export interface TimePlanItem {
  id: string;
  title: string;
  startAt: string;
  durationMinutes: number;
  assignee: TimePlanAssignee;
  prompt: string;
}

export interface TimePlanDraft {
  version: 1;
  status: 'draft' | 'confirmed';
  generatedAt: string;
  confirmedAt?: string;
  request: string;
  items: TimePlanItem[];
}

export interface TimePlanResult {
  valid: boolean;
  plan: TimePlanDraft | null;
  reason: string;
}

type TimePlanOperation = (operation: string, input: Record<string, unknown>) => Promise<unknown>;
interface TimePlanState { revision: number; value: unknown }

export function validateTimePlanValue(value: unknown): TimePlanResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, plan: null, reason: '时间安排必须是 JSON 对象。' };
  }
  const source = value as Record<string, unknown>;
  if (source.version !== 1 || !['draft', 'confirmed'].includes(String(source.status || ''))) {
    return { valid: false, plan: null, reason: 'version 必须为 1，status 必须为 draft 或 confirmed。' };
  }
  const generatedAt = String(source.generatedAt || '');
  if (!generatedAt || !Number.isFinite(Date.parse(generatedAt))) {
    return { valid: false, plan: null, reason: 'generatedAt 必须是有效的 ISO 时间。' };
  }
  if (!Array.isArray(source.items) || source.items.length === 0 || source.items.length > 12) {
    return { valid: false, plan: null, reason: 'items 必须包含 1 到 12 项安排。' };
  }
  const seen = new Set<string>();
  const items: TimePlanItem[] = [];
  for (const raw of source.items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { valid: false, plan: null, reason: '每项安排必须是 JSON 对象。' };
    }
    const item = raw as Record<string, unknown>;
    const id = String(item.id || '').trim();
    const title = String(item.title || '').trim();
    const startAt = String(item.startAt || '').trim();
    const durationMinutes = Number(item.durationMinutes);
    const assignee = String(item.assignee || '') as TimePlanAssignee;
    const prompt = String(item.prompt || '').trim();
    if (!id || seen.has(id) || !title) {
      return { valid: false, plan: null, reason: '每项安排必须有不重复的 id 和非空 title。' };
    }
    if (!Number.isFinite(Date.parse(startAt))) {
      return { valid: false, plan: null, reason: `${title} 的 startAt 不是有效的 ISO 时间。` };
    }
    if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) {
      return { valid: false, plan: null, reason: `${title} 的 durationMinutes 必须是 5 到 480 的整数。` };
    }
    if (assignee !== 'user' && assignee !== 'agent') {
      return { valid: false, plan: null, reason: `${title} 的 assignee 必须是 user 或 agent。` };
    }
    if (assignee === 'agent' && !prompt) {
      return { valid: false, plan: null, reason: `${title} 交给 Agent 执行时必须提供 prompt。` };
    }
    seen.add(id);
    items.push({ id, title, startAt, durationMinutes, assignee, prompt });
  }
  items.sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
  for (let index = 1; index < items.length; index += 1) {
    const previousEnd = Date.parse(items[index - 1].startAt) + items[index - 1].durationMinutes * 60_000;
    if (Date.parse(items[index].startAt) < previousEnd) {
      return { valid: false, plan: null, reason: `${items[index].title} 与上一项时间重叠。` };
    }
  }
  return {
    valid: true,
    reason: '',
    plan: {
      version: 1,
      status: source.status as 'draft' | 'confirmed',
      generatedAt,
      confirmedAt: String(source.confirmedAt || '').trim() || undefined,
      request: String(source.request || '').trim(),
      items
    }
  };
}

function timePlanOperation(projectPath: string, globalDataPath: string, operation?: TimePlanOperation): TimePlanOperation {
  if (operation) return operation;
  const root = normalizeGlobalDataPathForExtension(globalDataPath, projectPath);
  return (name, input) => sendRuntimeDataRequest(root, { operation: name, input });
}

export async function readTimePlan(projectPath: string, globalDataPath = '', operation?: TimePlanOperation): Promise<TimePlanResult> {
  try {
    const state = await timePlanOperation(projectPath, globalDataPath, operation)('read_analysis_state', {
      root: projectPath,
      namespace: 'time-plan',
      key: 'current'
    }) as TimePlanState;
    return state.value === null
      ? { valid: false, plan: null, reason: '还没有 Agent 生成的时间安排。' }
      : validateTimePlanValue(state.value);
  } catch (error: any) {
    return { valid: false, plan: null, reason: `时间安排暂时无法读取：${error?.message || error}` };
  }
}

export async function saveTimePlan(projectPath: string, globalDataPath: string, value: unknown, operation?: TimePlanOperation): Promise<TimePlanResult> {
  const result = validateTimePlanValue(value);
  if (!result.valid || !result.plan) return result;
  const call = timePlanOperation(projectPath, globalDataPath, operation);
  const writeId = crypto.randomUUID();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await call('read_analysis_state', { root: projectPath, namespace: 'time-plan', key: 'current' }) as TimePlanState;
    try {
      await call('write_analysis_state', {
        root: projectPath,
        namespace: 'time-plan',
        key: 'current',
        expectedRevision: current.revision,
        value: result.plan,
        idempotencyKey: `time-plan:${writeId}:${attempt}`
      });
      return result;
    } catch (error) {
      if (!/revision_conflict/.test(String(error)) || attempt === 3) throw error;
    }
  }
  return result;
}

export async function confirmTimePlan(projectPath: string, globalDataPath = '', operation?: TimePlanOperation): Promise<TimePlanResult> {
  const result = await readTimePlan(projectPath, globalDataPath, operation);
  if (!result.valid || !result.plan) return result;
  const confirmed: TimePlanDraft = {
    ...result.plan,
    status: 'confirmed',
    confirmedAt: new Date().toISOString()
  };
  return saveTimePlan(projectPath, globalDataPath, confirmed, operation);
}

export function extractTimePlanDraft(output: string): TimePlanResult {
  const matches = [...String(output || '').matchAll(/<solomap-time-plan>([\s\S]*?)<\/solomap-time-plan>/g)];
  const body = String(matches.at(-1)?.[1] || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!body) return { valid: false, plan: null, reason: 'Agent 没有返回可保存的时间安排。' };
  try { return validateTimePlanValue(JSON.parse(body)); }
  catch (error: any) { return { valid: false, plan: null, reason: `时间安排 JSON 无法解析：${error?.message || error}` }; }
}
