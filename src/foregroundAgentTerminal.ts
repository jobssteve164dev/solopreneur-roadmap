import * as childProcess from 'child_process';
import * as path from 'path';
import { ForegroundTerminalReconnectClient, type ForegroundTerminalReconnectEndpoint } from './foregroundTerminalReconnect';

export interface ForegroundRunnerIdentity {
  extensionOutputRoot: string;
  globalDataPath: string;
  workspaceRoot: string;
  executionLogId: number;
  deliveryId: string;
  traceId: string;
  interactionId: string;
  acceptedAtMs: number;
  terminalColumns?: number;
  terminalRows?: number;
  environment?: NodeJS.ProcessEnv;
}

export interface ForegroundRunnerInvocation {
  executable: string;
  args: string[];
  options: childProcess.SpawnOptions;
}

export function buildForegroundRunnerInvocation(identity: ForegroundRunnerIdentity, baseEnvironment: NodeJS.ProcessEnv = process.env): ForegroundRunnerInvocation {
  return {
    executable: process.execPath,
    args: [
      path.join(identity.extensionOutputRoot, 'runAgentProcess.js'),
      '--global-data-path', identity.globalDataPath,
      '--project-path', identity.workspaceRoot,
      '--execution-log-id', String(identity.executionLogId)
    ],
    options: {
      cwd: identity.workspaceRoot,
      detached: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...baseEnvironment,
        ...identity.environment,
        ELECTRON_RUN_AS_NODE: '1',
        SOLOMAP_TERMINAL_DELIVERY_ID: identity.deliveryId,
        SOLOMAP_DIAGNOSTIC_TRACE_ID: identity.traceId,
        SOLOMAP_INTERACTION_ID: identity.interactionId,
        SOLOMAP_DELIVERY_STARTED_AT: String(identity.acceptedAtMs),
        SOLOMAP_TERMINAL_COLUMNS: String(Math.max(20, Math.min(1000, Math.floor(Number(identity.terminalColumns) || 120)))),
        SOLOMAP_TERMINAL_ROWS: String(Math.max(5, Math.min(500, Math.floor(Number(identity.terminalRows) || 30))))
      }
    }
  };
}

type SpawnedRunner = childProcess.ChildProcess;
type SpawnRunner = (executable: string, args: readonly string[], options: childProcess.SpawnOptions) => SpawnedRunner;
type OutputConsumer = (bytes: Buffer) => void;

const MAX_DETACHED_OUTPUT_BYTES = 4 * 1024 * 1024;

export type ForegroundTerminalInputMode = 'prompt_turn' | 'session_reentry' | 'closed';

export interface ForegroundAgentTerminalTransport {
  attachOutput(consumer: OutputConsumer): () => void;
  writeInputFrame(bytes: Buffer): Promise<void>;
  detachForHostReload(): void;
  onExit(consumer: (exitCode?: number) => void): () => void;
  stop(signal?: NodeJS.Signals): boolean | void;
  readonly pid?: number;
  readonly isRunning: boolean;
}

export function settleForegroundTerminalExit(
  _inputMode: ForegroundTerminalInputMode,
  _exitCode: number | undefined,
  write: (value: string) => void,
  _close: (value: number | undefined) => void
): 'retained' | 'closed' {
  write('\r\nSoloMap: 任务已结束，可关闭此终端。\r\n');
  return 'retained';
}

export class ForegroundAgentTerminalBridge implements ForegroundAgentTerminalTransport {
  private child?: SpawnedRunner;
  private consumer?: OutputConsumer;
  private bufferedOutput: Buffer[] = [];
  private bufferedBytes = 0;
  private inputTail: Promise<void> = Promise.resolve();
  private running = false;
  private readonly exitConsumers = new Set<(exitCode?: number) => void>();

  constructor(
    private readonly invocation: ForegroundRunnerInvocation,
    private readonly spawnRunner: SpawnRunner = childProcess.spawn
  ) {}

  start(): SpawnedRunner {
    if (this.child) return this.child;
    const child = this.spawnRunner(this.invocation.executable, this.invocation.args, this.invocation.options);
    this.child = child;
    this.running = true;
    const forward = (value: Buffer | string) => this.forwardOutput(Buffer.isBuffer(value) ? value : Buffer.from(value));
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
    const ended = (exitCode?: number | null) => {
      if (!this.running) return;
      this.running = false;
      for (const consumer of this.exitConsumers) consumer(exitCode === null ? undefined : exitCode);
    };
    child.once('close', ended);
    child.once('error', ended);
    return child;
  }

