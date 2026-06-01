import * as fs from 'fs';
import * as path from 'path';

export interface DocumentationManifestDocument {
  path: string;
  role: string;
  status: 'active' | 'missing' | 'pending_review';
  solves: string;
  lastReviewedAt?: string;
  lastTouchedAt?: string;
}

export interface DocumentationManifestPendingReview {
  path: string;
  reason: string;
  severity: 'info' | 'warning';
  detectedAt: string;
  source: string;
}

export interface DocumentationManifestAudit {
  auditedAt: string;
  runKind: string;
  nodeId: string;
  status: string;
  action: 'none' | 'updated' | 'needs_review';
  touchedDocuments: string[];
  pendingReviewCount: number;
}

export interface DocumentationManifest {
  schemaVersion: number;
  updatedAt: string;
  documents: DocumentationManifestDocument[];
  pendingReview: DocumentationManifestPendingReview[];
  lastAudit?: DocumentationManifestAudit;
}

export interface DocumentationAuditOptions {
  nodeId?: string;
  runKind?: string;
  status?: string;
  changedFilesSummary?: string;
  touchedFilesSummary?: string;
  outputTail?: string;
  finishedAt?: string;
}

export interface DocumentationAuditResult {
  manifest: DocumentationManifest;
  touchedDocuments: string[];
  pendingReview: DocumentationManifestPendingReview[];
  summary: string;
}

const lowSignalDocumentNames = new Set([
  'summary.md',
  'summaries.md',
  'notes.md',
  'note.md',
  'final.md',
  'result.md',
  'results.md',
  'implementation.md',
  'plan.md',
  'temp.md',
  'draft.md',
  'design.md'
]);

const preferredDocumentOrder = [
  'README.md',
  'docs/README.zh.md',
  'docs/product/business-plan.zh.md',
  'docs/methodology/methodology.zh.md',
  'docs/architecture/solo-delivery-loop-boundary.zh.md',
  'docs/roadmap/next-feature-plan.zh.md',
  'docs/methodology/project-lifecycle-engineering-docs.zh.md',
  '.solopreneur/README.md'
];

export function getDocumentationManifestPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.solopreneur', 'documentation.json');
}

export function ensureDocumentationManifest(workspaceRoot: string, now = new Date().toISOString()): DocumentationManifest {
  const manifestPath = getDocumentationManifestPath(workspaceRoot);
  const existing = readDocumentationManifest(workspaceRoot);
  const scannedDocuments = scanProjectDocuments(workspaceRoot, now);
  const documents = mergeDocuments(existing.documents, scannedDocuments, now);
  const manifest: DocumentationManifest = {
    schemaVersion: 1,
    updatedAt: now,
    documents,
    pendingReview: dedupePendingReviews(existing.pendingReview || []),
    ...(existing.lastAudit ? { lastAudit: existing.lastAudit } : {})
  };
  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeDocumentationManifest(workspaceRoot, manifest);
  } catch {
    return manifest;
  }
  return manifest;
}

export function buildDocumentationPromptContext(workspaceRoot: string): string {
  const manifest = ensureDocumentationManifest(workspaceRoot);
  const documents = manifest.documents
    .filter((document) => document.status === 'active')
    .slice(0, 20)
    .map((document) => `- ${document.path}：${document.role}；${document.solves || '说明项目长期判断'}`);
  const pending = manifest.pendingReview
    .slice(0, 5)
    .map((item) => `- ${item.path}：${item.reason}`);
  return [
    'SoloMap 项目文档 Harness：',
    `- 项目文档 manifest：${toProjectRelativePath(workspaceRoot, getDocumentationManifestPath(workspaceRoot))}`,
    '- 该 manifest 由插件维护，Agent 不要手动编辑它；如需沉淀长期判断，优先更新下列正式文档。',
    ...(documents.length > 0 ? ['- 当前正式文档：', ...documents] : ['- 当前还没有正式项目解释性文档；只有形成长期判断时才创建。']),
    ...(pending.length > 0 ? ['- 待用户确认的文档风险：', ...pending] : []),
    '- 项目解释性文档只记录长期复用的判断：方向、模型、边界、决策、运行方式。',
    '- 本轮做了什么、改了哪里、怎么验证，应进入环节交接或最终输出，不要新建 `docs/summary.md`、`docs/notes.md`、`docs/plan.md` 这类低语义文档。',
    '- 执行流水、prompt、终端日志和命令输出不得复制进长期项目文档。',
    '- 如果需要新增正式文档，文件名必须表达长期职责，并优先使用 `docs/decisions/`、`docs/ui/` 或既有标准文档路径。'
  ].join('\n');
}

