import * as crypto from 'crypto';
import { SolomapScheduledAutomationTask } from './pluginContracts';
import { normalizeGlobalDataPathForExtension } from './projectRegistry';
import { sendRuntimeDataRequest } from './autonomousRuntimeControl';

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
  generation?: number;
  token?: string;
}

export interface ScheduledTaskLedger {
  schemaVersion: 1;
  updatedAt: string;
  tasks: ScheduledTaskOccurrence[];
  failures: Array<ScheduledTaskOccurrence & { failedAt: string }>;
}

const defaultLeaseMaxAgeMs = 5 * 60 * 1000;
const scheduleOwnerBirth = `${process.pid}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`;

type ScheduleOperation = (operation: string, input: Record<string, unknown>) => Promise<unknown>;

function databaseOperation(workspaceRoot: string, globalDataPath: string, operation?: ScheduleOperation): ScheduleOperation {
  if (operation) return operation;
  const root = normalizeGlobalDataPathForExtension(globalDataPath, workspaceRoot);
  return (name, input) => sendRuntimeDataRequest(root, { operation: name, input });
}

export async function syncScheduledTaskDatabase(workspaceRoot: string, globalDataPath: string, tasks: SolomapScheduledAutomationTask[], now = new Date(), operation?: ScheduleOperation): Promise<ScheduledTaskLedger> {
  const call = databaseOperation(workspaceRoot, globalDataPath, operation);
  const schedules = tasks.filter(task => task.id).map(task => {
    const occurrence = occurrenceForTask(task, now);
    return { id: task.id, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', trigger: { kind: task.scheduleKind || 'daily', timeOfDay: task.timeOfDay || '', scheduledAt: task.scheduledAt || '' }, enabled: task.enabled !== false,
      nextDueAt: occurrence ? Date.parse(occurrence.dueAt) : now.getTime(), task };
  });
  const desiredHash = crypto.createHash('sha256').update(JSON.stringify(schedules)).digest('hex');
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = await call('read_schedule_sync_state', {}) as { version: string };
    try {
      await call('sync_schedules', { schedules, expectedVersion: state.version, idempotencyKey: `schedule-sync:${state.version}:${desiredHash}` });
      break;
    } catch (error) {
      if ((error as Error).message !== 'revision_conflict' || attempt === 4) throw error;
    }
  }
  return readScheduledTaskDatabase(workspaceRoot, globalDataPath, call);
}

export async function readScheduledTaskDatabase(workspaceRoot: string, globalDataPath: string, operation?: ScheduleOperation): Promise<ScheduledTaskLedger> {
  const result = await databaseOperation(workspaceRoot, globalDataPath, operation)('read_schedule_ledger', {}) as { tasks: ScheduledTaskOccurrence[]; failures: Array<ScheduledTaskOccurrence & { failedAt?: string }> };
  return { schemaVersion: 1, updatedAt: new Date().toISOString(), tasks: result.tasks.map(item => ({ ...item, schemaVersion: 1, dueAt: String(item.dueAt), status: item.status === 'running' ? 'running' : 'pending' })), failures: result.failures.map(item => ({ ...item, schemaVersion: 1, dueAt: String(item.dueAt), status: item.status === 'running' ? 'running' : 'pending', failedAt: item.failedAt || new Date().toISOString() })) };
}

export async function claimDueScheduledTaskDatabase(workspaceRoot: string, globalDataPath: string, ownerInstanceId: string, now = new Date(), operation?: ScheduleOperation): Promise<ScheduledTaskOccurrence[]> {
  const result = await databaseOperation(workspaceRoot, globalDataPath, operation)('claim_due_schedules', { owner: { id: ownerInstanceId, pid: process.pid, birth: scheduleOwnerBirth }, now: now.getTime(), leaseMs: defaultLeaseMaxAgeMs, limit: 100 }) as { items: Array<Record<string, unknown>> };
  return result.items.map(item => ({ schemaVersion: 1, occurrenceId: String(item.occurrenceId), taskId: String(item.scheduleId), dueAt: new Date(Number(item.dueAt)).toISOString(), status: 'running', attempts: Number(item.attempts), generation: Number(item.generation), token: String(item.token), task: item.task as SolomapScheduledAutomationTask }));
}

export async function completeScheduledTaskDatabase(workspaceRoot: string, globalDataPath: string, occurrence: ScheduledTaskOccurrence, operation?: ScheduleOperation): Promise<void> {
  await databaseOperation(workspaceRoot, globalDataPath, operation)('settle_schedule_occurrence', { occurrenceId: occurrence.occurrenceId, token: occurrence.token, state: 'completed', idempotencyKey: `schedule-complete:${occurrence.occurrenceId}:${occurrence.generation}` });
}

export async function failScheduledTaskDatabase(workspaceRoot: string, globalDataPath: string, occurrence: ScheduledTaskOccurrence, now = new Date(), operation?: ScheduleOperation): Promise<'retrying' | 'failed'> {
  const failed = occurrence.attempts >= 3;
  await databaseOperation(workspaceRoot, globalDataPath, operation)('settle_schedule_occurrence', { occurrenceId: occurrence.occurrenceId, token: occurrence.token, state: failed ? 'failed' : 'pending', ...(failed ? {} : { retryAt: now.getTime() + Math.max(1, occurrence.attempts) * 60_000 }), idempotencyKey: `schedule-fail:${occurrence.occurrenceId}:${occurrence.generation}` });
  return failed ? 'failed' : 'retrying';
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
