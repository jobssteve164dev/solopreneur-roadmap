import * as vscode from 'vscode';
import { AcpClientEvent, CodexAcpClient } from './acpClient';

export interface CustomConversationTurn {
  executionLogId: number;
  userMessage: string;
  prompt: string;
}

export interface CustomConversationTurnResult {
  assistantText: string;
  stopReason: string;
  error?: string;
}

export interface CustomConversationViewOptions {
  extensionPath: string;
  workspaceRoot: string;
  agentCli: string;
  selectedModel?: string;
  title: string;
  language: string;
  existingSessionId?: string;
  onSessionReady: (sessionId: string) => Promise<void> | void;
  prepareTurn: (userMessage: string) => Promise<CustomConversationTurn | null>;
  finishTurn: (turn: CustomConversationTurn, result: CustomConversationTurnResult) => Promise<void>;
  onDidDispose?: () => void;
}

interface ConversationMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
}

interface ToolActivity {
  id: string;
  title: string;
  status: string;
}

export class CustomConversationView implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private client: CodexAcpClient | null = null;
  private sessionId = '';
  private initialized: Promise<void> | null = null;
  private runningTurn: CustomConversationTurn | null = null;
  private messages: ConversationMessage[] = [];
  private tools = new Map<string, ToolActivity>();
  private state = 'connecting';
  private stateDetail = '';
  private pendingInteraction: any = null;
  private assistantText = '';
  private disposed = false;

  public constructor(private readonly options: CustomConversationViewOptions) {}

  public async open(initialTurn?: CustomConversationTurn): Promise<void> {
    this.reveal();
    await this.ensureInitialized();
    if (initialTurn) await this.runTurn(initialTurn);
  }

  public reveal(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, false);
      this.postState();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'solopreneur.conversation',
      this.options.title,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = getCustomConversationHtml(this.panel.webview, this.options.language);
    this.panel.webview.onDidReceiveMessage((message) => void this.handleWebviewMessage(message));
    this.panel.onDidDispose(() => {
      this.panel = null;
      this.options.onDidDispose?.();
    });
    this.postState();
  }

  public ownsExecution(executionLogId: number): boolean {
    return Number(this.runningTurn?.executionLogId || 0) === Number(executionLogId || 0);
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public stop(): boolean {
    if (!this.runningTurn || !this.sessionId) return false;
    this.client?.cancel(this.sessionId);
    this.state = 'stopping';
    this.postState();
    return true;
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.panel?.dispose();
    this.panel = null;
    await this.client?.dispose();
    this.client = null;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      this.state = 'connecting';
      this.postState();
      const adapterEntryPath = require.resolve('@agentclientprotocol/codex-acp/dist/index.js', {
        paths: [this.options.extensionPath]
      });
      this.client = new CodexAcpClient({
        adapterEntryPath,
        codexPath: this.options.agentCli,
        cwd: this.options.workspaceRoot,
        onEvent: (event) => this.handleClientEvent(event)
      });
      await this.client.start();
      let sessionState: any;
      if (this.options.existingSessionId) {
        sessionState = await this.client.loadSession(this.options.existingSessionId);
        this.sessionId = this.options.existingSessionId;
      } else {
        sessionState = await this.client.newSession();
        this.sessionId = String(sessionState?.sessionId || '');
      }
      if (!this.sessionId) throw new Error('无法创建 Codex 对话会话。');
      const selectedModel = String(this.options.selectedModel || '').trim();
      if (selectedModel && selectedModel !== 'auto') {
        const modelOption = (sessionState?.configOptions || []).find((option: any) => option?.id === 'model');
        const supported = (modelOption?.options || []).some((option: any) => String(option?.value || '') === selectedModel);
        if (!supported) throw new Error(`当前 Codex 会话不支持所选模型：${selectedModel}`);
        await this.client.setConfigOption(this.sessionId, 'model', selectedModel);
      }
      await this.options.onSessionReady(this.sessionId);
      this.state = 'ready';
      this.stateDetail = '';
      this.postState();
    })().catch((error) => {
      this.state = 'error';
      this.stateDetail = error instanceof Error ? error.message : String(error);
      this.postState();
      throw error;
    });
    return this.initialized;
  }

  private async handleWebviewMessage(message: any): Promise<void> {
    if (message?.command === 'ready') {
      this.postState();
      return;
    }
    if (message?.command === 'submit') {
      if (this.runningTurn) return;
      const text = String(message.text || '').trim();
      if (!text) return;
      try {
        await this.ensureInitialized();
        const turn = await this.options.prepareTurn(text);
        if (turn) await this.runTurn(turn);
      } catch (error) {
        this.state = 'error';
        this.stateDetail = error instanceof Error ? error.message : String(error);
        this.postState();
      }
      return;
    }
    if (message?.command === 'stop' && this.runningTurn && this.sessionId) {
      this.stop();
      return;
    }
    if (message?.command === 'permission' && this.pendingInteraction?.kind === 'permission') {
      const requestId = this.pendingInteraction.requestId;
      this.pendingInteraction = null;
      this.client?.respondPermission(requestId, String(message.optionId || ''));
      this.state = 'running';
      this.postState();
      return;
    }
    if (message?.command === 'elicitation' && this.pendingInteraction?.kind === 'elicitation') {
      const requestId = this.pendingInteraction.requestId;
      this.pendingInteraction = null;
      const action = message.action === 'accept' ? 'accept' : message.action === 'decline' ? 'decline' : 'cancel';
      this.client?.respondElicitation(requestId, action, message.content || {});
      this.state = 'running';
      this.postState();
    }
  }

  private async runTurn(turn: CustomConversationTurn): Promise<void> {
    if (!this.client || !this.sessionId || this.runningTurn) return;
    this.runningTurn = turn;
    this.assistantText = '';
    this.tools.clear();
    this.pendingInteraction = null;
    this.messages.push({ id: `user-${turn.executionLogId}`, role: 'user', text: turn.userMessage });
    this.state = 'running';
    this.stateDetail = '';
    this.postState();
    let result: CustomConversationTurnResult;
    let finalState = 'ready';
    try {
      const response = await this.client.prompt(this.sessionId, turn.prompt);
      result = {
        assistantText: this.assistantText,
        stopReason: String(response?.stopReason || 'end_turn')
      };
      finalState = result.stopReason === 'cancelled' ? 'stopped' : 'ready';
    } catch (error) {
      result = {
        assistantText: this.assistantText,
        stopReason: 'error',
        error: error instanceof Error ? error.message : String(error)
      };
      finalState = 'error';
      this.stateDetail = result.error || '';
    }
    if (this.assistantText.trim()) {
      this.messages.push({ id: `agent-${turn.executionLogId}`, role: 'agent', text: this.assistantText });
    }
    this.assistantText = '';
    this.pendingInteraction = null;
    this.state = 'running';
    this.postState();
    try {
      await this.options.finishTurn(turn, result);
      this.state = finalState;
    } catch (error) {
      this.state = 'error';
      this.stateDetail = error instanceof Error ? error.message : String(error);
    }
    this.runningTurn = null;
    this.postState();
  }

  private handleClientEvent(event: AcpClientEvent): void {
    if (event.type === 'sessionUpdate') {
      const update = event.update || {};
      if (update.sessionUpdate === 'agent_message_chunk') {
        const text = String(update.content?.text || '');
        if (text) this.assistantText += text;
      } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        const id = String(update.toolCallId || update.id || `tool-${this.tools.size + 1}`);
        const previous = this.tools.get(id);
        this.tools.set(id, {
          id,
          title: String(update.title || previous?.title || update.kind || '正在处理'),
          status: String(update.status || previous?.status || 'in_progress')
        });
      }
      this.postState();
      return;
    }
    if (event.type === 'permissionRequest') {
      this.pendingInteraction = { kind: 'permission', requestId: event.requestId, params: event.params };
      this.state = 'permission';
      this.postState();
      return;
    }
    if (event.type === 'elicitationRequest') {
      this.pendingInteraction = { kind: 'elicitation', requestId: event.requestId, params: event.params };
      this.state = 'question';
      this.postState();
      return;
    }
    if (event.type === 'closed') {
      this.state = 'error';
      this.stateDetail = event.message;
      this.postState();
    }
  }

  private postState(): void {
    void this.panel?.webview.postMessage({
      command: 'state',
      state: this.state,
      detail: this.stateDetail,
      messages: this.messages,
      streamingText: this.assistantText,
      tools: [...this.tools.values()],
      interaction: this.pendingInteraction,
      running: Boolean(this.runningTurn)
    });
  }
}

