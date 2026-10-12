#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const requiredColumns = ['id', 'title', 'description', 'stage', 'dependencies', 'agentCli', 'agentPrompt', 'status', 'createdAt', 'completedAt'];
const bootstrapMarkers = [
  '你的唯一主任务是直接重写 .solopreneur/roadmap.csv',
  '你的唯一交付物是直接重写 .solopreneur/roadmap.csv',
  '保留 CSV 表头且字段顺序必须严格是',
  '生成初始路线图',
  '.solopreneur/bootstrap-roadmap-instructions.md',
  '不要把本文件内容、提示词模板或解释性说明写回 CSV'
];

function parseArgs(argv) {
  const args = { mode: 'revision' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--mode' && argv[index + 1]) {
      args.mode = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  if (inQuotes) {
    throw new Error('CSV 引号未闭合。');
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const nonEmptyRows = rows.filter((candidate) => candidate.some((value) => String(value || '').trim()));
  if (!nonEmptyRows.length) {
    return { fields: [], data: [] };
  }
  const fields = nonEmptyRows[0].map((field) => String(field || '').trim());
  return {
    fields,
    data: nonEmptyRows.slice(1).map((values) => {
      const entry = {};
      fields.forEach((field, index) => {
        entry[field] = values[index] === undefined ? '' : values[index];
      });
      return entry;
    })
  };
}

function normalizeNodes(data) {
  return data.map((node) => ({
    id: String(node.id || '').trim(),
    title: String(node.title || '').trim(),
    description: String(node.description || '').trim(),
    stage: String(node.stage || '').trim(),
    dependencies: String(node.dependencies || '').trim(),
    agentCli: String(node.agentCli || '').trim(),
    agentPrompt: String(node.agentPrompt || '').trim(),
    status: String(node.status || '').trim()
  })).filter((node) => node.id);
}

function fail(reason) {
  console.error('FAIL roadmap validation: ' + reason);
  process.exit(1);
}

function pass(mode, count) {
  console.log('PASS roadmap validation: ' + mode + ' (' + count + ' steps)');
}

function validateCommon(fields, nodes, label) {
  if (requiredColumns.some((field) => !fields.includes(field))) {
    fail(label + ' roadmap.csv 格式不完整。字段必须包含：' + requiredColumns.join(', '));
  }
  if (!nodes.length) {
    fail(label + '路线图没有可执行环节。');
  }
  const ids = nodes.map((node) => node.id);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) {
    fail(label + '路线图存在重复环节 ID。');
  }
  if (nodes.some((node) => !node.title || !node.stage || !node.description || !node.agentPrompt)) {
    fail(label + '路线图存在缺少标题、阶段、描述或 Agent 任务的环节。');
  }
  for (const node of nodes) {
    const dependencies = node.dependencies.split(',').map((entry) => entry.trim()).filter(Boolean);
    if (dependencies.includes(node.id) || dependencies.some((entry) => !idSet.has(entry))) {
      fail(label + '路线图存在无效依赖关系。');
    }
  }
}

function main() {
  const { mode } = parseArgs(process.argv.slice(2));
  if (!['bootstrap', 'revision'].includes(mode)) {
    fail('未知 mode：' + mode + '。请使用 --mode bootstrap 或 --mode revision。');
  }
  const roadmapPath = path.join(process.cwd(), '.solopreneur', 'roadmap.csv');
  if (!fs.existsSync(roadmapPath)) {
    fail('未找到 .solopreneur/roadmap.csv。');
  }
  let parsed;
  try {
    parsed = parseCsv(fs.readFileSync(roadmapPath, 'utf8'));
  } catch (error) {
    fail('roadmap.csv 无法解析：' + (error && error.message ? error.message : error));
  }
  const nodes = normalizeNodes(parsed.data);
  validateCommon(parsed.fields, nodes, mode === 'bootstrap' ? '生成后的' : '调整后的');
  if (mode === 'bootstrap') {
    if (nodes.length < 2 || nodes.length > 8) {
      fail('生成后的路线图环节数量不在 2 到 8 个之间。');
    }
    if (nodes.some((node) => node.status !== 'Pending')) {
      fail('生成后的路线图所有环节都必须回到 Pending。');
    }
    if (nodes.some((node) => bootstrapMarkers.some((marker) => node.title.includes(marker) || node.agentPrompt.includes(marker)))) {
      fail('生成后的 roadmap.csv 仍然残留了初始化提示词，没有真正写成业务路线图。');
    }
    if (nodes.some((node) => node.title === '生成初始路线图')) {
      fail('生成后的路线图仍然保留了原始 bootstrap 节点。');
    }
  } else {
    const allowedStatuses = new Set(['Pending', 'In Progress', 'Running', 'Completed', 'Failed']);
    if (nodes.some((node) => !allowedStatuses.has(node.status))) {
      fail('调整后的路线图存在无法识别的环节状态。');
    }
  }
  pass(mode, nodes.length);
}

main();

