import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { SqliteStore } from './db/sqliteStore';
import {
  GrowthEdgeRecord,
  GrowthModuleLabelRecord,
  GrowthNodeRecord,
  GrowthSignalRecord,
  GrowthSnapshotData,
  GrowthSnapshotRecord,
  RoadmapNode,
  RunIndexEntry
} from './db/types';

export interface ProjectGrowthScanOptions {
  scanReason?: string;
  maxFiles?: number;
  now?: Date;
  refreshIfMissing?: boolean;
  forceRefresh?: boolean;
  historyLimit?: number;
}

export interface ProjectGrowthSummaryNode {
  id: string;
  label: string;
  kind: string;
  path: string;
  sizeWeight: number;
  colorSignal: 'stable' | 'growing' | 'watch' | 'attention' | 'blocked';
  status: string;
  children: ProjectGrowthSummaryNode[];
}

export interface ProjectGrowthGap {
  nodeId: string;
  label: string;
  level: string;
  value: string;
  source: string;
}

export interface ProjectGrowthTimelineItem {
  snapshotId: string;
  createdAt: string;
  scanReason: string;
  gitHead: string;
  totals: ProjectGrowthTotals;
}

export interface ProjectGrowthDiff {
  fromSnapshotId: string;
  toSnapshotId: string;
  filesAdded: number;
  filesRemoved: number;
  filesChanged: number;
  locDelta: number;
  modulesAdded: number;
  modulesRemoved: number;
  capabilitiesAdded: number;
  capabilitiesRemoved: number;
  signalsAdded: number;
  signalsResolved: number;
}

export interface ProjectGrowthModuleSummary {
  nodeId: string;
  label: string;
  role: string;
  loc: number;
  files: number;
  tests: number;
  signal: ProjectGrowthSummaryNode['colorSignal'];
  confidence: number;
}

export interface ProjectGrowthCapabilitySummary {
  nodeId: string;
  label: string;
  stage: string;
  modules: string[];
  signal: ProjectGrowthSummaryNode['colorSignal'];
}

export interface ProjectGrowthEdgeSummary {
  sourceId: string;
  targetId: string;
  kind: string;
  weight: number;
  evidence: string;
}

export interface ProjectGrowthTotals {
  files: number;
  modules: number;
  capabilities: number;
  packages: number;
  loc: number;
  signals: number;
}

export interface ProjectGrowthInsightSummary {
  headline: string;
  body: string;
  healthLabel: string;
  focusLabel: string;
  evidenceLabel: string;
}

export interface ProjectGrowthCapabilityHealth {
  nodeId: string;
  label: string;
  stage: string;
  status: string;
  summary: string;
  action: string;
  modules: string[];
  evidence: string[];
  signal: ProjectGrowthSummaryNode['colorSignal'];
  roadmapStatus: string;
  description: string;
}

export interface ProjectGrowthStageSummary {
  label: string;
  completed: number;
  active: number;
  pending: number;
  total: number;
  status: string;
}

export interface ProjectGrowthOrientation {
  purpose: string;
  currentStage: string;
  currentStep: string;
  currentStepStatus: string;
  completedSteps: number;
  totalSteps: number;
  stages: ProjectGrowthStageSummary[];
}

export interface ProjectGrowthFocusArea {
  nodeId: string;
  label: string;
  status: string;
  summary: string;
  action: string;
  files: number;
  loc: number;
  tests: number;
  confidence: number;
  evidence: string[];
}

export interface ProjectGrowthRecommendedAction {
  title: string;
  detail: string;
  target: string;
  level: string;
  source: string;
}

export interface ProjectGrowthViewModel {
  snapshotId: string;
  generatedAt: string;
  projectPath: string;
  orientation: ProjectGrowthOrientation;
  insight: ProjectGrowthInsightSummary;
  capabilityHealth: ProjectGrowthCapabilityHealth[];
  focusAreas: ProjectGrowthFocusArea[];
  recommendedActions: ProjectGrowthRecommendedAction[];
  treemap: ProjectGrowthSummaryNode | null;
  gaps: ProjectGrowthGap[];
  modules: ProjectGrowthModuleSummary[];
  capabilities: ProjectGrowthCapabilitySummary[];
  keyEdges: ProjectGrowthEdgeSummary[];
  history: ProjectGrowthTimelineItem[];
  diff: ProjectGrowthDiff | null;
  totals: ProjectGrowthTotals;
}

interface FileFact {
  relativePath: string;
  absolutePath: string;
  parentPath: string;
  language: string;
  bytes: number;
  loc: number;
  generated: boolean;
  excluded: boolean;
  isTest: boolean;
  testItemCount: number;
  role: string;
}

interface ModuleFact {
  id: string;
  label: string;
  role: string;
  paths: Set<string>;
  loc: number;
  bytes: number;
  fileCount: number;
  testFileCount: number;
  changedRunCount: number;
  touchedRunCount: number;
  verificationCount: number;
  failureCount: number;
  latestRunAt: string;
  roadmapNodeIds: Set<string>;
}

const ignoredDirectoryNames = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage',
  '.turbo',
  '.codegraph'
]);

const generatedPathPatterns = [
  /(^|\/)node_modules\//,
  /(^|\/)out\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)\.next\//,
  /(^|\/)\.solopreneur\/agent-runs\//,
  /\.map$/i,
  /\.log$/i,
  /\.db(?:-journal)?$/i,
  /package-lock\.json$/i,
  /pnpm-lock\.yaml$/i,
  /bun\.lockb?$/i
];

const importRegex = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function normalizeRelativePath(projectPath: string, filePath: string): string {
  return toPosixPath(path.relative(projectPath, filePath));
}

function languageForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts') return 'typescript';
  if (ext === '.tsx') return 'tsx';
  if (ext === '.js') return 'javascript';
  if (ext === '.jsx') return 'jsx';
  if (ext === '.json') return 'json';
  if (ext === '.md' || ext === '.mdx') return 'markdown';
  if (ext === '.css') return 'css';
  if (ext === '.html') return 'html';
  if (ext === '.yml' || ext === '.yaml') return 'yaml';
  if (ext === '.cjs' || ext === '.mjs') return 'javascript';
  return ext.replace(/^\./, '') || 'unknown';
}

function isTextLikeFile(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|cjs|mjs|json|md|mdx|css|html|yml|yaml|txt|csv|svg)$/i.test(filePath);
}

function countLines(filePath: string, maxBytes = 512 * 1024): number {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes || !isTextLikeFile(filePath)) {
      return 0;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return content ? content.split(/\r?\n/).length : 0;
  } catch {
    return 0;
  }
}

