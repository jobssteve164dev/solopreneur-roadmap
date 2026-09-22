import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type ExecutionStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

export interface BackendCapabilities {
  headless: true;
  visibleTerminal: false;
  processLifecycle: true;
  durableResume: boolean;
  operatingSystemSandbox: boolean;
  readyForAutonomousWrites: boolean;
}

export interface ExecutionPackage {
  workspacePath: string;
  command: string;
  args?: string[];
  stdin?: string;
  baseRevision: string;
  timeoutMs: number;
}

export interface PreparedExecution {
  preparedId: string;
  workspacePath: string;
  baseRevision: string;
}

export interface ExecutionHandle {
  executionId: string;
  operationId: string;
  preparedId: string;
  workspacePath: string;
  status: ExecutionStatus;
}

export interface CancelResult {
  cancelled: boolean;
  irreversibleSideEffects: string[];
}

export interface ExecutionEvidence {
  executionId: string;
  operationId: string;
  workspacePath: string;
  baseRevision: string;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface ExecutionEvent {
  executionId: string;
  type: 'started' | 'finished';
  occurredAt: string;
  status: ExecutionStatus;
}

export interface ExecutionBackend {
  probe(): Promise<BackendCapabilities>;
  prepare(input: ExecutionPackage): Promise<PreparedExecution>;
  start(preparedId: string, operationId: string): Promise<ExecutionHandle>;
  resume(executionId: string): Promise<ExecutionHandle>;
  cancel(executionId: string): Promise<CancelResult>;
  subscribe(executionId: string, listener: (event: ExecutionEvent) => void): () => void;
  collectEvidence(executionId: string): Promise<ExecutionEvidence>;
}

interface PreparedRecord extends PreparedExecution {
  input: ExecutionPackage;
}

interface ExecutionRecord {
  handle: ExecutionHandle;
  baseRevision: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  cancelRequested: boolean;
  timeoutRequested: boolean;
  child: childProcess.ChildProcessWithoutNullStreams;
  completion: Promise<void>;
  resolveCompletion: () => void;
  listeners: Set<(event: ExecutionEvent) => void>;
}

type BaseRevisionReader = (workspacePath: string) => Promise<string>;

function allowedEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    SystemRoot: process.env.SystemRoot,
    NO_COLOR: '1'
  }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function readGitRevision(workspacePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess.execFile('git', ['rev-parse', 'HEAD'], { cwd: workspacePath, env: allowedEnvironment(), windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Unable to verify the execution base revision: ${String(stderr || error.message).trim()}`));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

function appendBounded(current: string, chunk: unknown, limit: number): string {
  if (current.length >= limit) return current;
  return current + String(chunk).slice(0, limit - current.length);
}

export class HeadlessProcessExecutionBackend implements ExecutionBackend {
  private readonly isolationRoot: string;
  private readonly maxRuntimeMs: number;
  private readonly readBaseRevision: BaseRevisionReader;
  private readonly prepared = new Map<string, PreparedRecord>();
  private readonly executions = new Map<string, ExecutionRecord>();
  private readonly operationExecutions = new Map<string, string>();

  constructor(options: { isolationRoot: string; maxRuntimeMs?: number; readBaseRevision?: BaseRevisionReader }) {
    this.isolationRoot = fs.realpathSync(options.isolationRoot);
    this.maxRuntimeMs = options.maxRuntimeMs || 30 * 60_000;
    this.readBaseRevision = options.readBaseRevision || readGitRevision;
  }

  public async probe(): Promise<BackendCapabilities> {
    return {
      headless: true,
      visibleTerminal: false,
      processLifecycle: true,
      durableResume: false,
      operatingSystemSandbox: false,
      readyForAutonomousWrites: false
    };
  }

  public async prepare(input: ExecutionPackage): Promise<PreparedExecution> {
    const workspacePath = await fs.promises.realpath(input.workspacePath);
    const relativePath = path.relative(this.isolationRoot, workspacePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error('Execution workspace is outside the configured isolation root.');
    }
    const stats = await fs.promises.stat(workspacePath);
    if (!stats.isDirectory()) throw new Error('Execution workspace must be a directory.');
    if (!String(input.command || '').trim()) throw new Error('Execution command is required.');
    if (!String(input.baseRevision || '').trim()) throw new Error('Execution base revision is required.');
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > this.maxRuntimeMs) {
      throw new Error(`Execution timeout must be between 1 and ${this.maxRuntimeMs} milliseconds.`);
    }
    const currentRevision = await this.readBaseRevision(workspacePath);
    if (currentRevision !== input.baseRevision) {
      throw new Error(`Execution base revision changed from ${input.baseRevision} to ${currentRevision}.`);
    }
    const preparedId = crypto.randomUUID();
    const prepared: PreparedRecord = {
      preparedId,
      workspacePath,
      baseRevision: input.baseRevision,
      input: { ...input, workspacePath, args: [...(input.args || [])] }
    };
    this.prepared.set(preparedId, prepared);
    return { preparedId, workspacePath, baseRevision: input.baseRevision };
  }

  public async start(preparedId: string, operationId: string): Promise<ExecutionHandle> {
    const stableOperationId = String(operationId || '').trim();
    if (!stableOperationId) throw new Error('Execution operation ID is required.');
    const existingExecutionId = this.operationExecutions.get(stableOperationId);
    if (existingExecutionId) return this.handleFor(existingExecutionId);
    const prepared = this.prepared.get(preparedId);
    if (!prepared) throw new Error(`Prepared execution not found: ${preparedId}`);
    const currentWorkspacePath = await fs.promises.realpath(prepared.workspacePath);
    if (currentWorkspacePath !== prepared.workspacePath) {
      throw new Error('Prepared execution workspace identity changed before start.');
    }
    const currentRevision = await this.readBaseRevision(currentWorkspacePath);
    if (currentRevision !== prepared.baseRevision) {
      throw new Error(`Execution base revision changed from ${prepared.baseRevision} to ${currentRevision} before start.`);
    }
    const concurrentExecutionId = this.operationExecutions.get(stableOperationId);
    if (concurrentExecutionId) return this.handleFor(concurrentExecutionId);

    const executionId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    let resolveCompletion: () => void = () => {};
    const completion = new Promise<void>(resolve => { resolveCompletion = resolve; });
    const child = childProcess.spawn(prepared.input.command, prepared.input.args || [], {
      cwd: prepared.workspacePath,
      env: allowedEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const handle: ExecutionHandle = {
      executionId,
      operationId: stableOperationId,
      preparedId,
      workspacePath: prepared.workspacePath,
      status: 'running'
    };
    const record: ExecutionRecord = {
      handle,
      baseRevision: prepared.baseRevision,
      startedAt,
      finishedAt: '',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      cancelRequested: false,
      timeoutRequested: false,
      child,
      completion,
      resolveCompletion,
      listeners: new Set()
    };
    this.executions.set(executionId, record);
    this.operationExecutions.set(stableOperationId, executionId);
    this.emit(record, 'started');

    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;
    const finish = (status: ExecutionStatus, exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      record.handle.status = status;
      record.exitCode = exitCode;
      record.signal = signal;
      record.finishedAt = new Date().toISOString();
      this.emit(record, 'finished');
      record.resolveCompletion();
    };
    const timeout = setTimeout(() => {
      record.timeoutRequested = true;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => {
        if (record.handle.status === 'running') child.kill('SIGKILL');
      }, 2_000);
      forceKill.unref();
    }, prepared.input.timeoutMs);
    timeout.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { record.stdout = appendBounded(record.stdout, chunk, 65_536); });
    child.stderr.on('data', chunk => { record.stderr = appendBounded(record.stderr, chunk, 16_384); });
    child.once('error', error => {
      record.stderr = appendBounded(record.stderr, error.message, 16_384);
      finish(record.cancelRequested ? 'cancelled' : record.timeoutRequested ? 'timed_out' : 'failed', null, null);
    });
    child.once('close', (code, signal) => {
      const status = record.cancelRequested ? 'cancelled' : record.timeoutRequested ? 'timed_out' : code === 0 ? 'succeeded' : 'failed';
      finish(status, code, signal);
    });
    child.stdin.end(prepared.input.stdin || '');
    return { ...handle };
  }

  public async resume(executionId: string): Promise<ExecutionHandle> {
    return this.handleFor(executionId);
  }

  public async cancel(executionId: string): Promise<CancelResult> {
    const record = this.recordFor(executionId);
    if (record.handle.status !== 'running') {
      return { cancelled: record.handle.status === 'cancelled', irreversibleSideEffects: ['process_started'] };
    }
    record.cancelRequested = true;
    record.child.kill('SIGTERM');
    const forceKill = setTimeout(() => {
      if (record.handle.status === 'running') record.child.kill('SIGKILL');
    }, 2_000);
    forceKill.unref();
    await record.completion;
    clearTimeout(forceKill);
    return { cancelled: true, irreversibleSideEffects: ['process_started'] };
  }

  public subscribe(executionId: string, listener: (event: ExecutionEvent) => void): () => void {
    const record = this.recordFor(executionId);
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  public async collectEvidence(executionId: string): Promise<ExecutionEvidence> {
    const record = this.recordFor(executionId);
    await record.completion;
    return {
      executionId,
      operationId: record.handle.operationId,
      workspacePath: record.handle.workspacePath,
      baseRevision: record.baseRevision,
      status: record.handle.status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      exitCode: record.exitCode,
      signal: record.signal,
      stdout: record.stdout,
      stderr: record.stderr
    };
  }

  private handleFor(executionId: string): ExecutionHandle {
    return { ...this.recordFor(executionId).handle };
  }

  private recordFor(executionId: string): ExecutionRecord {
    const record = this.executions.get(executionId);
    if (!record) throw new Error(`Execution not found: ${executionId}`);
    return record;
  }

  private emit(record: ExecutionRecord, type: ExecutionEvent['type']): void {
    const event: ExecutionEvent = {
      executionId: record.handle.executionId,
      type,
      occurredAt: new Date().toISOString(),
      status: record.handle.status
    };
    for (const listener of record.listeners) listener(event);
  }
}
