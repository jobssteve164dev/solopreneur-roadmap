import * as crypto from 'crypto';
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
const DIAGNOSTIC_WINDOW_DAYS = 14;
const PROCESS_DIAGNOSTIC_ID = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

type DiagnosticStageStatus = 'start' | 'ok' | 'error' | 'cancel';
interface DiagnosticOperationEvent {
  at: string;
  traceId: string;
  stage: string;
  status: DiagnosticStageStatus;
  durationMs: number;
  message?: string;
}
export interface LocalDiagnosticTrace {
  id: string;
  record(stage: string, status: DiagnosticStageStatus, durationMs?: number, error?: unknown): void;
}
const activeTrace = new AsyncLocalStorage<LocalDiagnosticTrace>();

function diagnosticDirectory(globalDataPath: string, date = new Date()): string {
  return path.join(normalizeGlobalDataPathForExtension(globalDataPath), 'diagnostics', date.toISOString().slice(0, 10));
}

function getDiagnosticsPath(globalDataPath: string): string {
  return path.join(diagnosticDirectory(globalDataPath), `recent-errors.${PROCESS_DIAGNOSTIC_ID}.json`);
}

function getOperationEventsPath(globalDataPath: string): string {
  return path.join(diagnosticDirectory(globalDataPath), `recent-operations.${PROCESS_DIAGNOSTIC_ID}.json`);
}

function diagnosticFiles(globalDataPath: string, kind: 'errors' | 'operations'): string[] {
  const root = path.join(normalizeGlobalDataPathForExtension(globalDataPath), 'diagnostics');
  const files: Array<{ path: string; modifiedAt: number }> = [];
  const directories = Array.from({ length: DIAGNOSTIC_WINDOW_DAYS }, (_, daysAgo) =>
    diagnosticDirectory(globalDataPath, new Date(Date.now() - daysAgo * 86_400_000)));
  for (const directory of directories) {
    try {
      for (const name of fs.readdirSync(directory)) {
        if (!new RegExp(`^recent-${kind}\\.\\d+-[a-f0-9]{8}\\.json$`).test(name)) continue;
        const filePath = path.join(directory, name);
        try { files.push({ path: filePath, modifiedAt: fs.statSync(filePath).mtimeMs }); } catch { /* File may have moved during a read. */ }
      }
    } catch { /* A day with no diagnostics has no directory. */ }
  }
  const legacyPath = path.join(root, `recent-${kind}.json`);
  try { files.push({ path: legacyPath, modifiedAt: fs.statSync(legacyPath).mtimeMs }); } catch { /* No legacy file. */ }
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt).map(file => file.path);
}

export function sanitizeDiagnosticText(value: unknown): string {
  const home = os.homedir();
  const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(value instanceof Error ? value.message : value || 'Unknown error')
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
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase();
  if (/^(?:missing_state|different_process|not_running|stale_heartbeat|process_exited|control_unavailable|different_runtime|control_not_running)$/.test(message)) return message;
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
  return diagnosticFiles(globalDataPath, 'operations')
    .slice(0, 50)
    .flatMap(readOperationEvents)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(-MAX_OPERATION_EVENTS);
}

export function createLocalDiagnosticTrace(globalDataPath: string, source: string): LocalDiagnosticTrace {
  const filePath = getOperationEventsPath(globalDataPath);
  const id = crypto.randomBytes(8).toString('hex');
  let writeFailureReported = false;
  const trace: LocalDiagnosticTrace = {
    id,
    record(stage, status, durationMs = 0, error) {
      try {
        const normalizedStage = String(stage || 'unknown').replace(/[^a-z0-9._-]/gi, '_').slice(0, 80);
        const entry: DiagnosticOperationEvent = {
          at: new Date().toISOString(),
          traceId: id,
          stage: normalizedStage,
          status,
          durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
          ...(error === undefined ? {} : { message: diagnosticStageMessage(normalizedStage, error) })
        };
        const entries = [...readOperationEvents(filePath), entry].slice(-MAX_OPERATION_EVENTS);
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        const temporary = `${filePath}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, entries }, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.chmodSync(temporary, 0o600);
        fs.renameSync(temporary, filePath);
      } catch (error) {
        if (!writeFailureReported) console.warn('SoloMap operation diagnostics could not be saved:', sanitizeDiagnosticText(error));
        writeFailureReported = true;
      }
    }
  };
  trace.record(source, 'start');
  return trace;
}

export function withLocalDiagnosticTrace<T>(trace: LocalDiagnosticTrace, operation: () => T): T {
  return activeTrace.run(trace, operation);
}

export function getCurrentLocalDiagnosticTrace(): LocalDiagnosticTrace | undefined {
  return activeTrace.getStore();
}

export function recordCurrentDiagnosticStage(stage: string, status: DiagnosticStageStatus, durationMs = 0, error?: unknown): void {
  activeTrace.getStore()?.record(stage, status, durationMs, error);
}

export async function observeLocalDiagnosticStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  const started = Date.now();
  recordCurrentDiagnosticStage(stage, 'start');
  try {
    const result = await operation();
    recordCurrentDiagnosticStage(stage, 'ok', Date.now() - started);
    return result;
  } catch (error) {
    recordCurrentDiagnosticStage(stage, 'error', Date.now() - started, error);
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
  return diagnosticFiles(globalDataPath, 'errors')
    .slice(0, 50)
    .flatMap(filePath => readStore(filePath).entries)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(-MAX_ENTRIES);
}

export function recordLocalDiagnosticError(globalDataPath: string, scope: string, error: unknown): void {
  try {
    const filePath = getDiagnosticsPath(globalDataPath);
    const store = readStore(filePath);
    const message = sanitizeDiagnosticText(error);
    const normalizedScope = String(scope || 'unknown').replace(/[^a-z0-9._-]/gi, '_').slice(0, 80);
    const fingerprint = crypto.createHash('sha256').update(`${normalizedScope}\n${message}`).digest('hex').slice(0, 12);
    store.entries.push({ at: new Date().toISOString(), scope: normalizedScope, fingerprint, message });
    store.entries = store.entries.slice(-MAX_ENTRIES);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    console.warn('SoloMap error diagnostics could not be saved:', sanitizeDiagnosticText(error));
  }
}

export function buildLocalDiagnosticSummary(
  context: vscode.ExtensionContext,
  globalDataPath: string,
  host: { appName?: string; version?: string; remoteName?: string; uiKind?: number; uriScheme?: string }
): string {
  const entries = readRecentErrors(globalDataPath).slice(-10);
  const operationEvents = readRecentOperationEvents(globalDataPath).slice(-20);
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
      ? operationEvents.map((event) => `- ${event.at} [${event.traceId}] ${event.stage} ${event.status} ${event.durationMs}ms${event.message ? `: ${event.message}` : ''}`)
      : ['- None recorded.']),
    '',
    'Diagnostic privacy:',
    '- Operation events contain stages, timings, and classified errors only. Recent error messages redact paths and credential patterns; review before sharing.'
  ].join('\n');
}
