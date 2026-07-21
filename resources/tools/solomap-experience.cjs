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

function readLearningCandidates(globalRoot) {
  const root = path.join(globalRoot, 'learning', 'candidates');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((file) => file.endsWith('.json'))
    .map((file) => readJson(path.join(root, file)))
    .filter((candidate) => candidate && candidate.schemaVersion === 1 && candidate.status !== 'rejected');
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

const RETRIEVAL_STOP_WORDS = new Set([
  'http', 'https', 'www', 'com', 'solo', 'flow', 'agent', 'codex', '项目', '任务', '当前', '本轮',
  '完成', '验证', '修复', '实现', '问题', '相关', '运行', '对话', '使用', '进行', '一个', '这个'
]);

function retrievalTokens(value, projectRoot) {
  const projectName = path.basename(projectRoot).toLowerCase();
  const baseTokens = String(value || '').toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^a-z0-9_./\-一-龥]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && token !== projectName && !RETRIEVAL_STOP_WORDS.has(token));
  const expanded = [];
  for (const token of baseTokens) {
    expanded.push(token);
    if (/^[一-龥]{5,}$/.test(token)) {
      for (let index = 0; index <= token.length - 3; index += 1) {
        expanded.push(token.slice(index, index + 3));
      }
    }
  }
  return unique(expanded, 40);
}

function scoreTextFields(tokens, fields) {
  let score = 0;
  let matches = 0;
  for (const token of tokens) {
    let tokenMatched = false;
    fields.forEach(({ text, weight }) => {
      if (String(text || '').toLowerCase().includes(token)) {
        score += weight;
        tokenMatched = true;
      }
    });
    if (tokenMatched) matches += 1;
  }
  return { score, matches };
}

