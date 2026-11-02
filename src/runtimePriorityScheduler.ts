import type { RuntimeExecutionDomain } from './runtimeOperationRegistry';
import { AsyncLocalStorage } from 'async_hooks';

interface ScheduledWork<T> {
  action: (admission: RuntimeSchedulerAdmission) => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  deadlineAt?: number;
  supersedesKey?: string;
  label?: string;
  deadlineTimer?: NodeJS.Timeout;
  parentAdmission?: RuntimeSchedulerAdmission;
}

export interface RuntimeSchedulerAdmission {
  readonly id: number;
  readonly domain: RuntimeExecutionDomain;
}

export interface RuntimeScheduleOptions {
  /** Latest time at which queued work may begin. Once begun, accepted work drains to completion. */
  deadlineAt?: number;
  /** Coalesces an older queued observation with the same key; never supersedes commands already running. */
  supersedesKey?: string;
  /** Stable operation identity used only in scheduler evidence. */
  label?: string;
}

const domainOrder: readonly RuntimeExecutionDomain[] = [
  'control-query',
  'foreground-command',
  'foreground-query',
  'interactive-query',
  'subscription-event',
  'runtime-event',
  'background-command',
  'git-job',
  'network-job',
  'external-job',
  'background-query',
  'maintenance'
];
const domainConcurrency: Readonly<Record<RuntimeExecutionDomain, number>> = {
  'control-query': 64,
  'foreground-command': 16,
  'foreground-query': 8,
  'interactive-query': 32,
  'subscription-event': 256,
  'runtime-event': 256,
  'background-command': 4,
  'git-job': 1,
  'network-job': 2,
  'external-job': 4,
  'background-query': 2,
  maintenance: 1
};
const domainQueueCapacity: Readonly<Record<RuntimeExecutionDomain, number>> = {
  'control-query': 256,
  'foreground-command': 2_048,
  'foreground-query': 1_024,
  'interactive-query': 1_024,
  'subscription-event': 256,
  'runtime-event': 256,
  'background-command': 256,
  'git-job': 64,
  'network-job': 128,
  'external-job': 128,
  'background-query': 256,
  maintenance: 64
};
const foregroundDomains = new Set<RuntimeExecutionDomain>([
  'control-query', 'foreground-command', 'foreground-query', 'interactive-query'
]);
const backgroundYieldDomains = new Set<RuntimeExecutionDomain>([
  'background-command', 'git-job', 'network-job', 'background-query', 'maintenance'
]);
const foregroundReservationMs = 25;

/** Admission and ordering for the Runtime's independently isolated domains. */
export class RuntimeExecutionScheduler {
  private readonly queues = new Map<RuntimeExecutionDomain, Array<ScheduledWork<unknown>>>(
    domainOrder.map(domain => [domain, []])
  );
  private readonly active = new Map<RuntimeExecutionDomain, number>(domainOrder.map(domain => [domain, 0]));
  private readonly activeLabels = new Map<RuntimeExecutionDomain, Map<string, number>>(
    domainOrder.map(domain => [domain, new Map()])
  );
  private scheduled = false;
  private foregroundReservedUntil = 0;
  private foregroundReservationTimer?: NodeJS.Timeout;
  private admissionSequence = 0;
  private readonly admissions = new WeakSet<object>();
  private readonly admissionContext = new AsyncLocalStorage<RuntimeSchedulerAdmission>();