  attachOutput(consumer: OutputConsumer): () => void {
    this.consumer = consumer;
    const buffered = this.bufferedOutput;
    this.bufferedOutput = [];
    this.bufferedBytes = 0;
    for (const bytes of buffered) consumer(bytes);
    return () => {
      if (this.consumer === consumer) this.consumer = undefined;
    };
  }

  writeInputFrame(bytes: Buffer): Promise<void> {
    const frame = Buffer.from(bytes);
    const pending = this.inputTail.then(() => this.writeFrame(frame));
    this.inputTail = pending.catch(() => undefined);
    return pending;
  }

  detachForHostReload(): void {
    this.consumer = undefined;
  }

  onExit(consumer: (exitCode?: number) => void): () => void {
    this.exitConsumers.add(consumer);
    return () => this.exitConsumers.delete(consumer);
  }

  stop(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (!this.child || !this.running) return false;
    return this.child.kill(signal);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private forwardOutput(bytes: Buffer): void {
    if (this.consumer) {
      this.consumer(bytes);
      return;
    }
    this.bufferedOutput.push(Buffer.from(bytes));
    this.bufferedBytes += bytes.length;
    while (this.bufferedBytes > MAX_DETACHED_OUTPUT_BYTES && this.bufferedOutput.length > 1) {
      this.bufferedBytes -= this.bufferedOutput.shift()!.length;
    }
  }

  private writeFrame(bytes: Buffer): Promise<void> {
    const stdin = this.child?.stdin;
    if (!this.child || !this.running || !stdin || stdin.destroyed) return Promise.reject(new Error('foreground_runner_not_running'));
    return new Promise<void>((resolve, reject) => {
      try {
        stdin.write(bytes, error => error ? reject(error) : resolve());
      } catch (error) {
        reject(error);
      }
    });
  }
}

export class ReconnectedForegroundAgentTerminalBridge implements ForegroundAgentTerminalTransport {
  private readonly client: ForegroundTerminalReconnectClient;
  private consumer?: OutputConsumer;
  private bufferedOutput: Buffer[];
  private running = false;
  private exited = false;
  private bufferedOutputBytes = 0;
  private readonly exitConsumers = new Set<(exitCode?: number) => void>();

  constructor(private readonly endpoint: ForegroundTerminalReconnectEndpoint, replay: Buffer, sinceOffset: number) {
    this.bufferedOutput = replay.length ? [Buffer.from(replay)] : [];
    this.bufferedOutputBytes = replay.length;
    this.client = new ForegroundTerminalReconnectClient(endpoint, sinceOffset);
    this.client.onOutput(bytes => this.forwardOutput(bytes));
    this.client.onExit(code => {
      if (this.exited) return;
      this.exited = true;
      this.running = false;
      for (const consumer of this.exitConsumers) consumer(code);
    });
    this.client.onDisconnect(() => { this.running = false; });
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.running = !this.exited && this.client.isConnected;
  }

  attachOutput(consumer: OutputConsumer): () => void {
    this.consumer = consumer;
    const buffered = this.bufferedOutput; this.bufferedOutput = []; this.bufferedOutputBytes = 0;
    for (const bytes of buffered) consumer(bytes);
    return () => { if (this.consumer === consumer) this.consumer = undefined; };
  }

  writeInputFrame(bytes: Buffer): Promise<void> { return this.client.writeInput(bytes); }
  detachForHostReload(): void { this.consumer = undefined; this.client.disconnect(); this.running = false; }
  onExit(consumer: (exitCode?: number) => void): () => void { this.exitConsumers.add(consumer); return () => this.exitConsumers.delete(consumer); }
  stop(signal: NodeJS.Signals = 'SIGTERM'): void { void this.client.stop(signal); }
  get pid(): number { return this.endpoint.runnerPid; }
  get isRunning(): boolean { return this.running; }

  private forwardOutput(bytes: Buffer): void {
    if (this.consumer) this.consumer(bytes);
    else {
      const copy = Buffer.from(bytes);
      this.bufferedOutput.push(copy); this.bufferedOutputBytes += copy.length;
      while (this.bufferedOutputBytes > MAX_DETACHED_OUTPUT_BYTES && this.bufferedOutput.length > 1) {
        this.bufferedOutputBytes -= this.bufferedOutput.shift()!.length;
      }
      if (this.bufferedOutputBytes > MAX_DETACHED_OUTPUT_BYTES && this.bufferedOutput.length === 1) {
        this.bufferedOutput[0] = this.bufferedOutput[0].subarray(this.bufferedOutputBytes - MAX_DETACHED_OUTPUT_BYTES);
        this.bufferedOutputBytes = this.bufferedOutput[0].length;
      }
    }
  }
}
