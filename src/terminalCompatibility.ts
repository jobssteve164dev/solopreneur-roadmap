import type { Terminal } from 'vscode';
import { performance } from 'node:perf_hooks';

const terminalInputQueues = new WeakMap<Terminal, Promise<boolean>>();

export interface TerminalDeliveryObservation {
  stage: 'terminal.queue.wait' | 'terminal.process.wait' | 'terminal.process.slow' | 'terminal.command.send';
  status: 'start' | 'ok' | 'error';
  durationMs: number;
  error?: string;
  pid?: number;
  timeoutMs?: number;
  budgetMs?: number;
}

export interface TerminalDeliveryOptions {
  readinessTimeoutMs?: number;
  readinessBudgetMs?: number;
  observe?: (event: TerminalDeliveryObservation) => void;
}

function observe(options: TerminalDeliveryOptions, event: TerminalDeliveryObservation): void {
  try { options.observe?.(event); }
  catch { /* Diagnostics cannot block terminal delivery. */ }
}

export function sendAgentTextWhenTerminalReady(terminal: Terminal, text: string, provider: string): Promise<boolean> {
  // Codex buffers raw text bursts, including Enter. An explicit paste clears that
  // suppression before the following submit key (Codex ChatComposer::handle_paste).
  if (provider === 'codex') return sendTextWhenTerminalReady(terminal, `\x1b[200~${text.replace(/\x1b/g, '\\u001b')}\x1b[201~\r`, false);
  return sendTextWhenTerminalReady(terminal, text);
}

async function waitForTerminalProcess(terminal: Terminal, options: TerminalDeliveryOptions): Promise<number | undefined> {
  const processId = terminal.processId;
  const started = performance.now();
  observe(options, { stage: 'terminal.process.wait', status: 'start', durationMs: 0, ...(options.readinessTimeoutMs ? { timeoutMs: options.readinessTimeoutMs } : {}) });
  if (!processId || typeof processId.then !== 'function') {
    observe(options, { stage: 'terminal.process.wait', status: 'ok', durationMs: performance.now() - started });
    return undefined;
  }
  let timer: NodeJS.Timeout | undefined;
  let budgetTimer: NodeJS.Timeout | undefined;
  try {
    if (options.readinessBudgetMs) {
      budgetTimer = setTimeout(() => observe(options, {
        stage: 'terminal.process.slow', status: 'error', durationMs: performance.now() - started,
        error: 'terminal_process_slow', budgetMs: options.readinessBudgetMs
      }), options.readinessBudgetMs);
      budgetTimer.unref?.();
    }
    const pid = await (options.readinessTimeoutMs
      ? Promise.race([
        processId,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('terminal_process_timeout')), options.readinessTimeoutMs); })
      ])
      : processId);
    if (!Number.isInteger(pid) || Number(pid) < 1) throw new Error('terminal_process_unavailable');
    observe(options, { stage: 'terminal.process.wait', status: 'ok', durationMs: performance.now() - started, pid: Number(pid), ...(options.readinessTimeoutMs ? { timeoutMs: options.readinessTimeoutMs } : {}) });
    return Number(pid);
  } catch (error) {
    observe(options, { stage: 'terminal.process.wait', status: 'error', durationMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error), ...(options.readinessTimeoutMs ? { timeoutMs: options.readinessTimeoutMs } : {}) });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (budgetTimer) clearTimeout(budgetTimer);
  }
}

async function deliverTerminalText(terminal: Terminal, text: string, addNewLine: boolean, options: TerminalDeliveryOptions): Promise<boolean> {
  try {
    await waitForTerminalProcess(terminal, options);
  } catch (error) {
    if (!options.observe) console.error('SoloMap could not wait for the terminal process:', error);
    return false;
  }
  const started = performance.now();
  observe(options, { stage: 'terminal.command.send', status: 'start', durationMs: 0 });
  try {
    terminal.sendText(text, addNewLine);
    observe(options, { stage: 'terminal.command.send', status: 'ok', durationMs: performance.now() - started });
    return true;
  } catch (error) {
    observe(options, { stage: 'terminal.command.send', status: 'error', durationMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error) });
    if (!options.observe) console.error('SoloMap could not deliver a command to the terminal:', error);
    return false;
  }
}

export function sendTextWhenTerminalReady(terminal: Terminal, text: string, addNewLine = true, options: TerminalDeliveryOptions = {}): Promise<boolean> {
  // Older test doubles and compatible hosts may not expose processId. Their
  // sendText implementation is already immediately available.
  if (!terminal.processId) {
    return deliverTerminalText(terminal, text, addNewLine, options);
  }

  const previous = terminalInputQueues.get(terminal);
  const queuedAt = performance.now();
  if (previous) observe(options, { stage: 'terminal.queue.wait', status: 'start', durationMs: 0 });
  const pending = (previous || Promise.resolve(true)).then(() => {
    if (previous) observe(options, { stage: 'terminal.queue.wait', status: 'ok', durationMs: performance.now() - queuedAt });
    return deliverTerminalText(terminal, text, addNewLine, options);
  });
  terminalInputQueues.set(terminal, pending);
  void pending.then(() => {
    if (terminalInputQueues.get(terminal) === pending) {
      terminalInputQueues.delete(terminal);
    }
  });
  return pending;
}
