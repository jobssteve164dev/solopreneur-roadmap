import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';

export interface ActiveConversationRecord {
  schemaVersion: 1;
  conversationId: number;
  executionLogId: number;
  nodeId: string;
  workspaceRoot: string;
  statusFilePath: string;
  runKind: string;
  ownerInstanceId: string;
  registeredAt: string;
  updatedAt: string;
}

export interface ActiveConversationLease {
  record: ActiveConversationRecord;
  recordPath: string;
  leasePath: string;
}

const ledgerDirectoryName = 'active-conversations';
const recordsDirectoryName = 'records';
const leasesDirectoryName = 'leases';
const migrationMarkerName = 'project-status-migration-v1.json';
const defaultLeaseMaxAgeMs = 5 * 60 * 1000;

function ledgerRoot(workspaceRoot: string, globalDataPath: string): string {
  return path.join(normalizeGlobalDataPathForExtension(globalDataPath, workspaceRoot), ledgerDirectoryName);
}

function ensureLedgerDirectories(workspaceRoot: string, globalDataPath: string): { recordsRoot: string; leasesRoot: string } {
  const root = ledgerRoot(workspaceRoot, globalDataPath);
  const recordsRoot = path.join(root, recordsDirectoryName);
  const leasesRoot = path.join(root, leasesDirectoryName);
  fs.mkdirSync(recordsRoot, { recursive: true });
  fs.mkdirSync(leasesRoot, { recursive: true });
  return { recordsRoot, leasesRoot };
}

function conversationKey(workspaceRoot: string, executionLogId: number): string {
  return crypto.createHash('sha256')
    .update(`${path.resolve(workspaceRoot)}\0${Number(executionLogId)}`)
    .digest('hex');
}

function recordPathFor(workspaceRoot: string, globalDataPath: string, executionLogId: number): string {
  const { recordsRoot } = ensureLedgerDirectories(workspaceRoot, globalDataPath);
  return path.join(recordsRoot, `${conversationKey(workspaceRoot, executionLogId)}.json`);
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function readRecord(recordPath: string): ActiveConversationRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as Partial<ActiveConversationRecord>;
    const workspaceRoot = String(parsed.workspaceRoot || '').trim();
    const statusFilePath = String(parsed.statusFilePath || '').trim();
    const executionLogId = Number(parsed.executionLogId || parsed.conversationId || 0);
    if (!workspaceRoot || !statusFilePath || !executionLogId) {
      return null;
    }
    return {
      schemaVersion: 1,
      conversationId: Number(parsed.conversationId || executionLogId),
      executionLogId,
      nodeId: String(parsed.nodeId || ''),
      workspaceRoot,
      statusFilePath,
      runKind: String(parsed.runKind || 'step'),
      ownerInstanceId: String(parsed.ownerInstanceId || ''),
      registeredAt: String(parsed.registeredAt || parsed.updatedAt || ''),
      updatedAt: String(parsed.updatedAt || parsed.registeredAt || '')
    };
  } catch {
    return null;
  }
}

export function registerActiveConversation(input: {
  workspaceRoot: string;
  globalDataPath: string;
  conversationId: number;
  executionLogId?: number;
  nodeId: string;
  statusFilePath: string;
  runKind: string;
  ownerInstanceId: string;
}): ActiveConversationRecord {
  const executionLogId = Number(input.executionLogId || input.conversationId);
  const recordPath = recordPathFor(input.workspaceRoot, input.globalDataPath, executionLogId);
  const existing = fs.existsSync(recordPath) ? readRecord(recordPath) : null;
  const now = new Date().toISOString();
  const record: ActiveConversationRecord = {
    schemaVersion: 1,
    conversationId: Number(input.conversationId || executionLogId),
    executionLogId,
    nodeId: String(input.nodeId || ''),
    workspaceRoot: path.resolve(input.workspaceRoot),
    statusFilePath: path.resolve(input.statusFilePath),
    runKind: String(input.runKind || 'step'),
    ownerInstanceId: String(input.ownerInstanceId || ''),
    registeredAt: existing?.registeredAt || now,
    updatedAt: now
  };
  atomicWriteJson(recordPath, record);
  return record;
}

export function listActiveConversations(workspaceRoot: string, globalDataPath: string): ActiveConversationRecord[] {
  const { recordsRoot } = ensureLedgerDirectories(workspaceRoot, globalDataPath);
  try {
    return fs.readdirSync(recordsRoot)
      .filter((fileName) => fileName.endsWith('.json'))
      .map((fileName) => readRecord(path.join(recordsRoot, fileName)))
      .filter((record): record is ActiveConversationRecord => Boolean(record));
  } catch {
    return [];
  }
}

export function claimActiveConversation(
  workspaceRoot: string,
  globalDataPath: string,
  record: ActiveConversationRecord,
  ownerInstanceId: string,
  now = Date.now(),
  leaseMaxAgeMs = defaultLeaseMaxAgeMs
): ActiveConversationLease | null {
  const { leasesRoot } = ensureLedgerDirectories(workspaceRoot, globalDataPath);
  const recordPath = recordPathFor(record.workspaceRoot, globalDataPath, record.executionLogId);
  if (!fs.existsSync(recordPath)) {
    return null;
  }
  const leasePath = path.join(leasesRoot, `${conversationKey(record.workspaceRoot, record.executionLogId)}.lock`);
  const tryCreate = (): boolean => {
    try {
      fs.writeFileSync(leasePath, JSON.stringify({ ownerInstanceId, claimedAt: new Date(now).toISOString() }), { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      return false;
    }
  };
  if (!tryCreate()) {
    try {
      const ageMs = now - fs.statSync(leasePath).mtimeMs;
      if (ageMs <= leaseMaxAgeMs) return null;
      fs.unlinkSync(leasePath);
    } catch {
      return null;
    }
    if (!tryCreate()) return null;
  }
  return { record, recordPath, leasePath };
}

export function releaseActiveConversationLease(lease: ActiveConversationLease): void {
  try {
    fs.unlinkSync(lease.leasePath);
  } catch {
    // Another recovering instance may already have cleared an expired lease.
  }
}

export function unregisterActiveConversation(
  workspaceRoot: string,
  globalDataPath: string,
  executionLogId: number,
  expectedStatusFilePath = ''
): boolean {
  const recordPath = recordPathFor(workspaceRoot, globalDataPath, executionLogId);
  const current = readRecord(recordPath);
  if (!current || current.executionLogId !== Number(executionLogId)) return false;
  if (expectedStatusFilePath && path.resolve(current.statusFilePath) !== path.resolve(expectedStatusFilePath)) return false;
  try {
    fs.unlinkSync(recordPath);
    return true;
  } catch {
    return false;
  }
}

export function getActiveConversationMigrationMarkerPath(workspaceRoot: string, globalDataPath: string): string {
  return path.join(ledgerRoot(workspaceRoot, globalDataPath), migrationMarkerName);
}

export function markActiveConversationMigrationComplete(workspaceRoot: string, globalDataPath: string): void {
  atomicWriteJson(getActiveConversationMigrationMarkerPath(workspaceRoot, globalDataPath), {
    schemaVersion: 1,
    completedAt: new Date().toISOString()
  });
}
