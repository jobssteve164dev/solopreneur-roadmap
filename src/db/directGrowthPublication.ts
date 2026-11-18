import type { DataWriteDatabaseIdentity, PreparedDataWrite } from './dataWritePublication.js';
import type { GrowthSnapshotData } from './types.js';
import type { LearningReviewApplyEvidence } from './learningReviewPublication.js';
import type { GrowthStageResult } from './growthStagePublication.js';
import type { DataWrite } from './unifiedDataStore.js';
import type { SqlValue } from './diskDatabase.js';
import type { LegacyProjectSqliteIdentity } from '../projectMigrationInspection.js';
export type LegacyDirectGrowthSource={file:string;identity:LegacyProjectSqliteIdentity;id:string};
export type DirectGrowthInput={mode:'write';projectId:string;data:GrowthSnapshotData;idempotencyKey:string}|{mode:'refresh';projectId:string;requestId:string;generation:number;data:GrowthSnapshotData}
  | {mode:'legacy';projectId:string;source:LegacyDirectGrowthSource;idempotencyKey:string};
export interface DirectGrowthRequest extends DataWriteDatabaseIdentity {actorId:string;time:number;objectId:string;input:DirectGrowthInput}
export interface DirectGrowthError {name:string;message:string;code?:string}
export interface PreparedDirectGrowth extends LearningReviewApplyEvidence {
 root?:{key:string;inputHash:string;before:Record<string,SqlValue>|null};rootReplay?:GrowthStageResult;result?:GrowthStageResult;
 choice?:Record<string,SqlValue>|null;latest?:Record<string,SqlValue>|null;latestRead?:true;
 snapshot?:{input:DataWrite;objectId:string};fields?:PreparedDataWrite;inputHash?:string;
 legacyMissing?:true;
 sections:Array<{kind:'items'|'edges'|'signals'|'labels';rows:unknown[][];failure?:DirectGrowthError}>;
 failure?:DirectGrowthError & {point:'root'|'input'|'mutation'};absentContents:string[];
}
