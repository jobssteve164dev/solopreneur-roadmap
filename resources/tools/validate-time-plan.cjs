#!/usr/bin/env node
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

