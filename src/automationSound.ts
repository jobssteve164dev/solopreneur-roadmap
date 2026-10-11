import type * as vscode from 'vscode';

const readyViews = new WeakMap<vscode.Webview, string>();
const pending = new Map<string, { view: vscode.Webview; id: string; pageId: string; resolve: (played: boolean) => void }>();

export function automationSoundReady(view: vscode.Webview | undefined): boolean {
  return Boolean(view && readyViews.has(view));
}

export function handleAutomationSoundMessage(view: vscode.Webview | undefined, message: Record<string, unknown>): boolean {
  if (!view) return false;
  if (message.command === 'automationSoundReady') {
    if (typeof message.pageId !== 'string' || !message.pageId) return true;
    if (readyViews.get(view) !== message.pageId) {
      disposeAutomationSoundView(view); readyViews.set(view, message.pageId);
    }
    return true;
  }
  if (message.command !== 'automationSoundPlayed') return false;
  const token = String(message.token || ''); const delivery = pending.get(token);
  if (delivery?.view === view && delivery.id === message.deliveryId && delivery.pageId === message.pageId && readyViews.get(view) === message.pageId) {
    pending.delete(token); delivery.resolve(message.played === true);
  }
  return true;
}

export function disposeAutomationSoundView(view: vscode.Webview): void {
  readyViews.delete(view);
  for (const [token, delivery] of pending) if (delivery.view === view) {
    pending.delete(token); delivery.resolve(false);
  }
}

export async function deliverAutomationSound(view: vscode.Webview, id: string, token: string, posted: () => void): Promise<boolean> {
  if (!automationSoundReady(view)) return false;
  const pageId = readyViews.get(view)!;
  const acknowledgement = new Promise<boolean>(resolve => pending.set(token, { view, id, pageId, resolve }));
  try {
    if (!await view.postMessage({ command: 'automationPlaySound', pageId, deliveryId: id, token })) {
      pending.delete(token); return false;
    }
    posted();
    return await acknowledgement;
  } finally { pending.delete(token); }
}
