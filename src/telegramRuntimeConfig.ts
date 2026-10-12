import * as crypto from 'crypto';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';
import type { RuntimeDataOperations } from './runtimeDataOperations';

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
  offset: number;
}

type TelegramSettingItem = { key: string; objectId: string; revision: number; value?: unknown; secretRef?: string };
const configs = new Map<string, TelegramRuntimeConfig>();
const revisions = new Map<string, Map<string, number>>();
const runtimeSecrets = new Map<string, Map<string, string>>();
const tokenFingerprints = new Map<string, string>();
const tokenFingerprintRevisions = new Map<string, number>();
export const telegramBotTokenSecretStorageKey = 'solopreneur.telegramBotToken';
export const telegramBotTokenSecretRef = `vscode-secret://${telegramBotTokenSecretStorageKey}`;

function secretIdentity(root: string): string { return crypto.createHash('sha256').update(root).digest('hex'); }
function tokenFingerprint(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function testSecretPath(root: string): string | null {
  const base = process.env.SOLOMAP_TEST_SECRET_STORE;
  return base ? path.join(base, `${secretIdentity(root)}.secret`) : null;
}
function persistHostSecret(root: string, value: string): void {
  const fixture = testSecretPath(root);
  if (fixture) { fs.mkdirSync(path.dirname(fixture), { recursive: true }); fs.writeFileSync(fixture, value, { mode: 0o600 }); return; }
  if (process.env.NODE_TEST_CONTEXT) return;
  const identity = secretIdentity(root);
  if (process.platform === 'linux') {
    const result = childProcess.spawnSync('secret-tool', ['store', '--label=SoloMap Telegram bot token', 'application', 'solomap', 'purpose', 'telegram-bot-token', 'data-root', identity], { input: value, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('runtime_secret_store_unavailable');
    return;
  }
  if (process.platform === 'darwin') {
    const result = childProcess.spawnSync('security', ['add-generic-password', '-U', '-a', telegramBotTokenSecretStorageKey, '-s', `site.szlk.solomap.${identity}`, '-w', value], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('runtime_secret_store_unavailable');
    return;
  }
  if (process.platform === 'win32') {
    const directory = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SoloMap', 'secrets');
    const destination = path.join(directory, identity);
    fs.mkdirSync(directory, { recursive: true });
    const script = '$b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd());$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[IO.File]::WriteAllBytes($args[0],$e)';
    const result = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, destination], { input: value, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('runtime_secret_store_unavailable');
    return;
  }
  throw new Error('runtime_secret_store_unavailable');
}
function readHostSecret(root: string): string {
  const fixture = testSecretPath(root);
  if (fixture) return fs.existsSync(fixture) ? fs.readFileSync(fixture, 'utf8') : '';
  if (process.env.NODE_TEST_CONTEXT) return '';
  const identity = secretIdentity(root);
  if (process.platform === 'linux') return childProcess.spawnSync('secret-tool', ['lookup', 'application', 'solomap', 'purpose', 'telegram-bot-token', 'data-root', identity], { encoding: 'utf8' }).stdout?.trim() || '';
  if (process.platform === 'darwin') return childProcess.spawnSync('security', ['find-generic-password', '-a', telegramBotTokenSecretStorageKey, '-s', `site.szlk.solomap.${identity}`, '-w'], { encoding: 'utf8' }).stdout?.trim() || '';
  if (process.platform === 'win32') {
    const source = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SoloMap', 'secrets', identity);
    if (!fs.existsSync(source)) return '';
    const script = '$e=[IO.File]::ReadAllBytes($args[0]);$b=[Security.Cryptography.ProtectedData]::Unprotect($e,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))';
    return childProcess.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, source], { encoding: 'utf8' }).stdout || '';
  }
  return '';
}

export function installTelegramRuntimeSecret(globalDataPath: string, secretRef: string, value: string): void {
  if (secretRef !== telegramBotTokenSecretRef || !value) throw new Error('runtime_secret_invalid');
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  const secrets = runtimeSecrets.get(root) || new Map<string, string>();
  secrets.set(secretRef, value); runtimeSecrets.set(root, secrets);
}

export function persistTelegramRuntimeSecret(globalDataPath: string, secretRef: string, value: string): void {
  persistHostSecret(normalizeGlobalDataPathForExtension(globalDataPath), value);
  installTelegramRuntimeSecret(globalDataPath, secretRef, value);
}

function resolveRuntimeSecret(root: string, secretRef: string): string {
  const current = runtimeSecrets.get(root)?.get(secretRef);
  if (current) return current;
  const restored = readHostSecret(root);
  if (restored) installTelegramRuntimeSecret(root, secretRef, restored);
  return restored;
}

export function readTelegramRuntimeConfig(globalDataPath: string): TelegramRuntimeConfig {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  const value: Partial<TelegramRuntimeConfig> = configs.get(root) || {};
  return {
    schemaVersion: 1,
    enabled: value.enabled === true,
    botToken: String(value.botToken || ''),
    chatId: String(value.chatId || ''),
    selectedProjectPath: String(value.selectedProjectPath || ''),
    language: value.language === 'en' ? 'en' : 'zh',
    bindingGeneration: Number(value.bindingGeneration || 0),
    replyGeneration: Number(value.replyGeneration ?? value.bindingGeneration ?? 0),
    conversationIds: value.conversationIds || {},
    offset: Number(value.offset || 0)
  };
}

export function writeTelegramRuntimeConfig(globalDataPath: string, patch: Partial<TelegramRuntimeConfig>): TelegramRuntimeConfig {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  const current = readTelegramRuntimeConfig(root);
  const changedBinding = (patch.botToken !== undefined && patch.botToken !== current.botToken)
    || (patch.chatId !== undefined && patch.chatId !== current.chatId);
  const changedBot = patch.botToken !== undefined && patch.botToken !== current.botToken;
  const changedAccess = changedBinding || (patch.enabled !== undefined && patch.enabled !== current.enabled);
  const next = { ...current, ...patch, schemaVersion: 1 as const,
    replyGeneration: changedAccess ? current.replyGeneration + 1 : current.replyGeneration,
    bindingGeneration: changedBinding ? current.bindingGeneration + 1 : current.bindingGeneration,
    conversationIds: changedBinding && patch.conversationIds === undefined ? {} : (patch.conversationIds ?? current.conversationIds),
    offset: changedBot ? 0 : Number(patch.offset ?? current.offset) };
  if (JSON.stringify(next) !== JSON.stringify(current)) configs.set(root, next);
  return next;
}

function telegramOperation(globalDataPath: string, operation?: RuntimeDataOperations) {
  return (name: string, input: Record<string, unknown>) => operation ? operation({ operation: name, input }) : sendRuntimeDataRequest(globalDataPath, { operation: name, input });
}

export async function refreshTelegramRuntimeConfig(globalDataPath: string, operation?: RuntimeDataOperations): Promise<TelegramRuntimeConfig> {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  const result = await telegramOperation(root, operation)('read_host_settings', { namespace: 'telegram', ownerScope: 'global', secretStateRef: telegramBotTokenSecretRef }) as { items: TelegramSettingItem[]; secretState?: { fingerprint: string; revision: number } };
  const fields = new Map(result.items.map(item => [item.key, item]));
  const legacyFingerprint = fields.get('botTokenFingerprint');
  if (legacyFingerprint) {
    const fingerprint = String(legacyFingerprint.value || '');
    await telegramOperation(root, operation)('migrate_host_secret_state', { namespace: 'telegram', ownerScope: 'global', legacyKey: legacyFingerprint.key,
      expectedRevision: legacyFingerprint.revision, secretRef: telegramBotTokenSecretRef, fingerprint,
      idempotencyKey: `telegram-secret-state-migration:${legacyFingerprint.objectId || legacyFingerprint.key}:${legacyFingerprint.revision}` });
    return refreshTelegramRuntimeConfig(root, operation);
  }
  revisions.set(root, new Map(result.items.map(item => [item.key, item.revision])));
  tokenFingerprints.set(root, String(result.secretState?.fingerprint || ''));
  tokenFingerprintRevisions.set(root, Number(result.secretState?.revision || 0));
  const config: TelegramRuntimeConfig = {
    schemaVersion: 1,
    enabled: fields.get('enabled')?.value === true,
    botToken: fields.get('botToken')?.secretRef
      ? resolveRuntimeSecret(root, String(fields.get('botToken')!.secretRef))
      : String(fields.get('botToken')?.value || ''),
    chatId: String(fields.get('chatId')?.value || ''),
    selectedProjectPath: String(fields.get('selectedProjectPath')?.value || ''),
    language: fields.get('language')?.value === 'en' ? 'en' : 'zh',
    bindingGeneration: Number(fields.get('bindingGeneration')?.value || 0),
    replyGeneration: Number(fields.get('replyGeneration')?.value || 0),
    conversationIds: fields.get('conversationIds')?.value && typeof fields.get('conversationIds')?.value === 'object' ? fields.get('conversationIds')!.value as Record<string, string> : {},
    offset: Number(fields.get('offset')?.value || 0)
  };
  configs.set(root, config);
  return config;
}

export async function importLegacyTelegramConversationIds(globalDataPath: string, ids: Record<string, string>, operation?: RuntimeDataOperations): Promise<{ settled: boolean; imported: boolean }> {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  const sourceHash = crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(ids).sort(([left], [right]) => left.localeCompare(right))))).digest('hex');
  return telegramOperation(root, operation)('import_legacy_telegram_conversations', { sourceHash, ids }) as Promise<{ settled: boolean; imported: boolean }>;
}

