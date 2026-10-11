#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { openDataClient } = require('./solomap-data-client.cjs');

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
  if (!value) {
    const defaults = new Set(SOURCE_ORDER);
    defaults.explicit = false;
    return defaults;
  }
  const requested = new Set(String(value).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
  const invalid = [...requested].filter((item) => !SOURCE_ORDER.includes(item));
  if (invalid.length) throw new Error(`Unknown memory source: ${invalid.join(', ')}`);
  requested.explicit = true;
  return requested;
}

const MEMORY_SOURCES = {
  profile: 'profile', preference: 'profile', rules: 'rules', rule: 'rules', operating_rule: 'rules',
  project: 'project', project_fact: 'project', decision: 'decisions', decisions: 'decisions',
  pattern: 'patterns', patterns: 'patterns', domain: 'domains', domains: 'domains',
  observation: 'inbox', inbox: 'inbox', handoff: 'active', active: 'active'
};

async function memoryReferences(client, terms, sources, includeCandidates = false) {
  const categories = Object.keys(MEMORY_SOURCES).filter(category => sources.has(MEMORY_SOURCES[category]));
  for (;;) {
    const objects = []; let cursor; let changed = false;
    do {
      const page = await client.call('context', { project: client.scope, view: 'metadata', categories, limit: 100, ...(terms ? { terms } : {}), ...(cursor ? { cursor } : {}) });
      if (page.sourceChanged) { changed = true; break; }
      objects.push(...page.items.filter(object => object.kind === 'memory' && (includeCandidates || object.data.layer !== 'candidate' || (sources.explicit && sources.has('inbox')))));
      cursor = page.cursor;
    } while (cursor);
    if (!changed) return objects;
  }
}

