import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { ContentVerificationRequest, ContentVerificationIdentity } from './contentVerification.js';
import type { PreparedRunInputsResult, RunInputsResultRequest } from './runInputsPublication.js';
import type { SqlValue } from './diskDatabase.js';
import type { DataWrite, DataObject, PreparedContentPublication } from './unifiedDataStore.js';
import type { PrepareRunInput } from '../runLifecycleTypes.js';
import type { AgentConversation } from './types.js';
import type { RunAllocationPlan } from './runAllocationPublication.js';

export type RunCreationIdentity = 'run' | 'conversation' | 'task' | 'turn' | 'policy' | 'backup' | 'launch' | 'journal';
export interface RunCreationRequest extends DataWriteDatabaseIdentity {
  allocation?:RunAllocationPlan;
  projectReplay?:boolean;
  projectId: string; locationId: string; actorId: string; input: PrepareRunInput;
  ids: Record<RunCreationIdentity,string>; time: number;
}
export interface PreparedRunCreation {
  inputHash: string; replay: boolean;
  replayStartedAt?:string;
  replayProjection?:PreparedRunInputsResult & {
    descriptor:RunInputsResultRequest;request:Record<string,SqlValue>;contents:ContentVerificationIdentity[];
  };
  ids: RunCreationRequest['ids'];
  parent: {runId:string;turnId:string;taskId:string;conversationId:string} | null;
  policy: {objectId:string;revision:number} | null;
  turnSequence: number;
  initialMetadata: Record<string,unknown>; metadata: Record<string,unknown>;
  nodes: Array<{key:'conversation'|'task'|'turn'|'policy'|'journal';objectId:string;input:DataWrite}>;
  fields: Array<{field:'prompt'|'command'|'initialMetadata'|'metadata'|'backup'|'launch';publication:PreparedContentPublication}>;
  journal: {key:string;entry:Omit<AgentConversation,'id'>;prelude?:boolean;insert?:boolean} | null;
  existingJournalNode: string | null;
  lessons: Array<{objectId:string;revision:number;projectId:string|null}>;
  lessonHeads: Array<{id:string;revision:number|null}>;
}
export interface RunCreationPlanRequest extends RunCreationRequest {
  prepared: PreparedRunCreation;
  contents: ReadonlyArray<ContentVerificationRequest & {field:string}>;
}
export interface PreparedRunCreationPlan {
  object: DataObject; terms: string; snapshot: PreparedContentPublication;
  contents: RunCreationPlanRequest['contents'];
  lessons: PreparedRunCreation['lessons'];
}
