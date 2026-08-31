import * as fs from 'fs';
import * as path from 'path';
import { AgentConversation } from './db/types';

export interface ConversationLifecycleOptions {
  nowMs?: number;
  staleRunningMs?: number;
  staleRunningStatusMs?: number;
}

const defaultStaleRunningMs = 2 * 60 * 1000;
const defaultStaleRunningStatusMs = 10 * 60 * 1000;
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

function hasFreshRunningStatus(
  projectRoot: string,
  conversation: AgentConversation,
  _nowMs: number,
  _staleRunningStatusMs: number
): boolean {
  const match = readStatusForConversation(projectRoot, Number(conversation.id || 0));
  return Boolean(match && String(match.status?.status || '') === 'Running');
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
  const status = String(conversation.status || '');
  const outputStatus = statusFromOutput(String(conversation.output || ''));
  if (outputStatus && (status === 'Running' || status === 'In Progress' || status === '')) {
    return { ...conversation, status: outputStatus };
  }
  if (status !== 'Running') {
    return conversation;
  }
  const nowMs = options.nowMs ?? Date.now();
  const staleRunningStatusMs = options.staleRunningStatusMs ?? defaultStaleRunningStatusMs;
  const statusMatch = readStatusForConversation(projectRoot, Number(conversation.id || 0));
  const settledStatus = statusFromStatusFile(conversation, statusMatch?.status || null);
  if (settledStatus) {
    return { ...conversation, status: settledStatus };
  }
  if (hasFreshRunningStatus(projectRoot, conversation, nowMs, staleRunningStatusMs)) {
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
