import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { persistTelegramRuntimeSecret, telegramBotTokenSecretRef } from './telegramRuntimeConfig';

import { UnifiedDataStore } from './db/unifiedDataStore';

type JsonRecord = Record<string, unknown>;

function hash(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readRegularFile(file: string): Buffer | null {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const bytes = fs.readFileSync(file);
    const after = fs.lstatSync(file);
    if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('legacy_runtime_source_changed');
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function capture(
  store: UnifiedDataStore,
  root: string,
  file: string,
  sanitize?: (value: JsonRecord) => JsonRecord
): { identity: string; key: string; hash: string; bytes: Buffer; value: JsonRecord; rawValue: JsonRecord; unchanged: boolean } | null {
  const sourceBytes = readRegularFile(file);
  if (!sourceBytes) return null;
  const identity = `runtime-state:${root}`;
  const key = path.relative(root, file).split(path.sep).join('/');
  let rawValue: JsonRecord;
  let value: JsonRecord;
  let bytes: Buffer;
  try {
    const parsed = JSON.parse(sourceBytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('legacy_runtime_source_invalid');
    rawValue = parsed as JsonRecord;
    value = sanitize ? sanitize(rawValue) : rawValue;
    bytes = sanitize ? Buffer.from(JSON.stringify(value)) : sourceBytes;
  } catch (error) {
    bytes = sanitize
      ? Buffer.from(JSON.stringify({ redacted: true, sourceFingerprint: hash(sourceBytes) }))
      : sourceBytes;
    const sourceHash = hash(bytes);
    const existing = store.migrationSourceState(identity, key);
    if (existing?.hash !== sourceHash || existing.stage !== 'conflict') {
      store.captureMigrationSource({ identity, key, hash: sourceHash }, bytes, { mimeType: 'application/json', encoding: 'utf8', pending: true });
      store.markMigrationSourceConflict(identity, key, error instanceof Error ? error.message : String(error));
    }
    return null;
  }
  const sourceHash = hash(bytes);
  const existing = store.migrationSourceState(identity, key);
  const unchanged = existing?.hash === sourceHash && existing.stage === 'imported';
  if (!unchanged) store.captureMigrationSource({ identity, key, hash: sourceHash }, bytes, { mimeType: 'application/json', encoding: 'utf8', pending: true });
  return { identity, key, hash: sourceHash, bytes, value, rawValue, unchanged };
}

function recordUnavailableSource(store: UnifiedDataStore, root: string, file: string, error: unknown): void {
  const key = path.relative(root, file).split(path.sep).join('/');
  const message = error instanceof Error ? error.message : String(error);
  try {
    store.appendDiagnosticEvent({
      kind: 'error', occurredAt: new Date().toISOString(), scope: 'runtime.migration',
      payload: { source: key, error: message },
      idempotencyKey: `runtime-migration-source-unavailable:${key}:${crypto.createHash('sha256').update(message).digest('hex')}`
    });
  } catch {
    // A legacy source must never prevent the current database from starting.
  }
}

function captureAvailable(store: UnifiedDataStore, root: string, file: string, sanitize?: (value: JsonRecord) => JsonRecord): ReturnType<typeof capture> {
  try { return capture(store, root, file, sanitize); }
  catch (error) { recordUnavailableSource(store, root, file, error); return null; }
}

function importSettings(store: UnifiedDataStore, source: NonNullable<ReturnType<typeof capture>>, namespace: string, values: JsonRecord): void {
  if (source.unchanged) return;
  store.importLegacyHostSettings({ source, namespace, values });
}

export function importLegacyRuntimeState(store: UnifiedDataStore, globalDataPath: string): void {
  const root = path.resolve(globalDataPath);
  const runtime = path.join(root, 'runtime');
  const cognitive = captureAvailable(store, root, path.join(runtime, 'cognitive-config.json'));
  if (cognitive) importSettings(store, cognitive, 'cognitive', {
    mode: cognitive.value.mode === 'agent_cli' ? 'agent_cli' : 'local_only',
    agentCli: String(cognitive.value.agentCli || ''),
    model: String(cognitive.value.model || 'auto')
  });

  const sanitizeTelegram = (value: JsonRecord): JsonRecord => {
    const { botToken, ...safe } = value;
    return botToken
      ? { ...safe, botTokenSecretRef: telegramBotTokenSecretRef, botTokenFingerprint: hash(Buffer.from(String(botToken))) }
      : safe;
  };
  const telegram = captureAvailable(store, root, path.join(runtime, 'telegram-config.json'), sanitizeTelegram);
  const telegramState = captureAvailable(store, root, path.join(runtime, 'telegram-state.json'), sanitizeTelegram);
  const state = telegramState?.value || {};
  const legacyTelegramToken = String(telegram?.rawValue.botToken || '');
  const adoptsLegacyTelegramBinding = Boolean(telegram && !telegram.unchanged && legacyTelegramToken
    && store.readHostSettings({ namespace: 'telegram', ownerScope: 'global' }).items.length === 0);
  if (adoptsLegacyTelegramBinding) persistTelegramRuntimeSecret(root, telegramBotTokenSecretRef, legacyTelegramToken);
  const telegramValues = telegram ? {
      enabled: telegram.value.enabled === true,
      ...(legacyTelegramToken ? { botTokenSecretRef: telegramBotTokenSecretRef } : {}),
      ...(legacyTelegramToken ? { botTokenFingerprint: String(telegram.value.botTokenFingerprint || '') } : {}),
      chatId: String(telegram.value.chatId || ''),
      selectedProjectPath: String(telegram.value.selectedProjectPath || ''),
      language: telegram.value.language === 'en' ? 'en' : 'zh',
      bindingGeneration: Number(telegram.value.bindingGeneration || state.bindingGeneration || 0),
      replyGeneration: Number(telegram.value.replyGeneration ?? telegram.value.bindingGeneration ?? state.bindingGeneration ?? 0),
      conversationIds: telegram.value.conversationIds && typeof telegram.value.conversationIds === 'object' ? telegram.value.conversationIds : state.conversationIds && typeof state.conversationIds === 'object' ? state.conversationIds : {},
      offset: Number(state.offset || 0)
    } : {};
  store.importLegacyTelegramRuntimeState({
    ...(telegram ? { config: { identity: telegram.identity, key: telegram.key, hash: telegram.hash, value: telegramValues, pending: !telegram.unchanged } } : {}),
    ...(telegramState && !telegramState.unchanged ? { state: { identity: telegramState.identity, key: telegramState.key, hash: telegramState.hash, value: telegramState.value } } : {})
  });

  const scheduled = captureAvailable(store, root, path.join(runtime, 'scheduled-tasks', 'scheduled-tasks.json'));
  if (scheduled && !scheduled.unchanged) {
    const tasks = Array.isArray(scheduled.value.tasks) ? scheduled.value.tasks as JsonRecord[] : [];
    const failures = Array.isArray(scheduled.value.failures) ? scheduled.value.failures as JsonRecord[] : [];
    const records = [...tasks.map(value => ({ value, state: 'pending' as const })), ...failures.map(value => ({ value, state: 'failed' as const }))]
      .filter(item => item.value.task && typeof item.value.task === 'object' && item.value.occurrenceId && item.value.taskId && Number.isFinite(Date.parse(String(item.value.dueAt || ''))));
    store.importLegacySchedules({ source: scheduled,
      schedules: records.map(({ value }) => ({ id: String(value.taskId), timezone: 'UTC', trigger: { kind: (value.task as JsonRecord).scheduleKind === 'once' ? 'once' : 'daily', timeOfDay: String((value.task as JsonRecord).timeOfDay || ''), scheduledAt: String((value.task as JsonRecord).scheduledAt || '') }, enabled: (value.task as JsonRecord).enabled !== false, nextDueAt: Date.parse(String(value.dueAt)), task: value.task as JsonRecord })),
      records: records.map(({ value, state }) => ({ scheduleId: String(value.taskId), occurrenceKey: `${String(value.taskId)}@${Date.parse(String(value.dueAt))}`, dueAt: Date.parse(String(value.retryAt || value.dueAt)), attempts: Math.max(0, Number(value.attempts || 0)), state, task: value.task as JsonRecord })) });
  }

  for (const [name, key] of [['today-shadow.json', 'decision'], ['shadow-evaluation.json', 'evaluation']] as const) {
    const source = captureAvailable(store, root, path.join(runtime, name));
    if (source) importSettings(store, source, 'runtime_shadow', { [key]: source.value });
  }
  const feedbackFile = path.join(runtime, 'shadow-feedback.jsonl');
  try {
    const info = fs.lstatSync(feedbackFile);
    if (info.isFile() && !info.isSymbolicLink()) {
      const bytes = fs.readFileSync(feedbackFile), identity = `runtime-state:${root}`, key = 'runtime/shadow-feedback.jsonl', sourceHash = hash(bytes);
      const existing = store.migrationSourceState(identity, key);
      if (!(existing?.hash === sourceHash && existing.stage === 'imported')) {
        store.captureMigrationSource({ identity, key, hash: sourceHash }, bytes, { mimeType: 'application/x-ndjson', encoding: 'utf8', pending: true });
        try {
          const feedback = bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
          store.importLegacyHostSettings({ source: { identity, key, hash: sourceHash }, namespace: 'runtime_shadow', values: { feedback } });
        } catch (error) {
          store.markMigrationSourceConflict(identity, key, error instanceof Error ? error.message : String(error));
        }
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') recordUnavailableSource(store, root, feedbackFile, error); }

  const oldRuntime = captureAvailable(store, root, path.join(runtime, 'state.json'));
  if (oldRuntime && !oldRuntime.unchanged) store.markMigrationSourceImported(oldRuntime.identity, oldRuntime.key);
}
