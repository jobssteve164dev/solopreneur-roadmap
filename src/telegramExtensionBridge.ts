import * as crypto from 'crypto';
import * as net from 'net';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';

const commands = new Set(['authorizeChat', 'bindChat', 'solopreneur.internalGetStatus', 'solopreneur.internalRunAgent', 'solopreneur.internalStopAgent',
  'solopreneur.internalApproveNode', 'solopreneur.internalDenyNode', 'solopreneur.internalRefreshTimedAutomation', 'solopreneur.internalStartConversation']);
const maxBridgeFrameBytes = 512 * 1024;
const unavailable = '请打开 SoloMap 项目编辑器后再执行此操作。聊天和项目查询仍可使用。';
type EditorEndpoint = { bridgeId: string; port: number; token: string; pid: number; expiresAt: number };
const runtimeEditorEndpoints = new Map<string, EditorEndpoint>();

export function registerTelegramEditorEndpoint(globalDataPath: string, value: Partial<EditorEndpoint> & { clear?: boolean }): { registered: boolean } {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  const current = runtimeEditorEndpoints.get(root);
  if (value.clear === true) {
    if (current?.bridgeId === value.bridgeId) runtimeEditorEndpoints.delete(root);
    return { registered: false };
  }
  const endpoint = { bridgeId: String(value.bridgeId || ''), port: Number(value.port), token: String(value.token || ''), pid: Number(value.pid), expiresAt: Number(value.expiresAt) };
  if (!endpoint.bridgeId || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535
    || endpoint.token.length < 32 || !Number.isInteger(endpoint.pid) || endpoint.pid < 1
    || !Number.isFinite(endpoint.expiresAt) || endpoint.expiresAt <= Date.now() || endpoint.expiresAt > Date.now() + 10_000) throw new Error('invalid_telegram_editor_endpoint');
  runtimeEditorEndpoints.set(root, endpoint);
  return { registered: true };
}

export async function startTelegramExtensionBridge(globalDataPath: string,
  execute: (command: string, args: string[]) => Promise<unknown>
): Promise<{ dispose(): void }> {
  const token = crypto.randomBytes(32).toString('hex');
  const bridgeId = crypto.randomUUID();
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;
    socket.on('data', async chunk => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > maxBridgeFrameBytes) { handled = true; socket.destroy(); return; }
      if (!buffer.includes('\n')) return;
      handled = true;
      try {
        const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
        const provided = Buffer.from(String(request.token || ''));
        const expected = Buffer.from(token);
        if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)
          || !commands.has(request.command) || !Array.isArray(request.args)
          || request.args.some((value: unknown) => typeof value !== 'string')) throw new Error('Telegram command authorization failed.');
        const result = await execute(request.command, request.args);
        socket.end(JSON.stringify({ ok: true, result }) + '\n');
      } catch (error) {
        socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Telegram editor connection did not start.');
  }
  const register = () => sendRuntimeDataRequest(globalDataPath, { operation: 'register_telegram_editor_endpoint', input: { globalDataPath, bridgeId, port: address.port, token, pid: process.pid, expiresAt: Date.now() + 4_000 } });
  try { await register(); }
  catch (error) {
    sockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
  const registrationTimer = setInterval(() => { void register().catch(() => undefined); }, 1_000);
  registrationTimer.unref?.();
  return { dispose() {
    clearInterval(registrationTimer);
    sockets.forEach(socket => socket.destroy());
    server.close();
    void sendRuntimeDataRequest(globalDataPath, { operation: 'register_telegram_editor_endpoint', input: { globalDataPath, bridgeId, clear: true } }).catch(() => undefined);
  } };
}

export async function executeTelegramExtensionCommand(globalDataPath: string, command: string, args: string[]): Promise<unknown> {
  if (!commands.has(command)) throw new Error('Unknown Telegram editor command.');
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  const endpoint = runtimeEditorEndpoints.get(root);
  if (!endpoint || endpoint.expiresAt <= Date.now()) { runtimeEditorEndpoints.delete(root); throw new Error(unavailable); }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: endpoint.port });
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(JSON.stringify({ token: endpoint.token, command, args }) + '\n'));
    socket.on('data', chunk => { response += chunk; });
    socket.once('error', () => reject(new Error(unavailable)));
    socket.once('end', () => {
      try {
        const parsed = JSON.parse(response);
        if (!parsed.ok) throw new Error(parsed.error || unavailable);
        resolve(parsed.result);
      } catch (error) { reject(error); }
    });
    socket.once('close', () => { if (!response) reject(new Error(unavailable)); });
  });
}
