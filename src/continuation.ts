import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentConversation } from './db/types';

export interface AgentStepSession {
  agentCli: string;
  provider: string;
  sessionId: string;
  updatedAt: string;
}

export interface StepSessionState {
  version: number;
  nodeId: string;
  sessions: Record<string, AgentStepSession>;
}

interface CodexRunSessionIndexEntry {
  sessionId: string;
  timestampMs: number;
}

const codexRunSessionIndexCache = new Map<string, {
  expiresAt: number;
  entries: Map<string, CodexRunSessionIndexEntry>;
}>();

export type ContinuableAgentConversation = AgentConversation & {
  resumableNativeSessionId?: string;
  continuationRootConversationId?: number;
};

export function getContinuationAgentProvider(agentCli: string): string {
  const executableName = path.basename(agentCli).toLowerCase();
  if (executableName === 'codex' || executableName === 'codex-cli') {
    return 'codex';
  }
  if (executableName === 'cursor' || executableName === 'cursor-cli' || executableName === 'cursor-agent') {
    return 'cursor';
  }
  if (executableName === 'claude' || executableName === 'claude-code' || executableName === 'claude-code-cli') {
    return 'claude';
  }
  if (executableName === 'opencode' || executableName === 'open-code' || executableName === 'open-code-cli') {
    return 'opencode';
  }
  if (executableName === 'copilot' || executableName === 'copilot-cli') {
    return 'copilot';
  }
  if (executableName === 'grok') {
    return 'grok';
  }
  if (executableName === 'agy' || executableName === 'antigravity' || executableName === 'antigravity-cli') {
    return 'antigravity';
  }
  return executableName || 'unknown';
}

export function getAgentSessionKey(agentCli: string): string {
  return getContinuationAgentProvider(agentCli);
}

export function getStepSessionFilePath(workspaceRoot: string, nodeId: string): string {
  return path.join(workspaceRoot, '.solopreneur', 'step-sessions', `${nodeId}.json`);
}

export function readStepSessionState(filePath: string, nodeId: string): StepSessionState {
  const emptyState: StepSessionState = {
    version: 1,
    nodeId,
    sessions: {}
  };
  if (!filePath || !fs.existsSync(filePath)) {
    return emptyState;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const sessions = parsed && typeof parsed.sessions === 'object' && parsed.sessions ? parsed.sessions : {};
    return {
      version: 1,
      nodeId: String(parsed.nodeId || nodeId),
      sessions
    };
  } catch {
    return emptyState;
  }
}

export function getStoredAgentSession(workspaceRoot: string, nodeId: string, agentCli: string): AgentStepSession | null {
  const filePath = getStepSessionFilePath(workspaceRoot, nodeId);
  const state = readStepSessionState(filePath, nodeId);
  const session = state.sessions[getAgentSessionKey(agentCli)];
  return session && session.sessionId ? session : null;
}

export function updateStoredAgentSession(workspaceRoot: string, nodeId: string, agentCli: string, sessionId: string): StepSessionState {
  const filePath = getStepSessionFilePath(workspaceRoot, nodeId);
  const state = readStepSessionState(filePath, nodeId);
  const sessionKey = getAgentSessionKey(agentCli);
  state.version = 1;
  state.nodeId = nodeId;
  state.sessions[sessionKey] = {
    agentCli,
    provider: getContinuationAgentProvider(agentCli),
    sessionId,
    updatedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

export function clearStoredAgentSession(workspaceRoot: string, nodeId: string, agentCli: string): boolean {
  const filePath = getStepSessionFilePath(workspaceRoot, nodeId);
  const state = readStepSessionState(filePath, nodeId);
  const sessionKey = getAgentSessionKey(agentCli);
  if (!state.sessions[sessionKey]) {
    return false;
  }
  delete state.sessions[sessionKey];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
  return true;
}

export function stripAnsiControlCodes(text: string): string {
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
}

export function extractCodexSessionIdFromOutputText(output: string): string {
  const lines = stripAnsiControlCodes(output).split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*session id:\s*([0-9a-fA-F-]{36})\s*$/i);
    if (match) {
      return match[1];
    }
  }
  return '';
}

export function extractSavedNativeSessionIdFromExecutionOutput(output: string): string {
  const text = String(output || '');
  const match = text.match(/Native Agent session saved:[^\n]*\(([A-Za-z0-9_.:-]+)\)/);
  return match ? match[1] : '';
}

export function extractContinuationSessionIdFromExecutionOutput(output: string): string {
  const match = String(output || '').match(/Continuation session id:\s*([A-Za-z0-9_.:-]+)/);
  return match ? match[1] : '';
}

