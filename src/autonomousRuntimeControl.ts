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
  error?: string;
}

interface RuntimeControlEndpoint {
  schemaVersion: 1;
  runtimeId: string;
  host: '127.0.0.1';
  port: number;
  token: string;
}

interface RuntimeControlServerOptions {
  globalDataPath: string;
  runtimeId: string;
  onCommand(command: RuntimeControlCommand): RuntimeControlResponse | Pick<RuntimeControlResponse, 'status'> | Promise<RuntimeControlResponse | Pick<RuntimeControlResponse, 'status'>>;
}

function endpointPath(globalDataPath: string): string {
  return path.join(normalizeGlobalDataPathForExtension(globalDataPath), 'runtime', 'control.json');
}

function writeEndpoint(filePath: string, endpoint: RuntimeControlEndpoint): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(endpoint), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

export async function startRuntimeControlServer(options: RuntimeControlServerOptions): Promise<{ close(): Promise<void> }> {
  const token = crypto.randomBytes(32).toString('hex');
  const filePath = endpointPath(options.globalDataPath);
  const connections = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(5_000, () => socket.destroy());
    socket.setEncoding('utf8');
    let request = '';
    let handled = false;
    socket.on('data', async (chunk) => {
      if (handled) return;
      request += chunk;
      if (request.length > 65_536) {
        handled = true;
        socket.end(JSON.stringify({ ok: false, runtimeId: options.runtimeId, status: 'rejected', error: 'Runtime control request is too large.' }) + '\n');
        return;
      }
      const frameEnd = request.indexOf('\n');
      if (frameEnd < 0) return;
      handled = true;
      try {
        const parsed = JSON.parse(request.slice(0, frameEnd)) as { token?: string; command?: RuntimeControlCommand };
        const providedToken = Buffer.from(String(parsed.token || ''));
        const expectedToken = Buffer.from(token);
        if (providedToken.length !== expectedToken.length || !crypto.timingSafeEqual(providedToken, expectedToken)) {
          socket.end(JSON.stringify({ ok: false, runtimeId: options.runtimeId, status: 'rejected', error: 'Runtime control authentication failed.' }) + '\n');
          return;
        }
        const command = parsed.command;
        if (!command || !['health', 'pause', 'resume', 'drain', 'stop'].includes(command)) {
          socket.end(JSON.stringify({ ok: false, runtimeId: options.runtimeId, status: 'rejected', error: 'Unknown Runtime control command.' }) + '\n');
          return;
        }
        const result = await options.onCommand(command);
        socket.end(JSON.stringify({ ok: true, runtimeId: options.runtimeId, ...result }) + '\n');
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
  writeEndpoint(filePath, {
    schemaVersion: 1,
    runtimeId: options.runtimeId,
    host: '127.0.0.1',
    port: address.port,
    token
  });
  return {
    close: async () => {
      const closePromise = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      const forceCloseTimer = setTimeout(() => connections.forEach(socket => socket.destroy()), 100);
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

export function sendRuntimeControlCommand(
  globalDataPath: string,
  command: RuntimeControlCommand,
  overrides: { token?: string; timeoutMs?: number } = {}
): Promise<RuntimeControlResponse> {
  const endpoint = JSON.parse(fs.readFileSync(endpointPath(globalDataPath), 'utf8')) as RuntimeControlEndpoint;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(overrides.timeoutMs || 3_000, () => socket.destroy(new Error('Runtime control request timed out.')));
    socket.once('connect', () => socket.write(JSON.stringify({ token: overrides.token || endpoint.token, command }) + '\n'));
    socket.on('data', chunk => { response += chunk; });
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        const parsed = JSON.parse(response) as RuntimeControlResponse;
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
