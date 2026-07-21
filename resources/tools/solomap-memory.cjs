#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_ORDER = ['profile', 'rules', 'project', 'decisions', 'patterns', 'domains', 'inbox', 'active'];
const ROUTE_ALIASES = {
  profile: 'profile', preference: 'profile',
  rules: 'rules', rule: 'rules',
  project: 'project',
  decision: 'decision', decisions: 'decision',
  pattern: 'pattern', patterns: 'pattern',
  domain: 'domain', domains: 'domain',
  inbox: 'inbox', observation: 'inbox',
  active: 'active', handoff: 'active'
};
const STOP_WORDS = new Set([
  'http', 'https', 'www', 'com', 'agent', 'solo', 'solomap', '项目', '任务', '当前', '本轮',
  '问题', '相关', '进行', '一个', '这个', '需要', '使用', '查看', '记忆', '系统', '内容',
  '项目记忆系统', '记忆系统'
]);

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    if (key === 'json' || key === 'help') {
      args[key] = true;
      continue;
    }
    args[key] = argv[index + 1] || '';
    index += 1;
  }
  return args;
}

function compact(value, maxLength = 320) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function unique(values, limit = 40) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = String(value || '').toLowerCase().trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeLimit(value) {
  const parsed = Number(value || 5);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 20) : 5;
}

function projectSlug(projectRoot) {
  return path.basename(path.resolve(projectRoot)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

function fileSlug(value) {
  const slug = String(value || '').toLowerCase().trim()
    .replace(/[^a-z0-9一-龥._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, 80);
}

function queryTokens(value, projectRoot) {
  const ignoredProject = projectSlug(projectRoot);
  const base = String(value || '').toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^a-z0-9_./\-一-龥]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && token !== ignoredProject && !STOP_WORDS.has(token));
  const expanded = [];
  for (const token of base) {
    expanded.push(token);
    if (/^[一-龥]{9,}$/.test(token)) {
      for (let index = 0; index <= token.length - 3; index += 1) {
        expanded.push(token.slice(index, index + 3));
      }
    }
  }
  return unique(expanded);
}

function parseSources(value) {
  if (!value) return new Set(SOURCE_ORDER);
  const requested = new Set(String(value).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
  const invalid = [...requested].filter((item) => !SOURCE_ORDER.includes(item));
  if (invalid.length) throw new Error(`Unknown memory source: ${invalid.join(', ')}`);
  return requested;
}

function markdownFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('_'))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function sourceFiles(memoryRoot, currentProjectSlug, sources) {
  const entries = [];
  const add = (source, files) => {
    if (!sources.has(source)) return;
    files.forEach((file) => {
      if (fs.existsSync(file)) entries.push({ source, file });
    });
  };
  add('profile', [path.join(memoryRoot, 'profile.md')]);
  add('rules', [path.join(memoryRoot, 'operating-rules.md')]);
  add('project', [path.join(memoryRoot, 'projects', `${currentProjectSlug}.md`)]);
  add('decisions', markdownFiles(path.join(memoryRoot, 'decisions')));
  add('patterns', markdownFiles(path.join(memoryRoot, 'patterns')));
  add('domains', markdownFiles(path.join(memoryRoot, 'domains')));
  add('inbox', markdownFiles(path.join(memoryRoot, 'inbox')));
  add('active', [path.join(memoryRoot, 'active', 'current-session.md')]);
  return entries;
}

function splitMarkdown(filePath, source) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const chunks = [];
  let heading = path.basename(filePath);
  let start = 1;
  let buffer = [];
  const flush = (end) => {
    const text = buffer.join('\n').trim();
    if (text && !/^#?\s*(template|模板|示例)\s*:?$/i.test(heading)) {
      chunks.push({ source, filePath, heading, lineStart: start, lineEnd: Math.max(start, end), text });
    }
    buffer = [];
  };
  lines.forEach((line, index) => {
    const match = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (match) {
      flush(index);
      heading = match[2].trim();
      start = index + 1;
      buffer = [line];
      return;
    }
    if (buffer.join('\n').length >= 1200 && /^[-*+]\s+/.test(line)) {
      flush(index);
      start = index + 1;
    }
    buffer.push(line);
    if (buffer.join('\n').length >= 1600 && line.trim() === '') {
      flush(index + 1);
      start = index + 2;
    }
  });
  flush(lines.length);
  return chunks;
}

