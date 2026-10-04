import { TelegramHost } from './telegramService';
import { startTelegramExtensionBridge } from './telegramExtensionBridge';
import { readTelegramRuntimeConfig, TelegramRuntimeConfig, writeTelegramRuntimeConfig } from './telegramRuntimeConfig';

export function createTelegramBackgroundConnection(options: {
  host: TelegramHost;
  bindChat(chatId: string): Promise<void>;
  ensureRuntime(): Promise<void>;
}): { sync(globalDataPath: string, selectedProjectPath: string, language: string, legacyIds?: Record<string, string>): Promise<void>; dispose(): void } {
  let currentRoot = '';
  let bridge: { dispose(): void } | undefined;
  let initialization: Promise<void> = Promise.resolve();
  let ensurePending: Promise<void> | undefined;
  let disposed = false;
  return {
    async sync(globalDataPath, selectedProjectPath, language, legacyIds = {}) {
      if (disposed) return;
      const settings = options.host.getSettings();
      const previous = readTelegramRuntimeConfig(globalDataPath);
      const patch: Partial<TelegramRuntimeConfig> = {
        enabled: settings.telegramEnabled, botToken: settings.telegramBotToken, chatId: settings.telegramChatId,
        selectedProjectPath, language
      };
      if (previous.botToken !== settings.telegramBotToken || previous.chatId !== settings.telegramChatId) patch.conversationIds = { ...legacyIds };
      writeTelegramRuntimeConfig(globalDataPath, patch);
      initialization = initialization.catch(() => undefined).then(async () => {
        if (disposed) return;
        if (!settings.telegramEnabled || !settings.telegramBotToken) {
          if (currentRoot && currentRoot !== globalDataPath) writeTelegramRuntimeConfig(currentRoot, { enabled: false });
          bridge?.dispose();
          bridge = undefined;
          currentRoot = '';
          return;
        }
        if (currentRoot === globalDataPath) return;
        if (currentRoot) writeTelegramRuntimeConfig(currentRoot, { enabled: false });
        bridge?.dispose();
        bridge = await startTelegramExtensionBridge(globalDataPath, async (command, args) => {
          if (command === 'authorizeChat' || command === 'bindChat') {
            const requestedGeneration = Number(args[command === 'authorizeChat' ? 2 : 1]);
            const authorized = () => {
              const config = readTelegramRuntimeConfig(globalDataPath);
              return !disposed && config.enabled && !config.chatId && config.bindingGeneration === requestedGeneration;
            };
            if (!authorized()) throw new Error('Telegram 绑定请求已失效，请重新发消息申请绑定。');
            if (command === 'authorizeChat') {
              const approved = await options.host.authorizeChat(args[0], args[1]);
              return approved && authorized();
            }
            await options.bindChat(args[0]);
            return true;
          }
          return options.host.executeCommand(command, ...args);
        });
        currentRoot = globalDataPath;
        if (disposed) bridge.dispose();
      });
      await initialization;
      if (disposed || !settings.telegramEnabled || !settings.telegramBotToken) return;
      if (!ensurePending) ensurePending = options.ensureRuntime().finally(() => { ensurePending = undefined; });
      await ensurePending;
    },
    dispose() {
      disposed = true;
      bridge?.dispose();
      // Closing the editor disconnects only its command bridge, never the TG daemon.
    }
  };
}