export function getCustomConversationHtml(webview: vscode.Webview, language: string): string {
  const nonce = String(Date.now());
  const zh = language !== 'en';
  const labels = zh ? {
    title: '对话', connecting: '正在连接', running: '正在执行', permission: '需要你确认', question: '需要你回答',
    ready: '等待你继续', stopped: '已停止', stopping: '正在停止', error: '连接出错', placeholder: '继续输入你的要求…',
    send: '发送', stop: '停止', agent: 'Agent', you: '你', decline: '暂不回答', approve: '确认', cancel: '取消',
    allowOnce: '允许这一次', allowAlways: '始终允许', rejectOnce: '拒绝这一次', rejectAlways: '始终拒绝', working: '进行中', failed: '未完成'
  } : {
    title: 'Conversation', connecting: 'Connecting', running: 'Working', permission: 'Needs your confirmation', question: 'Needs your answer',
    ready: 'Waiting for you', stopped: 'Stopped', stopping: 'Stopping', error: 'Connection error', placeholder: 'Continue with your next request…',
    send: 'Send', stop: 'Stop', agent: 'Agent', you: 'You', decline: 'Not now', approve: 'Confirm', cancel: 'Cancel',
    allowOnce: 'Allow once', allowAlways: 'Always allow', rejectOnce: 'Reject once', rejectAlways: 'Always reject', working: 'In progress', failed: 'Not completed'
  };
  return `<!doctype html>
<html lang="${zh ? 'zh-CN' : 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px/1.55 var(--vscode-font-family); }
    button, textarea, input, select { font: inherit; }
    .shell { min-height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }
    .topbar { min-height: 52px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 18px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
    .heading { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .heading h1 { margin: 0; font-size: 14px; font-weight: 600; }
    .status { display: inline-flex; align-items: center; gap: 7px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-charts-blue); }
    .status[data-state="ready"] .dot { background: var(--vscode-charts-green); }
    .status[data-state="permission"] .dot, .status[data-state="question"] .dot { background: var(--vscode-charts-yellow); }
    .status[data-state="error"] .dot, .status[data-state="stopped"] .dot { background: var(--vscode-charts-red); }
    .timeline { width: min(860px, 100%); margin: 0 auto; padding: 24px 20px 160px; overflow: auto; }
    .empty { color: var(--vscode-descriptionForeground); padding: 36px 0; text-align: center; }
    .message { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 10px; margin: 0 0 22px; }
    .avatar { width: 28px; height: 28px; display: grid; place-items: center; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: var(--vscode-sideBar-background); font-size: 11px; font-weight: 600; }
    .message.user .avatar { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: transparent; }
    .author { margin-bottom: 4px; font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); }
    .content { white-space: pre-wrap; overflow-wrap: anywhere; }
    .streaming .content::after { content: ''; display: inline-block; width: 2px; height: 1em; margin-left: 2px; vertical-align: -2px; background: var(--vscode-foreground); animation: blink 1s steps(1) infinite; }
    .tool-list { display: grid; gap: 6px; margin: -10px 0 20px 44px; }
    .tool { padding: 7px 10px; border: 1px solid var(--vscode-panel-border); border-radius: 7px; color: var(--vscode-descriptionForeground); background: var(--vscode-sideBar-background); font-size: 12px; }
    .interaction { margin: 0 0 22px 44px; padding: 14px; border: 1px solid var(--vscode-focusBorder); border-radius: 9px; background: var(--vscode-sideBar-background); }
    .interaction-title { margin-bottom: 10px; font-weight: 600; }
    .interaction-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .field { display: grid; gap: 5px; margin-bottom: 10px; }
    .field input, .field select { min-height: 36px; width: 100%; padding: 6px 9px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
    .composer-wrap { position: fixed; inset: auto 0 0; padding: 14px 20px 18px; background: linear-gradient(transparent, var(--vscode-editor-background) 24%); }
    .composer { width: min(860px, 100%); margin: 0 auto; padding: 8px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 10px; background: var(--vscode-input-background); box-shadow: 0 8px 28px rgba(0,0,0,.18); }
    textarea { display: block; width: 100%; min-height: 58px; max-height: 180px; resize: vertical; padding: 7px 8px; color: var(--vscode-input-foreground); background: transparent; border: 0; outline: 0; }
    .composer-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 7px; }
    button { min-height: 34px; padding: 5px 12px; border: 1px solid transparent; border-radius: 5px; cursor: pointer; }
    button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); border-color: var(--vscode-panel-border); }
    button:disabled { cursor: default; opacity: .55; }
    button:focus-visible, textarea:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .detail { max-width: 48vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-errorForeground); font-size: 12px; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    [hidden] { display: none !important; }
    @keyframes blink { 50% { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .streaming .content::after { animation: none; } }
    @media (max-width: 560px) { .timeline { padding-inline: 12px; } .topbar { padding-inline: 12px; } .message { grid-template-columns: 28px minmax(0,1fr); } .avatar { width: 24px; height: 24px; } .interaction, .tool-list { margin-left: 38px; } }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="heading"><h1>${labels.title}</h1><div class="status" id="status"><span class="dot"></span><span id="status-text">${labels.connecting}</span></div></div>
      <div class="detail" id="detail" role="status" aria-live="polite"></div>
    </header>
    <section class="timeline" id="timeline" aria-live="polite"></section>
    <div class="composer-wrap">
      <form class="composer" id="composer">
        <label for="prompt" class="sr-only">${labels.placeholder}</label>
        <textarea id="prompt" placeholder="${labels.placeholder}" aria-label="${labels.placeholder}"></textarea>
        <div class="composer-actions"><button type="button" class="secondary" id="stop" hidden>${labels.stop}</button><button type="submit" class="primary" id="send">${labels.send}</button></div>
      </form>
    </div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const labels = ${JSON.stringify(labels)};
    const timeline = document.getElementById('timeline');
    const status = document.getElementById('status');
    const statusText = document.getElementById('status-text');
    const detail = document.getElementById('detail');
    const prompt = document.getElementById('prompt');
    const send = document.getElementById('send');
    const stop = document.getElementById('stop');
    let latest = { messages: [], tools: [], running: false, state: 'connecting' };
    const stateLabels = { connecting: labels.connecting, running: labels.running, permission: labels.permission, question: labels.question, ready: labels.ready, stopped: labels.stopped, stopping: labels.stopping, error: labels.error };
    function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
    function renderMessage(item, streaming) {
      const row = el('article', 'message ' + item.role + (streaming ? ' streaming' : ''));
      row.appendChild(el('div', 'avatar', item.role === 'user' ? labels.you.slice(0, 1) : 'A'));
      const body = el('div', 'message-body'); body.appendChild(el('div', 'author', item.role === 'user' ? labels.you : labels.agent)); body.appendChild(el('div', 'content', item.text || '')); row.appendChild(body); return row;
    }
    function renderInteraction(interaction) {
      if (!interaction) return null;
      const box = el('section', 'interaction');
      const permissionAction = interaction.params && interaction.params.toolCall && interaction.params.toolCall.title;
      const schema = interaction.params && interaction.params.requestedSchema || {};
      const title = interaction.kind === 'permission'
        ? labels.permission + (permissionAction ? ' · ' + permissionAction : '')
        : (interaction.params && interaction.params.message) || schema.title || labels.question;
      box.appendChild(el('div', 'interaction-title', title));
      if (interaction.kind === 'permission') {
        const actions = el('div', 'interaction-actions');
        const permissionLabels = { allow_once: labels.allowOnce, allow_always: labels.allowAlways, reject_once: labels.rejectOnce, reject_always: labels.rejectAlways };
        (interaction.params.options || []).forEach(option => { const button = el('button', option.kind === 'allow_once' ? 'primary' : 'secondary', permissionLabels[option.kind] || option.name || option.kind); button.type = 'button'; button.addEventListener('click', () => vscode.postMessage({ command: 'permission', optionId: option.optionId })); actions.appendChild(button); });
        const cancel = el('button', 'secondary', labels.cancel); cancel.type = 'button'; cancel.addEventListener('click', () => vscode.postMessage({ command: 'permission', optionId: '' })); actions.appendChild(cancel); box.appendChild(actions);
      } else {
        const fields = {};
        Object.entries(schema.properties || {}).forEach(([key, spec]) => { const field = el('label', 'field'); field.appendChild(el('span', '', spec.title || key)); let input; const choices = Array.isArray(spec.oneOf) ? spec.oneOf : [];
          if (choices.length) { input = el('select'); choices.forEach(choice => { const option = el('option', '', choice.title || String(choice.const)); option.value = String(choice.const); input.appendChild(option); }); } else { input = el('input'); input.type = 'text'; }
          input.dataset.field = key; field.appendChild(input); fields[key] = input; box.appendChild(field); });
        const actions = el('div', 'interaction-actions'); const approve = el('button', 'primary', labels.approve); approve.type = 'button'; approve.addEventListener('click', () => { const content = {}; Object.entries(fields).forEach(([key, input]) => content[key] = input.value); vscode.postMessage({ command: 'elicitation', action: 'accept', content }); }); actions.appendChild(approve);
        const decline = el('button', 'secondary', labels.decline); decline.type = 'button'; decline.addEventListener('click', () => vscode.postMessage({ command: 'elicitation', action: 'decline' })); actions.appendChild(decline); box.appendChild(actions);
      }
      return box;
    }
    function render() {
      status.dataset.state = latest.state; statusText.textContent = stateLabels[latest.state] || latest.state; detail.textContent = latest.detail || '';
      timeline.replaceChildren();
      (latest.messages || []).forEach(item => timeline.appendChild(renderMessage(item, false)));
      if (latest.streamingText) timeline.appendChild(renderMessage({ role: 'agent', text: latest.streamingText }, latest.running));
      if ((latest.tools || []).length) { const list = el('div', 'tool-list'); latest.tools.forEach(tool => { const statusLabel = tool.status === 'completed' ? '' : tool.status === 'failed' ? labels.failed : labels.working; list.appendChild(el('div', 'tool', tool.title + (statusLabel ? ' · ' + statusLabel : ''))); }); timeline.appendChild(list); }
      const interaction = renderInteraction(latest.interaction); if (interaction) timeline.appendChild(interaction);
      if (!(latest.messages || []).length && !latest.streamingText) timeline.appendChild(el('div', 'empty', stateLabels[latest.state] || labels.connecting));
      send.disabled = latest.running || latest.state === 'connecting' || latest.state === 'error'; prompt.disabled = send.disabled; stop.disabled = !latest.running; stop.hidden = !latest.running;
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' });
    }
    window.addEventListener('message', event => { if (event.data && event.data.command === 'state') { latest = event.data; render(); } });
    document.getElementById('composer').addEventListener('submit', event => { event.preventDefault(); const text = prompt.value.trim(); if (!text || send.disabled) return; prompt.value = ''; vscode.postMessage({ command: 'submit', text }); });
    prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); document.getElementById('composer').requestSubmit(); } });
    stop.addEventListener('click', () => vscode.postMessage({ command: 'stop' }));
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
}
