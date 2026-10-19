import * as crypto from 'crypto';
import { IntelligenceTimeScheduleInput, validateIntelligenceTimeScheduleInput } from './intelligenceMcp';
import { SolomapScheduledAutomationTask } from './pluginContracts';
import { occurrenceForTask, readScheduledTaskDatabase, syncScheduledTaskDatabase } from './scheduledTaskLedger';

type Operation = (operation: string, input: Record<string, unknown>) => Promise<unknown>;
type SynchronousOperation = (operation: string, input: Record<string, unknown>) => unknown;
type Project = { name: string; path: string };

export function intelligenceTimeScheduleTaskId(projectPath: string, input: IntelligenceTimeScheduleInput): string {
  const intent = JSON.stringify({ projectPath, title: input.title, scheduleKind: input.scheduleKind,
    scheduledAt: input.scheduledAt || '', timeOfDay: input.timeOfDay || '', assignee: input.assignee, prompt: input.prompt || '' });
  return `intelligence-${crypto.createHash('sha256').update(intent).digest('hex').slice(0, 24)}`;
}

function existingScheduledTasks(value: unknown): SolomapScheduledAutomationTask[] {
  const automation = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (Array.isArray(automation.scheduledTasks)) return automation.scheduledTasks.filter(task => task && typeof task === 'object') as SolomapScheduledAutomationTask[];
  const trigger = automation.triggers && typeof automation.triggers === 'object'
    ? (automation.triggers as Record<string, unknown>).scheduled_time as Record<string, unknown> | undefined : undefined;
  const prompt = String(trigger?.prompt || '').trim();
  return prompt ? [{ id: 'scheduled-default', title: '', enabled: true, scheduleKind: 'daily', timeOfDay: String(trigger?.timeOfDay || '09:00'), assignee: 'agent', prompt }] : [];
}

export async function setIntelligenceTimeScheduleInDatabase(globalDataPath: string, project: Project, raw: IntelligenceTimeScheduleInput, operation: Operation): Promise<Record<string, unknown>> {
  const input = validateIntelligenceTimeScheduleInput(raw);
  if (!project.path) throw new Error('请先在 SoloMap 中选择要安排任务的项目。');
  const taskId = intelligenceTimeScheduleTaskId(project.path, input);
  const task: SolomapScheduledAutomationTask = {
    id: taskId, title: input.title, enabled: true, projectPath: project.path, projectName: project.name,
    scheduleKind: input.scheduleKind, assignee: input.assignee,
    ...(input.scheduleKind === 'once' ? { scheduledAt: input.scheduledAt } : { timeOfDay: input.timeOfDay }),
    ...(input.assignee === 'agent' ? { prompt: input.prompt } : {})
  };
  let tasks: SolomapScheduledAutomationTask[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await operation('read_host_settings', { namespace: 'extension', ownerScope: 'global' }) as { items: Array<{ key: string; revision: number; value?: unknown }> };
    const item = current.items.find(entry => entry.key === 'automationTasks');
    const automation = item?.value && typeof item.value === 'object' ? item.value as Record<string, unknown> : {};
    tasks = existingScheduledTasks(automation);
    const existing = tasks.find(entry => entry.id === taskId);
    if (existing) {
      break;
    }
    tasks = [...tasks, task];
    try {
      await operation('patch_host_settings', { namespace: 'extension', ownerScope: 'global', patches: [{ key: 'automationTasks', expectedRevision: item?.revision || 0, value: { ...automation, scheduledTasks: tasks } }], idempotencyKey: `intelligence-time-schedule:${taskId}:${item?.revision || 0}` });
      break;
    } catch (error) {
      if ((error as Error).message !== 'revision_conflict' || attempt === 4) throw error;
    }
  }
  const currentLedger = await readScheduledTaskDatabase(project.path, globalDataPath, operation);
  const internalTasks = currentLedger.tasks
    .map(item => item.task)
    .filter(item => item.internalKind === 'focus_reminder');
  await syncScheduledTaskDatabase(project.path, globalDataPath, [...tasks, ...internalTasks], new Date(), operation);
  return { taskId, title: task.title, scheduleKind: task.scheduleKind,
    ...(task.scheduledAt ? { scheduledAt: task.scheduledAt } : {}), ...(task.timeOfDay ? { timeOfDay: task.timeOfDay } : {}), assignee: task.assignee };
}

/** Native Pi tool path: the caller holds one SQLite writer transaction for this entire synchronous function. */
export function setIntelligenceTimeScheduleInDatabaseSync(project: Project, raw: IntelligenceTimeScheduleInput, operation: SynchronousOperation): Record<string, unknown> {
  const input = validateIntelligenceTimeScheduleInput(raw);
  if (!project.path) throw new Error('请先在 SoloMap 中选择要安排任务的项目。');
  const taskId = intelligenceTimeScheduleTaskId(project.path, input);
  const task: SolomapScheduledAutomationTask = {
    id: taskId, title: input.title, enabled: true, projectPath: project.path, projectName: project.name,
    scheduleKind: input.scheduleKind, assignee: input.assignee,
    ...(input.scheduleKind === 'once' ? { scheduledAt: input.scheduledAt } : { timeOfDay: input.timeOfDay }),
    ...(input.assignee === 'agent' ? { prompt: input.prompt } : {})
  };
  const current = operation('read_host_settings', { namespace: 'extension', ownerScope: 'global' }) as { items: Array<{ key: string; revision: number; value?: unknown }> };
  const item = current.items.find(entry => entry.key === 'automationTasks');
  const automation = item?.value && typeof item.value === 'object' ? item.value as Record<string, unknown> : {};
  let tasks = existingScheduledTasks(automation);
  if (!tasks.some(entry => entry.id === taskId)) {
    tasks = [...tasks, task];
    operation('patch_host_settings', { namespace: 'extension', ownerScope: 'global', patches: [{ key: 'automationTasks', expectedRevision: item?.revision || 0, value: { ...automation, scheduledTasks: tasks } }], idempotencyKey: `intelligence-time-schedule:${taskId}:${item?.revision || 0}` });
  }
  const ledger = operation('read_schedule_ledger', {}) as { tasks: Array<{ task: SolomapScheduledAutomationTask }> };
  const allTasks = [...tasks, ...ledger.tasks.map(item => item.task).filter(item => item.internalKind === 'focus_reminder')];
  const now = new Date();
  const schedules = allTasks.filter(item => item.id).map(item => {
    const occurrence = occurrenceForTask(item, now);
    return { id: item.id, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', trigger: { kind: item.scheduleKind || 'daily', timeOfDay: item.timeOfDay || '', scheduledAt: item.scheduledAt || '' }, enabled: item.enabled !== false,
      nextDueAt: occurrence ? Date.parse(occurrence.dueAt) : now.getTime(), task: item };
  });
  const desiredHash = crypto.createHash('sha256').update(JSON.stringify(schedules)).digest('hex');
  const state = operation('read_schedule_sync_state', {}) as { version: string };
  operation('sync_schedules', { schedules, expectedVersion: state.version, idempotencyKey: `schedule-sync:${state.version}:${desiredHash}` });
  return { taskId, title: task.title, scheduleKind: task.scheduleKind,
    ...(task.scheduledAt ? { scheduledAt: task.scheduledAt } : {}), ...(task.timeOfDay ? { timeOfDay: task.timeOfDay } : {}), assignee: task.assignee };
}
