import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { ContentVerificationIdentity } from './contentVerification.js';
import type { ObjectHeadObservation } from './objectHeadVerification.js';
import type { SqlValue } from './diskDatabase.js';
import type { DataObject, PreparedContentPublication } from './unifiedDataStore.js';
import type { RunOutputFinalizationInput, RunState } from '../runLifecycleTypes.js';
import type { RunCheckpointNode } from './runCheckpointPublication.js';
import type { RunDocumentRequest } from './runDocumentPublication.js';
import type { AgentConversation } from './types.js';

export interface RunOutputInspectionRequest extends DataWriteDatabaseIdentity {
  projectId:string;actorId:string;input:RunOutputFinalizationInput;
}
export interface PreparedRunOutputInspection {state:RunState;serialized:string;replay:boolean}
export interface RunOutputRequest extends RunOutputInspectionRequest {time:number;journalSourceId:string}
export interface PreparedRunOutput {
  inputHash:string;before:Record<string,SqlValue>;requests:Array<{key:string;value:Record<string,SqlValue>|null}>;
  heads:Array<ObjectHeadObservation & {signature?:string}>;contents:ContentVerificationIdentity[];
  taskAlias?:{taskId:string;legacyTaskId:string|null};
  replay?:{state:RunState;serialized:string;history:Record<string,SqlValue>|null;snapshotId:string|null};
  rootObject?:DataObject;metadata:Record<string,unknown>;runChanges:Record<string,SqlValue>;
  documents:Array<{input:RunDocumentRequest['input'];fields:Array<[string,'objectId'|'revision']>}>;
  turn?:RunCheckpointNode;
  journal?:{executionLogId:number;entry:Omit<AgentConversation,'dataState'>;signature:string;source?:RunCheckpointNode;beforeSource:{id:string;revision:number}|null};
  logs:Array<{stream:string;nextSequence:number;totalBytes:number;signature:string}>;
  live:boolean;
  learningControl?:{batchId:string;inputContentId:string|null;deliverable:boolean;contentIds:string[]};
}
export interface RunOutputPlanRequest extends RunOutputRequest {
  prepared:PreparedRunOutput;
  documents:Array<{receipt:{objectId:string;revision:number};fields:Array<[string,'objectId'|'revision']>;created:boolean}>;
}
export interface PreparedRunOutputPlan {object:DataObject;metadata:PreparedContentPublication;snapshot:PreparedContentPublication}
