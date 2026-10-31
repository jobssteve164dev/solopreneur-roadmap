import type { RuntimeExecutionDomain } from './runtimeOperationRegistry';

interface ScheduledWork<T> {
  action: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

const domainOrder: readonly RuntimeExecutionDomain[] = [
  'foreground-command',
  'interactive-query',
  'external-job',
  'background-query',
  'maintenance'
];
const domainConcurrency: Readonly<Record<RuntimeExecutionDomain, number>> = {
  'foreground-command': 16,
  'interactive-query': 32,
  'external-job': 4,
  'background-query': 8,
  maintenance: 1
};

/** Admission and ordering for the Runtime's independently isolated domains. */
export class RuntimeExecutionScheduler {
  private readonly queues = new Map<RuntimeExecutionDomain, Array<ScheduledWork<unknown>>>(
    domainOrder.map(domain => [domain, []])
  );
  private readonly active = new Map<RuntimeExecutionDomain, number>(domainOrder.map(domain => [domain, 0]));
  private scheduled = false;

  submit<T>(domain: RuntimeExecutionDomain, action: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queues.get(domain)!.push({ action, resolve, reject } as ScheduledWork<unknown>);
      this.schedule();
    });
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
    const work = this.queues.get(domain)!.shift();
    if (!work) return;
    this.active.set(domain, (this.active.get(domain) || 0) + 1);
    let result: Promise<unknown>;
    try { result = Promise.resolve(work.action()); }
    catch (error) { result = Promise.reject(error); }
    void result.then(work.resolve, work.reject).finally(() => {
      this.active.set(domain, Math.max(0, (this.active.get(domain) || 1) - 1));
      this.schedule();
    });
    if ((this.active.get(domain) || 0) < domainConcurrency[domain]) this.schedule();
  }
}
