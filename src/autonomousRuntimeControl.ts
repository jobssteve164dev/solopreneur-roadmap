import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import { RuntimeExecutionScheduler } from './runtimePriorityScheduler';
import { runtimeOperationDefinition } from './runtimeOperationRegistry';

export type RuntimeControlCommand = 'health' | 'refresh' | 'pause' | 'resume' | 'drain' | 'stop';

export interface RuntimeControlResponse {
  ok: boolean;
  runtimeId: string;
  status: string;
  entryPath?: string;
  buildId?: string;
  releaseVersion?: string;
  owner?: string;
  error?: string;
}

export interface RuntimeDataRequest {
  operation: string;
  input: Record<string, unknown>;
  sessionToken?: string;
  piToolFence?: { operationId: string; invocationId: string; ownerId: string; ownerGeneration: number };
}

export function isRuntimeDataTransportError(error: unknown): boolean {
  const failure = error as NodeJS.ErrnoException;
  return ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(String(failure?.code))
    || error instanceof SyntaxError
    || ['Invalid Runtime endpoint.', 'different_runtime', 'runtime_data_response_incomplete',
      'Runtime data service is unavailable.'].includes(String(failure?.message));
}

interface RuntimeControlEndpoint {
  schemaVersion: 1;
  runtimeId: string;
  host: '127.0.0.1';
  port: number;
  token: string;
  entryPath?: string;
  pid?: number;
  status?: string;
  startedAt?: string;
  heartbeatAt?: string;
  databaseId?: string;
  buildId?: string;
  releaseVersion?: string;
}

interface RuntimeBusyLease {
  schemaVersion: 1;
  runtimeId: string;
  entryPath: string;
  buildId: string;
  releaseVersion: string;
  busySince: string;
}

interface RuntimeControlServerOptions {
  globalDataPath: string;
  runtimeId: string;
  entryPath?: string;
  buildId?: string;
  releaseVersion?: string;
  owner?: string;
  enforceOperationRegistry?: boolean;
  onCommand(command: RuntimeControlCommand, replacement?: { buildId: string; releaseVersion: string }): RuntimeControlResponse | Pick<RuntimeControlResponse, 'status'> | Promise<RuntimeControlResponse | Pick<RuntimeControlResponse, 'status'>>;
  onData?(request: RuntimeDataRequest): unknown | Promise<unknown>;
}

function compareReleaseVersions(left: string, right: string): number {
  if (!/^\d+\.\d+\.\d+$/.test(left) || !/^\d+\.\d+\.\d+$/.test(right)) throw new Error('runtime_replacement_unverified');
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function endpointPath(globalDataPath: string): string {
  return path.join(normalizeGlobalDataPathForExtension(globalDataPath), 'runtime', 'control.json');
}

async function readReadyEndpoint(globalDataPath: string, timeoutMs = 3_000, expectedRuntimeId?: string): Promise<RuntimeControlEndpoint> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error('Invalid Runtime endpoint.');
  do {
    try {
      const endpoint = JSON.parse(await fs.promises.readFile(endpointPath(globalDataPath), 'utf8')) as RuntimeControlEndpoint;
      if (expectedRuntimeId && endpoint.runtimeId && endpoint.runtimeId !== expectedRuntimeId) throw new Error('different_runtime');
      if (endpoint.schemaVersion === 1 && endpoint.runtimeId && endpoint.host === '127.0.0.1' && Number.isInteger(endpoint.port) && endpoint.token) return endpoint;
      lastError = new Error('Invalid Runtime endpoint.');
    } catch (error) {
      if ((error as Error).message === 'different_runtime') throw error;
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (true);
  throw lastError instanceof Error && (lastError as NodeJS.ErrnoException).code !== 'ENOENT' ? lastError : new Error('Invalid Runtime endpoint.');
}

function writeEndpoint(filePath: string, endpoint: RuntimeControlEndpoint): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let previous: Partial<RuntimeControlEndpoint> = {};
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as RuntimeControlEndpoint;
    if (value.runtimeId === endpoint.runtimeId) previous = value;
  } catch { /* The first owner has no discovery record yet. */ }
  fs.writeFileSync(temporaryPath, JSON.stringify({ ...previous, ...endpoint, pid: previous.pid || process.pid, status: previous.status || 'running', heartbeatAt: previous.heartbeatAt || new Date().toISOString() }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    // Only this invocation's newly created temporary endpoint may be removed.
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    throw error;
  }
}

function writeBusyLease(filePath: string, lease: RuntimeBusyLease): void {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(lease), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    throw error;
  }
}