function scoreChunk(chunk, tokens, query) {
  const fileName = path.basename(chunk.filePath).toLowerCase();
  const heading = chunk.heading.toLowerCase();
  const body = chunk.text.toLowerCase();
  const matchedTerms = [];
  let score = 0;
  for (const token of tokens) {
    let matched = false;
    if (fileName.includes(token)) { score += 7; matched = true; }
    if (heading.includes(token)) { score += 6; matched = true; }
    if (body.includes(token)) { score += 2; matched = true; }
    if (matched) matchedTerms.push(token);
  }
  const normalizedQuery = compact(query, 180).toLowerCase();
  if (normalizedQuery.length >= 4 && body.includes(normalizedQuery)) score += 10;
  if (chunk.source === 'project') score += 3;
  if (chunk.source === 'decisions' || chunk.source === 'patterns') score += 2;
  if (chunk.source === 'inbox') score -= 2;
  return { score, matchedTerms: unique(matchedTerms, 8) };
}

function summarizeChunk(chunk) {
  const useful = chunk.text.split(/\r?\n/)
    .map((line) => line.replace(/^#{1,4}\s+/, '').replace(/^[-*+]\s+/, '').trim())
    .filter((line) => line && !/^(模板|建议内容|示例|template)\s*:?$/i.test(line));
  return compact(useful.slice(0, 3).join(' '), 360);
}

function retrieveMemory(memoryRoot, projectRoot, query, sources, limit) {
  const tokens = queryTokens(query, projectRoot);
  if (!tokens.length) {
    return {
      query,
      tokens: [],
      results: [],
      message: '请使用具体功能、边界、决策、错误或目标查询；URL、项目名和“记忆系统”等泛化词不会作为相关性依据。'
    };
  }
  const candidates = sourceFiles(memoryRoot, projectSlug(projectRoot), sources)
    .flatMap(({ source, file }) => splitMarkdown(file, source))
    .map((chunk) => ({ chunk, ...scoreChunk(chunk, tokens, query) }))
    .filter((entry) => entry.matchedTerms.length > 0 && entry.score >= 6)
    .sort((a, b) => b.score - a.score
      || SOURCE_ORDER.indexOf(a.chunk.source) - SOURCE_ORDER.indexOf(b.chunk.source)
      || a.chunk.filePath.localeCompare(b.chunk.filePath)
      || a.chunk.lineStart - b.chunk.lineStart);
  const seen = new Set();
  const results = [];
  for (const entry of candidates) {
    const key = `${entry.chunk.filePath}:${entry.chunk.lineStart}`;
    const summary = summarizeChunk(entry.chunk);
    if (!summary || seen.has(key)) continue;
    seen.add(key);
    results.push({
      source: entry.chunk.source,
      file: entry.chunk.filePath,
      lineStart: entry.chunk.lineStart,
      lineEnd: entry.chunk.lineEnd,
      heading: entry.chunk.heading,
      relevance: entry.score,
      matchedTerms: entry.matchedTerms,
      reason: `${entry.chunk.source} 中的“${entry.chunk.heading}”命中：${entry.matchedTerms.join('、')}`,
      summary
    });
    if (results.length >= limit) break;
  }
  return {
    query,
    tokens,
    results,
    message: results.length
      ? '只返回高相关记忆片段及精确位置；读取原文前仍应以当前代码、日志、测试和用户要求校验。'
      : '没有达到相关性门槛的记忆；请依赖当前证据继续调查，或使用更具体的查询。'
  };
}

function routeMemory(memoryRoot, projectRoot, kindValue, titleValue, now = new Date()) {
  const kind = ROUTE_ALIASES[String(kindValue || '').toLowerCase().trim()];
  if (!kind) {
    throw new Error('Unknown memory kind. Use profile, rules, project, decision, pattern, domain, inbox, or active.');
  }
  const title = compact(titleValue, 120);
  const month = now.toISOString().slice(0, 7);
  const titledSlug = fileSlug(title);
  let targetFile;
  let operation;
  let requiredStructure;
  let appliesWhen;
  if (kind === 'profile') {
    targetFile = path.join(memoryRoot, 'profile.md');
    operation = 'Update an existing matching preference; append only when no equivalent preference exists.';
    requiredStructure = ['Preference', 'Evidence or repeated user signal', 'Applies across projects when'];
    appliesWhen = 'Stable user preference, communication style, collaboration preference, or prohibition that applies across projects.';
  } else if (kind === 'rules') {
    targetFile = path.join(memoryRoot, 'operating-rules.md');
    operation = 'Merge with an existing rule when possible; add one concise rule backed by verified evidence.';
    requiredStructure = ['Rule', 'Applies when', 'Evidence'];
    appliesWhen = 'Reusable execution rule that applies across tasks or projects, not a project-specific implementation fact.';
  } else if (kind === 'project') {
    targetFile = path.join(memoryRoot, 'projects', `${projectSlug(projectRoot)}.md`);
    operation = 'Update the matching stable fact or append a concise project-scoped section; remove or mark superseded facts when current evidence invalidates them.';
    requiredStructure = ['Stable project fact', 'Current evidence', 'Affected boundary or entry point'];
    appliesWhen = 'Stable fact, entry point, architecture boundary, or operational context unique to the current project.';
  } else if (kind === 'decision') {
    targetFile = path.join(memoryRoot, 'decisions', `${month}.md`);
    operation = 'Append or update a titled decision section; do not create a duplicate decision with equivalent meaning.';
    requiredStructure = ['Decision', 'Rationale', 'Evidence', 'Consequences'];
    appliesWhen = 'Confirmed choice with rationale and future consequences; not an unverified idea or temporary implementation note.';
  } else if (kind === 'pattern') {
    if (!titledSlug) throw new Error('--title is required for pattern memory routing.');
    targetFile = path.join(memoryRoot, 'patterns', `${titledSlug}.md`);
    operation = 'Create or update one reusable pattern file; merge equivalent patterns instead of creating variants.';
    requiredStructure = ['Pattern', 'Evidence', 'Applies when', 'Do this', 'Avoid this'];
    appliesWhen = 'Verified implementation, debugging, validation, deployment, or delivery approach reusable across projects.';
  } else if (kind === 'domain') {
    if (!titledSlug) throw new Error('--title is required for domain memory routing.');
    targetFile = path.join(memoryRoot, 'domains', `${titledSlug}.md`);
    operation = 'Create or update the matching domain file; separate verified facts from assumptions and record freshness when facts can change.';
    requiredStructure = ['Domain fact', 'Evidence or source', 'Applies when', 'Freshness or validity note'];
    appliesWhen = 'Cross-project business, platform, protocol, regulatory, or technical domain knowledge.';
  } else if (kind === 'inbox') {
    targetFile = path.join(memoryRoot, 'inbox', 'capture.md');
    operation = 'Append a clearly marked unverified observation for later review; do not present it as stable fact.';
    requiredStructure = ['Observation', 'Source task', 'What remains unverified', 'Possible promotion target'];
    appliesWhen = 'Potentially useful information that is not yet sufficiently verified for stable memory.';
  } else {
    targetFile = path.join(memoryRoot, 'active', 'current-session.md');
    operation = 'Update the current handoff state; replace stale session state instead of accumulating an execution diary.';
    requiredStructure = ['Current goal', 'Verified facts', 'Open work or blocker', 'Next action'];
    appliesWhen = 'Current session handoff, pause state, continuation context, or unresolved work.';
  }
  return {
    kind,
    title,
    targetFile,
    operation,
    appliesWhen,
    requiredStructure,
    guardrails: [
      'Read the target file before editing and preserve unrelated user content.',
      'Write only information verified by current code, logs, tests, commands, or an explicit user decision.',
      'Do not write command output, diffs, commit ids, completion boilerplate, or an execution diary into stable memory.',
      'If an equivalent entry exists, update or supersede it instead of appending a duplicate.',
      'Memory must not override newer user instructions or current runtime evidence.'
    ]
  };
}

function renderMarkdown(payload) {
  const lines = ['# SoloMap Memory Retrieval', '', `- Query: ${payload.query}`, `- Guidance: ${payload.message}`, ''];
  if (!payload.results.length) return `${lines.join('\n')}\nNo high-value memory matched.`;
  payload.results.forEach((result, index) => {
    lines.push(`## ${index + 1}. ${result.heading}`);
    lines.push(`- Source: ${result.source}`);
    lines.push(`- Location: ${result.file}:${result.lineStart}`);
    lines.push(`- Relevance: ${result.relevance}`);
    lines.push(`- Why: ${result.reason}`);
    lines.push(`- Summary: ${result.summary}`, '');
  });
  return lines.join('\n');
}

function renderRouteMarkdown(payload) {
  return [
    '# SoloMap Memory Write Route',
    '',
    `- Kind: ${payload.kind}`,
    `- Target: ${payload.targetFile}`,
    `- Applies when: ${payload.appliesWhen}`,
    `- Update strategy: ${payload.operation}`,
    `- Required structure: ${payload.requiredStructure.join(' / ')}`,
    '',
    '## Guardrails',
    '',
    ...payload.guardrails.map((item) => `- ${item}`)
  ].join('\n');
}

function printHelp() {
  console.log([
    'Usage: node resources/tools/solomap-memory.cjs <retrieve|route> [options]',
    '',
    'Options:',
    '  --project <path> Workspace root. Defaults to current directory.',
    '  --global <path>  SoloMap global root. Defaults to <project parent>/.solomap-global.',
    '  --query <text>   Concrete feature, boundary, decision, error, or goal.',
    '  --sources <list> Comma-separated: profile,rules,project,decisions,patterns,domains,inbox,active.',
    '  --limit <n>      Maximum results. Defaults to 5, maximum 20.',
    '  --kind <type>    Write route: profile,rules,project,decision,pattern,domain,inbox,active.',
    '  --title <text>   Topic title. Required for pattern and domain routes.',
    '  --json           Output machine-readable JSON.',
    '  --help           Show this help.'
  ].join('\n'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'retrieve';
  if (args.help || command === 'help') return printHelp();
  if (command !== 'retrieve' && command !== 'route') throw new Error(`Unknown command: ${command}`);
  const projectRoot = path.resolve(args.project || process.cwd());
  const globalRoot = path.resolve(args.global || path.join(path.dirname(projectRoot), '.solomap-global'));
  const memoryRoot = path.join(globalRoot, 'memory');
  if (!fs.existsSync(memoryRoot)) throw new Error(`Memory root not found: ${memoryRoot}`);
  const payload = command === 'retrieve'
    ? retrieveMemory(memoryRoot, projectRoot, String(args.query || ''), parseSources(args.sources), normalizeLimit(args.limit))
    : routeMemory(memoryRoot, projectRoot, args.kind, args.title);
  if (args.json) {
    console.log(JSON.stringify({ command, projectRoot, globalRoot, memoryRoot, payload }, null, 2));
    return;
  }
  console.log(command === 'retrieve' ? renderMarkdown(payload) : renderRouteMarkdown(payload));
}

try {
  main();
} catch (error) {
  console.error(`solomap-memory failed: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
}
