import * as fs from 'fs';
import * as path from 'path';

export interface CodexSessionLocatorInput {
  codexHome: string;
  workspaceRoot: string;
  bindingNonce: string;
  startedAt: string;
}

export interface CodexSessionLocatorResult {
  status: 'matched' | 'ambiguous' | 'not_found';
  sessionId: string;
  candidateSessionIds: string[];
  transcriptPath: string;
  providerCreatedAt?: string;
}

export interface CodexTurnCompletion {
  turnId: string;
  lastAgentMessage: string;
  completedAt: string;
}

export interface CodexTurnCompletionReadResult {
  completion: CodexTurnCompletion | null;
  nextOffset: number;
}

interface CodexSessionCandidate {
  sessionId: string;
  transcriptPath: string;
  providerCreatedAt: string;
}

function sessionDayRoots(codexHome: string, startedMs: number): string[] {
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

async function listTranscriptFiles(roots: string[], modifiedAfterMs = Number.NEGATIVE_INFINITY): Promise<string[]> {
  const files: string[] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const current = stack.pop() || '';
    try {
      const directory = await fs.promises.opendir(current);
      for await (const entry of directory) {
        const candidate = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(candidate);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(candidate);
      }
    } catch {
      continue;
    }
  }
  if (!Number.isFinite(modifiedAfterMs)) return files.sort();
  const recent = await Promise.all(files.map(async file => {
    const match = path.basename(file).match(/^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/);
    const namedAt = match ? Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`) : Number.NaN;
    if (Number.isFinite(namedAt)) return namedAt >= modifiedAfterMs ? file : '';
    try { return (await fs.promises.stat(file)).mtimeMs >= modifiedAfterMs ? file : ''; }
    catch { return ''; }
  }));
  return recent.filter(Boolean).sort();
}

function containsExactNonce(text: string, bindingNonce: string): boolean {
  const escaped = bindingNonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`).test(text);
}

function messageContainsExactNonce(row: any, bindingNonce: string): boolean {
  const contents = Array.isArray(row?.payload?.content) ? row.payload.content : [];
  return contents.some((item: any) => (
    item?.type === 'input_text'
    && containsExactNonce(String(item.text || ''), bindingNonce)
  ));
}

async function scanJsonLines(
  transcriptPath: string,
  startOffset: number,
  visit: (row: any) => boolean
): Promise<number> {
  const normalizedOffset = Math.max(0, Math.floor(startOffset));
  const stream = fs.createReadStream(transcriptPath, { start: normalizedOffset });
  let pending = Buffer.alloc(0);
  let consumedBytes = 0;
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      let newlineIndex = pending.indexOf(0x0a);
      while (newlineIndex >= 0) {
        const line = pending.subarray(0, newlineIndex).toString('utf8').trim();
        pending = pending.subarray(newlineIndex + 1);
        consumedBytes += newlineIndex + 1;
        if (line) {
          try {
            if (visit(JSON.parse(line))) {
              stream.destroy();
              return normalizedOffset + consumedBytes;
            }
          } catch {
            // A complete malformed row is ignored; a partial final row is retried from its byte offset.
          }
        }
        newlineIndex = pending.indexOf(0x0a);
      }
    }
    if (pending.length > 0) {
      const line = pending.toString('utf8').trim();
      if (line) {
        try {
          const row = JSON.parse(line);
          consumedBytes += pending.length;
          visit(row);
        } catch {
          // Keep an incomplete final JSON row outside the cursor so the next poll retries it.
        }
      } else {
        consumedBytes += pending.length;
      }
    }
  } finally {
    stream.destroy();
  }
  return normalizedOffset + consumedBytes;
}

async function inspectTranscript(
  transcriptPath: string,
  workspaceRoot: string,
  bindingNonce: string,
  startedMs: number
): Promise<CodexSessionCandidate | null> {
  let meta: any = null;
  let bodyOffset = 0;
  try {
    bodyOffset = await scanJsonLines(transcriptPath, 0, (row) => {
      if (row?.type !== 'session_meta') return false;
      meta = row;
      return true;
    });
  } catch {
    return null;
  }
  const payload = meta?.payload && typeof meta.payload === 'object' ? meta.payload : {};
  const id = String(payload.id || '').trim();
  const sessionId = String(payload.session_id || '').trim();
  const resolvedSessionId = id || sessionId;
  const recordedWorkspace = String(payload.cwd || '').trim();
  const createdAt = String(payload.timestamp || meta?.timestamp || '').trim();
  const createdMs = Date.parse(createdAt);
  if (
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F-]{27}$/.test(resolvedSessionId)
    || (id && sessionId && id !== sessionId)
    || !recordedWorkspace
    || path.resolve(recordedWorkspace) !== workspaceRoot
    || !Number.isFinite(createdMs)
    || createdMs < startedMs
  ) {
    return null;
  }
  let matches = false;
  try {
    await scanJsonLines(transcriptPath, bodyOffset, (row) => {
      if (row?.type !== 'response_item' || row?.payload?.type !== 'message') return false;
      if (row.payload.role === 'assistant') return true;
      if (row.payload.role === 'user' && messageContainsExactNonce(row, bindingNonce)) {
        matches = true;
        return true;
      }
      return false;
    });
  } catch {
    return null;
  }
  return matches ? {
    sessionId: resolvedSessionId,
    transcriptPath,
    providerCreatedAt: new Date(createdMs).toISOString()
  } : null;
}

