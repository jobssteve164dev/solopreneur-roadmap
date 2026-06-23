#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_QUERIES = ['agent', 'ai', 'ai agent', 'coding agent', 'ai coding', 'roadmap', 'solomap'];
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_SCAN_LIMIT = 1000;
const DEFAULT_TOP = 10;
const DEFAULT_SORT_BY = ['relevance'];
const SORT_BY_OPTIONS = new Set(['relevance', 'timestamp', 'rating', 'downloadCount']);

function readPackageJson() {
  const packagePath = path.resolve(__dirname, '..', 'package.json');
  return JSON.parse(fs.readFileSync(packagePath, 'utf8'));
}

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function parseList(value, fallback) {
  if (!value) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInt(value, fallback) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getConfig() {
  const packageJson = readPackageJson();
  const defaultTarget = `${packageJson.publisher}.${packageJson.name}`;
  const sortBy = parseList(argValue('--sort-by'), DEFAULT_SORT_BY);
  const invalidSortBy = sortBy.filter((option) => !SORT_BY_OPTIONS.has(option));
  if (invalidSortBy.length > 0) {
    throw new Error(`Invalid --sort-by value: ${invalidSortBy.join(', ')}. Use one or more of: ${Array.from(SORT_BY_OPTIONS).join(', ')}`);
  }

  return {
    target: argValue('--target', defaultTarget),
    queries: parseList(argValue('--queries'), DEFAULT_QUERIES),
    sortBy,
    sortOrder: argValue('--sort-order', 'desc'),
    pageSize: parsePositiveInt(argValue('--page-size'), DEFAULT_PAGE_SIZE),
    scanLimit: parsePositiveInt(argValue('--scan-limit'), DEFAULT_SCAN_LIMIT),
    top: parsePositiveInt(argValue('--top'), DEFAULT_TOP),
    json: hasFlag('--json')
  };
}

async function searchOpenVsx(query, pageSize, offset, sortBy, sortOrder) {
  const params = new URLSearchParams({
    query,
    size: String(pageSize),
    offset: String(offset),
    sortBy,
    sortOrder
  });
  const response = await fetch(`https://open-vsx.org/api/-/search?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Open VSX search failed for "${query}" (${sortBy}/${sortOrder}): ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function extensionId(extension) {
  return `${extension.namespace}.${extension.name}`;
}

function summarizeExtension(extension, rank) {
  return {
    rank,
    id: extensionId(extension),
    displayName: extension.displayName || '',
    description: extension.description || '',
    version: extension.version || '',
    downloads: extension.downloadCount || 0,
    verified: Boolean(extension.verified)
  };
}

async function rankQuery(query, sortBy, config) {
  const firstPage = await searchOpenVsx(query, config.pageSize, 0, sortBy, config.sortOrder);
  const targetLower = config.target.toLowerCase();
  const totalSize = firstPage.totalSize || 0;
  const scanLimit = Math.min(totalSize, config.scanLimit);
  let found = null;

  for (let offset = 0; offset < scanLimit; offset += config.pageSize) {
    const page = offset === 0 ? firstPage : await searchOpenVsx(query, config.pageSize, offset, sortBy, config.sortOrder);
    const index = page.extensions.findIndex((extension) => extensionId(extension).toLowerCase() === targetLower);
    if (index >= 0) {
      found = summarizeExtension(page.extensions[index], offset + index + 1);
      break;
    }
  }

  return {
    query,
    sortBy,
    sortOrder: config.sortOrder,
    total: totalSize,
    scanned: scanLimit,
    rank: found ? found.rank : null,
    found,
    top: firstPage.extensions.slice(0, config.top).map((extension, index) => summarizeExtension(extension, index + 1))
  };
}

function printTextReport(config, results) {
  console.log(`Target: ${config.target}`);
  console.log(`Scanned per query: ${config.scanLimit}`);
  console.log(`Sort by: ${config.sortBy.join(', ')} (${config.sortOrder})`);
  console.log('');

  for (const result of results) {
    const rankText = result.rank ? `#${result.rank} / ${result.total}` : `not found in first ${result.scanned} / ${result.total}`;
    console.log(`## ${result.query} [${result.sortBy}/${result.sortOrder}]: ${rankText}`);
    if (result.found) {
      console.log(`Found: ${result.found.displayName} (${result.found.id})`);
      console.log(`Version: ${result.found.version} | Downloads: ${result.found.downloads} | Verified: ${result.found.verified}`);
    }
    console.log('Top results:');
    for (const item of result.top) {
      console.log(`${String(item.rank).padStart(2, ' ')}. ${item.displayName} (${item.id}) - ${item.downloads} downloads`);
    }
    console.log('');
  }
}

async function main() {
  const config = getConfig();
  const results = [];
  for (const query of config.queries) {
    for (const sortBy of config.sortBy) {
      results.push(await rankQuery(query, sortBy, config));
    }
  }

  if (config.json) {
    console.log(JSON.stringify({ target: config.target, sortOrder: config.sortOrder, results }, null, 2));
    return;
  }

  printTextReport(config, results);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
