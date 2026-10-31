import type * as vscode from 'vscode';
import * as crypto from 'crypto';

export type WebviewMessageTarget = Pick<vscode.Webview, 'postMessage'> | null | undefined;
export type WebviewMessageContainer = { readonly webview: WebviewMessageTarget } | null | undefined;
export type WebviewMessageHandler = (message: any) => void | Promise<void>;
export type WebviewMessageHandlers = Record<string, WebviewMessageHandler>;

interface BackgroundDelivery {
  message: Record<string, unknown>;
  waiters: Array<(delivered: boolean) => void>;
}

interface WebviewDeliveryState {
  active: boolean;
  pending: Map<string, BackgroundDelivery>;
}

const webviewDeliveries = new WeakMap<object, WebviewDeliveryState>();
const MAX_BACKGROUND_KEYS = 128;
const MAX_WAITERS_PER_KEY = 64;

const foregroundCommands = new Set([
  'agentCliUpgradeResult', 'cliTestResult', 'conversationActionAccepted', 'conversationActionSettled',
  'coverageAnalysisStarted', 'globalPromptReviewCompleted', 'globalPromptReviewStarted',
  'growth.reportActionSettled', 'intelligenceLoadFailed', 'intelligenceReplyFailed',
  'issueActionCompleted', 'mcpInstallResult', 'navigationReady', 'pastedAttachmentsAccepted',
  'pastedAttachmentsFailed', 'projectMetadataSaveFailed', 'projectMetadataSaved',
  'projectRefreshCompleted', 'projectSelectionChanged', 'pullRequestActionCompleted',
  'roadmapLoadFailed', 'roadmapRevisionLaunchRegistered', 'settingsSaved', 'sidebarActionFailed',
  'skillInstallResult', 'supplementFilesSelected'
]);

function backgroundDeliveryKey(message: Record<string, unknown>): string {
  const command = String(message.command || '');
  if (['projectIssuesLoaded', 'projectPullRequestsLoaded', 'projectDeliveryLoaded', 'projectSecurityLoaded', 'projectGrowthLoaded'].includes(command)) {
    return `${command}:${String(message.projectPath || '')}`;
  }
  if (command === 'projectsLoaded') {
    const projects = message.projects as { updatedProjectPaths?: unknown } | undefined;
    const updated = Array.isArray(projects?.updatedProjectPaths) ? projects.updatedProjectPaths.map(String).sort() : [];
    return `${command}:${updated.length === 1 ? updated[0] : 'core'}`;
  }
  if (command === 'sidebarProjectConversationSnapshotLoaded') {
    return `${command}:${String(message.projectPath || '')}`;
  }
  if (command === 'dailyReviewLoaded') return command;
  if (command === 'agentImpactLoaded' || command === 'databaseOverviewLoaded') {
    return command;
  }
  return '';
}

function protocolMessage(message: Record<string, unknown>, backgroundKey: string): Record<string, unknown> {
  const command = String(message.command || '');
  const lane = backgroundKey ? 'background' : foregroundCommands.has(command) ? 'foreground' : 'interactive';
  const interactionId = String(message.interactionId || message.launchActionId || message.requestId || '');
  return {
    ...message,
    protocolVersion: 1,
    messageId: crypto.randomUUID(),
    ...(interactionId ? { interactionId } : {}),
    lane,
    entityKey: backgroundKey || String(message.projectPath || command),
    revision: Number.isFinite(Number(message.revision)) ? Number(message.revision) : null,
    deadlineAt: lane === 'foreground' ? Date.now() + 10_000 : lane === 'interactive' ? Date.now() + 30_000 : Date.now() + 60_000,
    supersedesKey: backgroundKey || null
  };
}

function postDirect(target: NonNullable<WebviewMessageTarget>, message: Record<string, unknown>): Promise<boolean> {
  try {
    return Promise.resolve(target.postMessage(message)).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

function drainBackgroundDeliveries(target: NonNullable<WebviewMessageTarget>, state: WebviewDeliveryState): void {
  if (state.active) return;
  const next = state.pending.entries().next().value as [string, BackgroundDelivery] | undefined;
  if (!next) return;
  const [key, delivery] = next;
  state.pending.delete(key);
  if (Number(delivery.message.deadlineAt || 0) <= Date.now()) {
    for (const resolve of delivery.waiters) resolve(false);
    drainBackgroundDeliveries(target, state);
    return;
  }
  state.active = true;
  void postDirect(target, delivery.message).then(delivered => {
    for (const resolve of delivery.waiters) resolve(delivered);
  }).finally(() => {
    state.active = false;
    drainBackgroundDeliveries(target, state);
  });
}

export function postWebviewMessage(target: WebviewMessageTarget, message: Record<string, unknown>): Thenable<boolean> | Promise<boolean> {
  if (!target) {
    return Promise.resolve(false);
  }
  const backgroundKey = backgroundDeliveryKey(message);
  const deliveryMessage = protocolMessage(message, backgroundKey);
  if (!backgroundKey) return postDirect(target, deliveryMessage);
  let state = webviewDeliveries.get(target as object);
  if (!state) {
    state = { active: false, pending: new Map() };
    webviewDeliveries.set(target as object, state);
  }
  return new Promise<boolean>(resolve => {
    const pending = state!.pending.get(backgroundKey);
    if (pending) {
      pending.message = deliveryMessage;
      if (pending.waiters.length >= MAX_WAITERS_PER_KEY) pending.waiters.shift()?.(false);
      pending.waiters.push(resolve);
    } else {
      if (state!.pending.size >= MAX_BACKGROUND_KEYS) {
        const oldest = state!.pending.entries().next().value as [string, BackgroundDelivery] | undefined;
        if (oldest) {
          state!.pending.delete(oldest[0]);
          for (const superseded of oldest[1].waiters) superseded(false);
        }
      }
      state!.pending.set(backgroundKey, { message: deliveryMessage, waiters: [resolve] });
    }
    drainBackgroundDeliveries(target, state!);
  });
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
