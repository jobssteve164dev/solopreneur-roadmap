import type { DataWriteDatabaseIdentity, DataWriteImportSource } from './dataWritePublication.js';
import type { ImportObjectSelection } from './importObjectPublication.js';
import type { LearningReviewApplyEvidence } from './learningReviewPublication.js';
import type { SqlValue } from './diskDatabase.js';

export interface ArchiveSourceOptions {reason:string;mimeType?:string;projectId?:string|null;observedAt?:number}
export type ArchiveSourceInput={kind:'single';source:DataWriteImportSource;bytes:Uint8Array;options:ArchiveSourceOptions}
  | {kind:'group';identity:string;groupKey:string;keys:string[];options:ArchiveSourceOptions};
export interface ArchiveSourceRequest extends DataWriteDatabaseIdentity {actorId:string;time:number;input:ArchiveSourceInput}
export interface ArchiveSourceRecord {
  source:DataWriteImportSource;selection:ImportObjectSelection;contentBindings?:Record<string,string>;inputHash?:string;
  earlierRecord?:number;
  marks:Array<{identity:string;key:string}>;
}
export interface ArchiveSourceFailure {atRecord:number;point:'read'|'mutation'|'conflict';message:string;name:string;code?:string}
export interface PreparedArchiveSource extends LearningReviewApplyEvidence {
  records:ArchiveSourceRecord[];
  captures:Array<{identity:string;key:string;before:Record<string,SqlValue>|null}>;
  imports:Array<{source:DataWriteImportSource;before:Record<string,SqlValue>|null}>;
  absentContents:string[];actorMcpStates:boolean[];failure?:ArchiveSourceFailure;
}
