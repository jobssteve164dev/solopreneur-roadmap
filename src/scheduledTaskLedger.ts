import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SolomapScheduledAutomationTask } from './pluginContracts';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';

export interface ScheduledTaskOccurrence {
  schemaVersion: 1;
  occurrenceId: string;
  taskId: string;
  dueAt: string;
  status: 'pending' | 'running';
  attempts: number;
  claimedAt?: string;
  retryAt?: string;
  task: SolomapScheduledAutomationTask;
}

export interface ScheduledTaskLedger {
  schemaVersion: 1;
  updatedAt: string;
  tasks: ScheduledTaskOccurrence[];
  failures: Array<ScheduledTaskOccurrence & { failedAt: string }>;
}

const ledgerDirectoryName = 'scheduled-tasks';
const ledgerFileName = 'scheduled-tasks.json';
const lockFileName = 'scheduled-tasks.lock';
const defaultLeaseMaxAgeMs = 5 * 60 * 1000;

function ledgerRoot(workspaceRoot: string, globalDataPath: string): string {
  return path.join(normalizeGlobalDataPathForExtension(globalDataPath, workspaceRoot), ledgerDirectoryName);
}

export function getScheduledTaskLedgerPath(workspaceRoot: string, globalDataPath: string): string {
  return path.join(ledgerRoot(workspaceRoot, globalDataPath), ledgerFileName);
}

function emptyLedger(): ScheduledTaskLedger {
  return { schemaVersion: 1, updatedAt: new Date(0).toISOString(), tasks: [], failures: [] };
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function normalizeOccurrence(value: unknown): ScheduledTaskOccurrence | null {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const task = source.task && typeof source.task === 'object' ? source.task as SolomapScheduledAutomationTask : null;
  const occurrenceId = String(source.occurrenceId || '').trim();
  const taskId = String(source.taskId || task?.id || '').trim();
  const dueAt = String(source.dueAt || '').trim();
  if (!task || !occurrenceId || !taskId || !Number.isFinite(Date.parse(dueAt))) return null;
  return {
    schemaVersion: 1,
    occurrenceId,
    taskId,
    dueAt,
    status: source.status === 'running' ? 'running' : 'pending',
    attempts: Math.max(0, Number(source.attempts || 0) || 0),
    claimedAt: String(source.claimedAt || '').trim() || undefined,
    retryAt: String(source.retryAt || '').trim() || undefined,
    task: { ...task, id: taskId }
  };
}

export function readScheduledTaskLedger(workspaceRoot: string, globalDataPath: string): ScheduledTaskLedger {
  try {
    const parsed = JSON.parse(fs.readFileSync(getScheduledTaskLedgerPath(workspaceRoot, globalDataPath), 'utf8')) as Record<string, unknown>;
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks.map(normalizeOccurrence).filter((task): task is ScheduledTaskOccurrence => Boolean(task))
      : [];
    const failures = Array.isArray(parsed.failures)
      ? parsed.failures.map((value) => {
        const record = normalizeOccurrence(value);
        const failedAt = String((value as Record<string, unknown>)?.failedAt || '').trim();
        return record && failedAt ? { ...record, failedAt } : null;
      }).filter((task): task is ScheduledTaskOccurrence & { failedAt: string } => Boolean(task))
      : [];
    return { schemaVersion: 1, updatedAt: String(parsed.updatedAt || ''), tasks, failures };
  } catch {
    return emptyLedger();
  }
}

function withLedgerLock<T>(workspaceRoot: string, globalDataPath: string, mutate: (ledger: ScheduledTaskLedger) => T): T | null {
  const root = ledgerRoot(workspaceRoot, globalDataPath);
  fs.mkdirSync(root, { recursive: true });
  const lockPath = path.join(root, lockFileName);
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, claimedAt: new Date().toISOString() }), { encoding: 'utf8', flag: 'wx' });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs <= defaultLeaseMaxAgeMs) return null;
      fs.unlinkSync(lockPath);
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, claimedAt: new Date().toISOString() }), { encoding: 'utf8', flag: 'wx' });
    } catch {
      return null;
    }
  }
  try {
    const ledger = readScheduledTaskLedger(workspaceRoot, globalDataPath);
    const result = mutate(ledger);
    ledger.updatedAt = new Date().toISOString();
    atomicWriteJson(getScheduledTaskLedgerPath(workspaceRoot, globalDataPath), ledger);
    return result;
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* Another process may have recovered the lock. */ }
  }
}

function nextDailyAt(timeOfDay: string, now: Date): Date {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(timeOfDay || '').trim());
  const next = new Date(now.getTime());
  next.setHours(match ? Number(match[1]) : 9, match ? Number(match[2]) : 0, 0, 0);
  if (now.getTime() - next.getTime() > 30 * 60 * 1000) next.setDate(next.getDate() + 1);
  return next;
}

