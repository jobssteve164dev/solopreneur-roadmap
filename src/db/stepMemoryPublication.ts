import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { ContentVerificationIdentity } from './contentVerification.js';
import type { ObjectHeadObservation, ObjectRevisionVerification } from './objectHeadVerification.js';
import type { SqlValue } from './diskDatabase.js';
import type { DataObject, PreparedContentPublication, StepMemorySourceReference, WriteReceipt } from './unifiedDataStore.js';

export interface StepMemoryInput {
  nodeId:string;expectedRevision:number;patch:Record<string,unknown>;origin?:'default'|'user';idempotencyKey:string;
}
export interface StepMemoryResult {revision:number;objectId:string;data:Record<string,unknown>;receipt:WriteReceipt}
export interface StepMemoryContext extends DataWriteDatabaseIdentity {
  projectId:string;actorId:string;nodeId:string;key:string;objectId:string;time:number;
}
export interface StepMemoryRequest extends StepMemoryContext {input:StepMemoryInput}
export interface StepMemoryProjection {
  result:StepMemoryResult;serialized:string;row:Record<string,SqlValue>;
  heads:ObjectHeadObservation[];contents:ContentVerificationIdentity[];revisions:ObjectRevisionVerification[];
}
export interface StepMemoryStateSelection {
  inputHash:string;request:Record<string,SqlValue>|null;current:Record<string,SqlValue>|null;
  cursor:number;revision:number;sources:StepMemorySourceReference[];
  heads:ObjectHeadObservation[];contents:ContentVerificationIdentity[];
}
export interface StepMemorySelection extends StepMemoryStateSelection {fields:string[];origin:'default'|'user'}
export interface PreparedStepMemory extends StepMemorySelection {
  metadata?:PreparedContentPublication;sourceRefs?:PreparedContentPublication;replay?:StepMemoryProjection;
}
export interface StepMemoryBodyRequest extends StepMemoryContext {
  selection:StepMemoryStateSelection;metadata:ContentVerificationIdentity;
  pendingSources?:ReadonlyArray<{objectId:string;revision:number;snapshot:ContentVerificationIdentity}>;
}
export interface StepMemoryPlanRequest extends StepMemoryBodyRequest {body:ContentVerificationIdentity;sourceRefs:ContentVerificationIdentity}
export interface PreparedStepMemoryPlan {object:DataObject;terms:string;snapshot:PreparedContentPublication}
export interface StepMemoryResultRequest extends StepMemoryContext {receipt:WriteReceipt}
