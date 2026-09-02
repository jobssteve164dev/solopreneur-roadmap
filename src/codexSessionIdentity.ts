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

function listTranscriptFiles(roots: string[]): string[] {
  const files: string[] = [];
  const stack = roots.filter((root) => fs.existsSync(root));
  while (stack.length > 0) {
    const current = stack.pop() || '';
    let entries: fs.Dirent[] = [];
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
  return files.sort();
}

function containsExactNonce(text: string, bindingNonce: string): boolean {
  const escaped = bindingNonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`).test(text);
}

function inspectTranscript(
  transcriptPath: string,
  workspaceRoot: string,
  bindingNonce: string,
  startedMs: number
): CodexSessionCandidate | null {
  let rows: any[];
  try {
    rows = fs.readFileSync(transcriptPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return null;
  }
  const meta = rows.find((row) => row?.type === 'session_meta');
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
  const firstUserMessage = rows.find((row) => (
    row?.type === 'response_item'
    && row?.payload?.type === 'message'
    && row?.payload?.role === 'user'
  ));
  const contents = Array.isArray(firstUserMessage?.payload?.content) ? firstUserMessage.payload.content : [];
  const matches = contents.some((item: any) => (
    item?.type === 'input_text'
    && containsExactNonce(String(item.text || ''), bindingNonce)
  ));
  return matches ? {
    sessionId: resolvedSessionId,
    transcriptPath,
    providerCreatedAt: new Date(createdMs).toISOString()
  } : null;
}

export function locateCodexSessionByBindingNonce(input: CodexSessionLocatorInput): CodexSessionLocatorResult {
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
  for (const transcriptPath of listTranscriptFiles(sessionDayRoots(codexHome, startedMs))) {
    const candidate = inspectTranscript(transcriptPath, workspaceRoot, bindingNonce, startedMs);
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
