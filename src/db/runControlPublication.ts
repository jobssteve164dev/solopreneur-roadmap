import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { DataObject, DataWrite, PreparedContentPublication, UnifiedDataStore, WriteReceipt } from './unifiedDataStore.js';
import type { SqlValue } from './diskDatabase.js';
import type { NativeSessionBinding } from '../sessionIdentity.js';
import type { RunState } from '../runLifecycleTypes.js';
import type { ContentVerificationIdentity } from './contentVerification.js';

export type RunControlMutation = {type:'state';input:Parameters<UnifiedDataStore['patchRunState']>[1]}
  | {type:'stop';input:Parameters<UnifiedDataStore['requestRunStop']>[1];trustedBoundary?:Parameters<UnifiedDataStore['requestRunStop']>[2];contextRevision?:number}
  | {type:'binding';input:Parameters<UnifiedDataStore['writeRunBinding']>[1]}
  | {type:'deliveryClaim';input:Parameters<UnifiedDataStore['claimRunDelivery']>[1]}
  | {type:'deliveryRelease';input:Parameters<UnifiedDataStore['releaseRunDelivery']>[1]}
  | {type:'runClaim';input:Parameters<UnifiedDataStore['claimRun']>[1]}
  | {type:'terminalOwner';input:Parameters<UnifiedDataStore['claimRunTerminalOwner']>[1]}
  | {type:'reportBind';input:{executionLogId:number;generation:number;turnId:string;reportObjectId:string;reportRevision:number;availability:string;validationError?:string;idempotencyKey:string}};
export interface RunControlPreparationRequest extends DataWriteDatabaseIdentity {
  projectId:string;actorId:string;time:number;mutation:RunControlMutation;
  projectedBase?:RunControlProjectedState;
}
export interface RunDeliveryStartPreparationRequest extends DataWriteDatabaseIdentity {
  input:Parameters<UnifiedDataStore['beginRunDelivery']>[1];
}
export interface PreparedRunDeliveryStart {
  lease:Extract<RunControlMutation,{type:'deliveryClaim'}>;
  terminal:Omit<Extract<RunControlMutation,{type:'state'}>['input'],'expectedRevision'>;
}
export interface RunControlProjectedState {
  control:Record<string,SqlValue>;object:DataObject;nativeControl:Record<string,SqlValue>|null;
}
export interface PreparedRunControl {
  inputHash:string;before:Record<string,SqlValue>;
  replay?:{result:RunState|NativeSessionBinding;serialized:string;receipt:WriteReceipt;contents:ContentVerificationIdentity[]};
  object?:DataObject;runChanges:Record<string,SqlValue>;controlChanges:Record<string,SqlValue>;
  fields:Array<{field:'metadata'|'binding'|'providerContext'|'snapshot';publication:PreparedContentPublication}>;
  binding?:NativeSessionBinding;serializedBinding?:string;bindingRevision?:number;
  evidence?:{objectId:string;input:DataWrite};
}