function isLowValueLesson(candidate) {
  const summary = String(candidate.summary || '').toLowerCase();
  if (!summary || /usage limit|solo conversation state|等待用户决定是否关联|run completed without explicit|diff --git|(^|\W)i will\s|\+\+\+ b\/|--- a\//.test(summary)) return true;
  if (candidate.lessonType === 'verification_pattern' && (
    summary.length > 320 ||
    (summary.match(/\s\/\s/g) || []).length > 3 ||
    /command:\s*cat|\bconst\s+[a-z_]|new request\(|dangerously-bypass/.test(summary)
  )) return true;
  const meaningful = summary
    .split(/\s+\/\s+|\n/)
    .filter((part) => !/^(diff --git|--- |\+\+\+ |@@ |[+-]?test\(|[+-]?[a-z0-9_./-]+\.(js|ts|json|md))/.test(part.trim()));
  return meaningful.join(' ').replace(/[^a-z0-9一-龥]/gi, '').length < 18;
}

function retrieveLessons(candidates, records, query, projectRoot, limit) {
  const tokens = retrievalTokens(query, projectRoot);
  if (tokens.length === 0) {
    return { query, tokens: [], lessons: [], evidenceLeads: [], message: '请使用具体功能、文件、错误或目标查询；URL、项目名和运行类型不会作为相关性依据。' };
  }
  const lessonKeys = new Set();
  const lessons = candidates
    .filter((candidate) => !isLowValueLesson(candidate))
    .filter((candidate) => candidate.lessonType !== 'verification_pattern' || /测试|验证|命令|[a-z0-9_-]+\.[a-z0-9]+/i.test(query))
    .filter((candidate) => candidate.lessonType !== 'risk_pattern' || /失败|错误|报错|故障|异常|error|failed/i.test(query))
    .map((candidate) => {
      const evidenceText = (candidate.evidenceRefs || []).map((ref) => `${ref.ref || ''} ${ref.summary || ''}`).join(' ');
      const match = scoreTextFields(tokens, [
        { text: candidate.summary, weight: 5 },
        { text: candidate.appliesWhen, weight: 4 },
        { text: candidate.doThis, weight: 3 },
        { text: candidate.avoidThis, weight: 3 },
        { text: evidenceText, weight: 5 }
      ]);
      const projectScore = path.resolve(String(candidate.projectPath || '')) === path.resolve(projectRoot) ? 3 : 0;
      const statusScore = candidate.status === 'promoted' || candidate.status === 'approved' ? 5 : 0;
      const confidenceScore = candidate.confidence === 'high' ? 2 : candidate.confidence === 'medium' ? 1 : 0;
      return { candidate, score: match.score + projectScore + statusScore + confidenceScore, matches: match.matches };
    })
    .filter((entry) => entry.matches > 0 && entry.score >= 7)
    .sort((a, b) => b.score - a.score || String(b.candidate.updatedAt || '').localeCompare(String(a.candidate.updatedAt || '')))
    .filter((entry) => {
      const key = compactLine(entry.candidate.summary, 260).toLowerCase();
      if (lessonKeys.has(key)) return false;
      lessonKeys.add(key);
      return true;
    })
    .slice(0, limit)
    .map(({ candidate, score }) => ({
      id: candidate.id,
      relevance: score,
      lesson: compactLine(candidate.summary, 360),
      appliesWhen: compactLine(candidate.appliesWhen, 240),
      doThis: compactLine(candidate.doThis, 240),
      avoidThis: compactLine(candidate.avoidThis, 240),
      confidence: candidate.confidence || 'unknown',
      status: candidate.status || 'candidate',
      projectName: candidate.projectName || '',
      evidence: (candidate.evidenceRefs || []).filter((ref) => ref.type === 'run_digest' || ref.type === 'command').slice(0, 3)
    }));
  const evidenceLeads = records
    .map((record) => {
      const match = scoreTextFields(tokens, [
        { text: record.userIntent, weight: 4 },
        { text: record.outcome, weight: 4 },
        { text: (record.changedFiles || []).join(' '), weight: 5 },
        { text: (record.failures || []).join(' '), weight: 5 },
        { text: (record.verification || []).join(' '), weight: 3 }
      ]);
      return { record, score: match.score, matches: match.matches };
    })
    .filter((entry) => entry.matches > 0 && entry.score >= 4)
    .sort((a, b) => b.score - a.score || String(b.record.finishedAt || '').localeCompare(String(a.record.finishedAt || '')))
    .slice(0, Math.min(limit, 3))
    .map(({ record, score }) => ({
      relevance: score,
      runId: record.runId,
      executionLogId: record.executionLogId,
      intent: compactLine(record.userIntent, 220),
      outcome: /等待用户决定是否关联到路线图环节/.test(String(record.outcome || '')) ? '' : compactLine(record.outcome, 260),
      files: unique([...(record.changedFiles || []), ...(record.touchedFiles || [])], 5),
      digestFile: record.digestFile || ''
    }));
  return {
    query,
    tokens,
    lessons,
    evidenceLeads,
    message: lessons.length || evidenceLeads.length
      ? '只返回可复用判断和必要证据入口；需要原始记录时再使用 history、handoff 或 search。'
      : '没有达到相关性与质量门槛的经验；请以当前代码、日志和测试继续调查。'
  };
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
  if (payload && Array.isArray(payload.lessons) && Array.isArray(payload.evidenceLeads)) {
    lines.push(`- Query: ${payload.query || ''}`);
    lines.push(`- Guidance: ${payload.message || ''}`, '');
    lines.push('## Reusable lessons', '');
    if (payload.lessons.length === 0) lines.push('No high-value lesson matched.', '');
    payload.lessons.forEach((item, index) => {
      lines.push(`### ${index + 1}. ${item.lesson}`);
      lines.push(`- Applies when: ${item.appliesWhen}`);
      lines.push(`- Do: ${item.doThis}`);
      lines.push(`- Avoid: ${item.avoidThis}`);
      lines.push(`- Confidence: ${item.confidence} · status: ${item.status} · relevance: ${item.relevance}`);
      if (item.evidence.length) lines.push(`- Evidence: ${item.evidence.map((ref) => ref.ref).join(' / ')}`);
      lines.push('');
    });
    lines.push('## Evidence leads', '');
    if (payload.evidenceLeads.length === 0) lines.push('No strong run evidence matched.', '');
    payload.evidenceLeads.forEach((item) => {
      lines.push(`- ${item.intent || item.outcome} · relevance ${item.relevance}`);
      if (item.intent && item.outcome) lines.push(`  Outcome: ${item.outcome}`);
      if (item.files.length) lines.push(`  Files: ${item.files.join(', ')}`);
      if (item.digestFile) lines.push(`  Digest: ${item.digestFile}`);
    });
    return lines.join('\n');
  }
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
    '  retrieve         Find high-value lessons and evidence leads for a concrete task query.',
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
    '  --global <path>  SoloMap global root. Defaults to <project parent>/.solomap-global.',
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
  const globalRoot = path.resolve(args.global || path.join(path.dirname(projectRoot), '.solomap-global'));
  const limit = normalizeLimit(args.limit);
  const digests = readDigests(projectRoot);
  const graph = readGraph(projectRoot);
  const logs = (await readExecutionLogs(projectRoot)).map((log) => parseLogSignals(log, Boolean(args.full)));
  const records = mergeDigestAndLogs(digests, logs, args);

  let title = 'SoloMap Experience';
  let payload;
  if (command === 'retrieve') {
    title = 'SoloMap Task Experience Retrieval';
    payload = retrieveLessons(readLearningCandidates(globalRoot), records, String(args.query || ''), projectRoot, limit);
  } else if (command === 'summary') {
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
    console.log(JSON.stringify({ command, projectRoot, globalRoot, generatedAt: new Date().toISOString(), payload }, null, 2));
    return;
  }
  console.log(renderMarkdown(title, payload));
}

main().catch((error) => {
  console.error(`solomap-experience failed: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
