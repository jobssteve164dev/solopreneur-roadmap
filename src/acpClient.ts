import * as childProcess from 'child_process';
import * as readline from 'readline';

export type AcpClientEvent =
  | { type: 'sessionUpdate'; sessionId: string; update: any }
  | { type: 'permissionRequest'; requestId: number | string; params: any }
  | { type: 'elicitationRequest'; requestId: number | string; params: any }
  | { type: 'stderr'; text: string }
  | { type: 'closed'; message: string };

interface PendingRequest {
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export interface CodexAcpClientOptions {
  adapterEntryPath: string;
  codexPath: string;
  cwd: string;
  onEvent: (event: AcpClientEvent) => void;
}

export class CodexAcpClient {
  private child: childProcess.ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private closing = false;

  public constructor(private readonly options: CodexAcpClientOptions) {}

  public async start(): Promise<any> {
    if (this.child) return;
    this.child = childProcess.spawn(process.execPath, [this.options.adapterEntryPath], {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        CODEX_PATH: this.options.codexPath,
        INITIAL_AGENT_MODE: 'agent',
        NO_BROWSER: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.once('error', (error) => this.failAll(error));
    this.child.once('exit', (code, signal) => {
      if (this.closing) return;
      const error = new Error(`Codex 对话服务意外退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）。`);
      this.failAll(error);
      this.options.onEvent({ type: 'closed', message: error.message });
    });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      try {
        this.handleMessage(JSON.parse(line));
      } catch (error) {
        this.failAll(new Error(`Codex 对话服务返回了无效消息：${error instanceof Error ? error.message : String(error)}`));
      }
    });
    readline.createInterface({ input: this.child.stderr }).on('line', (line) => {
      const text = String(line || '').replace(/(Bearer\s+)[^\s"]+/gi, '$1[REDACTED]');
      if (text) this.options.onEvent({ type: 'stderr', text });
    });
    return this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'solomap', version: '1' },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        auth: { terminal: false },
        elicitation: { form: {} }
      }
    }, 30_000);
  }

  public newSession(): Promise<any> {
    return this.request('session/new', { cwd: this.options.cwd, mcpServers: [] }, 30_000);
  }

  public loadSession(sessionId: string): Promise<any> {
    return this.request('session/load', { sessionId, cwd: this.options.cwd, mcpServers: [] }, 30_000);
  }

  public prompt(sessionId: string, text: string): Promise<any> {
    return this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }]
    });
  }

  public setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<any> {
    return this.request('session/set_config_option', { sessionId, configId, value }, 30_000);
  }

  public cancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId });
  }

  public respondPermission(requestId: number | string, optionId: string): void {
    this.respond(requestId, optionId
      ? { outcome: { outcome: 'selected', optionId } }
      : { outcome: { outcome: 'cancelled' } });
  }

  public respondElicitation(requestId: number | string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>): void {
    this.respond(requestId, action === 'accept' ? { action, content: content || {} } : { action });
  }

  public async dispose(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.closing = true;
    this.child = null;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.failAll(new Error('Codex 对话服务已关闭。'));
  }

  private handleMessage(message: any): void {
    if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message || JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      if (message.method === 'session/request_permission') {
        this.options.onEvent({ type: 'permissionRequest', requestId: message.id, params: message.params || {} });
      } else if (message.method === 'elicitation/create') {
        this.options.onEvent({ type: 'elicitationRequest', requestId: message.id, params: message.params || {} });
      } else {
        this.respondError(message.id, -32601, `Unsupported client method: ${message.method}`);
      }
      return;
    }
    if (message.method === 'session/update') {
      this.options.onEvent({
        type: 'sessionUpdate',
        sessionId: String(message.params?.sessionId || ''),
        update: message.params?.update || {}
      });
    }
  }

  private request(method: string, params: any, timeoutMs = 0): Promise<any> {
    const id = this.nextRequestId++;
    const promise = new Promise<any>((resolve, reject) => {
      const pending: PendingRequest = { method, resolve, reject };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} 等待响应超时。`));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
    });
    this.write({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  private notify(method: string, params: any): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private respond(id: number | string, result: any): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private write(message: any): void {
    if (!this.child?.stdin.writable) throw new Error('Codex 对话服务尚未就绪。');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
