import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { LearningReviewApplyEvidence, LearningReviewApplyNode, LearningReviewApplyPublication } from './learningReviewPublication.js';
import type { DataObject, UnifiedDataStore } from './unifiedDataStore.js';

export interface GlobalPromptSaveRequest extends DataWriteDatabaseIdentity {
  actorId:string;time:number;input:Parameters<UnifiedDataStore['saveGlobalPrompt']>[0];
}
export interface PreparedGlobalPromptSave extends LearningReviewApplyEvidence {
  node?:LearningReviewApplyNode;result?:{objectId:string;revision:number};
}
export interface GlobalPromptOverridesRequest extends GlobalPromptSaveRequest {
  policy:{objectId:string;revision:number};publications:LearningReviewApplyPublication[];
}
export interface PreparedGlobalPromptOverrides extends LearningReviewApplyEvidence {
  overrides:Array<{applicationId:string;applicationRevision:number;evidence:LearningReviewApplyNode}>;
}
export interface GlobalPromptSupersedeRequest extends GlobalPromptSaveRequest {
  applicationId:string;publications:LearningReviewApplyPublication[];
}
export interface PreparedGlobalPromptSupersede extends LearningReviewApplyEvidence {
  node:LearningReviewApplyNode;previous?:DataObject;
}
