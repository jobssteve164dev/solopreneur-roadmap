#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_QUERIES = ['agent', 'ai', 'ai agent', 'coding agent', 'ai coding', 'roadmap', 'solomap'];
const GROWTH_QUERIES = [
  'ai',
  'agent',
  'ai agent',
  'coding agent',
  'ai coding',
  'ai coding agent',
  'ai code agent',
  'agent roadmap',
  'ai roadmap',
  'coding roadmap',
  'project roadmap',
  'claude code',
  'codex',
  'cursor agent',
  'local ai agent',
  'agent sessions',
  'agent workflow',
  'solomap'
];
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_SCAN_LIMIT = 1000;
const DEFAULT_TOP = 10;
const DEFAULT_SORT_BY = ['relevance'];
const DEFAULT_MARKETPLACES = ['openvsx'];
const MARKETPLACE_OPTIONS = new Set(['openvsx', 'vscode']);
const SORT_BY_OPTIONS = new Set([
  'relevance',
  'timestamp',
  'title',
  'publisher',
  'downloadCount',
  'publishedDate',
  'rating',
  'trendingDaily',
  'trendingWeekly',
  'trendingMonthly',
  'releaseDate',
  'author',
  'weightedRating'
]);
const OPENVSX_SORT_BY_OPTIONS = new Set(['relevance', 'timestamp', 'rating', 'downloadCount']);
const VSCODE_SORT_BY = new Map([
  ['relevance', 0],
  ['timestamp', 1],
  ['title', 2],
  ['publisher', 3],
  ['downloadCount', 4],
  ['publishedDate', 5],
  ['rating', 6],
  ['trendingDaily', 7],
  ['trendingWeekly', 8],
  ['trendingMonthly', 9],
  ['releaseDate', 10],
  ['author', 11],
  ['weightedRating', 12]
]);
const VSCODE_SORT_ORDER = new Map([
  ['default', 0],
  ['asc', 1],
  ['desc', 2]
]);

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
  const preset = argValue('--preset', 'default');
  const defaultQueries = preset === 'growth' ? GROWTH_QUERIES : DEFAULT_QUERIES;
  const sortBy = parseList(argValue('--sort-by'), DEFAULT_SORT_BY);
  const invalidSortBy = sortBy.filter((option) => !SORT_BY_OPTIONS.has(option));
  if (invalidSortBy.length > 0) {
    throw new Error(`Invalid --sort-by value: ${invalidSortBy.join(', ')}. Use one or more of: ${Array.from(SORT_BY_OPTIONS).join(', ')}`);
  }

  const marketplaces = parseList(argValue('--marketplaces'), DEFAULT_MARKETPLACES);
  const invalidMarketplaces = marketplaces.filter((option) => !MARKETPLACE_OPTIONS.has(option));
  if (invalidMarketplaces.length > 0) {
    throw new Error(`Invalid --marketplaces value: ${invalidMarketplaces.join(', ')}. Use one or more of: ${Array.from(MARKETPLACE_OPTIONS).join(', ')}`);
  }

  const sortOrder = argValue('--sort-order', 'desc');
  if (!VSCODE_SORT_ORDER.has(sortOrder)) {
    throw new Error(`Invalid --sort-order value: ${sortOrder}. Use default, asc or desc.`);
  }

  return {
    target: argValue('--target', defaultTarget),
    queries: parseList(argValue('--queries'), defaultQueries),
    preset,
    marketplaces,
    sortBy,
    sortOrder,
    pageSize: parsePositiveInt(argValue('--page-size'), DEFAULT_PAGE_SIZE),
    scanLimit: parsePositiveInt(argValue('--scan-limit'), DEFAULT_SCAN_LIMIT),
    top: parsePositiveInt(argValue('--top'), DEFAULT_TOP),
    json: hasFlag('--json')
  };
}

function openVsxSortBy(sortBy) {
  if (!OPENVSX_SORT_BY_OPTIONS.has(sortBy)) {
    throw new Error(`Open VSX does not support sortBy=${sortBy}. Use one of: ${Array.from(OPENVSX_SORT_BY_OPTIONS).join(', ')}`);
  }
  return sortBy;
}

