export interface RunLogCaptureOptions {
  append: (bytes: Buffer) => Promise<void>;
  forward: (bytes: Buffer) => Promise<void>;
  maxBytes?: number;
  maxDelayMs?: number;
}

export const runLogBatchMaxBytes = 256 * 1024;
export const runLogBatchMaxDelayMs = 500;

type TimedNext<T> = { kind: 'next'; result: IteratorResult<T> } | { kind: 'timeout' };

async function nextBefore<T>(next: Promise<IteratorResult<T>>, delayMs: number): Promise<TimedNext<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      next.then(result => ({ kind: 'next', result }) as const),
      new Promise<{ kind: 'timeout' }>(resolve => { timer = setTimeout(() => resolve({ kind: 'timeout' }), delayMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function captureRunLog(stream: AsyncIterable<unknown>, options: RunLogCaptureOptions): Promise<void> {
  const maxBytes = options.maxBytes ?? runLogBatchMaxBytes;
  const maxDelayMs = options.maxDelayMs ?? runLogBatchMaxDelayMs;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('run_log_batch_max_bytes_invalid');
  if (!Number.isInteger(maxDelayMs) || maxDelayMs < 1) throw new Error('run_log_batch_max_delay_invalid');

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
        ? await nextBefore(next, Math.max(0, deadline - Date.now()))
        : { kind: 'next' as const, result: await next };
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
      if (!pendingBytes) deadline = Date.now() + maxDelayMs;
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
