import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { execFile, execFileSync } from 'child_process';
import { createCoverageMap } from 'istanbul-lib-coverage';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';

export type ProjectCoverageStatus = 'ready' | 'test_failed' | 'stale_failed' | 'unavailable';

export interface ProjectCoverageMetric {
  covered: number;
  total: number;
  percent: number;
}

export interface ProjectFileCoverage {
  path: string;
  lines: ProjectCoverageMetric;
  branches: ProjectCoverageMetric;
  functions: ProjectCoverageMetric;
  statements: ProjectCoverageMetric;
}

export interface ProjectCoverageSnapshot {
  version: 1;
  provider: 'c8-istanbul';
  status: ProjectCoverageStatus;
  generatedAt: string;
  lastAttemptAt: string;
  durationMs: number;
  testPassed: boolean;
  files: ProjectFileCoverage[];
  error: string;
  sourceVersion?: { gitHead: string; contentHash: string };
}

export function captureCoverageVersion(projectPath: string): { gitHead: string; contentHash: string } {
  const digest = crypto.createHash('sha256');
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || ['node_modules', '.git', '.solopreneur', '.solomap-global', '.agents', 'out', 'dist', 'build', 'coverage', '.next'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:[cm]?[jt]sx?|json|ya?ml|sh|py|go|rs|java|swift|c|h|cpp|vue|svelte|html|css)$/.test(entry.name)) {
        digest.update(path.relative(projectPath, file)); digest.update('\0'); digest.update(fs.readFileSync(file)); digest.update('\0');
      }
    }
  };
  walk(projectPath);
  let gitHead = '';
  try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Non-Git projects still have a content identity. */ }
  return { gitHead, contentHash: digest.digest('hex') };
}

export function coverageVersionState(projectPath: string, snapshot: Pick<ProjectCoverageSnapshot, 'sourceVersion'>): 'current' | 'stale' | 'unknown' {
  if (!snapshot.sourceVersion?.contentHash) return 'unknown';
  try { return captureCoverageVersion(projectPath).contentHash === snapshot.sourceVersion.contentHash ? 'current' : 'stale'; } catch { return 'unknown'; }
}

const coverageRuns = new Map<string, Promise<ProjectCoverageSnapshot>>();

interface AnalysisState<T> {
  objectId: string | null;
  revision: number;
  value: T | null;
}

function coverageDataRoot(projectPath: string, globalDataPath: string): string {
  return normalizeGlobalDataPathForExtension(globalDataPath, projectPath);
}

function removeOwnedCoverageReportDirectory(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) removeOwnedCoverageReportDirectory(target);
    else fs.unlinkSync(target);
  }
  fs.rmdirSync(directory);
}

function emptyCoverageSnapshot(status: ProjectCoverageStatus, error: string): ProjectCoverageSnapshot {
  return {
    version: 1,
    provider: 'c8-istanbul',
    status,
    generatedAt: '',
    lastAttemptAt: new Date().toISOString(),
    durationMs: 0,
    testPassed: false,
    files: [],
    error
  };
}

function isCoverageSnapshot(value: unknown): value is ProjectCoverageSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ProjectCoverageSnapshot>;
  return candidate.version === 1
    && candidate.provider === 'c8-istanbul'
    && Array.isArray(candidate.files);
}

export async function loadProjectCoverageSnapshot(projectPath: string, globalDataPath = ''): Promise<ProjectCoverageSnapshot | null> {
  try {
    const state = await sendRuntimeDataRequest<AnalysisState<ProjectCoverageSnapshot>>(coverageDataRoot(projectPath, globalDataPath), {
      operation: 'read_analysis_state',
      input: { root: projectPath, namespace: 'coverage', key: 'project-growth' }
    });
    return isCoverageSnapshot(state.value) ? state.value : null;
  } catch {
    return null;
  }
}

function metricFromSummary(summary: { covered: number; total: number; pct: number }): ProjectCoverageMetric {
  return {
    covered: Number(summary.covered || 0),
    total: Number(summary.total || 0),
    percent: Number.isFinite(summary.pct) ? Number(summary.pct) : 0
  };
}

function normalizeCoveragePath(projectPath: string, filePath: string): string {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(projectPath, filePath);
  const relativePath = path.relative(projectPath, absolutePath).replace(/\\/g, '/');
  return relativePath.startsWith('../') ? '' : relativePath;
}

export function parseIstanbulCoverageReport(projectPath: string, reportPath: string): ProjectFileCoverage[] {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
  const coverageMap = createCoverageMap(report as any);
  return coverageMap.files()
    .map((filePath) => {
      const relativePath = normalizeCoveragePath(projectPath, filePath);
      if (!relativePath) return null;
      const summary = coverageMap.fileCoverageFor(filePath).toSummary();
      return {
        path: relativePath,
        lines: metricFromSummary(summary.lines),
        branches: metricFromSummary(summary.branches),
        functions: metricFromSummary(summary.functions),
        statements: metricFromSummary(summary.statements)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a!.path.localeCompare(b!.path)) as ProjectFileCoverage[];
}

function nodeSupportsBundledC8(version: string): boolean {
  const [major, minor] = version.replace(/^v/, '').split('.').map((value) => Number(value));
  return major > 20 || (major === 20 && minor >= 19);
}

async function resolveCoverageNodeExecutable(): Promise<string> {
  if (nodeSupportsBundledC8(process.versions.node)) return process.execPath;
  return new Promise((resolve) => {
    execFile('node', ['--version'], { timeout: 3000 }, (error, stdout) => {
      resolve(!error && nodeSupportsBundledC8(stdout.trim()) ? 'node' : '');
    });
  });
}

function readTestScript(projectPath: string): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const script = String(packageJson.scripts?.test || '').trim();
    if (!script || /no test specified/i.test(script)) return '';
    return script;
  } catch {
    return '';
  }
}

