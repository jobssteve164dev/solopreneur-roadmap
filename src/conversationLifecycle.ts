import * as fs from 'fs';
import * as path from 'path';
import { AgentConversation } from './db/types';

export interface ConversationLifecycleOptions {
  nowMs?: number;
  staleRunningMs?: number;
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

function readStatusForConversation(projectRoot: string, conversationId: number): any | null {
  for (const filePath of getConversationStatusFilePaths(projectRoot, conversationId)) {
    const status = readJson(filePath);
    if (status && Number(status.executionLogId || 0) === Number(conversationId || 0)) {
      return status;
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

function hasRunningStatus(projectRoot: string, conversation: AgentConversation): boolean {
  const status = readStatusForConversation(projectRoot, Number(conversation.id || 0));
  return Boolean(status && String(status.status || '') === 'Running');
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
  if (hasRunningStatus(projectRoot, conversation)) {
    return conversation;
  }
  const startedAt = Date.parse(String(conversation.timestamp || ''));
  const nowMs = options.nowMs ?? Date.now();
  const staleRunningMs = options.staleRunningMs ?? defaultStaleRunningMs;
  if (Number.isFinite(startedAt) && nowMs - startedAt < staleRunningMs) {
    return conversation;
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
