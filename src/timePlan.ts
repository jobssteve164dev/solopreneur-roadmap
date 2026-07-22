import * as fs from 'fs';
import * as path from 'path';

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

export function getTimePlanPath(projectPath: string): string {
  return path.join(projectPath, '.solopreneur', 'time-plan.json');
}

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

export function readTimePlan(projectPath: string): TimePlanResult {
  const filePath = getTimePlanPath(projectPath);
  if (!fs.existsSync(filePath)) {
    return { valid: false, plan: null, reason: '还没有 Agent 生成的时间安排。' };
  }
  try {
    return validateTimePlanValue(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error: any) {
    return { valid: false, plan: null, reason: `time-plan.json 无法解析：${error?.message || error}` };
  }
}

export function confirmTimePlan(projectPath: string): TimePlanResult {
  const result = readTimePlan(projectPath);
  if (!result.valid || !result.plan) return result;
  const confirmed: TimePlanDraft = {
    ...result.plan,
    status: 'confirmed',
    confirmedAt: new Date().toISOString()
  };
  const filePath = getTimePlanPath(projectPath);
  const temporaryPath = `${filePath}.confirming`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(confirmed, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
  return validateTimePlanValue(confirmed);
}

export function buildTimePlanValidationScript(): string {
  return `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
function fail(reason) { console.error('FAIL time plan validation: ' + reason); process.exit(1); }
const filePath = path.join(process.cwd(), '.solopreneur', 'time-plan.json');
if (!fs.existsSync(filePath)) fail('未找到 .solopreneur/time-plan.json。');
let plan;
try { plan = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (error) { fail('JSON 无法解析：' + error.message); }
if (!plan || Array.isArray(plan) || typeof plan !== 'object') fail('根节点必须是 JSON 对象。');
if (plan.version !== 1 || plan.status !== 'draft') fail('Agent 生成时 version 必须为 1，status 必须为 draft。');
if (!plan.generatedAt || !Number.isFinite(Date.parse(plan.generatedAt))) fail('generatedAt 必须是有效的 ISO 时间。');
if (!Array.isArray(plan.items) || plan.items.length < 1 || plan.items.length > 12) fail('items 必须包含 1 到 12 项安排。');
const ids = new Set();
const items = plan.items.map((item, index) => {
  if (!item || Array.isArray(item) || typeof item !== 'object') fail('第 ' + (index + 1) + ' 项必须是 JSON 对象。');
  const id = String(item.id || '').trim();
  const title = String(item.title || '').trim();
  const startAt = String(item.startAt || '').trim();
  const durationMinutes = Number(item.durationMinutes);
  const assignee = String(item.assignee || '');
  if (!id || ids.has(id) || !title) fail('每项必须有不重复的 id 和非空 title。');
  if (!Number.isFinite(Date.parse(startAt))) fail(title + ' 的 startAt 不是有效的 ISO 时间。');
  if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) fail(title + ' 的 durationMinutes 必须是 5 到 480 的整数。');
  if (!['user', 'agent'].includes(assignee)) fail(title + ' 的 assignee 必须是 user 或 agent。');
  if (assignee === 'agent' && !String(item.prompt || '').trim()) fail(title + ' 交给 Agent 执行时必须提供 prompt。');
  ids.add(id);
  return { title, startAt, durationMinutes };
}).sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
for (let index = 1; index < items.length; index += 1) {
  const previousEnd = Date.parse(items[index - 1].startAt) + items[index - 1].durationMinutes * 60000;
  if (Date.parse(items[index].startAt) < previousEnd) fail(items[index].title + ' 与上一项时间重叠。');
}
console.log('PASS time plan validation (' + items.length + ' items)');
`;
}

export function ensureTimePlanValidationScript(projectPath: string): string {
  const solopreneurDir = path.join(projectPath, '.solopreneur');
  const scriptPath = path.join(solopreneurDir, 'validate-time-plan.cjs');
  fs.mkdirSync(solopreneurDir, { recursive: true });
  fs.writeFileSync(scriptPath, buildTimePlanValidationScript(), { encoding: 'utf8', mode: 0o755 });
  try { fs.chmodSync(scriptPath, 0o755); } catch { /* Best effort on non-POSIX platforms. */ }
  return scriptPath;
}
