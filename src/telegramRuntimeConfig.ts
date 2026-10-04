import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';

export interface TelegramRuntimeConfig {
  schemaVersion: 1;
  enabled: boolean;
  botToken: string;
  chatId: string;
  selectedProjectPath: string;
  language: string;
  bindingGeneration: number;
  replyGeneration: number;
  conversationIds: Record<string, string>;
}

export function telegramRuntimePath(globalDataPath: string, name: string): string {
  return path.join(normalizeGlobalDataPathForExtension(globalDataPath), 'runtime', name);
}

export function writeTelegramRuntimeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

export function readTelegramRuntimeConfig(globalDataPath: string): TelegramRuntimeConfig {
  let value: Partial<TelegramRuntimeConfig> = {};
  const filePath = telegramRuntimePath(globalDataPath, 'telegram-config.json');
  if (fs.existsSync(filePath)) value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {
    schemaVersion: 1,
    enabled: value.enabled === true,
    botToken: String(value.botToken || ''),
    chatId: String(value.chatId || ''),
    selectedProjectPath: String(value.selectedProjectPath || ''),
    language: value.language === 'en' ? 'en' : 'zh',
    bindingGeneration: Number(value.bindingGeneration || 0),
    replyGeneration: Number(value.replyGeneration ?? value.bindingGeneration ?? 0),
    conversationIds: value.conversationIds || {}
  };
}

export function writeTelegramRuntimeConfig(globalDataPath: string, patch: Partial<TelegramRuntimeConfig>): TelegramRuntimeConfig {
  const current = readTelegramRuntimeConfig(globalDataPath);
  const changedBinding = (patch.botToken !== undefined && patch.botToken !== current.botToken)
    || (patch.chatId !== undefined && patch.chatId !== current.chatId);
  const changedAccess = changedBinding || (patch.enabled !== undefined && patch.enabled !== current.enabled);
  const next = { ...current, ...patch, schemaVersion: 1 as const,
    replyGeneration: changedAccess ? current.replyGeneration + 1 : current.replyGeneration,
    bindingGeneration: changedBinding ? current.bindingGeneration + 1 : current.bindingGeneration };
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    writeTelegramRuntimeJson(telegramRuntimePath(globalDataPath, 'telegram-config.json'), next);
  }
  return next;
}

export function queueTelegramBackgroundNotification(globalDataPath: string, text: string, parseMode?: 'HTML'): void {
  const config = readTelegramRuntimeConfig(globalDataPath);
  if (!config.enabled || !config.botToken || !config.chatId) return;
  writeTelegramRuntimeJson(telegramRuntimePath(globalDataPath, `telegram-outbox/${Date.now()}-${crypto.randomUUID()}.json`), {
    replyGeneration: config.replyGeneration, chatId: config.chatId, text, ...(parseMode ? { parseMode } : {})
  });
}
