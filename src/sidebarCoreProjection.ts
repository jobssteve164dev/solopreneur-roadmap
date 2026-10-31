import * as path from 'path';
import { Worker } from 'worker_threads';

import type { ProjectPortfolioSummary, SolopreneurProject } from './projectPortfolio';

interface ProjectionJob {
  id: number;
  project: SolopreneurProject;
  resolve(value: { summary: ProjectPortfolioSummary; workerThreadId: number }): void;
  reject(error: unknown): void;
}

interface ProjectionSlot {
  worker: Worker;
  job?: ProjectionJob;
}

const slots: ProjectionSlot[] = [];
const queue: ProjectionJob[] = [];
const inFlight = new Map<string, Promise<{ summary: ProjectPortfolioSummary; workerThreadId: number }>>();
let sequence = 0;
let idleTimer: NodeJS.Timeout | undefined;

function projectKey(project: SolopreneurProject): string {
  return JSON.stringify(project);
}

function startSlot(): ProjectionSlot {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
  const slot: ProjectionSlot = { worker: new Worker(path.join(__dirname, 'sidebarCoreProjectionWorker.js')) };
  slot.worker.on('message', (message: { id?: number; summary?: ProjectPortfolioSummary; workerThreadId?: number; error?: string }) => {
    const job = slot.job;
    if (!job || Number(message.id) !== job.id) return;
    slot.job = undefined;
    slot.worker.unref();
    if (message.error || !message.summary) job.reject(new Error(message.error || 'sidebar_core_projection_missing'));
    else job.resolve({ summary: message.summary, workerThreadId: Number(message.workerThreadId) });
    drainProjectionQueue();
  });
  const fail = (error: unknown) => {
    slot.job?.reject(error);
    slot.job = undefined;
    const index = slots.indexOf(slot);
    if (index >= 0) slots.splice(index, 1);
    drainProjectionQueue();
  };
  slot.worker.once('error', fail);
  slot.worker.once('exit', code => { if (slot.job && code !== 0) fail(new Error(`sidebar_core_projection_exited:${code}`)); });
  slot.worker.unref();
  slots.push(slot);
  return slot;
}

function drainProjectionQueue(): void {
  while (queue.length) {
    const slot = slots.find(candidate => !candidate.job) || (slots.length < 2 ? startSlot() : undefined);
    if (!slot) return;
    const job = queue.shift()!;
    slot.job = job;
    slot.worker.ref();
    slot.worker.postMessage({ id: job.id, project: job.project });
  }
  if (!queue.length && slots.every(slot => !slot.job) && !idleTimer) {
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      for (const slot of slots.splice(0)) void slot.worker.terminate();
    }, 250);
    idleTimer.unref();
  }
}

function projectProjection(project: SolopreneurProject): Promise<{ summary: ProjectPortfolioSummary; workerThreadId: number }> {
  const key = projectKey(project);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const projection = new Promise<{ summary: ProjectPortfolioSummary; workerThreadId: number }>((resolve, reject) => {
    queue.push({ id: ++sequence, project, resolve, reject });
    drainProjectionQueue();
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, projection);
  return projection;
}

export async function buildSidebarCoreProjection(projects: SolopreneurProject[]): Promise<{
  portfolio: ProjectPortfolioSummary[];
  workerThreadId: number;
}> {
  const projected = await Promise.all(projects.map(projectProjection));
  return {
    portfolio: projected.map(value => value.summary),
    workerThreadId: projected[0]?.workerThreadId || 0
  };
}
