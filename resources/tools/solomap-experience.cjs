#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    if (key === 'json' || key === 'full' || key === 'help') {
      args[key] = true;
      continue;
    }
    args[key] = argv[index + 1] || '';
    index += 1;
  }
  return args;
}

function compactLine(value, maxLength = 240) {
  const line = String(value || '').replace(/\s+/g, ' ').trim();
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}...` : line;
}

function unique(values, limit = 20) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const item = compactLine(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function getSolomapRoot(projectRoot) {
  return path.join(projectRoot, '.solopreneur');
}

function readDigests(projectRoot) {
  const root = path.join(getSolomapRoot(projectRoot), 'run-digests');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({ file, digest: readJson(path.join(root, file)) }))
    .filter((entry) => entry.digest && (entry.digest.schemaVersion === 1 || entry.digest.schemaVersion === 2))
    .map((entry) => ({ ...entry.digest, digestFile: path.join(root, entry.file) }))
    .sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')));
}

function readGraph(projectRoot) {
  return readJson(path.join(getSolomapRoot(projectRoot), 'execution-graph.json')) || null;
}

async function readExecutionLogs(projectRoot) {
  const dbPath = path.join(getSolomapRoot(projectRoot), 'project_journal.db');
  if (!fs.existsSync(dbPath)) return [];
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  try {
    const res = db.exec('SELECT id, nodeId, timestamp, agentCli, command, output, status FROM execution_logs ORDER BY id DESC');
    if (!res.length) return [];
    const columns = res[0].columns;
    return res[0].values.map((row) => {
      const record = {};
      columns.forEach((column, index) => {
        record[column] = row[index];
      });
      return record;
    });
  } finally {
    db.close();
  }
}

function extractSection(output, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(output || '').match(new RegExp(`${escaped}:\\n([\\s\\S]*?)(?=\\n[A-Z][^\\n]{2,80}:\\n|$)`));
  return match ? match[1].trim() : '';
}

function parseLogSignals(log, includeFull) {
  const output = String(log.output || '');
  const changedFiles = extractSection(output, 'Workspace changes')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 24);
  const touchedFiles = extractSection(output, 'Touched project files')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 24);
  const outputTail = extractSection(output, 'Agent output tail')
    .split('\n')
    .map((line) => compactLine(line, 260))
    .filter(Boolean)
    .slice(-12);
  return {
    id: Number(log.id || 0),
    nodeId: String(log.nodeId || ''),
    timestamp: String(log.timestamp || ''),
    agentCli: String(log.agentCli || ''),
    command: compactLine(log.command || '', 320),
    status: String(log.status || ''),
    userSupplement: compactLine(extractSection(output, 'User supplement'), 700),
    completionDecision: compactLine(extractSection(output, 'Completion decision'), 700),
    failureCategory: compactLine(extractSection(output, 'Failure category'), 180),
    failureReason: compactLine(extractSection(output, 'Failure reason'), 700),
    changedFiles,
    touchedFiles,
    outputTail,
    output: includeFull ? output : undefined
  };
}

function normalizeLimit(value) {
  const limit = Number(value || 8);
  return Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 8;
}

function filterRecords(records, args) {
  const query = String(args.query || '').toLowerCase();
  return records.filter((record) => {
    if (args.node && String(record.nodeId || '') !== String(args.node)) return false;
    if (args.agent && String(record.agentCli || '') !== String(args.agent)) return false;
    if (args.status && String(record.status || '') !== String(args.status)) return false;
    if (!query) return true;
    const haystack = JSON.stringify(record).toLowerCase();
    return query.split(/\s+/).filter(Boolean).every((token) => haystack.includes(token));
  });
}

function mergeDigestAndLogs(digests, logs, args) {
  const logById = new Map(logs.map((log) => [Number(log.id || 0), log]));
  const digestRecords = digests.map((digest) => ({
    source: 'digest',
    runId: digest.runId,
    executionLogId: Number(digest.executionLogId || 0),
    nodeId: String(digest.nodeId || ''),
    runKind: String(digest.runKind || ''),
    agentCli: String(digest.agentCli || ''),
    status: String(digest.status || ''),
    finishedAt: String(digest.finishedAt || ''),
    userIntent: digest.userIntent || '',
    outcome: digest.outcome || '',
    changedFiles: digest.changedFiles || [],
    touchedFiles: digest.touchedFiles || [],
    verification: digest.verification || [],
    failures: digest.failures || [],
    reusableSignals: digest.reusableSignals || [],
    handoff: digest.handoff || null,
    digestFile: digest.digestFile,
    log: logById.get(Number(digest.executionLogId || 0)) || null
  }));
  const digestLogIds = new Set(digestRecords.map((record) => Number(record.executionLogId || 0)));
  const logRecords = logs
    .filter((log) => !digestLogIds.has(Number(log.id || 0)))
    .map((log) => ({
      source: 'sqlite',
      runId: '',
      executionLogId: Number(log.id || 0),
      nodeId: String(log.nodeId || ''),
      runKind: '',
      agentCli: String(log.agentCli || ''),
      status: String(log.status || ''),
      finishedAt: String(log.timestamp || ''),
      userIntent: log.userSupplement || '',
      outcome: log.completionDecision || log.failureReason || '',
      changedFiles: log.changedFiles || [],
      touchedFiles: log.touchedFiles || [],
      verification: [],
      failures: unique([log.failureCategory, log.failureReason], 4),
      reusableSignals: unique([log.completionDecision, ...(log.outputTail || [])], 6),
      handoff: null,
      digestFile: '',
      log
    }));
  return filterRecords([...digestRecords, ...logRecords], args)
    .sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')));
}

function buildHandoffPack(records, limit) {
  return records.slice(0, limit).map((record) => {
    const handoff = record.handoff || {};
    return {
      runId: record.runId,
      executionLogId: record.executionLogId,
      nodeId: record.nodeId,
      agentCli: record.agentCli,
      status: record.status,
      finishedAt: record.finishedAt,
      brief: handoff.nextAgentBrief || record.outcome || record.userIntent,
      recommendedFirstActions: handoff.recommendedFirstActions || [],
      filesToInspectFirst: handoff.filesToInspectFirst || unique([...(record.changedFiles || []), ...(record.touchedFiles || [])], 8),
      commandsToRunNext: handoff.commandsToRunNext || [],
      blockedBy: handoff.blockedBy || record.failures || [],
      openQuestions: handoff.openQuestions || [],
      doNotRepeat: handoff.doNotRepeat || [],
      confidence: handoff.confidence || 'medium',
      riskLevel: handoff.riskLevel || (record.failures && record.failures.length ? 'high' : 'medium')
    };
  });
}

function buildSummary(records, graph) {
  const byStatus = {};
  const byAgent = {};
  records.forEach((record) => {
    byStatus[record.status || 'unknown'] = (byStatus[record.status || 'unknown'] || 0) + 1;
    byAgent[record.agentCli || 'unknown'] = (byAgent[record.agentCli || 'unknown'] || 0) + 1;
  });
  return {
    totalRecords: records.length,
    graphRunCount: graph ? graph.runCount : 0,
    byStatus,
    byAgent,
    latest: records.slice(0, 5).map((record) => ({
      executionLogId: record.executionLogId,
      nodeId: record.nodeId,
      agentCli: record.agentCli,
      status: record.status,
      finishedAt: record.finishedAt,
      outcome: compactLine(record.outcome || record.userIntent, 220)
    }))
  };
}

function renderMarkdown(title, payload) {
  const lines = [`# ${title}`, ''];
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      lines.push('No matching records.');
    }
    payload.forEach((item, index) => {
      lines.push(`## ${index + 1}. ${item.status || 'Unknown'} · ${item.agentCli || 'unknown'} · node ${item.nodeId || '-'}`);
      lines.push('');
      if (item.brief) lines.push(`- Brief: ${item.brief}`);
      if (item.executionLogId) lines.push(`- Execution log: ${item.executionLogId}`);
      if (item.filesToInspectFirst && item.filesToInspectFirst.length) lines.push(`- Files: ${item.filesToInspectFirst.join(', ')}`);
      if (item.recommendedFirstActions && item.recommendedFirstActions.length) lines.push(`- First actions: ${item.recommendedFirstActions.join(' / ')}`);
      if (item.commandsToRunNext && item.commandsToRunNext.length) lines.push(`- Verify: ${item.commandsToRunNext.join(' / ')}`);
      if (item.blockedBy && item.blockedBy.length) lines.push(`- ${item.status === 'Failed' ? 'Blocked by' : 'Risks'}: ${item.blockedBy.join(' / ')}`);
      if (item.doNotRepeat && item.doNotRepeat.length) lines.push(`- Do not repeat: ${item.doNotRepeat.join(' / ')}`);
      lines.push('');
    });
    return lines.join('\n');
  }
  for (const [key, value] of Object.entries(payload || {})) {
    if (Array.isArray(value)) {
      lines.push(`## ${key}`);
      value.forEach((entry) => lines.push(`- ${compactLine(JSON.stringify(entry), 320)}`));
      lines.push('');
    } else if (value && typeof value === 'object') {
      lines.push(`## ${key}`);
      Object.entries(value).forEach(([innerKey, innerValue]) => lines.push(`- ${innerKey}: ${innerValue}`));
      lines.push('');
    } else {
      lines.push(`- ${key}: ${value}`);
    }
  }
  return lines.join('\n');
}