export async function assertCodexResumeTranscript(transcriptPath: string, workspaceRoot: string, sessionId: string): Promise<void> {
  const stat = await fs.promises.stat(transcriptPath);
  if (!stat.isFile()) throw new Error('identity_transcript_unavailable');
  let meta: any = null;
  await scanJsonLines(transcriptPath, 0, row => {
    if (row?.type !== 'session_meta') return false;
    meta = row.payload;
    return true;
  });
  const id = String(meta?.id || '').trim(), alias = String(meta?.session_id || '').trim();
  const cwd = String(meta?.cwd || '').trim();
  if (!sessionId || (id || alias) !== sessionId || (id && alias && id !== alias) || !cwd || path.resolve(cwd) !== path.resolve(workspaceRoot)) {
    throw new Error('identity_transcript_mismatch');
  }
}

export async function locateCodexSessionByBindingNonce(input: CodexSessionLocatorInput): Promise<CodexSessionLocatorResult> {
  const codexHomeInput = String(input?.codexHome || '').trim();
  const workspaceInput = String(input?.workspaceRoot || '').trim();
  const bindingNonce = String(input?.bindingNonce || '').trim();
  const startedMs = Date.parse(String(input?.startedAt || ''));
  if (!codexHomeInput || !workspaceInput || bindingNonce.length < 32 || !Number.isFinite(startedMs)) {
    return { status: 'not_found', sessionId: '', candidateSessionIds: [], transcriptPath: '' };
  }
  const codexHome = path.resolve(codexHomeInput);
  const workspaceRoot = path.resolve(workspaceInput);
  const candidates = new Map<string, CodexSessionCandidate>();
  for (const transcriptPath of await listTranscriptFiles(sessionDayRoots(codexHome, startedMs), startedMs - 60_000)) {
    const candidate = await inspectTranscript(transcriptPath, workspaceRoot, bindingNonce, startedMs);
    if (candidate && !candidates.has(candidate.sessionId)) {
      candidates.set(candidate.sessionId, candidate);
    }
  }
  const candidateSessionIds = [...candidates.keys()].sort();
  if (candidateSessionIds.length === 1) {
    const candidate = candidates.get(candidateSessionIds[0]) as CodexSessionCandidate;
    return {
      status: 'matched',
      sessionId: candidate.sessionId,
      candidateSessionIds,
      transcriptPath: candidate.transcriptPath,
      providerCreatedAt: candidate.providerCreatedAt
    };
  }
  if (candidateSessionIds.length > 1) {
    return { status: 'ambiguous', sessionId: '', candidateSessionIds, transcriptPath: '' };
  }
  return { status: 'not_found', sessionId: '', candidateSessionIds: [], transcriptPath: '' };
}

function parseProviderTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  const numeric = Number(value);
  if (String(value || '').trim() && Number.isFinite(numeric)) {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  return Date.parse(String(value || ''));
}

export async function readCodexTurnCompletionSince(
  transcriptPath: string,
  turnStartedAt: string,
  startOffset: number
): Promise<CodexTurnCompletionReadResult> {
  const turnStartedMs = Date.parse(String(turnStartedAt || ''));
  let normalizedOffset = Number.isFinite(startOffset) ? Math.max(0, Math.floor(startOffset)) : 0;
  if (!transcriptPath || !Number.isFinite(turnStartedMs)) {
    return { completion: null, nextOffset: normalizedOffset };
  }
  try {
    const transcriptStat = await fs.promises.stat(transcriptPath);
    if (transcriptStat.size < normalizedOffset) {
      normalizedOffset = 0;
    }
  } catch {
    return { completion: null, nextOffset: normalizedOffset };
  }
  let completion: CodexTurnCompletion | null = null;
  let nextOffset = normalizedOffset;
  try {
    nextOffset = await scanJsonLines(transcriptPath, normalizedOffset, (row) => {
      const payload = row?.type === 'event_msg' && row?.payload?.type === 'task_complete'
        ? row.payload
        : null;
      if (!payload) return false;
      const providerStartedMs = parseProviderTimestamp(payload.started_at);
      const eventMs = parseProviderTimestamp(row.timestamp);
      const completedMs = parseProviderTimestamp(payload.completed_at);
      const observedAtMs = Number.isFinite(eventMs) ? eventMs : completedMs;
      if (
        (!Number.isFinite(providerStartedMs) || providerStartedMs < turnStartedMs)
        || !Number.isFinite(observedAtMs)
        || observedAtMs < turnStartedMs
      ) {
        return false;
      }
      const resolvedCompletedMs = Number.isFinite(completedMs) ? completedMs : observedAtMs;
      completion = {
        turnId: String(payload.turn_id || '').trim(),
        lastAgentMessage: String(payload.last_agent_message || '').trim(),
        completedAt: new Date(resolvedCompletedMs).toISOString()
      };
      return true;
    });
  } catch {
    return { completion: null, nextOffset: normalizedOffset };
  }
  return { completion, nextOffset };
}
