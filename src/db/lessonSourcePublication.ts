import type { DataWriteDatabaseIdentity, DataWriteImportSource, PreparedDataWrite } from './dataWritePublication.js';
import type { DataWrite } from './unifiedDataStore.js';
import type { ImportObjectSelection } from './importObjectPublication.js';
import type { LearningReviewApplyEvidence } from './learningReviewPublication.js';
import type { SqlValue } from './diskDatabase.js';
export interface LessonSourceRow {kind:'migration'|'lesson';identity:string;key:string;projectId?:string;before:Record<string,SqlValue>|null}
export interface LessonSourcePrelude {
 data:Record<string,unknown>;binding:Record<string,SqlValue>|null;physical:Record<string,SqlValue>|null;same:boolean;
 target?:{objectId:string;revision:number};sha256:string;
}
type LessonSourceBase={projectId:string;legacyId:string;source:DataWriteImportSource;updatedAt:number};
export type LessonSourceInput=(LessonSourceBase & {phase:'prelude';data:Record<string,unknown>;bytes:Uint8Array}) | (LessonSourceBase & {phase:'after_capture';prelude:LessonSourcePrelude});
export interface LessonSourceRequest extends DataWriteDatabaseIdentity {actorId:string;time:number;objectId:string;input:LessonSourceInput}
export interface LessonSourceNode {input:DataWrite;objectId:string;source?:DataWriteImportSource;referenceSource:DataWriteImportSource;prepared?:PreparedDataWrite}
export interface PreparedLessonSource extends LearningReviewApplyEvidence {
 rows:LessonSourceRow[];absentContents:string[];prelude?:LessonSourcePrelude;selection?:ImportObjectSelection;resolve?:LessonSourceNode;
 inputHash?:string;sourceOwned?:boolean;
 failure?:{point:'before_capture'|'after_capture'|'mutation';name:string;message:string;code?:string};
}
