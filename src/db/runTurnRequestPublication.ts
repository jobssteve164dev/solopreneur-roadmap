import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { DataObject, DataWrite, PreparedContentPublication, UnifiedDataStore, WriteReceipt } from './unifiedDataStore.js';
import type { ContentVerificationIdentity } from './contentVerification.js';
import type { ObjectHeadObservation } from './objectHeadVerification.js';
import type { SqlValue } from './diskDatabase.js';
import type { RunState } from '../runLifecycleTypes.js';
import type { AgentConversation } from './types.js';

export interface RunTurnRequestPreparation extends DataWriteDatabaseIdentity {
  projectId:string;actorId:string;time:number;journalSourceId:string;
  input:Parameters<UnifiedDataStore['patchRunTurnRequest']>[1];
}
export interface RunTurnRequestNode {input:DataWrite;objectId:string;replay?:WriteReceipt}
export interface PreparedRunTurnRequest {
  inputHash:string;before:Record<string,SqlValue>;request:Record<string,SqlValue>|null;
  heads:ObjectHeadObservation[];contents:ContentVerificationIdentity[];
  requests:Array<{key:string;value:Record<string,SqlValue>|null}>;
  replay?:{state:RunState;serialized:string;history:Record<string,SqlValue>|null};
  turn?:RunTurnRequestNode;
  journal?:{
    executionLogId:number;entry:Omit<AgentConversation,'dataState'>;signature:string;
    source?:RunTurnRequestNode;beforeSource:{id:string;revision:number}|null;
  };
  metadata?:PreparedContentPublication;snapshot?:PreparedContentPublication;object?:DataObject;
}
export interface RunTurnRequestQualification extends DataWriteDatabaseIdentity {
  projectId:string;executionLogId:number;signature:string;
}
