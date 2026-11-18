import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { ObjectHeadObservation, ObjectRevisionVerification } from './objectHeadVerification.js';
import type { ContentVerificationIdentity } from './contentVerification.js';
import type { SqlValue } from './diskDatabase.js';
import type { DataObject, FlowSnapshot, PreparedContentPublication, StepMemorySourceReference, UnifiedDataStore, WriteReceipt } from './unifiedDataStore.js';
import type { RunSettlementInput, RunState } from '../runLifecycleTypes.js';
import type { AgentConversation } from './types.js';
import type { RunDocumentRequest } from './runDocumentPublication.js';
import type { RunCheckpointNode } from './runCheckpointPublication.js';
import type { RunDigest } from '../runDigest.js';
import type { DocumentationManifest } from '../documentationManifest.js';
import type { ConversationNotificationCandidate } from '../conversationTracking.js';

export interface RunSettlementRequest extends DataWriteDatabaseIdentity {
  projectId:string;actorId:string;time:number;input:RunSettlementInput;
}
export interface RunSettlementPayloadRequest extends RunSettlementRequest {
  prepared:PreparedRunSettlement;
  flow?:{objectId:string;revision:number};
}
export interface PreparedRunSettlementPayload {
  payload:PreparedContentPublication;digest:PreparedContentPublication;handoff?:PreparedContentPublication;
  document:RunDocumentRequest['input'];
}
export interface RunSettlementDigestRequest extends RunSettlementRequest {
  prepared:PreparedRunSettlement;content:ContentVerificationIdentity;
  sourceDocument:{objectId:string;revision:number};ids:{digest:string;projection:string};
}
export interface RunDigestPublicationRequest extends DataWriteDatabaseIdentity {
  projectId:string;actorId:string;time:number;sourceKey:string;content:ContentVerificationIdentity;
  sourceObjectId?:string;ids:RunSettlementDigestRequest['ids'];
}
export interface PreparedRunSettlementDigest {
  sourceKey:string;key:string;inputHash:string;hash:string;request:Record<string,SqlValue>|null;
  previous:{objectId:string;projectionId:string}|null;
  heads:Array<ObjectHeadObservation & {signature?:string}>;contents:ContentVerificationIdentity[];
  replay?:WriteReceipt;value:Pick<RunDigest,'nodeId'|'runId'|'runKind'|'finishedAt'|'executionLogId'|'changedFiles'|'touchedFiles'|'tags'>;
  object?:DataObject;terms?:string;snapshot?:PreparedContentPublication;projection?:RunCheckpointNode;
  projectionRequest?:{key:string;value:Record<string,SqlValue>|null};
}
export interface RunSettlementDocumentationRequest extends RunSettlementRequest {
  prepared:PreparedRunSettlement;qualification?:PreparedRunSettlementDocumentation;
}
export interface PreparedRunSettlementDocumentation {
  manifest:DocumentationManifest;manifestHead:Record<string,SqlValue>|null;
  heads:Array<ObjectHeadObservation & {signature?:string}>;contents:ContentVerificationIdentity[];
  requests:Array<{key:string;value:Record<string,SqlValue>|null}>;nodes:RunCheckpointNode[];
}
export interface RunSettlementLearningRequest extends RunSettlementRequest {
  prepared:PreparedRunSettlement;sourceDocument:{objectId:string;revision:number};qualification?:PreparedRunSettlementLearning;
}
export interface PreparedRunSettlementLearning {
  learningEventId:string|null;learning?:RunCheckpointNode;
  nodes:Array<{node:RunCheckpointNode;relations:Array<{source:string;target:string}>}>;
  sourceRelations:Array<{source:string;target:string;ignore:boolean}>;
  heads:Array<ObjectHeadObservation & {signature?:string}>;contents:ContentVerificationIdentity[];
  requests:Array<{key:string;value:Record<string,SqlValue>|null}>;
  versions:Array<{objectId:string;revision:number;contentId:string|null}>;
  deliveries:Array<{lessonId:string;revision:number;delivered:boolean}>;
  skips:Array<{evaluation:string;rejected:string;done:boolean}>;
  assessment?:{evidenceId:string;contentId:string|null;signature:string;valid:boolean};
}
export interface RunSettlementStepRequest extends RunSettlementRequest {
  prepared:PreparedRunSettlement;sourceDocument:{objectId:string;revision:number};handoff:ContentVerificationIdentity;objectId:string;
}
export interface PreparedRunSettlementStep {
  key:string;inputHash:string;request:Record<string,SqlValue>|null;current:Record<string,SqlValue>|null;
  cursor:number;revision:number;sources:StepMemorySourceReference[];
  heads:ObjectHeadObservation[];contents:ContentVerificationIdentity[];replay?:WriteReceipt;
  body?:PreparedContentPublication;sourceRefs?:PreparedContentPublication;metadata?:PreparedContentPublication;
}
export interface RunSettlementStepPlanRequest extends RunSettlementStepRequest {
  step:PreparedRunSettlementStep;body:ContentVerificationIdentity;sourceRefs:ContentVerificationIdentity;metadata:ContentVerificationIdentity|null;
}
export interface PreparedRunSettlementStepPlan {
  object:DataObject;terms:string;snapshot:PreparedContentPublication;
}
export interface RunSettlementJournalsRequest extends RunSettlementRequest {
  prepared:PreparedRunSettlement;qualification?:PreparedRunSettlementJournals;
}
export interface PreparedRunSettlementJournals {
  heads:Array<ObjectHeadObservation & {signature?:string}>;contents:ContentVerificationIdentity[];
  requests:Array<{key:string;value:Record<string,SqlValue>|null}>;mappingSignature:string;
  baseline:Array<{executionLogId:number;signature:string;source:Record<string,SqlValue>|null}>;
  steps:Array<{executionLogId:number;entry:Pick<AgentConversation,'agentCli'|'command'|'output'|'status'>;source?:RunCheckpointNode;previousStep?:number}>;
}
export interface RunSettlementTailRequest extends RunSettlementRequest {
  prepared:PreparedRunSettlement;document:{objectId:string;created:boolean};
  heads:Array<ObjectHeadObservation & {signature?:string}>;
}
export interface PreparedRunSettlementTail {
  object:DataObject;snapshot:PreparedContentPublication;metadata?:PreparedContentPublication;runStatus?:string;
  tracked:boolean;effects:Array<{id:string;kind:string;payload:PreparedContentPublication}>;
  index?:{executionLogId:number;record:string;files:string;signals:string;hash:string;outputPath:string};
}
export interface RunSettlementNotificationRequest extends RunSettlementRequest {
  prepared:PreparedRunSettlement;payload:ContentVerificationIdentity;flow?:FlowSnapshot;qualification?:PreparedRunSettlementNotification;
}
export interface RunSettlementNotificationDependencies {
  launch:Record<string,SqlValue>|null;project:Record<string,SqlValue>|null;
  registry:Array<Record<string,SqlValue>>;configuration:Array<Record<string,SqlValue>>;locations:Array<Record<string,SqlValue>>;
}
export interface PreparedRunSettlementNotification {
  dependencies:RunSettlementNotificationDependencies;eligibleRoots:string[];visible:boolean;
  viewSignature:string;pending?:ConversationNotificationCandidate['pending'];
  heads:Array<ObjectHeadObservation & {signature?:string}>;contents:ContentVerificationIdentity[];revisions:ObjectRevisionVerification[];
  existing?:{intentId:string;value:Record<string,SqlValue>|null};
  request?:{key:string;value:Record<string,SqlValue>|null};
  enqueue?:{id:string;intentId:string;intentHash:string;messageHash:string;payload:PreparedContentPublication;node:RunCheckpointNode};
}
export interface PreparedRunSettlement {
  inputHash:string;request:Record<string,SqlValue>|null;before:Record<string,SqlValue>;
  heads:Array<ObjectHeadObservation & {signature?:string}>;
  contents:ContentVerificationIdentity[];revisions:ObjectRevisionVerification[];
  replay?:{state:RunState;serialized:string;history:Record<string,SqlValue>|null;snapshotId:string|null};
  rootObject?:DataObject;original?:RunState;
  lease?:Record<string,SqlValue>;source?:Record<string,SqlValue>;
  previousTurn?:{learningEventId:string|null};
  journal?:{executionLogId:number;entry:Omit<AgentConversation,'dataState'>;signature:string;source:{id:string;revision:number}|null};
  flow?:Parameters<UnifiedDataStore['writeFlowTrace']>[1];
}
