import type * as vscode from 'vscode';

export type WebviewMessageTarget = Pick<vscode.Webview, 'postMessage'> | null | undefined;
export type WebviewMessageHandler = (message: any) => void | Promise<void>;
export type WebviewMessageHandlers = Record<string, WebviewMessageHandler>;

export function postWebviewMessage(target: WebviewMessageTarget, message: Record<string, unknown>): Thenable<boolean> | Promise<boolean> {
  if (!target) {
    return Promise.resolve(false);
  }
  return target.postMessage(message);
}

export function postSettingsLoaded(target: WebviewMessageTarget, settings: unknown): Thenable<boolean> | Promise<boolean> {
  return postWebviewMessage(target, { command: 'settingsLoaded', settings });
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

