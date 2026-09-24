import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  BackendCapabilities,
  CancelResult,
  ExecutionEvent,
  ExecutionHandle,
  ExecutionPackage,
  ExecutionStatus,
  PreparedExecution
} from './headlessExecutionBackend';
import { ExecutionSandbox, LinuxBubblewrapSandbox, SandboxLaunch } from './executionSandbox';
import { ProjectAutonomyAuthorizationStore } from './projectAutonomyAuthorization';

export interface AuthorizedExecutionPackage extends ExecutionPackage {
  projectPath: string;
  authorizationEpoch: number;
  requestedNetworkAccess?: 'offline';
}

interface PreparedExecutionPackage extends AuthorizedExecutionPackage {
  networkAccess: 'tool' | 'offline';
}

export interface DurableExecutionEvidence {
  executionId: string;
  operationId: string;
  workspacePath: string;
  projectPath: string;
  baseRevision: string;
  authorizationEpoch: number;
  toolNetworkAccess: 'allowed' | 'blocked';
  status: ExecutionStatus;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  terminationReason: string;
  promotionEligible: boolean;
}

interface PreparedRecord extends PreparedExecution {
  input: PreparedExecutionPackage;
  launch: SandboxLaunch;
  executionFingerprint: string;
}

interface DurableState {
  executionId: string;
  operationId: string;
  preparedId: string;
  workspacePath: string;
  projectPath: string;
  baseRevision: string;
  authorizationEpoch: number;
  toolNetworkAccess: 'allowed' | 'blocked';
  status: ExecutionStatus;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  terminationReason: string;
  workerPid: number;
  childPid: number;
  stdoutPath: string;
  stderrPath: string;
  cancelPath: string;
  readyPath: string;
  requestPath: string;
  workerToken: string;
  executionFingerprint: string;
}

interface OperationRecord {
  executionId: string;
  operationId: string;
  preparedId: string;
  projectPath: string;
  baseRevision: string;
  authorizationEpoch: number;
  networkAccess?: 'tool' | 'offline';
  executionFingerprint: string;
}

type BaseRevisionReader = (workspacePath: string) => Promise<string>;

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function processMatchesToken(pid: number, token: string): boolean {
  if (!processAlive(pid) || !token || process.platform !== 'linux') return false;
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(token);
  } catch {
    return false;
  }
}

function executionFingerprint(input: PreparedExecutionPackage): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    projectPath: input.projectPath,
    workspacePath: input.workspacePath,
    baseRevision: input.baseRevision,
    authorizationEpoch: input.authorizationEpoch,
    networkAccess: input.networkAccess,
    command: input.command,
    args: input.args || [],
    stdin: input.stdin || '',
    timeoutMs: input.timeoutMs
  })).digest('hex');
}

function legacyExecutionFingerprint(input: AuthorizedExecutionPackage): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    projectPath: input.projectPath,
    workspacePath: input.workspacePath,
    baseRevision: input.baseRevision,
    authorizationEpoch: input.authorizationEpoch,
    command: input.command,
    args: input.args || [],
    stdin: input.stdin || '',
    timeoutMs: input.timeoutMs
  })).digest('hex');
}

