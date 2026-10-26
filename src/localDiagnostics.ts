import * as crypto from 'crypto';
import { performance } from 'node:perf_hooks';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import type * as vscode from 'vscode';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';

interface DiagnosticEntry { at: string; scope: string; fingerprint: string; message: string }
interface DiagnosticStore { schemaVersion: number; entries: DiagnosticEntry[] }
const MAX_ENTRIES = 50;
const MAX_OPERATION_EVENTS = 200;
const PROCESS_DIAGNOSTIC_ID = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

type DiagnosticStageStatus = 'start' | 'ok' | 'error' | 'cancel';
interface DiagnosticOperationEvent extends DiagnosticProcessDetails {
  at: string;
  traceId: string;
  stage: string;
  status: DiagnosticStageStatus;
  durationMs: number;
  message?: string;
  elapsedMs?: number;
  interactionId?: string;
  targetId?: string;
  generation?: number;
  budgetExceeded?: boolean;
}
interface DiagnosticInteraction { interactionId?: string; targetId?: string; generation?: number; budgetMs?: number }
interface DiagnosticProcessDetails {
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  stdoutBytes?: number;
  stderrBytes?: number;
  timeoutMs?: number;
  budgetMs?: number;
  projectId?: string;
  terminalId?: string;
  activeTerminalId?: string;
  focusRequested?: boolean;
  terminalProjectMatched?: boolean;
}
function safeProcessDetails(details: Record<string, unknown>): DiagnosticProcessDetails {
  const safeToken = (value: unknown) => typeof value === 'string' && /^[a-z0-9_.:-]{1,80}$/i.test(value) ? value : undefined;
  return {
    ...Object.fromEntries(Object.entries(details).filter(([key, value]) => ['pid', 'exitCode', 'stdoutBytes', 'stderrBytes', 'timeoutMs', 'budgetMs'].includes(key) && (value === null || Number.isSafeInteger(value)))),
    ...(typeof details.signal === 'string' && /^SIG[A-Z0-9]+$/.test(details.signal) ? { signal: details.signal } : {}),
    ...(safeToken(details.projectId) ? { projectId: safeToken(details.projectId) } : {}),
    ...(safeToken(details.terminalId) ? { terminalId: safeToken(details.terminalId) } : {}),
    ...(safeToken(details.activeTerminalId) ? { activeTerminalId: safeToken(details.activeTerminalId) } : {}),
    ...(typeof details.focusRequested === 'boolean' ? { focusRequested: details.focusRequested } : {}),
    ...(typeof details.terminalProjectMatched === 'boolean' ? { terminalProjectMatched: details.terminalProjectMatched } : {})
  };
}
export interface LocalDiagnosticEvent {
  kind: 'error' | 'operation';
  occurredAt: string;
  scope: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}
interface LocalDiagnosticPersistence {
  append(globalDataPath: string, event: LocalDiagnosticEvent): void | Promise<void>;
  read?(globalDataPath: string): Promise<{ items: Record<string, unknown>[] }>;
}
export interface LocalDiagnosticTrace {
  id: string;
  interactionId?: string;
  record(stage: string, status: DiagnosticStageStatus, durationMs?: number, error?: unknown, processDetails?: DiagnosticProcessDetails): void;
}
const activeTrace = new AsyncLocalStorage<LocalDiagnosticTrace>();
let persistence: LocalDiagnosticPersistence | undefined;
const currentErrors = new Map<string, DiagnosticEntry[]>();
const currentOperations = new Map<string, DiagnosticOperationEvent[]>();
const databaseErrors = new Map<string, DiagnosticEntry[]>();
const databaseOperations = new Map<string, DiagnosticOperationEvent[]>();
const loadingRoots = new Map<string, Promise<void>>();
const persistenceByTrace = new WeakMap<LocalDiagnosticTrace, LocalDiagnosticPersistence | null>();

function diagnosticRoot(globalDataPath: string): string {
  return normalizeGlobalDataPathForExtension(globalDataPath);
}

function remember<T>(map: Map<string, T[]>, globalDataPath: string, value: T, limit: number): void {
  const root = diagnosticRoot(globalDataPath);
  map.set(root, [...(map.get(root) || []), value].slice(-limit));
}

