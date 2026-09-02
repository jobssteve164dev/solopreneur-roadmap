#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('could not reserve a loopback port');
  return port;
}

async function waitForReady(url, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`app-server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('app-server did not become ready');
}

function createJsonRpcClient(endpoint) {
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  const notifications = [];
  const waiters = [];
  let nextId = 1;

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data || ''));
    if (Object.prototype.hasOwnProperty.call(message, 'id') && pending.has(message.id)) {
      const handler = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
      else handler.resolve(message.result);
      return;
    }
    if (message.method) {
      notifications.push(message);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (waiters[index].predicate(message)) {
          const waiter = waiters.splice(index, 1)[0];
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
    }
  });

  return {
    async open() {
      if (socket.readyState === WebSocket.OPEN) return;
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
    },
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ method, id, params }));
      });
    },
    notify(method, params) {
      socket.send(JSON.stringify({ method, params }));
    },
    waitFor(predicate, timeoutMs = 60000) {
      const existing = notifications.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('timed out waiting for app-server notification'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    close() {
      socket.close();
    }
  };
}

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solomap-codex-remote-'));
const outputFilePath = path.join(workspaceRoot, 'tui-output.log');
const port = await reserveLoopbackPort();
const endpoint = `ws://127.0.0.1:${port}`;
const appServer = spawn('codex', ['app-server', '--listen', endpoint], {
  cwd: workspaceRoot,
  stdio: ['ignore', 'pipe', 'pipe']
});
let tui = null;
let client = null;

try {
  await waitForReady(`http://127.0.0.1:${port}/readyz`, appServer);
  client = createJsonRpcClient(endpoint);
  await client.open();
  await client.request('initialize', {
    clientInfo: {
      name: 'solomap_session_identity_simulation',
      title: 'SoloMap Session Identity Simulation',
      version: '0.1.0'
    }
  });
  client.notify('initialized', {});
  const started = await client.request('thread/start', {
    cwd: workspaceRoot,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    serviceName: 'solomap_session_identity_simulation'
  });
  const threadId = String(started?.thread?.id || '');
  const threadSessionId = String(started?.thread?.sessionId || '');
  if (!threadId || !threadSessionId) throw new Error('thread/start did not return thread.id and thread.sessionId');

  const prompt = 'Reply with exactly SOLOMAP_CODEX_REMOTE_OK. Do not run tools.';
  const command = [
    'codex',
    'resume',
    '--remote', endpoint,
    '--no-alt-screen',
    '--sandbox', 'read-only',
    '--ask-for-approval', 'never',
    '-C', workspaceRoot,
    threadId,
    prompt
  ].map(shellQuote).join(' ');
  tui = spawn('script', ['-q', '-f', '-e', '-c', command, outputFilePath], {
    cwd: workspaceRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
  });
  tui.stdout.on('data', (chunk) => {
    const output = String(chunk || '');
    if (output.includes('\u001b[6n')) tui.stdin.write('\u001b[1;1R');
    if (output.includes('\u001b]10;?\u001b\\')) tui.stdin.write('\u001b]10;rgb:ffff/ffff/ffff\u001b\\');
    if (output.includes('\u001b]11;?\u001b\\')) tui.stdin.write('\u001b]11;rgb:0000/0000/0000\u001b\\');
    if (output.includes('\u001b[c')) tui.stdin.write('\u001b[?1;2c');
  });
  const turnStarted = await client.waitFor((message) => message.method === 'turn/started');
  const turnId = String(turnStarted.params?.turn?.id || '');
  if (!turnId) throw new Error('turn/started did not include a turn id');
  const turnCompleted = await client.waitFor((message) => (
    message.method === 'turn/completed'
    && String(message.params?.turn?.id || '') === turnId
  ));
  const readBack = await client.request('thread/read', { threadId, includeTurns: true });
  const readBackThreadId = String(readBack?.thread?.id || '');
  if (readBackThreadId !== threadId) throw new Error('thread/read returned a different thread');

  tui.stdin.write('/exit\n');
  const tuiExitCode = await waitForExit(tui, 5000);
  if (tuiExitCode === null) tui.kill('SIGINT');
  const output = fs.existsSync(outputFilePath) ? fs.readFileSync(outputFilePath, 'utf8') : '';
  const result = {
    status: 'matched',
    endpoint,
    threadId,
    threadSessionId,
    turnStartedId: turnId,
    turnCompletedId: String(turnCompleted.params?.turn?.id || ''),
    readBackThreadId,
    turnCount: Array.isArray(readBack?.thread?.turns) ? readBack.thread.turns.length : 0,
    outputContainsSentinel: output.includes('SOLOMAP_CODEX_REMOTE_OK'),
    workspaceRoot,
    outputFilePath,
    retainedProviderThread: true
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const output = fs.existsSync(outputFilePath) ? fs.readFileSync(outputFilePath, 'utf8') : '';
  process.stdout.write(`${JSON.stringify({
    status: 'unsupported',
    reason: error instanceof Error ? error.message : String(error),
    workspaceRoot,
    outputFilePath,
    outputContainsResumeFailure: output.includes('thread/resume failed'),
    retainedProviderThread: true
  }, null, 2)}\n`);
  process.exitCode = 2;
} finally {
  client?.close();
  if (tui && tui.exitCode === null) {
    tui.kill('SIGINT');
    await waitForExit(tui, 2000);
  }
  if (appServer.exitCode === null) {
    appServer.kill('SIGINT');
    await waitForExit(appServer, 2000);
  }
}