export function extractNativeSessionIdFromExecutionOutput(output: string): string {
  return extractSavedNativeSessionIdFromExecutionOutput(output)
    || extractContinuationSessionIdFromExecutionOutput(output);
}

export function extractNativeSessionIdFromConversation(conversation: AgentConversation | null): string {
  if (!conversation) {
    return '';
  }
  const outputSessionId = extractNativeSessionIdFromExecutionOutput(conversation.output || '');
  if (outputSessionId) {
    return outputSessionId;
  }
  const command = String(conversation.command || '');
  const optionMatch = command.match(/\b(?:--resume|--conversation|--session|-s|--connect)(?:=|\s+)['"]?([A-Za-z0-9_][A-Za-z0-9_.:-]*)['"]?/);
  if (optionMatch) {
    return optionMatch[1];
  }
  const resumeCommandMatch = command.match(/\bresume\b[\s\S]*?['"]?([A-Za-z0-9_][A-Za-z0-9_.:-]*)['"]?\s*$/);
  return resumeCommandMatch ? resumeCommandMatch[1] : '';
}

export function extractContinuationParentConversationId(output: string): number {
  const match = String(output || '').match(/Continuation parent conversation:\s*(\d+)/);
  return match ? Number(match[1]) : 0;
}

const codexTranscriptFilesCache = new Map<string, { expiresAt: number; files: string[] }>();

export function findCodexTranscriptFile(codexHome: string, sessionId: string): string {
  const normalizedHome = String(codexHome || '').trim();
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedHome || !normalizedSessionId) {
    return '';
  }
  const cacheKey = path.resolve(normalizedHome);
  let cached = codexTranscriptFilesCache.get(cacheKey);
  const reusedCachedIndex = Boolean(cached && cached.expiresAt > Date.now());
  if (!cached || cached.expiresAt <= Date.now()) {
    const roots = [
      path.join(normalizedHome, 'sessions'),
      path.join(normalizedHome, 'archived_sessions')
    ];
    const stack = roots.filter((candidate) => fs.existsSync(candidate));
    const files: string[] = [];
    while (stack.length > 0) {
      const current = stack.pop() || '';
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          files.push(fullPath);
        }
      }
    }
    cached = { expiresAt: Date.now() + 30 * 1000, files };
    codexTranscriptFilesCache.set(cacheKey, cached);
  }
  const candidateFiles = cached.files.filter((candidate) => path.basename(candidate).includes(normalizedSessionId));
  if (candidateFiles.length === 0 && reusedCachedIndex) {
    codexTranscriptFilesCache.delete(cacheKey);
    return findCodexTranscriptFile(normalizedHome, normalizedSessionId);
  }
  for (const fullPath of candidateFiles) {
    let descriptor = -1;
    try {
      descriptor = fs.openSync(fullPath, 'r');
      const prefixBuffer = Buffer.alloc(16 * 1024);
      const bytesRead = fs.readSync(descriptor, prefixBuffer, 0, prefixBuffer.length, 0);
      const firstLine = prefixBuffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/).find(Boolean) || '';
      const parsed = JSON.parse(firstLine);
      if (String(parsed?.payload?.id || '') === normalizedSessionId) {
        return fullPath;
      }
    } catch {
      // Ignore malformed or partially-written transcript files.
    } finally {
      if (descriptor >= 0) {
        try { fs.closeSync(descriptor); } catch {}
      }
    }
  }
  return '';
}

