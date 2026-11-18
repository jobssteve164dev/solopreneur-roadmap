import type { DataWriteDatabaseIdentity, DataWritePreparationRequest } from './dataWritePublication.js';
import type { DataObject, DataWrite, PreparedContentPublication, WriteReceipt } from './unifiedDataStore.js';
import type { RunCheckpointInput, RunState } from '../runLifecycleTypes.js';
import type { SqlValue } from './diskDatabase.js';
import type { ContentVerificationIdentity } from './contentVerification.js';
import type { RunControlMutation, RunControlProjectedState } from './runControlPublication.js';
import type { RunDocumentRequest } from './runDocumentPublication.js';
import type { AgentConversation } from './types.js';
import type { NativeSessionBinding } from '../sessionIdentity.js';
import type { RunReportHeader } from './runReportPublication.js';

export interface RunCheckpointRequest extends DataWriteDatabaseIdentity {
  projectId:string;actorId:string;time:number;input:RunCheckpointInput;
  ids:{turn:string;report:string;journal:string};
}
export interface RunCheckpointInspectionRequest extends DataWriteDatabaseIdentity {
  projectId:string;actorId:string;input:RunCheckpointInput;root?:string;normalizeReport?:boolean;
}
export interface PreparedRunCheckpointInspection {state:RunState;input:RunCheckpointInput;replay?:RunState;serialized?:string}
export interface RunCheckpointNode {
  input:DataWrite;objectId:string;producer?:DataWritePreparationRequest['producer'];projectedPrevious?:DataObject;
  replay?:WriteReceipt;
}
export interface RunCheckpointJournal {
  executionLogId:number;key:string;entry:Omit<AgentConversation,'id'>;insert:boolean;
  source?:RunCheckpointNode;
}
export interface PreparedRunCheckpoint {
  inputHash:string;before:Record<string,SqlValue>;request:Record<string,SqlValue>|null;
  heads:Array<{id:string;revision:number|null;signature?:string}>;contents:ContentVerificationIdentity[];
  requests:Array<{key:string;value:Record<string,SqlValue>|null}>;
  taskAlias?:{taskId:string;legacyTaskId:string|null};
  replay?:{state:RunState;serialized:string;receipt:WriteReceipt};
  time:number;turnId:string;newTurn:boolean;turns:RunCheckpointNode[];
  metadata:Record<string,unknown>;runChanges:Record<string,SqlValue>;controlChanges:Record<string,SqlValue>;
  preludeRunChanges:Record<string,SqlValue>;preludeControlChanges:Record<string,SqlValue>;
  documents:Array<{input:RunDocumentRequest['input'];fields:Array<[string,'objectId'|'revision']>}>;
  report?:{node:RunCheckpointNode;availability:string;validationError:string};
  reportHead?:{turnId:string;head:RunReportHeader|null};
  bindings:RunControlMutation[];bindingBase?:RunControlProjectedState;
  bindingMetadataFields:string[];
  journalPrelude?:RunCheckpointJournal;journalFinal?:RunCheckpointJournal;
  journalBaseline:{executionLogId:number;sourceId:string|null;sourceRevision:number|null}|null;
  journalSignature?:string;
  logs?:Array<{stream:string;sequence:number;signature:string}>;
  allocation?:{next:number;minimum:number|null;minimumObject:{id:string;revision:number}|null};
  turnSequence?:number;globalPolicy?:{objectId:string;revision:number}|null;
  live:{process:boolean;child:boolean};unusedSessionReentry:boolean;
  rootObject?:DataObject;
}
export interface RunCheckpointPlanRequest extends RunCheckpointRequest {
  prepared:PreparedRunCheckpoint;
  documents:Array<{receipt:{objectId:string;revision:number};fields:Array<[string,'objectId'|'revision']>;created:boolean}>;
  report?:{objectId:string;revision:number};bindingBase?:RunControlProjectedState;binding?:NativeSessionBinding;
}
export interface PreparedRunCheckpointPlan {
  object:DataObject;metadata:PreparedContentPublication;snapshot:PreparedContentPublication;
  controlChanges:Record<string,SqlValue>;runChanges:Record<string,SqlValue>;
  insertConsumer:boolean;
}
