import { CognitiveCliInvocation, runCognitiveCliInvocation } from './localAgentCliEngine';

/** Owns model CLI processes in a non-restartable supervisor isolate. */
export class CognitiveCliProcessExecutor {
  private readonly cancellations = new Map<number, () => void>();
  private readonly active = new Set<Promise<void>>();
  private readonly waiters: Array<{ resolve(): void; reject(error: Error): void }> = [];
  private activeInvocations = 0;
  private closed = false;

  private async acquire(): Promise<void> {
    if (this.closed) throw new Error('cognitive_cli_executor_closed');
    if (this.activeInvocations < 2 && this.waiters.length === 0) this.activeInvocations++;
    else await new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private release(): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve();
    else this.activeInvocations = Math.max(0, this.activeInvocations - 1);
  }

  async execute(id: number, invocation: CognitiveCliInvocation): Promise<string> {
    if (this.closed) throw new Error('cognitive_cli_executor_closed');
    if (!Number.isSafeInteger(id) || id < 1 || this.cancellations.has(id)) throw new Error('cognitive_cli_invocation_invalid');
    let cancel = () => {};
    let cancelled = false;
    this.cancellations.set(id, () => { cancelled = true; cancel(); });
    try { await this.acquire(); }
    catch (error) { this.cancellations.delete(id); throw error; }
    if (cancelled) { this.release(); this.cancellations.delete(id); throw new Error('Local Agent CLI cognitive call was cancelled.'); }
    let release!: () => void;
    const settled = new Promise<void>(resolve => { release = resolve; });
    this.active.add(settled);
    try {
      return await runCognitiveCliInvocation(invocation, next => {
        cancel = next || (() => {});
        if (this.closed) cancel();
      });
    } finally {
      this.cancellations.delete(id);
      this.active.delete(settled);
      release();
      this.release();
    }
  }

  cancel(id: number): void { this.cancellations.get(id)?.(); }

  async close(): Promise<void> {
    this.closed = true;
    for (const cancel of this.cancellations.values()) cancel();
    while (this.waiters.length) this.waiters.shift()?.reject(new Error('cognitive_cli_executor_closed'));
    await Promise.allSettled([...this.active]);
  }
}