export function findCodexSessionIdForRun(
  codexHome: string,
  workspaceRoot: string,
  promptFilePath: string,
  startedAt: string
): string {
  const normalizedHome = String(codexHome || '').trim();
  const normalizedWorkspace = String(workspaceRoot || '').trim();
  const normalizedPrompt = String(promptFilePath || '').trim();
  const startedMs = Date.parse(String(startedAt || ''));
  if (
    !normalizedHome
    || !normalizedWorkspace
    || !normalizedPrompt
    || !fs.existsSync(normalizedPrompt)
    || !Number.isFinite(startedMs)
  ) {
    return '';
  }
  const startedDate = new Date(startedMs);
  const dateKey = startedDate.toISOString().slice(0, 10);
  const cacheKey = `${path.resolve(normalizedHome)}\0${path.resolve(normalizedWorkspace)}\0${dateKey}`;
  const cached = codexRunSessionIndexCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    const match = cached.entries.get(path.resolve(normalizedPrompt));
    if (match) {
      return match.timestampMs >= startedMs ? match.sessionId : '';
    }
    codexRunSessionIndexCache.delete(cacheKey);
  }
  const roots = [-1, 0, 1].map((dayOffset) => {
    const candidateDate = new Date(startedMs + dayOffset * 24 * 60 * 60 * 1000);
    return path.join(
      normalizedHome,
      'sessions',
      String(candidateDate.getUTCFullYear()),
      String(candidateDate.getUTCMonth() + 1).padStart(2, '0'),
      String(candidateDate.getUTCDate()).padStart(2, '0')
    );
  });
  const stack = roots.filter((candidate) => fs.existsSync(candidate));
  const indexedEntries = new Map<string, CodexRunSessionIndexEntry>();
  while (stack.length > 0) {
    const current = stack.pop() || '';
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      let descriptor = -1;
      try {
        descriptor = fs.openSync(fullPath, 'r');
        const prefixBuffer = Buffer.alloc(160 * 1024);
        const bytesRead = fs.readSync(descriptor, prefixBuffer, 0, prefixBuffer.length, 0);
        const contentPrefix = prefixBuffer.subarray(0, bytesRead).toString('utf8');
        const firstLine = contentPrefix.split(/\r?\n/).find(Boolean) || '';
        const parsed = JSON.parse(firstLine);
        const payload = parsed?.payload || {};
        const sessionId = String(payload.id || payload.session_id || '').trim();
        const cwd = String(payload.cwd || '').trim();
        const timestampMs = Date.parse(String(parsed.timestamp || payload.timestamp || ''));
        if (!sessionId || !cwd || path.resolve(cwd) !== path.resolve(normalizedWorkspace) || !Number.isFinite(timestampMs)) {
          continue;
        }
        const promptMatch = contentPrefix.match(/Read the complete SoloMap task prompt from ([^"\r\n]+?\/prompt\.txt) and follow/);
        const indexedPrompt = String(promptMatch?.[1] || '').trim();
        if (indexedPrompt) {
          const promptKey = path.resolve(indexedPrompt);
          const previous = indexedEntries.get(promptKey);
          if (!previous || timestampMs < previous.timestampMs) {
            indexedEntries.set(promptKey, { sessionId, timestampMs });
          }
        }
      } catch {
        // Ignore malformed or partially-written transcript files.
      } finally {
        if (descriptor >= 0) {
          try { fs.closeSync(descriptor); } catch {}
        }
      }
    }
  }
  const match = indexedEntries.get(path.resolve(normalizedPrompt));
  const recentlyStarted = Date.now() - startedMs < 5 * 60 * 1000;
  codexRunSessionIndexCache.set(cacheKey, {
    expiresAt: Date.now() + (!match && recentlyStarted ? 1000 : 30 * 1000),
    entries: indexedEntries
  });
  return match && match.timestampMs >= startedMs ? match.sessionId : '';
}

export function extractFirstCodexUserMessageAfter(codexHome: string, sessionId: string, startedAt: string): string {
  const transcriptFile = findCodexTranscriptFile(codexHome, sessionId);
  if (!transcriptFile) {
    return '';
  }
  const startedMs = Date.parse(String(startedAt || ''));
  try {
    const lines = fs.readFileSync(transcriptFile, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = parsed?.payload || {};
      if (String(payload.type || '') !== 'user_message') {
        continue;
      }
      const timestampMs = Date.parse(String(parsed.timestamp || ''));
      if (Number.isFinite(startedMs) && Number.isFinite(timestampMs) && timestampMs < startedMs) {
        continue;
      }
      const message = String(payload.message || '').trim();
      if (message) {
        return message;
      }
    }
  } catch {
    return '';
  }
  return '';
}

export function getConversationRunDir(workspaceRoot: string, nodeId: string, conversationId: number): string {
  return path.join(workspaceRoot, '.solopreneur', 'agent-runs', nodeId, String(conversationId || ''));
}

export function readRunTextFile(workspaceRoot: string, nodeId: string, conversationId: number, fileName: string, includeLegacyNodeRun = false): string {
  const candidates = [path.join(getConversationRunDir(workspaceRoot, nodeId, conversationId), fileName)];
  if (includeLegacyNodeRun) {
    candidates.push(path.join(workspaceRoot, '.solopreneur', 'agent-runs', nodeId, fileName));
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, 'utf8');
      }
    } catch {
      // Ignore stale or partially-written run files.
    }
  }
  return '';
}

