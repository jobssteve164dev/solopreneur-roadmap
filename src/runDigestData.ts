import type { RunDigest } from './runDigest';
import type { RunIndexFile, RunIndexRecord, RunIndexSignal } from './db/types';
import { normalizeTokenUsage } from './tokenUsage';

export interface RunDigestReference {
  digest: RunDigest;
  ref: { objectId: string; revision: number };
}

export function parseRunDigestSource(text: string): RunDigest {
  const value = JSON.parse(text.replace(/^\uFEFF/, ''));
  const stringListInvalid = (object: Record<string, unknown>, keys: string[]): boolean => keys.some(key => object[key] !== undefined && (!Array.isArray(object[key]) || (object[key] as unknown[]).some(item => typeof item !== 'string')));
  const stringInvalid = (object: Record<string, unknown>, keys: string[]): boolean => keys.some(key => object[key] !== undefined && typeof object[key] !== 'string');
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![1, 2].includes(value.schemaVersion)
    || typeof value.runId !== 'string' || !value.runId || typeof value.nodeId !== 'string' || !value.nodeId
    || !Number.isInteger(value.executionLogId) || value.executionLogId < 1
    || stringListInvalid(value, ['changedFiles', 'touchedFiles', 'tags', 'verification', 'failures', 'commandSignals', 'reusableSignals'])
    || stringInvalid(value, ['runKind', 'agentCli', 'status', 'startedAt', 'finishedAt', 'userIntent', 'outcome', 'handoffSummary'])
    || (value.handoff !== undefined && (!value.handoff || typeof value.handoff !== 'object' || Array.isArray(value.handoff)
      || stringListInvalid(value.handoff, ['filesToInspectFirst', 'recommendedFirstActions', 'commandsToRunNext', 'openQuestions', 'blockedBy', 'assumptions', 'decisionsMade', 'doNotRepeat'])
      || stringInvalid(value.handoff, ['summary', 'nextAgentBrief'])))) {
    throw new Error('run_digest_source_invalid');
  }
  return value as RunDigest;
}

export function executionQueryTokens(context = '', files: string[] = []): string[] {
  return [...new Set([context, ...files].join('\n').toLowerCase().split(/[^a-z0-9_\-/.]+/i).map(token => token.trim()).filter(token => token.length >= 3))];
}

export function digestToRunIndex(digest: RunDigest): { record: RunIndexRecord; files: RunIndexFile[]; signals: RunIndexSignal[] } {
  const tokenUsage = normalizeTokenUsage(digest.tokenUsage);
  const files: RunIndexFile[] = [
    ...(digest.changedFiles || []).map((filePath) => ({ filePath, role: 'changed' })),
    ...(digest.touchedFiles || []).map((filePath) => ({ filePath, role: 'touched' }))
  ];
  const signals: RunIndexSignal[] = [
    ...(digest.verification || []).map((value) => ({ type: 'verification', value })),
    ...(digest.failures || []).map((value) => ({ type: 'failure', value })),
    ...(digest.reusableSignals || []).map((value) => ({ type: 'reusable', value }))
  ];
  return {
    record: {
      executionLogId: digest.executionLogId,
      nodeId: digest.nodeId,
      runKind: digest.runKind,
      agentCli: digest.agentCli,
      status: digest.status,
      startedAt: digest.startedAt,
      finishedAt: digest.finishedAt,
      durationMs: digest.durationMs,
      inputTokens: tokenUsage.inputTokens,
      cachedInputTokens: tokenUsage.cachedInputTokens,
      outputTokens: tokenUsage.outputTokens,
      reasoningOutputTokens: tokenUsage.reasoningOutputTokens,
      totalTokens: tokenUsage.totalTokens,
      outputPath: '',
      outputBytes: 0,
      outputTail: '',
      commandPath: '',
      promptPath: '',
      changesPath: '',
      touchedFilesPath: '',
      updatedAt: new Date().toISOString()
    },
    files,
    signals
  };
}
