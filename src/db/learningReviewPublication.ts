import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { ContentVerificationIdentity } from './contentVerification.js';
import type { RunCheckpointNode } from './runCheckpointPublication.js';
import type { ObjectHeadObservation, ObjectRevisionVerification } from './objectHeadVerification.js';
import type { SqlValue } from './diskDatabase.js';
import type { UnifiedDataStore, WriteReceipt } from './unifiedDataStore.js';
import type { RunControlMutation } from './runControlPublication.js';
import type { ReviewManifest } from '../learningReview.js';

export interface LearningReviewPrepareEntryRequest extends DataWriteDatabaseIdentity {
  actorId:string;time:number;input:Parameters<UnifiedDataStore['prepareLearningReview']>[0];resultMode?:'identity';
}
export interface LearningReviewPrepareEntryAcknowledgement {
  batchId:string;publications:ReadonlyArray<LearningReviewApplyPublication>;
}
export interface LearningReviewPrepareResult {
  objectId:string;revision:number;manifest:ReviewManifest;policy:{objectId:string;revision:number};pending:any[];
}
export interface LearningReviewPrepareIdentityResult {
  objectId:string;revision:number;policy:{objectId:string;revision:number};persistedPromptHash:string;manifestHash:string;
}
export interface PreparedLearningReviewEntry extends LearningReviewApplyEvidence {
  kind:'new'|'interrupt'|'replay';requestProjectId:string;requestRoot:string;batchId?:string;
  result?:LearningReviewPrepareResult;serialized?:string;
  identityResult?:LearningReviewPrepareIdentityResult;
  owners:Array<{pid:number;birth:string;childPid:number;childBirth:string;alive:boolean}>;
  runControls:Array<{runId:string;value:Record<string,SqlValue>}>;
}

export interface LearningReviewFinishRequest extends DataWriteDatabaseIdentity {
  actorId:string;time:number;input:Parameters<UnifiedDataStore['finishLearningReview']>[0];
  qualification?:PreparedLearningReviewFinish;
}
export interface PreparedLearningReviewFinish {
  projectId:string|null;nodes:RunCheckpointNode[];
  heads:Array<ObjectHeadObservation & {signature:string}>;contents:ContentVerificationIdentity[];
  controls:Array<{batchId:string;inputContentId:string|null}>;
  requests:Array<{key:string;value:Record<string,SqlValue>|null}>;
}

export interface LearningReviewInterruptRequest extends DataWriteDatabaseIdentity {
  actorId:string;time:number;batchId:string;qualification?:PreparedLearningReviewInterrupt;
}
export interface PreparedLearningReviewInterrupt extends PreparedLearningReviewFinish {
  control:Record<string,SqlValue>|null;run:Record<string,SqlValue>|null;live:boolean|null;
  stateControl?:Record<string,SqlValue>;
  stop?:{projectId:string;mutation:Extract<RunControlMutation,{type:'stop'}>};
}

export interface LearningReviewApplyPublication extends ContentVerificationIdentity {
  objectId:string;revision:number;nativeRevision:number|null;
}
export interface LearningReviewApplyNode extends RunCheckpointNode {
  referenceSnapshots:ObjectRevisionVerification[];
  pendingReferences:Array<{key:string;objectId:string;revision:number}>;
}
export interface LearningReviewApplyEvidence {
  heads:Array<ObjectHeadObservation & {signature?:string}>;
  contents:ContentVerificationIdentity[];revisions:ObjectRevisionVerification[];
  controls:PreparedLearningReviewFinish['controls'];requests:PreparedLearningReviewFinish['requests'];
  mappings:Array<{kind:'memory'|'lesson';identity:string;key:string;scope:string|null;legacyId?:string;objectId:string|null}>;
  projects:string[];
}
export interface LearningReviewApplyRequest extends DataWriteDatabaseIdentity {
  actorId:string;time:number;input:Parameters<UnifiedDataStore['applyLearningReview']>[0];
}
export interface LearningReviewApplyQualificationRequest extends DataWriteDatabaseIdentity {actorId:string;evidence:LearningReviewApplyEvidence}
export interface PreparedLearningReviewApply extends LearningReviewApplyEvidence {
  batchId:string;projectId:string|null;nodes:LearningReviewApplyNode[];tail?:LearningReviewApplyNode;
  recoveries:any[];applicationKey:string;policyKey:string;lessonKeys:string[];
}
export interface LearningReviewApplyRecoveryRequest extends DataWriteDatabaseIdentity {
  actorId:string;time:number;pending:any;decision:string;key:string;applicationKey:string;
  publications:LearningReviewApplyPublication[];
  pendingMappings?:Array<NonNullable<PreparedLearningReviewApplyRecovery['insertMapping']>>;
}
export interface PreparedLearningReviewApplyRecovery extends LearningReviewApplyEvidence {
  nodes:LearningReviewApplyNode[];
  insertMapping?:{identity:string;scope:string;legacyId:string;objectId:string;key:string};
}
export interface LearningReviewApplyResultRequest extends DataWriteDatabaseIdentity {
  actorId:string;applicationKey:string;policyKey:string;lessonKeys:string[];
}
export interface LearningReviewApplyResult {application:WriteReceipt;policy:WriteReceipt;lessons:WriteReceipt[]}
export interface PreparedLearningReviewApplyResult {result:LearningReviewApplyResult;serialized:string}

export interface LearningCycleRequest extends DataWriteDatabaseIdentity {
  actorId:string;time:number;projectId:string;input:Parameters<UnifiedDataStore['recordLearningCycle']>[1];
}
export interface PreparedLearningCycle extends LearningReviewApplyEvidence {
  nodes:LearningReviewApplyNode[];eventKey:string;
}
