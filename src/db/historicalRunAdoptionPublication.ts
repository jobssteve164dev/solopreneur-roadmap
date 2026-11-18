import type { DataWriteDatabaseIdentity,DataWriteImportSource,PreparedDataWrite,PreparedMutationReplay } from './dataWritePublication.js';
import type { LearningReviewApplyEvidence,LearningReviewApplyNode,LearningReviewApplyPublication } from './learningReviewPublication.js';
import type { NativeSessionBinding } from '../sessionIdentity.js';
import type { RegisteredReportObservation,RegisteredReportProjectedTurn } from './registeredReportPublication.js';
import type { ContentVerificationIdentity,ContentVerificationRequest } from './contentVerification.js';
import type { SqlValue } from './diskDatabase.js';
import type { DataObject,DataWrite,PreparedContentPublication } from './unifiedDataStore.js';
import type { RunState } from '../runLifecycleTypes.js';
import type { RunDocumentRequest } from './runDocumentPublication.js';

export interface HistoricalRunSourceIntent {
 source:DataWriteImportSource;status:Record<string,unknown>;binding:NativeSessionBinding|null;
 hashes:NonNullable<PreparedHistoricalRunInput['hashes']>;
 outputSource?:DataWriteImportSource;nativeSource?:DataWriteImportSource;
}
export interface HistoricalRunCompletionIntent extends HistoricalRunSourceIntent {completionSource:DataWriteImportSource}
export type HistoricalRunExistingRequest = DataWriteDatabaseIdentity & (
 {phase:'select';projectId:string;executionLogId:number;taskId:string;sourceHash:string;source:DataWriteImportSource;outputSource?:DataWriteImportSource;artifacts?:PreparedHistoricalRunArtifacts}
 | {phase:'completionIntent';metadata:ContentVerificationRequest;completion:HistoricalRunCompletionIntent}
 | {phase:'olderOutput';metadata:ContentVerificationRequest;runId:string;intent:HistoricalRunSourceIntent}
 | {phase:'mutation';actorId:string;key:string;input:unknown}
 | {phase:'metadata';metadata:ContentVerificationRequest;sourceHash:string;outputByteLength:number;updates:Record<string,unknown>}
 | {phase:'completionMetadata';metadata:ContentVerificationRequest;sourceHash:string;completionSource:DataWriteImportSource;decision:Record<string,unknown>;mayNormalize:boolean}
 | {phase:'body';runId:string;time:number;targets:ReadonlyArray<string>;runStatus?:string}
 | {phase:'projection';projectId:string;executionLogId:number;control:Record<string,SqlValue>;object:DataObject;metadata:ContentVerificationRequest}
);
export interface PreparedHistoricalRunExisting extends LearningReviewApplyEvidence {
 absentContents:string[];state?:RunState;control?:Record<string,SqlValue>;append?:boolean;completion?:boolean;olderOutputCandidate?:boolean;olderOutputAccepted?:boolean;
 object?:DataObject;terms?:string;snapshot?:PreparedContentPublication;metadata?:PreparedContentPublication;
 inputHash?:string;request?:Record<string,SqlValue>|null;replay?:PreparedMutationReplay;
 result?:{unchanged:false;state:RunState};serialized?:string;
 failure?:{name:string;message:string;code?:string};
}

