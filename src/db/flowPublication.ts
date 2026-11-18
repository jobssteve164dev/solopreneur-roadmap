import type { DataWriteDatabaseIdentity, DataWritePreparationRequest } from './dataWritePublication.js';
import type { ContentVerificationRequest, ContentVerificationIdentity } from './contentVerification.js';
import type { SqlValue } from './diskDatabase.js';
import type { DataWrite, DataObject, PreparedContentPublication, FlowSnapshot, WriteReceipt } from './unifiedDataStore.js';
import type { FlowTrace } from '../flowStore.js';

export interface FlowTraceWriteInput {flow:FlowTrace;expectedRevision:number;idempotencyKey:string}
export interface FlowTracePreparationRequest extends DataWriteDatabaseIdentity {
  projectId:string;actorId:string;time:number;input:FlowTraceWriteInput;
  projectedBase?:FlowTraceProjectedState;
  projectedRuns?:Array<{projectId:string;executionLogId:number;runId:string;nodeId:string;progress:{status:Record<string,unknown>}}>;
  retainProjectedState?:boolean;
  roleAttachment?:{loopId:string;role:'planner'|'builder'|'verifier';executionLogId:number;startedAt:string;command:string;updatedAt:string};
}
export interface FlowTraceProjectedState {
  control:Record<string,SqlValue>;
  nativeControl:Record<string,SqlValue>|null;
  objects:Record<string,DataObject>;
  loops:Array<Record<string,SqlValue>>;
}
export interface FlowPublicationNode {
  key:string;objectId:string;input:DataWrite;producer?:DataWritePreparationRequest['producer'];
  projectedPrevious?:DataObject;retainProjectedObject?:boolean;
}
export interface FlowNotificationDependencies {
  launch:Record<string,SqlValue>|null;
  project:Record<string,SqlValue>|null;
  registry:Array<Record<string,SqlValue>>;
  configuration:Array<Record<string,SqlValue>>;
  locations:Array<Record<string,SqlValue>>;
  contents:ContentVerificationIdentity[];
}
export interface PreparedFlowNotification {
  requiresConfiguration?:boolean;
  dependencies:FlowNotificationDependencies;state:string|null;eligibleRoots:string[];
  enqueue?:{
    id:string;intentId:string;intentHash:string;messageHash:string;
    node:FlowPublicationNode;payload:PreparedContentPublication;
  };
  existingIntentId?:string;
}
export interface PreparedFlowTrace {
  serialized?:string;
  inputHash:string;replay?:WriteReceipt;
  control:Record<string,SqlValue>|null;
  objectId:string;taskId:string;
  nodes:FlowPublicationNode[];
  heads:Array<{id:string;revision:number|null}>;
  header:PreparedContentPublication;
  versions:PreparedContentPublication;
  retained:Array<{contentId:string;publication:PreparedContentPublication}>;
  loops:Array<{loopId:string;workflowId:string;evidenceId:string;new:boolean}>;
  relations:DataObject['relations'];
  result:FlowSnapshot;
  notification:FlowNotificationDependencies;
}
export interface FlowTracePlanRequest extends FlowTracePreparationRequest {
  notificationConfigurationReady?:boolean;
  prepared:PreparedFlowTrace;
  contents:ReadonlyArray<ContentVerificationRequest & {field:string}>;
}
export interface PreparedFlowTracePlan {
  object:DataObject;terms:string;snapshot:PreparedContentPublication;
  contents:FlowTracePlanRequest['contents'];
  serialized:string;
  notification:PreparedFlowNotification;
}