function loadDatabaseDiagnostics(globalDataPath: string): Promise<void> {
  const root = diagnosticRoot(globalDataPath);
  if (!persistence?.read) return Promise.resolve();
  const active = loadingRoots.get(root);
  if (active) return active;
  const loading = persistence.read(root).then(result => {
    const errors: DiagnosticEntry[] = [];
    const operations: DiagnosticOperationEvent[] = [];
    for (const item of result.items || []) {
      const payload = item.payload && typeof item.payload === 'object' ? item.payload as Record<string, unknown> : {};
      if (item.kind === 'error') errors.push({
        at: String(item.occurredAt || ''), scope: String(item.scope || ''),
        fingerprint: String(payload.fingerprint || ''), message: String(payload.message || '')
      });
      if (item.kind === 'operation') operations.push({
        at: String(item.occurredAt || ''), traceId: String(payload.traceId || ''),
        stage: String(item.scope || ''), status: String(payload.status || 'error') as DiagnosticStageStatus,
        durationMs: Number(payload.durationMs || 0), ...(payload.message ? { message: String(payload.message) } : {}),
        ...(typeof payload.elapsedMs === 'number' ? { elapsedMs: payload.elapsedMs } : {}),
        ...(typeof payload.interactionId === 'string' && /^[a-z0-9_.:-]{1,80}$/i.test(payload.interactionId) ? { interactionId: payload.interactionId } : {}),
        ...(typeof payload.targetId === 'string' && /^[a-z0-9_.:-]{1,80}$/i.test(payload.targetId) ? { targetId: payload.targetId } : {}),
        ...(Number.isSafeInteger(payload.generation) ? { generation: Number(payload.generation) } : {}),
        ...(typeof payload.budgetExceeded === 'boolean' ? { budgetExceeded: payload.budgetExceeded } : {}),
        ...safeProcessDetails(payload)
      });
    }
    databaseErrors.set(root, errors.slice(-MAX_ENTRIES));
    databaseOperations.set(root, operations.slice(-MAX_OPERATION_EVENTS));
  }).catch(error => console.warn('SoloMap diagnostics could not be loaded:', sanitizeDiagnosticText(error)))
    .finally(() => loadingRoots.delete(root));
  loadingRoots.set(root, loading);
  return loading;
}

export function configureLocalDiagnosticPersistence(value: LocalDiagnosticPersistence | undefined, globalDataPath?: string): void {
  persistence = value;
  if (globalDataPath) void loadDatabaseDiagnostics(globalDataPath);
}

function appendDiagnostic(globalDataPath: string, event: LocalDiagnosticEvent, target?: LocalDiagnosticPersistence | null): void {
  const resolvedTarget = target === null ? undefined : target || persistence;
  if (!resolvedTarget) return;
  try {
    void Promise.resolve(resolvedTarget.append(diagnosticRoot(globalDataPath), event))
      .catch(error => console.warn('SoloMap diagnostics could not be saved:', sanitizeDiagnosticText(error)));
  } catch (error) {
    console.warn('SoloMap diagnostics could not be saved:', sanitizeDiagnosticText(error));
  }
}

function diagnosticDirectory(globalDataPath: string, date = new Date()): string {
  return path.join(normalizeGlobalDataPathForExtension(globalDataPath), 'diagnostics', date.toISOString().slice(0, 10));
}

function diagnosticFiles(globalDataPath: string, kind: 'errors' | 'operations'): string[] {
  const root = path.join(normalizeGlobalDataPathForExtension(globalDataPath), 'diagnostics');
  const files: Array<{ path: string; modifiedAt: number }> = [];
  const directories = [root];
  try {
    directories.push(...fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map(entry => path.join(root, entry.name)));
  } catch { /* No diagnostic directory has been created. */ }
  for (const directory of directories) {
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const name = entry.name;
        const filePath = path.join(directory, name);
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        if (!new RegExp(`^recent-${kind}\\.\\d+-[a-f0-9]{8}\\.json$`).test(name)) continue;
        try { files.push({ path: filePath, modifiedAt: fs.statSync(filePath).mtimeMs }); } catch { /* File may have moved during a read. */ }
      }
    } catch { /* A historical diagnostic directory may disappear during startup. */ }
  }
  const legacyPath = path.join(root, `recent-${kind}.json`);
  try { files.push({ path: legacyPath, modifiedAt: fs.statSync(legacyPath).mtimeMs }); } catch { /* No legacy file. */ }
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt).map(file => file.path);
}

