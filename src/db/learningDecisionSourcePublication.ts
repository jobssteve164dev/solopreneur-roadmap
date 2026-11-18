import type { DataWriteDatabaseIdentity, DataWriteImportSource } from './dataWritePublication.js';
import type { ImportObjectSelection } from './importObjectPublication.js';
import type { LearningReviewApplyEvidence } from './learningReviewPublication.js';
import type { SqlValue } from './diskDatabase.js';
export interface LearningDecisionReferences {event:{objectId:string;revision:number};candidates:Array<{objectId:string;revision:number}>}
type DecisionSourceBase={projectId:string;legacyId:string;data:Record<string,unknown>;source:DataWriteImportSource};
export type LearningDecisionSourceInput=
 {phase:'physical';projectId:string;source:DataWriteImportSource;bytes:Uint8Array} |
 (DecisionSourceBase & {phase:'evidence';eventId:string;candidateIds:string[];bytes:Uint8Array}) |
 (DecisionSourceBase & {phase:'decision';reference:{objectId:string;revision:number};resolved:LearningDecisionReferences});
export interface LearningDecisionSourceRequest extends DataWriteDatabaseIdentity {actorId:string;time:number;objectId:string;input:LearningDecisionSourceInput}
export interface LearningDecisionSourceRow {kind:'migration'|'lesson';identity:string;key:string;projectId?:string;before:Record<string,SqlValue>|null}
export interface PreparedLearningDecisionSource extends LearningReviewApplyEvidence {
 source?:DataWriteImportSource;selection?:ImportObjectSelection;inputHash?:string;resolved?:LearningDecisionReferences;physicalUnchanged?:true;
 rows:LearningDecisionSourceRow[];absentContents:string[];actorMcp?:boolean;
 failure?:{point:'read'|'mutation';message:string;name:string;code?:string};
}
