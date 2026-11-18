import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { ContentVerificationIdentity } from './contentVerification.js';
import type { DataObject, UnifiedDataStore } from './unifiedDataStore.js';
import type { SqlValue } from './diskDatabase.js';
import type { RunState } from '../runLifecycleTypes.js';
import type { RunControlMutation } from './runControlPublication.js';
import type { RunDocumentRequest } from './runDocumentPublication.js';
import type { LinkInput } from './linkPublication.js';
import type { ObjectHeadObservation } from './objectHeadVerification.js';

export type RunNativeMutation={type:'ready';input:Parameters<UnifiedDataStore['recordClaudeNativeReady']>[1]}
  | {type:'event';input:Parameters<UnifiedDataStore['recordClaudeNativeEvent']>[1]}
  | {type:'append';input:Parameters<UnifiedDataStore['recordClaudeNativeAppend']>[1]}
  | {type:'acknowledge';input:Parameters<UnifiedDataStore['acknowledgeClaudeNativeEvent']>[1]};
export interface RunNativeRequest extends DataWriteDatabaseIdentity {
  projectId:string;actorId:string;time:number;documentId:string;mutation:RunNativeMutation;
}
export interface PreparedRunNative {
  before:Record<string,SqlValue>;rootObject:DataObject;
  heads:ObjectHeadObservation[];contents:ContentVerificationIdentity[];
  beforeResult?:{state:RunState;serialized:string};
  document?:RunDocumentRequest['input'];
  link?:{input:LinkInput;preparedDocumentSource?:boolean};
  control?:RunControlMutation;
  resume?:ReturnType<UnifiedDataStore['readClaudeNativeResume']>;
}