export function sanitizeDiagnosticText(value: unknown): string {
  const home = os.homedir();
  const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const message = value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string'
    ? (value as { message: string }).message : value;
  return String(message || 'Unknown error')
    .replace(/\/bot\d{5,}:[A-Za-z0-9_-]{10,}\/[A-Za-z]+/gi, '<telegram-endpoint>')
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{10,}\b/g, '<redacted>')
    .replace(escapedHome ? new RegExp(escapedHome, 'g') : /$^/, '<home>')
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s:'"<>|]+[\\/])+[^\s:'"<>|]*/g, '<path>')
    .replace(/([?&](?:token|key|secret|code|signature)=)[^&\s]+/gi, '$1<redacted>')
    .replace(/\b((?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*|(?:api_key|access_token|client_secret|password))=)[^\s,;]+/gi, '$1<redacted>')
    .replace(/\b(?:gho|ghp|github_pat|sk)-[A-Za-z0-9_-]+\b/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

export function classifyDiagnosticFailure(error: unknown): string {
  const errorMessage = error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message : error;
  const message = String(errorMessage || '').toLowerCase();
  if (/^(?:missing_state|different_process|not_running|stale_heartbeat|process_exited|control_unavailable|different_runtime|different_runtime_build|different_runtime_owner|control_not_running|runtime_drain_timeout|runtime_service_rollback|runtime_service_upgrade_failed|runtime_service_cleanup_failed|terminal_process_slow|terminal_process_timeout|terminal_process_unavailable|runner_claim_timeout)$/.test(message)) return message;
  if (/failed to connect to (?:user scope )?bus|user bus.*(?:unavailable|not found)/.test(message)) return 'user_systemd_bus_unavailable';
  const httpStatus = message.match(/telegram[^\n]*?http\s*(\d{3})/);
  if (httpStatus) return `telegram_http_${httpStatus[1]}`;
  if (/auth(?:entication|orization)? (?:failed|error|denied|expired)|unauthorized|invalid api key|invalid credentials/.test(message)) return 'authentication_failed';
  if (/quota|insufficient credits|billing limit/.test(message)) return 'quota_exceeded';
  if (/rate limit|too many requests/.test(message)) return 'rate_limited';
  if (/model (?:not found|unavailable|does not exist|unsupported)/.test(message)) return 'model_unavailable';
  if (/permission denied|access denied/.test(message)) return 'permission_denied';
  if (/not found|enoent/.test(message)) return 'not_found';
  if (/timed out|timeout/.test(message)) return 'timeout';
  if (/cancelled|canceled|aborted/.test(message)) return 'cancelled';
  const exit = message.match(/(?:failed|exited) \((\d+)\)/);
  if (exit) return `process_exit_${exit[1]}`;
  if (/transport|mcp.*connect/.test(message)) return 'mcp_transport_error';
  if (/intelligence read tool failed/.test(message)) return 'mcp_tool_error';
  if (/invalid read tool request/.test(message)) return 'invalid_tool_request';
  if (/unknown read tool/.test(message)) return 'unknown_tool';
  if (/tool call limit/.test(message)) return 'tool_limit';
  if (/did not return an answer/.test(message)) return 'empty_answer';
  if (/valid json|invalid.*judgment/.test(message)) return 'invalid_model_output';
  return 'unknown_error';
}

function diagnosticStageMessage(_stage: string, error: unknown): string {
  return classifyDiagnosticFailure(error);
}

function readOperationEvents(filePath: string): DiagnosticOperationEvent[] {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(raw?.entries) ? raw.entries.slice(-MAX_OPERATION_EVENTS) : [];
  } catch {
    return [];
  }
}

function readRecentOperationEvents(globalDataPath: string): DiagnosticOperationEvent[] {
  const root = diagnosticRoot(globalDataPath);
  return [...(databaseOperations.get(root) || []), ...(currentOperations.get(root) || [])]
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(-MAX_OPERATION_EVENTS);
}