function printHelp() {
  console.log([
    'Usage: node resources/tools/solomap-experience.cjs <command> [options]',
    '',
    'Commands:',
    '  handoff          Build a cross-agent handoff pack from run digests and SQLite logs.',
    '  summary          Show counts and latest execution signals.',
    '  history          Show recent execution records.',
    '  failures         Show failed or risky records.',
    '  latest-changes   Show recently changed/touched files.',
    '  search           Search digests and SQLite signal summaries.',
    '  pack             Alias for handoff with broader retrieval wording.',
    '',
    'Options:',
    '  --project <path> Workspace root. Defaults to current directory.',
    '  --node <id>      Filter by SoloMap node id.',
    '  --agent <cli>    Filter by Agent CLI.',
    '  --status <s>     Filter by run status.',
    '  --query <text>   Search text.',
    '  --limit <n>      Max records. Defaults to 8.',
    '  --json           Output JSON.',
    '  --full           Include raw SQLite output in history/search records.'
  ].join('\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'handoff';
  if (args.help || command === 'help') {
    printHelp();
    return;
  }
  const projectRoot = path.resolve(args.project || process.cwd());
  const limit = normalizeLimit(args.limit);
  const digests = readDigests(projectRoot);
  const graph = readGraph(projectRoot);
  const logs = (await readExecutionLogs(projectRoot)).map((log) => parseLogSignals(log, Boolean(args.full)));
  const records = mergeDigestAndLogs(digests, logs, args);

  let title = 'SoloMap Experience';
  let payload;
  if (command === 'summary') {
    title = 'SoloMap Execution Summary';
    payload = buildSummary(records, graph);
  } else if (command === 'history') {
    title = 'SoloMap Execution History';
    payload = records.slice(0, limit);
  } else if (command === 'failures') {
    title = 'SoloMap Failure Signals';
    payload = records.filter((record) => record.status === 'Failed' || (record.failures || []).length > 0).slice(0, limit);
  } else if (command === 'latest-changes') {
    title = 'SoloMap Latest Changes';
    payload = {
      files: unique(records.flatMap((record) => [...(record.changedFiles || []), ...(record.touchedFiles || [])]), limit)
    };
  } else if (command === 'search') {
    title = 'SoloMap Experience Search';
    payload = records.slice(0, limit);
  } else if (command === 'handoff' || command === 'pack') {
    title = 'SoloMap Cross-Agent Handoff Pack';
    payload = buildHandoffPack(records, limit);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }

  if (args.json) {
    console.log(JSON.stringify({ command, projectRoot, generatedAt: new Date().toISOString(), payload }, null, 2));
    return;
  }
  console.log(renderMarkdown(title, payload));
}

main().catch((error) => {
  console.error(`solomap-experience failed: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
