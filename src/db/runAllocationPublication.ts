import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { SqlValue } from './diskDatabase.js';
import type { PrepareRunInput, RunState } from '../runLifecycleTypes.js';
import type { AgentConversation } from './types.js';
import type { ContentVerificationIdentity } from './contentVerification.js';

export interface RunAllocationRequest extends DataWriteDatabaseIdentity {
  mode:'intent'|'slot'; projectId:string; actorId:string;
  input:Omit<PrepareRunInput,'executionLogId'> & {executionLogId?:number;launchIntentId?:string;launchSlotId?:string;launchSlotScope?:'project'|'global'};
}
export interface RunAllocationPlan {
  replay:boolean;
  mode:RunAllocationRequest['mode']|'flow'; id:string; scope:'project'|'global';
  flowRole?:{flowId:string;loopId:string;role:'planner'|'builder'|'verifier';attempt:number;objectId:string|null;revision:number|null};
  before:Record<string,SqlValue>|null;
  input:PrepareRunInput;
  journalKey:string;
  journalRevision:number|null;
  minimum:ContentVerificationIdentity|null;
  existingJournalId:number|null;
  entry:Omit<AgentConversation,'id'>;
}
export interface RunAllocationSelection {
  plan:RunAllocationPlan;
  existing?:{result:RunState;serialized:string};
}