export function auditDocumentationAfterRun(workspaceRoot: string, options: DocumentationAuditOptions): DocumentationAuditResult {
  const finishedAt = options.finishedAt || new Date().toISOString();
  const manifest = ensureDocumentationManifest(workspaceRoot, finishedAt);
  const touchedDocuments = extractChangedProjectPaths([
    options.changedFilesSummary || '',
    options.touchedFilesSummary || ''
  ].join('\n')).filter((relativePath) => isDocumentationPath(relativePath));
  const scannedTouchedDocuments = scanProjectDocuments(workspaceRoot, finishedAt)
    .filter((document) => touchedDocuments.includes(document.path));
  const nextDocuments = mergeDocuments(manifest.documents, scannedTouchedDocuments, finishedAt);
  const newReviews = buildPendingReviewsForTouchedDocuments(workspaceRoot, touchedDocuments, finishedAt);
  const pendingReview = dedupePendingReviews([...(manifest.pendingReview || []), ...newReviews]);
  const action: DocumentationManifestAudit['action'] = newReviews.length > 0
    ? 'needs_review'
    : touchedDocuments.length > 0
      ? 'updated'
      : 'none';
  const nextManifest: DocumentationManifest = {
    schemaVersion: 1,
    updatedAt: finishedAt,
    documents: nextDocuments,
    pendingReview,
    lastAudit: {
      auditedAt: finishedAt,
      runKind: options.runKind || '',
      nodeId: options.nodeId || '',
      status: options.status || '',
      action,
      touchedDocuments,
      pendingReviewCount: pendingReview.length
    }
  };
  try {
    writeDocumentationManifest(workspaceRoot, nextManifest);
  } catch {
    return {
      manifest,
      touchedDocuments,
      pendingReview: [],
      summary: '文档：审计状态无法写入，主任务已保留'
    };
  }
  return {
    manifest: nextManifest,
    touchedDocuments,
    pendingReview: newReviews,
    summary: summarizeDocumentationAudit(touchedDocuments, newReviews)
  };
}

export function summarizeDocumentationForReview(workspaceRoot: string): {
  documentCount: number;
  pendingReviewCount: number;
  pendingReview: DocumentationManifestPendingReview[];
  staleDocuments: DocumentationManifestDocument[];
} {
  const manifest = ensureDocumentationManifest(workspaceRoot);
  const staleBefore = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const staleDocuments = manifest.documents.filter((document) => {
    const reviewedAt = Date.parse(document.lastReviewedAt || document.lastTouchedAt || '');
    return document.status === 'active' && Number.isFinite(reviewedAt) && reviewedAt < staleBefore;
  });
  return {
    documentCount: manifest.documents.filter((document) => document.status === 'active').length,
    pendingReviewCount: manifest.pendingReview.length,
    pendingReview: manifest.pendingReview.slice(0, 5),
    staleDocuments: staleDocuments.slice(0, 5)
  };
}

