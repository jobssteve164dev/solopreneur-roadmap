import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { canonicalExternalJson, parseExternalMemoryEntry } from './externalMemory';

export interface ExternalMemoryTargetResult {
  target: string;
  authorized: boolean;
  entries: Array<{ file: string; entryId: string; source: string; objectId: string; revision: number }>;
}

function hostActionKey(kind: 'reconcile' | 'revoke', operationId: string, body: Record<string, unknown>): string {
  return `external-memory-${kind}:${operationId}:${crypto.createHash('sha256').update(canonicalExternalJson(body)).digest('hex')}`;
}

export async function disconnectExternalMemoryTarget(input: {
  projectId: string;
  target: string;
  operationId?: string;
  revoke: (input: Record<string, unknown>) => Promise<{ revoked: number; total: number }>;
}): Promise<{ revoked: number; total: number }> {
  const operationId = input.operationId || crypto.randomUUID();
  return input.revoke({
    projectId: input.projectId,
    target: input.target,
    idempotencyKey: hostActionKey('revoke', operationId, { projectId: input.projectId, target: input.target })
  });
}

async function readStableJson(filePath: string): Promise<Record<string, unknown>> {
  const before = await fs.promises.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`external_memory_target_non_file:${path.basename(filePath)}`);
  const bytes = await fs.promises.readFile(filePath);
  const after = await fs.promises.lstat(filePath);
  if (!after.isFile() || after.isSymbolicLink() || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error(`external_memory_target_changed:${path.basename(filePath)}`);
  const value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('external_memory_target_json_invalid');
  return value as Record<string, unknown>;
}

/** Called only after an explicit host UI action. Agent MCP sessions cannot invoke the underlying operation. */
export async function syncExternalMemoryTarget(input: {
  projectId: string;
  targetRoot: string;
  authorized: boolean;
  sync: (input: Record<string, unknown>) => Promise<{ objectId: string; revision: number }>;
  reconcile?: (input: Record<string, unknown>) => Promise<unknown>;
}): Promise<ExternalMemoryTargetResult> {
  const operationId = crypto.randomUUID();
  const root = await fs.promises.realpath(path.resolve(input.targetRoot));
  const rootStat = await fs.promises.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('external_memory_target_root_invalid');
  const contract = await readStableJson(path.join(root, 'contract.json'));
  const targetKind = contract.target || contract.adapter || contract.kind;
  if (contract.schemaVersion !== 1 || targetKind !== 'solomap' || !['json', 'solomap-json'].includes(String(contract.format || ''))) throw new Error('external_memory_target_contract_invalid');
  const target = String(contract.targetId || contract.id || contract.identity || '');
  if (!/^[A-Za-z0-9._-]+$/.test(target)) throw new Error('external_memory_target_identity_invalid');
  const entriesRoot = path.join(root, 'entries');
  const entriesStat = await fs.promises.lstat(entriesRoot);
  if (!entriesStat.isDirectory() || entriesStat.isSymbolicLink()) throw new Error('external_memory_entries_invalid');
  const directoryEntries = await fs.promises.readdir(entriesRoot, { withFileTypes: true });
  if (directoryEntries.some(entry => entry.isSymbolicLink())) throw new Error('external_memory_entry_symlink_denied');
  const names = directoryEntries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name).sort();
  const entries: ExternalMemoryTargetResult['entries'] = [];
  for (const name of names) {
    const raw = await readStableJson(path.join(entriesRoot, name));
    const parsed = parseExternalMemoryEntry(raw);
    if (/[\\/\u0000]/.test(parsed.entryId)) throw new Error(`external_memory_entry_identity_invalid:${name}`);
    const source = parsed.scope === 'global'
      ? `cloudmcp:global:${target}:${parsed.entryId}`
      : `cloudmcp:project:${input.projectId}:${target}:${parsed.entryId}`;
    const idempotencyKey = `external-memory:${crypto.createHash('sha256').update(canonicalExternalJson({ source, authorized: input.authorized, revision: parsed.revision, canonicalHash: parsed.canonicalHash })).digest('hex')}`;
    const receipt = await input.sync({ projectId: input.projectId, source, entry: raw, authorized: input.authorized, idempotencyKey });
    entries.push({ file: name, entryId: parsed.entryId, source, objectId: receipt.objectId, revision: receipt.revision });
  }
  const sources = entries.map(entry => entry.source);
  await input.reconcile?.({
    projectId: input.projectId,
    target,
    sources,
    idempotencyKey: hostActionKey('reconcile', operationId, { projectId: input.projectId, target, authorized: input.authorized, sources })
  });
  return { target, authorized: input.authorized, entries };
}
