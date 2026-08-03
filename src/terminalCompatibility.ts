import type { Terminal } from 'vscode';

const terminalInputQueues = new WeakMap<Terminal, Promise<boolean>>();

async function deliverTerminalText(terminal: Terminal, text: string, addNewLine: boolean): Promise<boolean> {
  try {
    const processId = terminal.processId;
    if (processId && typeof processId.then === 'function') {
      await processId;
    }
    terminal.sendText(text, addNewLine);
    return true;
  } catch (error) {
    console.error('SoloMap could not deliver a command to the terminal:', error);
    return false;
  }
}

export function sendTextWhenTerminalReady(terminal: Terminal, text: string, addNewLine = true): Promise<boolean> {
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
  const pending = previous.then(() => deliverTerminalText(terminal, text, addNewLine));
  terminalInputQueues.set(terminal, pending);
  void pending.then(() => {
    if (terminalInputQueues.get(terminal) === pending) {
      terminalInputQueues.delete(terminal);
    }
  });
  return pending;
}