async function searchOpenVsx(query, pageSize, offset, sortBy, sortOrder) {
  const params = new URLSearchParams({
    query,
    size: String(pageSize),
    offset: String(offset),
    sortBy: openVsxSortBy(sortBy),
    sortOrder
  });
  const response = await fetch(`https://open-vsx.org/api/-/search?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Open VSX search failed for "${query}" (${sortBy}/${sortOrder}): ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function searchVsCodeMarketplace(query, pageSize, offset, sortBy, sortOrder) {
  const pageNumber = Math.floor(offset / pageSize) + 1;
  const body = {
    filters: [
      {
        criteria: [
          { filterType: 8, value: 'Microsoft.VisualStudio.Code' },
          { filterType: 10, value: query }
        ],
        pageNumber,
        pageSize,
        sortBy: VSCODE_SORT_BY.get(sortBy),
        sortOrder: VSCODE_SORT_ORDER.get(sortOrder)
      }
    ],
    assetTypes: [],
    flags: 256 | 512 | 1024
  };

  const response = await fetch('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
    method: 'POST',
    headers: {
      accept: 'application/json;api-version=7.2-preview.1',
      'content-type': 'application/json',
      'user-agent': 'solomap-marketplace-rank'
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`VS Code Marketplace search failed for "${query}" (${sortBy}/${sortOrder}): ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const result = json.results?.[0] || {};
  const totalSize = result.resultMetadata
    ?.find((metadata) => metadata.metadataType === 'ResultCount')
    ?.metadataItems?.[0]?.count || 0;
  return {
    totalSize,
    extensions: result.extensions || []
  };
}

function extensionId(extension, marketplace) {
  if (marketplace === 'vscode') {
    return `${extension.publisher?.publisherName}.${extension.extensionName}`;
  }
  return `${extension.namespace}.${extension.name}`;
}

function extensionStat(extension, name) {
  return extension.statistics?.find((stat) => stat.statisticName === name)?.value || 0;
}

function summarizeExtension(extension, rank, marketplace) {
  if (marketplace === 'vscode') {
    return {
      rank,
      id: extensionId(extension, marketplace),
      name: extension.extensionName || '',
      publisher: extension.publisher?.publisherName || '',
      displayName: extension.displayName || '',
      description: extension.shortDescription || '',
      version: extension.versions?.[0]?.version || '',
      downloads: extensionStat(extension, 'install'),
      rating: extensionStat(extension, 'averagerating'),
      ratingCount: extensionStat(extension, 'ratingcount'),
      verified: Boolean(extension.publisher?.isVerified),
      updated: extension.lastUpdated || ''
    };
  }

  return {
    rank,
    id: extensionId(extension, marketplace),
    name: extension.name || '',
    publisher: extension.namespace || '',
    displayName: extension.displayName || '',
    description: extension.description || '',
    version: extension.version || '',
    downloads: extension.downloadCount || 0,
    verified: Boolean(extension.verified)
  };
}

async function searchMarketplace(marketplace, query, pageSize, offset, sortBy, sortOrder) {
  if (marketplace === 'vscode') {
    return searchVsCodeMarketplace(query, pageSize, offset, sortBy, sortOrder);
  }
  return searchOpenVsx(query, pageSize, offset, sortBy, sortOrder);
}

async function rankQuery(marketplace, query, sortBy, config) {
  const firstPage = await searchMarketplace(marketplace, query, config.pageSize, 0, sortBy, config.sortOrder);
  const targetLower = config.target.toLowerCase();
  const totalSize = firstPage.totalSize || 0;
  const scanLimit = Math.min(totalSize, config.scanLimit);
  let found = null;

  for (let offset = 0; offset < scanLimit; offset += config.pageSize) {
    const page = offset === 0 ? firstPage : await searchMarketplace(marketplace, query, config.pageSize, offset, sortBy, config.sortOrder);
    const index = page.extensions.findIndex((extension) => extensionId(extension, marketplace).toLowerCase() === targetLower);
    if (index >= 0) {
      found = summarizeExtension(page.extensions[index], offset + index + 1, marketplace);
      break;
    }
  }

  const top = firstPage.extensions.slice(0, config.top).map((extension, index) => summarizeExtension(extension, index + 1, marketplace));

  return {
    marketplace,
    query,
    sortBy,
    sortOrder: config.sortOrder,
    total: totalSize,
    scanned: scanLimit,
    rank: found ? found.rank : null,
    found,
    top,
    topDownloads: top.reduce((sum, extension) => sum + extension.downloads, 0),
    topVerified: top.filter((extension) => extension.verified).length
  };
}

function printTextReport(config, results) {
  console.log(`Target: ${config.target}`);
  console.log(`Preset: ${config.preset}`);
  console.log(`Marketplaces: ${config.marketplaces.join(', ')}`);
  console.log(`Scanned per query: ${config.scanLimit}`);
  console.log(`Sort by: ${config.sortBy.join(', ')} (${config.sortOrder})`);
  console.log('');

  for (const result of results) {
    const rankText = result.rank ? `#${result.rank} / ${result.total}` : `not found in first ${result.scanned} / ${result.total}`;
    console.log(`## ${result.marketplace} · ${result.query} [${result.sortBy}/${result.sortOrder}]: ${rankText}`);
    if (result.found) {
      console.log(`Found: ${result.found.displayName} (${result.found.id})`);
      console.log(`Version: ${result.found.version} | Downloads/Installs: ${result.found.downloads} | Verified: ${result.found.verified}`);
    }
    console.log(`Top ${result.top.length} downloads/installs sum: ${result.topDownloads}`);
    console.log('Top results:');
    for (const item of result.top) {
      console.log(`${String(item.rank).padStart(2, ' ')}. ${item.displayName} (${item.id}) - ${item.downloads} downloads/installs`);
    }
    console.log('');
  }
}

async function main() {
  const config = getConfig();
  const results = [];
  for (const marketplace of config.marketplaces) {
    for (const query of config.queries) {
      for (const sortBy of config.sortBy) {
        results.push(await rankQuery(marketplace, query, sortBy, config));
      }
    }
  }

  if (config.json) {
    console.log(JSON.stringify({
      target: config.target,
      preset: config.preset,
      marketplaces: config.marketplaces,
      sortOrder: config.sortOrder,
      results
    }, null, 2));
    return;
  }

  printTextReport(config, results);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
