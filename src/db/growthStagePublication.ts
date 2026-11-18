import type { DataWriteDatabaseIdentity, PreparedDataWrite } from './dataWritePublication.js';
import type { GrowthSnapshotStageManifest } from './types.js';
import type { LearningReviewApplyEvidence } from './learningReviewPublication.js';
import type { RunCheckpointNode } from './runCheckpointPublication.js';
import type { StateWriteSelection } from './stateWritePublication.js';
import type { SqlValue } from './diskDatabase.js';

export type GrowthStageResult={accepted:boolean;snapshotId:string|null;unchanged:boolean};
export interface GrowthStageRequest extends DataWriteDatabaseIdentity {
  projectId:string;actorId:string;time:number;requestId:string;generation:number;manifest:GrowthSnapshotStageManifest;
}
export interface GrowthStageFailure {phase:'root'|'reservation'|'snapshot'|'source';message:string;name:string;code?:string}
export interface GrowthStageInputEncoding {
  encodedItems:Array<{index:number;json:string}>;
  failure?:Omit<GrowthStageFailure,'phase'> & {index:number};
}
export type GrowthStageCaptureRequest=
  | {operation:'encode';values:unknown[]}
  | {operation:'begin';token:string;stageId:string;staged:Record<string,SqlValue>}
  | {operation:'page';token:string;section:'nodes'|'edges'|'signals'|'labels';rows:Array<{ordinal:SqlValue;payload_json:SqlValue}>}
  | {operation:'prepare';token:string;request:Omit<GrowthStageRequest,'manifest'>}
  | {operation:'release';token:string};
export type GrowthStageCaptureResult=PreparedGrowthStage|GrowthStageInputEncoding|{captureFailure:Omit<GrowthStageFailure,'phase'>}|undefined;
export interface PreparedGrowthStage extends LearningReviewApplyEvidence {
  inputHash:string;root:Record<string,SqlValue>|null;result?:GrowthStageResult;serialized?:string;
  failure?:GrowthStageFailure;snapshot?:RunCheckpointNode;snapshotFields?:PreparedDataWrite;source?:StateWriteSelection;
  absentContents:string[];
  choices:Array<{namespace:string;row:Record<string,SqlValue>|null}>;
}