export interface HistoricalRunRootSelectionRequest extends DataWriteDatabaseIdentity {
 actorId:string;projectId:string;locationId:string;source:DataWriteImportSource;input:Pick<HistoricalRunAdoptionInput,'status'>;
 facts:HistoricalRunPrelude;sourceHash:string;taskId:string;
 publications:ReadonlyArray<LearningReviewApplyPublication>;turns:ReadonlyArray<RegisteredReportProjectedTurn>;
}
export interface PreparedHistoricalRunRootSelection extends LearningReviewApplyEvidence {
 absentContents:string[];existing:Record<string,SqlValue>|null;
 taskId?:string;conversationId?:string;location?:Record<string,SqlValue>|null;
 turns:Array<{executionLogId:number;legacySequence:number;turnId:string}>;
 reports?:Array<{objectId:string;turnId:string}>;inputHash?:string;request?:Record<string,SqlValue>|null;replay?:PreparedMutationReplay;
 turnId?:string;nextTurnSequence?:number;idempotencyKey?:string;
 startedAt?:number;finishedAt?:number|null;checkpointSequence?:number;
 failure?:{point:'before_root'|'after_owner'|'mutation';name:string;message:string;code?:string};
}
export interface HistoricalRunRootTurnRequest extends DataWriteDatabaseIdentity {
 actorId:string;time:number;projectId:string;source:DataWriteImportSource;status:Record<string,unknown>;
 selection?:PreparedHistoricalRunRootSelection;mode:'current'|'restore'|'prior';turnId?:string;executionLogId?:number;
 publications:ReadonlyArray<LearningReviewApplyPublication>;afterTurn?:LearningReviewApplyPublication;intentOnly?:true;
}
export interface PreparedHistoricalRunRootTurn extends LearningReviewApplyEvidence {
 absentContents:string[];turnId?:string;needsMapping?:boolean;previous?:DataObject;inputHash?:string;
 intent?:DataWrite;node?:LearningReviewApplyNode & {prepared?:PreparedDataWrite};
 failure?:{point:'before_node'|'mutation'|'fields';name:string;message:string;code?:string};
}
export interface HistoricalRunRootMetadataRequest extends DataWriteDatabaseIdentity {
 source:DataWriteImportSource;sourceHash:string;workspaceRoot:string;outputByteLength:number;legacyDecision:Record<string,unknown>;
 input:Pick<HistoricalRunAdoptionInput,'status'|'binding'|'changes'|'nativeTranscript'|'legacyCompletion'|'outputSource'>;
 changesIsBuffer:boolean;body?:HistoricalRunRootBodyRequest;
}
export interface PreparedHistoricalRunRootMetadata {
 metadata?:PreparedContentPublication;binding?:PreparedContentPublication;facts:Record<string,unknown>;
 body?:PreparedHistoricalRunRootBody;
 failure?:{point:'metadata'|'binding';name:string;message:string;code?:string};
}
export interface HistoricalRunRootBodyRequest extends DataWriteDatabaseIdentity {
 actorId:string;projectId:string;locationId:string;runId:string;turnId:string;time:number;
 selection:PreparedHistoricalRunRootSelection;runKind:string;status:string;exitCode:number|null;
 contents:ReadonlyArray<ContentVerificationRequest & {field:'command'|'prompt'}>;
 targets:ReadonlyArray<string>;final:boolean;
}
export interface PreparedHistoricalRunRootBody {
 object:DataObject;terms?:string;snapshot:PreparedContentPublication;
 contents:HistoricalRunRootBodyRequest['contents'];
}
export interface HistoricalRunRootNodeRequest extends DataWriteDatabaseIdentity {
 actorId:string;projectId:string;runId:string;turnId:string;time:number;idempotencyKey:string;
 kind:'binding'|'report'|'journal';publications:ReadonlyArray<LearningReviewApplyPublication>;
 binding?:NativeSessionBinding;bindingRevision?:number;reportId?:string;nodeId?:string;executionLogId?:number;
 metadata?:ContentVerificationRequest;intentOnly?:true;
}
export interface PreparedHistoricalRunRootNode extends LearningReviewApplyEvidence {
 absentContents:string[];intent?:DataWrite;inputHash?:string;previous?:DataObject;
 node?:LearningReviewApplyNode & {prepared?:PreparedDataWrite};
 journal?:{executionLogId:number;key:string;bindOnly:boolean;insert:boolean;entry?:{nodeId:string;timestamp:string;agentCli:string;command:string;output:string;status:string}};
 report?:{objectId:string;turnId:string;availability:string};provider?:PreparedContentPublication;
 failure?:{point:'before_node'|'mutation'|'fields';name:string;message:string;code?:string};
 providerFailure?:{name:string;message:string;code?:string};
}
export interface HistoricalRunRootDocumentRequest extends DataWriteDatabaseIdentity {
 input:Omit<RunDocumentRequest['input'],'bytes'>;bytes:unknown;isBuffer:boolean;countLines?:true;
}
export interface PreparedHistoricalRunRootDocument {
 input?:RunDocumentRequest['input'];lineCount?:number;failure?:{name:string;message:string;code?:string};
}
export interface HistoricalRunRootFinalMetadataRequest extends DataWriteDatabaseIdentity {
 metadata:ContentVerificationRequest;updates:Record<string,unknown>;
}
export interface HistoricalRunRootProjectionRequest extends DataWriteDatabaseIdentity {
 projectId:string;executionLogId:number;runId:string;turnId:string;taskId:string;conversationId:string;
 nodeId:string;checkpointSequence:number;currentExecutionLogId:number;metadata:ContentVerificationRequest;
 object:DataObject;taskAlias?:string;
}
export interface PreparedHistoricalRunRootProjection {
 result:{unchanged:false;state:RunState};serialized?:string;metadataContentId:string;
}

