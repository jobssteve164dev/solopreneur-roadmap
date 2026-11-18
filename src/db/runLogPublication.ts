import type { RunLogInput } from '../runLifecycleTypes.js';
import type { PreparedContentPublication } from './unifiedDataStore.js';
import type { DataWriteDatabaseIdentity } from './dataWritePublication.js';
import type { ContentVerificationIdentity } from './contentVerification.js';
import type { SqlValue } from './diskDatabase.js';

export interface RunLogResult {requestId:string;committedSequence:number;nextSequence:number;totalBytes:number}
export interface RunLogPreparationRequest extends DataWriteDatabaseIdentity {projectId:string;actorId:string;input:RunLogInput}
export interface PreparedRunLog {
  runId:string;inputHash:string;previous:Record<string,SqlValue>|null;
  contents:ContentVerificationIdentity[];
  replay?:{result:RunLogResult;serialized:string};
  body?:PreparedContentPublication;
  descriptor?:PreparedContentPublication;
}
export interface PreparedRunLogCommit {inputHash:string;body:Pick<ContentVerificationIdentity,'contentId'|'sha256'|'byteLength'>;descriptor:Pick<ContentVerificationIdentity,'contentId'|'sha256'|'byteLength'>}
