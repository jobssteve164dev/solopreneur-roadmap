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
export interface CapabilityOperation {
  operationId: string; ordinal: number; kind: CapabilityKind;
  action: 'install' | 'upgrade' | 'enable' | 'disable' | 'uninstall';
  targetId: string | null; requestKey: string; status: 'pending' | 'running' | 'succeeded' | 'failed' | 'stale';
  resultPath: string | null; runId: string | null; expectedRevision: number;
  sourceIntent: Record<string, any>;
  resultIntegrationId: string | null; resultRevision: number | null; error: string; createdAt: number; updatedAt: number;
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

export async function beginCapabilityOperation(root: string, input: { operationId?: string; kind: CapabilityKind; action: CapabilityOperation['action']; targetId?: string; expectedRevision?: number; requestKey?: string; sourceIntent?: Record<string, any> }): Promise<CapabilityOperation> {
  const operationId = input.operationId || crypto.randomUUID();
  return sendRuntimeDataRequest(root, { operation: 'begin_capability_operation', input: {
    operationId, kind: input.kind, action: input.action, ...(input.targetId ? { targetId: input.targetId } : {}),
    expectedRevision: input.expectedRevision || 0, requestKey: input.requestKey || `capability:${operationId}`,
    sourceIntent: input.sourceIntent || {}
  } });
}

export async function attachCapabilityOperation(root: string, operationId: string, resultPath: string, runId?: string): Promise<CapabilityOperation> {
  return sendRuntimeDataRequest(root, { operation: 'attach_capability_operation', input: { operationId, resultPath, ...(runId ? { runId } : {}) } });
}

export async function readCapabilityOperations(root: string, activeOnly = false, recentLimit?: number): Promise<CapabilityOperation[]> {
  return sendRuntimeDataRequest(root, { operation: 'read_capability_operations', input: { activeOnly, ...(recentLimit ? { recentLimit } : {}) } });
}

export async function readCapabilityOperation(root: string, operationId: string): Promise<CapabilityOperation> {
  const rows = await sendRuntimeDataRequest<CapabilityOperation[]>(root, { operation: 'read_capability_operations', input: { operationId } });
  if (rows.length !== 1) throw new Error('capability_operation_missing');
  return rows[0];
}

export async function readCapabilityOperationRunState(root: string, operationId: string): Promise<{ attached: boolean; terminal: boolean; status: string; exitCode: number | null }> {
  return sendRuntimeDataRequest(root, { operation: 'read_capability_operation_run_state', input: { operationId } });
}

export async function readCapabilityOperationResult(root: string, operationId: string): Promise<{ objectId: string; revision: number; bytes: string; hash: string; mimeType: string } | null> {
  return sendRuntimeDataRequest(root, { operation: 'read_capability_operation_result', input: { operationId } });
}

export function capabilityOperationSettlementDecision(
  run: { attached: boolean; terminal: boolean; status: string; exitCode: number | null },
  resultExists: boolean
): 'wait' | 'settle' | 'fail_missing_result' {
  if (run.attached && !run.terminal) return 'wait';
  if (!resultExists) return run.attached ? 'fail_missing_result' : 'wait';
  return 'settle';
}

export function capabilityOperationNeedsLaunchRecovery(
  operation: Pick<CapabilityOperation, 'resultPath' | 'createdAt'>,
  now = Date.now(),
  graceMs = 60_000
): boolean {
  return !operation.resultPath && now - operation.createdAt >= graceMs;
}

export async function failCapabilityOperation(root: string, operationId: string, error: string): Promise<CapabilityOperation> {
  return sendRuntimeDataRequest(root, { operation: 'fail_capability_operation', input: { operationId, error } });
}

export async function completeCapabilityEntry(root: string, operationId: string, kind: CapabilityKind, entry: Record<string, any> & { id: string }, installationFiles?: Record<string, string>): Promise<{ operation: CapabilityOperation; stale?: true }> {
  const attachments = installationFiles ? captureInstallationFiles(root, installationFiles) : undefined;
  const receipt = attachments?.find(item => item.purpose === 'result');
  if (attachments && !receipt) throw new Error('capability_installation_receipt_required');
  const installationReceiptId = receipt ? crypto.createHash('sha256').update(canonicalMetadata([
    path.relative(root, installationFiles!.result), receipt.bytes
  ])).digest('hex') : undefined;
  const request = { operation: 'complete_capability_operation', input: {
    operationId, targetId: entry.id, entry, ...(attachments ? { attachments, installationReceiptId } : {})
  } } as const;
  let result: { operation: CapabilityOperation; stale?: true };
  try {
    result = await sendRuntimeDataRequest<{ operation: CapabilityOperation; stale?: true }>(root, request);
  } catch (error) {
    // The owner may commit durably before the transport reply is lost. The
    // operation row is the authority, so never turn that committed install
    // back into a filesystem rollback merely because its first reply vanished.
    let persisted: CapabilityOperation;
    try { persisted = await readCapabilityOperation(root, operationId); }
    catch {
      const uncertain = new Error('capability_commit_state_unknown');
      (uncertain as Error & { cause?: unknown }).cause = error;
      throw uncertain;
    }
    if (persisted.status !== 'succeeded') throw error;
    result = { operation: persisted };
  }
  if (result.stale) throw new Error('capability_operation_superseded');
  try { await refreshCapabilityRegistry(root, kind); }
  catch (error) {
    const persisted = await readCapabilityOperation(root, operationId).catch(() => undefined);
    if (persisted?.status !== 'succeeded') throw error;
  }
  return result;
}

export async function setCapabilityEnabled(root: string, kind: CapabilityKind, targetId: string, enabled: boolean): Promise<CapabilityOperation> {
  const snapshot = await refreshCapabilityRegistry(root, kind);
  const current = snapshot.entries.find(item => item.entry.id === targetId);
  if (current?.entry.status === 'uninstalled') throw new Error('revision_conflict');
  if (!current) throw new Error('capability_not_installed');
  const operation = await beginCapabilityOperation(root, { kind, action: enabled ? 'enable' : 'disable', targetId, expectedRevision: current.revision });
  const completed = await completeCapabilityEntry(root, operation.operationId, kind, current.entry as Record<string, any> & { id: string });
  return completed.operation;
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
