import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentConversation } from './db/types';
import { getAgentCliVersion, resolveExecutableIdentityPath, resolveExecutablePath } from './agentCli';
import { getResumableSession, NativeSessionBinding, readCompatibleSessionId, readSessionBinding } from './sessionIdentity';

export interface AgentStepSession {
  agentCli: string;
  provider: string;
  sessionId: string;
  runId?: string;
  revision?: number;
  runStartedAt?: string;
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
const stepSessionLeaseWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

export type ContinuableAgentConversation = AgentConversation & {
  resumableNativeSessionId?: string;
  continuationRootConversationId?: number;
};

export function getContinuationAgentProvider(agentCli: string): string {
  const executableName = path.basename(agentCli).toLowerCase();
  if (executableName === 'codex' || executableName === 'codex-cli') {
    return 'codex';
  }
  if (executableName === 'agent' || executableName === 'cursor' || executableName === 'cursor-cli' || executableName === 'cursor-agent') {
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
      version: Number(parsed.version || 1),
      nodeId: String(parsed.nodeId || nodeId),
      sessions
    };
  } catch {
    return emptyState;
  }
}

function withStepSessionLease<T>(filePath: string, action: () => T): T {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const leaseFilePath = `${filePath}.lease`;
  const deadline = Date.now() + 2000;
  let leaseFd = -1;
  while (leaseFd < 0) {
    try {
      leaseFd = fs.openSync(leaseFilePath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the step session lease: ${filePath}`);
      }
      Atomics.wait(stepSessionLeaseWaitBuffer, 0, 0, 10);
    }
  }
  try {
    return action();
  } finally {
    fs.closeSync(leaseFd);
    try {
      fs.unlinkSync(leaseFilePath);
    } catch {
      // Losing an already released ephemeral lease cannot change the committed pointer.
    }
  }
}

export function getStoredAgentSession(workspaceRoot: string, nodeId: string, agentCli: string): AgentStepSession | null {
  const filePath = getStepSessionFilePath(workspaceRoot, nodeId);
  const state = readStepSessionState(filePath, nodeId);
  const session = state.sessions[getAgentSessionKey(agentCli)];
  if (!session || !session.sessionId) {
    return null;
  }
  if (session.runId || session.revision) {
    if (!session.runId || !Number.isInteger(session.revision)) {
      return null;
    }
    const bindingFilePath = path.join(workspaceRoot, '.solopreneur', 'agent-runs', nodeId, String(session.runId), 'session.json');
    const resumable = getResumableSession(bindingFilePath);
    let binding: NativeSessionBinding;
    try {
      binding = readSessionBinding(bindingFilePath);
    } catch {
      return null;
    }
    const currentCliPath = resolveExecutableIdentityPath(agentCli) || resolveExecutablePath(agentCli) || agentCli;
    const currentCliVersion = getAgentCliVersion(currentCliPath);
    if (!resumable
      || resumable.runId !== session.runId
      || resumable.revision !== session.revision
      || resumable.sessionId !== session.sessionId
      || resumable.provider !== getContinuationAgentProvider(agentCli)
      || path.resolve(resumable.workspaceRoot) !== path.resolve(workspaceRoot)
      || path.resolve(resumable.cliPath) !== path.resolve(currentCliPath)
      || (binding.cliVersion !== undefined && binding.cliVersion !== currentCliVersion)) {
      return null;
    }
  }
  return session;
}

export function updateStoredAgentSession(
  workspaceRoot: string,
  nodeId: string,
  agentCli: string,
  sessionId: string,
  pointer: { runId?: string; revision?: number } = {}
): StepSessionState {
  const filePath = getStepSessionFilePath(workspaceRoot, nodeId);
  return withStepSessionLease(filePath, () => {
    const state = readStepSessionState(filePath, nodeId);
    const sessionKey = getAgentSessionKey(agentCli);
    const existing = state.sessions[sessionKey];
    let runStartedAt = '';
    if (pointer.runId && Number.isInteger(pointer.revision)) {
      const bindingFilePath = path.join(workspaceRoot, '.solopreneur', 'agent-runs', nodeId, pointer.runId, 'session.json');
      const binding = readSessionBinding(bindingFilePath);
      const resumable = getResumableSession(bindingFilePath);
      if (!resumable
        || binding.runId !== pointer.runId
        || resumable.revision !== pointer.revision
        || resumable.sessionId !== sessionId) {
        return state;
      }
      runStartedAt = binding.createdAt;
      if (existing?.runId && existing.runId !== pointer.runId) {
        let existingRunStartedAt = String(existing.runStartedAt || '');
        if (!existingRunStartedAt) {
          try {
            existingRunStartedAt = readSessionBinding(path.join(
              workspaceRoot,
              '.solopreneur',
              'agent-runs',
              nodeId,
              existing.runId,
              'session.json'
            )).createdAt;
          } catch {
            existingRunStartedAt = '';
          }
        }
        const incomingTime = Date.parse(runStartedAt);
        const existingTime = Date.parse(existingRunStartedAt);
        const existingIsNewer = Number.isFinite(incomingTime) && Number.isFinite(existingTime)
          ? existingTime > incomingTime
            || (existingTime === incomingTime && existing.runId.localeCompare(pointer.runId, undefined, { numeric: true }) > 0)
          : Boolean(existingRunStartedAt);
        if (existingIsNewer) {
          return state;
        }
      }
    } else if (existing?.runId) {
      return state;
    }
    state.version = pointer.runId && Number.isInteger(pointer.revision) ? 2 : 1;
    state.nodeId = nodeId;
    state.sessions[sessionKey] = {
      agentCli,
      provider: getContinuationAgentProvider(agentCli),
      sessionId,
      ...(pointer.runId ? { runId: pointer.runId } : {}),
      ...(Number.isInteger(pointer.revision) ? { revision: pointer.revision } : {}),
      ...(runStartedAt ? { runStartedAt } : {}),
      updatedAt: new Date().toISOString()
    };
    const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFilePath, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tempFilePath, filePath);
    return state;
  });
}

export function clearStoredAgentSession(workspaceRoot: string, nodeId: string, agentCli: string): boolean {
  const filePath = getStepSessionFilePath(workspaceRoot, nodeId);
  return withStepSessionLease(filePath, () => {
    const state = readStepSessionState(filePath, nodeId);
    const sessionKey = getAgentSessionKey(agentCli);
    if (!state.sessions[sessionKey]) {
      return false;
    }
    delete state.sessions[sessionKey];
    const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFilePath, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tempFilePath, filePath);
    return true;
  });
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
  const text = String(output || '');
  const userBoundary = [
    text.indexOf('\n\nUser supplement:\n'),
    text.indexOf('\n\nUser request:\n'),
    text.indexOf('\n\nUser message:\n')
  ].filter((index) => index >= 0).sort((left, right) => left - right)[0];
  const trustedPrefix = userBoundary === undefined ? text : text.slice(0, userBoundary);
  const match = trustedPrefix.match(/(?:^|\n)Continuation parent conversation:\s*(\d+)(?:\n|$)/);
  if (!match || match.index === undefined) {
    return 0;
  }
  const markerIndex = trustedPrefix.indexOf('Agent continuation started.');
  return match.index === 0 || (markerIndex >= 0 && markerIndex < match.index)
    ? Number(match[1])
    : 0;
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
  return readCompatibleSessionId(path.join(getConversationRunDir(workspaceRoot, nodeId, conversationId), 'session.json'));
}

function blocksLegacySessionFallback(filePath: string): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    return value.version === 2;
  } catch {
    return fs.existsSync(filePath);
  }
}

export function recoverInterruptedNativeSessionId(
  workspaceRoot: string,
  nodeId: string,
  conversation: AgentConversation | null
): string {
  return resolveNativeSessionIdForConversation(workspaceRoot, nodeId, conversation);
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

export function resolveNativeSessionIdForConversation(workspaceRoot: string, nodeId: string, conversation: AgentConversation | null): string {
  if (!conversation || !workspaceRoot) {
    return '';
  }
  const conversationId = Number(conversation.id || 0);
  const runSessionFilePath = path.join(getConversationRunDir(workspaceRoot, nodeId, conversationId), 'session.json');
  if (!fs.existsSync(runSessionFilePath)) {
    return '';
  }
  try {
    const binding = readSessionBinding(runSessionFilePath);
    const resumable = getResumableSession(runSessionFilePath);
    if (!resumable) {
      return '';
    }
    const provider = getContinuationAgentProvider(conversation.agentCli || '');
    const currentCliPath = resolveExecutableIdentityPath(conversation.agentCli || '')
      || resolveExecutablePath(conversation.agentCli || '')
      || String(conversation.agentCli || '');
    const currentCliVersion = getAgentCliVersion(currentCliPath);
    const head = binding.revisions[binding.headRevision - 1];
    const codexContext = head?.providerContext?.codex as Record<string, unknown> | undefined;
    const recordedCodexHome = String(codexContext?.codexHome || '').trim();
    const currentCodexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    if (binding.runId !== String(conversationId)
      || resumable.runId !== String(conversationId)
      || binding.provider !== provider
      || path.resolve(binding.workspaceRoot) !== path.resolve(workspaceRoot)
      || path.resolve(binding.cliPath) !== path.resolve(currentCliPath)
      || (binding.cliVersion !== undefined && binding.cliVersion !== currentCliVersion)
      || (provider === 'codex' && (!recordedCodexHome || path.resolve(recordedCodexHome) !== currentCodexHome))) {
      return '';
    }
    return resumable.sessionId;
  } catch {
    if (blocksLegacySessionFallback(runSessionFilePath)) {
      return '';
    }
  }
  const runSessionId = readRunSessionId(workspaceRoot, nodeId, conversationId);
  if (!runSessionId) {
    return '';
  }
  if (getContinuationAgentProvider(conversation.agentCli || '') !== 'codex') {
    return runSessionId;
  }
  const recordedCodexHome = readRunTextFile(workspaceRoot, nodeId, conversationId, 'codex-home.txt').trim();
  const codexHome = recordedCodexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return findCodexTranscriptFile(codexHome, runSessionId) ? runSessionId : '';
}

export function hydrateConversationContinuations(
  workspaceRoot: string,
  nodeId: string,
  conversations: AgentConversation[],
  _options: { validateCodexTranscript?: boolean; recoverRunSessionIdentity?: boolean } = {}
): ContinuableAgentConversation[] {
  return conversations.map((conversation) => {
    const rootConversation = resolveContinuationRootConversationFromList(conversations, Number(conversation.id || 0)) || conversation;
    const sessionConversation = resolveContinuationSessionConversationFromList(conversations, Number(conversation.id || 0)) || conversation;
    const directSessionId = resolveNativeSessionIdForConversation(workspaceRoot, nodeId, conversation);
    const sessionId = directSessionId
      || resolveNativeSessionIdForConversation(workspaceRoot, nodeId, sessionConversation);
    return {
      ...conversation,
      ...(sessionId ? { resumableNativeSessionId: sessionId } : {}),
      continuationRootConversationId: Number(rootConversation.id || conversation.id || 0)
    };
  });
}
