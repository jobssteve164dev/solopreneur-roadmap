import type { DataWriteDatabaseIdentity,DataWriteImportSource } from './dataWritePublication.js';
import type { ImportObjectSelection } from './importObjectPublication.js';
import type { LearningReviewApplyEvidence } from './learningReviewPublication.js';
import type { SqlValue } from './diskDatabase.js';

export interface LegacyReviewCursorRequest extends DataWriteDatabaseIdentity {
  actorId:string;time:number;objectId:string;source:DataWriteImportSource;bytes:Uint8Array;projects:string[];
}
export interface LegacyCursorFailure {point:'read'|'mutation';message:string;name:string;code?:string}
export interface PreparedLegacyReviewCursor extends LearningReviewApplyEvidence {
  sourceBefore?:Record<string,SqlValue>|null;selection?:ImportObjectSelection;inputHash?:string;changed?:boolean;
  link?:{runKey:string;inputContentId:string};failure?:LegacyCursorFailure;absentContents:string[];
  cursorRows:Array<{table:'inputs'|'controls';key:string;row:Record<string,SqlValue>|null}>;
}
