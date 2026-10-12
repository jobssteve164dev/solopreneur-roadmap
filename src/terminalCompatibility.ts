import type { Terminal } from 'vscode';

const terminalInputQueues = new WeakMap<Terminal, Promise<boolean>>();

export function sendAgentTextWhenTerminalReady(terminal: Terminal, text: string, provider: string): Promise<boolean> {
  // Codex buffers raw text bursts, including Enter. An explicit paste clears that
  // suppression before the following submit key (Codex ChatComposer::handle_paste).
  if (provider === 'codex') return sendTextWhenTerminalReady(terminal, `\x1b[200~${text.replace(/\x1b/g, '\\u001b')}\x1b[201~\r`, false);
  return sendTextWhenTerminalReady(terminal, text);
}

async function waitForTerminalProcess(terminal: Terminal, timeoutMs: number): Promise<void> {
  const processId = terminal.processId;
  if (!processId || typeof processId.then !== 'function') return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    processId.then(() => undefined),
    new Promise<void>(resolve => {
      timeout = setTimeout(resolve, timeoutMs);
    })
  ]);
  if (timeout) clearTimeout(timeout);
}

async function deliverTerminalText(terminal: Terminal, text: string, addNewLine: boolean, readinessTimeoutMs: number): Promise<boolean> {
  try {
    await waitForTerminalProcess(terminal, readinessTimeoutMs);
    terminal.sendText(text, addNewLine);
    return true;
  } catch (error) {
    console.error('SoloMap could not deliver a command to the terminal:', error);
    return false;
  }
}

export function sendTextWhenTerminalReady(terminal: Terminal, text: string, addNewLine = true, readinessTimeoutMs = 5_000): Promise<boolean> {
  // Older test doubles and compatible hosts may not expose processId. Their
  // sendText implementation is already immediately available.
  if (!terminal.processId) {
    try {
      terminal.sendText(text, addNewLine);
      return Promise.resolve(true);
    } catch (error) {
      console.error('SoloMap could not deliver a command to the terminal:', error);
      return Promise.resolve(false);
    }
  }

  const previous = terminalInputQueues.get(terminal) || Promise.resolve(true);
  const pending = previous.then(() => deliverTerminalText(terminal, text, addNewLine, readinessTimeoutMs));
  terminalInputQueues.set(terminal, pending);
  void pending.then(() => {
    if (terminalInputQueues.get(terminal) === pending) {
      terminalInputQueues.delete(terminal);
    }
  });
  return pending;
}
