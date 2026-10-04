import * as vscode from 'vscode';
import { TelegramHost, sendTelegramNotification as sendNotification, startTelegramRemoteService as startService } from './telegramService';

export { callTelegramApi, stopTelegramRemoteService, mockTelegramUpdates, mockTelegramSentMessages,
  mockTelegramChatActions, mockTelegramApiFailures } from './telegramService';

// Editor adapter for the same transport used by the standalone runtime.
export function createVscodeTelegramHost(context: vscode.ExtensionContext): TelegramHost {
  return {
    getSettings() {
      const config = vscode.workspace.getConfiguration('solopreneur');
      const saved = context.globalState.get<any>('solopreneur.settings') || {};
      return {
        telegramEnabled: saved.telegramEnabled ?? config.get<boolean>('telegramEnabled') ?? false,
        telegramBotToken: saved.telegramBotToken ?? config.get<string>('telegramBotToken') ?? '',
        telegramChatId: saved.telegramChatId ?? config.get<string>('telegramChatId') ?? ''
      };
    },
    async authorizeChat(username, chatId) {
      return await vscode.window.showWarningMessage(
        `检测到 Telegram 账号 ${username} (Chat ID: ${chatId}) 申请绑定控制权限，是否授权此设备控制您的本地电脑？`,
        'Approve / 授权', 'Deny / 拒绝') === 'Approve / 授权';
    },
    async bindChat(chatId) {
      await vscode.workspace.getConfiguration('solopreneur').update('telegramChatId', chatId, vscode.ConfigurationTarget.Global);
      const saved = context.globalState.get<any>('solopreneur.settings') || {};
      await context.globalState.update('solopreneur.settings', { ...saved, telegramChatId: chatId });
      await vscode.commands.executeCommand('solopreneur.settingsSavedBroadcast');
    },
    async executeCommand(command, ...args) { return vscode.commands.executeCommand(command, ...args); }
  };
}

export function startTelegramRemoteService(context: vscode.ExtensionContext, reply?: (chatId: string, text: string) => Promise<string>, diagnosticDataPath = ''): void {
  startService(createVscodeTelegramHost(context), reply, diagnosticDataPath);
}

export const restartTelegramRemoteService = startTelegramRemoteService;

export async function sendTelegramNotification(context: vscode.ExtensionContext, text: string): Promise<void> {
  await sendNotification(createVscodeTelegramHost(context), text);
}
