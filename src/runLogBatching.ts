export interface RunLogCaptureOptions {
  append: (bytes: Buffer) => Promise<void>;
  forward: (bytes: Buffer) => Promise<void>;
  maxBytes?: number;
  maxDelayMs?: number | (() => number);
  onDidChangeMaxDelay?: (listener: () => void) => () => void;
}

export const runLogBatchMaxBytes = 256 * 1024;
export const runLogBatchMaxDelayMs = 500;
export const responsiveRunLogBatchMaxDelayMs = 32;

type TimedNext<T> = { kind: 'next'; result: IteratorResult<T> } | { kind: 'timeout' } | { kind: 'reschedule' };

async function nextBefore<T>(next: Promise<IteratorResult<T>>, delayMs: number, onDidChangeDelay?: (listener: () => void) => () => void): Promise<TimedNext<T>> {
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    return await Promise.race([
      next.then(result => ({ kind: 'next', result }) as const),
      new Promise<{ kind: 'timeout' }>(resolve => { timer = setTimeout(() => resolve({ kind: 'timeout' }), delayMs); }),
      ...(onDidChangeDelay ? [new Promise<{ kind: 'reschedule' }>(resolve => {
        unsubscribe = onDidChangeDelay(() => resolve({ kind: 'reschedule' }));
      })] : [])
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe?.();
  }
}

export async function captureRunLog(stream: AsyncIterable<unknown>, options: RunLogCaptureOptions): Promise<void> {
  const maxBytes = options.maxBytes ?? runLogBatchMaxBytes;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('run_log_batch_max_bytes_invalid');
  const maxDelayMs = () => {
    const value = typeof options.maxDelayMs === 'function' ? options.maxDelayMs() : options.maxDelayMs ?? runLogBatchMaxDelayMs;
    if (!Number.isInteger(value) || value < 1) throw new Error('run_log_batch_max_delay_invalid');
    return value;
  };
  if (typeof options.maxDelayMs !== 'function') maxDelayMs();

  const iterator = stream[Symbol.asyncIterator]();
  let next = iterator.next();
  let completed = false;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let deadline = 0;
  const flush = async (): Promise<void> => {
    if (!pendingBytes) return;
    const bytes = Buffer.concat(pending, pendingBytes);
    await options.append(bytes);
    await options.forward(bytes);
    pending = [];
    pendingBytes = 0;
    deadline = 0;
  };

  try {
    for (;;) {
      const item = pendingBytes
        ? await nextBefore(next, Math.max(0, deadline - Date.now()), options.onDidChangeMaxDelay)
        : { kind: 'next' as const, result: await next };
      if (item.kind === 'reschedule') {
        deadline = Math.min(deadline, Date.now() + maxDelayMs());
        continue;
      }
      if (item.kind === 'timeout') {
        await flush();
        continue;
      }
      if (item.result.done) {
        await flush();
        completed = true;
        return;
      }
      next = iterator.next();
      const bytes = Buffer.isBuffer(item.result.value) ? item.result.value : Buffer.from(item.result.value as Uint8Array);
      if (pendingBytes && pendingBytes + bytes.length > maxBytes) await flush();
      const nextDeadline = Date.now() + maxDelayMs();
      deadline = pendingBytes ? Math.min(deadline, nextDeadline) : nextDeadline;
      pending.push(bytes);
      pendingBytes += bytes.length;
      if (pendingBytes >= maxBytes) await flush();
    }
  } finally {
    if (!completed) {
      void next.catch(() => undefined);
      try { void iterator.return?.().catch(() => undefined); } catch { /* Preserve the capture failure. */ }
    }
  }
}
