#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

function sessionDayRoots(codexHome, startedMs) {
  return [-1, 0, 1].map((dayOffset) => {
    const date = new Date(startedMs + dayOffset * 24 * 60 * 60 * 1000);
    return path.join(
      codexHome,
      'sessions',
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0')
    );
  });
}

function transcriptFiles(roots) {
  const files = [];
  const stack = roots.filter((root) => fs.existsSync(root));
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(candidate);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(candidate);
    }
  }
  return files;
}

function userMessageContainsBinding(payload, bindingMarker, promptFilePath) {
  const expectedPromptInstruction = promptFilePath
    ? `Read the complete SoloMap task prompt from ${promptFilePath} and follow that file exactly. The user request inside the file is the highest priority. Stay in this interactive session after completing the current turn.`
    : '';
  return payload?.type === 'message'
    && payload?.role === 'user'
    && Array.isArray(payload.content)
    && payload.content.some((item) => {
      const text = item?.type === 'input_text' ? String(item.text || '') : '';
      if (bindingMarker) {
        const escapedMarker = bindingMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^A-Za-z0-9_])${escapedMarker}(?=$|[^A-Za-z0-9_])`).test(text);
      }
      return Boolean(expectedPromptInstruction && text.includes(expectedPromptInstruction));
    });
}

async function inspectTranscript(filePath, workspaceRoot, bindingMarker, promptFilePath, startedMs) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let sessionId = '';
  let eligible = false;
  let matchedPrompt = false;
  try {
    for await (const line of lines) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = row && typeof row.payload === 'object' && row.payload ? row.payload : {};
      if (!sessionId && row.type === 'session_meta') {
        const metaId = String(payload.id || '').trim();
        const metaSessionId = String(payload.session_id || '').trim();
        const recordedWorkspace = String(payload.cwd || '').trim();
        const timestampMs = Date.parse(String(payload.timestamp || row.timestamp || ''));
        if (metaId && metaSessionId && metaId !== metaSessionId) break;
        sessionId = metaId || metaSessionId;
        eligible = Boolean(
          sessionId
          && recordedWorkspace
          && path.resolve(recordedWorkspace) === workspaceRoot
          && Number.isFinite(timestampMs)
          && timestampMs >= startedMs
        );
        if (!eligible) break;
      } else if (eligible && row.type === 'response_item' && userMessageContainsBinding(payload, bindingMarker, promptFilePath)) {
        matchedPrompt = true;
        break;
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return eligible && matchedPrompt ? sessionId : '';
}

export async function locateCodexSessionForRun(input) {
  const codexHomeInput = String(input?.codexHome || '').trim();
  const workspaceInput = String(input?.workspaceRoot || '').trim();
  const codexHome = path.resolve(codexHomeInput);
  const workspaceRoot = path.resolve(workspaceInput);
  const bindingMarker = String(input?.bindingMarker || '').trim();
  const promptFileInput = String(input?.promptFilePath || '').trim();
  const promptFilePath = promptFileInput
    ? path.resolve(promptFileInput)
    : '';
  const startedMs = Date.parse(String(input?.startedAt || ''));
  if (!codexHomeInput || !workspaceInput || !Number.isFinite(startedMs)) {
    throw new Error('codexHome, workspaceRoot, and a valid startedAt are required');
  }
  if (Boolean(bindingMarker) === Boolean(promptFilePath)) {
    throw new Error('exactly one of bindingMarker or promptFilePath is required');
  }

  const candidateSessionIds = [];
  for (const filePath of transcriptFiles(sessionDayRoots(codexHome, startedMs))) {
    let sessionId = '';
    try {
      sessionId = await inspectTranscript(filePath, workspaceRoot, bindingMarker, promptFilePath, startedMs);
    } catch {
      continue;
    }
    if (sessionId && !candidateSessionIds.includes(sessionId)) candidateSessionIds.push(sessionId);
  }
  candidateSessionIds.sort();
  if (candidateSessionIds.length === 1) {
    return { status: 'matched', sessionId: candidateSessionIds[0], candidateSessionIds };
  }
  if (candidateSessionIds.length > 1) {
    return { status: 'ambiguous', sessionId: '', candidateSessionIds };
  }
  return { status: 'not_found', sessionId: '', candidateSessionIds: [] };
}

function readCliArguments(argv) {
  const values = {};
  const allowed = new Set(['codex-home', 'workspace', 'prompt', 'marker', 'started-at']);
  for (let index = 0; index < argv.length; index += 2) {
    const argument = String(argv[index] || '');
    const key = argument.replace(/^--/, '');
    const value = argv[index + 1];
    if (!argument.startsWith('--') || !allowed.has(key) || value === undefined) {
      throw new Error(`invalid CLI argument: ${argument || '(empty)'}`);
    }
    values[key] = value;
  }
  return {
    codexHome: values['codex-home'],
    workspaceRoot: values.workspace,
    promptFilePath: values.prompt,
    bindingMarker: values.marker,
    startedAt: values['started-at']
  };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  try {
    const result = await locateCodexSessionForRun(readCliArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.status === 'matched' ? 0 : result.status === 'ambiguous' ? 3 : 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