function readDocumentationManifest(workspaceRoot: string): DocumentationManifest {
  const manifestPath = getDocumentationManifestPath(workspaceRoot);
  if (!fs.existsSync(manifestPath)) {
    return { schemaVersion: 1, updatedAt: '', documents: [], pendingReview: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return {
      schemaVersion: Number(parsed.schemaVersion || 1),
      updatedAt: String(parsed.updatedAt || ''),
      documents: Array.isArray(parsed.documents) ? parsed.documents.map(normalizeDocument).filter((item: DocumentationManifestDocument) => item.path) : [],
      pendingReview: Array.isArray(parsed.pendingReview) ? parsed.pendingReview.map(normalizePendingReview).filter((item: DocumentationManifestPendingReview) => item.path && item.reason) : [],
      ...(parsed.lastAudit ? { lastAudit: parsed.lastAudit } : {})
    };
  } catch {
    return { schemaVersion: 1, updatedAt: '', documents: [], pendingReview: [] };
  }
}

function writeDocumentationManifest(workspaceRoot: string, manifest: DocumentationManifest): void {
  const manifestPath = getDocumentationManifestPath(workspaceRoot);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function normalizeDocument(value: any): DocumentationManifestDocument {
  return {
    path: normalizeRelativePath(String(value?.path || '')),
    role: String(value?.role || 'reference'),
    status: value?.status === 'missing' || value?.status === 'pending_review' ? value.status : 'active',
    solves: String(value?.solves || ''),
    lastReviewedAt: String(value?.lastReviewedAt || ''),
    lastTouchedAt: String(value?.lastTouchedAt || '')
  };
}

function normalizePendingReview(value: any): DocumentationManifestPendingReview {
  return {
    path: normalizeRelativePath(String(value?.path || '')),
    reason: String(value?.reason || ''),
    severity: value?.severity === 'info' ? 'info' : 'warning',
    detectedAt: String(value?.detectedAt || ''),
    source: String(value?.source || 'documentation_audit')
  };
}

function scanProjectDocuments(workspaceRoot: string, now: string): DocumentationManifestDocument[] {
  const results: DocumentationManifestDocument[] = [];
  for (const relativePath of ['README.md', '.solopreneur/README.md']) {
    const absolutePath = path.join(workspaceRoot, relativePath);
    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
      results.push(buildDocumentEntry(workspaceRoot, relativePath, now));
    }
  }
  const docsRoot = path.join(workspaceRoot, 'docs');
  if (fs.existsSync(docsRoot) && fs.statSync(docsRoot).isDirectory()) {
    for (const relativePath of walkMarkdownFiles(workspaceRoot, docsRoot)) {
      results.push(buildDocumentEntry(workspaceRoot, relativePath, now));
    }
  }
  return sortDocuments(results);
}

function walkMarkdownFiles(workspaceRoot: string, directory: string): string[] {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      files.push(...walkMarkdownFiles(workspaceRoot, absolutePath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(toProjectRelativePath(workspaceRoot, absolutePath));
    }
  }
  return files;
}

function buildDocumentEntry(workspaceRoot: string, relativePath: string, now: string): DocumentationManifestDocument {
  const absolutePath = path.join(workspaceRoot, relativePath);
  const stat = fs.statSync(absolutePath);
  return {
    path: normalizeRelativePath(relativePath),
    role: inferDocumentRole(relativePath),
    status: 'active',
    solves: inferDocumentSolves(relativePath),
    lastReviewedAt: '',
    lastTouchedAt: stat.mtime ? stat.mtime.toISOString() : now
  };
}

function mergeDocuments(existing: DocumentationManifestDocument[], scanned: DocumentationManifestDocument[], now: string): DocumentationManifestDocument[] {
  const byPath = new Map<string, DocumentationManifestDocument>();
  for (const document of existing || []) {
    const normalized = normalizeDocument(document);
    if (normalized.path) {
      byPath.set(normalized.path, normalized);
    }
  }
  for (const document of scanned) {
    const previous = byPath.get(document.path);
    byPath.set(document.path, {
      ...document,
      role: previous?.role || document.role,
      solves: previous?.solves || document.solves,
      lastReviewedAt: previous?.lastReviewedAt || '',
      lastTouchedAt: document.lastTouchedAt || previous?.lastTouchedAt || now,
      status: 'active'
    });
  }
  return sortDocuments(Array.from(byPath.values()));
}

function buildPendingReviewsForTouchedDocuments(workspaceRoot: string, touchedDocuments: string[], now: string): DocumentationManifestPendingReview[] {
  const reviews: DocumentationManifestPendingReview[] = [];
  for (const relativePath of touchedDocuments) {
    const absolutePath = path.join(workspaceRoot, relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      continue;
    }
    const basename = path.basename(relativePath).toLowerCase();
    if (lowSignalDocumentNames.has(basename)) {
      reviews.push({
        path: relativePath,
        reason: '低语义文件名，疑似把本轮总结或过程记录放进长期项目文档。',
        severity: 'warning',
        detectedAt: now,
        source: 'documentation_audit'
      });
    }
    const content = safeReadText(absolutePath);
    if (looksLikeProcessLog(content)) {
      reviews.push({
        path: relativePath,
        reason: '文档内容疑似包含 prompt、终端输出或执行流水，不适合进入长期项目解释性文档。',
        severity: 'warning',
        detectedAt: now,
        source: 'documentation_audit'
      });
    }
    if (relativePath.startsWith('docs/') && !hasLongTermJudgmentStructure(content)) {
      reviews.push({
        path: relativePath,
        reason: '文档缺少长期判断结构，建议确认它解决的项目判断和适用范围。',
        severity: 'info',
        detectedAt: now,
        source: 'documentation_audit'
      });
    }
  }
  return reviews;
}

function hasLongTermJudgmentStructure(content: string): boolean {
  const normalized = content.toLowerCase();
  const markers = [
    '解决什么判断',
    '适用范围',
    '核心原则',
    '正式规则',
    '禁止项',
    '相关入口',
    'background',
    'decision',
    'scope',
    'principle'
  ];
  return markers.filter((marker) => normalized.includes(marker.toLowerCase())).length >= 2;
}

function looksLikeProcessLog(content: string): boolean {
  const lines = content.split(/\r?\n/);
  const logLikeLines = lines.filter((line) => (
    /^\s*(\$|>|npm |git |pnpm |yarn |node |npx |codex |claude |agy )/.test(line)
    || /SoloMap 默认系统提示词|用户本次要求（最高优先级）|Agent output tail|Workspace changes|Touched project files|Run duration ms|completion\.json|prompt\.txt/.test(line)
  ));
  return logLikeLines.length >= 4 || logLikeLines.join('\n').length > 800;
}

function extractChangedProjectPaths(summary: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of String(summary || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^No (workspace|git|project)/i.test(line)) continue;
    const withoutStatus = line.replace(/^(?:[AMDRCU?!]{1,2}|[A-Z])\s+/, '').trim();
    const relativePath = normalizeRelativePath(withoutStatus.split(/\s+->\s+/).pop() || withoutStatus);
    if (!relativePath || relativePath.startsWith('../') || path.isAbsolute(relativePath)) continue;
    if (!seen.has(relativePath)) {
      seen.add(relativePath);
      paths.push(relativePath);
    }
  }
  return paths;
}

function isDocumentationPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return normalized === 'README.md'
    || normalized === '.solopreneur/README.md'
    || (normalized.startsWith('docs/') && normalized.toLowerCase().endsWith('.md'));
}

function inferDocumentRole(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  if (normalized === 'readme.md') return 'direction';
  if (normalized === '.solopreneur/readme.md') return 'data_ownership';
  if (normalized.includes('/decisions/')) return 'decision';
  if (normalized.includes('/ui/') || normalized.includes('ui') || normalized.includes('sidebar') || normalized.includes('panel')) return 'ui_guideline';
  if (normalized.includes('data') || normalized.includes('ownership')) return 'data_ownership';
  if (normalized.includes('release') || normalized.includes('distribution') || normalized.includes('troubleshooting') || normalized.includes('local-dev')) return 'operation';
  if (normalized.includes('lifecycle') || normalized.includes('methodology') || normalized.includes('template')) return 'methodology';
  if (normalized.includes('business') || normalized.includes('positioning') || normalized.includes('launch')) return 'direction';
  if (normalized.includes('harness') || normalized.includes('boundary') || normalized.includes('guideline')) return 'boundary';
  return 'reference';
}

function inferDocumentSolves(relativePath: string): string {
  const role = inferDocumentRole(relativePath);
  if (role === 'direction') return '说明项目是什么、服务谁、成功标准和对外表达。';
  if (role === 'methodology') return '说明项目生命周期、推进模型或 Harness 判断方法。';
  if (role === 'boundary') return '固定产品、工程或用户心智边界，避免后续偏航。';
  if (role === 'decision') return '记录不可轻易反转的项目决策、理由和影响。';
  if (role === 'operation') return '说明开发、验证、发布、安装、回滚或排障方式。';
  if (role === 'ui_guideline') return '约束长期 UI 或治理面如何服务用户动作。';
  if (role === 'data_ownership') return '说明项目数据、缓存、运行记录和 Git 管理边界。';
  return '保存项目长期解释性背景。';
}

function summarizeDocumentationAudit(touchedDocuments: string[], pendingReview: DocumentationManifestPendingReview[]): string {
  if (pendingReview.length > 0) {
    return `文档：建议确认 ${pendingReview.length} 个文档风险`;
  }
  if (touchedDocuments.length > 0) {
    return `文档：已更新 ${touchedDocuments.slice(0, 3).join(', ')}${touchedDocuments.length > 3 ? ' 等' : ''}`;
  }
  return '文档：无需更新';
}

function dedupePendingReviews(items: DocumentationManifestPendingReview[]): DocumentationManifestPendingReview[] {
  const byKey = new Map<string, DocumentationManifestPendingReview>();
  for (const item of items) {
    const normalized = normalizePendingReview(item);
    if (!normalized.path || !normalized.reason) continue;
    byKey.set(`${normalized.path}::${normalized.reason}`, normalized);
  }
  return Array.from(byKey.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function sortDocuments(documents: DocumentationManifestDocument[]): DocumentationManifestDocument[] {
  return documents.slice().sort((a, b) => {
    const preferredA = preferredDocumentOrder.indexOf(a.path);
    const preferredB = preferredDocumentOrder.indexOf(b.path);
    if (preferredA !== -1 || preferredB !== -1) {
      return (preferredA === -1 ? 999 : preferredA) - (preferredB === -1 ? 999 : preferredB);
    }
    return a.path.localeCompare(b.path);
  });
}

function safeReadText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function normalizeRelativePath(value: string): string {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function toProjectRelativePath(workspaceRoot: string, absolutePath: string): string {
  return normalizeRelativePath(path.relative(workspaceRoot, absolutePath));
}