export async function persistTelegramRuntimeConfig(globalDataPath: string, patch: Partial<TelegramRuntimeConfig>, operation?: RuntimeDataOperations, idempotencyKey = `telegram-config:${crypto.randomUUID()}`): Promise<TelegramRuntimeConfig> {
  const root = normalizeGlobalDataPathForExtension(globalDataPath);
  const attempt = async (): Promise<TelegramRuntimeConfig> => {
    let current: TelegramRuntimeConfig;
    try { current = await refreshTelegramRuntimeConfig(root, operation); }
    catch { current = readTelegramRuntimeConfig(root); }
    const desiredFingerprint = patch.botToken ? tokenFingerprint(patch.botToken) : '';
    const changedBot = Boolean(patch.botToken) && desiredFingerprint !== (tokenFingerprints.get(root) || '');
    if (patch.botToken) {
      await telegramOperation(root, operation)('install_runtime_secret', { secretRef: telegramBotTokenSecretRef, value: patch.botToken });
      installTelegramRuntimeSecret(root, telegramBotTokenSecretRef, patch.botToken);
    }
    const changedBinding = changedBot || (patch.chatId !== undefined && patch.chatId !== current.chatId);
    const changedAccess = changedBinding || (patch.enabled !== undefined && patch.enabled !== current.enabled);
    const next: TelegramRuntimeConfig = { ...current, ...patch, schemaVersion: 1,
      replyGeneration: changedAccess ? current.replyGeneration + 1 : current.replyGeneration,
      bindingGeneration: changedBinding ? current.bindingGeneration + 1 : current.bindingGeneration,
      conversationIds: changedBinding && patch.conversationIds === undefined ? {} : (patch.conversationIds ?? current.conversationIds),
      offset: changedBot ? 0 : Number(patch.offset ?? current.offset) };
    const known = revisions.get(root) || new Map<string, number>();
    const fields = ['enabled', 'chatId', 'selectedProjectPath', 'language', 'bindingGeneration', 'replyGeneration', 'conversationIds', 'offset'] as const;
    const patches: Array<{ key: string; expectedRevision: number; value?: unknown; secretRef?: string }> = fields
      .filter(key => key === 'offset' && changedBot || key === 'conversationIds' && changedBinding || JSON.stringify(current[key]) !== JSON.stringify(next[key]) || !known.has(key))
      .map(key => ({ key, expectedRevision: known.get(key) || 0, value: next[key] }));
    if (patch.botToken && (changedBot || !known.has('botToken'))) patches.push({ key: 'botToken', expectedRevision: known.get('botToken') || 0, secretRef: telegramBotTokenSecretRef });
    const secretState = patch.botToken && (changedBot || !tokenFingerprintRevisions.has(root))
      ? { secretRef: telegramBotTokenSecretRef, fingerprint: desiredFingerprint, expectedRevision: tokenFingerprintRevisions.get(root) || 0 }
      : undefined;
    if (patches.length || secretState) {
      try { await telegramOperation(root, operation)('patch_host_settings', { namespace: 'telegram', ownerScope: 'global', patches, ...(secretState ? { secretState } : {}), idempotencyKey }); }
      catch (error) {
        if ((error as Error).message !== 'revision_conflict') throw error;
        await refreshTelegramRuntimeConfig(root, operation);
        return attempt();
      }
    }
    return refreshTelegramRuntimeConfig(root, operation);
  };
  return attempt();
}