async function writeCoverageSnapshot(projectPath: string, globalDataPath: string, snapshot: ProjectCoverageSnapshot): Promise<void> {
  const root = coverageDataRoot(projectPath, globalDataPath);
  const idempotencyKey = `coverage:${crypto.randomUUID()}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await sendRuntimeDataRequest<AnalysisState<ProjectCoverageSnapshot>>(root, {
      operation: 'read_analysis_state',
      input: { root: projectPath, namespace: 'coverage', key: 'project-growth' }
    });
    try {
      await sendRuntimeDataRequest(root, {
        operation: 'write_analysis_state',
        input: {
          root: projectPath,
          namespace: 'coverage',
          key: 'project-growth',
          expectedRevision: current.revision,
          value: snapshot,
          idempotencyKey: `${idempotencyKey}:${attempt}`
        }
      });
      return;
    } catch (error) {
      if (!/revision_conflict/.test(String(error)) || attempt === 3) throw error;
    }
  }
}

async function preservePreviousCoverageFailure(
  projectPath: string,
  globalDataPath: string,
  previous: ProjectCoverageSnapshot | null,
  attemptedAt: string,
  startedAt: number,
  error: string
): Promise<ProjectCoverageSnapshot> {
  if (!previous) {
    const unavailable = emptyCoverageSnapshot('unavailable', error);
    unavailable.lastAttemptAt = attemptedAt;
    unavailable.durationMs = Date.now() - startedAt;
    await writeCoverageSnapshot(projectPath, globalDataPath, unavailable);
    return unavailable;
  }
  const staleSnapshot: ProjectCoverageSnapshot = {
    ...previous,
    status: 'stale_failed',
    lastAttemptAt: attemptedAt,
    durationMs: Date.now() - startedAt,
    testPassed: false,
    error
  };
  await writeCoverageSnapshot(projectPath, globalDataPath, staleSnapshot);
  return staleSnapshot;
}

async function executeCoverageRun(projectPath: string, extensionPath: string, globalDataPath: string): Promise<ProjectCoverageSnapshot> {
  const startedAt = Date.now();
  const attemptedAt = new Date().toISOString();
  const previous = await loadProjectCoverageSnapshot(projectPath, globalDataPath);
  const sourceVersion = captureCoverageVersion(projectPath);
  const testScript = readTestScript(projectPath);
  if (!testScript) {
    return preservePreviousCoverageFailure(projectPath, globalDataPath, previous, attemptedAt, startedAt, '项目没有可运行的 npm test 脚本。');
  }
  const coverageNodeExecutable = await resolveCoverageNodeExecutable();
  if (!coverageNodeExecutable) {
    return preservePreviousCoverageFailure(projectPath, globalDataPath, previous, attemptedAt, startedAt, '运行验证分析需要 Node.js 20.19 或更高版本。');
  }

  const c8Cli = path.join(extensionPath, 'node_modules', 'c8', 'bin', 'c8.js');
  if (!fs.existsSync(c8Cli)) {
    return preservePreviousCoverageFailure(projectPath, globalDataPath, previous, attemptedAt, startedAt, 'SoloMap 覆盖分析组件未安装完整。');
  }
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-coverage-report-'));
  const reportPath = path.join(reportDir, 'coverage-final.json');
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete childEnvironment.FORCE_COLOR;
  delete childEnvironment.NODE_TEST_CONTEXT;
  const result = await new Promise<{ error: Error | null }>((resolve) => {
    execFile(coverageNodeExecutable, [
      c8Cli,
      '--all',
      '--reporter=json',
      `--reports-dir=${reportDir}`,
      '--extension=.ts',
      '--extension=.tsx',
      '--extension=.js',
      '--extension=.jsx',
      npmExecutable,
      'test'
    ], {
      cwd: projectPath,
      maxBuffer: 10 * 1024 * 1024,
      env: childEnvironment
    }, (error) => resolve({ error }));
  });

  let snapshot: ProjectCoverageSnapshot | null = null;
  let reportError = '';
  try {
    if (!fs.existsSync(reportPath)) reportError = result.error?.message || '测试结束后没有生成覆盖报告。';
    else snapshot = {
      version: 1,
      provider: 'c8-istanbul',
      status: result.error ? 'test_failed' : 'ready',
      generatedAt: new Date().toISOString(),
      lastAttemptAt: attemptedAt,
      durationMs: Date.now() - startedAt,
      testPassed: !result.error,
      sourceVersion,
      files: parseIstanbulCoverageReport(projectPath, reportPath),
      error: result.error?.message || ''
    };
  } catch (error) {
    reportError = error instanceof Error ? error.message : String(error);
  } finally {
    removeOwnedCoverageReportDirectory(reportDir);
  }
  if (!snapshot) return preservePreviousCoverageFailure(projectPath, globalDataPath, previous, attemptedAt, startedAt, reportError);
  await writeCoverageSnapshot(projectPath, globalDataPath, snapshot);
  return snapshot;
}

export function runProjectCoverageAnalysis(projectPath: string, extensionPath: string, globalDataPath = ''): Promise<ProjectCoverageSnapshot> {
  const runKey = `${coverageDataRoot(projectPath, globalDataPath)}\n${path.resolve(projectPath)}`;
  const activeRun = coverageRuns.get(runKey);
  if (activeRun) return activeRun;
  const run = executeCoverageRun(projectPath, extensionPath, globalDataPath)
    .finally(() => coverageRuns.delete(runKey));
  coverageRuns.set(runKey, run);
  return run;
}
