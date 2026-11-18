import type { DataWriteDatabaseIdentity,DataWriteImportSource,PreparedDataWrite } from './dataWritePublication.js';
import type { ContentVerificationRequest } from './contentVerification.js';
import type { LearningReviewApplyEvidence,LearningReviewApplyNode,LearningReviewApplyPublication } from './learningReviewPublication.js';
import type { ImportObjectSelection,ImportObjectContext } from './importObjectPublication.js';
import type { PreparedContentPublication,DataObject } from './unifiedDataStore.js';
import type { SqlValue } from './diskDatabase.js';

export interface RegisteredReportObservation {executionLogId:number;sequence:number;availability:string;envelope:any}
export interface RegisteredReportProjectedTurn {executionLogId:number;legacySequence:number;turnId:string;sequence?:number;publication?:LearningReviewApplyPublication}
export interface RegisteredReportProjection {
 taskId:string;executions?:ContentVerificationRequest;failure?:RegisteredReportFailure;
 turns:ReadonlyArray<RegisteredReportProjectedTurn>;publications:ReadonlyArray<LearningReviewApplyPublication>;
 priorImport?:ImportObjectContext['priorImport'];
}
interface RegisteredReportBase extends DataWriteDatabaseIdentity {
 actorId:string;time:number;objectId:string;projectId:string;taskId:string;source:DataWriteImportSource;observation:RegisteredReportObservation;
 projection?:RegisteredReportProjection;
}
export type RegisteredReportRequest=RegisteredReportBase & (
 | {phase:'capture';bytes:Uint8Array}
 | {phase:'turn'}
 | {phase:'report';turnId:string;turnPublication?:LearningReviewApplyPublication}
);
export interface PreparedRegisteredReport extends LearningReviewApplyEvidence {
 phase:RegisteredReportRequest['phase'];absentContents:string[];
 sha256?:string;capture?:PreparedContentPublication;captureFailure?:RegisteredReportFailure;
 registration?:Record<string,SqlValue>|null;turnBinding?:string|null;nextSequence?:number;nativeNextSequence?:number;previous?:DataObject;
 turn?:LearningReviewApplyNode & {prepared?:PreparedDataWrite};turnId?:string;
 selection?:ImportObjectSelection;inputHash?:string;sourceTime?:string;
 failure?:RegisteredReportFailure & {point:'before_capture'|'after_capture'|'turn'|'before_report'|'report'|'tail'};
}
export interface RegisteredReportFailure {name:string;message:string;code?:string}
