import * as path from 'path';
import type * as vscode from 'vscode';

export interface LocalDataStatusView {
  title: string;
  message: string;
  detail?: string;
  actionLabel?: string;
  actionCommand?: string;
}

function joinExtensionUri(context: vscode.ExtensionContext, ...segments: string[]): vscode.Uri {
  const base = context.extensionUri as any;
  if (typeof base?.with === 'function') {
    return base.with({ path: path.posix.join(base.path, ...segments) });
  }
  const basePath = base?.fsPath || base?.path || String(base);
  const joined = path.join(basePath, ...segments);
  return {
    ...(base || {}),
    fsPath: joined,
    path: joined,
    toString: () => joined
  } as vscode.Uri;
}

function escapeHtml(value: string | number): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatLocalDataError(error: unknown, fallback = '本地数据加载失败。'): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  const message = String(error || '').trim();
  return message || fallback;
}

export async function runLocalDataLoad<T>(
  load: () => T | Promise<T>,
  onSuccess: (value: T) => void | Promise<void>,
  onFailure: (message: string) => void | Promise<void>,
  fallbackError = '本地数据加载失败。'
): Promise<void> {
  try {
    await onSuccess(await load());
  } catch (error) {
    await onFailure(formatLocalDataError(error, fallbackError));
  }
}

export async function loadLocalData<T>(
  load: () => T | Promise<T>,
  fallbackError = '本地数据加载失败。'
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await load() };
  } catch (error) {
    return { ok: false, message: formatLocalDataError(error, fallbackError) };
  }
}

export async function postLocalDataLoad<T>(
  load: () => T | Promise<T>,
  onSuccess: (value: T) => void | Promise<void>,
  onFailure: (message: string) => void | Promise<void>,
  fallbackError = '本地数据加载失败。'
): Promise<boolean> {
  const result = await loadLocalData(load, fallbackError);
  if (result.ok) {
    await onSuccess(result.value);
    return true;
  }
  await onFailure(result.message);
  return false;
}

export function buildLocalDataStatusHtml(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  status: LocalDataStatusView
): string {
  const codiconsUri = webview.asWebviewUri(joinExtensionUri(context, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
  const wordmarkUri = webview.asWebviewUri(joinExtensionUri(context, 'resources', 'logo_with_text.svg'));
  const action = status.actionCommand && status.actionLabel
    ? `<button class="status-action" data-action-command="${escapeHtml(status.actionCommand)}"><span class="codicon codicon-arrow-right"></span>${escapeHtml(status.actionLabel)}</button>`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${codiconsUri}" rel="stylesheet">
  <title>SoloMap</title>
  <style>
    :root {
      --bg: #0b0f16;
      --fg: #eef2f7;
      --muted: #9aa6b2;
      --border: rgba(255, 255, 255, 0.12);
      --panel: rgba(255, 255, 255, 0.04);
      --accent: #30d5c8;
      --danger: #ff6b6b;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: var(--bg);
      color: var(--fg);
    }
    .status-card {
      width: min(560px, 100%);
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--panel);
      padding: 22px;
      box-shadow: 0 14px 40px rgba(0, 0, 0, 0.24);
    }
    .wordmark {
      width: 138px;
      height: auto;
      margin-bottom: 20px;
    }
    .status-title {
      margin: 0;
      font-size: 20px;
      line-height: 1.35;
      font-weight: 700;
    }
    .status-message {
      margin: 10px 0 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.6;
    }
    .status-detail {
      margin-top: 12px;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid rgba(255, 107, 107, 0.22);
      color: #ffd6d6;
      background: rgba(255, 107, 107, 0.08);
      font-size: 12px;
      line-height: 1.5;
      word-break: break-word;
    }
    .status-action {
      margin-top: 18px;
      border: 1px solid rgba(48, 213, 200, 0.36);
      border-radius: 8px;
      background: rgba(48, 213, 200, 0.1);
      color: var(--fg);
      padding: 9px 13px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
    }
    .status-action:hover { background: rgba(48, 213, 200, 0.16); }
  </style>
</head>
<body>
  <main class="status-card">
    <img class="wordmark" src="${wordmarkUri}" alt="SoloMap">
    <h1 class="status-title">${escapeHtml(status.title)}</h1>
    <p class="status-message">${escapeHtml(status.message)}</p>
    ${status.detail ? `<div class="status-detail">${escapeHtml(status.detail)}</div>` : ''}
    ${action}
  </main>
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-action-command]').forEach(button => {
      button.addEventListener('click', () => {
        vscode.postMessage({ command: button.getAttribute('data-action-command') || '' });
      });
    });
  </script>
</body>
</html>`;
}
