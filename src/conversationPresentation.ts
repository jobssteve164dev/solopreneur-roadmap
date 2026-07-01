import { AgentConversation } from './db/types';
import {
  ContinuableAgentConversation,
  extractContinuationParentConversationId,
  hydrateConversationContinuations
} from './continuation';
import { normalizeAgentConversationLifecycles } from './conversationLifecycle';

export interface ConversationChangedFile {
  label: string;
  path: string;
}

export interface ConversationCapabilities {
  canContinue: boolean;
  canStop: boolean;
  canRetry: boolean;
  canRollback: boolean;
  canOpenTerminal: boolean;
}

export type PresentedAgentConversation = ContinuableAgentConversation & {
  continuationParentConversationId: number;
  reviewParentConversationId: number;
  summary: string;
  conclusion: string;
  failureCategory: string;
  failureReason: string;
  durationMs?: number;
  changedFiles: ConversationChangedFile[];
  rollbackGitHash: string;
  capabilities: ConversationCapabilities;
};

function extractSection(output: string, label: string): string {
  const match = String(output || '').match(new RegExp(`${label}:\\n([\\s\\S]*?)(?:\\n\\n|$)`));
  return match?.[1]?.trim() || '';
}

function extractSummary(output: string): string {
  const continuationMessage = extractSection(output, 'Continuation first message');
  if (continuationMessage) {
    return continuationMessage.replace(/\s+/g, ' ').slice(0, 120);
  }
  const userMessage = extractSection(output, 'User supplement');
  if (userMessage) {
    return userMessage.replace(/\s+/g, ' ').slice(0, 120);
  }
  const touchedFiles = extractSection(output, 'Touched project files');
  if (touchedFiles && !touchedFiles.includes('No project files')) {
    return touchedFiles.replace(/\s+/g, ' ').slice(0, 120);
  }
  const tailMatch = String(output || '').match(/Agent output tail:\n([\s\S]*)$/);
  return String(tailMatch?.[1] || output || '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

function extractConclusion(output: string): string {
  const match = String(output || '').match(/Agent output tail:\n([\s\S]*)$/);
  if (!match?.[1]) {
    return '';
  }
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('SoloMap:'))
    .slice(-3)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

function extractChangedFiles(output: string): ConversationChangedFile[] {
  const sections = [
    /Touched project files:\n([\s\S]*?)(?:\n\n|$)/,
    /Workspace changes:\n([\s\S]*?)(?:\n\nTouched project files:|\n\n|$)/
  ];
  const files: ConversationChangedFile[] = [];
  const seen = new Set<string>();
  for (const pattern of sections) {
    const match = String(output || '').match(pattern);
    if (!match?.[1]) continue;
    for (const line of match[1].split('\n').map((item) => item.trim()).filter(Boolean)) {
      if (/^No (workspace|git|project) /i.test(line)) continue;
      const normalized = line.replace(/^(?:[AMDRC?U!]{1,2}|[A-Z])\s+/, '').trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      files.push({ label: line, path: normalized });
    }
  }
  return files;
}

function extractDurationMs(conversation: AgentConversation, now: number): number | undefined {
  const stored = String(conversation.output || '').match(/Run duration ms:\s*(\d+)/);
  if (stored) {
    return Number(stored[1]);
  }
  if (conversation.status !== 'Running' || !conversation.timestamp) {
    return undefined;
  }
  const startedAt = Date.parse(conversation.timestamp);
  return Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : undefined;
}

function extractReviewParentConversationId(output: string): number {
  const match = String(output || '').match(/Review of execution:\s*(\d+)/);
  return match ? Number(match[1]) : 0;
}

function extractRollbackGitHash(output: string): string {
  const match = String(output || '').match(/SoloMapPreGitHash:\s*([a-f0-9]+)/i);
  return match ? match[1] : '';
}

export function buildConversationPresentations(
  workspaceRoot: string,
  nodeId: string,
  conversations: AgentConversation[],
  now = Date.now()
): PresentedAgentConversation[] {
  const normalizedConversations = normalizeAgentConversationLifecycles(workspaceRoot, conversations, { nowMs: now });
  return hydrateConversationContinuations(workspaceRoot, nodeId, normalizedConversations).map((conversation) => {
    const output = String(conversation.output || '');
    const rollbackGitHash = extractRollbackGitHash(output);
    return {
      ...conversation,
      continuationParentConversationId: extractContinuationParentConversationId(output),
      reviewParentConversationId: extractReviewParentConversationId(output),
      summary: extractSummary(output),
      conclusion: extractConclusion(output),
      failureCategory: (output.match(/Failure category:\s*([^\n]+)/) || [])[1]?.trim() || '',
      failureReason: extractSection(output, 'Failure reason'),
      durationMs: extractDurationMs(conversation, now),
      changedFiles: extractChangedFiles(output),
      rollbackGitHash,
      capabilities: {
        canContinue: conversation.status !== 'Running' && Boolean(conversation.resumableNativeSessionId),
        canStop: conversation.status === 'Running',
        canRetry: conversation.status === 'Failed',
        canRollback: conversation.status !== 'Running' && Boolean(rollbackGitHash),
        canOpenTerminal: conversation.status === 'Running'
      }
    };
  });
}