export function readRunSessionId(workspaceRoot: string, nodeId: string, conversationId: number): string {
  const sessionText = readRunTextFile(workspaceRoot, nodeId, conversationId, 'session.json');
  if (!sessionText) {
    return '';
  }
  try {
    const parsed = JSON.parse(sessionText);
    return String(parsed?.sessionId || '').trim();
  } catch {
    return '';
  }
}

export function recoverInterruptedNativeSessionId(
  workspaceRoot: string,
  nodeId: string,
  conversation: AgentConversation | null
): string {
  if (!conversation || !workspaceRoot) {
    return '';
  }
  const conversationId = Number(conversation.id || 0);
  const runSessionId = readRunSessionId(workspaceRoot, nodeId, conversationId);
  if (runSessionId) {
    return runSessionId;
  }
  if (getContinuationAgentProvider(conversation.agentCli || '') === 'codex') {
    return extractCodexSessionIdFromOutputText(
      readRunTextFile(workspaceRoot, nodeId, conversationId, 'output.log')
    );
  }
  return '';
}

export function resolveContinuationLeafConversationFromList(
  conversations: AgentConversation[],
  conversationId: number
): AgentConversation | null {
  if (!conversationId) {
    return null;
  }
  const byParent = new Map<number, AgentConversation[]>();
  for (const conversation of conversations) {
    const parentId = extractContinuationParentConversationId(conversation.output || '');
    if (!parentId) continue;
    const siblings = byParent.get(parentId) || [];
    siblings.push(conversation);
    byParent.set(parentId, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
  }
  let current = conversations.find((entry) => Number(entry.id) === Number(conversationId)) || null;
  while (current) {
    const children = byParent.get(Number(current.id || 0)) || [];
    if (!children.length) {
      return current;
    }
    current = children[children.length - 1] || null;
  }
  return null;
}

export function resolveContinuationSessionConversationFromList(
  conversations: AgentConversation[],
  conversationId: number
): AgentConversation | null {
  if (!conversationId) {
    return null;
  }
  const byId = new Map<number, AgentConversation>();
  conversations.forEach((conversation) => byId.set(Number(conversation.id || 0), conversation));
  const start = byId.get(Number(conversationId));
  const leaf = resolveContinuationLeafConversationFromList(conversations, conversationId);
  const candidates: AgentConversation[] = [];
  const pushLineage = (conversation: AgentConversation | null) => {
    let current = conversation;
    const seen = new Set<number>();
    while (current) {
      const currentId = Number(current.id || 0);
      if (!currentId || seen.has(currentId)) {
        return;
      }
      seen.add(currentId);
      candidates.push(current);
      const parentId = extractContinuationParentConversationId(current.output || '');
      current = parentId ? byId.get(Number(parentId)) || null : null;
    }
  };
  pushLineage(leaf);
  pushLineage(start || null);
  return candidates.find((conversation) => extractSavedNativeSessionIdFromExecutionOutput(conversation.output || ''))
    || candidates.find((conversation) => extractNativeSessionIdFromExecutionOutput(conversation.output || ''))
    || null;
}

export function resolveContinuationRootConversationFromList(conversations: AgentConversation[], conversationId: number): AgentConversation | null {
  const byId = new Map<number, AgentConversation>();
  conversations.forEach((conversation) => byId.set(Number(conversation.id || 0), conversation));
  const start = byId.get(Number(conversationId));
  if (!start) {
    return null;
  }
  let current = start;
  const seen = new Set<number>();
  let followedParent = false;
  let declaredParent = false;
  while (current) {
    const currentId = Number(current.id || 0);
    if (seen.has(currentId)) {
      return current;
    }
    seen.add(currentId);
    const parentId = extractContinuationParentConversationId(current.output || '');
    declaredParent = declaredParent || Boolean(parentId);
    const parent = parentId ? byId.get(Number(parentId)) : null;
    if (!parent) {
      break;
    }
    followedParent = true;
    current = parent;
  }
  if (followedParent) {
    return current || start;
  }
  if (declaredParent) {
    return start;
  }
  const sessionId = extractNativeSessionIdFromConversation(start);
  if (sessionId) {
    return conversations
      .filter((conversation) => extractNativeSessionIdFromConversation(conversation) === sessionId)
      .sort((a, b) => Number(a.id || 0) - Number(b.id || 0))[0] || start;
  }
  return start;
}

function shouldRecoverCodexRunSessionIdentity(conversation: AgentConversation): boolean {
  if (getContinuationAgentProvider(conversation.agentCli || '') !== 'codex') {
    return false;
  }
  const output = String(conversation.output || '');
  const hasInteractiveRunEvidence = /Interactive session (?:root|state):|Starting a new native\s+\S+\s+session\./i.test(output)
    || /--no-alt-screen\b/.test(String(conversation.command || ''));
  if (!hasInteractiveRunEvidence) {
    return false;
  }
  const savedSessionId = extractSavedNativeSessionIdFromExecutionOutput(output);
  const hasUnverifiedBareSessionMarker = /Native Agent session saved:\s*[A-Za-z0-9_.:-]+\s*(?:\r?\n|$)/.test(output);
  return !savedSessionId || hasUnverifiedBareSessionMarker;
}

export function resolveNativeSessionIdForConversation(workspaceRoot: string, nodeId: string, conversation: AgentConversation | null): string {
  if (!conversation) {
    return '';
  }
  const savedSessionId = extractSavedNativeSessionIdFromExecutionOutput(conversation.output || '');
  const continuationSessionId = extractContinuationSessionIdFromExecutionOutput(conversation.output || '');
  const commandSessionId = extractNativeSessionIdFromConversation(conversation);
  const conversationId = Number(conversation.id || 0);
  const runSessionId = workspaceRoot ? readRunSessionId(workspaceRoot, nodeId, conversationId) : '';
  if (getContinuationAgentProvider(conversation.agentCli || '') !== 'codex' || !workspaceRoot) {
    return runSessionId || savedSessionId || continuationSessionId || commandSessionId;
  }
  const recordedCodexHome = readRunTextFile(workspaceRoot, nodeId, conversationId, 'codex-home.txt').trim();
  const codexHome = recordedCodexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const runDir = getConversationRunDir(workspaceRoot, nodeId, conversationId);
  const promptFilePath = path.join(runDir, 'prompt.txt');
  const runStartedAtMatch = String(conversation.output || '').match(/Run started at:\s*([^\n]+)/);
  let runStartedAt = String(runStartedAtMatch?.[1] || conversation.timestamp || '').trim();
  try {
    const startedAtPath = path.join(runDir, 'started_at');
    if (fs.existsSync(startedAtPath)) {
      runStartedAt = fs.statSync(startedAtPath).mtime.toISOString();
    }
  } catch {
    // Fall back to the persisted conversation start time.
  }
  if (shouldRecoverCodexRunSessionIdentity(conversation)) {
    const liveRunSessionId = findCodexSessionIdForRun(
      codexHome,
      workspaceRoot,
      promptFilePath,
      runStartedAt
    );
    if (liveRunSessionId) {
      return liveRunSessionId;
    }
  }
  const outputText = readRunTextFile(workspaceRoot, nodeId, conversationId, 'output.log');
  const outputSessionId = extractCodexSessionIdFromOutputText(outputText);
  const candidates = [runSessionId, outputSessionId, savedSessionId, continuationSessionId, commandSessionId]
    .map((sessionId) => String(sessionId || '').trim())
    .filter(Boolean)
    .filter((sessionId, index, all) => all.indexOf(sessionId) === index);
  for (const sessionId of candidates) {
    if (findCodexTranscriptFile(codexHome, sessionId)) {
      return sessionId;
    }
  }
  return '';
}

export function hydrateConversationContinuations(
  workspaceRoot: string,
  nodeId: string,
  conversations: AgentConversation[],
  options: { validateCodexTranscript?: boolean; recoverRunSessionIdentity?: boolean } = {}
): ContinuableAgentConversation[] {
  return conversations.map((conversation) => {
    const rootConversation = resolveContinuationRootConversationFromList(conversations, Number(conversation.id || 0)) || conversation;
    const sessionConversation = resolveContinuationSessionConversationFromList(conversations, Number(conversation.id || 0)) || conversation;
    const shouldResolveDirectSession = options.validateCodexTranscript !== false
      || (options.recoverRunSessionIdentity === true && shouldRecoverCodexRunSessionIdentity(conversation));
    const directSessionId = shouldResolveDirectSession
      ? resolveNativeSessionIdForConversation(workspaceRoot, nodeId, conversation)
      : extractNativeSessionIdFromConversation(conversation);
    const sessionId = directSessionId || (options.validateCodexTranscript === false
      ? extractNativeSessionIdFromConversation(sessionConversation)
      : resolveNativeSessionIdForConversation(workspaceRoot, nodeId, sessionConversation));
    return {
      ...conversation,
      ...(sessionId ? { resumableNativeSessionId: sessionId } : {}),
      continuationRootConversationId: Number(rootConversation.id || conversation.id || 0)
    };
  });
}