function countTestItems(filePath: string, maxBytes = 512 * 1024): number {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes || !/\.[cm]?[jt]sx?$/i.test(filePath)) {
      return 0;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const directTests = content.match(/(?:^|[^\w$.])(?:test|it)\s*\(/gm) || [];
    const qualifiedTests = content.match(/(?:^|[^\w$.])(?:test|it)\.(?:only|skip|todo)\s*\(/gm) || [];
    return directTests.length + qualifiedTests.length;
  } catch {
    return 0;
  }
}

function isGeneratedOrExcluded(relativePath: string): boolean {
  return generatedPathPatterns.some((pattern) => pattern.test(relativePath));
}

function packageNameFromSpecifier(specifier: string): string {
  const value = String(specifier || '').trim();
  if (!value || value.startsWith('.') || value.startsWith('/') || value.startsWith('node:')) {
    return '';
  }
  const parts = value.split('/');
  return value.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function roleForPath(relativePath: string): string {
  if (/^docs\//.test(relativePath) || /\.mdx?$/i.test(relativePath)) return 'knowledge';
  if (/^(test|tests)\//.test(relativePath) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(relativePath)) return 'verification';
  if (/^src\/db\//.test(relativePath)) return 'data';
  if (/webview/i.test(relativePath) || /Webview/.test(relativePath)) return 'interface';
  if (/^src\/(agent|run|flow|learning|projectGrowth)/i.test(relativePath)) return 'execution';
  if (/^src\/.*(sidebar|roadmap|strategy)/i.test(relativePath)) return 'product-ui';
  if (/^resources\//.test(relativePath)) return 'runtime-resource';
  if (/^\.github\//.test(relativePath)) return 'delivery';
  if (/package\.json$|tsconfig\.json$|\.ya?ml$/i.test(relativePath)) return 'configuration';
  return 'implementation';
}

function moduleForPath(relativePath: string): { id: string; label: string; role: string; confidence: number } {
  const rules: Array<{ pattern: RegExp; id: string; label: string; role: string; confidence: number }> = [
    { pattern: /^src\/db\//, id: 'module:data-layer', label: '数据层', role: 'data', confidence: 0.9 },
    { pattern: /^src\/.*Webview\.ts$/, id: 'module:webview-ui', label: 'Webview 界面层', role: 'interface', confidence: 0.86 },
    { pattern: /^src\/sidebar/i, id: 'module:sidebar-cockpit', label: '侧边栏驾驶舱', role: 'product-ui', confidence: 0.86 },
    { pattern: /^src\/roadmap/i, id: 'module:roadmap-cockpit', label: '路线图大图', role: 'product-ui', confidence: 0.86 },
    { pattern: /^src\/(agent|run|flow|learning|conversation|projectGrowth)/i, id: 'module:agent-execution', label: 'Agent 执行与经验层', role: 'execution', confidence: 0.82 },
    { pattern: /^src\/strategy/i, id: 'module:strategy-pyramid', label: '战略驾驶舱', role: 'product-ui', confidence: 0.82 },
    { pattern: /^src\//, id: 'module:extension-host', label: '插件宿主与业务逻辑', role: 'extension-host', confidence: 0.65 },
    { pattern: /^(test|tests)\//, id: 'module:verification', label: '验证回归层', role: 'verification', confidence: 0.9 },
    { pattern: /^docs\//, id: 'module:project-knowledge', label: '项目知识层', role: 'knowledge', confidence: 0.9 },
    { pattern: /^resources\//, id: 'module:runtime-resources', label: '运行资源层', role: 'runtime-resource', confidence: 0.82 },
    { pattern: /^website\//, id: 'module:website', label: '官网与市场页面', role: 'website', confidence: 0.86 },
    { pattern: /^\.github\//, id: 'module:delivery-automation', label: '交付自动化', role: 'delivery', confidence: 0.88 }
  ];
  const matched = rules.find((rule) => rule.pattern.test(relativePath));
  if (matched) {
    return matched;
  }
  const top = relativePath.split('/')[0] || 'project';
  return {
    id: `module:${top}`,
    label: top,
    role: roleForPath(relativePath),
    confidence: 0.45
  };
}

function readGitHead(projectPath: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: projectPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

function readGitChurn(projectPath: string): Map<string, number> {
  const result = new Map<string, number>();
  try {
    const output = execFileSync('git', ['log', '--name-only', '--pretty=format:', '--since=90 days'], {
      cwd: projectPath,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    for (const line of output.split(/\r?\n/)) {
      const file = toPosixPath(line.trim());
      if (!file || isGeneratedOrExcluded(file)) {
        continue;
      }
      result.set(file, (result.get(file) || 0) + 1);
    }
  } catch {
    // Git is an optional evolution signal.
  }
  return result;
}

function walkProjectFiles(projectPath: string, maxFiles: number): FileFact[] {
  const result: FileFact[] = [];
  const visit = (dir: string) => {
    if (result.length >= maxFiles) {
      return;
    }
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.length >= maxFiles) {
        break;
      }
      const absolute = path.join(dir, entry);
      const relative = normalizeRelativePath(projectPath, absolute);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absolute);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!ignoredDirectoryNames.has(entry)) {
          visit(absolute);
        }
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }
      const excluded = isGeneratedOrExcluded(relative);
      const isTest = /(^|\/)(test|tests)\//.test(relative) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(relative);
      const testItemCount = isTest && !excluded ? countTestItems(absolute) : 0;
      result.push({
        relativePath: relative,
        absolutePath: absolute,
        parentPath: toPosixPath(path.dirname(relative)) === '.' ? '' : toPosixPath(path.dirname(relative)),
        language: languageForFile(relative),
        bytes: stat.size,
        loc: excluded ? 0 : countLines(absolute),
        generated: excluded,
        excluded,
        isTest,
        testItemCount,
        role: roleForPath(relative)
      });
    }
  };
  visit(projectPath);
  return result;
}

function nodeIdForPath(kind: 'file' | 'directory', relativePath: string): string {
  return `${kind}:${relativePath || '.'}`;
}

function ensureDirectoryNodes(
  snapshotId: string,
  files: FileFact[],
  nodes: Map<string, GrowthNodeRecord>,
  edges: GrowthEdgeRecord[]
): void {
  const addDirectory = (dirPath: string) => {
    const normalized = dirPath || '.';
    const nodeId = nodeIdForPath('directory', normalized === '.' ? '' : normalized);
    if (nodes.has(nodeId)) {
      return;
    }
    const parentPath = normalized === '.'
      ? ''
      : (toPosixPath(path.dirname(normalized)) === '.' ? '' : toPosixPath(path.dirname(normalized)));
    nodes.set(nodeId, {
      snapshotId,
      nodeId,
      parentId: normalized === '.' ? '' : nodeIdForPath('directory', parentPath),
      kind: 'directory',
      path: normalized === '.' ? '' : normalized,
      label: normalized === '.' ? 'Project' : path.basename(normalized),
      language: '',
      bytes: 0,
      loc: 0,
      fileCount: 0,
      testFileCount: 0,
      generated: false,
      excluded: false,
      primaryRole: '',
      confidence: 1
    });
    if (normalized !== '.') {
      addDirectory(parentPath);
      edges.push({
        snapshotId,
        sourceId: nodeIdForPath('directory', parentPath),
        targetId: nodeId,
        kind: 'contains',
        weight: 1,
        evidence: 'filesystem'
      });
    }
  };

  addDirectory('');
  for (const file of files) {
    addDirectory(file.parentPath);
    const parts = file.parentPath ? file.parentPath.split('/') : [];
    for (let index = 1; index <= parts.length; index++) {
      addDirectory(parts.slice(0, index).join('/'));
    }
  }
}

function addFileNodes(
  snapshotId: string,
  files: FileFact[],
  nodes: Map<string, GrowthNodeRecord>,
  edges: GrowthEdgeRecord[]
): void {
  for (const file of files) {
    const nodeId = nodeIdForPath('file', file.relativePath);
    nodes.set(nodeId, {
      snapshotId,
      nodeId,
      parentId: nodeIdForPath('directory', file.parentPath),
      kind: 'file',
      path: file.relativePath,
      label: path.basename(file.relativePath),
      language: file.language,
      bytes: file.bytes,
      loc: file.loc,
      fileCount: file.excluded ? 0 : 1,
      testFileCount: file.isTest && !file.excluded ? Math.max(1, file.testItemCount) : 0,
      generated: file.generated,
      excluded: file.excluded,
      primaryRole: file.role,
      confidence: 1
    });
    edges.push({
      snapshotId,
      sourceId: nodeIdForPath('directory', file.parentPath),
      targetId: nodeId,
      kind: 'contains',
      weight: Math.max(1, file.loc || file.bytes),
      evidence: 'filesystem'
    });
  }
}

function aggregateDirectoryMetrics(nodes: Map<string, GrowthNodeRecord>): void {
  const directories = [...nodes.values()]
    .filter((node) => node.kind === 'directory')
    .sort((a, b) => b.path.length - a.path.length);
  for (const directory of directories) {
    const prefix = directory.path ? `${directory.path}/` : '';
    let bytes = 0;
    let loc = 0;
    let fileCount = 0;
    let testFileCount = 0;
    for (const node of nodes.values()) {
      if (node.kind !== 'file' || node.excluded) {
        continue;
      }
      if (!directory.path || node.path.startsWith(prefix)) {
        bytes += node.bytes;
        loc += node.loc;
        fileCount += 1;
        testFileCount += node.testFileCount;
      }
    }
    directory.bytes = bytes;
    directory.loc = loc;
    directory.fileCount = fileCount;
    directory.testFileCount = testFileCount;
    directory.primaryRole = inferDominantRole(nodes, directory.path);
  }
}

function inferDominantRole(nodes: Map<string, GrowthNodeRecord>, directoryPath: string): string {
  const counts = new Map<string, number>();
  const prefix = directoryPath ? `${directoryPath}/` : '';
  for (const node of nodes.values()) {
    if (node.kind !== 'file' || node.excluded || (directoryPath && !node.path.startsWith(prefix))) {
      continue;
    }
    counts.set(node.primaryRole, (counts.get(node.primaryRole) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

function resolveImportTarget(projectPath: string, sourceRelativePath: string, specifier: string, fileSet: Set<string>): string {
  if (!specifier.startsWith('.')) {
    return '';
  }
  const sourceDir = path.dirname(path.join(projectPath, sourceRelativePath));
  const base = path.resolve(sourceDir, specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.cjs`,
    `${base}.mjs`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx')
  ];
  for (const candidate of candidates) {
    const relative = normalizeRelativePath(projectPath, candidate);
    if (fileSet.has(relative)) {
      return relative;
    }
  }
  return '';
}

function addImportEdges(
  projectPath: string,
  snapshotId: string,
  files: FileFact[],
  nodes: Map<string, GrowthNodeRecord>,
  edges: GrowthEdgeRecord[]
): void {
  const fileSet = new Set(files.map((file) => file.relativePath));
  const fileByPath = new Map(files.map((file) => [file.relativePath, file]));
  for (const file of files) {
    if (file.excluded || !/\.[cm]?[jt]sx?$/.test(file.relativePath)) {
      continue;
    }
    let content = '';
    try {
      if (fs.statSync(file.absolutePath).size > 512 * 1024) {
        continue;
      }
      content = fs.readFileSync(file.absolutePath, 'utf8');
    } catch {
      continue;
    }
    importRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content))) {
      const specifier = match[1] || match[2] || '';
      const packageName = packageNameFromSpecifier(specifier);
      if (packageName) {
        const packageNodeId = `package:${packageName}`;
        if (!nodes.has(packageNodeId)) {
          nodes.set(packageNodeId, {
            snapshotId,
            nodeId: packageNodeId,
            parentId: 'directory:.',
            kind: 'package',
            path: packageName,
            label: packageName,
            language: '',
            bytes: 0,
            loc: 0,
            fileCount: 0,
            testFileCount: 0,
            generated: false,
            excluded: false,
            primaryRole: 'dependency',
            confidence: 0.82
          });
        }
        edges.push({
          snapshotId,
          sourceId: nodeIdForPath('file', file.relativePath),
          targetId: packageNodeId,
          kind: 'depends_on',
          weight: 1,
          evidence: specifier
        });
        continue;
      }
      const target = resolveImportTarget(projectPath, file.relativePath, specifier, fileSet);
      if (!target) {
        continue;
      }
      const targetFile = fileByPath.get(target);
      edges.push({
        snapshotId,
        sourceId: nodeIdForPath('file', file.relativePath),
        targetId: nodeIdForPath('file', target),
        kind: 'imports',
        weight: 1,
        evidence: specifier
      });
      if (file.isTest && targetFile && !targetFile.isTest) {
        edges.push({
          snapshotId,
          sourceId: nodeIdForPath('file', target),
          targetId: nodeIdForPath('file', file.relativePath),
          kind: 'tested_by',
          weight: 1,
          evidence: specifier
        });
      }
    }
  }
}

function buildRunFileMaps(runEntries: RunIndexEntry[]): {
  byFile: Map<string, RunIndexEntry[]>;
  verificationByRun: Map<number, number>;
  failureByRun: Map<number, number>;
} {
  const byFile = new Map<string, RunIndexEntry[]>();
  const verificationByRun = new Map<number, number>();
  const failureByRun = new Map<number, number>();
  for (const run of runEntries) {
    const executionLogId = Number(run.executionLogId || 0);
    verificationByRun.set(executionLogId, run.signals.filter((signal) => signal.type === 'verification').length);
    failureByRun.set(executionLogId, run.signals.filter((signal) => signal.type === 'failure').length);
    for (const file of run.files) {
      const filePath = toPosixPath(String(file.filePath || '').trim());
      if (!filePath || isGeneratedOrExcluded(filePath)) {
        continue;
      }
      const list = byFile.get(filePath) || [];
      list.push(run);
      byFile.set(filePath, list);
    }
  }
  return { byFile, verificationByRun, failureByRun };
}

function ensureModule(
  snapshotId: string,
  modules: Map<string, ModuleFact>,
  moduleInfo: { id: string; label: string; role: string }
): ModuleFact {
  const existing = modules.get(moduleInfo.id);
  if (existing) {
    return existing;
  }
  const created: ModuleFact = {
    id: moduleInfo.id,
    label: moduleInfo.label,
    role: moduleInfo.role,
    paths: new Set(),
    loc: 0,
    bytes: 0,
    fileCount: 0,
    testFileCount: 0,
    changedRunCount: 0,
    touchedRunCount: 0,
    verificationCount: 0,
    failureCount: 0,
    latestRunAt: '',
    roadmapNodeIds: new Set()
  };
  modules.set(moduleInfo.id, created);
  return created;
}

function addModuleAndCapabilityNodes(
  snapshotId: string,
  files: FileFact[],
  roadmapNodes: RoadmapNode[],
  runEntries: RunIndexEntry[],
  nodes: Map<string, GrowthNodeRecord>,
  edges: GrowthEdgeRecord[],
  signals: GrowthSignalRecord[],
  labels: GrowthModuleLabelRecord[],
  nowIso: string
): void {
  const { byFile, verificationByRun, failureByRun } = buildRunFileMaps(runEntries);
  const modules = new Map<string, ModuleFact>();
  const roadmapById = new Map(roadmapNodes.map((node) => [node.id, node]));
  const fileToModule = new Map<string, string>();
  const moduleConfidence = new Map<string, number>();

  for (const file of files) {
    if (file.excluded) {
      continue;
    }
    const moduleInfo = moduleForPath(file.relativePath);
    moduleConfidence.set(moduleInfo.id, Math.max(moduleConfidence.get(moduleInfo.id) || 0, moduleInfo.confidence));
    const module = ensureModule(snapshotId, modules, moduleInfo);
    module.paths.add(file.relativePath);
    module.loc += file.loc;
    module.bytes += file.bytes;
    module.fileCount += 1;
    module.testFileCount += file.isTest ? Math.max(1, file.testItemCount) : 0;
    fileToModule.set(file.relativePath, module.id);
    const runs = byFile.get(file.relativePath) || [];
    for (const run of runs) {
      const role = run.files.find((item) => toPosixPath(String(item.filePath || '')) === file.relativePath)?.role || '';
      if (role === 'changed') module.changedRunCount += 1;
      if (role === 'touched') module.touchedRunCount += 1;
      module.verificationCount += verificationByRun.get(Number(run.executionLogId || 0)) || 0;
      module.failureCount += failureByRun.get(Number(run.executionLogId || 0)) || 0;
      if (run.nodeId) {
        module.roadmapNodeIds.add(run.nodeId);
      }
      if (run.finishedAt && (!module.latestRunAt || Date.parse(run.finishedAt) > Date.parse(module.latestRunAt))) {
        module.latestRunAt = run.finishedAt;
      }
    }
  }

  for (const module of modules.values()) {
    nodes.set(module.id, {
      snapshotId,
      nodeId: module.id,
      parentId: 'directory:.',
      kind: 'module',
      path: [...module.paths].sort()[0] || '',
      label: module.label,
      language: '',
      bytes: module.bytes,
      loc: module.loc,
      fileCount: module.fileCount,
      testFileCount: module.testFileCount,
      generated: false,
      excluded: false,
      primaryRole: module.role,
      confidence: moduleConfidence.get(module.id) || 0.5
    });
    labels.push({
      snapshotId,
      nodeId: module.id,
      label: module.label,
      role: module.role,
      source: 'rule',
      confidence: moduleConfidence.get(module.id) || 0.5,
      updatedAt: nowIso
    });
    for (const filePath of module.paths) {
      edges.push({
        snapshotId,
        sourceId: module.id,
        targetId: nodeIdForPath('file', filePath),
        kind: 'contains',
        weight: 1,
        evidence: 'module-rule'
      });
    }
    if (module.changedRunCount || module.touchedRunCount) {
      signals.push({
        snapshotId,
        nodeId: module.id,
        type: 'activity',
        level: module.changedRunCount >= 3 ? 'attention' : 'info',
        value: `最近 Agent 运行触碰 ${module.changedRunCount + module.touchedRunCount} 次`,
        source: 'run_index',
        sourceRef: module.latestRunAt,
        createdAt: nowIso
      });
    }
    if (module.failureCount > 0) {
      signals.push({
        snapshotId,
        nodeId: module.id,
        type: 'failure',
        level: module.failureCount >= 2 ? 'blocked' : 'attention',
        value: `关联运行包含 ${module.failureCount} 条失败信号`,
        source: 'run_index',
        sourceRef: module.latestRunAt,
        createdAt: nowIso
      });
    }
    if ((module.changedRunCount + module.touchedRunCount) > 0 && module.verificationCount === 0) {
      signals.push({
        snapshotId,
        nodeId: module.id,
        type: 'risk',
        level: 'watch',
        value: '最近被 Agent 触碰，但缺少验证信号',
        source: 'growth_rules',
        sourceRef: module.latestRunAt,
        createdAt: nowIso
      });
    }
    if (module.loc >= 1600 && module.testFileCount === 0) {
      signals.push({
        snapshotId,
        nodeId: module.id,
        type: 'risk',
        level: 'attention',
        value: '模块体量较大且未识别到测试文件',
        source: 'growth_rules',
        sourceRef: module.id,
        createdAt: nowIso
      });
    }
  }

  for (const roadmapNode of roadmapNodes) {
    const nodeId = roadmapNode.id;
    const capabilityId = `capability:roadmap:${nodeId}`;
    nodes.set(capabilityId, {
      snapshotId,
      nodeId: capabilityId,
      parentId: '',
      kind: 'capability',
      path: '',
      label: roadmapNode.title || nodeId,
      language: '',
      bytes: 0,
      loc: 0,
      fileCount: 0,
      testFileCount: 0,
      generated: false,
      excluded: false,
      primaryRole: roadmapNode.stage || 'roadmap',
      confidence: 0.78
    });
    labels.push({
      snapshotId,
      nodeId: capabilityId,
      label: roadmapNode.title || nodeId,
      role: roadmapNode.stage || 'roadmap',
      source: 'roadmap',
      confidence: 0.78,
      updatedAt: nowIso
    });
    signals.push({
      snapshotId,
      nodeId: capabilityId,
      type: 'roadmap_context',
      level: 'info',
      value: roadmapNode.description || '',
      source: 'roadmap',
      sourceRef: roadmapNode.status || 'Pending',
      createdAt: nowIso
    });
    for (const dependencyId of String(roadmapNode.dependencies || '').split(',').map((value) => value.trim()).filter(Boolean)) {
      if (!roadmapById.has(dependencyId)) continue;
      edges.push({
        snapshotId,
        sourceId: `capability:roadmap:${dependencyId}`,
        targetId: capabilityId,
        kind: 'precedes',
        weight: 1,
        evidence: 'roadmap:dependencies'
      });
    }
  }

  for (const module of modules.values()) {
    for (const roadmapNodeId of module.roadmapNodeIds) {
      const capabilityId = `capability:roadmap:${roadmapNodeId}`;
      if (!nodes.has(capabilityId)) {
        continue;
      }
      edges.push({
        snapshotId,
        sourceId: module.id,
        targetId: capabilityId,
        kind: 'implements',
        weight: 1,
        evidence: 'run_index:nodeId'
      });
      edges.push({
        snapshotId,
        sourceId: module.id,
        targetId: capabilityId,
        kind: 'belongs_to_step',
        weight: 1,
        evidence: roadmapNodeId
      });
    }
  }

  for (const [filePath, runs] of byFile.entries()) {
    const fileNodeId = nodeIdForPath('file', filePath);
    if (!nodes.has(fileNodeId)) {
      continue;
    }
    const moduleId = fileToModule.get(filePath);
    const latestRun = runs
      .slice()
      .sort((a, b) => Date.parse(String(b.finishedAt || b.startedAt || '')) - Date.parse(String(a.finishedAt || a.startedAt || '')))[0];
    signals.push({
      snapshotId,
      nodeId: fileNodeId,
      type: 'activity',
      level: runs.length >= 3 ? 'attention' : 'info',
      value: `被 ${runs.length} 次 Agent 运行触碰`,
      source: 'run_index',
      sourceRef: latestRun ? String(latestRun.executionLogId || '') : '',
      createdAt: nowIso
    });
    if (moduleId) {
      edges.push({
        snapshotId,
        sourceId: moduleId,
        targetId: fileNodeId,
        kind: 'shaped_by_run',
        weight: runs.length,
        evidence: runs.map((run) => String(run.executionLogId || '')).filter(Boolean).slice(0, 6).join(',')
      });
    }
  }
}

function addGitSignals(
  snapshotId: string,
  churn: Map<string, number>,
  nodes: Map<string, GrowthNodeRecord>,
  signals: GrowthSignalRecord[],
  nowIso: string
): void {
  for (const [filePath, count] of churn.entries()) {
    const fileNodeId = nodeIdForPath('file', filePath);
    if (!nodes.has(fileNodeId)) {
      continue;
    }
    if (count >= 3) {
      signals.push({
        snapshotId,
        nodeId: fileNodeId,
        type: 'activity',
        level: count >= 8 ? 'attention' : 'watch',
        value: `近 90 天 Git 变更 ${count} 次`,
        source: 'git',
        sourceRef: filePath,
        createdAt: nowIso
      });
    }
  }
}

function summarizeDirectoryStatus(node: GrowthNodeRecord, signals: GrowthSignalRecord[]): ProjectGrowthSummaryNode['colorSignal'] {
  const ownSignals = signals.filter((signal) => signal.nodeId === node.nodeId);
  if (ownSignals.some((signal) => signal.level === 'blocked')) return 'blocked';
  if (ownSignals.some((signal) => signal.level === 'attention')) return 'attention';
  if (ownSignals.some((signal) => signal.level === 'watch')) return 'watch';
  if (ownSignals.some((signal) => signal.type === 'activity')) return 'growing';
  return 'stable';
}

function emptyProjectGrowthViewModel(): ProjectGrowthViewModel {
  return {
    snapshotId: '',
    generatedAt: '',
    projectPath: '',
    orientation: {
      purpose: '',
      currentStage: '',
      currentStep: '',
      currentStepStatus: '',
      completedSteps: 0,
      totalSteps: 0,
      stages: []
    },
    insight: {
      headline: '还没有项目生长快照',
      body: '选择项目后刷新生长数据，SoloMap 会从代码、路线图、运行记录和验证信号里提炼项目理解。',
      healthLabel: '等待数据',
      focusLabel: '暂无重点',
      evidenceLabel: '暂无证据'
    },
    capabilityHealth: [],
    focusAreas: [],
    recommendedActions: [],
    treemap: null,
    gaps: [],
    modules: [],
    capabilities: [],
    keyEdges: [],
    history: [],
    diff: null,
    totals: { files: 0, modules: 0, capabilities: 0, packages: 0, loc: 0, signals: 0 }
  };
}

function calculateGrowthTotals(data: GrowthSnapshotData): ProjectGrowthTotals {
  return {
    files: data.nodes.filter((node) => node.kind === 'file' && !node.excluded).length,
    modules: data.nodes.filter((node) => node.kind === 'module').length,
    capabilities: data.nodes.filter((node) => node.kind === 'capability').length,
    packages: data.nodes.filter((node) => node.kind === 'package').length,
    loc: data.nodes.filter((node) => node.kind === 'file' && !node.excluded).reduce((sum, node) => sum + node.loc, 0),
    signals: data.signals.length
  };
}

function signalWeight(signal: ProjectGrowthSummaryNode['colorSignal']): number {
  if (signal === 'blocked') return 5;
  if (signal === 'attention') return 4;
  if (signal === 'watch') return 3;
  if (signal === 'growing') return 2;
  return 1;
}

function signalStatusLabel(signal: ProjectGrowthSummaryNode['colorSignal'], tests: number, confidence: number): string {
  if (signal === 'blocked') return 'rework';
  if (signal === 'attention') return 'risk';
  if (signal === 'watch') return tests > 0 ? 'growing' : 'needs_verification';
  if (signal === 'growing') return 'growing';
  if (tests > 0 && confidence >= 0.75) return 'formed';
  return 'stable';
}

function isPrimaryGrowthModule(module: ProjectGrowthModuleSummary): boolean {
  const id = module.nodeId || '';
  const label = module.label || '';
  if (/^module:(\.solopreneur|CHANGELOG\.md|README\.md|package(?:-lock)?\.json|tsconfig\.json|log)$/i.test(id)) {
    return false;
  }
  if (/^\./.test(label) || /\.(md|json|ya?ml|toml|csv|txt|lock)$/i.test(label) || /^(CHANGELOG|README|package(?:-lock)?\.json|tsconfig\.json|log)$/i.test(label)) {
    return false;
  }
  return module.files > 0 && module.loc > 0;
}

function shortenNodeLabel(nodeId: string, labelById: Map<string, string>): string {
  const label = labelById.get(nodeId) || nodeId.replace(/^(module:|file:|capability:roadmap:)/, '');
  return label.replace(/^module:/, '').replace(/^file:/, '');
}

function buildInsightSummary(
  totals: ProjectGrowthTotals,
  modules: ProjectGrowthModuleSummary[],
  capabilities: ProjectGrowthCapabilityHealth[],
  actions: ProjectGrowthRecommendedAction[]
): ProjectGrowthInsightSummary {
  const primaryModules = modules.filter(isPrimaryGrowthModule);
  const shapedCapabilities = capabilities.filter((item) => item.modules.length > 0).length;
  const formedCapabilities = capabilities.filter((item) => item.status === 'formed').length;
  const active = primaryModules
    .filter((module) => ['blocked', 'attention', 'watch', 'growing'].includes(module.signal))
    .sort((a, b) => signalWeight(b.signal) - signalWeight(a.signal) || b.loc - a.loc);
  const topFocus = active[0]?.label || primaryModules[0]?.label || '项目主干';
  const healthLabel = actions.length > 0 ? `${actions.length} 个优先处理点` : '暂无明显阻塞';
  const evidenceLabel = totals.signals > 0 ? `${totals.signals} 条生长信号` : '暂无生长信号';
  const focusLabel = active.length > 0 ? `${topFocus} 最值得先看` : '项目结构相对稳定';
  const capabilityText = capabilities.length > 0
    ? `${shapedCapabilities}/${capabilities.length} 个路线图能力已有代码痕迹`
    : `${primaryModules.length} 个主要模块已识别`;
  const body = capabilities.length > 0
    ? `${capabilityText}，其中 ${formedCapabilities} 个已有验证或稳定证据。当前重点不是文件数量，而是先处理影响理解和推进的能力缺口。`
    : `${capabilityText}。当前重点是把代码区域继续归并到真实产品能力，并补齐验证证据。`;
  return {
    headline: `${totals.files} 个文件沉淀为 ${primaryModules.length} 个主要生长区域`,
    body,
    healthLabel,
    focusLabel,
    evidenceLabel
  };
}

function buildCapabilityHealth(
  capabilities: ProjectGrowthCapabilitySummary[],
  modules: ProjectGrowthModuleSummary[],
  nodeSignals: Map<string, GrowthSignalRecord[]>,
  nodeLabelById: Map<string, string>
): ProjectGrowthCapabilityHealth[] {
  const moduleById = new Map(modules.map((module) => [module.nodeId, module]));
  return capabilities.map((capability) => {
    const capabilitySignals = nodeSignals.get(capability.nodeId) || [];
    const roadmapContext = capabilitySignals.find((signal) => signal.type === 'roadmap_context');
    const roadmapStatus = roadmapContext?.sourceRef || 'Pending';
    const description = roadmapContext?.value || '';
    const linkedModules = capability.modules
      .map((moduleId) => moduleById.get(moduleId))
      .filter(Boolean) as ProjectGrowthModuleSummary[];
    const primaryLinkedModules = linkedModules.filter(isPrimaryGrowthModule);
    const displayModules = primaryLinkedModules.length > 0 ? primaryLinkedModules : linkedModules;
    const tests = displayModules.reduce((sum, module) => sum + module.tests, 0);
    const files = displayModules.reduce((sum, module) => sum + module.files, 0);
    const strongestSignal = displayModules
      .map((module) => module.signal)
      .sort((a, b) => signalWeight(b) - signalWeight(a))[0] || capability.signal;
    let status = roadmapStatus === 'Completed' ? 'not_observed' : 'unshaped';
    if (displayModules.length > 0 && tests > 0 && signalWeight(strongestSignal) <= signalWeight('watch')) {
      status = 'formed';
    } else if (displayModules.some((module) => module.signal === 'blocked')) {
      status = 'rework';
    } else if (displayModules.some((module) => module.signal === 'attention')) {
      status = 'risk';
    } else if (displayModules.length > 0 && tests === 0) {
      status = 'needs_verification';
    } else if (displayModules.length > 0) {
      status = 'growing';
    }
    const evidence = displayModules.slice(0, 4).map((module) => {
      const signals = nodeSignals.get(module.nodeId) || [];
      const reason = signals.find((signal) => signal.level === 'blocked' || signal.level === 'attention' || signal.level === 'watch')?.value;
      return reason ? `${module.label}: ${reason}` : `${module.label}: ${module.files} 个文件 / ${module.tests} 个测试`;
    });
    const moduleNames = displayModules.map((module) => module.label);
    const summary = displayModules.length > 0
      ? `关联 ${displayModules.length} 个主要生长区域、${files} 个文件${tests > 0 ? `，已有 ${tests} 个测试项` : '，还缺少测试证据'}。`
      : '当前还没有识别到明确的代码或交付证据。';
    let action = 'keep_observing';
    if (status === 'unshaped' || status === 'not_observed') action = 'link_or_revise';
    if (status === 'needs_verification') action = 'add_verification';
    if (status === 'risk' || status === 'rework') action = 'reduce_risk';
    if (status === 'formed') action = 'release_or_learn';
    return {
      nodeId: capability.nodeId,
      label: capability.label,
      stage: capability.stage,
      status,
      summary,
      action,
      modules: moduleNames.length > 0 ? moduleNames : capability.modules.map((moduleId) => shortenNodeLabel(moduleId, nodeLabelById)),
      evidence,
      signal: strongestSignal,
      roadmapStatus,
      description
    };
  });
}

function buildProjectOrientation(capabilities: ProjectGrowthCapabilityHealth[], purpose = ''): ProjectGrowthOrientation {
  const statusRank = (status: string): number => {
    if (status === 'Running') return 5;
    if (status === 'Failed') return 4;
    if (status === 'In Progress') return 3;
    if (status === 'Pending') return 2;
    return 1;
  };
  const completedSteps = capabilities.filter((item) => item.roadmapStatus === 'Completed').length;
  const activeCapability = capabilities
    .filter((item) => item.roadmapStatus !== 'Completed')
    .sort((a, b) => statusRank(b.roadmapStatus) - statusRank(a.roadmapStatus))[0] || capabilities[capabilities.length - 1];
  const stageOrder: string[] = [];
  const stageMap = new Map<string, ProjectGrowthStageSummary>();
  for (const capability of capabilities) {
    const stage = capability.stage || '未分阶段';
    if (!stageMap.has(stage)) {
      stageOrder.push(stage);
      stageMap.set(stage, { label: stage, completed: 0, active: 0, pending: 0, total: 0, status: 'pending' });
    }
    const summary = stageMap.get(stage)!;
    summary.total += 1;
    if (capability.roadmapStatus === 'Completed') summary.completed += 1;
    else if (['Running', 'Failed', 'In Progress'].includes(capability.roadmapStatus)) summary.active += 1;
    else summary.pending += 1;
  }
  const stages = stageOrder.map((stage) => {
    const summary = stageMap.get(stage)!;
    summary.status = summary.completed === summary.total ? 'completed' : summary.active > 0 ? 'active' : 'pending';
    return summary;
  });
  const capabilityPurpose = capabilities
    .map((item) => item.label.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join('、');
  return {
    purpose: purpose || (capabilityPurpose ? `项目围绕${capabilityPurpose}等核心能力持续建设。` : ''),
    currentStage: activeCapability?.stage || '',
    currentStep: activeCapability?.label || '',
    currentStepStatus: activeCapability?.roadmapStatus || '',
    completedSteps,
    totalSteps: capabilities.length,
    stages
  };
}

function readProjectPurpose(projectPath: string): string {
  const packagePath = path.join(projectPath, 'package.json');
  try {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const description = String(packageJson.description || '').trim();
    if (description) return description;
  } catch {}
  for (const filename of ['README.md', 'README.zh.md', 'docs/README.zh.md']) {
    try {
      const content = fs.readFileSync(path.join(projectPath, filename), 'utf8')
        .replace(/<!--[^]*?-->/g, '')
        .replace(/^---\s*$[^]*?^---\s*$/m, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !/^#|^!\[|^\[!\[|^<|^```|^[-*]\s/.test(line));
      const paragraph = content.find((line) => line.length >= 24 && !/下一步|已识别|模块/.test(line));
      if (paragraph) return paragraph.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    } catch {}
  }
  return '';
}

function buildFocusAreas(
  modules: ProjectGrowthModuleSummary[],
  nodeSignals: Map<string, GrowthSignalRecord[]>
): ProjectGrowthFocusArea[] {
  return modules
    .filter(isPrimaryGrowthModule)
    .map((module) => {
      const signals = nodeSignals.get(module.nodeId) || [];
      const notableSignals = signals
        .filter((signal) => ['blocked', 'attention', 'watch'].includes(signal.level))
        .slice(0, 3);
      const status = signalStatusLabel(module.signal, module.tests, module.confidence);
      const evidence = notableSignals.length > 0
        ? notableSignals.map((signal) => signal.value)
        : [`${module.files} 个文件 / ${module.tests} 个测试 / ${Math.round(module.confidence * 100)}% 归类置信度`];
      let action = 'keep_observing';
      if (status === 'needs_verification') action = 'add_verification';
      if (status === 'risk' || status === 'rework') action = 'reduce_risk';
      if (status === 'growing') action = 'continue_with_evidence';
      return {
        nodeId: module.nodeId,
        label: module.label,
        status,
        summary: `${module.role} · ${module.files} 个文件 · ${module.loc.toLocaleString()} 行 · ${module.tests} 个测试`,
        action,
        files: module.files,
        loc: module.loc,
        tests: module.tests,
        confidence: module.confidence,
        evidence
      };
    })
    .sort((a, b) => {
      const statusRank = (value: string) => {
        if (value === 'rework') return 5;
        if (value === 'risk') return 4;
        if (value === 'needs_verification') return 3;
        if (value === 'growing') return 2;
        return 1;
      };
      return statusRank(b.status) - statusRank(a.status) || b.loc - a.loc;
    })
    .slice(0, 8);
}

function buildRecommendedActions(
  gaps: ProjectGrowthGap[],
  modules: ProjectGrowthModuleSummary[],
  capabilities: ProjectGrowthCapabilityHealth[],
  nodeLabelById: Map<string, string>
): ProjectGrowthRecommendedAction[] {
  const actions: ProjectGrowthRecommendedAction[] = [];
  for (const capability of capabilities) {
    const isOpenRoadmapWork = capability.roadmapStatus !== 'Completed';
    if (isOpenRoadmapWork && ['unshaped', 'needs_verification', 'risk', 'rework'].includes(capability.status)) {
      actions.push({
        title: capability.roadmapStatus === 'Pending' && capability.status === 'unshaped'
          ? `${capability.label}：按路线图开始推进`
          : `${capability.label} 需要处理`,
        detail: capability.summary,
        target: capability.stage || '路线图能力',
        level: capability.status,
        source: 'roadmap'
      });
    }
  }
  for (const module of modules.filter(isPrimaryGrowthModule)) {
    if (module.tests === 0 && module.loc >= 1200) {
      actions.push({
        title: `${module.label} 缺少验证证据`,
        detail: `${module.files} 个文件、${module.loc.toLocaleString()} 行代码，但没有识别到测试项。`,
        target: module.label,
        level: 'needs_verification',
        source: 'growth_rules'
      });
    }
  }
  for (const gap of gaps) {
    const isFileGitNoise = gap.nodeId.startsWith('file:') && gap.source === 'git';
    if (isFileGitNoise) {
      continue;
    }
    actions.push({
      title: `${shortenNodeLabel(gap.nodeId, nodeLabelById)} 需要关注`,
      detail: gap.value,
      target: gap.label,
      level: gap.level,
      source: gap.source
    });
  }
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = `${action.title}\u001f${action.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function signalKey(signal: GrowthSignalRecord): string {
  return [signal.nodeId, signal.type, signal.level, signal.value, signal.source].join('\u001f');
}

export function buildProjectGrowthDiff(previous: GrowthSnapshotData | null, current: GrowthSnapshotData | null): ProjectGrowthDiff | null {
  if (!previous || !current) {
    return null;
  }
  const previousFiles = new Map(previous.nodes.filter((node) => node.kind === 'file' && !node.excluded).map((node) => [node.path, node]));
  const currentFiles = new Map(current.nodes.filter((node) => node.kind === 'file' && !node.excluded).map((node) => [node.path, node]));
  const previousModules = new Set(previous.nodes.filter((node) => node.kind === 'module').map((node) => node.nodeId));
  const currentModules = new Set(current.nodes.filter((node) => node.kind === 'module').map((node) => node.nodeId));
  const previousCapabilities = new Set(previous.nodes.filter((node) => node.kind === 'capability').map((node) => node.nodeId));
  const currentCapabilities = new Set(current.nodes.filter((node) => node.kind === 'capability').map((node) => node.nodeId));
  const previousSignals = new Set(previous.signals.map(signalKey));
  const currentSignals = new Set(current.signals.map(signalKey));
  let filesChanged = 0;
  for (const [filePath, currentNode] of currentFiles.entries()) {
    const previousNode = previousFiles.get(filePath);
    if (previousNode && (previousNode.loc !== currentNode.loc || previousNode.bytes !== currentNode.bytes)) {
      filesChanged += 1;
    }
  }
  return {
    fromSnapshotId: previous.snapshot.id,
    toSnapshotId: current.snapshot.id,
    filesAdded: [...currentFiles.keys()].filter((filePath) => !previousFiles.has(filePath)).length,
    filesRemoved: [...previousFiles.keys()].filter((filePath) => !currentFiles.has(filePath)).length,
    filesChanged,
    locDelta: calculateGrowthTotals(current).loc - calculateGrowthTotals(previous).loc,
    modulesAdded: [...currentModules].filter((nodeId) => !previousModules.has(nodeId)).length,
    modulesRemoved: [...previousModules].filter((nodeId) => !currentModules.has(nodeId)).length,
    capabilitiesAdded: [...currentCapabilities].filter((nodeId) => !previousCapabilities.has(nodeId)).length,
    capabilitiesRemoved: [...previousCapabilities].filter((nodeId) => !currentCapabilities.has(nodeId)).length,
    signalsAdded: [...currentSignals].filter((key) => !previousSignals.has(key)).length,
    signalsResolved: [...previousSignals].filter((key) => !currentSignals.has(key)).length
  };
}

export function buildProjectGrowthViewModel(
  data: GrowthSnapshotData | null,
  options: {
    previous?: GrowthSnapshotData | null;
    history?: GrowthSnapshotData[];
  } = {}
): ProjectGrowthViewModel {
  if (!data) {
    return emptyProjectGrowthViewModel();
  }
  const byParent = new Map<string, GrowthNodeRecord[]>();
  for (const node of data.nodes.filter((node) => node.kind === 'directory' || node.kind === 'file')) {
    const parent = node.parentId || '';
    const list = byParent.get(parent) || [];
    list.push(node);
    byParent.set(parent, list);
  }
  const buildNode = (node: GrowthNodeRecord): ProjectGrowthSummaryNode => {
    const children = (byParent.get(node.nodeId) || [])
      .filter((child) => !child.excluded)
      .sort((a, b) => (b.loc || b.bytes) - (a.loc || a.bytes))
      .slice(0, 80)
      .map(buildNode);
    return {
      id: node.nodeId,
      label: node.label,
      kind: node.kind,
      path: node.path,
      sizeWeight: Math.max(1, node.loc || node.fileCount || node.bytes),
      colorSignal: summarizeDirectoryStatus(node, data.signals),
      status: node.primaryRole || 'stable',
      children
    };
  };
  const root = data.nodes.find((node) => node.nodeId === 'directory:.') || data.nodes.find((node) => node.kind === 'directory') || null;
  const actionableLevels = new Set(['watch', 'attention', 'blocked']);
  const labelById = new Map(data.nodes.map((node) => [node.nodeId, node.label || node.path || node.nodeId]));
  const signalsByNode = new Map<string, GrowthSignalRecord[]>();
  for (const signal of data.signals) {
    const list = signalsByNode.get(signal.nodeId) || [];
    list.push(signal);
    signalsByNode.set(signal.nodeId, list);
  }
  const incomingByTarget = new Map<string, string[]>();
  for (const edge of data.edges.filter((edge) => edge.kind === 'implements' || edge.kind === 'belongs_to_step')) {
    const list = incomingByTarget.get(edge.targetId) || [];
    list.push(edge.sourceId);
    incomingByTarget.set(edge.targetId, list);
  }
  const gaps = data.signals
    .filter((signal) => actionableLevels.has(signal.level))
    .map((signal) => ({
      nodeId: signal.nodeId,
      label: labelById.get(signal.nodeId) || signal.nodeId,
      level: signal.level,
      value: signal.value,
      source: signal.source
    }))
    .slice(0, 24);
  const modules = data.nodes
    .filter((node) => node.kind === 'module')
    .sort((a, b) => b.loc - a.loc)
    .map((node) => ({
      nodeId: node.nodeId,
      label: node.label,
      role: node.primaryRole,
      loc: node.loc,
      files: node.fileCount,
      tests: node.testFileCount,
      signal: summarizeDirectoryStatus(node, data.signals),
      confidence: node.confidence
    }));
  const capabilities = data.nodes
    .filter((node) => node.kind === 'capability')
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId, undefined, { numeric: true }))
    .map((node) => ({
      nodeId: node.nodeId,
      label: node.label,
      stage: node.primaryRole,
      modules: [...new Set(incomingByTarget.get(node.nodeId) || [])],
      signal: summarizeDirectoryStatus(node, data.signals)
    }));
  const moduleByFile = new Map<string, string>();
  for (const edge of data.edges) {
    if (edge.kind === 'contains' && edge.sourceId.startsWith('module:') && edge.targetId.startsWith('file:')) {
      moduleByFile.set(edge.targetId, edge.sourceId);
    }
  }
  const edgeByIdentity = new Map<string, ProjectGrowthEdgeSummary>();
  for (const edge of data.edges) {
    if (!['imports', 'depends_on', 'tested_by', 'implements', 'shaped_by_run'].includes(edge.kind)) continue;
    const sourceId = moduleByFile.get(edge.sourceId) || edge.sourceId;
    const targetId = moduleByFile.get(edge.targetId) || edge.targetId;
    if (sourceId === targetId) continue;
    const identity = `${sourceId}|${targetId}|${edge.kind}`;
    const existing = edgeByIdentity.get(identity);
    if (existing) {
      existing.weight += edge.weight;
    } else {
      edgeByIdentity.set(identity, { sourceId, targetId, kind: edge.kind, weight: edge.weight, evidence: edge.evidence });
    }
  }
  const keyEdges = [...edgeByIdentity.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 120);
  const history = (options.history || [data]).map((snapshotData) => ({
    snapshotId: snapshotData.snapshot.id,
    createdAt: snapshotData.snapshot.createdAt,
    scanReason: snapshotData.snapshot.scanReason,
    gitHead: snapshotData.snapshot.gitHead,
    totals: calculateGrowthTotals(snapshotData)
  }));
  const capabilityHealth = buildCapabilityHealth(capabilities, modules, signalsByNode, labelById);
  const focusAreas = buildFocusAreas(modules, signalsByNode);
  const recommendedActions = buildRecommendedActions(gaps, modules, capabilityHealth, labelById);
  const projectPurpose = data.signals.find((signal) => signal.nodeId === 'directory:.' && signal.type === 'project_purpose')?.value || '';
  const orientation = buildProjectOrientation(capabilityHealth, projectPurpose);
  const totals = calculateGrowthTotals(data);
  return {
    snapshotId: data.snapshot.id,
    generatedAt: data.snapshot.createdAt,
    projectPath: data.snapshot.projectPath,
    orientation,
    insight: buildInsightSummary(totals, modules, capabilityHealth, recommendedActions),
    capabilityHealth,
    focusAreas,
    recommendedActions,
    treemap: root ? buildNode(root) : null,
    gaps,
    modules,
    capabilities,
    keyEdges,
    history,
    diff: buildProjectGrowthDiff(options.previous || null, data),
    totals
  };
}

export function buildProjectGrowthSnapshot(
  projectPath: string,
  roadmapNodes: RoadmapNode[],
  runEntries: RunIndexEntry[],
  options: ProjectGrowthScanOptions = {}
): GrowthSnapshotData {
  const startedAt = Date.now();
  const now = options.now || new Date();
  const nowIso = now.toISOString();
  const snapshotId = `growth-${now.getTime().toString(36)}`;
  const gitHead = readGitHead(projectPath);
  const files = walkProjectFiles(projectPath, options.maxFiles || 4000);
  const nodes = new Map<string, GrowthNodeRecord>();
  const edges: GrowthEdgeRecord[] = [];
  const signals: GrowthSignalRecord[] = [];
  const labels: GrowthModuleLabelRecord[] = [];
  ensureDirectoryNodes(snapshotId, files, nodes, edges);
  addFileNodes(snapshotId, files, nodes, edges);
  aggregateDirectoryMetrics(nodes);
  addImportEdges(projectPath, snapshotId, files, nodes, edges);
  addModuleAndCapabilityNodes(snapshotId, files, roadmapNodes, runEntries, nodes, edges, signals, labels, nowIso);
  const projectPurpose = readProjectPurpose(projectPath);
  if (projectPurpose) {
    signals.push({
      snapshotId,
      nodeId: 'directory:.',
      type: 'project_purpose',
      level: 'info',
      value: projectPurpose,
      source: 'filesystem',
      sourceRef: 'package.json',
      createdAt: nowIso
    });
  }
  addGitSignals(snapshotId, readGitChurn(projectPath), nodes, signals, nowIso);

  const importCounts = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind === 'imports') {
      importCounts.set(edge.targetId, (importCounts.get(edge.targetId) || 0) + 1);
    }
  }
  for (const [nodeId, count] of importCounts.entries()) {
    if (count >= 5) {
      signals.push({
        snapshotId,
        nodeId,
        type: 'risk',
        level: count >= 12 ? 'attention' : 'watch',
        value: `被 ${count} 个文件依赖，属于潜在主路径`,
        source: 'import_graph',
        sourceRef: nodeId,
        createdAt: nowIso
      });
    }
  }

  const snapshot: GrowthSnapshotRecord = {
    id: snapshotId,
    createdAt: nowIso,
    projectPath,
    gitHead,
    scanReason: options.scanReason || 'manual',
    status: 'completed',
    durationMs: Date.now() - startedAt,
    error: ''
  };
  return {
    snapshot,
    nodes: [...nodes.values()],
    edges,
    signals,
    labels
  };
}

export async function refreshProjectGrowthSnapshot(
  projectPath: string,
  extensionPath: string,
  options: ProjectGrowthScanOptions = {}
): Promise<ProjectGrowthViewModel> {
  const growthDbPath = path.join(projectPath, '.solopreneur', 'project_growth.db');
  const journalDbPath = path.join(projectPath, '.solopreneur', 'project_journal.db');
  fs.mkdirSync(path.dirname(growthDbPath), { recursive: true });
  const growthStore = new SqliteStore(growthDbPath, extensionPath);
  const journalStore = new SqliteStore(journalDbPath, extensionPath);
  try {
    await Promise.all([growthStore.init(), journalStore.init()]);
    migrateLegacyGrowthHistory(journalStore, growthStore);
    const previousHistory = growthStore.getGrowthSnapshotHistory(1);
    const previous = previousHistory[0] ? growthStore.getGrowthSnapshotById(previousHistory[0].id) : null;
    const snapshot = buildProjectGrowthSnapshot(projectPath, journalStore.getAllNodes(), journalStore.getRunIndexEntries(), options);
    growthStore.writeGrowthSnapshot(snapshot);
    const history = growthStore.getGrowthSnapshotHistory(options.historyLimit || 12)
      .map((item) => growthStore.getGrowthSnapshotById(item.id))
      .filter(Boolean) as GrowthSnapshotData[];
    const view = buildProjectGrowthViewModel(snapshot, { previous, history });
    projectGrowthViewCache.set(projectPath, view);
    return view;
  } finally {
    journalStore.close();
    growthStore.close();
  }
}

export async function getProjectGrowthView(
  projectPath: string,
  extensionPath: string,
  options: ProjectGrowthScanOptions = {}
): Promise<ProjectGrowthViewModel> {
  if (!options.forceRefresh && projectGrowthViewCache.has(projectPath)) {
    return projectGrowthViewCache.get(projectPath)!;
  }
  const growthDbPath = path.join(projectPath, '.solopreneur', 'project_growth.db');
  const journalDbPath = path.join(projectPath, '.solopreneur', 'project_journal.db');
  fs.mkdirSync(path.dirname(growthDbPath), { recursive: true });
  const store = new SqliteStore(growthDbPath, extensionPath);
  let journalStore: SqliteStore | null = null;
  try {
    await store.init();
    if (!store.getLatestGrowthSnapshot() && fs.existsSync(journalDbPath)) {
      journalStore = new SqliteStore(journalDbPath, extensionPath);
      await journalStore.init();
      migrateLegacyGrowthHistory(journalStore, store);
    }
    if (options.forceRefresh || (options.refreshIfMissing !== false && !store.getLatestGrowthSnapshot())) {
      if (!journalStore) {
        journalStore = new SqliteStore(journalDbPath, extensionPath);
        await journalStore.init();
      }
      const previousHistory = store.getGrowthSnapshotHistory(1);
      const previous = previousHistory[0] ? store.getGrowthSnapshotById(previousHistory[0].id) : null;
      const snapshot = buildProjectGrowthSnapshot(projectPath, journalStore.getAllNodes(), journalStore.getRunIndexEntries(), {
        ...options,
        scanReason: options.scanReason || 'query_refresh'
      });
      store.writeGrowthSnapshot(snapshot);
      const history = store.getGrowthSnapshotHistory(options.historyLimit || 12)
        .map((item) => store.getGrowthSnapshotById(item.id))
        .filter(Boolean) as GrowthSnapshotData[];
      const view = buildProjectGrowthViewModel(snapshot, { previous, history });
      projectGrowthViewCache.set(projectPath, view);
      return view;
    }
    const latest = store.getLatestGrowthSnapshot();
    if (!latest) {
      const view = emptyProjectGrowthViewModel();
      projectGrowthViewCache.set(projectPath, view);
      return view;
    }
    const historyRows = store.getGrowthSnapshotHistory(options.historyLimit || 12);
    const previousRow = historyRows.find((item) => item.id !== latest.snapshot.id);
    const previous = previousRow ? store.getGrowthSnapshotById(previousRow.id) : null;
    const history = historyRows
      .map((item) => store.getGrowthSnapshotById(item.id))
      .filter(Boolean) as GrowthSnapshotData[];
    const view = buildProjectGrowthViewModel(latest, { previous, history });
    projectGrowthViewCache.set(projectPath, view);
    return view;
  } finally {
    journalStore?.close();
    store.close();
  }
}

function migrateLegacyGrowthHistory(legacyStore: SqliteStore, growthStore: SqliteStore): void {
  if (growthStore.getLatestGrowthSnapshot()) return;
  const legacyRows = legacyStore.getGrowthSnapshotHistory(50).reverse();
  for (const row of legacyRows) {
    const snapshot = legacyStore.getGrowthSnapshotById(row.id);
    if (snapshot) growthStore.writeGrowthSnapshot(snapshot);
  }
}

const projectGrowthViewCache = new Map<string, ProjectGrowthViewModel>();

export function getCachedProjectGrowthView(projectPath: string): ProjectGrowthViewModel | null {
  return projectGrowthViewCache.get(projectPath) || null;
}

export function clearProjectGrowthViewCache(projectPath = ''): void {
  if (projectPath) projectGrowthViewCache.delete(projectPath);
  else projectGrowthViewCache.clear();
}
