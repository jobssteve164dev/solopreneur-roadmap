import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { RunCheckpointInput, RunState } from '../runLifecycleTypes.js';
import type { NativeSessionBinding } from '../sessionIdentity.js';
import type { UnifiedDataStore } from './unifiedDataStore.js';

export interface RunContextRequest extends DataWriteDatabaseIdentity {
  projectId:string;
  input:{executionLogId:number;generation?:number;proof?:string;revision?:number;includeProof?:boolean;includeBinding?:boolean};
}
export interface PreparedRunContext {state:RunState;serialized:string;binding?:NativeSessionBinding|null}
export interface CurrentRunCheckpointRequest extends DataWriteDatabaseIdentity {
  projectId:string;identity:Pick<RunCheckpointInput,'executionLogId'|'generation'|'proof'>;input:Record<string,unknown>;
}
export interface PreparedCurrentRunCheckpoint {state:RunState;serializedState?:string;input?:RunCheckpointInput;ingressOnly:boolean}
export interface RunTaskIngressRequest extends DataWriteDatabaseIdentity {state:RunState;time:number}
export interface PreparedRunTaskIngress {patch:Record<string,unknown>;key:string;diagnostic?:Parameters<UnifiedDataStore['appendDiagnosticEvent']>[0]}
