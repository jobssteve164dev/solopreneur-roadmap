#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const filePath = path.resolve(process.argv[2] || 'scheduled-tasks.json');
if (!fs.existsSync(filePath)) {
  console.error(`FAIL: file not found: ${filePath}`);
  process.exit(1);
}

let ledger;
try {
  ledger = JSON.parse(fs.readFileSync(filePath, 'utf8'));
} catch (error) {
  console.error(`FAIL: invalid JSON: ${error.message}`);
  process.exit(1);
}

const errors = [];
if (ledger.schemaVersion !== 1) errors.push('schemaVersion must be 1');
if (!Array.isArray(ledger.tasks)) errors.push('tasks must be an array');
const ids = new Set();
for (const [index, record] of (Array.isArray(ledger.tasks) ? ledger.tasks : []).entries()) {
  const label = `tasks[${index}]`;
  if (!record || typeof record !== 'object') { errors.push(`${label} must be an object`); continue; }
  if (!record.occurrenceId) errors.push(`${label}.occurrenceId is required`);
  else if (ids.has(record.occurrenceId)) errors.push(`${label}.occurrenceId is duplicated`);
  else ids.add(record.occurrenceId);
  if (!record.taskId) errors.push(`${label}.taskId is required`);
  if (!Number.isFinite(Date.parse(String(record.dueAt || '')))) errors.push(`${label}.dueAt must be ISO-8601`);
  if (!['pending', 'running'].includes(record.status)) errors.push(`${label}.status must be pending or running`);
  if (!record.task || typeof record.task !== 'object') errors.push(`${label}.task is required`);
}

if (errors.length) {
  for (const error of errors) console.error(`FAIL: ${error}`);
  process.exit(1);
}
console.log(`PASS: ${filePath} (${ledger.tasks.length} pending occurrence${ledger.tasks.length === 1 ? '' : 's'})`);
