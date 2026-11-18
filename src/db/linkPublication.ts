import type { DataObject, PreparedContentPublication, WriteReceipt } from './unifiedDataStore.js';
import type { DataWriteDatabaseIdentity, DataWriteReferenceContext, PreparedMutationReplay } from './dataWritePublication.js';
import type { ContentVerificationIdentity } from './contentVerification.js';
import type { LearningReviewApplyPublication } from './learningReviewPublication.js';

export interface LinkInput {
  source:string;relation:string;target:string;expectedRevision:number;idempotencyKey:string;
}
export interface LinkPreparationRequest extends DataWriteDatabaseIdentity {
  input:LinkInput;actorId:string;time:number;
  projectedSource?:DataObject;
  publicationSource?:LearningReviewApplyPublication;
  publicationTarget?:LearningReviewApplyPublication;
}
export interface PreparedLink {
  inputHash:string;
  replay?:PreparedMutationReplay;
  publication?:{
    object:DataObject;heads:Array<{id:string;revision:number|null}>;
    contents:ContentVerificationIdentity[];references:DataWriteReferenceContext;
    snapshot:PreparedContentPublication;terms:string;reportMetadataJson?:string;
  };
}
export interface LinkPublicationHandle {
  snapshot?:LearningReviewApplyPublication;
  check():void;
  commitNative():WriteReceipt;
  release():Promise<void>;
}
