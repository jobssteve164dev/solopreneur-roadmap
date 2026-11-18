import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { ContentVerificationIdentity } from './contentVerification.js';
import type { RunCheckpointNode } from './runCheckpointPublication.js';
import type { ObjectHeadObservation } from './objectHeadVerification.js';
import type { SqlValue } from './diskDatabase.js';
import type { UnifiedDataStore, WriteReceipt } from './unifiedDataStore.js';

export interface RunVerificationRequest extends DataWriteDatabaseIdentity {
  projectId:string;actorId:string;time:number;
  input:Parameters<UnifiedDataStore['recordRunVerification']>[1];
  qualification?:PreparedRunVerification;
}
export interface PreparedRunVerification {
  runId:string;taskId:string;inputHash:string;request:Record<string,SqlValue>|null;
  heads:Array<ObjectHeadObservation & {signature?:string}>;contents:ContentVerificationIdentity[];
  requests:Array<{key:string;value:Record<string,SqlValue>|null}>;
  evaluations:Array<Record<string,SqlValue>>;
  nodes:Array<{node:RunCheckpointNode;relations:Array<{source:string;target:string}>}>;
  verificationKey?:string;
  replay?:{receipt:WriteReceipt;serialized:string};
}
