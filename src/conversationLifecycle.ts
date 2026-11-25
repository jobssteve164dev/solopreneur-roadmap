import * as fs from 'fs';
import * as path from 'path';
import { isProcessOwnerAlive } from './processIdentity.js';
import { AgentConversation } from './db/types';

export interface ConversationLifecycleOptions {
  nowMs?: number;
  staleRunningMs?: number;
  staleRunningStatusMs?: number;
}

const defaultStaleRunningMs = 2 * 60 * 1000;
const agentStatusDirName = 'agent-status';

function readJson(filePath: string): any | null {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
  } catch {
    return null;
  }
}

function getProjectRootFromJournal(dbFilePath: string): string {
  const solopreneurRoot = path.basename(path.dirname(dbFilePath)) === '.solopreneur'
    ? path.dirname(dbFilePath)
    : path.dirname(path.dirname(dbFilePath));
  return path.basename(solopreneurRoot) === '.solopreneur'
    ? path.dirname(solopreneurRoot)
    : '';
}

function getConversationStatusFilePaths(projectRoot: string, conversationId: number): string[] {
  if (!projectRoot || !conversationId) {
    return [];
  }
  return [
    path.join(projectRoot, '.solopreneur', agentStatusDirName, `${conversationId}.json`),
    path.join(projectRoot, '.agent_status.json')
  ];
}

interface ConversationStatusMatch {
  status: any;
  filePath: string;
}

function readStatusForConversation(projectRoot: string, conversationId: number): ConversationStatusMatch | null {
  for (const filePath of getConversationStatusFilePaths(projectRoot, conversationId)) {
    const status = readJson(filePath);
    if (status && Number(status.executionLogId || 0) === Number(conversationId || 0)) {
      return { status, filePath };
    }
  }
  return null;
}

function statusFromOutput(output: string): string {
  const text = String(output || '');
  const explicitState = text.match(/(?:Solo conversation state|Roadmap step state|Continuation record state):\s*([A-Za-z ]+)/);
  if (explicitState?.[1]) {
    return explicitState[1].trim();
  }
  if (/Failure category:|Failure reason:/i.test(text)) {
    return 'Failed';
  }
  if (/Continuation recording stopped by user\.|Continuation terminal closed\.|Continuation record state:\s*Recorded/i.test(text)) {
    return 'Recorded';
  }
  if (/Run finished at:|Sentinel captured state:|Agent output tail:/i.test(text)) {
    return 'Completed';
  }
  return '';
}

function isContinuationConversation(conversation: AgentConversation, status: any | null): boolean {
  const runKind = String(status?.runKind || '').trim();
  const output = String(conversation.output || '');
  return runKind === 'solo_continue'
    || runKind === 'step_continue'
    || /Agent continuation started\.|Continuation parent conversation:|Continuation mode:/i.test(output);
}

function hasRunningOwner(status: any): boolean {
  if (status?.status !== 'Running' || status.interactiveSessionClosed) return false;
  const owners = [[status.agentPid, status.processBirth], [status.agentChildPid, status.processChildBirth]]
    .filter(([pid]) => Number.isSafeInteger(Number(pid)) && Number(pid) > 0);
  // Older agents did not record PIDs or refresh quiet sessions.
  return owners.length === 0 || owners.some(([pid, birth]) => isProcessOwnerAlive(Number(pid), String(birth || '')));
}

function statusFromStatusFile(conversation: AgentConversation, status: any | null): string {
  const statusValue = String(status?.status || '').trim();
  if (!statusValue || statusValue === 'Running' || statusValue === 'Processed') {
    return '';
  }
  if (isContinuationConversation(conversation, status)) {
    return 'Recorded';
  }
  const runKind = String(status?.runKind || '').trim();
  const nodeId = String(status?.nodeId || conversation.nodeId || '').trim();
  if (statusValue === 'In Progress' && (runKind === 'solo' || nodeId === '__solo__')) {
    return 'Completed';
  }
  return statusValue;
}

export function isConversationRunningStatus(status: string): boolean {
  return String(status || '') === 'Running';
}

export function normalizeAgentConversationLifecycle(
  projectRoot: string,
  conversation: AgentConversation,
  options: ConversationLifecycleOptions = {}
): AgentConversation {
  if (conversation.dataState) {
    if (conversation.dataState.importedJournal && ['Running', 'In Progress'].includes(conversation.status)) {
      const summary = String(conversation.output || '').match(
        /(?:^|\n)Sentinel captured state: [^\n]+\n+(?:Solo conversation state|Roadmap step state|Continuation record state): (Completed|Failed|Recorded|In Progress)\n+(?:Run started at: [^\n]+\n+)?Run finished at: (\S+)/);
      if (summary && Number.isFinite(Date.parse(summary[2]))) {
        const sessionStates = [...conversation.output.matchAll(/^Interactive session state: (Waiting|Open|Running|Closed)$/gim)];
        const closed = !sessionStates.length || sessionStates.at(-1)?.[1].toLowerCase() === 'closed';
        return { ...conversation, status: summary[1], dataState: { ...conversation.dataState, sessionClosed: closed } };
      }
    }
    const settled = conversation.dataState.settledTurnStatus;
    return conversation.status === 'Running' && settled ? { ...conversation, status: settled } : conversation;
  }
  const status = String(conversation.status || '');
  const outputStatus = statusFromOutput(String(conversation.output || ''));
  if (outputStatus && (status === 'Running' || status === 'In Progress' || status === '')) {
    return { ...conversation, status: outputStatus };
  }
  if (status !== 'Running') {
    return conversation;
  }
  const nowMs = options.nowMs ?? Date.now();
  const statusMatch = readStatusForConversation(projectRoot, Number(conversation.id || 0));
  const settledStatus = statusFromStatusFile(conversation, statusMatch?.status || null);
  if (settledStatus) {
    return { ...conversation, status: settledStatus };
  }
  if (hasRunningOwner(statusMatch?.status)) {
    return conversation;
  }
  const startedAt = Date.parse(String(conversation.timestamp || ''));
  const staleRunningMs = options.staleRunningMs ?? defaultStaleRunningMs;
  if (Number.isFinite(startedAt) && nowMs - startedAt < staleRunningMs) {
    return conversation;
  }
  if (isContinuationConversation(conversation, statusMatch?.status || null)) {
    return { ...conversation, status: 'Recorded' };
  }
  return { ...conversation, status: 'Failed' };
}

export function normalizeAgentConversationLifecycles(
  projectRoot: string,
  conversations: AgentConversation[],
  options: ConversationLifecycleOptions = {}
): AgentConversation[] {
  return conversations.map((conversation) => normalizeAgentConversationLifecycle(projectRoot, conversation, options));
}

export function inferProjectRootForConversationStore(dbFilePath: string): string {
  return getProjectRootFromJournal(dbFilePath);
}