export function createLocalDiagnosticTrace(globalDataPath: string, source: string, interaction: DiagnosticInteraction = {}): LocalDiagnosticTrace {
  const id = crypto.randomBytes(8).toString('hex');
  const started = performance.now();
  // `null` is an explicit no-sink binding. Passing `undefined` here would let
  // appendDiagnostic fall through to a persistence configured by a later task.
  const tracePersistence = persistence || null;
  let sequence = 0;
  const token = (value: string | undefined) => value && /^[a-z0-9_.:-]{1,80}$/i.test(value) ? value : undefined;
  const metadata = {
    interactionId: token(interaction.interactionId) || id,
    ...(token(interaction.targetId) ? { targetId: token(interaction.targetId) } : {}),
    ...(Number.isSafeInteger(interaction.generation) ? { generation: interaction.generation } : {})
  };
  const trace: LocalDiagnosticTrace = {
    id,
    interactionId: metadata.interactionId,
    record(stage, status, durationMs = 0, error, processDetails = {}) {
      const normalizedStage = String(stage || 'unknown').replace(/[^a-z0-9._-]/gi, '_').slice(0, 80);
      const elapsedMs = Math.max(0, Math.round(performance.now() - started));
      const details = safeProcessDetails({ ...processDetails });
      const entry: DiagnosticOperationEvent = {
        at: new Date().toISOString(), traceId: id, stage: normalizedStage, status,
        ...metadata, elapsedMs, ...details,
        ...(interaction.budgetMs !== undefined ? { budgetExceeded: elapsedMs > interaction.budgetMs } : {}),
        durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
        ...(error === undefined ? {} : { message: diagnosticStageMessage(normalizedStage, error) })
      };
      remember(currentOperations, globalDataPath, entry, MAX_OPERATION_EVENTS);
      appendDiagnostic(globalDataPath, {
        kind: 'operation', occurredAt: entry.at, scope: normalizedStage,
        payload: { traceId: id, ...metadata, elapsedMs, ...(entry.budgetExceeded !== undefined ? { budgetExceeded: entry.budgetExceeded } : {}), status, durationMs: entry.durationMs, ...(entry.message ? { message: entry.message } : {}),
          ...details },
        idempotencyKey: `diagnostic-operation:${PROCESS_DIAGNOSTIC_ID}:${id}:${++sequence}`
      }, tracePersistence);
    }
  };
  persistenceByTrace.set(trace, tracePersistence);
  trace.record(source, 'start');
  return trace;
}

export function withLocalDiagnosticTrace<T>(trace: LocalDiagnosticTrace, operation: () => T): T {
  return activeTrace.run(trace, operation);
}

export function getCurrentLocalDiagnosticTrace(): LocalDiagnosticTrace | undefined {
  return activeTrace.getStore();
}

export function recordCurrentDiagnosticStage(stage: string, status: DiagnosticStageStatus, durationMs = 0, error?: unknown, details?: DiagnosticProcessDetails): void {
  activeTrace.getStore()?.record(stage, status, durationMs, error, details);
}

export async function observeLocalDiagnosticStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  const started = performance.now();
  recordCurrentDiagnosticStage(stage, 'start');
  try {
    const result = await operation();
    recordCurrentDiagnosticStage(stage, 'ok', performance.now() - started);
    return result;
  } catch (error) {
    recordCurrentDiagnosticStage(stage, 'error', performance.now() - started, error);
    throw error;
  }
}

function readStore(filePath: string): DiagnosticStore {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { schemaVersion: 1, entries: Array.isArray(raw?.entries) ? raw.entries.slice(-MAX_ENTRIES) : [] };
  } catch {
    return { schemaVersion: 1, entries: [] };
  }
}

function readRecentErrors(globalDataPath: string): DiagnosticEntry[] {
  const root = diagnosticRoot(globalDataPath);
  return [...(databaseErrors.get(root) || []), ...(currentErrors.get(root) || [])]
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(-MAX_ENTRIES);
}

export async function importLegacyLocalDiagnostics(
  globalDataPath: string,
  append: (event: LocalDiagnosticEvent) => void | Promise<void>,
  capture: (source: { identity: string; key: string; hash: string }, bytes: Buffer) => { unchanged?: boolean; stage?: string } | void,
  settle?: (source: { identity: string; key: string; hash: string }, result: 'imported' | 'conflict', error?: string) => void
): Promise<{ files: number; events: number }> {
  const root = diagnosticRoot(globalDataPath);
  const files = [...new Set([...diagnosticFiles(root, 'errors'), ...diagnosticFiles(root, 'operations')])];
  let events = 0;
  for (const filePath of files) {
    let source: { identity: string; key: string; hash: string } | undefined;
    try {
      const bytes = fs.readFileSync(filePath);
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      const key = path.relative(root, filePath).split(path.sep).join('/');
      source = { identity: `local-diagnostics:${root}`, key, hash };
      const captured = capture(source, bytes);
      if (captured?.unchanged && captured.stage === 'imported') continue;
      const parsed = JSON.parse(bytes.toString('utf8')) as { entries?: unknown };
      if (!Array.isArray(parsed?.entries)) throw new Error('legacy_diagnostic_entries_invalid');
      const pending: LocalDiagnosticEvent[] = [];
      if (/recent-errors/.test(path.basename(filePath))) for (const [index, raw] of parsed.entries.entries()) {
        const entry = raw as DiagnosticEntry;
        if (!entry?.at || !entry.scope || !entry.fingerprint || typeof entry.message !== 'string') throw new Error('legacy_diagnostic_error_invalid');
        pending.push({ kind: 'error', occurredAt: entry.at, scope: entry.scope,
          payload: { fingerprint: entry.fingerprint, message: entry.message },
          idempotencyKey: `legacy-diagnostic:${hash}:error:${index}` });
      }
      if (/recent-operations/.test(path.basename(filePath))) for (const [index, raw] of parsed.entries.entries()) {
        const entry = raw as DiagnosticOperationEvent;
        if (!entry?.at || !entry.traceId || !entry.stage || !['start', 'ok', 'error', 'cancel'].includes(entry.status)) throw new Error('legacy_diagnostic_operation_invalid');
        pending.push({ kind: 'operation', occurredAt: entry.at, scope: entry.stage,
          payload: { traceId: entry.traceId, status: entry.status, durationMs: Math.max(0, Number(entry.durationMs || 0)), ...(entry.message ? { message: entry.message } : {}) },
          idempotencyKey: `legacy-diagnostic:${hash}:operation:${index}` });
      }
      for (const event of pending) await append(event);
      events += pending.length;
      settle?.(source, 'imported');
    } catch (error) {
      if (source) {
        try { settle?.(source, 'conflict', error instanceof Error ? error.message : String(error)); } catch { /* Legacy evidence cannot block the database runtime. */ }
      }
    }
  }
  return { files: files.length, events };
}