function splitMarkdown(text, source, headingValue) {
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let heading = headingValue;
  let start = 1;
  let buffer = [];
  const flush = (end) => {
    const text = buffer.join('\n').trim();
    if (text && !/^#?\s*(template|模板|示例)\s*:?$/i.test(heading)) {
      chunks.push({ source, heading, lineStart: start, lineEnd: Math.max(start, end), text });
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
  const fileName = String(chunk.sourceName || '').toLowerCase();
  const heading = chunk.heading.toLowerCase();
  const body = [chunk.text, chunk.searchMetadata || ''].join('\n').toLowerCase();
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
  if (chunk.format === 'json' || chunk.format === 'record' || chunk.searchMetadata) score += 4;
  return { score, matchedTerms: unique(matchedTerms, 8) };
}

function summarizeChunk(chunk) {
  const useful = chunk.text.split(/\r?\n/)
    .map((line) => line.replace(/^#{1,4}\s+/, '').replace(/^[-*+]\s+/, '').trim())
    .filter((line) => line && !/^(模板|建议内容|示例|template)\s*:?$/i.test(line));
  return compact(useful.slice(0, 3).join(' '), 360);
}

async function retrieveMemory(client, projectRoot, query, sources, limit) {
  const tokens = queryTokens(query, projectRoot);
  if (!tokens.length) {
    return {
      query,
      tokens: [],
      results: [],
      message: '请使用具体功能、边界、决策、错误或目标查询；URL、项目名和“记忆系统”等泛化词不会作为相关性依据。'
    };
  }
  const objects = await memoryReferences(client, tokens, sources);
  const chunks = [];
  for (const object of objects) {
    const source = MEMORY_SOURCES[object.data.category];
    const body = await client.content(object);
    const tags = JSON.parse(object.data.tags_json || '[]');
    const provenance = JSON.parse(object.data.provenance_json || '{}');
    const searchMetadata = [...(Array.isArray(tags) ? tags : []), ...(Array.isArray(provenance?.evidenceRefs) ? provenance.evidenceRefs : [])].map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n');
    const metadata = { sourceRef: { objectId: object.objectId, revision: object.revision }, sourceName: path.basename(String(object.data.external_source || object.data.title)), memoryId: object.data.legacy_entry_id || object.objectId, searchMetadata };
    if (object.data.legacy_entry_id) {
      chunks.push({ ...metadata, source, heading: object.data.title, lineStart: 1, lineEnd: body.split(/\r?\n/).length, text: [object.data.title, body, searchMetadata].filter(Boolean).join('\n'), format: 'json' });
    } else {
      chunks.push(...splitMarkdown(body, source, object.data.title).map(chunk => ({ ...chunk, ...metadata, format: object.data.external_source ? 'markdown' : 'record' })));
    }
  }
  const candidates = chunks
    .map((chunk) => ({ chunk, ...scoreChunk(chunk, tokens, query) }))
    .filter((entry) => entry.matchedTerms.length > 0 && entry.score >= 6)
    .sort((a, b) => b.score - a.score
      || SOURCE_ORDER.indexOf(a.chunk.source) - SOURCE_ORDER.indexOf(b.chunk.source)
      || a.chunk.sourceRef.objectId.localeCompare(b.chunk.sourceRef.objectId)
      || a.chunk.lineStart - b.chunk.lineStart);
  const seen = new Set();
  const results = [];
  for (const entry of candidates) {
    const key = `${entry.chunk.sourceRef.objectId}:${entry.chunk.sourceRef.revision}:${entry.chunk.lineStart}`;
    const summary = summarizeChunk(entry.chunk);
    if (!summary || seen.has(key)) continue;
    seen.add(key);
    results.push({
      source: entry.chunk.source,
      sourceRef: entry.chunk.sourceRef,
      contentField: 'content',
      lineStart: entry.chunk.lineStart,
      lineEnd: entry.chunk.lineEnd,
      heading: entry.chunk.heading,
      relevance: entry.score,
      matchedTerms: entry.matchedTerms,
      reason: `${entry.chunk.source} 中的“${entry.chunk.heading}”命中：${entry.matchedTerms.join('、')}`,
      summary,
      memoryId: entry.chunk.memoryId || null,
      format: entry.chunk.format || 'markdown'
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

async function routeMemory(client, kindValue, titleValue) {
  const kind = ROUTE_ALIASES[String(kindValue || '').toLowerCase().trim()];
  if (!kind) {
    throw new Error('Unknown memory kind. Use profile, rules, project, decision, pattern, domain, inbox, or active.');
  }
  const title = compact(titleValue, 120);
  const titledSlug = fileSlug(title);
  let operation;
  let requiredStructure;
  let appliesWhen;
  if (kind === 'profile') {
    operation = 'Update an existing matching preference; append only when no equivalent preference exists.';
    requiredStructure = ['Preference', 'Evidence or repeated user signal', 'Applies across projects when'];
    appliesWhen = 'Stable user preference, communication style, collaboration preference, or prohibition that applies across projects.';
  } else if (kind === 'rules') {
    operation = 'Merge with an existing rule when possible; add one concise rule backed by verified evidence.';
    requiredStructure = ['Rule', 'Applies when', 'Evidence'];
    appliesWhen = 'Reusable execution rule that applies across tasks or projects, not a project-specific implementation fact.';
  } else if (kind === 'project') {
    operation = 'Update the matching stable fact or append a concise project-scoped section; remove or mark superseded facts when current evidence invalidates them.';
    requiredStructure = ['Stable project fact', 'Current evidence', 'Affected boundary or entry point'];
    appliesWhen = 'Stable fact, entry point, architecture boundary, or operational context unique to the current project.';
  } else if (kind === 'decision') {
    operation = 'Append or update a titled decision section; do not create a duplicate decision with equivalent meaning.';
    requiredStructure = ['Decision', 'Rationale', 'Evidence', 'Consequences'];
    appliesWhen = 'Confirmed choice with rationale and future consequences; not an unverified idea or temporary implementation note.';
  } else if (kind === 'pattern') {
    if (!titledSlug) throw new Error('--title is required for pattern memory routing.');
    operation = 'Create or update one reusable pattern; merge equivalent patterns instead of creating variants.';
    requiredStructure = ['Pattern', 'Evidence', 'Applies when', 'Do this', 'Avoid this'];
    appliesWhen = 'Verified implementation, debugging, validation, deployment, or delivery approach reusable across projects.';
  } else if (kind === 'domain') {
    if (!titledSlug) throw new Error('--title is required for domain memory routing.');
    operation = 'Create or update the matching domain record; separate verified facts from assumptions and record freshness when facts can change.';
    requiredStructure = ['Domain fact', 'Evidence or source', 'Applies when', 'Freshness or validity note'];
    appliesWhen = 'Cross-project business, platform, protocol, regulatory, or technical domain knowledge.';
  } else if (kind === 'inbox') {
    operation = 'Append a clearly marked unverified observation for later review; do not present it as stable fact.';
    requiredStructure = ['Observation', 'Source task', 'What remains unverified', 'Possible promotion target'];
    appliesWhen = 'Potentially useful information that is not yet sufficiently verified for stable memory.';
  } else {
    operation = 'Update the current handoff state; replace stale session state instead of accumulating an execution diary.';
    requiredStructure = ['Current goal', 'Verified facts', 'Open work or blocker', 'Next action'];
    appliesWhen = 'Current session handoff, pause state, continuation context, or unresolved work.';
  }
  return {
    kind,
    title,
    target: { kind: 'memory', scope: client.scope, data: { category: kind, status: 'captured', ...(title ? { title } : {}) } },
    existing: (await memoryReferences(client, undefined, new Set([kind === 'decision' ? 'decisions' : kind === 'pattern' ? 'patterns' : kind === 'domain' ? 'domains' : kind]), true)).filter(object => !title || String(object.data.title).toLowerCase().includes(title.toLowerCase())).map(object => ({ objectId: object.objectId, revision: object.revision, title: object.data.title, scope: object.projectId, status: object.data.status })),
    operation,
    appliesWhen,
    requiredStructure,
    guardrails: [
      'Read the fixed source revision before editing and preserve unrelated user content; patch with expectedRevision and a unique idempotencyKey.',
      'Create captured project-scoped claims through solomap_write; approval and cross-project promotion use the existing authorized review action.',
      'Keep evidence and unverified observations distinct from approved rules.',
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
    lines.push(`- Category: ${result.source}`);
    lines.push(`- Source: solomap://objects/${result.sourceRef.objectId} · revision=${result.sourceRef.revision} · content lines ${result.lineStart}-${result.lineEnd}`);
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
    '- Target: ' + JSON.stringify(payload.target),
    '- Existing sources: ' + JSON.stringify(payload.existing),
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'retrieve';
  if (args.help || command === 'help') return printHelp();
  if (command !== 'retrieve' && command !== 'route') throw new Error(`Unknown command: ${command}`);
  const projectRoot = path.resolve(args.project || process.cwd());
  const globalRoot = path.resolve(args.global || path.join(path.dirname(projectRoot), '.solomap-global'));
  const client = await openDataClient(globalRoot, projectRoot);
  try {
    const payload = command === 'retrieve'
      ? await retrieveMemory(client, projectRoot, String(args.query || ''), parseSources(args.sources), normalizeLimit(args.limit))
      : await routeMemory(client, args.kind, args.title);
    if (args.json) {
      console.log(JSON.stringify({ command, projectRoot, globalRoot, payload }, null, 2));
      return;
    }
    console.log(command === 'retrieve' ? renderMarkdown(payload) : renderRouteMarkdown(payload));
  } finally { await client.close(); }
}

main().catch(error => {
  console.error(`solomap-memory failed: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
