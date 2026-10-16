import type * as vscode from 'vscode';

export type WebviewMessageTarget = Pick<vscode.Webview, 'postMessage'> | null | undefined;
export type WebviewMessageContainer = { readonly webview: WebviewMessageTarget } | null | undefined;
export type WebviewMessageHandler = (message: any) => void | Promise<void>;
export type WebviewMessageHandlers = Record<string, WebviewMessageHandler>;

export function postWebviewMessage(target: WebviewMessageTarget, message: Record<string, unknown>): Thenable<boolean> | Promise<boolean> {
  if (!target) {
    return Promise.resolve(false);
  }
  try {
    return Promise.resolve(target.postMessage(message)).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

export function postWebviewContainerMessage(container: WebviewMessageContainer, message: Record<string, unknown>): Thenable<boolean> | Promise<boolean> {
  try {
    return postWebviewMessage(container?.webview, message);
  } catch {
    return Promise.resolve(false);
  }
}

export function webviewFromContainer<T extends WebviewMessageTarget>(container: { readonly webview: T } | null | undefined): T | undefined {
  try {
    return container?.webview || undefined;
  } catch {
    return undefined;
  }
}

export function updateWebviewContainer<T extends WebviewMessageTarget>(container: { readonly webview: T } | null | undefined, update: (webview: NonNullable<T>) => void): boolean {
  let webview: T | undefined;
  try {
    webview = container?.webview || undefined;
  } catch {
    return false;
  }
  if (!webview) return false;
  update(webview as NonNullable<T>);
  return true;
}

export function postSettingsLoaded(target: WebviewMessageTarget, settings: unknown, projectRoot?: string): Thenable<boolean> | Promise<boolean> {
  return postWebviewMessage(target, { command: 'settingsLoaded', settings, ...(projectRoot === undefined ? {} : { projectRoot }) });
}

export function postProjectsLoaded(target: WebviewMessageTarget, projects: unknown): Thenable<boolean> | Promise<boolean> {
  return postWebviewMessage(target, { command: 'projectsLoaded', projects });
}

export function postFlowStateLoaded(target: WebviewMessageTarget, state: unknown): Thenable<boolean> | Promise<boolean> {
  return postWebviewMessage(target, { command: 'flowStateLoaded', state });
}

export function postAgentModelsLoaded(
  target: WebviewMessageTarget,
  message: { requestId: string; targetId: string; agentCli: string; catalog: unknown }
): Thenable<boolean> | Promise<boolean> {
  return postWebviewMessage(target, { command: 'agentModelsLoaded', ...message });
}

export async function dispatchWebviewMessage(
  message: any,
  handlers: WebviewMessageHandlers,
  onUnhandled?: WebviewMessageHandler
): Promise<boolean> {
  const command = String(message?.command || '');
  const handler = command ? handlers[command] : undefined;
  if (handler) {
    await handler(message);
    return true;
  }
  if (onUnhandled) {
    await onUnhandled(message);
    return false;
  }
  return false;
}