export function recordLocalDiagnosticError(globalDataPath: string, scope: string, error: unknown): void {
  const message = sanitizeDiagnosticText(error);
  const normalizedScope = String(scope || 'unknown').replace(/[^a-z0-9._-]/gi, '_').slice(0, 80);
  const fingerprint = crypto.createHash('sha256').update(`${normalizedScope}\n${message}`).digest('hex').slice(0, 12);
  const entry = { at: new Date().toISOString(), scope: normalizedScope, fingerprint, message };
  remember(currentErrors, globalDataPath, entry, MAX_ENTRIES);
  const trace = activeTrace.getStore();
  appendDiagnostic(globalDataPath, {
    kind: 'error', occurredAt: entry.at, scope: normalizedScope, payload: { fingerprint, message },
    idempotencyKey: `diagnostic-error:${PROCESS_DIAGNOSTIC_ID}:${entry.at}:${fingerprint}`
  }, trace ? persistenceByTrace.get(trace) : undefined);
}

export async function buildLocalDiagnosticSummary(
  context: vscode.ExtensionContext,
  globalDataPath: string,
  host: { appName?: string; version?: string; remoteName?: string; uiKind?: number; uriScheme?: string }
): Promise<string> {
  await loadDatabaseDiagnostics(globalDataPath);
  const entries = readRecentErrors(globalDataPath).slice(-10);
  const recentOperations = readRecentOperationEvents(globalDataPath);
  const recentTraces = new Set([...new Set(recentOperations.map(event => event.traceId))].slice(-4));
  const operationEvents = recentOperations.filter(event => recentTraces.has(event.traceId)).slice(-100);
  return [
    'Runtime environment:',
    `- Host: ${sanitizeDiagnosticText(host.appName || 'unknown')} ${sanitizeDiagnosticText(host.version || 'unknown')}`,
    `- Platform / architecture: ${process.platform} / ${process.arch}`,
    `- Remote: ${sanitizeDiagnosticText(host.remoteName || 'local')}`,
    `- UI kind / URI scheme: ${host.uiKind ?? 'unknown'} / ${sanitizeDiagnosticText(host.uriScheme || 'unknown')}`,
    `- Extension mode: ${String((context as any).extensionMode ?? 'unknown')}`,
    '',
    `Recent local errors: ${entries.length}`,
    ...(entries.length > 0
      ? entries.map((entry) => `- ${entry.at} [${entry.scope}] ${entry.fingerprint}: ${entry.message}`)
      : ['- None recorded.']),
    '',
    `Recent operation events: ${operationEvents.length}`,
    ...(operationEvents.length > 0
      ? operationEvents.map((event) => `- ${event.at} [${event.traceId}${event.interactionId ? ` interaction=${event.interactionId}` : ''}] ${event.stage} ${event.status} ${event.durationMs}ms${event.elapsedMs === undefined ? '' : ` elapsed=${event.elapsedMs}ms`}${event.targetId ? ` target=${event.targetId}` : ''}${event.generation === undefined ? '' : ` generation=${event.generation}`}${event.budgetExceeded ? ' budget_exceeded' : ''}${Object.entries(safeProcessDetails({ ...event })).map(([key, value]) => ` ${key === 'exitCode' ? 'exit' : key}=${value}`).join('')}${event.message ? `: ${event.message}` : ''}`)
      : ['- None recorded.']),
    '',
    'Diagnostic privacy:',
    '- Operation events contain stages, timings, and classified errors only. Recent error messages redact paths and credential patterns; review before sharing.'
  ].join('\n');
}
