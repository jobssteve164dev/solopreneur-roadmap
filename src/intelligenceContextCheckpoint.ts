import * as crypto from 'crypto';

import type { IntelligenceMessage } from './intelligenceChat';

export const INTELLIGENCE_CONTEXT_CHECKPOINT_NAMESPACE = 'intelligence_context';
export const INTELLIGENCE_CONTEXT_CHECKPOINT_KEY = 'pi_harness_compaction';
export const MAX_INTELLIGENCE_CONTEXT_SUMMARY_CHARACTERS = 262_144;

export interface IntelligenceContextCheckpoint {
  schemaVersion: 1;
  engine: 'pi-harness';
  sourceMessageCount: number;
  sourceHash: string;
  sourceRevision: number;
  retainedMessageCount: number;
  tokensBefore: number;
  summary: string;
  createdAt: number;
}

export interface StagedIntelligenceContextCheckpoint extends Omit<IntelligenceContextCheckpoint, 'sourceRevision'> {}

export function intelligenceMessagePrefixHash(messages: IntelligenceMessage[], count = messages.length): string {
  return crypto.createHash('sha256').update(JSON.stringify(messages.slice(0, count))).digest('hex');
}

export function validIntelligenceContextCheckpoint(
  value: unknown,
  messages: IntelligenceMessage[]
): value is IntelligenceContextCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const checkpoint = value as Partial<IntelligenceContextCheckpoint>;
  return checkpoint.schemaVersion === 1
    && checkpoint.engine === 'pi-harness'
    && Number.isInteger(checkpoint.sourceMessageCount) && checkpoint.sourceMessageCount! >= 1
    && checkpoint.sourceMessageCount! <= messages.length
    && typeof checkpoint.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(checkpoint.sourceHash)
    && checkpoint.sourceHash === intelligenceMessagePrefixHash(messages, checkpoint.sourceMessageCount)
    && Number.isInteger(checkpoint.sourceRevision) && checkpoint.sourceRevision! >= 1
    && Number.isInteger(checkpoint.retainedMessageCount) && checkpoint.retainedMessageCount! >= 0
    && checkpoint.retainedMessageCount! <= checkpoint.sourceMessageCount!
    && Number.isFinite(checkpoint.tokensBefore) && checkpoint.tokensBefore! >= 0
    && typeof checkpoint.summary === 'string' && checkpoint.summary.length > 0
    && checkpoint.summary.length <= MAX_INTELLIGENCE_CONTEXT_SUMMARY_CHARACTERS
    && Number.isFinite(checkpoint.createdAt) && checkpoint.createdAt! > 0;
}

export function normalizeStagedIntelligenceContextCheckpoint(
  value: unknown,
  messages: IntelligenceMessage[],
  sourceRevision: number
): IntelligenceContextCheckpoint {
  const staged = value as Partial<StagedIntelligenceContextCheckpoint> | undefined;
  const checkpoint: IntelligenceContextCheckpoint = {
    schemaVersion: 1,
    engine: 'pi-harness',
    sourceMessageCount: Number(staged?.sourceMessageCount),
    sourceHash: String(staged?.sourceHash || ''),
    sourceRevision,
    retainedMessageCount: Number(staged?.retainedMessageCount),
    tokensBefore: Number(staged?.tokensBefore),
    summary: typeof staged?.summary === 'string' ? staged.summary : '',
    createdAt: Number(staged?.createdAt)
  };
  if (!validIntelligenceContextCheckpoint(checkpoint, messages)) throw new Error('intelligence_context_checkpoint_invalid');
  return checkpoint;
}
