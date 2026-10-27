import * as crypto from 'crypto';
import * as net from 'net';

export interface ForegroundTerminalReconnectIdentity {
  runId: string;
  generation: number;
  deliveryId: string;
  nonce: string;
}

export interface ForegroundTerminalReconnectEndpoint extends ForegroundTerminalReconnectIdentity {
  host: '127.0.0.1';
  port: number;
  runnerPid: number;
  protocol: 1;
}

interface BufferedOutput {
  startOffset: number;
  endOffset: number;
  bytes: Buffer;
}

type ProtocolFrame = Record<string, unknown> & { type: string };
const MAX_PROTOCOL_FRAME_BYTES = 1024 * 1024;
const AUTHENTICATION_TIMEOUT_MS = 5000;
const MAX_UNAUTHENTICATED_SOCKETS = 8;
const MAX_REMEMBERED_INPUT_REQUESTS = 1024;

function writeFrame(socket: net.Socket, frame: ProtocolFrame): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(`${JSON.stringify(frame)}\n`, error => error ? reject(error) : resolve());
  });
}

function consumeFrames(socket: net.Socket, consume: (frame: ProtocolFrame) => void): void {
  let pending = '';
  socket.setEncoding('utf8');
  socket.on('data', value => {
    pending += value;
    if (Buffer.byteLength(pending, 'utf8') > MAX_PROTOCOL_FRAME_BYTES) {
      socket.destroy(new Error('terminal_reconnect_frame_too_large'));
      return;
    }
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_FRAME_BYTES) {
        socket.destroy(new Error('terminal_reconnect_frame_too_large'));
        return;
      }
      try {
        const frame = JSON.parse(line) as ProtocolFrame;
        if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.type !== 'string') throw new Error('terminal_reconnect_protocol_invalid');
        consume(frame);
      }
      catch { socket.destroy(new Error('terminal_reconnect_protocol_invalid')); }
    }
  });
}

export class ForegroundTerminalReconnectServer {
  private server?: net.Server;
  private socket?: net.Socket;
  private readonly sockets = new Set<net.Socket>();
  private readonly socketWrites = new WeakMap<net.Socket, Promise<void>>();
  private readonly inputRequests = new Map<string, Promise<void>>();
  private readonly acknowledgedInputRequests: string[] = [];
  private output: BufferedOutput[] = [];
  private bufferedBytes = 0;
  private latestOffset = 0;

  constructor(
    private readonly identity: ForegroundTerminalReconnectIdentity,
    private readonly onInput: (bytes: Buffer) => void | Promise<void>,
    private readonly options: { maxBufferedBytes?: number; initialOffset?: number; onStop?: (signal: NodeJS.Signals) => void } = {}
  ) {
    const initialOffset = Number(options.initialOffset || 0);
    if (!Number.isInteger(initialOffset) || initialOffset < 0) throw new Error('terminal_reconnect_offset_invalid');
    this.latestOffset = initialOffset;
  }

  async start(): Promise<ForegroundTerminalReconnectEndpoint> {
    if (this.server) throw new Error('terminal_reconnect_server_already_started');
    this.server = net.createServer(socket => this.accept(socket));
    this.server.unref();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { this.server?.off('listening', onListening); reject(error); };
      const onListening = () => { this.server?.off('error', onError); resolve(); };
      this.server!.once('error', onError);
      this.server!.once('listening', onListening);
      this.server!.listen(0, '127.0.0.1');
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('terminal_reconnect_endpoint_missing');
    return { ...this.identity, host: '127.0.0.1', port: address.port, runnerPid: process.pid, protocol: 1 };
  }

  publish(bytes: Buffer, endOffset: number): void {
    if (!bytes.length) return;
    if (!Number.isInteger(endOffset) || endOffset < bytes.length || endOffset < this.latestOffset) throw new Error('terminal_reconnect_offset_invalid');
    const item = { startOffset: endOffset - bytes.length, endOffset, bytes: Buffer.from(bytes) };
    this.latestOffset = endOffset;
    this.output.push(item); this.bufferedBytes += item.bytes.length;
    const max = Math.max(1, Number(this.options.maxBufferedBytes || 4 * 1024 * 1024));
    while (this.bufferedBytes > max && this.output.length > 1) this.bufferedBytes -= this.output.shift()!.bytes.length;
    if (this.socket && !this.socket.destroyed) void this.send(this.socket, this.outputFrame(item)).catch(() => undefined);
  }

