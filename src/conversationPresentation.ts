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

  let tail = match[1]
    .replace(/\r/g, '')
    .replace(/^Script (?:started|done).*$/gim, '')
    .trim();

  // Codex and several compatible CLIs print the speaker before the final answer.
  // The last speaker block is more reliable than the last few terminal lines, which
  // often contain token counters or shell noise after the actual conclusion.
  const speakerMatches = [...tail.matchAll(/^(?:codex|assistant|agent)\s*$/gim)];
  const lastSpeaker = speakerMatches.at(-1);
  if (lastSpeaker?.index !== undefined) {
    tail = tail.slice(lastSpeaker.index + lastSpeaker[0].length).trim();
  }

  // Codex can print a long tool result or patch first, then the token counter, and
  // only then the final answer. In that layout the counter is the reliable boundary:
  // deleting the two counter lines alone leaves the preceding diff in the conclusion.
  const tokenCounters = [...tail.matchAll(/^tokens used\s*\n[\d,]+\s*$/gim)];
  const lastTokenCounter = tokenCounters.at(-1);
  if (lastTokenCounter?.index !== undefined) {
    const afterCounter = tail.slice(lastTokenCounter.index + lastTokenCounter[0].length).trim();
    tail = afterCounter || tail.slice(0, lastTokenCounter.index).trim();
  }

  const lines = tail
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !line.trimStart().startsWith('SoloMap:'));
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();

  // When no speaker marker exists, prefer a closing conclusion/summary section over
  // preceding tool output. Keep the complete section instead of an arbitrary 3-line tail.
  if (!lastSpeaker) {
    let headingIndex = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (/^(?:#{1,6}\s*)?(?:结论|总结|本轮(?:结果|结论|完成情况)|最终(?:结果|结论)|完成情况|result|conclusion|summary|outcome)\s*[:：]?\s*$/i.test(lines[index].trim())) {
        headingIndex = index;
        break;
      }
    }
    if (headingIndex >= 0) {
      lines.splice(0, headingIndex);
    }
  }

  return lines.join('\n').trim().slice(0, 4000);
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

export function selectLatestConversationRoots(conversations: PresentedAgentConversation[], limit = 1): PresentedAgentConversation[] {
  const byId = new Map<number, PresentedAgentConversation>();
  conversations.forEach((conversation) => {
    const id = Number(conversation.id || 0);
    if (id) {
      byId.set(id, conversation);
    }
  });

  const latestActivityByRoot = new Map<number, number>();
  const roots = new Map<number, PresentedAgentConversation>();
  conversations.forEach((conversation) => {
    const id = Number(conversation.id || 0);
    if (!id) {
      return;
    }
    const reviewParentId = Number(conversation.reviewParentConversationId || 0);
    const rootId = reviewParentId && byId.has(reviewParentId)
      ? reviewParentId
      : Number(conversation.continuationRootConversationId || id);
    const root = byId.get(rootId) || conversation;
    const resolvedRootId = Number(root.id || id);
    roots.set(resolvedRootId, root);
    latestActivityByRoot.set(
      resolvedRootId,
      Math.max(latestActivityByRoot.get(resolvedRootId) || 0, id)
    );
  });

  return [...roots.values()]
    .sort((left, right) => {
      const leftActivity = latestActivityByRoot.get(Number(left.id || 0)) || Number(left.id || 0);
      const rightActivity = latestActivityByRoot.get(Number(right.id || 0)) || Number(right.id || 0);
      return rightActivity - leftActivity || Number(right.id || 0) - Number(left.id || 0);
    })
    .slice(0, Math.max(0, limit));
}