export async function queueTelegramBackgroundNotification(globalDataPath: string, text: string, parseMode?: 'HTML', intentId = `telegram:${crypto.randomUUID()}`, operation?: RuntimeDataOperations, target?: { chatId: string; audience?: 'binding' | 'requester'; reuseExisting?: boolean }): Promise<Record<string, unknown> | null> {
  const call = (name: string, input: Record<string, unknown>) => operation ? operation({ operation: name, input }) : sendRuntimeDataRequest(globalDataPath, { operation: name, input });
  const existing = await call('read_notification', { intentId }) as Record<string, unknown> | null;
  if (existing) {
    const messageHash = crypto.createHash('sha256').update(JSON.stringify({ parseMode: parseMode || '', text })).digest('hex');
    if (existing.messageHash !== messageHash && !target?.reuseExisting) throw new Error('notification_identity_conflict');
    return existing;
  }
  const config = await refreshTelegramRuntimeConfig(globalDataPath, operation);
  const chatId = target?.chatId || config.chatId;
  if (!config.enabled || !chatId) return null;
  return call('enqueue_notification', {
    channel: 'telegram', intentId, payload: { replyGeneration: config.replyGeneration, chatId, text, ...(parseMode ? { parseMode } : {}), ...(target?.audience === 'requester' ? { audience: 'requester' } : {}) }, idempotencyKey: `enqueue:${intentId}`
  }) as Promise<Record<string, unknown>>;
}
