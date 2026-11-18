import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { LearningReviewApplyEvidence, LearningReviewApplyNode } from './learningReviewPublication.js';
import type { SqlValue } from './diskDatabase.js';
import type { UnifiedDataStore, WriteReceipt } from './unifiedDataStore.js';

export type ExternalMemoryMutation = {operation:'sync';input:Parameters<UnifiedDataStore['syncExternalMemory']>[1]}
  | {operation:'revoke';input:Parameters<UnifiedDataStore['revokeExternalMemoryTarget']>[1]}
  | {operation:'reconcile';input:Parameters<UnifiedDataStore['reconcileExternalMemoryTarget']>[1]};
export type ExternalMemoryRequest = DataWriteDatabaseIdentity & {actorId:string;time:number;projectId:string;mutation:ExternalMemoryMutation};
export interface PreparedExternalMemory extends LearningReviewApplyEvidence {
  nodes:LearningReviewApplyNode[];resultKey?:string;result?:WriteReceipt|{revoked:number;total:number};serialized?:string;
  receiptRequest?:{actorId:string;key:string;value:Record<string,SqlValue>};
}
export type ExternalMemorySelection = {source:string}|{projectPrefix:string;globalPrefix:string};
