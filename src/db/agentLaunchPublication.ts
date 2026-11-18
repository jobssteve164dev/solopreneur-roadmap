import type { AgentRunPreparationInput, AgentRunPreparationPreflight } from '../agentRunPreparation.js';
import type { RunState, PrepareRunInput } from '../runLifecycleTypes.js';
import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { RunControlProjectedState, RunControlMutation } from './runControlPublication.js';
import type { RunInputsPatchInput } from './runInputsPublication.js';
import type { DataObject } from './unifiedDataStore.js';
import type { ContentVerificationIdentity } from './contentVerification.js';
import type { SqlValue } from './diskDatabase.js';
import type { RunAllocationPlan } from './runAllocationPublication.js';

export interface AgentLaunchOptions {
  resumeSavedIntent?:boolean;
  resumeRun?:{runId:string;executionLogId:number};
  deliveryOwner?:NonNullable<AgentRunPreparationInput['deliveryOwner']>;
  providerContext?:Record<string,unknown>;
  interactionBudget?:AgentRunPreparationInput['interactionBudget'];
}
export interface AgentLaunchSelectionRequest extends DataWriteDatabaseIdentity,AgentLaunchOptions {
  projectId:string;actorId:string;input?:AgentRunPreparationInput;preflight:AgentRunPreparationPreflight;roadmapBackup?:string;
  resumeDeliveryClaimed?:boolean;
}
export interface AgentLaunchArtifactsRequest extends DataWriteDatabaseIdentity {input:AgentRunPreparationInput;captureBackup:boolean}
export interface PreparedAgentLaunchArtifacts {preflight:AgentRunPreparationPreflight;roadmapBackup?:string}
export interface PreparedAgentLaunchSelection {
  input:AgentRunPreparationInput;intentHash:string;prepareKey:string;
  current:Record<string,SqlValue>|null;
  target?:{id:string;scope:'project'|'global';before:Record<string,SqlValue>|null};
  existing?:RunState;projected?:RunControlProjectedState;
  creation?:PrepareRunInput;
  resumeInput?:AgentRunPreparationInput;
  requiresPreflight?:boolean;
  flowAllocation?:RunAllocationPlan;
  allocation?:RunAllocationPlan;
  heads:Array<{id:string;revision:number|null}>;
  taskAlias?:{taskId:string;legacyTaskId:string|null};
  result?:{value:RunState;serialized:string};
  contents:ContentVerificationIdentity[];
}
export interface AgentLaunchStepRequest extends DataWriteDatabaseIdentity {
  projectId:string;actorId:string;input:AgentRunPreparationInput;prepareKey:string;preflight:AgentRunPreparationPreflight;
  base:RunControlProjectedState;phase:'binding'|'identity'|'ready'|'resume';nativeSessionIdIsCurrent?:boolean;
  projectedPolicy?:DataObject;
  providerContext?:Record<string,unknown>;
}
export interface PreparedAgentLaunchStep {
  mutation?:RunControlMutation;ready?:RunInputsPatchInput;
  nativeSessionIdIsCurrent?:boolean;requiresPreflight?:boolean;
  heads:Array<{id:string;revision:number|null}>;
  contents:ContentVerificationIdentity[];
  taskAlias?:{taskId:string;legacyTaskId:string|null};
  flowAllocation?:RunAllocationPlan;
  resumeTarget?:{id:string;scope:'project'|'global';before:Record<string,SqlValue>|null};
}