function clearOwnedBusyLease(filePath: string, runtimeId: string): void {
  try {
    const lease = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<RuntimeBusyLease>;
    if (lease.runtimeId === runtimeId) fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function startRuntimeControlServer(options: RuntimeControlServerOptions): Promise<{ beginBusy(): () => void; close(): Promise<void> }> {
  const token = crypto.randomBytes(32).toString('hex');
  const filePath = endpointPath(options.globalDataPath);
  const busyFilePath = path.join(path.dirname(filePath), 'control.busy.json');
  const connections = new Set<net.Socket>();
  const busy = new Map<net.Socket, number>();
  let internalBusy = 0;
  let acceptedWork = 0;
  const acceptedWorkWaiters = new Set<() => void>();
  let closing = false;
  let endpoint: RuntimeControlEndpoint;
  const dataScheduler = new RuntimeExecutionScheduler();
  const acquireBusyLease = () => {
    if (busy.size === 0 && internalBusy === 0) writeBusyLease(busyFilePath, {
      schemaVersion: 1,
      runtimeId: options.runtimeId,
      entryPath: String(options.entryPath || ''),
      buildId: String(options.buildId || ''),
      releaseVersion: String(options.releaseVersion || ''),
      busySince: new Date().toISOString()
    });
  };
  const clearIdleBusyLease = () => {
    if (busy.size === 0 && internalBusy === 0) {
      try { clearOwnedBusyLease(busyFilePath, options.runtimeId); } catch { /* bounded stale marker */ }
    }
  };
  const beginSocketWork = (socket: net.Socket) => {
    acquireBusyLease();
    busy.set(socket, (busy.get(socket) || 0) + 1);
    acceptedWork += 1;
  };
  const finishSocketWork = (socket: net.Socket) => {
    const remaining = (busy.get(socket) || 1) - 1;
    if (remaining > 0) busy.set(socket, remaining);
    else busy.delete(socket);
    acceptedWork = Math.max(0, acceptedWork - 1);
    if (acceptedWork === 0) {
      for (const resolve of acceptedWorkWaiters) resolve();
      acceptedWorkWaiters.clear();
    }
    clearIdleBusyLease();
    if (closing && !busy.has(socket)) setImmediate(() => {
      if (!busy.has(socket)) socket.destroySoon();
    });
  };
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.once('close', () => { connections.delete(socket); clearIdleBusyLease(); });
    socket.on('error', () => {});
    socket.setTimeout(5_000, () => socket.destroy());
    socket.setEncoding('utf8');
    let request = '';
    let authenticated = false;
    socket.on('data', (chunk) => {
      request += chunk;
      if (!authenticated && request.length > 65_536) {
        const prefix = /^\s*\{\s*"token"\s*:\s*"([^"\\]*)"/.exec(request.slice(0, 4096));
        const provided = Buffer.from(prefix?.[1] || '');
        const expected = Buffer.from(token);
        if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
          socket.destroy();
          return;
        }
        authenticated = true;
        socket.setTimeout(0);
      }
      if (request.length > 16 * 1024 * 1024) { socket.destroy(); return; }
      for (;;) {
        const frameEnd = request.indexOf('\n');
        if (frameEnd < 0) return;
        const frame = request.slice(0, frameEnd);
        request = request.slice(frameEnd + 1);
        void (async () => {
          let requestId = '';
          let persistent = false;
          const respond = (payload: Record<string, unknown>) => {
            const framed = JSON.stringify({ ...payload, ...(requestId ? { requestId } : {}) }) + '\n';
            if (persistent && !socket.destroyed) socket.write(framed);
            else socket.end(framed);
          };
          try {
        const parsed = JSON.parse(frame) as { token?: string; command?: RuntimeControlCommand | 'data'; expectedRuntimeId?: string; replacementBuildId?: string; replacementVersion?: string; requestId?: string; request?: RuntimeDataRequest };
        requestId = String(parsed.requestId || '');
        persistent = parsed.command === 'data' && Boolean(requestId);
        const providedToken = Buffer.from(String(parsed.token || ''));
        const expectedToken = Buffer.from(token);
        if (providedToken.length !== expectedToken.length || !crypto.timingSafeEqual(providedToken, expectedToken)) {
          respond({ ok: false, runtimeId: options.runtimeId, status: 'rejected', error: 'Runtime control authentication failed.' });
          return;
        }
        authenticated = true;
        if (persistent) socket.setTimeout(0);
        const command = parsed.command;
        if (!command || !['health', 'refresh', 'pause', 'resume', 'drain', 'stop', 'data'].includes(command)) {
          respond({ ok: false, runtimeId: options.runtimeId, status: 'rejected', error: 'Unknown Runtime control command.' });
          return;
        }
        if (parsed.expectedRuntimeId && parsed.expectedRuntimeId !== options.runtimeId) {
          respond({ ok: false, runtimeId: options.runtimeId, status: 'rejected', error: 'different_runtime' });
          return;
        }
        if (command === 'drain' && options.buildId) {
          let replacementError = '';
          if (!parsed.replacementBuildId || options.releaseVersion && !parsed.replacementVersion) replacementError = 'runtime_replacement_unverified';
          else if (options.releaseVersion && parsed.replacementVersion) {
            const comparison = compareReleaseVersions(parsed.replacementVersion, options.releaseVersion);
            if (comparison < 0) replacementError = 'runtime_downgrade_rejected';
            else if (comparison === 0 && parsed.replacementBuildId !== options.buildId) replacementError = 'runtime_same_version_build_conflict';
          }
          if (replacementError) {
            respond({ ok: false, runtimeId: options.runtimeId, status: 'rejected', error: replacementError });
            return;
          }
        }
        if (command === 'data') {
          if (!options.onData || !parsed.request) throw new Error('Runtime data service is unavailable.');
          // Accepted work must finish even when a backup or export outlives a control timeout.
          socket.setTimeout(0);
          beginSocketWork(socket);
          let result: unknown;
          try {
            const domain = options.enforceOperationRegistry
              ? runtimeOperationDefinition(parsed.request.operation).domain
              : (() => { try { return runtimeOperationDefinition(parsed.request!.operation).domain; } catch { return 'background-query' as const; } })();
            result = await dataScheduler.submit(domain, () => Promise.resolve(options.onData!(parsed.request!)));
          }
          finally {
            // Clearing a completed-work marker must not replace the operation's
            // result or root error. A failed unlink remains bounded by the
            // host-side lease age and cannot impersonate another Runtime.
            finishSocketWork(socket);
          }
          respond({ ok: true, runtimeId: options.runtimeId, result });
          return;
        }
        const replacement = command === 'drain' && parsed.replacementBuildId && parsed.replacementVersion
          ? { buildId: parsed.replacementBuildId, releaseVersion: parsed.replacementVersion }
          : undefined;
        const result = await options.onCommand(command, replacement);
        respond({ ok: true, runtimeId: options.runtimeId, ...result, entryPath: options.entryPath, buildId: options.buildId, releaseVersion: options.releaseVersion, owner: options.owner });
      } catch (error) {
        respond({
          ok: false,
          runtimeId: options.runtimeId,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error)
        });
      }
        })();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Runtime control server did not bind a local TCP port.');
  endpoint = {
    schemaVersion: 1,
    runtimeId: options.runtimeId,
    host: '127.0.0.1',
    port: address.port,
    token,
    entryPath: options.entryPath,
    buildId: options.buildId,
    releaseVersion: options.releaseVersion
  };
  try { writeEndpoint(filePath, endpoint); } catch (error) {
    connections.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
  return {
    beginBusy: () => {
      acquireBusyLease();
      internalBusy++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        internalBusy--;
        clearIdleBusyLease();
      };
    },
    close: async () => {
      closing = true;
      const closePromise = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      const forceCloseTimer = setTimeout(() => connections.forEach(socket => { if (!busy.has(socket)) socket.destroy(); }), 100);
      forceCloseTimer.unref();
      await closePromise;
      clearTimeout(forceCloseTimer);
      if (acceptedWork > 0) await new Promise<void>(resolve => acceptedWorkWaiters.add(resolve));
      try {
        const current = JSON.parse(fs.readFileSync(filePath, 'utf8')) as RuntimeControlEndpoint;
        if (current.runtimeId === options.runtimeId) fs.unlinkSync(filePath);
      } catch {
        // A newer Runtime may already own the endpoint.
      }
    }
  };
}

interface RuntimeDataResponse {
  requestId?: string;
  ok: boolean;
  runtimeId: string;
  result?: unknown;
  error?: string;
}

type RuntimeDataTransportError = Error & {
  runtimeDataPreconnect?: boolean;
  runtimeDataPrewrite?: boolean;
  runtimeDataAmbiguous?: boolean;
};

function taggedRuntimeDataError(message: string, tag: keyof Pick<RuntimeDataTransportError, 'runtimeDataPrewrite' | 'runtimeDataAmbiguous'>): RuntimeDataTransportError {
  return Object.assign(new Error(message), { [tag]: true });
}

class RuntimeDataConnection {
  private readonly socket: net.Socket;
  private readonly ready: Promise<void>;
  private responseBuffer = '';
  private connected = false;
  private settled = false;
  private activeRequests = 0;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();

  constructor(
    readonly endpoint: RuntimeControlEndpoint,
    private readonly onClosed: (connection: RuntimeDataConnection) => void
  ) {
    this.socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    this.socket.setEncoding('utf8');
    this.socket.unref();
    this.ready = new Promise<void>((resolve, reject) => {
      this.socket.once('connect', () => { this.connected = true; resolve(); });
      this.socket.once('error', error => {
        if (!this.connected) Object.assign(error, { runtimeDataPreconnect: true });
        reject(error);
        this.fail(error);
      });
    });
    this.socket.on('data', chunk => this.receive(String(chunk)));
    this.socket.once('end', () => {
      // Runtime versions before the multiplexed protocol closed a one-shot
      // socket after a complete JSON response without a trailing newline.
      // Consume that final frame so a rolling handover remains compatible.
      if (this.responseBuffer.trim()) this.receive('\n');
      this.fail(taggedRuntimeDataError('runtime_data_response_incomplete', 'runtimeDataAmbiguous'));
    });
    this.socket.once('close', () => this.fail(taggedRuntimeDataError('runtime_data_response_incomplete', 'runtimeDataAmbiguous')));
  }

  private receive(chunk: string): void {
    this.responseBuffer += chunk;
    for (;;) {
      const frameEnd = this.responseBuffer.indexOf('\n');
      if (frameEnd < 0) return;
      const frame = this.responseBuffer.slice(0, frameEnd);
      this.responseBuffer = this.responseBuffer.slice(frameEnd + 1);
      let response: RuntimeDataResponse;
      try { response = JSON.parse(frame) as RuntimeDataResponse; }
      catch { this.fail(taggedRuntimeDataError('runtime_data_response_incomplete', 'runtimeDataAmbiguous')); return; }
      let requestId = String(response.requestId || '');
      // A pre-multiplex Runtime has no requestId because it accepts exactly
      // one request per connection. Rolling upgrades may briefly connect to
      // that owner, so the sole in-flight request remains unambiguous.
      if (!requestId && this.pending.size === 1) requestId = this.pending.keys().next().value as string;
      const pending = this.pending.get(requestId);
      if (!pending) continue;
      this.pending.delete(requestId);
      if (!response.ok || response.runtimeId !== this.endpoint.runtimeId) pending.reject(new Error(response.error || 'different_runtime'));
      else pending.resolve(response.result);
    }
  }

  private fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.onClosed(this);
  }

  async request<T>(request: RuntimeDataRequest): Promise<T> {
    this.activeRequests += 1;
    this.socket.ref();
    try {
      await this.ready;
      if (this.settled || this.socket.destroyed) throw taggedRuntimeDataError('runtime_data_response_incomplete', 'runtimeDataPrewrite');
      const requestId = crypto.randomUUID();
      return await new Promise<T>((resolve, reject) => {
        this.pending.set(requestId, { resolve: value => resolve(value as T), reject });
        const frame = JSON.stringify({
          token: this.endpoint.token,
          command: 'data',
          expectedRuntimeId: this.endpoint.runtimeId,
          requestId,
          request
        }) + '\n';
        try {
          this.socket.write(frame, error => {
            if (!error) return;
            this.pending.delete(requestId);
            reject(Object.assign(error, { runtimeDataAmbiguous: true }));
          });
        } catch (error) {
          this.pending.delete(requestId);
          reject(error instanceof Error ? Object.assign(error, { runtimeDataAmbiguous: true }) : error);
        }
      });
    } finally {
      this.activeRequests -= 1;
      if (this.activeRequests === 0) this.socket.unref();
    }
  }
}

function runtimeDataRequestReplaySafe(request: RuntimeDataRequest): boolean {
  try {
    const replay = runtimeOperationDefinition(request.operation).replay;
    if (replay === 'safe') return true;
    if (replay === 'never') return false;
    if (replay === 'open-request-id') {
      const input = request.input as Record<string, unknown>;
      return typeof input.openRequestId === 'string' && input.openRequestId.length > 0;
    }
  } catch {
    // Unknown fixture and future operations are writes unless they declare an idempotency contract.
  }
  const input = request.input as Record<string, unknown>;
  return typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0;
}

const runtimeDataConnections = new Map<string, Promise<RuntimeDataConnection>>();

async function runtimeDataConnection(globalDataPath: string): Promise<RuntimeDataConnection> {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  let connection = runtimeDataConnections.get(root);
  if (!connection) {
    connection = readReadyEndpoint(root).then(endpoint => {
      const value = new RuntimeDataConnection(endpoint, _closed => {
        if (runtimeDataConnections.get(root) === connection) runtimeDataConnections.delete(root);
      });
      return value;
    }).catch(error => {
      if (runtimeDataConnections.get(root) === connection) runtimeDataConnections.delete(root);
      throw error;
    });
    runtimeDataConnections.set(root, connection);
  }
  return connection;
}

export async function sendRuntimeDataRequest<T>(globalDataPath: string, request: RuntimeDataRequest): Promise<T> {
  const reconnectDeadline = Date.now() + 3_000;
  for (;;) {
    try {
      return await (await runtimeDataConnection(globalDataPath)).request<T>(request);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const transport = error as RuntimeDataTransportError;
      const retryable = transport.runtimeDataPreconnect || transport.runtimeDataPrewrite || (transport.runtimeDataAmbiguous && runtimeDataRequestReplaySafe(request));
      if (!retryable || Date.now() >= reconnectDeadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

export async function sendRuntimeControlCommand(
  globalDataPath: string,
  command: RuntimeControlCommand,
  overrides: { token?: string; timeoutMs?: number; expectedRuntimeId?: string; replacementBuildId?: string; replacementVersion?: string } = {}
): Promise<RuntimeControlResponse> {
  const endpoint = await readReadyEndpoint(globalDataPath, overrides.timeoutMs || 3_000, overrides.expectedRuntimeId);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(overrides.timeoutMs || 3_000, () => socket.destroy(new Error('Runtime control request timed out.')));
    socket.once('connect', () => socket.write(JSON.stringify({ token: overrides.token || endpoint.token, command, expectedRuntimeId: overrides.expectedRuntimeId, replacementBuildId: overrides.replacementBuildId, replacementVersion: overrides.replacementVersion }) + '\n'));
    socket.on('data', chunk => { response += chunk; });
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        const parsed = JSON.parse(response) as RuntimeControlResponse;
        if (overrides.expectedRuntimeId && parsed.runtimeId !== overrides.expectedRuntimeId) {
          reject(new Error('different_runtime'));
          return;
        }
        if (!parsed.ok) {
          reject(new Error(parsed.error || 'Runtime control request failed.'));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
  });
}