export function occurrenceForTask(task: SolomapScheduledAutomationTask, now = new Date()): ScheduledTaskOccurrence | null {
  if (!task.id || task.enabled === false) return null;
  const dueAt = task.scheduleKind === 'once' && Number.isFinite(Date.parse(String(task.scheduledAt || '')))
    ? new Date(String(task.scheduledAt)).toISOString()
    : nextDailyAt(task.timeOfDay || '09:00', now).toISOString();
  return {
    schemaVersion: 1,
    occurrenceId: `${task.id}@${dueAt}`,
    taskId: task.id,
    dueAt,
    status: 'pending',
    attempts: 0,
    task: { ...task }
  };
}

export function syncScheduledTaskLedger(workspaceRoot: string, globalDataPath: string, tasks: SolomapScheduledAutomationTask[], now = new Date()): ScheduledTaskLedger {
  withLedgerLock(workspaceRoot, globalDataPath, (ledger) => {
    const enabled = new Map(tasks.filter((task) => task.enabled !== false).map((task) => [task.id, task]));
    ledger.tasks = ledger.tasks.filter((record) => enabled.has(record.taskId));
    for (const task of enabled.values()) {
      const existing = ledger.tasks.find((record) => record.taskId === task.id);
      const desired = occurrenceForTask(task, now);
      if (!desired) continue;
      if (!existing) {
        ledger.tasks.push(desired);
      } else if (existing.status === 'pending' && (
        existing.task.scheduleKind !== task.scheduleKind
        || existing.task.timeOfDay !== task.timeOfDay
        || existing.task.scheduledAt !== task.scheduledAt
      )) {
        Object.assign(existing, desired);
      } else {
        existing.task = { ...task };
      }
    }
    ledger.tasks.sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt));
  });
  return readScheduledTaskLedger(workspaceRoot, globalDataPath);
}

export function claimDueScheduledTasks(workspaceRoot: string, globalDataPath: string, _ownerInstanceId: string, now = new Date()): ScheduledTaskOccurrence[] {
  const claimed: ScheduledTaskOccurrence[] = [];
  withLedgerLock(workspaceRoot, globalDataPath, (ledger) => {
    for (const record of ledger.tasks) {
      const claimedAt = Date.parse(String(record.claimedAt || ''));
      const leaseExpired = record.status === 'running' && (!Number.isFinite(claimedAt) || now.getTime() - claimedAt > defaultLeaseMaxAgeMs);
      const readyAt = Date.parse(String(record.retryAt || record.dueAt));
      if ((!leaseExpired && record.status !== 'pending') || readyAt > now.getTime()) continue;
      record.status = 'running';
      record.claimedAt = now.toISOString();
      record.attempts += 1;
      record.task = { ...record.task, id: record.taskId };
      claimed.push({ ...record, task: { ...record.task } });
    }
  });
  return claimed;
}

export function completeScheduledTaskOccurrence(workspaceRoot: string, globalDataPath: string, occurrenceId: string, now = new Date()): void {
  withLedgerLock(workspaceRoot, globalDataPath, (ledger) => {
    const current = ledger.tasks.find((record) => record.occurrenceId === occurrenceId);
    if (!current) return;
    ledger.tasks = ledger.tasks.filter((record) => record.occurrenceId !== occurrenceId);
    if (current.task.scheduleKind !== 'once' && current.task.enabled !== false) {
      const nextTask = { ...current.task, scheduleKind: 'daily' as const };
      const next = occurrenceForTask(nextTask, new Date(now.getTime() + 31 * 60 * 1000));
      if (next) ledger.tasks.push(next);
    }
    ledger.tasks.sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt));
  });
}

export function failScheduledTaskOccurrence(workspaceRoot: string, globalDataPath: string, occurrenceId: string, now = new Date()): 'retry' | 'failed' {
  let result: 'retry' | 'failed' = 'retry';
  withLedgerLock(workspaceRoot, globalDataPath, (ledger) => {
    const current = ledger.tasks.find((record) => record.occurrenceId === occurrenceId);
    if (!current) return;
    if (current.attempts >= 3) {
      ledger.tasks = ledger.tasks.filter((record) => record.occurrenceId !== occurrenceId);
      ledger.failures.push({ ...current, failedAt: now.toISOString() });
      result = 'failed';
      return;
    }
    current.status = 'pending';
    current.claimedAt = undefined;
    const delays = [60_000, 5 * 60_000, 15 * 60_000];
    current.retryAt = new Date(now.getTime() + delays[Math.min(current.attempts - 1, delays.length - 1)]).toISOString();
  });
  return result;
}

export function validateScheduledTaskLedger(value: unknown): string[] {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (source.schemaVersion !== 1) return ['schemaVersion 必须为 1。'];
  if (!Array.isArray(source.tasks)) return ['tasks 必须是数组。'];
  const errors: string[] = [];
  const ids = new Set<string>();
  source.tasks.forEach((item, index) => {
    const record = normalizeOccurrence(item);
    if (!record) errors.push(`tasks[${index}] 不是有效的定时任务记录。`);
    else if (ids.has(record.occurrenceId)) errors.push(`occurrenceId 重复：${record.occurrenceId}`);
    else ids.add(record.occurrenceId);
  });
  return errors;
}