  async close(exitCode?: number): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (socket && !socket.destroyed) {
      await this.send(socket, { type: 'exit', exitCode }).catch(() => undefined);
      socket.end();
    }
    const server = this.server;
    this.server = undefined;
    for (const candidate of this.sockets) candidate.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private accept(socket: net.Socket): void {
    socket.on('error', () => undefined);
    if (this.sockets.size >= MAX_UNAUTHENTICATED_SOCKETS + (this.socket ? 1 : 0)) {
      socket.destroy(new Error('terminal_reconnect_connection_limit'));
      return;
    }
    this.sockets.add(socket);
    socket.setNoDelay(true);
    let authenticated = false;
    let rejected = false;
    const authenticationTimer = setTimeout(() => socket.destroy(new Error('terminal_reconnect_authentication_timeout')), AUTHENTICATION_TIMEOUT_MS);
    authenticationTimer.unref();
    consumeFrames(socket, frame => {
      if (rejected) return;
      if (!authenticated) {
        if (frame.type !== 'attach' || frame.runId !== this.identity.runId || frame.generation !== this.identity.generation
          || frame.deliveryId !== this.identity.deliveryId || frame.nonce !== this.identity.nonce) {
          rejected = true;
          void writeFrame(socket, { type: 'error', code: 'terminal_reconnect_unauthorized' }).finally(() => socket.end());
          return;
        }
        const sinceOffset = Number(frame.sinceOffset);
        const earliestOffset = this.output[0]?.startOffset ?? this.latestOffset;
        if (!Number.isInteger(sinceOffset) || sinceOffset < 0 || sinceOffset > this.latestOffset) {
          rejected = true;
          void writeFrame(socket, { type: 'error', code: 'terminal_reconnect_offset_invalid' }).finally(() => socket.end());
          return;
        }
        if (sinceOffset < earliestOffset) {
          rejected = true;
          void writeFrame(socket, { type: 'resync_required', earliestOffset, latestOffset: this.latestOffset }).finally(() => socket.end());
          return;
        }
        authenticated = true;
        clearTimeout(authenticationTimer);
        this.socket?.destroy();
        this.socket = socket;
        void this.send(socket, { type: 'attached', latestOffset: this.latestOffset }).catch(() => undefined);
        for (const item of this.output) {
          if (item.endOffset <= sinceOffset) continue;
          const skip = Math.max(0, sinceOffset - item.startOffset);
          const bytes = item.bytes.subarray(skip);
          void this.send(socket, this.outputFrame({ startOffset: item.startOffset + skip, endOffset: item.endOffset, bytes })).catch(() => undefined);
        }
        void this.send(socket, { type: 'ready', latestOffset: this.latestOffset }).catch(() => undefined);
        return;
      }
      if (socket !== this.socket) return;
      if (frame.type === 'input') {
        const requestId = String(frame.requestId || '');
        const encoded = String(frame.bytes || '');
        const bytes = Buffer.from(encoded, 'base64');
        if (!/^[a-z0-9:._-]{1,128}$/i.test(requestId) || bytes.length > MAX_PROTOCOL_FRAME_BYTES || bytes.toString('base64') !== encoded) {
          void this.send(socket, { type: 'input_error', requestId, code: 'terminal_reconnect_input_invalid' }).catch(() => undefined);
          return;
        }
        let accepted = this.inputRequests.get(requestId);
        if (!accepted) {
          accepted = Promise.resolve().then(() => this.onInput(bytes));
          this.inputRequests.set(requestId, accepted);
          void accepted.then(() => {
            this.acknowledgedInputRequests.push(requestId);
            while (this.acknowledgedInputRequests.length > MAX_REMEMBERED_INPUT_REQUESTS) {
              this.inputRequests.delete(this.acknowledgedInputRequests.shift()!);
            }
          }, () => this.inputRequests.delete(requestId));
        }
        void accepted.then(
          () => this.send(socket, { type: 'input_ack', requestId }),
          () => this.send(socket, { type: 'input_error', requestId, code: 'terminal_reconnect_input_failed' })
        ).catch(() => undefined);
      }
      else if (frame.type === 'stop') this.options.onStop?.(frame.signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
    });
    socket.once('close', () => { clearTimeout(authenticationTimer); this.sockets.delete(socket); if (this.socket === socket) this.socket = undefined; });
  }

  private outputFrame(item: BufferedOutput): ProtocolFrame {
    return { type: 'output', startOffset: item.startOffset, endOffset: item.endOffset, bytes: item.bytes.toString('base64') };
  }

  private send(socket: net.Socket, frame: ProtocolFrame): Promise<void> {
    const pending = (this.socketWrites.get(socket) || Promise.resolve()).then(() => writeFrame(socket, frame));
    this.socketWrites.set(socket, pending.catch(() => undefined));
    return pending.catch(error => { socket.destroy(); throw error; });
  }
}

export class ForegroundTerminalReconnectClient {
  private socket?: net.Socket;
  private readonly outputConsumers = new Set<(bytes: Buffer) => void>();
  private readonly exitConsumers = new Set<(exitCode?: number) => void>();
  private readonly disconnectConsumers = new Set<() => void>();
  private readonly inputAcks = new Map<string, { resolve(): void; reject(error: Error): void }>();
  private connected = false;
  private readonly clientId = crypto.randomUUID();
  private inputSequence = 0;
  private intentionalDisconnect = false;

