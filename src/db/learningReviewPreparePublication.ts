import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { ContentVerificationIdentity } from './contentVerification.js';
import type { LearningReviewApplyEvidence, LearningReviewApplyNode, LearningReviewApplyPublication, LearningReviewPrepareEntryRequest, PreparedLearningReviewEntry } from './learningReviewPublication.js';
import type { LearningReviewSourceCaptureProgress } from './learningReviewSourceCapture.js';
import type { PreparedContentPublication } from './unifiedDataStore.js';
import type { ReviewManifest } from '../learningReview.js';

export interface LearningReviewPreparationRequest extends LearningReviewPrepareEntryRequest {
  preparationId:string;resultMode?:'identity';
}
export interface LearningReviewPreparationAcknowledgement {
  batchId?:string;publications?:ReadonlyArray<LearningReviewApplyPublication>;
  content?:ContentVerificationIdentity;capture?:LearningReviewSourceCaptureProgress;
}
export type LearningReviewPreparationPhase =
  | {kind:'interrupt';entry:PreparedLearningReviewEntry}
  | {kind:'object';role:'policy'|'batch';node:LearningReviewApplyNode;evidence:LearningReviewApplyEvidence}
  | {kind:'capture';scopes:Array<string|null>;evidence:LearningReviewApplyEvidence}
  | {kind:'content';key:string;publication:PreparedContentPublication;evidence:LearningReviewApplyEvidence};

export type PreparedLearningReviewPreparation =
  | {kind:'replay';entry:PreparedLearningReviewEntry}
  | {kind:'prepared';entry:PreparedLearningReviewEntry;batchId:string;policy:{objectId:string;revision:number};
      manifestHash:string;manifest:ReviewManifest;sourceContents:Record<string,string>;pending:any[]};

export interface LearningReviewPreparationAdvance extends DataWriteDatabaseIdentity {
  preparationId:string;phase:number;acknowledgement?:LearningReviewPreparationAcknowledgement;
}
export type LearningReviewPreparationState =
  | {preparationId:string;phase:number;done:false;value:LearningReviewPreparationPhase}
  | {preparationId:string;phase:number;done:true;result:PreparedLearningReviewPreparation};
export interface LearningReviewPreparationRelease extends DataWriteDatabaseIdentity {preparationId:string}
export interface LearningReviewPreparationResultRequest extends DataWriteDatabaseIdentity {batchId:string;revision?:number;resultMode?:'identity'}
export interface PreparedLearningReviewPreparationResult {result:import('./learningReviewPublication.js').LearningReviewPrepareResult|import('./learningReviewPublication.js').LearningReviewPrepareIdentityResult;serialized:string}