export interface HistoricalRunAdoptionInput {
 historicalExecutionLogIds?:number[];status:Record<string,unknown>;binding:NativeSessionBinding|null;
 prompt:string;command:string;output:Buffer;outputSource?:DataWriteImportSource;
 nativeTranscript?:{source:DataWriteImportSource;bytes:Buffer};legacyCompletion?:{source:DataWriteImportSource;bytes:Buffer};
 appendedOutputSource?:DataWriteImportSource;appendedOutputArtifactExecutionLogId?:number;
 refreshedArtifacts?:Array<{source:DataWriteImportSource;artifactExecutionLogId:number;kind:'change_evidence';documentPurpose?:'changes'}>;
 workspaceBefore?:Buffer;changes?:Buffer;roadmapBackup?:Buffer;registeredTaskAlias?:string;
 unregisteredTaskAlias?:string;unregisteredRequest?:string;unregisteredWorkspaceRoot?:string;unregisteredWorkspaceRelocated?:boolean;
 unregisteredReports?:Array<{source:DataWriteImportSource;bytes:Buffer;observation:RegisteredReportObservation}>;
}
export interface HistoricalRunInputPreparationRequest extends DataWriteDatabaseIdentity {
 projectId:string;locationId:string;source:DataWriteImportSource;input:HistoricalRunAdoptionInput;
}
export interface HistoricalRunPrelude {
 executionLogId:number;currentExecutionLogId:number;nodeId:string;historicalExecutionLogIds:number[];hasRunKind:boolean;
}
export interface HistoricalRunIdentityRequest extends DataWriteDatabaseIdentity,HistoricalRunPrelude {
 projectId:string;legacyTaskId:string;
}
export interface PreparedHistoricalRunIdentity {
 registration:Record<string,SqlValue>|null;
 matches:Array<{id:number;matched?:boolean;failure?:{name:string;message:string;code?:string}}>;
}
export interface PreparedHistoricalRunInput {
 statusSource:Record<string,SqlValue>|null;contents:ContentVerificationIdentity[];absentContents:string[];
 facts?:HistoricalRunPrelude;registeredIdentity?:PreparedHistoricalRunIdentity;sources?:PreparedHistoricalRunSources;
 preludeFailure?:{name:string;message:string;code?:string};
 sourceFailure?:{name:string;message:string;code?:string};
 hashes?:{prompt:string;command:string;output:string;workspaceBefore:string|null;changes:string|null;roadmapBackup:string|null};
 sourceHash?:string;
 rootRequest?:{key:string;inputHash:string};rootRequestFailure?:{name:string;message:string;code?:string};
 failure?:{name:string;message:string;code?:string};
}

export interface HistoricalRunSourcePublication {source:DataWriteImportSource;content:ContentVerificationIdentity}
export interface HistoricalRunSourcesRequest extends DataWriteDatabaseIdentity {
 input:HistoricalRunAdoptionInput;currentExecutionLogId:number;nodeId:string;
 captures:ReadonlyArray<HistoricalRunSourcePublication>;nativeBufferFields:ReadonlyArray<'output'|'native'|'completion'>;
 artifacts?:{projectId:string;executionLogId:number;source:DataWriteImportSource;hashes:NonNullable<PreparedHistoricalRunInput['hashes']>;sourceHash:string};
}
export interface PreparedHistoricalRunArtifacts {
 observations:Array<{executionLogId:number;key:string;row:Record<string,SqlValue>|null}>;
 control:Record<string,SqlValue>|null;
 appended?:{source:DataWriteImportSource;archived:{byteLength:number;hash:string;mimeType:string};captured:{hash:string}};
 refreshed:Array<NonNullable<HistoricalRunAdoptionInput['refreshedArtifacts']>[number] & {archived:{hash:string;mimeType:string};captured:{bytes:Uint8Array;hash:string}}>;
 previousSourceHash?:string;
 formalOutput?:{chunks:Array<Record<string,SqlValue>>;exact:boolean;changesPurpose:string;currentChanges:{objectId:string;revision:number;hash:string}|null};
 failure?:{name:string;message:string;code?:string};formalFailure?:{name:string;message:string;code?:string};
}
export interface PreparedHistoricalRunSources {
 observations:Array<{identity:string;key:string;row:Record<string,SqlValue>|null;point:'output'|'native'|'completion'|'artifacts'|'formal';contentId?:string}>;
 contents:ContentVerificationIdentity[];absentContents:string[];legacyDecision:Record<string,unknown>;
 contentPoints?:Array<{contentId:string;point:NonNullable<PreparedHistoricalRunSources['failure']>['point']}>;
 artifacts?:PreparedHistoricalRunArtifacts;
 failure?:{point:'output'|'native'|'completion'|'artifacts'|'formal';name:string;message:string;code?:string};
}

export interface HistoricalRunTaskRequest extends DataWriteDatabaseIdentity {
 actorId:string;time:number;objectId:string;projectId:string;source:DataWriteImportSource;
 phase:'select'|'conversation'|'task'|'registration';legacyTaskId:string;learningTaskId:unknown;
 userMessage:unknown;fallbackRequest:unknown;conversationId?:string;taskId?:string;
 facts:HistoricalRunPrelude;taskAlias:unknown;startedAt:unknown;prepareExecutions?:boolean;
}
export interface PreparedHistoricalRunTask extends LearningReviewApplyEvidence {
 phase:HistoricalRunTaskRequest['phase'];primary:Record<string,SqlValue>|null;selected?:Record<string,SqlValue>|null;
 fallbackSelected?:boolean;requestKind?:'status'|'fallback';absentContents:string[];
 node?:LearningReviewApplyNode & {prepared?:PreparedDataWrite};inputHash?:string;
 registration?:{taskId:string;alias:string;changed:boolean;executionsJson?:string;executions?:PreparedContentPublication;executionsFailure?:{name:string;message:string;code?:string};startedAt?:string;titlePreview?:string;matches:PreparedHistoricalRunIdentity['matches']};
 registrationFailure?:{name:string;message:string;code?:string};
 failure?:{name:string;message:string;code?:string};
}
