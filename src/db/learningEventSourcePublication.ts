import type { DataWriteDatabaseIdentity, DataWriteImportSource } from './dataWritePublication.js';
import type { ImportObjectSelection } from './importObjectPublication.js';
import type { LearningReviewApplyEvidence } from './learningReviewPublication.js';

export type LearningEventSourceInput =
  {phase:'evidence';projectId:string;legacyId:string;data:Record<string,unknown>;identity:string;bytes:Uint8Array} |
  {phase:'event';projectId:string;data:Record<string,unknown>;source:DataWriteImportSource;reference:{objectId:string;revision:number}};
export interface LearningEventSourceRequest extends DataWriteDatabaseIdentity {actorId:string;time:number;objectId:string;input:LearningEventSourceInput}
export interface PreparedLearningEventSource extends LearningReviewApplyEvidence {
  source?:DataWriteImportSource;eventSource?:DataWriteImportSource;selection?:ImportObjectSelection;inputHash?:string;
  failure?:{point:'read'|'mutation';message:string;name:string;code?:string};
  absentContents:string[];actorMcp?:boolean;
}
