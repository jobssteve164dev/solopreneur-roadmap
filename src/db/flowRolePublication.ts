import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { RunAllocationPlan } from './runAllocationPublication.js';
import type { PrepareRunInput,RunState } from '../runLifecycleTypes.js';
import type { FlowTrace } from '../flowStore.js';

export interface FlowRoleInput extends Omit<PrepareRunInput,'executionLogId'|'nodeId'|'runKind'> {
  flowId:string;loopId:string;role:'planner'|'builder'|'verifier';attempt:number;initialFlow?:FlowTrace;
}
export interface FlowRoleSelectionRequest extends DataWriteDatabaseIdentity {projectId:string;actorId:string;input:FlowRoleInput}
export interface FlowRoleSelection {
  flow:FlowTrace;initial:boolean;flowObjectId:string|null;flowRevision:number|null;
  allocation:RunAllocationPlan;
  existing?:{result:RunState;serialized:string};
}
