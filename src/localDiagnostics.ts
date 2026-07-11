import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';

interface DiagnosticEntry { at: string; scope: string; fingerprint: string; message: string }
interface DiagnosticStore { schemaVersion: number; entries: DiagnosticEntry[] }
const MAX_ENTRIES = 50;

function getDiagnosticsPath(globalDataPath: string): string {
  return path.join(normalizeGlobalDataPathForExtension(globalDataPath), 'diagnostics', 'recent-errors.json');
}

function sanitizeDiagnosticText(value: unknown): string {
  const home = os.homedir();
  const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(value instanceof Error ? value.message : value || 'Unknown error')
    .replace(escapedHome ? new RegExp(escapedHome, 'g') : /$^/, '<home>')
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s:'"<>|]+[\\/])+[^\s:'"<>|]*/g, '<path>')
    .replace(/([?&](?:token|key|secret|code|signature)=)[^&\s]+/gi, '$1<redacted>')
    .replace(/\b(?:gho|ghp|github_pat|sk)-[A-Za-z0-9_-]+\b/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function readStore(filePath: string): DiagnosticStore {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { schemaVersion: 1, entries: Array.isArray(raw?.entries) ? raw.entries.slice(-MAX_ENTRIES) : [] };
  } catch {
    return { schemaVersion: 1, entries: [] };
  }
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
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch {
    // Diagnostics must never interrupt the user's action or recurse through logging.
  }
}

export function buildLocalDiagnosticSummary(
  context: vscode.ExtensionContext,
  globalDataPath: string,
  host: { appName?: string; version?: string; remoteName?: string; uiKind?: number; uriScheme?: string }
): string {
  const entries = readStore(getDiagnosticsPath(globalDataPath)).entries.slice(-10);
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
    'Diagnostic privacy:',
    '- Paths, home directories, credential-like query values, tokens, prompts, project names, and file contents are not included.'
  ].join('\n');
}
