import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';

export type CapabilityKind = 'skill' | 'mcp' | 'enhancement';
export interface CapabilitySnapshot {
  kind: CapabilityKind;
  sourceSequence: number;
  readEpoch?: string;
  legacySkillsPending?: true;
  entries: Array<{ objectId: string; revision: number; entry: Record<string, any> }>;
}
export interface CapabilityRegistryVersion {
  entryVersions?: Record<string, number>;
}
const snapshots = new Map<string, CapabilitySnapshot>();
const reads = new Map<string, { issued: number; committed: number }>();
const key = (root: string, kind: CapabilityKind) => JSON.stringify([root, kind]);

function canonicalMetadata(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalMetadata).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => JSON.stringify(name) + ':' + canonicalMetadata(item)).join(',') + '}';
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('invalid_data: undefined is not a persisted value');
  return encoded;
}

export function capabilityVersion(root: string, kind: CapabilityKind): string {
  const current = snapshots.get(key(root, kind));
  return JSON.stringify([current?.readEpoch || '', current?.sourceSequence || 0]);
}

export function capabilitySnapshot(root: string, kind: CapabilityKind): CapabilitySnapshot {
  const current = snapshots.get(key(root, kind));
  return current ? structuredClone(current) : { kind, sourceSequence: 0, entries: [] };
}

export async function refreshCapabilityRegistry(root: string, kind: CapabilityKind): Promise<CapabilitySnapshot> {
  const cacheKey = key(root, kind), previous = snapshots.get(cacheKey);
  const ordering = reads.get(cacheKey) || { issued: 0, committed: 0 };
  reads.set(cacheKey, ordering);
  const ticket = ++ordering.issued;
  const result = await sendRuntimeDataRequest<CapabilitySnapshot | { kind: CapabilityKind; sourceSequence: number; readEpoch: string; unchanged: true }>(root, {
    operation: 'read_capability_registry', input: { kind, ...(previous ? { knownSequence: previous.sourceSequence, knownEpoch: previous.readEpoch } : {}) }
  });
  if (ticket > ordering.committed) {
    const current = snapshots.get(cacheKey);
    if (!('unchanged' in result) && (!current || current.readEpoch !== result.readEpoch || current.sourceSequence <= result.sourceSequence)) snapshots.set(cacheKey, result);
    ordering.committed = ticket;
  }
  return capabilitySnapshot(root, kind);
}

export async function writeCapabilityEntries(root: string, kind: CapabilityKind, entries: Array<{ id: string }>, versions?: Record<string, number>, installationFiles?: Record<string, Record<string, string>>): Promise<void> {
  const current = await refreshCapabilityRegistry(root, kind);
  for (const entry of entries) {
    const old = current.entries.find(item => item.entry.id === entry.id);
    if (old && canonicalMetadata(old.entry) === canonicalMetadata(entry) && !installationFiles?.[entry.id]) continue;
    const attachments = installationFiles?.[entry.id] ? captureInstallationFiles(root, installationFiles[entry.id]) : undefined;
    const receipt = attachments?.find(item => item.purpose === 'result');
    if (attachments && !receipt) throw new Error('capability_installation_receipt_required');
    const installationReceiptId = receipt ? crypto.createHash('sha256').update(canonicalMetadata([
      path.relative(root, installationFiles![entry.id].result), receipt.bytes
    ])).digest('hex') : undefined;
    await sendRuntimeDataRequest(root, { operation: 'patch_capability_registry', input: {
      kind, entry, expectedRevision: versions?.[entry.id] ?? (old ? -1 : 0),
      idempotencyKey: installationReceiptId ? `capability:install:${kind}:${installationReceiptId}` : `capability:${kind}:${crypto.randomUUID()}`,
      ...(attachments ? { attachments, installationReceiptId } : {})
    } });
  }
  // A missing entry expresses removal only when the caller supplies the exact
  // version it read. New entries from another window are never removed implicitly.
  if (versions) for (const old of current.entries) {
    const id = String(old.entry.id);
    if (versions[id] === undefined || entries.some(entry => entry.id === id) || old.entry.status === 'uninstalled') continue;
    await sendRuntimeDataRequest(root, { operation: 'patch_capability_registry', input: {
      kind, entry: { ...old.entry, status: 'uninstalled', enabled: false }, expectedRevision: versions[id],
      idempotencyKey: `capability:remove:${kind}:${crypto.randomUUID()}`
    } });
  }
  await refreshCapabilityRegistry(root, kind);
}

export function captureInstallationFiles(root: string, files: Record<string, string>): Array<{ purpose: string; bytes: string; mimeType: string }> {
  const physicalRoot = fs.realpathSync(root);
  return Object.entries(files).map(([purpose, file]) => {
    const physical = fs.realpathSync(file);
    const relative = path.relative(physicalRoot, physical);
    const before = fs.lstatSync(file);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || !before.isFile() || before.isSymbolicLink()) throw new Error('capability_attachment_path_invalid');
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const sameFile = (actual: fs.Stats): boolean => actual.isFile() && before.dev === actual.dev && before.ino === actual.ino && before.size === actual.size && before.mtimeMs === actual.mtimeMs && before.ctimeMs === actual.ctimeMs;
      if (!sameFile(fs.fstatSync(descriptor)) || fs.realpathSync(file) !== physical) throw new Error('capability_attachment_changed');
      const bytes = fs.readFileSync(descriptor);
      if (!sameFile(fs.fstatSync(descriptor)) || !sameFile(fs.lstatSync(file)) || fs.realpathSync(file) !== physical) throw new Error('capability_attachment_changed');
      return { purpose, bytes: bytes.toString('base64'), mimeType: 'application/octet-stream' };
    } finally { fs.closeSync(descriptor); }
  });
}
