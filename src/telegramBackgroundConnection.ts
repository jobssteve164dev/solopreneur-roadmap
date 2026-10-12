import * as crypto from 'crypto';

import { TelegramHost } from './telegramService';
import { startTelegramExtensionBridge } from './telegramExtensionBridge';
import { importLegacyTelegramConversationIds, persistTelegramRuntimeConfig, readTelegramRuntimeConfig, refreshTelegramRuntimeConfig, TelegramRuntimeConfig } from './telegramRuntimeConfig';
import { readProcessBirthMarker, readWindowsProcessBirthMarkerAsync } from './processIdentity';
import { registerTelegramHostPresence, releaseTelegramHostPresence, releaseTelegramHostPresenceAndRunWhenEmpty } from './telegramHostPresence';

export function createTelegramBackgroundConnection(options: {
  host: TelegramHost;
  loadSettings?(globalDataPath: string): Promise<ReturnType<TelegramHost['getSettings']>>;
  bindChat(chatId: string, acceptedOffset?: number): Promise<void>;
  ensureRuntime(): Promise<void>;
}): { sync(globalDataPath: string, selectedProjectPath: string, language: string, legacyIds?: Record<string, string>): Promise<{ legacySettled: boolean }>; dispose(): void } {
  const hostId = crypto.randomUUID();
  let hostBirth = '';
  const hostBirthReady = process.platform === 'win32'
    ? readWindowsProcessBirthMarkerAsync(process.pid).then(value => { hostBirth = value; })
    : Promise.resolve().then(() => { hostBirth = readProcessBirthMarker(process.pid); });
  let currentRoot = '';
  let bridge: { dispose(): void } | undefined;
  let initialization: Promise<void> = Promise.resolve();
  let ensurePending: Promise<void> | undefined;
  let syncQueue: Promise<void> = Promise.resolve();
  let requestedSyncGeneration = 0;
  let disposed = false;
  const heartbeat = setInterval(() => {
    const root = currentRoot;
    if (!disposed && root) void hostBirthReady.then(() => registerTelegramHostPresence(root, presence())).catch(() => undefined);
  }, 30_000);
  heartbeat.unref?.();
  const presence = () => ({ hostId, pid: process.pid, birth: hostBirth, updatedAt: new Date().toISOString() });
  const leaveRoot = async (root: string, disableWhenEmpty: boolean) => {
    if (!root) return 0;
    await hostBirthReady;
    return disableWhenEmpty
      ? releaseTelegramHostPresenceAndRunWhenEmpty(root, hostId, async () => { await persistTelegramRuntimeConfig(root, { enabled: false }); })
      : releaseTelegramHostPresence(root, hostId);
  };
  const runSync = async (generation: number, globalDataPath: string, selectedProjectPath: string, language: string, legacyIds: Record<string, string>) => {
      const stale = () => disposed || generation !== requestedSyncGeneration;
      if (stale()) return { legacySettled: false };
      await hostBirthReady;
      await options.ensureRuntime();
      if (stale()) return { legacySettled: false };
      if (currentRoot && currentRoot !== globalDataPath) {
        bridge?.dispose(); bridge = undefined;
        const previousRoot = currentRoot; currentRoot = '';
        await leaveRoot(previousRoot, true);
      }
      await registerTelegramHostPresence(globalDataPath, presence());
      if (stale()) {
        await leaveRoot(globalDataPath, false);
        return { legacySettled: false };
      }
      currentRoot = globalDataPath;
      let legacySettled = Object.keys(legacyIds).length === 0;
      if (!legacySettled) legacySettled = (await importLegacyTelegramConversationIds(globalDataPath, legacyIds)).settled;
      if (stale()) { await leaveRoot(globalDataPath, false); currentRoot = ''; return { legacySettled: false }; }
      const settings = options.loadSettings ? await options.loadSettings(globalDataPath) : options.host.getSettings();
      if (stale()) { await leaveRoot(globalDataPath, false); currentRoot = ''; return { legacySettled: false }; }
      const previous = await refreshTelegramRuntimeConfig(globalDataPath);
      if (stale()) { await leaveRoot(globalDataPath, false); currentRoot = ''; return { legacySettled: false }; }
      const patch: Partial<TelegramRuntimeConfig> = {
        enabled: settings.telegramEnabled, botToken: settings.telegramBotToken, chatId: settings.telegramChatId,
        selectedProjectPath, language
      };
      if ((previous.botToken !== settings.telegramBotToken || previous.chatId !== settings.telegramChatId)
        && (previous.botToken || previous.chatId)) patch.conversationIds = {};
      await persistTelegramRuntimeConfig(globalDataPath, patch);
      if (stale()) { await leaveRoot(globalDataPath, false); currentRoot = ''; return { legacySettled: false }; }
      initialization = initialization.catch(() => undefined).then(async () => {
        if (stale()) return;
        if (!settings.telegramEnabled || !settings.telegramBotToken) {
          bridge?.dispose();
          bridge = undefined;
          return;
        }
        if (bridge && currentRoot === globalDataPath) return;
        bridge?.dispose();
        const nextBridge = await startTelegramExtensionBridge(globalDataPath, async (command, args) => {
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
        if (stale()) { nextBridge.dispose(); return; }
        bridge = nextBridge;
        currentRoot = globalDataPath;
        if (disposed) bridge.dispose();
      });
      await initialization;
      if (stale()) { await leaveRoot(globalDataPath, false); currentRoot = ''; return { legacySettled: false }; }
      if (!settings.telegramEnabled || !settings.telegramBotToken) return { legacySettled };
      if (!ensurePending) ensurePending = options.ensureRuntime().finally(() => { ensurePending = undefined; });
      await ensurePending;
      return { legacySettled };
  };
  return {
    sync(globalDataPath, selectedProjectPath, language, legacyIds = {}) {
      const generation = ++requestedSyncGeneration;
      const result = syncQueue.catch(() => undefined).then(() => runSync(generation, globalDataPath, selectedProjectPath, language, legacyIds));
      syncQueue = result.then(() => undefined, () => undefined);
      return result;
    },
    dispose() {
      disposed = true;
      clearInterval(heartbeat);
      bridge?.dispose();
      const root = currentRoot; currentRoot = '';
      void leaveRoot(root, false).catch(() => undefined);
    }
  };
}
