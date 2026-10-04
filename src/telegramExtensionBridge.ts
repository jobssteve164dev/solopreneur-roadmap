import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import { telegramRuntimePath, writeTelegramRuntimeJson } from './telegramRuntimeConfig';

const commands = new Set(['authorizeChat', 'bindChat', 'solopreneur.internalGetStatus', 'solopreneur.internalRunAgent', 'solopreneur.internalStopAgent',
  'solopreneur.internalApproveNode', 'solopreneur.internalDenyNode']);
const unavailable = '请打开 SoloMap 项目编辑器后再执行此操作。聊天和项目查询仍可使用。';

export async function startTelegramExtensionBridge(globalDataPath: string,
  execute: (command: string, args: string[]) => Promise<unknown>
): Promise<{ dispose(): void }> {
  const token = crypto.randomBytes(32).toString('hex');
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
      if (buffer.length > 8192) { handled = true; socket.destroy(); return; }
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
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Telegram editor connection did not start.');
  const filePath = telegramRuntimePath(globalDataPath, 'telegram-editor.json');
  writeTelegramRuntimeJson(filePath, { port: address.port, token, pid: process.pid });
  return { dispose() {
    sockets.forEach(socket => socket.destroy());
    server.close();
    // Keep the endpoint as an inert record; a later host replaces it atomically.
  } };
}

export async function executeTelegramExtensionCommand(globalDataPath: string, command: string, args: string[]): Promise<unknown> {
  if (!commands.has(command)) throw new Error('Unknown Telegram editor command.');
  const filePath = telegramRuntimePath(globalDataPath, 'telegram-editor.json');
  if (!fs.existsSync(filePath)) throw new Error(unavailable);
  const endpoint = JSON.parse(fs.readFileSync(filePath, 'utf8'));
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
