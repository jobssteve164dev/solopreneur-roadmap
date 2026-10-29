export type RuntimePriority = 0 | 1 | 2;

interface ScheduledWork<T> {
  sequence: number;
  action: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function runtimeOperationPriority(operation: string): RuntimePriority {
  if (/^(?:start_conversation|query_conversation|prepare_(?:run|flow)|read_run_(?:execution_plan|state|checkpoint_state|launch_permission|binding|intent)|claim_run(?:_delivery)?|patch_run(?:_state|_inputs|_turn_request)?|checkpoint_run|checkpoint_current_run|stop_run|release_run_delivery|write_run_binding|materialize_run_prompt|finalize_run_output|observe_run_task_ingress|record_claude_native_(?:ready|append|event)|prepare_agent_database)$/.test(operation)) return 0;
  if (/^(?:append_(?:run_log|diagnostic_event)|write_project_growth|refresh_project_growth|(?:preview|apply)_growth_snapshot_detail_cleanup|upsert_project_run_index|write_documentation|capture_)/.test(operation)) return 2;
  return 1;
}

export class RuntimePriorityScheduler {
  private readonly queues: [Array<ScheduledWork<unknown>>, Array<ScheduledWork<unknown>>, Array<ScheduledWork<unknown>>] = [[], [], []];
  private sequence = 0;
  private scheduled = false;

  submit<T>(priority: RuntimePriority, action: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queues[priority].push({ sequence: ++this.sequence, action, resolve, reject } as ScheduledWork<unknown>);
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.drainOne();
    });
  }

  private drainOne(): void {
    const work = this.queues[0].shift() || this.queues[1].shift() || this.queues[2].shift();
    if (!work) return;
    let result: Promise<unknown>;
    try { result = work.action(); }
    catch (error) { work.reject(error); result = Promise.resolve(); }
    void result.then(work.resolve, work.reject);
    if (this.queues.some(queue => queue.length)) setImmediate(() => this.schedule());
  }
}
