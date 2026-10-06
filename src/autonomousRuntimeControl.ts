import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

import { normalizeGlobalDataPathForExtension } from './projectRegistry';

export type RuntimeControlCommand = 'health' | 'pause' | 'resume' | 'drain' | 'stop';

export interface RuntimeControlResponse {
  ok: boolean;
  runtimeId: string;
  status: string;
  entryPath?: string;
  buildId?: string;
  owner?: string;
  error?: string;
}

export interface RuntimeDataRequest {
  operation: string;
  input: Record<string, unknown>;
  sessionToken?: string;
}

interface RuntimeControlEndpoint {
  schemaVersion: 1;
  runtimeId: string;
  host: '127.0.0.1';
  port: number;
  token: string;
  entryPath?: string;
}

interface RuntimeControlServerOptions {
  globalDataPath: string;
  runtimeId: string;
  entryPath?: string;
  buildId?: string;
  owner?: string;
  onCommand(command: RuntimeControlCommand): RuntimeControlResponse | Pick<RuntimeControlResponse, 'status'> | Promise<RuntimeControlResponse | Pick<RuntimeControlResponse, 'status'>>;
  onData?(request: RuntimeDataRequest): unknown | Promise<unknown>;
}

function endpointPath(globalDataPath: string): string {
  return path.join(normalizeGlobalDataPathForExtension(globalDataPath), 'runtime', 'control.json');
}

function writeEndpoint(filePath: string, endpoint: RuntimeControlEndpoint): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(endpoint), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    // Only this invocation's newly created temporary endpoint may be removed.
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    throw error;
  }
}

export async function startRuntimeControlServer(options: RuntimeControlServerOptions): Promise<{ close(): Promise<void> }> {
  const token = crypto.randomBytes(32).toString('hex');
  const filePath = endpointPath(options.globalDataPath);
  const connections = new Set<net.Socket>();
  const busy = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.once('close', () => { connections.delete(socket); });
    socket.on('error', () => {});
    socket.setTimeout(5_000, () => socket.destroy());
    socket.setEncoding('utf8');
    let request = '';
    let handled = false;
    let authenticatedPrefix = false;
    socket.on('data', async (chunk) => {
      if (handled) return;
      request += chunk;
      if (!authenticatedPrefix && request.length > 65536) {
        const prefix = /^\s*\{\s*"token"\s*:\s*"([^"\\]*)"/.exec(request.slice(0, 4096));
        const provided = Buffer.from(prefix?.[1] || '');
        const expected = Buffer.from(token);
        if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) { socket.destroy(); return; }
        authenticatedPrefix = true;
        socket.setTimeout(0);
      }
      const frameEnd = request.indexOf('\n');
      if (frameEnd < 0) return;
      handled = true;
      try {
        const parsed = JSON.parse(request.slice(0, frameEnd)) as { token?: string; command?: RuntimeControlCommand | 'data'; expectedRuntimeId?: string; request?: RuntimeDataRequest };
        const providedToken = Buffer.from(String(parsed.token || ''));
        const expectedToken = Buffer.from(token);
        if (providedToken.length !== expectedToken.length || !crypto.timingSafeEqual(providedToken, expectedToken)) {
          socket.end(JSON.stringify({ ok: false, runtimeId: options.runtimeId, status: 'rejected', error: 'Runtime control authentication failed.' }) + '\n');
          return;
        }
        const command = parsed.command;
        if (!command || !['health', 'pause', 'resume', 'drain', 'stop', 'data'].includes(command)) {
          socket.end(JSON.stringify({ ok: false, runtimeId: options.runtimeId, status: 'rejected', error: 'Unknown Runtime control command.' }) + '\n');
          return;
        }
        if (parsed.expectedRuntimeId && parsed.expectedRuntimeId !== options.runtimeId) {
          socket.end(JSON.stringify({ ok: false, runtimeId: options.runtimeId, status: 'rejected', error: 'different_runtime' }) + '\n');
          return;
        }
        if (command === 'data') {
          if (!options.onData || !parsed.request) throw new Error('Runtime data service is unavailable.');
          // Accepted work must finish even when a backup or export outlives a control timeout.
          socket.setTimeout(0);
          busy.add(socket);
          let result: unknown;
          try { result = await options.onData(parsed.request); }
          finally { busy.delete(socket); }
          socket.end(JSON.stringify({ ok: true, runtimeId: options.runtimeId, result }) + '\n');
          return;
        }
        const result = await options.onCommand(command);
        socket.end(JSON.stringify({ ok: true, runtimeId: options.runtimeId, ...result, entryPath: options.entryPath, buildId: options.buildId, owner: options.owner }) + '\n');
      } catch (error) {
        socket.end(JSON.stringify({
          ok: false,
          runtimeId: options.runtimeId,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error)
        }) + '\n');
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
  try { writeEndpoint(filePath, {
    schemaVersion: 1,
    runtimeId: options.runtimeId,
    host: '127.0.0.1',
    port: address.port,
    token,
    entryPath: options.entryPath
  }); } catch (error) {
    connections.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
  return {
    close: async () => {
      const closePromise = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      const forceCloseTimer = setTimeout(() => connections.forEach(socket => { if (!busy.has(socket)) socket.destroy(); }), 100);
      forceCloseTimer.unref();
      await closePromise;
      clearTimeout(forceCloseTimer);
      try {
        const current = JSON.parse(fs.readFileSync(filePath, 'utf8')) as RuntimeControlEndpoint;
        if (current.runtimeId === options.runtimeId) fs.unlinkSync(filePath);
      } catch {
        // A newer Runtime may already own the endpoint.
      }
    }
  };
}

export async function sendRuntimeDataRequest<T>(globalDataPath: string, request: RuntimeDataRequest): Promise<T> {
  const endpoint = JSON.parse(await fs.promises.readFile(endpointPath(globalDataPath), 'utf8')) as RuntimeControlEndpoint;
  if (endpoint.schemaVersion !== 1 || endpoint.host !== '127.0.0.1' || !Number.isInteger(endpoint.port) || !endpoint.token) throw new Error('Invalid Runtime endpoint.');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: endpoint.port });
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(JSON.stringify({ token: endpoint.token, command: 'data', expectedRuntimeId: endpoint.runtimeId, request }) + '\n'));
    socket.on('data', chunk => { response += chunk; });
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        const parsed = JSON.parse(response) as { ok: boolean; runtimeId: string; result: T; error?: string };
        if (!parsed.ok || parsed.runtimeId !== endpoint.runtimeId) throw new Error(parsed.error || 'different_runtime');
        resolve(parsed.result);
      } catch (error) { reject(error); }
    });
  });
}

export function sendRuntimeControlCommand(
  globalDataPath: string,
  command: RuntimeControlCommand,
  overrides: { token?: string; timeoutMs?: number; expectedRuntimeId?: string } = {}
): Promise<RuntimeControlResponse> {
  const endpoint = JSON.parse(fs.readFileSync(endpointPath(globalDataPath), 'utf8')) as RuntimeControlEndpoint;
  if (overrides.expectedRuntimeId && endpoint.runtimeId !== overrides.expectedRuntimeId) return Promise.reject(new Error('different_runtime'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(overrides.timeoutMs || 3_000, () => socket.destroy(new Error('Runtime control request timed out.')));
    socket.once('connect', () => socket.write(JSON.stringify({ token: overrides.token || endpoint.token, command, expectedRuntimeId: overrides.expectedRuntimeId }) + '\n'));
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
