import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { createCoverageMap } from 'istanbul-lib-coverage';

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
}

const coverageCache = new Map<string, { modifiedAt: number; snapshot: ProjectCoverageSnapshot }>();
const coverageRuns = new Map<string, Promise<ProjectCoverageSnapshot>>();

function coverageRoot(projectPath: string): string {
  return path.join(projectPath, '.solopreneur', 'coverage');
}

function coverageCachePath(projectPath: string): string {
  return path.join(coverageRoot(projectPath), 'project-growth-coverage.json');
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

export function loadProjectCoverageSnapshot(projectPath: string): ProjectCoverageSnapshot | null {
  const cachePath = coverageCachePath(projectPath);
  let modifiedAt = 0;
  try {
    modifiedAt = fs.statSync(cachePath).mtimeMs;
  } catch {
    return null;
  }
  const cached = coverageCache.get(projectPath);
  if (cached?.modifiedAt === modifiedAt) return cached.snapshot;
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as unknown;
    if (!isCoverageSnapshot(parsed)) return null;
    coverageCache.set(projectPath, { modifiedAt, snapshot: parsed });
    return parsed;
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

function writeCoverageSnapshot(projectPath: string, snapshot: ProjectCoverageSnapshot): void {
  const cachePath = coverageCachePath(projectPath);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  const modifiedAt = fs.statSync(cachePath).mtimeMs;
  coverageCache.set(projectPath, { modifiedAt, snapshot });
}

function preservePreviousCoverageFailure(
  projectPath: string,
  previous: ProjectCoverageSnapshot | null,
  attemptedAt: string,
  startedAt: number,
  error: string
): ProjectCoverageSnapshot {
  if (!previous) {
    const unavailable = emptyCoverageSnapshot('unavailable', error);
    unavailable.lastAttemptAt = attemptedAt;
    unavailable.durationMs = Date.now() - startedAt;
    writeCoverageSnapshot(projectPath, unavailable);
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
  writeCoverageSnapshot(projectPath, staleSnapshot);
  return staleSnapshot;
}

async function executeCoverageRun(projectPath: string, extensionPath: string): Promise<ProjectCoverageSnapshot> {
  const startedAt = Date.now();
  const attemptedAt = new Date().toISOString();
  const previous = loadProjectCoverageSnapshot(projectPath);
  const testScript = readTestScript(projectPath);
  if (!testScript) {
    return preservePreviousCoverageFailure(projectPath, previous, attemptedAt, startedAt, '项目没有可运行的 npm test 脚本。');
  }
  const coverageNodeExecutable = await resolveCoverageNodeExecutable();
  if (!coverageNodeExecutable) {
    return preservePreviousCoverageFailure(projectPath, previous, attemptedAt, startedAt, '运行验证分析需要 Node.js 20.19 或更高版本。');
  }

  const reportDir = path.join(coverageRoot(projectPath), 'runtime');
  const reportPath = path.join(reportDir, 'coverage-final.json');
  fs.mkdirSync(reportDir, { recursive: true });
  const c8Cli = path.join(extensionPath, 'node_modules', 'c8', 'bin', 'c8.js');
  if (!fs.existsSync(c8Cli)) {
    return preservePreviousCoverageFailure(projectPath, previous, attemptedAt, startedAt, 'SoloMap 覆盖分析组件未安装完整。');
  }
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

  if (!fs.existsSync(reportPath)) {
    const error = result.error?.message || '测试结束后没有生成覆盖报告。';
    return preservePreviousCoverageFailure(projectPath, previous, attemptedAt, startedAt, error);
  }

  try {
    const files = parseIstanbulCoverageReport(projectPath, reportPath);
    const snapshot: ProjectCoverageSnapshot = {
      version: 1,
      provider: 'c8-istanbul',
      status: result.error ? 'test_failed' : 'ready',
      generatedAt: new Date().toISOString(),
      lastAttemptAt: attemptedAt,
      durationMs: Date.now() - startedAt,
      testPassed: !result.error,
      files,
      error: result.error?.message || ''
    };
    writeCoverageSnapshot(projectPath, snapshot);
    return snapshot;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return preservePreviousCoverageFailure(projectPath, previous, attemptedAt, startedAt, message);
  }
}

export function runProjectCoverageAnalysis(projectPath: string, extensionPath: string): Promise<ProjectCoverageSnapshot> {
  const activeRun = coverageRuns.get(projectPath);
  if (activeRun) return activeRun;
  const run = executeCoverageRun(projectPath, extensionPath)
    .finally(() => coverageRuns.delete(projectPath));
  coverageRuns.set(projectPath, run);
  return run;
}

export function clearProjectCoverageCache(projectPath = ''): void {
  if (projectPath) coverageCache.delete(projectPath);
  else coverageCache.clear();
}