export function recoverDurableExecutionStates(stateRoot: string): ExecutionHandle[] {
  const executionsRoot = path.join(stateRoot, 'executions');
  if (!fs.existsSync(executionsRoot)) return [];
  const handles: ExecutionHandle[] = [];
  for (const entry of fs.readdirSync(executionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const statePath = path.join(executionsRoot, entry.name, 'state.json');
    if (!fs.existsSync(statePath)) continue;
    try {
      let state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as DurableState;
      const missingReadySignal = state.status === 'running' && Boolean(state.readyPath) && !fs.existsSync(state.readyPath);
      const workerAlive = state.workerToken
        ? processMatchesToken(state.workerPid, state.workerToken)
        : processAlive(state.workerPid);
      if (missingReadySignal || (state.status === 'running' && !workerAlive)) {
        if (missingReadySignal && processMatchesToken(state.workerPid, state.workerToken)) {
          try { process.kill(state.workerPid, 'SIGTERM'); } catch { /* The worker may have just exited. */ }
        }
        state = {
          ...state,
          status: 'failed',
          finishedAt: new Date().toISOString(),
          terminationReason: missingReadySignal || !state.workerPid ? 'worker_interrupted_before_ready' : 'worker_interrupted'
        };
        writeJson(statePath, state);
      }
      handles.push({
        executionId: state.executionId,
        operationId: state.operationId,
        preparedId: state.preparedId,
        workspacePath: state.workspacePath,
        status: state.status
      });
    } catch (error) {
      console.error(`SoloMap could not recover durable execution ${entry.name}:`, error);
    }
  }
  return handles;
}

export class DurableSandboxExecutionBackend {
  private readonly isolationRoot: string;
  private readonly stateRoot: string;
  private readonly authorization: ProjectAutonomyAuthorizationStore;
  private readonly sandbox: ExecutionSandbox;
  private readonly readBaseRevision: BaseRevisionReader;
  private readonly pollIntervalMs: number;
  private readonly workerScriptPath: string;
  private readonly prepared = new Map<string, PreparedRecord>();

  constructor(options: {
    isolationRoot: string;
    stateRoot: string;
    authorization: ProjectAutonomyAuthorizationStore;
    sandbox?: ExecutionSandbox;
    readBaseRevision: BaseRevisionReader;
    pollIntervalMs?: number;
    workerScriptPath?: string;
  }) {
    this.isolationRoot = fs.realpathSync(options.isolationRoot);
    this.stateRoot = options.stateRoot;
    this.authorization = options.authorization;
    this.sandbox = options.sandbox || new LinuxBubblewrapSandbox();
    this.readBaseRevision = options.readBaseRevision;
    this.pollIntervalMs = options.pollIntervalMs || 100;
    this.workerScriptPath = options.workerScriptPath || path.join(__dirname, 'durableExecutionWorker.js');
    fs.mkdirSync(this.stateRoot, { recursive: true });
  }

  public async probe(): Promise<BackendCapabilities> {
    const probe = await this.sandbox.probe();
    return {
      headless: true,
      visibleTerminal: false,
      processLifecycle: true,
      durableResume: true,
      operatingSystemSandbox: probe.available,
      readyForAutonomousWrites: probe.available
    };
  }

  public async prepare(input: AuthorizedExecutionPackage): Promise<PreparedExecution> {
    const probe = await this.sandbox.probe();
    if (!probe.available) throw new Error(`Operating-system sandbox unavailable: ${probe.reason}`);
    const projectPath = await fs.promises.realpath(input.projectPath);
    const authorization = this.authorization.get(projectPath);
    if (!authorization.enabled || authorization.epoch !== input.authorizationEpoch) {
      throw new Error('Project authorization is missing, revoked, or stale.');
    }
    const workspacePath = await fs.promises.realpath(input.workspacePath);
    const relative = path.relative(this.isolationRoot, workspacePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Execution workspace is outside the configured isolation root.');
    if (!String(input.command || '').trim()) throw new Error('Execution command is required.');
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) throw new Error('Execution timeout must be positive.');
    const currentRevision = await this.readBaseRevision(workspacePath);
    if (currentRevision !== input.baseRevision) throw new Error(`Execution base revision changed from ${input.baseRevision} to ${currentRevision}.`);
    const preparedId = crypto.randomUUID();
    const networkAccess = authorization.toolNetworkDisabled || input.requestedNetworkAccess === 'offline' ? 'offline' : 'tool';
    const launch = this.sandbox.buildInvocation({ workspacePath, command: input.command, args: input.args || [], networkAccess });
    const normalizedInput: PreparedExecutionPackage = { ...input, projectPath, workspacePath, networkAccess };
    const record = {
      preparedId, workspacePath, baseRevision: input.baseRevision, input: normalizedInput, launch,
      executionFingerprint: executionFingerprint(normalizedInput)
    };
    this.prepared.set(preparedId, record);
    writeJson(this.preparedPath(preparedId), record);
    return { preparedId, workspacePath, baseRevision: input.baseRevision };
  }

  public async start(preparedId: string, operationIdValue: string): Promise<ExecutionHandle> {
    const operationId = String(operationIdValue || '').trim();
    if (!operationId) throw new Error('Execution operation ID is required.');
    const prepared = this.readPrepared(preparedId);
    if (!prepared) throw new Error(`Prepared execution not found: ${preparedId}`);
    if (!this.authorization.isCurrent(prepared.input.projectPath, prepared.input.authorizationEpoch)) throw new Error('Project authorization is missing, revoked, or stale.');
    if (await fs.promises.realpath(prepared.workspacePath) !== prepared.workspacePath) throw new Error('Prepared execution workspace identity changed before start.');
    const currentRevision = await this.readBaseRevision(prepared.workspacePath);
    if (currentRevision !== prepared.baseRevision) throw new Error(`Execution base revision changed from ${prepared.baseRevision} to ${currentRevision} before start.`);

    const operationPath = this.operationPath(prepared.input.projectPath, operationId);
    if (fs.existsSync(operationPath)) return this.handleForOperation(operationPath, prepared, operationId);

    const executionId = crypto.randomUUID();
    const directory = path.join(this.stateRoot, 'executions', executionId);
    const statePath = path.join(directory, 'state.json');
    const requestPath = path.join(directory, 'request.json');
    const readyPath = path.join(directory, 'worker-ready');
    const cancelPath = path.join(directory, 'cancel-requested');
    const workerToken = crypto.randomUUID();
    const state: DurableState = {
      executionId, operationId, preparedId, workspacePath: prepared.workspacePath,
      projectPath: prepared.input.projectPath, baseRevision: prepared.baseRevision,
      authorizationEpoch: prepared.input.authorizationEpoch, status: 'running',
      toolNetworkAccess: prepared.input.networkAccess === 'offline' ? 'blocked' : 'allowed',
      startedAt: new Date().toISOString(), finishedAt: '', exitCode: null, signal: null,
      terminationReason: '', workerPid: 0, childPid: 0,
      stdoutPath: path.join(directory, 'stdout.log'), stderrPath: path.join(directory, 'stderr.log'),
      cancelPath, readyPath, requestPath, workerToken, executionFingerprint: prepared.executionFingerprint
    };
    writeJson(statePath, state);
    writeJson(requestPath, {
      statePath,
      authorizationFile: this.authorization.filePath,
      projectPath: prepared.input.projectPath,
      authorizationEpoch: prepared.input.authorizationEpoch,
      timeoutMs: prepared.input.timeoutMs,
      stdin: prepared.input.stdin || '',
      readyPath,
      cancelPath,
      workerToken,
      launch: prepared.launch
    });
    const operation: OperationRecord = {
      executionId, operationId, preparedId, projectPath: prepared.input.projectPath,
      baseRevision: prepared.baseRevision, authorizationEpoch: prepared.input.authorizationEpoch,
      networkAccess: prepared.input.networkAccess,
      executionFingerprint: prepared.executionFingerprint
    };
    fs.mkdirSync(path.dirname(operationPath), { recursive: true });
    try {
      fs.writeFileSync(operationPath, JSON.stringify(operation), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      writeJson(statePath, { ...state, status: 'failed', finishedAt: new Date().toISOString(), terminationReason: 'duplicate_operation' });
      return this.handleForOperation(operationPath, prepared, operationId);
    }
    try {
      const worker = childProcess.spawn(process.execPath, [this.workerScriptPath, requestPath, workerToken], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1' }
      });
      if (!worker.pid) throw new Error('Durable execution worker did not return a process ID.');
      writeJson(statePath, { ...state, workerPid: worker.pid });
      fs.writeFileSync(readyPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      worker.unref();
    } catch (error) {
      writeJson(statePath, { ...state, status: 'failed', finishedAt: new Date().toISOString(), terminationReason: 'worker_start_failed' });
      throw error;
    }
    return this.handleFor(executionId);
  }

  public async resume(executionId: string): Promise<ExecutionHandle> {
    const state = this.readState(executionId);
    const missingReadySignal = state.status === 'running' && Boolean(state.readyPath) && !fs.existsSync(state.readyPath);
    const workerAlive = state.workerToken
      ? processMatchesToken(state.workerPid, state.workerToken)
      : processAlive(state.workerPid);
    if (missingReadySignal || (state.status === 'running' && !workerAlive)) {
      if (missingReadySignal && processMatchesToken(state.workerPid, state.workerToken)) {
        try { process.kill(state.workerPid, 'SIGTERM'); } catch { /* The worker may have just exited. */ }
      }
      writeJson(this.statePath(executionId), {
        ...state, status: 'failed', finishedAt: new Date().toISOString(),
        terminationReason: missingReadySignal || !state.workerPid ? 'worker_interrupted_before_ready' : 'worker_interrupted'
      });
    }
    return this.handleFor(executionId);
  }

  public async cancel(executionId: string): Promise<CancelResult> {
    const state = this.readState(executionId);
    if (state.status !== 'running') return { cancelled: state.status === 'cancelled', irreversibleSideEffects: ['process_started'] };
    fs.writeFileSync(state.cancelPath, '', { encoding: 'utf8', flag: 'a', mode: 0o600 });
    await this.waitForTerminal(executionId);
    return { cancelled: true, irreversibleSideEffects: ['process_started'] };
  }

  public subscribe(executionId: string, listener: (event: ExecutionEvent) => void): () => void {
    let previous = this.readState(executionId).status;
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      const current = this.readState(executionId).status;
      if (current !== previous) {
        previous = current;
        listener({ executionId, type: current === 'running' ? 'started' : 'finished', occurredAt: new Date().toISOString(), status: current });
      }
      if (current !== 'running') clearInterval(timer);
    }, this.pollIntervalMs);
    timer.unref();
    return () => { stopped = true; clearInterval(timer); };
  }

  public async collectEvidence(executionId: string): Promise<DurableExecutionEvidence> {
    const state = await this.waitForTerminal(executionId);
    const currentAuthorization = this.authorization.isCurrent(state.projectPath, state.authorizationEpoch);
    return {
      executionId, operationId: state.operationId, workspacePath: state.workspacePath,
      projectPath: state.projectPath, baseRevision: state.baseRevision, authorizationEpoch: state.authorizationEpoch,
      toolNetworkAccess: state.toolNetworkAccess,
      status: state.status, startedAt: state.startedAt, finishedAt: state.finishedAt,
      exitCode: state.exitCode, signal: state.signal,
      stdout: fs.existsSync(state.stdoutPath) ? fs.readFileSync(state.stdoutPath, 'utf8').slice(0, 65_536) : '',
      stderr: fs.existsSync(state.stderrPath) ? fs.readFileSync(state.stderrPath, 'utf8').slice(0, 16_384) : '',
      terminationReason: state.terminationReason,
      promotionEligible: state.status === 'succeeded' && currentAuthorization
    };
  }

  private async waitForTerminal(executionId: string): Promise<DurableState> {
    while (true) {
      const state = this.readState(executionId);
      if (state.status !== 'running') return state;
      if (state.workerPid && !processAlive(state.workerPid)) return this.readState((await this.resume(executionId)).executionId);
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  private handleFor(executionId: string): ExecutionHandle {
    const state = this.readState(executionId);
    return { executionId, operationId: state.operationId, preparedId: state.preparedId, workspacePath: state.workspacePath, status: state.status };
  }

  private handleForOperation(operationPath: string, prepared: PreparedRecord, operationId: string): ExecutionHandle {
    const operation = JSON.parse(fs.readFileSync(operationPath, 'utf8')) as OperationRecord;
    const fingerprintMatches = operation.executionFingerprint === prepared.executionFingerprint
      || (operation.networkAccess === undefined
        && operation.executionFingerprint === legacyExecutionFingerprint(prepared.input));
    if (operation.operationId !== operationId
      || operation.projectPath !== prepared.input.projectPath || operation.baseRevision !== prepared.baseRevision
      || operation.authorizationEpoch !== prepared.input.authorizationEpoch
      || !fingerprintMatches) {
      throw new Error('Execution operation identity does not match the prepared project request.');
    }
    if (!this.authorization.isCurrent(operation.projectPath, operation.authorizationEpoch)) {
      throw new Error('Project authorization is missing, revoked, or stale.');
    }
    return this.handleFor(operation.executionId);
  }

  private operationPath(projectPath: string, operationId: string): string {
    const identity = `${projectPath}\0${operationId}`;
    return path.join(this.stateRoot, 'operations', `${crypto.createHash('sha256').update(identity).digest('hex')}.json`);
  }

  private preparedPath(preparedId: string): string {
    return path.join(this.stateRoot, 'prepared', `${preparedId}.json`);
  }

  private readPrepared(preparedId: string): PreparedRecord | undefined {
    const inMemory = this.prepared.get(preparedId);
    if (inMemory) return inMemory;
    const preparedPath = this.preparedPath(preparedId);
    if (!fs.existsSync(preparedPath)) return undefined;
    const record = JSON.parse(fs.readFileSync(preparedPath, 'utf8')) as PreparedRecord;
    if (record.preparedId !== preparedId) throw new Error('Persisted prepared execution identity is invalid.');
    if (!record.input.networkAccess) {
      record.input.networkAccess = record.launch.args.includes('--unshare-net') ? 'offline' : 'tool';
      record.executionFingerprint = executionFingerprint(record.input);
    }
    this.prepared.set(preparedId, record);
    return record;
  }

  private statePath(executionId: string): string {
    return path.join(this.stateRoot, 'executions', executionId, 'state.json');
  }

  private readState(executionId: string): DurableState {
    const statePath = this.statePath(executionId);
    if (!fs.existsSync(statePath)) throw new Error(`Execution not found: ${executionId}`);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as DurableState;
    return {
      ...state,
      toolNetworkAccess: state.toolNetworkAccess === 'allowed' ? 'allowed' : 'blocked'
    };
  }
}