  constructor(private readonly endpoint: ForegroundTerminalReconnectEndpoint, private readonly sinceOffset: number) {}

  async connect(): Promise<void> {
    if (this.connected) return;
    this.intentionalDisconnect = false;
    const socket = net.createConnection({ host: this.endpoint.host, port: this.endpoint.port });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let receivedExit = false;
      const rejectInputs = (error: Error) => {
        for (const pending of this.inputAcks.values()) pending.reject(error);
        this.inputAcks.clear();
      };
      const settleError = (error: Error) => {
        rejectInputs(error);
        if (!settled) { settled = true; reject(error); }
      };
      socket.once('error', settleError);
      consumeFrames(socket, frame => {
        if (frame.type === 'attached') {
          this.connected = true;
        } else if (frame.type === 'ready') {
          if (!settled) { settled = true; resolve(); }
        } else if (frame.type === 'output' && this.connected) {
          const bytes = Buffer.from(String(frame.bytes || ''), 'base64');
          for (const consumer of this.outputConsumers) consumer(bytes);
        } else if (frame.type === 'exit') {
          receivedExit = true;
          this.connected = false;
          for (const consumer of this.exitConsumers) consumer(Number.isInteger(frame.exitCode) ? Number(frame.exitCode) : undefined);
        } else if (frame.type === 'input_ack') {
          const pending = this.inputAcks.get(String(frame.requestId || ''));
          if (pending) { this.inputAcks.delete(String(frame.requestId || '')); pending.resolve(); }
        } else if (frame.type === 'input_error') {
          const pending = this.inputAcks.get(String(frame.requestId || ''));
          if (pending) { this.inputAcks.delete(String(frame.requestId || '')); pending.reject(new Error(String(frame.code || 'terminal_reconnect_input_failed'))); }
        } else if (frame.type === 'error') settleError(new Error(String(frame.code || 'terminal_reconnect_error')));
        else if (frame.type === 'resync_required') settleError(new Error(`terminal_reconnect_resync_required:${frame.earliestOffset}:${frame.latestOffset}`));
      });
      socket.once('connect', () => void writeFrame(socket, { type: 'attach', ...this.endpoint, sinceOffset: this.sinceOffset }).catch(settleError));
      socket.once('close', () => {
        const unexpectedlyDisconnected = this.connected && !this.intentionalDisconnect && !receivedExit;
        this.connected = false;
        rejectInputs(new Error('terminal_reconnect_closed'));
        if (!settled) settleError(new Error('terminal_reconnect_closed'));
        if (unexpectedlyDisconnected) for (const consumer of this.disconnectConsumers) consumer();
      });
    });
  }

  onOutput(consumer: (bytes: Buffer) => void): () => void { this.outputConsumers.add(consumer); return () => this.outputConsumers.delete(consumer); }
  onExit(consumer: (exitCode?: number) => void): () => void { this.exitConsumers.add(consumer); return () => this.exitConsumers.delete(consumer); }
  onDisconnect(consumer: () => void): () => void { this.disconnectConsumers.add(consumer); return () => this.disconnectConsumers.delete(consumer); }
  async writeInput(bytes: Buffer): Promise<void> {
    if (!this.socket || !this.connected) throw new Error('foreground_runner_not_running');
    const requestId = `${this.clientId}:${++this.inputSequence}`;
    const acknowledged = new Promise<void>((resolve, reject) => this.inputAcks.set(requestId, { resolve, reject }));
    void acknowledged.catch(() => undefined);
    try {
      await writeFrame(this.socket, { type: 'input', requestId, bytes: bytes.toString('base64') });
      await acknowledged;
    } catch (error) {
      this.inputAcks.delete(requestId);
      throw error;
    }
  }
  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (this.socket && this.connected) await writeFrame(this.socket, { type: 'stop', signal });
  }
  disconnect(): void {
    this.intentionalDisconnect = true; this.connected = false; this.socket?.destroy(); this.socket = undefined;
    for (const pending of this.inputAcks.values()) pending.reject(new Error('terminal_reconnect_closed'));
    this.inputAcks.clear();
  }
  get isConnected(): boolean { return this.connected; }
}