  submit<T>(domain: RuntimeExecutionDomain, action: (admission: RuntimeSchedulerAdmission) => Promise<T>, options: RuntimeScheduleOptions = {}): Promise<T> {
    if (options.deadlineAt !== undefined && (!Number.isFinite(options.deadlineAt) || options.deadlineAt <= Date.now())) {
      return Promise.reject(new Error(this.deadlineEvidence(domain, options.label)));
    }
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(domain)!;
      const supersedesKey = domain === 'background-command' || domain === 'background-query' || domain === 'external-job' || domain === 'network-job'
        ? String(options.supersedesKey || '').trim() || undefined
        : undefined;
      if (supersedesKey) {
        const obsoleteIndex = queue.findIndex(work => work.supersedesKey === supersedesKey);
        if (obsoleteIndex >= 0) {
          const [obsolete] = queue.splice(obsoleteIndex, 1);
          if (obsolete.deadlineTimer) clearTimeout(obsolete.deadlineTimer);
          obsolete.reject(new Error(`runtime_request_superseded:${domain}:${supersedesKey}`));
        }
      }
      if (queue.length >= domainQueueCapacity[domain]) {
        reject(new Error(`runtime_domain_queue_full:${domain}`));
        return;
      }
      if (foregroundDomains.has(domain)) {
        this.foregroundReservedUntil = Math.max(this.foregroundReservedUntil, Date.now() + foregroundReservationMs);
      }
      const work: ScheduledWork<unknown> = {
        action, resolve, reject, deadlineAt: options.deadlineAt, supersedesKey, label: options.label,
        parentAdmission: this.admissionContext.getStore()
      } as ScheduledWork<unknown>;
      if (options.deadlineAt !== undefined) {
        work.deadlineTimer = setTimeout(() => {
          const index = queue.indexOf(work);
          if (index < 0) return;
          queue.splice(index, 1);
          work.reject(new Error(this.deadlineEvidence(domain, work.label)));
        }, Math.max(1, options.deadlineAt - Date.now()));
        work.deadlineTimer.unref();
      }
      queue.push(work);
      this.schedule();
    });
  }

  /** Executes child work under the already admitted parent instead of re-queuing behind it. */
  submitChild<T>(admission: RuntimeSchedulerAdmission, action: () => Promise<T>, options: RuntimeScheduleOptions = {}): Promise<T> {
    if (!admission || !this.admissions.has(admission as object)) return Promise.reject(new Error('runtime_scheduler_admission_invalid'));
    if (options.deadlineAt !== undefined && (!Number.isFinite(options.deadlineAt) || options.deadlineAt <= Date.now())) {
      return Promise.reject(new Error(this.deadlineEvidence(admission.domain, options.label)));
    }
    try { return Promise.resolve(action()); }
    catch (error) { return Promise.reject(error); }
  }

  snapshot(): Record<RuntimeExecutionDomain, { active: number; queued: number; capacity: number; concurrency: number; blockers: Record<string, number> }> {
    return Object.fromEntries(domainOrder.map(domain => [domain, {
      active: this.active.get(domain) || 0,
      queued: this.queues.get(domain)!.length,
      capacity: domainQueueCapacity[domain],
      concurrency: domainConcurrency[domain],
      blockers: Object.fromEntries([...this.activeLabels.get(domain)!.entries()].sort(([left], [right]) => left.localeCompare(right)))
    }])) as Record<RuntimeExecutionDomain, { active: number; queued: number; capacity: number; concurrency: number; blockers: Record<string, number> }>;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const domain of domainOrder) this.startNext(domain);
    });
  }

  private startNext(domain: RuntimeExecutionDomain): void {
    if ((this.active.get(domain) || 0) >= domainConcurrency[domain]) return;
    const queue = this.queues.get(domain)!;
    if (!queue.length) return;
    let workIndex = 0;
    if (backgroundYieldDomains.has(domain) && this.foregroundReservation()) {
      workIndex = queue.findIndex(work => Boolean(work.parentAdmission
        && foregroundDomains.has(work.parentAdmission.domain)));
      if (workIndex < 0) {
        this.scheduleForegroundReservationWake();
        return;
      }
    }
    const [work] = queue.splice(workIndex, 1);
    if (!work) return;
    if (work.deadlineTimer) clearTimeout(work.deadlineTimer);
    if (work.deadlineAt !== undefined && work.deadlineAt <= Date.now()) {
      work.reject(new Error(this.deadlineEvidence(domain, work.label)));
      this.schedule();
      return;
    }
    this.active.set(domain, (this.active.get(domain) || 0) + 1);
    this.changeActiveLabel(domain, work.label, 1);
    const admission = Object.freeze({ id: ++this.admissionSequence, domain });
    this.admissions.add(admission);
    let result: Promise<unknown>;
    try { result = this.admissionContext.run(admission, () => Promise.resolve(work.action(admission))); }
    catch (error) { result = Promise.reject(error); }
    void result.then(work.resolve, work.reject).finally(() => {
      this.active.set(domain, Math.max(0, (this.active.get(domain) || 1) - 1));
      this.changeActiveLabel(domain, work.label, -1);
      if (foregroundDomains.has(domain)) {
        this.foregroundReservedUntil = Math.max(this.foregroundReservedUntil, Date.now() + foregroundReservationMs);
      }
      this.schedule();
    });
    if ((this.active.get(domain) || 0) < domainConcurrency[domain]) this.schedule();
  }

  private foregroundReservation(): boolean {
    return [...foregroundDomains].some(domain => this.queues.get(domain)!.length > 0)
      || Date.now() < this.foregroundReservedUntil;
  }

  private scheduleForegroundReservationWake(): void {
    if ([...foregroundDomains].some(domain => this.queues.get(domain)!.length > 0)) return;
    if (this.foregroundReservationTimer) return;
    const delay = Math.max(1, this.foregroundReservedUntil - Date.now());
    this.foregroundReservationTimer = setTimeout(() => {
      this.foregroundReservationTimer = undefined;
      this.schedule();
    }, delay);
  }

  private changeActiveLabel(domain: RuntimeExecutionDomain, label: string | undefined, delta: 1 | -1): void {
    const key = String(label || 'anonymous');
    const labels = this.activeLabels.get(domain)!;
    const next = (labels.get(key) || 0) + delta;
    if (next > 0) labels.set(key, next);
    else labels.delete(key);
  }

  private deadlineEvidence(domain: RuntimeExecutionDomain, label: string | undefined): string {
    const blockers = [...this.activeLabels.get(domain)!.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => `${name}*${count}`)
      .join(',') || 'none';
    return `runtime_request_deadline_exceeded:${domain}:${String(label || 'anonymous')}`
      + `:active=${this.active.get(domain) || 0}:queued=${this.queues.get(domain)!.length}:blockers=${blockers}`;
  }
}
